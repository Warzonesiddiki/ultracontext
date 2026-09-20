// =============================================================================
// ARCH-003 — config.mjs: env → cfg, the runtime config-prefs block, bootstrap
// vocabulary and the pre-boot gate. Extracted from daemon.mjs, which had no
// tests at all; these pin the precedence rules a self-hosted install depends on.
// =============================================================================

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BOOTSTRAP_OPTIONS,
  DEFAULT_RUNTIME_CONFIG_FILE,
  applyConfigPrefs,
  bootstrapModeLabel,
  bootstrapStateStoreKey,
  buildRuntimeConfig,
  createConfigPrefs,
  normalizeApiKey,
  normalizeBootstrapModeWithPrompt,
  resolveRuntimeConfigPath,
  serializeConfigPrefs,
  validateConfig,
} from "../src/config.mjs";

const stubResolvers = {
  resolveDbPath: () => "/tmp/uc-test/store.db",
  resolveLockPath: () => "/tmp/uc-test/daemon.lock",
};

function buildCfg(env = {}, cliArgs = new Set()) {
  return buildRuntimeConfig({ env, cliArgs, ...stubResolvers });
}

describe("config: normalizeApiKey", () => {
  it("strips the quotes that shell profiles and hand-edited .env files leave behind", () => {
    assert.equal(normalizeApiKey("  uc_live_abc  "), "uc_live_abc");
    assert.equal(normalizeApiKey("'uc_live_abc'"), "uc_live_abc");
    assert.equal(normalizeApiKey('"uc_live_abc"'), "uc_live_abc");
    assert.equal(normalizeApiKey(""), "");
    assert.equal(normalizeApiKey(undefined), "");
    assert.equal(normalizeApiKey(null), "");
  });

  it("only strips ONE layer, at the edges", () => {
    assert.equal(normalizeApiKey("'\"uc_live_abc\"'"), '"uc_live_abc"');
  });
});

describe("config: buildRuntimeConfig", () => {
  it("applies the documented defaults when the environment is empty", () => {
    const cfg = buildCfg({});
    assert.equal(cfg.apiKey, "");
    assert.equal(cfg.baseUrl, "https://api.ultracontext.ai");
    assert.equal(cfg.userId, "unknown-user");
    assert.equal(cfg.pollMs, 1500);
    assert.equal(cfg.logLevel, "info");
    assert.equal(cfg.verboseLogs, false);
    assert.equal(cfg.logAppends, true);            // appends are logged by default
    assert.equal(cfg.uiRefreshMs, 1200);
    assert.equal(cfg.uiRecentLimit, 240);
    assert.equal(cfg.dedupeTtlSec, 60 * 60 * 24 * 30);
    assert.equal(cfg.maxReadBytes, 4 * 1024 * 1024);
    assert.equal(cfg.bootstrapMode, "prompt");     // ask on first start
    assert.equal(cfg.bootstrapReset, false);
    assert.equal(cfg.claudeIncludeSubagents, false);
    assert.equal(cfg.cleanupEveryCycles, 20);
    assert.equal(cfg.configFile, resolveRuntimeConfigPath({}));
    assert.equal(cfg.dbFile, "/tmp/uc-test/store.db");
    assert.equal(cfg.lockFile, "/tmp/uc-test/daemon.lock");
    assert.ok(cfg.host.length > 0, "host falls back to os.hostname()");
  });

  it("reads every knob from its own env var", () => {
    const cfg = buildCfg({
      ULTRACONTEXT_API_KEY: "uc_live_x",
      ULTRACONTEXT_BASE_URL: "  http://127.0.0.1:8787  ",
      DAEMON_USER_ID: "ada",
      DAEMON_HOST: "lovelace",
      DAEMON_POLL_MS: "250",
      DAEMON_LOG_LEVEL: "debug",
      DAEMON_VERBOSE: "1",
      DAEMON_LOG_APPENDS: "false",
      TUI_REFRESH_MS: "500",
      TUI_RECENT_LIMIT: "40",
      DAEMON_DEDUPE_TTL_SEC: "60",
      DAEMON_MAX_READ_BYTES: "1024",
      DAEMON_BOOTSTRAP_MODE: "new_only",
      DAEMON_BOOTSTRAP_RESET: "true",
      CLAUDE_INCLUDE_SUBAGENTS: "yes",
      DAEMON_STORE_CLEANUP_CYCLES: "3",
    });

    assert.equal(cfg.apiKey, "uc_live_x");
    assert.equal(cfg.baseUrl, "http://127.0.0.1:8787");   // trimmed
    assert.equal(cfg.userId, "ada");
    assert.equal(cfg.host, "lovelace");
    assert.equal(cfg.pollMs, 250);
    assert.equal(cfg.logLevel, "debug");
    assert.equal(cfg.verboseLogs, true);
    assert.equal(cfg.logAppends, false);
    assert.equal(cfg.uiRefreshMs, 500);
    assert.equal(cfg.uiRecentLimit, 40);
    assert.equal(cfg.dedupeTtlSec, 60);
    assert.equal(cfg.maxReadBytes, 1024);
    assert.equal(cfg.bootstrapMode, "new_only");
    assert.equal(cfg.bootstrapReset, true);
    assert.equal(cfg.claudeIncludeSubagents, true);
    assert.equal(cfg.cleanupEveryCycles, 3);
  });

  it("--verbose on the command line is enough for verbose logs", () => {
    assert.equal(buildCfg({}, new Set(["--verbose"])).verboseLogs, true);
    assert.equal(buildCfg({}, new Set(["--other"])).verboseLogs, false);
  });

  it("falls back to $USER for the user id, and never returns a NaN knob", () => {
    assert.equal(buildCfg({ USER: "grace" }).userId, "grace");
    assert.equal(buildCfg({ DAEMON_POLL_MS: "soon" }).pollMs, 1500);
    assert.equal(buildCfg({ DAEMON_STORE_CLEANUP_CYCLES: "0" }).cleanupEveryCycles, 1);  // clamped ≥ 1
  });

  it("resolves the runtime config path from ULTRACONTEXT_CONFIG_FILE, expanded", () => {
    assert.equal(DEFAULT_RUNTIME_CONFIG_FILE, "~/.ultracontext/config.json");
    assert.equal(resolveRuntimeConfigPath({}), path.join(os.homedir(), ".ultracontext", "config.json"));
    assert.equal(
      resolveRuntimeConfigPath({ ULTRACONTEXT_CONFIG_FILE: "~/elsewhere/config.json" }),
      path.join(os.homedir(), "elsewhere", "config.json"),
    );
    assert.equal(buildCfg({ ULTRACONTEXT_CONFIG_FILE: "~/x.json" }).configFile, path.join(os.homedir(), "x.json"));
  });
});

describe("config: the prefs block", () => {
  it("serialises exactly four settings — everything else is environment-only", () => {
    const cfg = buildCfg({ DAEMON_BOOTSTRAP_MODE: "all", CLAUDE_INCLUDE_SUBAGENTS: "1" });
    assert.deepEqual(serializeConfigPrefs(cfg), {
      bootstrapMode: "all",
      claudeIncludeSubagents: true,
      captureAgents: ["claude", "codex", "cursor"],
      projectPaths: [],
    });
  });

  it("applies only the keys present, in place, and normalises them", () => {
    const cfg = buildCfg({});
    applyConfigPrefs(cfg, { bootstrapMode: "last_24h" });
    assert.equal(cfg.bootstrapMode, "last_24h");
    assert.equal(cfg.claudeIncludeSubagents, false);       // untouched

    applyConfigPrefs(cfg, { claudeIncludeSubagents: "yes" });
    assert.equal(cfg.claudeIncludeSubagents, true);        // coerced with Boolean()
    assert.equal(cfg.bootstrapMode, "last_24h");

    applyConfigPrefs(cfg, { captureAgents: "codex, bogus" });
    assert.deepEqual(cfg.captureAgents, ["codex"]);

    // NOTE: project paths are `path.resolve`d, NOT `expandHome`d — a literal
    // "~" resolves against the cwd. The wizard always writes absolute paths, so
    // this is latent rather than live; the assertion pins the current contract
    // (dedupe + resolve) rather than blessing the quirk.
    const projectDir = path.join(os.homedir(), "projects");
    applyConfigPrefs(cfg, { projectPaths: `${projectDir}/a, ${projectDir}/a\n${projectDir}/b` });
    assert.deepEqual(cfg.projectPaths, [path.join(projectDir, "a"), path.join(projectDir, "b")]);

    applyConfigPrefs(cfg, null);                           // no-op, no throw
    applyConfigPrefs(cfg, "nonsense");
    assert.equal(cfg.bootstrapMode, "last_24h");
  });

  it("an unrecognised bootstrap mode falls back to 'prompt'", () => {
    assert.equal(normalizeBootstrapModeWithPrompt("whenever"), "");
    const cfg = buildCfg({});
    applyConfigPrefs(cfg, { bootstrapMode: "whenever" });
    assert.equal(cfg.bootstrapMode, "prompt");
    assert.equal(normalizeBootstrapModeWithPrompt("prompt"), "prompt");
  });

  it("round-trips through a file, keeping keys the daemon does not own", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-cfg-"));
    const file = path.join(dir, "nested", "config.json");
    const cfg = buildCfg({ ULTRACONTEXT_CONFIG_FILE: file });
    const logged = [];
    const prefs = createConfigPrefs({
      cfg,
      log: (level, message, data) => logged.push({ level, message, data }),
      errorDetails: (error) => ({ message: String(error?.message ?? error) }),
    });

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ apiKey: "uc_live_secret", custom: 1 }, null, 2), "utf8");

    const loaded = await prefs.loadFromFile();
    assert.deepEqual(
      { loaded: loaded.loaded, source: loaded.source, file: loaded.file },
      { loaded: true, source: "primary", file },
    );

    cfg.bootstrapMode = "new_only";
    cfg.claudeIncludeSubagents = true;
    const saved = await prefs.persistToFile();
    assert.deepEqual(saved, { saved: true, file });

    const onDisk = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(onDisk.apiKey, "uc_live_secret");          // foreign keys survive
    assert.equal(onDisk.custom, 1);
    assert.equal(onDisk.bootstrapMode, "new_only");
    assert.equal(onDisk.claudeIncludeSubagents, true);

    // SEC-004: the config can hold a raw API key
    const mode = fsSync.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(fsSync.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["config.json"]);   // no .tmp.cfg left behind

    // and reloading applies what was written
    const cfg2 = buildCfg({ ULTRACONTEXT_CONFIG_FILE: file });
    const prefs2 = createConfigPrefs({ cfg: cfg2, log: () => {}, errorDetails: () => ({}) });
    await prefs2.loadFromFile();
    assert.equal(cfg2.bootstrapMode, "new_only");
    assert.equal(cfg2.claudeIncludeSubagents, true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a missing file is normal (first boot), a broken one is a warning", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-cfg-"));
    const logged = [];
    const mk = (file) => createConfigPrefs({
      cfg: buildCfg({ ULTRACONTEXT_CONFIG_FILE: file }),
      log: (level, message, data) => logged.push({ level, message, data }),
      errorDetails: (error) => ({ message: String(error?.message ?? error) }),
    });

    const missing = await mk(path.join(dir, "nope.json")).loadFromFile();
    assert.deepEqual({ loaded: missing.loaded, source: missing.source, file: missing.file }, { loaded: false, source: "none", file: "" });
    assert.deepEqual(logged, []);                            // silence: not an error

    const broken = path.join(dir, "broken.json");
    await fs.writeFile(broken, "{not json", "utf8");
    const result = await mk(broken).loadFromFile();
    assert.equal(result.loaded, false);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].level, "warn");
    assert.equal(logged[0].message, "Failed to parse config prefs file");
    assert.equal(logged[0].data.file, broken);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("an unreadable target warns with the error details, and reports missing=false", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-cfg-"));
    const logged = [];
    const prefs = createConfigPrefs({
      cfg: buildCfg({}),
      log: (level, message, data) => logged.push({ level, message, data }),
      errorDetails: (error) => ({ message: String(error?.message ?? error) }),
    });
    // a DIRECTORY where the config should be → EISDIR, i.e. "not missing, just
    // broken": only ENOENT is treated as the normal first-boot case
    await fs.mkdir(path.join(dir, "config.json"));
    const result = await prefs.loadFromPath(path.join(dir, "config.json"));
    assert.equal(result.loaded, false);
    assert.equal(result.missing, false);
    assert.equal(logged.length, 1);
    assert.equal(logged[0].message, "Failed to read config prefs file");
    assert.equal(logged[0].data.file, path.join(dir, "config.json"));
    assert.ok(logged[0].data.message.length > 0);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("config: bootstrap vocabulary", () => {
  it("labels every option id, and echoes an unknown one", () => {
    assert.deepEqual(BOOTSTRAP_OPTIONS.map((o) => o.id), ["new_only", "last_24h", "all", "prompt"]);
    assert.equal(bootstrapModeLabel("new_only"), "New only (recommended)");
    assert.equal(bootstrapModeLabel("last_24h"), "Last 24h");
    assert.equal(bootstrapModeLabel("all"), "All");
    assert.equal(bootstrapModeLabel("prompt"), "Ask on startup");
    assert.equal(bootstrapModeLabel("mystery"), "mystery");
  });

  it("scopes the persisted decision to host + user + source set", () => {
    const cfg = { host: "h1", userId: "u1" };
    const key = bootstrapStateStoreKey({ cfg, sources: [{ name: "codex" }, { name: "claude" }] });
    assert.ok(key.length > 0);
    assert.equal(key, bootstrapStateStoreKey({ cfg, sources: [{ name: "codex" }, { name: "claude" }] }));

    // a different machine, user or harness selection must NOT inherit the answer
    assert.notEqual(key, bootstrapStateStoreKey({ cfg: { ...cfg, host: "h2" }, sources: [{ name: "codex" }, { name: "claude" }] }));
    assert.notEqual(key, bootstrapStateStoreKey({ cfg: { ...cfg, userId: "u2" }, sources: [{ name: "codex" }, { name: "claude" }] }));
    assert.notEqual(key, bootstrapStateStoreKey({ cfg, sources: [{ name: "codex" }] }));
    // names are sorted before hashing, so a re-ordered source list keeps the
    // same persisted decision across a restart
    assert.equal(key, bootstrapStateStoreKey({ cfg, sources: [{ name: "claude" }, { name: "codex" }] }));
  });
});

describe("config: validateConfig", () => {
  it("throws with the self-host-first message when there is no key", () => {
    assert.throws(
      () => validateConfig(buildCfg({})),
      (error) => {
        assert.match(error.message, /^Missing ULTRACONTEXT_API_KEY\./);
        assert.match(error.message, /ultracontext serve/);   // the free, local path is offered first
        assert.match(error.message, /ultracontext config/);
        return true;
      },
    );
  });

  it("warns (but does not refuse) for a key that does not look like an UltraContext key", () => {
    const gate = validateConfig(buildCfg({ ULTRACONTEXT_API_KEY: "sk-something-else" }));
    assert.equal(gate.warn.message, "ULTRACONTEXT_API_KEY format looks unusual");
    assert.deepEqual(gate.warn.data, { key_prefix: "sk-somet", key_len: "sk-something-else".length });
    assert.ok(!JSON.stringify(gate.warn.data).includes("sk-something-else"));   // prefix + length only
  });

  it("says nothing about a well-formed key, and never logs the key itself", () => {
    for (const key of ["uc_live_abcdef", "uc_test_abcdef"]) {
      const gate = validateConfig(buildCfg({ ULTRACONTEXT_API_KEY: key }));
      assert.equal(gate.warn, null);
    }
    const gate = validateConfig(buildCfg({ ULTRACONTEXT_API_KEY: "uc_live_SUPERSECRETVALUE" }));
    assert.equal(gate.warn, null);
    assert.ok(!JSON.stringify(gate).includes("SUPERSECRET"));
  });
});
