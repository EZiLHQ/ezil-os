import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { primePoolRelay } from './aws-pool-session';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { POOL_SESSION_PENDING, readPlacement } from './placement';
import { isAwsComputersEnabled } from './aws-config';
import { awsSandboxId } from './aws-enroll';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import { verifyPreviewTokenV2 } from '../../../../../worker/src/hmac';

const computerId = '22222222-2222-4222-8222-222222222222';
const ownerUserId = '11111111-1111-4111-8111-111111111111';
const expected = { computerId, ownerUserId, generation: 4, leaseEpoch: 9,
    instanceId: 'i-0123456789abcdef0', fenceToken: '33333333-3333-4333-8333-333333333333' };
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example.test',
    CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'test-secret' };
const pending = () => placementRow({ computer_id: computerId, owner_user_id: ownerUserId, provider: 'aws-ec2',
    state: 'MOUNTING', generation: 4, lease_epoch: 9, instance_id: expected.instanceId, fence_token: expected.fenceToken,
    volume_id: 'vol-0123456789abcdef0', enroll_nonce_hash: null, enroll_consumed_hash: 'a'.repeat(64),
    last_error: POOL_SESSION_PENDING, lifecycle_job_id: '44444444-4444-4444-8444-444444444444', lifecycle_digest: 'b'.repeat(64) });
function setup(over = {}) {
    const row = { ...pending(), ...over };
    const fake = createFakePlacementDb({ placements: [row] });
    let now = 0;
    const sleep = vi.fn(async (ms: number) => { now += ms; });
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({ error: 'aws_desktop_starting', reason: 'config_pushed' }, { status: 503 }));
    const deps = { db: fake.db, env, fetch, sleep, nowMs: () => now };
    return { fake, row, deps, sleep, fetch, run: () => primePoolRelay(deps, expected) };
}
afterEach(() => vi.restoreAllMocks());

describe('enrollment-triggered pool relay preparation', () => {
    it('starts immediately, signs the existing Worker route, discards the response and stops once config is pushed', async () => {
        const s = setup();
        expect(await s.run()).toBeUndefined();
        expect(s.fetch).toHaveBeenCalledTimes(1);
        expect(s.sleep).not.toHaveBeenCalled();
        const [url, init] = s.fetch.mock.calls[0]!;
        expect(url).toBe('https://worker.example.test/sandbox/preview');
        expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
        expect(init!.signal).toBeInstanceOf(AbortSignal);
        const body = String(init!.body);
        expect(JSON.parse(body)).toMatchObject({ projectId: computerId, userId: ownerUserId, desktopMode: 'neko' });
        expect(await verifyPreviewTokenV2(new Headers(init!.headers).get('x-ezil-auth')!, env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET,
            { method: 'POST', path: '/sandbox/preview', body }, Date.now())).toMatchObject({ ok: true,
            claims: { computerId, userId: ownerUserId, provider: 'aws-ec2', generation: 4, leaseEpoch: 9 } });
        expect(s.fake.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: POOL_SESSION_PENDING });
    });

    it.each([
        { owner_user_id: computerId }, { provider: 'cloudflare' }, { generation: 5 }, { lease_epoch: 10 },
        { instance_id: 'i-11111111111111111' }, { fence_token: computerId }, { state: 'STOPPING' }, { state: 'RUNNING' },
        { enroll_nonce_hash: 'a'.repeat(64) }, { enroll_consumed_hash: null }, { last_error: 'enrollment_pending' },
        { volume_id: null }, { lifecycle_job_id: null }, { lifecycle_digest: null },
        { image_upgrade_job_id: '44444444-4444-4444-8444-444444444444' },
    ])('refuses a changed or unconfirmed binding before signing: %j', async over => {
        const s = setup(over); await s.run(); expect(s.fetch).not.toHaveBeenCalled();
    });

    it.each(['aws_origin_starting', 'aws_desktop_unreachable'])('retries %s then stops on desktop start', async error => {
        const s = setup();
        s.fetch.mockResolvedValueOnce(Response.json({ error }, { status: 503 }));
        await s.run(); expect(s.fetch).toHaveBeenCalledTimes(2); expect(s.sleep).toHaveBeenCalledWith(500);
    });

    it('rereads the binding before retrying and cannot follow a replacement epoch', async () => {
        const s = setup();
        s.fetch.mockImplementationOnce(async () => {
            s.fake.placements[0]!.lease_epoch = 10;
            return Response.json({ error: 'aws_origin_starting' }, { status: 503 });
        });
        await s.run(); expect(s.fetch).toHaveBeenCalledTimes(1);
    });

    it('stops if enrollment settles, a fence wins or an image reservation appears during a retry', async () => {
        for (const over of [{ state: 'RUNNING' }, { fence_token: computerId },
            { image_upgrade_job_id: '44444444-4444-4444-8444-444444444444' }]) {
            const s = setup();
            s.fetch.mockImplementationOnce(async () => {
                Object.assign(s.fake.placements[0]!, over);
                return Response.json({ error: 'aws_origin_starting' }, { status: 503 });
            });
            await s.run(); expect(s.fetch).toHaveBeenCalledTimes(1);
        }
    });

    it('does not sign when the DB read fails', async () => {
        const s = setup();
        await expect(primePoolRelay({ ...s.deps, db: { execute: async () => { throw new Error('private DB error'); } } }, expected)).resolves.toBeUndefined();
        expect(s.fetch).not.toHaveBeenCalled();
    });

    it.each([401, 403, 409, 429, 500, 502, 503])('does not retry generic or terminal HTTP %i', async status => {
        const s = setup(); s.fetch.mockResolvedValueOnce(Response.json({ error: 'tunnel_origin_mismatch' }, { status }));
        await s.run(); expect(s.fetch).toHaveBeenCalledTimes(1); expect(s.sleep).not.toHaveBeenCalled();
    });

    it('caps retries and elapsed time, including request time', async () => {
        const s = setup();
        s.fetch.mockImplementation(async () => Response.json({ error: 'aws_origin_starting' }, { status: 503 }));
        await s.run(); expect(s.fetch).toHaveBeenCalledTimes(10);  // bounded probes: each may mint TURN credentials
        const slow = setup();
        slow.fetch.mockImplementation(async () => { await slow.sleep(30_000); return Response.json({ error: 'aws_origin_starting' }, { status: 503 }); });
        await slow.run(); expect(slow.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry ambiguous transport or parsing failures; the browser remains the fallback', async () => {
        for (const response of [() => { throw new Error('private response'); }, () => new Response('malformed', { status: 503 })]) {
            const s = setup(); s.fetch.mockImplementation(async () => response());
            await expect(s.run()).resolves.toBeUndefined(); expect(s.fetch).toHaveBeenCalledTimes(1);
        }
    });

    it.each([
        { EZIL_AWS_COMPUTERS_ENABLED: '0' }, { CLOUDFLARE_GUACAMOLE_HMAC_SECRET: '' },
        { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'http://worker.example.test' },
        { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://u:p@worker.example.test' },
        { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example.test/?q=x' },
    ])('fails closed on configuration: %j', async over => {
        const s = setup(); await primePoolRelay({ ...s.deps, env: { ...env, ...over } }, expected);
        expect(s.fetch).not.toHaveBeenCalled();
    });
});

// Execute guard mutants in memory. Only the exported preparation function is
// transpiled; imports use the same real placement reader/signing code as above.
// No source edits, credentials, network requests or external processes.
describe('relay preparation guard mutants', () => {
    const source = readFileSync(new URL('./aws-pool-session.ts', import.meta.url), 'utf8')
        .split('export async function primePoolRelay')[1]!.split('/** The host reports')[0]!;
    function mutant(before: string, after: string): typeof primePoolRelay {
        expect(source).toContain(before);
        const code = ts.transpileModule('async function primePoolRelay' + source.replace(before, after),
            { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        return new Function('readPlacement', 'isAwsComputersEnabled', 'awsSandboxId', 'mintPreviewTokenV2',
            'PREVIEW_TOKEN_V2_HEADER', 'POOL_SESSION_PENDING', `${code}; return primePoolRelay;`)(
            readPlacement, isAwsComputersEnabled, awsSandboxId, mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER, POOL_SESSION_PENDING);
    }
    it.each([
        ['owner', 'expected.computerId, expected.ownerUserId', 'expected.computerId', { owner_user_id: computerId }],
        ['generation', 'p.generation !== expected.generation', 'false', { generation: 5 }],
        ['epoch', 'p.leaseEpoch !== expected.leaseEpoch', 'false', { lease_epoch: 10 }],
        ['instance', 'p.instanceId !== expected.instanceId', 'false', { instance_id: 'i-11111111111111111' }],
        ['fence', 'p.fenceToken !== expected.fenceToken', 'false', { fence_token: computerId }],
        ['pending', 'p.lastError !== POOL_SESSION_PENDING', 'false', { last_error: 'enrollment_pending' }],
        ['nonce', 'p.enrollNonceHash !== null', 'false', { enroll_nonce_hash: 'a'.repeat(64) }],
        ['consumed-proof', 'p.enrollConsumedHash === null', 'false', { enroll_consumed_hash: null }],
        ['volume', '!p.volumeId', 'false', { volume_id: null }],
        ['job', '!p.lifecycleJobId', 'false', { lifecycle_job_id: null }],
        ['digest', '!p.lifecycleDigest', 'false', { lifecycle_digest: null }],
        ['state', "!['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'].includes(p.state)", 'false', { state: 'STOPPING' }],
    ] as const)('kills removal of the %s gate', async (_name, before, after, over) => {
        const baseline = setup(over); await baseline.run(); expect(baseline.fetch).not.toHaveBeenCalled();
        const changed = setup(over); await mutant(before, after)(changed.deps, expected);
        expect(changed.fetch).toHaveBeenCalledTimes(1); // the existing refusal assertion kills this mutant
    });

    it('kills an increased attempt cap', async () => {
        const changed = setup();
        changed.fetch.mockImplementation(async () => Response.json({ error: 'aws_origin_starting' }, { status: 503 }));
        await mutant('attempt < PRIME_BACKOFF_MS.length + 1', 'attempt < PRIME_BACKOFF_MS.length + 2')(changed.deps, expected);
        expect(changed.fetch).toHaveBeenCalledTimes(11); // baseline contract allows at most 10
    });

    it.each([
        ['AWS-enabled', '!isAwsComputersEnabled(deps.env)', 'false', { EZIL_AWS_COMPUTERS_ENABLED: '0' }],
        ['HTTPS', "endpoint.protocol !== 'https:'", 'false', { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'http://worker.example.test' }],
    ] as const)('kills removal of the %s configuration gate', async (_name, before, after, over) => {
        const baseline = setup();
        await primePoolRelay({ ...baseline.deps, env: { ...env, ...over } }, expected);
        expect(baseline.fetch).not.toHaveBeenCalled();
        const changed = setup(); await mutant(before, after)({ ...changed.deps, env: { ...env, ...over } }, expected);
        expect(changed.fetch).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['HTTP status', 'response.status !== 503', 401, 'aws_origin_starting'],
        ['transient code', "!['aws_origin_starting', 'aws_desktop_unreachable'].includes(String(result?.error))", 503, 'tunnel_origin_mismatch'],
    ] as const)('kills removal of the retry %s gate', async (_name, before, status, error) => {
        const changed = setup(); changed.fetch.mockResolvedValueOnce(Response.json({ error }, { status }));
        await mutant(before, 'false')(changed.deps, expected);
        expect(changed.fetch.mock.calls.length).toBeGreaterThan(1);
    });
});
