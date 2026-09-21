// Unit tests for the SDK's named-branch surface (ARCH-001):
//   branches()    → GET    /contexts/{id}/branches
//   setBranch()   → PUT    /contexts/{id}/branches
//   deleteBranch()→ DELETE /contexts/{id}/branches/{name}
// plus the widened `version` selector (an immutable id as well as a positional
// index) on get() and create(), and the Version.id field on history entries.
//
// Offline: a fake fetch records method/url/body and replays scripted responses.
// Runs against src directly (node type stripping), no rebuild needed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UltraContext, UltraContextHttpError, type BranchRef } from '../src/index.ts';

// ── fake fetch harness ───────────────────────────────────────────

type Call = { method: string; url: string; body?: unknown; contentType?: string | null };
type ScriptItem = Response | Error;

function makeFetch(script: ScriptItem[]) {
    const calls: Call[] = [];
    let i = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string> | undefined;
        calls.push({
            method: init?.method ?? 'GET',
            url: String(url),
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
            contentType: headers?.['Content-Type'] ?? null,
        });
        const item: ScriptItem = i < script.length ? script[i++] : new Response('{}', { status: 200 });
        if (item instanceof Error) throw item;
        return item;
    }) as typeof fetch;
    return { fetch: fetchFn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const BASE = { apiKey: 'uc_live_test', baseUrl: 'http://127.0.0.1:8787' };
const CTX = 'ctx_abc123';

const BRANCH: BranchRef = {
    name: 'release-1.2',
    version_id: 'ctx_def456',
    version: 3,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
};

function client(script: ScriptItem[]) {
    const { fetch, calls } = makeFetch(script);
    return { uc: new UltraContext({ ...BASE, fetch, maxRetries: 0 }), calls };
}

// ── branches() ───────────────────────────────────────────────────

describe('branches()', () => {
    it('GETs /contexts/{id}/branches and returns the parsed body', async () => {
        const { uc, calls } = client([json(200, { branches: [BRANCH] })]);

        const res = await uc.branches(CTX);

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[0].url, `http://127.0.0.1:8787/contexts/${CTX}/branches`);
        assert.equal(calls[0].body, undefined, 'a list request carries no body');
        assert.deepEqual(res, { branches: [BRANCH] });
    });

    it('returns an empty list untouched (branches are opt-in)', async () => {
        const { uc } = client([json(200, { branches: [] })]);
        assert.deepEqual(await uc.branches(CTX), { branches: [] });
    });

    it('URL-encodes the context id', async () => {
        const { uc, calls } = client([json(200, { branches: [] })]);

        await uc.branches('ctx/weird id');

        assert.equal(calls[0].url, 'http://127.0.0.1:8787/contexts/ctx%2Fweird%20id/branches');
    });

    it('surfaces a 404 as UltraContextHttpError', async () => {
        const { uc } = client([json(404, { error: 'Context not found', code: 'not_found' })]);

        await assert.rejects(() => uc.branches('ctx_nope'), (err: unknown) => {
            assert.ok(err instanceof UltraContextHttpError);
            assert.equal(err.status, 404);
            return true;
        });
    });
});

// ── setBranch() ──────────────────────────────────────────────────

describe('setBranch()', () => {
    it('PUTs {name} and omits version when pinning the current head', async () => {
        const { uc, calls } = client([json(200, BRANCH)]);

        const res = await uc.setBranch(CTX, { name: 'release-1.2' });

        assert.equal(calls[0].method, 'PUT');
        assert.equal(calls[0].url, `http://127.0.0.1:8787/contexts/${CTX}/branches`);
        assert.deepEqual(calls[0].body, { name: 'release-1.2' });
        assert.equal(calls[0].contentType, 'application/json');
        assert.deepEqual(res, BRANCH);
    });

    it('passes a positional index through as a number', async () => {
        const { uc, calls } = client([json(200, BRANCH)]);

        await uc.setBranch(CTX, { name: 'main', version: 1 });

        assert.deepEqual(calls[0].body, { name: 'main', version: 1 });
    });

    it('passes an immutable version id through as a string', async () => {
        const { uc, calls } = client([json(200, { ...BRANCH, version_id: 'ctx_def456' })]);

        await uc.setBranch(CTX, { name: 'pinned', version: 'ctx_def456' });

        assert.deepEqual(calls[0].body, { name: 'pinned', version: 'ctx_def456' });
    });

    it('passes a negative index through (-1 = latest)', async () => {
        const { uc, calls } = client([json(200, BRANCH)]);

        await uc.setBranch(CTX, { name: 'tip', version: -1 });

        assert.deepEqual(calls[0].body, { name: 'tip', version: -1 });
    });

    it('is retried on 429 because PUT is idempotent', async () => {
        const { fetch, calls } = makeFetch([
            json(429, { error: 'slow down', code: 'conflict' }, { 'retry-after': '0' }),
            json(200, BRANCH),
        ]);
        const uc = new UltraContext({ ...BASE, fetch, maxRetries: 2 });

        const res = await uc.setBranch(CTX, { name: 'main' });

        assert.deepEqual(res, BRANCH);
        assert.equal(calls.length, 2, 'the 429 must be retried verbatim');
        assert.deepEqual(calls[1].body, { name: 'main' });
    });

    it('surfaces a 400 for a rejected name without retrying', async () => {
        const { uc, calls } = client([json(400, { error: 'Invalid branch name', code: 'invalid_input' })]);

        await assert.rejects(() => uc.setBranch(CTX, { name: 'a..b' }), UltraContextHttpError);
        assert.equal(calls.length, 1, 'a 400 is never retried');
    });
});

// ── deleteBranch() ───────────────────────────────────────────────

describe('deleteBranch()', () => {
    it('DELETEs /contexts/{id}/branches/{name} and returns the receipt', async () => {
        const { uc, calls } = client([json(200, { deleted: true, name: 'release-1.2' })]);

        const res = await uc.deleteBranch(CTX, 'release-1.2');

        assert.equal(calls[0].method, 'DELETE');
        assert.equal(calls[0].url, `http://127.0.0.1:8787/contexts/${CTX}/branches/release-1.2`);
        assert.equal(calls[0].body, undefined, 'deleting a branch sends no body');
        assert.deepEqual(res, { deleted: true, name: 'release-1.2' });
    });

    it('URL-encodes the branch name', async () => {
        const { uc, calls } = client([json(200, { deleted: true, name: 'a.b_c-d' })]);

        await uc.deleteBranch(CTX, 'a.b_c-d');
        assert.equal(calls[0].url, `http://127.0.0.1:8787/contexts/${CTX}/branches/a.b_c-d`);

        await uc.deleteBranch(CTX, 'weird/name');
        assert.equal(calls[1].url, `http://127.0.0.1:8787/contexts/${CTX}/branches/weird%2Fname`);
    });

    it('surfaces a 404 for a branch that does not exist', async () => {
        const { uc } = client([json(404, { error: 'Branch not found', code: 'not_found' })]);

        await assert.rejects(() => uc.deleteBranch(CTX, 'nope'), (err: unknown) => {
            assert.ok(err instanceof UltraContextHttpError);
            assert.equal(err.status, 404);
            return true;
        });
    });
});

// ── version selector widened on the existing methods ─────────────

describe('version selector (immutable id or deprecated index)', () => {
    it('get() sends an id string as ?version=', async () => {
        const { uc, calls } = client([json(200, { data: [], version: 0 })]);

        await uc.get(CTX, { version: 'ctx_def456' });

        assert.equal(calls[0].url, `http://127.0.0.1:8787/contexts/${CTX}?version=ctx_def456`);
    });

    it('get() still sends a numeric index, and combines with history', async () => {
        const { uc, calls } = client([json(200, { data: [], version: 1 })]);

        await uc.get(CTX, { version: 1, history: true });

        assert.equal(calls[0].url, `http://127.0.0.1:8787/contexts/${CTX}?version=1&history=true`);
    });

    it('get() surfaces the immutable id on history entries', async () => {
        const { uc } = client([
            json(200, {
                data: [],
                version: 1,
                versions: [
                    { version: 0, id: 'ctx_a', created_at: 'x', operation: 'create', affected: null },
                    { version: 1, id: 'ctx_b', created_at: 'y', operation: 'append', affected: null },
                ],
            }),
        ]);

        const res = await uc.get(CTX, { history: true });

        assert.deepEqual(
            res.versions?.map((v) => v.id),
            ['ctx_a', 'ctx_b'],
        );
    });

    it('create() sends an id string in the fork body', async () => {
        const { uc, calls } = client([json(201, { id: 'ctx_new', metadata: {}, created_at: 'x' })]);

        await uc.create({ from: CTX, version: 'ctx_def456' });

        assert.deepEqual(calls[0].body, { from: CTX, version: 'ctx_def456' });
    });

    it('a branch id round-trips: branches() then get({version: version_id})', async () => {
        const { uc, calls } = client([
            json(200, { branches: [{ ...BRANCH, version: -1 }] }),
            json(200, { data: [], version: 3 }),
        ]);

        const { branches } = await uc.branches(CTX);
        await uc.get(CTX, { version: branches[0].version_id });

        assert.equal(calls[1].url, `http://127.0.0.1:8787/contexts/${CTX}?version=${BRANCH.version_id}`);
    });
});
