/**
 * P1 equivalence: the Cloudflare `ComputeProvider` adapter puts the IDENTICAL
 * request on the wire as the direct `cloudflare-guacamole-provider` call each
 * lifecycle caller made before the seam — method, URL, headers (names, values
 * and order) and body (byte-for-byte, so key order counts) — and hands back
 * the identical result object.
 *
 * `fetch` is stubbed; nothing leaves the process. `Date` is pinned so the
 * HMAC token minted by each side is the same string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    deriveGuacamoleSandboxId,
    getGuacamoleSandboxStatus,
    requestGuacamoleActivity,
    requestGuacamoleDesktopRestart,
    requestGuacamolePreview,
    requestGuacamoleSandboxTerminate,
    resolveCloudflareGuacamoleConfig,
    type CloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';

import { cloudflareComputeProvider, createCloudflareComputeProvider } from './cloudflare';
import type { ComputeProvider } from './provider';
import { selectComputeProvider } from './select';

interface Wire {
    method: string;
    url: string;
    headers: [string, string][];
    body: string | undefined;
    signalled: boolean;
}

const config: CloudflareGuacamoleConfig = {
    workerUrl: 'https://worker.example/',
    hasHmacSecret: true,
    isConfigured: true,
};
const secret = 'test-only-hmac-secret';
const computer = {
    userId: '11111111-1111-4111-8111-111111111111',
    computerId: '22222222-2222-4222-8222-222222222222',
};
const sandboxName = deriveGuacamoleSandboxId(computer.userId, computer.computerId);
const correlationId = 'corr-p1-equivalence';
const ctx = { correlationId };

let wire: Wire[] = [];
let answer: () => Response = () => Response.json({ ok: true });

beforeEach(() => {
    wire = [];
    answer = () => Response.json({ ok: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z'));
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init: RequestInit = {}) => {
            wire.push({
                method: init.method ?? 'GET',
                url: String(url),
                headers: Object.entries((init.headers ?? {}) as Record<string, string>),
                body: typeof init.body === 'string' ? init.body : undefined,
                signalled: init.signal instanceof AbortSignal,
            });
            return answer();
        }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

const adapter = createCloudflareComputeProvider({ resolveConfig: () => config, readHmacSecret: () => secret });

/** Run `direct` then `viaAdapter` against the same stubbed Worker answer. */
async function compare(direct: () => Promise<unknown>, viaAdapter: () => Promise<unknown>) {
    const directResult = await direct();
    const viaResult = await viaAdapter();
    expect(wire).toHaveLength(2);
    const [before, after] = wire;
    expect(after).toEqual(before);
    // `toEqual` on the tuple list already pins header ORDER; the body is
    // compared as the raw string so JSON key order counts too.
    expect(after?.body).toBe(before?.body);
    expect(viaResult).toEqual(directResult);
    return { request: before!, result: directResult };
}

describe('Cloudflare ComputeProvider adapter — per-operation wire equivalence', () => {
    it('ensure (previewUrl, screen requested) === requestGuacamolePreview', async () => {
        answer = () => Response.json({ ok: true, url: 'https://desktop.example/x', sandboxId: sandboxName });
        const screen = { width: 1280, height: 800 };
        const { request } = await compare(
            () =>
                requestGuacamolePreview(
                    config,
                    secret,
                    {
                        sessionId: '33333333-3333-4333-8333-333333333333',
                        userId: computer.userId,
                        projectId: computer.computerId,
                        desktopMode: 'neko',
                        screen,
                    },
                    correlationId,
                ),
            () =>
                adapter.ensure(ctx, computer, {
                    sessionId: '33333333-3333-4333-8333-333333333333',
                    desktopMode: 'neko',
                    screen,
                }),
        );
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://worker.example/sandbox/preview');
        expect(Object.keys(JSON.parse(request.body!))).toEqual([
            'sessionId',
            'userId',
            'projectId',
            'desktopMode',
            'screen',
            'token',
        ]);
    });

    it('ensure (appPreviewUrl/codePreviewUrl, no screen) === requestGuacamolePreview with screen OMITTED', async () => {
        answer = () => Response.json({ ok: true, url: 'https://desktop.example/x' });
        const { request } = await compare(
            () =>
                requestGuacamolePreview(
                    config,
                    secret,
                    {
                        sessionId: computer.computerId,
                        userId: computer.userId,
                        projectId: computer.computerId,
                        desktopMode: 'neko',
                    },
                    correlationId,
                ),
            () => adapter.ensure(ctx, computer, { sessionId: computer.computerId, desktopMode: 'neko' }),
        );
        expect(JSON.parse(request.body!)).not.toHaveProperty('screen');
    });

    it('ensure carries a Worker failure through unchanged', async () => {
        answer = () => new Response('boom', { status: 503 });
        await compare(
            () =>
                requestGuacamolePreview(
                    config,
                    secret,
                    { sessionId: 's', userId: computer.userId, projectId: computer.computerId, desktopMode: 'neko' },
                    correlationId,
                ),
            () => adapter.ensure(ctx, computer, { sessionId: 's', desktopMode: 'neko' }),
        );
    });

    it('status === getGuacamoleSandboxStatus (unsigned GET, as before)', async () => {
        answer = () => Response.json({ ok: true, guacamoleRunning: true });
        const { request } = await compare(
            () => getGuacamoleSandboxStatus(config, sandboxName, correlationId),
            () => adapter.status(ctx, computer),
        );
        expect(request.method).toBe('GET');
        expect(request.url).toBe(`https://worker.example/sandbox/${sandboxName}/status`);
        expect(request.headers.map(([k]) => k)).not.toContain('Authorization');
    });

    it('activity === requestGuacamoleActivity', async () => {
        const { request } = await compare(
            () => requestGuacamoleActivity(config, secret, sandboxName, 4_200, correlationId),
            () => adapter.activity(ctx, computer, { lastInputAgoMs: 4_200 }),
        );
        expect(request.url).toBe(`https://worker.example/sandbox/${sandboxName}/activity`);
        expect(request.body).toBe('{"lastInputAgoMs":4200}');
    });

    it('restart === requestGuacamoleDesktopRestart', async () => {
        answer = () => Response.json({ ok: true, outcome: 'restarted', wasRunning: true });
        const { request } = await compare(
            () => requestGuacamoleDesktopRestart(config, secret, sandboxName, correlationId),
            () => adapter.restart(ctx, computer),
        );
        expect(request.url).toBe(`https://worker.example/sandbox/${sandboxName}/restart`);
        expect(request.body).toBe('{}');
    });

    it('terminate === requestGuacamoleSandboxTerminate', async () => {
        answer = () => Response.json({ ok: true, terminated: true, outcome: 'destroyed' });
        const { request } = await compare(
            () => requestGuacamoleSandboxTerminate(config, secret, sandboxName, correlationId),
            () => adapter.terminate(ctx, computer),
        );
        expect(request.method).toBe('DELETE');
        expect(request.url).toBe(`https://worker.example/sandbox/${sandboxName}`);
        expect(request.body).toBeUndefined();
    });

    it('stop (the reaper path) === requestGuacamoleSandboxTerminate — one teardown on Cloudflare', async () => {
        answer = () => Response.json({ ok: false, outcome: 'still_running', error: 'x' }, { status: 500 });
        await compare(
            () => requestGuacamoleSandboxTerminate(config, secret, sandboxName, correlationId),
            () => adapter.stop(ctx, computer, 'idle_reap'),
        );
    });

    it('the default adapter (and selectComputeProvider) read the same env the call sites read', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', ' https://env-worker.example ');
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', ` ${secret} `);
        answer = () => Response.json({ ok: true, terminated: false, outcome: 'not_running' });
        await compare(
            () =>
                requestGuacamoleSandboxTerminate(
                    resolveCloudflareGuacamoleConfig(),
                    process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
                    sandboxName,
                    correlationId,
                ),
            () => selectComputeProvider(computer).terminate(ctx, computer),
        );
        expect(wire[0]?.url).toBe(`https://env-worker.example/sandbox/${sandboxName}`);
        expect(selectComputeProvider(computer)).toBe(cloudflareComputeProvider);
    });

    it('satisfies the ComputeProvider contract and says it is cloudflare', () => {
        const asContract: ComputeProvider = cloudflareComputeProvider;
        expect(asContract.kind).toBe('cloudflare');
    });
});
