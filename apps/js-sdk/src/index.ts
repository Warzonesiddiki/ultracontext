export type UltraContextConfig = {
    apiKey: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
};

export type Version = {
    version: number;
    created_at: string;
    operation: 'create' | 'append' | 'update' | 'delete';
    affected: string[] | null;
    metadata?: Record<string, unknown>;
};

export type CreateContextInput = {
    from?: string;
    version?: number;
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
    version?: number;
    at?: number;
    before?: string;
    history?: boolean;
};

export type GetContextResponse<T = unknown> = {
    data: Array<{ id: string; index: number; metadata: Record<string, unknown> } & T>;
    version: number;
    versions?: Version[];
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
    private readonly timeoutMs?: number;

    constructor(cfg: UltraContextConfig) {
        this.baseUrl = (cfg.baseUrl ?? 'https://api.ultracontext.ai').replace(/\/+$/, '');
        this.apiKey = cfg.apiKey;
        this.fetchFn = cfg.fetch ?? fetch;
        this.headers = cfg.headers;
        this.timeoutMs = cfg.timeoutMs;
    }

    async create(input: CreateContextInput = {}): Promise<CreateContextResponse> {
        return this.request<CreateContextResponse>('/contexts', {
            method: 'POST',
            body: input,
        });
    }

    async append<T = unknown>(contextId: string, input: AppendInput): Promise<AppendResponse<T>> {
        return this.request<AppendResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'POST',
            body: input,
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
            return this.request<ListContextsResponse>(`/contexts${query ? `?${query}` : ''}`, { method: 'GET' });
        }

        const params = new URLSearchParams();
        if (options?.version !== undefined) params.set('version', String(options.version));
        if (options?.at !== undefined) params.set('at', String(options.at));
        if (options?.before) params.set('before', options.before);
        if (options?.history) params.set('history', 'true');
        const query = params.toString();
        return this.request<GetContextResponse<T>>(`/contexts/${encodeURIComponent(idOrOptions)}${query ? `?${query}` : ''}`, { method: 'GET' });
    }

    async update<T = unknown>(contextId: string, input: UpdateInput, options?: MutationOptions): Promise<UpdateResponse<T>> {
        const body = options?.metadata
            ? { updates: Array.isArray(input) ? input : [input], metadata: options.metadata }
            : input;

        return this.request<UpdateResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'PATCH',
            body,
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
            });
        }

        return this.request<DeleteResponse<T>>(`/contexts/${encodeURIComponent(contextId)}`, {
            method: 'DELETE',
            body: { ids: input as DeleteInput, metadata: options?.metadata },
        });
    }

    // Full-text search across all captured context. Free and unmetered —
    // there is no query quota and no paywall.
    async search(input: SearchInput): Promise<SearchResponse> {
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

        return this.request<SearchResponse>(`/contexts/search?${params.toString()}`, { method: 'GET' });
    }

    // Usage analytics — free, unmetered, computed from your own database.
    // The commercial tier charges for analytics and caps history on paid plans;
    // nothing here is gated and no retention window truncates your history.
    async stats(input: ActivityInput = {}): Promise<ActivityStats> {
        const params = new URLSearchParams();
        if (input.bucket) params.set('bucket', input.bucket);
        if (input.days !== undefined) params.set('days', String(input.days));
        if (input.from) params.set('from', input.from);
        if (input.to) params.set('to', input.to);
        if (input.source) params.set('source', input.source);

        const query = params.toString();
        return this.request<ActivityStats>(`/contexts/stats${query ? `?${query}` : ''}`, { method: 'GET' });
    }

    async deleteMany(ids: string[]): Promise<DeleteManyResponse> {
        // 200 (all ok), 207 (partial), 409 (every item failed with a retryable
        // serialization conflict — Retry-After header), 500 (all failed) all
        // carry a results body — surface directly, never throw for these.
        return this.request<DeleteManyResponse>('/contexts/delete-many', {
            method: 'POST',
            body: { ids },
            acceptStatuses: [200, 207, 409, 500],
        });
    }

    private async request<T>(path: string, init: { method: string; body?: unknown; headers?: Record<string, string>; acceptStatuses?: number[] }): Promise<T> {
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

        const ac = this.timeoutMs ? new AbortController() : undefined;
        const timeout = this.timeoutMs ? setTimeout(() => ac?.abort(), this.timeoutMs) : undefined;

        try {
            const res = await this.fetchFn(url, {
                method: init.method,
                headers,
                body,
                signal: ac?.signal,
            });

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
        }
    }
}

async function safeReadText(res: Response) {
    try {
        return await res.text();
    } catch {
        return undefined;
    }
}
