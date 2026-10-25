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
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode })).toEqual({ kind: 'failed', reason });
        expect(boot.isRetryableBootErrorCode(errorCode)).toBe(false);
        const copy = boot.BOOT_FAILURE_COPY[reason];
        expect(copy.title).toBe(title);
        expect(copy.body).toContain('Your files are kept.');
        expect(copy.body).toContain(detail);
        expect(copy.body).toMatch(/Try again (only )?checks/);
        expect(copy.body).not.toMatch(/retrying usually fixes|upgrade|buy more/i);
    });

    it.each([undefined, 'unknown', 'worker_http_error', 'future_failure'])('%s keeps the old generic copy and retry behavior', code => {
        expect(boot.computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: code as app.BootErrorCode })).toEqual({ kind: 'failed', reason: 'unknown' });
        expect(boot.BOOT_FAILURE_COPY.unknown).toEqual({
            title: 'Something went wrong',
            body: "We couldn't start your computer. Try again, and if it keeps happening, let us know.",
        });
        expect(boot.isRetryableBootErrorCode(code)).toBe(true);
    });
});
