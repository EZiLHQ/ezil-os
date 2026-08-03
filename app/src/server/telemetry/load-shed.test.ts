import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetLoadShedCacheForTests, setLoadShedCacheForTests, SHED_ABOVE_ROWS, shouldShedLoad } from './load-shed';

describe('shouldShedLoad: the ingest-path circuit breaker', () => {
    afterEach(() => {
        resetLoadShedCacheForTests();
    });

    it('does not shed on a cold cache (never seen an estimate yet)', () => {
        const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) };
        expect(shouldShedLoad(db)).toBe(false);
    });

    it('sheds once the cached estimate is above the ceiling', () => {
        setLoadShedCacheForTests(SHED_ABOVE_ROWS + 1);
        const db = { execute: vi.fn() };
        expect(shouldShedLoad(db)).toBe(true);
        // A fresh cache must not trigger a refresh query at all.
        expect(db.execute).not.toHaveBeenCalled();
    });

    it('does not shed at or below the ceiling', () => {
        setLoadShedCacheForTests(SHED_ABOVE_ROWS);
        const db = { execute: vi.fn() };
        expect(shouldShedLoad(db)).toBe(false);
    });

    it('never awaits the refresh — the decision uses the stale cache, not the fresh one', async () => {
        setLoadShedCacheForTests(0, 10 * 60 * 1000); // stale: forces a refresh attempt
        let resolveQuery!: (v: unknown) => void;
        const db = {
            execute: vi.fn(() => new Promise((resolve) => (resolveQuery = resolve))),
        };
        const decision = shouldShedLoad(db); // must return synchronously
        expect(decision).toBe(false); // stale cache said 0 rows -> no shed, decided BEFORE the query resolves
        expect(db.execute).toHaveBeenCalledTimes(1);
        resolveQuery({ rows: [{ estimate: SHED_ABOVE_ROWS + 1 }] });
        await Promise.resolve();
        await Promise.resolve();
    });

    it('a refresh failure never throws out of shouldShedLoad and keeps the last value', async () => {
        setLoadShedCacheForTests(0, 10 * 60 * 1000);
        const db = { execute: vi.fn().mockRejectedValue(new Error('pg_class unreachable')) };
        expect(() => shouldShedLoad(db)).not.toThrow();
        await new Promise((r) => setTimeout(r, 0));
        expect(shouldShedLoad(db)).toBe(false);
    });
});
