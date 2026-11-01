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
// Round 5 (D6): warn/danger come from the server (fair use, AI state); storage from the disk left.
for (const [state, used, balance, bytes, fair, aiState] of [
    ['ok', 86400, 120, '1200000000', 'ok', 'ok'], ['warn', 115200, 40, '1800000000', 'near', 'low'],
    ['danger', 144000, 0, '2147483648', 'paused', 'exhausted'], ['unavailable', null, null, null, 'ok', 'ok'],
]) {
    const html = usageHtml({ ...sample, period: { ...sample.period, usedStandardSeconds: used, remainingStandardSeconds: used === null ? null : 144000 - used }, storage: { ...sample.storage, samples: [{ ...sample.storage.samples[0], bytes }] } },
        { ...summary, fairUse: { ...summary.fairUse, status: fair }, ai: { ...summary.ai, balance, state: aiState } });
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
    assert.match(html, /903 MB left/);
    assert.match(html, /1\.1 GB used of your 2 GB disk/);
    assert.match(usageHtml(sample, { ...summary, ai: { ...summary.ai, grant: { amount: 73, per: 'once' }, balance: 50 } }), /Includes 73 one-time trial credits/);
    // Round 6 review (R1-10): above the trial grant (120 of 73) the note would not explain the balance, so it is not said.
    assert.doesNotMatch(usageHtml(sample, { ...summary, ai: { ...summary.ai, grant: { amount: 73, per: 'once' } } }), /one-time trial credits/);
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
        const storage = usageHtml({ ...sample, period: { ...sample.period, allowanceStandardSeconds: value }, storage: { ...sample.storage, disk: { provisionedGiB: value, usedBytes: null } } }, summary);
        assert.equal((storage.match(/role="progressbar"/g) ?? []).length, 1, 'only the AI bar remains');
        assert.equal((html.match(/role="progressbar"/g) ?? []).length, 2, 'the capBytes constant is never a disk: storage is measured against the real disk');
    }
});
const format = await import(moduleUrl(readFileSync(new URL('./billing-format.js', import.meta.url), 'utf8')));
check('credit formatters: floor to 2 decimals (never round up), every microcredit at 6, the extension\'s shared vectors', () => {
    // The same table as extensions/ezil-models/tests/gateway.test.ts (`credits`): full precision, trailing zeros trimmed.
    for (const [micro, full, two, whole] of [['0', '0', '0', '0'], ['1', '0.000001', '0', '0'], ['500000', '0.5', '0.5', '0'], ['252750000', '252.75', '252.75', '252'],
        ['1246759999', '1,246.759999', '1,246.75', '1,246'], ['1500000000', '1,500', '1,500', '1,500'], ['9007199254740993123456', '9,007,199,254,740,993.123456', '9,007,199,254,740,993.12', '9,007,199,254,740,993']]) {
        assert.equal(format.creditsDecimal(micro, 6), full, micro);
        assert.equal(format.creditsDecimal(micro), two, micro);
        assert.equal(format.creditsLabel(micro), whole, micro);
    }
    for (const bad of [null, undefined, 1246750000, '-1', '1.5', '1e6', '', 'abc']) assert.equal(format.creditsDecimal(bad), null, String(bad));
    assert.equal(format.microOf(1246750000), null, 'numbers are refused: they cannot carry every microcredit past 2^53');
    assert.equal(format.clockLabel('2026-10-26T05:00:00Z'), new Date('2026-10-26T05:00:00Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
    assert.match(format.staleCreditsCopy('2026-10-26T05:00:00Z'), /^Couldn't refresh · as of \d\d:\d\d$/);
    assert.equal(format.staleCreditsCopy('soon'), "Couldn't refresh");
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
    assert.match(meter(el, 'storage').textContent, /903 MB left/);
    assert.match(meter(el, 'storage').textContent, /1\.1 GB used of your 2 GB disk/);
    assert.match(meter(el, 'session').textContent, /This session: 1 h 30 min · running · ends/);
    assert.deepEqual([...el.querySelectorAll('details')].map(el => el.dataset.usageDetail), ['period', 'storage', 'session']);
    assert.equal(el.querySelectorAll('details[open]').length, 0);
    assert.doesNotMatch(el.textContent, /Standard time|Compute allowance|Network transfer|Meter recording|Unlimited|compute hours|standard-hour|%/i);
});
// Round 5 (D6): every bar is what is LEFT; warn/danger follow the server state (time, AI) or the disk left.
for (const [state, used, balance, storage, percent, fair, aiState, storagePercent = null] of [
    // ADV-2: the 2 GB fixture disk is 2 × 2^30 bytes; 1.2e9 used leaves 44 %, 1.8e9 leaves 16 % (last column).
    ['ok', 86400, 120, '1200000000', 40, 'ok', 'ok', 44], ['warn', 115200, 40, '1800000000', 20, 'near', 'low', 16],
    ['danger', 144000, 0, '2147483648', 0, 'paused', 'exhausted', 0], ['unavailable', null, null, null, null, 'ok', 'ok'],
]) {
    for (const id of ['compute', 'ai', 'storage']) check(`${id}: ${state} state and accessible bar`, () => {
        const el = rendered({ ...withPeriod({ usedStandardSeconds: used, remainingStandardSeconds: used === null ? null : 144000 - used }), storage: withStorage(storage).storage },
            { ...withAI({ balance, state: aiState }), fairUse: { ...summary.fairUse, status: fair } });
        const section = meter(el, id), bar = progress(el, id);
        assert.equal(section.dataset.state, state);
        assert.ok(section.classList.contains(`usage-${state}`));
        assert.equal(section.getAttribute('aria-labelledby'), section.querySelector('h4').id);
        if (percent === null) {
            assert.equal(bar, null);
            assert.match(section.textContent, id === 'ai' ? /Unavailable/ : id === 'storage' ? /2 GB disk/ : /Not measured/);
        } else {
            assert.equal(bar.getAttribute('aria-valuemin'), '0');
            assert.equal(bar.getAttribute('aria-valuemax'), '100');
            assert.equal(Number(bar.getAttribute('aria-valuenow')), id === 'ai' ? Math.floor(balance / 200 * 100) : id === 'storage' ? storagePercent : percent);
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
    assert.equal(progress(el, 'storage').getAttribute('aria-valuetext'), '903 MB left of 2 GB.');
});
check('invalid caps and readings never create a proportion', () => {
    for (const value of [null, undefined, -1, NaN, Infinity, '100', Number.MAX_SAFE_INTEGER * 2]) {
        const el = rendered(withPeriod({ allowanceStandardSeconds: value }), withAI({ grant: { amount: value, per: 'period' } }));
        assert.equal(progress(el, 'compute'), null);
        assert.equal(progress(el, 'ai'), null);
        assert.match(meter(el, 'compute').textContent, /Not measured/);
        assert.doesNotMatch(el.textContent, /Unlimited/);
        assert.equal(progress(rendered(withPeriod({ usedStandardSeconds: value, remainingStandardSeconds: value })), 'compute'), null);
        const storage = rendered({ ...sample, storage: { ...sample.storage, disk: { provisionedGiB: value, usedBytes: null } } });
        assert.equal(progress(storage, 'storage'), null);
    }
    assert.equal(progress(rendered(withPeriod({ usedStandardSeconds: 0, allowanceStandardSeconds: 0 })), 'compute'), null);
    assert.match(meter(rendered(withPeriod({ allowanceStandardSeconds: 0 })), 'compute').textContent, /No computer time included this period/);
});
check('full, tiny and used-up time; server remaining is authoritative', () => {
    const full = rendered(withPeriod({ usedStandardSeconds: 0, remainingStandardSeconds: 144000 }));
    assert.equal(progress(full, 'compute').getAttribute('aria-valuenow'), '100');
    assert.ok(progress(full, 'compute').querySelector('.usage-fill'));
    const tiny = rendered(withPeriod({ usedStandardSeconds: 143999, remainingStandardSeconds: 1 }));
    assert.equal(progress(tiny, 'compute').getAttribute('aria-valuenow'), '0');
    assert.equal(progress(tiny, 'compute').querySelector('.usage-fill'), null);
    // The server's remaining wins over a used figure that disagrees.
    assert.equal(progress(rendered(withPeriod({ usedStandardSeconds: 0 })), 'compute').getAttribute('aria-valuenow'), '40');
    const over = rendered(withPeriod({ usedStandardSeconds: 200000, remainingStandardSeconds: 0 }));
    assert.equal(progress(over, 'compute').getAttribute('aria-valuenow'), '0');
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
    assert.equal(meter(rendered(withPeriod({ usedStandardSeconds: 144000, remainingStandardSeconds: 0 }), { ...summary, fairUse: { ...summary.fairUse, status: 'near' } }), 'compute').dataset.state, 'danger');
    // Low is the server's call only: 15 % left with state ok is not "Running low".
    assert.equal(meter(rendered(withPeriod({ usedStandardSeconds: 122400, remainingStandardSeconds: 21600 }), summary), 'compute').dataset.state, 'ok');
    assert.doesNotMatch(meter(rendered(sample, withAI({ balance: 30 })), 'ai').textContent, /Running low/);
});
check('AI topups, trial grants, zero grants and microcredits', () => {
    const topup = rendered(sample, withAI({ balance: 1200 }));
    // Round 6 (R1-10): above the grant there is no denominator, so no bar (it was full by construction).
    assert.equal(progress(topup, 'ai'), null);
    assert.match(meter(topup, 'ai').textContent, /1,200 left/);
    // ADV-1: no breakdown from the server, so no invented "plan + extra" split.
    assert.doesNotMatch(meter(topup, 'ai').textContent, /from your plan|1,000 extra/);
    const split = rendered(sample, withAI({ balance: 1200, starter: { remaining: 200 }, purchased: { remaining: 1000, expiresAt: '2027-04-01T00:00:00Z' } }));
    assert.match(meter(split, 'ai').textContent, /200 from your plan \+ 1,000 extra/);
    assert.doesNotMatch(meter(topup, 'ai').textContent, /1,200 of 200/);
    const trial = rendered(sample, withAI({ grant: { amount: 73, per: 'once' }, balance: 50 }));
    assert.match(meter(trial, 'ai').textContent, /Includes 73 one-time trial credits/);
    const zero = rendered(sample, withAI({ grant: { amount: 0, per: 'period' } }));
    assert.equal(progress(zero, 'ai'), null);
    assert.doesNotMatch(meter(zero, 'ai').textContent, /Your plan adds|of 0/);
    const micro = rendered(sample, withAI({ balance: null, balanceMicro: '123456789' }));
    // Whole credits only: the microcredit balance floors to 123.
    assert.match(meter(micro, 'ai').textContent, /123 of 200 left/);
    assert.doesNotMatch(meter(micro, 'ai').textContent, /123\.4/);
    assert.equal(progress(micro, 'ai').getAttribute('aria-valuenow'), '61');
    assert.equal(progress(rendered(sample, withAI({ balance: -1 })), 'ai'), null);
});
check('storage sampling gate, totals, latest measurement and 100% danger threshold', () => {
    const absent = rendered({ ...sample, storage: { state: 'unavailable', capBytes: '2000000000', samples: [] } }, { ...summary, storage: { ...summary.storage, usedBytes: '0' } }); // no disk reported
    // Round 3 D4: no invented "Limit 2 GB" (the legacy v1 Free constant).
    assert.match(meter(absent, 'storage').textContent, /Not measured yet/);
    assert.doesNotMatch(meter(absent, 'storage').textContent, /Limit|2 GB/);
    assert.equal(progress(absent, 'storage'), null);
    const two = rendered({ ...sample, storage: { ...sample.storage, samples: [...sample.storage.samples, { computerId: '<img src=x>', bytes: '200000000', measuredAt: '2026-10-26T00:00:00Z' }] } });
    assert.match(meter(two, 'storage').textContent, /1\.3 GB used of your 2 GB disk/);
    assert.match(meter(two, 'storage').textContent, /712 MB left/);
    assert.equal(meter(two, 'storage').querySelector('time').getAttribute('datetime'), '2026-10-26T00:00:00Z');
    assert.doesNotMatch(two.textContent, /<img|computer-a/);
    assert.match(meter(rendered(withStorage('123')), 'storage').textContent, /123 bytes/);
    assert.equal(meter(rendered(withStorage('1900000000'), { ...summary, storage: { ...summary.storage, state: 'exhausted' } }), 'storage').dataset.state, 'warn');
    assert.equal(progress(rendered(withStorage('3000000000')), 'storage').getAttribute('aria-valuenow'), '0');
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
    assert.equal(progress(el, 'ai').getAttribute('aria-valuenow'), '81');
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
    assert.match(meter(disk, 'storage').textContent, /50 GB disk for your projects/);
    assert.doesNotMatch(disk.textContent, /same on every configuration|stays the same/i);
    assert.equal(progress(disk, 'storage'), null);
    const used = rendered({ ...sample, storage: { state: 'unavailable', capBytes: '53687091200', disk: { provisionedGiB: 50, usedBytes: '12000000000' }, samples: [] } });
    // ADV-2: a 50 GB disk is 50 × 2^30 bytes, so 12e9 used leaves 38.8 GB (77 %).
    assert.match(meter(used, 'storage').textContent, /38\.8 GB left/);
    assert.match(meter(used, 'storage').textContent, /11\.2 GB used of your 50 GB disk/);
    assert.equal(progress(used, 'storage').getAttribute('aria-valuenow'), '77');
    assert.ok(progress(used, 'storage'));
    const free = rendered({ ...sample, storage: { state: 'unavailable', capBytes: null, disk: { provisionedGiB: null, usedBytes: null }, samples: [] } });
    assert.doesNotMatch(meter(free, 'storage').textContent, /\d+ GB|Limit/);
    assert.match(meter(free, 'storage').textContent, /Your files are saved between sessions\./);
});
check('storage honesty: an unmeasured AWS disk shows its size and "not measured yet", a Cloudflare computer says it is not measured, never "0 used"', () => {
    const unmeasured = { state: 'unavailable', capBytes: '53687091200', disk: { provisionedGiB: 50, usedBytes: null }, samples: [] };
    const aws = meter(rendered({ ...sample, storage: unmeasured }), 'storage');
    // The disk's size, as before the sampler existed; no "Measuring…" that may wait on a host image rollout.
    assert.equal(aws.querySelector('.usage-value').textContent, '50 GB disk');
    assert.match(aws.textContent, /50 GB disk for your projects\. Space used isn't measured yet\./);
    assert.doesNotMatch(aws.textContent, /Measuring…|\b0 (bytes|MB|GB)\b|used of your|left|Full|Almost full|on this computer/);
    assert.equal(aws.dataset.state, 'unavailable');
    // Even a "danger" summary state never brings Full copy without a measurement.
    const forced = meter(rendered({ ...sample, storage: unmeasured }, { ...summary, storage: { ...summary.storage, usedBytes: null, state: 'exhausted' } }), 'storage');
    assert.doesNotMatch(forced.textContent, /Full|Almost full/);
    const cf = meter(rendered({ ...sample, storage: { state: 'unavailable', capBytes: null, disk: { provisionedGiB: null, usedBytes: null }, samples: [] } },
        { ...summary, plan: { ...summary.plan, sku: 'free_v3', name: 'Free' }, storage: { usedBytes: null, capBytes: '0', state: 'unavailable' } }), 'storage');
    assert.match(cf.textContent, /Space used isn't measured on this computer\./);
    assert.doesNotMatch(cf.textContent, /Measuring…|measured yet|\b0 (bytes|MB|GB)\b/);
    // Positive controls: once measured, the same disk shows used and left, and 96% used is Almost full / 100% Full.
    const measured = meter(rendered({ ...sample, storage: { ...unmeasured, state: 'sampled', disk: { provisionedGiB: 50, usedBytes: '0' } } }), 'storage');
    assert.match(measured.textContent, /50 GB left/); assert.match(measured.textContent, /0 bytes used of your 50 GB disk/);
    assert.doesNotMatch(measured.textContent, /Measuring…|isn't measured/);
    const almost = meter(rendered({ ...sample, storage: { ...unmeasured, disk: { provisionedGiB: 50, usedBytes: String(48 * 2 ** 30) } } }), 'storage');
    assert.match(almost.textContent, /Almost full/);
    const full = meter(rendered({ ...sample, storage: { ...unmeasured, disk: { provisionedGiB: 50, usedBytes: String(50 * 2 ** 30) } } }), 'storage');
    assert.match(full.textContent, /■ Full\./);
});
// Round 6 (R1-06/07/09/10, R4-05, CR-2): the founder's Usage on 10-30. contact@ is Free (every subscription
// cancelled at once), the files are held on the AWS computer, a std-2 hold session is running with no heartbeat.
const heldUsage = { ...sample, asOf: '2026-10-30T05:44:00Z',
    session: { computerId: 'computer-a', state: 'stale', startedAt: '2026-10-30T05:42:01Z', observedAt: '2026-10-30T05:42:01Z', elapsedSeconds: 0, endedAt: null },
    period: { unit: 'standard_seconds', startsAt: '2026-10-01T00:00:00Z', resetsAt: '2026-11-01T00:00:00Z', usedStandardSeconds: 8640,
        allowanceStandardSeconds: 28800, remainingStandardSeconds: 20160, currentSize: 'std-2', currentWeight: 1, remainingHoursAtCurrent: 5,
        equivalents: [{ size: 'std-2', weight: 1, hours: 5 }] },
    storage: { state: 'unavailable', capBytes: '53687091200', disk: { provisionedGiB: 50, usedBytes: null, usedGiB: null, growsOnSwitch: false }, samples: [] } };
const heldSummary = { ...summary,
    plan: { sku: 'free_v3', name: 'Free', status: 'free', renewal: null, cancelsAt: null, scheduledChange: null, pendingUpgrade: null, paymentIssue: null },
    computer: { size: 'std-2', vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 3600, opening: 'standard', activeDeadline: '2026-10-30T06:42:00Z',
        machineChoice: [{ size: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1, arch: 'x86_64' }], standing: 'files_on_aws', filesOn: 'aws' },
    ai: { grant: { amount: 100, per: 'once' }, balance: 763, state: 'ok', included: null, purchased: null, starter: { remaining: 100 },
        previous: { remaining: 663, expiresAt: '2026-11-30T12:00:00Z' }, pendingFromRenewal: null, enrollment: 'enrolled', waiting: null },
    actions: { ...summary.actions, checkout: true, upgrade: false, cancel: false } };
const clock = iso => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
check('round 6: Free held on AWS — "About 5 of 8 hours left this month", no "Same as", the real 50 GB disk', () => {
    const el = rendered(heldUsage, heldSummary);
    assert.match(meter(el, 'compute').querySelector('.usage-value').textContent, /^About 5 of 8 hours left this month$/);
    assert.doesNotMatch(el.textContent, /Same as/);
    assert.match(meter(el, 'compute').textContent, /Free sessions last up to 1 hour\./);
    assert.match(meter(el, 'storage').textContent, /50 GB disk/);
    assert.doesNotMatch(el.textContent, /Saved with your computer/);
    // An older server (no hold branch) still sends the Cloudflare equivalent: same vCPU and weight, so no line either.
    const older = rendered({ ...heldUsage, period: { ...heldUsage.period, equivalents: [{ size: 'free-cf', weight: 1, hours: 5 }] } }, heldSummary);
    assert.doesNotMatch(older.textContent, /Same as/);
    // A real equivalent at another weight is still named (Premium).
    const premium = rendered({ ...heldUsage, period: { ...heldUsage.period, equivalents: [{ size: 'std-2', weight: 1, hours: 5 }, { size: 'cmp-4', weight: 2, hours: 2 }] } });
    assert.match(meter(premium, 'compute').textContent, /About 5 hours left at 2 vCPU/);
    assert.match(meter(premium, 'compute').textContent, /Same as 2 hours at 4 vCPU\./);
    // Under an hour, and an account with the 5-hour Free.
    const under = rendered({ ...heldUsage, period: { ...heldUsage.period, remainingStandardSeconds: 600, remainingHoursAtCurrent: 0 } }, heldSummary);
    assert.match(under.textContent, /Less than an hour left this month/);
    const five = rendered({ ...heldUsage, period: { ...heldUsage.period, allowanceStandardSeconds: 18000, remainingStandardSeconds: 9360, remainingHoursAtCurrent: 2 } }, heldSummary);
    assert.match(five.textContent, /About 2 of 5 hours left this month/);
    for (const node of [el, older, premium, under, five]) {
        assert.deepEqual(scanCopy(node.textContent), []);
        assert.doesNotMatch(node.textContent, /mumbai|ap-south-1/i);
    }
});
check('round 6 review (R4-02): a held 4 or 8 vCPU computer says it can\'t open on Free, never "Free sessions last up to 1 hour"', () => {
    for (const [size, vcpu, memoryGiB] of [['cmp-4', 4, 16], ['cmp-8', 8, 32]]) {
        const el = rendered(heldUsage, { ...heldSummary, computer: { ...heldSummary.computer, awsSize: { size, vcpu, memoryGiB } } });
        assert.match(meter(el, 'compute').textContent, new RegExp(`Your files are still on your ${vcpu} vCPU AWS \\(India\\) computer\\. The Free plan can't open it at that size; upgrade to open it again\\.`));
        assert.doesNotMatch(el.textContent, /Free sessions last/);
        assert.deepEqual(scanCopy(el.textContent), []);
        assert.doesNotMatch(el.textContent, /mumbai|ap-south-1/i);
    }
    // A held 2 vCPU placement keeps the Free session line.
    const open = rendered(heldUsage, { ...heldSummary, computer: { ...heldSummary.computer, awsSize: { size: 'std-2', vcpu: 2, memoryGiB: 8 } } });
    assert.match(meter(open, 'compute').textContent, /Free sessions last up to 1 hour\./);
    assert.doesNotMatch(open.textContent, /can't open/);
});
check('round 6 review (dunning into the hold): a paid plan past its grace says Free\'s month and session, with Fix payment', () => {
    const lapsed = { ...heldSummary, plan: { sku: 'premium_monthly_v3', name: 'Premium', status: 'past_due', renewal: null, cancelsAt: null,
        scheduledChange: null, pendingUpgrade: null, paymentIssue: 'payment_failed' }, actions: { ...summary.actions, portal: true, checkout: false } };
    const el = rendered({ ...heldUsage, period: { ...heldUsage.period, usedStandardSeconds: 1800, remainingStandardSeconds: 27000, remainingHoursAtCurrent: 7,
        equivalents: [{ size: 'std-2', weight: 1, hours: 7 }] } }, lapsed);
    assert.match(meter(el, 'compute').querySelector('.usage-value').textContent, /^About 7 of 8 hours left this month$/);
    assert.match(meter(el, 'compute').textContent, /Free sessions last up to 1 hour\./);
    assert.match(el.textContent, /Fix payment/);
    assert.doesNotMatch(el.textContent, /Computer time is used up|at 2 vCPU/);
    assert.deepEqual(scanCopy(el.textContent), []);
    assert.doesNotMatch(el.textContent, /mumbai|ap-south-1/i);
});
check('round 6: AI credits on Free after a cancel — no full bar, the 100 said once, the 663 named with their expiry', () => {
    const el = rendered(heldUsage, heldSummary);
    const ai = meter(el, 'ai');
    assert.match(ai.querySelector('.usage-value').textContent, /^763 left$/);
    assert.equal(progress(el, 'ai'), null, 'no bar against the 100 trial credits when the balance is above them');
    assert.equal((ai.textContent.match(/\b100\b/g) ?? []).length, 1, ai.textContent);
    assert.match(ai.textContent, /100 starter credits left/);
    assert.doesNotMatch(ai.textContent, /one-time trial credits/);
    assert.match(ai.textContent, /663 from your previous plan · expire Nov 30, 2026/);
    // On a paid plan the earlier credits may be its last period's tail or a cancelled plan's (a re-subscribe): "an earlier
    // billing period" fits both, never "previous plan" or "last billing period".
    const paid = rendered(sample, withAI({ balance: 1012, included: { granted: 1000, remaining: 812, periodEnd: '2026-11-27T00:00:00Z' },
        previous: { remaining: 200, expiresAt: '2026-10-13T00:00:00Z' } }));
    assert.match(meter(paid, 'ai').textContent, /200 from an earlier billing period · expire Oct 13, 2026/);
    assert.doesNotMatch(meter(paid, 'ai').textContent, /previous plan|last billing period/);
    assert.equal(progress(paid, 'ai').getAttribute('aria-valuenow'), '81');
    // Spent or unknown: no line.
    for (const previous of [null, undefined, { remaining: 0, expiresAt: '2026-11-30T12:00:00Z' }, { remaining: 5, expiresAt: 'soon' }])
        assert.doesNotMatch(rendered(heldUsage, { ...heldSummary, ai: { ...heldSummary.ai, previous } }).textContent, /previous plan|Invalid|undefined/);
    // Review: the starter spent (no starter bucket) beside 663 from the previous plan — the 100 are not in this
    // balance, so no "one-time trial credits" note; nor above the grant from purchases alone.
    for (const ai of [{ ...heldSummary.ai, balance: 663, starter: null }, { ...heldSummary.ai, balance: 500, starter: null, previous: null,
        purchased: { remaining: 500, expiresAt: '2027-10-01T00:00:00Z' } }]) {
        const spent = meter(rendered(heldUsage, { ...heldSummary, ai }), 'ai');
        assert.doesNotMatch(spent.textContent, /one-time trial credits|\b100\b/, spent.textContent);
        assert.deepEqual(scanCopy(spent.textContent), []);
    }
    assert.match(meter(rendered(heldUsage, { ...heldSummary, ai: { ...heldSummary.ai, balance: 663, starter: null } }), 'ai').textContent, /663 from your previous plan/);
    // Under the trial grant the bar stays, against the 100.
    const trial = rendered(heldUsage, { ...heldSummary, ai: { ...heldSummary.ai, balance: 60, starter: { remaining: 60 }, previous: null } });
    assert.equal(progress(trial, 'ai').getAttribute('aria-valuenow'), '60');
    assert.match(meter(trial, 'ai').textContent, /60 starter credits left/);
    assert.doesNotMatch(meter(trial, 'ai').textContent, /one-time trial credits/);
    for (const node of [el, paid, trial]) {
        assert.deepEqual(scanCopy(node.textContent), []);
        assert.doesNotMatch(node.textContent, /mumbai|ap-south-1/i);
    }
});
// Identity credits (`ai.account`): exact microcredit strings from the server; the total is every live grant.
const M = credits => { const [whole, fraction = ''] = String(credits).split('.'); return (BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'))).toString(); };
const worked = { userId: 'user', state: 'ok', asOf: '2026-10-26T05:00:00Z', totalMicro: M('1500'), remainingMicro: M('1246.75'), heldMicro: M('0.5'),
    usedMicro: M('252.75'), planBaselineMicro: M('1000'), labelled: true, grants: [
        { kind: 'plan', creditsMicro: M('1000'), remainingMicro: M('746.75'), expiresAt: '2026-11-04T00:00:00Z' },
        { kind: 'added', creditsMicro: M('500'), remainingMicro: M('500'), expiresAt: '2027-06-01T00:00:00Z' }] };
const unreadable = { ...worked, state: 'unavailable', totalMicro: null, remainingMicro: null, heldMicro: null, usedMicro: null, labelled: false, grants: [] };
// The legacy fields the same server still sends (fractional: they dropped `included` and fell back to the catalog 1,000).
const premiumAI = account => ({ ...summary, plan: { ...summary.plan, sku: 'premium_monthly_v3', name: 'Premium' },
    ai: { grant: { amount: 1000, per: 'period' }, balance: 1246.75, balanceMicro: M('1246.75'), state: 'ok', included: { granted: 1000, remaining: 746.75, periodEnd: '2026-11-01T00:00:00Z' }, account } });
const aiValue = el => meter(el, 'ai').querySelector('.usage-value').textContent;
const asOf = iso => new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
check('identity credits: the worked example reads "1,246 credits left of 1,500" with exact details and microcredit titles', () => {
    const el = rendered(sample, premiumAI(worked));
    assert.equal(aiValue(el), '1,246 credits left of 1,500');
    assert.match(meter(el, 'ai').textContent, /Plan 1,000 · Added 500 · Used 252\.75 · Reserved 0\.5 · Remaining 1,246\.75/);
    assert.equal(progress(el, 'ai').getAttribute('aria-valuenow'), '83');
    assert.equal(progress(el, 'ai').getAttribute('aria-valuetext'), '1,246 credits left of 1,500.');
    assert.deepEqual([...meter(el, 'ai').querySelectorAll('span[title]')].map(s => s.title),
        ['1,000 credits', '500 credits', '252.75 credits', '0.5 credits', '1,246.75 credits']);
    // Floored, never rounded up; the title keeps every microcredit.
    const odd = rendered(sample, premiumAI({ ...worked, remainingMicro: '1246759999', usedMicro: '252740001', heldMicro: '500000' }));
    assert.match(meter(odd, 'ai').textContent, /Used 252\.74 · Reserved 0\.5 · Remaining 1,246\.75/);
    assert.ok([...meter(odd, 'ai').querySelectorAll('span[title]')].some(s => s.title === '1,246.759999 credits'));
    // Never the catalog 1,000 (or the plan bucket's 746) as the headline.
    assert.doesNotMatch(aiValue(el), /of 1,000|746/);
    assert.deepEqual(scanCopy(meter(el, 'ai').textContent), []);
});
check('identity credits: fractional 996.25 left of 1,000; an operator grant above the plan keeps its bar; exhausted; unlabelled; unproven used', () => {
    const fractional = rendered(sample, premiumAI({ ...worked, totalMicro: M('1000'), remainingMicro: M('996.25'), heldMicro: '0', usedMicro: M('3.75'),
        grants: [{ kind: 'plan', creditsMicro: M('1000'), remainingMicro: M('996.25'), expiresAt: '2026-11-04T00:00:00Z' }] }));
    assert.equal(aiValue(fractional), '996 credits left of 1,000');
    assert.match(meter(fractional, 'ai').textContent, /Plan 1,000 · Used 3\.75 · Remaining 996\.25/);
    assert.doesNotMatch(meter(fractional, 'ai').textContent, /Reserved/);
    assert.equal(progress(fractional, 'ai').getAttribute('aria-valuenow'), '99');
    const above = rendered(sample, premiumAI({ ...worked, totalMicro: M('5200'), remainingMicro: M('5120'), heldMicro: '0', usedMicro: M('80'), grants: [
        { kind: 'plan', creditsMicro: M('200'), remainingMicro: M('120'), expiresAt: '2026-11-04T00:00:00Z' },
        { kind: 'added', creditsMicro: M('5000'), remainingMicro: M('5000'), expiresAt: '2027-06-01T00:00:00Z' }] }));
    assert.equal(aiValue(above), '5,120 credits left of 5,200');
    assert.equal(progress(above, 'ai').getAttribute('aria-valuenow'), '98');
    assert.match(meter(above, 'ai').textContent, /5,000 added · expire Jun 1, 2027/);
    const empty = rendered(sample, premiumAI({ ...worked, remainingMicro: '0', usedMicro: M('1499.5') }));
    assert.equal(meter(empty, 'ai').dataset.state, 'danger');
    assert.match(meter(empty, 'ai').textContent, /No credits left/);
    const unlabelled = rendered(sample, premiumAI({ ...worked, labelled: false }));
    assert.match(meter(unlabelled, 'ai').textContent, /Used 252\.75 · Reserved 0\.5 · Remaining 1,246\.75/);
    assert.doesNotMatch(meter(unlabelled, 'ai').textContent, /Plan 1,000|Added/);
    const unproven = rendered(sample, premiumAI({ ...worked, usedMicro: null }));
    assert.doesNotMatch(meter(unproven, 'ai').textContent, /Used/);
    assert.match(meter(unproven, 'ai').textContent, /Reserved 0\.5 · Remaining 1,246\.75/);
    // Unknown total: the remaining alone, no bar, no denominator from anywhere else.
    const noTotal = rendered(sample, premiumAI({ ...worked, totalMicro: null, labelled: false, grants: [] }));
    assert.equal(aiValue(noTotal), '1,246 credits left');
    assert.equal(progress(noTotal, 'ai'), null);
    // A top-up and an upgrade grant: both in the total, labelled.
    const upgraded = rendered(sample, premiumAI({ ...worked, totalMicro: M('1396'), remainingMicro: M('1346'), heldMicro: '0', usedMicro: M('50'), grants: [
        { kind: 'plan', creditsMicro: M('200'), remainingMicro: M('150'), expiresAt: '2026-11-04T00:00:00Z' },
        { kind: 'plan', creditsMicro: M('696'), remainingMicro: M('696'), expiresAt: '2026-11-04T00:00:00Z' },
        { kind: 'purchased', creditsMicro: M('500'), remainingMicro: M('500'), expiresAt: '2027-01-15T00:00:00Z' }] }));
    assert.equal(aiValue(upgraded), '1,346 credits left of 1,396');
    assert.match(meter(upgraded, 'ai').textContent, /Plan 896 · Purchased 500 · Used 50 · Remaining 1,346/);
    assert.match(meter(upgraded, 'ai').textContent, /500 purchased · expire Jan 15, 2027/);
    for (const node of [fractional, above, empty, upgraded]) assert.deepEqual(scanCopy(node.textContent), []);
});
check('identity credits: unavailable never falls back to the catalog; a kept balance shows "Couldn\'t refresh · as of"; limits are never a balance', () => {
    const down = rendered(sample, premiumAI(unreadable));
    assert.equal(aiValue(down), 'Unavailable');
    assert.equal(meter(down, 'ai').dataset.state, 'unavailable');
    assert.equal(progress(down, 'ai'), null);
    assert.match(meter(down, 'ai').textContent, /We couldn't read your balance\./);
    assert.doesNotMatch(meter(down, 'ai').textContent, /1,000|1,246|746/);
    // Positive control: the same summary without the key (an older server) still renders its own legacy view (where the
    // fractional `included` is dropped by its integer guard: the defect `ai.account` replaces).
    const { account: _omit, ...legacyAI } = premiumAI(worked).ai;
    assert.equal(aiValue(rendered(sample, { ...premiumAI(worked), ai: legacyAI })), '1,246 left');
    const kept = rendered(sample, premiumAI(unreadable), { lastAccount: worked, userId: 'user' });
    assert.equal(aiValue(kept), '1,246 credits left of 1,500');
    assert.match(meter(kept, 'ai').textContent, new RegExp(`Couldn't refresh · as of ${asOf(worked.asOf)}`));
    assert.match(rendered(null, null, { lastAccount: worked, userId: 'user' }).textContent, /1,246 credits left of 1,500[\s\S]*Couldn't refresh · as of/);
    // Another user's kept balance is never shown.
    for (const options of [{ lastAccount: { ...worked, userId: 'someone-else' }, userId: 'user' }, { lastAccount: worked, userId: 'someone-else' }])
        assert.doesNotMatch(rendered(sample, premiumAI(unreadable), options).textContent, /1,246/);
    // `/v1/me/limits` budgets are never read as a balance or a total.
    const limits = { policy: { dailyBudgetMicro: '9000000000000', monthlyBudgetMicro: '8000000000000' }, counters: { day_micro: 7000000 } };
    const limited = rendered(sample, { ...premiumAI(worked), ai: { ...premiumAI(worked).ai, limits, limitsState: 'available' } });
    assert.equal(aiValue(limited), '1,246 credits left of 1,500');
    assert.doesNotMatch(limited.textContent, /9,000,000|8,000,000|9000000|\b7\b credits/);
    assert.doesNotMatch(rendered(sample, { ...premiumAI(unreadable), ai: { ...premiumAI(unreadable).ai, limits } }).textContent, /9,000,000|8,000,000/);
});
check('identity credits: in the payment grace (D17) the period\'s credits wait for the payment; no live grant shows no "of 0" and no bar', () => {
    // The last period's plan grant still in its tail is the whole total; this period's grant waits for the payment.
    const tail = { ...worked, totalMicro: M('1000'), remainingMicro: M('640'), heldMicro: '0', usedMicro: M('360'), grants: [
        { kind: 'previous', creditsMicro: M('1000'), remainingMicro: M('640'), expiresAt: '2026-11-04T00:00:00Z' }] };
    const none = { ...tail, totalMicro: '0', remainingMicro: '0', usedMicro: '0', grants: [] };
    const grace = (account, paymentIssue = 'payment_failed') => { const value = premiumAI(account);
        return { ...value, plan: { ...value.plan, status: 'past_due', paymentIssue },
            ai: { ...value.ai, included: { granted: 0, remaining: 0, periodEnd: '2026-11-01T00:00:00Z' }, pendingFromRenewal: { credits: 1000, at: '2026-11-01T00:00:00Z' } } }; };
    const live = rendered(sample, grace(tail));
    assert.equal(aiValue(live), '640 credits left of 1,000');
    assert.match(meter(live, 'ai').textContent, /1,000 credits for this period\. Added once your payment goes through\./);
    assert.doesNotMatch(meter(live, 'ai').textContent, /more from|of 0\b/);
    const empty = rendered(sample, grace(none));
    assert.equal(aiValue(empty), '0 credits left');
    assert.equal(progress(empty, 'ai'), null);
    assert.equal(meter(empty, 'ai').dataset.state, 'danger');
    assert.match(meter(empty, 'ai').textContent, /Added once your payment goes through\./);
    assert.doesNotMatch(meter(empty, 'ai').textContent, /more from|of 0\b/);
    // Outside the grace a total of 0 has no denominator either.
    assert.equal(aiValue(rendered(sample, premiumAI(none))), '0 credits left');
    // Positive control: with no payment issue the renewal is a date again.
    const paid = rendered(sample, grace(tail, null));
    assert.match(meter(paid, 'ai').textContent, /1,000 more from/);
    assert.doesNotMatch(meter(paid, 'ai').textContent, /added once your payment/i);
    for (const node of [live, empty, paid]) assert.deepEqual(scanCopy(node.textContent), []);
});
check('identity credits: the warning is the total\'s own (at most 10% left), never `ai.state`, which judges one bucket', () => {
    const plenty = { ...worked, totalMicro: M('6000'), remainingMicro: M('5050'), heldMicro: '0', usedMicro: M('950'), grants: [
        { kind: 'plan', creditsMicro: M('1000'), remainingMicro: M('50'), expiresAt: '2026-11-04T00:00:00Z' },
        { kind: 'added', creditsMicro: M('5000'), remainingMicro: M('5000'), expiresAt: '2027-06-01T00:00:00Z' }] };
    const spent = { ...worked, totalMicro: M('10000'), remainingMicro: M('500'), heldMicro: '0', usedMicro: M('9500'), grants: [
        { kind: 'plan', creditsMicro: M('1000'), remainingMicro: M('500'), expiresAt: '2026-11-04T00:00:00Z' },
        { kind: 'added', creditsMicro: M('9000'), remainingMicro: '0', expiresAt: '2027-06-01T00:00:00Z' }] };
    const withState = (account, state) => { const value = premiumAI(account); return { ...value, ai: { ...value.ai, state } }; };
    // The server's 'low' (the plan bucket at 50 of 1,000) beside 5,050 of 6,000 left: no warning.
    const ok = rendered(sample, withState(plenty, 'low'));
    assert.equal(aiValue(ok), '5,050 credits left of 6,000');
    assert.equal(meter(ok, 'ai').dataset.state, 'ok');
    assert.doesNotMatch(meter(ok, 'ai').textContent, /Running low/);
    // The server's 'ok' (the plan bucket at half) beside 500 of 10,000 left: running low.
    const low = rendered(sample, withState(spent, 'ok'));
    assert.equal(aiValue(low), '500 credits left of 10,000');
    assert.equal(meter(low, 'ai').dataset.state, 'warn');
    assert.match(meter(low, 'ai').textContent, /! Running low/);
    // The line itself: 10% left is low, one microcredit more is not; an unknown or zero total has no share to judge.
    assert.equal(format.accountCredits({ totalMicro: M('10000'), remainingMicro: M('1000') }).low, true);
    assert.equal(format.accountCredits({ totalMicro: M('10000'), remainingMicro: '1000000001' }).low, false);
    assert.equal(format.accountCredits({ totalMicro: null, remainingMicro: M('1') }).low, false);
    assert.equal(format.accountCredits({ totalMicro: '0', remainingMicro: '0' }).low, false);
});
check('round 6 (CR-2): a stale hold session still says when it ends; a far-off paid deadline shows no clock time', () => {
    const el = rendered(heldUsage, heldSummary);
    assert.match(meter(el, 'session').textContent, new RegExp(`Measuring this session… · ends ${clock('2026-10-30T06:42:00Z')}`));
    assert.match(meter(rendered({ ...heldUsage, session: { ...heldUsage.session, state: 'recording', elapsedSeconds: 120 } }, heldSummary), 'session').textContent,
        new RegExp(`running · ends ${clock('2026-10-30T06:42:00Z')}`));
    // Review: a deadline the reading is already past (the sweep has not closed the epoch yet) is no end to announce.
    for (const state of ['stale', 'recording']) {
        const late = rendered({ ...heldUsage, asOf: '2026-10-30T07:05:00Z', session: { ...heldUsage.session, state, elapsedSeconds: 600 } }, heldSummary);
        assert.doesNotMatch(meter(late, 'session').textContent, /ends/, state);
    }
    // Ended: no deadline.
    assert.doesNotMatch(meter(rendered({ ...heldUsage, session: { ...heldUsage.session, state: 'ended', endedAt: '2026-10-30T06:42:00Z' } }, heldSummary), 'session').textContent, /ends \d/);
    // A paid fair-use deadline days away is not a clock time today.
    const far = rendered(sample, { ...summary, computer: { ...summary.computer, activeDeadline: '2026-11-20T06:40:00Z' } });
    assert.doesNotMatch(meter(far, 'session').textContent, /ends/);
    for (const node of [el, far]) {
        assert.deepEqual(scanCopy(node.textContent), []);
        assert.doesNotMatch(node.textContent, /mumbai/i);
    }
});
check('session states and null runtime remain honest', () => {
    for (const state of ['stale', 'ended', 'unavailable']) {
        const el = rendered({ ...sample, session: { ...sample.session, state, endedAt: state === 'ended' ? sample.asOf : null } });
        assert.doesNotMatch(meter(el, 'session').textContent, /running/);
        assert.match(meter(el, 'session').textContent, state === 'stale' ? /Measuring this session…/ : state === 'ended' ? /Last session:.*ended/ : /No session recorded yet/);
        assert.doesNotMatch(meter(el, 'session').textContent, /Update delayed|0 s so far/);
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
    // The first painted frame (nothing answered yet) is a load, not a failure.
    assert.doesNotMatch(win.text(), /couldn't read|Plan unavailable|Unavailable/);
    assert.deepEqual(calls.slice(0, 2), [{ path: 'billing.usage', input: { computerId: 'computer-a' } }, { path: 'billing.summary', input: undefined }]);
    u.resolve({ ok: true, data: sample }); await tick();
    assert.match(win.text(), /About 16 hours left at 2 vCPU/);
    // The summary is still on its way: its rows are loading, not failed.
    assert.match(win.text(), /Checking your plan…/);
    assert.doesNotMatch(win.text(), /Plan unavailable|couldn't read your balance/);
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
    // While the poll is out, the last observations stay; the session line says it is measuring (D6).
    assert.match(win.text(), /About 16 hours left at 2 vCPU/);
    assert.equal(win.find('details[data-usage-detail="session"]').get(0), details);
    assert.equal(document.activeElement, details.querySelector('summary'));
    assert.match(win.find('.usage-session-line').text(), /^This session: 1 h 30 min so far · Measuring this session…$/, 'the recorded runtime stays while it measures');
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
    assert.match(win.text(), /About 16 hours left at 2 vCPU/);
    assert.match(win.find('.usage-session-line').text(), /Measuring this session…/);
    assert.doesNotMatch(win.find('.usage-session-line').text(), /running/);
    assert.match(win.text(), /120 of 200 left/);
    success(); replies['billing.summary'] = Promise.reject(Error('summary failed')); await refresh();
    assert.match(win.text(), /Plan unavailable/);
    assert.match(win.text(), /About 16 hours left at 2 vCPU/);
    assert.equal(win.find('[data-action="usage-add-credits"]').length, 0);
    passed++; console.log('PASS partial failures retain usage honestly without blanking successful sections');

    const near = withPeriod({ usedStandardSeconds: 115200, remainingStandardSeconds: 28800 }); success(near, { ...summary, fairUse: { ...summary.fairUse, status: 'near' } }); await refresh();
    const live = win.find('[data-role="usage-announcement"]').get(0), announced = live.firstChild;
    assert.match(live.textContent, /nearly used up/);
    success(near, { ...summary, fairUse: { ...summary.fairUse, status: 'near' } }); await triggerTimer(30000);
    assert.equal(live.firstChild, announced, 'unchanged polling does not rewrite the live region');
    assert.equal(win.find('[data-role="usage-refresh-status"]').attr('role'), undefined);
    success(withPeriod({ usedStandardSeconds: 144000, remainingStandardSeconds: 0 })); await refresh();
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

    // Identity credits: the account switch A → B shows B only; a response read for another user is refused; the kept
    // balance survives a Gateway outage for the same user only; opening the tab and window focus re-read the summary.
    const forUser = (userId, account) => premiumAI({ ...account, userId });
    const userB = { ...worked, totalMicro: M('800'), remainingMicro: M('777.5'), heldMicro: '0', usedMicro: M('22.5'), labelled: false, grants: [] };
    owner = 'user-a'; success(sample, forUser('user-a', worked)); await refresh();
    assert.match(win.text(), /1,246 credits left of 1,500/);
    owner = 'user-b'; u = deferred(); s = deferred(); replies = { 'billing.usage': u.promise, 'billing.summary': s.promise }; await refresh();
    assert.doesNotMatch(win.text(), /1,246|1,500/, 'nothing of A while B loads');
    u.resolve({ ok: true, data: sample }); s.resolve({ ok: true, data: forUser('user-b', userB) }); await tick();
    assert.match(win.text(), /777 credits left of 800/);
    assert.doesNotMatch(win.text(), /1,246|1,500/);
    // The server read the session of A while this page is B's: refused, and B's kept balance is dropped too.
    success(sample, forUser('user-a', worked)); await refresh();
    assert.doesNotMatch(win.text(), /1,246|1,500|777/);
    // Gateway down for B: B's last balance, as of its time; then a failed summary keeps it too.
    success(sample, forUser('user-b', userB)); await refresh();
    success(sample, forUser('user-b', unreadable)); await refresh();
    assert.match(win.text(), new RegExp(`777 credits left of 800[\\s\\S]*Couldn't refresh · as of ${asOf(worked.asOf)}`));
    success(sample, forUser('user-b', userB)); replies['billing.summary'] = Promise.resolve({ ok: false }); await refresh();
    assert.match(win.text(), /777 credits left of 800[\s\S]*Couldn't refresh · as of/);
    // Positive control for the kept balance: a fresh read replaces it and the stale note goes.
    success(sample, forUser('user-b', { ...userB, remainingMicro: M('700'), usedMicro: M('100') })); await refresh();
    assert.match(win.text(), /700 credits left of 800/);
    assert.doesNotMatch(win.text(), /Couldn't refresh · as of/);
    // Focus within 5 minutes of the last summary: no re-read; after it, one re-read. Reopening the tab always re-reads.
    const summaries = () => calls.filter(call => call.path === 'billing.summary').length;
    let before = summaries(); success(sample, forUser('user-b', userB));
    dom.window.dispatchEvent(new dom.window.Event('focus')); await tick();
    assert.equal(summaries(), before);
    const realNow = Date.now; Date.now = () => realNow() + 4 * 60_000;
    try { dom.window.dispatchEvent(new dom.window.Event('focus')); await tick(); } finally { Date.now = realNow; }
    assert.equal(summaries(), before, 'a focus inside five minutes does not read the summary again');
    Date.now = () => realNow() + 5 * 60_000 + 1_000;
    try { dom.window.dispatchEvent(new dom.window.Event('focus')); await tick(); } finally { Date.now = realNow; }
    assert.equal(summaries(), before + 1);
    assert.match(win.text(), /777 credits left of 800/);
    tab.onDeactivate(); before = summaries(); success(sample, forUser('user-b', userB)); tab.onActivate(win); await tick();
    assert.equal(summaries(), before + 1);
    dom.window.dispatchEvent(new dom.window.Event('focus')); await tick();
    assert.equal(summaries(), before + 1, 'a focus right after opening does not read again');
    // Defence in depth: a kept block that does not name its user is still dropped when the signed-in user changes.
    owner = 'user-c'; success(sample, premiumAI({ ...worked, userId: null })); await refresh();
    assert.match(win.text(), /1,246 credits left of 1,500/);
    owner = 'user-d'; success(sample, premiumAI({ ...unreadable, userId: null })); await refresh();
    assert.doesNotMatch(win.text(), /1,246|1,500/);
    assert.match(win.text(), /We couldn't read your balance/);
    owner = 'other-owner'; success(); await refresh();
    passed++; console.log('PASS identity credits: account switch, foreign-user refusal, kept balance and refresh triggers');

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
{
    // Live staging (2026-11-01): usage answered first and the row read "Unavailable" for up to 3.6 s.
    const loading = usageHtml(sample, null, { summaryLoading: true });
    assert.match(loading, /Checking…/);
    assert.doesNotMatch(loading, /couldn't read your balance|>Unavailable</);
    // Positive control: once the summary has failed (not loading) the row says so.
    assert.match(usageHtml(sample, null, { summaryLoading: false }), /couldn't read your balance/);
    // The first frame, before anything answered: every row is loading, none says it failed.
    const first = usageHtml(null, null, { usageLoading: true, summaryLoading: true });
    assert.doesNotMatch(first, /couldn't read|Unavailable|Plan unavailable|Not measured yet/);
    assert.match(first, /Checking your plan…/);
    // Positive control: with nothing loading, the same empty frame reports the failures.
    assert.match(usageHtml(null, null), /Plan unavailable/);
    passed++; console.log('PASS the AI row says Checking… while the summary loads, and unreadable only after it fails');
}
console.log(`PASS ${passed} Usage checks; 0 failed`);
