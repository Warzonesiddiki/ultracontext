// =============================================================================
// MESSAGE VIEW — the response shape of a single message (content + id/index/meta)
// =============================================================================

// content fields are spread alongside the generated id, ordinal index,
// wall-clock creation time, and metadata
export type MessageView = Record<string, unknown> & {
    id: string;
    index: number;
    created_at: string;
    metadata: Record<string, unknown>;
};
