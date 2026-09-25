import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAwsLifecycleTransport } from './aws-lifecycle-transport';
import { parseLifecycleWork, type LifecycleIntent } from './lifecycle-protocol';
import { lifecycleFixture } from '../../../tests/fixtures/lifecycle';
import { lifecycleAllocationToken, type LifecycleRecoveryReceipt } from './lifecycle-recovery-protocol';

const credentials = async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'test-only', sessionToken: 'test-only', expiration: new Date(Date.now() + 3600000) });
type Wire = { hostname: string; body?: string | Uint8Array; headers: Record<string, string> };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
const xml = (name: string, data: unknown): string => Array.isArray(data) ? `<${name}>${data.map(v => xml('item', v)).join('')}</${name}>`
    : data && typeof data === 'object' ? `<${name}>${Object.entries(data).map(([k,v]) => xml(k,v)).join('')}</${name}>`
    : `<${name}>${String(data).replaceAll('&','&amp;').replaceAll('<','&lt;')}</${name}>`;
function fixture(operation: LifecycleIntent['operation'] = 'start', withRecovery = false) {
    const { intent: i, work, receipt } = lifecycleFixture(operation), d = i.deployment;
    const machineArn = d.stateMachineVersionArn.slice(0, d.stateMachineVersionArn.lastIndexOf(':'));
    const executionArn = machineArn.replace(':stateMachine:', ':execution:') + ':computer-' + i.jobId;
    const input = JSON.stringify({ schemaVersion: 1, document: work.document, digest: work.digest });
    const execution: Record<string, unknown> = { executionArn, stateMachineArn: machineArn,
        stateMachineVersionArn: d.stateMachineVersionArn, name: 'computer-' + i.jobId, input, redriveCount: 0,
        status: 'RUNNING', startDate: Date.now()/1000, output: JSON.stringify(receipt) };
    const recoveryVersionArn = 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle-recovery:1';
    const recoveryMachine = recoveryVersionArn.slice(0, -2), recoveryName = `cleanup-computer-${i.jobId}`;
    const recoveryArn = recoveryMachine.replace(':stateMachine:', ':execution:') + ':' + recoveryName;
    const recoveryReceipt: LifecycleRecoveryReceipt = { schemaVersion: 1, sourceExecutionArn: executionArn,
        jobId: i.jobId, digest: work.digest, computerId: i.computerId, state: 'fenced', volumeId: receipt.volumeId,
        instances: [...(i.previousInstanceId ? [{ instanceId: i.previousInstanceId, generation: i.previousGeneration!, fenceToken: i.previousFenceToken!, state: 'terminated' as const }] : []),
            { instanceId: receipt.instanceId, generation: i.targetGeneration, fenceToken: i.fenceToken, state: 'terminated' }] };
    const recoveryExecution: Record<string, unknown> = { executionArn: recoveryArn, stateMachineArn: recoveryMachine,
        stateMachineVersionArn: recoveryVersionArn, name: recoveryName, redriveCount: 0, status: 'SUCCEEDED',
        input: JSON.stringify({ sourceExecutionArn: executionArn }) };
    let historyNames = operation === 'provision' ? ['createVolume', 'runInstances'] : operation === 'replace' ? ['runInstances'] : [];
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': i.computerId,
        'ezil:generation': String(i.targetGeneration), 'ezil:fence-token': i.fenceToken };
    const tagSet = Object.entries(tags).map(([key,value]) => ({ key,value }));
    const target: Record<string, unknown> = { instanceId: receipt.instanceId, clientToken: lifecycleAllocationToken(work.digest, 'instance'),
        instanceState: { name: receipt.state === 'retired' ? 'terminated' : receipt.state }, tagSet,
        placement: { availabilityZone: d.availabilityZone }, architecture: 'x86_64', instanceType: 'm7i.large',
        imageId: d.amiId, subnetId: d.subnetId, rootDeviceType: 'ebs', groupSet: [{ groupId: d.securityGroupId }],
        iamInstanceProfile: { arn: d.instanceProfileArn }, metadataOptions: { httpTokens: 'required', httpPutResponseHopLimit: 1, state: 'applied' },
        blockDeviceMapping: [{ deviceName: '/dev/sdf', ebs: { volumeId: receipt.volumeId, status: 'attached', deleteOnTermination: false } }] };
    const old: Record<string, unknown> = { instanceId: i.previousInstanceId, instanceState: { name: 'terminated' }, placement: { availabilityZone: d.availabilityZone },
        tagSet: Object.entries({ ...tags, 'ezil:generation': String(i.previousGeneration), 'ezil:fence-token': i.previousFenceToken }).map(([key,value]) => ({key,value})) };
    const volume: Record<string, unknown> = { volumeId: receipt.volumeId, availabilityZone: d.availabilityZone, tagSet,
        encrypted: true, kmsKeyId: d.dataKeyArn, size: 50, volumeType: 'gp3', multiAttachEnabled: false,
        status: receipt.state === 'retired' ? 'available' : 'in-use', attachmentSet: receipt.state === 'retired' ? []
            : [{ volumeId: receipt.volumeId, instanceId: receipt.instanceId, device: '/dev/sdf', status: 'attached', deleteOnTermination: false }] };
    if (operation === 'provision') volume.tagSet = [...tagSet, { key: 'ezil:allocation', value: lifecycleAllocationToken(work.digest, 'volume') }];
    let exists = false, lostStart = false, failStart = false, machineType = 'STANDARD';
    const calls: { host: string; action: string; body: string }[] = [];
    const json = (data: unknown, statusCode = 200) => ({ response: { statusCode,
        headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Readable.from([JSON.stringify(data)]) } });
    const transport = createAwsLifecycleTransport({ credentials,
        recoveryDeployments: withRecovery ? { [d.stateMachineVersionArn]: recoveryVersionArn } : undefined,
        requestHandler: { async handle(request: Wire) {
        const body = typeof request.body === 'string' ? request.body : Buffer.from(request.body ?? []).toString();
        const action = request.headers['x-amz-target']?.split('.').at(-1) ?? new URLSearchParams(body).get('Action')!;
        calls.push({ host: request.hostname, action, body });
        if (action === 'DescribeExecution') {
            if (JSON.parse(body).executionArn === recoveryArn) return json({ ...recoveryExecution, output: JSON.stringify(recoveryReceipt) });
            return exists ? json(execution) : json({ __type: 'ExecutionDoesNotExist' }, 400);
        }
        if (action === 'GetExecutionHistory') return json({ events: [
            { type: 'ExecutionStarted' }, ...historyNames.map(name => ({ type: 'TaskStateEntered', stateEnteredEventDetails: { name } })),
            { type: 'ExecutionFailed' },
        ].map((event, index) => ({ ...event, id: index + 1, timestamp: Date.now()/1000 })) });
        if (action === 'DescribeStateMachine') return json({ stateMachineArn: d.stateMachineVersionArn, type: machineType, status: 'ACTIVE' });
        if (action === 'StartExecution') {
            if (failStart) throw new Error('sensitive-provider-response');
            exists = true; if (lostStart) { lostStart = false; throw new Error('sensitive-lost-response'); }
            return json({ executionArn, startDate: Date.now()/1000 });
        }
        let payload: unknown;
        if (action === 'DescribeInstances') payload = { reservationSet: [{ ownerId: d.accountId, instancesSet: [target,...(operation === 'replace' ? [old] : [])] }] };
        else if (action === 'DescribeVolumes') payload = { volumeSet: [volume] };
        else throw new Error('unexpected SDK call');
        return { response: { statusCode: 200, headers: { 'content-type': 'text/xml' },
            body: Readable.from([xml(action+'Response', payload)]) } };
    } } });
    cleanup.push(transport.destroy);
    return { work, i, receipt, calls, execution, target, volume, old, recoveryReceipt, recoveryExecution,
        noAllocation: () => { historyNames = []; recoveryReceipt.instances = []; recoveryReceipt.volumeId = null; },
        recovered: () => { exists = true; execution.status = 'FAILED'; target.instanceState = { name: 'terminated' }; volume.status = 'available'; volume.attachmentSet = []; },
        run: (allowStart = true) => transport.advance(work, allowStart, AbortSignal.timeout(5000)),
        existing: () => { exists = true; }, succeeded: () => { exists = true; execution.status = 'SUCCEEDED'; },
        loseStart: () => { lostStart = true; }, failStart: () => { failStart = true; }, express: () => { machineType = 'EXPRESS'; } };
}

describe('actual lifecycle SDK wire contract', () => {
    it('submits once and polls the exact pinned Standard execution without calling EC2 mutations', async () => {
        const f = fixture(); expect(await f.run()).toEqual({state:'pending'}); expect(await f.run()).toEqual({state:'pending'});
        expect(f.calls.map(c=>c.action)).toEqual(['DescribeExecution','DescribeStateMachine','StartExecution','DescribeExecution']);
        const sent = JSON.parse(f.calls.find(c=>c.action==='StartExecution')!.body);
        expect(sent.stateMachineArn).toBe(f.i.deployment.stateMachineVersionArn); expect(JSON.parse(sent.input).document).toBe(f.work.document);
    });
    it('observes a lost start response, and never changes execution name', async () => {
        const f=fixture(); f.loseStart(); expect(await f.run()).toEqual({state:'pending'});
        expect(f.calls.filter(c=>c.action==='StartExecution')).toHaveLength(1);
    });
    it('keeps an ambiguous missing start unconfirmed without leaking provider errors', async () => {
        const f=fixture(); f.failStart(); await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
        expect(f.calls.filter(c=>c.action==='StartExecution')).toHaveLength(1);
    });
    it('does not start after revocation, expiry or Express mismatch', async () => {
        const f=fixture(); expect(await f.run(false)).toEqual({state:'pending'}); expect(f.calls).toHaveLength(1);
        f.work.createdAt=new Date(0); await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
        const g=fixture(); g.express(); await expect(g.run()).rejects.toThrow('lifecycle_conflict');
        expect(g.calls.some(c=>c.action==='StartExecution')).toBe(false);
    });
    it.each(['stateMachineVersionArn','input','name','stateMachineAliasArn','redriveCount'])('rejects changed execution %s', async field => {
        const f=fixture(); f.existing(); f.execution[field]=field==='redriveCount'?1:'forged'; await expect(f.run()).rejects.toThrow('lifecycle_conflict');
    });
    it.each(['FAILED','ABORTED','TIMED_OUT'])('never treats %s as settled provider work', async status => {
        const f=fixture(); f.existing(); f.execution.status=status; await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
    });
    it.each(['start','stop','provision','replace','retire'] as const)('requires independent EC2 and EBS evidence for %s', async op => {
        const f=fixture(op); f.succeeded(); const result=await f.run(false);
        expect(result.state).toBe('observed'); if(result.state==='observed') expect(result.receipt).toEqual(f.receipt);
        expect(f.calls.map(c=>c.action)).toEqual(['DescribeExecution','DescribeInstances','DescribeVolumes']);
    });
    it('rejects the old stopped writer during replacement', async () => {
        const f=fixture('replace'); f.succeeded(); f.old.instanceState={name:'stopped'}; await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
    });
    it('rejects cross-computer tags, wrong disk encryption and a deletable data disk', async () => {
        const f=fixture(); f.succeeded(); f.target.tagSet=[]; await expect(f.run()).rejects.toThrow('lifecycle_conflict');
        const g=fixture(); g.succeeded(); g.volume.encrypted=false; await expect(g.run()).rejects.toThrow('lifecycle_conflict');
        const h=fixture(); h.succeeded(); h.target.blockDeviceMapping=[{deviceName:'/dev/sdf',ebs:{volumeId:h.receipt.volumeId,status:'attached',deleteOnTermination:true}}];
        await expect(h.run()).rejects.toThrow('lifecycle_unconfirmed');
    });
    it('rejects credential fallback and checks digest before making any signed request', async () => {
        const f=fixture(); f.work.document+=' '; expect(()=>parseLifecycleWork(f.work)).toThrow('lifecycle_invalid');
        await expect(f.run()).rejects.toThrow('lifecycle_invalid'); expect(f.calls).toHaveLength(0);
        const g=fixture(); const t=createAwsLifecycleTransport({credentials:async()=>({...await credentials(),sessionToken:''})}); cleanup.push(t.destroy);
        await expect(t.advance(g.work,true,AbortSignal.timeout(3000))).rejects.toThrow('lifecycle_invalid');
    });
});

describe('recovery receipts require independent provider evidence', () => {
    it.each(['start', 'stop', 'provision', 'replace', 'retire'] as const)('observes exact cleanup for %s without cloud mutations', async operation => {
        const f = fixture(operation, true); f.recovered(); const result = await f.run(false);
        expect(result.state).toBe('fenced'); if (result.state === 'fenced') expect(result.receipt).toEqual(f.recoveryReceipt);
        expect(f.calls.map(c => c.action)).toEqual(['DescribeExecution', 'DescribeExecution', 'GetExecutionHistory', 'DescribeInstances', 'DescribeVolumes']);
    });
    it('leaves an in-progress or failed recovery unsettled', async () => {
        const f = fixture('start', true); f.recovered(); f.recoveryExecution.status = 'RUNNING';
        expect(await f.run()).toEqual({ state: 'pending' });
        f.recoveryExecution.status = 'FAILED'; await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
        expect(f.calls.some(c => c.action === 'DescribeInstances')).toBe(false);
    });
    it('proves no allocation through complete history without account-wide resource reads', async () => {
        const f = fixture('provision', true); f.recovered(); f.noAllocation(); expect((await f.run()).state).toBe('fenced');
        expect(f.calls.map(c => c.action)).toEqual(['DescribeExecution', 'DescribeExecution', 'GetExecutionHistory']);
    });
    it('rejects omitted allocated resources and forged scope in a successful cleanup receipt', async () => {
        const f = fixture('provision', true); f.recovered(); f.recoveryReceipt.instances = [];
        await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed'); expect(f.calls.some(c => c.action === 'DescribeInstances')).toBe(false);
        const g = fixture('replace', true); g.recovered(); g.recoveryReceipt.instances.shift();
        await expect(g.run()).rejects.toThrow('lifecycle_conflict');
        const h = fixture('start', true); h.recovered(); h.recoveryReceipt.computerId = '11111111-1111-4111-8111-111111111111';
        await expect(h.run()).rejects.toThrow('lifecycle_conflict');
    });
    it.each(['stateMachineVersionArn', 'input', 'name', 'redriveCount'])('rejects changed cleanup execution %s', async field => {
        const f = fixture('start', true); f.recovered(); f.recoveryExecution[field] = field === 'redriveCount' ? 1 : 'forged';
        await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
    });
    it('rejects merely stopped writers, attached disks, foreign tags and the wrong allocation token', async () => {
        for (const kind of ['stopped', 'attached', 'foreign', 'token']) {
            const f = fixture('provision', true); f.recovered();
            if (kind === 'stopped') f.target.instanceState = { name: 'stopped' };
            if (kind === 'attached') f.volume.attachmentSet = [{ instanceId: f.receipt.instanceId }];
            if (kind === 'foreign') f.target.tagSet = [];
            if (kind === 'token') f.target.clientToken = 'another-allocation';
            await expect(f.run()).rejects.toThrow('lifecycle_unconfirmed');
        }
    });
});
