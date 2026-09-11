import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';

import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ProjectRow, ContextFilters, SearchFilters, SearchHit, TransactionOptions } from '@ultracontext/core';
import { alias } from 'drizzle-orm/pg-core';

import { nodes, api_keys, projects, type ApiDb } from './db';

// =============================================================================
// DRIZZLE ADAPTER — wraps existing Drizzle/PostgreSQL queries
// =============================================================================

export class DrizzleAdapter implements StorageAdapter {
    constructor(private db: ApiDb) {}

    // -- nodes: queries -------------------------------------------------------

    async findNodesByContextId(contextId: string): Promise<Partial<NodeRow>[]> {
        return this.db
            .select({ public_id: nodes.public_id, prev_id: nodes.prev_id })
            .from(nodes)
            .where(eq(nodes.context_id, contextId));
    }

    async findContextBranches(contextId: string) {
        return this.db
            .select({ public_id: nodes.public_id, prev_id: nodes.prev_id, created_at: nodes.created_at })
            .from(nodes)
            .where(and(eq(nodes.context_id, contextId), eq(nodes.type, 'context')));
    }

    async findVersions(contextId: string) {
        return this.db
            .select({ public_id: nodes.public_id, created_at: nodes.created_at, metadata: nodes.metadata })
            .from(nodes)
            .where(and(eq(nodes.context_id, contextId), eq(nodes.type, 'context')))
            .orderBy(asc(nodes.created_at));
    }

    async findNonContextNodes(contextId: string): Promise<NodeRow[]> {
        return this.db
            .select()
            .from(nodes)
            .where(and(eq(nodes.context_id, contextId), ne(nodes.type, 'context'))) as Promise<NodeRow[]>;
    }

    async findRootContext(projectId: number, publicId: string) {
        const rows = await this.db
            .select({ public_id: nodes.public_id })
            .from(nodes)
            .where(and(eq(nodes.project_id, projectId), eq(nodes.public_id, publicId), eq(nodes.type, 'context'), isNull(nodes.context_id)))
            .limit(1);
        return rows[0] ?? null;
    }

    async findRootContextByPublicId(publicId: string) {
        const rows = await this.db
            .select({ public_id: nodes.public_id })
            .from(nodes)
            .where(and(eq(nodes.public_id, publicId), eq(nodes.type, 'context'), isNull(nodes.context_id)))
            .limit(1);
        return rows[0] ?? null;
    }

    async listRootContexts(projectId: number, limit: number, filters?: ContextFilters) {
        const conditions = [eq(nodes.project_id, projectId), eq(nodes.type, 'context'), isNull(nodes.context_id)];

        // metadata JSONB filters (uses GIN index via @> containment)
        if (filters?.source) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ source: filters.source })}::jsonb`);
        if (filters?.user_id) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ user_id: filters.user_id })}::jsonb`);
        if (filters?.host) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ host: filters.host })}::jsonb`);
        if (filters?.project_path) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ project_path: filters.project_path })}::jsonb`);
        if (filters?.session_id) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ session_id: filters.session_id })}::jsonb`);

        // timestamp range filters
        if (filters?.after) conditions.push(gt(nodes.created_at, filters.after));
        if (filters?.before) conditions.push(lt(nodes.created_at, filters.before));

        return this.db
            .select({ public_id: nodes.public_id, metadata: nodes.metadata, created_at: nodes.created_at })
            .from(nodes)
            .where(and(...conditions))
            .orderBy(desc(nodes.created_at))
            .limit(limit);
    }

    // -- nodes: mutations -----------------------------------------------------

    async insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]> {
        return this.db
            .insert(nodes)
            .values(values as any)
            .returning({
                public_id: nodes.public_id,
                content: nodes.content,
                metadata: nodes.metadata,
                created_at: nodes.created_at,
            });
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        await this.db.delete(nodes).where(and(eq(nodes.project_id, projectId), eq(nodes.context_id, contextId)));
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        await this.db.delete(nodes).where(and(eq(nodes.project_id, projectId), eq(nodes.public_id, publicId)));
    }

    async clearParentReferences(projectId: number, parentId: string) {
        await this.db
            .update(nodes)
            .set({ parent_id: null })
            .where(and(eq(nodes.project_id, projectId), eq(nodes.parent_id, parentId)));
    }

    async clearParentReferencesBulk(projectId: number, parentIds: string[]) {
        if (parentIds.length === 0) return;
        await this.db
            .update(nodes)
            .set({ parent_id: null })
            .where(and(eq(nodes.project_id, projectId), inArray(nodes.parent_id, parentIds)));
    }

    // -- api keys -------------------------------------------------------------

    async searchMessages(projectId: number, query: string, filters: SearchFilters, limit: number): Promise<SearchHit[]> {
        const heads = alias(nodes, 'heads');

        // plainto_tsquery accepts arbitrary user input without throwing on
        // tsquery syntax errors — tsquery operator injection is not possible.
        const doc = sql`to_tsvector('english', COALESCE(${nodes.content}->>'message', ${nodes.content}::text))`;
        const q = sql`plainto_tsquery('english', ${query})`;
        const rankExpr = sql<number>`-ts_rank(${doc}, ${q})`;

        const conditions = [
            eq(nodes.project_id, projectId),
            ne(nodes.type, 'context'),
            sql`${doc} @@ ${q}`,
        ];

        if (filters.source) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ source: filters.source })}::jsonb`);
        if (filters.user_id) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ user_id: filters.user_id })}::jsonb`);
        if (filters.host) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ host: filters.host })}::jsonb`);
        if (filters.session_id) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ session_id: filters.session_id })}::jsonb`);
        if (filters.project_path) conditions.push(sql`${nodes.metadata} @> ${JSON.stringify({ project_path: filters.project_path })}::jsonb`);
        if (filters.after) conditions.push(gt(nodes.created_at, filters.after));
        if (filters.before) conditions.push(lt(nodes.created_at, filters.before));

        // ts_rank is higher-is-better; negated so ascending order (bm25 convention) applies.
        const rows = await this.db
            .select({
                message_id: nodes.public_id,
                context_id: sql<string>`COALESCE(${heads.context_id}, ${nodes.context_id})`,
                branch_id: nodes.context_id,
                content: nodes.content,
                metadata: nodes.metadata,
                created_at: nodes.created_at,
                rank: rankExpr,
            })
            .from(nodes)
            .leftJoin(heads, and(eq(heads.public_id, nodes.context_id), eq(heads.type, 'context')))
            .where(and(...conditions))
            .orderBy(rankExpr)
            .limit(limit);

        return rows.map((row) => ({
            context_id: String(row.context_id ?? ''),
            branch_id: String(row.branch_id ?? ''),
            message_id: String(row.message_id),
            content: String((row.content as Record<string, unknown>)?.message ?? ''),
            metadata: (row.metadata ?? {}) as Record<string, unknown>,
            created_at: String(row.created_at ?? ''),
            rank: Number(row.rank ?? 0),
        }));
    }

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
        const rows = await this.db
            .select({ id: api_keys.id, project_id: api_keys.project_id, key_hash: api_keys.key_hash })
            .from(api_keys)
            .where(eq(api_keys.key_prefix, prefix))
            .limit(1);
        return (rows[0] as ApiKeyRow) ?? null;
    }

    async insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }) {
        await this.db.insert(api_keys).values(values);
    }

    async updateApiKeyLastUsedAt(id: number, lastUsedAt: string) {
        await this.db
            .update(api_keys)
            .set({ last_used_at: lastUsedAt })
            .where(eq(api_keys.id, id));
    }

    // -- projects -------------------------------------------------------------

    async insertProject(name: string): Promise<ProjectRow | null> {
        const rows = await this.db.insert(projects).values({ name }).returning({ id: projects.id });
        return rows[0] ?? null;
    }

    async deleteProject(id: number) {
        await this.db.delete(projects).where(eq(projects.id, id));
    }

    // -- transactions ---------------------------------------------------------

    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, options?: TransactionOptions): Promise<T> {
        const txConfig = options?.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined;
        return this.db.transaction(async (txDb) => fn(new DrizzleAdapter(txDb as ApiDb)), txConfig);
    }
}
