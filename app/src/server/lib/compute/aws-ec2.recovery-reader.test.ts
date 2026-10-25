import { expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { createAwsEc2Provider } from './aws-ec2';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import { adoptRecoverySetup, RECOVERY_NOW } from './aws-pool-adopt-recovery.test-support';
import { DEFAULT_OWNER } from './fake-placement-db.test-support';
import { lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';

function setup(entry: 'status' | 'open', withHistory: boolean) {
    const s = adoptRecoverySetup();
    const original = s.deps.executions!;
    // Prototype methods require their original receiver: spreading the reader
    // or forwarding an unbound method must not satisfy this regression.
    class Reader implements LifecycleExecutionReader {
        describe(...args: Parameters<LifecycleExecutionReader['describe']>) {
            expect(this).toBe(reader);
            return original.describe(...args);
        }
        history(...args: Parameters<NonNullable<LifecycleExecutionReader['history']>>) {
            expect(this).toBe(reader);
            return original.history!(...args);
        }
    }
    const reader = new Reader();
    const history = vi.spyOn(reader, 'history');
    const executions: LifecycleExecutionReader = withHistory ? reader : { describe: reader.describe.bind(reader) };
    const d = s.currentDeployment;
    const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', AWS_REGIONS: d.region,
        EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100',
        EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
        EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200', EZIL_AWS_WAKE_MODE: 'start',
        EZIL_AWS_LIFECYCLE_USERDATA_NONCE: '1', [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ [d.region]: d }) };
    const provider = createAwsEc2Provider({ ...s.deps, executions, now: () => RECOVERY_NOW, env: () => env });
    const computer = { computerId: s.original.intent.computerId, userId: DEFAULT_OWNER };
    const poll = () => entry === 'status' ? provider.status({ correlationId: 'recovery-reader-test' }, computer)
        : provider.ensure({ correlationId: 'recovery-reader-test' }, computer, { sessionId: 'test', desktopMode: 'neko' });
    return { s, history, poll };
}

for (const hostState of ['running', 'stopped']) it.each(['status', 'open'] as const)(`%s reconciliation of ${hostState} host forwards complete failed-adopt history with its receiver`, async entry => {
    const { s, history, poll } = setup(entry, true);
    s.host.state = hostState;
    expect(await poll()).toMatchObject(entry === 'open'
        ? { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true }
        : { ok: true, state: 'starting', placementState: 'RECOVERING' });
    expect(history).toHaveBeenCalledWith(s.original.intent.deployment.region, s.originalExecution.executionArn);
    expect(s.historyCalls).toHaveLength(2);
    expect(s.starts).toHaveLength(1);
    expect(s.starts[0]!.intent.operation).toBe('release');
    expect(s.starts[0]!.intent.adoptRecoverRelease.sourceDocument).toBe(JSON.parse(s.original.input).document);
    expect((await s.current()).state).toBe('RECOVERING');
    expect(s.queries.filter(q => q.sql.includes('FOR UPDATE')).every(q => q.transaction)).toBe(true);
    expect(s.usage).toEqual([]);
    expect(s.meter.ready).not.toHaveBeenCalled();
    expect(s.meter.stopped).not.toHaveBeenCalled();
});

it.each(['status', 'open'] as const)('%s reconciliation without history remains fail-closed', async entry => {
    const { s, history, poll } = setup(entry, false);
    const before = await s.current();
    expect(await poll()).toMatchObject(entry === 'open'
        ? { ok: false, error: 'computer_recovering', errorCode: 'computer_recovering', retryable: false }
        : { ok: false, state: 'error', error: 'placement_unconfirmed' });
    expect(history).not.toHaveBeenCalled();
    expect(s.historyCalls).toEqual([]);
    expect(s.starts).toEqual([]);
    expect(await s.current()).toEqual(before);
    expect(s.pool.state).toBe('leased');
    expect(s.usage).toEqual([]);
    expect(s.meter.ready).not.toHaveBeenCalled();
    expect(s.meter.stopped).not.toHaveBeenCalled();
});

for (const state of ['RECOVERING', 'UNCONFIRMED']) it.each(['status', 'open'] as const)(`%s keeps waiting for a saved in-flight recovery in ${state}`, async entry => {
    const { s, poll } = setup(entry, true); await s.tick();
    s.placements[0]!.state = state;
    expect(await poll()).toMatchObject(entry === 'open'
        ? { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true }
        : { ok: true, state: 'starting', placementState: state });
    expect(s.starts).toHaveLength(1); expect(s.usage).toEqual([]);
});

for (const terminal of ['FAILED', 'TIMED_OUT', 'ABORTED']) it.each(['status', 'open'] as const)(`%s preserves the non-retryable hold after recovery ${terminal}`, async entry => {
    const { s, poll } = setup(entry, true); await s.tick();
    const saved = (await s.current()).lastError; s.finish(terminal);
    for (let n = 0; n < 2; n++) {
        expect(await poll()).toMatchObject(entry === 'open'
            ? { ok: false, error: 'computer_recovering', errorCode: 'computer_recovering', retryable: false }
            : { ok: false, state: 'error', error: 'placement_unconfirmed' });
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: saved });
    }
    expect(s.starts).toHaveLength(1);
});

for (const invalid of ['placement', 'input', 'version', 'arn', 'alias', 'redrive', 'absent'])
    it.each(['status', 'open'] as const)(`%s refuses UNCONFIRMED recovery with ${invalid} evidence`, async entry => {
        const { s, poll } = setup(entry, true); await s.tick(); s.placements[0]!.state = 'UNCONFIRMED';
        const w = s.starts[0]!, arn = lifecycleExecutionArn(w.intent.deployment, w.intent.jobId), e = s.executions.get(arn)!;
        if (invalid === 'placement') s.placements[0]!.lifecycle_digest = '00'.repeat(32);
        if (invalid === 'input') e.input = '{}';
        if (invalid === 'version') e.stateMachineVersionArn = s.original.stateMachineArn;
        if (invalid === 'arn') e.executionArn += '9';
        if (invalid === 'alias') e.stateMachineAliasArn = 'alias';
        if (invalid === 'redrive') e.redriveCount = 1;
        if (invalid === 'absent') s.executions.delete(arn);
        expect(await poll()).toMatchObject(entry === 'open'
            ? { ok: false, errorCode: 'computer_recovering', retryable: false }
            : { ok: false, state: 'error', error: 'placement_unconfirmed' });
        expect(s.starts).toHaveLength(1);
    });
