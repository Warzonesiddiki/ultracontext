// =============================================================================
// MIGRATION 0003 — context_refs: named branches (ARCH-001)
// =============================================================================
//
// Versions used to be addressable ONLY by positional index, and indices shift
// every time a new version lands — so a `?version=3` saved in a script, a
// bookmark or a pointer kept silently changing meaning. `findHead` compounded
// it by picking "newest by created_at" among forks, which ties on ISO-ms
// stamps.
//
// context_refs pins a human-chosen NAME to an IMMUTABLE version head id. The
// name is what callers remember; the id never moves, never gets reused, and
// keeps resolving to the same state no matter how much the chain grows.
//
// Design decisions worth knowing before you edit this:
//
//   1. head_id has NO foreign key, deliberately. The version node it points at
//      can legitimately disappear later (permanent delete, pruning), and a
//      branch name outliving its target is tolerable: readers report
//      `version: -1` for an orphaned pin instead of the write failing, or a
//      FK cascade silently unpinning someone's branch. An FK here would also
//      make the append path depend on the refs table for no benefit.
//
//   2. UNIQUE(project_id, context_id, name) — not UNIQUE(context_id, name).
//      Tenancy is part of the key, so two projects can each have a `main`
//      without colliding, and the constraint doubles as the upsert target
//      (`branch -f` semantics) on both dialects.
//
//   3. project_id DOES cascade from projects: branch names are tenant data, so
//      dropping a project must not leave its pointers behind.
//
//   4. created_at / updated_at are separate. Moving a name preserves
//      created_at and bumps updated_at, so "when was this branch made" and
//      "when did it last move" stay independently answerable.
//
// Both dialects are additive and idempotent (IF NOT EXISTS), so a database
// bootstrapped from apps/postgres/init.sql or the compatibility SCHEMA_SQL —
// which now carry the same DDL — migrates cleanly and simply stamps version 3.

import type { Migration } from './types';

const POSTGRES_UP = `
CREATE TABLE IF NOT EXISTS context_refs (
    id BIGSERIAL PRIMARY KEY,
    project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    context_id TEXT NOT NULL,
    name TEXT NOT NULL,
    head_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_context_refs_project_context_name
    ON context_refs (project_id, context_id, name);

CREATE INDEX IF NOT EXISTS idx_context_refs_context
    ON context_refs (context_id);
`;

const POSTGRES_DOWN = `
DROP INDEX IF EXISTS idx_context_refs_context;
DROP INDEX IF EXISTS uq_context_refs_project_context_name;
DROP TABLE IF EXISTS context_refs;
`;

const SQLITE_UP = `
CREATE TABLE IF NOT EXISTS context_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    context_id TEXT NOT NULL,
    name TEXT NOT NULL,
    head_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_context_refs_project_context_name
    ON context_refs (project_id, context_id, name);

CREATE INDEX IF NOT EXISTS idx_context_refs_context
    ON context_refs (context_id);
`;

const SQLITE_DOWN = `
DROP INDEX IF EXISTS idx_context_refs_context;
DROP INDEX IF EXISTS uq_context_refs_project_context_name;
DROP TABLE IF EXISTS context_refs;
`;

export const contextRefsMigration: Migration = {
    version: 3,
    name: 'context-refs-named-branches',
    up: {
        postgres: POSTGRES_UP,
        sqlite: SQLITE_UP,
    },
    down: {
        postgres: POSTGRES_DOWN,
        sqlite: SQLITE_DOWN,
    },
};
