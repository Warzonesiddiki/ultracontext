// =============================================================================
// AUDIT TRAIL — durable record for permanent deletes (API-011)
// =============================================================================
// A permanent delete is irreversible, so the operation must leave a durable,
// append-only record persisted BEFORE the wipe. These tests pin:
//   - the record is written (real file sink, fsync'd) with request correlation
//   - FAIL CLOSED: if the record cannot be persisted, the delete is aborted
//     (500, code 'internal') and the context still exists
//   - append-only: one line per permanent delete
//   - soft (message) deletes write no record
//   - default path resolution + $ULTRACONTEXT_AUDIT_LOG override

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateKey, hashKey, KEY_PREFIX_LEN } from '@ultracontext/core';
import { MemoryStorage } from '@ultracontext/core/testing';
import { createApp } from '../app';
import {
    AUDIT_LOG_FILE_NAME,
    defaultAuditLogPath,
    FileAuditSink,
    InMemoryAuditSink,
    resolveDefaultAuditSink,
    type AuditSink,
    type PermanentDeleteAuditEntry,
} from '../audit/permanent-delete';
import type { ApiConfig } from '../types/api';

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

type Req = (method: string, path: string, body?: unknown) => Promise<Response>;

async function setupTestApp(auditSink?: AuditSink) {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage, auditSink });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    await storage.insertApiKey({
        project_id: project!.id,
        key_prefix: apiKey.slice(0, KEY_PREFIX_LEN),
        key_hash: await hashKey(apiKey),
    });

    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    const req: Req = async (method, p, body) => {
        const init: RequestInit = { method, headers: { ...headers } };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        } else if (method === 'DELETE') {
            // no body — drop Content-Type (a bodyless DELETE is a permanent delete)
            init.headers = { Authorization: headers.Authorization };
        }
        return app.request(`http://localhost${p}`, init) as unknown as Response;
    };

    return { app, storage, req, apiKey, projectId: project!.id };
}

async function makeContext(req: Req): Promise<string> {
    const res = await req('POST', '/contexts', { metadata: { name: 't' } });
    assert.equal(res.status, 201);
    return ((await res.json()) as { id: string }).id;
}

// each file-sink test gets its own temp file — no cross-test state
async function tempAuditFile(): Promise<{ file: string; dir: string }> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'uc-audit-'));
    return { file: path.join(dir, AUDIT_LOG_FILE_NAME), dir };
}

describe('permanent delete audit trail (file sink)', () => {
    it('persists a durable JSONL record before the wipe, with request correlation', async () => {
        const { file, dir } = await tempAuditFile();
        try {
            const sink = new FileAuditSink(file);
            const { req, projectId } = await setupTestApp(sink);
            const id = await makeContext(req);
            await req('POST', `/contexts/${id}`, { role: 'user', content: 'hi' });

            const res = await req('DELETE', `/contexts/${id}`, {
                permanent: true,
                metadata: { reason: 'cleanup', ticket: 'JIRA-123' },
            });
            assert.equal(res.status, 200);
            const body = (await res.json()) as { deleted: boolean };
            assert.equal(body.deleted, true);

            // the context is really gone
            const gone = await req('GET', `/contexts/${id}`);
            assert.equal(gone.status, 404);

            // the durable record exists with the right fields
            const text = await readFile(file, 'utf8');
            assert.equal(text.trim().split('\n').length, 1);
            const entry = JSON.parse(text.trim()) as PermanentDeleteAuditEntry;
            assert.equal(entry.event, 'permanent_delete');
            assert.equal(entry.context_id, id);
            assert.equal(entry.project_id, projectId);
            assert.deepEqual(entry.metadata, { reason: 'cleanup', ticket: 'JIRA-123' });
            assert.ok(!Number.isNaN(Date.parse(entry.ts)), 'ts is a valid timestamp');
            // correlates with the X-Request-Id response header (API-008)
            assert.equal(entry.request_id, res.headers.get('x-request-id'));
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('is append-only: one line per permanent delete, in order', async () => {
        const { file, dir } = await tempAuditFile();
        try {
            const { req } = await setupTestApp(new FileAuditSink(file));
            const a = await makeContext(req);
            const b = await makeContext(req);
            await req('DELETE', `/contexts/${a}`, { permanent: true });
            await req('DELETE', `/contexts/${b}`, { permanent: true });

            const lines = (await readFile(file, 'utf8')).trim().split('\n');
            assert.equal(lines.length, 2);
            const ids = lines.map((l) => (JSON.parse(l) as PermanentDeleteAuditEntry).context_id);
            assert.deepEqual(ids, [a, b]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('permanent delete audit trail (fail-closed + scoping)', () => {
    it('aborts the delete when the record cannot be persisted (500, context intact)', async () => {
        const sink = new InMemoryAuditSink();
        sink.failWith = new Error('disk full');
        const { req } = await setupTestApp(sink);
        const id = await makeContext(req);

        const res = await req('DELETE', `/contexts/${id}`, { permanent: true });
        assert.equal(res.status, 500);
        const body = (await res.json()) as { code: string; error: string };
        assert.equal(body.code, 'internal');
        assert.match(body.error, /audit record/i);

        // nothing was deleted
        const still = await req('GET', `/contexts/${id}`);
        assert.equal(still.status, 200);
        assert.equal(sink.entries.length, 0);
    });

    it('writes no record for soft (message) deletes', async () => {
        const sink = new InMemoryAuditSink();
        const { req } = await setupTestApp(sink);
        const id = await makeContext(req);
        await req('POST', `/contexts/${id}`, { role: 'user', content: 'hi' });
        // soft-delete the first message by index
        const res = await req('DELETE', `/contexts/${id}`, { ids: 0 });
        assert.equal(res.status, 200);
        assert.equal(sink.entries.length, 0);
    });

    it('omits the metadata key when the caller supplies none', async () => {
        const sink = new InMemoryAuditSink();
        const { req, projectId } = await setupTestApp(sink);
        const id = await makeContext(req);

        const res = await req('DELETE', `/contexts/${id}`, { permanent: true });
        assert.equal(res.status, 200);
        assert.equal(sink.entries.length, 1);
        const entry = sink.entries[0];
        assert.equal(entry.event, 'permanent_delete');
        assert.equal(entry.context_id, id);
        assert.equal(entry.project_id, projectId);
        assert.ok(!('metadata' in entry));
    });

    it('still echoes caller metadata in the response (contract unchanged)', async () => {
        const sink = new InMemoryAuditSink();
        const { req } = await setupTestApp(sink);
        const id = await makeContext(req);

        const res = await req('DELETE', `/contexts/${id}`, {
            permanent: true,
            metadata: { reason: 'cleanup' },
        });
        const body = (await res.json()) as { deleted: boolean; metadata?: Record<string, unknown> };
        assert.equal(body.deleted, true);
        assert.deepEqual(body.metadata, { reason: 'cleanup' });
    });
});

describe('default audit path resolution', () => {
    it('sqlite: beside the database file', () => {
        const cfg: ApiConfig = {
            DATABASE_PROVIDER: 'sqlite',
            DATABASE_FILE: '/var/lib/uc/ultracontext.db',
            ULTRACONTEXT_ADMIN_KEY: 'k',
        };
        assert.equal(defaultAuditLogPath(cfg), path.join('/var/lib/uc', AUDIT_LOG_FILE_NAME));
    });

    it('postgres/supabase: under ~/.ultracontext', () => {
        const cfg: ApiConfig = {
            DATABASE_PROVIDER: 'postgres',
            DATABASE_URL: 'postgres://x',
            ULTRACONTEXT_ADMIN_KEY: 'k',
        };
        const p = defaultAuditLogPath(cfg);
        assert.ok(p.includes('.ultracontext'), p);
        assert.ok(p.endsWith(AUDIT_LOG_FILE_NAME));
    });

    it('$ULTRACONTEXT_AUDIT_LOG overrides the default', () => {
        const prev = process.env.ULTRACONTEXT_AUDIT_LOG;
        try {
            process.env.ULTRACONTEXT_AUDIT_LOG = '/custom/audit.jsonl';
            const cfg: ApiConfig = {
                DATABASE_PROVIDER: 'postgres',
                DATABASE_URL: 'postgres://x',
                ULTRACONTEXT_ADMIN_KEY: 'k',
            };
            const sink = resolveDefaultAuditSink(cfg) as FileAuditSink;
            assert.equal(sink.filePath, '/custom/audit.jsonl');
        } finally {
            if (prev === undefined) delete process.env.ULTRACONTEXT_AUDIT_LOG;
            else process.env.ULTRACONTEXT_AUDIT_LOG = prev;
        }
    });
});
