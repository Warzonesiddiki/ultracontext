import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildApiConfig } from '../config';

// =============================================================================
// CONFIG — buildApiConfig env resolution (TEST-003)
// Pure function: no dotenv, no process.env — the Node wrapper (config.node.ts)
// loads .env files and then delegates to this.
// =============================================================================

const ADMIN = 'admin-key';

const base = (extra: Record<string, string | undefined> = {}) => ({
    DATABASE_PROVIDER: 'sqlite',
    ULTRACONTEXT_ADMIN_KEY: ADMIN,
    ...extra,
});

describe('buildApiConfig — sqlite provider', () => {
    it('defaults DATABASE_FILE to ~/.ultracontext/ultracontext.db', () => {
        const cfg = buildApiConfig(base());
        assert.ok(cfg.DATABASE_PROVIDER === 'sqlite');
        assert.equal(cfg.DATABASE_PROVIDER, 'sqlite');
        assert.equal(cfg.DATABASE_FILE, '~/.ultracontext/ultracontext.db');
        assert.equal(cfg.ULTRACONTEXT_ADMIN_KEY, ADMIN);
    });

    it('honours an explicit DATABASE_FILE', () => {
        const cfg = buildApiConfig(base({ DATABASE_FILE: '/data/ultracontext.db' }));
        assert.ok(cfg.DATABASE_PROVIDER === 'sqlite');
        assert.equal(cfg.DATABASE_FILE, '/data/ultracontext.db');
    });
});

describe('buildApiConfig — postgres provider', () => {
    it('resolves DATABASE_URL', () => {
        const cfg = buildApiConfig(base({ DATABASE_PROVIDER: 'postgres', DATABASE_URL: 'postgres://db:5432/uc' }));
        assert.ok(cfg.DATABASE_PROVIDER === 'postgres');
        assert.equal(cfg.DATABASE_PROVIDER, 'postgres');
        assert.equal(cfg.DATABASE_URL, 'postgres://db:5432/uc');
    });

    it('throws a clear error when DATABASE_URL is missing', () => {
        assert.throws(
            () => buildApiConfig(base({ DATABASE_PROVIDER: 'postgres' })),
            /Missing required env var: DATABASE_URL/
        );
    });
});

describe('buildApiConfig — supabase provider', () => {
    it('resolves URL + service role key', () => {
        const cfg = buildApiConfig(
            base({ DATABASE_PROVIDER: 'supabase', SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role' })
        );
        assert.ok(cfg.DATABASE_PROVIDER === 'supabase');
        assert.equal(cfg.DATABASE_PROVIDER, 'supabase');
        assert.equal(cfg.SUPABASE_URL, 'https://proj.supabase.co');
        assert.equal(cfg.SUPABASE_SERVICE_ROLE_KEY, 'service-role');
    });

    it('throws when SUPABASE_URL is missing', () => {
        assert.throws(
            () => buildApiConfig(base({ DATABASE_PROVIDER: 'supabase', SUPABASE_SERVICE_ROLE_KEY: 'service-role' })),
            /Missing required env var: SUPABASE_URL/
        );
    });

    it('throws when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
        assert.throws(
            () => buildApiConfig(base({ DATABASE_PROVIDER: 'supabase', SUPABASE_URL: 'https://proj.supabase.co' })),
            /Missing required env var: SUPABASE_SERVICE_ROLE_KEY/
        );
    });
});

describe('buildApiConfig — provider + admin key validation', () => {
    it('throws when DATABASE_PROVIDER is missing', () => {
        assert.throws(() => buildApiConfig({ ULTRACONTEXT_ADMIN_KEY: ADMIN }), /DATABASE_PROVIDER/);
    });

    it('throws on an invalid provider value', () => {
        assert.throws(
            () => buildApiConfig(base({ DATABASE_PROVIDER: 'mysql' })),
            /Missing or invalid env var: DATABASE_PROVIDER/
        );
    });

    it('trims and lowercases the provider value', () => {
        const cfg = buildApiConfig(
            base({ DATABASE_PROVIDER: '  Postgres  ', DATABASE_URL: 'postgres://db:5432/uc' })
        );
        assert.ok(cfg.DATABASE_PROVIDER === 'postgres');
        assert.equal(cfg.DATABASE_PROVIDER, 'postgres');
    });

    it('throws when the admin key is missing', () => {
        assert.throws(() => buildApiConfig({ DATABASE_PROVIDER: 'sqlite' }), /Missing required env var: ULTRACONTEXT_ADMIN_KEY/);
    });

    it('throws on an empty admin key', () => {
        assert.throws(() => buildApiConfig(base({ ULTRACONTEXT_ADMIN_KEY: '' })), /ULTRACONTEXT_ADMIN_KEY/);
    });
});
