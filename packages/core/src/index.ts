// =============================================================================
// @ultracontext/core — capability engine (HTTP/DB-agnostic)
// =============================================================================

// -- storage types ------------------------------------------------------------

export type {
    StorageAdapter,
    NodeRow,
    NodeInsertRow,
    ApiKeyRow,
    ApiKeyPublic,
    ProjectRow,
    ContextRefRow,
    ContextFilters,
    SearchFilters,
    SearchHit,
    TransactionOptions,
    ActivityBucket,
    ActivityQuery,
    ActivityRow,
} from './storage';

// -- message view -------------------------------------------------------------

export type { MessageView } from './message-view';

// -- context chain helpers ----------------------------------------------------

export {
    orderNodes,
    compareByOrdinalThenTime,
    buildNodeInsertRecords,
    findTail,
    findHead,
    nextOrdinal,
    getOrderedNodes,
    getVersions,
} from './context-chain';
export type { NodeInsertInput, VersionInfo, OrderableNode, OrderNodesMeta } from './context-chain';

// -- chain health (ARCH-002) --------------------------------------------------
// The prev_id chain is the authoritative message order; when a walk of it comes
// up short, ordering falls back and THIS fires. In-process counters + a
// subscribe hook — no telemetry, no network, nothing leaves the machine.
export { recordChainFallback, onChainFallback, chainHealth, resetChainHealth } from './chain-health';
export type { ChainFallbackEvent, ChainHealthKind, ChainHealthListener, ChainHealthSnapshot } from './chain-health';

// -- capability ops -----------------------------------------------------------

export { listContexts } from './ops/list-contexts';
export { getContextMessages } from './ops/get-context-messages';

export { searchMessages, searchableText, snippet } from './ops/search';
export type { SearchInput, SearchResultData } from './ops/search';
export { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, MAX_SEARCH_QUERY_LEN } from './ops/search';

// -- activity / analytics (free, computed from your own data) -----------------
export { getProjectActivity, aggregateActivity, bucketStart } from './ops/analytics';
export type {
    ActivityInput,
    ActivityResultData,
    ActivityPoint,
    ActivityTotals,
    ActivitySourceTotal,
    ActivityAggregateInput,
} from './ops/analytics';
export { DEFAULT_ACTIVITY_DAYS, MAX_ACTIVITY_BUCKETS } from './ops/analytics';

export { createContext } from './ops/create-context';
export type { CreateContextInput } from './ops/create-context';

export { getContext, resolveVersionSelection, classifyVersionSelection } from './ops/get-context';
export type { GetContextOptions, ResolvedVersion, VersionSelection } from './ops/get-context';

// -- named branches (ARCH-001): stable names over immutable version ids --------

export {
    listBranches,
    createBranch,
    deleteBranch,
    isValidBranchName,
    MAX_BRANCH_NAME_LEN,
    BRANCH_NAME_ERROR,
} from './ops/branches';
export type { BranchRef, SetBranchInput } from './ops/branches';

export { appendMessages } from './ops/append-messages';

export { updateMessages } from './ops/update-messages';

export { deleteContextPermanent } from './ops/delete-context';
export type { DeleteContextParams } from './ops/delete-context';

export { deleteMessages } from './ops/delete-messages';
export type { DeleteMessagesParams } from './ops/delete-messages';

export { deleteManyContexts } from './ops/delete-many';
export type { DeleteResult, DeleteManyResult } from './ops/delete-many';

export { repairOrphanedHeads } from './ops/repair-orphaned-heads';
export type { RepairReport } from './ops/repair-orphaned-heads';

export { createKey } from './ops/create-key';

export { verifyKey, verifyKeyHash, hashToken } from './ops/verify-key';
export type { VerifiedKey } from './ops/verify-key';
export { listKeys, revokeKey, rotateKey } from './ops/key-lifecycle';

// -- public ids ---------------------------------------------------------------

export { generatePublicId } from './public-ids';

// -- api keys -----------------------------------------------------------------

export { toBase62, generateKey, hashKey } from './api-keys';
export { secretsEqual } from './secrets';

// -- constants ----------------------------------------------------------------

export { KEY_PREFIX_LEN, MAX_BATCH_DELETE, MAX_MESSAGES_PER_APPEND, MAX_MESSAGES_PER_CONTEXT } from './constants';

// -- request parsing ----------------------------------------------------------

export { isPlainObject, parseUpdateRequestBody, parseIndex, parseLimit } from './request-parsing';
export type { UpdateRequestInput } from './request-parsing';

// -- first row ----------------------------------------------------------------

export { firstRow } from './first-row';

// -- result -------------------------------------------------------------------

export { ok, err, resultStatus } from './result';
export type { ErrorCode, Result } from './result';

// -- transaction failure classification ----------------------------------------

export { isRetryableTxError } from './tx-errors';
