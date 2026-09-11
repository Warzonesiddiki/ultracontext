// =============================================================================
// ANALYTICS — free, self-hosted activity rollup
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getProjectActivity, bucketStart, aggregateActivity } from './analytics';
import type { ActivityQuery } from '../storage';
import { MemoryStorage } from '../testing/memory-adapter';

// -- helpers ------------------------------------------------------------------

let seq = 0;

// insert raw nodes with explicit timestamps so tests are deterministic
async function seed(
    storage: MemoryStorage,
    projectId: number,
    entries: Array<{ at: string; type: string; source?: string; context_id?: string | null }>,
) {
    for (const entry of entries) {
        await storage.insertNodes({
            public_id: `node-${projectId}-${++seq}`,
            project_id: projectId,
            type: entry.type,
            content: {},
            metadata: entry.source ? { source: entry.source } : {},
            context_id: entry.context_id ?? null,
            created_at: entry.at,
        });
    }
}

// 2026-03-02 is a Monday. 2026-03-08 is a Sunday.
const MON = '2026-03-02T09:00:00.000Z';
const TUE = '2026-03-03T09:00:00.000Z';
const SUN = '2026-03-08T09:00:00.000Z';
const NEXT_MON = '2026-03-09T09:00:00.000Z';
const NEXT_MONTH = '2026-04-01T09:00:00.000Z';

// -- bucketStart ---------------------------------------------------------------

describe('bucketStart', () => {
    it('truncates to the UTC calendar day', () => {
        assert.equal(bucketStart('2026-03-04T23:59:59.999Z', 'day'), '2026-03-04');
    });

    it('rolls a Sunday back to the preceding Monday', () => {
        // matches Postgres date_trunc('week') and SQLite 'weekday 1'
        assert.equal(bucketStart(SUN, 'week'), '2026-03-02');
        assert.equal(bucketStart(MON, 'week'), '2026-03-02');
        assert.equal(bucketStart(NEXT_MON, 'week'), '2026-03-09');
    });

    it('truncates months to the first', () => {
        assert.equal(bucketStart('2026-03-31T23:00:00.000Z', 'month'), '2026-03-01');
        assert.equal(bucketStart(NEXT_MONTH, 'month'), '2026-04-01');
    });

    it('is timezone-agnostic (UTC only)', () => {
        // 2026-03-02T00:30Z is still 2026-03-01 in New York — we report UTC
        assert.equal(bucketStart('2026-03-02T00:30:00.000Z', 'day'), '2026-03-02');
    });
});

// -- aggregateActivity (shared JS rollup) -------------------------------------

describe('aggregateActivity', () => {
    it('groups by bucket and source and classifies node types', () => {
        const rows = aggregateActivity(
            [
                { created_at: MON, type: 'context', context_id: null, metadata: { source: 'claude' } },
                { created_at: MON, type: 'message', context_id: 'head', metadata: { source: 'claude' } },
                { created_at: MON, type: 'message', context_id: 'head', metadata: { source: 'codex' } },
                { created_at: MON, type: 'message', context_id: 'head', metadata: {} },
            ],
            { bucket: 'day' } satisfies ActivityQuery,
        );

        assert.equal(rows.length, 3);
        const claude = rows.find((r) => r.source === 'claude')!;
        assert.equal(claude.node_count, 2);
        assert.equal(claude.message_count, 1);
        assert.equal(claude.context_count, 1);
        assert.equal(claude.root_context_count, 1);

        // a node with no metadata.source is bucketed as 'unknown', not dropped
        const unknown = rows.find((r) => r.source === 'unknown')!;
        assert.equal(unknown.node_count, 1);
        assert.equal(unknown.message_count, 1);

        // a version head (context with a parent context) is not a new root
        const rows2 = aggregateActivity(
            [
                { created_at: MON, type: 'context', context_id: null, metadata: { source: 'claude' } },
                { created_at: MON, type: 'context', context_id: 'root', metadata: { source: 'claude' } },
            ],
            { bucket: 'day' },
        );
        assert.equal(rows2[0].context_count, 2);
        assert.equal(rows2[0].root_context_count, 1);
    });

    it('honours from/to/source filters and tracks event bounds', () => {
        const rows = aggregateActivity(
            [
                { created_at: MON, type: 'message', context_id: 'head', metadata: { source: 'claude' } },
                { created_at: TUE, type: 'message', context_id: 'head', metadata: { source: 'claude' } },
                { created_at: TUE, type: 'message', context_id: 'head', metadata: { source: 'codex' } },
            ],
            { bucket: 'day', from: TUE, to: '2026-03-04T00:00:00.000Z', source: 'claude' },
        );

        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'claude');
        assert.equal(rows[0].node_count, 1);
        assert.equal(rows[0].first_event_at, TUE);
        assert.equal(rows[0].last_event_at, TUE);
    });
});

// -- getProjectActivity -------------------------------------------------------

describe('getProjectActivity', () => {
    it('rolls a project up by day with totals and per-source breakdown', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, [
            { at: MON, type: 'context', source: 'claude' },
            { at: MON, type: 'message', source: 'claude', context_id: 'head' },
            { at: TUE, type: 'message', source: 'claude', context_id: 'head' },
            { at: TUE, type: 'message', source: 'codex', context_id: 'head' },
        ]);
        // a second project's traffic must never leak into project 1's totals
        await storage.insertNodes({
            public_id: 'node-2-foreign',
            project_id: 2,
            type: 'message',
            content: {},
            metadata: { source: 'codex' },
            context_id: 'head',
            created_at: TUE,
        });

        const result = await getProjectActivity(storage, 1, {
            bucket: 'day',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-03-05T00:00:00.000Z',
        });

        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.totals.nodes, 4);
        assert.equal(result.data.totals.messages, 3);
        assert.equal(result.data.totals.contexts, 1);
        assert.equal(result.data.totals.root_contexts, 1);
        assert.equal(result.data.totals.sources, 2);

        // claude has 2 nodes, codex 1 → claude ranks first
        assert.deepEqual(
            result.data.by_source.map((s) => s.source),
            ['claude', 'codex'],
        );
        assert.equal(result.data.by_source[0].messages, 2);
    });

    it('gap-fills silent days so charts get a continuous axis', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, [{ at: MON, type: 'message', source: 'claude', context_id: 'head' }]);

        const result = await getProjectActivity(storage, 1, {
            bucket: 'day',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-03-05T00:00:00.000Z',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(
            result.data.series.map((p) => p.bucket_start),
            ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'],
        );
        assert.equal(result.data.series[0].nodes, 0);
        assert.equal(result.data.series[0].first_event_at, null);
        assert.equal(result.data.series[1].nodes, 1);
        assert.equal(result.data.totals.active_buckets, 1);
    });

    it('buckets weekly, starting Monday', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, [
            { at: MON, type: 'message', source: 'claude', context_id: 'head' },
            { at: SUN, type: 'message', source: 'claude', context_id: 'head' },
            { at: NEXT_MON, type: 'message', source: 'claude', context_id: 'head' },
        ]);

        const result = await getProjectActivity(storage, 1, {
            bucket: 'week',
            from: '2026-03-02T00:00:00.000Z',
            to: '2026-03-16T00:00:00.000Z',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(
            result.data.series.map((p) => [p.bucket_start, p.messages]),
            [
                ['2026-03-02', 2],
                ['2026-03-09', 1],
            ],
        );
    });

    it('buckets monthly', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, [
            { at: MON, type: 'message', source: 'claude', context_id: 'head' },
            { at: NEXT_MONTH, type: 'message', source: 'claude', context_id: 'head' },
        ]);

        const result = await getProjectActivity(storage, 1, {
            bucket: 'month',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-04-05T00:00:00.000Z',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.deepEqual(
            result.data.series.map((p) => [p.bucket_start, p.messages]),
            [
                ['2026-03-01', 1],
                ['2026-04-01', 1],
            ],
        );
    });

    it('filters by source', async () => {
        const storage = new MemoryStorage();
        await seed(storage, 1, [
            { at: MON, type: 'message', source: 'claude', context_id: 'head' },
            { at: MON, type: 'message', source: 'codex', context_id: 'head' },
        ]);

        const result = await getProjectActivity(storage, 1, {
            bucket: 'day',
            from: '2026-03-01T00:00:00.000Z',
            to: '2026-03-05T00:00:00.000Z',
            source: 'codex',
        });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.totals.nodes, 1);
        assert.deepEqual(
            result.data.by_source.map((s) => s.source),
            ['codex'],
        );
    });

    it('returns an empty (not failing) series for a project with no data', async () => {
        const storage = new MemoryStorage();
        const result = await getProjectActivity(storage, 99, { bucket: 'day', days: 3 });
        assert.equal(result.ok, true);
        if (!result.ok) return;

        assert.equal(result.data.totals.nodes, 0);
        assert.equal(result.data.series.length, 3);
        assert.equal(result.data.series.every((p) => p.nodes === 0), true);
    });

    it('rejects invalid input instead of returning garbage', async () => {
        const storage = new MemoryStorage();

        const badBucket = await getProjectActivity(storage, 1, { bucket: 'fortnight' as never });
        assert.equal(badBucket.ok, false);
        if (!badBucket.ok) assert.equal(badBucket.code, 'invalid_input');

        const badFrom = await getProjectActivity(storage, 1, { from: 'not-a-date' });
        assert.equal(badFrom.ok, false);

        const reversed = await getProjectActivity(storage, 1, {
            from: '2026-03-05T00:00:00.000Z',
            to: '2026-03-01T00:00:00.000Z',
        });
        assert.equal(reversed.ok, false);
    });
});
