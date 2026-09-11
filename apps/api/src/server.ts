import { serve } from '@hono/node-server';

import { createApp } from './app';
import { getApiConfig } from './config.node';
import { createStorageAdapter } from '@ultracontext/storage';

// -- Node.js entrypoint -------------------------------------------------------

const config = getApiConfig();
const storage = await createStorageAdapter(config);
const app = createApp({ config, storage });
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port });

const backend = config.DATABASE_PROVIDER === 'sqlite'
    ? `sqlite (${config.DATABASE_FILE})`
    : config.DATABASE_PROVIDER;

console.log(`UltraContext API listening on http://127.0.0.1:${port}`);
console.log(`Storage: ${backend} — local, self-hosted, no quota, no paywall.`);
