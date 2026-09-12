<p align="center">
  <a href="https://ultracontext.ai">
    <img src="https://ultracontext.ai/gh-cover.png" alt="UltraContext" />
  </a>
</p>

<h3 align="center">Same context. Everywhere.</h3>

<p align="center">
  Start on Claude Code. Continue on Codex.<br/>
  Open source, realtime and invisible context infrastructure for the ones shipping at inference speed.
</p>

<p align="center">
  <a href="https://ultracontext.ai/docs">Documentation</a> ·
  <a href="https://ultracontext.ai/docs/api-reference/introduction">API Reference</a> ·
  <a href="https://ultracontext.ai/docs/changelog">Changelog</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/ultracontext">
    <img src="https://img.shields.io/npm/v/ultracontext" alt="npm version" />
  </a>
  <a href="https://pypi.org/project/ultracontext/">
    <img src="https://img.shields.io/pypi/v/ultracontext" alt="PyPI version" />
  </a>
  <a href="https://github.com/ultracontext/ultracontext/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ultracontext/ultracontext" alt="license" />
  </a>
  <a href="https://ultracontext.ai">
    <img src="https://img.shields.io/badge/Visit-ultracontext.ai-4B6EF5" alt="Visit ultracontext.ai" />
  </a>
</p>

<div align="center">
  <a href="https://twitter.com/ultracontext">
    <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" />
  </a>
  <a href="https://discord.com/invite/4HjcS6KwhW">
    <img src="https://img.shields.io/badge/Join%20our%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join our Discord" />
  </a>
</div>

---

![ultracontext-gif](https://github.com/user-attachments/assets/be73afe5-161d-4fa3-8f4d-c4987fe63cb4)

What Claude Code knows, Codex doesn't. What your teammate is shipping right now? Your agent has no idea.

UltraContext captures every agent's context in realtime and makes it available to all of them. It's like having a personal context engineer everywhere. Continue a session in a different agent, or just ask what's happening.

For example:

- *"Codex, grab the last plan Claude Code made and implement it."*
- *"What's the team building today?"*
- *"What is Alex working on in Codex right now?"*

Open source. Framework-agnostic. Customizable via the git-like Context API.

## Features

| CLI | Auto-ingest sessions from Claude Code, Codex, Cursor, Gemini CLI, OpenClaw, opencode, Antigravity (agy), Freebuff and gstack, with a terminal dashboard. |
| --- | --- |
| MCP Server | Share context everywhere. Built into the API, or run standalone via stdio. |
| Context API | Git-like context engineering API. Store, version, and retrieve agent context with zero complexity. |
| Search | Full-text search across every captured session. Find a plan by what it says, not by its ID. |
| Analytics | Usage totals, per-agent breakdown and a day/week/month series — computed from your own database. |
| Backups | Safe online snapshots of your local database, protected restore, and a retention GC — free and local. |
| Self-hosted | Run the whole thing on your own machine against a local SQLite file. No account, no cloud, no cost. |

---

## How it works

1. **Start sync.** It captures all your agents' context in realtime.

2. **Add the MCP server.** Any agent gets full awareness of every other agent.

3. **That's it.** Ask questions, continue sessions, fork — your context is everywhere.

## Install

Requires Node >= 22.12.0.

```bash
npm install -g ultracontext
```

## Run it locally — free, forever

UltraContext is **100% free and self-hosted**. One command runs the entire product
on your own machine: the API, the MCP endpoint, full-text search, and storage in a
local SQLite file. No account, no Docker, no Postgres, no network.

```bash
ultracontext serve
```

```
UltraContext is running locally.
  API      http://127.0.0.1:8787
  MCP      http://127.0.0.1:8787/mcp
  Search   http://127.0.0.1:8787/contexts/search?q=…
  Stats    http://127.0.0.1:8787/contexts/stats?bucket=day

  API key  uc_live_…          (stored in ~/.ultracontext/server.json, mode 0600)

Free and self-hosted. No account, no quota, no paywall, no network required.
```

On first run it generates an admin key and an API key, writes them to
`~/.ultracontext/` with `0600` permissions, and prints a ready-to-paste command
for connecting an agent. Everything stays on your disk.

```bash
ultracontext serve --port 9000     # pick a port
DATABASE_PROVIDER=postgres DATABASE_URL=… ultracontext serve    # or bring your own Postgres
```

### The whole loop, offline

`serve` records the port and key in `~/.ultracontext/server.json`, so
everything else finds it automatically — **zero config, zero network**:

```bash
ultracontext serve    # terminal 1 — API + MCP + search on localhost
ultracontext sync     # terminal 2 — daemon picks the local server up automatically
```

The capture daemon and the standalone MCP server resolve credentials in the
same order: explicit `ULTRACONTEXT_API_KEY` / `ULTRACONTEXT_BASE_URL` → the
local `server.json` → the hosted `config.json` (from `ultracontext config`).
Set `ULTRACONTEXT_LOCAL=1` to force local mode. Your agents' transcripts never
leave the machine.

## Quick Start

```bash
ultracontext          # start sync (daemon + dashboard)
```

That's it. UltraContext watches your agents, ingests context in realtime, and the dashboard shows everything.

```bash
ultracontext sync     # start sync (daemon + dashboard) — auto-finds a local server
ultracontext serve    # run the context server locally (SQLite, free)
ultracontext stats    # usage analytics for everything you captured (free)
ultracontext backup   # safe local snapshot + protected restore (free)
ultracontext gc       # retention: drop sessions older than your window (free)
ultracontext switch   # continue a session in a different agent
ultracontext stop     # stop daemon
ultracontext config   # run setup wizard
ultracontext update   # update CLI globally
```

## Agent integrations

UltraContext ingests sessions from every AI coding harness you run, straight from
its on-disk store. All sources are on by default; disable any of them with the
`INGEST_<NAME>=0` env var (or point the glob at a custom location).

| Source | What it reads | Default location |
| --- | --- | --- |
| `claude` | Claude Code JSONL sessions | `~/.claude/projects/**/*.jsonl` |
| `codex` | Codex CLI JSONL sessions | `~/.codex/sessions/**/*.jsonl` |
| `cursor` | Cursor JSONL sessions | `~/.cursor/projects/**/*.jsonl` |
| `gemini` | Gemini CLI JSON chat files | `~/.gemini/tmp/*/chats/session-*.json` |
| `openclaw` | OpenClaw JSONL sessions | `~/.openclaw/agents/*/sessions/**/*.jsonl` |
| `opencode` | opencode's SQLite DB (v1.2.0+, both current `session_message` and older `message`/`part` schemas) plus the pre-1.2 JSON storage layout | `${XDG_DATA_HOME:-~/.local/share}/opencode` (`OPENCODE_DATA_DIR` accepts a comma-separated list) |
| `agy` | Google Antigravity CLI/IDE JSONL transcripts (untruncated) | `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl` + `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl` |
| `freebuff` | Freebuff (CodebuffAI) `chat-messages.json` per chat | `~/.config/manicode/projects/*/chats/*/chat-messages.json` |
| `gstack` | gstack skill artifacts | `~/.gstack/projects/**/*.jsonl` |

Notes:

- **Ingest-only where marked.** `ultracontext switch` (continue a session in a
  different agent) currently has writers for `claude` and `codex` only. The other
  sources are ingested and searchable; they cannot be written back to.
- Antigravity (`agy`) scans the CLI store and the IDE store, deliberately
  skipping the `antigravity-ide` and `antigravity-backup` siblings so the same
  conversation is not captured two or three times.
- opencode reads its database **read-only** — it never locks or modifies the
  file, even while opencode is running.

## Context API

For builders who want to go deeper. Git-like primitives for context engineering.

- **Five methods** — Create, get, append, update, delete. That's it.
- **Automatic versioning** — Every append, edit, or delete creates a new version. Full history out of the box.
- **Time-travel** — Jump to any point in your context history, by version or by timestamp.
- **Full-text search** — Query every captured session by what it says.
- **Analytics** — Totals, per-agent breakdown and a day/week/month series, computed over your own data.
- **Framework-agnostic** — Works with any LLM framework. No vendor lock-in.

### Search

Find a plan, a decision, or an error without knowing which session it was in.

```typescript
const { data } = await uc.search({ query: 'refactor the auth middleware' });
// → [{ context_id, message_id, content, metadata: { source, user_id, session_id }, created_at }]
```

```python
results = uc.search(query="refactor the auth middleware")
```

Search is **free and unmetered** — there is no query quota. Locally it runs on
SQLite FTS5 (porter stemming, bm25 ranking, prefix matching); on Postgres it uses
`tsvector` ranking. It never leaves your machine.

### Analytics

See what you have captured, by agent and over time — no telemetry pipeline, no
third party, and no retention window that quietly truncates your history.

```bash
ultracontext stats --bucket day --days 30
```

```
UltraContext Stats  by day · 2026-09-09 → 2026-09-11

  messages    7   sessions   4   sources  3
  contexts    8   nodes      15   active   1

  ▁▁█

  2026-09-09         0
  2026-09-10         0
  2026-09-11  ████████████████████████████       7

  By source
  claude   ████████████████████████████       7 msgs
```

```typescript
const stats = await uc.stats({ bucket: 'week', days: 12 });
// → { bucket, from, to, totals: { messages, contexts, root_contexts, sources, … },
//     by_source: [{ source, messages, … }], series: [{ bucket_start, messages, … }] }
```

```bash
curl -H "Authorization: Bearer $ULTRACONTEXT_API_KEY" \
  "$ULTRACONTEXT_BASE_URL/contexts/stats?bucket=month&days=12"
```

Agents can ask too — the MCP server exposes `get_activity_stats`.

Running Postgres? Point any BI tool (Metabase, Grafana, Superset, plain `psql`)
at the `project_activity_daily` / `project_activity_weekly` views in
[apps/postgres/init.sql](./apps/postgres/init.sql). It is your database; nothing
is hidden behind an API we control.

### Backups & retention

Your data is one local SQLite file, and everything you need to protect it is built in — no paid backup tier, nothing leaves the machine.

```bash
ultracontext backup                    # safe snapshot (works while the server runs)
ultracontext backup --list             # show existing backups
ultracontext backup --restore <file>   # roll back (auto-saves your current state first)
ultracontext backup --full             # + config, API keys, daemon state (0600 .tar.gz)
ultracontext gc --keep 30d             # drop sessions idle for 30+ days
ultracontext gc --keep 6mo --dry-run   # preview only, delete nothing
```

- **Snapshots are safe even while the server is running** — they use SQLite's
  online backup API and are `integrity_check`-verified before being reported.
  The 10 newest are kept automatically (`--keep` to change).
- **Restore is protected.** The current database is saved as
  `pre-restore-<timestamp>.sqlite` before anything is replaced, and restore
  refuses to run while the local server is running (`--force` overrides).
- **Retention is opt-in and previewable.** `gc` drops whole sessions — every
  version and message — whose last activity is older than the window.
  `--dry-run` shows what would go, `--vacuum` reclaims the disk space.
  A good cron: `0 3 * * * ultracontext gc --keep 6mo`.

### No paywall, ever

UltraContext is Apache-2.0 and self-hostable in full. Every capability — search,
analytics, versioning, forking, the MCP server, every agent integration — is
available free, with no account and no usage cap. There is no paid tier to unlock.

Use the API standalone to build your own agents, or extend existing ones in UltraContext.

| SDK                   | Install                    | Source                               |
| --------------------- | -------------------------- | ------------------------------------ |
| JavaScript/TypeScript | `npm install ultracontext` | [apps/js-sdk](./apps/js-sdk)         |
| Python                | `pip install ultracontext` | [apps/python-sdk](./apps/python-sdk) |

### JavaScript/TypeScript

```bash
npm install ultracontext
```

```typescript
import { UltraContext } from 'ultracontext';

const uc = new UltraContext({ apiKey: 'uc_live_...' });

const ctx = await uc.create();
await uc.append(ctx.id, { role: 'user', content: 'Hello!' });

// use with any LLM framework
const response = await generateText({ model, messages: ctx.data });
```

### Python

```bash
pip install ultracontext
```

```python
from ultracontext import UltraContext

uc = UltraContext(api_key="uc_live_...")

ctx = uc.create()
uc.append(ctx["id"], {"role": "user", "content": "Hello!"})

# use with any LLM framework
response = generate_text(model=model, messages=uc.get(ctx["id"])["data"])
```

<p align="center">📚 Context API Guides</p>
<p align="center">
  <a href="https://ultracontext.ai/docs/guides/store-retrieve-contexts">Store & Retrieve</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/edit-contexts">Edit Contexts</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/fork-clone-contexts">Fork & Clone</a>
  ·
  <a href="https://ultracontext.ai/docs/guides/view-context-history">View History</a>
</p>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=ultracontext/ultracontext-node&type=date&legend=top-left)](https://www.star-history.com/#ultracontext/ultracontext-node&type=date&legend=top-left)

## Documentation

- [Quickstart](https://ultracontext.ai/docs/quickstart) — Get running in 2 minutes
- [Guides](https://ultracontext.ai/docs/guides/store-retrieve-contexts) — Practical patterns for common use cases
- [API Reference](https://ultracontext.ai/docs/api-reference/introduction) — Full endpoint documentation
