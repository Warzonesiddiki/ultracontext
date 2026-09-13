import type { CachedKey, KeyCache } from './types';

// =============================================================================
// KV KEY CACHE — Cloudflare Workers KV implementation
// =============================================================================

// Worst-case window where a REVOKED key still resolves from cache (normal
// revocation evicts explicitly via delete(); this TTL is the backstop if an
// eviction write fails). 60s keeps the "revoked within a minute" guarantee
// without hammering KV — a 1.5s-poll daemon costs one extra storage lookup
// per key per minute.
const DEFAULT_TTL = 60;

export class KvKeyCache implements KeyCache {
    constructor(private kv: KVNamespace) {}

    async get(prefix: string): Promise<CachedKey | null> {
        const raw = await this.kv.get(`key:${prefix}`);
        if (!raw) return null;
        return JSON.parse(raw) as CachedKey;
    }

    async put(prefix: string, value: CachedKey, ttlSeconds = DEFAULT_TTL): Promise<void> {
        await this.kv.put(`key:${prefix}`, JSON.stringify(value), {
            expirationTtl: ttlSeconds,
        });
    }

    async delete(prefix: string) {
        await this.kv.delete(`key:${prefix}`);
    }
}
