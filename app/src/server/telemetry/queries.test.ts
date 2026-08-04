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
import { WORKER_SENTINEL_USER_HASH } from './types';

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

    // 🔴 The worker-sentinel exclusion: `errorEvents.userHash` is NOT NULL and
    // worker/container events have no real user, so they are stored under
    // `WORKER_SENTINEL_USER_HASH`. Without this exclusion, every worker error
    // reports "1 distinct user" and the leaderboard lies.
    it('🔴 excludes WORKER_SENTINEL_USER_HASH from the distinctUsers aggregate via FILTER, not WHERE', async () => {
        const { db, statements } = makeTestDb([]);
        await fingerprintLeaderboard(db, { windowHours: 1, limit: 10 });
        const generated = statements[0]!.sql;
        // Must be inside a FILTER clause on the count(DISTINCT ...) aggregate —
        // a WHERE predicate would make a worker-only fingerprint (every row
        // under the sentinel) vanish from the result set entirely rather than
        // showing up with a truthful (possibly zero) distinct-user count.
        expect(generated).toMatch(/count\(distinct e\.user_hash\)\s*filter\s*\(\s*where\s+e\.user_hash\s*<>/i);
        expect(statements[0]!.params).toContain(WORKER_SENTINEL_USER_HASH);
        // And NOT hoisted into the outer WHERE clause (which already carries
        // the received_at/outcome/muted_at predicates) — a WHERE-level
        // exclusion would drop a worker-only fingerprint's row entirely
        // instead of showing it with a truthful distinct-user count.
        const outerWhere = generated.match(/\bwhere\s+e\.received_at[\s\S]*?group\s+by/i)?.[0] ?? '';
        expect(outerWhere).not.toMatch(/user_hash\s*<>/i);
    });

    it('🔴 fingerprintLeaderboardFromRollup excludes the same sentinel from its distinctUsers aggregate', async () => {
        const { db, statements } = makeTestDb([]);
        await fingerprintLeaderboardFromRollup(db, { days: 90 });
        const generated = statements[0]!.sql;
        expect(generated).toMatch(/count\(distinct user_hash\)\s*filter\s*\(\s*where\s+user_hash\s*<>/i);
        expect(statements[0]!.params).toContain(WORKER_SENTINEL_USER_HASH);
    });
});

describe('Q2 — errorRateOverTime: the LEFT JOIN class filter bug the design calls out', () => {
    it('puts an eventClass filter in the JOIN condition, never the WHERE clause', async () => {
        const { db, statements } = makeTestDb([]);
        await errorRateOverTime(db, { hours: 24, eventClass: 'crash' });

        const generated = statements[0]!.sql;
        expect(generated).toMatch(/left\s+join\s+ezil_error_events/i);
        expect(generated).toMatch(/event_class\s*=/i);
        // The load-bearing assertion: this whole query has NO WHERE clause
        // at all in the correct implementation — the class filter folds
        // entirely into the JOIN's ON condition. A regression that instead
        // hoists it into a `WHERE ... e.event_class = ...` (even a `WHERE
        // 1=1 AND e.event_class = ...`, which a narrower "not immediately
        // after WHERE" check would miss) silently turns the LEFT JOIN back
        // into an INNER JOIN, dropping every zero-error hour — exactly the
        // ones that prove a fix worked. Asserting "no WHERE clause exists
        // outside a FILTER (WHERE ...) aggregate" is what actually catches
        // that, not just a check on adjacency to `event_class`. (`FILTER
        // (WHERE ...)` is a legitimate, unrelated use of the word "where"
        // elsewhere in this same query, for the per-row `outcome = 'error'`
        // aggregate filter — stripped out first so it can't false-positive.)
        const withoutFilterWhere = generated.replace(/filter\s*\(\s*where\b[^)]*\)/gi, '');
        expect(withoutFilterWhere).not.toMatch(/\bwhere\b/i);
        // And the filter must be textually INSIDE the ON-clause span (after
        // the JOIN's own `ON`, before `GROUP BY`).
        const onIndex = generated.search(/\bon\s+e\.received_at/i);
        const groupByIndex = generated.search(/\bgroup\s+by\b/i);
        const classFilterIndex = generated.search(/event_class\s*=/i);
        expect(onIndex).toBeGreaterThan(-1);
        expect(classFilterIndex).toBeGreaterThan(onIndex);
        expect(classFilterIndex).toBeLessThan(groupByIndex);
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
