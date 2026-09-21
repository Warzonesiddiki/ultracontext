// =============================================================================
// NAMED BRANCHES over HTTP (ARCH-001)
// =============================================================================
//   GET    /contexts/:id/branches          → { branches: BranchRef[] }
//   PUT    /contexts/:id/branches          → BranchRef   (create OR move)
//   DELETE /contexts/:id/branches/:name    → { deleted, name }
//
// The contract these pin down: PUT has git `branch -f` semantics (re-pinning
// preserves created_at and bumps updated_at), DELETE removes the pointer and
// never the version data, every route is project-scoped (a second tenant sees
// 404, not someone else's branches), and the immutable version id is accepted
// everywhere a positional index was — including `?history=true`, which now
// reports it.

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

type BranchRef = {
    name: string;
    version_id: string;
    version: number;
    created_at: string;
    updated_at: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });

    // a second project + key, so tenant isolation is exercised against a real
    // second tenant rather than a hypothetical one
    async function addProject(name: string) {
        const project = await storage.insertProject(name);
        const apiKey = generateKey('test');
        await storage.insertApiKey({
            project_id: project!.id,
            key_prefix: apiKey.slice(0, KEY_PREFIX_LEN),
            key_hash: await hashKey(apiKey),
        });
        return { projectId: project!.id, apiKey };
    }

    const { projectId, apiKey } = await addProject('test');
    const other = await addProject('other-tenant');

    // NOTE: `headers` in init REPLACES the defaults, so every call re-supplies auth
    const req = (path: string, init?: RequestInit, key: string = apiKey) =>
        app.request(`http://localhost${path}`, {
            headers: { Authorization: `Bearer ${key}` },
            ...init,
        }) as unknown as Promise<Response>;

    const put = (path: string, body: unknown, key: string = apiKey) =>
        req(path, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

    /** A context with three versions (0,1,2) and their immutable ids. */
    async function seedChain() {
        const created = await req('/contexts', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
        assert.equal(created.status, 201);
        const ctxId = ((await created.json()) as { id: string }).id;

        for (const content of ['v1', 'v2']) {
            const appended = await req(`/contexts/${ctxId}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify([{ role: 'user', content }]),
            });
            assert.equal(appended.status, 201);
        }

        const history = await req(`/contexts/${ctxId}?history=true`);
        const { versions } = (await history.json()) as {
            versions: Array<{ version: number; id: string }>;
        };
        return { ctxId, versions };
    }

    return { app, req, put, storage, projectId, apiKey, other, seedChain };
}

// =============================================================================

describe('ARCH-001: GET /contexts/:id/branches', () => {
    it('returns an empty list for a context with no branches', async () => {
        const { req, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();

        const res = await req(`/contexts/${ctxId}/branches`);

        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { branches: [] });
    });

    it('404s for an unknown context', async () => {
        const { req } = await setupTestApp();

        const res = await req('/contexts/ctx_doesnotexist/branches');

        assert.equal(res.status, 404);
        assert.equal(((await res.json()) as { code: string }).code, 'not_found');
    });

    it('is project-scoped: another tenant gets 404, not the branch list', async () => {
        const { req, put, other, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();
        await put(`/contexts/${ctxId}/branches`, { name: 'main' });

        const asOther = await req(`/contexts/${ctxId}/branches`, undefined, other.apiKey);

        assert.equal(asOther.status, 404);
        assert.equal(((await asOther.json()) as { code: string }).code, 'not_found');
    });
});

describe('ARCH-001: PUT /contexts/:id/branches', () => {
    it('pins a new branch to the current head and reports both addresses', async () => {
        const { req, put, seedChain } = await setupTestApp();
        const { ctxId, versions } = await seedChain();

        const res = await put(`/contexts/${ctxId}/branches`, { name: 'release-1.2' });

        assert.equal(res.status, 200);
        const branch = (await res.json()) as BranchRef;
        assert.equal(branch.name, 'release-1.2');
        assert.equal(branch.version_id, versions[versions.length - 1].id);
        assert.equal(branch.version, versions.length - 1);
        assert.equal(branch.created_at, branch.updated_at);

        const listed = (await (await req(`/contexts/${ctxId}/branches`)).json()) as { branches: BranchRef[] };
        assert.deepEqual(listed.branches, [branch]);
    });

    it('pins an explicit positional index and an immutable version id', async () => {
        const { put, req, seedChain } = await setupTestApp();
        const { ctxId, versions } = await seedChain();

        const byIndex = await put(`/contexts/${ctxId}/branches`, { name: 'by-index', version: 1 });
        assert.equal(byIndex.status, 200);
        assert.equal(((await byIndex.json()) as BranchRef).version_id, versions[1].id);

        const byId = await put(`/contexts/${ctxId}/branches`, { name: 'by-id', version: versions[0].id });
        assert.equal(byId.status, 200);
        const pinned = (await byId.json()) as BranchRef;
        assert.equal(pinned.version_id, versions[0].id);
        assert.equal(pinned.version, 0);

        // …and the pinned state reads back through the ordinary GET
        const read = await req(`/contexts/${ctxId}?version=${versions[0].id}`);
        assert.equal(read.status, 200);
        assert.equal(((await read.json()) as { version: number }).version, 0);
    });

    it('moves an existing branch: created_at survives, updated_at advances', async () => {
        const { put, req, seedChain } = await setupTestApp();
        const { ctxId, versions } = await seedChain();

        const first = (await (await put(`/contexts/${ctxId}/branches`, { name: 'main', version: 0 })).json()) as BranchRef;
        assert.equal(first.version_id, versions[0].id);

        await sleep(10);
        const movedRes = await put(`/contexts/${ctxId}/branches`, { name: 'main', version: 2 });
        assert.equal(movedRes.status, 200, 'a move is a 200, not a 201 or a 409');
        const moved = (await movedRes.json()) as BranchRef;

        assert.equal(moved.version_id, versions[2].id);
        assert.equal(moved.created_at, first.created_at);
        assert.ok(
            new Date(moved.updated_at).getTime() > new Date(first.updated_at).getTime(),
            'updated_at must advance when a branch moves'
        );

        // one branch, not two — PUT is an upsert
        const listed = (await (await req(`/contexts/${ctxId}/branches`)).json()) as { branches: BranchRef[] };
        assert.equal(listed.branches.length, 1);
    });

    it('400s on an invalid name, a fractional version, and unknown keys', async () => {
        const { put, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();

        for (const body of [
            { name: '' },
            { name: '-leading-dash' },
            { name: 'trailing.' },
            { name: 'a..b' },
            { name: 'has space' },
            { name: 'x'.repeat(65) },
            { name: 'main', version: 1.5 },
            { name: 'main', version: '' },
            { name: 'main', extra: true }, // strict: typos must not pass
            { branch: 'main' },
            {},
        ]) {
            const res = await put(`/contexts/${ctxId}/branches`, body);
            assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
            assert.equal(((await res.json()) as { code: string }).code, 'invalid_input');
        }
    });

    it('404s for an unknown version id, an out-of-range index, and an unknown context', async () => {
        const { put, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();

        const unknownId = await put(`/contexts/${ctxId}/branches`, { name: 'a', version: 'ctx_nope' });
        assert.equal(unknownId.status, 404);

        const outOfRange = await put(`/contexts/${ctxId}/branches`, { name: 'b', version: 99 });
        assert.equal(outOfRange.status, 404);

        const noContext = await put('/contexts/ctx_nope/branches', { name: 'c' });
        assert.equal(noContext.status, 404);
    });
});

describe('ARCH-001: DELETE /contexts/:id/branches/:name', () => {
    it('removes the pointer and leaves the version data readable', async () => {
        const { req, put, seedChain } = await setupTestApp();
        const { ctxId, versions } = await seedChain();
        await put(`/contexts/${ctxId}/branches`, { name: 'main', version: 0 });

        const res = await req(`/contexts/${ctxId}/branches/main`, { method: 'DELETE' });

        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { deleted: true, name: 'main' });

        const listed = (await (await req(`/contexts/${ctxId}/branches`)).json()) as { branches: BranchRef[] };
        assert.deepEqual(listed.branches, []);

        // the version the branch pointed at is untouched
        const stillThere = await req(`/contexts/${ctxId}?version=${versions[0].id}`);
        assert.equal(stillThere.status, 200);
        const history = await req(`/contexts/${ctxId}?history=true`);
        assert.equal((((await history.json()) as { versions: unknown[] }).versions).length, versions.length);
    });

    it('404s for a branch that does not exist and for an unknown context', async () => {
        const { req, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();

        const missing = await req(`/contexts/${ctxId}/branches/nope`, { method: 'DELETE' });
        assert.equal(missing.status, 404);
        assert.equal(((await missing.json()) as { error: string }).error, 'Branch not found');

        const noContext = await req('/contexts/ctx_nope/branches/main', { method: 'DELETE' });
        assert.equal(noContext.status, 404);
    });

    it('400s on an invalid name in the path', async () => {
        const { req, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();

        // encoded so the router still sees one path segment
        for (const name of ['a..b', 'trail.', '-lead', 'has%20space']) {
            const res = await req(`/contexts/${ctxId}/branches/${name}`, { method: 'DELETE' });
            assert.equal(res.status, 400, `expected 400 for ${name}`);
            assert.equal(((await res.json()) as { code: string }).code, 'invalid_input');
        }
    });

    it('is project-scoped: another tenant cannot delete a branch', async () => {
        const { req, put, other, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();
        await put(`/contexts/${ctxId}/branches`, { name: 'main' });

        const asOther = await req(`/contexts/${ctxId}/branches/main`, { method: 'DELETE' }, other.apiKey);
        assert.equal(asOther.status, 404);

        const listed = (await (await req(`/contexts/${ctxId}/branches`)).json()) as { branches: BranchRef[] };
        assert.equal(listed.branches.length, 1, 'the branch must survive the other tenant attempt');
    });
});

describe('ARCH-001: immutable ids on the existing version surface', () => {
    it('?history=true reports an id per version, next to the deprecated index', async () => {
        const { req, seedChain } = await setupTestApp();
        const { ctxId, versions } = await seedChain();

        assert.equal(versions.length, 3);
        assert.deepEqual(
            versions.map((v) => v.version),
            [0, 1, 2]
        );
        for (const v of versions) assert.match(v.id, /^ctx_/);

        // every id reads back its own version
        for (const v of versions) {
            const res = await req(`/contexts/${ctxId}?version=${v.id}`);
            assert.equal(res.status, 200);
            assert.equal(((await res.json()) as { version: number }).version, v.version);
        }
    });

    it('keeps positional addressing working as the deprecated alias', async () => {
        const { req, seedChain } = await setupTestApp();
        const { ctxId } = await seedChain();

        assert.equal((await req(`/contexts/${ctxId}?version=0`)).status, 200);
        assert.equal((await req(`/contexts/${ctxId}?version=2`)).status, 200);
        // new: negative indexes count back from the head
        const latest = await req(`/contexts/${ctxId}?version=-1`);
        assert.equal(latest.status, 200);
        assert.equal(((await latest.json()) as { version: number }).version, 2);
    });
});
