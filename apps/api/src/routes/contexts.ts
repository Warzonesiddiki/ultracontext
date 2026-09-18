import {
    appendMessages,
    createBranch,
    createContext,
    deleteBranch,
    deleteContextPermanent,
    deleteManyContexts,
    deleteMessages,
    getContext,
    getProjectActivity,
    isPlainObject,
    listBranches,
    listContexts,
    parseLimit,
    updateMessages,
    searchMessages,
    type ContextFilters,
} from '@ultracontext/core';
import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv, HttpApp, HttpContext } from '../types/http';
import { RETRY_AFTER_SECONDS, errorResponse } from '../http-error';
import { jsonV, optionalJsonV, paramV, queryV } from '../middleware/validate';
import {
    AppendInputSchema,
    BranchNameParamSchema,
    CreateBranchSchema,
    CreateContextSchema,
    DeleteInputSchema,
    DeleteManySchema,
    GetContextQuerySchema,
    ListContextsQuerySchema,
    SearchQuerySchema,
    StatsQuerySchema,
    UpdateBodySchema,
    type CreateBranchBody,
} from '../schemas';

// -- request-body ceiling ------------------------------------------------------
// 8 MiB: far beyond any legitimate single message (agent file pastes top out
// around a few hundred KB) yet below what a runaway/malicious JSON body can
// hold in memory. The sync daemon bulk-appends in batches of 50, so the cap
// must stay comfortably above ~50 messages worth of content.
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
const jsonBodyLimit = bodyLimit({ maxSize: MAX_JSON_BODY_BYTES });

// GET /contexts/:id page-size ceiling (API-010). 1,000 is 100× the sync
// daemon's batch size and 10% of a context's 10,000-message maximum — big
// enough to be useful, small enough that a single page can't balloon the
// response.
const MAX_MESSAGES_PER_PAGE = 1000;

// -- routes -------------------------------------------------------------------

export function registerContextRoutes(app: HttpApp) {
    // The minimal HttpApp type doesn't express route-level middleware; the
    // real Hono instance (createApp returns Hono<AppEnv>) does. Every route
    // below registers its zod validator (API-009) before the handler.
    const hono = app as unknown as Hono<AppEnv>;

    // create context — zod-gated body, call core, map Result
    hono.post('/contexts', optionalJsonV(CreateContextSchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => ({}));

        const result = await createContext(storage, projectId, body);
        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data, 201);
    });

    // list contexts — zod-gated query, call core listContexts
    hono.get('/contexts', queryV(ListContextsQuerySchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        // strict parse: ?limit=abc → 400 (not NaN into .limit()); out-of-range
        // is clamped into [1, 100]; absent → default 20
        const rawLimit = c.req.query('limit');
        const limit = rawLimit === undefined ? 20 : parseLimit(rawLimit, 1, 100);
        if (limit === null) return c.json({ error: 'limit must be a positive integer', code: 'invalid_input' }, 400);

        // metadata + timestamp filters
        const filters: ContextFilters & { limit?: number } = { limit };
        const source = c.req.query('source');
        const userId = c.req.query('user_id');
        const host = c.req.query('host');
        const projectPath = c.req.query('project_path');
        const sessionId = c.req.query('session_id');
        const after = c.req.query('after');
        const before = c.req.query('before');
        if (source) filters.source = source;
        if (userId) filters.user_id = userId;
        if (host) filters.host = host;
        if (projectPath) filters.project_path = projectPath;
        if (sessionId) filters.session_id = sessionId;
        if (after) {
            if (isNaN(Date.parse(after))) return c.json({ error: 'Invalid after timestamp', code: 'invalid_input' }, 400);
            filters.after = after;
        }
        if (before) {
            if (isNaN(Date.parse(before))) return c.json({ error: 'Invalid before timestamp', code: 'invalid_input' }, 400);
            filters.before = before;
        }

        const data = await listContexts(storage, projectId, filters);
        return c.json(data);
    });

    // -- full-text search (must be registered before :id routes) ----------------

    // Search is free and unmetered — UltraContext has no query quota and no paywall.
    hono.get('/contexts/search', queryV(SearchQuerySchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const query = c.req.query('q') ?? '';

        const limitRaw = c.req.query('limit');
        const limit = limitRaw === undefined ? undefined : parseInt(limitRaw);

        const result = await searchMessages(storage, projectId, {
            query,
            ...(limit !== undefined && { limit }),
            source: c.req.query('source') ?? undefined,
            user_id: c.req.query('user_id') ?? undefined,
            host: c.req.query('host') ?? undefined,
            project_path: c.req.query('project_path') ?? undefined,
            session_id: c.req.query('session_id') ?? undefined,
            after: c.req.query('after') ?? undefined,
            before: c.req.query('before') ?? undefined,
        });

        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data);
    });

    // -- activity / analytics (must be registered before :id routes) ------------

    // Free analytics, computed on demand from your own database. The commercial
    // tier sells analytics and gates "unlimited analytics" behind Pro — there is
    // nothing to unlock here and no history window that silently truncates.
    //   GET /contexts/stats?bucket=day|week|month&days=30&from=…&to=…&source=…
    hono.get('/contexts/stats', queryV(StatsQuerySchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');

        const bucket = c.req.query('bucket') ?? 'day';
        if (bucket !== 'day' && bucket !== 'week' && bucket !== 'month') {
            return c.json({ error: `Invalid bucket '${bucket}'. Use day, week or month.`, code: 'invalid_input' }, 400);
        }

        const from = c.req.query('from');
        const to = c.req.query('to');
        if (from !== undefined && isNaN(Date.parse(from))) return c.json({ error: 'Invalid from timestamp', code: 'invalid_input' }, 400);
        if (to !== undefined && isNaN(Date.parse(to))) return c.json({ error: 'Invalid to timestamp', code: 'invalid_input' }, 400);

        const daysRaw = c.req.query('days');
        const days = daysRaw === undefined ? undefined : parseInt(daysRaw);
        if (daysRaw !== undefined && (isNaN(days as number) || (days as number) < 1)) {
            return c.json({ error: 'Invalid days value', code: 'invalid_input' }, 400);
        }

        const result = await getProjectActivity(storage, projectId, {
            bucket,
            ...(from !== undefined && { from }),
            ...(to !== undefined && { to }),
            ...(days !== undefined && { days }),
            source: c.req.query('source') ?? undefined,
        });

        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data);
    });

    // -- delete-many contexts (must be registered before :id routes) -----------

    // delete-many — parse body (must be JSON object), call core, compute status
    hono.post('/contexts/delete-many', jsonV(DeleteManySchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = await c.req.json().catch(() => null);

        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object', code: 'invalid_input' }, 400);

        const { ids } = body;
        const result = await deleteManyContexts(storage, projectId, ids as string[]);
        if (!result.ok) return errorResponse(c, result);

        // 207 Multi-Status when partial failure; 500 if every item failed —
        // unless EVERY failure was a transient SSI conflict, in which case the
        // whole batch is retryable verbatim: 409 + Retry-After (API-003).
        const { results, deleted_count } = result.data;
        const total = results.length;
        let httpStatus: ContentfulStatusCode;
        if (deleted_count === 0) {
            httpStatus = results.every((r) => r.retryable === true) ? 409 : 500;
        } else if (deleted_count === total) {
            httpStatus = 200;
        } else {
            httpStatus = 207;
        }
        if (httpStatus === 409) c.header('Retry-After', String(RETRY_AFTER_SECONDS));
        return c.json(result.data, httpStatus);
    });

    // -- parameterized :id routes ------------------------------------------------

    // append messages — zod-gated body, call core, map Result
    hono.post('/contexts/:id', jsonBodyLimit, jsonV(AppendInputSchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');
        const body = (await c.req.json()) as object | object[];

        const result = await appendMessages(storage, projectId, contextPublicId, body);
        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data, 201);
    });

    // get context — zod-gated query selectors, call core, map Result
    hono.get('/contexts/:id', queryV(GetContextQuerySchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        const opts = {
            version: c.req.query('version'),
            at: c.req.query('at'),
            before: c.req.query('before'),
            history: c.req.query('history') === 'true',
        };

        // Pagination (API-010): `limit`/`offset` are opt-in. Without them the
        // response is byte-identical to the pre-pagination shape, so existing
        // clients (SDKs, MCP "full conversation") are never silently
        // truncated. When present: limit is clamped into [1, 1000] and the
        // response gains `total` + the applied `limit`/`offset` so callers
        // can walk a large context page by page.
        const rawLimit = c.req.query('limit');
        const rawOffset = c.req.query('offset');
        const paginating = rawLimit !== undefined || rawOffset !== undefined;
        let limit: number | undefined;
        let offset = 0;
        if (paginating) {
            if (rawLimit !== undefined) {
                const parsed = parseLimit(rawLimit, 1, MAX_MESSAGES_PER_PAGE);
                if (parsed === null) {
                    return c.json({ error: 'limit must be a positive integer', code: 'invalid_input' }, 400);
                }
                limit = parsed;
            }
            if (rawOffset !== undefined) offset = Number(rawOffset); // zod: digit-only
        }

        const result = await getContext(storage, projectId, contextPublicId, opts);
        if (!result.ok) return errorResponse(c, result);

        if (!paginating) return c.json(result.data);
        const { data, ...rest } = result.data;
        return c.json({
            data: limit !== undefined ? data.slice(offset, offset + limit) : data.slice(offset),
            ...rest,
            total: data.length,
            ...(limit !== undefined && { limit }),
            offset,
        });
    });

    // update messages — zod-gated body, call core, map Result
    hono.patch('/contexts/:id', jsonBodyLimit, jsonV(UpdateBodySchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        // bad JSON → 400, but a body-limit error must propagate: the
        // jsonBodyLimit middleware converts it into the 413 after next().
        let body: unknown;
        try {
            body = await c.req.json();
        } catch (error) {
            if (error instanceof Error && error.name === 'BodyLimitError') throw error;
            return c.json({ error: 'Invalid JSON body', code: 'invalid_input' }, 400);
        }
        if (body === null || body === undefined) return c.json({ error: 'Invalid JSON body', code: 'invalid_input' }, 400);

        const result = await updateMessages(storage, projectId, contextPublicId, body as object);
        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data);
    });

    // -- delete context or messages -----------------------------------------------

    // delete — zod-gates the body shape, then disambiguates permanent-delete
    // vs message-delete (the ambiguous permanent+ids 400 and the legacy
    // empty-{} tolerance stay in the handler)
    hono.delete('/contexts/:id', optionalJsonV(DeleteInputSchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const contextPublicId = c.req.param('id');

        // Check Content-Type to distinguish "no body" from "JSON body"
        const contentType = c.req.header('content-type') ?? '';
        const hasJsonBody = contentType.includes('application/json');

        let body: any = null;
        if (hasJsonBody) {
            try {
                body = await c.req.json();
            } catch {
                return c.json({ error: 'Invalid JSON body', code: 'invalid_input' }, 400);
            }
        }

        // Permanent delete path: no body, OR explicit {permanent: true}. Any other body shape must opt
        // in explicitly to prevent typos (e.g. `{IDs:[...]}`, `{id:"x"}`) from silently wiping the context.
        const isEmptyBody = isPlainObject(body) && Object.keys(body).length === 0;
        const isExplicitPermanent = isPlainObject(body) && body.permanent === true;
        const hasIds = isPlainObject(body) && body.ids !== undefined;

        // Reject ambiguous bodies that combine both — forces the caller to pick one
        if (isExplicitPermanent && hasIds) {
            return c.json({ error: 'Cannot combine "permanent" and "ids" in the same request — pick one', code: 'invalid_input' }, 400);
        }

        // permanent delete — no body / {} / {permanent: true}; echo optional audit metadata
        if (!hasJsonBody || isEmptyBody || isExplicitPermanent) {
            const auditMetadata = isPlainObject(body) && isPlainObject(body.metadata) ? body.metadata : undefined;

            // Durable audit record BEFORE the irreversible wipe (API-011).
            // Fail closed: if the record cannot be persisted, the delete does
            // not happen — an unwitnessed wipe is worse than a failed delete.
            try {
                await c.get('auditSink').record({
                    ts: new Date().toISOString(),
                    event: 'permanent_delete',
                    request_id: c.get('requestId'),
                    project_id: projectId,
                    context_id: contextPublicId,
                    ...(auditMetadata !== undefined && { metadata: auditMetadata }),
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                console.error(`permanent delete aborted for ${contextPublicId}: audit record failed: ${message}`);
                return c.json(
                    { error: `Failed to write the durable audit record — nothing was deleted (${message})`, code: 'internal' },
                    500
                );
            }

            // Operational log (the durable record above is the source of truth)
            if (auditMetadata) {
                console.info(JSON.stringify({ op: 'permanent_delete', request_id: c.get('requestId'), project_id: projectId, context_id: contextPublicId, metadata: auditMetadata }));
            }

            const result = await deleteContextPermanent(storage, projectId, contextPublicId, { auditMetadata });
            if (!result.ok) return errorResponse(c, result);
            return c.json(result.data);
        }

        // From here, body must have `ids` for message-delete path
        if (!isPlainObject(body)) return c.json({ error: 'Request body must be a JSON object', code: 'invalid_input' }, 400);
        if (!hasIds) {
            return c.json({ error: 'Body must contain "ids" (delete messages) or {"permanent": true} (delete entire context)', code: 'invalid_input' }, 400);
        }

        // message delete — pass ids + optional metadata to core (core validates shapes)
        const { ids, metadata: userMetadata } = body;
        const result = await deleteMessages(storage, projectId, contextPublicId, {
            ids: ids as (string | number)[],
            userMetadata: userMetadata as Record<string, unknown> | undefined,
        });
        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data);
    });

    // -- named branches (ARCH-001) ----------------------------------------------
    //
    // A branch name pins a stable, human-chosen handle to an immutable version
    // id. Positional `?version=N` addressing still works everywhere as a
    // deprecated alias — these routes ADD an addressing mode, they do not
    // change an existing one. Deeper paths than /contexts/:id, so registration
    // order against the :id routes is irrelevant (unlike /contexts/search).

    // list branches — an empty list is a valid answer (branches are opt-in)
    hono.get('/contexts/:id/branches', async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');

        const result = await listBranches(storage, projectId, c.req.param('id'));
        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data);
    });

    // create or MOVE a branch — PUT with git `branch -f` semantics: re-pinning
    // an existing name preserves created_at and bumps updated_at, so the call is
    // idempotent in effect and safe to retry. 200 (not 201) because the response
    // is the branch's current state whether it was created or moved.
    hono.put('/contexts/:id/branches', jsonBodyLimit, jsonV(CreateBranchSchema), async (c: HttpContext) => {
        const { projectId } = c.get('auth');
        const storage = c.get('storage');
        const body = (await c.req.json()) as CreateBranchBody;

        const result = await createBranch(storage, projectId, c.req.param('id'), body);
        if (!result.ok) return errorResponse(c, result);
        return c.json(result.data, 200);
    });

    // delete a branch — removes the POINTER only. Version data is never touched:
    // unpinning a name must not be able to destroy history.
    hono.delete(
        '/contexts/:id/branches/:name',
        paramV(BranchNameParamSchema),
        async (c: HttpContext) => {
            const { projectId } = c.get('auth');
            const storage = c.get('storage');

            const result = await deleteBranch(storage, projectId, c.req.param('id'), c.req.param('name'));
            if (!result.ok) return errorResponse(c, result);
            return c.json(result.data, 200);
        }
    );
}
