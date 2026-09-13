// =============================================================================
// VERIFY-KEY — storage-fallback token verification (pure capability)
// =============================================================================

import { KEY_PREFIX_LEN } from '../constants';
import { hashKey } from '../api-keys';
import { secretsEqual } from '../secrets';
import type { StorageAdapter } from '../storage';

// -- result shape -------------------------------------------------------------

export type VerifiedKey = { apiKeyId: number; projectId: number };

// -- hashToken ----------------------------------------------------------------

// derive the storage lookup prefix + full-token hash in a single computation,
// so a caching caller can hash once and reuse it for both lookup and cache.
export async function hashToken(token: string): Promise<{ prefix: string; hash: string }> {
    return { prefix: token.slice(0, KEY_PREFIX_LEN), hash: await hashKey(token) };
}

// -- verifyKeyHash ------------------------------------------------------------

// resolve a precomputed prefix+hash to its key/project — no row or hash
// mismatch means no match. The hash comparison is constant-time: stored
// key hashes are secret material, so a wrong guess must not cost less.
export async function verifyKeyHash(storage: StorageAdapter, prefix: string, hash: string): Promise<VerifiedKey | null> {
    const tokenRow = await storage.findApiKeyByPrefix(prefix);
    if (!tokenRow || !secretsEqual(hash, tokenRow.key_hash)) return null;

    return { apiKeyId: tokenRow.id, projectId: tokenRow.project_id };
}

// -- verifyKey ----------------------------------------------------------------

// convenience: verify a raw token in one call (for callers without a cache).
export async function verifyKey(storage: StorageAdapter, token: string): Promise<VerifiedKey | null> {
    const { prefix, hash } = await hashToken(token);
    return verifyKeyHash(storage, prefix, hash);
}
