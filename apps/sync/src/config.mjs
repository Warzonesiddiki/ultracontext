// =============================================================================
// CONFIG — the daemon's runtime configuration (extracted from daemon.mjs, ARCH-003)
// =============================================================================
//
// Three jobs, all of them about "what should this daemon do":
//   * `buildRuntimeConfig`   — env + argv (+ the injected db/lock resolvers) →
//     the `cfg` object every other module reads. Nothing here touches the
//     filesystem; `resolveDbPath` / `resolveLockPath` come in as parameters so
//     callers (index.mjs, tests) stay in control of where state lives.
//   * the config-prefs block  — `bootstrapMode`, `claudeIncludeSubagents`,
//     `captureAgents`, `projectPaths`: serialised to / loaded from the runtime
//     config file (SEC-004: 0700 dir, 0600 file, tmp+rename so an existing
//     0644 file is replaced rather than rewritten in place).
//   * bootstrap vocabulary   — the option list, its labels, the mode normaliser
//     and the state key. The PLAN (which mode to apply, priming offsets) is
//     orchestration and stays in daemon.mjs.
//
// `validateConfig` returns a warning descriptor instead of logging: config.mjs
// has no console contract of its own, so daemon.mjs decides how loudly to say
// it. It still THROWS for the one unrecoverable case (no API key).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBootstrapStateKey, normalizeBootstrapMode } from "./protocol.mjs";
import { normalizeCaptureAgents, normalizeProjectPaths } from "./onboarding-preferences.mjs";
import { boolFromEnv, expandHome, toInt } from "./utils.mjs";

export const DEFAULT_RUNTIME_CONFIG_FILE = "~/.ultracontext/config.json";

export const BOOTSTRAP_OPTIONS = [
  { id: "new_only", label: "New only (recommended)" },
  { id: "last_24h", label: "Last 24h" },
  { id: "all", label: "All" },
  { id: "prompt", label: "Ask on startup" },
];

/**
 * Strip surrounding quotes: keys reach us through shell profiles, `.env` files
 * and hand-edited JSON, all of which happily carry literal `'`/`"`.
 */
export function normalizeApiKey(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/^['"]|['"]$/g, "");
}

export function resolveRuntimeConfigPath(env = process.env) {
  return expandHome(env.ULTRACONTEXT_CONFIG_FILE ?? DEFAULT_RUNTIME_CONFIG_FILE);
}

/** `"prompt"` is a config value here (unlike the CLI's on/off/interactive). */
export function normalizeBootstrapModeWithPrompt(raw) {
  return normalizeBootstrapMode(raw, { allowPrompt: true }) || "";
}

export function bootstrapModeLabel(mode) {
  return BOOTSTRAP_OPTIONS.find((o) => o.id === mode)?.label ?? mode;
}

/**
 * The persisted bootstrap decision is scoped to (host, user, source set) so a
 * second machine — or a changed `INGEST_*` selection — bootstraps afresh instead
 * of inheriting someone else's "already primed" answer.
 */
export function bootstrapStateStoreKey({ cfg, sources }) {
  return createBootstrapStateKey({
    host: cfg.host, userId: cfg.userId,
    sourceNames: sources.map((s) => s.name),
  });
}

/**
 * @param {object} deps
 * @param {Record<string, string|undefined>} [deps.env]   environment (injectable for tests)
 * @param {Set<string>} [deps.cliArgs]                    `--flag` argv set
 * @param {(env: object) => string} deps.resolveDbPath    local store path resolver
 * @param {(env: object) => string} deps.resolveLockPath  single-instance lock path resolver
 */
export function buildRuntimeConfig({ env = process.env, cliArgs = new Set(), resolveDbPath, resolveLockPath } = {}) {
  return {
    apiKey: normalizeApiKey(env.ULTRACONTEXT_API_KEY),
    baseUrl: (env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").trim(),
    userId: env.DAEMON_USER_ID ?? env.USER ?? "unknown-user",
    host: (env.DAEMON_HOST || os.hostname() || "unknown-host").trim(),
    pollMs: toInt(env.DAEMON_POLL_MS, 1500),
    logLevel: env.DAEMON_LOG_LEVEL ?? "info",
    verboseLogs: cliArgs.has("--verbose") || boolFromEnv(env.DAEMON_VERBOSE, false),
    logAppends: boolFromEnv(env.DAEMON_LOG_APPENDS, true),
    uiRefreshMs: toInt(env.TUI_REFRESH_MS, 1200),
    uiRecentLimit: toInt(env.TUI_RECENT_LIMIT, 240),
    configFile: resolveRuntimeConfigPath(env),
    dbFile: resolveDbPath(env),
    lockFile: resolveLockPath(env),
    dedupeTtlSec: toInt(env.DAEMON_DEDUPE_TTL_SEC, 60 * 60 * 24 * 30),
    maxReadBytes: toInt(env.DAEMON_MAX_READ_BYTES, 4 * 1024 * 1024),
    bootstrapMode: normalizeBootstrapModeWithPrompt(env.DAEMON_BOOTSTRAP_MODE ?? "prompt") || "prompt",
    bootstrapReset: boolFromEnv(env.DAEMON_BOOTSTRAP_RESET, false),
    claudeIncludeSubagents: boolFromEnv(env.CLAUDE_INCLUDE_SUBAGENTS, false),
    // NOTE: these two still read `process.env` themselves (onboarding-preferences.mjs
    // normalises ULTRACONTEXT_CAPTURE_AGENTS / ULTRACONTEXT_PROJECT_PATHS). Passing
    // the injected `env` down would be nicer; it is deliberately NOT done here,
    // because this extraction must not change which environment is consulted.
    captureAgents: normalizeCaptureAgents(),
    projectPaths: normalizeProjectPaths(),
    cleanupEveryCycles: Math.max(toInt(env.DAEMON_STORE_CLEANUP_CYCLES, 20), 1),
  };
}

/**
 * The four settings the runtime config file owns. Everything else in `cfg` is
 * environment-only: a re-run must not resurrect a stale poll interval or db
 * path from a file the user edited months ago.
 */
export function serializeConfigPrefs(cfg) {
  return {
    bootstrapMode: normalizeBootstrapModeWithPrompt(cfg.bootstrapMode) || "prompt",
    claudeIncludeSubagents: Boolean(cfg.claudeIncludeSubagents),
    captureAgents: normalizeCaptureAgents(cfg.captureAgents),
    projectPaths: normalizeProjectPaths(cfg.projectPaths),
  };
}

/**
 * Merge a prefs object INTO `cfg` (in place — every module holds a reference to
 * the same object, so replacing `cfg` would silently detach them). Only keys
 * that are actually present are touched, which is what lets a partial
 * config.json leave the rest alone.
 */
export function applyConfigPrefs(cfg, prefs) {
  if (!prefs || typeof prefs !== "object") return;
  const fields = ["bootstrapMode", "claudeIncludeSubagents", "captureAgents", "projectPaths"];
  for (const field of fields) {
    if (!(field in prefs)) continue;
    if (field === "bootstrapMode") {
      cfg.bootstrapMode = normalizeBootstrapModeWithPrompt(prefs.bootstrapMode) || "prompt";
      continue;
    }
    if (field === "captureAgents") {
      cfg.captureAgents = normalizeCaptureAgents(prefs.captureAgents);
      continue;
    }
    if (field === "projectPaths") {
      cfg.projectPaths = normalizeProjectPaths(prefs.projectPaths);
      continue;
    }
    cfg[field] = Boolean(prefs[field]);
  }
}

/**
 * @param {object} deps
 * @param {object} deps.cfg                 live config (mutated in place by `apply`)
 * @param {(level: string, message: string, data?: object) => void} deps.log
 * @param {(error: unknown) => object} deps.errorDetails
 */
export function createConfigPrefs({ cfg, log, errorDetails }) {
  async function persistToFile(targetFile = cfg.configFile) {
    const target = path.resolve(targetFile);
    let existing = {};
    try {
      const raw = await fs.readFile(target, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed;
    } catch { /* ignore */ }

    const payload = JSON.stringify({ ...existing, ...serializeConfigPrefs(cfg) }, null, 2);
    // SEC-004: config may hold the raw API key — 0700 dir, 0600 file.
    // tmp + rename so an existing 0644 file is replaced, not re-written in place.
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    try { await fs.chmod(path.dirname(target), 0o700); } catch { /* best effort */ }
    const tmp = `${target}.tmp.cfg`;
    await fs.writeFile(tmp, `${payload}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, target);
    return { saved: true, file: target };
  }

  async function loadFromPath(target) {
    let raw = "";
    try {
      raw = await fs.readFile(target, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { loaded: false, missing: true, raw: "" };
      log("warn", "Failed to read config prefs file", { file: target, ...errorDetails(error) });
      return { loaded: false, missing: false, raw: "" };
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (error) {
      log("warn", "Failed to parse config prefs file", { file: target, ...errorDetails(error) });
      return { loaded: false, missing: false, raw };
    }
    applyConfigPrefs(cfg, parsed);
    return { loaded: true, missing: false, raw };
  }

  /** `source` is "primary" or "none" — a missing file is normal on first boot. */
  async function loadFromFile() {
    const primary = path.resolve(cfg.configFile);
    const loaded = await loadFromPath(primary);
    return {
      loaded: loaded.loaded,
      source: loaded.loaded ? "primary" : "none",
      file: loaded.loaded ? primary : "",
      raw: loaded.raw ?? "",
    };
  }

  return {
    serialize: () => serializeConfigPrefs(cfg),
    apply: (prefs) => applyConfigPrefs(cfg, prefs),
    persistToFile,
    loadFromPath,
    loadFromFile,
  };
}

/**
 * Pre-boot gate. Throws when there is no key at all (nothing can work); returns
 * a warning descriptor for a key that does not look like an UltraContext key,
 * which is usually a self-hosted or mistyped one and is worth showing but not
 * worth refusing to start over.
 */
export function validateConfig(cfg) {
  if (!cfg.apiKey) {
    throw new Error(
      "Missing ULTRACONTEXT_API_KEY. Run `ultracontext serve` first (free — keeps everything on " +
      "this machine, and the key is picked up automatically) or `ultracontext config` for a hosted key."
    );
  }
  if (!cfg.apiKey.startsWith("uc_live_") && !cfg.apiKey.startsWith("uc_test_")) {
    return {
      warn: {
        message: "ULTRACONTEXT_API_KEY format looks unusual",
        data: { key_prefix: cfg.apiKey.slice(0, 8), key_len: cfg.apiKey.length },
      },
    };
  }
  return { warn: null };
}
