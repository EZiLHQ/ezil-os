import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createAwsEc2Provider } from './aws-ec2';
import { buildLifecycleWork, LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleWork } from './aws-intent';
import { fixtureDeployment, fixtureIntent } from './aws-intent.test-support';
import { applyLifecycleReceipt, lifecycleExecutionArn, runAwsBackgroundReconcile, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow, type Row } from './fake-placement-db.test-support';
import { finishEnrollment, POOL_SESSION_PENDING, readPlacement, type PlacementDb, type PlacementExecutor } from './placement';
import { readPoolSessionReadyAt, recordPoolSessionReady } from './ready-pool';

export const CLAIM_AT = new Date('2026-10-27T12:11:00Z');
const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Evaluate the emitted pool predicates, so removing a SQL guard changes the test's outcome. */
function poolMatches(text: string, params: unknown[], row: Row): boolean {
    const value = (v: string): unknown => {
        const parameter = v.match(/^\$(\d+)/);
        if (parameter) return params[Number(parameter[1]) - 1];
        if (v.startsWith("'")) return v.slice(1, -1);
        return row[v];
    };
    const where = text.split(/\bWHERE\s+/)[1]!.split(/\s+(?:FOR UPDATE|RETURNING)\b/)[0]!.trim();
    return where.split(/\s+AND\s+/).every(predicate => {
        const nil = predicate.match(/^(\w+) IS (NOT )?NULL$/);
        if (nil) return nil[2] ? row[nil[1]!] != null : row[nil[1]!] == null;
        const inside = predicate.match(/^(\w+) IN \((.+)\)$/);
        if (inside) return inside[2]!.split(',').some(v => value(v.trim()) === row[inside[1]!]);
        const comparison = predicate.match(/^(\w+) (=|<=) (.+)$/);
        if (!comparison) throw new Error(`unsupported pool predicate: ${predicate}`);
        const left = row[comparison[1]!], right = value(comparison[3]!);
        return comparison[2] === '=' ? left != null && right != null && left === right
            : left != null && right != null && new Date(left as string).getTime() <= new Date(right as string).getTime();
    });
}

export function stalledAdoptSetup() {
    let clock = CLAIM_AT;
    const d = { ...fixtureDeployment('ap-south-1'), namespace: 'mum',
        stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:1' };
    const adopt = buildLifecycleWork({ ...fixtureIntent('stop'), deployment: d, operation: 'adopt', poolHostId: HOST,
        targetGeneration: 5, leaseEpoch: 6 });
    const i = adopt.intent;
    const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: i.computerId, state: 'STARTING',
        generation: i.targetGeneration, lease_epoch: i.leaseEpoch, region: d.region, zone_id: d.zoneId, instance_type: i.instanceType,
        instance_id: i.providerInstanceId, volume_id: i.dataVolumeId, fence_token: i.fenceToken,
        fs_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', lifecycle_job_id: i.jobId, lifecycle_digest: adopt.digest,
        last_error: 'pool_adopt_source:' + JSON.stringify({ instanceId: 'i-22222222222222222', generation: 4, fenceToken: HOST }),
        updated_at: CLAIM_AT })], computers: [{ id: i.computerId, user_id: DEFAULT_OWNER }] }, { clock: () => clock });
    const host: Row = { id: HOST, generation: 1, leased_generation: 1, lease_token: HOST, region: d.region, zone_id: d.zoneId,
        instance_type: i.instanceType, instance_id: i.providerInstanceId, state: 'leased', leased_computer_id: i.computerId,
        leased_at: CLAIM_AT, claim_generation: i.targetGeneration, claim_lease_epoch: i.leaseEpoch, claim_fence: i.fenceToken,
        claim_volume_serial: i.dataVolumeId!.replace('-', ''), session_ready_at: null, updated_at: CLAIM_AT };
    let onLock: (() => void) | undefined;
    const queries: { sql: string; transaction: boolean }[] = [];
    const wrap = (tx: PlacementExecutor, transaction: boolean): PlacementExecutor => ({ execute: async query => {
        const q = new PgDialect().sqlToQuery(query), text = q.sql.trim().replace(/\s+/g, ' ');
        queries.push({ sql: text, transaction });
        if (text.startsWith('SELECT computer_id') && text.includes('FOR UPDATE')) {
            if (!transaction) throw new Error('placement lock outside transaction');
            onLock?.(); onLock = undefined; return { rows: [] };
        }
        if (text.includes('placement:adopt-unopened')) return { rows: fake.usage.filter(u =>
            (u.computer_id === q.params[0] && u.stopped_at == null) || u.instance_id === q.params[1]).slice(0, 1) };
        if (!text.includes('public.ezil_compute_pool_hosts')) return tx.execute(query);
        if (text.includes('FOR UPDATE') && !transaction) throw new Error('pool lock outside transaction');
        if (!poolMatches(text, q.params, host)) return { rows: [] };
        if (text.startsWith('UPDATE')) {
            if (!transaction) throw new Error('pool write outside transaction');
            for (const assignment of text.split(' SET ')[1]!.split(' WHERE ')[0]!.split(', ')) {
                const [key, raw] = assignment.split(' = ');
                const parameter = raw!.match(/^\$(\d+)/);
                host[key!] = parameter ? q.params[Number(parameter[1]) - 1] : raw === 'now()' ? clock : raw!.slice(1, -1);
            }
        }
        return { rows: [{ ...host }] };
    } });
    const db: PlacementDb = { ...wrap(fake.db, false), transaction: fn => fake.db.transaction(async tx => {
        const saved = { ...host };
        try { return await fn(wrap(tx, true)); } catch (error) { Object.assign(host, saved); throw error; }
    }) };
    const receipt = (w: LifecycleWork) => JSON.stringify({ schemaVersion: 1, jobId: w.intent.jobId, digest: w.digest,
        computerId: i.computerId, generation: w.intent.targetGeneration, leaseEpoch: w.intent.leaseEpoch, fenceToken: w.intent.fenceToken,
        instanceId: w.intent.providerInstanceId ?? 'i-33333333333333333', volumeId: i.dataVolumeId,
        state: w.intent.operation === 'release' ? 'retired' : 'running' });
    type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
    const original: Execution = { status: 'SUCCEEDED', input: adopt.input, output: receipt(adopt),
        executionArn: lifecycleExecutionArn(d, i.jobId), stateMachineVersionArn: adopt.stateMachineArn, startDate: CLAIM_AT, redriveCount: 0 };
    const executions = new Map([[original.executionArn!, original]]), starts: LifecycleWork[] = [];
    const meter = { ready: vi.fn(), stopped: vi.fn(), heartbeat: vi.fn() };
    const deps: ReceiptDeps = { db, now: () => clock, clock: () => clock, meter, sleep: async () => {},
        pool: { readyAt: readPoolSessionReadyAt, publishPoolClaim: vi.fn(), leasePoolHost: vi.fn(),
            validateCapacity: vi.fn(), buildWork: buildLifecycleWork, replenish: vi.fn() },
        tunnels: { deleteTunnel: vi.fn(async () => ({ ok: true })) } as unknown as ReceiptDeps['tunnels'],
        executions: { describe: vi.fn(async (_region, arn) => {
            const e = executions.get(arn);
            if (!e) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
            return e;
        }) },
        starter: { start: vi.fn(async (_region, request) => {
            const w = buildLifecycleWork(JSON.parse(JSON.parse(request.input).document)); starts.push(w);
            executions.set(lifecycleExecutionArn(d, w.intent.jobId), { status: 'RUNNING', input: w.input,
                executionArn: lifecycleExecutionArn(d, w.intent.jobId), stateMachineVersionArn: w.stateMachineArn, startDate: clock, redriveCount: 0 });
        }) } };
    const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', AWS_REGIONS: d.region, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10',
        EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
        EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200', EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
        EZIL_AWS_WAKE_MODE: 'start', EZIL_AWS_LIFECYCLE_USERDATA_NONCE: '1', [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ [d.region]: d }) };
    const current = async () => (await readPlacement(db, i.computerId)).record!;
    const provider = createAwsEc2Provider({ ...deps, env: () => env });
    return { ...fake, db, deps, d, host, starts, executions, original, adopt, meter, env, queries, current,
        at: (ms: number) => { clock = new Date(CLAIM_AT.getTime() + ms); },
        race: (fn: () => void) => { onLock = fn; },
        tick: async () => applyLifecycleReceipt(deps, await current(), d),
        fleet: () => runAwsBackgroundReconcile(env, deps),
        ensure: () => provider.ensure({ correlationId: 'test' }, { computerId: i.computerId, userId: DEFAULT_OWNER }, { sessionId: 'test', desktopMode: 'neko' }),
        status: () => provider.status({ correlationId: 'test' }, { computerId: i.computerId, userId: DEFAULT_OWNER }),
        finish: () => {
            const w = starts.at(-1)!;
            Object.assign(executions.get(lifecycleExecutionArn(d, w.intent.jobId))!, { status: 'SUCCEEDED', output: receipt(w), stopDate: clock });
        },
        ready: async () => {
            Object.assign(fake.placements[0]!, { last_error: POOL_SESSION_PENDING, enroll_consumed_hash: 'a'.repeat(64) });
            const p = await current();
            await db.transaction(async tx => {
                const result = await finishEnrollment({ execute: q => tx.execute(q), transaction: fn => fn(tx) },
                    { computerId: i.computerId, expected: p, success: true, poolClaim: true, sessionReady: true });
                if (!result.ok || !await recordPoolSessionReady(tx, HOST, p, clock)) throw new Error('fixture readiness failed');
            });
        },
    };
}
