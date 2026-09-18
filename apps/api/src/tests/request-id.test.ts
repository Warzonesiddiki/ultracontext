import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

// =============================================================================
// REQUEST ID + ACCESS LOG (API-008)
// =============================================================================

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

type LogLine = Record<string, any>;

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });
    await app.request('http://localhost/contexts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
    });

    return { app, apiKey, projectId: project!.id };
}

describe('X-Request-Id header', () => {
    it('generates a UUID when no upstream id is supplied', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/');
        const id = res.headers.get('x-request-id');
        assert.ok(id, 'X-Request-Id header present');
        assert.match(id as string, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it('honours an upstream X-Request-Id', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/', { headers: { 'X-Request-Id': 'upstream-probe-123' } });
        assert.equal(res.headers.get('x-request-id'), 'upstream-probe-123');
    });

    it('rejects an oversize upstream id and generates one instead', async () => {
        const { app } = await setupTestApp();
        const tooLong = 'a'.repeat(200);
        const res = await app.request('http://localhost/', { headers: { 'X-Request-Id': tooLong } });
        const id = res.headers.get('x-request-id') as string;
        assert.notEqual(id, tooLong);
        assert.match(id, /^[0-9a-f-]{36}$/i);
    });
});

describe('access log line (JSON on stdout)', () => {
    let original: typeof console.log;
    let lines: LogLine[];

    beforeEach(() => {
        original = console.log;
        lines = [];
        console.log = (line: unknown) => {
            const text = typeof line === 'string' ? line : JSON.stringify(line);
            try {
                lines.push(JSON.parse(text));
            } catch {
                /* non-JSON log line — ignore */
            }
        };
    });

    afterEach(() => {
        console.log = original;
    });

    const requestLine = () => lines.find((l) => l.event === 'request');

    it('emits one JSON line with request_id, method, path, status, duration_ms', async () => {
        const { app } = await setupTestApp();
        lines.length = 0; // drop the setup request's line
        const res = await app.request('http://localhost/', { headers: { 'X-Request-Id': 'log-probe' } });
        assert.equal(res.status, 200);

        const line = requestLine();
        assert.ok(line, 'a request log line was emitted');
        assert.equal(line.request_id, 'log-probe');
        assert.equal(line.method, 'GET');
        assert.equal(line.path, '/');
        assert.equal(line.status, 200);
        assert.equal(typeof line.duration_ms, 'number');
        assert.ok(line.duration_ms >= 0);
    });

    it('includes project_id for authenticated routes', async () => {
        const { app, apiKey, projectId } = await setupTestApp();
        lines.length = 0; // drop the setup request's line
        const res = await app.request('http://localhost/contexts', {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        assert.equal(res.status, 200);

        const line = requestLine();
        assert.ok(line);
        assert.equal(line.project_id, projectId);
    });

    it('omits project_id for unauthenticated routes', async () => {
        const { app } = await setupTestApp();
        lines.length = 0; // drop the setup request's line
        await app.request('http://localhost/');
        const line = requestLine();
        assert.ok(line);
        assert.equal('project_id' in line, false);
    });

    it('logs failed requests with their status (401 without a project_id)', async () => {
        const { app } = await setupTestApp();
        lines.length = 0; // drop the setup request's line
        const res = await app.request('http://localhost/contexts', {
            headers: { Authorization: 'Bearer uc_live_wrong' },
        });
        assert.equal(res.status, 401);

        const line = requestLine();
        assert.ok(line);
        assert.equal(line.status, 401);
        assert.equal('project_id' in line, false);
    });

    it('emits at most one request line per request', async () => {
        const { app } = await setupTestApp();
        lines.length = 0; // drop the setup request's line
        await app.request('http://localhost/');
        assert.equal(lines.filter((l) => l.event === 'request').length, 1);
    });
});
