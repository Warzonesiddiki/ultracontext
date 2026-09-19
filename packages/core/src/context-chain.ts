import type { StorageAdapter } from './storage';
import { generatePublicId } from './public-ids';
import { recordChainFallback } from './chain-health';

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

type BranchNode = { public_id: string; prev_id: string | null; created_at: string; ordinal: number | null };

/** Anything orderNodes can sequence: a chain link plus the two tiebreakers. */
export type OrderableNode = {
    public_id: string;
    prev_id: string | null;
    created_at: string;
    /** Persisted position within its context_id partition (ARCH-002). Null on
     *  rows written before migration 0004 — ordering degrades gracefully. */
    ordinal?: number | null;
};

/** Optional provenance for the fallback metric: what the read was for. */
export type OrderNodesMeta = { contextId?: string | null };

// Rows with no persisted ordinal sort after every row that has one, so a
// partially-migrated partition still produces a stable, total order.
const NO_ORDINAL = Number.MAX_SAFE_INTEGER;

// -- pure functions (no DB) ---------------------------------------------------

/**
 * Sequence a set of chain nodes.
 *
 * `prev_id` is authoritative: when the walk from the root reaches every node,
 * that order is returned untouched. When it comes up short the chain is damaged
 * and ordering falls back to a TOTAL order — persisted `ordinal`, then
 * `created_at`, then `public_id`. The last two existed before ARCH-002; the
 * difference is that `created_at` alone is not enough. ISO-millisecond stamps
 * tie constantly (one batch append writes several nodes inside the same
 * millisecond), so a created_at-only sort left message order dependent on the
 * order storage happened to return rows — the same read could reorder itself.
 * `ordinal` is written at insert time and `public_id` is unique, so the
 * fallback is now deterministic even with every timestamp identical, and the
 * event is recorded so an operator can alert on it (see ./chain-health.ts).
 */
export function orderNodes<T extends OrderableNode>(items: T[], meta?: OrderNodesMeta): T[] {
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
        recordChainFallback({
            kind: 'broken_chain',
            context_id: meta?.contextId ?? null,
            expected: items.length,
            reached: ordered.length,
        });
        return [...items].sort(compareByOrdinalThenTime);
    }

    return ordered;
}

/** Total, deterministic order for nodes whose chain cannot be walked. */
export function compareByOrdinalThenTime<T extends OrderableNode>(a: T, b: T): number {
    const byOrdinal = (a.ordinal ?? NO_ORDINAL) - (b.ordinal ?? NO_ORDINAL);
    if (byOrdinal !== 0) return byOrdinal;

    const byTime = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (byTime !== 0) return byTime;

    return a.public_id < b.public_id ? -1 : a.public_id > b.public_id ? 1 : 0;
}

/**
 * Build the insert records for a run of nodes that will share one
 * `context_id` partition, linked head-to-tail by `prev_id` and numbered from
 * `startingOrdinal`.
 *
 * The ordinal is the persisted position in that partition (ARCH-002). It is
 * assigned here, in write order, so it can never disagree with the chain the
 * same call builds — which is what makes it usable as a tiebreaker later.
 * Message partitions are always brand new (every version write mints a fresh
 * head id), so callers pass nothing and get 0…n-1; version-head partitions grow
 * over the life of a context and pass `nextOrdinal()`.
 */
export function buildNodeInsertRecords(
    nodesToInsert: NodeInsertInput[],
    projectId: number,
    contextId: string,
    startingPrevId: string | null = null,
    startingOrdinal = 0,
) {
    const publicIds = nodesToInsert.map((n) => (n.type === 'context' ? generatePublicId('context') : generatePublicId('msg')));

    return nodesToInsert.map((node, idx) => ({
        public_id: publicIds[idx],
        project_id: projectId,
        type: node.type,
        context_id: contextId,
        prev_id: idx === 0 ? startingPrevId : publicIds[idx - 1],
        parent_id: node.parent_id,
        ordinal: startingOrdinal + idx,
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

/**
 * The ordinal the NEXT node inserted into `contextId` should carry: one past the
 * highest ordinal already in that partition.
 *
 * Max, not count. Deleting an interior head (permanent delete, the orphaned-head
 * repair) drops the row COUNT, so a count-based ordinal would hand the next
 * write a value a surviving head already holds — and two live rows sharing an
 * ordinal puts the fallback order straight back at the mercy of timestamps. Max
 * cannot collide: the only value it can ever repeat is one whose row is already
 * gone. Rows written before migration 0004 have no ordinal and read as -1, so an
 * unmigrated partition starts at 0 while backfilled rows keep their values.
 */
export async function nextOrdinal(storage: StorageAdapter, contextId: string): Promise<number> {
    const existing = await storage.findNodesByContextId(contextId, ['public_id', 'ordinal']);
    let max = -1;
    for (const row of existing) {
        if (typeof row.ordinal === 'number' && row.ordinal > max) max = row.ordinal;
    }
    return max + 1;
}

export async function findHead(storage: StorageAdapter, rootId: string): Promise<BranchNode | null> {
    const branches = await storage.findContextBranches(rootId);

    if (branches.length === 0) return null;

    const pointedTo = new Set(branches.map((b) => b.prev_id).filter(Boolean));
    const heads = branches.filter((b) => !pointedTo.has(b.public_id));

    // Newest head wins, and "newest" must be total: heads are written into one
    // partition over the life of a context, and ISO-millisecond stamps collide
    // routinely (a batch append writes several heads inside one millisecond), so
    // a created_at-only sort left the winner dependent on storage return order.
    //
    // The persisted ordinal is the real write order and settles it outright;
    // created_at then public_id remain as tiebreakers for heads written before
    // migration 0004 backfilled ordinals (ARCH-001 → ARCH-002).
    return (
        heads.sort((a, b) => {
            const ao = a.ordinal;
            const bo = b.ordinal;
            if (typeof ao === 'number' && typeof bo === 'number' && ao !== bo) return bo - ao;
            if (typeof ao === 'number' && typeof bo !== 'number') return -1;
            if (typeof ao !== 'number' && typeof bo === 'number') return 1;

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
        return nodes.length === 0 ? [] : orderNodes(nodes, { contextId: headId });
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

    return nodes.length === 0 ? [] : orderNodes(nodes, { contextId: rootId });
}

export async function getVersions(storage: StorageAdapter, rootId: string): Promise<VersionInfo[]> {
    const versionRows = await storage.findVersions(rootId);
    const branches = await storage.findContextBranches(rootId);

    // Order by the prev_id chain (authoritative), not by created_at — append
    // heads can share a millisecond timestamp.
    const ordered = orderNodes(branches, { contextId: rootId });
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
