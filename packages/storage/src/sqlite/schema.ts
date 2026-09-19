import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

// =============================================================================
// SQLITE SCHEMA — local-first mirror of the Postgres schema (apps/postgres)
// JSONB → text json mode · bigserial → integer autoincrement · timestamptz → ISO text
// =============================================================================

const isoNow = () => new Date().toISOString();

export const projects = sqliteTable('projects', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
    public_id: text('public_id'),
});

export const api_keys = sqliteTable('api_keys', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    project_id: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    key_prefix: text('key_prefix').notNull().unique(),
    key_hash: text('key_hash').notNull(),
    name: text('name'),
    last_used_at: text('last_used_at'),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
});

export const nodes = sqliteTable('nodes', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    public_id: text('public_id').notNull().unique(),
    project_id: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    content: text('content', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull().$defaultFn(() => ({})),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
    parent_id: text('parent_id'),
    prev_id: text('prev_id'),
    context_id: text('context_id'),
    // explicit position within the context_id partition (ARCH-002, migration
    // 0004). Nullable: root contexts belong to no partition, and rows written
    // before 0004 have none until it is backfilled.
    ordinal: integer('ordinal'),
});

export const context_refs = sqliteTable('context_refs', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    project_id: integer('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    context_id: text('context_id').notNull(),
    name: text('name').notNull(),
    // no FK by design (ARCH-001): the pinned version node can be deleted later
    head_id: text('head_id').notNull(),
    created_at: text('created_at').notNull().$defaultFn(isoNow),
    updated_at: text('updated_at').notNull().$defaultFn(isoNow),
});

export const schema = { projects, api_keys, nodes, context_refs };

// DDL applied on first open — superseded by the migration tooling
// (../migrations/0001_init.ts + 0002 + 0003 + 0004 are the canonical
// baseline). Kept as an export for compatibility; new code should go through
// migrateSqlite(). Matches the post-0004 database: UNIQUE constraints, FK ON
// DELETE CASCADE (callers must run PRAGMA foreign_keys = ON for the cascade to
// apply), the context_refs named-branch table, and nodes.ordinal with the same
// index names the migrations use so a bootstrapped database and a migrated one
// are indistinguishable.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    public_id TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key_prefix TEXT NOT NULL UNIQUE,
    key_hash TEXT NOT NULL,
    name TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id TEXT NOT NULL UNIQUE,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    parent_id TEXT,
    prev_id TEXT,
    context_id TEXT,
    -- explicit position within the context_id partition (ARCH-002, migration
    -- 0004): makes the broken-chain fallback order total instead of leaving it
    -- to ISO-millisecond timestamps that tie.
    ordinal INTEGER
);
CREATE INDEX IF NOT EXISTS idx_nodes_context_id ON nodes(context_id);
CREATE INDEX IF NOT EXISTS idx_nodes_project_type ON nodes(project_id, type);
CREATE INDEX IF NOT EXISTS idx_nodes_context_ordinal ON nodes(context_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);

-- Named branches (ARCH-001, migration 0003): a project-scoped name pinned to
-- an immutable version head id. head_id has no FK by design — the target
-- version node can be deleted later and an orphaned name is tolerated.
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
    ON context_refs(project_id, context_id, name);
CREATE INDEX IF NOT EXISTS idx_context_refs_context ON context_refs(context_id);

-- Full-text search index over message nodes (not version heads).
-- Search is a free, first-class capability — there is no quota and no paywall.
-- UNINDEXED columns are stored but not tokenised: they are only used for filtering.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    public_id UNINDEXED,
    project_id UNINDEXED,
    context_id UNINDEXED,
    body,
    tokenize = 'porter unicode61'
);
`;
