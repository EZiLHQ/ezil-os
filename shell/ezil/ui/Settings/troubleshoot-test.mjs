// troubleshoot-test.mjs — EZiL-authored. Settings → Troubleshoot, round 3
// (plan §6.6): two different restarts, each with its own reason copy.
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
    .replace("import session from '../../../session.js';", 'const session = { restartEndpoint: () => null, currentComputer: () => null };')
    .replace("import trpc from '../trpc.js';", 'const trpc = { query: async () => ({ ok: false }) };')
    .replace("import telemetry from '../../../telemetry.js';", 'const telemetry = { recentEvents: () => [], capture: () => undefined, redact: v => v };')
    .replace("import { ambientCorrelationId } from '../../../trace.js';", 'const ambientCorrelationId = () => null;')
    .replace("import { feedback_enabled, open_feedback_dialog, list_my_reports, delete_my_report } from '../../feedback/feedback.js';", 'const feedback_enabled = () => false, open_feedback_dialog = () => undefined, list_my_reports = async () => [], delete_my_report = async () => true;')
    .replace("import { TRANSITION_EVENT } from '../../computer-progress.js';", "const TRANSITION_EVENT = 'ezil:computer-transition';");
assert.ok(! /^import /m.test(src), 'every import is stubbed');
const { reasonCopy } = await import(moduleUrl(src));

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
check('the restart copy passes scanCopy', () => {
    const all = [...codes, 'unsupported', 'timeout', 'fetch_failed', 'unauthorized', 'bad_request', 'stop_timed_out', 'boot_failed', 'user_hours_cap'].map(reasonCopy).join(' ');
    assert.deepEqual(scanCopy(all), []);
    const tab = readFileSync(new URL('./tabs/troubleshoot.js', import.meta.url), 'utf8');
    // Round 5 (D6): one Restart duration, quoted in the description and while it runs.
    const restartTime = 'Restarting usually takes about 45 seconds and can take up to 3 minutes.';
    assert.ok(tab.includes(`const RESTART_DESKTOP_TIME = '${restartTime}';`));
    assert.ok(tab.includes('Restarts the desktop and its apps on this machine. Files stay. ${RESTART_DESKTOP_TIME}'));
    assert.doesNotMatch(tab, /About 20 seconds/);
    for ( const copy of [`Restarts the desktop and its apps on this machine. Files stay. ${restartTime}`, 'Stops your computer and starts it again. Files stay. 1–4 minutes.'] ) {
        assert.ok(tab.includes(copy) || copy.endsWith(restartTime), copy);
        assert.deepEqual(scanCopy(copy), []);
    }
});
console.log(`\n${passed}/4 Troubleshoot checks passed`);
