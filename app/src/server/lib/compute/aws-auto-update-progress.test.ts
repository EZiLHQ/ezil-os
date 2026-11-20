import { describe, expect, it } from 'vitest';

import { automaticImageUpdateWait } from './aws-auto-update-progress';
import type { ImageRebaseResponse } from './aws-rebase-orchestrator';

const body = {
    schemaVersion: 1,
    computerId: '11111111-1111-4111-8111-111111111111',
    jobId: '22222222-2222-4222-8222-222222222222',
    phase: null,
    eligible: true,
    failureCode: null,
} satisfies ImageRebaseResponse['body'];

function wait(fields: Partial<ImageRebaseResponse['body']> = {}, status = 202) {
    return automaticImageUpdateWait({ status, body: { ...body, ...fields } });
}

describe('automatic computer update milestones', () => {
    it.each([
        ['reserved', 20, 'saving_files'],
        ['fencing', 20, 'saving_files'],
        ['snapshot_pending', 20, 'saving_files'],
        ['snapshot_ready', 40, 'starting_computer'],
        ['launch_pending', 40, 'starting_computer'],
        ['verifying', 60, 'checking_computer'],
        ['succeeded', 80, 'opening_code'],
    ] as const)('reports the verified checkpoint reached in phase %s', (phase, percent, stage) => {
        expect(wait({ phase })).toEqual({ milestone: { percent, stage } });
    });

    it('keeps checking during a live desktop-health wait', () => {
        const waiting = { phase: 'verifying', eligible: false, failureCode: 'desktop_unhealthy' } as const;
        expect(wait(waiting, 202)).toEqual({ milestone: { percent: 60, stage: 'checking_computer' } });
        expect(wait(waiting, 409)).toBeNull();
    });

    it('preserves indeterminate waiting on unproved phases and omits any job or computer identifiers', () => {
        expect(wait({ phase: 'unconfirmed' })).toEqual({});
        expect(wait()).toEqual({});
    });

    it('does not mark a missing or failed job as an update', () => {
        expect(wait({ jobId: null, phase: 'reserved' })).toBeNull();
        expect(wait({ eligible: false, phase: 'failed', failureCode: 'launch_failed' })).toBeNull();
    });
});
