import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';

import type { StorageAdapter, NodeRow, NodeInsertRow, ApiKeyRow, ProjectRow, ContextFilters, SearchFilters, SearchHit, TransactionOptions } from '@ultracontext/core';
import { searchableText } from '@ultracontext/core';
import { schema, nodes, api_keys, projects, SCHEMA_SQL } from './schema';

// =============================================================================
// SQLITE ADAPTER — local-first StorageAdapter over libsql (file or :memory:)
// =============================================================================

type SqliteDb = LibSQLDatabase<typeof schema>;

function parseJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== 'string') return (value as T) ?? fallback;
    try { return JSON.parse(value) as T; } catch { return fallback; }
}

// -- url normalisation --------------------------------------------------------

function expandHome(value: string): string {
    if (!value.startsWith('~')) return value;
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (!home) return value;
    if (value === '~') return home;
    if (value.startsWith('~/')) return `${home}/${value.slice(2)}`;
    return value;
}

// Accept what people actually type — '~/.ultracontext/uc.db', '/var/lib/uc.db',
// 'file:/var/lib/uc.db', ':memory:' — and hand libsql the URL form it requires.
export function normalizeSqliteUrl(input: string): string {
    const value = String(input ?? '').trim();
    if (!value) return 'file::memory:';
    if (value === ':memory:' || value.startsWith('file:') || /^[a-z]+:\/\//i.test(value)) return value;
    return `file:${expandHome(value)}`;
}

// -- client + schema bootstrap ------------------------------------------------

// open a libsql client (url: 'file:/path/uc.db' or ':memory:'), apply DDL once
export async function createSqliteAdapter(url: string): Promise<SqliteAdapter> {
    const client = createClient({ url: normalizeSqliteUrl(url) });
    await client.executeMultiple(SCHEMA_SQL);
    return new SqliteAdapter(drizzle(client, { schema }));
}


// -- full-text search helpers -------------------------------------------------

// Escape user input into a safe FTS5 MATCH expression. Every token is quoted so
// FTS5 operators (NEAR, *, ", -, OR) in user input can never change query
// semantics or throw a syntax error. The final token gets a prefix wildcard for
// typeahead behaviour.
export function toFtsQuery(query: string): string {
    const tokens = query.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
    if (tokens.length === 0) return '';

    return tokens
        .map((token, i) => {
            const escaped = token.replace(/"/g, '""');
            return i === tokens.length - 1 ? `"${escaped}"*` : `"${escaped}"`;
        })
        .join(' ');
}

// -- adapter ------------------------------------------------------------------



export class SqliteAdapter implements StorageAdapter {
    constructor(private db: SqliteDb) {}

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

        // metadata filters via json_extract (SQLite equivalent of Postgres JSONB containment)
        if (filters?.source) conditions.push(sql`json_extract(${nodes.metadata}, '$.source') = ${filters.source}`);
        if (filters?.user_id) conditions.push(sql`json_extract(${nodes.metadata}, '$.user_id') = ${filters.user_id}`);
        if (filters?.host) conditions.push(sql`json_extract(${nodes.metadata}, '$.host') = ${filters.host}`);
        if (filters?.project_path) conditions.push(sql`json_extract(${nodes.metadata}, '$.project_path') = ${filters.project_path}`);
        if (filters?.session_id) conditions.push(sql`json_extract(${nodes.metadata}, '$.session_id') = ${filters.session_id}`);

        // timestamp range filters (created_at is ISO text — lexical order matches chronological)
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
        const rows = Array.isArray(values) ? values : [values];
        const created = await this.db
            .insert(nodes)
            .values(rows as any)
            .returning({
                public_id: nodes.public_id,
                content: nodes.content,
                metadata: nodes.metadata,
                created_at: nodes.created_at,
            });

        // keep the FTS index in step — message nodes only (version heads are empty)
        const indexable = rows
            .filter((row) => row.type !== 'context')
            .map((row) => ({ row, body: searchableText(row.content) }))
            .filter((entry) => entry.body);

        if (indexable.length > 0) {
            const byId = new Map(created.map((row) => [row.public_id, row]));
            for (const { row, body } of indexable) {
                if (!byId.has(row.public_id)) continue;
                await this.db.run(sql`INSERT INTO nodes_fts (public_id, project_id, context_id, body)
                                      VALUES (${row.public_id}, ${row.project_id}, ${row.context_id ?? null}, ${body})`);
            }
        }

        return created;
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        // drop index rows before the nodes they reference disappear
        await this.db.run(sql`DELETE FROM nodes_fts
                              WHERE public_id IN (SELECT public_id FROM ${nodes}
                                                   WHERE project_id = ${projectId} AND context_id = ${contextId})`);
        await this.db.delete(nodes).where(and(eq(nodes.project_id, projectId), eq(nodes.context_id, contextId)));
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        await this.db.run(sql`DELETE FROM nodes_fts WHERE public_id = ${publicId} AND project_id = ${projectId}`);
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
        const match = toFtsQuery(query);
        if (!match) return [];

        const conditions = [sql`nodes_fts MATCH ${match}`, sql`nodes_fts.project_id = ${projectId}`];

        // NOTE: the nodes table is aliased `n` in the raw SQL below, so filters must
        // use the bare alias — drizzle's ${nodes.metadata} would render "nodes"."metadata",
        // which is out of scope once the alias exists.
        if (filters.source) conditions.push(sql`json_extract(n.metadata, '$.source') = ${filters.source}`);
        if (filters.user_id) conditions.push(sql`json_extract(n.metadata, '$.user_id') = ${filters.user_id}`);
        if (filters.host) conditions.push(sql`json_extract(n.metadata, '$.host') = ${filters.host}`);
        if (filters.session_id) conditions.push(sql`json_extract(n.metadata, '$.session_id') = ${filters.session_id}`);
        if (filters.project_path) conditions.push(sql`json_extract(n.metadata, '$.project_path') = ${filters.project_path}`);
        if (filters.after) conditions.push(sql`n.created_at > ${filters.after}`);
        if (filters.before) conditions.push(sql`n.created_at < ${filters.before}`);

        // bm25 is negative; ascending order puts the best match first.
        const rows = await this.db.all(sql`
            SELECT
                n.public_id                            AS message_id,
                COALESCE(h.context_id, n.context_id)   AS context_id,
                n.context_id                           AS branch_id,
                nodes_fts.body AS content,
                n.metadata                             AS metadata,
                n.created_at                           AS created_at,
                bm25(nodes_fts)                        AS rank
            FROM nodes_fts
            JOIN nodes n ON n.public_id = nodes_fts.public_id
            LEFT JOIN nodes h ON h.public_id = n.context_id AND h.type = 'context'
            WHERE ${sql.join(conditions, sql` AND `)}
            ORDER BY rank
            LIMIT ${limit}
        `);

        return rows.map((row: any) => ({
            context_id: String(row.context_id ?? ''),
            branch_id: String(row.branch_id ?? ''),
            message_id: String(row.message_id),
            content: String(row.content ?? ''),
            metadata: parseJson(row.metadata, {}),
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

    // SQLite serializes writes by default — isolationLevel is accepted for API
    // parity and ignored. The callback runs inside a real libsql transaction.
    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, _options?: TransactionOptions): Promise<T> {
        return this.db.transaction(async (tx) => fn(new SqliteAdapter(tx as unknown as SqliteDb)));
    }
}
