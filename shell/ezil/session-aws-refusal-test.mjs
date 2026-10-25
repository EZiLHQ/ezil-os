import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop, previewUrl, withWakeAndOneRetry } from './session.js';
import { BOOT_FAILURE_COPY, computeBootUiState } from './boot-phases.js';

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
