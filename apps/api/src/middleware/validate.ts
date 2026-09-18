// =============================================================================
// VALIDATION MIDDLEWARE — @hono/zod-validator wired to the API error contract
// =============================================================================
// @hono/zod-validator (v0.9) is `zValidator(target, schema, hook)`: the hook
// receives BOTH success and failure ({ success, data, error?, target }) and a
// returned Response short-circuits. Its default failure body is the raw zod
// result, but the UltraContext API contract is { error, code } (see
// http-error.ts), so the hook maps every failed parse to
// 400 { error: <joined issues>, code: 'invalid_input' }.
//
// The json wrappers also pre-check the raw body so the two cases hono's
// validator would otherwise surface as a bare HTTPException(400) { message }
// get the full API contract:
//   - non-empty body with a non-JSON Content-Type → 400 contract
//   - non-empty body that is not valid JSON       → 400 contract
// Hono caches the body after the first read (bodyCache), so the inner
// zValidator's own c.req.json() reuses the same bytes.
//
// `optionalJsonV` tolerates a completely empty body (zero bytes) by passing
// straight through — needed by POST /contexts (empty body == create with {})
// and DELETE /contexts/:id (empty body == permanent delete). Malformed
// (non-empty, unparseable) JSON is still a 400.

import { zValidator } from '@hono/zod-validator';
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { z } from 'zod';
import type { AppEnv } from '../types/http';

/** Read the raw body without swallowing hono's BodyLimitError — the limit
 *  middleware converts that error into the 413 AFTER next() returns, so it
 *  must propagate through our text() read. */
async function readBodyText(c: Context<AppEnv>): Promise<string> {
    try {
        return await c.req.text();
    } catch (error) {
        if (error instanceof Error && error.name === 'BodyLimitError') throw error;
        return '';
    }
}

type AnySchema = z.ZodTypeAny;

type ContractFailure = { success: false; error?: z.ZodError };
type ContractResult = { success: boolean; error?: z.ZodError; data?: unknown };

function formatIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) =>
            issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message
        )
        .join('; ');
}

/** Success/failure hook: failures become 400 in the API error contract. */
function contract400(
    result: ContractResult,
    c: Context
): Response | void {
    if (result.success) return;
    const message = result.error === undefined ? 'Invalid request' : formatIssues(result.error);
    return c.json({ error: message, code: 'invalid_input' }, 400);
}

function looksJson(contentType: string | undefined): boolean {
    const ct = (contentType ?? '').toLowerCase();
    return ct.includes('application/json') || ct.includes('+json');
}

/** Validate `schema` against the request's JSON body. Returns a 400 Response
 *  on any failure, or undefined when the request may continue. */
async function validateJsonBody<T extends AnySchema>(
    schema: T,
    c: Context<AppEnv>
): Promise<Response | undefined> {
    const inner = zValidator('json', schema, contract400) as unknown as RouteMiddleware;
    const text = await readBodyText(c);
    const jsonContentType = looksJson(c.req.header('content-type'));
    if (text.trim() === '') {
        // Zero-length body announced as JSON: hono's validator would throw a
        // bare HTTPException(400) — surface it in the API contract instead.
        if (jsonContentType) {
            return c.json({ error: 'Invalid JSON body', code: 'invalid_input' }, 400);
        }
        return undefined; // no body, no JSON announcement — schema sees {}
    }
    if (!jsonContentType) {
        return c.json({ error: 'Content-Type must be application/json', code: 'invalid_input' }, 400);
    }
    try {
        JSON.parse(text);
    } catch {
        return c.json({ error: 'Invalid JSON body', code: 'invalid_input' }, 400);
    }
    // Defer to the inner validator (reuses Hono's cached body). Its next is a
    // no-op: on success we fall through to the real next() in jsonV/
    // optionalJsonV, on failure the returned Response propagates.
    const response = await inner(c, async () => undefined);
    return response instanceof Response ? response : undefined;
}

// zValidator's MiddlewareHandler carries a generic Env; the routes mount on
// Hono<AppEnv>, so normalize the handler type.
type RouteMiddleware = MiddlewareHandler<AppEnv, string, any>;

/** Required JSON body, validated against `schema`. */
export function jsonV<T extends AnySchema>(schema: T) {
    return async (c: Context<AppEnv>, next: Next) => {
        const early = await validateJsonBody(schema, c);
        if (early !== undefined) return early;
        return next();
    };
}

/** JSON body that may be completely absent — an empty body passes through
 *  untouched (the route decides what "no body" means). */
export function optionalJsonV<T extends AnySchema>(schema: T) {
    return async (c: Context<AppEnv>, next: Next) => {
        const text = await readBodyText(c);
        if (text.trim() === '') return next();
        const early = await validateJsonBody(schema, c);
        if (early !== undefined) return early;
        return next();
    };
}

export function queryV<T extends AnySchema>(schema: T): RouteMiddleware {
    return zValidator('query', schema, contract400) as unknown as RouteMiddleware;
}

export function paramV<T extends AnySchema>(schema: T): RouteMiddleware {
    return zValidator('param', schema, contract400) as unknown as RouteMiddleware;
}
