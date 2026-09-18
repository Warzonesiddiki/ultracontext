# HANDOVER — UltraContext (written 2026-09-15, supersedes the 2026-09-11 HANDOVER.md)

You are continuing a long-running autonomous taskboard session on
`Warzonesiddiki/ultracontext` (working dir `/home/user/ultracontext`).

Everything below was verified against the working tree on 2026-09-15, not
recalled from memory. An untracked copy of this document may exist at
`HANDOVER-FRESH.md` in the repo root.

## 1. MISSION & STANDING DIRECTIVE

The user's standing directive: **"Continue" / "Go" — work `taskboard.html`
in order**, one item at a time: implement → full test suite green → tsc
clean → mark the board entry → commit → push to the session's `arena/…`
branch.

Non-negotiable product constraints (user-set):

- **100% free, self-hosted, local-first. No paid tier, no telemetry, no
  network dependency.** The whole point is that the commercial product is
  free with all features.
- New agent harnesses are **ingest-only unless a writer is added**;
  `ultracontext switch` supports only `claude` and `codex` (README says so).
- Do NOT invent session file paths for parsers — verify by running the tool
  or reading its source; record verified paths in the parser's header comment.

## 2. FIRST ACTIONS — ENVIRONMENT RECOVERY (do this before anything else)

The sandbox RESETS between sessions. A reset (a) rewinds the local session
branch pointer to the old base commit, (b) **wipes `node_modules`**
(excluded from snapshots), (c) wipes `/tmp`. **Working-tree file content
survives and stays byte-identical to `origin/main`.** On 2026-09-15 the
reset happened again mid-session: the branch sat at `1ff782b` with a huge
`M` diff — it was reset residue, NOT user edits (all 53 index-diffing files
were verified byte-identical to `origin/main`).

Recovery runbook:

```bash
cd /home/user/ultracontext
git fetch origin
git status                      # expect many ' M' files vs HEAD — reset residue
git diff --stat origin/main     # MUST be empty (only untracked .github/workflows/ci.yml)
# Only after confirming the diff is empty:
git reset --hard origin/main    # aligns refs/index; content already identical
npm i -g pnpm@10.28.1           # pnpm is NOT on PATH; repo pins pnpm@10.28.1
pnpm install                    # restores node_modules + workspace links
                                # (apps/sync/node_modules/ultracontext → ../../js-sdk)
# dist bundles are gitignored and lost on reset — rebuild:
cd apps/js-sdk && npm run build && cd ../mcp-server && npm run build && cd ../..
# Python venv (/tmp wiped):
python3 -m venv /tmp/uc-py-venv && /tmp/uc-py-venv/bin/pip install -e 'apps/python-sdk[dev]'
```

**Never** `git clean` or `reset --hard` before confirming
`git diff --stat origin/main` is empty — the untracked
`.github/workflows/ci.yml` (CI-001, pending promotion) is precious.

Then restore the baseline (§5) before touching any feature.

## 3. GIT / PROJECT STATE OF RECORD (verified 2026-09-15)

- `origin/main` = **`184633b`** — "Merge pull request #2" (merged
  2026-09-13). All work through SEC-006 is on main. PR #2 = 16 commits,
  116 files, +8124/−577, 20 taskboard items.
- `origin/arena/01a09075-ultracontext` = `47216cc` (merged branch,
  historical). Old base = `1ff782b` (PR #1: analytics/search/local-serve/
  SEC-001).
- **Board: 57 items total, 28 shipped, 29 open.**
- Working tree should equal `origin/main` + one untracked file:
  `.github/workflows/ci.yml` (staged copy of `docs/ci/ci.yml.pending`).
- The repo's `HANDOVER.md` is STALE (2026-09-11) — this document supersedes
  it; overwrite that file with this text (commit it).
- **CI-001 is the only item blocked on the OWNER:** grant the connected
  GitHub App the `workflows` permission, then promote:
  `cp docs/ci/ci.yml.pending .github/workflows/ci.yml` → commit+push → add
  branch protection on main with the CI job as required status check.
  Until then, pushes touching `.github/workflows/` are rejected, and that
  file must be EXCLUDED from every commit (`git add -A` then
  `git reset -q .github/workflows/ci.yml`).

## 4. REMAINING WORK — EXACT ORDER

### P1 (phase 3) — do these first, in this order:

**1. API-003 (S) — Surface retryable failures**
File: `packages/core/src/ops/append-messages.ts:~70` (tx failure path).
Today: any transaction failure collapses to `err('internal')` → flat HTTP
500. The Postgres SSI conflict (SQLSTATE 40001) is exactly the retryable
case. Acceptance: a `conflict` ErrorCode → **HTTP 409 + Retry-After
header**; the underlying error is **logged, not swallowed**. Touch points:
core ErrorCode list + `resultStatus()` mapping (used by
`apps/api/src/routes/contexts.ts` via `status(code)`) + the API route that
sets Retry-After + tests in core and api.

**2. API-005 (S) — Throttle last_used_at writes**
File: `apps/api/src/middleware/auth.ts` (lines ~19-26, ~105).
Today: every authenticated request performs an **awaited** `UPDATE
api_keys` before `next()` — an extra DB round-trip on the latency path for
100% of traffic. Acceptance: updated **at most once per N minutes per key;
off the request latency path** (in-memory last-write map + fire-and-forget
flush; the map is per-process, which is fine — it's an optimization, not
data).

**3. TEST-002 (M) — Python SDK test suite (board entry is STALE)**
Board claims "zero tests" — FALSE since CI-001:
`apps/python-sdk/tests/test_client.py` exists with **20 offline tests**
(httpx mocked) + pytest config, and `mypy` strict is clean. Remaining: grow
toward full parity with the JS SDK client surface (JS SDK has 67 tests —
mirror its behavior coverage: create/append/get with all selectors,
delete-many 207 semantics, search, stats, keys lifecycle, error mapping,
timeouts/retries), keeping everything offline (httpx MockTransport pattern
already in test_client.py). Verify: `cd apps/python-sdk && pytest -q` and
`mypy apps/python-sdk/ultracontext`.

**4. API-004 (L) — Cap context size; plan delta storage**
File: `packages/core/src/ops/update-messages.ts:~118-140`.
Copy-on-write clones **ALL** message nodes under a new head on every update
— O(n) inserts per edit (10k-message context costs 10k row inserts to change
one word). Acceptance, two tiers: (near-term) `MAX_MESSAGES_PER_CONTEXT`
and `MAX_MESSAGES_PER_APPEND` enforced with clear errors; (structural,
design + implement) store patches/deltas, materialise on read, periodic
snapshots. First check whether `MAX_MESSAGES_PER_APPEND` already exists
(mentioned in API-006's acceptance text — I believe it does not; verify).

### P2 queue (then, in board order):
TEST-003 (API HTTP-layer tests), API-007 (health endpoints), API-008
(structured logging + request IDs), API-009 (Zod validation + generated
OpenAPI), API-010 (paginate GET /contexts/:id), API-011 (durable audit trail
for permanent deletes), SDK-001/SDK-002 (client resilience), ARCH-001
(named branches + immutable version ids), ARCH-002 (harden chain ordering),
ARCH-003 (split sync god-modules), PERF-001 (event-driven ingestion),
DOC-001/002/003, TEAM-001, PROM-004, PROM-006, PROM-007. P3: MISC-001/003/
004, PROM-008. Read each item's full `d:`/`acc:` in taskboard.html before
starting.

## 5. VERIFICATION BASELINE (all green as of 2026-09-13/15)

- **JS 535/535**: core **228**, storage **42**, parsers **98**, sync **20**,
  js-sdk **67**, mcp-server **5**, api **76**.
- **python-sdk 20/20** (pytest, offline) + `mypy` strict clean.
- **tsc clean**: `packages/core`, `packages/storage`, `apps/api`; js-sdk via
  `./node_modules/.bin/tsc --noEmit -p tsconfig.json`.

Commands (run from each package dir):

```bash
# JS tests — plain `npm test` per package (node --test; tsx loader where TS):
for p in packages/core packages/storage packages/parsers apps/sync \
         apps/js-sdk apps/mcp-server apps/api; do (cd $p && npm test); done
# tsc:
(cd packages/core && npm run check)   # tsc --noEmit
(cd packages/storage && npm run check)
(cd apps/api && npm run check)
# python:
/tmp/uc-py-venv/bin/python -m pytest apps/python-sdk -q
/tmp/uc-py-venv/bin/python -m mypy apps/python-sdk/ultracontext
# full CI sequence (mirror of docs/ci/ci.yml.pending):
pnpm install --frozen-lockfile && pnpm check
cd apps/js-sdk && ./node_modules/.bin/tsc --noEmit -p tsconfig.json && cd ..
<test all 7 JS packages> && cd apps/js-sdk && npm run build && cd ../mcp-server && npm run build && cd ../..
node scripts/ci/verify-bins.mjs
```

Environment: node **v22.22.3**, pnpm **10.28.1** (`npm i -g pnpm@10.28.1`;
corepack exists as fallback).

## 6. REPO MAP

- `packages/core` — domain ops (context chain, version model, request
  parsing), `StorageAdapter` interface, `MemoryStorage` test double,
  `resultStatus()` (ErrorCode→HTTP). TS; `node --import tsx --test`.
- `packages/storage` — drizzle schema; **SQLite adapter (libsql)** +
  **Supabase adapter**; migration tooling in `src/migrations/`
  (`0001_init`, `0002_sqlite_constraints`; runner = one BEGIN…COMMIT
  `executeMultiple` per migration + `schema_migrations` stamp; registry
  requires up+down for BOTH dialects; migrations are IMMUTABLE — add new,
  never edit; legacy DBs no-op via IF NOT EXISTS).
- `packages/parsers` — transcript parsers: claude, codex, opencode (v1
  legacy JSONL + v2 + SQLite), agy (Antigravity), freebuff, generic.
  Fixtures under `tests/fixtures/` (opencode-v1.db / opencode-v2.db are
  checked-in SQLite DBs). Verified session paths are in each parser's header
  comment.
- `apps/api` — Hono server: auth middleware (hash+prefix keys), rate
  limiting (per-namespace buckets!), CORS allowlist, contexts/keys routes,
  `repair.ts` tooling. 8 MiB `bodyLimit` on POST/PATCH `/contexts/:id`.
- `apps/sync` — headless ingestion daemon (→ API), CLI (`ultracontext
  serve|switch|backup|gc`), `redact.mjs`, `utils.mjs`. Plain ESM JS;
  `node --check` + `node --test`. BULK_BATCH_SIZE = 50 (body cap must stay
  above ~50 messages).
- `apps/js-sdk` — TS client + CLI (bin), tsdown build → gitignored `dist/`.
- `apps/mcp-server` — MCP stdio+http, tsdown bundle `dist/stdio.mjs` (bin).
- `apps/python-sdk` — httpx client, pytest, mypy strict (dev extras).
- `apps/docs` — docs site. `docs/ci/ci.yml.pending` = the ready-to-promote
  CI workflow.
- `taskboard.html` — THE board. Data array of JS objects; fields
  `id/sev/ph/eff/area/t/file/d/acc`.
- `scripts/ci/verify-bins.mjs` — asserts every declared bin path exists.

## 7. DESIGN FACTS (verified — don't re-derive)

- **Version-on-append (the git model):** every append/patch/delete inserts a
  new head node (`type:'context'`, `context_id=root`, `prev_id=old head`)
  plus message copies under the head. Version = position in heads sorted by
  `created_at`. `GET /contexts/:id?version=&at=&before=&history=true`.
  Strict parsing: `parseIndex` (rejects `1abc`/`1.9`/`' 1 '`) and
  `parseLimit` (NaN→400, clamp [1,100], default 20) live in
  `packages/core/src/request-parsing.ts`; malformed version/at → 400
  `invalid_input`, out-of-range → 404.
- **MessageView** = `content` + `id` + `index` + `created_at` (ISO) +
  `metadata` — `created_at` is in ALL five response builders (get-context
  default + at-slice, append, update, delete). `?before=` is
  client-discoverable. Update/delete ops map the rows `insertNodes` returns
  (the only place adapters' stamped time is visible), excluding the head.
- **SQLite:** `createSqliteAdapter` runs `PRAGMA foreign_keys = ON` BEFORE
  migrations (per-connection!). UNIQUE on `nodes.public_id` +
  `api_keys.key_prefix`; `ON DELETE CASCADE` from `projects` (migration
  0002 — table rebuild, because SQLite can't ALTER ADD FOREIGN KEY; orphan
  rows cleaned during rebuild; UNIQUE indexes created AFTER the rebuild —
  an index dies with its table through rename+drop). `deleteProject`
  manually clears `nodes_fts` rows (FTS has no cascade). FTS rows are
  maintained manually (no triggers) in insertNodes /
  deleteNodesByContextId.
- **hono 4.12:** `import { bodyLimit } from 'hono/body-limit'`
  (`bodyLimit({maxSize})`). undici string bodies carry NO content-length →
  streaming limit path → 413 only fires if the handler lets
  `BodyLimitError` propagate (rethrow when `error.name ===
  'BodyLimitError'`).
- **Redaction (apps/sync/src/redact.mjs):** pattern ORDER matters — PEM
  blocks first, connection strings (password masked, host kept), `.env`
  pairs (anchor-free: inside JSONL line separators are escaped `\n`; key
  must start at a token boundary — lookbehind — so MYTOKEN/AUTHOR don't
  match; value class stops at quotes/commas/backslashes/`=` so masks don't
  swallow neighbours), JWTs, AWS AKIA/ASIA, GitHub ghp*/github_pat_, Slack
  xox*, then uc_/sk-/Bearer/AIza. Object keys matching the sensitive-key
  regex get their whole value replaced.
- **Daemon metadata:** per-message metadata includes `occurred_at`
  (`eventOccurredAt` in utils.mjs: number→`Date(n)`, digit-string→
  `Date(Number(s))` — `new Date("1788256800000")` is **Invalid Date** in V8
  — else ingestion-time fallback).
- **Keys:** stored hashed, looked up by prefix; `listApiKeys` never returns
  the hash; key/status files written 0600 (dir 0700).
- **Daemon E2E (for verification):** env `ULTRACONTEXT_API_KEY`,
  `ULTRACONTEXT_BASE_URL`, `DAEMON_BOOTSTRAP_MODE=all`;
  `POST /v1/keys` ALWAYS provisions a NEW project — use the returned
  `project_id`. MCP stdio server needs config at startup (server.json or
  env key) or exits 1 — smoke tests need a fake HOME.

## 8. PITFALL CATALOG (each of these cost a real debugging turn)

1. **Sandbox reset** — see §2. Huge `M` diffs vs HEAD right after a reset
   are residue, not user work. Verify content vs `origin/main` first.
2. **node_modules + /tmp wiped on reset** — pnpm install + venv rebuild
   every time.
3. **GitHub API flakes:** `gh pr create` / `gh pr merge` return generic
   GraphQL errors or 502s — RETRY (create succeeded on attempt 3; the REST
   merge reported 502 but the mutation HAD landed — always verify with
   `gh pr view N --json state,mergedAt` before concluding failure).
4. **Push Protection (secret scanning)** rejects pushes containing
   realistic-looking secrets (Slack `xoxb-123456789012-…` got us). Test
   fixtures must use FAKE/EXAMPLE-marked values that still match the
   pattern shape (e.g. `xoxb-FAKE000000-FAKEFAKEFAKEFAKE`). AWS's canonical
   `AKIAIOSFODNN7EXAMPLE` passes.
5. **hono bodyLimit streaming path** — see §7.
6. **drizzle wraps driver errors** — the real message ("SQLITE_CONSTRAINT:
   UNIQUE constraint failed…") is on `err.cause`, NOT `err.message`
   ("Failed query: …"). Assertions must test both.
7. **V8 Date parsing** — see §7 (digit strings).
8. **Test-glob pollution:** `apps/api` globs `src/tests/*.test.ts` —
   scratch files there run under `npm test`. Put scratch `.mts` at the
   package root; `/tmp` can't resolve workspace imports
   (`@ultracontext/core`); the repo root can't resolve `tsx`. `node
   --check` every scratch file (a missing `)` makes "it works standalone /
   fails under --test" illusions).
9. **`pkill -f` kills your own shell** when the pattern matches your own
   cmdline — `pgrep -f` → `kill <pids>`.
10. **pnpm workspace bins link at install time** — build dist BEFORE
    `pnpm install` when a bin changed, or "Failed to create bin" won't
    self-heal.
11. **Board entries go STALE vs the tree** — always re-verify current code
    before working an item (TEST-002 "zero tests" was false; other items
    were half-done in ways the entries didn't say).
12. **`git add -A` in this tree** stages the pending ci.yml — always
    `git reset -q .github/workflows/ci.yml` before committing until
    CI-001 promotion.
13. **tsx loader:** TS tests need `node --import tsx`; run from the package
    dir. `createSqliteAdapter` is positional+async; drizzle TS narrowing
    often wants `assert.ok`.
14. **MemoryRateLimiter buckets are keyed by the key STRING only** —
    distinct namespaces need prefixed keys (`keycreate:<ip>`).
15. **Hono 4.12 renames** — `bodyLimit`/`maxSize` (not the 4.10-era
    `createBodyLimit`/`max`).
16. **edit_file fuzzy matching** — re-read files after several edits.

## 9. CONVENTIONS

- **Board marking (shipped item):** title `t:` gets " — SHIPPED" appended;
  `d:` is replaced with `DONE. <what changed + key subtleties + how
  verified + test counts>`; keep `acc:` as-is.
- **Commits:** descriptive subject + body listing changes per file area and
  a "Verified: …" line with test counts. One commit per logical batch.
  Push ONLY to the session's `arena/…` branch.
- **PRs:** opened per batch to `main` (PR #2 merged as `184633b`).
- **ci.yml:** never commit `.github/workflows/ci.yml` until the App has
  `workflows` permission; the canonical pending copy is
  `docs/ci/ci.yml.pending`.

## 10. VERIFIED EXTERNAL FACTS (original clones are gone; recorded here)

- **opencode** = `github.com/anomalyco/opencode` (monorepo; npm
  `@opencode-ai/cli` points here; NOT the sst-era repo). Key files:
  `packages/core/src/session/sql.ts` (table DDL),
  `packages/schema/src/session-message.ts` (v2 `session_message.data`),
  `packages/schema/src/v1/session.ts` (v1 message/part data),
  `packages/core/src/global.ts` (paths),
  `packages/opencode/src/storage/storage.ts` (legacy JSON migration
  layouts). Data root `${XDG_DATA_HOME:-$HOME/.local/share}/opencode`; DB
  candidates `opencode*.db`.
- **freebuff** = `github.com/CodebuffAI/freebuff`: `cli/src/utils/
  config-dir.ts`, `cli/src/project-files.ts`, `cli/src/utils/chat-meta.ts`,
  `cli/src/utils/run-state-storage.ts`, `cli/src/types/chat.ts`.
- **agy / Antigravity:** line schema `{step_index, source, type, status,
  created_at, content, tool_calls, thinking, truncated_fields}`; CLI writes
  `transcript.jsonl` (truncated) + `transcript_full.jsonl` (complete);
  editor transcript at `~/.gemini/antigravity/brain/<conv>/.system_generated/
  logs/transcript.jsonl`.
- npm (2026-09-11): `@opencode-ai/cli` latest `0.0.0-beta-17823`;
  `freebuff` latest 0.0.173 (launcher-only).
- Open-ended harness candidates still unverified: Amp, Cline, Roo Code,
  Kilo Code, Windsurf, Zed, Aider, Goose, Crush, Droid/Factory, Continue,
  pi.

## 11. IMMEDIATE TODO (numbered)

1. Run the §2 recovery runbook; confirm the §5 baseline is green.
2. Overwrite the repo's stale `HANDOVER.md` with this document (commit it).
3. Work **API-003** → **API-005** → **TEST-002** → **API-004** in that
   order. Per item: implement, full suite + tsc green, board-mark, commit,
   push.
4. Check with the user whether the GitHub App `workflows` permission was
   granted; if yes, promote CI-001 (see §3) and verify a green CI run.
5. Continue down the P2 queue (§4).
