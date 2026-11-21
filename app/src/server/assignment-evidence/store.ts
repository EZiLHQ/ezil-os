import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { attemptLifetimeMs, consentVersion, maxAttemptEvents, type AssignmentEvidenceEvent, type EvidencePilot } from './contract';

type Row = {
    id: string;
    started_at: string;
    expires_at: string;
    ended_at: string | null;
    last_sequence: number;
};
type EventRow = {
    id: string;
    sequence: number;
    kind: string;
    source: 'server_observed' | 'client_reported';
    occurred_at: string;
    received_at: string;
    detail: Record<string, unknown>;
};
type Runner = Pick<PostgresJsDatabase, 'execute'>;
type Transactional = Runner & { transaction<T>(fn: (tx: Runner) => Promise<T>): Promise<T> };

const instant = (value: string) => new Date(value).toISOString();
const attemptView = (row: Row, now: number) => ({
    id: row.id,
    state: row.ended_at ? 'ended' as const : Date.parse(row.expires_at) <= now ? 'expired' as const : 'active' as const,
    startedAt: instant(row.started_at),
    expiresAt: instant(row.expires_at),
    endedAt: row.ended_at ? instant(row.ended_at) : null,
});

const matches = (pilot: EvidencePilot) => sql`assignment_id = ${pilot.id} AND owner_id = ${pilot.ownerId}
    AND computer_id = ${pilot.computerId} AND repository_id = ${pilot.repositoryId}
    AND repository_ref = ${pilot.ref} AND base_sha = ${pilot.baseSha}`;

async function selectAttempt(db: Runner, pilot: EvidencePilot, attemptId?: string, lock = false) {
    const [row] = await db.execute<Row>(sql`
        SELECT id, started_at::text, expires_at::text, ended_at::text, last_sequence
        FROM public.ezil_assignment_evidence_attempts WHERE ${matches(pilot)}
        ${attemptId ? sql`AND id = ${attemptId}` : sql``}
        ${lock ? sql`FOR UPDATE` : sql``}
    `);
    return row;
}

function writeBoundary(db: Runner, attemptId: string, sequence: number, kind: 'assignment.started' | 'assignment.ended', now: string) {
    return db.execute(sql`
        INSERT INTO public.ezil_assignment_evidence_events (attempt_id,id,sequence,kind,source,occurred_at,received_at,detail)
        VALUES (${attemptId},${randomUUID()},${sequence},${kind},'server_observed',${now},${now},'{}'::jsonb)
    `);
}

export function evidenceStore(db: Transactional) {
    return {
        async current(pilot: EvidencePilot, now: number) {
            const row = await selectAttempt(db, pilot);
            return row ? attemptView(row, now) : null;
        },

        start(pilot: EvidencePilot, now: number) {
            return db.transaction(async tx => {
                const timestamp = new Date(now).toISOString();
                const [inserted] = await tx.execute<Row>(sql`
                    INSERT INTO public.ezil_assignment_evidence_attempts
                        (id,assignment_id,owner_id,computer_id,repository_id,repository_ref,base_sha,consent_version,started_at,expires_at,last_sequence)
                    VALUES (${randomUUID()},${pilot.id},${pilot.ownerId},${pilot.computerId},${pilot.repositoryId},${pilot.ref},${pilot.baseSha},
                            ${consentVersion},${timestamp},${new Date(now + attemptLifetimeMs).toISOString()},1)
                    ON CONFLICT (assignment_id) DO NOTHING
                    RETURNING id, started_at::text, expires_at::text, ended_at::text, last_sequence
                `);
                if (inserted) await writeBoundary(tx, inserted.id, 1, 'assignment.started', timestamp);
                const row = inserted ?? await selectAttempt(tx, pilot);
                return row ? attemptView(row, now) : null;
            });
        },

        append(pilot: EvidencePilot, attemptId: string, events: AssignmentEvidenceEvent[], now: number) {
            return db.transaction(async tx => {
                const row = await selectAttempt(tx, pilot, attemptId, true);
                if (!row) return 'not_found' as const;
                if (attemptView(row, now).state !== 'active') return 'closed' as const;
                const start = Date.parse(row.started_at);
                // Client time is contextual. Sequence and received time come from the server.
                if (events.some(event => Date.parse(event.occurredAt) < start - 300_000 || Date.parse(event.occurredAt) > now + 60_000)) {
                    return 'event_time' as const;
                }

                const existing = await tx.execute<Pick<EventRow, 'id' | 'kind' | 'source' | 'occurred_at' | 'detail'>>(sql`
                    SELECT id, kind, source, occurred_at::text, detail
                    FROM public.ezil_assignment_evidence_events WHERE attempt_id = ${attemptId}
                    AND id IN (${sql.join(events.map(event => sql`${event.id}`), sql`, `)})
                `);
                const prior = new Map(existing.map(event => [event.id, event]));
                const sameDetail = (a: Record<string, unknown>, b: Record<string, unknown>) =>
                    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
                for (const event of events) {
                    const original = prior.get(event.id);
                    if (original && (original.source !== 'client_reported' || original.kind !== event.kind
                        || instant(original.occurred_at) !== event.occurredAt || !sameDetail(original.detail, event.detail))) {
                        return 'reused_event_id' as const;
                    }
                }
                const fresh = events.filter(event => !prior.has(event.id));
                if (row.last_sequence - 1 + fresh.length > maxAttemptEvents) return 'event_limit' as const;

                if (fresh.length) {
                    const timestamp = new Date(now).toISOString();
                    const values = fresh.map((event, index) => sql`
                        (${attemptId},${event.id},${row.last_sequence + index + 1},${event.kind},'client_reported',
                         ${event.occurredAt},${timestamp},${JSON.stringify(event.detail)}::jsonb)
                    `);
                    await tx.execute(sql`
                        INSERT INTO public.ezil_assignment_evidence_events (attempt_id,id,sequence,kind,source,occurred_at,received_at,detail)
                        VALUES ${sql.join(values, sql`, `)}
                    `);
                    await tx.execute(sql`UPDATE public.ezil_assignment_evidence_attempts
                        SET last_sequence = ${row.last_sequence + fresh.length} WHERE id = ${attemptId}`);
                }
                return { accepted: events.map(event => event.id) };
            });
        },

        end(pilot: EvidencePilot, attemptId: string, now: number) {
            return db.transaction(async tx => {
                const row = await selectAttempt(tx, pilot, attemptId, true);
                if (!row) return null;
                if (attemptView(row, now).state !== 'active') return attemptView(row, now);
                const timestamp = new Date(now).toISOString();
                const next = row.last_sequence + 1;
                await writeBoundary(tx, attemptId, next, 'assignment.ended', timestamp);
                await tx.execute(sql`UPDATE public.ezil_assignment_evidence_attempts
                    SET ended_at = ${timestamp}, last_sequence = ${next} WHERE id = ${attemptId}`);
                return attemptView({ ...row, ended_at: timestamp }, now);
            });
        },

        async report(pilot: EvidencePilot, attemptId: string, after: number, now: number) {
            const row = await selectAttempt(db, pilot, attemptId);
            if (!row) return null;
            const found = await db.execute<EventRow>(sql`
                SELECT id, sequence, kind, source, occurred_at::text, received_at::text, detail
                FROM public.ezil_assignment_evidence_events
                WHERE attempt_id = ${attemptId} AND sequence > ${after} AND sequence <= ${row.last_sequence}
                ORDER BY sequence LIMIT 101
            `);
            const events = found.slice(0, 100).map(event => ({
                id: event.id, sequence: event.sequence, kind: event.kind, source: event.source,
                occurredAt: instant(event.occurred_at), receivedAt: instant(event.received_at), detail: event.detail,
            }));
            return {
                attempt: attemptView(row, now),
                elapsedMs: Math.max(0, Math.min(row.ended_at ? Date.parse(row.ended_at) : now, Date.parse(row.expires_at))
                    - Date.parse(row.started_at)),
                binding: { assignmentId: pilot.id, computerId: pilot.computerId, repositoryId: pilot.repositoryId, ref: pilot.ref, baseSha: pilot.baseSha },
                consentVersion,
                events,
                nextAfter: found.length > 100 ? events.at(-1)?.sequence : null,
            };
        },
    };
}

export type EvidenceStore = ReturnType<typeof evidenceStore>;
