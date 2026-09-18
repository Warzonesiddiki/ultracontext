// =============================================================================
// HTTP ERROR — single error-response shape for the whole API (API-003)
// =============================================================================

import { resultStatus, type ErrorCode } from '@ultracontext/core';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HttpContext } from './types/http';

// Retry-After policy for retryable failures: SSI conflicts resolve quickly
// (the racing commit already finished), so a short 1s backoff is enough for
// a client to retry the whole operation verbatim.
export const RETRY_AFTER_SECONDS = 1;

type ErrorResult = { ok: false; code: ErrorCode; message: string };

// Every API error is { error: <message>, code: <machine-readable code> }.
// `conflict` (Postgres SSI serialization failure / deadlock / SQLITE_BUSY)
// additionally carries Retry-After so clients can back off and retry.
export function errorResponse(c: HttpContext, result: ErrorResult): Response {
    if (result.code === 'conflict') c.header('Retry-After', String(RETRY_AFTER_SECONDS));
    return c.json({ error: result.message, code: result.code }, resultStatus(result.code) as ContentfulStatusCode);
}
