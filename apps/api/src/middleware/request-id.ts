import type { HttpApp, HttpMiddleware } from '../types/http';

// =============================================================================
// REQUEST ID + ACCESS LOG (API-008)
// =============================================================================
// Every request carries a request_id: honoured from an upstream X-Request-Id
// (sanitized) or generated (UUIDv4). The id is stored in the request context
// (for structured event logs deeper in the stack) and echoed back in the
// X-Request-Id response header so callers can correlate support reports.
//
// The access log emits ONE JSON line per request to stdout:
//   { level, event:'request', request_id, method, path, status, duration_ms,
//     project_id? }
// — parseable by any log shipper, correlatable by request_id, and free of
// request/response bodies (privacy + size).

// Sanitize an upstream-supplied X-Request-Id: non-empty, ≤128 chars, printable
// ASCII only — keeps the id safe to embed in log lines and headers.
function sanitizeUpstream(upstream: string | undefined): string | null {
    if (!upstream) return null;
    const value = upstream.trim();
    if (value.length === 0 || value.length > 128) return null;
    if (!/^[!-~]+$/.test(value)) return null;
    return value;
}

export function requestIdMiddleware(): HttpMiddleware {
    return async (c, next) => {
        const id = sanitizeUpstream(c.req.header('x-request-id')) ?? crypto.randomUUID();
        c.set('requestId', id);
        c.header('X-Request-Id', id);
        await next();
    };
}

export function accessLogMiddleware(): HttpMiddleware {
    return async (c, next) => {
        const started = performance.now();
        try {
            await next();
        } finally {
            // finally: the line is emitted even when a handler throws and the
            // error handler turns it into a 500
            const auth = c.get('auth') as { projectId?: number } | undefined;
            const entry: Record<string, unknown> = {
                level: 'info',
                event: 'request',
                request_id: c.get('requestId'),
                method: c.req.method,
                path: c.req.path,
                status: c.res.status,
                duration_ms: Math.round((performance.now() - started) * 1000) / 1000,
            };
            if (auth?.projectId !== undefined) entry.project_id = auth.projectId;
            console.log(JSON.stringify(entry));
        }
    };
}

// register request-id first, access-log second (the log reads the id)
export function registerRequestObservability(app: HttpApp) {
    app.use('*', requestIdMiddleware());
    app.use('*', accessLogMiddleware());
}
