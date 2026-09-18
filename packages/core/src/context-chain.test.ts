// =============================================================================
// context-chain — findHead determinism (ARCH-001)
// =============================================================================
// findHead picks which fork of a multi-head context is "the latest". It used to
// sort by created_at alone: ISO-millisecond stamps collide constantly (one batch
// append writes several heads inside the same millisecond), and on a tie the
// winner was whatever order the storage adapter happened to return — so the same
// data could resolve to different heads on different backends, or between two
// reads. These tests pin the tiebreak: created_at descending, then public_id
// descending — a total order, so the answer is a function of the data alone.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from './testing/memory-adapter';
import { findHead, orderNodes } from './context-chain';

// -- helpers ------------------------------------------------------------------

async function makeProject() {
    const storage = new MemoryStorage();
    const project = await storage.insertProject('test');
    return { storage, projectId: project!.id };
}

/** Insert a root context node and return its public id. */
async function makeRoot(storage: MemoryStorage, projectId: number) {
    const rootId = `ctx_root_${Math.random().toString(16).slice(2, 10)}`;
    await storage.insertNodes({
        public_id: rootId,
        project_id: projectId,
        type: 'context',
        context_id: null,
        prev_id: null,
        content: {},
        metadata: {},
    });
    return rootId;
}

/** Insert a version head under a root with an explicit created_at stamp. */
async function makeHead(
    storage: MemoryStorage,
    projectId: number,
    rootId: string,
    publicId: string,
    createdAt: string,
    prevId: string | null = null
) {
    await storage.insertNodes({
        public_id: publicId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: prevId,
        content: {},
        metadata: { operation: 'create' },
        created_at: createdAt,
    });
    return publicId;
}

// =============================================================================

describe('findHead', () => {
    it('returns null when the context has no version heads', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);

        assert.equal(await findHead(storage, rootId), null);
    });

    it('returns the only head when the chain has never forked', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        await makeHead(storage, projectId, rootId, 'ctx_a', '2026-01-01T00:00:00.000Z');

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_a');
    });

    it('picks the newest head by created_at across forks', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        // two independent forks (neither is the other's prev_id)
        await makeHead(storage, projectId, rootId, 'ctx_old', '2026-01-01T00:00:00.000Z');
        await makeHead(storage, projectId, rootId, 'ctx_new', '2026-03-01T00:00:00.000Z');

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_new');
    });

    it('breaks a created_at tie deterministically by public_id (descending)', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        const sameMs = '2026-01-01T00:00:00.000Z';
        // inserted low-id first: a stable sort would keep this order, so the
        // tiebreak has to actively choose the higher id
        await makeHead(storage, projectId, rootId, 'ctx_aaa', sameMs);
        await makeHead(storage, projectId, rootId, 'ctx_zzz', sameMs);

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_zzz');
    });

    it('is independent of the order the storage returns rows in', async () => {
        const sameMs = '2026-01-01T00:00:00.000Z';
        const winners: Array<string | undefined> = [];

        // same data, three different physical row orders (a real adapter's order
        // depends on the query plan, vacuum, page layout…)
        for (const order of [0, 1, 2]) {
            const { storage, projectId } = await makeProject();
            const rootId = await makeRoot(storage, projectId);
            await makeHead(storage, projectId, rootId, 'ctx_aaa', sameMs);
            await makeHead(storage, projectId, rootId, 'ctx_mmm', sameMs);
            await makeHead(storage, projectId, rootId, 'ctx_zzz', sameMs);

            // getAllNodes() is the live array — reversing it changes what
            // findContextBranches() hands back without changing the data
            if (order === 1) storage.getAllNodes().reverse();
            if (order === 2) storage.getAllNodes().sort((a, b) => a.public_id.localeCompare(b.public_id));

            winners.push((await findHead(storage, rootId))?.public_id);
        }

        assert.deepEqual(winners, ['ctx_zzz', 'ctx_zzz', 'ctx_zzz']);
    });

    it('does not treat a node another head points at as a head', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        // ctx_first is NEWER by stamp but is ctx_second's prev_id → not a head.
        // Sorting heads by created_at must never resurrect an interior node.
        await makeHead(storage, projectId, rootId, 'ctx_first', '2026-06-01T00:00:00.000Z');
        await makeHead(storage, projectId, rootId, 'ctx_second', '2026-01-01T00:00:00.000Z', 'ctx_first');

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_second');
    });

    it('keeps created_at as the primary key over the id tiebreak', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        // 'ctx_aaa' is newest — a higher id must not beat a later timestamp
        await makeHead(storage, projectId, rootId, 'ctx_zzz', '2026-01-01T00:00:00.000Z');
        await makeHead(storage, projectId, rootId, 'ctx_aaa', '2026-02-01T00:00:00.000Z');

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_aaa');
    });
});

describe('orderNodes (unchanged by ARCH-001)', () => {
    it('still walks the prev_id chain and falls back on a broken one', async () => {
        const chain = [
            { public_id: 'a', prev_id: null, created_at: '2026-01-03T00:00:00.000Z' },
            { public_id: 'b', prev_id: 'a', created_at: '2026-01-01T00:00:00.000Z' },
            { public_id: 'c', prev_id: 'b', created_at: '2026-01-02T00:00:00.000Z' },
        ];
        assert.deepEqual(orderNodes(chain).map((n) => n.public_id), ['a', 'b', 'c']);

        // broken chain (no null root) → created_at fallback, as before
        const broken = [
            { public_id: 'x', prev_id: 'missing', created_at: '2026-01-02T00:00:00.000Z' },
            { public_id: 'y', prev_id: 'x', created_at: '2026-01-01T00:00:00.000Z' },
        ];
        assert.deepEqual(orderNodes(broken).map((n) => n.public_id), ['y', 'x']);
    });
});
