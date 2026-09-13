import { truncateString } from "./utils.mjs";

const REDACTED = "***REDACTED***";

// Object/array keys that mark their value as secret — the whole value goes.
const SENSITIVE_KEY_REGEX = /(token|secret|password|passphrase|api[-_]?key|authorization|cookie|session[-_]?key|credential|dsn|jwt)/i;

// Value patterns applied to every string. Order matters where overlap is
// possible: PEM blocks first (a whole-block mask is cleaner than a patchwork
// of inner matches), connection strings before anything else that might
// touch userinfo, then the per-vendor token shapes.
const SECRET_PATTERNS = [
  // PEM private key blocks (RSA / EC / OPENSSH / PKCS8 / PGP)
  {
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g,
    replacement: "***PEM PRIVATE KEY REDACTED***",
  },
  // connection strings — mask the password portion, keep scheme+host usable
  {
    regex: /(\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|https?|ftp|sftp|elasticsearch|sqlserver|mssql):\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    replacement: "$1$2:***@",
  },
  // .env / key=value pairs with sensitive key names (transcripts paste
  // whole env blocks). Anchor-free on purpose: inside JSONL the lines are
  // separated by escaped \n, so ^...$ never fires. The key must start at a
  // token boundary (start, whitespace, quote, brace, backslash…) so
  // mid-word suffixes (MYTOKEN, AUTHOR) never match; the value stops at
  // quotes/commas/backslashes so one pair's mask can't swallow neighbours.
  {
    regex: /(?<=^|[\s"'{(,;=\\])((?:[A-Za-z_][A-Za-z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|CREDENTIALS?|DSN|CONNECTION_?STRING|BEARER|JWT|PRIVATE_?KEY))\s*=\s*([^\s"',;\\=]+)/g,
    replacement: "$1=***",
  },
  // JWTs (header.payload.signature) — always base64url, always starts eyJ
  {
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: "***JWT***",
  },
  // AWS access key ids (AKIA permanent, ASIA temporary)
  {
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "AKIA***",
  },
  // GitHub tokens: classic PATs + fine-grained
  {
    regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
    replacement: "ghp_***",
  },
  {
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "github_pat_***",
  },
  // Slack tokens (bot / app-level / user / refresh)
  {
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "xox_***",
  },
  // UltraContext keys
  { regex: /\buc_(live|test)_[A-Za-z0-9_-]+\b/g, replacement: "uc_$1_***" },
  // OpenAI / Anthropic / generic sk- keys (covers sk-ant-, sk-proj-)
  { regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g, replacement: "sk-***" },
  { regex: /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi, replacement: "Bearer ***" },
  // Google API keys
  {
    regex: /\bAIza[0-9A-Za-z\-_]{20,}\b/g,
    replacement: "AIza***",
  },
];

function redactString(value) {
  let output = truncateString(value, 8000);
  for (const { regex, replacement } of SECRET_PATTERNS) {
    output = output.replace(regex, replacement);
  }
  return output;
}

export function redact(value, currentKey = "") {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return SENSITIVE_KEY_REGEX.test(currentKey) ? REDACTED : redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_REGEX.test(key) ? REDACTED : redact(raw, key);
    }
    return out;
  }

  return REDACTED;
}
