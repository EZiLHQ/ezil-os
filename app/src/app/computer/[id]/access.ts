/**
 * Pure ownership-guard decision logic for `/computer/[id]`, extracted out
 * of `page.tsx` so it is unit-testable without rendering a React server
 * component.
 *
 * The actual enforcement lives server-side in `computer.get` (scoped to
 * `(id, userId, deletedAt IS NULL)`, throwing a plain `NOT_FOUND` — never a
 * distinguishing `FORBIDDEN` — for a computer that either doesn't exist or
 * belongs to another user; see `server/api/routers/computer.ts`). This
 * helper's only job is to make sure the PAGE never leaks that distinction
 * either: any failure to fetch (missing id, thrown error of any kind)
 * collapses to the same `not_found` state.
 *
 * Carried verbatim from EBuilder's
 * `apps/web/client/src/app/computer/[id]/access.ts` (authored
 * post-Onlook-import, listed as safe to carry) — no changes needed.
 */

export type ComputerPageState<TComputer> =
    | { status: 'not_found' }
    | { status: 'ready'; computer: TComputer };

/**
 * Resolves the render state for `/computer/[id]`.
 *
 * @param computerId   The route param, possibly empty/undefined.
 * @param getComputer  Fetches the computer, scoped to the caller — expected
 *                     to throw (e.g. a `TRPCError` with code `NOT_FOUND`)
 *                     for a missing OR not-owned computer.
 */
export async function resolveComputerPageState<TComputer>(
    computerId: string | undefined,
    getComputer: (id: string) => Promise<TComputer>,
): Promise<ComputerPageState<TComputer>> {
    if (!computerId) {
        return { status: 'not_found' };
    }

    try {
        const computer = await getComputer(computerId);
        return { status: 'ready', computer };
    } catch {
        // Deliberately swallows the specific error (NOT_FOUND vs. a
        // transient DB/network failure) — the page must not distinguish
        // "doesn't exist" from "not yours" from "something went wrong",
        // so there is nothing more specific to branch on here.
        return { status: 'not_found' };
    }
}
