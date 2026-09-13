// =============================================================================
// KEY CACHE — optional caching layer for API key lookups
// =============================================================================

export type CachedKey = {
    keyHash: string;
    apiKeyId: number;
    projectId: number;
};

export interface KeyCache {
    get(prefix: string): Promise<CachedKey | null>;
    put(prefix: string, value: CachedKey, ttlSeconds?: number): Promise<void>;
    /**
     * Invalidate a cached key. Revocation and rotation must take effect
     * immediately — a cache with a 60s TTL would otherwise keep a revoked
     * key working for up to a minute after the row is gone.
     */
    delete(prefix: string): Promise<void>;
}
