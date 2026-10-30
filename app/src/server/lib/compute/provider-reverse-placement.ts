/**
 * AWS → Cloudflare moves (Phase B): the two providers routing returns while a reverse move exists, and the routing read
 * that picks one (docs/compute/REVERSE-MOVE-CONTRACT.md §5.3). `select.ts` calls `providerForReverseMove` before the
 * placement provider, like `providerForPendingMigration`.
 *
 * 🔴 Both providers are `kind: 'aws-ec2'`. Any other kind is unsafe: the dispatcher swaps every `'cloudflare'` provider for
 * the real Cloudflare adapter (an open during a move would start a sandbox), `computer.delete` retires first only for
 * `'aws-ec2'` (a delete would soft-delete a computer the flip then gives a Cloudflare row), and the sweep's stop proof
 * treats any other kind as running. Every refusal is a VALUE, never a thrown error: the shell answers values only.
 *
 * - **Waiting** (`computer_moving`, retryable `sandbox_starting`): never the forward `computer_migrating`, whose
 *   10-minute shell clock would fail every move. No member ever boots, stops or adopts the export boot: the machine owns it.
 * - **Blocked** (`computer_move_needs_attention`, deterministic `preconditions_unmet`): an operator-attended row.
 */
import { PlacementOwnerError, type PlacementExecutor } from './placement';
import type { ComputeProvider, ComputerRef } from './provider';
import { reverseOpenBlocked } from './provider-reverse';
import { createProviderReverseStore, REVERSE_MOVE_IN_FLIGHT, reverseMovesTablePresent } from './provider-reverse-store';

export const COMPUTER_MOVING = 'computer_moving';
export const COMPUTER_MOVE_NEEDS_ATTENTION = 'computer_move_needs_attention';

/** The reverse waiting answer (§5.3, pinned). */
export function reverseMovingAnswer() {
    return { ok: false as const, error: COMPUTER_MOVING, errorCode: 'sandbox_starting', retryable: true, computeProvider: 'aws-ec2' as const };
}
/** The reverse blocked answer (§5.3, pinned). */
export function reverseBlockedAnswer() {
    return { ok: false as const, error: COMPUTER_MOVE_NEEDS_ATTENTION, errorCode: 'preconditions_unmet', retryable: false, computeProvider: 'aws-ec2' as const };
}

export const reverseWaitingProvider: ComputeProvider = {
    kind: 'aws-ec2',
    ensure: async () => reverseMovingAnswer(),
    status: async () => ({ ...reverseMovingAnswer(), state: 'starting' }),
    activity: async () => ({ ok: false, error: COMPUTER_MOVING }),
    restart: async () => ({ ok: false, error: COMPUTER_MOVING }),
    stop: async () => ({ ok: false, terminated: false, outcome: COMPUTER_MOVING }),
    terminate: async () => ({ ok: false, terminated: false, outcome: COMPUTER_MOVING }),
};

export const reverseBlockedProvider: ComputeProvider = {
    kind: 'aws-ec2',
    ensure: async () => reverseBlockedAnswer(),
    status: async () => ({ ...reverseBlockedAnswer(), state: 'error' }),
    activity: async () => ({ ok: false, error: COMPUTER_MOVE_NEEDS_ATTENTION }),
    restart: async () => ({ ok: false, error: COMPUTER_MOVE_NEEDS_ATTENTION }),
    stop: async () => ({ ok: false, terminated: false, outcome: COMPUTER_MOVE_NEEDS_ATTENTION }),
    terminate: async () => ({ ok: false, terminated: false, outcome: COMPUTER_MOVE_NEEDS_ATTENTION }),
};

/**
 * The routing read (§5.3): the computer's NEWEST reverse row decides. In flight → the waiting provider (`reverse: 'moving'`);
 * `failed_needs_operator` with `openBlocked` → the blocked provider (`reverse: 'blocked'`); anything else (including
 * `abort_unconfirmed`, whose placement settled), none, or no 0012 → null: ordinary routing on the placement. Another
 * owner's row is that owner's (`PlacementOwnerError`, as the forward read). Re-read on every request.
 */
export async function providerForReverseMove(db: PlacementExecutor, computer: ComputerRef):
    Promise<{ provider: ComputeProvider; reverse: 'moving' | 'blocked' } | null> {
    if (!(await reverseMovesTablePresent(db))) return null;
    const m = await createProviderReverseStore(db).readByComputer(computer.computerId);
    if (!m) return null;
    if (m.userId !== computer.userId.toLowerCase()) throw new PlacementOwnerError(computer.computerId);
    if (REVERSE_MOVE_IN_FLIGHT.includes(m.state)) return { provider: reverseWaitingProvider, reverse: 'moving' };
    if (reverseOpenBlocked(m)) return { provider: reverseBlockedProvider, reverse: 'blocked' };
    return null;
}
