// Tests for the modules extracted out of tui.mjs by ARCH-005 (ui/status,
// ui/update-check, ui/config-file, ui/config-editor, ui/detail,
// ui/resume/*, process-tree) plus the shared logger runtimeLogsKeep export.
// The TUI's own boot path stays covered by the non-TTY tuiBoot() smoke in the
// commit message; everything tested here is the newly importable surface.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tmpdir } from "node:os";

import { isNewerVersion, readTuiVersion } from "../src/ui/update-check.mjs";
import {
  PERSISTED_CONFIG_FIELDS,
  createTuiConfigPrefs,
  normalizeResumeSourceFilter,
  normalizeResumeTerminal,
  writeConfigKey,
} from "../src/ui/config-file.mjs";
import { createConfigEditor } from "../src/ui/config-editor.mjs";
import { createStatusChannel, readStatusJson } from "../src/ui/status.mjs";
import { createDetailController } from "../src/ui/detail.mjs";
import {
  INSPECT_OPTION,
  isCodingContextSource,
  recommendedResumeTargetForContext,
  resumeCompact,
  resumeContextSource,
  resumeDedupeById,
  resumeFilterContexts,
  resumeNormalizeRole,
  resumeSortContexts,
  resumeSummaryMarkdown,
  resumeTargetAgent,
  resumeTargetOptionsForSource,
} from "../src/ui/resume/context-helpers.mjs";
import {
  createTerminalLauncher,
  resumeOpenTmuxWindow,
  resumeShellQuote,
  warpLaunchConfigYaml,
} from "../src/ui/resume/terminal-launch.mjs";
import { createResumeController } from "../src/ui/resume/controller.mjs";
import { isWatchCommand, readProcessInfo } from "../src/process-tree.mjs";
import { runtimeLogsKeep } from "../src/logger.mjs";

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "uc-tui-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeTuiState({ uiRecentLimit = 240 } = {}) {
  const cfg = {
    uiRecentLimit,
    bootstrapMode: "prompt",
    resumeTerminal: "terminal",
    claudeIncludeSubagents: false,
    resumeOpenTab: true,
    resumeContextLimit: 1000,
    resumeSourceFilter: "all",
    resumeSummaryTail: 14,
    resumeOutputDir: "/tmp/uc-resume-test",
    configFile: "/tmp/uc-tui-test-config.json",
  };
  const stats = { startedAt: 1, cycles: 0, appended: 0 };
  const ui = {
    daemonOnline: false,
    onlineClients: 0,
    recentLogs: [],
    sourceStats: [],
    selectedTab: "logs",
    configEditor: { selectedIndex: 0 },
    resume: {
      loading: false, syncing: false, contexts: [], filteredContexts: [],
      sourceFilter: "all", selectedIndex: 0, loadedAt: 0, error: "", notice: "",
      summaryPath: "", command: "", commandPath: "",
    },
    resumeTargetPicker: {
      active: false, selectedIndex: 0, source: "", contextId: "",
      options: [], recommendedTarget: "",
    },
    detailView: {
      active: false, contextId: null, contextMeta: null, messages: [],
      scrollOffset: 0, lineOffset: 0, loading: false, error: null,
    },
  };
  const runtime = {
    uc: null,
    seenLogSignatures: new Set(),
    resumeKnownContextIds: new Set(),
    resumeBaselineReady: false,
    titleCache: new Map(),
    titleInflight: new Set(),
    cachedLogSlice: [],
    cachedLogLen: 0,
    dirty: true,
  };
  let dirtyCount = 0;
  const markDirty = () => { dirtyCount += 1; runtime.dirty = true; };
  let renders = 0;
  const renderDashboard = () => { renders += 1; };
  return { cfg, stats, ui, runtime, markDirty, renderDashboard, counts: () => ({ dirtyCount, renders }) };
}

// ── ui/update-check.mjs ─────────────────────────────────────────

describe("ui/update-check", () => {
  it("isNewerVersion compares numerically, segment by segment", () => {
    assert.equal(isNewerVersion("1.2.3", "1.2.2"), true);
    assert.equal(isNewerVersion("1.2.3", "1.2.3"), false);
    assert.equal(isNewerVersion("1.2.3", "1.10.0"), false);
    assert.equal(isNewerVersion("2.0.0", "1.9.9"), true);
  });

  it("isNewerVersion treats missing segments as zero", () => {
    assert.equal(isNewerVersion("1.3", "1.2.9"), true);
    assert.equal(isNewerVersion("1.2", "1.2.0"), false);
  });

  it("readTuiVersion reads the app root package.json", () => {
    const root = tmpHomeWithPkg("9.9.8");
    assert.equal(readTuiVersion(root), "9.9.8");
  });

  it("readTuiVersion falls back to unknown", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "uc-tui-nopkg-"));
    try { assert.equal(readTuiVersion(dir), "unknown"); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

function tmpHomeWithPkg(version) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "uc-tui-pkg-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
  return dir;
}

// ── ui/config-file.mjs ──────────────────────────────────────────

describe("ui/config-file", () => {
  it("normalizeResumeTerminal accepts the five terminals and defaults to terminal", () => {
    for (const id of ["terminal", "ghostty", "warp", "tmux", "cmux"]) {
      assert.equal(normalizeResumeTerminal(id), id);
    }
    assert.equal(normalizeResumeTerminal("WARP "), "warp");
    assert.equal(normalizeResumeTerminal(""), "terminal");
    assert.equal(normalizeResumeTerminal("hyper"), "terminal");
    assert.equal(normalizeResumeTerminal(undefined), "terminal");
  });

  it("normalizeResumeSourceFilter accepts the known filters and defaults to all", () => {
    assert.equal(normalizeResumeSourceFilter("codex"), "codex");
    assert.equal(normalizeResumeSourceFilter(" Claude\n"), "claude");
    assert.equal(normalizeResumeSourceFilter("gemini"), "all");
    assert.equal(normalizeResumeSourceFilter(undefined), "all");
  });

  it("writeConfigKey merges one key and preserves foreign keys", (t) => {
    const home = tmpHome(t);
    fs.mkdirSync(path.join(home, ".ultracontext"), { recursive: true });
    const configPath = path.join(home, ".ultracontext", "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ apiKey: "secret", _bootstrapState: { k: "all" } }));

    assert.equal(writeConfigKey("bootstrapReset", true, { home }), true);

    const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(written.bootstrapReset, true);
    assert.equal(written.apiKey, "secret");
    assert.deepEqual(written._bootstrapState, { k: "all" });
    assert.ok(fs.readFileSync(configPath, "utf8").endsWith("\n"));
    assert.ok(!fs.existsSync(configPath + ".tmp.tui"), "no tmp file left behind");
  });

  it("writeConfigKey returns false when the write fails", (t) => {
    // a home whose .ultracontext is a regular file makes the write fail
    const home = tmpHome(t);
    fs.mkdirSync(path.join(home, ".ultracontext"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ultracontext", "config.json"), "");
    fs.rmSync(path.join(home, ".ultracontext"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ultracontext"), "not a dir");
    assert.equal(writeConfigKey("k", 1, { home }), false);
  });

  it("tui prefs round-trip through a file, preserving foreign keys", async (t) => {
    const dir = tmpHome(t);
    const configFile = path.join(dir, "config.json");
    fs.writeFileSync(configFile, JSON.stringify({ apiKey: "uc_live_x", extra: 1 }));
    const { cfg } = fakeTuiState();
    cfg.configFile = configFile;
    const prefs = createTuiConfigPrefs({ cfg });

    cfg.bootstrapMode = "last_24h";
    cfg.resumeTerminal = "warp";
    cfg.claudeIncludeSubagents = true;
    cfg.resumeOpenTab = false;

    const saved = await prefs.persistConfigPrefsToFile();
    assert.equal(saved.saved, true);
    assert.equal(saved.file, path.resolve(configFile));

    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(onDisk.apiKey, "uc_live_x");
    assert.equal(onDisk.extra, 1);
    assert.equal(onDisk.bootstrapMode, "last_24h");

    // a fresh cfg loads the four fields and nothing else
    const { cfg: cfg2 } = fakeTuiState();
    cfg2.configFile = configFile;
    const prefs2 = createTuiConfigPrefs({ cfg: cfg2 });
    const loaded = await prefs2.loadConfigPrefsFromFile();
    assert.equal(loaded.loaded, true);
    assert.equal(loaded.source, "primary");
    assert.equal(cfg2.bootstrapMode, "last_24h");
    assert.equal(cfg2.resumeTerminal, "warp");
    assert.equal(cfg2.claudeIncludeSubagents, true);
    assert.equal(cfg2.resumeOpenTab, false);
  });

  it("tui prefs normalise invalid values and ignore unknown fields", () => {
    const { cfg } = fakeTuiState();
    const prefs = createTuiConfigPrefs({ cfg });
    prefs.applyConfigPrefs({
      bootstrapMode: "nonsense",
      resumeTerminal: "hyper",
      claudeIncludeSubagents: "yes",
      apiKey: "injected",
      resumeContextLimit: 5,
    });
    assert.equal(cfg.bootstrapMode, "prompt");
    assert.equal(cfg.resumeTerminal, "terminal");
    assert.equal(cfg.claudeIncludeSubagents, true);
    assert.equal(cfg.resumeContextLimit, 1000, "non-persisted field untouched");
    assert.deepEqual(Object.keys(prefs.serializeConfigPrefs()).sort(), [...PERSISTED_CONFIG_FIELDS].sort());
  });

  it("tui prefs load reports ENOENT as missing", async (t) => {
    const { cfg } = fakeTuiState();
    cfg.configFile = path.join(tmpHome(t), "missing.json");
    const prefs = createTuiConfigPrefs({ cfg });
    const loaded = await prefs.loadConfigPrefsFromPath(cfg.configFile);
    assert.deepEqual(loaded, { loaded: false, missing: true });
  });
});

// ── ui/config-editor.mjs ────────────────────────────────────────

describe("ui/config-editor", () => {
  function editor() {
    const s = fakeTuiState();
    const prefs = createTuiConfigPrefs({ cfg: s.cfg });
    const ctrl = createConfigEditor({ cfg: s.cfg, ui: s.ui, prefs, renderDashboard: s.renderDashboard });
    return { s, ctrl };
  }

  it("exposes the three toggle items with labels", () => {
    const { ctrl } = editor();
    const items = ctrl.configToggleItems();
    assert.deepEqual(items.map((i) => i.key), ["bootstrapMode", "resumeTerminal", "bootstrapResetState"]);
    assert.equal(items[0].valueLabel, "Ask on startup");
  });

  it("moveConfigSelection wraps in both directions", () => {
    const { s, ctrl } = editor();
    ctrl.moveConfigSelection(-1);
    assert.equal(s.ui.configEditor.selectedIndex, 2);
    ctrl.moveConfigSelection(1);
    assert.equal(s.ui.configEditor.selectedIndex, 0);
    ctrl.moveConfigSelection(1);
    assert.equal(s.ui.configEditor.selectedIndex, 1);
  });

  it("bootstrapMode toggle cycles the enum and persists", async () => {
    const { s, ctrl } = editor();
    await ctrl.toggleSelectedConfig();
    assert.equal(s.cfg.bootstrapMode, "new_only");
    assert.match(s.ui.resume.notice, /Sync profile set: New only \(saved\)\./);
  });

  it("resumeTerminal toggle cycles and persists", async () => {
    const { s, ctrl } = editor();
    s.ui.configEditor.selectedIndex = 1;
    await ctrl.toggleSelectedConfig();
    assert.equal(s.cfg.resumeTerminal, "ghostty");
    assert.match(s.ui.resume.notice, /Resume terminal: Ghostty \(saved\)\./);
  });

  it("bootstrapReset action persists prefs then stamps the command key", async (t) => {
    // writeConfigKey resolves ~/.ultracontext/config.json via os.homedir(),
    // so point HOME at a tmp home for the duration (the original never mkdir'd
    // the directory and silently failed — pinned, not blessed).
    const home = tmpHome(t);
    fs.mkdirSync(path.join(home, ".ultracontext"), { recursive: true });
    const realHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => { process.env.HOME = realHome; });
    const { s, ctrl } = editor();
    s.cfg.configFile = path.join(home, ".ultracontext", "config.json");
    s.ui.configEditor.selectedIndex = 2;
    await ctrl.toggleSelectedConfig();
    assert.match(s.ui.resume.notice, /Bootstrap reset requested/);
    assert.equal(JSON.parse(fs.readFileSync(s.cfg.configFile, "utf8")).bootstrapReset, true);
  });
});

// ── ui/status.mjs ───────────────────────────────────────────────

describe("ui/status", () => {
  it("readStatusJson parses an existing file and returns null on missing/invalid", async (t) => {
    const dir = tmpHome(t);
    const file = path.join(dir, "status.json");
    assert.equal(await readStatusJson(file), null);
    fs.writeFileSync(file, JSON.stringify({ pid: 7 }));
    assert.deepEqual(await readStatusJson(file), { pid: 7 });
    fs.writeFileSync(file, "{not json");
    assert.equal(await readStatusJson(file), null);
  });

  it("applyDaemonStatus applies a fresh snapshot: online, stats, sources, logs, config", () => {
    const s = fakeTuiState();
    const channel = createStatusChannel({ ...s, statusFile: "/tmp/none.json" });
    const now = new Date().toISOString();
    channel.applyDaemonStatus({
      updatedAt: now,
      stats: { cycles: 42, appended: 3 },
      sources: [{ name: "claude", filesScanned: 2, lastAt: 5 }],
      recentLogs: [{ ts: "00:00:00", level: "info", source: "claude", text: "hello" }],
      config: { bootstrapMode: "all", claudeIncludeSubagents: true },
    });
    assert.equal(s.ui.daemonOnline, true);
    assert.equal(s.ui.onlineClients, 1);
    assert.equal(s.stats.cycles, 42);
    assert.equal(s.stats.appended, 3);
    assert.equal(s.ui.sourceStats.length, 1);
    assert.equal(s.ui.sourceStats[0].name, "claude");
    assert.equal(s.ui.sourceStats[0].lastFile, "-");
    assert.deepEqual(s.ui.recentLogs, [{ ts: "00:00:00", level: "info", source: "claude", text: "hello" }]);
    assert.equal(s.cfg.bootstrapMode, "all");
    assert.equal(s.cfg.claudeIncludeSubagents, true);
    assert.ok(s.counts().dirtyCount > 0);
  });

  it("applyDaemonStatus dedupes logs by signature and caps the ring at uiRecentLimit", () => {
    const s = fakeTuiState({ uiRecentLimit: 3 });
    const channel = createStatusChannel({ ...s, statusFile: "/tmp/none.json" });
    const entry = { ts: "00:00:00", level: "info", source: "claude", text: "x" };
    channel.applyDaemonStatus({ updatedAt: new Date().toISOString(), recentLogs: [entry, entry, entry] });
    assert.equal(s.ui.recentLogs.length, 1);
    // cap: ring trims to uiRecentLimit as more unique entries arrive
    for (let i = 0; i < 5; i++) {
      channel.applyDaemonStatus({
        updatedAt: new Date().toISOString(),
        recentLogs: [{ ts: "00:00:00", level: "info", source: "claude", text: `y${i}` }],
      });
    }
    assert.ok(s.ui.recentLogs.length <= 3);
    assert.equal(s.ui.recentLogs.at(-1).text, "y4");
  });

  it("applyDaemonStatus marks the daemon offline on stale or missing status", () => {
    const s = fakeTuiState();
    const channel = createStatusChannel({ ...s, statusFile: "/tmp/none.json" });
    channel.applyDaemonStatus({ updatedAt: new Date(Date.now() - 60_000).toISOString() });
    assert.equal(s.ui.daemonOnline, false);
    assert.equal(s.ui.onlineClients, 0);
    // stats NOT applied while offline
    channel.applyDaemonStatus({ updatedAt: new Date(Date.now() - 60_000).toISOString(), stats: { appended: 9 } });
    assert.equal(s.stats.appended, 0);
    channel.applyDaemonStatus(null);
    assert.equal(s.ui.daemonOnline, false);
  });

  it("recentLogsCached slices to runtimeLogsKeep and reuses the array when unchanged", () => {
    const s = fakeTuiState({ uiRecentLimit: 10 }); // keep = max(10, 180) = 180
    const channel = createStatusChannel({ ...s, statusFile: "/tmp/none.json" });
    for (let i = 0; i < 200; i++) s.ui.recentLogs.push({ ts: "t", level: "info", source: "s", text: `l${i}` });
    const first = channel.recentLogsCached();
    assert.equal(first.length, 180);
    assert.equal(first[0].text, "l20");
    const second = channel.recentLogsCached();
    assert.equal(second, first, "same array instance while unchanged");
  });
});

// ── logger.runtimeLogsKeep (shared export) ─────────────────────

describe("logger runtimeLogsKeep", () => {
  it("holds at least a screenful even for a tiny uiRecentLimit", () => {
    assert.equal(runtimeLogsKeep({ uiRecentLimit: 10 }), 180);
    assert.equal(runtimeLogsKeep({ uiRecentLimit: 240 }), 240);
  });
});

// ── ui/resume/context-helpers.mjs ───────────────────────────────

describe("ui/resume/context-helpers", () => {
  it("resumeCompact truncates with an ellipsis and respects small maxima", () => {
    assert.equal(resumeCompact("short"), "short");
    assert.equal(resumeCompact("abcdefghij", 6), "abc...");
    assert.equal(resumeCompact("abcdef", 3), "abc");
    assert.equal(resumeCompact(null), "");
  });

  it("resumeNormalizeRole folds aliases into user/assistant/system", () => {
    assert.equal(resumeNormalizeRole({ role: "human" }), "user");
    assert.equal(resumeNormalizeRole({ role: "Agent" }), "assistant");
    assert.equal(resumeNormalizeRole({}), "system");
  });

  it("resumeDedupeById keeps the first occurrence and drops id-less items", () => {
    const list = [{ id: "a" }, { id: "b" }, { id: "a" }, {}, { id: "b" }];
    assert.deepEqual(resumeDedupeById(list).map((c) => c.id), ["a", "b"]);
  });

  it("resumeFilterContexts honours the source filter but keeps unlabelled contexts", () => {
    const list = [
      { id: "1", metadata: { source: "claude" } },
      { id: "2", metadata: { source: "codex" } },
      { id: "3", metadata: {} },
    ];
    assert.deepEqual(resumeFilterContexts(list, "codex").map((c) => c.id), ["2", "3"]);
    assert.deepEqual(resumeFilterContexts(list, "all").map((c) => c.id), ["1", "2", "3"]);
  });

  it("resumeSortContexts sorts newest first and breaks ties by id descending", () => {
    const list = [
      { id: "ctx_1", created_at: "2026-01-01T00:00:00Z" },
      { id: "ctx_3", created_at: "2026-03-01T00:00:00Z" },
      { id: "ctx_2", created_at: "2026-02-01T00:00:00Z" },
    ];
    assert.deepEqual(resumeSortContexts(list).map((c) => c.id), ["ctx_3", "ctx_2", "ctx_1"]);
    const tied = [{ id: "ctx_a" }, { id: "ctx_b" }];
    assert.deepEqual(resumeSortContexts(tied).map((c) => c.id), ["ctx_b", "ctx_a"]);
    assert.notEqual(resumeSortContexts(list), list, "input not mutated");
  });

  it("source→agent mapping is the cross switch with codex fallback", () => {
    assert.equal(resumeContextSource({ metadata: { source: "CLAUDE" } }), "claude");
    assert.equal(resumeContextSource({ metadata: { source: "gemini" } }), "unknown");
    assert.equal(isCodingContextSource("codex"), true);
    assert.equal(isCodingContextSource("unknown"), false);
    assert.equal(resumeTargetAgent("codex"), "claude");
    assert.equal(resumeTargetAgent("claude"), "codex");
    assert.equal(resumeTargetAgent("unknown"), "codex");
    assert.equal(recommendedResumeTargetForContext({ metadata: { source: "gemini" } }), "");
  });

  it("resumeTargetOptionsForSource puts the recommended target first and appends inspect", () => {
    const forClaude = resumeTargetOptionsForSource("claude");
    assert.equal(forClaude[0].id, "codex");
    assert.equal(forClaude.at(-1), INSPECT_OPTION);
    const forUnknown = resumeTargetOptionsForSource("gemini");
    assert.deepEqual(forUnknown.map((o) => o.id), ["claude", "codex"], "non-coding source: plain options, no inspect");
  });

  it("resumeSummaryMarkdown renders header, snapshot and timeline sections", () => {
    const md = resumeSummaryMarkdown({
      context: { id: "ctx_9", created_at: "2026-01-01T00:00:00Z", metadata: { source: "claude", user_id: "u", session_id: "s" } },
      messages: [
        { role: "user", content: { message: "first question", event_type: "message", timestamp: "2026-01-01T00:00:01Z" } },
        { role: "assistant", content: { message: "an answer", event_type: "message", timestamp: "2026-01-01T00:00:02Z" } },
      ],
      tail: 14,
    });
    assert.match(md, /^# UltraContext Resume\n/);
    assert.match(md, /Context ID: ctx_9/);
    assert.match(md, /Messages: 2/);
    assert.match(md, /user=1, assistant=1, system=0/);
    assert.match(md, /first question/);
    assert.match(md, /## Resume Instructions/);
  });
});

// ── ui/resume/terminal-launch.mjs ───────────────────────────────

describe("ui/resume/terminal-launch", () => {
  it("resumeShellQuote single-quotes and escapes embedded single quotes", () => {
    assert.equal(resumeShellQuote("/tmp/a b"), "'/tmp/a b'");
    assert.equal(resumeShellQuote("it's"), `'it'"'"'s'`);
  });

  it("warpLaunchConfigYaml quotes name/cwd/command and flattens newlines", () => {
    const yaml = warpLaunchConfigYaml({ name: "Resume 1", cwd: "/tmp/x", command: "a\nb" });
    assert.match(yaml, /^---\n/);
    assert.match(yaml, /name: "Resume 1"/);
    assert.match(yaml, /cwd: "\/tmp\/x"/);
    assert.match(yaml, /exec: "a && b"/);
  });

  it("tmux launch refuses politely outside a tmux session", () => {
    const out = resumeOpenTmuxWindow("echo hi");
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not inside a tmux session");
  });

  it("dispatcher reports non-macOS for the default terminal", () => {
    const launcher = createTerminalLauncher({ getResumeTerminal: () => "terminal" });
    if (process.platform === "darwin") return; // behavioural check is POSIX-only here
    const out = launcher.resumeOpenTerminalTab("echo hi");
    assert.equal(out.ok, false);
    assert.equal(out.reason, "open-tab is available only on macOS");
  });

  it("dispatcher routes tmux before the platform gate", () => {
    const launcher = createTerminalLauncher({ getResumeTerminal: () => "tmux" });
    const out = launcher.resumeOpenTerminalTab("echo hi");
    assert.equal(out.ok, false);
    assert.equal(out.reason, "not inside a tmux session");
  });
});

// ── ui/resume/controller.mjs ────────────────────────────────────

describe("ui/resume/controller", () => {
  function controller({ data = [], getError = null } = {}) {
    const s = fakeTuiState();
    const launcher = createTerminalLauncher({ getResumeTerminal: () => "terminal" });
    s.runtime.uc = {
      get: async () => { if (getError) throw getError; return { data }; },
    };
    const ctrl = createResumeController({
      cfg: s.cfg, ui: s.ui, runtime: s.runtime,
      renderDashboard: s.renderDashboard, markDirty: s.markDirty, terminalLauncher: launcher,
    });
    return { s, ctrl };
  }

  it("loadResumeContexts (silent) dedupes, filters, sorts and records known ids", async () => {
    const { s, ctrl } = controller({
      data: [
        { id: "ctx_1", created_at: "2026-01-01T00:00:00Z", metadata: { source: "claude" } },
        { id: "ctx_1", created_at: "2026-01-01T00:00:00Z", metadata: { source: "claude" } },
        { id: "ctx_2", created_at: "2026-02-01T00:00:00Z", metadata: { source: "codex" } },
      ],
    });
    await ctrl.loadResumeContexts({ silent: true });
    assert.deepEqual(s.ui.resume.contexts.map((c) => c.id), ["ctx_2", "ctx_1"]);
    assert.equal(s.ui.resume.contexts.length, s.ui.resume.filteredContexts.length);
    assert.ok(s.runtime.resumeBaselineReady);
    assert.deepEqual([...s.runtime.resumeKnownContextIds].sort(), ["ctx_1", "ctx_2"]);
    assert.equal(s.ui.resume.notice, "", "silent load leaves the notice alone");
    assert.equal(s.ui.resume.loading, false);
  });

  it("loadResumeContexts (verbose) sets the loaded notice with per-source counts", async () => {
    const { s, ctrl } = controller({
      data: [
        { id: "ctx_1", created_at: "2026-01-01T00:00:00Z", metadata: { source: "claude" } },
        { id: "ctx_2", created_at: "2026-02-01T00:00:00Z", metadata: { source: "codex" } },
      ],
    });
    await ctrl.loadResumeContexts();
    assert.match(s.ui.resume.notice, /Loaded 2 session contexts \(all sources: codex=1, claude=1, openclaw=0, cursor=0, gemini=0, other=0\)/);
  });

  it("loadResumeContexts reports errors into resume.error and honours the source filter", async () => {
    const { s, ctrl } = controller({ getError: Object.assign(new Error("boom"), { status: 500 }) });
    await ctrl.loadResumeContexts();
    assert.equal(s.ui.resume.error, "boom");

    const { s: s2, ctrl: ctrl2 } = controller({
      data: [
        { id: "ctx_c", created_at: "2026-01-01T00:00:00Z", metadata: { source: "claude" } },
        { id: "ctx_x", created_at: "2026-02-01T00:00:00Z", metadata: { source: "codex" } },
      ],
    });
    s2.cfg.resumeSourceFilter = "codex";
    await ctrl2.loadResumeContexts({ silent: true });
    assert.deepEqual(s2.ui.resume.filteredContexts.map((c) => c.id), ["ctx_x"]);
  });

  it("openResumeTargetPicker rejects non-coding sources and accepts codex/claude", async () => {
    const { s, ctrl } = controller({
      data: [{ id: "ctx_g", created_at: "2026-01-01T00:00:00Z", metadata: { source: "gemini" } }],
    });
    await ctrl.loadResumeContexts({ silent: true });
    assert.equal(ctrl.openResumeTargetPicker(), false);
    assert.match(s.ui.resume.notice, /only for codex\/claude contexts/);

    const { s: s2, ctrl: ctrl2 } = controller({
      data: [{ id: "ctx_c", created_at: "2026-01-01T00:00:00Z", metadata: { source: "codex" } }],
    });
    await ctrl2.loadResumeContexts({ silent: true });
    assert.equal(ctrl2.openResumeTargetPicker(), true);
    assert.equal(s2.ui.resumeTargetPicker.active, true);
    assert.equal(s2.ui.resumeTargetPicker.recommendedTarget, "claude");
    assert.deepEqual(s2.ui.resumeTargetPicker.options.map((o) => o.id), ["claude", "codex", "inspect"]);
    ctrl2.closeResumeTargetPicker();
    assert.equal(s2.ui.resumeTargetPicker.active, false);
  });

  it("moveResumeSelection wraps at both ends; applySourceFilter clamps the index", async () => {
    const { s, ctrl } = controller({
      data: [
        { id: "ctx_1", created_at: "2026-01-01T00:00:00Z", metadata: { source: "claude" } },
        { id: "ctx_2", created_at: "2026-02-01T00:00:00Z", metadata: { source: "claude" } },
      ],
    });
    await ctrl.loadResumeContexts({ silent: true });
    ctrl.moveResumeSelection(-1);
    assert.equal(s.ui.resume.selectedIndex, 1);
    ctrl.moveResumeSelection(1);
    assert.equal(s.ui.resume.selectedIndex, 0);
    s.ui.resume.selectedIndex = 1;
    s.ui.resume.sourceFilter = "codex";
    ctrl.applySourceFilter();
    assert.equal(s.ui.resume.selectedIndex, 0, "clamped to the filtered length");
  });

  it("cycleSourceFilter advances through the filter list", async () => {
    const { s, ctrl } = controller({ data: [] });
    await ctrl.loadResumeContexts({ silent: true });
    ctrl.cycleSourceFilter();
    assert.equal(s.ui.resume.sourceFilter, "claude");
    ctrl.cycleSourceFilter();
    assert.equal(s.ui.resume.sourceFilter, "codex");
  });

  it("resumeSelectedContext guards: no client, no selection, non-coding source", async () => {
    const { s, ctrl } = controller({ data: [] });
    await ctrl.resumeSelectedContext();
    assert.equal(s.ui.resume.syncing, false);

    const { s: s2, ctrl: ctrl2 } = controller({
      data: [{ id: "ctx_g", created_at: "2026-01-01T00:00:00Z", metadata: { source: "gemini" } }],
    });
    await ctrl2.loadResumeContexts({ silent: true });
    await ctrl2.resumeSelectedContext();
    assert.match(s2.ui.resume.notice, /only for codex\/claude contexts/);
  });

  it("enrichContextTitles caches the first real user message as the title", async () => {
    const s = fakeTuiState();
    s.runtime.uc = {
      get: async () => ({
        data: [
          { role: "user", content: { event_type: "response_item.message", message: "A new session was started" } },
          { role: "user", content: { message: "the real first question\nwith detail" } },
        ],
      }),
    };
    const launcher = createTerminalLauncher({ getResumeTerminal: () => "terminal" });
    const ctrl = createResumeController({
      cfg: s.cfg, ui: s.ui, runtime: s.runtime,
      renderDashboard: s.renderDashboard, markDirty: s.markDirty, terminalLauncher: launcher,
    });
    const contexts = [{ id: "ctx_t", metadata: {} }];
    ctrl.enrichContextTitles(contexts);
    await new Promise((r) => setImmediate(r));
    assert.equal(s.runtime.titleCache.get("ctx_t"), "the real first question with detail");
    assert.equal(contexts[0].metadata.title, "the real first question with detail");
  });
});

// ── ui/detail.mjs ───────────────────────────────────────────────

describe("ui/detail", () => {
  it("scrollContextDetail wraps and resets the line offset; scrollContextDetailLine clamps", () => {
    const s = fakeTuiState();
    const detail = createDetailController({ ui: s.ui, runtime: s.runtime, renderDashboard: s.renderDashboard });
    s.ui.detailView.messages = [{}, {}, {}];
    s.ui.detailView.scrollOffset = 0;
    s.ui.detailView.lineOffset = 4;
    detail.scrollContextDetail(-1);
    assert.equal(s.ui.detailView.scrollOffset, 2, "wraps backwards");
    assert.equal(s.ui.detailView.lineOffset, 0);
    detail.scrollContextDetail(1);
    assert.equal(s.ui.detailView.scrollOffset, 0, "wraps forwards");
    detail.scrollContextDetailLine(-10);
    assert.equal(s.ui.detailView.lineOffset, 0, "clamped at 0");
    detail.scrollContextDetailLine(3);
    assert.equal(s.ui.detailView.lineOffset, 3);
  });

  it("closeContextDetail clears the view", () => {
    const s = fakeTuiState();
    const detail = createDetailController({ ui: s.ui, runtime: s.runtime, renderDashboard: s.renderDashboard });
    s.ui.detailView.active = true;
    s.ui.detailView.contextId = "ctx_1";
    s.ui.detailView.messages = [{}];
    detail.closeContextDetail();
    assert.equal(s.ui.detailView.active, false);
    assert.equal(s.ui.detailView.contextId, null);
    assert.deepEqual(s.ui.detailView.messages, []);
  });
});

// ── process-tree.mjs ────────────────────────────────────────────

describe("process-tree", () => {
  it("isWatchCommand spots --watch invocations only", () => {
    assert.equal(isWatchCommand("node --watch src/index.mjs"), true);
    assert.equal(isWatchCommand("npm run dev -- --watch x"), true);
    assert.equal(isWatchCommand("node src/index.mjs"), false);
    assert.equal(isWatchCommand(""), false);
    assert.equal(isWatchCommand(undefined), false);
    assert.equal(isWatchCommand("node --watcher x"), true, "substring matching — pinned, not blessed");
  });

  it("readProcessInfo reads the current process from ps", () => {
    const info = readProcessInfo(process.pid);
    assert.ok(info, "ps should resolve the current pid");
    assert.ok(Number.isInteger(info.ppid));
    assert.ok(typeof info.command === "string" && info.command.length > 0);
  });

  it("readProcessInfo returns null for an unreadable pid", () => {
    assert.equal(readProcessInfo(0), null);
  });
});
