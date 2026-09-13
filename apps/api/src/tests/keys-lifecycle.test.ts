// =============================================================================
// KEY LIFECYCLE — list / revoke / rotate (SEC-005)
// =============================================================================
// A leaked key must be invalidatable within a minute. These tests pin the
// admin lifecycle surface: list never leaks the hash, revoke takes effect
// immediately (even when the key was cached), rotate kills the old key,
// and failed admin-token guesses are throttled.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { CachedKey, KeyCache } from '../cache/types';
import type { ApiConfig } from '../types/api';

const ADMIN_KEY = 'test-admin-key';
const WRONG_ADMIN = 'test-admin-keyX';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: ADMIN_KEY,
};

class MemKeyCache implements KeyCache {
    private map = new Map<string, CachedKey>();
    async get(prefix: string) {
        return this.map.get(prefix) ?? null;
    }
    async put(prefix: string, value: CachedKey) {
        this.map.set(prefix, value);
    }
    async delete(prefix: string) {
        this.map.delete(prefix);
    }
    /** test hook: is a prefix currently cached? */
    has(prefix: string) {
        return this.map.has(prefix);
    }
}

async function setupTestApp() {
    const storage = new MemoryStorage();
    const keyCache = new MemKeyCache();
    const app = createApp({ config: TEST_CONFIG, storage, keyCache });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    await storage.insertApiKey({
        project_id: project!.id,
        key_prefix: apiKey.slice(0, KEY_PREFIX_LEN),
        key_hash: await hashKey(apiKey),
    });

    const req = (path: string, auth: string | undefined, method: 'GET' | 'POST' | 'DELETE' = 'GET', body?: unknown) =>
        app.request(`http://localhost${path}`, {
            method,
            headers: {
                ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        }) as unknown as Response;

    return { app, storage, keyCache, req, apiKey, projectId: project!.id };
}

describe('GET /v1/keys/:projectId', () => {
    it('lists the project keys (admin) without exposing the hash', async () => {
        const { req, storage, apiKey, projectId } = await setupTestApp();

        const res = await req(`/v1/keys/${projectId}`, ADMIN_KEY);
        assert.equal(res.status, 200);
        const body = (await res.json()) as { project_id: number; keys: Array<Record<string, unknown>> };

        assert.equal(body.project_id, projectId);
        assert.equal(body.keys.length, 1);
        assert.equal(body.keys[0].key_prefix, apiKey.slice(0, KEY_PREFIX_LEN));
        assert.equal(typeof body.keys[0].created_at, 'string');

        const row = await storage.findApiKeyByPrefix(apiKey.slice(0, KEY_PREFIX_LEN));
        assert.ok(row, 'the hash exists in storage');
        const raw = JSON.stringify(body);
        assert.ok(!raw.includes('key_hash'), 'listing must not contain the hash field');
        assert.ok(!raw.includes(row.key_hash), 'listing must not contain the hash value');
    });

    it('rejects a non-admin API key', async () => {
        const { req, projectId, apiKey } = await setupTestApp();
        const res = await req(`/v1/keys/${projectId}`, apiKey);
        assert.equal(res.status, 401);
    });

    it('rejects a malformed projectId', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/v1/keys/abc', ADMIN_KEY)).status, 400);
        assert.equal((await req('/v1/keys/0', ADMIN_KEY)).status, 400);
        assert.equal((await req('/v1/keys/1.5', ADMIN_KEY)).status, 400);
    });
});

describe('DELETE /v1/keys/:id (revoke)', () => {
    it('revoked key stops working immediately — even when it was cached', async () => {
        const { req, storage, keyCache, apiKey } = await setupTestApp();
        const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
        const row = await storage.findApiKeyByPrefix(prefix);
        assert.ok(row);

        // use the key once so the auth cache is populated with it
        const before = await req('/contexts', apiKey);
        assert.equal(before.status, 200);
        assert.equal(keyCache.has(prefix), true, 'key should be cached');

        const res = await req(`/v1/keys/${row.id}`, ADMIN_KEY, 'DELETE');
        assert.equal(res.status, 200);
        const body = (await res.json()) as { revoked: boolean };
        assert.equal(body.revoked, true);
        assert.equal(keyCache.has(prefix), false, 'cache entry must be evicted');

        // the leaked key no longer authenticates
        const after = await req('/contexts', apiKey);
        assert.equal(after.status, 401);
    });

    it('revoking an unknown id is 404', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/v1/keys/999', ADMIN_KEY, 'DELETE')).status, 404);
    });

    it('rejects non-admin callers', async () => {
        const { req, apiKey } = await setupTestApp();
        assert.equal((await req('/v1/keys/1', apiKey, 'DELETE')).status, 401);
    });
});

describe('POST /v1/keys/:id/rotate', () => {
    it('old key dies (even cached), new key works, same project', async () => {
        const { req, storage, keyCache, apiKey, projectId } = await setupTestApp();
        const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
        const row = await storage.findApiKeyByPrefix(prefix);
        assert.ok(row);

        // populate the cache with the old key first
        assert.equal((await req('/contexts', apiKey)).status, 200);
        assert.equal(keyCache.has(prefix), true);

        const res = await req(`/v1/keys/${row.id}/rotate`, ADMIN_KEY, 'POST');
        assert.equal(res.status, 200);
        const body = (await res.json()) as { key: string; prefix: string; project_id: number };
        assert.equal(typeof body.key, 'string');
        assert.ok(body.key.startsWith('uc_live_'));
        assert.equal(body.project_id, projectId);
        assert.ok(!('old_prefix' in body), 'old prefix is not returned to the client');
        assert.equal(keyCache.has(prefix), false, 'old key evicted from cache');

        // old key dead, new key alive
        assert.equal((await req('/contexts', apiKey)).status, 401);
        assert.equal((await req('/contexts', body.key)).status, 200);
    });

    it('rotating an unknown id is 404', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/v1/keys/999/rotate', ADMIN_KEY, 'POST')).status, 404);
    });
});

describe('admin auth-failure throttling', () => {
    it('sustained bad admin tokens get throttled to 429 (AUTH_FAILURE_PER_IP)', async () => {
        const { req } = await setupTestApp();

        const statuses: number[] = [];
        for (let i = 0; i < 25; i++) {
            const res = await req('/v1/keys/1', `wrong-admin-${i}`, 'GET');
            statuses.push(res.status);
            if (res.status === 429) break;
        }

        // the first failures are 401s; once the failure bucket (20/min) is
        // spent, further guesses get 429 — well before the 300/min per-IP cap
        assert.ok(statuses.includes(401), 'expected some 401s first');
        assert.ok(statuses.includes(429), `expected a 429 within 25 attempts: ${statuses.join(',')}`);
        const first429 = statuses.indexOf(429);
        assert.ok(first429 <= 20, `429 should land by attempt 21, landed at ${first429 + 1}`);
    });

    it('a valid admin token does not consume the failure budget', async () => {
        const { req, projectId } = await setupTestApp();
        for (let i = 0; i < 5; i++) {
            const res = await req(`/v1/keys/${projectId}`, ADMIN_KEY);
            assert.equal(res.status, 200);
        }
        // still room for failed guesses after 5 successes
        const res = await req('/v1/keys/1', 'wrong-admin');
        assert.equal(res.status, 401);
    });
});
