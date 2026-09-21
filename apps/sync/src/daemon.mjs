// daemon core — receives store factory as param so callers control env/sqlite
//
// ARCH-003: this file used to hold the logging pipeline, the counters, the
// config/prefs handling, the file-based IPC channel, harness discovery and the
// whole ingest path in one 1,300-line closure. Those moved out; what remains is
// the daemon's ORCHESTRATION — build the config, wire the modules together,
// resolve bootstrap, run the poll loop, shut down cleanly.
//
//   ./logger.mjs   log(level, message, data), the recent-log ring, stdio guards
//   ./stats.mjs    process + per-source counters, uptime, the STATUS line
//   ./config.mjs   env → cfg, the config-prefs block, bootstrap vocabulary
//   ./ipc.mjs      status.json / config.json / _bootstrapState (file channel)
//   ./sources.mjs  which harnesses to watch, project-path discovery (+ LRU)
//   ./ingest.mjs   offsets, dedupe, context resolution, bulk append, per-cycle
//                  file/source processing
//
// Wiring rule: every module is a factory that receives the pieces it needs
// (cfg, state, runtime, log, the stat bumpers). Nothing here reaches into a
// module's internals, and no module imports another one except sources →
// ingest (through the injected `sourceFiles` object), so the dependency graph
// stays a star with daemon.mjs in the middle.

import path from "node:path";
import process from "node:process";

import { UltraContext } from "ultracontext";
import { normalizeBootstrapMode } from "./protocol.mjs";

import { stopWatchParentProcess } from "./process-tree.mjs";

import { acquireFileLock, resolveLockPath } from "./lock.mjs";

import {
  bootstrapModeLabel,
  bootstrapStateStoreKey,
  buildRuntimeConfig,
  createConfigPrefs,
  validateConfig,
} from "./config.mjs";
import { createIngest } from "./ingest.mjs";
import { createIpc } from "./ipc.mjs";
import { createLogger } from "./logger.mjs";
import {
  buildSources as buildSourcesFromEnv,
  createProjectPathResolver,
  extractProjectPathFromNormalized,
  listSourceFiles,
} from "./sources.mjs";
import { createStats } from "./stats.mjs";

const cliArgs = new Set(process.argv.slice(2));

// ── exported boot function ──────────────────────────────────────

export async function daemonBoot({ createStore, resolveDbPath }) {
  const cfg = buildRuntimeConfig({ env: process.env, cliArgs, resolveDbPath, resolveLockPath });

  const state = {
    recentLogs: [],
    sourceStats: new Map(),
    sourceOrder: [],
  };

  const runtime = {
    uc: null,
    stop: null,
    store: null,
    sources: null,
    ingestMode: "all",
    daemonRunning: false,
    lockHandle: null,
    projectPathCache: new Map(),
  };

  const {
    stats, bumpStat, bumpSourceStat, noteSourceActivity, ensureSourceStats, emitStatusLine,
  } = createStats({ state });

  const { log, errorDetails, printVerboseBanner, installStdioGuards } = createLogger({ cfg, state, runtime });

  // ── stdio guards ──
  // A daemon whose terminal went away (laptop lid, closed pane, `node --watch`
  // restart) must stop cleanly instead of throwing on every write.
  installStdioGuards();

  // ── file-based IPC: status.json (out) + config.json (in / commands) ──
  const {
    readConfigJson, writeConfigJson, writeStatusJson,
    getBootstrapState, setBootstrapState, deleteBootstrapState,
  } = createIpc();

  // ── config persistence (file-only) ──
  const {
    serialize: serializeConfigPrefs,
    apply: applyConfigPrefs,
    persistToFile: persistConfigPrefsToFile,
    loadFromFile: loadConfigPrefsFromFile,
  } = createConfigPrefs({ cfg, log, errorDetails });

  // ── sources ──

  const { resolveSourceFileProjectPath } = createProjectPathResolver({ cache: runtime.projectPathCache });

  /** Bound to this daemon's cfg + env so the call sites stay `buildSources()`. */
  const buildSources = () => buildSourcesFromEnv({ cfg, env: process.env });

  function applyRuntimeSources(sources) {
    runtime.sources = sources;
    state.sourceOrder = sources.map((s) => s.name);
    for (const name of state.sourceOrder) ensureSourceStats(name);
  }

  // ── event ingestion ──

  const { primeOffsetsToEof, processSource } = createIngest({
    cfg,
    stats: { bumpStat, bumpSourceStat, noteSourceActivity },
    log,
    errorDetails,
    sourceFiles: { listSourceFiles, resolveSourceFileProjectPath, extractProjectPathFromNormalized },
  });

  // ── config.json reading each cycle ──

  async function refreshConfigFromFile() {
    const data = await readConfigJson();
    if (!data || typeof data !== "object") return;

    // apply setting changes
    const before = serializeConfigPrefs();
    applyConfigPrefs(data);
    const after = serializeConfigPrefs();

    // rebuild sources if subagent toggle changed
    if (
      before.claudeIncludeSubagents !== after.claudeIncludeSubagents ||
      JSON.stringify(before.captureAgents) !== JSON.stringify(after.captureAgents)
    ) {
      applyRuntimeSources(buildSources());
    }

    if (JSON.stringify(before) !== JSON.stringify(after)) {
      log("info", "Reloaded config from config.json", {
        claude_subagents: after.claudeIncludeSubagents ? "on" : "off",
        bootstrap_mode: after.bootstrapMode,
        capture_agents: after.captureAgents.join(","),
        project_paths: after.projectPaths.length,
      });
    }

    // handle bootstrapReset command flag
    if (data.bootstrapReset) {
      cfg.bootstrapReset = true;
      await resetBootstrapState();
      log("info", "Bootstrap reset triggered via config.json");

      // clear the flag by writing config.json back
      const cleaned = { ...data };
      delete cleaned.bootstrapReset;
      await writeConfigJson(cleaned);
    }
  }

  // ── bootstrap ──

  function resolveBootstrapPlan({ sources }) {
    const key = bootstrapStateStoreKey({ cfg, sources });
    if (cfg.bootstrapReset) {
      deleteBootstrapState(key);
      log("info", "Bootstrap state reset by configuration", { key });
    }
    const forcedMode = normalizeBootstrapMode(cfg.bootstrapMode);
    if (forcedMode) return { mode: forcedMode, needsBootstrap: true, forced: true };
    const stored = normalizeBootstrapMode(getBootstrapState(key));
    if (stored) return { mode: stored, needsBootstrap: false, forced: false };
    return { mode: "new_only", needsBootstrap: true, forced: false };
  }

  async function applyBootstrapMode({ store, sources, mode, needsBootstrap, shouldStop = () => false }) {
    const selected = normalizeBootstrapMode(mode) || "new_only";
    if (!needsBootstrap) return "all";
    if (selected === "new_only") {
      for (const source of sources) {
        if (shouldStop()) break;
        await primeOffsetsToEof(store, source, shouldStop);
      }
    }
    if (shouldStop()) return "all";
    setBootstrapState(bootstrapStateStoreKey({ cfg, sources }), selected);
    if (selected === "last_24h") return "last_24h";
    return "all";
  }

  // ── runtime commands ──

  async function resetBootstrapState() {
    const sources = runtime.sources ?? buildSources();
    deleteBootstrapState(bootstrapStateStoreKey({ cfg, sources }));
  }

  // ── cleanup ──

  async function stopRuntimeResources() {
    runtime.daemonRunning = false;
    if (runtime.lockHandle) { try { await runtime.lockHandle.release(); } catch (e) { log("warn", "Failed to release daemon lock", errorDetails(e)); } runtime.lockHandle = null; }
    if (runtime.store) { try { runtime.store.close(); } catch (e) { log("warn", "Failed to close local store", errorDetails(e)); } runtime.store = null; }
    runtime.uc = null;
    runtime.stop = null;
    runtime.sources = null;
    runtime.ingestMode = "all";
  }

  // ── main loop ──

  async function daemonMain() {
    const gate = validateConfig(cfg);
    if (gate.warn) log("warn", gate.warn.message, gate.warn.data);
    printVerboseBanner();

    const store = createStore({ dbPath: cfg.dbFile });
    runtime.store = store;

    // load persisted config from file
    try {
      const fileLoad = await loadConfigPrefsFromFile();
      if (fileLoad.loaded) {
        log("info", "Loaded persisted config preferences", {
          file_source: fileLoad.source, file_path: fileLoad.file,
        });
      } else {
        await persistConfigPrefsToFile();
        log("info", "Created default runtime config file", { file: path.resolve(cfg.configFile) });
      }
    } catch (error) {
      log("warn", "Failed to load persisted config preferences", errorDetails(error));
    }

    // sources + lock
    const sources = buildSources();
    if (sources.length === 0) throw new Error("No sources enabled. Set INGEST_CODEX=true, INGEST_CLAUDE=true, and/or INGEST_GSTACK=true");
    applyRuntimeSources(sources);

    runtime.lockHandle = await acquireFileLock({ lockPath: cfg.lockFile, userId: cfg.userId, host: cfg.host });

    const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
    runtime.uc = uc;

    // connectivity check
    try { await uc.get({ limit: 1 }); } catch (error) {
      const details = errorDetails(error);
      const isLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(cfg.baseUrl);
      throw new Error(
        isLocal
          ? `Local UltraContext server unreachable (url=${cfg.baseUrl}). Is \`ultracontext serve\` running? Start it in another terminal, then retry.`
          : `UltraContext auth/connectivity check failed (status=${details.status ?? "?"}, url=${details.url ?? cfg.baseUrl}, body=${details.bodyText ?? details.message}). Check your API key at https://ultracontext.ai`
      );
    }

    log("info", "UltraContext daemon started", {
      user_id: cfg.userId, host: cfg.host, poll_ms: cfg.pollMs, mode: "headless",
      db_file: cfg.dbFile,
      sources: sources.map((s) => ({ name: s.name, globs: s.globs })),
    });

    runtime.daemonRunning = true;

    // main poll loop
    let running = true;
    let stopRequested = false;
    const stop = (reason = "internal") => {
      if (stopRequested) return;
      stopRequested = true;
      if (reason === "user" || reason === "sigint") stopWatchParentProcess();
      running = false;
    };
    runtime.stop = stop;

    process.on("SIGINT", () => stop("sigint"));
    process.on("SIGTERM", () => stop("sigterm"));

    // bootstrap
    runtime.ingestMode = "all";
    if (running) {
      const bootstrapPlan = resolveBootstrapPlan({ store, sources });
      if (running) {
        runtime.ingestMode = await applyBootstrapMode({
          store, sources, mode: bootstrapPlan.mode,
          needsBootstrap: bootstrapPlan.needsBootstrap, shouldStop: () => !running,
        });
        log("info", "Bootstrap mode resolved", {
          mode: bootstrapPlan.mode, mode_label: bootstrapModeLabel(bootstrapPlan.mode),
          applied: bootstrapPlan.needsBootstrap ? "yes" : "no", ingest_mode: runtime.ingestMode,
        });
      }
    }

    while (running) {
      // check config.json for setting changes + commands
      try { await refreshConfigFromFile(); } catch (error) {
        log("warn", "Failed to refresh config from config.json", errorDetails(error));
      }

      bumpStat("cycles");
      const cycleStart = Date.now();

      // process all sources in parallel
      const activeSources = (runtime.sources ?? []);
      await Promise.all(activeSources.map((source) =>
        processSource({ store, uc, source, shouldStop: () => !running, ingestMode: runtime.ingestMode ?? "all" }),
      ));

      if (stats.cycles % cfg.cleanupEveryCycles === 0) { try { store.cleanupExpired(); } catch { /* ignore */ } }

      // write status.json atomically after each cycle
      try { await writeStatusJson(cfg, stats, state, runtime); } catch { /* ignore */ }

      if (!running) break;
      const waitMs = Math.max(cfg.pollMs - (Date.now() - cycleStart), 10);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    runtime.daemonRunning = false;

    // final status write
    try { await writeStatusJson(cfg, stats, state, runtime); } catch { /* ignore */ }

    emitStatusLine();
    await stopRuntimeResources();
    log("info", "UltraContext daemon stopped");
  }

  // ── run ──

  daemonMain().catch(async (error) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isAlreadyRunning = error?.code === "ELOCKED" || errorMessage.startsWith("UltraContext daemon already running");
    await stopRuntimeResources();

    if (isAlreadyRunning) {
      log("warn", "UltraContext already running", { error: errorMessage });
      stopWatchParentProcess();
    } else {
      bumpStat("errors");
      log("error", "UltraContext failed", { error: errorMessage });
    }
    process.exit(isAlreadyRunning ? 2 : 1);
  });
}
