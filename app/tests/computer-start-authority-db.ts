import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import type { Sql, TransactionSql } from 'postgres';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { dataMountComputer, type MountComputer } from './fixtures/data-mount';
import { ageConfigurationMount, recordConfigurationMount, restartConfigurationComputer } from './fixtures/configuration-mount';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';

const fixture = await runtimeTestDatabase({ throughMigration: '0011_computer_data_mount_authority' }), { sql } = fixture;
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const reject = (run: () => Promise<unknown>, code = '23514') => assert.rejects(run, (e: { code?: string }) => e.code === code);
type Query = Sql | TransactionSql;
async function configuration(c: MountComputer, revision = 1, prepared = true, suspended = false) {
    return sql.begin(async tx => {
        const body = { schemaVersion: 1, computerId: c.computerId, computerGeneration: c.generation, configurationRevision: revision,
            volumeId: c.volume, dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts',
            controlPort: 8181, memoryBudgetMiB: 3072, suspended, preparedInstallations: [], approvedInstallations: [] };
        const [row] = await tx`INSERT INTO ezil_computer_configurations(computer_id,computer_generation,revision,provider_instance_id,
            fence_token,data_volume_id,configuration) VALUES (${c.computerId},${c.generation},${revision},${c.instance},${c.fence},${c.volume},${JSON.stringify(body)}) RETURNING *`;
        await tx`INSERT INTO ezil_computer_configuration_deliveries(configuration_id,prepared_at) VALUES (${row!.id},${prepared ? new Date() : null})`;
        return row!;
    });
}
const bindingValues = (c: MountComputer, mount: string) => ({ computer_id: c.computerId, computer_generation: c.generation,
    creation_mount_id: mount, fence_token: c.fence, provider_instance_id: c.instance, data_volume_id: c.volume,
    account_id: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
    control_domain: 'control.example.com', kms_key_arn: deployment.dataKeyArn });
async function binding(c: MountComputer, mount: string, changes: Record<string, unknown> = {}, db: Query = sql) {
    return (await db`INSERT INTO ezil_computer_control_bindings ${db({ ...bindingValues(c, mount), ...changes })} RETURNING *`)[0]!;
}
const secretArn = (b: Awaited<ReturnType<typeof binding>>) => `arn:aws:secretsmanager:${b.region}:${b.account_id}:secret:${b.namespace}/computers/${b.computer_id}/generations/${b.computer_generation}/control-Ab12Cd`;
async function confirmKey(b: Awaited<ReturnType<typeof binding>>) {
    // Simulated AWS evidence only; production issuance must inspect the real
    // pinned version and persist the attempt BEFORE any CreateSecret request.
    await sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=now() WHERE id=${b.id}`;
    return (await sql`UPDATE ezil_computer_control_bindings SET key_confirmed_at=now(),secret_arn=${secretArn(b)} WHERE id=${b.id} RETURNING *`)[0]!;
}
async function target(options: { prepared?: boolean; suspended?: boolean; keyReady?: boolean } = {}) {
    const c = await dataMountComputer(sql), config = await configuration(c, 1, options.prepared, options.suspended);
    const mount = await recordConfigurationMount(sql, c), reserved = await binding(c, mount);
    const key = options.keyReady === false ? reserved : await confirmKey(reserved);
    return { c, config, mount, key };
}
type Target = Awaited<ReturnType<typeof target>>;
const grantValues = (t: Target) => ({ computer_id: t.c.computerId, computer_generation: t.c.generation,
    control_binding_id: t.key.id, configuration_id: t.config.id, mount_authorization_id: t.mount, provider_observed_at: new Date() });
async function grant(t: Target, changes: Record<string, unknown> = {}, db: Query = sql) {
    return (await db`INSERT INTO ezil_computer_start_authorizations ${db({ ...grantValues(t), ...changes })} RETURNING *`)[0]!;
}
const receipt = (t: Target, id: string) => ({ schemaVersion: 1, authorizationId: id, state: 'started',
    scope: { computerId: t.c.computerId, computerGeneration: t.c.generation, fenceToken: t.c.fence,
        providerInstanceId: t.c.instance, dataVolumeId: t.c.volume },
    descriptor: { computerId: t.c.computerId, computerGeneration: t.c.generation,
        configurationRevision: t.config.revision, configurationDigest: t.config.digest } });
const claim = (id: string) => sql`UPDATE ezil_computer_start_deliveries SET attempts=attempts+1,lease_until=clock_timestamp()+interval '30 seconds' WHERE authorization_id=${id}`;
const settle = (t: Target, id: string, value: unknown = receipt(t, id), db: Query = sql) => db`UPDATE ezil_computer_start_deliveries
    SET started_at=now(),receipt=${JSON.stringify(value)} WHERE authorization_id=${id} RETURNING *`;
async function expire(id: string) {
    // Simulate time passing only in this disposable DB; production history is immutable.
    await sql.begin(async tx => {
        await tx`ALTER TABLE ezil_computer_start_authorizations DISABLE TRIGGER ezil_start_authority_write_trg`;
        await tx`UPDATE ezil_computer_start_authorizations SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
            provider_observed_at=provider_observed_at-interval '1 hour' WHERE id=${id}`;
        await tx`ALTER TABLE ezil_computer_start_authorizations ENABLE TRIGGER ezil_start_authority_write_trg`;
    });
}
try {
    await test('additive upgrade preserves existing writer, configuration and mounted-disk history', async () => {
        const c = await dataMountComputer(sql), config = await configuration(c), mount = await recordConfigurationMount(sql, c);
        const existing = () => sql`SELECT to_jsonb(c) computer,to_jsonb(r) runtime,to_jsonb(w) writer,
            to_jsonb(a) mount,to_jsonb(d) receipt,to_jsonb(s) configuration FROM ezil_computers c
            JOIN ezil_computer_runtimes r ON r.computer_id=c.id JOIN ezil_computer_instances w ON w.computer_id=c.id
            JOIN ezil_computer_data_mount_authorizations a ON a.id=${mount}
            JOIN ezil_computer_data_mount_deliveries d ON d.authorization_id=a.id
            JOIN ezil_computer_configurations s ON s.id=${config.id} WHERE c.id=${c.computerId}`;
        const before = await existing();
        const migration = await readFile(new URL('../drizzle/0012_computer_start_authority.sql', import.meta.url), 'utf8');
        await sql.begin(async tx => {
            for (const statement of migration.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement);
        });
        assert.deepEqual([...(await existing())], [...before]);
        assert.equal((await sql`SELECT * FROM ezil_computer_control_bindings`).length, 0);
        await grant({ c, config, mount, key: await confirmKey(await binding(c, mount)) });
    });
    await test('control references require completed mount and exact deployment/writer scope', async () => {
        const c = await dataMountComputer(sql), other = await dataMountComputer(sql);
        await reject(() => binding(c, randomUUID()));
        const [mount] = await sql`INSERT INTO ezil_computer_data_mount_authorizations(computer_id,computer_generation,lifecycle_job_id,
            fence_token,provider_instance_id,data_volume_id,filesystem_uuid,mode,provider_observed_at)
            VALUES (${c.computerId},${c.generation},${c.jobId},${c.fence},${c.instance},${c.volume},${c.filesystemUuid},'initialize',now()) RETURNING id`;
        await reject(() => binding(c, mount!.id));
        const completed = await recordConfigurationMount(sql, other);
        for (const changes of [{ computer_id: c.computerId }, { computer_generation: 9 }, { fence_token: randomUUID() },
            { provider_instance_id: c.instance }, { data_volume_id: c.volume }, { account_id: '999999999999' }, { namespace: 'other' },
            { region: 'us-west-2' }, { control_domain: 'https://control.example.com' }, { kms_key_arn: 'alias/master' },
            { revoked_at: new Date() }]) await reject(() => binding(other, completed, changes));
        const b = await binding(other, completed, { created_at: new Date(0) });
        assert.ok(b.created_at.getTime() > Date.now() - 5000);
        assert.equal(b.creation_mount_id, completed);
    });
    await test('a key reference alone cannot authorize startup; initial attempts and receipts cannot be forged', async () => {
        const t = await target({ keyReady: false });
        await reject(() => grant(t));
        const c = await dataMountComputer(sql), mount = await recordConfigurationMount(sql, c);
        for (const changes of [{ create_attempted_at: new Date() }, { key_confirmed_at: new Date(), secret_arn: secretArn(t.key) }]) {
            await reject(() => binding(c, mount, changes));
        }
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET key_confirmed_at=now(),secret_arn=${secretArn(t.key)} WHERE id=${t.key.id}`);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=now(),key_confirmed_at=now(),secret_arn=${secretArn(t.key)} WHERE id=${t.key.id}`);
        t.key = await confirmKey(t.key); await grant(t);
    });
    await test('a persisted creation attempt can be claimed only once, including concurrent workers', async () => {
        const t = await target({ keyReady: false });
        const claim = () => sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=${new Date(0)}
            WHERE id=${t.key.id} AND create_attempted_at IS NULL RETURNING *`;
        const claimed = (await Promise.all([claim(), claim()])).flat(); assert.equal(claimed.length, 1);
        assert.ok(claimed[0]!.create_attempted_at.getTime() > Date.now() - 5000);
        assert.equal((await claim()).length, 0);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=NULL WHERE id=${t.key.id}`);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=clock_timestamp() WHERE id=${t.key.id}`);
        await reject(() => grant(t));
    });
    await test('key confirmation binds the exact ARN, is timestamped by SQL and remains immutable', async () => {
        const t = await target({ keyReady: false });
        await sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=now() WHERE id=${t.key.id}`;
        for (const arn of [secretArn(t.key).replace(t.c.computerId, randomUUID()), secretArn(t.key).replace('/generations/1/', '/generations/2/'),
            secretArn(t.key).replace(deployment.accountId, '999999999999'), secretArn(t.key).replace('/control-', '/other-')]) {
            await reject(() => sql`UPDATE ezil_computer_control_bindings SET key_confirmed_at=now(),secret_arn=${arn} WHERE id=${t.key.id}`);
        }
        const [key] = await sql`UPDATE ezil_computer_control_bindings SET key_confirmed_at=${new Date(0)},secret_arn=${secretArn(t.key)} WHERE id=${t.key.id} RETURNING *`;
        assert.ok(key!.key_confirmed_at >= key!.create_attempted_at);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET secret_arn=${secretArn(t.key).replace('Ab12Cd', 'Ef34Gh')} WHERE id=${t.key.id}`);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET key_confirmed_at=NULL,secret_arn=NULL WHERE id=${t.key.id}`);
        await sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE id=${t.key.id}`;
        assert.equal((await sql`SELECT secret_arn FROM ezil_computer_control_bindings WHERE id=${t.key.id}`)[0]!.secret_arn, secretArn(t.key));
    });
    await test('revocation blocks new creation attempts and late key confirmation', async () => {
        for (const attempted of [false, true]) {
            const t = await target({ keyReady: false });
            if (attempted) await sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=now() WHERE id=${t.key.id}`;
            await sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE id=${t.key.id}`;
            if (!attempted) await reject(() => sql`UPDATE ezil_computer_control_bindings SET create_attempted_at=now() WHERE id=${t.key.id}`);
            await reject(() => sql`UPDATE ezil_computer_control_bindings SET key_confirmed_at=now(),secret_arn=${secretArn(t.key)} WHERE id=${t.key.id}`);
        }
    });
    await test('control references are immutable and terminal revocation cannot rotate the same writer key', async () => {
        const t = await target();
        for (const changes of [{ id: randomUUID() }, { creation_mount_id: randomUUID() }, { fence_token: randomUUID() },
            { control_domain: 'other.example.com' }, { namespace: 'other' }, { kms_key_arn: deployment.dataKeyArn.replace('11111111-', '22222222-') },
            { created_at: new Date(0) }]) {
            await reject(() => sql`UPDATE ezil_computer_control_bindings SET ${sql(changes)} WHERE id=${t.key.id}`);
        }
        await reject(() => binding(t.c, t.mount), '23505');
        const [revoked] = await sql`UPDATE ezil_computer_control_bindings SET revoked_at=${new Date(0)} WHERE id=${t.key.id} RETURNING revoked_at`;
        assert.ok(revoked!.revoked_at.getTime() > Date.now() - 5000);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET revoked_at=NULL WHERE id=${t.key.id}`);
        await reject(() => sql`UPDATE ezil_computer_control_bindings SET revoked_at=clock_timestamp() WHERE id=${t.key.id}`);
        await reject(() => binding(t.c, t.mount), '23505'); await reject(() => grant(t));
    });
    await test('database sets five-minute grant lifetime and atomically enqueues without claiming readiness', async () => {
        const t = await target(), a = await grant(t, { issued_at: new Date(0), expires_at: new Date(0) });
        assert.equal(a.expires_at - a.issued_at, 300000); assert.equal(a.issued_at.getTime() % 1000, 0);
        assert.ok(a.issued_at.getTime() > Date.now() - 5000);
        const [q] = await sql`SELECT * FROM ezil_computer_start_deliveries WHERE authorization_id=${a.id}`;
        assert.equal(q!.attempts, 0); assert.equal(q!.started_at, null); assert.equal(q!.receipt, null);
        assert.equal((await sql`SELECT loaded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${t.config.id}`)[0]!.loaded_at, null);
    });
    await test('start requires latest prepared unsuspended configuration and exact computer/key/mount', async () => {
        const t = await target({ prepared: false }), other = await target();
        await reject(() => grant(t));
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${t.config.id}`;
        for (const changes of [{ computer_id: other.c.computerId }, { computer_generation: 9 }, { control_binding_id: other.key.id },
            { configuration_id: other.config.id }, { mount_authorization_id: other.mount }, { mount_authorization_id: randomUUID() },
            { control_binding_id: randomUUID() }, { configuration_id: randomUUID() }]) await reject(() => grant(t, changes));
        const next = await configuration(t.c, 2, false);
        await reject(() => grant(t)); await reject(() => grant({ ...t, config: next }));
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now(),superseded_at=now() WHERE configuration_id=${next.id}`;
        await reject(() => grant({ ...t, config: next }));
        const suspended = await target({ suspended: true }); await reject(() => grant(suspended));
    });
    await test('grant scope and times are immutable; revocation is terminal; provider observations are bounded', async () => {
        const t = await target();
        for (const changes of [{ provider_observed_at: new Date(Date.now() - 60000) }, { provider_observed_at: new Date(Date.now() + 60000) },
            { revoked_at: new Date() }]) await reject(() => grant(t, changes));
        const a = await grant(t);
        for (const changes of [{ configuration_id: randomUUID() }, { control_binding_id: randomUUID() }, { mount_authorization_id: randomUUID() },
            { expires_at: new Date(Date.now() + 3600000) }, { issued_at: new Date() }, { provider_observed_at: new Date(0) }]) {
            await reject(() => sql`UPDATE ezil_computer_start_authorizations SET ${sql(changes)} WHERE id=${a.id}`);
        }
        await sql`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${a.id}`;
        await reject(() => sql`UPDATE ezil_computer_start_authorizations SET revoked_at=NULL WHERE id=${a.id}`);
        await reject(() => sql`UPDATE ezil_computer_start_authorizations SET revoked_at=clock_timestamp() WHERE id=${a.id}`);
        assert.notEqual((await grant(t)).id, a.id);
    });
    await test('same-generation restart rejects old mount but reuses key with a freshly completed mount', async () => {
        const t = await target(), a = await grant(t); await claim(a.id); await settle(t, a.id);
        const c = await restartConfigurationComputer(sql, t.c);
        await sql`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${a.id}`;
        await reject(() => grant(t));
        const mount = await recordConfigurationMount(sql, c), restarted = { ...t, c, mount };
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${t.mount}`;
        const next = await grant(restarted); assert.equal(next.control_binding_id, t.key.id);
        await claim(next.id); await settle(restarted, next.id);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_control_bindings WHERE computer_id=${c.computerId}`)[0]!.n, 1);
    });
    await test('accepted mount outlives execution deadline but expired startup grants cannot renew through leases', async () => {
        const t = await target(); await ageConfigurationMount(sql, t.mount);
        const a = await grant(t); await claim(a.id); await expire(a.id);
        await reject(() => settle(t, a.id)); await claim(a.id); await reject(() => settle(t, a.id));
        await reject(() => grant(t), '23505');
    });
    await test('revoked/current-scope changes block both new grants and late startup receipts', async () => {
        const invalidate: Record<string, (t: Target) => Promise<unknown>> = {
            mount: t => sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${t.mount}`,
            key: t => sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE id=${t.key.id}`,
            stopped: t => sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${t.c.computerId}`,
            writer: t => sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${t.c.computerId}`,
            observed: t => sql`UPDATE ezil_computer_instances SET observed_state='stopped' WHERE computer_id=${t.c.computerId}`,
            later: t => sql`INSERT INTO ezil_computer_lifecycle_jobs(computer_id,requested_by,operation,idempotency_key)
                VALUES (${t.c.computerId},${t.c.userId},'stop',${randomUUID()})`,
            config: t => configuration(t.c, 2),
            owner: t => sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${t.c.computerId}`,
        };
        for (const change of Object.values(invalidate)) {
            const t = await target(), a = await grant(t); await claim(a.id); await change(t);
            await reject(() => settle(t, a.id)); await reject(() => grant(t));
        }
        const t = await target(), a = await grant(t); await claim(a.id);
        await sql`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${a.id}`;
        await reject(() => settle(t, a.id));
    });
    await test('receipt requires existing live lease and exact historical host descriptor', async () => {
        const t = await target(), a = await grant(t), value = receipt(t, a.id);
        await reject(() => settle(t, a.id)); await claim(a.id);
        await sql`UPDATE ezil_computer_start_deliveries SET lease_until=now()-interval '1 second' WHERE authorization_id=${a.id}`;
        await reject(() => settle(t, a.id)); await claim(a.id);
        for (const bad of [null, [], { ...value, extra: true }, { ...value, authorizationId: randomUUID() }, { ...value, state: 'running' },
            { ...value, scope: { ...value.scope, computerId: randomUUID() } }, { ...value, scope: { ...value.scope, fenceToken: randomUUID() } },
            { ...value, scope: { ...value.scope, providerInstanceId: 'i-11111111111111111' } },
            { ...value, descriptor: { ...value.descriptor, configurationRevision: 2 } },
            { ...value, descriptor: { ...value.descriptor, configurationDigest: '0'.repeat(64) } }]) await reject(() => settle(t, a.id, bad));
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET started_at=now(),receipt='invalid json sentinel' WHERE authorization_id=${a.id}`);
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET attempts=attempts+1,started_at=now(),receipt=${JSON.stringify(value)} WHERE authorization_id=${a.id}`);
        const [done] = await settle(t, a.id);
        assert.deepEqual(JSON.parse(done!.receipt), value); assert.equal(done!.lease_until, null);
        await expire(a.id);
        await sql`UPDATE ezil_computer_start_deliveries SET receipt=receipt WHERE authorization_id=${a.id}`;
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET receipt=NULL,started_at=NULL WHERE authorization_id=${a.id}`);
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET available_at=clock_timestamp() WHERE authorization_id=${a.id}`);
    });
    await test('queue cannot be seeded completed, skip attempts or record unredacted errors', async () => {
        const t = await target(), a = await grant(t);
        await reject(() => sql`INSERT INTO ezil_computer_start_deliveries(authorization_id,started_at,receipt) VALUES (${a.id},now(),'{}')`);
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET attempts=attempts+2 WHERE authorization_id=${a.id}`);
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET lease_until=now() WHERE authorization_id=${a.id}`);
        await claim(a.id);
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET attempts=0 WHERE authorization_id=${a.id}`);
        await reject(() => sql`UPDATE ezil_computer_start_deliveries SET error_code='secret value here' WHERE authorization_id=${a.id}`);
        await sql`UPDATE ezil_computer_start_deliveries SET error_code='host_unavailable' WHERE authorization_id=${a.id}`;
    });
    await test('concurrent grants serialize to one authorization and one event; rolled-back work leaves neither', async () => {
        const t = await target(), results = await Promise.allSettled([grant(t), grant(t)]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        const failed = results.find(r => r.status === 'rejected'); assert.equal(failed?.status === 'rejected' && failed.reason.code, '23505');
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_start_deliveries d JOIN ezil_computer_start_authorizations a ON a.id=d.authorization_id
            WHERE a.computer_id=${t.c.computerId}`)[0]!.n, 1);
        const other = await target(), rolledBack = randomUUID();
        await assert.rejects(sql.begin(async tx => { await grant(other, { id: rolledBack }, tx); throw new Error('rollback fixture'); }), /rollback fixture/);
        assert.equal((await sql`SELECT * FROM ezil_computer_start_deliveries WHERE authorization_id=${rolledBack}`).length, 0);
        assert.equal((await sql`SELECT * FROM ezil_computer_start_authorizations WHERE id=${rolledBack}`).length, 0);
        await grant(other, { id: rolledBack });
    });
    await test('accepted receipt holds mount/key/grant/writer authority against concurrent revocation until commit', async () => {
        const t = await target(), a = await grant(t); await claim(a.id);
        await sql.begin(async tx => {
            await tx`SELECT id FROM ezil_computers WHERE id=${t.c.computerId} FOR UPDATE`;
            await settle(t, a.id, receipt(t, a.id), tx);
            for (const [table, column, id] of [['ezil_computer_data_mount_authorizations', 'id', t.mount],
                ['ezil_computer_control_bindings', 'id', t.key.id], ['ezil_computer_start_authorizations', 'id', a.id]]) {
                await reject(() => sql.begin(async other => {
                    await other`SET LOCAL lock_timeout='100ms'`;
                    await other`UPDATE ${other(table!)} SET revoked_at=now() WHERE ${other(column!)}=${id!}`;
                }), '55P03');
            }
            for (const write of [
                (other: TransactionSql) => other`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${t.c.computerId}`,
                (other: TransactionSql) => other`UPDATE ezil_computer_configuration_deliveries SET superseded_at=now() WHERE configuration_id=${t.config.id}`,
            ]) await reject(() => sql.begin(async other => {
                await other`SET LOCAL lock_timeout='100ms'`; await write(other);
            }), '55P03');
        });
        await sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE id=${t.key.id}`;
        assert.equal((await sql`SELECT started_at FROM ezil_computer_start_deliveries WHERE authorization_id=${a.id}`)[0]!.started_at !== null, true);
    });
    await test('issuance waiting on lifecycle lock rereads committed mount/key revocation', async () => {
        for (const [table, field] of [['ezil_computer_control_bindings', 'key'], ['ezil_computer_data_mount_authorizations', 'mount']] as const) {
            const t = await target();
            let pending!: Promise<unknown>;
            await sql.begin(async tx => {
                const [held] = await tx`SELECT pg_backend_pid() pid FROM ezil_computers WHERE id=${t.c.computerId} FOR UPDATE`;
                pending = reject(() => grant(t));
                const deadline = Date.now() + 3000;
                let blocked = false;
                while (Date.now() < deadline) {
                    const [wait] = await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                        WHERE ${held!.pid} = ANY(pg_blocking_pids(pid))) blocked`;
                    if (wait!.blocked) { blocked = true; break; }
                    await delay(10);
                }
                assert.equal(blocked, true, 'concurrent issuance must actually wait on the lifecycle lock');
                await tx`UPDATE ${tx(table)} SET revoked_at=now() WHERE id=${field === 'key' ? t.key.id : t.mount}`;
            });
            await pending;
        }
    });
    await test('delete/truncate cannot erase startup authority or delivery history', async () => {
        for (const table of ['ezil_computer_start_deliveries', 'ezil_computer_start_authorizations', 'ezil_computer_control_bindings']) {
            await reject(() => sql`DELETE FROM ${sql(table)}`);
            await reject(() => sql`TRUNCATE ${sql(table)} CASCADE`);
        }
    });
    await test('authenticated owners cannot read or mutate tables; service role retains constrained access', async () => {
        const t = await target(), a = await grant(t);
        const tables = ['ezil_computer_control_bindings', 'ezil_computer_start_authorizations', 'ezil_computer_start_deliveries'];
        await sql.begin(async tx => {
            for (const table of tables) await tx`GRANT ALL ON ${tx(table)} TO authenticated,service_role`;
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${t.c.userId},true)`;
            for (const table of tables) assert.equal((await tx`SELECT * FROM ${tx(table)}`).length, 0);
            assert.equal((await tx`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${a.id} RETURNING id`).length, 0);
            await tx`RESET ROLE`;
            await tx`GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role`;
            await tx`SET LOCAL ROLE service_role`; await tx`SELECT set_config('request.jwt.claim.role','service_role',true)`;
            assert.equal((await tx`SELECT * FROM ezil_computer_control_bindings WHERE id=${t.key.id}`).length, 1);
            assert.equal((await tx`SELECT * FROM ezil_computer_start_deliveries WHERE authorization_id=${a.id}`).length, 1);
            assert.equal((await tx`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${a.id} RETURNING id`).length, 1);
            const renewed = await grant(t, {}, tx);
            assert.notEqual(renewed.id, a.id);
        });
        await reject(() => sql.begin(async tx => {
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true)`;
            await tx`INSERT INTO ezil_computer_start_deliveries(authorization_id) VALUES (${randomUUID()})`;
        }), '42501');
    });
    console.log(`PASS ${passed} computer startup authority database checks`);
} finally { await fixture.close(); }
