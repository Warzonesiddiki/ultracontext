// =============================================================================
// ARCH-003 — logger.mjs: the daemon's log pipeline, extracted from daemon.mjs.
// The daemon had ZERO test coverage before this split, so these tests pin the
// behaviour the extraction had to preserve: level filtering, the bounded
// recent-log ring (what the TUI and status.json render), message normalisation
// and the one-line `k=v` suffix.
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LOG_LEVELS,
  colorize,
  compactValue,
  createLogger,
  errorDetails,
  formatDataInline,
  formatTime,
  levelColor,
  logSourceFromData,
  recentLogLabel,
} from "../src/logger.mjs";

/** Minimal stand-ins for the daemon's cfg/state/runtime. */
function harness({ logLevel = "info", verboseLogs = false, uiRecentLimit = 240 } = {}) {
  const cfg = { logLevel, verboseLogs, uiRecentLimit };
  const state = { recentLogs: [] };
  const runtime = { stopCalls: [], stop(reason) { runtime.stopCalls.push(reason); } };
  const lines = [];
  const logger = createLogger({ cfg, state, runtime, out: (line) => lines.push(line) });
  return { cfg, state, runtime, lines, ...logger };
}

describe("logger: level filtering", () => {
  it("drops everything below the configured level", () => {
    const h = harness({ logLevel: "warn" });
    h.log("debug", "too quiet");
    h.log("info", "still too quiet");
    h.log("warn", "loud enough");
    h.log("error", "loudest");

    assert.deepEqual(h.state.recentLogs.map((row) => row.level), ["warn", "error"]);
    assert.equal(h.lines.length, 2);
  });

  it("treats an unknown level as info on BOTH sides, so a typo cannot silence errors", () => {
    const h = harness({ logLevel: "loud" });          // unknown configured level → info
    h.log("error", "must still land");
    assert.equal(h.state.recentLogs.length, 1);

    const h2 = harness({ logLevel: "info" });
    h2.log("shout", "unknown level → info, so it passes an info filter");
    assert.equal(h2.state.recentLogs.length, 1);
    assert.match(h2.lines[0], /SHOUT/);
  });

  it("ranks error < warn < info < debug", () => {
    assert.ok(LOG_LEVELS.error < LOG_LEVELS.warn);
    assert.ok(LOG_LEVELS.warn < LOG_LEVELS.info);
    assert.ok(LOG_LEVELS.info < LOG_LEVELS.debug);
  });
});

describe("logger: console rendering", () => {
  it("prints one `HH:MM:SS LEVEL message k=v` line in normal mode", () => {
    const h = harness();
    h.log("info", "UltraContext daemon started", { user_id: "u1", poll_ms: 1500 });

    assert.equal(h.lines.length, 1);
    assert.match(h.lines[0], /^\d{2}:\d{2}:\d{2} INFO  UltraContext daemon started user_id=u1 poll_ms=1500$/);
  });

  it("pads the level to five characters so columns line up", () => {
    const h = harness({ logLevel: "debug" });
    h.log("warn", "x");
    h.log("error", "y");
    assert.match(h.lines[0], /^\d{2}:\d{2}:\d{2} WARN  x$/);
    assert.match(h.lines[1], /^\d{2}:\d{2}:\d{2} ERROR y$/);
  });

  it("prints a multi-line coloured dump in verbose mode, and returns early", () => {
    const h = harness({ verboseLogs: true });
    h.log("info", "Context created", { context_id: "ctx_1" });

    // one header line + one `  |` line per line of pretty-printed JSON
    assert.equal(h.lines.length, 4);
    assert.match(h.lines[0], /\[INFO\] Context created$/);
    // each JSON line is prefixed with the gutter `  | ` (two-space indent + the
    // pipe + the separator space, so nested keys land at 3+ spaces)
    assert.equal(h.lines[1], "  | {");
    assert.equal(h.lines[2], '  |   "context_id": "ctx_1"');
    assert.equal(h.lines[3], "  | }");
  });

  it("omits the data block entirely when verbose data is empty", () => {
    const h = harness({ verboseLogs: true });
    h.log("info", "no data", {});
    assert.equal(h.lines.length, 1);
  });

  it("prints the verbose banner only in verbose mode", () => {
    const quiet = harness();
    quiet.printVerboseBanner();
    assert.deepEqual(quiet.lines, []);

    const loud = harness({ verboseLogs: true });
    loud.printVerboseBanner();
    assert.equal(loud.lines.length, 3);
    assert.match(loud.lines[1], /UltraContext Daemon \(Verbose\)/);
  });
});

describe("logger: the recent-log ring", () => {
  it("trims to max(uiRecentLimit, 180) — a screenful even if the limit is tiny", () => {
    const h = harness({ uiRecentLimit: 2 });
    for (let i = 0; i < 250; i += 1) h.log("info", `event ${i}`);
    assert.equal(h.state.recentLogs.length, 180);
    assert.equal(h.state.recentLogs.at(-1).text, "event 249");
    assert.equal(h.state.recentLogs[0].text, "event 70");
  });

  it("keeps a larger configured limit", () => {
    const h = harness({ uiRecentLimit: 300 });
    for (let i = 0; i < 400; i += 1) h.log("info", `event ${i}`);
    assert.equal(h.state.recentLogs.length, 300);
  });

  it("stores ts/level/source/text per row", () => {
    const h = harness();
    h.log("warn", "Failed to process file", { source: "Claude" });
    const [row] = h.state.recentLogs;
    assert.match(row.ts, /^\d{2}:\d{2}:\d{2}$/);
    assert.equal(row.level, "warn");
    assert.equal(row.source, "claude");                 // lower-cased for grouping
    assert.equal(row.text, "File processing warning");
  });

  it("appends details inline for ERRORS only — the ring has no expandable row", () => {
    const h = harness();
    h.log("error", "UltraContext failed", { error: "boom", status: 500 });
    h.log("warn", "something", { status: 500 });

    assert.match(h.state.recentLogs[0].text, /^UltraContext failed error=boom status=500$/);
    assert.equal(h.state.recentLogs[1].text, "something");
  });

  it("flattens newlines and control characters so one event stays one line", () => {
    const h = harness();
    h.log("info", "line one\r\nline   two\x1b[0m");
    const { text } = h.state.recentLogs[0];
    assert.ok(!/[\r\n\x00-\x1f]/.test(text), `still has control chars: ${JSON.stringify(text)}`);
    // a \r\n run becomes ONE space and runs of whitespace collapse; the ESC is
    // stripped but the printable tail of the sequence survives (it is not ANSI-
    // parsed here, only de-controlled) — that is the pre-split behaviour.
    assert.equal(text, "line one line two [0m");
  });

  it("collapses chatty messages to short labels", () => {
    assert.equal(recentLogLabel("Appended event to session context x=1"), "context append");
    assert.equal(recentLogLabel("Context created"), "Context created");
    assert.equal(recentLogLabel("UltraContext daemon started"), "Daemon started");
    assert.equal(recentLogLabel("UltraContext daemon stopped"), "Daemon stopped");
    assert.equal(recentLogLabel("Failed to process file for source=codex"), "File processing warning");
    assert.equal(recentLogLabel("Failed to create context with metadata"), "Context create warning");
    assert.equal(recentLogLabel("something else entirely"), "something else entirely");
  });

  it("documents the label-order trap: the fallback label is unreachable, as it was before the split", () => {
    // "Context created" matches first and rewrites the line, so the
    // "Context created (fallback)" rule never sees the original message.
    // Preserved on purpose — see RECENT_LOG_LABELS in logger.mjs.
    assert.equal(recentLogLabel("Context created without metadata fallback"), "Context created");
  });
});

describe("logger: formatting helpers", () => {
  it("formatTime renders HH:MM:SS from an ISO timestamp", () => {
    assert.equal(formatTime(Date.parse("2026-09-20T07:08:09Z")), "07:08:09");
  });

  it("compactValue keeps short values whole and elides long ones head...tail", () => {
    assert.equal(compactValue("short"), "short");
    assert.equal(compactValue("x".repeat(32)), "x".repeat(32));
    const compacted = compactValue(`${"a".repeat(20)}${"b".repeat(20)}`);
    assert.equal(compacted, `${"a".repeat(14)}...${"b".repeat(12)}`);
    assert.equal(compactValue(null), "");
  });

  it("formatDataInline takes at most 8 pairs and nothing from non-objects", () => {
    const data = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i]));
    const rendered = formatDataInline(data);
    assert.equal(rendered.split(" ").length, 8);
    assert.match(rendered, /^k0=0 k1=1/);
    assert.equal(formatDataInline(null), "");
    assert.equal(formatDataInline("nope"), "");
    assert.equal(formatDataInline({}), "");
  });

  it("logSourceFromData checks the shapes sources actually produce", () => {
    assert.equal(logSourceFromData({ source: "Codex" }), "codex");
    assert.equal(logSourceFromData({ context_source: "claude" }), "claude");
    assert.equal(logSourceFromData({ contextSource: "cursor" }), "cursor");
    assert.equal(logSourceFromData({ metadata: { source: "gemini" } }), "gemini");
    assert.equal(logSourceFromData({ other: 1 }), "");
    assert.equal(logSourceFromData(null), "");
  });

  it("errorDetails exposes message/status/url/bodyText and nothing else", () => {
    const details = errorDetails({
      message: "nope", status: 401, url: "https://api", bodyText: "bad key",
      requestBody: { apiKey: "secret" },
    });
    assert.deepEqual(details, { message: "nope", status: 401, url: "https://api", bodyText: "bad key" });
    assert.equal(errorDetails("plain string").message, "plain string");
  });

  it("colour is off without a TTY, so logs stay greppable", () => {
    // node --test is not a TTY: colorize must be a pass-through and levelColor
    // still resolves (it is used to build the string that colorize ignores).
    assert.equal(colorize("hello", levelColor("error")), "hello");
    assert.notEqual(levelColor("error"), levelColor("warn"));
    assert.notEqual(levelColor("debug"), levelColor("info"));
  });
});

describe("logger: stdio guards", () => {
  it("classifies only EIO/EPIPE/ENXIO as benign", () => {
    const h = harness();
    for (const code of ["EIO", "EPIPE", "ENXIO"]) {
      assert.equal(h.isBenignStdioError({ code }), true, code);
    }
    assert.equal(h.isBenignStdioError({ code: "EACCES" }), false);
    assert.equal(h.isBenignStdioError(null), false);
  });

  it("stops the daemon once when its terminal disappears, and ignores other errors", () => {
    const h = harness();
    h.handleStdioError({ code: "EACCES", message: "nope" }, "stdout");
    assert.deepEqual(h.runtime.stopCalls, []);

    h.handleStdioError({ code: "EPIPE", message: "gone" }, "stdout");
    h.handleStdioError({ code: "EIO", message: "gone too" }, "stdin");
    assert.deepEqual(h.runtime.stopCalls, ["stdio"]);      // exactly one stop
  });

  it("survives a runtime with no stop handler yet (guards install before the loop)", () => {
    const h = harness();
    const bare = createLogger({
      cfg: h.cfg,
      state: h.state,
      runtime: {},
      out: () => {},
    });
    assert.doesNotThrow(() => bare.handleStdioError({ code: "EIO" }, "stderr"));
  });
});
