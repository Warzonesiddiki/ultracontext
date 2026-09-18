// =============================================================================
// OPENAPI GENERATOR (API-009)
// =============================================================================
// Renders apps/docs/api-reference/openapi.json from the schema registry in
// src/schemas/openapi.ts — the single source of truth. Run:
//
//   pnpm --filter @ultracontext-api openapi:generate
//
// openapi.test.ts keeps the committed file in lockstep: CI fails if the
// generated document and the committed file ever diverge.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { renderOpenApi } from '../src/schemas/openapi';

const here = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(here, '../../docs/api-reference/openapi.json');

writeFileSync(outPath, renderOpenApi(), 'utf8');
console.log(`wrote ${outPath} from src/schemas/openapi.ts`);
