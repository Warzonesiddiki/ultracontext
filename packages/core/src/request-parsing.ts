export type UpdateRequestInput = { id?: string; index?: number; [key: string]: unknown };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// -- strict numeric parsing ---------------------------------------------------

// Strict integer parsing for user-supplied indices (version / at selectors).
//
// parseInt() silently accepts garbage — parseInt("1abc") === 1,
// parseInt("1.9") === 1, parseInt(" 1 ") === 1 — so a malformed selector
// must be rejected (400), never silently resolved to a real index.
// Whitespace is NOT trimmed: Number() trims it, which is exactly the leak
// we are closing.
export function parseIndex(value: unknown): number | null {
    if (typeof value === 'number') return Number.isInteger(value) ? value : null;
    if (typeof value !== 'string') return null;
    if (!/^[+-]?\d+$/.test(value)) return null;
    const n = Number(value);
    return Number.isInteger(n) ? n : null;
}

// Strict parse for ?limit= — NaN/empty/non-numeric → null (caller 400s),
// out-of-range is clamped into [min, max] rather than rejected.
export function parseLimit(raw: string | null | undefined, min = 1, max = 100): number | null {
    if (raw === undefined || raw === null) return null;
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return Math.min(max, Math.max(min, n));
}

export function parseUpdateRequestBody(body: unknown): { updates: UpdateRequestInput[]; userMetadata?: Record<string, unknown> } | { error: string } {
    if (Array.isArray(body)) {
        return { updates: body as UpdateRequestInput[] };
    }

    if (!isPlainObject(body)) {
        return { error: 'Request body must be a JSON object or array' };
    }

    const { metadata, updates, ...single } = body;

    if (metadata !== undefined && !isPlainObject(metadata)) {
        return { error: 'metadata must be an object' };
    }

    if (updates !== undefined) {
        if (!Array.isArray(updates)) return { error: 'updates must be an array' };
        return { updates: updates as UpdateRequestInput[], userMetadata: metadata as Record<string, unknown> | undefined };
    }

    return { updates: [single as UpdateRequestInput], userMetadata: metadata as Record<string, unknown> | undefined };
}
