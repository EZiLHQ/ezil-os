import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { releasedPoolSetup } from './aws-rebase.test-support';
import { reconcileFailedRelease, type ReconcileReleaseDeps, type ReconcileReleaseRequest } from './aws-pool-release-recovery';
import { POOL_RELEASED } from './aws-receipts';
import { ImageJobConflictError, type PlacementDb, type PlacementExecutor } from './placement';

afterEach(() => vi.restoreAllMocks());
const OTHER = '99999999-9999-4999-8999-999999999999', dialect = new PgDialect();
/** Evaluate actual WHERE predicates; unknown SQL fails instead of silently implementing its intended filter. */
function matches(text: string, params: unknown[], row: Record<string, unknown>): boolean {
    return text.split('WHERE ')[1]!.split(/ LIMIT | RETURNING /)[0]!.split(/\s+AND\s+/).every(term => {
        term = term.trim();
        let m = /^(\w+) = \$(\d+)(?:::\w+)?$/.exec(term);
        if (m) return row[m[1]!] === params[Number(m[2]) - 1];
        m = /^(\w+) = '([^']+)'$/.exec(term); if (m) return row[m[1]!] === m[2];
        m = /^(\w+) = (\w+)$/.exec(term); if (m) return row[m[1]!] === row[m[2]!];
        m = /^(\w+) IS NOT NULL$/.exec(term); if (m) return row[m[1]!] != null;
        m = /^(\w+) IN \('([^']+)', '([^']+)'\)$/.exec(term); if (m) return [m[2], m[3]].includes(row[m[1]!] as string);
        throw new Error('unsupported pool predicate: ' + term);
    });
}
function setup() {
    const s = releasedPoolSetup({ shared: true });
    const deployment = { ...s.provisioned, namespace: 'mum', stateMachineVersionArn: s.provisioned.stateMachineVersionArn.replace('ezil-pilot-', 'ezil-mum-'),
        preparationStateMachineVersionArn: s.provisioned.preparationStateMachineVersionArn!.replace('ezil-pilot-', 'ezil-mum-'),
        recoveryStateMachineVersionArn: s.provisioned.recoveryStateMachineVersionArn!.replace('ezil-pilot-', 'ezil-mum-') };
    const provisionArn = s.setProvision(deployment), releaseArn = s.setRelease({ deployment }), p = s.fake.placements[0]!;
    Object.assign(p, { last_error: POOL_RELEASED });
    Object.assign(s.row, { state: 'leased', leased_generation: s.row.generation, lease_token: OTHER,
        leased_at: '2026-10-22 09:00:00+00', updated_at: '2026-10-22 10:01:00.123456+00' });
    Object.assign(s.provider.volume, { zoneId: deployment.zoneId, volumeType: 'gp3' });
    Object.assign(s.provider.volume.tags, { 'ezil:stage': deployment.namespace, 'ezil:backup': deployment.namespace });
    const poolStatements: { sql: string; params: unknown[] }[] = [];
    let writer = false, forward = false, reverse = false, refuseCas = false;
    const wrap = (tx: PlacementExecutor): PlacementExecutor => ({ execute: async (q: SQL) => {
        const rendered = dialect.sqlToQuery(q), text = rendered.sql.replace(/\s+/g, ' ').trim();
        if (text.startsWith('/* moves:lock-computer */')) return { rows: [{ isolation: 'read committed' }] };
        if (text.startsWith('SELECT 1 AS busy FROM public.ezil_compute_migrations')) return { rows: forward ? [{ busy: 1 }] : [] };
        if (text === "SELECT to_regclass('public.ezil_compute_reverse_moves') IS NOT NULL AS present") return { rows: [{ present: reverse }] };
        if (text.startsWith('SELECT 1 AS held FROM public.ezil_compute_reverse_moves')) return { rows: reverse ? [{ held: 1 }] : [] };
        if (reverse && text.startsWith('SELECT') && text.includes('FROM public.ezil_compute_reverse_moves') && text.includes('FOR UPDATE')) return { rows: [] };
        if (text === "SELECT to_regclass('public.ezil_compute_writer_leases') IS NOT NULL AS present") return { rows: [{ present: writer }] };
        if (text.startsWith('/* pool:completed-release-writer */')) return { rows: writer ? [{ held: 1 }] : [] };
        if (text.startsWith('/* pool:completed-release-')) {
            poolStatements.push(rendered);
            const rows = s.fake.poolHosts.filter(row => matches(text, rendered.params, row)).slice(0, 2);
            if (text.startsWith('/* pool:completed-release-read */')) return { rows: rows.map(row => ({
                id: row.id, generation: String(row.generation), region: row.region, zone_id: row.zone_id, instance_type: row.instance_type,
                instance_id: row.instance_id, state: row.state, leased_computer_id: row.leased_computer_id,
                leased_generation: row.leased_generation, leased_at: row.leased_at, allocation_token: row.lease_token,
                claim_generation: row.claim_generation, claim_lease_epoch: row.claim_lease_epoch, claim_fence: row.claim_fence,
                claim_volume_serial: row.claim_volume_serial, lifecycle_job_id: row.lifecycle_job_id,
                lifecycle_digest: row.lifecycle_digest, lifecycle_input: row.lifecycle_input, claim_updated_at: row.updated_at,
            })) };
            if (refuseCas) return { rows: [] };
            for (const row of rows) Object.assign(row, { state: 'retired', updated_at: '2026-10-22 12:00:00+00' });
            return { rows: rows.map(row => ({ id: row.id })) };
        }
        return tx.execute(q);
    } });
    const db: PlacementDb = { execute: q => wrap(s.fake.db).execute(q), transaction: fn => s.fake.db.transaction(tx => fn(wrap(tx))) };
    const deps: ReconcileReleaseDeps = { db, starter: s.deps.starter, executions: s.deps.executions, describer: s.deps.describer, now: s.deps.now };
    const request: ReconcileReleaseRequest = { schemaVersion: 1, operation: 'reconcile-release', computerId: s.source.computerId,
        expectedJobId: s.release().intent.jobId, releaseExecutionArn: releaseArn };
    const run = () => reconcileFailedRelease(deps, { [deployment.region]: deployment }, request);
    return { ...s, p, deployment, request, deps, run, releaseArn, provisionArn, poolStatements,
        holdWriter: () => { writer = true; }, holdForward: () => { forward = true; }, holdReverse: () => { reverse = true; }, refuseCas: () => { refuseCas = true; } };
}
type Setup = ReturnType<typeof setup>;
const noWrite = (s: Setup) => {
    expect(s.fake.poolHosts[0]!.state).toBe('leased'); expect(s.started).toHaveLength(0);
    expect(s.poolStatements.filter(q => q.sql.includes('completed-release-retire'))).toHaveLength(0);
};

describe('normal reconcile-release completes stale pool claim bookkeeping', () => {
    it('proves the actual claim and retirement, preserves every placement/provider field, and is idempotent', async () => {
        const s = setup(), placement = structuredClone(s.p), volume = structuredClone(s.provider.volume), claim = structuredClone(s.row);
        expect(await s.run()).toEqual({ outcome: 'settled', error: null });
        expect(s.row).toEqual({ ...claim, state: 'retired', updated_at: '2026-10-22 12:00:00+00' });
        expect(s.p).toEqual(placement); expect(s.provider.volume).toEqual(volume); expect(s.started).toHaveLength(0);
        expect(s.deps.executions.history).toHaveBeenCalledWith(s.deployment.region, s.releaseArn);
        expect(await s.run()).toEqual({ outcome: 'settled', error: null });
        expect(s.poolStatements.filter(q => q.sql.includes('completed-release-retire'))).toHaveLength(1);
    });
    it.each([
        ['expected job differs', (s: Setup) => { s.request.expectedJobId = OTHER; }, 'source_not_proven'],
        ['foreign machine', (s: Setup) => { s.request.releaseExecutionArn = s.releaseArn.replace('ezil-mum-', 'ezil-other-'); }, 'source_not_proven'],
        ['no history reader', (s: Setup) => { s.deps.executions.history = undefined; }, 'not_applicable'],
        ['foreign owner', (s: Setup) => { s.p.owner_user_id = OTHER; }, 'not_applicable'],
        ['not pool released', (s: Setup) => { s.p.last_error = null; }, 'not_applicable'],
        ['current job present', (s: Setup) => { s.p.lifecycle_job_id = OTHER; }, 'not_applicable'],
        ['enrollment authority', (s: Setup) => { s.p.enroll_nonce_hash = 'a'.repeat(64); }, 'not_applicable'],
        ['forward migration', (s: Setup) => s.holdForward(), 'not_applicable'],
        ['reverse migration', (s: Setup) => s.holdReverse(), 'not_applicable'],
        ['writer lease', (s: Setup) => s.holdWriter(), 'not_applicable'],
    ] as const)('%s refuses before provider reads', async (_label, edit, outcome) => {
        const s = setup(); edit(s); expect((await s.run()).outcome).toBe(outcome); noWrite(s);
        expect(s.deps.executions.describe).not.toHaveBeenCalled();
    });
    it('image reservations conflict before proof or writes', async () => {
        const s = setup(); s.p.image_upgrade_job_id = OTHER;
        await expect(s.run()).rejects.toBeInstanceOf(ImageJobConflictError); noWrite(s);
    });
    it.each([
        ['instance_id', 'i-99999999999999999'], ['leased_computer_id', OTHER], ['region', 'us-east-1'], ['zone_id', 'aps1-az2'],
        ['instance_type', 'm6i.xlarge'], ['claim_generation', 99], ['claim_lease_epoch', 99], ['claim_fence', OTHER],
        ['claim_volume_serial', 'vol99999999999999999'], ['leased_generation', 99], ['lease_token', null],
        ['state', 'retiring'], ['state', 'ready'], ['dispatch_status', 'started'], ['lifecycle_input', null],
    ])('refuses nonmatching claim %s=%s', async (key, value) => {
        const s = setup(); s.row[key] = value; expect((await s.run()).outcome).toBe('not_applicable');
        expect(s.deps.executions.describe).not.toHaveBeenCalled();
        expect(s.poolStatements.some(q => q.sql.includes('completed-release-retire'))).toBe(false);
    });
    it('duplicate matching allocations are ambiguous', async () => {
        const s = setup(); s.fake.poolHosts.push({ ...s.row, id: OTHER });
        await expect(s.run()).rejects.toThrow('pool_completed_release_conflict'); noWrite(s);
    });
    it.each([
        ['failed retirement', (s: Setup) => { s.executions.get(s.releaseArn)!.status = 'FAILED'; }],
        ['redriven retirement', (s: Setup) => { s.executions.get(s.releaseArn)!.redriveCount = 1; }],
        ['aliased retirement', (s: Setup) => { s.executions.get(s.releaseArn)!.stateMachineAliasArn = 'alias'; }],
        ['different version', (s: Setup) => { s.executions.get(s.releaseArn)!.stateMachineVersionArn += '0'; }],
        ['truncated history', (s: Setup) => { s.histories.get(s.releaseArn)!.pop(); }],
        ['shutting-down only', (s: Setup) => { s.setRelease({ deployment: s.deployment }, {}, { Code: 32, Name: 'shutting-down' }); }],
        ['wrong generation', (s: Setup) => { s.setRelease({ deployment: s.deployment, targetGeneration: 9 }); }],
        ['changed provision bytes', (s: Setup) => { s.row.lifecycle_input += ' '; }],
        ['failed provision', (s: Setup) => { s.executions.get(s.provisionArn)!.status = 'FAILED'; }],
    ] as const)('%s is not retirement proof', async (_label, edit) => {
        const s = setup(); edit(s); expect((await s.run()).outcome).toBe('source_not_proven'); noWrite(s);
    });
    it.each([
        ['listed source', (s: Setup) => { s.provider.host = s.terminatedHost(); }],
        ['attachment', (s: Setup) => { s.provider.volume.attachments = [{ instanceId: s.source.sourceInstanceId, state: 'attached' }]; }],
        ['in-use disk', (s: Setup) => { s.provider.volume.state = 'in-use'; }],
        ['wrong zone', (s: Setup) => { Object.assign(s.provider.volume, { zoneId: 'aps1-az2' }); }],
        ['unencrypted disk', (s: Setup) => { s.provider.volume.encrypted = false; }],
        ['wrong key', (s: Setup) => { s.provider.volume.kmsKeyId += '0'; }],
        ['gp2', (s: Setup) => { Object.assign(s.provider.volume, { volumeType: 'gp2' }); }],
        ['small disk', (s: Setup) => { s.provider.volume.sizeGiB = 1; }],
        ['no canonical owner', (s: Setup) => { Reflect.deleteProperty(s.provider.volume.tags, 'ezil:computer-id'); }],
        ['foreign fence alias', (s: Setup) => { Object.assign(s.provider.volume.tags, { 'ezil:fence': OTHER }); }],
        ['no backup namespace', (s: Setup) => { Reflect.deleteProperty(s.provider.volume.tags, 'ezil:backup'); }],
        ['pool marker', (s: Setup) => { Object.assign(s.provider.volume.tags, { 'ezil:pool': 'mum' }); }],
    ] as const)('%s preserves claim and all data', async (_label, edit) => {
        const s = setup(); edit(s); expect((await s.run()).outcome).toBe('unconfirmed'); noWrite(s);
    });
    it.each([
        ['epoch', (s: Setup) => { s.p.lease_epoch = 99; }],
        ['placement timestamp', (s: Setup) => { s.p.updated_at = new Date('2026-10-22T12:00:01Z'); }],
        ['owner', (s: Setup) => { s.p.owner_user_id = OTHER; }],
        ['claim timestamp microsecond', (s: Setup) => { s.row.updated_at = '2026-10-22 10:01:00.123457+00'; }],
        ['lease token', (s: Setup) => { s.row.lease_token = '88888888-8888-4888-8888-888888888888'; }],
        ['provision digest', (s: Setup) => { s.row.lifecycle_digest = '0'.repeat(64); }],
        ['new writer', (s: Setup) => s.holdWriter()], ['new migration', (s: Setup) => s.holdForward()], ['new reverse migration', (s: Setup) => s.holdReverse()],
    ] as const)('concurrent %s change loses the locked CAS', async (_label, edit) => {
        const s = setup(), describe = vi.mocked(s.deps.describer!.describeVolume!).getMockImplementation()!;
        vi.mocked(s.deps.describer!.describeVolume!).mockImplementation(async (...args) => { const v = await describe(...args); edit(s); return v; });
        expect(await s.run()).toEqual({ outcome: 'unconfirmed', error: 'allocation_changed' }); noWrite(s);
    });
    it('simultaneous repairs have one writer and safe idempotent retry', async () => {
        const s = setup(), results = await Promise.all([s.run(), s.run()]);
        expect(results.some(r => r.outcome === 'settled')).toBe(true);
        expect(s.poolStatements.filter(q => q.sql.includes('completed-release-retire'))).toHaveLength(1);
        expect((await s.run()).outcome).toBe('settled'); expect(s.started).toHaveLength(0);
    });
    it('a zero-row final allocation CAS reports uncertainty without another write', async () => {
        const s = setup(), placement = structuredClone(s.p); s.refuseCas();
        expect(await s.run()).toEqual({ outcome: 'unconfirmed', error: 'allocation_changed' });
        expect(s.p).toEqual(placement); expect(s.row.state).toBe('leased'); expect(s.started).toHaveLength(0);
        expect(s.poolStatements.filter(q => q.sql.includes('completed-release-retire'))).toHaveLength(1);
    });
});
