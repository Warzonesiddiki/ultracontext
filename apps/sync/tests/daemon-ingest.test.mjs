// =============================================================================
// ARCH-003 — ingest.mjs: transcript bytes → UltraContext events.
//
// The daemon had no tests before this split, so this file is the safety net for
// the refactor AND the specification of the two invariants that make ingestion
// trustworthy:
//
//   1. OFFSETS ARE THE RESUME POINT — a file is read from where the last cycle
//      stopped, a half-written trailing line is never consumed, a shrunk
//      (rotated) file restarts at 0, and one cycle never reads more than
//      cfg.maxReadBytes.
//   2. DEDUPE IS CONTENT-ADDRESSED — the same event can arrive twice (racing
//      cycles, a restart, a re-read after rotation) and is appended once.
//
// The harness below wires stats + logger + sources + ingest exactly the way
// daemon.mjs does, so a broken seam between the extracted modules fails here.
// No network, no ~/.claude, no daemon process: a fake store and a fake client.
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createLogger } from "../src/logger.mjs";
import { createStats } from "../src/stats.mjs";
import { createProjectPathResolver, extractProjectPathFromNormalized, listSourceFiles } from "../src/sources.mjs";
import {
  BULK_BATCH_SIZE,
  FILE_CONCURRENCY,
  SESSION_CONCURRENCY,
  createIngest,
  isWithinLast24h,
  parallelMap,
} from "../src/ingest.mjs";

// ── fakes ────────────────────────────────────────────────────────────────────

function fakeStore() {
  const offsets = new Map();
  const seen = new Set();
  const contexts = new Map();
  return {
    offsets, seen, contexts,
    getOffset: (key) => (offsets.has(key) ? offsets.get(key) : null),
    setOffset: (key, value) => offsets.set(key, value),
    markEventSeen: (key) => { if (seen.has(key)) return false; seen.add(key); return true; },
    getContextCache: (key) => contexts.get(key) ?? null,
    setContextCache: (key, id) => contexts.set(key, id),
    cleanupExpired: () => {},
    close: () => {},
  };
}

function fakeUc({ createError = null } = {}) {
  const calls = { create: [], append: [] };
  let created = 0;
  let pendingError = createError;
  return {
    calls,
    async create(arg) {
      calls.create.push(arg);
      if (pendingError) {
        const error = pendingError;
        pendingError = null;                                 // fail once, then recover
        throw error;
      }
      created += 1;
      return { id: `ctx_${created}` };
    },
    async append(contextId, payload) {
      calls.append.push({ contextId, payload });
      return { ok: true };
    },
  };
}

const httpError = (status, message = "bad request") => Object.assign(new Error(message), { status, url: "https://api/contexts" });

/** cfg with the daemon's defaults; override per test. */
function baseCfg(overrides = {}) {
  return {
    host: "test-host",
    userId: "test-user",
    dedupeTtlSec: 3600,
    maxReadBytes: 4 * 1024 * 1024,
    logAppends: true,
    projectPaths: [],
    logLevel: "info",
    verboseLogs: false,
    uiRecentLimit: 240,
    ...overrides,
  };
}

/** Wire the extracted modules together the way daemonBoot does. */
function harness(cfgOverrides = {}) {
  const cfg = baseCfg(cfgOverrides);
  const state = { recentLogs: [], sourceStats: new Map(), sourceOrder: [] };
  const lines = [];
  const statsApi = createStats({ state });
  const logger = createLogger({
    cfg,
    state,
    runtime: {},
    out: (line) => lines.push(line),
  });
  const projectPaths = createProjectPathResolver({ cache: new Map() });
  const ingest = createIngest({
    cfg,
    stats: {
      bumpStat: statsApi.bumpStat,
      bumpSourceStat: statsApi.bumpSourceStat,
      noteSourceActivity: statsApi.noteSourceActivity,
    },
    log: logger.log,
    errorDetails: logger.errorDetails,
    sourceFiles: {
      listSourceFiles,
      resolveSourceFileProjectPath: projectPaths.resolveSourceFileProjectPath,
      extractProjectPathFromNormalized,
    },
  });
  return { cfg, state, lines, stats: statsApi.stats, sourceStats: state.sourceStats, ...statsApi, ...ingest };
}

/** A JSONL source whose records are `{sessionId, kind, eventType, message, timestamp, cwd}`. */
function fakeJsonlSource(name = "fake") {
  return {
    name,
    enabled: true,
    globs: [],
    parseLine: ({ line }) => {
      try {
        const raw = JSON.parse(line);
        if (!raw.sessionId) return null;
        return {
          sessionId: raw.sessionId,
          kind: raw.kind ?? "user",
          eventType: raw.eventType ?? "message",
          message: raw.message ?? "",
          timestamp: raw.timestamp ?? new Date().toISOString(),
          raw,
        };
      } catch { return null; }
    },
  };
}

const record = (sessionId, message, extra = {}) => JSON.stringify({
  sessionId, kind: "user", eventType: "message", message,
  timestamp: new Date().toISOString(), ...extra,
});

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-ingest-"));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("ingest: parallelMap", () => {
  it("preserves input order no matter which worker finishes first", async () => {
    const items = [50, 5, 30, 1, 20];
    const results = await parallelMap(items, 3, async (ms, index) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return index * 100;
    });
    assert.deepEqual(results, [0, 100, 200, 300, 400]);
  });

  it("never runs more tasks than the concurrency bound", async () => {
    let live = 0;
    let peak = 0;
    await parallelMap(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 2));
      live -= 1;
    });
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
    assert.ok(peak > 1, "expected real parallelism, not a serial walk");
  });

  it("handles empty input and a bound larger than the work", async () => {
    assert.deepEqual(await parallelMap([], 8, async () => 1), []);
    assert.deepEqual(await parallelMap([1, 2], 100, async (n) => n * 2), [2, 4]);
  });

  it("publishes the tunables the daemon batches with", () => {
    assert.equal(BULK_BATCH_SIZE, 50);
    assert.equal(FILE_CONCURRENCY, 8);
    assert.equal(SESSION_CONCURRENCY, 6);
  });
});

describe("ingest: isWithinLast24h", () => {
  it("accepts a fresh ISO timestamp", () => {
    const now = Date.now();
    assert.equal(isWithinLast24h(new Date(now - 1000).toISOString(), now), true);
  });

  it("REJECTS epoch timestamps — a pre-existing quirk, pinned not blessed", () => {
    // `new Date(String(1789000000000))` is Invalid in V8, so a numeric (or
    // digit-string) timestamp reads as "not within 24h" and a `last_24h`
    // bootstrap would skip those events. utils.mjs `eventOccurredAt` routes
    // digit-only strings through Number() for exactly this reason; this
    // function does not. Left as-is because ARCH-003 moves code, it does not
    // change it — fixing it deserves its own item and its own test.
    const now = Date.now();
    assert.equal(isWithinLast24h(now - 1000, now), false);
    assert.equal(isWithinLast24h(String(now - 1000), now), false);
  });

  it("rejects anything older than a day, and anything unparseable", () => {
    const now = Date.now();
    assert.equal(isWithinLast24h(new Date(now - 25 * 3600 * 1000).toISOString(), now), false);
    assert.equal(isWithinLast24h("", now), false);
    assert.equal(isWithinLast24h(null, now), false);
    assert.equal(isWithinLast24h(undefined, now), false);
    assert.equal(isWithinLast24h("not a date", now), false);
  });

  it("is exactly 24h, inclusive at the boundary", () => {
    const now = Date.now();
    assert.equal(isWithinLast24h(new Date(now - 24 * 3600 * 1000).toISOString(), now), true);
    assert.equal(isWithinLast24h(new Date(now - 24 * 3600 * 1000 - 1).toISOString(), now), false);
  });
});

describe("ingest: local store keys", () => {
  it("scopes offsets and seen-events by source, and session contexts by host + user", () => {
    const h = harness();
    assert.equal(h.offsetStoreKey("codex", "1:2"), "offset:codex:1:2");
    assert.equal(h.seenEventStoreKey("codex", "abc"), "seen:codex:abc");
    assert.equal(
      h.sessionContextStoreKey("codex", "s1"),
      "ctx:session:codex:test-host:test-user:s1",
    );
    // two users on one machine must never share a context mapping
    const other = harness({ userId: "someone-else" });
    assert.notEqual(other.sessionContextStoreKey("codex", "s1"), h.sessionContextStoreKey("codex", "s1"));
  });

  it("markEventSeen reports new vs already-seen and passes the dedupe TTL through", () => {
    const h = harness();
    const store = fakeStore();
    const ttl = [];
    store.markEventSeen = (key, seconds) => {
      ttl.push(seconds);
      if (store.seen.has(key)) return false;
      store.seen.add(key);
      return true;
    };
    assert.equal(h.markEventSeen(store, "codex", "e1"), true);
    assert.equal(h.markEventSeen(store, "codex", "e1"), false);
    assert.deepEqual(ttl, [3600, 3600]);
  });
});

// ── readNewLines: the resume contract ────────────────────────────────────────

describe("ingest: readNewLines", () => {
  it("reads whole lines from the offset and returns the next one", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "one\ntwo\nthree\n", "utf8");

      const first = await h.readNewLines(file, 0);
      assert.deepEqual(first.lines.map((l) => l.line), ["one", "two", "three"]);
      assert.deepEqual(first.lines.map((l) => l.lineOffset), [0, 4, 8]);   // byte offsets
      assert.equal(first.nextOffset, 14);
      assert.match(first.fileId, /^\d+:\d+$/);                              // dev:ino

      const second = await h.readNewLines(file, first.nextOffset);
      assert.deepEqual(second.lines, []);
      assert.equal(second.nextOffset, 14);
      assert.equal(second.fileId, first.fileId);
    });
  });

  it("leaves a half-written trailing line unread and does NOT advance past it", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "complete\npartial", "utf8");

      const first = await h.readNewLines(file, 0);
      assert.deepEqual(first.lines.map((l) => l.line), ["complete"]);
      assert.equal(first.nextOffset, 9);                                    // stops after the newline

      await fs.writeFile(file, "complete\npartial-now-done\n", "utf8");
      const second = await h.readNewLines(file, first.nextOffset);
      assert.deepEqual(second.lines.map((l) => l.line), ["partial-now-done"]);
      assert.equal(second.lines[0].lineOffset, 9);
      assert.equal(second.nextOffset, 9 + Buffer.byteLength("partial-now-done\n", "utf8"));
    });
  });

  it("returns nothing when the chunk has no newline at all (a very long line in progress)", async () => {
    await withTempDir(async (dir) => {
      const h = harness({ maxReadBytes: 16 });
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "x".repeat(200), "utf8");                     // no newline anywhere

      const result = await h.readNewLines(file, 0);
      assert.deepEqual(result.lines, []);
      assert.equal(result.nextOffset, 0);                                   // unchanged: retry next cycle
    });
  });

  it("restarts at 0 when the file shrank (rotation/truncation)", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "aaa\nbbb\nccc\n", "utf8");
      const first = await h.readNewLines(file, 0);
      assert.equal(first.nextOffset, 12);

      await fs.writeFile(file, "zzz\n", "utf8");                             // rotated to a shorter file
      const after = await h.readNewLines(file, first.nextOffset);
      assert.deepEqual(after.lines.map((l) => l.line), ["zzz"]);
      assert.equal(after.lines[0].lineOffset, 0);
      assert.equal(after.nextOffset, 4);
    });
  });

  it("reads at most cfg.maxReadBytes per call, so a huge backlog cannot stall a cycle", async () => {
    await withTempDir(async (dir) => {
      const h = harness({ maxReadBytes: 20 });
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "123456789\n".repeat(50), "utf8");           // 500 bytes

      const first = await h.readNewLines(file, 0);
      assert.equal(first.lines.length, 2);                                  // 20 bytes → two 10-byte lines
      assert.equal(first.nextOffset, 20);

      const second = await h.readNewLines(file, first.nextOffset);
      assert.equal(second.nextOffset, 40);                                  // resumes exactly where it stopped
      assert.equal(second.lines[0].lineOffset, 20);
    });
  });

  it("skips blank lines but still counts their bytes in the offsets", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "a\n\n   \nb\n", "utf8");
      const result = await h.readNewLines(file, 0);
      assert.deepEqual(result.lines, [
        { line: "a", lineOffset: 0 },
        { line: "b", lineOffset: Buffer.byteLength("a\n\n   \n", "utf8") },   // 7: blanks counted
      ]);
      assert.equal(result.nextOffset, Buffer.byteLength("a\n\n   \nb\n", "utf8"));
    });
  });

  it("counts multi-byte characters in bytes, not code points", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const file = path.join(dir, "a.jsonl");
      await fs.writeFile(file, "héllo→\nsecond\n", "utf8");
      const result = await h.readNewLines(file, 0);
      assert.deepEqual(result.lines.map((l) => l.line), ["héllo→", "second"]);
      assert.equal(result.lines[1].lineOffset, Buffer.byteLength("héllo→\n", "utf8"));
      assert.equal(result.nextOffset, Buffer.byteLength("héllo→\nsecond\n", "utf8"));
    });
  });
});

// ── context resolution ───────────────────────────────────────────────────────

describe("ingest: getOrCreateContext", () => {
  it("creates once, caches the id, and counts it", async () => {
    const h = harness();
    const store = fakeStore();
    const uc = fakeUc();

    const first = await h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex");
    assert.equal(first, "ctx_1");
    assert.equal(uc.calls.create.length, 1);
    assert.deepEqual(uc.calls.create[0], { metadata: { session_id: "s1" } });
    assert.equal(store.contexts.get("key1"), "ctx_1");
    assert.equal(h.stats.contextsCreated, 1);
    assert.equal(h.sourceStats.get("codex").contextsCreated, 1);

    const second = await h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex");
    assert.equal(second, "ctx_1");
    assert.equal(uc.calls.create.length, 1);                                 // served from the local cache
    assert.equal(h.stats.contextsCreated, 1);
  });

  it("coalesces concurrent creates for the same key — parallel files must not double-create", async () => {
    const h = harness();
    const store = fakeStore();
    const uc = fakeUc();
    const ids = await Promise.all([
      h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex"),
      h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex"),
      h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex"),
    ]);
    assert.deepEqual(ids, ["ctx_1", "ctx_1", "ctx_1"]);
    assert.equal(uc.calls.create.length, 1);
    assert.equal(h.stats.contextsCreated, 1);
  });

  it("falls back to a metadata-less create on a 400, and says so in the log", async () => {
    const h = harness();
    const store = fakeStore();
    const uc = fakeUc({ createError: httpError(400) });

    const id = await h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex");
    assert.equal(id, "ctx_1");                                               // the failed create consumed no id
    assert.equal(uc.calls.create.length, 2);
    assert.equal(uc.calls.create[1], undefined);                             // retried with NO argument at all
    assert.equal(store.contexts.get("key1"), "ctx_1");
    assert.equal(h.stats.contextsCreated, 1);
    assert.equal(h.stats.errors, 1);
    assert.ok(h.state.recentLogs.some((row) => row.text === "Context create warning"));
  });

  it("rethrows a non-400 failure after counting it, and clears the inflight slot", async () => {
    const h = harness();
    const store = fakeStore();
    const uc = fakeUc({ createError: httpError(500, "boom") });

    await assert.rejects(
      () => h.getOrCreateContext(store, uc, "key1", { session_id: "s1" }, "codex"),
      /boom/,
    );
    assert.equal(h.stats.errors, 1);
    assert.equal(store.contexts.size, 0);

    // the failed create must not poison the next attempt for the same key
    const healthy = fakeUc();
    assert.equal(await h.getOrCreateContext(store, healthy, "key1", { session_id: "s1" }, "codex"), "ctx_1");
  });

  it("logs the creation only when logAppends is on", async () => {
    const quiet = harness({ logAppends: false });
    const store = fakeStore();
    await quiet.getOrCreateContext(store, fakeUc(), "key1", { session_id: "s1" }, "codex");
    assert.deepEqual(quiet.state.recentLogs, []);

    const loud = harness({ logAppends: true });
    await loud.getOrCreateContext(fakeStore(), fakeUc(), "key1", { session_id: "s1" }, "codex");
    assert.equal(loud.state.recentLogs.length, 1);
    assert.equal(loud.state.recentLogs[0].text, "Context created");
    assert.equal(loud.state.recentLogs[0].source, "codex");
  });
});

// ── bulk append ──────────────────────────────────────────────────────────────

describe("ingest: appendBulkToUltraContext", () => {
  const event = (sessionId, message, extra = {}) => ({
    normalized: {
      sessionId, kind: "user", eventType: "message", message,
      timestamp: "2026-09-20T06:00:00.000Z", raw: { sessionId, message },
    },
    eventId: `ev-${sessionId}-${message}`,
    lineOffset: 0,
    projectPath: "",
    ...extra,
  });

  it("groups by session and creates exactly one context per session", async () => {
    const h = harness();
    const store = fakeStore();
    const uc = fakeUc();

    await h.appendBulkToUltraContext({
      store, uc, sourceName: "codex", filePath: "/f.jsonl",
      events: [event("s1", "a"), event("s2", "b"), event("s1", "c")],
    });

    assert.equal(uc.calls.create.length, 2);
    assert.equal(uc.calls.append.length, 2);                                 // one batch per session
    const byContext = Object.fromEntries(uc.calls.append.map((call) => [call.contextId, call.payload.length]));
    assert.deepEqual(byContext, { ctx_1: 2, ctx_2: 1 });
    assert.equal(h.stats.appended, 3);
    assert.equal(h.sourceStats.get("codex").appended, 3);
  });

  it("splits a long session into batches of BULK_BATCH_SIZE, in order", async () => {
    const h = harness();
    const uc = fakeUc();
    const events = Array.from({ length: 120 }, (_, i) => event("s1", `m${i}`));

    await h.appendBulkToUltraContext({ store: fakeStore(), uc, sourceName: "codex", filePath: "/f.jsonl", events });

    assert.equal(uc.calls.append.length, 3);
    assert.deepEqual(uc.calls.append.map((call) => call.payload.length), [50, 50, 20]);
    assert.deepEqual(
      uc.calls.append[0].payload.slice(0, 2).map((p) => p.content.message),
      ["m0", "m1"],
    );
    assert.equal(uc.calls.append[2].payload.at(-1).content.message, "m119");
    assert.equal(h.stats.appended, 120);
  });

  it("sends the payload shape the API expects, with redaction applied to raw", async () => {
    const h = harness();
    const uc = fakeUc();
    const withSecret = event("s1", "run it", {
      normalized: {
        sessionId: "s1", kind: "assistant", eventType: "tool_use", message: "run it",
        timestamp: "2026-09-20T06:00:00.000Z",
        raw: { env: { AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" } },
      },
    });

    await h.appendBulkToUltraContext({
      store: fakeStore(), uc, sourceName: "codex", filePath: "/tmp/f.jsonl",
      events: [withSecret], projectPath: "/repo/a",
    });

    const [payload] = uc.calls.append[0].payload;
    assert.deepEqual(Object.keys(payload).sort(), ["content", "metadata", "role"]);
    assert.equal(payload.role, "assistant");
    assert.equal(payload.content.message, "run it");
    assert.equal(payload.content.event_type, "tool_use");
    assert.equal(payload.content.timestamp, "2026-09-20T06:00:00.000Z");
    assert.equal(payload.metadata.source, "codex");
    assert.equal(payload.metadata.host, "test-host");
    assert.equal(payload.metadata.user_id, "test-user");
    assert.equal(payload.metadata.session_id, "s1");
    assert.equal(payload.metadata.file_path, "/tmp/f.jsonl");
    assert.equal(payload.metadata.occurred_at, "2026-09-20T06:00:00.000Z");
    // SEC-006: the credential never leaves the machine
    assert.ok(!JSON.stringify(payload).includes("wJalrXUtnFEMI"));
    assert.match(JSON.stringify(payload.content.raw), /REDACTED/i);
  });

  it("titles the context from the first REAL user message, skipping injected noise", async () => {
    const h = harness();
    const uc = fakeUc();
    const userEvent = (message, eventType = "message") => ({
      ...event("s1", message),
      normalized: { ...event("s1", message).normalized, eventType },
    });

    await h.appendBulkToUltraContext({
      store: fakeStore(), uc, sourceName: "codex", filePath: "/f.jsonl",
      events: [
        userEvent("AGENTS.md contents", "response_item.message"),   // codex system-injected
        userEvent("A new session was started"),                     // openclaw init
        userEvent("[result] tool output"),                          // claude tool result
        userEvent("<command>do it</command>"),                      // xml wrapper
        userEvent("why does the daemon poll?"),                     // ← the real question
        userEvent("a later message"),
      ],
    });

    const { metadata } = uc.calls.create[0];
    assert.equal(metadata.title, "why does the daemon poll?");
  });

  it("falls back to the first user event when every candidate is noise", async () => {
    const h = harness();
    const uc = fakeUc();
    await h.appendBulkToUltraContext({
      store: fakeStore(), uc, sourceName: "codex", filePath: "/f.jsonl",
      events: [{ ...event("s1", "ignored"), normalized: { ...event("s1", "ignored").normalized, kind: "assistant" } },
               event("s1", "<command>only user line</command>")],
    });
    assert.equal(uc.calls.create[0].metadata.title, "<command>only user line</command>");
  });

  it("sanitises and truncates the title to 120 characters", async () => {
    const h = harness();
    const uc = fakeUc();
    const long = `${"word ".repeat(60)}\nwith\nnewlines`;
    await h.appendBulkToUltraContext({
      store: fakeStore(), uc, sourceName: "codex", filePath: "/f.jsonl", events: [event("s1", long)],
    });
    const { title } = uc.calls.create[0].metadata;
    assert.equal(title.length, 120);
    assert.ok(!/[\r\n]/.test(title));
    assert.ok(!/\s{2,}/.test(title));
  });

  it("omits the title when a session has no user message at all", async () => {
    const h = harness();
    const uc = fakeUc();
    const assistantOnly = { ...event("s1", "output"), normalized: { ...event("s1", "output").normalized, kind: "assistant" } };
    await h.appendBulkToUltraContext({ store: fakeStore(), uc, sourceName: "codex", filePath: "/f.jsonl", events: [assistantOnly] });
    assert.ok(!("title" in uc.calls.create[0].metadata));
  });

  it("prefers the per-event project path over the file-level one", async () => {
    const h = harness();
    const uc = fakeUc();
    await h.appendBulkToUltraContext({
      store: fakeStore(), uc, sourceName: "opencode", filePath: "/db", projectPath: "/repo/file-level",
      events: [event("s1", "a", { projectPath: "/repo/from-event" }), event("s2", "b")],
    });
    const metas = uc.calls.create.map((call) => call.metadata);
    assert.equal(metas[0].project_path, "/repo/from-event");
    assert.equal(metas[1].project_path, "/repo/file-level");
  });

  it("records the session's last activity for the TUI's per-source row", async () => {
    const h = harness();
    const uc = fakeUc();
    const last = event("s9", "final");
    last.normalized.eventType = "tool_result";
    await h.appendBulkToUltraContext({ store: fakeStore(), uc, sourceName: "claude", filePath: "/f.jsonl", events: [event("s9", "first"), last] });

    const row = h.sourceStats.get("claude");
    assert.equal(row.lastSessionId, "s9");
    assert.equal(row.lastEventType, "tool_result");
    assert.ok(row.lastAt > 0);
  });

  it("logs one line per event when logAppends is on, and none when it is off", async () => {
    const loud = harness();
    await loud.appendBulkToUltraContext({
      store: fakeStore(), uc: fakeUc(), sourceName: "codex", filePath: "/f.jsonl",
      events: [event("s1", "hello there")],
    });
    assert.equal(loud.state.recentLogs.length, 2);                            // Context created + the event
    assert.equal(loud.state.recentLogs[1].text, "[message] hello there");
    assert.equal(loud.state.recentLogs[1].source, "codex");

    const quiet = harness({ logAppends: false });
    await quiet.appendBulkToUltraContext({
      store: fakeStore(), uc: fakeUc(), sourceName: "codex", filePath: "/f.jsonl",
      events: [event("s1", "hello there")],
    });
    assert.deepEqual(quiet.state.recentLogs, []);
  });
});

// ── processFile: the JSONL resume path ───────────────────────────────────────

describe("ingest: processFile (JSONL sources)", () => {
  it("ingests a new transcript end to end and stores the resume offset", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, [
        record("s1", "first question"),
        record("s1", "second question"),
        record("s2", "other session"),
      ].join("\n") + "\n", "utf8");

      await h.processFile({ store, uc, source: fakeJsonlSource("codex"), filePath: file });

      assert.equal(h.stats.filesScanned, 1);
      assert.equal(h.stats.linesRead, 3);
      assert.equal(h.stats.parsedEvents, 3);
      assert.equal(h.stats.appended, 3);
      assert.equal(h.stats.deduped, 0);
      assert.equal(h.stats.errors, 0);
      assert.equal(uc.calls.create.length, 2);                    // one context per session
      assert.equal(uc.calls.append.length, 2);

      // the offset is the whole file, so the next cycle starts after it
      const [offsetKey, offsetValue] = [...store.offsets][0];
      assert.match(offsetKey, /^offset:codex:\d+:\d+$/);
      assert.equal(offsetValue, (await fs.stat(file)).size);
      assert.equal(store.seen.size, 3);                           // three dedupe entries

      const row = h.sourceStats.get("codex");
      assert.equal(row.filesScanned, 1);
      assert.equal(row.appended, 3);
      assert.equal(row.lastFile, file);
      assert.equal(row.lastSessionId, "s2");
    });
  });

  it("does nothing at all on a second pass over an unchanged file", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, `${record("s1", "hello")}\n`, "utf8");
      const source = fakeJsonlSource();

      await h.processFile({ store, uc, source, filePath: file });
      const appendedAfterFirst = h.stats.appended;

      await h.processFile({ store, uc, source, filePath: file });
      assert.equal(h.stats.appended, appendedAfterFirst);          // nothing new
      assert.equal(h.stats.filesScanned, 2);                       // but it was scanned
      assert.equal(h.stats.linesRead, 1);                          // and no lines were re-read
      assert.equal(uc.calls.create.length, 1);
      assert.equal(uc.calls.append.length, 1);
    });
  });

  it("picks up only the lines appended since the last cycle", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      const source = fakeJsonlSource();
      await fs.writeFile(file, `${record("s1", "one")}\n`, "utf8");
      await h.processFile({ store, uc, source, filePath: file });

      await fs.appendFile(file, `${record("s1", "two")}\n${record("s1", "three")}\n`, "utf8");
      await h.processFile({ store, uc, source, filePath: file });

      assert.equal(h.stats.linesRead, 3);                          // 1 + 2, never a re-read of "one"
      assert.equal(h.stats.appended, 3);
      assert.equal(uc.calls.create.length, 1);                     // same session → cached context
      assert.equal(uc.calls.append.length, 2);
      const appended = uc.calls.append.flatMap((call) => call.payload.map((p) => p.content.message));
      assert.deepEqual(appended, ["one", "two", "three"]);
    });
  });

  it("re-reads from 0 after a truncation but dedupes the lines it has already seen", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      const source = fakeJsonlSource();
      // dedupe is content-addressed, so the surviving line has to be the SAME
      // bytes (a fresh timestamp would make it a genuinely new event)
      const keep = `${record("s1", "keep me")}\n`;
      await fs.writeFile(file, `${keep}${record("s1", "drop me")}\n`, "utf8");
      await h.processFile({ store, uc, source, filePath: file });
      assert.equal(h.stats.appended, 2);

      // rotation: the file is now SHORTER than the stored offset
      await fs.writeFile(file, keep, "utf8");
      await h.processFile({ store, uc, source, filePath: file });

      assert.equal(h.stats.appended, 2);                           // "keep me" was NOT appended twice
      assert.equal(h.stats.deduped, 1);                            // it was seen and skipped
      assert.equal(h.stats.linesRead, 3);                          // 2 + the 1 re-read line
      assert.equal(store.offsets.get([...store.offsets.keys()][0]), Buffer.byteLength(keep, "utf8"));
    });
  });

  it("skips a file whose project path is not in cfg.projectPaths, before reading a line", async () => {
    await withTempDir(async (dir) => {
      const allowed = path.join(dir, "allowed");
      const other = path.join(dir, "other");
      const h = harness({ projectPaths: [allowed] });
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, `${record("s1", "wrong project", { cwd: other })}\n`, "utf8");

      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: file });
      assert.equal(h.stats.filesScanned, 1);
      assert.equal(h.stats.linesRead, 0);                          // gated at the file level
      assert.equal(h.stats.appended, 0);
      assert.equal(store.offsets.size, 0);                         // no offset written for a skipped file
      assert.equal(uc.calls.append.length, 0);

      // A file in scope IS ingested. Note this has to be a DIFFERENT file: the
      // discovered project path is cached per (source, dev:ino) for the daemon's
      // lifetime, so rewriting the same inode keeps the cached answer — which is
      // the point of the cache, and why a harness that rewrites transcripts in
      // place is scoped by its first-seen cwd.
      const allowedFile = path.join(dir, "allowed.jsonl");
      await fs.writeFile(allowedFile, `${record("s1", "right project", { cwd: allowed })}\n`, "utf8");
      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: allowedFile });
      assert.equal(h.stats.appended, 1);
      assert.equal(h.stats.filesScanned, 2);
    });
  });

  it("an empty cfg.projectPaths means 'capture every project'", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, `${record("s1", "anywhere", { cwd: "/some/other/place" })}\n`, "utf8");
      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: file });
      assert.equal(h.stats.appended, 1);
    });
  });

  it("ingestMode=last_24h drops old events but still advances the offset", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      await fs.writeFile(file, [
        record("s1", "ancient", { timestamp: old }),
        record("s1", "fresh"),
      ].join("\n") + "\n", "utf8");

      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: file, ingestMode: "last_24h" });

      assert.equal(h.stats.linesRead, 2);                          // both lines were read
      assert.equal(h.stats.parsedEvents, 1);                       // only the fresh one counted as parsed
      assert.equal(h.stats.appended, 1);
      assert.equal(store.offsets.get([...store.offsets.keys()][0]), (await fs.stat(file)).size);

      // and in the default mode both land
      const all = harness();
      const store2 = fakeStore();
      const uc2 = fakeUc();
      await all.processFile({ store: store2, uc: uc2, source: fakeJsonlSource(), filePath: file });
      assert.equal(all.stats.appended, 2);
    });
  });

  it("skips lines that are not JSON and records without a sessionId", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, [
        "not json at all",
        JSON.stringify({ kind: "user", message: "no session" }),
        "",
        record("s1", "real event"),
      ].join("\n") + "\n", "utf8");

      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: file });
      assert.equal(h.stats.linesRead, 3);                          // blank lines never reach the parser
      assert.equal(h.stats.parsedEvents, 1);
      assert.equal(h.stats.appended, 1);
      assert.equal(h.stats.errors, 0);                             // junk is normal, not an error
    });
  });

  it("a parser that throws is counted and logged, and the offset is NOT advanced (the cycle retries)", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, `${record("s1", "one")}\n`, "utf8");

      let boom = true;
      const exploding = {
        name: "codex",
        parseLine: () => { if (boom) throw new Error("parser exploded"); return null; },
      };
      await h.processFile({ store, uc, source: exploding, filePath: file });

      assert.equal(h.stats.errors, 1);
      assert.equal(h.sourceStats.get("codex").errors, 1);
      assert.equal(store.offsets.size, 0);                         // nothing stored → the line is retried
      const warning = h.state.recentLogs.at(-1);
      assert.equal(warning.level, "warn");
      assert.equal(warning.text, "File processing warning");       // the ring's collapsed label
      // the row's `source` column is empty here: processFile logs { filePath,
      // message } and the harness name only appears in the message text, so
      // logSourceFromData finds nothing to group by
      assert.equal(warning.source, "");
      // the raw message + details are on the console line, which is where a
      // human debugging a harness actually looks
      const consoleLine = h.lines.at(-1);
      assert.match(consoleLine, /Failed to process file for source=codex/);
      assert.match(consoleLine, /filePath=/);
      assert.match(consoleLine, /message=parser exploded/);

      boom = false;
      await h.processFile({ store, uc, source: exploding, filePath: file });
      assert.equal(h.stats.errors, 1);                             // no new error
      assert.equal(store.offsets.size, 1);                         // and now the offset landed
    });
  });

  it("shouldStop() short-circuits before any work is done", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.jsonl");
      await fs.writeFile(file, `${record("s1", "one")}\n`, "utf8");

      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: file, shouldStop: () => true });
      assert.equal(h.stats.filesScanned, 0);
      assert.equal(store.offsets.size, 0);
      assert.equal(uc.calls.append.length, 0);
    });
  });

  it("an unreadable file is a counted warning, not a crash", async () => {
    const h = harness();
    const store = fakeStore();
    await h.processFile({ store, uc: fakeUc(), source: fakeJsonlSource(), filePath: "/nope/missing.jsonl" });
    assert.equal(h.stats.errors, 1);
    assert.equal(h.stats.filesScanned, 0);                         // stat() failed before the bump
    assert.equal(h.state.recentLogs.at(-1).text, "File processing warning");
    assert.match(h.lines.at(-1), /Failed to process file for source=fake/);
  });
});

// ── processFile: whole-file sources (Gemini JSON, the opencode DB) ───────────

function fakeWholeFileSource(name = "whole", { readBinary = false } = {}) {
  return {
    name,
    enabled: true,
    globs: [],
    readBinary,
    parseFile: ({ fileContents }) => {
      const parsed = JSON.parse(String(fileContents));
      return (parsed.events ?? []).map((event) => ({
        sessionId: event.sessionId,
        kind: event.kind ?? "user",
        eventType: event.eventType ?? "message",
        message: event.message ?? "",
        timestamp: event.timestamp ?? new Date().toISOString(),
        raw: event,
      }));
    },
  };
}

const wholeFile = (events) => JSON.stringify({ events });

describe("ingest: processFile (whole-file sources)", () => {
  it("dedupes by content hash and re-ingests when the content changes", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "session.json");
      const source = fakeWholeFileSource("gemini");

      await fs.writeFile(file, wholeFile([{ sessionId: "s1", message: "one" }]), "utf8");
      await h.processFile({ store, uc, source, filePath: file });
      assert.equal(h.stats.appended, 1);
      assert.equal(h.stats.linesRead, 1);                          // "lines" = events for whole-file sources

      const [hashKey, firstHash] = [...store.offsets][0];
      assert.match(firstHash, /^[0-9a-f]{64}$/);                   // a sha256, not a byte offset

      await h.processFile({ store, uc, source, filePath: file });
      assert.equal(h.stats.appended, 1);                           // unchanged → skipped entirely
      assert.equal(h.stats.linesRead, 1);
      assert.equal(store.offsets.get(hashKey), firstHash);

      await fs.writeFile(file, wholeFile([
        { sessionId: "s1", message: "one" },
        { sessionId: "s1", message: "two" },
      ]), "utf8");
      await h.processFile({ store, uc, source, filePath: file });
      assert.equal(h.stats.linesRead, 3);                          // the whole file is re-read…
      assert.equal(h.stats.appended, 2);                           // …but only the new event is appended
      assert.equal(h.stats.deduped, 1);                            // index 0 hashes to the same event id
      assert.notEqual(store.offsets.get(hashKey), firstHash);
    });
  });

  it("reads readBinary sources as bytes and hashes the buffer", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "opencode.db");
      const seen = [];
      const source = {
        ...fakeWholeFileSource("opencode", { readBinary: true }),
        parseFile: ({ fileContents }) => {
          seen.push(fileContents);
          return [{ sessionId: "s1", kind: "user", eventType: "message", message: "x", timestamp: new Date().toISOString(), raw: {} }];
        },
      };
      await fs.writeFile(file, wholeFile([{ sessionId: "s1", message: "x" }]), "utf8");
      await h.processFile({ store, uc, source, filePath: file });

      assert.ok(Buffer.isBuffer(seen[0]), "readBinary sources must get a Buffer, not a string");
      assert.equal(h.stats.appended, 1);
      assert.match([...store.offsets.values()][0], /^[0-9a-f]{64}$/);
    });
  });

  it("filters per event, so one DB holding many projects keeps the ones in scope", async () => {
    await withTempDir(async (dir) => {
      const allowed = path.join(dir, "allowed");
      const h = harness({ projectPaths: [allowed] });
      const store = fakeStore();
      const uc = fakeUc();
      const file = path.join(dir, "opencode.db");
      await fs.writeFile(file, wholeFile([
        { sessionId: "s1", message: "in scope", cwd: allowed },
        { sessionId: "s2", message: "out of scope", cwd: path.join(dir, "elsewhere") },
        { sessionId: "s3", message: "no cwd at all" },
      ]), "utf8");

      // the file-level path is unknown (a tmpdir path says nothing), which must
      // NOT skip the whole file for a parseFile source
      await h.processFile({ store, uc, source: fakeWholeFileSource("opencode"), filePath: file });

      assert.equal(h.stats.linesRead, 3);
      assert.equal(h.stats.parsedEvents, 1);
      assert.equal(h.stats.appended, 1);
      assert.deepEqual(uc.calls.append.flatMap((call) => call.payload.map((p) => p.content.message)), ["in scope"]);
    });
  });

  it("stores nothing for a file that yields no events, so it is retried next cycle", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const file = path.join(dir, "empty.json");
      await fs.writeFile(file, wholeFile([]), "utf8");

      await h.processFile({ store, uc: fakeUc(), source: fakeWholeFileSource(), filePath: file });
      assert.equal(h.stats.appended, 0);
      assert.equal(store.offsets.size, 0);                         // hash NOT recorded (pre-split behaviour)
    });
  });
});

// ── processSource + primeOffsetsToEof ────────────────────────────────────────

describe("ingest: processSource", () => {
  it("walks every matched file in the source's globs", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const uc = fakeUc();
      await fs.mkdir(path.join(dir, "nested"), { recursive: true });
      for (const name of ["a.jsonl", "nested/b.jsonl", "nested/c.jsonl"]) {
        await fs.writeFile(path.join(dir, name), `${record("s1", name)}\n`, "utf8");
      }
      await fs.writeFile(path.join(dir, "ignored.txt"), "not a transcript", "utf8");

      await h.processSource({ store, uc, source: { ...fakeJsonlSource(), globs: [`${dir}/**/*.jsonl`] } });

      assert.equal(h.stats.filesScanned, 3);
      assert.equal(h.stats.appended, 3);
      assert.equal(store.offsets.size, 3);
    });
  });

  it("counts and logs a glob failure instead of throwing it into the poll loop", async () => {
    const h = harness();
    const store = fakeStore();
    const evil = {
      name: "broken",
      get globs() { throw new Error("glob boom"); },
    };
    await h.processSource({ store, uc: fakeUc(), source: evil });
    assert.equal(h.stats.errors, 1);
    assert.equal(h.state.recentLogs.at(-1).level, "warn");
    assert.match(h.state.recentLogs.at(-1).text, /Failed to list files for source=broken/);
  });

  it("does nothing when a stop was already requested", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      await fs.writeFile(path.join(dir, "a.jsonl"), `${record("s1", "x")}\n`, "utf8");
      await h.processSource({
        store, uc: fakeUc(),
        source: { ...fakeJsonlSource(), globs: [`${dir}/*.jsonl`] },
        shouldStop: () => true,
      });
      assert.equal(h.stats.filesScanned, 0);
      assert.equal(store.offsets.size, 0);
    });
  });
});

describe("ingest: primeOffsetsToEof", () => {
  it("stores sizes for JSONL sources and content hashes for whole-file sources", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      const jsonl = path.join(dir, "a.jsonl");
      const whole = path.join(dir, "b.json");
      await fs.writeFile(jsonl, `${record("s1", "x")}\n${record("s1", "y")}\n`, "utf8");
      await fs.writeFile(whole, wholeFile([{ sessionId: "s1", message: "z" }]), "utf8");

      await h.primeOffsetsToEof(store, { ...fakeJsonlSource(), globs: [`${dir}/*.jsonl`] });
      await h.primeOffsetsToEof(store, { ...fakeWholeFileSource(), globs: [`${dir}/*.json`] });

      const values = [...store.offsets.values()];
      assert.equal(values.length, 2);
      assert.ok(values.includes((await fs.stat(jsonl)).size));     // byte offset for JSONL
      assert.ok(values.some((value) => /^[0-9a-f]{64}$/.test(String(value))));   // hash for whole-file

      // "new only" means a primed file contributes nothing until it grows
      const uc = fakeUc();
      await h.processFile({ store, uc, source: fakeJsonlSource(), filePath: jsonl });
      assert.equal(h.stats.appended, 0);
      assert.equal(h.stats.deduped, 0);
    });
  });

  it("stops early when a shutdown was requested", async () => {
    await withTempDir(async (dir) => {
      const h = harness();
      const store = fakeStore();
      await fs.writeFile(path.join(dir, "a.jsonl"), `${record("s1", "x")}\n`, "utf8");

      await h.primeOffsetsToEof(store, { ...fakeJsonlSource(), globs: [`${dir}/*.jsonl`] }, () => true);
      assert.equal(store.offsets.size, 0);
    });
  });

  it("ignores files it cannot stat", async () => {
    const h = harness();
    const store = fakeStore();
    await h.primeOffsetsToEof(store, { ...fakeJsonlSource(), globs: ["/nope/**/*.jsonl"] });
    assert.equal(store.offsets.size, 0);
  });
});
