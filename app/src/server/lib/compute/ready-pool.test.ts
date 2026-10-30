import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PlacementDb, PlacementExecutor } from './placement';
import { leasePoolHost, markPoolHost, planPool, POOL_POLICY, publishPoolClaim, readPoolClaim, readPoolDemand,
    recordPoolEnrollment, recordPoolReady, readPoolReadinessDiagnostics, retireRefusedPoolLease, type PoolClass, type PoolDemand, type PoolHostState } from './ready-pool';

const NOW = new Date('2026-10-23T12:00:00.123Z');
const c: PoolClass = { region: 'ap-south-1', zoneId: 'aps1-az1', instanceType: 'm6i.large' };
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
const demand = (patch: Partial<PoolDemand> = {}): PoolDemand => ({ opens15m: 0, activeStandard: 1, activePremium: 0,
    bootMinutes: null, spares: 0, vcpuInUse: 0, regionVcpuCap: 40, killSwitch: false, idleReady: [], booting: [], ...patch });
const raw = { id: 'host', generation: '1', ...c, zone_id: c.zoneId, instance_type: c.instanceType,
    instance_id: 'i-pool', state: 'ready', ready_at: NOW.toISOString(), enrolled_at: NOW.toISOString(), leased_at: null,
    leased_computer_id: null, claim_generation: null, claim_lease_epoch: null, claim_fence: null, claim_volume_serial: null };
const claim = { computerId: 'computer', generation: 3, leaseEpoch: 4, fence: 'fence', volumeSerial: 'vol1234' };
function capture(result: unknown = [raw]) {
    const queries: { sql: string; params: unknown[] }[] = [];
    const db: PlacementExecutor = { execute: async q => { const compiled = new PgDialect().sqlToQuery(q);
        queries.push({ sql: compiled.sql.replace(/\s+/g, ' ').trim(), params: compiled.params }); return result; } };
    return { db, queries };
}

describe('P1/P2 pool planning', () => {
    it.each([
        ['minimum', {}, 1, 1], ['recent rounds up', { opens15m: 1 }, 1, 1],
        ['unknown boot defaults to four minutes', { opens15m: 4, activeStandard: 2 }, 2, 2],
        ['measured p90', { opens15m: 4, bootMinutes: 1 }, 1, 1],
        ['measured fractional p90', { opens15m: 10, bootMinutes: 1.5 }, 1, 1],
        ['standard base', { activeStandard: 26 }, 2, 2], ['premium base', { activePremium: 11 }, 2, 2],
        ['weighted base combined before ceiling', { activeStandard: 1, activePremium: 1 }, 1, 1],
        ['max recent/base, not sum', { opens15m: 4, activePremium: 11 }, 2, 2],
        ['activity ceiling and two boots', { opens15m: 1000, activeStandard: 30 }, 16, 2],
        ['booting already covers target', { spares: 1, vcpuInUse: 2, booting: [{ poolHostId: 'b', createdAt: ago(1) }] }, 1, 0],
        ['mixed ready/booting covers target', { opens15m: 1, spares: 2, vcpuInUse: 4,
            idleReady: [{ poolHostId: 'r', readyAt: ago(1) }], booting: [{ poolHostId: 'b', createdAt: ago(1) }] }, 1, 0],
        ['vcpu includes existing spares', { opens15m: 100, activeStandard: 5, spares: 1, vcpuInUse: 8, regionVcpuCap: 10 }, 2, 1],
        ['vcpu floor', { opens15m: 100, vcpuInUse: 7, regionVcpuCap: 10 }, 1, 1],
        ['vcpu full', { opens15m: 100, activeStandard: 5, spares: 2, vcpuInUse: 10, regionVcpuCap: 10 }, 2, 0],
        ['over cap lowers target', { spares: 2, vcpuInUse: 12, regionVcpuCap: 10 }, 1, 0],
        ['target never negative', { spares: 1, vcpuInUse: 30, regionVcpuCap: 0 }, 0, 0],
        ['kill switch', { opens15m: 100, activePremium: 100, killSwitch: true }, 0, 0],
    ] as [string, Partial<PoolDemand>, number, number][])('%s', (_, patch, target, provision) => {
        expect(planPool(c, demand(patch), NOW)).toEqual({ target, provision, retire: [], fail: [] });
    });
    it.each([
        ['one paid user keeps exactly one spare despite heavy history', { opens15m: 1000, activeStandard: 1 }, 1],
        ['one Premium on its selected class keeps one spare', { activeStandard: 0, activePremium: 1 }, 1],
        ['spares rise with paid users and opens', { opens15m: 15, activeStandard: 3, activePremium: 2 }, 4],
        ['spares never exceed paid users of the class', { opens15m: 60, activeStandard: 2, activePremium: 1 }, 3],
    ] as [string, Partial<PoolDemand>, number][])('demand-driven: %s', (_, patch, target) => {
        expect(planPool(c, demand(patch), NOW).target).toBe(target);
    });
    describe('production namespace prd keeps exactly one warm m6i.large spare', () => {
        const deployment = { namespace: 'prd' } as NonNullable<PoolClass['deployment']>;
        const prd = (instanceType: PoolClass['instanceType']): PoolClass => ({ ...c, instanceType, deployment });
        it.each([
            ['no paid users yet', { activeStandard: 0 }],
            ['heavy demand never adds a second spare', { opens15m: 1000, activeStandard: 30, activePremium: 10 }],
            ['waiting opens never add a second spare', { activeStandard: 3, pending: 4 }],
        ] as [string, Partial<PoolDemand>][])('m6i.large: %s', (_, patch) => {
            expect(planPool(prd('m6i.large'), demand(patch), NOW).target).toBe(1);
        });
        it.each(['m6i.xlarge', 'm6i.2xlarge'] as const)('%s stays cold even when selected and switching', type => {
            expect(planPool(prd(type), demand({ opens15m: 100, activeStandard: 5, activePremium: 5, pending: 2 }), NOW).target).toBe(0);
        });
        it('mum and classes without a deployment keep the mum policy', () => {
            const mum = { ...c, instanceType: 'm6i.xlarge' as const, deployment: { namespace: 'mum' } as NonNullable<PoolClass['deployment']> };
            expect(planPool(mum, demand({ activeStandard: 1 }), NOW).target).toBe(1);
            expect(planPool(c, demand({ opens15m: 15, activeStandard: 3, activePremium: 2 }), NOW).target).toBe(4);
            expect(POOL_POLICY['ap-south-1:m6i.large']).toEqual({ minSpares: 1, maxSpares: 16 });
        });
    });
    it('scale-down retires aged excess spares once paid users leave the class, back to the minimum', () => {
        const idleReady = [40, 50, 60].map(n => ({ poolHostId: String(n), readyAt: ago(n) }));
        expect(planPool(c, demand({ activeStandard: 1, spares: 3, idleReady }), NOW)).toMatchObject({ target: 1, retire: ['40', '50'] });
        expect(planPool(c, demand({ activeStandard: 0, spares: 3, idleReady }), NOW)).toMatchObject({ target: 1, retire: ['40', '50'] });
    });
    it('booting reservations do not permit retiring the sole usable ready host',()=>{
        const d=demand({spares:2,ready:1,vcpuInUse:4,idleReady:[{poolHostId:'ready',readyAt:ago(31)}],booting:[{poolHostId:'boot',createdAt:ago(1)}]});
        expect(planPool(c,d,NOW)).toMatchObject({target:1,provision:0,retire:[]});
    });
    it('zero subscribers keep exactly the one base-class floor spare; larger classes none', () => {
        expect(planPool(c, demand({activeStandard:0, activePremium:0, opens15m:100, vcpuInUse:20}), NOW))
            .toEqual({target:1, provision:1, retire:[], fail:[]});
        expect(planPool({ ...c, instanceType: 'm6i.xlarge' }, demand({activeStandard:0, activePremium:0, opens15m:100}), NOW).target).toBe(0);
        expect(planPool(c, demand({activeStandard:0, activePremium:0, spares:1, vcpuInUse:2, idleReady:[{poolHostId:'f', readyAt: ago(90)}]}), NOW))
            .toEqual({target:1, provision:0, retire:[], fail:[]});
    });
    it.each([2, 4, 5, 10])('pending %i uses shared bounded spares and existing reservations', pending => {
        for (const instanceType of ['m6i.large','m6i.xlarge','m6i.2xlarge'] as const) {
            const key = {...c, instanceType};
            const target = Math.min({ 'm6i.large': 16, 'm6i.xlarge': 8, 'm6i.2xlarge': 4 }[instanceType], pending);
            expect(planPool(key, demand({pending}), NOW)).toMatchObject({target, provision:2});
            expect(planPool(key, demand({pending, spares:target}), NOW).provision).toBe(0);
        }
    });
    it.each(['us-east-1', 'eu-west-1'])('other region %s has zero target', region => {
        expect(planPool({ ...c, region }, demand({ opens15m: 100, activePremium: 100 }), NOW).target).toBe(0);
    });
    it.each(['c6i.xlarge', 't3.medium'])('unsupported class %s has zero target', instanceType => {
        expect(planPool({ ...c, instanceType } as PoolClass, demand({ opens15m: 100 }), NOW).target).toBe(0);
    });
    it('drains at most two excess ready hosts, newest first, strictly older than 30 minutes', () => {
        const d = demand({ spares: 6, idleReady: [60, 31, 30, 45, 0].map(n => ({ poolHostId: String(n), readyAt: ago(n) })) });
        const before = structuredClone(d);
        expect(planPool(c, d, NOW)).toEqual({ target: 1, provision: 0, retire: ['31', '45'], fail: [] });
        expect(d).toEqual(before);
    });
    it('never drains more than the excess', () => {
        expect(planPool(c, demand({ spares: 2, idleReady: [45, 60].map(n => ({ poolHostId: String(n), readyAt: ago(n) })) }), NOW).retire).toEqual(['45']);
    });
    it('keeps ready hosts at or below target and at the 30 minute boundary', () => {
        for (const [spares, age] of [[1, 60], [0, 60], [3, 30]]) {
            expect(planPool(c, demand({ spares, idleReady: [{ poolHostId: 'r', readyAt: ago(age) }] }), NOW).retire).toEqual([]);
        }
    });
    it('kill switch immediately drains young ready hosts, newest first and at most two', () => {
        expect(planPool(c, demand({ killSwitch: true, spares: 3, idleReady: [2, 0, 1].map(n => ({ poolHostId: String(n), readyAt: ago(n) })) }), NOW))
            .toEqual({ target: 0, provision: 0, retire: ['0', '1'], fail: [] });
    });
    it('fails every boot strictly older than ten minutes separately from ready retirement', () => {
        expect(planPool(c, demand({ spares: 5, booting: [9, 10, 10.001, 11, 12].map(n => ({ poolHostId: String(n), createdAt: ago(n) })) }), NOW).fail)
            .toEqual(['10.001', '11', '12']);
    });
    it.each(['opens15m', 'activeStandard', 'activePremium', 'spares', 'vcpuInUse', 'regionVcpuCap'] as const)('rejects invalid %s', field => {
        for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
            expect(() => planPool(c, demand({ [field]: value }), NOW)).toThrow('pool_count_invalid');
        }
    });
    it.each([0, -1, NaN, Infinity])('rejects invalid measured boot time %s', bootMinutes => {
        expect(() => planPool(c, demand({ bootMinutes }), NOW)).toThrow('pool_boot_minutes_invalid');
    });
});

describe('P8 API boundaries and SQL guards (offline structural checks)', () => {
    it('burns only the bound unclaimed lease and releases its tenant binding for pool-retire', async () => {
        const { db, queries } = capture();
        await retireRefusedPoolLease(db, 'host', { computerId: 'computer', instanceId: 'i-pool' });
        expect(queries[0].params).toEqual(['host', 'i-pool', 'computer']);
        expect(queries[0].sql).toContain("SET state = 'retiring', leased_computer_id = NULL");
        expect(queries[0].sql).toContain("AND state = 'leased'");
        for (const column of ['claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial'])
            expect(queries[0].sql).toContain(`${column} IS NULL`);
    });
    it('a lost refusal CAS aborts the placement recovery transaction', async () => {
        await expect(retireRefusedPoolLease(capture([]).db, 'host', { computerId: 'computer', instanceId: 'i-pool' }))
            .rejects.toThrow('pool_refusal_conflict');
    });
    it('maps production string timestamps, bigints and nulls to P8', async () => {
        const { db, queries } = capture();
        expect(await leasePoolHost(db, c, claim.computerId, 2, NOW)).toEqual({ poolHostId: 'host', poolGeneration: 1,
            ...c, instanceId: 'i-pool', state: 'ready', readyAt: NOW, enrolledAt: NOW, leasedComputerId: null,
            leasedAt: null, claimGeneration: null, claimLeaseEpoch: null, claimFence: null, claimVolumeSerial: null });
        expect(queries[0]!.params).toContain(NOW.toISOString());
        expect(queries[0]!.params.some(v => v instanceof Date)).toBe(false);
        expect(await readPoolClaim(capture({ rows: [{ ...raw, claim_generation: '3', claim_lease_epoch: '4',
            claim_fence: 'f', claim_volume_serial: 'v', leased_at: NOW, leased_computer_id: 'c' }] }).db, 'host', 'i-pool'))
            .toMatchObject({ claimGeneration: 3, claimLeaseEpoch: 4, claimFence: 'f', claimVolumeSerial: 'v', leasedAt: NOW, leasedComputerId: 'c' });
    });
    it.each([null, {}, { rows: {} }])('rejects invalid driver results %j', result => {
        return expect(readPoolClaim(capture(result).db, 'host', 'i')).rejects.toThrow('pool_result_invalid');
    });
    it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid generation %s', generation => {
        return expect(readPoolClaim(capture([{ ...raw, generation }]).db, 'host', 'i')).rejects.toThrow();
    });
    it('empty reads and lost lease return null; required CAS writes refuse', async () => {
        const { db } = capture([]);
        expect(await leasePoolHost(db, c, 'computer', 1, NOW)).toBeNull();
        expect(await readPoolClaim(db, 'host', 'i')).toBeNull();
        expect(await markPoolHost(db, 'host', ['ready'], 'retiring', NOW)).toBeNull();
        await expect(recordPoolEnrollment(db, 'host', 'i', NOW)).rejects.toThrow('pool_state_conflict');
        await expect(recordPoolReady(db, 'host', { editorOk: true }, NOW)).rejects.toThrow('pool_state_conflict');
        await expect(publishPoolClaim(db, 'host', claim, NOW)).rejects.toThrow('pool_state_conflict');
    });
    it.each([{ ...c, region: 'bad' }, { ...c, zoneId: '' }, { ...c, instanceType: 'c6i.xlarge' }])('rejects unsupported lease/demand class %j', async invalid => {
        const { db, queries } = capture();
        await expect(leasePoolHost(db, invalid as PoolClass, 'computer', 1, NOW)).rejects.toThrow('pool_class_invalid');
        await expect(readPoolDemand(db, invalid as PoolClass, NOW)).rejects.toThrow('pool_class_invalid');
        expect(queries).toEqual([]);
    });

    it.each([0, 3, undefined])('rejects invalid priority %s before SQL', async priority => {
        const { db, queries } = capture();
        await expect(leasePoolHost(db, c, 'computer', priority as 1, NOW)).rejects.toThrow('pool_priority_invalid');
        expect(queries).toEqual([]);
    });
    it('refuses unhealthy readiness, empty identity and incomplete claims before SQL', async () => {
        const { db, queries } = capture();
        await expect(recordPoolReady(db, 'h', { editorOk: false }, NOW)).rejects.toThrow('pool_editor_unhealthy');
        await expect(recordPoolEnrollment(db, 'h', '', NOW)).rejects.toThrow('pool_instance_invalid');
        for (const patch of [{ generation: 0 }, { leaseEpoch: 0 }, { fence: '' }, { volumeSerial: '' }])
            await expect(publishPoolClaim(db, 'h', { ...claim, ...patch }, NOW)).rejects.toThrow();
        expect(queries).toEqual([]);
    });
    it.each([['booting', 'failed'], ['booting', 'retiring'], ['ready', 'retiring'], ['leased', 'retiring'],
        ['failed', 'retiring'], ['retiring', 'retiring'], ['retiring', 'retired']] as [PoolHostState, PoolHostState][])('permits mark %s -> %s', async (from, to) => {
        const { db, queries } = capture();
        expect(await markPoolHost(db, 'h', [from], to, NOW)).not.toBeNull();
        expect(queries[0]!.params).toEqual([to, NOW.toISOString(), 'h', from]);
    });
    it('generic marks cannot enter ready/leased, resurrect, skip retirement or ignore expected state', async () => {
        const { db, queries } = capture();
        const states: PoolHostState[] = ['booting', 'ready', 'leased', 'retiring', 'retired', 'failed'];
        for (const to of ['booting', 'ready', 'leased'] as const) expect(await markPoolHost(db, 'h', states, to, NOW)).toBeNull();
        for (const to of states) expect(await markPoolHost(db, 'h', ['retired'], to, NOW)).toBeNull();
        expect(await markPoolHost(db, 'h', ['ready', 'leased'], 'retired', NOW)).toBeNull();
        expect(await markPoolHost(db, 'h', [], 'retiring', NOW)).toBeNull();
        expect(queries).toEqual([]);
        await markPoolHost(db, 'h', ['retired', 'ready'], 'retiring', NOW);
        expect(queries[0]!.params).toEqual(['retiring', NOW.toISOString(), 'h', 'ready']);
        expect(queries[0]!.sql).toContain('AND state IN (');
    });
    it('lease retains every clean-host predicate, zone, priority and SKIP LOCKED', async () => {
        const { db, queries } = capture(); await leasePoolHost(db, c, 'computer', 2, NOW);
        const query = queries[0]!;
        for (const fragment of ["state = 'ready'", "health = 'healthy'", 'instance_id IS NOT NULL', 'editor_ready_at IS NOT NULL',
            'editor_ready_at <=', 'ready_at IS NOT NULL', 'ready_at <=', "enrolled_at >", "interval '10 minutes'", 'enrolled_at <=',
            'generation > 0', 'generation <=', 'leased_computer_id IS NULL', 'leased_at IS NULL', 'leased_generation IS NULL', 'lease_token IS NULL',
            'region =', 'zone_id =', 'instance_type =', 'ORDER BY pool_priority DESC, ready_at ASC, id ASC', 'FOR UPDATE SKIP LOCKED LIMIT 1'])
            expect(query.sql).toContain(fragment);
        expect(query.sql).toMatch(/enrolled_at > \$\d+::timestamptz - interval '10 minutes'/);
        expect(query.sql).toMatch(/enrolled_at <= \$\d+::timestamptz/);
        expect(query.params).toEqual(['computer', NOW.toISOString(), 2, NOW.toISOString(), c.region, c.zoneId, c.instanceType,
            NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), Number.MAX_SAFE_INTEGER]);
    });
    it('enrollment and ready writes keep identity, state, lease and freshness predicates', async () => {
        const { db, queries } = capture();
        await recordPoolEnrollment(db, 'h', 'i', NOW); await recordPoolReady(db, 'h', { editorOk: true }, NOW);
        for (const query of queries) for (const fragment of ["state IN ('booting', 'ready')", 'leased_computer_id IS NULL', 'leased_at IS NULL'])
            expect(query.sql).toContain(fragment);
        expect(queries[0]!.sql).toContain('(instance_id IS NULL OR instance_id =');
        expect(queries[1]!.sql).toMatch(/enrolled_at > \$\d+::timestamptz - interval '10 minutes'/);
        expect(queries[1]!.sql).toMatch(/enrolled_at <= \$\d+::timestamptz/);
        for (const fragment of ['instance_id IS NOT NULL', 'enrolled_at >', "interval '10 minutes'", 'enrolled_at <=',
            'ready_at = COALESCE(ready_at,', 'editor_ready_at = COALESCE(editor_ready_at,']) expect(queries[1]!.sql).toContain(fragment);
    });
    it('claim publication binds the holder and is immutable; claim reads bind identity and completeness', async () => {
        const { db, queries } = capture(); await publishPoolClaim(db, 'h', claim, NOW); await readPoolClaim(db, 'h', 'i');
        for (const fragment of ["state = 'leased'", 'leased_computer_id =', '((claim_generation IS NULL AND claim_lease_epoch IS NULL AND claim_fence IS NULL AND claim_volume_serial IS NULL) OR (claim_generation =',
            'AND claim_lease_epoch =', 'AND claim_fence =', 'AND claim_volume_serial =']) expect(queries[0]!.sql).toContain(fragment);
        for (const fragment of ['instance_id =', "state = 'leased'", 'leased_computer_id IS NOT NULL', 'claim_generation IS NOT NULL',
            'claim_lease_epoch IS NOT NULL', 'claim_fence IS NOT NULL', 'claim_volume_serial IS NOT NULL']) expect(queries[1]!.sql).toContain(fragment);
    });
});

describe('readPoolDemand', () => {
    afterEach(() => vi.unstubAllEnvs());
    const aggregate = { opens: '7', standard: '25', premium: '3', boot_minutes: '4.5', spares: '2', vcpu: '8',
        idle_ready: [{ poolHostId: 'r', readyAt: NOW.toISOString() }], booting: [{ poolHostId: 'b', createdAt: NOW.toISOString() }] };
    it('maps the single snapshot and uses existing regional cap units and exact kill switch', async () => {
        vi.stubEnv('AWS_REGIONS', 'ap-south-1'); vi.stubEnv('EZIL_AWS_MAX_RUNNING_AP_SOUTH_1', '5');
        for (const kill of ['1', '0', 'true', undefined]) {
            vi.stubEnv('EZIL_AWS_KILL_SWITCH', kill);
            expect(await readPoolDemand(capture([aggregate]).db, c, NOW)).toEqual({ ready: 0, pending: 0, opens15m: 7, activeStandard: 25, activePremium: 3,
                bootMinutes: 4.5, spares: 2, vcpuInUse: 8, regionVcpuCap: 10, killSwitch: kill === '1',
                idleReady: [{ poolHostId: 'r', readyAt: NOW }], booting: [{ poolHostId: 'b', createdAt: NOW }], demandVcpu: 0, earmarked: [] });
        }
    });
    it('unknown measurements stay null and missing/unconfigured/invalid region capacity is zero', async () => {
        vi.stubEnv('AWS_REGIONS', 'us-east-1'); vi.stubEnv('EZIL_AWS_MAX_RUNNING_US_EAST_1', '5');
        expect(await readPoolDemand(capture([{ ...aggregate, boot_minutes: null }]).db, c, NOW)).toMatchObject({ bootMinutes: null, regionVcpuCap: 0 });
        vi.stubEnv('AWS_REGIONS', 'ap-south-1'); vi.stubEnv('EZIL_AWS_MAX_RUNNING_AP_SOUTH_1', 'bad');
        expect((await readPoolDemand(capture([aggregate]).db, c, NOW)).regionVcpuCap).toBe(0);
    });
    it('refuses missing snapshot', () => expect(readPoolDemand(capture([]).db, c, NOW)).rejects.toThrow('pool_demand_missing'));
    it('queries authoritative tables and guarded demand windows without counting polls or duplicate joins', async () => {
        const { db, queries } = capture([aggregate]); await readPoolDemand(db, c, NOW);
        expect(queries).toHaveLength(1);
        for (const fragment of ['public.ezil_billing_compute_epochs', 'public.ezil_billing_subscriptions', 'public.ezil_computer_placements',
            'public.ezil_compute_pool_hosts', 'DISTINCT ON (s.user_id)', "status = 'active'", 'current_period_start <=', 'current_period_end >',
            'current_period_end DESC', "state NOT IN ('RETIRED', 'PURGE_ELIGIBLE')", "provider = 'aws-ec2'", 'region =', 'zone_id =', 'instance_type =',
            'e.size =', 'count(DISTINCT e.id)', 's.user_id = e.user_id', 'p.owner_user_id = e.user_id',
            "s.sku IN ('standard_monthly_v3', 'premium_monthly_v3')", 'e.ready_at >', 'e.ready_at <=', "interval '15 minutes'",
            "s.sku = 'standard_monthly_v3'", "sku = 'premium_monthly_v3'", 'p.owner_user_id = s.user_id',
            'percentile_cont(0.9)', "interval '24 hours'", 'ready_at <=', 'ready_at > created_at', "state = 'booting' OR",
            'OR region IS NULL', "h.state <> 'retired'", 'NOT EXISTS (SELECT 1 FROM live_placements', 'p.instance_id = h.instance_id',
            'p.computer_id = h.leased_computer_id AND p.instance_id IS NULL', "state = 'ready' AND leased_at IS NULL AND leased_computer_id IS NULL AND ready_at IS NOT NULL",
            "state = 'booting'", 'ELSE 8 END']) expect(queries[0]!.sql).toContain(fragment);
        expect(queries[0]!.params.some(v => v instanceof Date)).toBe(false);
    });
});

describe('readPoolReadinessDiagnostics', () => {
    it('lists slow enrolled and unenrolled hosts with health using only a class-scoped read', async () => {
        const { db, queries } = capture([
            { ...raw, id: 'enrolled', created_at: ago(6), enrolled_at: ago(5), health: 'unknown' },
            { ...raw, id: 'unenrolled', instance_id: null, created_at: ago(7), enrolled_at: null, health: 'unhealthy' },
        ]);
        expect(await readPoolReadinessDiagnostics(db, c, NOW)).toEqual([
            { poolHostId: 'enrolled', instanceId: 'i-pool', createdAt: ago(6).toISOString(), enrolledAt: ago(5).toISOString(), health: 'unknown' },
            { poolHostId: 'unenrolled', instanceId: null, createdAt: ago(7).toISOString(), enrolledAt: null, health: 'unhealthy' },
        ]);
        expect(queries).toHaveLength(1);
        expect(queries[0].sql).toMatch(/^SELECT id, instance_id, created_at, enrolled_at, health FROM/);
        expect(queries[0].sql).toContain("AND state = 'booting' AND ready_at IS NULL");
        expect(queries[0].sql).toMatch(/created_at < \$4::timestamptz - interval '5 minutes'/);
        expect(queries[0].sql).toContain('WHERE region = $1 AND zone_id = $2 AND instance_type = $3');
        expect(queries[0].params).toEqual([c.region, c.zoneId, c.instanceType, NOW.toISOString()]);
    });
    it('returns no warning for an empty slow-host query', async () => {
        expect(await readPoolReadinessDiagnostics(capture([]).db, c, NOW)).toEqual([]);
    });
});
