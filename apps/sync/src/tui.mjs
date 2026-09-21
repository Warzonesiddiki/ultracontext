// tui core — exported as tuiBoot(), no env.mjs import (caller handles that).
// ARCH-005: this file is boot + wiring only — cfg/stats/ui/runtime
// construction, the render snapshot, the update-prompt/tab/detail glue, and
// tuiMain's timers. The feature logic lives in ui/: status polling
// (ui/status.mjs), the update check (ui/update-check.mjs), config.json
// vocabulary + prefs I/O (ui/config-file.mjs), the Configs tab
// (ui/config-editor.mjs), the detail inspector (ui/detail.mjs) and the resume
// feature (ui/resume/{context-helpers,terminal-launch,plans,controller}.mjs).
// The process-tree helpers are shared with the daemon (process-tree.mjs), and
// the config/logger helpers are imported from config.mjs/logger.mjs instead of
// being re-declared here.
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { UltraContext } from "ultracontext";

import {
  DEFAULT_RUNTIME_CONFIG_FILE,
  normalizeApiKey,
  normalizeBootstrapModeWithPrompt,
  resolveRuntimeConfigPath,
} from "./config.mjs";
import { stopWatchParentProcess } from "./process-tree.mjs";
import { MENU_TABS, createInkUiController } from "./ui.mjs";
import { boolFromEnv, expandHome, toInt } from "./utils.mjs";

import { createStatusChannel } from "./ui/status.mjs";
import { UPDATE_PROMPT_OPTIONS, createUpdateChecker, readTuiVersion } from "./ui/update-check.mjs";
import { createTuiConfigPrefs, normalizeResumeSourceFilter, normalizeResumeTerminal } from "./ui/config-file.mjs";
import { createConfigEditor } from "./ui/config-editor.mjs";
import { createDetailController } from "./ui/detail.mjs";
import { createTerminalLauncher } from "./ui/resume/terminal-launch.mjs";
import { createResumeController } from "./ui/resume/controller.mjs";
import { RESUME_TARGET_OPTIONS, isCodingContextSource, resumeContextSource } from "./ui/resume/context-helpers.mjs";

// ── exported boot function ──────────────────────────────────────

export async function tuiBoot({
  assetsRoot,
  onFatalError,
} = {}) {

const APP_ROOT = assetsRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cfg = {
  apiKey: normalizeApiKey(process.env.ULTRACONTEXT_API_KEY),
  baseUrl: (process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").trim(),
  userId: process.env.DAEMON_USER_ID ?? process.env.USER ?? "unknown-user",
  host: (process.env.DAEMON_HOST || os.hostname() || "unknown-host").trim(),
  uiRefreshMs: toInt(process.env.TUI_REFRESH_MS, 1200),
  resumeAutoRefreshMs: Math.max(toInt(process.env.RESUME_AUTO_REFRESH_MS, 3500), 0),
  uiRecentLimit: toInt(process.env.TUI_RECENT_LIMIT, 240),
  configFile: resolveRuntimeConfigPath(),
  bootstrapMode: normalizeBootstrapModeWithPrompt(process.env.DAEMON_BOOTSTRAP_MODE ?? "prompt") || "prompt",
  bootstrapReset: boolFromEnv(process.env.DAEMON_BOOTSTRAP_RESET, false),
  claudeIncludeSubagents: boolFromEnv(process.env.CLAUDE_INCLUDE_SUBAGENTS, false),
  resumeTerminal: normalizeResumeTerminal(process.env.RESUME_TERMINAL),
  resumeContextLimit: toInt(process.env.RESUME_CONTEXT_LIMIT, 1000),
  resumeSourceFilter: normalizeResumeSourceFilter(process.env.RESUME_SOURCE_FILTER),
  resumeSummaryTail: toInt(process.env.RESUME_SUMMARY_TAIL, 14),
  resumeOutputDir: expandHome(process.env.RESUME_OUTPUT_DIR ?? "~/.codex/resume"),
  resumeOpenTab: boolFromEnv(process.env.RESUME_OPEN_TAB, true),
};

const stats = {
  startedAt: Date.now(),
  cycles: 0,
  filesScanned: 0,
  linesRead: 0,
  parsedEvents: 0,
  appended: 0,
  deduped: 0,
  contextsCreated: 0,
  errors: 0,
};

const ui = {
  daemonOnline: false,
  currentVersion: readTuiVersion(APP_ROOT),
  updateAvailable: "",
  updatePrompt: {
    active: false,
    selectedIndex: 0,
    latestVersion: "",
  },
  recentLogs: [],
  onlineClients: 0,
  sourceStats: [],
  selectedTab: "logs",
  configEditor: {
    selectedIndex: 0,
  },
  resume: {
    loading: false,
    syncing: false,
    contexts: [],
    filteredContexts: [],
    sourceFilter: "all",
    selectedIndex: 0,
    loadedAt: 0,
    error: "",
    notice: "",
    summaryPath: "",
    command: "",
    commandPath: "",
  },
  detailView: {
    active: false,
    contextId: null,
    contextMeta: null,
    messages: [],
    scrollOffset: 0,
    lineOffset: 0,
    loading: false,
    error: null,
  },
  resumeTargetPicker: {
    active: false,
    selectedIndex: 0,
    source: "",
    contextId: "",
    options: RESUME_TARGET_OPTIONS,
    recommendedTarget: "",
  },
  bootstrap: {
    active: false,
    selectedIndex: 0,
    options: [],
    sourceNames: [],
    note: "",
  },
};

const runtime = {
  uc: null,
  uiController: null,
  renderTimer: null,
  statusPollTimer: null,
  contextRefreshTimer: null,
  stop: null,
  seenLogSignatures: new Set(),
  seenLogQueue: [],
  syncCount: 0,
  resumeKnownContextIds: new Set(),
  resumeBaselineReady: false,
  dirty: true,
  lastSnapshot: null,
  cachedLogSlice: [],
  cachedLogLen: 0,
  stopResolve: null,
  titleCache: new Map(),
  titleInflight: new Set(),
};

// mark UI dirty so next refresh actually rerenders
function markDirty() { runtime.dirty = true; }

function renderDashboard() {
  markDirty();
  runtime.uiController?.refresh();
}

// ── feature controllers (ARCH-005: the extracted ui/ modules) ──────────

const {
  applyDaemonStatus,
  pollDaemonStatus,
  recentLogsCached,
} = createStatusChannel({ cfg, stats, ui, runtime, markDirty });

const { checkForUpdateSilent } = createUpdateChecker({ appRoot: APP_ROOT, ui, renderDashboard });

const tuiPrefs = createTuiConfigPrefs({ cfg });
const { persistConfigPrefsToFile, loadConfigPrefsFromFile } = tuiPrefs;

const terminalLauncher = createTerminalLauncher({ getResumeTerminal: () => cfg.resumeTerminal });

const {
  loadResumeContexts,
  cycleSourceFilter,
  moveResumeSelection,
  openResumeTargetPicker,
  closeResumeTargetPicker,
  moveResumeTargetPickerSelection,
  resumeTargetPickerSelectionByIndex,
  resumeSelectedContext,
} = createResumeController({ cfg, ui, runtime, renderDashboard, markDirty, terminalLauncher });

const {
  openContextDetail,
  closeContextDetail,
  refreshContextDetail,
  scrollContextDetail,
  scrollContextDetailLine,
} = createDetailController({ ui, runtime, renderDashboard });

const {
  configToggleItems,
  moveConfigSelection,
  toggleSelectedConfig,
} = createConfigEditor({ cfg, ui, prefs: tuiPrefs, renderDashboard });

function buildUiSnapshot() {
  // reuse cached snapshot when nothing changed (prevents GC pressure from poll timer)
  if (!runtime.dirty && runtime.lastSnapshot) return runtime.lastSnapshot;
  runtime.dirty = false;

  const configItems = configToggleItems();
  const selectedConfigIndex = Math.max(
    Math.min(ui.configEditor.selectedIndex, Math.max(configItems.length - 1, 0)),
    0
  );

  const snapshot = {
    now: Date.now(),
    currentVersion: ui.currentVersion,
    updateAvailable: ui.updateAvailable,
    updatePrompt: {
      active: ui.updatePrompt.active,
      selectedIndex: ui.updatePrompt.selectedIndex,
      latestVersion: ui.updatePrompt.latestVersion,
      options: UPDATE_PROMPT_OPTIONS,
    },
    cfg: {
      userId: cfg.userId,
      host: cfg.host,
      pollMs: 0,
      uiRefreshMs: cfg.uiRefreshMs,
      logLevel: "info"
    },
    stats,
    selectedTab: ui.selectedTab,
    configEditor: {
      selectedIndex: selectedConfigIndex,
      items: configItems,
    },
    recentLogs: recentLogsCached(),
    sourceStats: ui.sourceStats,
    resume: ui.resume,
    detailView: ui.detailView,
    resumeTargetPicker: ui.resumeTargetPicker,
    onlineClients: ui.onlineClients,
    bootstrap: {
      active: ui.bootstrap.active,
      selectedIndex: ui.bootstrap.selectedIndex,
      options: ui.bootstrap.options,
      sourceNames: ui.bootstrap.sourceNames,
      note: ui.bootstrap.note,
    },
  };

  runtime.lastSnapshot = snapshot;
  return snapshot;
}

function validateConfig() {
  if (!cfg.apiKey) {
    throw new Error("Missing ULTRACONTEXT_API_KEY");
  }
}

// ── update prompt actions ────────────────────────────────────────

function moveUpdatePrompt(delta) {
  const total = UPDATE_PROMPT_OPTIONS.length;
  ui.updatePrompt.selectedIndex = (ui.updatePrompt.selectedIndex + delta + total) % total;
  renderDashboard();
}

function teardownTui() {
  if (runtime.statusPollTimer) clearInterval(runtime.statusPollTimer);
  runtime.statusPollTimer = null;
  if (runtime.contextRefreshTimer) clearInterval(runtime.contextRefreshTimer);
  runtime.contextRefreshTimer = null;
  runtime.uiController?.stop();
  runtime.uiController = null;
  runtime.stop?.("update");
  runtime.stop = null;
  runtime.uc = null;
}

function chooseUpdatePrompt(index) {
  const safeIndex = Math.max(Math.min(index, UPDATE_PROMPT_OPTIONS.length - 1), 0);
  const choice = UPDATE_PROMPT_OPTIONS[safeIndex]?.id;

  // dismiss prompt
  ui.updatePrompt.active = false;
  renderDashboard();

  if (choice === "install") {
    // tear down TUI so we can reuse the current terminal
    teardownTui();

    // run update in the same terminal
    const result = spawnSync(process.execPath, [process.argv[1], "update"], {
      stdio: "inherit",
      env: process.env,
    });

    if (result.status === 0) {
      // re-exec ultracontext to restart with the new version
      const restart = spawnSync(process.execPath, [process.argv[1]], {
        stdio: "inherit",
        env: process.env,
      });
      process.exit(restart.status ?? 0);
    } else {
      console.error("Update failed. Run manually: ultracontext update");
      process.exit(result.status ?? 1);
    }
  }
}

// ── tab + context entry wiring ──────────────────────────────────

// ── enter context (picker or detail based on source) ────────────

function enterContext() {
  const context = ui.resume.filteredContexts[ui.resume.selectedIndex];
  if (!context) {
    ui.resume.notice = "No context selected";
    renderDashboard();
    return;
  }

  const source = resumeContextSource(context);
  if (isCodingContextSource(source)) {
    openResumeTargetPicker();
  } else {
    void openContextDetail();
  }
}

function setSelectedTabByIndex(nextIndex) {
  const normalized = (nextIndex + MENU_TABS.length) % MENU_TABS.length;
  ui.selectedTab = MENU_TABS[normalized].id;
}

function ensureResumeTabDataLoaded() {
  if (ui.selectedTab !== "contexts") return;
  if (ui.resume.contexts.length === 0 && !ui.resume.loading) {
    void loadResumeContexts();
  }
}

function selectTabAndRefreshByIndex(index) {
  setSelectedTabByIndex(index);
  ensureResumeTabDataLoaded();
  renderDashboard();
}

function moveTabAndRefresh(delta) {
  const idx = MENU_TABS.findIndex((tab) => tab.id === ui.selectedTab);
  const current = idx === -1 ? 0 : idx;
  setSelectedTabByIndex(current + delta);
  ensureResumeTabDataLoaded();
  renderDashboard();
}

// ── main entry ──────────────────────────────────────────────────

async function tuiMain() {
  validateConfig();

  if (!process.stdout.isTTY) {
    throw new Error("TUI mode requires a TTY.");
  }

  try {
    const fileLoad = await loadConfigPrefsFromFile();
    if (!fileLoad.loaded) {
      await persistConfigPrefsToFile();
    }
  } catch {
    // ignore config persistence startup issues
  }

  const uc = new UltraContext({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
  runtime.uc = uc;

  await uc.get({ limit: 1 });

  let stopRequested = false;
  const stop = (reason = "internal") => {
    if (stopRequested) return;
    stopRequested = true;
    if (reason === "user" || reason === "sigint") {
      stopWatchParentProcess();
    }
    runtime.stopResolve?.();
  };
  runtime.stop = stop;

  runtime.uiController = createInkUiController({
    getSnapshot: buildUiSnapshot,
    actions: {
      stop: () => runtime.stop?.("user"),
      moveBootstrap: () => {},
      chooseBootstrap: () => {},
      moveUpdatePrompt: (delta) => {
        moveUpdatePrompt(delta);
      },
      chooseUpdatePrompt: (index) => {
        chooseUpdatePrompt(index);
      },
      moveTab: moveTabAndRefresh,
      selectTab: selectTabAndRefreshByIndex,
      moveConfig: (delta) => {
        moveConfigSelection(delta);
        renderDashboard();
      },
      toggleConfig: () => {
        void toggleSelectedConfig();
      },
      moveResume: (delta) => {
        moveResumeSelection(delta);
        renderDashboard();
      },
      refreshResume: () => {
        void loadResumeContexts();
      },
      cycleSourceFilter: () => {
        cycleSourceFilter();
      },
      promptResumeTarget: () => {
        openResumeTargetPicker();
      },
      moveResumeTarget: (delta) => {
        moveResumeTargetPickerSelection(delta);
      },
      chooseResumeTarget: (index) => {
        const target = resumeTargetPickerSelectionByIndex(index);
        if (target === "inspect") {
          closeResumeTargetPicker();
          void openContextDetail();
          return;
        }
        void resumeSelectedContext({ targetAgentOverride: target });
      },
      cancelResumeTarget: () => {
        closeResumeTargetPicker();
      },
      enterContext: () => {
        enterContext();
      },
      openDetail: () => {
        void openContextDetail();
      },
      closeDetail: () => {
        closeContextDetail();
      },
      scrollDetail: (delta) => {
        scrollContextDetail(delta);
      },
      scrollDetailLine: (delta) => {
        scrollContextDetailLine(delta);
      },
      refreshDetail: () => {
        void refreshContextDetail();
      },
    },
  });

  runtime.uiController.start();
  renderDashboard();
  void loadResumeContexts();
  void checkForUpdateSilent();

  // initial status poll
  await pollDaemonStatus();

  // status.json polling + render loop (only rerender when state changed)
  runtime.statusPollTimer = setInterval(async () => {
    await pollDaemonStatus();
    if (runtime.dirty) runtime.uiController?.refresh();
  }, cfg.uiRefreshMs);
  runtime.statusPollTimer.unref?.();

  // context auto-refresh
  if (cfg.resumeAutoRefreshMs > 0) {
    runtime.contextRefreshTimer = setInterval(() => {
      if (ui.resume.loading || ui.resume.syncing) return;
      void loadResumeContexts({ silent: ui.selectedTab !== "contexts" });
    }, Math.max(cfg.resumeAutoRefreshMs, 1000));
    runtime.contextRefreshTimer.unref?.();
  }

  process.on("SIGINT", () => stop("sigint"));
  process.on("SIGTERM", () => stop("sigterm"));

  // block until stop() is called (single Promise, no spin-loop allocation)
  await new Promise((resolve) => { runtime.stopResolve = resolve; });

  // cleanup
  if (runtime.statusPollTimer) clearInterval(runtime.statusPollTimer);
  runtime.statusPollTimer = null;
  if (runtime.contextRefreshTimer) clearInterval(runtime.contextRefreshTimer);
  runtime.contextRefreshTimer = null;

  runtime.uiController?.stop();
  runtime.uiController = null;

  runtime.lastSnapshot = null;
  runtime.stopResolve = null;
  runtime.stop = null;
  runtime.uc = null;
}

tuiMain().catch(async (error) => {
  if (runtime.statusPollTimer) clearInterval(runtime.statusPollTimer);
  runtime.statusPollTimer = null;
  if (runtime.contextRefreshTimer) clearInterval(runtime.contextRefreshTimer);
  runtime.contextRefreshTimer = null;

  runtime.uiController?.stop();
  runtime.uiController = null;

  runtime.stopResolve = null;
  runtime.stop = null;
  runtime.uc = null;

  if (onFatalError) {
    onFatalError(error);
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(`[error] UltraContext TUI failed: ${message}`);
  process.exit(1);
});

} // end tuiBoot
