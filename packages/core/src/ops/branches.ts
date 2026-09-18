// =============================================================================
// NAMED BRANCHES (ARCH-001) — human-chosen pointers to immutable version ids
// =============================================================================
//
// Before this, a version could only be addressed by its positional index, and
// `findHead` picked "newest by created_at" among forks. Both are ambiguous:
// indices shift as the chain grows (a saved `?version=3` silently changes
// meaning), and ISO-millisecond timestamps tie, so the "latest" head of a
// multi-fork context was whatever order the storage returned.
//
// A named branch pins a name to an immutable version head id. The name is
// stable, the id never moves, and moving a name (`branch -f`) is explicit.
// Positional index addressing stays available everywhere as a deprecated alias
// — nothing that works today breaks.
//
// Every op here is PROJECT-SCOPED through findRootContext: branch names are
// tenant data, so a second project asking for someone else's context gets
// not_found, exactly like every other read (SEC-001).

import { findHead, getVersions, type VersionInfo } from '../context-chain';
import type { ContextRefRow, StorageAdapter } from '../storage';
import { resolveVersionSelection } from './get-context';
import { ok, err, type Result } from '../result';

// -- types --------------------------------------------------------------------

/**
 * A named branch as callers see it.
 *
 * `version_id` is the immutable address — the public id of the pinned version
 * head. `version` is that head's positional index *at read time*, and is `-1`
 * when the pinned head is no longer part of the chain (its version node was
 * deleted). The name and the pin survive that; the index cannot.
 */
export type BranchRef = {
    name: string;
    version_id: string;
    version: number;
    created_at: string;
    updated_at: string;
};

/** Body of a branch create/move: a name, optionally pinned to a version. */
export type SetBranchInput = {
    name?: unknown;
    /** Version to pin — immutable id, or positional index (deprecated).
     *  Omitted → the current head. */
    version?: unknown;
};

// -- name rules ---------------------------------------------------------------

export const MAX_BRANCH_NAME_LEN = 64;

// First character must be alphanumeric; the rest may add '.', '_' and '-'.
const BRANCH_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// One message for every rejection path, so the API, both SDKs and the docs all
// quote the same rule set.
export const BRANCH_NAME_ERROR =
    'Invalid branch name: must start with a letter or digit, contain only [A-Za-z0-9._-], ' +
    `have no '..', not end with '.' or '-', and be at most ${MAX_BRANCH_NAME_LEN} characters`;

/**
 * Branch names follow the git-ref rules that matter for a flat namespace:
 * no path traversal ('..'), no leading/trailing punctuation that would make a
 * name ambiguous in a URL or a shell, and a hard length cap so a name can
 * never be used as a storage-amplification vector.
 */
export function isValidBranchName(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > MAX_BRANCH_NAME_LEN) return false;
    if (!BRANCH_NAME_RE.test(value)) return false;
    if (value.includes('..')) return false;
    if (value.endsWith('.') || value.endsWith('-')) return false;
    return true;
}

// -- helpers ------------------------------------------------------------------

// Render a stored ref. The positional index is looked up fresh on every read,
// which is why it can be -1 for a head that is no longer in the chain.
function toBranchRef(row: ContextRefRow, versions: VersionInfo[]): BranchRef {
    const idx = versions.findIndex((v) => v.head_id === row.head_id);
    return {
        name: row.name,
        version_id: row.head_id,
        version: idx === -1 ? -1 : versions[idx].version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
}

// -- ops ----------------------------------------------------------------------

/**
 * GET /contexts/:id/branches — every named branch on a context, name-ascending.
 * An empty list is a valid answer (branches are opt-in), so only an unknown or
 * cross-project context is a 404.
 */
export async function listBranches(
    storage: StorageAdapter,
    projectId: number,
    contextId: string
): Promise<Result<{ branches: BranchRef[] }>> {
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    const [refs, versions] = await Promise.all([
        storage.findContextRefs(projectId, root.public_id),
        getVersions(storage, root.public_id),
    ]);

    return ok({ branches: refs.map((row) => toBranchRef(row, versions)) });
}

/**
 * PUT /contexts/:id/branches — create a branch, or move an existing one.
 *
 * Upsert with git `branch -f` semantics: re-pinning a name that already exists
 * preserves its `created_at` and bumps `updated_at`, so "when was this branch
 * first made" and "when did it last move" stay separately answerable.
 *
 * `version` accepts an immutable version id or a positional index; omitted, the
 * branch points at the current head.
 */
export async function createBranch(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    input: SetBranchInput
): Promise<Result<BranchRef>> {
    const { name, version } = input ?? {};
    if (!isValidBranchName(name)) return err('invalid_input', BRANCH_NAME_ERROR);

    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    const versions = await getVersions(storage, root.public_id);

    // pin target: explicit selector, else the current head
    let headId: string;
    if (version !== undefined) {
        const resolved = resolveVersionSelection(versions, version);
        if (!resolved.ok) return resolved;
        headId = resolved.data.headId;
    } else {
        const head = await findHead(storage, root.public_id);
        if (!head) return err('not_found', 'Context has no versions');
        headId = head.public_id;
    }

    const row = await storage.upsertContextRef({
        project_id: projectId,
        context_id: root.public_id,
        name,
        head_id: headId,
    });

    return ok(toBranchRef(row, versions));
}

/**
 * DELETE /contexts/:id/branches/:name — unpin a name.
 *
 * Deletes the pointer ONLY. Version data is never touched: dropping a branch
 * must not be able to destroy history, which is the whole point of an
 * append-only chain.
 */
export async function deleteBranch(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    name: unknown
): Promise<Result<{ deleted: true; name: string }>> {
    if (!isValidBranchName(name)) return err('invalid_input', BRANCH_NAME_ERROR);

    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    const deleted = await storage.deleteContextRef(projectId, root.public_id, name);
    if (!deleted) return err('not_found', 'Branch not found');

    return ok({ deleted: true, name });
}
