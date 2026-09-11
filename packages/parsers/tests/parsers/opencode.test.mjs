import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseOpencodeFile, parseOpencodeLegacyMessage } from "../../src/agents/opencode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, "../fixtures");

function parseDb(dbFile) {
    const buffer = fs.readFileSync(dbFile);
    return parseOpencodeFile({ fileContents: buffer, filePath: dbFile });
}

describe("parseOpencodeFile — v1 SQLite schema (session + message + part)", () => {
    const events = parseDb(path.join(fixtures, "opencode-v1.db"));

    it("emits a session start anchor plus one event per message", () => {
        assert.equal(events.length, 4);
        assert.equal(events[0].eventType, "opencode.session_start");
        assert.equal(events[0].sessionId, "ses_legacy1");
        assert.ok(events[0].message.includes("Fix login timeout"));
        assert.ok(events[0].message.includes("/home/demo/webapp"));
    });

    it("parses user messages from part text", () => {
        const user = events[1];
        assert.equal(user.kind, "user");
        assert.equal(user.eventType, "opencode.user");
        assert.ok(user.message.includes("login endpoint times out under load"));
        assert.equal(user.timestamp, "2026-09-10T10:01:00.000Z");
    });

    it("merges assistant text + tool parts into one event", () => {
        const assistant = events[2];
        assert.equal(assistant.kind, "assistant");
        assert.equal(assistant.eventType, "opencode.assistant");
        assert.ok(assistant.message.includes("Let me look at the auth flow first."));
        assert.ok(assistant.message.includes("[read]"));
        assert.ok(assistant.message.includes("/home/demo/webapp/src/auth.ts"));
        assert.ok(assistant.message.includes("[result]"));
    });

    it("formats reasoning parts as [thinking]", () => {
        const assistant = events[3];
        assert.ok(assistant.message.includes("[thinking]"));
        assert.ok(assistant.message.includes("connections are held during token verification"));
        assert.ok(assistant.message.includes("[edit]"));
        assert.ok(assistant.message.includes("await verify(body.token)"));
    });

    it("carries the project directory in raw for daemon project-path extraction", () => {
        for (const event of events.slice(1)) {
            assert.equal(event.raw.directory, "/home/demo/webapp");
        }
    });
});

describe("parseOpencodeFile — v2 SQLite schema (session_message)", () => {
    const events = parseDb(path.join(fixtures, "opencode-v2.db"));

    it("emits a session start anchor with title and directory", () => {
        assert.equal(events[0].eventType, "opencode.session_start");
        assert.ok(events[0].message.includes("Add retry to fetch"));
        assert.ok(events[0].message.includes("/home/demo/api"));
    });

    it("parses v2 user rows", () => {
        const user = events.find((e) => e.eventType === "opencode.user");
        assert.equal(user.kind, "user");
        assert.ok(user.message.includes("Add a retry with backoff to the upstream fetch"));
        assert.equal(user.timestamp, "2026-09-11T08:01:00.000Z");
    });

    it("parses v2 assistant content: reasoning + text + tool", () => {
        const assistant = events.filter((e) => e.eventType === "opencode.assistant");
        const first = assistant[0];
        assert.ok(first.message.includes("[thinking]"));
        assert.ok(first.message.includes("exponential backoff"));
        assert.ok(first.message.includes("[write]"));
        assert.ok(first.message.includes("/home/demo/api/src/retry.ts"));
        assert.equal(assistant.length, 2);
        assert.ok(assistant[1].message.includes("jittered"));
    });

    it("parses shell rows with command and output", () => {
        const shell = events.find((e) => e.eventType === "opencode.shell");
        assert.equal(shell.kind, "system");
        assert.ok(shell.message.includes("[shell] bun test"));
        assert.ok(shell.message.includes("12 pass"));
    });

    it("parses model-switched and compaction rows as system events", () => {
        const switched = events.find((e) => e.eventType === "opencode.model_switched");
        assert.equal(switched.kind, "system");
        assert.ok(switched.message.includes("opencode-go/go-mini-1"));

        const compacted = events.find((e) => e.eventType === "opencode.compaction");
        assert.ok(compacted.message.includes("retry helper added with jittered backoff"));
    });

    it("carries the session directory in raw", () => {
        assert.equal(events[1].raw.directory, "/home/demo/api");
    });
});

describe("parseOpencodeFile — legacy pre-1.2 JSON storage layout", () => {
    const messageDir = path.join(fixtures, "opencode-legacy", "storage", "message", "ses_legacy_file");

    it("parses a user message file, pulling sibling part files", () => {
        const filePath = path.join(messageDir, "msg_l1.json");
        const buffer = fs.readFileSync(filePath); // daemon reads with readBinary → Buffer
        const events = parseOpencodeFile({ fileContents: buffer, filePath });
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, "user");
        assert.equal(events[0].sessionId, "ses_legacy_file");
        assert.ok(events[0].message.includes("queue drop messages when workers restart"));
        assert.equal(events[0].timestamp, "2026-09-10T13:00:00.000Z");
    });

    it("parses an assistant message file with tool parts", () => {
        const filePath = path.join(messageDir, "msg_l2.json");
        const events = parseOpencodeLegacyMessage({
            fileContents: fs.readFileSync(filePath, "utf8"),
            filePath,
        });
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, "assistant");
        assert.ok(events[0].message.includes("acks before persisting"));
        assert.ok(events[0].message.includes("[edit]"));
        assert.ok(events[0].message.includes("/home/demo/webapp/src/queue.ts"));
    });

    it("ignores session-info files (no role)", () => {
        const filePath = path.join(fixtures, "opencode-legacy", "storage", "session", "prjhash", "ses_legacy_file.json");
        const events = parseOpencodeFile({
            fileContents: fs.readFileSync(filePath, "utf8"),
            filePath,
        });
        assert.deepEqual(events, []);
    });

    it("ignores malformed content", () => {
        assert.deepEqual(parseOpencodeFile({ fileContents: "not json", filePath: "/tmp/x.json" }), []);
    });
});
