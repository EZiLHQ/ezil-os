/**
 * App-error coverage, end to end. A REAL router refusal (`cloudflareGuacamole.previewUrl`, AWS `user_has_aws_computer`)
 * goes through the shell's REAL parser (`session.openDesktop`), REAL `telemetry.capture` and REAL feedback diagnostics
 * builder, then the server's REAL submit schema and sanitizer. With EZIL_PG_TEST_URL it continues through the
 * REAL ingest on disposable PostgreSQL and the REAL admin read. The correlation id and reason must arrive unchanged
 * and equal to the server's own log line, so a stored report joins the refusal in the logs.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initTRPC } from '@trpc/server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';

const mocks = vi.hoisted(() => ({ route: vi.fn(), ensure: vi.fn(), preview: vi.fn(), prepare: vi.fn() }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure };
});
vi.mock('@/server/api/routers/compute-dispatch', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), routeComputer: mocks.route,
}));
vi.mock('@/server/api/routers/computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ config: { enforcementEnabled: false, tabEnabled: false }, now: () => new Date() }) }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: vi.fn(async () => {}) }));
vi.mock('@/server/lib/compute/aws-clients', () => ({
    sharedAwsSdkCollaborators: () => { throw new Error('Unexpected AWS client construction'); },
}));
vi.mock('@/server/lib/compute/aws-preview', async original => ({
    ...await original<Record<string, unknown>>(), requestAwsPreview: mocks.preview, prepareAwsPoolSession: mocks.prepare,
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, hasHmacSecret: true }),
}));

import { cloudflareGuacamoleRouter } from '@/server/api/routers/cloudflare-guacamole';
import { feedbackAdminQueries } from './admin-queries';
import { ingestFeedback, type FeedbackDb } from './ingest';
import { sanitizeDiagnostics } from './redact';
import { feedbackSubmitSchema } from './types';

const PG = process.env.EZIL_PG_TEST_URL;
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const shell = path.resolve(__dirname, '../../../../shell/ezil');

/** The few browser globals the shell modules read; a stand-in for the page, not for any behaviour under test. */
function page() {
    const boot = { computer: { id: computerId }, user: { id: userId },
        desktopState: { endpoints: {}, ui: { feedbackEventDiagnostics: true } } };
    vi.stubGlobal('window', { __EZIL_BOOT__: boot, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
    vi.stubGlobal('document', { body: { classList: { contains: () => false } }, querySelectorAll: () => [], visibilityState: 'visible',
        fullscreenElement: null });
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/149.0.0.0 Safari/537.36', onLine: true });
}

async function refusalThroughTheShell() {
    mocks.route.mockResolvedValue({ kind: 'aws-ec2', provider: { ensure: mocks.ensure }, instanceType: 't3a.medium' });
    mocks.prepare.mockResolvedValue(undefined);
    // The canary case: a hidden reservation on the person's other computer refuses this one.
    mocks.ensure.mockResolvedValue({ ok: false, error: 'user_has_aws_computer', errorCode: 'user_has_aws_computer', retryable: false });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: userId },
        db: { query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never);
    page();
    const answers: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
        if (!String(url).includes('/desktop')) throw new Error(`unexpected request ${url}`);
        const answer = await caller.previewUrl({ computerId, sessionId: computerId });
        answers.push(answer);
        // `/api/shell/desktop` is a transport: `shellJson(preview)`.
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const session = await import(`${shell}/session.js`) as { openDesktop(id: string): Promise<Record<string, unknown>> };
    const telemetry = (await import(`${shell}/telemetry.js`)).default as { capture(input: object): void };
    const { build_diagnostics } = await import(`${shell}/ui/feedback/diagnostics.js`) as { build_diagnostics(): Record<string, unknown> };
    const res = await session.openDesktop(computerId);
    // Exactly the desktop window's terminal #mint capture (`apps/desktop-window.js`).
    telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: res.errorCode,
        reason: res.reason, serverCorrelationId: res.serverCorrelationId });
    const diagnostics = build_diagnostics();
    const logged = info.mock.calls.map(c => String(c[0])).filter(l => l.includes('"event":"aws-preview"')).map(l => JSON.parse(l) as Record<string, unknown>);
    return { res, diagnostics, logged, answers, info };
}

describe('a real router refusal reaches a consented feedback report unchanged', () => {
    it('router → shell parser → telemetry → diagnostics → submit schema and sanitizer', { timeout: 15_000 }, async () => {
        const { res, diagnostics, logged, answers } = await refusalThroughTheShell();
        // The shell retries one unknown-to-it refusal once; every ask has its own id, and the last one is reported.
        expect(logged.length).toBe(answers.length);
        const last = logged.at(-1)!;
        expect(last).toMatchObject({ surface: 'desktop', reason: 'user_has_aws_computer' });
        expect(res).toMatchObject({ ok: false, errorCode: 'user_has_aws_computer', reason: 'user_has_aws_computer', serverCorrelationId: last.correlationId });
        const event = (diagnostics.recentEvents as Record<string, unknown>[]).findLast(e => e.site === 'ezil-os:apps/desktop#mint');
        expect(event).toEqual({ eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: 'user_has_aws_computer',
            reason: 'user_has_aws_computer', correlationId: last.correlationId });
        const body = JSON.parse(JSON.stringify({ v: 1, clientRequestId: randomUUID(), category: 'bug',
            description: '[synthetic app-error] seam', computerId, diagnostics }));
        const parsed = feedbackSubmitSchema.parse(body);
        const stored = sanitizeDiagnostics(parsed.diagnostics, { excludeIds: [userId, computerId] });
        expect((stored!.recentEvents as Record<string, unknown>[]).findLast(e => e.site === 'ezil-os:apps/desktop#mint'))
            .toEqual(event);
    });

    describe.skipIf(!PG)('…and through ingest and the admin read on PostgreSQL', () => {
        const name = `fbseam_${randomUUID().replaceAll('-', '')}`;
        const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
        const client = PG ? postgres(PG, { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
        afterAll(async () => {
            await admin?.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
            await client?.end(); await admin?.end();
        });
        it('stores, logs and shows the same id and reason; the server context is separate', { timeout: 20_000 }, async () => {
            await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
                DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
            await admin!.unsafe(`CREATE SCHEMA ${name}`);
            const sql = readFileSync(path.resolve(__dirname, '../../../drizzle/0011_feedback.sql'), 'utf8');
            await admin!.begin((tx) => tx.unsafe(sql.replaceAll('public.', `${name}.`)));
            await admin!.unsafe(`CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz)`);
            await admin!.unsafe(`INSERT INTO ${name}.ezil_computers (id, user_id) VALUES ($1, $2)`, [computerId, userId]);
            const db = drizzle(client!, { schema }) as unknown as FeedbackDb;

            const { diagnostics, logged, info } = await refusalThroughTheShell();
            const last = logged.at(-1)!;
            const body = feedbackSubmitSchema.parse(JSON.parse(JSON.stringify({ v: 1, clientRequestId: randomUUID(), category: 'bug',
                description: '[synthetic app-error] seam', computerId, diagnostics })));
            const created = await ingestFeedback(db, userId, body, new Date());
            expect(created.status).toBe(201);
            if (created.status !== 201) throw new Error(`unexpected ${created.status}`);
            // The post-commit log names the report beside the server's own id and reason: the join.
            const feedbackLog = info.mock.calls.find(c => c[0] === '[feedback] report carries server failures');
            expect(JSON.stringify(feedbackLog?.[1])).toContain(String(last.correlationId));
            const report = await feedbackAdminQueries(db as unknown as Parameters<typeof feedbackAdminQueries>[0]).findReport(created.created.id);
            expect(report!.diagnostics).toEqual(sanitizeDiagnostics(body.diagnostics, { excludeIds: [userId, computerId] }));
            expect((report!.diagnostics as { recentEvents: Record<string, unknown>[] }).recentEvents
                .findLast(e => e.site === 'ezil-os:apps/desktop#mint')).toMatchObject({ reason: 'user_has_aws_computer', correlationId: last.correlationId });
            // Compute tables are absent in this schema: the report is stored, the context says so, separately.
            expect(report!.serverContext).toMatchObject({ outcome: 'unavailable' });
        });
    });
});
