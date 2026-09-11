import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import { MemoryRateLimiter } from '../rate-limit/memory';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { MemoryStorage } from '@ultracontext/core/testing';
import type { StorageAdapter } from '@ultracontext/core';

// =============================================================================
// RATE LIMITING — abuse protection, not a paywall.
// These tests assert the protective behaviour AND that exceeding a limit is
// presented as "slow down", never as "upgrade".
// =============================================================================

function appWith(limiter: MemoryRateLimiter, limit: number, windowMs: number, storage?: StorageAdapter) {
    const app = new Hono();
    app.use('*', rateLimitMiddleware({ limiter, limit, windowMs }));
    app.get('/ping', (c) => c.json({ ok: true }));
    return app;
}

describe('MemoryRateLimiter', () => {
    it('allows requests under the limit and counts down', async () => {
        const limiter = new MemoryRateLimiter();

        const first = await limiter.consume('a', 3, 60_000);
        assert.equal(first.allowed, true);
        assert.equal(first.remaining, 2);

        const second = await limiter.consume('a', 3, 60_000);
        assert.equal(second.remaining, 1);
    });

    it('blocks once the limit is exceeded and reports retryAfter', async () => {
        const limiter = new MemoryRateLimiter();

        for (let i = 0; i < 3; i++) await limiter.consume('b', 3, 60_000);

        const blocked = await limiter.consume('b', 3, 60_000);
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.remaining, 0);
        assert.ok(blocked.retryAfterSec >= 1);
    });

    it('tracks keys independently', async () => {
        const limiter = new MemoryRateLimiter();

        for (let i = 0; i < 2; i++) await limiter.consume('one', 2, 60_000);
        assert.equal((await limiter.consume('one', 2, 60_000)).allowed, false);

        // a different key is unaffected
        assert.equal((await limiter.consume('two', 2, 60_000)).allowed, true);
    });

    it('resets after the window rolls over', async () => {
        const limiter = new MemoryRateLimiter();

        await limiter.consume('c', 1, 10);
        assert.equal((await limiter.consume('c', 1, 10)).allowed, false);

        await new Promise((r) => setTimeout(r, 25));
        assert.equal((await limiter.consume('c', 1, 10)).allowed, true);
    });

    it('does not grow without bound', async () => {
        const limiter = new MemoryRateLimiter();
        for (let i = 0; i < 12_000; i++) await limiter.consume(`k${i}`, 10, 60_000);
        assert.ok(limiter.size <= 10_000, `tracked ${limiter.size} keys, expected <= 10000`);
    });
});

describe('rateLimitMiddleware', () => {
    it('returns 429 with Retry-After once exceeded', async () => {
        const app = appWith(new MemoryRateLimiter(), 2, 60_000);

        assert.equal((await app.request('/ping')).status, 200);
        assert.equal((await app.request('/ping')).status, 200);

        const blocked = await app.request('/ping');
        assert.equal(blocked.status, 429);
        assert.ok(blocked.headers.get('Retry-After'));
    });

    it('emits standard RateLimit headers on allowed requests', async () => {
        const app = appWith(new MemoryRateLimiter(), 5, 60_000);
        const res = await app.request('/ping');

        assert.equal(res.headers.get('RateLimit-Limit'), '5');
        assert.equal(res.headers.get('RateLimit-Remaining'), '4');
        assert.ok(res.headers.get('RateLimit-Reset'));
    });

    it('frames the 429 as abuse protection, not as a paywall', async () => {
        const app = appWith(new MemoryRateLimiter(), 1, 60_000);
        await app.request('/ping');
        const blocked = await app.request('/ping');

        const body = (await blocked.json()) as { error: string; detail: string };
        assert.match(body.error, /rate limit/i);
        assert.match(body.detail, /free/i);
        assert.doesNotMatch(body.detail, /upgrade|plan|pricing|tier/i);
    });

    it('fails open when the limiter throws (never takes the API down)', async () => {
        const broken = {
            consume: async () => {
                throw new Error('limiter exploded');
            },
        };

        const app = new Hono();
        app.use('*', rateLimitMiddleware({ limiter: broken as never, limit: 1, windowMs: 60_000 }));
        app.get('/ping', (c) => c.json({ ok: true }));

        const res = await app.request('/ping');
        assert.equal(res.status, 200);
    });
});
