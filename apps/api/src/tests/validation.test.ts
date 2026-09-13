// =============================================================================
// VALIDATION — strict query parsing + request body ceiling
// =============================================================================
// API-001: ?limit must parse strictly (NaN → 400, clamped [1,100], default 20)
// API-002: version/at selectors must reject malformed integers (1abc, 1.9, ' 1 ')
// API-006: append/patch bodies are capped (oversized → 413)

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

    const auth = { Authorization: `Bearer ${apiKey}` };
    const json = { ...auth, 'Content-Type': 'application/json' };
    // NOTE: `headers` in init REPLACES the default auth header, so every
    // call that passes custom headers must re-include them via `json`.
    const req = (path: string, init?: RequestInit) =>
        app.request(`http://localhost${path}`, { headers: auth, ...init }) as unknown as Response;

    // one context with two messages → versions 0..1, message indexes 0..1
    const created = await req('/contexts', { method: 'POST', headers: json, body: JSON.stringify({}) });
    assert.equal(created.status, 201);
    const ctxId = ((await created.json()) as { id: string }).id;

    const appended = await req(`/contexts/${ctxId}`, {
        method: 'POST',
        headers: json,
        body: JSON.stringify([{ role: 'user', content: 'first' }, { role: 'user', content: 'second' }]),
    });
    assert.equal(appended.status, 201);

    return { app, req, json, ctxId };
}

describe('API-001: ?limit strict parse', () => {
    it('defaults to 20 when absent', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/contexts')).status, 200);
    });

    it('rejects non-numeric limit with 400', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/contexts?limit=abc')).status, 400);
        assert.equal((await req('/contexts?limit=')).status, 400);
        assert.equal((await req('/contexts?limit=1.5')).status, 400);
        assert.equal((await req('/contexts?limit=-5')).status, 400);
    });

    it('clamps into [1, 100]', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/contexts?limit=0')).status, 200);
        const res = await req('/contexts?limit=1000000');
        assert.equal(res.status, 200);
        const body = (await res.json()) as { data: unknown[] };
        assert.ok(Array.isArray(body.data));
    });
});

describe('API-002: strict version / at selectors', () => {
    it('well-formed selectors still work', async () => {
        const { req, ctxId } = await setupTestApp();
        assert.equal((await req(`/contexts/${ctxId}?version=0`)).status, 200);
        assert.equal((await req(`/contexts/${ctxId}?version=1`)).status, 200);
        assert.equal((await req(`/contexts/${ctxId}?at=0`)).status, 200);
        assert.equal((await req(`/contexts/${ctxId}?at=1`)).status, 200);
    });

    it('out-of-range well-formed selectors stay 404', async () => {
        const { req, ctxId } = await setupTestApp();
        assert.equal((await req(`/contexts/${ctxId}?version=99`)).status, 404);
        assert.equal((await req(`/contexts/${ctxId}?at=99`)).status, 404);
    });

    it('malformed selectors are 400, not silently resolved', async () => {
        const { req, ctxId } = await setupTestApp();
        // before the fix these all resolved: parseInt("1abc")===1,
        // parseInt("1.9")===1, parseInt(" 1 ")===1
        assert.equal((await req(`/contexts/${ctxId}?version=1abc`)).status, 400);
        assert.equal((await req(`/contexts/${ctxId}?version=1.9`)).status, 400);
        assert.equal((await req(`/contexts/${ctxId}?version=%201%20`)).status, 400);
        assert.equal((await req(`/contexts/${ctxId}?at=1abc`)).status, 400);
        assert.equal((await req(`/contexts/${ctxId}?at=1.9`)).status, 400);
        assert.equal((await req(`/contexts/${ctxId}?at=-1`)).status, 400);
    });

    it('malformed fork selectors on POST /contexts are 400', async () => {
        const { req, json, ctxId } = await setupTestApp();
        const fork = (body: Record<string, unknown>) =>
            req('/contexts', { method: 'POST', headers: json, body: JSON.stringify(body) });
        assert.equal((await fork({ from: ctxId, version: '1abc' })).status, 400);
        assert.equal((await fork({ from: ctxId, at: '1.9' })).status, 400);
        // sanity: a valid fork still works
        assert.equal((await fork({ from: ctxId, version: 1 })).status, 201);
    });
});

describe('API-006: request body ceiling on append/patch', () => {
    it('rejects an oversized append with 413', async () => {
        const { req, json, ctxId } = await setupTestApp();
        const huge = JSON.stringify([{ role: 'user', content: 'x'.repeat(9 * 1024 * 1024) }]);
        const res = await req(`/contexts/${ctxId}`, { method: 'POST', headers: json, body: huge });
        assert.equal(res.status, 413);
    });

    it('rejects an oversized patch with 413', async () => {
        const { req, json, ctxId } = await setupTestApp();
        const huge = JSON.stringify([{ id: 0, index: 0, content: 'x'.repeat(9 * 1024 * 1024) }]);
        const res = await req(`/contexts/${ctxId}`, { method: 'PATCH', headers: json, body: huge });
        assert.equal(res.status, 413);
    });

    it('small bodies pass untouched', async () => {
        const { req, json, ctxId } = await setupTestApp();
        const res = await req(`/contexts/${ctxId}`, {
            method: 'POST',
            headers: json,
            body: JSON.stringify([{ role: 'user', content: 'fits easily' }]),
        });
        assert.equal(res.status, 201);
    });
});
