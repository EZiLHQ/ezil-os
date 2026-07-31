import { describe, expect, it } from 'vitest';

import { deleteComputerCopy } from './delete-copy';

/**
 * The confirmation is the only place the product explains what deleting
 * does, so these assertions pin it to what the code actually does — see
 * `delete-copy.ts`'s doc comment for the per-clause verification. If the
 * delete path ever starts erasing R2 objects, or ever gains a restore, the
 * copy has to change and one of these tests has to change with it.
 */
describe('deleteComputerCopy', () => {
    const copy = deleteComputerCopy({ name: 'Workhorse', slot: 2 });
    const body = copy.body.join(' ');

    it('names the computer and the slot the delete frees', () => {
        expect(copy.title).toContain('Workhorse');
        expect(body).toContain('frees slot 2');
    });

    it('says the desktop shuts down', () => {
        expect(body).toMatch(/desktop down/);
    });

    it('states that the files are NOT erased, because they are not', () => {
        // Soft delete is `UPDATE ... SET deleted_at`; nothing in the delete
        // path touches R2. Claiming erasure here would be a lie that scares
        // users off a safe action.
        expect(body).toContain('not erased');
        expect(body).toMatch(/stay in storage/);
    });

    it('promises no recovery, because there is none', () => {
        // There is no restore procedure and no surface that addresses a
        // soft-deleted computer, so the copy must not imply one.
        expect(body).toMatch(/reopened or restored/);
        expect(body).not.toMatch(/\bcan be restored\b/i);
        expect(body).not.toMatch(/\brestore (?:it|them|your)\b/i);
        expect(body).not.toMatch(/\bundo\b/i);
        expect(body).not.toMatch(/\brecoverable\b/i);
        expect(body).not.toMatch(/\brecover\b/i);
    });

    it('does not claim the data is destroyed either', () => {
        expect(body).not.toMatch(/permanently delet/i);
        expect(body).not.toMatch(/\bforever\b/i);
        expect(body).not.toMatch(/wiped|destroyed|lost forever/i);
    });

    it('warns that a replacement computer starts empty', () => {
        // The freed SLOT is reused; the R2 prefix is not — `create` inserts
        // a fresh uuid, which is a different, empty prefix.
        expect(body).toMatch(/starts from an empty workspace/);
    });

    it('labels the safe action as the plain one and the destructive action explicitly', () => {
        expect(copy.cancelLabel).toBe('Keep computer');
        expect(copy.confirmLabel).toBe('Delete computer');
        expect(copy.pendingLabel).toBe('Deleting…');
    });
});
