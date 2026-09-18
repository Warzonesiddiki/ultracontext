// =============================================================================
// PERMANENT DELETE AUDIT TRAIL (API-011)
// =============================================================================
// A permanent delete is IRREVERSIBLE — the context, every version, and the
// message history vanish. The audit metadata the caller supplies used to be
// console.info'd only: once the host's logs rotated, the operation left no
// trace. API-011 persists an APPEND-ONLY record (one JSON line, fsync'd)
// BEFORE the wipe runs, and fails closed: if the record cannot be written,
// the delete is aborted with a 500 and nothing is deleted.
//
// The trail is a local JSONL file — local-first like the rest of the
// product: no audit events leave the machine. Path resolution order:
//   1. $ULTRACONTEXT_AUDIT_LOG            (explicit override)
//   2. sqlite provider: beside the database file
//   3. everything else: ~/.ultracontext/
//
// createApp resolves the default sink; tests inject InMemoryAuditSink via
// AppOptions.auditSink. On runtimes where the file cannot be written (e.g.
// Workers FS restrictions), record() rejects and the delete fails closed —
// a failed delete is always preferable to an unwitnessed wipe.

import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { ApiConfig } from '../types/api';

// -- record shape ---------------------------------------------------------------

export interface PermanentDeleteAuditEntry {
    /** ISO 8601 UTC timestamp of the record */
    ts: string;
    /** event discriminator — future audit event types may share the file */
    event: 'permanent_delete';
    /** request correlation id (API-008) */
    request_id: string;
    project_id: number;
    context_id: string;
    /** the audit metadata the caller supplied, when present */
    metadata?: Record<string, unknown>;
}

// -- sinks -----------------------------------------------------------------------

export interface AuditSink {
    /** Persist one audit entry durably. MUST reject when the entry is not
     *  durably written — the caller aborts the irreversible op on failure. */
    record(entry: PermanentDeleteAuditEntry): Promise<void>;
}

/** Append-only JSONL sink. Every record() appends one line and fsyncs, so a
 *  persisted line survives a crash. */
export class FileAuditSink implements AuditSink {
    constructor(readonly filePath: string) {}

    async record(entry: PermanentDeleteAuditEntry): Promise<void> {
        const line = JSON.stringify(entry) + '\n';
        await mkdir(dirname(this.filePath), { recursive: true });
        const handle = await open(this.filePath, 'a');
        try {
            await handle.writeFile(line, { encoding: 'utf8' });
            // fsync BEFORE the wipe: a record lost to a crash is worse than a
            // failed delete.
            await handle.sync();
        } finally {
            await handle.close();
        }
    }
}

/** Test sink: keeps entries in memory. Set `failWith` to make record()
 *  reject (fail-closed path). */
export class InMemoryAuditSink implements AuditSink {
    readonly entries: PermanentDeleteAuditEntry[] = [];
    failWith?: Error;

    async record(entry: PermanentDeleteAuditEntry): Promise<void> {
        if (this.failWith) throw this.failWith;
        this.entries.push(entry);
    }
}

// -- default resolution ------------------------------------------------------------

function expandHome(value: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    if (value === '~') return home;
    if (value.startsWith('~/')) return home + value.slice(1);
    return value;
}

export const AUDIT_LOG_FILE_NAME = 'audit-permanent-delete.jsonl';

/** Default trail location: beside the SQLite file when the deployment is
 *  fully local (so the data directory stays portable); otherwise the shared
 *  ~/.ultracontext directory. */
export function defaultAuditLogPath(config: ApiConfig): string {
    if (config.DATABASE_PROVIDER === 'sqlite') {
        return join(dirname(expandHome(config.DATABASE_FILE)), AUDIT_LOG_FILE_NAME);
    }
    return join(expandHome('~/.ultracontext'), AUDIT_LOG_FILE_NAME);
}

/** $ULTRACONTEXT_AUDIT_LOG wins; otherwise the default location. */
export function resolveDefaultAuditSink(config: ApiConfig): AuditSink {
    const envPath = process.env.ULTRACONTEXT_AUDIT_LOG;
    return new FileAuditSink(envPath ? expandHome(envPath) : defaultAuditLogPath(config));
}
