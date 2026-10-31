// Phase B (reverse move contract §6.4): the ONE opening surface during a move. Run: node --test ezil/ui/app-spinner-move-test.mjs
//
// An open that meets a move shows the move, never an opening bar, `needs_operator` copy or a ten-minute failure:
//   - in flight: "Moving your files to your Free computer", the step sentence, a four-step bar, the elapsed time
//     (no "usually about"), then "Taking a little longer than usual" past the move's expectation; checked BEFORE the
//     prepare latch;
//   - the outcome, keyed on move.outcome + move.openBlocked only (whatever `stage` says), to an open that watched it;
//     [Open my AWS computer] only when the hold can open it; the open-blocked card on a bare needs-attention answer;
//   - past startedAt + budgetSeconds + 300 s, or once the open's loop handed the move back: "still working on it" and
//     Send feedback, never a failure;
//   - Code and Preview (read-only callers) render a moving answer as a `sandbox_starting`/`preconditions_unmet`
//     failure: the surface recognises it; an ordinary failure during a move keeps its own copy.
import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { scanCopy } from '../../../e2e/billing-e2e-lib.mjs';
import { honestyBans } from './Settings/billing-copy-test-helpers.mjs';
import { MOVE_COMPUTER, MOVE_STARTED, movingProgress, blockedProgress, terminalProgress, blockedAnswer } from './reverse-move-fixtures.mjs';
import { noteMoveAnswer, noteMoveRead, moveOf } from './computer-progress.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.window = { __EZIL_BOOT__: { desktopState: { provider: 'cloudflare-guacamole', endpoints: { feedback: '/api/shell/feedback' } } } };
const START = Date.parse(MOVE_STARTED);
let now = START;
const realNow = Date.now;
Date.now = () => now;
const timers = new Map(); let timerId = 0;
const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
globalThis.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; };
globalThis.clearTimeout = id => timers.delete(id);
let payload = null;
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
const { AppSpinner } = await import('./app-spinner.js');
const tick = async () => { for ( let i = 0; i < 30; i++ ) await Promise.resolve(); };
const poll = async () => { const found = [...timers].find(([, t]) => t.ms === 5000); assert.ok(found, 'a 5 s poll is scheduled'); timers.delete(found[0]); found[1].fn(); await tick(); };
const $ = (s, sel) => s.el.querySelector(sel);
const title = s => $(s, '.ezil-app-spinner-label').textContent;
const status = s => $(s, '.ezil-app-spinner-sub').textContent;
const meta = s => $(s, '.ezil-opening-meta');
const bar = s => $(s, '.ezil-opening-bar');
const pct = s => Number(bar(s).dataset.percent);
const retry = s => $(s, '.ezil-boot-retry');
const feedback = s => $(s, '.ezil-opening-feedback');
const shown = [];
const visible = s => { const text = [title(s), status(s), meta(s).hidden ? '' : meta(s).textContent,
    retry(s).hidden ? '' : retry(s).textContent].join(' '); shown.push(text); return text; };

async function surface (t, first, options = {}) {
    payload = first;
    const retried = [];
    const s = AppSpinner({ computerId: MOVE_COMPUTER, label: 'Opening Browser…', onRetry: () => retried.push(1), ...options });
    document.body.appendChild(s.el);
    t.after(() => { s.dispose(); s.el.remove(); timers.clear(); now = START; });
    s.render({ kind: 'progress' });
    await tick();
    return { s, retried, set: async data => { payload = data; await poll(); } };
}

const PHASE_COPY = {
    export_boot: 'Step 1 of 4: Saving your files.', exporting: 'Step 1 of 4: Saving your files.',
    importing: 'Step 2 of 4: Copying your files. 120 MB of 0.4 GB copied.', checking: 'Step 3 of 4: Checking your files.',
    committing: 'Step 4 of 4: Switching to your Free computer.',
};
for ( const [phase, sentence] of Object.entries(PHASE_COPY) ) {
    test(`in flight, ${phase}: the move's title and step, a determinate bar, the elapsed time only; never an opening`, async t => {
        now = START + 65_000;
        const { s } = await surface(t, movingProgress({ phase }));
        assert.equal(title(s), 'Moving your files to your Free computer');
        assert.equal(status(s), sentence);
        assert.equal(bar(s).hidden, false);
        assert.equal(bar(s).dataset.indeterminate, undefined);
        const floor = { export_boot: 0, exporting: 0, importing: 25, checking: 50, committing: 75 }[phase];
        assert.ok(pct(s) >= floor && pct(s) <= floor + 25 && pct(s) < 100, `${phase}: ${pct(s)}`);
        assert.equal(meta(s).textContent, '1:05', 'the elapsed time from the move\'s start, no expectation claim');
        assert.equal(retry(s).hidden, true);
        assert.equal(s.el.dataset.kind, 'progress');
        assert.doesNotMatch(visible(s), /Opening Browser|usually|needs attention|taking too long|Starting your computer/i);
    });
}

test('in flight: past move.expectedSeconds the meta says "Taking a little longer than usual"; the bar never moves back', async t => {
    now = START + 30_000;
    const { s } = await surface(t, movingProgress({ phase: 'importing', bytesDone: 300_000_000, bytesTotal: 400_000_000 }));
    const high = pct(s);
    now = START + 1_200_000;
    await (async () => { payload = movingProgress({ phase: 'importing', bytesDone: 100_000_000, bytesTotal: 400_000_000 }); await poll(); })();
    assert.equal(meta(s).textContent, 'Taking a little longer than usual');
    assert.equal(s.el.dataset.state, 'long');
    assert.ok(pct(s) >= high, `${pct(s)} >= ${high}`);
    assert.equal(retry(s).hidden, true);
});

test('the moving view is checked before the prepare latch', async t => {
    const { s } = await surface(t, movingProgress({ phase: 'checking' }), { isPreparing: () => true });
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.doesNotMatch(status(s), /^Preparing/);
});

test('answered "moving" before any read: the move\'s title over an indeterminate bar', async t => {
    globalThis.fetch = async () => { throw new Error('network'); };
    t.after(() => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) }); });
    const { s } = await surface(t, null, { isMoving: () => true });
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.equal(bar(s).dataset.indeterminate, 'true');
});

// Each terminal outcome with each `stage` the row can carry: the card comes from the move alone.
const STAGES = ['stopped', 'needs_operator', 'running', 'unavailable', 'starting'];
const OUTCOMES = [
    ['failed_reopened copy_stalled', { outcome: 'failed_reopened', reason: 'copy_stalled' }, "We couldn't move your files", "They're still on your AWS computer and nothing was deleted.", 'Open my AWS computer', 'failed'],
    ['failed_reopened copy_stalled, hold cannot open', { outcome: 'failed_reopened', reason: 'copy_stalled', holdOpenable: false }, "We couldn't move your files", "They're still on your AWS computer and nothing was deleted.", null, 'failed'],
    ['failed_reopened entitlement_paid', { outcome: 'failed_reopened', reason: 'entitlement_paid' }, "We couldn't move your files", 'Your plan is active again, so your files stay on your AWS computer.', 'Open my AWS computer', 'failed'],
    ['failed_reopened workspace_too_large', { outcome: 'failed_reopened', reason: 'workspace_too_large', retry: 'after_aws_session' }, "We couldn't move your files",
        'Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Remove some files on your AWS computer and try again, or upgrade to keep using them.', 'Open my AWS computer', 'failed'],
    ['failed_reopened workspace_too_large, hold cannot open', { outcome: 'failed_reopened', reason: 'workspace_too_large', retry: 'no', holdOpenable: false }, "We couldn't move your files",
        'Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Upgrade to use them again.', null, 'failed'],
    ['failed_reopened region_missing', { outcome: 'failed_reopened', reason: 'region_missing', retry: 'no' }, "We couldn't move your files",
        "They're still on your AWS computer and nothing was deleted. This computer needs a fix on our side before it can open or move; we're looking into it.", null, 'failed'],
    ['failed_needs_operator abort_unconfirmed', { outcome: 'failed_needs_operator', reason: 'abort_unconfirmed' }, "We couldn't finish moving your files",
        "They're safe on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it.", 'Open my AWS computer', 'attention'],
    ['failed_needs_operator abort_unconfirmed, hold cannot open', { outcome: 'failed_needs_operator', reason: 'abort_unconfirmed', holdOpenable: false }, "We couldn't finish moving your files",
        "They're safe on your AWS computer and nothing was deleted. We're looking into it.", null, 'attention'],
];
for ( const [label, row, wantTitle, wantStatus, action, state] of OUTCOMES ) {
    test(`outcome ${label}: the card from the move, whatever the stage`, async t => {
        const { s, retried, set } = await surface(t, movingProgress({ phase: 'importing' }));
        for ( const stage of STAGES ) {
            await set(terminalProgress({ ...row, stage, lifecycleState: stage === 'running' ? 'RUNNING' : stage === 'stopped' ? 'STOPPED' : null }));
            assert.equal(title(s), wantTitle, stage);
            assert.equal(status(s), wantStatus, stage);
            assert.equal(bar(s).hidden, true, stage);
            assert.equal(s.el.dataset.state, state, stage);
            assert.equal(retry(s).hidden, action === null, `${stage}: [Open my AWS computer] only when the hold can open it`);
            if ( action ) assert.equal(retry(s).textContent, action);
            assert.equal(feedback(s).hidden, false, `${stage}: Send feedback`);
            visible(s);
        }
        if ( action ) {
            retry(s).click();
            assert.equal(retried.length, 1, 'it re-asks the open (the D16 hold)');
            payload = terminalProgress({ ...row, stage: 'starting' });
            s.render({ kind: 'progress' });
            assert.equal(title(s), 'Opening Browser…', 'the hold\'s open is an ordinary open');
            assert.equal(retry(s).textContent === 'Open my AWS computer' && ! retry(s).hidden, false);
        }
    });
}

test('a terminal outcome this open never watched shows nothing of the move (an ordinary hold open)', async t => {
    const { s } = await surface(t, terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled', stage: 'starting', lifecycleState: 'STARTING' }));
    assert.doesNotMatch(visible(s), /move your files|moving your files/i);
    assert.equal(title(s), 'Opening Browser…');
});

for ( const stage of ['needs_operator', 'stopped', 'unavailable'] ) {
    test(`the open-blocked card, read live (${stage} on a later read), with no retry`, async t => {
        const { s, set } = await surface(t, blockedProgress({ reason: 'flip_stuck' }));
        assert.equal(title(s), "We're finishing moving your files");
        assert.equal(status(s), "Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it.");
        await set({ ...blockedProgress({ reason: 'flip_stuck' }), operation: 'none', stage });
        assert.equal(title(s), "We're finishing moving your files");
        assert.equal(retry(s).hidden, true);
        assert.equal(feedback(s).hidden, false);
        assert.equal(bar(s).hidden, true);
        visible(s);
    });
}

test('a bare needs-attention answer (the desktop window\'s state.move) shows the card at once; boot_unsettled once a read says so', async t => {
    globalThis.fetch = async () => { throw new Error('network'); };
    t.after(() => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) }); });
    const { s } = await surface(t, null);
    s.render({ kind: 'failed', reason: 'unknown', errorCode: 'preconditions_unmet', move: 'needs_attention' });
    assert.equal(title(s), "We're finishing moving your files");
    assert.equal(retry(s).hidden, true, 'deterministic: no retry, no spinner');
    assert.equal(bar(s).hidden, true);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
    payload = blockedProgress({ reason: 'boot_unsettled' });
    await poll();
    assert.equal(title(s), "We couldn't finish moving your files");
    assert.equal(status(s), "Your files are safe on your AWS computer and nothing was deleted. Your computer can't open until we've checked it; we're looking into it.");
    visible(s);
});

test('Code\'s needs-attention failure (preconditions_unmet) over the blocked row: the card, not "Something went wrong"', async t => {
    const { s } = await surface(t, blockedProgress());
    s.render({ kind: 'failed', reason: 'unknown', errorCode: 'preconditions_unmet' });
    assert.equal(title(s), "We're finishing moving your files");
    assert.equal(retry(s).hidden, true);
});

test('Code\'s moving answer handed back past the move\'s watch (sandbox_starting → timeout): still working on it, never a failure', async t => {
    const { s } = await surface(t, movingProgress({ phase: 'importing' }));
    now = START + (13_200 + 300) * 1000;
    s.render({ kind: 'failed', reason: 'timeout', errorCode: 'sandbox_starting' });
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.equal(status(s), "This is taking longer than usual. We're still working on it — you can keep this open or come back later.");
    assert.equal(retry(s).hidden, true);
    assert.equal(feedback(s).hidden, false);
    assert.equal(s.el.dataset.kind, 'progress');
    assert.doesNotMatch(visible(s), /taking too long|Try again/);
});

// Review fix (R1-m2): before the move's own watch, a handed-back move is not "still working on it": the loop handed it
// back because it read an outcome this surface has not read yet. The last in-flight view stays until it does.
test('a move handed back BEFORE its watch keeps the last in-flight view (no "still working on it", no Try again)', async t => {
    now = START + 120_000;
    const { s } = await surface(t, movingProgress({ phase: 'importing' }));
    s.render({ kind: 'failed', reason: 'timeout', errorCode: 'sandbox_starting' });
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.equal(status(s), 'Step 2 of 4: Copying your files. 120 MB of 0.4 GB copied.');
    assert.equal(retry(s).hidden, true);
    assert.doesNotMatch(visible(s), /still working on it|taking too long|Try again/);
});

test('past startedAt + budgetSeconds + 300 s with no outcome: "still working on it", never a failure', async t => {
    now = START + (13_200 + 299) * 1000;
    const { s } = await surface(t, movingProgress({ phase: 'committing' }));
    assert.equal(status(s), 'Step 4 of 4: Switching to your Free computer.');
    now = START + (13_200 + 300) * 1000;
    s.render({ kind: 'progress' });
    assert.equal(status(s), "This is taking longer than usual. We're still working on it — you can keep this open or come back later.");
    assert.equal(retry(s).hidden, true);
});

test('an ordinary failure during a move keeps its own copy', async t => {
    const { s } = await surface(t, movingProgress());
    s.render({ kind: 'failed', reason: 'unauthorized', errorCode: 'unauthorized' });
    assert.doesNotMatch(title(s), /mov/i);
    assert.equal(retry(s).hidden, false);
});

test('committed: "Your files are on your Free computer", full; then the Free computer\'s ordinary open and its ready', async t => {
    const { s, set } = await surface(t, movingProgress({ phase: 'committing' }));
    await set(terminalProgress({ outcome: 'committed' }));
    assert.equal(title(s), 'Your files are on your Free computer');
    assert.equal(status(s), 'Opening your Free computer.');
    assert.equal(pct(s), 100);
    assert.equal(retry(s).hidden, true);
    visible(s);
    s.render({ kind: 'ready' });
    assert.equal(s.el.dataset.state, 'done');
});

test('committed, then the Free computer\'s open fails (Code\'s failure, no state.move): its own failure copy', async t => {
    const { s, set } = await surface(t, movingProgress({ phase: 'committing' }));
    await set(terminalProgress({ outcome: 'committed' }));
    s.render({ kind: 'failed', reason: 'timeout', errorCode: 'sandbox_starting' });
    assert.equal(title(s), 'This is taking too long');
});

test('the desktop window\'s handed-back move (state.move moving) that later commits shows the commit', async t => {
    const { s, set } = await surface(t, movingProgress({ phase: 'committing' }));
    now = START + (13_200 + 300) * 1000; // its watch ran out: the loop handed the move back
    s.render({ kind: 'failed', reason: 'timeout', errorCode: 'sandbox_starting', move: 'moving' });
    assert.equal(status(s), "This is taking longer than usual. We're still working on it — you can keep this open or come back later.");
    await set(terminalProgress({ outcome: 'committed' }));
    assert.equal(title(s), 'Your files are on your Free computer');
    assert.equal(s.computerMove().outcome, 'committed');
});

test('a fresh open never paints an earlier open\'s move outcome (a new move answered before any read)', async t => {
    let moving = false;
    const { s, set } = await surface(t, movingProgress(), { isMoving: () => moving });
    await set(terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled' }));
    assert.equal(title(s), "We couldn't move your files");
    retry(s).click(); // [Open my AWS computer]: the hold's open, a fresh one
    globalThis.fetch = async () => { throw new Error('network'); };
    t.after(() => { globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) }); });
    moving = true; // a new move (started from Settings) answers the next open
    s.render({ kind: 'progress' });
    await tick();
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.equal(bar(s).dataset.indeterminate, 'true');
    assert.equal(retry(s).hidden, true);
});

// ── Review fixes (lane U r6b) ────────────────────────────────────────────────────────────────────────────────
const okFetch = async () => ({ ok: true, status: 200, json: async () => ({ result: { data: { json: payload } } }) });
let noteIds = 0;
/** A computer of the test's own: the open loop's notes are per computer and module-wide. */
const noteComputer = () => `note-computer-${++noteIds}`;
const BLOCKED_TITLE = "We're finishing moving your files";

// R1-M2 / R2-m2: Code and Preview hand over a plain `preconditions_unmet` (no `state.move`); the loop noted that the latest
// answer was the blocked one. The card shows at once, whatever this surface's own read is doing.
for ( const [label, setup] of [
    ['before its first progress read has answered', () => { globalThis.fetch = () => new Promise(() => {}); }],
    ['with every progress read failing', () => { globalThis.fetch = async () => { throw new Error('network'); }; }],
    ['with the tab hidden (no read at all)', () => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); }],
] ) {
    test(`Code's blocked failure ${label}: the needs-attention card at once, never "Something went wrong" or Try again`, async t => {
        setup();
        t.after(() => { globalThis.fetch = okFetch; delete document.hidden; });
        const id = noteComputer();
        const { s } = await surface(t, null, { computerId: id, label: 'Opening Code…' });
        noteMoveAnswer(id, blockedAnswer());
        s.render({ kind: 'failed', reason: 'unknown', errorCode: 'preconditions_unmet' });
        assert.equal(title(s), BLOCKED_TITLE);
        assert.equal(status(s), "Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it.");
        assert.equal(retry(s).hidden, true, 'no retry');
        assert.equal(bar(s).hidden, true, 'no spinner');
        assert.equal(feedback(s).hidden, false);
        noteMoveAnswer(id, { ok: true }); // another surface's later answer never takes this open's card back
        s.render({ kind: 'failed', reason: 'unknown', errorCode: 'preconditions_unmet' });
        assert.equal(title(s), BLOCKED_TITLE);
        assert.doesNotMatch(visible(s), /Something went wrong|Try again/);
    });
}

test('Code\'s blocked failure before its first read: the read that lands says boot_unsettled, and the card follows it', async t => {
    let answer;
    globalThis.fetch = () => new Promise(resolve => { answer = resolve; });
    t.after(() => { globalThis.fetch = okFetch; });
    const id = noteComputer();
    const { s } = await surface(t, null, { computerId: id, label: 'Opening Code…' });
    noteMoveAnswer(id, blockedAnswer());
    s.render({ kind: 'failed', reason: 'unknown', errorCode: 'preconditions_unmet' });
    assert.equal(title(s), BLOCKED_TITLE);
    answer({ ok: true, status: 200, json: async () => ({ result: { data: { json: blockedProgress({ computerId: id, reason: 'boot_unsettled' }) } } }) });
    await tick();
    assert.equal(title(s), "We couldn't finish moving your files");
    assert.equal(status(s), "Your files are safe on your AWS computer and nothing was deleted. Your computer can't open until we've checked it; we're looking into it.");
    assert.equal(retry(s).hidden, true);
});

test('a preconditions_unmet failure whose latest answer was NOT the blocked one keeps the ordinary failure', async t => {
    globalThis.fetch = async () => { throw new Error('network'); };
    t.after(() => { globalThis.fetch = okFetch; });
    const id = noteComputer();
    const { s } = await surface(t, null, { computerId: id, label: 'Opening Code…' });
    noteMoveAnswer(id, blockedAnswer());
    noteMoveAnswer(id, { ok: false, errorCode: 'preconditions_unmet' });
    s.render({ kind: 'failed', reason: 'unknown', errorCode: 'preconditions_unmet' });
    assert.notEqual(title(s), BLOCKED_TITLE);
    assert.equal(retry(s).hidden, false);
});

// R1-m2: the open's loop read the failed outcome before this surface's next 5 s poll and handed the move back. The
// outcome it read is painted at once (never "still working on it" for a move that has ended).
test('the loop\'s newer read of a failed outcome is painted the moment the move is handed back', async t => {
    now = START + 300_000;
    const id = noteComputer();
    const { s } = await surface(t, movingProgress({ computerId: id, phase: 'importing' }), { computerId: id });
    assert.equal(title(s), 'Moving your files to your Free computer');
    now += 4_000;
    noteMoveRead(id, moveOf(terminalProgress({ computerId: id, outcome: 'failed_reopened', reason: 'copy_stalled' }), id));
    s.render({ kind: 'failed', reason: 'timeout', errorCode: 'sandbox_starting', move: 'moving' });
    assert.equal(title(s), "We couldn't move your files");
    assert.equal(retry(s).textContent, 'Open my AWS computer');
    assert.doesNotMatch(visible(s), /still working on it/);
});

test('an older loop read never overrides this surface\'s newer poll', async t => {
    now = START + 300_000;
    const id = noteComputer();
    const { s, set } = await surface(t, movingProgress({ computerId: id, phase: 'checking' }), { computerId: id });
    now += 2_000;
    await set(movingProgress({ computerId: id, phase: 'checking' })); // this surface's own poll, at +2 s
    noteMoveRead(id, moveOf(terminalProgress({ computerId: id, outcome: 'failed_reopened' }), id), START + 301_000); // inside this open, older
    s.render({ kind: 'progress' });
    assert.equal(status(s), 'Step 3 of 4: Checking your files.');
});

test('a loop read from before this open (an earlier open\'s move) is never this open\'s outcome', async t => {
    globalThis.fetch = async () => { throw new Error('network'); };
    t.after(() => { globalThis.fetch = okFetch; });
    now = START + 300_000;
    const id = noteComputer();
    noteMoveRead(id, moveOf(terminalProgress({ computerId: id, outcome: 'failed_reopened', reason: 'copy_stalled' }), id), START + 100_000);
    const { s } = await surface(t, null, { computerId: id, isMoving: () => true });
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.equal(retry(s).hidden, true);
});

// R1-m3: "full, then the ordinary Cloudflare open": the committed card holds its full bar for a beat, then the Free
// computer's open is an ordinary open with its own clock and bar (never 100% through its wake), never the move's again.
test('committed: full for a beat, then the Free computer\'s ordinary open on its own clock; never 100% before its frame', async t => {
    now = START + 600_000;
    const { s, set } = await surface(t, movingProgress({ phase: 'committing' }), { isMoving: () => true });
    await set(terminalProgress({ outcome: 'committed' }));
    assert.equal(title(s), 'Your files are on your Free computer');
    assert.equal(pct(s), 100);
    now += 1_000;
    s.render({ kind: 'progress' });
    assert.equal(pct(s), 100, 'still the beat');
    now += 1_000;
    s.render({ kind: 'progress' });
    assert.equal(title(s), 'Opening Browser…', 'the ordinary open, though the loop still reads as moving');
    assert.ok(!(pct(s) >= 100), `below 100 until the first frame: ${pct(s)}`);
    now += 5_000;
    s.render({ kind: 'progress' });
    assert.equal(meta(s).textContent.startsWith('0:05'), true, `its own clock: ${meta(s).textContent}`);
    assert.doesNotMatch(visible(s), /Moving your files|Your files are on your Free computer/);
    s.stamp('first_frame');
    assert.equal(pct(s), 100);
});

// R2-M1: the caller is told the action was [Open my AWS computer], so it can end a loop still pausing on the move.
test('[Open my AWS computer] tells the caller ({openAws: true}); an ordinary Try again does not', async t => {
    const calls = [];
    const { s, set } = await surface(t, movingProgress({ phase: 'importing' }), { onRetry: (action) => calls.push(action) });
    await set(terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled' }));
    retry(s).click();
    assert.deepEqual(calls, [{ openAws: true }]);
    s.render({ kind: 'failed', reason: 'unauthorized', errorCode: 'unauthorized' });
    assert.equal(retry(s).hidden, false);
    retry(s).click();
    assert.deepEqual(calls, [{ openAws: true }, undefined]);
});

test('every move state painted passes the copy guards and names no city or region', () => {
    assert.ok(shown.length >= 20, `${shown.length} states`);
    for ( const text of shown ) {
        assert.deepEqual(scanCopy(text), [], text);
        assert.doesNotMatch(text, honestyBans, text);
        assert.doesNotMatch(text, /mumbai|ap-south-1|india/i, text);
        assert.doesNotMatch(text, /512 MB/, text);
    }
});

test.after(() => { Date.now = realNow; globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; delete globalThis.window; dom.window.close(); });
