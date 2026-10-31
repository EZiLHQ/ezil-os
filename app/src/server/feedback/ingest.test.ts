import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { deleteFeedback, ingestFeedback, listFeedback, type FeedbackDb } from './ingest';
import { FEEDBACK_LIMITS, type FeedbackSubmit } from './types';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const OTHER = '550e8400-e29b-41d4-a716-446655440001';
const REQUEST = '550e8400-e29b-41d4-a716-446655440002';
const COMPUTER = '550e8400-e29b-41d4-a716-446655440003';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const input: FeedbackSubmit = { v: 1, clientRequestId: REQUEST, category: 'bug', description: 'The button is stuck.' };
type Row = Record<string, unknown>;
type Statement = { sql: string; params: unknown[] };

/** Real Drizzle SQL with a small committed-row model. Locks actually queue
 * concurrent callbacks here; this catches removing the lock even when a
 * sequential replay test would still pass (db/schema/feedback.ts:7). */
function database(options: { hour?: number; day?: number; attachmentDay?: number; attachmentTotal?: number; ownedComputer?: boolean; failAttachment?: boolean } = {}) {
    const statements: Statement[] = [];
    const reports: Row[] = [];
    const attachments: Row[] = [];
    const configs: unknown[] = [];
    const locks = new Map<string, Promise<void>>();
    function proxyFor(releases: (() => void)[]) {
        return drizzle(async (sql, params) => {
            statements.push({ sql, params });
            if (sql.includes('pg_advisory_xact_lock')) {
                const key = JSON.stringify(params);
                const previous = locks.get(key) ?? Promise.resolve();
                let release!: () => void;
                const next = new Promise<void>((resolve) => { release = resolve; });
                locks.set(key, previous.then(() => next));
                await previous;
                releases.push(release);
                return { rows: [] };
            }
            if (sql.startsWith('insert')) {
                const columns = sql.match(/\(([^)]+)\) values/)![1]!.split(',').map((c) => c.trim().replaceAll('"', ''));
                const row = Object.fromEntries(columns.map((c, i) => [c, params[i]]));
                if (sql.includes('ezil_feedback_attachments')) {
                    if (options.failAttachment) throw new Error('attachment write failed');
                    attachments.push(row);
                } else reports.push(row);
                return { rows: [] };
            }
            if (sql.includes('count(*)')) return { rows: [[options.hour ?? reports.filter((r) => r.user_id === params[1]).length, options.day ?? reports.filter((r) => r.user_id === params[1]).length]] };
            if (sql.includes('sum(')) return { rows: [[options.attachmentDay ?? attachments.reduce((n, r) => n + Number(r.byte_length), 0), options.attachmentTotal ?? attachments.reduce((n, r) => n + Number(r.byte_length), 0)]] };
            if (sql.includes('"computers"')) return { rows: options.ownedComputer ? [[COMPUTER]] : [] };
            if (sql.startsWith('delete')) {
                const rows = sql.includes('ezil_feedback_attachments') ? attachments : reports;
                const idField = rows === attachments ? 'report_id' : 'id';
                const deleted = rows.filter((r) => r[idField] === params[0] && r.user_id === params[1]);
                for (const row of deleted) rows.splice(rows.indexOf(row), 1);
                return { rows: deleted.map((r) => [r.id]) };
            }
            if (sql.includes('"client_request_id"')) return { rows: reports.filter((r) => r.user_id === params[0] && r.client_request_id === params[1]).map((r) => [r.id, r.created_at, r.has_screenshot]) };
            if (sql.includes('order by')) return { rows: reports.filter((r) => r.user_id === params[0]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, Number(params[1])).map((r) => [r.id, r.created_at, r.category, r.description, r.has_screenshot, r.status]) };
            return { rows: reports.filter((r) => r.id === params[0] && r.user_id === params[1]).map((r) => [r.id]) };
        }, { schema });
    }
    const readDb = proxyFor([]);
    const db = {
        select: readDb.select.bind(readDb),
        transaction: async (cb: (tx: ReturnType<typeof proxyFor>) => Promise<unknown>, config: unknown) => {
            configs.push(config);
            const releases: (() => void)[] = [];
            const reportStart = reports.length;
            const attachmentStart = attachments.length;
            try { return await cb(proxyFor(releases)); }
            catch (error) { reports.splice(reportStart); attachments.splice(attachmentStart); throw error; }
            finally { for (const release of releases.reverse()) release(); }
        },
    } as unknown as FeedbackDb;
    return { db, statements, reports, attachments, configs };
}

function screenshot() {
    return { contentType: 'image/png' as const, dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==' };
}

describe('feedback ingest SQL and persisted values', () => {
    it('inserts server-generated identity, timestamps, status and sanitized data', async () => {
        const { db, reports } = database();
        const result = await ingestFeedback(db, USER, { ...input, description: `alice@example.com ${['AKIA', '1234567890ABCDEF'].join('')}`, diagnostics: { shellVersion: 'bob@example.com', appCommit: 'eyJabc.def.ghi' } }, NOW);
        expect(result.status).toBe(201);
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
            id: expect.stringMatching(/^[0-9a-f-]{14}4[0-9a-f-]{21}$/), user_id: USER, computer_id: null,
            created_at: NOW.toISOString(), category: 'bug', status: 'new', client_request_id: REQUEST,
            description: 'alice@example.com [redacted:aws-key]', redaction_count: 1, has_screenshot: false,
            shell_version: '[redacted:email]', deploy_sha: null,
        });
        expect(JSON.parse(String(reports[0]!.diagnostics))).toEqual({ shellVersion: '[redacted:email]', appCommit: '[redacted:jwt]' });
    });

    it('FEEDBACK-DIAG: persists validated failure annotations and logs only the report id with them, after commit', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const corr = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
        const { db, reports } = database({ ownedComputer: true });
        const result = await ingestFeedback(db, USER, { ...input, computerId: COMPUTER, diagnostics: { recentEvents: [
            { eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'unauthorized',
                reason: 'worker_http_401:hmac_signature_mismatch', correlationId: corr },
            // The reporter's own ids are never accepted as correlation ids.
            { eventClass: 'api_failure', site: 's', code: 'c', reason: 'worker_http_502', correlationId: USER },
            { eventClass: 'api_failure', site: 's', code: 'c', correlationId: COMPUTER.toUpperCase() },
            { eventClass: 'api_failure', site: 's', code: 'c', reason: 'https://x.test/?token=abc' },
        ] } }, NOW);
        expect(result.status).toBe(201);
        expect(JSON.parse(String(reports[0]!.diagnostics)).recentEvents).toEqual([
            { eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'unauthorized',
                reason: 'worker_http_401:hmac_signature_mismatch', correlationId: corr },
            { eventClass: 'api_failure', site: 's', code: 'c', reason: 'worker_http_502' },
            { eventClass: 'api_failure', site: 's', code: 'c' },
            { eventClass: 'api_failure', site: 's', code: 'c' },
        ]);
        expect(info).toHaveBeenCalledExactlyOnceWith('[feedback] report carries server failures', {
            reportId: result.status === 201 ? result.created.id : '',
            failures: [{ correlationId: corr, reason: 'worker_http_401:hmac_signature_mismatch' }, { reason: 'worker_http_502' }],
        });
        const logged = JSON.stringify(info.mock.calls);
        expect(logged).not.toContain(USER);
        expect(logged).not.toContain('button');
        info.mockClear();
        // A replay is not a new report: nothing new is logged.
        await ingestFeedback(db, USER, { ...input, computerId: COMPUTER }, NOW);
        expect(info).not.toHaveBeenCalled();
        info.mockRestore();
    });

    it('stores the server-stamped deploy SHA on the report row', async () => {
        const { db, reports } = database();
        await ingestFeedback(db, USER, input, NOW, '46698745a1b2c3d4e5f60718293a4b5c6d7e8f90');
        expect(reports[0]).toMatchObject({ deploy_sha: '46698745a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    });

    it.each([false, true])('retains a computer only when owner/nondeleted lookup succeeds: %s', async (ownedComputer) => {
        const { db, reports, statements } = database({ ownedComputer });
        await ingestFeedback(db, USER, { ...input, computerId: COMPUTER }, NOW);
        expect(reports[0]!.computer_id).toBe(ownedComputer ? COMPUTER : null);
        const query = statements.find((s) => s.sql.includes('"computers"'))!;
        expect(query.sql).toMatch(/"id" = \$1 and .*"user_id" = \$2 and .*"deleted_at" is null/);
        expect(query.params.slice(0, 2)).toEqual([COMPUTER, USER]);
    });

    it('serializes concurrent replays before checking DB quota and creates only one report', async () => {
        const { db, reports, statements, configs } = database({ hour: 9 });
        const results = await Promise.all([ingestFeedback(db, USER, input, NOW), ingestFeedback(db, USER, input, NOW)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
        expect(reports).toHaveLength(1);
        expect(results.map((result) => 'created' in result ? result.created : null)).toEqual([
            { id: reports[0]!.id, createdAt: NOW.toISOString(), screenshotAccepted: false },
            { id: reports[0]!.id, createdAt: NOW.toISOString(), screenshotAccepted: false },
        ]);
        expect(statements[0]!.sql).toContain('pg_advisory_xact_lock');
        expect(statements[0]!.sql).toContain('::uuid::text');
        expect(statements.filter((s) => s.sql.includes('count(*)'))).toHaveLength(1);
        expect(configs).toEqual([{ isolationLevel: 'read committed' }, { isolationLevel: 'read committed' }]);
        const replay = statements.find((s) => s.sql.includes('"client_request_id"') && s.sql.startsWith('select'))!;
        expect(replay.sql).toMatch(/where \("ezil_feedback_reports"\."user_id" = \$1 and "ezil_feedback_reports"\."client_request_id" = \$2\)/);
        expect(replay.params.slice(0, 2)).toEqual([USER, REQUEST]);
    });

    it('replays an original result even after later writes reach the rate limit', async () => {
        const state = database();
        const first = await ingestFeedback(state.db, USER, input, NOW);
        for (let i = 1; i < 10; i++) state.reports.push({ ...state.reports[0], client_request_id: `other-${i}` });
        expect(await ingestFeedback(state.db, USER, input, new Date(NOW.getTime() + 1000))).toEqual({ ...first, status: 200 });
    });

    it('does not confuse two users sharing a client request id', async () => {
        const { db, reports } = database();
        expect((await ingestFeedback(db, USER, input, NOW)).status).toBe(201);
        expect((await ingestFeedback(db, OTHER, input, NOW)).status).toBe(201);
        expect(reports).toHaveLength(2);
    });

    it.each([{ hour: 10 }, { day: 30 }])('writes nothing when counts hit %j', async (options) => {
        const { db, reports, statements } = database(options);
        expect(await ingestFeedback(db, USER, input, NOW)).toEqual({ status: 429 });
        expect(reports).toHaveLength(0);
        expect(statements.some((s) => s.sql.startsWith('insert'))).toBe(false);
    });

    it('serializes concurrent new submissions at the hourly boundary', async () => {
        const state = database();
        for (let i = 0; i < 9; i++) state.reports.push({ user_id: USER, client_request_id: `old-${i}` });
        const results = await Promise.all([
            ingestFeedback(state.db, USER, input, NOW),
            ingestFeedback(state.db, USER, { ...input, clientRequestId: COMPUTER }, NOW),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 429]);
        expect(state.reports).toHaveLength(10);
    });

    it('stores attachment bytes and hash atomically with the report', async () => {
        const { db, reports, attachments, statements } = database();
        const result = await ingestFeedback(db, USER, { ...input, screenshot: screenshot() }, NOW);
        expect(result).toMatchObject({ status: 201, created: { screenshotAccepted: true } });
        expect(reports[0]!.has_screenshot).toBe(true);
        expect(attachments[0]).toMatchObject({ report_id: reports[0]!.id, user_id: USER, content_type: 'image/png', byte_length: Buffer.from(screenshot().dataBase64, 'base64').length, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(attachments[0]!.bytes).toEqual(Buffer.from(screenshot().dataBase64, 'base64'));
        const budgetIndex = statements.findIndex((s) => s.sql.includes('sum('));
        expect(statements[budgetIndex - 1]!.sql).toContain('pg_advisory_xact_lock');
        expect(statements[budgetIndex - 1]!.params[0]).not.toBe(statements[0]!.params[0]);
        const inserts = statements.filter((s) => s.sql.startsWith('insert'));
        expect(inserts[0]!.sql).toContain('ezil_feedback_reports');
        expect(inserts[1]!.sql).toContain('ezil_feedback_attachments');
    });

    it.each([{ attachmentDay: FEEDBACK_LIMITS.globalAttachmentBytesPerDay }, { attachmentTotal: FEEDBACK_LIMITS.globalAttachmentBytesTotal }])('stores text without screenshot when budget is exhausted: %j', async (options) => {
        const { db, reports, attachments } = database(options);
        const result = await ingestFeedback(db, USER, { ...input, screenshot: screenshot() }, NOW);
        expect(result).toMatchObject({ status: 201, created: { screenshotAccepted: false } });
        expect(reports[0]!.has_screenshot).toBe(false);
        expect(attachments).toEqual([]);
    });

    it('serializes global budget checks across different users', async () => {
        const state = database();
        const byteLength = Buffer.from(screenshot().dataBase64, 'base64').length;
        state.attachments.push({ byte_length: FEEDBACK_LIMITS.globalAttachmentBytesPerDay - byteLength });
        const results = await Promise.all([
            ingestFeedback(state.db, USER, { ...input, screenshot: screenshot() }, NOW),
            ingestFeedback(state.db, OTHER, { ...input, screenshot: screenshot() }, NOW),
        ]);
        expect(results.map((r) => 'created' in r && r.created.screenshotAccepted).sort()).toEqual([false, true]);
        expect(state.reports).toHaveLength(2);
        expect(state.attachments).toHaveLength(2);
    });

    it('aborts the transaction when the attachment insert fails', async () => {
        const { db, reports, attachments } = database({ failAttachment: true });
        await expect(ingestFeedback(db, USER, { ...input, screenshot: screenshot() }, NOW)).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'attachment write failed' }) });
        expect(reports).toEqual([]); expect(attachments).toEqual([]);
    });
});

describe('owner-scoped report listing and deletion', () => {
    it('keeps summaries inside the wire category enum for unconstrained legacy rows', async () => {
        const { db, reports } = database();
        reports.push({ id: COMPUTER, user_id: USER, created_at: NOW.toISOString(), category: 'legacy', description: 'Example', has_screenshot: false, status: 'new' });
        expect((await listFeedback(db, USER))[0]!.category).toBe('other');
    });

    it('lists newest first, limits to 50, and caps previews at 140 characters', async () => {
        const { db, reports, statements } = database();
        for (let i = 0; i < 55; i++) reports.push({ id: String(i), user_id: USER, created_at: new Date(NOW.getTime() + i * 1000).toISOString(), category: 'bug', description: 'a'.repeat(200), has_screenshot: false, status: 'new' });
        reports.push({ id: 'foreign', user_id: OTHER, created_at: NOW.toISOString() });
        const result = await listFeedback(db, USER);
        expect(result).toHaveLength(50);
        expect(result[0]).toEqual({ id: '54', createdAt: new Date(NOW.getTime() + 54000).toISOString(), category: 'bug', descriptionPreview: 'a'.repeat(140), hasScreenshot: false, status: 'new' });
        expect(result.some((r) => r.id === 'foreign')).toBe(false);
        expect(statements[0]!.sql).toMatch(/where "ezil_feedback_reports"\."user_id" = \$1 order by .*"created_at" desc.* limit \$2/);
        expect(statements[0]!.params).toEqual([USER, 50]);
    });

    it('returns not found for another user and never deletes their attachment', async () => {
        const { db, reports, attachments, statements } = database();
        reports.push({ id: COMPUTER, user_id: OTHER }); attachments.push({ report_id: COMPUTER, user_id: OTHER });
        expect(await deleteFeedback(db, USER, COMPUTER)).toBe(false);
        expect(reports).toHaveLength(1); expect(attachments).toHaveLength(1);
        expect(statements.some((s) => s.sql.startsWith('delete'))).toBe(false);
        expect(statements[1]!.sql).toMatch(/"id" = \$1 and "ezil_feedback_reports"\."user_id" = \$2/);
    });

    it('deletes the caller attachment before their report with both owner filters', async () => {
        const { db, reports, attachments, statements } = database();
        reports.push({ id: COMPUTER, user_id: USER }); attachments.push({ report_id: COMPUTER, user_id: USER });
        attachments.push({ report_id: COMPUTER, user_id: OTHER });
        expect(await deleteFeedback(db, USER, COMPUTER)).toBe(true);
        expect(reports).toEqual([]); expect(attachments).toEqual([{ report_id: COMPUTER, user_id: OTHER }]);
        const deletes = statements.filter((s) => s.sql.startsWith('delete'));
        expect(deletes[0]!.sql).toContain('delete from "ezil_feedback_attachments"');
        expect(deletes[1]!.sql).toContain('delete from "ezil_feedback_reports"');
        for (const statement of deletes) {
            expect(statement.sql).toMatch(/where \(.*(?:"report_id"|"id") = \$1 and .*"user_id" = \$2\)/);
            expect(statement.params).toEqual([COMPUTER, USER]);
        }
    });
});
