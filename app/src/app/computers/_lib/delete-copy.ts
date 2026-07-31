/**
 * The confirmation copy for deleting a computer, as data rather than JSX —
 * so the one thing that must not drift from reality (what deleting actually
 * does) is unit-testable, mirroring the `computer-limit.ts` pattern next to
 * it.
 *
 * ## Why this copy says what it says
 *
 * Every clause below was checked against the code that runs, not against
 * what "delete" usually means:
 *
 *   - "shuts this computer's desktop down" — `computer.delete` calls the
 *     Worker's `DELETE /sandbox/:name`, whose `handleTerminate` flushes the
 *     workspace to R2 and then calls `sandbox.destroy()`
 *     (`worker/src/index.ts`).
 *   - "frees slot N" — the stamp on `deleted_at` drops the row out of the
 *     partial unique index `(user_id, slot) WHERE deleted_at IS NULL`, so
 *     `computer.create` immediately sees the slot as free.
 *   - "Your files are not erased" — VERIFIED, not assumed. Deleting is
 *     `UPDATE ... SET deleted_at`; no R2 object is touched by any part of
 *     the delete path. `handleTerminate` does not delete objects, and the
 *     Worker's flush loop is handed a put-only bucket interface
 *     (`worker/src/workspace-persist.ts`) so it structurally cannot. The
 *     only R2 delete in the system is the per-key `POST
 *     /project-files/delete` endpoint, which this app never calls.
 *   - "EZiL OS can't reach them again" — also verified, and the reason this
 *     copy does NOT offer recovery. The R2 prefix is rooted at the
 *     computer's row id; once the row is soft-deleted every product surface
 *     filters it out (`liveComputersOf` / `liveOwnedComputer`) and there is
 *     no restore procedure and no UI that addresses a deleted computer.
 *   - "a new computer starts from an empty workspace" — `create` inserts a
 *     row with a fresh `gen_random_uuid()`, i.e. a different, empty R2
 *     prefix. Reusing the freed SLOT does not reuse the old files.
 *
 * What this copy deliberately does NOT say: that the computer can be
 * restored or undone, and that the files are erased. Both would be lies in
 * opposite directions. `delete-copy.test.ts` asserts exactly that.
 */

export interface DeleteComputerCopy {
    title: string;
    /** Paragraphs, in order. */
    body: readonly string[];
    confirmLabel: string;
    cancelLabel: string;
    /** Label while the mutation is in flight. */
    pendingLabel: string;
}

export function deleteComputerCopy({ name, slot }: { name: string; slot: number }): DeleteComputerCopy {
    return {
        title: `Delete “${name}”?`,
        body: [
            `Deleting shuts this computer's desktop down and frees slot ${slot} for a new one.`,
            'Your files are not erased — they stay in storage. But EZiL OS can’t reach them again: a deleted computer can’t be reopened or restored, and a new computer starts from an empty workspace.',
        ],
        confirmLabel: 'Delete computer',
        cancelLabel: 'Keep computer',
        pendingLabel: 'Deleting…',
    };
}
