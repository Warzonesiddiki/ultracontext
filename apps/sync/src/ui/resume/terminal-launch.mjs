// === ui/resume/terminal-launch.mjs — open a terminal tab/window with a command ===
// Owns: every way the TUI hands a resume command to a real terminal — the
// AppleScript clipboard-paste flows (Warp paste-and-run/new-window, Apple
// Terminal, Ghostty, cmux), the Warp URI + launch-configurations YAML flow,
// the tmux new-window flow, and the dispatcher that picks one from the
// configured resume terminal. Extracted verbatim from tui.mjs (ARCH-005).
// The dispatcher reads the configured terminal through getResumeTerminal()
// so config-editor toggles apply to the next launch without a rebuild.

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function resumeShellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function resumeAppleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function runAppleScriptLines(scriptLines) {
  const args = [];
  for (const line of scriptLines) args.push("-e", line);
  const out = spawnSync("osascript", args, { stdio: "pipe", encoding: "utf8" });
  if (out.status !== 0) {
    return {
      ok: false,
      reason: out.stderr?.trim() || out.stdout?.trim() || "osascript failed",
    };
  }
  return { ok: true };
}

export function warpLaunchConfigDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".warp", "launch_configurations"),
    path.join(home, "Library", "Application Support", "dev.warp.Warp-Stable", "launch_configurations"),
    path.join(home, "Library", "Application Support", "dev.warp.Warp-Preview", "launch_configurations"),
  ];
}

export function warpLaunchConfigYaml({ name, cwd, command }) {
  const safeCommand = String(command ?? "").replace(/\r?\n/g, " && ");
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    "windows:",
    "  - tabs:",
    "      - title: UltraContext Resume",
    "        layout:",
    `          cwd: ${JSON.stringify(cwd)}`,
    "          commands:",
    `            - exec: ${JSON.stringify(safeCommand)}`,
    "",
  ].join("\n");
}

export function runOpenUri(uri) {
  const out = spawnSync("open", [uri], { stdio: "pipe", encoding: "utf8" });
  if (out.status !== 0) {
    return {
      ok: false,
      reason: out.stderr?.trim() || out.stdout?.trim() || "open uri failed",
    };
  }
  return { ok: true };
}

export function resumeWarpPasteAndRun(command, { openNewTab = false } = {}) {
  const scriptLines = [
    "set _uc_prev_clipboard to the clipboard",
    `set the clipboard to ${resumeAppleScriptString(command)}`,
    'tell application "Warp" to activate',
    "delay 0.85",
    'tell application "System Events"',
  ];
  if (openNewTab) {
    scriptLines.push('keystroke "t" using {command down}', "delay 0.45");
  }
  scriptLines.push(
    'keystroke "v" using {command down}',
    "delay 0.25",
    "key code 36",
    "delay 0.18",
    "key code 36",
    "end tell",
    "delay 0.05",
    "set the clipboard to _uc_prev_clipboard"
  );
  return runAppleScriptLines(scriptLines);
}

export function resumeOpenWarpNewWindowAndRun(command) {
  spawnSync("open", ["-a", "Warp"], { stdio: "ignore" });
  runAppleScriptLines(['tell application "Warp" to activate', "delay 0.12"]);

  const uri = `warp://action/new_window?path=${encodeURIComponent(process.cwd())}`;
  const opened = runOpenUri(uri);
  if (!opened.ok) return opened;

  runAppleScriptLines(['tell application "Warp" to activate', "delay 0.3"]);
  return resumeWarpPasteAndRun(command, { openNewTab: false });
}

export function resumeOpenWarpViaUri(command) {
  try {
    const timestamp = Date.now();
    const launchName = `ultracontext_resume_${timestamp}_${process.pid}`;
    const yaml = warpLaunchConfigYaml({
      name: `UltraContext Resume ${timestamp}`,
      cwd: process.cwd(),
      command,
    });

    let primaryFilePath = "";
    for (const dir of warpLaunchConfigDirs()) {
      try {
        fsSync.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, `${launchName}.yaml`);
        fsSync.writeFileSync(filePath, yaml, "utf8");
        if (!primaryFilePath) primaryFilePath = filePath;
      } catch {
        // Best effort.
      }
    }

    if (!primaryFilePath) {
      return { ok: false, reason: "could not write Warp launch configuration file" };
    }

    const uri = `warp://launch/${encodeURIComponent(primaryFilePath)}`;
    spawnSync("open", ["-a", "Warp"], { stdio: "ignore" });
    runAppleScriptLines(['tell application "Warp" to activate', "delay 0.12"]);

    const opened = runOpenUri(uri);
    if (!opened.ok) return opened;

    runAppleScriptLines(['tell application "Warp" to activate', "delay 0.12"]);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resumeOpenAppleTerminalTab(command) {
  const scriptLines = [
    'tell application "Terminal"',
    "activate",
    "if (count of windows) = 0 then",
    `  do script ${resumeAppleScriptString(command)}`,
    "else",
    `  do script ${resumeAppleScriptString(command)} in front window`,
    "end if",
    "end tell",
  ];
  const out = runAppleScriptLines(scriptLines);
  return out.ok ? { ...out, method: "terminal_applescript" } : { ...out, method: "terminal_applescript" };
}

export function resumeOpenWarpTab(command) {
  const uriLaunch = resumeOpenWarpViaUri(command);
  if (uriLaunch.ok) return { ...uriLaunch, method: "warp_uri_launch" };

  const newWindowFlow = resumeOpenWarpNewWindowAndRun(command);
  if (newWindowFlow.ok) return { ...newWindowFlow, method: "warp_new_window_paste" };

  const firstTry = resumeWarpPasteAndRun(command, { openNewTab: true });
  if (firstTry.ok) return { ...firstTry, method: "warp_new_tab_paste" };

  const fallback = resumeWarpPasteAndRun(command, { openNewTab: false });
  if (fallback.ok) return { ...fallback, method: "warp_current_tab_paste" };

  return {
    ok: false,
    method: "warp_failed",
    reason: `${newWindowFlow.reason}; ${uriLaunch.reason}; ${firstTry.reason}; fallback failed: ${fallback.reason}. Check macOS Accessibility permission for your terminal and osascript/System Events.`,
  };
}

// ghostty — activate app, open new tab, paste command, press enter
export function resumeOpenGhosttyTab(command) {
  const scriptLines = [
    "set _uc_prev_clipboard to the clipboard",
    `set the clipboard to ${resumeAppleScriptString(command)}`,
    'tell application "Ghostty" to activate',
    "delay 0.4",
    'tell application "System Events"',
    'keystroke "t" using {command down}',
    "delay 0.3",
    'keystroke "v" using {command down}',
    "delay 0.15",
    "key code 36",
    "end tell",
    "delay 0.05",
    "set the clipboard to _uc_prev_clipboard",
  ];
  const out = runAppleScriptLines(scriptLines);
  return { ...out, method: "ghostty_applescript" };
}

// cmux — Ghostty-based terminal, same AppleScript approach
export function resumeOpenCmuxTab(command) {
  const scriptLines = [
    "set _uc_prev_clipboard to the clipboard",
    `set the clipboard to ${resumeAppleScriptString(command)}`,
    'tell application "cmux" to activate',
    "delay 0.4",
    'tell application "System Events"',
    'keystroke "t" using {command down}',
    "delay 0.3",
    'keystroke "v" using {command down}',
    "delay 0.15",
    "key code 36",
    "end tell",
    "delay 0.05",
    "set the clipboard to _uc_prev_clipboard",
  ];
  const out = runAppleScriptLines(scriptLines);
  return { ...out, method: "cmux_applescript" };
}

// tmux — open new window with command
export function resumeOpenTmuxWindow(command) {
  if (!process.env.TMUX) {
    return { ok: false, reason: "not inside a tmux session" };
  }
  const out = spawnSync("tmux", ["new-window", command], {
    stdio: "pipe", encoding: "utf8", timeout: 5000,
  });
  if (out.status === 0) return { ok: true, method: "tmux" };
  return { ok: false, reason: out.stderr?.trim() || "tmux new-window failed", method: "tmux" };
}

/** Dispatcher over the configured resume terminal (cfg.resumeTerminal). */
export function createTerminalLauncher({ getResumeTerminal }) {
  function resumeOpenTerminalTab(command) {
    const resumeTerminal = getResumeTerminal();
    if (resumeTerminal === "tmux") return resumeOpenTmuxWindow(command);
    if (resumeTerminal === "cmux") return resumeOpenCmuxTab(command);
    if (process.platform !== "darwin") {
      return { ok: false, reason: "open-tab is available only on macOS" };
    }
    if (resumeTerminal === "warp") return resumeOpenWarpTab(command);
    if (resumeTerminal === "ghostty") return resumeOpenGhosttyTab(command);
    return resumeOpenAppleTerminalTab(command);
  }
  return { resumeOpenTerminalTab };
}
