import type {
    StorageAdapter,
    NodeRow,
    NodeInsertRow,
    ApiKeyRow,
    ApiKeyPublic,
    ProjectRow,
    ContextRefRow,
    ContextFilters,
    SearchFilters,
    SearchHit,
    ActivityQuery,
    ActivityRow,
} from '../storage';
import { searchableText } from '../ops/search';
import { aggregateActivity } from '../ops/analytics';

// -- In-memory storage adapter ------------------------------------------------

type StoredNode = NodeRow;

export class MemoryStorage implements StorageAdapter {
    private nodes: StoredNode[] = [];
    // named branches (ARCH-001): name → pinned version head id
    private refs: ContextRefRow[] = [];
    private keys: Array<{
        id: number;
        project_id: number;
        key_prefix: string;
        key_hash: string;
        name?: string;
        created_at: string;
        last_used_at?: string;
    }> = [];
    private projectSeq = 0;
    private nodeSeq = 0;

    async findNodesByContextId(contextId: string): Promise<Partial<NodeRow>[]> {
        return this.nodes
            .filter((n) => n.context_id === contextId)
            .map((n) => ({ public_id: n.public_id, prev_id: n.prev_id }));
    }

    async findContextBranches(contextId: string) {
        return this.nodes
            .filter((n) => n.context_id === contextId && n.type === 'context')
            .map((n) => ({ public_id: n.public_id, prev_id: n.prev_id, created_at: n.created_at }));
    }

    async findVersions(contextId: string) {
        return this.nodes
            .filter((n) => n.context_id === contextId && n.type === 'context')
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .map((n) => ({ public_id: n.public_id, created_at: n.created_at, metadata: n.metadata }));
    }

    async findNonContextNodes(contextId: string): Promise<NodeRow[]> {
        return this.nodes.filter((n) => n.context_id === contextId && n.type !== 'context');
    }

    async findNonContextNodesByContextIds(contextIds: string[]): Promise<NodeRow[]> {
        if (contextIds.length === 0) return [];
        const ids = new Set(contextIds);
        return this.nodes.filter((n) => n.context_id !== null && ids.has(n.context_id) && n.type !== 'context');
    }

    async findRootContext(projectId: number, publicId: string) {
        const n = this.nodes.find(
            (n) => n.project_id === projectId && n.public_id === publicId && n.type === 'context' && n.context_id === null
        );
        return n ? { public_id: n.public_id } : null;
    }

    async listRootContexts(projectId: number, limit: number, _filters?: ContextFilters) {
        return this.nodes
            .filter((n) => n.project_id === projectId && n.type === 'context' && n.context_id === null)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .slice(0, limit)
            .map((n) => ({ public_id: n.public_id, metadata: n.metadata, created_at: n.created_at }));
    }

    async insertNodes(values: NodeInsertRow | NodeInsertRow[]): Promise<Partial<NodeRow>[]> {
        const rows = Array.isArray(values) ? values : [values];
        const results: Partial<NodeRow>[] = [];
        for (const row of rows) {
            const node: StoredNode = {
                id: ++this.nodeSeq,
                public_id: row.public_id,
                project_id: row.project_id,
                type: row.type,
                content: row.content ?? {},
                metadata: row.metadata ?? {},
                created_at: row.created_at ?? new Date().toISOString(),
                parent_id: row.parent_id ?? null,
                prev_id: row.prev_id ?? null,
                context_id: row.context_id ?? null,
            };
            this.nodes.push(node);
            results.push({
                public_id: node.public_id,
                content: node.content,
                metadata: node.metadata,
                created_at: node.created_at,
            });
        }
        return results;
    }

    async deleteNodesByContextId(projectId: number, contextId: string) {
        this.nodes = this.nodes.filter((n) => !(n.project_id === projectId && n.context_id === contextId));
    }

    async deleteNodeByPublicId(projectId: number, publicId: string) {
        this.nodes = this.nodes.filter((n) => !(n.project_id === projectId && n.public_id === publicId));
    }

    async clearParentReferences(projectId: number, parentId: string) {
        for (const n of this.nodes) {
            if (n.project_id === projectId && n.parent_id === parentId) {
                n.parent_id = null;
            }
        }
    }

    async clearParentReferencesBulk(projectId: number, parentIds: string[]) {
        if (parentIds.length === 0) return;
        const set = new Set(parentIds);
        for (const n of this.nodes) {
            if (n.project_id === projectId && n.parent_id && set.has(n.parent_id)) {
                n.parent_id = null;
            }
        }
    }

    async searchMessages(projectId: number, query: string, filters: SearchFilters, limit: number): Promise<SearchHit[]> {
        const needle = query.toLowerCase();
        const hits: SearchHit[] = [];

        for (const n of this.nodes) {
            if (n.project_id !== projectId) continue;
            if (n.type === 'context') continue;

            const text = searchableText(n.content);
            if (!text.toLowerCase().includes(needle)) continue;

            const meta = (n.metadata ?? {}) as Record<string, unknown>;
            if (filters.source && meta.source !== filters.source) continue;
            if (filters.user_id && meta.user_id !== filters.user_id) continue;
            if (filters.host && meta.host !== filters.host) continue;
            if (filters.session_id && meta.session_id !== filters.session_id) continue;
            if (filters.after && String(n.created_at) <= filters.after) continue;
            if (filters.before && String(n.created_at) >= filters.before) continue;

            const branch = this.nodes.find((b) => b.public_id === n.context_id && b.type === 'context');
            hits.push({
                context_id: branch?.context_id ?? n.context_id ?? '',
                branch_id: n.context_id ?? '',
                message_id: n.public_id,
                content: text,
                metadata: meta,
                created_at: n.created_at,
                rank: -text.toLowerCase().indexOf(needle),
            });
        }

        // ascending rank (bm25 convention), newest first on ties
        hits.sort((a, b) => a.rank - b.rank || String(b.created_at).localeCompare(String(a.created_at)));
        return hits.slice(0, limit);
    }

    async projectActivity(projectId: number, query: ActivityQuery): Promise<ActivityRow[]> {
        return aggregateActivity(
            this.nodes.filter((n) => n.project_id === projectId),
            query,
        );
    }

    async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
        const k = this.keys.find((k) => k.key_prefix === prefix);
        return k ? { id: k.id, project_id: k.project_id, key_hash: k.key_hash } : null;
    }

    async insertApiKey(values: { project_id: number; key_prefix: string; key_hash: string }) {
        this.keys.push({ id: this.keys.length + 1, created_at: new Date().toISOString(), ...values });
    }

    async updateApiKeyLastUsedAt(_id: number, _lastUsedAt: string) {}

    async listApiKeys(projectId: number): Promise<ApiKeyPublic[]> {
        return this.keys
            .filter((k) => k.project_id === projectId)
            .map((k) => ({
                id: k.id,
                project_id: k.project_id,
                key_prefix: k.key_prefix,
                name: k.name ?? null,
                created_at: k.created_at,
                last_used_at: k.last_used_at ?? null,
            }));
    }

    async findApiKey(id: number): Promise<ApiKeyPublic | null> {
        const k = this.keys.find((k) => k.id === id);
        if (!k) return null;
        return {
            id: k.id,
            project_id: k.project_id,
            key_prefix: k.key_prefix,
            name: k.name ?? null,
            created_at: k.created_at,
            last_used_at: k.last_used_at ?? null,
        };
    }

    async deleteApiKey(id: number): Promise<boolean> {
        const i = this.keys.findIndex((k) => k.id === id);
        if (i === -1) return false;
        this.keys.splice(i, 1);
        return true;
    }

    // -- named branches (ARCH-001) --------------------------------------------

    async findContextRefs(projectId: number, contextId: string): Promise<ContextRefRow[]> {
        return this.refs
            .filter((r) => r.project_id === projectId && r.context_id === contextId)
            // stable order: the SQL adapters ORDER BY name, so tests that assert
            // on list order exercise the real contract
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
            .map((r) => ({ ...r }));
    }

    async upsertContextRef(values: {
        project_id: number;
        context_id: string;
        name: string;
        head_id: string;
    }): Promise<ContextRefRow> {
        const now = new Date().toISOString();
        const existing = this.refs.find(
            (r) => r.project_id === values.project_id && r.context_id === values.context_id && r.name === values.name
        );

        // git `branch -f`: the pointer moves, the branch's birthday does not
        if (existing) {
            existing.head_id = values.head_id;
            existing.updated_at = now;
            return { ...existing };
        }

        const row: ContextRefRow = { ...values, created_at: now, updated_at: now };
        this.refs.push(row);
        return { ...row };
    }

    async deleteContextRef(projectId: number, contextId: string, name: string): Promise<boolean> {
        const i = this.refs.findIndex(
            (r) => r.project_id === projectId && r.context_id === contextId && r.name === name
        );
        if (i === -1) return false;
        this.refs.splice(i, 1);
        return true;
    }

    async insertProject(name: string): Promise<ProjectRow | null> {
        return { id: ++this.projectSeq };
    }

    async deleteProject(_id: number) {}

    async listProjects() {
        // projectSeq is a monotonic 1..N counter — every id in range exists
        return Array.from({ length: this.projectSeq }, (_, i) => ({ id: i + 1 }));
    }

    async transaction<T>(fn: (tx: StorageAdapter) => Promise<T>, _options?: unknown): Promise<T> {
        return fn(this);
    }

    // test helpers
    getAllNodes() {
        return this.nodes;
    }

    getNodesByPublicId(publicId: string) {
        return this.nodes.find((n) => n.public_id === publicId) ?? null;
    }

    getNodesWithParentId(parentId: string) {
        return this.nodes.filter((n) => n.parent_id === parentId);
    }

    /** Raw stored branch rows (ARCH-001) — for tests asserting on the pin itself. */
    getContextRefs() {
        return this.refs.map((r) => ({ ...r }));
    }
}
