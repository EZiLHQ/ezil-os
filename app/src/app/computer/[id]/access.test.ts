import { describe, expect, it, vi } from 'vitest';

import { resolveComputerPageState } from './access';

/**
 * Tests the ownership-guard decision logic for `/computer/[id]`.
 *
 * The actual ownership scoping is enforced server-side by `computer.get`
 * (see `server/api/routers/computer.test.ts`). This suite covers the
 * PAGE's contract: it must render the same "not found" state whether the
 * id is missing, the computer doesn't exist, or the computer belongs to
 * another user — never leaking which case occurred.
 *
 * Carried verbatim from EBuilder's
 * `apps/web/client/src/app/computer/[id]/access.test.ts` (authored
 * post-Onlook-import, listed as safe to carry) — no changes needed.
 */
describe('resolveComputerPageState', () => {
    it('returns not_found when the route param is missing', async () => {
        const getComputer = vi.fn();
        const state = await resolveComputerPageState(undefined, getComputer);
        expect(state).toEqual({ status: 'not_found' });
        expect(getComputer).not.toHaveBeenCalled();
    });

    it('returns not_found when the route param is empty', async () => {
        const getComputer = vi.fn();
        const state = await resolveComputerPageState('', getComputer);
        expect(state).toEqual({ status: 'not_found' });
        expect(getComputer).not.toHaveBeenCalled();
    });

    it("returns ready with the fetched computer on success (the owner's own computer)", async () => {
        const computer = { id: 'computer-1', name: 'My Computer' };
        const getComputer = vi.fn().mockResolvedValue(computer);

        const state = await resolveComputerPageState('computer-1', getComputer);

        expect(state).toEqual({ status: 'ready', computer });
        expect(getComputer).toHaveBeenCalledWith('computer-1');
    });

    it("returns not_found when getComputer throws NOT_FOUND (computer doesn't exist)", async () => {
        const getComputer = vi.fn().mockRejectedValue(
            Object.assign(new Error('Computer not found'), { code: 'NOT_FOUND' }),
        );

        const state = await resolveComputerPageState('missing-id', getComputer);

        expect(state).toEqual({ status: 'not_found' });
    });

    it("returns not_found when getComputer throws NOT_FOUND for another user's computer — identical to the \"doesn't exist\" case, never distinguished", async () => {
        const notOwnedError = Object.assign(new Error('Computer not found'), {
            code: 'NOT_FOUND',
        });
        const getComputer = vi.fn().mockRejectedValue(notOwnedError);

        const state = await resolveComputerPageState('someone-elses-computer', getComputer);

        expect(state).toEqual({ status: 'not_found' });
    });

    it('collapses ANY thrown error to not_found (e.g. a transient DB error), never crashing the page', async () => {
        const getComputer = vi.fn().mockRejectedValue(new Error('connection reset'));

        const state = await resolveComputerPageState('computer-1', getComputer);

        expect(state).toEqual({ status: 'not_found' });
    });
});
