import type { StorageAdapter } from './storage';
import { generatePublicId } from './public-ids';

export type NodeInsertInput = {
    type: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    parent_id?: string | null;
};

export type VersionInfo = {
    version: number;
    head_id: string;
    created_at: string;
    operation: 'create' | 'append' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

type BranchNode = { public_id: string; prev_id: string | null; created_at: string };

// -- pure functions (no DB) ---------------------------------------------------

export function orderNodes<T extends { public_id: string; prev_id: string | null; created_at: string }>(items: T[]): T[] {
    if (items.length === 0) return [];

    const byPrev = new Map<string | null, T>();
    for (const item of items) {
        byPrev.set(item.prev_id, item);
    }

    const ordered: T[] = [];
    let current = byPrev.get(null);

    while (current) {
        ordered.push(current);
        current = byPrev.get(current.public_id);
    }

    if (ordered.length !== items.length) {
        console.error(`Broken linked list in context. Expected ${items.length} nodes, got ${ordered.length}. Falling back to created_at order.`);
        return [...items].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    }

    return ordered;
}

export function buildNodeInsertRecords(nodesToInsert: NodeInsertInput[], projectId: number, contextId: string, startingPrevId: string | null = null) {
    const publicIds = nodesToInsert.map((n) => (n.type === 'context' ? generatePublicId('context') : generatePublicId('msg')));

    return nodesToInsert.map((node, idx) => ({
        public_id: publicIds[idx],
        project_id: projectId,
        type: node.type,
        context_id: contextId,
        prev_id: idx === 0 ? startingPrevId : publicIds[idx - 1],
        parent_id: node.parent_id,
        content: node.content,
        metadata: node.metadata,
    }));
}

// -- storage-backed functions -------------------------------------------------

export async function findTail(storage: StorageAdapter, contextPublicId: string): Promise<string | null> {
    const contextNodes = await storage.findNodesByContextId(contextPublicId);

    if (contextNodes.length === 0) return null;

    const pointedTo = new Set(contextNodes.map((n) => n.prev_id).filter(Boolean));
    const tail = contextNodes.find((n) => !pointedTo.has(n.public_id));

    return tail?.public_id ?? null;
}

export async function findHead(storage: StorageAdapter, rootId: string): Promise<BranchNode | null> {
    const branches = await storage.findContextBranches(rootId);

    if (branches.length === 0) return null;

    const pointedTo = new Set(branches.map((b) => b.prev_id).filter(Boolean));
    const heads = branches.filter((b) => !pointedTo.has(b.public_id));

    // Newest head wins. ISO-millisecond stamps collide routinely (a batch
    // append writes several heads inside one millisecond), so a created_at-only
    // sort leaves the winner dependent on storage return order — the ambiguity
    // ARCH-001 closes. public_id descending is a total, deterministic order on
    // ties: same data, same head, every time.
    return (
        heads.sort((a, b) => {
            const byTime = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            if (byTime !== 0) return byTime;
            return a.public_id < b.public_id ? 1 : a.public_id > b.public_id ? -1 : 0;
        })[0] ?? null
    );
}

/**
 * Ordered messages = the full content at a version head (PROM-002).
 *
 * Version heads come in two flavours:
 *  - snapshot heads (create / update / delete) own a complete copy of the
 *    message state — self-contained;
 *  - append heads (operation 'append') own only the messages added by that
 *    append; their first message links via prev_id into the previous head,
 *    so the version's content is cumulative.
 *
 * The content at `headId` is therefore: this head's own messages plus, while
 * the head is an append, the content of the previous head — stopping at the
 * nearest snapshot head. The concatenated nodes form one continuous prev_id
 * chain, so a single orderNodes pass restores message order.
 */
export async function getOrderedNodes(storage: StorageAdapter, rootId: string, headId: string) {
    const versions = await getVersions(storage, rootId);
    const idx = versions.findIndex((v) => v.head_id === headId);

    // Defensive: head not in the version chain (should not happen) — read it directly.
    if (idx === -1) {
        const nodes = await storage.findNonContextNodes(headId);
        return nodes.length === 0 ? [] : orderNodes(nodes);
    }

    const headIds: string[] = [];
    for (let i = idx; i >= 0; i--) {
        headIds.push(versions[i].head_id);
        if (versions[i].operation !== 'append') break;
    }

    const nodes =
        headIds.length === 1
            ? await storage.findNonContextNodes(headIds[0])
            : await storage.findNonContextNodesByContextIds(headIds);

    return nodes.length === 0 ? [] : orderNodes(nodes);
}

export async function getVersions(storage: StorageAdapter, rootId: string): Promise<VersionInfo[]> {
    const versionRows = await storage.findVersions(rootId);
    const branches = await storage.findContextBranches(rootId);

    // Order by the prev_id chain (authoritative), not by created_at — append
    // heads can share a millisecond timestamp.
    const ordered = orderNodes(branches);
    const rowById = new Map(versionRows.map((r) => [r.public_id, r]));

    const versions: VersionInfo[] = [];
    for (let i = 0; i < ordered.length; i++) {
        const row = rowById.get(ordered[i].public_id);
        if (!row) continue;

        const meta = (row.metadata as Record<string, unknown>) ?? {};
        const { operation, affected, ...userMetadata } = meta;

        versions.push({
            version: versions.length,
            head_id: row.public_id,
            created_at: row.created_at,
            operation: (operation as VersionInfo['operation']) ?? 'create',
            affected: (affected as string[]) ?? null,
            metadata: Object.keys(userMetadata).length > 0 ? userMetadata : undefined,
        });
    }

    return versions;
}
