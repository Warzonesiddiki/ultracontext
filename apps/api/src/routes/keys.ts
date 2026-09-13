// =============================================================================
// KEY ROUTES — create, list, revoke and rotate API keys (admin-only)
// =============================================================================
// Mounted on /v1/keys, which the auth middleware protects with the ADMIN
// token (not the API keys themselves — a leaked key can still be revoked).
//
// Lifecycle guarantee: a revoked key stops working immediately. The key
// row is deleted from storage AND the auth cache entry is evicted (cache
// delete is best-effort — the KV TTL of 60s is the backstop if an eviction
// write fails).

import { createKey, listKeys, revokeKey, rotateKey, resultStatus, type ErrorCode } from '@ultracontext/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HttpApp } from '../types/http';
import type { KeyCache } from '../cache/types';

// -- error status (core code -> Hono-typed HTTP status) -----------------------

const status = (code: ErrorCode) => resultStatus(code) as ContentfulStatusCode;

function parseId(raw: string): number | null {
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Evict the auth cache for a prefix. Best-effort: if the KV write fails we
 * log and continue — the storage row is already gone, and the short cache
 * TTL bounds the staleness window.
 */
async function evict(keyCache: KeyCache | undefined, prefix: string, what: string) {
    if (!keyCache) return;
    try {
        await keyCache.delete(prefix);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to evict auth cache for ${what} key ${prefix}: ${message}`);
    }
}

export function registerKeyRoutes(app: HttpApp, options?: { keyCache?: KeyCache }) {
    const keyCache = options?.keyCache;

    // create key — parse body (default {} on bad JSON), call core, map Result
    app.post('/v1/keys', async (c) => {
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => ({}));
        const { name } = body;

        const result = await createKey(storage, name);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json(result.data);
    });

    // list a project's keys — never exposes the hash
    app.get('/v1/keys/:projectId', async (c) => {
        const projectId = parseId(c.req.param('projectId'));
        if (projectId === null) return c.json({ error: 'projectId must be a positive integer' }, 400);

        const result = await listKeys(c.get('storage'), projectId);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));
        return c.json({ project_id: projectId, keys: result.data });
    });

    // revoke — the leaked-key escape hatch
    app.delete('/v1/keys/:id', async (c) => {
        const id = parseId(c.req.param('id'));
        if (id === null) return c.json({ error: 'id must be a positive integer' }, 400);

        const result = await revokeKey(c.get('storage'), id);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));

        await evict(keyCache, result.data.prefix, 'revoked');
        return c.json({ revoked: true, id });
    });

    // rotate — fresh key for the same project, old key revoked
    app.post('/v1/keys/:id/rotate', async (c) => {
        const id = parseId(c.req.param('id'));
        if (id === null) return c.json({ error: 'id must be a positive integer' }, 400);

        const result = await rotateKey(c.get('storage'), id);
        if (!result.ok) return c.json({ error: result.message }, status(result.code));

        // evict BOTH the old key's cache entry and any entry the new key may
        // have populated (same project, fresh prefix)
        await evict(keyCache, result.data.old_prefix, 'rotated-out');

        const { old_prefix, ...publicResult } = result.data;
        return c.json(publicResult);
    });
}
