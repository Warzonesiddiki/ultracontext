import { serve } from '@hono/node-server';

import { createApp } from './app';
import { getApiConfig } from './config.node';
import { createStorageAdapter } from '@ultracontext/storage';
import { MemoryRateLimiter } from './rate-limit/memory';

// -- Node.js entrypoint -------------------------------------------------------

const config = getApiConfig();
const storage = await createStorageAdapter(config);

// Abuse protection only. Self-hosters can turn it off entirely with
// RATE_LIMIT_DISABLED=1 — UltraContext has no paid tier to upsell.
const rateLimitDisabled = ['1', 'true', 'yes'].includes(String(process.env.RATE_LIMIT_DISABLED ?? '').toLowerCase());

const app = createApp({
    config,
    storage,
    rateLimiter: rateLimitDisabled ? null : new MemoryRateLimiter(),
});
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });

const backend = config.DATABASE_PROVIDER === 'sqlite'
    ? `sqlite (${config.DATABASE_FILE})`
    : config.DATABASE_PROVIDER;

console.log(`UltraContext API listening on http://127.0.0.1:${port}`);
console.log(`Storage: ${backend} — local, self-hosted, no quota, no paywall.`);
console.log(`Rate limiting: ${rateLimitDisabled ? 'disabled' : 'on (abuse protection only, not a quota)'}.`);
