import assert from 'node:assert/strict';
import test from 'node:test';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { afterAction, type Action } from '../lib/lifecycle/contract.js';
import { MAX_THROTTLE_RETRIES, NO_ERROR, throttleDelaySeconds, toLambdaError } from '../lib/lifecycle/errors.js';
import { validateLifecycleReceipt } from '../lib/lifecycle/intent.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { runAsl, taskError } from './asl.js';

type Fixture = ReturnType<typeof lifecycleFixture>;
type View = Pick<Fixture['state'], 'instances' | 'volumes'>;
const view = (f: Fixture): View => structuredClone({ instances: f.state.instances, volumes: f.state.volumes });
const LAG = 20;

/** Mutations land immediately, but both Describe APIs can keep returning a
 * pre-action view. The real helper and shipped ASL must tolerate that view. */
async function run(f: Fixture, options: { after?: Action; before?: Action; observations?: number; lost?: boolean; throttle?: boolean;
    snapshot?: (live: View) => View } = {}) {
    f.state.now = f.state.execution.startDate.getTime();
    const graph = lifecycleDefinition('helper', f.settings.features), helper = createLifecycleHelper(f.settings, f.deps);
    const calls: { action: Action; parameters: any }[] = [], before = new Map<Action, View>();
    let stale: View | undefined, remaining = 0, observations = 0, throttled = false;
    const result = await runAsl(graph, {
        input: f.envelope, executionArn: f.executionArn, sleep: seconds => { f.state.now += seconds * 1000; },
        invoke: async (resource, parameters, state) => {
            if (resource === 'helper') {
                const live = { instances: f.state.instances, volumes: f.state.volumes };
                if (stale && remaining > 0) { Object.assign(f.state, structuredClone(stale)); remaining--; observations++; }
                try { return await helper(parameters); }
                catch (error) { throw toLambdaError(error, 'lifecycle_unconfirmed'); }
                finally { Object.assign(f.state, live); }
            }
            const action = state as Action;
            assert.equal(graph.States[state].Retry, undefined, 'provider tasks must not retry automatically');
            calls.push({ action, parameters });
            if (!before.has(action)) before.set(action, view(f));
            if (action === options.after && options.throttle && !throttled) {
                throttled = true; stale = before.get(options.before ?? action); assert.ok(stale);
                remaining = options.observations ?? LAG;
                throw taskError('Ec2.RequestLimitExceeded', 'definite rejection without effect');
            }
            const host = f.state.instances.find(h => h.InstanceId === (parameters.InstanceId ?? parameters.InstanceIds?.[0]));
            switch (action) {
                case 'createVolume':
                    if (!f.state.volumes.length) {
                        const v = f.volume(); v.Tags = parameters.TagSpecifications[0].Tags; f.state.volumes.push(v);
                    }
                    break;
                case 'runInstances': case 'runBurstableInstances':
                    if (!f.state.instances.some(h => h.ClientToken === parameters.ClientToken)) {
                        const h = f.instance('i-33333333333333333'); h.ClientToken = parameters.ClientToken;
                        h.Tags = parameters.TagSpecifications.find((t: any) => t.ResourceType === 'instance').Tags;
                        f.state.instances.push(h);
                    }
                    break;
                case 'createTags': case 'claimInstance': {
                    const target = f.state.instances.find(h => h.InstanceId === parameters.Resources[0])
                        ?? f.state.volumes.find(v => v.VolumeId === parameters.Resources[0]);
                    assert.ok(target);
                    target.Tags = [...target.Tags!.filter(t => !parameters.Tags.some((p: any) => p.Key === t.Key)), ...parameters.Tags];
                    break;
                }
                case 'deleteTags': {
                    const target = f.state.instances.find(h => h.InstanceId === parameters.Resources[0])!;
                    target.Tags = target.Tags!.filter(t => !parameters.Tags.some((p: any) => p.Key === t.Key && p.Value === t.Value));
                    break;
                }
                case 'attachVolume':
                    // Repeating the call against the live EC2 state is unsafe,
                    // even when Describe still claims the volume is available.
                    assert.equal(f.state.volumes[0]!.State, 'available', 'duplicate AttachVolume / VolumeInUse');
                    f.attach(f.state.volumes[0]!, host!); break;
                case 'detachVolume': {
                    const v = f.state.volumes[0]!;
                    assert.equal(v.State, 'in-use', 'duplicate DetachVolume / IncorrectState');
                    assert.equal(host!.State?.Name, 'stopped'); assert.equal(parameters.Force, false);
                    v.State = 'available'; v.Attachments = [];
                    host!.BlockDeviceMappings = host!.BlockDeviceMappings!.filter(m => m.Ebs?.VolumeId !== v.VolumeId);
                    break;
                }
                case 'startInstances': host!.State = { Name: 'running' }; break;
                case 'stopInstances': host!.State = { Name: 'stopped' }; break;
                case 'terminateInstances':
                    host!.State = { Name: 'terminated' }; host!.BlockDeviceMappings = [];
                    for (const v of f.state.volumes) if (v.Attachments?.some(a => a.InstanceId === host!.InstanceId)) {
                        v.State = 'available'; v.Attachments = [];
                    }
                    break;
                case 'modifyInstanceAttribute': assert.equal(host!.State?.Name, 'stopped'); break;
                default: assert.fail(`unexpected action ${action}`);
            }
            if (action === options.after && !stale) {
                stale = options.snapshot ? options.snapshot(view(f)) : before.get(options.before ?? action); assert.ok(stale);
                remaining = options.observations ?? LAG;
            }
            if (action === options.after && options.lost) throw taskError('States.Timeout', 'lost response');
            return {};
        },
    });
    if (result.output) validateLifecycleReceipt({ ...f.envelope, createdAt: f.state.execution.startDate }, result.output);
    return { ...result, calls, observations, elapsed: f.state.now - f.state.execution.startDate.getTime() };
}

const cases: [Fixture['i']['operation'], Action, Parameters<typeof lifecycleFixture>[1]?][] = [
    ['provision', 'createVolume'], ['provision', 'runInstances'], ['provision', 'attachVolume'],
    ['provision', 'runBurstableInstances', { instanceType: 't3.medium', instanceTypes: ['t3.medium', 'm6i.large'] }],
    ['replace', 'stopInstances'], ['replace', 'terminateInstances'], ['replace', 'runInstances'],
    ['replace', 'createTags'], ['replace', 'attachVolume'],
    ['start', 'startInstances'], ['stop', 'stopInstances'], ['retire', 'terminateInstances'],
    ['start', 'modifyInstanceAttribute', { userData: 'bm9uY2UtZTM=', userDataNonce: true }],
    ['pool-provision', 'runInstances'], ['pool-retire', 'terminateInstances'],
    ['adopt', 'createVolume', { dataVolumeGiB: 50 }], ['adopt', 'createTags'], ['adopt', 'attachVolume'],
    ['adopt', 'claimInstance'], ['adopt', 'deleteTags'],
    ['release', 'stopInstances'], ['release', 'detachVolume'], ['release', 'terminateInstances'],
];
for (const [operation, action, options] of cases) test(`${operation}: confirmed ${action}, ${LAG} unchanged observations, no second call`, async () => {
    const r = await run(lifecycleFixture(operation, options), { after: action });
    assert.equal(r.error, undefined, r.cause); assert.ok(r.output); assert.equal(r.observations, LAG);
    for (const name of new Set(r.calls.map(c => c.action))) assert.equal(r.calls.filter(c => c.action === name).length, 1, name);
});

// Unlike an unchanged pre-action snapshot, EC2 can report in-use while its
// attachment list is empty. Exercise the real graph after acknowledged actions.
const attachmentCases = [
    ['provision', 'attachVolume'], ['replace', 'attachVolume'],
    ['adopt', 'attachVolume'], ['adopt', 'claimInstance'], ['adopt', 'deleteTags'],
    ['start', 'startInstances'],
    ['release', 'stopInstances'], ['release', 'detachVolume'], ['release', 'terminateInstances'],
] as const;
const emptyAttachments = (live: View): View => {
    live.volumes[0]!.State = 'in-use'; live.volumes[0]!.Attachments = []; return live;
};
for (const [operation, after] of attachmentCases) {
    for (const lost of [false, true]) test(`ATTACHWAIT ${operation}: ${after} ${lost ? 'lost' : 'acknowledged'}, empty in-use observations converge`, async () => {
        const r = await run(lifecycleFixture(operation), { after, lost, snapshot: emptyAttachments });
        assert.equal(r.error, undefined, r.cause); assert.ok(r.output); assert.equal(r.observations, LAG);
        assert.equal(r.elapsed, LAG * 2000 + (lost ? 1000 : 0));
        for (const action of new Set(r.calls.map(c => c.action)))
            assert.equal(r.calls.filter(c => c.action === action).length, 1, action);
        const index = r.visited.indexOf(after);
        assert.deepEqual(r.visited.slice(index, index + (lost ? 7 : 6)),
            [after, ...(lost ? ['After-' + after] : []), 'Observe-' + afterAction[after], 'Decide', 'Wait', 'Resume', 'Observe-' + afterAction[after]]);
    });
    test(`ATTACHWAIT ${operation}: ${after} empty observations expire without repeating actions`, async () => {
        const r = await run(lifecycleFixture(operation), { after, snapshot: emptyAttachments, observations: Infinity });
        assert.equal(r.error, 'LifecycleUnconfirmed'); assert.equal(r.output, undefined);
        assert.match(r.cause!, /lifecycle_expired/); assert.equal(r.elapsed, 902000);
        for (const action of new Set(r.calls.map(c => c.action)))
            assert.equal(r.calls.filter(c => c.action === action).length, 1, action);
    });
    for (const foreign of ['InstanceId', 'VolumeId'] as const) for (const state of ['in-use', 'creating'] as const)
        test(`ATTACHWAIT ${operation}: ${after} foreign ${foreign} in ${state} fails immediately`, async () => {
            const r = await run(lifecycleFixture(operation), { after, snapshot: live => {
                const v = live.volumes[0]!;
                v.State = state;
                v.Attachments = [{ InstanceId: live.instances.find(h => h.State?.Name !== 'terminated')?.InstanceId ?? live.instances[0]!.InstanceId, VolumeId: v.VolumeId,
                    State: 'attached', Device: '/dev/sdf', DeleteOnTermination: false, ...v.Attachments?.[0],
                    [foreign]: foreign === 'InstanceId' ? 'i-99999999999999999' : 'vol-99999999999999999' }];
                return live;
            } });
            assert.equal(r.error, 'LifecycleUnconfirmed'); assert.equal(r.output, undefined);
            assert.match(r.cause!, /lifecycle_(attachment_invalid|unconfirmed)/);
            assert.equal(r.elapsed, 0); assert.equal(r.observations, 1);
            assert.equal(r.calls.at(-1)!.action, after);
        });
}
for (const after of ['attachVolume', 'claimInstance', 'deleteTags'] as const)
    for (const state of ['available', 'creating', 'deleting', 'deleted', 'error', undefined] as const)
        test(`ATTACHWAIT adopt: ${after} empty ${state ?? 'unknown'} volume view preserves phase`, async () => {
            const r = await run(lifecycleFixture('adopt'), { after, snapshot: live => {
                emptyAttachments(live); live.volumes[0]!.State = state; return live;
            } });
            assert.equal(r.error, undefined, r.cause); assert.ok(r.output); assert.equal(r.observations, LAG);
            assert.equal(r.calls.filter(c => c.action === 'attachVolume').length, 1);
        });

for (const [operation, action] of cases.filter(([, action]) =>
    !['createVolume', 'runInstances', 'runBurstableInstances', 'modifyInstanceAttribute'].includes(action)))
    test(`${operation}: lost ${action}, ${LAG} unchanged observations, no second call`, async () => {
        const r = await run(lifecycleFixture(operation), { after: action, lost: true });
        assert.equal(r.error, undefined, r.cause); assert.equal(r.observations, LAG);
        assert.equal(r.calls.filter(c => c.action === action).length, 1);
    });

for (const [operation, after, before] of [
    ['provision', 'attachVolume', 'runInstances'], ['replace', 'createTags', 'runInstances'],
    ['replace', 'attachVolume', 'runInstances'],
    ['replace', 'attachVolume', 'createTags'], ['adopt', 'attachVolume', 'createTags'],
    ['adopt', 'claimInstance', 'createTags'], ['adopt', 'deleteTags', 'createTags'],
    ['adopt', 'claimInstance', 'attachVolume'], ['adopt', 'deleteTags', 'attachVolume'],
    ['adopt', 'deleteTags', 'claimInstance'],
] as const) test(`${operation}: ${after} followed by regressing ${before} observations never rewinds the phase`, async () => {
    const r = await run(lifecycleFixture(operation), { after, before });
    assert.equal(r.error, undefined, r.cause); assert.equal(r.observations, LAG);
    for (const name of new Set(r.calls.map(c => c.action))) assert.equal(r.calls.filter(c => c.action === name).length, 1, name);
});

for (const [operation, action, options] of cases.filter(([, action]) =>
    ['createVolume', 'runInstances', 'runBurstableInstances'].includes(action)))
    test(`${operation}: lost ${action} retains identical tokenized retries until visible`, async () => {
        const f = lifecycleFixture(operation, options), r = await run(f, { after: action, lost: true });
        assert.equal(r.error, undefined, r.cause); assert.equal(r.observations, LAG);
        const repeated = r.calls.filter(c => c.action === action);
        assert.equal(repeated.length, LAG + 1);
        for (const call of repeated) assert.deepEqual(call.parameters, repeated[0]!.parameters);
        assert.equal(f.state.instances.filter(h => h.ClientToken === repeated[0]!.parameters.ClientToken).length,
            action === 'createVolume' ? 0 : 1);
    });

for (const [operation, after, before, options] of [
    ['provision', 'runInstances', 'createVolume', undefined],
    ['replace', 'runInstances', 'terminateInstances', undefined],
    ['replace', 'createTags', 'runInstances', undefined],
    ['adopt', 'attachVolume', 'createTags', undefined],
    ['adopt', 'claimInstance', 'attachVolume', undefined],
    ['adopt', 'deleteTags', 'claimInstance', undefined],
    ['release', 'detachVolume', 'stopInstances', undefined],
    ['release', 'terminateInstances', 'detachVolume', undefined],
    ['retire', 'terminateInstances', 'stopInstances', undefined],
    ['start', 'startInstances', 'modifyInstanceAttribute', { userData: 'bm9uY2UtZTM=', userDataNonce: true }],
] as const) test(`${operation}: throttled ${after} cannot re-arm completed ${before}`, async () => {
    const r = await run(lifecycleFixture(operation, options), { after, before, throttle: true });
    assert.equal(r.error, undefined, r.cause); assert.equal(r.observations, LAG);
    assert.equal(r.calls.filter(c => c.action === before).length, 1);
    const rejected = r.calls.filter(c => c.action === after);
    assert.equal(rejected.length, 2); assert.deepEqual(rejected[0]!.parameters, rejected[1]!.parameters);
});

for (const userDataNonce of [false, true]) for (const action of Object.keys(afterAction) as Action[]) {
    if (action === 'modifyInstanceAttribute' && !userDataNonce) continue;
    test(`graph: ${action} observes success immediately and preserves caught errors (nonce=${userDataNonce})`, async () => {
        const graph = lifecycleDefinition('helper', { userDataNonce }), state = graph.States[action];
        const observer = 'Observe-' + afterAction[action], after = 'After-' + action;
        assert.equal(state.Next, observer);
        assert.equal(state.Retry, undefined);
        assert.equal(state.TimeoutSeconds, 30);
        assert.deepEqual(state.Catch, [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.lastError', Next: after }]);
        assert.deepEqual(graph.States[after], { Type: 'Wait', Seconds: 1, Next: observer });
        for (const lost of [false, true]) {
            const waits: number[] = [], inputs: any[] = [];
            const prior = { Error: 'Ec2.RequestLimitExceeded', Cause: 'previous error' };
            const caught = { Error: 'States.Timeout', Cause: 'lost response' };
            const parameters = Object.fromEntries(Object.keys(state.Parameters).map(key => [key.slice(0, -2), []]));
            const result = await runAsl({ ...graph, StartAt: action }, {
                input: { ctl: { lastError: prior, observeError: NO_ERROR, throttles: 2 }, step: { parameters } },
                executionArn: 'execution', sleep: seconds => { waits.push(seconds); },
                invoke: async (resource, input) => {
                    if (resource === 'helper') { inputs.push(input); return { decision: 'success', receipt: {} }; }
                    if (lost) throw taskError(caught.Error, caught.Cause);
                    return { providerResponse: 'discarded' };
                },
            });
            assert.equal(result.error, undefined);
            assert.deepEqual(result.visited, [action, ...(lost ? [after] : []), observer, 'Decide', 'Succeeded']);
            assert.deepEqual(waits, lost ? [1] : []);
            assert.deepEqual(inputs, [{ executionArn: 'execution', phase: afterAction[action],
                lastError: lost ? caught : NO_ERROR, throttles: 2 }]);
            assert.deepEqual(result.data.ctl.observeError, NO_ERROR);
        }
    });
}

test('warm adopt and already-stopped release have no fixed waits when first observations converge', async () => {
    const adopt = await run(lifecycleFixture('adopt'));
    assert.equal(adopt.error, undefined); assert.equal(adopt.calls.length, 4); assert.equal(adopt.elapsed, 0);
    const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: 'stopped' };
    const release = await run(f); assert.equal(release.error, undefined); assert.equal(release.calls.length, 2); assert.equal(release.elapsed, 0);
});

test('an incomplete first adopt observation falls back to the ordinary two-second wait', async () => {
    const r = await run(lifecycleFixture('adopt'), { after: 'attachVolume', observations: 1 });
    assert.equal(r.error, undefined); assert.equal(r.observations, 1); assert.equal(r.elapsed, 2000);
    assert.equal(r.calls.length, 4);
    const attempt = r.visited.indexOf('attachVolume');
    assert.deepEqual(r.visited.slice(attempt, attempt + 6),
        ['attachVolume', 'Observe-attached', 'Decide', 'Wait', 'Resume', 'Observe-attached']);
});

for (const operation of ['pool-provision', 'provision', 'adopt', 'release'] as const)
    test(`${operation}: slow visibility keeps the full 900-second observation budget`, async () => {
        const action = operation === 'adopt' ? 'attachVolume' : operation === 'release' ? 'detachVolume' : 'runInstances';
        const r = await run(lifecycleFixture(operation), { after: action, observations: Infinity });
        assert.equal(r.error, 'LifecycleUnconfirmed'); assert.equal(r.output, undefined); assert.match(r.cause!, /lifecycle_expired/);
        assert.ok(r.elapsed > 900000 && r.elapsed <= 902000, String(r.elapsed));
        assert.equal(r.calls.filter(c => c.action === action).length, 1);
        assert.ok(r.observations >= 448);
    });

test('new actions retain the 870-second deadline at its boundary', async () => {
    const f = lifecycleFixture('start'), helper = createLifecycleHelper(f.settings, f.deps);
    f.state.now = f.state.execution.startDate.getTime() + 870000;
    assert.equal((await helper({ executionArn: f.executionArn, phase: 'initial' })).decision, 'startInstances');
    f.state.now++;
    await assert.rejects(helper({ executionArn: f.executionArn, phase: 'initial' }), /lifecycle_expired/);
});

test('immediate success observation keeps retry waits and Standard history within 25,000 events', () => {
    const g = lifecycleDefinition('helper', { userDataNonce: true });
    assert.equal(g.TimeoutSeconds, 960);
    assert.deepEqual(g.States.Wait, { Type: 'Wait', Seconds: 2, Next: 'Resume' });
    assert.deepEqual(g.States.Backoff, { Type: 'Wait', SecondsPath: '$.step.delaySeconds', Next: 'Rearm' });
    assert.deepEqual(g.States.Rearm, { Type: 'Pass', Parameters: { lastError: NO_ERROR,
        'observeError.$': '$.ctl.observeError', 'throttles.$': 'States.MathAdd($.ctl.throttles, 1)' }, ResultPath: '$.ctl', Next: 'Resume' });
    const actions = Object.keys(afterAction) as Action[];
    assert.equal(actions.length, 12);
    assert.deepEqual(new Set(cases.map(([, action]) => action)), new Set(actions), 'all successful actions have no-re-issue coverage');
    for (const action of actions) {
        assert.equal(g.States[action].Next, 'Observe-' + afterAction[action]);
        assert.deepEqual(g.States['After-' + action], { Type: 'Wait', Seconds: 1, Next: 'Observe-' + afterAction[action] });
    }
    // A direct Lambda task emits enter/schedule/start/success/exit (5).
    // Each retry adds schedule/start/failure (3); assume zero jitter delay.
    const observationEvents = 5 + 3 * g.States['Observe-initial'].Retry[0].MaxAttempts;
    // Recurring segments still wait: observation polling takes 2s, caught
    // errors take 1s (including lost allocation/nonce retries), and throttle
    // backoff takes >=2s. Overcharge each segment as Resume(2), Observe(14),
    // Decide(2), EC2(5), Wait(2) = 25, at the minimum wait cadence.
    const backoffWaits = Array.from({ length: MAX_THROTTLE_RETRIES }, (_, n) => throttleDelaySeconds(n, () => 0));
    assert.deepEqual(backoffWaits, [2, 2, 2, 2, 2]);
    const minWait = Math.min(g.States.Wait.Seconds, ...actions.map(a => g.States['After-' + a].Seconds), ...backoffWaits);
    assert.ok(minWait > 0, 'retry cycles must always wait');
    const recurringEvents = (Math.floor(g.TimeoutSeconds / minWait) + 1) * (observationEvents + 11);
    // Successful actions bypass waits, so account for them separately. Phase
    // memory permits each of the 12 actions at most once successfully, even
    // through lag/regression and throttle re-arm (covered above). Charge all
    // 12 although no single operation uses all of them: EC2 + Observe + Decide.
    const immediateEvents = actions.length * (5 + observationEvents + 2);
    const allEvents = recurringEvents + immediateEvents + 2 * MAX_THROTTLE_RETRIES + 6;
    assert.equal(immediateEvents, 252);
    assert.equal(allEvents, 24293); assert.ok(allEvents < 25000);
});
