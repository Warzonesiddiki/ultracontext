// =============================================================================
// chain-health — the observable behind a broken prev_id chain (ARCH-002)
// =============================================================================
// Before ARCH-002 a damaged chain produced one console.error line and a
// created_at sort, and nothing else: no counter, no way to ask "has this ever
// happened here", no seam to wire an alert into. These tests pin the replacement
// — in-process counters, a subscribe hook, and the guarantee that observing a
// read can never break it.
//
// UltraContext has no telemetry and no network dependency in core, so the
// counters are deliberately process-local: they answer "since start", they are
// exposed read-only on GET /health for a monitor to scrape, and they reset with
// the process. Nothing here is ever sent anywhere.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { chainHealth, onChainFallback, recordChainFallback, resetChainHealth, type ChainFallbackEvent } from './chain-health';

const event = (overrides: Partial<Omit<ChainFallbackEvent, 'kind'>> = {}) => ({
    kind: 'broken_chain' as const,
    context_id: 'ctx_root_1',
    expected: 4,
    reached: 2,
    ...overrides,
});

describe('chainHealth — counters', () => {
    beforeEach(() => resetChainHealth());

    it('starts empty and serialisable', () => {
        assert.deepEqual(chainHealth(), {
            fallbacks: 0,
            nodes_lost: 0,
            contexts_affected: 0,
            last_fallback_at: null,
            last_context_id: null,
        });
        // a health response json()s this straight out
        assert.deepEqual(JSON.parse(JSON.stringify(chainHealth())), chainHealth());
    });

    it('counts each fallback and the nodes it lost', () => {
        recordChainFallback(event({ expected: 4, reached: 2 }));
        recordChainFallback(event({ context_id: 'ctx_root_1', expected: 4, reached: 0 }));

        const health = chainHealth();
        assert.equal(health.fallbacks, 2);
        assert.equal(health.nodes_lost, 6, '(4-2) + (4-0)');
        assert.equal(health.contexts_affected, 1, 'the same context twice is one affected context');
    });

    it('counts distinct contexts', () => {
        recordChainFallback(event({ context_id: 'ctx_a' }));
        recordChainFallback(event({ context_id: 'ctx_b' }));
        recordChainFallback(event({ context_id: 'ctx_a' }));

        assert.equal(chainHealth().contexts_affected, 2);
        assert.equal(chainHealth().last_context_id, 'ctx_a');
    });

    it('tracks the most recent event, and stamps it', () => {
        const recorded = recordChainFallback(event({ context_id: 'ctx_first', at: '2026-09-18T00:00:00.000Z' }));
        assert.equal(recorded.at, '2026-09-18T00:00:00.000Z', 'an explicit stamp is kept verbatim');
        assert.equal(chainHealth().last_fallback_at, '2026-09-18T00:00:00.000Z');

        const before = Date.now();
        const auto = recordChainFallback(event({ context_id: 'ctx_second' }));
        assert.ok(auto.at, 'a missing stamp is filled in');
        assert.ok(new Date(auto.at).getTime() >= before);
        assert.equal(chainHealth().last_context_id, 'ctx_second');
    });

    it('handles an event with no context in scope', () => {
        // orderNodes is exported and can be called with no provenance at all
        recordChainFallback(event({ context_id: null, expected: 3, reached: 1 }));

        const health = chainHealth();
        assert.equal(health.fallbacks, 1);
        assert.equal(health.nodes_lost, 2);
        assert.equal(health.contexts_affected, 0, 'an unknown context is not an affected context');
        assert.equal(health.last_context_id, null);
    });

    it('never reports negative nodes_lost', () => {
        // defensive: reached > expected cannot happen, but a counter that goes
        // backwards would be worse than useless in an alert
        recordChainFallback(event({ expected: 1, reached: 5 }));
        assert.equal(chainHealth().nodes_lost, 0);
    });

    it('resets', () => {
        recordChainFallback(event());
        assert.equal(chainHealth().fallbacks, 1);

        resetChainHealth();
        assert.deepEqual(chainHealth(), {
            fallbacks: 0,
            nodes_lost: 0,
            contexts_affected: 0,
            last_fallback_at: null,
            last_context_id: null,
        });
    });
});

describe('onChainFallback — the alerting seam', () => {
    beforeEach(() => resetChainHealth());

    it('delivers every event to every listener', () => {
        const a: ChainFallbackEvent[] = [];
        const b: ChainFallbackEvent[] = [];
        onChainFallback((e) => a.push(e));
        onChainFallback((e) => b.push(e));

        recordChainFallback(event({ context_id: 'ctx_x' }));

        assert.equal(a.length, 1);
        assert.equal(b.length, 1);
        assert.equal(a[0].context_id, 'ctx_x');
    });

    it('returns an unsubscribe that only removes its own listener', () => {
        const kept: ChainFallbackEvent[] = [];
        const dropped: ChainFallbackEvent[] = [];
        onChainFallback((e) => kept.push(e));
        const off = onChainFallback((e) => dropped.push(e));

        off();
        recordChainFallback(event());

        assert.equal(kept.length, 1);
        assert.equal(dropped.length, 0);
    });

    it('contains a listener that throws — observing must not break the read', () => {
        const after: ChainFallbackEvent[] = [];
        onChainFallback(() => {
            throw new Error('prometheus client is down');
        });
        onChainFallback((e) => after.push(e));

        // must not throw, and must still count
        assert.doesNotThrow(() => recordChainFallback(event()));
        assert.equal(chainHealth().fallbacks, 1);
        assert.equal(after.length, 1, 'a broken listener does not silence the others');
    });

    it('resetChainHealth drops listeners too', () => {
        const seen: ChainFallbackEvent[] = [];
        onChainFallback((e) => seen.push(e));

        resetChainHealth();
        recordChainFallback(event());

        assert.equal(seen.length, 0);
        assert.equal(chainHealth().fallbacks, 1, 'counting continues after a reset');
    });
});
