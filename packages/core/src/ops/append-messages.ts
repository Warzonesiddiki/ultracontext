// =============================================================================
// APPEND MESSAGES — append messages to a context (ported from POST /contexts/:id)
// =============================================================================

import { buildNodeInsertRecords, findHead, getOrderedNodes, getVersions, nextOrdinal } from '../context-chain';
import { MAX_MESSAGES_PER_APPEND, MAX_MESSAGES_PER_CONTEXT } from '../constants';
import { generatePublicId } from '../public-ids';
import type { MessageView } from '../message-view';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';
import { isRetryableTxError } from '../tx-errors';

// -- intermediate tx outcome --------------------------------------------------
// Mirrors the handler: the serializable tx returns either the success payload
// or an error marker carrying the original HTTP status, resolved to a Result
// once the tx completes.

type AppendOutcome =
    | { data: MessageView[]; version: number }
    | { code: 'not_found' | 'invalid_input' | 'internal'; message: string };

// -- op -----------------------------------------------------------------------

export async function appendMessages(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    messages: object | object[],
): Promise<Result<{ data: MessageView[]; version: number }>> {
    // normalize input to an array — pure, so the per-append cap (API-004)
    // rejects before any storage round-trip
    const items = Array.isArray(messages) ? messages : [messages];
    if (items.length > MAX_MESSAGES_PER_APPEND) {
        return err('invalid_input', `Append exceeds the limit of ${MAX_MESSAGES_PER_APPEND} messages per append`);
    }

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

            // the full content at the current head gives both the existing
            // count and the chain tail
            const existingNodes = await getOrderedNodes(tx, root.public_id, head.public_id);
            const existingCount = existingNodes.length;

            // API-004: the append must not push the context past its ceiling
            if (existingCount + items.length > MAX_MESSAGES_PER_CONTEXT) {
                return {
                    code: 'invalid_input',
                    message: `Context would exceed the limit of ${MAX_MESSAGES_PER_CONTEXT} messages (currently ${existingCount})`,
                };
            }

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
            //
            // DATA-001: head + messages go out as ONE insertNodes call. On a
            // transactional backend that's one statement inside the tx; on a
            // transaction-less one (Supabase REST) it is a single SQL INSERT —
            // so the head and its messages can never commit separately and a
            // crash mid-op can never leave an orphaned head.
            const newHeadId = generatePublicId('context');
            // The messages land in a brand-new partition (context_id = the new
            // head id), so they number from 0. The head lands in the root's
            // version partition, which already holds every previous head — its
            // ordinal continues from the highest one there (ARCH-002).
            const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, newHeadId, tailPublicId);
            const headOrdinal = await nextOrdinal(tx, root.public_id);
            let createdMessages;
            const headRecord = {
                public_id: newHeadId,
                project_id: projectId,
                type: 'context' as const,
                context_id: root.public_id,
                prev_id: head.public_id,
                ordinal: headOrdinal,
                content: {},
                metadata: { operation: 'append', child_count: insertRecords.length },
            };

            try {
                const created = await tx.insertNodes([headRecord, ...insertRecords]);
                createdMessages = created.filter((n) => n.public_id !== newHeadId);
            } catch (error) {
                // single statement failed → nothing was written; report failure
                throw error;
            }

            // version reflects the current head count (this append added one)
            const versions = await getVersions(tx, root.public_id);
            const currentVersion = versions.length - 1;

            // shape each created node: content + generated id + index +
            // wall-clock created_at (PROM-001) + metadata
            const data: MessageView[] = createdMessages.map((node, i: number) => ({
                ...(node.content ?? {}),
                id: node.public_id!,
                index: existingCount + i,
                created_at: node.created_at!,
                metadata: node.metadata ?? {},
            }));

            return { data, version: currentVersion };
        }, { isolationLevel: 'serializable' });
    } catch (error) {
        // Log, don't swallow: the raw driver error only survives in the
        // server log; the client gets a stable, classifiable response.
        // SSI conflicts (SQLSTATE 40001) are retryable — 409 + Retry-After
        // at the route (API-003).
        console.error('appendMessages: transaction failed', error);
        if (isRetryableTxError(error)) return err('conflict', 'Concurrent write conflict — retry the request');
        return err('internal', 'Failed to append messages');
    }

    // resolve the intermediate error marker to a Result error
    if ('code' in outcome) return err(outcome.code, outcome.message);
    return ok({ data: outcome.data, version: outcome.version });
}
