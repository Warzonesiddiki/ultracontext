import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ok, err, resultStatus } from './result';

// =============================================================================
// resultStatus — ErrorCode → HTTP status mapping (API-003 added `conflict`)
// =============================================================================

describe('resultStatus', () => {
    it('maps not_found to 404', () => {
        assert.equal(resultStatus('not_found'), 404);
    });

    it('maps invalid_input to 400', () => {
        assert.equal(resultStatus('invalid_input'), 400);
    });

    it('maps conflict to 409 (retryable failure)', () => {
        assert.equal(resultStatus('conflict'), 409);
    });

    it('maps internal to 500', () => {
        assert.equal(resultStatus('internal'), 500);
    });
});

describe('ok / err constructors', () => {
    it('ok carries the data', () => {
        const r = ok({ a: 1 });
        assert.deepEqual(r, { ok: true, data: { a: 1 } });
    });

    it('err carries the conflict code', () => {
        const r = err('conflict', 'Concurrent write conflict — retry the request');
        assert.equal(r.ok, false);
        if (r.ok) return;
        assert.equal(r.code, 'conflict');
    });
});
