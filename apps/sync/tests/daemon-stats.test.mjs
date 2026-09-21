// =============================================================================
// ARCH-003 — stats.mjs: the daemon's counters, extracted from daemon.mjs.
// These are the numbers `ultracontext status`, the TUI header and the shutdown
// STATUS line all read, so the field names, the per-source row shape and the
// uptime format are a contract, not an implementation detail.
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSourceStats, createStats, createStatsSnapshot, humanUptime } from "../src/stats.mjs";

function harness(opts = {}) {
  const state = { recentLogs: [], sourceStats: new Map(), sourceOrder: [] };
  const lines = [];
  const statsApi = createStats({ state, out: (line) => lines.push(line), ...opts });
  return { state, lines, ...statsApi };
}

describe("stats: the process-wide snapshot", () => {
  it("starts every counter at zero with a startedAt timestamp", () => {
    const stats = createStatsSnapshot(1_700_000_000_000);
    assert.deepEqual(stats, {
      startedAt: 1_700_000_000_000,
      cycles: 0,
      filesScanned: 0,
      linesRead: 0,
      parsedEvents: 0,
      appended: 0,
      deduped: 0,
      contextsCreated: 0,
      errors: 0,
    });
  });

  it("stamps startedAt from the clock by default", () => {
    const before = Date.now();
    const { stats } = harness();
    assert.ok(stats.startedAt >= before && stats.startedAt <= Date.now());
  });

  it("bumpStat increments by one, or by an explicit delta", () => {
    const h = harness();
    h.bumpStat("cycles");
    h.bumpStat("appended", 41);
    assert.equal(h.stats.cycles, 1);
    assert.equal(h.stats.appended, 41);
  });

  it("bumpStat accepts a counter nobody declared (metrics should be cheap to add)", () => {
    const h = harness();
    h.bumpStat("brandNewMetric", 3);
    assert.equal(h.stats.brandNewMetric, 3);
  });
});

describe("stats: per-source counters", () => {
  it("creates a row on first touch, with '-' placeholders for the breadcrumbs", () => {
    assert.deepEqual(createSourceStats(), {
      filesScanned: 0, linesRead: 0, parsedEvents: 0,
      appended: 0, deduped: 0, contextsCreated: 0, errors: 0,
      lastEventType: "-", lastSessionId: "-", lastAt: 0, lastFile: "-",
    });

    const h = harness();
    const row = h.ensureSourceStats("codex");
    assert.equal(h.state.sourceStats.get("codex"), row);
    assert.equal(h.ensureSourceStats("codex"), row);       // idempotent
  });

  it("bumps one source without touching another", () => {
    const h = harness();
    h.bumpSourceStat("claude", "filesScanned");
    h.bumpSourceStat("claude", "appended", 7);
    h.bumpSourceStat("codex", "errors");

    assert.equal(h.state.sourceStats.get("claude").appended, 7);
    assert.equal(h.state.sourceStats.get("claude").filesScanned, 1);
    assert.equal(h.state.sourceStats.get("codex").errors, 1);
    assert.equal(h.state.sourceStats.get("codex").appended, 0);
  });

  it("records the last-event breadcrumbs the TUI shows per harness", () => {
    const h = harness();
    h.noteSourceActivity("gemini", { lastEventType: "message", lastSessionId: "s1", lastAt: 123 });
    h.noteSourceActivity("gemini", { lastFile: "/tmp/a.json" });
    h.noteSourceActivity("gstack");                        // no patch → no-op

    const row = h.state.sourceStats.get("gemini");
    assert.deepEqual(
      { lastEventType: row.lastEventType, lastSessionId: row.lastSessionId, lastAt: row.lastAt, lastFile: row.lastFile },
      { lastEventType: "message", lastSessionId: "s1", lastAt: 123, lastFile: "/tmp/a.json" },
    );
    assert.equal(h.state.sourceStats.get("gstack").lastEventType, "-");
  });
});

describe("stats: uptime", () => {
  it("renders HH:MM:SS", () => {
    assert.equal(humanUptime(0), "00:00:00");
    assert.equal(humanUptime(9_000), "00:00:09");
    assert.equal(humanUptime(61_000), "00:01:01");
    assert.equal(humanUptime(3_661_000), "01:01:01");
    assert.equal(humanUptime(360_000_000), "100:00:00");   // hours are not wrapped to days
  });

  it("clamps a negative delta (bad clock) to zero instead of printing '-'", () => {
    assert.equal(humanUptime(-5_000), "00:00:00");
  });
});

describe("stats: the shutdown STATUS line", () => {
  it("prints one greppable key=value line", () => {
    const h = harness({ now: Date.now() - 3_661_000 });
    h.bumpStat("cycles", 4);
    h.bumpStat("filesScanned", 12);
    h.bumpStat("linesRead", 900);
    h.bumpStat("parsedEvents", 800);
    h.bumpStat("appended", 750);
    h.bumpStat("deduped", 50);
    h.bumpStat("contextsCreated", 9);
    h.bumpStat("errors", 2);
    h.emitStatusLine();

    assert.equal(h.lines.length, 1);
    const [line] = h.lines;
    assert.match(line, /^STATUS uptime=01:01:0\d /);
    assert.match(line, /cycles=4 files=12 lines=900 parsed=800 append=750 dedupe=50 ctx_new=9 errors=2$/);
  });

  it("goes to the injected sink, not straight to console.log", () => {
    const h = harness();
    h.emitStatusLine();
    assert.equal(h.lines.length, 1);
  });
});
