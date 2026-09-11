import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { appendMessages, createContext } from '../index';
import { searchMessages, searchableText, snippet, MAX_SEARCH_QUERY_LEN } from './search';
import { MemoryStorage } from '../testing/memory-adapter';
import type { StorageAdapter } from '../storage';

// daemon-shaped message: { role, content: { message, ... }, metadata }
function daemonMessage(role: string, text: string, extra: Record<string, unknown> = {}) {
    return { role, content: { message: text, event_type: 'message' }, metadata: extra };
}

async function seed(storage: StorageAdapter, projectId: number, texts: string[]) {
    const ctx = await createContext(storage, projectId, { metadata: { source: 'claude' } });
    if (!ctx.ok) throw new Error('seed failed: ' + ctx.message);
    await appendMessages(storage, projectId, ctx.data.id, texts.map((t) => daemonMessage('assistant', t, { source: 'claude' })));
    return ctx.data.id;
}

describe('searchableText', () => {
    it('reads the SDK shape ({ role, content: string })', () => {
        assert.equal(searchableText({ role: 'user', content: 'Hello!' }), 'Hello!');
    });

    it('reads the daemon shape ({ role, content: { message } })', () => {
        assert.equal(searchableText({ role: 'assistant', content: { message: 'the plan' } }), 'the plan');
    });

    it('never indexes raw transcript payloads', () => {
        const text = searchableText({ role: 'assistant', content: { message: 'visible', raw: { huge: 'secret-noise' } } });
        assert.equal(text, 'visible');
    });

    it('returns empty for non-indexable content', () => {
        assert.equal(searchableText(null), '');
        assert.equal(searchableText(42), '');
        assert.equal(searchableText({ role: 'assistant' }), '');
    });
});

describe('snippet', () => {
    it('centres on the match and marks truncation with ellipses', () => {
        const text = 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(200);
        const out = snippet(text, 'needle', 10);
        assert.ok(out.startsWith('…'));
        assert.ok(out.endsWith('…'));
        assert.ok(out.includes('NEEDLE'));
    });

    it('adds no ellipses when the whole text fits', () => {
        assert.equal(snippet('hello world', 'hello', 90), 'hello world');
    });

    it('is case-insensitive on the needle', () => {
        assert.ok(snippet('Deploy the service', 'DEPLOY', 20).startsWith('Deploy'));
    });
});

describe('searchMessages — validation', () => {
    it('requires a query', async () => {
        const storage = new MemoryStorage();
        const res = await searchMessages(storage, 1, { query: '' });
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.code, 'invalid_input');
    });

    it('rejects an over-long query', async () => {
        const storage = new MemoryStorage();
        const res = await searchMessages(storage, 1, { query: 'x'.repeat(MAX_SEARCH_QUERY_LEN + 1) });
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.code, 'invalid_input');
    });

    it('clamps limit instead of rejecting it', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, ['one two three']);

        const zero = await searchMessages(storage, 1, { query: 'one', limit: 0 });
        assert.equal(zero.ok, true);
        if (zero.ok) assert.equal(zero.data.limit, 1);

        const huge = await searchMessages(storage, 1, { query: 'one', limit: 9999 });
        assert.ok(huge.ok);
        if (huge.ok) assert.equal(huge.data.limit, 100);

        const nan = await searchMessages(storage, 1, { query: 'one', limit: NaN });
        assert.ok(nan.ok);
        if (nan.ok) assert.equal(nan.data.limit, 20);
    });
});

describe('searchMessages — behaviour', () => {
    it('finds messages by their text', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, ['we decided to refactor the auth middleware', 'unrelated chatter']);

        const res = await searchMessages(storage, 1, { query: 'refactor' });
        assert.ok(res.ok);
        if (!res.ok) return;

        assert.equal(res.data.data.length, 1);
        assert.ok(res.data.data[0].content.includes('refactor'));
    });

    it('returns the ROOT context id, not the version branch id', async () => {
        const storage = new MemoryStorage();
        const ctxId = await seed(storage, 1, ['the migration plan']);

        const res = await searchMessages(storage, 1, { query: 'migration' });
        assert.ok(res.ok);
        if (!res.ok) return;

        const hit = res.data.data[0];
        assert.equal(hit.context_id, ctxId);
        assert.notEqual(hit.context_id, hit.branch_id);
    });

    it('filters by source', async () => {
        const storage = new MemoryStorage();
        const ctx = await createContext(storage, 1, {});
        if (!ctx.ok) throw new Error('seed failed: ' + ctx.message);
        await appendMessages(storage, 1, ctx.data.id, [
            daemonMessage('assistant', 'plan from claude', { source: 'claude' }),
            daemonMessage('assistant', 'plan from codex', { source: 'codex' }),
        ]);

        const res = await searchMessages(storage, 1, { query: 'plan', source: 'codex' });
        assert.ok(res.ok);
        if (!res.ok) return;

        assert.equal(res.data.data.length, 1);
        assert.equal(res.data.data[0].metadata.source, 'codex');
    });

    it('NEVER returns another project’s messages (tenant isolation)', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, ['project one secret plan']);
        await seed(storage, 2, ['project two secret plan']);

        const one = await searchMessages(storage, 1, { query: 'secret plan' });
        const two = await searchMessages(storage, 2, { query: 'secret plan' });

        assert.ok(one.ok && two.ok);
        if (!one.ok || !two.ok) return;

        assert.equal(one.data.data.length, 1);
        assert.equal(two.data.data.length, 1);
        assert.ok(one.data.data[0].content.includes('project one'));
        assert.ok(two.data.data[0].content.includes('project two'));
    });

    it('returns no hits (not an error) when nothing matches', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, ['nothing relevant here']);

        const res = await searchMessages(storage, 1, { query: 'zzzznotpresent' });
        assert.ok(res.ok);
        if (res.ok) assert.equal(res.data.data.length, 0);
    });
});
