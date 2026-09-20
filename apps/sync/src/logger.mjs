// =============================================================================
// LOGGER — the daemon's log pipeline (extracted from daemon.mjs, ARCH-003)
// =============================================================================
//
// Two sinks, one call. Every `log(level, message, data)` lands in
//   1. `state.recentLogs` — the bounded ring the TUI and `status.json` read,
//      normalised so a wall of text becomes a scannable line, and
//   2. the console — verbose mode prints a coloured, multi-line dump; normal
//      mode prints one `HH:MM:SS LEVEL message k=v …` line.
//
// Level filtering is by LOG_LEVELS rank, and an unknown level is treated as
// `info` on both sides of the comparison so a typo can neither silence errors
// nor spam debug.
//
// Everything here is created by `createLogger` rather than exported as free
// functions because the pipeline is stateful: it reads `cfg.logLevel` /
// `cfg.verboseLogs` / `cfg.uiRecentLimit` live (config.json can change them
// between cycles), trims `state.recentLogs`, and the stdio guards need
// `runtime.stop` to shut the daemon down when its terminal disappears.
//
// `out` is injectable (defaults to console.log) so tests can assert on the
// exact rendered lines without a TTY, and colour is already off unless
// stdout is a TTY and NO_COLOR is unset.

import process from "node:process";

import { boolFromEnv } from "./utils.mjs";

export const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

export function shouldUseColor() {
  return Boolean(process.stdout?.isTTY) && !boolFromEnv(process.env.NO_COLOR, false);
}

export function levelColor(level) {
  if (level === "error") return ANSI.red;
  if (level === "warn") return ANSI.yellow;
  if (level === "debug") return ANSI.gray;
  return ANSI.cyan;
}

export function colorize(text, color) {
  if (!shouldUseColor()) return String(text ?? "");
  return `${color}${String(text ?? "")}${ANSI.reset}`;
}

/** HH:MM:SS from an ISO stamp — the ring buffer and the console share it. */
export function formatTime(value = Date.now()) {
  return new Date(value).toISOString().slice(11, 19);
}

export function safeText(value) {
  return String(value ?? "");
}

/** Keep long ids readable in one-line logs: head…tail instead of a wall. */
export function compactValue(value) {
  const raw = safeText(value);
  if (raw.length <= 32) return raw;
  return `${raw.slice(0, 14)}...${raw.slice(-12)}`;
}

/** Up to 8 `k=v` pairs, each value compacted — the one-line log suffix. */
export function formatDataInline(data) {
  if (!data || typeof data !== "object") return "";
  const entries = Object.entries(data).slice(0, 8);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${compactValue(v)}`).join(" ");
}

/**
 * Best-effort source name for a log row, so the TUI can group by harness.
 * Callers pass it in different shapes depending on where the event came from
 * (parser output, context metadata, an API error), hence the candidate list.
 */
export function logSourceFromData(data) {
  if (!data || typeof data !== "object") return "";
  for (const value of [data.source, data.context_source, data.contextSource, data?.metadata?.source]) {
    const raw = String(value ?? "").trim();
    if (raw) return raw.toLowerCase();
  }
  return "";
}

/**
 * The fields worth reporting from an SDK/HTTP failure. Deliberately narrow:
 * the raw error object can carry a request body, and logs are shared.
 */
export function errorDetails(error) {
  if (!error || typeof error !== "object") return { message: String(error) };
  const details = { message: error.message ?? String(error) };
  if ("status" in error) details.status = error.status;
  if ("url" in error) details.url = error.url;
  if ("bodyText" in error) details.bodyText = error.bodyText;
  return details;
}

/**
 * Long messages are collapsed to a short label in the recent-log ring: the TUI
 * shows one line per event, and "Appended event to session context" repeated
 * 500 times carries no information. Control characters are flattened first so
 * a transcript fragment can never break the single-line layout.
 *
 * The rules are applied IN SEQUENCE to the evolving line — not first-match-wins
 * — exactly as the original inline `if` chain in daemon.mjs did. That ordering
 * is load-bearing and slightly wrong: "Context created" rewrites the fallback
 * message before the fallback rule ever sees it, so "Context created (fallback)"
 * is unreachable. Preserved deliberately, because this extraction changes
 * structure and not behaviour; the fix is a visible one-line reorder (move the
 * fallback rule above the plain one) and belongs in its own commit.
 */
const RECENT_LOG_LABELS = [
  ["Appended event to session context", "context append"],
  ["Context created", "Context created"],
  ["Context created without metadata fallback", "Context created (fallback)"],
  ["UltraContext daemon started", "Daemon started"],
  ["UltraContext daemon stopped", "Daemon stopped"],
  ["Failed to process file", "File processing warning"],
  ["Failed to create context with metadata", "Context create warning"],
];

export function recentLogLabel(message) {
  let line = String(message ?? "").replace(/[\r\n\t\v\f\x00-\x1f]+/g, " ").replace(/\s{2,}/g, " ");
  for (const [prefix, label] of RECENT_LOG_LABELS) {
    if (line.startsWith(prefix)) line = label;
  }
  return line;
}

/**
 * @param {object} deps
 * @param {object} deps.cfg      live daemon config (logLevel, verboseLogs, uiRecentLimit)
 * @param {object} deps.state    shared mutable state; `recentLogs` is written here
 * @param {object} deps.runtime  runtime handles; `stop` is used by the stdio guards
 * @param {(line: string) => void} [deps.out]  console sink (injectable for tests)
 */
export function createLogger({ cfg, state, runtime, out = (line) => console.log(line) } = {}) {
  let stdioErrorHandled = false;

  /** The ring has to hold at least a screenful even if uiRecentLimit is tiny. */
  function runtimeLogsKeep() {
    return Math.max(cfg.uiRecentLimit, 180);
  }

  function pushRecentLog(level, message, data) {
    let line = recentLogLabel(message);

    // errors get their details inline: the ring has no expandable row, so the
    // status/url/body that explains a failure has to fit on the one line
    const suffix = level === "error" ? formatDataInline(data) : "";
    if (suffix) line = `${line} ${suffix}`;

    state.recentLogs.push({ ts: formatTime(), level, source: logSourceFromData(data), text: line });
    const keep = runtimeLogsKeep();
    while (state.recentLogs.length > keep) state.recentLogs.shift();
  }

  function log(level, message, data) {
    const current = LOG_LEVELS[cfg.logLevel] ?? LOG_LEVELS.info;
    const target = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (target > current) return;

    pushRecentLog(level, message, data);

    if (cfg.verboseLogs) {
      const stamp = colorize(new Date().toISOString(), ANSI.dim);
      const badge = colorize(`[${String(level).toUpperCase()}]`, levelColor(level));
      out(`${stamp} ${badge} ${message}`);
      if (data && typeof data === "object" && Object.keys(data).length > 0) {
        for (const line of JSON.stringify(data, null, 2).split("\n")) {
          out(`${colorize("  |", ANSI.gray)} ${line}`);
        }
      }
      return;
    }

    const now = formatTime();
    const suffix = formatDataInline(data);
    const finalLine = suffix ? `${message} ${suffix}` : message;
    out(`${now} ${String(level).toUpperCase().padEnd(5)} ${finalLine}`);
  }

  function printVerboseBanner() {
    if (!cfg.verboseLogs) return;
    for (const row of [
      "+------------------------------------------+",
      "|        UltraContext Daemon (Verbose)     |",
      "+------------------------------------------+",
    ]) out(colorize(row, ANSI.cyan));
  }

  // ── stdio guards ────────────────────────────────────────────────────────
  // A daemon whose terminal went away (laptop lid, closed pane, `node --watch`
  // restart) gets EIO/EPIPE/ENXIO on stdin/stdout/stderr. Those are not
  // ingest failures: stop cleanly, once, instead of throwing on every write.

  function isBenignStdioError(error) {
    const code = String(error?.code ?? "");
    return code === "EIO" || code === "EPIPE" || code === "ENXIO";
  }

  function handleStdioError(error, streamName) {
    if (!isBenignStdioError(error)) return;
    if (stdioErrorHandled) return;
    stdioErrorHandled = true;
    try { runtime?.stop?.("stdio"); } catch { /* ignore */ }
    if (LOG_LEVELS[cfg.logLevel] >= LOG_LEVELS.debug) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[debug] Ignored stdio ${streamName} error (${error?.code ?? "?"}): ${msg}`);
    }
  }

  function installStdioGuards() {
    process.stdin?.on?.("error", (error) => handleStdioError(error, "stdin"));
    process.stdout?.on?.("error", (error) => handleStdioError(error, "stdout"));
    process.stderr?.on?.("error", (error) => handleStdioError(error, "stderr"));
  }

  return {
    log,
    pushRecentLog,
    runtimeLogsKeep,
    printVerboseBanner,
    installStdioGuards,
    isBenignStdioError,
    handleStdioError,
    errorDetails,
    formatTime,
    colorize,
  };
}
