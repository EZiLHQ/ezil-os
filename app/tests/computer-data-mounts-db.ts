import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { dataMountComputer, type MountComputer } from './fixtures/data-mount';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const reject = (run: () => Promise<unknown>, code = '23514') => assert.rejects(run, (e: { code?: string }) => e.code === code);
const create = async (c: MountComputer, changes: Record<string, unknown> = {}) => {
    const values = { computer_id: c.computerId, computer_generation: c.generation, lifecycle_job_id: c.jobId,
        fence_token: c.fence, provider_instance_id: c.instance, data_volume_id: c.volume, filesystem_uuid: c.filesystemUuid,
        mode: c.operation === 'provision' ? 'initialize' : 'mount', provider_observed_at: new Date(), ...changes };
    const [row] = await sql`INSERT INTO ezil_computer_data_mount_authorizations ${sql(values)} RETURNING *`;
    return row!;
};
const receipt = (a: Awaited<ReturnType<typeof create>>) => ({ schemaVersion: 1, authorizationId: a.id,
    scope: { computerId: a.computer_id, computerGeneration: a.computer_generation, fenceToken: a.fence_token,
        providerInstanceId: a.provider_instance_id, dataVolumeId: a.data_volume_id }, digest: a.digest, state: 'mounted',
    computerId: a.computer_id, volumeId: a.data_volume_id, filesystemUuid: a.filesystem_uuid });
const claim = (id: string) => sql`UPDATE ezil_computer_data_mount_deliveries SET attempts=attempts+1,lease_until=now()+interval '30 seconds' WHERE authorization_id=${id}`;
try {
    await test('grant freezes canonical plan, database digest and deadline and atomically enqueues delivery', async () => {
        const c = await dataMountComputer(sql), a = await create(c, { digest: 'forged', issued_at: new Date(0), expires_at: new Date(0) });
        const [row] = await sql`SELECT ezil_data_mount_plan(a) plan FROM ezil_computer_data_mount_authorizations a WHERE id=${a.id}`;
        assert.equal(row!.plan, JSON.stringify({ computerId: c.computerId, filesystemUuid: c.filesystemUuid,
            mode: 'initialize', schemaVersion: 1, volumeId: c.volume }));
        assert.equal(a.digest, createHash('sha256').update(row!.plan).digest('hex'));
        assert.equal(a.expires_at - a.issued_at, 900000); assert.equal(a.issued_at.getTime() % 1000, 0);
        const [q] = await sql`SELECT * FROM ezil_computer_data_mount_deliveries WHERE authorization_id=${a.id}`;
        assert.equal(q!.attempts, 0); assert.equal(q!.mounted_at, null);
    });
    await test('starts and replacements receive mount only; cross-computer and disk/UUID/writer substitutions fail', async () => {
        for (const operation of ['start', 'replace'] as const) {
            const c = await dataMountComputer(sql, operation);
            await reject(() => create(c, { mode: 'initialize' }));
            assert.equal((await create(c)).mode, 'mount');
        }
        const c = await dataMountComputer(sql), other = await dataMountComputer(sql);
        for (const changes of [{ computer_id: other.computerId }, { lifecycle_job_id: other.jobId }, { computer_generation: 9 },
            { filesystem_uuid: other.filesystemUuid }, { data_volume_id: other.volume }, { provider_instance_id: other.instance }, { fence_token: other.fence }]) {
            await reject(() => create(c, changes));
        }
    });
    await test('unsuccessful jobs, stale observations and noncurrent owners/writers cannot grant authority', async () => {
        for (const reason of ['failed', 'stale', 'fenced', 'stopped', 'deleted', 'owner', 'unknown']) {
            const c = await dataMountComputer(sql, 'provision', reason === 'failed' ? 'failed' : 'succeeded');
            if (reason === 'fenced') await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
            if (reason === 'stopped') await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
            if (reason === 'deleted') await sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${c.computerId}`;
            if (reason === 'owner') await sql`UPDATE ezil_computer_lifecycle_jobs SET requested_by=NULL WHERE id=${c.jobId}`;
            await reject(() => create(c, reason === 'stale' ? { provider_observed_at: new Date(Date.now() - 31000) }
                : reason === 'unknown' ? { filesystem_uuid: randomUUID() } : {}));
        }
    });
    await test('recovery of a failed writer retains the UUID and can only authorize mounting', async () => {
        const source = await dataMountComputer(sql, 'provision', 'failed');
        await sql`UPDATE ezil_computer_lifecycle_jobs SET error_code='lifecycle_recovered' WHERE id=${source.jobId}`;
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped',fenced_at=now() WHERE computer_id=${source.computerId}`;
        const [pin] = await sql`SELECT digest FROM ezil_computer_lifecycle_intents WHERE job_id=${source.jobId}`;
        const c: MountComputer = { ...source, operation: 'recover', jobId: randomUUID(), generation: 2,
            fence: randomUUID(), instance: `i-${randomUUID().replaceAll('-', '').slice(0, 17)}` };
        await sql.begin(async tx => {
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
                VALUES (${c.jobId},${c.computerId},${c.userId},'recover',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${c.jobId},${c.computerId})`;
            await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
                revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
                VALUES (${c.jobId},${c.computerId},${source.jobId},1,${pin!.digest},2,2,${c.fence},${c.volume},1,${source.fence},${JSON.stringify(deployment)})`;
            await tx`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at)
                VALUES (${c.computerId},2,${c.instance},${c.fence},'running',now())`;
            await tx`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE id=${c.jobId}`;
            await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${c.jobId}`;
        });
        await reject(() => create(c, { mode: 'initialize' }));
        const grant = await create(c); assert.equal(grant.mode, 'mount'); assert.equal(grant.filesystem_uuid, source.filesystemUuid);
    });
    await test('concurrent issue creates one grant/outbox and revocation cannot renew or clear an initialization grant', async () => {
        const c = await dataMountComputer(sql);
        const results = await Promise.allSettled([create(c), create(c)]);
        assert.equal(results.filter(v => v.status === 'fulfilled').length, 1);
        const a = (await sql`SELECT * FROM ezil_computer_data_mount_authorizations WHERE computer_id=${c.computerId}`)[0]!;
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_data_mount_deliveries WHERE authorization_id=${a.id}`)[0]!.n, 1);
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${a.id}`;
        await reject(() => sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=NULL WHERE id=${a.id}`);
        await reject(() => sql`UPDATE ezil_computer_data_mount_authorizations SET expires_at=expires_at+interval '15 minutes' WHERE id=${a.id}`);
        await reject(() => create(c), '23505');
    });
    await test('rollback leaves neither grant nor queue row and preserves source intent bytes', async () => {
        const c = await dataMountComputer(sql), marker = new Error('rollback');
        const before = (await sql`SELECT digest,ezil_lifecycle_intent_document(i) body FROM ezil_computer_lifecycle_intents i WHERE job_id=${c.jobId}`)[0]!;
        await assert.rejects(sql.begin(async tx => {
            await tx`INSERT INTO ezil_computer_data_mount_authorizations(computer_id,computer_generation,lifecycle_job_id,fence_token,
                provider_instance_id,data_volume_id,filesystem_uuid,mode,provider_observed_at)
                VALUES (${c.computerId},1,${c.jobId},${c.fence},${c.instance},${c.volume},${c.filesystemUuid},'initialize',now())`;
            throw marker;
        }), e => e === marker);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_data_mount_authorizations WHERE computer_id=${c.computerId}`)[0]!.n, 0);
        assert.deepEqual((await sql`SELECT digest,ezil_lifecycle_intent_document(i) body FROM ezil_computer_lifecycle_intents i WHERE job_id=${c.jobId}`)[0], before);
        await create(c);
    });
    await test('mounted receipts require a lease, exact identity and current authority, and cannot be rewritten', async () => {
        const c = await dataMountComputer(sql), a = await create(c), body = JSON.stringify(receipt(a));
        const settle = (value = body) => sql`UPDATE ezil_computer_data_mount_deliveries SET mounted_at=now(),receipt=${value} WHERE authorization_id=${a.id}`;
        await reject(() => settle()); await claim(a.id);
        await sql`UPDATE ezil_computer_data_mount_deliveries SET lease_until=now()-interval '1 second' WHERE authorization_id=${a.id}`;
        await reject(() => settle()); await claim(a.id);
        await reject(() => settle(JSON.stringify({ ...receipt(a), filesystemUuid: randomUUID() })));
        await settle();
        await reject(() => sql`UPDATE ezil_computer_data_mount_deliveries SET receipt=NULL,mounted_at=NULL WHERE authorization_id=${a.id}`);
        await reject(() => sql`DELETE FROM ezil_computer_data_mount_deliveries WHERE authorization_id=${a.id}`);
        await reject(() => sql`DELETE FROM ezil_computer_data_mount_authorizations WHERE id=${a.id}`);
    });
    await test('revocation, stop intent and writer changes prevent late receipt acceptance', async () => {
        for (const reason of ['revoke', 'stop', 'writer', 'later']) {
            const c = await dataMountComputer(sql), a = await create(c); await claim(a.id);
            if (reason === 'revoke') await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${a.id}`;
            if (reason === 'stop') await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
            if (reason === 'writer') await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
            if (reason === 'later') await sql`INSERT INTO ezil_computer_lifecycle_jobs(computer_id,requested_by,operation,idempotency_key)
                VALUES (${c.computerId},${c.userId},'stop',${randomUUID()})`;
            await reject(() => sql`UPDATE ezil_computer_data_mount_deliveries SET mounted_at=now(),receipt=${JSON.stringify(receipt(a))} WHERE authorization_id=${a.id}`);
        }
    });
    await test('authenticated owners have no direct table access; scoped service role can read grants', async () => {
        const c = await dataMountComputer(sql), a = await create(c);
        await sql.begin(async tx => {
            await tx`GRANT ALL ON ezil_computer_data_mount_authorizations,ezil_computer_data_mount_deliveries TO authenticated,service_role`;
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${c.userId},true)`;
            assert.equal((await tx`SELECT * FROM ezil_computer_data_mount_authorizations`).length, 0);
            assert.equal((await tx`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${a.id} RETURNING id`).length, 0);
            await tx`SET LOCAL ROLE service_role`; await tx`SELECT set_config('request.jwt.claim.role','service_role',true)`;
            assert.equal((await tx`SELECT * FROM ezil_computer_data_mount_authorizations WHERE id=${a.id}`).length, 1);
        });
    });
    console.log(`PASS ${passed} mount authorization database checks`);
} finally { await fixture.close(); }
