import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { issueComputerDataMount } from '../src/server/app-platform/computer-mount-authority';
import { authorizeComputerMount, claimComputerMount, dispatchComputerMountClaim, dispatchNextComputerMount,
    type MountDeliveryOptions } from '../src/server/app-platform/computer-mount-delivery';
import type { ComputerMountWork } from '../src/server/app-platform/computer-mount-protocol';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { dataMountComputer } from './fixtures/data-mount';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
const options: MountDeliveryOptions = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite',
    deployments: [deployment], advanceMount: async () => ({ state: 'pending' }) };
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
async function setup(operation: 'provision' | 'start' | 'replace' = 'provision') {
    const c = await dataMountComputer(sql, operation), email = `${randomUUID()}@example.com`;
    await sql`UPDATE auth.users SET email=${email} WHERE id=${c.userId}`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'fixture')`;
    const result = await issueComputerDataMount({ ...options, advance: async work => ({ state: 'observed', observedAt: new Date(),
        receipt: { schemaVersion: 1, computerId: c.computerId, jobId: c.jobId, digest: work.digest, generation: c.generation,
            fenceToken: c.fence, instanceId: c.instance, volumeId: c.volume, state: 'running' } }) }, { computerId: c.computerId, jobId: c.jobId });
    assert.ok(result.state === 'issued');
    return { ...c, email, authorizationId: result.authorization.authorizationId,
        work: { authorization: result.authorization, plan: result.plan, deployment } satisfies ComputerMountWork };
}
type Computer = Awaited<ReturnType<typeof setup>>;
async function due(c: Computer) {
    await sql`UPDATE ezil_computer_data_mount_deliveries SET available_at=now()+interval '1 day' WHERE mounted_at IS NULL`;
    await sql`UPDATE ezil_computer_data_mount_deliveries SET available_at=now() WHERE authorization_id=${c.authorizationId}`;
}
async function claim(c: Computer) { await due(c); const value = await claimComputerMount(options); assert.equal(value?.authorizationId, c.authorizationId); return value!; }
const state = async (c: Computer) => (await sql`SELECT * FROM ezil_computer_data_mount_deliveries WHERE authorization_id=${c.authorizationId}`)[0]!;
function mounted(w: ComputerMountWork) { return { state: 'mounted', receipt: { schemaVersion: 1, authorizationId: w.authorization.authorizationId,
    scope: w.authorization.scope, digest: w.authorization.digest, state: 'mounted', computerId: w.plan.computerId,
    volumeId: w.plan.volumeId, filesystemUuid: w.plan.filesystemUuid } }; }
async function expire(c: Computer) {
    // Test-clock fixture only, in this disposable database. Production authority
    // is immutable and the consumer has no way to renew or change this deadline.
    await sql.begin(async tx => {
        await tx`ALTER TABLE ezil_computer_data_mount_authorizations DISABLE TRIGGER ezil_mount_authority_write_trg`;
        await tx`UPDATE ezil_computer_data_mount_authorizations SET issued_at=issued_at-interval '1000 seconds',
            expires_at=expires_at-interval '1000 seconds',provider_observed_at=provider_observed_at-interval '1000 seconds'
            WHERE id=${c.authorizationId}`;
        await tx`ALTER TABLE ezil_computer_data_mount_authorizations ENABLE TRIGGER ezil_mount_authority_write_trg`;
    });
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled and malformed calls do not use a database or transport', async () => {
        const invalid = { ...options, database: null as never, enabled: false,
            advanceMount: async () => { throw new Error('must_not_call'); } };
        assert.equal(await dispatchNextComputerMount(invalid), 'disabled');
        assert.equal(await authorizeComputerMount(invalid, null), false);
        assert.equal(await dispatchComputerMountClaim({ ...invalid, enabled: true }, { computerId: randomUUID() } as never), 'stale');
        assert.equal(await authorizeComputerMount({ ...invalid, enabled: true }, { computerId: randomUUID() }), false);
    });
    await test('concurrent claims lease one delivery and pending polls retain immutable identity', async () => {
        const c = await setup(); await due(c);
        const claims = await Promise.all([claimComputerMount(options), claimComputerMount(options)]);
        assert.equal(claims.filter(Boolean).length, 1); const first = claims.find(Boolean)!;
        const work: ComputerMountWork[] = [];
        const o = { ...options, advanceMount: async (w: ComputerMountWork) => { work.push(w); return { state: 'pending' }; } };
        assert.equal(await dispatchComputerMountClaim(o, first), 'waiting');
        assert.equal((await state(c)).mounted_at, null);
        assert.equal(await dispatchComputerMountClaim(o, await claim(c)), 'waiting');
        assert.deepEqual(work, [c.work, c.work]);
        assert.equal(await authorizeComputerMount(options, c.work), true, 'workflow outlives a released delivery lease');
    });
    await test('exact receipts settle once, including mount-only start and replacement', async () => {
        for (const operation of ['provision', 'start', 'replace'] as const) {
            const c = await setup(operation), lease = await claim(c);
            assert.equal(c.work.plan.mode, operation === 'provision' ? 'initialize' : 'mount');
            const result = await Promise.all([dispatchComputerMountClaim({ ...options, advanceMount: async w => mounted(w) }, lease),
                dispatchComputerMountClaim({ ...options, advanceMount: async w => mounted(w) }, lease)]);
            assert.deepEqual(result.sort(), ['mounted', 'stale']); assert.ok((await state(c)).mounted_at);
            assert.deepEqual(JSON.parse((await state(c)).receipt), mounted(c.work).receipt);
            assert.equal(await authorizeComputerMount(options, c.work), false);
        }
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_installations`)[0]!.n, 0, 'mount is not installation readiness');
    });
    await test('cross-computer claims and forged receipt fields cannot record success', async () => {
        const c = await setup(), other = await setup(), lease = await claim(c); let calls = 0;
        const o = { ...options, advanceMount: async () => { calls++; return mounted(other.work); } };
        assert.equal(await dispatchComputerMountClaim(o, { ...lease, computerId: other.computerId }), 'stale'); assert.equal(calls, 0);
        assert.equal(await dispatchComputerMountClaim(o, lease), 'waiting'); assert.equal((await state(c)).error_code, 'mount_receipt_invalid');
        assert.equal((await state(c)).mounted_at, null);
        for (const field of ['digest', 'filesystemUuid', 'unknown']) {
            const wrong = mounted(c.work);
            if (field === 'digest') wrong.receipt.digest = '0'.repeat(64);
            if (field === 'filesystemUuid') wrong.receipt.filesystemUuid = randomUUID();
            if (field === 'unknown') Object.assign(wrong.receipt, { secret: 'PRIVATE_VALUE' });
            assert.equal(await dispatchComputerMountClaim({ ...options, advanceMount: async () => wrong }, await claim(c)), 'waiting');
            assert.equal((await state(c)).mounted_at, null);
        }
    });
    await test('workflow reauthorization rejects altered work, deployments, expired or revoked grants', async () => {
        const c = await setup(); assert.equal(await authorizeComputerMount(options, c.work), true);
        const other = { ...c.work, authorization: { ...c.work.authorization, authorizationId: randomUUID() } };
        assert.equal(await authorizeComputerMount(options, other), false);
        assert.equal(await authorizeComputerMount({ ...options, deployments: [] }, c.work), false);
        assert.equal(await authorizeComputerMount(options, { ...c.work, deployment: { ...deployment, launchTemplateVersion: '2' } }), false);
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${c.authorizationId}`;
        assert.equal(await authorizeComputerMount(options, c.work), false);
        const old = await setup(); await expire(old);
        assert.equal(await authorizeComputerMount(options, old.work), false); await due(old);
        assert.equal(await claimComputerMount(options), null);
    });
    await test('revocation, stop, fence, expiry and disablement during delivery fence late receipts without held SQL locks', async () => {
        for (const reason of ['owner', 'grant', 'stop', 'fence', 'expiry', 'disable']) {
            const c = await setup(), lease = await claim(c);
            const o: MountDeliveryOptions = { ...options, advanceMount: async w => {
                await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='200ms'`;
                    await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
                    if (reason === 'owner') await tx`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
                    if (reason === 'grant') await tx`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${c.authorizationId}`;
                    if (reason === 'stop') await tx`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
                    if (reason === 'fence') await tx`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
                });
                if (reason === 'expiry') await expire(c);
                if (reason === 'disable') o.enabled = false;
                return mounted(w);
            } };
            assert.equal(await dispatchComputerMountClaim(o, lease), 'stale', reason); assert.equal((await state(c)).mounted_at, null);
        }
    });
    await test('lease takeover rejects the delayed attempt without changing the durable work', async () => {
        const c = await setup(), old = await claim(c); let enter!: () => void, release!: () => void;
        const started = new Promise<void>(r => { enter = r; }), proceed = new Promise<void>(r => { release = r; });
        const running = dispatchComputerMountClaim({ ...options, advanceMount: async w => { enter(); await proceed; return mounted(w); } }, old);
        await started;
        await sql`UPDATE ezil_computer_data_mount_deliveries SET lease_until=now()-interval '1 second' WHERE authorization_id=${c.authorizationId}`;
        const next = await claim(c); release(); assert.equal(await running, 'stale');
        assert.equal(next.attempt, old.attempt + 1); assert.equal((await state(c)).mounted_at, null);
        assert.equal(await dispatchComputerMountClaim({ ...options, advanceMount: async w => {
            assert.deepEqual(w, c.work); return mounted(w);
        } }, next), 'mounted');
    });
    await test('short leases and stopped writers never call the transport', async () => {
        const c = await setup(), lease = await claim(c); let calls = 0;
        const o = { ...options, advanceMount: async () => { calls++; throw new Error('must_not_call'); } };
        await sql`UPDATE ezil_computer_data_mount_deliveries SET lease_until=now()+interval '1 second' WHERE authorization_id=${c.authorizationId}`;
        assert.equal(await dispatchComputerMountClaim(o, lease), 'waiting'); assert.equal((await state(c)).error_code, 'mount_lease_short');
        const next = await claim(c);
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped' WHERE computer_id=${c.computerId}`;
        assert.equal(await dispatchComputerMountClaim(o, next), 'stale'); assert.equal(calls, 0);
    });
    await test('transport exceptions are redacted and failed receipt transactions remain retryable', async () => {
        const c = await setup();
        assert.equal(await dispatchComputerMountClaim({ ...options, advanceMount: async () => { throw new Error('PRIVATE_CREDENTIAL'); } }, await claim(c)), 'waiting');
        assert.equal((await state(c)).error_code, 'mount_delivery_failed');
        await sql.unsafe(`CREATE FUNCTION test_mount_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.mounted_at IS NOT NULL THEN RAISE EXCEPTION 'PRIVATE_DB_VALUE'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER test_mount_receipt_failure BEFORE UPDATE ON ezil_computer_data_mount_deliveries
            FOR EACH ROW EXECUTE FUNCTION test_mount_receipt_failure();`);
        const o = { ...options, advanceMount: async (w: ComputerMountWork) => mounted(w) };
        assert.equal(await dispatchComputerMountClaim(o, await claim(c)), 'waiting'); assert.equal((await state(c)).mounted_at, null);
        await sql.unsafe('DROP TRIGGER test_mount_receipt_failure ON ezil_computer_data_mount_deliveries; DROP FUNCTION test_mount_receipt_failure();');
        assert.equal(await dispatchComputerMountClaim(o, await claim(c)), 'mounted');
    });
    await test('unavailable earlier grants do not starve other computers or renew authority', async () => {
        const c = await setup(), next = await setup(); await due(c);
        await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
        assert.equal(await claimComputerMount(options), null); assert.equal((await state(c)).error_code, 'mount_authority_denied');
        assert.equal((await state(c)).attempts, 0);
        assert.equal((await claim(next)).computerId, next.computerId);
    });
    await test('timeout rejects even an abort handler returning a valid-looking receipt', async () => {
        const c = await setup(); let aborted = false;
        assert.equal(await dispatchComputerMountClaim({ ...options, advanceMount: (w, signal) => new Promise(resolve => {
            signal.addEventListener('abort', () => { aborted = true; resolve(mounted(w)); }, { once: true });
        }) }, await claim(c)), 'waiting');
        assert.equal(aborted, true); assert.equal((await state(c)).mounted_at, null); assert.equal((await state(c)).error_code, 'mount_delivery_failed');
    });
    console.log(`PASS ${passed} mount delivery database checks`);
} finally { await fixture.close(); }
