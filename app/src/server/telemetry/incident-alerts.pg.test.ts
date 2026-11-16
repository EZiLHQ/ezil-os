/** Disposable PostgreSQL only (EZIL_PG_TEST_URL, an owned fixture): the real scan SQL, the unique outbox key, the lock and the budget. No mail credential. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncidentDb } from './incident-alerts';
import { ALERT_POLICY, drainIncidentAlerts } from './incident-alerts';

const PG = process.env.EZIL_PG_TEST_URL;
if (PG) {
    const url = new URL(PG);
    if (process.env.EZIL_PG_TEST_DISPOSABLE !== '1' || !['postgres:', 'postgresql:'].includes(url.protocol)
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.pathname !== '/ezil_alerts_test' || url.search || url.hash) {
        throw new Error('Incident PG tests require explicit disposable opt-in and loopback /ezil_alerts_test without URL options');
    }
}
const now = new Date('2026-11-15T12:00:00Z');
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
const hash = (n: number) => `u_${n.toString(16).padStart(8, '0')}`;

describe.skipIf(!PG)('incident alerts on PostgreSQL', () => {
    const name = `incident_alerts_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const db: IncidentDb = client ? drizzle(client) : null!;
    let created = false;
    beforeAll(async () => {
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${name}`); created = true;
        // The columns the alert scan reads; the production tables carry more.
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_error_events (event_id uuid PRIMARY KEY, event_class text NOT NULL, fingerprint text NOT NULL,
            user_hash text NOT NULL, site text NOT NULL, code text NOT NULL, outcome text NOT NULL, received_at timestamptz NOT NULL);
            CREATE TABLE ${name}.ezil_error_fingerprints (fingerprint text PRIMARY KEY, muted_at timestamptz NULL)`);
        const migration = readFileSync(new URL('../../../drizzle/0024_telemetry_alerts.sql', import.meta.url), 'utf8');
        await admin!.begin(tx => tx.unsafe(migration.replaceAll('public.', `${name}.`)));
    });
    afterAll(async () => {
        if (created) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await client?.end(); await admin?.end();
    });
    const clear = () => client!.unsafe('TRUNCATE ezil_error_events, ezil_error_fingerprints, ezil_telemetry_alerts, ezil_telemetry_alert_health');
    async function event(o: { fp: string; cls?: string; site?: string; code?: string; user: number; minutes?: number; outcome?: string }) {
        await client!.unsafe('INSERT INTO ezil_error_events VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [randomUUID(), o.cls ?? 'api_failure', o.fp, hash(o.user), o.site ?? 'ezil-os:apps/code#mint', o.code ?? 'http_500', o.outcome ?? 'error', ago(o.minutes ?? 1)]);
    }
    const queued = async () => (await client!.unsafe('SELECT fingerprint FROM ezil_telemetry_alerts ORDER BY fingerprint')).map(r => r.fingerprint as string);
    const ok = async () => ({ accepted: true as const, messageId: 'provider-1' });

    it('queues only real incidents: one-user code, terminal class and several-user failures, not milestones, sentinel-only, muted or one-user noise', async () => {
        await clear();
        await event({ fp: 'fp_00000000000000a1', code: 'computer_rebase_required', user: 1 });                       // one user, actionable
        await event({ fp: 'fp_00000000000000a4', code: 'ai_provider_error', site: 'ezil-os:apps/code#aiRequest', user: 1 });
        await event({ fp: 'fp_00000000000000a2', cls: 'crash', code: 'boot_failed', user: 2 });                       // terminal
        for (const u of [3, 4, 5]) await event({ fp: 'fp_00000000000000a3', user: u });                                 // three users
        await event({ fp: 'fp_00000000000000b1', user: 6 });                                                           // one user, ordinary
        await event({ fp: 'fp_00000000000000b2', cls: 'boot_phase', site: 'ezil-os:apps/desktop#tti', code: 'first_frame_cloudflare', user: 7 }); // milestone
        await event({ fp: 'fp_00000000000000b3', cls: 'crash', user: 0 });                                              // sentinel only
        await event({ fp: 'fp_00000000000000b4', cls: 'crash', user: 8 });
        await client!.unsafe(`INSERT INTO ezil_error_fingerprints VALUES ('fp_00000000000000b4', $1)`, [ago(5)]);        // muted
        for (const u of [9, 10, 11]) await event({ fp: 'fp_00000000000000b5', cls: 'display_failure', code: 'sandbox_starting', user: u, minutes: 2 }); // a warm-up burst
        await drainIncidentAlerts(db, null, now);
        expect(await queued()).toEqual(['fp_00000000000000a1', 'fp_00000000000000a2', 'fp_00000000000000a3', 'fp_00000000000000a4']);
    });
    it('does not let ineligible fingerprints starve a critical one behind the scan limit', async () => {
        await clear();
        for (let i = 0; i < ALERT_POLICY.scanLimit + 5; i++) await event({ fp: `fp_${(0x1000 + i).toString(16).padStart(16, '0')}`, user: 100 + i, minutes: 1 });
        await event({ fp: 'fp_00000000000000c1', cls: 'crash', user: 1, minutes: 25 });
        await drainIncidentAlerts(db, null, now);
        expect(await queued()).toEqual(['fp_00000000000000c1']);
    });
    it('persistent sandbox_starting across users and time alerts; the cooldown and the unique key prevent a second row', async () => {
        await clear();
        for (const u of [1, 2, 3]) { await event({ fp: 'fp_00000000000000d1', cls: 'display_failure', code: 'sandbox_starting', user: u, minutes: 25 }); await event({ fp: 'fp_00000000000000d1', cls: 'display_failure', code: 'sandbox_starting', user: u, minutes: 1 }); }
        await drainIncidentAlerts(db, null, now); await drainIncidentAlerts(db, null, now);
        await drainIncidentAlerts(db, null, new Date(now.getTime() + 60_000));
        expect(await queued()).toEqual(['fp_00000000000000d1']);
    });
    it('overlapping sweeps send once and committed acceptance is not resent during cooldown', async () => {
        await clear(); await event({ fp: 'fp_00000000000000e1', cls: 'crash', user: 1 });
        let entered!: () => void, finish!: () => void;
        const inSend = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const send = vi.fn(async () => { entered(); await gate; return { accepted: true as const, messageId: 'provider-accepted' }; });
        const first = drainIncidentAlerts(db, send, now);
        await inSend;
        try { expect(await drainIncidentAlerts(db, send, now)).toMatchObject({ skipped: true, accepted: 0 }); } finally { finish(); }
        expect(await first).toMatchObject({ accepted: 1 });
        expect(send).toHaveBeenCalledTimes(1);
        expect(await drainIncidentAlerts(db, send, now)).toMatchObject({ accepted: 0 });
        expect(send).toHaveBeenCalledTimes(1);
    });
    it('provider acceptance followed by transaction rollback can resend the same notice', async () => {
        await clear(); await event({ fp: 'fp_00000000000000e2', code: 'ai_request_timeout', user: 1 });
        const broken: IncidentDb = { transaction: (run, config) => db.transaction(tx => run({
            execute: query => {
                if (new PgDialect().sqlToQuery(query).sql.includes('UPDATE ezil_telemetry_alerts SET accepted_at')) throw new Error('commit path lost');
                return tx.execute(query);
            },
        }), config) };
        const send = vi.fn(ok);
        await expect(drainIncidentAlerts(broken, send, now)).rejects.toThrow('commit path lost');
        expect(await queued()).toEqual([]);
        expect(await drainIncidentAlerts(db, send, now)).toMatchObject({ accepted: 1 });
        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
    });
    it('a fingerprint muted after it was queued is dropped, never sent', async () => {
        await clear(); await event({ fp: 'fp_00000000000000f1', cls: 'crash', user: 1 });
        await drainIncidentAlerts(db, null, now);
        await client!.unsafe(`INSERT INTO ezil_error_fingerprints VALUES ('fp_00000000000000f1', $1)`, [now.toISOString()]);
        const send = vi.fn(ok);
        expect(await drainIncidentAlerts(db, send, now)).toMatchObject({ accepted: 0, dropped: 1 });
        expect(send).not.toHaveBeenCalled(); expect(await queued()).toEqual([]);
    });
    it('the durable hourly budget stops sending but keeps the queue', async () => {
        await clear();
        for (let i = 0; i < ALERT_POLICY.maxPerHour; i++) {
            await client!.unsafe(`INSERT INTO ezil_telemetry_alerts VALUES ($1,$2,'crash','s','c',1,1,$3,$3,$3,1,$3,$3,'m')`, [`k${i}`, `fp_${i.toString(16).padStart(16, '0')}`, ago(10)]);
        }
        await event({ fp: 'fp_00000000000000ee', cls: 'crash', user: 1 });
        const send = vi.fn(ok);
        expect(await drainIncidentAlerts(db, send, now)).toMatchObject({ accepted: 0, budget: true });
        expect(send).not.toHaveBeenCalled(); expect(await queued()).toContain('fp_00000000000000ee');
    });
    it('fresh empty telemetry waits six hours, then reports silence at most once per 24 hours', async () => {
        await clear();
        expect(await drainIncidentAlerts(db, null, now)).toMatchObject({ silent: false });
        expect(await queued()).toEqual([]);
        expect(await drainIncidentAlerts(db, null, new Date(now.getTime() + ALERT_POLICY.silentAfterMs - 1))).toMatchObject({ silent: false });
        const first = new Date(now.getTime() + ALERT_POLICY.silentAfterMs);
        expect(await drainIncidentAlerts(db, null, first)).toMatchObject({ silent: true });
        expect(await drainIncidentAlerts(db, null, new Date(first.getTime() + ALERT_POLICY.silentCooldownMs - 1))).toMatchObject({ silent: false });
        expect(await queued()).toEqual(['collection_silent']);
        expect(await drainIncidentAlerts(db, null, new Date(first.getTime() + ALERT_POLICY.silentCooldownMs))).toMatchObject({ silent: true });
    });
});
