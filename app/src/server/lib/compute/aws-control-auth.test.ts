/**
 * Control helpers under v2 auth (compute/aws-control-auth.ts): the request carries the v2
 * envelope the Worker itself verifies (worker/src/hmac.ts), over the exact method, path and
 * body sent, and no v1 bearer. Under v1 the legacy bearer is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyPreviewTokenV2 } from '../../../../../worker/src/hmac';
import {
    readGuacamoleScreen,
    requestGuacamoleFocusApp,
    requestGuacamoleScreen,
    requestRelayRefresh,
    type CloudflareGuacamoleConfig,
} from '../cloudflare-guacamole-provider';
import type { WorkerAuth } from './preview-token-v2';

const SECRET = 'control-helper-secret';
const SID = 'guac-1111111111114111-2222222222224222';
const config = { isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true } as CloudflareGuacamoleConfig;
const v2: WorkerAuth = {
    kind: 'v2',
    claims: { sandboxId: SID, computerId: '22222222-2222-4222-8222-222222222222', userId: '11111111-1111-4111-8111-111111111111', provider: 'aws-ec2', store: '', generation: 4, leaseEpoch: 7 },
};

type Seen = { url: string; method: string; headers: Headers; body: string };
function stubFetch(answer: unknown) {
    const seen: Seen[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        seen.push({ url, method: String(init.method), headers: new Headers(init.headers), body: typeof init.body === 'string' ? init.body : '' });
        return new Response(JSON.stringify(answer), { status: 200 });
    }));
    return seen;
}

afterEach(() => vi.unstubAllGlobals());

const calls: [string, (auth: WorkerAuth) => Promise<unknown>, unknown][] = [
    ['focus', (auth) => requestGuacamoleFocusApp(config, SECRET, SID, 'chromium', 'c1', auth), { ok: true }],
    ['screen read', (auth) => readGuacamoleScreen(config, SECRET, SID, 'c1', auth), { ok: true, width: 1920, height: 1080 }],
    ['screen set', (auth) => requestGuacamoleScreen(config, SECRET, SID, 1920, 1080, 'c1', auth), { ok: true, width: 1920, height: 1080, verified: true }],
    ['relay read', (auth) => requestRelayRefresh(config, SECRET, SID, 'c1', undefined, auth), { ok: true, runtimeId: 'a'.repeat(32), expiresAt: 1 }],
    ['relay renew', (auth) => requestRelayRefresh(config, SECRET, SID, 'c1', 'b'.repeat(32), auth), { ok: true, runtimeId: 'b'.repeat(32), expiresAt: 1 }],
];

describe('control helpers', () => {
    it.each(calls)('%s under v2: the Worker verifies the envelope over the exact request; no bearer', async (_name, call, answer) => {
        const seen = stubFetch(answer);
        await call(v2);
        expect(seen).toHaveLength(1);
        const s = seen[0]!;
        expect(s.headers.get('authorization')).toBeNull();
        const verdict = await verifyPreviewTokenV2(s.headers.get('x-ezil-auth'), SECRET, { method: s.method, path: new URL(s.url).pathname, body: s.body });
        expect(verdict).toMatchObject({ ok: true, claims: { provider: 'aws-ec2', sandboxId: SID, generation: 4, leaseEpoch: 7 } });
    });

    it.each(calls)('%s under v1: the legacy bearer, no v2 envelope', async (_name, call, answer) => {
        const seen = stubFetch(answer);
        await call({ kind: 'v1' });
        expect(seen[0]!.headers.get('authorization')).toMatch(/^Bearer t=\d+,v1=[a-f0-9]{64}$/);
        expect(seen[0]!.headers.get('x-ezil-auth')).toBeNull();
    });

    it('v2 without a secret refuses before any request', async () => {
        const seen = stubFetch({ ok: true });
        expect(await requestGuacamoleFocusApp(config, '', SID, 'chromium', 'c1', v2)).toMatchObject({ ok: false });
        expect(await requestRelayRefresh(config, ' ', SID, 'c1', undefined, v2)).toEqual({ ok: false, error: 'hmac_secret_not_configured' });
        expect(seen).toEqual([]);
    });
});
