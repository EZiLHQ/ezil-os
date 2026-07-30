import { MAX_COMPUTERS_PER_USER } from '@/utils/constants';

/**
 * Pure decision logic for the "New computer" slot's cap-reached state.
 * Extracted out of the component so it is unit-testable directly, mirroring
 * the `pickFreeSlot` pattern in `server/api/routers/computer.ts`.
 *
 * Carried verbatim from EBuilder's
 * `apps/web/client/src/app/computers/_lib/computer-limit.ts` (authored
 * post-Onlook-import, listed as safe to carry) — no changes needed.
 */
export interface NewComputerTileState {
    /** True once the user already has `MAX_COMPUTERS_PER_USER` live computers. */
    atCap: boolean;
    /** Whether the "New computer" slot's primary action should be disabled. */
    disabled: boolean;
}

/**
 * @param liveComputerCount Count of the caller's live (non-soft-deleted)
 *                          computers, as returned by `computer.list`.
 */
export function computeNewComputerTileState(liveComputerCount: number): NewComputerTileState {
    const atCap = liveComputerCount >= MAX_COMPUTERS_PER_USER;
    return { atCap, disabled: atCap };
}
