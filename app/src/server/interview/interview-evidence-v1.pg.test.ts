/** Offline PostgreSQL proof of the interview evidence slice (migration 0038, store, service, gate) on PGlite.
 * Set EZIL_PGLITE_MODULE to an installed PGlite ESM entry. Synthetic local identities only; no hosted DB. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// gate.ts -> works/project-repo.ts imports `server-only` (a Next marker, absent under vitest); the same stub the
// repo's other server-module tests use. runInterviewOpenGate never touches `@/server/db` (only the public
// interviewOpenGate does, lazily), so no hosted connection is opened here.
vi.mock('server-only', () => ({}));

import { interviewOpenGate, runInterviewOpenGate } from './gate';
import { NOTICE_SHA256 } from './notice';
import {
    adminEvents, adminFinish, adminRegister, adminStart, consentAccept, consentStatus, eventsBatch, type HandlerResult,
} from './service';
import { listEvents, type InterviewDb } from './store';

interface LocalPg {
    exec(query: string): Promise<unknown>;
    query(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    transaction<T>(run: (tx: LocalPg) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
const MODULE = process.env.EZIL_PGLITE_MODULE;
const OWNER = 'auth0|candidate-a';
const OS_USER = '3b9e2a71-0c4d-4f5e-8a6b-1d2c3e4f5a6b';
const OTHER_SUBJECT = 'auth0|someone-else';
const dialect = new PgDialect();

describe.skipIf(!MODULE)('interview evidence on offline PostgreSQL', () => {
    let pg: LocalPg;
    const toDb = (source: LocalPg, inTx: boolean): InterviewDb => ({
        execute: (query) => { const compiled = dialect.sqlToQuery(query); return source.query(compiled.sql, compiled.params); },
        transaction: async (run) => (inTx ? run(toDb(source, true)) : source.transaction((tx) => run(toDb(tx, true)))),
    });
    let db: InterviewDb;
    const rows = async (query: SQL) => (await db.execute(query) as { rows: Record<string, unknown>[] }).rows;
    const eventRows = (interviewId: string) => rows(sql`SELECT seq, type, at, client_at, data FROM ezil_interview_events WHERE interview_id = ${interviewId}::uuid ORDER BY seq`);
    const countEvents = async (interviewId: string) => Number((await rows(sql`SELECT count(*)::int AS n FROM ezil_interview_events WHERE interview_id = ${interviewId}::uuid`))[0]!.n);
    const code = (r: HandlerResult) => (r.body as { error?: { code?: string } }).error?.code;
    const now = () => '2026-11-22T09:06:00.000Z';
    const subjectOf = (s: string | null) => async () => s;
    let n = 0;

    /** Register a fresh interview and advance it to the requested state. */
    async function mk(to: 'registered' | 'consented' | 'started' | 'finished') {
        n += 1;
        const interviewId = randomUUID();
        const handle = `cand-${n}`;
        const url = `https://git-qa.ezil.work/${handle}/interview-${n}.git`;
        const reg = await adminRegister(db, { gateOn: true, authz: 'ok', body: {
            interviewId, repositoryId: '4211', canonicalURL: url, handle, ownerEzilIdSubject: OWNER, worksAccountId: '1187' } });
        expect(reg.status).toBe(201);
        if (to !== 'registered') {
            const acc = await consentAccept(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), interviewId, noticeVersion: 1, noticeSha256: NOTICE_SHA256, now });
            expect(acc.status).toBe(200);
        }
        if (to === 'started' || to === 'finished') expect((await adminStart(db, { gateOn: true, authz: 'ok', interviewId, now })).status).toBe(200);
        if (to === 'finished') expect((await adminFinish(db, { gateOn: true, authz: 'ok', interviewId, now })).status).toBe(200);
        return { interviewId, url };
    }

    beforeAll(async () => {
        const { PGlite } = await import(/* @vite-ignore */ MODULE!);
        pg = new PGlite() as LocalPg;
        db = toDb(pg, false);
        await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
        await pg.exec(readFileSync(path.resolve(__dirname, '../../../drizzle/0038_interview_evidence.sql'), 'utf8'));
    });
    beforeEach(async () => { await pg.exec('TRUNCATE ezil_interview_events, ezil_interviews, ezil_interview_event_limits CASCADE'); });
    afterAll(async () => { await pg?.close(); });

    it('migration enables RLS and revokes browser roles on both tables', async () => {
        for (const table of ['ezil_interviews', 'ezil_interview_events', 'ezil_interview_event_limits']) {
            expect((await rows(sql.raw(`SELECT relrowsecurity FROM pg_class WHERE oid = '${table}'::regclass`)))[0]!.relrowsecurity).toBe(true);
            for (const role of ['anon', 'authenticated']) {
                expect((await rows(sql.raw(`SELECT has_table_privilege('${role}', '${table}', 'SELECT') AS a`)))[0]!.a).toBe(false);
            }
        }
    });

    it('triggers: append-only (UPDATE always, DELETE only after 30 days) and forward-only state', async () => {
        const { interviewId } = await mk('started');
        await db.execute(sql`INSERT INTO ezil_interview_events (interview_id, seq, type, at, data) VALUES (${interviewId}::uuid, 99, 'session.heartbeat', now(), '{}'::jsonb)`);
        await expect(db.execute(sql`UPDATE ezil_interview_events SET data = '{}'::jsonb WHERE interview_id = ${interviewId}::uuid AND seq = 99`)).rejects.toThrow(/append-only/);
        await expect(db.execute(sql`DELETE FROM ezil_interview_events WHERE interview_id = ${interviewId}::uuid AND seq = 99`)).rejects.toThrow(/only after 30 days/);
        // positive control: a 31-day-old row deletes.
        await db.execute(sql`INSERT INTO ezil_interview_events (interview_id, seq, type, at, data) VALUES (${interviewId}::uuid, 100, 'session.heartbeat', now() - interval '31 days', '{}'::jsonb)`);
        await db.execute(sql`DELETE FROM ezil_interview_events WHERE interview_id = ${interviewId}::uuid AND seq = 100`);
        await expect(db.execute(sql`UPDATE ezil_interviews SET state = 'consented' WHERE interview_id = ${interviewId}::uuid`)).rejects.toThrow(/forward-only/);
    });

    it('A3: another EZiL ID gets 404 repo_not_found from status and leaves zero rows', async () => {
        const { url, interviewId } = await mk('registered');
        const r = await consentStatus(db, { gateOn: true, osUserId: 'other-os-user', subject: subjectOf(OTHER_SUBJECT), url });
        expect(r.status).toBe(404);
        expect(code(r)).toBe('repo_not_found');
        expect(await countEvents(interviewId)).toBe(0);
        // The registry row is untouched: still registered, still unbound.
        expect((await rows(sql`SELECT state, os_user_id FROM ezil_interviews WHERE interview_id = ${interviewId}::uuid`))[0]).toMatchObject({ state: 'registered', os_user_id: null });
    });

    it('status: no subject -> 409 IDENTITY_REFRESH_REQUIRED; candidate -> notice; A4 zero rows before accept', async () => {
        const { url, interviewId } = await mk('registered');
        expect(code(await consentStatus(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(null), url }))).toBe('IDENTITY_REFRESH_REQUIRED');
        const seen = await consentStatus(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), url });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ interview: { interviewId, state: 'registered', notice: { version: 1, sha256: NOTICE_SHA256 } } });
        expect(await countEvents(interviewId)).toBe(0); // A4
    });

    it('status: a non-interview or unknown git-qa URL is interview:null (boot continues unchanged)', async () => {
        expect((await consentStatus(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), url: 'https://github.com/a/b.git' })).body).toEqual({ interview: null });
        expect((await consentStatus(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), url: 'https://git-qa.ezil.work/nobody/none.git' })).body).toEqual({ interview: null });
    });

    it('accept: notice mismatch, wrong candidate and wrong state are refused with zero rows; the candidate binds and consent.accepted is seq 1', async () => {
        const { interviewId } = await mk('registered');
        expect(code(await consentAccept(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), interviewId, noticeVersion: 1, noticeSha256: '0'.repeat(64), now }))).toBe('notice_mismatch');
        expect(code(await consentAccept(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), interviewId, noticeVersion: 2, noticeSha256: NOTICE_SHA256, now }))).toBe('notice_mismatch');
        expect(code(await consentAccept(db, { gateOn: true, osUserId: 'intruder', subject: subjectOf(OTHER_SUBJECT), interviewId, noticeVersion: 1, noticeSha256: NOTICE_SHA256, now }))).toBe('repo_not_found');
        expect(await countEvents(interviewId)).toBe(0);
        const accepted = await consentAccept(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), interviewId, noticeVersion: 1, noticeSha256: NOTICE_SHA256, now });
        expect(accepted).toEqual({ status: 200, body: { accepted: true, state: 'consented' } });
        const evs = await eventRows(interviewId);
        expect(evs.map((e) => [e.seq, e.type])).toEqual([[1, 'consent.accepted']]);
        expect(evs[0]!.data).toMatchObject({ noticeVersion: 1, noticeSha256: NOTICE_SHA256 });
        expect((await rows(sql`SELECT state, os_user_id, ezil_id_subject, notice_sha256 FROM ezil_interviews WHERE interview_id = ${interviewId}::uuid`))[0])
            .toMatchObject({ state: 'consented', os_user_id: OS_USER, ezil_id_subject: OWNER, notice_sha256: NOTICE_SHA256 });
        // idempotent for the same bound candidate: still one consent.accepted.
        expect((await consentAccept(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), interviewId, noticeVersion: 1, noticeSha256: NOTICE_SHA256, now })).status).toBe(200);
        expect(await countEvents(interviewId)).toBe(1);
    });

    it('accept in started -> 409 interview_state', async () => {
        const { interviewId } = await mk('started');
        expect(code(await consentAccept(db, { gateOn: true, osUserId: OS_USER, subject: subjectOf(OWNER), interviewId, noticeVersion: 1, noticeSha256: NOTICE_SHA256, now }))).toBe('interview_state');
    });

    it('events: a validated batch writes same-at rows; a turn_end derives turn_start (seq n, n+1); a repeated requestId is dropped', async () => {
        const { interviewId } = await mk('started'); // consent.accepted (seq 1), interview.started (seq 2)
        const batch = await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now: () => '2026-11-22T09:06:40.000Z', events: [
            { type: 'tab.visibility', clientAt: '2026-11-22T09:06:39.512Z', data: { state: 'visible' } },
            { type: 'window.focus', clientAt: '2026-11-22T09:06:39.512Z', data: { focused: true } },
            { type: 'app.focus', clientAt: '2026-11-22T09:06:39.512Z', data: { app: 'code' } },
            { type: 'presence.idle', clientAt: '2026-11-22T09:06:39.512Z', data: { bucket: '<15s' } },
        ] });
        expect(batch).toEqual({ status: 202, body: { accepted: 4 } });
        const turnEnd = { type: 'agent.turn_end', clientAt: '2026-11-22T09:08:03.900Z', data: {
            requestId: '9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5', gatewayRequestId: 'e1d2c3b4-a5f6-4789-8a0b-1c2d3e4f5a6b',
            modelAlias: 'claude-sonnet', durationMs: 6000, outcome: 'completed', toolCalls: { read: 2, search: 1, write: 1, other: 0 } } };
        expect((await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now: () => '2026-11-22T09:08:04.000Z', events: [turnEnd] })))
            .toEqual({ status: 202, body: { accepted: 1 } });
        const evs = await eventRows(interviewId);
        expect(evs.map((e) => [Number(e.seq), e.type])).toEqual([
            [1, 'consent.accepted'], [2, 'interview.started'], [3, 'tab.visibility'], [4, 'window.focus'], [5, 'app.focus'],
            [6, 'presence.idle'], [7, 'agent.turn_start'], [8, 'agent.turn_end'],
        ]);
        const iso = (v: unknown) => new Date(v as string).toISOString();
        expect(evs.slice(2, 6).every((e) => iso(e.at) === '2026-11-22T09:06:40.000Z')).toBe(true);
        expect(iso(evs[6]!.at)).toBe('2026-11-22T09:07:58.000Z'); // turn_start.at = turn_end.at - 6000ms
        expect(evs[6]!.data).toEqual({ requestId: '9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5', derived: true });
        expect(iso(evs[7]!.at)).toBe('2026-11-22T09:08:04.000Z');
        // repeated requestId dropped: accepted 0, no new rows.
        expect(await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now: () => '2026-11-22T09:08:10.000Z', events: [turnEnd] })).toEqual({ status: 202, body: { accepted: 0 } });
        expect(await countEvents(interviewId)).toBe(8);
    });

    it('events: wrong user or wrong batch size/type is refused, nothing written', async () => {
        const { interviewId } = await mk('started');
        const before = await countEvents(interviewId);
        expect(code(await eventsBatch(db, { gateOn: true, osUserId: 'not-the-candidate', interviewId, now, events: [{ type: 'session.heartbeat', clientAt: '2026-11-22T09:06:40.000Z', data: {} }] }))).toBe('not_found');
        expect(code(await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now, events: [] }))).toBe('invalid_event');
        expect(code(await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now, events: Array.from({ length: 21 }, () => ({ type: 'session.heartbeat', clientAt: '2026-11-22T09:06:40.000Z', data: {} })) }))).toBe('invalid_event');
        expect(code(await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now, events: [{ type: 'interview.started', clientAt: '2026-11-22T09:06:40.000Z', data: {} }] }))).toBe('invalid_event');
        expect(await countEvents(interviewId)).toBe(before);
    });

    it('events: 120/min/user is enforced and the over-limit batch writes nothing', async () => {
        const { interviewId } = await mk('started');
        const hb = () => ({ type: 'session.heartbeat' as const, clientAt: '2026-11-22T09:06:40.000Z', data: {} });
        for (let i = 0; i < 6; i++) expect((await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now, events: Array.from({ length: 20 }, hb) })).status).toBe(202);
        const started = await countEvents(interviewId); // interview.started + 120 heartbeats
        const over = await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now, events: [hb()] });
        expect(over.status).toBe(429);
        expect(code(over)).toBe('rate_limited');
        expect(await countEvents(interviewId)).toBe(started);
    });

    it('openGateCases: every row, and computer.opened is written only on an allowed open', async () => {
        const gate = (url: string, who: { osUserId: string; ezilIdSubject: string | null }, purpose: 'open' | 'renew' = 'open') =>
            runInterviewOpenGate(db, { canonicalURL: url, osUserId: who.osUserId, ezilIdSubject: who.ezilIdSubject, computerId: 'cmp_8f2a1c', purpose }, () => '2026-11-22T09:06:30.000Z');
        const candidate = { osUserId: OS_USER, ezilIdSubject: OWNER };
        const stranger = { osUserId: 'another-os-user', ezilIdSubject: OTHER_SUBJECT };

        // gate off (no ai-staging funding in the test env): the public gate short-circuits to `none`, no DB.
        expect(await interviewOpenGate({ canonicalURL: 'https://git-qa.ezil.work/c/r.git', osUserId: OS_USER, ezilIdSubject: OWNER, computerId: 'cmp_x', purpose: 'open' })).toEqual({ kind: 'none' });
        // no interview for the URL -> none
        expect(await gate('https://git-qa.ezil.work/no/interview.git', candidate)).toEqual({ kind: 'none' });

        const reg = await mk('registered');
        expect(await gate(reg.url, candidate)).toEqual({ kind: 'refuse', status: 409, code: 'interview_not_started' });
        expect(await gate(reg.url, stranger)).toEqual({ kind: 'refuse', status: 404, code: 'repo_not_found' });

        const con = await mk('consented');
        expect(await gate(con.url, candidate)).toEqual({ kind: 'refuse', status: 409, code: 'interview_not_started' });

        const fin = await mk('finished');
        expect(await gate(fin.url, candidate)).toEqual({ kind: 'refuse', status: 409, code: 'interview_finished' });
        expect(await gate(fin.url, stranger)).toEqual({ kind: 'refuse', status: 404, code: 'repo_not_found' });

        const started = await mk('started');
        expect(await gate(started.url, candidate, 'renew')).toEqual({ kind: 'allow', interviewId: started.interviewId });
        expect(await countEvents(started.interviewId)).toBe(2); // consent.accepted + interview.started; renew writes nothing
        expect(await gate(started.url, candidate, 'open')).toEqual({ kind: 'allow', interviewId: started.interviewId });
        const evs = await eventRows(started.interviewId);
        expect(evs.map((e) => e.type)).toEqual(['consent.accepted', 'interview.started', 'computer.opened']);
        expect(evs[2]!.data).toEqual({ computerId: 'cmp_8f2a1c' });
    });

    it('A5: after finish, interview-events is 404 and the open gate is interview_finished', async () => {
        const { interviewId, url } = await mk('started');
        await adminFinish(db, { gateOn: true, authz: 'ok', interviewId, now });
        const before = await countEvents(interviewId);
        const r = await eventsBatch(db, { gateOn: true, osUserId: OS_USER, interviewId, now, events: [{ type: 'session.heartbeat', clientAt: '2026-11-22T09:06:40.000Z', data: {} }] });
        expect(r.status).toBe(404);
        expect(await countEvents(interviewId)).toBe(before);
        expect(await runInterviewOpenGate(db, { canonicalURL: url, osUserId: OS_USER, ezilIdSubject: OWNER, computerId: 'cmp_x', purpose: 'open' }, now))
            .toEqual({ kind: 'refuse', status: 409, code: 'interview_finished' });
    });

    it('admin register replay vs conflict; get exposes the identity tuple with osUserId null before consent', async () => {
        const interviewId = randomUUID();
        const body = { interviewId, repositoryId: '4211', canonicalURL: 'https://git-qa.ezil.work/cand-r/interview-r.git', handle: 'cand-r', ownerEzilIdSubject: OWNER, worksAccountId: '1187' };
        expect((await adminRegister(db, { gateOn: true, authz: 'ok', body })).status).toBe(201);
        expect((await adminRegister(db, { gateOn: true, authz: 'ok', body })).status).toBe(200); // replay
        expect(code(await adminRegister(db, { gateOn: true, authz: 'ok', body: { ...body, handle: 'different' } }))).toBe('conflict');
        const got = await adminGetJson(interviewId);
        expect(got).toMatchObject({ interviewId, state: 'registered', noticeSha256: null, identity: { osUserId: null, ezilIdSubject: OWNER, repositoryId: '4211' } });
    });

    it('admin start requires consented; admin events purges >30 days and returns seq order', async () => {
        const reg = await mk('registered');
        expect(code(await adminStart(db, { gateOn: true, authz: 'ok', interviewId: reg.interviewId, now }))).toBe('interview_state');
        const { interviewId } = await mk('started');
        // an old row (written while started) and a recent one; the admin read purges the old one first.
        await db.execute(sql`INSERT INTO ezil_interview_events (interview_id, seq, type, at, data) VALUES (${interviewId}::uuid, 50, 'session.heartbeat', now() - interval '31 days', '{}'::jsonb)`);
        await db.execute(sql`INSERT INTO ezil_interview_events (interview_id, seq, type, at, data) VALUES (${interviewId}::uuid, 51, 'session.heartbeat', now(), '{}'::jsonb)`);
        const events = await listEvents(db, interviewId);
        expect(events.every((e) => e.seq !== 50)).toBe(true); // purged
        expect(events.some((e) => e.seq === 51)).toBe(true);
        expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
        const read = await adminEvents(db, { gateOn: true, authz: 'ok', interviewId });
        expect(read.status).toBe(200);
        expect(read.body).toMatchObject({ v: 1, interviewId, identity: { osUserId: OS_USER } });
    });

    async function adminGetJson(interviewId: string) {
        const { adminGet } = await import('./service');
        return (await adminGet(db, { gateOn: true, authz: 'ok', interviewId })).body;
    }
});
