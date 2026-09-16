import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import { InMemoryAuditSink } from '../audit/permanent-delete';
import type { ApiConfig } from '../types/api';
import { RETRY_AFTER_SECONDS } from '../http-error';

// =============================================================================
// API-003 — retryable failures surface as 409 + Retry-After, not flat 500
// =============================================================================

// shape of the JSON bodies these endpoints return (kept loose for assertions)
type JsonBody = {
    error?: string;
    code?: string;
    results?: Array<{ id: string; deleted: boolean; error?: string; retryable?: boolean }>;
    deleted_count?: number;
    data?: Array<Record<string, unknown>>;
} & Record<string, unknown>;

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

// a simulated Postgres SSI abort — the backend kills one side of a racing
// serializable pair with SQLSTATE 40001
function pgConflict(): Error {
    return Object.assign(new Error('could not serialize access due to read/write dependencies among transactions'), {
        code: '40001',
    });
}

async function setupTestApp() {
    const storage = new MemoryStorage();
    // in-memory audit sink keeps the suite hermetic (no real FS trail)
    const app = createApp({ config: TEST_CONFIG, storage, auditSink: new InMemoryAuditSink() });

    // create project + API key
    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });

    const headers = {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
    };

    async function req(method: string, path: string, body?: unknown): Promise<Response> {
        const init: RequestInit = { method, headers: { ...headers } };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        } else if (method === 'DELETE') {
            // No body — remove Content-Type
            init.headers = { Authorization: headers.Authorization };
        }
        return app.request(`http://localhost${path}`, init);
    }

    async function createTestContext(): Promise<string> {
        const res = await req('POST', '/contexts', {});
        assert.equal(res.status, 201);
        const data = (await res.json()) as JsonBody;
        return data.id as string;
    }

    async function json(res: Response): Promise<JsonBody> {
        return res.json() as Promise<JsonBody>;
    }

    return { app, storage, req, json, createTestContext };
}

describe('retryable failures — 409 + Retry-After (API-003)', () => {
    it('append returns 409 + Retry-After + conflict code on an SSI conflict', async () => {
        const { storage, req, json, createTestContext } = await setupTestApp();
        const contextId = await createTestContext();

        // the append races a concurrent permanent delete and gets SSI-aborted
        storage.transaction = async () => {
            throw pgConflict();
        };

        const res = await req('POST', `/contexts/${contextId}`, [{ role: 'user', text: 'x' }]);

        assert.equal(res.status, 409);
        assert.equal(res.headers.get('retry-after'), String(RETRY_AFTER_SECONDS));
        const body = await json(res);
        assert.equal(body.code, 'conflict');
        assert.match(body.error as string, /conflict/i);

        // the failed append wrote nothing — the context is intact
        const get = await req('GET', `/contexts/${contextId}`);
        assert.equal(get.status, 200);
    });

    it('permanent delete returns 409 + Retry-After on an SSI conflict', async () => {
        const { storage, req, json, createTestContext } = await setupTestApp();
        const contextId = await createTestContext();

        storage.transaction = async () => {
            throw pgConflict();
        };

        const res = await req('DELETE', `/contexts/${contextId}`);

        assert.equal(res.status, 409);
        assert.equal(res.headers.get('retry-after'), String(RETRY_AFTER_SECONDS));
        const body = await json(res);
        assert.equal(body.code, 'conflict');

        // the failed delete wrote nothing — the context survives for the retry
        const get = await req('GET', `/contexts/${contextId}`);
        assert.equal(get.status, 200);
    });

    it('delete-many returns 409 + Retry-When when EVERY item hit an SSI conflict', async () => {
        const { storage, req, json, createTestContext } = await setupTestApp();
        const id1 = await createTestContext();
        const id2 = await createTestContext();

        storage.transaction = async () => {
            throw pgConflict();
        };

        const res = await req('POST', '/contexts/delete-many', { ids: [id1, id2] });

        assert.equal(res.status, 409);
        assert.equal(res.headers.get('retry-after'), String(RETRY_AFTER_SECONDS));
        const body = await json(res);
        assert.equal(body.deleted_count, 0);
        assert.ok((body.results as Array<{ retryable?: boolean }>).every((r) => r.retryable === true));
    });

    it('delete-many stays 500 (no Retry-After) on a mixed not-found + conflict failure, with per-item flags', async () => {
        const { storage, req, json, createTestContext } = await setupTestApp();
        const id1 = await createTestContext();

        storage.transaction = async () => {
            throw pgConflict();
        };

        const res = await req('POST', '/contexts/delete-many', { ids: [id1, 'ctx_missing'] });

        // every item failed → 500 (207 requires a success); the batch is not
        // uniformly retryable, so no Retry-After — the per-item flags carry
        // the distinction instead
        assert.equal(res.status, 500);
        assert.equal(res.headers.get('retry-after'), null);
        const body = await json(res);
        assert.equal(body.deleted_count, 0);
        assert.equal((body.results as Array<{ retryable?: boolean }>)[0].retryable, true);
        assert.equal((body.results as Array<{ error?: string }>)[1].error, 'Not found');
    });

    it('delete-many stays 500 (no Retry-After) when every item fails non-retryably', async () => {
        const { req } = await setupTestApp();

        // every item missing → per-item 'Not found', none retryable → flat 500
        const res = await req('POST', '/contexts/delete-many', { ids: ['ctx_missing', 'ctx_missing2'] });

        assert.equal(res.status, 500);
        assert.equal(res.headers.get('retry-after'), null);
    });

    it('a non-retryable transaction failure stays a flat 500 without Retry-After', async () => {
        const { storage, req, json, createTestContext } = await setupTestApp();
        const contextId = await createTestContext();

        storage.transaction = async () => {
            throw new Error('connection lost');
        };

        const res = await req('POST', `/contexts/${contextId}`, [{ role: 'user', text: 'x' }]);

        assert.equal(res.status, 500);
        assert.equal(res.headers.get('retry-after'), null);
        const body = await json(res);
        assert.equal(body.code, 'internal');
    });

    it('non-conflict errors carry the machine-readable code and no Retry-After', async () => {
        const { req, json } = await setupTestApp();

        const res = await req('GET', '/contexts/ctx_nonexistent');

        assert.equal(res.status, 404);
        assert.equal(res.headers.get('retry-after'), null);
        const body = await json(res);
        assert.equal(body.code, 'not_found');
    });
});
