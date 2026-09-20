// =============================================================================
// SOURCES — harness discovery (extracted from daemon.mjs, ARCH-003)
// =============================================================================
//
// A "source" is one agent harness: a name, the glob(s) where it keeps its
// transcripts, the parser that understands them, and whether the user enabled
// it. This module owns the whole question of "what is out there to watch":
//
//   * `buildSources`                  — env/cfg → the source list, rebuilt when
//                                       the capture-agents or subagent prefs
//                                       change at runtime
//   * `listSourceFiles`               — glob → absolute file paths for one cycle
//   * project-path discovery          — which project a transcript belongs to,
//                                       from the file path or from the first
//                                       lines of the file, behind an LRU cache
//
// Parsing itself lives in @ultracontext/parsers (ingest-only, no network); this
// module only decides WHICH parser sees WHICH file.
//
// Nothing here is stateful except the injected project-path cache, so
// `buildSources({ cfg, env })` is directly testable against an env matrix.

import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import fg from "fast-glob";
import {
  parseClaudeCodeLine, parseCodexLine, parseGstackLine, parseOpenClawLine,
  parseCursorLine, parseGeminiFile, parseOpencodeFile, parseAgyLine,
  parseFreebuffFile,
} from "@ultracontext/parsers";

import { boolFromEnv, expandHome, extractProjectPathFromFile } from "./utils.mjs";
import { isPrimaryAgentSourceEnabled } from "./onboarding-preferences.mjs";

/**
 * LRU cap on the project-path cache — bounds memory for long-lived daemons
 * with many rotated session files. 5k entries is ~500KB of strings.
 */
export const PROJECT_PATH_CACHE_LIMIT = 5000;

/**
 * Build the watch list from `INGEST_*` toggles and the onboarding prefs.
 *
 * Two different gates, both required:
 *   * `INGEST_<HARNESS>` (default true)  — an install-level kill switch
 *   * `captureAgents`                    — the user's onboarding answer, which
 *     only applies to the PRIMARY agent harnesses (codex/claude/cursor); the
 *     rest are always captured when their toggle is on
 */
export function buildSources({ cfg, env = process.env } = {}) {
  const codexGlob = expandHome(env.CODEX_GLOB ?? "~/.codex/sessions/**/*.jsonl");
  const claudeGlob = expandHome(env.CLAUDE_GLOB ?? "~/.claude/projects/**/*.jsonl");
  const openclawGlob = expandHome(env.OPENCLAW_GLOB ?? "~/.openclaw/agents/*/sessions/**/*.jsonl");

  const sources = [];
  if (boolFromEnv(env.INGEST_CODEX, true) && isPrimaryAgentSourceEnabled("codex", cfg.captureAgents)) {
    sources.push({ name: "codex", enabled: true, globs: [codexGlob], parseLine: parseCodexLine });
  }
  if (boolFromEnv(env.INGEST_CLAUDE, true) && isPrimaryAgentSourceEnabled("claude", cfg.captureAgents)) {
    sources.push({
      name: "claude", enabled: true, globs: [claudeGlob],
      ignoreGlobs: cfg.claudeIncludeSubagents ? [] : ["**/subagents/**"],
      parseLine: parseClaudeCodeLine,
    });
  }
  if (boolFromEnv(env.INGEST_OPENCLAW, true)) {
    sources.push({ name: "openclaw", enabled: true, globs: [openclawGlob], parseLine: parseOpenClawLine });
  }

  // cursor — same format as Claude but uses "role" instead of "type"
  const cursorGlob = expandHome(env.CURSOR_GLOB ?? "~/.cursor/projects/**/*.jsonl");
  if (boolFromEnv(env.INGEST_CURSOR, true) && isPrimaryAgentSourceEnabled("cursor", cfg.captureAgents)) {
    sources.push({ name: "cursor", enabled: true, globs: [cursorGlob], parseLine: parseCursorLine });
  }

  // gemini — JSON format (not JSONL), uses parseFile instead of parseLine
  const geminiGlob = expandHome(env.GEMINI_GLOB ?? "~/.gemini/tmp/*/chats/session-*.json");
  if (boolFromEnv(env.INGEST_GEMINI, true)) {
    sources.push({ name: "gemini", enabled: true, globs: [geminiGlob], parseFile: parseGeminiFile });
  }

  // gstack — skill artifacts (learnings, timeline, reviews, resources)
  const gstackGlob = expandHome(env.GSTACK_GLOB ?? "~/.gstack/projects/**/*.jsonl");
  if (boolFromEnv(env.INGEST_GSTACK, true)) {
    sources.push({ name: "gstack", enabled: true, globs: [gstackGlob], parseLine: parseGstackLine });
  }

  // opencode — SQLite DB (≥1.2.0: opencode.db, v1 message/part or v2
  // session_message schema) plus the pre-1.2 JSON "storage" layout.
  // Data dir: ${XDG_DATA_HOME:-~/.local/share}/opencode (see parser header).
  // OPENCODE_DATA_DIR accepts a comma-separated list of data dirs.
  const xdgData = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const opencodeDataDir = env.OPENCODE_DATA_DIR || `${xdgData}/opencode`;
  const opencodeGlobs = String(opencodeDataDir)
    .split(",").map((d) => expandHome(d.trim())).filter(Boolean)
    .flatMap((dir) => [
      `${dir}/opencode*.db`,                      // current: SQLite DB
      `${dir}/storage/message/*/*.json`,           // pre-1.2: message files
      `${dir}/storage/session/message/*/*.json`,   // migration-era: message files
    ]);
  if (boolFromEnv(env.INGEST_OPENCODE, true)) {
    sources.push({ name: "opencode", enabled: true, globs: opencodeGlobs, parseFile: parseOpencodeFile, readBinary: true });
  }

  // agy (Google Antigravity CLI/IDE) — JSONL step transcripts.
  // Only antigravity-cli (full, untruncated) + antigravity (IDE) are scanned;
  // the -ide/-backup siblings would duplicate the same conversations.
  const agyGlobs = [
    expandHome(env.AGY_GLOB ?? "~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl"),
    expandHome("~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl"),
  ];
  if (boolFromEnv(env.INGEST_AGY, true)) {
    sources.push({ name: "agy", enabled: true, globs: agyGlobs, parseLine: parseAgyLine });
  }

  // freebuff (CodebuffAI/freebuff) — chat-messages.json per chat
  const freebuffGlob = expandHome(env.FREEBUFF_GLOB ?? "~/.config/manicode/projects/*/chats/*/chat-messages.json");
  if (boolFromEnv(env.INGEST_FREEBUFF, true)) {
    sources.push({ name: "freebuff", enabled: true, globs: [freebuffGlob], parseFile: parseFreebuffFile });
  }

  return sources;
}

export async function listSourceFiles(source) {
  return fg(source.globs, {
    onlyFiles: true, absolute: true, followSymbolicLinks: false,
    unique: true, suppressErrors: true, ignore: source.ignoreGlobs ?? [],
  });
}

/**
 * Pull cwd out of a parser-normalized record (handles codex session_meta shape,
 * opencode's session.directory / v1 message path.cwd).
 */
export function extractProjectPathFromNormalized(normalized) {
  const candidates = [
    normalized?.raw?.payload?.cwd,
    normalized?.raw?.cwd,
    normalized?.raw?.directory,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return path.resolve(value);
  }
  return "";
}

/**
 * Stream the file line-by-line and stop on the first line that yields a cwd.
 * Caps at 32 lines as a safety valve so we never walk the whole file.
 * The path itself is tried first: harnesses encode the project directory in the
 * transcript path (claude/cursor), which costs nothing to check.
 */
export async function discoverProjectPathFromFileHead(source, filePath) {
  const fromFilePath = extractProjectPathFromFile(filePath);
  if (fromFilePath) return path.resolve(fromFilePath);
  if (!source.parseLine) return "";

  const stream = fsSync.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let scanned = 0;
  try {
    for await (const line of rl) {
      if (scanned++ >= 32) break;
      if (!line.trim()) continue;
      const normalized = source.parseLine({ line, filePath });
      const projectPath = extractProjectPathFromNormalized(normalized);
      if (projectPath) return projectPath;
    }
  } catch {
    return "";
  } finally {
    rl.close();
    stream.destroy();
  }

  return "";
}

/**
 * Project-path lookup with an LRU cache. The cache lives on `runtime` in the
 * daemon (one Map for the process lifetime) and is passed in here so this
 * module stays free of daemon internals.
 *
 * Keyed by `${source.name}:${fileId}` where fileId is `dev:ino` — stable across
 * rotation-by-rename, and different for a rewritten file, which is exactly the
 * distinction that matters when re-reading a head.
 *
 * @param {object} deps
 * @param {Map<string, string>} deps.cache  insertion-ordered Map used as an LRU
 * @param {number} [deps.limit]             entry cap (see PROJECT_PATH_CACHE_LIMIT)
 */
export function createProjectPathResolver({ cache, limit = PROJECT_PATH_CACHE_LIMIT } = {}) {
  function rememberProjectPath(cacheKey, projectPath) {
    if (cache.has(cacheKey)) cache.delete(cacheKey);
    cache.set(cacheKey, projectPath);
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  async function resolveSourceFileProjectPath({ source, filePath, fileId }) {
    const cacheKey = `${source.name}:${fileId}`;
    if (cache.has(cacheKey)) {
      // refresh LRU position on hit
      const cached = cache.get(cacheKey);
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached || "";
    }

    const projectPath = await discoverProjectPathFromFileHead(source, filePath);
    rememberProjectPath(cacheKey, projectPath || "");
    return projectPath || "";
  }

  return { cache, rememberProjectPath, resolveSourceFileProjectPath };
}
