// computers-test.mjs — EZiL-authored. The one-computer Settings tab (round 3,
// plan §6.1/§6.2, decisions D5/D6).
//
// Run:  node shell/ezil/ui/Settings/computers-test.mjs
//       Part A imports the SOURCE tab with its imports stubbed (no bundle).
//       Part B drives the BUILT bundle in jsdom (after shell/build-shell.sh;
//       EZIL_SHELL_OUT_DIR picks another build directory) and is skipped with
//       exit 2 only when no bundle exists.
//
// What it pins: no slot UI; current / available / locked / unavailable / next
// start per plan; the acknowledgement before the request leaves; a duplicate
// click sends nothing; a reload reuses the requestId; "Now" and "Next" are
// never mixed in one label; failure names the size it is on, shows Back to <previous>
// only when the computer is on another size, and Try again
// only when retryable; D11 copy; the copy passes scanCopy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCopy } from '../../../../e2e/billing-e2e-lib.mjs';
import { summaryV3 } from './billing-v3-fixtures.mjs';
import { honestyBans } from './billing-copy-test-helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const results = [];
function check (name, fn) {
    try { fn(); passed++; results.push(`PASS ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error.message}`); }
}
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const scanned = [];
const scan = html => { scanned.push(html); return html; };

// ── Part A: the source module, pure functions ────────────────────────────────
globalThis.html_encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
globalThis.__cSession = { currentComputer: () => null, payload: () => null };
const moduleUrl = src => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
const src = fs.readFileSync(new URL('./tabs/computers.js', import.meta.url), 'utf8')
    .replace("import { isNative } from '../../../native-runtime.js';", 'const isNative = () => false;')
    .replace("import { deleteComputerCopy } from '../../../../../app/src/app/computers/_lib/delete-copy.ts';", 'const deleteComputerCopy = () => ({});')
    .replace("import UIAlert from '../../../../src/UI/UIAlert.js';", "const UIAlert = async () => 'confirm';")
    .replace("import registry from '../../../apps/registry.js';", 'const registry = { launch: async () => undefined };')
    .replace("import session from '../../../session.js';", 'const session = globalThis.__cSession;')
    .replace("import trpc from '../trpc.js';", 'const trpc = { query: async () => ({ ok: false }), mutate: async () => ({ ok: false }) };')
    .replace("import TabBilling from './billing.js';", 'const TabBilling = { available: () => true };')
    .replace("import { feedback_enabled, open_feedback_dialog } from '../../feedback/feedback.js';", 'const feedback_enabled = () => true, open_feedback_dialog = () => undefined;')
    .replace("import { TRANSITION_EVENT } from '../../computer-progress.js';", "const TRANSITION_EVENT = 'ezil:computer-transition';");
assert.ok(! /^import /m.test(src), 'every import of the tab is stubbed');
const tab = await import(moduleUrl(src));
const { computerModel, computerHtml, switchSteps, switchRatio, switchRequestId, clearSwitchRequestId, refusalCopy, sizeForInstanceType, AWS_CAP_COPY, moveView, standingOf } = tab;

const me = { id: 'c-1', name: 'My computer', slot: 1, createdAt: '2026-10-01T00:00:00Z', lastOpenedAt: null };
const running = (type = 'm6i.large', extra = {}) => ({ version: 2, computerId: 'c-1', operation: 'none', lifecycleState: 'RUNNING', needsOperator: false,
    transition: null, milestones: [], hardware: { instanceType: type, source: 'placement' }, ...extra });
const premium = () => ({ ...summaryV3('premium'), computer: { ...summaryV3('premium').computer, disk: { provisionedGiB: 50, usedBytes: null } } });
const standard = () => ({ ...summaryV3('standard'), computer: { ...summaryV3('standard').computer, disk: { provisionedGiB: 50, usedBytes: null } } });
const free = () => ({ ...summaryV3('free'), computer: { ...summaryV3('free').computer, disk: { provisionedGiB: null, usedBytes: null } } });
const states = model => Object.fromEntries(model.cards.map(card => [card.size, card.state]));

check('instance types map to configurations by vCPU', () => {
    assert.deepEqual(['m6i.large', 'm6i.xlarge', 'm6i.2xlarge', 'm6i.metal', null].map(sizeForInstanceType), ['std-2', 'cmp-4', 'cmp-8', null, null]);
});

check('Premium running on 2 vCPU: current + two available, no slot UI', () => {
    const model = computerModel({ computer: me, data: premium(), prog: running() });
    assert.deepEqual(states(model), { 'std-2': 'current', 'cmp-4': 'available', 'cmp-8': 'available' });
    assert.equal(model.chip.text, 'Running');
    assert.equal(model.provider, 'AWS · India');
    const html = scan(computerHtml(model, running(), []));
    assert.match(html, /<h3>Your computer<\/h3>/);
    assert.match(text(html), /2 vCPU · 8 GB memory · 50 GB disk/);
    assert.match(text(html), /50 GB disk for your projects/);
    assert.match(text(html), /Stays the same when you switch configuration\./);
    assert.match(text(html), /counts 2× time/);
    assert.equal((html.match(/data-action="switch-config"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-slot|New computer|Empty slot|data-action="create"|Add computer/);
});

check('Standard: 4 and 8 vCPU are locked with the plan that unlocks them, plus Upgrade', () => {
    const model = computerModel({ computer: me, data: standard(), prog: running() });
    assert.deepEqual(states(model), { 'std-2': 'current', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    const html = scan(computerHtml(model, running(), []));
    assert.equal((html.match(/data-role="config-locked"/g) ?? []).length, 2);
    assert.match(html, /Premium<\/span>\s*<a class="ezil-settings-btn" data-action="config-upgrade" href="\/os\?settings=billing&amp;upgrade=premium">Upgrade<\/a>/);
    assert.doesNotMatch(html, /data-action="switch-config"/);
    assert.match(text(html), /Your plan includes 2 vCPU\. Premium unlocks 4 and 8 vCPU\. Compare plans/);
});

check('Free: the Cloudflare configuration is current, AWS ones locked; no invented disk number', () => {
    const model = computerModel({ computer: me, data: free(), prog: { version: 2, computerId: 'c-1', operation: 'none', lifecycleState: null } , streaming: true });
    assert.deepEqual(states(model), { 'free-cf': 'current', 'std-2': 'locked', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.equal(model.provider, 'Cloudflare');
    const html = scan(computerHtml(model, null, []));
    assert.equal(model.cards.find(c => c.size === 'std-2').plan, 'Standard');
    assert.doesNotMatch(text(html), /\d+ GB disk/);
});

check('a capacity refusal marks that card unavailable with the plan copy', () => {
    const model = computerModel({ computer: me, data: premium(), prog: running(), refusedSizes: new Set(['cmp-8']) });
    assert.equal(states(model)['cmp-8'], 'unavailable');
    assert.match(text(scan(computerHtml(model, running(), []))), /Not available right now — try 4 vCPU or try again later\./);
    assert.equal(refusalCopy('capacity_unavailable', 'cmp-4', premium(), 'std-2'), 'Not available right now — try again later.');
});

check('acknowledgement: the pending click alone shows Switching…, the chip and separate Now/Next labels', () => {
    const pending = { computerId: 'c-1', current: 'std-2', target: 'cmp-4' };
    const model = computerModel({ computer: me, data: premium(), prog: running(), pending });
    assert.equal(model.chip.text, 'Switching to 4 vCPU');
    assert.equal(states(model)['cmp-4'], 'switching');
    const html = scan(computerHtml(model, running(), []));
    const now = text(html.match(/<p data-role="now-label">[\s\S]*?<\/p>/)[0]);
    const next = text(html.match(/<p data-role="next-label">[\s\S]*?<\/p>/)[0]);
    assert.equal(now, 'Now: 2 vCPU · 8 GB');
    assert.equal(next, 'Next: 4 vCPU · 16 GB');
    assert.match(html, /Switching…/);
    assert.match(html, /data-step="1" data-state="active">Saving and closing your session/);
    assert.match(html, /data-action="open" disabled/);
});

check('🔴 Now and Next are never mixed in one label, in every phase', () => {
    for ( const phase of ['requested', 'stopping', 'waking'] ) {
        const prog = running('m6i.large', { transition: { transitionId: `t-${phase}`, kind: 'switch', current: 'std-2', target: 'cmp-8', phase, reason: null, revertAvailable: false } });
        const html = scan(computerHtml(computerModel({ computer: me, data: premium(), prog }), prog, []));
        for ( const label of html.match(/<(p|span|li|strong)[^>]*>[^<]*<\/\1>/g) ?? [] ) {
            const sizes = ['2 vCPU', '8 vCPU'].filter(size => text(label).includes(size));
            assert.ok(sizes.length <= 1, `mixed label: ${text(label)}`);
        }
        assert.match(text(html), /Now: 2 vCPU · 8 GB/);
        assert.match(text(html), /Next: 8 vCPU · 32 GB/);
    }
});

check('progress steps follow server milestones; warm vs cold wording; bar monotonic and below 100 %', () => {
    const base = { current: 'std-2', target: 'cmp-4', acknowledged: true };
    assert.equal(switchSteps({ ...base, phase: 'stopping' }, { milestones: [] }, premium()).index, 0);
    const warm = switchSteps({ ...base, phase: 'waking' }, { expectedSeconds: 150, milestones: [{ key: 'requested' }, { key: 'host_claimed' }] }, premium());
    assert.equal(warm.index, 2);
    assert.equal(warm.steps[1], 'Getting a 4 vCPU machine — ready machine found');
    const cold = switchSteps({ ...base, phase: 'waking' }, { expectedSeconds: 300, milestones: [{ key: 'requested' }] }, premium());
    assert.equal(cold.index, 1);
    assert.equal(cold.steps[1], 'Getting a 4 vCPU machine — preparing a new machine — can take a few minutes');
    assert.equal(switchSteps({ ...base, phase: 'waking' }, { milestones: [{ key: 'files_attached' }] }, premium()).index, 3);
    const t = { transitionId: 't-bar' };
    const at = (seconds, index) => switchRatio(base, { transition: t, openingStartedAt: '2026-10-28T10:00:00Z', observedAt: new Date(Date.parse('2026-10-28T10:00:00Z') + seconds * 1000).toISOString(), expectedSeconds: 100 }, index);
    const a = at(90, 3), b = at(10, 1), c = at(5000, 3);
    assert.ok(b >= a, 'the bar never moves back');
    assert.ok(c < 1, 'never 100 % before done');
});

check('done: "Now running on" + Open desktop only for a transition seen in flight', () => {
    const flying = running('m6i.large', { transition: { transitionId: 't-done', kind: 'switch', current: 'std-2', target: 'cmp-4', phase: 'waking', reason: null, revertAvailable: false } });
    // computerModel alone does not record in-flight ids; the tab does on render.
    const unseen = computerModel({ computer: me, data: premium(), prog: running('m6i.xlarge', { transition: { ...flying.transition, phase: 'done' } }) });
    assert.equal(unseen.done, null);
});

check('HF3 lead: a release that failed to heal is retryable; an 8 vCPU step reads "an"', () => {
    for ( const reason of ['release_heal_failed', 'release_heal_timeout'] ) {
        const prog = running('m6i.large', { transition: { transitionId: `t-${reason}`, kind: 'switch', current: 'std-2', target: 'cmp-4', phase: 'failed', reason, revertAvailable: true } });
        const html = scan(computerHtml(computerModel({ computer: me, data: premium(), prog }), prog, []));
        assert.match(html, /data-action="switch-retry" data-size="cmp-4">Try again/, reason);
        assert.match(text(html), /We couldn't switch to 4 vCPU · 16 GB\. Your computer is on 2 vCPU · 8 GB/);
    }
    const big = switchSteps({ current: 'cmp-4', target: 'cmp-8', phase: 'waking', acknowledged: true }, { milestones: [{ key: 'host_claimed' }], expectedSeconds: 90 }, premium());
    assert.equal(big.steps[1], 'Getting an 8 vCPU machine — ready machine found');
});

check('failure: names the target and the size it is on, Back to only when elsewhere, Try again only when retryable, D11 copy for the AWS cap', () => {
    const failed = (reason, type = 'm6i.large') => running(type, { transition: { transitionId: `t-${reason}`, kind: 'switch', current: 'std-2', target: 'cmp-8', phase: 'failed', reason, revertAvailable: true } });
    const html = scan(computerHtml(computerModel({ computer: me, data: premium(), prog: failed('capacity_unavailable') }), failed('capacity_unavailable'), []));
    assert.match(text(html), /We couldn't switch to 8 vCPU · 32 GB\. Your computer is on 2 vCPU · 8 GB and your files are safe\./);
    assert.doesNotMatch(text(html), /back on/);
    assert.match(html, /data-action="switch-retry" data-size="cmp-8">Try again/);
    // HF3: already on the pre-switch size, so "Back to" it would be a switch to the size it runs.
    assert.doesNotMatch(html, /switch-back/);
    assert.match(html, /data-role="computer-chip" data-state="attention">Needs attention/);
    // The placement is on another size (the switch left it elsewhere): name it, and offer Back to the previous one.
    const elsewhere = failed('size_not_applied', 'm6i.xlarge');
    const moved = scan(computerHtml(computerModel({ computer: me, data: premium(), prog: elsewhere }), elsewhere, []));
    assert.match(text(moved), /We couldn't switch to 8 vCPU · 32 GB\. Your computer is on 4 vCPU · 16 GB and your files are safe\./);
    assert.match(moved, /data-action="switch-back" data-size="std-2">Back to 2 vCPU · 8 GB/);
    assert.match(moved, /data-action="switch-retry" data-size="cmp-8">Try again/);
    // No placement size and no preference: the pre-switch size, and no Back to it.
    const bare = { ...failed('wake_timeout'), hardware: null };
    const data = premium(); data.computer.size = null;
    const unknown = scan(computerHtml(computerModel({ computer: me, data, prog: bare }), bare, []));
    assert.match(text(unknown), /Your computer is on 2 vCPU · 8 GB and your files are safe\./);
    assert.doesNotMatch(unknown, /switch-back/);
    const billing = scan(computerHtml(computerModel({ computer: me, data: premium(), prog: failed('billing_payment_issue', 'm6i.xlarge') }), failed('billing_payment_issue', 'm6i.xlarge'), []));
    assert.doesNotMatch(billing, /switch-retry/);
    assert.match(billing, /switch-back/);
    const cap = scan(computerHtml(computerModel({ computer: me, data: premium(), prog: failed('billing_user_hours_cap') }), failed('billing_user_hours_cap'), []));
    assert.match(text(cap), new RegExp(AWS_CAP_COPY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(cap, /switch-retry|fair use|standard-hour/i);
    assert.equal(refusalCopy('user_hours_cap', 'cmp-4'), AWS_CAP_COPY);
});

check('HF3: after a failure, the server decides the card: reopened (no transition) shows none; a second switch shows progress', () => {
    // Settings reopened after a failure the server no longer reports (superseded or recovered): no failure card.
    const reopened = running('m6i.xlarge');
    const gone = scan(computerHtml(computerModel({ computer: me, data: premium(), prog: reopened }), reopened, []));
    assert.doesNotMatch(gone, /switch-failed|couldn't switch/);
    assert.match(gone, /data-role="computer-chip" data-state="running">Running/);
    assert.match(text(gone), /4 vCPU · 16 GB memory/);
    // A second switch (cmp-4 → cmp-8) after the earlier failure: progress only, no stale failure copy.
    const again = running('m6i.xlarge', { transition: { transitionId: 't-again', kind: 'switch', current: 'cmp-4', target: 'cmp-8', phase: 'waking', reason: null, revertAvailable: false } });
    const model = computerModel({ computer: me, data: premium(), prog: again });
    assert.equal(model.failed, null);
    const html = scan(computerHtml(model, again, []));
    assert.match(html, /data-role="switch-progress"/);
    assert.doesNotMatch(html, /switch-failed|couldn't switch|back on/);
    assert.match(text(html), /Now: 4 vCPU · 16 GB Next: 8 vCPU · 32 GB/);
});

check('STOPPED with a different next-start choice: "Next start" + Start now, nothing starts', () => {
    const prog = { ...running(), lifecycleState: 'STOPPED' };
    const data = premium();
    data.computer.size = 'cmp-4';
    const model = computerModel({ computer: me, data, prog });
    assert.deepEqual(states(model), { 'std-2': 'current', 'cmp-4': 'next', 'cmp-8': 'available' });
    assert.equal(model.chip.text, 'Stopped');
    const html = scan(computerHtml(model, prog, []));
    assert.match(text(html), /Next start: 4 vCPU · 16 GB Start now/);
    assert.doesNotMatch(html, /data-action="stop"/);
});

check('older computer: read-only, Delete only', () => {
    const html = scan(computerHtml(computerModel({ computer: me, data: premium(), prog: running() }), running(), [{ id: 'c-2', name: 'Old box', slot: 2, createdAt: '2026-10-01T00:00:00Z' }]));
    const older = html.split('data-role="older-computer"')[1].split('</section>')[0];
    assert.deepEqual([...older.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]), ['delete']);
    assert.match(text(html), /Older computer/);
});

check('🔴 one requestId per (computer, target): a duplicate click and a reload reuse it; clearing mints a new one', () => {
    const map = new Map();
    const store = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) };
    const first = switchRequestId('c-1', 'cmp-4', store);
    assert.match(first, /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(switchRequestId('c-1', 'cmp-4', store), first, 'second click');
    assert.equal(switchRequestId('c-1', 'cmp-4', { ...store }), first, 'reload: a new page reads the same session storage');
    assert.notEqual(switchRequestId('c-1', 'cmp-8', store), first, 'another target is another request');
    clearSwitchRequestId('c-1', 'cmp-4', store);
    assert.notEqual(switchRequestId('c-1', 'cmp-4', store), first);
    assert.match(switchRequestId('c-1', 'std-2', null), /^[A-Za-z0-9_-]{8,64}$/, 'no storage still yields a valid id');
});

check('every refusal reads as a sentence', () => {
    for ( const reason of ['switch_in_progress', 'not_entitled', 'capacity_unavailable', 'computer_busy', 'foreign_computer', 'unauthorized', 'error'] ) {
        const copy = refusalCopy(reason, 'cmp-8', premium(), 'std-2');
        assert.match(copy, /^[A-Z].+[.]$/, reason);
        scanned.push(copy);
    }
});

// ── Round 4 (D16-D18): the Computer card from the server's standing ──────────
const GRACE = '2026-11-05T00:00:00Z', ENDS = '2026-11-26T00:00:00Z';
const withStanding = (data, standing, extra = {}, plan = {}) => ({ ...data, plan: { ...data.plan, ...plan },
    computer: { ...data.computer, standing, filesOn: 'aws', heldSince: null, move: null, ...extra } });
const stoppedAws = (type = 'm6i.large') => running(type, { lifecycleState: 'STOPPED' });
const roles = html => ['payment-grace', 'plan-ending', 'files-held', 'move-progress', 'move-done', 'move-failed'].filter(role => html.includes(`data-role="${role}"`));

check('Round 4 paid: unchanged, no standing banner', () => {
    const model = computerModel({ computer: me, data: withStanding(premium(), 'paid'), prog: running() });
    assert.deepEqual(states(model), { 'std-2': 'current', 'cmp-4': 'available', 'cmp-8': 'available' });
    assert.deepEqual(roles(scan(computerHtml(model, running(), []))), []);
});

check('Round 4 grace: the paid computer stays usable; banner with the date and Fix payment', () => {
    const data = withStanding(premium(), 'grace', {}, { status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: GRACE });
    const model = computerModel({ computer: me, data, prog: running() });
    const html = scan(computerHtml(model, running(), []));
    assert.deepEqual(roles(html), ['payment-grace']);
    assert.match(text(html), /Your payment didn't go through — update it by Nov 5, 2026 to keep your AWS computer\./);
    assert.match(html, /data-action="fix-payment" href="\/os\?settings=billing">Fix payment<\/a>/);
    assert.equal((html.match(/data-action="switch-config"/g) ?? []).length, 2, 'Switch stays enabled');
    assert.doesNotMatch(html, /data-action="open" disabled/);
    assert.equal(model.provider, 'AWS · India');
});

check('Round 4 plan_ending: the end date and that nothing is deleted', () => {
    const data = withStanding(premium(), 'plan_ending', {}, { status: 'cancels', cancelsAt: ENDS, planEndsAt: ENDS });
    const html = scan(computerHtml(computerModel({ computer: me, data, prog: running() }), running(), []));
    assert.deepEqual(roles(html), ['plan-ending']);
    assert.match(text(html), /Premium ends on Nov 26, 2026\. After that your files stay on your AWS computer until they are moved to your Free computer; nothing is deleted\./);
});

check('Round 4 files_on_aws: AWS (India) · files kept, Open desktop, every AWS configuration locked with Upgrade, no Cloudflare "Current"', () => {
    const data = withStanding(free(), 'files_on_aws');
    const model = computerModel({ computer: me, data, prog: stoppedAws(), streaming: false });
    assert.equal(model.held, true);
    assert.deepEqual(states(model), { 'std-2': 'locked', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.equal(model.chip.text, 'Stopped');
    assert.equal(model.provider, 'AWS (India) · files kept');
    const html = scan(computerHtml(model, stoppedAws(), []));
    assert.deepEqual(roles(html), ['files-held']);
    assert.match(text(html), /Your computer Stopped AWS \(India\) · files kept/);
    assert.match(text(html), /2 vCPU · 8 GB memory/);
    assert.match(html, /<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open">Open desktop<\/button>/);
    assert.equal((html.match(/data-role="config-locked"/g) ?? []).length, 3);
    assert.equal((html.match(/data-action="config-upgrade"/g) ?? []).length, 3);
    assert.doesNotMatch(html, /data-role="config-current"|data-size="free-cf"|data-action="switch-config"/);
    assert.match(text(html), /Your files are still on your AWS \(India\) computer\. Open it on the Free plan with Free limits, or upgrade to restore full use\./);
    assert.match(text(html), /Upgrade to restore full use\. Compare plans/);
    const runningHeld = computerModel({ computer: me, data, prog: running() });
    assert.equal(runningHeld.chip.text, 'Running');
});

check('Round 4: after grace the plan block may still describe the past_due paid plan; the standing decides the card', () => {
    const lapsed = withStanding(premium(), 'files_on_aws', {}, { status: 'past_due', paymentIssue: 'payment_failed' });
    const held = computerModel({ computer: me, data: lapsed, prog: stoppedAws() });
    assert.equal(held.held, true);
    assert.deepEqual(states(held), { 'std-2': 'locked', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.ok(! /data-action="switch-config"/.test(computerHtml(held, stoppedAws(), [])));
    const onCf = computerModel({ computer: me, data: withStanding(premium(), 'free', { filesOn: 'cloudflare' }, { status: 'past_due', paymentIssue: 'payment_failed' }),
        prog: { version: 2, computerId: 'c-1', operation: 'none', lifecycleState: null }, streaming: true });
    assert.deepEqual(states(onCf), { 'free-cf': 'current', 'std-2': 'locked', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.equal(onCf.provider, 'Cloudflare');
});

check('Round 4: Free on Cloudflare and an unknown standing keep the round-3 card exactly', () => {
    const base = computerModel({ computer: me, data: free(), prog: { version: 2, computerId: 'c-1', operation: 'none', lifecycleState: null }, streaming: true });
    for ( const standing of ['free', undefined, 'moved'] ) {
        const model = computerModel({ computer: me, data: withStanding(free(), standing, standing === 'free' ? { filesOn: 'cloudflare' } : {}),
            prog: { version: 2, computerId: 'c-1', operation: 'none', lifecycleState: null }, streaming: true });
        assert.deepEqual(states(model), states(base), String(standing));
        assert.equal(model.provider, 'Cloudflare');
        assert.deepEqual(roles(computerHtml(model, null, [])), []);
    }
    assert.equal(standingOf({ computer: { standing: 'moved' } }), null);
});

check('Round 4 move (Phase B): dormant while move is null or another direction; progress, done and failed from server stages', () => {
    for ( const move of [null, undefined, { direction: 'to_aws', stage: 'exporting', bytesDone: '1', bytesTotal: '2' }] ) {
        assert.equal(moveView(move), null);
        const html = computerHtml(computerModel({ computer: me, data: withStanding(free(), 'files_on_aws', { move }), prog: stoppedAws() }), stoppedAws(), []);
        assert.ok(! /data-role="move-/.test(html), JSON.stringify(move));
    }
    const moving = withStanding(free(), 'files_on_aws', { move: { direction: 'to_cloudflare', stage: 'exporting', bytesDone: '120000000', bytesTotal: '2400000000' } });
    const html = scan(computerHtml(computerModel({ computer: me, data: moving, prog: stoppedAws() }), stoppedAws(), []));
    assert.ok(html.includes('data-role="move-progress"'));
    assert.match(text(html), /Moving your files to your Free computer 120 MB of 2\.4 GB copied/);
    assert.match(html, /<li data-step="1" data-state="done">Saving your files<\/li><li data-step="2" data-state="active">Copying your files to your Free computer<\/li>/);
    const percent = Number(html.match(/aria-valuenow="(\d+)"/)[1]);
    assert.ok(percent > 25 && percent < 50, String(percent));
    const done = scan(computerHtml(computerModel({ computer: me, data: withStanding(free(), 'free', { filesOn: 'cloudflare', move: { direction: 'to_cloudflare', stage: 'committed', bytesDone: '1', bytesTotal: '1' } }) }), null, []));
    assert.match(text(done), /Your files are on your Free computer\. Open desktop/);
    const failed = scan(computerHtml(computerModel({ computer: me, data: withStanding(free(), 'files_on_aws', { move: { direction: 'to_cloudflare', stage: 'failed_reopened', bytesDone: '0', bytesTotal: null, reason: 'move_copy_failed' } }), prog: stoppedAws() }), stoppedAws(), []));
    assert.match(text(failed), /We couldn't move your files\. They're still on your AWS computer and nothing was deleted\./);
    assert.match(failed, /data-action="move-retry">Try again<\/button>/);
    assert.match(failed, /data-action="move-feedback" data-code="move_copy_failed">Send feedback/);
});

check('Round 4: the standing copy passes the copy guard and names no region code or city', () => {
    for ( const html of scanned ) {
        assert.doesNotMatch(text(html), honestyBans);
        assert.doesNotMatch(text(html), /ap-south-1|mumbai/i);
    }
});

check('scanCopy: no banned word in any rendered Computer state', () => {
    const hits = scanned.flatMap(html => scanCopy(text(html)));
    assert.deepEqual(hits, []);
    assert.ok(scanned.length >= 15, `${scanned.length} states scanned`);
});

// ── Part B: the built bundle, the real click path ─────────────────────────────
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
const haveBundle = ['icons.js', 'bundle.min.js', 'bundle.min.css'].every(f => fs.existsSync(path.join(OS, f)));
let bundleRan = false;
if ( haveBundle ) {
    bundleRan = true;
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><html><head></head><body><div class="desktop"></div></body></html>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' });
    const { window } = dom;
    const uncaught = [];
    window.addEventListener('error', e => uncaught.push(e.message));
    if ( ! window.crypto?.getRandomValues ) window.crypto = { getRandomValues: a => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; } };
    const calls = [];
    let data = premium(), progress = running(), switchReply = null, held = null;
    window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const call = { url: u, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, at: window.performance.now() };
        calls.push(call);
        const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
        if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: [me] } } });
        if ( u.includes('/api/trpc/billing.summary') ) return json({ result: { data: { json: data } } });
        if ( u.includes('/api/trpc/billing.history') ) return json({ result: { data: { json: [] } } });
        if ( u.includes('/api/trpc/computer.progress') ) return json({ result: { data: { json: progress } } });
        if ( u.endsWith('/api/shell/switch') ) {
            if ( switchReply ) return json(switchReply);
            return new Promise(resolve => { held = body => resolve(json(body)); });
        }
        return json({ error: { json: { message: 'stub', data: { code: 'INTERNAL_SERVER_ERROR' } } } }, 500);
    };
    window.eval(fs.readFileSync(`${OS}/icons.js`, 'utf8'));
    window.eval(fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
    window.ezil.boot();
    const doc = window.document;
    const q = sel => doc.querySelector(sel), qa = sel => [...doc.querySelectorAll(sel)];
    const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
    const settle = async (n = 10, ms = 20) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
    const click = el => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    const payload = { user: { id: 'u-1', email: 'a@example.com', name: 'A', provider: 'google', createdAt: '2026-10-01T00:00:00Z' },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }], computer: me,
        desktopState: { endpoints: { switch: '/api/shell/switch' } }, features: { billing: true } };
    window.__EZIL_BOOT__ = payload;
    const ctx = { payload, computer: me, desktopState: payload.desktopState };
    const pane = () => q('.window[data-app="settings"] [data-pane="computers"]');
    const card = size => pane()?.querySelector(`[data-role="config-grid"] [data-size="${size}"]`);
    const openComputerTab = async () => {
        if ( ! q('.window[data-app="settings"]') ) await window.ezil.registry.launch('settings', ctx);
        await settle();
        click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
        await settle(3);
        click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
        await settle();
    };
    const switches = () => calls.filter(c => c.url.endsWith('/api/shell/switch'));

    await openComputerTab();
    check('bundle: the Computer tab shows Your computer with a Premium grid and the sidebar says Computer', () => {
        assert.equal(pane()?.querySelector('[data-role="your-computer"] h3')?.textContent, 'Your computer');
        assert.equal(card('std-2')?.dataset.state, 'current');
        assert.equal(card('cmp-4')?.dataset.state, 'available');
        assert.equal(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"] .ezil-settings-tab-label')?.textContent, 'Computer');
        assert.equal(pane()?.querySelector('[data-slot], [data-action="create"]'), null);
    });

    click(card('cmp-4')?.querySelector('[data-action="switch-config"]'));
    await settle(4);
    const confirmText = q('.window-alert-message')?.textContent ?? '';
    const switchNow = qa('.window button').find(b => b.textContent.trim() === 'Switch now' && b.closest('.window')?.querySelector('.window-alert-message'));
    check('bundle: Switch on a RUNNING computer confirms first with the plan copy, and sends nothing yet', () => {
        assert.match(confirmText, /Switch to 4 vCPU · 16 GB\?/);
        assert.match(confirmText, /Your computer restarts on a bigger machine\. Your files and settings stay; running apps restart\. Usually about a minute, longer if a machine has to be prepared\./);
        assert.ok(switchNow, 'Switch now button');
        assert.equal(switches().length, 0);
    });
    const clickedAt = window.performance.now();
    click(switchNow);
    let ackAt = null;
    for ( let i = 0; i < 40 && ackAt === null; i++ ) {
        await tick(5);
        if ( card('cmp-4')?.dataset.state === 'switching' ) ackAt = window.performance.now();
    }
    check('🔴 bundle: acknowledged in under 200 ms while the request is still unanswered', () => {
        assert.ok(ackAt !== null && ackAt - clickedAt < 200, `ack after ${ackAt === null ? 'never' : Math.round(ackAt - clickedAt)} ms`);
        assert.equal(held !== null, true, 'the request is held open');
        assert.equal(pane().querySelector('[data-role="computer-chip"]')?.textContent, 'Switching to 4 vCPU');
        assert.equal(pane().querySelector('[data-role="now-label"]')?.textContent, 'Now: 2 vCPU · 8 GB');
        assert.equal(pane().querySelector('[data-role="next-label"]')?.textContent, 'Next: 4 vCPU · 16 GB');
    });
    click(card('cmp-8')?.querySelector('[data-action="switch-config"]'));
    await settle(4);
    check('🔴 bundle: a second click while pending sends no second request', () => {
        assert.equal(switches().length, 1);
        assert.equal(q('.window-alert-message'), null, 'no second confirmation');
    });
    const sent = switches()[0]?.body;
    check('bundle: the switch request carries computer, target and a well-formed requestId, kept in sessionStorage', () => {
        assert.equal(sent?.computerId, 'c-1');
        assert.equal(sent?.size, 'cmp-4');
        assert.match(sent?.requestId ?? '', /^[A-Za-z0-9_-]{8,64}$/);
        assert.equal(window.sessionStorage.getItem('ezil-os:switch.c-1.cmp-4'), sent?.requestId);
    });
    progress = running('m6i.large', { transition: { transitionId: 't-1', kind: 'switch', current: 'std-2', target: 'cmp-4', phase: 'waking', reason: null, revertAvailable: false },
        expectedSeconds: 150, openingStartedAt: '2026-10-28T10:00:00Z', observedAt: '2026-10-28T10:00:40Z', milestones: [{ key: 'requested', at: '2026-10-28T10:00:00Z' }, { key: 'host_claimed', at: '2026-10-28T10:00:30Z' }] });
    held({ ok: true, effective: 'switching', current: 'std-2', target: 'cmp-4', transitionId: 't-1' });
    await settle(10);
    check('bundle: after the answer, progress comes from the server milestones', () => {
        assert.equal(pane().querySelector('[data-step="3"]')?.dataset.state, 'active');
        assert.match(pane().querySelector('[data-step="2"]')?.textContent ?? '', /ready machine found/);
        const bar = pane().querySelector('[data-role="switch-progress"] [role="progressbar"]');
        assert.ok(Number(bar?.getAttribute('aria-valuenow')) < 100);
    });

    // A reload: close Settings and reopen. The state is the server's, and a
    // second request for the same target reuses the id.
    window.$('.window[data-app="settings"]').close();
    await settle(6);
    await openComputerTab();
    check('🔴 bundle: after a reload the switch is still shown from the server state', () => {
        assert.equal(card('cmp-4')?.dataset.state, 'switching');
        assert.equal(pane().querySelector('[data-role="next-label"]')?.textContent, 'Next: 4 vCPU · 16 GB');
        assert.equal(window.sessionStorage.getItem('ezil-os:switch.c-1.cmp-4'), sent?.requestId);
    });

    progress = running('m6i.xlarge', { transition: { transitionId: 't-1', kind: 'switch', current: 'std-2', target: 'cmp-4', phase: 'done', reason: null, revertAvailable: false } });
    data.computer.size = 'cmp-4';
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    check('bundle: done reads "Now running on 4 vCPU · 16 GB" with Open desktop, and the id is cleared', () => {
        assert.match(pane().querySelector('[data-role="switch-done"]')?.textContent ?? '', /Now running on 4 vCPU · 16 GB/);
        assert.ok(pane().querySelector('[data-role="switch-done"] [data-action="open"]'));
        assert.equal(card('cmp-4')?.dataset.state, 'current');
        assert.equal(window.sessionStorage.getItem('ezil-os:switch.c-1.cmp-4'), null);
    });

    // Hotfix r5 (ACCEPT #5): "Now running on …" is about a running computer; it clears once it is
    // stopping or stopped, while the server still reports the same done transition.
    const doneT = progress.transition;
    for ( const [label, next, chip] of [['Stopping…', { ...running('m6i.xlarge', { transition: doneT }), operation: 'stopping' }, null],
        ['Stopped', running('m6i.xlarge', { transition: doneT, lifecycleState: 'STOPPED' }), 'Stopped']] ) {
        progress = next;
        click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
        await settle(3);
        click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
        await settle();
        check(`🔴 bundle: the "Now running on" banner clears once the computer is ${label}`, () => {
            if ( chip ) assert.equal(pane().querySelector('[data-role="computer-chip"]')?.textContent.trim(), chip);
            assert.equal(pane().querySelector('[data-role="switch-done"]'), null);
            assert.doesNotMatch(pane().textContent, /Now running on/);
        });
    }

    // HF3: the placement is not on the pre-switch size (2 vCPU after cmp-4 → cmp-8), so "Back to" is offered.
    progress = running('m6i.large', { transition: { transitionId: 't-2', kind: 'switch', current: 'cmp-4', target: 'cmp-8', phase: 'failed', reason: 'capacity_unavailable', revertAvailable: true } });
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    check('bundle: a failed switch names the size it is on, with Back to <previous> and Try again', () => {
        assert.match(pane().querySelector('[data-role="switch-failed"]')?.textContent ?? '', /We couldn't switch to 8 vCPU · 32 GB\. Your computer is on 2 vCPU · 8 GB and your files are safe\./);
        assert.ok(pane().querySelector('[data-action="switch-retry"]'));
        assert.equal(pane().querySelector('[data-action="switch-back"]')?.textContent, 'Back to 4 vCPU · 16 GB');
    });
    window.sessionStorage.setItem('ezil-os:switch.c-1.cmp-4', 'stale-id-123');
    switchReply = { ok: true, effective: 'next_start', current: 'cmp-4', target: 'cmp-4', transitionId: 't-3' };
    click(pane().querySelector('[data-action="switch-back"]'));
    await settle(10);
    check('bundle: Back to <previous> is a fresh switch to the previous configuration, without a confirmation', () => {
        const back = switches().at(-1)?.body;
        assert.equal(back?.size, 'cmp-4');
        assert.notEqual(back?.requestId, 'stale-id-123');
        assert.notEqual(back?.requestId, sent?.requestId);
    });

    data = standard();
    progress = running();
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    check('bundle: Standard shows locked 4 and 8 vCPU with Premium and Upgrade', () => {
        assert.equal(card('cmp-4')?.dataset.state, 'locked');
        assert.match(card('cmp-8')?.textContent ?? '', /Premium\s*Upgrade/);
    });
    check('bundle: no uncaught page errors', () => assert.deepEqual(uncaught, []));
    dom.window.close();
}

for ( const line of results ) console.log(line);
const failed = results.filter(line => line.startsWith('FAIL')).length;
console.log(`\n${passed}/${results.length} Computer tab checks passed${bundleRan ? '' : ' (bundle part SKIPPED: no built bundle)'}; ${scanned.length} states scanned`);
process.exit(failed ? 1 : bundleRan ? 0 : 2);
