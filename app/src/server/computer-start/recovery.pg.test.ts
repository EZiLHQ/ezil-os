/** Synthetic PostgreSQL only: real start receipts + real port, with provider/billing collaborators faked. */
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    route: vi.fn(), ensure: vi.fn(), status: vi.fn(), gate: vi.fn(), ready: vi.fn(), prepare: vi.fn(), services: true,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/api/editor-delegation', () => ({ editorControlsEnabled: () => h.services }));
vi.mock('@/server/api/routers/compute-dispatch', () => ({ routeComputer: h.route, cloudflareMigrationAnswer: () => null }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date(), config: { enforcementEnabled: true } }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: h.gate }));
vi.mock('@/server/billing/v2/compute-meter', () => ({ billingComputeMeter: () => ({ ready: h.ready }) }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({ newCorrelationId: () => 'synthetic', resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true }) }));
vi.mock('@/server/lib/compute/aws-preview', () => ({ prepareAwsPoolSession: h.prepare }));
vi.mock('@/server/lib/compute/stop-policy', () => ({ stopComputerForPolicy: vi.fn() }));

import { ensureTestSchema } from '@/server/agent-session/pg-test-schema';
import { observeAdmittedStart, startPort } from './port';
import { reconcileColdStart, reconcileColdStarts, startComputer, type BootOutcome } from './start';

const url = process.env.DELEGATION_TEST_DATABASE_URL;
// This suite cannot accidentally run against a deployment or a different local DB.
if (url && url !== 'postgres://postgres:synthetic-editor-test@127.0.0.1:32857/postgres') {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1'].includes(target.hostname)
        || !/^\/ezil_integration_test_[0-9]+$/.test(target.pathname)) {
        throw new Error('Recovery tests require an assigned disposable local PostgreSQL database');
    }
}

describe.skipIf(!url)('admitted AWS recovery on synthetic PostgreSQL', () => {
    let client: ReturnType<typeof postgres>;
    let db: ReturnType<typeof drizzle>;
    let fixturesCreated = false;
    const userId = randomUUID(), other = randomUUID();
    const caller = { userId, clientId: 'synthetic-recovery' };
    let computer: { userId: string; computerId: string };
    let key: string;
    const aws = () => ({ kind: 'aws-ec2', instanceType: 'm6i.large', provider: { ensure: h.ensure, status: h.status } });
    const start = () => startComputer(db, startPort(db, computer), caller, { computerId: computer.computerId, idempotencyKey: key });
    const poll = () => reconcileColdStart(db, caller, key, c => observeAdmittedStart(db, c));
    const row = async () => (await client`SELECT * FROM public.ezil_control_operations WHERE user_id = ${userId}::uuid AND idempotency_key = ${key}::uuid`)[0]!;
    const age = async (seconds: number) => { await client`UPDATE public.ezil_control_operations
        SET created_at = now() - make_interval(secs => ${seconds}::int), updated_at = now() - make_interval(secs => ${seconds}::int)
        WHERE user_id = ${userId}::uuid AND idempotency_key = ${key}::uuid`; };

    beforeAll(async () => {
        client = postgres(url!, { max: 4, prepare: false, onnotice: () => {} });
        db = drizzle(client);
        await ensureTestSchema(client);
        await client`INSERT INTO auth.users (id) VALUES (${userId}::uuid), (${other}::uuid)`;
        fixturesCreated = true;
    });
    beforeEach(async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '1');
        vi.stubEnv('EZIL_AWS_KILL_SWITCH', '0');
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'synthetic-only');
        for (const mock of [h.route, h.ensure, h.status, h.gate, h.ready, h.prepare]) mock.mockReset();
        h.services = true;
        h.route.mockImplementation(async () => aws());
        h.gate.mockResolvedValue({ allowed: true });
        h.ensure.mockResolvedValue({ ok: false, errorCode: 'computer_starting', retryable: true });
        h.prepare.mockResolvedValue(undefined);
        h.status.mockResolvedValue({ ok: true, state: 'starting', placementState: 'MOUNTING' });
        computer = { userId, computerId: randomUUID() };
        key = randomUUID();
        await client`INSERT INTO public.ezil_computers (id, user_id, name, slot) VALUES (${computer.computerId}::uuid, ${userId}::uuid, 'synthetic', 1)`;
    });
    afterEach(async () => {
        vi.unstubAllEnvs();
        // Delete only this suite's fixtures, including receipts whose computer changed owner.
        await client`DELETE FROM public.ezil_control_operations WHERE user_id = ${userId}::uuid`;
        await client`DELETE FROM public.ezil_computers WHERE id = ${computer.computerId}::uuid`;
    });
    afterAll(async () => {
        if (client) {
            try {
                if (fixturesCreated) await client`DELETE FROM auth.users WHERE id IN (${userId}::uuid, ${other}::uuid)`;
            } finally { await client.end(); }
        }
    });

    it('recovers AWS readiness through status; retry never dispatches, rerates or primes again', async () => {
        const accepted = await start();
        expect(accepted).toMatchObject({ status: 'starting', reason: null });
        expect(await row()).toMatchObject({ reason: 'aws_wake_dispatched:m6i.large' });
        expect(await start()).toEqual(accepted);
        h.gate.mockResolvedValue({ allowed: false, reason: 'no_plan' });
        await poll();
        expect(await row()).toMatchObject({ status: 'starting' });
        h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
        await poll();
        expect(await start()).toMatchObject({ id: accepted.id, status: 'running', reason: null });
        expect(h.ensure).toHaveBeenCalledTimes(1);
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.gate).toHaveBeenCalledTimes(1);
        expect(h.ready).not.toHaveBeenCalled();
        expect(h.route.mock.calls.filter(([, , opts]) => opts.pinCloudflare)).toHaveLength(1);
    });

    it('returns a durable receipt within two seconds for a still-pending AWS boot', async () => {
        let release!: (answer: { ok: boolean }) => void;
        h.ensure.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        try {
            const accepted = await start();
            expect(accepted).toMatchObject({ status: 'starting', reason: null });
            expect(await start()).toEqual(accepted);
            // Another process can observe the admitted wake while the original call is in flight.
            h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
            await poll();
            release({ ok: true });
            expect(await row()).toMatchObject({ status: 'running' });
            expect(h.ensure).toHaveBeenCalledTimes(1);
        } finally { release?.({ ok: true }); }
    }, 10_000);

    it('records bounded failures, and a later running status cannot overwrite the terminal receipt', async () => {
        await start();
        h.status.mockResolvedValue({ ok: false, state: 'error', error: 'placement_unconfirmed' });
        await poll();
        expect(await row()).toMatchObject({ status: 'failed', reason: 'placement_unconfirmed' });
        const terminal = await row();
        h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
        await poll();
        expect(await row()).toEqual(terminal);
        expect(h.status).toHaveBeenCalledTimes(1);
        expect(h.ensure).toHaveBeenCalledTimes(1);
    });

    it.each(['before', 'during'])('does not publish or observe the previous owner after transfer %s status', async when => {
        await start();
        const transfer = () => client`UPDATE public.ezil_computers SET user_id = ${other}::uuid WHERE id = ${computer.computerId}::uuid`;
        if (when === 'before') await transfer();
        else h.status.mockImplementation(async () => { await transfer(); return { ok: true, state: 'running', placementState: 'RUNNING' }; });
        await poll();
        expect(await row()).toMatchObject({ status: 'starting', reason: 'aws_wake_dispatched:m6i.large' });
        expect(h.status).toHaveBeenCalledTimes(when === 'before' ? 0 : 1);
        expect(h.ready).not.toHaveBeenCalled();
        expect(h.ensure).toHaveBeenCalledTimes(1);
    });

    it.each(['provider', 'size', 'move'])('refuses a changed %s without querying the new provider', async change => {
        await start();
        h.route.mockResolvedValue(change === 'provider' ? { kind: 'cloudflare', provider: { status: h.status } }
            : { ...aws(), ...(change === 'size' ? { instanceType: 'm6i.xlarge' } : { reverse: 'moving' }) });
        await poll();
        expect(await row()).toMatchObject({ status: 'failed', reason: 'route_changed' });
        expect(h.status).not.toHaveBeenCalled();
        expect(h.ensure).toHaveBeenCalledTimes(1);
    });

    it('retains an ambiguous boot throw for status recovery, without a second dispatch', async () => {
        h.ensure.mockRejectedValue(new Error('synthetic lost response'));
        const accepted = await start();
        expect(accepted).toMatchObject({ status: 'starting', reason: null });
        expect(await start()).toEqual(accepted);
        h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
        await poll();
        expect(await row()).toMatchObject({ status: 'running' });
        expect(h.ensure).toHaveBeenCalledTimes(1);
        expect(h.gate).toHaveBeenCalledTimes(1);
    });

    it('expires ambiguous/legacy receipts without consulting a provider or manufacturing ready', async () => {
        await start();
        await age(301);
        h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
        await poll();
        expect(await row()).toMatchObject({ status: 'failed', reason: 'readiness_unconfirmed' });
        await client`UPDATE public.ezil_control_operations SET status = 'starting', reason = NULL WHERE idempotency_key = ${key}::uuid`;
        await poll();
        expect(await row()).toMatchObject({ status: 'failed', reason: 'readiness_unconfirmed' });
        expect(h.status).not.toHaveBeenCalled();
    });

    it('leaves thrown observations leased and closes uncertainty after the original deadline', async () => {
        await start();
        h.status.mockRejectedValue(new Error('synthetic status unavailable'));
        await poll();
        expect(await row()).toMatchObject({ status: 'starting', attempt_id: expect.any(String) });
        await poll();
        expect(h.status).toHaveBeenCalledTimes(1);
        await age(301);
        await client`UPDATE public.ezil_control_operations SET not_before = now() - interval '1 second' WHERE idempotency_key = ${key}::uuid`;
        await poll();
        expect(await row()).toMatchObject({ status: 'failed', reason: 'readiness_unconfirmed', attempt_id: null });
    });

    it('fences stale observers after claim expiry and rejects a late ready result', async () => {
        await start();
        let release!: (outcome: BootOutcome) => void;
        const observer = vi.fn(() => new Promise<BootOutcome>(resolve => { release = resolve; }));
        const first = reconcileColdStart(db, caller, key, observer);
        try {
            await expect.poll(() => observer.mock.calls.length).toBe(1);
            await poll();
            expect(h.status).not.toHaveBeenCalled();
            await client`UPDATE public.ezil_control_operations SET not_before = now() - interval '1 second' WHERE idempotency_key = ${key}::uuid`;
            h.status.mockResolvedValue({ ok: false, state: 'error', error: 'placement_unconfirmed' });
            await poll();
            const failed = await row();
            release({ state: 'running' });
            await first;
            expect(await row()).toEqual(failed);
            expect(failed).toMatchObject({ status: 'failed', reason: 'placement_unconfirmed' });
        } finally { release?.({ state: 'starting' }); await first; }
    });

    it('bounds a stalled observation and ignores its late ready answer', async () => {
        await start();
        let release!: (outcome: BootOutcome) => void;
        try {
            await reconcileColdStart(db, caller, key, () => new Promise<BootOutcome>(resolve => { release = resolve; }));
            expect(await row()).toMatchObject({ status: 'starting', attempt_id: expect.any(String) });
            await age(301);
            await client`UPDATE public.ezil_control_operations SET not_before = now() - interval '1 second' WHERE idempotency_key = ${key}::uuid`;
            await poll();
            release({ state: 'running' });
            expect(await row()).toMatchObject({ status: 'failed', reason: 'readiness_unconfirmed' });
            expect(h.status).not.toHaveBeenCalled();
        } finally { release?.({ state: 'starting' }); }
    }, 10_000);

    it('cannot publish an answer that crosses the five-minute deadline while observing', async () => {
        await start();
        h.status.mockImplementation(async () => {
            await age(301);
            return { ok: true, state: 'running', placementState: 'RUNNING' };
        });
        await poll();
        expect(await row()).toMatchObject({ status: 'failed', reason: 'readiness_unconfirmed' });
    });

    it('honors service and AWS kill gates and resumes status after gates reopen', async () => {
        await start();
        h.services = false;
        await poll();
        expect(h.status).not.toHaveBeenCalled();
        h.services = true;
        vi.stubEnv('EZIL_AWS_KILL_SWITCH', '1');
        await poll();
        expect(h.status).not.toHaveBeenCalled();
        vi.stubEnv('EZIL_AWS_KILL_SWITCH', '0');
        h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
        await poll();
        expect(await row()).toMatchObject({ status: 'running' });
        expect(h.ensure).toHaveBeenCalledTimes(1);
    });

    it('supports a restarted sweep with the stable observer export', async () => {
        await start();
        await age(240);
        // Other qualification suites can share this disposable DB. Make our receipt first in the bounded batch.
        await client`UPDATE public.ezil_control_operations SET updated_at = '1970-01-01'::timestamptz WHERE idempotency_key = ${key}::uuid`;
        const fresh = postgres(url!, { max: 1, prepare: false, onnotice: () => {} });
        try {
            const restarted = drizzle(fresh);
            h.status.mockResolvedValue({ ok: true, state: 'running', placementState: 'RUNNING' });
            await reconcileColdStarts(restarted, c => c.userId === userId ? observeAdmittedStart(restarted, c) : Promise.resolve({ state: 'starting' }));
            expect(await row()).toMatchObject({ status: 'running' });
            expect(h.ensure).toHaveBeenCalledTimes(1);
            expect(h.ready).not.toHaveBeenCalled();
        } finally { await fresh.end(); }
    });
});
