import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { User } from '@supabase/supabase-js';
import { runtimeRecords } from './fixtures/runtime-release';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { claimRuntimeCommand, dispatchRuntimeClaim, dispatchNextRuntimeCommand, type RuntimeDispatcherOptions } from '../src/server/app-platform/runtime-dispatcher';
import { hostIntentDigest, type HostCommand, type HostObservation } from '../src/server/app-platform/host-control-client';

const fixture = await runtimeTestDatabase();
const { sql } = fixture;
process.env.SUPABASE_DATABASE_URL = fixture.url;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://runtime-test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'local-test';
process.env.EZIL_APP_MARKETPLACE_API_ENABLED = 'true';
process.env.EZIL_APP_RUNTIME_COMMANDS_ENABLED = 'true';
process.env.EZIL_OS_ACCESS_MODE = 'open';
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`); };
try {
    const [{ appRouter }, { buildTRPCContext }, schema] = await Promise.all([
        import('../src/server/api/root'), import('../src/server/api/trpc'), import('../src/server/db/schema'),
    ]);
    const database = drizzle(sql, { schema });
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    const user = randomUUID();
    await sql`INSERT INTO auth.users(id,email) VALUES (${user},'dispatcher@example.com')`;
    await sql`INSERT INTO ezil_app_admins(user_id) VALUES (${user})`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES ('dispatcher@example.com','local-test')`;
    const [publisher] = await sql`INSERT INTO ezil_app_publishers(owner_user_id,display_name,status,invited_by)
        VALUES (${user},'Test','active',${user}) RETURNING id`;
    const setup = async (kind: 'node' | 'reticle' = 'node') => {
        const ownerId = randomUUID();
        await sql`INSERT INTO auth.users(id,email) VALUES (${ownerId},'dispatcher@example.com')`;
        const [computer] = await sql`INSERT INTO ezil_computers(user_id,slot,provider) VALUES (${ownerId},1,'aws-ec2') RETURNING id`;
        const caller = appRouter.createCaller(buildTRPCContext({ db: database, user: { id: ownerId, email: 'dispatcher@example.com' } as User,
            headers: new Headers(), mode: 'open' }));
        const c = computer!.id as string;
        await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,availability_zone,data_volume_id,desired_state)
            VALUES (${c},'us-east-1','us-east-1a',${`vol-${randomUUID()}`},'running')`;
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,observed_state,observed_at)
            VALUES (${c},1,${`i-${randomUUID()}`},'running',now())`;
        const r = runtimeRecords(kind, { appId: randomUUID(), publisherId: publisher!.id, releaseId: randomUUID() },
            manifest => { manifest.slug = `test-${randomUUID()}`; });
        await sql`INSERT INTO ezil_apps(id,publisher_id,slug,name,summary,category,visibility)
            VALUES (${r.app.id},${publisher!.id},${r.app.slug},'Test','Test','Development','grant-only')`;
        await sql`INSERT INTO ezil_app_releases(id,app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
            VALUES (${r.release.id},${r.app.id},${r.release.version},${JSON.stringify(r.release.manifest)}::jsonb,${JSON.stringify(r.release.policy)}::jsonb,
                ${r.release.manifestDigest},${r.release.policyDigest},${r.release.imageReference},${r.release.provenanceDigest},${r.release.sourceCommitSha})`;
        await sql`UPDATE ezil_app_releases SET status='validated' WHERE id=${r.release.id}`;
        await sql`UPDATE ezil_app_releases SET status='approved',approved_by=${user},approved_at=now() WHERE id=${r.release.id}`;
        await sql`INSERT INTO ezil_app_grants(user_id,app_id,granted_by) VALUES (${ownerId},${r.app.id},${user})`;
        const [i] = await sql`INSERT INTO ezil_app_installations(computer_id,app_id,release_id,installed_by)
            VALUES (${c},${r.app.id},${r.release.id},${ownerId}) RETURNING id`;
        const id = i!.id as string;
        await sql`UPDATE ezil_app_installations SET status='installed',installed_at=now() WHERE id=${id}`;
        const s = r.services[0]!;
        await sql`INSERT INTO ezil_app_services(installation_id,computer_id,name,protocol,scope,internal_port,health_path)
            VALUES (${id},${c},${s.name},${s.protocol},${s.scope},${s.internalPort},${s.healthPath})`;
        await sql`INSERT INTO ezil_app_port_leases(installation_id,computer_id,service_name,host_port) VALUES (${id},${c},${s.name},4400)`;
        const request = () => ({ computerId: c, installationId: id, clientRequestId: randomUUID() });
        return { c, id, owner: ownerId as string, r, caller, request };
    };
    const history = new Map<string, HostCommand>(), observations = new Map<string, HostObservation>();
    let calls = 0;
    const options: RuntimeDispatcherOptions = { database, enabled: true, osAccessMode: 'invite', resolveHost: async scope => ({ scope,
        observe: async id => { calls++; return observations.get(id) ?? null; },
        reconcile: async command => { calls++; history.set(command.installationId, command); },
    }) };
    const due = async (jobId: string) => {
        // Isolate the selected case's scheduling without bypassing claim locks.
        await sql`UPDATE ezil_app_outbox SET available_at=now()+interval '1 day' WHERE delivered_at IS NULL`;
        await sql`UPDATE ezil_app_outbox SET available_at=now() WHERE job_id=${jobId}`;
    };
    const claim = async (jobId: string) => { await due(jobId); const c = await claimRuntimeCommand(database); assert.equal(c?.jobId, jobId); return c!; };
    const status = async (id: string) => (await sql`SELECT status,error_code FROM ezil_app_jobs WHERE id=${id}`)[0]!;
    const setObserved = (id: string, settled = true) => {
        const c = history.get(id)!; assert.ok(c);
        observations.set(id, { computerId: c.computerId, computerGeneration: c.computerGeneration, installationId: id,
            generation: c.generation, desired: c.desired, intentDigest: hostIntentDigest(c), state: c.desired,
            settled, runtimeDeadlineMs: c.desired === 'running' ? Date.now() + 60000 : null });
    };
    const first = await setup();
    const start = await first.caller.apps.launch(first.request());
    await test('disabled dispatch and browser polling do no work; concurrent claims lease exactly one event', async () => {
        assert.equal(await dispatchNextRuntimeCommand({ ...options, enabled: false }), 'disabled');
        await first.caller.apps.jobStatus({ computerId: first.c, jobId: start.jobId }); assert.equal(calls, 0);
        await due(start.jobId);
        const claims = await Promise.all([claimRuntimeCommand(database), claimRuntimeCommand(database)]);
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal(await dispatchRuntimeClaim(options, claims.find(Boolean)!), 'waiting');
        assert.equal((await status(start.jobId)).status, 'running');
    });
    await test('202 and mid-start health cannot succeed; matching settled observation can', async () => {
        setObserved(first.id, false);
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'waiting');
        assert.equal((await status(start.jobId)).status, 'running');
        setObserved(first.id);
        const before = calls;
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'succeeded');
        assert.equal(calls, before + 1);
        assert.equal((await status(start.jobId)).status, 'succeeded');
        assert.equal((await sql`SELECT delivered_at FROM ezil_app_outbox WHERE job_id=${start.jobId}`)[0]!.delivered_at, null);
    });
    await test('post-success runtime expiry creates durable Stop without replaying Start', async () => {
        observations.get(first.id)!.runtimeDeadlineMs = Date.now() - 1;
        const before = calls;
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'cancelled');
        assert.equal(calls, before + 1);
        const [stop] = await sql`SELECT job_id,generation,operation FROM ezil_app_runtime_commands WHERE installation_id=${first.id} ORDER BY generation DESC LIMIT 1`;
        assert.equal(stop!.generation, 2); assert.equal(stop!.operation, 'stop');
        assert.equal((await status(start.jobId)).status, 'succeeded', 'retain actual completed job history');
        assert.equal(await dispatchRuntimeClaim(options, await claim(stop!.job_id)), 'waiting');
        setObserved(first.id);
        assert.equal(await dispatchRuntimeClaim(options, await claim(stop!.job_id)), 'succeeded');
    });
    await test('a stale attempt cannot send or overwrite a reclaimed lease', async () => {
        const s = await setup(); const job = await s.caller.apps.launch(s.request());
        const old = await claim(job.jobId);
        await sql`UPDATE ezil_app_outbox SET lease_until=now()-interval '1 second' WHERE id=${old.id}`;
        const replacement = await claim(job.jobId); assert.equal(replacement.attempt, old.attempt + 1);
        const before = calls; assert.equal(await dispatchRuntimeClaim(options, old), 'stale'); assert.equal(calls, before);
        assert.equal(await dispatchRuntimeClaim(options, replacement), 'waiting');
    });
    await test('old Start delivery after newer Stop never signs or changes the newer command', async () => {
        const s = await setup(); const start = await s.caller.apps.launch(s.request()); const old = await claim(start.jobId);
        const stop = await s.caller.apps.stop(s.request()); const before = calls;
        assert.equal(await dispatchRuntimeClaim(options, old), 'cancelled'); assert.equal(calls, before);
        assert.equal((await status(stop.jobId)).status, 'queued');
    });
    await test('revocation before delivery records a compensating Stop without signing revoked Start', async () => {
        for (const kind of ['grant', 'release', 'os', 'ban', 'deleted', 'port', 'authorization', 'publisher']) {
            const s = await setup(); const start = await s.caller.apps.launch(s.request());
            if (kind === 'grant') await sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${s.r.app.id}`;
            if (kind === 'release') await sql`UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=${s.r.release.id}`;
            if (kind === 'os') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email='dispatcher@example.com'`;
            if (kind === 'ban') await sql`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${s.owner}`;
            if (kind === 'deleted') await sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${s.c}`;
            if (kind === 'port') await sql`UPDATE ezil_app_port_leases SET released_at=now() WHERE installation_id=${s.id}`;
            if (kind === 'authorization') await sql`UPDATE ezil_app_installations SET auth_generation=auth_generation+1 WHERE id=${s.id}`;
            if (kind === 'publisher') await sql`UPDATE ezil_app_publishers SET status='revoked',revoked_at=now() WHERE id=${publisher!.id}`;
            const before = calls;
            assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'cancelled', kind); assert.equal(calls, before, kind);
            assert.equal((await status(start.jobId)).error_code, 'authority_changed');
            if (kind === 'os') await sql`UPDATE ezil_os_access SET revoked_at=null WHERE email='dispatcher@example.com'`;
            if (kind === 'publisher') await sql`UPDATE ezil_app_publishers SET status='active' WHERE id=${publisher!.id}`;
        }
    });
    await test('fenced writer and provider-observed Stop never contact a host', async () => {
        const s = await setup(); const start = await s.caller.apps.launch(s.request());
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${s.c}`;
        const before = calls; assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'cancelled'); assert.equal(calls, before);
        const second = await setup(); await second.caller.apps.launch(second.request()); const stop = await second.caller.apps.stop(second.request());
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped',observed_at=now() WHERE computer_id=${second.c}`;
        assert.equal(await dispatchRuntimeClaim(options, await claim(stop.jobId)), 'succeeded'); assert.equal(calls, before);
    });
    await test('wrong host mapping, wrong digest and transport errors stay retryable and redacted', async () => {
        const s = await setup(); const start = await s.caller.apps.launch(s.request());
        const wrong: RuntimeDispatcherOptions = { ...options, resolveHost: async (scope, signal) => ({ ...await options.resolveHost(scope, signal), scope: { ...scope, fenceToken: randomUUID() } }) };
        const before = calls; assert.equal(await dispatchRuntimeClaim(wrong, await claim(start.jobId)), 'waiting'); assert.equal(calls, before);
        assert.equal((await status(start.jobId)).error_code, 'host_rejected');
        await dispatchRuntimeClaim(options, await claim(start.jobId)); setObserved(s.id);
        observations.get(s.id)!.intentDigest = 'f'.repeat(64);
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'waiting');
        assert.equal((await status(start.jobId)).error_code, 'host_response_invalid');
        const broken = { ...options, resolveHost: async () => { throw new Error('private-secret-value'); } };
        assert.equal(await dispatchRuntimeClaim(broken, await claim(start.jobId)), 'waiting');
        assert.equal((await status(start.jobId)).error_code, 'runtime_dispatch_failed');
    });
    await test('a blocked delivery serializes newer Stop and revocation until its authority locks release', async () => {
        const s = await setup(); const start = await s.caller.apps.launch(s.request());
        let entered!: () => void, resume!: () => void;
        const atHost = new Promise<void>(resolve => { entered = resolve; });
        const paused = new Promise<void>(resolve => { resume = resolve; });
        const slow: RuntimeDispatcherOptions = { ...options, resolveHost: async (scope, signal) => {
            const host = await options.resolveHost(scope, signal);
            return { ...host, observe: async id => { entered(); await paused; return host.observe(id); } };
        } };
        const delivering = dispatchRuntimeClaim(slow, await claim(start.jobId));
        await atHost;
        let stopped = false, revoked = false;
        const stop = s.caller.apps.stop(s.request()).then(value => { stopped = true; return value; });
        const revoke = sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${s.r.app.id}`.then(() => { revoked = true; });
        try {
            // Poll actual PostgreSQL wait state rather than relying only on a
            // short sleep to infer that competing transactions reached the lock.
            for (let attempt = 0; attempt < 100; attempt++) {
                const [row] = await sql`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
                if (row!.n >= 2) break;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            const [blocked] = await sql`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
            assert.ok(blocked!.n >= 2); assert.equal(stopped, false); assert.equal(revoked, false);
        } finally { resume(); }
        assert.equal(await delivering, 'waiting');
        const newer = await stop; await revoke;
        const before = calls;
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'cancelled'); assert.equal(calls, before);
        assert.equal(await dispatchRuntimeClaim(options, await claim(newer.jobId)), 'waiting');
        assert.equal(history.get(s.id)!.desired, 'stopped');
    });
    await test('failure to commit a compensating Stop rolls back command, job, outbox and audit together', async () => {
        const s = await setup(); const start = await s.caller.apps.launch(s.request());
        await sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${s.r.app.id}`;
        await sql.unsafe(`CREATE FUNCTION test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.action='installation.runtime-stop-requested' THEN RAISE EXCEPTION 'sensitive-internal-detail'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER test_reject_audit BEFORE INSERT ON ezil_app_audit_events FOR EACH ROW EXECUTE FUNCTION test_reject_audit()`);
        try {
            assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'waiting');
            assert.equal((await status(start.jobId)).error_code, 'runtime_dispatch_failed');
            const [count] = await sql`SELECT count(*)::int n FROM ezil_app_runtime_commands WHERE installation_id=${s.id}`;
            assert.equal(count!.n, 1);
        } finally { await sql.unsafe('DROP TRIGGER test_reject_audit ON ezil_app_audit_events; DROP FUNCTION test_reject_audit()'); }
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'cancelled');
        const [count] = await sql`SELECT count(*)::int n FROM ezil_app_runtime_commands WHERE installation_id=${s.id}`;
        assert.equal(count!.n, 2);
    });
    await test('selected Reticle project consent is rechecked at dispatch', async () => {
        const s = await setup('reticle'); const projectId = randomUUID();
        await sql`INSERT INTO ezil_app_folder_grants(installation_id,computer_id,folder,scope,project_id,access,granted_by)
            VALUES (${s.id},${s.c},'Projects','selected-projects',${projectId},'read-write',${s.owner})`;
        const start = await s.caller.apps.launch({ ...s.request(), projectId });
        await sql`UPDATE ezil_app_folder_grants SET revoked_at=now() WHERE installation_id=${s.id}`;
        const before = calls;
        assert.equal(await dispatchRuntimeClaim(options, await claim(start.jobId)), 'cancelled'); assert.equal(calls, before);
    });
    console.log(`${passed} passed, 0 failed, 0 skipped`);
    await (await import('../src/server/db')).db.$client.end({ timeout: 5 });
} finally { await fixture.close(); }
