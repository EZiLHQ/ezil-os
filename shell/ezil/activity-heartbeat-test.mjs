// activity-heartbeat-test.mjs — EZiL-authored. Unit test for the container-
// billing heartbeat's PRESENCE rule and eligibility rule.
//
// Run: node ezil/activity-heartbeat-test.mjs
//
// These are PURE function tests, deliberately not browser/jsdom ones: the
// 30-minute idle threshold this module encodes cannot be proven by a test
// that waits 30 real minutes, any more than `boot-test.mjs`'s display-gate
// scenarios could prove a 45-second deadline by staring at a browser for 45
// seconds per assertion — see that file's own scenarios 6-11 for the sibling
// problem, and `activity-heartbeat.js`'s header for why the decision was
// split out from the wiring specifically so it could be tested this way.
// `apps/desktop-window.js`'s heartbeat wiring (the `setInterval`, the
// focus/blur/visibility listeners, the actual `session.reportActivity` call)
// is proven separately, in `boot-test.mjs`, using real (short) waits and a
// mocked clock for the one number too large to wait out honestly.

import { ACTIVITY_FRESH_MS, HEARTBEAT_INTERVAL_MS, isPresent, shouldHeartbeat } from './activity-heartbeat.js';

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });

// ── The constants themselves, pinned ────────────────────────────────────────
push('HEARTBEAT_INTERVAL_MS is 60s, per the billing contract', HEARTBEAT_INTERVAL_MS === 60_000,
    String(HEARTBEAT_INTERVAL_MS));
push('ACTIVITY_FRESH_MS is 30 minutes, per the billing contract', ACTIVITY_FRESH_MS === 30 * 60_000,
    String(ACTIVITY_FRESH_MS));

// ── 🔴 isPresent — THE SIGNAL THE SHIPPED DEFECT GOT WRONG ──────────────────
// Presence is `visibilityState === 'visible' && document.hasFocus()`, and the
// load-bearing property is the SECOND one: `hasFocus()` stays TRUE while the
// cross-origin Neko iframe holds focus, which is the only reason this window
// can tell "typing into a stream I cannot see" apart from "gone". The old
// rule keyed off input this document observed, saw none of that typing, and
// would have idle-stopped the container mid-session.
push('🔴 visible + focused -> PRESENT (a user working inside the cross-origin iframe)',
    isPresent({ visibilityState: 'visible', hasFocus: true }) === true);
push('🔴 visible + NOT focused -> ABSENT (switched to another window)',
    isPresent({ visibilityState: 'visible', hasFocus: false }) === false);
push('🔴 hidden -> ABSENT however focused it claims to be (switched to another tab)',
    isPresent({ visibilityState: 'hidden', hasFocus: true }) === false);
push('hidden + unfocused -> ABSENT (both reasons agree)',
    isPresent({ visibilityState: 'hidden', hasFocus: false }) === false);
push('a prerendering document is not a present user',
    isPresent({ visibilityState: 'prerender', hasFocus: true }) === false);

// 🔴 FAILS TOWARDS PRESENT. An unimplemented `document.hasFocus` must degrade
// to visibility-only, NOT to "nobody is here" — reading a missing capability
// as absence is exactly how the shipped defect behaved, and it stops a
// container out from under a working user.
push('🔴 visible + hasFocus unavailable (undefined) -> PRESENT, degrading to visibility only',
    isPresent({ visibilityState: 'visible', hasFocus: undefined }) === true);
push('hidden + hasFocus unavailable -> still ABSENT (visibility alone settles it)',
    isPresent({ visibilityState: 'hidden', hasFocus: undefined }) === false);

// ── The happy path ───────────────────────────────────────────────────────────
push('visible + present just now -> heartbeat',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: 0 }) === true);
push('visible + present 5 minutes ago -> still heartbeat',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: 5 * 60_000 }) === true);

// ── 🔴 THE VISIBILITY GUARD — a hidden tab must STOP heartbeating ───────────
push('🔴 hidden + present just now -> NO heartbeat (a backgrounded tab must not bill)',
    shouldHeartbeat({ visible: false, lastPresenceAgoMs: 0 }) === false);
push('hidden, however fresh the presence, never heartbeats',
    shouldHeartbeat({ visible: false, lastPresenceAgoMs: 1 }) === false);

// ── 🔴 THE 30-MINUTE STALENESS GUARD — the boundary, exactly ────────────────
push('🔴 visible + presence exactly at the 30-minute boundary -> still eligible (inclusive)',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: ACTIVITY_FRESH_MS }) === true);
push('🔴 visible + presence ONE MILLISECOND past 30 minutes -> NO heartbeat',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: ACTIVITY_FRESH_MS + 1 }) === false);
push('visible + last present 31 minutes ago (genuinely gone) -> NO heartbeat',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: 31 * 60_000 }) === false);

// ── 🔴 NEVER-OBSERVED PRESENCE IS NOT PRESENCE ──────────────────────────────
// `desktop-window.js` passes `NaN` while it has not yet seen presence even
// once. That must refuse, not be read as "0ms ago" — the truthfulness
// property: the reported age is time since REAL OBSERVED PRESENCE, never
// time-since-page-load and never time-since-last-heartbeat.
push('🔴 visible + NaN (presence never once observed) -> refuses, does not throw',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: NaN }) === false);
push('visible + negative lastPresenceAgoMs -> refuses (not a real measurement)',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: -1 }) === false);
push('visible + Infinity lastPresenceAgoMs -> refuses',
    shouldHeartbeat({ visible: true, lastPresenceAgoMs: Infinity }) === false);

// ── Both conditions are genuinely required, not either/or ───────────────────
push('hidden + stale -> NO heartbeat (both reasons agree)',
    shouldHeartbeat({ visible: false, lastPresenceAgoMs: ACTIVITY_FRESH_MS + 1 }) === false);

// ───────────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.pass);
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
