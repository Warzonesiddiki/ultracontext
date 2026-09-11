// =============================================================================
// SQLITE ACTIVITY — the SQL rollup must agree with the JS rollup
// =============================================================================
// This is the path a self-hosted install actually runs: a plain SQLite file.
// Analytics here is a GROUP BY over your own rows — no telemetry pipeline, no
// data leaving the machine, no retention window that truncates history, and
// no quota on how often you ask.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { getProjectActivity } from '@ultracontext/core';
import { createSqliteAdapter } from './index';

const tmpFiles: string[] = [];
function tmpDbUrl(): string {
    const file = path.join(os.tmpdir(), `uc-activity-${process.pid}-${tmpFiles.length}-${Date.now()}.db`);
    tmpFiles.push(file);
    return `file:${file}`;
}
after(() => {
    for (const f of tmpFiles) {
        for (const ext of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(f + ext); } catch { /* ignore */ }
        }
    }
});

// 2026-03-02 is a Monday, 2026-03-08 the Sunday of the same ISO week.
const MON = '2026-03-02T09:00:00.000Z';
const TUE = '2026-03-03T09:00:00.000Z';
const SUN = '2026-03-08T09:00:00.000Z';
const NEXT_MON = '2026-03-09T09:00:00.000Z';
const NEXT_MONTH = '2026-04-01T09:00:00.000Z';

async function seeded() {
    const storage = await createSqliteAdapter(tmpDbUrl());
    const project = (await storage.insertProject('activity'))!;
    const projectId = project.id;

    let n = 0;
    const add = async (at: string, type: string, source: string | null, contextId: string | null) => {
        await storage.insertNodes({
            public_id: `an-${++n}`,
            project_id: projectId,
            type,
            content: {},
            metadata: source ? { source } : {},
            context_id: contextId,
            created_at: at,
        });
    };

    // week of 2026-03-02: 1 root context + 3 messages from claude, 1 from codex
    await add(MON, 'context', 'claude', null);
    await add(MON, 'message', 'claude', 'head');
    await add(TUE, 'message', 'claude', 'head');
    await add(SUN, 'message', 'claude', 'head');
    await add(SUN, 'message', 'codex', 'head');
    // a version head (context under a context) is a context but NOT a root
    await add(TUE, 'context', 'claude', 'root');

    // next week + next month
    await add(NEXT_MON, 'message', 'claude', 'head');
    await add(NEXT_MONTH, 'message', 'codex', 'head');

    return { storage, projectId };
}

describe('SqliteAdapter.projectActivity — local analytics, no server', () => {
    it('rolls up by UTC day', async () => {
        const { storage, projectId } = await seeded();

        const result = await getProjectActivity(storage, projectId, {
            bucket: 'day',
            from: '2026-03-02T00:00:00.000Z',
            to: '2026-03-09T00:00:00.000Z',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.totals.nodes, 6);
        assert.equal(result.data.totals.messages, 4);
        assert.equal(result.data.totals.contexts, 2);
        // only the parent-less context node counts as a new session
        assert.equal(result.data.totals.root_contexts, 1);
        assert.equal(result.data.totals.sources, 2);

        const byDay = Object.fromEntries(result.data.series.map((p) => [p.bucket_start, p.nodes]));
        assert.equal(byDay['2026-03-02'], 2);
        assert.equal(byDay['2026-03-03'], 2);
        assert.equal(byDay['2026-03-08'], 2);
        // gap-filled
        assert.equal(byDay['2026-03-04'], 0);
    });

    it('buckets weeks on Monday, matching Postgres date_trunc', async () => {
        const { storage, projectId } = await seeded();

        const result = await getProjectActivity(storage, projectId, {
            bucket: 'week',
            from: '2026-03-02T00:00:00.000Z',
            to: '2026-03-16T00:00:00.000Z',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(
            result.data.series.map((p) => [p.bucket_start, p.nodes]),
            [
                ['2026-03-02', 6],
                ['2026-03-09', 1],
            ],
        );
    });

    it('buckets months', async () => {
        const { storage, projectId } = await seeded();

        const result = await getProjectActivity(storage, projectId, {
            bucket: 'month',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-04-30T00:00:00.000Z',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(
            result.data.series.map((p) => [p.bucket_start, p.nodes]),
            [
                ['2026-03-01', 7],
                ['2026-04-01', 1],
            ],
        );
    });

    it('ranks sources and filters by source', async () => {
        const { storage, projectId } = await seeded();

        const all = await getProjectActivity(storage, projectId, {
            bucket: 'month',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-05-01T00:00:00.000Z',
        });
        assert.equal(all.ok, true);
        if (!all.ok) return;
        assert.deepEqual(all.data.by_source.map((s) => s.source), ['claude', 'codex']);
        assert.equal(all.data.by_source[0].messages, 4);
        assert.equal(all.data.by_source[1].messages, 2);

        const filtered = await getProjectActivity(storage, projectId, {
            bucket: 'month',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-05-01T00:00:00.000Z',
            source: 'codex',
        });
        assert.equal(filtered.ok, true);
        if (!filtered.ok) return;
        assert.equal(filtered.data.totals.nodes, 2);
        assert.deepEqual(filtered.data.by_source.map((s) => s.source), ['codex']);
    });

    it('never leaks another project’s traffic', async () => {
        const { storage, projectId } = await seeded();
        const other = (await storage.insertProject('other'))!;

        await storage.insertNodes({
            public_id: 'foreign-1',
            project_id: other.id,
            type: 'message',
            content: {},
            metadata: { source: 'claude' },
            context_id: 'head',
            created_at: MON,
        });

        const mine = await getProjectActivity(storage, projectId, {
            bucket: 'month',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-05-01T00:00:00.000Z',
        });
        assert.equal(mine.ok, true);
        if (!mine.ok) return;
        assert.equal(mine.data.totals.nodes, 8);

        const theirs = await getProjectActivity(storage, other.id, {
            bucket: 'month',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-05-01T00:00:00.000Z',
        });
        assert.equal(theirs.ok, true);
        if (!theirs.ok) return;
        assert.equal(theirs.data.totals.nodes, 1);
    });

    it('returns an empty series (not an error) for a project with no data', async () => {
        const { storage } = await seeded();
        const fresh = (await storage.insertProject('empty'))!;

        const result = await getProjectActivity(storage, fresh.id, { bucket: 'day', days: 3 });
        assert.equal(result.ok, true);
        if (!result.ok) return;
        assert.equal(result.data.totals.nodes, 0);
        assert.equal(result.data.series.length, 3);
    });
});
