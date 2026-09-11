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
};
