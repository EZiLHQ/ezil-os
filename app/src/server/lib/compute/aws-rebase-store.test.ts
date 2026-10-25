import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { IMAGE_JOB_NEXT, IMAGE_JOB_PHASES, newReservedImageJob, parseImageJobRow, validateImageJob } from './aws-rebase-store';
import { parseRebaseRelease } from './aws-rebase-release';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { assertNoImageReservation, readPlacement, transitionPlacement } from './placement';
import { leasePoolHost } from './ready-pool';
import { rebaseSetup } from './aws-rebase.test-support';

const p = fixtureRebasePreparation();
const repository = '123456789012.dkr.ecr.ap-south-1.amazonaws.com/desktop';
const make = () => newReservedImageJob({ preparation: p, ownerUserId: '33333333-3333-4333-8333-333333333333',
    sourceRelease: fixtureRebaseRelease(p.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(p.intent.deployment) });
const rowOf = (j: ReturnType<typeof make>) => Object.fromEntries(Object.entries(j).map(([k, v]) => [k.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), v]));

describe('image job store and release read contracts', () => {
    it('reserves explicitly with retention and the precomputed execution identity, without a nonce', () => {
        const j = make();
        expect(j.phase).toBe('reserved'); expect(j.retentionHold).toBe(true);
        expect(j.preparationExecutionArn).toBe(p.executionArn);
        expect(JSON.stringify(j)).not.toMatch(/nonce|userData/);
        expect(parseImageJobRow(rowOf(j))).toEqual(j);
    });
    it('pins all SQL columns in model order and uses only the contract indexes and RLS', () => {
        const ddl = readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql/0002_image_rebase.sql.txt'), 'utf8');
        const columns = ddl.split('CREATE TABLE public.ezil_computer_image_jobs (')[1]!.split('\n);')[0]!
            .trim().split('\n').map(l => l.trim().split(' ')[0]);
        expect(Object.keys(rowOf(make()))).toEqual(columns);
        expect(ddl.match(/CREATE INDEX /g)).toHaveLength(4);
        expect(ddl).not.toMatch(/PRIMARY KEY|UNIQUE|REFERENCES|DEFAULT|CREATE POLICY|GRANT |TRIGGER/);
        expect(ddl).toContain('REVOKE ALL ON TABLE public.ezil_computer_image_jobs FROM public, anon, authenticated;');
        expect(ddl).toContain('ALTER TABLE public.ezil_computer_image_jobs ENABLE ROW LEVEL SECURITY;');
    });
    it('release and evidence binds survive postgres-js serialization as JSON objects or SQL NULL', async () => {
        const s = rebaseSetup();
        expect((await s.run('prepare')).status).toBe(202);
        await s.completePreparation();
        expect((await s.run('launch')).status).toBe(202);
        const j = await s.current();
        // Construct the driver for its actual codecs only; never open a socket.
        const client = postgres({ host: '127.0.0.1', database: 'unused', username: 'unused', password: 'unused' });
        try {
            const serialized: unknown[] = [];
            for (const statement of s.fake.statements.filter(q => /^(INSERT INTO|UPDATE) public\.ezil_computer_image_jobs/.test(q.sql))) {
                for (const match of statement.sql.matchAll(/\$(\d+)::(text::)?jsonb/g)) {
                    const value = statement.params[Number(match[1]) - 1];
                    // PostgreSQL describes the first cast's OID to the driver.
                    const oid = match[2] ? 25 : 3802;
                    serialized.push(value === null ? null : JSON.parse(String(client.options.serializers[oid]!(value))));
                }
            }
            expect(serialized).toContainEqual(j.sourceRelease);
            expect(serialized).toContainEqual(j.targetRelease);
            expect(serialized).toContainEqual(j.snapshotEvidence);
            expect(serialized).toContain(null);
            expect(serialized.every(value => value === null || typeof value === 'object')).toBe(true);
        } finally { await client.end(); }
    });
    it('rejects double-encoded JSONB instead of silently accepting corrupt release data', () => {
        const j = make();
        expect(() => parseImageJobRow({ ...rowOf(j), source_release: JSON.stringify(j.sourceRelease) })).toThrow();
        expect(() => parseImageJobRow({ ...rowOf(j), target_release: JSON.stringify(j.targetRelease) })).toThrow();
    });
    it.each([
        { sourceGeneration: '1' }, { sourceLeaseEpoch: true }, { sourceGeneration: 2147483648 }, { phase: 'running' },
        { failureCode: 'provider private message' }, { retentionHold: 'true' }, { region: 'us-east-1' },
        { sourceVolumeId: 'vol-22222222222222222' }, { preparationDigest: 'f'.repeat(64) }, { targetGeneration: 2 },
        { snapshotId: 'snap-11111111111111111' }, { phase: 'snapshot_ready' }, { phase: 'failed' }, { phase: 'unconfirmed' },
        { hostEvidence: { nonce: 'forbidden' } }, { createdAt: '2026-02-30T12:00:00.000Z' }, { unexpected: true },
    ])('refuses malformed/inconsistent stored data #%#', patch => {
        expect(() => validateImageJob({ ...make(), ...patch })).toThrow();
    });
    it('accepts only the declared PostgreSQL bigint representation', () => {
        const row = rowOf(make()); row.source_generation = '1'; row.source_lease_epoch = '3';
        expect(parseImageJobRow(row).sourceGeneration).toBe(1);
        for (const value of ['01', '1.0', '1e0', '2147483648', false]) {
            expect(() => parseImageJobRow({ ...row, source_generation: value })).toThrow();
        }
        expect(() => parseImageJobRow({ ...row, unknown_column: null })).toThrow();
    });
    it('keeps all phases closed, with terminal states having no outgoing edges', () => {
        expect(Object.keys(IMAGE_JOB_NEXT)).toEqual(IMAGE_JOB_PHASES);
        for (const next of Object.values(IMAGE_JOB_NEXT)) expect(next.every(phase => IMAGE_JOB_PHASES.includes(phase))).toBe(true);
        for (const phase of ['succeeded', 'recovered', 'cancelled'] as const) expect(IMAGE_JOB_NEXT[phase]).toEqual([]);
        expect(IMAGE_JOB_NEXT.snapshot_pending).not.toContain('launch_pending');
    });
    it('manifest registry hashes need not equal baked IDs; the approved repository must match', () => {
        const r = fixtureRebaseRelease(p.intent.deployment);
        expect(parseRebaseRelease(JSON.stringify(r), p.intent.deployment, repository)).toEqual(r);
        expect(() => parseRebaseRelease(r, p.intent.deployment, repository + '-foreign')).toThrow();
    });
    it.each([
        { recipeVersion: '1073741824.1.0' }, { agentCommit: 'abcdef' }, { namespace: 'ops' }, { extra: true },
        { previousLowerImageRef: null }, { lowerImageRef: repository + ':latest' }, { amiId: 'ami-22222222222222222' },
        { stateMachineVersionArn: p.intent.deployment.stateMachineVersionArn.replace(/:1$/, ':live') },
        { lowerImageRef: '999999999999.dkr.ecr.ap-south-1.amazonaws.com/desktop@sha256:' + 'a'.repeat(64) },
    ])('refuses unreviewed or partial release evidence #%#', patch => {
        expect(() => parseRebaseRelease({ ...fixtureRebaseRelease(p.intent.deployment), ...patch }, p.intent.deployment, repository)).toThrow();
    });
});

describe('ordinary admission respects image reservations', () => {
    it.each(['LEASED', 'DRAINING', 'RETIRING'] as const)('refuses %s and preserves the reserved source', async (to) => {
        const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: p.intent.computerId, state: 'RUNNING',
            image_upgrade_job_id: p.intent.jobId })] });
        await expect(assertNoImageReservation(fake.db, p.intent.computerId)).rejects.toThrow('image_job_conflict');
        await expect(readPlacement(fake.db, p.intent.computerId)).rejects.toThrow('image_job_conflict');
        // The direct CAS path is fenced too, even if a caller retained an old read.
        const result = transitionPlacement(fake.db, { computerId: p.intent.computerId, ownerUserId: String(fake.placements[0]!.owner_user_id),
            expected: { generation: 1, leaseEpoch: 0, state: 'RUNNING' }, to });
        if (to === 'LEASED') expect(await result).toMatchObject({ ok: false });
        else await expect(result).rejects.toThrow('image_job_conflict');
        expect(fake.placements[0]!.state).toBe('RUNNING');
    });
    it('pool adoption takes admission/computer locks and refuses a reserved computer before leasing a host', async () => {
        const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: p.intent.computerId, image_upgrade_job_id: p.intent.jobId })] });
        // This seam handles the new image projection; the reservation query and locks are real fake-DB statements.
        const db = { ...fake.db, transaction: <T>(fn: (tx: import('./placement').PlacementExecutor) => Promise<T>) => fake.db.transaction(tx => fn({ execute: async q => {
            const { PgDialect } = await import('drizzle-orm/pg-core');
            const text = new PgDialect().sqlToQuery(q).sql;
            if (text.includes('placement:image-read')) return { rows: [] };
            return tx.execute(q);
        } })) };
        await expect(import('./placement').then(({ withAdmission, lockImagePlacement }) => withAdmission(db, async (tx, lock) => {
            await lockImagePlacement(tx, lock, p.intent.computerId);
            await assertNoImageReservation(tx, p.intent.computerId);
            return leasePoolHost(tx, { region: 'ap-south-1', zoneId: 'aps1-az1', instanceType: 'm6i.large' }, p.intent.computerId, 1, new Date());
        }))).rejects.toThrow('image_job_conflict');
        expect(fake.statements.some(s => /UPDATE public.ezil_compute_pool_hosts/.test(s.sql))).toBe(false);
    });
});
