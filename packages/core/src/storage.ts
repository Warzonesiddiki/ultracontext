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

// -- Storage adapter interface ------------------------------------------------

export interface StorageAdapter {
    // nodes — queries
    findNodesByContextId(contextId: string, columns?: (keyof NodeRow)[]): Promise<Partial<NodeRow>[]>;
    findContextBranches(contextId: string): Promise<Pick<NodeRow, 'public_id' | 'prev_id' | 'created_at'>[]>;
    findVersions(contextId: string): Promise<Pick<NodeRow, 'public_id' | 'created_at' | 'metadata'>[]>;
    findNonContextNodes(contextId: string): Promise<NodeRow[]>;
    findRootContext(projectId: number, publicId: string): Promise<Pick<NodeRow, 'public_id'> | null>;
    findRootContextByPublicId(publicId: string): Promise<Pick<NodeRow, 'public_id'> | null>;
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
