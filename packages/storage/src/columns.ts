// =============================================================================
// COLUMN PROJECTION — shared by the SQL adapters' findNodesByContextId
// =============================================================================
//
// `StorageAdapter.findNodesByContextId(contextId, columns?)` takes an optional
// projection, and for a long time every adapter ignored it and returned
// `public_id, prev_id` — which was fine while the only caller was the chain
// walk, and silently wrong the moment a caller asked for something else
// (`nextOrdinal` needs `ordinal`, ARCH-002: an ignored projection reads as
// `undefined`, and MAX(undefined) looks exactly like "empty partition").
//
// These helpers make the contract real in one place so the three SQL adapters
// cannot drift apart again.

import type { NodeRow } from '@ultracontext/core';

/**
 * What a caller gets when it does not ask for anything: the two columns the
 * prev_id walk needs. Keeping the default narrow is the point of having a
 * projection at all — a caller after one integer should not drag every
 * message's content JSONB across the wire.
 */
export const DEFAULT_NODE_COLUMNS: (keyof NodeRow)[] = ['public_id', 'prev_id'];

export function requestedNodeColumns(columns?: (keyof NodeRow)[]): (keyof NodeRow)[] {
    return columns && columns.length > 0 ? columns : DEFAULT_NODE_COLUMNS;
}

/**
 * Build a Drizzle `select({ … })` shape for the requested columns. Columns the
 * table does not declare are skipped rather than throwing: a projection is a
 * read hint, and one adapter missing a column must not take the whole read
 * path down with it.
 */
// The return type is deliberately loose: Drizzle's `select()` wants concrete
// column objects (PgColumn / SQLiteColumn), and this helper is shared by both
// dialects so it cannot name either. `unknown` values are rejected by
// SelectedFields; `any` lets each adapter's own table type do the checking.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickNodeColumns(table: object, columns?: (keyof NodeRow)[]): Record<string, any> {
    const source = table as Record<string, unknown>;
    const projection: Record<string, any> = {};
    for (const column of requestedNodeColumns(columns)) {
        const target = source[column as string];
        if (target) projection[column as string] = target;
    }
    return projection;
}

/** Same projection as a PostgREST select list ("public_id,prev_id,ordinal"). */
export function nodeColumnsSelectList(columns?: (keyof NodeRow)[]): string {
    return requestedNodeColumns(columns).join(',');
}
