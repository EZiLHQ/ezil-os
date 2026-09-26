import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { issueComputerStart } from '../src/server/app-platform/computer-start-issuer';
import { produceComputerConfiguration } from '../src/server/app-platform/computer-configuration';
import { computerControlKeyIdentity } from '../src/server/app-platform/computer-control-key';
import { claimComputerStart, authorizeComputerStart, dispatchComputerStartClaim, dispatchNextComputerStart,
    type ComputerStartDeliveryOptions } from '../src/server/app-platform/computer-start-delivery';
import type { ComputerStartWork } from '../src/server/app-platform/computer-start-protocol';
import { createStartAuthorityHandler, START_AUTHORITY_PATH, startAuthoritySignature } from '../src/server/app-platform/computer-start-authority-http';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { dataMountComputer } from './fixtures/data-mount';
import { recordConfigurationMount } from './fixtures/configuration-mount';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
const policy = { accountId: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
    controlDomain: 'control.example.com', kmsKeyArn: deployment.dataKeyArn };
const options: ComputerStartDeliveryOptions = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite', deployments: [deployment],
    keys: { policy }, advanceStart: async () => ({ state: 'pending' }) };
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
async function setup() {
    const c = await dataMountComputer(sql), email = `${c.userId}@example.com`;
    await sql`UPDATE auth.users SET email=${email} WHERE id=${c.userId}`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'fixture')`;
    const mountAuthorizationId = await recordConfigurationMount(sql, c);
    const result = await produceComputerConfiguration(options, c.computerId); assert.ok('configurationId' in result);
    await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${result.configurationId}`;
    const issued = await issueComputerStart({ ...options, advance: async work => ({ state: 'observed', observedAt: new Date(), receipt: {
        schemaVersion: 1, computerId: c.computerId, jobId: c.jobId, digest: work.digest, generation: c.generation, fenceToken: c.fence,
        instanceId: c.instance, volumeId: c.volume, state: 'running' } }),
    keys: { policy, prepare: async work => ({ state: 'confirmed', versionId: work.versionId,
        secretArn: `${computerControlKeyIdentity(policy, work).arnPrefix}Ab12Cd` }) } },
    { computerId: c.computerId, configurationId: result.configurationId, mountAuthorizationId });
    assert.ok(issued.state === 'issued');
    return { ...c, email, mountAuthorizationId, configurationId: result.configurationId, authorizationId: issued.authorizationId };
}
type Computer = Awaited<ReturnType<typeof setup>>;
const state = async (c: Computer) => (await sql`SELECT * FROM ezil_computer_start_deliveries WHERE authorization_id=${c.authorizationId}`)[0]!;
async function due(c: Computer) {
    await sql`UPDATE ezil_computer_start_deliveries SET available_at=now()+interval '1 day' WHERE started_at IS NULL`;
    await sql`UPDATE ezil_computer_start_deliveries SET available_at=now() WHERE authorization_id=${c.authorizationId}`;
}
async function claim(c: Computer) { await due(c); const value = await claimComputerStart(options); assert.equal(value?.authorizationId, c.authorizationId); return value!; }
const started = (w: ComputerStartWork) => ({ state: 'started', receipt: { schemaVersion: 1, authorizationId: w.authorizationId,
    scope: w.scope, state: 'started', descriptor: { computerId: w.scope.computerId, computerGeneration: w.scope.computerGeneration,
        configurationRevision: w.configuration.revision, configurationDigest: w.configuration.digest } } });
async function capture(c: Computer) {
    let work: ComputerStartWork | undefined;
    assert.equal(await dispatchComputerStartClaim({ ...options, advanceStart: async w => { work = w; return { state: 'pending' }; } }, await claim(c)), 'waiting');
    assert.ok(work); return work;
}
async function expire(c: Computer) {
    await sql.begin(async tx => {
        await tx`ALTER TABLE ezil_computer_start_authorizations DISABLE TRIGGER ezil_start_authority_write_trg`;
        await tx`UPDATE ezil_computer_start_authorizations SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
            provider_observed_at=provider_observed_at-interval '1 hour' WHERE id=${c.authorizationId}`;
        await tx`ALTER TABLE ezil_computer_start_authorizations ENABLE TRIGGER ezil_start_authority_write_trg`;
    });
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled and malformed work never accesses DB or transport', async () => {
        const o = { ...options, database: null as never };
        assert.equal(await dispatchNextComputerStart({ ...o, enabled: false }), 'disabled');
        assert.equal(await claimComputerStart({ ...o, enabled: false }), null);
        for (const target of [null, {}, { computerId: randomUUID(), authorizationId: randomUUID(), extra: true }]) {
            assert.equal(await claimComputerStart(o, target as never), null);
        }
        assert.equal(await authorizeComputerStart(o, {}), false);
        assert.equal(await dispatchComputerStartClaim(o, {} as never), 'stale');
    });
    await test('concurrent leases and polls preserve one immutable work identity', async () => {
        const c = await setup(); await due(c);
        const claims = await Promise.all([claimComputerStart(options), claimComputerStart(options)]); assert.equal(claims.filter(Boolean).length, 1);
        let work: ComputerStartWork | undefined;
        assert.equal(await dispatchComputerStartClaim({ ...options, advanceStart: async w => { work = w; return { state: 'pending' }; } }, claims.find(Boolean)!), 'waiting');
        assert.deepEqual(await capture(c), work); assert.equal((await state(c)).started_at, null);
        assert.equal(await authorizeComputerStart(options, work), true);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_control_bindings WHERE computer_id=${c.computerId}`)[0]!.n, 1);
    });
    await test('workflow checks reject changed configuration, keys, scope and policy; replays recheck revocation', async () => {
        const c = await setup(), work = await capture(c); assert.equal(await authorizeComputerStart(options, work), true);
        for (const changed of [{ ...work, authorizationId: randomUUID() }, { ...work, mountAuthorizationId: randomUUID() },
            { ...work, configuration: { ...work.configuration, digest: '0'.repeat(64) } },
            { ...work, controlKey: { ...work.controlKey, versionId: randomUUID() } },
            { ...work, scope: { ...work.scope, providerInstanceId: 'i-99999999999999999' } }]) assert.equal(await authorizeComputerStart(options, changed), false);
        assert.equal(await authorizeComputerStart({ ...options, deployments: [] }, work), false);
        assert.equal(await authorizeComputerStart({ ...options, keys: { policy: { ...policy, controlDomain: 'other.example.com' } } }, work), false);
        await sql`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${c.authorizationId}`;
        assert.equal(await authorizeComputerStart(options, work), false);
    });
    await test('signed HTTP checks real DB authority without creating grants or reporting a host start', async () => {
        const c = await setup(), work = await capture(c), key = 'ab'.repeat(32);
        const handle = createStartAuthorityHandler({ enabled: true, secret: key, authorize: w => authorizeComputerStart(options, w) });
        const signed = (w: ComputerStartWork) => {
            const body = JSON.stringify(w), timestamp = String(Math.floor(Date.now()/1000));
            return new Request('https://control.example'+START_AUTHORITY_PATH, { method: 'POST', body,
                headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp,
                    'x-ezil-workflow-signature': startAuthoritySignature(Buffer.from(body), key, timestamp) } });
        };
        const req = signed(work), response = await handle(req.clone()); assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { authorized: true, work });
        assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
        const other = await setup(), foreign = await capture(other);
        for (const changed of [{ ...work, authorizationId: foreign.authorizationId },
            { ...work, mountAuthorizationId: foreign.mountAuthorizationId },
            { ...work, configuration: foreign.configuration },
            { ...work, scope: { ...work.scope, dataVolumeId: foreign.scope.dataVolumeId } },
            { ...work, controlKey: { ...work.controlKey, policy: { ...policy, controlDomain: 'untrusted.example.com' } } }]) {
            const denied = await handle(signed(changed)); assert.equal(denied.status, 403);
            assert.deepEqual(await denied.json(), { code: 'start_not_current' });
        }
        assert.equal((await state(c)).started_at, null);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_start_authorizations WHERE computer_id=${c.computerId}`)[0]!.n, 1);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_control_bindings WHERE computer_id=${c.computerId}`)[0]!.n, 1);
        await sql`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${c.authorizationId}`;
        assert.equal((await handle(req)).status, 403);
    });
    await test('signed HTTP replays fail after owner access, key, mount, writer or desired-state revocation', async () => {
        const key = 'ab'.repeat(32), handle = createStartAuthorityHandler({ enabled: true, secret: key,
            authorize: w => authorizeComputerStart(options, w) });
        for (const reason of ['access', 'key', 'mount', 'fence', 'stop']) {
            const c = await setup(), work = await capture(c), body = JSON.stringify(work), timestamp = String(Math.floor(Date.now()/1000));
            const req = new Request('https://control.example'+START_AUTHORITY_PATH, { method: 'POST', body,
                headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp,
                    'x-ezil-workflow-signature': startAuthoritySignature(Buffer.from(body), key, timestamp) } });
            assert.equal((await handle(req.clone())).status, 200);
            if (reason === 'access') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
            if (reason === 'key') await sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE computer_id=${c.computerId}`;
            if (reason === 'mount') await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${c.mountAuthorizationId}`;
            if (reason === 'fence') await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
            if (reason === 'stop') await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
            assert.equal((await handle(req)).status, 403, reason); assert.equal((await state(c)).started_at, null);
        }
    });
    await test('exact receipt settles once without completing configuration or apps', async () => {
        const c = await setup(), work = await capture(c), lease = await claim(c);
        const o = { ...options, advanceStart: async (w: ComputerStartWork) => started(w) };
        const result = await Promise.all([dispatchComputerStartClaim(o, lease), dispatchComputerStartClaim(o, lease)]);
        assert.deepEqual(result.sort(), ['stale', 'started']); assert.deepEqual(JSON.parse((await state(c)).receipt), started(work).receipt);
        assert.equal(await authorizeComputerStart(options, work), false);
        assert.equal((await sql`SELECT loaded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${c.configurationId}`)[0]!.loaded_at, null);
    });
    await test('foreign claims and receipt mutations cannot record startup', async () => {
        const c = await setup(), other = await setup(), lease = await claim(c); let calls = 0;
        const o = { ...options, advanceStart: async (w: ComputerStartWork) => { calls++; return started(w); } };
        assert.equal(await dispatchComputerStartClaim(o, { ...lease, computerId: other.computerId }), 'stale'); assert.equal(calls, 0);
        for (const reason of ['id', 'scope', 'digest', 'extra', 'mutate-work']) {
            assert.equal(await dispatchComputerStartClaim({ ...options, advanceStart: async w => {
                if (reason === 'mutate-work') w.configuration.digest = '0'.repeat(64);
                const result = started(w);
                if (reason === 'id') result.receipt.authorizationId = randomUUID();
                if (reason === 'scope') result.receipt.scope.fenceToken = randomUUID();
                if (reason === 'digest') result.receipt.descriptor.configurationDigest = '0'.repeat(64);
                if (reason === 'extra') Object.assign(result.receipt, { privateValue: 'PRIVATE_VALUE' });
                return result;
            } }, reason === 'id' ? lease : await claim(c)), 'waiting');
            assert.equal((await state(c)).error_code, 'start_receipt_invalid'); assert.equal((await state(c)).started_at, null);
        }
    });
    await test('authority changes during I/O fence receipts and never hold database locks', async () => {
        for (const reason of ['access', 'grant', 'mount', 'key', 'stop', 'fence', 'expiry', 'disable']) {
            const c = await setup(), lease = await claim(c);
            const o: ComputerStartDeliveryOptions = { ...options, advanceStart: async w => {
                await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
                    await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
                    if (reason === 'access') await tx`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
                    if (reason === 'grant') await tx`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${c.authorizationId}`;
                    if (reason === 'mount') await tx`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${c.mountAuthorizationId}`;
                    if (reason === 'key') await tx`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE computer_id=${c.computerId}`;
                    if (reason === 'stop') await tx`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
                    if (reason === 'fence') await tx`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
                });
                if (reason === 'expiry') await expire(c); if (reason === 'disable') o.enabled = false;
                return started(w);
            } };
            assert.equal(await dispatchComputerStartClaim(o, lease), 'stale', reason); assert.equal((await state(c)).started_at, null);
        }
    });
    await test('lease takeover rejects delayed workers and does not change the durable work', async () => {
        const c = await setup(), expected = await capture(c), old = await claim(c); let enter!: () => void, release!: () => void;
        const entered = new Promise<void>(r => { enter = r; }), wait = new Promise<void>(r => { release = r; });
        const running = dispatchComputerStartClaim({ ...options, advanceStart: async w => { enter(); await wait; return started(w); } }, old);
        await entered; await sql`UPDATE ezil_computer_start_deliveries SET lease_until=now()-interval '1 second' WHERE authorization_id=${c.authorizationId}`;
        const next = await claim(c); release(); assert.equal(await running, 'stale'); assert.equal(next.attempt, old.attempt+1);
        assert.equal(await dispatchComputerStartClaim({ ...options, advanceStart: async w => { assert.deepEqual(w, expected); return started(w); } }, next), 'started');
    });
    await test('short leases and expired authority cannot dispatch', async () => {
        const c = await setup(), lease = await claim(c); let calls = 0;
        const o = { ...options, advanceStart: async () => { calls++; throw new Error('unexpected'); } };
        await sql`UPDATE ezil_computer_start_deliveries SET lease_until=now()+interval '1 second' WHERE authorization_id=${c.authorizationId}`;
        assert.equal(await dispatchComputerStartClaim(o, lease), 'waiting'); assert.equal(calls, 0);
        assert.equal((await state(c)).error_code, 'start_lease_short'); await expire(c); await due(c);
        assert.equal(await claimComputerStart(o), null); assert.equal(calls, 0);
    });
    await test('unavailable work backs off without starving a later computer or issuing replacement authority', async () => {
        const c = await setup(), next = await setup(); await due(c);
        await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
        assert.equal(await claimComputerStart(options), null); assert.equal((await state(c)).attempts, 0);
        assert.equal((await state(c)).error_code, 'start_authority_denied'); assert.equal((await claim(next)).computerId, next.computerId);
    });
    await test('abort replies cannot settle and transport failures are redacted', async () => {
        const c = await setup();
        assert.equal(await dispatchComputerStartClaim({ ...options, advanceStart: async () => { throw new Error('PRIVATE_KEY'); } }, await claim(c)), 'waiting');
        assert.equal((await state(c)).error_code, 'start_delivery_failed');
        const original = globalThis.setTimeout;
        globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => original(fn, ms === 20000 ? 10 : ms, ...args)) as typeof setTimeout;
        try {
            assert.equal(await dispatchComputerStartClaim({ ...options, advanceStart: (w, signal) => new Promise(resolve => {
                signal.addEventListener('abort', () => resolve(started(w)), { once: true });
            }) }, await claim(c)), 'waiting');
        } finally { globalThis.setTimeout = original; }
        assert.equal((await state(c)).started_at, null);
    });
    console.log(`PASS ${passed} startup delivery database checks`);
} finally { await fixture.close(); }
