import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createAwsCancellationTransport, type AwsCancellationTransportOptions } from '../../src/server/app-platform/aws-cancellation-transport';
import { computerLifecycleAllocationToken } from '../../src/server/app-platform/computer-lifecycle-work';
import type { CancellationAuthorityScope, CancellationReceipt } from '../../src/server/app-platform/cancellation-authority-protocol';
import type { ComputerCancellationV1 } from '../../src/server/app-platform/computer-cancellation-protocol';
import { computerRecoveryFixture } from './computer-recovery';
import { lifecycleFixture } from './lifecycle';

const xml = (name: string, data: unknown): string => Array.isArray(data) ? `<${name}>${data.map(v => xml('item', v)).join('')}</${name}>`
    : data && typeof data === 'object' ? `<${name}>${Object.entries(data).map(([k, v]) => xml(k, v)).join('')}</${name}>`
    : `<${name}>${String(data).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</${name}>`;
const json = (data: unknown, statusCode = 200) => ({ response: { statusCode,
    headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Readable.from([JSON.stringify(data)]) } });
const xmlResponse = (action: string, data: unknown, statusCode = 200) => ({ response: { statusCode,
    headers: { 'content-type': 'text/xml' }, body: Readable.from([xml(action, data)]) } });
type Wire = { hostname: string; body?: string | Uint8Array; headers: Record<string, string> };
export const cancellationCredentials = async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'test-only',
    sessionToken: 'test-only', expiration: new Date(Date.now() + 3600000) });

/** Fake AWS wire responses, with the real SDK signer, serializers, deserializers
 * and paginator. This fixture never opens a network connection. */
export function cancellationAwsFixture(operation: 'provision' | 'start' | 'replace' | 'recover' = 'recover') {
    const f = operation === 'recover' ? computerRecoveryFixture() : lifecycleFixture(operation);
    const i = f.intent, d = i.deployment, now = Date.now(), source = { ...f.work, createdAt: new Date(now - 300000) };
    const c: ComputerCancellationV1 = { schemaVersion: 1, operation: 'cancel', cancellationId: randomUUID(), computerId: i.computerId,
        source: { schemaVersion: i.schemaVersion, jobId: i.jobId, digest: source.digest, stateAtRequest: 'running' },
        reason: 'stop_requested', requestedBy: randomUUID(), workflowVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancellation:1' };
    const document = JSON.stringify(c), work = { document, digest: createHash('sha256').update(document).digest('hex'), createdAt: new Date(now - 180000) };
    const machine = d.stateMachineVersionArn.slice(0, -2), sourceName = `computer-${i.jobId}`;
    const sourceArn = machine.replace(':stateMachine:', ':execution:') + ':' + sourceName;
    const cancellationMachine = c.workflowVersionArn.slice(0, -2), name = `cancel-computer-${c.cancellationId}`;
    const arn = cancellationMachine.replace(':stateMachine:', ':execution:') + ':' + name;
    const original: Record<string, unknown> = { executionArn: sourceArn, stateMachineArn: machine, stateMachineVersionArn: d.stateMachineVersionArn,
        name: sourceName, redriveCount: 0, input: JSON.stringify({ schemaVersion: i.schemaVersion, document: source.document, digest: source.digest }),
        status: 'SUCCEEDED', startDate: (now - 290000) / 1000, stopDate: (now - 120000) / 1000 };
    const execution: Record<string, unknown> = { executionArn: arn, stateMachineArn: cancellationMachine, stateMachineVersionArn: c.workflowVersionArn,
        name, redriveCount: 0, input: JSON.stringify({ schemaVersion: 1, document, digest: work.digest,
            source: { schemaVersion: i.schemaVersion, document: source.document, digest: source.digest } }),
        status: 'SUCCEEDED', startDate: (now - 170000) / 1000, stopDate: (now - 30000) / 1000 };
    const previous = i.schemaVersion === 2 ? i.dataScope : i.previousGeneration ? { generation: i.previousGeneration, fenceToken: i.previousFenceToken! } : null;
    const oldId = i.schemaVersion === 2 ? 'i-22222222222222222' : i.previousInstanceId;
    const receipt: CancellationReceipt = { schemaVersion: 1, computerId: i.computerId, cancellationId: c.cancellationId, digest: work.digest,
        source: { schemaVersion: i.schemaVersion, sourceExecutionArn: sourceArn, jobId: i.jobId, computerId: i.computerId,
            digest: source.digest, state: 'fenced', volumeId: f.receipt.volumeId,
            instances: [...(operation === 'replace' ? [{ instanceId: oldId!, ...previous!, state: 'terminated' as const }] : []),
                { instanceId: f.receipt.instanceId, generation: i.targetGeneration, fenceToken: i.fenceToken, state: 'terminated' }] } };
    const scope: CancellationAuthorityScope = { source: { schemaVersion: i.schemaVersion, jobId: i.jobId, digest: source.digest },
        dataVolumeId: i.dataVolumeId, writers: [
            ...(oldId ? [{ instanceId: oldId, ...previous!, observedState: 'stopped' as const,
                observedAt: new Date(now - 320000).toISOString(), fencedAt: new Date(now - 310000).toISOString() }] : []),
            { instanceId: f.receipt.instanceId, generation: i.targetGeneration, fenceToken: i.fenceToken,
                observedState: 'running', observedAt: new Date(now - 200000).toISOString(), fencedAt: null },
        ] };
    const tagSet = (generation: number, fence: string) => Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': String(generation), 'ezil:fence-token': fence }).map(([key, value]) => ({ key, value }));
    const target: Record<string, unknown> = { instanceId: f.receipt.instanceId, instanceState: { name: 'terminated' }, tagSet: tagSet(i.targetGeneration, i.fenceToken),
        clientToken: computerLifecycleAllocationToken(source, 'instance'), placement: { availabilityZone: d.availabilityZone } };
    const old: Record<string, unknown> = { instanceId: oldId, instanceState: { name: 'terminated' },
        tagSet: previous ? tagSet(previous.generation, previous.fenceToken) : [], placement: { availabilityZone: d.availabilityZone } };
    const volume: Record<string, unknown> = { volumeId: f.receipt.volumeId, tagSet: [...tagSet(i.targetGeneration, i.fenceToken),
        ...(operation === 'provision' ? [{ key: 'ezil:allocation', value: computerLifecycleAllocationToken(source, 'volume') }] : [])],
        availabilityZone: d.availabilityZone, encrypted: true, kmsKeyId: d.dataKeyArn, size: 50, volumeType: 'gp3',
        multiAttachEnabled: false, status: 'available', attachmentSet: [] };
    const state = { exists: true, sourceExists: true, loseStart: false, failStart: false, oldMissing: false, oldError: false,
        targetMissing: false, owner: d.accountId, instanceNextToken: '', volumeNextToken: '', sourceReads: 0,
        machineType: 'STANDARD', output: undefined as string | undefined,
        allocated: operation !== 'start', hasVolume: true,
        before: undefined as ((action: string, body: string) => void) | undefined };
    const history = { pages: [] as Record<string, unknown>[] };
    function resetHistory(names = operation === 'provision' ? ['createVolume', 'runInstances'] : operation === 'start' ? [] : ['runInstances']) {
        const endings: Record<string, string> = { SUCCEEDED: 'ExecutionSucceeded', FAILED: 'ExecutionFailed', ABORTED: 'ExecutionAborted', TIMED_OUT: 'ExecutionTimedOut' };
        history.pages = [{ events: [{ type: 'ExecutionStarted' }, ...names.map(n => ({ type: 'TaskStateEntered', stateEnteredEventDetails: { name: n } })),
            { type: endings[String(original.status)] }].map((event, index) => ({ ...event, id: index + 1, timestamp: (now - 125000) / 1000 })) }];
    }
    resetHistory();
    const calls: { host: string; action: string; body: string; signed: boolean }[] = [];
    const options: AwsCancellationTransportOptions = { credentials: cancellationCredentials, deployments: [d], workflows: { [d.stateMachineVersionArn]: c.workflowVersionArn },
        requestHandler: { async handle(request: Wire) {
            const body = typeof request.body === 'string' ? request.body : Buffer.from(request.body ?? []).toString();
            const form = new URLSearchParams(body), action = request.headers['x-amz-target']?.split('.').at(-1) ?? form.get('Action')!;
            calls.push({ host: request.hostname, action, body, signed: request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ') === true
                && request.headers['x-amz-security-token'] === 'test-only' });
            state.before?.(action, body);
            if (action === 'DescribeExecution') {
                if (JSON.parse(body).executionArn === arn) return state.exists ? json({ ...execution, output: state.output ?? JSON.stringify(receipt) }) : json({ __type: 'ExecutionDoesNotExist' }, 400);
                state.sourceReads++;
                return state.sourceExists ? json(original) : json({ __type: 'ExecutionDoesNotExist' }, 400);
            }
            if (action === 'DescribeStateMachine') return json({ stateMachineArn: c.workflowVersionArn, type: state.machineType, status: 'ACTIVE' });
            if (action === 'StartExecution') {
                if (state.failStart) throw new Error('private-provider-error');
                state.exists = true; execution.status = 'RUNNING';
                if (state.loseStart) throw new Error('private-lost-response');
                return json({ executionArn: arn });
            }
            if (action === 'GetExecutionHistory') return json(history.pages[Number(JSON.parse(body).nextToken ?? 0)] ?? {});
            if (action === 'DescribeInstances') {
                const isOld = oldId && form.get('InstanceId.1') === oldId;
                if (isOld && state.oldError) return xmlResponse('Response', { Errors: { Error: { Code: 'InvalidInstanceID.NotFound', Message: 'gone' } } }, 400);
                const instances = isOld ? (state.oldMissing ? [] : [old])
                    : state.targetMissing || (form.has('Filter.1.Name') && !state.allocated) ? [] : [target];
                return xmlResponse(action + 'Response', { reservationSet: [{ ownerId: state.owner, instancesSet: instances }], nextToken: state.instanceNextToken });
            }
            if (action === 'DescribeVolumes') return xmlResponse(action + 'Response', { volumeSet: state.hasVolume ? [volume] : [], nextToken: state.volumeNextToken });
            throw new Error('unexpected SDK operation');
        } } };
    const transport = createAwsCancellationTransport(options);
    return { i, c, work, source, scope, receipt, original, execution, target, old, volume, state, history, calls, options, resetHistory,
        run: (signal = AbortSignal.timeout(5000)) => transport.advance(work, source, scope, signal), destroy: transport.destroy };
}
