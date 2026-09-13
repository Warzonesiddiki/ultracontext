// =============================================================================
// MIGRATIONS — SQLite runner (libsql)
// =============================================================================
//
// Each migration runs inside a single transaction (SQLite DDL is
// transactional), so a crash mid-migration either fully applied or fully
// rolled back. The version stamp and the schema change commit together.

import type { Client as LibsqlClient } from '@libsql/client';

import { migrations as allMigrations } from './registry';
import type { AppliedMigration, MigrateReport, Migration } from './types';

const BOOKKEEPING_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);`;

async function currentVersion(client: LibsqlClient): Promise<number> {
    const { rows } = await client.execute({
        sql: 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations',
    });
    return Number(rows[0]?.v ?? 0);
}

async function appliedVersions(client: LibsqlClient): Promise<Map<number, string>> {
    const { rows } = await client.execute({
        sql: 'SELECT version, name FROM schema_migrations ORDER BY version DESC',
    });
    const map = new Map<number, string>();
    for (const row of rows) map.set(Number(row.version), String(row.name));
    return map;
}

async function applyUp(client: LibsqlClient, m: Migration): Promise<void> {
    await client.executeMultiple(
        `BEGIN;\n${BOOKKEEPING_DDL}\n${m.up.sqlite}\nINSERT INTO schema_migrations (version, name, applied_at) VALUES (${m.version}, '${m.name}', datetime('now'));\nCOMMIT;`,
    );
}

async function applyDown(client: LibsqlClient, m: Migration): Promise<void> {
    await client.executeMultiple(
        `BEGIN;\n${m.down.sqlite}\nDELETE FROM schema_migrations WHERE version = ${m.version};\nCOMMIT;`,
    );
}

/**
 * Apply pending migrations (in order) to a SQLite database.
 * Idempotent: a database already at the latest version is left untouched.
 * Safe on legacy databases (bootstrapped by the old SCHEMA_SQL): the
 * baseline migration is fully idempotent and simply stamps version 1.
 */
export async function migrateSqlite(
    client: LibsqlClient,
    list: Migration[] = allMigrations,
): Promise<MigrateReport> {
    for (const m of list) {
        if (!m.up.sqlite) throw new Error(`migration ${m.version} has no sqlite up SQL`);
    }

    // bookkeeping table may not exist on a first-ever database
    await client.executeMultiple(BOOKKEEPING_DDL);
    const current = await currentVersion(client);
    const applied: AppliedMigration[] = [];

    for (const m of [...list].sort((a, b) => a.version - b.version)) {
        if (m.version <= current) continue;
        await applyUp(client, m);
        applied.push({ version: m.version, name: m.name, appliedAt: new Date().toISOString() });
    }

    return { applied, rolledBack: [], version: applied.length > 0 ? applied[applied.length - 1].version : current };
}

/**
 * Roll back applied migrations down to (and including) `toVersion` —
 * i.e. the database ends at the schema of version `toVersion` (0 = empty).
 */
export async function rollbackSqlite(
    client: LibsqlClient,
    toVersion: number,
    list: Migration[] = allMigrations,
): Promise<MigrateReport> {
    await client.executeMultiple(BOOKKEEPING_DDL);
    const byVersion = new Map(list.map((m) => [m.version, m]));
    const applied = await appliedVersions(client);
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
        await applyDown(client, m);
        rolledBack.push({ version, name, appliedAt: new Date().toISOString() });
    }

    return {
        applied: [],
        rolledBack,
        version: rolledBack.length > 0 ? toVersion : (await currentVersion(client)),
    };
}
