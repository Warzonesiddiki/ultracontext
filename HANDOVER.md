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
**PROM-002 (version on append — the git model)** — see the notes below the
table for FREE-006, FREE-007 and PROM-002.

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

### PROM-002 — version on append, the zero-copy git model (shipped last in this thread)

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

---
## 2. Test + typecheck baseline (current)

```
packages/core        196 pass / 0 fail   (was 191; +5 PROM-002 version-on-append)
packages/storage      20 pass / 0 fail
packages/parsers      98 pass / 0 fail   (was 69; +29 new: opencode 19, agy 7, freebuff 7… see tests/parsers/)
apps/js-sdk           48 pass / 0 fail   (was 30; +13 backup/gc, +5 local-server)
apps/sync             10 pass / 0 fail
apps/api              38 pass / 0 fail   (1 assertion updated: delete after append => version 2)
apps/mcp-server        5 pass / 0 fail   (new: src/config.test.ts)
────────────────────────────────────
total                415 pass / 0 fail
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
(interactive, now **64** tasks incl. FREE-006/007/008 SHIPPED), `README-REALITY-CHECK.md`.
GitHub Issues are **disabled** on this repo (403) — local artifacts are the board.

Next highest-value (plus the open-ended harness list):
- **SEC-002** (CORS), **CI-001** (no CI), **DATA-004/DATA-001**.
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
  Root `pnpm check` runs `pnpm -r` and fails with `sh: pnpm: not found`;
  run `corepack pnpm check` **per package**.
- `apps/js-sdk` has **no** `check` script → `./node_modules/.bin/tsc --noEmit -p tsconfig.json`.
  `apps/mcp-server` has 3 pre-existing `TS2307` errors (unresolved workspace
  types) — expect them.
- `/tmp/*` and sometimes `node_modules/` are **cleared between turns**.
  Re-run `corepack pnpm install --frozen-lockfile`. Prefer `./node_modules/.bin/*`
  over `npx`. `edit_file` is rooted at the workspace — use bash/sed for /tmp files.
- **Node:** v22.22.3. `node:sqlite` works without flags here (experimental
  warning is fine); the opencode parser degrades to "no events" if it's absent.
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
