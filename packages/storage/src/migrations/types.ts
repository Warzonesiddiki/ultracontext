// =============================================================================
// MIGRATIONS — types
// =============================================================================
//
// A schema change is a Migration: an ordered, named, numbered unit with
// `up` and `down` SQL for each supported dialect. Migrations are reviewed as
// code (they live in this directory), applied once, tracked in the
// `schema_migrations` table, and reversible via `rollback*` down to any
// earlier version.
//
// Dialect note: Postgres and SQLite are different enough (JSONB vs JSON-text,
// BIGSERIAL vs AUTOINCREMENT, FTS5, views/functions) that each migration
// carries one SQL script per dialect. Keeping them side by side in a single
// file is what prevents the two schemas from drifting silently.

export type Dialect = 'postgres' | 'sqlite';

export interface Migration {
    /** 1-based, strictly increasing. Never reuse or reorder a version. */
    version: number;
    /** Short kebab-case name, stored in schema_migrations for humans. */
    name: string;
    /** SQL applied in order. Must be transactional-safe (both dialects run DDL in a tx). */
    up: Record<Dialect, string>;
    /** SQL that fully reverses `up` for this dialect. */
    down: Record<Dialect, string>;
}

export interface AppliedMigration {
    version: number;
    name: string;
    appliedAt: string;
}

export interface MigrateReport {
    /** Migrations applied by this call (empty = already at target). */
    applied: AppliedMigration[];
    /** Migrations rolled back by this call (rollback calls only). */
    rolledBack: AppliedMigration[];
    /** Version after the call. */
    version: number;
}
