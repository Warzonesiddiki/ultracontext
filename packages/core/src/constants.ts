// =============================================================================
// CONSTANTS — shared ceilings for the context chain
// =============================================================================

export const KEY_PREFIX_LEN = 12;

export const MAX_BATCH_DELETE = 100;

// -- context size caps (API-004) ------------------------------------------------
//
// Operational ceilings, NOT a metered tier: UltraContext is free and
// self-hosted, these only protect a single deployment from runaway ingestion.
//
// Update/delete are copy-on-write: a version change re-writes the message
// state under a new head (O(n) inserts for an n-message context). The cap
// bounds that worst case — a 10k-message context costs at most 10k row
// inserts per update. The structural fix (patch/delta heads, materialised on
// read) is designed in docs/design/delta-storage.md and tracked as ARCH-004;
// these caps stay as the hard ceiling until (and after) that lands.

/** Maximum messages in a single append batch. */
export const MAX_MESSAGES_PER_APPEND = 1000;

/** Maximum total messages a context may hold. */
export const MAX_MESSAGES_PER_CONTEXT = 10_000;
