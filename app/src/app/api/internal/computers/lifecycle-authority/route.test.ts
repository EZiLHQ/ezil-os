import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakePlacementDb, placementRow, type Row } from '@/server/lib/compute/fake-placement-db.test-support';
import { PLACEMENT_STATES } from '@/server/lib/compute/placement';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/server/db', () => ({ db: { execute } }));
const route = await import('./route');
const { POST } = route;

const AUTHORITY_PATH = '/api/internal/computers/lifecycle-authority';
// Same test-only key and algorithm as infra/app-computers/test/lifecycle-aws.test.ts.
// Fix its randomized IDs and clock so the vector is reproducible.
const KEY = 'ab'.repeat(32);
const TIMESTAMP = '1791979200';
const authority = {
    schemaVersion: 1,
    computerId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
    jobId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
    leaseEpoch: 3,
    digest: 'cd'.repeat(32),
};
// authorityFor is flat; infra canonical sorts its keys alphabetically.
const BODY = JSON.stringify(Object.fromEntries(Object.entries(authority).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const VECTOR_SIGNATURE = 'baef59825acdf55b2ca8fc9431cfd9318a48127e2e31ce007c6f0eac2c33228e';

function sign(body: string, timestamp = TIMESTAMP, key = KEY, signedPath = AUTHORITY_PATH, method = 'POST') {
    return createHmac('sha256', Buffer.from(key, 'hex')).update([
        'ezil-lifecycle-authority-v1', method, signedPath, timestamp,
        createHash('sha256').update(body).digest('hex'),
    ].join('\n')).digest('hex');
}

function request(body = BODY, timestamp = TIMESTAMP, signature = sign(body, timestamp)) {
    return new Request(`https://app.example.test${AUTHORITY_PATH}`, {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature },
    });
}

function row(overrides: Row = {}) {
    return placementRow({
        computer_id: authority.computerId, lease_epoch: authority.leaseEpoch, state: 'STARTING',
        lifecycle_job_id: authority.jobId, lifecycle_digest: authority.digest, ...overrides,
    });
}

function seed(rows = [row()]) {
    const fake = createFakePlacementDb({ placements: rows });
    execute.mockImplementation(fake.db.execute);
    return fake;
}

async function refused(req = request(), status = 403) {
    const response = await POST(req);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(status === 403 ? { authorized: false } : { error: 'authority_unavailable' });
    expect(response.headers.get('cache-control')).toBe('no-store');
}

beforeEach(() => {
    vi.stubEnv('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', KEY);
    vi.spyOn(Date, 'now').mockReturnValue(Number(TIMESTAMP) * 1000);
    execute.mockReset();
    seed();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('lifecycle authority wire contract', () => {
    it('authorizes the infra signer vector with the exact response its client accepts', async () => {
        const infra = path.resolve(__dirname, '../../../../../../../infra/app-computers');
        const contract = readFileSync(path.join(infra, 'lib/lifecycle/contract.ts'), 'utf8');
        expect(contract).toContain(`AUTHORITY_PATH='${AUTHORITY_PATH}'`);
        const source = readFileSync(path.join(infra, 'lib/lifecycle/aws.ts'), 'utf8');
        // Execute ONLY the real signer's crypto expression: no SDK, credentials,
        // secret provider or fetch. This catches drift in the other lane too.
        const expression = source.match(/const signature=(createHmac[\s\S]*?\.digest\('hex'\));/)?.[1];
        expect(expression).toBeDefined();
        const signature = runInNewContext(expression!, {
            createHmac, createHash, Buffer, authoritySecret: { key: KEY }, body: BODY, timestamp: TIMESTAMP, AUTHORITY_PATH,
        }) as string;
        expect(signature).toBe(VECTOR_SIGNATURE);
        expect(sign(BODY)).toBe(VECTOR_SIGNATURE);
        const response = await POST(request(BODY, TIMESTAMP, signature));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ authorized: true, ...authority });
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(execute).toHaveBeenCalledTimes(2);
    });

    it('exports only POST and the Node.js/dynamic route configuration', () => {
        expect(Object.keys(route).sort()).toEqual(['POST', 'dynamic', 'runtime']);
        expect(route.runtime).toBe('nodejs');
        expect(route.dynamic).toBe('force-dynamic');
    });

    it.each([-300, 0, 300])('accepts timestamp skew %i seconds', async (skew) => {
        const response = await POST(request(BODY, String(Number(TIMESTAMP) + skew)));
        expect(response.status).toBe(200);
    });

    it('hashes received bytes without requiring canonical JSON', async () => {
        expect((await POST(request(JSON.stringify(authority, null, 2)))).status).toBe(200);
    });
});

describe('authentication fails closed before reading placement', () => {
    it('refuses a bad signature', async () => {
        await refused(request(BODY, TIMESTAMP, '00'.repeat(32)));
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses a different signing key', async () => {
        await refused(request(BODY, TIMESTAMP, sign(BODY, TIMESTAMP, 'ef'.repeat(32))));
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses body tampering even when the parsed authority is unchanged', async () => {
        await refused(request(`${BODY}\n`, TIMESTAMP, sign(BODY)));
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ['GET', AUTHORITY_PATH], ['POST', '/api/compute/aws/lifecycle-authority'],
    ])('refuses a signature for %s %s', async (method, signedPath) => {
        await refused(request(BODY, TIMESTAMP, sign(BODY, TIMESTAMP, KEY, signedPath, method)));
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([-301, 301])('refuses signed timestamp skew %i seconds', async (skew) => {
        await refused(request(BODY, String(Number(TIMESTAMP) + skew)));
        expect(execute).not.toHaveBeenCalled();
    });

    it.each(['', '1791979200000', '1791979200.0', '+1791979200', '01791979200', '1.7919792e9', 'NaN', 'Infinity', '9007199254740992', '1791979200,1791979200'])('refuses timestamp format %j', async (timestamp) => {
        await refused(request(BODY, timestamp));
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ['empty', ''], ['short', 'ab'], ['non-hex', 'gg'.repeat(32)], ['uppercase', VECTOR_SIGNATURE.toUpperCase()],
        ['prefixed', `sha256=${VECTOR_SIGNATURE}`], ['duplicate', `${VECTOR_SIGNATURE},${VECTOR_SIGNATURE}`],
    ])('refuses %s signature format', async (_name, signature) => {
        await refused(request(BODY, TIMESTAMP, signature));
        expect(execute).not.toHaveBeenCalled();
    });

    it.each(['x-ezil-workflow-timestamp', 'x-ezil-workflow-signature', 'content-type'])('refuses missing %s', async (header) => {
        const req = request();
        req.headers.delete(header);
        await refused(req);
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        ['missing', undefined], ['empty', ''], ['short', 'ab'], ['non-hex', 'gg'.repeat(32)],
        ['uppercase', KEY.toUpperCase()], ['padded', ` ${KEY}`],
    ])('fails closed for %s secret', async (_name, secret) => {
        vi.stubEnv('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', secret);
        // An empty-key signature must never turn a missing secret into authority.
        await refused(request(BODY, TIMESTAMP, sign(BODY, TIMESTAMP, secret ?? '')), 503);
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses an unreadable request body', async () => {
        const req = request();
        Object.defineProperty(req, 'body', { value: new ReadableStream({ start(controller) { controller.error(new Error('read failed')); } }) });
        await refused(req);
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('strict authority schema', () => {
    it.each([
        ['extra keys', { ...authority, authorized: true }],
        ['missing key', { ...authority, jobId: undefined }],
        ['wrong version', { ...authority, schemaVersion: 2 }],
        ['invalid computer ID', { ...authority, computerId: 'invalid' }],
        ['invalid job ID', { ...authority, jobId: 'invalid' }],
        ['uppercase ID', { ...authority, computerId: authority.computerId.toUpperCase() }],
        ['invalid digest', { ...authority, digest: 'bad' }],
        ['uppercase digest', { ...authority, digest: authority.digest.toUpperCase() }],
        ['epoch zero', { ...authority, leaseEpoch: 0 }],
        ['negative epoch', { ...authority, leaseEpoch: -1 }],
        ['fractional epoch', { ...authority, leaseEpoch: 3.5 }],
        ['oversized epoch', { ...authority, leaseEpoch: 2147483648 }],
        ['string epoch', { ...authority, leaseEpoch: '3' }],
        ['array', [authority]], ['null', null],
    ])('refuses signed %s', async (_name, body) => {
        await refused(request(JSON.stringify(body)));
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses signed malformed JSON', async () => {
        await refused(request('{'));
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('placement is the authority', () => {
    it.each(['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING'])('authorizes the current job in %s', async (state) => {
        seed([row({ state })]);
        expect((await POST(request())).status).toBe(200);
    });

    const inactive = PLACEMENT_STATES.filter((state) => !['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING'].includes(state));
    it.each(inactive)('refuses %s even with matching job/digest/epoch', async (state) => {
        seed([row({ state })]);
        await refused();
    });

    it.each([
        ['job ID', { lifecycle_job_id: '11111111-1111-4111-8111-111111111111' }],
        ['digest', { lifecycle_digest: 'ef'.repeat(32) }],
        ['lease epoch', { lease_epoch: authority.leaseEpoch + 1 }],
        ['cleared job', { lifecycle_job_id: null }],
        ['cleared digest', { lifecycle_digest: null }],
        ['provider', { provider: 'cloudflare', workspace_store: 'r2' }],
    ])('refuses mismatched %s', async (_name, overrides) => {
        seed([row(overrides)]);
        await refused();
        // A Cloudflare row also gets the read-only active-migration lookup; never a write.
        expect(execute).toHaveBeenCalledTimes('provider' in overrides ? 3 : 2);
    });

    it('refuses another computer', async () => {
        await refused(request(JSON.stringify({ ...authority, computerId: '11111111-1111-4111-8111-111111111111' })));
    });

    it('refuses a missing placement', async () => {
        seed([]);
        await refused();
    });

    it('refuses duplicate placements', async () => {
        seed([row(), row()]);
        await refused();
    });

    it.each([{ provider: 'unknown' }, { state: 'unknown' }, { lease_epoch: null }])('refuses an invalid placement: %j', async (overrides) => {
        seed([row(overrides)]);
        await refused();
    });

    it('returns uncertain on database failure', async () => {
        execute.mockRejectedValue(new Error('database unavailable'));
        await refused(request(), 503);
    });
});

it.each(['pool-provision', 'pool-retire'] as const)('authenticates and echoes the exact durable %s authority', async operation => {
    const { fixturePoolIntent } = await import('@/server/lib/compute/aws-intent.test-support');
    const { buildLifecycleWork } = await import('@/server/lib/compute/aws-intent');
    const w = buildLifecycleWork(fixturePoolIntent(operation)), i = w.intent;
    const host = { id: i.poolHostId, generation: i.poolGeneration, region: i.deployment.region,
        zone_id: i.deployment.zoneId, instance_type: i.instanceType, instance_id: i.providerInstanceId,
        leased_computer_id: null, state: operation === 'pool-provision' ? 'booting' : 'retiring',
        lifecycle_job_id: i.jobId, lifecycle_digest: w.digest, lifecycle_input: w.input };
    // Provision authority replays against the CURRENT validated deployment and requires eligible
    // subscriber demand (aws-pool-dispatch.ts provisionEligible); retire needs neither.
    const demand = (standard: number) => ({ opens: 0, standard, premium: 0, boot_minutes: null, spares: 0, vcpu: 0, idle_ready: [], booting: [] });
    let eligible = 1;
    const { PgDialect } = await import('drizzle-orm/pg-core');
    execute.mockImplementation(async (q: Parameters<InstanceType<typeof PgDialect>['sqlToQuery']>[0]) =>
        new PgDialect().sqlToQuery(q).sql.includes('FROM public.ezil_compute_pool_hosts WHERE id =') ? [host] : [demand(eligible)]);
    vi.stubEnv('EZIL_AWS_LIFECYCLE_DEPLOYMENTS', JSON.stringify({ [i.deployment.region]: i.deployment }));
    vi.stubEnv('AWS_REGIONS', i.deployment.region);
    vi.stubEnv(`EZIL_AWS_MAX_RUNNING_${i.deployment.region.toUpperCase().replace(/-/g, '_')}`, '5');
    vi.stubEnv('EZIL_AWS_KILL_SWITCH', '0');
    const a = { schemaVersion: 1, computerId: i.computerId, jobId: i.jobId, leaseEpoch: i.leaseEpoch, digest: w.digest,
        operation, poolHostId: i.poolHostId, poolGeneration: i.poolGeneration };
    const res = await POST(request(JSON.stringify(a)));
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ authorized: true, ...a });
    for (const patch of [{ poolGeneration: 2 }, { operation: undefined }, { poolHostId: undefined }, { imageJobId: i.jobId, imageJobPhase: 'launch' }])
        expect((await POST(request(JSON.stringify({ ...a, ...patch })))).status).toBe(403);    if (operation === 'pool-provision') {
        // No eligible active subscriber: the same exact durable provision is refused.
        eligible = 0;
        expect((await POST(request(JSON.stringify(a)))).status).toBe(403);
    }
    vi.unstubAllEnvs();
});
