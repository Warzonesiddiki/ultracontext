// =============================================================================
// ultracontext backup — free, local backups + restore (no paid tier)
//
// The commercial tier sells "Backups + log retention" as a Pro feature.
// Here it is a SQLite online backup against your own file — nothing leaves
// the machine.
//
//   ultracontext backup                     snapshot the context DB
//   ultracontext backup --list              list existing backups
//   ultracontext backup --full              also archive config + keys + daemon state
//   ultracontext backup --keep 20           retain the 20 newest backups
//   ultracontext backup --restore <file>    restore the context DB from a backup
//
// Backups use the SQLite online-backup API, so the snapshot is consistent
// even while `ultracontext serve` is running. The restore path refuses to
// run while the server appears to hold the database open, and always takes
// a safety snapshot of the current state first.
// =============================================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const requireCjs = createRequire(import.meta.url);

// node:sqlite is experimental in Node 22.x — load lazily so unrelated CLI
// commands (and older runtimes) keep working, with a clear error if absent.
function loadSqlite() {
    try {
        return requireCjs("node:sqlite");
    } catch {
        throw new Error(
            "backups need node:sqlite, which ships with Node >= 22.5. " +
            "Upgrade Node (>= 22.12 recommended) and retry.",
        );
    }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

// same convention as `ultracontext serve`: ULTRACONTEXT_HOME or ~/.ultracontext
export function defaultDataHome(env = process.env) {
    const override = String(env.ULTRACONTEXT_HOME ?? "").trim();
    if (override) return override;
    const home = env.HOME || env.USERPROFILE || os.homedir();
    return path.join(home, ".ultracontext");
}

export function mainDbPath(dataHome) {
    return path.join(dataHome, "ultracontext.db");
}

export function backupsDir(dataHome) {
    return path.join(dataHome, "backups");
}

function tsStamp(date = new Date()) {
    // 2026-09-12T02:30:00.123Z → 20260912T023000Z
    return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** Human-readable size that doesn't round small files to 0. */
function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function slugify(tag) {
    const s = String(tag ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return s.slice(0, 40);
}

// ---------------------------------------------------------------------------
// snapshot (online backup)
// ---------------------------------------------------------------------------

/**
 * Online-backup srcDbPath to destFile. Works while other connections are
 * open (e.g. the local server). Verifies the result with integrity_check.
 * Returns { file, sizeBytes, tables, messageNodes, contextNodes }.
 */
export function snapshotDatabase(srcDbPath, destFile) {
    const { DatabaseSync, backup } = loadSqlite();
    if (!fs.existsSync(srcDbPath)) {
        throw new Error(`Database not found: ${srcDbPath}`);
    }

    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    // remove a stale destination so the backup never merges into old bytes
    for (const suffix of ["", "-wal", "-shm"]) {
        fs.rmSync(destFile + suffix, { force: true });
    }

    const src = new DatabaseSync(srcDbPath, { readOnly: false });
    try {
        // settle any WAL so the backup starts from a clean frame — best effort,
        // the online-backup API would handle an active WAL anyway
        try {
            src.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
        } catch {
            /* checkpoint is advisory */
        }
        backup(src, destFile);
    } finally {
        // the transfer settles when the source connection closes — always close
        // before touching the destination
        src.close();
    }

    // wait for the destination to settle (a short window; usually instant).
    // an empty source yields an empty destination — that settles immediately.
    const srcSize = fs.statSync(srcDbPath).size;
    const deadline = Date.now() + 5000;
    for (;;) {
        let destSize = 0;
        try {
            destSize = fs.statSync(destFile).size;
        } catch {
            /* not written yet */
        }
        if (destSize > 0 || srcSize === 0) break;
        if (Date.now() > deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }

    // verify the snapshot
    const dst = new DatabaseSync(destFile, { readOnly: true });
    try {
        const integrity = dst.prepare("PRAGMA integrity_check").get();
        const verdict = integrity?.integrity_check ?? String(integrity);
        if (verdict !== "ok") {
            throw new Error(`Backup integrity check failed: ${verdict}`);
        }
        const tables = dst
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
            .all()
            .map((r) => r.name);
        const info = { file: destFile, sizeBytes: fs.statSync(destFile).size, tables };
        if (tables.includes("nodes")) {
            info.messageNodes = dst.prepare("SELECT COUNT(*) c FROM nodes WHERE type = 'message'").get().c;
            info.contextNodes = dst.prepare("SELECT COUNT(*) c FROM nodes WHERE type = 'context'").get().c;
        }
        return info;
    } finally {
        dst.close();
    }
}

// ---------------------------------------------------------------------------
// listing + retention
// ---------------------------------------------------------------------------

const BACKUP_FILE_RE = /^ultracontext-(full-)?\d{8}T\d{6}Z(-[a-z0-9-]+)?\.(sqlite|tar\.gz)$/;
const SAFETY_BACKUP_RE = /^pre-restore-\d{8}T\d{6}Z\.sqlite$/;

// list backup files (newest first). `all` includes pre-restore safety copies.
export function listBackups(dir, { all = false } = {}) {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir)
        .filter((name) => (all ? BACKUP_FILE_RE.test(name) || SAFETY_BACKUP_RE.test(name) : BACKUP_FILE_RE.test(name)))
        .map((name) => {
            const p = path.join(dir, name);
            const st = fs.statSync(p);
            return { file: name, path: p, sizeBytes: st.size, mtimeMs: st.mtimeMs };
        });
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
}

/**
 * Retention: keep the `keep` newest of each backup family (sqlite snapshots
 * and full archives are counted separately; pre-restore safety copies are
 * never auto-pruned). Returns the deleted file names.
 */
export function pruneOldBackups(dir, keep) {
    const n = Math.max(1, Math.floor(keep));
    const kept = { sqlite: 0, full: 0 };
    const deleted = [];
    for (const entry of listBackups(dir)) {
        const family = entry.file.endsWith(".tar.gz") ? "full" : "sqlite";
        if (kept[family] < n) {
            kept[family] += 1;
            continue;
        }
        fs.rmSync(entry.path, { force: true });
        deleted.push(entry.file);
    }
    return deleted;
}

// ---------------------------------------------------------------------------
// full archive (context DB + daemon state + config/keys)
// ---------------------------------------------------------------------------

/**
 * Archive the whole local install into a single .tar.gz (mode 0600 — it
 * contains API keys). The databases are online-backupped, not byte-copied,
 * so the archive is consistent even while things are running.
 */
export function createFullArchive(dataHome, outFile) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-backup-"));
    try {
        const staged = [];
        const stage = (name, srcPath) => {
            if (!fs.existsSync(srcPath)) return;
            const dest = path.join(workDir, name);
            fs.copyFileSync(srcPath, dest);
            staged.push(name);
        };

        const liveDb = mainDbPath(dataHome);
        if (fs.existsSync(liveDb)) {
            snapshotDatabase(liveDb, path.join(workDir, "ultracontext.db.sqlite"));
            staged.push("ultracontext.db.sqlite");
        }
        const daemonDb = path.join(dataHome, "daemon.db");
        if (fs.existsSync(daemonDb)) {
            snapshotDatabase(daemonDb, path.join(workDir, "daemon.db.sqlite"));
            staged.push("daemon.db.sqlite");
        }
        for (const name of ["config.json", "server.json"]) {
            stage(name, path.join(dataHome, name));
        }

        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.rmSync(outFile, { force: true });
        const res = spawnSync("tar", ["-czf", outFile, "-C", workDir, ...staged], { encoding: "utf8" });
        if (res.status !== 0) {
            throw new Error(`tar failed: ${res.stderr || res.stdout || `exit ${res.status}`}`);
        }
        fs.chmodSync(outFile, 0o600);
        return { file: outFile, sizeBytes: fs.statSync(outFile).size, files: staged };
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

function verifyBackupFile(backupFile) {
    const { DatabaseSync } = loadSqlite();
    if (!fs.existsSync(backupFile)) throw new Error(`Backup not found: ${backupFile}`);
    let db;
    try {
        db = new DatabaseSync(backupFile, { readOnly: true });
        const integrity = db.prepare("PRAGMA integrity_check").get();
        if ((integrity?.integrity_check ?? String(integrity)) !== "ok") {
            throw new Error("Backup file failed integrity_check — refusing to restore from it.");
        }
        const hasNodes = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'")
            .get();
        if (!hasNodes) {
            throw new Error("Backup file is not an UltraContext database (no nodes table).");
        }
    } catch (e) {
        if (e instanceof Error && /integrity_check|no nodes table/.test(e.message)) throw e;
        throw new Error(`Backup file is not a readable database (${e.message}).`);
    } finally {
        try { db?.close(); } catch { /* already closed */ }
    }
}

// Probe the local server: if something answers on the serve port, the DB may
// be held open — renaming under a live server would fork the data. A leftover
// -wal file is NOT a reliable signal (clean closes can leave one), so we ask
// the port instead.
async function localServerRunning(dataHome) {
    const port = Number(process.env.PORT) || 8787;
    let apiKey = null;
    try {
        apiKey = JSON.parse(fs.readFileSync(path.join(dataHome, "server.json"), "utf8")).apiKey ?? null;
    } catch {
        /* no server.json — probe without a key (401 still proves it's up) */
    }
    try {
        const res = await fetch(`http://127.0.0.1:${port}/contexts?limit=1`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
            signal: AbortSignal.timeout(1500),
        });
        // any HTTP answer means the server (or something) is listening
        return true;
    } catch {
        return false; // ECONNREFUSED / timeout → nothing listening
    }
}

/**
 * Restore the live context DB from a backup file.
 *  1. verifies the backup (integrity + schema)
 *  2. refuses if the local server is running (use --force to override)
 *  3. takes an online safety snapshot of the current state first
 *  4. atomically swaps the live DB and verifies the result
 */
export async function restoreBackup({ backupFile, dataHome, force = false }) {
    const liveDb = mainDbPath(dataHome);
    verifyBackupFile(backupFile);

    let safety = null;
    if (fs.existsSync(liveDb)) {
        if (!force && (await localServerRunning(dataHome))) {
            throw new Error(
                "The local context server is running on port " + (Number(process.env.PORT) || 8787) + ".\n" +
                "Stop it first — e.g. close the `ultracontext serve` terminal — then retry.\n" +
                "(Restoring under a live server would fork your data. --force overrides this check.)",
            );
        }
        const dir = backupsDir(dataHome);
        safety = snapshotDatabase(liveDb, path.join(dir, `pre-restore-${tsStamp()}.sqlite`));
    }

    // copy to a temp file in the same directory, then rename (atomic on POSIX)
    const tmpFile = `${liveDb}.restore-tmp`;
    try {
        fs.copyFileSync(backupFile, tmpFile);
        for (const suffix of ["-wal", "-shm"]) fs.rmSync(liveDb + suffix, { force: true });
        fs.renameSync(tmpFile, liveDb);
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }

    // verify the restored file
    verifyBackupFile(liveDb);
    return { restored: liveDb, safetyBackup: safety ? safety.file : null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printBackupHelp() {
    console.log(`ultracontext backup [options]

Free, local backups of your UltraContext data. Everything stays on this
machine — nothing is uploaded anywhere.

Options:
  (no options)              Create a snapshot of the context database
  --list                    List existing backups (newest first)
  --restore <file>          Restore the context database from a backup file.
                            Refuses if the local server looks like it's running
                            (stop it first). If the server listens on a custom
                            port, set PORT=<port> in the environment so the
                            check can see it.
  --force                   (with --restore) restore even if the local server
                            appears to be running — you know what you're doing
  --full                    Also archive config, API keys and daemon state
                            (single .tar.gz, mode 0600 — keep it safe)
  --keep <n>                Retain the n newest backups (default 10)
  --dir <path>              Backup directory (default ~/.ultracontext/backups)
  --tag <name>              Add a label to the backup filename
  --home <path>             Data home (default $ULTRACONTEXT_HOME or ~/.ultracontext)
  -h, --help                Show this help`);
}

export async function runBackup(argv = []) {
    const args = [...argv];
    if (args.includes("-h") || args.includes("--help")) {
        printBackupHelp();
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

    const dirOverride = takeValue("--dir");
    const tag = takeValue("--tag");
    const keepRaw = takeValue("--keep");
    const homeOverride = takeValue("--home");
    const restoreFile = takeValue("--restore");
    const wantList = args.includes("--list");
    const wantFull = args.includes("--full");
    const force = args.includes("--force"); // restore only
    if (args.some((a) => !["--list", "--full", "--force"].includes(a))) {
        throw new Error(`Unknown option or argument: ${args.find((a) => !["--list", "--full", "--force"].includes(a))}`);
    }

    const dataHome = homeOverride || defaultDataHome();
    const dir = dirOverride || backupsDir(dataHome);
    const keep = keepRaw ? Math.max(1, Number.parseInt(keepRaw, 10)) : 10;
    const stamp = tsStamp();

    if (wantList) {
        const files = listBackups(dir, { all: true });
        if (!files.length) {
            console.log(`No backups yet in ${dir}`);
            return;
        }
        for (const f of files) {
            const age = new Date(f.mtimeMs).toISOString().replace("T", " ").slice(0, 19);
            console.log(`${age}  ${fmtSize(f.sizeBytes)}  ${f.file}`);
        }
        return;
    }

    if (restoreFile) {
        const result = await restoreBackup({ backupFile: path.resolve(restoreFile), dataHome, force });
        console.log(`Restored context database from ${restoreFile}`);
        if (result.safetyBackup) {
            console.log(`Previous state saved to ${result.safetyBackup} (delete it once you're happy)`);
        }
        return;
    }

    if (!fs.existsSync(mainDbPath(dataHome))) {
        console.error(`No context database found at ${mainDbPath(dataHome)}.`);
        console.error("Run `ultracontext serve` (or start sync) first, then back up.");
        process.exitCode = 1;
        return;
    }

    const created = [];
    const info = snapshotDatabase(mainDbPath(dataHome), path.join(dir, `ultracontext-${stamp}${tag ? `-${slugify(tag)}` : ""}.sqlite`));
    created.push(info.file);
    console.log(`Backup: ${info.file} (${fmtSize(info.sizeBytes)})`);
    if (info.messageNodes !== undefined) {
        console.log(`  ${info.contextNodes} contexts · ${info.messageNodes} messages · integrity ok`);
    }

    if (wantFull) {
        const full = createFullArchive(dataHome, path.join(dir, `ultracontext-full-${stamp}.tar.gz`));
        created.push(full.file);
        console.log(`Full archive: ${full.file} (${fmtSize(full.sizeBytes)}, mode 0600)`);
        console.log(`  contains: ${full.files.join(", ")}`);
        console.log("  ⚠ contains API keys — treat the archive like a secret");
    }

    const deleted = pruneOldBackups(dir, keep);
    if (deleted.length) {
        console.log(`Pruned ${deleted.length} older backup(s): ${deleted.join(", ")}`);
    }
}
