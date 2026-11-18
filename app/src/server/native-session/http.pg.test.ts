/** BFF pipeline on disposable PostgreSQL (`EZIL_PG_TEST_URL`) with a mocked Gateway and fixture host transport. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PLACEMENT_LOCK_NAMESPACE, type PlacementExecutor } from '@/server/lib/compute/placement';

import { NATIVE_OPERATION_LOCK_NAMESPACE, NATIVE_SESSION_LOCK_NAMESPACE, type NativeAuthorityDb } from './authority';
import { approveNativeIntent, insertNativeIntent } from '@/server/native-auth/store';
import { nativeInstructionDigest, nativeIntentInputDigest } from '@/server/native-auth/contract';
import { readApprovedNativeConsentBinding } from '@/server/native-auth/consent-binding';
import { sourceAuthorizationOf } from '@/server/native-auth/consent';
import { fixtureConfig, fixtureKeys } from './native-authorization.test-support';
import { NativeAuthorizationConfig } from './native-authorization-config';
import { handleNativeSessionStatus, nativeRunResponse, parseNativeCreateBody, runNativeOperation, type NativeSessionDeps } from './http';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `native_http_test_${randomUUID().replaceAll('-', '')}`;
const ROOT = path.resolve(__dirname, '../../../..');
const ORIGIN = 'https://os-staging.ezil.work';
// Synthetic c9-shaped secrets and policy UUID; never real credentials.
const SERVICE = `ezs_${Buffer.alloc(32, 0x5a).toString('base64url')}`;
const GRANT = `ezg_${Buffer.alloc(32, 0xa5).toString('base64url')}`;
const POLICY = '0b6f8a2e-4c1d-4e5f-9a7b-3c2d1e0f9a8b';
const DIGEST = nativeInstructionDigest('fixture instruction');
const KEYS = await fixtureKeys();
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe.skipIf(!PG)('native session BFF pipeline on disposable PostgreSQL', () => {
    // Tagged so the open-transaction probe counts only this file's connections, not a parallel suite's.
    const client = PG ? postgres(PG, { max: 8, idle_timeout: 20, prepare: false, onnotice: () => {}, connection: { application_name: schema } }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: NativeAuthorityDb = { execute: q => executor(production!).execute(q), transaction: fn => production!.transaction(tx => fn(executor(tx))) };
    const rows = (q: string, ...args: unknown[]) => client!.unsafe(local(q), args as never[]);
    const tryLock = async (namespace: number, key: string) =>
        (await client!.begin(async c => c`SELECT pg_try_advisory_xact_lock(${namespace}::int4, hashtext(${key})) AS ok`))[0]!.ok as boolean;

    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot smallint NOT NULL DEFAULT 1,
            deleted_at timestamptz NULL)`);
        for (const file of ['docs/aws-computers/sql/0001_compute_placement.sql.txt', 'docs/aws-computers/sql/0002_image_rebase.sql.txt',
            'app/drizzle/0029_native_session_operations.sql', 'app/drizzle/0031_native_auth_intents.sql', 'app/drizzle/0033_native_grant_outbox.sql']) await client!.unsafe(local(readFileSync(path.join(ROOT, file), 'utf8')));
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    const setup = async (respond: (ids: { userId: string; computerId: string; operationId: string; sessionId: string }) => Promise<Response>,
        leaseSeconds = 600) => {
        const ids = { userId: randomUUID(), computerId: randomUUID(), operationId: randomUUID(), sessionId: randomUUID() };
        await rows(`INSERT INTO public.ezil_computers (id, user_id) VALUES ($1, $2)`, ids.computerId, ids.userId);
        await rows(`INSERT INTO public.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch,
            state, instance_id, instance_type, volume_id, fence_token, lease_until, updated_at)
            VALUES ($1, $2, 'aws-ec2', 'ebs', 3000000001, 4294967301, 'RUNNING', 'i-0123456789abcdef0', 'm6i.large', 'vol-11111111111111111',
                gen_random_uuid(), now() + make_interval(secs => $3), now())`, ids.computerId, ids.userId, leaseSeconds);
        const proof = `${b64({ alg: 'HS256' })}.${b64({ sub: ids.userId, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
        const deliveries: unknown[] = [];
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const response = await respond(ids);
            if (!response.ok) return response;
            const body = await response.json() as { grant_id: string; expires_at: string };
            const claim = JSON.parse(Buffer.from((JSON.parse(String(init?.body)) as { subjectToken: string }).subjectToken.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, string>;
            return new Response(JSON.stringify({ object: 'native_authorization_grant', grant_id: body.grant_id, expires_at: body.expires_at,
                authorization_id: claim.authorizationId, epoch: claim.epoch, authorization_deadline: claim.authorizationDeadline,
                budget_micro: claim.budgetMicro, replayed: false }), { status: 201, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof fetch;
        const base = fixtureConfig(KEYS);
        const config = new NativeAuthorizationConfig(base.issuer, base.audience, POLICY, base.serviceAuthorization().slice(7), base.serviceExpiresAt, base.signer, base.wrapping);
        const deps: NativeSessionDeps = {
            env: { EZIL_NATIVE_SESSIONS: '1', EZIL_NATIVE_SESSIONS_ORIGIN: ORIGIN, EZIL_NATIVE_GATEWAY_POLICY_ID: POLICY,
                EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL: SERVICE, EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() },
            supabase: async () => ({ auth: { getUser: async () => ({ data: { user: { id: ids.userId } } }),
                getSession: async () => { throw new Error('no'); }, refreshSession: async () => { throw new Error('no'); } } }),
            db, fetch: fetchImpl, nativeAuthorizationConfig: config,
            hostTransport: { available: true, supportsKind: () => true,
                checkReadiness: vi.fn(async () => ({ kind: 'ready' as const })), deliver: vi.fn(async delivery => { deliveries.push(delivery); return { kind: 'acknowledged' as const }; }) },
            taskResolver: { resolve: async taskRef => ({ taskRef, instructionRevision: 1, instructionDigest: DIGEST,
                instruction: 'fixture instruction' }) },
            currentAccessToken: async () => proof, now: () => Date.now(),
        };
        const body = { operationId: ids.operationId, sessionId: ids.sessionId, computerId: ids.computerId, instructionRevision: 1,
            instructionDigest: DIGEST, taskRef: `native-task:${ids.operationId}` };
        const input = { kind: 'create' as const, operationId: ids.operationId, sessionId: ids.sessionId, computerId: ids.computerId,
            instructionRevision: 1 as const, instructionDigest: DIGEST, instruction: 'fixture instruction' };
        const inserted = await insertNativeIntent(db, ids.userId, input, ids.computerId, nativeIntentInputDigest(input),
            { clientId: 'ezil-mcp-staging', idpIssuer: 'https://id.ezil.work/', subject: 'auth0|fixture', scope: 'ezil:native-sessions:write' });
        if (inserted.kind !== 'inserted') throw new Error('fixture insert');
        await approveNativeIntent(db, ids.userId, ids.operationId, ids.computerId, inserted.intent.inputDigest,
            { policyId: POLICY, epoch: '7', budgetMicro: '2500000', ttlSeconds: 3600 });
        const binding = (await readApprovedNativeConsentBinding(db, { ownerUserId: ids.userId, operationId: ids.operationId }))!;
        const admitted = { placement: binding.placement, computerId: ids.computerId, consentOperationId: ids.operationId,
            sourceAuthorization: sourceAuthorizationOf(binding), consentRecheck: async () => 'ok' as const };
        const create = async (overrides: Record<string, unknown> = {}) => {
            const request = parseNativeCreateBody({ ...body, ...overrides });
            if (!request) return new Response(null, { status: 400 });
            return nativeRunResponse(await runNativeOperation(deps, { userId: ids.userId, supabase: await deps.supabase(),
                headers: new Headers({ origin: ORIGIN }) }, request, admitted));
        };
        const status = () => handleNativeSessionStatus(new Request(`${ORIGIN}/api/shell/native-sessions/${ids.sessionId}`), ids.sessionId, deps);
        return { ids, deps, proof, fetchImpl, deliveries, create, status };
    };
    /** c9 builds the body with jsonb_build_object over timestamptz: let this PostgreSQL render it the same way. */
    const grant = async () => {
        const [row] = await client!`SELECT jsonb_build_object('token_type', 'Bearer', 'access_token', ${GRANT}::text,
            'grant_id', gen_random_uuid(), 'expires_at', date_trunc('second', now()) + interval '4 minutes')::text AS body`;
        return new Response(row!.body as string, { status: 201, headers: { 'content-type': 'application/json' } });
    };

    it('the fixture PostgreSQL renders timestamptz in JSON with an explicit +00:00 offset, as c9 forwards it', async () => {
        const [row] = await client!`SELECT jsonb_build_object('expires_at', '2026-11-16T17:30:00Z'::timestamptz)->>'expires_at' AS v,
            current_setting('TimeZone') AS tz`;
        expect(row).toEqual({ v: '2026-11-16T17:30:00+00:00', tz: 'Etc/UTC' });
    });

    it('holds no lock or open transaction during the exchange, delivers, and stores no secret', async () => {
        let probes: Record<string, unknown> = {};
        const t = await setup(async ids => {
            probes = {
                operation: await tryLock(NATIVE_OPERATION_LOCK_NAMESPACE, `${ids.userId}/${ids.operationId}`),
                session: await tryLock(NATIVE_SESSION_LOCK_NAMESPACE, `${ids.userId}/${ids.sessionId}`),
                computer: await tryLock(PLACEMENT_LOCK_NAMESPACE, ids.computerId),
                openTransactions: Number((await client!`SELECT count(*)::int AS n FROM pg_stat_activity
                    WHERE datname = current_database() AND application_name = ${schema} AND state LIKE 'idle in transaction%'`)[0]!.n),
                state: (await rows(`SELECT state FROM public.ezil_native_session_operations WHERE operation_id = $1`, ids.operationId))[0]!.state,
            };
            return grant();
        });
        const res = await t.create();
        expect(res.status).toBe(201);
        expect(probes).toEqual({ operation: true, session: true, computer: true, openTransactions: 0, state: 'exchanging' });
        expect(t.deliveries).toHaveLength(1);
        const stored = await rows(`SELECT row_to_json(o)::text AS j FROM public.ezil_native_session_operations o WHERE user_id = $1`, t.ids.userId);
        const text = JSON.stringify([stored, await res.json(), await (await t.status()).json()]);
        for (const secret of [SERVICE, GRANT, t.proof, 'ezs_', 'ezg_']) expect(text).not.toContain(secret);
        expect(JSON.parse(stored[0]!.j as string)).toMatchObject({ state: 'delivered', placement_generation: 3000000001 });
    });

    it('rechecks the stored placement after the exchange: a change during it stops delivery', async () => {
        const t = await setup(async ids => {
            await rows(`UPDATE public.ezil_computer_placements SET lease_epoch = lease_epoch + 1 WHERE computer_id = $1`, ids.computerId);
            return grant();
        });
        const res = await t.create();
        expect(await res.json()).toMatchObject({ operation: { state: 'authority_changed', reason: 'authorization_unavailable', settled: true } });
        expect(t.deliveries).toHaveLength(0);
    });

    it('refuses an insufficient signed lease before any outbox candidate or send', async () => {
        const t = await setup(async () => grant(), 29);
        expect(await (await t.create()).json()).toMatchObject({ operation: { state: 'exchange_refused', reason: 'lease_boundary' } });
        expect(t.fetchImpl).not.toHaveBeenCalled();
        expect(await rows('SELECT count(*)::int AS n FROM public.ezil_native_authorization_operations WHERE owner_user_id = $1', t.ids.userId)).toEqual([{ n: 0 }]);
    });

    it('replays a receipt only to the current owner: deleted or reassigned is 404 with no receipt, other input stays 409', async () => {
        for (const change of ['deleted', 'reassigned'] as const) {
            const t = await setup(async () => grant());
            expect((await t.create()).status).toBe(201);
            expect(await (await t.create()).json()).toMatchObject({ operation: { state: 'delivered', replayed: true } });
            const tombstone = await rows(`SELECT row_to_json(o)::text AS j FROM public.ezil_native_session_operations o WHERE user_id = $1`, t.ids.userId);
            await rows(change === 'deleted' ? `UPDATE public.ezil_computers SET deleted_at = now() WHERE id = $1`
                : `UPDATE public.ezil_computers SET user_id = gen_random_uuid() WHERE id = $1`, t.ids.computerId);
            const gone = await t.create();
            const text = await gone.text();
            expect(gone.status, change).toBe(404);
            expect(JSON.parse(text), change).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
            for (const field of [t.ids.operationId, t.ids.computerId, t.ids.sessionId, 'delivered']) expect(text).not.toContain(field);
            expect((await t.create({ taskRef: 'task:other' })).status, change).toBe(409);
            expect(t.fetchImpl).toHaveBeenCalledTimes(1);
            expect(t.deliveries).toHaveLength(1);
            expect(await rows(`SELECT row_to_json(o)::text AS j FROM public.ezil_native_session_operations o WHERE user_id = $1`, t.ids.userId)).toEqual(tombstone);
        }
    });

    it('quarantines an unknown exchange: the same key replays it with no second exchange, and status reports it', async () => {
        const t = await setup(async () => new Response('upstream', { status: 502 }));
        expect(await (await t.create()).json()).toMatchObject({ operation: { state: 'exchange_unknown', reason: 'gateway_unavailable', replayed: false } });
        for (let i = 0; i < 3; i++) expect(await (await t.create()).json()).toMatchObject({ operation: { state: 'exchange_unknown', replayed: true } });
        expect(t.fetchImpl).toHaveBeenCalledTimes(1);
        expect(await (await t.status()).json()).toMatchObject({ session: { latest: { state: 'exchange_unknown', settled: true } } });
        await rows(`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = $1`, t.ids.computerId);
        expect((await t.status()).status).toBe(404);
    });
});
