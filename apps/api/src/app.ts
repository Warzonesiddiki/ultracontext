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
import type { StorageAdapter } from '@ultracontext/core';
import type { ApiConfig } from './types/api';
import type { AppEnv } from './types/http';

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

        // project + key creation is expensive — keep it tight
        const keyCreate = rateLimitMiddleware({
            limiter,
            limit: RATE_LIMITS.KEY_CREATE_PER_IP.limit,
            windowMs: RATE_LIMITS.KEY_CREATE_PER_IP.windowMs,
            skip,
        });

        for (const p of ['/contexts', '/contexts/*', '/mcp']) {
            app.use(p, perKey);
            app.use(p, perIp);
        }
        app.use('/v1/keys', keyCreate);
    }

    registerAuthMiddleware(app, { keyCache: options.keyCache });
    registerRootRoutes(app);
    registerKeyRoutes(app);
    registerContextRoutes(app);
    registerMcpRoutes(app);

    return app;
}
