// =============================================================================
// GET CONTEXT — read a context's messages with version-control semantics
// (ported from GET /contexts/:id)
// =============================================================================

import { findHead, getOrderedNodes, getVersions, type VersionInfo } from '../context-chain';
import type { MessageView } from '../message-view';
import { parseIndex } from '../request-parsing';
import type { StorageAdapter } from '../storage';
import { ok, err, type Result } from '../result';

// -- types --------------------------------------------------------------------

// selection + shaping options (mirror the route's query params)
export type GetContextOptions = {
    version?: number | string;
    at?: number | string;
    before?: string;
    history?: boolean;
};

// optional history entries when history is requested
type VersionEntry = {
    version: number;
    /**
     * Immutable version id (ARCH-001) — the public id of the version head.
     * Prefer this over `version` when saving a reference: positional indexes
     * shift as the chain grows, this never does.
     */
    id: string;
    created_at: string;
    operation: 'create' | 'append' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

type GetContextResult = { data: MessageView[]; version: number; versions?: VersionEntry[] };

// -- version selection (ARCH-001) ---------------------------------------------
//
// Versions used to be addressable ONLY by positional index, and indices shift
// every time a new version is appended — so a `?version=3` saved in a script or
// a branch pointer silently changed meaning later. Two addressing modes now
// coexist:
//
//   1. immutable id  — the version head's public id (`ctx_…`). Never moves,
//                      never re-used. This is the mode new code should use,
//                      and what named branches pin.
//   2. positional index — kept as a DEPRECATED alias so every existing client,
//                      SDK and script keeps working unchanged. Negative indexes
//                      count back from the head (git/Python style): -1 = latest.
//
// The gateway cannot tell the two apart (a query string is always text), so the
// decision lives here, in one place: an integer-looking selector is positional,
// anything else is an id. Public ids are always `ctx_`/`msg_`-prefixed, so the
// two spaces can never collide.

/** How a `version` selector was interpreted. */
export type VersionSelection = { kind: 'index'; index: number } | { kind: 'id'; id: string };

/** A resolved selector: which head to read, and its positional index. */
export type ResolvedVersion = { headId: string; version: number };

// Mirrors core `parseIndex` (/^[+-]?\d+$/) — deliberately NOT trimmed, so
// ' 1 ' stays an id lookup (→ 404) instead of silently becoming index 1.
const INDEX_STRING = /^[+-]?\d+$/;

/**
 * Classify a raw selector without touching the chain. Returns null for values
 * that are neither an integer nor a non-empty string (fractional JSON numbers,
 * booleans, null) — callers map that to 400 invalid_input.
 */
export function classifyVersionSelection(value: unknown): VersionSelection | null {
    if (typeof value === 'number') return Number.isInteger(value) ? { kind: 'index', index: value } : null;
    if (typeof value !== 'string') return null;
    if (value.length === 0) return null;
    if (INDEX_STRING.test(value)) return { kind: 'index', index: Number(value) };
    return { kind: 'id', id: value };
}

/**
 * Resolve a selector against a chain's versions.
 *   - malformed selector            → invalid_input (400)
 *   - index/id outside the chain    → not_found     (404)
 */
export function resolveVersionSelection(versions: VersionInfo[], value: unknown): Result<ResolvedVersion> {
    const selection = classifyVersionSelection(value);
    if (selection === null) return err('invalid_input', 'Invalid version');

    if (selection.kind === 'id') {
        const match = versions.find((v) => v.head_id === selection.id);
        if (!match) return err('not_found', 'Version not found');
        return ok({ headId: match.head_id, version: match.version });
    }

    const len = versions.length;
    const idx = selection.index < 0 ? len + selection.index : selection.index;
    if (idx < 0 || idx >= len) return err('not_found', 'Version not found');
    return ok({ headId: versions[idx].head_id, version: versions[idx].version });
}

// -- op -----------------------------------------------------------------------

export async function getContext(
    storage: StorageAdapter,
    projectId: number,
    contextId: string,
    opts: GetContextOptions
): Promise<Result<GetContextResult>> {
    // history flag toggles inclusion of versions[]
    const includeHistory = opts.history === true;

    // parse + validate the before timestamp up front
    let beforeTs: number | undefined;
    if (opts.before !== undefined) {
        beforeTs = Date.parse(opts.before);
        if (isNaN(beforeTs)) return err('invalid_input', 'Invalid timestamp format');
    }

    // root must exist within this project
    const root = await storage.findRootContext(projectId, contextId);
    if (!root) return err('not_found', 'Context not found');

    // collect all version heads under the root
    const versions = await getVersions(storage, root.public_id);
    let head: { public_id: string } | null;
    let currentVersion: number;

    // select the head: explicit version (index or immutable id) → before
    // timestamp → latest
    if (opts.version !== undefined) {
        const resolved = resolveVersionSelection(versions, opts.version);
        if (!resolved.ok) return resolved;
        head = { public_id: resolved.data.headId };
        currentVersion = resolved.data.version;
    } else if (beforeTs !== undefined) {
        const targetVersion = versions.filter((v) => new Date(v.created_at).getTime() <= beforeTs!).pop();
        if (!targetVersion) return err('not_found', 'No version found before timestamp');
        head = { public_id: targetVersion.head_id };
        currentVersion = targetVersion.version;
    } else {
        head = await findHead(storage, root.public_id);
        currentVersion = versions.length - 1;
    }

    // no head → empty context at version 0
    if (!head) return ok({ data: [], version: 0 });

    // ordered messages under the head, optionally filtered by the before cutoff
    let orderedNodes = await getOrderedNodes(storage, root.public_id, head.public_id);
    if (beforeTs !== undefined) {
        orderedNodes = orderedNodes.filter((n) => new Date(n.created_at).getTime() <= beforeTs!);
    }

    // build the optional history payload
    const versionsResponse = includeHistory
        ? versions.map(({ version, head_id, created_at, operation, affected, metadata }) => ({
              version,
              // immutable address for this version (ARCH-001) — `version` above
              // is the deprecated positional alias
              id: head_id,
              created_at,
              operation,
              affected,
              metadata,
          }))
        : undefined;

    // at slices messages up to and including the index, re-indexed from 0
    if (opts.at !== undefined) {
        const idx = parseIndex(opts.at);
        if (idx === null || idx < 0) return err('invalid_input', 'Invalid index');
        if (idx >= orderedNodes.length) return err('not_found', 'Index out of range');

        const sliced = orderedNodes.slice(0, idx + 1).map((n: any, i: number) => ({
            ...n.content,
            id: n.public_id,
            index: i,
            created_at: n.created_at,
            metadata: n.metadata,
        }));
        return ok({ data: sliced, version: currentVersion, ...(versionsResponse && { versions: versionsResponse }) });
    }

    // default: all ordered messages
    const result = orderedNodes.map((n: any, index: number) => ({
        ...n.content,
        id: n.public_id,
        index,
        // wall-clock creation time — lets clients discover ?before= targets
        // and render when-each-message-arrived without extra round-trips
        created_at: n.created_at,
        metadata: n.metadata,
    }));

    return ok({ data: result, version: currentVersion, ...(versionsResponse && { versions: versionsResponse }) });
}
