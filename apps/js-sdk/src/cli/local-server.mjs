// Local server discovery — the offline-first glue (FREE-007).
//
// `ultracontext serve` writes <dataHome>/server.json (mode 0600) holding the
// local API key and the port it is listening on. Whenever that file exists,
// the rest of the CLI (sync, stats, MCP) can run with zero network and zero
// configuration: no account, no hosted API, no key entry.
//
// Precedence (highest first), applied by the CLI before any key is needed:
//   1. explicit env — ULTRACONTEXT_API_KEY / ULTRACONTEXT_BASE_URL
//   2. ULTRACONTEXT_LOCAL=1  — force the local server (error if absent)
//   3. <dataHome>/server.json — local server from `ultracontext serve`
//   4. <dataHome>/config.json — hosted key from `ultracontext config` (legacy)
//   5. interactive onboarding

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Data home for the local server: $ULTRACONTEXT_HOME, else ~/.ultracontext. */
export function localDataHome(env = process.env) {
  // same convention as `ultracontext serve`: ULTRACONTEXT_HOME is the home dir itself
  const override = String(env.ULTRACONTEXT_HOME ?? "").trim();
  if (override) return override;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".ultracontext");
}

/**
 * Read the local server descriptor written by `ultracontext serve`.
 * @returns {{apiKey: string, port: number, url: string} | null}
 *   null when there is no usable local server (missing file, bad JSON,
 *   or no API key recorded yet).
 */
export function readLocalServer(env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(localDataHome(env), "server.json"), "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || !raw.apiKey) return null;
  const port = Number.isInteger(raw.port) && raw.port > 0 ? raw.port : 8787;
  return { apiKey: String(raw.apiKey), port, url: `http://127.0.0.1:${port}` };
}
