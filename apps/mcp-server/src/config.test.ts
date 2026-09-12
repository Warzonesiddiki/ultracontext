// config.ts — local-first configuration resolution (FREE-007)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "./config";

/** Run fn with selected env vars overridden (restored afterwards). */
function withEnv(overrides: Record<string, string | undefined>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

function tmpHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "uc-mcp-config-"));
}

test("explicit env always wins", () => {
    withEnv(
        { ULTRACONTEXT_API_KEY: "uc_live_env", ULTRACONTEXT_BASE_URL: "http://127.0.0.1:9999", ULTRACONTEXT_HOME: "/nonexistent-home" },
        () => {
            const c = loadConfig();
            assert.equal(c.source, "env");
            assert.equal(c.apiKey, "uc_live_env");
            assert.equal(c.baseUrl, "http://127.0.0.1:9999");
        }
    );
});

test("env key without base URL falls back to the hosted default", () => {
    withEnv({ ULTRACONTEXT_API_KEY: "uc_live_env" }, () => {
        delete process.env.ULTRACONTEXT_BASE_URL;
        const c = loadConfig();
        assert.equal(c.baseUrl, "https://api.ultracontext.ai");
    });
});

test("local server.json is used when no env key exists", () => {
    const home = tmpHome();
    try {
        fs.writeFileSync(
            path.join(home, "server.json"),
            JSON.stringify({ apiKey: "uc_live_local", port: 9002, adminKey: "uc_admin_x" })
        );
        withEnv({ ULTRACONTEXT_API_KEY: undefined, ULTRACONTEXT_BASE_URL: undefined, ULTRACONTEXT_HOME: home }, () => {
            const c = loadConfig();
            assert.equal(c.source, "local");
            assert.equal(c.apiKey, "uc_live_local");
            assert.equal(c.baseUrl, "http://127.0.0.1:9002");
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("local server.json without a recorded port uses 8787", () => {
    const home = tmpHome();
    try {
        fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ apiKey: "uc_live_local" }));
        withEnv({ ULTRACONTEXT_API_KEY: undefined, ULTRACONTEXT_BASE_URL: undefined, ULTRACONTEXT_HOME: home }, () => {
            assert.equal(loadConfig().baseUrl, "http://127.0.0.1:8787");
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test("hosted config.json is the last fallback", () => {
    const home = tmpHome();
    try {
        fs.mkdirSync(home, { recursive: true });
        fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ apiKey: "uc_live_cfg", baseUrl: "http://127.0.0.1:8888" }));
        withEnv({ ULTRACONTEXT_API_KEY: undefined, ULTRACONTEXT_BASE_URL: undefined, ULTRACONTEXT_HOME: home }, () => {
            const c = loadConfig();
            assert.equal(c.source, "config");
            assert.equal(c.apiKey, "uc_live_cfg");
            assert.equal(c.baseUrl, "http://127.0.0.1:8888");
        });
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
