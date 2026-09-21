import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chainHealth, generateKey, hashKey, KEY_PREFIX_LEN, resetChainHealth } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

// =============================================================================
// HEALTH — liveness + readiness probes (API-007), plus the chain-health
// counters ARCH-002 hangs off liveness.
// Unauthenticated: load balancers / orchestrators cannot hold API keys.
// =============================================================================

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

type HealthBody = {
    status: string;
    chain_health?: {
        fallbacks: number;
        nodes_lost: number;
        contexts_affected: number;
        last_fallback_at: string | null;
        last_context_id?: string | null;
    };
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

    return { app, storage, projectId: project!.id, apiKey };
}

describe('GET /health (liveness)', () => {
    it('returns 200 {status: ok} without authentication', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/health');
        assert.equal(res.status, 200);
        const body = (await res.json()) as HealthBody;
        assert.equal(body.status, 'ok');
    });

    it('reports the chain-health counters (ARCH-002)', async () => {
        resetChainHealth();
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/health');
        const body = (await res.json()) as HealthBody;

        assert.ok(body.chain_health, 'chain_health must be present on liveness');
        assert.deepEqual(body.chain_health, {
            fallbacks: 0,
            nodes_lost: 0,
            contexts_affected: 0,
            last_fallback_at: null,
        });
    });

    it('never names a tenant context — the probe is unauthenticated', async () => {
        resetChainHealth();
        const { app, storage, projectId, apiKey } = await setupTestApp();
        await breakAChain(storage, projectId);

        const read = await app.request(`http://localhost/contexts/${ROOT}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        assert.equal(read.status, 200, 'the read still succeeds — ordering falls back');

        const body = (await (await app.request('http://localhost/health')).json()) as HealthBody;
        assert.ok(body.chain_health!.fallbacks >= 1, 'the fallback must be counted');
        assert.ok(!('last_context_id' in body.chain_health!), 'no tenant identifier on a public probe');
        // …while the in-process snapshot an operator reads directly still has it
        assert.equal(chainHealth().last_context_id, ROOT);
    });

    it('counts a broken chain read through the API', async () => {
        resetChainHealth();
        const { app, storage, projectId, apiKey } = await setupTestApp();
        await breakAChain(storage, projectId);
        const key = apiKey;

        const before = (await (await app.request('http://localhost/health')).json()) as HealthBody;
        assert.equal(before.chain_health!.fallbacks, 0);

        // GET the damaged context: the prev_id walk reaches nothing, ordering
        // falls back, and the fallback is recorded.
        const res = await app.request(`http://localhost/contexts/${ROOT}`, {
            headers: { Authorization: `Bearer ${key}` },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { data: { id: string }[] };
        assert.deepEqual(
            body.data.map((m) => m.id),
            ['msg_a', 'msg_b'],
            'fallback order is the persisted ordinal order',
        );

        const after = (await (await app.request('http://localhost/health')).json()) as HealthBody;
        assert.equal(after.chain_health!.fallbacks, 1);
        assert.equal(after.chain_health!.nodes_lost, 2);
        assert.equal(after.chain_health!.contexts_affected, 1);
        assert.ok(after.chain_health!.last_fallback_at, 'the event is timestamped');
        assert.equal(after.status, 'ok', 'a broken chain is data damage, not a dead process');
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

// -- helpers ------------------------------------------------------------------

const ROOT = 'ctx_brokenroot';
const HEAD = 'ctx_brokenhead';

/**
 * Fabricate the damage ARCH-002 exists for: a version head whose two messages
 * both point at a predecessor that does not exist, so the prev_id walk reaches
 * zero of two nodes. Written straight through the adapter because no op can
 * produce this state any more (DATA-001) — it is legacy/hand-edited damage.
 *
 * Both messages share one created_at millisecond on purpose: the pre-ARCH-002
 * fallback sorted by created_at alone, so this is exactly the case where order
 * used to be up to the storage engine. Their ordinals (0, 1) are what make the
 * fallback deterministic now.
 */
async function breakAChain(storage: MemoryStorage, projectId: number) {
    const at = '2026-09-18T00:00:00.000Z';
    await storage.insertNodes([
        { public_id: ROOT, project_id: projectId, type: 'context', context_id: null, content: {}, metadata: {}, created_at: at },
        {
            public_id: HEAD,
            project_id: projectId,
            type: 'context',
            context_id: ROOT,
            prev_id: null,
            ordinal: 0,
            content: {},
            metadata: { operation: 'create', child_count: 2 },
            created_at: at,
        },
        {
            public_id: 'msg_a',
            project_id: projectId,
            type: 'message',
            context_id: HEAD,
            prev_id: 'msg_does_not_exist',
            ordinal: 0,
            content: { role: 'user', content: 'first' },
            metadata: {},
            created_at: at,
        },
        {
            public_id: 'msg_b',
            project_id: projectId,
            type: 'message',
            context_id: HEAD,
            prev_id: 'msg_also_missing',
            ordinal: 1,
            content: { role: 'assistant', content: 'second' },
            metadata: {},
            created_at: at,
        },
    ]);
}
