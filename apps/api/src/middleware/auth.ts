import { hashToken, secretsEqual, verifyKeyHash, type StorageAdapter } from '@ultracontext/core';
import type { KeyCache } from '../cache/types';
import type { HttpApp, HttpContext, HttpMiddleware } from '../types/http';

// -- helpers ------------------------------------------------------------------

function readBearerToken(c: HttpContext): string | null {
    const authorization = c.req.header('authorization');
    if (!authorization) return null;

    const [scheme, token] = authorization.split(' ');
    if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
    return token;
}

function unauthorized(c: HttpContext) {
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'Unauthorized' }, 401);
}

// -- last_used_at throttling (API-005) ------------------------------------------
//
// last_used_at is an optimization signal, not data (dashboard "last used",
// key hygiene). Updating it on every request cost an AWAITED DB round-trip
// on the latency path for 100% of traffic. So:
//   * at most one UPDATE per key per LAST_USED_AT_INTERVAL_MS;
//   * the UPDATE is fire-and-forget — scheduled before next(), never
//     awaited: a slow or failing write cannot delay or break the request.
// The last-write map is per-process module state. A multi-process deploy may
// stamp up to one extra write per process — still bounded and still orders
// of magnitude less than per-request; the value is approximate by nature.
// Revoked keys leave one stale stamp (a number) behind — negligible.

const LAST_USED_AT_INTERVAL_MS = 5 * 60 * 1000;

// now / intervalMs are parameters so the throttle window is testable
// without real-time waits; production always uses the defaults. `stamps`
// (last write per key id) is passed in so the throttle state belongs to the
// app instance that created it — per-process in the single-process deploy.
export function scheduleApiKeyLastUsedAt(
    storage: StorageAdapter,
    apiKeyId: number,
    stamps: Map<number, number>,
    now: number = Date.now(),
    intervalMs: number = LAST_USED_AT_INTERVAL_MS,
): void {
    const last = stamps.get(apiKeyId);
    if (last !== undefined && now - last < intervalMs) return;
    // Stamp at schedule time: concurrent in-flight requests inside the
    // window don't queue extra writes, and a failed write defers the next
    // attempt by a full interval — acceptable for an approximation.
    stamps.set(apiKeyId, now);
    void (async () => {
        try {
            await storage.updateApiKeyLastUsedAt(apiKeyId, new Date(now).toISOString());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`Failed to update api_keys.last_used_at for key ${apiKeyId}: ${message}`);
        }
    })();
}

function bearerAuthMiddleware(verify: (token: string, c: HttpContext) => Promise<boolean>): HttpMiddleware {
    return async (c, next) => {
        const token = readBearerToken(c as HttpContext);
        if (!token) return unauthorized(c as HttpContext);

        const ok = await verify(token, c as HttpContext);
        if (!ok) return unauthorized(c as HttpContext);

        await next();
    };
}

// -- token verification -------------------------------------------------------

function createTokenVerifier(keyCache?: KeyCache) {
    // per-app throttle state for last_used_at (API-005)
    const lastUsedAtStamps = new Map<number, number>();

    return async function verifyToken(token: string, c: HttpContext) {
        // hash once — reused for cache lookup, storage verify, and cache put
        const { prefix, hash } = await hashToken(token);

        // check cache first
        if (keyCache) {
            const cached = await keyCache.get(prefix);
            if (cached && secretsEqual(cached.keyHash, hash)) {
                c.set('auth', { apiKeyId: cached.apiKeyId, projectId: cached.projectId });
                // fire-and-forget, throttled — never on the latency path
                scheduleApiKeyLastUsedAt(c.get('storage'), cached.apiKeyId, lastUsedAtStamps);
                return true;
            }
        }

        // fallback to storage with the precomputed prefix+hash (no re-hash)
        const storage = c.get('storage');
        const verified = await verifyKeyHash(storage, prefix, hash);
        if (!verified) return false;

        c.set('auth', { apiKeyId: verified.apiKeyId, projectId: verified.projectId });

        // populate cache on success
        if (keyCache) {
            await keyCache.put(prefix, {
                keyHash: hash,
                apiKeyId: verified.apiKeyId,
                projectId: verified.projectId,
            });
        }

        // fire-and-forget, throttled — never on the latency path
        scheduleApiKeyLastUsedAt(c.get('storage'), verified.apiKeyId, lastUsedAtStamps);

        return true;
    };
}

async function verifyAdminToken(token: string, c: HttpContext) {
    const expected = c.get('config').ULTRACONTEXT_ADMIN_KEY;
    if (!expected) return false;
    // constant-time: a one-byte-off admin token must not cost less to reject
    return secretsEqual(token, expected);
}

// -- registration -------------------------------------------------------------

export type AuthOptions = {
    keyCache?: KeyCache;
};

export function registerAuthMiddleware(app: HttpApp, options?: AuthOptions) {
    const verifyToken = createTokenVerifier(options?.keyCache);

    app.use('/contexts', bearerAuthMiddleware(verifyToken));
    app.use('/contexts/*', bearerAuthMiddleware(verifyToken));
    app.use('/mcp', bearerAuthMiddleware(verifyToken));
    // admin token on the whole lifecycle surface: create on the bare path,
    // list/revoke/rotate on the subpaths
    app.use('/v1/keys', bearerAuthMiddleware(verifyAdminToken));
    app.use('/v1/keys/*', bearerAuthMiddleware(verifyAdminToken));
}
