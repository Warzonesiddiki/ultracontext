// =============================================================================
// CORS — origin allowlist (SEC-002)
// =============================================================================
// The old wildcard (Access-Control-Allow-Origin: *) let ANY website make
// cross-origin calls against the API. It is replaced by an explicit allowlist:
//   1. loopback origins (http/https on localhost / 127.0.0.1 / ::1, any port)
//      — the product is local-first and the server binds to 127.0.0.1, so only
//      code that already reaches the loopback interface can reach the API.
//      This keeps local dashboards and dev UIs working with zero config.
//   2. exact origins listed in ULTRACONTEXT_CORS_ORIGINS
//      (comma-separated, e.g. "https://dash.example.com,http://lb:9000").
//      A bare "*" entry is ignored on purpose — that is the hole SEC-002 closes.
//
// Any other origin (and a missing Origin) receives NO
// Access-Control-Allow-Origin header, so browsers block the response.

import type { HttpMiddleware } from '../types/http';

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';
const MAX_AGE = '86400';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackOrigin(origin: string): boolean {
    try {
        const u = new URL(origin);
        return (u.protocol === 'http:' || u.protocol === 'https:') && LOOPBACK_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
}

/**
 * Decide whether an Origin may use CORS against this API.
 * `env` defaults to process.env (tests inject their own).
 */
export function corsAllowed(origin: string | undefined | null, env: Record<string, string | undefined> = process.env): boolean {
    if (!origin || origin === 'null') return false;
    if (isLoopbackOrigin(origin)) return true;

    const raw = String(env.ULTRACONTEXT_CORS_ORIGINS ?? '').trim();
    if (!raw) return false;

    for (const part of raw.split(',')) {
        const candidate = part.trim();
        if (!candidate || candidate === '*') continue; // never re-open the wildcard
        if (candidate === origin) return true;
    }
    return false;
}

export const corsMiddleware: HttpMiddleware = async (c, next) => {
    c.header('Vary', 'Origin');

    const origin = c.req.header('origin');
    if (origin && corsAllowed(origin)) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
        c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        c.header('Access-Control-Max-Age', MAX_AGE);
    }
    // disallowed / absent origin: no ACAO header — the browser blocks the read

    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
};
