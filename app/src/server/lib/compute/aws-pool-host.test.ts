import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePoolHost } from './aws-pool-host';
import { handlePoolClaim } from './aws-pool-claim';
import { buildLifecycleWork } from './aws-intent';
import { poolFixture, NOW, OTHER } from './aws-pool-test-support';

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
/** D4: every readiness line is ONE single-line JSON string tagged pool-host-readiness. */
function lines(spy: unknown): Record<string, unknown>[] {
    return vi.mocked(spy as typeof console.info).mock.calls.map(([line, ...rest]) => {
        expect(rest).toEqual([]); expect(typeof line).toBe('string'); expect(line).not.toContain('\n');
        return JSON.parse(line as string) as Record<string, unknown>;
    });
}

describe('pool host authentication and transactional enrollment', () => {
    it.each(['m6i.large','m6i.xlarge','m6i.2xlarge'])('authenticates configured %s through enroll and ready', async instanceType => {
        const f=poolFixture(); f.doc.instanceType=instanceType; f.view.instanceType=instanceType; f.row.instanceType=instanceType;
        f.deployment.instanceTypes=[instanceType];
        f.deps.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS=JSON.stringify({[f.deployment.region]:f.deployment});
        expect((await handlePoolHost(f.request('enroll'),f.deps,'enroll')).status).toBe(200);
        f.row.state='ready';
        expect((await handlePoolHost(f.request('ready'),f.deps,'ready')).status).toBe(200);
    });
    it.each(['enroll', 'ready'] as const)('logs %s readiness only after the transaction commits', async action => {
        const f = poolFixture();
        if (action === 'ready') f.row.state = 'ready';
        f.deps.db.transaction = async run => {
            const row = await run({ execute: vi.fn() });
            expect(console.info).not.toHaveBeenCalled();
            return row;
        };
        expect((await handlePoolHost(f.request(action), f.deps, action)).status).toBe(200);
        expect(lines(console.info)).toEqual([{ event: 'pool-host-readiness',
            result: action === 'enroll' ? 'enrolled' : 'ready', poolHostId: f.row.poolHostId, poolGeneration: 1,
            instanceId: f.row.instanceId, state: f.row.state, enrolledAt: f.row.enrolledAt!.toISOString(),
            readyAt: NOW.toISOString(), observedAt: NOW.toISOString(), ...(action === 'ready' ? { reportedHealth: { editorOk: true } } : {}),
        }]);
    });
    it('logs the authenticated host and reported component health when readiness is rejected', async () => {
        const f = poolFixture(); const health = { ok: false, desktop: true, editor: false };
        expect((await handlePoolHost(f.request('ready', { health }), f.deps, 'ready')).status).toBe(403);
        expect(lines(console.warn)).toEqual([{ event: 'pool-host-readiness',
            result: 'ready_rejected', poolHostId: f.row.poolHostId, poolGeneration: 1,
            instanceId: f.row.instanceId, reportedHealth: health, reason: 'ready_health',
        }]);
        expect(console.info).not.toHaveBeenCalled();
    });
    it('does not log success on commit failure or expose raw database errors', async () => {
        const f = poolFixture();
        f.deps.db.transaction = async run => { await run({ execute: vi.fn() }); throw new Error('private database failure'); };
        expect((await handlePoolHost(f.request('enroll'), f.deps, 'enroll')).status).toBe(503);
        expect(console.info).not.toHaveBeenCalled();
        expect(lines(console.warn)).toEqual([expect.objectContaining({ event: 'pool-host-readiness', result: 'enroll_rejected', reason: 'pool_unavailable' })]);
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private database failure');
    });
    it('D4: a heartbeat enroll of an already-ready spare is silent', async () => {
        const f = poolFixture(); f.row.state = 'ready';
        expect((await handlePoolHost(f.request('enroll'), f.deps, 'enroll')).status).toBe(200);
        expect(f.deps.data.recordPoolEnrollment).toHaveBeenCalledOnce();
        expect(console.info).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled();
    });
    it('D4: a heartbeat ready of a host whose readyAt predates this report is silent', async () => {
        const f = poolFixture(); f.row.state = 'ready'; f.row.readyAt = new Date(NOW.getTime() - 5 * 60_000);
        expect((await handlePoolHost(f.request('ready'), f.deps, 'ready')).status).toBe(200);
        expect(f.deps.data.recordPoolReady).toHaveBeenCalledOnce();
        expect(console.info).not.toHaveBeenCalled(); expect(console.warn).not.toHaveBeenCalled();
    });
    it('D4: the first ready (readyAt set by this report) is logged once even when the row was already enrolled', async () => {
        const f = poolFixture(); f.row.state = 'ready'; f.row.readyAt = NOW;
        expect((await handlePoolHost(f.request('ready'), f.deps, 'ready')).status).toBe(200);
        expect(lines(console.info)).toEqual([expect.objectContaining({ event: 'pool-host-readiness', result: 'ready', readyAt: NOW.toISOString() })]);
    });
    it.each(['enroll', 'ready'] as const)('%s records the authenticated host via P8', async action => {
        const f = poolFixture();
        const res = await handlePoolHost(f.request(action), f.deps, action);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(f.deps.data[action === 'enroll' ? 'recordPoolEnrollment' : 'recordPoolReady']).toHaveBeenCalledOnce();
    });
    const bad: [string, (f: ReturnType<typeof poolFixture>) => void, number][] = [
        ['flag', f => { f.deps.env.EZIL_AWS_COMPUTERS_ENABLED = '0'; }, 503],
        ['describer', f => { f.deps.describer = null; }, 503],
        ['certificate', f => { f.deps.env.EZIL_AWS_IDENTITY_CERTS = '{}'; }, 503],
        ['deployment', f => { f.deps.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = '{}'; }, 503],
        ['signature', f => { f.deps.verify = () => ({ ok: false, reason: 'bad' }); }, 403],
        ['account', f => { f.doc.accountId = '999999999999'; }, 403],
        ['consistently disallowed pool class', f => {
            f.doc.instanceType = 'c6i.xlarge'; f.view.instanceType = 'c6i.xlarge'; f.row.instanceType = 'c6i.xlarge';
            f.deployment.instanceTypes=['c6i.xlarge'];
            f.deps.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [f.deployment.region]: f.deployment });
        }, 403],
        ['document type', f => { f.doc.instanceType = 'm6i.2xlarge'; }, 403],
        ['instance', f => { f.view.instanceId = 'i-22222222222222222'; }, 403],
        ['stopped', f => { f.view.state = 'stopped'; }, 403],
        ['zone name', f => { f.view.availabilityZone = 'ap-south-1b'; }, 403],
        ['zone ID', f => { f.view.availabilityZoneId = 'aps1-az2'; }, 403],
        ['live type', f => { f.view.instanceType = 'm6i.xlarge'; }, 403],
        ['namespace', f => { f.view.tags['ezil:namespace'] = 'other'; }, 403],
        ['stage', f => { f.view.tags['ezil:stage'] = 'other'; }, 403],
        ['managed-by', f => { delete f.view.tags['ezil:managed-by']; }, 403],
        ['pool host tag', f => { f.view.tags['ezil:pool-host'] = OTHER; }, 403],
        ['pool tag', f => { delete f.view.tags['ezil:pool']; }, 403],
        ['claimed tag', f => { f.view.tags['ezil:computer'] = OTHER; }, 403],
        ['legacy claimed tag', f => { f.view.tags['ezil:computer-id'] = OTHER; }, 403],
        ['extra disk', f => { f.view.volumes.push({ volumeId: 'vol-33333333333333333', deleteOnTermination: false, tags: {} }); }, 403],
        ['retained root', f => { f.view.volumes[0]!.deleteOnTermination = false; }, 403],
        ['row host', f => { f.row.poolHostId = OTHER; }, 403],
        ['row instance', f => { f.row.instanceId = 'i-22222222222222222'; }, 403],
        ['row generation', f => { f.row.poolGeneration = 2; }, 403],
        ['row region', f => { f.row.region = 'us-east-1'; }, 403],
        ['row zone', f => { f.row.zoneId = 'aps1-az2'; }, 403],
        ['row type', f => { f.row.instanceType = 'm6i.xlarge'; }, 403],
        ['leased', f => { f.row.state = 'leased'; }, 403],
        ['row computer', f => { f.row.leasedComputerId = OTHER; }, 403],
    ];
    it.each(bad)('refuses %s without a committed write', async (_name, mutate, status) => {
        const f = poolFixture(); mutate(f);
        let committed = false;
        f.deps.db.transaction = async run => { const result = await run({ execute: vi.fn() }); committed = true; return result; };
        expect((await handlePoolHost(f.request('enroll'), f.deps, 'enroll')).status).toBe(status);
        expect(committed).toBe(false);
    });
    it('uses the real PKCS7 verifier by default', async () => {
        const f = poolFixture(); delete f.deps.verify;
        expect((await handlePoolHost(f.request('enroll'), f.deps, 'enroll')).status).toBe(403);
    });
    it.each([null, new Date(NOW.getTime() - 600_000), new Date(NOW.getTime() + 1)])('refuses readiness with stale/future/missing enrollment %s', async at => {
        const f = poolFixture(); f.row.enrolledAt = at;
        expect((await handlePoolHost(f.request('ready'), f.deps, 'ready')).status).toBe(403);
    });
    it.each([{ editorOk: false }, { ok: true, desktop: false, editor: true }, { ok: true, desktop: true, editor: false }])('requires full readiness %s', async health => {
        const f = poolFixture();
        expect((await handlePoolHost(f.request('ready', { health }), f.deps, 'ready')).status).toBe(403);
        expect(f.deps.data.recordPoolReady).not.toHaveBeenCalled();
    });
    it('accepts the existing host agent health shape', async () => {
        const f = poolFixture();
        expect((await handlePoolHost(f.request('ready', { health: { ok: true, desktop: true, editor: true } }), f.deps, 'ready')).status).toBe(200);
    });
    it('binds readiness body to header identity', async () => {
        const f = poolFixture();
        expect((await handlePoolHost(f.request('ready', { poolHostId: OTHER }), f.deps, 'ready')).status).toBe(403);
    });
    it.each([{ poolGeneration: 0 }, { extra: true }, { identityDocument: 'x'.repeat(8193) }, { signature: '' }])('rejects malformed enrollment %s', async body => {
        const f = poolFixture();
        expect((await handlePoolHost(f.request('enroll', body), f.deps, 'enroll')).status).toBe(400);
    });
    it('rejects malformed JSON', async () => {
        const f = poolFixture();
        expect((await handlePoolHost(new Request('https://test', { method: 'POST', body: '{' }), f.deps, 'enroll')).status).toBe(400);
    });
});

describe('claim publication, adopt completion and one-time enrollment', () => {
    it('returns only the P6 payload; stores a hash with existing 10-minute freshness', async () => {
        const f = poolFixture(true);
        const response = await handlePoolClaim(f.request('claim'), f.deps);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(Object.keys(body)).toEqual(['computerId', 'generation', 'leaseEpoch', 'fence', 'volumeSerial', 'enrollNonce']);
        expect(body.enrollNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const nonce = vi.mocked(f.deps.saveNonce).mock.calls[0]![2];
        expect(nonce.expiresAt.getTime()).toBe(NOW.getTime() + 600_000);
        expect(nonce.nonceHash).not.toContain(body.enrollNonce);
        f.p.enrollNonceHash = nonce.nonceHash; f.p.enrollExpiresAt = nonce.expiresAt;
        const again = await handlePoolClaim(f.request('claim'), f.deps);
        expect(await again.json()).toEqual(body);
        expect(f.deps.saveNonce).toHaveBeenCalledOnce();
    });
    const bad: [string, (f: ReturnType<typeof poolFixture>) => void, number][] = [
        ['unpublished', f => { f.deps.data.readPoolClaim = async () => null; }, 204],
        ['unleased', f => { f.row.state = 'ready'; }, 204],
        ['foreign host', f => { f.row.instanceId = 'i-22222222222222222'; }, 403],
        ['foreign placement', f => { f.p.instanceId = 'i-22222222222222222'; }, 403],
        ['missing placement', f => { f.deps.lockPlacement = async () => null; }, 403],
        ['foreign computer', f => { f.p.computerId = OTHER; }, 403],
        ['wrong provider', f => { f.p.provider = 'cloudflare'; }, 403],
        ['wrong region', f => { f.p.region = 'us-east-1'; }, 403],
        ['published epoch mismatch', f => { f.row.claimLeaseEpoch!++; }, 403],
        ['published serial mismatch', f => { f.row.claimVolumeSerial = 'vol33333333333333333'; }, 403],
        ['stale generation', f => { f.p.generation++; }, 403],
        ['stale epoch', f => { f.p.leaseEpoch++; }, 403],
        ['wrong fence', f => { f.p.fenceToken = OTHER; }, 403],
        ['wrong volume', f => { f.p.volumeId = 'vol-33333333333333333'; }, 403],
        ['stopped placement', f => { f.p.state = 'STOPPED'; }, 204],
        ['unremoved pool tag', f => { f.view.tags['ezil:pool'] = '1'; }, 204],
        ['foreign computer tag', f => { f.view.tags['ezil:computer'] = OTHER; }, 204],
        ['foreign fence tag', f => { f.view.tags['ezil:fence'] = OTHER; }, 204],
        ['no attached volume', f => { f.view.volumes.pop(); }, 204],
        ['deletable volume', f => { f.view.volumes[1]!.deleteOnTermination = true; }, 204],
        ['missing job', f => { f.p.lifecycleJobId = null; }, 204],
        ['missing execution reader', f => { f.deps.executions = null; }, 204],
        ['running execution', f => { f.execution.status = 'RUNNING'; }, 204],
        ['failed execution', f => { f.execution.status = 'FAILED'; }, 204],
        ['other execution', f => { f.execution.executionArn += 'x'; }, 403],
        ['other version', f => { f.execution.stateMachineVersionArn += '2'; }, 403],
        ['envelope digest mismatch', f => {
            f.execution.input = JSON.stringify({ ...JSON.parse(f.execution.input), digest: 'f'.repeat(64) });
        }, 403],
        ['wrong digest', f => { f.p.lifecycleDigest = 'f'.repeat(64); }, 403],
        ['wrong adopt host', f => {
            const w = buildLifecycleWork({ ...f.work.intent, poolHostId: OTHER });
            f.execution.input = w.input; f.p.lifecycleDigest = w.digest;
            f.execution.output = JSON.stringify({ ...f.receipt, digest: w.digest });
        }, 403],
        ['wrong receipt', f => { f.execution.output = JSON.stringify({ ...f.receipt, instanceId: 'i-22222222222222222' }); }, 403],
        ['consumed nonce', f => { f.p.enrollConsumedHash = 'f'.repeat(64); }, 204],
        ['nonce secret short', f => { f.deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET = 'short'; }, 503],
        ['nonce secret unset', f => { delete f.deps.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET; }, 503],
        ['another nonce', f => { f.p.enrollNonceHash = 'f'.repeat(64); f.p.enrollExpiresAt = new Date(NOW.getTime() + 1000); }, 403],
        ['nonce CAS lost', f => { f.deps.saveNonce = vi.fn(async () => false); }, 204],
    ];
    it.each(bad)('does not disclose a claim: %s', async (_name, mutate, status) => {
        const f = poolFixture(true); mutate(f);
        const res = await handlePoolClaim(f.request('claim'), f.deps);
        expect(res.status).toBe(status);
        expect(await res.text()).not.toContain('enrollNonce');
    });
    it('does not refresh an expired nonce', async () => {
        const f = poolFixture(true); await handlePoolClaim(f.request('claim'), f.deps);
        f.p.enrollNonceHash = vi.mocked(f.deps.saveNonce).mock.calls[0]![2].nonceHash;
        f.p.enrollExpiresAt = NOW;
        expect((await handlePoolClaim(f.request('claim'), f.deps)).status).toBe(204);
        expect(f.deps.saveNonce).toHaveBeenCalledOnce();
    });
    it('returns 204 while the enrolled spare waits for publication', async () => {
        const f = poolFixture(); f.deps.data.readPoolClaim = vi.fn(async () => null);
        expect((await handlePoolClaim(f.request('claim'), f.deps)).status).toBe(204);
        expect(f.deps.data.readPoolClaim).toHaveBeenCalledWith(expect.anything(), f.row.poolHostId, f.row.instanceId);
        expect(f.deps.executions!.describe).not.toHaveBeenCalled();
    });
});
