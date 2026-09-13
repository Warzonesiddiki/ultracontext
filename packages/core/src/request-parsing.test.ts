// =============================================================================
// REQUEST-PARSING — strict numeric parsing (API-001 / API-002)
// =============================================================================
// parseInt() silently accepts garbage (parseInt("1abc") === 1). These parsers
// must reject malformed input so callers can 400 instead of silently
// resolving to a real index.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseIndex, parseLimit } from './request-parsing';

describe('parseIndex', () => {
    it('accepts clean integer literals', () => {
        assert.equal(parseIndex('0'), 0);
        assert.equal(parseIndex('12'), 12);
        assert.equal(parseIndex('42'), 42);
        assert.equal(parseIndex('-3'), -3);
    });

    it('accepts integer numbers, rejects fractional', () => {
        assert.equal(parseIndex(5), 5);
        assert.equal(parseIndex(0), 0);
        assert.equal(parseIndex(-1), -1);
        assert.equal(parseIndex(5.5), null);
    });

    it('rejects malformed strings (the parseInt leaks)', () => {
        assert.equal(parseIndex('1abc'), null);
        assert.equal(parseIndex('1.9'), null);
        assert.equal(parseIndex(' 1 '), null, 'whitespace must NOT be trimmed');
        assert.equal(parseIndex('1 2'), null);
        assert.equal(parseIndex(''), null);
        assert.equal(parseIndex('1e2'), null);
        assert.equal(parseIndex('0x10'), null);
    });

    it('rejects null / undefined / non-numeric types', () => {
        assert.equal(parseIndex(null), null);
        assert.equal(parseIndex(undefined), null);
        assert.equal(parseIndex({} as unknown as string), null);
        assert.equal(parseIndex(true as unknown as string), null);
    });
});

describe('parseLimit', () => {
    it('absent → null (caller applies the default)', () => {
        assert.equal(parseLimit(undefined), null);
        assert.equal(parseLimit(null), null);
    });

    it('in-range values pass through', () => {
        assert.equal(parseLimit('20', 1, 100), 20);
        assert.equal(parseLimit('1', 1, 100), 1);
        assert.equal(parseLimit('100', 1, 100), 100);
    });

    it('out-of-range is clamped into [min, max]', () => {
        assert.equal(parseLimit('0', 1, 100), 1);
        assert.equal(parseLimit('1000000', 1, 100), 100);
    });

    it('malformed → null (caller 400s)', () => {
        assert.equal(parseLimit('abc', 1, 100), null);
        assert.equal(parseLimit('', 1, 100), null);
        assert.equal(parseLimit('1.5', 1, 100), null);
        assert.equal(parseLimit(' 5 ', 1, 100), null);
        assert.equal(parseLimit('-5', 1, 100), null);
    });
});
