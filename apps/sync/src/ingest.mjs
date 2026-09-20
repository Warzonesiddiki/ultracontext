// =============================================================================
// INGEST — transcript bytes → UltraContext events (extracted from daemon.mjs, ARCH-003)
// =============================================================================
//
// The pipeline, in the order a cycle runs it:
//
//   processSource  glob the harness, then walk files with bounded concurrency
//     └ processFile
//         ├ JSONL sources: readNewLines from the stored byte offset → parse each
//         │   line → dedupe by event id → appendBulkToUltraContext
//         └ whole-file sources (`parseFile`: Gemini JSON, the opencode SQLite
//             DB): hash the contents, skip if unchanged, then filter per event
//
//   appendBulkToUltraContext groups the new events by session, resolves one
//   context per session (created once, then cached in the local store), and
//   posts each session's payloads in batches of BULK_BATCH_SIZE.
//
// Two rules this module exists to protect:
//
//   * OFFSETS ARE THE RESUME POINT. A file is never re-read from the start
//     unless it shrank (rotation/truncation), and a trailing partial line is
//     never consumed — the offset only advances to the last newline, so a
//     transcript still being written is picked up complete on the next cycle.
//   * DEDUPE IS CONTENT-ADDRESSED. Event ids hash (source, host, user, session,
//     file, offset/line, line content), so the same event arriving twice — two
//     cycles racing, a restarted daemon, a re-run bootstrap — is appended once.
//
// Dependencies are injected (`cfg`, the stat bumpers, the logger, the source
// helpers) so this module can be driven from a test with a fake store and a fake
// `uc` client: no network, no ~/.claude, no daemon.

import fs from "node:fs/promises";

import { redact } from "./redact.mjs";
import { eventOccurredAt, sha256, toInt } from "./utils.mjs";
import { matchesConfiguredProjectPath } from "./onboarding-preferences.mjs";

// bulk ingestion tunables
export const BULK_BATCH_SIZE = 50;
export const FILE_CONCURRENCY = 8;
export const SESSION_CONCURRENCY = 6;

/** An event is "recent" for the `last_24h` bootstrap mode. */
export function isWithinLast24h(timestamp, nowMs = Date.now()) {
  if (!timestamp) return false;
  const d = new Date(String(timestamp));
  if (Number.isNaN(d.getTime())) return false;
  return nowMs - d.getTime() <= 24 * 60 * 60 * 1000;
}

/**
 * Run async tasks with bounded concurrency. Results are written by index, so
 * the returned array matches the input order no matter which worker finished
 * first — callers rely on that for deterministic offsets.
 */
export async function parallelMap(items, concurrency, fn) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg         live daemon config (host, userId, dedupeTtlSec,
 *                                  maxReadBytes, logAppends, projectPaths)
 * @param {object} deps.stats       `{ bumpStat, bumpSourceStat, noteSourceActivity }`
 * @param {Function} deps.log       daemon logger
 * @param {Function} deps.errorDetails  error → loggable fields
 * @param {object} deps.sourceFiles `{ listSourceFiles, resolveSourceFileProjectPath,
 *                                     extractProjectPathFromNormalized }` from sources.mjs
 */
export function createIngest({ cfg, stats, log, errorDetails, sourceFiles }) {
  const { listSourceFiles, resolveSourceFileProjectPath, extractProjectPathFromNormalized } = sourceFiles;
  const { bumpStat, bumpSourceStat, noteSourceActivity } = stats;

  // ── local store keys ──────────────────────────────────────────────────────
  // Scoped by source, and (for sessions) by host+user, so one store shared
  // between machines or users can never hand back someone else's context.

  function offsetStoreKey(sourceName, fileId) { return `offset:${sourceName}:${fileId}`; }
  function seenEventStoreKey(sourceName, eventId) { return `seen:${sourceName}:${eventId}`; }
  function sessionContextStoreKey(sourceName, sessionId) { return `ctx:session:${sourceName}:${cfg.host}:${cfg.userId}:${sessionId}`; }

  function markEventSeen(store, sourceName, eventId) {
    return store.markEventSeen(seenEventStoreKey(sourceName, eventId), cfg.dedupeTtlSec);
  }

  /**
   * Prime every existing file's offset to EOF: the "new only" bootstrap answer.
   * Whole-file sources store a content hash instead of a size, matching what
   * processFile compares against.
   */
  async function primeOffsetsToEof(store, source, shouldStop = () => false) {
    if (shouldStop()) return;
    const files = await listSourceFiles(source);
    for (const filePath of files) {
      if (shouldStop()) break;
      try {
        const stat = await fs.stat(filePath);
        const fileId = `${stat.dev}:${stat.ino}`;

        // JSON-format sources (e.g. Gemini) and binary formats (opencode DB):
        // store content hash to match processFile's comparison
        if (source.parseFile) {
          const contents = source.readBinary ? await fs.readFile(filePath) : await fs.readFile(filePath, "utf8");
          store.setOffset(offsetStoreKey(source.name, fileId), sha256(contents));
        } else {
          store.setOffset(offsetStoreKey(source.name, fileId), stat.size);
        }
      } catch { /* ignore */ }
    }
  }

  // prevent duplicate context creation when files are processed in parallel
  const contextCreateInflight = new Map();

  async function getOrCreateContext(store, uc, cacheKey, metadata, sourceName) {
    const cached = store.getContextCache(cacheKey);
    if (cached) return cached;

    // coalesce concurrent creates for the same cache key
    if (contextCreateInflight.has(cacheKey)) return contextCreateInflight.get(cacheKey);

    const pending = (async () => {
      try {
        const created = await uc.create({ metadata });
        store.setContextCache(cacheKey, created.id);
        bumpStat("contextsCreated");
        bumpSourceStat(sourceName, "contextsCreated");
        if (cfg.logAppends) {
          log("info", "Context created", {
            source: sourceName, context_id: created.id,
            session_id: metadata?.session_id ?? "",
          });
        }
        return created.id;
      } catch (error) {
        const details = errorDetails(error);
        bumpStat("errors");
        bumpSourceStat(sourceName, "errors");
        log("warn", "Failed to create context with metadata", details);

        if (details.status === 400) {
          // a server that rejects the metadata block still accepts a bare
          // context — losing the transcript is worse than losing the labels
          const created = await uc.create();
          store.setContextCache(cacheKey, created.id);
          bumpStat("contextsCreated");
          bumpSourceStat(sourceName, "contextsCreated");
          if (cfg.logAppends) {
            log("warn", "Context created without metadata fallback", {
              source: sourceName, context_id: created.id,
            });
          }
          return created.id;
        }
        throw error;
      } finally {
        contextCreateInflight.delete(cacheKey);
      }
    })();

    contextCreateInflight.set(cacheKey, pending);
    return pending;
  }

  /**
   * The single-event append path. NOTE: nothing calls this today — processFile
   * batches through `appendBulkToUltraContext` — but it is kept because it is
   * the documented per-event contract (and the fallback if batching is ever
   * disabled). Deleting it is a separate decision from moving it.
   */
  async function appendToUltraContext({ store, uc, sourceName, normalized, eventId, filePath, lineOffset, projectPath = "" }) {

    // enrich context metadata with project path + first event timestamp
    const contextMeta = {
      source: sourceName, host: cfg.host, user_id: cfg.userId,
      session_id: normalized.sessionId,
      started_at: normalized.timestamp,
    };
    if (projectPath) contextMeta.project_path = projectPath;

    const sessionContextId = await getOrCreateContext(store, uc,
      sessionContextStoreKey(sourceName, normalized.sessionId),
      contextMeta, sourceName,
    );

    const safeRaw = redact(normalized.raw);
    const payload = {
      role: normalized.kind,
      content: { message: normalized.message, event_type: normalized.eventType, timestamp: normalized.timestamp, raw: safeRaw },
      metadata: { source: sourceName, host: cfg.host, user_id: cfg.userId, session_id: normalized.sessionId, event_id: eventId, file_path: filePath, file_offset: lineOffset, occurred_at: eventOccurredAt(normalized.timestamp) },
    };

    await uc.append(sessionContextId, payload);
    bumpStat("appended");
    bumpSourceStat(sourceName, "appended");
    noteSourceActivity(sourceName, { lastEventType: normalized.eventType, lastSessionId: normalized.sessionId, lastAt: Date.now() });

    if (cfg.logAppends) {
      log("info", "Appended event to session context", {
        source: sourceName, session_id: normalized.sessionId, context_id: sessionContextId,
        event_type: normalized.eventType, role: normalized.kind, event_id: eventId,
      });
    }
  }

  async function appendBulkToUltraContext({ store, uc, sourceName, events, filePath, projectPath = "" }) {

    // group events by session id
    const bySession = new Map();
    for (const ev of events) {
      const key = ev.normalized.sessionId;
      if (!bySession.has(key)) bySession.set(key, []);
      bySession.get(key).push(ev);
    }

    // resolve all context ids first (sequential — touches local store)
    const sessionEntries = [...bySession.entries()];
    const contextIds = new Map();
    for (const [sessionId, sessionEvents] of sessionEntries) {
      const contextMeta = {
        source: sourceName, host: cfg.host, user_id: cfg.userId,
        session_id: sessionId,
        started_at: sessionEvents[0].normalized.timestamp,
      };
      const sessionProjectPath = sessionEvents.find((event) => event.projectPath)?.projectPath || projectPath;
      if (sessionProjectPath) contextMeta.project_path = sessionProjectPath;

      // extract title from first real user message
      const isRealUserEvent = (ev) => {
        if (ev.normalized.kind !== "user") return false;
        const et = ev.normalized.eventType ?? "";
        const msg = ev.normalized.message ?? "";
        // skip codex system-injected user messages (AGENTS.md, permissions)
        if (et === "response_item.message") return false;
        // skip openclaw session init + claude tool results + xml tags
        if (msg.startsWith("A new session was started")) return false;
        if (msg.startsWith("[result]")) return false;
        if (msg.startsWith("<")) return false;
        return true;
      };
      const firstUserEvent = sessionEvents.find(isRealUserEvent)
        ?? sessionEvents.find(ev => ev.normalized.kind === "user");
      if (firstUserEvent?.normalized?.message) {
        contextMeta.title = firstUserEvent.normalized.message.replace(/[\r\n\t\v\f\x00-\x1f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 120);
      }
      const ctxId = await getOrCreateContext(store, uc,
        sessionContextStoreKey(sourceName, sessionId),
        contextMeta, sourceName,
      );
      contextIds.set(sessionId, ctxId);
    }

    // send bulk requests in parallel across sessions
    await parallelMap(sessionEntries, SESSION_CONCURRENCY, async ([sessionId, sessionEvents]) => {
      const sessionContextId = contextIds.get(sessionId);

      // build payloads array
      const payloads = sessionEvents.map(({ normalized, eventId, lineOffset }) => {
        const safeRaw = redact(normalized.raw);
        return {
          role: normalized.kind,
          content: { message: normalized.message, event_type: normalized.eventType, timestamp: normalized.timestamp, raw: safeRaw },
          metadata: { source: sourceName, host: cfg.host, user_id: cfg.userId, session_id: sessionId, event_id: eventId, file_path: filePath, file_offset: lineOffset, occurred_at: eventOccurredAt(normalized.timestamp) },
        };
      });

      // send in batches of BULK_BATCH_SIZE
      for (let i = 0; i < payloads.length; i += BULK_BATCH_SIZE) {
        const batch = payloads.slice(i, i + BULK_BATCH_SIZE);
        await uc.append(sessionContextId, batch);
      }

      // update stats
      bumpStat("appended", sessionEvents.length);
      bumpSourceStat(sourceName, "appended", sessionEvents.length);
      const last = sessionEvents[sessionEvents.length - 1].normalized;
      noteSourceActivity(sourceName, { lastEventType: last.eventType, lastSessionId: sessionId, lastAt: Date.now() });

      if (cfg.logAppends) {
        for (const { normalized } of sessionEvents) {
          const msg = (normalized.message ?? "").replace(/[\r\n\t\v\f\x00-\x1f]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 80);
          log("info", `[${normalized.eventType}] ${msg}`, {
            source: sourceName, session_id: sessionId,
          });
        }
      }
    });
  }

  // ── file reading ──────────────────────────────────────────────────────────

  /**
   * Read the bytes added since `offset` and return complete lines only.
   *
   * Three guards that matter more than they look:
   *   * `start > stat.size` → the file was rotated/truncated: restart at 0
   *     rather than reading past EOF forever.
   *   * no newline in the chunk → return nothing and DO NOT advance the offset;
   *     the writer is mid-line and the tail must stay unread.
   *   * `cfg.maxReadBytes` caps a single cycle's read, so a 400MB transcript
   *     that appeared overnight is consumed over several cycles instead of
   *     stalling the loop.
   */
  async function readNewLines(filePath, offset) {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      let start = offset;
      if (start > stat.size) start = 0;
      const unread = stat.size - start;
      if (unread <= 0) return { lines: [], nextOffset: start, fileId: `${stat.dev}:${stat.ino}` };

      const readLen = Math.min(unread, cfg.maxReadBytes);
      const buffer = Buffer.allocUnsafe(readLen);
      const { bytesRead } = await handle.read(buffer, 0, readLen, start);
      const chunk = buffer.subarray(0, bytesRead);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline === -1) return { lines: [], nextOffset: start, fileId: `${stat.dev}:${stat.ino}` };

      const text = chunk.subarray(0, lastNewline + 1).toString("utf8");
      const lines = [];
      let consumed = 0;
      for (const line of text.split("\n")) {
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        const lineOffset = start + consumed;
        consumed += lineBytes;
        if (!line.trim()) continue;
        lines.push({ line, lineOffset });
      }
      return { lines, nextOffset: start + lastNewline + 1, fileId: `${stat.dev}:${stat.ino}` };
    } finally {
      await handle.close();
    }
  }

  async function processFile({ store, uc, source, filePath, shouldStop = () => false, ingestMode = "all" }) {
    if (shouldStop()) return;
    try {
      const stat = await fs.stat(filePath);
      bumpStat("filesScanned");
      bumpSourceStat(source.name, "filesScanned");

      const fileId = `${stat.dev}:${stat.ino}`;
      const offsetKey = offsetStoreKey(source.name, fileId);
      const fileProjectPath = await resolveSourceFileProjectPath({ source, filePath, fileId });

      // whole-file sources (parseFile) filter per-event below — an unknown
      // file-level path must not skip the whole file (e.g. an opencode DB
      // holds sessions from many projects); JSONL sources keep the file gate
      if (!source.parseFile && !matchesConfiguredProjectPath(cfg.projectPaths, fileProjectPath)) {
        return;
      }

      // JSON-format sources (e.g. Gemini) and binary formats (opencode's
      // SQLite DB): read entire file, dedup by content hash
      if (source.parseFile) {
        const fileContents = source.readBinary
          ? await fs.readFile(filePath)
          : await fs.readFile(filePath, "utf8");
        const contentHash = sha256(fileContents);
        const storedHash = store.getOffset(offsetKey);
        if (storedHash === contentHash) return;

        noteSourceActivity(source.name, { lastFile: filePath, lastAt: Date.now() });
        const allEvents = source.parseFile({ fileContents, filePath });
        if (!Array.isArray(allEvents) || allEvents.length === 0) return;

        bumpStat("linesRead", allEvents.length);
        bumpSourceStat(source.name, "linesRead", allEvents.length);

        const pendingEvents = [];
        for (let i = 0; i < allEvents.length; i++) {
          if (shouldStop()) break;
          const normalized = allEvents[i];
          if (!normalized || !normalized.sessionId) continue;
          if (ingestMode === "last_24h" && !isWithinLast24h(normalized.timestamp)) continue;

          // per-event project path (e.g. opencode DB rows carry session.cwd /
          // session.directory) falls back to the file-level discovery
          const eventProjectPath = extractProjectPathFromNormalized(normalized) || fileProjectPath;
          if (!matchesConfiguredProjectPath(cfg.projectPaths, eventProjectPath)) continue;

          bumpStat("parsedEvents");
          bumpSourceStat(source.name, "parsedEvents");
          noteSourceActivity(source.name, { lastEventType: normalized.eventType, lastSessionId: normalized.sessionId, lastAt: Date.now() });

          const eventId = sha256(`${source.name}|${cfg.host}|${cfg.userId}|${normalized.sessionId}|${fileId}|${i}`);
          const isNew = markEventSeen(store, source.name, eventId);
          if (!isNew) { bumpStat("deduped"); bumpSourceStat(source.name, "deduped"); continue; }

          pendingEvents.push({ normalized, eventId, lineOffset: i, projectPath: eventProjectPath });
        }

        if (pendingEvents.length > 0) {
          await appendBulkToUltraContext({
            store,
            uc,
            sourceName: source.name,
            events: pendingEvents,
            filePath,
            projectPath: fileProjectPath,
          });
        }
        store.setOffset(offsetKey, contentHash);
        return;
      }

      // JSONL-format sources: read new lines from byte offset
      const currentOffset = toInt(store.getOffset(offsetKey), 0);
      const { lines, nextOffset } = await readNewLines(filePath, currentOffset);

      bumpStat("linesRead", lines.length);
      bumpSourceStat(source.name, "linesRead", lines.length);
      noteSourceActivity(source.name, { lastFile: filePath, lastAt: Date.now() });
      if (lines.length === 0) return;

      // collect all new events, then bulk-append per session
      const pendingEvents = [];

      for (const { line, lineOffset } of lines) {
        if (shouldStop()) break;
        const normalized = source.parseLine({ line, filePath });
        if (!normalized || !normalized.sessionId) continue;
        if (ingestMode === "last_24h" && !isWithinLast24h(normalized.timestamp)) continue;

        bumpStat("parsedEvents");
        bumpSourceStat(source.name, "parsedEvents");
        noteSourceActivity(source.name, { lastEventType: normalized.eventType, lastSessionId: normalized.sessionId, lastAt: Date.now() });

        const eventId = sha256(`${source.name}|${cfg.host}|${cfg.userId}|${normalized.sessionId}|${fileId}|${lineOffset}|${sha256(line)}`);
        const isNew = markEventSeen(store, source.name, eventId);
        if (!isNew) { bumpStat("deduped"); bumpSourceStat(source.name, "deduped"); continue; }

        pendingEvents.push({ normalized, eventId, lineOffset, projectPath: fileProjectPath });
      }

      // bulk append all collected events
      if (pendingEvents.length > 0) {
        await appendBulkToUltraContext({
          store,
          uc,
          sourceName: source.name,
          events: pendingEvents,
          filePath,
          projectPath: fileProjectPath,
        });
      }

      store.setOffset(offsetKey, nextOffset);
    } catch (error) {
      bumpStat("errors");
      bumpSourceStat(source.name, "errors");
      log("warn", `Failed to process file for source=${source.name}`, { filePath, ...errorDetails(error) });
    }
  }

  async function processSource({ store, uc, source, shouldStop = () => false, ingestMode = "all" }) {
    if (shouldStop()) return;
    let files = [];
    try { files = await listSourceFiles(source); } catch (error) {
      bumpStat("errors");
      log("warn", `Failed to list files for source=${source.name}`, { error: error instanceof Error ? error.message : String(error) });
      return;
    }

    // process files concurrently
    await parallelMap(
      files.filter(() => !shouldStop()),
      FILE_CONCURRENCY,
      (filePath) => processFile({ store, uc, source, filePath, shouldStop, ingestMode }),
    );
  }

  return {
    offsetStoreKey,
    seenEventStoreKey,
    sessionContextStoreKey,
    markEventSeen,
    primeOffsetsToEof,
    getOrCreateContext,
    appendToUltraContext,
    appendBulkToUltraContext,
    readNewLines,
    processFile,
    processSource,
  };
}
