import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import type { User } from '@supabase/supabase-js';
import { runtimeRecords } from './fixtures/runtime-release';
import { runtimeTestDatabase } from './helpers/runtime-database';

const fixture = await runtimeTestDatabase();
const { sql } = fixture;
process.env.SUPABASE_DATABASE_URL = fixture.url;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://runtime-api-test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'runtime-api-test-anon';
process.env.EZIL_APP_MARKETPLACE_API_ENABLED = 'true';
process.env.EZIL_APP_RUNTIME_COMMANDS_ENABLED = 'true';
process.env.EZIL_APP_INSTALL_ENABLED = 'true';
process.env.EZIL_OS_ACCESS_MODE = 'open';
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`); };
const reject = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: { code?: string }) => error.code === code);
const capturedPlans: unknown[] = [];

try {
    const [{ appRouter }, { buildTRPCContext }, schema] = await Promise.all([
        import('../src/server/api/root'), import('../src/server/api/trpc'), import('../src/server/db/schema'),
    ]);
    const database = drizzle(sql, { schema });
    const alice = randomUUID(), bob = randomUUID(), admin = randomUUID();
    await sql`INSERT INTO auth.users (id) VALUES (${alice}),(${bob}),(${admin})`;
    await sql`INSERT INTO ezil_app_admins (user_id) VALUES (${admin})`;
    const [publisher] = await sql`INSERT INTO ezil_app_publishers (owner_user_id,display_name,status,invited_by)
        VALUES (${admin},'Test','active',${admin}) RETURNING id`;
    const makeComputer = async (user: string, slot = 1) => {
        const [computer] = await sql`INSERT INTO ezil_computers (user_id,slot,provider) VALUES (${user},${slot},'aws-ec2') RETURNING id`;
        await sql`INSERT INTO ezil_computer_runtimes (computer_id,region,availability_zone,data_volume_id)
            VALUES (${computer!.id},'us-east-1','us-east-1a',${`vol-${randomUUID().replaceAll('-', '').slice(0, 17)}`})`;
        await sql`INSERT INTO ezil_computer_instances (computer_id,generation,observed_state)
            VALUES (${computer!.id},1,'stopped')`;
        return computer!.id as string;
    };
    const a = await makeComputer(alice), b = await makeComputer(bob);
    const context = (user: string | null) => buildTRPCContext({ db: database,
        user: user ? { id: user, email: `${user}@example.com` } as User : null, headers: new Headers(), mode: 'open' });
    const aliceApi = appRouter.createCaller(context(alice)), bobApi = appRouter.createCaller(context(bob));
    const createRelease = async (kind: 'node' | 'reticle', mutate?: Parameters<typeof runtimeRecords>[2]) => {
        const records = runtimeRecords(kind, { appId: randomUUID(), publisherId: publisher!.id, releaseId: randomUUID() }, mutate);
        await sql`INSERT INTO ezil_apps (id,publisher_id,slug,name,summary,category,visibility)
            VALUES (${records.app.id},${publisher!.id},${records.app.slug},'Test','Test','Development','grant-only')`;
        const r = records.release;
        await sql`INSERT INTO ezil_app_releases
            (id,app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
            VALUES (${r.id},${records.app.id},${r.version},${JSON.stringify(r.manifest)}::jsonb,${JSON.stringify(r.policy)}::jsonb,
                ${r.manifestDigest},${r.policyDigest},${r.imageReference},${r.provenanceDigest},${r.sourceCommitSha})`;
        await sql`UPDATE ezil_app_releases SET status='validated' WHERE id=${r.id}`;
        await sql`UPDATE ezil_app_releases SET status='approved',approved_by=${admin},approved_at=now() WHERE id=${r.id}`;
        await sql`INSERT INTO ezil_app_grants (user_id,app_id,granted_by) VALUES (${alice},${records.app.id},${admin}),(${bob},${records.app.id},${admin})`;
        return records;
    };
    const notes = await createRelease('node'), reticle = await createRelease('reticle');
    const install = async (user: string, computer: string, records: ReturnType<typeof runtimeRecords>, hostPort: number) => {
        const [row] = await sql`INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by)
            VALUES (${computer},${records.app.id},${records.release.id},${user}) RETURNING id`;
        const installationId = row!.id as string;
        await sql`UPDATE ezil_app_installations SET status='installed',installed_at=now() WHERE id=${installationId}`;
        const service = records.services[0]!;
        await sql`INSERT INTO ezil_app_services (installation_id,computer_id,name,protocol,scope,internal_port,health_path)
            VALUES (${installationId},${computer},${service.name},${service.protocol},${service.scope},${service.internalPort},${service.healthPath})`;
        await sql`INSERT INTO ezil_app_port_leases (installation_id,computer_id,service_name,host_port)
            VALUES (${installationId},${computer},${service.name},${hostPort})`;
        return installationId;
    };
    const aNotes = await install(alice, a, notes, 4400), bNotes = await install(bob, b, notes, 4400);
    const aReticle = await install(alice, a, reticle, 20000);
    const request = (installationId = aNotes, computerId = a) => ({ computerId, installationId, clientRequestId: randomUUID() });
    const counts = async () => ({ ...(await sql`SELECT
        (SELECT count(*)::int FROM ezil_app_jobs) jobs, (SELECT count(*)::int FROM ezil_app_outbox) outbox,
        (SELECT count(*)::int FROM ezil_app_runtime_commands) commands, (SELECT count(*)::int FROM ezil_app_runtime_requests) receipts,
        (SELECT count(*)::int FROM ezil_computer_lifecycle_jobs) computer_jobs,
        (SELECT count(*)::int FROM ezil_computer_lifecycle_outbox) computer_outbox`)[0] });

    await test('authentication, ownership, mismatched installation and unknown fields fail before writes', async () => {
        await reject(appRouter.createCaller(context(null)).apps.launch(request()), 'UNAUTHORIZED');
        await reject(bobApi.apps.launch(request()), 'NOT_FOUND');
        await reject(aliceApi.apps.launch(request(bNotes)), 'NOT_FOUND');
        await reject(aliceApi.apps.launch({ ...request(), hostPort: 4400 } as never), 'BAD_REQUEST');
        assert.equal((await counts()).jobs, 0);
    });
    await test('OS access, legacy computers, unprepared disks and Stop without prior intent fail closed', async () => {
        const denied = appRouter.createCaller(buildTRPCContext({ db: database, user: context(alice).user,
            headers: new Headers(), mode: 'invite' }));
        await reject(denied.apps.launch(request()), 'FORBIDDEN');
        const [legacy] = await sql`INSERT INTO ezil_computers (user_id,slot) VALUES (${alice},2) RETURNING id`;
        await reject(aliceApi.apps.launch(request(aNotes, legacy!.id)), 'PRECONDITION_FAILED');
        await reject(aliceApi.apps.stop(request(aReticle)), 'PRECONDITION_FAILED');
        const [runtime] = await sql`SELECT data_volume_id,availability_zone FROM ezil_computer_runtimes WHERE computer_id=${a}`;
        await sql`UPDATE ezil_computer_runtimes SET data_volume_id=null,availability_zone=null WHERE computer_id=${a}`;
        await reject(aliceApi.apps.launch(request()), 'PRECONDITION_FAILED');
        await sql`UPDATE ezil_computer_runtimes SET data_volume_id=${runtime!.data_volume_id},availability_zone=${runtime!.availability_zone} WHERE computer_id=${a}`;
        assert.equal((await counts()).jobs, 0);
    });
    const firstRequest = request(), secondRequest = request();
    const [first, duplicate, simultaneous] = await Promise.all([
        aliceApi.apps.launch(firstRequest), aliceApi.apps.launch(firstRequest), aliceApi.apps.launch(secondRequest),
    ]);
    await test('launch commits app job, outbox, immutable intent, receipt and one computer-start job', async () => {
        assert.equal(first.status, 'queued');
        assert.equal(first.generation, 1);
        assert.equal(duplicate.jobId, first.jobId);
        assert.equal(simultaneous.jobId, first.jobId);
        assert.equal([first, duplicate, simultaneous].filter(r => !r.reused).length, 1);
        assert.deepEqual(await counts(), { jobs: 1, outbox: 1, commands: 1, receipts: 2, computer_jobs: 1, computer_outbox: 1 });
        const [command] = await sql`SELECT plan FROM ezil_app_runtime_commands WHERE job_id=${first.jobId}`;
        assert.equal(command!.plan.services[0].hostPort, 4400);
        assert.equal(command!.plan.services[0].internalPort, 8080);
        assert.equal(command!.plan.allowedOrigins.includes(`https://i-${aNotes}.apps.ezil.org`), true);
        capturedPlans.push(command!.plan);
    });
    await test('parallel opens and distinct request IDs reuse one command and computer-start job', async () => {
        const requests = [secondRequest, request(), request(), firstRequest];
        const results = await Promise.all(requests.map(input => aliceApi.apps.launch(input)));
        assert.ok(results.every(r => r.jobId === first.jobId && r.generation === 1 && r.reused));
        assert.deepEqual(await counts(), { jobs: 1, outbox: 1, commands: 1, receipts: 4, computer_jobs: 1, computer_outbox: 1 });
    });
    const stopRequest = request();
    const stop = await aliceApi.apps.stop(stopRequest);
    await test('Stop supersedes Open; replay of every accepted old Open cannot resurrect it', async () => {
        assert.equal(stop.generation, 2);
        assert.equal(stop.operation, 'stop');
        const before = await counts();
        for (const input of [firstRequest, secondRequest]) {
            const replay = await aliceApi.apps.launch(input);
            assert.equal(replay.jobId, first.jobId);
            assert.equal(replay.isLatestCommand, false);
        }
        await reject(aliceApi.apps.stop(firstRequest), 'CONFLICT');
        assert.deepEqual(await counts(), before);
        assert.equal((await aliceApi.apps.stop(stopRequest)).jobId, stop.jobId);
    });
    await test('a new explicit Open advances intent without changing browser authorization', async () => {
        const open = await aliceApi.apps.launch(request());
        assert.equal(open.generation, 3);
        assert.equal((await sql`SELECT auth_generation FROM ezil_app_installations WHERE id=${aNotes}`)[0]!.auth_generation, 1);
    });
    await test('status polling is scoped and changes no job, outbox, receipt or computer record', async () => {
        const before = await counts();
        const runtimes = await sql`SELECT * FROM ezil_computer_runtimes ORDER BY computer_id`;
        const outbox = await sql`SELECT * FROM ezil_app_outbox ORDER BY id`;
        await reject(bobApi.apps.jobStatus({ computerId: a, jobId: first.jobId }), 'NOT_FOUND');
        assert.equal((await aliceApi.apps.jobStatus({ computerId: a, jobId: first.jobId })).status, 'queued');
        assert.deepEqual(await counts(), before);
        assert.deepEqual(await sql`SELECT * FROM ezil_computer_runtimes ORDER BY computer_id`, runtimes);
        assert.deepEqual(await sql`SELECT * FROM ezil_app_outbox ORDER BY id`, outbox);
    });
    await test('a pending computer stop prevents new launch receipts and startup jobs', async () => {
        const [job] = await sql`INSERT INTO ezil_computer_lifecycle_jobs (computer_id,requested_by,operation,idempotency_key,target_generation)
            VALUES (${a},${alice},'stop',${randomUUID()},1) RETURNING id`;
        await sql`INSERT INTO ezil_computer_lifecycle_outbox (job_id,computer_id) VALUES (${job!.id},${a})`;
        const before = await counts();
        await reject(aliceApi.apps.launch(request()), 'PRECONDITION_FAILED');
        assert.deepEqual(await counts(), before);
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='cancelled',completed_at=now() WHERE id=${job!.id}`;
        await sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${job!.id}`;
    });
    await test('a fresh Open after computer stop gets a new revision; replacement keeps revisions monotonic', async () => {
        await sql`UPDATE ezil_app_jobs SET status='succeeded',completed_at=now() WHERE installation_id=${aNotes}`;
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE computer_id=${a} AND operation='start'`;
        const reopened = await aliceApi.apps.launch(request());
        assert.equal(reopened.generation, 4);
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${a} AND generation=1`;
        await sql`INSERT INTO ezil_computer_instances (computer_id,generation,observed_state) VALUES (${a},2,'running')`;
        await sql`UPDATE ezil_computer_runtimes SET next_generation=3 WHERE computer_id=${a}`;
        const replacement = await aliceApi.apps.launch(request());
        assert.equal(replacement.generation, 5);
        const [command] = await sql`SELECT computer_generation FROM ezil_app_runtime_commands WHERE job_id=${replacement.jobId}`;
        assert.equal(command!.computer_generation, 2);
        assert.equal((await aliceApi.apps.launch(firstRequest)).jobId, first.jobId);
        await sql`UPDATE ezil_app_jobs SET status='succeeded',completed_at=now() WHERE id=${replacement.jobId}`;
        const reused = await aliceApi.apps.launch(request());
        assert.equal(reused.jobId, replacement.jobId);
        assert.equal(reused.generation, 5);
    });
    await test('two accounts use the same release and port with separate commands and origins', async () => {
        const other = await bobApi.apps.launch(request(bNotes, b));
        assert.equal(other.generation, 1);
        const [command] = await sql`SELECT plan FROM ezil_app_runtime_commands WHERE job_id=${other.jobId}`;
        assert.equal(command!.plan.services[0].hostPort, 4400);
        assert.ok(command!.plan.allowedOrigins.includes(`https://i-${bNotes}.apps.ezil.org`));
        assert.ok(!command!.plan.allowedOrigins.includes(`https://i-${aNotes}.apps.ezil.org`));
    });
    const project = randomUUID(), otherProject = randomUUID();
    const reticleRequest = { ...request(aReticle), projectId: project };
    await test('Reticle needs explicit project consent and uses the assigned 20000 service lease', async () => {
        await reject(aliceApi.apps.launch(request(aReticle)), 'PRECONDITION_FAILED');
        await reject(aliceApi.apps.launch(reticleRequest), 'PRECONDITION_FAILED');
        await sql`INSERT INTO ezil_app_folder_grants (installation_id,computer_id,folder,scope,project_id,access,granted_by)
            VALUES (${aReticle},${a},'Projects','selected-projects',${project},'read-write',${alice})`;
        const launch = await aliceApi.apps.launch(reticleRequest);
        const [command] = await sql`SELECT plan FROM ezil_app_runtime_commands WHERE job_id=${launch.jobId}`;
        assert.equal(command!.plan.services[0].hostPort, 20000);
        assert.equal(command!.plan.services[0].process.projectId, project);
        assert.equal(command!.plan.projectGrants.length, 1);
        capturedPlans.push(command!.plan);
        await reject(aliceApi.apps.launch({ ...reticleRequest, projectId: otherProject }), 'CONFLICT');
        await sql`UPDATE ezil_app_folder_grants SET revoked_at=now() WHERE installation_id=${aReticle}`;
        await reject(aliceApi.apps.launch({ ...request(aReticle), projectId: project }), 'PRECONDITION_FAILED');
        assert.equal((await aliceApi.apps.stop(request(aReticle))).operation, 'stop');
    });
    await test('release and entitlement revocation block new starts but permit owned Stop', async () => {
        await sql`UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=${notes.release.id}`;
        await sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${notes.app.id}`;
        await reject(aliceApi.apps.launch(request()), 'FORBIDDEN');
        assert.equal((await aliceApi.apps.stop(request())).operation, 'stop');
        await reject(bobApi.apps.stop(request()), 'NOT_FOUND');
    });
    await test('a failing audit insert rolls back every producer write without exposing the database error', async () => {
        const before = await counts();
        await sql.unsafe(`CREATE FUNCTION public.test_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'never-echo-database-secret'; END; $$;
            CREATE TRIGGER test_refuse_audit BEFORE INSERT ON ezil_app_audit_events
            FOR EACH ROW EXECUTE FUNCTION public.test_refuse_audit();`);
        try {
            const error = await bobApi.apps.stop(request(bNotes, b)).catch(error => error);
            assert.equal(error.code, 'INTERNAL_SERVER_ERROR');
            assert.equal(error.message, 'Application request could not be recorded');
            assert.equal(error.cause, undefined);
            assert.deepEqual(await counts(), before);
        } finally { await sql.unsafe('DROP TRIGGER test_refuse_audit ON ezil_app_audit_events; DROP FUNCTION public.test_refuse_audit()'); }
    });
    await test('actual tRPC transport rejects mutation GET and serializes a scoped status query', async () => {
        const getMutation = new Request(`http://local.test/api/trpc/apps.launch?input=${encodeURIComponent(JSON.stringify(superjson.serialize(firstRequest)))}`);
        const respond = (req: Request) => fetchRequestHandler({ endpoint: '/api/trpc', req, router: appRouter,
            createContext: () => context(alice) });
        assert.equal((await respond(getMutation)).status, 405);
        const response = await respond(new Request(`http://local.test/api/trpc/apps.jobStatus?input=${encodeURIComponent(JSON.stringify(superjson.serialize({ computerId: a, jobId: first.jobId })))}`));
        assert.equal(response.status, 200);
        const body = await response.json();
        const data = superjson.deserialize(body.result.data) as { jobId: string; status: string };
        assert.equal(data.jobId, first.jobId);
        assert.equal('plan' in data, false);
        const before = await counts();
        const replay = await respond(new Request('http://local.test/api/trpc/apps.launch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(superjson.serialize(firstRequest)),
        }));
        assert.equal(replay.status, 200);
        const replayData = superjson.deserialize((await replay.json()).result.data) as { jobId: string; isLatestCommand: boolean };
        assert.equal(replayData.jobId, first.jobId);
        assert.equal(replayData.isLatestCommand, false);
        assert.deepEqual(await counts(), before);
    });
    await test('unsupported installation requirements fail before creating an installation, job, lease or audit', async () => {
        for (const companion of [false, true]) {
            const records = await createRelease('node', manifest => {
                manifest.slug = companion ? 'needs-companion' : 'needs-configuration';
                if (companion) manifest.services.push({ ...manifest.services[0]!, name: 'api' });
                else manifest.configuration.push({ name: 'THEME', kind: 'text', required: false });
            });
            await sql`INSERT INTO ezil_app_publications (app_id,release_id,published_by)
                VALUES (${records.app.id},${records.release.id},${admin})`;
            const before = await counts();
            const [beforeRows] = await sql`SELECT (SELECT count(*)::int FROM ezil_app_installations) installs,
                (SELECT count(*)::int FROM ezil_app_port_leases) leases, (SELECT count(*)::int FROM ezil_app_audit_events) audit`;
            const error = await aliceApi.apps.install({ computerId: a, appId: records.app.id,
                clientRequestId: randomUUID() }).catch(error => error);
            assert.equal(error.code, 'PRECONDITION_FAILED');
            assert.equal(error.message, 'Application release is not supported by this computer runtime');
            assert.equal(error.cause, undefined);
            assert.deepEqual(await counts(), before);
            assert.deepEqual((await sql`SELECT (SELECT count(*)::int FROM ezil_app_installations) installs,
                (SELECT count(*)::int FROM ezil_app_port_leases) leases, (SELECT count(*)::int FROM ezil_app_audit_events) audit`)[0], beforeRows);
        }
    });
    await test('Reticle installation precedes project selection and remains pending without execution or folder authority', async () => {
        const records = await createRelease('reticle', manifest => { manifest.slug = 'install-reticle'; });
        await sql`INSERT INTO ezil_app_publications (app_id,release_id,published_by)
            VALUES (${records.app.id},${records.release.id},${admin})`;
        const before = await counts();
        const input = { computerId: a, appId: records.app.id, clientRequestId: randomUUID() };
        const [first, second] = await Promise.all([aliceApi.apps.install(input), aliceApi.apps.install(input)]);
        assert.equal(first.installationId, second.installationId);
        assert.equal(first.jobId, second.jobId);
        assert.equal(first.status, 'pending');
        assert.equal([first, second].filter(result => !result.reused).length, 1);
        const after = await counts();
        assert.deepEqual(after, { ...before, jobs: before.jobs + 1, outbox: before.outbox + 1 });
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_folder_grants WHERE installation_id=${first.installationId}`)[0]!.n, 0);
        const [installed] = await sql`SELECT installed_at FROM ezil_app_installations WHERE id=${first.installationId}`;
        assert.equal(installed!.installed_at, null);
        await reject(aliceApi.apps.launch({ computerId: a, installationId: first.installationId,
            clientRequestId: randomUUID() }), 'PRECONDITION_FAILED');
        await reject(bobApi.apps.install(input), 'NOT_FOUND');
    });
    if (process.env.EZIL_TEST_COMPILED_PLANS) {
        await writeFile(process.env.EZIL_TEST_COMPILED_PLANS, JSON.stringify(capturedPlans), { mode: 0o600 });
    }
    console.log(`${passed} pass, 0 fail, 0 skip — actual PostgreSQL runtime API transactions`);
} finally { await fixture.close(); }
