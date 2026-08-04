// activity-heartbeat.js — EZiL-authored. Not Puter code.
//
// The container-billing fix's client-side eligibility rule, pulled out as a
// PURE function for the same reason `boot-phases.js`'s `computeBootUiState`
// is one: a rule that governs a 30-MINUTE real-world deadline cannot be
// proven correct by a test that waits 30 real minutes, any more than a
// 45-second display-gate deadline could be proven by staring at a browser —
// see that file's own scenarios 6-11 for the sibling problem. Splitting the
// DECISION out from the WIRING (the `setInterval`, the `pointerdown`/
// `keydown` listeners, the actual `fetch` — all in `apps/desktop-window.js`)
// means the decision itself is instant and exhaustive to test, and the
// wiring only has to be trusted to call it correctly.
//
// ── The rule, verbatim from the billing brief ───────────────────────────────
// Heartbeat every 60s while the desktop window is open AND
// `document.visibilityState === 'visible'` AND real user input occurred
// within the last 30 minutes. A hidden or genuinely idle tab must STOP
// heartbeating — that is the whole point: the container then cools down on
// the server side. "The desktop window is open" is not this module's
// concern — `apps/desktop-window.js` only ever runs its heartbeat interval
// for the lifetime of the window it belongs to, so by construction nothing
// here is ever asked about a window that is not open.

/** How often the desktop window heartbeats, while eligible. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * How recently real key/pointer input must have been observed for a
 * heartbeat to still be honest. Past this, the tab is open but nobody is
 * there, and reporting activity anyway would be exactly the lie this whole
 * fix exists to stop telling the server.
 */
export const ACTIVITY_FRESH_MS = 30 * 60_000;

/**
 * Should THIS tick send a heartbeat?
 *
 * A pure predicate over one instant: the caller reads `document.
 * visibilityState` and its own tracked "time since last input" fresh, every
 * tick, and hands both in — nothing here reaches for a clock or a global on
 * its own, which is what makes it callable from a test with numbers a real
 * clock would take 30 minutes to produce.
 *
 * @param {object} state
 * @param {boolean} state.visible `document.visibilityState === 'visible'`, read by the caller.
 * @param {number} state.lastInputAgoMs Milliseconds since the last real key/pointer input this window observed.
 * @returns {boolean}
 */
export function shouldHeartbeat ({ visible, lastInputAgoMs }) {
    if ( ! visible ) return false;
    // A negative or non-finite value is not a real measurement (a clock that
    // has not been set up yet, a caller bug) — never treated as "fresh".
    if ( ! Number.isFinite(lastInputAgoMs) || lastInputAgoMs < 0 ) return false;
    return lastInputAgoMs <= ACTIVITY_FRESH_MS;
}

export default { HEARTBEAT_INTERVAL_MS, ACTIVITY_FRESH_MS, shouldHeartbeat };
