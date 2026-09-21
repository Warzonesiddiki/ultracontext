// === ui/resume/plans.mjs — cross-agent resume plans ===
// Owns: resolving where a resumed session should run (the recorded session
// cwd when it still exists on disk, else process.cwd) and building the
// concrete resume command + adapter outcome for each target agent — writing
// a local transcript first (via the parsers' session writers) when the
// original session file is gone, so `--resume` works on a fresh machine.
// Extracted verbatim from tui.mjs (ARCH-005).

import fs from "node:fs/promises";
import process from "node:process";

import {
  hasLocalClaudeSession,
  hasLocalCodexSession,
  writeClaudeSession,
  writeCodexSession,
} from "@ultracontext/parsers";

import { resumeShellQuote } from "./terminal-launch.mjs";

export async function resumeResolveWorkingDirectory(preferredCwd) {
  if (!preferredCwd) return process.cwd();
  try {
    const stat = await fs.stat(preferredCwd);
    if (stat.isDirectory()) return preferredCwd;
  } catch {
    // Fall back to current directory.
  }
  return process.cwd();
}

export async function buildCodexResumePlan({ sessionId, runCwd, messages }) {
  const originalSessionId = String(sessionId ?? "").trim();
  let canResumeBySessionId = originalSessionId ? await hasLocalCodexSession(originalSessionId) : false;
  let restoredPath = "";
  let restoredError = "";

  if (!canResumeBySessionId && originalSessionId) {
    const restored = await writeCodexSession({
      sessionId: originalSessionId,
      cwd: runCwd,
      messages,
    });
    canResumeBySessionId = await hasLocalCodexSession(originalSessionId);
    restoredPath = restored.filePath || "";
    restoredError = restored.error || "";
  }

  const command = canResumeBySessionId
    ? `codex -C ${resumeShellQuote(runCwd)} resume ${resumeShellQuote(originalSessionId)}`
    : `codex -C ${resumeShellQuote(runCwd)}`;

  return {
    targetAgent: "codex",
    sessionId: originalSessionId,
    command,
    canResumeBySessionId,
    restoredPath,
    restoredError,
  };
}

export async function buildClaudeResumePlan({ sessionId, runCwd, messages }) {
  const originalSessionId = String(sessionId ?? "").trim();
  let candidateSessionId = originalSessionId;
  let canResumeBySessionId = candidateSessionId ? await hasLocalClaudeSession(candidateSessionId, runCwd) : false;
  let restoredPath = "";
  let restoredError = "";

  if (!canResumeBySessionId || !candidateSessionId) {
    const restored = await writeClaudeSession({
      sessionId: candidateSessionId,
      cwd: runCwd,
      messages,
    });
    candidateSessionId = restored.sessionId || candidateSessionId;
    canResumeBySessionId = candidateSessionId ? await hasLocalClaudeSession(candidateSessionId, runCwd) : false;
    restoredPath = restored.filePath || "";
    restoredError = restored.error || "";
  }

  const command = canResumeBySessionId
    ? `cd ${resumeShellQuote(runCwd)} && claude --resume ${resumeShellQuote(candidateSessionId)}`
    : `cd ${resumeShellQuote(runCwd)} && claude`;

  return {
    targetAgent: "claude",
    sessionId: candidateSessionId,
    command,
    canResumeBySessionId,
    restoredPath,
    restoredError,
  };
}
