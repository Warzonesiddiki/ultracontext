// -- ContextReader — abstract data source for MCP tools -----------------------

export type ContextSummary = {
  id: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type ContextMessage = {
  id: string;
  index: number;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
};

export type ContextSearchHit = {
  context_id: string;
  branch_id: string;
  message_id: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  rank: number;
};

// -- Activity / analytics ------------------------------------------------------
// Free usage analytics computed from your own database. The commercial tier
// charges for analytics and caps history on paid plans; here the answer is a
// GROUP BY over rows you already own, with no sampling and no retention window.

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
  bucket: "day" | "week" | "month";
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

export type ContextReader = {
  search(input: {
    query: string;
    limit?: number;
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
  }): Promise<{ query: string; limit: number; data: ContextSearchHit[] }>;

  listContexts(input: {
    limit?: number;
    source?: string;
    user_id?: string;
    host?: string;
    project_path?: string;
    session_id?: string;
    after?: string;
    before?: string;
  }): Promise<{ data: ContextSummary[] }>;

  getMessages(contextId: string): Promise<{ data: ContextMessage[] } | null>;

  activity(input: {
    bucket?: "day" | "week" | "month";
    from?: string;
    to?: string;
    source?: string;
    days?: number;
  }): Promise<ActivityStats>;
};
