// Run the source tab and real session selection with a fake DOM and clock;
// no rebuilt bundle or browser dependencies are required.
// Run: node shell/ezil/ui/Settings/system-tab-test.mjs
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import session from '../../session.js';
import system from './tabs/system.js';

const first = { id: 'computer-1', name: 'First computer', slot: 1 };
const second = { id: 'computer-2', name: 'Second computer', slot: 2 };
const known = { provider: 'cloudflare', image: { id: 'running-image', source: 'running' } };
const pending = { provider: 'unassigned', image: { id: null, source: 'unknown' } };
const ctx = { computer: first };
const $win = { off () { return this; }, on () { return this; } };
const globals = ['window', 'document', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const original = Object.fromEntries(globals.map(key => [key, globalThis[key]]));
const originalScreen = session.getScreen, originalInfo = session.getSystemInfo;
let host, now, nextTimer, timers, infoCalls, screenCalls, answer;

const settle = async () => { for ( let i = 0; i < 8; i++ ) await Promise.resolve(); };
async function advance (ms) {
    const end = now + ms;
    for (;;) {
        const due = [...timers.values()].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if ( ! due ) break;
        now = due.at;
        if ( due.interval ) due.at += due.interval;
        else timers.delete(due.id);
        due.fn();
        await settle();
    }
    now = end;
    await settle();
}
async function activate () {
    system.init($win, ctx);
    system.onActivate($win, ctx);
    await settle();
}
function deferred () {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

beforeEach(() => {
    now = 0; nextTimer = 0; timers = new Map(); infoCalls = []; screenCalls = [];
    host = { innerHTML: '' };
    globalThis.window = new EventTarget();
    window.__EZIL_BOOT__ = { user: { id: 'user' }, computer: first };
    globalThis.document = { querySelector: selector => selector === '.ezil-settings-system' ? host : null };
    const schedule = (fn, delay, repeat) => {
        const id = ++nextTimer;
        timers.set(id, { id, fn, at: now + delay, interval: repeat ? delay : 0 });
        return id;
    };
    globalThis.setTimeout = (fn, delay) => schedule(fn, delay, false);
    globalThis.setInterval = (fn, delay) => schedule(fn, delay, true);
    globalThis.clearTimeout = globalThis.clearInterval = id => timers.delete(id);
    session.setCurrentComputer(null);
    session.getScreen = async id => { screenCalls.push(id); return { ok: true, width: 1280, height: 720 }; };
    answer = () => ({ ok: true, info: known });
    session.getSystemInfo = async id => { infoCalls.push({ id, at: now }); return answer(id); };
});

afterEach(() => {
    system.onDeactivate();
    assert.equal(timers.size, 0, 'closing the tab clears every timer');
    session.setCurrentComputer(null);
    session.getScreen = originalScreen;
    session.getSystemInfo = originalInfo;
    for ( const key of globals ) {
        if ( original[key] === undefined ) delete globalThis[key];
        else globalThis[key] = original[key];
    }
});

test('uses the Settings context when the session has no current computer', async () => {
    delete window.__EZIL_BOOT__;
    await activate();
    assert.match(host.innerHTML, /First computer/);
    assert.deepEqual(infoCalls, [{ id: first.id, at: 0 }]);
    assert.deepEqual(screenCalls, [first.id]);
});

test('returning from Computers resolves the current selection instead of the opening context', async () => {
    await activate();
    system.onDeactivate();
    session.setCurrentComputer(second);
    const read = deferred();
    answer = () => read.promise;
    system.onActivate($win, ctx);
    assert.match(host.innerHTML, /Second computer/);
    assert.doesNotMatch(host.innerHTML, /First computer|running-image|Cloudflare Containers/);
    read.resolve({ ok: true, info: known });
    await settle();
    assert.equal(infoCalls.at(-1).id, second.id);
    assert.equal(screenCalls.at(-1), second.id);
    assert.match(host.innerHTML, /running-image/);
    assert.equal(ctx.computer, first);
});

test('detects a switch while System remains open and refetches even after metadata was known', async () => {
    await activate();
    session.setCurrentComputer(second);
    await advance(10_000);
    assert.match(host.innerHTML, /Second computer/);
    assert.deepEqual(infoCalls, [{ id: first.id, at: 0 }, { id: second.id, at: 10_000 }]);
    assert.equal(screenCalls.at(-1), second.id);
});

test('retries every 15 seconds until provider and image are known, then every 60 seconds', async () => {
    const answers = [{ ...known, provider: 'unassigned' }, { ...known, image: pending.image }, known];
    answer = () => ({ ok: true, info: answers.shift() ?? known });
    await activate();
    await advance(14_999);
    assert.equal(infoCalls.length, 1);
    await advance(1);
    assert.match(host.innerHTML, /Not reported yet/);
    await advance(15_000);
    assert.match(host.innerHTML, /running-image/);
    assert.deepEqual(infoCalls.map(call => call.at), [0, 15_000, 30_000]);
    await advance(59_999);
    assert.equal(infoCalls.length, 3);
    await advance(1);
    assert.deepEqual(infoCalls.map(call => call.at), [0, 15_000, 30_000, 90_000]);
    assert.equal(timers.size, 2, 'screen and slow system-info timers remain');
});

test('known metadata refreshes a replacement image while the same computer stays open', async () => {
    await activate();
    const replacement = { ...known, image: { id: 'replacement-image', source: 'running' } };
    answer = () => ({ ok: true, info: replacement });
    await advance(59_999);
    assert.match(host.innerHTML, /running-image/);
    assert.equal(infoCalls.length, 1);
    await advance(1);
    assert.match(host.innerHTML, /replacement-image/);
    assert.doesNotMatch(host.innerHTML, /running-image/);
    await advance(60_000);
    assert.deepEqual(infoCalls, [0, 60_000, 120_000].map(at => ({ id: first.id, at })));
    system.onDeactivate();
    await advance(120_000);
    assert.equal(infoCalls.length, 3, 'closing cancels known metadata refreshes');
    assert.equal(timers.size, 0);
});

test('a failed slow refresh returns to the 15-second retry cadence', async () => {
    await activate();
    answer = () => { throw new Error('temporary failure'); };
    await advance(60_000);
    answer = () => ({ ok: true, info: known });
    await advance(15_000);
    assert.deepEqual(infoCalls.map(call => call.at), [0, 60_000, 75_000]);
    assert.match(host.innerHTML, /running-image/);
});

test('closing with unknown metadata cancels retries', async () => {
    answer = () => ({ ok: true, info: pending });
    await activate();
    assert.equal(timers.size, 2);
    system.onDeactivate();
    await advance(60_000);
    assert.equal(infoCalls.length, 1);
    assert.equal(timers.size, 0);
});

test('slow system-info reads do not overlap and late completion cannot rearm a closed tab', async () => {
    const read = deferred();
    answer = () => read.promise;
    await activate();
    await advance(45_000);
    assert.equal(infoCalls.length, 1);
    system.onDeactivate();
    const before = host.innerHTML;
    read.resolve({ ok: true, info: pending });
    await settle();
    assert.equal(host.innerHTML, before);
    assert.equal(timers.size, 0);
});

test('late responses from the old computer cannot replace the current computer data', async () => {
    const oldInfo = deferred(), oldScreen = deferred();
    answer = id => id === first.id ? oldInfo.promise : { ok: true, info: known };
    session.getScreen = async id => id === first.id ? oldScreen.promise : { ok: true, width: 1280, height: 720 };
    await activate();
    session.setCurrentComputer(second);
    await advance(10_000);
    const current = host.innerHTML;
    oldInfo.resolve({ ok: true, info: { provider: 'aws-ec2', image: { id: 'old-image', source: 'running' } } });
    oldScreen.resolve({ ok: true, width: 800, height: 600 });
    await settle();
    assert.equal(host.innerHTML, current);
    assert.doesNotMatch(host.innerHTML, /old-image|ezil-sys-v">AWS/);
});

test('a failed read retries and refreshes slowly after recovery', async () => {
    answer = () => { throw new Error('temporary failure'); };
    await activate();
    answer = () => ({ ok: true, info: known });
    await advance(15_000);
    await advance(60_000);
    assert.deepEqual(infoCalls.map(call => call.at), [0, 15_000, 75_000]);
    assert.match(host.innerHTML, /running-image/);
});

test('stream vitals render only from the desktop frame, and only as text', async () => {
    const frame = { postMessage () {} };
    const iframe = { contentWindow: frame };
    globalThis.document = { querySelector: selector => selector === '.ezil-settings-system' ? host
        : selector.includes('data-app="desktop"') ? iframe : null };
    await activate();
    const post = (source, vitals) => {
        const ev = new Event('message');
        Object.assign(ev, { source, data: { source: 'ezil-mobile', type: 'stream_vitals', vitals } });
        window.dispatchEvent(ev);
    };
    post({}, { width: 640, height: 480, fps: 30 });
    assert.doesNotMatch(host.innerHTML, /640 × 480/, 'another window cannot report vitals');
    post(frame, { width: '<img src=x onerror=alert(1)>', height: 1, fps: '<b>9</b>', relayProtocol: '<i>' });
    assert.doesNotMatch(host.innerHTML, /<img|<b>|<i>/);
    post(frame, { width: 1920, height: 1080, fps: 30, localCandidateType: 'relay', remoteCandidateType: 'srflx', relayProtocol: 'udp' });
    assert.match(host.innerHTML, /1920 × 1080/);
    assert.match(host.innerHTML, /30 fps/);
    assert.match(host.innerHTML, /Relayed through TURN over UDP/, 'route fields survive cleaning');
    post(frame, { localCandidateType: 'host', remoteCandidateType: 'srflx' });
    assert.match(host.innerHTML, /Direct \(host → srflx\)/);
});

test('Round 4: a Free user with files on the AWS computer sees truthful Running on and Configuration rows', async () => {
    answer = () => ({ ok: true, info: { provider: 'aws-ec2', providerSource: 'placement', lifecycleState: 'STOPPED', usage: null,
        machine: { vcpu: 2, memoryMiB: 8192, instanceType: 'm6i.large', region: 'ap-south-1', source: 'configured' },
        image: { id: 'running-image', source: 'running' }, plan: { standing: 'files_on_aws' } } });
    await activate();
    // `host` is a plain innerHTML holder here; read the row's value cell by its data-role.
    const rowText = role => host.innerHTML.match(new RegExp(`data-role="${role}">\\s*<div class="ezil-sys-k">[^<]*</div>\\s*<div class="ezil-sys-v">([^<]*)</div>`))?.[1];
    assert.equal(rowText('sys-running-on'), 'AWS (India) · 2 vCPU / 8 GiB · stopped');
    assert.equal(rowText('sys-configuration'), 'Plan: Free · files kept on this computer');
    assert.doesNotMatch(host.innerHTML, /Not reported<|Plan entitlement is not available|ap-south-1|Mumbai/);
});
