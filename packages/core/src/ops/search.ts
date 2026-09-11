// =============================================================================
// SEARCH — full-text search across a project's captured context
// =============================================================================
// Search is a first-class capability, not a paid add-on. UltraContext is free
// and self-hosted: there is no query quota, no metering, and no paywall. Every
// adapter implements it with the best mechanism its backend offers
// (SQLite FTS5 · Postgres tsvector · Supabase text search · in-memory scan).

import type { SearchFilters, SearchHit, StorageAdapter } from '../storage';
import { err, ok, type Result } from '../result';

// -- limits -------------------------------------------------------------------

export const MAX_SEARCH_QUERY_LEN = 256;
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;

// -- input / output -----------------------------------------------------------

export type SearchInput = SearchFilters & {
    query: string;
    limit?: number;
};

export type SearchResultData = {
    query: string;
    limit: number;
    data: SearchHit[];
};

// -- helpers ------------------------------------------------------------------

// Collapse a message's content to the text a human would consider "the message".
// Daemon-ingested messages carry { message, event_type, timestamp, raw }; raw is
// a full agent transcript line and is deliberately excluded from search so
// results stay readable and the index stays small.
// Handles both shapes we see in the wild:
//   SDK:     { role, content: 'Hello!' }
//   daemon:  { role, content: { message, event_type, timestamp, raw } }
// `raw` is never indexed — it is a full agent transcript line and would swamp
// results with noise.
export function searchableText(content: unknown, depth = 0): string {
    if (typeof content === 'string') return content;
    if (!content || typeof content !== 'object' || depth > 3) return '';

    const record = content as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.text === 'string') return record.text;

    return searchableText(record.content, depth + 1);
}

// Build a short snippet centred on the first case-insensitive match, so callers
// can render results without downloading whole messages.
export function snippet(text: string, query: string, radius = 90): string {
    if (!text) return '';

    const needle = query.trim().toLowerCase();
    if (!needle) return text.slice(0, radius * 2);

    const at = text.toLowerCase().indexOf(needle);
    if (at === -1) return text.slice(0, radius * 2);

    const start = Math.max(0, at - radius);
    const end = Math.min(text.length, at + needle.length + radius);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';

    return prefix + text.slice(start, end) + suffix;
}

// -- op -----------------------------------------------------------------------

export async function searchMessages(
    storage: StorageAdapter,
    projectId: number,
    input: SearchInput
): Promise<Result<SearchResultData>> {
    const query = typeof input?.query === 'string' ? input.query.trim() : '';

    if (!query) return err('invalid_input', 'query is required');
    if (query.length > MAX_SEARCH_QUERY_LEN) {
        return err('invalid_input', `query must be at most ${MAX_SEARCH_QUERY_LEN} characters`);
    }

    // limit: undefined → default; NaN/negative/oversized → clamped, never rejected
    const rawLimit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    const limit = Number.isFinite(rawLimit)
        ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_SEARCH_LIMIT)
        : DEFAULT_SEARCH_LIMIT;

    const filters: SearchFilters = {};
    for (const key of ['source', 'user_id', 'host', 'project_path', 'session_id', 'after', 'before'] as const) {
        const value = input[key];
        if (typeof value === 'string' && value) filters[key] = value;
    }

    let data: SearchHit[];
    try {
        data = await storage.searchMessages(projectId, query, filters, limit);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed';
        return err('internal', message);
    }

    return ok({
        query,
        limit,
        data: data.map((hit) => ({ ...hit, content: snippet(hit.content ?? '', query) })),
    });
}
