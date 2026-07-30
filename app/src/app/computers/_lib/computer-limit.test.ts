import { describe, expect, it } from 'vitest';

import { MAX_COMPUTERS_PER_USER } from '@/utils/constants';
import { computeNewComputerTileState } from './computer-limit';

describe('computeNewComputerTileState', () => {
    it('is not at cap and not disabled with 0 computers', () => {
        expect(computeNewComputerTileState(0)).toEqual({ atCap: false, disabled: false });
    });

    it('is not at cap and not disabled with one below the cap', () => {
        expect(computeNewComputerTileState(MAX_COMPUTERS_PER_USER - 1)).toEqual({
            atCap: false,
            disabled: false,
        });
    });

    it('is at cap and disabled once the count reaches MAX_COMPUTERS_PER_USER', () => {
        expect(computeNewComputerTileState(MAX_COMPUTERS_PER_USER)).toEqual({
            atCap: true,
            disabled: true,
        });
    });

    it('MAX_COMPUTERS_PER_USER is 2 (mirrors the server cap)', () => {
        expect(MAX_COMPUTERS_PER_USER).toBe(2);
    });

    it('stays at cap/disabled even if count somehow exceeds the max (defensive)', () => {
        expect(computeNewComputerTileState(MAX_COMPUTERS_PER_USER + 1)).toEqual({
            atCap: true,
            disabled: true,
        });
    });
});
