import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { requestRepoOpen } from '@/server/lib/compute/repo-open';
import { resetRateLimitForTests } from '@/server/telemetry/rate-limit';
import { setLoadShedCacheForTests } from '@/server/telemetry/load-shed';
import { safeUserHash } from '@/server/telemetry/sanitize';
import { repoOpenFailureDiagnostic, repoOpenFailureResponse } from './repo-open-failure';
import { feedbackSubmitSchema } from './types';
import { sanitizeDiagnostics } from './redact';
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: vi.fn() }));
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'NEVER_EXPORT_THIS_NATIVE_CREDENTIAL';

function db() {
    const statements: { sql: string; params: unknown[] }[] = [];
    const proxy = drizzle(async (sql, params) => { statements.push({ sql, params }); return { rows: [] }; }, { schema });
    return { statements, value: { execute: proxy.execute.bind(proxy),
        transaction: async (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy) } as unknown as Parameters<typeof repoOpenFailureResponse>[0] };
}
beforeEach(() => { resetRateLimitForTests(); setLoadShedCacheForTests(0); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());

describe('repository failure evidence', () => {
    it('preserves a closed Worker cause and app request id in feedback and the existing durable event insert', async () => {
        const failure = await requestRepoOpen('https://worker.test', 'secret', { sandboxName: 'guac-a-b', auth: { kind: 'v1' } },
            { userId: USER, computerId: COMPUTER }, { repositoryId: REQUEST, canonicalURL: 'https://github.ezil.work/default/test.git',
                ref: 'refs/heads/main', git: { token: TOKEN, expiresAt: new Date(Date.now() + 250_000).toISOString() }, timeoutMs: 60_000 },
            { correlationId: REQUEST, fetch: (async () => Response.json({ ok: false, error: 'repo_open_failed', diagnosticReason: 'clone_failed',
                ignored: TOKEN }, { status: 502 })) as typeof fetch });
        expect(failure).toMatchObject({ ok: false, errorCode: 'repo_open_failed',
            refusalReason: 'repo_open:worker_http_502:clone_failed', correlationId: REQUEST });
        if (failure.ok) throw new Error('expected failure');
        const store = db(), pending: (() => Promise<void>)[] = [];
        const response = repoOpenFailureResponse(store.value, USER, COMPUTER, failure, 'Could not open the repository.', w => pending.push(w));
        const answer = await response.json();
        expect(answer).toEqual({ error: { code: 'repo_open_failed', message: 'Could not open the repository.' },
            refusalReason: failure.refusalReason, correlationId: REQUEST });
        expect(store.statements).toEqual([]); // persistence is after the product response
        await pending[0]!();
        const inserted = store.statements.find(s => s.sql.startsWith('insert into "ezil_error_events"'))!;
        expect(inserted.params).toContain(failure.refusalReason);
        expect(inserted.params).toContain(REQUEST);
        expect(inserted.params).toContain(safeUserHash(USER));
        expect(inserted.params).not.toContain(USER);
        expect(JSON.stringify(store.statements)).not.toContain(TOKEN);
        // A consented report has the same durable request reference after app/log restart.
        const report = feedbackSubmitSchema.parse({ v: 1, clientRequestId: randomUUID(), category: 'bug', description: '',
            computerId: COMPUTER, diagnostics: { recentEvents: [{ eventClass: 'api_failure', site: 'ezil-os:apps/code#project',
                code: 'repo_open_failed', reason: answer.refusalReason, correlationId: answer.correlationId }] } });
        expect(sanitizeDiagnostics(report.diagnostics)!.recentEvents![0]).toMatchObject({ reason: failure.refusalReason, correlationId: REQUEST });
    });
    it.each(['bootstrap_unavailable', 'supervisor_unavailable', 'workspace_unavailable', 'workspace_not_ready', 'folder_conflict',
        'checkout_busy', 'invalid_request', 'repository_not_authorized', 'ref_mismatch', 'clone_failed', 'cleanup_unconfirmed',
        'token_expired', 'runtime_not_running', 'invalid_result', 'admission_rejected', 'admission_invalid', 'admission_stopping',
        'status_unavailable', 'status_invalid', 'transport_unavailable', 'budget_exhausted'])('accepts the closed host stage %s', reason => {
        expect(repoOpenFailureDiagnostic({ refusalReason: `repo_open:worker_http_502:${reason}`, correlationId: REQUEST }))
            .toEqual({ refusalReason: `repo_open:worker_http_502:${reason}`, correlationId: REQUEST, httpStatus: 502 });
    });
    it('drops arbitrary provider and caller strings rather than persisting token-shaped codes', () => {
        const d = repoOpenFailureDiagnostic({ refusalReason: 'repo_open:transport:private_secret', correlationId: TOKEN, httpStatus: 999 });
        expect(d).toEqual({ refusalReason: 'repo_open:transport:other', correlationId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    });
    it('keeps the same plain failure response when scheduling or database writes fail', async () => {
        const first = repoOpenFailureResponse(db().value, USER, COMPUTER, {}, 'Not working.', () => { throw new Error(TOKEN); });
        expect(first.status).toBe(502);
        const pending: (() => Promise<void>)[] = [];
        const broken = { execute: vi.fn(), transaction: async () => { throw new Error(TOKEN); } } as unknown as Parameters<typeof repoOpenFailureResponse>[0];
        const response = repoOpenFailureResponse(broken, USER, COMPUTER, {}, 'Not working.', w => pending.push(w));
        await pending[0]!();
        expect((await response.json()).error).toEqual({ code: 'repo_open_failed', message: 'Not working.' });
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(TOKEN);
    });
    it('honors the existing telemetry row breaker', async () => {
        setLoadShedCacheForTests(2_000_001); const store = db(), pending: (() => Promise<void>)[] = [];
        repoOpenFailureResponse(store.value, USER, COMPUTER, {}, 'Not working.', w => pending.push(w));
        await pending[0]!(); expect(store.statements).toEqual([]);
    });
});
