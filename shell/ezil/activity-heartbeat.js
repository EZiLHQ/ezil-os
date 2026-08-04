// activity-heartbeat.js — EZiL-authored. Not Puter code.
//
// The container-billing fix's client-side eligibility rule, pulled out as a
// PURE function for the same reason `boot-phases.js`'s `computeBootUiState`
// is one: a rule that governs a 30-MINUTE real-world deadline cannot be
// proven correct by a test that waits 30 real minutes, any more than a
// 45-second display-gate deadline could be proven by staring at a browser —
// see that file's own scenarios 6-11 for the sibling problem. Splitting the
// DECISION out from the WIRING (the `setInterval`, the presence listeners,
// the actual `fetch` — all in `apps/desktop-window.js`) means the decision
// itself is instant and exhaustive to test, and the wiring only has to be
// trusted to call it correctly.
//
// ── The rule ────────────────────────────────────────────────────────────────
// Heartbeat every 60s while the desktop window is open AND
// `document.visibilityState === 'visible'` AND PRESENCE was last true within
// the last 30 minutes. A hidden tab, or a user who has gone elsewhere, must
// STOP the heartbeat — that is the whole point: the container then cools down
// on the server side. "The desktop window is open" is not this module's
// concern — `apps/desktop-window.js` only ever runs its heartbeat interval
// for the lifetime of the window it belongs to, so by construction nothing
// here is ever asked about a window that is not open.
//
// ── 🔴 WHY PRESENCE, AND NOT OBSERVED INPUT ─────────────────────────────────
// The first version of this module gated on "time since real key/pointer
// input THIS WINDOW OBSERVED". That signal is UNOBSERVABLE for this product,
// and shipping it would have stopped containers out from under people who
// were actively working in them.
//
// The desktop is a CROSS-ORIGIN Neko iframe: its `src` comes from
// `session.openDesktop()` and points at another origin, and there is no
// `postMessage` bridge. Every key and every pointer event a user aims at the
// desktop is delivered INSIDE that iframe's browsing context, and the parent
// document — this one — sees none of them. So "last input" froze the instant
// somebody started working, and the server's 10-minute idle-stop would fire
// DURING ACTIVE USE.
//
// `document.hasFocus()` is the signal that survives the origin boundary: it
// stays TRUE while a descendant iframe (cross-origin included) holds focus,
// and goes false when the user switches to another window or another tab. So
//
//     presence := document.visibilityState === 'visible' && document.hasFocus()
//
// is true exactly while the user is looking at, and working in, this desktop
// — including while they are typing into a stream this document structurally
// cannot see — and false the moment they go elsewhere. That is the literal
// owner requirement, "no work, no activity from the user", made observable.
//
// It reports PRESENCE, never a proxy for it: `apps/desktop-window.js` seeds
// its "last present at" clock from an actual observation, never from
// page-load time and never from "the last time I sent a heartbeat" — either
// of those would make the signal self-sustaining, which is the exact
// immortality bug the whole billing fix exists to kill.

/** How often the desktop window heartbeats, while eligible. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How recently PRESENCE must have been observed for a heartbeat to still be
 * honest. Past this, the tab is open but nobody is there, and reporting
 * activity anyway would be exactly the lie this whole fix exists to stop
 * telling the server.
 */
export const ACTIVITY_FRESH_MS = 30 * 60_000;

/**
 * Is a human present at this desktop RIGHT NOW?
 *
 * Pure over one instant, so the caller reads both browser facts fresh and
 * hands them in — see this file's header for why `hasFocus` rather than
 * observed input.
 *
 * 🔴 FAILS TOWARDS PRESENT. `document.hasFocus` is universally implemented,
 * but if a runtime ever lacks it the caller passes `undefined` and this
 * degrades to VISIBILITY ONLY rather than to "nobody is here". Reading an
 * unavailable capability as absence is precisely how the shipped defect
 * behaved, and it stops a container out from under a working user; the
 * opposite mistake only costs a container that lingers until the platform's
 * own `SLEEP_AFTER` backstop collects it.
 *
 * @param {object} state
 * @param {string} state.visibilityState `document.visibilityState`, read by the caller.
 * @param {boolean|undefined} state.hasFocus `document.hasFocus()`, or `undefined` if unimplemented.
 * @returns {boolean}
 */
export function isPresent ({ visibilityState, hasFocus }) {
    if ( visibilityState !== 'visible' ) return false;
    return hasFocus !== false;
}

/**
 * Should THIS tick send a heartbeat?
 *
 * A pure predicate over one instant: the caller reads `document.
 * visibilityState` and its own tracked "time since presence was last true"
 * fresh, every tick, and hands both in — nothing here reaches for a clock or
 * a global on its own, which is what makes it callable from a test with
 * numbers a real clock would take 30 minutes to produce.
 *
 * @param {object} state
 * @param {boolean} state.visible `document.visibilityState === 'visible'`, read by the caller.
 * @param {number} state.lastPresenceAgoMs Milliseconds since {@link isPresent} was last observed true.
 * @returns {boolean}
 */
export function shouldHeartbeat ({ visible, lastPresenceAgoMs }) {
    if ( ! visible ) return false;
    // A negative or non-finite value is not a real measurement — in
    // particular `NaN`, which is what the caller passes when presence has
    // never once been observed since this window opened. Never treated as
    // "fresh": the absence of an observation is not an observation of
    // presence.
    if ( ! Number.isFinite(lastPresenceAgoMs) || lastPresenceAgoMs < 0 ) return false;
    return lastPresenceAgoMs <= ACTIVITY_FRESH_MS;
}

export default { HEARTBEAT_INTERVAL_MS, ACTIVITY_FRESH_MS, isPresent, shouldHeartbeat };
