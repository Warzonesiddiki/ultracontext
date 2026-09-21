import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { generatePublicId } from '../public-ids';
import { buildNodeInsertRecords, findHead, getOrderedNodes } from '../context-chain';
import { createContext } from './create-context';

// -- helpers ------------------------------------------------------------------
// Append a new version head + copied message nodes onto an existing root, so
// version-selection branches can be exercised without calling sibling ops.

async function addVersion(storage: MemoryStorage, projectId: number, rootId: string, messages: object[]) {
    // create the new version head linked off the current head
    const currentHead = await findHead(storage, rootId);
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: currentHead ? currentHead.public_id : null,
        content: {},
        metadata: { operation: 'update' },
    });

    // copy message nodes under the new head
    const nodeInputs = messages.map((m) => ({ type: 'message', content: m as Record<string, unknown>, metadata: {} }));
    const insertRecords = buildNodeInsertRecords(nodeInputs, projectId, headId, null);
    await storage.insertNodes(insertRecords);

    return headId;
}

// -- create-context behavior --------------------------------------------------

describe('createContext', () => {
    // -- simple create (no fork) ----------------------------------------------

    it('creates a root context and initial head with no source', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, {});

        // success result shape
        assert.equal(result.ok, true);
        if (result.ok) {
            assert.match(result.data.id, /^ctx_/);
            assert.deepEqual(result.data.metadata, {});
            assert.equal(typeof result.data.created_at, 'string');
        }
    });

    it('persists the root node and an initial head with operation: create', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, {});
        assert.equal(result.ok, true);
        if (!result.ok) return;

        // root node exists with context_id null and parent_id null
        const root = storage.getNodesByPublicId(result.data.id);
        assert.ok(root);
        assert.equal(root!.context_id, null);
        assert.equal(root!.parent_id, null);
        assert.equal(root!.type, 'context');

        // exactly one head exists, with operation: create metadata
        const head = await findHead(storage, result.data.id);
        assert.ok(head);
        const headNode = storage.getNodesByPublicId(head!.public_id);
        assert.deepEqual(headNode!.metadata, { operation: 'create', child_count: 0 });
    });

    it('stores provided metadata on the root node', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { metadata: { source: 'cli' } });

        assert.equal(result.ok, true);
        if (result.ok) {
            assert.deepEqual(result.data.metadata, { source: 'cli' });
        }
    });

    // -- require-from validation ----------------------------------------------

    it('rejects version without from', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { version: 0 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'version, at, and before require from');
        }
    });

    it('rejects at without from', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { at: 0 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'version, at, and before require from');
        }
    });

    it('rejects before without from', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { before: '2099-01-01T00:00:00Z' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'version, at, and before require from');
        }
    });

    // -- invalid timestamp ----------------------------------------------------
    // Timestamp parsing happens before the require-from check, so a bad
    // timestamp wins even when from is absent.

    it('rejects an unparseable before timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { from: 'ctx_whatever', before: 'not-a-date' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid timestamp format');
        }
    });

    // -- source not found -----------------------------------------------------

    it('returns not_found when the source context does not exist', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        const result = await createContext(storage, project!.id, { from: 'ctx_missing' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Source context not found');
        }
    });

    // -- fork copies source nodes ---------------------------------------------

    it('forks a source context and copies its message nodes', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, {
            messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }],
        });

        const result = await createContext(storage, project!.id, { from: seed.rootId });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // forked root records its source via parent_id
        const root = storage.getNodesByPublicId(result.data.id);
        assert.equal(root!.parent_id, seed.rootId);

        // copied nodes match source content, in order, parented to the source nodes
        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.equal(copied.length, 2);
        assert.deepEqual(copied.map((n) => n.content), [
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
        ]);
        assert.deepEqual(copied.map((n) => n.parent_id), seed.messageIds);
    });

    it('forks a source context with zero messages (empty head)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, {});

        const result = await createContext(storage, project!.id, { from: seed.rootId });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        // new head exists but holds no message nodes
        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.equal(copied.length, 0);
    });

    // -- version selection ----------------------------------------------------

    it('forks a specific version by index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0-msg' }] });
        await addVersion(storage, project!.id, seed.rootId, [{ text: 'v1-msg-a' }, { text: 'v1-msg-b' }]);

        // version 0 is the original create head — fork it
        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 0 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'v0-msg' }]);
    });

    it('forks a later version by index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0-msg' }] });
        await addVersion(storage, project!.id, seed.rootId, [{ text: 'v1-msg-a' }, { text: 'v1-msg-b' }]);

        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 1 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'v1-msg-a' }, { text: 'v1-msg-b' }]);
    });

    it('returns not_found for an out-of-range version index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, version: 99 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Version not found');
        }
    });

    it('forks from a negative version index counted back from the head (ARCH-001)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'v0-msg' }] });
        await addVersion(storage, project!.id, seed.rootId, [{ text: 'v1-msg' }]);

        // -1 = the latest version (git / Python style)
        const result = await createContext(storage, project!.id, { from: seed.rootId, version: -1 });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'v1-msg' }]);

        // …but not past the start of the chain
        const tooFar = await createContext(storage, project!.id, { from: seed.rootId, version: -99 });
        assert.equal(tooFar.ok, false);
        if (!tooFar.ok) {
            assert.equal(tooFar.code, 'not_found');
            assert.equal(tooFar.message, 'Version not found');
        }
    });

    it('rejects malformed versions with no parseInt leak (API-002, ARCH-001 codes)', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        // Non-integer NUMBERS are unambiguously malformed → invalid_input (400).
        for (const bad of [1.9, NaN, Infinity, '']) {
            const result = await createContext(storage, project!.id, { from: seed.rootId, version: bad });
            assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
            if (!result.ok) assert.equal(result.code, 'invalid_input');
        }

        // Non-integer STRINGS are immutable version ids (ARCH-001): unknown id →
        // not_found (404), never a silently-resolved index.
        for (const unknown of ['abc', '1abc', '1.9', ' 1 ', 'ctx_doesnotexist']) {
            const result = await createContext(storage, project!.id, { from: seed.rootId, version: unknown });
            assert.equal(result.ok, false, `should reject ${JSON.stringify(unknown)}`);
            if (!result.ok) assert.equal(result.code, 'not_found');
        }
    });

    // -- before-timestamp version selection -----------------------------------

    it('forks the version at-or-before a timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        // a far-future cutoff includes every existing version + node
        const result = await createContext(storage, project!.id, { from: seed.rootId, before: '2099-01-01T00:00:00Z' });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'm0' }]);
    });

    it('filters copied nodes to those at-or-before the timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }, { text: 'm1' }] });

        // a far-past cutoff drops every node created after it
        const result = await createContext(storage, project!.id, { from: seed.rootId, before: '1970-01-01T00:00:00Z' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'No version found before timestamp');
        }
    });

    it('returns not_found when no version exists before the timestamp', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, before: '1971-01-01T00:00:00Z' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'No version found before timestamp');
        }
    });

    // -- at-index slicing -----------------------------------------------------

    it('slices the source nodes to the given index when forking with at', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, {
            messages: [{ text: 'm0' }, { text: 'm1' }, { text: 'm2' }],
        });

        // at=1 keeps nodes [0..1] inclusive
        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 1 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'm0' }, { text: 'm1' }]);
    });

    it('keeps only the first node when forking with at=0', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }, { text: 'm1' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 0 });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        const head = await findHead(storage, result.data.id);
        const copied = await getOrderedNodes(storage, result.data.id, head!.public_id);
        assert.deepEqual(copied.map((n) => n.content), [{ text: 'm0' }]);
    });

    it('returns invalid_input for an out-of-range at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 5 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid index');
        }
    });

    it('returns invalid_input for a negative at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: -1 });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid index');
        }
    });

    it('returns invalid_input for a non-numeric at index', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project!.id, { from: seed.rootId, at: 'xyz' });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'invalid_input');
            assert.equal(result.message, 'Invalid index');
        }
    });

    // -- single-statement create failure (DATA-001) ---------------------------
    // root + head + copies are one statement: a failure means nothing landed.
    // (previously a separate head insert could fail and orphan the root)
    // an internal error returned.

    it('returns internal when the create statement fails — nothing is written', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');

        // DATA-001: root + head + copies are one statement. A failed statement
        // means the whole create failed — there is no partial state to roll
        // back (and no separate head step to fail).
        storage.insertNodes = (async () => {
            throw new Error('boom');
        }) as typeof storage.insertNodes;

        const result = await createContext(storage, project!.id, {});

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'internal');
            assert.equal(result.message, 'Failed to create context');
        }

        // nothing landed: no root, no head, no messages
        assert.equal(storage.getAllNodes().length, 0);
        const roots = storage.getAllNodes().filter((n) => n.type === 'context' && n.context_id === null);
        assert.equal(roots.length, 0);
    });

    // -- single-statement fork failure (DATA-001) -----------------------------
    // the forked root + head + copies are one statement: a failure means the
    // source is untouched and nothing new landed
    // internal error returned.

    it('returns internal when the fork statement fails — only the seed remains', async () => {
        const storage = new MemoryStorage();
        const project = await storage.insertProject('test');
        const seed = await seedContext(storage, project!.id, { messages: [{ text: 'm0' }] });

        // DATA-001: the fork (root + head + copies) is one statement; failing
        // it leaves the seeded source untouched and writes nothing new.
        const nodesBefore = storage.getAllNodes().length;
        storage.insertNodes = (async () => {
            throw new Error('boom');
        }) as typeof storage.insertNodes;

        const result = await createContext(storage, project!.id, { from: seed.rootId });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'internal');
            assert.equal(result.message, 'Failed to create context');
        }

        // only the original seeded root remains — the fork never landed
        assert.equal(storage.getAllNodes().length, nodesBefore);
        const roots = storage.getAllNodes().filter((n) => n.type === 'context' && n.context_id === null);
        assert.deepEqual(roots.map((r) => r.public_id), [seed.rootId]);
    });
});

// -- tenant isolation (SEC-001) ------------------------------------------------

// Regression tests for the cross-tenant fork read: a fork source must be
// resolved WITHIN the caller's project. Knowing another tenant's context id
// must never be enough to read or copy it.
describe('createContext — tenant isolation (SEC-001)', () => {
    it('refuses to fork another project\'s context by id alone', async () => {
        const storage = new MemoryStorage();
        const tenantA = (await storage.insertProject('a'))!;
        const tenantB = (await storage.insertProject('b'))!;

        const secret = await seedContext(storage, tenantA.id, {
            messages: [{ role: 'user', content: 'TENANT-A-SECRET' }],
        });

        const result = await createContext(storage, tenantB.id, { from: secret.rootId });

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Source context not found');
        }

        // and no node from tenant A leaked into tenant B
        const leaked = storage
            .getAllNodes()
            .filter((n) => n.project_id === tenantB.id);
        assert.equal(leaked.length, 0);
    });

    it('refuses the version fork path across projects', async () => {
        const storage = new MemoryStorage();
        const tenantA = (await storage.insertProject('a'))!;
        const tenantB = (await storage.insertProject('b'))!;

        const seed = await seedContext(storage, tenantA.id, { messages: [{ text: 'm0' }] });
        await addVersion(storage, tenantA.id, seed.rootId, [{ text: 'm1' }]);

        const result = await createContext(storage, tenantB.id, { from: seed.rootId, version: 1 });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'not_found');
    });

    it('refuses the `before` timestamp fork path across projects', async () => {
        const storage = new MemoryStorage();
        const tenantA = (await storage.insertProject('a'))!;
        const tenantB = (await storage.insertProject('b'))!;

        const seed = await seedContext(storage, tenantA.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, tenantB.id, {
            from: seed.rootId,
            before: new Date(Date.now() + 60_000).toISOString(),
        });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'not_found');
    });

    it('refuses the `at` fork path across projects', async () => {
        const storage = new MemoryStorage();
        const tenantA = (await storage.insertProject('a'))!;
        const tenantB = (await storage.insertProject('b'))!;

        const seed = await seedContext(storage, tenantA.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, tenantB.id, { from: seed.rootId, at: 0 });
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'not_found');
    });

    it('still forks happily within the owning project', async () => {
        const storage = new MemoryStorage();
        const project = (await storage.insertProject('a'))!;

        const seed = await seedContext(storage, project.id, { messages: [{ text: 'm0' }] });

        const result = await createContext(storage, project.id, { from: seed.rootId });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        // a fork is a NEW context, not a copy of the id
        assert.notEqual(result.data.id, seed.rootId);
    });
});
