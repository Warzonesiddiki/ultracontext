// =============================================================================
// MIGRATIONS — Postgres runner (postgres-js)
// =============================================================================
//
// Same contract as the SQLite runner: each migration runs inside a single
// transaction (Postgres DDL is transactional), version stamp and schema
// change commit together, and a crash mid-migration cannot leave a half
// applied migration.
//
// Note: the Supabase REST adapter cannot execute DDL through PostgREST, so
// Supabase deployments pick up migrations via apps/postgres/init.sql (kept in
// sync with this registry). This runner serves the direct Postgres/Drizzle
// path (DATABASE_PROVIDER=postgres), which auto-migrates on connection.

import type { Sql } from 'postgres';

import { migrations as allMigrations } from './registry';
import type { AppliedMigration, MigrateReport, Migration } from './types';

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`;

type Row = Record<string, unknown>;

async function currentVersion(sql: Sql): Promise<number> {
    const rows = (await sql.unsafe('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations')) as unknown as Row[];
    return Number(rows[0]?.v ?? 0);
}

async function appliedVersions(sql: Sql): Promise<Map<number, string>> {
    const rows = (await sql.unsafe('SELECT version, name FROM schema_migrations ORDER BY version DESC')) as unknown as Row[];
    const map = new Map<number, string>();
    for (const row of rows) map.set(Number(row.version), String(row.name));
    return map;
}

async function applyUp(sql: Sql, m: Migration): Promise<void> {
    await sql.unsafe(
        `BEGIN;\n${BOOKKEEPING_DDL}\n${m.up.postgres}\nINSERT INTO schema_migrations (version, name) VALUES (${m.version}, '${m.name}');\nCOMMIT;`,
    );
}

async function applyDown(sql: Sql, m: Migration): Promise<void> {
    await sql.unsafe(
        `BEGIN;\n${m.down.postgres}\nDELETE FROM schema_migrations WHERE version = ${m.version};\nCOMMIT;`,
    );
}

/**
 * Apply pending migrations (in order) to a Postgres database.
 * Idempotent and safe on legacy databases: the baseline migration is fully
 * idempotent (IF NOT EXISTS / CREATE OR REPLACE), so a database created from
 * an older init.sql simply gets stamped version 1.
 */
export async function migratePostgres(
    sql: Sql,
    list: Migration[] = allMigrations,
): Promise<MigrateReport> {
    for (const m of list) {
        if (!m.up.postgres) throw new Error(`migration ${m.version} has no postgres up SQL`);
    }

    await sql.unsafe(BOOKKEEPING_DDL);
    const current = await currentVersion(sql);
    const applied: AppliedMigration[] = [];

    for (const m of [...list].sort((a, b) => a.version - b.version)) {
        if (m.version <= current) continue;
        await applyUp(sql, m);
        applied.push({ version: m.version, name: m.name, appliedAt: new Date().toISOString() });
    }

    return { applied, rolledBack: [], version: applied.length > 0 ? applied[applied.length - 1].version : current };
}

/**
 * Roll back applied migrations down to (and including) `toVersion`
 * (0 = empty). Same guard as the SQLite runner: a version applied on a
 * database but missing from the registry is a hard error.
 */
export async function rollbackPostgres(
    sql: Sql,
    toVersion: number,
    list: Migration[] = allMigrations,
): Promise<MigrateReport> {
    await sql.unsafe(BOOKKEEPING_DDL);
    const byVersion = new Map(list.map((m) => [m.version, m]));
    const applied = await appliedVersions(sql);
    const rolledBack: AppliedMigration[] = [];

    for (const [version, name] of [...applied.entries()].sort((a, b) => b[0] - a[0])) {
        if (version <= toVersion) break;
        const m = byVersion.get(version);
        if (!m) {
            throw new Error(
                `cannot roll back version ${version} (${name}): no matching migration in the registry ` +
                `— do not delete or renumber migrations that may have been applied`,
            );
        }
        await applyDown(sql, m);
        rolledBack.push({ version, name, appliedAt: new Date().toISOString() });
    }

    return {
        applied: [],
        rolledBack,
        version: rolledBack.length > 0 ? toVersion : (await currentVersion(sql)),
    };
}
