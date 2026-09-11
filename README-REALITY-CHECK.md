# README vs Reality

**Goal:** make UltraContext do exactly what the README promises — then more.
Every claim below was tested against the code, not inferred. Date: 2026-09-11 · commit `736b471`.

---

## TL;DR

The README makes **8 verifiable promises**. **3 are broken today**, 1 is materially
over-claimed, 1 under-claims, and your newest flagship feature is missing from it entirely.

| | Claim | Status |
|---|---|---|
| 1 | "Every change creates a new version" · "Time-travel" | ❌ **False for appends** — the daemon's only write |
| 2 | "Codex, grab the last plan Claude Code made" | ⚠️ Works — but the command is **documented nowhere** |
| 3 | "MCP server … or run standalone via stdio" | ❌ **Not shippable** — not in the npm package |
| 4 | "What's the team building today?" | ⚠️ Possible, but the setup is **undocumented** |
| 5 | "Auto-ingest Claude Code, Codex, and OpenClaw" | ⚠️ Under-claim — you ingest **6** sources |
| 6 | "Five methods … that's it" | ✅ Close enough |
| 7 | "Works with any LLM framework" | ✅ True, and documented |
| 8 | Local-first / SQLite | ➕ **Absent from the README** — your newest flagship feature |

**The single most important finding:** the feature your README leads with — git-like
versioning with time-travel — **is inert for the primary use case**, because the daemon only
ever appends, and appends don't create versions.

---

## 1 · "Automatic versioning — every change creates a new version" ❌

> *"Every change creates a new version. Full history out of the box."* · *"Time-travel — Jump to any point in your context history."*

**This is false for appends, and appends are the only thing the daemon does.**

Verified:

```
create              → version 0
append "plan step 1" → version 0
append "plan step 2" → version 0
append "plan step 3" → version 0
update               → version 1
history operations   → [ 'create', 'update' ]
```

`appendMessages` carries the comment *"version reflects the current head count (append adds
no new head)."* It's deliberate. But `apps/sync/src/daemon.mjs` only ever calls `uc.append`
(lines 817, 913) — never update, never a version-creating op.

**So every session the daemon captures has exactly one version, forever.**

Consequences, all verified:

| Feature | On a captured session |
|---|---|
| `?version=1` | ❌ `Version not found` |
| `?history=true` | ⚠️ returns `[create]` — no history to show |
| Rollback | ❌ nothing to roll back to |
| "Full history out of the box" | ❌ one entry |

Two compounding problems:

- **`MessageView` drops `created_at`.** `get-context.ts:113` maps `{...n.content, id, index, metadata}` —
  no `created_at`. Clients can't see when a message was created, so they can't discover
  timestamps to pass to `?before=`. Time-travel by timestamp works server-side but is
  practically unusable from the SDK.
- **Daemon metadata has no timestamp.** Appended metadata is
  `{source, host, user_id, session_id, event_id, file_path, file_offset}` — no wall-clock time.

### Fix

**Short term (cheap, honest):** snapshot-on-interval. Create a new version every *N* messages
or *T* seconds for ingested contexts, configurable via `DAEMON_SNAPSHOT_EVERY`. Time-travel
becomes real at useful granularity with no schema change.

**Long term (correct):** move to the actual git model. A version head should point at an
*immutable* message chain rather than owning the messages.

```
today:   head.context_id = messages      → appending can't version without re-pointing every row
git:     head → chain(tail_id)           → append = new head, zero copies
                                            update = new head + copy diverging nodes only
```

This also fixes **API-004** (every PATCH currently rewrites *all* nodes — O(n) inserts per
edit), because an update would copy only the diverging suffix.

**Also:** expose `created_at` on `MessageView`, and add it to daemon metadata.

---

## 2 · "Codex, grab the last plan Claude Code made and implement it" ⚠️

This is your best demo, and it exists — `ultracontext switch` (`apps/js-sdk/src/cli/switch.mjs`)
translates a session from one agent's format into another's and launches the target agent.

**But nobody can find it.**

- `grep -rn "switch" README.md apps/docs/` → **zero hits**
- The CLI docs (`apps/docs/fundamentals/cli.mdx`) list 7 commands; `switch` is not among them
- `openInNewTab()` returns `false` unless `os.platform() === "darwin"` — **macOS only**
- Supports `codex` ↔ `claude` only; Cursor, Gemini, and OpenClaw can't be switched to

So the one example your README leads with is undocumented, unadvertised, platform-locked,
and limited to 2 of your 6 sources.

### Fix

- Document it in the README and add `apps/docs/fundamentals/switch.mdx`
- Add a Linux/Windows launcher (`x-terminal-emulator`, `gnome-terminal`, Windows Terminal, `wt`)
- Extend to all sources you have writers for (`packages/parsers/src/writers/` has claude + codex)
- Add `--dry-run` output showing what will be carried over

---

## 3 · "MCP Server … Built into the API, or run standalone via stdio" ❌

The hosted half works (`POST /mcp` in the API, with a storage-backed reader — nicely done).
**The standalone half is not shippable.**

- `apps/js-sdk/package.json` `files` = `dist/, lib/, ultracontext.mjs, postinstall.mjs, assets/, plugin/`
  — the MCP server **is not included**, and `ultracontext-mcp-server` isn't a dependency
- `bin` points at `./dist/stdio.js`, which **is never built**
- `"build": "tsx src/stdio.ts --help || true"` — the `|| true` makes every failure pass
- The docs work around this by telling users to run from a repo clone:
  `npx tsx /path/to/ultracontext/apps/mcp-server/src/stdio.ts`

So an npm user — the audience the README addresses — cannot run the standalone server at all.

### Fix

Build and ship it (task **BUILD-002**), then add `ultracontext mcp` as a first-class
subcommand that configures the server for Claude/Codex/Cursor. If you decide not to ship it,
remove the claim from the README.

---

## 4 · "What's the team building today?" / "What is Alex working on in Codex right now?" ⚠️

Better than it looks — **the plumbing already exists**:

- The daemon tags every context and message with `user_id` and `host` (`daemon.mjs:799,814`)
- `ContextFilters` supports `user_id`, `host`, `source`, `session_id`, `after`, `before`
- The MCP server exposes them as tool arguments

So if a team shares **one API key** and each member sets `DAEMON_USER_ID`, both examples work
today via `listContexts({ user_id: "alex" })`.

**What's missing is the onboarding.** There is no team setup guide, no identity prompt in
`ultracontext config` (it defaults to `$USER`, e.g. an opaque login name), and no
team-oriented MCP tool — an agent has to know to filter by `user_id`.

### Fix

- Add `ultracontext config` identity step: *"What should other agents call you?"* → `DAEMON_USER_ID`
- Add `apps/docs/guides/team-setup.mdx`: one shared key per team, per-member identity
- Add MCP tools: `list_teammates`, `what_is_<user>_working_on`
- Longer term: real cross-project sharing (**TEAM-001**) so teams don't share one key

---

## 5 · "Auto-ingest Claude Code, Codex, and OpenClaw" ⚠️ (under-claim)

You ingest **six** sources (`daemon.mjs:509-537`):

`codex` · `claude` · `openclaw` · `cursor` · `gemini` · `gstack`

Cursor and Gemini are real differentiators — nobody else has them. They're invisible in the README.

**Fix:** update the feature table. Cheapest credibility win available.

---

## 6 · "Five methods — create, get, append, update, delete. That's it." ✅

Close enough. The surface is create / get (overloaded for list) / append / update / delete,
plus `deleteMany`, `/v1/keys`, and `/mcp`. `list` being folded into `get()` is a small
ergonomic oddity but not a broken promise.

Optional polish: a distinct `uc.list()` in both SDKs for discoverability.

---

## 7 · "Framework-agnostic — works with any LLM framework" ✅

True, and **well documented** — `apps/docs/guides/store-retrieve-contexts.mdx` has worked
examples for the Vercel AI SDK, OpenAI, and Anthropic. No gap.

---

## 8 · Local-first / SQLite ➕ (missing entirely)

`grep -ni "sqlite|local-first|offline|self-host" README.md` → **no matches**.

Your most recent commit is *"feat(storage): SQLite adapter — @ultracontext/core runs local,
no server (#38)."* It's the flagship new capability — and it appears nowhere in the README,
the features table, or (as far as I can tell) the docs site.

For a tool that reads developers' agent transcripts, **"runs entirely on your machine"** is
probably your strongest trust and adoption lever. It should be near the top of the README.

**Fix:** add a "Local-first" row to the features table and a section explaining that
`@ultracontext/core` + `@ultracontext/storage/sqlite` run with no server at all.

---

## Also broken (from the audit)

Two audit findings directly undermine README promises:

| ID | Why it matters here |
|---|---|
| **DATA-001** | `SupabaseAdapter.transaction()` is a no-op and production *is* Supabase. Every version-creating operation is non-atomic — a crash mid-update corrupts the **version history** that promises 1 and 8 depend on. |
| **BUILD-001** | The CLI resolves `ultracontext@1.0.2` from npm while the workspace SDK is at `1.5.0`, so the daemon users run never sees your SDK changes. |

Plus: README line 50 has a typo — *"or just ask what's happeming"* → "happening" — and
*"Requires Node >= 22"* should be **22.12.0** (the declared engine floor).

---

# "Even better" — beyond parity

Once the README is true, these would make it *more* than true. Ordered by
impact-to-effort.

### Tier 1 — high impact, contained

| Idea | Why |
|---|---|
| **`ultracontext ask "<question>"`** | The README says *"Ask questions."* Today that requires wiring up an MCP client. A CLI command that answers from your own captured context delivers the promise directly — and is a great demo. |
| **Semantic search over contexts** | *"Grab the last plan Claude Code made"* shouldn't need a session id. Embed message chunks; let `ask` and the MCP server retrieve by meaning. This is the difference between a store and a **context engineer** — your own words. |
| **`ultracontext diff ctx_a ctx_b`** | True git-like ergonomics. Cheap to build on the existing chain walker, and it makes the versioning story tangible. |
| **Auto-summarise / compact long contexts** | Solves the real problem your fork guide describes (*"the conversation gets too long, it starts forgetting"*). Roll old messages into a summary node on a new version. |
| **Redaction transparency report** | `ultracontext redact-report` showing what was redacted before upload. Directly answers the first objection anyone raises about this product. |

### Tier 2 — bigger swings

| Idea | Why |
|---|---|
| **Local-first end-to-end** | The SQLite adapter exists; wire the daemon and MCP server to it so the whole product runs with zero network. Your strongest trust lever, and the direction your last commit points. |
| **`ultracontext share ctx_...`** | Read-only, expiring share links. Delivers the team promise properly — with consent and audit — instead of everyone sharing one key. |
| **Cross-machine session continuity** | Same session id from two machines currently races. Make appends conflict-free (CRDT-ish, or per-machine branches). *"Same context everywhere"* implies multiple machines. |
| **Switch to all 6 sources** | Writers exist for claude + codex. Add cursor + gemini and the headline example works across every agent you support. |
| **Web dashboard** | Your README hero images imply one. The `status.json` IPC already has everything it needs. |
| **Hosted free tier + `ultracontext login`** | Removes the API-key step entirely. Biggest adoption unlock if you're willing to operate it. |

### Tier 3 — platform

| Idea | Why |
|---|---|
| **Context templates / replay** | "Start every session from this context" — turns captured context into reusable scaffolding. |
| **Hooks & event stream** | Webhook or SSE on new contexts/versions, so you can trigger your own automations. |
| **Retention & cost controls** | Per-project retention windows, size caps, archival. Needed before teams depend on it. |
| **Benchmarks** | Public latency/throughput numbers for append and get. Builds trust with the "shipping at inference speed" crowd. |

---

# Recommended order

**Ship the 3 P0 security fixes first** — SEC-001, SEC-002, SEC-004 are each under an hour and
one is a confirmed cross-tenant read. Then:

| # | Task | Effort | Unblocks |
|---|---|---|---|
| 1 | Add `created_at` to `MessageView` + daemon metadata | S | makes time-travel usable |
| 2 | Snapshot-on-interval versioning | M | **makes "every change creates a version" true** |
| 3 | Build + ship the standalone MCP server | M | promise 3 |
| 4 | Document `switch`; extend to Linux/Windows | M | promise 2 |
| 5 | Team setup guide + identity prompt | M | promise 4 |
| 6 | README: 6 sources, local-first section, typo, Node version | S | promises 5 + 8 |
| 7 | Fix DATA-001 (real transactions) | L | protects everything above |
| 8 | Git-model refactor (heads → immutable chains) | L | fixes API-004 too |
| 9 | `ultracontext ask` + semantic search | L | the "even better" headline |

Steps 1–6 are roughly a week and turn the README from three broken promises into an accurate
description of a stronger product.

---

## Appendix — reproducing

```bash
# versioning behaviour
node --import tsx  # in packages/core
createContext → getContext.version        # 0
appendMessages ×3 → getContext.version    # still 0   ← the bug
updateMessages  → getContext.version      # 1

# undocumented command
grep -rn "switch" README.md apps/docs/     # zero hits

# MCP server not shipped
node -e "console.log(require('./apps/js-sdk/package.json').files)"   # no mcp-server
ls apps/mcp-server/dist                                              # does not exist

# sources
grep -n "sources.push" apps/sync/src/daemon.mjs   # 6, README says 3
```
