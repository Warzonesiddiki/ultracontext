// =============================================================================
// CREATE CONTEXT — create a root context, optionally forking a source (ported
// from POST /contexts)
// =============================================================================

import type { StorageAdapter, NodeRow } from '../storage';
import { buildNodeInsertRecords, findHead, getOrderedNodes, getVersions } from '../context-chain';
import { generatePublicId } from '../public-ids';
import { firstRow } from '../first-row';
import { parseIndex } from '../request-parsing';
import { resolveVersionSelection } from './get-context';
import { ok, err, type Result } from '../result';

// -- input --------------------------------------------------------------------

export type CreateContextInput = {
    from?: string;
    version?: unknown;
    at?: unknown;
    before?: unknown;
    metadata?: Record<string, unknown>;
};

// -- op -----------------------------------------------------------------------

export async function createContext(
    storage: StorageAdapter,
    projectId: number,
    input: CreateContextInput
): Promise<Result<{ id: string; metadata: Record<string, unknown>; created_at: string }>> {
    const { from, version, at, before, metadata } = input;

    // parse the optional `before` cutoff before anything else
    let beforeTs: number | undefined;
    if (before !== undefined) {
        beforeTs = Date.parse(before as string);
        if (isNaN(beforeTs)) return err('invalid_input', 'Invalid timestamp format');
    }

    // version/at/before are only meaningful when forking a source
    if ((version !== undefined || at !== undefined || before !== undefined) && !from) {
        return err('invalid_input', 'version, at, and before require from');
    }

    // resolve the source nodes to copy when forking
    let sourceNodes: NodeRow[] = [];
    if (from) {
        // SEC-001: the source lookup MUST be project-scoped. Resolving a fork
        // source by public id alone let a caller with only an id (leaked in a
        // log, a shared link, a transcript) read and copy another tenant's
        // context. findRootContext() applies `project_id` in the same query.
        const sourceCtx = await storage.findRootContext(projectId, from);
        if (!sourceCtx) return err('not_found', 'Source context not found');

        // pick the source head — by version index, by timestamp, or latest
        let sourceHead;
        const versions = await getVersions(storage, from);

        if (version !== undefined) {
            // ARCH-001: fork from an immutable version id OR a positional index
            // (deprecated alias). Same resolver as GET /contexts/:id, so the two
            // endpoints can never disagree about what a selector means.
            const resolved = resolveVersionSelection(versions, version);
            if (!resolved.ok) return resolved;
            sourceHead = { public_id: resolved.data.headId };
        } else if (beforeTs !== undefined) {
            const targetVersion = versions.filter((v) => new Date(v.created_at).getTime() <= beforeTs).pop();
            if (!targetVersion) return err('not_found', 'No version found before timestamp');
            sourceHead = { public_id: targetVersion.head_id };
        } else {
            sourceHead = await findHead(storage, from);
        }

        // gather + filter + slice the source nodes off the chosen head
        if (sourceHead) {
            sourceNodes = await getOrderedNodes(storage, from, sourceHead.public_id);

            if (beforeTs !== undefined) {
                sourceNodes = sourceNodes.filter((n) => new Date(n.created_at).getTime() <= beforeTs);
            }

            if (at !== undefined) {
                const idx = parseIndex(at);
                if (idx === null || idx < 0 || idx >= sourceNodes.length) {
                    return err('invalid_input', 'Invalid index');
                }
                sourceNodes = sourceNodes.slice(0, idx + 1);
            }
        }
    }

    // DATA-001: root + initial head + forked copies go out as ONE insertNodes
    // call. Previously a crash between the three writes left partial contexts
    // (a root with no version head, or a head with no messages). As a single
    // statement the whole create either lands or it doesn't.
    const rootId = generatePublicId('context');
    const headId = generatePublicId('context');

    const insertRecords =
        sourceNodes.length > 0
            ? buildNodeInsertRecords(
                  sourceNodes.map((n) => ({
                      type: 'message',
                      content: n.content,
                      metadata: n.metadata,
                      parent_id: n.public_id,
                  })),
                  projectId,
                  headId,
                  null,
              )
            : [];

    let root;
    try {
        const rows = await storage.insertNodes([
            {
                public_id: rootId,
                project_id: projectId,
                type: 'context',
                context_id: null,
                parent_id: from ?? null,
                content: {},
                metadata: (metadata ?? {}) as Record<string, unknown>,
            },
            {
                public_id: headId,
                project_id: projectId,
                type: 'context',
                context_id: rootId,
                prev_id: null,
                content: {},
                metadata: { operation: 'create', child_count: insertRecords.length },
            },
            ...insertRecords,
        ]);
        root = rows.find((r) => r.public_id === rootId);
    } catch {
        // stable message — the raw driver error is not useful to the caller
        return err('internal', 'Failed to create context');
    }
    if (!root) return err('internal', 'Failed to create context');

    return ok({
        id: root.public_id!,
        metadata: root.metadata!,
        created_at: root.created_at!,
    });
}
