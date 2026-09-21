// === ui/resume/context-helpers.mjs — pure resume list/message helpers ===
// Owns: the stateless half of the resume feature — message coercion
// (role/text/timestamp/event-type), session cwd extraction, context list
// handling (dedupe by id, source filter, newest-first sort), source→agent
// mapping with the recommended target ordering, and the resume summary
// markdown renderer. Extracted verbatim from tui.mjs (ARCH-005); the two
// functions that read the cfg closure (resumeFilterContexts' source filter,
// resumeSummaryMarkdown's tail length) take those values as parameters now.

export const RESUME_TARGET_OPTIONS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export const INSPECT_OPTION = { id: "inspect", label: "Inspect messages" };

export const SOURCE_FILTERS = ["all", "claude", "codex", "openclaw", "cursor", "gemini"];

export function resumeCompact(value, max = 60) {
  const raw = String(value ?? "");
  if (raw.length <= max) return raw;
  if (max <= 3) return raw.slice(0, max);
  return `${raw.slice(0, max - 3)}...`;
}

export function resumeNormalizeRole(message) {
  const role = String(message?.role ?? "system").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "agent") return "assistant";
  return "system";
}

export function resumeMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return resumeCompact(content.replace(/\s+/g, " ").trim(), 220);
  if (content && typeof content === "object") {
    if (typeof content.message === "string") return resumeCompact(content.message.replace(/\s+/g, " ").trim(), 220);
    if (typeof content.text === "string") return resumeCompact(content.text.replace(/\s+/g, " ").trim(), 220);
    return resumeCompact(JSON.stringify(content), 220);
  }
  return "";
}

export function resumeMessageTimestamp(message) {
  return message?.content?.timestamp ?? message?.metadata?.timestamp ?? "";
}

export function resumeMessageEventType(message) {
  return message?.content?.event_type ?? message?.metadata?.event_type ?? "message";
}

export function resumeExtractSessionCwd(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cwd = messages[i]?.content?.raw?.payload?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return "";
}

export function resumeDedupeById(contexts) {
  const out = [];
  const seen = new Set();
  for (const item of contexts ?? []) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function resumeFilterContexts(contexts, resumeSourceFilter) {
  return contexts.filter((ctx) => {
    const md = ctx?.metadata ?? {};
    const source = String(md.source ?? "").toLowerCase();
    if (resumeSourceFilter !== "all" && source && source !== resumeSourceFilter) return false;
    return true;
  });
}

export function resumeSortContexts(contexts) {
  const ts = (ctx) => {
    const candidates = [ctx?.created_at, ctx?.updated_at, ctx?.metadata?.timestamp, ctx?.metadata?.created_at];
    for (const candidate of candidates) {
      const value = new Date(candidate ?? 0).getTime();
      if (!Number.isNaN(value) && value > 0) return value;
    }
    return 0;
  };

  return contexts.slice().sort((a, b) => {
    const diff = ts(b) - ts(a);
    if (diff !== 0) return diff;
    const aId = String(a?.id ?? "");
    const bId = String(b?.id ?? "");
    return bId.localeCompare(aId);
  });
}

export function resumeFormatDate(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function resumeContextSource(context) {
  const raw = String(context?.metadata?.source ?? "").trim().toLowerCase();
  if (raw === "codex") return "codex";
  if (raw === "claude") return "claude";
  return "unknown";
}

export function isCodingContextSource(source) {
  return source === "codex" || source === "claude";
}

export function resumeTargetAgent(source) {
  if (source === "codex") return "claude";
  if (source === "claude") return "codex";
  return "codex";
}

export function resumeTargetOptionsForSource(source) {
  if (!isCodingContextSource(source)) return RESUME_TARGET_OPTIONS.slice();
  const recommended = resumeTargetAgent(source);
  const ordered = RESUME_TARGET_OPTIONS.slice().sort((a, b) => {
    if (a.id === recommended && b.id !== recommended) return -1;
    if (b.id === recommended && a.id !== recommended) return 1;
    return 0;
  });
  ordered.push(INSPECT_OPTION);
  return ordered;
}

export function resumeAgentLabel(agent) {
  if (agent === "claude") return "Claude Code";
  if (agent === "codex") return "Codex";
  return "Unknown";
}

export function recommendedResumeTargetForContext(context) {
  const sourceAgent = resumeContextSource(context);
  if (!isCodingContextSource(sourceAgent)) return "";
  return resumeTargetAgent(sourceAgent);
}

export function resumeSummaryMarkdown({ context, messages, tail }) {
  const counts = { user: 0, assistant: 0, system: 0 };
  for (const msg of messages) counts[resumeNormalizeRole(msg)] += 1;
  const recent = messages.slice(-Math.max(tail, 4));
  const lines = [
    "# UltraContext Resume",
    "",
    `Generated at: ${new Date().toISOString()}`,
    `Context ID: ${context.id}`,
    `Created at: ${resumeFormatDate(context.created_at)}`,
    `Source: ${context.metadata?.source ?? "-"}`,
    `User: ${context.metadata?.user_id ?? "-"}`,
    `Session ID: ${context.metadata?.session_id ?? "-"}`,
    "",
    "## Snapshot",
    `- Messages: ${messages.length}`,
    `- Roles: user=${counts.user}, assistant=${counts.assistant}, system=${counts.system}`,
    "",
    `## Recent Timeline (last ${recent.length})`,
  ];

  for (const msg of recent) {
    const ts = resumeCompact(resumeMessageTimestamp(msg) || "-", 19).padEnd(19);
    const role = resumeNormalizeRole(msg).toUpperCase().padEnd(9);
    const eventType = resumeCompact(resumeMessageEventType(msg), 24).padEnd(24);
    const text = resumeMessageText(msg) || "-";
    lines.push(`- ${ts} ${role} ${eventType} ${text}`);
  }

  lines.push("", "## Resume Instructions", "1. Use the generated adapter command from the Contexts tab.", "2. Continue from the latest unresolved request.", "");
  return lines.join("\n");
}
