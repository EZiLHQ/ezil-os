// Round 6 (R3-2/R3-8): one JSON `aws-preview` line per non-ok answer to an AWS computer's desktop, app or
// Code ask. Live 10-30 05:42-05:44Z the Code mint was answered "starting" every ~2 s for two minutes and
// the web log had no line for any of it.
import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

const mocks = vi.hoisted(() => ({ route: vi.fn(), ensure: vi.fn(), gate: vi.fn(), cooldown: vi.fn(), preview: vi.fn() }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure };
});
vi.mock('./compute-dispatch', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), routeComputer: mocks.route, stopCooldownAnswer: mocks.cooldown,
}));
vi.mock('./computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ config: { enforcementEnabled: false, tabEnabled: false }, now: () => new Date() }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: mocks.gate }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: vi.fn(async () => {}) }));
vi.mock('@/server/lib/compute/aws-clients', () => ({
    sharedAwsSdkCollaborators: () => { throw new Error('Unexpected AWS client construction'); },
}));
vi.mock('@/server/lib/compute/aws-preview', async original => ({
    ...await original<Record<string, unknown>>(), requestAwsPreview: mocks.preview, prepareAwsPoolSession: vi.fn(async () => {}),
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, hasHmacSecret: true, workerUrl: 'https://worker.test/' }),
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const surfaces = [['desktop', 'previewUrl'], ['app', 'appPreviewUrl'], ['code', 'codePreviewUrl']] as const;
type Procedure = typeof surfaces[number][1];
let info: { mock: { calls: unknown[][] } };
const lines = () => info.mock.calls.map(c => String(c[0])).filter(l => l.includes('"event":"aws-preview"')).map(l => JSON.parse(l) as Record<string, unknown>);

function caller() {
    const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: userId, state: 'RUNNING', generation: 7, lease_epoch: 11 })] });
    return cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, db: { ...fake.db,
        query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never);
}
const ask = (procedure: Procedure) => procedure === 'previewUrl'
    ? caller().previewUrl({ computerId, sessionId: computerId }) : caller()[procedure]({ computerId });

beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@/server/lib/compute/aws-preview')>('@/server/lib/compute/aws-preview');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-secret');
    vi.stubEnv('EZIL_AWS_BROWSER_ZONE', 'preview.example');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false, error: 'aws_desktop_starting', detail: 'LEAK https://x.test/?token=LEAK' }, { status: 503 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    info = vi.spyOn(console, 'info').mockImplementation(() => {});
    mocks.route.mockReset().mockResolvedValue({ kind: 'aws-ec2', provider: { ensure: mocks.ensure }, instanceType: 'm6i.large' });
    mocks.ensure.mockReset().mockResolvedValue({ ok: true });
    mocks.gate.mockReset().mockResolvedValue({ allowed: true });
    mocks.cooldown.mockReset().mockResolvedValue(null);
    // The real preview request against a RUNNING placement; only the Worker (fetch) is faked.
    mocks.preview.mockReset().mockImplementation(actual.requestAwsPreview);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(surfaces)('%s (%s): one aws-preview line per non-ok answer', (surface, procedure) => {
    it('the Worker answered 503 aws_desktop_starting (the live Code stall): its code and status', async () => {
        expect(await ask(procedure)).toMatchObject({ ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' });
        expect(lines()).toEqual([{ event: 'aws-preview', surface, computer: '22222222', status: 503, error: 'sandbox_starting',
            reason: 'aws_desktop_starting', ms: expect.any(Number) }]);
    });
    it('an ensure refusal that never reached the preview: the ensure code', async () => {
        mocks.ensure.mockResolvedValue({ ok: false, error: 'computer_stopping', errorCode: 'computer_stopping', retryable: true });
        expect(await ask(procedure)).toMatchObject({ ok: false, errorCode: 'sandbox_starting' });
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(lines()).toEqual([{ event: 'aws-preview', surface, computer: '22222222', status: null, error: 'sandbox_starting',
            reason: 'computer_stopping', ms: expect.any(Number) }]);
    });
    it('a billing refusal on an AWS computer; none for a Cloudflare one', async () => {
        mocks.gate.mockResolvedValue({ allowed: false, reason: 'fair_use_paused' });
        expect(await ask(procedure)).toMatchObject({ ok: false, errorCode: 'billing_fair_use_paused' });
        expect(lines()).toMatchObject([{ surface, status: null, error: 'billing_fair_use_paused', reason: 'billing_fair_use_paused' }]);
        mocks.route.mockResolvedValue({ kind: 'cloudflare', provider: { ensure: mocks.ensure } });
        await ask(procedure);
        expect(lines()).toHaveLength(1);
    });
    it('an ok answer writes nothing', async () => {
        vi.mocked(fetch).mockResolvedValue(Response.json({ ok: false, error: 'other' }, { status: 200 }));
        mocks.preview.mockResolvedValue({ ok: true, guacamoleUrl: 'https://x.test/', appPreviewUrl: 'https://x.test/', codePreviewUrl: 'https://x.test/' });
        await ask(procedure);
        expect(lines()).toEqual([]);
    });
    it('never writes a URL, token, body or full id', async () => {
        await ask(procedure);
        // A code that is not a bounded code is never echoed.
        mocks.ensure.mockResolvedValue({ ok: false, error: 'LEAK', errorCode: 'https://LEAK.test/?token=LEAK', retryable: false });
        await ask(procedure);
        const raw = info.mock.calls.map(c => String(c[0])).filter(l => l.includes('aws-preview')).join('\n');
        expect(lines()).toHaveLength(2);
        expect(lines()[1]).toMatchObject({ error: 'other', reason: 'other' });
        expect(raw).not.toMatch(/https?:|token|LEAK|preview\.example|11111111|2222-/i);
    });
});

describe.each([['app', 'appPreviewUrl'], ['code', 'codePreviewUrl']] as const)('%s: the stop hold', (surface, procedure) => {
    it('a just-stopped computer: computer_stopped, without ensure', async () => {
        mocks.cooldown.mockResolvedValue({ ok: false, error: 'computer_stopped', errorCode: 'computer_stopped', retryable: false,
            provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2' });
        expect(await ask(procedure)).toMatchObject({ ok: false, errorCode: 'computer_stopped' });
        expect(mocks.ensure).not.toHaveBeenCalled();
        expect(lines()).toMatchObject([{ surface, status: null, error: 'computer_stopped', reason: 'computer_stopped' }]);
    });
});
