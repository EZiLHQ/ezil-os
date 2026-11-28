// status-control-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/status-control-test.mjs
//
// The corner control: a red dot, the server's time left, the state in words, and Stop. Accessible names and roles, the
// states it keeps across a stop and a system pause, and an announcement stream that is never one per second.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createCountdown} from './countdown.js';
import {createStatusControl, STOP_LABEL} from './status-control.js';

const T0 = Date.parse('2026-11-24T10:00:00.000Z');
const MIN = 60000;
class Element {
    children = []; hidden = false; attrs = {}; textContent = ''; isConnected = true;
    constructor(tag) { this.tag = tag; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    append(...children) { this.children.push(...children); }
    remove() { this.isConnected = false; }
}
function harness({deadlineIn = 30 * MIN} = {}) {
    let now = T0, handle = 0;
    const timers = new Map(), made = [], stops = [];
    const win = {setTimeout(fn, ms) { timers.set(++handle, {fn, at: now + ms}); return handle; }, clearTimeout(id) { timers.delete(id); },
        document: {body: new Element('body'), createElement(tag) { const el = new Element(tag); made.push(el); return el; }}};
    const countdown = createCountdown({now: () => now});
    countdown.sync({deadlineAt: new Date(T0 + deadlineIn).toISOString(), serverNow: new Date(T0).toISOString()}, T0);
    const control = createStatusControl({win, countdown, onStop: () => stops.push(now), now: () => now, timers: win});
    const by = cls => made.find(el => el.className === 'ezil-assignment-recording-' + cls);
    return {control, countdown, win, stops, by, timers, get now() { return now; },
        advance(ms) { const end = now + ms; for (;;) {
            const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at; timers.delete(next[0]); next[1].fn();
        } now = end; },
        sync() { control.sync(); }};
}

test('the control is one group: a hidden dot, a timer, the state in words and a named Stop', () => {
    const h = harness();
    h.control.set('recording');
    assert.equal(h.control.root.attrs.role, 'group');
    assert.equal(h.control.root.attrs['aria-label'], 'Assignment recording');
    assert.equal(h.by('dot').attrs['aria-hidden'], 'true', 'the dot is decoration; the state is words');
    assert.equal(h.by('state').textContent, 'Recording');
    assert.equal(h.by('time').textContent, '30:00');
    assert.equal(h.by('stop').textContent, 'Stop');
    assert.equal(h.by('stop').attrs['aria-label'], STOP_LABEL, 'Stop has its own name, apart from the timer');
    assert.equal(h.by('stop').type, 'button');
    assert.deepEqual(h.control.root.children.map(el => el.className.replace('ezil-assignment-recording-', '')), ['dot', 'time', 'state', 'stop', 'sr']);
    assert.ok(h.win.document.body.children.includes(h.control.root));
});

test('the timer is role=timer and never a live region, so a screen reader reads it on demand only', () => {
    const h = harness();
    h.control.set('recording');
    const time = h.by('time');
    assert.equal(time.attrs.role, 'timer');
    assert.equal(time.attrs['aria-live'], 'off');
    assert.equal(time.attrs['aria-label'], '30 minutes remaining');
    h.advance(61030);
    assert.equal(time.textContent, '28:59');
    assert.equal(time.attrs['aria-label'], '28 minutes remaining', 'seconds are spoken only in the last two minutes');
    assert.equal(time.attrs['aria-live'], 'off');
});

test('the displayed second changes once per second and the polite region is not touched by it', () => {
    const h = harness({deadlineIn: 40 * MIN});
    h.control.set('recording');
    const sr = h.by('sr'), time = h.by('time');
    assert.equal(sr.attrs.role, 'status');
    assert.equal(sr.attrs['aria-live'], 'polite');
    const writes = [];
    let text = sr.textContent;
    Object.defineProperty(sr, 'textContent', {get: () => text, set: value => { writes.push(value); text = value; }});
    const seen = new Set();
    for (let i = 0; i < 120; i++) { h.advance(1000); seen.add(time.textContent); }
    assert.equal(seen.size, 120, 'a new second each second');
    assert.deepEqual(writes, [], 'two minutes of ticking is silent');
});

test('state changes and the 30/10/5/1 minute thresholds are spoken once through the polite region', () => {
    const h = harness({deadlineIn: 31 * MIN});
    h.control.set('recording');
    const sr = h.by('sr');
    assert.equal(sr.textContent, 'Recording.');
    const writes = [];
    let text = sr.textContent;
    Object.defineProperty(sr, 'textContent', {get: () => text, set: value => { writes.push(value); text = value; }});
    h.advance(MIN + 100);
    assert.deepEqual(writes, ['Assignment time: 30 minutes remaining.'], 'one thing said on crossing 30 minutes, nothing per second');
    h.advance(20 * MIN);
    assert.equal(writes.length, 2);
    assert.equal(writes[1], 'Assignment time: 10 minutes remaining.');
    const before = writes.length;
    h.advance(30 * 1000);
    assert.equal(writes.length, before, 'no repeat inside the same threshold');
    h.control.set('interrupted');
    assert.equal(writes.at(-1), 'Recording paused.');
    h.control.set('interrupted');
    assert.equal(writes.filter(w => w === 'Recording paused.').length, 1, 'an unchanged state is not repeated');
});

test('every state says its words, and Stop is offered only while a share is live', () => {
    const h = harness();
    const state = h.by.bind(null, 'state');
    const expected = {sharing: ['Sharing', true], recording: ['Recording', true], interrupted: ['Recording paused', true],
        paused: ['Paused for system upgrade', true], stopped: ['Sharing stopped', false], idle: ['Not recording', false]};
    for (const [name, [words, stop]] of Object.entries(expected)) {
        h.control.set(name);
        assert.equal(state().textContent, words, name);
        assert.equal(h.control.root.attrs['data-state'], name);
        assert.equal(h.by('stop').hidden, !stop, name + ' Stop');
    }
});

test('Stop acts only for a trusted click and stopping keeps the control and its running time', () => {
    const h = harness();
    h.control.set('recording');
    h.by('stop').onclick({isTrusted: false});
    assert.deepEqual(h.stops, [], 'a script cannot press Stop');
    h.by('stop').onclick({isTrusted: true});
    assert.equal(h.stops.length, 1);
    h.control.set('stopped');
    assert.equal(h.control.root.isConnected, true, 'the time is still the participant\'s after a stop');
    h.advance(5 * MIN + 100);
    assert.equal(h.by('time').textContent, '25:00');
    assert.equal(h.by('state').textContent, 'Sharing stopped');
});

test('before the server starts the clock the timer says so instead of inventing one', () => {
    let now = T0;
    const win = {setTimeout: () => 1, clearTimeout() {}, document: {body: new Element('body'), createElement: tag => new Element(tag)}};
    const control = createStatusControl({win, countdown: createCountdown({now: () => now}), onStop() {}, now: () => now, timers: win});
    control.set('sharing');
    const [, time] = control.root.children;
    assert.equal(time.textContent, '--:--');
    assert.equal(time.attrs['aria-label'], 'Time starts when your editor opens');
});

test('a window without timers cannot break the control: it uses the page timers', () => {
    const win = {document: {body: new Element('body'), createElement: tag => new Element(tag)}};
    const countdown = createCountdown({now: () => Date.now()});
    countdown.sync({deadlineAt: new Date(Date.now() + 30 * MIN).toISOString(), serverNow: new Date().toISOString()});
    const control = createStatusControl({win, countdown, onStop() {}});
    control.set('recording');
    control.set('paused');
    control.sync();
    control.remove();
    assert.equal(control.root.isConnected, false);
});

test('a paused server clock is spoken as paused and shown frozen, also after a stop', () => {
    const h = harness();
    h.control.set('stopped');
    h.countdown.sync({deadlineAt: new Date(T0 + 30 * MIN).toISOString(), pausedAt: new Date(T0).toISOString(), pauseReason: 'system_upgrade', remainingMs: 12 * MIN, revision: 1}, T0);
    h.sync();
    assert.equal(h.by('time').textContent, '12:00');
    assert.equal(h.by('time').attrs['aria-label'], '12 minutes remaining, time paused');
    h.advance(5 * MIN);
    assert.equal(h.by('time').textContent, '12:00');
});

test('time over wins over a live share, and a removed control stops its timer', () => {
    const h = harness({deadlineIn: 3000});
    h.control.set('recording');
    h.advance(4000);
    assert.equal(h.by('state').textContent, 'Time ended');
    assert.equal(h.by('stop').hidden, true);
    h.control.remove();
    assert.equal(h.control.root.isConnected, false);
    assert.equal(h.timers.size, 0, 'nothing keeps ticking behind a removed control');
});

test('a report that gives time back re-arms the thresholds', () => {
    const h = harness({deadlineIn: 4 * MIN});
    h.control.set('recording');
    const sr = h.by('sr');
    assert.equal(sr.textContent, 'Recording. Assignment time: 4 minutes remaining.', 'state and threshold in one message at the first draw');
    h.advance(MIN);
    h.countdown.sync({deadlineAt: new Date(T0 + 20 * MIN).toISOString()}, h.now);
    h.sync();
    assert.equal(sr.textContent, 'Assignment time: 19 minutes remaining.', 'time given back is said once, as the new time');
    h.advance(10 * MIN + 100);
    assert.equal(sr.textContent, 'Assignment time: 10 minutes remaining.', 'the 10-minute threshold is live again after the time went up');
});
