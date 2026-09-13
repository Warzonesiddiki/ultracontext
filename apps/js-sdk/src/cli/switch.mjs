// CLI handler for `ultracontext switch <target>`
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";

// ANSI helpers (match entry.mjs style)
const isTTY = process.stdout.isTTY;
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const r = esc(0);
const b = esc(1);
const d = esc(2);
const green = esc("38;2;80;200;120");
const red = esc("38;2;220;80;80");
const gray = esc("38;5;245");

const VALID_TARGETS = ["codex", "claude"];

// known terminal program identifiers from TERM_PROGRAM
const TERM_GHOSTTY = "ghostty";
const TERM_ITERM2 = "iTerm.app";
const TERM_TERMINAL_APP = "Apple_Terminal";

// ms to wait after activate / Cmd+T for Ghostty to be ready to receive paste
const GHOSTTY_FOCUS_DELAY_MS = 150;
const GHOSTTY_TAB_OPEN_DELAY_MS = 300;

// parse switch-specific args from process.argv
function parseArgs() {
  const args = process.argv.slice(3);
  const opts = { target: null, last: null, session: null, noLaunch: false, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--last") {
      const val = Number(args[++i]);
      if (!val || val <= 0) throw new Error("--last requires a positive number");
      opts.last = val;
      continue;
    }

    if (arg === "--session") {
      opts.session = args[++i];
      if (!opts.session) throw new Error("--session requires a path");
      continue;
    }

    if (arg === "--no-launch") {
      opts.noLaunch = true;
      continue;
    }

    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }

    // positional: target
    if (!arg.startsWith("-") && !opts.target) {
      opts.target = arg.toLowerCase();
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!opts.target) throw new Error("Missing target. Usage: ultracontext switch <codex|claude>");
  if (!VALID_TARGETS.includes(opts.target)) {
    throw new Error(`Invalid target: ${opts.target}. Must be: ${VALID_TARGETS.join(", ")}`);
  }

  return opts;
}

// single-quote wrap + escape any embedded single quotes — safe for POSIX shells
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// escape \ and " for AppleScript double-quoted string literals
function appleScriptEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// run AppleScript via spawnSync — argv form avoids shell-layer interpolation
function runAppleScript(script) {
  const r = spawnSync("osascript", ["-e", script]);
  return r.status === 0;
}

// write a string to the macOS pasteboard via pbcopy (stdin avoids all quoting)
function writePasteboard(value) {
  const r = spawnSync("pbcopy", [], { input: value });
  return r.status === 0;
}

// Ghostty: pasteboard the command, activate Ghostty, open tab, paste, return.
// Pasteboard + Cmd+V avoids the focus-race window where typed keystrokes could
// land in the frontmost app if it's not Ghostty. Activate re-anchors focus
// explicitly before any keystroke is sent, and we tell process "ghostty" for
// every keystroke so System Events routes them to the right process.
function launchGhostty(cmd) {
  if (!writePasteboard(cmd)) return false;
  const focusSec = GHOSTTY_FOCUS_DELAY_MS / 1000;
  const tabSec = GHOSTTY_TAB_OPEN_DELAY_MS / 1000;
  const script = [
    'tell application "Ghostty" to activate',
    `delay ${focusSec}`,
    'tell application "System Events"',
    '  tell process "ghostty"',
    '    keystroke "t" using command down',
    `    delay ${tabSec}`,
    '    keystroke "v" using command down',
    '    key code 36',
    '  end tell',
    'end tell',
  ].join("\n");
  return runAppleScript(script);
}

// iTerm2: create new tab with command
function launchITerm2(cmd) {
  const script = `tell application "iTerm2" to tell current window to create tab with default profile command "${appleScriptEscape(cmd)}"`;
  return runAppleScript(script);
}

// Terminal.app: do script in new tab
function launchTerminalApp(cmd) {
  const script = `tell application "Terminal" to do script "${appleScriptEscape(cmd)}"`;
  return runAppleScript(script);
}

// dispatch table for supported terminals
const TERMINALS = [
  { match: (term) => term.toLowerCase().includes(TERM_GHOSTTY), launch: launchGhostty },
  { match: (term) => term === TERM_ITERM2, launch: launchITerm2 },
  { match: (term) => term === TERM_TERMINAL_APP, launch: launchTerminalApp },
];

// ── cross-platform terminal launch (Linux / Windows) ────────────────────────

// escape \ and " for PowerShell double-quoted string literals
function powershellQuote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// locate an executable on PATH (pure — testable without spawning)
function findOnPath(name, pathStr, sep) {
  if (!pathStr) return null;
  for (const dir of pathStr.split(sep)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* skip unreadable dirs */ }
  }
  return null;
}

// Linux terminal launchers: [binary, flag prefix]. The command is always run
// as `sh -c "cd <cwd> && <cmd>"` after the flags — each launcher's flags
// below open a new window/tab and pass the rest as the program to execute.
const LINUX_TERMINALS = [
  ["kitty", ["--type=window"]],
  ["alacritty", ["--command"]],
  ["wezterm", ["cli", "spawn"]],
  ["foot", ["-e"]],
  ["konsole", ["--new-window", "-e"]],
  ["gnome-terminal", ["--new-window"]],
  ["xfce4-terminal", ["-x"]],
  ["xterm", ["-e"]],
];

// find the first available Linux terminal. TERM_PROGRAM (set by most
// emulators) wins when it matches; otherwise probe in a fixed order.
function findLinuxTerminal(env = process.env) {
  const sep = (env.PATH ?? "").includes(";") ? ";" : ":";
  const current = (env.TERM_PROGRAM ?? "").toLowerCase();
  const ordered = [
    ...LINUX_TERMINALS.filter(([name]) => name === current),
    ...LINUX_TERMINALS.filter(([name]) => name !== current),
  ];
  for (const [name, flags] of ordered) {
    const bin = findOnPath(name, env.PATH, sep);
    if (bin) return { bin, flags };
  }
  return null;
}

function launchLinuxTerminal(cmd, cwd) {
  const terminal = findLinuxTerminal();
  if (!terminal) return false;
  const shell = process.env.SHELL || "/bin/sh";
  const wrapped = `cd ${shellQuote(cwd)} && ${cmd}`;
  try {
    const child = spawn(terminal.bin, [...terminal.flags, shell, "-c", wrapped], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => { /* launcher failed — caller prints the fallback */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// Windows: prefer Windows Terminal (`wt` — the Win11 default); fall back to a
// plain new console window via powershell.exe -NoExit.
function findWindowsTerminal(env = process.env) {
  const systemRoot = env.SystemRoot ?? "C:\\Windows";
  const pathStr = `${env.PATH ?? ""};${systemRoot}\\System32;${systemRoot}\\System32\\WindowsPowerShell\\v1.0`;
  return {
    wt: findOnPath("wt.exe", pathStr, ";"),
    powershell: findOnPath("powershell.exe", pathStr, ";"),
  };
}

function launchWindowsTerminal(cmd, cwd) {
  const { wt, powershell } = findWindowsTerminal();
  if (!powershell) return false;
  // cmd was built with POSIX shellQuote() — single-quoted strings are also
  // valid PowerShell, so it can be embedded verbatim.
  const psCmd = `Set-Location ${powershellQuote(cwd)}; ${cmd}`;
  try {
    const file = wt ?? powershell;
    const args = wt
      ? ["powershell", "-NoExit", "-Command", psCmd]
      : ["-NoExit", "-Command", psCmd];
    const child = spawn(file, args, { cwd, detached: true, stdio: "ignore" });
    child.on("error", () => { /* launcher failed — caller prints the fallback */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// open a command in a new terminal tab/window — macOS (terminal-specific
// AppleScript), Linux (new window via the detected emulator), Windows
// (Windows Terminal or a fresh console window)
function openInNewTab(cmd, cwd = process.cwd()) {
  const platform = os.platform();
  if (platform === "darwin") {
    const term = process.env.TERM_PROGRAM ?? "";
    const entry = TERMINALS.find((t) => t.match(term));
    if (!entry) return false;
    try { return entry.launch(cmd); } catch { return false; }
  }
  if (platform === "linux") return launchLinuxTerminal(cmd, cwd);
  if (platform === "win32") return launchWindowsTerminal(cmd, cwd);
  return false;
}

async function doSwitch(opts) {
  // auto-detect source (opposite of target)
  const source = opts.target === "codex" ? "claude" : "codex";

  // dynamic import — parsers is a workspace dep
  const parsers = await import("@ultracontext/parsers");

  // --dry-run: show what would carry over — parse only, write nothing,
  // launch nothing
  if (opts.dryRun) {
    const session = await parsers.readLocalSession({
      source,
      sessionPath: opts.session,
      cwd: process.cwd(),
    });
    const total = session.messages.length;
    const carried = opts.last ? Math.min(opts.last, total) : total;
    console.log(`${green}dry run${r} — nothing will be written or launched`);
    console.log(`  ${d}From:${r}        ${b}${source}${r}  ${gray}${session.filePath}${r}`);
    console.log(`  ${d}To:${r}          ${b}${opts.target}${r}`);
    console.log(`  ${d}Messages:${r}    ${gray}${carried}${r}${carried < total ? ` (of ${total}, via --last ${opts.last})` : ""}`);
    console.log(`  ${d}Working dir:${r} ${gray}${session.cwd}${r}`);
    if (opts.target === "codex") {
      console.log(`  ${d}Would run:${r}   ${gray}codex fork <new-session-id> -C ${shellQuote(session.cwd)}${r}`);
    } else {
      console.log(`  ${d}Then:${r}         ${gray}open a new Claude Code session in ${shellQuote(session.cwd)}${r}`);
    }
    return;
  }

  const result = await parsers.switchSession({
    source,
    target: opts.target,
    sessionPath: opts.session,
    cwd: process.cwd(),
    last: opts.last,
  });

  if (!result.written) {
    console.error(`${red}x${r} Switch failed: ${result.reason}`);
    process.exit(1);
  }

  // --no-launch: print JSON for scripting
  if (opts.noLaunch) {
    console.log(JSON.stringify({
      sessionId: result.sessionId,
      filePath: result.filePath,
      messageCount: result.messageCount,
    }));
    return;
  }

  // success output
  console.log(`${green}✓${r} Switched to ${b}${opts.target}${r}`);
  console.log(`  ${d}Session:${r}  ${gray}${result.sessionId}${r}`);
  console.log(`  ${d}File:${r}     ${gray}${result.filePath}${r}`);
  console.log(`  ${d}Messages:${r} ${gray}${result.messageCount}${r}`);

  // launch target agent in a new terminal tab — shell-quote cwd so spaces/metachars can't break it
  if (opts.target === "codex") {
    const cmd = `codex fork ${result.sessionId} -C ${shellQuote(result.cwd)}`;
    const launched = openInNewTab(cmd, result.cwd);
    if (!launched) {
      // print on its own line with no ANSI wrapping so copy-paste yields a clean command
      console.log(`\n  ${d}Run in your terminal:${r}`);
      console.log(`  ${cmd}`);
    }
  }

  if (opts.target === "claude") {
    console.log(`\n  Open a new Claude Code session to load this context.`);
  }
}

export async function runSwitch() {
  let opts;
  try {
    opts = parseArgs();
  } catch (err) {
    console.error(`${red}x${r} ${err.message}`);
    process.exit(1);
  }

  try {
    await doSwitch(opts);
  } catch (err) {
    console.error(`${red}x${r} ${err.message}`);
    process.exit(1);
  }
}

// exported for tests
export {
  parseArgs,
  shellQuote,
  appleScriptEscape,
  powershellQuote,
  findOnPath,
  findLinuxTerminal,
  findWindowsTerminal,
  LINUX_TERMINALS,
  openInNewTab,
  writePasteboard,
};
