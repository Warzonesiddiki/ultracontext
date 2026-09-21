// =============================================================================
// NAMED BRANCHES (ARCH-001) — stable names over immutable version ids
// =============================================================================
// Covers: the branch-name rules, create-or-move (git `branch -f`) semantics,
// listing with positional indexes resolved at read time, delete touching only
// the pointer, project scoping on every op, and the version selector that
// accepts either an immutable id or a deprecated positional index.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryStorage } from '../testing/memory-adapter';
import { seedContext } from '../testing/seed';
import { buildNodeInsertRecords, getVersions } from '../context-chain';
import { generatePublicId } from '../public-ids';
import {
    BRANCH_NAME_ERROR,
    MAX_BRANCH_NAME_LEN,
    createBranch,
    deleteBranch,
    isValidBranchName,
    listBranches,
} from './branches';
import { classifyVersionSelection, getContext, resolveVersionSelection } from './get-context';

// -- helpers ------------------------------------------------------------------

/**
 * Seed an extra version head under an existing root (5-arg form: the caller
 * names the head it links back to), mirroring what update/delete produce.
 */
async function addVersion(
    storage: MemoryStorage,
    projectId: number,
    rootId: string,
    prevHeadId: string,
    messages: object[]
): Promise<string> {
    const headId = generatePublicId('context');
    await storage.insertNodes({
        public_id: headId,
        project_id: projectId,
        type: 'context',
        context_id: rootId,
        prev_id: prevHeadId,
        content: {},
        metadata: { operation: 'update', affected: [] },
    });

    if (messages.length > 0) {
        const insertRecords = buildNodeInsertRecords(
            messages.map((m) => ({ type: 'message', content: m as Record<string, unknown>, metadata: {} })),
            projectId,
            headId,
            null
        );
        await storage.insertNodes(insertRecords);
    }

    return headId;
}

/** A root context with three versions (indexes 0..2); returns their head ids. */
async function seedChain(storage: MemoryStorage, projectId: number) {
    const seed = await seedContext(storage, projectId, { messages: [{ text: 'v0' }] });
    const head1 = await addVersion(storage, projectId, seed.rootId, seed.headId, [{ text: 'v1' }]);
    const head2 = await addVersion(storage, projectId, seed.rootId, head1, [{ text: 'v2' }]);
    return { rootId: seed.rootId, heads: [seed.headId, head1, head2] };
}

/** created_at/updated_at are ISO-millisecond strings — a real gap needs a wait. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup() {
    const storage = new MemoryStorage();
    const project = await storage.insertProject('test');
    return { storage, projectId: project!.id };
}

// =============================================================================

describe('isValidBranchName', () => {
    it('accepts names that start alphanumerically and stay in [A-Za-z0-9._-]', () => {
        for (const good of ['main', 'v1', '9lives', 'release-1.2', 'feature_x', 'a.b.c', 'A1', '0']) {
            assert.equal(isValidBranchName(good), true, `should accept ${good}`);
        }
        assert.equal(isValidBranchName('a'.repeat(MAX_BRANCH_NAME_LEN)), true);
    });

    it('rejects empty, over-long, bad-start, bad-charset, ".." and trailing punctuation', () => {
        for (const bad of [
            '',
            'a'.repeat(MAX_BRANCH_NAME_LEN + 1),
            '-lead',
            '.lead',
            '_lead',
            'trail-',
            'trail.',
            'a..b',
            '..',
            'has space',
            'has/slash',
            'has:colon',
            'tilde~',
            'ünïcode',
        ]) {
            assert.equal(isValidBranchName(bad), false, `should reject ${JSON.stringify(bad)}`);
        }
    });

    it('rejects non-string names outright', () => {
        for (const bad of [undefined, null, 1, true, {}, ['main']]) {
            assert.equal(isValidBranchName(bad), false);
        }
    });
});

describe('createBranch', () => {
    it('pins a new branch to the current head when no version is given', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const result = await createBranch(storage, projectId, rootId, { name: 'main' });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.name, 'main');
        assert.equal(result.data.version_id, heads[2]);
        assert.equal(result.data.version, 2);
        assert.equal(result.data.created_at, result.data.updated_at);
    });

    it('pins to a positional index (deprecated alias still works)', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const result = await createBranch(storage, projectId, rootId, { name: 'release-1', version: 1 });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.version_id, heads[1]);
        assert.equal(result.data.version, 1);
    });

    it('pins to an immutable version id', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const result = await createBranch(storage, projectId, rootId, { name: 'pinned', version: heads[0] });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.version_id, heads[0]);
        assert.equal(result.data.version, 0);
    });

    it('accepts a digit-string index and a negative index counted back from the head', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const asString = await createBranch(storage, projectId, rootId, { name: 'from-string', version: '1' });
        assert.equal(asString.ok, true);
        if (asString.ok) assert.equal(asString.data.version_id, heads[1]);

        const negative = await createBranch(storage, projectId, rootId, { name: 'from-negative', version: -1 });
        assert.equal(negative.ok, true);
        if (negative.ok) assert.equal(negative.data.version_id, heads[2]);
    });

    it('moves an existing branch, preserving created_at and bumping updated_at', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const first = await createBranch(storage, projectId, rootId, { name: 'main', version: 0 });
        assert.equal(first.ok, true);
        if (!first.ok) return;

        await sleep(10);
        const moved = await createBranch(storage, projectId, rootId, { name: 'main', version: 2 });

        assert.equal(moved.ok, true);
        if (!moved.ok) return;
        assert.equal(moved.data.version_id, heads[2]);
        assert.equal(moved.data.version, 2);
        // git `branch -f`: the pointer moved, the birthday did not
        assert.equal(moved.data.created_at, first.data.created_at);
        assert.ok(
            new Date(moved.data.updated_at).getTime() > new Date(first.data.updated_at).getTime(),
            'updated_at must advance on a move'
        );

        // still exactly one row — upsert, not insert
        const rows = storage.getContextRefs();
        assert.equal(rows.length, 1);
    });

    it('rejects an invalid name with invalid_input and the documented rule text', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);

        for (const bad of ['', 'a..b', '-x', 'x'.repeat(MAX_BRANCH_NAME_LEN + 1), 42 as unknown as string]) {
            const result = await createBranch(storage, projectId, rootId, { name: bad });
            assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
            if (!result.ok) {
                assert.equal(result.code, 'invalid_input');
                assert.equal(result.message, BRANCH_NAME_ERROR);
            }
        }
        assert.equal(storage.getContextRefs().length, 0);
    });

    it('returns not_found for an unknown context', async () => {
        const { storage, projectId } = await setup();

        const result = await createBranch(storage, projectId, 'ctx_nope', { name: 'main' });

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'not_found');
    });

    it('returns not_found for another project\'s context (tenant isolation)', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);
        const other = await storage.insertProject('other');

        const list = await listBranches(storage, other!.id, rootId);
        const create = await createBranch(storage, other!.id, rootId, { name: 'main' });
        const remove = await deleteBranch(storage, other!.id, rootId, 'main');

        for (const result of [list, create, remove]) {
            assert.equal(result.ok, false);
            if (!result.ok) {
                assert.equal(result.code, 'not_found');
                assert.equal(result.message, 'Context not found');
            }
        }
        // the other tenant could not write a ref onto someone else's context
        assert.equal(storage.getContextRefs().length, 0);
    });

    it('returns not_found for an unknown version id and an out-of-range index', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);

        const unknownId = await createBranch(storage, projectId, rootId, { name: 'a', version: 'ctx_doesnotexist' });
        assert.equal(unknownId.ok, false);
        if (!unknownId.ok) {
            assert.equal(unknownId.code, 'not_found');
            assert.equal(unknownId.message, 'Version not found');
        }

        const outOfRange = await createBranch(storage, projectId, rootId, { name: 'b', version: 99 });
        assert.equal(outOfRange.ok, false);
        if (!outOfRange.ok) assert.equal(outOfRange.code, 'not_found');

        const fractional = await createBranch(storage, projectId, rootId, { name: 'c', version: 1.5 });
        assert.equal(fractional.ok, false);
        if (!fractional.ok) assert.equal(fractional.code, 'invalid_input');

        assert.equal(storage.getContextRefs().length, 0);
    });
});

describe('listBranches', () => {
    it('returns an empty list for a context with no branches', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);

        const result = await listBranches(storage, projectId, rootId);

        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.data.branches, []);
    });

    it('lists every branch name-ascending with its index resolved at read time', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        await createBranch(storage, projectId, rootId, { name: 'release-1', version: 1 });
        await createBranch(storage, projectId, rootId, { name: 'main', version: 2 });
        await createBranch(storage, projectId, rootId, { name: 'archive', version: heads[0] });

        const result = await listBranches(storage, projectId, rootId);
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(
            result.data.branches.map((b) => [b.name, b.version, b.version_id]),
            [
                ['archive', 0, heads[0]],
                ['main', 2, heads[2]],
                ['release-1', 1, heads[1]],
            ]
        );
    });

    it('re-indexes a branch when the chain grows underneath it (id stays fixed)', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);
        await createBranch(storage, projectId, rootId, { name: 'main' });

        const before = await listBranches(storage, projectId, rootId);
        assert.equal(before.ok, true);
        if (before.ok) assert.equal(before.data.branches[0].version, 2);

        // append a new version — the positional head moves, the pin does not
        await addVersion(storage, projectId, rootId, heads[2], [{ text: 'v3' }]);

        const after = await listBranches(storage, projectId, rootId);
        assert.equal(after.ok, true);
        if (!after.ok) return;
        assert.equal(after.data.branches[0].version_id, heads[2]);
        assert.equal(after.data.branches[0].version, 2);
        assert.equal((await getVersions(storage, rootId)).length, 4);
    });

    it('reports version -1 when the pinned head is no longer in the chain', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);
        await createBranch(storage, projectId, rootId, { name: 'orphan', version: 1 });

        // the version node itself disappears (permanent delete of that head);
        // head_id has no FK by design, so the name survives as an orphan
        await storage.deleteNodeByPublicId(projectId, heads[1]);

        const result = await listBranches(storage, projectId, rootId);
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.branches.length, 1);
        assert.equal(result.data.branches[0].version_id, heads[1]);
        assert.equal(result.data.branches[0].version, -1);
    });

    it('keeps branches of different contexts and projects separate', async () => {
        const { storage, projectId } = await setup();
        const a = await seedChain(storage, projectId);
        const b = await seedChain(storage, projectId);

        await createBranch(storage, projectId, a.rootId, { name: 'main' });
        await createBranch(storage, projectId, b.rootId, { name: 'other' });

        const listA = await listBranches(storage, projectId, a.rootId);
        const listB = await listBranches(storage, projectId, b.rootId);

        assert.equal(listA.ok, true);
        assert.equal(listB.ok, true);
        if (listA.ok) assert.deepEqual(listA.data.branches.map((x) => x.name), ['main']);
        if (listB.ok) assert.deepEqual(listB.data.branches.map((x) => x.name), ['other']);
    });
});

describe('deleteBranch', () => {
    it('deletes the name and reports {deleted, name}', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);
        await createBranch(storage, projectId, rootId, { name: 'main' });

        const result = await deleteBranch(storage, projectId, rootId, 'main');

        assert.equal(result.ok, true);
        if (result.ok) assert.deepEqual(result.data, { deleted: true, name: 'main' });
        assert.equal(storage.getContextRefs().length, 0);
    });

    it('returns not_found for a branch that does not exist', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);

        const result = await deleteBranch(storage, projectId, rootId, 'nope');

        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.code, 'not_found');
            assert.equal(result.message, 'Branch not found');
        }
    });

    it('rejects an invalid name before touching storage', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);
        await createBranch(storage, projectId, rootId, { name: 'main' });

        const result = await deleteBranch(storage, projectId, rootId, 'a..b');

        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'invalid_input');
        // the existing branch is untouched
        assert.equal(storage.getContextRefs().length, 1);
    });

    it('never touches version data — the chain still reads back intact', async () => {
        const { storage, projectId } = await setup();
        const { rootId } = await seedChain(storage, projectId);
        await createBranch(storage, projectId, rootId, { name: 'main', version: 0 });

        const before = await getContext(storage, projectId, rootId, { history: true });
        const removed = await deleteBranch(storage, projectId, rootId, 'main');
        assert.equal(removed.ok, true);

        const after = await getContext(storage, projectId, rootId, { history: true });
        assert.equal(before.ok, true);
        assert.equal(after.ok, true);
        if (before.ok && after.ok) {
            assert.deepEqual(after.data.versions, before.data.versions);
            assert.deepEqual(after.data.data, before.data.data);
            assert.equal(after.data.versions?.length, 3);
        }
    });
});

describe('resolveVersionSelection', () => {
    it('classifies integers and digit strings as positional, everything else as an id', () => {
        assert.deepEqual(classifyVersionSelection(0), { kind: 'index', index: 0 });
        assert.deepEqual(classifyVersionSelection(-1), { kind: 'index', index: -1 });
        assert.deepEqual(classifyVersionSelection('7'), { kind: 'index', index: 7 });
        assert.deepEqual(classifyVersionSelection('-2'), { kind: 'index', index: -2 });
        assert.deepEqual(classifyVersionSelection('ctx_abc'), { kind: 'id', id: 'ctx_abc' });
        assert.deepEqual(classifyVersionSelection('1.9'), { kind: 'id', id: '1.9' });
        // malformed: fractional number, empty string, non-number/string
        assert.equal(classifyVersionSelection(1.9), null);
        assert.equal(classifyVersionSelection(NaN), null);
        assert.equal(classifyVersionSelection(''), null);
        assert.equal(classifyVersionSelection(undefined), null);
        assert.equal(classifyVersionSelection(null), null);
    });

    it('resolves ids and indexes against a chain, and errors the right way', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);
        const versions = await getVersions(storage, rootId);

        assert.deepEqual(resolveVersionSelection(versions, heads[1]), { ok: true, data: { headId: heads[1], version: 1 } });
        assert.deepEqual(resolveVersionSelection(versions, 2), { ok: true, data: { headId: heads[2], version: 2 } });
        assert.deepEqual(resolveVersionSelection(versions, '2'), { ok: true, data: { headId: heads[2], version: 2 } });
        assert.deepEqual(resolveVersionSelection(versions, -3), { ok: true, data: { headId: heads[0], version: 0 } });

        const unknown = resolveVersionSelection(versions, 'ctx_missing');
        assert.equal(unknown.ok, false);
        if (!unknown.ok) assert.equal(unknown.code, 'not_found');

        const bad = resolveVersionSelection(versions, 1.5);
        assert.equal(bad.ok, false);
        if (!bad.ok) assert.equal(bad.code, 'invalid_input');
    });

    it('exposes the immutable id on ?history=true entries alongside the index', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const result = await getContext(storage, projectId, rootId, { history: true });

        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.deepEqual(
            result.data.versions?.map((v) => [v.version, v.id]),
            [
                [0, heads[0]],
                [1, heads[1]],
                [2, heads[2]],
            ]
        );
    });

    it('reads a context by immutable version id end to end', async () => {
        const { storage, projectId } = await setup();
        const { rootId, heads } = await seedChain(storage, projectId);

        const byId = await getContext(storage, projectId, rootId, { version: heads[1] });
        const byIndex = await getContext(storage, projectId, rootId, { version: 1 });

        assert.equal(byId.ok, true);
        assert.equal(byIndex.ok, true);
        if (byId.ok && byIndex.ok) {
            assert.equal(byId.data.version, 1);
            assert.deepEqual(byId.data.data, byIndex.data.data);
        }

        const unknown = await getContext(storage, projectId, rootId, { version: 'ctx_missing' });
        assert.equal(unknown.ok, false);
        if (!unknown.ok) assert.equal(unknown.code, 'not_found');
    });
});
