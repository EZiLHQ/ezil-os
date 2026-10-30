// Phase B (reverse move contract §5.3, §6.4 rules 1-6): an open of a computer whose files are moving to its Free
// computer is answered `computeMoving` (the reverse waiting answer) or `computeMoveNeedsAttention` (the blocked
// answer). `withWakeAndOneRetry` tests the move FIRST: it replaces the loop's deadline and cap with the move's own
// (`MOVE_WATCH_MS` = budgetSeconds + 300 s, re-asked at most every `MOVE_REASK_MS`), re-asks only after a
// `computer.progress` read shows the move in flight or committed, never after a failed outcome, and re-anchors the
// wake clocks on the first answer without the flag. Three surfaces: `openDesktop`, `previewUrl` and Code's mint mapping.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop, previewUrl, withWakeAndOneRetry, pendingOrRefused, isComputeMoving, isComputePreparing, isComputeLaunching,
    isComputeMigrating, MOVE_WATCH_MS, MOVE_REASK_MS, LAUNCH_DEADLINE_MS, PREPARE_DEADLINE_MS } from './session.js';
import { WAKE_DEADLINE_MS } from './boot-phases.js';
import { MOVE_BUDGET_SECONDS } from './ui/computer-progress.js';
import { MOVE_COMPUTER, waitingAnswer, blockedAnswer, movingProgress, blockedProgress, terminalProgress } from './ui/reverse-move-fixtures.mjs';

const pending = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const preparing = { ...pending, computePreparing: true };
/** A Cloudflare wake answer: what the open of the Free computer says after the commit. */
const cfStarting = { ok: false, errorCode: 'sandbox_starting' };
/** apps/code.js `mintCodePreviewUrlOnce`'s mapping: ok passes, anything else is `pendingOrRefused`. */
const codeAnswer = data => (data?.ok === true ? data : pendingOrRefused(data));
const surfaces = [
    ['openDesktop', id => openDesktop(id), { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } }],
    ['previewUrl', id => previewUrl(id), { ok: true, appPreviewUrl: 'https://preview.example/' }],
    ['Code mint', id => withWakeAndOneRetry(async () => codeAnswer(await (await fetch('/api/shell/code-preview-url', { method: 'POST' })).json()), 'codePreviewUrl', id),
        { ok: true, codePreviewUrl: 'https://code.example/' }],
];
const READ = '/api/trpc/computer.progress';

/**
 * A fake clock and network. `answer` answers the open routes, `progress` the `computer.progress` read (return an
 * Error to fail the read). `log` records every ask and read with the clock.
 */
async function run (t, { open, answer, progress = () => movingProgress(), onWait, frozen = false, computerId = MOVE_COMPUTER, signal } = {}) {
    let now = 0;
    const log = [];
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => { onWait?.({ now, ms }); if ( ! frozen ) now += ms; queueMicrotask(fn); return 0; });
    t.mock.method(globalThis, 'fetch', async (url) => {
        const u = String(url);
        if ( u.includes(READ) ) {
            log.push({ kind: 'read', at: now });
            assert.ok(u.includes(encodeURIComponent(JSON.stringify({ json: { computerId } }))), `the read names the loop's computer: ${u}`);
            const data = progress({ now, log });
            if ( data instanceof Error ) throw data;
            return { ok: true, status: 200, json: async () => ({ result: { data: { json: data } } }) };
        }
        log.push({ kind: 'ask', at: now });
        const body = answer({ now, asks: log.filter(e => e.kind === 'ask').length, log });
        return { ok: true, status: 200, json: async () => body };
    });
    const result = await open(computerId, signal);
    return { result, log, asks: log.filter(e => e.kind === 'ask'), reads: log.filter(e => e.kind === 'read'), elapsed: now };
}

test('pendingOrRefused carries computeMoving and computeMoveNeedsAttention only when boolean true', () => {
    assert.equal(pendingOrRefused(waitingAnswer()).computeMoving, true);
    assert.equal(pendingOrRefused(blockedAnswer()).computeMoveNeedsAttention, true);
    for ( const flag of [undefined, null, false, 'true', 1, {}, []] ) {
        assert.equal(Object.hasOwn(pendingOrRefused(waitingAnswer({ computeMoving: flag })), 'computeMoving'), false, JSON.stringify(flag));
        assert.equal(Object.hasOwn(pendingOrRefused(blockedAnswer({ computeMoveNeedsAttention: flag })), 'computeMoveNeedsAttention'), false, JSON.stringify(flag));
    }
});

test('the move clocks are the contract\'s: budgetSeconds + 300 s, re-asked every 30 s', () => {
    assert.equal(MOVE_BUDGET_SECONDS, 13_200);
    assert.equal(MOVE_WATCH_MS, (13_200 + 300) * 1000);
    assert.equal(MOVE_REASK_MS, 30_000);
});

for ( const [name, open, ready] of surfaces ) {
    test(`${name}: a move in flight is re-asked every 30 s after a read, and a commit re-asks into the Free computer's open`, async t => {
        const seen = [];
        const out = await run(t, { open,
            answer: ({ now }) => now < 600_000 ? waitingAnswer() : now < 603_000 ? cfStarting : ready,
            progress: ({ now }) => now < 600_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }),
            onWait: () => seen.push([isComputeMoving(MOVE_COMPUTER), isComputeMoving('another-computer')]) });
        assert.equal(out.result.ok, true, JSON.stringify(out.result));
        assert.equal(out.elapsed, 603_000);
        const moving = out.asks.filter(a => a.at < 600_000);
        assert.deepEqual(moving.map(a => a.at), Array.from({ length: 20 }, (_, i) => i * 30_000), 'one ask per 30 s while the move runs');
        assert.equal(out.reads.length, 20, 'one read before every re-ask of a moving answer, none after the commit');
        for ( const ask of out.asks.slice(1, 21) ) {
            const before = out.log[out.log.indexOf(ask) - 1];
            assert.equal(before.kind, 'read', `the ask at ${ask.at} follows a read`);
        }
        assert.deepEqual(out.asks.slice(20).map(a => a.at), [600_000, 601_500, 603_000], 'after the commit: the ordinary 1.5 s wake cadence');
        assert.ok(seen.some(([mine]) => mine === true) && seen.every(([, other]) => other === false), 'moving is scoped to this computer');
        assert.equal(isComputeMoving(MOVE_COMPUTER), false, 'cleared when the loop ends');
    });

    // 🔴 6a's clocks never end a move: a preparing answer first (deadline min(prep + 180 s, t0 + 600 s)), then a move.
    test(`${name}: a moving answer after a preparing one is not ended at t0 + 600 s, and outlives 40 asks`, async t => {
        const seen = [];
        const out = await run(t, { open,
            answer: ({ now }) => now < 3_000 ? preparing : now < 7_200_000 ? waitingAnswer() : ready,
            progress: ({ now }) => now < 7_200_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }),
            onWait: ({ now }) => { if ( now >= 3_000 ) seen.push([isComputePreparing(MOVE_COMPUTER), isComputeLaunching(MOVE_COMPUTER), isComputeMigrating(MOVE_COMPUTER)]); } });
        assert.equal(out.result.ok, true, JSON.stringify(out.result));
        assert.ok(out.elapsed > LAUNCH_DEADLINE_MS * 10, `ran past t0 + 600 s: ${out.elapsed}`);
        assert.ok(out.asks.length > 40, `outlived MAX_ISSUES: ${out.asks.length} asks`);
        assert.ok(seen.length > 0 && seen.every(flags => flags.every(f => f === false)), 'a moving answer clears preparing, launching and migrating');
    });

    test(`${name}: the move's watch ends at firstMovingAt + MOVE_WATCH_MS with the last moving answer (never a failure)`, async t => {
        const out = await run(t, { open, answer: () => waitingAnswer() });
        assert.equal(out.result.computeMoving, true);
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.elapsed, MOVE_WATCH_MS);
        assert.equal(out.asks.length, MOVE_WATCH_MS / MOVE_REASK_MS + 1);
    });

    for ( const [label, outcome] of [
        ['failed_reopened', () => terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled' })],
        ['failed_needs_operator (open works)', () => terminalProgress({ outcome: 'failed_needs_operator', reason: 'abort_unconfirmed', stage: 'stopped' })],
        ['failed_needs_operator (open blocked)', () => blockedProgress({ reason: 'flip_stuck' })],
        ['failed_reopened with a stage that reads running', () => terminalProgress({ outcome: 'failed_reopened', stage: 'running', lifecycleState: 'RUNNING' })],
    ] ) {
        test(`${name}: a ${label} outcome read after a pause sends no further ask`, async t => {
            const out = await run(t, { open, answer: () => waitingAnswer(),
                progress: ({ now }) => now < 300_000 ? movingProgress() : outcome() });
            assert.equal(out.result.computeMoving, true, 'the last moving answer goes back to the caller');
            assert.equal(out.asks.length, 10);
            assert.equal(out.asks.at(-1).at, 270_000);
            assert.equal(out.log.at(-1).kind, 'read', 'the outcome read is the last request: no D16 hold boot is asked for');
        });
    }

    // Rule 4: the first answer without the flag re-anchors t0, the deadline and the cap, and forgets the
    // launch/prepare clocks. A preparing answer before the move (t = 0) is forgotten; one at 600 s (re-anchor + 88.5 s)
    // extends to 780 s. Without the re-anchored t0 the clamp would be 0 + 600 s and the loop would end at 727.5 s.
    // (`openDesktopOnce` carries no `computePreparing` at 6a's base, so the desktop's preparing answers are plain ones.)
    if ( name !== 'openDesktop' ) test(`${name}: a committed outcome re-asks with fresh wake clocks`, async t => {
        const out = await run(t, { open,
            answer: ({ now }) => now < 1_500 ? preparing : now < 500_000 ? waitingAnswer() : now >= 600_000 && now < 601_500 ? preparing : pending,
            progress: ({ now }) => now < 500_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.result.computeMoving, undefined);
        const anchor = out.asks.find(a => a.at >= 500_000).at;
        assert.equal(anchor, 511_500);
        assert.equal(out.elapsed, 600_000 + PREPARE_DEADLINE_MS, 'the new t0 clamps the preparing extension, not the old one');
    });

    test(`${name}: a committed outcome then plain starting answers end at the re-anchor + the wake deadline`, async t => {
        const out = await run(t, { open, answer: ({ now }) => now < 300_000 ? waitingAnswer() : cfStarting,
            progress: ({ now }) => now < 300_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
        assert.equal(out.result.errorCode, 'sandbox_starting');
        assert.equal(out.elapsed, 300_000 + Math.ceil(WAKE_DEADLINE_MS / 1_500) * 1_500);
    });

    // Unpinned by the contract (reported): a read that fails, names another computer, or carries no move is not
    // evidence the move is in flight. The loop never asks on it; it pauses and reads again.
    for ( const [label, bad] of [['a failed read', () => new Error('network')], ['another computer\'s read', () => movingProgress({ computerId: 'another-computer' })],
        ['a read with no move', () => ({ ...terminalProgress(), move: null })], ['a malformed move', () => ({ ...movingProgress(), move: { direction: 'to_aws' } })]] ) {
        test(`${name}: ${label} sends no ask; the next in-flight read does`, async t => {
            const out = await run(t, { open,
                answer: ({ now }) => now < 600_000 ? waitingAnswer() : ready,
                progress: ({ now }) => now > 90_000 && now < 400_000 ? bad() : now < 600_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
            assert.equal(out.result.ok, true);
            assert.deepEqual(out.asks.filter(a => a.at > 90_000 && a.at < 420_000), [], 'no ask while the reads say nothing');
            assert.ok(out.asks.some(a => a.at === 420_000), 'the first in-flight read after them asks again');
        });
    }

    test(`${name}: a needs-attention answer returns at once, with no silent re-ask and no read`, async t => {
        const out = await run(t, { open, answer: () => blockedAnswer() });
        assert.equal(out.result.computeMoveNeedsAttention, true);
        assert.equal(out.result.errorCode, 'preconditions_unmet');
        assert.equal(out.asks.length, 1);
        assert.equal(out.reads.length, 0);
    });

    test(`${name}: needs attention after a moving answer also returns at once`, async t => {
        const out = await run(t, { open, answer: ({ asks }) => asks < 3 ? waitingAnswer() : blockedAnswer() });
        assert.equal(out.result.computeMoveNeedsAttention, true);
        assert.equal(out.asks.length, 3);
        assert.equal(isComputeMoving(MOVE_COMPUTER), false);
    });

    // The structural backstops: a frozen clock never spins.
    test(`${name}: frozen clock, reads that never answer: a finite number of reads, then the last moving answer`, async t => {
        const out = await run(t, { open, frozen: true, answer: () => waitingAnswer(), progress: () => new Error('network') });
        assert.equal(out.result.computeMoving, true);
        assert.equal(out.asks.length, 1);
        assert.equal(out.reads.length, Math.ceil(MOVE_WATCH_MS / MOVE_REASK_MS) + 2);
    });

    test(`${name}: frozen clock, the move in flight: the move's own cap stops the asks`, async t => {
        const out = await run(t, { open, frozen: true, answer: () => waitingAnswer() });
        assert.equal(out.result.errorCode, 'unknown');
        assert.equal(out.asks.length, Math.ceil(MOVE_WATCH_MS / MOVE_REASK_MS) + 2);
    });
}

test('openDesktop: a cancel during the move\'s wait asks no more', async t => {
    const controller = new AbortController();
    const out = await run(t, { open: (id) => openDesktop(id, undefined, { signal: controller.signal }), answer: () => waitingAnswer(),
        progress: ({ log }) => { if ( log.filter(e => e.kind === 'read').length === 3 ) controller.abort(); return movingProgress(); } });
    assert.equal(out.result.errorCode, 'cancelled');
    assert.equal(out.asks.length, 3, 'the read that saw the cancel sends no ask');
    assert.equal(isComputeMoving(MOVE_COMPUTER), false);
});

test('a loop with no computer id returns a moving answer to its caller and never re-asks it', async t => {
    let asks = 0;
    t.mock.method(globalThis, 'setTimeout', (fn) => { queueMicrotask(fn); return 0; });
    const out = await withWakeAndOneRetry(async () => { asks++; return waitingAnswer(); }, 'raw');
    assert.equal(out.computeMoving, true);
    assert.equal(asks, 1);
});

test('the move deadline belongs to the loop: the plain sandbox_starting deadline never cuts it', async t => {
    // A moving answer at 200 s, after 200 s of plain starting answers (216 s would be the wake's give-up).
    const out = await run(t, { open: id => openDesktop(id), answer: ({ now }) => now < 200_000 ? pending : now < 1_000_000 ? waitingAnswer()
        : { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } },
    progress: ({ now }) => now < 1_000_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.ok, true);
    assert.ok(out.elapsed >= 1_000_000);
});

test('a moving answer from the server after a committed read keeps waiting (the server still routes the move)', async t => {
    const out = await run(t, { open: id => previewUrl(id),
        answer: ({ now }) => now <= 90_000 ? waitingAnswer() : { ok: true, appPreviewUrl: 'https://preview.example/' },
        progress: ({ now }) => now < 90_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.ok, true);
    assert.deepEqual(out.asks.map(a => a.at), [0, 30_000, 60_000, 90_000, 120_000]);
});
