import { describe, expect, it } from 'vitest';
import * as app from './boot-phases';
import * as shell from './boot-phases.shell.js';

describe.each([['app', app], ['shell', shell]] as const)('%s AWS refusal copy', (_name, boot) => {
    it.each([
        ['kill_switch', 'operations_paused', 'Your AWS computer is paused by operations', 'Only operations can resume'],
        ['aws_disabled', 'operations_paused', 'Your AWS computer is paused by operations', 'Only operations can resume'],
        ['capacity_unavailable', 'capacity_unavailable', 'No capacity in India right now', 'Try again checks availability'],
        // RETRY-118: same copy and an enabled Try again; never retried automatically.
        ['capacity_attempt_expired', 'capacity_unavailable', 'No capacity in India right now', 'Try again checks availability'],
        ['region_capacity', 'capacity_unavailable', 'No capacity in India right now', 'Try again checks availability'],
        ['max_running', 'capacity_unavailable', 'No capacity in India right now', 'Try again checks availability'],
        ['user_hours_cap', 'user_hours_cap', "This month's computer hours are used up", 'Your monthly computer hours renew next month'],
        ['global_hours_cap', 'global_hours_cap', "This month's computer hours are used up", 'The service has reached its monthly computer hours limit'],
    ] as const)('%s is terminal with truthful copy and an honest manual recheck', (errorCode, reason, title, detail) => {
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode })).toEqual({ kind: 'failed', reason, errorCode });
        expect(boot.isRetryableBootErrorCode(errorCode)).toBe(false);
        const copy = boot.BOOT_FAILURE_COPY[reason];
        expect(copy.title).toBe(title);
        expect(copy.body).toContain('Your files are kept.');
        expect(copy.body).toContain(detail);
        expect(copy.body).toMatch(/Try again (only )?checks/);
        expect(copy.body).not.toMatch(/retrying usually fixes|upgrade|buy more/i);
    });

    it.each([undefined, 'unknown', 'worker_http_error', 'future_failure'])('%s keeps the old generic copy and retry behavior', code => {
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: code as app.BootErrorCode })).toEqual(
            code ? { kind: 'failed', reason: 'unknown', errorCode: code } : { kind: 'failed', reason: 'unknown' });
        expect(boot.BOOT_FAILURE_COPY.unknown).toEqual({
            title: 'Something went wrong',
            body: "We couldn't start your computer. Try again, and if it keeps happening, let us know.",
        });
        expect(boot.isRetryableBootErrorCode(code)).toBe(true);
    });
});

// Round 4 (D16-D18): the billing gate's refusals. The founder's 10-28 report showed
// `billing_size_not_allowed` as "Something went wrong" and "Error code: unknown".
describe.each([['app', app], ['shell', shell]] as const)('%s billing refusal copy', (_name, boot) => {
    it.each([
        ['billing_payment_issue', 'payment_issue', "Your payment didn't go through", 'Update your payment method in Settings → Billing to keep using your computer.'],
        ['billing_no_plan', 'plan_required', 'This configuration needs a paid plan.', 'Your files are kept.'],
        ['billing_size_not_allowed', 'plan_required', 'This configuration needs a paid plan.', 'Your files are kept.'],
        ['billing_fair_use_paused', 'fair_use_paused', 'Computer time is paused', 'Your files are kept.'],
        ['billing_allowance_exhausted', 'fair_use_paused', 'Computer time is paused', 'Your files are kept.'],
        ['billing_overage_cap_reached', 'fair_use_paused', 'Computer time is paused', 'Your files are kept.'],
        ['billing_files_on_aws', 'files_on_aws', 'Your files are on a bigger AWS (India) computer.', "That size can't open on the Free plan. Your files are kept. Upgrade to open it again."],
        ['billing_user_hours_cap', 'user_hours_cap', "This month's computer hours are used up", 'Your files are kept.'],
        ['billing_aws_monthly_cap', 'user_hours_cap', "This month's computer hours are used up", 'Your files are kept.'],
        ['billing_concurrent_limit', 'unknown', 'Something went wrong', "We couldn't start your computer."],
        ['billing_upgrade_pending', 'unknown', 'Something went wrong', "We couldn't start your computer."],
        ['billing_some_future_reason', 'unknown', 'Something went wrong', "We couldn't start your computer."],
    ] as const)('%s is never retried automatically, keeps its raw code and reads as %s', (errorCode, reason, title, detail) => {
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: errorCode as app.BootErrorCode }))
            .toEqual({ kind: 'failed', reason, errorCode });
        expect(boot.isRetryableBootErrorCode(errorCode)).toBe(false);
        const copy = boot.BOOT_FAILURE_COPY[reason];
        expect(copy.title).toBe(title);
        expect(copy.body).toContain(detail);
    });

    it('billing_unavailable keeps the generic copy and stays retryable', () => {
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: 'billing_unavailable' }))
            .toEqual({ kind: 'failed', reason: 'unknown', errorCode: 'billing_unavailable' });
        expect(boot.isRetryableBootErrorCode('billing_unavailable')).toBe(true);
    });

    it('the billing copy passes the copy guard and names no region code or city', () => {
        const banned = ['faster', 'instant', 'unlimited', 'priority', 'gpu', 'heavy use', 'gpt', 'claude', 'gemini', 'llama',
            'memory is kept', 'memory survives', 'processes keep running', 'ai included', 'includes ai', 'compute hours',
            'standard-hour', 'ap-south-1', 'mumbai'];
        for (const reason of ['payment_issue', 'plan_required', 'fair_use_paused', 'files_on_aws'] as const) {
            const text = `${boot.BOOT_FAILURE_COPY[reason].title} ${boot.BOOT_FAILURE_COPY[reason].body}`.toLowerCase();
            expect(banned.filter(term => text.includes(term))).toEqual([]);
            expect(text).not.toMatch(/moved|retrying usually fixes/);
        }
    });

    it('only an error carries a raw code: a missing or empty code adds none', () => {
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0 })).toEqual({ kind: 'failed', reason: 'unknown' });
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: '' as app.BootErrorCode }))
            .toEqual({ kind: 'failed', reason: 'unknown' });
    });
});
