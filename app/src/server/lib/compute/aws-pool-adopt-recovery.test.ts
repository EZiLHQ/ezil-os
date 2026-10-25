import { expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { createHash } from 'node:crypto';
import { adoptRecoverySetup, RECOVERY_OTHER } from './aws-pool-adopt-recovery.test-support';
import { adoptRecoveryReplay, authorizeAdoptRecovery, buildAdoptRecoveryWork, proveFailedAdoptHistory } from './aws-pool-recovery';
import { lifecycleExecutionArn } from './aws-receipts';

type Fixture = ReturnType<typeof adoptRecoverySetup>;
it('live old-AMI failed adopt: atomic replay, successful release, STOPPED and retired pool, zero usage', async () => {
    const s = adoptRecoverySetup(); await s.tick();
    expect(s.starts).toHaveLength(1); const w = s.starts[0]!;
    expect((await s.current()).state).toBe('RECOVERING');
    expect(w.intent.operation).toBe('release'); expect(w.intent.deployment.amiId).toBe(s.currentDeployment.amiId);
    expect(adoptRecoveryReplay(await s.current())!.intent.adoptRecoverRelease.sourceDocument).toBe(JSON.parse(s.original.input).document);
    expect(await authorizeAdoptRecovery(s.db, await s.current())).toBe(true);
    const envelope = JSON.parse(w.input); expect(createHash('sha256').update(envelope.document).digest('hex')).toBe(w.digest);
    expect(s.queries.filter(q => q.sql.includes('FOR UPDATE')).every(q => q.transaction)).toBe(true);
    s.finish(); await s.tick();
    expect((await s.current()).state).toBe('STOPPED'); expect(s.pool.state).toBe('retired');
    expect(s.volume.state).toBe('available'); expect(s.usage).toEqual([]); expect(s.meter.stopped).not.toHaveBeenCalled();
    expect(s.statements.filter(q => q.sql.includes('usage-'))).toEqual([]);
});
it('retries an absent execution with the durable identical job and input', async () => {
    const s = adoptRecoverySetup(); await s.tick(); const w = s.starts[0]!;
    s.executions.delete(lifecycleExecutionArn(w.intent.deployment, w.intent.jobId)); await s.tick();
    expect(s.starts).toHaveLength(2); expect(s.starts[1]).toEqual(w);
});
it('failed recovery cannot loop on the same lifecycle version or turn into generic release recovery', async () => {
    const s = adoptRecoverySetup(); await s.tick(); s.finish('FAILED'); await s.tick(); await s.tick();
    expect((await s.current()).state).toBe('UNCONFIRMED'); expect(s.starts).toHaveLength(1);
    s.currentDeployment.stateMachineVersionArn = s.currentDeployment.stateMachineVersionArn.replace(/:2$/, ':3');
    await s.tick(); expect(s.starts).toHaveLength(1);
});
it('refuses initial recovery on the failed adopt\'s own lifecycle version without any write or start', async () => {
    const s = adoptRecoverySetup(); s.currentDeployment.stateMachineVersionArn = s.original.stateMachineArn;
    const before = { ...(await s.current()) }, pool = { ...s.pool };
    await s.tick(); await s.tick();
    expect(s.starts).toHaveLength(0); expect(await s.current()).toEqual(before); expect(s.pool).toEqual(pool);
    expect(s.statements.filter(q => /\b(UPDATE|INSERT|DELETE)\b/i.test(q.sql))).toEqual([]);
});
it('builder rejects a recovery whose source version equals its target version', async () => {
    const s = adoptRecoverySetup(); await s.tick(); const w = s.starts[0]!;
    const { adoptRecoverRelease, ...base } = w.intent;
    expect(() => buildAdoptRecoveryWork({ ...base, adoptRecoverRelease })).not.toThrow();
    expect(() => buildAdoptRecoveryWork({ ...base, deployment: { ...base.deployment, stateMachineVersionArn: s.original.stateMachineArn },
        adoptRecoverRelease })).toThrow('adopt_recovery_guard');
});
const guards: [string, (s: Fixture) => void][] = [
    ['redrive', s => { s.originalExecution.redriveCount = 1; }],
    ['alias', s => { s.originalExecution.stateMachineAliasArn = 'alias'; }],
    ['source version', s => { s.originalExecution.stateMachineVersionArn += '9'; }],
    ['source arn', s => { s.originalExecution.executionArn += '9'; }],
    ['nonfailed source', s => { s.originalExecution.status = 'TIMED_OUT'; }],
    ['wrong failure', s => { s.originalExecution.error = 'Other'; }],
    ['history has no ACK', s => { s.history[25]!.type = 'TaskFailed'; }],
    ['history has claim', s => { s.history[27]!.stateEnteredEventDetails!.name = 'claimInstance'; }],
    ['incomplete history', s => { s.history.pop(); }],
    ['history starts late', s => { s.history.shift(); }],
    ['history input differs', s => { s.history[0]!.executionStartedEventDetails!.input = '{}'; }],
    ['history pagination gap', s => { s.history[22]!.id = 99; }],
    ['history redriven', s => { s.history[27]!.type = 'ExecutionRedriven'; }],
    ['history truncated', s => { s.history[0]!.executionStartedEventDetails!.inputDetails = { truncated: true }; }],
    ['history other attach volume', s => { s.history[23]!.taskScheduledEventDetails!.parameters = JSON.stringify({ InstanceId: s.host.instanceId, VolumeId: 'vol-99999999999999999', Device: '/dev/sdf' }); }],
    ['history unlinked ACK', s => { s.history[25]!.previousEventId = 3; }],
    ['history task type', s => { s.history[23]!.taskScheduledEventDetails!.resourceType = 'lambda'; }],
    ['history ACK resource', s => { s.history[25]!.taskSucceededEventDetails!.resource = 'createTags'; }],
    ['wrong original AMI', s => { s.host.imageId = s.currentDeployment.amiId; }],
    ['host instance', s => { s.host.instanceId = 'i-99999999999999999'; }],
    ['host stopped', s => { s.host.state = 'stopped'; }],
    ['host zone', s => { s.host.availabilityZoneId = 'aps1-az9'; }],
    ['host type', s => { s.host.instanceType = 'm6i.xlarge'; }],
    ['host root', s => { s.host.rootDeviceName = '/dev/sdb'; }],
    ['extra disk', s => { s.host.volumes.push({ ...s.host.volumes[1]!, volumeId: 'vol-99999999999999999' }); }],
    ['root retained', s => { s.host.volumes[0]!.deleteOnTermination = false; }],
    ['data deleted', s => { s.host.volumes[1]!.deleteOnTermination = true; }],
    ['foreign attachment', s => { s.volume.attachments[0]!.instanceId = 'i-99999999999999999'; }],
    ['nonempty attachment', s => { s.volume.attachments.push({ ...s.volume.attachments[0]! }); }],
    ['empty preflight attachment', s => { s.volume.state = 'available'; s.volume.attachments = []; }],
    ['volume unencrypted', s => { s.volume.encrypted = false; }],
    ['volume wrong key', s => { s.volume.kmsKeyId = 'other'; }],
    ['volume wrong zone', s => { s.volume.zoneId = 'aps1-az9'; }],
    ['pool instance', s => { s.pool.instance_id = 'i-99999999999999999'; }],
    ['pool computer', s => { s.pool.leased_computer_id = RECOVERY_OTHER; }],
    ['pool generation', s => { s.pool.leased_generation = 9; }],
    ['pool state', s => { s.pool.state = 'retired'; }],
    ['pool lease token', s => { s.pool.lease_token = null; }],
    ['published claim', s => { s.pool.claim_generation = 5; }],
    ['session ready', s => { s.pool.session_ready_at = new Date(); }],
    ['enrollment issued', s => { s.placements[0]!.enroll_nonce_hash = 'ab'.repeat(32); }],
    ['enrollment consumed', s => { s.placements[0]!.enroll_consumed_hash = 'ab'.repeat(32); }],
    ['enrollment expires', s => { s.placements[0]!.enroll_expires_at = new Date(); }],
    ['computer deleted', s => { s.computers[0]!.deleted_at = new Date(); }],
    ['computer owner', s => { s.computers[0]!.user_id = RECOVERY_OTHER; }],
    ['current deployment changed subnet', s => { s.currentDeployment.subnetId = 'subnet-99999999999999999'; }],
];
for (const key of ['ezil:computer', 'ezil:computer-id', 'ezil:generation', 'ezil:fence', 'ezil:fence-token'])
    guards.push([`host claim alias ${key}`, s => { s.host.tags[key] = s.original.intent.computerId; }]);
for (const key of ['ezil:managed-by', 'ezil:stage', 'ezil:namespace', 'ezil:pool', 'ezil:pool-host', 'aws:ec2launchtemplate:id'])
    guards.push([`host ownership ${key}`, s => { s.host.tags[key] = 'foreign'; }]);
for (const key of ['ezil:computer-id', 'ezil:generation', 'ezil:fence-token', 'ezil:managed-by', 'ezil:stage', 'ezil:computer', 'ezil:fence'])
    guards.push([`volume ownership ${key}`, s => { s.volume.tags[key] = 'foreign'; }]);
it.each(guards)('refuses %s without mutation', async (_name, change) => {
    const s = adoptRecoverySetup(); change(s); await s.tick(); expect(s.starts).toHaveLength(0);
    expect(s.usage).toEqual([]); expect(s.meter.stopped).not.toHaveBeenCalled();
});
it.each(['lease_token', 'instance_id', 'leased_generation', 'claim_fence', 'session_ready_at'])('atomic lock revalidation catches racing %s', async key => {
    const s = adoptRecoverySetup(); s.race(() => { s.pool[key] = key === 'leased_generation' ? 9 : s.original.intent.jobId; });
    await s.tick(); expect(s.starts).toHaveLength(0); expect((await s.current()).state).toBe('UNCONFIRMED');
});
it('atomic placement lock catches racing enrollment', async () => {
    const s = adoptRecoverySetup(); s.race(() => { s.placements[0]!.enroll_consumed_hash = 'ab'.repeat(32); });
    await s.tick(); expect(s.starts).toHaveLength(0);
});
it.each(['sourceDigest', 'sourceVersion', 'executionArn'] as const)('replay builder refuses corrupt %s', async key => {
    const s = adoptRecoverySetup(); await s.tick(); const w = adoptRecoveryReplay(await s.current())!;
    w.intent.adoptRecoverRelease[key] += '9'; expect(() => buildAdoptRecoveryWork(w.intent)).toThrow();
});
it('history proof requires a linked scheduled/start/succeeded chain', () => {
    const s = adoptRecoverySetup(); s.history[24]!.type = 'TaskFailed';
    expect(() => proveFailedAdoptHistory(s.originalExecution, s.original, s.history)).toThrow();
});
it('successful receipt cannot complete until volume is available', async () => {
    const s = adoptRecoverySetup(); await s.tick(); s.finish(); s.volume.state = 'in-use'; await s.tick();
    expect((await s.current()).state).toBe('RECOVERING'); expect(s.pool.state).toBe('leased');
    s.volume.state = 'available'; await s.tick(); expect((await s.current()).state).toBe('STOPPED');
});
it.each(['digest', 'jobId', 'computerId', 'generation', 'leaseEpoch', 'fenceToken', 'instanceId', 'volumeId', 'state'])('bad receipt %s retains reservation', async key => {
    const s = adoptRecoverySetup(); await s.tick(); const e = s.finish(), r = JSON.parse(e.output!);
    r[key] = typeof r[key] === 'number' ? 99 : RECOVERY_OTHER; e.output = JSON.stringify(r); await s.tick();
    expect((await s.current()).state).toBe('RECOVERING'); expect(s.pool.state).toBe('leased'); expect(s.usage).toEqual([]);
});
it('refuses a stale placement digest before admitting recovery', async () => {
    const s = adoptRecoverySetup(); s.placements[0]!.lifecycle_digest = 'cd'.repeat(32); await s.tick(); expect(s.starts).toHaveLength(0);
});
it('refuses a second attach entry in the complete history', async () => {
    const s = adoptRecoverySetup(); s.history[27]!.stateEnteredEventDetails!.name = 'attachVolume'; await s.tick(); expect(s.starts).toHaveLength(0);
});
it.each(['stateMachineVersionArn', 'executionArn', 'input', 'stateMachineAliasArn', 'redriveCount'] as const)('refuses changed recovery execution %s', async key => {
    const s = adoptRecoverySetup(); await s.tick(); const e = s.finish(); Object.assign(e, { [key]: key === 'redriveCount' ? 1 : 'bad' });
    await s.tick(); expect((await s.current()).state).toBe('RECOVERING'); expect(s.pool.state).toBe('leased');
});
it.each(['claimNeverRan', 'redriveCount', 'status', 'attachAcknowledged'] as const)('replay rejects corrupt proof %s', async key => {
    const s = adoptRecoverySetup(); await s.tick(); const w = adoptRecoveryReplay(await s.current())!;
    Object.assign(w.intent.adoptRecoverRelease.proof, { [key]: key === 'claimNeverRan' ? false : key === 'status' ? 'SUCCEEDED' : -1 });
    expect(() => buildAdoptRecoveryWork(w.intent)).toThrow();
});

it('normal regional execution reader supplies the complete 34-event history across the attach boundary', async () => {
    const s = adoptRecoverySetup(); await s.tick();
    expect(s.history).toHaveLength(34); expect(s.history[30]!.type).toBe('LambdaFunctionFailed');
    expect(s.historyCalls).toHaveLength(2);
    expect(s.starts[0]!.intent.adoptRecoverRelease.proof).toMatchObject({ attachEntered: 23, attachAcknowledged: 26, terminal: 34 });
});
it.each(['running', 'stopped', 'shutting-down', 'wrong-instance', 'absent', 'NotFound', 'throttled'])
('completion requires positive exact terminated host: %s remains retryable', async state => {
    const s = adoptRecoverySetup(); await s.tick(); s.finish();
    const read = vi.mocked(s.deps.describer!.describeForEnrollment);
    read.mockClear();
    if (state === 'absent') read.mockResolvedValueOnce(null);
    else if (state === 'NotFound' || state === 'throttled') read.mockRejectedValueOnce(Object.assign(new Error(state), { name: state === 'NotFound' ? 'InvalidInstanceID.NotFound' : 'ThrottlingException' }));
    else read.mockResolvedValueOnce({ ...s.host, state: state === 'wrong-instance' ? 'terminated' : state, instanceId: state === 'wrong-instance' ? 'i-99999999999999999' : s.host.instanceId });
    await s.tick(); expect(read).toHaveBeenCalledTimes(1);
    expect((await s.current()).state).toBe('RECOVERING'); expect(s.pool.state).toBe('leased');
    expect(s.statements.filter(q => q.sql.includes('usage-'))).toEqual([]);
    await s.tick(); expect((await s.current()).state).toBe('STOPPED');
});
it.each(['open-computer-other-host', 'closed-host', 'closed-host-other-computer'])
('any disqualifying ledger row refuses initiation and completion: %s', async kind => {
    for (const completion of [false, true]) for (const race of [false, true]) {
        const s = adoptRecoverySetup();
        if (completion) { await s.tick(); s.finish(); }
        const add = () => s.usage.push({ computer_id: kind === 'closed-host-other-computer' ? RECOVERY_OTHER : s.original.intent.computerId,
            instance_id: kind === 'open-computer-other-host' ? 'i-99999999999999999' : s.host.instanceId,
            stopped_at: kind === 'open-computer-other-host' ? null : new Date('2026-10-01') });
        if (race) s.race(add); else add();
        await s.tick();
        expect(s.starts).toHaveLength(completion ? 1 : 0);
        expect((await s.current()).state).toBe(completion ? 'RECOVERING' : 'UNCONFIRMED');
        expect(s.pool.state).toBe('leased'); expect(s.statements.filter(q => q.sql.includes('usage-'))).toEqual([]);
        const checks = s.queries.filter(q => q.sql.includes('placement:adopt-unopened'));
        expect(checks.length).toBeGreaterThan(0); expect(checks.every(q => q.transaction)).toBe(true);
        for (const q of checks) expect(q.sql.replace(/\s+/g, ' ').trim()).toBe('/* placement:adopt-unopened */ SELECT computer_id FROM public.ezil_compute_usage WHERE (computer_id = $1::uuid AND stopped_at IS NULL) OR instance_id = $2 LIMIT 1');
        const checkIndex = s.queries.indexOf(checks.at(-1)!);
        expect(s.queries.slice(0, checkIndex).some(q => q.sql.includes('ezil_compute_pool_hosts') && q.sql.includes('FOR UPDATE'))).toBe(true);
    }
});
it('closed usage for a different host is preserved without writes', async () => {
    const s = adoptRecoverySetup(); const old = { computer_id: s.original.intent.computerId, instance_id: 'i-old', stopped_at: new Date('2026-10-01') };
    s.usage.push(old); await s.tick(); s.finish(); await s.tick();
    expect((await s.current()).state).toBe('STOPPED'); expect(s.usage).toEqual([old]);
    expect(s.statements.filter(q => q.sql.includes('usage-'))).toEqual([]);
});
it('failed attempt permanently holds its source and partial claim/unpool progress across versions', async () => {
    const s = adoptRecoverySetup(); await s.tick(); const saved = (await s.current()).lastError;
    delete s.host.tags['ezil:pool']; s.host.tags['ezil:computer-id'] = s.original.intent.computerId;
    s.finish('FAILED'); await s.tick();
    for (const version of [2, 3, 4]) {
        s.currentDeployment.stateMachineVersionArn = s.currentDeployment.stateMachineVersionArn.replace(/:[0-9]+$/, ':' + version);
        await s.tick(); expect((await s.current()).lastError).toBe(saved); expect(s.starts).toHaveLength(1);
        expect(s.host.tags['ezil:pool']).toBeUndefined(); expect(s.host.tags['ezil:computer-id']).toBe(s.original.intent.computerId);
    }
});
it('pool retirement failure rolls back completion without touching usage', async () => {
    const s = adoptRecoverySetup(); await s.tick(); s.finish();
    const execute = s.db.transaction;
    s.db.transaction = fn => execute(tx => fn({ execute: async q => {
        const { PgDialect } = await import('drizzle-orm/pg-core');
        if (new PgDialect().sqlToQuery(q).sql.startsWith('UPDATE public.ezil_compute_pool_hosts')) throw new Error('retirement failed');
        return tx.execute(q);
    } }));
    await s.tick(); expect((await s.current()).state).toBe('RECOVERING'); expect(s.pool.state).toBe('leased');
    expect(s.statements.filter(q => q.sql.includes('usage-'))).toEqual([]);
});
