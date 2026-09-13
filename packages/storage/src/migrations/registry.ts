// =============================================================================
// MIGRATIONS — registry
// =============================================================================
//
// Add a schema change by creating a new numbered module (0002_*, 0003_*, …)
// with up + down SQL for BOTH dialects, then appending it here. Versions are
// immutable: never edit, reorder, or delete a migration that may have been
// applied anywhere — add a new one instead.

import { initMigration } from './0001_init';
import { sqliteConstraintsMigration } from './0002_sqlite_constraints';
import type { Migration } from './types';

export const migrations: Migration[] = [
    // ── append new migrations below, in version order ────────────────────
    initMigration,
    sqliteConstraintsMigration,
];

export function validateRegistry(list: Migration[]): void {
    let previous = 0;
    for (const m of list) {
        if (m.version <= previous) {
            throw new Error(`migrations must be strictly increasing: ${m.version} after ${previous}`);
        }
        if (!m.name?.trim()) throw new Error(`migration ${m.version} is missing a name`);
        for (const dialect of ['postgres', 'sqlite'] as const) {
            if (!m.up[dialect]?.trim()) throw new Error(`migration ${m.version} (${m.name}) is missing up.${dialect}`);
            if (!m.down[dialect]?.trim()) throw new Error(`migration ${m.version} (${m.name}) is missing down.${dialect}`);
        }
        previous = m.version;
    }
}
