import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import type { StorageAdapter } from '../storage';
import { appendMessages } from './append-messages';
import { updateMessages } from './update-messages';
import { deleteMessages } from './delete-messages';
import { createContext } from './create-context';
import { deleteContextPermanent } from './delete-context';
import { repairOrphanedHeads } from './repair-orphaned-heads';
import { findHead, getOrderedNodes, getVersions } from '../context-chain';

// =============================================================================
// CRASH CONSISTENCY (DATA-001) — acceptance: killing the process mid-update
// always leaves a consistent chain; never an orphaned head.
//
// A single-statement write has exactly two observable outcomes: it landed or
// it didn't. The fault-injection adapter models a process death by throwing
// at the crash point — the DB is left exactly where the interrupted
// statement would have left it.
// =============================================================================

type CrashHooks = {
    /** throw from insertNodes (process died before/while the statement ran) */
    crashOnInsert?: boolean;
    /** throw from the FIRST deleteNodesByContextId (died mid permanent-delete) */
    crashOnFirstMessageDelete?: boolean;
};

function crashAdapter(inner: MemoryStorage, hooks: CrashHooks): StorageAdapter {
    let messageDeleteFired = false;
    let proxy: StorageAdapter;
    const handler: ProxyHandler<StorageAdapter> = {
        get(target, prop) {
            // transaction() must hand the proxy to the callback, so the hooks
            // apply to the tx too
            if (prop === 'transaction') {
                const original = target.transaction.bind(target);
                // hand the proxy to the callback so the hooks apply to the tx
                return (fn: (tx: StorageAdapter) => Promise<unknown>) => original((tx: StorageAdapter) => fn(proxy));
            }
            const value = (target as unknown as Record<PropertyKey, unknown>)[prop];
            if (prop === 'insertNodes' && hooks.crashOnInsert) {
                return () => {
                    throw new Error('process killed mid-write');
                };
            }
            if (prop === 'deleteNodesByContextId' && hooks.crashOnFirstMessageDelete) {
                if (!messageDeleteFired) {
                    messageDeleteFired = true;
                    return () => {
                        throw new Error('process killed mid-delete');
                    };
                }
            }
            return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value;
        },
    };
    proxy = new Proxy(inner as unknown as StorageAdapter, handler);
    return proxy;
}

const PROJECT = 1;

async function seedContext(storage: StorageAdapter, messages: number): Promise<string> {
    const created = await createContext(
        storage,
        PROJECT,
        { metadata: { source: 'test' } },
    );
    if (!created.ok) throw new Error(`seed create failed: ${created.message}`);
    for (let i = 0; i < messages; i++) {
        const appended = await appendMessages(storage, PROJECT, created.data.id, {
            role: 'user',
            text: `message ${i}`,
        });
        if (!appended.ok) throw new Error(`seed append failed: ${appended.message}`);
    }
    return created.data.id;
}

async function assertConsistent(storage: StorageAdapter, contextId: string, expectedCount: number) {
    const root = { public_id: contextId };
    const head = await findHead(storage, contextId);
    assert.ok(head, 'a head must exist');
    const versions = await getVersions(storage, contextId);
    assert.ok(versions.length > 0, 'at least one version');
    const nodes = await getOrderedNodes(storage, root.public_id, head.public_id);
    assert.equal(nodes.length, expectedCount, 'HEAD content intact');
}

// ── crash mid-write: the op fails, the chain is untouched ───────────────────

test('append: crash before the version statement → chain unchanged, no orphaned head', async () => {
    const inner = new MemoryStorage();
    const storage = crashAdapter(inner, { crashOnInsert: true });
    const contextId = await seedContext(inner, 2); // seed on the healthy adapter

    const beforeNodes = inner.getAllNodes().length;
    const result = await appendMessages(storage, PROJECT, contextId, { role: 'user', text: 'will not land' });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'internal');

    // nothing was written: the single statement never landed
    assert.equal(inner.getAllNodes().length, beforeNodes);
    await assertConsistent(inner, contextId, 2);
});

test('update: crash before the version statement → previous head intact', async () => {
    const inner = new MemoryStorage();
    const storage = crashAdapter(inner, { crashOnInsert: true });
    const contextId = await seedContext(inner, 3);

    const beforeNodes = inner.getAllNodes().length;
    const result = await updateMessages(storage, PROJECT, contextId, { updates: [{ index: 0, text: 'changed' }] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'internal');
    assert.equal(inner.getAllNodes().length, beforeNodes);
    await assertConsistent(inner, contextId, 3);
});

test('create: crash before the create statement → no partial context at all', async () => {
    const inner = new MemoryStorage();
    const storage = crashAdapter(inner, { crashOnInsert: true });

    const result = await createContext(storage, PROJECT, {});
    assert.equal(result.ok, false);
    assert.equal(inner.getAllNodes().length, 0, 'root, head and copies all-or-nothing');
});

test('delete-all: crash before the version statement → messages still present', async () => {
    const inner = new MemoryStorage();
    const storage = crashAdapter(inner, { crashOnInsert: true });
    const contextId = await seedContext(inner, 1);

    const result = await deleteMessages(storage, PROJECT, contextId, { ids: [0] });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'internal');
    await assertConsistent(inner, contextId, 1);
});

// ── crash mid permanent-delete: never an orphaned head ──────────────────────

test('permanent delete: crash between head-delete and message-delete leaves no orphaned head', async () => {
    const inner = new MemoryStorage();
    const contextId = await seedContext(inner, 2); // create head + 2 append heads
    const healthy = new MemoryStorage();
    await seedContext(healthy, 2); // same shape, kept as the "surviving" expectation

    const storage = crashAdapter(inner, { crashOnFirstMessageDelete: true });
    const result = await deleteContextPermanent(storage, PROJECT, contextId, {});
    assert.equal(result.ok, false);
    assert.equal(result.code, 'internal');

    // every surviving version head must still own its messages
    const branches = await inner.findContextBranches(contextId);
    assert.ok(branches.length >= 1, 'some versions survive the partial delete');
    for (const branch of branches) {
        const children = await inner.findNonContextNodes(branch.public_id);
        assert.ok(children.length > 0, `head ${branch.public_id} must not be orphaned`);
    }

    // reads still work and return a coherent (if shortened) history
    const head = await findHead(inner, contextId);
    assert.ok(head, 'a readable head remains');
    const versions = await getVersions(inner, contextId);
    assert.ok(versions.length >= 1);
    const nodes = await getOrderedNodes(inner, contextId, head.public_id);
    assert.ok(Array.isArray(nodes));
});

// ── repair pass: heals damage older code left behind ─────────────────────────

test('repair: removes an orphaned head (marker says children expected, none exist)', async () => {
    const inner = new MemoryStorage();
    const contextId = await seedContext(inner, 1);

    // simulate pre-DATA-001 damage: a head whose children never landed
    const orphanId = 'ctx_orphan_0001';
    const prevHead = (await findHead(inner, contextId))!;
    await inner.insertNodes({
        public_id: orphanId,
        project_id: PROJECT,
        type: 'context',
        context_id: contextId,
        prev_id: prevHead.public_id,
        content: {},
        metadata: { operation: 'update', child_count: 3 },
    });

    // the damage is visible: HEAD is the empty orphan
    const damagedHead = await findHead(inner, contextId);
    assert.equal(damagedHead?.public_id, orphanId);
    const damaged = await getOrderedNodes(inner, contextId, orphanId);
    assert.equal(damaged.length, 0, 'damaged HEAD reads as empty');

    const report = await repairOrphanedHeads(inner, PROJECT);
    assert.ok(report.ok);
    assert.deepEqual(report.data.repaired_heads, [orphanId]);
    assert.deepEqual(report.data.repaired_roots, []);

    // the chain healed: previous head is HEAD again, content intact
    const healedHead = await findHead(inner, contextId);
    assert.equal(healedHead?.public_id, prevHead.public_id);
    await assertConsistent(inner, contextId, 1);
});

test('repair: leaves legitimate empty heads alone (delete-all, empty append, empty create)', async () => {
    const inner = new MemoryStorage();

    // 1) delete-all → head with child_count: 0 is legitimate
    const a = await seedContext(inner, 1);
    const deletedAll = await deleteMessages(inner, PROJECT, a, { ids: [0] });
    assert.ok('ok' in deletedAll);

    // 2) empty append → head with child_count: 0 is legitimate
    await appendMessages(inner, PROJECT, a, []);

    // 3) empty create → head with child_count: 0 is legitimate
    const c = await createContext(inner, PROJECT, {});
    if (!c.ok) throw new Error(`empty create failed: ${c.message}`);

    const report = await repairOrphanedHeads(inner, PROJECT);
    assert.ok(report.ok);
    assert.deepEqual(report.data.repaired_heads, [], 'no legitimate head may be removed');
    assert.deepEqual(report.data.repaired_roots, []);

    // all three contexts still readable
    await assertConsistent(inner, a, 0);
    await assertConsistent(inner, c.data.id, 0);
});

test('repair: removes a partial-create root (root present, zero version heads)', async () => {
    const inner = new MemoryStorage();
    await seedContext(inner, 1); // healthy context must survive

    const partialRoot = 'ctx_partial_root';
    await inner.insertNodes({
        public_id: partialRoot,
        project_id: PROJECT,
        type: 'context',
        context_id: null,
        parent_id: null,
        content: {},
        metadata: {},
    });

    const report = await repairOrphanedHeads(inner, PROJECT);
    assert.ok(report.ok);
    assert.deepEqual(report.data.repaired_roots, [partialRoot]);
    assert.deepEqual(report.data.repaired_heads, []);

    // healthy context untouched
    const roots = await inner.listRootContexts(PROJECT, 100);
    assert.equal(roots.length, 1);
    await assertConsistent(inner, roots[0].public_id, 1);
});

test('repair: no-op on a healthy database', async () => {
    const inner = new MemoryStorage();
    const contextId = await seedContext(inner, 2);
    await updateMessages(inner, PROJECT, contextId, { updates: [{ index: -1, text: 'v3' }] });
    await deleteMessages(inner, PROJECT, contextId, { ids: [0] });

    const report = await repairOrphanedHeads(inner, PROJECT);
    assert.ok(report.ok);
    assert.deepEqual(report.data, { repaired_heads: [], repaired_roots: [] });
    await assertConsistent(inner, contextId, 1);
});

test('head metadata carries child_count on every current op', async () => {
    const inner = new MemoryStorage();
    const contextId = await seedContext(inner, 2);

    const versions = await getVersions(inner, contextId);
    assert.equal(versions.length, 3); // create + 2 appends
    assert.equal((versions[0].metadata as Record<string, unknown>)?.child_count, 0);
    assert.equal((versions[1].metadata as Record<string, unknown>)?.child_count, 1);
    assert.equal((versions[2].metadata as Record<string, unknown>)?.child_count, 1);

    await updateMessages(inner, PROJECT, contextId, { updates: [{ index: 0, text: 'x' }] });
    const after = await getVersions(inner, contextId);
    assert.equal((after[after.length - 1].metadata as Record<string, unknown>)?.child_count, 2);
});
