import type { StorageAdapter } from '@ultracontext/core';
import { createDbClient } from './db';
import { DrizzleAdapter } from './drizzle';
import { SupabaseAdapter } from './supabase';
import { createSqliteAdapter } from './sqlite';

// =============================================================================
// ADAPTER FACTORY — picks the right backend based on config
// =============================================================================

// Minimal storage config — decoupled from any consumer's app config. Callers
// (e.g. apps/api ApiConfig) are structurally compatible and may carry extra fields.
export type StorageConfig =
    | { DATABASE_PROVIDER: 'postgres'; DATABASE_URL: string }
    | { DATABASE_PROVIDER: 'supabase'; SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }
    // sqlite = the fully local, self-hosted, zero-dependency path. A plain file on
    // disk. No server, no account, no network, no cost.
    | { DATABASE_PROVIDER: 'sqlite'; DATABASE_FILE: string };

// Async because the SQLite adapter must open the file and apply its schema
// before it can serve queries.
export async function createStorageAdapter(config: StorageConfig): Promise<StorageAdapter> {
    if (config.DATABASE_PROVIDER === 'supabase') {
        return new SupabaseAdapter(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
    }
    if (config.DATABASE_PROVIDER === 'sqlite') {
        return createSqliteAdapter(config.DATABASE_FILE);
    }
    return new DrizzleAdapter(await createDbClient(config.DATABASE_URL));
}

// -- re-exports ---------------------------------------------------------------

export type { StorageAdapter } from '@ultracontext/core';
export { DrizzleAdapter } from './drizzle';
export { SupabaseAdapter } from './supabase';
