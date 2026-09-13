// =============================================================================
// STARTUP REPAIR — scan every project for version-chain damage left by
// crashes of OLDER code (pre-DATA-001: a version head committed without its
// children, or a root context without any version head). Current ops write a
// version's head + children as a single statement, so they cannot create
// these states; this is the upgrade path for legacy databases.
// =============================================================================

import { repairOrphanedHeads, type StorageAdapter } from '@ultracontext/core';

export async function repairAllProjects(storage: StorageAdapter): Promise<number> {
    let repairedHeads = 0;
    let repairedRoots = 0;

    for (const project of await storage.listProjects()) {
        const report = await repairOrphanedHeads(storage, project.id);
        if (!report.ok) continue; // keep scanning; one bad project must not stop the rest
        repairedHeads += report.data.repaired_heads.length;
        repairedRoots += report.data.repaired_roots.length;
    }

    if (repairedHeads > 0 || repairedRoots > 0) {
        console.log(
            `[ultracontext] repaired ${repairedHeads} orphaned version head(s) ` +
            `and ${repairedRoots} partial context(s)`,
        );
    }
    return repairedHeads + repairedRoots;
}
