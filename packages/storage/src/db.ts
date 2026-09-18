import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { bigint, bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import postgres, { type Sql } from 'postgres';

import { migratePostgres } from './migrations/postgres';

const GLOBAL_DB_REGISTRY_KEY = '__ultracontextPgRegistry';

export const projects = pgTable('projects', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    public_id: text('public_id'),
});

export const api_keys = pgTable('api_keys', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    key_prefix: text('key_prefix').notNull(),
    key_hash: text('key_hash').notNull(),
    name: text('name'),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const nodes = pgTable('nodes', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    public_id: text('public_id').notNull(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    content: jsonb('content').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    parent_id: text('parent_id'),
    prev_id: text('prev_id'),
    context_id: text('context_id'),
});

// Named branches (ARCH-001, migration 0003): a project-scoped name pinned to an
// immutable version head id. head_id has NO foreign key on purpose — the target
// version node can be deleted later and an orphaned name is tolerated (readers
// report version -1) rather than cascading someone's branch away.
export const context_refs = pgTable('context_refs', {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    project_id: bigint('project_id', { mode: 'number' }).notNull(),
    context_id: text('context_id').notNull(),
    name: text('name').notNull(),
    head_id: text('head_id').notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const schema = {
    projects,
    api_keys,
    nodes,
    context_refs,
};

export type ApiDb = PostgresJsDatabase<typeof schema>;

type DbRegistry = {
    clients: Map<string, Sql>;
    databases: Map<string, ApiDb>;
};

function resolveDbRegistry(): DbRegistry {
    const globalWithRegistry = globalThis as typeof globalThis & {
        [GLOBAL_DB_REGISTRY_KEY]?: DbRegistry;
    };

    if (!globalWithRegistry[GLOBAL_DB_REGISTRY_KEY]) {
        globalWithRegistry[GLOBAL_DB_REGISTRY_KEY] = {
            clients: new Map<string, Sql>(),
            databases: new Map<string, ApiDb>(),
        };
    }

    return globalWithRegistry[GLOBAL_DB_REGISTRY_KEY]!;
}

export async function createDbClient(databaseUrl: string): Promise<ApiDb> {
    const registry = resolveDbRegistry();
    const existingDb = registry.databases.get(databaseUrl);
    if (existingDb) return existingDb;

    const sqlClient = postgres(databaseUrl, {
        prepare: false,
        max: 5,
        idle_timeout: 20,
        connect_timeout: 10,
    });

    // self-hosted Postgres auto-migrates on connect (idempotent, tracked in
    // schema_migrations; Supabase deployments use apps/postgres/init.sql)
    await migratePostgres(sqlClient);

    const db = drizzle(sqlClient, { schema });
    registry.clients.set(databaseUrl, sqlClient);
    registry.databases.set(databaseUrl, db);
    return db;
}
