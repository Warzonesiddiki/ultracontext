import { Hono } from 'hono';

import type { KeyCache } from './cache/types';
import { registerAuthMiddleware } from './middleware/auth';
import { corsMiddleware } from './middleware/cors';
import { databaseMiddleware } from './middleware/database';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { MemoryRateLimiter } from './rate-limit/memory';
import { RATE_LIMITS, clientIp, type RateLimiter } from './rate-limit/types';
import { registerContextRoutes } from './routes/contexts';
import { registerKeyRoutes } from './routes/keys';
import { registerMcpRoutes } from './routes/mcp';
import { registerRootRoutes } from './routes/root';
import { registerRequestObservability } from './middleware/request-id';
import type { StorageAdapter } from '@ultracontext/core';
import type { ApiConfig } from './types/api';
import type { AppEnv, HttpMiddleware } from './types/http';

// -- app factory --------------------------------------------------------------

export type AppOptions = {
    config: ApiConfig;
    storage: StorageAdapter;
    keyCache?: KeyCache;
    /**
     * Abuse protection only — UltraContext is free and unmetered. Omit to use an
     * in-memory limiter; pass `null` to disable entirely (self-hosted default if
     * RATE_LIMIT_DISABLED is set).
     */
    rateLimiter?: RateLimiter | null;
    /** disable all rate limiting regardless of limiter */
    rateLimitDisabled?: boolean;
};

export function createApp(options: AppOptions) {
    const app = new Hono<AppEnv>();

    const disabled = options.rateLimitDisabled || options.rateLimiter === null;
    const limiter: RateLimiter | null = disabled ? null : (options.rateLimiter ?? new MemoryRateLimiter());
    const skip = () => limiter === null;

    // request id + access log run first: every downstream middleware and
    // route sees the id, and the log line spans the full request
    registerRequestObservability(app);
    app.use('*', corsMiddleware);
    app.use('*', databaseMiddleware(options.storage, options.config));

    // -- abuse protection (free tier is not a metered tier) --------------------
    // NOTE: Hono matches '/contexts*' against '/contexts/…' but NOT bare
    // '/contexts', so every limiter is registered on both patterns — the same
    // approach the auth middleware already uses.
    if (limiter) {
        const perKey = rateLimitMiddleware({
            limiter,
            limit: RATE_LIMITS.GLOBAL_PER_KEY.limit,
            windowMs: RATE_LIMITS.GLOBAL_PER_KEY.windowMs,
            keyFor: (c) => {
                const auth = c.get('auth') as { apiKeyId?: number } | undefined;
                return auth?.apiKeyId !== undefined ? `key:${auth.apiKeyId}` : `ip:${clientIp(c)}`;
            },
        });

        // per IP — also throttles credential stuffing, since every attempt
        // (successful or not) spends from the same bucket
        const perIp = rateLimitMiddleware({ limiter, limit: 300, windowMs: 60_000, skip });

        // project + key creation is expensive — keep it tight. POST-only so
        // list/revoke (read-mostly admin ops) ride on the per-IP backstop.
        // Its own key namespace: buckets are shared per key STRING, so
        // reusing the bare client IP would let perIp traffic eat the
        // creation budget (or vice versa).
        const keyCreate = rateLimitMiddleware({
            limiter,
            limit: RATE_LIMITS.KEY_CREATE_PER_IP.limit,
            windowMs: RATE_LIMITS.KEY_CREATE_PER_IP.windowMs,
            keyFor: (c) => `keycreate:${clientIp(c)}`,
            skip: (c) => limiter === null || c.req.method !== 'POST',
        });

        // failed admin-token guesses — tighter than the general per-IP
        // bucket, so an offline brute-force against ULTRACONTEXT_ADMIN_KEY
        // is throttled hard. Runs OUTSIDE the auth middleware: it only
        // charges the bucket when auth actually returned 401.
        const authFailureGuard: HttpMiddleware = async (c, next) => {
            await next();
            if (c.res.status !== 401) return;

            let decision;
            try {
                decision = await limiter.consume(
                    `authfail:${clientIp(c)}`,
                    RATE_LIMITS.AUTH_FAILURE_PER_IP.limit,
                    RATE_LIMITS.AUTH_FAILURE_PER_IP.windowMs
                );
            } catch {
                return; // fail open — a limiter bug must not break auth
            }

            if (decision.allowed) return;

            // Hono note: returning a new response after `await next()` is
            // IGNORED — the replacement must be assigned to c.res.
            const throttled = c.json(
                {
                    error: 'Too many failed authentication attempts',
                    detail: 'UltraContext is free and unmetered — this limit protects against abuse, not usage. Retry shortly.',
                    retry_after_sec: decision.retryAfterSec,
                },
                429
            );
            throttled.headers.set('RateLimit-Limit', String(decision.limit));
            throttled.headers.set('RateLimit-Remaining', '0');
            throttled.headers.set('RateLimit-Reset', String(Math.ceil(decision.resetAt / 1000)));
            throttled.headers.set('Retry-After', String(decision.retryAfterSec));
            c.res = throttled;
        };

        for (const p of ['/contexts', '/contexts/*', '/mcp', '/v1/keys', '/v1/keys/*']) {
            app.use(p, perKey);
            app.use(p, perIp);
        }
        // key lifecycle (create/rotate) — tight per-IP bucket
        app.use('/v1/keys', keyCreate);
        app.use('/v1/keys/*', keyCreate);
        // registered before the auth middleware so it wraps the 401s
        app.use('/v1/keys', authFailureGuard);
        app.use('/v1/keys/*', authFailureGuard);
    }

    registerAuthMiddleware(app, { keyCache: options.keyCache });
    registerRootRoutes(app);
    registerKeyRoutes(app, { keyCache: options.keyCache });
    registerContextRoutes(app);
    registerMcpRoutes(app);

    return app;
}
