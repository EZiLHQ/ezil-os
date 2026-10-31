// troubleshoot-test.mjs — EZiL-authored. Settings → Troubleshoot, round 3
// (plan §6.6): every restart reason has its own copy, and the tab offers only
// Restart computer (Restart desktop was removed by app-code lane A2).
//
// Run:  node shell/ezil/ui/Settings/troubleshoot-test.mjs
// Imports the SOURCE tab with its imports stubbed; no bundle, no browser.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanCopy } from '../../../../e2e/billing-e2e-lib.mjs';

const moduleUrl = src => `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
const src = readFileSync(new URL('./tabs/troubleshoot.js', import.meta.url), 'utf8')
    .replace("import { isNative, selectRuntimeAdapter, sanitizeNativeEvents } from '../../../native-runtime.js';", 'const isNative = () => false, selectRuntimeAdapter = () => null, sanitizeNativeEvents = () => [];')
    .replace("import UIAlert from '../../../../src/UI/UIAlert.js';", "const UIAlert = async () => 'confirm';")
    .replace("import { openConfirmSheet } from '../sheet-frame.js';", 'const openConfirmSheet = async () => false;')
    .replace("import log from '../../../log.js';", 'const log = { ringBuffer: () => [] };')
    .replace("import session from '../../../session.js';", 'const session = { restartEndpoint: () => globalThis.__troubleshoot?.restart ?? null, currentComputer: () => globalThis.__troubleshoot?.computer ?? null };')
    .replace("import trpc from '../trpc.js';", 'const trpc = { query: async () => ({ ok: false }) };')
    .replace("import telemetry from '../../../telemetry.js';", 'const telemetry = { recentEvents: () => [], capture: () => undefined, redact: v => v };')
    .replace("import { ambientCorrelationId } from '../../../trace.js';", 'const ambientCorrelationId = () => null;')
    .replace("import { feedback_enabled, open_feedback_dialog, list_my_reports, delete_my_report } from '../../feedback/feedback.js';", 'const feedback_enabled = () => false, open_feedback_dialog = () => undefined, list_my_reports = async () => [], delete_my_report = async () => true;')
    .replace("import { MOVE_COPY, TRANSITION_EVENT } from '../../computer-progress.js';", "const TRANSITION_EVENT = 'ezil:computer-transition', MOVE_COPY = globalThis.__moveCopy;");
assert.ok(! /^import /m.test(src), 'every import is stubbed');
globalThis.__moveCopy = (await import('../computer-progress.js')).MOVE_COPY;
const { reasonCopy, restartMoveReason, default: troubleshootTab } = await import(moduleUrl(src));

let passed = 0;
function check (name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

const codes = ['restart_not_running', 'restart_busy', 'restart_budget_exhausted', 'restart_host_unreachable', 'restart_timeout', 'restart_unavailable',
    'restart_switch_in_progress', 'restart_foreign_computer', 'restart_not_entitled'];
check('🔴 every server restart code has its own sentence (no collapse into "could not be confirmed")', () => {
    const copies = codes.map(reasonCopy);
    assert.equal(new Set(copies).size, codes.length, copies.join(' | '));
    for ( const [i, copy] of copies.entries() ) {
        assert.notEqual(copy, 'Something went wrong. Please try again.', codes[i]);
        assert.match(copy, /^[A-Z].*[.]$/, codes[i]);
    }
    assert.equal(reasonCopy('restart_unavailable'), 'The desktop restart could not be confirmed. Try again in a moment.');
});
check('D11: the AWS monthly cap has its own copy, distinct from plan time, and never says fair use', () => {
    for ( const code of ['user_hours_cap', 'aws_monthly_cap', 'billing_user_hours_cap'] ) {
        assert.equal(reasonCopy(code), "You've used this month's AWS computer time. It resets on the 1st — or contact us.");
    }
    assert.doesNotMatch(reasonCopy('user_hours_cap'), /fair use|standard-hour|Paused until/i);
});
check('unknown codes stay honest and never echo the server string', () => {
    assert.equal(reasonCopy('<img src=x>'), 'Something went wrong. Please try again.');
});
check('the restart copy passes scanCopy; Troubleshoot offers Restart computer and no Restart desktop', () => {
    const all = [...codes, 'unsupported', 'timeout', 'fetch_failed', 'unauthorized', 'bad_request', 'stop_timed_out', 'boot_failed', 'user_hours_cap'].map(reasonCopy).join(' ');
    assert.deepEqual(scanCopy(all), []);
    const tab = readFileSync(new URL('./tabs/troubleshoot.js', import.meta.url), 'utf8');
    // App-code lane A2 (2026-10-30): "Restart desktop" was removed. Positive
    // control first: Restart computer's heading, copy and control are present.
    const computerCopy = 'Stops your computer and starts it again. Files stay. 1–4 minutes.';
    assert.ok(tab.includes(`<h3>Restart computer</h3><p class="ezil-settings-muted">${computerCopy}</p>`), 'Restart computer heading + copy');
    assert.match(tab, /<button [^>]*data-action="restart-computer"/, 'Restart computer button');
    assert.ok(tab.includes(`.on('click', '[data-action="restart-computer"]'`), 'Restart computer click binding');
    assert.deepEqual(scanCopy(computerCopy), []);
    // ...and nothing of Restart desktop: no duration constant, copy, heading, control or sheet.
    assert.doesNotMatch(tab, /RESTART_DESKTOP_TIME/);
    assert.ok(! tab.includes('Restarts the desktop and its apps'), 'no Restart desktop copy');
    assert.doesNotMatch(tab, /<h3>Restart desktop<\/h3>/);
    assert.doesNotMatch(tab, /data-action="restart"/);
    // The closing quote is what keeps 'confirm-restart-computer' (present) out of this.
    assert.doesNotMatch(tab, /sheet: ['"]confirm-restart['"]/);
    assert.doesNotMatch(tab, /About 20 seconds/);
});
// Round 6a: the terminal desktop copy (boot-phases BOOT_FAILURE_COPY desktop_config_unapplied / desktop_failed) sends a
// Code or app preview open to Restart computer. That is only honest if Restart computer is ENABLED with no desktop
// window open. Merged with app-code lane A2 (2026-10-31): Restart desktop no longer exists at all (check 4 above), so
// this asserts its absence rather than a disabled button, and no "Open a desktop first" note (that note is shown
// only when there is no computer to restart).
check('🔴 with no desktop window open, Restart computer is enabled and there is no Restart desktop', () => {
    let painted = '';
    const body = { length: 1, html: h => { painted = h; }, on () { return body; } };
    const $win = { find: sel => (sel === '[data-role="troubleshoot-body"]' ? Object.assign(body, { 0: { isConnected: true } }) : { length: 0 }) };
    Object.assign(globalThis, {
        __troubleshoot: { restart: '/api/shell/restart', computer: { id: 'c-1' } },
        html_encode: v => String(v),
        document: { querySelector: () => null },
        window: { addEventListener () {}, removeEventListener () {} },
    });
    troubleshootTab.init($win);
    const button = action => painted.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0] ?? '';
    assert.ok(button('restart-computer'), painted);
    assert.doesNotMatch(button('restart-computer'), /\sdisabled\b/, 'Restart computer needs only a computer');
    assert.ok(! button('restart') && ! /data-action="restart"/.test(painted), 'no Restart desktop control');
    assert.doesNotMatch(painted, /Restart desktop/);
    assert.doesNotMatch(painted, /Open a desktop first/, 'a computer to restart is all Restart computer needs');
});
// Phase B (§5.3, §6.4; r7 fixer): Restart desktop during a move meets the reverse provider. Its answer carries the move
// flags (session.restartDesktop passes them through), and the tab says what is true: the move, never "Something went wrong".
check('during a move, Restart desktop says the move (no generic failure); the blocked answer says the open-blocked sentence', () => {
    assert.equal(restartMoveReason({ ok: false, errorCode: 'sandbox_starting', computeMoving: true }), 'Moving your files to your Free computer.');
    assert.equal(restartMoveReason({ ok: false, errorCode: 'preconditions_unmet', computeMoveNeedsAttention: true }),
        "Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it.");
    // Only the flags decide, and only when boolean true: an ordinary failure keeps its own copy (and its telemetry row).
    for ( const res of [{ ok: false, errorCode: 'sandbox_starting' }, { ok: false, errorCode: 'restart_busy', computeMoving: 'true' }, null] ) {
        assert.equal(restartMoveReason(res), null, JSON.stringify(res));
    }
    assert.equal(reasonCopy('sandbox_starting'), 'Something went wrong. Please try again.', 'the generic copy the flags replace');
    assert.deepEqual(scanCopy(restartMoveReason({ computeMoving: true }) + ' ' + restartMoveReason({ computeMoveNeedsAttention: true })), []);
    // The move's answer is no api_failure: the telemetry capture is skipped for it.
    const tab = readFileSync(new URL('./tabs/troubleshoot.js', import.meta.url), 'utf8');
    assert.match(tab, /const moving = restartMoveReason\(res\);\s+failReason = moving \?\? reasonCopy\(res\.errorCode\);/);
    assert.match(tab, /if \( res\.errorCode !== 'unsupported' && ! moving \) \{\s+telemetry\.capture\(/);
});
console.log(`\n${passed}/6 Troubleshoot checks passed`);
