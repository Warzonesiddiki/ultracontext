import path from "node:path";
import { preserveText, safeJsonParse, toMessage, truncateString } from "../utils.mjs";

/**
 * agy — Google Antigravity CLI (npm: @google/antigravity? no — install via
 * antigravity.google; the binary is `agy`). The IDE app is "Antigravity".
 *
 * On-disk layout — verified 2026-09-11 (HANDOVER.md prior-session capture,
 * cross-checked against antigravity.google/docs/cli/statusline and public
 * walkthroughs of the transcript format, Antigravity ≥ 1.1):
 *
 *   ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript.jsonl        (CLI, truncated)
 *   ~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/transcript_full.jsonl   (CLI, complete)
 *   ~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/transcript.jsonl            (IDE)
 *   ~/.gemini/antigravity-ide/brain/…        — sibling copy of the IDE store (duplicate)
 *   ~/.gemini/antigravity-backup/brain/…     — migration snapshot (duplicate)
 *
 * Ingestion scans ONLY `antigravity-cli/brain` (transcript_full.jsonl — the
 * plain transcript.jsonl is truncated for large outputs) and `antigravity/brain`
 * (transcript.jsonl — the IDE store; its official statusline payload points at
 * this path). The -ide and -backup siblings are deliberately excluded so the
 * same conversation is not ingested two or three times.
 *
 * Line format: each line is one STEP of the conversation, not one message:
 *   { step_index, source, type, status, created_at, content, tool_calls?, thinking?, truncated_fields? }
 *   type examples: USER_INPUT, PLANNER_RESPONSE, CONVERSATION_HISTORY,
 *   RUN_COMMAND / GREP_SEARCH / READ_FILE / WRITE_FILE (tool steps), …
 *   - `content` is a plain string when present.
 *   - `tool_calls` is an array of { name, arguments|args|params|input }.
 *   - lines with no content AND no tool_calls (e.g. CONVERSATION_HISTORY)
 *     carry no transcript text and are skipped.
 *   - `truncated_fields` (only in transcript.jsonl) lists clipped fields —
 *     another reason to prefer transcript_full.jsonl.
 * The conversation id (directory name under brain/) is the session id.
 */

// conversation id from …/brain/<conversation>/…/<file>.jsonl
function extractAgySessionId(filePath) {
    const match = filePath.match(/brain\/([^/]+)\//);
    return match ? match[1] : path.basename(filePath, ".jsonl");
}

// created_at arrives as ISO string or epoch — tolerate both
function agyTimeToIso(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
    }
    if (typeof value === "string" && value) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
}

function formatAgyToolCall(tc) {
    if (!tc || typeof tc !== "object") return "";
    const name = tc.name ?? tc.tool ?? "unknown";
    const args = tc.arguments ?? tc.args ?? tc.params ?? tc.input ?? {};
    const compact = typeof args === "string" ? args : JSON.stringify(args);
    const detail = compact.length > 500 ? compact.slice(0, 500) + "..." : compact;
    return `[${name}] ${detail}`;
}

export function parseAgyLine({ line, filePath }) {
    const parsed = safeJsonParse(line);
    if (!parsed || typeof parsed !== "object") return null;

    const type = String(parsed.type ?? "step");
    const typeKey = type.toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const sessionId = parsed.conversation_id ?? parsed.session_id ?? extractAgySessionId(filePath);
    const timestamp = agyTimeToIso(parsed.created_at ?? parsed.timestamp);

    const parts = [];

    // main text
    if (typeof parsed.content === "string" && parsed.content.trim()) {
        parts.push(preserveText(parsed.content));
    } else if (Array.isArray(parsed.content)) {
        // tolerate a polymorphic content array of {text} items
        const chunks = parsed.content
            .filter((c) => c && typeof c === "object" && typeof c.text === "string")
            .map((c) => preserveText(c.text))
            .filter(Boolean);
        if (chunks.length) parts.push(chunks.join("\n"));
    }

    // tool calls on this step
    if (Array.isArray(parsed.tool_calls)) {
        const toolTexts = parsed.tool_calls.map(formatAgyToolCall).filter(Boolean);
        if (toolTexts.length) parts.push(toolTexts.join("\n"));
    }

    // reasoning steps may only carry thinking
    if (typeof parsed.thinking === "string" && parsed.thinking.trim()) {
        parts.push(`[thinking] ${preserveText(parsed.thinking)}`);
    }

    if (!parts.length) return null; // no transcript text on this step

    // classify: USER_INPUT is the user; system-ish types stay system; the rest
    // (planner responses, tool steps, agent output) are assistant
    const upper = type.toUpperCase();
    let kind;
    if (upper === "USER_INPUT" || upper === "USER") kind = "user";
    else if (upper.includes("SYSTEM") || upper === "CONVERSATION_HISTORY" || upper.includes("STATUS") || upper.includes("META")) kind = "system";
    else kind = "assistant";

    return {
        sessionId,
        eventType: `agy.${typeKey}`,
        kind,
        timestamp,
        message: toMessage(parts.join("\n\n")),
        raw: {
            step_index: parsed.step_index,
            type,
            source: parsed.source,
            status: parsed.status,
            hasToolCalls: Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0,
            truncatedFields: parsed.truncated_fields,
        },
    };
}
