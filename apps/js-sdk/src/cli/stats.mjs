// CLI handler for `ultracontext stats` — free usage analytics, right here.
//
// The commercial tier sells "analytics" and gates "unlimited analytics" behind
// a paid plan. You are looking at the whole feature, computed on demand from
// your own database: no telemetry pipeline, no third party, no retention window
// that quietly truncates your history, and no quota on how often you ask.

import process from "node:process";

const isTTY = Boolean(process.stdout.isTTY);
const esc = (code) => (isTTY ? `\x1b[${code}m` : "");
const r = esc(0);
const b = esc(1);
const d = esc(2);
const blue = esc("38;2;47;111;179");
const green = esc("38;2;80;200;120");
const cyan = esc("36");
const gray = esc("38;5;245");

// -- args ---------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { bucket: "day", days: null, from: null, to: null, source: null, json: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] ?? "");

    if (arg === "-h" || arg === "--help") {
      opts.help = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--bucket") {
      const value = String(argv[++i] ?? "").trim().toLowerCase();
      if (!["day", "week", "month"].includes(value)) {
        throw new Error(`Invalid --bucket value: ${value || "(empty)"}. Use day, week or month.`);
      }
      opts.bucket = value;
      continue;
    }
    if (arg === "--days") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 1) throw new Error("--days requires a positive number");
      opts.days = Math.floor(value);
      continue;
    }
    if (arg === "--from") {
      opts.from = String(argv[++i] ?? "");
      continue;
    }
    if (arg === "--to") {
      opts.to = String(argv[++i] ?? "");
      continue;
    }
    if (arg === "--source") {
      opts.source = String(argv[++i] ?? "");
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: ultracontext stats [options]

Usage analytics for everything you have captured — free, unmetered, and
computed from your own database. Nothing is sampled and no retention window
truncates your history.

Options:
  --bucket <day|week|month>  Time granularity (default: day)
  --days <n>                 Width of the default window (default 30 days,
                             12 weeks, or 12 months)
  --from <iso8601>           Explicit lower bound
  --to <iso8601>             Explicit upper bound (exclusive)
  --source <name>            Restrict to one agent (claude, codex, …)
  --json                     Print the raw response instead of a chart
  -h, --help                 Show this help message

Environment:
  ULTRACONTEXT_API_KEY    Your API key
  ULTRACONTEXT_BASE_URL   API base URL (default: https://api.ultracontext.ai)
`);
}

// -- formatting ---------------------------------------------------------------

const nf = new Intl.NumberFormat("en-US");

// Unicode block bars — degrade to '#' when the terminal is not UTF-8 friendly.
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
const ASCII_BLOCKS = ["_", ".", ":", "-", "=", "+", "*", "#"];
const utf8 = (process.env.LANG ?? "").toUpperCase().includes("UTF") || process.platform !== "win32";

function sparkline(values) {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  const glyphs = utf8 ? BLOCKS : ASCII_BLOCKS;
  return values
    .map((value) => {
      if (value <= 0) return glyphs[0];
      const idx = Math.min(glyphs.length - 1, Math.max(0, Math.round((value / max) * (glyphs.length - 1))));
      return glyphs[idx];
    })
    .join("");
}

function bar(value, max, width = 28) {
  if (max <= 0) return "";
  const filled = Math.round((value / max) * width);
  const glyphs = utf8 ? BLOCKS : ASCII_BLOCKS;
  const full = glyphs[glyphs.length - 1];
  return full.repeat(Math.max(value > 0 ? 1 : 0, filled));
}

function pad(value, width) {
  return String(value).padEnd(width);
}
function padLeft(value, width) {
  return String(value).padStart(width);
}

// -- main ---------------------------------------------------------------------

export async function runStats(rawArgs) {
  const opts = parseArgs(rawArgs ?? process.argv.slice(3));
  if (opts.help) {
    printHelp();
    return;
  }

  const apiKey = process.env.ULTRACONTEXT_API_KEY;
  if (!apiKey) throw new Error("ULTRACONTEXT_API_KEY is not set. Run `ultracontext config`.");

  const baseUrl = (process.env.ULTRACONTEXT_BASE_URL ?? "https://api.ultracontext.ai").replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("bucket", opts.bucket);
  if (opts.days !== null) params.set("days", String(opts.days));
  if (opts.from) params.set("from", opts.from);
  if (opts.to) params.set("to", opts.to);
  if (opts.source) params.set("source", opts.source);

  const url = `${baseUrl}/contexts/stats?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const message = payload?.error ?? text.slice(0, 200) ?? res.statusText;
    throw new Error(`Stats request failed (${res.status}): ${message}`);
  }

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  render(payload);
}

function render(data) {
  const totals = data.totals ?? {};
  const series = data.series ?? [];
  const bySource = data.by_source ?? [];
  const peak = Math.max(...series.map((p) => p.messages ?? 0), 0);

  console.log("");
  console.log(`  ${blue}${b}UltraContext${r} ${d}Stats${r}  ${gray}by ${data.bucket} · ${shortDate(data.from)} → ${shortDate(data.to)}${r}`);
  console.log("");

  console.log(
    `  ${pad("messages", 12)}${b}${nf.format(totals.messages ?? 0)}${r}   ` +
      `${pad("sessions", 11)}${b}${nf.format(totals.root_contexts ?? 0)}${r}   ` +
      `${pad("sources", 9)}${b}${nf.format(totals.sources ?? 0)}${r}`,
  );
  console.log(
    `  ${pad("contexts", 12)}${nf.format(totals.contexts ?? 0)}   ` +
      `${pad("nodes", 11)}${nf.format(totals.nodes ?? 0)}   ` +
      `${pad("active", 9)}${nf.format(totals.active_buckets ?? 0)}`,
  );

  if (series.length > 0) {
    console.log("");
    console.log(`  ${gray}${sparkline(series.map((p) => p.messages ?? 0))}${r}`);
    console.log("");

    const labelWidth = Math.max(...series.map((p) => String(p.bucket_start).length));
    for (const point of series) {
      const messages = point.messages ?? 0;
      console.log(
        `  ${cyan}${pad(point.bucket_start, labelWidth)}${r}  ` +
          `${bar(messages, peak)} ${gray}${padLeft(nf.format(messages), 7)}${r}`,
      );
    }
  }

  if (bySource.length > 0) {
    console.log("");
    console.log(`  ${d}By source${r}`);
    const sourcePeak = Math.max(...bySource.map((s) => s.messages ?? 0), 0);
    const nameWidth = Math.max(...bySource.map((s) => String(s.source).length));
    for (const source of bySource) {
      console.log(
        `  ${cyan}${pad(source.source, nameWidth)}${r}  ` +
          `${bar(source.messages ?? 0, sourcePeak)} ${gray}${padLeft(nf.format(source.messages ?? 0), 7)}${r} ${d}msgs${r}`,
      );
    }
  }

  console.log("");
  console.log(`  ${gray}Free and unmetered — analytics is computed from your own data, never a paid add-on.${r}`);
  console.log("");
}

function shortDate(value) {
  const text = String(value ?? "");
  return text.length >= 10 ? text.slice(0, 10) : text || "—";
}
