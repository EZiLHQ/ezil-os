import { afterEach, expect, it } from 'vitest';
import { cancellationAwsFixture, cancellationCredentials } from '../../../tests/fixtures/cancellation-aws';
import { createAwsCancellationTransport } from './aws-cancellation-transport';
import { computerLifecycleAllocationToken } from './computer-lifecycle-work';

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
function fixture(operation?: Parameters<typeof cancellationAwsFixture>[0]) {
    const f = cancellationAwsFixture(operation); cleanup.push(f.destroy); return f;
}
type Fixture = ReturnType<typeof fixture>;
const denied = (f: Fixture) => expect(f.run()).rejects.toThrow(/^lifecycle_(conflict|unconfirmed|unavailable|invalid)$/);

it('signs and submits both immutable documents once under the deterministic cancellation name', async () => {
    const f = fixture(); f.state.exists = false;
    expect(await f.run()).toEqual({ state: 'pending' }); expect(await f.run()).toEqual({ state: 'pending' });
    const starts = f.calls.filter(c => c.action === 'StartExecution'); expect(starts).toHaveLength(1);
    expect(JSON.parse(starts[0]!.body)).toEqual({ stateMachineArn: f.c.workflowVersionArn, name: `cancel-computer-${f.c.cancellationId}`,
        input: JSON.stringify({ schemaVersion: 1, document: f.work.document, digest: f.work.digest,
            source: { schemaVersion: f.i.schemaVersion, document: f.source.document, digest: f.source.digest } }) });
    expect(f.calls.every(c => c.signed && c.host === 'states.us-east-1.amazonaws.com')).toBe(true);
});
it('observes an ambiguous start without renaming, redriving or retrying a billable request', async () => {
    const f = fixture(); f.state.exists = false; f.state.loseStart = true;
    expect(await f.run()).toEqual({ state: 'pending' });
    expect(f.calls.map(c => c.action)).toEqual(['DescribeExecution', 'DescribeStateMachine', 'StartExecution', 'DescribeExecution']);
    const g = fixture(); g.state.exists = false; g.state.failStart = true;
    await expect(g.run()).rejects.toThrow('lifecycle_unconfirmed');
    expect(g.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
});
it.each(['provision', 'start', 'replace', 'recover'] as const)('independently verifies cancellation of %s with only scoped EC2 reads', async operation => {
    const f = fixture(operation), result = await f.run();
    expect(result.state).toBe('observed');
    if (result.state === 'observed') { expect(result.receipt).toEqual(f.receipt); expect(result.observedAt).toBeInstanceOf(Date); }
    expect(f.state.sourceReads).toBe(2);
    for (const call of f.calls) {
        expect(call.signed).toBe(true);
        if (call.host === 'states.us-east-1.amazonaws.com') expect(['DescribeExecution', 'GetExecutionHistory']).toContain(call.action);
        else {
            expect(call.host).toBe('ec2.us-east-1.amazonaws.com');
            expect(['DescribeInstances', 'DescribeVolumes']).toContain(call.action);
            const form = new URLSearchParams(call.body);
            if (call.action === 'DescribeInstances' && operation !== 'start' && form.has('Filter.1.Name')) {
                expect(form.get('Filter.1.Name')).toBe('client-token');
                expect(form.get('Filter.1.Value.1')).toBe(computerLifecycleAllocationToken(f.source, 'instance'));
            } else if (call.action === 'DescribeVolumes' && operation === 'provision') {
                expect(form.get('Filter.1.Name')).toBe('tag:ezil:allocation');
                expect(form.get('Filter.1.Value.1')).toBe(computerLifecycleAllocationToken(f.source, 'volume'));
            } else expect(form.has(call.action === 'DescribeVolumes' ? 'VolumeId.1' : 'InstanceId.1')).toBe(true);
        }
    }
});
it.each(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT'])('accepts a terminal %s original only with explicit cancellation evidence', async status => {
    const f = fixture(); f.original.status = status; f.resetHistory(); expect((await f.run()).state).toBe('observed');
});
it.each(['RUNNING', 'PENDING_REDRIVE', 'UNKNOWN'])('rejects original execution state %s', async status => {
    const f = fixture(); f.original.status = status; await denied(f);
});
it('does not infer no effects from a missing original execution', async () => {
    const f = fixture(); f.state.sourceExists = false; await denied(f);
    expect(f.calls.some(c => c.host === 'ec2.us-east-1.amazonaws.com')).toBe(false);
});
it('waits for original terminal propagation without treating elapsed time as resource proof', async () => {
    const f = fixture(); f.original.stopDate = Date.now() / 1000 - 10; f.execution.stopDate = Date.now() / 1000 - 5;
    expect(await f.run()).toEqual({ state: 'pending' }); expect(f.calls.map(c => c.action)).toEqual(['DescribeExecution', 'DescribeExecution']);
});
it.each(['stateMachineArn', 'stateMachineVersionArn', 'stateMachineAliasArn', 'executionArn', 'name', 'input', 'redriveCount', 'startDate'])('rejects changed cancellation %s', async field => {
    const f = fixture(); f.execution[field] = field === 'redriveCount' ? 1 : field === 'startDate' ? 1 : 'forged'; await denied(f);
});
it.each(['stateMachineVersionArn', 'stateMachineAliasArn', 'name', 'input', 'redriveCount', 'startDate', 'stopDate'])('rejects changed original %s', async field => {
    const f = fixture(); f.original[field] = field === 'redriveCount' ? 1 : ['startDate', 'stopDate'].includes(field) ? 1 : 'forged'; await denied(f);
});
it.each(['FAILED', 'ABORTED', 'TIMED_OUT'])('cannot settle an unsuccessful cancellation %s', async status => {
    const f = fixture(); f.execution.status = status; await denied(f);
});
it('rejects expired missing work and Express workflows before starting', async () => {
    for (const change of [(f: Fixture) => { f.work.createdAt = new Date(Date.now() - 8 * 86400000); f.source.createdAt = new Date(0); },
        (f: Fixture) => { f.state.machineType = 'EXPRESS'; }]) {
        const f = fixture(); f.state.exists = false; change(f); await denied(f);
        expect(f.calls.some(c => c.action === 'StartExecution')).toBe(false);
    }
});
it('rejects tampered hashes, unapproved mappings and foreign scopes before any AWS request', async () => {
    const changes: ((f: Fixture) => void)[] = [f => { f.work.document += ' '; }, f => { f.source.document += ' '; },
        f => { f.options.deployments = []; }, f => { f.options.workflows = {}; }, f => { f.scope.source.digest = 'b'.repeat(64); },
        f => { f.scope.dataVolumeId = 'vol-22222222222222222'; }];
    for (const change of changes) { const f = fixture(); change(f); await denied(f); expect(f.calls).toHaveLength(0); }
});
it.each(['accessKeyId', 'secretAccessKey', 'sessionToken', 'expiration'])('rejects invalid temporary credential %s without fallback or a wire request', async field => {
    const f = fixture(), credentials = await cancellationCredentials();
    const t = createAwsCancellationTransport({ ...f.options, credentials: async () => ({ ...credentials,
        [field]: field === 'expiration' ? new Date(0) : '' }) }); cleanup.push(t.destroy);
    await expect(t.advance(f.work, f.source, f.scope, AbortSignal.timeout(1000))).rejects.toThrow('lifecycle_invalid');
    expect(f.calls).toHaveLength(0);
});
it('redacts malformed or foreign cancellation output', async () => {
    for (const output of ['private-invalid-json', 'x'.repeat(8193), JSON.stringify({ secret: 'private-provider-secret' })]) {
        const f = fixture(); f.state.output = output; await denied(f);
    }
    const f = fixture(); f.receipt.source.digest = 'b'.repeat(64); await denied(f);
});
it('refuses truncated, cyclic, discontinuous or mismatched original history', async () => {
    const changes: ((f: Fixture) => void)[] = [f => { f.history.pages = []; },
        f => { f.history.pages[0]!.nextToken = '0'; },
        f => { f.history.pages = Array.from({ length: 4 }, (_, n) => ({ events: [], nextToken: String(n + 1) })); },
        f => { f.history.pages[0] = { events: [{ type: 'ExecutionStarted', id: 1, timestamp: Date.now() / 1000 }] }; },
        f => { f.history.pages[0] = { events: [{ type: 'ExecutionStarted', id: 2, timestamp: Number(f.original.startDate) }] }; },
        f => f.resetHistory([]), f => f.resetHistory(['runInstances', 'createVolume'])];
    for (const change of changes) { const f = fixture(); change(f); await denied(f); }
});
it('reads all pages of a complete history', async () => {
    const f = fixture(), events = f.history.pages[0]!.events as unknown[];
    f.history.pages = [{ events: events.slice(0, 1), nextToken: '1' }, { events: events.slice(1) }];
    expect((await f.run()).state).toBe('observed');
    expect(f.calls.filter(c => c.action === 'GetExecutionHistory').map(c => JSON.parse(c.body).nextToken)).toEqual([undefined, '1']);
});
it.each(['gap', 'redrive', 'timestamp', 'nameless task'])('rejects complete-looking history with %s even when execution metadata is unchanged', async kind => {
    const f = fixture(), events = f.history.pages[0]!.events as Record<string, unknown>[];
    if (kind === 'gap') events[1]!.id = 100;
    else if (kind === 'timestamp') events[1]!.timestamp = Date.now() / 1000;
    else if (kind === 'nameless task') delete events[1]!.stateEnteredEventDetails;
    else {
        events.splice(1, 0, { type: 'ExecutionRedriven', timestamp: events[0]!.timestamp });
        events.forEach((event, index) => { event.id = index + 1; });
    }
    await denied(f);
});
it('requires each current writer to match the receipt generation and fence', async () => {
    for (const field of ['generation', 'fenceToken'] as const) {
        const f = fixture();
        if (field === 'generation') f.scope.writers[1]!.generation++;
        else f.scope.writers[1]!.fenceToken = '11111111-1111-4111-8111-111111111111';
        await denied(f);
    }
});
it('rejects omitted allocations, receipt disk substitution and still attached storage', async () => {
    const changes: ((f: Fixture) => void)[] = [f => { f.receipt.source.instances = []; }, f => { f.state.targetMissing = true; },
        f => { f.receipt.source.volumeId = 'vol-22222222222222222'; }, f => { f.volume.attachmentSet = [{ status: 'attached' }]; },
        f => { f.volume.status = 'in-use'; }, f => { f.state.hasVolume = false; }, f => { f.state.instanceNextToken = 'more'; },
        f => { f.state.volumeNextToken = 'more'; }];
    for (const change of changes) { const f = fixture(); change(f); await denied(f); }
});
it.each(['instanceState', 'tagSet', 'clientToken', 'placement'])('rejects changed target %s', async field => {
    const f = fixture(); f.target[field] = field === 'instanceState' ? { name: 'stopped' } : field === 'tagSet' ? [] : 'forged'; await denied(f);
});
it.each(['volumeId', 'tagSet', 'encrypted', 'kmsKeyId', 'size', 'volumeType', 'multiAttachEnabled', 'availabilityZone'])('rejects changed retained volume %s', async field => {
    const f = fixture(); f.volume[field] = field === 'encrypted' ? false : field === 'multiAttachEnabled' ? true : field === 'size' ? 49 : field === 'tagSet' ? [] : 'forged'; await denied(f);
});
it('checks allocation tags for a newly provisioned volume and the owning account', async () => {
    const f = fixture('provision'); f.volume.tagSet = (f.volume.tagSet as { key: string }[]).filter(t => t.key !== 'ezil:allocation'); await denied(f);
    const g = fixture(); g.state.owner = '999999999999'; await denied(g);
});
it('accepts absence only for previously fenced historical writers, never the live target', async () => {
    for (const error of [false, true]) {
        const f = fixture(); f.state.oldMissing = true; f.state.oldError = error; expect((await f.run()).state).toBe('observed');
    }
    const changes: ((f: Fixture) => void)[] = [f => { f.scope.writers[0]!.fencedAt = null; },
        f => { f.scope.writers[0]!.fencedAt = new Date().toISOString(); }, f => { f.scope.writers[0]!.observedState = 'running'; },
        f => { f.old.instanceState = { name: 'stopped' }; }, f => { f.old.tagSet = []; }, f => { f.state.targetMissing = true; }];
    for (const change of changes) { const f = fixture(); change(f); await denied(f); }
    const f = fixture('replace'); f.state.oldMissing = true; await denied(f);
});
it('allows a proven pre-allocation failure while still inventorying the allocation token', async () => {
    const f = fixture('provision'); f.original.status = 'ABORTED'; f.resetHistory([]);
    f.receipt.source.instances = []; f.receipt.source.volumeId = null; f.scope.writers = [];
    f.state.allocated = false; f.state.hasVolume = false;
    expect((await f.run()).state).toBe('observed');
    expect(f.calls.filter(c => c.action === 'DescribeInstances')).toHaveLength(1);
    const g = fixture('provision'); g.original.status = 'ABORTED'; g.resetHistory([]);
    g.receipt.source.instances = []; g.receipt.source.volumeId = null; g.scope.writers = [];
    await denied(g);
});
it('rechecks the original after resource observation and rejects a redrive race', async () => {
    const f = fixture(); f.state.before = action => { if (action === 'DescribeExecution' && f.state.sourceReads === 1) f.original.redriveCount = 1; };
    await denied(f); expect(f.state.sourceReads).toBe(2);
});
it('honors abort before signing and after a provider response', async () => {
    const f = fixture(), before = new AbortController(); before.abort(); await expect(f.run(before.signal)).rejects.toThrow('lifecycle_unconfirmed');
    expect(f.calls).toHaveLength(0);
    const g = fixture(), during = new AbortController();
    g.state.before = action => { if (action === 'DescribeVolumes') during.abort(); };
    await expect(g.run(during.signal)).rejects.toThrow(/^lifecycle_/);
    expect(g.calls.some(c => ['StartExecution', 'StopExecution', 'TerminateInstances'].includes(c.action))).toBe(false);
});
