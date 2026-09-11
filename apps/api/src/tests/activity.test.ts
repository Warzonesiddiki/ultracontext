// =============================================================================
// GET /contexts/stats — free, unmetered analytics
// =============================================================================
// Analytics is a paid upsell in the commercial tier ("unlimited analytics" on
// Pro). These tests pin down that here it is (a) present, (b) scoped to the
// caller's own project, and (c) never framed as a plan/upgrade concept.

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
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });

    const headers = { Authorization: `Bearer ${apiKey}` };

    const req = (path: string) => app.request(`http://localhost${path}`, { headers }) as unknown as Response;

    return { app, storage, req, headers, projectId: project!.id };
}

// raw node insert so timestamps are deterministic
async function seedNodes(storage: MemoryStorage, projectId: number, at: string, count: number, source: string) {
    for (let i = 0; i < count; i++) {
        await storage.insertNodes({
            public_id: `n-${projectId}-${source}-${at}-${i}`,
            project_id: projectId,
            type: 'message',
            content: { role: 'user', content: 'hello' },
            metadata: { source },
            context_id: 'head',
            created_at: at,
        });
    }
}

describe('GET /contexts/stats', () => {
    it('returns totals, a gap-filled series and a per-source breakdown', async () => {
        const { req, storage, projectId } = await setupTestApp();
        await seedNodes(storage, projectId, '2026-03-02T09:00:00.000Z', 3, 'claude');
        await seedNodes(storage, projectId, '2026-03-02T10:00:00.000Z', 1, 'codex');

        const res = await req('/contexts/stats?bucket=day&from=2026-03-01T00:00:00.000Z&to=2026-03-04T00:00:00.000Z');
        assert.equal(res.status, 200);

        const body = (await res.json()) as any;
        assert.equal(body.bucket, 'day');
        assert.equal(body.totals.nodes, 4);
        assert.equal(body.totals.messages, 4);
        assert.equal(body.totals.sources, 2);
        assert.equal(body.totals.active_buckets, 1);

        // gap-filled: 3 buckets, only the middle one has traffic
        assert.deepEqual(body.series.map((p: any) => p.bucket_start), ['2026-03-01', '2026-03-02', '2026-03-03']);
        assert.equal(body.series[0].messages, 0);
        assert.equal(body.series[1].messages, 4);

        assert.deepEqual(body.by_source.map((s: any) => s.source), ['claude', 'codex']);
        assert.equal(body.by_source[0].messages, 3);
    });

    it('never reports another project’s traffic', async () => {
        const { req, storage, projectId } = await setupTestApp();
        await seedNodes(storage, projectId, '2026-03-02T09:00:00.000Z', 2, 'claude');

        const other = await storage.insertProject('other');
        await seedNodes(storage, other!.id, '2026-03-02T09:00:00.000Z', 50, 'codex');

        const res = await req('/contexts/stats?bucket=day&from=2026-03-01T00:00:00.000Z&to=2026-03-04T00:00:00.000Z');
        assert.equal(res.status, 200);

        const body = (await res.json()) as any;
        assert.equal(body.totals.nodes, 2);
        assert.deepEqual(body.by_source.map((s: any) => s.source), ['claude']);
    });

    it('defaults to a 30-day window when no range is given', async () => {
        const { req } = await setupTestApp();
        const res = await req('/contexts/stats');
        assert.equal(res.status, 200);

        const body = (await res.json()) as any;
        assert.equal(body.bucket, 'day');
        assert.equal(body.series.length, 30);
        assert.equal(body.totals.nodes, 0);
    });

    it('rejects a bad bucket, range or days value with 400', async () => {
        const { req } = await setupTestApp();

        assert.equal((await req('/contexts/stats?bucket=fortnight')).status, 400);
        assert.equal((await req('/contexts/stats?from=not-a-date')).status, 400);
        assert.equal((await req('/contexts/stats?to=not-a-date')).status, 400);
        assert.equal((await req('/contexts/stats?days=0')).status, 400);
        assert.equal((await req('/contexts/stats?days=abc')).status, 400);
    });

    it('requires authentication', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/contexts/stats');
        assert.equal(res.status, 401);
    });

    it('is free — the response never mentions plans, upgrades or quotas', async () => {
        const { req } = await setupTestApp();
        const res = await req('/contexts/stats?days=7');
        const text = JSON.stringify(await res.json()).toLowerCase();

        for (const forbidden of ['upgrade', 'plan', 'pricing', 'tier', 'quota', 'trial', 'billing']) {
            assert.equal(text.includes(forbidden), false, `analytics response mentions '${forbidden}'`);
        }
    });
});
