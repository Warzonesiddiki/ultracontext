// =============================================================================
// REPAIR ORPHANED HEADS — heal version chains damaged by crashes of OLDER
// code (pre-DATA-001, when a version's head and children were written in
// separate calls and a crash between them could leave a head with no
// children, or a root context with no version head at all).
//
// Current ops can't create these states (head + children are one statement),
// so the repair is for legacy damage plus defense-in-depth. It is conservative
// and marker-driven: a head is only removed when its own metadata
// (`child_count`, written by every current op) says children were expected
// and none exist. A head with child_count: 0 (a legitimate delete-all, an
// empty create, an explicit empty append) is left alone.
// =============================================================================

import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

export type RepairReport = {
    /** Version heads removed (head present, its declared children absent). */
    repaired_heads: string[];
    /** Root contexts removed (root present, zero version heads — partial create). */
    repaired_roots: string[];
};

// Generous cap for the root scan; local databases are small and this runs at
// server start, not per request.
const ROOT_SCAN_LIMIT = 10_000;

export async function repairOrphanedHeads(
    storage: StorageAdapter,
    projectId: number,
): Promise<Result<RepairReport>> {
    try {
        const roots = await storage.listRootContexts(projectId, ROOT_SCAN_LIMIT);
        const repaired_heads: string[] = [];
        const repaired_roots: string[] = [];

        for (const root of roots) {
            const branches = await storage.findContextBranches(root.public_id);

            // A completed create always leaves at least one version head.
            // A root with zero branches can only be a partial create (crash
            // before the head was written) — remove it.
            if (branches.length === 0) {
                await storage.deleteNodeByPublicId(projectId, root.public_id);
                repaired_roots.push(root.public_id);
                continue;
            }

            const versions = await storage.findVersions(root.public_id);
            const metaById = new Map(versions.map((v) => [v.public_id, v.metadata ?? {}]));

            for (const branch of branches) {
                const meta = metaById.get(branch.public_id) ?? {};
                const childCount = meta.child_count;
                if (typeof childCount !== 'number' || childCount <= 0) continue;

                const children = await storage.findNonContextNodes(branch.public_id);
                if (children.length > 0) continue;

                // Head says "I own N messages" and owns none → the write that
                // was supposed to create them never completed. Removing the
                // head heals the chain: the previous head becomes HEAD again.
                await storage.deleteNodeByPublicId(projectId, branch.public_id);
                repaired_heads.push(branch.public_id);
            }
        }

        return ok({ repaired_heads, repaired_roots });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Repair failed';
        return err('internal', message);
    }
}
