// Phase B (reverse move contract §6.4): the desktop window's AWS boot verdicts never end a move. A moving open
// (`computeMoving` / `computeMoveNeedsAttention` on the answer, or a timeout over the moving view) is 'move', never
// 'reopen', 'budget_spent' or 'fail'; the moving view always waits. Past the 600 s hard stop and the reopen cap too.
import assert from 'node:assert/strict';
import test from 'node:test';
import { awsBootTimeoutVerdict, awsBootWaitVerdict, AWS_BOOT_HARD_STOP_MS, AWS_BOOT_MAX_REOPENS } from './boot-progress.js';
import { progressView } from './computer-progress.js';
import { MOVE_COMPUTER, MOVE_STARTED, movingProgress, blockedProgress } from './reverse-move-fixtures.mjs';

const START = Date.parse(MOVE_STARTED);
// The observation the desktop window holds: the moving view, an hour into the move (elapsed 3600 s > 600 s).
const moving = progressView(movingProgress({ phase: 'importing' }), MOVE_COMPUTER, { now: START + 3_600_000 });
const blocked = progressView(blockedProgress(), MOVE_COMPUTER, { now: START + 3_600_000 });
const opening = { stage: 'starting', activeAws: true, elapsed: 0 };

test('the moving view is an observation the verdicts recognise (not an AWS opening)', () => {
    assert.equal(moving.moving, true);
    assert.equal(moving.activeAws, false);
    assert.ok(moving.elapsed * 1000 > AWS_BOOT_HARD_STOP_MS);
});

for ( const bootElapsedMs of [0, AWS_BOOT_HARD_STOP_MS, 3 * AWS_BOOT_HARD_STOP_MS] ) {
    for ( const reopens of [0, AWS_BOOT_MAX_REOPENS, AWS_BOOT_MAX_REOPENS + 4] ) {
        test(`timeout verdict at ${bootElapsedMs} ms, ${reopens} reopens: a move is 'move', never budget_spent or fail`, () => {
            for ( const [reason, observation] of [['timeout', moving], ['timeout', null], ['unknown', blocked], ['timeout', opening], ['unknown', null]] ) {
                for ( const sessionClockSpent of [false, true] ) {
                    assert.equal(awsBootTimeoutVerdict({ reason, observation, bootElapsedMs, reopens, sessionClockSpent, moving: true }), 'move',
                        `${reason} ${observation?.stage}`);
                }
            }
            // A timeout over the moving view is the move too (a transport timeout, not the server's answer).
            assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: moving, bootElapsedMs, reopens }), 'move');
        });
        test(`wait verdict at ${bootElapsedMs} ms: the moving view always waits (in flight and open blocked)`, () => {
            for ( const clock of [false, true] ) {
                assert.equal(awsBootWaitVerdict({ observation: moving, bootElapsedMs, clock }), 'wait');
                assert.equal(awsBootWaitVerdict({ observation: blocked, bootElapsedMs, clock }), 'wait');
            }
        });
    }
}

test('without a move the verdicts are unchanged', () => {
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening, bootElapsedMs: 0 }), 'reopen');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening, bootElapsedMs: AWS_BOOT_HARD_STOP_MS }), 'budget_spent');
    assert.equal(awsBootTimeoutVerdict({ reason: 'unknown', observation: opening, bootElapsedMs: 0 }), 'fail');
    // An ordinary failure over the moving view (signed out, ...) is not the move's.
    assert.equal(awsBootTimeoutVerdict({ reason: 'unauthorized', observation: moving, bootElapsedMs: 0 }), 'fail');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: null, bootElapsedMs: 0 }), 'fail');
    assert.equal(awsBootWaitVerdict({ observation: { stage: 'needs_operator' }, bootElapsedMs: 0 }), 'fail');
    assert.equal(awsBootWaitVerdict({ observation: opening, bootElapsedMs: AWS_BOOT_HARD_STOP_MS }), 'budget_spent');
    assert.equal(awsBootWaitVerdict({ observation: opening, bootElapsedMs: AWS_BOOT_HARD_STOP_MS, clock: false }), 'wait');
});
