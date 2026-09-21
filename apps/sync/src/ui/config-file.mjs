// === ui/config-file.mjs — the TUI's config.json vocabulary + prefs I/O ===
// Owns: the TUI-side config vocabulary (bootstrap modes, resume terminals,
// the persisted-field list and its normalisers), writeConfigKey (the TUI's
// one-shot command channel into the daemon's config.json — e.g. bootstrapReset),
// and the read-modify-write prefs cluster that persists the TUI's four settings
// (bootstrapMode, resumeTerminal, claudeIncludeSubagents, resumeOpenTab) while
// preserving every foreign key (apiKey, _bootstrapState, ...). Extracted
// verbatim from tui.mjs (ARCH-005); the cfg closure became the factory's
// injected dependency. Unlike the daemon's prefs writer (config.mjs, SEC-004
// 0700/0600 tmp+rename), this file keeps the TUI's historical plain
// tmp+rename write — changing that is a deliberate behaviour change, not a
// refactor, and does not belong to ARCH-005.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeBootstrapModeWithPrompt } from "../config.mjs";

export const CONFIG_BOOTSTRAP_MODES = [
  { id: "prompt", label: "Ask on startup" },
  { id: "new_only", label: "New only" },
  { id: "last_24h", label: "Last 24h" },
  { id: "all", label: "All" },
];

export const CONFIG_RESUME_TERMINALS = [
  { id: "terminal", label: "Terminal" },
  { id: "ghostty", label: "Ghostty" },
  { id: "warp", label: "Warp" },
  { id: "tmux", label: "tmux" },
  { id: "cmux", label: "cmux" },
];

export const PERSISTED_CONFIG_FIELDS = [
  "bootstrapMode",
  "resumeTerminal",
  "claudeIncludeSubagents",
  "resumeOpenTab"
];

export function normalizeResumeSourceFilter(raw) {
  const value = String(raw ?? "all").trim().toLowerCase();
  if (value === "codex" || value === "claude" || value === "openclaw" || value === "all") return value;
  return "all";
}

export function normalizeResumeTerminal(raw) {
  const value = String(raw ?? "terminal").trim().toLowerCase();
  if (value === "warp") return "warp";
  if (value === "ghostty") return "ghostty";
  if (value === "tmux") return "tmux";
  if (value === "cmux") return "cmux";
  return "terminal";
}

export function bootstrapModeConfigLabel(mode) {
  return CONFIG_BOOTSTRAP_MODES.find((entry) => entry.id === mode)?.label ?? mode;
}

export function resumeTerminalConfigLabel(mode) {
  const normalized = normalizeResumeTerminal(mode);
  return CONFIG_RESUME_TERMINALS.find((entry) => entry.id === normalized)?.label ?? "Terminal";
}

/**
 * Merge a single key into the daemon's config.json (read-modify-write via a
 * `.tmp.tui` sibling + rename). `home` is injectable for tests; production
 * callers resolve ~/.ultracontext/config.json exactly as before.
 */
export function writeConfigKey(key, value, { home = os.homedir() } = {}) {
  try {
    const configPath = path.join(home, ".ultracontext", "config.json");
    let data = {};
    try { data = JSON.parse(fsSync.readFileSync(configPath, "utf8")); } catch { /* empty */ }
    data[key] = value;
    const tmp = configPath + ".tmp.tui";
    fsSync.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fsSync.renameSync(tmp, configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The TUI's config.json prefs (its own four keys only — the daemon owns the
 * rest of the file). `cfg` is the boot closure's live object: apply() mutates
 * it, serialize() reads it, so editor toggles and file loads stay in sync.
 */
export function createTuiConfigPrefs({ cfg }) {

  function serializeConfigPrefs() {
    return {
      bootstrapMode: normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt",
      resumeTerminal: normalizeResumeTerminal(cfg.resumeTerminal),
      claudeIncludeSubagents: Boolean(cfg.claudeIncludeSubagents),
      resumeOpenTab: Boolean(cfg.resumeOpenTab)
    };
  }

  async function persistConfigPrefsToFile(targetFile = cfg.configFile) {
    const target = path.resolve(targetFile);
    await fs.mkdir(path.dirname(target), { recursive: true });

    // read-modify-write to preserve non-TUI keys (apiKey, _bootstrapState, etc.)
    let existing = {};
    try { existing = JSON.parse(await fs.readFile(target, "utf8")); } catch { /* empty */ }
    const merged = { ...existing, ...serializeConfigPrefs() };

    const tmp = target + ".tmp.prefs";
    await fs.writeFile(tmp, JSON.stringify(merged, null, 2) + "\n", "utf8");
    await fs.rename(tmp, target);
    return { saved: true, file: target };
  }

  async function loadConfigPrefsFromPath(target) {
    let raw = "";
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { loaded: false, missing: true };
      return { loaded: false, missing: false, error };
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { loaded: false, missing: false, error };
    }

    applyConfigPrefs(parsed);
    return { loaded: true, missing: false };
  }

  async function loadConfigPrefsFromFile() {
    const primary = path.resolve(cfg.configFile);
    const loaded = await loadConfigPrefsFromPath(primary);
    return {
      loaded: loaded.loaded,
      source: loaded.loaded ? "primary" : "none",
      file: loaded.loaded ? primary : "",
    };
  }

  function applyConfigPrefs(prefs) {
    if (!prefs || typeof prefs !== "object") return;
    for (const field of PERSISTED_CONFIG_FIELDS) {
      if (!(field in prefs)) continue;
      if (field === "bootstrapMode") {
        cfg.bootstrapMode = normalizeBootstrapModeWithPrompt(prefs.bootstrapMode) || "prompt";
        continue;
      }
      if (field === "resumeTerminal") {
        cfg.resumeTerminal = normalizeResumeTerminal(prefs.resumeTerminal);
        continue;
      }
      cfg[field] = Boolean(prefs[field]);
    }
  }

  async function persistConfigPrefs() {
    let fileSaved = false;

    try {
      await persistConfigPrefsToFile();
      fileSaved = true;
    } catch {
      // ignore
    }

    return { fileSaved };
  }

  return {
    serializeConfigPrefs,
    applyConfigPrefs,
    persistConfigPrefsToFile,
    loadConfigPrefsFromPath,
    loadConfigPrefsFromFile,
    persistConfigPrefs,
  };
}
