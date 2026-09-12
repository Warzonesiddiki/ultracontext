// MCP server configuration — local-first (FREE-007).
//
// Precedence (highest first):
//   1. explicit env — ULTRACONTEXT_API_KEY (optionally ULTRACONTEXT_BASE_URL)
//   2. local server.json written by `ultracontext serve` — fully offline
//   3. hosted config.json written by `ultracontext config` — legacy
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOSTED_DEFAULT = "https://api.ultracontext.ai";

export interface McpConfig {
  apiKey: string;
  baseUrl: string;
  source: "env" | "local" | "config";
}

/** Data home: $ULTRACONTEXT_HOME, else ~/.ultracontext (same as `serve`). */
function dataHome(): string {
  const override = String(process.env.ULTRACONTEXT_HOME ?? "").trim();
  if (override) return override;
  return join(homedir(), ".ultracontext");
}

/**
 * Resolve MCP credentials. Prints a helpful error and exits when no usable
 * configuration exists.
 */
export function loadConfig(): McpConfig {
  // 1 — explicit env always wins
  if (process.env.ULTRACONTEXT_API_KEY) {
    return {
      apiKey: process.env.ULTRACONTEXT_API_KEY,
      baseUrl: process.env.ULTRACONTEXT_BASE_URL ?? HOSTED_DEFAULT,
      source: "env",
    };
  }

  // 2 — local server from `ultracontext serve`
  try {
    const local = JSON.parse(readFileSync(join(dataHome(), "server.json"), "utf8"));
    if (local?.apiKey) {
      const port = Number.isInteger(local.port) && local.port > 0 ? local.port : 8787;
      return {
        apiKey: String(local.apiKey),
        baseUrl: `http://127.0.0.1:${port}`,
        source: "local",
      };
    }
  } catch { /* no local server — fall through */ }

  // 3 — hosted key from `ultracontext config`
  try {
    const raw = JSON.parse(readFileSync(join(dataHome(), "config.json"), "utf8"));
    if (raw?.apiKey) {
      return {
        apiKey: String(raw.apiKey),
        baseUrl: String(raw.baseUrl ?? HOSTED_DEFAULT),
        source: "config",
      };
    }
  } catch { /* no config — fall through */ }

  console.error(
    "No UltraContext configuration found.\n" +
    "  Free & local:  run `ultracontext serve` first (writes server.json), then retry.\n" +
    "  Or set ULTRACONTEXT_API_KEY (and optionally ULTRACONTEXT_BASE_URL) explicitly."
  );
  process.exit(1);
}
