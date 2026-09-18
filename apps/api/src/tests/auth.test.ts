// =============================================================================
// AUTH — constant-time secret verification (SEC-003)
// =============================================================================
// The admin token and the derived API-key hashes must be compared in
// constant time: a one-character-off guess must be rejected, and it must
// be rejected whether it is checked against the cache or against storage.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN, type StorageAdapter } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { CachedKey, KeyCache } from '../cache/types';
import type { ApiConfig } from '../types/api';
import { scheduleApiKeyLastUsedAt } from '../middleware/auth';

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
    async delete(prefix: string) {
        this.map.delete(prefix);
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

// =============================================================================
// AUTH — last_used_at throttling (API-005)
// =============================================================================
// last_used_at must be updated at most once per N minutes per key, and the
// write must be off the request latency path (fire-and-forget).

describe('last_used_at throttling (API-005)', () => {
    // unique ids per test: the last-write stamp map is module state, so each
    // test must not collide with another test's stamps
    let unitKeySeq = 990000;
    const nextUnitKeyId = () => ++unitKeySeq;

    function countingStorage() {
        const calls: Array<{ id: number; ts: string }> = [];
        return {
            calls,
            storage: {
                updateApiKeyLastUsedAt: async (id: number, ts: string) => {
                    calls.push({ id, ts });
                },
            } as unknown as StorageAdapter,
        };
    }

    it('writes at most once per interval window (explicit clock)', async () => {
        const { storage, calls } = countingStorage();
        const stamps = new Map<number, number>();
        const id = nextUnitKeyId();
        const interval = 60_000;

        scheduleApiKeyLastUsedAt(storage, id, stamps, 1_000, interval);
        assert.equal(calls.length, 1, 'first use writes');

        scheduleApiKeyLastUsedAt(storage, id, stamps, 1_000 + interval - 1, interval);
        assert.equal(calls.length, 1, 'one ms before the window expires: throttled');

        scheduleApiKeyLastUsedAt(storage, id, stamps, 1_000 + interval, interval);
        assert.equal(calls.length, 2, 'at the window boundary: writes again');
    });

    it('treats intervalMs=0 as "no throttle window"', async () => {
        const { storage, calls } = countingStorage();
        const stamps = new Map<number, number>();
        const id = nextUnitKeyId();

        scheduleApiKeyLastUsedAt(storage, id, stamps, 1_000, 0);
        scheduleApiKeyLastUsedAt(storage, id, stamps, 1_001, 0);
        scheduleApiKeyLastUsedAt(storage, id, stamps, 1_002, 0);

        assert.equal(calls.length, 3);
    });

    it('stamps at schedule time, so concurrent uses in one window queue one write', async () => {
        const { storage, calls } = countingStorage();
        const stamps = new Map<number, number>();
        const id = nextUnitKeyId();
        const interval = 60_000;

        // N in-flight requests, all inside the window — one write total
        for (let i = 0; i < 50; i++) scheduleApiKeyLastUsedAt(storage, id, stamps, 2_000 + i, interval);
        assert.equal(calls.length, 1);
    });

    it('a failing write is logged, not thrown, and the next attempt follows the window', async () => {
        const originalError = console.error;
        const logged: unknown[] = [];
        console.error = (...args: unknown[]) => logged.push(args);
        try {
            let failures = 0;
            const storage = {
                updateApiKeyLastUsedAt: async () => {
                    failures++;
                    throw new Error('connection lost');
                },
            } as unknown as StorageAdapter;
            const stamps = new Map<number, number>();
            const id = nextUnitKeyId();
            const interval = 60_000;

            scheduleApiKeyLastUsedAt(storage, id, stamps, 3_000, interval);
            // let the fire-and-forget promise settle
            await new Promise((r) => setImmediate(r));
            assert.equal(failures, 1);
            assert.ok(logged.length > 0, 'failure was logged');

            // still inside the window — no extra attempt
            scheduleApiKeyLastUsedAt(storage, id, stamps, 3_000 + interval - 1, interval);
            await new Promise((r) => setImmediate(r));
            assert.equal(failures, 1);

            // window elapsed — the write is retried (and fails again, logged)
            scheduleApiKeyLastUsedAt(storage, id, stamps, 3_000 + interval, interval);
            await new Promise((r) => setImmediate(r));
            assert.equal(failures, 2);
            assert.ok(logged.length >= 2, 'retry failure was logged too');
        } finally {
            console.error = originalError;
        }
    });

    it('two authenticated requests (storage path + cache-hit path) produce ONE last_used_at write', async () => {
        const { storage, req, apiKey } = await setupTestApp();

        let writes = 0;
        const realUpdate = storage.updateApiKeyLastUsedAt.bind(storage);
        storage.updateApiKeyLastUsedAt = async (id: number, ts: string) => {
            writes++;
            return realUpdate(id, ts);
        };

        // first request: storage verification path
        const first = await req('/contexts', apiKey);
        assert.equal(first.status, 200);
        // second request: cache-hit path (the cache was populated by #1)
        const second = await req('/contexts', apiKey);
        assert.equal(second.status, 200);

        // the write is fire-and-forget — flush microtasks before asserting
        await new Promise((r) => setImmediate(r));
        assert.equal(writes, 1);
    });

    it('a hanging last_used_at write never blocks the response', async () => {
        const { storage, req, apiKey } = await setupTestApp();

        // never settles — if the request path ever awaited this, the test
        // request would hang until the race timeout below fails it
        storage.updateApiKeyLastUsedAt = () => new Promise<void>(() => {});

        const res = await Promise.race([
            req('/contexts', apiKey),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('request blocked on last_used_at')), 3_000)),
        ]);
        assert.equal(res.status, 200);
    });
});
