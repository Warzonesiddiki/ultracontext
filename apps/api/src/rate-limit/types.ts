// =============================================================================
// RATE LIMITER — abuse protection, NOT a paywall
// =============================================================================
// UltraContext is 100% free and self-hosted. These limits exist to stop runaway
// loops, credential stuffing, and accidental self-DoS — not to meter usage or
// upsell anyone. Defaults are deliberately generous: a sync daemon polling at
// 1.5s uses ~40 requests/minute, roughly 4% of the default ceiling.
//
// There is no plan, no tier, and no quota anywhere in this codebase. Anyone who
// wants higher limits can edit RATE_LIMIT_* or self-host with them disabled.

export type RateLimitDecision = {
    allowed: boolean;
    limit: number;
    remaining: number;
    /** epoch ms when the current window rolls over */
    resetAt: number;
    /** seconds to wait before retrying (0 when allowed) */
    retryAfterSec: number;
};

export interface RateLimiter {
    /**
     * Consume one unit for `key`. Implementations must be safe to call on every
     * request and must fail OPEN — a limiter that errors must never take the
     * API down with it.
     */
    consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
}

// -- defaults -----------------------------------------------------------------

export const RATE_LIMITS = {
    /** per API key, across all endpoints */
    GLOBAL_PER_KEY: { limit: 1000, windowMs: 60_000 },
    /** per IP — project + key creation is expensive */
    KEY_CREATE_PER_IP: { limit: 10, windowMs: 60_000 },
    /** per IP — throttles credential stuffing */
    AUTH_FAILURE_PER_IP: { limit: 20, windowMs: 60_000 },
} as const;

// -- helpers ------------------------------------------------------------------

export function clientIp(c: { req: { header(name: string): string | undefined } }): string {
    // Cloudflare → standard proxy header → fallback bucket
    return (
        c.req.header('cf-connecting-ip') ??
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        c.req.header('x-real-ip') ??
        'unknown'
    );
}
