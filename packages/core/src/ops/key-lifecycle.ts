// =============================================================================
// KEY LIFECYCLE — list, revoke and rotate API keys (pure capability)
// =============================================================================
// A leaked key must be invalidatable — and invalidation must take effect
// immediately, not when some cache expires. The route layer is responsible
// for evicting the auth cache for the returned prefixes; these ops handle
// the source of truth (storage).

import { KEY_PREFIX_LEN } from '../constants';
import { generateKey, hashKey } from '../api-keys';
import type { ApiKeyPublic, StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- id validation ------------------------------------------------------------

function validId(id: number): boolean {
    return Number.isInteger(id) && id > 0;
}

// -- list ----------------------------------------------------------------------

// all keys of a project, without the hash
export async function listKeys(storage: StorageAdapter, projectId: number): Promise<Result<ApiKeyPublic[]>> {
    if (!validId(projectId)) return err('invalid_input', 'projectId must be a positive integer');
    try {
        return ok(await storage.listApiKeys(projectId));
    } catch {
        return err('internal', 'Failed to list keys');
    }
}

// -- revoke --------------------------------------------------------------------

// delete the key row so the next auth lookup finds nothing. The result
// carries the key_prefix so the caller can evict the auth cache entry.
export async function revokeKey(storage: StorageAdapter, id: number): Promise<Result<{ id: number; prefix: string }>> {
    if (!validId(id)) return err('invalid_input', 'id must be a positive integer');

    const key = await storage.findApiKey(id);
    if (!key) return err('not_found', 'Key not found');

    try {
        const deleted = await storage.deleteApiKey(id);
        if (!deleted) return err('not_found', 'Key not found');
        return ok({ id, prefix: key.key_prefix });
    } catch {
        return err('internal', 'Failed to revoke key');
    }
}

// -- rotate --------------------------------------------------------------------

// issue a fresh key for the same project, then delete the old one. The new
// row is inserted BEFORE the old one is deleted, so a failure mid-rotate
// leaves the old key still valid — fail safe, never a locked-out project.
export async function rotateKey(
    storage: StorageAdapter,
    id: number
): Promise<Result<{ key: string; prefix: string; old_prefix: string; project_id: number }>> {
    if (!validId(id)) return err('invalid_input', 'id must be a positive integer');

    const old = await storage.findApiKey(id);
    if (!old) return err('not_found', 'Key not found');

    try {
        const raw = generateKey();
        const prefix = raw.slice(0, KEY_PREFIX_LEN);
        await storage.insertApiKey({ project_id: old.project_id, key_prefix: prefix, key_hash: await hashKey(raw) });
        await storage.deleteApiKey(id);
        return ok({ key: raw, prefix, old_prefix: old.key_prefix, project_id: old.project_id });
    } catch {
        return err('internal', 'Failed to rotate key');
    }
}
