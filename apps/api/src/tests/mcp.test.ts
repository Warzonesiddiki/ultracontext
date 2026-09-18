import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { KEY_PREFIX_LEN, generateKey, hashKey } from '@ultracontext/core';
import { MemoryStorage, seedContext } from '@ultracontext/core/testing';
import { createApp } from '../app';
import type { ApiConfig } from '../types/api';

// =============================================================================
// MCP — stateless streamable-HTTP endpoint on /mcp (TEST-003)
// The handler delegates to the real MCP server (ultracontext-mcp-server),
// so these tests exercise the full protocol surface: auth gate, method
// gating, initialize handshake, tools/list, tools/call against storage,
// and JSON-RPC error shapes.
// =============================================================================

const TEST_CONFIG: ApiConfig = {
    DATABASE_PROVIDER: 'postgres',
    DATABASE_URL: 'postgres://test',
    ULTRACONTEXT_ADMIN_KEY: 'test-admin-key',
};

// MCP streamable HTTP: the client must accept both application/json and
// text/event-stream on POSTs
const mcpHeaders = (auth: string) => ({
    Authorization: `Bearer ${auth}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
});

type JsonRpc = { jsonrpc: string; id: number | null; result?: any; error?: { code: number; message: string } };

async function setupTestApp() {
    const storage = new MemoryStorage();
    const app = createApp({ config: TEST_CONFIG, storage });

    const project = await storage.insertProject('test');
    const apiKey = generateKey('test');
    const prefix = apiKey.slice(0, KEY_PREFIX_LEN);
    const hash = await hashKey(apiKey);
    await storage.insertApiKey({ project_id: project!.id, key_prefix: prefix, key_hash: hash });

    // one context with one message for the tools/call tests
    const seeded = await seedContext(storage, project!.id, {
        messages: [{ role: 'user', text: 'hello mcp world' }],
        metadata: { source: 'claude' },
    });

    async function rpc(id: number, method: string, params: unknown, apiKeyOverride?: string): Promise<{ status: number; body: JsonRpc }> {
        const res = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: mcpHeaders(apiKeyOverride ?? apiKey),
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        });
        return { status: res.status, body: (await res.json()) as JsonRpc };
    }

    return { app, storage, apiKey, seeded, rpc };
}

describe('POST /mcp — handshake and discovery', () => {
    it('initialize returns server info + tool capabilities', async () => {
        const { rpc } = await setupTestApp();
        const { status, body } = await rpc(1, 'initialize', {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'probe', version: '0' },
        });
        assert.equal(status, 200);
        assert.equal(body.id, 1);
        assert.equal(body.result.serverInfo.name, 'ultracontext');
        assert.equal(typeof body.result.serverInfo.version, 'string');
        assert.equal(body.result.protocolVersion, '2025-03-26');
        assert.ok(body.result.capabilities.tools, 'tools capability advertised');
    });

    it('tools/list exposes the five context tools', async () => {
        const { rpc } = await setupTestApp();
        const { status, body } = await rpc(2, 'tools/list', {});
        assert.equal(status, 200);
        const names = body.result.tools.map((t: any) => t.name);
        assert.deepEqual(names.sort(), [
            'get_activity_stats',
            'get_context_messages',
            'get_recent_activity',
            'list_contexts',
            'search_contexts',
        ]);
    });
});

describe('POST /mcp — tools/call against storage', () => {
    it('get_context_messages returns the seeded message for the authenticated project', async () => {
        const { rpc, seeded } = await setupTestApp();
        const { status, body } = await rpc(3, 'tools/call', {
            name: 'get_context_messages',
            arguments: { context_id: seeded.rootId },
        });
        assert.equal(status, 200);
        const text = body.result.content[0].text as string;
        assert.ok(text.includes('hello mcp world'));
        assert.ok(text.includes(seeded.messageIds[0]));
    });

    it('get_context_messages reports a missing context as content, not a JSON-RPC error', async () => {
        const { rpc } = await setupTestApp();
        const { status, body } = await rpc(4, 'tools/call', {
            name: 'get_context_messages',
            arguments: { context_id: 'ctx_missing' },
        });
        assert.equal(status, 200);
        assert.equal(body.result.content[0].text, 'Context not found.');
    });

    it('list_contexts sees the seeded context', async () => {
        const { rpc, seeded } = await setupTestApp();
        const { status, body } = await rpc(5, 'tools/call', {
            name: 'list_contexts',
            arguments: {},
        });
        assert.equal(status, 200);
        assert.ok((body.result.content[0].text as string).includes(seeded.rootId));
    });

    it('search_contexts finds the seeded message text', async () => {
        const { rpc } = await setupTestApp();
        const { status, body } = await rpc(6, 'tools/call', {
            name: 'search_contexts',
            arguments: { query: 'hello mcp world' },
        });
        assert.equal(status, 200);
        assert.ok((body.result.content[0].text as string).includes('hello mcp world'));
    });
});

describe('POST /mcp — auth and protocol errors', () => {
    it('rejects a missing bearer token with 401 (auth middleware, not MCP)', async () => {
        const { app } = await setupTestApp();
        const res = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res.status, 401);
    });

    it('rejects a wrong key with 401', async () => {
        const { rpc } = await setupTestApp();
        const { status } = await rpc(2, 'initialize', {}, 'uc_live_wrong');
        assert.equal(status, 401);
    });

    it('requires the MCP Accept header on POSTs (406 without it)', async () => {
        const { app, apiKey } = await setupTestApp();
        const res = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });
        assert.equal(res.status, 406);
        const body = (await res.json()) as JsonRpc;
        assert.equal(body.error?.code, -32000);
    });

    it('returns a JSON-RPC parse error for malformed JSON', async () => {
        const { app, apiKey } = await setupTestApp();
        const res = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: mcpHeaders(apiKey),
            body: '{not json',
        });
        assert.equal(res.status, 400);
        const body = (await res.json()) as JsonRpc;
        assert.equal(body.error?.code, -32700);
    });
});

describe('GET/DELETE /mcp — method gating', () => {
    it('GET is 405 with the JSON-RPC method-not-allowed body', async () => {
        const { app, apiKey } = await setupTestApp();
        const res = await app.request('http://localhost/mcp', { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` } });
        assert.equal(res.status, 405);
        const body = (await res.json()) as JsonRpc;
        assert.equal(body.error?.code, -32000);
        assert.match(body.error?.message ?? '', /not allowed/i);
    });

    it('DELETE is 405 with the same body', async () => {
        const { app, apiKey } = await setupTestApp();
        const res = await app.request('http://localhost/mcp', { method: 'DELETE', headers: { Authorization: `Bearer ${apiKey}` } });
        assert.equal(res.status, 405);
        const body = (await res.json()) as JsonRpc;
        assert.equal(body.error?.code, -32000);
    });
});
