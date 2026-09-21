// =============================================================================
// ARCH-003 — sources.mjs: harness discovery, extracted from daemon.mjs.
//
// This is the "which files does the daemon watch" contract: the INGEST_* kill
// switches, the onboarding captureAgents gate (primary agents only), the
// per-harness globs and their env overrides, and project-path discovery with
// its LRU cache. Getting any of it wrong silently stops capturing somebody's
// transcripts, which is the one failure mode users cannot diagnose from a log.
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  parseAgyLine, parseClaudeCodeLine, parseCodexLine, parseCursorLine, parseFreebuffFile,
  parseGeminiFile, parseGstackLine, parseOpenClawLine, parseOpencodeFile,
} from "@ultracontext/parsers";

import {
  PROJECT_PATH_CACHE_LIMIT,
  buildSources,
  createProjectPathResolver,
  discoverProjectPathFromFileHead,
  extractProjectPathFromNormalized,
  listSourceFiles,
} from "../src/sources.mjs";

const ALL_AGENTS = ["claude", "codex", "cursor"];

function cfg(overrides = {}) {
  return { captureAgents: ALL_AGENTS, claudeIncludeSubagents: false, ...overrides };
}

function names(sources) {
  return sources.map((source) => source.name);
}

describe("sources: buildSources", () => {
  it("enables every harness by default, in the documented order", () => {
    assert.deepEqual(names(buildSources({ cfg: cfg(), env: {} })), [
      "codex", "claude", "openclaw", "cursor", "gemini", "gstack", "opencode", "agy", "freebuff",
    ]);
  });

  it("wires the right parser to the right harness — parseLine for JSONL, parseFile for whole-file formats", () => {
    const sources = buildSources({ cfg: cfg(), env: {} });
    const byName = Object.fromEntries(sources.map((source) => [source.name, source]));

    assert.equal(byName.codex.parseLine, parseCodexLine);
    assert.equal(byName.claude.parseLine, parseClaudeCodeLine);
    assert.equal(byName.openclaw.parseLine, parseOpenClawLine);
    assert.equal(byName.cursor.parseLine, parseCursorLine);
    assert.equal(byName.gstack.parseLine, parseGstackLine);
    assert.equal(byName.agy.parseLine, parseAgyLine);

    assert.equal(byName.gemini.parseFile, parseGeminiFile);
    assert.equal(byName.opencode.parseFile, parseOpencodeFile);
    assert.equal(byName.freebuff.parseFile, parseFreebuffFile);
    assert.equal(byName.gemini.parseLine, undefined);

    // only the opencode SQLite DB is read as bytes
    assert.equal(byName.opencode.readBinary, true);
    assert.equal(byName.gemini.readBinary, undefined);
  });

  it("honours the INGEST_* kill switches (accepting the usual boolean spellings)", () => {
    for (const off of ["0", "false", "no", "off"]) {
      const sources = buildSources({ cfg: cfg(), env: { INGEST_CODEX: off, INGEST_CLAUDE: off } });
      assert.ok(!names(sources).includes("codex"), `codex still on for ${off}`);
      assert.ok(!names(sources).includes("claude"), `claude still on for ${off}`);
      assert.ok(names(sources).includes("gemini"), "unrelated harness was disabled");
    }
    // anything unrecognised falls back to the default (on)
    assert.ok(names(buildSources({ cfg: cfg(), env: { INGEST_CODEX: "maybe" } })).includes("codex"));
  });

  it("applies captureAgents ONLY to the primary agents (claude/codex/cursor)", () => {
    const sources = buildSources({ cfg: cfg({ captureAgents: ["claude"] }), env: {} });
    const list = names(sources);
    assert.ok(list.includes("claude"));
    assert.ok(!list.includes("codex"));
    assert.ok(!list.includes("cursor"));
    // non-primary harnesses are not gated by the wizard's agent choice
    for (const expected of ["openclaw", "gemini", "gstack", "opencode", "agy", "freebuff"]) {
      assert.ok(list.includes(expected), `${expected} should not be gated by captureAgents`);
    }
  });

  it("an empty captureAgents list means 'all primary agents', not 'none'", () => {
    const sources = buildSources({ cfg: cfg({ captureAgents: [] }), env: {} });
    for (const expected of ["claude", "codex", "cursor"]) {
      assert.ok(names(sources).includes(expected));
    }
  });

  it("excludes claude subagent transcripts unless the user asked for them", () => {
    const off = buildSources({ cfg: cfg({ claudeIncludeSubagents: false }), env: {} }).find((s) => s.name === "claude");
    const on = buildSources({ cfg: cfg({ claudeIncludeSubagents: true }), env: {} }).find((s) => s.name === "claude");
    assert.deepEqual(off.ignoreGlobs, ["**/subagents/**"]);
    assert.deepEqual(on.ignoreGlobs, []);
  });

  it("expands ~ and honours the per-harness glob overrides", () => {
    const home = os.homedir();
    const sources = buildSources({
      cfg: cfg(),
      env: {
        CODEX_GLOB: "~/tmp/codex/**/*.jsonl",
        CLAUDE_GLOB: "~/tmp/claude/**/*.jsonl",
        GEMINI_GLOB: "~/tmp/gemini/session-*.json",
      },
    });
    const byName = Object.fromEntries(sources.map((source) => [source.name, source]));
    assert.deepEqual(byName.codex.globs, [path.join(home, "tmp/codex/**/*.jsonl")]);
    assert.deepEqual(byName.claude.globs, [path.join(home, "tmp/claude/**/*.jsonl")]);
    assert.deepEqual(byName.gemini.globs, [path.join(home, "tmp/gemini/session-*.json")]);
  });

  it("defaults each harness to its real on-disk location", () => {
    const home = os.homedir();
    const byName = Object.fromEntries(buildSources({ cfg: cfg(), env: {} }).map((s) => [s.name, s]));
    assert.deepEqual(byName.codex.globs, [path.join(home, ".codex/sessions/**/*.jsonl")]);
    assert.deepEqual(byName.claude.globs, [path.join(home, ".claude/projects/**/*.jsonl")]);
    assert.deepEqual(byName.openclaw.globs, [path.join(home, ".openclaw/agents/*/sessions/**/*.jsonl")]);
    assert.deepEqual(byName.cursor.globs, [path.join(home, ".cursor/projects/**/*.jsonl")]);
    assert.deepEqual(byName.gstack.globs, [path.join(home, ".gstack/projects/**/*.jsonl")]);
    assert.equal(byName.agy.globs.length, 2);               // antigravity-cli (full) + antigravity (IDE)
    assert.ok(byName.agy.globs[0].includes("antigravity-cli"));
    assert.ok(byName.agy.globs[1].includes("antigravity/brain"));
  });

  it("opencode covers the SQLite DB plus both pre-1.2 JSON layouts, for every configured data dir", () => {
    const single = buildSources({ cfg: cfg(), env: { OPENCODE_DATA_DIR: "/data/oc" } })
      .find((s) => s.name === "opencode");
    assert.deepEqual(single.globs, [
      "/data/oc/opencode*.db",
      "/data/oc/storage/message/*/*.json",
      "/data/oc/storage/session/message/*/*.json",
    ]);

    const multi = buildSources({ cfg: cfg(), env: { OPENCODE_DATA_DIR: "/a, /b " } })
      .find((s) => s.name === "opencode");
    assert.equal(multi.globs.length, 6);
    assert.ok(multi.globs.includes("/b/opencode*.db"));      // whitespace trimmed

    const xdg = buildSources({ cfg: cfg(), env: { XDG_DATA_HOME: "/xdg" } }).find((s) => s.name === "opencode");
    assert.ok(xdg.globs[0].startsWith("/xdg/opencode/"));
  });

  it("returns an empty list when everything is switched off — daemonMain turns that into a clear error", () => {
    const env = Object.fromEntries(
      ["CODEX", "CLAUDE", "OPENCLAW", "CURSOR", "GEMINI", "GSTACK", "OPENCODE", "AGY", "FREEBUFF"]
        .map((name) => [`INGEST_${name}`, "0"]),
    );
    assert.deepEqual(buildSources({ cfg: cfg(), env }), []);
  });
});

describe("sources: listSourceFiles", () => {
  it("returns absolute, unique, file-only matches and applies ignoreGlobs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    await fs.mkdir(path.join(dir, "subagents"), { recursive: true });
    await fs.mkdir(path.join(dir, "empty"), { recursive: true });
    await fs.writeFile(path.join(dir, "a.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(dir, "b.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(dir, "subagents", "c.jsonl"), "{}\n", "utf8");
    await fs.symlink(path.join(dir, "a.jsonl"), path.join(dir, "link.jsonl"));

    const all = await listSourceFiles({ globs: [`${dir}/**/*.jsonl`] });
    // followSymbolicLinks: false means a symlinked transcript is NOT picked up
    // (and cannot be double-ingested through two paths). That is the shipped
    // behaviour, pinned here because it is easy to "fix" by accident.
    assert.equal(all.length, 3);
    assert.ok(!all.some((file) => file.endsWith("link.jsonl")));
    assert.ok(all.every((file) => path.isAbsolute(file)));
    assert.equal(new Set(all).size, all.length);            // unique

    const filtered = await listSourceFiles({ globs: [`${dir}/**/*.jsonl`], ignoreGlobs: ["**/subagents/**"] });
    assert.ok(!filtered.some((file) => file.includes("subagents")));
    assert.equal(filtered.length, 2);

    // a glob that matches nothing (or a directory that does not exist) is not an error
    assert.deepEqual(await listSourceFiles({ globs: [`${dir}/nothing/**/*.jsonl`] }), []);
    assert.deepEqual(await listSourceFiles({ globs: ["/definitely/not/here/**/*.jsonl"] }), []);

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("sources: project-path discovery", () => {
  it("reads cwd from the shapes the parsers actually emit, in priority order", () => {
    assert.equal(extractProjectPathFromNormalized({ raw: { payload: { cwd: "/a/one" } } }), "/a/one");
    assert.equal(extractProjectPathFromNormalized({ raw: { cwd: "/a/two" } }), "/a/two");
    assert.equal(extractProjectPathFromNormalized({ raw: { directory: "/a/three" } }), "/a/three");
    // payload.cwd wins over a sibling cwd on the same record
    assert.equal(
      extractProjectPathFromNormalized({ raw: { payload: { cwd: "/win" }, cwd: "/lose" } }),
      "/win",
    );
    assert.equal(extractProjectPathFromNormalized({ raw: {} }), "");
    assert.equal(extractProjectPathFromNormalized(null), "");
    assert.equal(extractProjectPathFromNormalized({ raw: { cwd: "   " } }), "");
  });

  it("resolves a relative cwd against the process cwd", () => {
    const found = extractProjectPathFromNormalized({ raw: { cwd: "relative/dir" } });
    assert.equal(found, path.resolve("relative/dir"));
  });

  it("prefers the transcript path (claude/cursor encode the project in it) over reading the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    const file = path.join(dir, ".claude", "projects", "-tmp-uc-demo", "session.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}\n", "utf8");

    let parsed = 0;
    const found = await discoverProjectPathFromFileHead(
      { name: "claude", parseLine: () => { parsed += 1; return null; } },
      file,
    );
    assert.equal(found, path.resolve("/tmp/uc/demo"));
    assert.equal(parsed, 0);                                // never opened the file

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("scans the head of a JSONL transcript and stops at the first cwd", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    const file = path.join(dir, "session.jsonl");            // codex-style: the path says nothing
    const lines = [
      JSON.stringify({ type: "noise" }),
      "",
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/found" } }),
      JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/later" } }),
    ];
    await fs.writeFile(file, `${lines.join("\n")}\n`, "utf8");

    const source = {
      name: "codex",
      parseLine: ({ line }) => { try { return { raw: JSON.parse(line) }; } catch { return null; } },
    };
    assert.equal(await discoverProjectPathFromFileHead(source, file), "/repo/found");

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("gives up after 32 lines — a head scan must never walk a 100k-line transcript", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    const file = path.join(dir, "deep.jsonl");
    const filler = Array.from({ length: 40 }, () => JSON.stringify({ type: "noise" }));
    filler[38] = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo/too-deep" } });
    await fs.writeFile(file, `${filler.join("\n")}\n`, "utf8");

    let scanned = 0;
    const source = {
      name: "codex",
      parseLine: ({ line }) => {
        scanned += 1;
        try { return { raw: JSON.parse(line) }; } catch { return null; }
      },
    };
    assert.equal(await discoverProjectPathFromFileHead(source, file), "");
    assert.ok(scanned <= 33, `scanned ${scanned} lines, expected at most 33`);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("returns '' for whole-file sources, unreadable files and transcripts with no cwd", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    const file = path.join(dir, "s.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ type: "noise" })}\n`, "utf8");

    // parseFile-only sources (gemini/opencode) have no parseLine to scan with
    assert.equal(await discoverProjectPathFromFileHead({ name: "gemini", parseFile: () => [] }, file), "");
    assert.equal(await discoverProjectPathFromFileHead({ name: "codex", parseLine: () => null }, path.join(dir, "missing.jsonl")), "");
    assert.equal(await discoverProjectPathFromFileHead({ name: "codex", parseLine: () => { throw new Error("bad line"); } }, file), "");

    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("sources: the project-path LRU cache", () => {
  it("caches a discovery per (source, file) and never re-reads the head", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    const file = path.join(dir, ".claude", "projects", "-tmp-cache-demo", "s.jsonl");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{}\n", "utf8");

    const cache = new Map();
    const resolver = createProjectPathResolver({ cache });
    const source = { name: "claude", parseLine: () => null };

    const first = await resolver.resolveSourceFileProjectPath({ source, filePath: file, fileId: "1:2" });
    const second = await resolver.resolveSourceFileProjectPath({ source, filePath: file, fileId: "1:2" });
    assert.equal(first, path.resolve("/tmp/cache/demo"));
    assert.equal(second, first);
    assert.equal(cache.size, 1);
    assert.equal(cache.get("claude:1:2"), first);

    // a different fileId (rotation by rewrite) is a different entry
    await resolver.resolveSourceFileProjectPath({ source, filePath: file, fileId: "1:3" });
    assert.equal(cache.size, 2);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("caches a NEGATIVE result too, so a cwd-less file is not rescanned every cycle", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "uc-src-"));
    const file = path.join(dir, "s.jsonl");
    await fs.writeFile(file, `${JSON.stringify({ type: "noise" })}\n`, "utf8");

    let scans = 0;
    const resolver = createProjectPathResolver({ cache: new Map() });
    const source = {
      name: "codex",
      parseLine: () => { scans += 1; return null; },
    };
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await resolver.resolveSourceFileProjectPath({ source, filePath: file, fileId: "9:9" }), "");
    }
    assert.equal(scans, 1);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("evicts the oldest entry past the cap, and a hit refreshes recency", () => {
    const cache = new Map();
    const resolver = createProjectPathResolver({ cache, limit: 3 });
    resolver.rememberProjectPath("a", "/a");
    resolver.rememberProjectPath("b", "/b");
    resolver.rememberProjectPath("c", "/c");
    assert.equal(cache.size, 3);

    resolver.rememberProjectPath("d", "/d");                 // evicts "a"
    assert.deepEqual([...cache.keys()], ["b", "c", "d"]);

    // touching "b" makes it the newest, so the next insert evicts "c"
    resolver.rememberProjectPath("b", "/b");
    resolver.rememberProjectPath("e", "/e");
    assert.deepEqual([...cache.keys()], ["d", "b", "e"]);
    assert.equal(PROJECT_PATH_CACHE_LIMIT, 5000);            // ~500KB of strings, per the cap's rationale
  });

  it("re-remembering an existing key replaces its value without growing the map", () => {
    const cache = new Map();
    const resolver = createProjectPathResolver({ cache, limit: 5 });
    resolver.rememberProjectPath("k", "/old");
    resolver.rememberProjectPath("k", "/new");
    assert.equal(cache.size, 1);
    assert.equal(cache.get("k"), "/new");
  });
});
