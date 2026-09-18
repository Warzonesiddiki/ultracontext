import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { MAX_MESSAGES_PER_APPEND, MAX_MESSAGES_PER_CONTEXT } from '../constants';
import { getVersions } from '../context-chain';
import { appendMessages } from './append-messages';
import { getContext } from './get-context';
import { updateMessages } from './update-messages';

// =============================================================================
// appendMessages — behavior-preserving extraction of POST /contexts/:id
// Source of truth: apps/api/src/routes/contexts.ts (app.post('/contexts/:id'))
// =============================================================================

describe('appendMessages', () => {
    // -- success: single message object appended to empty context -------------

    it('appends a single message object and returns data + version', async () => {
        const storage = new MemoryStorage();

        // seed an empty context (root + initial head, zero messages)
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // append one message passed as a bare object (not array)
        const result = await appendMessages(storage, project!.id, rootId, { role: 'user', text: 'hi' });

        // success branch — result.ok true with data + version shape
        // the append created a new version head (PROM-002): create(0) + append(1)
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.version, 1);
        assert.equal(result.data.data.length, 1);

        // first message carries its content, generated id, index 0, default metadata
        const [msg] = result.data.data as Array<Record<string, unknown>>;
        assert.equal(msg.role, 'user');
        assert.equal(msg.text, 'hi');
        assert.equal(msg.index, 0);
        assert.match(String(msg.id), /^msg_/);
        assert.deepEqual(msg.metadata, {});
    });

    // -- success: array of messages with indices continuing past tail ---------

    it('appends an array of messages with sequential indices and persists nodes', async () => {
        const storage = new MemoryStorage();

        // seed a context that already has two messages (existingCount = 2)
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }],
        });

        // append two more messages as an array
        const result = await appendMessages(storage, project!.id, rootId, [
            { role: 'user', text: 'c' },
            { role: 'assistant', text: 'd' },
        ]);

        // success — two appended, indices continue from existing tail (2, 3)
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, 2);
        const rows = result.data.data as Array<Record<string, unknown>>;
        assert.equal(rows[0].index, 2);
        assert.equal(rows[1].index, 3);
        assert.equal(rows[0].text, 'c');
        assert.equal(rows[1].text, 'd');

        // the append created one new version head (PROM-002): create(0) + append(1)
        assert.equal(result.data.version, 1);

        // zero-copy append: the 2 seeded + 2 appended messages exist exactly once
        const messageNodes = storage.getAllNodes().filter((n) => n.type === 'message');
        assert.equal(messageNodes.length, 4);
        const contextNodes = storage.getAllNodes().filter((n) => n.type === 'context');
        assert.equal(contextNodes.length, 3); // root + create head + append head
    });

    // -- success: metadata is split out of content ----------------------------

    it('extracts metadata from each message, leaving the rest as content', async () => {
        const storage = new MemoryStorage();

        // seed empty context
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // append a message carrying both metadata and content fields
        const result = await appendMessages(storage, project!.id, rootId, {
            role: 'user',
            text: 'hello',
            metadata: { source: 'cli', tokens: 12 },
        });

        // metadata is hoisted; content excludes the metadata key
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const [msg] = result.data.data as Array<Record<string, unknown>>;
        assert.deepEqual(msg.metadata, { source: 'cli', tokens: 12 });
        assert.equal(msg.role, 'user');
        assert.equal(msg.text, 'hello');
        assert.equal('metadata' in (msg as { metadata?: unknown }) && msg.metadata !== undefined, true);
    });

    // -- success: chain ordering preserved across appends ---------------------

    it('keeps message order so a later get would read them tail-to-tail', async () => {
        const storage = new MemoryStorage();

        // seed empty context, then append three messages in one call
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);
        const result = await appendMessages(storage, project!.id, rootId, [
            { n: 1 },
            { n: 2 },
            { n: 3 },
        ]);

        // indices reflect insertion order
        assert.equal(result.ok, true);
        if (!result.ok) return;
        const rows = result.data.data as Array<Record<string, unknown>>;
        assert.deepEqual(rows.map((r) => r.n), [1, 2, 3]);
        assert.deepEqual(rows.map((r) => r.index), [0, 1, 2]);
    });

    // -- success: version reflects current head count after updates -----------

    it('reports the current version when multiple version heads exist', async () => {
        const storage = new MemoryStorage();

        // seed context then add a second version head (simulating a prior update)
        const project = await storage.insertProject('test');
        const { rootId, headId } = await seedContext(storage, project!.id, {
            messages: [{ text: 'first' }],
        });
        await storage.insertNodes({
            public_id: 'ctx_secondhead',
            project_id: project!.id,
            type: 'context',
            context_id: rootId,
            prev_id: headId,
            content: {},
            metadata: { operation: 'update', affected: [] },
        });

        // append to the latest head — the append adds a third head => version 2
        const result = await appendMessages(storage, project!.id, rootId, { text: 'next' });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.version, 2);
    });

    // -- error: context not found -> not_found (404) --------------------------

    it('returns not_found when the context does not exist', async () => {
        const storage = new MemoryStorage();

        // no context seeded for this id
        const project = await storage.insertProject('test');
        const result = await appendMessages(storage, project!.id, 'ctx_missing', { text: 'x' });

        // not_found code + exact handler message
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    // -- error: context belongs to another project -> not_found --------------

    it('returns not_found when the context belongs to a different project', async () => {
        const storage = new MemoryStorage();

        // seed under project A, query under project B
        const projectA = await storage.insertProject('a');
        const projectB = await storage.insertProject('b');
        const { rootId } = await seedContext(storage, projectA!.id);
        const result = await appendMessages(storage, projectB!.id, rootId, { text: 'x' });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'not_found');
        assert.equal(result.message, 'Context not found');
    });

    // -- error: HEAD not found -> internal (500) ------------------------------

    it('returns internal when the root exists but has no head', async () => {
        const storage = new MemoryStorage();

        // insert a root context node WITHOUT any head node under it
        const project = await storage.insertProject('test');
        await storage.insertNodes({
            public_id: 'ctx_headless',
            project_id: project!.id,
            type: 'context',
            context_id: null,
            parent_id: null,
            content: {},
            metadata: {},
        });

        // findHead returns null -> internal with exact handler message
        const result = await appendMessages(storage, project!.id, 'ctx_headless', { text: 'x' });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'HEAD not found');
    });

    // -- error: transaction failure -> internal (500) -------------------------

    it('returns internal with the append failure message when the tx throws', async () => {
        const storage = new MemoryStorage();

        // seed a valid context so we get past not_found / HEAD checks
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // force the insert of the appended messages to throw inside the tx
        const realInsert = storage.insertNodes.bind(storage);
        storage.insertNodes = async (values) => {
            const rows = Array.isArray(values) ? values : [values];
            if (rows.some((r) => r.type === 'message')) throw new Error('boom');
            return realInsert(values);
        };

        const result = await appendMessages(storage, project!.id, rootId, { text: 'x' });

        // internal code + exact handler message
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to append messages');
    });

    // -- size caps (API-004) ----------------------------------------------------

    it('rejects an append over MAX_MESSAGES_PER_APPEND and writes nothing', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        const tooMany = Array.from({ length: MAX_MESSAGES_PER_APPEND + 1 }, (_, i) => ({ text: String(i) }));
        const result = await appendMessages(storage, project!.id, rootId, tooMany);

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'invalid_input');
        assert.match(result.message, /limit of 1000 messages per append/);

        // nothing was written — the context is still at its create version
        const versions = await getVersions(storage, rootId);
        assert.equal(versions.length, 1);
    });

    it('accepts an append of exactly MAX_MESSAGES_PER_APPEND (boundary)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        const batch = Array.from({ length: MAX_MESSAGES_PER_APPEND }, (_, i) => ({ text: String(i) }));
        const result = await appendMessages(storage, project!.id, rootId, batch);

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.data.length, MAX_MESSAGES_PER_APPEND);
        assert.equal(result.data.version, 1);
    });

    it('rejects an append that would push the context past MAX_MESSAGES_PER_CONTEXT', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // one seeded head with MAX - 2 messages (cheap: a single batch insert)
        const big = Array.from({ length: MAX_MESSAGES_PER_CONTEXT - 2 }, (_, i) => ({ text: String(i) }));
        const { rootId } = await seedContext(storage, project!.id, { messages: big });

        // filling the context to exactly the cap is allowed
        const fill = await appendMessages(storage, project!.id, rootId, [{ text: 'a' }, { text: 'b' }]);
        assert.equal(fill.ok, true);

        // one more message would exceed the cap
        const over = await appendMessages(storage, project!.id, rootId, [{ text: 'c' }]);
        assert.equal(over.ok, false);
        if (over.ok) return;
        assert.equal(over.code, 'invalid_input');
        assert.match(over.message, /limit of 10000 messages \(currently 10000\)/);

        // the rejected append wrote nothing — still exactly at the cap
        const current = await getContext(storage, project!.id, rootId, {});
        assert.ok(current.ok);
        assert.equal((current.data.data as unknown[]).length, MAX_MESSAGES_PER_CONTEXT);
    });

    // -- tx failure classification (API-003) -----------------------------------

    it('maps a Postgres SSI conflict (SQLSTATE 40001) to the retryable conflict code', async () => {
        const storage = new MemoryStorage();

        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // SSI abort: the backend kills one side of the racing pair with 40001
        const conflict = Object.assign(new Error('could not serialize access due to read/write dependencies among transactions'), {
            code: '40001',
        });
        storage.transaction = async () => {
            throw conflict;
        };

        const result = await appendMessages(storage, project!.id, rootId, { text: 'x' });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'conflict');
        assert.match(result.message, /conflict/i);
    });

    it('maps a drizzle-wrapped SSI conflict (code on err.cause) to the conflict code', async () => {
        const storage = new MemoryStorage();

        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        // drizzle wraps the driver error — the 40001 code is on err.cause
        const wrapped = Object.assign(new Error('Failed query: INSERT INTO nodes'), {
            cause: Object.assign(new Error('could not serialize access'), { code: '40001' }),
        });
        storage.transaction = async () => {
            throw wrapped;
        };

        const result = await appendMessages(storage, project!.id, rootId, { text: 'x' });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'conflict');
    });

    it('maps a non-retryable transaction failure to internal (not conflict)', async () => {
        const storage = new MemoryStorage();

        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        storage.transaction = async () => {
            throw new Error('connection lost');
        };

        const result = await appendMessages(storage, project!.id, rootId, { text: 'x' });

        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.code, 'internal');
        assert.equal(result.message, 'Failed to append messages');
    });

    it('logs the underlying transaction error instead of swallowing it', async () => {
        const storage = new MemoryStorage();

        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
        storage.transaction = async () => {
            throw conflict;
        };

        // capture console.error — the raw driver error must reach the log
        const originalError = console.error;
        const logged: unknown[] = [];
        console.error = (...args: unknown[]) => {
            logged.push(args);
        };
        try {
            const result = await appendMessages(storage, project!.id, rootId, { text: 'x' });
            assert.equal(result.ok, false);
        } finally {
            console.error = originalError;
        }

        // the original error object (with its 40001 code) was logged
        const flat = logged.flat();
        assert.ok(flat.includes(conflict), 'expected the raw transaction error to be logged');
    });

    // -- transaction: append runs under serializable isolation ----------------

    it('invokes the storage transaction with serializable isolation', async () => {
        const storage = new MemoryStorage();

        // capture the options passed to transaction()
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);
        let capturedOptions: unknown;
        const realTransaction = storage.transaction.bind(storage);
        storage.transaction = async (fn, options) => {
            capturedOptions = options;
            return realTransaction(fn, options);
        };

        await appendMessages(storage, project!.id, rootId, { text: 'x' });

        // the op must request serializable isolation, like the handler
        assert.deepEqual(capturedOptions, { isolationLevel: 'serializable' });
    });
});

// =============================================================================
// Version on append (PROM-002) — every append is a new, meaningful version.
// A captured (append-only) session gains multiple versions, and
// ?version=N / ?history=true are meaningful for it.
// =============================================================================

describe('version on append (PROM-002)', () => {
    it('creates one new version per append batch', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        await appendMessages(storage, project!.id, rootId, { text: 'a' });
        await appendMessages(storage, project!.id, rootId, { text: 'b' });
        await appendMessages(storage, project!.id, rootId, { text: 'c' });

        const versions = await getVersions(storage, rootId);
        // create(0) + three appends(1,2,3)
        assert.equal(versions.length, 4);
        assert.deepEqual(versions.map((v) => v.operation), ['create', 'append', 'append', 'append']);
    });

    it('makes ?version=N and ?history=true meaningful for an append-only session', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id);

        await appendMessages(storage, project!.id, rootId, { text: 'a' });
        await appendMessages(storage, project!.id, rootId, { text: 'b' });
        await appendMessages(storage, project!.id, rootId, { text: 'c' });

        // time-travel: each version sees exactly the messages up to that point
        const v0 = await getContext(storage, project!.id, rootId, { version: 0 });
        assert.ok(v0.ok);
        assert.deepEqual((v0.data.data as unknown as Array<{ text: string }>).map((m) => m.text), []);

        const v1 = await getContext(storage, project!.id, rootId, { version: 1 });
        assert.ok(v1.ok);
        assert.deepEqual((v1.data.data as unknown as Array<{ text: string }>).map((m) => m.text), ['a']);

        const v2 = await getContext(storage, project!.id, rootId, { version: 2 });
        assert.ok(v2.ok);
        assert.deepEqual((v2.data.data as unknown as Array<{ text: string }>).map((m) => m.text), ['a', 'b']);

        const latest = await getContext(storage, project!.id, rootId, {});
        assert.ok(latest.ok);
        assert.equal(latest.data.version, 3);
        assert.deepEqual((latest.data.data as unknown as Array<{ text: string }>).map((m) => m.text), ['a', 'b', 'c']);

        // history lists every version with its operation
        const hist = await getContext(storage, project!.id, rootId, { history: true });
        assert.ok(hist.ok);
        assert.deepEqual(
            (hist.data.versions ?? []).map((v) => v.operation),
            ['create', 'append', 'append', 'append']
        );
    });

    it('stores each appended message exactly once (zero-copy)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {
            messages: [{ text: 'seed' }],
        });

        await appendMessages(storage, project!.id, rootId, { text: 'a' });
        await appendMessages(storage, project!.id, rootId, { text: 'b' });

        const messageNodes = storage.getAllNodes().filter((n) => n.type === 'message');
        // 1 seeded + 2 appended, each stored once — no version snapshot copies
        assert.equal(messageNodes.length, 3);
        assert.deepEqual(messageNodes.map((n) => n.content.text).sort(), ['a', 'b', 'seed']);
    });

    it('chains an append head into the previous head via prev_id', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId, headId } = await seedContext(storage, project!.id, {
            messages: [{ text: 'seed' }],
        });
        const seedMsgId = (storage.getAllNodes().find((n) => n.type === 'message') as { public_id: string }).public_id;

        await appendMessages(storage, project!.id, rootId, { text: 'next' });

        // the new head points at the create head
        const heads = (await storage.findContextBranches(rootId)) as Array<{ public_id: string; prev_id: string | null }>;
        const appendHead = heads.find((h) => h.public_id !== headId && h.prev_id === headId);
        assert.ok(appendHead, 'an append head linking to the create head exists');

        // the appended message links into the previous head's tail
        const appended = (storage.getAllNodes().find((n) => n.content?.text === 'next') as { prev_id: string | null });
        assert.equal(appended.prev_id, seedMsgId);
    });

    it('continues a snapshot created by an update', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const { rootId } = await seedContext(storage, project!.id, {
            messages: [{ text: 'a' }, { text: 'b' }],
        });

        // update message 0 → creates a snapshot version (v1)
        const upd = await updateMessages(storage, project!.id, rootId, {
            updates: [{ index: 0, text: 'A' }],
        });
        assert.ok(upd.ok);

        // append after the update → v2, cumulative over the snapshot
        await appendMessages(storage, project!.id, rootId, { text: 'c' });

        const v1 = await getContext(storage, project!.id, rootId, { version: 1 });
        assert.ok(v1.ok);
        assert.deepEqual((v1.data.data as unknown as Array<{ text: string }>).map((m) => m.text), ['A', 'b']);

        const v2 = await getContext(storage, project!.id, rootId, { version: 2 });
        assert.ok(v2.ok);
        assert.deepEqual((v2.data.data as unknown as Array<{ text: string }>).map((m) => m.text), ['A', 'b', 'c']);
    });
});
