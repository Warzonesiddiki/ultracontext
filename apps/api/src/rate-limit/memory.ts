import type { RateLimitDecision, RateLimiter } from './types';

// =============================================================================
// IN-MEMORY RATE LIMITER — fixed window, bounded map (Node + single-isolate)
// =============================================================================

type Bucket = { count: number; resetAt: number };

const MAX_TRACKED_KEYS = 10_000;
const SWEEP_EVERY_MS = 60_000;

export class MemoryRateLimiter implements RateLimiter {
    private buckets = new Map<string, Bucket>();
    private lastSweep = Date.now();

    async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
        const now = Date.now();

        this.sweepIfDue(now);

        const existing = this.buckets.get(key);

        // no bucket, or the window has rolled over — start fresh
        if (!existing || existing.resetAt <= now) {
            // bound memory: refuse to track past the cap rather than grow forever
            if (this.buckets.size >= MAX_TRACKED_KEYS && !existing) {
                return { allowed: true, limit, remaining: limit, resetAt: now + windowMs, retryAfterSec: 0 };
            }

            const resetAt = now + windowMs;
            this.buckets.set(key, { count: 1, resetAt });
            return { allowed: true, limit, remaining: limit - 1, resetAt, retryAfterSec: 0 };
        }

        existing.count += 1;

        if (existing.count > limit) {
            return {
                allowed: false,
                limit,
                remaining: 0,
                resetAt: existing.resetAt,
                retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
            };
        }

        return {
            allowed: true,
            limit,
            remaining: limit - existing.count,
            resetAt: existing.resetAt,
            retryAfterSec: 0,
        };
    }

    private sweepIfDue(now: number) {
        if (now - this.lastSweep < SWEEP_EVERY_MS) return;
        this.lastSweep = now;

        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= now) this.buckets.delete(key);
        }
    }

    /** exposed for tests */
    get size() {
        return this.buckets.size;
    }
}
