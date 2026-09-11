# UltraContext — Engineering Audit & Improvement Plan

**Date:** 2026-09-11 · **Commit audited:** `736b471` (main) · **Branch:** `arena/01a08f10-ultracontext`

---

## 1. Scope & method

Full-repo review across architecture, security, correctness, performance, developer
experience, and documentation. Everything below was verified by reading code and
running it locally — nothing is inferred from the docs alone.

**Environment:** Node v22.22.3 · pnpm 10.28.1 · Python 3.11.2 · clean `pnpm install --frozen-lockfile`

### Verification commands run

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ✅ 338 packages — ⚠️ 2 warnings (see BUILD-001/002) |
| `pnpm check` (typecheck all) | ✅ pass — but only covers 3 of 10 workspace packages (CI-002) |
| `packages/core` tests | ✅ 158 / 158 pass |
| `packages/storage` tests | ✅ 2 / 2 pass |
| `packages/parsers` tests | ❌ **68 / 69 — 1 failing** (TEST-001) |
| `apps/js-sdk` tests | ✅ 30 / 30 pass |
| `apps/sync` tests | ✅ 10 / 10 pass |
| `apps/api` tests | ✅ 23 / 23 pass |
| `apps/mcp-server` | ⚠️ no `test` or `check` script exists |
| `apps/python-sdk` | ⚠️ no test files exist at all (TEST-002) |
| Cross-tenant fork PoC | ❌ **leak confirmed** (SEC-001) |

---

## 2. What's already good

Worth naming, so the plan below doesn't read as a blanket criticism.

- **The `StorageAdapter` seam is genuinely well designed.** Three backends
  (Drizzle/Postgres, Supabase REST, SQLite) behind one narrow interface, with ops in
  `packages/core` as pure capabilities returning a `Result` that the Hono layer maps to
  HTTP status. That's why the SQLite adapter landed in one commit.
- **Capability-layer test coverage is strong.** 158 tests in `packages/core`, run against
  a `MemoryStorage` adapter via a shared smoke suite — the "run every op against a swappable
  adapter" pattern is exactly right and is the highest-leverage test asset in the repo.
- **Tenant scoping is correct almost everywhere.** `project_id` is threaded from auth into
  every op; 11 of 12 adapter methods are project-scoped. SEC-001 is a single-line slip
  inside an otherwise disciplined design.
- **The permanent-delete disambiguation in `DELETE /contexts/:id`** — requiring an explicit
  `{"permanent": true}` and rejecting ambiguous bodies — is careful, defensive API design.
- **Redaction exists at all.** Most ingestion tools ship nothing. SEC-006 is about depth,
  not absence.

---

## 3. Findings summary

| Severity | Count | Meaning |
|---|---|---|
| 🔴 **P0 — Critical** | 5 | Security / data integrity. Fix now. |
| 🟠 **P1 — High** | 15 | Correctness or reliability bug. Fix this sprint. |
| 🟡 **P2 — Medium** | 20 | Architecture, DX, or coverage gap. Next sprint. |
| 🔵 **P3 — Low** | 8 | Polish and hygiene. |
| | **48** | |

---

## 4. P0 — Critical

### SEC-001 · Cross-tenant context read via unscoped fork lookup 🔴

**Location:** `packages/core/src/ops/create-context.ts:82`
**Also:** `packages/storage/src/{drizzle.ts:53, supabase.ts:73, sqlite/index.ts:68}`, `packages/core/src/testing/memory-adapter.ts:43`

`createContext` resolves the `from` fork target with:

```ts
const sourceCtx = await storage.findRootContextByPublicId(from);   // ← no projectId
```

Every other lookup is project-scoped. This one is not, in **all four** adapters. So
`POST /contexts {"from": "<another tenant's ctx id>"}` copies that tenant's messages into
the attacker's own project, where they can be read normally.

**Confirmed with a working PoC** (two projects, one shared adapter):

```
Tenant A ctx id  : ctx_04b14ebd057c70c2c5c208a7
Tenant B fork    : {"ok":true,"data":{"id":"ctx_dfd4c80e680ff2a559a1a03b", ...}}
Tenant B reading : ["My AWS_SECRET is AKIAIOSFODNN7EXAMPLE"]

CROSS-TENANT LEAK: CONFIRMED
```

**Why it's not intentional:** see the analysis in §7 — forking is documented as a personal
history operation, no share/ACL concept exists, and no product flow can surface a foreign
context id. **Fixing this does not affect the "same context everywhere" promise**, which
operates within a project via a shared API key.

**Fix:** one line — use the project-scoped variant that already exists in all four adapters:

```ts
const sourceCtx = await storage.findRootContext(projectId, from);
```

Then add a regression test asserting `createContext(storage, 2, { from: tenantAContextId })`
returns `not_found`.

**Mitigating factor (not a fix):** context ids are 12 random bytes (`ctx_` + 24 hex), so
they aren't guessable. They do leak routinely through the MCP server, logs, dashboards, and
anything a user has ever shared — which is why this must be closed.

---

### SEC-002 · CORS `Access-Control-Allow-Origin: *` on an authenticated API 🔴

**Location:** `apps/api/src/middleware/cors.ts:6-10`

```ts
c.header('Access-Control-Allow-Origin', '*');
c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
```

Any origin on the internet may drive the API with a bearer token. Combined with SEC-005
(no rate limiting) this is a ready-made exfiltration and abuse channel.

**Fix:** replace `*` with an echo of an allowlisted origin set (your dashboard domains,
`http://localhost:*` for dev). Drop `Vary: Origin` only if you truly go static. Never pair
`*` with `Authorization`.

---

### SEC-003 · Timing-unsafe secret comparisons 🔴

**Locations:**
- `apps/api/src/middleware/auth.ts:100` — `return token === expected;` (admin key)
- `packages/core/src/ops/verify-key.ts:23` — `hash !== tokenRow.key_hash`
- `apps/api/src/middleware/auth.ts:64` — `cached.keyHash === hash`

**Fix:** `crypto.timingSafeEqual` on equal-length `Buffer`s (length-check first, and use a
constant-length comparison so length itself doesn't leak). Low practical risk today, but
it's cheap to fix and it's the kind of thing that shows up in a security review.

---

### SEC-004 · API key stored world-readable 🔴

**Locations:** `apps/js-sdk/src/cli/onboarding.mjs:155` (writes `apiKey`),
`apps/sync/src/daemon.mjs` `writeConfigJson` / `writeStatusJson`

`~/.ultracontext/config.json` holds the raw API key. **There is no `chmod` call anywhere in
the repository** (`grep -rn "chmod|0o600" apps packages` → zero hits), so the file is created
with the default umask — typically `0644`, readable by every user and process on the machine.
`status.json` is written the same way.

**Fix:** write with `mode: 0o600` and `fs.mkdir(..., { mode: 0o700 })`; on read, warn if the
mode is broader than `0600`.

---

### SEC-005 · No rate limiting, no key lifecycle 🔴

**Locations:** `apps/api/src/routes/keys.ts`, `apps/api/src/app.ts`

- `POST /v1/keys` is unthrottled and creates a project **plus** an API key per call → trivial
  resource exhaustion.
- No `DELETE` / list / rotate / revoke endpoint. A leaked key can never be invalidated.
- No scopes (read-only vs read-write), no expiry, no per-project key cap.
- No rate limit on auth failures → unthrottled admin-key and API-key guessing.

**Fix:** at minimum, per-key token bucket (KV on Workers, in-memory/LRU on Node), a
`DELETE /v1/keys/:prefix` revoke endpoint, and `last_used_at`-based expiry warnings.
Key rotation and scopes are prerequisites for team use.

---

## 5. P1 — High

### DATA-001 · Production runs with no transactional atomicity 🟠

**Location:** `packages/storage/src/supabase.ts:189-193`

```ts
async transaction<T>(fn, _options?) { return fn(this); }   // ← no-op
```

The comment is honest about it, but the consequence is severe: **your production deployment
is the Supabase one** (`wrangler.jsonc` routes `api.ultracontext.ai` to it). Every
copy-on-write update and every permanent delete is a sequence of independent REST calls
with no atomicity. A crash mid-operation leaves orphaned version heads and half-copied
message chains — silent corruption of the version history, which is the product's core value.

`appendMessages` explicitly requests `isolationLevel: 'serializable'` and the comment says
"client retries" — on Supabase that flag is silently discarded.

**Fix (in order of preference):**
1. Move the Worker to real Postgres (Cloudflare Hyperdrive, or Supabase's connection
   pooler via a Postgres driver) so `transaction()` is real.
2. Otherwise, implement the multi-statement operations as Postgres functions and call them
   via `rpc()` — one HTTP call, atomic server-side.
3. If neither is near-term, add a reconciliation job + integrity checker, and **document
   the limitation publicly.**

---

### DATA-002 · SQLite schema missing UNIQUE constraints 🟠

**Location:** `packages/storage/src/sqlite/schema.ts`

Postgres has `nodes.public_id UNIQUE` and `api_keys.key_prefix UNIQUE`. The SQLite DDL has
neither. Consequences:
- `findApiKeyByPrefix` returns `LIMIT 1` — a prefix collision silently routes one key's
  traffic to another project.
- `generatePublicId` collisions (birthday bound at ~2⁴⁸ for 12 bytes — low, but the DB is
  the backstop) would create duplicate node ids and corrupt the linked list silently.

**Fix:** add `UNIQUE` to `nodes.public_id` and `api_keys.key_prefix` in both the DDL and the
Drizzle schema. Needs a migration path (see DATA-004).

---

### DATA-003 · SQLite: no foreign keys, no cascade 🟠

**Location:** `packages/storage/src/sqlite/schema.ts`, `packages/storage/src/sqlite/index.ts`

`PRAGMA foreign_keys` is never set (defaults **off**), and the DDL has no `REFERENCES` /
`ON DELETE CASCADE` — unlike Postgres, where deleting a project cascades. Deleting a project
via SQLite orphans its `api_keys` and `nodes` rows forever.

**Fix:** add FKs + `ON DELETE CASCADE` to the DDL; execute `PRAGMA foreign_keys = ON` on
connect. (Note: `apps/sync/src/store.mjs` already sets `WAL` and `synchronous = NORMAL` —
apply the same rigour here. It should also set a `busy_timeout`.)

---

### DATA-004 · No migration tooling; three sources of schema truth 🟠

`apps/postgres/init.sql` is `CREATE TABLE IF NOT EXISTS` only — no versions, no up/down.
The Drizzle schema in `db.ts` is a **second** definition, and the SQLite schema is a
hand-maintained **third**. They have already drifted (DATA-002, DATA-003). Without
migrations, shipping the UNIQUE-constraint fix to existing databases is impossible.

**Fix:** adopt `drizzle-kit` (you already depend on Drizzle) for Postgres; add a
`schema_version` table + ordered migration array for SQLite. Generate both from one
canonical definition where possible. This is a prerequisite for DATA-002 and DATA-003.

---

### BUILD-001 · The daemon ships against a 4-minor-version-old SDK 🟠

**Location:** `apps/sync/package.json` — `"ultracontext": "^1.0.1"`

`apps/sync` resolves `ultracontext@1.0.2` **from the npm registry**, while the workspace SDK
is at **1.5.0**:

```
apps/sync/node_modules/ultracontext -> node_modules/.pnpm/ultracontext@1.0.2/...
```

So the daemon and TUI — the code every user actually runs — are built against a stale
published package, and local development never exercises the workspace SDK. Any SDK fix you
make is invisible to the CLI until you publish.

**Fix:** `"ultracontext": "workspace:*"` (matching how `apps/js-sdk` already declares
`@ultracontext/sync` as a workspace devDependency).

---

### BUILD-002 · `ultracontext-mcp` bin is broken; build script is a no-op 🟠

**Location:** `apps/mcp-server/package.json`

- `bin` points at `./dist/stdio.js`, which is never produced.
- `"build": "tsx src/stdio.ts --help || true"` — starts the server, and `|| true` makes it
  **always succeed**. This is why install prints:
  `WARN Failed to create bin ... ENOENT: no such file or directory, open '.../dist/stdio.js'`

**Fix:** real `tsdown`/`tsc` build emitting `dist/`, drop `|| true`, add `test` + `check`
scripts, and add a CI job that asserts the declared `bin` paths exist.

---

### TEST-001 · Failing test in `packages/parsers` 🟠

**Location:** `packages/parsers/tests/writers/claude.test.mjs:97`

```js
assert.ok(entry.message.content.includes("[system]"));
```

`content` is an **array of objects** (`[{ type: "text", text: "[system] Context loaded" }]`),
so `.includes(string)` is always `false`. Verified by execution:

```
content = [{"type":"text","text":"[system] Context loaded"}]
content.includes("[system]") = false
```

**The production code is correct — the assertion is wrong.** Fix:

```js
assert.ok(entry.message.content[0].text.includes("[system]"));
```

Note this test has been asserting the wrong thing the whole time, so the behaviour was never
actually covered.

---

### TEST-002 · Python SDK has zero tests 🟠

`apps/python-sdk/pyproject.toml` declares `pytest`, `pytest-asyncio`, and `mypy` dev deps,
and `AGENTS.md` states *"Add tests with `*.test.*` or `*.spec.*`"* and *"Python SDK dev
tooling is defined in `apps/python-sdk/pyproject.toml` (`pytest`, `pytest-asyncio`, `mypy`)"*.
There are **no test files** and no CI runs either tool. `mypy` is configured `strict = true`
but never invoked.

**Fix:** port the JS SDK's test cases (30 tests) to pytest with an `httpx.MockTransport`;
add `mypy` to CI. Start with `delete_many`'s 200/207/500 handling and error mapping.

---

### SEC-006 · Redaction misses common secret formats 🟠

**Location:** `apps/sync/src/redact.mjs`

Covered: `uc_live_/uc_test_`, `sk-`, `Bearer`, `AIza`. **Not covered:** AWS access keys
(`AKIA…`), GitHub tokens (`ghp_`, `github_pat_`), Slack (`xox…`), PEM private key blocks
(`-----BEGIN … PRIVATE KEY-----`), JWTs, connection strings with embedded passwords,
`.env` file contents. Agent transcripts contain these constantly — and this data leaves the
machine to a hosted API.

**Fix:** extend the pattern list with the above (especially the PEM block, which is
multi-line and needs a `[\s\S]` regex, not a per-string scan); make the list configurable;
document exactly what is and isn't redacted so users can make an informed choice.

---

### API-001 · `limit` query param is unvalidated 🟠

**Location:** `apps/api/src/routes/contexts.ts:40` → `packages/core/src/ops/list-contexts.ts`

```ts
const limit = parseInt(c.req.query('limit') ?? '20');
```

`?limit=abc` → `NaN` → `.limit(NaN)` (a 500, or worse). `?limit=0`, `?limit=-5`, and
`?limit=1000000` all pass straight through with no ceiling — the last is a trivial
denial-of-service vector on a large project.

**Fix:** clamp and reject — parse strictly, fall back to 20 on `NaN`, clamp to `[1, 100]`.

---

### API-002 · `version` / `at` params use permissive `parseInt` 🟠

**Locations:** `packages/core/src/ops/get-context.ts:64,96`, `create-context.ts:92,122`

`parseInt("1abc") === 1`, `parseInt("1.9") === 1`, `parseInt(" 1 ") === 1`. `?version=1xyz`
silently resolves to version 1 rather than 400.

**Fix:** a shared `parseIndex()` helper using `Number()` + `Number.isInteger()`, or validate
with zod (see API-009).

---

### API-003 · Retryable failures are indistinguishable from fatal ones 🟠

**Location:** `packages/core/src/ops/append-messages.ts:70-72`

```ts
} catch {
    return err('internal', 'Failed to append messages');   // 500
}
```

The comment says Postgres SSI makes one side fail with `40001` and *"client retries"* — but
the API returns a flat `500` with no `Retry-After`, no `409`, and no machine-readable code.
Clients cannot tell "try again" from "your data is gone." The original error is swallowed.

**Fix:** add a `'conflict'` code to `ErrorCode` → HTTP `409` + `Retry-After`. Log the
underlying error. Consider one internal retry with jitter.

---

### API-004 · Every PATCH rewrites every message node 🟠

**Location:** `packages/core/src/ops/update-messages.ts:118-140`

Copy-on-write clones **all** message nodes under a new head on each update — O(n) inserts
per edit, with no cap on context size. A 10k-message context costs 10k row inserts to change
one word. There's also no ceiling on nodes per context or messages per append.

**Fix (near-term):** enforce `MAX_MESSAGES_PER_CONTEXT` and `MAX_MESSAGES_PER_APPEND`.
**Fix (structural):** store patches/deltas rather than full copies, materialising a version
only on read (with periodic snapshots). This is the single biggest scalability limit in the
current design.

---

### API-005 · `last_used_at` written on every request 🟠

**Location:** `apps/api/src/middleware/auth.ts:19-26, 105`

Every authenticated request performs an extra `UPDATE api_keys` round-trip, awaited before
`next()` — so it's on the latency path for 100% of traffic. On Workers that's an extra
Supabase call per request.

**Fix:** throttle to at most once per N minutes per key (in-memory `Map` on Node, KV on
Workers with a short TTL marker), or batch via a queue/tail worker.

---

### API-006 · No request body size limit 🟠

`c.req.json()` is called with no cap in `POST /contexts/:id` (append) and
`PATCH /contexts/:id`. A single request can carry unbounded payloads.

**Fix:** explicit `Content-Length` check plus a streaming/parse cap; return `413` over the
limit. Pair with API-004's per-append message cap.

---

## 6. P2 — Medium

### Process & CI

| ID | Finding | Location | Fix |
|---|---|---|---|
| **CI-001** | **No CI on pull requests.** The only workflow is `publish.yml` (release → npm + PyPI). Nothing runs tests, typecheck, or lint on PRs — and the parsers suite is currently red, which CI would have caught. | `.github/workflows/` | Add `ci.yml`: install → `pnpm check` → all test suites → Python `pytest` + `mypy` → build → verify `bin` paths exist. |
| **CI-002** | `pnpm check` only covers **3 of 10** workspace packages (core, storage, sync). `apps/api`, `apps/js-sdk`, `apps/mcp-server`, `packages/parsers` define no `check`. There is **no root `test` script**. | root `package.json` | Add `check` to every package; add a root `test` that runs the full matrix; consider Turborepo for caching/ordering. |
| **DX-001** | No formatter or linter. `CLAUDE.md` documents indentation conventions *prose-style* per package, enforced only by human discipline. | repo root | Biome or Prettier + ESLint, one config, `pnpm format`, `--check` in CI. |
| **DX-002** | `tsconfig.json` duplicated in 4 packages with no shared base. | `*/tsconfig.json` | Add `packages/tsconfig/base.json`; extend it everywhere. |
| **DX-003** | No `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, or `.github/dependabot.yml`. For a project handling users' agent transcripts, a disclosure policy is table stakes. | `.github/` | Add all four. |

### Documentation drift

| ID | Finding | Fix |
|---|---|---|
| **DOC-001** | `AGENTS.md` documents `apps/daemon` and `apps/tui` (merged into `apps/sync`) and `packages/protocol` (doesn't exist); references `pnpm dev:daemon`; describes the API as "Hono + Drizzle" only, missing Supabase and SQLite. | Rewrite against the current tree; add a CI check that flags documented paths that don't exist. |
| **DOC-002** | `CLAUDE.md` contains a **"Skill routing"** section referencing personal agent skills (`office-hours`, `investigate`, `ship`, `qa`, `retro`, `plan-eng-review`…) that don't exist in this repo, and instructs *"ALWAYS invoke it… Do NOT answer directly."* This is one developer's private agent config in a public OSS repo — it will confuse contributors and over-constrain other coding agents. | Move to `CLAUDE.local.md` (git-ignored) or delete. Keep only repo-wide facts in `CLAUDE.md`. |
| **DOC-003** | `apps/docs/changelog.mdx` has **one** entry (Jan 1, 2026) while the JS SDK is at v1.5.0. README's Star History badge points at the old repo name `ultracontext/ultracontext-node`. | Backfill the changelog from git history; fix the badge. Consider auto-generating from Conventional Commits. |

### API surface & operations

| ID | Finding | Fix |
|---|---|---|
| **API-007** | No health endpoint — only `GET /` returning a welcome message. | Add `/health` (liveness) and `/health/ready` (DB ping). |
| **API-008** | No structured logging or request IDs. Scattered `console.log`/`console.info`; `wrangler.jsonc` has `observability.enabled: false`. | Tiny JSON logger emitting `request_id`, `project_id`, `route`, `duration_ms`, `status`; propagate a request id; enable Workers observability. |
| **API-009** | **No request validation.** Routes do ad-hoc `c.req.json()` with `body: any` casts. `zod` is already a dependency — but only `apps/mcp-server` uses it; the API doesn't. `apps/docs/api-reference/openapi.json` is hand-maintained and free to drift. | `@hono/zod-validator` with shared schemas; generate `openapi.json` from them (or from Hono's route types) so docs can't drift. This also removes every `any` cast in the route layer. |
| **API-010** | No pagination on `GET /contexts/:id` — a large context returns in full. | Add `limit`/`offset` or cursor pagination; default cap. |
| **API-011** | Permanent deletes leave no durable audit trail — `auditMetadata` is only `console.info`'d (`contexts.ts:145`). | Persist an append-only audit record before the wipe. |
| **OPS-001** | No Docker image or `build`/`start` script for the API. The self-hosting guide tells users to run `tsx src/server.ts`. | Dockerfile + published image + `build`/`start` scripts; compose file including the API. |

### SDKs

| ID | Finding | Fix |
|---|---|---|
| **SDK-001** | Python client opens and **closes a new `httpx.Client` on every request** — no connection pooling, no keep-alive, no retry, no backoff. | Persistent client (context-manager friendly), `transport` with retries, exponential backoff on 429/5xx, honour `Retry-After`. |
| **SDK-002** | JS SDK has no retry, no default timeout, and `timeoutMs` is opt-in (defaults to none). | Default timeout (~30s), retry with backoff on 429/5xx and network errors, `AbortSignal` passthrough. |

### Architecture

| ID | Finding | Fix |
|---|---|---|
| **ARCH-001** | No branch naming or HEAD pointer. `findHead` picks the newest branch by `created_at` — with multiple forks, "HEAD" is ambiguous and ties are nondeterministic. Versions are addressable **only by index**, and indices shift as new versions appear, so a saved `?version=3` silently means something else later. | Named branches / immutable version ids; keep index addressing as a deprecated alias. |
| **ARCH-002** | `orderNodes` falls back to `created_at` sorting on a broken chain, logging only via `console.error`. With ISO-ms timestamps ties are possible → nondeterministic message order. | Emit a metric/alert on fallback; consider persisting an explicit ordinal alongside `prev_id`. |
| **ARCH-003** | `apps/sync/src/tui.mjs` is **1,835 lines** and `daemon.mjs` **1,242**. The daemon mixes config, logging, IPC, source discovery, offset tracking, bootstrap, ingestion, stats, and command handling. | Extract `logger.mjs`, `ipc.mjs`, `sources.mjs`, `ingest.mjs`, `stats.mjs`. |
| **PERF-001** | The daemon runs `fast-glob` over `~/**` session trees every **1,500 ms** (`DAEMON_POLL_MS`), and `primeOffsetsToEof` reads whole files for JSON sources. On a machine with thousands of session files this is continuous filesystem churn. | `fs.watch`/inotify with polling fallback, adaptive backoff when idle, mtime pre-filtering. |
| **TEST-003** | The API's HTTP layer is untested — only `delete-contexts.test.ts` (23 tests) exists. No coverage for auth middleware, CORS, `/v1/keys`, `/mcp`, or config. | Add route tests against `MemoryStorage` (the pattern already works well in `packages/core`). |
| **TEST-004** | The SQLite adapter has **2** tests vs core's 158. | Run the core smoke suite against all three adapters via a shared conformance harness — this is the highest-value test investment available. |

### Security hygiene

| ID | Finding | Fix |
|---|---|---|
| **SEC-007** | `findRootContextByPublicId` remains on the `StorageAdapter` interface after the SEC-001 fix — an unscoped footgun that invites reintroduction. | Remove it from the interface and all four adapters once SEC-001 lands. |

---

## 7. On the cross-tenant question

Worth recording explicitly, since it determines whether SEC-001 is a bug or a feature.

**Sharing across AI harnesses is by design, and it is unaffected.** One API key maps to one
project; all of a user's agents use the same key, so they share one context pool. That is the
mechanism behind "same context, everywhere," and it lives entirely *within* a project.

**What SEC-001 crosses is the *project* boundary**, and the evidence says it's an oversight:

1. `findRootContextByPublicId` is the **only** unscoped method among twelve — the lone
   outlier in an otherwise disciplined interface.
2. All seven route handlers thread `projectId` from auth into every op; `createContext`
   receives it, uses it for inserts, and omits it for the source lookup.
3. `apps/docs/guides/fork-clone-contexts.mdx` frames forking as personal history —
   *"capture that perfect moment… branch in new directions while keeping the original
   intact."* No share, public, or ACL concept exists anywhere in the codebase.
4. No product flow can surface a foreign context id: the MCP server only ever lists the
   caller's own project.

**However** — the README promises team-shaped things (*"What's the team building today?"*,
*"What is Alex working on in Codex right now?"*). If cross-user visibility is a genuine
product goal, it should be built deliberately: explicit sharing, read-only grants, membership,
and an audit trail. Today the system is the worst of both worlds — accidentally open, with no
UI, no consent, no scoping, and no logging.

**Recommendation:** close SEC-001 now (one line), then design team sharing as its own
feature (P2) with a real authorisation model.

---

## 8. Prioritised roadmap

### Phase 1 — Stop the bleeding (this week)

1. **SEC-001** — scope the fork lookup to the project + regression test. *(one line; ships today)*
2. **SEC-002** — replace the CORS wildcard with an origin allowlist.
3. **SEC-004** — write `config.json` / `status.json` with mode `0600`.
4. **TEST-001** — fix the broken parsers assertion so the suite is green.
5. **CI-001** — add PR CI so nothing else lands broken.

### Phase 2 — Correctness (this sprint)

6. **DATA-004** → **DATA-002** → **DATA-003** — migrations first, then the SQLite constraints.
7. **DATA-001** — real transactions on the production backend (highest-risk item here).
8. **BUILD-001** — point `apps/sync` at `workspace:*`.
9. **BUILD-002** — real mcp-server build; fix the broken bin.
10. **SEC-003**, **SEC-005**, **SEC-006** — timing-safe compares, rate limits + revoke, redaction depth.
11. **API-001/002/006** — validate `limit`, `version`, `at`; cap body sizes.

### Phase 3 — Hardening & leverage (next sprint)

12. **TEST-004** — adapter conformance harness (run core's 158 tests against all three backends).
13. **TEST-002** / **TEST-003** — Python tests; API HTTP-layer tests.
14. **CI-002**, **DX-001/002/003** — full `check` coverage, formatter, shared tsconfig, community files.
15. **API-009** — zod validation; generate `openapi.json` from schemas.
16. **API-003/004/005/007/008/010/011** — retryable conflicts, size caps, throttled
    `last_used_at`, health, structured logging, pagination, audit trail.

### Phase 4 — Scale & product

17. **SDK-001/002** — pooling, retries, and timeouts in both SDKs.
18. **ARCH-001/002** — named branches and immutable version ids.
19. **ARCH-003**, **PERF-001** — split the god-modules; event-driven ingestion.
20. **OPS-001** — Docker image for the API.
21. **DOC-001/002/003** — fix documentation drift; backfill the changelog.
22. **Team sharing** as a designed feature — if that's the direction.

---

## 9. Appendix — reproducing this audit

```bash
git checkout 736b471
corepack enable && pnpm install --frozen-lockfile

pnpm check                                    # 3 of 10 packages

(cd packages/core    && pnpm test)            # 158 pass
(cd packages/storage && pnpm test)            #   2 pass
(cd packages/parsers && pnpm test)            #   1 FAIL  ← TEST-001
(cd apps/js-sdk      && pnpm test)            #  30 pass
(cd apps/sync        && pnpm test)            #  10 pass
(cd apps/api         && pnpm test)            #  23 pass

# SEC-001 proof of concept
#   createContext(storage, 1, {})              → tenant A context
#   appendMessages(storage, 1, ctxA, [secret])
#   createContext(storage, 2, { from: ctxA })  → succeeds (should be not_found)
#   getContext(storage, 2, forkedId)           → returns tenant A's secret
```

---

*48 findings · 5 critical · 15 high · 20 medium · 8 low*
