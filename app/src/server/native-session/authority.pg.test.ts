/** Disposable PostgreSQL only (`EZIL_PG_TEST_URL`); never imports the app DB or reads credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getTableConfig } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nativeSessionOperations } from '@/server/db/schema/native-sessions';
import { PLACEMENT_LOCK_NAMESPACE, PlacementIsolationError, type PlacementExecutor } from '@/server/lib/compute/placement';

import {
    NATIVE_OPERATION_LOCK_NAMESPACE, NATIVE_SESSION_LOCK_NAMESPACE, advanceNativeOperation, claimNativeOperation, lookupNativeOperation, nativeRequestDigest,
    readNativeSessionStatus, recheckNativeAuthority, type NativeAuthorityDb, type NativeCreateRequest, type NativeOperation,
} from './authority';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `native_session_test_${randomUUID().replaceAll('-', '')}`;
const ROOT = path.resolve(__dirname, '../../../..');
const GENERATION = '3000000001'; // above int4: counters must stay bigint end to end
const LEASE_EPOCH = '4294967301';
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe.skipIf(!PG)('native session authority on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 12, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const textOf = (q: SQL): string => q.queryChunks.map(c => c instanceof StringChunk ? c.value.join('') : c instanceof SQL ? textOf(c) : '?').join('');
    type Hook = (statement: string) => Promise<void> | void;
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>, hook?: Hook): PlacementExecutor => ({
        execute: async q => { await hook?.(textOf(q)); return db.execute(scoped(q)); },
    });
    const authority = (hook?: Hook, config?: Parameters<NonNullable<typeof production>['transaction']>[1]): NativeAuthorityDb => ({
        execute: q => executor(production!, hook).execute(q),
        transaction: fn => production!.transaction(tx => fn(executor(tx, hook)), config),
    });
    const db = authority();
    const rows = (q: string, ...args: unknown[]) => client!.unsafe(local(q), args as never[]);

    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // Supabase grants every new public table to anon/authenticated by default; the migration must revoke it.
        await client!.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO anon, authenticated;
            ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated;
            CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, slot smallint NOT NULL DEFAULT 1,
                deleted_at timestamptz NULL)`);
        for (const file of ['docs/aws-computers/sql/0001_compute_placement.sql.txt', 'docs/aws-computers/sql/0002_image_rebase.sql.txt',
            'app/drizzle/0029_native_session_operations.sql']) await client!.unsafe(local(readFileSync(path.join(ROOT, file), 'utf8')));
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    interface Seed { userId: string; computerId: string; fence: string; instance: string }
    const seed = async (placement: Record<string, string | null> = {}, computer: { deleted?: boolean } = {}): Promise<Seed> => {
        const s = { userId: randomUUID(), computerId: randomUUID(), fence: randomUUID(), instance: `i-${randomUUID().replaceAll('-', '').slice(0, 17)}` };
        await rows(`INSERT INTO public.ezil_computers (id, user_id, deleted_at) VALUES ($1, $2, ${computer.deleted ? 'now()' : 'NULL'})`, s.computerId, s.userId);
        const p = { provider: 'aws-ec2', workspace_store: 'ebs', generation: GENERATION, lease_epoch: LEASE_EPOCH, state: 'RUNNING',
            instance_id: s.instance, fence_token: s.fence, lease_until: new Date(Date.now() + 10 * 60_000).toISOString(), owner_user_id: s.userId,
            ...placement };
        if (placement.none !== undefined) return s;
        await rows(`INSERT INTO public.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch,
            state, instance_id, instance_type, volume_id, fence_token, lease_until, updated_at)
            VALUES ($1, $2, $3, $4, $5::bigint, $6::bigint, $7, $8, 'm6i.large', 'vol-11111111111111111', $9::uuid, $10::timestamptz, now())`,
        s.computerId, p.owner_user_id, p.provider, p.workspace_store, p.generation, p.lease_epoch, p.state, p.instance_id, p.fence_token, p.lease_until);
        return s;
    };
    const create = (s: Seed, extra: Partial<NativeCreateRequest> = {}): NativeCreateRequest => ({
        kind: 'create', operationId: randomUUID(), sessionId: randomUUID(), computerId: s.computerId, instructionRevision: 1,
        instructionDigest: DIGEST, taskRef: 'task:native-smoke', ...extra,
    });
    const count = async (s: Seed) => Number((await rows(`SELECT count(*)::text AS n FROM public.ezil_native_session_operations WHERE user_id = $1`, s.userId))[0]!.n);
    const claimed = async (s: Seed, request: NativeCreateRequest) => {
        const result = await claimNativeOperation(db, s.userId, request);
        if (result.kind !== 'claimed') throw new Error(`expected claim, got ${JSON.stringify(result)}`);
        return result.operation;
    };
    const deliver = async (op: NativeOperation) => {
        for (const [from, to, detail] of [['claimed', 'exchanging', {}], ['exchanging', 'granted', { grant: { id: randomUUID(), expiresAt: new Date(Date.now() + 240_000) } }],
            ['granted', 'delivering', {}], ['delivering', 'delivered', {}]] as const) {
            expect(await advanceNativeOperation(db, op, from, to, detail)).not.toBeNull();
        }
    };
    type Step = readonly [NativeOperation['state'], NativeOperation['state'], Parameters<typeof advanceNativeOperation>[4]];
    const settle = async (operationId: string, s: Seed, ...steps: Step[]) => {
        for (const [from, to, detail] of steps) {
            expect(await advanceNativeOperation(db, { userId: s.userId, operationId }, from, to, detail)).not.toBeNull();
        }
    };
    const grant = () => ({ grant: { id: randomUUID(), expiresAt: new Date(Date.now() + 240_000) } });
    const deliveredSession = async () => {
        const s = await seed();
        const request = create(s);
        await deliver(await claimed(s, request));
        return { s, sessionId: request.sessionId };
    };
    const snapshot = (s: Seed) => rows(`SELECT row_to_json(o)::text AS j FROM public.ezil_native_session_operations o
        WHERE user_id = $1 ORDER BY operation_id`, s.userId);
    const tryLock = async (namespace: number, key: string) =>
        (await client!.begin(async c => c`SELECT pg_try_advisory_xact_lock(${namespace}::int4, hashtext(${key})) AS ok`))[0]!.ok as boolean;

    it('installs a server-only, foreign-key-free table that matches the Drizzle model', async () => {
        const table = `${schema}.ezil_native_session_operations`;
        const [meta] = await client!.unsafe(`SELECT c.relrowsecurity AS rls,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
            (SELECT count(*) FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'f')::int AS fks,
            has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') AS client_access
            FROM pg_class c WHERE c.oid = '${table}'::regclass`);
        expect(meta).toEqual({ rls: true, policies: 0, fks: 0, client_access: false });
        await expect(client!.begin(async c => { await c.unsafe('SET LOCAL ROLE authenticated'); return c.unsafe(`SELECT 1 FROM ${table}`); }))
            .rejects.toThrow(/permission denied/);

        const config = getTableConfig(nativeSessionOperations);
        const columns = await client!.unsafe(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_schema = '${schema}' AND table_name = 'ezil_native_session_operations' ORDER BY ordinal_position`);
        expect(columns.map(c => [c.column_name, c.data_type, c.is_nullable === 'NO'])).toEqual(
            config.columns.map(c => [c.name, c.getSQLType(), c.notNull]));
        expect(columns.some(c => /secret|credential|proof|subject|access_token|password/.test(String(c.column_name)))).toBe(false);
        const constraints = await client!.unsafe(`SELECT conname FROM pg_constraint WHERE conrelid = '${table}'::regclass ORDER BY conname`);
        expect(constraints.map(c => c.conname)).toEqual([...config.checks.map(c => c.name), config.primaryKeys[0]!.getName()].sort());
        const indexes = await client!.unsafe(`SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}'
            AND tablename = 'ezil_native_session_operations' AND indexname <> 'ezil_native_session_operations_pkey' ORDER BY indexname`);
        expect(indexes.map(i => i.indexname)).toEqual(config.indexes.map(i => i.config.name).sort());
    });

    it('claims a tombstone pinning digest, session, revision, owner, computer and the bigint placement tuple', async () => {
        const s = await seed();
        const request = create(s);
        const op = await claimed(s, request);
        expect(op).toMatchObject({ userId: s.userId, operationId: request.operationId, kind: 'create', sessionId: request.sessionId,
            computerId: s.computerId, instructionRevision: '1', instructionDigest: DIGEST, taskRef: 'task:native-smoke',
            requestDigest: nativeRequestDigest(request), state: 'claimed', reason: null, grantId: null,
            placement: { generation: GENERATION, leaseEpoch: LEASE_EPOCH, instanceId: s.instance, fenceToken: s.fence } });
        const [raw] = await rows(`SELECT placement_generation::text AS g, placement_lease_epoch::text AS e,
            pg_typeof(placement_generation)::text AS t FROM public.ezil_native_session_operations WHERE operation_id = $1`, request.operationId);
        expect(raw).toEqual({ g: GENERATION, e: LEASE_EPOCH, t: 'bigint' });
        expect(await lookupNativeOperation(db, s.userId, request.operationId)).toEqual(op);
        expect(await lookupNativeOperation(db, randomUUID(), request.operationId)).toBeNull();
    });

    it('replays the same key and input, and conflicts on any other input, also after delete and reassignment', async () => {
        const s = await seed();
        const request = create(s);
        const op = await claimed(s, request);
        const conflicts = [
            { ...request, instructionDigest: `sha256:${'b'.repeat(64)}` }, { ...request, taskRef: 'task:other' },
            { ...request, sessionId: randomUUID() }, { ...request, computerId: randomUUID() },
            { kind: 'renew' as const, operationId: request.operationId, sessionId: request.sessionId },
        ];
        const check = async () => {
            expect(await claimNativeOperation(db, s.userId, request)).toEqual({ kind: 'existing', operation: op });
            for (const other of conflicts) expect(await claimNativeOperation(db, s.userId, other)).toEqual({ kind: 'conflict', reason: 'operation_conflict' });
        };
        await check();
        await rows(`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = $1`, s.computerId);
        await check();
        const newOwner = randomUUID();
        await rows(`UPDATE public.ezil_computers SET deleted_at = NULL, user_id = $2 WHERE id = $1`, s.computerId, newOwner);
        await rows(`UPDATE public.ezil_computer_placements SET owner_user_id = $2, generation = generation + 1 WHERE computer_id = $1`, s.computerId, newOwner);
        await check();
        expect(await count(s)).toBe(1);
        // The same key under another user is another tombstone, not a replay.
        expect((await claimNativeOperation(db, newOwner, { ...request, sessionId: randomUUID() })).kind).toBe('claimed');
    });

    it('refuses without a tombstone unless the live owner has a current RUNNING AWS placement with an unexpired lease', async () => {
        const cases: [string, () => Promise<Seed>, string][] = [
            ['no computer row', async () => ({ ...(await seed()), computerId: randomUUID() }), 'computer_not_found'],
            ['soft-deleted computer', () => seed({}, { deleted: true }), 'computer_not_found'],
            ['foreign placement owner', () => seed({ owner_user_id: randomUUID() }), 'computer_not_found'],
            ['no placement (Cloudflare default)', () => seed({ none: '1' }), 'computer_not_aws'],
            ['cloudflare placement', () => seed({ provider: 'cloudflare', workspace_store: 'r2' }), 'computer_not_aws'],
            ['stopped', () => seed({ state: 'STOPPED' }), 'computer_not_running'],
            ['starting', () => seed({ state: 'STARTING' }), 'computer_not_running'],
            ['no instance', () => seed({ instance_id: null }), 'placement_unavailable'],
            ['empty instance', () => seed({ instance_id: '' }), 'placement_unavailable'],
            ['no fence', () => seed({ fence_token: null }), 'placement_unavailable'],
            ['no lease', () => seed({ lease_until: null }), 'lease_expired'],
            ['expired lease', () => seed({ lease_until: new Date(Date.now() - 1000).toISOString() }), 'lease_expired'],
            ['unknown state', () => seed({ state: 'BOGUS' }), 'placement_invalid'],
        ];
        for (const [name, make, reason] of cases) {
            const s = await make();
            expect(await claimNativeOperation(db, s.userId, create(s)), name).toEqual({ kind: 'refused', reason });
            expect(await count(s), name).toBe(0);
        }
        const dup = await seed();
        await rows(`INSERT INTO public.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch,
            state, updated_at) VALUES ($1, $2, 'aws-ec2', 'ebs', 1, 1, 'STOPPED', now())`, dup.computerId, dup.userId);
        expect(await claimNativeOperation(db, dup.userId, create(dup))).toEqual({ kind: 'refused', reason: 'placement_invalid' });
        const busy = await seed();
        await rows(`UPDATE public.ezil_computer_placements SET image_upgrade_job_id = $2 WHERE computer_id = $1`, busy.computerId, randomUUID());
        expect(await claimNativeOperation(db, busy.userId, create(busy))).toEqual({ kind: 'refused', reason: 'computer_busy' });
    });

    it('serialises concurrent same-key claims on separate connections into one tombstone', async () => {
        const s = await seed();
        const request = create(s);
        const results = await Promise.all(Array.from({ length: 8 }, () => claimNativeOperation(db, s.userId, request)));
        expect(results.filter(r => r.kind === 'claimed')).toHaveLength(1);
        expect(results.filter(r => r.kind === 'existing')).toHaveLength(7);
        const mixed = { ...request, operationId: randomUUID(), sessionId: randomUUID() };
        const races = await Promise.all([claimNativeOperation(db, s.userId, mixed),
            claimNativeOperation(db, s.userId, { ...mixed, instructionDigest: `sha256:${'c'.repeat(64)}` })]);
        expect(races.map(r => r.kind).sort()).toEqual(['claimed', 'conflict']);
        expect(await count(s)).toBe(2);
    });

    it('allows one create per session, also racing on two computers under different computer locks', async () => {
        const a = await seed();
        const b = await seed({}, {});
        await rows(`UPDATE public.ezil_computers SET user_id = $2 WHERE id = $1`, b.computerId, a.userId);
        await rows(`UPDATE public.ezil_computer_placements SET owner_user_id = $2 WHERE computer_id = $1`, b.computerId, a.userId);
        const sessionId = randomUUID();
        const results = await Promise.all([claimNativeOperation(db, a.userId, create(a, { sessionId })),
            claimNativeOperation(db, a.userId, create({ ...b, userId: a.userId }, { sessionId }))]);
        expect(results.map(r => r.kind === 'conflict' ? r.reason : r.kind).sort()).toEqual(['claimed', 'session_exists']);
        expect(await claimNativeOperation(db, a.userId, create(a, { sessionId }))).toEqual({ kind: 'conflict', reason: 'session_exists' });
    });

    it('refuses with no tombstone when the admitted lease cannot hold the latest possible grant, and returns the lease', async () => {
        const leaseUntil = new Date(Math.ceil((Date.now() + 120_000) / 1000) * 1000);
        const s = await seed({ lease_until: leaseUntil.toISOString() });
        expect(await claimNativeOperation(db, s.userId, create(s), { leaseMustCover: new Date(leaseUntil.getTime()) }))
            .toEqual({ kind: 'refused', reason: 'lease_boundary' });
        expect(await claimNativeOperation(db, s.userId, create(s), { leaseMustCover: new Date(Date.now() + 300_000) }))
            .toEqual({ kind: 'refused', reason: 'lease_boundary' });
        expect(await count(s)).toBe(0);
        const ok = await claimNativeOperation(db, s.userId, create(s), { leaseMustCover: new Date(leaseUntil.getTime() - 1) });
        expect(ok).toMatchObject({ kind: 'claimed', leaseUntil });
    });

    it('refuses REPEATABLE READ and SERIALIZABLE before reading or writing anything', async () => {
        const s = await seed();
        for (const isolationLevel of ['repeatable read', 'serializable'] as const) {
            await expect(claimNativeOperation(authority(undefined, { isolationLevel }), s.userId, create(s))).rejects.toBeInstanceOf(PlacementIsolationError);
        }
        expect(await count(s)).toBe(0);
    });

    it('takes the operation lock, then the canonical computer lock, then FOR SHARE, and holds neither after commit', async () => {
        const s = await seed();
        const request = create(s);
        const order: string[] = [];
        let pause!: () => void;
        const paused = new Promise<void>(resolve => { pause = resolve; });
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const hooked = authority(async statement => {
            const marker = /\/\* ([a-z:-]+) \*\//.exec(statement)?.[1];
            if (marker) order.push(marker);
            if (marker === 'placement:read') { pause(); await gate; }
        });
        const pending = claimNativeOperation(hooked, s.userId, request);
        await paused;
        const opKey = `${s.userId}/${request.operationId}`;
        const sessionKey = `${s.userId}/${request.sessionId}`;
        expect(await tryLock(NATIVE_OPERATION_LOCK_NAMESPACE, opKey)).toBe(false);
        expect(await tryLock(NATIVE_SESSION_LOCK_NAMESPACE, sessionKey)).toBe(false);
        expect(await tryLock(PLACEMENT_LOCK_NAMESPACE, s.computerId)).toBe(false);
        // The live owner row is FOR SHARE: a concurrent soft delete waits for the claim to commit.
        let deleted = false;
        const deletion = rows(`UPDATE public.ezil_computers SET deleted_at = now() WHERE id = $1`, s.computerId).then(() => { deleted = true; });
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(deleted).toBe(false);
        release();
        expect((await pending).kind).toBe('claimed');
        await deletion;
        expect(order.slice(0, 6)).toEqual(['native-session:lock-operation', 'native-session:operation', 'native-session:lock-session',
            'native-session:session-create', 'native-session:lock-computer', 'native-session:computer-owner']);
        expect(order).toContain('placement:read');
        expect(order.at(-1)).toBe('native-session:claim');
        expect(await tryLock(NATIVE_OPERATION_LOCK_NAMESPACE, opKey)).toBe(true);
        expect(await tryLock(NATIVE_SESSION_LOCK_NAMESPACE, sessionKey)).toBe(true);
        expect(await tryLock(PLACEMENT_LOCK_NAMESPACE, s.computerId)).toBe(true);
        // Deleted after the claim: the tombstone still replays.
        expect((await claimNativeOperation(db, s.userId, request)).kind).toBe('existing');
    });

    it('rechecks the live tuple before delivery: generation, epoch, instance, fence, state, lease and owner', async () => {
        const changes: [string, string, unknown[]][] = [
            ['generation', 'generation = generation + 1', []], ['lease epoch', 'lease_epoch = lease_epoch + 1', []],
            ['instance', `instance_id = 'i-00000000000000001'`, []], ['fence', 'fence_token = $2::uuid', [randomUUID()]],
            ['state', `state = 'STOPPING'`, []], ['lease', `lease_until = now() - interval '1 second'`, []],
        ];
        const reasons: Record<string, string> = { state: 'computer_not_running', lease: 'lease_expired' };
        for (const [name, set, args] of changes) {
            const s = await seed();
            const op = await claimed(s, create(s));
            expect(await recheckNativeAuthority(db, op), name).toMatchObject({ ok: true });
            await rows(`UPDATE public.ezil_computer_placements SET ${set} WHERE computer_id = $1`, s.computerId, ...args);
            expect(await recheckNativeAuthority(db, op), name).toEqual({ ok: false, reason: reasons[name] ?? 'placement_changed' });
        }
        const s = await seed();
        const op = await claimed(s, create(s));
        await rows(`UPDATE public.ezil_computers SET user_id = $2 WHERE id = $1`, s.computerId, randomUUID());
        expect(await recheckNativeAuthority(db, op)).toEqual({ ok: false, reason: 'computer_not_found' });
    });

    it('moves outcomes only by compare-and-swap; the table refuses illegal moves, identity edits, DELETE and TRUNCATE', async () => {
        const s = await seed();
        const op = await claimed(s, create(s));
        await expect(advanceNativeOperation(db, op, 'claimed', 'delivered')).rejects.toThrow(/illegal/);
        await expect(advanceNativeOperation(db, op, 'exchanging', 'exchange_unknown', { reason: 'made_up' })).rejects.toThrow(/illegal/);
        expect(await advanceNativeOperation(db, op, 'exchanging', 'exchange_unknown', { reason: 'gateway_timeout' })).toBeNull();
        const exchanging = await advanceNativeOperation(db, op, 'claimed', 'exchanging');
        expect(exchanging?.state).toBe('exchanging');
        expect(await advanceNativeOperation(db, op, 'claimed', 'exchanging')).toBeNull();
        const unknown = await advanceNativeOperation(db, op, 'exchanging', 'exchange_unknown', { reason: 'gateway_timeout' });
        expect(unknown).toMatchObject({ state: 'exchange_unknown', reason: 'gateway_timeout', grantId: null });
        const where = `WHERE user_id = '${s.userId}' AND operation_id = '${op.operationId}'`;
        for (const statement of [`UPDATE public.ezil_native_session_operations SET state = 'exchanging', reason = NULL ${where}`,
            `UPDATE public.ezil_native_session_operations SET computer_id = gen_random_uuid() ${where}`,
            `UPDATE public.ezil_native_session_operations SET placement_generation = placement_generation + 1 ${where}`,
            `DELETE FROM public.ezil_native_session_operations ${where}`, `TRUNCATE public.ezil_native_session_operations`]) {
            await expect(rows(statement), statement).rejects.toThrow(/illegal|immutable|permanent/);
        }
        expect(await lookupNativeOperation(db, s.userId, op.operationId)).toEqual(unknown);
    });

    it('renews only a delivered session, on its pinned computer and unchanged placement tuple', async () => {
        const s = await seed();
        const request = create(s);
        const op = await claimed(s, request);
        const renew = { kind: 'renew' as const, operationId: randomUUID(), sessionId: request.sessionId };
        expect(await claimNativeOperation(db, s.userId, { ...renew, sessionId: randomUUID() })).toEqual({ kind: 'refused', reason: 'session_not_found' });
        expect(await claimNativeOperation(db, randomUUID(), renew)).toEqual({ kind: 'refused', reason: 'session_not_found' });
        expect(await claimNativeOperation(db, s.userId, renew)).toEqual({ kind: 'refused', reason: 'session_not_active' });
        await deliver(op);
        const renewed = await claimNativeOperation(db, s.userId, renew);
        expect(renewed).toMatchObject({ kind: 'claimed', operation: { kind: 'renew', computerId: s.computerId, taskRef: op.taskRef,
            instructionDigest: op.instructionDigest, placement: op.placement } });
        // A definite refusal settles the renewal, so the placement check below is reached.
        await settle(renew.operationId, s, ['claimed', 'exchanging', {}], ['exchanging', 'exchange_refused', { reason: 'gateway_refused' }]);
        await rows(`UPDATE public.ezil_computer_placements SET lease_epoch = lease_epoch + 1 WHERE computer_id = $1`, s.computerId);
        expect(await claimNativeOperation(db, s.userId, { ...renew, operationId: randomUUID() })).toEqual({ kind: 'refused', reason: 'placement_changed' });
        expect(await claimNativeOperation(db, s.userId, renew)).toMatchObject({ kind: 'existing' });
    });

    it('reads status as a pure projection inside a READ ONLY transaction, scoped to the owner', async () => {
        const s = await seed();
        const request = create(s);
        const op = await claimed(s, request);
        await deliver(op);
        const renew = await claimNativeOperation(db, s.userId, { kind: 'renew', operationId: randomUUID(), sessionId: request.sessionId });
        const before = await rows(`SELECT row_to_json(o)::text AS j FROM public.ezil_native_session_operations o WHERE user_id = $1 ORDER BY operation_id`, s.userId);
        const status = await production!.transaction(tx => readNativeSessionStatus(executor(tx), s.userId, request.sessionId), { accessMode: 'read only' });
        expect(status?.created).toMatchObject({ operationId: op.operationId, state: 'delivered' });
        expect(status?.latest).toMatchObject({ operationId: renew.kind === 'claimed' ? renew.operation.operationId : '', kind: 'renew', state: 'claimed' });
        expect(await readNativeSessionStatus(db, randomUUID(), request.sessionId)).toBeNull();
        expect(await readNativeSessionStatus(db, s.userId, randomUUID())).toBeNull();
        expect(await rows(`SELECT row_to_json(o)::text AS j FROM public.ezil_native_session_operations o WHERE user_id = $1 ORDER BY operation_id`, s.userId)).toEqual(before);
    });

    it('serialises distinct renewal keys racing on separate connections: exactly one claims, the rest wait for it', async () => {
        const { s, sessionId } = await deliveredSession();
        const keys = Array.from({ length: 6 }, () => randomUUID());
        const results = await Promise.all(keys.map(operationId => claimNativeOperation(db, s.userId, { kind: 'renew', operationId, sessionId })));
        expect(results.filter(r => r.kind === 'claimed')).toHaveLength(1);
        expect(results.filter(r => r.kind !== 'claimed')).toEqual(Array(5).fill({ kind: 'refused', reason: 'renewal_pending' }));
        const winner = keys[results.findIndex(r => r.kind === 'claimed')]!;
        expect(Number((await rows(`SELECT count(*)::text AS n FROM public.ezil_native_session_operations WHERE user_id = $1 AND kind = 'renew'`,
            s.userId))[0]!.n)).toBe(1);
        // The winner's own key still replays its original tombstone.
        expect(await claimNativeOperation(db, s.userId, { kind: 'renew', operationId: winner, sessionId })).toMatchObject({ kind: 'existing',
            operation: { operationId: winner, state: 'claimed' } });
    });

    it('refuses a new renewal key after an unknown renewal until positive reconciliation; the same key replays the original', async () => {
        const unknownEndings: [string, Step[]][] = [
            ['exchange_unknown', [['claimed', 'exchanging', {}], ['exchanging', 'exchange_unknown', { reason: 'gateway_timeout' }]]],
            ['delivery_unknown', [['claimed', 'exchanging', {}], ['exchanging', 'granted', grant()], ['granted', 'delivering', {}],
                ['delivering', 'delivery_unknown', { reason: 'host_no_ack' }]]],
        ];
        for (const [state, steps] of unknownEndings) {
            const { s, sessionId } = await deliveredSession();
            const first = { kind: 'renew' as const, operationId: randomUUID(), sessionId };
            expect((await claimNativeOperation(db, s.userId, first)).kind).toBe('claimed');
            // In flight at every stage before the unknown ending.
            for (const step of steps) {
                expect(await claimNativeOperation(db, s.userId, { ...first, operationId: randomUUID() }), state).toEqual({ kind: 'refused', reason: 'renewal_pending' });
                await settle(first.operationId, s, step);
            }
            const before = await snapshot(s);
            for (let i = 0; i < 3; i++) {
                expect(await claimNativeOperation(db, s.userId, { ...first, operationId: randomUUID() }), state).toEqual({ kind: 'refused', reason: 'renewal_unreconciled' });
            }
            expect(await claimNativeOperation(db, s.userId, first)).toMatchObject({ kind: 'existing', operation: { operationId: first.operationId, state } });
            expect(await snapshot(s)).toEqual(before);
        }
        // Definite outcomes settle a renewal and admit the next key.
        const settledEndings: Step[][] = [
            [['claimed', 'exchanging', {}], ['exchanging', 'exchange_refused', { reason: 'gateway_refused' }]],
            [['claimed', 'exchanging', {}], ['exchanging', 'granted', grant()], ['granted', 'authority_changed', { reason: 'lease_expired' }]],
            [['claimed', 'exchanging', {}], ['exchanging', 'granted', grant()], ['granted', 'delivering', {}], ['delivering', 'host_refused', { reason: 'host_refused' }]],
            [['claimed', 'exchanging', {}], ['exchanging', 'granted', grant()], ['granted', 'delivering', {}], ['delivering', 'delivered', {}]],
        ];
        for (const steps of settledEndings) {
            const { s, sessionId } = await deliveredSession();
            const first = randomUUID();
            expect((await claimNativeOperation(db, s.userId, { kind: 'renew', operationId: first, sessionId })).kind).toBe('claimed');
            await settle(first, s, ...steps);
            expect((await claimNativeOperation(db, s.userId, { kind: 'renew', operationId: randomUUID(), sessionId })).kind).toBe('claimed');
        }
    });

    it('answers no current status once the computer is deleted or reassigned, without touching the tombstones', async () => {
        for (const change of ['deleted', 'reassigned'] as const) {
            const { s, sessionId } = await deliveredSession();
            const created = await readNativeSessionStatus(db, s.userId, sessionId);
            expect(created?.created.state).toBe('delivered');
            await rows(change === 'deleted' ? `UPDATE public.ezil_computers SET deleted_at = now() WHERE id = $1`
                : `UPDATE public.ezil_computers SET user_id = gen_random_uuid() WHERE id = $1`, s.computerId);
            const before = await snapshot(s);
            const status = await production!.transaction(tx => readNativeSessionStatus(executor(tx), s.userId, sessionId), { accessMode: 'read only' });
            expect(status, change).toBeNull();
            expect(await snapshot(s)).toEqual(before);
            expect(before).toHaveLength(1);
            // Historical replay integrity is unchanged.
            expect(await lookupNativeOperation(db, s.userId, created!.created.operationId)).toEqual(created!.created);
        }
    });
});
