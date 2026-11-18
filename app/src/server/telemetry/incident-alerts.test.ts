import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { additiveSQL } from '../../../../.github/scripts/production-migrations.mjs';
import type { IncidentDb } from './incident-alerts';
import { incidentAlertMailer, INCIDENT_MAIL_TIMEOUT_MS, type IncidentMailer } from './incident-alert-mail';
import { KNOWN_CODES, KNOWN_SITES } from './incident-labels';
import { TERMINAL_AI_CODES } from './types';
import { ALERT_POLICY, drainIncidentAlerts, shouldAlert } from './incident-alerts';

const now = new Date('2026-11-15T12:00:00Z');
const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
const cand = (o: Partial<Parameters<typeof shouldAlert>[0]> = {}) => ({ eventClass: 'api_failure', code: 'http_500', distinctUsers: 1, events: 1, firstAt: at(5), lastAt: at(1), ...o });

describe('alert threshold policy', () => {
    it('one real user terminal AI codes have approved mail labels; noise stays below threshold', () => {
        for (const code of TERMINAL_AI_CODES) {
            expect(shouldAlert(cand({ code }))).toBe(true);
            expect(shouldAlert(cand({ code, distinctUsers: 0 }))).toBe(false);
            expect(KNOWN_CODES.has(code)).toBe(true);
        }
        expect(KNOWN_SITES.has('ezil-os:apps/code#aiRequest')).toBe(true);
        for (const code of ['request_cancelled', 'credits_exhausted', 'model_not_entitled', 'provider_refused']) expect(shouldAlert(cand({ code }))).toBe(false);
    });
    it('alerts a terminal class or a single-user code at one real user, other classes only at several users', () => {
        for (const eventClass of ['crash', 'worker_exception', 'contract_violation']) expect(shouldAlert(cand({ eventClass }))).toBe(true);
        expect(shouldAlert(cand({ code: 'computer_rebase_required' }))).toBe(true); // api_failure at ONE user: the real incident
        expect(shouldAlert(cand({ eventClass: 'crash', distinctUsers: 0 }))).toBe(false); // sentinel-only: not a user
        expect(shouldAlert(cand({ distinctUsers: 2, events: 40 }))).toBe(false);          // one noisy pair is not an incident
        expect(shouldAlert(cand({ distinctUsers: ALERT_POLICY.otherMinUsers }))).toBe(true);
    });
    it('never alerts the warming sandbox_starting transient unless it persists across users and time', () => {
        const t = (o: object) => shouldAlert(cand({ eventClass: 'display_failure', code: 'sandbox_starting', ...o }));
        expect(t({ distinctUsers: 1, events: 500 })).toBe(false);
        expect(t({ distinctUsers: 9, events: 50, firstAt: at(2), lastAt: at(1) })).toBe(false); // a burst of warm-ups
        expect(t({ distinctUsers: 2, firstAt: at(25), lastAt: at(1) })).toBe(false);
        expect(t({ distinctUsers: 3, firstAt: at(25), lastAt: at(1) })).toBe(true);             // persistent for 24 minutes
        expect(shouldAlert(cand({ eventClass: 'crash', code: 'sandbox_starting', distinctUsers: 1, firstAt: at(2) }))).toBe(false);
    });
});

type Row = Record<string, unknown>;
const due = { fingerprint: 'fp_0123456789abcdef', eventClass: 'crash', site: 'ezil-os:boot#give_up', code: 'boot_failed', distinctUsers: 2, events: 3,
    windowStart: at(10), windowEnd: at(1), createdAt: now, attempts: 0 };
const found = (o: Row = {}) => ({ fingerprint: 'fp_0123456789abcdef', eventClass: 'crash', site: 'ezil-os:boot#give_up', code: 'boot_failed', distinctUsers: 2, events: 3, firstAt: at(10), lastAt: at(1), ...o });
function database(input: { locked?: boolean; found?: Row[]; pending?: number; sent?: number; latest?: Date | null; firstObservedAt?: Date; silentAlertedAt?: Date | null; due?: Row | null } = {}) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const execute = vi.fn(async (query: SQL) => {
        const q = new PgDialect().sqlToQuery(query); statements.push(q);
        if (q.sql.includes('pg_try_advisory_xact_lock')) return [{ locked: input.locked ?? true }];
        if (q.sql.includes('WITH gone AS')) return [{ n: 0 }];
        if (q.sql.includes('FROM ezil_error_events e')) return input.found ?? [];
        if (q.sql.includes('accepted_at IS NULL') && q.sql.includes('count(*)::int AS n FROM ezil_telemetry_alerts')) return [{ n: input.pending ?? 0 }];
        if (q.sql.includes('accepted_at >')) return [{ n: input.sent ?? 0 }];
        if (q.sql.includes('SELECT max(received_at)')) return [{ at: input.latest === undefined ? at(1) : input.latest }];
        if (q.sql.includes('"silentAlertedAt"')) return [{ firstObservedAt: input.firstObservedAt ?? now, silentAlertedAt: input.silentAlertedAt ?? null }];
        if (q.sql.includes('FOR UPDATE SKIP LOCKED')) return input.due === null ? [] : [input.due ?? due];
        return [];
    });
    const transaction = vi.fn(async (cb: (tx: { execute: typeof execute }) => Promise<unknown>) => cb({ execute }));
    return { db: { transaction } as unknown as IncidentDb, statements, transaction };
}
const inserts = (d: ReturnType<typeof database>) => d.statements.filter(s => s.sql.includes('INSERT INTO ezil_telemetry_alerts'));

describe('durable incident alert drain', () => {
    it('cannot run while another sweep owns the transaction lock', async () => {
        const d = database({ locked: false }); const send = vi.fn();
        expect(await drainIncidentAlerts(d.db, send, now)).toMatchObject({ skipped: true, enqueued: 0 });
        expect(send).not.toHaveBeenCalled(); expect(d.statements).toHaveLength(1);
    });
    it('applies mute, sentinel, cooldown, milestone exclusion and the thresholds in the scan SQL itself', async () => {
        const d = database();
        await drainIncidentAlerts(d.db, null, now);
        const scan = d.statements.find(s => s.sql.includes('FROM ezil_error_events e'))!;
        expect(scan.sql).toContain('f.muted_at IS NULL');
        expect(scan.sql).toContain("e.outcome = 'error'");
        expect(scan.sql).toContain('FILTER (WHERE e.user_hash <>'); expect(scan.params).toContain('u_00000000');
        expect(scan.sql).toContain('NOT EXISTS (SELECT 1 FROM ezil_telemetry_alerts a');
        expect(scan.params).toContain(new Date(now.getTime() - ALERT_POLICY.cooldownMs).toISOString());
        // TTI milestones are timings, never failures, even when marked error.
        expect(scan.sql).toContain("e.code ~ '^(first_frame|first_input)_'"); expect(scan.params).toContain('ezil-os:apps/desktop#tti');
        // The policy runs in HAVING, before LIMIT, so quiet fingerprints cannot starve a critical one.
        expect(scan.sql.indexOf('HAVING CASE')).toBeLessThan(scan.sql.lastIndexOf('LIMIT'));
        for (const p of ['sandbox_starting', 'crash', 'computer_rebase_required', ALERT_POLICY.otherMinUsers, ALERT_POLICY.transientMinSpanMs]) expect(scan.params).toContain(p);
        expect(scan.sql).not.toMatch(/\bdetail\b|correlation_id|computer_id|attrs/);
    });
    it('enqueues only candidates that pass the policy under a unique outbox key, and sends nothing without mail', async () => {
        const d = database({ found: [found(), found({ fingerprint: 'fp_aaaaaaaaaaaaaaaa', eventClass: 'display_failure', code: 'sandbox_starting', distinctUsers: 1 })] });
        expect(await drainIncidentAlerts(d.db, null, now)).toMatchObject({ enqueued: 1, accepted: 0, skipped: true, dropped: 0 });
        expect(inserts(d)).toHaveLength(1);
        expect(inserts(d)[0]!.sql).toContain('ON CONFLICT (outbox_key) DO NOTHING');
        expect(inserts(d)[0]!.params[0]).toBe(`fp_0123456789abcdef:${Math.floor(now.getTime() / ALERT_POLICY.cooldownMs)}`);
    });
    it('bounds the pending queue and counts what it could not queue', async () => {
        const d = database({ found: [found(), found({ fingerprint: 'fp_bbbbbbbbbbbbbbbb' })], pending: ALERT_POLICY.queueMax - 1 });
        expect(await drainIncidentAlerts(d.db, null, now)).toMatchObject({ enqueued: 1, dropped: 1 });
    });
    it('sends one due, unmuted alert and records acceptance and health in the same transaction', async () => {
        const d = database(); const send = vi.fn<IncidentMailer>(async (_notice) => ({ accepted: true, messageId: 'm-1' }));
        expect(await drainIncidentAlerts(d.db, send, now)).toMatchObject({ accepted: 1, retry: 0, skipped: false, budget: false });
        expect(send).toHaveBeenCalledOnce();
        expect(Object.keys(send.mock.calls[0]![0]).sort()).toEqual(['code', 'createdAt', 'distinctUsers', 'eventClass', 'events', 'fingerprint', 'site', 'windowEnd', 'windowStart']);
        expect(d.statements.some(s => s.sql.includes('accepted_at =') && s.params.includes('m-1'))).toBe(true);
        expect(d.statements.at(-1)!.sql).toContain('consecutive_failures = 0');
        const claim = d.statements.find(s => s.sql.includes('FOR UPDATE SKIP LOCKED'))!;
        expect(claim.sql).toContain('accepted_at IS NULL');
        expect(claim.sql).toContain('f.muted_at IS NOT NULL'); // a fingerprint muted after enqueue is not sent
    });
    it('removes pending alerts for a fingerprint muted after it was queued', async () => {
        const d = database();
        await drainIncidentAlerts(d.db, null, now);
        const cleanup = d.statements.filter(s => s.sql.includes('WITH gone AS')).map(s => s.sql).join('\n');
        expect(cleanup).toContain('f.muted_at IS NOT NULL'); expect(cleanup).toContain('a.accepted_at IS NULL');
    });
    it('stops sending once the durable hourly budget is spent, keeping the queue', async () => {
        const d = database({ sent: ALERT_POLICY.maxPerHour }); const send = vi.fn();
        expect(await drainIncidentAlerts(d.db, send, now)).toMatchObject({ accepted: 0, retry: 0, budget: true });
        expect(send).not.toHaveBeenCalled();
        expect(d.statements.some(s => s.sql.includes('FOR UPDATE SKIP LOCKED'))).toBe(false);
        const count = d.statements.find(s => s.sql.includes('accepted_at >'))!;
        expect(count.params).toContain(new Date(now.getTime() - 3_600_000).toISOString());
        const ok = database({ sent: ALERT_POLICY.maxPerHour - 1 });
        expect(await drainIncidentAlerts(ok.db, async () => ({ accepted: true, messageId: 'x' }), now)).toMatchObject({ accepted: 1, budget: false });
    });
    it.each([0, 20])('keeps a failed send durably retryable with bounded backoff (attempt %i)', async attempts => {
        const d = database({ due: { ...due, attempts } });
        expect(await drainIncidentAlerts(d.db, async () => { throw new Error('secret'); }, now)).toMatchObject({ accepted: 0, retry: 1 });
        const update = d.statements.find(s => s.sql.includes('next_attempt_at = '))!;
        expect(update.params[0]).toBe(new Date(now.getTime() + (attempts === 0 ? 60_000 : ALERT_POLICY.maxBackoffMs)).toISOString());
        expect(d.statements.at(-1)!.sql).toContain('consecutive_failures = consecutive_failures + 1');
    });
    it('treats silent collection as unhealthy once, then respects its own cooldown', async () => {
        const silent = database({ latest: at(7 * 60), due: null });
        expect(await drainIncidentAlerts(silent.db, vi.fn(), now)).toMatchObject({ silent: true, enqueued: 1 });
        expect(inserts(silent)[0]!.sql).toContain("'collection_silent'");
        expect(inserts(silent)[0]!.params[0]).toBe(`collection_silent:${Math.floor(now.getTime() / ALERT_POLICY.silentCooldownMs)}`);
        const never = database({ latest: null, due: null });
        expect(await drainIncidentAlerts(never.db, vi.fn(), now)).toMatchObject({ silent: false, enqueued: 0 });
        const established = database({ latest: null, firstObservedAt: at(6 * 60), due: null });
        expect(await drainIncidentAlerts(established.db, null, now)).toMatchObject({ silent: true, enqueued: 1 });
        expect(inserts(established)[0]!.params).toContain(at(6 * 60).toISOString());
        const cooling = database({ latest: null, firstObservedAt: at(48 * 60), silentAlertedAt: at(23 * 60), due: null });
        expect(await drainIncidentAlerts(cooling.db, null, now)).toMatchObject({ silent: false });
        const expired = database({ latest: null, firstObservedAt: at(48 * 60), silentAlertedAt: at(24 * 60), due: null });
        expect(await drainIncidentAlerts(expired.db, null, now)).toMatchObject({ silent: true });
        const again = database({ latest: at(7 * 60), silentAlertedAt: at(60), due: null });
        expect(await drainIncidentAlerts(again.db, vi.fn(), now)).toMatchObject({ silent: false, enqueued: 0 });
        const healthy = database({ latest: at(2), due: null });
        expect(await drainIncidentAlerts(healthy.db, vi.fn(), now)).toMatchObject({ silent: false });
    });
});

describe('incident alert mail', () => {
    const notice = { fingerprint: 'fp_0123456789abcdef', eventClass: 'crash', site: 'ezil-os:apps/code#mint', code: 'boot_failed', distinctUsers: 2, events: 3,
        windowStart: at(10).toISOString(), windowEnd: at(1).toISOString(), createdAt: now.toISOString() };
    const ok = () => ({ ok: true, json: async () => ({ data: { succeeded: 1, failed: 0, email_id: 'id-1' } }) }) as Response;
    const bodyOf = (fetcher: ReturnType<typeof vi.fn>) => JSON.parse((fetcher.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    it('is off without a key and uses the confirmed internal recipient', async () => {
        expect(incidentAlertMailer(undefined)).toBeNull();
        const fetcher = vi.fn(async () => ok());
        expect(await incidentAlertMailer(' key ', fetcher as unknown as typeof fetch, 'staging')!(notice)).toEqual({ accepted: true, messageId: 'id-1' });
        const body = bodyOf(fetcher);
        expect(body.to).toEqual(['contact@ezil.work']);
        expect(body.sender).toBe('invites@projects.ezil.work');
        expect(body.subject).toMatch(/^\[staging\]/);
        expect(body.text_body).toContain('Site: ezil-os:apps/code#mint'); // a real label with # is named, not refused
        expect(body.text_body).toContain('Distinct users: 2'); expect(body.text_body).toContain('https://os-staging.ezil.work/admin/telemetry');
    });
    it('names staging only for the trusted staging deployment; production and unknown link the production app unlabelled', async () => {
        const silent = { ...notice, fingerprint: 'collection_silent', eventClass: 'collection', site: '(none)', code: '(none)' };
        const send = async (deployment: unknown, sent: typeof notice) => {
            const fetcher = vi.fn(async () => ok());
            expect(await incidentAlertMailer('k', fetcher as unknown as typeof fetch, deployment as 'production')!(sent)).toEqual({ accepted: true, messageId: 'id-1' });
            return bodyOf(fetcher) as { subject: string; text_body: string; to: string[]; sender: string };
        };
        for (const sent of [notice, silent]) {
            const staging = await send('staging', sent);
            expect(staging.subject).toMatch(/^\[staging\] EZiL OS /);
            expect(staging.text_body).toContain('Review telemetry: https://os-staging.ezil.work/admin/telemetry');
            // Production, absent and any untrusted value (an origin, a look-alike, a different case) are never staging.
            for (const deployment of ['production', null, undefined, 'https://os-staging.ezil.work', 'os-staging', 'Staging', 'staging ']) {
                const body = await send(deployment, sent);
                expect(body.subject).toMatch(/^EZiL OS /);
                expect(`${body.subject}\n${body.text_body}`).not.toMatch(/staging/i);
                expect(body.text_body).toContain('Review telemetry: https://os.ezil.work/admin/telemetry');
                expect(body.to).toEqual(['contact@ezil.work']); expect(body.sender).toBe('invites@projects.ezil.work');
            }
        }
    });
    it('uses the five-second abort signal and treats ambiguous provider results as retryable', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        try {
            for (const response of [null, {}, { data: { succeeded: 1, failed: 1, email_id: 'x' } }, { data: { succeeded: 1, failed: 0 } }]) {
                const fetcher = vi.fn(async () => ({ ok: true, json: async () => response }) as Response);
                expect(await incidentAlertMailer('fixture', fetcher)!(notice)).toEqual({ accepted: false });
                expect(timeout).toHaveBeenLastCalledWith(INCIDENT_MAIL_TIMEOUT_MS);
                expect(INCIDENT_MAIL_TIMEOUT_MS).toBe(5000);
            }
        } finally { timeout.mockRestore(); }
    });
    it('names only known server-owned labels: URL- and token-shaped client values become (other)', async () => {
        expect(KNOWN_SITES.has('ezil-os:apps/code#mint')).toBe(true); expect(KNOWN_CODES.has('computer_rebase_required')).toBe(true);
        const fetcher = vi.fn(async () => ok());
        const mail = incidentAlertMailer('k', fetcher as unknown as typeof fetch)!;
        await mail({ ...notice, site: 'https://x.test/?token=abc', code: 'user_example_com_secret', eventClass: 'x@y.z' });
        const sent = bodyOf(fetcher).text_body as string;
        expect(sent).toContain('Site: (other)'); expect(sent).toContain('Code: (other)'); expect(sent).toContain('Class: (other)');
        expect(sent).not.toMatch(/token=abc|example|secret|x\.test|x@y/);
        expect(await mail({ ...notice, fingerprint: 'not-a-fingerprint' })).toEqual({ accepted: false });
        expect(await mail({ ...notice, distinctUsers: -1 })).toEqual({ accepted: false });
        expect(await incidentAlertMailer('k', (async () => { throw new Error('boom'); }) as unknown as typeof fetch)!(notice)).toEqual({ accepted: false });
    });
});

describe('migration 0024', () => {
    it('uses the production additive grammar, keys the outbox uniquely and enqueues nothing', () => {
        const migration = readFileSync(new URL('../../../drizzle/0024_telemetry_alerts.sql', import.meta.url), 'utf8');
        expect(additiveSQL(migration, ['public'])).toBe(migration);
        expect(migration).not.toMatch(/INSERT|SELECT/i);
        expect(migration).toContain('CREATE UNIQUE INDEX ezil_telemetry_alerts_key ON public.ezil_telemetry_alerts (outbox_key)');
        expect(migration.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(2);
        expect(migration.match(/FROM public, anon, authenticated/g)).toHaveLength(2);
    });
});
