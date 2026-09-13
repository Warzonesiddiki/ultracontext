// merged utils (daemon + tui deduplicated)
import crypto from "node:crypto";

// shared utils from parsers
export { expandHome, truncateString, safeJsonParse, extractSessionIdFromPath } from "@ultracontext/parsers/utils";

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// Wall-clock time of an ingested event as recorded in its source file —
// parsers normalise to ISO text or epoch ms. Falls back to ingestion time so
// message metadata always carries a clock the client can trust (PROM-001).
//
// Epoch handling: `new Date(number)` treats a number as ms, but
// `new Date("1788256800000")` (stringified digits) is Invalid in V8, so
// digit-only strings must be routed through Number() explicitly.
export function eventOccurredAt(timestamp) {
  if (timestamp === undefined || timestamp === null || timestamp === "") return new Date().toISOString();
  let d;
  if (typeof timestamp === "number") d = new Date(timestamp);
  else if (/^\d+$/.test(String(timestamp).trim())) d = new Date(Number(timestamp));
  else d = new Date(String(timestamp));
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return new Date().toISOString();
}

export function boolFromEnv(value, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

// claude: ~/.claude/projects/-Users-fabio-Code-foo/session.jsonl → /Users/fabio/Code/foo
// cursor: ~/.cursor/projects/-Users-fabio-Code-foo/session.jsonl → /Users/fabio/Code/foo
// codex:  ~/.codex/sessions/<uuid>.jsonl → null (cwd comes from session_meta)
// openclaw: ~/.openclaw/agents/<name>/sessions/<uuid>.jsonl → null
export function extractProjectPathFromFile(filePath) {
  const match = filePath.match(/\.(claude|cursor)\/projects\/([^/]+)/);
  if (!match) return null;

  // convert dash-separated path back to real path (leading dash = leading /)
  const encoded = match[2];
  return encoded.replace(/-/g, "/");
}
