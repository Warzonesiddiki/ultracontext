import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createContext, appendMessages, searchMessages } from '@ultracontext/core';
import type { StorageAdapter } from '@ultracontext/core';
import { createSqliteAdapter, toFtsQuery } from './index';

// =============================================================================
// FULL-TEXT SEARCH ON SQLITE — the local, self-hosted, 100% free path.
// Search is a first-class capability: no quota, no metering, no paywall.
// =============================================================================

const tmpFiles: string[] = [];
function tmpDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-fts-${process.pid}-${tmpFiles.length}-${Date.now()}.db`);
    tmpFiles.push(file);
    return `file:${file}`;
}

after(() => {
    for (const f of tmpFiles) {
        for (const ext of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(f + ext); } catch { /* ignore */ }
        }
    }
});

function daemonMessage(text: string, meta: Record<string, unknown> = {}) {
    return { role: 'assistant', content: { message: text, event_type: 'message' }, metadata: meta };
}

async function seed(storage: StorageAdapter, projectId: number, texts: string[]) {
    const ctx = await createContext(storage, projectId, { metadata: { source: 'claude' } });
    if (!ctx.ok) throw new Error('seed failed: ' + ctx.message);
    await appendMessages(storage, projectId, ctx.data.id, texts.map((t) => daemonMessage(t, { source: 'claude', user_id: 'alice' })));
    return ctx.data.id;
}

describe('toFtsQuery — input escaping', () => {
    it('quotes tokens so FTS5 operators can never change semantics', () => {
        assert.equal(toFtsQuery('plan'), '"plan"*');
        assert.equal(toFtsQuery('two words'), '"two" "words"*');
    });

    it('neutralises FTS5 operators in user input', () => {
        // NEAR / OR / - / * would otherwise be interpreted by FTS5
        const q = toFtsQuery('foo OR bar NEAR baz -not');
        assert.ok(!/\bOR\b[^"]/.test(q.replace(/"[^"]*"/g, '')));
        assert.ok(q.startsWith('"'));
    });

    it('normalises quote characters into FTS5 phrase delimiters', () => {
        // Input quotes are dropped by the tokenizer and re-emitted as FTS5 phrase
        // delimiters, so they can never unbalance the MATCH expression.
        assert.equal(toFtsQuery('say "hi"'), '"say" "hi"*');
        // every quote in the output is a balanced delimiter, never raw user input
        const q = toFtsQuery('a "b" c');
        assert.equal((q.match(/"/g) ?? []).length % 2, 0);
    });

    it('returns empty for input with no indexable tokens', () => {
        assert.equal(toFtsQuery('!!! ???'), '');
        assert.equal(toFtsQuery('   '), '');
    });
});

describe('SqliteAdapter — full-text search', () => {
    it('indexes messages on append and finds them', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        await seed(storage, 1, ['we decided to refactor the auth middleware', 'unrelated chatter']);

        const res = await searchMessages(storage, 1, { query: 'refactor' });
        assert.ok(res.ok, res.ok ? '' : res.message);
        if (!res.ok) return;

        assert.equal(res.data.data.length, 1);
        assert.ok(res.data.data[0].content.includes('refactor'));
    });

    it('stems words (porter tokenizer): "refactor" matches "refactoring"', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        await seed(storage, 1, ['we are refactoring the parser today']);

        const res = await searchMessages(storage, 1, { query: 'refactor' });
        assert.ok(res.ok);
        if (res.ok) assert.equal(res.data.data.length, 1);
    });

    it('supports prefix / typeahead matching', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        await seed(storage, 1, ['implemented the authentication layer']);

        const res = await searchMessages(storage, 1, { query: 'auth' });
        assert.ok(res.ok);
        if (res.ok) assert.equal(res.data.data.length, 1);
    });

    it('ranks the better match first', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        await seed(storage, 1, [
            'refactor mentioned once in passing',
            'refactor refactor refactor the whole thing',
        ]);

        const res = await searchMessages(storage, 1, { query: 'refactor' });
        assert.ok(res.ok);
        if (!res.ok) return;

        assert.equal(res.data.data.length, 2);
        // bm25 ranks the denser document higher; ascending rank = better
        assert.ok(res.data.data[0].rank <= res.data.data[1].rank);
    });

    it('filters by metadata and time range', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        const ctx = await createContext(storage, 1, {});
        if (!ctx.ok) throw new Error('seed failed: ' + ctx.message);
        await appendMessages(storage, 1, ctx.data.id, [
            daemonMessage('the claude plan', { source: 'claude' }),
            daemonMessage('the codex plan', { source: 'codex' }),
        ]);

        const claude = await searchMessages(storage, 1, { query: 'plan', source: 'claude' });
        assert.ok(claude.ok);
        if (claude.ok) {
            assert.equal(claude.data.data.length, 1);
            assert.equal(claude.data.data[0].metadata.source, 'claude');
        }

        const future = await searchMessages(storage, 1, { query: 'plan', after: '2099-01-01T00:00:00Z' });
        assert.ok(future.ok);
        if (future.ok) assert.equal(future.data.data.length, 0);
    });

    it('scopes results to the project (tenant isolation)', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        await seed(storage, 1, ['project one secret plan']);
        await seed(storage, 2, ['project two secret plan']);

        const one = await searchMessages(storage, 1, { query: 'secret' });
        const two = await searchMessages(storage, 2, { query: 'secret' });

        assert.ok(one.ok && two.ok);
        if (!one.ok || !two.ok) return;

        assert.equal(one.data.data.length, 1);
        assert.equal(two.data.data.length, 1);
        assert.ok(one.data.data[0].content.includes('one'));
        assert.ok(two.data.data[0].content.includes('two'));
    });

    it('survives hostile FTS5 syntax without throwing', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        await seed(storage, 1, ['a normal message about plans']);

        for (const hostile of ['"', 'plan OR', 'NEAR(a b)', '*', '((', 'plan"', 'a AND NOT b', '-']) {
            const res = await searchMessages(storage, 1, { query: hostile });
            assert.ok(res.ok, `query ${JSON.stringify(hostile)} should not error`);
        }
    });

    it('removes index entries when the context is deleted', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        const ctxId = await seed(storage, 1, ['delete me entirely']);

        const before = await searchMessages(storage, 1, { query: 'entirely' });
        assert.ok(before.ok && before.data.data.length === 1);

        // wipe every node under the root, mirroring a permanent delete.
        // Branches must be read BEFORE the heads are deleted.
        const branches = await storage.findContextBranches(ctxId);
        for (const branch of branches) await storage.deleteNodesByContextId(1, branch.public_id);
        await storage.deleteNodesByContextId(1, ctxId);
        await storage.deleteNodeByPublicId(1, ctxId);

        const after = await searchMessages(storage, 1, { query: 'entirely' });
        assert.ok(after.ok);
        if (after.ok) assert.equal(after.data.data.length, 0);
    });
});
