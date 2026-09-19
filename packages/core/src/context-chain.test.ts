// =============================================================================
// context-chain — findHead determinism (ARCH-001) + ordinal ordering (ARCH-002)
// =============================================================================
// findHead picks which fork of a multi-head context is "the latest". It used to
// sort by created_at alone: ISO-millisecond stamps collide constantly (one batch
// append writes several heads inside the same millisecond), and on a tie the
// winner was whatever order the storage adapter happened to return — so the same
// data could resolve to different heads on different backends, or between two
// reads. ARCH-001 pinned the tiebreak to created_at descending, then public_id
// descending; ARCH-002 put a persisted `ordinal` in front of both, because the
// ordinal IS the write order and needs no tiebreak at all. The old keys remain
// for heads written before migration 0004 backfilled ordinals.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from './testing/memory-adapter';
import { buildNodeInsertRecords, findHead, nextOrdinal, orderNodes } from './context-chain';
import { chainHealth, onChainFallback, resetChainHealth, type ChainFallbackEvent } from './chain-health';

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
/**
 * Insert a version head under a root. `ordinal` defaults to undefined, i.e.
 * "a row written before migration 0004" — the legacy case the tiebreakers
 * exist for.
 */
async function makeHead(
    storage: MemoryStorage,
    projectId: number,
    rootId: string,
    publicId: string,
    createdAt: string,
    prevId: string | null = null,
    ordinal?: number | null
) {
    await storage.insertNodes({
        public_id: publicId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: prevId,
        ordinal,
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

describe('orderNodes — the chain walk', () => {
    it('walks the prev_id chain and falls back on a broken one', async () => {
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

    it('treats prev_id as authoritative even when the ordinals disagree', async () => {
        // A hand-edited or badly restored database can hold ordinals that do not
        // match the chain. The chain wins: ordinal is the FALLBACK's tiebreak,
        // never a re-ordering of intact data.
        const chain = [
            { public_id: 'a', prev_id: null, created_at: '2026-01-01T00:00:00.000Z', ordinal: 9 },
            { public_id: 'b', prev_id: 'a', created_at: '2026-01-01T00:00:00.000Z', ordinal: 0 },
        ];
        assert.deepEqual(orderNodes(chain).map((n) => n.public_id), ['a', 'b']);
    });
});

// =============================================================================
// ARCH-002 — the fallback is total, and it is measured
// =============================================================================

describe('orderNodes — broken-chain fallback (ARCH-002)', () => {
    it('orders by persisted ordinal when every created_at is identical', async () => {
        // The exact case that used to be nondeterministic: one batch append,
        // one millisecond, three nodes, and a created_at-only sort whose result
        // depended on the order storage happened to return rows.
        const at = '2026-09-18T00:00:00.000Z';
        const nodes = [
            { public_id: 'm3', prev_id: 'missing', created_at: at, ordinal: 2 },
            { public_id: 'm1', prev_id: 'missing', created_at: at, ordinal: 0 },
            { public_id: 'm2', prev_id: 'missing', created_at: at, ordinal: 1 },
        ];
        assert.deepEqual(orderNodes(nodes).map((n) => n.public_id), ['m1', 'm2', 'm3']);
        // …and it is a function of the data alone, so reversing the input
        // cannot change the answer
        assert.deepEqual(orderNodes([...nodes].reverse()).map((n) => n.public_id), ['m1', 'm2', 'm3']);
    });

    it('sorts rows with no ordinal after rows that have one, then by time and id', async () => {
        const nodes = [
            { public_id: 'legacy_b', prev_id: 'missing', created_at: '2026-01-02T00:00:00.000Z', ordinal: null },
            { public_id: 'legacy_a', prev_id: 'missing', created_at: '2026-01-01T00:00:00.000Z', ordinal: null },
            { public_id: 'new', prev_id: 'missing', created_at: '2026-01-03T00:00:00.000Z', ordinal: 0 },
        ];
        // 'new' has an ordinal (0) so it leads, even though it is the newest by
        // time; the two legacy rows then fall back to created_at.
        assert.deepEqual(orderNodes(nodes).map((n) => n.public_id), ['new', 'legacy_a', 'legacy_b']);
    });

    it('breaks a total timestamp+ordinal tie on public_id', async () => {
        const at = '2026-09-18T00:00:00.000Z';
        const nodes = [
            { public_id: 'zzz', prev_id: 'missing', created_at: at },
            { public_id: 'aaa', prev_id: 'missing', created_at: at },
        ];
        assert.deepEqual(orderNodes(nodes).map((n) => n.public_id), ['aaa', 'zzz']);
    });

    it('records the fallback with what was expected and what was reached', async () => {
        resetChainHealth();
        const seen: ChainFallbackEvent[] = [];
        const off = onChainFallback((event) => seen.push(event));
        try {
            orderNodes(
                [
                    { public_id: 'x', prev_id: 'missing', created_at: '2026-01-02T00:00:00.000Z' },
                    { public_id: 'y', prev_id: 'x', created_at: '2026-01-01T00:00:00.000Z' },
                    { public_id: 'z', prev_id: 'y', created_at: '2026-01-03T00:00:00.000Z' },
                ],
                { contextId: 'ctx_root_1' },
            );
        } finally {
            off();
        }

        assert.equal(seen.length, 1);
        assert.equal(seen[0].kind, 'broken_chain');
        assert.equal(seen[0].context_id, 'ctx_root_1');
        assert.equal(seen[0].expected, 3);
        assert.equal(seen[0].reached, 0, 'nothing is reachable without a null prev_id root');
        assert.ok(seen[0].at);
        assert.equal(chainHealth().fallbacks, 1);
        assert.equal(chainHealth().nodes_lost, 3);
    });

    it('does not record anything when the chain is intact', async () => {
        resetChainHealth();
        orderNodes([
            { public_id: 'a', prev_id: null, created_at: '2026-01-01T00:00:00.000Z', ordinal: 0 },
            { public_id: 'b', prev_id: 'a', created_at: '2026-01-01T00:00:00.000Z', ordinal: 1 },
        ]);
        assert.equal(chainHealth().fallbacks, 0);
    });
});

describe('findHead — ordinal wins (ARCH-002)', () => {
    it('picks the highest ordinal even when created_at says otherwise', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        // written later, but out of order: a restored export can carry original
        // timestamps, and the ordinal is what records the real write order
        await makeHead(storage, projectId, rootId, 'ctx_newer_stamp', '2026-05-01T00:00:00.000Z', null, 0);
        await makeHead(storage, projectId, rootId, 'ctx_older_stamp', '2026-01-01T00:00:00.000Z', 'ctx_newer_stamp', 1);

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_older_stamp');
    });

    it('picks the highest ordinal when every timestamp is identical', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        const at = '2026-09-18T00:00:00.000Z';
        // 'ctx_aaa' would win the ARCH-001 public_id tiebreak only if it were
        // newest; ordinal 1 belongs to 'ctx_zzz'… so make the ids argue with the
        // ordinals: the highest ordinal has the LOWEST id.
        await makeHead(storage, projectId, rootId, 'ctx_zzz', at, null, 0);
        await makeHead(storage, projectId, rootId, 'ctx_aaa', at, 'ctx_zzz', 1);

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_aaa', 'ordinal 1 is the newest write');
    });

    it('prefers a head that has an ordinal over one that does not', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        const at = '2026-09-18T00:00:00.000Z';
        await makeHead(storage, projectId, rootId, 'ctx_legacy', at, null, null);
        await makeHead(storage, projectId, rootId, 'ctx_migrated', at, null, 0);

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_migrated');
    });

    it('still falls back to created_at then public_id when no head has an ordinal', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        const at = '2026-09-18T00:00:00.000Z';
        await makeHead(storage, projectId, rootId, 'ctx_aaa', at);
        await makeHead(storage, projectId, rootId, 'ctx_zzz', at);

        const head = await findHead(storage, rootId);
        assert.equal(head?.public_id, 'ctx_zzz', 'pre-0004 rows keep the ARCH-001 tiebreak');
    });
});

describe('nextOrdinal (ARCH-002)', () => {
    it('starts at 0 for an empty partition', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        assert.equal(await nextOrdinal(storage, rootId), 0);
    });

    it('continues past the highest ordinal, not past the row count', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        await makeHead(storage, projectId, rootId, 'ctx_h0', '2026-01-01T00:00:00.000Z', null, 0);
        await makeHead(storage, projectId, rootId, 'ctx_h1', '2026-01-02T00:00:00.000Z', 'ctx_h0', 1);
        await makeHead(storage, projectId, rootId, 'ctx_h2', '2026-01-03T00:00:00.000Z', 'ctx_h1', 2);
        assert.equal(await nextOrdinal(storage, rootId), 3);

        // delete an INTERIOR head: a count-based ordinal would now return 2 and
        // collide with the live head that already holds it
        await storage.deleteNodeByPublicId(projectId, 'ctx_h1');
        assert.equal(await nextOrdinal(storage, rootId), 3);
    });

    it('ignores rows with no ordinal (a partition that predates migration 0004)', async () => {
        const { storage, projectId } = await makeProject();
        const rootId = await makeRoot(storage, projectId);
        await makeHead(storage, projectId, rootId, 'ctx_legacy', '2026-01-01T00:00:00.000Z');
        assert.equal(await nextOrdinal(storage, rootId), 0);

        await makeHead(storage, projectId, rootId, 'ctx_migrated', '2026-01-02T00:00:00.000Z', null, 5);
        assert.equal(await nextOrdinal(storage, rootId), 6);
    });
});

describe('buildNodeInsertRecords — ordinals (ARCH-002)', () => {
    it('numbers a run from 0 by default, in chain order', () => {
        const records = buildNodeInsertRecords(
            [
                { type: 'message', content: { role: 'user' }, metadata: {} },
                { type: 'message', content: { role: 'assistant' }, metadata: {} },
            ],
            1,
            'ctx_head',
            null,
        );
        assert.deepEqual(records.map((r) => r.ordinal), [0, 1]);
        assert.deepEqual(records.map((r) => r.prev_id), [null, records[0].public_id]);
    });

    it('continues from an explicit starting ordinal', () => {
        const records = buildNodeInsertRecords(
            [{ type: 'message', content: {}, metadata: {} }],
            1,
            'ctx_head',
            'msg_prev',
            7,
        );
        assert.equal(records[0].ordinal, 7);
        assert.equal(records[0].prev_id, 'msg_prev');
    });
});
