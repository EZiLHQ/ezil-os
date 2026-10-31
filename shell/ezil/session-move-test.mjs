// Phase B (reverse move contract §5.3, §6.4 rules 1-6): an open of a computer whose files are moving to its Free
// computer is answered `computeMoving` (the reverse waiting answer) or `computeMoveNeedsAttention` (the blocked
// answer). `withWakeAndOneRetry` tests the move FIRST: it replaces the loop's deadline and cap with the move's own
// (`MOVE_WATCH_MS` = budgetSeconds + 2400 s, re-asked at most every `MOVE_REASK_MS`), re-asks only after a
// `computer.progress` read shows the move in flight or committed, never after a failed outcome, and re-anchors the
// wake clocks on the first answer without the flag. Three surfaces: `openDesktop`, `previewUrl` and Code's mint mapping.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openDesktop, previewUrl, withWakeAndOneRetry, cancellableWake, pendingOrRefused, isComputeMoving, isComputePreparing, isComputeLaunching,
    isComputeMigrating, MOVE_WATCH_MS, MOVE_REASK_MS, LAUNCH_DEADLINE_MS, PREPARE_DEADLINE_MS } from './session.js';
import { WAKE_DEADLINE_MS, WAKE_REASK_MS } from './boot-phases.js';
import { MOVE_BUDGET_SECONDS, loopMoveOf } from './ui/computer-progress.js';
import { MOVE_COMPUTER, waitingAnswer, blockedAnswer, movingProgress, blockedProgress, terminalProgress } from './ui/reverse-move-fixtures.mjs';

const pending = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
const preparing = { ...pending, computePreparing: true };
/** A Cloudflare wake answer: what the open of the Free computer says after the commit. */
const cfStarting = { ok: false, errorCode: 'sandbox_starting' };
/** apps/code.js `mintCodePreviewUrlOnce`'s mapping: ok passes, anything else is `pendingOrRefused`. */
const codeAnswer = data => (data?.ok === true ? data : pendingOrRefused(data));
/** `apps/code.js`'s mint: its own `cancellableWake`, always with its window's signal. */
const codeMint = (id, signal, opts = {}) => cancellableWake(id, 'codePreviewUrl',
    async () => codeAnswer(await (await fetch('/api/shell/code-preview-url', { method: 'POST' })).json()), { signal, ...opts });
// Every real caller that can wait on a move passes its window's signal (the desktop window's own open, Code's and
// Preview's mints). Without one (the paint-time warm) a loop never waits on a move: tested on its own below.
const surfaces = [
    ['openDesktop', (id, signal) => openDesktop(id, undefined, { signal }), { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } }],
    ['previewUrl', (id, signal) => previewUrl(id, { signal }), { ok: true, appPreviewUrl: 'https://preview.example/' }],
    ['Code mint', codeMint, { ok: true, codePreviewUrl: 'https://code.example/' }],
];
const READ = '/api/trpc/computer.progress';
/** A refused `computer.progress` read: tRPC's GET error envelope (its code nests under `error.json.data`). */
class Refused { constructor (status, code) { this.status = status; this.body = { error: { json: { message: code, code: -32001, data: { code, httpStatus: status, path: 'computer.progress' } } } }; } }

/**
 * A fake clock and network. `answer` answers the open routes, `progress` the `computer.progress` read (return an
 * Error to fail the read, a `Refused` to refuse it). `log` records every ask and read with the clock. `signal`: the
 * caller's (default: a fresh one the test never aborts; null: no signal, as the paint-time warm).
 */
async function run (t, { open, answer, progress = () => movingProgress(), onWait, frozen = false, computerId = MOVE_COMPUTER, signal } = {}) {
    let now = 0;
    const log = [];
    const owner = signal === undefined ? new AbortController().signal : signal ?? undefined;
    t.mock.method(Date, 'now', () => now);
    t.mock.method(globalThis, 'setTimeout', (fn, ms) => { onWait?.({ now, ms, owner }); if ( ! frozen ) now += ms; queueMicrotask(fn); return 0; });
    t.mock.method(globalThis, 'fetch', async (url) => {
        const u = String(url);
        if ( u.includes(READ) ) {
            log.push({ kind: 'read', at: now });
            assert.ok(u.includes(encodeURIComponent(JSON.stringify({ json: { computerId } }))), `the read names the loop's computer: ${u}`);
            const data = progress({ now, log });
            if ( data instanceof Error ) throw data;
            if ( data instanceof Refused ) return { ok: false, status: data.status, json: async () => data.body };
            return { ok: true, status: 200, json: async () => ({ result: { data: { json: data } } }) };
        }
        log.push({ kind: 'ask', at: now });
        const body = answer({ now, asks: log.filter(e => e.kind === 'ask').length, log });
        return { ok: true, status: 200, json: async () => body };
    });
    const result = await open(computerId, owner);
    return { result, log, asks: log.filter(e => e.kind === 'ask'), reads: log.filter(e => e.kind === 'read'), elapsed: now, owner };
}

test('pendingOrRefused carries computeMoving and computeMoveNeedsAttention only when boolean true', () => {
    assert.equal(pendingOrRefused(waitingAnswer()).computeMoving, true);
    assert.equal(pendingOrRefused(blockedAnswer()).computeMoveNeedsAttention, true);
    for ( const flag of [undefined, null, false, 'true', 1, {}, []] ) {
        assert.equal(Object.hasOwn(pendingOrRefused(waitingAnswer({ computeMoving: flag })), 'computeMoving'), false, JSON.stringify(flag));
        assert.equal(Object.hasOwn(pendingOrRefused(blockedAnswer({ computeMoveNeedsAttention: flag })), 'computeMoveNeedsAttention'), false, JSON.stringify(flag));
    }
});

test('the move clocks are the contract\'s: budgetSeconds + 2400 s (r7 fixer: one drive gap per state), re-asked every 30 s', () => {
    assert.equal(MOVE_BUDGET_SECONDS, 13_200);
    assert.equal(MOVE_WATCH_MS, (13_200 + 2_400) * 1000);
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

test('a loop with no computer id returns a moving answer to its caller and never re-asks it (and reads nothing)', async t => {
    let asks = 0, reads = 0;
    t.mock.method(globalThis, 'setTimeout', (fn) => { queueMicrotask(fn); return 0; });
    t.mock.method(globalThis, 'fetch', async () => { reads++; return { ok: true, status: 200, json: async () => ({ result: { data: { json: movingProgress() } } }) }; });
    // An owner signal, so the no-computer rule (not the no-owner rule) is what returns.
    const out = await withWakeAndOneRetry(async () => { asks++; return waitingAnswer(); }, 'raw', undefined, undefined, { owner: new AbortController().signal });
    assert.equal(out.computeMoving, true);
    assert.equal(asks, 1);
    assert.equal(reads, 0, 'no progress read without the computer');
});

test('the move deadline belongs to the loop: the plain sandbox_starting deadline never cuts it', async t => {
    // A moving answer at 200 s, after 200 s of plain starting answers (216 s would be the wake's give-up).
    const out = await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal }), answer: ({ now }) => now < 200_000 ? pending : now < 1_000_000 ? waitingAnswer()
        : { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } },
    progress: ({ now }) => now < 1_000_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.ok, true);
    assert.ok(out.elapsed >= 1_000_000);
});

test('a moving answer from the server after a committed read keeps waiting (the server still routes the move)', async t => {
    const out = await run(t, { open: (id, signal) => previewUrl(id, { signal }),
        answer: ({ now }) => now <= 90_000 ? waitingAnswer() : { ok: true, appPreviewUrl: 'https://preview.example/' },
        progress: ({ now }) => now < 90_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.ok, true);
    assert.deepEqual(out.asks.map(a => a.at), [0, 30_000, 60_000, 90_000, 120_000]);
});

// ── Review fixes (lane U r6b): who may wait on a move, what the loop leaves the surface, and the backstops ─────────

// 🔴 Only a loop its caller can cancel waits on a move. The paint-time warm (`warm.js`) has no window and no signal:
// it would read and ask for hours behind no window and open the Free computer at the commit for nobody.
for ( const [name, open] of surfaces ) {
    test(`${name} with no caller signal (the warm): a moving answer goes straight back; no read, no second ask`, async t => {
        const out = await run(t, { open, signal: null, answer: () => waitingAnswer(), progress: () => terminalProgress({ outcome: 'committed' }) });
        assert.equal(out.result.computeMoving, true);
        assert.equal(out.asks.length, 1);
        assert.equal(out.reads.length, 0);
        assert.equal(isComputeMoving(MOVE_COMPUTER), false);
    });
}

test('the window that claims the warm takes the wait over from its moving answer: a read first, never a second ask back to back', async t => {
    const ready = { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } };
    const out = await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal, movingAnswer: waitingAnswer() }),
        answer: ({ now }) => now < 90_000 ? waitingAnswer() : ready,
        progress: ({ now }) => now < 90_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.ok, true);
    assert.deepEqual(out.log[0], { kind: 'read', at: MOVE_REASK_MS }, 'the first request is a read, one pause after the warm\'s answer');
    assert.deepEqual(out.asks.map(a => a.at), [30_000, 60_000, 90_000]);
});

test('isComputeMoving with an owner reads that caller\'s own loop only', async t => {
    const other = new AbortController().signal;
    const seen = [];
    await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal }),
        answer: ({ now }) => now < 60_000 ? waitingAnswer() : { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } },
        progress: ({ now }) => now < 60_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }),
        onWait: ({ owner }) => seen.push([isComputeMoving(MOVE_COMPUTER, owner), isComputeMoving(MOVE_COMPUTER, other), isComputeMoving(MOVE_COMPUTER)]) });
    assert.ok(seen.some(([mine]) => mine === true), 'its own loop');
    assert.ok(seen.every(([, theirs]) => theirs === false), 'never another caller\'s');
    assert.ok(seen.some(([, , any]) => any === true), 'no owner: any loop for the computer');
});

test('a progress read refused for the session (HTTP 401) answers `unauthorized` itself and asks nothing more', async t => {
    const out = await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal }), answer: () => waitingAnswer(),
        progress: ({ now }) => now < 90_000 ? movingProgress() : new Refused(401, 'UNAUTHORIZED') });
    assert.equal(out.result.ok, false);
    assert.equal(out.result.errorCode, 'unauthorized');
    assert.equal(out.result.computeMoving, undefined, 'its sign-in copy, never the move\'s');
    assert.deepEqual(out.asks.map(a => a.at), [0, 30_000, 60_000]);
    assert.equal(out.log.at(-1).kind, 'read', 'the refused read is the last request');
});

test('any other refused read (HTTP 500) is no evidence either way: it waits, and the next in-flight read asks', async t => {
    const out = await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal }),
        answer: ({ now }) => now < 120_000 ? waitingAnswer() : { ok: true, guacamoleUrl: 'https://viewer.example/', frame: { confirmed: true } },
        progress: ({ now }) => now === 60_000 ? new Refused(500, 'INTERNAL_SERVER_ERROR') : now < 120_000 ? movingProgress() : terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.ok, true);
    assert.deepEqual(out.asks.filter(a => a.at <= 90_000).map(a => a.at), [0, 30_000, 90_000]);
});

// Rule 4's cap: after the commit the loop is an ordinary wake again, capped at asks − 1 + AWS_MAX_ISSUES (not the move's).
test('frozen clock after a committed read: plain starting answers stop at the re-anchored wake cap, never the move\'s', async t => {
    const awsMaxIssues = Math.ceil(WAKE_DEADLINE_MS / WAKE_REASK_MS) + 2;
    const out = await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal }), frozen: true,
        answer: ({ asks }) => asks === 1 ? waitingAnswer() : cfStarting, progress: () => terminalProgress({ outcome: 'committed' }) });
    assert.equal(out.result.errorCode, 'unknown', 'the structural backstop');
    assert.equal(out.asks.length, 1 + awsMaxIssues);
    assert.equal(out.reads.length, 1);
});

// Rule 6 is keyed on the flag, not on `preconditions_unmet`: a blocked answer with a retryable code is not re-asked either.
test('a needs-attention answer on a retryable code (sandbox_starting) still returns at once: no re-ask, no read', async t => {
    const out = await run(t, { open: (id, signal) => openDesktop(id, undefined, { signal }), answer: () => blockedAnswer({ errorCode: 'sandbox_starting', retryable: true }) });
    assert.equal(out.result.computeMoveNeedsAttention, true);
    assert.equal(out.asks.length, 1);
    assert.equal(out.reads.length, 0);
});

// The notes the loop leaves the opening surface (Code and Preview hand it plain failures).
test('the loop notes whether the latest answer was the blocked one, and the move its latest read saw', async t => {
    await run(t, { open: (id, signal) => previewUrl(id, { signal }), answer: () => blockedAnswer() });
    assert.equal(loopMoveOf(MOVE_COMPUTER).blocked, true);
    await run(t, { open: (id, signal) => previewUrl(id, { signal }), answer: () => ({ ok: true, appPreviewUrl: 'https://preview.example/' }) });
    assert.equal(loopMoveOf(MOVE_COMPUTER).blocked, false, 'every answer overwrites it');
    const out = await run(t, { open: (id, signal) => previewUrl(id, { signal }), answer: () => waitingAnswer(),
        progress: ({ now }) => now < 60_000 ? movingProgress() : terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled' }) });
    assert.equal(loopMoveOf(MOVE_COMPUTER).move.outcome, 'failed_reopened');
    assert.equal(loopMoveOf(MOVE_COMPUTER).readAt, out.reads.at(-1).at);
    assert.equal(loopMoveOf('another-computer'), null);
});
