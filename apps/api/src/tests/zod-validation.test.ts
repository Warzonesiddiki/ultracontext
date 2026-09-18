// =============================================================================
// ZOD VALIDATION — route-level behavior of the API-009 validator layer
// =============================================================================
// Pins the contract of the zod gate in front of every route:
//   - shape-level 400s arrive with { error, code: 'invalid_input' }
//   - semantic 400s (core) are unchanged — same statuses as pre-API-009
//   - the tricky regressions: empty-body DELETE (permanent delete) and
//     empty-body POST /contexts (create with {}) still work; clamped limits
//     (?limit=150 → 200, not 400) still work; oversized bodies still 413.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import { InMemoryAuditSink } from '../audit/permanent-delete';
import type { ApiConfig } from '../types/api';

const ADMIN_KEY = 'test-admin-key';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: ADMIN_KEY,
};

async function setupTestApp() {
    const storage = new MemoryStorage();
    // in-memory audit sink keeps the suite hermetic (no real FS trail)
    const app = createApp({ config: TEST_CONFIG, storage, auditSink: new InMemoryAuditSink() });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    await storage.insertApiKey({
        project_id: project!.id,
        key_prefix: apiKey.slice(0, KEY_PREFIX_LEN),
        key_hash: await hashKey(apiKey),
    });

    const req = (
        path: string,
        options?: {
            method?: string;
            auth?: string;
            body?: string | undefined;
            /** override the default Content-Type (default: application/json when a
             *  body is present; pass '' to send none) */
            contentType?: string;
        }
    ): Promise<Response> => {
        const contentType =
            options?.contentType === undefined
                ? options?.body !== undefined
                    ? 'application/json'
                    : undefined
                : options.contentType === ''
                  ? undefined
                  : options.contentType;
        return app.request(`http://localhost${path}`, {
            method: options?.method ?? 'GET',
            headers: {
                ...(options?.auth ? { Authorization: `Bearer ${options.auth}` } : {}),
                ...(contentType ? { 'Content-Type': contentType } : {}),
            },
            body: options?.body,
        }) as unknown as Promise<Response>;
    };

    return { app, storage, req, apiKey, projectId: project!.id };
}

describe('zod gate — POST /contexts (create)', () => {
    it('rejects a non-string `from` with 400 invalid_input', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ from: 123 }),
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as { code?: string };
        assert.equal(body.code, 'invalid_input');
    });

    it('rejects an unknown key (typo-safe strict body)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ form: 'ctx_does_not_matter' }),
        });
        assert.equal(res.status, 400);
    });

    it('still creates on an empty body (no regression)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey });
        assert.equal(res.status, 201);
    });

    it('still accepts valid fork params', async () => {
        const { req, apiKey } = await setupTestApp();
        const first = await req('/contexts', {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ metadata: { name: 'first' } }),
        });
        assert.equal(first.status, 201);
        const { id } = (await first.json()) as { id: string };

        // fork from a non-existent source: 404 (not 400) — validation passed
        const res = await req('/contexts', {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ from: 'ctx_missing', version: 1 }),
        });
        assert.equal(res.status, 404);
        void id;
    });
});

describe('zod gate — query parameters', () => {
    it('rejects ?limit=abc but still clamps ?limit=150 to 100 (200)', async () => {
        const { req, apiKey } = await setupTestApp();
        const bad = await req('/contexts?limit=abc', { auth: apiKey });
        assert.equal(bad.status, 400);

        const clamped = await req('/contexts?limit=150', { auth: apiKey });
        assert.equal(clamped.status, 200);
        const body = (await clamped.json()) as { data: unknown[] };
        assert.ok(Array.isArray(body.data));
    });

    it('rejects strict-int violations on ?at=; ?version= is an id or an index (ARCH-001)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', {
            method: 'POST',
            auth: apiKey,
            body: '{}',
        });
        assert.equal(res.status, 201);
        const { id } = (await res.json()) as { id: string };

        // `at` is a message index with no id form — still strict at the gate
        assert.equal((await req(`/contexts/${id}?at=1abc`, { auth: apiKey })).status, 400);
        assert.equal((await req(`/contexts/${id}?at=1.9`, { auth: apiKey })).status, 400);

        // `version` now addresses an immutable id as well as a positional index,
        // so the gate only rejects the empty value; core resolves the rest. A
        // non-integer string is an id that does not exist → 404, never a silent
        // parseInt-style resolution to a real version.
        assert.equal((await req(`/contexts/${id}?version=`, { auth: apiKey })).status, 400);
        assert.equal((await req(`/contexts/${id}?version=1.9`, { auth: apiKey })).status, 404);
        assert.equal((await req(`/contexts/${id}?version=%201%20`, { auth: apiKey })).status, 404);
        // valid selectors still work — index form and id form
        assert.equal((await req(`/contexts/${id}?version=0`, { auth: apiKey })).status, 200);
        const history = (await (
            await req(`/contexts/${id}?history=true`, { auth: apiKey })
        ).json()) as { versions: Array<{ id: string }> };
        assert.equal(
            (await req(`/contexts/${id}?version=${history.versions[0].id}`, { auth: apiKey })).status,
            200
        );
    });

    it('search requires q; stats validates bucket and days', async () => {
        const { req, apiKey } = await setupTestApp();
        assert.equal((await req('/contexts/search', { auth: apiKey })).status, 400);
        assert.equal((await req('/contexts/search?q=', { auth: apiKey })).status, 400);
        assert.equal((await req('/contexts/search?q=hello', { auth: apiKey })).status, 200);

        assert.equal((await req('/contexts/stats?bucket=hour', { auth: apiKey })).status, 400);
        assert.equal((await req('/contexts/stats?days=-1', { auth: apiKey })).status, 400);
        assert.equal((await req('/contexts/stats?days=abc', { auth: apiKey })).status, 400);
        assert.equal((await req('/contexts/stats?bucket=day&days=30', { auth: apiKey })).status, 200);
    });
});

describe('zod gate — append / update bodies', () => {
    it('append: malformed JSON is 400 invalid_input (was 500)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: '{not json',
        });
        assert.equal(bad.status, 400);
        const body = (await bad.json()) as { code?: string };
        assert.equal(body.code, 'invalid_input');
    });

    it('append: a non-JSON Content-Type is 400', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ role: 'user', content: 'x' }),
            contentType: 'text/plain',
        });
        assert.equal(bad.status, 400);
        const body = (await bad.json()) as { code?: string };
        assert.equal(body.code, 'invalid_input');
    });

    it('append: valid single + array forms still 201', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const single = await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ role: 'user', content: 'hi' }),
        });
        assert.equal(single.status, 201);

        const many = await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify([
                { role: 'user', content: 'a' },
                { role: 'assistant', content: 'b' },
            ]),
        });
        assert.equal(many.status, 201);
    });

    it('append: a message with non-object metadata is 400', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ role: 'user', content: 'hi', metadata: 'oops' }),
        });
        assert.equal(bad.status, 400);
    });

    it('update: all three accepted shapes still work', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };
        await req(`/contexts/${id}`, {
            method: 'POST',
            auth: apiKey,
            body: JSON.stringify({ role: 'system', content: 's' }),
        });

        const single = await req(`/contexts/${id}`, {
            method: 'PATCH',
            auth: apiKey,
            body: JSON.stringify({ index: 0, content: 'updated' }),
        });
        assert.equal(single.status, 200);

        const arr = await req(`/contexts/${id}`, {
            method: 'PATCH',
            auth: apiKey,
            body: JSON.stringify([{ index: -1, content: 'updated2' }]),
        });
        assert.equal(arr.status, 200);

        const batch = await req(`/contexts/${id}`, {
            method: 'PATCH',
            auth: apiKey,
            body: JSON.stringify({
                updates: [{ index: 0, content: 'batch' }],
                metadata: { reason: 'test' },
            }),
        });
        assert.equal(batch.status, 200);
    });

    it('update: id+index both provided is still 400 (core semantic)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'PATCH',
            auth: apiKey,
            body: JSON.stringify({ id: 'msg_whatever', index: 0, content: 'x' }),
        });
        assert.equal(bad.status, 400);
    });
});

describe('zod gate — DELETE /contexts/:id body shapes', () => {
    it('no body is still a permanent delete (no regression)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const del = await req(`/contexts/${id}`, { method: 'DELETE', auth: apiKey });
        assert.equal(del.status, 200);
        const body = (await del.json()) as { deleted?: boolean };
        assert.equal(body.deleted, true);
    });

    it('unknown shape is still 400 (typo-safe)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'DELETE',
            auth: apiKey,
            body: JSON.stringify({ foo: 1 }),
        });
        assert.equal(bad.status, 400);
    });

    it('ambiguous permanent+ids is still 400', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'DELETE',
            auth: apiKey,
            body: JSON.stringify({ permanent: true, ids: ['msg_1'] }),
        });
        assert.equal(bad.status, 400);
    });

    it('non-integer index in ids is still 400 (core semantic)', async () => {
        const { req, apiKey } = await setupTestApp();
        const res = await req('/contexts', { method: 'POST', auth: apiKey, body: '{}' });
        const { id } = (await res.json()) as { id: string };

        const bad = await req(`/contexts/${id}`, {
            method: 'DELETE',
            auth: apiKey,
            body: JSON.stringify({ ids: 1.5 }),
        });
        assert.equal(bad.status, 400);
    });
});

describe('zod gate — /v1/keys (admin)', () => {
    it('create key requires a non-empty string name', async () => {
        const { req } = await setupTestApp();
        assert.equal((await req('/v1/keys', { method: 'POST', auth: ADMIN_KEY, body: '{}' })).status, 400);
        assert.equal(
            (await req('/v1/keys', { method: 'POST', auth: ADMIN_KEY, body: JSON.stringify({ name: 123 }) })).status,
            400
        );
        assert.equal(
            (await req('/v1/keys', { method: 'POST', auth: ADMIN_KEY, body: JSON.stringify({ name: 'ci', extra: 1 }) })).status,
            400
        );
        const ok = await req('/v1/keys', { method: 'POST', auth: ADMIN_KEY, body: JSON.stringify({ name: 'ci' }) });
        assert.equal(ok.status, 200);
    });

    it('numeric path params: abc/0/-3/1.5 are 400, positive int works', async () => {
        const { req, projectId } = await setupTestApp();
        assert.equal((await req('/v1/keys/abc', { auth: ADMIN_KEY })).status, 400);
        assert.equal((await req('/v1/keys/0', { auth: ADMIN_KEY })).status, 400);
        assert.equal((await req('/v1/keys/-3', { auth: ADMIN_KEY })).status, 400);
        assert.equal((await req('/v1/keys/1.5', { auth: ADMIN_KEY })).status, 400);
        assert.equal((await req(`/v1/keys/${projectId}`, { auth: ADMIN_KEY })).status, 200);

        assert.equal((await req('/v1/keys/not-an-id', { method: 'DELETE', auth: ADMIN_KEY })).status, 400);
        assert.equal((await req('/v1/keys/abc/rotate', { method: 'POST', auth: ADMIN_KEY })).status, 400);
    });
});

describe('zod gate — delete-many body', () => {
    it('keeps the core 400s for empty / oversized / non-string ids', async () => {
        const { req, apiKey } = await setupTestApp();
        assert.equal(
            (await req('/contexts/delete-many', { method: 'POST', auth: apiKey, body: '{}' })).status,
            400
        );
        assert.equal(
            (await req('/contexts/delete-many', {
                method: 'POST',
                auth: apiKey,
                body: JSON.stringify({ ids: [] }),
            })).status,
            400
        );
        const big = Array.from({ length: 101 }, (_, i) => `ctx_${i}`);
        assert.equal(
            (await req('/contexts/delete-many', {
                method: 'POST',
                auth: apiKey,
                body: JSON.stringify({ ids: big }),
            })).status,
            400
        );
        assert.equal(
            (await req('/contexts/delete-many', {
                method: 'POST',
                auth: apiKey,
                body: JSON.stringify({ ids: ['ctx_ok', 7] }),
            })).status,
            400
        );
    });
});
