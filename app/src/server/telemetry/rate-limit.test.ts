import { afterEach, describe, expect, it, vi } from 'vitest';

import { isRateLimited, resetRateLimitForTests } from './rate-limit';

describe('isRateLimited', () => {
    afterEach(() => {
        resetRateLimitForTests();
        vi.useRealTimers();
    });

    it('allows the first request for a fresh user', () => {
        expect(isRateLimited('u_aaaaaaaa')).toBe(false);
    });

    it('allows exactly the budget, then rejects the next one within the same window', () => {
        for (let i = 0; i < 20; i++) {
            expect(isRateLimited('u_bbbbbbbb')).toBe(false);
        }
        expect(isRateLimited('u_bbbbbbbb')).toBe(true);
    });

    it('does not let one user affect another', () => {
        for (let i = 0; i < 25; i++) isRateLimited('u_cccccccc');
        expect(isRateLimited('u_dddddddd')).toBe(false);
    });

    it('resets after the window elapses', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        for (let i = 0; i < 20; i++) isRateLimited('u_eeeeeeee');
        expect(isRateLimited('u_eeeeeeee')).toBe(true);

        vi.setSystemTime(61_000);
        expect(isRateLimited('u_eeeeeeee')).toBe(false);
    });
});
