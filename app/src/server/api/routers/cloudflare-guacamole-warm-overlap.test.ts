/**
 * WARM-118 (root ROOT-WARM-OPTIMIZATIONS-118 #3): in codePreviewUrl, after the ownership and billing gates, the
 * AWS-only AI credential sync overlaps the first provider ensure. Both settle before any preview or relay preparation;
 * an ensure rejection is rethrown only after the sync drains. Driven through the real router procedure.
 */
import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owned: true, billing: true as boolean }));
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const calls = vi.hoisted(() => [] as string[]);
const ensure = vi.hoisted(() => vi.fn());
const sync = vi.hoisted(() => vi.fn());
const preview = vi.hoisted(() => vi.fn());
const prepare = vi.hoisted(() => vi.fn());
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date(), config: {} }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: async () => state.billing
    ? { allowed: true } : { allowed: false, reason: 'no_allowance' } }));
vi.mock('@/server/billing/v2/compute-meter-observation', () => ({ recordComputeMeter: async () => 'ok' }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown; headers: Headers }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure, createTRPCContext: async () => ({}) };
});
vi.mock('@/server/lib/cloudflare-guacamole-provider', async original => ({
    ...await original<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true }),
}));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: sync }));
vi.mock('@/server/lib/compute/aws-preview', () => ({
    requestAwsPreview: preview, prepareAwsPoolSession: prepare, waitForAwsPreviewPlacement: async () => false,
}));
vi.mock('@/server/api/routers/compute-dispatch', async original => ({
    ...await original<Record<string, unknown>>(),
    routeComputer: async () => ({ kind: 'aws-ec2', instanceType: 'm6i.large', provider: { ensure } }),
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
const caller = () => cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, headers: new Headers({ cookie: 'session=1' }),
    db: { query: { computers: { findFirst: async () => state.owned ? { id: computerId } : undefined } } } } as never);
const tick = () => new Promise(r => setTimeout(r, 0));
function held<T>() { let release!: (v: T) => void; let fail!: (e: unknown) => void;
    const promise = new Promise<T>((r, f) => { release = r; fail = f; }); return { promise, release, fail }; }

beforeEach(() => {
    state.owned = true; state.billing = true; calls.length = 0;
    for (const f of [ensure, sync, preview, prepare]) f.mockReset();
    preview.mockImplementation(async () => { calls.push('preview'); return { ok: true, provider: 'aws-ec2', codePreviewUrl: 'https://x' }; });
    prepare.mockImplementation(async () => { calls.push('prepare'); });
});

describe('codePreviewUrl overlaps the AWS credential sync with ensure (WARM-118)', () => {
    it('a delayed sync overlaps exactly one ensure; preview waits for BOTH', async () => {
        const s = held<{ ok: true }>();
        sync.mockImplementation(() => { calls.push('sync:start'); return s.promise.then(v => { calls.push('sync:end'); return v; }); });
        ensure.mockImplementation(async () => { calls.push('ensure'); return { ok: true }; });
        let settled = false;
        const pending = caller().codePreviewUrl({ computerId }).then(r => { settled = true; return r; });
        for (let i = 0; i < 20 && ensure.mock.calls.length === 0; i++) await tick();
        expect(ensure).toHaveBeenCalledOnce(); // started while the sync is still in flight
        expect([...calls].sort()).toEqual(['ensure', 'sync:start']); // both in flight together
        expect(settled).toBe(false);
        expect(preview).not.toHaveBeenCalled();
        s.release({ ok: true });
        expect(await pending).toMatchObject({ ok: true });
        expect(calls.slice(2)).toEqual(['sync:end', 'preview']); // preview only after BOTH settled
        expect(ensure).toHaveBeenCalledOnce();
        // The credential is synced for the session user only (another user's session is refused inside
        // syncAiCredential: ai-credential.test.ts "refuses bearer callers, missing sessions and another user's session").
        expect(sync.mock.calls[0]![0]).toMatchObject({ userId });
    });

    it('a starting computer prepares the relay only after BOTH settled', async () => {
        const s = held<{ ok: true }>();
        sync.mockImplementation(() => s.promise.then(v => { calls.push('sync:end'); return v; }));
        ensure.mockImplementation(async () => { calls.push('ensure'); return { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true }; });
        const pending = caller().codePreviewUrl({ computerId });
        for (let i = 0; i < 20 && ensure.mock.calls.length === 0; i++) await tick();
        expect(prepare).not.toHaveBeenCalled();
        s.release({ ok: true });
        await pending;
        expect(calls.indexOf('sync:end')).toBeLessThan(calls.indexOf('prepare'));
    });

    it('denied ownership or billing starts neither the sync nor an ensure', async () => {
        state.owned = false;
        await expect(caller().codePreviewUrl({ computerId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        state.owned = true; state.billing = false;
        expect(await caller().codePreviewUrl({ computerId })).toMatchObject({ ok: false, errorCode: 'billing_no_allowance' });
        expect(sync).not.toHaveBeenCalled();
        expect(ensure).not.toHaveBeenCalled();
    });

    it('an ensure rejection is rethrown only after the sync drains, with no preview, preparation or published URL', async () => {
        const s = held<{ ok: true }>();
        sync.mockImplementation(() => s.promise.then(v => { calls.push('sync:end'); return v; }));
        ensure.mockImplementation(async () => { calls.push('ensure'); throw new Error('ensure exploded'); });
        let rejected = false;
        const pending = caller().codePreviewUrl({ computerId }).then(() => 'resolved', (e: Error) => { rejected = true; return e.message; });
        for (let i = 0; i < 20 && ensure.mock.calls.length === 0; i++) await tick();
        await tick(); await tick();
        expect(rejected).toBe(false); // not while the sync is still running
        s.release({ ok: true });
        expect(await pending).toBe('ensure exploded');
        expect(calls).toEqual(['ensure', 'sync:end']);
        expect(preview).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
    });
});
