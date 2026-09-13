// =============================================================================
// PROM-001 — daemon message metadata carries wall-clock time (occurred_at)
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventOccurredAt } from "../src/utils.mjs";

describe("eventOccurredAt", () => {
  it("normalises ISO timestamps to canonical ISO text", () => {
    assert.equal(eventOccurredAt("2026-09-01T10:00:00.000Z"), "2026-09-01T10:00:00.000Z");
  });

  it("normalises epoch-ms timestamps to ISO text", () => {
    // new Date(1788256800000) === 2026-09-01T10:00:00.000Z
    assert.equal(eventOccurredAt(1788256800000), "2026-09-01T10:00:00.000Z");
  });

  it("accepts epoch-ms given as a string (parsers are inconsistent)", () => {
    // new Date("1788256800000") is Invalid in V8 — must route through Number()
    assert.equal(eventOccurredAt("1788256800000"), "2026-09-01T10:00:00.000Z");
  });

  it("falls back to ingestion time for missing timestamps", () => {
    const before = Date.now();
    const value = eventOccurredAt(undefined);
    const after = Date.now();
    const t = new Date(value).getTime();
    assert.ok(t >= before && t <= after, `expected between ${before} and ${after}, got ${t}`);
  });

  it("falls back to ingestion time for unparseable timestamps", () => {
    const value = eventOccurredAt("not-a-date");
    assert.ok(!Number.isNaN(new Date(value).getTime()));
  });
});
