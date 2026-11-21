/**
 * The `ezil_computer_tool_jobs` audit ledger (contract §5.4). Exactly one row per
 * delegation-verified call, including refused and failed ones. The ledger is also the
 * idempotency fence: `claimOriginal` inserts the originating row for a (computer, procedure,
 * requestId) under the partial unique index, so two concurrent first calls can never both win.
 *
 * Never stores a full command or any job output — only `command_sha256` and the secret-redacted
 * `command_prefix` (≤120 chars), plus the Job's state/exitCode. `stdout`/`stderr` are relayed to
 * the MCP but never written here.
 */
import { randomUUID } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

export interface AuditExecutor {
    execute(query: SQL): Promise<ArrayLike<Record<string, unknown>>>;
}

/** Identity of a verified call, fixed before the Worker is reached. */
export interface AuditEntry {
    userId: string;
    computerId: string;
    clientId: string;
    jti: string;
    procedure: string;
    scope: string;
    requestId: string | null;
    requestSha256: string | null;
    toolName: string | null;
    commandSha256: string | null;
    commandPrefix: string | null;
}

/** The outcome fields, known once the call resolves. */
export interface AuditOutcome {
    jobId: string | null;
    state: string | null;
    exitCode: number | null;
    error: string | null;
}

export interface OriginalRow {
    id: string;
    requestSha256: string | null;
    jobId: string | null;
}

/** What the ledger holds about the call/exec that first recorded a jobId, to synthesize a lost Job. */
export interface LostJobRecord {
    procedure: string;
    toolName: string | null;
    requestId: string | null;
    exitCode: number | null;
    createdAt: string;
    completedAt: string | null;
}

export interface ComputerToolsAudit {
    /** Insert the originating row, claiming the (computer, procedure, requestId) slot atomically. */
    claimOriginal(entry: AuditEntry): Promise<{ claimed: true; id: string } | { claimed: false; original: OriginalRow }>;
    /** Write the outcome onto a claimed originating row. */
    finalize(id: string, outcome: AuditOutcome): Promise<void>;
    /** Insert a standalone row (a read, or a replay with `replayOf` set) with its outcome in one write. */
    record(entry: AuditEntry, replayOf: string | null, outcome: AuditOutcome): Promise<void>;
    /** The earliest call/exec row that recorded `jobId` on this computer (for lost synthesis), else null. */
    findExecutingJob(computerId: string, jobId: string): Promise<LostJobRecord | null>;
}

const isoOf = (value: unknown): string | null =>
    value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;

export function createComputerToolsAudit(db: AuditExecutor): ComputerToolsAudit {
    return {
        async claimOriginal(entry) {
            const id = randomUUID();
            const inserted = await db.execute(sql`/* computer-tools:audit-claim */
                INSERT INTO public.ezil_computer_tool_jobs
                    (id, user_id, computer_id, client_id, jti, procedure, scope,
                     request_id, request_sha256, replay_of, tool_name, command_sha256, command_prefix)
                VALUES (${id}::uuid, ${entry.userId}::uuid, ${entry.computerId}::uuid, ${entry.clientId}, ${entry.jti},
                    ${entry.procedure}, ${entry.scope}, ${entry.requestId}::uuid, ${entry.requestSha256}, NULL,
                    ${entry.toolName}, ${entry.commandSha256}, ${entry.commandPrefix})
                ON CONFLICT (computer_id, procedure, request_id) WHERE request_id IS NOT NULL AND replay_of IS NULL
                DO NOTHING
                RETURNING id`);
            if (inserted.length === 1) return { claimed: true, id };
            // The conflicting insert has committed (ON CONFLICT blocks until it does); read it.
            const existing = await db.execute(sql`/* computer-tools:audit-original */
                SELECT id::text AS id, request_sha256, job_id FROM public.ezil_computer_tool_jobs
                WHERE computer_id = ${entry.computerId}::uuid AND procedure = ${entry.procedure}
                  AND request_id = ${entry.requestId}::uuid AND replay_of IS NULL
                LIMIT 1`);
            const row = existing[0];
            if (!row || typeof row.id !== 'string') throw new Error('computer_tools_audit_original_missing');
            return {
                claimed: false,
                original: {
                    id: row.id,
                    requestSha256: typeof row.request_sha256 === 'string' ? row.request_sha256 : null,
                    jobId: typeof row.job_id === 'string' ? row.job_id : null,
                },
            };
        },

        async finalize(id, outcome) {
            await db.execute(sql`/* computer-tools:audit-finalize */
                UPDATE public.ezil_computer_tool_jobs
                SET job_id = ${outcome.jobId}, state = ${outcome.state}, exit_code = ${outcome.exitCode},
                    error = ${outcome.error}, completed_at = now()
                WHERE id = ${id}::uuid`);
        },

        async record(entry, replayOf, outcome) {
            await db.execute(sql`/* computer-tools:audit-record */
                INSERT INTO public.ezil_computer_tool_jobs
                    (id, user_id, computer_id, client_id, jti, procedure, scope,
                     request_id, request_sha256, replay_of, tool_name, command_sha256, command_prefix,
                     job_id, state, exit_code, error, completed_at)
                VALUES (${randomUUID()}::uuid, ${entry.userId}::uuid, ${entry.computerId}::uuid, ${entry.clientId}, ${entry.jti},
                    ${entry.procedure}, ${entry.scope}, ${entry.requestId}::uuid, ${entry.requestSha256}, ${replayOf}::uuid,
                    ${entry.toolName}, ${entry.commandSha256}, ${entry.commandPrefix},
                    ${outcome.jobId}, ${outcome.state}, ${outcome.exitCode}, ${outcome.error}, now())`);
        },

        async findExecutingJob(computerId, jobId) {
            const rows = await db.execute(sql`/* computer-tools:audit-lost */
                SELECT procedure, tool_name, request_id::text AS request_id, exit_code, created_at, completed_at
                FROM public.ezil_computer_tool_jobs
                WHERE computer_id = ${computerId}::uuid AND job_id = ${jobId}
                  AND procedure IN ('computerTools.call', 'computerTools.exec')
                ORDER BY created_at ASC
                LIMIT 1`);
            const row = rows[0];
            if (!row || typeof row.procedure !== 'string') return null;
            const createdAt = isoOf(row.created_at);
            if (!createdAt) return null;
            return {
                procedure: row.procedure,
                toolName: typeof row.tool_name === 'string' ? row.tool_name : null,
                requestId: typeof row.request_id === 'string' ? row.request_id : null,
                exitCode: typeof row.exit_code === 'number' ? row.exit_code : null,
                createdAt,
                completedAt: isoOf(row.completed_at),
            };
        },
    };
}
