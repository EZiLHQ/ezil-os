import { describe, expect, it } from 'vitest';

import {
    arrivedByClientNavigation,
    BOOT_LOAD_GRACE_MS,
    BOOT_STALL_MS,
    judgeArrival,
    stallCopy,
    type ArrivalFacts,
    type StallReason,
} from './boot-watchdog-logic';

/**
 * These pin the two guarantees the watchdog exists to make:
 *
 *   1. AT MOST ONE automatic reload, ever. The reload is the recovery for a
 *      client-side navigation into `/os` (docs/PLATFORM-NOTES.md §17), and a
 *      recovery that can fire twice on the login path is a reload loop
 *      pointed at a user who has just typed their password.
 *   2. SILENCE IS NEVER THE ANSWER. Every branch that is not "the OS is
 *      coming" ends in words on screen, because `/os` server-renders a
 *      full-screen wallpaper that otherwise reads as "still loading" forever.
 */

const facts = (over: Partial<ArrivalFacts> = {}): ArrivalFacts => ({
    navigationName: 'https://app.example/os',
    pathname: '/os',
    hasBootPayload: true,
    reloadSpent: false,
    canRecordReload: true,
    ...over,
});

describe('arrivedByClientNavigation', () => {
    it('is false for a document load of this page', () => {
        expect(arrivedByClientNavigation('https://app.example/os', '/os')).toBe(false);
    });

    it('is TRUE when the loaded document was some other page — the strand', () => {
        // The observed signature: the browser loaded /login and the router
        // swapped /os in underneath it, so the <script src> tags never ran.
        expect(
            arrivedByClientNavigation('https://app.example/login?returnUrl=%2Fos', '/os'),
        ).toBe(true);
        expect(arrivedByClientNavigation('https://app.example/computers', '/os')).toBe(true);
    });

    it('ignores query strings and hashes, which a reload legitimately changes', () => {
        expect(arrivedByClientNavigation('https://app.example/os?x=1#y', '/os')).toBe(false);
    });

    it('treats a missing or unparseable measurement as NOT evidence of a soft nav', () => {
        // An absent Navigation Timing entry must not trigger a reload: no
        // observation is not the same as a negative observation.
        expect(arrivedByClientNavigation(null, '/os')).toBe(false);
        expect(arrivedByClientNavigation('not a url', '/os')).toBe(false);
    });
});

describe('judgeArrival', () => {
    it('does nothing while a boot payload exists — that is a real document load', () => {
        expect(judgeArrival(facts())).toEqual({ action: 'watch' });
        // Even from a soft nav: if the payload is somehow there, the reload
        // is not this component's call to make.
        expect(judgeArrival(facts({ navigationName: 'https://app.example/login' })))
            .toEqual({ action: 'watch' });
    });

    it('reloads once for the strand: soft nav, no payload, budget unspent', () => {
        expect(judgeArrival(facts({
            navigationName: 'https://app.example/login?returnUrl=%2Fos',
            hasBootPayload: false,
        }))).toEqual({ action: 'reload' });
    });

    it('🔴 REFUSES a second reload — this is the loop guard', () => {
        const v = judgeArrival(facts({
            navigationName: 'https://app.example/login?returnUrl=%2Fos',
            hasBootPayload: false,
            reloadSpent: true,
        }));
        expect(v).toEqual({ action: 'stall', reason: 'reload-did-not-help' });
    });

    it('🔴 REFUSES to reload at all when the budget cannot be recorded', () => {
        // `sessionStorage` unusable means an unbounded loop, so we take the
        // honest error over the recovery.
        const v = judgeArrival(facts({
            navigationName: 'https://app.example/login?returnUrl=%2Fos',
            hasBootPayload: false,
            canRecordReload: false,
        }));
        expect(v).toEqual({ action: 'stall', reason: 'cannot-reload-safely' });
    });

    it('does not reload a document load that simply has no payload', () => {
        // Reloading would repeat whatever suppressed the inline script.
        expect(judgeArrival(facts({ hasBootPayload: false })))
            .toEqual({ action: 'stall', reason: 'no-payload' });
    });

    it('never reloads more than once across the whole decision space', () => {
        const bools = [false, true];
        let reloads = 0;
        for (const hasBootPayload of bools) {
            for (const reloadSpent of bools) {
                for (const canRecordReload of bools) {
                    for (const nav of ['https://app.example/os', 'https://app.example/login', null]) {
                        const v = judgeArrival(facts({
                            navigationName: nav, hasBootPayload, reloadSpent, canRecordReload,
                        }));
                        // The only state that reloads is the unspent one.
                        if (v.action === 'reload') {
                            reloads += 1;
                            expect(reloadSpent).toBe(false);
                            expect(canRecordReload).toBe(true);
                            expect(hasBootPayload).toBe(false);
                        }
                    }
                }
            }
        }
        expect(reloads).toBe(1);
    });
});

describe('stallCopy', () => {
    const reasons: StallReason[] = [
        'reload-did-not-help', 'cannot-reload-safely', 'no-payload', 'timeout', 'shell-gave-up',
    ];

    it('states a failure in words, for every reason', () => {
        for (const r of reasons) {
            const c = stallCopy(r);
            expect(c.title).toMatch(/didn’t start|stopped/);
            expect(c.detail.length).toBeGreaterThan(10);
        }
    });

    it('🔴 never implies the OS is still on its way', () => {
        // The whole point: the wallpaper already says "loading". This must
        // contradict it, not agree with it.
        for (const r of reasons) {
            const all = `${stallCopy(r).title} ${stallCopy(r).body} ${stallCopy(r).detail}`;
            expect(all).not.toMatch(/still loading|starting up|almost|hang tight|…$/i);
            expect(all).not.toMatch(/please wait/i);
        }
    });

    it('offers a way out and tells the truth about the files', () => {
        for (const r of reasons) {
            const body = stallCopy(r).body;
            expect(body).toMatch(/Reload/);
            expect(body).toMatch(/computer from the list/);
            // Nothing in any of these failure modes touches the container or
            // R2, so saying the files are safe is a claim we can back.
            expect(body).toMatch(/files are unaffected/);
        }
    });

    it('reports the observation, not a diagnosis', () => {
        expect(stallCopy('timeout').detail).toContain(String(BOOT_STALL_MS / 1000));
        expect(stallCopy('reload-did-not-help').detail).toMatch(/Reloaded once/);
        expect(stallCopy('shell-gave-up').detail).toMatch(/removed from the page/);
    });
});

describe('the budget itself', () => {
    it('waits longer than every observed successful boot', () => {
        // MEASURED: taskbar 618ms warm; 2615ms worst case with 900ms of
        // injected latency on React's chunks; the shell's own hydration cap
        // is 3000ms and it mounts after that.
        expect(BOOT_STALL_MS).toBeGreaterThan(2615 + 3000);
        // And the post-`load` grace covers the hydration cap on its own.
        expect(BOOT_LOAD_GRACE_MS).toBeGreaterThan(3000);
    });
});
