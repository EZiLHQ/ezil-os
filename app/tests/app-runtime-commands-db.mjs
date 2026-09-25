// Real transactions and independent connections. Only a uniquely named local
// test database is created/dropped; the supplied database is never migrated.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

const rawUrl = process.env.EZIL_TEST_DATABASE_URL;
if (!rawUrl) throw new Error('EZIL_TEST_DATABASE_URL is required');
const url = new URL(rawUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('EZIL_TEST_DATABASE_URL must target loopback');
}
const databaseName = `ezil_commands_${randomUUID().replaceAll('-', '')}`;
const adminDb = postgres(rawUrl, { max: 1, prepare: false, connect_timeout: 5, onnotice: () => {} });
url.pathname = `/${databaseName}`;
const db = postgres(url.toString(), { max: 4, prepare: false, connect_timeout: 5, onnotice: () => {} });
const alice = randomUUID(), bob = randomUUID(), admin = randomUUID();
const digest = `sha256:${'c'.repeat(64)}`;
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/test@sha256:${'b'.repeat(64)}`;
let created = false;
let passed = 0;
async function test(name, fn) {
    await fn();
    console.log(`PASS ${name}`);
    passed++;
}
const rejects = (fn, code) => assert.rejects(fn, error => error.code === code);

try {
    await adminDb.unsafe(`CREATE DATABASE ${databaseName}`);
    created = true;
    await db.unsafe(`CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
        END $$;
        GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role;`);
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
    await db.begin(async tx => {
        for (const { tag } of journal.entries) {
            const migration = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8');
            for (const part of migration.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
                await tx.unsafe(part);
            }
        }
    });
    await db`INSERT INTO auth.users (id) VALUES (${alice}), (${bob}), (${admin})`;
    await db`INSERT INTO ezil_app_admins (user_id) VALUES (${admin})`;
    const [publisher] = await db`INSERT INTO ezil_app_publishers (owner_user_id,display_name,status,invited_by)
        VALUES (${admin},'Test publisher','active',${admin}) RETURNING id`;
    async function fixture(userId, slug) {
        const [computer] = await db`INSERT INTO ezil_computers (user_id,slot,provider)
            VALUES (${userId},1,'aws-ec2') RETURNING id`;
        await db`INSERT INTO ezil_computer_runtimes (computer_id,region) VALUES (${computer.id},'us-east-1')`;
        await db`INSERT INTO ezil_computer_instances (computer_id,generation) VALUES (${computer.id},1)`;
        const [app] = await db`INSERT INTO ezil_apps (publisher_id,slug,name,summary,category)
            VALUES (${publisher.id},${slug},'Test','Test','Development') RETURNING id`;
        const [release] = await db`INSERT INTO ezil_app_releases
            (app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
            VALUES (${app.id},'1',${db.json({ schemaVersion: 2, source: { kind: 'github', commitSha: 'a'.repeat(40) } })},
                ${db.json({ schemaVersion: 2, image: { reference: image } })},${digest},${digest},${image},${digest},${'a'.repeat(40)})
            RETURNING id`;
        await db`UPDATE ezil_app_releases SET status='validated' WHERE id=${release.id}`;
        await db`UPDATE ezil_app_releases SET status='approved',approved_by=${admin},approved_at=now() WHERE id=${release.id}`;
        const [installation] = await db`INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by)
            VALUES (${computer.id},${app.id},${release.id},${userId}) RETURNING id`;
        return { userId, computerId: computer.id, appId: app.id, releaseId: release.id, installationId: installation.id };
    }
    const a = await fixture(alice, 'alice-app'), b = await fixture(bob, 'bob-app');
    const plan = target => ({ releaseId: target.releaseId, policyDigest: digest, image,
        services: [], privateDirectories: [], projectGrants: [] });
    async function job(tx, target, operation = 'start') {
        const [row] = await tx`INSERT INTO ezil_app_jobs (installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${target.installationId},${target.computerId},${target.userId},${operation},${randomUUID()}) RETURNING id`;
        return row.id;
    }
    async function command(tx, target, generation, options = {}) {
        const jobId = options.jobId ?? await job(tx, target, options.operation ?? 'start');
        if (!options.skipOutbox) await tx`INSERT INTO ezil_app_outbox (job_id) VALUES (${jobId})`;
        await tx`INSERT INTO ezil_app_runtime_commands
            (job_id,installation_id,computer_id,app_id,release_id,computer_generation,generation,auth_generation,operation,plan)
            VALUES (${jobId},${target.installationId},${target.computerId},${target.appId},${target.releaseId},
                ${options.computerGeneration ?? 1},${generation},${options.authGeneration ?? 1},${options.operation ?? 'start'},
                ${tx.json(options.plan ?? plan(target))})`;
        return jobId;
    }

    let first;
    await test('complete job, outbox and immutable command commit together', async () => {
        first = await db.begin(tx => command(tx, a, 1));
        const [counts] = await db`SELECT (SELECT count(*)::int FROM ezil_app_jobs) jobs,
            (SELECT count(*)::int FROM ezil_app_outbox) events,
            (SELECT count(*)::int FROM ezil_app_runtime_commands) commands`;
        assert.deepEqual({ ...counts }, { jobs: 1, events: 1, commands: 1 });
    });
    await test('failed commit without command rolls back its job and outbox', async () => {
        await rejects(() => db.begin(async tx => {
            const id = await job(tx, a);
            await tx`INSERT INTO ezil_app_outbox (job_id) VALUES (${id})`;
        }), '23514');
        assert.equal((await db`SELECT count(*)::int n FROM ezil_app_jobs`)[0].n, 1);
    });
    await test('command cannot omit its outbox, cross a tenant, target a missing writer, or change operation', async () => {
        await rejects(() => db.begin(tx => command(tx, a, 2, { skipOutbox: true })), '23503');
        await rejects(() => db.begin(tx => command(tx, { ...a, computerId: b.computerId }, 2)), '23503');
        await rejects(() => db.begin(tx => command(tx, { ...a, releaseId: b.releaseId }, 2)), '23503');
        await rejects(() => db.begin(tx => command(tx, a, 2, { computerGeneration: 9 })), '23503');
        await rejects(() => db.begin(async tx => command(tx, a, 2, { jobId: await job(tx, a, 'stop') })), '23503');
    });
    await test('history cannot be rewritten, deleted, truncated or detached from its outbox', async () => {
        await rejects(() => db`UPDATE ezil_app_runtime_commands SET plan='{}' WHERE job_id=${first}`, '23514');
        await rejects(() => db`DELETE FROM ezil_app_runtime_commands WHERE job_id=${first}`, '23514');
        await rejects(() => db.unsafe('TRUNCATE ezil_app_runtime_commands CASCADE'), '23514');
        // PG18 distinguishes RESTRICT from a general FK violation (PG16).
        await assert.rejects(db`DELETE FROM ezil_app_outbox WHERE job_id=${first}`,
            error => ['23503', '23001'].includes(error.code));
        await db`UPDATE ezil_app_outbox SET delivered_at=now() WHERE job_id=${first}`;
        await db`UPDATE ezil_app_jobs SET status='succeeded',completed_at=now() WHERE id=${first}`;
    });
    await test('plan envelope and size are bounded and revisions cannot skip or repeat', async () => {
        await rejects(() => db.begin(tx => command(tx, a, 1)), '23514');
        await rejects(() => db.begin(tx => command(tx, a, 3)), '23514');
        await rejects(() => db.begin(tx => command(tx, a, 2, { plan: {} })), '23514');
        await rejects(() => db.begin(tx => command(tx, a, 2, { plan: { ...plan(a), padding: 'x'.repeat(49_152) } })), '23514');
    });
    await test('a lost transaction does not consume a revision', async () => {
        const marker = new Error('rollback');
        await assert.rejects(db.begin(async tx => { await command(tx, a, 2); throw marker; }), error => error === marker);
        assert.equal((await db`SELECT max(generation) revision FROM ezil_app_runtime_commands WHERE installation_id=${a.installationId}`)[0].revision, 1);
    });
    await test('two simultaneous writers cannot commit the same revision', async () => {
        const outcomes = await Promise.allSettled([db.begin(tx => command(tx, a, 2)), db.begin(tx => command(tx, a, 2))]);
        assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
        const failure = outcomes.find(r => r.status === 'rejected');
        assert.equal(failure.reason.code, '23514');
        assert.equal((await db`SELECT count(*)::int n FROM ezil_app_runtime_commands WHERE installation_id=${a.installationId}`)[0].n, 2);
    });
    await test('stop advances intent independently from browser authorization and host replacement', async () => {
        await db`UPDATE ezil_app_installations SET auth_generation=7 WHERE id=${a.installationId}`;
        await db`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${a.computerId}`;
        await db`INSERT INTO ezil_computer_instances (computer_id,generation) VALUES (${a.computerId},2)`;
        await db.begin(tx => command(tx, a, 3, { operation: 'stop', authGeneration: 7, computerGeneration: 2 }));
        await db.begin(tx => command(tx, b, 1));
        const [row] = await db`SELECT generation,auth_generation,computer_generation FROM ezil_app_runtime_commands
            WHERE installation_id=${a.installationId} ORDER BY generation DESC LIMIT 1`;
        assert.deepEqual({ ...row }, { generation: 3, auth_generation: 7, computer_generation: 2 });
    });
    await test('reused Open request receipts stay bound to the original intent after Stop', async () => {
        const requestId = randomUUID(), secondRequestId = randomUUID();
        const receipt = (target, id, jobId) => db`INSERT INTO ezil_app_runtime_requests
            (installation_id,request_id,job_id,requested_by) VALUES (${target.installationId},${id},${jobId},${target.userId})`;
        await receipt(a, requestId, first);
        await receipt(a, secondRequestId, first);
        const [stop] = await db`SELECT job_id FROM ezil_app_runtime_commands WHERE installation_id=${a.installationId} AND generation=3`;
        await rejects(() => receipt(a, secondRequestId, stop.job_id), '23505');
        await rejects(() => db`UPDATE ezil_app_runtime_requests SET job_id=${stop.job_id} WHERE request_id=${requestId}`, '23514');
        await rejects(() => db`DELETE FROM ezil_app_runtime_requests WHERE request_id=${requestId}`, '23514');
        await rejects(() => db.unsafe('TRUNCATE ezil_app_runtime_requests'), '23514');
        await rejects(() => receipt(b, requestId, first), '23503');
        const [other] = await db`SELECT job_id FROM ezil_app_runtime_commands WHERE installation_id=${b.installationId}`;
        await receipt(b, requestId, other.job_id);
        const receipts = await db`SELECT job_id FROM ezil_app_runtime_requests WHERE installation_id=${a.installationId}`;
        assert.deepEqual(receipts.map(r => r.job_id), [first, first]);
    });
    await test('authenticated owners cannot read or insert commands; service role can read', async () => {
        await db.unsafe('GRANT ALL ON ezil_app_runtime_commands, ezil_app_runtime_requests, ezil_computers, ezil_app_installations TO authenticated, service_role');
        await db.begin(async tx => {
            await tx.unsafe('SET LOCAL ROLE authenticated');
            await tx`SELECT set_config('request.jwt.claim.sub',${alice},true),set_config('request.jwt.claim.role','authenticated',true)`;
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_app_runtime_commands`)[0].n, 0);
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_app_runtime_requests`)[0].n, 0);
            // RLS also denies updates even to the owner's own command.
            assert.equal((await tx`UPDATE ezil_app_runtime_commands SET generation=99 WHERE job_id=${first} RETURNING job_id`).length, 0);
        });
        await rejects(() => db.begin(async tx => {
            await tx.unsafe('SET LOCAL ROLE authenticated');
            await tx`SELECT set_config('request.jwt.claim.sub',${alice},true),set_config('request.jwt.claim.role','authenticated',true)`;
            await tx`INSERT INTO ezil_app_runtime_commands
                (job_id,installation_id,computer_id,app_id,release_id,computer_generation,generation,auth_generation,operation,plan)
                VALUES (${randomUUID()},${a.installationId},${a.computerId},${a.appId},${a.releaseId},2,4,7,'start',${tx.json(plan(a))})`;
        // The invoker-rights guard sees no installation through its service-only
        // RLS policy, before PostgreSQL reaches the command's WITH CHECK policy.
        }), '23503');
        await rejects(() => db.begin(async tx => {
            await tx.unsafe('SET LOCAL ROLE authenticated');
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true)`;
            await tx`INSERT INTO ezil_app_runtime_requests (installation_id,request_id,job_id,requested_by)
                VALUES (${a.installationId},${randomUUID()},${first},${alice})`;
        }), '42501');
        await db.begin(async tx => {
            await tx.unsafe('SET LOCAL ROLE service_role');
            await tx`SELECT set_config('request.jwt.claim.role','service_role',true)`;
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_app_runtime_commands`)[0].n, 4);
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_app_runtime_requests`)[0].n, 3);
        });
    });
    console.log(`${passed} pass, 0 fail, 0 skip — actual PostgreSQL command ledger`);
} finally {
    await db.end({ timeout: 5 });
    if (created) await adminDb.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await adminDb.end({ timeout: 5 });
}
