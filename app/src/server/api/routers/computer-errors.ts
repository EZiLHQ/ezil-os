/**
 * Reason -> wire error, for the computer create path.
 *
 * Its own module for one reason: it is the piece a test most needs to be able
 * to assert directly ("a concurrent double-create surfaces as the TYPED
 * `computer_limit_reached`, never a 500"), and `./computer.ts` cannot be
 * imported by a unit test — it pulls in `../trpc` -> `@/server/db` -> `@/env`,
 * i.e. a validated environment and a connection pool. This module imports
 * `@trpc/server` and nothing else, so the mapping is testable on its own,
 * exactly like `./computer-store.ts` is for the row rules.
 *
 * `./computer-store.ts` deliberately returns REASONS rather than throwing
 * (see `CreateComputerOutcome`); this is the single place those reasons
 * become the error the browser sees.
 */

import { TRPCError } from '@trpc/server';

/** Every way the create path can decline to produce a computer. */
export type ComputerCreateFailureReason = 'computer_limit_reached' | 'insert_returned_no_row';

/**
 * `computer_limit_reached` is a FORBIDDEN with that exact message — a
 * user-facing, typed refusal the browser already switches on (see
 * `src/app/computers/_lib/computer-limit.ts`). It covers BOTH ways the cap
 * is hit: the read found every slot taken, and a concurrent insert won the
 * slot first (SQLSTATE 23505 on the partial unique index). A raw unique
 * violation must never reach the client as an opaque 500, and must never
 * become a duplicate computer.
 *
 * `insert_returned_no_row` is the genuinely unexpected one and keeps the
 * INTERNAL_SERVER_ERROR + "Failed to create computer." this router has
 * always thrown for it. It is deliberately NOT folded into the cap error:
 * telling a user with one computer that they are at a limit of two would be
 * a lie about their own account.
 */
export function computerCreateError(reason: ComputerCreateFailureReason): TRPCError {
    if (reason === 'computer_limit_reached') {
        return new TRPCError({ code: 'FORBIDDEN', message: 'computer_limit_reached' });
    }
    return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create computer.' });
}
