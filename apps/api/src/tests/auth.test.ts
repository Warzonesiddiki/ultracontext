// =============================================================================
// AUTH — constant-time secret verification (SEC-003)
// =============================================================================
// The admin token and the derived API-key hashes must be compared in
// constant time: a one-character-off guess must be rejected, and it must
// be rejected whether it is checked against the cache or against storage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { CachedKey, KeyCache } from '../cache/types';
import type { ApiConfig } from '../types/api';

const ADMIN_KEY = 'test-admin-key';
const ADMIN_KEY_WRONG_LAST_CHAR = 'test-admin-kei';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: ADMIN_KEY,
};

// minimal in-memory cache so the cached-hash comparison path is exercised
class MemKeyCache implements KeyCache {
    private map = new Map<string, CachedKey>();
    async get(prefix: string) {
        return this.map.get(prefix) ?? null;
    }
    async put(prefix: string, value: CachedKey) {
        this.map.set(prefix, value);
    }
}

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage, keyCache: new MemKeyCache() });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });

    const req = (path: string, auth?: string, method: 'GET' | 'POST' = 'GET', body?: unknown) =>
        app.request(`http://localhost${path}`, {
            method,
            headers: {
                ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        }) as unknown as Response;

    return { app, storage, req, apiKey, projectId: project!.id };
}

describe('API key verification', () => {
    it('accepts the valid key', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', apiKey);
        assert.equal(res.status, 200);
    });

    it('rejects a one-character-off key (storage path)', async () => {
        const { req, apiKey } = await setupTestApp();
        const wrong = apiKey.slice(0, -1) + (apiKey.at(-1) === 'A' ? 'B' : 'A');
        const res = await req('/contexts', wrong);
        assert.equal(res.status, 401);
    });

    it('rejects a same-prefix different-hash key after the real key populated the cache', async () => {
        const { storage, req, apiKey, projectId } = await setupTestApp();

        // a second key that collides on the 12-char lookup prefix
        const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
        const other = prefix + 'ZZZZZZZZZZ';
        assert.equal(other, apiKey.slice(0, KEY_PREFIX_LEN) + 'ZZZZZZZZZZ');
        const otherHash = await hashKey(other);
        const row = await storage.findApiKeyByPrefix(prefix);
        assert.ok(row, 'setup key exists under the shared prefix');
        assert.notEqual(row.key_hash, otherHash, 'fixture sanity: hashes must differ');

        // populate the cache with the REAL key, then try the look-alike:
        // the cache hit on prefix must fail the constant-time hash compare,
        // and the storage fallback must fail the stored-hash compare.
        const first = await req('/contexts', apiKey);
        assert.equal(first.status, 200);
        const impostor = await req('/contexts', other);
        assert.equal(impostor.status, 401);

        // and the real key still works (cache-hit success path)
        const again = await req('/contexts', apiKey);
        assert.equal(again.status, 200);
        assert.equal(projectId > 0, true);
    });

    it('rejects a missing bearer token', async () => {
        const { req } = await setupTestApp();
        const res = await req('/contexts');
        assert.equal(res.status, 401);
    });
});

describe('admin token verification', () => {
    it('accepts the valid admin key on POST /v1/keys', async () => {
        const { req } = await setupTestApp();
        const res = await req('/v1/keys', ADMIN_KEY, 'POST', { name: 'ci' });
        assert.equal(res.status, 200);
    });

    it('rejects a one-character-off admin key', async () => {
        const { req } = await setupTestApp();
        const res = await req('/v1/keys', ADMIN_KEY_WRONG_LAST_CHAR, 'POST', { name: 'ci' });
        assert.equal(res.status, 401);
    });

    it('rejects a different-length admin key', async () => {
        const { req } = await setupTestApp();
        const res = await req('/v1/keys', ADMIN_KEY + 'x', 'POST', { name: 'ci' });
        assert.equal(res.status, 401);
    });
});
