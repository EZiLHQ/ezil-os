import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { AWS_BROWSER_ROUTE_TOKEN, awsPreviewRefusal, prepareAwsPoolSession, requestAwsPreview, waitForAwsPreviewPlacement } from './aws-preview';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import type { EnsureOptions } from './provider';
import { ENROLLMENT_FAILED, ENROLLMENT_PENDING } from './placement';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
const config = { workerUrl: 'https://worker.preview.example/', isConfigured: true, hasHmacSecret: true };
const options = { sessionId: 'session', desktopMode: 'neko' as const };
const failure = { ok: false, error: 'aws_preview_unavailable', errorCode: 'aws_preview_unavailable' };
const waking = { ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting' };
const row = (over: Record<string, unknown> = {}) => placementRow({
    computer_id: computerId, owner_user_id: userId, state: 'RUNNING', generation: 7, lease_epoch: 11, ...over,
});
const url = (port: number) =>
    `https://aws-${port}-${sandboxId}-aws.preview.example/preview-bootstrap?token=opaque%2Etoken&path=%2F`;
const ready = () => ({
    ok: true, provider: 'aws-ec2', mode: 'neko', sandboxId, generation: 7, leaseEpoch: 11,
    guacamoleUrl: url(8181), appPreviewUrl: url(3002), codePreviewUrl: url(8443),
    expiresAt: NOW + 3_600_000,
    relay: { runtimeId: 'a'.repeat(32), expiresAt: NOW + 600_000 }, turnRelay: true,
});
function setup(placements = [row()], instant = false) {
    const fake = createFakePlacementDb({ placements }, instant ? { yield: async () => {} } : {});
    return {
        fake,
        open: (cfg = config, secret = 'test-secret', opts: EnsureOptions = options) =>
            requestAwsPreview(fake.db, { userId, computerId: computerId.toUpperCase() }, opts, cfg, secret, 'corr'),
    };
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('EZIL_PREVIEW_TOKEN_V2', '0');
    vi.stubEnv('EZIL_AWS_BROWSER_ZONE', 'preview.example');
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(ready()));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('AWS preview placement hold', () => {
    const computer = { userId, computerId };
    beforeEach(() => { vi.useRealTimers(); vi.useFakeTimers(); vi.setSystemTime(NOW); });

    it('observes readiness on the next 250ms poll without opening a transaction or signing', async () => {
        const { fake } = setup([row({ state: 'STARTING' })], true);
        const done = vi.fn();
        const held = waitForAwsPreviewPlacement(fake.db, computer).then(done);
        await vi.advanceTimersByTimeAsync(249);
        expect(done).not.toHaveBeenCalled();
        fake.placements[0]!.state = 'RUNNING';
        await vi.advanceTimersByTimeAsync(1);
        await held;
        expect(done).toHaveBeenCalledExactlyOnceWith(true);
        expect(fake.statements.filter(s => s.sql.includes('placement:read'))).toHaveLength(2);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('expires at eight seconds with a bounded number of placement reads', async () => {
        const { fake } = setup([row({ state: 'STARTING' })], true);
        const done = vi.fn();
        const held = waitForAwsPreviewPlacement(fake.db, computer).then(done);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(done).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await held;
        expect(done).toHaveBeenCalledExactlyOnceWith(false);
        expect(fake.statements.filter(s => s.sql.includes('placement:read'))).toHaveLength(32);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('holds only one ask per owner/computer, normalizes UUID case, and releases on abort', async () => {
        const { fake } = setup([row({ state: 'STARTING' })], true);
        const controller = new AbortController();
        const held = waitForAwsPreviewPlacement(fake.db, computer, controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        const reads = fake.statements.length;
        expect(await waitForAwsPreviewPlacement(fake.db, { userId, computerId: computerId.toUpperCase() })).toBe(false);
        expect(fake.statements).toHaveLength(reads);
        controller.abort();
        expect(await held).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        fake.placements[0]!.state = 'RUNNING';
        expect(await waitForAwsPreviewPlacement(fake.db, computer)).toBe(true);
    });

    it('allows independent computers to wait concurrently', async () => {
        const secondId = '22222222-2222-4222-8222-222222222222';
        const { fake } = setup([row({ state: 'STARTING' }), row({ state: 'STARTING', computer_id: secondId })], true);
        const first = waitForAwsPreviewPlacement(fake.db, computer);
        const second = waitForAwsPreviewPlacement(fake.db, { userId, computerId: secondId });
        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(2);
        fake.placements.forEach(p => { p.state = 'RUNNING'; });
        await vi.advanceTimersByTimeAsync(250);
        expect(await Promise.all([first, second])).toEqual([true, true]);
    });

    it.each([
        { state: 'STOPPING' }, { provider: 'cloudflare' }, { last_error: ENROLLMENT_FAILED },
        { owner_user_id: '22222222-2222-4222-8222-222222222222' }, { generation: 0 },
        { image_upgrade_job_id: computerId },
    ])('ends the hold on a new refusal: %j', async patch => {
        const { fake } = setup([row({ state: 'STARTING' })], true);
        const held = waitForAwsPreviewPlacement(fake.db, computer);
        await vi.advanceTimersByTimeAsync(0);
        Object.assign(fake.placements[0]!, patch);
        await vi.advanceTimersByTimeAsync(250);
        expect(await held).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not wait for a RUNNING placement with unsettled enrollment', async () => {
        const { fake } = setup([row({ enroll_nonce_hash: 'pending' })], true);
        expect(await waitForAwsPreviewPlacement(fake.db, computer)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['placement', 'reservation'])('releases the hold on abort during the %s read, even if it never answers', async stage => {
        const { fake } = setup([row()], true);
        const execute = fake.db.execute;
        let release!: () => void;
        const deferred = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        const db = { execute: vi.fn(async (query: Parameters<typeof execute>[0]) => {
            if (++calls === (stage === 'placement' ? 1 : 2)) await deferred;
            return execute(query);
        }) };
        const controller = new AbortController();
        const held = waitForAwsPreviewPlacement(db, computer, controller.signal);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        expect(await held).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        // A new ask acquires the same slot before the old dependency settles.
        expect(await waitForAwsPreviewPlacement(fake.db, computer)).toBe(true);
        const count = db.execute.mock.calls.length;
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(db.execute).toHaveBeenCalledTimes(count);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([0, 7_750])('bounds a deferred read started at %ims by the remaining eight-second budget', async start => {
        const { fake } = setup([row({ state: start ? 'STARTING' : 'RUNNING' })], true);
        const execute = fake.db.execute;
        let release!: () => void;
        const deferred = new Promise<void>(resolve => { release = resolve; });
        const db = { execute: vi.fn(async (query: Parameters<typeof execute>[0]) => {
            if (performance.now() >= start) await deferred;
            return execute(query);
        }) };
        const done = vi.fn();
        const held = waitForAwsPreviewPlacement(db, computer).then(done);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(done).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await held;
        expect(done).toHaveBeenCalledExactlyOnceWith(false);
        fake.placements[0]!.state = 'RUNNING';
        expect(await waitForAwsPreviewPlacement(fake.db, computer)).toBe(true);
        const reads = db.execute.mock.calls.length;
        await vi.advanceTimersByTimeAsync(1);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(done).toHaveBeenCalledExactlyOnceWith(false);
        expect(db.execute).toHaveBeenCalledTimes(reads);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a ready result at 8001ms even before the deadline timer runs', async () => {
        const { fake } = setup([row()], true);
        const execute = fake.db.execute;
        const db = { execute: async (query: Parameters<typeof execute>[0]) => {
            const result = await execute(query);
            vi.spyOn(performance, 'now').mockReturnValue(8_001);
            return result;
        } };
        expect(await waitForAwsPreviewPlacement(db, computer)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('accepts a deferred healthy read just before the deadline and clears its timer', async () => {
        const { fake } = setup([row()], true);
        let release!: () => void;
        const deferred = new Promise<void>(resolve => { release = resolve; });
        const held = waitForAwsPreviewPlacement({ execute: async query => { await deferred; return fake.db.execute(query); } }, computer);
        await vi.advanceTimersByTimeAsync(7_999);
        release();
        expect(await held).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('AWS preview handoff', () => {
    it('signs the exact POST body with current placement claims even when Cloudflare v2 is off', async () => {
        const { open, fake } = setup();
        const screen = { width: 1280, height: 800 };
        await expect(open(config, 'test-secret', { ...options, screen })).resolves.toEqual({
            ...ready(), correlationId: 'corr', frame: undefined,
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [endpoint, init] = fetchMock.mock.calls[0]!;
        expect(endpoint).toBe('https://worker.preview.example/sandbox/preview');
        const body = JSON.stringify({ sessionId: 'session', userId, projectId: computerId, desktopMode: 'neko', screen });
        expect(init).toMatchObject({ method: 'POST', body, redirect: 'error' });
        expect(init!.signal).toBeInstanceOf(AbortSignal);
        const headers = new Headers(init!.headers);
        expect(headers.get('content-type')).toBe('application/json');
        expect(headers.get('x-correlation-id')).toBe('corr');
        const [version, encoded, signature] = headers.get('x-ezil-auth')!.split('.');
        expect(version).toBe('v2');
        expect(JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'))).toEqual({
            ts: NOW, sandboxId, computerId, userId, provider: 'aws-ec2', store: '', generation: 7, leaseEpoch: 11,
        });
        const digest = createHash('sha256').update(body).digest('hex');
        expect(signature).toBe(createHmac('sha256', 'test-secret').update([
            'v2', NOW, 'POST', '/sandbox/preview', sandboxId, computerId, userId, 'aws-ec2', '', 7, 11, digest,
        ].join('|')).digest('hex'));
        expect(fake.statements).toHaveLength(4);
        expect(fake.statements[0]!.sql).toContain('placement:read');
    });

    it('omits absent screen and v1 token, and strips unknown Worker and relay fields', async () => {
        fetchMock.mockResolvedValue(Response.json({
            ...ready(), internal: 'LEAK', error: 'LEAK',
            relay: { ...ready().relay, credential: 'LEAK' },
        }));
        await expect(setup().open()).resolves.toEqual({ ...ready(), correlationId: 'corr', frame: undefined });
        expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
            sessionId: 'session', userId, projectId: computerId, desktopMode: 'neko',
        });
    });

    it('accepts a ready answer without optional relay metadata', async () => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), relay: undefined, turnRelay: undefined }));
        const out = await setup().open();
        expect(out.ok).toBe(true);
        expect(out).not.toHaveProperty('relay');
        expect(out).not.toHaveProperty('turnRelay');
    });

    it.each([
        [{ ...config, isConfigured: false }, 'test-secret'],
        [config, '   '],
    ] as const)('refuses missing configuration before any placement read', async (cfg, secret) => {
        const { open, fake } = setup();
        await expect(open(cfg, secret)).resolves.toEqual(failure);
        expect(fake.statements).toEqual([]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', []],
        ['foreign', [row({ owner_user_id: '22222222-2222-4222-8222-222222222222' })]],
        ['cloudflare', [row({ provider: 'cloudflare', workspace_store: 'r2' })]],
        ['stopping', [row({ state: 'STOPPING' })]],
        ['stopped', [row({ state: 'STOPPED' })]],
        ['unconfirmed', [row({ state: 'UNCONFIRMED' })]],
        ['retired', [row({ state: 'RETIRED' })]],
        ['failed enrollment', [row({ last_error: ENROLLMENT_FAILED })]],
        ['zero generation', [row({ generation: 0 })]],
        ['zero lease', [row({ lease_epoch: 0 })]],
        ['duplicate', [row(), row()]],
    ] as const)('refuses a %s placement before fetch', async (_name, placements) => {
        await expect(setup([...placements]).open()).resolves.toEqual(failure);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING'])('keeps an owned %s placement waking without signing', async (state) => {
        const { fake, open } = setup([row({ state })]);
        await expect(open()).resolves.toEqual(waking);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fake.placements[0]).toMatchObject({ state, generation: 7, lease_epoch: 11 });
    });

    it.each([
        { enroll_nonce_hash: 'pending-nonce' }, { last_error: ENROLLMENT_PENDING },
        { lifecycle_job_id: computerId }, { lifecycle_digest: 'a'.repeat(64) },
    ])('waits for enrollment and receipt settlement before signing: %j', async (over) => {
        await expect(setup([row(over)]).open()).resolves.toEqual(waking);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('checks ownership before reservations, without leaking the reservation or owner', async () => {
        const { fake, open } = setup([row({ owner_user_id: '22222222-2222-4222-8222-222222222222' })]);
        await expect(open()).resolves.toEqual(failure);
        expect(fake.statements).toHaveLength(1);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith('[aws-preview] unavailable reason=placement_foreign');
    });

    it('refuses an image reservation without guessing or advancing its target generation', async () => {
        const { fake, open } = setup();
        fake.placements[0]!.image_upgrade_job_id = computerId;
        fake.imageJobs.push({ computer_id: computerId, job_id: computerId, phase: 'verifying', target_generation: 8 });
        await expect(open()).resolves.toEqual(failure);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(fake.placements[0]).toMatchObject({ generation: 7, lease_epoch: 11 });
        expect(console.warn).toHaveBeenCalledExactlyOnceWith('[aws-preview] unavailable reason=placement_reserved');
    });

    it('reads the current epoch on every handoff', async () => {
        const { open, fake } = setup();
        await open();
        fake.placements[0]!.generation = 8;
        fake.placements[0]!.lease_epoch = 12;
        fetchMock.mockResolvedValue(Response.json({ ...ready(), generation: 8, leaseEpoch: 12 }));
        await expect(open()).resolves.toMatchObject({ ok: true, generation: 8, leaseEpoch: 12 });
        const token = new Headers(fetchMock.mock.calls[1]![1]!.headers).get('x-ezil-auth')!;
        expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
            generation: 8, leaseEpoch: 12,
        });
    });

    it.each(['?unsigned=1', '#unsigned'])('refuses unsigned URL components: %s', async (suffix) => {
        await expect(setup().open({ ...config, workerUrl: config.workerUrl + suffix })).resolves.toEqual(failure);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['aws_desktop_starting', 'aws_origin_starting', 'aws_desktop_unreachable'])('maps only HTTP 503 %s to waking', async (error) => {
        fetchMock.mockResolvedValue(Response.json({ ok: false, error, reason: 'LEAK' }, { status: 503 }));
        await expect(setup().open()).resolves.toEqual({
            ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting',
        });
        fetchMock.mockResolvedValue(Response.json({ ok: false, error }, { status: 502 }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each([
        [502, 'aws_origin_unavailable'], [409, 'relay_busy'], [409, 'relay_runtime_changed'],
        [409, 'relay_negotiation_busy'], [504, 'relay_timeout'],
    ])('retries the documented Worker transient %s %s', async (status, error) => {
        fetchMock.mockResolvedValue(Response.json({ ok: false, error, reason: 'LEAK' }, { status }));
        await expect(setup().open()).resolves.toEqual(waking);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        [502, 'tunnel_origin_mismatch'], [502, 'aws_desktop_failed'], [502, 'aws_desktop_config_refused'],
        [401, 'aws_preview_auth_required'], [403, 'aws_origin_starting'], [409, 'unknown_conflict'],
        [503, 'unknown_starting'], [409, 'aws_desktop_unreachable'],
    ])('keeps the invalid Worker state %s %s unavailable', async (status, error) => {
        fetchMock.mockResolvedValue(Response.json({ ok: false, error, reason: 'LEAK' }, { status }));
        await expect(setup().open()).resolves.toEqual(failure);
        expect(console.warn).toHaveBeenCalledExactlyOnceWith(`[aws-preview] unavailable reason=worker_status_${status}`);
    });

    it.each(['success', 'epoch refusal'] as const)('discards a %s for an epoch replaced during the Worker request and signs the current pair next time', async (answer) => {
        const { fake, open } = setup();
        fetchMock.mockImplementationOnce(async () => {
            fake.placements[0]!.generation = 8;
            fake.placements[0]!.lease_epoch = 12;
            return answer === 'success' ? Response.json(ready())
                : Response.json({ ok: false, error: 'aws_origin_unavailable' }, { status: 502 });
        });
        await expect(open()).resolves.toEqual(waking);
        fetchMock.mockResolvedValue(Response.json({ ...ready(), generation: 8, leaseEpoch: 12 }));
        await expect(open()).resolves.toMatchObject({ ok: true, generation: 8, leaseEpoch: 12 });
        const token = new Headers(fetchMock.mock.calls[1]![1]!.headers).get('x-ezil-auth')!;
        expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({ generation: 8, leaseEpoch: 12 });
    });

    it.each([
        ['STARTING', waking], ['MOUNTING', waking], ['STOPPING', failure], ['UNCONFIRMED', failure],
    ])('rechecks a concurrent %s transition before returning URLs', async (state, result) => {
        const { fake, open } = setup();
        fetchMock.mockImplementationOnce(async () => {
            fake.placements[0]!.state = state;
            return Response.json(ready());
        });
        await expect(open()).resolves.toEqual(result);
    });

    it.each(['owner', 'reservation'])('refuses a concurrent %s change before returning URLs', async (change) => {
        const { fake, open } = setup();
        fetchMock.mockImplementationOnce(async () => {
            if (change === 'owner') fake.placements[0]!.owner_user_id = '22222222-2222-4222-8222-222222222222';
            else fake.placements[0]!.image_upgrade_job_id = computerId;
            return Response.json(ready());
        });
        await expect(open()).resolves.toEqual(failure);
    });

    it.each([201, 401, 403, 404, 409, 500, 502, 503, 504])('refuses HTTP %s even with a success-shaped body', async (status) => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), error: 'LEAK' }, { status }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each([
        { ok: false, error: 'aws_desktop_starting' },
        { provider: 'cloudflare' }, { mode: 'production' }, { sandboxId: 'guac-other-computer' },
        { generation: 6 }, { leaseEpoch: 10 }, { expiresAt: NOW },
        { guacamoleUrl: undefined }, { appPreviewUrl: null }, { codePreviewUrl: '' },
        { appPreviewUrl: url(8443) }, { codePreviewUrl: url(3002) },
        { relay: { runtimeId: 'LEAK', expiresAt: NOW + 600_000 } },
        { relay: { runtimeId: 'a'.repeat(32), expiresAt: NOW } }, { turnRelay: 'LEAK' },
    ])('refuses malformed or stale success fields: %j', async (over) => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), ...over, internal: 'LEAK' }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each([
        url(8181).replace('https:', 'http:'),
        url(8181).replace('https://', 'https://user@'),
        url(8181).replace('https://', 'https://:password@'),
        url(8181).replace('.example/', '.example:8443/'),
        url(8080),
        url(8181).replace(sandboxId, 'guac-other-computer'),
        url(8181).replace('/preview-bootstrap', '/'),
        url(8181).replace('token=', 'other='),
        'LEAK',
    ])('refuses an invalid desktop bootstrap URL: %s', async (guacamoleUrl) => {
        fetchMock.mockResolvedValue(Response.json({ ...ready(), guacamoleUrl }));
        await expect(setup().open()).resolves.toEqual(failure);
    });

    it.each(['fetch', 'timeout', 'json', 'null', 'array', 'database'])('sanitizes %s failures', async (kind) => {
        const { open, fake } = setup();
        if (kind === 'database') vi.spyOn(fake.db, 'execute').mockRejectedValue(new Error('LEAK'));
        else if (kind === 'fetch') fetchMock.mockRejectedValue(new Error('LEAK'));
        else if (kind === 'timeout') fetchMock.mockRejectedValue(new DOMException('LEAK', 'TimeoutError'));
        else fetchMock.mockResolvedValue(kind === 'json' ? new Response('LEAK') : Response.json(kind === 'null' ? null : []));
        const transport = kind === 'fetch' || kind === 'timeout';
        await expect(open()).resolves.toEqual(transport ? waking : failure);
        if (!transport) expect(console.warn).toHaveBeenCalledExactlyOnceWith(
            `[aws-preview] unavailable reason=${kind === 'database' ? 'placement_read_failed' : 'parse_failed'}`,
        );
    });
});

// Round 6 (R3-2): every refusal says why, as one bounded code (and the Worker's HTTP status when it
// answered), for the router's one `aws-preview` log line. The wire answer is unchanged.
describe('AWS preview refusal reasons', () => {
    const reasonOf = async (placements = [row()]) => {
        const out = await setup(placements).open();
        expect(out.ok).toBe(false);
        return awsPreviewRefusal(out);
    };
    it.each([
        ['PROVISIONING', { state: 'PROVISIONING' }], ['MOUNTING', { state: 'MOUNTING' }],
    ])('an owned %s placement: placement_opening', async (_state, over) => {
        expect(await reasonOf([row(over)])).toEqual({ reason: 'placement_opening', status: null });
    });
    it.each([
        [{ enroll_nonce_hash: 'pending-nonce' }, 'enrollment_pending'], [{ last_error: ENROLLMENT_PENDING }, 'enrollment_pending'],
        [{ lifecycle_job_id: computerId }, 'lifecycle_pending'], [{ lifecycle_digest: 'a'.repeat(64) }, 'lifecycle_pending'],
    ] as const)('a RUNNING placement still settling %j: %s', async (over, reason) => {
        expect(await reasonOf([row(over)])).toEqual({ reason, status: null });
    });
    it.each([
        [503, 'aws_desktop_starting'], [503, 'aws_origin_starting'], [503, 'aws_desktop_unreachable'], [502, 'aws_origin_unavailable'],
        [409, 'relay_busy'], [409, 'relay_runtime_changed'], [409, 'relay_negotiation_busy'], [504, 'relay_timeout'],
    ])('a Worker transient %s %s: that allow-listed code and its status', async (status, error) => {
        fetchMock.mockResolvedValue(Response.json({ ok: false, error, reason: 'LEAK' }, { status }));
        expect(await reasonOf()).toEqual({ reason: error, status });
    });
    it('an unknown Worker refusal is only its status, never its body', async () => {
        fetchMock.mockResolvedValue(Response.json({ ok: false, error: 'LEAK_unknown_starting' }, { status: 503 }));
        expect(await reasonOf()).toEqual({ reason: 'worker_status_503', status: 503 });
    });
    it('a transport loss and an epoch replaced during the ask', async () => {
        fetchMock.mockRejectedValue(new DOMException('LEAK', 'TimeoutError'));
        expect(await reasonOf()).toEqual({ reason: 'transport_failed', status: null });
        const { fake, open } = setup();
        fetchMock.mockImplementationOnce(async () => { fake.placements[0]!.lease_epoch = 12; return Response.json(ready()); });
        expect(awsPreviewRefusal(await open())).toEqual({ reason: 'epoch_moved', status: 200 });
    });
    it('a hard refusal keeps its existing category', async () => {
        expect(await reasonOf([row({ state: 'STOPPED' })])).toEqual({ reason: 'placement_not_running', status: null });
        expect(console.warn).toHaveBeenCalledExactlyOnceWith('[aws-preview] unavailable reason=placement_not_running');
    });
    it('an ok answer, a copy and a foreign object have no reason', async () => {
        const ok = await setup().open();
        expect(ok.ok).toBe(true);
        expect(awsPreviewRefusal(ok)).toBeUndefined();
        const refused = await setup([row({ state: 'STARTING' })]).open();
        expect(awsPreviewRefusal({ ...refused })).toBeUndefined();
        expect(awsPreviewRefusal({ ok: false, error: 'sandbox_starting' })).toBeUndefined();
    });
});

describe('AWS browser host (Codex P1: the Worker appends the -aws route token)', () => {
    const host = (h: string) => `https://${h}/preview-bootstrap?token=opaque%2Etoken&path=%2F`;
    const answer = (guacamoleUrl: string) => Response.json({ ...ready(), guacamoleUrl });

    it('accepts the Worker host on the configured browser zone', async () => {
        const h = `aws-8181-${sandboxId}-aws.preview.example`;
        fetchMock.mockResolvedValue(answer(host(h)));
        await expect(setup().open()).resolves.toMatchObject({ ok: true, guacamoleUrl: host(h) });
    });

    it.each([
        ['suffixless (the zone catch-all owns it)', `aws-8181-${sandboxId}.preview.example`],
        ['a foreign zone', `aws-8181-${sandboxId}-aws.other.example`],
        ['a zone suffix lookalike', `aws-8181-${sandboxId}-aws.preview.example.evil.example`],
        ['another port in the desktop field', `aws-3002-${sandboxId}-aws.preview.example`],
        ['another sandbox', `aws-8181-guac-0000000000000000-0000000000000000-aws.preview.example`],
        ['a different route token', `aws-8181-${sandboxId}-awsx.preview.example`],
        // Never derived from the Worker's host: its own host is not the configured zone.
        ['the Worker host itself (not the configured zone)', `aws-8181-${sandboxId}-aws.worker.preview.example`],
    ])('refuses %s', async (_name, h) => {
        fetchMock.mockResolvedValue(answer(host(h)));
        await expect(setup().open()).resolves.toEqual(failure);
    });
});

describe('AWS browser zone comes from EZIL_AWS_BROWSER_ZONE, never the Worker host (Codex 4278276844)', () => {
    const answerOn = (zone: string) => Response.json({
        ...ready(),
        guacamoleUrl: `https://aws-8181-${sandboxId}-aws.${zone}/preview-bootstrap?token=t&path=%2F`,
        appPreviewUrl: `https://aws-3002-${sandboxId}-aws.${zone}/preview-bootstrap?token=t&path=%2F`,
        codePreviewUrl: `https://aws-8443-${sandboxId}-aws.${zone}/preview-bootstrap?token=t&path=%2F`,
    });

    it.each([
        // Staging: the Worker host has the zone below a hyphenated label.
        ['staging', 'https://api-desktop-staging.ezil.work/', 'ezil.work'],
        // Production.
        ['production', 'https://api-desktop.ezil.org/', 'ezil.org'],
        // A Worker host two labels below its zone: "host minus one label" would be wrong here.
        ['a deeper Worker host', 'https://api.desktop-staging.ezil.work/', 'ezil.work'],
    ])('%s: %s serves AWS hosts on %s', async (_name, workerUrl, zone) => {
        vi.stubEnv('EZIL_AWS_BROWSER_ZONE', zone);
        fetchMock.mockResolvedValue(answerOn(zone));
        await expect(setup().open({ ...config, workerUrl })).resolves.toMatchObject({ ok: true });
    });

    it.each([['unset', ''], ['malformed', 'not a zone'], ['a bare label', 'example']])(
        'fails closed (no Worker call) when the zone is %s', async (_name, value) => {
            vi.stubEnv('EZIL_AWS_BROWSER_ZONE', value);
            await expect(setup().open()).resolves.toEqual(failure);
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );
});

describe('AWS browser route token', () => {
    it('pins the route token to the Worker source', () => {
        const worker = readFileSync(path.resolve(__dirname, '../../../../../worker/src/aws-origin.ts'), 'utf8');
        expect(worker).toContain(`export const AWS_BROWSER_ROUTE_TOKEN = '${AWS_BROWSER_ROUTE_TOKEN}';`);
        expect(worker).toContain('https://aws-${port}-${sandboxId}-${AWS_BROWSER_ROUTE_TOKEN}.${zoneRoot}/preview-bootstrap');
    });
});

it('pool relay preparation sends only an enrolled pending epoch and never returns user URLs', async () => {
    const pending = row({ state: 'MOUNTING', last_error: 'pool_session_pending', enroll_nonce_hash: null,
        enroll_consumed_hash: 'a'.repeat(64), instance_id: 'i-11111111111111111', volume_id: 'vol-11111111111111111',
        lifecycle_job_id: '11111111-1111-4111-8111-111111111111', lifecycle_digest: 'b'.repeat(64) });
    const fake = createFakePlacementDb({ placements: [pending] });
    vi.stubEnv('EZIL_AWS_BROWSER_ZONE', 'preview.example');
    const fetcher = vi.fn(async () => Response.json(ready())); vi.stubGlobal('fetch', fetcher);
    expect(await prepareAwsPoolSession(fake.db, { userId, computerId }, options, config, 'test-secret', 'test')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    for (const patch of [{ last_error: 'enroll_tunnel_pending' }, { enroll_consumed_hash: null }, { enroll_nonce_hash: 'still-unconsumed' },
        { instance_id: null }, { volume_id: null }, { lifecycle_job_id: null }, { lifecycle_digest: null }, { state: 'STOPPING' }]) {
        const refused = createFakePlacementDb({ placements: [{ ...pending, ...patch }] });
        await prepareAwsPoolSession(refused.db, { userId, computerId }, options, config, 'test-secret', 'test');
        expect(fetcher).toHaveBeenCalledOnce();
    }
});
