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
// Phase B: the one cap constant (the tab imports it; Part A stubs it with the real value) and the overlay's words.
import { MOVE_LIMIT_BYTES, moveTooLargeText } from '../computer-progress.js';
import { reverseMove, movingProgress, blockedProgress, terminalProgress, PHASES } from '../reverse-move-fixtures.mjs';

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
    .replace("import { TRANSITION_EVENT, MOVE_LIMIT_BYTES } from '../../computer-progress.js';", `const TRANSITION_EVENT = 'ezil:computer-transition', MOVE_LIMIT_BYTES = ${MOVE_LIMIT_BYTES};`);
assert.ok(! /^import /m.test(src), 'every import of the tab is stubbed');
const tab = await import(moduleUrl(src));
const { computerModel, computerHtml, switchSteps, switchRatio, switchRequestId, clearSwitchRequestId, refusalCopy, sizeForInstanceType, AWS_CAP_COPY, moveView, standingOf,
    moveCardCopy, moveTooLargeCopy, moveOfferCopy, moveRefusalCopy, moveSummaryLags, MOVE_NOT_MOVED } = tab;

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
    // Round 6 (R1-11): one provider string, "AWS (India)", on every tab.
    assert.equal(model.provider, 'AWS (India)');
    const html = scan(computerHtml(model, running(), []));
    assert.match(html, /<h3>Your computer<\/h3>/);
    assert.match(text(html), /2 vCPU · 8 GB memory · 50 GB disk/);
    assert.match(text(html), /50 GB disk for your projects/);
    // Round 5 (D6): the disk does not grow yet (growsOnSwitch false), and the tile names the weight.
    assert.match(text(html), /It keeps its size when you switch configuration\./);
    assert.match(text(html), /Counts 2× of your monthly time/);
    assert.equal((html.match(/data-action="switch-config"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-slot|New computer|Empty slot|data-action="create"|Add computer/);
});

// Follow-up r5 (ACCEPT-9a755827 FINDING 2): until this activation's `computer.progress` answers,
// the pane renders with `prog` null — and an unknown lifecycle is NEITHER Running nor Stopped.
check('🔴 AWS with no lifecycle read yet (prog null): no chip, not running, not stopped, no Stop, no "Stopped"', () => {
    for ( const data of [premium(), standard(), null] ) {
        const model = computerModel({ computer: me, data, prog: null });
        assert.equal(model.chip, null);
        assert.equal(model.running, false);
        assert.equal(model.stopped, false);
        assert.equal(model.busy, false);
        const html = scan(computerHtml(model, null, []));
        assert.doesNotMatch(html, /data-action="stop"/);
        assert.doesNotMatch(text(html), /Stopped|Running/);
    }
});

check('lifecycle chip follows the read: RUNNING → Running + Stop; STOPPED → Stopped, no Stop; stopping → Stopping…', () => {
    const run = computerModel({ computer: me, data: premium(), prog: running() });
    assert.equal(run.chip.text, 'Running');
    assert.match(computerHtml(run, running(), []), /data-action="stop"/);
    const stoppedProg = running('m6i.large', { lifecycleState: 'STOPPED' });
    const stopped = computerModel({ computer: me, data: premium(), prog: stoppedProg });
    assert.equal(stopped.chip.text, 'Stopped');
    assert.doesNotMatch(computerHtml(stopped, stoppedProg, []), /data-action="stop"/);
    const stoppingProg = running('m6i.large', { lifecycleState: 'STOPPING', operation: 'stopping' });
    const stopping = computerModel({ computer: me, data: premium(), prog: stoppingProg });
    assert.equal(stopping.chip.text, 'Stopping…');
    assert.doesNotMatch(computerHtml(stopping, stoppingProg, []), /data-action="stop"/);
});

check('Standard: 4 and 8 vCPU are locked with the plan that unlocks them, plus Upgrade', () => {
    const model = computerModel({ computer: me, data: standard(), prog: running() });
    assert.deepEqual(states(model), { 'std-2': 'current', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    const html = scan(computerHtml(model, running(), []));
    assert.equal((html.match(/data-role="config-locked"/g) ?? []).length, 2);
    assert.match(html, /Included in Premium<\/span><\/div>\s*<div class="ezil-computer-config-action"><a class="ezil-settings-btn ezil-computer-upgrade" data-action="config-upgrade" href="\/os\?settings=billing&amp;upgrade=premium">Upgrade<\/a>/);
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
    assert.equal(model.provider, 'AWS (India)');
});

check('Round 4 plan_ending: the end date and that nothing is deleted', () => {
    const data = withStanding(premium(), 'plan_ending', {}, { status: 'cancels', cancelsAt: ENDS, planEndsAt: ENDS });
    const html = scan(computerHtml(computerModel({ computer: me, data, prog: running() }), running(), []));
    assert.deepEqual(roles(html), ['plan-ending']);
    assert.match(text(html), /Premium ends on Nov 26, 2026\. After that your files stay on your AWS computer until they are moved to your Free computer; nothing is deleted\./);
});

// Round 6 (R1-08/R1-11/R4-02/CR-2): the founder's Computer tab on 10-30 — contact@ on Free, files held on
// AWS, a std-2 hold session Running. The running size is CURRENT (with Free limits), only 4/8 vCPU are locked.
const HELD_NOW = Date.parse('2026-10-30T05:44:00Z');
const heldData = (extra = {}) => withStanding({ ...free(), computer: { ...free().computer, size: 'std-2', vcpu: 2, memoryGiB: 8,
    activeDeadline: '2026-10-30T06:42:00Z', disk: { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false } } }, 'files_on_aws', extra);
const heldUsage = { enabled: true, version: 1, session: { computerId: 'c-1', state: 'stale' },
    period: { unit: 'standard_seconds', usedStandardSeconds: 8640, allowanceStandardSeconds: 28800, remainingStandardSeconds: 20160,
        currentSize: 'std-2', currentWeight: 1, remainingHoursAtCurrent: 5, equivalents: [] } };
const clock = iso => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
const card = (html, size) => html.match(new RegExp(`<li class="ezil-computer-config" data-size="${size}"[\\s\\S]*?</li>`))?.[0] ?? '';

check('Round 6 held std-2 Running: current with a Free limits pill, 4/8 vCPU locked as Premium, the hold in numbers and the session end', () => {
    const model = computerModel({ computer: me, data: heldData(), prog: running(), usage: heldUsage, now: HELD_NOW });
    assert.equal(model.held, true);
    assert.equal(model.heldClosed, false);
    assert.deepEqual(states(model), { 'std-2': 'current', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.equal(model.provider, 'AWS (India)');
    const html = scan(computerHtml(model, running(), []));
    assert.deepEqual(roles(html), ['files-held']);
    assert.match(text(html), /Your computer My computer AWS \(India\) Running/);
    assert.match(text(html), /2 vCPU · 8 GB memory · 50 GB disk/);
    assert.match(html, /<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open">Open desktop<\/button>/);
    assert.match(card(html, 'std-2'), /data-state="current"/);
    assert.match(card(html, 'std-2'), /data-role="config-current">Current<\/span><span class="ezil-settings-pill" data-role="config-free-limits">Free limits<\/span>/);
    assert.doesNotMatch(card(html, 'std-2'), /Included in|config-upgrade/);
    for ( const size of ['cmp-4', 'cmp-8'] ) assert.match(text(card(html, size)), /Included in Premium Upgrade/);
    assert.equal((html.match(/data-role="config-locked"/g) ?? []).length, 2);
    assert.doesNotMatch(html, /data-size="free-cf"|data-action="switch-config"|Included in Standard/);
    assert.match(text(html), /Your files are still on your AWS \(India\) computer\. It opens on the Free plan with Free limits; upgrade for no session time limit\./);
    assert.match(html, /data-role="hold-time">Free sessions last 1 hour · About 5 of 8 hours left this month<\/p>/);
    assert.match(text(html), new RegExp(`This session ends at ${clock('2026-10-30T06:42:00Z')} ?\\.`));
    assert.match(html, /<time datetime="2026-10-30T06:42:00Z">/);
    assert.doesNotMatch(text(html), /Pick a size|More sizes come with|restore full use/);
    assert.match(text(html), /On the Free plan your AWS computer opens at 2 vCPU · 8 GB\. Upgrade to choose a size\./);
    assert.match(text(html), /Standard and Premium have no session time limit; Premium unlocks 4 and 8 vCPU\. Compare plans/);
});

check('Round 6 held std-2: Stopped (no session end), no usage yet (no invented hours), a passed deadline (no line)', () => {
    const stopped = computerModel({ computer: me, data: heldData(), prog: stoppedAws(), usage: heldUsage, now: HELD_NOW });
    assert.equal(stopped.chip.text, 'Stopped');
    assert.deepEqual(states(stopped), { 'std-2': 'current', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    const stoppedHtml = scan(computerHtml(stopped, stoppedAws(), []));
    assert.doesNotMatch(stoppedHtml, /data-role="session-ends"/);
    assert.match(stoppedHtml, /About 5 of 8 hours left this month/);
    const unread = scan(computerHtml(computerModel({ computer: me, data: heldData(), prog: running(), usage: null, now: HELD_NOW }), running(), []));
    assert.match(unread, /data-role="hold-time">Free sessions last 1 hour<\/p>/);
    const late = computerModel({ computer: me, data: heldData(), prog: running(), usage: heldUsage, now: Date.parse('2026-10-30T06:42:30Z') });
    assert.equal(late.sessionEnds, null);
    assert.equal(computerModel({ computer: me, data: heldData(), prog: running(), usage: heldUsage, now: HELD_NOW, stopping: true }).sessionEnds, null);
    const under = computerModel({ computer: me, data: heldData(), prog: running(), now: HELD_NOW,
        usage: { ...heldUsage, period: { ...heldUsage.period, remainingStandardSeconds: 600, remainingHoursAtCurrent: 0 } } });
    assert.equal(under.holdLine, 'Free sessions last 1 hour · Less than an hour left this month');
});

check('Round 6 (R4-02) held 4 or 8 vCPU: no Open desktop, says it cannot open on Free, Upgrade; the size is current without Free limits', () => {
    for ( const [type, size, vcpu] of [['m6i.xlarge', 'cmp-4', 4], ['m6i.2xlarge', 'cmp-8', 8]] ) {
        const prog = stoppedAws(type);
        const model = computerModel({ computer: me, data: heldData(), prog, usage: heldUsage, now: HELD_NOW });
        assert.equal(model.heldClosed, true, type);
        assert.equal(model.current, size);
        assert.equal(model.holdLine, null);
        const html = scan(computerHtml(model, prog, []));
        assert.doesNotMatch(html, /data-action="open"/);
        assert.doesNotMatch(html, /ezil-settings-btn-primary/, 'D6: no primary stands in for Open desktop');
        assert.match(text(html), new RegExp(`Your files are still on your ${vcpu} vCPU AWS \\(India\\) computer\\. The Free plan can't open it at that size; upgrade to open it again\\.`));
        assert.match(html, /data-action="held-upgrade" href="\/os\?settings=billing&amp;upgrade=pro">Upgrade<\/a>/);
        assert.match(card(html, size), /data-state="current"/);
        assert.match(text(card(html, size)), /Can't open on Free/);
        assert.doesNotMatch(html, /config-free-limits|Free sessions last|It opens on the Free plan/);
        assert.match(text(card(html, 'std-2')), /Included in Standard Upgrade/);
        assert.match(text(html), new RegExp(`On the Free plan a ${vcpu} vCPU computer can't open\\. Upgrade to choose a size\\.`));
    }
});

check('Round 6: a held computer before the lifecycle read shows the size the hold opens (std-2), Open, no chip', () => {
    const model = computerModel({ computer: me, data: heldData(), prog: null, usage: null, now: HELD_NOW });
    assert.equal(model.chip, null);
    assert.equal(model.current, 'std-2');
    assert.equal(model.heldClosed, false);
    assert.equal(model.sessionEnds, null, 'not known to be running');
    const html = scan(computerHtml(model, null, []));
    assert.match(html, /data-action="open"/);
    assert.match(card(html, 'std-2'), /config-free-limits/);
});

check('Round 6 review (R4-02): before the lifecycle read a held computer is shown at its placed size (summary awsSize); the live hardware wins', () => {
    const placed8 = heldData({ awsSize: { size: 'cmp-8', vcpu: 8, memoryGiB: 32 } });
    const early = computerModel({ computer: me, data: placed8, prog: null, usage: null, now: HELD_NOW });
    assert.equal(early.current, 'cmp-8');
    assert.equal(early.heldClosed, true);
    const earlyHtml = scan(computerHtml(early, null, []));
    assert.doesNotMatch(earlyHtml, /data-action="open"/);
    assert.match(text(earlyHtml), /Your files are still on your 8 vCPU AWS \(India\) computer\. The Free plan can't open it at that size/);
    // The lifecycle read says 2 vCPU (a fresher answer than the summary's): it opens, with the open hold copy only.
    const live = computerModel({ computer: me, data: placed8, prog: running(), usage: heldUsage, now: HELD_NOW });
    assert.equal(live.current, 'std-2');
    assert.equal(live.heldClosed, false);
    const liveHtml = scan(computerHtml(live, running(), []));
    assert.match(liveHtml, /data-action="open"/);
    assert.match(text(liveHtml), /It opens on the Free plan with Free limits/);
    assert.doesNotMatch(text(liveHtml), /can't open/);
    // A malformed or unknown placed size falls back to the size the hold opens.
    for ( const awsSize of [null, { size: 'm6i.large' }, { size: 'free-cf', vcpu: 2, memoryGiB: 6 }] )
        assert.equal(computerModel({ computer: me, data: heldData({ awsSize }), prog: null, now: HELD_NOW }).current, 'std-2', JSON.stringify(awsSize));
});

check('Round 6: a Free session on Cloudflare also says when it ends; a paid session (no cap) never does', () => {
    const cf = { ...free(), computer: { ...free().computer, activeDeadline: '2026-10-30T06:42:00Z' } };
    const model = computerModel({ computer: me, data: cf, prog: { version: 2, computerId: 'c-1', operation: 'none', lifecycleState: null }, streaming: true, now: HELD_NOW });
    assert.match(scan(computerHtml(model, null, [])), /data-role="session-ends"/);
    // Review: a deadline read for an earlier session (the desktop was seen closed since) is never shown for a new one.
    for ( const [data, prog, streaming] of [[cf, { version: 2, computerId: 'c-1', operation: 'none', lifecycleState: null }, true], [heldData(), running(), false]] ) {
        const stale = computerModel({ computer: me, data, prog, streaming, usage: heldUsage, now: HELD_NOW, deadlineStale: true });
        assert.equal(stale.sessionEnds, null);
        assert.doesNotMatch(scan(computerHtml(stale, prog, [])), /data-role="session-ends"/);
    }
    const paid = { ...premium(), computer: { ...premium().computer, activeDeadline: '2026-10-30T06:42:00Z' } };
    assert.equal(computerModel({ computer: me, data: paid, prog: running(), now: HELD_NOW }).sessionEnds, null);
});

check('Round 6 review (CR-2): sessionReads — the session edges re-read the deadline and the hold\'s hours, bounded', () => {
    const { sessionReads } = tab;
    const base = { sawRunning: true, held: true, capped: true, hasDeadline: true, stale: false, retries: 0 };
    // Not running: nothing read, the re-reads re-armed; a held session that just ended re-reads the hours left.
    assert.deepEqual(sessionReads({ ...base, runningNow: false }), { summary: false, usage: true, retries: 2 });
    assert.deepEqual(sessionReads({ ...base, runningNow: false, sawRunning: false }), { summary: false, usage: false, retries: 2 });
    assert.deepEqual(sessionReads({ ...base, runningNow: false, held: false }), { summary: false, usage: false, retries: 2 });
    // The session started (deadline retired): the summary, and under the hold the hours; no retry spent.
    assert.deepEqual(sessionReads({ ...base, runningNow: true, sawRunning: false, stale: true, retries: 2 }), { summary: true, usage: true, retries: 2 });
    assert.deepEqual(sessionReads({ ...base, runningNow: true, sawRunning: false, stale: true, held: false, retries: 2 }), { summary: true, usage: false, retries: 2 });
    // Running with no deadline yet: asked again while re-reads are left, then never.
    assert.deepEqual(sessionReads({ ...base, runningNow: true, hasDeadline: false, retries: 2 }), { summary: true, usage: true, retries: 1 });
    assert.deepEqual(sessionReads({ ...base, runningNow: true, hasDeadline: false, retries: 1 }), { summary: true, usage: true, retries: 0 });
    assert.deepEqual(sessionReads({ ...base, runningNow: true, hasDeadline: false, retries: 0 }), { summary: false, usage: false, retries: 0 });
    // A known deadline, or an uncapped (paid) session: nothing to read.
    assert.deepEqual(sessionReads({ ...base, runningNow: true, retries: 2 }), { summary: false, usage: false, retries: 2 });
    assert.deepEqual(sessionReads({ ...base, runningNow: true, capped: false, stale: true, hasDeadline: false, retries: 2 }), { summary: false, usage: false, retries: 2 });
});

check('Round 4: after grace the plan block may still describe the past_due paid plan; the standing decides the card', () => {
    const lapsed = withStanding(premium(), 'files_on_aws', {}, { status: 'past_due', paymentIssue: 'payment_failed' });
    const held = computerModel({ computer: me, data: lapsed, prog: stoppedAws() });
    assert.equal(held.held, true);
    // Round 6: the held std-2 is current; only the sizes the hold cannot open are locked.
    assert.deepEqual(states(held), { 'std-2': 'current', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.ok(! /data-action="switch-config"/.test(computerHtml(held, stoppedAws(), [])));
    // Round 6 review: the server rates a lapsed plan's computer as Free (1-hour sessions, Free's month), so the hold
    // line and the session end show for a dunning hold exactly as for an immediate cancel.
    // The server's shape for that state: the Premium plan block with Free's session cap, machine choice and opening.
    const lapsedRunning = withStanding({ ...premium(), computer: { ...premium().computer, size: 'std-2', vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 3600,
        opening: free().computer.opening, machineChoice: free().computer.machineChoice, activeDeadline: '2026-10-30T06:42:00Z' } },
        'files_on_aws', {}, { status: 'past_due', paymentIssue: 'payment_failed' });
    const dunning = computerModel({ computer: me, data: lapsedRunning, prog: running(), usage: heldUsage, now: HELD_NOW });
    assert.deepEqual(states(dunning), { 'std-2': 'current', 'cmp-4': 'locked', 'cmp-8': 'locked' });
    assert.equal(dunning.holdLine, 'Free sessions last 1 hour · About 5 of 8 hours left this month');
    assert.equal(dunning.sessionEnds, '2026-10-30T06:42:00Z');
    const dunningHtml = scan(computerHtml(dunning, running(), []));
    assert.match(dunningHtml, /data-role="session-ends"/);
    assert.match(card(dunningHtml, 'std-2'), /config-free-limits/);
    assert.match(text(dunningHtml), /On the Free plan your AWS computer opens at 2 vCPU · 8 GB\. Upgrade to choose a size\./);
    assert.doesNotMatch(dunningHtml, /data-action="switch-config"|data-size="free-cf"/);
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

// ── Phase B (reverse move contract §6.1-§6.4): the Computer tab before, during and after a move ─────────────
const SIZE = { 'std-2': { size: 'std-2', vcpu: 2, memoryGiB: 8 }, 'cmp-4': { size: 'cmp-4', vcpu: 4, memoryGiB: 16 }, 'cmp-8': { size: 'cmp-8', vcpu: 8, memoryGiB: 32 } };
const held = (extra = {}, size = 'std-2') => withStanding(free(), 'files_on_aws', { awsSize: SIZE[size], reverseMove: null, moveAvailable: false, moveOnOpen: false, ...extra });
const afterCommit = extra => withStanding(free(), 'free', { filesOn: 'cloudflare', reverseMove: null, moveAvailable: false, moveOnOpen: false, ...extra });
const tabProg = data => ({ ...data, computerId: 'c-1' });
const render = (data, prog = stoppedAws()) => { const model = computerModel({ computer: me, data, prog }); return { model, html: scan(computerHtml(model, prog, [])) }; };
const BANNER = 'Your files are still on your AWS (India) computer. It opens on the Free plan with Free limits; upgrade for no session time limit.';
const NOT_MOVED = 'settings and programs you added on your AWS computer, saved browser sign-ins, installed packages, and build folders you can recreate (node_modules, .next, .turbo and dist, unless Git tracks them)';
const KEPT = `Not moved: ${NOT_MOVED}. Your AWS computer's disk is kept for 14 days after the move.`;

check('Phase B: the move card reads summary.computer.reverseMove only; computer.move (kept null for old shells) is never rendered', () => {
    for ( const move of [null, undefined, { direction: 'to_aws', stage: 'exporting', bytesDone: '1', bytesTotal: '2' }] ) assert.equal(moveView(move), null);
    for ( const stage of ['saving', 'copying', 'failed_reopened', 'failed_needs_operator', 'committed'] ) {
        const legacy = { direction: 'to_cloudflare', stage, bytesDone: '1', bytesTotal: '2', reason: 'copy_stalled', openBlocked: true };
        const { model, html } = render(held({ move: legacy }));
        assert.ok(! /data-role="move-/.test(html), stage);
        assert.equal(model.moving || model.blocked, false, stage);
        assert.doesNotMatch(html, /data-action="move-retry"/);
    }
    assert.equal(NOT_MOVED, MOVE_NOT_MOVED);
});

check('Phase B: MOVE_STEP_OF keeps the keys lane A reads; step 4 says "Switching to your Free computer"', () => {
    const src = fs.readFileSync(new URL('./tabs/computers.js', import.meta.url), 'utf8');
    const table = src.match(/const MOVE_STEP_OF = \{([^}]+)\}/)?.[1];
    const steps = Object.fromEntries(table.split(',').map(entry => entry.split(':').map(part => part.trim())));
    assert.deepEqual(['saving', 'copying', 'checking', 'flipping'].map(s => steps[s]), ['0', '1', '2', '3']);
    const { html } = render(held({ reverseMove: reverseMove({ stage: 'flipping' }) }));
    assert.match(html, /<li data-step="4" data-state="active">Switching to your Free computer<\/li>/);
    assert.doesNotMatch(html, /Starting your desktop/);
    assert.match(src, /import \{ TRANSITION_EVENT, MOVE_LIMIT_BYTES \} from '\.\.\/\.\.\/computer-progress\.js';/, 'the cap comes from computer-progress.js');
    assert.doesNotMatch(src, /5(12|37) MB/, 'no literal cap in the tab');
});

const STEP_TEXT = { saving: 'Step 1 of 4: Saving your files.', copying: 'Step 2 of 4: Copying your files to your Free computer.',
    checking: 'Step 3 of 4: Checking your files.', flipping: 'Step 4 of 4: Switching to your Free computer.' };
// Every progress read the tab can hold during a move: the moving view (lifecycleState null), a stale read from
// before it (STOPPED, MOUNTING opening, RUNNING), none yet.
const STALE = [null, stoppedAws(), running('m6i.large', { lifecycleState: 'MOUNTING', operation: 'opening', stage: 'mounting' }), running(), running('m6i.large', { lifecycleState: 'UNCONFIRMED', needsOperator: true, stage: 'needs_operator' })];
for ( const [stage, sentence] of Object.entries(STEP_TEXT) ) {
    check(`Phase B in flight (${stage}): chip "Moving files…", the move card only, no Open/Stop/Start now, Delete disabled — with every progress read`, () => {
        const data = held({ reverseMove: reverseMove({ stage, bytesDone: stage === 'copying' ? '120000000' : '0', bytesTotal: stage === 'saving' ? null : '2400000000' }),
            moveAvailable: true, moveOnOpen: true, sessionMaxSeconds: 3600, activeDeadline: '2999-01-01T00:00:00Z' });
        const phase = Object.keys(PHASES).find(p => ({ export_boot: 'saving', exporting: 'saving', importing: 'copying', checking: 'checking', committing: 'flipping' })[p] === stage);
        for ( const prog of [...STALE, tabProg(movingProgress({ phase, bytesDone: stage === 'copying' ? 120_000_000 : undefined, bytesTotal: stage === 'saving' ? null : 2_400_000_000 }))] ) {
            const { model, html } = render(data, prog);
            const label = prog?.lifecycleState ?? prog?.operation ?? 'none';
            assert.deepEqual(model.chip, { state: 'moving', text: 'Moving files…' }, label);
            assert.equal(model.busy, true, label);
            assert.ok(html.includes('data-role="move-progress"'), label);
            assert.match(text(html), new RegExp(`Moving your files to your Free computer ${sentence.replace(/\./g, '\\.')}`), label);
            if ( stage === 'copying' ) assert.match(text(html), /120 MB of 2\.4 GB copied/, label);
            assert.doesNotMatch(html, /data-action="(open|stop|move-start|move-retry|switch-config)"/, label);
            assert.match(html, /data-action="delete" hidden disabled/, label);
            assert.doesNotMatch(html, /data-role="(files-held|hold-time|session-ends|move-offer|switch-progress|switch-done|switch-failed|next-start)"/, label);
            assert.doesNotMatch(text(html), /Now running|Stopped|Running|Starting…/, label);
            assert.equal(model.provider, 'AWS (India)');
        }
    });
}

check('Phase B: a move from an open in another window (progress moving, reverseMove still null) shows from computer.progress, live bytes', () => {
    for ( const [phase, sentence] of [['export_boot', STEP_TEXT.saving], ['importing', STEP_TEXT.copying], ['committing', STEP_TEXT.flipping]] ) {
        const prog = tabProg(movingProgress({ phase }));
        const data = held({ moveAvailable: true });
        const { model, html } = render(data, prog);
        assert.equal(model.chip.text, 'Moving files…');
        assert.match(text(html), new RegExp(sentence.replace(/\./g, '\\.')));
        if ( phase === 'importing' ) assert.match(text(html), /120 MB of 0\.4 GB copied/);
        assert.equal(moveSummaryLags(prog, data), true, 'the tab re-reads the summary');
        assert.equal(moveSummaryLags(prog, held({ reverseMove: reverseMove({ stage: 'copying' }) })), false);
        assert.doesNotMatch(html, /data-role="move-offer"|data-action="open"/);
    }
    assert.equal(moveSummaryLags(tabProg(terminalProgress({ outcome: 'committed' })), held({ reverseMove: reverseMove({ stage: 'flipping' }) })), true, 'ended, summary behind');
    assert.equal(moveSummaryLags(stoppedAws(), held()), false);
    assert.equal(moveSummaryLags(null, null), false);
});

check('Phase B open blocked: chip "Needs attention", no Open, the needs-attention card (summary or progress), no Try again', () => {
    for ( const [data, prog] of [
        [held({ reverseMove: reverseMove({ stage: 'failed_needs_operator', reason: 'flip_stuck', retry: 'no', openBlocked: true }) }), stoppedAws()],
        [held({ reverseMove: reverseMove({ stage: 'failed_needs_operator', reason: 'flip_stuck', retry: 'no', openBlocked: true }) }), tabProg(blockedProgress())],
        [held(), tabProg(blockedProgress())],
        [held({ reverseMove: reverseMove({ stage: 'flipping' }) }), tabProg(blockedProgress())],
    ] ) {
        const { model, html } = render(data, prog);
        assert.deepEqual(model.chip, { state: 'attention', text: 'Needs attention' });
        assert.equal(model.blocked, true);
        assert.doesNotMatch(html, /data-action="(open|stop|move-retry|move-start)"/);
        assert.ok(html.includes('data-role="move-attention"'));
        assert.match(text(html), /We're finishing moving your files to your Free computer\. Your files are safe and nothing was deleted\. Your computer can't open until we've checked this; we're looking into it\./);
        assert.match(html, /data-action="move-feedback"/);
        assert.doesNotMatch(html, /data-role="files-held"/);
    }
    const unsettled = render(held({ reverseMove: reverseMove({ stage: 'failed_needs_operator', reason: 'boot_unsettled', retry: 'no', openBlocked: true }) })).html;
    assert.match(text(unsettled), /We couldn't finish moving your files\. They're safe on your AWS computer and nothing was deleted\. Your computer can't open until we've checked it; we're looking into it\./);
});

// §6.3 every terminal row, with every stage/lifecycle the row's progress can carry (§5.10: the placement's own).
const failedRow = (reason, retry, holdOpenable = true, stage = 'failed_reopened') => reverseMove({ stage, reason, retry, holdOpenable });
const ROWS = [
    ['default reopen, Try again', failedRow('copy_stalled', 'now'), "We couldn't move your files. They're still on your AWS computer and nothing was deleted.", { retry: true }],
    ['workspace_too_large, after an AWS session', failedRow('workspace_too_large', 'after_aws_session'),
        'Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Remove some files on your AWS computer and try again, or upgrade to keep using them.', { upgrade: true }],
    ['workspace_too_large, Try again now', failedRow('workspace_too_large', 'now'), null, { upgrade: true, retry: true }],
    ['workspace_too_large, hold cannot open', failedRow('workspace_too_large', 'no', false),
        'Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Upgrade to use them again.', { upgrade: true }],
    ['kill_switch (try later)', failedRow('kill_switch', 'now'), "We couldn't start moving your files right now. They're still on your AWS computer and nothing was deleted. Try again later.", { retry: true }],
    ['boot_unavailable (try later)', failedRow('boot_unavailable', 'now'), "We couldn't start moving your files right now. They're still on your AWS computer and nothing was deleted. Try again later.", { retry: true }],
    ['entitlement_paid', failedRow('entitlement_paid', 'no'), 'Your plan is active again, so your files stay on your AWS computer.', {}],
    ['region_missing', failedRow('region_missing', 'no'), "We couldn't move your files. They're still on your AWS computer and nothing was deleted. This computer needs a fix on our side before it can open or move; we're looking into it.", {}],
    ['reopen_final', failedRow('head_moved', 'no'), "We couldn't move your files. They're still on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it.", {}],
    ['reopen_final, hold cannot open', failedRow('worker_conflict', 'no', false), "We couldn't move your files. They're still on your AWS computer and nothing was deleted. We're looking into it.", {}],
    ['abort_unconfirmed (open works)', failedRow('abort_unconfirmed', 'no', true, 'failed_needs_operator'),
        "We couldn't finish moving your files. They're safe on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it.", { feedback: true }],
    ['abort_unconfirmed, hold cannot open', failedRow('abort_unconfirmed', 'no', false, 'failed_needs_operator'),
        "We couldn't finish moving your files. They're safe on your AWS computer and nothing was deleted. We're looking into it.", { feedback: true }],
];
for ( const [label, row, want, actions] of ROWS ) {
    check(`Phase B §6.3 ${label}: the row's copy and only its actions, whatever stage the progress read says`, () => {
        for ( const prog of [stoppedAws(), running(), running('m6i.large', { lifecycleState: 'UNCONFIRMED', needsOperator: true, stage: 'needs_operator' }), null,
            tabProg(terminalProgress({ outcome: row.stage, reason: row.reason, retry: row.retry, holdOpenable: row.holdOpenable, stage: 'stopped' }))] ) {
            const { model, html } = render(held({ reverseMove: row, moveAvailable: row.retry === 'now' }, row.holdOpenable === false ? 'cmp-8' : 'std-2'), prog);
            const card = html.split(/data-role="move-(failed|attention)"/)[2]?.split('</div></div>')[0] ?? '';
            if ( want ) assert.match(text(html), new RegExp(want.replace(/[.()?]/g, '\\$&')), `${label} / ${prog?.stage}`);
            assert.equal(/data-action="move-retry"/.test(card), !! actions.retry, `${label}: Try again only when retry is 'now'`);
            assert.equal(/data-action="move-upgrade"/.test(card), !! actions.upgrade, `${label}: Upgrade`);
            assert.equal(/data-action="move-feedback"/.test(card), !! actions.feedback, `${label}: Send feedback`);
            assert.doesNotMatch(card, /data-action="(open|move-start)"/);
            assert.equal(model.moving, false);
            assert.doesNotMatch(html, /data-role="move-offer"/, 'a failed row has its own card, never the pre-move one');
            assert.notEqual(model.chip?.text, 'Moving files…');
        }
    });
}

check('Phase B §6.3 committed: the files are on the Free computer, what was not moved, the skipped items, the retained disk date', () => {
    const at = '2026-11-13T10:00:00.000Z';
    const done = n => render(afterCommit({ reverseMove: reverseMove({ stage: 'committed', bytesDone: '400000000', bytesTotal: '400000000', skipped: n, retainUntil: at }) }), null).html;
    assert.equal(text(done(0)).match(/Your files are on your Free computer\.[^]*?kept until [A-Z][a-z]{2} \d+, \d{4}\./)?.[0],
        `Your files are on your Free computer. Not moved: ${NOT_MOVED}. Your AWS disk is kept until Nov 13, 2026.`);
    assert.match(text(done(3)), new RegExp(`Not moved: ${NOT_MOVED.replace(/[.()]/g, '\\$&')}, and 3 items that can't be copied, like links that point outside your Workspace folder\\. Your AWS disk is kept until Nov 13, 2026\\.`));
    assert.match(text(done(1)), /, and 1 item that can't be copied, like links that point outside your Workspace folder\./);
    const html = done(0);
    assert.ok(html.includes('data-role="move-done"'));
    assert.doesNotMatch(html.split('data-role="move-done"')[1].split('</div>')[0], /data-action="open"/, 'Open desktop is the header\'s only');
    assert.match(html, /data-role="computer-actions">\s*<button[^>]*data-action="open"/);
    assert.equal(moveCardCopy(moveView(reverseMove({ stage: 'committed', retainUntil: null }))).text, `Your files are on your Free computer. Not moved: ${NOT_MOVED}.`);
});

check('Phase B pre-move (§6.3): moveAvailable false keeps 6a\'s banner exactly; true adds the card, its variant chosen by moveOnOpen', () => {
    const plain = render(held()).html;
    assert.equal(text(plain.match(/<div[^>]*data-role="files-held"[^>]*>[\s\S]*?<\/div>/)[0]).replace(/ Free sessions[^]*$/, ''), BANNER);
    assert.doesNotMatch(text(plain), /Move my files|Workspace folder|14 days|Opening it uses/);
    assert.doesNotMatch(plain, /data-role="move-|data-action="move-/);
    const onOpen = render(held({ moveAvailable: true, moveOnOpen: true })).html;
    assert.match(text(onOpen), new RegExp(`Your files are on your AWS computer\\. The next time you open your computer, we'll first move the files in your Workspace folder to your Free computer\\. ${KEPT.replace(/[.()']/g, '\\$&')} Move my files now`));
    assert.match(onOpen, /data-action="move-start">Move my files now<\/button>/);
    assert.ok(onOpen.includes(BANNER.replace(/'/g, '&#39;')), '6a\'s banner stays');
    const later = render(held({ moveAvailable: true, moveOnOpen: false })).html;
    assert.match(text(later), new RegExp(`Your files are on your AWS computer\\. Opening it uses your Free limits\\. You can move the files in your Workspace folder to your Free computer\\. ${KEPT.replace(/[.()']/g, '\\$&')} Move my files to my Free computer`));
    assert.match(later, /data-action="move-start">Move my files to my Free computer<\/button>/);
    for ( const html of [onOpen, later] ) assert.match(html, /<button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open">Open desktop<\/button>/);
});

check('Phase B pre-move, held closed (6a\'s card first, then the move; never the next-open variant, never "Opening it uses your Free limits")', () => {
    for ( const size of ['cmp-4', 'cmp-8'] ) {
        for ( const moveOnOpen of [false, true] ) {
            const { html } = render(held({ moveAvailable: true, moveOnOpen }, size), stoppedAws(size === 'cmp-4' ? 'm6i.xlarge' : 'm6i.2xlarge'));
            const card = text(html.match(/<div[^>]*data-role="files-held"[\s\S]*?<\/div><\/div>/)[0]);
            const vcpu = SIZE[size].vcpu;
            assert.ok(card.startsWith(`Your files are still on your ${vcpu} vCPU AWS (India) computer. The Free plan can't open it at that size; upgrade to open it again. Upgrade You can move the files in your Workspace folder to your Free computer. ${KEPT} Move my files to my Free computer`), card);
            assert.doesNotMatch(text(html), /Opening it uses your Free limits|The next time you open|Move my files now/);
            assert.doesNotMatch(html, /data-action="open"/);
            assert.doesNotMatch(html, /data-role="move-offer" role/, 'no second card');
        }
        const closed = render(held({}, size), stoppedAws(size === 'cmp-4' ? 'm6i.xlarge' : 'm6i.2xlarge')).html;
        assert.doesNotMatch(text(closed), /Move my files|Workspace folder/, 'moveAvailable false: 6a\'s card unchanged');
    }
});

check('Phase B: "537 MB" is MOVE_LIMIT_BYTES in the shell\'s MB unit, the same words on the overlay and the tab', () => {
    assert.equal(MOVE_LIMIT_BYTES, 536_870_912);
    for ( const h of [true, false, null] ) assert.equal(moveTooLargeCopy(h), moveTooLargeText(h));
    assert.match(moveTooLargeCopy(true), /\(537 MB\)/);
});

check('Phase B start/retry refusals (§6.3): stop first, try later, or no card (the re-read summary shows the truth)', () => {
    assert.deepEqual(moveRefusalCopy('move_computer_running'), { lead: 'Your AWS computer is open.',
        text: 'Stop it first, and your files start moving to your Free computer as soon as it has stopped.', action: 'stop-and-move' });
    for ( const reason of ['move_paused', 'move_busy', 'move_computer_unsettled', 'error'] ) {
        assert.equal(moveRefusalCopy(reason).text, "We can't start moving your files right now. They're still on your AWS computer and nothing was deleted. Try again later.");
        assert.equal(moveRefusalCopy(reason).action, 'try-again');
    }
    for ( const reason of ['move_in_progress', 'move_unavailable', 'move_not_held', 'move_unsupported'] ) assert.equal(moveRefusalCopy(reason), null);
    for ( const copy of [moveRefusalCopy('move_computer_running'), moveRefusalCopy('move_busy'), moveOfferCopy({ onOpen: true }), moveOfferCopy(), moveOfferCopy({ lead: false })] ) {
        scanned.push(`<p>${copy.lead ?? ''} ${copy.text}</p>`);
    }
});

check('Round 4/6: every rendered state passes the copy guard and names no region code or city (R1-11: never "Mumbai")', () => {
    for ( const html of scanned ) {
        assert.doesNotMatch(text(html), honestyBans);
        assert.doesNotMatch(text(html), /ap-south-1/i);
        assert.doesNotMatch(text(html), /mumbai/i);
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
    let data = premium(), progress = running(), switchReply = null, held = null, usageData = null;
    // Phase B: `computer.move.start`/`retry` answers (in order) and the stop route's answer; the move section turns on
    // fast 5 s timers (the move's poll and the stop watch).
    let moveReplies = [], stopReply = { ok: true, terminated: true }, fastFive = false;
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, fastFive && ms === 5000 ? 30 : ms, ...args);
    window.fetch = async (url, opts = {}) => {
        const u = String(url);
        const call = { url: u, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, at: window.performance.now() };
        calls.push(call);
        const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
        if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: [me] } } });
        if ( u.includes('/api/trpc/billing.summary') ) return json({ result: { data: { json: data } } });
        if ( u.includes('/api/trpc/billing.history') ) return json({ result: { data: { json: [] } } });
        if ( u.includes('/api/trpc/computer.progress') ) return json({ result: { data: { json: progress } } });
        if ( u.includes('/api/trpc/billing.usage') && usageData ) return json({ result: { data: { json: usageData } } });
        if ( u.endsWith('/api/shell/switch') ) {
            if ( switchReply ) return json(switchReply);
            return new Promise(resolve => { held = body => resolve(json(body)); });
        }
        if ( u.includes('/api/trpc/computer.move.') ) return json({ result: { data: { json: moveReplies.shift() ?? { ok: false, reason: 'move_busy' } } } });
        if ( u.endsWith('/api/shell/stop') ) return json(typeof stopReply === 'function' ? stopReply() : stopReply);
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
    // Round 5 (D6): the confirmation is the sheet frame, not the legacy UIAlert.
    const sheet = q('[role="dialog"][data-sheet="confirm-switch"]');
    const confirmText = sheet?.textContent ?? '';
    const switchNow = sheet?.querySelector('[data-action="confirm"]');
    check('bundle: Switch on a RUNNING computer confirms first in the sheet frame with the brief copy, and sends nothing yet', () => {
        assert.ok(sheet, 'sheet-frame dialog');
        assert.equal(sheet.getAttribute('aria-modal'), 'true');
        assert.ok(sheet.closest('.ezil-upgrade-backdrop'));
        assert.equal(q('.window-alert-message'), null, 'no legacy alert');
        assert.match(confirmText, /Switch to 4 vCPU · 16 GB\?/);
        assert.match(confirmText, /Your computer restarts on the new size\. Open apps close; save your work first\./);
        assert.match(confirmText, /Your files stay on your disk\./);
        assert.match(confirmText, /This usually takes 1-4 minutes\./);
        assert.match(confirmText, /At this size, an hour of use counts as 2 hours of your monthly time\./);
        assert.equal(switchNow?.textContent, 'Restart and switch');
        assert.ok(switchNow?.classList.contains('ezil-settings-btn-primary'));
        assert.ok(sheet.querySelector('[data-action="cancel"]'));
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
        assert.equal(switchNow.disabled, true, 'the primary is disabled while the request is in flight');
        assert.equal(switchNow.textContent, 'Starting switch…');
        assert.equal(pane().querySelector('[data-role="computer-chip"]')?.textContent, 'Switching to 4 vCPU');
        assert.equal(pane().querySelector('[data-role="now-label"]')?.textContent, 'Now: 2 vCPU · 8 GB');
        assert.equal(pane().querySelector('[data-role="next-label"]')?.textContent, 'Next: 4 vCPU · 16 GB');
    });
    click(card('cmp-8')?.querySelector('[data-action="switch-config"]'));
    await settle(4);
    check('🔴 bundle: a second click while pending sends no second request', () => {
        assert.equal(switches().length, 1);
        assert.equal(qa('[role="dialog"][data-sheet^="confirm-"]').length, 1, 'no second confirmation');
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
    check('bundle: the confirmation closes once the server answers', () => assert.equal(q('[role="dialog"][data-sheet="confirm-switch"]'), null));
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
        // One primary per state (D6): Open desktop is the header's, not repeated in the done box.
        assert.equal(pane().querySelector('[data-role="switch-done"] [data-action="open"]'), null);
        assert.equal(pane().querySelectorAll('.ezil-settings-btn-primary').length, 1);
        assert.ok(pane().querySelector('[data-role="computer-actions"] [data-action="open"].ezil-settings-btn-primary'));
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
    // Review (hotfix r5): cleared means dismissed — a later Start, with the server still reporting the
    // same done transition, must not bring "Now running on …" back.
    progress = running('m6i.xlarge', { transition: doneT });
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    check('🔴 bundle: after Stop then Start, the same done transition does not bring "Now running on" back', () => {
        assert.equal(pane().querySelector('[data-role="computer-chip"]')?.textContent.trim(), 'Running');
        assert.equal(pane().querySelector('[data-role="switch-done"]'), null);
        assert.doesNotMatch(pane().textContent, /Now running on/);
    });

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
        assert.match(card('cmp-8')?.textContent ?? '', /Included in Premium\s*Upgrade/);
        assert.ok(card('cmp-8')?.querySelector('[data-action="config-upgrade"].ezil-computer-upgrade'));
    });
    const usageReads = () => calls.filter(c => c.url.includes('/api/trpc/billing.usage'));
    const summaryReads = () => calls.filter(c => c.url.includes('/api/trpc/billing.summary'));
    check('bundle: Round 6: a paid computer never reads billing.usage from the Computer tab', () => assert.equal(usageReads().length, 0));

    // Round 6 (R1-08/CR-2): the founder's held std-2, on the real click path. A session that starts while the pane is
    // open (STARTING → RUNNING) re-reads the summary (its deadline) and usage (the hours left) once.
    data = heldData(); data.computer.activeDeadline = new Date(Date.now() + 40 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    usageData = { ...heldUsage, asOf: new Date().toISOString() };
    progress = running('m6i.large', { lifecycleState: 'STARTING', operation: 'opening' });
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    check('bundle: Round 6 held std-2: current with Free limits, 4/8 vCPU locked, AWS (India), the hold line from billing.usage', () => {
        assert.equal(card('std-2')?.dataset.state, 'current');
        assert.ok(card('std-2')?.querySelector('[data-role="config-free-limits"]'));
        assert.equal(card('cmp-4')?.dataset.state, 'locked');
        assert.equal(pane()?.querySelector('[data-role="computer-provider"]')?.textContent, 'AWS (India)');
        assert.equal(pane()?.querySelector('[data-role="hold-time"]')?.textContent, 'Free sessions last 1 hour · About 5 of 8 hours left this month');
        const read = usageReads().at(-1);
        assert.ok(read, 'billing.usage was read');
        assert.match(decodeURIComponent(read.url), /"computerId":"c-1"/);
        assert.equal(pane()?.querySelector('[data-role="session-ends"]'), null, 'not running yet');
    });
    const before = { summaries: summaryReads().length, usage: usageReads().length };
    progress = running();
    await settle(25, 200); // the opening poll is 3 s
    check('bundle: Round 6 held: the session starting re-reads the deadline and the hours once, and shows when it ends', () => {
        assert.equal(summaryReads().length, before.summaries + 1);
        assert.equal(usageReads().length, before.usage + 1);
        assert.match(pane()?.querySelector('[data-role="session-ends"]')?.textContent ?? '', /^This session ends at .+\.$/);
        assert.ok(pane()?.querySelector('[data-action="open"]'));
    });
    // Review: a session whose deadline is not there yet (its epoch opens just after RUNNING) is asked again on
    // fast polls, at most twice more, and never again after that.
    data = heldData(); data.computer.activeDeadline = null;
    progress = running('m6i.large', { lifecycleState: 'STARTING', operation: 'opening' });
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    const late = summaryReads().length;
    progress = running();
    await settle(60, 200); // the opening poll (3 s), then two fast re-read polls (3 s each)
    check('bundle: Round 6 review held: a deadline missing at the start is asked again twice (fast polls), then not again', () => {
        assert.equal(summaryReads().length, late + 3);
        assert.equal(pane()?.querySelector('[data-role="session-ends"]'), null);
    });
    progress = stoppedAws('m6i.xlarge');
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
    await settle(3);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle();
    check('bundle: Round 6 (R4-02) held 4 vCPU: no Open desktop; it says so with Upgrade', () => {
        assert.equal(pane()?.querySelector('[data-action="open"]'), null);
        assert.match(pane()?.querySelector('[data-role="files-held"]')?.textContent ?? '', /The Free plan can't open it at that size/);
        assert.ok(pane()?.querySelector('[data-role="files-held"] [data-action="held-upgrade"]'));
        assert.doesNotMatch(pane()?.textContent ?? '', /mumbai/i);
    });

    // ── Phase B (reverse move contract §6.2): the move's actions on the real click path ─────────────────────
    fastFive = true;
    const reopen = async () => {
        click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="about"]'));
        await settle(3);
        click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
        await settle();
    };
    const moves = () => calls.filter(c => c.url.includes('/api/trpc/computer.move.'));
    const stops = () => calls.filter(c => c.url.endsWith('/api/shell/stop'));
    const role = name => pane()?.querySelector(`[data-role="${name}"]`);
    const heldMove = (extra = {}) => { const d = heldData(); Object.assign(d.computer, { reverseMove: null, moveAvailable: true, moveOnOpen: false, activeDeadline: null }, extra); return d; };
    const startedMove = stage => ({ ok: true, move: reverseMove({ stage }) });

    data = heldMove(); progress = { ...stoppedAws(), stage: 'stopped' };
    await reopen();
    check('bundle: Phase B the pre-move card offers [Move my files to my Free computer] beside 6a\'s banner', () => {
        assert.match(role('move-offer')?.textContent ?? '', /Opening it uses your Free limits\. You can move the files in your Workspace folder/);
        assert.equal(role('move-offer')?.querySelector('[data-action="move-start"]')?.textContent, 'Move my files to my Free computer');
        assert.match(role('files-held')?.textContent ?? '', /Your files are still on your AWS \(India\) computer\./);
    });
    moveReplies = [startedMove('saving')];
    data = heldMove({ reverseMove: reverseMove({ stage: 'saving' }) });
    const startsBefore = moves().length;
    click(role('move-offer')?.querySelector('[data-action="move-start"]'));
    await settle(8);
    check('bundle: Phase B a start answered with the move shows the move card; the request names the computer', () => {
        const sent = moves().at(-1);
        assert.equal(moves().length, startsBefore + 1);
        assert.match(sent.url, /\/api\/trpc\/computer\.move\.start$/);
        assert.equal(sent.method, 'POST');
        assert.deepEqual(sent.body, { json: { computerId: 'c-1' } });
        assert.match(role('move-progress')?.textContent ?? '', /Step 1 of 4: Saving your files\./);
        assert.equal(role('computer-chip')?.textContent.trim(), 'Moving files…');
        assert.equal(pane().querySelector('[data-action="open"], [data-action="stop"], [data-role="move-offer"], [data-role="files-held"]'), null);
    });

    // A move started from an open in another window: progress moves before the summary carries it.
    data = heldMove(); progress = { ...movingProgress({ phase: 'importing' }), computerId: 'c-1' };
    const summariesBefore = summaryReads().length;
    await reopen();
    await settle(20, 30);
    check('bundle: Phase B progress moving while reverseMove is null: the card from progress; the summary re-read at most 6 times', () => {
        assert.match(role('move-progress')?.textContent ?? '', /Step 2 of 4: Copying your files to your Free computer\./);
        assert.match(role('move-bytes')?.textContent ?? '', /120 MB of 0\.4 GB copied/);
        assert.equal(summaryReads().length - summariesBefore, 1 + 6, 'one activation read, then six re-reads, no more');
    });
    data = heldMove({ reverseMove: reverseMove({ stage: 'copying', bytesDone: '120000000', bytesTotal: '400000000' }) });

    // move_computer_running → [Stop and move my files]: start again first, then Stop (the same confirmation), wait for stopped, start once.
    data = heldMove(); progress = running();
    await reopen();
    moveReplies = [{ ok: false, reason: 'move_computer_running' }];
    click(role('move-offer')?.querySelector('[data-action="move-start"]'));
    await settle(8);
    check('bundle: Phase B move_computer_running: "Your AWS computer is open." with [Stop and move my files]', () => {
        assert.match(role('move-refused')?.textContent ?? '', /Your AWS computer is open\. Stop it first, and your files start moving to your Free computer as soon as it has stopped\./);
        assert.ok(role('move-refused')?.querySelector('[data-action="move-stop-start"]'));
        assert.equal(role('move-offer'), null, 'the refusal answers the click in its place');
    });
    moveReplies = [{ ok: false, reason: 'move_computer_running' }, startedMove('saving')];
    stopReply = () => { progress = { ...stoppedAws(), stage: 'stopped' }; return { ok: true, terminated: true }; };
    const stopFlow = { moves: moves().length, stops: stops().length };
    click(role('move-refused')?.querySelector('[data-action="move-stop-start"]'));
    await settle(6);
    const stopSheet = q('[role="dialog"][data-sheet="confirm-stop"]');
    check('bundle: Phase B [Stop and move my files] asks start again first, then confirms the stop (nothing stopped yet)', () => {
        assert.equal(moves().length, stopFlow.moves + 1);
        assert.ok(stopSheet, 'the same Stop confirmation');
        assert.equal(stops().length, stopFlow.stops);
    });
    data = heldMove({ reverseMove: reverseMove({ stage: 'saving' }) });
    click(stopSheet?.querySelector('[data-action="confirm"]'));
    await settle(20, 30);
    check('bundle: Phase B after the confirmed stop and a stopped read, the move starts once and shows', () => {
        assert.equal(stops().length, stopFlow.stops + 1);
        assert.equal(moves().length, stopFlow.moves + 2);
        assert.match(role('move-progress')?.textContent ?? '', /Step 1 of 4: Saving your files\./);
    });

    // A move another window started meanwhile: the re-check answers the move, and nothing is stopped.
    data = heldMove(); progress = running(); stopReply = { ok: true, terminated: true };
    await reopen();
    moveReplies = [{ ok: false, reason: 'move_computer_running' }];
    click(role('move-offer')?.querySelector('[data-action="move-start"]'));
    await settle(8);
    moveReplies = [startedMove('copying')];
    data = heldMove({ reverseMove: reverseMove({ stage: 'copying' }) });
    const noStop = stops().length;
    click(role('move-refused')?.querySelector('[data-action="move-stop-start"]'));
    await settle(8);
    check('bundle: Phase B [Stop and move my files] when a move already started: the move, no stop', () => {
        assert.equal(q('[role="dialog"][data-sheet="confirm-stop"]'), null);
        assert.equal(stops().length, noStop);
        assert.match(role('move-progress')?.textContent ?? '', /Step 2 of 4/);
    });

    // Try later, then Try again; a failed row's Try again is computer.move.retry (never an open).
    data = heldMove(); progress = { ...stoppedAws(), stage: 'stopped' };
    await reopen();
    moveReplies = [{ ok: false, reason: 'move_busy' }];
    click(role('move-offer')?.querySelector('[data-action="move-start"]'));
    await settle(8);
    check('bundle: Phase B move_busy: try later, with Try again', () => {
        assert.match(role('move-refused')?.textContent ?? '', /We can't start moving your files right now\. They're still on your AWS computer and nothing was deleted\. Try again later\./);
        assert.ok(role('move-refused')?.querySelector('[data-action="move-start"]'));
    });
    data = heldMove({ moveAvailable: true, reverseMove: reverseMove({ stage: 'failed_reopened', reason: 'copy_stalled', retry: 'now' }) });
    await reopen();
    moveReplies = [{ ok: false, reason: 'move_in_progress' }];
    data = heldMove({ reverseMove: reverseMove({ stage: 'checking' }) });
    const opens = calls.filter(c => c.url.includes('/api/shell/desktop')).length;
    click(role('move-failed')?.querySelector('[data-action="move-retry"]'));
    await settle(8);
    check('bundle: Phase B a failed card\'s Try again calls computer.move.retry; move_in_progress re-reads and shows the current move', () => {
        assert.match(moves().at(-1).url, /\/api\/trpc\/computer\.move\.retry$/);
        assert.equal(calls.filter(c => c.url.includes('/api/shell/desktop')).length, opens, 'no open: after a failure that is a D16 hold boot');
        assert.equal(q('.window[data-app="desktop"]'), null);
        assert.match(role('move-progress')?.textContent ?? '', /Step 3 of 4: Checking your files\./);
    });

    // A stop that meets the move is not "couldn't confirm the stop".
    data = heldMove(); progress = running();
    await reopen();
    stopReply = () => { data = heldMove({ reverseMove: reverseMove({ stage: 'saving' }) }); return { ok: false, terminated: false, outcome: 'computer_moving' }; };
    click(pane().querySelector('[data-action="stop"]'));
    await settle(6);
    click(q('[role="dialog"][data-sheet="confirm-stop"] [data-action="confirm"]'));
    await settle(10);
    check('bundle: Phase B a stop answered computer_moving shows the move card, never "We couldn\'t confirm the stop"', () => {
        assert.equal(role('computer-notice'), null);
        assert.doesNotMatch(pane().textContent, /couldn't confirm the stop/);
        assert.match(role('move-progress')?.textContent ?? '', /Step 1 of 4: Saving your files\./);
    });
    fastFive = false; stopReply = { ok: true, terminated: true };
    check('bundle: Phase B every move state names no city and passes the copy guards', () => {
        assert.doesNotMatch(pane().textContent, /mumbai|ap-south-1/i);
        assert.deepEqual(scanCopy(pane().textContent), []);
    });
    check('bundle: no uncaught page errors', () => assert.deepEqual(uncaught, []));
    dom.window.close();
}

for ( const line of results ) console.log(line);
const failed = results.filter(line => line.startsWith('FAIL')).length;
console.log(`\n${passed}/${results.length} Computer tab checks passed${bundleRan ? '' : ' (bundle part SKIPPED: no built bundle)'}; ${scanned.length} states scanned`);
process.exit(failed ? 1 : bundleRan ? 0 : 2);
