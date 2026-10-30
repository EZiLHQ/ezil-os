// Phase B (reverse move contract §5.10, §6.2, §6.4): `computer-progress.js` renders the moving view. In flight:
// "Moving your files to your Free computer" with the step sentence and a four-step bar, never an opening
// (`activeAws` false), whatever the export boot's placement state. The open-blocked row: the needs-attention card,
// not "Your computer needs attention". Terminal rows: today's description plus `move`; the outcome is keyed on
// `move.outcome` + `move.openBlocked` only. With no move the view is exactly today's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { progressView, openingAt, observeComputerProgress, moveOf, moveAskOf, moveOutcomeCopy, moveStepText, moveTooLargeText, moveBytesText,
    MOVE_COPY, MOVE_LIMIT_BYTES, MOVE_BUDGET_SECONDS, OPENING_COPY } from './computer-progress.js';
import { scanCopy } from '../../../e2e/billing-e2e-lib.mjs';
import { honestyBans } from './Settings/billing-copy-test-helpers.mjs';
import { MOVE_COMPUTER, MOVE_STARTED, PHASES, movingProgress, blockedProgress, terminalProgress } from './reverse-move-fixtures.mjs';

const ID = MOVE_COMPUTER;
const START = Date.parse(MOVE_STARTED);
const copies = [];
const keep = text => { copies.push(text); return text; };
const NO_CITY = /mumbai|ap-south-1|india|region/i;

test('MOVE_LIMIT_BYTES is the contract\'s plain literal and reads "537 MB"; "512 MB" appears nowhere', () => {
    assert.equal(MOVE_LIMIT_BYTES, 536_870_912);
    const src = fs.readFileSync(new URL('./computer-progress.js', import.meta.url), 'utf8');
    assert.match(src, /^export const MOVE_LIMIT_BYTES = 536870912;$/m, 'lane A reads this line');
    assert.match(moveTooLargeText(true), /\(537 MB\)/);
    for ( const file of ['./computer-progress.js', './app-spinner.js', './Settings/tabs/computers.js', './boot-progress.js', '../session.js', '../apps/desktop-window.js'] ) {
        const text = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
        assert.doesNotMatch(text, /512 MB/, file);
        assert.doesNotMatch(text, /537 MB/, `${file}: "537 MB" comes from the constant, never a literal`);
    }
    assert.equal(MOVE_BUDGET_SECONDS, 13_200);
});

for ( const phase of Object.keys(PHASES) ) {
    for ( const placementState of ['LEASED', 'STARTING', 'MOUNTING', 'UNCONFIRMED', 'RECOVERING', 'RETIRING', 'STOPPED'] ) {
        test(`moving view, ${phase}, export boot ${placementState}: the move's step, never an opening`, () => {
            const data = movingProgress({ phase, placementState });
            const view = progressView(data, ID, { now: START + 60_000 });
            assert.equal(view.stage, 'moving');
            assert.equal(view.moving, true);
            assert.equal(view.activeAws, false, 'never an AWS opening: no opening budget, no ten-minute stop');
            assert.equal(view.active, true);
            assert.equal(view.manualAttention, false);
            assert.equal(view.path, null);
            assert.equal(view.transition, null);
            assert.equal(view.title, keep(MOVE_COPY.moving));
            assert.equal(keep(view.body), moveStepText(view.move));
            assert.equal(view.move.step, PHASES[phase].step);
            assert.equal(view.expected, 1_110, 'the bar eases by move.expectedSeconds');
            assert.equal(view.elapsed, 60, 'from move.startedAt');
            assert.notEqual(view.bar, null);
            // The placement state never shows: the same view in every state.
            assert.deepEqual(view, progressView(movingProgress({ phase, placementState: 'MOUNTING' }), ID, { now: START + 60_000 }));
        });
    }
}

test('moving view: the overlay\'s step sentences, and the copied bytes in the card\'s units', () => {
    const body = phase => progressView(movingProgress({ phase }), ID).body;
    assert.equal(body('export_boot'), 'Step 1 of 4: Saving your files.');
    assert.equal(body('exporting'), 'Step 1 of 4: Saving your files.');
    assert.equal(body('importing'), 'Step 2 of 4: Copying your files. 120 MB of 0.4 GB copied.');
    assert.equal(body('checking'), 'Step 3 of 4: Checking your files.');
    assert.equal(body('committing'), 'Step 4 of 4: Switching to your Free computer.');
    assert.equal(progressView(movingProgress({ phase: 'importing', bytesDone: 1_200_000_000, bytesTotal: 2_400_000_000 }), ID).body,
        'Step 2 of 4: Copying your files. 1,200 MB of 2.4 GB copied.');
    assert.equal(progressView(movingProgress({ phase: 'importing', bytesDone: 0, bytesTotal: null }), ID).body, 'Step 2 of 4: Copying your files.',
        'before the export head, no invented total');
    assert.equal(moveBytesText(5, 0), '');
});

test('moving view bar: four equal steps, eased by the move\'s expectation, never past the next step\'s floor, never 100', () => {
    const at = (phase, seconds, extra = {}) => openingAt(progressView(movingProgress({ phase, ...extra }), ID, { now: START + seconds * 1000 }), START + seconds * 1000).percent;
    assert.equal(at('export_boot', 0), 0);
    assert.ok(at('export_boot', 300) > 0 && at('export_boot', 300) <= 25);
    assert.equal(at('export_boot', 100_000), 25, 'step 1 stops at step 2\'s floor however long it takes');
    assert.equal(at('checking', 0), 50);
    assert.equal(at('checking', 100_000), 75);
    assert.equal(at('committing', 0), 75);
    assert.ok(at('committing', 100_000) < 100);
    // Step 2's segment is filled by the bytes.
    const copied = done => at('importing', 0, { bytesDone: done, bytesTotal: 400_000_000 });
    assert.ok(copied(0) === 25 && copied(200_000_000) > 25 && copied(200_000_000) <= 50 && copied(400_000_000) === 50, `${copied(0)} ${copied(200_000_000)} ${copied(400_000_000)}`);
    const view = progressView(movingProgress({ phase: 'committing' }), ID, { now: START + 10_000_000 });
    assert.equal(openingAt(view, START + 10_000_000).long, true, 'past move.expectedSeconds: the overlay\'s long note');
    assert.equal(OPENING_COPY.long, 'Taking a little longer than usual');
});

test('the open-blocked row is the move\'s needs-attention card, never "Your computer needs attention"', () => {
    const view = progressView(blockedProgress({ reason: 'flip_stuck' }), ID);
    assert.equal(view.stage, 'needs_operator');
    assert.equal(view.moving, true);
    assert.equal(view.bar, null);
    assert.equal(view.activeAws, false);
    assert.equal(view.manualAttention, true);
    assert.equal(keep(view.title), "We're finishing moving your files");
    assert.equal(keep(view.body), "Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it.");
    assert.equal(view.move.openBlocked, true);
    const unsettled = progressView(blockedProgress({ reason: 'boot_unsettled' }), ID);
    assert.equal(keep(unsettled.title), "We couldn't finish moving your files");
    assert.equal(keep(unsettled.body), "Your files are safe on your AWS computer and nothing was deleted. Your computer can't open until we've checked it; we're looking into it.");
});

test('terminal rows: today\'s description plus `move`; a committed row on the Cloudflare placement has no view, but its move is read', () => {
    const committed = terminalProgress({ outcome: 'committed' });
    assert.equal(progressView(committed, ID), null, 'stage unavailable: no view, exactly as today');
    assert.equal(moveOf(committed, ID).outcome, 'committed');
    assert.equal(moveOf(committed, ID).reason, null);
    const reopened = progressView(terminalProgress({ outcome: 'failed_reopened', stage: 'stopped' }), ID);
    assert.equal(reopened.title, 'Computer stopped', 'the hold\'s own stage');
    assert.equal(reopened.moving, false);
    assert.equal(reopened.move.outcome, 'failed_reopened');
});

test('with no move the view is exactly today\'s (no new keys)', () => {
    const today = { version: 2, computerId: ID, operation: 'opening', stage: 'starting', recordedStage: 'starting', active: true, durable: false, path: 'warm',
        openingStartedAt: MOVE_STARTED, expectedSeconds: 240, milestones: [], bytes: { transferred: null, total: null }, percent: null };
    const view = progressView(today, ID, { now: START });
    for ( const move of [null, undefined, { direction: 'to_aws' }, 'move'] ) {
        assert.deepEqual(progressView({ ...today, move }, ID, { now: START }), view, JSON.stringify(move));
    }
    assert.equal('move' in view || 'moving' in view, false);
    assert.equal(progressView({ ...today, operation: 'moving' }, ID), null, 'a moving operation without a move is not shown');
    assert.equal(progressView(movingProgress(), 'someone-else'), null);
});

test('moveAskOf: in flight or committed asks; a failed outcome stops; anything else waits', () => {
    assert.equal(moveAskOf(movingProgress(), ID), 'ask');
    assert.equal(moveAskOf(terminalProgress({ outcome: 'committed' }), ID), 'ask');
    for ( const data of [terminalProgress({ outcome: 'failed_reopened' }), terminalProgress({ outcome: 'failed_needs_operator', reason: 'abort_unconfirmed' }),
        blockedProgress(), terminalProgress({ outcome: 'failed_reopened', stage: 'running', lifecycleState: 'RUNNING' })] ) {
        assert.equal(moveAskOf(data, ID), 'stop', JSON.stringify(data.move));
    }
    for ( const data of [null, undefined, {}, movingProgress({ computerId: 'other' }), { ...terminalProgress(), move: null }, { ...movingProgress(), version: 3 }] ) {
        assert.equal(moveAskOf(data, ID), 'wait');
    }
});

test('moveOf: server fields only; an unknown reason is dropped; a committed row\'s reason is null', () => {
    const odd = { ...terminalProgress({ outcome: 'failed_reopened' }), move: { ...terminalProgress({ outcome: 'failed_reopened' }).move, reason: '<b>x</b>' } };
    assert.equal(moveOf(odd, ID).reason, null);
    const spent = { ...terminalProgress({ outcome: 'committed' }) };
    spent.move = { ...spent.move, reason: null };
    assert.equal(moveOf(spent, ID).reason, null);
    assert.equal(moveOf({ ...movingProgress(), move: { ...movingProgress().move, budgetSeconds: undefined } }, ID).budgetSeconds, MOVE_BUDGET_SECONDS);
});

const failed = (reason, holdOpenable = true, retry = 'now') => moveOf(terminalProgress({ outcome: 'failed_reopened', reason, holdOpenable, retry }), ID);
test('overlay outcomes (§6.4): every row, keyed on outcome + openBlocked, with the holdOpenable variants', () => {
    const c = moveOutcomeCopy(moveOf(terminalProgress({ outcome: 'committed' }), ID));
    assert.deepEqual([keep(c.status), keep(c.body), c.committed, c.openAws], ['Your files are on your Free computer', 'Opening your Free computer.', true, false]);
    const plain = moveOutcomeCopy(failed('copy_stalled'));
    assert.deepEqual([keep(plain.status), keep(plain.body), plain.openAws, plain.feedback], ["We couldn't move your files", "They're still on your AWS computer and nothing was deleted.", true, true]);
    assert.equal(moveOutcomeCopy(failed('copy_stalled', false)).openAws, false, '[Open my AWS computer] only when the hold can open it');
    assert.equal(keep(moveOutcomeCopy(failed('entitlement_paid')).body), 'Your plan is active again, so your files stay on your AWS computer.');
    assert.equal(keep(moveOutcomeCopy(failed('workspace_too_large', true, 'after_aws_session')).body),
        'Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Remove some files on your AWS computer and try again, or upgrade to keep using them.');
    assert.equal(keep(moveOutcomeCopy(failed('workspace_too_large', false, 'no')).body),
        'Your Workspace folder is larger than a Free computer can hold (537 MB), so your files stay on your AWS computer. Nothing was deleted. Upgrade to use them again.');
    const region = moveOutcomeCopy(failed('region_missing', true, 'no'));
    assert.equal(keep(region.body), "They're still on your AWS computer and nothing was deleted. This computer needs a fix on our side before it can open or move; we're looking into it.");
    assert.equal(region.openAws, false, 'region_missing: the hold cannot open it either');
    const abort = h => moveOutcomeCopy(moveOf(terminalProgress({ outcome: 'failed_needs_operator', reason: 'abort_unconfirmed', holdOpenable: h }), ID));
    assert.deepEqual([keep(abort(true).status), keep(abort(true).body), abort(true).openAws],
        ["We couldn't finish moving your files", "They're safe on your AWS computer and nothing was deleted, and you can keep using it. We're looking into it.", true]);
    assert.deepEqual([keep(abort(false).body), abort(false).openAws], ["They're safe on your AWS computer and nothing was deleted. We're looking into it.", false]);
    // The open-blocked card whatever the stage, and on a bare needs-attention answer with nothing read yet.
    for ( const stage of ['needs_operator', 'stopped', 'running', 'unavailable'] ) {
        const blocked = moveOf({ ...blockedProgress(), stage, operation: 'none' }, ID);
        assert.equal(moveOutcomeCopy(blocked).status, "We're finishing moving your files", stage);
        assert.equal(moveOutcomeCopy(blocked).openAws, false);
    }
    assert.equal(moveOutcomeCopy(null, { needsAttention: true }).status, "We're finishing moving your files");
    assert.equal(moveOutcomeCopy(null, { needsAttention: true }).openAws, false);
    // A failed_needs_operator row that is NOT open blocked never gets the blocked card, even if its stage reads needs_operator.
    const notBlocked = moveOf(terminalProgress({ outcome: 'failed_needs_operator', reason: 'abort_unconfirmed', stage: 'needs_operator' }), ID);
    assert.equal(moveOutcomeCopy(notBlocked).status, "We couldn't finish moving your files");
    assert.equal(moveOutcomeCopy(moveOf(movingProgress(), ID)), null, 'in flight: no outcome');
});

test('observeComputerProgress hands the move to its caller with the view (committed has no view, still has its move)', async () => {
    const element = { isConnected: true };
    globalThis.document = { hidden: false, addEventListener () {}, removeEventListener () {} };
    const seen = [];
    let data = movingProgress();
    const observer = observeComputerProgress({ computerId: ID, element, query: async () => ({ ok: true, data }), onChange: (view, move) => seen.push([view, move]) });
    observer.start();
    for ( let i = 0; i < 20; i++ ) await Promise.resolve();
    observer.stop();
    assert.equal(seen[0][0].moving, true);
    assert.equal(seen[0][1].step, 1);
    data = terminalProgress({ outcome: 'committed' });
    const again = observeComputerProgress({ computerId: ID, element, query: async () => ({ ok: true, data }), onChange: (view, move) => seen.push([view, move]) });
    again.start();
    for ( let i = 0; i < 20; i++ ) await Promise.resolve();
    again.stop();
    assert.equal(seen[1][0], null);
    assert.equal(seen[1][1].outcome, 'committed');
    const failing = observeComputerProgress({ computerId: ID, element, query: async () => ({ ok: false }), onChange: (view, move) => seen.push([view, move]) });
    failing.start();
    for ( let i = 0; i < 20; i++ ) await Promise.resolve();
    failing.stop();
    assert.deepEqual(seen[2], [null, undefined], 'nothing read: the move is unknown, not "none"');
    delete globalThis.document;
});

test('every overlay move sentence passes the copy guards and names no city or region', () => {
    for ( const text of [...copies, ...Object.values(MOVE_COPY).flat(), moveTooLargeText(true), moveTooLargeText(false), OPENING_COPY.runningLong] ) {
        assert.deepEqual(scanCopy(text), [], text);
        assert.doesNotMatch(text, honestyBans, text);
        assert.doesNotMatch(text, NO_CITY, text);
        assert.doesNotMatch(text, /\b\d+\s*(min|minute|second|hour)s?\b/i, `no duration claim: ${text}`);
    }
});
