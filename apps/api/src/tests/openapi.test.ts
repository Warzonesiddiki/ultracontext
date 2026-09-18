// =============================================================================
// OPENAPI — generated docs cannot drift (API-009)
// =============================================================================
// The committed openapi.json is rendered from src/schemas/openapi.ts. These
// tests fail when:
//   1. the committed file diverges from renderOpenApi() (someone edited the
//      JSON by hand, or changed the registry without regenerating), or
//   2. the zod request contracts in src/schemas diverge from the documented
//      request bodies (spot-checks per schema: documented-valid examples must
//      parse, documented-invalid shapes must not).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderOpenApi, openapiPaths } from '../schemas/openapi';
import {
    CreateContextSchema,
    DeleteInputSchema,
    DeleteManySchema,
    GetContextQuerySchema,
    KeyProjectParamSchema,
    ListContextsQuerySchema,
    SearchQuerySchema,
    StatsQuerySchema,
    StrictIntString,
    LimitString,
    UpdateBodySchema,
    CreateKeySchema,
} from '../schemas';

const here = path.dirname(fileURLToPath(import.meta.url));
const openapiPath = path.resolve(here, '../../../docs/api-reference/openapi.json');

function parse() {
    return JSON.parse(readFileSync(openapiPath, 'utf8')) as {
        openapi: string;
        info: { title: string; version: string };
        paths: Record<string, Record<string, { operationId: string; summary: string; responses: Record<string, unknown> }>>;
        components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
    };
}

describe('openapi generation', () => {
    it('committed openapi.json is byte-identical to renderOpenApi()', () => {
        const committed = readFileSync(openapiPath, 'utf8');
        const rendered = renderOpenApi();
        assert.equal(committed, rendered);
    });

    it('is valid OpenAPI 3.1 with all expected paths', () => {
        const doc = parse();
        assert.equal(doc.openapi, '3.1.0');
        const expectedPaths = [
            '/',
            '/health',
            '/health/ready',
            '/contexts',
            '/contexts/search',
            '/contexts/stats',
            '/contexts/{id}',
            '/contexts/delete-many',
            '/mcp',
            '/v1/keys',
            '/v1/keys/{projectId}',
            '/v1/keys/{id}',
            '/v1/keys/{id}/rotate',
        ];
        for (const p of expectedPaths) {
            assert.ok(doc.paths[p], `missing path ${p}`);
        }
        // every operation has an operationId, summary, and at least one response
        for (const [p, ops] of Object.entries(doc.paths)) {
            for (const [m, op] of Object.entries(ops)) {
                assert.ok(op.operationId, `${p} ${m} missing operationId`);
                assert.ok(op.summary, `${p} ${m} missing summary`);
                assert.ok(Object.keys(op.responses).length > 0, `${p} ${m} missing responses`);
            }
        }
    });

    it('registry path count matches the rendered document', () => {
        assert.equal(openapiPaths.length, 13);
        const doc = parse();
        assert.equal(Object.keys(doc.paths).length, 13);
    });

    it('Error schema documents the four machine-readable codes', () => {
        const doc = parse();
        const code = doc.components.schemas.Error.properties?.['code'] as { enum: string[] };
        assert.deepEqual(code.enum, ['not_found', 'invalid_input', 'conflict', 'internal']);
    });
});

describe('zod contracts match the documented request bodies', () => {
    it('CreateContext: documented shapes parse, typo/non-string do not', () => {
        assert.ok(CreateContextSchema.safeParse({}).success);
        assert.ok(CreateContextSchema.safeParse({ metadata: { name: 'x' } }).success);
        assert.ok(
            CreateContextSchema.safeParse({ from: 'ctx_abc', version: 1, at: 5, before: '2024-01-15T10:30:00Z' })
                .success
        );
        assert.ok(!CreateContextSchema.safeParse({ from: 123 }).success);
        assert.ok(!CreateContextSchema.safeParse({ form: 'ctx_abc' }).success); // typo-safe
        assert.ok(!CreateContextSchema.safeParse({ metadata: 'nope' }).success);
    });

    it('list/search query: limit is digit-only, search q is required', () => {
        assert.ok(LimitString.safeParse('20').success);
        assert.ok(!LimitString.safeParse('abc').success);
        assert.ok(!LimitString.safeParse('-1').success);
        assert.ok(LimitString.safeParse('150').success); // clamped downstream, not rejected

        assert.ok(ListContextsQuerySchema.safeParse({}).success);
        assert.ok(ListContextsQuerySchema.safeParse({ limit: '10', source: 'claude' }).success);

        assert.ok(SearchQuerySchema.safeParse({ q: 'hello' }).success);
        assert.ok(!SearchQuerySchema.safeParse({}).success);
        assert.ok(!SearchQuerySchema.safeParse({ q: '' }).success);
    });

    it('stats query: bucket enum + days semantics', () => {
        assert.ok(StatsQuerySchema.safeParse({}).success);
        assert.ok(!StatsQuerySchema.safeParse({ bucket: 'hour' }).success);
        assert.ok(!StatsQuerySchema.safeParse({ days: '-1' }).success);
        assert.ok(!StatsQuerySchema.safeParse({ days: 'abc' }).success);
        assert.ok(StatsQuerySchema.safeParse({ bucket: 'month', days: '30' }).success);
    });

    it('get-context query: strict integer selectors', () => {
        assert.ok(StrictIntString.safeParse('0').success);
        assert.ok(StrictIntString.safeParse('-1').success);
        assert.ok(StrictIntString.safeParse('+2').success);
        assert.ok(!StrictIntString.safeParse('1.9').success);
        assert.ok(!StrictIntString.safeParse('1abc').success);
        assert.ok(!StrictIntString.safeParse(' 1 ').success);

        assert.ok(GetContextQuerySchema.safeParse({ version: '1', history: 'true' }).success);
        assert.ok(!GetContextQuerySchema.safeParse({ version: '1.9' }).success);
    });

    it('delete body: the three accepted shapes, nothing ambiguous', () => {
        assert.ok(DeleteInputSchema.safeParse({}).success); // legacy: permanent
        assert.ok(DeleteInputSchema.safeParse({ permanent: true }).success);
        assert.ok(DeleteInputSchema.safeParse({ ids: 'msg_x' }).success);
        assert.ok(DeleteInputSchema.safeParse({ ids: -1 }).success);
        assert.ok(DeleteInputSchema.safeParse({ ids: [0, 'msg_x'], metadata: { reason: 't' } }).success);
        assert.ok(!DeleteInputSchema.safeParse({ permanent: 'yes' }).success);
        assert.ok(!DeleteInputSchema.safeParse({ ids: 'msg_x', metadata: 'nope' }).success);
    });

    it('delete-many: 1..100 string ids', () => {
        assert.ok(DeleteManySchema.safeParse({ ids: ['ctx_a'] }).success);
        assert.ok(DeleteManySchema.safeParse({ ids: Array.from({ length: 100 }, (_, i) => `c${i}`) }).success);
        assert.ok(!DeleteManySchema.safeParse({}).success);
        assert.ok(!DeleteManySchema.safeParse({ ids: [] }).success);
        assert.ok(!DeleteManySchema.safeParse({ ids: Array.from({ length: 101 }, (_, i) => `c${i}`) }).success);
        assert.ok(!DeleteManySchema.safeParse({ ids: ['ctx_a', 7] }).success);
    });

    it('update body: single, array, and {updates, metadata} forms', () => {
        assert.ok(UpdateBodySchema.safeParse({ index: 0, content: 'x' }).success);
        assert.ok(UpdateBodySchema.safeParse([{ id: 'msg_a', content: 'x' }]).success);
        assert.ok(
            UpdateBodySchema.safeParse({ updates: [{ index: -1, content: 'x' }], metadata: { reason: 'r' } })
                .success
        );
        assert.ok(!UpdateBodySchema.safeParse({ updates: 'nope' }).success);
        assert.ok(!UpdateBodySchema.safeParse('string').success);
        assert.ok(!UpdateBodySchema.safeParse({ metadata: 'nope' }).success);
    });

    it('keys: name required; numeric params must be positive integers', () => {
        assert.ok(CreateKeySchema.safeParse({ name: 'ci' }).success);
        assert.ok(!CreateKeySchema.safeParse({}).success);
        assert.ok(!CreateKeySchema.safeParse({ name: '' }).success);
        assert.ok(!CreateKeySchema.safeParse({ name: 123 }).success);
        assert.ok(!CreateKeySchema.safeParse({ name: 'ci', extra: 1 }).success); // strict

        assert.ok(KeyProjectParamSchema.safeParse({ projectId: '3' }).success);
        assert.ok(!KeyProjectParamSchema.safeParse({ projectId: 'abc' }).success);
        assert.ok(!KeyProjectParamSchema.safeParse({ projectId: '0' }).success);
        assert.ok(!KeyProjectParamSchema.safeParse({ projectId: '1.5' }).success);
        assert.ok(!KeyProjectParamSchema.safeParse({ projectId: '-2' }).success);
    });
});
