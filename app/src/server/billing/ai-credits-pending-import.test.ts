import { describe, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ defaultPoolLoads: 0 }));
vi.mock('@/server/db', () => {
    observed.defaultPoolLoads++;
    throw new Error('default pool intentionally unavailable in isolated test');
});
import { aiCreditsPendingFor } from './ai-credits-pending';

const OWNER = '11111111-1111-4111-8111-111111111111';
describe('pending evidence pool initialization boundary', () => {
    it('imports and uses an injected database without loading application credentials', async () => {
        expect(observed.defaultPoolLoads).toBe(0);
        const fixture = { transaction: async (work: (tx: unknown) => Promise<unknown>) => work({
            execute: async () => [{ pending: false, unknown: false }],
        }) } as unknown as Parameters<typeof aiCreditsPendingFor>[1];
        expect(await aiCreditsPendingFor(OWNER, fixture)).toBe(false);
        expect(observed.defaultPoolLoads).toBe(0);
    });
    it('a real default-pool initialization failure is unknown only when the read is invoked', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect(await aiCreditsPendingFor(OWNER)).toBeUndefined();
            expect(observed.defaultPoolLoads).toBe(1);
            expect(warn).toHaveBeenCalledExactlyOnceWith('[billing.ai] pending credits unavailable');
        } finally { warn.mockRestore(); }
    });
});
