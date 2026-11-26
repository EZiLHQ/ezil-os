import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ placement: vi.fn(), own: vi.fn(), config: vi.fn() }));
vi.mock('@/server/lib/compute/placement', () => ({ readPlacement: h.placement }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({
    deriveGuacamoleSandboxId: () => 'guac-fixture',
    resolveCloudflareGuacamoleConfig: h.config,
}));
import { readSettingsAiBalance } from './account-ai-balance';

type BalanceFetch = NonNullable<Parameters<typeof readSettingsAiBalance>[4]>;

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const db = { query: { computers: { findFirst: h.own } } } as unknown as Parameters<typeof readSettingsAiBalance>[0];
const placement = {
    provider: 'cloudflare',
    record: { provider: 'cloudflare', state: 'STOPPED', generation: 1, leaseEpoch: 0, updatedAt: new Date('2026-11-21T00:00:00Z') },
};
beforeEach(() => {
    vi.stubEnv('EZIL_PREVIEW_TOKEN_V2', '1');
    vi.stubEnv('EZIL_EDITOR_WORKER_PROTOCOL', '2');
    vi.stubEnv('EZIL_EDITOR_WORKER_ORIGIN', 'https://worker.example.test');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example.test');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'synthetic-stage-signing-fixture');
    h.own.mockReset().mockResolvedValue({ id: computerId });
    h.placement.mockReset().mockResolvedValue(placement);
    h.config.mockReset().mockReturnValue({ isConfigured: true, workerUrl: 'https://worker.example.test' });
});
afterEach(() => vi.unstubAllEnvs());

describe('Settings AI balance', () => {
    it('performs one fixed bounded read signed with the verified owner and exact current placement', async () => {
        const fetch = vi.fn<BalanceFetch>(async () => Response.json({ balanceMicro: '123', heldMicro: '4' }));
        expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toEqual({ balanceMicro: '123', heldMicro: '4' });
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe('https://worker.example.test/sandbox/guac-fixture/ai-credential');
        expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
        expect(init?.body).toBeUndefined();
        const headers = new Headers(init?.headers);
        expect(headers.has('authorization')).toBe(false);
        const [_, claims] = headers.get('x-ezil-auth')!.split('.');
        expect(JSON.parse(Buffer.from(claims!, 'base64url').toString('utf8'))).toMatchObject({
            userId, computerId, provider: 'cloudflare', generation: 1, leaseEpoch: 0,
        });
        expect(h.placement.mock.calls).toEqual([[db, computerId, userId], [db, computerId, userId]]);
    });

    it('accepts an explicit legacy Cloudflare pin and lets the Worker confirm its boot', async () => {
        h.placement.mockResolvedValue({ ...placement, record: { ...placement.record, generation: 0, state: 'RUNNING' } });
        const fetch = vi.fn<BalanceFetch>(async () => Response.json({ balanceMicro: '0', heldMicro: '0' }));
        expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toEqual({ balanceMicro: '0', heldMicro: '0' });
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not request a Worker for zero, foreign, absent, AWS, moving, or unconfigured placement', async () => {
        const fetch = vi.fn<BalanceFetch>();
        expect(await readSettingsAiBalance(db, userId, [], undefined, fetch)).toBeNull();
        expect(h.own).not.toHaveBeenCalled();
        h.own.mockResolvedValueOnce(undefined);
        expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toBeNull();
        for (const record of [
            null,
            { ...placement.record, provider: 'aws-ec2' },
            { ...placement.record, state: 'RETIRING' },
            { ...placement.record, generation: 2 },
            { ...placement.record, leaseEpoch: 1 },
        ]) {
            h.placement.mockResolvedValueOnce({ ...placement, record });
            expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toBeNull();
        }
        h.config.mockReturnValueOnce({ isConfigured: true, workerUrl: 'https://api-desktop.ezil.work' });
        expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toBeNull();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects relayed values when placement has moved or the response shape contains anything else', async () => {
        const fetch = vi.fn<BalanceFetch>(async () => Response.json({ balanceMicro: '0', heldMicro: '0' }));
        h.placement.mockResolvedValueOnce(placement)
            .mockResolvedValueOnce({ ...placement, record: { ...placement.record, updatedAt: new Date('2026-11-21T00:01:00Z') } });
        expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toBeNull();
        fetch.mockResolvedValueOnce(Response.json({ balanceMicro: '0', heldMicro: '0', extra: 'fixture-metadata' }));
        expect(await readSettingsAiBalance(db, userId, [computerId], undefined, fetch)).toBeNull();
    });
});
