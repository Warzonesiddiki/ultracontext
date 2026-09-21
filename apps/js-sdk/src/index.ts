export type UltraContextConfig = {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    /** Per-attempt timeout in milliseconds. Defaults to 30000. 0 disables the timeout. */
    timeoutMs?: number;
    /**
     * Max retries for transient failures (SDK-002): 429 for every method,
     * 5xx and network errors only for idempotent methods. Defaults to 3.
     * 0 disables retries.
     */
    maxRetries?: number;
};

/** Transport-level options accepted by every client method. */
export type SignalOptions = {
    /** Abort the in-flight request (and any pending retry backoff) from the caller. */
    signal?: AbortSignal;
};

// -- resilience defaults (SDK-002) --------------------------------------------
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 8_000;
// 429 is safe to retry for EVERY method — the API's rate-limit gate rejects
// the request before any handler runs, so nothing was processed. 5xx is only
// safe for idempotent methods: blindly retrying a POST (append) after a server
// error could double-apply the write if the server actually processed it.
// 409 is deliberately NOT retried — the API's conflict + Retry-After stays
// caller-handled (existing contract).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'PUT', 'DELETE']);

/** Exponential backoff with jitter (half..full of the computed delay). */
export function backoffDelayMs(attempt: number, base: number = BACKOFF_BASE_MS, cap: number = BACKOFF_CAP_MS): number {
    const delay = Math.min(cap, base * 2 ** attempt);
    return Math.floor(delay / 2 + Math.random() * (delay / 2));
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
export function retryAfterMs(header: string | null | undefined): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    return undefined;
}

/**
 * One entry of a context's version history.
 *
 * Address a version by `id` (ARCH-001): it is the version head's public id, it
 * never moves and is never reused, so a stored reference keeps meaning the same
 * thing as the chain grows. `version` is the deprecated positional alias — it is
 * recomputed at read time and shifts when versions are added or removed.
 */
export type Version = {
    version: number;
    /** Immutable version id (ctx_…) — pass it back as `version` to re-read this exact state. */
    id: string;
    created_at: string;
    operation: 'create' | 'append' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

/**
 * A version selector: an immutable version id (`ctx_…`, preferred) or a
 * positional index (deprecated alias). Negative indexes count back from the
 * head, so `-1` is the latest version.
 */
export type VersionSelector = number | string;

export type CreateContextInput = {
    from?: string;
    /** Which source version to fork: an immutable id, or a positional index (deprecated). */
    version?: VersionSelector;
    at?: number;
    before?: string;
    metadata?: Record<string, unknown>;
};

export type CreateContextResponse = {
    id: string;
    metadata: Record<string, unknown>;
    created_at: string;
};

export type AppendMessage = Omit<Record<string, unknown>, 'metadata'> & { metadata?: Record<string, unknown> };
export type AppendInput = AppendMessage | AppendMessage[];

export type AppendResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type GetContextInput = {
    /** Which version to read: an immutable id, or a positional index (deprecated). */
    version?: VersionSelector;
    at?: number;
    before?: string;
    history?: boolean;
    /** pagination (API-010): page size, server-clamped to 1..1000 */
    limit?: number;
    /** pagination (API-010): zero-based start index */
    offset?: number;
    /** transport (SDK-002): abort the request / pending retry from the caller */
    signal?: AbortSignal;
};

export type GetContextResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
    versions?: Version[];
    /** pagination (API-010): present only when limit/offset was requested */
    total?: number;
    /** pagination (API-010): applied page size (when limit was requested) */
    limit?: number;
    /** pagination (API-010): applied start index (when limit/offset was requested) */
    offset?: number;
};

export type ListContextsInput = {
    limit?: number;
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
    /** transport (SDK-002): abort the request / pending retry from the caller */
    signal?: AbortSignal;
};

export type ListContextsResponse = {
    data: Array<{
        id: string;
        metadata: Record<string, unknown>;
        created_at: string;
    }>;
};

export type MutationOptions = {
    metadata?: Record<string, unknown>;
    /** transport (SDK-002): abort the request / pending retry from the caller */
    signal?: AbortSignal;
};

export type UpdateMessageInput =
    | ({ id: string; index?: never } & Record<string, unknown>)
    | ({ index: number; id?: never } & Record<string, unknown>);
export type UpdateInput = UpdateMessageInput | UpdateMessageInput[];

export type UpdateResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type SearchInput = {
    query: string;
    limit?: number;
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
};

export type SearchHit = {
    context_id: string;
    branch_id: string;
    message_id: string;
    content: string;
    metadata: Record<string, unknown>;
    created_at: string;
    rank: number;
};

export type SearchResponse = {
    query: string;
    limit: number;
    data: SearchHit[];
};

// -- activity / analytics -----------------------------------------------------

export type ActivityInput = {
    bucket?: 'day' | 'week' | 'month';
    days?: number;
    from?: string;
    to?: string;
    source?: string;
};

export type ActivityPoint = {
    bucket_start: string;
    nodes: number;
    messages: number;
    contexts: number;
    root_contexts: number;
    first_event_at: string | null;
    last_event_at: string | null;
    sources: string[];
};

export type ActivityStats = {
    bucket: 'day' | 'week' | 'month';
    from: string;
    to: string;
    totals: {
        nodes: number;
        messages: number;
        contexts: number;
        root_contexts: number;
        sources: number;
        active_buckets: number;
    };
    by_source: Array<{
        source: string;
        nodes: number;
        messages: number;
        contexts: number;
        root_contexts: number;
    }>;
    series: ActivityPoint[];
};

export type DeleteInput = (string | number) | (string | number)[];

// Unified delete input — either message ids (soft, versioned) OR {permanent: true} (hard, irreversible)
export type DeletePermanentInput = { permanent: true; metadata?: Record<string, unknown> };

export type DeleteResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
};

export type PermanentDeleteResponse = {
    deleted: boolean;
    id: string;
    metadata?: Record<string, unknown>;
};

export type DeleteManyResult = {
    id: string;
    deleted: boolean;
    error?: string;
};

export type DeleteManyResponse = {
    results: DeleteManyResult[];
    deleted_count: number;
};

// -- named branches (ARCH-001) -------------------------------------------------

/**
 * A named branch: a stable handle pinned to an immutable version id.
 *
 * `version` is the pinned version's positional index at read time and is `-1`
 * when the pinned head is no longer part of the chain (its version node was
 * deleted) — the name and `version_id` survive that, the index cannot.
 */
export type BranchRef = {
    name: string;
    version_id: string;
    version: number;
    created_at: string;
    updated_at: string;
};

export type BranchListResponse = {
    branches: BranchRef[];
};

export type SetBranchInput = {
    /** Branch name: starts alphanumeric, then [A-Za-z0-9._-], no '..', no trailing
     *  '.' or '-', at most 64 characters. */
    name: string;
    /** Version to pin — an immutable id or a positional index. Omit for the current head. */
    version?: VersionSelector;
};

export type DeleteBranchResponse = {
    deleted: boolean;
    name: string;
};

export class UltraContextHttpError extends Error {
    readonly status: number;
    readonly url: string;
    readonly bodyText?: string;

    constructor(args: { status: number; url: string; bodyText?: string }) {
        super(`UltraContext request failed: ${args.status} ${args.url}`);
        this.name = 'UltraContextHttpError';
        this.status = args.status;
        this.url = args.url;
        this.bodyText = args.bodyText;
    }
}

export class UltraContext {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly fetchFn: typeof fetch;
    private readonly headers?: Record<string, string>;
    private readonly timeoutMs: number;
    private readonly maxRetries: number;

    constructor(cfg: UltraContextConfig) {
        this.baseUrl = (cfg.baseUrl ?? 'https://api.ultracontext.ai').replace(/\/+$/, '');
        this.apiKey = cfg.apiKey;
        this.fetchFn = cfg.fetch ?? fetch;
        this.headers = cfg.headers;
        this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxRetries = Math.max(0, cfg.maxRetries ?? DEFAULT_MAX_RETRIES);
    }

    async create(input: CreateContextInput = {}, options?: SignalOptions): Promise<CreateContextResponse> {
        return this.request<CreateContextResponse>('/contexts', {
            method: 'POST',
            body: input,
            signal: options?.signal,
        });
    }

    async append<T = unknown>(contextId: string, input: AppendInput, options?: SignalOptions): Promise<AppendResponse<T>> {
        return this.request<AppendResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'POST',
            body: input,
            signal: options?.signal,
        });
    }

    async get(options?: ListContextsInput): Promise<ListContextsResponse>;
    async get<T = unknown>(id: string, options?: GetContextInput): Promise<GetContextResponse<T>>;
    async get<T = unknown>(
        idOrOptions?: string | ListContextsInput,
        options?: GetContextInput
    ): Promise<GetContextResponse<T> | ListContextsResponse> {
        if (!idOrOptions || typeof idOrOptions === 'object') {
            const params = new URLSearchParams();
            if (typeof idOrOptions === 'object') {
                if (idOrOptions.limit) params.set('limit', String(idOrOptions.limit));
                if (idOrOptions.source) params.set('source', idOrOptions.source);
                if (idOrOptions.user_id) params.set('user_id', idOrOptions.user_id);
                if (idOrOptions.host) params.set('host', idOrOptions.host);
                if (idOrOptions.project_path) params.set('project_path', idOrOptions.project_path);
                if (idOrOptions.session_id) params.set('session_id', idOrOptions.session_id);
                if (idOrOptions.after) params.set('after', idOrOptions.after);
                if (idOrOptions.before) params.set('before', idOrOptions.before);
            }
            const query = params.toString();
            return this.request<ListContextsResponse>(`/contexts${query ? `?${query}` : ''}`, {
                method: 'GET',
                signal: typeof idOrOptions === 'object' ? idOrOptions.signal : undefined,
            });
        }

        const params = new URLSearchParams();
        if (options?.version !== undefined) params.set('version', String(options.version));
        if (options?.at !== undefined) params.set('at', String(options.at));
        if (options?.before) params.set('before', options.before);
        if (options?.history) params.set('history', 'true');
        if (options?.limit !== undefined) params.set('limit', String(options.limit));
        if (options?.offset !== undefined) params.set('offset', String(options.offset));
        const query = params.toString();
        return this.request<GetContextResponse<T>>(`/contexts/${encodeURIComponent(idOrOptions)}${query ? `?${query}` : ''}`, {
            method: 'GET',
            signal: options?.signal,
        });
    }

    async update<T = unknown>(contextId: string, input: UpdateInput, options?: MutationOptions): Promise<UpdateResponse<T>> {
        const body = options?.metadata
            ? { updates: Array.isArray(input) ? input : [input], metadata: options.metadata }
            : input;

        return this.request<UpdateResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'PATCH',
            body,
            signal: options?.signal,
        });
    }

    async delete<T = unknown>(contextId: string, ids: DeleteInput, options?: MutationOptions): Promise<DeleteResponse<T>>;
    async delete(contextId: string, input: DeletePermanentInput): Promise<PermanentDeleteResponse>;
    async delete<T = unknown>(
        contextId: string,
        input: DeleteInput | DeletePermanentInput,
        options?: MutationOptions,
    ): Promise<DeleteResponse<T> | PermanentDeleteResponse> {
        const isPermanent =
            typeof input === 'object' &&
            !Array.isArray(input) &&
            input !== null &&
            (input as DeletePermanentInput).permanent === true;

        if (isPermanent) {
            const meta = (input as DeletePermanentInput).metadata;
            return this.request<PermanentDeleteResponse>(`/contexts/${encodeURIComponent(contextId)}`, {
                method: 'DELETE',
                body: meta ? { permanent: true, metadata: meta } : { permanent: true },
                signal: options?.signal,
            });
        }

        return this.request<DeleteResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'DELETE',
            body: { ids: input as DeleteInput, metadata: options?.metadata },
            signal: options?.signal,
        });
    }

    // Full-text search across all captured context. Free and unmetered —
    // there is no query quota and no paywall.
    async search(input: SearchInput, options?: SignalOptions): Promise<SearchResponse> {
        const params = new URLSearchParams();
        params.set('q', input.query);
        if (input.limit !== undefined) params.set('limit', String(input.limit));
        if (input.source) params.set('source', input.source);
        if (input.user_id) params.set('user_id', input.user_id);
        if (input.host) params.set('host', input.host);
        if (input.project_path) params.set('project_path', input.project_path);
        if (input.session_id) params.set('session_id', input.session_id);
        if (input.after) params.set('after', input.after);
        if (input.before) params.set('before', input.before);

        return this.request<SearchResponse>(`/contexts/search?${params.toString()}`, { method: 'GET', signal: options?.signal });
    }

    // Usage analytics — free, unmetered, computed from your own database.
    // The commercial tier charges for analytics and caps history on paid plans;
    // nothing here is gated and no retention window truncates your history.
    async stats(input: ActivityInput = {}, options?: SignalOptions): Promise<ActivityStats> {
        const params = new URLSearchParams();
        if (input.bucket) params.set('bucket', input.bucket);
        if (input.days !== undefined) params.set('days', String(input.days));
        if (input.from) params.set('from', input.from);
        if (input.to) params.set('to', input.to);
        if (input.source) params.set('source', input.source);

        const query = params.toString();
        return this.request<ActivityStats>(`/contexts/stats${query ? `?${query}` : ''}`, { method: 'GET', signal: options?.signal });
    }

    // -- named branches (ARCH-001) ---------------------------------------------

    /**
     * List the named branches on a context (name-ascending). Branches are
     * opt-in, so a context with none returns `{ branches: [] }`.
     */
    async branches(contextId: string, options?: SignalOptions): Promise<BranchListResponse> {
        return this.request<BranchListResponse>(`/contexts/${encodeURIComponent(contextId)}/branches`, {
            method: 'GET',
            signal: options?.signal,
        });
    }

    /**
     * Create a branch, or move an existing one — git `branch -f` semantics.
     * PUT is idempotent, so the SDK's retry layer can safely re-send it after a
     * transient failure. Re-pinning preserves `created_at` and bumps `updated_at`.
     */
    async setBranch(contextId: string, input: SetBranchInput, options?: SignalOptions): Promise<BranchRef> {
        return this.request<BranchRef>(`/contexts/${encodeURIComponent(contextId)}/branches`, {
            method: 'PUT',
            body: input,
            signal: options?.signal,
        });
    }

    /**
     * Remove a branch name. Deletes the POINTER only — the version it pointed at
     * stays readable by its id, because unpinning a name must never destroy
     * history.
     */
    async deleteBranch(contextId: string, name: string, options?: SignalOptions): Promise<DeleteBranchResponse> {
        return this.request<DeleteBranchResponse>(
            `/contexts/${encodeURIComponent(contextId)}/branches/${encodeURIComponent(name)}`,
            { method: 'DELETE', signal: options?.signal },
        );
    }

    async deleteMany(ids: string[], options?: SignalOptions): Promise<DeleteManyResponse> {
        // 200 (all ok), 207 (partial), 409 (every item failed with a retryable
        // serialization conflict — Retry-After header), 500 (all failed) all
        // carry a results body — surface directly, never throw for these.
        return this.request<DeleteManyResponse>('/contexts/delete-many', {
            method: 'POST',
            body: { ids },
            acceptStatuses: [200, 207, 409, 500],
            signal: options?.signal,
        });
    }

    private shouldRetry(method: string, status: number, acceptStatuses: number[] | undefined, attempt: number, maxRetries: number): boolean {
        if (attempt >= maxRetries) return false;
        if (!RETRYABLE_STATUS.has(status)) return false;
        if (acceptStatuses?.includes(status)) return false; // caller handles this status itself
        if (status === 429) return true; // gate rejected the request — nothing was processed
        return IDEMPOTENT_METHODS.has(method.toUpperCase());
    }

    private async retryAfterFrom429Body(res: Response): Promise<number | undefined> {
        // The API's 429 rate-limit carries retry_after_sec in the JSON body
        // (the header is not guaranteed there) — used when the header is absent.
        try {
            const body: unknown = JSON.parse(await res.text());
            const sec = (body as { retry_after_sec?: unknown })?.retry_after_sec;
            if (typeof sec === 'number' && sec >= 0) return sec * 1000;
        } catch {
            // non-JSON 429 body — fall back to the backoff curve
        }
        return undefined;
    }

    private sleep(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                reject(abortError(signal.reason));
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                reject(abortError(signal!.reason));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    private async request<T>(path: string, init: { method: string; body?: unknown; headers?: Record<string, string>; acceptStatuses?: number[]; signal?: AbortSignal }): Promise<T> {
        const url = `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            ...(this.headers ?? {}),
            ...(init.headers ?? {}),
        };

        let body: BodyInit | undefined;
        if (init.body !== undefined) {
            headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
            body = JSON.stringify(init.body);
        }

        const method = init.method.toUpperCase();
        // A lost or errored non-idempotent request may have been processed
        // server-side — transport failures are only retried for these methods.
        const canRetryTransport = IDEMPOTENT_METHODS.has(method);
        const { maxRetries } = this;
        let attempt = 0;

        for (;;) {
            // check before allocating anything — a throw here must not leak
            // the per-attempt timeout timer below
            if (init.signal?.aborted) throw abortError(init.signal.reason);

            // SDK-002: per-attempt timeout + caller AbortSignal passthrough,
            // combined into one AbortController for this attempt.
            const ac = new AbortController();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            if (this.timeoutMs > 0) {
                timeout = setTimeout(
                    () => ac.abort(new DOMException(`Request timed out after ${this.timeoutMs}ms`, 'TimeoutError')),
                    this.timeoutMs,
                );
            }
            let onUserAbort: (() => void) | undefined;
            if (init.signal) {
                onUserAbort = () => ac.abort(init.signal?.reason);
                init.signal.addEventListener('abort', onUserAbort, { once: true });
            }

            try {
                let res: Response;
                try {
                    res = await this.fetchFn(url, {
                        method: init.method,
                        headers,
                        body,
                        signal: ac.signal,
                    });
                } catch (err) {
                    // caller aborted → propagate, never retry
                    if (init.signal?.aborted) throw err;
                    // network failure or per-attempt timeout
                    if (canRetryTransport && attempt < maxRetries) {
                        await this.sleep(backoffDelayMs(attempt), init.signal);
                        attempt += 1;
                        continue;
                    }
                    throw err;
                }

                const retryable = this.shouldRetry(method, res.status, init.acceptStatuses, attempt, maxRetries);
                if (retryable) {
                    // the server's Retry-After wins over the backoff curve
                    let delay = retryAfterMs(res.headers.get('retry-after'));
                    if (delay === undefined && res.status === 429) delay = await this.retryAfterFrom429Body(res);
                    if (delay === undefined) delay = backoffDelayMs(attempt);
                    await this.sleep(delay, init.signal);
                    attempt += 1;
                    continue;
                }

                const accepted = init.acceptStatuses?.includes(res.status) ?? false;
                if (!res.ok && !accepted) {
                    const bodyText = await safeReadText(res);
                    throw new UltraContextHttpError({ status: res.status, url, bodyText });
                }

                if (res.status === 204) return undefined as unknown as T;

                const contentType = res.headers.get('content-type') ?? '';
                if (contentType.includes('application/json')) return (await res.json()) as T;
                return (await res.text()) as unknown as T;
            } finally {
                if (timeout) clearTimeout(timeout);
                if (init.signal && onUserAbort) init.signal.removeEventListener('abort', onUserAbort);
            }
        }
    }
}

function abortError(reason: unknown): unknown {
    return reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function safeReadText(res: Response) {
    try {
        return await res.text();
    } catch {
        return undefined;
    }
}
