import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><div id="win"></div>', { runScripts: 'outside-only' });
globalThis.document = dom.window.document;
let hidden = false;
Object.defineProperty(document, 'hidden', { get: () => hidden });
dom.window.eval(readFileSync(new URL('../../../src/lib/jquery-3.6.1/jquery-3.6.1.min.js', import.meta.url), 'utf8'));
const win = dom.window.$('#win');
const calls = []; let computer = { id: 'computer-a' }; let owner = 'user'; let response;
globalThis.__usageTrpc = { query: (path, input) => { calls.push({ path, input }); return response; } };
globalThis.__usageSession = { currentComputer: () => computer, payload: () => ({ user: { id: owner } }) };
const src = readFileSync(new URL('./tabs/usage.js', import.meta.url), 'utf8')
    .replace("import trpc from '../trpc.js';", 'const trpc = globalThis.__usageTrpc;')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__usageSession;');
const { default: tab, usageHtml } = await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const sample = { enabled: true, version: 1, asOf: '2026-10-26T05:00:00Z',
    session: { computerId: 'computer-a', state: 'stale', startedAt: '2026-10-26T04:00:00Z', observedAt: '2026-10-26T04:30:00Z', elapsedSeconds: 1800, endedAt: null },
    period: { unit: 'standard_seconds', startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z', usedStandardSeconds: 7200, allowanceStandardSeconds: 10800, remainingStandardSeconds: 3600 },
    storage: { state: 'sampled', capBytes: '2147483648', samples: [{ computerId: '<img src=x>', bytes: '1073741824', measuredAt: '2026-10-25T00:00:00Z' }] }, egress: { state: 'unavailable', usedBytes: null } };
function rendered(data) { const el = document.createElement('div'); el.innerHTML = usageHtml(data); return el; }
let el = rendered(sample);
assert.match(el.querySelector('[data-usage="allowance"]').textContent, /2 h/);
assert.match(el.querySelector('[data-usage="allowance"]').textContent, /1 h/);
assert.equal(Number(el.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')), 7200 / 10800 * 100);
assert.match(el.querySelector('[role="progressbar"]').getAttribute('aria-valuetext'), /standard time/);
assert.match(el.textContent, /Update delayed/);
assert.match(el.textContent, /Current total unavailable/);
assert.match(el.textContent, /No|Computer/);
assert.equal(el.querySelector('time').getAttribute('datetime'), sample.period.resetsAt);
assert.equal(el.querySelector('img'), null, 'sample identity is escaped');
assert.match(el.textContent, /<img src=x>/);
assert.match(usageHtml({...sample, session:{...sample.session, elapsedSeconds:7}}), /7 s/);
assert.match(usageHtml({...sample, storage:{...sample.storage,capBytes:'123'}}), /123 bytes/);
for (const value of [null, undefined, -1, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER * 2]) {
    const d = rendered({...sample, period:{...sample.period, allowanceStandardSeconds:value}});
    assert.equal(d.querySelector('[role="progressbar"]'), null, 'invalid cap has no proportion');
    assert.match(d.textContent, /Unavailable/);
    assert.doesNotMatch(d.textContent, /Unlimited/);
}
let zero = rendered({...sample,period:{...sample.period,usedStandardSeconds:0,remainingStandardSeconds:10800}});
assert.equal(zero.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '0');
assert.match(zero.textContent, /0 s/);
zero = rendered({...sample,period:{...sample.period,usedStandardSeconds:0,allowanceStandardSeconds:0,remainingStandardSeconds:0}});
assert.equal(zero.querySelector('[role="progressbar"]'), null);
assert.match(zero.textContent, /No compute allowance/);
const tiny = rendered({...sample,period:{...sample.period,usedStandardSeconds:1}});
assert.ok(Number(tiny.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')) > 0);
assert.doesNotMatch(tiny.textContent, /0%/);
const over = rendered({...sample,period:{...sample.period,usedStandardSeconds:20000,remainingStandardSeconds:7}});
assert.equal(over.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '100');
assert.match(over.textContent, /exceeds/);
assert.match(over.querySelector('.usage-metrics').textContent, /7 s/, 'remaining uses server value, never recomputed');
for(const state of ['stale','ended','unavailable']) {
    const d = rendered({...sample,session:{...sample.session,state,endedAt:state==='ended'?'2026-10-26T04:30:00Z':null}});
    assert.doesNotMatch(d.textContent,/Meter recording/);
    if(state==='unavailable') assert.equal(d.querySelector('.usage-runtime').textContent,'Unavailable');
    if(state==='ended') assert.match(d.textContent,/Ended/);
}
assert.match(usageHtml({...sample, storage:{state:'unavailable',capBytes:'2147483648',samples:[]}}), /No storage measurements available/);
assert.throws(() => usageHtml({enabled:true,version:99}));
assert.match(usageHtml({enabled:false}), /unavailable in this deployment/);
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
    assert.ok(win.text().includes('Update delayed'));
    assert.equal(win.find('[data-role="usage-body"]').attr('aria-busy'), 'false');
    const details = win.find('details[data-usage-detail="session"]').get(0); details.open = true;
    details.querySelector('summary').focus();
    const oldBody = win.find('[data-role="usage-body"]').get(0).innerHTML;
    response = new Promise(r => { resolve = r; });
    await triggerTimer(30000);
    assert.match(win.text(), /30 min/, 'refresh retains observation');
    assert.equal(win.find('details[data-usage-detail="session"]').get(0), details, 'pending refresh does not replace body');
    assert.equal(document.activeElement, details.querySelector('summary'));
    assert.match(win.text(), /Last recorded/);
    assert.doesNotMatch(win.text(), /Meter recording/);
    resolve({ok:true,data:{...sample,session:{...sample.session,state:'recording'}}}); await tick();
    assert.ok(win.find('details[data-usage-detail="session"]').get(0).open);
    assert.equal(document.activeElement.tagName, 'SUMMARY');
    response = Promise.resolve({ok:false}); await triggerTimer(30000);
    assert.match(win.text(), /Could not refresh/);
    assert.match(win.text(), /30 min/, 'failed refresh retains last observation explicitly');
    assert.match(win.text(), /Last recorded · update failed/);
    assert.doesNotMatch(win.text(), /Meter recording/);
    response = new Promise(r => { resolve = r; });
    win.find('button').trigger('click');
    tab.onDeactivate(); const beforeLate = win.html(); resolve({ok:true,data:sample}); await tick();
    assert.equal(win.html(), beforeLate, 'late response cannot repaint inactive tab');
    assert.ok(![...timers.values()].some(timer => timer.ms === 30000));
    response = Promise.resolve({ ok: true, data: sample }); tab.onActivate(win); await tick();
    hidden = true; document.dispatchEvent(new dom.window.Event('visibilitychange'));
    const count = calls.length; win.find('button').trigger('click'); await tick(); assert.equal(calls.length, count);
    computer = { id: 'computer-b' }; hidden = false; document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
    assert.equal(calls.at(-1).input.computerId, 'computer-b');
    assert.doesNotMatch(win.text(), /30 min/, 'computer switch clears prior observation');
    response = new Promise(() => {}); win.find('button').trigger('click'); await triggerTimer(15000);
    assert.match(win.text(), /Measurements are unavailable/);
    computer = {id:'computer-a'}; response=Promise.resolve({ok:true,data:sample});
    win.find('button').trigger('click'); await tick();
    assert.match(win.text(), /30 min/);
    owner='other-owner'; response=new Promise(r=>{resolve=r;});
    win.find('button').trigger('click'); await tick();
    assert.doesNotMatch(win.text(), /30 min/, 'owner switch clears the prior owner observation immediately');
    resolve({ok:true,data:{...sample,session:{...sample.session,elapsedSeconds:42}}});await tick();
    assert.match(win.text(), /42 s/);
    tab.onDeactivate();
} finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; dom.window.close(); }
console.log('PASS usage units, stale/missing/partial readings, escaping, scoped query, loading/error/timeout, refresh and late response lifecycle');
