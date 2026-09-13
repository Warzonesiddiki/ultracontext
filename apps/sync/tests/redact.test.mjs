// =============================================================================
// SEC-006 — transcript redaction: every known secret shape that appears in
// agent transcripts must be gone from what leaves the machine.
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { redact } from "../src/redact.mjs";

// One secret of every kind the board lists — embedded in a realistic
// agent-transcript fragment (tool output + a pasted .env + code + chat).
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const ASIA_KEY = "ASIAIOSFODNN7EXAMPL1";
const GITHUB_PAT = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ12";
const GITHUB_FINE = "github_pat_11ABCDEFGH1234567890ab";
// deliberately "FAKE" — must match the redaction pattern's shape without
// tripping GitHub push protection's Slack token detector
const SLACK_TOKEN = "xoxb-FAKE000000-FAKEFAKEFAKEFAKE";
const PEM_BLOCK = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEpAIBAAKCAQEA7v5x",
  "QWQWQWQWQWQWQWQWQWQWQWQW",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
const PG_DSN = "postgres://dbadmin:hunter2secret@db.internal:5432/app";
const MONGO_DSN = "mongodb+srv://reader:pass123@cluster0.example.net/app?retryWrites=true";
const ENV_BLOCK = [
  "DATABASE_PASSWORD=S3cretPW",
  "OPENAI_API_KEY=sk-abcdef1234567890abcdef1234567890",
  "GITHUB_TOKEN=ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ12",
  "SLACK_BOT_TOKEN=xoxb-FAKE000000-FAKEFAKEFAKEFAKE",
].join("\n");

const TRANSCRIPT = [
  '{"role":"user","content":"deploy the service to production now"}',
  `{"role":"assistant","content":"I set the keys: uc_live_Zz9Yy8Xx7Ww6 for the API and ${AWS_KEY} for AWS (temporary ${ASIA_KEY} also active). GitHub ${GITHUB_PAT} and fine-grained ${GITHUB_FINE} are in the repo. Slack uses ${SLACK_TOKEN}."}`,
  `{"role":"tool","content":"Authorization: Bearer 9f8e7d6c5b4a3210feed\nGoogle key AIzaSyA1234567890abcdefghijklmnop\nJWT for the gateway: ${JWT}"}`,
  `{"role":"tool","content":"pasted env file:\\n${ENV_BLOCK}"}`,
  `{"role":"tool","content":"dsn: ${PG_DSN} and ${MONGO_DSN}"}`,
  `{"role":"assistant","content":"the cert material was:\\n${PEM_BLOCK}\\nrotated now."}`,
  `{"role":"assistant","content":"note: totally innocent sentence with no secrets at all"}`,
].join("\n");

describe("redact — SEC-006 transcript coverage", () => {
  it("leaves zero matches of every secret in the fixture transcript", () => {
    const out = redact(TRANSCRIPT);
    const secrets = [
      AWS_KEY,
      ASIA_KEY,
      GITHUB_PAT,
      GITHUB_FINE,
      SLACK_TOKEN,
      PEM_BLOCK,
      JWT,
      "hunter2secret",
      "pass123",
      "S3cretPW",
      "sk-abcdef1234567890abcdef1234567890",
      "9f8e7d6c5b4a3210feed",
      "AIzaSyA1234567890abcdefghijklmnop",
      "uc_live_Zz9Yy8Xx7Ww6",
    ];
    for (const secret of secrets) {
      assert.ok(!out.includes(secret), `leaked: ${secret.slice(0, 12)}…`);
    }
    // the PEM inner base64 must be gone with the block
    assert.ok(!out.includes("MIIEpAIBAAKCAQEA7v5x"));
  });

  it("keeps the transcript readable — harmless content and context survive", () => {
    const out = redact(TRANSCRIPT);
    assert.ok(out.includes("deploy the service to production now"));
    assert.ok(out.includes("totally innocent sentence with no secrets at all"));
    // connection-string hostnames survive, only the password is masked
    assert.ok(out.includes("dbadmin:***@db.internal:5432/app"));
    assert.ok(out.includes("reader:***@cluster0.example.net"));
    // .env keys survive, values do not
    assert.ok(out.includes("DATABASE_PASSWORD=***"));
    // vendor markers survive so a human can see WHAT was redacted
    assert.ok(out.includes("Bearer ***"));
    assert.ok(/AKIA\*\*\*/.test(out));
  });

  it("masks AWS key ids in longer text and leaves ordinary words alone", () => {
    const out = redact(`aws configure set aws_access_key_id ${AWS_KEY} --profile prod`);
    assert.ok(!out.includes(AWS_KEY));
    assert.ok(out.includes("--profile prod"));
    // AKIA-ish word inside longer mixed-case text must not false-positive
    assert.equal(redact("the akia bird flew"), "the akia bird flew");
  });

  it("redacts sensitive object keys and recurses through arrays", () => {
    const out = redact({
      name: "alice",
      password: "hunter2",
      headers: { authorization: "Bearer abcdef123456", "x-plain": "ok" },
      list: [{ secret_token: "abc123" }, "plain"],
      42: "number key is fine",
    });
    assert.equal(out.name, "alice");
    assert.equal(out.password, "***REDACTED***");
    assert.equal(out.headers.authorization, "***REDACTED***");
    assert.equal(out.headers["x-plain"], "ok");
    assert.equal(out.list[0].secret_token, "***REDACTED***");
    assert.equal(out.list[1], "plain");
    assert.equal(out["42"], "number key is fine");
  });

  it("handles null, scalars, and non-object leaves", () => {
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
    assert.equal(redact(3.14), 3.14);
    assert.equal(redact(true), true);
  });
});
