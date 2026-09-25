import { createHash, randomUUID } from 'node:crypto';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { token } from '../lib/lifecycle/contract.js';
import type { ComputerRecoveryIntent, FencedWriters } from '../lib/lifecycle/computer-recovery.js';

export function computerRecoveryFixture() {
    const f = lifecycleFixture('replace');
    const i: ComputerRecoveryIntent = { schemaVersion: 2, operation: 'recover', jobId: f.i.jobId, computerId: f.i.computerId,
        revision: 2, targetGeneration: 2, fenceToken: f.i.fenceToken, deployment: f.i.deployment,
        source: { schemaVersion: 1, jobId: randomUUID(), digest: 'a'.repeat(64) }, dataVolumeId: f.i.dataVolumeId!,
        dataScope: { generation: 1, fenceToken: f.i.previousFenceToken! } };
    const document = JSON.stringify(i), digest = createHash('sha256').update(document).digest('hex'), envelope = { schemaVersion: 2, document, digest };
    f.state.execution.input = JSON.stringify(envelope);
    const old = f.state.instances[0]!, volume = f.state.volumes[0]!;
    old.State = { Name: 'terminated' }; old.BlockDeviceMappings = [];
    volume.State = 'available'; volume.Attachments = [];
    const writers: FencedWriters = [{ instanceId: old.InstanceId!, ...i.dataScope,
        observedAt: new Date(f.state.now - 20000).toISOString(), fencedAt: new Date(f.state.now - 10000).toISOString() }];
    f.deps.recoveryAuthority = async (intent, sourceDigest) => {
        if (intent.jobId !== i.jobId || sourceDigest !== digest) throw new Error('authority_scope');
        f.state.authorityCalls++; return f.state.authorized ? { writers: structuredClone(writers) } : null;
    };
    const instance = () => { const v = f.instance('i-33333333333333333'); v.ClientToken = token(digest, 'instance', 2); return v; };
    return { ...f, i, document, digest, envelope, old, volume, writers, instance };
}
