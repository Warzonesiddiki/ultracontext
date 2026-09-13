# Handover — UltraContext
Written 2026-09-11 (second session). Everything below is verified against the
working tree, not recalled from memory.

---
## 1. State of the world

**Overall goal (unchanged):** make the commercial product 100% free, self-hosted
and local — all features, no paywall, no telemetry, no network dependency.

**This thread shipped: universal harness coverage (FREE-008)**, then
**FREE-006 (`ultracontext backup` + `ultracontext gc`)**, then
**FREE-007 (local-first daemon + MCP — the offline loop)**, then
**PROM-002 (version on append — the git model)** and **SEC-002 (CORS
allowlist)**, then SEC-004, CI-001, DATA-004, DATA-001, **PROM-003
(`ultracontext switch` documented + cross-platform terminal launch +
`--dry-run`)** and **SEC-003 (timing-safe secret comparison)** — see the
notes below the table.

UltraContext now ingests **9** sources, up from 6:

| Source | Parser | What it reads | Verified against |
| --- | --- | --- | --- |
| `claude` | `agents/claude.mjs` | `~/.claude/projects/**/*.jsonl` | (pre-existing) |
| `codex` | `agents/codex.mjs` | `~/.codex/sessions/**/*.jsonl` | (pre-existing) |
| `openclaw` | `agents/openclaw.mjs` | `~/.openclaw/agents/*/sessions/**/*.jsonl` | (pre-existing) |
| `cursor` | `agents/cursor.mjs` | `~/.cursor/projects/**/*.jsonl` | (pre-existing) |
| `gemini` | `agents/gemini.mjs` (`parseFile`) | `~/.gemini/tmp/*/chats/session-*.json` | (pre-existing) |
| `gstack` | `gstack.mjs` | `~/.gstack/projects/**/*.jsonl` | (pre-existing) |
| **`opencode`** | `agents/opencode.mjs` (`parseFile`, `readBinary`) | SQLite DB **and** legacy JSON storage | current source tree `github.com/anomalyco/opencode` (`packages/core/src/session/sql.ts`, `global.ts`, `storage.ts`) |
| **`agy`** | `agents/agy.mjs` (`parseLine`) | Antigravity CLI + IDE JSONL transcripts | antigravity.google statusline docs + public transcript-format walkthroughs |
| **`freebuff`** | `agents/freebuff.mjs` (`parseFile`) | `chat-messages.json` per chat | public source `github.com/CodebuffAI/freebuff` (main, read 2026-09-11) |

All three new sources are behind `INGEST_OPENCODE` / `INGEST_AGY` /
`INGEST_FREEBUFF` (default on) and glob-overridable via `OPENCODE_DATA_DIR`
(comma-separated), `AGY_GLOB`, `FREEBUFF_GLOB`.

### Verified on-disk layouts (do not re-derive — these were checked this session)

**opencode** — data dir `${XDG_DATA_HOME:-$HOME/.local/share}/opencode`
(`packages/core/src/global.ts` uses xdg-basedir; there is **no**
`OPENCODE_DATA_DIR` in current versions — that was the old sst era).
- **SQLite DB** (≥1.2.0, Feb 2026 → current): `<data>/opencode.db`, read **read-only**.
  - Current schema: `session(id, …, directory, title, …)` +
    `session_message(id, session_id, type, seq, time_created, time_updated, data)`
    where `data` is tagged JSON: `user {text}` · `assistant {content:[text|reasoning|tool], tokens, …}` ·
    `system` · `synthetic` · `shell {command, output}` · `agent-switched` · `model-switched` · `compaction`.
  - Older schema: `message(id, session_id, time_created, data)` +
    `part(id, message_id, …, data)` — v1 assistant rows carry `data.path.cwd`.
  - Timestamps are **epoch milliseconds**. If a DB has both schemas (mid-migration),
    the parser prefers `session_message`.
- **Legacy JSON** (pre-1.2): `<data>/storage/message/<sid>/msg_<mid>.json` (role + time),
  parts under `<data>/storage/part/<sid>/<mid>/…` (or the migration-era
  `<data>/storage/session/{message,part}/…`). The parser resolves the data root by
  walking up to the dir containing `storage/` and pulls the message's sibling parts.

**agy / Antigravity** (CLI binary `agy`, IDE "Antigravity") — under `~/.gemini`:
- CLI: `~/.gemini/antigravity-cli/brain/<conversation>/.system_generated/logs/`
  → `transcript_full.jsonl` (untruncated — the plain `transcript.jsonl` is clipped
  with a `truncated_fields` marker; we only read `_full`).
- IDE: `~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/transcript.jsonl`.
- `~/.gemini/antigravity-ide/brain` and `~/.gemini/antigravity-backup/brain` are
  **duplicate siblings — deliberately not scanned** (same conversation 2–3×).
- Line format: one **step** per line —
  `{step_index, source, type, status, created_at, content, tool_calls?, thinking?, truncated_fields?}`.
  `type` examples: `USER_INPUT`, `PLANNER_RESPONSE`, `CONVERSATION_HISTORY` (no
  payload → skipped), `RUN_COMMAND` / `GREP_SEARCH` / … (tool steps).
  The conversation id (dir under `brain/`) is the session id.

**freebuff** (CodebuffAI/freebuff; `npm i -g freebuff`) — the npm package is a
launcher; the real CLI is TypeScript (Bun) in `github.com/CodebuffAI/freebuff`:
- Config dir: `~/.config/manicode` (override `FREEBUFF_CONFIG_DIR`, absolute).
  The launcher drops its binary there too (`~/.config/manicode/freebuff`).
- `<config>/projects/<project-BASENAME>/chats/<chatId>/`
  - `chat-messages.json` — JSON array of ChatMessage (the transcript)
  - `chat-meta.json` — sidecar `{messageCount, firstPrompt, messagesSize, messagesMtimeMs}`
  - `run-state.json`
- `chatId` = `new Date().toISOString()` with `:` → `-` (the session id).
- ChatMessage: `{id, variant: 'ai'|'user'|'agent'|'error', content: string,
  blocks?: [{type:'text',content,textType:'text'|'reasoning'} | {type:'tool',toolName,input,output?} | …], timestamp: string}`.

### Source-contract changes (daemon)
`apps/sync/src/daemon.mjs`:
- Sources may set `readBinary: true` → the whole file is read as a Buffer
  (content-hash dedup still applies; `sha256` accepts Buffers).
- Whole-file sources filter **per event** against configured project paths
  (`extractProjectPathFromNormalized` now also reads `raw.directory`), because a
  single DB holds sessions from many projects. JSONL sources keep the file gate.
- `buildSources()` registers the three new sources (search "opencode", "agy",
  "freebuff" in `buildSources`).

### FREE-006 — backup + gc (shipped later in this thread)

- `apps/js-sdk/src/cli/backup.mjs` — `ultracontext backup`. Snapshot via
  node:sqlite's online `backup(src, dest)`: open source RW → best-effort
  `wal_checkpoint(TRUNCATE)` → backup → **close the source connection** → wait
  (≤5s poll) for the destination to be non-empty → open dest RO →
  `PRAGMA integrity_check`. Keep-N per family (`--keep`, default 10);
  `pre-restore-*.sqlite` safety copies are never auto-pruned. `--full` =
  0600 tar.gz of DB + server.json + config (contains API keys). Restore:
  verify file → port-probe guard → safety snapshot → atomic rename.
- `apps/js-sdk/src/cli/gc.mjs` — `ultracontext gc --keep <12h|30d|4w|6mo|1y>`
  (default 30d). Session age = **last activity** (max `created_at` across the
  root, its version heads, and their messages), so touched sessions survive.
  Deletes FTS rows → messages → version heads → root, in 200-id chunks per
  transaction. `--dry-run`, `--vacuum`.
- **node:sqlite `backup()` gotcha (verified 2026-09-12):** the module-level
  `backup(srcDb, destPath)` export is ASYNC — the destination stays 0 bytes
  until the SOURCE connection closes. Verifying between `backup()` and
  `close()` reads an empty DB; exiting the process before settlement throws
  an unhandled `Error: not an error` (ERR_SQLITE_ERROR).
- **`-wal` presence is NOT a "server running" signal** (clean closes leave
  `-wal`/`-shm` behind — reproduced). `localServerRunning(dataHome)` probes
  `http://127.0.0.1:${PORT||8787}/contexts?limit=1` with the Bearer key from
  `<home>/server.json`; any HTTP response = running (1.5s timeout). The CLI
  must have `PORT` set in its environment for the guard to see a custom port;
  help text says so.

### FREE-007 — local-first daemon + MCP (shipped later in this thread)

- **One shared precedence** for credentials (CLI entry, MCP config.ts):
  explicit `ULTRACONTEXT_API_KEY`/`ULTRACONTEXT_BASE_URL` env →
  `ULTRACONTEXT_LOCAL=1` (forced, hard error if no server) → local
  `<dataHome>/server.json` (written by `serve`) → hosted
  `<configHome>/.ultracontext/config.json` (from `config`, with a nudge line)
  → interactive onboarding.
- `apps/js-sdk/src/cli/local-server.mjs` — `readLocalServer()` /
  `localDataHome()`: server.json = `{adminKey, apiKey, projectId, port}`;
  port persisted by `serve` on every start (`apps/api/src/serve.ts`).
- The entry sets `process.env` BEFORE spawning the daemon
  (`launchSyncDaemon` passes `env: process.env`) — so the daemon/TUI need no
  changes to get local mode; they still read env with the hosted default as
  last resort.
- **Gotcha:** the bin wrapper (`ultracontext.mjs`) loads `dist/cli/entry.*`
  when it exists — CLI edits are NOT live until `corepack pnpm build` in
  `apps/js-sdk` (or until dist is absent). This bit the E2E once.
- **Gotcha:** onboarding's `config.json` lives under
  `ULTRACONTEXT_CONFIG_HOME ?? $HOME` + `/.ultracontext` — deliberately NOT
  `ULTRACONTEXT_HOME` (so project inference reads real session dirs).
  `loadApiKeyFromConfig` previously ignored `ULTRACONTEXT_CONFIG_HOME`
  (fixed in this thread).
- MCP stdio diagnostics go to stderr (stdout is the JSON-RPC stream).
- **Offline E2E recipe (all verified):** temp `ULTRACONTEXT_HOME` + fake
  `HOME` with a `.claude/projects/<proj>/<sess>.jsonl`; `serve` on a test
  port; `env -u ULTRACONTEXT_API_KEY node ultracontext.mjs sync start`
  (prints "Using local UltraContext server at …"); contexts + search visible
  on localhost; standalone MCP: `tsx src/stdio.ts` with no key env, drive
  `initialize` + `tools/call list_contexts` / `search_contexts` over stdio.

### PROM-002 — version on append, the zero-copy git model (shipped in this thread)

- **Model:** version heads are two flavours. *Snapshot* heads (create /
  update / delete) own a complete copy of the message state. *Append* heads
  (`metadata.operation === 'append'`) own ONLY their new messages — the first
  one links via `prev_id` into the previous head's tail. Content at a head =
  its own messages plus, while the head is an append, the previous head's
  content — stopping at the nearest snapshot head. One batched query
  (`findNonContextNodesByContextIds`, new on all 4 adapters + memory) + an
  in-memory `prev_id` walk (`getOrderedNodes(storage, rootId, headId)` —
  **signature changed**, all callers updated incl. tests).
- **getVersions** now orders by the `prev_id` chain (not `created_at`) so
  same-millisecond append heads stay ordered.
- `appendMessages` inserts head + messages inside the serializable tx and
  rolls back the orphaned head (best effort) if the message insert throws.
- **Backward compatible:** legacy DBs (single create head) read identically —
  the walk stops immediately at a non-append head.
- **Not fixed here (separate board item):** update/delete still copy O(n)
  (API-004). The zero-copy model removes the per-APPEND cost, which is the
  dominant one for daemon capture.
- Version counts moved for append-then-delete sequences: create+append+delete
  = version 2 (was 1). One API test assertion updated; 5 new core tests cover
  time-travel, zero-copy, chain linkage and update-then-append.

### SEC-002 — CORS origin allowlist (shipped in this thread)

- `apps/api/src/middleware/cors.ts` no longer sends `Access-Control-Allow-Origin: *`.
  Allowed origins: loopback (http/https on `localhost` / `127.0.0.1` / `::1`,
  any port — zero-config local dashboards) + exact matches from
  `ULTRACONTEXT_CORS_ORIGINS` (comma list; a bare `*` entry is ignored on
  purpose). Anything else — and a missing Origin — gets NO ACAO header and no
  CORS surface headers; preflights from blocked origins get 204 without ACAO.
- `corsAllowed(origin, env)` is exported for reuse/tests; the middleware reads
  `process.env` at request time (so the env var can change without a restart).

### SEC-004 — 0600/0700 on everything under ~/.ultracontext (shipped last in this thread)

- Writers fixed: onboarding `writeConfig` (config.json — holds the raw API key;
  tmp+rename + chmod, dir 0700), daemon `persistConfigPrefsToFile` (tmp+rename),
  `writeStatusJson` (tmp+rename), bootstrap-state writes, `lock.mjs` (lock 0600,
  dir 0700). Verified live on a fresh `sync start`: dir 700, config.json 600,
  status.json 600, daemon.lock 600.
- **Two real gotchas cost time here (see §5):**
  1. Node 22.22.3 silently drops `mode` in the 4-arg
     `fs.writeFile(file, data, encoding, options)` form. Always use one options
     object: `{ encoding: "utf8", mode: 0o600 }`.
  2. The js-sdk launcher runs `dist/cli/*.mjs` bundles, NOT `src/`. Daemon-side
     fixes are invisible until `cd apps/js-sdk && corepack pnpm build`.
- 2 new unit tests (js-sdk 48 → 50) cover fresh-write 0600/0700 and
  re-locking a pre-existing 0644 config.

### CI-001 — pull-request CI (shipped last in this thread)

- CI design + all supporting code shipped: JS job (`pnpm install
  --frozen-lockfile` → `pnpm check` → js-sdk tsc → test all 7 packages →
  build js-sdk + mcp-server → `scripts/ci/verify-bins.mjs`) and Python job
  (`pip install -e "apps/python-sdk[dev]"` → pytest → mypy strict).
- **The workflow file itself is blocked:** the GitHub App connected to this
  repo lacks the `workflows` permission, so commits touching
  `.github/workflows/` are rejected on push. The ready-to-promote workflow
  lives at `docs/ci/ci.yml.pending` (also untracked at
  `.github/workflows/ci.yml` in this workspace) — once the owner grants
  `workflows` permission to the App, copy it into place, commit, push.
- **Fixes made so CI is green on day one:**
  1. mcp-server's bin `./dist/stdio.js` **did not exist** and its build
     script was a no-op (`tsx --help || true`). Now a real tsdown bundle:
     `apps/mcp-server/tsdown.config.ts` → `dist/stdio.mjs` (shebang,
     externals = @modelcontextprotocol/*, ultracontext, zod); `bin` updated
     to `./dist/stdio.mjs`. Verified by piping an MCP `initialize` JSON-RPC
     request through the built file (proper `serverInfo` reply).
  2. python-sdk had **no tests** — added `apps/python-sdk/tests/test_client.py`
     (20 offline tests, httpx mocked; URL/header/body/error/validation
     coverage, sync + async) + `[tool.pytest.ini_options] asyncio_mode=auto`.
  3. `mypy --strict` had 14 errors in `client.py` (params `no-redef`,
     `Optional` indexed-assignment in `get`/`delete`, sync + async) — fixed.
- **Still open (admin actions):** promote `docs/ci/ci.yml.pending` (needs
  `workflows` permission) + branch protection on main (required status
  check = the CI job names).

### DATA-004 — migration tooling (shipped last in this thread)

- `packages/storage/src/migrations/` (new):
  - `types.ts` — `Migration { version, name, up: {postgres, sqlite}, down: {…} }`
  - `0001_init.ts` — the baseline; exact former `init.sql` / `SCHEMA_SQL`
    content, per dialect, **all idempotent** (IF NOT EXISTS / CREATE OR
    REPLACE) → migrating a legacy DB is a safe no-op that stamps v1
  - `registry.ts` — ordered list + `validateRegistry` (strictly increasing
    versions, both dialects required)
  - `sqlite.ts` / `postgres.ts` — runners. Each migration runs in ONE
    transaction (DDL is transactional in both dialects): schema change and
    the `schema_migrations` stamp commit together. `migrate*()` idempotent;
    `rollback*(client, toVersion)` reverses down to any version and hard-
    errors if an applied version is missing from the registry.
- **Wiring:** `createSqliteAdapter` → `migrateSqlite` on open (replaces
  `executeMultiple(SCHEMA_SQL)`); `createDbClient` (direct Postgres) →
  `migratePostgres` on connect (now async); `apps/postgres/init.sql` kept
  for Supabase deploys (REST can't run DDL) with a "generated from the
  registry" header + `schema_migrations` bootstrap row; `SCHEMA_SQL`
  deprecated (export kept). Package export `@ultracontext/storage/migrations`.
- **Storage test glob gotcha:** `src/**/*.test.ts` expands to one level
  without globstar — the test script is now
  `node --import tsx --test "src/*.test.ts" "src/*/*.test.ts"`.
- 12 new tests (storage 20 → 32): real in-memory SQLite (fresh, idempotent,
  legacy-with-data, rollback round-trip, second-migration up/down, registry
  guard) + Postgres runner via mocked `Sql` (transactional up, rollback SQL,
  registry guard). **No live Postgres in CI yet** — the PG path is validated
  by the mock; add a PG service job when one is available (see CI-001
  promotion).

### DATA-001 — crash consistency without REST transactions (shipped last in this thread)

- **The problem:** Supabase REST (PostgREST) has no multi-statement
  transactions, so `SupabaseAdapter.transaction()` was a no-op — and the
  core ops wrote a version's head and its children as SEPARATE calls. A
  crash between them left an orphaned head (a version that reads as an
  empty/broken context).
- **The fix (structural, backend-agnostic):**
  1. **Single-statement version writes** — append/update/delete/create now
     issue ONE `insertNodes([head, ...children])` call. On SQLite/Postgres
     it's one statement inside the real tx; on Supabase REST it is one SQL
     INSERT — atomic either way. A version can never commit half-way. The
     old two-stage writes + `rollbackHead`/`rollbackRootContext` helpers are
     gone (4 stale rollback tests rewritten to the new semantics).
  2. **Head-first permanent delete** — `permanentlyDelete` deletes each
     version head BEFORE its messages, so a crash mid-delete leaves a chain
     gap (reads fall back to created_at order) + invisible garbage — never
     an orphaned head.
  3. **`child_count` marker** — every op writes the expected child count
     into the head's metadata.
  4. **`repairOrphanedHeads(storage, projectId)`** (new core op) — removes
     heads whose marker says children were expected but none exist, and
     partial-create roots with zero branches. Conservative: legitimate empty
     heads (delete-all, empty create, empty append → child_count 0) are
     untouched. Wired as a startup pass in `serve.ts` and `worker.ts`
     (production!) via `apps/api/src/repair.ts` + a new `listProjects()`
     adapter method (implemented in all 4 adapters).
- **Known remaining limitation (documented in SupabaseAdapter.transaction):**
  two CONCURRENT writers on the same context can both commit (no isolation
  on REST); reads degrade gracefully (both versions listed, HEAD = newest),
  last-write-wins. The `isolationLevel` option is still ignored.
- **10 new chaos tests** (`core/src/ops/crash-consistency.test.ts`): a
  fault-injection proxy kills the process at the write point and asserts the
  chain is unchanged (append/update/create/delete), that permanent-delete
  crashes leave no orphaned head, and that repair heals marker-marked
  orphans while leaving legitimate empty heads alone. Core 196 → 206.
- Gotcha: a Proxy that wraps `transaction()` must re-hand the callback to
  the PROXY (not the inner target) or hooks on the tx are bypassed; and
  `assert.equal('ok' in result, false)` is always false — Result always has
  the key — use `result.ok === false`.

### PROM-003 — document switch + Linux/Windows launch + --dry-run (shipped last in this thread)

- **The gap:** `ultracontext switch` (the headline example — "Codex, grab
  the last plan Claude Code made") had ZERO mentions in the README or docs
  site, and `openInNewTab()` was darwin-only (Ghostty/iTerm2/Terminal.app
  AppleScript). Linux/Windows users got a bare "please run ..." line.
- **Documentation:**
  - `README.md` — new "Hand off between agents — ultracontext switch"
    section after the Agent integrations notes: headline example, all
    flags (`--last`, `--session`, `--no-launch`, `--dry-run`), what happens
    (parse → write → launch), and the per-platform terminal support note.
  - Docs site (Mintlify) — new `apps/docs/guides/switch-agents.mdx` guide
    (registered in `docs.json` navigation between fork-clone-contexts and
    self-hosting) + one line in the `cli.mdx` command list.
- **Cross-platform launch** (`apps/js-sdk/src/cli/switch.mjs`):
  - **Linux:** detect a running emulator via `TERM_PROGRAM` first, else a
    PATH probe, over kitty → Alacritty → WezTerm → foot → Konsole → GNOME
    Terminal → xfce4-terminal → xterm. Opens a NEW window/tab running
    `sh -c "cd <cwd> && codex fork <id> -C <cwd>"` (per-emulator flags;
    e.g. `kitty --type=window`, `gnome-terminal --new-window`, `xterm -e`).
  - **Windows:** prefer Windows Terminal (`wt` — probes PATH +
    System32/WindowsPowerShell), else a fresh `powershell.exe -NoExit`.
    Commands are quoted for PowerShell with the new `powershellQuote()`
    (single quotes, `''` escaping — the existing POSIX `shellQuote` is not
    PowerShell-safe).
  - No launcher found on any platform → the pre-existing fallback prints
    the exact command to run. macOS paths (Ghostty/iTerm2/Terminal.app)
    unchanged.
- **`--dry-run`:** parse-only — uses `readLocalSession()` from
  `@ultracontext/parsers` (no writer, no launch) and prints From (source +
  file), To, message count (honours `--last` capping), the working
  directory recovered from the session, and the command that WOULD run.
  Writes nothing — asserted by an end-to-end test that snapshots the fake
  `$HOME` before/after.
- **17 new tests** (`apps/js-sdk/tests/cli/switch.test.mjs`, 50 → 67):
  `powershellQuote` cases, PATH lookup, terminal discovery order
  (TERM_PROGRAM preference + fallbacks), Windows `wt`/PowerShell
  fallback, `--dry-run` flag parsing, and 2 CLI end-to-end dry-run tests
  that spawn `ultracontext.mjs` against a fake `$HOME` with a real
  claude JSONL.
- **Live E2E verified:** dry-run preview (correct From/To/count/cwd) and a
  real `--no-launch` run writing a valid codex rollout
  (`~/.codex/sessions/<date>/rollout-….jsonl` with `session_meta`).

### TEST-001 + PROM-005 — board hygiene (verified, no code changes)

- **TEST-001** ("broken parsers assertion") was already fixed in the tree
  since the initial merge `1ff782b` — the board predates it. Marked
  SHIPPED; parsers suite green (98/98).
- **PROM-005** (README accuracy pass): all four board points were written
  against an older checkout and are already met (nine sources listed,
  local-first section present, typo gone, `Requires Node >= 22.12.0`).
  Re-verified every concrete README claim against the code on 2026-09-13
  (port 8787, env var names, defaults, the real launch command). No README
  changes required — marked SHIPPED.

### SEC-003 — timing-safe secret comparison (shipped last in this thread)

- **The problem:** the raw admin token and both derived API-key hashes
  (cache hit + storage fallback) were compared with `===`/`!==`, which
  short-circuits on the first differing byte — a timing oracle on secret
  material.
- **The fix:** new core primitive `secretsEqual(a, b)`
  (`packages/core/src/secrets.ts`, exported from the package index):
  both sides reduced to fixed-size SHA-256 digests first (so a length
  difference can't reveal which input was shorter), then compared with
  `crypto.timingSafeEqual` (never short-circuits). Replaced all three
  comparison sites: `verifyAdminToken` (auth.ts), the cached key-hash
  check (auth.ts), and `verifyKeyHash` (core ops). A whole-repo grep for
  `===`/`!==` against secret-named operands now finds nothing.
- **13 new tests:** 6 core unit (`secrets.test.ts` — identical, one-char
  off, different lengths both orders, empty inputs, sha256-hex digests,
  unicode) + 7 API (`apps/api/src/tests/auth.test.ts` — valid key 200,
  one-char-off key 401, same-prefix/different-hash key 401 AFTER the real
  key populated the cache [exercises BOTH constant-time paths], valid key
  200 on the cache-hit path, missing bearer 401, valid admin 200,
  one-char-off admin 401, longer admin 401).
- **Bonus fix:** core's npm test glob `src/**/*.test.ts` (bash has no
  globstar) silently skipped top-level `src/*.test.ts` — the new
  `secrets.test.ts` never ran under `npm test` until the script was
  changed to `node --import tsx --test src/*.test.ts src/**/*.test.ts`.
  Verify new test files show up in `npm test` output.

---
## 2. Test + typecheck baseline (current)

```
packages/core        212 pass / 0 fail   (was 191; +5 PROM-002, +10 DATA-001 crash-consistency, +6 SEC-003 secrets)
packages/storage      32 pass / 0 fail   (was 20; +12 DATA-004 migrations)
packages/parsers      98 pass / 0 fail   (was 69; +29 new: opencode 19, agy 7, freebuff 7… see tests/parsers/)
apps/js-sdk           67 pass / 0 fail   (was 30; +13 backup/gc, +5 local-server, +2 SEC-004 perms, +17 PROM-003 switch)
apps/sync             10 pass / 0 fail
apps/api              56 pass / 0 fail   (1 PROM-002 assertion updated; +11 CORS tests; +7 SEC-003 auth)
apps/mcp-server        5 pass / 0 fail   (new: src/config.test.ts)
apps/python-sdk       20 pass / 0 fail   (NEW in CI-001: tests/test_client.py) + mypy strict clean
────────────────────────────────────
total                500 pass / 0 fail
```
`tsc --noEmit` clean for `packages/core`, `packages/storage`, `apps/api`,
`apps/js-sdk` (js-sdk via `./node_modules/.bin/tsc --noEmit -p tsconfig.json` —
it has no `check` script).

New fixtures in `packages/parsers/tests/fixtures/`:
`opencode-v1.db`, `opencode-v2.db` (real SQLite files generated from the real
schema — regenerate with the script in the parser's git history if the schema
changes), `opencode-legacy/storage/…` (directory tree), `agy-transcript.jsonl`,
`freebuff-chat-messages.json`.

**End-to-end verified this session:** `ultracontext serve` (local, port 8921) +
headless daemon (`node apps/sync/src/index.mjs` with `HOME=<fake>`) ingested all
5 opencode layouts + agy + freebuff, created 5 contexts with correct
`project_path` (opencode `session.directory`), re-run appended **0** (idempotent),
appending one freebuff message appended **1** (incremental).

---
## 3. What is still open (board)

`AUDIT.md` (48 findings), `TASKS.md` (phased plan), `taskboard.html`
(interactive, **64** tasks; FREE-006/007/008, PROM-002, SEC-002, SEC-003,
SEC-004, CI-001, DATA-004, DATA-001, PROM-003 SHIPPED this thread;
TEST-001 + PROM-005 verified-already-done and marked),
`README-REALITY-CHECK.md`.
GitHub Issues are **disabled** on this repo (403) — local artifacts are the board.

Next highest-value on the board (plus the open-ended harness list):
- **SEC-005** (rate limiting + API key lifecycle — revoke/rotate/list),
  then the P1 smalls: API-001 (validate `limit`), API-002 (strict integer
  parsing), API-006 (body size cap), BUILD-001 (sync → workspace SDK),
  BUILD-002 (mcp bin), DATA-002/003 (SQLite UNIQUE + FK cascade), PROM-001,
  SEC-006 (deeper redaction).
- The harness candidates (Amp, Cline, Roo Code, Kilo Code, Windsurf, Zed,
  Aider, Goose, Crush, Droid/Factory, Continue, pi).
- **CI promotion (admin actions):** grant `workflows` permission to the
  connected GitHub App → copy `docs/ci/ci.yml.pending` to
  `.github/workflows/ci.yml` → branch protection on main (required status
  check = the CI job names).
- **More harnesses** — the user said "all harness use to use ai". Candidates not
  yet covered: Amp, Cline, Roo Code, Kilo Code, Windsurf, Zed, Aider, Goose,
  Crush, Droid/Factory, Continue, pi. Recipe below; **verify paths first**.
- `ultracontext switch` writers still only exist for claude + codex. New harnesses
  are ingest-only — README says so; add writers only if the user asks.

---
## 4. Recipe: adding a harness

1. **Parser** — `packages/parsers/src/agents/<name>.mjs`.
   - JSONL: `parse<Name>Line({ line, filePath })` → normalized record or null.
   - Whole file: `parse<Name>File({ fileContents, filePath })` → array.
   - Binary (SQLite etc.): same as whole file + set `readBinary: true` on the
     source in `buildSources()`. `fileContents` arrives as a **Buffer**.
   - Normalized record: `{ sessionId, eventType, kind: 'user'|'assistant'|'system',
     timestamp: ISO string, message, raw }`.
   - Put the **verified** on-disk path in the file's header comment with the
     date and what you checked. NEVER guess a path.
2. **Barrel** — re-export from `packages/parsers/src/agents/index.mjs` **and**
   `packages/parsers/src/index.mjs` (the daemon imports the package root).
3. **Register** — `buildSources()` in `apps/sync/src/daemon.mjs` behind
   `boolFromEnv(process.env.INGEST_<NAME>, true)`.
4. **Project paths (optional)** — if your format carries a cwd, put it in
   `raw.directory` (or `raw.cwd` / `raw.payload.cwd`); the daemon's
   `extractProjectPathFromNormalized` picks it up per event.
5. **Tests** — `packages/parsers/tests/parsers/<name>.test.mjs` + a committed
   sample fixture (a real captured file if you can get one, otherwise a file
   generated from the real schema).
6. **Docs** — add a row to the "Agent integrations" table in README.md and a
   task entry in `taskboard.html` (keep finding IDs stable; new work gets new IDs).

---
## 5. Environment gotchas (each cost real time)

- **`pnpm` vanishes from PATH between turns — always `corepack pnpm`.**
  Root `pnpm check` runs `pnpm -r` and fails with `sh: pnpm: not found`
  (corepack's shim is not in PATH for pnpm's own child processes) — run the
  check scripts **per package**. On GitHub CI, `pnpm/action-setup` puts
  `pnpm` on PATH, so root `pnpm check` works there.
- **The sandbox can reset the local branch to the base commit mid-work**
  (happened again during CI-001): remote stays the source of truth.
  Recovery: `git fetch origin`, restore missing files with
  `git checkout <remote-sha> -- <paths>`, then
  `git reset --mixed <remote-sha>` and re-commit the real delta. Untracked
  files (HANDOVER.md etc.) can also get reverted — re-verify content after
  any weird `git status`.
- **mcp-server runs from a built bundle:** `ultracontext-mcp` bin =
  `dist/stdio.mjs` (tsdown; config in `tsdown.config.ts`). Rebuild with
  `pnpm --filter ultracontext-mcp-server run build` after touching
  `apps/mcp-server/src` — and build js-sdk first (`ultracontext` is a
  workspace dep resolved from its dist).
- `apps/js-sdk` has **no** `check` script → `./node_modules/.bin/tsc --noEmit -p tsconfig.json`.
  `apps/mcp-server` has 3 pre-existing `TS2307` errors (unresolved workspace
  types) — expect them.
- `/tmp/*` and sometimes `node_modules/` are **cleared between turns**.
  Re-run `corepack pnpm install --frozen-lockfile`. Prefer `./node_modules/.bin/*`
  over `npx`. `edit_file` is rooted at the workspace — use bash/sed for /tmp files.
- **Node:** v22.22.3. `node:sqlite` works without flags here (experimental
  warning is fine); the opencode parser degrades to "no events" if it's absent.
  **`mode` is silently dropped in the 4-arg `fs.writeFile(file, data, encoding,
  options)` form** — always pass one options object:
  `{ encoding: "utf8", mode: 0o600 }` (bit this in SEC-004; files landed 0644).
- **js-sdk runs from `dist/`, not `src/`:** `ultracontext.mjs` resolves
  `dist/cli/*.mjs` bundles first. Any fix in `apps/sync` or `apps/js-sdk/src`
  that the daemon executes is invisible until
  `cd apps/js-sdk && corepack pnpm build` (dist is gitignored).
- **Headless daemon:** `node apps/sync/src/index.mjs` (plain ESM — **no tsx in
  apps/sync**). State lives under `$HOME/.ultracontext`; point `HOME` at a fake
  dir for isolated E2E runs. `DAEMON_BOOTSTRAP_MODE=all` to ingest existing files.
- **Local API:** `cd apps/api && node_modules/.bin/tsx src/serve.ts` (PORT env).
  Key lands in `$ULTRACONTEXT_HOME/server.json`. Port 8899 has a stuck listener;
  8902/8903/8910 were used by past sessions.
- Hono: `app.use('/contexts*')` does NOT match bare `/contexts` — register both.
- Never delete a SQLite file while a server holds it open (SQLITE_READONLY_DBMOVED).
- libsql needs a `file:` URL. Bash heredocs + single quotes break `node -e` —
  write a temp `.cjs`/`.mjs` file. Never bare `npx tsc` (installs deprecated `tsc@2.0.4`).
- `Result` is a discriminated union — check `.ok` before `.data`.
- **Network in the sandbox:** npm registry + GitHub work; arbitrary hosts
  (e.g. codebuff.com) may be TLS-blocked. Read CLI source on GitHub instead of
  running unknown binaries.

---
## 6. Git

- Branch `arena/01a09075-ultracontext` (this session), linear history on top of
  `main` @ `1ff782b` (PR #1 merged).
- **Never force-push.** On divergence: `git ls-remote --heads origin <branch>` →
  backup branch → reset to remote → cherry-pick → resolve → push.
- GitHub Issues disabled; PRs and `gh` work.
