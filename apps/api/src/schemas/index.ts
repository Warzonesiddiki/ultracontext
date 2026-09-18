// =============================================================================
// REQUEST SCHEMAS — zod contracts for every route (API-009)
// =============================================================================
// These are the FIRST line of validation: shape-level checks that run before
// the core ops apply their semantic rules. The numeric rules intentionally
// MIRROR the core parsers byte-for-byte so the two layers can never disagree
// about which inputs are legal:
//   - parseIndex (packages/core): /^[+-]?\d+$/  — strict, no trim, no parseInt
//   - parseLimit (packages/core): /^\d+$/       — out-of-range is CLAMPED,
//     never rejected, so the schema enforces digit-only and leaves the
//     [1, 100] clamp to the route/core.
// Where the route/core stays deliberately lenient (unknown keys on some
// bodies, parseInt-style `days`), the schema stays equally lenient — the goal
// is an earlier, consistent 400 with a machine-readable code, not a behaviour
// change. Semantic checks (id XOR index, out-of-range, empty ids, ambiguous
// permanent+ids) remain in the core ops, which own the precise error text.

import { z } from 'zod';

// -- shared primitives ----------------------------------------------------------

/** Strict integer string — mirrors core `parseIndex` (/^[+-]?\d+$/). */
export const StrictIntString = z
    .string()
    .regex(/^[+-]?\d+$/, 'must be an integer');

/** Non-negative integer string — mirrors core `parseLimit` (/^\d+$/). */
export const LimitString = z
    .string()
    .regex(/^\d+$/, 'must be a positive integer');

/** User-supplied metadata — always a plain object when present. */
export const Metadata = z.record(z.unknown());

/** version / at selectors accept a JSON number OR a strict integer string
 *  (core parseIndex handles both). */
const VersionSelector = z.union([z.number().int(), StrictIntString]);

/**
 * `version` selector for JSON bodies (ARCH-001).
 *
 * Two addressing modes coexist: an immutable version id (`ctx_…`, the mode new
 * code should use) and a positional index (deprecated alias, kept so nothing
 * that works today breaks). A JSON number must still be an INTEGER — a
 * fractional index is meaningless and 400s here rather than reaching core. A
 * string is passed through untouched: only core can tell an index string from
 * an id, and it owns the 404 for an unknown one.
 *
 * `at` deliberately does NOT use this: it is a message index with no id form,
 * so it stays a strict integer (StrictIntString).
 */
const BodyVersionSelector = z.union([z.number().int(), z.string().min(1)]);

// -- POST /contexts (create) ----------------------------------------------------

// Strict: unknown keys 400 — `{form: …}` must never silently create a context
// without forking. `before` is a string here; the core validates the
// timestamp format (Date.parse) and 400s with its own message.
export const CreateContextSchema = z
    .object({
        from: z.string().min(1).optional(),
        version: BodyVersionSelector.optional(),
        at: VersionSelector.optional(),
        before: z.string().optional(),
        metadata: Metadata.optional(),
    })
    .strict();
export type CreateContextBody = z.infer<typeof CreateContextSchema>;

// -- GET /contexts (list) ---------------------------------------------------------

export const ListContextsQuerySchema = z.object({
    limit: LimitString.optional(),
    source: z.string().optional(),
    user_id: z.string().optional(),
    host: z.string().optional(),
    project_path: z.string().optional(),
    session_id: z.string().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
});
export type ListContextsQuery = z.infer<typeof ListContextsQuerySchema>;

// -- GET /contexts/search ----------------------------------------------------------

// `q` is required and non-empty (core trims and 400s whitespace-only queries
// with 'query is required'); `limit` is strictly parsed here, matching the
// strictness established for list (API-001).
export const SearchQuerySchema = z.object({
    q: z.string().min(1, 'query is required'),
    limit: LimitString.optional(),
    source: z.string().optional(),
    user_id: z.string().optional(),
    host: z.string().optional(),
    project_path: z.string().optional(),
    session_id: z.string().optional(),
    after: z.string().optional(),
    before: z.string().optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

// -- GET /contexts/stats -------------------------------------------------------------

// `days` mirrors the route's parseInt logic exactly (lenient about format,
// strict about the result: >= 1).
export const StatsQuerySchema = z.object({
    bucket: z.enum(['day', 'week', 'month']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    days: z
        .string()
        .refine(
            (v) => !Number.isNaN(parseInt(v)) && parseInt(v) >= 1,
            'Invalid days value'
        )
        .optional(),
    source: z.string().optional(),
});
export type StatsQuery = z.infer<typeof StatsQuerySchema>;

// -- GET /contexts/:id --------------------------------------------------------------

// history: any string passes (the route interprets === 'true'); `at` is a strict
// integer string (core parseIndex rejects everything else with 400).
//
// `version` is NOT strict-int any more (ARCH-001): it accepts an immutable
// version id (`ctx_…`) as well as the deprecated positional index. A query
// string cannot distinguish the two, and the gateway must not guess — so zod
// only rejects the empty value and core resolves the selector, returning 404
// for an id that is not in the chain. Malformed *numeric* input is still
// impossible to mistake for an id: '1abc' and ' 1 ' simply are not versions.
//
// Pagination (API-010): `limit` is digit-only and clamped to [1, 1000] in the
// route; `offset` is digit-only (non-negative by construction). ABSENT
// limit+offset means "return everything" — the response shape is unchanged,
// so no existing client (SDKs, MCP, dashboards) ever sees a truncated page.
export const GetContextQuerySchema = z.object({
    version: z.string().min(1).optional(),
    at: StrictIntString.optional(),
    before: z.string().optional(),
    history: z.string().optional(),
    limit: LimitString.optional(),
    offset: LimitString.optional(),
});
export type GetContextQuery = z.infer<typeof GetContextQuerySchema>;

// -- /contexts/:id/branches (ARCH-001) -------------------------------------------
//
// A named branch pins a human-chosen name to an immutable version id, so a
// saved reference keeps meaning the same thing as the chain grows. The name
// rules below MIRROR core `isValidBranchName` byte-for-byte (same discipline as
// StrictIntString/parseIndex): the gateway rejects bad names early with a
// consistent 400, and core owns the canonical rule text for callers that reach
// it directly (SDKs, MCP, in-process use).
export const BRANCH_NAME_MAX_LEN = 64;

export const BranchName = z
    .string()
    .min(1, 'name is required')
    .max(BRANCH_NAME_MAX_LEN, `name must be at most ${BRANCH_NAME_MAX_LEN} characters`)
    .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        'name must start with a letter or digit and contain only [A-Za-z0-9._-]'
    )
    .refine((v) => !v.includes('..'), { message: "name must not contain '..'" })
    .refine((v) => !v.endsWith('.') && !v.endsWith('-'), {
        message: "name must not end with '.' or '-'",
    });

/** Path param for DELETE /contexts/:id/branches/:name. */
export const BranchNameParamSchema = z.object({ name: BranchName });
export type BranchNameParam = z.infer<typeof BranchNameParamSchema>;

// Strict: an unknown key (e.g. `{branch: 'main'}`) must 400 rather than
// silently pin a nameless branch. `version` omitted → pin the current head.
export const CreateBranchSchema = z
    .object({
        name: BranchName,
        version: BodyVersionSelector.optional(),
    })
    .strict();
export type CreateBranchBody = z.infer<typeof CreateBranchSchema>;

// -- POST /contexts/delete-many --------------------------------------------------------

// 1..100 string ids (core enforces the same bounds). Unknown keys pass through
// to preserve the route's current leniency.
export const DeleteManySchema = z
    .object({
        ids: z
            .array(z.string())
            .min(1, 'ids must be a non-empty array')
            .max(100, 'ids must contain at most 100 items'),
    })
    .passthrough();
export type DeleteManyBody = z.infer<typeof DeleteManySchema>;

// -- POST /contexts/:id (append) --------------------------------------------------------

// One message object OR an array of them. `metadata` must be an object when
// present (extracted to the message level); every other field is content —
// including the reserved `index`, which the core rejects.
const AppendMessageSchema = z
    .object({
        metadata: Metadata.optional(),
    })
    .passthrough();
export const AppendInputSchema = z.union([
    AppendMessageSchema,
    z.array(AppendMessageSchema),
]);
export type AppendInput = z.infer<typeof AppendInputSchema>;

// -- PATCH /contexts/:id (update) ---------------------------------------------------------

// Three accepted shapes (core parseUpdateRequestBody):
//   1. array of updates
//   2. { updates: [...], metadata? }  — metadata = version audit trail
//   3. a single update object (metadata = version audit trail)
// Each update targets by `id` XOR `index` (the core enforces the XOR and the
// index range); all other keys merge into the message content.
const UpdateInputSchema = z
    .object({
        id: z.string().optional(),
        index: VersionSelector.optional(),
        metadata: Metadata.optional(),
    })
    .passthrough();
// Top-level single update: when an `updates` key is present it must start an
// array-of-updates object (core: 'updates must be an array'). Inside an ARRAY
// of updates, an `updates` field is ordinary content, so the refine applies
// only to the top-level single form.
const SingleUpdateSchema = UpdateInputSchema.refine(
    (v) => v.updates === undefined || Array.isArray(v.updates),
    { message: 'updates must be an array' }
);
export const UpdateBodySchema = z.union([
    z.array(UpdateInputSchema),
    z
        .object({
            updates: z.array(UpdateInputSchema),
            metadata: Metadata.optional(),
        })
        .passthrough(),
    SingleUpdateSchema,
]);
export type UpdateBody = z.infer<typeof UpdateBodySchema>;

// -- DELETE /contexts/:id ------------------------------------------------------------------

// Deliberately shape-only: the permanent-vs-ids disambiguation (including the
// ambiguous permanent+ids 400 and the legacy empty-{} tolerance) stays in the
// route, and ids emptiness/integer checks stay in core deleteMessages.
export const DeleteInputSchema = z
    .object({
        ids: z
            .union([
                z.string(),
                z.number(),
                z.array(z.union([z.string(), z.number()])),
            ])
            .optional(),
        permanent: z.boolean().optional(),
        metadata: Metadata.optional(),
    })
    .passthrough();
export type DeleteInput = z.infer<typeof DeleteInputSchema>;

// -- /v1/keys (admin) ---------------------------------------------------------------------

// createKey requires a non-empty string name (the core 400s 'name is
// required'); unknown keys are rejected so a typo cannot silently create a
// misnamed key.
export const CreateKeySchema = z
    .object({
        name: z.string().min(1, 'name is required'),
    })
    .strict();
export type CreateKeyBody = z.infer<typeof CreateKeySchema>;

// Numeric path params — mirrors the keys route's parseId exactly:
// Number() coercion, must be an integer > 0.
const PositiveIntParam = z.string().refine(
    (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0;
    },
    'must be a positive integer'
);

export const KeyProjectParamSchema = z.object({ projectId: PositiveIntParam });
export const KeyIdParamSchema = z.object({ id: PositiveIntParam });
export type KeyProjectParam = z.infer<typeof KeyProjectParamSchema>;
export type KeyIdParam = z.infer<typeof KeyIdParamSchema>;
