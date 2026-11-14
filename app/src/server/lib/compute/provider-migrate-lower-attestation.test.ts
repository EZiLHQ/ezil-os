/**
 * A Cloudflare → AWS migration's first host attests the lower it booted (enroll.py `committed_digest`).
 * Before the flip the published placement is still Cloudflare, so the boot enrolls against the migration
 * intent (provider-migrate-provision.ts). That attestation must reach the published AWS row with the
 * placement itself, or the first cold open after the move is refused as `computer_rebase_required`
 * (aws-ec2.ts) although the volume is on the deployment's lower.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AWS_BROWSER_ZONE_ENV, handleAwsEnrollment, nonceHashOf, type Ec2EnrollmentView, type EnrollDeps, type TunnelClient } from './aws-enroll';
import { AWS_IDENTITY_CERTS_ENV } from './aws-identity';
import fx from './aws-identity.fixtures.json';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import { fixtureDeployment, fixtureRebaseDeployments } from './aws-intent.test-support';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { ENROLLMENT_FAILED, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, flipPlacementToAws, readRecordedLowerDigest, transitionPlacementAsReconciler,
    type Placement, type PlacementDb } from './placement';
import { consumeMigrationEnrollment, finishMigrationEnrollment, provisionFor, readEnrollmentPlacement } from './provider-migrate-provision';
import { createMigrationRuntime } from './provider-migrate-runtime';
import { MigrationConflictError, type ComputeMigration } from './provider-migrate-store';

const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('./provider-migrate-store', async original => ({ ...await original<typeof import('./provider-migrate-store')>(), createProviderMigrationStore: () => fake.store }));
vi.mock('./aws-clients', () => ({ sharedAwsSdkCollaborators: () => { throw new Error('AWS collaborators must be injected in tests'); } }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('No DB in tests'); } }));

const U = '11111111-1111-4111-8111-111111111111', C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', M = '33333333-3333-4333-8333-333333333333';
const FS = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', FENCE = 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd';
const NOW = new Date('2026-10-20T00:00:00Z'); // after the identity fixture certificates' notBefore
const NONCE = Buffer.alloc(32, 5).toString('base64url');
const DOC = JSON.parse(fx.document) as { instanceId: string; availabilityZone: string; instanceType: string };
// The deployment's current lower in the rebase fixture: the cold-open fence's comparison value.
const DIGEST = fixtureRebaseDeployments().deployment.lowerImageDigest!;
const OTHER = 'sha256:' + 'c'.repeat(64);
const VOLUME = 'vol-11111111111111111';

/** The hidden migration boot (generation 1, epoch 1) as `provision` records it, before any host enrolled. */
const intentPlacement = (): Placement => ({ computerId: C, ownerUserId: U, provider: 'aws-ec2', store: 'ebs', state: 'PROVISIONING',
    generation: 1, leaseEpoch: 1, region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: null, instanceType: DOC.instanceType,
    volumeId: null, fsUuid: FS, tunnelId: null, enrollNonceHash: nonceHashOf(NONCE), enrollExpiresAt: new Date(NOW.getTime() + 300_000),
    enrollConsumedHash: null, leaseUntil: new Date(NOW.getTime() + 3_600_000), presenceAt: null, fenceToken: FENCE,
    lifecycleJobId: '44444444-4444-4444-8444-444444444444', lifecycleDigest: 'd'.repeat(64), lastError: null, updatedAt: NOW });

/** An in-memory migration row: jsonb round trip (Dates become ISO text) and the store's updated_at CAS. */
function migration(state: ComputeMigration['state'] = 'provisioning') {
    let n = 1;
    let m = { id: M, computerId: C, userId: U, fromProvider: 'cloudflare', toProvider: 'aws-ec2', toSize: 'standard', state, generation: M,
        workspaceHead: { generation: M, _awsProvision: JSON.parse(JSON.stringify({ placement: intentPlacement(),
            deployment: fixtureDeployment('ap-south-1'), source: null, reservedAt: NOW.toISOString() })) },
        systemHead: null, sourceEtag: 'etag', sourceSystemEtag: null, restoreTokenSha256: null, restoreTokenExpiresAt: null,
        createdAt: '0', updatedAt: '1', attempts: 0, lastError: null } as unknown as ComputeMigration;
    const store = {
        readById: vi.fn(async () => m),
        readActiveByComputer: vi.fn(async () => ['committed', 'failed_reopened', 'failed_needs_operator'].includes(m.state) ? null : m),
        saveProvision: vi.fn(async (expected: ComputeMigration, provision: unknown) => {
            if (expected.updatedAt !== m.updatedAt || expected.state !== m.state) throw new MigrationConflictError();
            m = { ...m, workspaceHead: { generation: M, _awsProvision: JSON.parse(JSON.stringify(provision)) }, updatedAt: String(++n) };
        }),
    };
    fake.store = store;
    return { store, get: () => m, set: (patch: Partial<ComputeMigration>) => { m = { ...m, ...patch }; } };
}

/** Published Cloudflare row plus the flip's migration row lock and source removal (as provider-migrate-placement.test.ts). */
function placements(mig: ReturnType<typeof migration>) {
    const f = createFakePlacementDb({ computers: [{ id: C, user_id: U }],
        placements: [placementRow({ computer_id: C, owner_user_id: U, provider: 'cloudflare', workspace_store: 'r2', state: 'RUNNING' })] },
    { clock: () => NOW });
    const dialect = new PgDialect();
    const answer = (tx: { execute: PlacementDb['execute'] }): { execute: PlacementDb['execute'] } => ({ execute: async query => {
        const q = dialect.sqlToQuery(query);
        if (q.sql.startsWith('SELECT state, user_id::text') && q.sql.includes('FROM public.ezil_compute_migrations')) {
            const m = mig.get();
            return { rows: [{ state: m.state, user_id: m.userId, computer_id: m.computerId, to_provider: m.toProvider, last_error: m.lastError }] };
        }
        if (q.sql.includes('placement:migration-remove')) {
            const removed = f.placements.filter(r => r.computer_id === C && r.provider === 'cloudflare' && r.state === 'RETIRED');
            for (const r of removed) f.placements.splice(f.placements.indexOf(r), 1);
            return { rows: removed.map(r => ({ computer_id: r.computer_id })) };
        }
        return tx.execute(query);
    } });
    const db: PlacementDb = {
        execute: f.db.execute,
        async transaction(fn) {
            const before = structuredClone(f.placements);
            try { return await f.db.transaction(tx => fn(answer(tx))); }
            catch (error) { f.placements.splice(0, f.placements.length, ...before); throw error; }
        },
    };
    return { ...f, db };
}

const liveTags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:computer-id': C, 'ezil:generation': '1', 'ezil:fence-token': FENCE };
const view = (): Ec2EnrollmentView => ({ instanceId: DOC.instanceId, state: 'running', availabilityZone: DOC.availabilityZone, availabilityZoneId: 'aps1-az1',
    publicIp: '13.0.0.5', tags: liveTags, volumes: [
        { volumeId: VOLUME, deleteOnTermination: false, tags: { ...liveTags } },
        { volumeId: 'vol-99999999999999999', deleteOnTermination: true, tags: { ...liveTags, 'ezil:disk-kind': 'root' } }] });
const body = (lowerImageDigest?: string) => ({ computerId: C, generation: 1, leaseEpoch: 1, nonce: NONCE, identityDocument: fx.document,
    signature: fx.pkcs7_rsa_detached, ...(lowerImageDigest ? { lowerImageDigest } : {}) });

/** Tunnel client: the first create is ambiguous (thrown); replays find the tunnel only once a create committed. */
function tunnels(firstThrows: boolean) {
    let created = false, throwNext = firstThrows;
    const calls: { replay: boolean }[] = [];
    const client: TunnelClient = {
        async createTunnel(_owner, request) {
            calls.push({ replay: request.replay === true });
            if (throwNext) { throwNext = false; created = true; throw new Error('socket'); }
            if (request.replay) return created ? { ok: true, tunnelToken: 'tunnel-token-' + 'x'.repeat(40) } : { ok: false, status: 404, code: 'tunnel_not_found' };
            if (created) return { ok: false, status: 409, code: 'tunnel_exists' };
            created = true;
            return { ok: true, tunnelToken: 'tunnel-token-' + 'x'.repeat(40) };
        },
        deleteTunnel: async () => ({ ok: true }),
    };
    return { client, calls };
}

function enrollDeps(db: PlacementDb, tunnel: TunnelClient, clock: () => Date = () => NOW): EnrollDeps {
    return { db, now: clock, controlKeySecret: 'control-key-secret-for-tests', tunnels: tunnel,
        env: { EZIL_AWS_COMPUTERS_ENABLED: '1', [AWS_IDENTITY_CERTS_ENV]: JSON.stringify({ 'ap-south-1': fx.cert_rsa }),
            [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': fixtureDeployment('ap-south-1', ['t3a.medium', 'm6i.large']) }),
            [AWS_BROWSER_ZONE_ENV]: 'ezil.org' },
        describer: { describeForEnrollment: async () => view() } };
}

const attestationOf = (m: ComputeMigration) => (provisionFor(m) as unknown as { lowerAttestation?: unknown }).lowerAttestation;

beforeEach(() => {
    fake.store = {};
    // consumeMigrationEnrollment reads the nonce deadline against Date.now(); only the clock is faked.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('a migrated volume keeps the lower its first host attested', () => {
    it('consume → retry → finish → flip publishes the attested digest and server time; the stopped row passes the cold-open fence', async () => {
        let clock = NOW;
        const mig = migration(), f = placements(mig), t = tunnels(true), deps = enrollDeps(f.db, t.client, () => clock);
        // 1. The ambiguous tunnel create leaves the consumed boot pending (retryable): the host keeps its nonce.
        // main also returns its enrollment diagnostics (subject/tunnel); status and body stay exact.
        const pending = await handleAwsEnrollment(deps, body(DIGEST));
        expect({ status: pending.status, body: pending.body }).toEqual({ status: 503, body: { error: 'tunnel_unavailable', retryable: true } });
        expect(provisionFor(mig.get())!.placement).toMatchObject({ lastError: ENROLLMENT_PENDING, enrollNonceHash: null, instanceId: DOC.instanceId, volumeId: VOLUME });
        // 2. The host's retry of the SAME boot (a minute later) finishes on the tunnel the first attempt created.
        clock = new Date(NOW.getTime() + 60_000);
        const retried = await handleAwsEnrollment(deps, body(DIGEST));
        expect(retried.body).not.toMatchObject({ error: 'host_digest_mismatch' });
        expect(retried.status).toBe(200);
        expect(attestationOf(mig.get())).toEqual({ lowerImageDigest: DIGEST, observedAt: NOW.toISOString() });
        expect(provisionFor(mig.get())!.placement.lastError).toBe(ENROLLMENT_SUCCEEDED);
        // 3. An exact replay of the completed enrollment (its 200 lost) is still answered.
        expect((await handleAwsEnrollment(deps, body(DIGEST))).status).toBe(200);
        // Neither the retry nor the replay re-observes: the original server time stays.
        expect(attestationOf(mig.get())).toEqual({ lowerImageDigest: DIGEST, observedAt: NOW.toISOString() });
        expect(f.placements).toEqual([expect.objectContaining({ provider: 'cloudflare' })]);
        // 4. Restored, then published: the AWS row carries the attestation, never anything else.
        mig.set({ state: 'restored' });
        await createMigrationRuntime(f.db).flip(mig.get());
        expect(f.placements).toHaveLength(1);
        expect(f.placements[0]).toMatchObject({ provider: 'aws-ec2', state: 'PROVISIONING', lower_image_digest: DIGEST, last_error: `migration_pending:${M}` });
        expect(new Date(f.placements[0]!.lower_digest_observed_at as string | Date).toISOString()).toBe(NOW.toISOString());
        // 5. A later normal stop keeps it, and the cold-open fence (aws-ec2.ts) compares equal.
        const published = (await readEnrollmentPlacement(f.db, C)).record!;
        expect((await transitionPlacementAsReconciler(f.db, { computerId: C, expected: published, to: 'STOPPED' })).ok).toBe(true);
        expect(f.placements[0]!.state).toBe('STOPPED');
        // aws-ec2.ts cold-open fence, verbatim: refuse when the deployment names a lower the volume did not record.
        const refused = async (lowerImageDigest: string) => !!lowerImageDigest && await readRecordedLowerDigest(f.db, C) !== lowerImageDigest;
        expect(await refused(fixtureRebaseDeployments().deployment.lowerImageDigest!)).toBe(false);
        // A deployment that has since moved to another lower is still refused: release drift is never hidden.
        expect(await refused(OTHER)).toBe(true);
    });

    it('the existing consume → finish → flip functions publish the digest the host enrolled with (not null)', async () => {
        const mig = migration(), f = placements(mig), p = (await readEnrollmentPlacement(f.db, C)).record!;
        const consumed = await consumeMigrationEnrollment(f.db, { computerId: C, expected: p, nonceHash: nonceHashOf(NONCE),
            fields: { instanceId: DOC.instanceId, volumeId: VOLUME }, lowerImageDigest: DIGEST, observedAt: NOW });
        if (!consumed.ok) throw new Error('consume');
        expect((await finishMigrationEnrollment(f.db, { computerId: C, expected: consumed.placement, success: true })).ok).toBe(true);
        mig.set({ state: 'restored' });
        await createMigrationRuntime(f.db).flip(mig.get());
        expect(await readRecordedLowerDigest(f.db, C)).toBe(DIGEST);
    });

    it('a retry with a DIFFERENT digest is refused and the original attestation is unchanged', async () => {
        const mig = migration(), f = placements(mig), t = tunnels(true), deps = enrollDeps(f.db, t.client);
        expect((await handleAwsEnrollment(deps, body(DIGEST))).status).toBe(503);
        const before = structuredClone(mig.get());
        const mismatch = await handleAwsEnrollment(deps, body(OTHER));
        expect({ status: mismatch.status, body: mismatch.body }).toEqual({ status: 403, body: { error: 'host_digest_mismatch' } });
        expect(mig.get()).toEqual(before);
        expect(t.calls).toHaveLength(1);
    });

    it('a legacy boot that attested nothing publishes no lower: the cold open stays refused (fail closed)', async () => {
        const mig = migration(), f = placements(mig), deps = enrollDeps(f.db, tunnels(false).client);
        expect((await handleAwsEnrollment(deps, body())).status).toBe(200);
        expect(attestationOf(mig.get())).toBeUndefined();
        // Its retry cannot introduce a digest after the fact either.
        expect((await handleAwsEnrollment(deps, body(DIGEST))).body).toMatchObject({ error: 'host_digest_mismatch' });
        mig.set({ state: 'restored' });
        await createMigrationRuntime(f.db).flip(mig.get());
        // The fake row has no column where the database has its NULL default.
        expect(f.placements[0]).toMatchObject({ provider: 'aws-ec2' });
        expect(f.placements[0]!.lower_image_digest ?? null).toBeNull(); expect(f.placements[0]!.lower_digest_observed_at ?? null).toBeNull();
        expect(await readRecordedLowerDigest(f.db, C)).toBeNull();
    });
});

describe('the migration attestation is written only with a valid consume', () => {
    const input = (p: Placement, over: Record<string, unknown> = {}) => ({ computerId: C, expected: p, nonceHash: nonceHashOf(NONCE),
        fields: { instanceId: DOC.instanceId, volumeId: VOLUME }, lowerImageDigest: DIGEST, observedAt: NOW, ...over });

    it.each([
        ['a malformed digest', { lowerImageDigest: 'sha256:' + 'Z'.repeat(64) }],
        ['an unprefixed digest', { lowerImageDigest: 'b'.repeat(64) }],
        ['an invalid observation time', { observedAt: new Date(Number.NaN) }],
        ['a digest without its observation time', { observedAt: undefined }],
    ] as const)('%s is refused before anything is written', async (_name, over) => {
        const mig = migration(), f = placements(mig), before = structuredClone(mig.get());
        const p = (await readEnrollmentPlacement(f.db, C)).record!;
        await expect(consumeMigrationEnrollment(f.db, input(p, over))).rejects.toThrow();
        expect(mig.get()).toEqual(before);
        expect(mig.store.saveProvision).not.toHaveBeenCalled();
    });

    it.each(['nonce', 'generation', 'lease', 'expired'])('a stale %s consumes nothing and attests nothing', async guard => {
        const mig = migration(), f = placements(mig);
        if (guard === 'expired') {
            const intent = provisionFor(mig.get())!; intent.placement.enrollExpiresAt = new Date(0);
            await mig.store.saveProvision(mig.get(), intent); mig.store.saveProvision.mockClear();
        }
        const before = structuredClone(mig.get()), p = (await readEnrollmentPlacement(f.db, C)).record!;
        const result = await consumeMigrationEnrollment(f.db, input({ ...p, generation: guard === 'generation' ? 9 : p.generation,
            leaseEpoch: guard === 'lease' ? 9 : p.leaseEpoch }, guard === 'nonce' ? { nonceHash: 'f'.repeat(64) } : {}));
        expect(result.ok).toBe(false);
        expect(mig.get()).toEqual(before);
        expect(attestationOf(mig.get())).toBeUndefined();
    });

    it('is immutable: a second consume of the same boot neither succeeds nor replaces it', async () => {
        const mig = migration(), f = placements(mig), p = (await readEnrollmentPlacement(f.db, C)).record!;
        expect((await consumeMigrationEnrollment(f.db, input(p))).ok).toBe(true);
        const before = structuredClone(mig.get());
        expect((await consumeMigrationEnrollment(f.db, input(p, { lowerImageDigest: OTHER }))).ok).toBe(false);
        expect(mig.get()).toEqual(before);
        expect(attestationOf(mig.get())).toEqual({ lowerImageDigest: DIGEST, observedAt: NOW.toISOString() });
    });

    it('a failed finish keeps the attestation with the failed boot; it is never published (no flip from UNCONFIRMED)', async () => {
        const mig = migration(), f = placements(mig), p = (await readEnrollmentPlacement(f.db, C)).record!;
        const consumed = await consumeMigrationEnrollment(f.db, input(p));
        if (!consumed.ok) throw new Error('consume');
        expect((await finishMigrationEnrollment(f.db, { computerId: C, expected: consumed.placement, success: false })).ok).toBe(true);
        expect(provisionFor(mig.get())!.placement).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED });
        expect(attestationOf(mig.get())).toEqual({ lowerImageDigest: DIGEST, observedAt: NOW.toISOString() });
        expect(f.placements).toEqual([expect.objectContaining({ provider: 'cloudflare' })]);
    });
});

describe('publication of the attestation with the AWS placement', () => {
    const attested = { lowerImageDigest: DIGEST, observedAt: NOW.toISOString() };
    const flipInput = (lowerAttestation?: typeof attested) => ({ computerId: C, ownerUserId: U, migrationId: M, pendingReady: true,
        fields: { region: 'ap-south-1' as const, instanceId: DOC.instanceId, volumeId: VOLUME, fsUuid: FS, fenceToken: FENCE,
            lastError: `migration_pending:${M}` }, ...(lowerAttestation ? { lowerAttestation } : {}) });

    it('a repeated flip returns the same row and keeps the same lower', async () => {
        const mig = migration('restored'), f = placements(mig);
        const first = await flipPlacementToAws(f.db, flipInput(attested));
        expect(await flipPlacementToAws(f.db, flipInput(attested))).toEqual(first);
        expect(f.placements).toHaveLength(1);
        expect(f.placements[0]!.lower_image_digest).toBe(DIGEST);
    });

    it('a repeated flip that disagrees with the published lower is refused and changes nothing', async () => {
        const mig = migration('restored'), f = placements(mig);
        await flipPlacementToAws(f.db, flipInput(attested));
        const before = structuredClone(f.placements);
        await expect(flipPlacementToAws(f.db, flipInput({ ...attested, lowerImageDigest: OTHER }))).rejects.toThrow('migration_placement_conflict');
        expect(f.placements).toEqual(before);
    });

    it('a repeated attested flip never backfills a row published without a lower (legacy stays null, fail closed)', async () => {
        const mig = migration('restored'), f = placements(mig);
        await flipPlacementToAws(f.db, flipInput());
        const before = structuredClone(f.placements);
        await expect(flipPlacementToAws(f.db, flipInput(attested))).rejects.toThrow('migration_placement_conflict');
        expect(f.placements).toEqual(before);
        expect(await readRecordedLowerDigest(f.db, C)).toBeNull();
    });

    it('a failed lower write rolls the AWS publication back with it (the Cloudflare row is kept)', async () => {
        const mig = migration('restored'), f = placements(mig), before = structuredClone(f.placements);
        const dialect = new PgDialect(), tx = f.db.transaction;
        f.db.transaction = fn => tx(t => fn({ execute: async query => {
            if (dialect.sqlToQuery(query).sql.includes('placement:migration-lower')) throw new Error('write failed');
            return t.execute(query);
        } }));
        await expect(flipPlacementToAws(f.db, flipInput(attested))).rejects.toThrow('write failed');
        expect(f.placements).toEqual(before);
    });

    it.each([
        ['a malformed digest', { lowerImageDigest: 'sha256:xyz', observedAt: NOW.toISOString() }],
        ['a malformed time', { lowerImageDigest: DIGEST, observedAt: 'yesterday' }],
    ])('%s rolls the whole publication back (the Cloudflare row is kept)', async (_name, bad) => {
        const mig = migration('restored'), f = placements(mig), before = structuredClone(f.placements);
        await expect(flipPlacementToAws(f.db, flipInput(bad))).rejects.toThrow('migration_aws_receipt_invalid');
        expect(f.placements).toEqual(before);
    });
});
