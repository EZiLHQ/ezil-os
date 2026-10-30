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
import { MOVE_COMPUTER, MOVE_STARTED, movingProgress, blockedProgress, terminalProgress } from './reverse-move-fixtures.mjs';

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

test('Code\'s moving answer handed back (sandbox_starting → timeout) while the move runs: still working on it, never a failure', async t => {
    const { s } = await surface(t, movingProgress({ phase: 'importing' }));
    s.render({ kind: 'failed', reason: 'timeout', errorCode: 'sandbox_starting' });
    assert.equal(title(s), 'Moving your files to your Free computer');
    assert.equal(status(s), "This is taking longer than usual. We're still working on it — you can keep this open or come back later.");
    assert.equal(retry(s).hidden, true);
    assert.equal(feedback(s).hidden, false);
    assert.equal(s.el.dataset.kind, 'progress');
    assert.doesNotMatch(visible(s), /taking too long|Try again/);
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
