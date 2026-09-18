// =============================================================================
// TX ERRORS — classify storage-transaction failures (API-003)
// =============================================================================
//
// A serializable transaction that races with another transaction on the same
// context chain is aborted by the backend rather than corrupting data:
//   - Postgres: SQLSTATE 40001 (serialization_failure) — SSI abort
//   - Postgres: SQLSTATE 40P01 (deadlock_detected) — same "retry the whole op"
//     class of transient failure
//   - SQLite:   SQLITE_BUSY ("database is locked")
//
// None of these are caller error — the operation must be retried verbatim.
// They are surfaced as the `conflict` ErrorCode (HTTP 409 + Retry-After)
// instead of collapsing into a flat 500.
//
// Drivers wrap the real error: drizzle puts the driver's original on
// `err.cause` (err.message is a "Failed query: …" shell), so classification
// walks the `cause` chain.

const RETRYABLE_PG_SQLSTATES = new Set(['40001', '40P01']);
// Canonical pg 40001 message — fallback for drivers that keep the message
// but drop the code property.
const RETRYABLE_MESSAGES = ['SQLITE_BUSY', 'could not serialize access'];

// -- classification ------------------------------------------------------------

export function isRetryableTxError(error: unknown): boolean {
    let current: unknown = error;
    // bounded walk: cause chains are 1-2 deep in practice; the guard makes
    // circular `cause` references (malformed driver) terminate.
    for (let guard = 0; current !== null && typeof current === 'object' && guard < 10; guard++) {
        const e = current as { code?: unknown; message?: unknown; cause?: unknown };
        const code = e.code;
        if (typeof code === 'string' && RETRYABLE_PG_SQLSTATES.has(code)) return true;
        const message = e.message;
        if (typeof message === 'string' && RETRYABLE_MESSAGES.some((m) => message.includes(m))) return true;
        current = e.cause;
    }
    return false;
}
