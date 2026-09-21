import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createContext, appendMessages, getContext, createBranch, deleteBranch, listBranches } from '@ultracontext/core';
import { createSqliteAdapter } from './index';

// =============================================================================
// KEYSTONE PROOF — @ultracontext/core ops run against local SQLite, in-process,
// with NO HTTP server. This is the whole Full-TS-local-first thesis.
// =============================================================================

// unique temp db file per use, auto-cleaned (local-first stores a real file)
const tmpFiles: string[] = [];
function tmpDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-sqlite-${process.pid}-${tmpFiles.length}-${Date.now()}.db`);
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

describe('SqliteAdapter — core ops run local, no server', () => {
    it('round-trips create → append → get', async () => {
        const storage = await createSqliteAdapter(tmpDbUrl());
        const project = await storage.insertProject('test');
        const projectId = project!.id;

        // create a context
        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;

        // append two messages
        const appended = await appendMessages(storage, projectId, created.data.id, [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ]);
        assert.equal(appended.ok, true);
        if (!appended.ok) return;
        assert.equal(appended.data.data.length, 2);

        // read them back, ordered
        const got = await getContext(storage, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 2);
        assert.equal(got.data.data[0].role, 'user');
        assert.equal(got.data.data[1].role, 'assistant');
    });

    it('persists across reconnects to the same file (local-first, no server)', async () => {
        const url = tmpDbUrl();

        // write with one connection
        let storage = await createSqliteAdapter(url);
        const project = await storage.insertProject('test');
        const projectId = project!.id;
        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;
        await appendMessages(storage, projectId, created.data.id, [{ role: 'user', content: 'persisted' }]);

        // reopen a fresh connection to the same file — data survives
        storage = await createSqliteAdapter(url);
        const got = await getContext(storage, projectId, created.data.id, {});
        assert.equal(got.ok, true);
        if (!got.ok) return;
        assert.equal(got.data.data.length, 1);
        assert.equal(got.data.data[0].content, 'persisted');
    });

    it('pins named branches to immutable version ids (ARCH-001, real ON CONFLICT path)', async () => {
        const url = tmpDbUrl();
        const storage = await createSqliteAdapter(url);
        const project = await storage.insertProject('test');
        const projectId = project!.id;

        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;
        const contextId = created.data.id;
        await appendMessages(storage, projectId, contextId, [{ role: 'user', content: 'v0' }]);

        // pin a branch at the current head
        const pinned = await createBranch(storage, projectId, contextId, { name: 'release-1' });
        assert.equal(pinned.ok, true);
        if (!pinned.ok) return;
        assert.match(pinned.data.version_id, /^ctx_/);

        // the chain grows underneath the pin — the id must not move
        await appendMessages(storage, projectId, contextId, [{ role: 'user', content: 'v1' }]);
        const listed = await listBranches(storage, projectId, contextId);
        assert.equal(listed.ok, true);
        if (!listed.ok) return;
        assert.equal(listed.data.branches.length, 1);
        assert.equal(listed.data.branches[0].version_id, pinned.data.version_id);

        // that exact state is readable forever by its immutable id
        const byId = await getContext(storage, projectId, contextId, { version: pinned.data.version_id });
        assert.equal(byId.ok, true);

        // move the branch (git `branch -f`) — created_at survives, updated_at advances
        await new Promise((r) => setTimeout(r, 10));
        const moved = await createBranch(storage, projectId, contextId, { name: 'release-1' });
        assert.equal(moved.ok, true);
        if (!moved.ok) return;
        assert.equal(moved.data.created_at, pinned.data.created_at);
        assert.notEqual(moved.data.version_id, pinned.data.version_id);
        assert.ok(
            new Date(moved.data.updated_at).getTime() > new Date(pinned.data.updated_at).getTime(),
            'updated_at must advance when a branch moves'
        );
        // still one row: upsert, not insert
        const afterMove = await listBranches(storage, projectId, contextId);
        assert.equal(afterMove.ok, true);
        if (afterMove.ok) assert.equal(afterMove.data.branches.length, 1);

        // branch names survive a reconnect (they are ordinary persisted rows)
        const reopened = await createSqliteAdapter(url);
        const afterReopen = await listBranches(reopened, projectId, contextId);
        assert.equal(afterReopen.ok, true);
        if (afterReopen.ok) {
            assert.equal(afterReopen.data.branches.length, 1);
            assert.equal(afterReopen.data.branches[0].version_id, moved.data.version_id);
        }

        // delete removes the pointer only — the pinned version still reads back
        const removed = await deleteBranch(reopened, projectId, contextId, 'release-1');
        assert.equal(removed.ok, true);
        if (removed.ok) assert.deepEqual(removed.data, { deleted: true, name: 'release-1' });

        const empty = await listBranches(reopened, projectId, contextId);
        if (empty.ok) assert.deepEqual(empty.data.branches, []);

        const stillReadable = await getContext(reopened, projectId, contextId, { version: moved.data.version_id });
        assert.equal(stillReadable.ok, true, 'deleting a branch must never destroy version data');

        // a second delete is an honest false, which the API turns into a 404
        const again = await deleteBranch(reopened, projectId, contextId, 'release-1');
        assert.equal(again.ok, false);
    });

    it('persists the chain ordinal in a real SQLite file (ARCH-002)', async () => {
        const url = tmpDbUrl();
        const storage = await createSqliteAdapter(url);
        const project = await storage.insertProject('test');
        const projectId = project!.id;

        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        if (!created.ok) return;
        const contextId = created.data.id;

        await appendMessages(storage, projectId, contextId, [{ role: 'user', content: 'a' }]);
        await appendMessages(storage, projectId, contextId, [
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ]);

        // version heads carry a gap-free ordinal, in write order
        const heads = await storage.findContextBranches(contextId);
        const ordinals = (rows: { ordinal: number | null }[]) =>
            rows.map((r) => r.ordinal).sort((a, b) => Number(a) - Number(b));
        assert.deepEqual(ordinals(heads), [0, 1, 2]);

        // the projection is honoured: ask for ordinal and get ordinal. An
        // adapter that ignored `columns` would hand back undefined, which
        // nextOrdinal cannot tell from an empty partition — every append would
        // then restart the head numbering at 0.
        const projected = await storage.findNodesByContextId(contextId, ['public_id', 'ordinal']);
        assert.equal(projected.length, 3);
        assert.deepEqual(Object.keys(projected[0]).sort(), ['ordinal', 'public_id']);
        assert.ok(projected.every((row) => typeof row.ordinal === 'number'));

        const defaulted = await storage.findNodesByContextId(contextId);
        assert.deepEqual(Object.keys(defaulted[0]).sort(), ['prev_id', 'public_id'], 'the default stays narrow');

        // messages are numbered inside their own head's partition, from 0
        const newest = heads.find((h) => h.ordinal === 2)!;
        const messages = await storage.findNonContextNodes(newest.public_id);
        assert.deepEqual(messages.map((m) => m.ordinal), [0, 1]);

        // …and it is really in the file, not just in the connection
        const reopened = await createSqliteAdapter(url);
        assert.deepEqual(ordinals(await reopened.findContextBranches(contextId)), [0, 1, 2]);

        const read = await getContext(reopened, projectId, contextId, {});
        assert.equal(read.ok, true);
        if (read.ok) assert.deepEqual(read.data.data.map((m) => m.content), ['a', 'b', 'c']);
    });
});
