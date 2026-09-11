# UltraContext — Taskboard

Companion to [`AUDIT.md`](./AUDIT.md) · **48 findings → 48 tracked tasks**
Updated 2026-09-11 · commit `736b471`

**Legend** — Severity: 🔴 P0 · 🟠 P1 · 🟡 P2 · 🔵 P3 · Effort: `S` ≤1h · `M` ≤1d · `L` ≥1d

> **Severity** and **Phase** are independent axes. Severity is how urgent a finding is;
> Phase is when it gets done. Phase 1 is deliberately small so it can ship this week.

| Severity | Count | | Phase | Count |
|---|---|---|---|---|
| 🔴 P0 | 5 | | 1 — Stop the bleeding | 5 |
| 🟠 P1 | 15 | | 2 — Correctness | 13 |
| 🟡 P2 | 24 | | 3 — Hardening & leverage | 15 |
| 🔵 P3 | 4 | | 4 — Scale, product & hygiene | 15 |
| **Total** | **48** | | **Total** | **48** |

There is also an interactive version: **`taskboard.html`** — open it in a browser to filter by
severity, area, or effort and tick items off as you go (progress persists in `localStorage`).

---

## 🚦 Board

| Now (this week) | Next (this sprint) | Later | Backlog |
|---|---|---|---|
| SEC-001 | DATA-004 | TEST-004 | SDK-001 |
| SEC-002 | DATA-002 | TEST-002 | SDK-002 |
| SEC-004 | DATA-003 | TEST-003 | ARCH-001 |
| TEST-001 | DATA-001 | CI-002 | ARCH-002 |
| CI-001 | BUILD-001 | DX-001 | ARCH-003 |
| | BUILD-002 | DX-002 | PERF-001 |
| | SEC-003 | DX-003 | OPS-001 |
| | SEC-005 | API-009 | DOC-001 |
| | SEC-006 | API-003 | DOC-002 |
| | API-001 | API-004 | DOC-003 |
| | API-002 | API-005 | MISC-001 |
| | API-006 | API-007 | MISC-002 |
| | SEC-007 | API-008 | MISC-003 |
| | | API-010 | MISC-004 |
| | | API-011 | |
| | | TEAM-001 | |

---

## Phase 1 — Stop the bleeding

> Goal: close the security holes and make CI exist. **Everything here is under a day.**

### 🔴 SEC-001 · Scope fork source lookup to the project · `S`
**File:** `packages/core/src/ops/create-context.ts:82`
**Change:** `findRootContextByPublicId(from)` → `findRootContext(projectId, from)`
(the project-scoped method already exists in all four adapters)

**Status: DONE** — 2026-09-11
- [x] Swap the call
- [x] Add regression test: `createContext(storage, 2, { from: tenantAId })` → `not_found`
- [x] Add equivalent tests for `version` / `at` / `before` fork paths
- [x] Verify existing fork tests still pass (they use same-project ids, so they should)

The five new tests were verified to actually catch the bug: reverting the one-line
fix makes all five fail.

**Acceptance:** no adapter method can return a root context outside the caller's project.

---

### 🔴 SEC-002 · Replace CORS wildcard with an origin allowlist · `S`
**File:** `apps/api/src/middleware/cors.ts`
- [ ] Replace `Access-Control-Allow-Origin: *` with an echo from an allowlist env var
- [ ] Default allowlist: `https://ultracontext.ai`, `http://localhost:*` (dev)
- [ ] Keep `Vary: Origin`; never pair `*` with `Authorization`

**Acceptance:** a request with `Origin: https://evil.example` gets no ACAO header.

---

### 🔴 SEC-004 · Write secrets with `0600` · `S`
**Files:** `apps/js-sdk/src/cli/onboarding.mjs:155`, `apps/sync/src/daemon.mjs` (`writeConfigJson`, `writeStatusJson`)
- [ ] `mkdir(..., { mode: 0o700 })` and `writeFile(..., { mode: 0o600 })` for `~/.ultracontext/`
- [ ] Warn on read if the file mode is broader than `0600`
- [ ] Audit every other write into `~/.ultracontext/`

**Acceptance:** `stat -c '%a' ~/.ultracontext/config.json` → `600` after a fresh `ultracontext config`.

---

### 🟠 TEST-001 · Fix broken parsers assertion · `S`
**File:** `packages/parsers/tests/writers/claude.test.mjs:97`
- [ ] `entry.message.content.includes("[system]")` → `entry.message.content[0].text.includes("[system]")`
- [ ] Confirm the suite is green (68 → 69 pass)
- [ ] Grep the suite for other `Array.prototype.includes` misuse

**Acceptance:** `pnpm --filter @ultracontext/parsers test` exits 0.

---

### 🟡 CI-001 · Add pull-request CI · `M`
**File:** new `.github/workflows/ci.yml`
- [ ] Trigger on `pull_request` + `push` to `main`
- [ ] Steps: install → `pnpm check` → all six test suites → Python `pytest` + `mypy` → build
- [ ] Assert every declared `bin` path exists (catches BUILD-002 class of bug)
- [ ] Cache pnpm store

**Acceptance:** CI is required to merge; it would have caught TEST-001. **Blocks Phase 2.**

---

## Phase 2 — Correctness

> Goal: make the data layer trustworthy. **Do DATA-004 first** — the others depend on it.

### 🟠 DATA-004 · Introduce migration tooling · `L`
- [ ] Adopt `drizzle-kit` for Postgres; add `schema_version` table for SQLite
- [ ] Collapse three schema definitions (`db.ts`, `init.sql`, `sqlite/schema.ts`) toward one source
- [ ] Replace `apps/postgres/init.sql`'s bare `CREATE TABLE IF NOT EXISTS` with versioned migrations
- [ ] Document the migration workflow in `CONTRIBUTING.md`

**Acceptance:** a schema change is expressible as a reviewed, reversible migration on both backends.
**Blocks:** DATA-002, DATA-003.

---

### 🟠 DATA-002 · Add missing UNIQUE constraints to SQLite · `M`
**File:** `packages/storage/src/sqlite/schema.ts`
- [ ] `nodes.public_id UNIQUE`, `api_keys.key_prefix UNIQUE` (DDL **and** Drizzle schema)
- [ ] Add covering indexes
- [ ] Migration path for existing databases (via DATA-004)

**Acceptance:** a duplicate `public_id` insert fails loudly instead of silently corrupting the chain.

---

### 🟠 DATA-003 · Foreign keys and cascade in SQLite · `M`
**Files:** `packages/storage/src/sqlite/schema.ts`, `sqlite/index.ts`
- [ ] `PRAGMA foreign_keys = ON` on connect; `busy_timeout` while you're there
- [ ] `REFERENCES ... ON DELETE CASCADE` matching the Postgres schema

**Acceptance:** deleting a project removes its keys and nodes on SQLite as it does on Postgres.

---

### 🟠 DATA-001 · Real transactions on the production backend · `L`
**File:** `packages/storage/src/supabase.ts:189` — `transaction()` is currently a no-op, and
production (`api.ultracontext.ai`) is the Supabase deployment.
- [ ] **Option A (preferred):** move the Worker to real Postgres (Hyperdrive / pooler) so
      `transaction()` is genuine
- [ ] **Option B:** implement multi-statement ops as Postgres functions, call via `rpc()`
- [ ] **Option C (interim):** integrity checker + reconciliation job; document the limitation
- [ ] Either way: stop silently discarding `isolationLevel`

**Acceptance:** killing the process mid-update leaves a consistent chain — never an orphaned head.
**Highest-risk item in this audit.**

---

### 🟠 BUILD-001 · Point `apps/sync` at the workspace SDK · `S`
**File:** `apps/sync/package.json` — `"ultracontext": "^1.0.1"` resolves to **1.0.2** from npm
while the workspace SDK is at **1.5.0**.
- [ ] `"ultracontext": "workspace:*"`
- [ ] Reinstall; confirm the symlink targets the workspace, not `.pnpm/ultracontext@1.0.2`
- [ ] Re-run daemon + TUI tests against the local SDK

**Acceptance:** a change to `apps/js-sdk/src/index.ts` is immediately visible to `apps/sync`.

---

### 🟠 BUILD-002 · Fix the broken `ultracontext-mcp` bin · `M`
**File:** `apps/mcp-server/package.json`
- [ ] Real build (tsdown/tsc) emitting `dist/stdio.js`
- [ ] Delete `"build": "tsx src/stdio.ts --help || true"` — the `|| true` hides all failures
- [ ] Add `test` and `check` scripts
- [ ] Confirm install no longer warns `Failed to create bin ... ENOENT`

**Acceptance:** `npx ultracontext-mcp` runs after a clean build.

---

### 🟠 SEC-003 · Timing-safe secret comparison · `S`
**Files:** `apps/api/src/middleware/auth.ts:64,100`, `packages/core/src/ops/verify-key.ts:23`
- [ ] `crypto.timingSafeEqual` for admin token, stored key hash, and cache hash
- [ ] Length-check first without leaking length
- [ ] Unit test that a one-character difference still fails

---

### 🟠 SEC-005 · Rate limiting and key lifecycle · `L`
- [ ] Per-key token bucket (KV on Workers, LRU on Node) — especially `POST /v1/keys`
- [ ] `DELETE /v1/keys/:prefix` revoke endpoint
- [ ] Key rotation (issue new, keep old valid briefly)
- [ ] Scopes: `read` / `write` / `admin`
- [ ] Rate limit auth failures (blocks admin-key guessing)

**Acceptance:** a leaked key can be revoked within a minute; abuse is throttled.

---

### 🟠 SEC-006 · Deepen transcript redaction · `M`
**File:** `apps/sync/src/redact.mjs`
- [ ] Add: AWS `AKIA…`, GitHub `ghp_`/`github_pat_`, Slack `xox…`, JWTs, connection strings
- [ ] Add multi-line PEM private-key blocks (needs a `[\s\S]` scan, not per-string)
- [ ] Make the pattern list configurable
- [ ] Document precisely what is and isn't redacted

**Acceptance:** a fixture transcript containing all of the above uploads with zero matches.

---

### 🟠 API-001 · Validate `limit` · `S`
**File:** `apps/api/src/routes/contexts.ts:40`
- [ ] Strict parse; `NaN` → 400; clamp to `[1, 100]`; default 20

---

### 🟠 API-002 · Strict integer parsing for `version` / `at` · `S`
**Files:** `get-context.ts:64,96`, `create-context.ts:92,122`
- [ ] Shared `parseIndex()` (`Number()` + `Number.isInteger()`); reject `1abc`, `1.9`, ` 1 `

---

### 🟠 API-006 · Cap request body size · `S`
- [ ] `Content-Length` check + parse cap → `413` over the limit
- [ ] Pair with `MAX_MESSAGES_PER_APPEND` (see API-004)

---

### 🟠 SEC-007 · Remove the unscoped adapter method · `S`

**Status: DONE** — 2026-09-11
- [x] Once SEC-001 lands, delete `findRootContextByPublicId` from the `StorageAdapter`
      interface and all four adapters
- [x] Confirm no callers remain

**Acceptance:** the interface makes the SEC-001 class of bug unrepresentable.

---

## Phase 3 — Hardening & leverage

### 🟡 TEST-004 · Adapter conformance harness · `M`
**Highest-value test investment available.**
- [ ] Extract `packages/core`'s smoke suite into a reusable conformance suite
- [ ] Run it against `MemoryStorage`, `SqliteAdapter`, `DrizzleAdapter`, `SupabaseAdapter`
- [ ] Wire into CI (SQLite always; Postgres via service container; Supabase optional)

**Acceptance:** 158 core ops × 3 real adapters; SQLite goes from 2 tests to ~158.

---

### 🟡 TEST-002 · Python SDK test suite · `M`
**Files:** `apps/python-sdk/` — currently **zero** tests despite declared pytest/mypy deps
- [ ] `httpx.MockTransport`-based tests porting the JS SDK's 30 cases
- [ ] Cover `delete_many` 200/207/500, error mapping, `quote()` encoding
- [ ] Add `pytest` + `mypy` to CI (mypy is `strict = true` but never run)

---

### 🟡 TEST-003 · API HTTP-layer tests · `M`
**File:** `apps/api/src/tests/` — only `delete-contexts.test.ts` exists
- [ ] Auth middleware (valid / invalid / malformed / missing bearer / admin vs key)
- [ ] CORS behaviour (post-SEC-002)
- [ ] `POST /v1/keys`, `/mcp`, config resolution
- [ ] Use `MemoryStorage` — the pattern already works in `packages/core`

---

### 🟡 CI-002 · Full `check` coverage + root `test` · `S`
- [ ] Add `check` to `apps/api`, `apps/js-sdk`, `apps/mcp-server`, `packages/parsers`
      (currently 3 of 10 packages are covered)
- [ ] Root `test` script running every suite
- [ ] Consider Turborepo for ordering and caching

---

### 🟡 API-009 · Zod request validation · `M`
- [ ] `@hono/zod-validator` on every route (zod is already a dep)
- [ ] Removes all `body: any` casts in the route layer
- [ ] Generate `apps/docs/api-reference/openapi.json` from the schemas so docs can't drift

---

### 🟡 API-003 · Surface retryable failures · `S`
**File:** `packages/core/src/ops/append-messages.ts:70`
- [ ] Add `'conflict'` to `ErrorCode` → HTTP `409` + `Retry-After`
- [ ] Stop swallowing the underlying error; log it
- [ ] Optional: one internal retry with jitter (SSI `40001`)

---

### 🟡 API-004 · Cap context size; plan delta storage · `L`
- [ ] `MAX_MESSAGES_PER_CONTEXT`, `MAX_MESSAGES_PER_APPEND`
- [ ] **Structural:** store patches/deltas instead of full copies, materialising on read
      with periodic snapshots. Today every PATCH rewrites *all* nodes — O(n) inserts per edit.

---

### 🟡 API-005 · Throttle `last_used_at` writes · `S`
**File:** `apps/api/src/middleware/auth.ts:19-26,105`
- [ ] Update at most once per N minutes per key (in-memory on Node, KV marker on Workers)
- [ ] Keep it off the request latency path

---

### 🟡 API-007 · Health endpoints · `S`
- [ ] `/health` (liveness), `/health/ready` (DB ping)

---

### 🟡 API-008 · Structured logging & request IDs · `M`
- [ ] JSON logger: `request_id`, `project_id`, `route`, `duration_ms`, `status`
- [ ] Propagate a request id; replace scattered `console.*`
- [ ] Enable `observability` in `wrangler.jsonc` (currently `false`)

---

### 🟡 API-010 · Paginate `GET /contexts/:id` · `M`
- [ ] `limit` / `offset` or cursor; default cap

---

### 🟡 API-011 · Durable audit trail for permanent deletes · `M`
**File:** `apps/api/src/routes/contexts.ts:145` — audit metadata is only `console.info`'d
- [ ] Persist an append-only audit record before the wipe

---

### 🟡 DX-001 · Formatter & linter · `S`
- [ ] Biome or Prettier + ESLint, one repo config
- [ ] `pnpm format`; `--check` in CI (replaces the prose style rules in `CLAUDE.md`)

---

### 🟡 DX-002 · Shared tsconfig base · `S`
- [ ] `packages/tsconfig/base.json`; extend from all four packages

---

### 🟡 DX-003 · Community & security files · `S`
- [ ] `SECURITY.md` (disclosure policy — important for a tool handling agent transcripts)
- [ ] `CODE_OF_CONDUCT.md`, issue + PR templates, `.github/dependabot.yml`

---

## Phase 4 — Scale & product

### 🟡 SDK-001 · Python client resilience · `M`
**File:** `apps/python-sdk/ultracontext/client.py` — opens and closes a new `httpx.Client`
**on every request**
- [ ] Persistent client (context-manager friendly)
- [ ] Retry transport with exponential backoff on 429/5xx; honour `Retry-After`

---

### 🟡 SDK-002 · JS SDK resilience · `M`
- [ ] Default timeout (~30s) instead of none
- [ ] Retry with backoff on 429/5xx and network errors
- [ ] `AbortSignal` passthrough

---

### 🟡 ARCH-001 · Named branches & immutable version ids · `L`
`findHead` picks the newest branch by `created_at` — ambiguous with forks, nondeterministic on
ties. Versions are addressable **only by index**, and indices shift as new versions appear, so
a saved `?version=3` silently changes meaning.
- [ ] Branch names / immutable version ids; keep index addressing as a deprecated alias

---

### 🟡 ARCH-002 · Harden chain ordering · `M`
`orderNodes` falls back to `created_at` sorting on a broken chain, logging only to
`console.error`; ISO-ms timestamps can tie → nondeterministic order.
- [ ] Emit a metric/alert on fallback
- [ ] Consider persisting an explicit ordinal alongside `prev_id`

---

### 🟡 ARCH-003 · Split the sync god-modules · `L`
`apps/sync/src/tui.mjs` is **1,835** lines; `daemon.mjs` is **1,242**.
- [ ] Extract `logger.mjs`, `ipc.mjs`, `sources.mjs`, `ingest.mjs`, `stats.mjs` from the daemon
- [ ] Break the TUI into panels/components (a `ui/` tree already exists — finish the job)

---

### 🟡 PERF-001 · Event-driven ingestion · `M`
The daemon runs `fast-glob` over `~/**` session trees every **1,500 ms**.
- [ ] `fs.watch`/inotify with polling fallback
- [ ] Adaptive backoff when idle; mtime pre-filtering

---

### 🟡 OPS-001 · Docker image for the API · `M`
- [ ] Dockerfile + published image; `build` and `start` scripts
- [ ] Compose file including the API, not just Postgres
- [ ] Update `apps/docs/guides/self-hosting.mdx` (today it tells users to run `tsx src/server.ts`)

---

### 🟡 DOC-001 · Fix `AGENTS.md` drift · `S`
Documents `apps/daemon`, `apps/tui` (merged into `apps/sync`), `packages/protocol`
(doesn't exist), and `pnpm dev:daemon`; describes the API as Hono + Drizzle only.
- [ ] Rewrite against the current tree
- [ ] Add a CI check flagging documented paths that don't exist

---

### 🟡 DOC-002 · Move personal agent config out of the repo · `S`
`CLAUDE.md` has a **"Skill routing"** section referencing private skills
(`office-hours`, `investigate`, `ship`, `qa`, `retro`…) that don't exist here, and instructs
*"ALWAYS invoke it… Do NOT answer directly."*
- [ ] Move to `CLAUDE.local.md` (git-ignored) or delete
- [ ] Keep only repo-wide facts in `CLAUDE.md`

---

### 🟡 DOC-003 · Backfill the changelog · `S`
`apps/docs/changelog.mdx` has **one** entry (Jan 1, 2026) while the SDK is at v1.5.0.
- [ ] Backfill from git history
- [ ] Fix the README Star History badge (points at old name `ultracontext/ultracontext-node`)
- [ ] Consider generating from Conventional Commits

---

### 🟡 TEAM-001 · Design cross-user sharing (if it's a product goal) · `L`
The README promises *"What's the team building today?"* and *"What is Alex working on in
Codex right now?"* — but there is no sharing primitive, no membership, no grants. Close
SEC-001 first, then decide deliberately.
- [ ] Decide: is cross-user visibility in scope?
- [ ] If yes: explicit share model, read-only grants, membership, audit trail
- [ ] If no: state the single-project boundary clearly in the docs

---

## Backlog — hygiene

### 🔵 MISC-001 · De-duplicate LICENSE files · `S`
Four copies (root, `apps/js-sdk`, `apps/python-sdk`, `apps/docs`). Keep the root one.

### 🔵 MISC-002 · Fix relative paths in `.env.example` · `S`
`ULTRACONTEXT_DB_FILE=../../.ultracontext/daemon.db` etc. depend on the caller's cwd —
use `~/`-relative or absolute paths.

### 🔵 MISC-003 · Add root `CHANGELOG.md` · `S`
Today the only history lives in GitHub releases.

### 🔵 MISC-004 · Add performance benchmarks · `M`
No benchmarks exist for the append/read path — needed to validate the API-004 delta-storage work.

---

## Dependency graph

```
CI-001 ────────────────► (gates all merges)
DATA-004 ──► DATA-002 ──┐
         └─► DATA-003 ──┴──► DATA-001
SEC-001 ──► SEC-007
API-004 ──► MISC-004
BUILD-001 ──► (unblocks SDK changes reaching the CLI)
```

**Critical path:** `SEC-001` → `CI-001` → `DATA-004` → `DATA-001`

---

## Definition of done

- [ ] Test added (or explicitly justified as untestable)
- [ ] `pnpm check` passes
- [ ] CI green
- [ ] Docs updated if behaviour changed
- [ ] Conventional Commit, scoped (`feat(api):`, `fix(core):`, …)
- [ ] PR notes affected packages and commands run
