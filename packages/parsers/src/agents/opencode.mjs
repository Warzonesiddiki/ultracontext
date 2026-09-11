import path from "node:path";
import fsSync from "node:fs";
import { createRequire } from "node:module";
import { normalizeRole, preserveText, safeJsonParse, toMessage, truncateString } from "../utils.mjs";

const requireCjs = createRequire(import.meta.url);

/**
 * opencode (sst/opencode, now anomalyco/opencode; npm: opencode-ai, @opencode-ai/cli)
 *
 * On-disk layout — verified 2026-09-11 against the current source tree
 * (github.com/anomalyco/opencode, packages/core/src):
 *
 * Data directory: `${XDG_DATA_HOME:-$HOME/.local/share}/opencode`
 * (packages/core/src/global.ts → xdg-basedir `xdgData` + "/opencode").
 * There is no OPENCODE_DATA_DIR in current versions — that env var belonged
 * to the old sst/opencode era. Override the ingestion glob instead.
 *
 * Two layouts exist in the wild and this parser handles BOTH:
 *
 * 1) SQLite DB (opencode ≥ 1.2.0, Feb 2026 → current):
 *      <data>/opencode.db
 *    Current schema (packages/core/src/session/sql.ts):
 *      session(id, project_id, …, directory, title, version, time_created, time_updated, …)
 *      session_message(id, session_id, type, seq, time_created, time_updated, data)
 *        data JSON is tagged by `type`: user {text, files?, agents?} |
 *        assistant {agent, model, content: [{type: text|reasoning|tool, …}], tokens?} |
 *        system {text} | synthetic {text} | shell {command, output} |
 *        agent-switched {agent} | model-switched {model} | compaction {summary}
 *      message(id, session_id, time_created, time_updated, data)   ← v1 schema
 *        data JSON: {role: "user"|"assistant", time: {created}, path?: {cwd, root}, …}
 *      part(id, message_id, session_id, time_created, time_updated, data)  ← v1 schema
 *        data JSON: {type: "text"|"reasoning"|"tool"|"file"|"patch"|"snapshot"|…, …}
 *    Timestamps are epoch MILLISECONDS (integer columns / encoded JSON).
 *    If a DB has both v1 and v2 rows (mid-migration), the v2 rows win.
 *
 * 2) Legacy JSON (pre-1.2 "storage" layout, verified against the in-tree
 *    migration code packages/opencode/src/storage/storage.ts and the layout
 *    recorded in HANDOVER.md):
 *      <data>/storage/session/<projectHash>/<sessionID>.json   (session info, metadata only)
 *      <data>/storage/message/<sessionID>/msg_<messageID>.json (message info: role, time)
 *      <data>/storage/part/…                                   (message parts: text, tool calls)
 *    A later migration era also used <data>/storage/session/message/<id>/*.json
 *    and <data>/storage/session/part/<sid>/<mid>/*.json.
 *    Message files are parsed; each one pulls its sibling part files to
 *    reconstruct the full turn (text + tool calls).
 */

const SQLITE_MAGIC = Buffer.from("SQLite format 3\x00");

// ── timestamp coercion (opencode uses epoch ms, tolerate s/ISO) ──

function opencodeTimeToIso(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value; // seconds → ms
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    if (typeof value === "string" && value) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
}

// ── tool call formatting (shared by DB + legacy JSON paths) ──

function formatToolState(toolName, input, output) {
    const compact = JSON.stringify(input ?? {});
    const detail = compact.length > 500 ? compact.slice(0, 500) + "..." : compact;
    let text = `[${toolName}] ${detail}`;
    if (typeof output === "string" && output.trim()) {
        text += `\n[result] ${truncateString(preserveText(output), 1000)}`;
    }
    return text;
}

// ── v2 (session_message) row → events ──

// content array of an assistant message: text / reasoning / tool parts
function v2AssistantText(content) {
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const item of content) {
        if (!item || typeof item !== "object") continue;
        if (item.type === "text" && typeof item.text === "string") {
            const chunk = preserveText(item.text);
            if (chunk) parts.push(chunk);
        } else if (item.type === "reasoning" && typeof item.text === "string") {
            const chunk = preserveText(item.text);
            if (chunk) parts.push(`[thinking] ${chunk}`);
        } else if (item.type === "tool" && item.name) {
            const state = item.state ?? {};
            let output = "";
            if (Array.isArray(state.content)) {
                output = state.content
                    .filter((c) => c?.type === "text" && typeof c.text === "string")
                    .map((c) => c.text)
                    .join("\n");
            }
            parts.push(formatToolState(item.name, state.input, output));
        }
    }
    return parts.join("\n\n");
}

function v2RowToEvents({ row, session }) {
    const data = safeJsonParse(typeof row.data === "string" ? row.data : JSON.stringify(row.data ?? {}));
    if (!data || typeof data !== "object") return [];

    const type = String(data.type ?? row.type ?? "unknown").toLowerCase();
    const ts = opencodeTimeToIso(data?.time?.created ?? row.time_created);

    const base = {
        sessionId: row.session_id,
        timestamp: ts,
        raw: { ...data, directory: session?.directory ?? "" },
    };

    switch (type) {
        case "user": {
            const parts = [];
            if (typeof data.text === "string" && data.text.trim()) parts.push(preserveText(data.text));
            if (Array.isArray(data.files) && data.files.length) {
                const names = data.files.map((f) => (typeof f === "string" ? f : f?.path ?? f?.filename ?? "")).filter(Boolean);
                if (names.length) parts.push(`[attachments] ${names.join(", ")}`);
            }
            if (!parts.length) return [];
            return [{ ...base, eventType: "opencode.user", kind: "user", message: toMessage(parts.join("\n\n")) }];
        }
        case "assistant": {
            const text = v2AssistantText(data.content);
            if (!text) return [];
            return [{ ...base, eventType: "opencode.assistant", kind: "assistant", message: toMessage(text) }];
        }
        case "system":
        case "synthetic": {
            if (typeof data.text !== "string" || !data.text.trim()) return [];
            return [{ ...base, eventType: `opencode.${type}`, kind: "system", message: toMessage(preserveText(data.text)) }];
        }
        case "shell": {
            const command = typeof data.command === "string" ? data.command : "";
            const output = typeof data.output === "string" ? data.output : "";
            if (!command && !output) return [];
            const parts = [`[shell] ${command}`];
            if (output.trim()) parts.push(`[result] ${truncateString(preserveText(output), 1000)}`);
            return [{ ...base, eventType: "opencode.shell", kind: "system", message: toMessage(parts.join("\n")) }];
        }
        case "agent-switched":
            return [{ ...base, eventType: "opencode.agent_switched", kind: "system", message: toMessage(`Agent switched to: ${data.agent ?? "unknown"}`) }];
        case "model-switched": {
            const model = data.model ? `${data.model.providerID ?? ""}/${data.model.id ?? ""}` : "unknown";
            return [{ ...base, eventType: "opencode.model_switched", kind: "system", message: toMessage(`Model switched to: ${model}`) }];
        }
        case "compaction":
            return [{ ...base, eventType: "opencode.compaction", kind: "system", message: toMessage(data.summary ?? "Context compacted") }];
        default:
            return [];
    }
}

// ── v1 (message + part) rows → events ──

function v1PartText(part) {
    const type = String(part?.type ?? "").toLowerCase();
    if (type === "text" && typeof part.text === "string") {
        const chunk = preserveText(part.text);
        return chunk ? chunk : "";
    }
    if (type === "reasoning" && typeof part.text === "string") {
        const chunk = preserveText(part.text);
        return chunk ? `[thinking] ${chunk}` : "";
    }
    if (type === "tool" && part.tool) {
        const state = part.state ?? {};
        return formatToolState(part.tool, state.input, state.output);
    }
    if (type === "patch" && Array.isArray(part.files) && part.files.length) {
        return `[patch] ${part.files.join(", ")}`;
    }
    return "";
}

function v1MessageToEvent({ messageRow, parts, session }) {
    const data = safeJsonParse(typeof messageRow.data === "string" ? messageRow.data : JSON.stringify(messageRow.data ?? {}));
    if (!data || typeof data !== "object") return null;

    const role = normalizeRole(data.role, "system");
    const ts = opencodeTimeToIso(data?.time?.created ?? messageRow.time_created);

    const partsTexts = (parts ?? []).map(v1PartText).filter(Boolean);
    const text = partsTexts.join("\n\n");
    if (!text) return null;

    // assistant message data carries the project cwd (v1 Info.path.cwd)
    const cwd = typeof data?.path?.cwd === "string" && data.path.cwd ? data.path.cwd : "";

    return {
        sessionId: messageRow.session_id,
        eventType: `opencode.${role === "user" ? "user" : "assistant"}`,
        kind: role,
        timestamp: ts,
        message: toMessage(text),
        raw: { ...data, directory: session?.directory ?? cwd },
    };
}

// ── SQLite DB ──

function loadDatabaseSync() {
    try {
        // node:sqlite ships with Node ≥ 22.5 (experimental); absent on older
        // runtimes — the daemon logs a warn and the source simply yields nothing.
        return requireCjs("node:sqlite").DatabaseSync;
    } catch {
        return null;
    }
}

function parseOpencodeDb(filePath) {
    const DatabaseSync = loadDatabaseSync();
    if (!DatabaseSync) return [];

    let db;
    try {
        db = new DatabaseSync(filePath, { readOnly: true });
    } catch {
        return [];
    }

    try {
        const tables = new Set(
            db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
        );

        // session metadata (both schemas share the session table)
        const sessions = new Map();
        if (tables.has("session")) {
            let rows = [];
            try {
                rows = db.prepare("SELECT id, title, directory FROM session").all();
            } catch {
                rows = [];
            }
            for (const row of rows) sessions.set(row.id, row);
        }

        const events = [];
        const pushSessionStart = (sessionId, timeCreated) => {
            const session = sessions.get(sessionId);
            events.push({
                sessionId,
                eventType: "opencode.session_start",
                kind: "system",
                timestamp: opencodeTimeToIso(timeCreated),
                message: toMessage(
                    `opencode session${session?.title ? `: ${session.title}` : ""}` +
                        (session?.directory ? ` (${session.directory})` : ""),
                ),
                raw: { title: session?.title ?? "", directory: session?.directory ?? "" },
            });
        };

        if (tables.has("session_message")) {
            // v2 schema — preferred when present (v1+v2 can coexist mid-migration)
            const rows = db
                .prepare(
                    "SELECT sm.session_id, sm.type, sm.seq, sm.time_created, sm.data, s.title, s.directory " +
                        "FROM session_message sm LEFT JOIN session s ON s.id = sm.session_id " +
                        "ORDER BY sm.time_created, sm.id",
                )
                .all();

            const seenSessions = new Set();
            for (const row of rows) {
                if (!seenSessions.has(row.session_id)) {
                    seenSessions.add(row.session_id);
                    pushSessionStart(row.session_id, row.time_created);
                }
                events.push(...v2RowToEvents({ row, session: sessions.get(row.session_id) }));
            }
        } else if (tables.has("message") && tables.has("part")) {
            // v1 schema: message rows + part rows grouped per message
            const partsByMessage = new Map();
            for (const p of db.prepare("SELECT message_id, data FROM part ORDER BY id").all()) {
                const part = safeJsonParse(typeof p.data === "string" ? p.data : JSON.stringify(p.data ?? {}));
                if (!part || typeof part !== "object") continue;
                if (!partsByMessage.has(p.message_id)) partsByMessage.set(p.message_id, []);
                partsByMessage.get(p.message_id).push(part);
            }

            const seenSessions = new Set();
            for (const m of db.prepare("SELECT id, session_id, time_created, data FROM message ORDER BY time_created, id").all()) {
                if (!seenSessions.has(m.session_id)) {
                    seenSessions.add(m.session_id);
                    pushSessionStart(m.session_id, m.time_created);
                }
                const event = v1MessageToEvent({ messageRow: m, parts: partsByMessage.get(m.id), session: sessions.get(m.session_id) });
                if (event) events.push(event);
            }
        } else {
            // unknown schema — nothing we can read
            return [];
        }

        return events;
    } finally {
        try { db.close(); } catch { /* already closed */ }
    }
}

// ── legacy JSON message files ──

// <data>/storage/message/<sid>/msg_<mid>.json          → data root is 4 levels up
// <data>/storage/session/message/<sid>/<mid>.json      → data root is 5 levels up
function findDataRoot(filePath) {
    const parts = filePath.split(path.sep);
    for (let up = 3; up <= 6; up++) {
        const candidate = parts.slice(0, parts.length - up).join(path.sep) || path.sep;
        if (fsSync.existsSync(path.join(candidate, "storage"))) return candidate;
    }
    return "";
}

function readLegacyParts(dataRoot, sessionID, messageID) {
    if (!dataRoot) return [];
    let fgSync;
    try {
        fgSync = requireCjs("fast-glob").sync;
    } catch {
        return [];
    }
    // historical part layouts vary by opencode version — try each, first hit wins
    const patterns = [
        `storage/part/${sessionID}/${messageID}/**/*.json`,
        `storage/session/part/${sessionID}/${messageID}/**/*.json`,
        `storage/part/${messageID}/**/*.json`,
        `storage/part/${sessionID}/**/*.json`,
    ];
    for (const pattern of patterns) {
        let files = [];
        try {
            files = fgSync(pattern, { cwd: dataRoot, absolute: true, onlyFiles: true, suppressErrors: true });
        } catch {
            files = [];
        }
        if (!files.length) continue; // try the next layout

        const parts = [];
        for (const file of files) {
            let raw = "";
            try { raw = fsSync.readFileSync(file, "utf8"); } catch { continue; }
            const part = safeJsonParse(raw);
            if (part && typeof part === "object" && part.type) parts.push(part);
        }
        return parts; // first layout that matched wins — avoid cross-message bleed
    }
    return [];
}

function extractSessionIdFromMessagePath(filePath) {
    // …/storage/message/<sessionID>/msg_<id>.json  or  …/storage/session/message/<sessionID>/<id>.json
    const match = filePath.match(/storage\/(?:session\/)?message\/([^/]+)\/[^/]+$/);
    return match ? match[1] : path.basename(filePath, ".json");
}

export function parseOpencodeLegacyMessage({ fileContents, filePath }) {
    const parsed = safeJsonParse(typeof fileContents === "string" ? fileContents : fileContents.toString("utf8"));
    if (!parsed || typeof parsed !== "object") return [];

    // message files carry role + sessionID; session-info files do not
    const role = String(parsed.role ?? "").toLowerCase();
    if (role !== "user" && role !== "assistant") return [];

    const sessionID = parsed.sessionID ?? parsed.session_id ?? extractSessionIdFromMessagePath(filePath);
    const messageID = parsed.id ?? path.basename(filePath, ".json");
    const ts = opencodeTimeToIso(parsed?.time?.created);

    const dataRoot = findDataRoot(filePath);
    const parts = readLegacyParts(dataRoot, sessionID, messageID);
    const text = parts.map(v1PartText).filter(Boolean).join("\n\n");
    if (!text) return [];

    const kind = normalizeRole(role, "assistant");
    return [{
        sessionId: sessionID,
        eventType: `opencode.${kind === "user" ? "user" : "assistant"}`,
        kind,
        timestamp: ts,
        message: toMessage(text),
        raw: parsed,
    }];
}

// ── entry point (daemon parseFile hook) ──

export function parseOpencodeFile({ fileContents, filePath }) {
    // SQLite DB (read as Buffer by the daemon via readBinary)
    if (Buffer.isBuffer(fileContents) && fileContents.length >= 16) {
        if (fileContents.subarray(0, 16).equals(SQLITE_MAGIC)) {
            return parseOpencodeDb(filePath);
        }
    }

    // legacy JSON message file
    const content = typeof fileContents === "string" ? fileContents : fileContents?.toString("utf8");
    if (!content) return [];
    return parseOpencodeLegacyMessage({ fileContents: content, filePath });
}
