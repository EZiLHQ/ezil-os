// activity-heartbeat-test.mjs — EZiL-authored. Unit test for the container-
// billing heartbeat's ELIGIBILITY RULE.
//
// Run: node ezil/activity-heartbeat-test.mjs
//
// This is a PURE function test, deliberately not a browser/jsdom one: the
// 30-minute idle threshold this module encodes cannot be proven by a test
// that waits 30 real minutes, any more than `boot-test.mjs`'s display-gate
// scenarios could prove a 45-second deadline by staring at a browser for 45
// seconds per assertion — see that file's own scenarios 6-11 for the sibling
// problem, and `activity-heartbeat.js`'s header for why the decision was
// split out from the wiring specifically so it could be tested this way.
// `apps/desktop-window.js`'s heartbeat wiring (the `setInterval`, the
// `pointerdown`/`keydown` listeners, the actual `session.reportActivity`
// call) is proven separately, in `boot-test.mjs`, using real (short) waits
// and a mocked clock for the one number too large to wait out honestly.

import { ACTIVITY_FRESH_MS, HEARTBEAT_INTERVAL_MS, shouldHeartbeat } from './activity-heartbeat.js';

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });

// ── The constants themselves, pinned ────────────────────────────────────────
push('HEARTBEAT_INTERVAL_MS is 60s, per the billing contract', HEARTBEAT_INTERVAL_MS === 60_000,
    String(HEARTBEAT_INTERVAL_MS));
push('ACTIVITY_FRESH_MS is 30 minutes, per the billing contract', ACTIVITY_FRESH_MS === 30 * 60_000,
    String(ACTIVITY_FRESH_MS));

// ── The happy path ───────────────────────────────────────────────────────────
push('visible + input just now -> heartbeat',
    shouldHeartbeat({ visible: true, lastInputAgoMs: 0 }) === true);
push('visible + input 5 minutes ago -> still heartbeat',
    shouldHeartbeat({ visible: true, lastInputAgoMs: 5 * 60_000 }) === true);

// ── 🔴 THE VISIBILITY GUARD — a hidden tab must STOP heartbeating ───────────
push('🔴 hidden + input just now -> NO heartbeat (a backgrounded tab must not bill)',
    shouldHeartbeat({ visible: false, lastInputAgoMs: 0 }) === false);
push('hidden, however fresh the input, never heartbeats',
    shouldHeartbeat({ visible: false, lastInputAgoMs: 1 }) === false);

// ── 🔴 THE 30-MINUTE IDLE GUARD — the boundary, exactly ─────────────────────
push('🔴 visible + input exactly at the 30-minute boundary -> still eligible (inclusive)',
    shouldHeartbeat({ visible: true, lastInputAgoMs: ACTIVITY_FRESH_MS }) === true);
push('🔴 visible + input ONE MILLISECOND past 30 minutes -> NO heartbeat',
    shouldHeartbeat({ visible: true, lastInputAgoMs: ACTIVITY_FRESH_MS + 1 }) === false);
push('visible + input 31 minutes ago (genuinely idle) -> NO heartbeat',
    shouldHeartbeat({ visible: true, lastInputAgoMs: 31 * 60_000 }) === false);

// ── Malformed input never reads as "fresh" ──────────────────────────────────
push('visible + NaN lastInputAgoMs -> refuses, does not throw',
    shouldHeartbeat({ visible: true, lastInputAgoMs: NaN }) === false);
push('visible + negative lastInputAgoMs -> refuses (not a real measurement)',
    shouldHeartbeat({ visible: true, lastInputAgoMs: -1 }) === false);
push('visible + Infinity lastInputAgoMs -> refuses',
    shouldHeartbeat({ visible: true, lastInputAgoMs: Infinity }) === false);

// ── Both conditions are genuinely required, not either/or ───────────────────
push('hidden + idle -> NO heartbeat (both reasons agree)',
    shouldHeartbeat({ visible: false, lastInputAgoMs: ACTIVITY_FRESH_MS + 1 }) === false);

// ───────────────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => !c.pass);
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
