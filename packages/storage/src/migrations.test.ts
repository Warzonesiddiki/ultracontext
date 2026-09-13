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
    assert.equal(migrations.length, 2);
    assert.equal(migrations[0].version, 1);
    assert.equal(migrations[1].version, 2);
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

test('migrateSqlite: fresh database → baseline + constraints applied, version 2', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2]);
        assert.equal(report.version, 2);

        const tables = await tableNames(client);
        for (const t of ['projects', 'api_keys', 'nodes', 'nodes_fts', 'schema_migrations']) {
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
        assert.equal(second.version, 2);
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
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2]);

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
        assert.deepEqual(report.applied.map((m) => m.version), [1, 2]);

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
        assert.deepEqual(down.rolledBack.map((m) => m.version), [2, 1]);
        assert.equal(down.version, 0);

        const after = await tableNames(client);
        assert.ok(!after.has('nodes'), 'nodes should be dropped');
        assert.ok(!after.has('projects'), 'projects should be dropped');
        assert.ok(after.has('schema_migrations'), 'bookkeeping table remains');

        const again = await migrateSqlite(client);
        assert.deepEqual(again.applied.map((m) => m.version), [1, 2]);
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

const TEST_0003: Migration = {
    version: 3,
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

test('migrateSqlite: a third migration applies and rolls back cleanly', async () => {
    const client = createClient({ url: ':memory:' });
    const list = [...migrations, TEST_0003];
    try {
        const up = await migrateSqlite(client, list);
        assert.deepEqual(up.applied.map((m) => m.version), [1, 2, 3]);
        assert.ok((await tableNames(client)).has('flags'));

        const down = await rollbackSqlite(client, 2, list);
        assert.deepEqual(down.rolledBack.map((m) => m.version), [3]);
        assert.equal(down.version, 2);
        assert.ok(!(await tableNames(client)).has('flags'));
        assert.ok((await tableNames(client)).has('nodes'), 'baseline must survive');
    } finally {
        client.close();
    }
});

test('rollbackSqlite: unknown applied version is a hard error', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client, [...migrations, TEST_0003]);
        // registry that no longer contains version 3
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

    assert.deepEqual(report.applied.map((m) => m.version), [1, 2]);
    assert.equal(state.version, 0); // mock state unchanged — verify the SQL
    const ups = state.calls.filter((c) => c.startsWith('BEGIN;'));
    assert.equal(ups.length, 2, 'each migration runs in its own transaction');

    const up = ups[0];
    assert.ok(up, 'up must run in a transaction');
    assert.ok(up.includes('CREATE TABLE IF NOT EXISTS nodes'));
    assert.ok(up.includes('CREATE OR REPLACE FUNCTION ultracontext_activity'));
    assert.ok(up.includes("INSERT INTO schema_migrations (version, name) VALUES (1, 'init')"));
    assert.ok(up.trimEnd().endsWith('COMMIT;'));

    // 0002 is a no-op on Postgres (constraints already in 0001) but still stamps
    assert.ok(ups[1].includes("INSERT INTO schema_migrations (version, name) VALUES (2, 'sqlite-unique-and-fk-cascade')"));
});

test('migratePostgres: already-current database — no DDL issued', async () => {
    const state: PgState = {
        version: 2,
        applied: [{ version: 1, name: 'init' }, { version: 2, name: 'sqlite-unique-and-fk-cascade' }],
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
    const state: PgState = { version: 3, applied: [{ version: 3, name: 'ghost' }], calls: [] };
    await assert.rejects(() => rollbackPostgres(mockPg(state) as never, 2, migrations), /no matching migration/);
});
