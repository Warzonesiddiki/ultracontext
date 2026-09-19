// =============================================================================
// node ordinal — persisted by every write path (ARCH-002)
// =============================================================================
// `ordinal` is the explicit position of a node inside its `context_id`
// partition, written by the same insert that writes `prev_id`. These tests walk
// the real ops — create, append, update, delete — and assert what lands in
// storage, because the point of the column is that message order never has to
// be reconstructed from ISO-millisecond timestamps that tie.
//
// Partition recap, since every expected number depends on it:
//   * a root context node has context_id NULL — it belongs to no partition and
//     carries no ordinal;
//   * version heads share the ROOT's id as their context_id, so that partition
//     grows for the life of the context (0, 1, 2, …);
//   * messages carry their own version HEAD's id, and every version write mints
//     a fresh head — so each message partition starts back at 0.
//
// Note that `createContext` takes no messages (POST /contexts creates an empty
// context; POST /contexts/:id fills it), so the first head always has
// child_count 0 and the seeded messages arrive with the first append.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from './testing/memory-adapter';
import { createContext } from './ops/create-context';
import { appendMessages } from './ops/append-messages';
import { updateMessages } from './ops/update-messages';
import { deleteMessages } from './ops/delete-messages';
import { findHead, getOrderedNodes, nextOrdinal } from './context-chain';

async function makeProject() {
    const storage = new MemoryStorage();
    const project = await storage.insertProject('test');
    return { storage, projectId: project!.id };
}

/** An empty context, then one append carrying `messages`. */
async function seed(messages: object[] = [{ role: 'user', text: 'a' }]) {
    const { storage, projectId } = await makeProject();
    const created = await createContext(storage, projectId, {});
    assert.equal(created.ok, true);
    const rootId = created.ok ? created.data.id : '';

    if (messages.length > 0) {
        const appended = await appendMessages(storage, projectId, rootId, messages);
        assert.equal(appended.ok, true);
    }
    return { storage, projectId, rootId };
}

/** Version heads of a root with their persisted ordinals. */
async function headOrdinals(storage: MemoryStorage, rootId: string) {
    const branches = await storage.findContextBranches(rootId);
    return branches.map((b) => ({ public_id: b.public_id, ordinal: b.ordinal }));
}

const sorted = (values: (number | null)[]) => values.slice().sort((a, b) => Number(a) - Number(b));
const text = (node: { content: Record<string, unknown> }) => node.content.text as string;

describe('create — the first partition numbers from 0', () => {
    it('puts the root in no partition and gives its first head ordinal 0', async () => {
        const { storage, projectId } = await makeProject();
        const created = await createContext(storage, projectId, {});
        assert.equal(created.ok, true);
        const rootId = created.ok ? created.data.id : '';

        const partition = await storage.findNodesByContextId(rootId, ['public_id', 'ordinal']);
        assert.equal(partition.length, 1, 'the create head is the only member so far');
        assert.equal(partition[0].ordinal, 0);
        assert.ok(
            !partition.some((row) => row.public_id === rootId),
            'the root node has context_id NULL, so it is never in a partition',
        );
    });

    it('numbers the first append\u2019s messages 0..n-1 in chain order', async () => {
        const { storage, rootId } = await seed([
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
            { role: 'user', text: 'c' },
        ]);

        assert.deepEqual(sorted((await headOrdinals(storage, rootId)).map((h) => h.ordinal)), [0, 1]);

        const head = await findHead(storage, rootId);
        const messages = await storage.findNonContextNodes(head!.public_id);
        assert.deepEqual(messages.map((m) => m.ordinal), [0, 1, 2]);
        assert.deepEqual(messages.map(text), ['a', 'b', 'c']);

        // the ordinal agrees with the chain the same insert wrote: message i
        // points at message i-1
        const byOrdinal = [...messages].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
        assert.equal(byOrdinal[0].prev_id, null);
        assert.equal(byOrdinal[1].prev_id, byOrdinal[0].public_id);
        assert.equal(byOrdinal[2].prev_id, byOrdinal[1].public_id);
    });

    it('honours the column projection callers ask for', async () => {
        // findNodesByContextId has always taken a `columns` argument, and every
        // adapter used to ignore it — returning public_id + prev_id no matter
        // what was asked for. nextOrdinal reads `ordinal` through it, and an
        // ignored projection reads back as undefined, which is
        // indistinguishable from an empty partition: every append would have
        // restarted the head numbering at 0.
        const { storage, rootId } = await seed();
        const head = await findHead(storage, rootId);

        const projected = await storage.findNodesByContextId(rootId, ['public_id', 'ordinal']);
        assert.equal(projected.length, 2, 'the create head and the append head');
        assert.deepEqual(Object.keys(projected[0]).sort(), ['ordinal', 'public_id']);
        assert.deepEqual(sorted(projected.map((row) => row.ordinal ?? null)), [0, 1]);

        const defaulted = await storage.findNodesByContextId(rootId);
        assert.deepEqual(Object.keys(defaulted[0]).sort(), ['prev_id', 'public_id'], 'the default stays narrow');

        const messages = await storage.findNodesByContextId(head!.public_id, ['public_id', 'ordinal']);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].ordinal, 0);
    });
});

describe('append — the head partition grows, message partitions restart', () => {
    it('numbers consecutive heads without gaps or duplicates', async () => {
        const { storage, projectId, rootId } = await seed([{ role: 'user', text: 'a' }]);

        const first = await appendMessages(storage, projectId, rootId, [
            { role: 'user', text: 'b' },
            { role: 'assistant', text: 'c' },
        ]);
        assert.equal(first.ok, true);
        const second = await appendMessages(storage, projectId, rootId, { role: 'user', text: 'd' });
        assert.equal(second.ok, true);

        const heads = await headOrdinals(storage, rootId);
        assert.deepEqual(sorted(heads.map((h) => h.ordinal)), [0, 1, 2, 3], 'create + the seed append + two more');

        // each append stored ONLY its own new messages, numbered from 0 in its
        // own fresh partition (zero-copy append)
        const headAt = (ordinal: number) => heads.find((h) => h.ordinal === ordinal)!.public_id;
        const twoMessages = await storage.findNonContextNodes(headAt(2));
        assert.deepEqual(twoMessages.map((m) => m.ordinal), [0, 1]);
        assert.deepEqual(twoMessages.map(text), ['b', 'c']);

        const oneMessage = await storage.findNonContextNodes(headAt(3));
        assert.deepEqual(oneMessage.map((m) => m.ordinal), [0]);
        assert.deepEqual(oneMessage.map(text), ['d']);
    });

    it('keeps the cumulative message order readable across append heads', async () => {
        const { storage, projectId, rootId } = await seed([{ role: 'user', text: 'a' }]);
        await appendMessages(storage, projectId, rootId, [
            { role: 'assistant', text: 'b' },
            { role: 'user', text: 'c' },
        ]);
        await appendMessages(storage, projectId, rootId, [{ role: 'assistant', text: 'd' }]);

        const head = await findHead(storage, rootId);
        const ordered = await getOrderedNodes(storage, rootId, head!.public_id);
        assert.deepEqual(ordered.map(text), ['a', 'b', 'c', 'd']);
        assert.deepEqual(
            ordered.map((n) => n.ordinal),
            [0, 0, 1, 0],
            'each partition numbers from 0, so ordinals repeat ACROSS heads and only order within one',
        );
    });

    it('never reuses an ordinal that a live head still holds', async () => {
        // an EMPTY context: the create head is the only one, so the ordinals
        // below are 0 (create), 1 and 2 (appends)
        const { storage, projectId, rootId } = await seed([]);
        await appendMessages(storage, projectId, rootId, { role: 'user', text: 'b' });
        await appendMessages(storage, projectId, rootId, { role: 'user', text: 'c' });
        assert.equal(await nextOrdinal(storage, rootId), 3);

        const interior = (await headOrdinals(storage, rootId)).find((h) => h.ordinal === 1)!;
        await storage.deleteNodeByPublicId(projectId, interior.public_id);

        // a COUNT-based ordinal would return 2 here and collide with the live
        // head that already holds 2
        assert.equal(await nextOrdinal(storage, rootId), 3);

        const next = await appendMessages(storage, projectId, rootId, { role: 'user', text: 'd' });
        assert.equal(next.ok, true);

        const ordinals = sorted((await headOrdinals(storage, rootId)).map((h) => h.ordinal));
        assert.deepEqual(ordinals, [0, 2, 3], 'the gap left by the deleted head is never filled in');
        assert.equal(new Set(ordinals).size, ordinals.length, 'no two live heads share an ordinal');
    });
});

describe('update / delete — snapshot copies are numbered in write order', () => {
    it('continues the head ordinals and renumbers the copied snapshot from 0', async () => {
        const { storage, projectId, rootId } = await seed([
            { role: 'user', text: 'a' },
            { role: 'assistant', text: 'b' },
            { role: 'user', text: 'c' },
        ]);
        const seededHead = await findHead(storage, rootId);
        const seededIds = (await storage.findNonContextNodes(seededHead!.public_id)).map((m) => m.public_id);

        const updated = await updateMessages(storage, projectId, rootId, {
            updates: [{ id: seededIds[1], text: 'b-edited' }],
        });
        assert.equal(updated.ok, true);

        const updateHead = await findHead(storage, rootId);
        assert.equal(updateHead!.ordinal, 2, 'create, append, then the update head');

        const copies = await storage.findNonContextNodes(updateHead!.public_id);
        assert.deepEqual(copies.map((c) => c.ordinal), [0, 1, 2], 'a full snapshot, numbered in chain order');
        assert.deepEqual(copies.map(text), ['a', 'b-edited', 'c']);

        // …and a delete does the same for the survivors
        const deleted = await deleteMessages(storage, projectId, rootId, { ids: [copies[0].public_id] });
        assert.equal(deleted.ok, true);

        const deleteHead = await findHead(storage, rootId);
        assert.equal(deleteHead!.ordinal, 3);
        const survivors = await storage.findNonContextNodes(deleteHead!.public_id);
        assert.deepEqual(survivors.map((s) => s.ordinal), [0, 1]);
        assert.deepEqual(survivors.map(text), ['b-edited', 'c']);
    });
});

describe('legacy rows — a missing ordinal is not an error', () => {
    it('stores null, still orders an intact chain, and starts numbering at 0', async () => {
        const { storage, projectId } = await makeProject();
        await storage.insertNodes([
            { public_id: 'ctx_legacy_root', project_id: projectId, type: 'context', context_id: null, content: {}, metadata: {} },
            {
                public_id: 'ctx_legacy_head',
                project_id: projectId,
                type: 'context',
                context_id: 'ctx_legacy_root',
                prev_id: null,
                content: {},
                metadata: { operation: 'create', child_count: 1 },
            },
            {
                public_id: 'msg_legacy',
                project_id: projectId,
                type: 'message',
                context_id: 'ctx_legacy_head',
                prev_id: null,
                content: { text: 'old' },
                metadata: {},
            },
        ]);

        const heads = await headOrdinals(storage, 'ctx_legacy_root');
        assert.equal(heads[0].ordinal, null, 'a pre-0004 row has no ordinal until the migration backfills it');
        assert.equal(await nextOrdinal(storage, 'ctx_legacy_root'), 0, 'so the next write starts the partition');

        const ordered = await getOrderedNodes(storage, 'ctx_legacy_root', 'ctx_legacy_head');
        assert.deepEqual(ordered.map((n) => n.public_id), ['msg_legacy']);

        const head = await findHead(storage, 'ctx_legacy_root');
        assert.equal(head?.public_id, 'ctx_legacy_head');
    });
});
