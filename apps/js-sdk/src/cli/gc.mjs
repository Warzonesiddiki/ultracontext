// =============================================================================
// ultracontext gc — free, local log retention (no paid tier)
//
// The commercial tier sells "Custom retention" to Enterprise. Here the
// retention policy is a command you run (or wire into cron/systemd) against
// your own database.
//
//   ultracontext gc --keep 90d            drop whole sessions older than 90 days
//   ultracontext gc --keep 12mo --dry-run preview what would be dropped
//   ultracontext gc --keep 30d --vacuum   and reclaim the freed disk space
//
// Retention works at the SESSION level (a root context plus all of its
// versions and messages), never at the single-message level: pricking
// individual messages would break the version chain and the copy-on-write
// lineage that `?version=` time-travel depends on.
//
// A session's age is its LAST activity (newest node in the chain), so a
// long-running session that was touched yesterday is never dropped.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

import { defaultDataHome, mainDbPath } from "./backup.mjs";

const requireCjs = createRequire(import.meta.url);

function loadSqlite() {
    try {
        return requireCjs("node:sqlite");
    } catch {
        throw new Error(
            "gc needs node:sqlite, which ships with Node >= 22.5. " +
            "Upgrade Node (>= 22.12 recommended) and retry.",
        );
    }
}

const UNIT_MS = {
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
    mo: 30 * 24 * 60 * 60 * 1000,
    y: 365 * 24 * 60 * 60 * 1000,
};

// parse a retention window like "90d", "12h", "6mo", "1y" → milliseconds
export function parseKeepWindow(raw) {
    const m = String(raw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(h|d|w|mo|y)$/i);
    if (!m) {
        throw new Error(`Invalid retention window: "${raw}". Use e.g. 12h, 30d, 4w, 6mo, 1y.`);
    }
    return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

/**
 * Which root contexts are older than the cutoff?
 * Returns [{ publicId, lastActivity, messageCount }], oldest first.
 */
export function planGc(dbPath, { keepMs, now = Date.now() }) {
    if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
    const cutoff = now - keepMs;
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        const contexts = db
            .prepare("SELECT public_id, context_id, created_at FROM nodes WHERE type = 'context'")
            .all();
        const msgAgg = db
            .prepare("SELECT context_id, MAX(created_at) AS last, COUNT(*) AS c FROM nodes WHERE type = 'message' GROUP BY context_id")
            .all();
        const msgAggByHead = new Map(msgAgg.map((r) => [r.context_id, r]));

        const roots = new Map(); // publicId → { lastActivity, messageCount, heads: [] }
        for (const c of contexts.filter((r) => r.context_id === null)) {
            roots.set(c.public_id, { publicId: c.public_id, lastActivity: c.created_at, messageCount: 0, heads: [] });
        }
        for (const c of contexts.filter((r) => r.context_id !== null)) {
            const root = roots.get(c.context_id);
            if (root) root.heads.push(c.public_id);
        }
        for (const root of roots.values()) {
            const consider = [root.publicId, ...root.heads];
            for (const id of consider) {
                const agg = msgAggByHead.get(id);
                if (agg) {
                    root.lastActivity = root.lastActivity > agg.last ? root.lastActivity : agg.last;
                    root.messageCount += agg.c;
                }
            }
        }

        return [...roots.values()]
            .filter((r) => new Date(r.lastActivity).getTime() < cutoff)
            .sort((a, b) => String(a.lastActivity).localeCompare(String(b.lastActivity)));
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

const CHUNK = 200;

/**
 * Drop the given root contexts (all versions, messages, FTS rows).
 * Returns { contexts, messages }.
 */
export function applyGc(dbPath, rootPublicIds) {
    if (!rootPublicIds.length) return { contexts: 0, messages: 0 };
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(dbPath, { readOnly: false });
    let contexts = 0;
    let messages = 0;
    try {
        const hasFts = Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'").get());

        for (let i = 0; i < rootPublicIds.length; i += CHUNK) {
            const chunk = rootPublicIds.slice(i, i + CHUNK);
            // heads owned by these roots
            const heads = db
                .prepare(`SELECT public_id FROM nodes WHERE type = 'context' AND context_id IN (${chunk.map(() => "?").join(",")})`)
                .all(...chunk)
                .map((r) => r.public_id);
            const scope = [...new Set([...chunk, ...heads])]; // root ids + head ids
            const scopeMarks = scope.map(() => "?").join(",");

            db.exec("BEGIN IMMEDIATE");
            try {
                if (hasFts) {
                    const f = db.prepare(`DELETE FROM nodes_fts WHERE public_id IN (SELECT public_id FROM nodes WHERE type = 'message' AND context_id IN (${scopeMarks}))`);
                    f.run(...scope);
                }
                const m = db.prepare(`DELETE FROM nodes WHERE type = 'message' AND context_id IN (${scopeMarks})`);
                messages += m.run(...scope).changes;
                const h = db.prepare(`DELETE FROM nodes WHERE type = 'context' AND context_id IN (${chunk.map(() => "?").join(",")})`);
                contexts += h.run(...chunk).changes;
                const r = db.prepare(`DELETE FROM nodes WHERE public_id IN (${chunk.map(() => "?").join(",")})`);
                contexts += r.run(...chunk).changes;
                db.exec("COMMIT");
            } catch (e) {
                try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
                throw e;
            }
        }
    } finally {
        db.close();
    }
    return { contexts, messages };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printGcHelp() {
    console.log(`ultracontext gc [options]

Local log retention: drop whole sessions (with all their versions and
messages) whose LAST activity is older than the retention window.

Options:
  --keep <window>   Retention window: 12h, 30d, 4w, 6mo, 1y (default 30d)
  --dry-run         Show what would be dropped, without deleting anything
  --vacuum          VACUUM afterwards to reclaim the freed disk space
  --home <path>     Data home (default $ULTRACONTEXT_HOME or ~/.ultracontext)
  -h, --help        Show this help

Example cron (nightly, 6-month retention):
  0 3 * * * ultracontext gc --keep 6mo
`);
}

export async function runGc(argv = []) {
    let args = [...argv];
    if (args.includes("-h") || args.includes("--help")) {
        printGcHelp();
        return;
    }

    const takeValue = (flag) => {
        const i = args.indexOf(flag);
        if (i === -1) return undefined;
        const v = args[i + 1];
        if (v === undefined || v.startsWith("-")) throw new Error(`Missing value for ${flag}`);
        args.splice(i, 2);
        return v;
    };

    const keepRaw = takeValue("--keep") ?? "30d";
    const homeOverride = takeValue("--home");
    const dryRun = args.includes("--dry-run");
    const vacuum = args.includes("--vacuum");
    args = args.filter((a) => a !== "--dry-run" && a !== "--vacuum");
    if (args.length > 0) throw new Error(`Unknown option or argument: ${args[0]}`);

    const keepMs = parseKeepWindow(keepRaw);
    const dataHome = homeOverride || defaultDataHome();
    const dbPath = mainDbPath(dataHome);
    if (!fs.existsSync(dbPath)) {
        console.error(`No context database found at ${dbPath}. Nothing to garbage-collect.`);
        return;
    }

    const plan = planGc(dbPath, { keepMs });
    if (!plan.length) {
        console.log(`Nothing to do — every session has activity within the last ${keepRaw}.`);
        return;
    }

    const totalMessages = plan.reduce((sum, p) => sum + p.messageCount, 0);
    console.log(`Retention window: last ${keepRaw}`);
    console.log(`Sessions to drop: ${plan.length} (oldest first)\n`);
    for (const p of plan.slice(0, 20)) {
        const last = String(p.lastActivity).replace("T", " ").slice(0, 19);
        console.log(`  ${last}  ${p.publicId}  ${p.messageCount} messages`);
    }
    if (plan.length > 20) console.log(`  … and ${plan.length - 20} more`);
    console.log(`\nTotal: ${plan.length} sessions · ${totalMessages} messages`);

    if (dryRun) {
        console.log("\nDry run — nothing deleted.");
        return;
    }

    const { contexts, messages } = applyGc(dbPath, plan.map((p) => p.publicId));
    console.log(`Deleted ${contexts} sessions · ${messages} messages`);

    if (vacuum) {
        const { DatabaseSync } = loadSqlite();
        const before = fs.statSync(dbPath).size;
        const db = new DatabaseSync(dbPath, { readOnly: false });
        try {
            db.exec("VACUUM");
        } finally {
            db.close();
        }
        const after = fs.statSync(dbPath).size;
        const freed = before - after;
        console.log(freed > 0
            ? `VACUUM reclaimed ${(freed / 1048576).toFixed(2)} MiB (${(before / 1048576).toFixed(2)} → ${(after / 1048576).toFixed(2)} MiB)`
            : "VACUUM complete (no freeable space)");
    }
}
