import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

// =============================================================================
// HEALTH — liveness + readiness probes (API-007)
// Unauthenticated: load balancers / orchestrators cannot hold API keys.
// =============================================================================

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });
    return { app, storage };
}

describe('GET /health (liveness)', () => {
    it('returns 200 {status: ok} without authentication', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/health');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: 'ok' });
    });

    it('does not touch storage', async () => {
        const { app, storage } = await setupTestApp();
        let touched = false;
        const real = storage.listProjects.bind(storage);
        storage.listProjects = async () => {
            touched = true;
            return real();
        };
        const res = await app.request('http://localhost/health');
        assert.equal(res.status, 200);
        assert.equal(touched, false);
    });
});

describe('GET /health/ready (readiness)', () => {
    it('returns 200 {status: ready} when storage answers', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/health/ready');
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { status: 'ready' });
    });

    it('returns 503 {status: not_ready} with the error when storage fails', async () => {
        const { app, storage } = await setupTestApp();
        storage.listProjects = async () => {
            throw new Error('connection refused');
        };
        const res = await app.request('http://localhost/health/ready');
        assert.equal(res.status, 503);
        const body = (await res.json()) as { status: string; error: string };
        assert.equal(body.status, 'not_ready');
        assert.equal(body.error, 'connection refused');
    });

    it('does not require authentication', async () => {
        const { app } = await setupTestApp();
        // no Authorization header at all — probes must work keyless
        const res = await app.request('http://localhost/health/ready');
        assert.equal(res.status, 200);
    });
});

describe('root route regression', () => {
    it('GET / still returns the welcome message', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/');
        assert.equal(res.status, 200);
        const body = (await res.json()) as { message: string };
        assert.equal(body.message, 'UltraContext API');
    });
});
