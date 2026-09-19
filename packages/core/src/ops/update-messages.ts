// =============================================================================
// UPDATE MESSAGES — patch messages in a context, creating a new version head
// Ported from PATCH /contexts/:id in apps/api routes. Copy-on-write semantics.
// =============================================================================

import type { StorageAdapter } from '../storage';
import { findHead, getOrderedNodes, getVersions, nextOrdinal } from '../context-chain';
import { generatePublicId } from '../public-ids';
import { isPlainObject, parseUpdateRequestBody } from '../request-parsing';
import type { MessageView } from '../message-view';
import { ok, err, type Result } from '../result';

// -- op -----------------------------------------------------------------------

export async function updateMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    body: object,
): Promise<Result<{ data: MessageView[]; version: number }>> {
    // body-shape validation — parse into { updates, userMetadata } or fail 400
    const parsed = parseUpdateRequestBody(body);
    if ('error' in parsed) return err('invalid_input', parsed.error);

    const { userMetadata, updates } = parsed;

    // per-update validation — selector presence, mutual exclusion, and types
    for (const u of updates) {
        if (!isPlainObject(u)) return err('invalid_input', 'Each update must be an object');
        const hasId = u.id !== undefined;
        const hasIndex = u.index !== undefined;
        if (hasId && hasIndex) return err('invalid_input', 'Cannot specify both id and index');
        if (!hasId && !hasIndex) return err('invalid_input', 'Either id or index required');
        if (hasId && typeof u.id !== 'string') return err('invalid_input', 'id must be a string');
        if (hasIndex && (typeof u.index !== 'number' || !Number.isInteger(u.index))) {
            return err('invalid_input', 'index must be an integer');
        }
    }

    // resolve the root context scoped to the project — missing -> not_found
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    // locate the current head — missing -> internal
    const currentHead = await findHead(storage, root.public_id);
    if (!currentHead) return err('internal', 'HEAD not found');

    // load current messages, indexed by public id for lookup
    const orderedNodes = await getOrderedNodes(storage, root.public_id, currentHead.public_id);
    const nodeIds = new Set(orderedNodes.map((n) => n.public_id));

    // resolve each update's selector (id or index) to a concrete target id
    const resolvedUpdates: Array<{ id: string; [key: string]: unknown }> = [];
    for (const u of updates) {
        if (u.id) {
            // id selector — must reference an existing message
            if (!nodeIds.has(u.id)) return err('not_found', `Message not found: ${u.id}`);
            const { index: _idx, ...rest } = u;
            resolvedUpdates.push(rest as { id: string; [key: string]: unknown });
        } else {
            // index selector — normalize negatives, then bounds-check
            let idx = u.index!;
            if (idx < 0) idx = orderedNodes.length + idx;
            if (idx < 0 || idx >= orderedNodes.length) return err('invalid_input', `Index out of range: ${u.index}`);
            const { index: _idx, ...rest } = u;
            resolvedUpdates.push({ ...rest, id: orderedNodes[idx].public_id });
        }
    }

    // index resolved updates by target id; collect affected ids for the head
    const updateMap = new Map(resolvedUpdates.map((u) => [u.id, u]));
    const affectedIds = resolvedUpdates.map((u) => u.id);

    // build updated node copies — copy-on-write, merging changes onto targets
    const newHeadId = generatePublicId('context');
    const newNodes = orderedNodes.map((n, i) => {
        const update = updateMap.get(n.public_id);
        const { id: _id, ...changes } = update ?? { id: null };
        return {
            public_id: generatePublicId('msg'),
            project_id: projectId,
            type: 'message' as const,
            context_id: newHeadId,
            parent_id: n.public_id,
            prev_id: null as string | null,
            // snapshot copy: a fresh partition, numbered in write order (ARCH-002)
            ordinal: i,
            content: update ? { ...n.content, ...changes } : n.content,
            metadata: n.metadata,
        };
    });

    // link the copies into a chain via prev_id
    for (let i = 1; i < newNodes.length; i++) {
        newNodes[i].prev_id = newNodes[i - 1].public_id;
    }

    // DATA-001: head + copies go out as ONE insertNodes call, so the new
    // version can never commit half-way — a crash mid-op leaves the previous
    // head intact (the write is a single SQL statement on every backend).
    const headRecord = {
        public_id: newHeadId,
        project_id: projectId,
        type: 'context' as const,
        context_id: root.public_id,
        prev_id: currentHead.public_id,
        ordinal: await nextOrdinal(storage, root.public_id),
        content: {},
        metadata: { operation: 'update', affected: affectedIds, child_count: newNodes.length, ...(userMetadata ?? {}) },
    };
    let created: Awaited<ReturnType<typeof storage.insertNodes>>;
    try {
        created = await storage.insertNodes([headRecord, ...newNodes]);
    } catch {
        // stable message — the raw driver error is not useful to the caller
        return err('internal', 'Failed to update messages');
    }

    // current version index is the count of heads minus one
    const versions = await getVersions(storage, root.public_id);
    const currentVersion = versions.length - 1;

    // project the copied nodes into the response shape (created rows carry
    // the wall-clock created_at the adapters stamped on insert — PROM-001)
    const result: MessageView[] = created.filter((n) => n.public_id !== headRecord.public_id).map((n, index: number) => ({
        ...n.content,
        id: n.public_id!,
        index,
        created_at: n.created_at!,
        metadata: n.metadata ?? {},
    }));

    return ok({ data: result, version: currentVersion });
}
