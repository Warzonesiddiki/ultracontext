// =============================================================================
// MIGRATION 0004 — nodes.ordinal: an explicit position beside prev_id (ARCH-002)
// =============================================================================
//
// Message order inside a version is a linked list walked through `prev_id`.
// When that walk comes up short — a crashed legacy write, a hand-edited
// database, a partially restored export — ordering fell back to `created_at`,
// and `created_at` is not enough: stamps are ISO-millisecond, a batch append
// writes several nodes inside the SAME millisecond, and ties were then broken by
// whatever order storage happened to return rows. The same read of the same
// data could come back in a different order. It also logged one console.error
// and told nobody.
//
// `ordinal` is the explicit position of a node within its `context_id`
// partition (0-based, assigned in write order by the same insert that writes
// `prev_id`). With it the fallback order is TOTAL — ordinal, then created_at,
// then the unique public_id — so ordering is deterministic even when every
// timestamp in the partition is identical, and `findHead` can pick the newest
// version head by real write order instead of by timestamp tiebreak.
//
// Design decisions worth knowing before you edit this:
//
//   1. NULLABLE, and null means "written before this migration". Root context
//      nodes have context_id NULL — they belong to no partition and never get
//      an ordinal. Readers must therefore treat a missing ordinal as
//      "sorts last", never as 0.
//
//   2. The backfill ranks by (created_at, id), which IS the write order for
//      every path this product has: ids are monotonic per insert and created_at
//      is stamped at insert, so the pair reproduces the chain order even when
//      timestamps tie. Rows are NOT re-linked — `prev_id` stays authoritative
//      and the chain walk still wins whenever it is intact.
//
//   3. The ranking subquery deliberately references only immutable columns
//      (context_id, created_at, id). Referencing `ordinal` inside an UPDATE
//      that is itself setting `ordinal` makes the result depend on whether the
//      engine sees its own uncommitted writes, and Postgres and SQLite differ
//      there. As written, both dialects compute the same numbers.
//
//   4. SQLite gets a table REBUILD, not ALTER TABLE ADD COLUMN. SQLite has no
//      `ADD COLUMN IF NOT EXISTS`, and this migration must also run cleanly on
//      a database bootstrapped from SCHEMA_SQL — which already carries the
//      column — because migrations.test.ts does exactly that. A rebuild lands
//      the same final shape from either starting point (the procedure 0002
//      established for this very table). Ordinals are recomputed rather than
//      copied, since the copy column list cannot reference a column that may
//      not exist in the source; recomputation is deterministic and yields the
//      values the write path would have assigned.
//
//   5. `idx_nodes_context_ordinal` backs the two queries this column exists
//      for: MAX(ordinal) per partition on write (nextOrdinal) and partition
//      reads ordered by position.

import type { Migration } from './types';

// Identical on both dialects: rank each node inside its partition by write
// order. Only immutable columns are referenced (see note 3).
const BACKFILL = `
UPDATE nodes SET ordinal = (
    SELECT COUNT(*) FROM nodes earlier
    WHERE earlier.context_id = nodes.context_id
      AND (earlier.created_at < nodes.created_at
           OR (earlier.created_at = nodes.created_at AND earlier.id < nodes.id))
)
WHERE nodes.context_id IS NOT NULL AND nodes.ordinal IS NULL;
`;

const POSTGRES_UP = `
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS ordinal BIGINT;
${BACKFILL}
CREATE INDEX IF NOT EXISTS idx_nodes_context_ordinal ON nodes (context_id, ordinal);
`;

const POSTGRES_DOWN = `
DROP INDEX IF EXISTS idx_nodes_context_ordinal;
ALTER TABLE nodes DROP COLUMN IF EXISTS ordinal;
`;

const SQLITE_UP = `
DROP INDEX IF EXISTS idx_nodes_context_ordinal;

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
    context_id TEXT,
    ordinal INTEGER
);
-- the column list omits ordinal on purpose: nodes_old may or may not have it
-- (migrated database vs SCHEMA_SQL bootstrap), and the backfill below assigns
-- every value deterministically either way.
INSERT INTO nodes (id, public_id, project_id, type, content, metadata, created_at, parent_id, prev_id, context_id)
    SELECT id, public_id, project_id, type, content, metadata, created_at, parent_id, prev_id, context_id
    FROM nodes_old;
DROP TABLE nodes_old;

CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_public_id ON nodes(public_id);
CREATE INDEX IF NOT EXISTS idx_nodes_context_ordinal ON nodes(context_id, ordinal);
${BACKFILL}
`;

const SQLITE_DOWN = `
DROP INDEX IF EXISTS idx_nodes_context_ordinal;

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

export const nodeOrdinalMigration: Migration = {
    version: 4,
    name: 'node-ordinal-chain-order',
    up: {
        postgres: POSTGRES_UP,
        sqlite: SQLITE_UP,
    },
    down: {
        postgres: POSTGRES_DOWN,
        sqlite: SQLITE_DOWN,
    },
};
