import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// SEC-004: config.json holds the raw API key, so a fresh `ultracontext config`
// must never leave it group/world-readable. writeConfig() honors
// ULTRACONTEXT_CONFIG_HOME, so we can point it at a scratch directory.
import { writeConfig, readConfig } from "../../src/cli/onboarding.mjs";

function octal(p) {
  return (fs.statSync(p).mode & 0o777).toString(8);
}

test("writeConfig creates .ultracontext 0700 and config.json 0600 (SEC-004)", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "uc-sec004-"));
  process.env.ULTRACONTEXT_CONFIG_HOME = home;
  try {
    writeConfig({ apiKey: "uc_live_test123", baseUrl: "http://localhost:8787" });

    const dir = path.join(home, ".ultracontext");
    const file = path.join(dir, "config.json");
    assert.equal(octal(dir), "700", "config dir must be 0700");
    assert.equal(octal(file), "600", "config.json must be 0600");
    assert.equal(readConfig().apiKey, "uc_live_test123");
  } finally {
    delete process.env.ULTRACONTEXT_CONFIG_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("writeConfig re-locks an existing world-readable config.json to 0600", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "uc-sec004-"));
  process.env.ULTRACONTEXT_CONFIG_HOME = home;
  try {
    const dir = path.join(home, ".ultracontext");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ apiKey: "uc_live_old" }), "utf8");
    fs.chmodSync(file, 0o644); // simulate a pre-fix install

    writeConfig({ apiKey: "uc_live_new" });
    assert.equal(octal(file), "600", "existing 0644 file must be re-locked");
    assert.equal(readConfig().apiKey, "uc_live_new");
  } finally {
    delete process.env.ULTRACONTEXT_CONFIG_HOME;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
