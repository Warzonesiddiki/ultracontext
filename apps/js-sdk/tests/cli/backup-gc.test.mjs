import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  snapshotDatabase,
  listBackups,
  pruneOldBackups,
  restoreBackup,
  createFullArchive,
  defaultDataHome,
  mainDbPath,
} from "../../src/cli/backup.mjs";
import { parseKeepWindow, planGc, applyGc } from "../../src/cli/gc.mjs";

// same DDL as packages/storage/src/sqlite/schema.ts (local-file shape)
const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL, public_id TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL, key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL, name TEXT, last_used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT NOT NULL, project_id INTEGER NOT NULL,
  type TEXT NOT NULL, content TEXT NOT NULL DEFAULT '{}', metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, parent_id TEXT, prev_id TEXT, context_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  public_id UNINDEXED, project_id UNINDEXED, context_id UNINDEXED, body,
  tokenize = 'porter unicode61'
);
`;

function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

function makeDb(dir) {
  const dbPath = path.join(dir, "ultracontext.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(DDL);
  return { dbPath, db };
}

function seedContexts(db) {
  const now = Date.now();
  const old = isoAgo(400 * 24 * 3600 * 1000); // ~13 months ago
  const oldPlus = isoAgo(399 * 24 * 3600 * 1000);
  const recent = isoAgo(1 * 3600 * 1000); // 1h ago
  const yest = isoAgo(26 * 3600 * 1000);

  const insNode = (public_id, type, created_at, context_id, content, metadata) =>
    db.prepare(
      "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id) VALUES (?,?,?,?,'{}',?,?)",
    ).run(public_id, 1, type, JSON.stringify(content ?? {}), created_at, context_id);
  const insFts = (public_id, context_id, body) =>
    db.prepare("INSERT INTO nodes_fts (public_id, project_id, context_id, body) VALUES (?,?,1,?)").run(public_id, context_id, body);

  // ancient, fully old context
  insNode("ctx_old", "context", old, null);
  insNode("ctx_old_h1", "context", old, "ctx_old");
  insNode("msg_old1", "message", oldPlus, "ctx_old_h1", { role: "user", content: { message: "ancient quantum flux capacitor" } });
  insFts("msg_old1", "ctx_old_h1", "ancient quantum flux capacitor");

  // ancient context that was touched an hour ago — must survive retention
  insNode("ctx_active_old", "context", old, null);
  insNode("ctx_active_old_h1", "context", old, "ctx_active_old");
  insNode("msg_active1", "message", oldPlus, "ctx_active_old_h1", { role: "user", content: { message: "stale line in a live session" } });
  insFts("msg_active1", "ctx_active_old_h1", "stale line in a live session");
  insNode("msg_active2", "message", recent, "ctx_active_old_h1", { role: "user", content: { message: "fresh line in a live session" } });
  insFts("msg_active2", "ctx_active_old_h1", "fresh line in a live session");

  // fresh context
  insNode("ctx_new", "context", yest, null);
  insNode("ctx_new_h1", "context", yest, "ctx_new");
  insNode("msg_new1", "message", yest, "ctx_new_h1", { role: "user", content: { message: "modern quantum flux capacitor" } });
  insFts("msg_new1", "ctx_new_h1", "modern quantum flux capacitor");

  void now;
}

describe("backup.mjs — snapshot / list / prune / restore", () => {
  let home;
  let dir;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "uc-bk-"));
    dir = path.join(home, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const { db, dbPath } = makeDb(home);
    seedContexts(db);
    db.close();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ apiKey: "uc_test_x" }));
    fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ apiKey: "uc_live_secret" }));
    void dbPath;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("defaultDataHome honors ULTRACONTEXT_HOME", () => {
    assert.equal(defaultDataHome({ ULTRACONTEXT_HOME: "/tmp/custom", HOME: "/tmp/home" }), "/tmp/custom");
    assert.equal(defaultDataHome({ HOME: "/tmp/home" }), path.join("/tmp/home", ".ultracontext"));
  });

  it("snapshotDatabase creates a verified, complete backup", () => {
    const info = snapshotDatabase(mainDbPath(home), path.join(dir, "ultracontext-20260912T000000Z.sqlite"));
    assert.ok(fs.existsSync(info.file)); // integrity_check throws on failure
    assert.equal(info.messageNodes, 4);
    assert.equal(info.contextNodes, 6);
    assert.ok(info.sizeBytes > 0);
  });

  it("snapshot works while another connection holds the DB open (online backup)", () => {
    const holder = new DatabaseSync(mainDbPath(home), { readOnly: false });
    try {
      holder.prepare("INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('msg_live',1,'message','{}','{}',?)").run(new Date().toISOString());
      const info = snapshotDatabase(mainDbPath(home), path.join(dir, "ultracontext-live.sqlite"));
      assert.equal(info.messageNodes, 5); // includes the row written by the open connection
    } finally {
      holder.close();
    }
  });

  it("listBackups returns newest first and pruneOldBackups keeps N", () => {
    const mk = (name, ageMin) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, "x");
      const t = Date.now() - ageMin * 60 * 1000;
      fs.utimesSync(p, t / 1000, t / 1000);
    };
    mk("ultracontext-20260901T000000Z.sqlite", 300);
    mk("ultracontext-20260902T000000Z.sqlite", 200);
    mk("ultracontext-20260903T000000Z.sqlite", 100);
    mk("pre-restore-20260903T010000Z.sqlite", 50); // safety copy — never pruned

    const listed = listBackups(dir);
    assert.equal(listed.length, 3); // safety copy excluded
    assert.equal(listed[0].file, "ultracontext-20260903T000000Z.sqlite");

    const deleted = pruneOldBackups(dir, 2);
    assert.deepEqual(deleted, ["ultracontext-20260901T000000Z.sqlite"]);
    assert.ok(fs.existsSync(path.join(dir, "pre-restore-20260903T010000Z.sqlite")));
  });

  it("createFullArchive packages DB snapshots + config with 0600 perms", () => {
    const out = path.join(dir, "ultracontext-full-20260912T000000Z.tar.gz");
    const result = createFullArchive(home, out);
    assert.ok(result.sizeBytes > 0);
    assert.ok(result.files.includes("ultracontext.db.sqlite"));
    assert.ok(result.files.includes("config.json"));
    assert.ok(result.files.includes("server.json"));
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  });

  it("restoreBackup restores the live DB and keeps a safety copy", async () => {
    // 1 — snapshot the seeded state
    const backupFile = path.join(dir, "ultracontext-snap.sqlite");
    snapshotDatabase(mainDbPath(home), backupFile);

    // 2 — mutate the live DB after the snapshot
    const db = new DatabaseSync(mainDbPath(home), { readOnly: false });
    db.prepare("INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('msg_late',1,'message','{}','{}',?)").run(new Date().toISOString());
    db.close();

    // 3 — restore
    const result = await restoreBackup({ backupFile, dataHome: home });
    assert.ok(result.safetyBackup);
    assert.ok(fs.existsSync(result.safetyBackup));

    const after = new DatabaseSync(mainDbPath(home), { readOnly: true });
    const late = after.prepare("SELECT COUNT(*) c FROM nodes WHERE public_id = 'msg_late'").get().c;
    const old = after.prepare("SELECT COUNT(*) c FROM nodes WHERE public_id = 'msg_old1'").get().c;
    after.close();
    assert.equal(late, 0); // post-snapshot write rolled back
    assert.equal(old, 1); // snapshot data intact
  });

  it("restoreBackup verifies the file before touching anything", async () => {
    const bad = path.join(dir, "garbage.sqlite");
    fs.writeFileSync(bad, "not a database at all");
    await assert.rejects(() => restoreBackup({ backupFile: bad, dataHome: home }), /not a readable database/);
    // live DB untouched (3+4+3 seeded nodes)
    const db = new DatabaseSync(mainDbPath(home), { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) c FROM nodes").get().c, 10);
    db.close();
  });

  it("restoreBackup refuses while the local server is answering on the port", async () => {
    const http = await import("node:http");
    const server = http.createServer((_req, res) => res.end("[]"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const backupFile = path.join(dir, "ultracontext-snap.sqlite");
    snapshotDatabase(mainDbPath(home), backupFile);
    const origPort = process.env.PORT;
    try {
        process.env.PORT = String(server.address().port);
        await assert.rejects(() => restoreBackup({ backupFile, dataHome: home }), /local context server is running/);
        // --force overrides
        const result = await restoreBackup({ backupFile, dataHome: home, force: true });
        assert.ok(result.safetyBackup);
    } finally {
        if (origPort === undefined) delete process.env.PORT;
        else process.env.PORT = origPort;
        server.close();
    }
  });
});

describe("gc.mjs — retention", () => {
  let home;
  let dbPath;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "uc-gc-"));
    const made = makeDb(home);
    dbPath = made.dbPath;
    seedContexts(made.db);
    made.db.close();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("parseKeepWindow handles common windows", () => {
    assert.equal(parseKeepWindow("30d"), 30 * 24 * 3600 * 1000);
    assert.equal(parseKeepWindow("12h"), 12 * 3600 * 1000);
    assert.equal(parseKeepWindow("6mo"), 180 * 24 * 3600 * 1000);
    assert.equal(parseKeepWindow("1y"), 365 * 24 * 3600 * 1000);
    assert.equal(parseKeepWindow("4w"), 28 * 24 * 3600 * 1000);
    assert.throws(() => parseKeepWindow("forever"), /Invalid retention/);
    assert.throws(() => parseKeepWindow("5x"), /Invalid retention/);
  });

  it("planGc targets only sessions whose LAST activity is stale", () => {
    // 48h window: ctx_old (13 months) is stale; ctx_active_old and ctx_new
    // (touched within the last day) survive
    const plan = planGc(dbPath, { keepMs: 48 * 3600 * 1000 });
    assert.deepEqual(plan.map((p) => p.publicId), ["ctx_old"]);
    assert.equal(plan[0].messageCount, 1);
  });

  it("applyGc deletes the session's versions, messages and FTS rows", () => {
    const plan = planGc(dbPath, { keepMs: 48 * 3600 * 1000 });
    const result = applyGc(dbPath, plan.map((p) => p.publicId));
    // 2 context nodes (1 version head + the root) and 1 message
    assert.deepEqual(result, { contexts: 2, messages: 1 });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const gone = db.prepare("SELECT COUNT(*) c FROM nodes WHERE context_id = 'ctx_old' OR public_id IN ('ctx_old','ctx_old_h1','msg_old1')").get().c;
    const kept = db.prepare("SELECT COUNT(*) c FROM nodes WHERE public_id IN ('ctx_new','ctx_new_h1','msg_new1','ctx_active_old','msg_active2')").get().c;
    db.close();
    assert.equal(gone, 0);
    assert.equal(kept, 5);
  });

  it("gc keeps FTS consistent after pruning", () => {
    const plan = planGc(dbPath, { keepMs: 48 * 3600 * 1000 });
    applyGc(dbPath, plan.map((p) => p.publicId));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const ancient = db.prepare("SELECT COUNT(*) c FROM nodes_fts WHERE nodes_fts MATCH 'ancient'").get().c;
    const modern = db.prepare("SELECT COUNT(*) c FROM nodes_fts WHERE nodes_fts MATCH 'modern'").get().c;
    const fresh = db.prepare("SELECT COUNT(*) c FROM nodes_fts WHERE nodes_fts MATCH 'fresh'").get().c;
    db.close();
    assert.equal(ancient, 0);
    assert.equal(modern, 1);
    assert.equal(fresh, 1);
  });

  it("applyGc with no ids is a no-op", () => {
    assert.deepEqual(applyGc(dbPath, []), { contexts: 0, messages: 0 });
  });
});
