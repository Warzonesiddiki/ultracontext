import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ApiKeyPublic, ProjectRow, ContextRefRow, ContextFilters, SearchFilters, SearchHit, TransactionOptions, ActivityQuery, ActivityRow } from '@ultracontext/core';
import { aggregateActivity } from '@ultracontext/core';
import type { ActivityAggregateInput } from '@ultracontext/core';

// =============================================================================
// SUPABASE ADAPTER — same interface via Supabase REST client
// =============================================================================

export class SupabaseAdapter implements StorageAdapter {
    private client: SupabaseClient;

    constructor(url: string, serviceRoleKey: string) {
        this.client = createClient(url, serviceRoleKey);
    }

    // -- nodes: queries -------------------------------------------------------

    async findNodesByContextId(contextId: string): Promise<Partial<NodeRow>[]> {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, prev_id')
            .eq('context_id', contextId);
        if (error) throw error;
        return data ?? [];
    }

    async findContextBranches(contextId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, prev_id, created_at')
            .eq('context_id', contextId)
            .eq('type', 'context');
        if (error) throw error;
        return data ?? [];
    }

    async findVersions(contextId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id, created_at, metadata')
            .eq('context_id', contextId)
            .eq('type', 'context')
            .order('created_at', { ascending: true });
        if (error) throw error;
        return data ?? [];
    }

    async findNonContextNodes(contextId: string): Promise<NodeRow[]> {
        const { data, error } = await this.client
            .from('nodes')
            .select('*')
            .eq('context_id', contextId)
            .neq('type', 'context');
        if (error) throw error;
        return (data ?? []) as NodeRow[];
    }

    async findNonContextNodesByContextIds(contextIds: string[]): Promise<NodeRow[]> {
        if (contextIds.length === 0) return [];
        const { data, error } = await this.client
            .from('nodes')
            .select('*')
            .in('context_id', contextIds)
            .neq('type', 'context');
        if (error) throw error;
        return (data ?? []) as NodeRow[];
    }

    async findRootContext(projectId: number, publicId: string) {
        const { data, error } = await this.client
            .from('nodes')
            .select('public_id')
            .eq('project_id', projectId)
            .eq('public_id', publicId)
            .eq('type', 'context')
            .is('context_id', null)
            .limit(1)
            .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        return data;
    }

    async listRootContexts(projectId: number, limit: number, filters?: ContextFilters) {
        let query = this.client
            .from('nodes')
            .select('public_id, metadata, created_at')
            .eq('project_id', projectId)
            .eq('type', 'context')
            .is('context_id', null);

        // metadata JSONB filters
        if (filters?.source) query = query.eq('metadata->>source', filters.source);
        if (filters?.user_id) query = query.eq('metadata->>user_id', filters.user_id);
        if (filters?.host) query = query.eq('metadata->>host', filters.host);
        if (filters?.project_path) query = query.eq('metadata->>project_path', filters.project_path);
        if (filters?.session_id) query = query.eq('metadata->>session_id', filters.session_id);

        // timestamp range filters
        if (filters?.after) query = query.gt('created_at', filters.after);
        if (filters?.before) query = query.lt('created_at', filters.before);

        const { data, error } = await query
            .order('created_at', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data ?? [];
    }

    // -- nodes: mutations -----------------------------------------------------

    async insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]> {
        const rows = Array.isArray(values) ? values : [values];
        const { data, error } = await this.client
            .from('nodes')
            .insert(rows)
            .select('public_id, content, metadata, created_at');
        if (error) throw error;
        return data ?? [];
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        const { error } = await this.client
            .from('nodes')
            .delete()
            .eq('project_id', projectId)
            .eq('context_id', contextId);
        if (error) throw error;
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        const { error } = await this.client
            .from('nodes')
            .delete()
            .eq('project_id', projectId)
            .eq('public_id', publicId);
        if (error) throw error;
    }

    async clearParentReferences(projectId: number, parentId: string) {
        const { error } = await this.client
            .from('nodes')
            .update({ parent_id: null })
            .eq('project_id', projectId)
            .eq('parent_id', parentId);
        if (error) throw error;
    }

    async clearParentReferencesBulk(projectId: number, parentIds: string[]) {
        if (parentIds.length === 0) return;
        const { error } = await this.client
            .from('nodes')
            .update({ parent_id: null })
            .eq('project_id', projectId)
            .in('parent_id', parentIds);
        if (error) throw error;
    }

    // -- api keys -------------------------------------------------------------

    // PostgREST has no tsvector ranking over jsonb without an RPC, so this falls
    // back to a case-insensitive match and orders by recency. Callers that need
    // ranked full-text search should use Postgres (DrizzleAdapter) or SQLite.
    async searchMessages(projectId: number, query: string, filters: SearchFilters, limit: number): Promise<SearchHit[]> {
        const needle = `%${query.replace(/[%,]/g, '')}%`;

        let rows: Array<Record<string, any>> = [];
        try {
            let request = this.client
                .from('nodes')
                .select('public_id, context_id, content, metadata, created_at')
                .eq('project_id', projectId)
                .neq('type', 'context')
                .or(`content->>message.ilike.${needle},content->>text.ilike.${needle}`);

            if (filters.source) request = request.eq('metadata->>source', filters.source);
            if (filters.user_id) request = request.eq('metadata->>user_id', filters.user_id);
            if (filters.host) request = request.eq('metadata->>host', filters.host);
            if (filters.session_id) request = request.eq('metadata->>session_id', filters.session_id);
            if (filters.project_path) request = request.eq('metadata->>project_path', filters.project_path);
            if (filters.after) request = request.gt('created_at', filters.after);
            if (filters.before) request = request.lt('created_at', filters.before);

            const { data, error } = await request
                .order('created_at', { ascending: false })
                .limit(limit);
            if (error) throw error;
            rows = (data ?? []) as Array<Record<string, any>>;
        } catch (error) {
            // PostgREST rejects the ->  operator on some deployments; surface as empty,
            // never as a 500 — search is a convenience, not a critical path.
            console.error(`searchMessages failed: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }

        // resolve root context ids for the matched branch heads
        const branchIds = [...new Set(rows.map((r) => r.context_id).filter(Boolean))];
        const rootByBranch = new Map<string, string>();
        if (branchIds.length > 0) {
            const { data: heads } = await this.client
                .from('nodes')
                .select('public_id, context_id')
                .in('public_id', branchIds)
                .eq('type', 'context');
            for (const head of heads ?? []) rootByBranch.set(head.public_id, head.context_id);
        }

        return rows.map((row) => ({
            context_id: String(rootByBranch.get(row.context_id) ?? row.context_id ?? ''),
            branch_id: String(row.context_id ?? ''),
            message_id: String(row.public_id),
            content: String(row.content?.message ?? row.content?.text ?? ''),
            metadata: (row.metadata ?? {}) as Record<string, unknown>,
            created_at: String(row.created_at ?? ''),
            rank: 0,
        }));
    }

    // -- activity / analytics -------------------------------------------------

    // Prefer the server-side rollup (ultracontext_activity, defined in
    // apps/postgres/init.sql). Deployments that have not applied the latest
    // schema fall back to a paged client-side rollup instead of failing —
    // analytics is free here, and a missing helper must never 500 the API.
    async projectActivity(projectId: number, query: ActivityQuery): Promise<ActivityRow[]> {
        try {
            const { data, error } = await this.client.rpc('ultracontext_activity', {
                p_project_id: projectId,
                p_from: query.from ?? null,
                p_to: query.to ?? null,
                p_bucket: query.bucket,
                p_source: query.source ?? null,
            });

            if (!error && Array.isArray(data)) {
                return (data as Array<Record<string, any>>).map((row) => ({
                    bucket_start: String(row.bucket_start ?? ''),
                    source: String(row.source ?? 'unknown'),
                    node_count: Number(row.node_count ?? 0),
                    message_count: Number(row.message_count ?? 0),
                    context_count: Number(row.context_count ?? 0),
                    root_context_count: Number(row.root_context_count ?? 0),
                    first_event_at: String(row.first_event_at ?? ''),
                    last_event_at: String(row.last_event_at ?? ''),
                }));
            }
        } catch {
            // no helper deployed yet — fall through to the client-side rollup
        }

        return this.aggregateActivityPaged(projectId, query);
    }

    private async aggregateActivityPaged(projectId: number, query: ActivityQuery): Promise<ActivityRow[]> {
        const PAGE = 1000;
        const MAX_ROWS = 200_000;
        const rows: Array<Record<string, any>> = [];

        for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
            let request = this.client
                .from('nodes')
                .select('created_at, type, context_id, metadata')
                .eq('project_id', projectId)
                .order('created_at', { ascending: true })
                .range(offset, offset + PAGE - 1);

            if (query.from) request = request.gte('created_at', query.from);
            if (query.to) request = request.lt('created_at', query.to);

            const { data, error } = await request;
            if (error) throw error;
            if (!data || data.length === 0) break;

            rows.push(...(data as Array<Record<string, any>>));
            if (data.length < PAGE) break;
        }

        return aggregateActivity(rows as ActivityAggregateInput[], query);
    }

    // -- api keys -------------------------------------------------------------

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
        const { data, error } = await this.client
            .from('api_keys')
            .select('id, project_id, key_hash')
            .eq('key_prefix', prefix)
            .limit(1)
            .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        return data;
    }

    async insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }) {
        const { error } = await this.client.from('api_keys').insert(values);
        if (error) throw error;
    }

    async updateApiKeyLastUsedAt(id: number, lastUsedAt: string) {
        const { error } = await this.client
            .from('api_keys')
            .update({ last_used_at: lastUsedAt })
            .eq('id', id);
        if (error) throw error;
    }

    // key lifecycle — listing never selects key_hash

    private static readonly KEY_COLUMNS = 'id, project_id, key_prefix, name, created_at, last_used_at';

    async listApiKeys(projectId: number): Promise<ApiKeyPublic[]> {
        const { data, error } = await this.client
            .from('api_keys')
            .select(SupabaseAdapter.KEY_COLUMNS)
            .eq('project_id', projectId)
            .order('id');
        if (error) throw error;
        return data as ApiKeyPublic[];
    }

    async findApiKey(id: number): Promise<ApiKeyPublic | null> {
        const { data, error } = await this.client
            .from('api_keys')
            .select(SupabaseAdapter.KEY_COLUMNS)
            .eq('id', id)
            .limit(1)
            .single();
        if (error && error.code === 'PGRST116') return null;
        if (error) throw error;
        return data as ApiKeyPublic;
    }

    // PostgREST cannot report "no rows deleted" without a representation
    // round-trip, so check existence first. Two calls for an admin-only
    // operation is an acceptable trade for an honest boolean.
    async deleteApiKey(id: number): Promise<boolean> {
        const existing = await this.findApiKey(id);
        if (!existing) return false;
        const { error } = await this.client.from('api_keys').delete().eq('id', id);
        if (error) throw error;
        return true;
    }

    // -- named branches (ARCH-001) ---------------------------------------------

    /** Branch-ref columns — `id` is a surrogate and never leaves the adapter. */
    private static readonly CONTEXT_REF_COLUMNS =
        'project_id, context_id, name, head_id, created_at, updated_at';

    // PostgREST has no upsert-that-preserves-a-column: `resolution=merge-
    // duplicates` rewrites every column in the payload, which would reset
    // created_at on a move. So: read, then update or insert. Two round-trips on
    // a rare admin path, in exchange for correct `branch -f` semantics. A
    // concurrent create loses on the UNIQUE index and surfaces as an error,
    // which is the same trade this adapter already documents for transactions.
    async findContextRefs(projectId: number, contextId: string): Promise<ContextRefRow[]> {
        const { data, error } = await this.client
            .from('context_refs')
            .select(SupabaseAdapter.CONTEXT_REF_COLUMNS)
            .eq('project_id', projectId)
            .eq('context_id', contextId)
            .order('name');
        if (error) throw error;
        return (data ?? []) as ContextRefRow[];
    }

    async upsertContextRef(values: {
        project_id: number;
        context_id: string;
        name: string;
        head_id: string;
    }): Promise<ContextRefRow> {
        const now = new Date().toISOString();
        const { data: existing, error: findError } = await this.client
            .from('context_refs')
            .select(SupabaseAdapter.CONTEXT_REF_COLUMNS)
            .eq('project_id', values.project_id)
            .eq('context_id', values.context_id)
            .eq('name', values.name)
            .limit(1)
            .maybeSingle();
        if (findError) throw findError;

        if (existing) {
            const { data, error } = await this.client
                .from('context_refs')
                .update({ head_id: values.head_id, updated_at: now })
                .eq('project_id', values.project_id)
                .eq('context_id', values.context_id)
                .eq('name', values.name)
                .select(SupabaseAdapter.CONTEXT_REF_COLUMNS)
                .single();
            if (error) throw error;
            return data as ContextRefRow;
        }

        const { data, error } = await this.client
            .from('context_refs')
            .insert({ ...values, created_at: now, updated_at: now })
            .select(SupabaseAdapter.CONTEXT_REF_COLUMNS)
            .single();
        if (error) throw error;
        return data as ContextRefRow;
    }

    async deleteContextRef(projectId: number, contextId: string, name: string): Promise<boolean> {
        // same existence-first pattern as deleteApiKey: PostgREST cannot report
        // "no rows deleted" without a representation round-trip
        const { data: existing, error: findError } = await this.client
            .from('context_refs')
            .select('name')
            .eq('project_id', projectId)
            .eq('context_id', contextId)
            .eq('name', name)
            .limit(1)
            .maybeSingle();
        if (findError) throw findError;
        if (!existing) return false;

        const { error } = await this.client
            .from('context_refs')
            .delete()
            .eq('project_id', projectId)
            .eq('context_id', contextId)
            .eq('name', name);
        if (error) throw error;
        return true;
    }

    // -- projects -------------------------------------------------------------

    async insertProject(name: string): Promise<ProjectRow | null> {
        const { data, error } = await this.client
            .from('projects')
            .insert({ name })
            .select('id')
            .single();
        if (error) throw error;
        return data;
    }

    async deleteProject(id: number) {
        const { error } = await this.client.from('projects').delete().eq('id', id);
        if (error) throw error;
    }

    async listProjects() {
        const { data, error } = await this.client.from('projects').select('id');
        if (error) throw error;
        return (data ?? []).map((row) => ({ id: Number(row.id) }));
    }

    // -- transactions ---------------------------------------------------------

    // Supabase REST (PostgREST) has no multi-statement transactions and no
    // isolation levels, so this runs inline. That is SAFE today because every
    // version write in the core ops is a SINGLE insertNodes call — one SQL
    // statement — so a version's head and children can never commit
    // separately (DATA-001). Remaining known limitation: two CONCURRENT
    // writers on the same context can both commit (each sees the other's
    // head as a sibling branch); reads degrade gracefully (versions stay
    // listed, HEAD = newest) but last-write-wins applies. The isolationLevel
    // option is accepted for API parity and intentionally ignored.
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, _options?: TransactionOptions): Promise<T> {
        return fn(this);
    }
}
