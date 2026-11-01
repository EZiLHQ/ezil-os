import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { deriveControlKey } from '@/server/lib/compute/aws-enroll';
import { ImageJobConflictError, PlacementIntegrityError, type Placement } from '@/server/lib/compute/placement';
import { handleHostStorageSample, storageMacMessage, type HostStorageDeps } from './host-storage';

const SECRET = 'synthetic-app-worker-secret';
const NOW = new Date('2026-11-01T12:00:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function placement(computerId: string, ownerUserId: string, overrides: Partial<Placement> = {}): Placement {
    return {
        computerId, ownerUserId, provider: 'aws-ec2', store: 'ebs', generation: 3, leaseEpoch: 7, state: 'RUNNING',
        region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: 'i-0123456789abcdef0', instanceType: 't3.large',
        volumeId: 'vol-0123456789abcdef0', fsUuid: null, tunnelId: null, enrollNonceHash: null, enrollExpiresAt: NOW,
        enrollConsumedHash: (computerId === A ? 'a' : 'b').repeat(64), leaseUntil: null, presenceAt: null,
        fenceToken: '33333333-3333-4333-8333-333333333333', lifecycleJobId: null, lifecycleDigest: null,
        lastError: 'enrollment_succeeded', updatedAt: NOW, ...overrides,
    };
}

/** The host's control key for `p`'s epoch: what enrollment returned to that host (aws-enroll.ts). */
const keyOf = (p: Placement) => deriveControlKey(SECRET, { computerId: p.computerId, generation: p.generation, leaseEpoch: p.leaseEpoch, nonceHash: p.enrollConsumedHash! });
const sampleBody = (overrides: Record<string, unknown> = {}) => JSON.stringify({ bytes: '1610612736', measuredAt: '2026-11-01T11:59:00Z', reason: 'interval', ...overrides });

function signed(p: Placement, body: string, opts: { key?: Buffer; computerId?: string; generation?: number; leaseEpoch?: number; ts?: number } = {}) {
    const ts = String(opts.ts ?? Math.floor(NOW.getTime() / 1000));
    const computerId = opts.computerId ?? p.computerId;
    const generation = opts.generation ?? p.generation;
    const leaseEpoch = opts.leaseEpoch ?? p.leaseEpoch;
    const mac = createHmac('sha256', opts.key ?? keyOf(p)).update(storageMacMessage({ timestamp: ts, computerId, generation, leaseEpoch, body })).digest('hex');
    return new Request('https://app.test/api/compute/aws/storage', { method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-ezil-computer-id': computerId, 'x-ezil-generation': String(generation),
        'x-ezil-lease-epoch': String(leaseEpoch), 'x-ezil-timestamp': ts, 'x-ezil-signature': `v1=${mac}` } });
}

function deps(placements: Placement[], overrides: Partial<HostStorageDeps> = {}) {
    const record = vi.fn<HostStorageDeps['record']>().mockResolvedValue('recorded');
    const d: HostStorageDeps = {
        env: { EZIL_AWS_COMPUTERS_ENABLED: '1', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: SECRET }, now: () => NOW,
        placement: async id => placements.find(p => p.computerId === id) ?? null, record, ...overrides,
    };
    return { d, record };
}

async function send(request: Request, d: HostStorageDeps) {
    const response = await handleHostStorageSample(request, d);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('POST /api/compute/aws/storage: host storage samples under the epoch control key', () => {
    const a = placement(A, OWNER_A);
    const b = placement(B, OWNER_B);

    it('verifies the host agent\'s signature byte for byte (vector shared with infra/host-agent/test/test_storage.py)', () => {
        const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
        const body = '{"bytes":"1610612736","measuredAt":"2026-11-01T11:59:00Z","reason":"interval"}';
        expect(body).toBe(sampleBody());
        const mac = createHmac('sha256', key).update(storageMacMessage({ timestamp: '1793534400', computerId: A.toUpperCase(), generation: 3, leaseEpoch: 7, body })).digest('hex');
        expect(`v1=${mac}`).toBe('v1=d914aeeec7cf11c04065b5e5d63c86048f5080f25e856bbfc647f0c7b92de40a');
    });

    it('records a validly signed sample for the credential\'s computer and the placement owner (positive control)', async () => {
        const { d, record } = deps([a, b]);
        expect(await send(signed(a, sampleBody()), d)).toEqual({ status: 200, body: { recorded: true } });
        expect(record).toHaveBeenCalledOnce();
        expect(record).toHaveBeenCalledWith(OWNER_A, { computerId: A, bytes: BigInt(1610612736),
            measuredAt: new Date('2026-11-01T11:59:00Z'), source: 'host-agent' });
    });

    it('accepts the on-stop reason, a measured zero and a sample 29 minutes old', async () => {
        const { d, record } = deps([a]);
        for (const body of [sampleBody({ reason: 'stop' }), sampleBody({ bytes: '0' }), sampleBody({ measuredAt: '2026-11-01T11:31:00Z' })]) {
            expect((await send(signed(a, body), d)).status).toBe(200);
        }
        expect(record).toHaveBeenCalledTimes(3);
    });

    it('answers a duplicate (same computer and measuredAt) as recorded: false, never an error', async () => {
        const { d } = deps([a], { record: vi.fn<HostStorageDeps['record']>().mockResolvedValue('duplicate') });
        expect(await send(signed(a, sampleBody()), d)).toEqual({ status: 200, body: { recorded: false } });
    });

    it('refuses an unauthenticated request (no headers) without reading a placement or recording', async () => {
        const placementRead = vi.fn().mockResolvedValue(a);
        const { d, record } = deps([a], { placement: placementRead });
        const bare = new Request('https://app.test/api/compute/aws/storage', { method: 'POST', body: sampleBody() });
        expect(await send(bare, d)).toEqual({ status: 401, body: { error: 'storage_unauthenticated' } });
        expect(placementRead).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
    });

    it('refuses a forged signature: a guessed key, the deployment secret itself, or a tampered body', async () => {
        const { d, record } = deps([a]);
        expect((await send(signed(a, sampleBody(), { key: Buffer.alloc(32, 7) }), d)).status).toBe(401);
        expect((await send(signed(a, sampleBody(), { key: Buffer.from(SECRET) }), d)).status).toBe(401);
        const tampered = signed(a, sampleBody());
        const forged = new Request(tampered.url, { method: 'POST', headers: tampered.headers, body: sampleBody({ bytes: '1' }) });
        expect(await send(forged, d)).toEqual({ status: 401, body: { error: 'storage_unauthenticated' } });
        expect(record).not.toHaveBeenCalled();
    });

    it('refuses a swapped computer id: A\'s host naming B\'s computer gets nothing recorded for B (or A)', async () => {
        const { d, record } = deps([a, b]);
        // A's key, B's id in the signed headers: the key derived for B does not match.
        expect(await send(signed(a, sampleBody(), { computerId: B, generation: b.generation, leaseEpoch: b.leaseEpoch }), d))
            .toEqual({ status: 401, body: { error: 'storage_unauthenticated' } });
        expect(record).not.toHaveBeenCalled();
        // Positive control: B's own host, with B's key, is recorded for B's owner.
        expect((await send(signed(b, sampleBody()), d)).status).toBe(200);
        expect(record).toHaveBeenCalledWith(OWNER_B, expect.objectContaining({ computerId: B }));
    });

    it('never takes an id from the body: a validly signed body that names a computer or user is refused', async () => {
        const { d, record } = deps([a, b]);
        for (const extra of [{ computerId: B }, { userId: OWNER_B }, { computerId: A }]) {
            expect(await send(signed(a, sampleBody(extra)), d)).toEqual({ status: 400, body: { error: 'storage_sample_invalid' } });
        }
        expect(record).not.toHaveBeenCalled();
    });

    it('refuses any epoch but the current one, and a placement without its consumed-nonce proof', async () => {
        const stale = placement(A, OWNER_A, { leaseEpoch: 8 });
        // The host still signs with epoch 7's key: the placement has moved on.
        expect((await send(signed(a, sampleBody()), deps([stale]).d)).status).toBe(401);
        expect((await send(signed(a, sampleBody(), { generation: 2 }), deps([a]).d)).status).toBe(401);
        for (const p of [placement(A, OWNER_A, { state: 'DRAINING', enrollConsumedHash: null }), placement(A, OWNER_A, { state: 'STOPPED' }),
            placement(A, OWNER_A, { provider: 'cloudflare' }), placement(A, OWNER_A, { instanceId: null })]) {
            const { d, record } = deps([p]);
            expect(await send(signed(a, sampleBody()), d)).toEqual({ status: 401, body: { error: 'storage_unauthenticated' } });
            expect(record).not.toHaveBeenCalled();
        }
        expect((await send(signed(a, sampleBody()), deps([]).d)).status).toBe(401);
    });

    it('refuses a stale or future signature timestamp, and stale or future measurements', async () => {
        const { d, record } = deps([a]);
        const ts = Math.floor(NOW.getTime() / 1000);
        expect(await send(signed(a, sampleBody(), { ts: ts - 301 }), d)).toEqual({ status: 401, body: { error: 'storage_signature_stale' } });
        expect((await send(signed(a, sampleBody(), { ts: ts + 301 }), d)).status).toBe(401);
        expect((await send(signed(a, sampleBody(), { ts: ts - 299 }), d)).status).toBe(200);
        expect(await send(signed(a, sampleBody({ measuredAt: '2026-11-01T11:29:59Z' })), d)).toEqual({ status: 422, body: { error: 'storage_sample_stale' } });
        expect(await send(signed(a, sampleBody({ measuredAt: '2026-11-01T12:05:01Z' })), d)).toEqual({ status: 422, body: { error: 'storage_sample_future' } });
        expect((await send(signed(a, sampleBody({ measuredAt: '2026-11-01T12:04:59Z' })), d)).status).toBe(200);
        expect(record).toHaveBeenCalledTimes(2);
    });

    it('refuses malformed counts: negative, decimal, padded, beyond bigint, or numeric JSON', async () => {
        const { d, record } = deps([a]);
        for (const bytes of ['-1', '1.5', '01', '9223372036854775808', 12, '']) {
            expect((await send(signed(a, sampleBody({ bytes })), d)).status).toBe(400);
        }
        expect((await send(signed(a, sampleBody({ reason: 'manual' })), d)).status).toBe(400);
        expect((await send(signed(a, '{"bytes":"1","bytes":"2","measuredAt":"2026-11-01T11:59:00Z","reason":"interval"}'), d)).status).toBe(400);
        expect(record).not.toHaveBeenCalled();
        expect((await send(signed(a, sampleBody({ bytes: '9223372036854775807' })), d)).status).toBe(200);
    });

    it('is off without AWS computers or the app↔Worker secret, and retryable when the database fails', async () => {
        const off = deps([a], { env: { CLOUDFLARE_GUACAMOLE_HMAC_SECRET: SECRET } });
        expect(await send(signed(a, sampleBody()), off.d)).toEqual({ status: 404, body: { error: 'not_found' } });
        const unset = deps([a], { env: { EZIL_AWS_COMPUTERS_ENABLED: '1' } });
        expect(await send(signed(a, sampleBody()), unset.d)).toEqual({ status: 503, body: { error: 'storage_unavailable', retryable: true } });
        const down = deps([a], { placement: async () => { throw new Error('db down'); } });
        expect((await send(signed(a, sampleBody()), down.d)).body).toEqual({ error: 'storage_unavailable', retryable: true });
        const failing = deps([a], { record: async () => { throw new Error('insert failed'); } });
        expect((await send(signed(a, sampleBody()), failing.d)).status).toBe(503);
        for (const x of [off, unset, down]) expect(x.record).not.toHaveBeenCalled();
    });

    it('answers a computer whose placement an image job holds, or whose row is invalid, exactly as an unknown computer (no oracle)', async () => {
        const raw = async (request: Request, d: HostStorageDeps) => {
            const response = await handleHostStorageSample(request, d);
            return { status: response.status, cache: response.headers.get('cache-control'), text: await response.text() };
        };
        const unknown = await raw(signed(a, sampleBody()), deps([]).d);
        expect(unknown).toEqual({ status: 401, cache: 'no-store', text: '{"error":"storage_unauthenticated"}' });
        for (const thrown of [new ImageJobConflictError(), new PlacementIntegrityError('duplicate_placement', A), new PlacementIntegrityError('unknown_state', A)]) {
            const held = deps([a], { placement: async () => { throw thrown; } });
            expect(await raw(signed(a, sampleBody()), held.d)).toEqual(unknown);
            expect(held.record).not.toHaveBeenCalled();
        }
        // Positive control: a failure that is not about this computer (the database) stays 503 and retryable.
        const down = deps([a], { placement: async () => { throw new Error('connection terminated'); } });
        expect(await send(signed(a, sampleBody()), down.d)).toEqual({ status: 503, body: { error: 'storage_unavailable', retryable: true } });
    });

    it('refuses an oversized body before reading any placement', async () => {
        const placementRead = vi.fn().mockResolvedValue(a);
        const { d } = deps([a], { placement: placementRead });
        expect((await send(signed(a, sampleBody({ pad: 'x'.repeat(5000) })), d)).status).toBe(413);
        expect(placementRead).not.toHaveBeenCalled();
    });
});
