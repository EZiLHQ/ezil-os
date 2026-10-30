import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop, previewUrl, withWakeAndOneRetry } from './session.js';
import { BOOT_FAILURE_COPY, computeBootUiState } from './boot-phases.js';
import { recentEvents } from './telemetry.js';

const refusals = [
    ['kill_switch', 'Your AWS computer is paused by operations'],
    ['aws_disabled', 'Your AWS computer is paused by operations'],
    ['capacity_unavailable', 'No capacity in India right now'],
    ['user_hours_cap', "This month's computer hours are used up"],
    ['global_hours_cap', "This month's computer hours are used up"],
];

for (const surface of ['Browser', 'Preview', 'Code']) {
    for (const [errorCode, title] of [...refusals, ['unknown', 'Something went wrong']]) {
        await test(`${surface}: ${errorCode} preserves code/copy and ${errorCode === 'unknown' ? 'retries once' : 'never automatically retries'}`, async () => {
            const oldFetch = globalThis.fetch;
            let asks = 0;
            const answer = { ok: false, errorCode, error: errorCode };
            const issue = async () => { asks++; return answer; };
            // Every network call is intercepted, including unexpected ones.
            globalThis.fetch = async () => ({ ok: true, status: 200, json: issue });
            try {
                const result = surface === 'Browser' ? await openDesktop('computer-1')
                    : surface === 'Preview' ? await previewUrl('computer-1')
                    // Code's mint uses this exported session loop.
                    : await withWakeAndOneRetry(issue, 'codePreviewUrl');
                assert.equal(result.errorCode, errorCode);
                assert.equal(asks, errorCode === 'unknown' ? 2 : 1);
                const state = computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: result.errorCode });
                assert.equal(state.kind, 'failed');
                assert.equal(BOOT_FAILURE_COPY[state.reason].title, title);
                if (errorCode !== 'unknown') assert.match(BOOT_FAILURE_COPY[state.reason].body, /Try again (only )?checks/);
            } finally {
                globalThis.fetch = oldFetch;
            }
        });
    }
}

// Round 4: a billing refusal is a value on a 200 and answers the same until the plan or payment
// changes. Exactly one ask, no `auto_retry_billing_*` event, and the raw code reaches the failure
// state. Only `billing_unavailable` (the billing state could not be read) is asked once more.
const billing = [
    ['billing_payment_issue', 'payment_issue'],
    ['billing_no_plan', 'plan_required'],
    ['billing_size_not_allowed', 'plan_required'],
    ['billing_fair_use_paused', 'fair_use_paused'],
    ['billing_files_on_aws', 'files_on_aws'],
    ['billing_concurrent_limit', 'unknown'],
    ['billing_unavailable', 'unknown'],
];
const autoRetries = code => recentEvents().filter(e => e.code === `auto_retry_${code}`).length;
for (const surface of ['Browser', 'Preview', 'Code']) {
    for (const [errorCode, reason] of billing) {
        const retryable = errorCode === 'billing_unavailable';
        await test(`${surface}: ${errorCode} keeps its raw code and ${retryable ? 'retries once' : 'is asked exactly once'}`, async () => {
            const oldFetch = globalThis.fetch;
            let asks = 0;
            const answer = { ok: false, errorCode, error: errorCode, billingRefusal: errorCode.slice('billing_'.length), provider: 'cloudflare-guacamole' };
            const issue = async () => { asks++; return answer; };
            globalThis.fetch = async () => ({ ok: true, status: 200, json: issue });
            const before = autoRetries(errorCode);
            try {
                const result = surface === 'Browser' ? await openDesktop('computer-1')
                    : surface === 'Preview' ? await previewUrl('computer-1')
                    : await withWakeAndOneRetry(issue, 'codePreviewUrl');
                assert.equal(result.errorCode, errorCode);
                assert.equal(asks, retryable ? 2 : 1);
                assert.equal(autoRetries(errorCode) - before, retryable ? 1 : 0);
                const state = computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: result.errorCode });
                assert.deepEqual(state, { kind: 'failed', reason, errorCode });
            } finally {
                globalThis.fetch = oldFetch;
            }
        });
    }
}
