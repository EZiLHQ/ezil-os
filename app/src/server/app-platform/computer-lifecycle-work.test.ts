import { expect, it } from 'vitest';
import { computerRecoveryFixture } from '../../../tests/fixtures/computer-recovery';
import { lifecycleFixture } from '../../../tests/fixtures/lifecycle';
import { lifecycleAllocationToken } from './lifecycle-recovery-protocol';
import { computerLifecycleAllocationToken, parseComputerLifecycleWork, validateComputerLifecycleReceipt, validateComputerLifecycleCleanup } from './computer-lifecycle-work';
import { lifecycleDeploymentApproved, type LifecycleApproval } from './lifecycle-approval';

it('keeps v1 documents, receipts and allocation tokens unchanged', () => {
    const f = lifecycleFixture(); expect(parseComputerLifecycleWork(f.work)).toEqual(f.intent);
    expect(validateComputerLifecycleReceipt(f.work, f.receipt)).toEqual(f.receipt);
    expect(computerLifecycleAllocationToken(f.work, 'instance')).toBe(lifecycleAllocationToken(f.work.digest, 'instance'));
});
it('binds v2 success to its exact disk, generation, source document hash and receipt version', () => {
    const f = computerRecoveryFixture(); expect(validateComputerLifecycleReceipt(f.work, f.receipt)).toEqual(f.receipt);
    for (const changed of [{ schemaVersion: 1 }, { volumeId: 'vol-22222222222222222' }, { generation: 1 }, { digest: 'b'.repeat(64) }]) {
        expect(() => validateComputerLifecycleReceipt(f.work, { ...f.receipt, ...changed })).toThrow('lifecycle_conflict');
    }
    expect(() => parseComputerLifecycleWork({ ...f.work, document: f.work.document + ' ' })).toThrow('lifecycle_invalid');
    expect(computerLifecycleAllocationToken(f.work, 'instance')).not.toBe(lifecycleAllocationToken(f.work.digest, 'instance'));
});
it('v2 cleanup must preserve its disk and cannot invent another historical writer', () => {
    const f = computerRecoveryFixture(), version = f.intent.deployment.stateMachineVersionArn;
    const r = { schemaVersion: 2, sourceExecutionArn: version.slice(0, -2).replace(':stateMachine:', ':execution:') + `:computer-${f.intent.jobId}`,
        jobId: f.intent.jobId, computerId: f.intent.computerId, digest: f.work.digest, state: 'fenced', volumeId: f.intent.dataVolumeId, instances: [] };
    expect(validateComputerLifecycleCleanup(f.work, r)).toEqual(r);
    for (const changed of [{ volumeId: null }, { schemaVersion: 1 }, { instances: [{ ...f.writers[0], state: 'terminated' }] }]) {
        expect(() => validateComputerLifecycleCleanup(f.work, { ...r, ...changed })).toThrow('lifecycle_conflict');
    }
});
it('shared approval derives the exact computer/generation profile without broadening other pins', () => {
    const f = computerRecoveryFixture(), { instanceProfileArn: _profile, ...shared } = f.intent.deployment;
    const approvals: LifecycleApproval[] = [{ profileMode: 'per-writer', deployment: shared }];
    expect(lifecycleDeploymentApproved(approvals, f.intent)).toBe(true);
    for (const changed of [{ instanceProfileArn: _profile.replace('/g2', '/g1') }, { namespace: 'other' }, { amiId: 'ami-22222222222222222' }]) {
        expect(lifecycleDeploymentApproved(approvals, { ...f.intent, deployment: { ...f.intent.deployment, ...changed } })).toBe(false);
    }
    const legacy = lifecycleFixture(); expect(lifecycleDeploymentApproved([legacy.intent.deployment], legacy.intent)).toBe(true);
});
