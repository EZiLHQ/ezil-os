import { expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { createAwsEc2Provider } from './aws-ec2';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import { adoptRecoverySetup, RECOVERY_NOW } from './aws-pool-adopt-recovery.test-support';
import { DEFAULT_OWNER } from './fake-placement-db.test-support';
import type { LifecycleExecutionReader } from './aws-receipts';

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

it.each(['status', 'open'] as const)('%s reconciliation forwards complete failed-adopt history with its receiver', async entry => {
    const { s, history, poll } = setup(entry, true);
    await poll();
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
    await poll();
    expect(history).not.toHaveBeenCalled();
    expect(s.historyCalls).toEqual([]);
    expect(s.starts).toEqual([]);
    expect(await s.current()).toEqual(before);
    expect(s.pool.state).toBe('leased');
    expect(s.usage).toEqual([]);
    expect(s.meter.ready).not.toHaveBeenCalled();
    expect(s.meter.stopped).not.toHaveBeenCalled();
});
