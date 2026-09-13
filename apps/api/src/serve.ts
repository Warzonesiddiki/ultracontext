#!/usr/bin/env node
// =============================================================================
// ultracontext serve — run the whole product locally, for free, in one command
// =============================================================================
// No Docker. No Postgres. No Supabase. No account. No network.
// A SQLite file in ~/.ultracontext and an HTTP server on localhost.
//
//   $ ultracontext serve
//
// On first run it generates an admin key, creates a default project + API key,
// writes them to ~/.ultracontext (mode 0600), and prints an MCP config snippet.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';

import { serve } from '@hono/node-server';

import { createApp } from './app';
import { createStorageAdapter } from '@ultracontext/storage';
import { createKey } from '@ultracontext/core';
import { MemoryRateLimiter } from './rate-limit/memory';
import { repairAllProjects } from './repair';

// -- paths --------------------------------------------------------------------

const HOME = os.homedir();
const DIR = process.env.ULTRACONTEXT_HOME ?? path.join(HOME, '.ultracontext');
const CONFIG_FILE = path.join(DIR, 'server.json');
const DEFAULT_DB = path.join(DIR, 'ultracontext.db');

// -- 0600 hygiene: this directory holds API keys ------------------------------

function ensureDir(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
}

function readJson(file: string): Record<string, unknown> {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { return {}; }
}

function writeJson0600(file: string, data: Record<string, unknown>) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// -- main ---------------------------------------------------------------------

async function main() {
    ensureDir(DIR);

    const args = process.argv.slice(2);
    const portFlag = args.indexOf('--port');
    const port = portFlag !== -1 ? Number(args[portFlag + 1]) : Number(process.env.PORT ?? 8787);
    if (!Number.isInteger(port) || port <= 0) {
        console.error('Invalid --port value');
        process.exit(1);
    }

    // 1 — admin key: reuse, or generate once and persist at 0600
    let state = readJson(CONFIG_FILE);
    let adminKey = process.env.ULTRACONTEXT_ADMIN_KEY ?? (state.adminKey as string | undefined);

    if (!adminKey) {
        adminKey = `uc_admin_${randomBytes(24).toString('base64url')}`;
        state = { ...state, adminKey };
        writeJson0600(CONFIG_FILE, state);
        console.log(`Generated admin key → ${CONFIG_FILE}`);
    }
    process.env.ULTRACONTEXT_ADMIN_KEY = adminKey;

    // record the port so `ultracontext sync` and the MCP server can discover
    // this server automatically (FREE-007 — zero-config local mode)
    if (state.port !== port) {
        state = { ...state, port };
        writeJson0600(CONFIG_FILE, state);
    }

    // 2 — storage: SQLite unless the user explicitly configured something else
    const provider = (process.env.DATABASE_PROVIDER ?? 'sqlite').toLowerCase();
    let config: any;
    if (provider === 'sqlite') {
        const dbFile = process.env.DATABASE_FILE ?? DEFAULT_DB;
        config = { DATABASE_PROVIDER: 'sqlite' as const, DATABASE_FILE: dbFile, ULTRACONTEXT_ADMIN_KEY: adminKey };
        console.log(`Storage: ${cyan(dbFile)}`);
    } else if (provider === 'postgres') {
        if (!process.env.DATABASE_URL) { console.error('DATABASE_PROVIDER=postgres requires DATABASE_URL'); process.exit(1); }
        config = { DATABASE_PROVIDER: 'postgres' as const, DATABASE_URL: process.env.DATABASE_URL, ULTRACONTEXT_ADMIN_KEY: adminKey };
        console.log(`Storage: ${cyan('postgres')}`);
    } else if (provider === 'supabase') {
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
            console.error('DATABASE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
            process.exit(1);
        }
        config = {
            DATABASE_PROVIDER: 'supabase' as const,
            SUPABASE_URL: process.env.SUPABASE_URL,
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
            ULTRACONTEXT_ADMIN_KEY: adminKey,
        };
        console.log(`Storage: ${cyan('supabase')}`);
    } else {
        console.error(`Unknown DATABASE_PROVIDER: ${provider} (expected sqlite, postgres or supabase)`);
        process.exit(1);
    }

    const storage = await createStorageAdapter(config);

    // DATA-001: heal version chains damaged by crashes of older code (an
    // orphaned head or a headless root). Current ops are single-statement and
    // can't create these states; this covers legacy databases on upgrade.
    // Best effort — a repair failure must not block startup.
    await repairAllProjects(storage).catch(() => undefined);

    // 3 — first run: make a project + API key so this is usable immediately
    let apiKey = state.apiKey as string | undefined;
    if (!apiKey) {
        const created = await createKey(storage, 'local');
        if (created.ok) {
            apiKey = created.data.key;
            state = { ...state, apiKey, projectId: created.data.project_id };
            writeJson0600(CONFIG_FILE, state);
        } else {
            console.error(`Could not create a local API key: ${created.message}`);
        }
    }

    // 4 — serve
    const app = createApp({
        config,
        storage,
        rateLimiter: new MemoryRateLimiter(),
    });

    const url = `http://127.0.0.1:${port}`;

    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });

    console.log('');
    console.log(green('UltraContext is running locally.'));
    console.log(`  API      ${cyan(url)}`);
    console.log(`  MCP      ${cyan(`${url}/mcp`)}`);
    console.log(`  Search   ${cyan(`${url}/contexts/search?q=…`)}`);
    console.log('');
    if (apiKey) console.log(`  API key  ${dim(apiKey)}`);
    console.log(`  ${dim('Stored in')} ${CONFIG_FILE} ${dim('(mode 0600)')}`);
    console.log('');
    console.log(dim('Free and self-hosted. No account, no quota, no paywall, no network required.'));
    console.log('');
    console.log(dim('Or just start capturing — `ultracontext sync` finds this server automatically:'));
    console.log(cyan('    ultracontext sync'));
    console.log('');
    console.log(dim('Point an agent at it (Claude Code):'));
    console.log(cyan(`    claude mcp add ultracontext --transport http ${url}/mcp --header "Authorization: Bearer ${apiKey ?? '<key>'}"`));
    console.log('');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
