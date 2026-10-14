/**
 * C-6 enrollment endpoint (aws-enroll.ts `handleAwsEnrollment`) against the
 * fake placement database, a recording EC2 describer and a recording GW-1
 * tunnel client. The identity document and its PKCS7 signature are the
 * OpenSSL fixtures (aws-identity.fixtures.json). No network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    awsSandboxId,
    createWorkerTunnelClient,
    handleAwsEnrollment,
    nonceHashOf,
    TUNNELS_PATH,
    type Ec2EnrollmentView,
    type EnrollDeps,
    type TunnelClient,
    type TunnelRequest,
} from './aws-enroll';
import { AWS_IDENTITY_CERTS_ENV } from './aws-identity';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import fx from './aws-identity.fixtures.json';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { readPlacement } from './placement';
import * as placement from './placement';
import { mintPreviewTokenV2 } from './preview-token-v2';

const U1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
// After the fixture certificates' notBefore (2026-10-14T09:16Z).
const NOW = new Date('2026-10-20T00:00:00Z');
const NONCE = Buffer.alloc(32, 5).toString('base64url');
const FENCE = 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd';
const DOC = JSON.parse(fx.document) as { instanceId: string; availabilityZone: string };
const KEY = Buffer.alloc(32, 0xab);
const TOKEN = 'tunnel-token-' + 'x'.repeat(40);
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];

const env = (over: Record<string, string> = {}) => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    [AWS_IDENTITY_CERTS_ENV]: JSON.stringify({ 'ap-south-1': fx.cert_rsa }),
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': fixtureDeployment('ap-south-1', TYPES) }),
    ...over,
});

/** A replace boot (generation 2, epoch 3) waiting for its host. */
const booting = (over: Record<string, unknown> = {}) =>
    placementRow({
        computer_id: C1, owner_user_id: U1, state: 'STARTING', generation: 2, lease_epoch: 3, region: 'ap-south-1', zone_id: 'aps1-az1',
        instance_type: 't3a.medium', instance_id: null, volume_id: 'vol-11111111111111111', fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5',
        fence_token: FENCE, enroll_nonce_hash: nonceHashOf(NONCE), enroll_expires_at: new Date(NOW.getTime() + 300_000), ...over,
    });

const generationTags = (over: Record<string, string> = {}) => ({
    'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:computer-id': C1, 'ezil:generation': '2', 'ezil:fence-token': FENCE, ...over,
});

const liveView = (over: Partial<Ec2EnrollmentView> = {}): Ec2EnrollmentView => ({
    instanceId: DOC.instanceId,
    state: 'running',
    availabilityZone: DOC.availabilityZone,
    availabilityZoneId: 'aps1-az1',
    publicIp: '13.0.0.5',
    tags: generationTags(),
    volumes: [
        { volumeId: 'vol-11111111111111111', deleteOnTermination: false, tags: { ...generationTags(), 'ezil:backup': 'pilot' } },
        { volumeId: 'vol-99999999999999999', deleteOnTermination: true, tags: { ...generationTags(), 'ezil:disk-kind': 'root' } },
    ],
    ...over,
});

const hostBody = (over: Record<string, unknown> = {}) => ({
    computerId: C1, generation: 2, leaseEpoch: 3, nonce: NONCE, identityDocument: fx.document, signature: fx.pkcs7_rsa_detached, ...over,
});

function setup(rows = [booting()], over: Partial<EnrollDeps> & { e?: Record<string, string>; view?: Ec2EnrollmentView | null; tunnel?: TunnelClient['createTunnel']; clock?: () => Date } = {}) {
    const fake = createFakePlacementDb({ placements: rows }, { clock: over.clock ?? (() => NOW) });
    const described: { region: string; instanceId: string }[] = [];
    const tunnels: { owner: { userId: string }; request: TunnelRequest }[] = [];
    const deps: EnrollDeps = {
        db: fake.db,
        env: over.e ?? env(),
        now: () => NOW,
        randomBytes: over.randomBytes ?? (() => Buffer.from(KEY)),
        describer:
            'describer' in over
                ? over.describer
                : {
                      async describeForEnrollment(region, instanceId) {
                          described.push({ region, instanceId });
                          return 'view' in over ? over.view! : liveView();
                      },
                  },
        tunnels:
            'tunnels' in over
                ? over.tunnels
                : {
                      createTunnel: over.tunnel ?? (async (owner, request) => (tunnels.push({ owner, request }), { ok: true, tunnelToken: TOKEN })),
                      deleteTunnel: async () => ({ ok: true }),
                  },
    };
    return { ...fake, deps, described, tunnels, enroll: (b: unknown = hostBody()) => handleAwsEnrollment(deps, b) };
}

afterEach(() => vi.restoreAllMocks());

describe('a valid enrollment', () => {
    it('200 {tunnelToken, controlKey}; the nonce is cleared and the verified instance + volume recorded; GW-1 called once', async () => {
        const { enroll, placements, tunnels, described } = setup();
        const r = await enroll();
        expect(r).toEqual({ status: 200, body: { tunnelToken: TOKEN, controlKey: KEY.toString('base64') } });
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: null, enroll_expires_at: null, instance_id: DOC.instanceId, volume_id: 'vol-11111111111111111', state: 'STARTING', last_error: placement.ENROLLMENT_SUCCEEDED });
        expect(described).toEqual([{ region: 'ap-south-1', instanceId: DOC.instanceId }]);
        expect(tunnels).toEqual([
            {
                owner: { userId: U1 },
                request: {
                    computerId: C1, sandboxId: awsSandboxId(C1), generation: 2, leaseEpoch: 3, instanceId: DOC.instanceId, region: 'ap-south-1', publicIp: '13.0.0.5',
                    controlKey: KEY.toString('base64'),
                },
            },
        ]);
        expect(awsSandboxId(C1)).toBe('c1c1c1c1c1c14c1c');
    });

    it('works once: a second enrollment for the same epoch is refused and opens no tunnel', async () => {
        const { enroll, tunnels } = setup();
        expect((await enroll()).status).toBe(200);
        expect(await enroll()).toEqual({ status: 403, body: { error: 'enroll_nonce_invalid' } });
        expect(tunnels).toHaveLength(1);
    });

    it('two concurrent enrollments: exactly one wins the compare-and-swap', async () => {
        const { enroll, tunnels } = setup();
        const results = await Promise.all([enroll(), enroll()]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(tunnels).toHaveLength(1);
    });

    it('a provision (no volume recorded yet) picks the one retained data volume tagged for the computer and records it', async () => {
        const { enroll, placements } = setup([booting({ state: 'PROVISIONING', volume_id: null, instance_id: null })]);
        expect((await enroll()).status).toBe(200);
        expect(placements[0]).toMatchObject({ volume_id: 'vol-11111111111111111', instance_id: DOC.instanceId });
    });

    it('MOUNTING is enrollable too (C-6: STARTING or MOUNTING)', async () => {
        const { enroll } = setup([booting({ state: 'MOUNTING' })]);
        expect((await enroll()).status).toBe(200);
    });

    it('a receipt moving STARTING to MOUNTING during describe still enrolls without rewinding state', async () => {
        const s = setup();
        const consume = vi.spyOn(placement, 'consumeEnrollmentNonce');
        s.deps.describer = { describeForEnrollment: async () => {
            Object.assign(s.placements[0]!, { state: 'MOUNTING', instance_id: DOC.instanceId });
            return liveView();
        } };
        expect((await s.enroll()).status).toBe(200);
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: placement.ENROLLMENT_SUCCEEDED });
        expect(consume).toHaveBeenCalledTimes(1);
        expect(s.tunnels).toHaveLength(1);
    });

    it('re-reads an unconsumed boot after a CAS miss and retries once', async () => {
        const s = setup();
        const consume = vi.spyOn(placement, 'consumeEnrollmentNonce').mockResolvedValueOnce({ ok: false, reason: 'cas_conflict' });
        expect((await s.enroll()).status).toBe(200);
        expect(consume).toHaveBeenCalledTimes(2);
        expect(s.tunnels).toHaveLength(1);
    });

    it('a second unexplained miss is bounded and is not reported as a consumed nonce', async () => {
        const s = setup();
        const consume = vi.spyOn(placement, 'consumeEnrollmentNonce').mockResolvedValue({ ok: false, reason: 'cas_conflict' });
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'enroll_conflict' } });
        expect(consume).toHaveBeenCalledTimes(2);
        expect(s.placements[0]!.enroll_nonce_hash).toBe(nonceHashOf(NONCE));
        expect(s.tunnels).toEqual([]);
    });

    it.each(['generation', 'lease_epoch'] as const)('a moved %s is terminal without retrying the CAS', async (counter) => {
        const s = setup();
        s.deps.describer = { describeForEnrollment: async () => {
            s.placements[0]![counter] = Number(s.placements[0]![counter]) + 1;
            return liveView();
        } };
        const consume = vi.spyOn(placement, 'consumeEnrollmentNonce');
        expect(await s.enroll()).toEqual({ status: 409, body: { error: 'enroll_stale_epoch' } });
        expect(consume).toHaveBeenCalledTimes(1);
        expect(s.tunnels).toEqual([]);
    });

    it('never logs the nonce, the control key or the tunnel token', async () => {
        const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        const { enroll } = setup();
        await enroll();
        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        for (const secret of [NONCE, KEY.toString('base64'), TOKEN]) expect(logged).not.toContain(secret);
    });
});

describe('every refusal changes nothing (nonce kept, no tunnel)', () => {
    const cases: [string, Parameters<typeof setup>, unknown, number, string][] = [
        ['flag off', [[booting()], { e: env({ EZIL_AWS_COMPUTERS_ENABLED: '0' }) }], hostBody(), 404, 'not_found'],
        ['no describe client', [[booting()], { describer: null }], hostBody(), 503, 'enroll_unavailable'],
        ['no tunnel client', [[booting()], { tunnels: null }], hostBody(), 503, 'enroll_unavailable'],
        ['malformed body', [[booting()]], { ...hostBody(), extra: 1 }, 400, 'enroll_request_invalid'],
        ['short nonce', [[booting()]], hostBody({ nonce: 'abc' }), 400, 'enroll_request_invalid'],
        ['unknown computer', [[]], hostBody(), 403, 'enroll_refused'],
        ['a Cloudflare computer', [[booting({ provider: 'cloudflare', workspace_store: 'r2' })]], hostBody(), 403, 'enroll_refused'],
        ['wrong state (RUNNING)', [[booting({ state: 'RUNNING' })]], hostBody(), 403, 'enroll_state'],
        ['wrong state (STOPPED)', [[booting({ state: 'STOPPED' })]], hostBody(), 403, 'enroll_state'],
        ['stale epoch', [[booting()]], hostBody({ leaseEpoch: 2 }), 403, 'enroll_stale_epoch'],
        ['stale generation', [[booting()]], hostBody({ generation: 1 }), 403, 'enroll_stale_epoch'],
        ['wrong nonce', [[booting()]], hostBody({ nonce: Buffer.alloc(32, 6).toString('base64url') }), 403, 'enroll_nonce_invalid'],
        ['expired nonce', [[booting({ enroll_expires_at: new Date(NOW.getTime() - 1) })]], hostBody(), 403, 'enroll_nonce_expired'],
        ['no region certificate', [[booting()], { e: env({ [AWS_IDENTITY_CERTS_ENV]: JSON.stringify({ 'us-east-1': fx.cert_rsa }) }) }], hostBody(), 503, 'enroll_unavailable'],
        ['a signature by another key', [[booting()], { e: env({ [AWS_IDENTITY_CERTS_ENV]: JSON.stringify({ 'ap-south-1': fx.cert_other }) }) }], hostBody(), 403, 'identity_signature_mismatch'],
        ['a tampered document', [[booting()]], hostBody({ identityDocument: fx.document.replace('10.0.0.12', '10.0.0.13') }), 403, 'identity_signature_mismatch'],
        ['a receipt already bound another instance', [[booting({ instance_id: 'i-33333333333333333' })]], hostBody(), 403, 'instance_mismatch'],
        ['instance type differs from the placement', [[booting({ instance_type: 'm6i.large' })]], hostBody(), 403, 'identity_document_mismatch'],
        [
            'another account',
            [[booting()], { e: env({ [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': { ...fixtureDeployment('ap-south-1', TYPES), accountId: '210987654321', dataKeyArn: 'arn:aws:kms:ap-south-1:210987654321:key/11111111-1111-4111-8111-111111111111', stateMachineVersionArn: 'arn:aws:states:ap-south-1:210987654321:stateMachine:ezil-pilot-lifecycle:1' } }) }) }],
            hostBody(), 403, 'identity_document_mismatch',
        ],
        ['instance unknown to EC2', [[booting()], { view: null }], hostBody(), 403, 'enroll_instance_unknown'],
        ['instance not running', [[booting()], { view: liveView({ state: 'stopping' }) }], hostBody(), 403, 'enroll_instance_not_running'],
        ['another ZoneId', [[booting()], { view: liveView({ availabilityZoneId: 'aps1-az2' }) }], hostBody(), 403, 'enroll_zone_mismatch'],
        ['describe AZ differs from the document', [[booting()], { view: liveView({ availabilityZone: 'ap-south-1b' }) }], hostBody(), 403, 'enroll_zone_mismatch'],
        ["the previous generation's instance (old fence)", [[booting()], { view: liveView({ tags: generationTags({ 'ezil:fence-token': 'fefefefe-fefe-4efe-8efe-fefefefefefe' }) }) }], hostBody(), 403, 'enroll_instance_mismatch'],
        ['instance of another computer', [[booting()], { view: liveView({ tags: generationTags({ 'ezil:computer-id': 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2' }) }) }], hostBody(), 403, 'enroll_instance_mismatch'],
        ['instance of another namespace', [[booting()], { view: liveView({ tags: generationTags({ 'ezil:stage': 'other' }) }) }], hostBody(), 403, 'enroll_instance_mismatch'],
        ['no public address', [[booting()], { view: liveView({ publicIp: null }) }], hostBody(), 403, 'enroll_instance_mismatch'],
        ['data volume not attached', [[booting()], { view: liveView({ volumes: [] }) }], hostBody(), 403, 'enroll_volume_mismatch'],
        ['data volume marked delete-on-termination', [[booting()], { view: liveView({ volumes: [{ volumeId: 'vol-11111111111111111', deleteOnTermination: true, tags: generationTags() }] }) }], hostBody(), 403, 'enroll_volume_mismatch'],
        [
            'provision with two candidate data volumes',
            [[booting({ state: 'PROVISIONING', volume_id: null })], { view: liveView({ volumes: [{ volumeId: 'vol-11111111111111111', deleteOnTermination: false, tags: generationTags() }, { volumeId: 'vol-22222222222222222', deleteOnTermination: false, tags: generationTags() }] }) }],
            hostBody(), 403, 'enroll_volume_mismatch',
        ],
    ];

    it.each(cases)('%s → %i %s', async (_n, args, body, status, error) => {
        const { enroll, placements, tunnels, described } = setup(...args);
        const before = placements.map((r) => ({ ...r }));
        expect(await enroll(body)).toEqual({ status, body: { error } });
        if (error === 'instance_mismatch') expect(described).toEqual([]);
        expect(placements).toEqual(before);
        expect(tunnels).toEqual([]);
    });

    it('expiry reached during EC2 describe is refused by the database clock, even with a stale JS clock', async () => {
        let clock = NOW;
        const s = setup([booting()], { clock: () => clock });
        s.deps.describer = { describeForEnrollment: async () => {
            clock = new Date(NOW.getTime() + 300_000);
            return liveView();
        } };
        expect((await s.enroll()).status).not.toBe(200);
        expect(s.placements[0]).toMatchObject({ enroll_nonce_hash: nonceHashOf(NONCE), instance_id: null, last_error: null });
        expect(s.tunnels).toEqual([]);
    });

    it('an instance bound by a receipt during describe cannot be overwritten by the CAS', async () => {
        const s = setup();
        s.deps.describer = { describeForEnrollment: async () => {
            s.placements[0]!.instance_id = 'i-33333333333333333';
            return liveView();
        } };
        expect(await s.enroll()).toEqual({ status: 403, body: { error: 'instance_mismatch' } });
        expect(s.placements[0]).toMatchObject({ instance_id: 'i-33333333333333333', enroll_nonce_hash: nonceHashOf(NONCE) });
        expect(s.tunnels).toEqual([]);
    });

    it.each([() => Buffer.alloc(16), () => { throw new Error('random'); }])('a broken random source leaves the nonce intact', async (randomBytes) => {
        const s = setup([booting()], { randomBytes });
        expect(await s.enroll()).toEqual({ status: 500, body: { error: 'enroll_failed' } });
        expect(s.placements[0]!.enroll_nonce_hash).toBe(nonceHashOf(NONCE));
        expect(s.tunnels).toEqual([]);
    });

    it('a describe failure is 503 and changes nothing', async () => {
        const { enroll, placements } = setup([booting()], { describer: { describeForEnrollment: async () => { throw new Error('throttled'); } } });
        expect(await enroll()).toEqual({ status: 503, body: { error: 'enroll_describe_unavailable' } });
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: nonceHashOf(NONCE) });
    });
});

describe('after the nonce is consumed', () => {
    it('a tunnel failure is non-200, the nonce stays consumed, and no control key is returned', async () => {
        const { enroll, placements } = setup([booting()], { tunnel: async () => ({ ok: false, status: 409, code: 'tunnel_exists' }) });
        expect(await enroll()).toEqual({ status: 502, body: { error: 'tunnel_unavailable' } });
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: null, state: 'UNCONFIRMED', last_error: placement.ENROLLMENT_FAILED });
        // The host never re-sends it (enroll.py), and a replay is refused.
        expect((await enroll()).status).toBe(403);
    });

    it('a thrown tunnel call is the same 502', async () => {
        const { enroll, placements } = setup([booting()], { tunnel: async () => { throw new Error('socket'); } });
        expect(await enroll()).toEqual({ status: 502, body: { error: 'tunnel_unavailable' } });
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: placement.ENROLLMENT_FAILED });
    });

    it.each(['generation', 'lease_epoch'] as const)('GW-1 completion cannot mark a newer %s successful', async (counter) => {
        const s = setup();
        s.deps.tunnels = {
            createTunnel: async () => {
                s.placements[0]![counter] = Number(s.placements[0]![counter]) + 1;
                return { ok: true, tunnelToken: TOKEN };
            },
            deleteTunnel: async () => ({ ok: true }),
        };
        expect(await s.enroll()).toEqual({ status: 409, body: { error: 'enroll_conflict' } });
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_PENDING, enroll_nonce_hash: null });
    });
});

describe('createWorkerTunnelClient (GW-1 over HTTPS)', () => {
    const SECRET = 's'.repeat(32);
    const req: TunnelRequest = {
        computerId: C1, sandboxId: awsSandboxId(C1), generation: 2, leaseEpoch: 3, instanceId: DOC.instanceId, region: 'ap-south-1', publicIp: '13.0.0.5', controlKey: KEY.toString('base64'),
    };

    it('POSTs the exact body to /internal/aws/tunnels with a v2 aws-ec2 envelope bound to the body', async () => {
        const seen: { url: string; init: RequestInit }[] = [];
        const client = createWorkerTunnelClient({
            workerUrl: 'https://worker.example.test/',
            secret: SECRET,
            now: () => NOW,
            fetch: (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(JSON.stringify({ tunnelToken: TOKEN }), { status: 200 }))) as typeof fetch,
        });
        expect(await client.createTunnel({ userId: U1 }, req)).toEqual({ ok: true, tunnelToken: TOKEN });
        expect(seen[0]!.url).toBe(`https://worker.example.test${TUNNELS_PATH}`);
        expect(seen[0]!.init).toMatchObject({ method: 'POST', body: JSON.stringify(req), redirect: 'error' });
        const want = mintPreviewTokenV2(
            SECRET,
            { ts: Math.floor(NOW.getTime() / 1000), sandboxId: req.sandboxId, computerId: C1, userId: U1, provider: 'aws-ec2', store: '', generation: 2, leaseEpoch: 3 },
            { method: 'POST', path: TUNNELS_PATH, body: JSON.stringify(req) },
        );
        expect((seen[0]!.init.headers as Record<string, string>)['x-ezil-auth']).toBe(want);
    });

    it.each([
        ['a 409', new Response('{}', { status: 409 }), { ok: false, status: 409, code: 'tunnel_http_409' }],
        ['a short token', new Response(JSON.stringify({ tunnelToken: 'x' }), { status: 200 }), { ok: false, status: 502, code: 'tunnel_response_malformed' }],
        ['not JSON', new Response('nope', { status: 200 }), { ok: false, status: 502, code: 'tunnel_response_malformed' }],
    ])('%s is a failure', async (_n, response, want) => {
        const client = createWorkerTunnelClient({ workerUrl: 'https://w.example.test', secret: SECRET, fetch: (async () => response) as unknown as typeof fetch });
        expect(await client.createTunnel({ userId: U1 }, req)).toEqual(want);
    });

    it('DELETE carries only the fence fields', async () => {
        const seen: RequestInit[] = [];
        const client = createWorkerTunnelClient({ workerUrl: 'https://w.example.test', secret: SECRET, fetch: (async (_u: string, init: RequestInit) => (seen.push(init), new Response('{"deleted":true}', { status: 200 }))) as typeof fetch });
        expect(await client.deleteTunnel({ userId: U1 }, { computerId: C1, sandboxId: req.sandboxId, generation: 2, leaseEpoch: 3 })).toEqual({ ok: true, status: 200 });
        expect(seen[0]).toMatchObject({ method: 'DELETE', body: JSON.stringify({ computerId: C1, generation: 2, leaseEpoch: 3 }) });
    });
});

describe('consumeEnrollmentNonce SQL', () => {
    it('one UPDATE matches generation, epoch, state, provider, nonce hash AND an unexpired deadline, and clears both', async () => {
        const { enroll, statements } = setup();
        await enroll();
        const cas = statements.filter((st) => st.sql.includes('placement:cas'));
        expect(cas).toHaveLength(2); // consume, then record GW-1 success
        for (const frag of ['generation = $', 'lease_epoch = $', 'state IN (', 'provider = $', 'enroll_nonce_hash = $', 'enroll_expires_at > now()', '(instance_id IS NULL OR instance_id = $']) expect(cas[0]!.sql).toContain(frag);
        expect(cas[0]!.sql).toContain('state = state');
        const { record } = await readPlacement(setup().db, C1);
        expect(record?.enrollNonceHash).toBe(nonceHashOf(NONCE));
    });
});
