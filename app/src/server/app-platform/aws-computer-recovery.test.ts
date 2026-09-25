import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { computerRecoveryFixture } from '../../../tests/fixtures/computer-recovery';
import { createAwsLifecycleTransport } from './aws-lifecycle-transport';
import { computerLifecycleAllocationToken } from './computer-lifecycle-work';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
const xml = (name: string, data: unknown): string => Array.isArray(data) ? `<${name}>${data.map(v => xml('item', v)).join('')}</${name}>`
    : data && typeof data === 'object' ? `<${name}>${Object.entries(data).map(([k,v]) => xml(k,v)).join('')}</${name}>`
    : `<${name}>${String(data).replaceAll('&','&amp;').replaceAll('<','&lt;')}</${name}>`;
function fixture() {
    const f = computerRecoveryFixture(), i = f.intent, d = i.deployment;
    const machine = d.stateMachineVersionArn.slice(0, -2), name = `computer-${i.jobId}`;
    const arn = machine.replace(':stateMachine:', ':execution:') + ':' + name;
    const execution: Record<string, unknown> = { executionArn: arn, stateMachineArn: machine, stateMachineVersionArn: d.stateMachineVersionArn,
        name, redriveCount: 0, input: JSON.stringify({ schemaVersion: 2, document: f.work.document, digest: f.work.digest }),
        status: 'SUCCEEDED', output: JSON.stringify(f.receipt) };
    const cleanupVersion = 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-recovery-cleanup:1', cleanupName = `cleanup-${name}`;
    const cleanupMachine = cleanupVersion.slice(0, -2), cleanupArn = cleanupMachine.replace(':stateMachine:', ':execution:') + ':' + cleanupName;
    const cleanupReceipt = { schemaVersion: 2, sourceExecutionArn: arn, jobId: i.jobId, computerId: i.computerId, digest: f.work.digest,
        state: 'fenced', volumeId: i.dataVolumeId, instances: [{ instanceId: f.receipt.instanceId, generation: 2, fenceToken: i.fenceToken, state: 'terminated' }] };
    const tagSet = (generation: number, fence: string) => Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': String(generation), 'ezil:fence-token': fence }).map(([key,value])=>({key,value}));
    const target: Record<string, unknown> = { instanceId: f.receipt.instanceId, instanceState: { name: 'running' }, tagSet: tagSet(2, i.fenceToken),
        clientToken: computerLifecycleAllocationToken(f.work, 'instance'), placement: { availabilityZone: d.availabilityZone },
        architecture: 'x86_64', instanceType: 'm7i.large', imageId: d.amiId, subnetId: d.subnetId, rootDeviceType: 'ebs',
        groupSet: [{ groupId: d.securityGroupId }], iamInstanceProfile: { arn: d.instanceProfileArn },
        metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1, state: 'applied' },
        blockDeviceMapping: [{ deviceName: '/dev/sdf', ebs: { volumeId: i.dataVolumeId, status: 'attached', deleteOnTermination: false } }] };
    const old: Record<string, unknown> = { instanceId: f.writers[0]!.instanceId, instanceState: { name: 'terminated' },
        tagSet: tagSet(1, i.dataScope.fenceToken), placement: { availabilityZone: d.availabilityZone } };
    const volume: Record<string, unknown> = { volumeId: i.dataVolumeId, tagSet: tagSet(2, i.fenceToken), availabilityZone: d.availabilityZone,
        encrypted: true, kmsKeyId: d.dataKeyArn, size: 50, volumeType: 'gp3', multiAttachEnabled: false, status: 'in-use',
        attachmentSet: [{ instanceId: f.receipt.instanceId, volumeId: i.dataVolumeId, device: '/dev/sdf', status: 'attached', deleteOnTermination: false }] };
    const calls: { action: string; body: string }[] = [];
    let exists = true, historyNames = ['runInstances'], oldMissing = false, targetMissing = false, oldError = false;
    const json = (data: unknown, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Readable.from([JSON.stringify(data)]) } });
    const transport = createAwsLifecycleTransport({ credentials: async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'test-only',
        sessionToken: 'test-only', expiration: new Date(Date.now() + 3600000) }), recoveryDeployments: { [d.stateMachineVersionArn]: cleanupVersion },
        requestHandler: { async handle(request: { body?: string | Uint8Array; headers: Record<string, string> }) {
            const body = typeof request.body === 'string' ? request.body : Buffer.from(request.body ?? []).toString();
            const form = new URLSearchParams(body), action = request.headers['x-amz-target']?.split('.').at(-1) ?? form.get('Action')!;
            calls.push({ action, body });
            if (action === 'DescribeExecution') {
                if (JSON.parse(body).executionArn === cleanupArn) return json({ executionArn: cleanupArn, stateMachineArn: cleanupMachine,
                    stateMachineVersionArn: cleanupVersion, name: cleanupName, status: 'SUCCEEDED', redriveCount: 0,
                    input: JSON.stringify({ sourceExecutionArn: arn }), output: JSON.stringify(cleanupReceipt) });
                return exists ? json(execution) : json({ __type: 'ExecutionDoesNotExist' }, 400);
            }
            if (action === 'DescribeStateMachine') return json({ stateMachineArn: d.stateMachineVersionArn, status: 'ACTIVE', type: 'STANDARD' });
            if (action === 'StartExecution') { exists = true; execution.status = 'RUNNING'; return json({ executionArn: arn }); }
            if (action === 'GetExecutionHistory') return json({ events: [{ type: 'ExecutionStarted' },
                ...historyNames.map(name => ({ type: 'TaskStateEntered', stateEnteredEventDetails: { name } })), { type: 'ExecutionFailed' }]
                .map((event, index) => ({ ...event, id: index + 1, timestamp: Date.now()/1000 })) });
            let payload: unknown;
            if (action === 'DescribeInstances') {
                const isOld = form.get('InstanceId.1') === f.writers[0]?.instanceId;
                if (isOld && oldError) return { response: { statusCode: 400, headers: { 'content-type': 'text/xml' },
                    body: Readable.from(['<Response><Errors><Error><Code>InvalidInstanceID.NotFound</Code><Message>gone</Message></Error></Errors></Response>']) } };
                payload = { reservationSet: [{ ownerId: d.accountId, instancesSet: isOld ? (oldMissing ? [] : [old]) : (targetMissing ? [] : [target]) }] };
            } else if (action === 'DescribeVolumes') payload = { volumeSet: [volume] };
            else throw new Error('unexpected SDK operation');
            return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' }, body: Readable.from([xml(action + 'Response', payload)]) } };
        } } });
    cleanup.push(transport.destroy);
    return { ...f, target, old, volume, calls, execution, cleanupReceipt,
        run: (allow = true, context = { fencedWriters: f.writers }) => transport.advance(f.work, allow, AbortSignal.timeout(5000), context),
        missingExecution: () => { exists = false; }, oldGone: (error = false) => { oldMissing = true; oldError = error; }, newGone: () => { targetMissing = true; },
        failed: (allocated = true) => { execution.status = 'FAILED'; target.instanceState = { name: 'terminated' }; volume.status = 'available'; volume.attachmentSet = [];
            if (!allocated) { historyNames = []; cleanupReceipt.instances = []; volume.tagSet = tagSet(1, i.dataScope.fenceToken); } },
        unsafeHistory: () => { historyNames.push('createVolume'); } };
}
it('submits immutable v2 bytes once with a deterministic execution name', async () => {
    const f = fixture(); f.missingExecution(); expect(await f.run()).toEqual({ state: 'pending' });
    expect(await f.run()).toEqual({ state: 'pending' });
    const starts = f.calls.filter(c => c.action === 'StartExecution'); expect(starts).toHaveLength(1);
    expect(JSON.parse(JSON.parse(starts[0]!.body).input)).toEqual({ schemaVersion: 2, document: f.work.document, digest: f.work.digest });
});
it('observes the preserved disk, target token and every historical writer through real SDK serialization', async () => {
    const f = fixture(); const result = await f.run(false); expect(result.state).toBe('observed');
    if (result.state === 'observed') expect(result.receipt).toEqual(f.receipt);
    expect(f.calls.map(c => c.action)).toEqual(['DescribeExecution', 'DescribeInstances', 'DescribeVolumes', 'DescribeInstances']);
});
it('allows expired EC2 history only for previously fenced historical IDs', async () => {
    for (const error of [false, true]) { const f = fixture(); f.oldGone(error); expect((await f.run()).state).toBe('observed'); }
    const f = fixture(); f.newGone(); await expect(f.run()).rejects.toThrow('lifecycle_conflict');
});
it('rejects stopped historical writers, changed tags, tokens, profiles and deletable or foreign disks', async () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [f => { f.old.instanceState = { name: 'stopped' }; },
        f => { f.old.tagSet = []; }, f => { f.target.clientToken = 'forged'; }, f => { f.target.iamInstanceProfile = { arn: 'forged' }; },
        f => { f.volume.volumeId = 'vol-22222222222222222'; }, f => { f.volume.attachmentSet = []; }];
    for (const change of changes) {
        const f = fixture(); change(f); await expect(f.run()).rejects.toThrow(/lifecycle_(conflict|unconfirmed)/);
    }
});
it('does not accept a fresh generation as historical evidence or start after revocation', async () => {
    const f = fixture(); f.writers[0]!.generation = 2; await expect(f.run()).rejects.toThrow('lifecycle_conflict'); expect(f.calls).toHaveLength(0);
    const g = fixture(); g.missingExecution(); expect(await g.run(false)).toEqual({ state: 'pending' });
    expect(g.calls.map(c => c.action)).toEqual(['DescribeExecution']);
});
it('consumes cleanup only after terminated target and detached retained-disk evidence', async () => {
    for (const allocated of [false, true]) { const f = fixture(); f.failed(allocated); expect((await f.run(false)).state).toBe('fenced'); }
    const f = fixture(); f.failed(); f.target.instanceState = { name: 'stopped' }; await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
});
it('rejects an omitted possible allocation, a fabricated disk and a recovery that created another volume', async () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [f => { f.cleanupReceipt.instances = []; },
        f => { f.cleanupReceipt.volumeId = 'vol-22222222222222222'; }, f => f.unsafeHistory()];
    for (const change of changes) {
        const f = fixture(); f.failed(); change(f); await expect(f.run(false)).rejects.toThrow(/lifecycle_(conflict|unconfirmed)/);
    }
});
