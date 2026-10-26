import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="win"></div>', { runScripts: 'outside-only' });
globalThis.document = dom.window.document;
let hidden = false;
Object.defineProperty(document, 'hidden', { get: () => hidden });
dom.window.eval(readFileSync(new URL('../../../src/lib/jquery-3.6.1/jquery-3.6.1.min.js', import.meta.url), 'utf8'));
const win = dom.window.$('#win');
const calls = []; let computer = { id: 'computer-a' }; let response;
globalThis.__usageTrpc = { query: (path, input) => { calls.push({ path, input }); return response; } };
globalThis.__usageSession = { currentComputer: () => computer, payload: () => ({ user: { id: 'user' } }) };
const src = readFileSync(new URL('./tabs/usage.js', import.meta.url), 'utf8')
    .replace("import trpc from '../trpc.js';", 'const trpc = globalThis.__usageTrpc;')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__usageSession;');
const { default: tab, usageHtml } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const sample = { enabled: true, version: 1, asOf: '2026-10-26T05:00:00Z',
    session: { computerId: 'computer-a', state: 'stale', startedAt: '2026-10-26T04:00:00Z', observedAt: '2026-10-26T04:30:00Z', elapsedSeconds: 1800, endedAt: null },
    period: { unit: 'standard_seconds', startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z', usedStandardSeconds: 7200, allowanceStandardSeconds: 10800, remainingStandardSeconds: 3600 },
    storage: { state: 'sampled', capBytes: '2147483648', samples: [{ computerId: '<img src=x>', bytes: '1073741824', measuredAt: '2026-10-25T00:00:00Z' }] }, egress: { state: 'unavailable', usedBytes: null } };
assert.ok(usageHtml({ ...sample, session: { ...sample.session, elapsedSeconds: 7 }, storage: { ...sample.storage, capBytes: '123' } }).includes('7 s'));
assert.ok(usageHtml({ ...sample, storage: { ...sample.storage, capBytes: '123' } }).includes('123 bytes'));
let html = usageHtml(sample);
assert.ok(html.includes('0 h 30 min'));
assert.ok(html.includes('Last observation is stale'));
assert.ok(html.includes('2 h 0 min (standard time)'));
assert.ok(html.includes('Current total: unavailable'));
assert.ok(html.includes('2026-10-25 00:00:00 UTC'));
assert.ok(html.includes('network transfer is not measured'));
assert.ok(!html.includes('<img'));
assert.ok(usageHtml({ ...sample, session: { state: 'unavailable', elapsedSeconds: null }, storage: { state: 'unavailable', capBytes: '2147483648', samples: [] } }).includes('No storage measurements available'));
assert.ok(!usageHtml({ ...sample, session: { state: 'unavailable', elapsedSeconds: null } }).includes('Recorded runtime:</strong> 0'));
assert.throws(() => usageHtml({ enabled: true, version: 99 }));
assert.ok(usageHtml({ enabled: false }).includes('unavailable in this deployment'));
const timers = new Map(); let timerId = 0;
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const triggerTimer = async ms => { const timer = [...timers.values()].find(timer => timer.ms === ms); assert.ok(timer, `timer ${ms} exists`); timer.fn(); await tick(); };
try {
    win.html(tab.html()); tab.init(win, {});
    let resolve; response = new Promise(r => { resolve = r; });
    tab.onActivate(win);
    assert.ok(win.text().includes('Loading usage'));
    assert.deepEqual(calls[0], { path: 'billing.usage', input: { computerId: 'computer-a' } });
    resolve({ ok: true, data: sample }); await tick();
    assert.ok(win.text().includes('Last observation is stale'));
    assert.equal(win.find('[data-role="usage-body"]').attr('aria-busy'), 'false');
    response = Promise.resolve({ ok: false });
    await triggerTimer(30000);
    assert.ok(win.text().includes('Could not load usage'));
    assert.ok(!win.text().includes('0 h 30 min'), 'failed refresh does not show old values as current');
    response = new Promise(r => { resolve = r; });
    win.find('button').trigger('click');
    tab.onDeactivate(); resolve({ ok: true, data: sample }); await tick();
    assert.ok(!win.text().includes('0 h 30 min'), 'late response cannot repaint closed/inactive tab');
    assert.ok(![...timers.values()].some(timer => timer.ms === 30000));
    response = Promise.resolve({ ok: true, data: sample }); tab.onActivate(win); await tick();
    hidden = true; document.dispatchEvent(new dom.window.Event('visibilitychange'));
    const count = calls.length; win.find('button').trigger('click'); await tick(); assert.equal(calls.length, count);
    computer = { id: 'computer-b' }; hidden = false; document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
    assert.equal(calls.at(-1).input.computerId, 'computer-b');
    response = new Promise(() => {}); win.find('button').trigger('click'); await triggerTimer(15000);
    assert.ok(win.text().includes('Measurements are unavailable'));
    tab.onDeactivate();
} finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; dom.window.close(); }
console.log('PASS usage units, stale/missing/partial readings, escaping, scoped query, loading/error/timeout, refresh and late response lifecycle');
