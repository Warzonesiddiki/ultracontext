// =============================================================================
// IPC — the daemon's file-based control channel (extracted from daemon.mjs, ARCH-003)
// =============================================================================
//
// The daemon has no socket: `ultracontext status` / `ultracontext stop` / the
// TUI and the onboarding wizard all talk to it through two JSON files under
// ~/.ultracontext, and that is deliberate — a self-hosted, local-first daemon
// should be controllable with `cat` and a text editor, with nothing to bind and
// nothing to authenticate.
//
//   status.json  daemon → everyone. Rewritten atomically (tmp + rename) after
//                every poll cycle, 0600 because it names the user/host and the
//                files being watched.
//   config.json  everyone → daemon. Read every cycle, so editing it is the
//                "runtime command" channel: changing a pref takes effect on the
//                next cycle, and `bootstrapReset: true` is a one-shot command
//                that the daemon consumes and deletes (see daemon.mjs).
//   _bootstrapState inside config.json is the daemon's own persisted bootstrap
//                decision; it rides along in the same file so there is exactly
//                one place a restart can look.
//
// Paths are injectable (`createIpc({ statusFile, configFile })`) so tests can
// point the channel at a tmpdir instead of the developer's real ~/.ultracontext.
//
// Every writer is best-effort by contract: a full disk or a vanished home
// directory must never take down ingestion, so failures are swallowed here or
// by the caller (never thrown into the poll loop).

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** Default channel endpoints — the ones `ultracontext status`/`stop` read. */
export const STATUS_FILE = path.join(os.homedir(), ".ultracontext", "status.json");
export const CONFIG_FILE = path.join(os.homedir(), ".ultracontext", "config.json");

/**
 * The status payload. Pure so it can be asserted on without touching the disk;
 * `writeStatusJson` is this plus an atomic write.
 *
 * `recentLogs` is capped at the last 240 rows regardless of the ring's own
 * limit: status.json is read by external tools that should not have to page.
 */
export function buildStatusSnapshot(cfg, stats, state, runtime) {
  return {
    pid: process.pid,
    startedAt: new Date(stats.startedAt).toISOString(),
    updatedAt: new Date().toISOString(),
    host: cfg.host,
    userId: cfg.userId,
    mode: runtime.ingestMode,
    running: runtime.daemonRunning,
    stats: { ...stats },
    sources: state.sourceOrder.map(name => {
      const s = state.sourceStats.get(name) || {};
      return { name, ...s };
    }),
    recentLogs: state.recentLogs.slice(-240),
    config: {
      bootstrapMode: cfg.bootstrapMode,
      claudeIncludeSubagents: cfg.claudeIncludeSubagents,
      captureAgents: cfg.captureAgents,
      projectPaths: cfg.projectPaths,
    },
  };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.statusFile]  where the status snapshot is published
 * @param {string} [opts.configFile]  where runtime prefs + commands are exchanged
 */
export function createIpc({ statusFile = STATUS_FILE, configFile = CONFIG_FILE } = {}) {
  async function writeStatusJson(cfg, stats, state, runtime) {
    const snapshot = buildStatusSnapshot(cfg, stats, state, runtime);
    // SEC-004: status file is 0600 (rename carries the mode).
    // encoding + mode must be ONE options object: node 22.22.3 silently
    // drops `mode` in the 4-arg (file, data, encoding, options) form.
    const tmp = statusFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, statusFile);
  }

  /** `null` means "no usable config" — missing, unreadable or not JSON. */
  async function readConfigJson() {
    try {
      const raw = await fs.readFile(configFile, "utf8");
      return JSON.parse(raw);
    } catch { return null; }
  }

  async function writeConfigJson(data) {
    const tmp = configFile + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await fs.rename(tmp, configFile);
  }

  // ── bootstrap state (persisted in config.json under _bootstrapState) ──
  // Synchronous on purpose: this is read while resolving the bootstrap plan,
  // before the poll loop exists, and it must not be able to interleave with a
  // concurrent async rewrite of the same file.

  function getBootstrapState(key) {
    try {
      const raw = fsSync.readFileSync(configFile, "utf8");
      const data = JSON.parse(raw);
      return data?._bootstrapState?.[key] ?? "";
    } catch { return ""; }
  }

  /**
   * Rewrite config.json preserving every other key it already holds.
   * `createIfMissing` keeps set/delete asymmetric the way the original inline
   * pair was: setting creates `_bootstrapState`, deleting never invents it (so
   * a config that never bootstrapped is not given an empty block).
   */
  function writeBootstrapStateKey(mutate, createIfMissing) {
    try {
      let data = {};
      try { data = JSON.parse(fsSync.readFileSync(configFile, "utf8")); } catch { /* empty */ }
      if (createIfMissing && !data._bootstrapState) data._bootstrapState = {};
      if (data._bootstrapState) mutate(data._bootstrapState);
      const tmp = configFile + ".tmp.bs";
      fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      fsSync.renameSync(tmp, configFile);
    } catch { /* best effort */ }
  }

  function setBootstrapState(key, value) {
    writeBootstrapStateKey((bootstrapState) => { bootstrapState[key] = String(value); }, true);
  }

  function deleteBootstrapState(key) {
    writeBootstrapStateKey((bootstrapState) => { delete bootstrapState[key]; }, false);
  }

  return {
    statusFile,
    configFile,
    buildStatusSnapshot: (cfg, stats, state, runtime) => buildStatusSnapshot(cfg, stats, state, runtime),
    writeStatusJson,
    readConfigJson,
    writeConfigJson,
    getBootstrapState,
    setBootstrapState,
    deleteBootstrapState,
  };
}
