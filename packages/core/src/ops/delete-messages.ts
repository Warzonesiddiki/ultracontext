// =============================================================================
// DELETE MESSAGES — remove messages from a context by id or index
// (ported from the DELETE /contexts/:id message-delete path)
// =============================================================================

import { findHead, getOrderedNodes, getVersions, nextOrdinal } from '../context-chain';
import { generatePublicId } from '../public-ids';
import { isPlainObject } from '../request-parsing';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- params -------------------------------------------------------------------

export type DeleteMessagesParams = {
    ids: (string | number)[];
    userMetadata?: Record<string, unknown>;
};

// -- op -----------------------------------------------------------------------

export async function deleteMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    params: DeleteMessagesParams
): Promise<Result<{ data: MessageView[]; version: number }>> {
    const { ids, userMetadata } = params;

    // userMetadata, when present, must be a plain object
    if (userMetadata !== undefined && !isPlainObject(userMetadata)) {
        return err('invalid_input', 'metadata must be an object');
    }

    // ids must be supplied
    if (ids === undefined || ids === null) return err('invalid_input', 'ids is required');

    // normalize to an array and reject empty input
    const rawIds: Array<string | number> = Array.isArray(ids) ? ids : [ids];
    if (rawIds.length === 0) return err('invalid_input', 'ids must be a non-empty array');

    // each element must be a string id or an integer index
    for (const input of rawIds) {
        if (typeof input === 'string') continue;
        if (typeof input !== 'number' || !Number.isInteger(input)) {
            return err('invalid_input', 'Each id must be a string or integer index');
        }
    }

    // resolve the root context, scoped to the project
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    // resolve the current head of the version chain
    const currentHead = await findHead(storage, root.public_id);
    if (!currentHead) return err('internal', 'HEAD not found');

    // load the ordered messages under the current head
    const orderedNodes = await getOrderedNodes(storage, root.public_id, currentHead.public_id);
    const nodeIds = new Set(orderedNodes.map((n) => n.public_id));

    // resolve each target to a concrete message public id
    const idsToDelete: string[] = [];
    for (const input of rawIds) {
        if (typeof input === 'string') {
            if (!nodeIds.has(input)) return err('not_found', `Message not found: ${input}`);
            idsToDelete.push(input);
        } else {
            let idx = input;
            if (idx < 0) idx = orderedNodes.length + idx;
            if (idx < 0 || idx >= orderedNodes.length) return err('invalid_input', `Index out of range: ${input}`);
            idsToDelete.push(orderedNodes[idx].public_id);
        }
    }
    const deleteSet = new Set(idsToDelete);

    // build filtered node copies (copy-on-write of the survivors)
    const newHeadId = generatePublicId('context');
    const filtered = orderedNodes.filter((n) => !deleteSet.has(n.public_id));
    const newNodes = filtered.map((n, i) => ({
        public_id: generatePublicId('msg'),
        project_id: projectId,
        type: 'message' as const,
        context_id: newHeadId,
        parent_id: n.public_id,
        prev_id: null as string | null,
        // snapshot copy: a fresh partition, numbered in write order (ARCH-002)
        ordinal: i,
        content: n.content,
        metadata: n.metadata,
    }));

    // link the copies in order via prev_id
    for (let i = 1; i < newNodes.length; i++) {
        newNodes[i].prev_id = newNodes[i - 1].public_id;
    }

    // DATA-001: head + survivors go out as ONE insertNodes call, so the new
    // version can never commit half-way (child_count: 0 is legitimate here —
    // a delete-all produces an empty version; the repair pass only touches
    // heads whose marker says children were expected).
    const headRecord = {
        public_id: newHeadId,
        project_id: projectId,
        type: 'context' as const,
        context_id: root.public_id,
        prev_id: currentHead.public_id,
        ordinal: await nextOrdinal(storage, root.public_id),
        content: {},
        metadata: { operation: 'delete', affected: idsToDelete, child_count: newNodes.length, ...(userMetadata ?? {}) },
    };
    let created: Awaited<ReturnType<typeof storage.insertNodes>>;
    try {
        created = await storage.insertNodes([headRecord, ...newNodes]);
    } catch {
        // stable message — the raw driver error is not useful to the caller
        return err('internal', 'Failed to delete messages');
    }

    // recompute the current version after the delete head landed
    const versions = await getVersions(storage, root.public_id);
    const currentVersion = versions.length - 1;
    // created rows carry the wall-clock created_at the adapters stamped
    // on insert (PROM-001)
    const result: MessageView[] = created.filter((n) => n.public_id !== headRecord.public_id).map((n, index: number) => ({
        ...n.content,
        id: n.public_id!,
        index,
        created_at: n.created_at!,
        metadata: n.metadata ?? {},
    }));

    return ok({ data: result, version: currentVersion });
}
