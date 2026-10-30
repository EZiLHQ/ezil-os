/**
 * Follow-up r5 (ACCEPT-9a755827 e2e-standard A3). Code failed on its first `confirm=frame` ask and
 * nothing recorded WHICH hop answered or with what status: `confirmFrame` logged nothing on a
 * negative. It now logs exactly one JSON line per probe negative — `{event:'frame-confirm',
 * computer:<8-char prefix>, reason, status}` — and never the frameUrl, its token, or the probe's
 * `detail` (which can quote the URL it failed on). Driven through the real router procedure.
 */
import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const probe = vi.hoisted(() => vi.fn());
// The router module's import graph, stubbed exactly as the sibling router tests do (stop-cooldown).
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date(), config: {} }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: async () => ({ allowed: true }) }));
vi.mock('@/server/billing/v2/compute-meter-observation', () => ({ recordComputeMeter: async () => 'ok' }));
vi.mock('./computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: vi.fn() }));
vi.mock('@/server/lib/compute/aws-preview', () => ({
    requestAwsPreview: vi.fn(), prepareAwsPoolSession: vi.fn(async () => {}), waitForAwsPreviewPlacement: async () => false,
}));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown; headers: Headers }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure, createTRPCContext: async () => ({}) };
});
vi.mock('@/server/lib/cloudflare-guacamole-provider', async original => ({
    ...await original<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true }),
    probeDesktopFrame: probe,
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';

const caller = () => cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, headers: new Headers(),
    db: { query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never);
const TOKEN = 't=1761700000,v1=deadbeefcafe';
const frameUrl = () => `https://8443-${deriveGuacamoleSandboxId(userId, computerId)}-code.worker.example/preview-bootstrap?token=${TOKEN}`;

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
let spies: ReturnType<typeof vi.spyOn>[] = [];
const lines = () => spies.flatMap(spy => spy.mock.calls.map(args => args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')));

beforeEach(() => {
    probe.mockReset();
    spies = METHODS.map(m => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => { for (const spy of spies) spy.mockRestore(); });

describe('confirmFrame names the failing hop on a negative', () => {
    it('🔴 http_error 530: exactly one JSON line with the computer prefix, reason and status — no URL, token or detail', async () => {
        probe.mockResolvedValue({ alive: false, reason: 'http_error', status: 530, detail: `GET ${frameUrl()} failed token=${TOKEN}` });
        const answer = await caller().confirmFrame({ computerId, frameUrl: frameUrl() });
        expect(answer).toEqual({ confirmed: false, reason: 'http_error', status: 530 });
        expect(probe).toHaveBeenCalledOnce();
        const all = lines();
        expect(all).toHaveLength(1);
        expect(JSON.parse(all[0])).toEqual({ event: 'frame-confirm', computer: computerId.slice(0, 8), reason: 'http_error', status: 530 });
        for (const line of all) {
            expect(line).not.toContain('token=');
            expect(line).not.toContain(TOKEN);
            expect(line).not.toContain('preview-bootstrap');
            expect(line).not.toContain('worker.example');
            expect(line).not.toContain(computerId);
            expect(line).not.toContain('failed');
        }
    });

    it.each([401, 404, 410, 502])('http_error %i is logged with its origin status', async status => {
        probe.mockResolvedValue({ alive: false, reason: 'http_error', status });
        await caller().confirmFrame({ computerId, frameUrl: frameUrl() });
        expect(lines().map(l => JSON.parse(l))).toEqual([{ event: 'frame-confirm', computer: '22222222', reason: 'http_error', status }]);
    });

    it('unreachable (no status) is logged with status null, never the detail', async () => {
        probe.mockResolvedValue({ alive: false, reason: 'unreachable', detail: `TypeError: fetch failed token=${TOKEN}` });
        await caller().confirmFrame({ computerId, frameUrl: frameUrl() });
        const all = lines();
        expect(all.map(l => JSON.parse(l))).toEqual([{ event: 'frame-confirm', computer: '22222222', reason: 'unreachable', status: null }]);
        expect(all.join('\n')).not.toMatch(/token=|fetch failed/);
    });

    it('a confirmed frame logs nothing', async () => {
        probe.mockResolvedValue({ alive: true, status: 200 });
        expect(await caller().confirmFrame({ computerId, frameUrl: frameUrl() })).toEqual({ confirmed: true, status: 200 });
        expect(lines()).toEqual([]);
    });
});
