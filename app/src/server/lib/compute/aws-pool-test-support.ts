import { vi } from 'vitest';
import type { PoolClaimDeps } from './aws-pool-claim';
import type { PoolHostRow, PoolData, PoolDemand } from './ready-pool';
import type { Placement } from './placement';
import { buildLifecycleWork } from './aws-intent';
import { fixtureIntent, fixtureDeployment } from './aws-intent.test-support';
import { lifecycleExecutionArn } from './aws-receipts';
export const NOW = new Date('2026-10-23T10:00:00Z');
export const HOST = '11111111-1111-4111-8111-111111111111';
export const INSTANCE = 'i-11111111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export function poolFixture(adopted = false) {
    const deployment = fixtureDeployment('ap-south-1');
    const work = buildLifecycleWork({ ...fixtureIntent('start'), operation: 'adopt', poolHostId: HOST });
    const i = work.intent;
    const row: PoolHostRow = { poolHostId: HOST, poolGeneration: 1, region: deployment.region, zoneId: deployment.zoneId,
        instanceType: 'm6i.large', instanceId: INSTANCE, state: adopted ? 'leased' : 'booting', readyAt: NOW,
        enrolledAt: new Date(NOW.getTime() - 1000), leasedComputerId: adopted ? i.computerId : null,
        leasedAt: adopted ? NOW : null, claimGeneration: i.targetGeneration, claimLeaseEpoch: i.leaseEpoch,
        claimFence: i.fenceToken, claimVolumeSerial: i.dataVolumeId!.replace('-', '') };
    const p: Placement = { computerId: i.computerId, ownerUserId: OTHER, provider: 'aws-ec2', store: 'ebs',
        generation: i.targetGeneration, leaseEpoch: i.leaseEpoch, state: 'MOUNTING', region: deployment.region, zoneId: deployment.zoneId,
        instanceId: INSTANCE, instanceType: 'm6i.large', volumeId: i.dataVolumeId, fsUuid: OTHER, tunnelId: null,
        enrollNonceHash: null, enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null,
        fenceToken: i.fenceToken, lifecycleJobId: i.jobId, lifecycleDigest: work.digest, lastError: null, updatedAt: NOW };
    const doc = { accountId: deployment.accountId, instanceId: INSTANCE, instanceType: 'm6i.large', region: deployment.region, availabilityZone: 'ap-south-1a' };
    const tags: Record<string, string> = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': deployment.namespace,
        'ezil:namespace': deployment.namespace, 'ezil:pool-host': HOST, ...(adopted ? { 'ezil:computer': p.computerId,
            'ezil:generation': String(p.generation), 'ezil:fence': p.fenceToken! } : { 'ezil:pool': '1' }) };
    const view = { instanceId: INSTANCE, state: 'running', instanceType: 'm6i.large', availabilityZone: doc.availabilityZone,
        availabilityZoneId: deployment.zoneId, publicIp: null, tags, volumes: [
            { volumeId: 'vol-22222222222222222', deleteOnTermination: true, tags: {} },
            ...(adopted ? [{ volumeId: p.volumeId!, deleteOnTermination: false, tags: {} }] : [])] };
    const receipt = { schemaVersion: 1, jobId: i.jobId, digest: work.digest, computerId: i.computerId, generation: i.targetGeneration,
        leaseEpoch: i.leaseEpoch, fenceToken: i.fenceToken, instanceId: INSTANCE, volumeId: p.volumeId, state: 'running' };
    const execution = { status: 'SUCCEEDED', input: work.input, output: JSON.stringify(receipt),
        executionArn: lifecycleExecutionArn(deployment, i.jobId), stateMachineVersionArn: work.stateMachineArn };
    const data: PoolData = { recordPoolEnrollment: vi.fn(async () => row), recordPoolReady: vi.fn(async () => row),
        readPoolClaim: vi.fn(async () => row), markPoolHost: vi.fn(async () => row),
        readPoolDemand: vi.fn(), readPoolReadinessDiagnostics: vi.fn(async () => []), planPool: vi.fn(), POOL_POLICY: {} };
    const deps: PoolClaimDeps = { data, db: { execute: vi.fn(), transaction: vi.fn(async run => run({ execute: vi.fn() })) },
        env: { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [deployment.region]: deployment }),
            EZIL_AWS_IDENTITY_CERTS: JSON.stringify({ [deployment.region]: '-----BEGIN CERTIFICATE-----public-test-only' }),
            CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 's'.repeat(40) }, now: () => NOW,
        describer: { describeForEnrollment: vi.fn(async () => view) }, verify: vi.fn(() => ({ ok: true as const })),
        executions: { describe: vi.fn(async () => execution) }, lockPlacement: vi.fn(async () => p), saveNonce: vi.fn(async () => true) };
    const request = (action: 'enroll' | 'ready' | 'claim', override: Record<string, unknown> = {}) => {
        const proof = { poolHostId: HOST, poolGeneration: 1, identityDocument: JSON.stringify(doc), signature: 's'.repeat(32) };
        return new Request(`https://test/api/compute/aws/pool/${action}`, { method: action === 'claim' ? 'GET' : 'POST',
            headers: { 'x-ezil-pool-host-id': HOST, 'x-ezil-pool-generation': '1',
                'x-ezil-identity-document': Buffer.from(proof.identityDocument).toString('base64'), 'x-ezil-identity-signature': proof.signature },
            ...(action === 'claim' ? {} : { body: JSON.stringify(action === 'enroll' ? { ...proof, ...override } : { poolHostId: HOST, health: { editorOk: true }, ...override }) }) });
    };
    return { deps, row, p, doc, view, receipt, execution, work, deployment, request };
}
export function demandFixture(): PoolDemand {
    return { opens15m: 4, activeStandard: 10, activePremium: 5, bootMinutes: null, spares: 1,
        vcpuInUse: 2, regionVcpuCap: 16, killSwitch: false, idleReady: [], booting: [] };
}
