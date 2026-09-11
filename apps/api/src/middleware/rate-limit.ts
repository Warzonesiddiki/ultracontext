import type { RateLimiter } from '../rate-limit/types';
import { clientIp } from '../rate-limit/types';
import type { HttpContext, HttpMiddleware } from '../types/http';

// =============================================================================
// RATE LIMIT MIDDLEWARE
// =============================================================================
// Protection, not monetisation. UltraContext has no paid tier, so exceeding a
// limit means "slow down", never "upgrade".

export type RateLimitOptions = {
    limiter: RateLimiter;
    limit: number;
    windowMs: number;
    /** bucket key — defaults to the client IP */
    keyFor?: (c: HttpContext) => string;
    /** skip when true (e.g. disabled in self-hosted deployments) */
    skip?: (c: HttpContext) => boolean;
};

function standardHeaders(c: HttpContext, decision: { limit: number; remaining: number; resetAt: number }) {
    c.header('RateLimit-Limit', String(decision.limit));
    c.header('RateLimit-Remaining', String(Math.max(0, decision.remaining)));
    c.header('RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
}

export function rateLimitMiddleware(options: RateLimitOptions): HttpMiddleware {
    const { limiter, limit, windowMs } = options;
    const keyFor = options.keyFor ?? ((c: HttpContext) => clientIp(c));

    return async (c, next) => {
        if (options.skip?.(c)) return next();

        let decision;
        try {
            decision = await limiter.consume(keyFor(c as HttpContext), limit, windowMs);
        } catch {
            // limiter blew up — fail open so a bug here can never cause an outage
            return next();
        }

        standardHeaders(c as HttpContext, decision);

        if (!decision.allowed) {
            c.header('Retry-After', String(decision.retryAfterSec));
            return c.json(
                {
                    error: 'Rate limit exceeded',
                    // explicit, because the obvious assumption is a paywall
                    detail: 'UltraContext is free and unmetered — this limit protects against abuse, not usage. Retry shortly.',
                    retry_after_sec: decision.retryAfterSec,
                },
                429
            );
        }

        return next();
    };
}
