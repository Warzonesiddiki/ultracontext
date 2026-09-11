import type { RateLimitDecision, RateLimiter } from './types';

// =============================================================================
// KV RATE LIMITER — Cloudflare Workers KV (eventually-consistent, best effort)
// =============================================================================
// KV is eventually consistent, so a burst across isolates can briefly exceed the
// limit. That is an acceptable trade: the goal is stopping sustained abuse, not
// exact accounting. It fails open on any KV error.

export class KvRateLimiter implements RateLimiter {
    constructor(private kv: KVNamespace, private prefix = 'rl') {}

    async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
        const now = Date.now();
        const storageKey = `${this.prefix}:${key}`;
        const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

        let count = 0;
        let resetAt = now + windowMs;

        try {
            const raw = await this.kv.get(storageKey);
            if (raw) {
                const parsed = JSON.parse(raw) as { count?: number; resetAt?: number };
                if (typeof parsed.resetAt === 'number' && parsed.resetAt > now) {
                    count = typeof parsed.count === 'number' ? parsed.count : 0;
                    resetAt = parsed.resetAt;
                }
            }
        } catch {
            // unreadable bucket — start a fresh window and allow the request
        }

        count += 1;

        if (count > limit) {
            return {
                allowed: false,
                limit,
                remaining: 0,
                resetAt,
                retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)),
            };
        }

        try {
            await this.kv.put(storageKey, JSON.stringify({ count, resetAt }), {
                expirationTtl: Math.max(windowSec, 60),
            });
        } catch {
            // failed to persist — allow rather than break the request
        }

        return { allowed: true, limit, remaining: limit - count, resetAt, retryAfterSec: 0 };
    }
}
