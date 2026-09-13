// =============================================================================
// KEY LIFECYCLE — list / revoke / rotate ops
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listKeys, revokeKey, rotateKey, verifyKey, createKey } from '../index';
import { MemoryStorage } from '../testing/memory-adapter';

describe('listKeys', () => {
    it('lists a project keys without ever exposing the hash', async () => {
        const storage = new MemoryStorage();
        const created = await createKey(storage, 'proj-a');
        assert.ok(created.ok);
        const projectId = created.data.project_id;

        // a second project must not leak into the listing
        const other = await createKey(storage, 'proj-b');

        const result = await listKeys(storage, projectId);
        assert.equal(result.ok, true);
        assert.equal(result.data.length, 1);

        const key = result.data[0];
        assert.equal(key.project_id, projectId);
        assert.ok(key.key_prefix.startsWith('uc_live_'));
        assert.ok(key.created_at.length > 0);
        assert.equal(typeof key.id, 'number');

        // the hash is secret material and must not appear in any listing
        const raw = JSON.stringify(result);
        assert.ok(!raw.includes('key_hash'));
        assert.ok(!raw.includes('hash'));
        void other;
    });

    it('rejects invalid project ids', async () => {
        const storage = new MemoryStorage();
        for (const bad of [0, -1, 1.5, NaN]) {
            const result = await listKeys(storage, bad);
            assert.equal(result.ok, false, `should reject ${bad}`);
        }
    });
});

describe('revokeKey', () => {
    it('revoked key no longer verifies; result carries the prefix for cache eviction', async () => {
        const storage = new MemoryStorage();
        const created = await createKey(storage, 'victim');
        assert.ok(created.ok);
        const rawKey = created.data.key;
        const projectId = created.data.project_id;

        const listed = await listKeys(storage, projectId);
        assert.equal(listed.ok, true);
        const [keyRow] = listed.data;

        const result = await revokeKey(storage, keyRow!.id);
        assert.equal(result.ok, true);
        assert.equal(result.data.prefix, rawKey.slice(0, 12));

        // the key no longer verifies
        const after = await verifyKey(storage, rawKey);
        assert.equal(after, null);

        // the project is gone from the listing
        const again = await listKeys(storage, projectId);
        assert.equal(again.ok, true);
        assert.equal(again.data.length, 0);
    });

    it('revoking an unknown id is not_found', async () => {
        const storage = new MemoryStorage();
        const result = await revokeKey(storage, 999);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'not_found');
    });
});

describe('rotateKey', () => {
    it('old key dies, new key works, same project', async () => {
        const storage = new MemoryStorage();
        const created = await createKey(storage, 'rotating');
        assert.ok(created.ok);
        const oldRaw = created.data.key;
        const projectId = created.data.project_id;

        const listed = await listKeys(storage, projectId);
        assert.ok(listed.ok);
        const [keyRow] = listed.data;

        const result = await rotateKey(storage, keyRow!.id);
        assert.equal(result.ok, true);
        assert.equal(result.data.project_id, projectId);
        assert.notEqual(result.data.prefix, result.data.old_prefix);

        // old key no longer verifies; new key does
        assert.equal(await verifyKey(storage, oldRaw), null);
        const newVerify = await verifyKey(storage, result.data.key);
        assert.ok(newVerify);
        assert.equal(newVerify!.projectId, projectId);

        // listing shows exactly one key now
        const again = await listKeys(storage, projectId);
        assert.equal(again.ok, true);
        assert.equal(again.data.length, 1);
        assert.equal(again.data[0].key_prefix, result.data.prefix);
    });

    it('rotating an unknown id is not_found', async () => {
        const storage = new MemoryStorage();
        const result = await rotateKey(storage, 4242);
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.code, 'not_found');
    });

    it('rejects non-integer ids', async () => {
        const storage = new MemoryStorage();
        for (const bad of [0, -5, 2.5, NaN]) {
            const r = await revokeKey(storage, bad);
            assert.equal(r.ok, false);
            const q = await rotateKey(storage, bad);
            assert.equal(q.ok, false);
        }
    });
});
