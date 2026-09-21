// =============================================================================
// CHAIN HEALTH — the observable behind a broken prev_id chain (ARCH-002)
// =============================================================================
//
// Message order inside a version is a linked list: each node points at its
// predecessor through `prev_id`. When a walk of that list reaches fewer nodes
// than were handed to it, the chain is damaged (a crashed legacy write, a
// hand-edited database, a partially restored export) and ordering has to fall
// back to something else.
//
// Before ARCH-002 that fallback was invisible: one `console.error` line and a
// `created_at` sort. ISO-millisecond stamps collide routinely — a batch append
// writes several nodes inside the same millisecond — so the fallback order was
// not even stable between reads of the same data. Two fixes, both here:
//
//   1. The fallback order is now TOTAL: persisted `ordinal` first, then
//      `created_at`, then `public_id`. Same rows, same order, every time
//      (see orderNodes in ./context-chain.ts).
//
//   2. The fallback is now MEASURED. This module keeps in-process counters and
//      a subscribe hook, so an operator can alert on it.
//
// Why in-process counters and not a metrics backend: UltraContext is
// self-hosted and local-first with no network dependency in core and no
// telemetry, ever. Nothing here phones home. The counters live in the process
// that read the chain, are exposed read-only on `GET /health` for a monitor to
// scrape, and reset with the process — they are a "has this happened since
// start" signal, not a durable time series. Wire them into your own Prometheus
// exporter or log shipper if you want history; the hook below is the seam.

/** What went wrong. Only one kind exists today; the field keeps log/metric
 *  consumers forward-compatible when more are added. */
export type ChainHealthKind = 'broken_chain';

export type ChainFallbackEvent = {
    kind: ChainHealthKind;
    /**
     * The context (root id) or version head the read was for, when the caller
     * knows it. Null for a bare `orderNodes` call with no context in scope.
     */
    context_id: string | null;
    /** Nodes handed to the ordering pass. */
    expected: number;
    /** Nodes the prev_id walk actually reached. */
    reached: number;
    /** ISO 8601, stamped when the fallback happened. */
    at: string;
};

export type ChainHealthSnapshot = {
    /** How many ordering passes fell back since process start. */
    fallbacks: number;
    /** Nodes lost to broken chains in total (expected - reached, summed). */
    nodes_lost: number;
    /** Distinct contexts that had at least one fallback. */
    contexts_affected: number;
    /** ISO 8601 of the most recent fallback, or null if none. */
    last_fallback_at: string | null;
    /** Context of the most recent fallback, or null. */
    last_context_id: string | null;
};

export type ChainHealthListener = (event: ChainFallbackEvent) => void;

const listeners = new Set<ChainHealthListener>();
const affectedContexts = new Set<string>();

let fallbacks = 0;
let nodesLost = 0;
let lastFallbackAt: string | null = null;
let lastContextId: string | null = null;

/**
 * Record one fallback. Called by `orderNodes` the moment a prev_id walk comes
 * up short — it bumps the counters, notifies listeners, and writes a single
 * structured line to stderr so log-based alerting works with no wiring.
 *
 * Listener exceptions are contained: an observability hook must never be able
 * to fail the read it is observing.
 */
export function recordChainFallback(event: Omit<ChainFallbackEvent, 'at'> & { at?: string }): ChainFallbackEvent {
    const recorded: ChainFallbackEvent = { ...event, at: event.at ?? new Date().toISOString() };

    fallbacks += 1;
    nodesLost += Math.max(0, recorded.expected - recorded.reached);
    if (recorded.context_id) {
        affectedContexts.add(recorded.context_id);
        lastContextId = recorded.context_id;
    }
    lastFallbackAt = recorded.at;

    // One line, greppable prefix, machine-readable tail. This replaces the old
    // "logging only to console.error" behaviour rather than adding to it.
    console.error(
        `[ultracontext:chain-health] broken prev_id chain — expected ${recorded.expected} nodes, reached ${recorded.reached}; ` +
            `order fell back to (ordinal, created_at, public_id). ${JSON.stringify(recorded)}`,
    );

    for (const listener of listeners) {
        try {
            listener(recorded);
        } catch {
            // never let an observer break the read path
        }
    }

    return recorded;
}

/**
 * Subscribe to fallback events. Returns an unsubscribe function. Use this to
 * bridge into your own metrics system — the counters here are per-process and
 * deliberately not exported anywhere else.
 */
export function onChainFallback(listener: ChainHealthListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Current counters, safe to serialise straight into a health response. */
export function chainHealth(): ChainHealthSnapshot {
    return {
        fallbacks,
        nodes_lost: nodesLost,
        contexts_affected: affectedContexts.size,
        last_fallback_at: lastFallbackAt,
        last_context_id: lastContextId,
    };
}

/** Zero the counters and drop listeners. Tests and a long-lived process that
 *  wants a fresh window; not called by any request path. */
export function resetChainHealth(): void {
    fallbacks = 0;
    nodesLost = 0;
    affectedContexts.clear();
    lastFallbackAt = null;
    lastContextId = null;
    listeners.clear();
}
