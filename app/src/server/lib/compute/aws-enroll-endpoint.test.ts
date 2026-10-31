/**
 * C-6 enrollment endpoint (aws-enroll.ts `handleAwsEnrollment`) against the
 * fake placement database, a recording EC2 describer and a recording GW-1
 * tunnel client. The identity document and its PKCS7 signature are the
 * OpenSSL fixtures (aws-identity.fixtures.json). No network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    AWS_BROWSER_ZONE_ENV,
    awsSandboxId,
    createWorkerTunnelClient,
    deriveControlKey,
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
import { applyLifecycleReceipt, lifecycleExecutionArn } from './aws-receipts';
import fx from './aws-identity.fixtures.json';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { readPlacement } from './placement';
import * as placement from './placement';
import { mintPreviewTokenV2 } from './preview-token-v2';
import { deriveGuacamoleSandboxId } from '../cloudflare-guacamole-provider';
import { verifyPreviewTokenV2 } from '../../../../../worker/src/hmac';
import { createAwsTunnelService, createCloudflareTunnelApi, TUNNEL_REPLAY_WINDOW_MS, type CloudflareTunnelApi } from '../../../../../worker/src/aws-tunnels';
import { logEnrollRefusal, resetEnrollRefusalLogForTests } from './aws-enroll-log';

const U1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
// After the fixture certificates' notBefore (2026-10-14T09:16Z).
const NOW = new Date('2026-10-20T00:00:00Z');
const NONCE = Buffer.alloc(32, 5).toString('base64url');
const FENCE = 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd';
const DOC = JSON.parse(fx.document) as { instanceId: string; availabilityZone: string };
const CONTROL_SECRET = 'control-key-secret-for-tests';
/** The derived control key of the default boot (generation 2, epoch 3, NONCE). */
const KEY = deriveControlKey(CONTROL_SECRET, { computerId: C1, generation: 2, leaseEpoch: 3, nonceHash: nonceHashOf(NONCE) });
const TOKEN = 'tunnel-token-' + 'x'.repeat(40);
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];

const env = (over: Record<string, string> = {}) => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    [AWS_IDENTITY_CERTS_ENV]: JSON.stringify({ 'ap-south-1': fx.cert_rsa }),
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': fixtureDeployment('ap-south-1', TYPES) }),
    [AWS_BROWSER_ZONE_ENV]: 'ezil.org',
    ...over,
});
/** The Worker's routable form (worker/src/aws-origin.ts SANDBOX_ID). */
const SID = 'guac-1111111111114111-c1c1c1c1c1c14c1c';

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
        controlKeySecret: 'controlKeySecret' in over ? over.controlKeySecret : CONTROL_SECRET,
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

/**
 * The app's REAL GW-1 client (createWorkerTunnelClient) against the Worker's REAL tunnel
 * service (aws-tunnels.ts), v2-verified by the Worker's own hmac.ts, over a fake Cloudflare
 * API that counts the tunnels it is asked to create.
 */
function workerBackedTunnels(clockMs: () => number = () => NOW.getTime(), cloudflare?: CloudflareTunnelApi) {
    const map = new Map<string, unknown>();
    const storage = {
        async get<T>(k: string) { return map.get(k) as T | undefined; },
        async put<T>(k: string, v: T) { map.set(k, structuredClone(v)); },
        async delete(k: string) { return map.delete(k); },
    };
    let n = 0;
    const created: string[] = [];
    const named = new Map<string, string>(); // tunnel name -> id, as Cloudflare would keep it
    const cnames = new Map<string, { id: string; content: string }>();
    const api: CloudflareTunnelApi = {
        async createTunnel(name) { created.push(name); const id = `tun-${++n}`; named.set(name, id); return { id }; },
        async findTunnelByName(name) { const id = named.get(name); return id ? { id } : null; },
        async getTunnelToken(id) { return `token-for-${id}-${'x'.repeat(24)}`; },
        async putTunnelIngress() {},
        async createDnsCname(host, target) { const r = { id: `dns-${n}`, content: target }; cnames.set(host, r); return { id: r.id }; },
        async findDnsCname(host) { return cnames.get(host) ?? null; },
        async deleteDnsRecord(id) { for (const [h, r] of cnames) if (r.id === id) cnames.delete(h); },
        async deleteTunnel(id) { for (const [k, v] of named) if (v === id) named.delete(k); },
        async listConnectorOrigins() { return []; },
    };
    const service = createAwsTunnelService({ api: cloudflare ?? api, storage, zone: 'origin.example.net', nowMs: clockMs });
    const secret = 'worker-hmac-secret-for-tests';
    const client = createWorkerTunnelClient({
        workerUrl: 'https://w.example.test', secret, now: () => new Date(clockMs()),
        fetch: (async (url: string, init: RequestInit) => {
            const body = String(init.body);
            const method = String(init.method);
            const auth = (init.headers as Record<string, string>)['x-ezil-auth'];
            const v = await verifyPreviewTokenV2(auth, secret, { method, path: new URL(url).pathname, body }, clockMs());
            if (!v.ok) return new Response(JSON.stringify({ ok: false, error: v.error }), { status: 401 });
            const r = method === 'POST' ? await service.create(v.claims, body) : await service.remove(v.claims, body);
            return new Response(JSON.stringify(r.body), { status: r.status });
        }) as typeof fetch,
    });
    return { client, created };
}

describe('a valid enrollment', () => {
    it('200 {tunnelToken, controlKey}; the nonce is cleared and the verified instance + volume recorded; GW-1 called once', async () => {
        const { enroll, placements, tunnels, described } = setup();
        const r = await enroll();
        expect(r).toEqual({ status: 200, body: { tunnelToken: TOKEN, controlKey: KEY.toString('base64'), sandboxId: SID, zone: 'ezil.org' } });
        // Single use: the nonce hash moved to the consumed proof; its deadline stays as that proof's window.
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: null, enroll_consumed_hash: nonceHashOf(NONCE), instance_id: DOC.instanceId, volume_id: 'vol-11111111111111111', state: 'STARTING', last_error: placement.ENROLLMENT_SUCCEEDED });
        expect(placements[0]!.enroll_expires_at).toEqual(booting().enroll_expires_at);
        expect(described).toEqual([{ region: 'ap-south-1', instanceId: DOC.instanceId }]);
        expect(tunnels).toEqual([
            {
                owner: { userId: U1 },
                request: {
                    computerId: C1, sandboxId: SID, generation: 2, leaseEpoch: 3, instanceId: DOC.instanceId, region: 'ap-south-1', publicIp: '13.0.0.5',
                    controlKey: KEY.toString('base64'),
                },
            },
        ]);
        // Codex PR #200: the Worker's tunnel route accepts only `guac-<user>-<computer>` ids, and the
        // preview path derives the same one, so the tunnel and the browser name one sandbox.
        expect(awsSandboxId(U1, C1)).toBe(SID);
        expect(SID).toMatch(/^guac-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/);
        expect(awsSandboxId(U1.toUpperCase(), C1.toUpperCase())).toBe(deriveGuacamoleSandboxId(U1, C1));
    });

    it('works once: another nonce for a completed epoch gets nothing and opens no tunnel', async () => {
        const w = workerBackedTunnels();
        const { enroll } = setup([booting()], { tunnels: w.client });
        expect((await enroll()).status).toBe(200);
        const other = Buffer.alloc(32, 6).toString('base64url');
        // Refused by the consumed-nonce proof before any Worker call (C-6).
        expect(await enroll(hostBody({ nonce: other }))).toEqual({ status: 403, body: { error: 'enroll_nonce_invalid' } });
        expect(w.created).toHaveLength(1);
    });

    it('Codex PR #200: a host whose 200 was lost replays with its nonce and gets the SAME credentials; no second tunnel', async () => {
        const w = workerBackedTunnels();
        const { enroll, placements } = setup([booting()], { tunnels: w.client });
        const first = await enroll();
        expect(first.status).toBe(200);
        expect(first.body.controlKey).toBe(KEY.toString('base64'));
        const after = { ...placements[0] };
        // The response never reached the host; it retries with the nonce it kept (enroll.py).
        expect(await enroll()).toEqual(first);
        expect(w.created).toHaveLength(1);
        expect(placements[0]).toEqual(after); // a replay writes nothing
    });

    it('the replay also works once the boot is RUNNING, and not after the window', async () => {
        let t = NOW.getTime();
        const w = workerBackedTunnels(() => t);
        const { enroll, placements } = setup([booting()], { tunnels: w.client });
        const first = await enroll();
        placements[0]!.state = 'RUNNING';
        expect(await enroll()).toEqual(first);
        t += TUNNEL_REPLAY_WINDOW_MS + 1;
        // The Worker's own refusal is kept server-side for the route's log; the host sees only the body.
        expect(await enroll()).toEqual({ status: 409, body: { error: 'enroll_nonce_consumed' },
            tunnel: { code: 'tunnel_http_409', workerError: 'tunnel_replay_refused' } });
        expect(w.created).toHaveLength(1);
    });

    it('a replay from another instance is refused before any tunnel call', async () => {
        const w = workerBackedTunnels();
        const s = setup([booting()], { tunnels: w.client });
        expect((await s.enroll()).status).toBe(200);
        s.placements[0]!.instance_id = 'i-33333333333333333';
        expect(await s.enroll()).toEqual({ status: 403, body: { error: 'instance_mismatch' } });
        expect(w.created).toHaveLength(1);
    });

    it('only a completed enrollment replays: a failed one (UNCONFIRMED) stays refused', async () => {
        const s = setup([booting()], { tunnel: async () => ({ ok: false, status: 401, code: 'tunnel_http_401' }) });
        expect((await s.enroll()).status).toBe(502);
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: placement.ENROLLMENT_FAILED });
        expect((await s.enroll()).status).toBe(403);
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
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'enroll_conflict', retryable: true } });
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
        ["instance still pending in EC2's view", [[booting()], { view: liveView({ state: 'pending' }) }], hostBody(), 403, 'enroll_instance_not_running'],
        ['provision: data volume not visible yet', [[booting({ state: 'PROVISIONING', volume_id: null })], { view: liveView({ volumes: [] }) }], hostBody(), 403, 'enroll_volume_mismatch'],
        ['data volume marked delete-on-termination', [[booting()], { view: liveView({ volumes: [{ volumeId: 'vol-11111111111111111', deleteOnTermination: true, tags: generationTags() }] }) }], hostBody(), 403, 'enroll_volume_mismatch'],
        [
            'provision with two candidate data volumes',
            [[booting({ state: 'PROVISIONING', volume_id: null })], { view: liveView({ volumes: [{ volumeId: 'vol-11111111111111111', deleteOnTermination: false, tags: generationTags() }, { volumeId: 'vol-22222222222222222', deleteOnTermination: false, tags: generationTags() }] }) }],
            hostBody(), 403, 'enroll_volume_mismatch',
        ],
    ];

    // Nothing consumed AND it may clear on its own: the host keeps its nonce and retries
    // (enroll.py). Every other refusal is final: the host wipes the nonce.
    const RETRYABLE = new Set([
        'flag off', 'no describe client', 'no tunnel client', 'no region certificate',
        'data volume not attached', "instance still pending in EC2's view", 'provision: data volume not visible yet',
    ]);

    it.each(cases)('%s → %i %s', async (name, args, body, status, error) => {
        const { enroll, placements, tunnels, described } = setup(...args);
        const before = placements.map((r) => ({ ...r }));
        expect(await enroll(body)).toEqual({ status, body: RETRYABLE.has(name) ? { error, retryable: true } : { error } });
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

    it.each([undefined, '', '   '])('no control-key secret (%j) leaves the nonce intact', async (controlKeySecret) => {
        const s = setup([booting()], { controlKeySecret });
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'enroll_unavailable', retryable: true } });
        expect(s.placements[0]!.enroll_nonce_hash).toBe(nonceHashOf(NONCE));
        expect(s.tunnels).toEqual([]);
    });

    it('a describe failure is 503 and changes nothing', async () => {
        const { enroll, placements } = setup([booting()], { describer: { describeForEnrollment: async () => { throw new Error('throttled'); } } });
        expect(await enroll()).toEqual({ status: 503, body: { error: 'enroll_describe_unavailable', retryable: true } });
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: nonceHashOf(NONCE) });
    });
});

describe('the browser zone the host is told (EZIL_AWS_BROWSER_ZONE)', () => {
    it.each([undefined, '', 'EZIL.ORG', 'org', 'ezil..org', '-ezil.org', 'ezil.org.', 'a/b.org', '10.0.0.1', 'https://ezil.org'])(
        '%j: 503 before anything changes (nonce intact, no tunnel)',
        async (zone) => {
            const e = env();
            if (zone === undefined) delete (e as Record<string, string>)[AWS_BROWSER_ZONE_ENV];
            else e[AWS_BROWSER_ZONE_ENV] = zone;
            const { enroll, placements, tunnels } = setup([booting()], { e });
            expect(await enroll()).toEqual({ status: 503, body: { error: 'enroll_unavailable', retryable: true } });
            expect(placements[0]).toMatchObject({ enroll_nonce_hash: nonceHashOf(NONCE), instance_id: null });
            expect(tunnels).toEqual([]);
        },
    );

    it('a valid zone is returned verbatim with the routable sandbox id', async () => {
        const { enroll } = setup([booting()], { e: env({ [AWS_BROWSER_ZONE_ENV]: ' ezil.work ' }) });
        expect((await enroll()).body).toMatchObject({ sandboxId: SID, zone: 'ezil.work' });
    });
});

describe('after the nonce is consumed', () => {
    it('a tunnel failure is non-200, the nonce stays consumed, and no control key is returned', async () => {
        const { enroll, placements } = setup([booting()], { tunnel: async () => ({ ok: false, status: 409, code: 'tunnel_exists' }) });
        expect(await enroll()).toEqual({ status: 502, body: { error: 'tunnel_unavailable' }, tunnel: { code: 'tunnel_exists' } });
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: null, state: 'UNCONFIRMED', last_error: placement.ENROLLMENT_FAILED });
        // The host never re-sends it (enroll.py), and a replay is refused.
        expect((await enroll()).status).toBe(403);
    });

    it('a thrown tunnel call is ambiguous: retryable 503, still pending, the consumed proof kept', async () => {
        const { enroll, placements } = setup([booting()], { tunnel: async () => { throw new Error('socket'); } });
        expect(await enroll()).toEqual({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, tunnel: { code: 'tunnel_transport' } });
        expect(placements[0]).toMatchObject({ state: 'STARTING', last_error: placement.ENROLLMENT_PENDING, enroll_nonce_hash: null, enroll_consumed_hash: nonceHashOf(NONCE) });
    });

    /** Make the Nth database transaction fail (1 = the consume, 2 = the completion); `commitFirst` loses only the answer. */
    function failTransaction(db: unknown, nth: number, commitFirst = false) {
        const d = db as { transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
        const real = d.transaction.bind(d);
        let n = 0;
        d.transaction = async (fn) => {
            n++;
            if (n !== nth) return real(fn);
            if (commitFirst) await real(fn);
            throw new Error('connection terminated unexpectedly');
        };
    }

    it('Codex PR #200: the completion write fails after the tunnel exists → retryable 503; the retry finishes on the SAME tunnel', async () => {
        const w = workerBackedTunnels();
        const s = setup([booting()], { tunnels: w.client });
        failTransaction(s.deps.db, 2);
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'enroll_finish_unavailable', retryable: true } });
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_PENDING, enroll_nonce_hash: null });
        // The host kept its nonce (retryable) and re-sends it.
        const again = await s.enroll();
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ controlKey: KEY.toString('base64'), tunnelToken: expect.stringContaining('token-for-tun-1') });
        expect(w.created).toHaveLength(1);
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_SUCCEEDED });
    });

    it('Codex PR #200: tunnel create AND completion write both fail → every answer is retryable; the tunnel is created once and finishes', async () => {
        const w = workerBackedTunnels();
        const s = setup([booting()], { tunnels: w.client });
        const real = w.client.createTunnel.bind(w.client);
        let first = true;
        w.client.createTunnel = async (owner, req) => { if (first) { first = false; throw new Error('socket'); } return real(owner, req); };
        failTransaction(s.deps.db, 2);
        // An ambiguous create attempts no finish at all (Codex 4277613521): still pending.
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, tunnel: { code: 'tunnel_transport' } });
        expect(w.created).toHaveLength(0);
        // The retry creates the tunnel; its completion write fails: still retryable.
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'enroll_finish_unavailable', retryable: true } });
        expect(w.created).toHaveLength(1);
        const again = await s.enroll();
        expect(again.status).toBe(200);
        expect(w.created).toHaveLength(1);
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_SUCCEEDED });
    });

    it('Codex PR #200: the consume committed but its answer was lost → the retry completes (pending path, one tunnel)', async () => {
        const w = workerBackedTunnels();
        const s = setup([booting()], { tunnels: w.client });
        failTransaction(s.deps.db, 1, true);
        await expect(s.enroll()).rejects.toThrow('connection terminated'); // the route answers this retryable (route.test.ts)
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_PENDING, enroll_nonce_hash: null });
        const again = await s.enroll();
        expect(again.status).toBe(200);
        expect(w.created).toHaveLength(1);
    });

    it('a pending enrollment with ANOTHER nonce while the tunnel exists: final 409, no second tunnel, nothing written', async () => {
        const w = workerBackedTunnels();
        const s = setup([booting()], { tunnels: w.client });
        failTransaction(s.deps.db, 2);
        expect((await s.enroll()).status).toBe(503);
        const before = { ...s.placements[0] };
        const other = Buffer.alloc(32, 6).toString('base64url');
        expect(await s.enroll(hostBody({ nonce: other }))).toEqual({ status: 403, body: { error: 'enroll_nonce_invalid' } });
        expect(w.created).toHaveLength(1);
        expect(s.placements[0]).toEqual(before);
    });

    // Lead review of 1b0b070: recovery is bound to the consumed NONCE, not just the (replayable)
    // identity document. The proof is checked before ANY Worker call, create or replay.
    it('C-6: pending + valid identity document + WRONG nonce never reaches the Worker (neither create nor replay)', async () => {
        const s = setup([booting({ enroll_nonce_hash: null, enroll_consumed_hash: nonceHashOf(NONCE), instance_id: DOC.instanceId, last_error: placement.ENROLLMENT_PENDING })]);
        const calls: TunnelRequest[] = [];
        s.deps.tunnels = { createTunnel: async (_o, req) => (calls.push(req), { ok: true, tunnelToken: TOKEN }), deleteTunnel: async () => ({ ok: true }) };
        const other = Buffer.alloc(32, 6).toString('base64url');
        expect(await s.enroll(hostBody({ nonce: other }))).toEqual({ status: 403, body: { error: 'enroll_nonce_invalid' } });
        expect(calls).toEqual([]);
        expect(s.described).toEqual([]); // refused before the describe too
    });

    it('C-6: a pending recovery after the window (enroll_expires_at) is refused before any Worker call', async () => {
        const s = setup([booting({
            enroll_nonce_hash: null, enroll_consumed_hash: nonceHashOf(NONCE), instance_id: DOC.instanceId, last_error: placement.ENROLLMENT_PENDING,
            enroll_expires_at: new Date(NOW.getTime() - 1),
        })]);
        const calls: TunnelRequest[] = [];
        s.deps.tunnels = { createTunnel: async (_o, req) => (calls.push(req), { ok: true, tunnelToken: TOKEN }), deleteTunnel: async () => ({ ok: true }) };
        expect(await s.enroll()).toEqual({ status: 403, body: { error: 'enroll_nonce_expired' } });
        expect(calls).toEqual([]);
    });

    it('C-6: a pending row without the consumed proof (legacy/cleared) cannot be recovered', async () => {
        const s = setup([booting({ enroll_nonce_hash: null, enroll_consumed_hash: null, instance_id: DOC.instanceId, last_error: placement.ENROLLMENT_PENDING })]);
        const calls: TunnelRequest[] = [];
        s.deps.tunnels = { createTunnel: async (_o, req) => (calls.push(req), { ok: true, tunnelToken: TOKEN }), deleteTunnel: async () => ({ ok: true }) };
        expect(await s.enroll()).toEqual({ status: 409, body: { error: 'enroll_nonce_consumed' } });
        expect(calls).toEqual([]);
    });

    it('C-6: a SUCCEEDED replay with the wrong nonce is refused before any Worker call too', async () => {
        const s = setup([booting({ enroll_nonce_hash: null, enroll_consumed_hash: nonceHashOf(NONCE), instance_id: DOC.instanceId, last_error: placement.ENROLLMENT_SUCCEEDED })]);
        const calls: TunnelRequest[] = [];
        s.deps.tunnels = { createTunnel: async (_o, req) => (calls.push(req), { ok: true, tunnelToken: TOKEN }), deleteTunnel: async () => ({ ok: true }) };
        const other = Buffer.alloc(32, 6).toString('base64url');
        expect(await s.enroll(hostBody({ nonce: other }))).toEqual({ status: 403, body: { error: 'enroll_nonce_invalid' } });
        expect(calls).toEqual([]);
    });

    it('a failed finish clears the consumed proof (a failed enrollment is never recoverable)', async () => {
        const s = setup([booting()], { tunnel: async () => ({ ok: false, status: 403, code: 'tunnel_http_403' }) });
        expect((await s.enroll()).status).toBe(502);
        expect(s.placements[0]).toMatchObject({ enroll_consumed_hash: null, enroll_expires_at: null, last_error: placement.ENROLLMENT_FAILED });
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

    // Codex PR #200: the shell's status poll can apply the boot's receipt (STARTING → MOUNTING,
    // job cleared) while createTunnel is in flight. Completion must still succeed: the host
    // discards its nonce on any answer, so a 409 here would strand the boot.
    it('receipt progress (STARTING → MOUNTING) during createTunnel still completes: 200, then RUNNING', async () => {
        const JOB = 'ababab00-abab-4bab-8bab-abababababab';
        const DIGEST = 'd'.repeat(64);
        const deployment = fixtureDeployment('ap-south-1', TYPES);
        const s = setup([booting({ lifecycle_job_id: JOB, lifecycle_digest: DIGEST })]);
        const executions = {
            async describe(_region: string, arn: string) {
                expect(arn).toBe(lifecycleExecutionArn(deployment, JOB));
                return {
                    status: 'SUCCEEDED',
                    output: JSON.stringify({
                        schemaVersion: 1, jobId: JOB, digest: DIGEST, computerId: C1, generation: 2, leaseEpoch: 3, fenceToken: FENCE,
                        instanceId: DOC.instanceId, volumeId: 'vol-11111111111111111', state: 'running',
                    }),
                };
            },
        };
        const poll = async () => {
            const { record } = await readPlacement(s.db, C1);
            await applyLifecycleReceipt({ db: s.db, executions }, record!, deployment);
        };
        s.deps.tunnels = {
            createTunnel: async () => {
                await poll();
                expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', lifecycle_job_id: null, last_error: placement.ENROLLMENT_PENDING });
                return { ok: true, tunnelToken: TOKEN };
            },
            deleteTunnel: async () => ({ ok: true }),
        };
        const r = await s.enroll();
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ tunnelToken: TOKEN, controlKey: KEY.toString('base64') });
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: placement.ENROLLMENT_SUCCEEDED, enroll_nonce_hash: null });
        await poll();
        expect(s.placements[0]).toMatchObject({ state: 'RUNNING', last_error: placement.ENROLLMENT_SUCCEEDED });
    });
});

describe('a Cloudflare API refusal is diagnosable from both logs (production: a Worker token without "Cloudflare Tunnel: Edit")', () => {
    it('the Worker logs leg + code, the app carries the code server-side and logs it once per minute; nothing secret is logged', async () => {
        const CF_TOKEN = 'SECRET-CF-API-TOKEN-0123456789abcdef';
        const output = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
        resetEnrollRefusalLogForTests();
        // The REAL Cloudflare REST client: lookups answer, the tunnel POST is refused with a body naming the token.
        const cloudflare = createCloudflareTunnelApi({
            accountId: 'acct', zoneId: 'zone', apiToken: CF_TOKEN,
            fetch: async (url, init) => (init?.method === 'POST' && url.endsWith('/cfd_tunnel')
                ? new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `Authentication error ${CF_TOKEN}` }] }), { status: 403 })
                : new Response(JSON.stringify({ success: true, result: [] }), { status: 200 })),
        });
        const w = workerBackedTunnels(undefined, cloudflare);
        const s = setup([booting()], { tunnels: w.client });
        const refused = { status: 503, body: { error: 'tunnel_unavailable', retryable: true },
            tunnel: { code: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' } };
        // The first attempt, then the host's retry (pending: replay → tunnel_absent → create again).
        for (let i = 0; i < 2; i++) {
            const r = await s.enroll();
            expect(r).toEqual(refused);
            logEnrollRefusal(r, hostBody()); // what the route does with every non-200
        }
        const warn = vi.mocked(console.warn).mock.calls;
        const subject = { computerId: C1, generation: 2, leaseEpoch: 3 };
        expect(warn).toEqual([
            ['[aws-tunnels] create_failed', { leg: 'create', code: 'cf_api_403', ...subject }],
            ['[aws-enroll] refused', { status: 503, error: 'tunnel_unavailable', retryable: true, ...subject,
                tunnel: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' }],
            ['[aws-tunnels] create_failed', { leg: 'create', code: 'cf_api_403', ...subject }],
        ]);
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_PENDING, enroll_consumed_hash: nonceHashOf(NONCE) });
        const logged = JSON.stringify(output.flatMap((o) => o.mock.calls));
        for (const secret of [NONCE, fx.pkcs7_rsa_detached.slice(0, 64), KEY.toString('base64'), CF_TOKEN, 'Authentication error',
            '13.0.0.5', '10.0.0.12', DOC.instanceId, 'origin.example.net', SID]) expect(logged).not.toContain(secret);
    });
});

describe('createWorkerTunnelClient (GW-1 over HTTPS)', () => {
    const SECRET = 's'.repeat(32);
    const req: TunnelRequest = {
        computerId: C1, sandboxId: SID, generation: 2, leaseEpoch: 3, instanceId: DOC.instanceId, region: 'ap-south-1', publicIp: '13.0.0.5', controlKey: KEY.toString('base64'),
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
            { ts: NOW.getTime(), sandboxId: req.sandboxId, computerId: C1, userId: U1, provider: 'aws-ec2', store: '', generation: 2, leaseEpoch: 3 },
            { method: 'POST', path: TUNNELS_PATH, body: JSON.stringify(req) },
        );
        expect((seen[0]!.init.headers as Record<string, string>)['x-ezil-auth']).toBe(want);
    });

    it.each([
        ['a 409', new Response('{}', { status: 409 }), { ok: false, status: 409, code: 'tunnel_http_409' }],
        ['a Worker 502 naming the Cloudflare leg', new Response(JSON.stringify({ ok: false, error: 'tunnel_create_failed', detail: 'cf_api_403' }), { status: 502 }),
            { ok: false, status: 502, code: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' }],
        ['an edge HTML 502', new Response('<html>Bad gateway</html>', { status: 502 }), { ok: false, status: 502, code: 'tunnel_http_502' }],
        ['free-form Worker fields (dropped, never logged)', new Response(JSON.stringify({ error: 'Bad Thing', detail: 'x'.repeat(65) }), { status: 503 }),
            { ok: false, status: 503, code: 'tunnel_http_503' }],
        ['a short token', new Response(JSON.stringify({ tunnelToken: 'x' }), { status: 200 }), { ok: false, status: 502, code: 'tunnel_response_malformed' }],
        ['not JSON', new Response('nope', { status: 200 }), { ok: false, status: 502, code: 'tunnel_response_malformed' }],
    ])('%s is a failure', async (_n, response, want) => {
        const client = createWorkerTunnelClient({ workerUrl: 'https://w.example.test', secret: SECRET, fetch: (async () => response) as unknown as typeof fetch });
        expect(await client.createTunnel({ userId: U1 }, req)).toEqual(want);
    });

    // Codex 4275269636: the Worker compares claims.ts with Date.now() (ms). A seconds stamp is
    // ~55 years "old" and every tunnel call was refused hmac_token_expired.
    it.each(['POST', 'DELETE'] as const)('%s: the Worker\'s own verifier accepts the envelope at the same instant', async (method) => {
        const seen: RequestInit[] = [];
        const client = createWorkerTunnelClient({
            workerUrl: 'https://w.example.test', secret: SECRET, now: () => NOW,
            fetch: (async (_u: string, init: RequestInit) => (seen.push(init), new Response(JSON.stringify({ tunnelToken: TOKEN, deleted: true }), { status: 200 }))) as typeof fetch,
        });
        if (method === 'POST') await client.createTunnel({ userId: U1 }, req);
        else await client.deleteTunnel({ userId: U1 }, { computerId: C1, sandboxId: req.sandboxId, generation: 2, leaseEpoch: 3 });
        const headers = seen[0]!.headers as Record<string, string>;
        const verdict = await verifyPreviewTokenV2(headers['x-ezil-auth'], SECRET, { method, path: TUNNELS_PATH, body: String(seen[0]!.body) }, NOW.getTime());
        expect(verdict).toMatchObject({ ok: true, claims: { provider: 'aws-ec2', sandboxId: req.sandboxId, computerId: C1, userId: U1, generation: 2, leaseEpoch: 3 } });
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

describe('an ambiguous Worker answer to the tunnel create keeps the enrollment recoverable (Codex 4277613521)', () => {
    const ambiguous: [string, TunnelClient['createTunnel'], string][] = [
        ['a thrown call (transport, timeout)', async () => { throw new Error('ETIMEDOUT'); }, 'tunnel_transport'],
        ['status 0 (no answer)', async () => ({ ok: false, status: 0, code: 'tunnel_transport' }), 'tunnel_transport'],
        ['429 (throttled)', async () => ({ ok: false, status: 429, code: 'tunnel_http_429' }), 'tunnel_http_429'],
        ['500', async () => ({ ok: false, status: 500, code: 'tunnel_http_500' }), 'tunnel_http_500'],
        ['502 (the Worker\'s own Cloudflare call failed, or an unreadable 200)', async () => ({ ok: false, status: 502, code: 'tunnel_response_malformed' }), 'tunnel_response_malformed'],
        ['503', async () => ({ ok: false, status: 503, code: 'tunnel_http_503' }), 'tunnel_http_503'],
    ];
    it.each(ambiguous)('%s: retryable 503, no finish, still ENROLLMENT_PENDING with the consumed proof', async (_label, tunnel, code) => {
        const { enroll, placements } = setup([booting()], { tunnel });
        expect(await enroll()).toEqual({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, tunnel: { code } });
        expect(placements[0]).toMatchObject({
            state: 'STARTING', last_error: placement.ENROLLMENT_PENDING, enroll_nonce_hash: null,
            enroll_consumed_hash: nonceHashOf(NONCE), instance_id: DOC.instanceId,
        });
    });

    it.each([400, 401, 403, 409])('an answered %i is a definite refusal: 502, UNCONFIRMED, proof cleared', async (status) => {
        const { enroll, placements } = setup([booting()], { tunnel: async () => ({ ok: false, status, code: `tunnel_http_${status}` }) });
        expect(await enroll()).toEqual({ status: 502, body: { error: 'tunnel_unavailable' }, tunnel: { code: `tunnel_http_${status}` } });
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: placement.ENROLLMENT_FAILED, enroll_consumed_hash: null });
    });

    it('the Worker COMMITTED but its answer was lost: the host retry gets that exact tunnel; no second tunnel', async () => {
        const w = workerBackedTunnels();
        let lost = false;
        const tokens: string[] = [];
        const lossy: TunnelClient = {
            createTunnel: async (owner, request) => {
                const t = await w.client.createTunnel(owner, request);
                if (t.ok) tokens.push(t.tunnelToken);
                if (!request.replay && !lost) { lost = true; return { ok: false, status: 0, code: 'tunnel_transport' }; }
                return t;
            },
            deleteTunnel: w.client.deleteTunnel,
        };
        const s = setup([booting()], { tunnels: lossy });
        expect(await s.enroll()).toEqual({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, tunnel: { code: 'tunnel_transport' } });
        expect(w.created).toHaveLength(1);
        const retry = await s.enroll();
        expect(retry.status).toBe(200);
        expect((retry.body as { tunnelToken: string }).tunnelToken).toBe(tokens[0]);
        expect(w.created).toHaveLength(1);
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_SUCCEEDED });
    });

    it('the Worker never got the request: the host retry creates the tunnel once', async () => {
        const w = workerBackedTunnels();
        let first = true;
        const flaky: TunnelClient = {
            createTunnel: async (owner, request) => {
                if (first) { first = false; return { ok: false, status: 0, code: 'tunnel_transport' }; }
                return w.client.createTunnel(owner, request);
            },
            deleteTunnel: w.client.deleteTunnel,
        };
        const s = setup([booting()], { tunnels: flaky });
        expect((await s.enroll()).status).toBe(503);
        expect(w.created).toHaveLength(0);
        expect((await s.enroll()).status).toBe(200);
        expect(w.created).toHaveLength(1);
        expect(s.placements[0]).toMatchObject({ last_error: placement.ENROLLMENT_SUCCEEDED });
    });
});

describe('authenticated lower-image observations', () => {
    const digest = 'sha256:' + 'a'.repeat(64);
    it('backfills an ordinary host in the nonce transaction and rejects a different replay digest', async () => {
        const s = setup();
        expect((await s.enroll(hostBody({ lowerImageDigest: digest }))).status).toBe(200);
        expect(s.placements[0]).toMatchObject({ lower_image_digest: digest, enroll_nonce_hash: null });
        // The production driver binds ISO text; compare the instant, not the JS representation.
        expect(new Date(s.placements[0]!.lower_digest_observed_at as string | Date).getTime()).toBe(NOW.getTime());
        expect((await s.enroll(hostBody({ lowerImageDigest: digest }))).status).toBe(200);
        expect((await s.enroll(hostBody({ lowerImageDigest: 'sha256:' + 'b'.repeat(64) }))).body).toMatchObject({ error: 'host_digest_mismatch' });
        expect(s.placements[0]!.lower_image_digest).toBe(digest);
    });
    it('rolls back nonce consumption if digest evidence cannot be persisted', async () => {
        const s = setup();
        const db = s.deps.db;
        s.deps.db = { ...db, transaction: fn => db.transaction(tx => fn({ execute: async query => {
            const { PgDialect } = await import('drizzle-orm/pg-core');
            if (new PgDialect().sqlToQuery(query).sql.includes('placement:enroll-digest')) throw new Error('write failed');
            return tx.execute(query);
        } })) };
        await expect(s.enroll(hostBody({ lowerImageDigest: digest }))).rejects.toThrow('write failed');
        expect(s.placements[0]!.enroll_nonce_hash).toBe(nonceHashOf(NONCE)); expect(s.tunnels).toHaveLength(0);
    });
    it('does not observe a lower when the live data volume tags differ', async () => {
        const view = liveView(); view.volumes = view.volumes.map(v => ({ ...v, tags: { ...v.tags, 'ezil:fence-token': C1 } }));
        const s = setup([booting()], { view });
        expect((await s.enroll(hostBody({ lowerImageDigest: digest }))).body).toMatchObject({ error: 'enroll_volume_mismatch' });
        expect(s.placements[0]!.enroll_nonce_hash).toBe(nonceHashOf(NONCE)); expect(s.tunnels).toHaveLength(0);
    });
});

it('a pool claim uses canonical instance tags and waits for session-ready after enrollment', async () => {
    const view = liveView({ tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot',
        'ezil:namespace': 'pilot', 'ezil:pool-host': '11111111-1111-4111-8111-111111111111',
        'ezil:computer': C1, 'ezil:generation': '2', 'ezil:fence': FENCE } });
    const s = setup([booting()], { view });
    const result = await s.enroll();
    expect(result.status).toBe(200);
    expect(result.poolRelay).toEqual({ computerId: C1, ownerUserId: U1, generation: 2, leaseEpoch: 3,
        instanceId: DOC.instanceId, fenceToken: FENCE });
    expect(result.body).not.toHaveProperty('poolRelay');
    expect(s.placements[0]!.last_error).toBe('pool_session_pending');
    expect((await s.enroll()).poolRelay).toEqual(result.poolRelay);
    expect(s.placements[0]!.last_error).toBe('pool_session_pending');
    view.tags = { ...view.tags, 'ezil:computer': 'wrong' };
    const refused = await s.enroll();
    expect(refused.status).toBe(403); expect(refused.poolRelay).toBeUndefined();
});

it('ordinary enrollment and an uncommitted pool tunnel never trigger relay preparation', async () => {
    expect((await setup().enroll()).poolRelay).toBeUndefined();
    const view = liveView({ tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot',
        'ezil:namespace': 'pilot', 'ezil:pool-host': '11111111-1111-4111-8111-111111111111',
        'ezil:computer': C1, 'ezil:generation': '2', 'ezil:fence': FENCE } });
    const s = setup([booting()], { view, tunnel: async () => ({ ok: false, status: 503, code: 'tunnel_transport' }) });
    const result = await s.enroll(); expect(result.status).toBe(503); expect(result.poolRelay).toBeUndefined();
});
