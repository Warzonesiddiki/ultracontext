import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAgyLine } from "../../src/agents/agy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/agy-transcript.jsonl");
const lines = fs.readFileSync(fixturePath, "utf8").split("\n").filter((l) => l.trim());

// realistic on-disk path: CLI transcript under a conversation id
const filePath = "/home/demo/.gemini/antigravity-cli/brain/11111111-2222-3333-4444-555555555555/.system_generated/logs/transcript_full.jsonl";

function parseAll(filePathOverride = filePath) {
    const events = [];
    lines.forEach((line, i) => {
        const event = parseAgyLine({ line, filePath: filePathOverride });
        if (event) events.push(event);
    });
    return events;
}

describe("parseAgyLine — Antigravity transcript step format", () => {
    it("skips steps without transcript text (CONVERSATION_HISTORY)", () => {
        const historyLine = JSON.parse(lines[4]);
        assert.equal(historyLine.type, "CONVERSATION_HISTORY");
        assert.equal(parseAgyLine({ line: lines[4], filePath }), null);
        const events = parseAll();
        assert.ok(!events.some((e) => e.raw.type === "CONVERSATION_HISTORY"));
    });

    it("parses USER_INPUT as a user event with the conversation id as session id", () => {
        const event = parseAgyLine({ line: lines[0], filePath });
        assert.equal(event.kind, "user");
        assert.equal(event.eventType, "agy.user_input");
        assert.equal(event.sessionId, "11111111-2222-3333-4444-555555555555");
        assert.ok(event.message.includes("flaky test in src/queue.ts"));
        assert.equal(event.timestamp, "2026-09-10T14:02:11.000Z");
        assert.equal(event.raw.step_index, 0);
    });

    it("parses planner responses with thinking", () => {
        const event = parseAgyLine({ line: lines[1], filePath });
        assert.equal(event.kind, "assistant");
        assert.equal(event.eventType, "agy.planner_response");
        assert.ok(event.message.includes("reproduce the failure first"));
        assert.ok(event.message.includes("[thinking]"));
        assert.ok(event.message.includes("race around a 50ms timer"));
    });

    it("formats tool_calls on tool steps", () => {
        const run = parseAgyLine({ line: lines[2], filePath });
        assert.equal(run.eventType, "agy.run_command");
        assert.ok(run.message.includes("[RUN_COMMAND]"));
        assert.ok(run.message.includes("bun test src/queue.ts --repeat 10"));
        assert.equal(run.raw.hasToolCalls, true);

        const grep = parseAgyLine({ line: lines[3], filePath });
        assert.ok(grep.message.includes("[GREP_SEARCH]"));
        assert.ok(grep.message.includes("setTimeout"));
    });

    it("tolerates epoch-number created_at", () => {
        const event = parseAgyLine({
            line: JSON.stringify({ step_index: 9, type: "USER_INPUT", created_at: 1789045200000, content: "hi" }),
            filePath,
        });
        assert.equal(event.timestamp, "2026-09-10T13:00:00.000Z");
    });

    it("parses the whole fixture into 5 events", () => {
        const events = parseAll();
        assert.equal(events.length, 5);
        assert.deepEqual(events.map((e) => e.kind), ["user", "assistant", "assistant", "assistant", "assistant"]);
    });

    it("falls back to the filename when the path has no brain/<id> segment", () => {
        const event = parseAgyLine({ line: lines[0], filePath: "/tmp/transcript.jsonl" });
        assert.equal(event.sessionId, "transcript");
    });
});
