// === ui/status.mjs — status.json polling for the TUI ===
// Owns: reading ~/.ultracontext/status.json (the daemon's outbound IPC file)
// and applying each snapshot onto the TUI's ui/stats/cfg/runtime state:
// online detection via updatedAt staleness, stats/sourceStats/log application
// with signature dedupe + ring capping, and the cached log slice used by the
// render snapshot. Extracted verbatim from tui.mjs (ARCH-005); the closure
// state became the createStatusChannel factory's injected dependencies.
//
// Known quirk preserved from the original: STATUS_FILE is computed from
// os.homedir() at import time and deliberately ignores ULTRACONTEXT_CONFIG_FILE
// (pinned by ARCH-003 for the daemon's ipc.mjs; the TUI behaves the same).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runtimeLogsKeep } from "../logger.mjs";

export const STATUS_FILE = path.join(os.homedir(), ".ultracontext", "status.json");

export const OFFLINE_NOTICE = "Daemon offline — status.json stale or missing.";

export async function readStatusJson(statusFile = STATUS_FILE) {
  try {
    const raw = await fs.readFile(statusFile, "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

/**
 * The TUI's status.json channel. `cfg`/`stats`/`ui`/`runtime` are the boot
 * closures' live objects (mutations must stay visible to the snapshot builder),
 * `markDirty` flags the render loop, `statusFile` is injectable for tests.
 */
export function createStatusChannel({ cfg, stats, ui, runtime, markDirty, statusFile = STATUS_FILE }) {

  function applyDaemonStatus(status) {
    if (!status) {
      if (ui.daemonOnline) { ui.daemonOnline = false; markDirty(); }
      return;
    }

    // check liveness — if updatedAt is stale by >5s, daemon is offline
    const updatedAt = new Date(status.updatedAt).getTime();
    const staleMs = Date.now() - updatedAt;
    const wasOnline = ui.daemonOnline;
    ui.daemonOnline = staleMs < 30_000;
    if (wasOnline !== ui.daemonOnline) markDirty();

    if (!ui.daemonOnline) return;

    // apply stats — only mark dirty if display-visible values changed
    // (skip 'cycles' — it increments every daemon loop and would defeat the dirty-flag)
    const ss = status.stats || {};
    let statsChanged = false;
    for (const k of Object.keys(ss)) {
      if (k === "cycles") continue;
      if (stats[k] !== ss[k]) { statsChanged = true; break; }
    }
    Object.assign(stats, ss);
    if (statsChanged) markDirty();

    // apply source stats — reuse array if unchanged
    const sources = status.sources || [];
    if (sources.length !== ui.sourceStats.length || sources.some((s, i) => s.lastAt !== ui.sourceStats[i]?.lastAt)) {
      ui.sourceStats = sources.map(s => ({
        name: s.name,
        filesScanned: s.filesScanned || 0,
        linesRead: s.linesRead || 0,
        parsedEvents: s.parsedEvents || 0,
        appended: s.appended || 0,
        deduped: s.deduped || 0,
        contextsCreated: s.contextsCreated || 0,
        errors: s.errors || 0,
        lastEventType: s.lastEventType || "-",
        lastSessionId: s.lastSessionId || "-",
        lastAt: s.lastAt || 0,
        lastFile: s.lastFile || "-",
      }));
      markDirty();
    }

    // apply logs (deduplicate by signature)
    if (status.recentLogs && Array.isArray(status.recentLogs)) {
      let newLogs = false;
      for (const entry of status.recentLogs) {
        const sig = `${entry.ts}|${entry.level}|${entry.source}|${entry.text}`;
        if (!runtime.seenLogSignatures.has(sig)) {
          runtime.seenLogSignatures.add(sig);
          ui.recentLogs.push(entry);
          newLogs = true;
        }
      }

      // cap logs + prune dedup set to prevent unbounded growth
      while (ui.recentLogs.length > cfg.uiRecentLimit) ui.recentLogs.shift();
      if (runtime.seenLogSignatures.size > cfg.uiRecentLimit * 2) {
        const keep = new Set();
        for (const entry of ui.recentLogs) {
          keep.add(`${entry.ts}|${entry.level}|${entry.source}|${entry.text}`);
        }
        runtime.seenLogSignatures = keep;
      }
      if (newLogs) markDirty();
    }

    // apply config from daemon
    if (status.config) {
      if (status.config.bootstrapMode) cfg.bootstrapMode = status.config.bootstrapMode;
      if (status.config.claudeIncludeSubagents !== undefined) cfg.claudeIncludeSubagents = Boolean(status.config.claudeIncludeSubagents);
    }

    // update online clients count (just show 1 if daemon is running)
    ui.onlineClients = ui.daemonOnline ? 1 : 0;
  }

  async function pollDaemonStatus() {
    const status = await readStatusJson(statusFile);
    applyDaemonStatus(status);
  }

  // reuse slice when log array hasn't changed (avoids allocation per snapshot)
  function recentLogsCached() {
    const len = ui.recentLogs.length;
    if (len === runtime.cachedLogLen && runtime.cachedLogSlice.length > 0) {
      return runtime.cachedLogSlice;
    }
    runtime.cachedLogLen = len;
    runtime.cachedLogSlice = ui.recentLogs.slice(-runtimeLogsKeep(cfg));
    return runtime.cachedLogSlice;
  }

  return { applyDaemonStatus, pollDaemonStatus, recentLogsCached };
}
