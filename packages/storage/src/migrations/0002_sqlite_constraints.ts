// =============================================================================
// MIGRATION 0002 — SQLite parity with Postgres: UNIQUE + FK cascade
// =============================================================================
//
// Postgres (migration 0001) already declares nodes.public_id UNIQUE,
// api_keys.key_prefix UNIQUE, and ON DELETE CASCADE from projects. SQLite
// never got either — a duplicate key_prefix could silently route one key's
// traffic to a different project, and deleting a project orphaned its keys
// and nodes forever (PRAGMA foreign_keys defaults to OFF).
//
// SQLite cannot ALTER TABLE ADD CONSTRAINT / ADD FOREIGN KEY, so this
// migration rebuilds both tables in place (standard rename → create → copy →
// drop procedure, inside the runner's single transaction). Two things happen
// first:
//
//   1. Orphan rows (created while foreign_keys was OFF) are deleted — they
//      reference projects that no longer exist, exactly what CASCADE would
//      have removed at the time.
//   2. The UNIQUE indexes are created AFTER the rebuild, because an index
//      follows its table through RENAME and dies with DROP TABLE.
//
// If a legacy database contains genuine duplicate public_id / key_prefix
// values, CREATE UNIQUE INDEX fails and the whole migration rolls back —
// that is the corruption the board wants surfaced, not papered over.
//
// Postgres needs no change: 0001 already carries both constraints.

import type { Migration } from './types';

const POSTGRES_UP = `
-- No-op: nodes.public_id UNIQUE, api_keys.key_prefix UNIQUE and
-- REFERENCES projects(id) ON DELETE CASCADE have existed since 0001.
`;

const POSTGRES_DOWN = `
-- No-op: nothing was added on Postgres by this migration.
`;

const SQLITE_UP = `
-- orphan cleanup (no-op on databases that were never without cascade)
DELETE FROM api_keys WHERE project_id NOT IN (SELECT id FROM projects);
DELETE FROM nodes WHERE project_id NOT IN (SELECT id FROM projects);

-- rebuild api_keys with the FK (index is created after the rename/drop)
ALTER TABLE api_keys RENAME TO api_keys_old;
CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);
INSERT INTO api_keys (id, project_id, key_prefix, key_hash, name, last_used_at, created_at)
    SELECT id, project_id, key_prefix, key_hash, name, last_used_at, created_at
    FROM api_keys_old;
DROP TABLE api_keys_old;
CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);

-- rebuild nodes with the FK (the two baseline indexes die with the old table)
ALTER TABLE nodes RENAME TO nodes_old;
CREATE TABLE nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    parent_id TEXT,
    prev_id TEXT,
    context_id TEXT
);
INSERT INTO nodes (id, public_id, project_id, type, content, metadata, created_at, parent_id, prev_id, context_id)
    SELECT id, public_id, project_id, type, content, metadata, created_at, parent_id, prev_id, context_id
    FROM nodes_old;
DROP TABLE nodes_old;
CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_public_id ON nodes(public_id);
`;

const SQLITE_DOWN = `
-- drop the unique indexes first (they would block the rebuild)
DROP INDEX IF EXISTS idx_nodes_public_id;
DROP INDEX IF EXISTS idx_api_keys_key_prefix;

-- rebuild api_keys without the FK
ALTER TABLE api_keys RENAME TO api_keys_old;
CREATE TABLE api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);
INSERT INTO api_keys (id, project_id, key_prefix, key_hash, name, last_used_at, created_at)
    SELECT id, project_id, key_prefix, key_hash, name, last_used_at, created_at
    FROM api_keys_old;
DROP TABLE api_keys_old;
CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);

-- rebuild nodes without the FK
ALTER TABLE nodes RENAME TO nodes_old;
CREATE TABLE nodes (
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
INSERT INTO nodes (id, public_id, project_id, type, content, metadata, created_at, parent_id, prev_id, context_id)
    SELECT id, public_id, project_id, type, content, metadata, created_at, parent_id, prev_id, context_id
    FROM nodes_old;
DROP TABLE nodes_old;
CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type);
`;

export const sqliteConstraintsMigration: Migration = {
    version: 2,
    name: 'sqlite-unique-and-fk-cascade',
    up: {
        postgres: POSTGRES_UP,
        sqlite: SQLITE_UP,
    },
    down: {
        postgres: POSTGRES_DOWN,
        sqlite: SQLITE_DOWN,
    },
};
