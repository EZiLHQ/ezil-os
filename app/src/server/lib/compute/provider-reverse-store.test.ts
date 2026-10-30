import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { PLACEMENT_LOCK_NAMESPACE, type PlacementDb } from './placement';
import { createProviderMigrationStore, MigrationConflictError } from './provider-migrate-store';
import {
    bitmapHas, bitmapSet, EXPORT_CHUNK_BYTES, EXPORT_MAX_BYTES, importComplete, MoveLockIsolationError,
    REVERSE_MOVE_DTO_STAGE, REVERSE_MOVE_HOLDING, REVERSE_MOVE_IN_FLIGHT, REVERSE_MOVE_STATES, REVERSE_MOVE_TRANSITIONS,
    validExportBoot, validExportHead, type ReverseExportBoot, type ReverseExportHead,
} from './provider-reverse-store';

const C = '11111111-1111-4111-8111-111111111111', G = '22222222-2222-4222-8222-222222222222';
const dialect = new PgDialect();
const head = (sizes: number[]): ReverseExportHead => ({ generation: G, sha256: 'a'.repeat(64), entries: 3, skipped: 0,
    bytes: sizes.reduce((a, b) => a + b, 0), chunks: sizes.map((size, i) => ({ i, size, sha256: 'b'.repeat(64) })) });

describe('reverse move states', () => {
    it('only committed and failed_reopened release the computer; before the point of no return every state can fail both ways', () => {
        expect(REVERSE_MOVE_STATES.filter(s => !REVERSE_MOVE_HOLDING.includes(s))).toEqual(['committed', 'failed_reopened']);
        for (const s of REVERSE_MOVE_IN_FLIGHT.filter(state => state !== 'flipping')) {
            expect(REVERSE_MOVE_TRANSITIONS[s]).toEqual(expect.arrayContaining(['failed_reopened', 'failed_needs_operator']));
        }
        // flipping = the Worker commit may have been sent: it never reopens the AWS computer.
        expect(REVERSE_MOVE_TRANSITIONS.flipping).toEqual(['committed', 'failed_needs_operator']);
        expect(REVERSE_MOVE_TRANSITIONS.committed).toEqual([]);
        expect(REVERSE_MOVE_TRANSITIONS.failed_reopened).toEqual([]);
        expect(REVERSE_MOVE_TRANSITIONS.failed_needs_operator).toEqual(['failed_reopened', 'committed']);
        // The happy path is a straight line.
        const path = ['requested'];
        for (let s = 'requested'; s !== 'committed';) path.push(s = REVERSE_MOVE_TRANSITIONS[s as 'requested'][0]!);
        expect(path).toEqual(['requested', 'booting', 'exporting', 'copying', 'checking', 'flipping', 'committed']);
    });
    it('every DTO stage is one the dormant shell already reads (MOVE_STEP_OF, done or failed)', () => {
        const shell = readFileSync(path.resolve(__dirname, '../../../../../shell/ezil/ui/Settings/tabs/computers.js'), 'utf8');
        const table = shell.match(/const MOVE_STEP_OF = \{([^}]+)\}/)?.[1];
        expect(table).toBeDefined();
        const steps = Object.fromEntries(table!.split(',').map(entry => entry.split(':').map(part => part.trim())));
        for (const [state, stage] of Object.entries(REVERSE_MOVE_DTO_STAGE)) {
            if (state === 'committed') expect(stage).toBe('committed');
            else if (state.startsWith('failed_')) expect(stage).toBe(state);
            else expect(steps[stage], `${state} → ${stage}`).toBeDefined();
        }
        expect(['requested', 'booting', 'exporting'].map(s => steps[REVERSE_MOVE_DTO_STAGE[s as 'booting']])).toEqual(['0', '0', '0']);
        expect(['copying', 'checking', 'flipping'].map(s => steps[REVERSE_MOVE_DTO_STAGE[s as 'copying']])).toEqual(['1', '2', '3']);
    });
});

describe('export head validation', () => {
    it('accepts full chunks with a short last chunk, up to 512 chunks and 512 MiB', () => {
        expect(validExportHead(head([1]), G)).toBe(true);
        expect(validExportHead(head([EXPORT_CHUNK_BYTES, EXPORT_CHUNK_BYTES, 7]), G)).toBe(true);
        expect(validExportHead(head(Array(512).fill(EXPORT_CHUNK_BYTES)), G)).toBe(true);
        expect(head(Array(512).fill(EXPORT_CHUNK_BYTES)).bytes).toBe(EXPORT_MAX_BYTES);
    });
    it('refuses a foreign generation, short middle chunks, empty or oversize heads and a wrong byte total', () => {
        for (const bad of [{ ...head([1]), generation: C }, head([7, EXPORT_CHUNK_BYTES]), head([]), head(Array(513).fill(EXPORT_CHUNK_BYTES)),
            head([EXPORT_CHUNK_BYTES + 1]), head([0]), { ...head([5]), bytes: 6 }, { ...head([5]), entries: -1 }, { ...head([5]), skipped: 1.5 },
            { ...head([5]), sha256: 'z'.repeat(64) }, { ...head([5, 5]), chunks: [{ i: 1, size: 5, sha256: 'b'.repeat(64) }] }]) {
            expect(validExportHead(bad, G)).toBe(false);
        }
    });
});

describe('export boot validation (r5: the claim carries the placement region)', () => {
    const boot: ReverseExportBoot = { placementGeneration: 2, leaseEpoch: 3, region: 'ap-south-1', volumeId: 'vol-0b1ffbc8f8cfa6384',
        jobId: null, instanceId: null, fsUuid: null, claimedAt: '2026-10-30T09:00:00.000Z' };
    it('accepts any configured-region shape and refuses a missing or malformed region', () => {
        expect(validExportBoot(boot)).toBe(true);
        expect(validExportBoot({ ...boot, region: 'eu-west-1' })).toBe(true);
        for (const region of [undefined, null, '', 'ap-south', 'ap-south-0', 'AP-SOUTH-1', 'mumbai', ' ap-south-1'])
            expect(validExportBoot({ ...boot, region } as never), String(region)).toBe(false);
    });
});

describe('progress bitmap', () => {
    it('uses the PostgreSQL set_bit order of restore_progress (bit i = byte ⌊i/8⌋, mask 1<<(i%8))', () => {
        const zero = '0'.repeat(128);
        expect(bitmapSet(zero, [0])).toBe('01'.padEnd(128, '0'));
        expect(bitmapSet(zero, [7])).toBe('80'.padEnd(128, '0'));
        expect(bitmapSet(zero, [8])).toBe('0001'.padEnd(128, '0'));
        expect(bitmapSet(zero, [511]).slice(-2)).toBe('80');
        const set = bitmapSet(zero, [3, 300, 3]);
        expect([3, 300, 4, 299].map(i => bitmapHas(set, i))).toEqual([true, true, false, false]);
    });
    it('import is complete only for the current archive and every chunk', () => {
        const h = head([EXPORT_CHUNK_BYTES, 9]);
        const progress = { bitmap: bitmapSet('0'.repeat(128), [0, 1]), bytes: EXPORT_CHUNK_BYTES + 9, archiveSha256: h.sha256, first: '', last: '' };
        expect(importComplete({ exportHead: h, importProgress: progress })).toBe(true);
        expect(importComplete({ exportHead: h, importProgress: { ...progress, bitmap: bitmapSet('0'.repeat(128), [0]) } })).toBe(false);
        expect(importComplete({ exportHead: h, importProgress: { ...progress, archiveSha256: 'c'.repeat(64) } })).toBe(false);
        expect(importComplete({ exportHead: h, importProgress: null })).toBe(false);
    });
});

describe('forward create: cross-direction exclusion', () => {
    const row = { id: G, user_id: G, computer_id: C, from_provider: 'cloudflare', to_provider: 'aws-ec2', to_size: 'standard', state: 'requested',
        generation: null, workspace_head: null, system_head: null, source_etag: null, source_system_etag: null, migrated_etag: null, attempts: 0,
        last_error: null, restore_token_sha256: null, restore_token_expires_at: null, created_at: '2026-10-30 09:00:00+00', updated_at: '2026-10-30 09:00:00.000001+00' };
    function setup(results: unknown[]) {
        const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
        let transactions = 0;
        const execute = async (query: SQL) => { queries.push(dialect.sqlToQuery(query)); return results.shift() ?? []; };
        const db: PlacementDb = { execute, transaction: async fn => { transactions++; return fn({ execute }); } };
        return { store: createProviderMigrationStore(db), queries, transactions: () => transactions };
    }
    it('inserts, probes for 0012, locks the computer with the placement key, then refuses while a reverse move holds it', async () => {
        const f = setup([[row], [{ present: true }], [{ isolation: 'read committed' }], [{ held: 1 }]]);
        await expect(f.store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).rejects.toBeInstanceOf(MigrationConflictError);
        expect(f.transactions()).toBe(1);
        expect(f.queries).toHaveLength(4);
        [/^INSERT INTO public\.ezil_compute_migrations\b/, /^SELECT to_regclass\('public\.ezil_compute_reverse_moves'\) IS NOT NULL AS present$/,
            /^\/\* moves:lock-computer \*\/ SELECT pg_advisory_xact_lock\(/, /^SELECT 1 AS held FROM public\.ezil_compute_reverse_moves\b/]
            .forEach((pattern, i) => expect(f.queries[i]!.sql.trim()).toMatch(pattern));
        expect(f.queries[2]!.sql).toContain('pg_advisory_xact_lock($1::int4, hashtext($2::uuid::text))');
        expect(f.queries[2]!.params).toEqual([PLACEMENT_LOCK_NAMESPACE, C]);
        expect(f.queries[3]!.sql).toContain("state NOT IN ('committed', 'failed_reopened')");
    });
    it('keeps the row when no reverse move holds the computer, or when the database has no 0012', async () => {
        const free = setup([[row], [{ present: true }], [{ isolation: 'read committed' }], []]);
        expect((await free.store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).id).toBe(G);
        const absent = setup([[row], [{ present: false }]]);
        expect((await absent.store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).id).toBe(G);
        expect(absent.queries).toHaveLength(2);
    });
    it('refuses to check under any isolation but READ COMMITTED', async () => {
        const f = setup([[row], [{ present: true }], [{ isolation: 'repeatable read' }]]);
        await expect(f.store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).rejects.toBeInstanceOf(MoveLockIsolationError);
    });
    it('an existing active forward row is returned without a new check', async () => {
        const f = setup([[], [row]]);
        expect((await f.store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).id).toBe(G);
        expect(f.queries).toHaveLength(2);
    });
});
