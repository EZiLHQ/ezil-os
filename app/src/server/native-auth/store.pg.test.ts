import { acceptedDeploymentFixture } from '@/server/native-session/accepted-policy.test-support';
import { createProductionNativeAiPort } from '@/server/native-session/production';
/**
 * Disposable PostgreSQL only (`EZIL_PG_TEST_URL`): every run creates its own random schema
 * `native_auth_intent_test_*` and drops it afterwards. Never imports the app DB, never touches another
 * lane's tables or schemas, and never reads credentials.
 */
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runNativeOperation, type NativeSessionDeps } from '@/server/native-session/http';
import { fixtureConfig, fixtureKeys, jsonResponse, type FixtureKeys } from '@/server/native-session/native-authorization.test-support';
import { NativeAuthorizationConfig } from '@/server/native-session/native-authorization-config';
import { prepareNativeRevoke, dispatchNativeOperationOnce, openNativeGrantCandidate, readNativeAuthorizationOperation } from '@/server/native-session/native-authorization-outbox';
import type { PlacementExecutor } from '@/server/lib/compute/placement';
import { claimNativeOperation, type NativeAuthorityDb } from '@/server/native-session/authority';

import { readApprovedNativeConsentBinding, readApprovedNativeConsentBindingTx, readNativeConsentHistory } from './consent-binding';
import { nativeInstructionDigest, nativeIntentInputDigest, type NativeConsentTermsConfig, type NativeCreateIntentInput } from './contract';
import {
    approveNativeIntent, blockApprovedNativeIntent, decideNativeIntent, deriveRenewNativeIntent, insertNativeIntent, lookupNativeIntent,
    nativeArtifactTaskResolver, nativeConsentRevokedAt, readNativeConsentRevocation, revokeNativeConsent, type NativeIntent,
} from './store';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `native_auth_intent_test_${randomUUID().replaceAll('-', '')}`;
const ROOT = path.resolve(__dirname, '../../../..');
const ACTOR = { clientId: 'ezil-mcp-staging', idpIssuer: 'https://id.ezil.work/', subject: 'auth0|abc', scope: 'ezil:native-sessions:read ezil:native-sessions:write' };
const TERMS: NativeConsentTermsConfig = { policyId: '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b', epoch: '7', budgetMicro: '2500000', ttlSeconds: 86_400 };
const GENERATION = '3000000001'; // above int4: counters stay bigint end to end
const LEASE_EPOCH = '4294967301';

describe.skipIf(!PG)('native auth intent store on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 12, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: NativeAuthorityDb = {
        execute: q => executor(production!).execute(q),
        transaction: fn => production!.transaction(tx => fn(executor(tx))),
    };
    const rows = (q: string, ...args: unknown[]) => client!.unsafe(local(q), args as never[]);
    const refused = async (q: string, ...args: unknown[]) => {
        await expect(rows(q, ...args), q).rejects.toThrow();
    };

    let created = false;
    let keys: FixtureKeys;
    beforeAll(async () => {
        keys = await fixtureKeys();
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        await client!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated;
            CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot smallint NOT NULL DEFAULT 1,
                deleted_at timestamptz NULL)`);
        for (const file of ['docs/aws-computers/sql/0001_compute_placement.sql.txt', 'docs/aws-computers/sql/0002_image_rebase.sql.txt',
            'app/drizzle/0029_native_session_operations.sql', 'app/drizzle/0031_native_auth_intents.sql', 'app/drizzle/0033_native_grant_outbox.sql']) {
            await client!.unsafe(local(readFileSync(path.join(ROOT, file), 'utf8')));
        }
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    type Seed = { userId: string; computerId: string; sessionId: string; operationId: string; fence: string; instance: string };
    const seed = async (placement: Record<string, string> = {}): Promise<Seed> => {
        const s = { userId: randomUUID(), computerId: randomUUID(), sessionId: randomUUID(), operationId: randomUUID(), fence: randomUUID(),
            instance: `i-${randomUUID().replaceAll('-', '').slice(0, 17)}` };
        await rows('INSERT INTO public.ezil_computers (id, user_id) VALUES ($1, $2)', s.computerId, s.userId);
        const p = { generation: GENERATION, lease_epoch: LEASE_EPOCH, state: 'RUNNING', ...placement };
        await rows(`INSERT INTO public.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch,
            state, instance_id, instance_type, volume_id, fence_token, lease_until, updated_at)
            VALUES ($1, $2, 'aws-ec2', 'ebs', $3::bigint, $4::bigint, $5, $6, 'm6i.large', 'vol-11111111111111111', $7::uuid, now() + interval '10 minutes', now())`,
        s.computerId, s.userId, p.generation, p.lease_epoch, p.state, s.instance, s.fence);
        return s;
    };
    const input = (s: Seed, instruction = 'run the tests\n'): NativeCreateIntentInput => ({
        kind: 'create', operationId: s.operationId, sessionId: s.sessionId, computerId: s.computerId, instructionRevision: 1,
        instructionDigest: nativeInstructionDigest(instruction), instruction,
    });
    const prepared = async (s: Seed, instruction?: string) => {
        const i = input(s, instruction);
        const result = await insertNativeIntent(db, s.userId, i, s.computerId, nativeIntentInputDigest(i), ACTOR);
        if (result.kind !== 'inserted') throw new Error(`expected insert, got ${result.kind}`);
        return result.intent;
    };
    const approve = async (s: Seed, intent: NativeIntent, terms = TERMS) => {
        const result = await approveNativeIntent(db, s.userId, s.operationId, s.computerId, intent.inputDigest, terms);
        if (result.kind !== 'approved') throw new Error(`expected approval, got ${JSON.stringify(result)}`);
        return result.intent;
    };
    const claim = (s: Seed, expectPlacement?: { generation: string; leaseEpoch: string; instanceId: string; fenceToken: string }) =>
        claimNativeOperation(db, s.userId, { kind: 'create', operationId: s.operationId, sessionId: s.sessionId, computerId: s.computerId,
            instructionRevision: 1, instructionDigest: nativeInstructionDigest('run the tests\n'), taskRef: `native-task:${s.operationId}` },
        expectPlacement ? { expectPlacement } : {});
    const renewIntent = async (s: Seed, clientId = ACTOR.clientId) => {
        const renew = { kind: 'renew' as const, operationId: randomUUID(), sessionId: s.sessionId };
        const result = await insertNativeIntent(db, s.userId, renew, s.computerId, nativeIntentInputDigest(renew), { ...ACTOR, clientId });
        if (result.kind !== 'inserted') throw new Error('expected renewal insert');
        return result.intent;
    };

    it('stores the exact bytes with a fixed five-minute challenge and replays the same key without writing', async () => {
        for (const text of ['  spaced  \n', 'café', '😀 x', 'a'.repeat(16_384)]) {
            const s = await seed();
            const intent = await prepared(s, text);
            expect(intent).toMatchObject({ instruction: text, state: 'required', terms: null });
            expect(intent.expiresAt.getTime() - intent.createdAt.getTime()).toBe(300_000);
            const again = await insertNativeIntent(db, s.userId, input(s, text), s.computerId, intent.inputDigest, ACTOR);
            expect(again).toMatchObject({ kind: 'existing', intent: { createdAt: intent.createdAt, inputDigest: intent.inputDigest } });
        }
        const s = await seed();
        await prepared(s);
        expect(await insertNativeIntent(db, s.userId, input({ ...s, operationId: randomUUID() }), s.computerId, `sha256:${'b'.repeat(64)}`, ACTOR))
            .toEqual({ kind: 'session_exists' });
    });

    it('refuses NULL or inconsistent instruction metadata (IS TRUE, not NULL-tolerant)', async () => {
        const s = await seed();
        const base = `INSERT INTO public.ezil_native_auth_intents (user_id, operation_id, kind, session_id, computer_id, instruction_revision,
            instruction_digest, instruction, instruction_bytes, input_digest, client_id, idp_issuer, subject, scope, state, created_at, expires_at, updated_at)
            VALUES ($1, gen_random_uuid(), $2, gen_random_uuid(), $3, $4, $5, $6, $7, $8, 'c', 'i', 's', 'ezil:native-sessions:write', 'required',
                now(), now() + interval '5 minutes', now())`;
        const d = nativeInstructionDigest('x');
        const good = `sha256:${'c'.repeat(64)}`;
        for (const [kind, revision, digest, text, bytes] of [
            ['create', null, d, 'x', 1], ['create', 1, null, 'x', 1], ['create', 1, d, null, 1], ['create', 1, d, 'x', null],
            ['create', 2, d, 'x', 1], ['create', 1, d, 'x', 2], ['create', 1, d, '', 0], ['create', 1, d.toUpperCase(), 'x', 1],
            ['renew', 1, null, null, null], ['renew', null, d, null, null], ['renew', null, null, 'x', null], ['renew', null, null, null, 1],
        ] as const) {
            await refused(base, s.userId, kind, s.computerId, revision, digest, text, bytes, good);
        }
        await refused(base.replace("interval '5 minutes'", "interval '6 minutes'"), s.userId, 'create', s.computerId, 1, d, 'x', 1, good);
    });

    it('refuses partial, NULL-holed or out-of-range consent terms', async () => {
        const s = await seed();
        const intent = await approve(s, await prepared(s));
        const terms = intent.terms!;
        expect(terms).toMatchObject({ epoch: '7', budgetMicro: '2500000', policyId: TERMS.policyId, service: 'ezil-os-native', profile: 'ezil-native-claude-v1',
            placement: { generation: GENERATION, leaseEpoch: LEASE_EPOCH, instanceId: s.instance, fenceToken: s.fence } });
        expect(terms.initialApprovalAt.getTime() % 1).toBe(0);
        expect(terms.initialApprovalAt).toEqual(intent.decidedAt);
        expect(terms.authorizationDeadline.getTime() - terms.initialApprovalAt.getTime()).toBe(86_400_000);
        // A raw row with any terms column NULL (and others set), zero counters or a deadline beyond 24 hours never stores.
        const insert = (overrides: Record<string, string>) => {
            const cols: Record<string, string> = {
                authz_id: 'gen_random_uuid()', consent_epoch: "'1'", budget_micro: "'1'", policy_id: 'gen_random_uuid()', service: "'ezil-os-native'",
                profile: "'ezil-native-claude-v1'", initial_approval_at: "date_trunc('milliseconds', now())",
                authorization_deadline: "date_trunc('milliseconds', now()) + interval '1 hour'", approved_placement_generation: '1',
                approved_placement_lease_epoch: '1', approved_placement_instance_id: "'i-0123456789abcdef0'", approved_placement_fence_token: 'gen_random_uuid()',
                ...overrides,
            };
            return `INSERT INTO public.ezil_native_auth_intents (user_id, operation_id, kind, session_id, computer_id, input_digest, client_id, idp_issuer,
                subject, scope, state, decided_at, created_at, expires_at, updated_at, ${Object.keys(cols).join(', ')})
                VALUES ('${s.userId}', gen_random_uuid(), 'renew', gen_random_uuid(), '${s.computerId}', 'sha256:${'d'.repeat(64)}', 'c', 'i', 's', 'x',
                'approved', now(), now(), now() + interval '5 minutes', now(), ${Object.values(cols).join(', ')})`;
        };
        await rows(insert({})); // the well-formed control row stores
        for (const key of ['authz_id', 'consent_epoch', 'budget_micro', 'policy_id', 'service', 'profile', 'initial_approval_at', 'authorization_deadline',
            'approved_placement_generation', 'approved_placement_lease_epoch', 'approved_placement_instance_id', 'approved_placement_fence_token']) {
            await refused(insert({ [key]: 'NULL' }));
        }
        for (const bad of <Record<string, string>[]>[{ approved_placement_generation: '0' }, { approved_placement_lease_epoch: '0' }, { consent_epoch: "'0'" },
            { budget_micro: "'01'" }, { service: "'other'" }, { profile: "'other'" },
            { authorization_deadline: "date_trunc('milliseconds', now()) + interval '24 hours 1 millisecond'" },
            { initial_approval_at: "date_trunc('milliseconds', now()) + interval '1 microsecond'" }]) {
            await refused(insert(bad));
        }
    });

    it('approves exactly once under concurrency and seals exactly one artifact', async () => {
        const s = await seed();
        const intent = await prepared(s);
        const results = await Promise.all(Array.from({ length: 6 }, () => approveNativeIntent(db, s.userId, s.operationId, s.computerId, intent.inputDigest, TERMS)));
        expect(results.filter(r => r.kind === 'approved')).toHaveLength(1);
        expect(await rows('SELECT count(*)::int AS n FROM public.ezil_native_task_artifacts WHERE user_id = $1', s.userId)).toEqual([{ n: 1 }]);
        expect(await approveNativeIntent(db, s.userId, s.operationId, s.computerId, intent.inputDigest, TERMS)).toEqual({ kind: 'not_approvable' });
        expect(await decideNativeIntent(db, s.userId, s.operationId, 'denied')).toBeNull();
    });

    it('refuses approval for a stopped, transferred or zero-generation computer, a different digest, another owner, or after expiry', async () => {
        for (const [placement, reason] of [[{ state: 'STOPPED' }, 'computer_not_running'], [{ generation: '0' }, 'placement_invalid'],
            [{ lease_epoch: '0' }, 'placement_invalid']] as const) {
            const s = await seed(placement);
            const intent = await prepared(s);
            expect(await approveNativeIntent(db, s.userId, s.operationId, s.computerId, intent.inputDigest, TERMS)).toEqual({ kind: 'refused', reason });
            expect(await lookupNativeIntent(db, s.userId, s.operationId)).toMatchObject({ state: 'required', terms: null });
        }
        const s = await seed();
        const intent = await prepared(s);
        expect(await approveNativeIntent(db, s.userId, s.operationId, s.computerId, `sha256:${'e'.repeat(64)}`, TERMS)).toEqual({ kind: 'not_approvable' });
        expect((await approveNativeIntent(db, randomUUID(), s.operationId, s.computerId, intent.inputDigest, TERMS)).kind).toBe('refused');
        expect(await decideNativeIntent(db, s.userId, s.operationId, 'expired')).toBeNull(); // not yet expired

        const old = await seed();
        await rows(`INSERT INTO public.ezil_native_auth_intents (user_id, operation_id, kind, session_id, computer_id, input_digest, client_id, idp_issuer,
            subject, scope, state, created_at, expires_at, updated_at) VALUES ($1, $2, 'renew', $3, $4, $5, 'c', 'i', 's', 'x', 'required',
            now() - interval '10 minutes', now() - interval '5 minutes', now())`, old.userId, old.operationId, old.sessionId, old.computerId, `sha256:${'d'.repeat(64)}`);
        expect(await deriveRenewNativeIntent(db, old.userId, old.operationId)).toBeNull();
        expect(await decideNativeIntent(db, old.userId, old.operationId, 'denied')).toBeNull();
        await refused(`UPDATE public.ezil_native_auth_intents SET state = 'approved', decided_at = now() WHERE operation_id = $1`, old.operationId);
        expect(await decideNativeIntent(db, old.userId, old.operationId, 'expired')).toMatchObject({ state: 'expired' });
    });

    it('keeps identity, timestamps, terms and the first decision immutable; never resurrects; refuses DELETE and TRUNCATE', async () => {
        const s = await seed();
        const intent = await approve(s, await prepared(s));
        for (const set of ["state = 'required', decided_at = NULL", "state = 'denied'", "decided_at = decided_at + interval '1 second'",
            "created_at = created_at - interval '1 minute', expires_at = expires_at - interval '1 minute'", "instruction = 'other'",
            "input_digest = 'sha256:" + 'f'.repeat(64) + "'", "client_id = 'other'", "scope = 'x'", 'computer_id = gen_random_uuid()',
            "budget_micro = '9'", "authorization_deadline = authorization_deadline + interval '1 second'", 'authz_id = gen_random_uuid()',
            'approved_placement_lease_epoch = approved_placement_lease_epoch + 1', "initial_approval_at = initial_approval_at - interval '1 second'"]) {
            await refused(`UPDATE public.ezil_native_auth_intents SET ${set} WHERE operation_id = $1`, s.operationId);
        }
        await refused('DELETE FROM public.ezil_native_auth_intents WHERE operation_id = $1', s.operationId);
        await refused('TRUNCATE public.ezil_native_auth_intents');
        expect(await lookupNativeIntent(db, s.userId, s.operationId)).toEqual(intent);
    });

    it('never upgrades an approved row without terms, and its binding is null', async () => {
        const s = await seed();
        await rows(`INSERT INTO public.ezil_native_auth_intents (user_id, operation_id, kind, session_id, computer_id, input_digest, client_id, idp_issuer,
            subject, scope, state, decided_at, created_at, expires_at, updated_at) VALUES ($1, $2, 'renew', $3, $4, $5, 'c', 'i', 's', 'x', 'approved',
            now(), now(), now() + interval '5 minutes', now())`, s.userId, s.operationId, s.sessionId, s.computerId, `sha256:${'d'.repeat(64)}`);
        expect(await lookupNativeIntent(db, s.userId, s.operationId)).toMatchObject({ state: 'approved', terms: null });
        expect(await readApprovedNativeConsentBinding(db, { ownerUserId: s.userId, operationId: s.operationId })).toBeNull();
        await refused(`UPDATE public.ezil_native_auth_intents SET authz_id = gen_random_uuid(), consent_epoch = '1', budget_micro = '1',
            policy_id = gen_random_uuid(), service = 'ezil-os-native', profile = 'ezil-native-claude-v1', initial_approval_at = decided_at,
            authorization_deadline = decided_at + interval '1 hour', approved_placement_generation = 1, approved_placement_lease_epoch = 1,
            approved_placement_instance_id = 'i-0123456789abcdef0', approved_placement_fence_token = gen_random_uuid() WHERE operation_id = $1`, s.operationId);
    });

    it('records approved>blocked only while no native operation exists under the key, preserving the decision time', async () => {
        const pre = await seed();
        const approved = await approve(pre, await prepared(pre));
        const blocked = await blockApprovedNativeIntent(db, pre.userId, pre.operationId, 'subject_token_unavailable');
        expect(blocked).toMatchObject({ state: 'blocked', reason: 'subject_token_unavailable', decidedAt: approved.decidedAt, terms: approved.terms });
        expect(await blockApprovedNativeIntent(db, pre.userId, pre.operationId, 'host_unavailable')).toBeNull();

        const post = await seed();
        await approve(post, await prepared(post));
        expect((await claim(post)).kind).toBe('claimed');
        expect(await blockApprovedNativeIntent(db, post.userId, post.operationId, 'dispatch_refused')).toBeNull();
        await refused(`UPDATE public.ezil_native_auth_intents SET state = 'blocked', reason = 'x' WHERE operation_id = $1`, post.operationId);
        expect(await lookupNativeIntent(db, post.userId, post.operationId)).toMatchObject({ state: 'approved' });
    });

    it('the broker claim compares the approved tuple inside its own transaction', async () => {
        const s = await seed();
        const approved = await approve(s, await prepared(s));
        const tuple = approved.terms!.placement;
        expect(await claim(s, { ...tuple, fenceToken: randomUUID() })).toEqual({ kind: 'refused', reason: 'placement_changed' });
        expect(await claim(s, { ...tuple, leaseEpoch: String(BigInt(tuple.leaseEpoch) + BigInt(1)) })).toEqual({ kind: 'refused', reason: 'placement_changed' });
        expect(await rows('SELECT count(*)::int AS n FROM public.ezil_native_session_operations WHERE user_id = $1', s.userId)).toEqual([{ n: 0 }]);
        expect((await claim(s, tuple)).kind).toBe('claimed');
    });

    it('answers the exact consent binding only while owner, approved tuple, claim and deadline all hold', async () => {
        const s = await seed();
        const approved = await approve(s, await prepared(s));
        const key = { ownerUserId: s.userId, operationId: s.operationId };
        const binding = await readApprovedNativeConsentBinding(db, key);
        expect(binding).toEqual({
            authorizationId: approved.terms!.authzId, epoch: '7', budgetMicro: '2500000', ownerUserId: s.userId, sessionId: s.sessionId,
            computerId: s.computerId, placement: { generation: GENERATION, leaseEpoch: LEASE_EPOCH, instanceId: s.instance, fenceToken: s.fence },
            clientId: ACTOR.clientId, serviceId: 'ezil-os-native', profileId: 'ezil-native-claude-v1', policyId: TERMS.policyId,
            initialApprovalAt: approved.terms!.initialApprovalAt.toISOString(), authorizationDeadline: approved.terms!.authorizationDeadline.toISOString(),
        });
        expect(binding!.initialApprovalAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(await readApprovedNativeConsentBinding(db, { ownerUserId: randomUUID(), operationId: s.operationId })).toBeNull();
        expect((await claim(s, approved.terms!.placement)).kind).toBe('claimed');
        expect(await readApprovedNativeConsentBinding(db, key)).toEqual(binding);

        // Placement drift (a new lease epoch) makes it null; the approved tuple is never re-derived from the new one.
        await rows('UPDATE public.ezil_computer_placements SET lease_epoch = lease_epoch + 1 WHERE computer_id = $1', s.computerId);
        expect(await readApprovedNativeConsentBinding(db, key)).toBeNull();
        await rows('UPDATE public.ezil_computer_placements SET lease_epoch = lease_epoch - 1 WHERE computer_id = $1', s.computerId);
        expect(await readApprovedNativeConsentBinding(db, key)).toEqual(binding);
        // Transfer or deletion makes it null.
        await rows('UPDATE public.ezil_computers SET deleted_at = now() WHERE id = $1', s.computerId);
        expect(await readApprovedNativeConsentBinding(db, key)).toBeNull();
        await rows('UPDATE public.ezil_computers SET deleted_at = NULL WHERE id = $1', s.computerId);
        // Authorization is separate from execution: an unknown operation keeps the live consent readable, with the
        // exact identity and full tuple, for explicit reconciliation of that same operation. Reading writes nothing.
        await rows(`UPDATE public.ezil_native_session_operations SET state = 'exchanging' WHERE operation_id = $1`, s.operationId);
        await rows(`UPDATE public.ezil_native_session_operations SET state = 'exchange_unknown', reason = 'gateway_timeout' WHERE operation_id = $1`, s.operationId);
        expect(await readApprovedNativeConsentBinding(db, key)).toEqual(binding);
        expect(await rows(`SELECT state, reason FROM public.ezil_native_session_operations WHERE operation_id = $1`, s.operationId))
            .toEqual([{ state: 'exchange_unknown', reason: 'gateway_timeout' }]);
        expect(await lookupNativeIntent(db, s.userId, s.operationId)).toEqual(approved);
    });

    it('keeps a live consent readable while its delivery is unknown, and refuses a same-key operation of another identity', async () => {
        const s = await seed();
        const approved = await approve(s, await prepared(s));
        expect((await claim(s, approved.terms!.placement)).kind).toBe('claimed');
        for (const [from, to, extra] of [['claimed', 'exchanging', ''], ['exchanging', 'granted', `, grant_id = gen_random_uuid(), grant_expires_at = now() + interval '4 minutes'`],
            ['granted', 'delivering', ''], ['delivering', 'delivery_unknown', `, reason = 'host_timeout'`]] as const) {
            await rows(`UPDATE public.ezil_native_session_operations SET state = '${to}'${extra} WHERE operation_id = $1 AND state = '${from}'`, s.operationId);
        }
        const key = { ownerUserId: s.userId, operationId: s.operationId };
        expect(await readApprovedNativeConsentBinding(db, key)).toMatchObject({ authorizationId: approved.terms!.authzId, placement: approved.terms!.placement });

        // A same-key operation that is not the one this consent admits (another session) is never the binding's operation.
        const other = await seed();
        const otherApproved = await approve(other, await prepared(other));
        await rows(`INSERT INTO public.ezil_native_session_operations (user_id, operation_id, kind, session_id, computer_id, instruction_revision,
            instruction_digest, task_ref, request_digest, placement_generation, placement_lease_epoch, placement_instance_id, placement_fence_token, state,
            created_at, updated_at) VALUES ($1, $2, 'create', gen_random_uuid(), $3, 1, $4, $5, $6, $7::bigint, $8::bigint, $9, $10::uuid, 'claimed', now(), now())`,
        other.userId, other.operationId, other.computerId, otherApproved.instructionDigest, `native-task:${other.operationId}`, `sha256:${'a'.repeat(64)}`,
        GENERATION, LEASE_EPOCH, other.instance, other.fence);
        expect(await readApprovedNativeConsentBinding(db, { ownerUserId: other.userId, operationId: other.operationId })).toBeNull();
    });

    it('derives a renewal with the SAME authorization, deadline, budget and tuple, and no new approval time', async () => {
        const s = await seed();
        const approved = await approve(s, await prepared(s));
        const renewal = await renewIntent(s);
        const derived = await deriveRenewNativeIntent(db, s.userId, renewal.operationId);
        expect(derived).toMatchObject({ state: 'approved', terms: approved.terms });
        expect(derived!.terms!.initialApprovalAt).toEqual(approved.terms!.initialApprovalAt);
        expect(await deriveRenewNativeIntent(db, s.userId, renewal.operationId)).toBeNull(); // decided once

        const otherClient = await renewIntent(s, 'other-client');
        expect(await deriveRenewNativeIntent(db, s.userId, otherClient.operationId)).toBeNull();
        const noConsent = await seed();
        expect(await deriveRenewNativeIntent(db, noConsent.userId, (await renewIntent(noConsent)).operationId)).toBeNull();
    });

    it('seals artifacts only from an approved intent and never changes them; resolves them only while approved and owned', async () => {
        const s = await seed();
        const intent = await prepared(s, 'exact\ttask \n');
        await refused(`INSERT INTO public.ezil_native_task_artifacts (user_id, task_ref, operation_id, session_id, computer_id, instruction_revision,
            instruction_digest, instruction, instruction_bytes, sealed_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, now())`,
        s.userId, `native-task:${s.operationId}`, s.operationId, s.sessionId, s.computerId, intent.instructionDigest, intent.instruction,
        Buffer.byteLength(intent.instruction!, 'utf8'));
        const resolver = nativeArtifactTaskResolver(db);
        const ref = `native-task:${s.operationId}`;
        expect(await resolver.resolve(ref, { userId: s.userId })).toBeNull();
        await approve(s, intent);
        expect(await resolver.resolve(ref, { userId: s.userId })).toEqual({ taskRef: ref, instructionRevision: 1,
            instructionDigest: intent.instructionDigest, instruction: 'exact\ttask \n' });
        expect(intent.instructionDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(await resolver.resolve(ref, { userId: randomUUID() })).toBeNull();
        expect(await resolver.resolve('task:native-smoke', { userId: s.userId })).toBeNull();
        await refused(`UPDATE public.ezil_native_task_artifacts SET instruction = 'x' WHERE operation_id = $1`, s.operationId);
        await refused('DELETE FROM public.ezil_native_task_artifacts WHERE operation_id = $1', s.operationId);
        await refused('TRUNCATE public.ezil_native_task_artifacts');
        await rows('UPDATE public.ezil_computers SET user_id = $1 WHERE id = $2', randomUUID(), s.computerId);
        expect(await resolver.resolve(ref, { userId: s.userId })).toBeNull();
        await rows('UPDATE public.ezil_computers SET user_id = $1 WHERE id = $2', s.userId, s.computerId);
        await blockApprovedNativeIntent(db, s.userId, s.operationId, 'subject_token_unavailable');
        expect(await resolver.resolve(ref, { userId: s.userId })).toBeNull();
    });

    it('a local STOP is terminal for the whole consent: no binding, no derived renewal; the operation is untouched', async () => {
        const s = await seed();
        const approved = await approve(s, await prepared(s));
        const authz = approved.terms!.authzId;
        expect((await claim(s, approved.terms!.placement)).kind).toBe('claimed');
        const key = { ownerUserId: s.userId, operationId: s.operationId };
        expect(await readApprovedNativeConsentBinding(db, key)).not.toBeNull();

        // The caller-transaction getter answers the same binding inside the caller's own READ COMMITTED transaction.
        const before = await readApprovedNativeConsentBinding(db, key);
        expect(await db.transaction(tx => readApprovedNativeConsentBindingTx(tx, key))).toEqual(before);

        expect(await revokeNativeConsent(db, randomUUID(), authz)).toBeNull(); // another owner: nothing written
        const revocation = await revokeNativeConsent(db, s.userId, authz);
        // The binding is captured before the stop, with a stable gateway-revoke operation id.
        expect(revocation).toEqual({
            authorizationId: authz, consentOperationId: s.operationId, gatewayRevokeOperationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            ownerUserId: s.userId, sessionId: s.sessionId, computerId: s.computerId, clientId: ACTOR.clientId, policyId: TERMS.policyId, epoch: '7',
            budgetMicro: '2500000', initialApprovalAt: before!.initialApprovalAt, authorizationDeadline: before!.authorizationDeadline,
            placement: before!.placement, revokedAt: expect.stringMatching(/Z$/),
        });
        expect(await revokeNativeConsent(db, s.userId, authz)).toEqual(revocation); // idempotent: the first stop stays
        expect((await nativeConsentRevokedAt(db, s.userId, authz))!.toISOString()).toBe(revocation!.revokedAt);
        expect(await readApprovedNativeConsentBinding(db, key)).toBeNull();
        expect(await readNativeConsentRevocation(db, s.userId, authz)).toEqual(revocation); // still readable for the Gateway revoke
        // The purpose-tagged history snapshot still names the same identity; it is not a permission.
        expect(await readNativeConsentHistory(db, key)).toEqual({ purpose: 'history', binding: before });
        expect(await deriveRenewNativeIntent(db, s.userId, (await renewIntent(s)).operationId)).toBeNull();
        // The original operation and the intent are untouched; nothing restarts.
        expect(await rows('SELECT state FROM public.ezil_native_session_operations WHERE operation_id = $1', s.operationId)).toEqual([{ state: 'claimed' }]);
        expect(await lookupNativeIntent(db, s.userId, s.operationId)).toEqual(approved);

        await refused('UPDATE public.ezil_native_consent_revocations SET revoked_at = now() WHERE authz_id = $1', authz);
        await refused('DELETE FROM public.ezil_native_consent_revocations WHERE authz_id = $1', authz);
        await refused('TRUNCATE public.ezil_native_consent_revocations');
        // A consent never issued (approved, nothing claimed) can still be stopped, and its binding is then refused.
        const idle = await seed();
        const idleApproved = await approve(idle, await prepared(idle));
        // First: a tombstone whose captured binding differs from the owner's consent never stores (trigger, not a key clash).
        const mismatch = (column: string, value: string) => `INSERT INTO public.ezil_native_consent_revocations SELECT i.user_id, i.authz_id,
            i.operation_id, gen_random_uuid(), i.session_id, i.computer_id, i.client_id, i.policy_id, i.consent_epoch, i.budget_micro, i.initial_approval_at,
            i.authorization_deadline, i.approved_placement_generation, i.approved_placement_lease_epoch, i.approved_placement_instance_id,
            i.approved_placement_fence_token, now() FROM public.ezil_native_auth_intents i WHERE i.operation_id = $1`.replace(`i.${column},`, `${value},`);
        for (const [column, value] of [['budget_micro', "'999'"], ['consent_epoch', "'8'"], ['client_id', "'other'"],
            ['approved_placement_fence_token', 'gen_random_uuid()']]) {
            await refused(mismatch(column, value), idle.operationId);
        }
        expect(await revokeNativeConsent(db, idle.userId, idleApproved.terms!.authzId)).toMatchObject({ consentOperationId: idle.operationId });
        expect(await readApprovedNativeConsentBinding(db, { ownerUserId: idle.userId, operationId: idle.operationId })).toBeNull();
    });

    it('STOP serialises with dispatch on the canonical computer lock, in either order', async () => {
        // Order 1: the stop commits first; a dispatch starting after it reads no binding and so claims nothing.
        const a = await seed();
        const aApproved = await approve(a, await prepared(a));
        const keyA = { ownerUserId: a.userId, operationId: a.operationId };
        expect(await revokeNativeConsent(db, a.userId, aApproved.terms!.authzId)).not.toBeNull();
        expect(await db.transaction(tx => readApprovedNativeConsentBindingTx(tx, keyA))).toBeNull();
        expect(await rows('SELECT count(*)::int AS n FROM public.ezil_native_session_operations WHERE user_id = $1', a.userId)).toEqual([{ n: 0 }]);

        // Order 2: a dispatch holds the lock from its binding read through its CAS to commit; the stop waits for it,
        // then commits, and the genuine in-flight operation is preserved untouched.
        const b = await seed();
        const bApproved = await approve(b, await prepared(b));
        const keyB = { ownerUserId: b.userId, operationId: b.operationId };
        let entered!: () => void;
        let release!: () => void;
        const inside = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const tuple = bApproved.terms!.placement;
        const dispatch = db.transaction(async tx => {
            const binding = await readApprovedNativeConsentBindingTx(tx, keyB);
            entered();
            await gate;
            await tx.execute(sql`INSERT INTO public.ezil_native_session_operations (user_id, operation_id, kind, session_id, computer_id,
                instruction_revision, instruction_digest, task_ref, request_digest, placement_generation, placement_lease_epoch, placement_instance_id,
                placement_fence_token, state, created_at, updated_at) VALUES (${b.userId}::uuid, ${b.operationId}::uuid, 'create', ${b.sessionId}::uuid,
                ${b.computerId}::uuid, 1, ${bApproved.instructionDigest}, ${`native-task:${b.operationId}`}, ${`sha256:${'a'.repeat(64)}`},
                ${tuple.generation}::bigint, ${tuple.leaseEpoch}::bigint, ${tuple.instanceId}, ${tuple.fenceToken}::uuid, 'claimed', now(), now())`);
            return binding;
        });
        await inside;
        let stopped = false;
        const stop = revokeNativeConsent(db, b.userId, bApproved.terms!.authzId).then(r => { stopped = true; return r; });
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(stopped).toBe(false); // waiting on the same canonical computer lock
        release();
        expect(await dispatch).toMatchObject({ authorizationId: bApproved.terms!.authzId, placement: tuple });
        expect(await stop).toMatchObject({ authorizationId: bApproved.terms!.authzId, consentOperationId: b.operationId });
        expect(await rows('SELECT state FROM public.ezil_native_session_operations WHERE operation_id = $1', b.operationId)).toEqual([{ state: 'claimed' }]);
        expect(await readApprovedNativeConsentBinding(db, keyB)).toBeNull();
    });

    it('STOP needs no running computer, lease or live placement', async () => {
        const s = await seed();
        const approved = await approve(s, await prepared(s));
        await rows(`UPDATE public.ezil_computer_placements SET state = 'STOPPED', lease_until = now() - interval '1 minute' WHERE computer_id = $1`, s.computerId);
        expect(await revokeNativeConsent(db, s.userId, approved.terms!.authzId)).toMatchObject({ authorizationId: approved.terms!.authzId });
    });

    it('runs on the disposable PostgreSQL 17 fixture (server version receipt)', async () => {
        const [row] = await client!`SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS version`;
        console.info('[pg-fixture] server_version', row!.version, row!.num);
        expect(Math.floor((row!.num as number) / 10_000)).toBe(17);
    });

    it('grants nothing to anon or authenticated and keeps RLS on', async () => {
        for (const table of ['ezil_native_auth_intents', 'ezil_native_task_artifacts', 'ezil_native_consent_revocations']) {
            for (const role of ['anon', 'authenticated']) {
                const [row] = await client!.unsafe(`SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') AS any`, [role, `${schema}.${table}`]);
                expect(row!.any, `${role} ${table}`).toBe(false);
            }
            const [rls] = await client!.unsafe(`SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass`, [`${schema}.${table}`]);
            expect(rls!.relrowsecurity).toBe(true);
        }
    });
    it('composes actual consent, durable candidate, one send, private delivery and pure replay without browser proof', async () => {
        const s = await seed();
        await approve(s, await prepared(s));
        const binding = (await readApprovedNativeConsentBinding(db, { ownerUserId: s.userId, operationId: s.operationId }))!;
        const base = fixtureConfig(keys);
        const config = new NativeAuthorizationConfig(base.issuer, base.audience, TERMS.policyId, base.serviceAuthorization().slice(7), base.serviceExpiresAt, base.signer, base.wrapping);
        const deliveries: import('@/server/native-session/host-transport').NativeHostDelivery[] = [];
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body)) as { subjectToken: string };
            const claim = JSON.parse(Buffer.from(body.subjectToken.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, string>;
            // The candidate is already durable, encrypted, and is the same hash signed for Gateway.
            const [row] = await rows('SELECT token_sha256, candidate_ciphertext, state FROM public.ezil_native_authorization_operations WHERE operation_id = $1', s.operationId);
            expect(row).toMatchObject({ token_sha256: claim.tokenSha256, state: 'dispatching' });
            expect(row!.candidate_ciphertext).toBeTruthy();
            return jsonResponse(201, { object: 'native_authorization_grant', grant_id: randomUUID(), expires_at: claim.leaseExpiresAt,
                authorization_id: claim.authorizationId, epoch: claim.epoch, authorization_deadline: claim.authorizationDeadline,
                budget_micro: claim.budgetMicro, replayed: false });
        }) as unknown as typeof fetch;
        const deps: NativeSessionDeps = { db, env: {}, nativeAuthorizationConfig: config, now: Date.now, fetch: fetchImpl,
            supabase: vi.fn(), currentAccessToken: vi.fn(() => { throw new Error('browser proof forbidden'); }), taskResolver: nativeArtifactTaskResolver(db),
            hostTransport: { available: true, supportsKind: () => true, checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })),
                deliver: vi.fn(async d => { deliveries.push(d); return { kind: 'acknowledged' as const }; }) } };
        const request = { ...input(s), taskRef: `native-task:${s.operationId}` };
        const caller = { userId: s.userId, headers: new Headers(), supabase: {} as never };
        const admitted = { consentOperationId: s.operationId, placement: binding.placement, computerId: s.computerId,
            sourceAuthorization: { authorizationId: binding.authorizationId, epoch: binding.epoch, authorizationDeadline: binding.authorizationDeadline,
                clientId: binding.clientId, profileId: binding.profileId, policyId: binding.policyId, budgetMicro: binding.budgetMicro, initialApprovalAt: binding.initialApprovalAt },
            consentRecheck: async () => 'ok' as const };
        expect(await runNativeOperation(deps, caller, request, admitted)).toMatchObject({ kind: 'operation', operation: { state: 'delivered' }, replayed: false });
        expect(fetchImpl).toHaveBeenCalledTimes(1);expect(deliveries).toHaveLength(1);expect(deps.currentAccessToken).not.toHaveBeenCalled();
        expect(deliveries[0]!.grant.tokenSha256).toBe(createHash('sha256').update(deliveries[0]!.grant.accessToken, 'utf8').digest('hex'));
        expect(Object.keys(deliveries[0]!.sourceAuthorization)).toHaveLength(8);
        const unavailable = { ...deps, env: {}, nativeAuthorizationConfig: undefined, hostTransport: { ...deps.hostTransport, available: false } };
        expect(await runNativeOperation(unavailable, caller, request, admitted)).toMatchObject({ kind: 'operation', replayed: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);expect(deliveries).toHaveLength(1);
        await revokeNativeConsent(db, s.userId, binding.authorizationId);
        const outbox = { config, readConsent: readApprovedNativeConsentBindingTx, now: Date.now, fetchImpl };
        expect(await openNativeGrantCandidate(db, outbox, { ownerUserId: s.userId, operationId: s.operationId })).toMatchObject({ kind: 'refused', reason: 'consent_unavailable' });
        const revoked = (await readNativeConsentRevocation(db, s.userId, binding.authorizationId))!;
        const cleanup = { ...outbox, readConsent: async (tx: PlacementExecutor, key: { ownerUserId: string; operationId: string }) => (await readNativeConsentHistory(tx, key))?.binding ?? null };
        expect(await prepareNativeRevoke(db, cleanup, { ownerUserId: s.userId, operationId: revoked.gatewayRevokeOperationId,
            consentOperationId: s.operationId, authorizationId: binding.authorizationId })).toMatchObject({ kind: 'prepared' });
        const status = await readNativeAuthorizationOperation(db, { ownerUserId: s.userId, operationId: s.operationId });
        expect(status).toMatchObject({ state: 'granted' });
        expect(await dispatchNativeOperationOnce(db, { ...cleanup, fetchImpl: (async () => { throw new Error('lost revoke ACK'); }) as typeof fetch },
            { ownerUserId: s.userId, operationId: revoked.gatewayRevokeOperationId })).toMatchObject({ kind: 'settled', status: { state: 'delivery_unknown' } });
        expect(await openNativeGrantCandidate(db, outbox, { ownerUserId: s.userId, operationId: s.operationId })).toMatchObject({ kind: 'refused', reason: 'authorization_revoked' });
    });

    it('production AI port resolves actual0031 history/active/revocation with accepted policy and original client', async () => {
        const s = await seed();const intent = await approve(s, await prepared(s));
        const pin = acceptedDeploymentFixture(TERMS.policyId);const port = createProductionNativeAiPort(db, pin.env)!;
        expect(await port.history(s.userId, s.operationId)).toMatchObject({ authorizationId: intent.terms!.authzId,
            originalOAuthClientId: ACTOR.clientId, sessionId: s.sessionId, computerId: s.computerId,
            policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/) });
        expect(await port.active(s.userId, s.operationId)).not.toBeNull();expect(await port.history(randomUUID(), s.operationId)).toBeNull();
        const other = createProductionNativeAiPort(db, acceptedDeploymentFixture(randomUUID()).env)!;
        expect(await other.history(s.userId, s.operationId)).toBeNull();expect(await other.active(s.userId, s.operationId)).toBeNull();
        await revokeNativeConsent(db, s.userId, intent.terms!.authzId);
        expect(await port.active(s.userId, s.operationId)).toBeNull();expect(await port.revocation(s.userId, intent.terms!.authzId)).toMatchObject({ revokedAt: expect.any(String) });
        expect(await port.history(s.userId, s.operationId)).not.toBeNull();
    });

});
