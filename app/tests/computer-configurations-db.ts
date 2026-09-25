import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransactionSql } from 'postgres';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { runtimeRecords } from './fixtures/runtime-release';
import { compilePreparedInstallation, compileRuntimePlan } from '../src/server/app-platform/runtime-plan';

const fixture = await runtimeTestDatabase();
const { sql } = fixture;
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`); };
const reject = (fn: () => Promise<unknown>, code = '23514') => assert.rejects(fn, (error: { code?: string }) => error.code === code);
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

try {
    const alice = randomUUID(), bob = randomUUID(), admin = randomUUID();
    await sql`INSERT INTO auth.users (id) VALUES (${alice}),(${bob}),(${admin})`;
    await sql`INSERT INTO ezil_app_admins (user_id) VALUES (${admin})`;
    const [publisher] = await sql`INSERT INTO ezil_app_publishers (owner_user_id,display_name,status,invited_by)
        VALUES (${admin},'Test','active',${admin}) RETURNING id`;
    const records = runtimeRecords('node', { appId: randomUUID(), publisherId: publisher!.id, releaseId: randomUUID() });
    const r = records.release;
    await sql`INSERT INTO ezil_apps (id,publisher_id,slug,name,summary,category)
        VALUES (${records.app.id},${publisher!.id},'notes','Notes','Test','Development')`;
    await sql`INSERT INTO ezil_app_releases
        (id,app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
        VALUES (${r.id},${records.app.id},${r.version},${sql.json(r.manifest as never)},${sql.json(r.policy as never)},
            ${r.manifestDigest},${r.policyDigest},${r.imageReference},${r.provenanceDigest},${r.sourceCommitSha})`;
    await sql`UPDATE ezil_app_releases SET status='validated' WHERE id=${r.id}`;
    await sql`UPDATE ezil_app_releases SET status='approved',approved_by=${admin},approved_at=now() WHERE id=${r.id}`;
    async function computer(user: string) {
        const computerId = randomUUID(), installationId = randomUUID(), fenceToken = randomUUID();
        const volumeId = `vol-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
        const instanceId = `i-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
        await sql`INSERT INTO ezil_computers (id,user_id,slot,provider) VALUES (${computerId},${user},1,'aws-ec2')`;
        await sql`INSERT INTO ezil_computer_runtimes (computer_id,region,availability_zone,data_volume_id)
            VALUES (${computerId},'us-east-1','us-east-1a',${volumeId})`;
        await sql`INSERT INTO ezil_computer_instances (computer_id,generation,provider_instance_id,fence_token)
            VALUES (${computerId},1,${instanceId},${fenceToken})`;
        await sql`INSERT INTO ezil_app_installations (id,computer_id,app_id,release_id,installed_by)
            VALUES (${installationId},${computerId},${records.app.id},${r.id},${user})`;
        const [job] = await sql`INSERT INTO ezil_app_jobs (installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${installationId},${computerId},${user},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox (job_id) VALUES (${job!.id})`;
        return { computerId, installationId, fenceToken, volumeId, instanceId, generation: 1, authGeneration: 1,
            userId: user, installJobId: job!.id as string, records: { ...records, installationId } };
    }
    const a = await computer(alice), b = await computer(bob);
    type Target = typeof a;
    type Options = { omitEvent?: boolean; omitBindings?: boolean; empty?: boolean; runtimeJobId?: string;
        loaded?: boolean; installJobId?: string | null; binding?: Target; config?: Record<string, unknown> };
    const payload = (target: Target, revision: number, options: Options) => ({
        schemaVersion: 1, configurationRevision: revision, computerId: target.computerId, computerGeneration: target.generation,
        volumeId: target.volumeId, dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor',
        stagingRoot: '/run/ezil-supervisor/mounts', controlPort: 8181, memoryBudgetMiB: 3072, suspended: Boolean(options.empty),
        preparedInstallations: options.empty ? [] : [compilePreparedInstallation(target.records)],
        approvedInstallations: options.runtimeJobId ? [{ installationId: target.installationId, plan: compileRuntimePlan(target.records) }] : [],
        ...options.config,
    });
    async function snapshot(tx: TransactionSql, target: Target, revision: number, options: Options = {}) {
        const body = canonical(payload(target, revision, options));
        const [row] = await tx`INSERT INTO ezil_computer_configurations
            (computer_id,computer_generation,revision,provider_instance_id,fence_token,data_volume_id,configuration,digest)
            VALUES (${target.computerId},${target.generation},${revision},${target.instanceId},${target.fenceToken},${target.volumeId},${body},'caller-digest-is-ignored')
            RETURNING id,digest`;
        if (!options.omitEvent) {
            await tx`INSERT INTO ezil_computer_configuration_deliveries (configuration_id,prepared_at,loaded_at,loaded_digest)
                VALUES (${row!.id},${options.loaded ? new Date() : null},${options.loaded ? new Date() : null},${options.loaded ? row!.digest : null})`;
        }
        if (!options.omitBindings && !options.empty) {
            const bound = options.binding ?? target;
            await tx`INSERT INTO ezil_computer_configuration_installations
                (configuration_id,computer_id,installation_id,app_id,release_id,auth_generation,install_job_id,runtime_job_id)
                VALUES (${row!.id},${bound.computerId},${bound.installationId},${records.app.id},${r.id},${bound.authGeneration},
                    ${options.installJobId === undefined ? bound.installJobId : options.installJobId},${options.runtimeJobId ?? null})`;
        }
        assert.equal(row!.digest, hash(body));
        return { id: row!.id as string, digest: row!.digest as string, body };
    }
    type Snapshot = Awaited<ReturnType<typeof snapshot>>;
    const loaded = (row: Snapshot) => sql`UPDATE ezil_computer_configuration_deliveries
        SET prepared_at=coalesce(prepared_at,now()),loaded_at=now(),loaded_digest=${row.digest},lease_until=null
        WHERE configuration_id=${row.id}`;
    async function command(target: Target, generation: number, operation: 'start' | 'stop') {
        return sql.begin(async tx => {
            const [job] = await tx`INSERT INTO ezil_app_jobs (installation_id,computer_id,requested_by,operation,idempotency_key)
                VALUES (${target.installationId},${target.computerId},${target.userId},${operation},${randomUUID()}) RETURNING id`;
            await tx`INSERT INTO ezil_app_outbox (job_id) VALUES (${job!.id})`;
            await tx`INSERT INTO ezil_app_runtime_commands
                (job_id,installation_id,computer_id,app_id,release_id,computer_generation,generation,auth_generation,operation,plan)
                VALUES (${job!.id},${target.installationId},${target.computerId},${records.app.id},${r.id},${target.generation},
                    ${generation},${target.authGeneration},${operation},${tx.json(compileRuntimePlan(target.records) as never)})`;
            return job!.id as string;
        });
    }
    let first!: Snapshot;
    await test('snapshot digest is computed from bytes; membership/event commit without installing or running anything', async () => {
        first = await sql.begin(tx => snapshot(tx, a, 1));
        assert.equal((await sql`SELECT status FROM ezil_app_installations WHERE id=${a.installationId}`)[0]!.status, 'pending');
        assert.equal((await sql`SELECT desired_state FROM ezil_computer_runtimes WHERE computer_id=${a.computerId}`)[0]!.desired_state, 'stopped');
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_runtime_commands`)[0]!.n, 0);
    });
    await test('an incomplete transaction rolls back its revision, bindings and event', async () => {
        await reject(() => sql.begin(tx => snapshot(tx, a, 2, { omitEvent: true })));
        await reject(() => sql.begin(tx => snapshot(tx, a, 2, { omitBindings: true })));
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_configurations`)[0]!.n, 1);
    });
    await test('configuration IDs, generation, disk, unknown fields and null identity cannot drift', async () => {
        for (const config of [{computerId:b.computerId},{computerGeneration:2},{configurationRevision:9},
            {volumeId:b.volumeId},{secret:'sensitive-sentinel'},{computerId:null}]) {
            await reject(() => sql.begin(tx => snapshot(tx, a, 2, { config })));
        }
        for (const target of [{...a,fenceToken:randomUUID()},{...a,instanceId:b.instanceId},{...a,volumeId:b.volumeId}]) {
            await reject(() => sql.begin(tx => snapshot(tx,target,2)));
        }
        await reject(() => sql.begin(tx => snapshot(tx,a,2,{config:{dataRoot:'x'.repeat(262144)}})));
    });
    await test('bindings cannot cross computers, jobs or immutable release bytes', async () => {
        await reject(() => sql.begin(tx => snapshot(tx,a,2,{binding:b})), '23503');
        await reject(() => sql.begin(tx => snapshot(tx,a,2,{installJobId:b.installJobId})), '23503');
        const prepared = compilePreparedInstallation(a.records);
        await reject(() => sql.begin(tx => snapshot(tx,a,2,{config:{preparedInstallations:[{...prepared,image:`x/${prepared.image}`} ]}})));
        await reject(() => sql.begin(tx => snapshot(tx,a,2,{config:{preparedInstallations:[prepared,prepared]}})));
    });
    await test('snapshot content, member links and delivery events cannot be rewritten or deleted', async () => {
        await reject(() => sql`UPDATE ezil_computer_configurations SET configuration='{}' WHERE id=${first.id}`);
        await reject(() => sql`DELETE FROM ezil_computer_configurations WHERE id=${first.id}`);
        await reject(() => sql.unsafe('TRUNCATE ezil_computer_configurations CASCADE'));
        await reject(() => sql`UPDATE ezil_computer_configuration_installations SET auth_generation=9 WHERE configuration_id=${first.id}`);
        await reject(() => sql`DELETE FROM ezil_computer_configuration_installations WHERE configuration_id=${first.id}`);
        await reject(() => sql.unsafe('TRUNCATE ezil_computer_configuration_installations'));
        await reject(() => sql`DELETE FROM ezil_computer_configuration_deliveries WHERE configuration_id=${first.id}`);
        await reject(() => sql.unsafe('TRUNCATE ezil_computer_configuration_deliveries'));
    });
    await test('preparation is distinct from loaded acknowledgement and an incorrect digest fails', async () => {
        await sql`UPDATE ezil_computer_configuration_deliveries SET attempts=1,lease_until=now()+interval '45 seconds',prepared_at=now()
            WHERE configuration_id=${first.id}`;
        assert.equal((await sql`SELECT loaded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${first.id}`)[0]!.loaded_at,null);
        await reject(() => sql`UPDATE ezil_computer_configuration_deliveries SET loaded_at=now(),lease_until=null,loaded_digest=${'f'.repeat(64)}
            WHERE configuration_id=${first.id}`, '23503');
        await loaded(first);
        await reject(() => sql`UPDATE ezil_computer_configuration_deliveries SET loaded_at=null,loaded_digest=null WHERE configuration_id=${first.id}`);
    });
    await test('two independent transactions cannot allocate the same revision; rollback does not consume it', async () => {
        const outcomes = await Promise.allSettled([sql.begin(tx=>snapshot(tx,a,2)),sql.begin(tx=>snapshot(tx,a,2))]);
        assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
        assert.equal((outcomes.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'23514');
        const marker = new Error('rollback');
        await assert.rejects(sql.begin(async tx=>{await snapshot(tx,a,3); throw marker;}),error=>error===marker);
        await reject(()=>sql.begin(tx=>snapshot(tx,a,4)));
        await sql.begin(tx=>snapshot(tx,a,3));
        const [stale] = await sql`SELECT id,digest,configuration body FROM ezil_computer_configurations WHERE computer_id=${a.computerId} AND revision=2`;
        await reject(()=>loaded(stale as Snapshot));
    });
    await test('replacement preserves revision history and denies a receipt from the old writer', async () => {
        const old = await sql.begin(tx=>snapshot(tx,a,4));
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${a.computerId}`;
        await reject(()=>loaded(old));
        await reject(()=>sql.begin(tx=>snapshot(tx,a,5)));
        a.generation=2; a.instanceId=`i-${randomUUID().replaceAll('-','').slice(0,17)}`; a.fenceToken=randomUUID();
        await sql`INSERT INTO ezil_computer_instances (computer_id,generation,provider_instance_id,fence_token)
            VALUES (${a.computerId},2,${a.instanceId},${a.fenceToken})`;
        await reject(()=>sql.begin(tx=>snapshot(tx,a,1)));
        await sql.begin(tx=>snapshot(tx,a,5,{loaded:true}));
    });
    await test('revocation before acknowledgement fails even if the receipt was inserted before bindings', async () => {
        const current=await sql.begin(tx=>snapshot(tx,a,6));
        await sql`UPDATE ezil_app_installations SET auth_generation=2 WHERE id=${a.installationId}`;
        await reject(()=>loaded(current));
        a.authGeneration=2;
        await reject(()=>sql.begin(async tx=>{
            await snapshot(tx,a,7,{loaded:true});
            await tx`UPDATE ezil_app_installations SET auth_generation=3 WHERE id=${a.installationId}`;
        }));
        assert.equal((await sql`SELECT auth_generation FROM ezil_app_installations WHERE id=${a.installationId}`)[0]!.auth_generation,2);
    });
    await test('loaded acknowledgement locks authority through commit against a concurrent raw revocation', async () => {
        const current=await sql.begin(tx=>snapshot(tx,a,7));
        let announce!:()=>void, release!:()=>void;
        const held=new Promise<void>(resolve=>{announce=resolve;});
        const finish=new Promise<void>(resolve=>{release=resolve;});
        const transaction=sql.begin(async tx=>{
            await tx`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now(),loaded_at=now(),loaded_digest=${current.digest}
                WHERE configuration_id=${current.id}`;
            await tx.unsafe('SET CONSTRAINTS ALL IMMEDIATE'); announce(); await finish;
        });
        await Promise.race([held, transaction.then(() => {throw new Error('receipt transaction did not hold its lock');})]);
        let revoked=false;
        const revocation=sql`UPDATE ezil_app_installations /* configuration-revocation-race */
            SET auth_generation=3 WHERE id=${a.installationId}`.then(()=>{revoked=true;});
        try {
            let blocked=false;
            for (let attempt=0;attempt<100;attempt++) {
                const [state]=await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                    AND wait_event_type='Lock' AND query LIKE '%configuration-revocation-race%') blocked`;
                blocked=state!.blocked; if(blocked) break; await delay(20);
            }
            assert.equal(blocked,true,'the second database connection must actually be waiting for the receipt transaction');
            assert.equal(revoked,false);
        } finally {release();}
        await transaction; await revocation; a.authGeneration=3;
    });
    await test('execution membership binds the exact current Start; a newer Stop invalidates its receipt', async () => {
        const start=await command(b,1,'start');
        await reject(()=>sql.begin(tx=>snapshot(tx,b,1,{config:{approvedInstallations:[{installationId:b.installationId,plan:compileRuntimePlan(b.records)}]}})));
        await reject(()=>sql.begin(tx=>snapshot(tx,b,1,{runtimeJobId:start,config:{approvedInstallations:[{installationId:b.installationId,plan:{...compileRuntimePlan(b.records),image:'forged'}}]}})));
        const current=await sql.begin(tx=>snapshot(tx,b,1,{runtimeJobId:start}));
        await command(b,2,'stop');
        await reject(()=>loaded(current));
        await reject(()=>sql.begin(tx=>snapshot(tx,b,2,{runtimeJobId:start})));
    });
    await test('cancelled install jobs cannot be completed through a delayed loaded receipt', async () => {
        const current=await sql.begin(tx=>snapshot(tx,b,2));
        await sql`UPDATE ezil_app_jobs SET status='cancelled',completed_at=now() WHERE id=${b.installJobId}`;
        await reject(()=>loaded(current));
        await sql`UPDATE ezil_computer_configuration_deliveries SET superseded_at=now(),lease_until=null WHERE configuration_id=${current.id}`;
        await reject(()=>loaded(current));
    });
    await test('a revoked release blocks acknowledgement while an empty suspended snapshot remains deliverable', async () => {
        const current=await sql.begin(tx=>snapshot(tx,a,8));
        await sql`UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=${r.id}`;
        await reject(()=>loaded(current));
        await sql.begin(tx=>snapshot(tx,a,9,{empty:true,loaded:true}));
    });
    await test('authenticated owners cannot read or forge configuration receipts; service role can inspect history', async () => {
        await sql.unsafe('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated,service_role');
        await sql.begin(async tx=>{
            await tx.unsafe('SET LOCAL ROLE authenticated');
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${alice},true)`;
            for (const table of ['ezil_computer_configurations','ezil_computer_configuration_installations','ezil_computer_configuration_deliveries']) {
                assert.equal((await tx.unsafe(`SELECT count(*)::int n FROM ${table}`))[0]!.n,0);
            }
            assert.equal((await tx`UPDATE ezil_computer_configuration_deliveries SET attempts=99 WHERE configuration_id=${first.id} RETURNING configuration_id`).length,0);
        });
        await reject(()=>sql.begin(async tx=>{
            await tx.unsafe('SET LOCAL ROLE authenticated');
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true)`;
            await tx`INSERT INTO ezil_computer_configuration_deliveries (configuration_id) VALUES (${randomUUID()})`;
        }),'23503');
        await sql.begin(async tx=>{
            await tx.unsafe('SET LOCAL ROLE service_role');
            await tx`SELECT set_config('request.jwt.claim.role','service_role',true)`;
            assert.ok((await tx`SELECT count(*)::int n FROM ezil_computer_configurations`)[0]!.n>0);
        });
    });
    console.log(`${passed} pass, 0 fail, 0 skip — actual PostgreSQL computer configuration ledger`);
} finally {await fixture.close();}
