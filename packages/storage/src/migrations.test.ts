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
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0].version, 1);
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

test('migrateSqlite: fresh database → baseline applied, version 1', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1]);
        assert.equal(report.version, 1);

        const tables = await tableNames(client);
        for (const t of ['projects', 'api_keys', 'nodes', 'nodes_fts', 'schema_migrations']) {
            assert.ok(tables.has(t), `missing table ${t}`);
        }
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
        assert.equal(second.version, 1);
    } finally {
        client.close();
    }
});

test('migrateSqlite: legacy database (old SCHEMA_SQL) migrates without data loss', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        // what pre-migration code would have created
        await client.executeMultiple(SCHEMA_SQL);
        await client.execute({
            sql: "INSERT INTO projects (name, created_at) VALUES ('legacy', '2026-01-01T00:00:00.000Z')",
        });

        const report = await migrateSqlite(client);
        assert.deepEqual(report.applied.map((m) => m.version), [1]);

        const { rows } = await client.execute({ sql: 'SELECT name FROM projects' });
        assert.deepEqual(rows, [{ name: 'legacy' }]);
    } finally {
        client.close();
    }
});

test('migrateSqlite → rollback to 0 → migrate again: fully reversible', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client);
        const down = await rollbackSqlite(client, 0);
        assert.deepEqual(down.rolledBack.map((m) => m.version), [1]);
        assert.equal(down.version, 0);

        const after = await tableNames(client);
        assert.ok(!after.has('nodes'), 'nodes should be dropped');
        assert.ok(!after.has('projects'), 'projects should be dropped');
        assert.ok(after.has('schema_migrations'), 'bookkeeping table remains');

        const again = await migrateSqlite(client);
        assert.deepEqual(again.applied.map((m) => m.version), [1]);
        assert.ok((await tableNames(client)).has('nodes'));
    } finally {
        client.close();
    }
});

const TEST_0002: Migration = {
    version: 2,
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

test('migrateSqlite: a second migration applies and rolls back cleanly', async () => {
    const client = createClient({ url: ':memory:' });
    const list = [...migrations, TEST_0002];
    try {
        const up = await migrateSqlite(client, list);
        assert.deepEqual(up.applied.map((m) => m.version), [1, 2]);
        assert.ok((await tableNames(client)).has('flags'));

        const down = await rollbackSqlite(client, 1, list);
        assert.deepEqual(down.rolledBack.map((m) => m.version), [2]);
        assert.equal(down.version, 1);
        assert.ok(!(await tableNames(client)).has('flags'));
        assert.ok((await tableNames(client)).has('nodes'), 'baseline must survive');
    } finally {
        client.close();
    }
});

test('rollbackSqlite: unknown applied version is a hard error', async () => {
    const client = createClient({ url: ':memory:' });
    try {
        await migrateSqlite(client, [...migrations, TEST_0002]);
        // registry that no longer contains version 2
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

test('migratePostgres: fresh database — transactional up + version stamp', async () => {
    const state: PgState = { version: 0, applied: [], calls: [] };
    const report = await migratePostgres(mockPg(state) as never);

    assert.deepEqual(report.applied.map((m) => m.version), [1]);
    assert.equal(state.version, 0); // mock state unchanged — verify the SQL
    const up = state.calls.find((c) => c.startsWith('BEGIN;'));
    assert.ok(up, 'up must run in a transaction');
    assert.ok(up.includes('CREATE TABLE IF NOT EXISTS nodes'));
    assert.ok(up.includes('CREATE OR REPLACE FUNCTION ultracontext_activity'));
    assert.ok(up.includes("INSERT INTO schema_migrations (version, name) VALUES (1, 'init')"));
    assert.ok(up.trimEnd().endsWith('COMMIT;'));
    assert.equal(state.calls.filter((c) => c.startsWith('BEGIN;')).length, 1);
});

test('migratePostgres: already-current database — no DDL issued', async () => {
    const state: PgState = { version: 1, applied: [{ version: 1, name: 'init' }], calls: [] };
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
    const state: PgState = { version: 2, applied: [{ version: 2, name: 'ghost' }], calls: [] };
    await assert.rejects(() => rollbackPostgres(mockPg(state) as never, 1, migrations), /no matching migration/);
});
