'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Routes } from '@/utils/constants';
import {
    BOOT_LOAD_GRACE_MS,
    BOOT_RELOAD_KEY,
    BOOT_STALL_MS,
    judgeArrival,
    stallCopy,
    type StallReason,
} from './boot-watchdog-logic';

interface ShellWindow {
    __EZIL_BOOT__?: unknown;
    ezil?: { mounted?: boolean; stalled?: unknown };
}

/** The only thing that counts as "the OS is on screen". */
function shellIsUp(): boolean {
    const w = window as unknown as ShellWindow;
    return Boolean(w.ezil?.mounted) && Boolean(document.querySelector('.taskbar'));
}

/**
 * The half of the boot contract that runs when the shell does not.
 *
 * Renders NOTHING while the OS is booting or booted — it is not a spinner and
 * it must never look like one. `/os` already server-renders the wallpaper, and
 * the shell draws its own honest progress panel inside the desktop window.
 * This component exists for exactly one moment: the one where neither of those
 * happened. See `boot-watchdog-logic.ts` for the reasoning and for the tests
 * covering every branch.
 *
 * 🔴 It does not participate in the hydration contract. It renders `null` on
 * the server AND on the first client render, so there is nothing to mismatch,
 * and it never writes to `<body>` or `#ezil-os-root` — the panel is a sibling
 * React has owned since the server render. See `hydration-signal.tsx`.
 */
export function BootWatchdog() {
    const [stall, setStall] = useState<StallReason | null>(null);

    /*
     * The shell's own surrender signal, bound for the LIFE of the component
     * rather than just for the boot window: a desktop can be destroyed, and
     * its rebuild budget exhausted, hours into a session. A surrender that
     * happened BEFORE this ran — the bundle is `defer`red and can give up
     * before React runs an effect — is picked up from the `ezil.stalled`
     * latch by the poll below.
     */
    useEffect(() => {
        const onShellStalled = () => setStall(prev => prev ?? 'shell-gave-up');
        window.addEventListener('ezil:stalled', onShellStalled);
        return () => window.removeEventListener('ezil:stalled', onShellStalled);
    }, []);

    /* The arrival check, then the bounded wait. */
    useEffect(() => {
        if (shellIsUp()) {
            // A healthy boot returns the reload budget, so a later strand in
            // this same tab still gets its one recovery.
            forgetReload();
            return;
        }

        const w = window as unknown as ShellWindow;
        const verdict = judgeArrival({
            navigationName: performance.getEntriesByType('navigation')[0]?.name ?? null,
            pathname: window.location.pathname,
            hasBootPayload: typeof w.__EZIL_BOOT__ !== 'undefined',
            reloadSpent: reloadBudget.spent(),
            canRecordReload: reloadBudget.recordable(),
        });

        if (verdict.action === 'reload') {
            // 🔴 Recorded BEFORE the reload, never after. If the write could
            // be skipped by the navigation, the budget would bound nothing.
            reloadBudget.spend();
            console.warn(
                '[ezil-os:watchdog] no boot payload after a client-side navigation;'
                + ' reloading once to get a document load',
            );
            window.location.reload();
            return;
        }

        /*
         * Every stall is raised from the poll, never synchronously from this
         * effect body — a decision that is already made just gets a deadline
         * in the past. The poll is the external system this component is
         * genuinely subscribed to (the shell is not a React tree and has no
         * other way to report itself), and routing all four exits through one
         * place is also why "booted" always wins over "timed out".
         */
        const settled: StallReason = verdict.action === 'stall' ? verdict.reason : 'timeout';
        let deadline = verdict.action === 'stall' ? 0 : Date.now() + BOOT_STALL_MS;

        // The deadline moves out if `load` lands late: before `load` the
        // deferred bundle has not necessarily executed, so declaring failure
        // then would be guessing. Only for a boot that might still arrive.
        const onLoad = () => { deadline = Math.max(deadline, Date.now() + BOOT_LOAD_GRACE_MS); };
        if (verdict.action === 'watch' && document.readyState !== 'complete') {
            window.addEventListener('load', onLoad, { once: true });
        }

        const poll = setInterval(() => {
            if (shellIsUp()) {
                forgetReload();
                clearInterval(poll);
                return;
            }
            if (w.ezil?.stalled) {
                clearInterval(poll);
                setStall(prev => prev ?? 'shell-gave-up');
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(poll);
                setStall(prev => prev ?? settled);
            }
        }, 250);

        return () => {
            clearInterval(poll);
            window.removeEventListener('load', onLoad);
        };
    }, []);

    if (!stall) return null;

    const copy = stallCopy(stall);
    return (
        <div
            data-ezil-stalled={stall}
            role="alertdialog"
            aria-labelledby="ezil-stalled-title"
            className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
        >
            <div className="w-full max-w-md space-y-4 rounded-lg border border-white/15 bg-charcoal p-8 text-center">
                <h1 id="ezil-stalled-title" className="text-2xl font-semibold text-offwhite">
                    {copy.title}
                </h1>
                <p className="text-sm text-gray-400">{copy.body}</p>
                <div className="flex items-center justify-center gap-3 pt-2">
                    <button
                        type="button"
                        onClick={() => {
                            // A user-initiated reload is not the automatic
                            // one, so it re-arms the net for wherever it lands.
                            forgetReload();
                            window.location.reload();
                        }}
                        className="rounded-md bg-teal px-4 py-2 text-sm font-medium text-black hover:opacity-90"
                    >
                        Reload
                    </button>
                    <Link
                        href={Routes.COMPUTERS}
                        className="rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-offwhite hover:bg-white/10"
                    >
                        Your computers
                    </Link>
                </div>
                <p className="pt-1 text-xs text-gray-500">{copy.detail}</p>
            </div>
        </div>
    );
}

/**
 * The one-reload budget. Every access is guarded: `sessionStorage` throws
 * outright under some privacy configurations, and a watchdog that throws is a
 * watchdog that guarantees the dead page it was added to prevent.
 */
const reloadBudget = {
    recordable(): boolean {
        try {
            const probe = `${BOOT_RELOAD_KEY}:probe`;
            window.sessionStorage.setItem(probe, '1');
            window.sessionStorage.removeItem(probe);
            return true;
        } catch {
            return false;
        }
    },
    spent(): boolean {
        try {
            return window.sessionStorage.getItem(BOOT_RELOAD_KEY) !== null;
        } catch {
            return false;
        }
    },
    spend(): void {
        try {
            window.sessionStorage.setItem(BOOT_RELOAD_KEY, String(Date.now()));
        } catch {
            /* `recordable()` already gated this. */
        }
    },
};

function forgetReload(): void {
    try {
        window.sessionStorage.removeItem(BOOT_RELOAD_KEY);
    } catch {
        /* ignore */
    }
}
