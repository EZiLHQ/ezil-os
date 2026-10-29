// settings-design-test.mjs — EZiL-authored. Round 5 decision D6 (L5b): the
// Settings design pins for Billing, Usage, Computer, System, Troubleshoot, the
// sheet-frame confirmation and the Feedback dialog theme.
//
// Run:  node shell/ezil/ui/Settings/settings-design-test.mjs
// Source modules only (imports stubbed or bundled from source); no built
// bundle, no browser. Every check is red on aefea143 (before L5b).
//
// What it pins:
// - Billing: at most ONE primary button in every page state, and the right one;
//   no operator AI internals; whole-number credits; needs_ezil_id renders the
//   EZiL ID link and no top-up; every meter means "left"; three plan cards with
//   configurations, storage and credits; the current card says "Current plan";
//   the top-up is a disclosure; the real disk; no banned copy.
// - Usage: the same meter semantics, whole numbers, honest session copy.
// - Computer: configuration tiles that sell (benefit, weight, plan, Upgrade);
//   one primary per state; Older computer and Delete hidden on the web; the
//   chip says Stopping… at once; only the switch target is highlighted.
// - The confirmation is the sheet frame (dialog, accent primary, Esc/Cancel,
//   primary disabled in flight).
// - Troubleshoot Restart copy is one sentence in both places; System keeps
//   identifiers behind a closed Details disclosure; Feedback uses tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { scanCopy } from '../../../../e2e/billing-e2e-lib.mjs';
import { summaryV3 } from './billing-v3-fixtures.mjs';
import { honestyBans, v3CopyForAudit } from './billing-copy-test-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const read = rel => fs.readFileSync(path.join(here, rel), 'utf8');
const moduleUrl = src => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
let passed = 0, failed = 0;
async function check (name, fn) {
    try { await fn(); passed++; console.log(`PASS ${name}`); } catch (error) { failed++; console.log(`FAIL ${name}: ${error.message}`); }
}
const END = '2026-11-01T00:00:00Z';
const dom = new JSDOM('<!doctype html><body><main></main></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os' });
const { window } = dom;
const encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
window.html_encode = encode;
globalThis.html_encode = encode;
window.structuredClone = structuredClone;
const fragment = html => { const el = window.document.createElement('div'); el.innerHTML = html; return el; };
const clean = el => el.textContent.replace(/\s+/g, ' ').trim();

// ── Billing: the real renderer, bundled from source ─────────────────────────
const { buildSync } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const bundle = buildSync({
    stdin: { contents: `
        import { summaryV3Html } from './tabs/billing.js';
        import { creditsLabel } from './billing-format.js';
        window.design = { summaryV3Html, creditsLabel };
    `, resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
}).outputFiles[0].text;
window.eval(bundle);
const { summaryV3Html, creditsLabel } = window.design;
const packs = [
    { sku: 'ai_pack_100_v2', aiCredits: 1000, creditCents: 10000, discountPercent: 20, totalCents: 8000, currency: 'usd' },
    { sku: 'ai_pack_250_v2', aiCredits: 2500, creditCents: 25000, discountPercent: 25, totalCents: 18750, currency: 'usd' },
];
const EZIL_ID = 'https://ezil.work/login?method=ezil-id&returnUrl=%2Fos%3Fsettings%3Dbilling';
function billingState (name) {
    const tier = name.startsWith('free') || name === 'files_on_aws' || name.startsWith('needs') || name.startsWith('activating') ? 'free'
        : name.startsWith('standard') || name === 'upgrade_pending' || name === 'incomplete' || name === 'paused-standard' ? 'standard' : 'premium';
    const s = summaryV3(tier);
    s.ai.state = 'ok'; s.ai.balanceState = 'ok';
    s.computer.disk = tier === 'free' ? { provisionedGiB: null, usedBytes: null, growsOnSwitch: false } : { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false };
    s.computer.standing = tier === 'free' ? 'free' : 'paid';
    s.computer.filesOn = tier === 'free' ? 'cloudflare' : 'aws';
    if ( tier !== 'free' ) s.ai.included = { granted: s.ai.grant.amount, remaining: Math.floor(s.ai.grant.amount * 0.8), periodEnd: END };
    s.actions.topup = true; s.catalog.packs = packs;
    switch ( name ) {
    case 'premium-low': s.ai.state = 'low'; s.ai.included.remaining = 40; break;
    case 'grace': Object.assign(s.plan, { status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: '2026-11-05T00:00:00Z' }); s.computer.standing = 'grace'; break;
    case 'past_due': Object.assign(s.plan, { status: 'past_due', paymentIssue: 'payment_failed' }); break;
    case 'cancels': Object.assign(s.plan, { status: 'cancels', cancelsAt: END, planEndsAt: END }); s.computer.standing = 'plan_ending'; break;
    case 'upgrade_pending': Object.assign(s.plan, { status: 'upgrade_pending', pendingUpgrade: { toSku: 'premium_monthly_v3', expiresAt: '2026-10-20T00:00:00Z', hostedInvoiceUrl: 'https://invoice.example.test/p' } }); break;
    case 'incomplete': Object.assign(s.plan, { status: 'incomplete', pendingUpgrade: { toSku: 'premium_monthly_v3', expiresAt: '2026-10-20T00:00:00Z', hostedInvoiceUrl: 'https://invoice.example.test/p' } }); break;
    case 'paused-standard': case 'paused-premium': s.fairUse.status = 'paused'; break;
    case 'files_on_aws': Object.assign(s.computer, { standing: 'files_on_aws', filesOn: 'aws', heldSince: null, move: null }); break;
    case 'needs_ezil_id': Object.assign(s.ai, { enrollment: 'needs_ezil_id', waiting: { credits: 100 }, balance: null, balanceMicro: null, state: 'unavailable' }); s.actions.ezilId = EZIL_ID; break;
    case 'activating': Object.assign(s.ai, { enrollment: 'activating', waiting: { credits: 100 }, balance: null, balanceMicro: null, state: 'unavailable' }); break;
    default: break;
    }
    return s;
}
const usageDto = (remaining = 36000, allowance = 144000) => ({ enabled: true, version: 1, asOf: END, session: {}, storage: {},
    period: { unit: 'standard_seconds', allowanceStandardSeconds: allowance, remainingStandardSeconds: remaining, usedStandardSeconds: allowance - remaining,
        currentSize: 'std-2', currentWeight: 1, remainingHoursAtCurrent: Math.floor(remaining / 3600), equivalents: [] } });
const STATES = {
    free: 'Upgrade to Standard', standard: 'Upgrade to Premium', premium: null, 'premium-low': 'Add AI credits',
    grace: 'Update payment method', past_due: 'Update payment method', cancels: 'Resume plan', upgrade_pending: 'Finish payment', incomplete: 'Finish payment',
    'paused-standard': 'Upgrade to Premium', 'paused-premium': null, files_on_aws: 'Upgrade to Standard', needs_ezil_id: 'Upgrade to Standard', activating: 'Upgrade to Standard',
};

await check('Billing: at most ONE primary button in every page state, and it is the state\'s own CTA', () => {
    for ( const [name, label] of Object.entries(STATES) ) {
        for ( const usage of [null, usageDto()] ) {
            const el = fragment(summaryV3Html(billingState(name), usage));
            const primaries = [...el.querySelectorAll('.ezil-settings-btn-primary')];
            assert.equal(primaries.length, label ? 1 : 0, `${name}: ${primaries.map(clean).join(' | ')}`);
            if ( label ) assert.equal(clean(primaries[0]), label, name);
            const header = el.querySelector('.ezil-billing-header [data-action="portal"]');
            if ( header ) assert.ok(! header.classList.contains('ezil-settings-btn-primary'), `${name}: Manage payment is secondary`);
        }
    }
});
await check('Billing: the operator AI internals card is gone from every state', () => {
    for ( const name of Object.keys(STATES) ) {
        const el = fragment(summaryV3Html(billingState(name)));
        for ( const role of ['ai-usage', 'ai-limits', 'ai-recent', 'ai-spending'] ) assert.equal(el.querySelector(`[data-role="${role}"]`), null, `${name}: ${role}`);
        assert.doesNotMatch(clean(el), /service ceiling|Held for requests|Requests per minute|Tokens per minute|Recent AI requests|Commitments|Not reported/i, name);
    }
});
await check('Billing: no machine picker and no "Next start:" (the Computer tab owns configuration)', () => {
    for ( const name of ['standard', 'premium'] ) {
        const el = fragment(summaryV3Html(billingState(name)));
        assert.equal(el.querySelector('input[name="ezil-billing-machine"], [data-role="machine-picker"]'), null);
        assert.doesNotMatch(clean(el), /Next start:|Next session/);
    }
});
await check('Billing: credits are whole numbers everywhere (formatter and pane)', () => {
    assert.equal(creditsLabel('1000001'), '1');
    assert.equal(creditsLabel('1264035750'), '1,264');
    assert.equal(creditsLabel(null, 1264.03575), '1,264');
    assert.equal(creditsLabel(null, 0.5), '0');
    const s = billingState('free'); s.ai.balance = 1264.03575; s.ai.balanceMicro = '1264035750';
    const text = clean(fragment(summaryV3Html(s)).querySelector('[data-role="meter-ai"]'));
    assert.match(text, /1,264/);
    assert.doesNotMatch(text, /\d\.\d|1,264 of 100\b/);
});
await check('Billing: every meter means "left" (time, AI credits, storage)', () => {
    const s = billingState('premium');
    s.ai.included = { granted: 1000, remaining: 812, periodEnd: END };
    s.computer.disk = { provisionedGiB: 50, usedBytes: '12000000000', growsOnSwitch: false };
    const el = fragment(summaryV3Html(s, usageDto(36000, 144000)));
    const meter = role => el.querySelector(`[data-role="${role}"] [role="meter"]`);
    assert.equal(meter('meter-time')?.getAttribute('aria-valuenow'), '25', 'time bar is the share LEFT');
    assert.equal(meter('meter-ai')?.getAttribute('aria-valuenow'), '81', 'AI bar is the share of the plan grant LEFT');
    assert.equal(meter('meter-storage')?.getAttribute('aria-valuenow'), '76', 'storage bar is the disk LEFT');
    for ( const bar of el.querySelectorAll('[role="meter"]') ) {
        assert.match(bar.getAttribute('aria-label') ?? '', /left/i, 'each bar is labelled as what is left');
        assert.equal(bar.getAttribute('aria-valuemin'), '0'); assert.equal(bar.getAttribute('aria-valuemax'), '100');
    }
    assert.match(clean(el.querySelector('[data-role="meter-time"]')), /25 h left/);
    assert.match(clean(el.querySelector('[data-role="meter-ai"]')), /812 of 1,000 left/);
    assert.match(clean(el.querySelector('[data-role="meter-storage"]')), /38 GB left/);
    assert.doesNotMatch(summaryV3Html(s, usageDto()), /progressbar/i, 'Billing never renders progressbar (ui-copy.qa)');
});
await check('Billing: a balance above the plan grant fills the bar and splits "from your plan + extra"', () => {
    const s = billingState('free'); s.ai.balance = 1264; s.ai.included = null;
    const row = fragment(summaryV3Html(s)).querySelector('[data-role="meter-ai"]');
    assert.equal(row.querySelector('[role="meter"]')?.getAttribute('aria-valuenow'), '100');
    assert.match(clean(row), /1,264 left/);
    assert.match(clean(row), /100 from your plan \+ 1,164 extra/);
    assert.doesNotMatch(clean(row), /1,264 of 100/);
});
await check('Billing: needs_ezil_id shows waiting credits, the EZiL ID link and no top-up; activating says so', () => {
    const el = fragment(summaryV3Html(billingState('needs_ezil_id')));
    const row = el.querySelector('[data-role="meter-ai"]');
    assert.match(clean(row), /100 credits waiting/);
    assert.match(clean(row), /AI credits activate when you sign in with EZiL ID\. Use the same email as this account\./);
    const link = row.querySelector('a[data-action="ezil-id"]');
    assert.equal(link?.getAttribute('href'), EZIL_ID);
    assert.equal(link?.getAttribute('target'), null, 'document navigation, same tab');
    assert.equal(el.querySelector('[data-role="ai-topup"], [data-action="topup"]'), null);
    assert.doesNotMatch(clean(el), /Unavailable|Not available|unavailable/);
    const act = fragment(summaryV3Html(billingState('activating')));
    assert.match(clean(act.querySelector('[data-role="meter-ai"]')), /Setting up your AI credits…/);
    assert.equal(act.querySelector('[data-role="ai-topup"], [data-action="topup"]'), null);
    const unsafe = billingState('needs_ezil_id'); unsafe.actions.ezilId = 'javascript:alert(1)';
    assert.equal(fragment(summaryV3Html(unsafe)).querySelector('a[data-action="ezil-id"]'), null, 'only an http(s) or same-site link');
});
await check('Billing: the AI top-up is a closed disclosure, only when enrolled with packs', () => {
    const el = fragment(summaryV3Html(billingState('premium')));
    const topup = el.querySelector('details[data-role="ai-topup"]');
    assert.ok(topup, 'disclosure exists');
    assert.equal(topup.open, false);
    assert.match(clean(topup.querySelector('summary')), /Add AI credits/);
    assert.equal(topup.querySelectorAll('[data-action="topup"]').length, 2);
    for ( const button of topup.querySelectorAll('button') ) assert.ok(! button.classList.contains('ezil-settings-btn-primary'));
    const none = billingState('premium'); none.actions.topup = false;
    assert.equal(fragment(summaryV3Html(none)).querySelector('[data-role="ai-topup"]'), null);
});
await check('Billing: three plan cards with configurations, storage and credits; the current one says "Current plan"', () => {
    for ( const name of ['free', 'standard', 'premium'] ) {
        const el = fragment(summaryV3Html(billingState(name)));
        const cards = [...el.querySelectorAll('[data-role="plans"] [data-role="plan-offer"]')];
        assert.deepEqual(cards.map(card => card.dataset.sku), ['free_v3', 'standard_monthly_v3', 'premium_monthly_v3']);
        const current = cards.filter(card => card.hasAttribute('data-current'));
        assert.equal(current.length, 1, name);
        assert.match(clean(current[0]), /Current plan/);
        assert.equal(current[0].querySelector('button, a.ezil-settings-btn'), null, 'no button on the current card');
        const [free, standard, premium] = cards.map(clean);
        assert.match(free, /\$0/); assert.match(free, /2 vCPU · 6 GB/); assert.match(free, /Files saved between sessions/); assert.match(free, /100 AI credits to start/);
        assert.match(standard, /\$20/); assert.match(standard, /2 vCPU · 8 GB/); assert.match(standard, /50 GB disk/); assert.match(standard, /200 AI credits every month/);
        assert.match(premium, /\$100/); for ( const config of ['2 vCPU · 8 GB', '4 vCPU · 16 GB', '8 vCPU · 32 GB'] ) assert.ok(premium.includes(config), config);
        assert.match(premium, /100 GB disk/); assert.match(premium, /1,000 AI credits every month/);
        assert.doesNotMatch(clean(el), /Most popular/);
    }
});
await check('Billing: "Your computer" row shows the configuration, the REAL disk and a link to the Computer tab', () => {
    const el = fragment(summaryV3Html(billingState('premium')));
    const row = el.querySelector('[data-role="your-computer"]');
    assert.match(clean(row), /2 vCPU · 8 GB memory · 50 GB disk/);
    assert.match(clean(row.querySelector('[data-action="computer-tab"]')), /Change configuration ›/);
    assert.match(clean(el.querySelector('[data-role="meter-storage"]')), /50 GB disk for your projects/);
    assert.doesNotMatch(clean(el.querySelector('[data-role="meter-storage"]')), /100 GB|same disk on every/i);
    const free = fragment(summaryV3Html(billingState('free')));
    assert.doesNotMatch(clean(free.querySelector('[data-role="meter-storage"]')), /\d+ GB/);
});
await check('Billing: single column capped at 760 px', () => {
    assert.match(read('settings.css').replace(/\/\*[\s\S]*?\*\//g, ''), /\.ezil-settings-billing\s*\{[^}]*max-width:\s*760px/);
});
await check('Billing: no banned or dishonest copy in any state', () => {
    for ( const name of Object.keys(STATES) ) {
        const text = clean(fragment(summaryV3Html(billingState(name), usageDto())));
        assert.deepEqual(scanCopy(v3CopyForAudit(text)), [], name);
        assert.doesNotMatch(text, honestyBans, name);
        assert.doesNotMatch(text, /coming soon|\$\d[\d.,]* (credits )?left/i, name);
    }
});

// ── Usage: source module with its imports stubbed ───────────────────────────
globalThis.__dUsageTrpc = { query: async () => ({ ok: false }) };
globalThis.__dUsageSession = { currentComputer: () => null, payload: () => null };
const usageSrc = read('tabs/usage.js')
    .replace("import trpc from '../trpc.js';", 'const trpc = globalThis.__dUsageTrpc;')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__dUsageSession;')
    .replace("'../billing-format.js'", JSON.stringify(moduleUrl(read('billing-format.js'))));
const { usageHtml } = await import(moduleUrl(usageSrc));
const uSample = { enabled: true, version: 1, asOf: END,
    session: { computerId: 'c-1', state: 'stale', startedAt: '2026-10-26T03:30:00Z', observedAt: '2026-10-26T05:00:00Z', elapsedSeconds: 0, endedAt: null },
    period: { unit: 'standard_seconds', startsAt: '2026-10-01T00:00:00Z', resetsAt: END, usedStandardSeconds: 86400, allowanceStandardSeconds: 144000, remainingStandardSeconds: 57600 },
    storage: { state: 'unavailable', capBytes: '2000000000', samples: [], disk: { provisionedGiB: 50, usedBytes: null } } };
const uSummary = () => { const s = billingState('standard'); s.ai.included = null; s.ai.balance = 120; return s; };
await check('Usage: the computer-time bar is the share LEFT', () => {
    const el = fragment(usageHtml(uSample, uSummary()));
    assert.equal(el.querySelector('[data-usage="compute"] [role="progressbar"]')?.getAttribute('aria-valuenow'), '40');
});
await check('Usage: whole-number credits; a balance above the grant is "from your plan + extra", never "x of 100"', () => {
    const s = billingState('free'); s.ai.balance = 1041.67; s.ai.balanceMicro = '1041670000'; s.ai.included = null;
    const row = fragment(usageHtml(uSample, s)).querySelector('[data-usage="ai"]');
    assert.doesNotMatch(clean(row), /1,041\.67|\d\.\d|1,041 of 100/);
    assert.match(clean(row), /1,041 left/);
    assert.match(clean(row), /100 from your plan \+ 941 extra/);
    assert.equal(row.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'), '100');
});
await check('Usage: low credits come from the server state only', () => {
    const s = uSummary(); s.ai.balance = 30; s.ai.state = 'ok';
    assert.doesNotMatch(clean(fragment(usageHtml(uSample, s)).querySelector('[data-usage="ai"]')), /Running low/);
});
await check('Usage: "Measuring this session…" instead of "0 s so far · Update delayed"', () => {
    const text = clean(fragment(usageHtml(uSample, uSummary(), { stale: true })));
    assert.match(text, /Measuring this session…/);
    assert.doesNotMatch(text, /Update delayed|0 s so far/);
});
await check('Usage: needs_ezil_id shows the EZiL ID link and no Add credits', () => {
    const el = fragment(usageHtml(uSample, billingState('needs_ezil_id')));
    const row = el.querySelector('[data-usage="ai"]');
    assert.match(clean(row), /100 credits waiting/);
    assert.equal(row.querySelector('a[data-action="ezil-id"]')?.getAttribute('href'), EZIL_ID);
    assert.equal(el.querySelector('[data-action="usage-add-credits"]'), null);
    assert.doesNotMatch(clean(row), /Unavailable|couldn't read/i);
});
await check('Usage: storage is the real disk, never "the same on every configuration" or the 2 GB constant', () => {
    const text = clean(fragment(usageHtml(uSample, uSummary())).querySelector('[data-usage="storage"]'));
    assert.match(text, /50 GB disk/);
    assert.doesNotMatch(text, /same on every configuration|2 GB/);
});
await check('Usage: no banned copy', () => {
    for ( const name of ['free', 'standard', 'premium', 'needs_ezil_id'] ) {
        const text = clean(fragment(usageHtml(uSample, billingState(name))));
        assert.deepEqual(scanCopy(text), [], name); assert.doesNotMatch(text, honestyBans, name);
    }
});

// ── Computer: source module with its imports stubbed (computers-test Part A) ──
globalThis.__dSession = { currentComputer: () => null, payload: () => null };
const computersSrc = read('tabs/computers.js')
    .replace("import { isNative } from '../../../native-runtime.js';", 'const isNative = () => false;')
    .replace("import { deleteComputerCopy } from '../../../../../app/src/app/computers/_lib/delete-copy.ts';", 'const deleteComputerCopy = () => ({});')
    .replace("import UIAlert from '../../../../src/UI/UIAlert.js';", "const UIAlert = async () => 'confirm';")
    .replace("import registry from '../../../apps/registry.js';", 'const registry = { launch: async () => undefined };')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__dSession;')
    .replace("import trpc from '../trpc.js';", 'const trpc = { query: async () => ({ ok: false }), mutate: async () => ({ ok: false }) };')
    .replace("import TabBilling from './billing.js';", 'const TabBilling = { available: () => true };')
    .replace("import { feedback_enabled, open_feedback_dialog } from '../../feedback/feedback.js';", 'const feedback_enabled = () => true, open_feedback_dialog = () => undefined;')
    .replace("import { TRANSITION_EVENT } from '../../computer-progress.js';", "const TRANSITION_EVENT = 'ezil:computer-transition';")
    + '\nexport const markSeen = id => seenInFlight.add(id);\n';
assert.ok(! /^import /m.test(computersSrc), 'every import of computers.js is stubbed (opening-progress-browser-test relies on the same nine lines)');
const tab = await import(moduleUrl(computersSrc));
const me = { id: 'c-1', name: 'My computer', slot: 1, createdAt: '2026-10-01T00:00:00Z', lastOpenedAt: null };
const older = { id: 'c-0', name: 'Old computer', slot: 2, createdAt: '2026-09-01T00:00:00Z', lastOpenedAt: null };
const running = (type = 'm6i.large', extra = {}) => ({ version: 2, computerId: 'c-1', operation: 'none', lifecycleState: 'RUNNING', needsOperator: false,
    transition: null, milestones: [], hardware: { instanceType: type, source: 'placement' }, ...extra });
const plan = tier => { const s = summaryV3(tier); s.computer.disk = tier === 'free' ? { provisionedGiB: null, usedBytes: null, growsOnSwitch: false } : { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false }; return s; };
const render = (args, prog = args.prog, list = []) => fragment(tab.computerHtml(tab.computerModel({ computer: me, ...args }), prog, list));
const tile = (el, size) => el.querySelector(`[data-role="config-grid"] [data-size="${size}"]`);

await check('Computer: tiles sell — title, one benefit line, the weight note, the plan needed and a visible Upgrade', () => {
    const el = render({ data: plan('standard'), prog: running() });
    for ( const [size, title, weight] of [['std-2', '2 vCPU · 8 GB', null], ['cmp-4', '4 vCPU · 16 GB', 'Counts 2× of your monthly time'], ['cmp-8', '8 vCPU · 32 GB', 'Counts 4× of your monthly time']] ) {
        const card = tile(el, size);
        assert.equal(clean(card.querySelector('[data-role="config-title"]')), title);
        assert.ok(clean(card.querySelector('[data-role="config-benefit"]')).length > 10, `${size} has a benefit line`);
        if ( weight ) assert.match(clean(card), new RegExp(weight.replace(/[×]/g, '×')));
    }
    for ( const size of ['cmp-4', 'cmp-8'] ) {
        const card = tile(el, size);
        assert.match(clean(card), /Included in Premium/);
        const upgrade = card.querySelector('[data-action="config-upgrade"]');
        assert.equal(clean(upgrade), 'Upgrade');
        assert.ok(upgrade.classList.contains('ezil-computer-upgrade'), 'accent-outline Upgrade, not a ghost button');
        assert.ok(! upgrade.classList.contains('ezil-settings-btn-primary'));
    }
    assert.equal(el.querySelectorAll('[data-role="config-current"]').length, 1);
    assert.match(clean(tile(el, 'std-2')), /Current/);
    const premium = render({ data: plan('premium'), prog: running() });
    assert.equal(clean(tile(premium, 'cmp-4').querySelector('[data-action="switch-config"]')), 'Switch');
    assert.equal(premium.querySelectorAll('[data-role="config-current"]').length, 1);
    const free = render({ data: plan('free'), prog: null, streaming: true });
    assert.match(clean(tile(free, 'std-2')), /Included in Standard/);
});
await check('Computer: the header names the computer, where it runs, its configuration and its real disk', () => {
    const el = render({ data: plan('premium'), prog: running('m6i.xlarge') });
    const header = clean(el.querySelector('[data-role="computer-header"]'));
    assert.match(header, /My computer/); assert.match(header, /AWS · Mumbai/);
    assert.match(clean(el.querySelector('[data-role="computer-summary"]')), /4 vCPU · 16 GB memory · 50 GB disk/);
    assert.match(clean(render({ data: plan('free'), prog: null, streaming: true }).querySelector('[data-role="computer-header"]')), /Cloudflare/);
});
await check('Computer: at most ONE primary in every state, and it is Open desktop in the header', () => {
    const T = '2026-10-29T10:00:00Z';
    const tr = (phase, extra = {}) => ({ transitionId: `t-${phase}`, kind: 'switch', current: 'std-2', target: 'cmp-4', phase, reason: null, requestedAt: T, endedAt: null, revertAvailable: false, ...extra });
    tab.markSeen('t-done');
    const grace = plan('premium'); grace.computer.standing = 'grace'; grace.plan.graceEndsAt = '2026-11-05T00:00:00Z';
    const nextStart = plan('premium'); nextStart.computer.size = 'cmp-4';
    const moved = state => { const s = plan('free'); Object.assign(s.computer, { standing: 'files_on_aws', filesOn: 'aws', move: { direction: 'to_cloudflare', stage: state, bytesDone: '1', bytesTotal: '2' } }); return s; };
    const cases = {
        idle: { data: plan('premium'), prog: running() },
        stopped: { data: plan('premium'), prog: running('m6i.large', { lifecycleState: 'STOPPED' }) },
        switching: { data: plan('premium'), prog: running('m6i.large', { transition: tr('waking'), operation: 'opening' }) },
        done: { data: plan('premium'), prog: running('m6i.xlarge', { transition: tr('done') }) },
        failed: { data: plan('premium'), prog: running('m6i.large', { transition: tr('failed', { reason: 'wake_timeout', revertAvailable: true }) }) },
        healFailed: { data: plan('premium'), prog: running('m6i.large', { transition: tr('failed', { reason: 'release_heal_failed' }) }) },
        nextStart: { data: nextStart, prog: running('m6i.large', { lifecycleState: 'STOPPED' }) },
        grace: { data: grace, prog: running() },
        moveDone: { data: moved('done'), prog: running() },
        moveFailed: { data: moved('failed'), prog: running() },
    };
    for ( const [name, args] of Object.entries(cases) ) {
        const el = render(args);
        const primaries = [...el.querySelectorAll('.ezil-settings-btn-primary')];
        assert.ok(primaries.length <= 1, `${name}: ${primaries.map(clean).join(' | ')}`);
        for ( const p of primaries ) assert.ok(p.closest('[data-role="computer-actions"]') && p.dataset.action === 'open', `${name}: the primary is the header Open desktop`);
    }
    // HF3 copy survives the demotion: the failed card still names the size and offers Try again.
    const failedText = clean(render(cases.failed));
    assert.match(failedText, /We couldn't switch to 4 vCPU · 16 GB\. Your computer is on 2 vCPU · 8 GB and your files are safe\./);
    assert.match(failedText, /Try again/);
    assert.match(clean(render(cases.healFailed)), /Try again/);
    assert.equal(render(cases.done).querySelectorAll('[data-action="open"]').length, 1, 'done: one Open desktop');
});
await check('Computer: during a switch only the target tile is highlighted; finished steps are marked done', () => {
    const prog = running('m6i.large', { operation: 'opening', milestones: [{ key: 'host_claimed', at: '2026-10-29T10:00:30Z' }],
        transition: { transitionId: 't-w', kind: 'switch', current: 'std-2', target: 'cmp-4', phase: 'waking', reason: null, revertAvailable: false } });
    const el = render({ data: plan('premium'), prog });
    assert.equal(tile(el, 'cmp-4').dataset.state, 'switching');
    assert.equal(tile(el, 'std-2').dataset.state, 'from', 'the old size is not highlighted as current');
    assert.equal(el.querySelectorAll('[data-role="config-grid"] [data-state="current"]').length, 0);
    assert.ok(el.querySelectorAll('.ezil-computer-steps li[data-state="done"]').length >= 1);
    const css = read('settings.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.ezil-computer-steps li\[data-state="done"\]::before/, 'done steps carry a marker');
    assert.doesNotMatch(css, /\.ezil-computer-config\[data-state="from"\][^{]*\{[^}]*var\(--accent\)/);
});
await check('Computer: Older computer and the red Delete are hidden on the web (the data stays)', () => {
    const el = render({ data: plan('premium'), prog: running() }, undefined, [older]);
    const section = el.querySelector('[data-role="older-computers"]');
    assert.ok(section, 'kept in the document');
    assert.ok(section.hidden, 'not shown');
    for ( const button of el.querySelectorAll('[data-action="delete"]') ) assert.ok(button.hidden || button.closest('[hidden]'), 'no visible Delete');
});
await check('Computer: the chip says "Stopping…" the moment the user confirms', () => {
    const model = tab.computerModel({ computer: me, data: plan('premium'), prog: running(), stopping: true });
    assert.deepEqual(model.chip, { state: 'stopping', text: 'Stopping…' });
});
await check('Computer: switch and stop confirmations carry the brief\'s copy', () => {
    const data = plan('premium');
    const sw = tab.confirmCopy('switch', { target: 'cmp-4', current: 'std-2', data });
    assert.equal(sw.title, 'Switch to 4 vCPU · 16 GB?');
    assert.deepEqual(sw.lines.slice(0, 3), ['Your computer restarts on the new size. Open apps close; save your work first.', 'Your files stay on your disk.', 'This usually takes 1-4 minutes.']);
    assert.match(sw.lines[3], /an hour of use counts as 2 hours of your monthly time/);
    assert.equal(sw.confirmLabel, 'Restart and switch');
    const stop = tab.confirmCopy('stop', { data });
    assert.equal(stop.title, 'Stop your computer?');
    assert.ok(stop.lines.includes('Your files stay on your disk.'));
    for ( const copy of [sw, stop] ) assert.deepEqual(scanCopy([copy.title, ...copy.lines].join(' ')), []);
});
await check('Computer: no banned copy in any rendered state', () => {
    for ( const tier of ['free', 'standard', 'premium'] ) {
        const text = clean(render({ data: plan(tier), prog: running(), streaming: true }));
        assert.deepEqual(scanCopy(text), [], tier); assert.doesNotMatch(text, honestyBans, tier);
    }
});

// ── The confirmation is the sheet frame ─────────────────────────────────────
const { openConfirmSheet } = await import(moduleUrl(read('sheet-frame.js')));
await check('Confirm: a dark sheet-frame dialog with an accent primary; Esc and Cancel decline; primary disabled in flight', async () => {
    const container = window.document.querySelector('main');
    assert.equal(typeof openConfirmSheet, 'function');
    let declined = openConfirmSheet({ container, sheet: 'confirm-stop', title: 'Stop your computer?', lines: ['Your files stay on your disk.'], confirmLabel: 'Stop' });
    let dialog = window.document.querySelector('[role="dialog"][data-sheet="confirm-stop"]');
    assert.ok(dialog, 'dialog rendered');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
    assert.equal(dialog.getAttribute('aria-label'), 'Stop your computer?');
    assert.ok(dialog.closest('.ezil-upgrade-backdrop'), 'inside the dark sheet backdrop');
    assert.equal(dialog.querySelector('[data-action="close-sheet"]').getAttribute('aria-label'), 'Close');
    assert.ok(dialog.querySelector('[data-action="confirm"]').classList.contains('ezil-settings-btn-primary'));
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(await declined, false);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
    declined = openConfirmSheet({ container, sheet: 'confirm-stop', title: 'Stop your computer?', lines: [], confirmLabel: 'Stop' });
    window.document.querySelector('[data-action="cancel"]').click();
    assert.equal(await declined, false);
    let release;
    const accepted = openConfirmSheet({ container, sheet: 'confirm-switch', title: 'Switch?', lines: ['a'], confirmLabel: 'Restart and switch', busyLabel: 'Starting switch…',
        onConfirm: () => new Promise(resolve => { release = resolve; }) });
    dialog = window.document.querySelector('[data-sheet="confirm-switch"]');
    const primary = dialog.querySelector('[data-action="confirm"]');
    primary.click();
    assert.equal(primary.disabled, true);
    assert.equal(primary.textContent, 'Starting switch…');
    primary.click();
    release();
    assert.equal(await accepted, true);
    assert.equal(window.document.querySelector('[role="dialog"]'), null);
});
await check('Confirm: the sheet styles use tokens only (accent primary, dark surface)', () => {
    const css = read('upgrade-sheet.css').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\.ezil-confirm-sheet\s*\{/);
    const rule = css.match(/\.ezil-confirm-sheet\s*\{([^}]*)\}/)[1];
    assert.doesNotMatch(rule, /#[0-9a-f]{3,6}\b/i);
});

// ── Troubleshoot, System, Feedback ──────────────────────────────────────────
const RESTART = 'Restarting usually takes about 45 seconds and can take up to 3 minutes.';
await check('Troubleshoot: the Restart copy is one sentence, identical in both places', () => {
    const src = read('tabs/troubleshoot.js');
    assert.equal(src.split(RESTART).length - 1, 2, 'the sentence appears in the description and in the restarting status');
    assert.doesNotMatch(src, /About 20 seconds/);
    assert.deepEqual(scanCopy(RESTART), []);
});
globalThis.__dSystemSession = { currentComputer: () => me, payload: () => null, getScreen: async () => ({ ok: false }), getSystemInfo: async () => ({ ok: false, code: 'UPSTREAM' }) };
const systemSrc = read('tabs/system.js')
    .replace("import { isNative, NATIVE_CAPABILITIES, selectRuntimeAdapter } from '../../../native-runtime.js';", 'const isNative = () => false, NATIVE_CAPABILITIES = {}, selectRuntimeAdapter = () => null;')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__dSystemSession;')
    .replace("from './system-describe.js';", `from ${JSON.stringify(moduleUrl(read('tabs/system-describe.js')))};`);
await check('System: Running on and Configuration stay; identifiers, slot, image and provenance sit behind a closed Details', async () => {
    assert.ok(! /^import /m.test(systemSrc.replace(/^import \{[^}]*\} from "data:[^"]*";$/m, '')), 'system imports stubbed');
    globalThis.document = window.document;
    globalThis.window = window;
    const { default: system } = await import(moduleUrl(systemSrc));
    const host = window.document.createElement('div');
    window.document.body.append(host);
    host.innerHTML = system.html();
    const $win = { off () { return this; }, on () { return this; } };
    system.init($win, { computer: me });
    const pane = window.document.querySelector('.ezil-settings-system');
    const details = pane.querySelector('details[data-role="sys-details"]');
    assert.ok(details, 'a Details disclosure');
    assert.equal(details.open, false);
    assert.equal(clean(details.querySelector('summary')), 'Details');
    for ( const text of ['Identifier', 'Slot', 'Image', 'recorded, configured or measured'] ) {
        assert.ok(clean(details).includes(text), `${text} is inside Details`);
        assert.ok(! clean(pane).replace(clean(details), '').includes(text), `${text} is not outside Details`);
    }
    for ( const role of ['sys-running-on', 'sys-configuration'] ) {
        const row = pane.querySelector(`[data-role="${role}"]`);
        assert.ok(row && ! details.contains(row), `${role} stays visible`);
    }
    system.onDeactivate();
    host.remove();
});
await check('Feedback: the dialog is dark with an accent primary, through tokens only', () => {
    const css = read('../feedback/feedback.css').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = selector => (css.match(new RegExp(`(?:^|\\})\\s*${selector.replace(/[.[\]()*"=]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) ?? [])[1] ?? '';
    const dialog = rule('.ezil-feedback-dialog');
    assert.match(dialog, /background:\s*var\(--/);
    assert.match(dialog, /color:\s*var\(--/);
    const submit = rule('.ezil-feedback-dialog button[type="submit"]');
    assert.match(submit, /background:\s*var\(--ezil-accent/);
    assert.match(submit, /color:\s*var\(--ezil-accent-contrast/);
    assert.doesNotMatch(css, /#245fae|background:\s*#fff\b|#3479d5/i, 'no hard-coded light theme or off-system blue');
    assert.match(css, /prefers-color-scheme:\s*light|data-theme="?light/, 'a light variant exists');
});

console.log(`\n${passed} passed, ${failed} failed (Settings design D6)`);
dom.window.close();
process.exit(failed ? 1 : 0);
