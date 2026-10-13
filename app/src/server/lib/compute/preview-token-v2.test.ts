/**
 * P4b contract: the app's v2 minter against the Worker's verifier.
 *
 * - The shared vectors (`worker/src/preview-token-v2.vectors.json`) pin both
 *   minters to the same bytes; `worker/src/hmac-v2.test.ts` holds the Worker
 *   to the same constants.
 * - A request the adapter actually puts on the wire, with the flag on, is
 *   verified by the Worker's REAL `verifyPreviewTokenV2` over the captured
 *   method, path and body.
 * - Flag off (the default): no v2 header, today's v1 envelope unchanged.
 *
 * `fetch` is stubbed; nothing leaves the process.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import vectors from '../../../../../worker/src/preview-token-v2.vectors.json';
import { verifyPreviewTokenV2 } from '../../../../../worker/src/hmac';
import { deriveGuacamoleSandboxId, type CloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';

import { createCloudflareComputeProvider } from './cloudflare';
import { mintPreviewTokenV2, previewTokenV2Enabled, type PreviewTokenV2Claims } from './preview-token-v2';

describe('shared vectors: the app minter emits the fixture tokens byte for byte', () => {
    for (const v of vectors.valid) {
        it(v.name, () => {
            expect(mintPreviewTokenV2(vectors.secret, v.claims as PreviewTokenV2Claims, {
                method: v.method, path: v.path, body: v.body,
            })).toBe(v.token);
        });
    }
    it('refuses to mint without a secret, or with a field that could break the framing', () => {
        const v = vectors.valid[0]!;
        const req = { method: v.method, path: v.path, body: v.body };
        expect(() => mintPreviewTokenV2('', v.claims as PreviewTokenV2Claims, req)).toThrow('hmac_secret_not_configured');
        expect(() => mintPreviewTokenV2(vectors.secret, { ...(v.claims as PreviewTokenV2Claims), userId: 'a|b' }, req)).toThrow();
        expect(() => mintPreviewTokenV2(vectors.secret, { ...(v.claims as PreviewTokenV2Claims), store: 'gcs' as never }, req)).toThrow();
    });
});

describe('EZIL_PREVIEW_TOKEN_V2 flag', () => {
    it('is on only for the exact value 1', () => {
        expect(previewTokenV2Enabled({})).toBe(false);
        for (const off of ['0', 'true', 'yes', '']) expect(previewTokenV2Enabled({ EZIL_PREVIEW_TOKEN_V2: off })).toBe(false);
        expect(previewTokenV2Enabled({ EZIL_PREVIEW_TOKEN_V2: '1' })).toBe(true);
    });
});

interface Wire { method: string; url: string; headers: Record<string, string>; body: string }

describe('adapter wire: the Worker verifier accepts what the app sends', () => {
    const config: CloudflareGuacamoleConfig = { workerUrl: 'https://worker.example/', hasHmacSecret: true, isConfigured: true };
    const secret = 'test-only-hmac-secret';
    const computer = { userId: '11111111-1111-4111-8111-111111111111', computerId: '22222222-2222-4222-8222-222222222222' };
    const sandboxName = deriveGuacamoleSandboxId(computer.userId, computer.computerId);
    const ctx = { correlationId: 'corr-p4b' };
    let wire: Wire[] = [];

    beforeEach(() => {
        wire = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
            wire.push({
                method: init.method ?? 'GET',
                url: String(url),
                headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
                body: typeof init.body === 'string' ? init.body : '',
            });
            return Response.json({ ok: true, terminated: true });
        }));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    const v2 = createCloudflareComputeProvider({ resolveConfig: () => config, readHmacSecret: () => secret, useTokenV2: () => true });
    const v1 = createCloudflareComputeProvider({ resolveConfig: () => config, readHmacSecret: () => secret, useTokenV2: () => false });

    async function verifyCaptured(w: Wire) {
        const u = new URL(w.url);
        return verifyPreviewTokenV2(w.headers['x-ezil-auth'], secret, { method: w.method, path: u.pathname, body: w.body });
    }
    const expectedClaims = {
        sandboxId: sandboxName, computerId: computer.computerId, userId: computer.userId,
        provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0,
    };

    it('ensure: v2 header verifies over the exact body, which carries no token', async () => {
        await v2.ensure(ctx, computer, { sessionId: '33333333-3333-4333-8333-333333333333', desktopMode: 'neko' });
        const [w] = wire;
        expect(w!.url).toBe('https://worker.example/sandbox/preview');
        expect(JSON.parse(w!.body)).not.toHaveProperty('token');
        const r = await verifyCaptured(w!);
        expect(r).toMatchObject({ ok: true, claims: expectedClaims });
        // The body the Worker digests is the one that was signed: changing it breaks the signature.
        expect(await verifyPreviewTokenV2(w!.headers['x-ezil-auth'], secret,
            { method: 'POST', path: '/sandbox/preview', body: w!.body.replace('neko', 'guac') })).toMatchObject({ ok: false });
    });

    it('terminate (DELETE, empty body), activity and restart all verify', async () => {
        await v2.terminate(ctx, computer);
        await v2.activity(ctx, computer, { lastInputAgoMs: 1200 });
        await v2.restart(ctx, computer);
        expect(wire.map((w) => `${w.method} ${new URL(w.url).pathname}`)).toEqual([
            `DELETE /sandbox/${sandboxName}`,
            `POST /sandbox/${sandboxName}/activity`,
            `POST /sandbox/${sandboxName}/restart`,
        ]);
        for (const w of wire) {
            expect(w.headers).not.toHaveProperty('Authorization');
            expect(await verifyCaptured(w)).toMatchObject({ ok: true, claims: expectedClaims });
        }
    });

    it('flag off: no v2 header, v1 envelope exactly as before', async () => {
        await v1.ensure(ctx, computer, { sessionId: 's', desktopMode: 'neko' });
        await v1.terminate(ctx, computer);
        expect(wire[0]!.headers).not.toHaveProperty('x-ezil-auth');
        expect(JSON.parse(wire[0]!.body).token).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
        expect(wire[1]!.headers.Authorization).toMatch(/^Bearer t=\d+,v1=[0-9a-f]{64}$/);
    });

    it('v2 without a secret makes no Worker call (fail closed)', async () => {
        const noSecret = createCloudflareComputeProvider({ resolveConfig: () => config, readHmacSecret: () => '', useTokenV2: () => true });
        expect(await noSecret.terminate(ctx, computer)).toMatchObject({ ok: false, error: 'hmac_secret_not_configured' });
        expect(await noSecret.ensure(ctx, computer, { sessionId: 's', desktopMode: 'neko' })).toMatchObject({ ok: false });
        expect(wire).toHaveLength(0);
    });
});
