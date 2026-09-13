import path from "node:path";
import { normalizeRole, preserveText, safeJsonParse, toMessage, truncateString } from "../utils.mjs";

/**
 * freebuff — CodebuffAI/freebuff, "the world's strongest free coding agent"
 * (npm i -g freebuff). The npm package is a thin launcher that downloads a
 * prebuilt binary into the config dir; the real CLI is TypeScript (Bun).
 *
 * On-disk layout — discovered 2026-09-11 by reading the public source
 * (github.com/CodebuffAI/freebuff @ main, cli/src):
 *
 * Config dir: `~/.config/manicode`
 *   (cli/src/utils/config-dir.ts; override with FREEBUFF_CONFIG_DIR, which
 *    must be an absolute path. Non-prod dev builds add a `-<environment>`
 *    suffix to the dir name.)
 *
 * Per-project data: `~/.config/manicode/projects/<project-basename>/`
 *   (cli/src/project-files.ts — project dir is the BASENAME of the cwd)
 *
 * One directory per chat:
 *   <project>/chats/<chatId>/
 *     chat-messages.json   ← the transcript (JSON array of ChatMessage)
 *     chat-meta.json       ← sidecar {messageCount, firstPrompt, messagesSize, messagesMtimeMs}
 *     run-state.json       ← run state
 *
 * chatId = new Date().toISOString() with ':' → '-'
 * (e.g. "2026-09-11T12-34-56.789Z"). The chatId is the session id.
 *
 * ChatMessage (cli/src/types/chat.ts):
 *   { id, variant: 'ai' | 'user' | 'agent' | 'error',
 *     content: string, blocks?: ContentBlock[], timestamp: string, … }
 * ContentBlock kinds used for text extraction:
 *   {type:'text', content, textType: 'text' | 'reasoning'}
 *   {type:'tool', toolName, input, output?}
 *   {type:'plan', content}
 *   {type:'image', image, filename?}
 */

// chatId from …/projects/<project>/chats/<chatId>/chat-messages.json
function extractFreebuffSessionId(filePath) {
    const match = filePath.match(/chats\/([^/]+)\/[^/]+$/);
    return match ? match[1] : path.basename(filePath, ".json");
}

function freebuffTimeToIso(value) {
    if (typeof value === "string" && value) {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        const ms = value < 1e12 ? value * 1000 : value;
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    return new Date().toISOString();
}

function formatFreebuffTool(block) {
    const name = block.toolName ?? block.tool ?? "unknown";
    const compact = typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {});
    const detail = compact.length > 500 ? compact.slice(0, 500) + "..." : compact;
    let text = `[${name}] ${detail}`;
    if (typeof block.output === "string" && block.output.trim()) {
        text += `\n[result] ${truncateString(preserveText(block.output), 1000)}`;
    }
    return text;
}

// one ChatMessage → 0 or 1 normalized events
function freebuffMessageToEvent(message, sessionId, fallbackTimestamp) {
    if (!message || typeof message !== "object") return null;

    const variant = String(message.variant ?? "").toLowerCase();
    const parts = [];

    // primary text
    if (typeof message.content === "string" && message.content.trim()) {
        parts.push(preserveText(message.content));
    }

    // blocks: reasoning, tool calls, plans, image placeholders
    if (Array.isArray(message.blocks)) {
        for (const block of message.blocks) {
            if (!block || typeof block !== "object") continue;
            const blockType = String(block.type ?? "").toLowerCase();
            if (blockType === "text" && typeof block.content === "string") {
                // skip blocks that just mirror message.content
                if (block.content === message.content) continue;
                const chunk = preserveText(block.content);
                if (!chunk) continue;
                parts.push(block.textType === "reasoning" ? `[thinking] ${chunk}` : chunk);
            } else if (blockType === "tool") {
                const toolText = formatFreebuffTool(block);
                if (toolText) parts.push(toolText);
            } else if (blockType === "plan" && typeof block.content === "string" && block.content.trim()) {
                parts.push(`[plan] ${preserveText(block.content)}`);
            } else if (blockType === "image") {
                parts.push(`[image] ${block.filename ?? block.mediaType ?? "attachment"}`);
            }
        }
    }

    if (!parts.length) return null;

    // variant → kind: user, ai/agent (sub-agent runs) → assistant, error → system
    const kind = variant === "user"
        ? "user"
        : variant === "error"
            ? "system"
            : normalizeRole(variant, "assistant");

    return {
        sessionId,
        eventType: `freebuff.${variant || "message"}`,
        kind,
        timestamp: freebuffTimeToIso(message.timestamp ?? fallbackTimestamp),
        message: toMessage(parts.join("\n\n")),
        raw: {
            id: message.id,
            variant,
            isCompletion: message.isCompletion,
            completionTime: message.completionTime,
            agent: message.agent,
        },
    };
}

// parse an entire freebuff chat-messages.json file
export function parseFreebuffFile({ fileContents, filePath }) {
    const parsed = safeJsonParse(typeof fileContents === "string" ? fileContents : fileContents.toString("utf8"));
    if (!parsed) return [];

    const messages = Array.isArray(parsed) ? parsed : Array.isArray(parsed.messages) ? parsed.messages : [];
    if (!messages.length) return [];

    const sessionId = extractFreebuffSessionId(filePath);
    const events = [];
    for (const message of messages) {
        const event = freebuffMessageToEvent(message, sessionId, new Date().toISOString());
        if (event) events.push(event);
    }
    return events;
}
