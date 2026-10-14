/**
 * Placement single writer (docs/AWS-COMPUTERS.md C-2, C-3, R8, R13).
 *
 * Runs the real statements against `fake-placement-db.test-support.ts`, whose
 * advisory locks are real mutexes and whose CAS WHERE/SET are parsed from the
 * rendered SQL. Races here are event-loop interleavings, not two Postgres
 * backends; the SQL text the races depend on is pinned below as well.
 */

import { drizzle } from 'drizzle-orm/pg-proxy';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { describe, expect, it } from 'vitest';

import type * as schema from '@/server/db/schema';
import { createFakePlacementDb, DEFAULT_OWNER as OWNER, placementRow } from './fake-placement-db.test-support';
import * as Placement from './placement';
import {
    createAwsPlacement,
    createPlacement,
    DEFAULT_PLACEMENT,
    findDuplicatePlacements,
    leasePlacement,
    PLACEMENT_STATES,
    PLACEMENT_TRANSITIONS,
    PlacementIntegrityError,
    placementTrpcError,
    placementOwnerTrpcError,
    PlacementOwnerError,
    readPlacement,
    RUNNING_CLASS_STATES,
    readAdmissionCounters,
    withAdmission,
    PlacementIsolationError,
    transitionPlacement,
    type PlacementDb,
} from './placement';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Compile-time: the production database and the SQL-capture database both satisfy the surface.
const _prod = null as unknown as PostgresJsDatabase<typeof schema> satisfies PlacementDb;
const _proxy = drizzle(async () => ({ rows: [] })) satisfies PlacementDb;
void _prod;
void _proxy;

async function integrity(promise: Promise<unknown>) {
    const error = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PlacementIntegrityError);
    return error as PlacementIntegrityError;
}

describe('read: no row = cloudflare + r2; anything doubtful fails closed', () => {
    it('no row is the Cloudflare/R2 default', async () => {
        const { db } = createFakePlacementDb();
        expect(await readPlacement(db, A)).toEqual(DEFAULT_PLACEMENT);
        expect(DEFAULT_PLACEMENT).toEqual({ provider: 'cloudflare', store: 'r2', record: null });
    });

    it('one valid row is returned with numeric counters', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A, generation: 3, lease_epoch: 7 })] });
        const p = await readPlacement(db, A);
        expect(p.provider).toBe('aws-ec2');
        expect(p.store).toBe('ebs');
        expect(p.record).toMatchObject({ generation: 3, leaseEpoch: 7, state: 'STOPPED' });
    });

    it('an uppercase id from a caller still matches the lowercase ::text column', async () => {
        // Postgres compares uuids by value and returns `::text` lowercase.
        const db = { execute: async () => ({ rows: [{ ...placementRow({ computer_id: A }), generation: '1', lease_epoch: '0' }] }) };
        const p = await readPlacement(db, A.toUpperCase());
        expect(p.record?.computerId).toBe(A);
    });

    it('a row for a different computer fails closed', async () => {
        const db = { execute: async () => ({ rows: [{ ...placementRow({ computer_id: B }), generation: '1', lease_epoch: '0' }] }) };
        expect((await integrity(readPlacement(db, A))).reason).toBe('invalid_row');
    });

    it('cloudflare may record r2 or s3 (C-2 values)', async () => {
        for (const store of ['r2', 's3']) {
            const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A, provider: 'cloudflare', workspace_store: store })] });
            expect((await readPlacement(db, A)).store).toBe(store);
        }
    });

    it('owner mismatch maps to NOT_FOUND (no ownership oracle)', () => {
        const e = placementOwnerTrpcError(new PlacementOwnerError(A));
        expect(e.code).toBe('NOT_FOUND');
    });

    it('two rows for one computer fail closed as duplicate_placement', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A }), placementRow({ computer_id: A })] });
        expect((await integrity(readPlacement(db, A))).reason).toBe('duplicate_placement');
    });

    it.each([
        ['unknown provider', { provider: 'gcp' }, 'unknown_provider'],
        ['NULL store', { workspace_store: null }, 'unknown_store'],
        ['unknown store', { workspace_store: 'gcs' }, 'unknown_store'],
        ['aws on s3', { workspace_store: 's3' }, 'unknown_store'],
        ['cloudflare on ebs', { provider: 'cloudflare', workspace_store: 'ebs' }, 'unknown_store'],
        ['aws on r2', { workspace_store: 'r2' }, 'unknown_store'],
        ['unknown state', { state: 'running' }, 'unknown_state'],
        ['non-numeric generation', { generation: 'x' }, 'invalid_row'],
        ['negative lease epoch', { lease_epoch: -1 }, 'invalid_row'],
        ['bad timestamp', { lease_until: 'not a date' }, 'invalid_row'],
        ['missing owner', { owner_user_id: null }, 'invalid_row'],
        ['non-uuid owner', { owner_user_id: 'someone' }, 'invalid_row'],
        ['generation above MAX_SAFE_INTEGER', { generation: '9007199254740993' }, 'invalid_row'],
    ] as const)('%s fails closed', async (_label, over, reason) => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A, ...over })] });
        expect((await integrity(readPlacement(db, A))).reason).toBe(reason);
    });

    it('maps to tRPC PRECONDITION_FAILED', () => {
        const e = placementTrpcError(new PlacementIntegrityError('duplicate_placement', A));
        expect(e.code).toBe('PRECONDITION_FAILED');
        expect(e.message).toBe('placement_integrity:duplicate_placement');
    });

    it('the read SQL is bounded and parameterised', async () => {
        const { db, statements } = createFakePlacementDb();
        await readPlacement(db, A);
        expect(statements[0]!.sql).toMatch(/FROM public\.ezil_computer_placements\s+WHERE computer_id = \$1::uuid\s+LIMIT 2/);
        expect(statements[0]!.params).toEqual([A]);
    });
});

describe('create: per-computer advisory lock, then refuse an existing row', () => {
    it('two concurrent creates for one computer yield exactly one row', async () => {
        const { db, placements } = createFakePlacementDb();
        const results = await Promise.all([
            createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' }),
            createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'placement_exists' }]);
        expect(placements).toHaveLength(1);
    });

    it('takes pg_advisory_xact_lock on the computer BEFORE reading or inserting', async () => {
        const { db, statements } = createFakePlacementDb();
        await createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' });
        const sqls = statements.map((s) => s.sql);
        expect(sqls[0]).toBe('BEGIN');
        expect(sqls[1]).toMatch(/SELECT pg_advisory_xact_lock\(\$1::int4, hashtext\(\$2::uuid::text\)\), current_setting\('transaction_isolation'\) AS isolation/);
        expect(statements[1]!.params[1]).toBe(A);
        expect(sqls[2]).toMatch(/placement:read/);
        expect(sqls[3]).toMatch(/INSERT INTO public\.ezil_computer_placements/);
        expect(sqls[4]).toBe('COMMIT');
    });

    it('mixed-case creators of one computer serialise on ONE lock: exactly one row', async () => {
        const { db, placements } = createFakePlacementDb();
        const results = await Promise.all([
            createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' }),
            createPlacement(db, { computerId: A.toUpperCase(), ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(placements).toHaveLength(1);
        expect(placements[0]!.computer_id).toBe(A);
    });

    it('the lock key hashes the canonical uuid text', async () => {
        const { db, statements } = createFakePlacementDb();
        await createPlacement(db, { computerId: A.toUpperCase(), ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' });
        const lock = statements.find((s) => /lock-computer/.test(s.sql))!;
        expect(lock.sql).toMatch(/hashtext\(\$2::uuid::text\)/);
        expect(lock.params[1]).toBe(A);
    });

    it('refuses to create outside READ COMMITTED, before any read or write', async () => {
        const { db, placements, statements } = createFakePlacementDb({}, { isolation: 'repeatable read' });
        await expect(createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' })).rejects.toBeInstanceOf(PlacementIsolationError);
        expect(placements).toEqual([]);
        expect(statements.map((s) => s.sql)).not.toContainEqual(expect.stringMatching(/placement:(read|insert)/));
        expect(statements.at(-1)!.sql).toBe('ROLLBACK');
    });

    it('a new row starts at generation 1, lease_epoch 0, with the provider store', async () => {
        const { db } = createFakePlacementDb();
        const r = await createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'cloudflare', state: 'STOPPED' });
        expect(r.ok && r.placement).toMatchObject({ provider: 'cloudflare', store: 'r2', generation: 1, leaseEpoch: 0 });
    });

    it('an aws-ec2 row starts at lease_epoch 1: the provision is its first lease (C-4 marker fence)', async () => {
        const { db } = createFakePlacementDb();
        const r = await withAdmission(db, (tx, lock) => createAwsPlacement(tx, lock, { computerId: A, ownerUserId: OWNER }));
        expect(r.ok && r.placement).toMatchObject({ provider: 'aws-ec2', store: 'ebs', state: 'PROVISIONING', generation: 1, leaseEpoch: 1 });
    });

    it('aws-ec2 rows cannot be created outside admission', async () => {
        const { db, statements } = createFakePlacementDb();
        await expect(createPlacement(db, { computerId: A, ownerUserId: OWNER, provider: 'aws-ec2', state: 'PROVISIONING' })).rejects.toThrow(/admission/);
        expect(statements).toEqual([]);
    });
});

describe('transitions: CAS on (computer_id, generation, lease_epoch, state)', () => {
    const at = (over: Record<string, unknown> = {}) => createFakePlacementDb({ placements: [placementRow({ computer_id: A, generation: 2, lease_epoch: 5, state: 'LEASED', ...over })] });

    it('a matching expectation moves the state and stamps updated_at', async () => {
        const { db, placements } = at();
        const r = await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 5, state: 'LEASED' }, to: 'STARTING', fields: { instanceId: 'i-1' } });
        expect(r.ok && r.placement).toMatchObject({ state: 'STARTING', generation: 2, leaseEpoch: 5, instanceId: 'i-1' });
        expect(placements[0]!.updated_at).toEqual(new Date('2026-10-13T12:00:00Z'));
    });

    it('a stale lease_epoch loses (guard: lease_epoch)', async () => {
        const { db, placements } = at();
        const r = await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 4, state: 'LEASED' }, to: 'STARTING' });
        expect(r).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(placements[0]!.state).toBe('LEASED');
    });

    it('a stale generation loses (guard: generation)', async () => {
        const { db, placements } = at();
        const r = await transitionPlacement(db, { computerId: A, expected: { generation: 1, leaseEpoch: 5, state: 'LEASED' }, to: 'STARTING' });
        expect(r).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(placements[0]!.state).toBe('LEASED');
    });

    it('a wrong from-state loses even with matching counters (guard: state)', async () => {
        const { db, placements } = at({ state: 'RUNNING' });
        const r = await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 5, state: 'STOPPED' }, to: 'RETIRING' });
        expect(r).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(placements[0]!.state).toBe('RUNNING');
    });

    it('another computer is never touched (guard: computer_id)', async () => {
        const { db, placements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: A, state: 'LEASED' }), placementRow({ computer_id: B, state: 'LEASED' })],
        });
        await transitionPlacement(db, { computerId: A, expected: { generation: 1, leaseEpoch: 0, state: 'LEASED' }, to: 'STARTING' });
        expect(placements.map((p) => p.state)).toEqual(['STARTING', 'LEASED']);
    });

    it('two concurrent transitions from one expectation: exactly one winner', async () => {
        const { db, placements } = at();
        const expected = { generation: 2, leaseEpoch: 5, state: 'LEASED' } as const;
        const results = await Promise.all([
            transitionPlacement(db, { computerId: A, expected, to: 'STARTING' }),
            transitionPlacement(db, { computerId: A, expected, to: 'UNCONFIRMED' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'cas_conflict' }]);
        expect(['STARTING', 'UNCONFIRMED']).toContain(placements[0]!.state);
    });

    it('a CAS that hits duplicate rows rolls back and fails closed', async () => {
        const { db, placements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: A, state: 'LEASED' }), placementRow({ computer_id: A, state: 'LEASED' })],
        });
        const e = await integrity(transitionPlacement(db, { computerId: A, expected: { generation: 1, leaseEpoch: 0, state: 'LEASED' }, to: 'STARTING' }));
        expect(e.reason).toBe('duplicate_placement');
        expect(placements.map((p) => p.state)).toEqual(['LEASED', 'LEASED']);
    });

    it('a duplicate with DIFFERENT keys still refuses the transition (found on real Postgres)', async () => {
        const { db, placements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: A, state: 'LEASED', lease_epoch: 1 }), placementRow({ computer_id: A, state: 'STOPPED' })],
        });
        const e = await integrity(transitionPlacement(db, { computerId: A, expected: { generation: 1, leaseEpoch: 1, state: 'LEASED' }, to: 'STARTING' }));
        expect(e.reason).toBe('duplicate_placement');
        expect(placements.map((p) => p.state)).toEqual(['LEASED', 'STOPPED']);
    });

    it('illegal edges are refused without a statement; LEASED is reachable only by leasing', async () => {
        const { db, statements } = at({ state: 'STOPPED' });
        expect(await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 5, state: 'STOPPED' }, to: 'LEASED' })).toEqual({ ok: false, reason: 'illegal_transition' });
        expect(await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 5, state: 'STOPPED' }, to: 'RUNNING' })).toEqual({ ok: false, reason: 'illegal_transition' });
        expect(statements).toEqual([]);
        for (const from of PLACEMENT_STATES) expect(PLACEMENT_TRANSITIONS[from]).not.toContain('LEASED');
    });

    it('a provision receipt may land RUNNING (the infra provision boots the instance); the epoch does not move', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A, state: 'PROVISIONING', lease_epoch: 1 })] });
        const r = await transitionPlacement(db, { computerId: A, expected: { generation: 1, leaseEpoch: 1, state: 'PROVISIONING' }, to: 'RUNNING', fields: { instanceId: 'i-1' } });
        expect(r.ok && r.placement).toMatchObject({ state: 'RUNNING', generation: 1, leaseEpoch: 1, instanceId: 'i-1' });
        expect(PLACEMENT_TRANSITIONS.PROVISIONING).toEqual(['RUNNING', 'STOPPED', 'UNCONFIRMED']);
        expect(await transitionPlacement(db, { computerId: A, expected: { generation: 1, leaseEpoch: 1, state: 'RUNNING' }, to: 'PROVISIONING' })).toEqual({ ok: false, reason: 'illegal_transition' });
    });

    it('the CAS SQL carries all four guards and RETURNING', async () => {
        const { db, statements } = at();
        await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 5, state: 'LEASED' }, to: 'STARTING' });
        const cas = statements.find((s) => /placement:cas/.test(s.sql))!;
        expect(cas.sql).toMatch(/WHERE computer_id = \$\d+::uuid AND generation = \$\d+ AND lease_epoch = \$\d+ AND state = \$\d+\s+RETURNING/);
        expect(statements.map((s) => s.sql)).not.toContainEqual(expect.stringMatching(/set transaction|set session|isolation level/i));
    });
});

describe('leasing and AWS creation need the admission lock of the same transaction', () => {
    it('leasing bumps lease_epoch by one (and generation only on replace)', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A, generation: 2, lease_epoch: 5 })] });
        const until = new Date('2026-10-13T13:00:00Z');
        const r = await withAdmission(db, (tx, lock) => leasePlacement(tx, lock, { computerId: A, ownerUserId: OWNER, expected: { generation: 2, leaseEpoch: 5 }, leaseUntil: until }));
        expect(r.ok && r.placement).toMatchObject({ state: 'LEASED', generation: 2, leaseEpoch: 6, leaseUntil: until });
        // LEASED → STOPPED (a lapsed lease), then a replace lease reserves generation + 1 as well.
        await transitionPlacement(db, { computerId: A, expected: { generation: 2, leaseEpoch: 6, state: 'LEASED' }, to: 'STOPPED' });
        const r2 = await withAdmission(db, (tx, lock) =>
            leasePlacement(tx, lock, { computerId: A, ownerUserId: OWNER, expected: { generation: 2, leaseEpoch: 6 }, leaseUntil: until, replace: true }),
        );
        expect(r2.ok && r2.placement).toMatchObject({ generation: 3, leaseEpoch: 7 });
    });

    it('a lock minted in another transaction is refused', async () => {
        const { db, placements } = createFakePlacementDb({ placements: [placementRow({ computer_id: A })] });
        const foreign = await withAdmission(db, async (_tx, lock) => lock);
        await expect(
            db.transaction((tx) => leasePlacement(tx, foreign, { computerId: A, ownerUserId: OWNER, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date() })),
        ).rejects.toThrow(/admission lock/);
        await expect(db.transaction((tx) => createAwsPlacement(tx, foreign, { computerId: B, ownerUserId: OWNER }))).rejects.toThrow(/admission lock/);
        const counters = { userId: A, computerId: B, monthStart: new Date(0), now: new Date() };
        await expect(db.transaction((tx) => readAdmissionCounters(tx, foreign, counters))).rejects.toThrow(/admission lock/);
        // Even inside ANOTHER admission, a lock from a different transaction is refused.
        await expect(withAdmission(db, (tx) => readAdmissionCounters(tx, foreign, counters))).rejects.toThrow(/admission lock/);
        expect(placements).toHaveLength(1);
        expect(placements[0]!.state).toBe('STOPPED');
    });

    it('no lock can be minted outside withAdmission: takeAdmissionLock is not exported', () => {
        expect('takeAdmissionLock' in Placement).toBe(false);
        expect(typeof Placement.withAdmission).toBe('function');
    });

    it('withAdmission opens the transaction and takes the global lock as its first statement', async () => {
        const { db, statements } = createFakePlacementDb();
        await withAdmission(db, async () => undefined);
        expect(statements.map((s) => s.sql.slice(0, 40))).toEqual(['BEGIN', expect.stringMatching(/placement:lock-admission/), 'COMMIT']);
    });

    it('a hand-built lock carrying the right transaction is refused (no symbol to copy)', async () => {
        const { db, placements } = createFakePlacementDb({ placements: [placementRow({ computer_id: A })] });
        const real = await withAdmission(db, async (_tx, lock) => lock);
        expect(Object.getOwnPropertySymbols(real)).toEqual([]);
        expect(Object.keys(real)).toEqual([]);
        await expect(
            db.transaction((tx) => leasePlacement(tx, { ...real } as never, { computerId: A, ownerUserId: OWNER, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date() })),
        ).rejects.toThrow(/admission lock/);
        expect(placements[0]!.state).toBe('STOPPED');
    });

    it('a forged lock object is refused', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: A })] });
        await expect(
            db.transaction((tx) => leasePlacement(tx, {} as never, { computerId: A, ownerUserId: OWNER, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date() })),
        ).rejects.toThrow(/admission lock/);
    });
});

describe('duplicate check', () => {
    it('returns computers with more than one row, via HAVING count(*) > 1', async () => {
        const { db, statements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: A }), placementRow({ computer_id: A }), placementRow({ computer_id: B })],
        });
        expect(await findDuplicatePlacements(db)).toEqual([{ computerId: A, rows: 2 }]);
        expect(statements[0]!.sql).toMatch(/GROUP BY computer_id\s+HAVING count\(\*\) > 1/);
    });
});

describe('running class', () => {
    it('counts every state that may hold a live instance, including UNCONFIRMED and RECOVERING', () => {
        expect([...RUNNING_CLASS_STATES].sort()).toEqual(
            PLACEMENT_STATES.filter((s) => !['STOPPED', 'RETIRED', 'PURGE_ELIGIBLE'].includes(s)).sort(),
        );
        expect(RUNNING_CLASS_STATES).toEqual(expect.arrayContaining(['UNCONFIRMED', 'RECOVERING', 'LEASED', 'RUNNING']));
    });
});
