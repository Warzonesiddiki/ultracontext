// =============================================================================
// PAGINATION — GET /contexts/:id limit/offset (API-010)
// =============================================================================
// The headline guarantee: WITHOUT limit/offset the response is byte-identical
// to the pre-pagination shape (no `total`/`limit`/`offset` keys) — existing
// clients (SDKs, MCP "full conversation") are never silently truncated. WITH
// limit/offset the response gains `total` + applied `limit`/`offset`, and
// `limit` is clamped into [1, 1000].

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

type Req = (
    path: string,
    options?: { method?: string; auth?: string; body?: string | undefined }
) => Promise<Response>;

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    await storage.insertApiKey({
        project_id: project!.id,
        key_prefix: apiKey.slice(0, KEY_PREFIX_LEN),
        key_hash: await hashKey(apiKey),
    });

    const req: Req = (path, options) =>
        app.request(`http://localhost${path}`, {
            method: options?.method ?? 'GET',
            headers: {
                ...(options?.auth ? { Authorization: `Bearer ${options.auth}` } : {}),
                ...(options?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            },
            body: options?.body,
        }) as unknown as Promise<Response>;

    return { req, apiKey };
}

async function createContextWith(req: Req, apiKey: string, messages: object[]): Promise<string> {
    const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
    assert.equal(res.status, 201);
    const { id } = (await res.json()) as { id: string };
    for (let i = 0; i < messages.length; i += 1000) {
        const batch = messages.slice(i, i + 1000);
        const r = await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify(batch),
        });
        assert.equal(r.status, 201);
    }
    return id;
}

const twelve = () =>
    Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `msg ${i}` }));

describe('GET /contexts/:id pagination', () => {
    it('no params: response shape is unchanged (no total/limit/offset keys)', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, twelve());
        const res = await req(`/contexts/${id}`, { auth: apiKey });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).sort(), ['data', 'version']);
        assert.equal((body.data as unknown[]).length, 12);
    });

    it('?limit=5 pages the first 5 with total/limit/offset', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, twelve());
        const res = await req(`/contexts/${id}?limit=5`, { auth: apiKey });
        assert.equal(res.status, 200);
        const body = (await res.json()) as {
            data: Array<{ content: string }>;
            total: number;
            limit: number;
            offset: number;
            version: number;
        };
        assert.equal(body.data.length, 5);
        assert.equal(body.data[0].content, 'msg 0');
        assert.equal(body.data[4].content, 'msg 4');
        assert.equal(body.total, 12);
        assert.equal(body.limit, 5);
        assert.equal(body.offset, 0);
        assert.ok(body.version >= 1);
    });

    it('?limit=5&offset=5 continues where the first page ended', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, twelve());
        const res = await req(`/contexts/${id}?limit=5&offset=5`, { auth: apiKey });
        const body = (await res.json()) as {
            data: Array<{ content: string }>;
            total: number;
            limit: number;
            offset: number;
        };
        assert.equal(body.data.length, 5);
        assert.equal(body.data[0].content, 'msg 5');
        assert.equal(body.data[4].content, 'msg 9');
        assert.equal(body.total, 12);
        assert.equal(body.limit, 5);
        assert.equal(body.offset, 5);

        // final partial page
        const tail = await req(`/contexts/${id}?limit=5&offset=10`, { auth: apiKey });
        const tailBody = (await tail.json()) as { data: Array<{ content: string }>; total: number };
        assert.equal(tailBody.data.length, 2);
        assert.equal(tailBody.data[0].content, 'msg 10');
        assert.equal(tailBody.total, 12);
    });

    it('?offset without limit returns the remainder, without a limit key', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, twelve());
        const res = await req(`/contexts/${id}?offset=10`, { auth: apiKey });
        const body = (await res.json()) as Record<string, unknown> & {
            data: Array<{ content: string }>;
            total: number;
            offset: number;
        };
        assert.equal(body.data.length, 2);
        assert.equal(body.data[0].content, 'msg 10');
        assert.equal(body.total, 12);
        assert.equal(body.offset, 10);
        assert.ok(!('limit' in body));
    });

    it('limit is clamped: 0 → 1, huge → 1000', async () => {
        const { req, apiKey } = await setupTestApp();
        const big = Array.from({ length: 1050 }, (_, i) => ({ role: 'user', content: `m${i}` }));
        const id = await createContextWith(req, apiKey, big);

        const clampedLow = await req(`/contexts/${id}?limit=0`, { auth: apiKey });
        const lowBody = (await clampedLow.json()) as { data: unknown[]; limit: number; total: number };
        assert.equal(lowBody.data.length, 1);
        assert.equal(lowBody.limit, 1);
        assert.equal(lowBody.total, 1050);

        const clampedHigh = await req(`/contexts/${id}?limit=5000`, { auth: apiKey });
        const highBody = (await clampedHigh.json()) as { data: unknown[]; limit: number; total: number };
        assert.equal(highBody.data.length, 1000);
        assert.equal(highBody.limit, 1000);
        assert.equal(highBody.total, 1050);

        // the page after the clamped one covers the remainder
        const rest = await req(`/contexts/${id}?limit=5000&offset=1000`, { auth: apiKey });
        const restBody = (await rest.json()) as { data: unknown[]; total: number };
        assert.equal(restBody.data.length, 50);
        assert.equal(restBody.total, 1050);
    });

    it('offset beyond the end returns an empty page (still 200)', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, twelve());
        const res = await req(`/contexts/${id}?limit=5&offset=99999`, { auth: apiKey });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { data: unknown[]; total: number; offset: number };
        assert.equal(body.data.length, 0);
        assert.equal(body.total, 12);
        assert.equal(body.offset, 99999);
    });

    it('malformed limit/offset are 400 invalid_input', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, twelve());
        for (const q of ['limit=abc', 'limit=', 'offset=-1', 'offset=1.5', 'offset=1abc']) {
            const res = await req(`/contexts/${id}?${q}`, { auth: apiKey });
            assert.equal(res.status, 400, `expected 400 for ?${q}`);
            const body = (await res.json()) as { code?: string };
            assert.equal(body.code, 'invalid_input');
        }
    });

    it('pagination composes with ?history=true and ?version=N', async () => {
        const { req, apiKey } = await setupTestApp();
        const id = await createContextWith(req, apiKey, [
            { role: 'system', content: 's' },
            { role: 'user', content: 'u1' },
            { role: 'user', content: 'u2' },
            { role: 'user', content: 'u3' },
        ]);

        // history + pagination: versions array present, data paged, total = 4
        const hist = await req(`/contexts/${id}?history=true&limit=2&offset=2`, { auth: apiKey });
        const histBody = (await hist.json()) as {
            data: Array<{ content: string }>;
            versions: unknown[];
            total: number;
        };
        assert.equal(histBody.data.length, 2);
        assert.equal(histBody.data[0].content, 'u2');
        assert.equal(histBody.versions.length, 2); // create + one append batch
        assert.equal(histBody.total, 4);

        // an older version is paginated against ITS OWN message count
        const older = await req(`/contexts/${id}?version=0&limit=1`, { auth: apiKey });
        const olderBody = (await older.json()) as { data: Array<{ content: string }>; total: number };
        assert.equal(olderBody.data.length, 0);
        assert.equal(olderBody.total, 0); // version 0 (create) has no messages
    });
});
