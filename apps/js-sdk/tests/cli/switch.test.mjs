import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  shellQuote,
  appleScriptEscape,
  powershellQuote,
  findOnPath,
  findLinuxTerminal,
  findWindowsTerminal,
  LINUX_TERMINALS,
  parseArgs,
} from "../../src/cli/switch.mjs";

describe("shellQuote", () => {
  it("wraps simple strings in single quotes", () => {
    assert.equal(shellQuote("hello"), "'hello'");
  });

  it("handles empty string", () => {
    assert.equal(shellQuote(""), "''");
  });

  it("escapes embedded single quote via '\\''", () => {
    assert.equal(shellQuote("O'Brien"), "'O'\\''Brien'");
  });

  it("preserves spaces and special chars literally", () => {
    assert.equal(shellQuote("my project"), "'my project'");
    assert.equal(shellQuote("/tmp/$(id)"), "'/tmp/$(id)'");
    assert.equal(shellQuote("foo;rm -rf /"), "'foo;rm -rf /'");
    assert.equal(shellQuote("`cat /etc/passwd`"), "'`cat /etc/passwd`'");
  });

  it("handles newlines safely (shell sees literal newline inside quotes)", () => {
    const quoted = shellQuote("line1\nline2");
    assert.ok(quoted.startsWith("'"));
    assert.ok(quoted.endsWith("'"));
    assert.ok(quoted.includes("\n"));
  });

  it("coerces non-string input", () => {
    assert.equal(shellQuote(42), "'42'");
    assert.equal(shellQuote(null), "'null'");
  });
});

describe("appleScriptEscape", () => {
  it("escapes backslash and double quote only", () => {
    assert.equal(appleScriptEscape('a"b\\c'), 'a\\"b\\\\c');
  });

  it("passes safe input unchanged", () => {
    assert.equal(appleScriptEscape("hello world"), "hello world");
    assert.equal(appleScriptEscape("/tmp/foo"), "/tmp/foo");
  });

  it("escapes \\ before \"  (order matters)", () => {
    // input: \"  →  expected: \\\"
    // if order were wrong, \" would double-escape to \\\\\\"
    assert.equal(appleScriptEscape('\\"'), '\\\\\\"');
  });

  it("handles empty string", () => {
    assert.equal(appleScriptEscape(""), "");
  });
});

describe("parseArgs", () => {
  let originalArgv;

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  function setArgs(...args) {
    process.argv = ["node", "u", "switch", ...args];
  }

  it("accepts target only", () => {
    setArgs("codex");
    assert.deepEqual(parseArgs(), { target: "codex", last: null, session: null, noLaunch: false, dryRun: false });
  });

  it("accepts target + --last", () => {
    setArgs("codex", "--last", "50");
    assert.deepEqual(parseArgs(), { target: "codex", last: 50, session: null, noLaunch: false, dryRun: false });
  });

  it("accepts target + --session", () => {
    setArgs("claude", "--session", "/tmp/session.jsonl");
    assert.deepEqual(parseArgs(), { target: "claude", last: null, session: "/tmp/session.jsonl", noLaunch: false, dryRun: false });
  });

  it("accepts target + --no-launch", () => {
    setArgs("codex", "--no-launch");
    assert.deepEqual(parseArgs(), { target: "codex", last: null, session: null, noLaunch: true, dryRun: false });
  });

  it("lowercases target", () => {
    setArgs("CODEX");
    assert.equal(parseArgs().target, "codex");
  });

  it("throws on missing target", () => {
    setArgs();
    assert.throws(parseArgs, /Missing target/);
  });

  it("throws on invalid target", () => {
    setArgs("gemini");
    assert.throws(parseArgs, /Invalid target/);
  });

  it("throws on --last non-positive", () => {
    setArgs("codex", "--last", "0");
    assert.throws(parseArgs, /positive number/);
  });

  it("throws on --last negative", () => {
    setArgs("codex", "--last", "-5");
    assert.throws(parseArgs, /positive number/);
  });

  it("throws on --last non-numeric", () => {
    setArgs("codex", "--last", "abc");
    assert.throws(parseArgs, /positive number/);
  });

  it("throws on --session missing value", () => {
    setArgs("codex", "--session");
    assert.throws(parseArgs, /--session requires/);
  });

  it("throws on unknown flag", () => {
    setArgs("codex", "--wrong");
    assert.throws(parseArgs, /Unknown argument/);
  });
});

describe("powershellQuote", () => {
  it("wraps in double quotes", () => {
    assert.equal(powershellQuote("C:\\my dir"), '"C:\\my dir"');
  });

  it("doubles embedded double quotes", () => {
    assert.equal(powershellQuote('a"b'), '"a""b"');
  });

  it("leaves backslashes untouched (not an escape char in PS double quotes)", () => {
    assert.equal(powershellQuote("C:\\Users\\me"), '"C:\\Users\\me"');
  });

  it("handles empty string", () => {
    assert.equal(powershellQuote(""), '""');
  });
});

describe("findOnPath", () => {
  it("finds an existing file in a PATH dir", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-switch-path-"));
    try {
      const target = path.join(dir, "kitty");
      fs.writeFileSync(target, "#!/bin/sh\n");
      assert.equal(findOnPath("kitty", dir, ":"), target);
      assert.equal(findOnPath("nope", dir, ":"), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches multiple PATH dirs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-switch-path-"));
    try {
      const target = path.join(dir, "foot");
      fs.writeFileSync(target, "#!/bin/sh\n");
      assert.equal(findOnPath("foot", `/nonexistent:${dir}`, ":"), target);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findLinuxTerminal", () => {
  function makeEnvWithBins(names, termProgram) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-switch-term-"));
    for (const name of names) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n");
    return { dir, env: { PATH: dir, TERM_PROGRAM: termProgram } };
  }

  it("returns null when no known terminal is on PATH", () => {
    const env = { PATH: "/nonexistent", TERM_PROGRAM: "" };
    assert.equal(findLinuxTerminal(env), null);
  });

  it("finds a terminal that exists on PATH", () => {
    const { dir, env } = makeEnvWithBins(["gnome-terminal"], "");
    try {
      const found = findLinuxTerminal(env);
      assert.equal(found.bin, path.join(dir, "gnome-terminal"));
      assert.deepEqual(found.flags, ["--new-window"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers the current TERM_PROGRAM over probe order", () => {
    // kitty is first in probe order; xterm is "last". Running under xterm
    // must make xterm win even though kitty is also installed.
    const { dir, env } = makeEnvWithBins(["kitty", "xterm"], "xterm");
    try {
      const found = findLinuxTerminal(env);
      assert.equal(path.basename(found.bin), "xterm");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to probe order when TERM_PROGRAM is unknown", () => {
    const { dir, env } = makeEnvWithBins(["kitty", "xterm"], "some-unknown-term");
    try {
      const found = findLinuxTerminal(env);
      assert.equal(path.basename(found.bin), "kitty");
      assert.deepEqual(found.flags, ["--type=window"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("knows a flag prefix for every listed terminal", () => {
    for (const [name, flags] of LINUX_TERMINALS) {
      assert.ok(flags.length >= 1, `${name} needs at least one flag`);
    }
  });
});

describe("findWindowsTerminal", () => {
  it("finds wt.exe and powershell.exe via PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-switch-win-"));
    try {
      fs.writeFileSync(path.join(dir, "wt.exe"), "");
      fs.writeFileSync(path.join(dir, "powershell.exe"), "");
      const found = findWindowsTerminal({ PATH: dir, SystemRoot: "C:\\Windows" });
      assert.equal(path.basename(found.wt), "wt.exe");
      assert.equal(path.basename(found.powershell), "powershell.exe");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the SystemRoot PowerShell when wt is absent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uc-switch-win-"));
    try {
      fs.writeFileSync(path.join(dir, "powershell.exe"), "");
      const found = findWindowsTerminal({ PATH: dir, SystemRoot: "C:\\Windows" });
      assert.equal(found.wt, null);
      assert.ok(found.powershell);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parseArgs — --dry-run", () => {
  let originalArgv;
  beforeEach(() => { originalArgv = process.argv; });
  afterEach(() => { process.argv = originalArgv; });

  it("accepts --dry-run", () => {
    process.argv = ["node", "u", "switch", "codex", "--dry-run"];
    assert.deepEqual(parseArgs(), { target: "codex", last: null, session: null, noLaunch: false, dryRun: true });
  });

  it("combines --dry-run with --last", () => {
    process.argv = ["node", "u", "switch", "codex", "--last", "10", "--dry-run"];
    const opts = parseArgs();
    assert.equal(opts.dryRun, true);
    assert.equal(opts.last, 10);
  });
});

describe("dry-run (end-to-end via the CLI)", () => {
  let tmp;
  let fakeHome;
  let projDir;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uc-switch-e2e-"));
    fakeHome = path.join(tmp, "home");
    projDir = path.join(fakeHome, ".claude", "projects", "demo-proj");
    fs.mkdirSync(projDir, { recursive: true });
    // realistic Claude Code JSONL lines
    const lines = [
      JSON.stringify({
        parentUuid: null, isSidechain: false, cwd: tmp,
        sessionId: "sess-e2e", version: "1", type: "user",
        message: { role: "user", content: "first" },
        timestamp: "2026-04-01T10:00:00.000Z",
      }),
      JSON.stringify({
        parentUuid: "1", isSidechain: false, cwd: tmp,
        sessionId: "sess-e2e", version: "1", type: "assistant",
        message: { role: "assistant", content: "second" },
        timestamp: "2026-04-01T10:00:05.000Z",
      }),
    ];
    fs.writeFileSync(path.join(projDir, "sess-e2e.jsonl"), lines.join("\n") + "\n");
  });

  function sessionArg() {
    return ["--session", path.join(projDir, "sess-e2e.jsonl")];
  }

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runCli(args) {
    const cli = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..", "..", "ultracontext.mjs"
    );
    return spawnSync(process.execPath, [cli, "switch", ...args], {
      cwd: tmp,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, NO_COLOR: "1" },
      encoding: "utf8",
    });
  }

  it("shows what would carry over and writes nothing", () => {
    const filesBefore = fs.readdirSync(projDir);
    const r = runCli(["codex", "--dry-run", ...sessionArg()]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run/);
    assert.match(r.stdout, /nothing will be written or launched/);
    assert.match(r.stdout, /Messages:\s+2/);
    assert.match(r.stdout, /sess-e2e/);
    assert.match(r.stdout, /Would run:.*codex fork/);
    // nothing written
    assert.deepEqual(fs.readdirSync(projDir), filesBefore);
    // no ~/.codex output created either
    assert.ok(!fs.existsSync(path.join(fakeHome, ".codex")));
  });

  it("reports --last capping in the preview", () => {
    const r = runCli(["codex", "--dry-run", "--last", "1", ...sessionArg()]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Messages:\s+1 \(of 2, via --last 1\)/);
  });
});
