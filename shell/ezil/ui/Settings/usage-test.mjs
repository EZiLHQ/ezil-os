import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usage as sample, summary } from './usage-fixtures.mjs';
import { scanCopy } from '../../../../e2e/billing-e2e-lib.mjs';
const calls = []; let computer = { id: 'computer-a' }; let owner = 'user'; let replies = {};
globalThis.__usageTrpc = { query: (path, input) => { calls.push({ path, input }); return replies[path]; } };
globalThis.__usageSession = { currentComputer: () => computer, payload: () => ({ user: { id: owner } }) };
const moduleUrl = src => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
const src = readFileSync(new URL('./tabs/usage.js', import.meta.url), 'utf8')
    .replace("import trpc from '../trpc.js';", 'const trpc = globalThis.__usageTrpc;')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__usageSession;')
    .replace("'../billing-format.js'", JSON.stringify(moduleUrl(readFileSync(new URL('./billing-format.js', import.meta.url), 'utf8'))));
const { default: tab, usageHtml } = await import(moduleUrl(src));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
// Render checks also run where the worker cannot access the jsdom dependency.
for (const [state, used, balance, bytes] of [
    ['ok', 86400, 120, '1200000000'], ['warn', 115200, 40, '1600000000'],
    ['danger', 144000, 0, '2000000000'], ['unavailable', null, null, null],
]) {
    const html = usageHtml({ ...sample, period: { ...sample.period, usedStandardSeconds: used }, storage: { ...sample.storage, samples: [{ ...sample.storage.samples[0], bytes }] } }, { ...summary, ai: { ...summary.ai, balance } });
    for (const id of ['compute', 'ai', 'storage']) check(`render ${id}: ${state}`, () => {
        const row = html.match(new RegExp(`<section[^>]*data-usage="${id}"[^>]*>[\\s\\S]*?</section>`))[0];
        assert.match(row, new RegExp(`data-state="${state}"`));
        assert.equal(row.includes('role="progressbar"'), state !== 'unavailable');
        if (state !== 'unavailable') assert.match(row, /aria-valuemin="0" aria-valuemax="100" aria-valuenow="[\d.]+" aria-valuetext="[^"<>]+"/);
    });
}
check('render uses server grants, decimal storage and Billing deep links', () => {
    const html = usageHtml(sample, summary);
    assert.match(html, /href="\/os\?settings=billing&amp;section=ai-credits"/);
    assert.match(html, /Your plan adds 200 every month/);
    assert.match(html, /1.2 GB of 2 GB/);
    assert.match(usageHtml(sample, { ...summary, ai: { ...summary.ai, grant: { amount: 73, per: 'once' } } }), /Includes 73 one-time trial credits/);
});
check('render keeps null sources honest and escapes plan names', () => {
    assert.match(usageHtml(null, summary), /Not measured yet/);
    assert.match(usageHtml(sample, null), /Plan unavailable/);
    assert.doesNotMatch(usageHtml(sample, null), /data-action="usage-add-credits"/);
    assert.match(usageHtml(sample, { ...summary, plan: { ...summary.plan, name: '<img src=x>' } }), /&lt;img src=x&gt;/);
    assert.doesNotMatch(usageHtml(sample, summary), /<img|NaN|Infinity|Network transfer/);
});
check('render has no proportions for invalid compute and storage caps', () => {
    for (const value of [null, undefined, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER * 2]) {
        const html = usageHtml({ ...sample, period: { ...sample.period, allowanceStandardSeconds: value }, storage: { ...sample.storage, capBytes: value } }, summary);
        assert.equal((html.match(/role="progressbar"/g) ?? []).length, 1, 'only the AI bar remains');
    }
});
if (process.argv.includes('--render-only')) {
    console.log(`PASS ${passed} Usage render checks; 0 failed`);
    process.exit(0);
}
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><div id="win"></div>', { runScripts: 'outside-only', url: 'https://os.example.test/os' });
globalThis.document = dom.window.document;
let hidden = false;
Object.defineProperty(document, 'hidden', { get: () => hidden });
dom.window.eval(readFileSync(new URL('../../../src/lib/jquery-3.6.1/jquery-3.6.1.min.js', import.meta.url), 'utf8'));
const win = dom.window.$('#win');
function rendered(data = sample, billing = summary, options) { const el = document.createElement('div'); el.innerHTML = usageHtml(data, billing, options); return el; }
const meter = (el, id) => el.querySelector(`[data-usage="${id}"]`);
const progress = (el, id) => meter(el, id).querySelector('[role="progressbar"]');
const withPeriod = period => ({ ...sample, period: { ...sample.period, ...period } });
const withAI = ai => ({ ...summary, ai: { ...summary.ai, ...ai } });
const withStorage = bytes => ({ ...sample, storage: { ...sample.storage, samples: [{ ...sample.storage.samples[0], bytes }] } });
check('normal layout, units, reset date and collapsed disclosures', () => {
    const el = rendered();
    assert.match(el.querySelector('.usage-plan').textContent, /Standard plan/);
    assert.equal(el.querySelector('.usage-plan time').getAttribute('datetime'), sample.period.resetsAt);
    assert.equal(el.querySelector('.usage-plan time').title, new Date(sample.period.resetsAt).toISOString());
    // Round 3 D3: hours at the current configuration, never raw standard-seconds as hours.
    assert.match(meter(el, 'compute').textContent, /About 16 hours left at 2 vCPU/);
    assert.doesNotMatch(meter(el, 'compute').textContent, /24 h of 40 h/);
    assert.match(meter(el, 'ai').textContent, /120 of 200 left/);
    assert.match(meter(el, 'ai').textContent, /Your plan adds 200 every month/);
    assert.match(meter(el, 'storage').textContent, /1.2 GB of 2 GB/);
    assert.match(meter(el, 'session').textContent, /This session: 1 h 30 min · running · ends/);
    assert.deepEqual([...el.querySelectorAll('details')].map(el => el.dataset.usageDetail), ['period', 'storage', 'session']);
    assert.equal(el.querySelectorAll('details[open]').length, 0);
    assert.doesNotMatch(el.textContent, /Standard time|Compute allowance|Network transfer|Meter recording|Unlimited|compute hours|standard-hour|%/i);
});
for (const [state, used, balance, storage, percent] of [
    ['ok', 86400, 120, '1200000000', 60], ['warn', 115200, 40, '1600000000', 80],
    ['danger', 144000, 0, '2000000000', 100], ['unavailable', null, null, null, null],
]) {
    for (const id of ['compute', 'ai', 'storage']) check(`${id}: ${state} state and accessible bar`, () => {
        const el = rendered({ ...withPeriod({ usedStandardSeconds: used }), storage: withStorage(storage).storage }, withAI({ balance }));
        const section = meter(el, id), bar = progress(el, id);
        assert.equal(section.dataset.state, state);
        assert.ok(section.classList.contains(`usage-${state}`));
        assert.equal(section.getAttribute('aria-labelledby'), section.querySelector('h4').id);
        if (percent === null) {
            assert.equal(bar, null);
            assert.match(section.textContent, id === 'ai' ? /Unavailable/ : /Not measured/);
        } else {
            assert.equal(bar.getAttribute('aria-valuemin'), '0');
            assert.equal(bar.getAttribute('aria-valuemax'), '100');
            assert.equal(Number(bar.getAttribute('aria-valuenow')), id === 'ai' ? balance / 200 * 100 : percent);
            assert.equal(bar.getAttribute('aria-labelledby'), section.querySelector('h4').id);
            assert.equal(bar.hasAttribute('tabindex'), false);
            assert.ok(bar.getAttribute('aria-valuetext').length > 10);
            if (state === 'warn') assert.match(section.textContent, /!/);
            if (state === 'danger') assert.match(section.textContent, /■/);
        }
    });
}
check('bar descriptions identify used time, credits left and measured storage', () => {
    const el = rendered();
    assert.equal(progress(el, 'compute').getAttribute('aria-valuetext'), 'About 16 hours left at 2 vCPU.');
    assert.equal(progress(el, 'ai').getAttribute('aria-valuetext'), '120 credits left. Plan adds 200 every month.');
    assert.equal(progress(el, 'storage').getAttribute('aria-valuetext'), '1.2 GB used of 2 GB.');
});
check('invalid caps and readings never create a proportion', () => {
    for (const value of [null, undefined, -1, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER * 2]) {
        const el = rendered(withPeriod({ allowanceStandardSeconds: value }), withAI({ grant: { amount: value, per: 'period' } }));
        assert.equal(progress(el, 'compute'), null);
        assert.equal(progress(el, 'ai'), null);
        assert.match(meter(el, 'compute').textContent, /Not measured/);
        assert.doesNotMatch(el.textContent, /Unlimited/);
        assert.equal(progress(rendered(withPeriod({ usedStandardSeconds: value })), 'compute'), null);
        const storage = rendered({ ...sample, storage: { ...sample.storage, capBytes: value } });
        if (value !== '100') assert.equal(progress(storage, 'storage'), null);
    }
    assert.equal(progress(rendered(withPeriod({ usedStandardSeconds: 0, allowanceStandardSeconds: 0 })), 'compute'), null);
    assert.match(meter(rendered(withPeriod({ allowanceStandardSeconds: 0 })), 'compute').textContent, /No computer time included this period/);
});
check('zero, tiny and over-cap usage; server remaining is authoritative', () => {
    const zero = rendered(withPeriod({ usedStandardSeconds: 0 }));
    assert.equal(progress(zero, 'compute').getAttribute('aria-valuenow'), '0');
    assert.match(meter(zero, 'compute').textContent, /About 16 hours left at 2 vCPU/);
    assert.equal(progress(zero, 'compute').querySelector('.usage-fill'), null);
    const tiny = rendered(withPeriod({ usedStandardSeconds: 1 }));
    assert.equal(Number(progress(tiny, 'compute').getAttribute('aria-valuenow')), 1 / 144000 * 100);
    assert.ok(progress(tiny, 'compute').querySelector('.usage-fill'));
    const over = rendered(withPeriod({ usedStandardSeconds: 200000, remainingStandardSeconds: 7 }));
    assert.equal(progress(over, 'compute').getAttribute('aria-valuenow'), '100');
    assert.match(meter(over, 'compute').textContent, /No computer time left · new sessions paused/);
    assert.equal(over.querySelectorAll('.ezil-settings-btn-primary').length, 1);
    assert.ok(over.querySelector('.usage-banner .ezil-settings-btn-primary'));
    assert.equal(over.querySelector('.usage-banner').hasAttribute('role'), false);
});
check('server fair-use state and reset fallback', () => {
    const el = rendered(withPeriod({ resetsAt: null }), { ...summary, fairUse: { ...summary.fairUse, status: 'near' } });
    assert.equal(meter(el, 'compute').dataset.state, 'warn');
    assert.match(meter(el, 'compute').textContent, /this session ends and new sessions pause until/);
    assert.equal(el.querySelector('.usage-plan time').getAttribute('datetime'), summary.fairUse.resetsAt);
    assert.equal(meter(rendered(withPeriod({ usedStandardSeconds: 144000 }), { ...summary, fairUse: { ...summary.fairUse, status: 'near' } }), 'compute').dataset.state, 'danger');
});
check('AI topups, trial grants, zero grants and microcredits', () => {
    const topup = rendered(sample, withAI({ balance: 1200 }));
    assert.equal(progress(topup, 'ai').getAttribute('aria-valuenow'), '100');
    assert.match(meter(topup, 'ai').textContent, /1,200 of 200 left/);
    const trial = rendered(sample, withAI({ grant: { amount: 73, per: 'once' }, balance: 50 }));
    assert.match(meter(trial, 'ai').textContent, /Includes 73 one-time trial credits/);
    const zero = rendered(sample, withAI({ grant: { amount: 0, per: 'period' } }));
    assert.equal(progress(zero, 'ai'), null);
    assert.doesNotMatch(meter(zero, 'ai').textContent, /Your plan adds|of 0/);
    const micro = rendered(sample, withAI({ balance: null, balanceMicro: '123456789' }));
    assert.match(meter(micro, 'ai').textContent, /123.456789/);
    assert.equal(Number(progress(micro, 'ai').getAttribute('aria-valuenow')), 123.456789 / 200 * 100);
    assert.equal(progress(rendered(sample, withAI({ balance: -1 })), 'ai'), null);
});
check('storage sampling gate, totals, latest measurement and 100% danger threshold', () => {
    const absent = rendered({ ...sample, storage: { state: 'unavailable', capBytes: '2000000000', samples: [] } }, { ...summary, storage: { ...summary.storage, usedBytes: '0' } });
    // Round 3 D4: no invented "Limit 2 GB" (the legacy v1 Free constant).
    assert.match(meter(absent, 'storage').textContent, /Not measured yet/);
    assert.doesNotMatch(meter(absent, 'storage').textContent, /Limit|2 GB/);
    assert.equal(progress(absent, 'storage'), null);
    const two = rendered({ ...sample, storage: { ...sample.storage, samples: [...sample.storage.samples, { computerId: '<img src=x>', bytes: '200000000', measuredAt: '2026-10-26T00:00:00Z' }] } });
    assert.match(meter(two, 'storage').textContent, /1.4 GB of 2 GB/);
    assert.equal(meter(two, 'storage').querySelector('time').getAttribute('datetime'), '2026-10-26T00:00:00Z');
    assert.doesNotMatch(two.textContent, /<img|computer-a/);
    assert.match(meter(rendered(withStorage('123')), 'storage').textContent, /123 bytes/);
    assert.equal(meter(rendered(withStorage('1900000000'), { ...summary, storage: { ...summary.storage, state: 'exhausted' } }), 'storage').dataset.state, 'warn');
    assert.equal(progress(rendered(withStorage('3000000000')), 'storage').getAttribute('aria-valuenow'), '100');
    assert.equal(progress(rendered(withStorage('9007199254740992')), 'storage'), null);
});
check('round 3: hours left at weight 1, 2 and 4 with the equivalents; never standard-seconds as hours', () => {
    const choice = [{ size: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1 }, { size: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2 }, { size: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4 }];
    const premium = { ...summary, plan: { ...summary.plan, sku: 'premium_monthly_v3', name: 'Premium' }, computer: { ...summary.computer, machineChoice: choice } };
    const remaining = 1630800; // 453 h at weight 1
    const equivalents = choice.map(c => ({ size: c.size, weight: c.weight, hours: Math.floor(remaining / c.weight / 3600) }));
    for (const [size, weight, text, same] of [
        ['std-2', 1, 'About 453 hours left at 2 vCPU', 'Same as 113 hours at 8 vCPU or 226 hours at 4 vCPU.'],
        ['cmp-4', 2, 'About 226 hours left at 4 vCPU', 'Same as 113 hours at 8 vCPU or 453 hours at 2 vCPU.'],
        ['cmp-8', 4, 'About 113 hours left at 8 vCPU', 'Same as 226 hours at 4 vCPU or 453 hours at 2 vCPU.'],
    ]) {
        const el = rendered(withPeriod({ usedStandardSeconds: 169200, allowanceStandardSeconds: 1800000, remainingStandardSeconds: remaining, currentSize: size, currentWeight: weight,
            remainingHoursAtCurrent: Math.floor(remaining / weight / 3600), equivalents }), premium);
        assert.match(meter(el, 'compute').textContent, new RegExp(text));
        assert.match(meter(el, 'compute').textContent, new RegExp(same.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(el.textContent, /\b\d+ h( \d+ min)? (left|of)\b|standard-hour|compute hours/i);
        if (weight > 1) assert.doesNotMatch(meter(el, 'compute').querySelector('.usage-value').textContent, /453/);
        assert.deepEqual(scanCopy(el.textContent), []);
    }
    // An older server without the round-3 fields: the client divides by the weight itself.
    const old = rendered(withPeriod({ remainingStandardSeconds: 57600, currentWeight: 2, currentSize: 'cmp-4' }), premium);
    assert.match(meter(old, 'compute').textContent, /About 8 hours left at 4 vCPU/);
    const tiny = rendered(withPeriod({ remainingStandardSeconds: 600, remainingHoursAtCurrent: 0, currentSize: 'std-2', equivalents: [] }), summary);
    assert.match(meter(tiny, 'compute').textContent, /Less than an hour left at 2 vCPU/);
});
check('round 3: AI credits split into this period, purchased, starter and renewal rows', () => {
    const el = rendered(sample, withAI({ balance: 1312, included: { granted: 1000, remaining: 812, periodEnd: '2026-11-27T00:00:00Z' },
        purchased: { remaining: 500, expiresAt: '2027-01-15T00:00:00Z' }, starter: null, pendingFromRenewal: null }));
    assert.match(meter(el, 'ai').textContent, /812 of 1,000 left/);
    assert.match(meter(el, 'ai').textContent, /\+ 500 purchased · expire/);
    assert.equal(Number(progress(el, 'ai').getAttribute('aria-valuenow')), 81.2);
    assert.doesNotMatch(meter(el, 'ai').textContent, /Your plan adds/);
    const upgraded = rendered(sample, withAI({ balance: 569, included: { granted: 369, remaining: 369, periodEnd: '2026-11-27T00:00:00Z' }, pendingFromRenewal: { credits: 1000, at: '2026-11-27T00:00:00Z' } }));
    assert.match(meter(upgraded, 'ai').textContent, /369 of 369 left/);
    assert.match(meter(upgraded, 'ai').textContent, /1,000 more from/);
    const free = rendered(sample, withAI({ grant: { amount: 100, per: 'once' }, balance: 60, starter: { remaining: 60 } }));
    assert.match(meter(free, 'ai').textContent, /60 starter credits left/);
    for (const node of [el, upgraded, free]) assert.deepEqual(scanCopy(node.textContent), []);
});
check('round 3: storage is the provisioned disk; used only when measured; Free shows no number', () => {
    const disk = rendered({ ...sample, storage: { state: 'unavailable', capBytes: '53687091200', disk: { provisionedGiB: 50, usedBytes: null }, samples: [] } });
    assert.match(meter(disk, 'storage').textContent, /50 GB disk/);
    assert.match(meter(disk, 'storage').textContent, /For your projects · the same on every configuration/);
    assert.equal(progress(disk, 'storage'), null);
    const used = rendered({ ...sample, storage: { state: 'unavailable', capBytes: '53687091200', disk: { provisionedGiB: 50, usedBytes: '12000000000' }, samples: [] } });
    assert.match(meter(used, 'storage').textContent, /12 GB of 50 GB/);
    assert.ok(progress(used, 'storage'));
    const free = rendered({ ...sample, storage: { state: 'unavailable', capBytes: null, disk: { provisionedGiB: null, usedBytes: null }, samples: [] } });
    assert.doesNotMatch(meter(free, 'storage').textContent, /\d+ GB|Limit/);
    assert.match(meter(free, 'storage').textContent, /Your files are saved with your computer\./);
});
check('session states and null runtime remain honest', () => {
    for (const state of ['stale', 'ended', 'unavailable']) {
        const el = rendered({ ...sample, session: { ...sample.session, state, endedAt: state === 'ended' ? sample.asOf : null } });
        assert.doesNotMatch(meter(el, 'session').textContent, /running/);
        assert.match(meter(el, 'session').textContent, state === 'stale' ? /so far · Update delayed/ : state === 'ended' ? /Last session:.*ended/ : /No session recorded yet/);
    }
    assert.match(meter(rendered({ ...sample, session: { ...sample.session, elapsedSeconds: null } }), 'session').textContent, /Unavailable/);
    assert.match(meter(rendered({ ...sample, session: { ...sample.session, elapsedSeconds: 7 } }), 'session').textContent, /7 s/);
    assert.doesNotMatch(meter(rendered(sample, { ...summary, computer: { ...summary.computer, activeDeadline: null } }), 'session').textContent, /ends/);
});
check('plan actions, status pills and escaped server strings', () => {
    const free = rendered(sample, { ...summary, plan: { ...summary.plan, sku: 'free_v3', name: 'Free' }, actions: { ...summary.actions, checkout: true } });
    assert.equal(free.querySelector('[data-action="usage-upgrade"]').textContent, 'Upgrade');
    const premium = rendered(sample, { ...summary, plan: { ...summary.plan, sku: 'premium_monthly_v3', name: 'Premium' }, computer: { ...summary.computer, machineChoice: [{ vcpu: 8, weight: 4 }] } });
    assert.equal(premium.querySelector('.ezil-settings-btn-primary'), null);
    assert.match(premium.querySelector('[data-usage-detail="period"]').textContent, /8 vCPU counts 4 h for each hour it runs/);
    assert.doesNotMatch(rendered().textContent, /vCPU counts/);
    for (const [status, copy] of [['past_due', 'Payment due'], ['cancels', 'Ends'], ['upgrade_pending', 'Upgrade pending']]) {
        const el = rendered(sample, { ...summary, plan: { ...summary.plan, status, cancelsAt: sample.period.resetsAt } });
        assert.ok(el.querySelector('.ezil-settings-pill').textContent.includes(copy));
        if (status === 'past_due') assert.equal(el.querySelector('.ezil-settings-btn-primary').textContent, 'Fix payment');
    }
    const disabled = rendered(sample, { ...summary, actions: { checkout: false, upgrade: false, topup: false, portal: false } });
    assert.equal(disabled.querySelector('.ezil-settings-btn-primary'), null);
    assert.equal(disabled.querySelector('[data-action="usage-add-credits"]'), null);
    const escaped = rendered(sample, { ...summary, plan: { ...summary.plan, name: '<img src=x onerror="bad()">' } });
    assert.equal(escaped.querySelector('img'), null);
    assert.match(escaped.textContent, /<img src=x/);
});
check('Billing navigation reuses the existing AI credits and upgrade deep links', () => {
    const el = rendered();
    const add = el.querySelector('[data-action="usage-add-credits"]');
    assert.equal(add.tagName, 'A');
    assert.equal(add.getAttribute('href'), '/os?settings=billing&section=ai-credits');
    assert.ok(meter(el, 'ai').contains(add));
    assert.equal(el.querySelector('[data-action="usage-billing"]').getAttribute('href'), '/os?settings=billing');
    assert.equal(el.querySelector('[data-action="usage-upgrade"]').getAttribute('href'), '/os?settings=billing&upgrade=premium');
    assert.equal(el.querySelector('[role="dialog"]'), null);
    assert.match(meter(rendered(sample, withAI({ balance: null })), 'ai').textContent, /Unavailable.*Add credits/s);
    assert.deepEqual([...el.querySelectorAll('a, summary')].map(el => el.dataset.action || el.parentElement.dataset.usageDetail), ['usage-upgrade', 'usage-billing', 'usage-add-credits', 'period', 'storage', 'session']);
});
check('independent null sources and unsupported responses', () => {
    const noUsage = rendered(null);
    assert.ok(progress(noUsage, 'ai'));
    assert.equal(progress(noUsage, 'compute'), null);
    assert.equal(progress(noUsage, 'storage'), null);
    assert.match(noUsage.textContent, /Not measured yet/);
    const noSummary = rendered(sample, null);
    assert.match(noSummary.textContent, /Plan unavailable/);
    assert.ok(progress(noSummary, 'compute'));
    assert.ok(progress(noSummary, 'storage'));
    assert.equal(progress(noSummary, 'ai'), null);
    assert.equal(noSummary.querySelector('.ezil-settings-btn-primary'), null);
    assert.equal(meter(rendered(withPeriod({ usedStandardSeconds: 144000 }), null), 'compute').dataset.state, 'ok');
    assert.throws(() => usageHtml({ enabled: true, version: 99 }));
    assert.match(usageHtml({ enabled: false }, summary), /unavailable in this deployment/);
});
check('narrow layout classes, 550/760 window rules, 420 content stacking and tokens', () => {
    const css = readFileSync(new URL('./tabs/usage.css', import.meta.url), 'utf8');
    const el = rendered();
    for (const name of ['usage-plan', 'usage-plan-actions', 'usage-caption', 'usage-meter-heading', 'usage-value']) assert.ok(el.querySelector(`.${name}`));
    assert.match(css, /@container ezil-settings-window \(max-width: 600px\)\s*\{\s*\.ezil-settings-usage \.usage-plan \{[^}]*border: 0/);
    assert.match(css, /\.usage-plan \{[^}]*border: 1px solid var\(--border\)/);
    assert.match(css, /@container \(max-width: 420px\)[\s\S]*flex-direction: column; align-items: stretch/);
    assert.match(css, /\.usage-caption \.ezil-settings-btn,[\s\S]*width: 100%/);
    assert.match(css, /\.ezil-settings-btn \{ display: inline-block/);
    assert.match(css, /\.usage-value \{[^}]*text-align: right/);
    assert.match(css, /\.usage-fill \{ min-width: 2px/);
    assert.match(css, /\.usage-capacity \{ height: 6px; border-radius: 3px/);
    assert.match(css, /\.usage-warn \.usage-capacity > span \{ background: var\(--warn\)/);
    assert.match(css, /\.usage-danger \.usage-capacity > span \{ background: var\(--danger\)/);
    assert.match(css, /\.usage-capacity > span \{[^}]*transition: none/);
});

const timers = new Map(); let timerId = 0;
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; };
globalThis.clearTimeout = id => timers.delete(id);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const triggerTimer = async ms => { const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(entry, `timer ${ms} exists`); timers.delete(entry[0]); entry[1].fn(); await tick(); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const success = (usage = sample, billing = summary) => { replies = { 'billing.usage': Promise.resolve({ ok: true, data: usage }), 'billing.summary': Promise.resolve({ ok: true, data: billing }) }; };
const refresh = async () => { win.find('[data-action="refresh-usage"]').trigger('click'); await tick(); };
try {
    win.html(tab.html()); tab.init(win, {});
    let u = deferred(), s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise };
    tab.onActivate(win);
    assert.match(win.text(), /Loading usage/);
    assert.deepEqual(calls.slice(0, 2), [{ path: 'billing.usage', input: { computerId: 'computer-a' } }, { path: 'billing.summary', input: undefined }]);
    u.resolve({ ok: true, data: sample }); await tick();
    assert.match(win.text(), /About 16 hours left at 2 vCPU/);
    assert.match(win.text(), /Plan unavailable/);
    assert.equal(win.find('[data-role="usage-body"]').attr('aria-busy'), 'true');
    s.resolve({ ok: true, data: summary }); await tick();
    assert.match(win.text(), /120 of 200 left/);
    assert.equal(win.find('[data-role="usage-body"]').attr('aria-busy'), 'false');
    assert.match(win.find('[data-role="usage-refresh-status"]').text(), /Updated/);
    assert.equal(win.find('[data-role="usage-body"] [aria-live]').length, 0);
    assert.equal(win.find('[data-role="usage-announcement"]').attr('aria-live'), 'polite');
    passed++; console.log('PASS parallel queries render independently and freshness is outside the body');

    const details = win.find('details[data-usage-detail="session"]').get(0); details.open = true;
    details.querySelector('summary').focus();
    u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise };
    await triggerTimer(30000);
    assert.match(win.text(), /1 h 30 min/);
    assert.equal(win.find('details[data-usage-detail="session"]').get(0), details);
    assert.equal(document.activeElement, details.querySelector('summary'));
    assert.match(win.find('.usage-session-line').text(), /Update delayed/);
    s.resolve({ ok: true, data: summary }); await tick();
    assert.doesNotMatch(win.find('.usage-session-line').text(), /running/);
    u.resolve({ ok: true, data: sample }); await tick();
    assert.ok(win.find('details[data-usage-detail="session"]').get(0).open);
    assert.equal(document.activeElement.tagName, 'SUMMARY');
    const add = win.find('[data-action="usage-add-credits"]').get(0); add.focus();
    success(); await refresh();
    assert.equal(document.activeElement.dataset.action, 'usage-add-credits');
    passed++; console.log('PASS polling retains observations, disclosure state and keyboard focus');

    success(); replies['billing.usage'] = Promise.resolve({ ok: false }); await triggerTimer(30000);
    assert.match(win.text(), /Couldn't refresh/);
    assert.match(win.text(), /1 h 30 min/);
    assert.match(win.find('.usage-session-line').text(), /Update delayed/);
    assert.doesNotMatch(win.find('.usage-session-line').text(), /running/);
    assert.match(win.text(), /120 of 200 left/);
    success(); replies['billing.summary'] = Promise.reject(Error('summary failed')); await refresh();
    assert.match(win.text(), /Plan unavailable/);
    assert.match(win.text(), /About 16 hours left at 2 vCPU/);
    assert.equal(win.find('[data-action="usage-add-credits"]').length, 0);
    passed++; console.log('PASS partial failures retain usage honestly without blanking successful sections');

    const near = withPeriod({ usedStandardSeconds: 115200 }); success(near); await refresh();
    const live = win.find('[data-role="usage-announcement"]').get(0), announced = live.firstChild;
    assert.match(live.textContent, /nearly used up/);
    success(near); await triggerTimer(30000);
    assert.equal(live.firstChild, announced, 'unchanged polling does not rewrite the live region');
    assert.equal(win.find('[data-role="usage-refresh-status"]').attr('role'), undefined);
    success(withPeriod({ usedStandardSeconds: 144000 })); await refresh();
    assert.match(live.textContent, /Computer time is used up/);
    passed++; console.log('PASS only state changes are announced during automatic refresh');

    u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    tab.onDeactivate(); const beforeLate = win.html();
    u.resolve({ ok: true, data: sample }); s.resolve({ ok: true, data: summary }); await tick();
    assert.equal(win.html(), beforeLate);
    assert.ok(![...timers.values()].some(timer => timer.ms === 30000));
    success(); tab.onActivate(win); await tick();
    hidden = true; document.dispatchEvent(new dom.window.Event('visibilitychange'));
    const count = calls.length; await refresh(); assert.equal(calls.length, count);
    computer = { id: 'computer-b' }; hidden = false; document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
    assert.equal(calls.filter(call => call.path === 'billing.usage').at(-1).input.computerId, 'computer-b');
    assert.doesNotMatch(win.text(), /1 h 30 min/);
    assert.match(win.text(), /Couldn't load usage/);
    passed++; console.log('PASS inactive, hidden and mismatched-computer responses are ignored');

    u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    await triggerTimer(15000); await triggerTimer(15000);
    assert.match(win.text(), /Couldn't load usage/);
    assert.equal(win.find('[data-role="usage-body"]').attr('aria-busy'), 'false');
    u.resolve({ ok: true, data: sample }); s.resolve({ ok: true, data: summary }); await tick();
    assert.doesNotMatch(win.text(), /1 h 30 min/);
    computer = { id: 'computer-a' }; success(); await refresh();
    assert.match(win.text(), /1 h 30 min/);
    owner = 'other-owner'; u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    assert.doesNotMatch(win.text(), /1 h 30 min|120 of 200 left|Standard plan/);
    u.resolve({ ok: true, data: { ...sample, session: { ...sample.session, elapsedSeconds: 42 } } });
    s.resolve({ ok: true, data: summary }); await tick();
    assert.match(win.text(), /42 s/);
    passed++; console.log('PASS timeouts and owner changes clear unsafe observations');

    u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    success({ ...sample, session: { ...sample.session, elapsedSeconds: 9 } }); await refresh();
    const latest = win.html(); u.resolve({ ok: true, data: sample }); s.resolve({ ok: false }); await tick();
    assert.equal(win.html(), latest, 'older overlapping requests cannot overwrite the latest refresh');
    u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    hidden = true; document.dispatchEvent(new dom.window.Event('visibilitychange')); const beforeHidden = win.html();
    u.resolve({ ok: true, data: sample }); s.resolve({ ok: true, data: summary }); await tick();
    assert.equal(win.html(), beforeHidden);
    hidden = false; success(); document.dispatchEvent(new dom.window.Event('visibilitychange')); await tick();
    u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    win.get(0).remove(); const beforeClosed = win.html();
    u.resolve({ ok: true, data: sample }); s.resolve({ ok: true, data: summary }); await tick();
    assert.equal(win.html(), beforeClosed);
    assert.ok(![...timers.values()].some(timer => timer.ms === 30000));
    passed++; console.log('PASS overlapping, hidden and detached-window late responses cannot repaint');
    tab.onDeactivate();
} finally { tab.onDeactivate(); globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; dom.window.close(); }
console.log(`PASS ${passed} Usage checks; 0 failed`);
