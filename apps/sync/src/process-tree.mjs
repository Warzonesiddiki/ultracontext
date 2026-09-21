// === process-tree.mjs — shared daemon/TUI process-tree helpers ===
// Owns: reading a process's parent + command line via `ps`, recognising a
// `node --watch` command, and stopping the watching ancestor process.
// Extracted from verbatim copies that existed in BOTH daemon.mjs and tui.mjs
// (ARCH-005): the two copies differed only in formatting — tui.mjs had an
// extra `if (!raw) return false;` guard in isWatchCommand that is a no-op
// (`"".includes(...)` is already false), and a trailing comma in the
// readProcessInfo object literal. The daemon bodies are canonical here.

import { spawnSync } from "node:child_process";
import process from "node:process";

/** `ps` lookup of a pid's parent pid + command line; null when it cannot be read. */
export function readProcessInfo(pid) {
  try {
    const out = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      stdio: "pipe",
      encoding: "utf8",
    });
    const raw = String(out.stdout ?? "").trim();
    if (!raw) return null;
    const match = raw.match(/^(\d+)\s+(.*)$/);
    if (!match) return null;
    return { ppid: Number(match[1]), command: match[2] ?? "" };
  } catch { return null; }
}

export function isWatchCommand(command) {
  const raw = String(command ?? "").trim();
  return raw.includes("node --watch") || raw.includes(" --watch ");
}

/**
 * `ultracontext dev` runs the daemon under `node --watch`; stopping the daemon
 * alone leaves the watcher to respawn it instantly, so "stop" has to reach the
 * watching parent too. Walks up at most 10 levels and refuses to cross pid 1.
 */
export function stopWatchParentProcess() {
  let pid = Number(process.ppid);
  const seen = new Set();
  for (let depth = 0; depth < 10; depth += 1) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    if (seen.has(pid)) return false;
    seen.add(pid);
    const info = readProcessInfo(pid);
    if (!info) return false;
    if (isWatchCommand(info.command)) {
      try { process.kill(pid, "SIGTERM"); return true; } catch { return false; }
    }
    pid = Number(info.ppid);
  }
  return false;
}
