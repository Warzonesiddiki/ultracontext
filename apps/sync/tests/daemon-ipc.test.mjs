// =============================================================================
// ARCH-003 — ipc.mjs: the daemon's file-based control channel.
//
// `ultracontext status`, `ultracontext stop`, the TUI and the onboarding wizard
// have no socket to talk to: they read status.json and write config.json. That
// makes the two files a PUBLIC PROTOCOL, and this is the test that says so —
// field names, atomic writes, 0600 permissions, and the rule that a config the
// daemon does not own is preserved rather than clobbered.
//
// Every case runs against a tmpdir through the injected paths, so the suite
// never touches the developer's real ~/.ultracontext.
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { CONFIG_FILE, STATUS_FILE, buildStatusSnapshot, createIpc } from "../src/ipc.mjs";

const isPosix = process.platform !== "win32";

async function withChannel(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-ipc-"));
  try {
    return await fn(createIpc({
      statusFile: path.join(dir, "status.json"),
      configFile: path.join(dir, "config.json"),
    }), dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function daemonFixture() {
  const cfg = {
    host: "ada", userId: "ada", bootstrapMode: "new_only",
    claudeIncludeSubagents: true, captureAgents: ["claude", "codex"], projectPaths: ["/repo/a"],
  };
  const stats = {
    startedAt: Date.parse("2026-09-20T06:00:00Z"),
    cycles: 3, filesScanned: 12, linesRead: 900, parsedEvents: 800,
    appended: 750, deduped: 50, contextsCreated: 9, errors: 1,
  };
  const state = {
    recentLogs: [{ ts: "06:00:01", level: "info", source: "codex", text: "Daemon started" }],
    sourceStats: new Map([["codex", { filesScanned: 8, appended: 700, lastSessionId: "s1" }]]),
    sourceOrder: ["codex", "claude"],
  };
  const runtime = { ingestMode: "last_24h", daemonRunning: true };
  return { cfg, stats, state, runtime };
}

describe("ipc: default endpoints", () => {
  it("points at ~/.ultracontext, where the CLI reads them", () => {
    assert.equal(STATUS_FILE, path.join(os.homedir(), ".ultracontext", "status.json"));
    assert.equal(CONFIG_FILE, path.join(os.homedir(), ".ultracontext", "config.json"));
    const ipc = createIpc();
    assert.equal(ipc.statusFile, STATUS_FILE);
    assert.equal(ipc.configFile, CONFIG_FILE);
  });
});

describe("ipc: the status snapshot", () => {
  it("carries the fields `ultracontext status` and the TUI render", () => {
    const { cfg, stats, state, runtime } = daemonFixture();
    const snapshot = buildStatusSnapshot(cfg, stats, state, runtime);

    assert.equal(snapshot.pid, process.pid);
    assert.equal(snapshot.startedAt, "2026-09-20T06:00:00.000Z");
    assert.ok(Number.isNaN(Date.parse(snapshot.updatedAt)) === false);
    assert.equal(snapshot.host, "ada");
    assert.equal(snapshot.userId, "ada");
    assert.equal(snapshot.mode, "last_24h");
    assert.equal(snapshot.running, true);
    assert.deepEqual(snapshot.stats, stats);
    assert.notEqual(snapshot.stats, stats);                 // a copy: later bumps do not mutate a published snapshot
    assert.deepEqual(snapshot.config, {
      bootstrapMode: "new_only",
      claudeIncludeSubagents: true,
      captureAgents: ["claude", "codex"],
      projectPaths: ["/repo/a"],
    });
  });

  it("lists sources in sourceOrder, with an empty row for a source that never ran", () => {
    const { cfg, stats, state, runtime } = daemonFixture();
    const snapshot = buildStatusSnapshot(cfg, stats, state, runtime);
    assert.deepEqual(snapshot.sources, [
      { name: "codex", filesScanned: 8, appended: 700, lastSessionId: "s1" },
      { name: "claude" },
    ]);
  });

  it("caps recentLogs at 240 rows for external readers", () => {
    const { cfg, stats, runtime } = daemonFixture();
    const state = {
      recentLogs: Array.from({ length: 500 }, (_, i) => ({ ts: "06:00:00", level: "info", source: "", text: `e${i}` })),
      sourceStats: new Map(),
      sourceOrder: [],
    };
    const snapshot = buildStatusSnapshot(cfg, stats, state, runtime);
    assert.equal(snapshot.recentLogs.length, 240);
    assert.equal(snapshot.recentLogs.at(-1).text, "e499");   // the NEWEST 240
    assert.equal(snapshot.recentLogs[0].text, "e260");
    assert.equal(state.recentLogs.length, 500);              // the ring itself is untouched
  });

  it("writes atomically, 0600, with no tmp file left behind", async () => {
    await withChannel(async (ipc, dir) => {
      const { cfg, stats, state, runtime } = daemonFixture();
      await ipc.writeStatusJson(cfg, stats, state, runtime);

      const file = path.join(dir, "status.json");
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(parsed.pid, process.pid);
      assert.deepEqual(await fs.readdir(dir), ["status.json"]);

      if (isPosix) {
        // SEC-004: status names the user, the host and the files being watched
        assert.equal(fsSync.statSync(file).mode & 0o777, 0o600);
      }
    });
  });

  it("re-publishes every cycle without growing the file or leaving tmp files", async () => {
    await withChannel(async (ipc, dir) => {
      const fixture = daemonFixture();
      for (let cycle = 0; cycle < 3; cycle += 1) {
        fixture.stats.cycles = cycle;
        await ipc.writeStatusJson(fixture.cfg, fixture.stats, fixture.state, fixture.runtime);
      }
      const parsed = JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8"));
      assert.equal(parsed.stats.cycles, 2);
      assert.deepEqual(await fs.readdir(dir), ["status.json"]);
    });
  });
});

describe("ipc: config.json — the inbound command channel", () => {
  it("reads back what was written", async () => {
    await withChannel(async (ipc) => {
      assert.equal(await ipc.readConfigJson(), null);        // missing → null, not a throw
      await ipc.writeConfigJson({ bootstrapMode: "all", bootstrapReset: true });
      assert.deepEqual(await ipc.readConfigJson(), { bootstrapMode: "all", bootstrapReset: true });
    });
  });

  it("returns null for a half-written or non-JSON config instead of crashing the cycle", async () => {
    await withChannel(async (ipc, dir) => {
      await fs.writeFile(path.join(dir, "config.json"), "{oops", "utf8");
      assert.equal(await ipc.readConfigJson(), null);
    });
  });

  it("leaves no tmp file after a write", async () => {
    await withChannel(async (ipc, dir) => {
      await ipc.writeConfigJson({ a: 1 });
      assert.deepEqual(await fs.readdir(dir), ["config.json"]);
    });
  });
});

describe("ipc: _bootstrapState inside config.json", () => {
  it("is empty-string by default and survives a set/get round trip", async () => {
    await withChannel(async (ipc) => {
      assert.equal(ipc.getBootstrapState("uc:daemon:bootstrap:v1:h:u:codex"), "");
      ipc.setBootstrapState("uc:daemon:bootstrap:v1:h:u:codex", "new_only");
      assert.equal(ipc.getBootstrapState("uc:daemon:bootstrap:v1:h:u:codex"), "new_only");
      assert.equal(ipc.getBootstrapState("some:other:key"), "");
    });
  });

  it("preserves every other key in config.json — the file is shared with the CLI", async () => {
    await withChannel(async (ipc, dir) => {
      const file = path.join(dir, "config.json");
      await fs.writeFile(file, JSON.stringify({ bootstrapMode: "all", apiKey: "uc_live_x" }, null, 2), "utf8");

      ipc.setBootstrapState("k1", "last_24h");
      let data = JSON.parse(await fs.readFile(file, "utf8"));
      assert.equal(data.bootstrapMode, "all");
      assert.equal(data.apiKey, "uc_live_x");
      assert.deepEqual(data._bootstrapState, { k1: "last_24h" });

      ipc.setBootstrapState("k2", "new_only");
      data = JSON.parse(await fs.readFile(file, "utf8"));
      assert.deepEqual(data._bootstrapState, { k1: "last_24h", k2: "new_only" });

      ipc.deleteBootstrapState("k1");
      data = JSON.parse(await fs.readFile(file, "utf8"));
      assert.deepEqual(data._bootstrapState, { k2: "new_only" });
      assert.equal(data.apiKey, "uc_live_x");
      assert.deepEqual(await fs.readdir(dir), ["config.json"]);   // no .tmp.bs left behind
    });
  });

  it("coerces values to strings, so a boolean cannot poison the next read", async () => {
    await withChannel(async (ipc) => {
      ipc.setBootstrapState("k", true);
      assert.equal(ipc.getBootstrapState("k"), "true");
      const data = await ipc.readConfigJson();
      assert.deepEqual(data._bootstrapState, { k: "true" });   // still valid JSON, string-typed
    });
  });

  it("writes 0600 — the same file can hold the API key", async () => {
    await withChannel(async (ipc, dir) => {
      ipc.setBootstrapState("k", "all");
      if (isPosix) {
        assert.equal(fsSync.statSync(path.join(dir, "config.json")).mode & 0o777, 0o600);
      }
    });
  });

  it("deleting from a config that never bootstrapped does not invent an empty block", async () => {
    await withChannel(async (ipc, dir) => {
      const file = path.join(dir, "config.json");
      await fs.writeFile(file, JSON.stringify({ bootstrapMode: "prompt" }, null, 2), "utf8");
      ipc.deleteBootstrapState("nope");
      const data = JSON.parse(await fs.readFile(file, "utf8"));
      assert.deepEqual(data, { bootstrapMode: "prompt" });
      assert.ok(!("_bootstrapState" in data));
    });
  });

  it("treats an unreadable or absent config as 'no state' rather than throwing", async () => {
    await withChannel(async (ipc, dir) => {
      assert.equal(ipc.getBootstrapState("k"), "");            // file does not exist yet
      await fs.writeFile(path.join(dir, "config.json"), "not json", "utf8");
      assert.equal(ipc.getBootstrapState("k"), "");
      assert.doesNotThrow(() => ipc.setBootstrapState("k", "all"));   // best effort: overwrites the junk
      assert.equal(ipc.getBootstrapState("k"), "all");
    });
  });

  it("a set on an unwritable path is swallowed — the daemon must keep ingesting", async () => {
    const ipc = createIpc({ configFile: path.join(os.tmpdir(), "uc-ipc-nope", "deep", "config.json") });
    assert.doesNotThrow(() => ipc.setBootstrapState("k", "all"));
    assert.doesNotThrow(() => ipc.deleteBootstrapState("k"));
    assert.equal(ipc.getBootstrapState("k"), "");
  });
});
