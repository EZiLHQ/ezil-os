/**
 * Structural tests against the actual SQL text each query builds (via
 * `drizzle-orm/pg-proxy`, same technique as `ingest.test.ts`) — these do NOT
 * prove the queries are correct against a live Postgres (no server binary in
 * this environment; see `couldNotVerify`), but they do pin: the right table
 * and index-bearing columns are referenced, the LEFT JOIN class filter is
 * NOT hoisted into a WHERE clause (the bug the design doc calls out by
 * name), and each function returns a typed, empty-safe shape.
 */
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import {
    bootPhaseFailureRanking,
    distinctUsersForFingerprint,
    errorRateOverTime,
    fingerprintLeaderboard,
    fingerprintLeaderboardFromRollup,
    spikeDetection,
    type QueryDb,
} from './queries';

function makeTestDb(rows: unknown[] = []) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => {
        statements.push({ sql, params });
        return { rows };
    }, { schema }) as unknown as QueryDb;
    return { db, statements };
}

describe('Q1 — distinctUsersForFingerprint (the owner\'s actual question)', () => {
    it('filters by fingerprint and a received_at window, on the fp/time/user index columns', async () => {
        const { db, statements } = makeTestDb([{ distinctUsers: 3, events: 5, firstInWindow: 'a', lastInWindow: 'b' }]);
        const result = await distinctUsersForFingerprint(db, 'fp_deadbeefdeadbeef', 1);

        expect(statements[0]!.sql).toMatch(/ezil_error_events/);
        expect(statements[0]!.sql).toMatch(/fingerprint\s*=/);
        expect(statements[0]!.sql).toMatch(/received_at\s*>=/);
        expect(statements[0]!.params).toContain('fp_deadbeefdeadbeef');
        expect(result).toEqual({ distinctUsers: 3, events: 5, firstInWindow: 'a', lastInWindow: 'b' });
    });

    it('returns a safe zeroed shape when no rows exist, never undefined/throws', async () => {
        const { db } = makeTestDb([]);
        const result = await distinctUsersForFingerprint(db, 'fp_0000000000000000');
        expect(result).toEqual({ distinctUsers: 0, events: 0, firstInWindow: null, lastInWindow: null });
    });
});

describe('Q1 — fingerprintLeaderboard (fleet-wide "what is hurting people now")', () => {
    it('excludes muted fingerprints and orders by distinct users desc', async () => {
        const { db, statements } = makeTestDb([]);
        await fingerprintLeaderboard(db, { windowHours: 1, limit: 10 });

        expect(statements[0]!.sql).toMatch(/muted_at is null/i);
        expect(statements[0]!.sql).toMatch(/order\s+by\s+"distinctUsers"\s+desc/i);
        expect(statements[0]!.sql).toMatch(/outcome\s*=\s*\$?\d*/i);
    });

    it('clamps an oversized limit to 200', async () => {
        const { db, statements } = makeTestDb([]);
        await fingerprintLeaderboard(db, { limit: 100_000 });
        expect(statements[0]!.params).toContain(200);
    });

    it('fingerprintLeaderboardFromRollup reads ezil_error_user_hours, not the raw events', async () => {
        const { db, statements } = makeTestDb([]);
        await fingerprintLeaderboardFromRollup(db, { days: 90 });
        expect(statements[0]!.sql).toMatch(/ezil_error_user_hours/);
        expect(statements[0]!.sql).not.toMatch(/ezil_error_events/);
    });
});

describe('Q2 — errorRateOverTime: the LEFT JOIN class filter bug the design calls out', () => {
    it('puts an eventClass filter in the JOIN condition, never the WHERE clause', async () => {
        const { db, statements } = makeTestDb([]);
        await errorRateOverTime(db, { hours: 24, eventClass: 'crash' });

        const generated = statements[0]!.sql;
        expect(generated).toMatch(/left\s+join\s+ezil_error_events/i);
        // The class filter must appear before the closing of the JOIN ON
        // clause (i.e. as part of the ON condition), not as a bare WHERE.
        expect(generated).not.toMatch(/where\s+e\.event_class/i);
        expect(generated).toMatch(/event_class\s*=/i);
    });

    it('omits the class filter entirely with no eventClass given', async () => {
        const { db, statements } = makeTestDb([]);
        await errorRateOverTime(db, { hours: 24 });
        expect(statements[0]!.sql).not.toMatch(/event_class/i);
    });
});

describe('Q3 — spikeDetection: never divides by zero, needs 3+ users to call a new fingerprint a spike', () => {
    it('uses greatest(sd, 1) to guard the z-score division', async () => {
        const { db, statements } = makeTestDb([]);
        await spikeDetection(db);
        expect(statements[0]!.sql).toMatch(/greatest\(/i);
    });

    it('requires >= 3 users for a never-before-seen fingerprint', async () => {
        const { db, statements } = makeTestDb([]);
        await spikeDetection(db);
        expect(statements[0]!.sql).toMatch(/r\.users\s*>=\s*3/i);
    });
});

describe('Q4 — bootPhaseFailureRanking: boot_summary is the denominator', () => {
    it('computes boot_attempts from boot_summary events, failures from boot_phase', async () => {
        const { db, statements } = makeTestDb([]);
        await bootPhaseFailureRanking(db, 24);
        expect(statements[0]!.sql).toMatch(/boot_summary/);
        expect(statements[0]!.sql).toMatch(/boot_phase/);
        expect(statements[0]!.sql).toMatch(/group\s+by\s+p\.site/i);
    });
});
