import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isRetryableTxError } from './tx-errors';

// =============================================================================
// isRetryableTxError — retryable (conflict) vs non-retryable tx failures (API-003)
// =============================================================================

// a pg-style driver error (node-postgres / libsql both carry `code`)
function pgError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

// drizzle wraps driver errors: err.message is the "Failed query: …" shell,
// the real driver error lives on err.cause (pitfall catalog #6)
function drizzleWrapped(cause: unknown): Error {
    return Object.assign(new Error('Failed query: INSERT INTO nodes (public_id) VALUES ($1)'), { cause });
}

describe('isRetryableTxError', () => {
    it('classifies Postgres SSI serialization failure (SQLSTATE 40001)', () => {
        const e = pgError('40001', 'could not serialize access due to read/write dependencies among transactions');
        assert.equal(isRetryableTxError(e), true);
    });

    it('classifies Postgres deadlock detection (SQLSTATE 40P01) as the same retryable class', () => {
        const e = pgError('40P01', 'deadlock detected');
        assert.equal(isRetryableTxError(e), true);
    });

    it('finds the driver code through a drizzle wrapper (err.cause)', () => {
        const wrapped = drizzleWrapped(pgError('40001', 'could not serialize access'));
        assert.equal(isRetryableTxError(wrapped), true);
    });

    it('finds the driver code several levels down the cause chain', () => {
        const wrapped = Object.assign(new Error('outer'), { cause: drizzleWrapped(pgError('40001', 'x')) });
        assert.equal(isRetryableTxError(wrapped), true);
    });

    it('classifies SQLite SQLITE_BUSY as retryable', () => {
        assert.equal(isRetryableTxError(new Error('SQLITE_BUSY: database is locked')), true);
    });

    it('falls back to the canonical pg 40001 message when the code property is dropped', () => {
        assert.equal(isRetryableTxError(new Error('could not serialize access due to concurrent update')), true);
    });

    it('does not classify a plain error as retryable', () => {
        assert.equal(isRetryableTxError(new Error('boom')), false);
    });

    it('does not classify a UNIQUE violation (23505) as retryable', () => {
        assert.equal(isRetryableTxError(pgError('23505', 'duplicate key value violates unique constraint "nodes_public_id_key"')), false);
    });

    it('does not classify a foreign-key violation (23503) as retryable', () => {
        assert.equal(isRetryableTxError(pgError('23503', 'update or delete on table "nodes" violates foreign key constraint')), false);
    });

    it('does not classify a connection-refused error as retryable', () => {
        assert.equal(isRetryableTxError(new Error('connect ECONNREFUSED 127.0.0.1:5432')), false);
    });

    it('returns false for non-object throws (string, null, undefined)', () => {
        assert.equal(isRetryableTxError('boom'), false);
        assert.equal(isRetryableTxError(null), false);
        assert.equal(isRetryableTxError(undefined), false);
    });

    it('terminates on a circular cause reference', () => {
        const e = new Error('boom') as Error & { cause?: unknown };
        e.cause = e; // malformed driver — must not hang
        assert.equal(isRetryableTxError(e), false);
    });
});
