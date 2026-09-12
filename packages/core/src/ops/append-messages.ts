// =============================================================================
// APPEND MESSAGES — append messages to a context (ported from POST /contexts/:id)
// =============================================================================

import { buildNodeInsertRecords, findHead, getOrderedNodes, getVersions } from '../context-chain';
import { generatePublicId } from '../public-ids';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- intermediate tx outcome --------------------------------------------------
// Mirrors the handler: the serializable tx returns either the success payload
// or an error marker carrying the original HTTP status, resolved to a Result
// once the tx completes.

type AppendOutcome = { data: MessageView[]; version: number } | { code: 'not_found' | 'internal'; message: string };

// -- op -----------------------------------------------------------------------

export async function appendMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    messages: object | object[],
): Promise<Result<{ data: MessageView[]; version: number }>> {
    // Serializable tx so concurrent permanent-delete can't race with append
    // (Postgres SSI makes one side fail with 40001; client retries).
    let outcome: AppendOutcome;
    try {
        outcome = await storage.transaction<AppendOutcome>(async (tx) => {
            // context must exist under this project
            const root = await tx.findRootContext(projectId, contextId);
            if (!root) return { code: 'not_found', message: 'Context not found' };

            // resolve the current head of the context chain
            const head = await findHead(tx, root.public_id);
            if (!head) return { code: 'internal', message: 'HEAD not found' };

            // normalize input to an array; the full content at the current
            // head gives both the existing count and the chain tail
            const items = Array.isArray(messages) ? messages : [messages];
            const existingNodes = await getOrderedNodes(tx, root.public_id, head.public_id);
            const existingCount = existingNodes.length;
            const tailPublicId = existingCount > 0 ? existingNodes[existingCount - 1].public_id! : null;

            // split metadata out of each message; the rest is content
            const nodeInputs = items.map((msg) => {
                const { metadata, ...content } = msg as Record<string, unknown>;
                return { type: 'message', content, metadata: (metadata ?? {}) as Record<string, unknown> };
            });

            // Every append is a new version (PROM-002): a fresh head records
            // the append, and only the NEW messages are stored under it — the
            // first one links via prev_id into the previous head's tail, so
            // no message is ever copied (zero-copy append).
            const newHeadId = generatePublicId('context');
            const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, newHeadId, tailPublicId);

            let createdMessages;
            try {
                await tx.insertNodes({
                    public_id: newHeadId,
                    project_id: projectId,
                    type: 'context',
                    context_id: root.public_id,
                    prev_id: head.public_id,
                    content: {},
                    metadata: { operation: 'append' },
                });
                createdMessages = await tx.insertNodes(insertRecords);
            } catch (error) {
                // roll back the orphaned head (best effort), then report failure
                try {
                    await tx.deleteNodeByPublicId(projectId, newHeadId);
                } catch { /* already rolled back */ }
                throw error;
            }

            // version reflects the current head count (this append added one)
            const versions = await getVersions(tx, root.public_id);
            const currentVersion = versions.length - 1;

            // shape each created node: content + generated id + index + metadata
            const data: MessageView[] = createdMessages.map((node, i: number) => ({
                ...(node.content ?? {}),
                id: node.public_id!,
                index: existingCount + i,
                metadata: node.metadata ?? {},
            }));

            return { data, version: currentVersion };
        }, { isolationLevel: 'serializable' });
    } catch {
        // any tx failure collapses to a single internal error
        return err('internal', 'Failed to append messages');
    }

    // resolve the intermediate error marker to a Result error
    if ('code' in outcome) return err(outcome.code, outcome.message);
    return ok({ data: outcome.data, version: outcome.version });
}
