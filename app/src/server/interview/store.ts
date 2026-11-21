/**
 * The interview registry and the append-only activity log (docs/contracts/interview-evidence-v1.md §7.2).
 *
 * All DB access for the lane lives here. The store mirrors `ai-traces/store.ts`: a narrow `InterviewDb` is injected
 * (so tests drive real SQL on PGlite, and nothing imports `@/server/db` eagerly), every value is parameterised, and
 * the atomic rate-limit upsert is the one from `ezil_ai_trace_limits`. `seq` is allocated under the interview's row
 * lock so it is gapless per interview; the DB triggers are the backstop for append-only and the state rule.
 */
import { sql } from 'drizzle-orm';

import { turnStartAtISO, type CleanClientEvent } from './events';

type Query = ReturnType<typeof sql>;
export interface InterviewDb {
    execute(query: Query): Promise<unknown>;
    transaction<T>(fn: (tx: InterviewDb) => Promise<T>): Promise<T>;
}

export const rowsOf = (result: unknown): Record<string, unknown>[] =>
    Array.isArray(result) ? result : ((result as { rows?: Record<string, unknown>[] })?.rows ?? []);

export type InterviewState = 'registered' | 'consented' | 'started' | 'finished';

/** One registry row, camel-cased. `osUserId`/`ezilIdSubject`/`noticeSha256` are null until consent. */
export interface InterviewRow {
    interviewId: string;
    canonicalUrl: string;
    repositoryId: string;
    handle: string;
    ownerEzilIdSubject: string;
    worksAccountId: string;
    state: InterviewState;
    osUserId: string | null;
    ezilIdSubject: string | null;
    noticeSha256: string | null;
    registeredAt: string;
    consentedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
}

const iso = (v: unknown): string | null => (v == null ? null : new Date(v as string | number | Date).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));

function mapRow(r: Record<string, unknown>): InterviewRow {
    return {
        interviewId: String(r.interview_id),
        canonicalUrl: String(r.canonical_url),
        repositoryId: String(r.repository_id),
        handle: String(r.handle),
        ownerEzilIdSubject: String(r.owner_ezil_id_subject),
        worksAccountId: String(r.works_account_id),
        state: String(r.state) as InterviewState,
        osUserId: str(r.os_user_id),
        ezilIdSubject: str(r.ezil_id_subject),
        noticeSha256: str(r.notice_sha256),
        registeredAt: iso(r.registered_at)!,
        consentedAt: iso(r.consented_at),
        startedAt: iso(r.started_at),
        finishedAt: iso(r.finished_at),
    };
}

const SELECT_COLUMNS = sql`interview_id, canonical_url, repository_id, handle, owner_ezil_id_subject,
    works_account_id, state, os_user_id, ezil_id_subject, notice_sha256,
    registered_at, consented_at, started_at, finished_at`;

export async function getInterviewById(db: InterviewDb, interviewId: string): Promise<InterviewRow | null> {
    const rows = rowsOf(await db.execute(sql`SELECT ${SELECT_COLUMNS} FROM ezil_interviews WHERE interview_id = ${interviewId}::uuid`));
    return rows[0] ? mapRow(rows[0]) : null;
}

export async function getInterviewByUrl(db: InterviewDb, canonicalUrl: string): Promise<InterviewRow | null> {
    const rows = rowsOf(await db.execute(sql`SELECT ${SELECT_COLUMNS} FROM ezil_interviews WHERE canonical_url = ${canonicalUrl}`));
    return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Candidate recognition (contract §1): by EZiL ID subject before consent (os_user_id null), by OS account id after it.
 * A null `ezilIdSubject` can never match; the caller turns "need a subject but none" into IDENTITY_REFRESH_REQUIRED.
 */
export function isCandidate(row: InterviewRow, who: { osUserId: string; ezilIdSubject: string | null }): boolean {
    return row.osUserId === null
        ? who.ezilIdSubject !== null && who.ezilIdSubject === row.ownerEzilIdSubject
        : row.osUserId === who.osUserId;
}

/** A row to append. `at` is server time; `clientAt` only on client-reported types; `data` is the exact §3 shape. */
interface EventRow { type: string; at: string; clientAt: string | null; data: Record<string, unknown> }

/**
 * Append events under the interview's row lock, allocating a gapless `seq` per interview. The caller must already
 * have performed any state transition in this same transaction (the insert-state trigger reads the current state).
 */
async function appendEvents(tx: InterviewDb, interviewId: string, rows: EventRow[]): Promise<void> {
    await tx.execute(sql`SELECT 1 FROM ezil_interviews WHERE interview_id = ${interviewId}::uuid FOR UPDATE`);
    const base = Number(rowsOf(await tx.execute(
        sql`SELECT coalesce(max(seq), 0)::int AS m FROM ezil_interview_events WHERE interview_id = ${interviewId}::uuid`,
    ))[0]!.m);
    let seq = base;
    for (const row of rows) {
        seq += 1;
        await tx.execute(sql`
            INSERT INTO ezil_interview_events (interview_id, seq, source, type, at, client_at, data)
            VALUES (${interviewId}::uuid, ${seq}, 'os', ${row.type}, ${row.at}::timestamptz,
                ${row.clientAt}::timestamptz, ${JSON.stringify(row.data)}::jsonb)`);
    }
}

export type RegisterOutcome = 'created' | 'replayed' | 'conflict';

/** Register an interview in `registered`. The same body again is a replay; a conflicting one (same id or URL) conflicts. */
export async function registerInterview(db: InterviewDb, input: {
    interviewId: string; repositoryId: string; canonicalUrl: string; handle: string;
    ownerEzilIdSubject: string; worksAccountId: string;
}): Promise<RegisterOutcome> {
    const sameBody = (row: InterviewRow): boolean =>
        row.repositoryId === input.repositoryId && row.canonicalUrl === input.canonicalUrl && row.handle === input.handle
        && row.ownerEzilIdSubject === input.ownerEzilIdSubject && row.worksAccountId === input.worksAccountId;
    return db.transaction(async (tx) => {
        const existing = await getInterviewById(tx, input.interviewId);
        if (existing) return sameBody(existing) ? 'replayed' : 'conflict';
        const urlOwner = await getInterviewByUrl(tx, input.canonicalUrl);
        if (urlOwner) return 'conflict';
        await tx.execute(sql`
            INSERT INTO ezil_interviews (interview_id, canonical_url, repository_id, handle, owner_ezil_id_subject, works_account_id)
            VALUES (${input.interviewId}::uuid, ${input.canonicalUrl}, ${input.repositoryId}, ${input.handle},
                ${input.ownerEzilIdSubject}, ${input.worksAccountId})`);
        return 'created';
    });
}

export type AcceptOutcome =
    | { kind: 'consented' }
    | { kind: 'idempotent' }
    | { kind: 'not_candidate' }
    | { kind: 'wrong_state' };

/**
 * Bind the candidate and move registered->consented, writing `consent.accepted` (OS seq 1) in the same transaction.
 * Idempotent for the same bound candidate. The notice version/sha are checked by the caller before this runs.
 */
export async function acceptConsent(db: InterviewDb, input: {
    interviewId: string; osUserId: string; ezilIdSubject: string; noticeSha256: string; noticeVersion: number; at: string;
}): Promise<AcceptOutcome> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ezil_interviews WHERE interview_id = ${input.interviewId}::uuid FOR UPDATE`);
        const row = await getInterviewById(tx, input.interviewId);
        if (!row) return { kind: 'not_candidate' };
        if (!isCandidate(row, input)) return { kind: 'not_candidate' };
        if (row.state === 'consented') return { kind: 'idempotent' };
        if (row.state !== 'registered') return { kind: 'wrong_state' };
        await tx.execute(sql`
            UPDATE ezil_interviews SET state = 'consented', os_user_id = ${input.osUserId}::uuid,
                ezil_id_subject = ${input.ezilIdSubject}, notice_sha256 = ${input.noticeSha256}, consented_at = ${input.at}::timestamptz
            WHERE interview_id = ${input.interviewId}::uuid`);
        await appendEvents(tx, input.interviewId, [{
            type: 'consent.accepted', at: input.at, clientAt: null,
            data: { noticeVersion: input.noticeVersion, noticeSha256: input.noticeSha256 },
        }]);
        return { kind: 'consented' };
    });
}

/** Admin start: consented->started, writing `interview.started`. Idempotent once started; else wrong state. */
export async function startInterview(db: InterviewDb, interviewId: string, at: string): Promise<'started' | 'idempotent' | 'wrong_state' | 'not_found'> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ezil_interviews WHERE interview_id = ${interviewId}::uuid FOR UPDATE`);
        const row = await getInterviewById(tx, interviewId);
        if (!row) return 'not_found';
        if (row.state === 'started') return 'idempotent';
        if (row.state !== 'consented') return 'wrong_state';
        await tx.execute(sql`UPDATE ezil_interviews SET state = 'started', started_at = ${at}::timestamptz WHERE interview_id = ${interviewId}::uuid`);
        await appendEvents(tx, interviewId, [{ type: 'interview.started', at, clientAt: null, data: {} }]);
        return 'started';
    });
}

/** Admin finish: ->finished, idempotent. `interview.finished` is written only when prior state was consented or started. */
export async function finishInterview(db: InterviewDb, interviewId: string, at: string): Promise<'finished' | 'idempotent' | 'not_found'> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ezil_interviews WHERE interview_id = ${interviewId}::uuid FOR UPDATE`);
        const row = await getInterviewById(tx, interviewId);
        if (!row) return 'not_found';
        if (row.state === 'finished') return 'idempotent';
        const writeEvent = row.state === 'consented' || row.state === 'started';
        await tx.execute(sql`UPDATE ezil_interviews SET state = 'finished', finished_at = ${at}::timestamptz WHERE interview_id = ${interviewId}::uuid`);
        if (writeEvent) await appendEvents(tx, interviewId, [{ type: 'interview.finished', at, clientAt: null, data: {} }]);
        return 'finished';
    });
}

/** Append `computer.opened` for a started interview (the open gate, purpose `open`). Best-effort: never blocks access. */
export async function writeComputerOpened(db: InterviewDb, interviewId: string, computerId: string, at: string): Promise<void> {
    await db.transaction((tx) => appendEvents(tx, interviewId, [{ type: 'computer.opened', at, clientAt: null, data: { computerId } }]));
}

export type EventsOutcome =
    | { kind: 'accepted'; accepted: number }
    | { kind: 'not_found' }
    | { kind: 'rate_limited' };

/**
 * Persist a validated client batch for the bound candidate while started. One transaction: the interview row lock,
 * the atomic 120/min consume (nothing consumed when over), the turn_start the server derives before each turn_end,
 * and the drop of a turn_end whose requestId was already recorded. Over-limit or not-candidate writes nothing.
 */
export async function appendClientEvents(db: InterviewDb, input: {
    interviewId: string; osUserId: string; events: CleanClientEvent[]; at: string; perMinute?: number;
}): Promise<EventsOutcome> {
    const limit = input.perMinute ?? 120;
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1 FROM ezil_interviews WHERE interview_id = ${input.interviewId}::uuid FOR UPDATE`);
        const row = await getInterviewById(tx, input.interviewId);
        if (!row || row.state !== 'started' || row.osUserId !== input.osUserId) return { kind: 'not_found' };

        const consumed = Number(rowsOf(await tx.execute(sql`
            WITH stamp AS (SELECT date_trunc('minute', clock_timestamp()) AS minute), upsert AS (
                INSERT INTO ezil_interview_event_limits (os_user_id, window_start, used)
                SELECT ${input.osUserId}::uuid, stamp.minute, ${input.events.length} FROM stamp
                ON CONFLICT (os_user_id) DO UPDATE SET window_start = excluded.window_start,
                    used = CASE WHEN ezil_interview_event_limits.window_start = excluded.window_start
                        THEN ezil_interview_event_limits.used + excluded.used ELSE excluded.used END
                WHERE (ezil_interview_event_limits.window_start < excluded.window_start AND excluded.used <= ${limit})
                   OR (ezil_interview_event_limits.window_start = excluded.window_start
                       AND ezil_interview_event_limits.used + excluded.used <= ${limit})
                RETURNING os_user_id)
            SELECT count(*)::int AS n FROM upsert`))[0]!.n);
        if (consumed === 0) return { kind: 'rate_limited' };

        // A turn_end whose requestId is already recorded for this interview, or repeated within the batch, is dropped.
        const seenTurnEnds = new Set(rowsOf(await tx.execute(sql`
            SELECT data->>'requestId' AS r FROM ezil_interview_events
            WHERE interview_id = ${input.interviewId}::uuid AND type = 'agent.turn_end'`)).map((r) => String(r.r)));
        const toWrite: EventRow[] = [];
        let accepted = 0;
        for (const ev of input.events) {
            if (ev.type === 'agent.turn_end') {
                const requestId = String(ev.data.requestId);
                if (seenTurnEnds.has(requestId)) continue;
                seenTurnEnds.add(requestId);
                toWrite.push({ type: 'agent.turn_start', at: turnStartAtISO(input.at, Number(ev.data.durationMs)), clientAt: null, data: { requestId, derived: true } });
                toWrite.push({ type: 'agent.turn_end', at: input.at, clientAt: ev.clientAt, data: ev.data });
            } else {
                toWrite.push({ type: ev.type, at: input.at, clientAt: ev.clientAt, data: ev.data });
            }
            accepted += 1;
        }
        if (toWrite.length) await appendEvents(tx, input.interviewId, toWrite);
        return { kind: 'accepted', accepted };
    });
}

/** The OS envelope (contract §2) for one stored row. `clientAt` is present only when the row carries one. */
export interface OsEnvelope {
    v: 1; interviewId: string; source: 'os'; seq: number; type: string; at: string; clientAt?: string; data: unknown;
}

/**
 * Admin events read: purge rows older than the 30-day retention first (the DELETE trigger only lets those through),
 * then return the OS envelopes in `seq` order.
 */
export async function listEvents(db: InterviewDb, interviewId: string): Promise<OsEnvelope[]> {
    await db.execute(sql`DELETE FROM ezil_interview_events
        WHERE interview_id = ${interviewId}::uuid AND at < now() - interval '30 days'`);
    const rows = rowsOf(await db.execute(sql`
        SELECT seq, type, at, client_at, data FROM ezil_interview_events
        WHERE interview_id = ${interviewId}::uuid ORDER BY seq`));
    return rows.map((r) => {
        const envelope: OsEnvelope = {
            v: 1, interviewId, source: 'os', seq: Number(r.seq), type: String(r.type), at: iso(r.at)!,
            data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
        };
        if (r.client_at != null) envelope.clientAt = iso(r.client_at)!;
        return envelope;
    });
}
