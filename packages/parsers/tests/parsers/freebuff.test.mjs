import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseFreebuffFile } from "../../src/agents/freebuff.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, "../fixtures/freebuff-chat-messages.json");
const fileContents = fs.readFileSync(fixturePath, "utf8");

// realistic on-disk path: <config>/projects/<project>/chats/<chatId>/chat-messages.json
const filePath = "/home/demo/.config/manicode/projects/webapp/chats/2026-09-10T09-15-00.000Z/chat-messages.json";

function parseAll() {
    return parseFreebuffFile({ fileContents, filePath });
}

describe("parseFreebuffFile — freebuff chat-messages.json format", () => {
    it("parses every message with text", () => {
        const events = parseAll();
        assert.equal(events.length, 4);
        assert.deepEqual(events.map((e) => e.kind), ["user", "assistant", "assistant", "user"]);
        assert.deepEqual(events.map((e) => e.eventType), ["freebuff.user", "freebuff.ai", "freebuff.agent", "freebuff.user"]);
    });

    it("uses the chat id from the path as the session id", () => {
        const events = parseAll();
        for (const event of events) {
            assert.equal(event.sessionId, "2026-09-10T09-15-00.000Z");
        }
    });

    it("parses user message content", () => {
        const user = parseAll()[0];
        assert.ok(user.message.includes("Make the deploy script idempotent"));
        assert.equal(user.timestamp, "2026-09-10T09:15:00.000Z");
    });

    it("merges text, reasoning and tool blocks without duplicating content", () => {
        const assistant = parseAll()[1];
        // message.content appears once (the mirroring text block is deduped)
        assert.equal(assistant.message.match(/I'll read the deploy script/g).length, 1);
        assert.ok(assistant.message.includes("[thinking]"));
        assert.ok(assistant.message.includes("re-runs migrations unconditionally"));
        assert.ok(assistant.message.includes("[bash]"));
        assert.ok(assistant.message.includes("cat deploy.sh"));
        assert.ok(assistant.message.includes("psql -f migrate.sql"));
    });

    it("parses sub-agent (variant=agent) messages", () => {
        const agent = parseAll()[2];
        assert.equal(agent.kind, "assistant");
        assert.ok(agent.message.includes("lock-file check"));
        assert.equal(agent.raw.agent.agentName, "deploy-fixer");
    });

    it("handles Buffer input (daemon reads files as utf8 for text sources)", () => {
        const events = parseFreebuffFile({ fileContents: Buffer.from(fileContents), filePath });
        assert.equal(events.length, 4);
    });

    it("returns [] for malformed or non-array files", () => {
        assert.deepEqual(parseFreebuffFile({ fileContents: "not json", filePath }), []);
        assert.deepEqual(parseFreebuffFile({ fileContents: JSON.stringify({ messages: [] }), filePath }), []);
    });
});
