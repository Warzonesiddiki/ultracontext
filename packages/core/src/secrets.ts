// =============================================================================
// SECRETS — constant-time comparison of secret strings
// =============================================================================

import { createHash, timingSafeEqual } from 'node:crypto';

// Compare two secret strings in constant time.
//
// A plain `a === b` short-circuits at the first differing byte, leaking a
// timing signal about where a guess diverged from the real secret (and,
// through string identity, the length). To compare safely:
//
//   1. reduce both sides to a FIXED-SIZE sha256 digest — inputs of different
//      lengths can no longer reveal which one was shorter;
//   2. compare the digests with crypto.timingSafeEqual, which does not
//      short-circuit on mismatch.
//
// Use this for anything secret-shaped: raw admin tokens, and the hashes
// derived from API keys (hashes are secret material too — a prefix guess
// against them should cost the same as a wrong guess).
export function secretsEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a, 'utf8').digest();
    const hb = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(ha, hb);
}
