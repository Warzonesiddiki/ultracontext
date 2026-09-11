// =============================================================================
// ACTIVITY — free, self-hosted analytics over your own database
// =============================================================================
// The commercial tier sells "analytics" and gates "unlimited analytics" behind
// a Pro plan. Here analytics is just a GROUP BY over rows you already own: no
// separate telemetry pipeline, no data shipped to a third party, no retention
// window that quietly truncates your history, and no quota on how often you ask.
//
// Bucketing happens in SQL; rollup, gap-filling and top-source ranking happen
// here so every backend returns byte-identical shapes.

import type { ActivityBucket, ActivityQuery, ActivityRow, StorageAdapter } from '../storage';
import { err, ok, type Result } from '../result';

// -- limits -------------------------------------------------------------------

/** default window width when the caller passes `days` and bucket is 'day' */
export const DEFAULT_ACTIVITY_DAYS = 30;
export const DEFAULT_WEEK_BUCKETS = 12;
export const DEFAULT_MONTH_BUCKETS = 12;
/** hard ceiling on emitted buckets — guards a pathological `days` value */
export const MAX_ACTIVITY_BUCKETS = 500;

const VALID_BUCKETS: ActivityBucket[] = ['day', 'week', 'month'];
const DAY_MS = 86_400_000;

// -- input / output -----------------------------------------------------------

export type ActivityInput = {
    bucket?: ActivityBucket;
    /** inclusive ISO 8601 lower bound (e.g. '2026-08-01' or a full timestamp) */
    from?: string;
    /** exclusive ISO 8601 upper bound */
    to?: string;
    source?: string;
    /** default window in days when `from` is omitted */
    days?: number;
};

export type ActivityTotals = {
    nodes: number;
    messages: number;
    contexts: number;
    root_contexts: number;
    /** distinct sources seen in the window */
    sources: number;
    /** buckets that contain at least one event */
    active_buckets: number;
};

export type ActivitySourceTotal = {
    source: string;
    nodes: number;
    messages: number;
    contexts: number;
    root_contexts: number;
};

export type ActivityPoint = {
    bucket_start: string;
    nodes: number;
    messages: number;
    contexts: number;
    root_contexts: number;
    /** null when the bucket is empty (gap-filled) */
    first_event_at: string | null;
    last_event_at: string | null;
    sources: string[];
};

export type ActivityResultData = {
    bucket: ActivityBucket;
    from: string;
    to: string;
    totals: ActivityTotals;
    by_source: ActivitySourceTotal[];
    series: ActivityPoint[];
};

// -- bucket helpers -----------------------------------------------------------

// Start of the bucket containing `date`, in UTC, as 'YYYY-MM-DD'.
// Weeks start on Monday so Postgres date_trunc('week'), SQLite and JS agree.
export function bucketStart(value: string | number | Date, bucket: ActivityBucket): string {
    const date = new Date(value);
    if (isNaN(date.getTime())) throw new TypeError(`Invalid timestamp: ${String(value)}`);

    const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

    if (bucket === 'month') {
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-01`;
    }

    if (bucket === 'week') {
        // 1970-01-01 was a Thursday; shift so day 0 of the epoch week is Monday.
        const dayOfWeek = (date.getUTCDay() + 6) % 7;
        const monday = new Date(utc - dayOfWeek * DAY_MS);
        return iso(monday);
    }

    return iso(new Date(utc));
}

function nextBucket(start: string, bucket: ActivityBucket): string {
    return shiftBucket(start, bucket, 1);
}

function shiftBucket(start: string, bucket: ActivityBucket, delta: number): string {
    const date = new Date(`${start}T00:00:00.000Z`);
    if (bucket === 'month') {
        return bucketStart(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1), 'month');
    }
    const step = bucket === 'week' ? 7 * DAY_MS : DAY_MS;
    return bucketStart(date.getTime() + delta * step, bucket);
}

// Width of the default window, in whole buckets. A caller asking for months
// wants a year of history, not the 1–2 buckets a 30-day window would produce.
function defaultBuckets(bucket: ActivityBucket, days: number | undefined): number {
    const fallback =
        bucket === 'week' ? DEFAULT_WEEK_BUCKETS : bucket === 'month' ? DEFAULT_MONTH_BUCKETS : DEFAULT_ACTIVITY_DAYS;
    if (days === undefined || !Number.isFinite(days) || days < 1) return fallback;

    const spanDays = bucket === 'week' ? 7 : bucket === 'month' ? 30 : 1;
    return clampInt(Math.ceil(days / spanDays), fallback);
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// -- op -----------------------------------------------------------------------

export async function getProjectActivity(
    storage: StorageAdapter,
    projectId: number,
    input: ActivityInput = {},
): Promise<Result<ActivityResultData>> {
    const bucket = input.bucket ?? 'day';
    if (!VALID_BUCKETS.includes(bucket)) {
        return err('invalid_input', `Invalid bucket '${String(input.bucket)}'. Use day, week or month.`);
    }

    const now = new Date();

    if (input.from !== undefined && isNaN(Date.parse(input.from))) {
        return err('invalid_input', 'Invalid from timestamp');
    }
    if (input.to !== undefined && isNaN(Date.parse(input.to))) {
        return err('invalid_input', 'Invalid to timestamp');
    }

    const to = input.to ? new Date(input.to) : now;
    const from = input.from
        ? new Date(input.from)
        : new Date(`${shiftBucket(bucketStart(to, bucket), bucket, -(defaultBuckets(bucket, input.days) - 1))}T00:00:00.000Z`);

    if (from.getTime() > to.getTime()) {
        return err('invalid_input', '`from` must not be after `to`');
    }

    const query: ActivityQuery = {
        bucket,
        from: from.toISOString(),
        to: to.toISOString(),
    };
    if (input.source) query.source = input.source;

    let rows: ActivityRow[];
    try {
        rows = await storage.projectActivity(projectId, query);
    } catch (error) {
        return err('internal', `Activity query failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return ok(rollup(rows, bucket, query.from!, query.to!));
}

function clampInt(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(1, Math.min(MAX_ACTIVITY_BUCKETS, Math.floor(value)));
}

// -- rollup -------------------------------------------------------------------

// Pure so it is testable without a database and identical across adapters.
export function rollup(
    rows: ActivityRow[],
    bucket: ActivityBucket,
    from: string,
    to: string,
): ActivityResultData {
    const byBucket = new Map<string, ActivityPoint>();
    const bySource = new Map<string, ActivitySourceTotal>();

    for (const row of rows) {
        const start = row.bucket_start;

        let point = byBucket.get(start);
        if (!point) {
            point = {
                bucket_start: start,
                nodes: 0,
                messages: 0,
                contexts: 0,
                root_contexts: 0,
                first_event_at: null,
                last_event_at: null,
                sources: [],
            };
            byBucket.set(start, point);
        }

        point.nodes += num(row.node_count);
        point.messages += num(row.message_count);
        point.contexts += num(row.context_count);
        point.root_contexts += num(row.root_context_count);
        if (!point.sources.includes(row.source)) point.sources.push(row.source);

        const first = row.first_event_at || null;
        const last = row.last_event_at || null;
        if (first && (point.first_event_at === null || first < point.first_event_at)) point.first_event_at = first;
        if (last && (point.last_event_at === null || last > point.last_event_at)) point.last_event_at = last;

        let source = bySource.get(row.source);
        if (!source) {
            source = { source: row.source, nodes: 0, messages: 0, contexts: 0, root_contexts: 0 };
            bySource.set(row.source, source);
        }
        source.nodes += num(row.node_count);
        source.messages += num(row.message_count);
        source.contexts += num(row.context_count);
        source.root_contexts += num(row.root_context_count);
    }

    const series = gapFill(byBucket, bucket, from, to);

    const totals: ActivityTotals = {
        nodes: 0,
        messages: 0,
        contexts: 0,
        root_contexts: 0,
        sources: bySource.size,
        active_buckets: series.filter((p) => p.nodes > 0).length,
    };
    for (const point of series) {
        totals.nodes += point.nodes;
        totals.messages += point.messages;
        totals.contexts += point.contexts;
        totals.root_contexts += point.root_contexts;
    }

    const by_source = [...bySource.values()].sort(
        (a, b) => b.messages - a.messages || a.source.localeCompare(b.source),
    );

    return { bucket, from, to, totals, by_source, series };
}

// Walk the window and insert zero rows for buckets with no traffic, so charts
// render a continuous axis instead of collapsing silent days.
function gapFill(
    points: Map<string, ActivityPoint>,
    bucket: ActivityBucket,
    from: string,
    to: string,
): ActivityPoint[] {
    const first = bucketStart(from, bucket);
    const last = bucketStart(new Date(new Date(to).getTime() - 1).toISOString(), bucket);

    const out: ActivityPoint[] = [];
    let cursor = first;
    let guard = 0;

    while (cursor <= last && guard++ <= MAX_ACTIVITY_BUCKETS) {
        out.push(
            points.get(cursor) ?? {
                bucket_start: cursor,
                nodes: 0,
                messages: 0,
                contexts: 0,
                root_contexts: 0,
                first_event_at: null,
                last_event_at: null,
                sources: [],
            },
        );
        cursor = nextBucket(cursor, bucket);
    }

    // Anything outside the requested window (clock skew, adapter rounding) is
    // still reported — appended in ascending order rather than silently dropped.
    const strays = [...points.values()]
        .filter((p) => !out.some((q) => q.bucket_start === p.bucket_start))
        .sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));

    return [...out, ...strays];
}

function num(value: number | string | null | undefined): number {
    const n = typeof value === 'string' ? Number(value) : (value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

// -- shared aggregation (adapters without server-side rollup) -----------------

export type ActivityAggregateInput = {
    created_at: string;
    type: string;
    context_id: string | null;
    metadata?: Record<string, unknown> | null;
};

/**
 * Group raw node rows into (bucket × source) rollups in JavaScript.
 * Used by adapters whose backend cannot express the rollup in one query
 * (Supabase REST, in-memory). SQL adapters do this in the database instead,
 * but the output shape is identical by contract.
 */
export function aggregateActivity(
    input: ActivityAggregateInput[],
    query: ActivityQuery,
): ActivityRow[] {
    const groups = new Map<string, ActivityRow>();

    for (const node of input) {
        const createdAt = String(node.created_at ?? '');
        if (!createdAt) continue;
        if (query.from && createdAt < query.from) continue;
        if (query.to && createdAt >= query.to) continue;

        const meta = (node.metadata ?? {}) as Record<string, unknown>;
        const source = typeof meta.source === 'string' && meta.source ? meta.source : 'unknown';
        if (query.source && source !== query.source) continue;

        const start = bucketStart(createdAt, query.bucket);
        const key = `${start}\u0000${source}`;

        let row = groups.get(key);
        if (!row) {
            row = {
                bucket_start: start,
                source,
                node_count: 0,
                message_count: 0,
                context_count: 0,
                root_context_count: 0,
                first_event_at: createdAt,
                last_event_at: createdAt,
            };
            groups.set(key, row);
        }

        row.node_count += 1;
        if (node.type === 'context') {
            row.context_count += 1;
            if (!node.context_id) row.root_context_count += 1;
        } else {
            row.message_count += 1;
        }
        if (createdAt < row.first_event_at) row.first_event_at = createdAt;
        if (createdAt > row.last_event_at) row.last_event_at = createdAt;
    }

    return [...groups.values()].sort(
        (a, b) => a.bucket_start.localeCompare(b.bucket_start) || a.source.localeCompare(b.source),
    );
}
