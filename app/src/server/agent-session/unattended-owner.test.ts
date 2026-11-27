/**
 * Who may take the editor bridge from whom (docs/UNATTENDED-CODE.md). The
 * computer's private unattended workbench syncs as `unattended.<id>`; a window a
 * person opened syncs as anything else (`ext.<id>` today). While a lease is
 * live, only a person's window may displace the private workbench; every other
 * pairing keeps today's rule (the live owner stays, the other waits for the
 * lease to lapse). The displaced owner's held work becomes `uncertain`, as for
 * any owner change; that path is covered by agent-session.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { attendedPreempts, isUnattendedOwner, UNATTENDED_OWNER_PREFIX } from './store';

describe('the private unattended workbench yields to a person\'s window', () => {
    it('recognises the private workbench by OS\'s prefix only', () => {
        expect(UNATTENDED_OWNER_PREFIX).toBe('unattended.');
        expect(isUnattendedOwner('unattended.1f2e')).toBe(true);
        for (const id of ['ext.1f2e', 'unattended', 'xunattended.1', 'ext.unattended.1', '']) expect(isUnattendedOwner(id)).toBe(false);
    });

    it('a person\'s window preempts a live private workbench; nothing else preempts anything', () => {
        expect(attendedPreempts('unattended.a', 'ext.b')).toBe(true);
        expect(attendedPreempts('unattended.a', 'os-lease')).toBe(true);
        // The private workbench never takes a live window's lease.
        expect(attendedPreempts('ext.b', 'unattended.a')).toBe(false);
        // Two windows, or two private workbenches (a stale boot and a new one): the live one keeps it.
        expect(attendedPreempts('ext.a', 'ext.b')).toBe(false);
        expect(attendedPreempts('unattended.a', 'unattended.b')).toBe(false);
        // The same owner is `same`, never a takeover.
        expect(attendedPreempts('unattended.a', 'unattended.a')).toBe(false);
    });
});
