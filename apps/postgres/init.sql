-- =============================================================================
-- UltraContext Postgres schema — GENERATED from the migration registry.
-- Single source of truth: packages/storage/src/migrations/
-- (0001_init.ts, 0002_sqlite_constraints.ts, 0003_context_refs.ts,
-- 0004_node_ordinal.ts — the cumulative postgres.up.sql result). After changing
-- a migration, paste the cumulative result here so new Supabase deployments
-- start in sync.
--
-- New Supabase deployments run THIS file once (SQL editor / init script).
-- The schema_migrations bootstrap below stamps every version this file
-- contains (1..4) so direct Postgres/Drizzle clients (which auto-migrate on
-- connect) treat the database as current instead of re-applying DDL.
-- =============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO schema_migrations (version, name) VALUES
  (1, 'init'),
  (2, 'sqlite-unique-and-fk-cascade'),
  (3, 'context-refs-named-branches'),
  (4, 'node-ordinal-chain-order')
  ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  public_id TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  name TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS nodes (
  id BIGSERIAL PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_id TEXT,
  prev_id TEXT,
  context_id TEXT,
  -- Explicit position within the context_id partition (ARCH-002, migration
  -- 0004). The prev_id chain stays authoritative for message order; ordinal is
  -- what makes the BROKEN-chain fallback total instead of leaving it to
  -- ISO-millisecond timestamps that tie, and it lets HEAD be picked by real
  -- write order. Nullable: root contexts belong to no partition.
  ordinal BIGINT
);

CREATE INDEX IF NOT EXISTS idx_nodes_project_type_context
  ON nodes (project_id, type, context_id);

CREATE INDEX IF NOT EXISTS idx_nodes_context_ordinal
  ON nodes (context_id, ordinal);

CREATE INDEX IF NOT EXISTS idx_nodes_context
  ON nodes (context_id);

CREATE INDEX IF NOT EXISTS idx_nodes_prev
  ON nodes (prev_id);

CREATE INDEX IF NOT EXISTS idx_nodes_created_at
  ON nodes (created_at);

CREATE INDEX IF NOT EXISTS idx_nodes_metadata
  ON nodes USING GIN (metadata);

CREATE INDEX IF NOT EXISTS idx_api_keys_project_id
  ON api_keys (project_id);

-- Named branches (ARCH-001, migration 0003): a project-scoped name pinned to an
-- immutable version head id, so a saved reference keeps meaning the same thing
-- as the chain grows. head_id has NO foreign key by design — the version node it
-- points at can be deleted later, and an orphaned name is tolerated (readers
-- report version -1) instead of cascading someone's branch away.
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

CREATE OR REPLACE VIEW project_activity_daily
  WITH (security_invoker = on) AS
WITH node_activity AS (
  SELECT
    n.project_id,
    p.name AS project_name,
    DATE_TRUNC('day', n.created_at) AS activity_day,
    COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown') AS source,
    COUNT(*) AS node_count,
    COUNT(*) FILTER (WHERE n.type <> 'context') AS message_count,
    COUNT(*) FILTER (WHERE n.type = 'context') AS context_count,
    COUNT(*) FILTER (WHERE n.type = 'context' AND n.context_id IS NULL) AS root_context_count,
    MIN(n.created_at) AS first_event_at,
    MAX(n.created_at) AS last_event_at
  FROM nodes n
  JOIN projects p ON p.id = n.project_id
  GROUP BY
    n.project_id,
    p.name,
    DATE_TRUNC('day', n.created_at),
    COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown')
)
SELECT
  na.project_id,
  na.project_name,
  na.activity_day,
  na.source,
  na.node_count,
  na.message_count,
  na.context_count,
  na.root_context_count,
  na.first_event_at,
  na.last_event_at,
  MAX(ak.last_used_at) AS latest_api_key_last_used_at,
  COUNT(DISTINCT ak.id) FILTER (WHERE ak.last_used_at IS NOT NULL) AS active_api_keys
FROM node_activity na
LEFT JOIN api_keys ak ON ak.project_id = na.project_id
GROUP BY
  na.project_id,
  na.project_name,
  na.activity_day,
  na.source,
  na.node_count,
  na.message_count,
  na.context_count,
  na.root_context_count,
  na.first_event_at,
  na.last_event_at;

CREATE OR REPLACE VIEW project_activity_weekly
  WITH (security_invoker = on) AS
SELECT
  project_id,
  project_name,
  DATE_TRUNC('week', activity_day) AS activity_week,
  source,
  COUNT(*) AS active_days,
  SUM(node_count) AS node_count,
  SUM(message_count) AS message_count,
  SUM(context_count) AS context_count,
  SUM(root_context_count) AS root_context_count,
  MIN(first_event_at) AS first_event_at,
  MAX(last_event_at) AS last_event_at,
  MAX(latest_api_key_last_used_at) AS latest_api_key_last_used_at,
  MAX(active_api_keys) AS active_api_keys
FROM project_activity_daily
GROUP BY
  project_id,
  project_name,
  DATE_TRUNC('week', activity_day),
  source;

-- Free, self-hosted analytics rollup. Called by the Supabase adapter via RPC;
-- the Postgres/Drizzle adapter issues the equivalent inline. Buckets are UTC so
-- a self-hosted instance anywhere reports the same day boundaries as the client
-- that wrote the data, and weeks start on Monday everywhere.
CREATE OR REPLACE FUNCTION ultracontext_activity(
    p_project_id BIGINT,
    p_from TIMESTAMPTZ DEFAULT NULL,
    p_to TIMESTAMPTZ DEFAULT NULL,
    p_bucket TEXT DEFAULT 'day',
    p_source TEXT DEFAULT NULL
)
RETURNS TABLE (
    bucket_start TEXT,
    source TEXT,
    node_count BIGINT,
    message_count BIGINT,
    context_count BIGINT,
    root_context_count BIGINT,
    first_event_at TEXT,
    last_event_at TEXT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
    WITH scoped AS (
        SELECT
            n.created_at,
            n.type,
            n.context_id,
            COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown') AS source
        FROM nodes n
        WHERE n.project_id = p_project_id
          AND (p_from IS NULL OR n.created_at >= p_from)
          AND (p_to   IS NULL OR n.created_at <  p_to)
          AND (p_source IS NULL OR COALESCE(NULLIF(n.metadata->>'source', ''), 'unknown') = p_source)
    )
    SELECT
        to_char(
            date_trunc(
                CASE WHEN p_bucket IN ('week', 'month') THEN p_bucket ELSE 'day' END,
                created_at AT TIME ZONE 'UTC'
            ),
            'YYYY-MM-DD'
        ) AS bucket_start,
        source,
        COUNT(*) AS node_count,
        COUNT(*) FILTER (WHERE type <> 'context') AS message_count,
        COUNT(*) FILTER (WHERE type = 'context') AS context_count,
        COUNT(*) FILTER (WHERE type = 'context' AND context_id IS NULL) AS root_context_count,
        to_char(MIN(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_event_at,
        to_char(MAX(created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_event_at
    FROM scoped
    GROUP BY 1, 2
    ORDER BY 1, 2;
$$;
