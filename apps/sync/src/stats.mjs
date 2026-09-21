// =============================================================================
// STATS — the daemon's counters (extracted from daemon.mjs, ARCH-003)
// =============================================================================
//
// Two levels, one source of truth:
//   * `stats`  — process-wide totals (cycles, files, lines, events, appends,
//     dedupes, contexts created, errors). Read by the status line, the TUI and
//     `status.json`.
//   * per-source counters in `state.sourceStats`, a Map keyed by harness name
//     with the same fields plus "last …" breadcrumbs (event type, session,
//     file, timestamp), so the TUI can show which harness is actually moving.
//
// Both live in objects OWNED BY THE CALLER (`stats` is returned; per-source
// rows go into the shared `state`), because the file-based IPC snapshot in
// ipc.mjs serialises them and the TUI reads them between cycles. Nothing here
// is persisted: counters are process-lifetime and start at zero on boot.
//
// Counters are deliberately dumb — `bumpStat(name, delta)` will happily create
// a field that no reader knows about. That is intentional: adding a metric
// should not require touching this module.

/** The process-wide totals, in the order the status line prints them. */
export function createStatsSnapshot(now = Date.now()) {
  return {
    startedAt: now,
    cycles: 0,
    filesScanned: 0,
    linesRead: 0,
    parsedEvents: 0,
    appended: 0,
    deduped: 0,
    contextsCreated: 0,
    errors: 0,
  };
}

/** A fresh per-source row. `last*` fields render as "-" until something happens. */
export function createSourceStats() {
  return {
    filesScanned: 0,
    linesRead: 0,
    parsedEvents: 0,
    appended: 0,
    deduped: 0,
    contextsCreated: 0,
    errors: 0,
    lastEventType: "-",
    lastSessionId: "-",
    lastAt: 0,
    lastFile: "-",
  };
}

/** HH:MM:SS, clamped at zero so a bad clock cannot print a negative uptime. */
export function humanUptime(ms) {
  const totalSec = Math.max(Math.floor(ms / 1000), 0);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * @param {object} deps
 * @param {object} deps.state  shared mutable state; `sourceStats` / `sourceOrder` live here
 * @param {(line: string) => void} [deps.out]  console sink (injectable for tests)
 * @param {number} [deps.now]  boot timestamp, injectable so uptime is testable
 */
export function createStats({ state, out = (line) => console.log(line), now = Date.now() } = {}) {
  const stats = createStatsSnapshot(now);

  function bumpStat(name, delta = 1) {
    stats[name] = (stats[name] ?? 0) + delta;
  }

  function ensureSourceStats(sourceName) {
    if (!state.sourceStats.has(sourceName)) {
      state.sourceStats.set(sourceName, createSourceStats());
    }
    return state.sourceStats.get(sourceName);
  }

  function bumpSourceStat(sourceName, key, delta = 1) {
    const current = ensureSourceStats(sourceName);
    current[key] = (current[key] ?? 0) + delta;
  }

  /** Record the "last …" breadcrumbs for a source (event type, session, file). */
  function noteSourceActivity(sourceName, patch) {
    Object.assign(ensureSourceStats(sourceName), patch ?? {});
  }

  /**
   * One greppable line at shutdown, in the shape the TUI's status row and any
   * log shipper already parse: `STATUS uptime=… cycles=… files=… …`.
   */
  function emitStatusLine() {
    out([
      "STATUS", `uptime=${humanUptime(Date.now() - stats.startedAt)}`,
      `cycles=${stats.cycles}`, `files=${stats.filesScanned}`, `lines=${stats.linesRead}`,
      `parsed=${stats.parsedEvents}`, `append=${stats.appended}`, `dedupe=${stats.deduped}`,
      `ctx_new=${stats.contextsCreated}`, `errors=${stats.errors}`,
    ].join(" "));
  }

  return {
    stats,
    bumpStat,
    ensureSourceStats,
    bumpSourceStat,
    noteSourceActivity,
    humanUptime,
    emitStatusLine,
  };
}
