/**
 * The reverse waiting and blocked providers and the routing read (REVERSE-MOVE-CONTRACT §5.3): both `kind: 'aws-ec2'`,
 * every member a value, never the forward `computer_migrating`; the newest row decides; no 0012 is no reverse move.
 */
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { PlacementOwnerError, type PlacementExecutor } from './placement';
import {
    COMPUTER_MOVE_NEEDS_ATTENTION, COMPUTER_MOVING, providerForReverseMove, reverseBlockedAnswer, reverseBlockedProvider, reverseMovingAnswer,
    reverseWaitingProvider,
} from './provider-reverse-placement';

const U = '11111111-1111-4111-8111-111111111111';
const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const ctx = { correlationId: 'c' }, ref = { userId: U, computerId: C };

describe('the reverse providers (§5.3, pinned answers)', () => {
    it('waiting: computer_moving as a retryable sandbox_starting from aws-ec2; stop and terminate refuse; nothing boots', async () => {
        expect(reverseWaitingProvider.kind).toBe('aws-ec2');
        expect(await reverseWaitingProvider.ensure(ctx, ref, { sessionId: 's', desktopMode: 'neko' }))
            .toEqual({ ok: false, error: 'computer_moving', errorCode: 'sandbox_starting', retryable: true, computeProvider: 'aws-ec2' });
        expect(await reverseWaitingProvider.status(ctx, ref)).toEqual({ ...reverseMovingAnswer(), state: 'starting' });
        expect(await reverseWaitingProvider.activity(ctx, ref, { lastInputAgoMs: 0 })).toEqual({ ok: false, error: COMPUTER_MOVING });
        expect(await reverseWaitingProvider.restart(ctx, ref)).toEqual({ ok: false, error: COMPUTER_MOVING });
        expect(await reverseWaitingProvider.stop(ctx, ref, 'user')).toEqual({ ok: false, terminated: false, outcome: COMPUTER_MOVING });
        expect(await reverseWaitingProvider.terminate(ctx, ref)).toEqual({ ok: false, terminated: false, outcome: COMPUTER_MOVING });
        expect(JSON.stringify(reverseMovingAnswer())).not.toContain('computer_migrating');
    });
    it('blocked: computer_move_needs_attention as a deterministic preconditions_unmet from aws-ec2', async () => {
        expect(reverseBlockedProvider.kind).toBe('aws-ec2');
        expect(await reverseBlockedProvider.ensure(ctx, ref, { sessionId: 's', desktopMode: 'neko' }))
            .toEqual({ ok: false, error: 'computer_move_needs_attention', errorCode: 'preconditions_unmet', retryable: false, computeProvider: 'aws-ec2' });
        expect(await reverseBlockedProvider.status(ctx, ref)).toEqual({ ...reverseBlockedAnswer(), state: 'error' });
        expect(await reverseBlockedProvider.restart(ctx, ref)).toEqual({ ok: false, error: COMPUTER_MOVE_NEEDS_ATTENTION });
        expect(await reverseBlockedProvider.terminate(ctx, ref)).toEqual({ ok: false, terminated: false, outcome: COMPUTER_MOVE_NEEDS_ATTENTION });
    });
});

describe('providerForReverseMove (the routing read)', () => {
    const dbWith = (present: boolean, newest: Record<string, unknown> | null) => {
        const sqls: string[] = [];
        const db: PlacementExecutor = { execute: async (q: SQL) => {
            const text = new PgDialect().sqlToQuery(q).sql;
            sqls.push(text);
            if (text.includes('to_regclass')) return [{ present }];
            if (!present) throw new Error('relation does not exist');
            return newest ? [{ id: 'm', user_id: U, computer_id: C, started_by: 'open', generation: 'g', attempts: 0, commit_sent_at: null, last_error: null,
                state_entered_at: 't', created_at: 't', updated_at: 'u', age_created: 0, age_state_entered: 0, ...newest }] : [];
        } };
        return { db, sqls };
    };
    it.each(['requested', 'booting', 'exporting', 'copying', 'checking', 'flipping'])('%s → the waiting provider (reverse: moving)', async state => {
        expect(await providerForReverseMove(dbWith(true, { state }).db, ref)).toEqual({ provider: reverseWaitingProvider, reverse: 'moving' });
    });
    it.each([
        ['flip_stuck with commit_sent_at', { last_error: 'flip_stuck', commit_sent_at: 'sent' }],
        ['already_imported', { last_error: 'already_imported' }], ['commit_in_progress', { last_error: 'commit_in_progress' }],
        ['boot_unsettled', { last_error: 'boot_unsettled' }],
    ])('failed_needs_operator, open blocked (%s) → the blocked provider', async (_name, over) => {
        expect(await providerForReverseMove(dbWith(true, { state: 'failed_needs_operator', ...over }).db, ref))
            .toEqual({ provider: reverseBlockedProvider, reverse: 'blocked' });
    });
    it('abort_unconfirmed (placement settled), committed, failed_reopened, no row and no 0012 → ordinary routing (null)', async () => {
        expect(await providerForReverseMove(dbWith(true, { state: 'failed_needs_operator', last_error: 'abort_unconfirmed' }).db, ref)).toBeNull();
        for (const state of ['committed', 'failed_reopened']) expect(await providerForReverseMove(dbWith(true, { state }).db, ref), state).toBeNull();
        expect(await providerForReverseMove(dbWith(true, null).db, ref)).toBeNull();
        const bare = dbWith(false, { state: 'copying' });
        expect(await providerForReverseMove(bare.db, ref)).toBeNull();
        expect(bare.sqls).toHaveLength(1);
    });
    it('another owner\'s row is that owner\'s: PlacementOwnerError, as the forward read', async () => {
        await expect(providerForReverseMove(dbWith(true, { state: 'copying', user_id: '22222222-2222-4222-8222-222222222222' }).db, ref))
            .rejects.toBeInstanceOf(PlacementOwnerError);
    });
});
