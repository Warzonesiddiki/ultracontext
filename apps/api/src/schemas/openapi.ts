// =============================================================================
// OPENAPI REGISTRY — single source of truth for the API reference (API-009)
// =============================================================================
// apps/docs/api-reference/openapi.json is GENERATED from this module by
// `pnpm --filter @ultracontext-api openapi:generate` (scripts/generate-openapi
// .mts). Hand-editing the JSON is futile: openapi.test.ts fails when the
// committed file diverges from renderOpenApi(), so docs cannot drift from
// the registry that ships in the app source.
//
// Conventions:
//   - `x-mint.content` → mintContent (Mintlify block markup)
//   - `x-codeSamples`  → codeSamples
//   - response `content: { 'application/json': { schema } }` is written out
//     by the renderer from `jsonSchema`/`schemaRef` helpers below.

type CodeSample = { lang: string; label: string; source: string };
type JsonSchema = Record<string, unknown>;

type OpenApiResponse = {
    description: string;
    jsonSchema?: JsonSchema;
    schemaRef?: string;
    headers?: Record<string, { description: string; schema: JsonSchema }>;
};

type OpenApiParameter = {
    name: string;
    in: 'query' | 'path';
    required?: boolean;
    description?: string;
    schema: JsonSchema;
};

type OpenApiOperation = {
    operationId: string;
    summary: string;
    description?: string;
    mintContent?: string;
    codeSamples?: CodeSample[];
    parameters?: OpenApiParameter[];
    requestBody?: {
        description?: string;
        required?: boolean;
        schemaRef?: string;
        jsonSchema?: JsonSchema;
    };
    responses: Record<string, OpenApiResponse>;
};

type PathEntry = { path: string; operations: Record<string, OpenApiOperation> };

// -- document-level -------------------------------------------------------------

export const openapiInfo = {
    title: 'UltraContext',
    description:
        'Manage conversation contexts with automatic versioning. Every mutation creates a new branch, preserving full history. ' +
        'All API-key-authenticated requests are rate-limited to protect against abuse — a 429 carries a `RateLimitError` body with a `retry_after_sec` field. ' +
        'Every response carries an `X-Request-Id` header for correlation with server logs.',
    version: '1.2.0',
};

export const openapiServers = [{ url: 'https://api.ultracontext.ai' }];

export const openapiSecurity = [{ bearerAuth: [] }];

// -- shared response helpers ------------------------------------------------------

const errorRef = (description: string, extra?: Partial<OpenApiResponse>): OpenApiResponse => ({
    description,
    schemaRef: 'Error',
    ...extra,
});

const conflictHeaders = {
    'Retry-After': {
        description: 'Seconds to wait before retrying the request verbatim',
        schema: { type: 'string' },
    },
};

// -- paths (order = page order in the docs) ----------------------------------------

export const openapiPaths: PathEntry[] = [
    {
        path: '/',
        operations: {
            get: {
                operationId: 'welcome',
                summary: 'Service welcome',
                description:
                    'Unauthenticated service banner. Authenticated routes: /contexts*, /mcp, /v1/keys*.',
                responses: {
                    200: {
                        description: 'Service banner',
                        jsonSchema: {
                            type: 'object',
                            properties: {
                                message: { type: 'string' },
                                reasoning: { type: 'string' },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        path: '/health',
        operations: {
            get: {
                operationId: 'liveness',
                summary: 'Liveness probe',
                description:
                    'Returns 200 while the process is up and serving. Unauthenticated — for load balancers and orchestrators.',
                responses: {
                    200: {
                        description: 'Service is alive',
                        jsonSchema: {
                            type: 'object',
                            properties: {
                                status: { type: 'string', enum: ['ok'] },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        path: '/health/ready',
        operations: {
            get: {
                operationId: 'readiness',
                summary: 'Readiness probe',
                description:
                    'Returns 200 when the storage backend answers a trivial read, 503 when it does not. Unauthenticated — for load balancers and orchestrators.',
                responses: {
                    200: {
                        description: 'Storage backend is reachable',
                        jsonSchema: {
                            type: 'object',
                            properties: {
                                status: { type: 'string', enum: ['ready'] },
                            },
                        },
                    },
                    503: {
                        description: 'Storage backend is unreachable (the process itself is up)',
                        jsonSchema: {
                            type: 'object',
                            properties: {
                                status: { type: 'string', enum: ['not_ready'] },
                                error: {
                                    type: 'string',
                                    description: 'Underlying storage error',
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        path: '/contexts',
        operations: {
            post: {
                operationId: 'createContext',
                summary: 'Create context',
                description:
                    'Create a new context. Optionally copy from an existing context using the `from` parameter, and specify a `version` to fork from a specific version.',
                mintContent:
                    '<Tip>Use `from` with `version`, `at`, or `before` to fork from a specific point in history. Learn more in the [Fork & Clone Contexts](/guides/fork-clone-contexts) guide.</Tip>',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `const ctx = await uc.create()

// With metadata
const ctx = await uc.create({ metadata: { name: 'my-session' } })

// Copy from existing (latest version)
const fork = await uc.create({ from: 'ctx_abc123' })

// Fork from specific version
const v1Fork = await uc.create({ from: 'ctx_abc123', version: 1 })

// Fork at specific message index
const partial = await uc.create({ from: 'ctx_abc123', at: 5 })

// Fork from point-in-time
const snapshot = await uc.create({ from: 'ctx_abc123', before: '2024-01-15T10:30:00Z' })`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `ctx = uc.create()

# With metadata
ctx = uc.create(metadata={'name': 'my-session'})

# Copy from existing (latest version)
fork = uc.create(from_='ctx_abc123')

# Fork from specific version
v1_fork = uc.create(from_='ctx_abc123', version=1)

# Fork at specific message index
partial = uc.create(from_='ctx_abc123', at=5)

# Fork from point-in-time
snapshot = uc.create(from_='ctx_abc123', before='2024-01-15T10:30:00Z')`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl -X POST https://api.ultracontext.ai/contexts \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"metadata": {"name": "my-session"}}'

# Fork from specific version
curl -X POST https://api.ultracontext.ai/contexts \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"from": "ctx_abc123", "version": 1}'

# Fork from point-in-time
curl -X POST https://api.ultracontext.ai/contexts \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"from": "ctx_abc123", "before": "2024-01-15T10:30:00Z"}'`,
                    },
                ],
                requestBody: { schemaRef: 'CreateContextInput' },
                responses: {
                    201: { description: 'Context created', schemaRef: 'Context' },
                    400: errorRef('Invalid index (when using `at` with `from`)'),
                    404: errorRef('Version not found (when using `version` with `from`)'),
                    500: errorRef('Server error'),
                },
            },
            get: {
                operationId: 'listContexts',
                summary: 'List contexts',
                description:
                    'List all root contexts for your project. Sorted by `created_at` descending (newest first).',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `// List all contexts
const { data } = await uc.get()

// With limit
const { data } = await uc.get({ limit: 10 })

// Filter by source
const { data } = await uc.get({ source: 'claude' })

// Filter by project
const { data } = await uc.get({ project_path: '/Users/alice/Code/myapp' })

// Combine filters
const { data } = await uc.get({ source: 'codex', host: 'Mac-mini.local', after: '2026-03-01T00:00:00Z' })`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `# List all contexts
result = uc.get()

# With limit
result = uc.get(limit=10)

# Filter by source
result = uc.get(source='claude')

# Filter by project
result = uc.get(project_path='/Users/alice/Code/myapp')

# Combine filters
result = uc.get(source='codex', host='Mac-mini.local', after='2026-03-01T00:00:00Z')`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl https://api.ultracontext.ai/contexts \\
  -H "Authorization: Bearer $API_KEY"

# With limit
curl "https://api.ultracontext.ai/contexts?limit=10" \\
  -H "Authorization: Bearer $API_KEY"

# Filter by source + project
curl "https://api.ultracontext.ai/contexts?source=claude&project_path=/Users/alice/Code/myapp" \\
  -H "Authorization: Bearer $API_KEY"

# Time range
curl "https://api.ultracontext.ai/contexts?after=2026-03-01T00:00:00Z&before=2026-03-08T00:00:00Z" \\
  -H "Authorization: Bearer $API_KEY"`,
                    },
                ],
                parameters: [
                    {
                        name: 'limit',
                        in: 'query',
                        description: 'Maximum number of contexts to return',
                        schema: { type: 'integer', default: 20 },
                    },
                    {
                        name: 'source',
                        in: 'query',
                        description: 'Filter by agent source (e.g. `claude`, `codex`, `openclaw`)',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'user_id',
                        in: 'query',
                        description: 'Filter by user identifier',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'host',
                        in: 'query',
                        description: 'Filter by machine hostname',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'project_path',
                        in: 'query',
                        description:
                            'Filter by project directory path (e.g. `/Users/alice/Code/myapp`)',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'session_id',
                        in: 'query',
                        description: 'Filter by session identifier',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'after',
                        in: 'query',
                        description: 'Only contexts created after this ISO 8601 timestamp',
                        schema: { type: 'string', format: 'date-time' },
                    },
                    {
                        name: 'before',
                        in: 'query',
                        description: 'Only contexts created before this ISO 8601 timestamp',
                        schema: { type: 'string', format: 'date-time' },
                    },
                ],
                responses: {
                    200: {
                        description: 'List of contexts',
                        jsonSchema: {
                            type: 'object',
                            properties: {
                                data: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/Context' },
                                },
                            },
                        },
                    },
                    400: errorRef('Invalid limit (must be a positive integer)'),
                },
            },
        },
    },
    {
        path: '/mcp',
        operations: {
            post: {
                operationId: 'mcpEndpoint',
                summary: 'MCP endpoint',
                description:
                    'Built-in Model Context Protocol endpoint. Accepts JSON-RPC requests over Streamable HTTP. Exposes `list_contexts`, `get_context_messages`, and `get_recent_activity` tools.',
                mintContent:
                    '<Info>This endpoint speaks [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http). Use any MCP-compatible client to connect.</Info>',
                codeSamples: [
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `# List available tools
curl -X POST https://api.ultracontext.ai/mcp \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'

# Call a tool
curl -X POST https://api.ultracontext.ai/mcp \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"list_contexts","arguments":{"limit":5}},"id":2}'`,
                    },
                ],
                requestBody: {
                    description: 'JSON-RPC 2.0 request (MCP protocol)',
                    jsonSchema: {
                        type: 'object',
                        required: ['jsonrpc', 'method', 'id'],
                        properties: {
                            jsonrpc: { type: 'string', enum: ['2.0'] },
                            method: {
                                type: 'string',
                                description: 'MCP method (e.g. `tools/list`, `tools/call`)',
                            },
                            params: { type: 'object', description: 'Method parameters' },
                            id: {
                                description: 'Request identifier',
                                oneOf: [{ type: 'string' }, { type: 'integer' }],
                            },
                        },
                    },
                },
                responses: {
                    200: {
                        description: 'JSON-RPC 2.0 response',
                        jsonSchema: {
                            type: 'object',
                            properties: {
                                jsonrpc: { type: 'string' },
                                result: { type: 'object' },
                                id: {
                                    description: 'Matching request identifier',
                                    oneOf: [{ type: 'string' }, { type: 'integer' }],
                                },
                            },
                        },
                    },
                    401: errorRef('Unauthorized'),
                },
            },
        },
    },
    {
        path: '/contexts/{id}',
        operations: {
            get: {
                operationId: 'getContext',
                summary: 'Get context',
                description:
                    'Get context with all messages. Returns latest version by default.',
                mintContent: '<Info>The `versions` array is only returned when `?history=true`.</Info>',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `// Get current version
const { data, version } = await uc.get('ctx_abc123')

// With version history
const { data, version, versions } = await uc.get('ctx_abc123', { history: true })

// Get specific version
const { data } = await uc.get('ctx_abc123', { version: 1 })

// Get at specific message index
const { data } = await uc.get('ctx_abc123', { at: 5 })

// Get point-in-time state
const { data } = await uc.get('ctx_abc123', { before: '2024-01-15T10:30:00Z' })`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `# Get current version
result = uc.get('ctx_abc123')

# With version history
result = uc.get('ctx_abc123', history=True)

# Get specific version
result = uc.get('ctx_abc123', version=1)

# Get at specific message index
result = uc.get('ctx_abc123', at=5)

# Get point-in-time state
result = uc.get('ctx_abc123', before='2024-01-15T10:30:00Z')`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `# Get current version
curl https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY"

# With version history
curl "https://api.ultracontext.ai/contexts/ctx_abc123?history=true" \\
  -H "Authorization: Bearer $API_KEY"

# Get specific version
curl "https://api.ultracontext.ai/contexts/ctx_abc123?version=1" \\
  -H "Authorization: Bearer $API_KEY"

# Get point-in-time state
curl "https://api.ultracontext.ai/contexts/ctx_abc123?before=2024-01-15T10:30:00Z" \\
  -H "Authorization: Bearer $API_KEY"`,
                    },
                ],
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        description: 'Context ID (ctx_...)',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'version',
                        in: 'query',
                        description:
                            'Version number to retrieve (0-indexed). Defaults to latest.',
                        schema: { type: 'integer' },
                    },
                    {
                        name: 'at',
                        in: 'query',
                        description:
                            'Return messages 0 through this index (point-in-time retrieval)',
                        schema: { type: 'integer' },
                    },
                    {
                        name: 'before',
                        in: 'query',
                        description:
                            'ISO timestamp. Returns point-in-time state: finds version created before timestamp, then filters messages by created_at.',
                        schema: { type: 'string', format: 'date-time' },
                    },
                    {
                        name: 'history',
                        in: 'query',
                        description: 'Include version history in response',
                        schema: { type: 'boolean' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Context messages with version info',
                        schemaRef: 'GetContextResponse',
                    },
                    400: errorRef('Invalid index (when using ?at=)'),
                    404: errorRef(
                        'Context not found, version not found, or index out of range'
                    ),
                },
            },
            post: {
                operationId: 'appendMessages',
                summary: 'Append messages',
                description:
                    'Append one or more messages to the context. Each append creates a new version. Limits: at most 1,000 messages per append and 10,000 messages per context — exceeding either returns 400 with code `invalid_input`.',
                mintContent:
                    '<Info>Every append creates a **new version** of the context, so `?version=N` and `?at=…` on the GET endpoint are meaningful for append-only sessions too.</Info>\n\n<Warning>`index` is a reserved field. The `metadata` field is extracted and stored at the message level—it won\'t appear as a regular content field.</Warning>',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `// Single message
const { data, version } = await uc.append('ctx_abc123', { role: 'user', content: 'Hello!' })

// With metadata
const { data, version } = await uc.append('ctx_abc123', {
  role: 'user',
  content: 'Hello!',
  metadata: { source: 'web' }
})`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `# Single message
result = uc.append('ctx_abc123', {'role': 'user', 'content': 'Hello!'})

# With metadata
result = uc.append('ctx_abc123', {
  'role': 'user',
  'content': 'Hello!',
  'metadata': {'source': 'web'}
})`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl -X POST https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"role": "user", "content": "Hello!", "metadata": {"source": "web"}}'`,
                    },
                ],
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        description: 'Context ID (ctx_...)',
                        schema: { type: 'string' },
                    },
                ],
                requestBody: {
                    description:
                        'Single message or array. The `metadata` field is extracted; all other fields stored as content.',
                    schemaRef: 'AppendInput',
                },
                responses: {
                    201: { description: 'Messages appended', schemaRef: 'WriteResponse' },
                    409: errorRef(
                        'Retryable conflict — this write raced with a concurrent write on the same context (database serialization conflict). The response carries a `Retry-After` header; wait that many seconds and retry the request verbatim.',
                        { headers: conflictHeaders }
                    ),
                    404: errorRef('Context not found'),
                },
            },
            patch: {
                operationId: 'updateMessages',
                summary: 'Update messages',
                description:
                    'Update one or more messages by `id` or `index`. Each update automatically creates a new version.',
                mintContent:
                    '<Info>Include `metadata` in the request body to record why this update was made. It is optional, but recommended to make audit trail easier to understand.</Info>',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `// Update by id
const { data, version } = await uc.update('ctx_abc123', { id: 'msg_xyz', content: 'Fixed!' })

// Update by index (0 = first message, -1 = last)
const { data, version } = await uc.update('ctx_abc123', { index: 0, content: 'New system prompt' })
const { data, version } = await uc.update('ctx_abc123', { index: -1, content: 'Fix last msg' })

// With audit metadata
const { data, version } = await uc.update('ctx_abc123', 
  { id: 'msg_xyz', content: 'Fixed!' },
  { metadata: { reason: 'typo fix', author: 'alice' } }
)

// Multiple updates
await uc.update('ctx_abc123', [
  { index: 0, content: 'Updated system prompt' },
  { id: 'msg_bbb', content: 'Updated 2' }
])

// Multiple updates with audit metadata
await uc.update('ctx_abc123', [
  { index: 0, content: 'Updated system prompt' },
  { id: 'msg_bbb', content: 'Updated 2' }
], { metadata: { reason: 'batch fix', ticket: 'JIRA-456' } })`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `# Update by id
result = uc.update('ctx_abc123', id='msg_xyz', content='Fixed!')

# Update by index (0 = first message, -1 = last)
result = uc.update('ctx_abc123', index=0, content='New system prompt')
result = uc.update('ctx_abc123', index=-1, content='Fix last msg')

# With audit metadata
result = uc.update('ctx_abc123',
  index=0, content='Fixed!',
  metadata={'reason': 'typo fix', 'author': 'alice'}
)

# Multiple updates
uc.update('ctx_abc123', [
  {'index': 0, 'content': 'Updated system prompt'},
  {'id': 'msg_bbb', 'content': 'Updated 2'}
])

# Multiple updates with audit metadata
uc.update('ctx_abc123', [
  {'index': 0, 'content': 'Updated system prompt'},
  {'id': 'msg_bbb', 'content': 'Updated 2'}
], metadata={'reason': 'batch fix', 'ticket': 'JIRA-456'})`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `# Update by id
curl -X PATCH https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"id": "msg_xyz", "content": "Fixed typo!"}'

# Update by index (0 = first, -1 = last)
curl -X PATCH https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"index": 0, "content": "New system prompt"}'

# Update last message
curl -X PATCH https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"index": -1, "content": "Fixed last message"}'

# With audit metadata
curl -X PATCH https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"updates": [{"index": 0, "content": "Fixed!"}], "metadata": {"reason": "typo fix"}}'`,
                    },
                ],
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        description: 'Context ID (ctx_...)',
                        schema: { type: 'string' },
                    },
                ],
                requestBody: {
                    description:
                        'Single update, array of updates, or object with `updates` array and `metadata` for audit trail.',
                    schemaRef: 'UpdateRequestBody',
                },
                responses: {
                    200: {
                        description: 'Messages updated (new version created)',
                        schemaRef: 'WriteResponse',
                    },
                    400: errorRef(
                        'Invalid request (both id and index provided, neither provided, or index out of range)'
                    ),
                    404: errorRef('Context or message not found'),
                },
            },
            delete: {
                operationId: 'deleteContextOrMessages',
                summary: 'Delete messages or the entire context',
                description:
                    'Send a body with `ids` to soft-delete specific messages (creates a new version, prior versions retain the messages). Send no body OR `{"permanent": true}` to permanently delete the entire context (irreversible).',
                mintContent:
                    '<Tip>Send `{"ids": [...]}` to delete specific messages (soft, versioned). Send `{"permanent": true}` to delete the entire context (hard, irreversible).</Tip>\n\n<Info>Include `metadata` to record why this deletion was made. Optional, but recommended for audit trail.</Info>',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `// Delete entire context (permanent, irreversible)
await uc.delete('ctx_abc123', { permanent: true })

// Delete messages by id (soft, versioned)
const { data, version } = await uc.delete('ctx_abc123', 'msg_xyz')

// Delete by index (0 = first, -1 = last)
const { data, version } = await uc.delete('ctx_abc123', 0)

// With audit metadata
const { data, version } = await uc.delete('ctx_abc123', 'msg_xyz', {
  metadata: { reason: 'hallucination', ticket: 'JIRA-123' }
})

// Multiple deletes (mix of ids and indices)
await uc.delete('ctx_abc123', ['msg_aaa', 0, -1])`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `# Delete entire context (permanent, irreversible)
uc.delete('ctx_abc123', permanent=True)

# Delete messages by id (soft, versioned)
result = uc.delete('ctx_abc123', 'msg_xyz')

# Delete by index (0 = first, -1 = last)
result = uc.delete('ctx_abc123', 0)

# With audit metadata
result = uc.delete('ctx_abc123', 'msg_xyz',
  metadata={'reason': 'hallucination', 'ticket': 'JIRA-123'}
)

# Multiple deletes (mix of ids and indices)
uc.delete('ctx_abc123', ['msg_aaa', 0, -1])`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `# Delete entire context (permanent)
curl -X DELETE https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"permanent": true}'

# Delete messages by id (soft, versioned)
curl -X DELETE https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"ids": "msg_xyz"}'

# Delete by index
curl -X DELETE https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"ids": 0}'

# With audit metadata
curl -X DELETE https://api.ultracontext.ai/contexts/ctx_abc123 \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"ids": [0, "msg_xyz"], "metadata": {"reason": "cleanup"}}'`,
                    },
                ],
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        description: 'Context ID (ctx_...)',
                        schema: { type: 'string' },
                    },
                ],
                requestBody: {
                    description:
                        'Optional. Omit to delete the entire context. Include `ids` to delete specific messages.',
                    required: false,
                    schemaRef: 'DeleteInput',
                },
                responses: {
                    200: {
                        description:
                            'Context deleted or messages deleted (new version created)',
                        jsonSchema: {
                            oneOf: [
                                { $ref: '#/components/schemas/PermanentDeleteResponse' },
                                { $ref: '#/components/schemas/WriteResponse' },
                            ],
                        },
                    },
                    400: errorRef('Index out of range'),
                    404: errorRef('Context or message not found'),
                    409: errorRef(
                        'Retryable conflict — the permanent delete raced with a concurrent write on the same context (database serialization conflict). The response carries a `Retry-After` header; wait that many seconds and retry the request verbatim.',
                        { headers: conflictHeaders }
                    ),
                },
            },
        },
    },
    {
        path: '/contexts/delete-many',
        operations: {
            post: {
                operationId: 'deleteManyContexts',
                summary: 'Delete multiple contexts permanently',
                description:
                    'Permanently delete up to 100 contexts in one call. Each context and all its versions are irreversibly removed.',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `const { results, deleted_count } = await uc.deleteMany(['ctx_abc123', 'ctx_def456'])

for (const r of results) {
  if (r.deleted) console.log(\`Deleted \${r.id}\`)
  else console.log(\`Failed \${r.id}: \${r.error}\`)
}`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `result = uc.delete_many(['ctx_abc123', 'ctx_def456'])

for r in result['results']:
    if r['deleted']:
        print(f"Deleted {r['id']}")
    else:
        print(f"Failed {r['id']}: {r.get('error')}")`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl -X POST https://api.ultracontext.ai/contexts/delete-many \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"ids": ["ctx_abc123", "ctx_def456"]}'`,
                    },
                ],
                requestBody: { required: true, schemaRef: 'DeleteManyInput' },
                responses: {
                    200: {
                        description: 'All contexts deleted successfully',
                        schemaRef: 'DeleteManyResponse',
                    },
                    207: {
                        description: 'Multi-Status — partial success (some items failed)',
                        schemaRef: 'DeleteManyResponse',
                    },
                    400: errorRef('Invalid request body (empty, oversized, non-string element)'),
                    409: {
                        description:
                            'Every item failed with a retryable serialization conflict (each item is flagged `retryable: true`). The response carries a `Retry-After` header; wait that many seconds and retry the request verbatim.',
                        headers: conflictHeaders,
                        schemaRef: 'DeleteManyResponse',
                    },
                    500: {
                        description:
                            'All items failed (response body still contains per-item errors)',
                        schemaRef: 'DeleteManyResponse',
                    },
                },
            },
        },
    },
    {
        path: '/contexts/search',
        operations: {
            get: {
                operationId: 'searchMessages',
                summary: 'Search messages',
                description:
                    'Full-text search across all message content in your project. Free and unmetered — there is no query quota and no paywall. Results are ranked, and `content` is a snippet centered on the match.',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `const { data } = await uc.search('authentication bug')

// With filters
const { data } = await uc.search('retry', {
  limit: 5,
  project_path: '/Users/alice/Code/myapp',
})`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `result = uc.search('authentication bug')

# With filters
result = uc.search('retry', limit=5, project_path='/Users/alice/Code/myapp')`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl "https://api.ultracontext.ai/contexts/search?q=authentication+bug" \\
  -H "Authorization: Bearer $API_KEY"

# With limit + project filter
curl "https://api.ultracontext.ai/contexts/search?q=retry&limit=5&project_path=/Users/alice/Code/myapp" \\
  -H "Authorization: Bearer $API_KEY"`,
                    },
                ],
                parameters: [
                    {
                        name: 'q',
                        in: 'query',
                        required: true,
                        description: 'Search text (required, non-empty)',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'limit',
                        in: 'query',
                        description: 'Maximum number of hits to return',
                        schema: { type: 'integer', default: 20 },
                    },
                    {
                        name: 'source',
                        in: 'query',
                        description: 'Filter by agent source',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'user_id',
                        in: 'query',
                        description: 'Filter by user identifier',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'host',
                        in: 'query',
                        description: 'Filter by machine hostname',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'project_path',
                        in: 'query',
                        description: 'Filter by project directory path',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'session_id',
                        in: 'query',
                        description: 'Filter by session identifier',
                        schema: { type: 'string' },
                    },
                    {
                        name: 'after',
                        in: 'query',
                        description: 'Only messages created after this ISO 8601 timestamp',
                        schema: { type: 'string', format: 'date-time' },
                    },
                    {
                        name: 'before',
                        in: 'query',
                        description: 'Only messages created before this ISO 8601 timestamp',
                        schema: { type: 'string', format: 'date-time' },
                    },
                ],
                responses: {
                    200: {
                        description: 'Ranked search hits',
                        schemaRef: 'SearchResponse',
                    },
                    400: errorRef('Invalid query or limit'),
                    401: errorRef('Unauthorized'),
                },
            },
        },
    },
    {
        path: '/contexts/stats',
        operations: {
            get: {
                operationId: 'getActivityStats',
                summary: 'Activity stats',
                description:
                    'Aggregated write activity (appends, updates, deletes) computed on demand from your own database. Free — the commercial tier sells analytics; there is nothing to unlock here and no history window that silently truncates. Buckets are UTC; weeks start on Monday.',
                codeSamples: [
                    {
                        lang: 'typescript',
                        label: 'TypeScript',
                        source: `// Last 30 days, one bucket per day
const stats = await uc.stats({ days: 30 })

// Monthly buckets since a date, one agent source
const stats = await uc.stats({ bucket: 'month', from: '2026-01-01T00:00:00Z', source: 'claude' })`,
                    },
                    {
                        lang: 'python',
                        label: 'Python',
                        source: `# Last 30 days, one bucket per day
stats = uc.stats(days=30)

# Monthly buckets since a date, one agent source
stats = uc.stats(bucket='month', from='2026-01-01T00:00:00Z', source='claude')`,
                    },
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl "https://api.ultracontext.ai/contexts/stats?bucket=day&days=30" \\
  -H "Authorization: Bearer $API_KEY"

# Range + source
curl "https://api.ultracontext.ai/contexts/stats?bucket=week&from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z&source=codex" \\
  -H "Authorization: Bearer $API_KEY"`,
                    },
                ],
                parameters: [
                    {
                        name: 'bucket',
                        in: 'query',
                        description: 'Bucket size: `day` (default), `week`, or `month`',
                        schema: { type: 'string', enum: ['day', 'week', 'month'], default: 'day' },
                    },
                    {
                        name: 'from',
                        in: 'query',
                        description: 'Window start (ISO 8601). Defaults to `days` days ago.',
                        schema: { type: 'string', format: 'date-time' },
                    },
                    {
                        name: 'to',
                        in: 'query',
                        description: 'Window end (ISO 8601). Defaults to now.',
                        schema: { type: 'string', format: 'date-time' },
                    },
                    {
                        name: 'days',
                        in: 'query',
                        description: 'Window length in days when `from` is omitted (default 30)',
                        schema: { type: 'integer', default: 30 },
                    },
                    {
                        name: 'source',
                        in: 'query',
                        description: 'Restrict to one agent source',
                        schema: { type: 'string' },
                    },
                ],
                responses: {
                    200: { description: 'Activity rollup', schemaRef: 'ActivityResponse' },
                    400: errorRef('Invalid bucket, timestamp, or days value'),
                    401: errorRef('Unauthorized'),
                },
            },
        },
    },
    {
        path: '/v1/keys',
        operations: {
            post: {
                operationId: 'createKey',
                summary: 'Create API key',
                description:
                    'Create a new API key for a new project. Admin-only — authenticate with the UltraContext admin key (ULTRACONTEXT_ADMIN_KEY), not a regular API key. The raw key is returned exactly once; only its hash is stored.',
                codeSamples: [
                    {
                        lang: 'bash',
                        label: 'cURL',
                        source: `curl -X POST https://api.ultracontext.ai/v1/keys \\
  -H "Authorization: Bearer $ADMIN_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name": "ci-deploy"}'`,
                    },
                ],
                requestBody: { required: true, schemaRef: 'CreateKeyInput' },
                responses: {
                    200: { description: 'Key created (raw key returned once)', schemaRef: 'CreateKeyResponse' },
                    400: errorRef('Missing or invalid name'),
                    401: errorRef('Unauthorized (admin key required)'),
                    500: errorRef('Server error'),
                },
            },
        },
    },
    {
        path: '/v1/keys/{projectId}',
        operations: {
            get: {
                operationId: 'listKeys',
                summary: 'List a project\'s API keys',
                description:
                    'List all API keys for a project. Admin-only. Never exposes key hashes.',
                parameters: [
                    {
                        name: 'projectId',
                        in: 'path',
                        required: true,
                        description: 'Project ID (positive integer)',
                        schema: { type: 'integer' },
                    },
                ],
                responses: {
                    200: { description: 'Project and its keys', schemaRef: 'KeyListResponse' },
                    400: errorRef('projectId must be a positive integer'),
                    401: errorRef('Unauthorized (admin key required)'),
                },
            },
        },
    },
    {
        path: '/v1/keys/{id}',
        operations: {
            delete: {
                operationId: 'revokeKey',
                summary: 'Revoke API key',
                description:
                    'Revoke an API key — the leaked-key escape hatch. The key stops working immediately: the storage row is deleted and the auth cache entry is evicted. Admin-only.',
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        description: 'Key ID (positive integer)',
                        schema: { type: 'integer' },
                    },
                ],
                responses: {
                    200: { description: 'Key revoked', schemaRef: 'RevokeKeyResponse' },
                    400: errorRef('id must be a positive integer'),
                    401: errorRef('Unauthorized (admin key required)'),
                    404: errorRef('Key not found'),
                },
            },
        },
    },
    {
        path: '/v1/keys/{id}/rotate',
        operations: {
            post: {
                operationId: 'rotateKey',
                summary: 'Rotate API key',
                description:
                    'Issue a fresh key for the same project and revoke the old one in one step. Admin-only. The old prefix is returned (masked) so you can update references; the old raw key is not.',
                parameters: [
                    {
                        name: 'id',
                        in: 'path',
                        required: true,
                        description: 'Key ID to rotate (positive integer)',
                        schema: { type: 'integer' },
                    },
                ],
                responses: {
                    200: { description: 'Key rotated (new raw key returned once)', schemaRef: 'RotateKeyResponse' },
                    400: errorRef('id must be a positive integer'),
                    401: errorRef('Unauthorized (admin key required)'),
                    404: errorRef('Key not found'),
                },
            },
        },
    },
];

// -- components -------------------------------------------------------------------

export const openapiComponents = {
    securitySchemes: {
        bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            description:
                'API key from your UltraContext dashboard. The /v1/keys routes additionally require the admin key.',
        },
    },
    schemas: {
        Context: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'Unique identifier (ctx_...)',
                    example: 'ctx_a1b2c3d4e5f6',
                },
                metadata: {
                    type: 'object',
                    description: 'User-defined metadata',
                    additionalProperties: true,
                },
                created_at: {
                    type: 'string',
                    format: 'date-time',
                    description: 'ISO 8601 timestamp',
                },
            },
        },
        Message: {
            type: 'object',
            description:
                'Message with unwrapped content. Your fields are merged at the top level.',
            properties: {
                id: {
                    type: 'string',
                    description: 'Unique identifier (msg_...)',
                    example: 'msg_x1y2z3',
                },
                index: {
                    type: 'integer',
                    description: '0-based position in context',
                    example: 0,
                },
                metadata: { type: 'object', additionalProperties: true },
            },
            additionalProperties: true,
        },
        Version: {
            type: 'object',
            description: 'Version history entry with audit trail',
            properties: {
                version: {
                    type: 'integer',
                    description: '0-indexed version number',
                    example: 0,
                },
                created_at: {
                    type: 'string',
                    format: 'date-time',
                    description: 'ISO 8601 timestamp',
                },
                operation: {
                    type: 'string',
                    enum: ['create', 'update', 'delete'],
                    description: 'Operation that created this version',
                },
                affected: {
                    type: 'array',
                    items: { type: 'string' },
                    nullable: true,
                    description:
                        'Message IDs affected by update/delete operations. Null for create.',
                },
                metadata: {
                    type: 'object',
                    additionalProperties: true,
                    description:
                        'User-provided audit metadata (e.g., reason, performed_by). Only present when provided.',
                },
            },
        },
        GetContextResponse: {
            type: 'object',
            properties: {
                data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Message' },
                },
                version: {
                    type: 'integer',
                    description: 'Current version number being viewed',
                },
                versions: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Version' },
                    description: 'Version history (only present when ?history=true)',
                },
            },
        },
        WriteResponse: {
            type: 'object',
            properties: {
                data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/Message' },
                },
                version: {
                    type: 'integer',
                    description: 'Current version number after the write',
                },
            },
        },
        CreateContextInput: {
            type: 'object',
            properties: {
                from: {
                    type: 'string',
                    description: 'Source context ID to copy from (optional)',
                },
                version: {
                    type: 'integer',
                    description:
                        'When forking with `from`, copy from this specific version (0-indexed)',
                },
                at: {
                    type: 'integer',
                    description:
                        'When forking with `from`, copy only messages 0 through this index',
                },
                before: {
                    type: 'string',
                    format: 'date-time',
                    description:
                        'When forking with `from`, copy point-in-time state before this ISO timestamp',
                },
                metadata: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'User-defined metadata for this context',
                },
            },
            description: 'Create a new context with optional fork params and metadata',
        },
        AppendInput: {
            oneOf: [
                { $ref: '#/components/schemas/AppendMessage' },
                {
                    type: 'array',
                    items: { $ref: '#/components/schemas/AppendMessage' },
                },
            ],
        },
        AppendMessage: {
            type: 'object',
            properties: {
                metadata: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Message metadata (extracted and stored separately)',
                },
            },
            additionalProperties: true,
            description:
                'Message content with optional metadata. `index` is reserved.',
        },
        UpdateInput: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description:
                        'Message ID to update (msg_...). Either id or index required, not both.',
                },
                index: {
                    type: 'integer',
                    description:
                        'Message index (0 = first, -1 = last). Either `id` or `index` required.',
                },
            },
            additionalProperties: true,
            description:
                'Include `id` OR `index` (not both) and any fields to merge into the message',
        },
        UpdateRequestBody: {
            oneOf: [
                { $ref: '#/components/schemas/UpdateInput' },
                {
                    type: 'array',
                    items: { $ref: '#/components/schemas/UpdateInput' },
                },
                {
                    type: 'object',
                    properties: {
                        updates: {
                            type: 'array',
                            items: { $ref: '#/components/schemas/UpdateInput' },
                            description: 'Array of updates to apply',
                        },
                        metadata: {
                            type: 'object',
                            additionalProperties: true,
                            description:
                                'Audit metadata for this version (e.g., reason, author)',
                        },
                    },
                    required: ['updates'],
                },
            ],
        },
        DeleteInput: {
            description:
                'Either `ids` (soft-delete specific messages, versioned) or `{permanent: true}` (hard-delete entire context, irreversible). Any other body shape returns 400 to prevent typos from silently wiping a context.',
            oneOf: [
                {
                    type: 'object',
                    required: ['ids'],
                    properties: {
                        ids: {
                            oneOf: [
                                { type: 'string', description: 'Single message ID (msg_...)' },
                                {
                                    type: 'integer',
                                    description: 'Single message index (0 = first, -1 = last)',
                                },
                                {
                                    type: 'array',
                                    items: {
                                        oneOf: [{ type: 'string' }, { type: 'integer' }],
                                    },
                                    description: 'Array of message IDs and/or indices',
                                },
                            ],
                        },
                        metadata: {
                            type: 'object',
                            additionalProperties: true,
                            description:
                                'Audit metadata for this version (e.g., reason, ticket)',
                        },
                    },
                },
                {
                    type: 'object',
                    required: ['permanent'],
                    properties: {
                        permanent: {
                            type: 'boolean',
                            enum: [true],
                            description:
                                'Must be `true` to permanently delete the entire context',
                        },
                        metadata: {
                            type: 'object',
                            additionalProperties: true,
                            description:
                                'Audit metadata logged server-side (context history is wiped; metadata is echoed in the response)',
                        },
                    },
                },
            ],
        },
        PermanentDeleteResponse: {
            type: 'object',
            properties: {
                deleted: {
                    type: 'boolean',
                    description: 'Whether the context was deleted',
                },
                id: { type: 'string', description: 'The deleted context ID' },
                metadata: {
                    type: 'object',
                    additionalProperties: true,
                    description: 'Audit metadata echoed from the request, if supplied',
                },
            },
        },
        DeleteManyInput: {
            type: 'object',
            required: ['ids'],
            properties: {
                ids: {
                    type: 'array',
                    items: { type: 'string' },
                    minItems: 1,
                    maxItems: 100,
                    description: 'Array of context IDs to permanently delete (max 100)',
                },
            },
        },
        DeleteManyResponse: {
            type: 'object',
            description:
                'Status 200 when all succeeded, 207 (Multi-Status) on partial failure, 409 when every item failed with a retryable serialization conflict (Retry-After header), 500 when every item failed otherwise.',
            properties: {
                results: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: 'Context ID' },
                            deleted: {
                                type: 'boolean',
                                description: 'Whether the context was deleted',
                            },
                            error: {
                                type: 'string',
                                description: 'Error message if deletion failed',
                            },
                            retryable: {
                                type: 'boolean',
                                description:
                                    'True when the failure was a transient serialization conflict — retry the item verbatim after the Retry-After delay',
                            },
                        },
                    },
                },
                deleted_count: {
                    type: 'integer',
                    description: 'Number of contexts successfully deleted',
                },
            },
        },
        SearchHit: {
            type: 'object',
            description: 'One ranked search match',
            properties: {
                context_id: { type: 'string', description: 'Context the message belongs to' },
                branch_id: {
                    type: 'string',
                    description:
                        'Version head the message currently lives under (differs from context_id once the context was edited)',
                },
                message_id: { type: 'string', description: 'Message ID (msg_...)' },
                content: {
                    type: 'string',
                    description: 'Snippet of the message content centered on the match',
                },
                metadata: { type: 'object', additionalProperties: true },
                created_at: { type: 'string', format: 'date-time' },
                rank: {
                    type: 'number',
                    description: 'Relevance rank (lower is better)',
                },
            },
        },
        SearchResponse: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The (trimmed) search text' },
                limit: { type: 'integer', description: 'Effective limit applied' },
                data: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/SearchHit' },
                },
            },
        },
        ActivityResponse: {
            type: 'object',
            description:
                'Write-activity rollup over a UTC window. `series` is gap-filled (empty buckets carry null first/last event times).',
            properties: {
                bucket: {
                    type: 'string',
                    enum: ['day', 'week', 'month'],
                    description: 'Bucket size used',
                },
                from: { type: 'string', format: 'date-time', description: 'Window start' },
                to: { type: 'string', format: 'date-time', description: 'Window end' },
                totals: {
                    type: 'object',
                    properties: {
                        nodes: { type: 'integer' },
                        messages: { type: 'integer' },
                        contexts: { type: 'integer' },
                        root_contexts: { type: 'integer' },
                        sources: {
                            type: 'integer',
                            description: 'Distinct sources seen in the window',
                        },
                        active_buckets: {
                            type: 'integer',
                            description: 'Buckets that contain at least one event',
                        },
                    },
                },
                by_source: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            source: { type: 'string' },
                            nodes: { type: 'integer' },
                            messages: { type: 'integer' },
                            contexts: { type: 'integer' },
                            root_contexts: { type: 'integer' },
                        },
                    },
                },
                series: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            bucket_start: {
                                type: 'string',
                                format: 'date-time',
                                description: 'Bucket start (UTC)',
                            },
                            nodes: { type: 'integer' },
                            messages: { type: 'integer' },
                            contexts: { type: 'integer' },
                            root_contexts: { type: 'integer' },
                            first_event_at: {
                                type: 'string',
                                format: 'date-time',
                                nullable: true,
                            },
                            last_event_at: {
                                type: 'string',
                                format: 'date-time',
                                nullable: true,
                            },
                            sources: {
                                type: 'array',
                                items: { type: 'string' },
                            },
                        },
                    },
                },
            },
        },
        CreateKeyInput: {
            type: 'object',
            required: ['name'],
            properties: {
                name: {
                    type: 'string',
                    min_length: 1,
                    description: 'Human-readable project/key name (required)',
                },
            },
        },
        CreateKeyResponse: {
            type: 'object',
            properties: {
                key: {
                    type: 'string',
                    description: 'The raw API key — returned exactly once',
                },
                prefix: {
                    type: 'string',
                    description: 'Key prefix (safe to store; used for cache eviction)',
                },
                project_id: { type: 'integer' },
            },
        },
        ApiKey: {
            type: 'object',
            description: 'Public key row. key_hash is never exposed.',
            properties: {
                id: { type: 'integer' },
                project_id: { type: 'integer' },
                key_prefix: { type: 'string' },
                name: { type: 'string', nullable: true },
                created_at: { type: 'string', format: 'date-time' },
                last_used_at: { type: 'string', format: 'date-time', nullable: true },
            },
        },
        KeyListResponse: {
            type: 'object',
            properties: {
                project_id: { type: 'integer' },
                keys: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/ApiKey' },
                },
            },
        },
        RevokeKeyResponse: {
            type: 'object',
            properties: {
                revoked: { type: 'boolean' },
                id: { type: 'integer', description: 'The revoked key ID' },
            },
        },
        RotateKeyResponse: {
            type: 'object',
            properties: {
                key: {
                    type: 'string',
                    description: 'The new raw API key — returned exactly once',
                },
                prefix: {
                    type: 'string',
                    description: 'New key prefix (safe to store)',
                },
                project_id: { type: 'integer' },
            },
        },
        RateLimitError: {
            type: 'object',
            description:
                'Returned with 429 when a caller exceeds the abuse-protection rate limit. The limit protects against abuse, not usage — UltraContext is free and unmetered.',
            properties: {
                error: { type: 'string' },
                detail: { type: 'string' },
                retry_after_sec: {
                    type: 'integer',
                    description: 'Seconds to wait before retrying',
                },
            },
        },
        Error: {
            type: 'object',
            properties: {
                error: { type: 'string', description: 'Error message' },
                code: {
                    type: 'string',
                    enum: ['not_found', 'invalid_input', 'conflict', 'internal'],
                    description:
                        'Machine-readable error code. `conflict` is retryable — the response also carries a `Retry-After` header; wait that many seconds and retry the request verbatim.',
                },
            },
        },
    },
};

// -- renderer -----------------------------------------------------------------------

/** Assemble the full OpenAPI 3.1 document from the registry parts. */
export function renderOpenApi(): string {
    const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

    const paths: Record<string, Record<string, unknown>> = {};
    for (const { path, operations } of openapiPaths) {
        paths[path] = {};
        for (const [method, op] of Object.entries(operations)) {
            const rendered: Record<string, unknown> = {};
            if (op.operationId) rendered.operationId = op.operationId;
            rendered.summary = op.summary;
            if (op.description !== undefined) rendered.description = op.description;
            if (op.mintContent !== undefined) rendered['x-mint'] = { content: op.mintContent };
            if (op.codeSamples !== undefined) rendered['x-codeSamples'] = op.codeSamples;
            if (op.parameters !== undefined) rendered.parameters = op.parameters;
            if (op.requestBody !== undefined) {
                rendered.requestBody = {
                    ...(op.requestBody.description !== undefined && {
                        description: op.requestBody.description,
                    }),
                    ...(op.requestBody.required !== undefined && {
                        required: op.requestBody.required,
                    }),
                    content: {
                        'application/json': {
                            schema: op.requestBody.schemaRef
                                ? ref(op.requestBody.schemaRef)
                                : (op.requestBody.jsonSchema as JsonSchema),
                        },
                    },
                };
            }
            const responses: Record<string, unknown> = {};
            for (const [status, resp] of Object.entries(op.responses)) {
                const entry: Record<string, unknown> = { description: resp.description };
                if (resp.headers !== undefined) entry.headers = resp.headers;
                entry.content = {
                    'application/json': {
                        schema: resp.schemaRef ? ref(resp.schemaRef) : resp.jsonSchema,
                    },
                };
                responses[status] = entry;
            }
            rendered.responses = responses;
            paths[path][method] = rendered;
        }
    }

    const doc = {
        openapi: '3.1.0',
        info: openapiInfo,
        servers: openapiServers,
        security: openapiSecurity,
        paths,
        components: openapiComponents,
    };
    return JSON.stringify(doc, null, 2) + '\n';
}
