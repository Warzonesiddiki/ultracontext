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
    buildNodeInsertRecords,
    findTail,
    findHead,
    getOrderedNodes,
    getVersions,
} from './context-chain';
export type { NodeInsertInput, VersionInfo } from './context-chain';

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

export { getContext } from './ops/get-context';
export type { GetContextOptions } from './ops/get-context';

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

export { KEY_PREFIX_LEN, MAX_BATCH_DELETE } from './constants';

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
