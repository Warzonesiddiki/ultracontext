// local-server.mjs — discovery of the local `ultracontext serve` server.json
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localDataHome, readLocalServer } from "../../src/cli/local-server.mjs";

function withHome(fn) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "uc-local-server-"));
    try {
        return fn(home);
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
}

test("localDataHome", () => {
    withHome((home) => {
        // explicit ULTRACONTEXT_HOME wins and is used as-is
        assert.equal(localDataHome({ ULTRACONTEXT_HOME: "/data/uc" }), "/data/uc");
        // otherwise $HOME/.ultracontext
        assert.equal(localDataHome({ HOME: "/data/h" }), path.join("/data/h", ".ultracontext"));
    });
});

test("readLocalServer returns null when nothing is there", () => {
    withHome((home) => {
        assert.equal(readLocalServer({ ULTRACONTEXT_HOME: home }), null);
    });
});

test("readLocalServer parses server.json (key + port)", () => {
    withHome((home) => {
        fs.writeFileSync(
            path.join(home, "server.json"),
            JSON.stringify({ adminKey: "uc_admin_x", apiKey: "uc_live_local123", port: 9001, projectId: 1 })
        );
        const local = readLocalServer({ ULTRACONTEXT_HOME: home });
        assert.deepEqual(local, {
            apiKey: "uc_live_local123",
            port: 9001,
            url: "http://127.0.0.1:9001",
        });
    });
});

test("readLocalServer falls back to the default port 8787", () => {
    withHome((home) => {
        fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ apiKey: "uc_live_local123" }));
        assert.equal(readLocalServer({ ULTRACONTEXT_HOME: home }).url, "http://127.0.0.1:8787");

        fs.writeFileSync(
            path.join(home, "server.json"),
            JSON.stringify({ apiKey: "uc_live_local123", port: "not-a-number" })
        );
        assert.equal(readLocalServer({ ULTRACONTEXT_HOME: home }).port, 8787);
    });
});

test("readLocalServer ignores bad JSON and missing keys", () => {
    withHome((home) => {
        fs.writeFileSync(path.join(home, "server.json"), "{not json");
        assert.equal(readLocalServer({ ULTRACONTEXT_HOME: home }), null);

        fs.writeFileSync(path.join(home, "server.json"), JSON.stringify({ adminKey: "uc_admin_x" }));
        assert.equal(readLocalServer({ ULTRACONTEXT_HOME: home }), null);
    });
});
