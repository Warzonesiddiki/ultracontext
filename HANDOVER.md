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
the test run **in the same call**. `/tmp` itself can also be wiped
mid-session (it happened on 2026-09-19, taking `boot.sh` and the python venv
with it while the working tree survived untouched), so treat both helpers as
recreatable, not as state. `/tmp/boot.sh` — recreate verbatim if missing:

```bash
#!/usr/bin/env bash
export PATH="/usr/local/bin:$PATH"
corepack enable >/dev/null 2>&1
cd /home/user/ultracontext
if [ ! -d node_modules ] || [ ! -d packages/core/node_modules ]; then
  pnpm install --prefer-offline >/tmp/boot-install.log 2>&1 || pnpm install >>/tmp/boot-install.log 2>&1
fi
```

Prefix node work with `bash /tmp/boot.sh`; a warm install is ~5s. The python
venv is `python3 -m venv /tmp/uc-v && /tmp/uc-v/bin/pip install -e
'apps/python-sdk[dev]'` (~20s).

**If the sandbox recycled, the local branch pointer may have been rewound to
its base while the working tree kept every edit** — `git log` shows the base
commit and `git status` shows both the last item's files and the current
one's. Recover with `git fetch origin <branch> && git reset --mixed
FETCH_HEAD` (never `--hard`), then re-run this section before committing.

**Never** `git clean` before confirming what is untracked — the pending
`.github/workflows/ci.yml` (CI-001) is precious and untracked by design.

Then restore the baseline (§5) before touching any feature.

## 3. GIT / PROJECT STATE OF RECORD (verified 2026-09-18)

- `origin/main` = **`abe1284`** — "Merge pull request #3" (merged
  2026-09-18): 12 items — API-003/004/005/007/008/009/010/011,
  TEST-002/003, SDK-001 (python), SDK-002 (js).
- **Board: 65 items, 41 shipped, 24 open** (ARCH-001 and ARCH-002 both
  shipped 2026-09-18 on this session's branch, not yet merged to main).
- Session branches: `arena/01a08f10-…` (PR #1), `arena/01a09075-…` (PR #2),
  `arena/01a0a803-…` (PR #3, at `939042c`) are all merged/historical.
  **Work happens on the CURRENT session's `arena/…` branch only** — the
  platform pins it; never push to an older session's branch.
- **A session's GitHub access dies when its PR merges.** Plan pushes
  BEFORE asking for a merge, and re-verify with
  `git ls-remote origin main "refs/heads/<session-branch>"` at the start of
  every turn — the sandbox rewinds the local branch pointer to its base.
- **CI-001 is STILL BLOCKED — promotion was attempted and rejected on
  2026-09-19.** The owner approved CI-001, so the workflow was committed
  (`git mv docs/ci/ci.yml.pending → .github/workflows/ci.yml`) and pushed.
  GitHub refused the push:

  ```
  ! [remote rejected] (refusing to allow a GitHub App to create or update
    workflow `.github/workflows/ci.yml` without `workflows` permission)
  ```

  So the grant that landed is NOT the installation-scoped one this needs.
  The commit was rolled back (`git reset --mixed HEAD~1` + restore) per the
  standing rule; the remote tip never moved. What to check, in order:
  1. Repo → Settings → **Installed GitHub Apps** → *your App* → Configure →
     **Repository permissions → Workflows = Read and write**. The App-level
     permission (App settings → Permissions & events) is necessary but NOT
     sufficient: an installation can narrow it, and this one has.
  2. If Apps → *GitHub Apps* → your App → **Installations** shows the
     repo under "Only select repositories", the Workflows permission must be
     enabled for THAT installation, then re-saved.
  3. Permission changes can take a minute to propagate; also confirm the
     push is authenticated as the App (`gh auth status`) and not as a user
     token that lacks the scope.

  Current layout: `docs/ci/ci.yml.pending` is the TRACKED canonical copy and
  `.github/workflows/ci.yml` sits beside it UNTRACKED, byte-identical
  (`diff -q` verified). Retry = commit the rename and push; nothing else
  needs redoing. The workflow itself is finished and every step was
  verified locally in CI order on 2026-09-19 (see the board entry).
  Remaining OWNER step after it lands: branch protection on `main` with the
  two job names as required checks — `JS — check, test, build, bins` and
  `Python — pytest + mypy`.

## 4. REMAINING WORK — EXACT ORDER

### Shipped (phase 3 complete)

API-003, API-004, API-005, API-007, API-008, API-009, API-010, API-011,
TEST-002, TEST-003, SDK-001, SDK-002 — all on `main` via PR #3 (`abe1284`).
Shipped 2026-09-18 on this session's branch (one commit each, not yet
merged): **ARCH-001** (named branches + immutable version ids) and
**ARCH-002** (persisted chain ordinal + chain-health counters on
`GET /health`). Both board entries carry the full contract — read them
before touching chain ordering, version addressing or branches.

### Next, in board order

**1. ARCH-003 (L) — Split the sync god-modules.**
`apps/sync/src/tui.mjs` (1,835 lines) and `daemon.mjs` (1,242 lines).
Acceptance: `logger.mjs`, `ipc.mjs`, `sources.mjs`, `ingest.mjs`,
`stats.mjs` extracted; the TUI broken into the `ui/` tree that already
exists. NOTE `pnpm check` for apps/sync is a list of `node --check` calls
in package.json — add every new file to it.

**2. PERF-001 (M) — Event-driven ingestion** in `daemon.mjs`: fs.watch /
inotify with a polling fallback, adaptive idle backoff, mtime
pre-filtering.

**3. OPS-001 (M) — Docker image for the API**: Dockerfile, build/start
scripts, compose; document in `apps/docs/guides/self-hosting.mdx`.

**4. DOC-001/002/003** — AGENTS.md drift fix (+ a CI path check); personal
agent config out of the repo (CLAUDE.md); changelog backfill.
**Known drift found while doing ARCH-001:** the docs claim "appends don't
create versions" (`guides/store-retrieve-contexts.mdx`,
`guides/edit-contexts.mdx`, `guides/view-context-history.mdx`) — FALSE:
appends DO create version heads (`operation:'append'`; verified create +
2 appends = 3 versions). Left alone to keep the ARCH-001 diff reviewable.
Also `apps/api/src/schemas/openapi.ts` documents `Version.operation` as
`enum: ['create','update','delete']` while core also emits `'append'`.

**5. TEAM-001** — cross-user sharing design decision (a share model vs a
documented single-project boundary). Then **PROM-004/006/007/008**, then
the P3 MISC items.

Re-read each item's `d:`/`acc:` in `taskboard.html` before starting: board
entries CAN be stale vs the tree (they were wrong for TEST-002 and
TEST-003), so verify the code first.

## 5. VERIFICATION BASELINE (all green as of 2026-09-18, post-ARCH-002)

| package | command | result |
|---|---|---|
| core | `cd packages/core && node --import tsx --test src/*.test.ts src/**/*.test.ts` | **323/323** |
| storage | `cd packages/storage && pnpm test` | **51/51** |
| api | `cd apps/api && node --import tsx --test src/tests/**/*.test.ts` | **198/198** |
| parsers | `cd packages/parsers && pnpm test` | **98/98** |
| sync | `cd apps/sync && pnpm test` | **20/20** |
| mcp-server | `cd apps/mcp-server && pnpm test` | **5/5** |
| js-sdk | `cd apps/js-sdk && pnpm test` | **103/103** — e2e pty suite skips here |
| python-sdk | `cd apps/python-sdk && /tmp/uc-v/bin/python -m pytest -q` | **73/73** |
| tsc | `pnpm -r --if-present run check` | clean (core, storage, api, js-sdk, sync) |
| mypy | `/tmp/uc-v/bin/python -m mypy apps/python-sdk/ultracontext` | clean |

`tests/onboarding-wizard.e2e.test.mjs` needs the NATIVE `node-pty` binding,
which this sandbox cannot build (nodejs.org headers unreachable → "Failed to
load native module: pty.node"). It used to fail the file at import time and
was carried as a known env-only failure; as of CI-001 it loads node-pty
defensively and the suite SKIPS with the reason, so `pnpm test` exits 0 here
and runs all 13 e2e tests wherever the binding builds (CI on ubuntu-latest,
a normal dev machine). Do not "fix" the skip into a pass, and do not remove
the guard: a static import of a native module in a test file turns an
environment property into a red suite.

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
  parsing), `StorageAdapter` interface, `MemoryStorage` + `seedContext` test
  doubles (`src/testing/`), `chain-health.ts` (the fallback observable),
  `resultStatus()` (ErrorCode→HTTP). TS; `node --import tsx --test`.
- `packages/storage` — drizzle schema; **SQLite adapter (libsql)** +
  **Supabase adapter**; `src/columns.ts` (the shared column-projection
  helper); migration tooling in `src/migrations/` (`0001_init`,
  `0002_sqlite_constraints`, `0003_context_refs`, `0004_node_ordinal`;
  runner = one BEGIN…COMMIT `executeMultiple` per migration +
  `schema_migrations` stamp; registry requires up+down for BOTH dialects;
  migrations are IMMUTABLE — add new, never edit; legacy DBs no-op via IF
  NOT EXISTS, and `sqlite/schema.ts`'s `SCHEMA_SQL` must stay equal to the
  cumulative result because a test bootstraps from it and then migrates).
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
- `apps/docs` — docs site (Mintlify: `docs.json` nav + `.mdx` pages,
  `api-reference/openapi.json` GENERATED from the API's openapi.ts).
- `docs/ci/ci.yml.pending` — the TRACKED, ready-to-promote PR CI workflow
  (JS job: install → check → js-sdk tsc → 7 test suites → builds →
  verify-bins; Python job: pytest + mypy). `.github/workflows/ci.yml` is the
  same bytes, untracked, until the App's installation-scoped `workflows`
  permission exists (§3). `scripts/ci/verify-bins.mjs` asserts every declared
  bin path exists. `.github/workflows/publish.yml` (tracked, pre-existing)
  publishes on release — proof that a workflow file CAN be committed once the
  permission is right.
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
- **findHead's tiebreak is total:** `ordinal` desc, then created_at desc,
  then public_id desc. ISO-ms stamps collide routinely (one batch writes
  several heads in the same millisecond), and a created_at-only sort left
  the winner dependent on storage return order; the ordinal IS the write
  order, so the two timestamp keys only matter for heads written before
  migration 0004. A node that is another head's `prev_id` target is NOT a
  head — sorting can never resurrect an interior node.
- **Chain ordering (ARCH-002):** `prev_id` stays authoritative —
  `orderNodes` walks it and returns that order untouched when the walk is
  complete, EVEN IF the persisted ordinals disagree with it. Only a broken
  walk falls back, and the fallback is now total: `ordinal`, then
  `created_at`, then `public_id`. A null ordinal sorts AFTER every real one
  (null means "written before 0004", never 0).
- **`nodes.ordinal`:** 0-based position inside the node's `context_id`
  partition, written by the same insert that writes `prev_id`. Partitions:
  version heads share the ROOT id (grows for the life of the context);
  messages carry their own HEAD id and every version write mints a fresh
  head, so each message partition restarts at 0; a root node has
  `context_id` NULL → no partition → no ordinal. `nextOrdinal()` =
  MAX+1, **never COUNT** — deleting an interior head drops the count, so a
  count-based ordinal would collide with a surviving head.
- **Chain health is observable, not telemetry:** `chain-health.ts` keeps
  in-process counters + `onChainFallback(listener)` (listener exceptions
  contained) and writes one `[ultracontext:chain-health]` log line with the
  event as JSON. `GET /health` returns them as `chain_health` — `status`
  stays `ok` on purpose (a damaged chain is data; a failing liveness probe
  would restart a healthy server and fix nothing → alert on
  `chain_health.fallbacks`), and `last_context_id` is OMITTED because that
  probe is unauthenticated and must not name a tenant's context. Counters
  reset with the process; nothing is ever transmitted.
- **`findNodesByContextId(contextId, columns?)` projections are honoured**
  by all four adapters via `packages/storage/src/columns.ts` (default stays
  `public_id, prev_id`). They used to be silently ignored — see pitfall 21.
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
18. **Adding a migration breaks hardcoded test fixtures.** Version 3
    collided with `migrations.test.ts`'s synthetic `TEST_0003` and with
    `rollbackPostgres`'s `{version: 3, name: 'ghost'}` case (moved to 4 / 9);
    version 4 then collided with that same fixture again, now `TEST_0005`
    (ghost stays at 9). Every `[1, 2, 3]` assertion, `report.version`,
    `ups.length` and the "already-current" PgState list has to move too.
    Registry versions are immutable: never reuse one, so fixtures are
    renumbered forwards, not the migration backwards.
19. **`apps/docs/docs.json` is 4-space-indented JSON with some arrays kept
    on one line.** Round-tripping it through `json.dumps` reformats all 120
    lines; do a targeted text insertion instead (3-line diff vs 116).
20. **A widened contract silently invalidates old assertions.** ARCH-001
    turned `?version=1.9` from 400 into 404, which broke tests in THREE
    files (`validation`, `zod-validation`, `openapi.test.ts`) that all
    asserted the old code. When a change is deliberate, rewrite the
    assertion to state the NEW contract and why — don't delete it.
21. **An ignored optional parameter reads as `undefined`, which looks like
    missing data.** `findNodesByContextId(ctx, columns)` accepted a
    projection every adapter threw away. Harmless for the chain walk; fatal
    for `nextOrdinal`, because `MAX(undefined)` is indistinguishable from
    "empty partition" and every append would have restarted the numbering at
    0 — silently, with all tests green. When you add a caller that depends on
    an optional parameter, check the adapters actually implement it.
22. **SQLite has no `ADD COLUMN IF NOT EXISTS`,** and a migration must run
    cleanly on BOTH a migrated database and one bootstrapped from
    `SCHEMA_SQL` (which already has the column) — `migrations.test.ts` does
    exactly that. So 0004 rebuilds the table (the 0002 procedure) and its
    copy column list deliberately OMITS the new column, recomputing it
    afterwards. Also: a backfill `UPDATE` must not read the column it is
    writing — Postgres and SQLite differ on seeing their own uncommitted
    writes, so rank by immutable columns only (`created_at`, `id`).
23. **`createContext` takes no messages.** `CreateContextInput` is
    `{from?, version?, at?, before?, metadata?}` — POST /contexts creates an
    EMPTY context and POST /contexts/:id fills it, so the create head always
    has `child_count: 0`. Tests that want a seeded context use
    `testing/seed.ts`'s `seedContext()` (a fixture, not the op) or create +
    append. Passing `{messages: […]}` to the op is silently ignored.
24. **`apps/docs/guides/self-hosting.mdx` carries a hand-written DDL
    sketch** that had drifted (no `context_refs`, no UNIQUE/FK, no
    `ordinal`). A self-hoster who follows it gets an API that selects
    columns which do not exist. It is updated as of ARCH-002 and now points
    at `apps/postgres/init.sql` as canonical — keep it that way, or delete
    the sketch when DOC-001 lands.

## 9. CONVENTIONS

- **Board marking (shipped item):** title `t:` gets " — SHIPPED" appended;
  `d:` is replaced with `DONE. <what changed + key subtleties + how
  verified + test counts>`; keep `acc:` as-is.
- **Commits:** descriptive subject + body listing changes per file area and
  a "Verified: …" line with test counts. One commit per logical batch.
  Push ONLY to the session's `arena/…` branch.
- **PRs:** opened per batch to `main` (PR #2 merged as `184633b`, PR #3 as
  `abe1284`). One commit per board item, subject `<ITEM-ID>: <title>`.
- **CI:** the canonical workflow is `docs/ci/ci.yml.pending` (tracked) with
  an untracked byte-identical `.github/workflows/ci.yml`; **never `git add`
  the latter until the push containing it is accepted** (§3 records the
  2026-09-19 rejection). Edit BOTH or, better, edit the pending copy and
  `cp` it across so they cannot drift. CI runs each package's test SCRIPT,
  not the suites directly — renaming or narrowing a package script, or adding
  a package, must be mirrored in the workflow or coverage is silently lost.

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
2. Work **ARCH-003** → **PERF-001** → **OPS-001** → **DOC-001/002/003** →
   **TEAM-001**, then PROM-004/006/007/008 and the P3 MISC items. Per item: re-verify the code against the board entry,
   implement, ALL suites green + tsc/mypy clean, mark the board, commit
   `<ITEM-ID>: <title>`, push to the CURRENT session's `arena/…` branch.
3. Sweep the docs drift recorded in §4 item 5 (the "appends don't create
   versions" claim and the `Version.operation` enum missing `'append'`)
   when DOC-001 comes up — both verified false on 2026-09-18.
4. CI-001 promotion was REJECTED on 2026-09-19 (§3 has the error text and
   the three settings to check). When the owner confirms the
   installation-scoped Workflows permission is set: `git mv
   docs/ci/ci.yml.pending .github/workflows/ci.yml`, commit `CI-001: add
   pull-request CI`, push, and watch the first PR's checks with
   `gh run list` / `gh pr checks`. Do not re-derive the workflow — it is
   finished and every step was verified locally in CI order.
5. Push BEFORE any PR merge — a session loses GitHub access when its own PR
   merges (§3).
