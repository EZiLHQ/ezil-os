// Decides what "Revert" may do to a file, from its content *now*. Pure so it is
// unit-testable; the reviewer reads the file and applies the plan.
import type { FileDiff } from '../opencode/adapter';
import { applyUnifiedPatch } from './patch';

export type RevertPlan =
    | { action: 'write'; content: string }
    | { action: 'delete' }
    | { action: 'refuse'; reason: string };

/**
 * Reverse-apply the edit's patch to the current content. When that fails the file
 * has changed since the edit (a later edit, the user, a formatter) and reverting
 * would clobber work that is not ours, so refuse. Never falls back to git HEAD.
 */
export function planRevert(current: string | undefined, diff: FileDiff): RevertPlan {
    if (diff.status === 'deleted') {
        if (current !== undefined) return { action: 'refuse', reason: 'the file has been recreated since OpenCode deleted it' };
        const restored = applyUnifiedPatch('', diff.patch, { reverse: true });
        return restored === undefined ? { action: 'refuse', reason: 'the deletion patch cannot be reversed' } : { action: 'write', content: restored };
    }
    if (current === undefined) return { action: 'refuse', reason: 'the file no longer exists' };
    const reversed = applyUnifiedPatch(current, diff.patch, { reverse: true });
    if (reversed === undefined) return { action: 'refuse', reason: 'the file changed after this edit, so the edit cannot be undone on its own' };
    if (diff.status === 'added') {
        return reversed.trim() === '' ? { action: 'delete' } : { action: 'refuse', reason: 'the file gained content after OpenCode created it' };
    }
    return { action: 'write', content: reversed };
}
