/**
 * Disposable PostgreSQL only (EZIL_PG_TEST_URL, an owned fixture): terminal AI failures from the real telemetry
 * route handler to a provider-accepted incident alert.
 *
 * Covered: `handleTelemetryPost` (authenticated context and `after()` scheduling injected), the real `ingestBatch`
 * against the full actual `0001_telemetry.sql` and `0024_telemetry_alerts.sql` (schema names rewritten into one
 * isolated schema), the real `drainIncidentAlerts`, and the real `incidentAlertMailer` up to its provider HTTP call
 * (a recorded fake `fetch`; no SMTP, mail, network, key or hosted database). The shell publisher chain is also
 * covered as real source modules: `create_app_failure_store` (iframe source, origin, nonce, exact keys, closed record)
 * feeding the real `telemetry.capture`/`flushNow` wire bytes into the handler, including its forged-frame and
 * cancelled/recovered/credits/read-heavy refusals, which the server itself does not filter.
 *
 * NOT covered (separate post-deploy UI QA): the bundled, installed browser artifact in a real browser with a real
 * cross-origin Code frame. Provider acceptance is not inbox delivery, and delivery is at least once.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as schema from '@/server/db/schema';
import { fingerprint } from './fingerprint';
import { handleTelemetryPost, type TelemetryRequestContext } from './http-handler';
import { incidentAlertMailer } from './incident-alert-mail';
import { drainIncidentAlerts, MILESTONE_SITE, type IncidentDb } from './incident-alerts';
import { safeUserHash } from './sanitize';
import { TERMINAL_AI_CODES } from './types';

const PG = process.env.EZIL_PG_TEST_URL;
// The dedicated CI step (and the gated local run) sets this marker: there, a missing database is a failure, never a
// silent skip. The generic App vitest phase does not set it, so this opt-in suite still skips there.
if (process.env.EZIL_ALERT_CHAIN_REQUIRED === '1' && (!PG || process.env.EZIL_PG_TEST_DISPOSABLE !== '1')) {
    throw new Error('EZIL_ALERT_CHAIN_REQUIRED=1 needs EZIL_PG_TEST_URL and EZIL_PG_TEST_DISPOSABLE=1; refusing to skip the terminal alert chain');
}
if (PG) {
    const url = new URL(PG);
    if (process.env.EZIL_PG_TEST_DISPOSABLE !== '1' || !['postgres:', 'postgresql:'].includes(url.protocol)
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.pathname !== '/ezil_alerts_test' || url.search || url.hash) {
        throw new Error('Incident PG tests require explicit disposable opt-in and loopback /ezil_alerts_test without URL options');
    }
}

const AI_SITE = 'ezil-os:apps/code#aiRequest';
const FIXTURE_KEY = 'fixture-provider-key-never-real';
type Event = { eventId?: string; eventClass?: string; source?: string; site?: string; code: string; outcome?: string; extra?: Record<string, unknown> };
const body = (events: Event[]) => JSON.stringify({ schemaVersion: 1, events: events.map(e => ({
    eventId: e.eventId ?? randomUUID(), schemaVersion: 1, eventClass: e.eventClass ?? 'api_failure', source: e.source ?? 'shell',
    occurredAt: new Date().toISOString(), site: e.site ?? AI_SITE, code: e.code, outcome: e.outcome ?? 'error', ...e.extra,
})) });

describe.skipIf(!PG)('terminal AI failure telemetry to incident alert on PostgreSQL', () => {
    const name = `terminal_alerts_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const db = client ? drizzle(client, { schema }) : null!;
    const contextDb = db as unknown as TelemetryRequestContext['db'];
    const incidentDb = db as unknown as IncidentDb;
    let created = false;

    beforeAll(async () => {
        // Disposable fixtures only so the REAL migrations parse: roles, an auth.role() for the RLS policies, and the
        // FK target of ezil_error_events.computer_id. No telemetry table is substituted.
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            CREATE SCHEMA IF NOT EXISTS auth;
            DO $$ BEGIN IF to_regprocedure('auth.role()') IS NULL THEN
                CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS 'SELECT current_user::text'; END IF; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${name}`); created = true;
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY)`);
        const isolate = (sql: string) => sql.replaceAll('"public".', `"${name}".`).replaceAll('public.', `${name}.`);
        for (const file of ['0001_telemetry.sql', '0024_telemetry_alerts.sql']) {
            const migration = isolate(readFileSync(new URL(`../../../drizzle/${file}`, import.meta.url), 'utf8'));
            await admin!.begin(tx => tx.unsafe(`SET LOCAL search_path TO ${name}; ${migration}`));
        }
    });
    afterAll(async () => {
        if (created) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await client?.end(); await admin?.end();
    });

    let ingestErrors: MockInstance<typeof console.error>;
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ezil_error_user_hours, ezil_error_events, ezil_error_fingerprints,
            ezil_telemetry_alerts, ezil_telemetry_alert_health`);
        ingestErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
        return () => ingestErrors.mockRestore();
    });

    /** POST through the real handler; the scheduled ingest runs to completion before returning. */
    async function post(user: string | null, raw: string) {
        const scheduled: Array<() => void | Promise<void>> = [];
        const response = await handleTelemetryPost(
            new Request('http://localhost/api/shell/telemetry', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw }),
            { getContext: async () => ({ user: user ? { id: user } : null, db: contextDb }), schedule: work => { scheduled.push(work); } },
        );
        expect(response.status).toBe(202);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe('');
        for (const work of scheduled) await work();
        return scheduled.length;
    }
    const count = async (sql: string, args: unknown[] = []) => Number((await client!.unsafe(sql, args as never[]))[0]!.n);
    function provider(statuses: number[] = []) {
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init: init! });
            const status = statuses[calls.length - 1] ?? 200;
            return status === 200
                ? new Response(JSON.stringify({ data: { succeeded: 1, failed: 0, email_id: `provider-${calls.length}` } }), { status })
                : new Response('{}', { status });
        }) as unknown as typeof fetch;
        return { calls, mailer: incidentAlertMailer(FIXTURE_KEY, fetcher)! };
    }
    const noIngestFailure = () => expect(ingestErrors).not.toHaveBeenCalledWith('[telemetry] ingest failed', expect.anything());

    it('every terminal AI code from one signed-in user becomes one server-attributed, provider-accepted alert', async () => {
        expect(TERMINAL_AI_CODES).toHaveLength(9);
        const expected = new Map<string, { code: string; userHash: string }>();
        for (const code of TERMINAL_AI_CODES) {
            const user = `qa-terminal-${code}`;
            expect(await post(user, body([{ code }]))).toBe(1);
            expected.set(fingerprint({ eventClass: 'api_failure', source: 'shell', site: AI_SITE, code }), { code, userHash: safeUserHash(user) });
        }
        noIngestFailure();
        for (const [fp, { userHash }] of expected) {
            expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE fingerprint = $1 AND user_hash = $2', [fp, userHash])).toBe(1);
            expect(await count('SELECT count(*) AS n FROM ezil_error_fingerprints WHERE fingerprint = $1', [fp])).toBe(1);
            expect(await count('SELECT count(*) AS n FROM ezil_error_user_hours WHERE fingerprint = $1 AND user_hash = $2', [fp, userHash])).toBe(1);
        }
        const { calls, mailer } = provider();
        const now = new Date();
        for (let i = 0; i < TERMINAL_AI_CODES.length; i++) expect(await drainIncidentAlerts(incidentDb, mailer, now)).toMatchObject({ accepted: 1 });
        expect(await drainIncidentAlerts(incidentDb, mailer, now)).toMatchObject({ accepted: 0 });
        const rows = await client!.unsafe(`SELECT fingerprint, code, distinct_users, accepted_at, provider_message_id FROM ezil_telemetry_alerts`);
        expect(new Set(rows.map(r => r.fingerprint))).toEqual(new Set(expected.keys()));
        for (const row of rows) {
            expect(row.code).toBe(expected.get(row.fingerprint as string)!.code);
            expect(row.distinct_users).toBe(1);
            expect(row.accepted_at).not.toBeNull();
            expect(row.provider_message_id).toMatch(/^provider-\d+$/);
        }
        expect(calls).toHaveLength(9);
        for (const { url, init } of calls) {
            expect(url).toBe('https://api.smtp2go.com/v3/email/send');
            expect((init.headers as Record<string, string>)['X-Smtp2go-Api-Key']).toBe(FIXTURE_KEY);
            const text = String(init.body);
            expect(text).toContain('Distinct users: 1');
            for (const { userHash } of expected.values()) expect(text).not.toContain(userHash); // metadata only
        }
    });

    it('a re-delivered event id is stored once, and the cooldown keeps one committed outbox row and one send', async () => {
        const user = 'qa-dedupe', eventId = randomUUID(), code = 'ai_first_token_timeout';
        const fp = fingerprint({ eventClass: 'api_failure', source: 'shell', site: AI_SITE, code });
        await post(user, body([{ eventId, code }]));
        await post(user, body([{ eventId, code }]));
        noIngestFailure();
        expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE event_id = $1', [eventId])).toBe(1);
        expect(await count('SELECT count(*) AS n FROM ezil_error_user_hours WHERE fingerprint = $1', [fp])).toBe(1);
        const { calls, mailer } = provider();
        const now = new Date();
        expect(await drainIncidentAlerts(incidentDb, mailer, now)).toMatchObject({ accepted: 1 });
        await post(user, body([{ code }])); // a fresh event of the same failure inside the cooldown
        expect(await drainIncidentAlerts(incidentDb, mailer, new Date(now.getTime() + 60_000))).toMatchObject({ enqueued: 0, accepted: 0 });
        expect(await count('SELECT count(*) AS n FROM ezil_telemetry_alerts WHERE fingerprint = $1', [fp])).toBe(1);
        expect(calls).toHaveLength(1);
    });

    it('attribution is the server session: two users share one fingerprint, a different source is a different fingerprint, a client user hash is refused', async () => {
        const code = 'ai_model_unavailable';
        await post('qa-attribution-a', body([{ code }]));
        await post('qa-attribution-b', body([{ code }]));
        await post('qa-attribution-a', body([{ code, source: 'worker' }]));
        await post('qa-attribution-c', body([{ code, extra: { userHash: 'u_00000001' } }])); // strict schema: dropped
        noIngestFailure();
        const shell = fingerprint({ eventClass: 'api_failure', source: 'shell', site: AI_SITE, code });
        const worker = fingerprint({ eventClass: 'api_failure', source: 'worker', site: AI_SITE, code });
        expect(shell).not.toBe(worker);
        const hashes = (await client!.unsafe('SELECT DISTINCT user_hash FROM ezil_error_events WHERE fingerprint = $1 ORDER BY 1', [shell])).map(r => r.user_hash);
        expect(hashes).toEqual([safeUserHash('qa-attribution-a'), safeUserHash('qa-attribution-b')].sort());
        expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE fingerprint = $1', [worker])).toBe(1);
        expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE user_hash IN ($1, $2)', ['u_00000001', safeUserHash('qa-attribution-c')])).toBe(0);
        const { mailer } = provider();
        await drainIncidentAlerts(incidentDb, mailer, new Date());
        expect(await count('SELECT distinct_users AS n FROM ezil_telemetry_alerts WHERE fingerprint = $1', [shell])).toBe(2);
    });

    it('server-enforced negatives produce no outbox row and no provider call', async () => {
        await post('qa-neg-ordinary', body([{ code: 'http_500', site: 'ezil-os:apps/code#mint' }]));       // one user, ordinary code
        await post('qa-neg-ok', body([{ code: 'ai_provider_error', outcome: 'ok' }]));                      // not an error outcome
        await post('qa-neg-skipped', body([{ code: 'ai_provider_error', outcome: 'skipped' }]));
        await post('qa-neg-muted', body([{ code: 'ai_stream_interrupted' }]));                               // muted below
        await post('qa-neg-milestone', body([{ eventClass: 'boot_phase', site: MILESTONE_SITE, code: 'first_frame_cloudflare' }]));
        noIngestFailure();
        const muted = fingerprint({ eventClass: 'api_failure', source: 'shell', site: AI_SITE, code: 'ai_stream_interrupted' });
        await client!.unsafe('UPDATE ezil_error_fingerprints SET muted_at = now() WHERE fingerprint = $1', [muted]);
        // Rejected before any ingest is scheduled: unauthenticated, malformed JSON, over the body cap, invalid event.
        expect(await post(null, body([{ code: 'ai_provider_error' }]))).toBe(0);
        expect(await post('qa-neg-malformed', '{"schemaVersion":1,"events":[')).toBe(0);
        expect(await post('qa-neg-oversize', body([{ code: 'ai_provider_error', extra: { detail: 'x'.repeat(70 * 1024) } }]))).toBe(0);
        expect(await post('qa-neg-invalid', body([{ code: 'AI-Provider-Error' }]))).toBe(0);
        expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE user_hash IN ($1, $2, $3)',
            [safeUserHash('qa-neg-malformed'), safeUserHash('qa-neg-oversize'), safeUserHash('qa-neg-invalid')])).toBe(0);
        const { calls, mailer } = provider();
        expect(await drainIncidentAlerts(incidentDb, mailer, new Date())).toMatchObject({ enqueued: 0, accepted: 0 });
        expect(await count('SELECT count(*) AS n FROM ezil_telemetry_alerts')).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it('a provider failure is not accepted, waits for its backoff, then the same notice is resent and accepted (at least once)', async () => {
        const code = 'ai_app_start_timeout';
        const fp = fingerprint({ eventClass: 'api_failure', source: 'shell', site: AI_SITE, code });
        await post('qa-retry', body([{ code }]));
        noIngestFailure();
        const { calls, mailer } = provider([500, 200]);
        const now = new Date();
        expect(await drainIncidentAlerts(incidentDb, mailer, now)).toMatchObject({ accepted: 0, retry: 1 });
        let [row] = await client!.unsafe('SELECT accepted_at, attempts, next_attempt_at FROM ezil_telemetry_alerts WHERE fingerprint = $1', [fp]);
        expect(row!.accepted_at).toBeNull();
        expect(row!.attempts).toBe(1);
        expect(new Date(row!.next_attempt_at as string).getTime()).toBeGreaterThan(now.getTime());
        expect(await drainIncidentAlerts(incidentDb, mailer, now)).toMatchObject({ accepted: 0 }); // not due yet
        expect(calls).toHaveLength(1);
        expect(await drainIncidentAlerts(incidentDb, mailer, new Date(now.getTime() + 61_000))).toMatchObject({ accepted: 1 });
        [row] = await client!.unsafe('SELECT accepted_at, attempts, provider_message_id FROM ezil_telemetry_alerts WHERE fingerprint = $1', [fp]);
        expect(row!.accepted_at).not.toBeNull();
        expect(row!.provider_message_id).toBe('provider-2');
        expect(calls).toHaveLength(2);
        // The same notice (same Message-ID) is resent: a receiver can dedupe, but delivery is at least once, never exactly once.
        const messageId = (i: number) => JSON.parse(String(calls[i]!.init.body)).custom_headers[0].value;
        expect(messageId(1)).toBe(messageId(0));
    });

    // ── The shell's real publisher chain, as source modules (no browser, bundle or installed artifact) ──────────
    // Real `create_app_failure_store` (iframe source, exact origin, own nonce, exact keys, closed record) feeds the
    // real `telemetry.capture` as onTerminalFailure; the real formatter and `flushNow` produce the wire bytes, which
    // are posted unchanged to the real handler. Fixtures are only the iframe/window event targets, the boot payload
    // and the transport (`fetch`) boundary. Each test re-imports fresh module state (per-page caps, arming, flushes).
    const ORIGIN = 'https://code-fixture.example.invalid';
    const BOOT_USER = 'qa-publisher';
    const COMPUTER = 'c0000000-0000-4000-8000-000000000001';
    type Wire = { url: string; body: string };
    /** Lets any transport work the module queued settle before the recorded boundary is read. */
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    async function shellChain() {
        const wire: Wire[] = [];
        vi.stubGlobal('navigator', {}); // no sendBeacon: the module's own fetch fallback is the transport boundary
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
            wire.push({ url: String(url), body: String(init.body) });
            return new Response(null, { status: 202 });
        }));
        vi.stubGlobal('window', { __EZIL_BOOT__: { user: { id: BOOT_USER }, computer: { id: COMPUTER },
            desktopState: { endpoints: { telemetry: '/api/shell/telemetry' } } } });
        vi.resetModules();
        const telemetry = await import('../../../../shell/ezil/telemetry.js');
        const trace = await import('../../../../shell/ezil/trace.js');
        const failures = await import('../../../../shell/ezil/ui/feedback/app-failures.js');
        const host = new EventTarget();
        const hellos: Array<{ data: { nonce: string }; origin: string }> = [];
        const contentWindow = { postMessage: (data: { nonce: string }, origin: string) => { hellos.push({ data, origin }); } };
        const iframe = Object.assign(new EventTarget(), { ownerDocument: { defaultView: host }, src: `${ORIGIN}/code/`, isConnected: true, contentWindow });
        const store = failures.create_app_failure_store();
        const unregister = store.register_app_frame(iframe as unknown as HTMLIFrameElement, {
            origin: ORIGIN, computerId: COMPUTER, appSession: 'qa-session', app: 'code', onTerminalFailure: telemetry.capture,
        });
        expect(hellos).toHaveLength(1);
        expect(hellos[0]!.origin).toBe(ORIGIN);
        const nonce = hellos[0]!.data.nonce;
        const deliver = (data: unknown, { source = contentWindow as unknown, origin = ORIGIN } = {}) => {
            const event = new Event('message');
            Object.defineProperties(event, { data: { value: data }, origin: { value: origin }, source: { value: source } });
            host.dispatchEvent(event);
        };
        const failure = (fields: Record<string, unknown>) => ({ type: 'ezil.code.failure', v: 1, nonce,
            failure: { eventId: randomUUID(), source: 'ezil_chat', operation: 'chat_request', stage: 'request', outcome: 'failed', ...fields } });
        return { wire, telemetry, trace, store, unregister, nonce, deliver, failure };
    }
    const SHELL_TERMINAL = [
        { category: 'provider', code: 'provider_error' }, { category: 'provider', code: 'provider_overloaded' },
        { category: 'provider', code: 'model_unavailable' }, { category: 'interrupted', code: 'stream_interrupted' },
        { category: 'timeout', code: 'first_token_timeout' }, { category: 'timeout', code: 'request_timeout' },
        { category: 'app_startup', code: 'app_start_failed', source: 'code_app', operation: 'app_start', stage: 'startup' },
        { category: 'app_startup', code: 'app_start_timeout', source: 'code_app', operation: 'app_start', stage: 'startup' },
        { category: 'app_startup', code: 'chat_unavailable', source: 'code_app', operation: 'app_start', stage: 'startup' },
    ];

    it('the real shell chain turns all nine terminal failures into one wire batch the real handler ingests and alerts on', async () => {
        try {
            const chain = await shellChain();
            chain.trace.beginTrace('qa-ambient'); // an ambient correlation the terminal projection must not carry
            expect(chain.trace.ambientCorrelationId()).toBeTruthy();
            for (const fields of SHELL_TERMINAL) chain.deliver(chain.failure(fields));
            // Control: an ordinary capture still carries the ambient correlation and computer.
            chain.telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'http_500' });
            chain.telemetry.flushNow();
            await settle();
            chain.unregister();
            expect(chain.wire).toHaveLength(1);
            expect(chain.wire[0]!.url).toBe('/api/shell/telemetry');
            const batch = JSON.parse(chain.wire[0]!.body) as { schemaVersion: number; events: Array<Record<string, unknown>> };
            expect(batch.schemaVersion).toBe(1);
            const terminal = batch.events.filter(e => e.site === AI_SITE);
            expect(new Set(terminal.map(e => e.code))).toEqual(new Set(TERMINAL_AI_CODES));
            for (const e of terminal) {
                expect(e).toMatchObject({ eventClass: 'api_failure', source: 'shell', outcome: 'error' });
                expect(e).not.toHaveProperty('correlationId');
                expect(e).not.toHaveProperty('computerId');
            }
            const control = batch.events.find(e => e.code === 'http_500')!;
            expect(control.correlationId).toBe(chain.trace.ambientCorrelationId());
            expect(control.computerId).toBe(COMPUTER);
            // The control's computer must exist for the real computer_id FK, or the whole batch would fail to ingest.
            await client!.unsafe('INSERT INTO ezil_computers (id) VALUES ($1) ON CONFLICT DO NOTHING', [COMPUTER]);
            // The captured bytes, unchanged, through the real handler under the boot user's session.
            expect(await post(BOOT_USER, chain.wire[0]!.body)).toBe(1);
            noIngestFailure();
            for (const code of TERMINAL_AI_CODES) {
                const fp = fingerprint({ eventClass: 'api_failure', source: 'shell', site: AI_SITE, code });
                expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE fingerprint = $1 AND user_hash = $2 AND computer_id IS NULL AND correlation_id IS NULL',
                    [fp, safeUserHash(BOOT_USER)])).toBe(1);
            }
            expect(await count('SELECT count(*) AS n FROM ezil_error_events WHERE code = $1 AND computer_id = $2', ['http_500', COMPUTER])).toBe(1);
            const { calls, mailer } = provider();
            const now = new Date();
            for (let i = 0; i < TERMINAL_AI_CODES.length; i++) expect(await drainIncidentAlerts(incidentDb, mailer, now)).toMatchObject({ accepted: 1 });
            expect(await count('SELECT count(*) AS n FROM ezil_telemetry_alerts WHERE accepted_at IS NOT NULL AND code = ANY($1)', [[...TERMINAL_AI_CODES]])).toBe(9);
            expect(await count('SELECT count(*) AS n FROM ezil_telemetry_alerts WHERE code = $1', ['http_500'])).toBe(0);
            expect(calls).toHaveLength(9);
        } finally { vi.unstubAllGlobals(); }
    });

    it('forged frames and non-terminal outcomes emit nothing: no wire bytes, no events, no outbox', async () => {
        try {
            const chain = await shellChain();
            const terminal = { category: 'provider', code: 'provider_error' };
            chain.deliver(chain.failure(terminal), { source: {} });                                   // another window
            chain.deliver(chain.failure(terminal), { source: null });
            chain.deliver(chain.failure(terminal), { origin: 'https://forged.example.invalid' });     // wrong origin
            chain.deliver(chain.failure(terminal), { origin: 'null' });
            chain.deliver({ ...chain.failure(terminal), nonce: 'forged-nonce' });                    // not our nonce
            chain.deliver({ ...chain.failure(terminal), extra: true });                              // extra top-level key
            chain.deliver(chain.failure({ category: 'cancellation', code: 'request_cancelled', outcome: 'cancelled', cancellationSource: 'user_stop' }));
            chain.deliver(chain.failure({ ...terminal, outcome: 'recovered' }));
            chain.deliver(chain.failure({ ...terminal, outcome: 'retrying' }));
            chain.deliver(chain.failure({ category: 'credits', code: 'credits_exhausted' }));          // credits, not terminal AI
            chain.deliver(chain.failure({ category: 'provider', code: 'credits_pending' }));           // unknown code
            chain.deliver({ type: 'ezil.code.readHeavy', v: 1, nonce: chain.nonce, failure: { reads: 1000 } }); // unknown message
            chain.deliver(chain.failure({ ...terminal, readHeavy: true }));                          // unknown failure field
            chain.telemetry.flushNow();
            await settle();
            chain.unregister();
            expect(chain.wire).toEqual([]);
            // A late valid record after unregister is also ignored.
            chain.deliver(chain.failure(terminal));
            chain.telemetry.flushNow();
            await settle();
            expect(chain.wire).toEqual([]);
            expect(await count('SELECT count(*) AS n FROM ezil_error_events')).toBe(0);
            const { calls, mailer } = provider();
            expect(await drainIncidentAlerts(incidentDb, mailer, new Date())).toMatchObject({ enqueued: 0, accepted: 0 });
            expect(await count('SELECT count(*) AS n FROM ezil_telemetry_alerts')).toBe(0);
            expect(calls).toHaveLength(0);
        } finally { vi.unstubAllGlobals(); }
    });
});
