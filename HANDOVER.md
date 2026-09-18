# HANDOVER — UltraContext (written 2026-09-18, supersedes the 2026-09-15 HANDOVER.md)

You are continuing a long-running autonomous taskboard session on
`Warzonesiddiki/ultracontext` (working dir `/home/user/ultracontext`).

Everything below was verified against the working tree on 2026-09-18, not
recalled from memory. §2 (recovery runbook), §6 (repo map), §7 (design
facts), §8 (pitfalls) and §10 (external facts) are cumulative — they are
appended to, never rewritten, so the hard-won detail survives.

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
branch pointer to its base commit, (b) **wipes `node_modules`** (excluded
from snapshots — see pitfall 17: this happens between EVERY bash call, not
only between sessions), (c) wipes `/tmp` between sessions (but `/tmp`
survives across calls inside one session). **Working-tree file content
survives.** On 2026-09-15 the reset happened again mid-session: the branch
sat at `1ff782b` with a huge `M` diff — it was reset residue, NOT user
edits (all 53 index-diffing files were verified byte-identical to
`origin/main`).

Recovery runbook:

```bash
cd /home/user/ultracontext
BR=$(git branch --show-current)              # the session's arena/… branch
git rev-parse --short HEAD && git status --short | head
git ls-remote origin main "refs/heads/$BR"   # the REMOTE is the source of truth

# If HEAD ≠ the remote branch tip, realign WITHOUT touching the working tree:
git fetch origin "$BR" && git reset --mixed FETCH_HEAD
#   --mixed moves refs/index and KEEPS your files. Never use --hard here: it
#   destroys uncommitted work, which is exactly what a mid-session reset
#   leaves you holding.

corepack enable && pnpm install              # pnpm is NOT on PATH in a fresh
                                             # sandbox; the repo pins
                                             # pnpm@10.28.1 (corepack 0.34 is
                                             # present, node v22.22.x)
# dist bundles are gitignored and lost on reset — rebuild when a bin matters:
cd apps/js-sdk && pnpm build && cd ../mcp-server && pnpm build && cd ../..
# Python venv:
python3 -m venv /tmp/uc-v && /tmp/uc-v/bin/pip -q install -e 'apps/python-sdk[dev]'
```

Because `node_modules` disappears between bash calls, do the bootstrap and
the test run **in the same call** — e.g. keep `/tmp/boot.sh` containing
`corepack enable && pnpm install` (guarded on `node_modules` existing) and
prefix commands with `bash /tmp/boot.sh`. A full install is ~5s warm, ~13s
including a core test run.

**Never** `git clean` before confirming what is untracked — the pending
`.github/workflows/ci.yml` (CI-001) is precious and untracked by design.

Then restore the baseline (§5) before touching any feature.

## 3. GIT / PROJECT STATE OF RECORD (verified 2026-09-18)

- `origin/main` = **`abe1284`** — "Merge pull request #3" (merged
  2026-09-18): 12 items — API-003/004/005/007/008/009/010/011,
  TEST-002/003, SDK-001 (python), SDK-002 (js).
- **Board: 65 items, 40 shipped, 25 open** (ARCH-001 shipped 2026-09-18).
- Session branches: `arena/01a08f10-…` (PR #1), `arena/01a09075-…` (PR #2),
  `arena/01a0a803-…` (PR #3, at `939042c`) are all merged/historical.
  **Work happens on the CURRENT session's `arena/…` branch only** — the
  platform pins it; never push to an older session's branch.
- **A session's GitHub access dies when its PR merges.** Plan pushes
  BEFORE asking for a merge, and re-verify with
  `git ls-remote origin main "refs/heads/<session-branch>"` at the start of
  every turn — the sandbox rewinds the local branch pointer to its base.
- Untracked-by-design: `.github/workflows/ci.yml` (byte-identical to the
  tracked `docs/ci/ci.yml.pending`; restore with
  `cp docs/ci/ci.yml.pending .github/workflows/ci.yml`).
- **CI-001 is still blocked on the OWNER:** the connected GitHub App has
  `workflows` at App level but the grant is installation-scoped — set it on
  the repo's Installed-apps → Configure → Permissions → Workflows
  (read+write). Standing rule: never commit `ci.yml` until the push that
  contains it is accepted; if a push is rejected, revert the commit.

## 4. REMAINING WORK — EXACT ORDER

### Shipped (phase 3 complete)

API-003, API-004, API-005, API-007, API-008, API-009, API-010, API-011,
TEST-002, TEST-003, SDK-001, SDK-002 — all on `main` via PR #3 (`abe1284`).
**ARCH-001** (named branches + immutable version ids) shipped 2026-09-18;
see its board entry for the full contract.

### Next, in board order

**1. ARCH-002 (M) — Harden chain ordering.**
`packages/core/src/context-chain.ts (orderNodes)`: a broken `prev_id` chain
falls back to a `created_at` sort and only `console.error`s. ISO-ms stamps
tie, so message order is nondeterministic on the fallback path. Acceptance:
a metric/alert fires on fallback, and an explicit ordinal is persisted
alongside `prev_id` (a migration — follow the 0003 pattern, and keep
`apps/postgres/init.sql` in lockstep).

**2. ARCH-003 (L) — Split the sync god-modules.**
`apps/sync/src/tui.mjs` (1,835 lines) and `daemon.mjs` (1,242 lines).
Acceptance: `logger.mjs`, `ipc.mjs`, `sources.mjs`, `ingest.mjs`,
`stats.mjs` extracted; the TUI broken into the `ui/` tree that already
exists. NOTE `pnpm check` for apps/sync is a list of `node --check` calls
in package.json — add every new file to it.

**3. PERF-001 (M) — Event-driven ingestion** in `daemon.mjs`: fs.watch /
inotify with a polling fallback, adaptive idle backoff, mtime
pre-filtering.

**4. OPS-001 (M) — Docker image for the API**: Dockerfile, build/start
scripts, compose; document in `apps/docs/guides/self-hosting.mdx`.

**5. DOC-001/002/003** — AGENTS.md drift fix (+ a CI path check); personal
agent config out of the repo (CLAUDE.md); changelog backfill.
**Known drift found while doing ARCH-001:** the docs claim "appends don't
create versions" (`guides/store-retrieve-contexts.mdx`,
`guides/edit-contexts.mdx`, `guides/view-context-history.mdx`) — FALSE:
appends DO create version heads (`operation:'append'`; verified create +
2 appends = 3 versions). Left alone to keep the ARCH-001 diff reviewable.
Also `apps/api/src/schemas/openapi.ts` documents `Version.operation` as
`enum: ['create','update','delete']` while core also emits `'append'`.

**6. TEAM-001** — cross-user sharing design decision (a share model vs a
documented single-project boundary). Then **PROM-004/006/007/008**, then
the P3 MISC items.

Re-read each item's `d:`/`acc:` in `taskboard.html` before starting: board
entries CAN be stale vs the tree (they were wrong for TEST-002 and
TEST-003), so verify the code first.

## 5. VERIFICATION BASELINE (all green as of 2026-09-18, post-ARCH-001)

| package | command | result |
|---|---|---|
| core | `cd packages/core && node --import tsx --test src/*.test.ts src/**/*.test.ts` | **289/289** |
| storage | `cd packages/storage && pnpm test` | **45/45** |
| api | `cd apps/api && node --import tsx --test src/tests/**/*.test.ts` | **195/195** |
| parsers | `cd packages/parsers && pnpm test` | **98/98** |
| sync | `cd apps/sync && pnpm test` | **20/20** |
| mcp-server | `cd apps/mcp-server && pnpm test` | **5/5** |
| js-sdk | `cd apps/js-sdk && pnpm test` | **103/104** — 1 KNOWN env-only failure |
| python-sdk | `cd apps/python-sdk && /tmp/uc-v/bin/python -m pytest -q` | **73/73** |
| tsc | `pnpm -r --if-present run check` | clean (core, storage, api, js-sdk, sync) |
| mypy | `/tmp/uc-v/bin/python -m mypy apps/python-sdk/ultracontext` | clean |

The one js-sdk failure is `tests/onboarding-wizard.e2e.test.mjs`: it needs a
native `node-pty` build this sandbox cannot compile (nodejs.org headers are
unreachable → "Failed to load native module: pty.node"). **Do not try to
fix it** — it is not a code defect.

Bootstrap (a fresh sandbox has no `node_modules` and no `pnpm` on PATH):

```bash
cd /home/user/ultracontext
corepack enable && pnpm install          # repo pins pnpm@10.28.1, node v22.22.x
python3 -m venv /tmp/uc-v && /tmp/uc-v/bin/pip -q install -e "apps/python-sdk[dev]"
```

OpenAPI is generated: after touching `apps/api/src/schemas/openapi.ts`, run
`cd apps/api && ./node_modules/.bin/tsx scripts/generate-openapi.mts` —
`openapi.test.ts` fails if `apps/docs/api-reference/openapi.json` diverges.

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
  `packages/core/src/request-parsing.ts`. `at` is still strict-int →
  malformed 400, out-of-range 404. **`version` is different since
  ARCH-001 — see the next bullet.**
- **Version addressing (ARCH-001):** ONE resolver,
  `resolveVersionSelection(versions, value)` in
  `packages/core/src/ops/get-context.ts`, used by GET /contexts/:id, the
  POST /contexts fork path and branch pinning. An integer or a
  `/^[+-]?\d+$/` string is a POSITIONAL INDEX (negative counts back from
  the head: `-1` = latest — it used to 404); any other non-empty string is
  an IMMUTABLE HEAD-ID LOOKUP (`ctx_…`; unknown → 404 `not_found`); a
  fractional JSON number or `''` → 400 `invalid_input`. So `'1abc'`/`'1.9'`
  moved 400 → 404: API-002's "never silently parseInt'd" guarantee holds,
  but a non-integer string is now a legitimate FORM that just doesn't
  exist. Safe because public ids are always `ctx_`/`msg_`-prefixed, so the
  index and id spaces cannot collide. `?history=true` entries carry `id`;
  OpenAPI marks `Version.version` `deprecated`.
- **Named branches (ARCH-001):** `context_refs(project_id, context_id,
  name, head_id, created_at, updated_at)`, UNIQUE(project_id,
  context_id, name) — tenancy is part of the key and is the upsert target.
  **`head_id` has NO FK by design** (the pinned version node can be
  deleted; an orphaned name reports `version: -1` rather than cascading a
  branch away or blocking the append path); `project_id` DOES cascade.
  Ops in `packages/core/src/ops/branches.ts` (listBranches / createBranch /
  deleteBranch), all project-scoped via `findRootContext` → a second tenant
  gets 404. PUT is an upsert with git `branch -f` semantics (created_at
  preserved, updated_at bumped) and returns **200**, not 201. DELETE
  removes the pointer only — never version data. Name rules live in core
  `isValidBranchName` and are mirrored byte-for-byte by the zod
  `BranchName` in `apps/api/src/schemas/index.ts`.
- **findHead's tiebreak is total:** created_at desc, then public_id desc.
  ISO-ms stamps collide routinely (one batch writes several heads in the
  same millisecond), and a created_at-only sort left the winner dependent
  on storage return order. A node that is another head's `prev_id` target
  is NOT a head — sorting can never resurrect an interior node.
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
17. **`node_modules` is stripped between EVERY bash call**, not just
    between sessions — it is on the snapshot exclusion list (as are `dist`,
    `build`, `.venv`, `__pycache__`), while `/tmp` survives. So `pnpm test`
    in a fresh call fails with `Cannot find package 'tsx'` / `pnpm: command
    not found`. Fix: bootstrap inside the same call — keep a
    `/tmp/boot.sh` that runs `corepack enable && pnpm install` when
    `node_modules` is missing (~13s) and prefix test commands with it.
    The `/tmp/uc-v` venv persists across calls within a session.
18. **Adding a migration breaks hardcoded test fixtures.** Adding version 3
    collided with `migrations.test.ts`'s synthetic `TEST_0003` (a fake
    "next" migration) and with `rollbackPostgres`'s `{version: 3, name:
    'ghost'}` unknown-version case — both had to move to 4 / 9. Registry
    versions are immutable: never reuse one, so fixtures must be renumbered
    forwards, not the migration backwards.
19. **`apps/docs/docs.json` is 4-space-indented JSON with some arrays kept
    on one line.** Round-tripping it through `json.dumps` reformats all 120
    lines; do a targeted text insertion instead (3-line diff vs 116).
20. **A widened contract silently invalidates old assertions.** ARCH-001
    turned `?version=1.9` from 400 into 404, which broke tests in THREE
    files (`validation`, `zod-validation`, `openapi.test.ts`) that all
    asserted the old code. When a change is deliberate, rewrite the
    assertion to state the NEW contract and why — don't delete it.

## 9. CONVENTIONS

- **Board marking (shipped item):** title `t:` gets " — SHIPPED" appended;
  `d:` is replaced with `DONE. <what changed + key subtleties + how
  verified + test counts>`; keep `acc:` as-is.
- **Commits:** descriptive subject + body listing changes per file area and
  a "Verified: …" line with test counts. One commit per logical batch.
  Push ONLY to the session's `arena/…` branch.
- **PRs:** opened per batch to `main` (PR #2 merged as `184633b`, PR #3 as
  `abe1284`). One commit per board item, subject `<ITEM-ID>: <title>`.
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

1. Run the §2 recovery runbook; confirm the §5 baseline is green
   (remember pitfall 17: bootstrap inside the same bash call).
2. Work **ARCH-002** → **ARCH-003** → **PERF-001** → **OPS-001** →
   **DOC-001/002/003** → **TEAM-001**, then PROM-004/006/007/008 and the P3
   MISC items. Per item: re-verify the code against the board entry,
   implement, ALL suites green + tsc/mypy clean, mark the board, commit
   `<ITEM-ID>: <title>`, push to the CURRENT session's `arena/…` branch.
3. Sweep the docs drift recorded in §4 item 5 (the "appends don't create
   versions" claim and the `Version.operation` enum missing `'append'`)
   when DOC-001 comes up — both verified false on 2026-09-18.
4. Ask the user whether the GitHub App `workflows` permission was granted;
   if yes, promote CI-001 (§3) and verify a green run.
5. Push BEFORE any PR merge — a session loses GitHub access when its own PR
   merges (§3).
