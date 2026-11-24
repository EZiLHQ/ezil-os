// countdown-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/countdown-test.mjs
//
// The assignment countdown is the server's clock, never the browser's: it counts down from the server's deadline against
// the server/browser offset, does not exist before the server starts it, and moves only when a report says so. Synthetic
// reports only; no network, no capture, no real assignment.
import assert from 'node:assert/strict';
import test from 'node:test';
import {announcement, clockOf, createCountdown, formatRemaining, spokenRemaining} from './countdown.js';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const MIN = 60000;

test('no clock exists until the server reports a deadline', () => {
    const c = createCountdown({now: () => T0});
    assert.equal(c.started(), false);
    assert.equal(c.state(), 'waiting');
    assert.equal(c.remaining(), null);
    assert.equal(c.sync({status: 'awaiting_frame', startedAt: null, deadlineAt: null}), false, 'a provisional begin has no clock');
    assert.equal(c.started(), false);
    assert.equal(c.deadlineAt(), null);
    assert.equal(formatRemaining(c.remaining()), '--:--');
});

test('it counts down from the server deadline against the server/browser offset', () => {
    let now = T0;
    const c = createCountdown({now: () => now});
    // The browser's clock runs 90 s behind the server's.
    assert.equal(c.sync({startedAt: iso(T0 + 90000), deadlineAt: iso(T0 + 90000 + 60 * MIN), serverNow: iso(T0 + 90000 + 1000)}, T0), true);
    assert.equal(c.remaining(T0), 60 * MIN - 1000);
    now = T0 + 10 * MIN;
    assert.equal(c.remaining(), 50 * MIN - 1000);
    assert.equal(c.deadlineAt(), T0 + 60 * MIN - 1000, 'the deadline in browser time, for local timers');
    assert.equal(c.serverDeadlineAt(), T0 + 90000 + 60 * MIN, 'the deadline in server time, for segment times');
    assert.equal(c.state(), 'running');
});

test('a status report without serverNow keeps the offset the seed confirm established', () => {
    const c = createCountdown({now: () => T0});
    c.sync({deadlineAt: iso(T0 + 3600000 + 5000), serverNow: iso(T0 + 5000)}, T0);
    c.sync({deadlineAt: iso(T0 + 3600000 + 5000)}, T0 + 1000);
    assert.equal(c.remaining(T0 + 1000), 3600000 - 1000);
});

test('the clock only ever follows the server: a later deadline extends it, nothing else restarts it', () => {
    let now = T0;
    const c = createCountdown({now: () => now});
    c.sync({deadlineAt: iso(T0 + 10 * MIN), serverNow: iso(T0)}, T0);
    now = T0 + 6 * MIN;
    assert.equal(c.remaining(), 4 * MIN);
    c.sync({deadlineAt: iso(T0 + 10 * MIN + 3 * MIN)}, now);
    assert.equal(c.remaining(), 7 * MIN, 'time the server gave back');
    // A report without a clock (a checkpoint answer, a refusal) changes nothing and never "un-starts" it.
    assert.equal(c.sync({status: 'paused'}), false);
    assert.equal(c.started(), true);
    assert.equal(c.remaining(), 7 * MIN);
});

test('time reaches zero and says ended, never negative', () => {
    let now = T0;
    const c = createCountdown({now: () => now});
    c.sync({deadlineAt: iso(T0 + 2000), serverNow: iso(T0)}, T0);
    now = T0 + 9000;
    assert.equal(c.remaining(), 0);
    assert.equal(c.state(), 'ended');
    assert.equal(formatRemaining(0), '00:00');
});

test('a share stopping or restarting leaves the clock exactly where the server has it', () => {
    let now = T0;
    const c = createCountdown({now: () => now});
    c.sync({deadlineAt: iso(T0 + 30 * MIN), serverNow: iso(T0)}, T0);
    // No report arrives for 12 minutes (a stopped share has no transport): the same deadline keeps counting.
    now = T0 + 12 * MIN;
    assert.equal(c.remaining(), 18 * MIN);
    // A second share's seed confirm brings the same deadline back: the time is the same, not a new hour.
    c.sync({deadlineAt: iso(T0 + 30 * MIN), serverNow: iso(T0 + 12 * MIN)}, now);
    assert.equal(c.remaining(), 18 * MIN);
});

test('a server-reported system pause freezes the remaining time and its end gives the time back', () => {
    let now = T0;
    const c = createCountdown({now: () => now});
    c.sync({deadlineAt: iso(T0 + 30 * MIN), serverNow: iso(T0)}, T0);
    now = T0 + 5 * MIN;
    c.sync({deadlineAt: iso(T0 + 30 * MIN), pausedAt: iso(T0 + 4 * MIN), pauseReason: 'system_upgrade'}, now);
    assert.equal(c.state(), 'paused');
    assert.equal(c.pauseReason(), 'system_upgrade');
    assert.equal(c.remaining(), 26 * MIN, 'the deadline minus the server-side pause instant');
    now = T0 + 20 * MIN;
    assert.equal(c.remaining(), 26 * MIN, 'frozen while paused');
    c.sync({deadlineAt: iso(T0 + 30 * MIN + 16 * MIN), serverNow: iso(T0 + 20 * MIN)}, now);
    assert.equal(c.state(), 'running');
    assert.equal(c.remaining(), 26 * MIN);
    assert.equal(c.pauseReason(), null);
});

test('remainingMs from the server wins over a derived value', () => {
    const c = createCountdown({now: () => T0});
    assert.deepEqual(clockOf({deadlineAt: iso(T0 + MIN), pauseReason: 'system_upgrade', remainingMs: 12345}).frozenMs, 12345);
    c.sync({deadlineAt: iso(T0 + MIN), pauseReason: 'system_upgrade', remainingMs: 12345}, T0);
    assert.equal(c.remaining(), 12345);
});

test('a bare status:"paused" is a checkpoint between shares, not a system pause', () => {
    const c = createCountdown({now: () => T0});
    c.sync({status: 'paused', deadlineAt: iso(T0 + 30 * MIN), serverNow: iso(T0)}, T0);
    assert.equal(c.state(), 'running', 'Universe uses paused for a checkpointed phase; only a named pause stops the clock');
});

test('garbage reports are ignored', () => {
    const c = createCountdown({now: () => T0});
    for (const bad of [null, undefined, 'x', 3, {}, {deadlineAt: 'not a date'}, {deadlineAt: 5}]) assert.equal(c.sync(bad), false);
    assert.equal(c.started(), false);
});

test('format rounds up and switches to hours only at an hour', () => {
    assert.equal(formatRemaining(59 * MIN + 59999), '1:00:00');
    assert.equal(formatRemaining(59 * MIN + 59000), '59:59');
    assert.equal(formatRemaining(1), '00:01');
    assert.equal(formatRemaining(61000), '01:01');
    assert.equal(formatRemaining(3600000), '1:00:00');
    assert.equal(formatRemaining(NaN), '--:--');
    assert.equal(formatRemaining(null), '--:--');
});

test('spoken time is words, not a digit stream', () => {
    assert.equal(spokenRemaining(null), 'Time starts when your editor opens');
    assert.equal(spokenRemaining(3600000), '1 hour remaining');
    assert.equal(spokenRemaining(10 * MIN), '10 minutes remaining');
    assert.equal(spokenRemaining(MIN), '1 minute remaining');
    assert.equal(spokenRemaining(90000), '1 minute 30 seconds remaining');
    assert.equal(spokenRemaining(45000), '45 seconds remaining');
});

test('thresholds are announced once, with the real time left', () => {
    assert.equal(announcement(31 * MIN, null), null);
    assert.equal(announcement(30 * MIN, null).minutes, 30);
    assert.equal(announcement(29 * MIN, 30), null, 'already announced');
    assert.equal(announcement(10 * MIN, 30).minutes, 10);
    assert.equal(announcement(5 * MIN - 1, 10).minutes, 5);
    assert.equal(announcement(MIN - 1, 5).minutes, 1);
    assert.equal(announcement(30000, 1), null);
    assert.equal(announcement(0, 1), null);
    // Resumed with 8 minutes left: it says 8, under the 10-minute threshold.
    const resumed = announcement(8 * MIN, null);
    assert.equal(resumed.minutes, 10);
    assert.equal(resumed.text, 'Assignment time: 8 minutes remaining.');
});

const report = (revision, over = {}) => ({serverNow: iso(T0), startedAt: iso(T0 - MIN), deadlineAt: iso(T0 + 30 * MIN), pausedAt: null,
    pauseReason: null, remainingMs: null, revision, ...over});

test('clock reports are ordered by revision: an older one never overwrites a newer one', () => {
    const c = createCountdown({now: () => T0});
    assert.equal(c.sync(report(5), T0), true);
    assert.equal(c.sync(report(4, {deadlineAt: iso(T0 + 5 * MIN)}), T0), false, 'stale');
    assert.equal(c.remaining(T0), 30 * MIN);
    assert.equal(c.sync(report(5), T0), true, 'the same revision is the same state');
    assert.equal(c.sync(report(6, {deadlineAt: iso(T0 + 40 * MIN)}), T0), true);
    assert.equal(c.remaining(T0), 40 * MIN);
    assert.equal(c.revision(), 6);
});

test('a paused report arriving late cannot re-pause a clock the server already resumed', () => {
    const c = createCountdown({now: () => T0});
    c.sync(report(7, {pausedAt: iso(T0), pauseReason: 'system_upgrade', remainingMs: 20 * MIN}), T0);
    c.sync(report(8, {deadlineAt: iso(T0 + 21 * MIN)}), T0 + MIN);
    assert.equal(c.state(), 'running');
    assert.equal(c.sync(report(7, {pausedAt: iso(T0), pauseReason: 'system_upgrade', remainingMs: 20 * MIN}), T0 + 2 * MIN), false);
    assert.equal(c.state(), 'running');
    assert.equal(c.pauseReason(), null);
});

test('every field is nullable before the clock is ready, and a null report starts nothing', () => {
    const c = createCountdown({now: () => T0});
    const empty = {serverNow: iso(T0), startedAt: null, deadlineAt: null, pausedAt: null, pauseReason: null, remainingMs: null, revision: 3};
    assert.equal(c.sync(empty), false);
    assert.equal(c.started(), false);
    assert.equal(c.state(), 'waiting');
    assert.equal(c.revision(), 3, 'it still orders what follows');
    assert.equal(c.sync(report(2), T0), false, 'older than the empty report');
    assert.equal(c.sync(report(4), T0), true);
    assert.equal(c.state(), 'running');
    // The clock never goes back to "not started" because a later report is empty.
    assert.equal(c.sync({...empty, revision: 5}), false);
    assert.equal(c.state(), 'running');
});

test('begin/confirm/status answers carry no revision and stop moving the clock once a revisioned report was seen', () => {
    const c = createCountdown({now: () => T0});
    assert.equal(c.sync({deadlineAt: iso(T0 + 50 * MIN), serverNow: iso(T0)}, T0), true, 'seeds the clock before the first clock report');
    assert.equal(c.sync(report(1), T0), true);
    assert.equal(c.sync({deadlineAt: iso(T0 + 10 * MIN)}, T0), false);
    assert.equal(c.remaining(T0), 30 * MIN);
});

test('a paused clock may carry remainingMs and no deadline, and shows exactly that', () => {
    const c = createCountdown({now: () => T0});
    c.sync(report(1, {deadlineAt: null, pausedAt: iso(T0), pauseReason: 'system_upgrade', remainingMs: 17 * MIN}), T0);
    assert.equal(c.state(), 'paused');
    assert.equal(c.remaining(T0 + 5 * MIN), 17 * MIN);
    assert.equal(c.deadlineAt(), null);
});

test('the start of the server clock bounds how far the timeline may run', () => {
    const c = createCountdown({now: () => T0});
    c.sync(report(1, {startedAt: iso(T0 - 10 * MIN), deadlineAt: iso(T0 + 80 * MIN)}), T0);
    assert.equal(c.serverDeadlineAt() - c.startedAtMs(), 90 * MIN);
});
