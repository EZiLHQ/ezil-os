// warm.js — EZiL-authored. Not Puter code.
//
// Silently warms a computer's desktop container the moment there is
// something to paint over, so the FIRST real click on Browser is not the
// first request this computer's container has ever seen.
//
// ── Why this exists ─────────────────────────────────────────────────────
// The owner, directly: "The moment I log in, it just shows a computer
// loading and then a mounting screen... App opening should be like opening
// an app — a circular thing rotates a few seconds, then it opens." A
// container that has never been touched takes ~22s to boot
// (docs/PLATFORM-NOTES.md §11). `boot.js` now calls `warm()` right after the
// desktop + taskbar are on screen — well before the user has clicked
// anything — instead of on the first click, so most of that 22s has already
// been spent by the time anyone is watching a spinner.
//
// ── Single-flight, always ────────────────────────────────────────────────
// 🔴 `apps/desktop-window.js`'s own file header calls two concurrent
// `/sandbox/preview` requests against one cold container "the worst possible
// first run" — two boot spinners, one of them lying, no way for the user to
// tell which. `claim()` is how the desktop window gets the SAME in-flight
// (or recently-resolved) request `warm()` already started, instead of firing
// a second one the moment its own window opens.
//
// ── The TTL, and why it is NOT the app-preview bootstrap token's ──────────
// `session.previewUrl()` (the Preview window's sibling) mints a
// `/preview-bootstrap?token=...` URL good for FIVE MINUTES
// (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`, enforced server-side). The
// desktop URL `session.openDesktop()` returns is a different shape entirely:
// `composeBrowserDesktopUrl` (app server) embeds a DETERMINISTIC per-sandbox
// password derived from the HMAC secret and the sandbox id — not a
// time-boxed token — so there is no hard "this URL stops working at T+5m"
// deadline on this path the way there is on Preview's. The Worker's own
// `/sandbox/preview` response does carry an `expiresAt` (`SESSION_TTL_MS`,
// 30 minutes, `worker/src/index.ts`), and the app server forwards it, but
// `session.openDesktop()` never reads or returns that field today — this
// file does not depend on it existing.
//
// `WARM_MAX_AGE_MS` is deliberately far tighter than either of those real
// numbers anyway, because this file is not trying to cache a URL for as long
// as it happens to remain valid — it is trying to have paid for the
// CONTAINER BOOT before the user clicks. A re-mint against an
// already-warm container is cheap (~1s: `ensureDesktop`'s already-exposed
// fast path on the Worker skips the boot entirely), so re-minting past
// `WARM_MAX_AGE_MS` costs almost nothing and buys freshness against anything
// this file cannot see from here — a reaped container, a Worker redeploy, a
// credential derivation that changed. The warm still bought the one thing
// that actually takes 22s; it never claimed to buy the URL forever.
//
// ── What "fresh" measures, and why ───────────────────────────────────────
// Age is measured from RESOLUTION, never from when the request was fired. A
// warm that is still in flight is NEVER re-fired, no matter how long it has
// been pending — firing a second `openDesktop` while the first is still
// outstanding is exactly the "two concurrent requests" failure this file
// exists to prevent, and a slow first boot is not evidence that a second one
// would go any faster. Only once a mint has SETTLED does its age start
// counting toward the deadline.
//
// A FAILED mint is never treated as "warm" and is never cached: the entry is
// dropped the instant it fails, so the next `warm()` or `claim()` call for
// the same computer starts clean — a transient failure at paint time must
// not follow the user to their first real click 45 seconds later.
//
// ── Retries deliberately bypass this file ──────────────────────────────────
// `apps/desktop-window.js` only ever calls `claim()` on a window's FIRST boot
// attempt. An explicit Retry (the user clicking the button after a failure)
// calls `session.openDesktop()` directly instead — "try again" has to mean
// the network is actually asked again, not that a possibly-stale warm result
// is silently replayed. See that file's own comment at the call site.
//
// ── Phase B r8: a warm is not an open (REVERSE-MOVE-CONTRACT §5.9, Option C) ──
// The next open of a held Free computer starts moving its files to the Free
// computer, which cannot be undone. A hover is not that open. So every ask
// `warm()` sends carries `intent: 'warm'`, and on a computer whose open would
// start the move the server creates nothing, boots nothing, and answers the
// stop hold's `computer_stopped` (`isWarmHeld`). Like any failure the warm
// drops it. A window must never be handed it: `claim()` of a warm stops the
// marker on the warm's later asks (they are the click's now), and if the
// warm's answer was that one, it asks a real open, which starts the move.

import session from './session.js';
import { measureDesktopBox } from './apps/desktop-screen.js';

/**
 * Far tighter than either server-side TTL on this path — see the module doc
 * for why that is deliberate rather than a guess at the real deadline.
 */
export const WARM_MAX_AGE_MS = 60_000;

/**
 * The one warm this module is holding, if any. `warm`: minted by `warm()` (its asks carry the marker until
 * `claimed`); `claim()`'s own mint is a real open and never is.
 * @type {{computerId: string, promise: Promise<unknown>, resolvedAt: number|null, warm: boolean, claimed: boolean} | null}
 */
let current = null;

/**
 * Phase B r8 (§5.9, Option C): the server's answer to a warm on a computer whose next open would start the move:
 * the stop hold's `computer_stopped`, which `POST /api/shell/desktop` answers for nothing else (the desktop open is
 * never held). Deterministic, so the warm's loop returns it at once, with no telemetry.
 */
export function isWarmHeld (res) {
    return !! res && res.ok !== true && res.errorCode === 'computer_stopped';
}

function isFresh (entry) {
    return !!entry
        && entry.resolvedAt !== null
        && (performance.now() - entry.resolvedAt) < WARM_MAX_AGE_MS;
}

/**
 * The shape to ask the container to boot at, measured HERE rather than taken
 * from a caller.
 *
 * 🔴 THIS IS WHY THE WARM PATH HAD TO KNOW ABOUT SIZING AT ALL. The warm
 * request is what actually boots the container on the common path — the
 * desktop window's first attempt `claim()`s this promise rather than making
 * its own. A warm that asked for nothing would boot every container at the
 * default 1920x1080 and leave the window to correct it with a live resize,
 * which is a capture-pipeline restart on every single first open and is
 * impossible entirely on a container whose X server cannot change mode. So the
 * one request that boots the container is the one that has to carry the size.
 *
 * There is no window yet, so the measurement is of the VIEWPORT — which is
 * exactly right: the desktop window goes full-bleed the moment its desktop is
 * confirmed, and the viewport is the box it ends up in. `measureDesktopBox`
 * returns null when nothing is measurable (no `window` at all, e.g. a node
 * test), and `session.openDesktop` then omits the field entirely.
 */
function bootScreen () {
    try {
        return measureDesktopBox({ view: typeof window !== 'undefined' ? window : null });
    } catch {
        // Sizing is an improvement on a boot; it is not the boot, and it must
        // never be able to stop one. Same rule as `desktop-window.js`'s guard
        // around `ResizeObserver`.
        return null;
    }
}

/**
 * Mint a fresh single-flight entry for `computerId` and make it the current one. `warm`: this is `warm()`'s (a hover
 * or press), so each ask carries `intent: 'warm'` until a window claims it; otherwise it is a real open, with no marker.
 */
function mint (computerId, { warm = false } = {}) {
    const entry = { computerId, promise: null, resolvedAt: null, warm, claimed: false };
    const open = warm
        ? session.openDesktop(computerId, bootScreen(), { warm: () => ! entry.claimed })
        : session.openDesktop(computerId, bootScreen());
    entry.promise = open.then((res) => {
        // `session.openDesktop` is failure-first and never throws (see that
        // file's own header), so this is the only branch that needs
        // handling. Only a genuine success counts as "warm" — a failure must
        // not be replayed as a cached success for up to a minute.
        if (res && res.ok === true) {
            entry.resolvedAt = performance.now();
        } else if (current === entry) {
            current = null;
        }
        return res;
    });
    current = entry;
    return entry;
}

/**
 * Fire the warm for `computerId`, unless one is already in flight or still
 * fresh for it. Fire-and-forget by design — the caller (`boot.js`) does not,
 * and must not, await this.
 *
 * @param {string} computerId
 */
export function warm (computerId) {
    if ( ! computerId ) return;
    if ( session.stoppedByUser?.(computerId) ) return; // the owner stopped it: only an explicit open starts it
    if ( current?.computerId === computerId ) return; // in flight, or claim() will judge freshness
    mint(computerId, { warm: true });
}

/**
 * The desktop window's entry point on its FIRST boot attempt. Returns the
 * SAME promise `warm()` already started if it is still in flight or was
 * resolved recently enough to trust; otherwise mints a fresh one — which,
 * against an already-warm container, resolves in ~1s rather than paying
 * another cold ~22s boot.
 *
 * @param {string} computerId
 * @returns {Promise<unknown>} whatever `session.openDesktop` would have resolved to
 */
export function claim (computerId) {
    if ( ! computerId ) return session.openDesktop(computerId);
    // 🔴 HOTFIX r5 review: the desktop window's open is explicit — it starts a computer the owner
    // stopped, and lifts the hover hold (`session.holdAfterStop`). A warm resolved BEFORE that stop
    // is never handed back: its desktop URL belongs to the instance that stopped.
    if ( session.stoppedByUser?.(computerId) ) {
        session.releaseStopHold?.(computerId);
        if ( current?.computerId === computerId ) current = null;
    }
    if ( current?.computerId === computerId
        && (current.resolvedAt === null || isFresh(current)) ) {
        const entry = current;
        if ( ! entry.warm ) return entry.promise;
        // 🔴 Phase B r8: the click now owns the warm's loop, so its later asks carry no marker. An answer the warm
        // already got for its marker (`isWarmHeld`) is never handed to the window: the click asks a real open.
        entry.claimed = true;
        return entry.promise.then(res => (isWarmHeld(res) ? mint(computerId).promise : res));
    }
    return mint(computerId).promise;
}

/** Test-only: forget whatever this module is holding, so each test starts clean. */
export function _resetForTests () {
    current = null;
}

export default { warm, claim, isWarmHeld, WARM_MAX_AGE_MS, _resetForTests };
