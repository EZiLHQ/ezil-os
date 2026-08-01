/**
 * The decision logic behind `/os`'s boot watchdog, kept out of the component
 * so it can be tested without a DOM.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * `/os` server-renders its wallpaper (`<div class="desktop ezil-desktop">`,
 * see `page.tsx`) so the first paint costs no JavaScript. That is a real win
 * and it introduced a real hazard: when the shell fails to boot, the wallpaper
 * is still there, full-screen, with nothing on it. It reads as "the OS is
 * loading" and it never stops reading that way.
 *
 * 🔴 That is the same defect this project closed on the desktop frame: A
 * SURFACE ASSERTING HEALTH IT HAS NOT CONFIRMED. `probeDesktopFrame` refuses
 * to call a 500 "ready" no matter how convincingly `load` fired; a wallpaper
 * must likewise refuse to stand in for an OS that did not arrive. So the rule
 * here is the same one: within a bounded time the page either has a shell on
 * it or it SAYS SO, in words, with a way out.
 *
 * ── The two things that go wrong ────────────────────────────────────────────
 * 1. THE SHELL NEVER STARTED because the page was entered by a client-side
 *    navigation, so React inserted the `<script src>` tags and the browser
 *    ignored them (docs/PLATFORM-NOTES.md §17). Signature: no
 *    `window.__EZIL_BOOT__` at all, and a navigation entry whose URL is not
 *    this page. This one is RECOVERABLE — a document load fixes it — so it
 *    gets exactly one automatic reload.
 * 2. ANYTHING ELSE: the bundle 404'd, threw, was blocked, or the shell built
 *    a desktop that something then destroyed more times than its own rebuild
 *    budget allows. Not recoverable by reloading, and pretending otherwise
 *    would be a reload loop. These get the failure state directly.
 *
 * The one reload is bounded by a record in `sessionStorage`. If that record
 * cannot be written — private mode, a storage-partitioning policy, a quota —
 * the reload does NOT happen at all: an unbounded reload loop on the login
 * path would be far worse than an honest error message.
 */

/** `sessionStorage` key marking that this tab has spent its one reload. */
export const BOOT_RELOAD_KEY = 'ezil:os-reloaded';

/**
 * How long after hydration to keep waiting before declaring the boot failed.
 *
 * MEASURED on this production build: taskbar on screen at 618ms warm, and
 * 1482-2615ms with 900ms of injected latency on React's chunks. The shell's
 * own hydration cap is 3000ms, so a pathological-but-working load can mount
 * at ~3.5s. Ten seconds is comfortably past every observed success and still
 * inside the window where a user is willing to be told something went wrong.
 */
export const BOOT_STALL_MS = 10_000;

/**
 * Extra grace measured from the window `load` event, when that lands later
 * than `BOOT_STALL_MS` (a slow network still pulling the 620KB bundle).
 * `load` is the point at which the deferred bundle has definitively executed,
 * so this only has to cover the shell's own hydration cap plus its mount.
 */
export const BOOT_LOAD_GRACE_MS = 4_000;

/** Why the page is telling the user the OS is not coming. */
export type StallReason =
    /** Entered by client-side navigation, and the one reload is already spent. */
    | 'reload-did-not-help'
    /** Entered by client-side navigation, but a bounded reload is not possible. */
    | 'cannot-reload-safely'
    /** A real document load, yet the inline boot payload never executed. */
    | 'no-payload'
    /** The shell had time and did not put a desktop on screen. */
    | 'timeout'
    /** The shell built a desktop, something destroyed it, and it gave up. */
    | 'shell-gave-up';

export type ArrivalVerdict =
    | { action: 'watch' }
    | { action: 'reload' }
    | { action: 'stall'; reason: StallReason };

export interface ArrivalFacts {
    /**
     * `performance.getEntriesByType('navigation')[0].name` — the URL of the
     * document the browser actually loaded. On a client-side navigation this
     * is still the PREVIOUS page's URL, which is the whole tell.
     */
    navigationName: string | null;
    /** `location.pathname` right now. */
    pathname: string;
    /** Is `window.__EZIL_BOOT__` present? */
    hasBootPayload: boolean;
    /** Has this tab already spent its one reload? */
    reloadSpent: boolean;
    /** Can a spent reload be recorded, i.e. is `sessionStorage` usable? */
    canRecordReload: boolean;
}

/**
 * Did this page arrive by a client-side navigation rather than a document
 * load? Compares PATHNAMES, not full URLs: a reload, a hash change or a query
 * string difference must not read as a soft nav.
 *
 * `null` navigationName (no Navigation Timing entry) is treated as NOT a soft
 * nav — an absent measurement is not evidence.
 */
export function arrivedByClientNavigation(navigationName: string | null, pathname: string): boolean {
    if (!navigationName) return false;
    try {
        return new URL(navigationName).pathname !== pathname;
    } catch {
        return false;
    }
}

/**
 * What to do the moment React has hydrated and the shell has not yet drawn
 * anything. Pure; every branch is covered in `boot-watchdog-logic.test.ts`.
 */
export function judgeArrival(facts: ArrivalFacts): ArrivalVerdict {
    // A payload means the inline script ran, which means this was a document
    // load and the bundle is at least on its way. Nothing to decide yet —
    // hand it to the timer.
    if (facts.hasBootPayload) return { action: 'watch' };

    if (!arrivedByClientNavigation(facts.navigationName, facts.pathname)) {
        // A document load whose inline payload script did not run. Reloading
        // would repeat whatever suppressed it, so do not.
        return { action: 'stall', reason: 'no-payload' };
    }
    if (facts.reloadSpent) return { action: 'stall', reason: 'reload-did-not-help' };
    if (!facts.canRecordReload) return { action: 'stall', reason: 'cannot-reload-safely' };
    return { action: 'reload' };
}

export interface StallCopy {
    title: string;
    body: string;
    /** The machine-facing detail, shown small. Never the whole message. */
    detail: string;
}

/**
 * What the user reads. Three rules, all of them load-bearing:
 *   - it says the desktop did NOT start, in those words. No "still loading",
 *     no ellipsis, nothing that a wallpaper could already be implying;
 *   - it says their files are unaffected, because they are — none of these
 *     failures touch the container or R2;
 *   - it never claims to know something it does not. `detail` reports the
 *     observation, not a diagnosis.
 */
export function stallCopy(reason: StallReason): StallCopy {
    const body =
        'Your computer and your files are unaffected — this tab just never'
        + ' finished loading the desktop. Reload to try again, or open your'
        + ' computer from the list.';
    switch (reason) {
        case 'reload-did-not-help':
            return {
                title: 'Your desktop didn’t start',
                body,
                detail: 'Reloaded once already and the shell still did not load.',
            };
        case 'cannot-reload-safely':
            return {
                title: 'Your desktop didn’t start',
                body,
                detail: 'The shell was not loaded, and this tab cannot reload itself safely.',
            };
        case 'no-payload':
            return {
                title: 'Your desktop didn’t start',
                body,
                detail: 'The page loaded without its boot data.',
            };
        case 'shell-gave-up':
            return {
                title: 'Your desktop stopped',
                body,
                detail: 'The desktop was removed from the page and could not be rebuilt.',
            };
        case 'timeout':
        default:
            return {
                title: 'Your desktop didn’t start',
                body,
                detail: `The shell did not appear within ${Math.round(BOOT_STALL_MS / 1000)} seconds.`,
            };
    }
}
