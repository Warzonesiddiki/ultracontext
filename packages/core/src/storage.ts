// =============================================================================
// STORAGE ADAPTER — abstracts all DB operations behind a common interface
// =============================================================================

// -- Row types (DB-agnostic) --------------------------------------------------

export type NodeRow = {
    id: number;
    public_id: string;
    project_id: number;
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    created_at: string;
    parent_id: string | null;
    prev_id: string | null;
    context_id: string | null;
};

export type NodeInsertRow = {
    public_id: string;
    project_id: number;
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    context_id?: string | null;
    parent_id?: string | null;
    prev_id?: string | null;
    /**
     * ISO 8601 timestamp to store verbatim. Omit for "now".
     * Used by import/restore so a restored context keeps its original
     * chronology instead of being re-stamped at restore time.
     */
    created_at?: string;
};

export type ApiKeyRow = {
    id: number;
    project_id: number;
    key_hash: string;
};

export type ProjectRow = {
    id: number;
};

// -- Metadata filters for listing contexts ------------------------------------

export type ContextFilters = {
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
};

// -- Full-text search ---------------------------------------------------------

export type SearchFilters = {
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
};

// A single search hit. `context_id` is the ROOT context the message belongs to
// (what a caller passes to GET /contexts/:id); `branch_id` is the version head
// the message actually lives under. They differ once a context has been edited.
export type SearchHit = {
    context_id: string;
    branch_id: string;
    message_id: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
    rank: number;
};

// -- Activity / analytics -----------------------------------------------------
// Free, self-hosted analytics. The commercial tier sells "analytics" and gates
// "unlimited analytics" behind Pro — here it is computed from your own database
// on demand, with no sampling, no retention cap and no quota.

export type ActivityBucket = 'day' | 'week' | 'month';

export type ActivityQuery = {
    bucket: ActivityBucket;
    /** inclusive lower bound (ISO 8601) */
    from?: string;
    /** exclusive upper bound (ISO 8601) */
    to?: string;
    source?: string;
};

// One (bucket × source) rollup row. `bucket_start` is always a UTC calendar date
// formatted 'YYYY-MM-DD' — the first day of the week for `week`, the first day of
// the month for `month`.
export type ActivityRow = {
    bucket_start: string;
    source: string;
    node_count: number;
    message_count: number;
    context_count: number;
    root_context_count: number;
    first_event_at: string;
    last_event_at: string;
};

// -- Storage adapter interface ------------------------------------------------

export interface StorageAdapter {
    // nodes — queries
    findNodesByContextId(contextId: string, columns?: (keyof NodeRow)[]): Promise<Partial<NodeRow>[]>;
    findContextBranches(contextId: string): Promise<Pick<NodeRow, 'public_id' | 'prev_id' | 'created_at'>[]>;
    findVersions(contextId: string): Promise<Pick<NodeRow, 'public_id' | 'created_at' | 'metadata'>[]>;
    findNonContextNodes(contextId: string): Promise<NodeRow[]>;
    /**
     * All non-context nodes whose context_id is one of the given ids (batch
     * form of findNonContextNodes). Used to read a version's cumulative
     * message chain across append heads (PROM-002).
     */
    findNonContextNodesByContextIds(contextIds: string[]): Promise<NodeRow[]>;
    /**
     * Resolve a ROOT context. MUST be project-scoped — an unscoped lookup here
     * is a cross-tenant read (see SEC-001).
     */
    findRootContext(projectId: number, publicId: string): Promise<Pick<NodeRow, 'public_id'> | null>;
    listRootContexts(projectId: number, limit: number, filters?: ContextFilters): Promise<Pick<NodeRow, 'public_id' | 'metadata' | 'created_at'>[]>;

    // nodes — mutations
    insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]>;
    deleteNodesByContextId(projectId: number, contextId: string): Promise<void>;
    deleteNodeByPublicId(projectId: number, publicId: string): Promise<void>;
    clearParentReferences(projectId: number, parentId: string): Promise<void>;
    // batch-clear parent_id for all nodes whose parent_id is any of parentIds (single query)
    clearParentReferencesBulk(projectId: number, parentIds: string[]): Promise<void>;

    // full-text search — ranked matches across a project's message nodes.
    // Adapters use the best mechanism available (FTS5 / tsvector / ILIKE) and
    // MUST return [] for an empty query rather than throwing.
    searchMessages(projectId: number, query: string, filters: SearchFilters, limit: number): Promise<SearchHit[]>;

    // api keys
    findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
    insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }): Promise<void>;
    updateApiKeyLastUsedAt(id: number, lastUsedAt: string): Promise<void>;

    // activity / analytics — server-side rollup of a project's write traffic.
    // Adapters aggregate in the database where possible; never throws for an
    // empty project (returns []).
    projectActivity(projectId: number, query: ActivityQuery): Promise<ActivityRow[]>;

    // projects
    insertProject(name: string): Promise<ProjectRow | null>;
    deleteProject(id: number): Promise<void>;

    // transactions — adapter-specific atomicity (tx on Drizzle, no-op on Supabase REST)
    transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, options?: TransactionOptions): Promise<T>;
}

export type TransactionOptions = {
    // 'serializable' turns on Postgres SSI — concurrent conflicting txs get
    // a 40001 error, letting client retry. Required for append-vs-permanent-delete safety.
    isolationLevel?: 'serializable';
};
