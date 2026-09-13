import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import { corsMiddleware, corsAllowed, isLoopbackOrigin } from '../middleware/cors';

// =============================================================================
// CORS origin allowlist (SEC-002)
// Acceptance: a request with Origin: https://evil.example receives no
// Access-Control-Allow-Origin header.
// =============================================================================

function makeApp() {
    const app = new Hono();
    app.use('*', corsMiddleware);
    app.get('/ping', (c) => c.json({ ok: true }));
    return app;
}

describe('isLoopbackOrigin', () => {
    it('accepts http/https on loopback hosts, any port', () => {
        assert.equal(isLoopbackOrigin('http://localhost:3000'), true);
        assert.equal(isLoopbackOrigin('http://127.0.0.1:8787'), true);
        assert.equal(isLoopbackOrigin('https://localhost:443'), true);
        assert.equal(isLoopbackOrigin('https://[::1]:9443'), true);
    });

    it('rejects everything else (incl. lookalikes and null)', () => {
        assert.equal(isLoopbackOrigin('https://evil.example'), false);
        assert.equal(isLoopbackOrigin('http://localhost.evil.example'), false);
        assert.equal(isLoopbackOrigin('http://127.0.0.2:80'), false);
        assert.equal(isLoopbackOrigin('ftp://localhost:21'), false);
        assert.equal(isLoopbackOrigin('not a url'), false);
        assert.equal(isLoopbackOrigin('null'), false);
    });
});

describe('corsAllowed', () => {
    it('allows loopback origins by default', () => {
        assert.equal(corsAllowed('http://localhost:3000', {}), true);
        assert.equal(corsAllowed('http://127.0.0.1:9999', {}), true);
    });

    it('rejects external origins by default (acceptance criterion)', () => {
        assert.equal(corsAllowed('https://evil.example', {}), false);
        assert.equal(corsAllowed(undefined, {}), false);
        assert.equal(corsAllowed(null, {}), false);
        assert.equal(corsAllowed('', {}), false);
        assert.equal(corsAllowed('null', {}), false);
    });

    it('honours ULTRACONTEXT_CORS_ORIGINS (exact match, comma list)', () => {
        const env = { ULTRACONTEXT_CORS_ORIGINS: 'https://dash.example.com, http://lb.local:9000' };
        assert.equal(corsAllowed('https://dash.example.com', env), true);
        assert.equal(corsAllowed('http://lb.local:9000', env), true);
        assert.equal(corsAllowed('https://evil.example', env), false);
        // prefix/suffix confusion must not match
        assert.equal(corsAllowed('https://dash.example.com.evil.example', env), false);
        assert.equal(corsAllowed('http://dash.example.com', env), false);
        // loopback stays allowed even with a configured list
        assert.equal(corsAllowed('http://127.0.0.1:1234', env), true);
    });

    it('ignores a bare * in the configured origins (never re-open the wildcard)', () => {
        assert.equal(corsAllowed('https://evil.example', { ULTRACONTEXT_CORS_ORIGINS: '*' }), false);
        assert.equal(corsAllowed('http://anything.example', { ULTRACONTEXT_CORS_ORIGINS: '*,http://anything.example' }), true);
    });
});

describe('corsMiddleware', () => {
    it('sends NO Access-Control-Allow-Origin for a disallowed origin (acceptance)', async () => {
        const app = makeApp();
        const res = await app.request('/ping', { headers: { Origin: 'https://evil.example' } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
        // and it does not advertise the API surface either
        assert.equal(res.headers.get('access-control-allow-headers'), null);
    });

    it('sends no ACAO header when there is no Origin (same-origin / non-browser)', async () => {
        const app = makeApp();
        const res = await app.request('/ping');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    it('echoes an allowed loopback origin with methods/headers', async () => {
        const app = makeApp();
        const res = await app.request('/ping', { headers: { Origin: 'http://localhost:3000' } });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:3000');
        assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
        assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'));
        assert.ok(res.headers.get('vary')?.includes('Origin'));
    });

    it('preflight: allowed origin gets CORS headers, disallowed gets 204 without ACAO', async () => {
        const app = makeApp();

        const ok = await app.request('/ping', { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5000' } });
        assert.equal(ok.status, 204);
        assert.equal(ok.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5000');
        assert.ok(ok.headers.get('access-control-allow-methods'));

        const bad = await app.request('/ping', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
        assert.equal(bad.status, 204);
        assert.equal(bad.headers.get('access-control-allow-origin'), null);
    });

    it('supports configured origins end-to-end (env)', async () => {
        const prev = process.env.ULTRACONTEXT_CORS_ORIGINS;
        process.env.ULTRACONTEXT_CORS_ORIGINS = 'https://dash.example.com';
        try {
            const app = makeApp();
            const res = await app.request('/ping', { headers: { Origin: 'https://dash.example.com' } });
            assert.equal(res.headers.get('access-control-allow-origin'), 'https://dash.example.com');

            const blocked = await app.request('/ping', { headers: { Origin: 'https://evil.example' } });
            assert.equal(blocked.headers.get('access-control-allow-origin'), null);
        } finally {
            if (prev === undefined) delete process.env.ULTRACONTEXT_CORS_ORIGINS;
            else process.env.ULTRACONTEXT_CORS_ORIGINS = prev;
        }
    });
});
