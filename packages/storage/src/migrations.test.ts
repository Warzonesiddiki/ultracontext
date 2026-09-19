import test from 'node:test';
import assert from 'node:assert/strict';

import { createClient } from '@libsql/client';

import { SCHEMA_SQL } from './sqlite/schema';
import { validateRegistry } from './migrations/registry';
import { migrateSqlite, rollbackSqlite } from './migrations/sqlite';
import { migratePostgres, rollbackPostgres } from './migrations/postgres';
import { migrations } from './migrations/registry';
import type { Migration } from './migrations/types';

// =============================================================================
// MIGRATIONS — SQLite (real in-memory DBs) + Postgres (mocked driver, real
// registry SQL; no Postgres server in CI for now)
// =============================================================================

async function tableNames(client: Awaited<ReturnType<typeof createClient>>): Promise<Set<string>> {
    const { rows } = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual table')",
    });
    return new Set(rows.map((r) => String(r.name)));
}

test('validateRegistry accepts the shipped registry', () => {
    assert.doesNotThrow(() => validateRegistry(migrations));
    assert.equal(migrations.length, 4);
    assert.equal(migrations[0].version, 1);
    assert.equal(migrations[1].version, 2);
    assert.equal(migrations[2].version, 3);
    assert.equal(migrations[3].version, 4);
});

test('validateRegistry rejects out-of-order or incomplete migrations', () => {
    const bad: Migration[] = [
        { version: 1, name: 'a', up: { postgres: 'x', sqlite: 'x' }, down: { postgres: 'x', sqlite: 'x' } },
        { version: 1, name: 'b', up: { postgres: 'x', sqlite: 'x' }, down: { postgres: 'x', sqlite: 'x' } },
    ];
    assert.throws(() => validateRegistry(bad), /strictly increasing/);
    const missing: Migration[] = [
        { version: 1, name: 'a', up: { postgres: 'x', sqlite: 'x' }, down: { postgres: 'x', sqlite: '' } },
    ];
    assert.throws(() => validateRegistry(missing), /down\.sqlite/);
});

test('migrateSqlite: fresh database → baseline + constraints + refs + ordinal applied, version 4', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2, 3, 4]);
        assert.equal(report.version, 4);

        const tables = await tableNames(client);
        for (const t of ['projects', 'api_keys', 'nodes', 'nodes_fts', 'context_refs', 'schema_migrations']) {
            assert.ok(tables.has(t), `missing table ${t}`);
        }

        // the rebuilt tables carry the FKs (no *_old leftovers)
        const { rows } = await client.execute({
            sql: "SELECT name FROM sqlite_master WHERE name LIKE '%_old'",
        });
        assert.equal(rows.length, 0, 'no rename leftovers after the rebuild');
    } finally {
        client.close();
    }
});

test('migrateSqlite: idempotent — second run applies nothing', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client);
        const second = await migrateSqlite(client);
        assert.equal(second.applied.length, 0);
        assert.equal(second.version, 4);
    } finally {
        client.close();
    }
});

// The pre-0002 DDL, verbatim (what pre-migration code and old SCHEMA_SQL
// created: no UNIQUE, no FKs). Pinned here so the legacy path stays tested
// even though SCHEMA_SQL now matches the post-migration shape.
const LEGACY_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    public_id TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL,
    project_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    parent_id TEXT,
    prev_id TEXT,
    context_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type);
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    public_id UNINDEXED,
    project_id UNINDEXED,
    context_id UNINDEXED,
    body,
    tokenize = 'porter unicode61'
);
`;

test('migrateSqlite: legacy database (old DDL) migrates without data loss', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        // what pre-migration code would have created
        await client.executeMultiple(LEGACY_SQL);
        await client.execute({
            sql: "INSERT INTO projects (name, created_at) VALUES ('legacy', '2026-01-01T00:00:00.000Z')",
        });

        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2, 3, 4]);

        const { rows } = await client.execute({ sql: 'SELECT name FROM projects' });
        assert.deepEqual(rows, [{ name: 'legacy' }]);
    } finally {
        client.close();
    }
});

test('migrateSqlite: a database bootstrapped by SCHEMA_SQL migrates cleanly', async () => {
    // guards against drift between the compatibility DDL and the migrations
    const client = createClient({ url: ':memory:' });
    try {
        await client.executeMultiple(SCHEMA_SQL);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'compat', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('node-c', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" });

        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2, 3, 4]);

        const { rows } = await client.execute({ sql: 'SELECT public_id FROM nodes' });
        assert.deepEqual(rows.map((r) => r.public_id), ['node-c'], 'data must survive the rebuild');
    } finally {
        client.close();
    }
});

test('migrateSqlite: legacy orphan rows (no cascade era) are cleaned up', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await client.executeMultiple(LEGACY_SQL);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'keeper', '2026-01-01T00:00:00.000Z')" });
        // valid rows
        await client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (1, 'uc_live_KEEP', 'hash', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('node-keep', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" });
        // orphans: project 999 never existed (possible while FKs were off)
        await client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (999, 'uc_live_ORPH', 'hash', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('node-orphan', 999, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" });

        await migrateSqlite(client);

        const { rows: keys } = await client.execute({ sql: 'SELECT key_prefix FROM api_keys ORDER BY key_prefix' });
        assert.deepEqual(keys.map((r) => r.key_prefix), ['uc_live_KEEP'], 'orphan key removed, valid key kept');
        const { rows: nodes } = await client.execute({ sql: 'SELECT public_id FROM nodes' });
        assert.deepEqual(nodes.map((r) => r.public_id), ['node-keep'], 'orphan node removed, valid node kept');
    } finally {
        client.close();
    }
});

test('migrateSqlite: legacy duplicate key_prefix fails the migration loudly', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await client.executeMultiple(LEGACY_SQL);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'p', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (1, 'uc_live_DUP', 'h1', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (1, 'uc_live_DUP', 'h2', '2026-01-01T00:00:00.000Z')" });

        await assert.rejects(() => migrateSqlite(client), /UNIQUE/i);
    } finally {
        client.close();
    }
});

test('migrateSqlite → rollback to 0 → migrate again: fully reversible', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client);
        const down = await rollbackSqlite(client, 0);
        assert.deepEqual(down.rolledBack.map((m) => m.version), [4, 3, 2, 1]);
        assert.equal(down.version, 0);

        const after = await tableNames(client);
        assert.ok(!after.has('nodes'), 'nodes should be dropped');
        assert.ok(!after.has('projects'), 'projects should be dropped');
        assert.ok(!after.has('context_refs'), 'context_refs should be dropped');
        assert.ok(after.has('schema_migrations'), 'bookkeeping table remains');

        const again = await migrateSqlite(client);
        assert.deepEqual(again.applied.map((m) => m.version), [1, 2, 3, 4]);
        assert.ok((await tableNames(client)).has('nodes'));
    } finally {
        client.close();
    }
});

test('migrateSqlite: UNIQUE constraints reject duplicates after migration', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'p', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('dup', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" });

        await assert.rejects(
            () => client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('dup', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" }),
            /UNIQUE/i,
        );

        await client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (1, 'uc_live_SAME', 'h1', '2026-01-01T00:00:00.000Z')" });
        await assert.rejects(
            () => client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (1, 'uc_live_SAME', 'h2', '2026-01-01T00:00:00.000Z')" }),
            /UNIQUE/i,
        );
    } finally {
        client.close();
    }
});

test('migrateSqlite: FK ON DELETE CASCADE with foreign_keys enabled', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await client.execute('PRAGMA foreign_keys = ON'); // what createSqliteAdapter does
        await migrateSqlite(client);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'doomed', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO api_keys (project_id, key_prefix, key_hash, created_at) VALUES (1, 'uc_live_GONE', 'hash', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('node-gone', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" });

        await client.execute({ sql: 'DELETE FROM projects WHERE id = 1' });

        const { rows: keys } = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM api_keys' });
        assert.equal(Number(keys[0]?.n ?? 1), 0, 'api_keys must cascade');
        const { rows: nodes } = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM nodes' });
        assert.equal(Number(nodes[0]?.n ?? 1), 0, 'nodes must cascade');

        // and a dangling insert is now rejected outright
        await assert.rejects(
            () => client.execute({ sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at) VALUES ('node-orphan2', 999, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z')" }),
            /FOREIGN KEY/i,
        );
    } finally {
        client.close();
    }
});

test('migration 0003: context_refs is unique per (project, context, name)', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await client.execute('PRAGMA foreign_keys = ON');
        await migrateSqlite(client);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'a', '2026-01-01T00:00:00.000Z')" });
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (2, 'b', '2026-01-01T00:00:00.000Z')" });

        const insertRef = (projectId: number, contextId: string, name: string, headId: string) =>
            client.execute({
                sql: `INSERT INTO context_refs (project_id, context_id, name, head_id, created_at, updated_at)
                      VALUES (${projectId}, '${contextId}', '${name}', '${headId}',
                              '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
            });

        await insertRef(1, 'ctx_a', 'main', 'ctx_head1');

        // re-pinning the same name in the same project+context is a duplicate at
        // the storage layer — the adapter upserts, it never double-inserts
        await assert.rejects(() => insertRef(1, 'ctx_a', 'main', 'ctx_head2'), /UNIQUE/i);

        // …but the key is scoped, so every other combination is legal: another
        // name, another context, another tenant's project
        await insertRef(1, 'ctx_a', 'dev', 'ctx_head3');
        await insertRef(1, 'ctx_b', 'main', 'ctx_head4');
        await insertRef(2, 'ctx_a', 'main', 'ctx_head5');

        const { rows } = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM context_refs' });
        assert.equal(Number(rows[0]?.n), 4);
    } finally {
        client.close();
    }
});

test('migration 0003: context_refs cascades from projects but has no FK on head_id', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await client.execute('PRAGMA foreign_keys = ON');
        await migrateSqlite(client);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'p', '2026-01-01T00:00:00.000Z')" });

        // head_id deliberately references a node that does not exist: the pinned
        // version can be deleted later and the name must survive it (readers
        // report version -1). An FK here would make that impossible.
        await client.execute({
            sql: `INSERT INTO context_refs (project_id, context_id, name, head_id, created_at, updated_at)
                  VALUES (1, 'ctx_gone', 'main', 'ctx_never_existed',
                          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        });
        const before = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM context_refs' });
        assert.equal(Number(before.rows[0]?.n), 1, 'orphaned head_id must be storable');

        // the tenant FK is the one that matters: dropping a project drops its names
        await client.execute({ sql: 'DELETE FROM projects WHERE id = 1' });
        const after = await client.execute({ sql: 'SELECT COUNT(*) AS n FROM context_refs' });
        assert.equal(Number(after.rows[0]?.n), 0, 'branch names must cascade with their project');
    } finally {
        client.close();
    }
});

// -- migration 0004: nodes.ordinal (ARCH-002) ---------------------------------

async function columnNames(client: ReturnType<typeof createClient>, table: string): Promise<Set<string>> {
    const { rows } = await client.execute({ sql: `PRAGMA table_info(${table})` });
    return new Set(rows.map((r) => String(r.name)));
}

async function ordinalsByPublicId(client: ReturnType<typeof createClient>): Promise<Record<string, number | null>> {
    const { rows } = await client.execute({ sql: 'SELECT public_id, ordinal FROM nodes ORDER BY public_id' });
    return Object.fromEntries(rows.map((r) => [String(r.public_id), r.ordinal === null || r.ordinal === undefined ? null : Number(r.ordinal)]));
}

test('migration 0004: nodes.ordinal exists on sqlite, indexed, and survives a rollback', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client);
        const columns = await columnNames(client, 'nodes');
        assert.ok(columns.has('ordinal'), 'ordinal column added');

        const { rows: indexes } = await client.execute({
            sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes'",
        });
        const names = new Set(indexes.map((r) => String(r.name)));
        assert.ok(names.has('idx_nodes_context_ordinal'), 'the partition+ordinal index backs nextOrdinal');
        assert.ok(names.has('idx_nodes_public_id'), 'the rebuild must restore the UNIQUE index 0002 created');
        assert.ok(names.has('idx_nodes_context_id'), '…and the baseline indexes');

        // the 0002 constraints must survive the 0004 rebuild: a rebuild that
        // quietly dropped the FK or the UNIQUE index would be a regression no
        // reader would notice until data went missing
        const { rows: ddl } = await client.execute({
            sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes'",
        });
        const create = String(ddl[0].sql);
        assert.ok(create.includes('REFERENCES projects(id) ON DELETE CASCADE'), 'FK cascade preserved');

        await rollbackSqlite(client, 3);
        assert.ok(!(await columnNames(client, 'nodes')).has('ordinal'), 'down removes the column');
        const afterDown = await client.execute({
            sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'nodes'",
        });
        assert.ok(
            !afterDown.rows.map((r) => String(r.name)).includes('idx_nodes_context_ordinal'),
            'down removes its index',
        );
        assert.ok(
            afterDown.rows.map((r) => String(r.name)).includes('idx_nodes_public_id'),
            'down restores the pre-0004 indexes',
        );
    } finally {
        client.close();
    }
});

test('migration 0004: backfill ranks each partition by write order, ties broken by id', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        // a database from before the column existed
        await client.executeMultiple(LEGACY_SQL);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'p', '2026-01-01T00:00:00.000Z')" });

        const at = '2026-09-18T00:00:00.000Z';
        // one partition whose three nodes share a millisecond — the exact case
        // where a created_at-only order used to be up to the storage engine
        for (const id of ['msg_c', 'msg_a', 'msg_b']) {
            await client.execute({
                sql: 'INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id) VALUES (?, 1, ?, ?, ?, ?, ?)',
                args: [id, 'message', '{}', '{}', at, 'ctx_head_1'],
            });
        }
        // a second partition, numbered independently
        await client.execute({
            sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id) VALUES ('msg_other', 1, 'message', '{}', '{}', '2026-01-01T00:00:00.000Z', 'ctx_head_2')",
        });
        // a version head written EARLIER than its messages: ranking is per
        // partition, so its own timestamp does not interfere
        await client.execute({
            sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id, prev_id) VALUES ('ctx_head_1', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z', 'ctx_root_1', NULL)",
        });
        // a root context: context_id NULL means no partition and no ordinal
        await client.execute({
            sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id) VALUES ('ctx_root_1', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z', NULL)",
        });

        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2, 3, 4]);

        const ordinals = await ordinalsByPublicId(client);
        // insertion order was msg_c, msg_a, msg_b — identical timestamps, so the
        // surrogate id (monotonic per insert) is what records the write order
        assert.deepEqual(
            [ordinals.msg_c, ordinals.msg_a, ordinals.msg_b],
            [0, 1, 2],
            'one partition ranks 0..n-1 by (created_at, id)',
        );
        assert.equal(ordinals.msg_other, 0, 'a different partition starts over');
        assert.equal(ordinals.ctx_head_1, 0, 'version heads rank within the root partition');
        assert.equal(ordinals.ctx_root_1, null, 'a root belongs to no partition');
    } finally {
        client.close();
    }
});

test('migration 0004: runs on a SCHEMA_SQL database that already has the column', async () => {
    // SCHEMA_SQL matches the post-0004 shape, and migrations.test bootstraps
    // from it — so 0004 has to land the same final state from a database that
    // ALREADY has ordinal. SQLite has no ADD COLUMN IF NOT EXISTS; the rebuild
    // is what makes both starting points converge.
    const client = createClient({ url: ':memory:' });
    try {
        await client.executeMultiple(SCHEMA_SQL);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'compat', '2026-01-01T00:00:00.000Z')" });
        await client.execute({
            sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id, ordinal) VALUES ('msg_x', 1, 'message', '{}', '{}', '2026-01-02T00:00:00.000Z', 'ctx_head', 0)",
        });

        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2, 3, 4]);

        const ordinals = await ordinalsByPublicId(client);
        assert.deepEqual(ordinals, { msg_x: 0 }, 'data and ordinal survive the rebuild');
        assert.ok((await columnNames(client, 'nodes')).has('ordinal'));
    } finally {
        client.close();
    }
});

test('migration 0004: rollback keeps the rows it rebuilds', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client);
        await client.execute({ sql: "INSERT INTO projects (id, name, created_at) VALUES (1, 'p', '2026-01-01T00:00:00.000Z')" });
        await client.execute({
            sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id, prev_id, ordinal) VALUES ('ctx_h', 1, 'context', '{}', '{}', '2026-01-01T00:00:00.000Z', 'ctx_r', NULL, 0)",
        });
        await client.execute({
            sql: "INSERT INTO nodes (public_id, project_id, type, content, metadata, created_at, context_id, prev_id, ordinal) VALUES ('msg_m', 1, 'message', '{\"text\":\"keep me\"}', '{}', '2026-01-01T00:00:00.000Z', 'ctx_h', NULL, 0)",
        });

        await rollbackSqlite(client, 3);

        const { rows } = await client.execute({ sql: 'SELECT public_id, content FROM nodes ORDER BY public_id' });
        assert.deepEqual(rows.map((r) => r.public_id), ['ctx_h', 'msg_m'], 'a rebuild must not lose rows');
        assert.equal(String(rows[1].content), '{"text":"keep me"}', '…or their content');
    } finally {
        client.close();
    }
});

test('migration 0004: postgres up/down SQL is additive and idempotent', () => {
    const m = migrations[3];
    assert.equal(m.name, 'node-ordinal-chain-order');

    // IF NOT EXISTS on both the column and the index: an init.sql database that
    // was stamped 1..4 must not break if 0004 is ever replayed
    assert.ok(m.up.postgres.includes('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ordinal BIGINT'));
    assert.ok(m.up.postgres.includes('CREATE INDEX IF NOT EXISTS idx_nodes_context_ordinal'));
    assert.ok(m.up.postgres.includes('WHERE nodes.context_id IS NOT NULL'), 'roots get no ordinal');
    assert.ok(
        !/ordinal/.test(m.up.postgres.split('UPDATE nodes SET ordinal')[1]?.split('WHERE')[0] ?? ''),
        'the ranking subquery must not read the column it is writing',
    );

    assert.ok(m.down.postgres.includes('DROP INDEX IF EXISTS idx_nodes_context_ordinal'));
    assert.ok(m.down.postgres.includes('ALTER TABLE nodes DROP COLUMN IF EXISTS ordinal'));

    // SQLite cannot ADD COLUMN IF NOT EXISTS, so it rebuilds — and the copy
    // must not name the column, since the source table may or may not have it
    assert.ok(m.up.sqlite.includes('ALTER TABLE nodes RENAME TO nodes_old'));
    assert.ok(m.up.sqlite.includes('ordinal INTEGER'));
    const copyStatement = m.up.sqlite.split('INSERT INTO nodes')[1].split('FROM nodes_old')[0];
    assert.ok(!copyStatement.includes('ordinal'), 'the copy column list omits ordinal on purpose');
    assert.ok(m.down.sqlite.includes('ALTER TABLE nodes RENAME TO nodes_old'));
    assert.ok(!m.down.sqlite.split('CREATE TABLE nodes (')[1].split(');')[0].includes('ordinal'));
});

// A synthetic migration AFTER the shipped registry. It used to be version 3,
// then 4; 0003_context_refs and 0004_node_ordinal took those numbers, and
// registry versions are immutable — never reuse one, so the fixture moves to 5.
const TEST_0005: Migration = {
    version: 5,
    name: 'add-flags',
    up: {
        postgres: 'CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT);',
        sqlite: 'CREATE TABLE flags (key TEXT PRIMARY KEY, value TEXT);',
    },
    down: {
        postgres: 'DROP TABLE flags;',
        sqlite: 'DROP TABLE flags;',
    },
};

test('migrateSqlite: a further migration applies and rolls back cleanly', async () => {
    const client = createClient({ url: ':memory:' });
    const list = [...migrations, TEST_0005];
    try {
        const up = await migrateSqlite(client, list);
        assert.deepEqual(up.applied.map((m) => m.version), [1, 2, 3, 4, 5]);
        assert.ok((await tableNames(client)).has('flags'));

        const down = await rollbackSqlite(client, 4, list);
        assert.deepEqual(down.rolledBack.map((m) => m.version), [5]);
        assert.equal(down.version, 4);
        assert.ok(!(await tableNames(client)).has('flags'));
        assert.ok((await tableNames(client)).has('nodes'), 'baseline must survive');
        assert.ok((await tableNames(client)).has('context_refs'), 'shipped migrations must survive');
    } finally {
        client.close();
    }
});

test('rollbackSqlite: unknown applied version is a hard error', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client, [...migrations, TEST_0005]);
        // registry that no longer contains version 5
        await assert.rejects(() => rollbackSqlite(client, 1, migrations), /no matching migration/);
    } finally {
        client.close();
    }
});

// ── Postgres runner (mocked postgres-js `unsafe`) ────────────────────────────

interface PgState {
    version: number;
    applied: Array<{ version: number; name: string }>;
    calls: string[];
}

function mockPg(state: PgState) {
    return {
        unsafe: async (query: string): Promise<unknown> => {
            state.calls.push(query);
            if (query.includes('SELECT COALESCE(MAX(version)')) return [{ v: state.version }];
            if (query.includes('SELECT version, name FROM schema_migrations')) {
                return state.applied.map((a) => ({ version: a.version, name: a.name }));
            }
            return [];
        },
    };
}

test('migratePostgres: fresh database — transactional up + version stamps', async () => {
    const state: PgState = { version: 0, applied: [], calls: [] };
    const report = await migratePostgres(mockPg(state) as never);

    assert.deepEqual(report.applied.map((m) => m.version), [1, 2, 3, 4]);
    assert.equal(state.version, 0); // mock state unchanged — verify the SQL
    const ups = state.calls.filter((c) => c.startsWith('BEGIN;'));
    assert.equal(ups.length, 4, 'each migration runs in its own transaction');

    const up = ups[0];
    assert.ok(up, 'up must run in a transaction');
    assert.ok(up.includes('CREATE TABLE IF NOT EXISTS nodes'));
    assert.ok(up.includes('CREATE OR REPLACE FUNCTION ultracontext_activity'));
    assert.ok(up.includes("INSERT INTO schema_migrations (version, name) VALUES (1, 'init')"));
    assert.ok(up.trimEnd().endsWith('COMMIT;'));

    // 0002 is a no-op on Postgres (constraints already in 0001) but still stamps
    assert.ok(ups[1].includes("INSERT INTO schema_migrations (version, name) VALUES (2, 'sqlite-unique-and-fk-cascade')"));

    // 0003 adds the named-branch table on BOTH dialects
    assert.ok(ups[2].includes('CREATE TABLE IF NOT EXISTS context_refs'));
    assert.ok(ups[2].includes('uq_context_refs_project_context_name'));
    assert.ok(ups[2].includes("INSERT INTO schema_migrations (version, name) VALUES (3, 'context-refs-named-branches')"));

    // 0004 adds the explicit chain ordinal on BOTH dialects (ARCH-002)
    assert.ok(ups[3].includes('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ordinal BIGINT'));
    assert.ok(ups[3].includes('idx_nodes_context_ordinal'));
    assert.ok(ups[3].includes("INSERT INTO schema_migrations (version, name) VALUES (4, 'node-ordinal-chain-order')"));
});

test('migratePostgres: already-current database — no DDL issued', async () => {
    const state: PgState = {
        version: 4,
        applied: [
            { version: 1, name: 'init' },
            { version: 2, name: 'sqlite-unique-and-fk-cascade' },
            { version: 3, name: 'context-refs-named-branches' },
            { version: 4, name: 'node-ordinal-chain-order' },
        ],
        calls: [],
    };
    const report = await migratePostgres(mockPg(state) as never);
    assert.equal(report.applied.length, 0);
    assert.equal(state.calls.filter((c) => c.startsWith('BEGIN;')).length, 0);
});

test('rollbackPostgres: reverses the baseline and clears the stamp', async () => {
    const state: PgState = { version: 1, applied: [{ version: 1, name: 'init' }], calls: [] };
    const report = await rollbackPostgres(mockPg(state) as never, 0);
    assert.deepEqual(report.rolledBack.map((m) => m.version), [1]);
    const down = state.calls.find((c) => c.startsWith('BEGIN;'));
    assert.ok(down);
    assert.ok(down.includes('DROP FUNCTION IF EXISTS ultracontext_activity'));
    assert.ok(down.includes('DROP TABLE IF EXISTS nodes'));
    assert.ok(down.includes('DELETE FROM schema_migrations WHERE version = 1'));
});

test('rollbackPostgres: unknown applied version is a hard error', async () => {
    const state: PgState = { version: 9, applied: [{ version: 9, name: 'ghost' }], calls: [] };
    await assert.rejects(() => rollbackPostgres(mockPg(state) as never, 8, migrations), /no matching migration/);
});
