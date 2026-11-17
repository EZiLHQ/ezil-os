import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { aiCreditsPendingFor } from './ai-credits-pending';
vi.mock('@/server/db', () => ({ db: {} }));
const USER = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const NOW = new Date('2026-11-11T12:00:00Z');
function fixture(rows: unknown = [{ pending: false, unknown: false }]) {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const transaction = vi.fn(async (work: (tx: { execute: typeof execute }) => Promise<unknown>) => work({ execute }));
    return { execute, transaction, db: { transaction } as unknown as Parameters<typeof aiCreditsPendingFor>[1] };
}
describe('trusted owner credit-delivery metadata', () => {
    it.each([[true, false, true], [true, true, true], [false, false, false], [false, true, undefined]])(
        'pending=%s unknown=%s yields %s without consulting a wallet', async (pending, unknown, expected) => {
            const f = fixture([{ pending, unknown }]);
            expect(await aiCreditsPendingFor(USER, f.db, NOW)).toBe(expected);
        });
    it.each([[], [{}], [{ pending: 'false', unknown: false }], [{ pending: false }]].map(rows => ({ rows })))('malformed query answer is unknown: $rows', async ({ rows }) => {
        expect(await aiCreditsPendingFor(USER, fixture(rows).db, NOW)).toBeUndefined();
    });
    it('queries every undelivered grant of exactly this owner, under read-only SQL limits, with guarded casts', async () => {
        const f = fixture();
        expect(await aiCreditsPendingFor(USER, f.db, NOW)).toBe(false);
        expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), { accessMode: 'read only' });
        const queries = f.execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q));
        expect(queries[0]!.sql).toBe("set local statement_timeout = '1000ms'");
        expect(queries[1]!.sql).toBe("set local lock_timeout = '500ms'");
        const { sql, params } = queries[2]!;
        expect(params).toEqual([USER, 'ezil-ai-credits-v1', NOW.toISOString()]);
        expect(sql).toContain("user_id = $1::uuid and kind = 'ai_grant'");
        expect(sql).toContain("payload->>'protocol' = $2");
        expect(sql).toContain("delivered_at is null and payload->'delivery'->>'status' is distinct from 'failed'");
        expect(sql).not.toMatch(/\blimit\b/i);
        expect(sql).toMatch(/case\s+when jsonb_typeof\(payload->'credits'\) = 'number'/);
        expect(sql).toContain("jsonb_typeof(payload->'expiresAt') = 'string'");
        expect(sql).toContain("trunc((payload->>'credits')::numeric)");
        expect(sql).toContain("(payload->>'expiresAt')::timestamptz > $3::timestamptz");
        expect(sql).toContain('bool_or(pending is null)');
    });
    it('a failed or timed-out read omits metadata and logs no private database detail', async () => {
        const f = fixture(); f.transaction.mockRejectedValue(new Error('postgres://private-credential'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await aiCreditsPendingFor(USER, f.db, NOW)).toBeUndefined();
            expect(warn).toHaveBeenCalledExactlyOnceWith('[billing.ai] pending credits unavailable');
        } finally { warn.mockRestore(); }
    });
});
