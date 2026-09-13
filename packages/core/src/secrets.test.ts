// =============================================================================
// SECRETS — constant-time comparison tests
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { secretsEqual } from './secrets';

test('secretsEqual: identical strings are equal', () => {
    assert.equal(secretsEqual('uc_admin_abc123', 'uc_admin_abc123'), true);
});

test('secretsEqual: a one-character difference fails', () => {
    const secret = 'uc_live_9f8e7d6c5b4a';
    const wrong = 'uc_live_9f8e7d6c5b4Z';
    assert.equal(secretsEqual(secret, wrong), false);
});

test('secretsEqual: different lengths fail without throwing', () => {
    assert.equal(secretsEqual('short', 'shorter'), false);
    assert.equal(secretsEqual('shorter', 'short'), false);
});

test('secretsEqual: empty vs non-empty fails in both orders', () => {
    assert.equal(secretsEqual('', 'x'), false);
    assert.equal(secretsEqual('x', ''), false);
    assert.equal(secretsEqual('', ''), true);
});

test('secretsEqual: works on sha256 hex digests (the API-key case)', async () => {
    const { createHash } = await import('node:crypto');
    const h1 = createHash('sha256').update('key-one').digest('hex');
    const h2 = createHash('sha256').update('key-one').digest('hex');
    const h3 = createHash('sha256').update('key-two').digest('hex');
    assert.equal(secretsEqual(h1, h2), true);
    assert.equal(secretsEqual(h1, h3), false);
});

test('secretsEqual: unicode input does not throw or leak length', () => {
    assert.equal(secretsEqual('tökén', 'tökén'), true);
    assert.equal(secretsEqual('tökén', 'tokén'), false);
    assert.equal(secretsEqual('tökén', 'tök'), false);
});
