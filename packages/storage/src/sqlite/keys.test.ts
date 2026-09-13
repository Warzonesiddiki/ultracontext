// =============================================================================
// SQLITE — key lifecycle methods (list / find / delete)
// =============================================================================

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { createSqliteAdapter } from './index';

const tmpFiles: string[] = [];
function tmpDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-keys-${process.pid}-${tmpFiles.length}-${Date.now()}.db`);
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

describe('SqliteAdapter — key lifecycle', () => {
    it('listApiKeys returns public fields only, scoped to the project', async () => {
        const db = await createSqliteAdapter(tmpDbUrl());

        const p1 = await db.insertProject('one');
        const p2 = await db.insertProject('two');
        await db.insertApiKey({ project_id: p1!.id, key_prefix: 'uc_live_AAAA', key_hash: 'hash-a' });
        await db.insertApiKey({ project_id: p1!.id, key_prefix: 'uc_live_BBBB', key_hash: 'hash-b' });
        await db.insertApiKey({ project_id: p2!.id, key_prefix: 'uc_live_CCCC', key_hash: 'hash-c' });

        const rows = await db.listApiKeys(p1!.id);
        assert.equal(rows.length, 2);
        assert.deepEqual(
            rows.map((r) => r.key_prefix),
            ['uc_live_AAAA', 'uc_live_BBBB']
        );
        for (const r of rows) {
            assert.equal(r.project_id, p1!.id);
            assert.ok(r.created_at.length > 0);
            assert.equal('key_hash' in r, false, 'public rows must not carry the hash');
        }
        const raw = JSON.stringify(rows);
        assert.ok(!raw.includes('hash-a'), 'hash values must not leak');

        assert.equal((await db.listApiKeys(p2!.id)).length, 1);
    });

    it('findApiKey returns null for unknown ids', async () => {
        const db = await createSqliteAdapter(tmpDbUrl());
        const p = await db.insertProject('x');
        await db.insertApiKey({ project_id: p!.id, key_prefix: 'uc_live_DDDD', key_hash: 'hash-d' });

        const rows = await db.listApiKeys(p!.id);
        assert.ok(rows[0]);
        assert.equal((await db.findApiKey(rows[0].id))?.key_prefix, 'uc_live_DDDD');
        assert.equal(await db.findApiKey(9999), null);
    });

    it('deleteApiKey removes the row and reports existence', async () => {
        const db = await createSqliteAdapter(tmpDbUrl());
        const p = await db.insertProject('x');
        await db.insertApiKey({ project_id: p!.id, key_prefix: 'uc_live_EEEE', key_hash: 'hash-e' });

        const rows = await db.listApiKeys(p!.id);
        assert.equal(await db.deleteApiKey(rows[0].id), true);
        assert.equal(await db.findApiKey(rows[0].id), null);
        assert.equal(await db.deleteApiKey(rows[0].id), false, 'second delete reports false');
        assert.equal(await db.deleteApiKey(424242), false, 'unknown id reports false');
    });

    it('deleteProject cascades keys and nodes (FK ON DELETE CASCADE)', async () => {
        const db = await createSqliteAdapter(tmpDbUrl());
        const p1 = await db.insertProject('doomed');
        const p2 = await db.insertProject('keeper');
        await db.insertApiKey({ project_id: p1!.id, key_prefix: 'uc_live_FFFF', key_hash: 'hash-f' });
        await db.insertApiKey({ project_id: p2!.id, key_prefix: 'uc_live_GGGG', key_hash: 'hash-g' });
        await db.insertNodes({
            public_id: 'ctx-doomed',
            project_id: p1!.id,
            type: 'context',
            content: {},
            metadata: {},
        });
        await db.insertNodes({
            public_id: 'ctx-keeper',
            project_id: p2!.id,
            type: 'context',
            content: {},
            metadata: {},
        });

        await db.deleteProject(p1!.id);

        assert.equal((await db.listApiKeys(p1!.id)).length, 0, 'api_keys must cascade');
        assert.equal((await db.listApiKeys(p2!.id)).length, 1, 'other projects untouched');
        assert.equal((await db.listRootContexts(p1!.id, 10)).length, 0, 'nodes must cascade');
        assert.equal((await db.listRootContexts(p2!.id, 10)).length, 1, 'other projects untouched');
    });
});

describe('SqliteAdapter — constraint enforcement (migration 0002)', () => {
    it('rejects a duplicate key_prefix and a duplicate node public_id', async () => {
        const db = await createSqliteAdapter(tmpDbUrl());
        const p = await db.insertProject('x');
        await db.insertApiKey({ project_id: p!.id, key_prefix: 'uc_live_HHHH', key_hash: 'hash-h' });
        // drizzle wraps the libsql error: the SQLITE_CONSTRAINT text is on cause
        await assert.rejects(
            () => db.insertApiKey({ project_id: p!.id, key_prefix: 'uc_live_HHHH', key_hash: 'hash-h2' }),
            (err: any) => /UNIQUE|constraint/i.test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`),
            'duplicate key_prefix must fail loudly',
        );

        await db.insertNodes({
            public_id: 'ctx-dup',
            project_id: p!.id,
            type: 'context',
            content: {},
            metadata: {},
        });
        await assert.rejects(
            () =>
                db.insertNodes({
                    public_id: 'ctx-dup',
                    project_id: p!.id,
                    type: 'context',
                    content: {},
                    metadata: {},
                }),
            (err: any) => /UNIQUE|constraint/i.test(`${err?.message ?? ''} ${err?.cause?.message ?? ''}`),
            'duplicate public_id must fail loudly',
        );
    });
});
