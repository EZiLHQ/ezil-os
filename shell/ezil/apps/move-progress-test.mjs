// Phase B (reverse move contract §6.4): the built loader during a move, for the three app windows (Browser = the
// desktop window, Code, Preview). Runs the bundle (`EZIL_SHELL_OUT_DIR`, else the committed one); every HTTP answer
// and the clock are local fakes. An open during a move never shows the opening bar, `needs_operator` copy or a
// ten-minute failure; it asks again only while the move is in flight or once it committed; a failed outcome is shown,
// never auto-opened; the needs-attention answer shows its card at once, with no retry.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { waitingAnswer, blockedAnswer, movingProgress, blockedProgress, terminalProgress, MOVE_STARTED } from '../ui/reverse-move-fixtures.mjs';

const assets = process.env.EZIL_SHELL_OUT_DIR;
const bundle = readFileSync(assets ? `${assets}/bundle.min.js` : new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(assets ? `${assets}/icons.js` : new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until (fn, what = 'the move UI') {
    for ( let i = 0; i < 600; i++ ) { const value = fn(); if ( value ) return value; await wait(5); }
    assert.fail(`${what} did not settle`);
}
const COMPUTER = 'computer-1';
const START = Date.parse(MOVE_STARTED);
const OPEN_PATHS = { desktop: '/api/shell/desktop', code: '/api/shell/code-preview-url', preview: '/api/shell/preview-url' };
const label = spinner => spinner.querySelector('.ezil-app-spinner-label').textContent;
const line = spinner => spinner.querySelector('.ezil-app-spinner-sub').textContent;

/**
 * `progress()` answers `computer.progress`; `answer()` answers the window's open route. Time is the move's own
 * (MOVE_STARTED + `now`); 5 s polls, 1.5 s wake re-asks and the 30 s move re-ask run in a few ms.
 */
async function open (t, app, { progress, answer, launch = true, reaskMs = 5 }) {
    const dom = new JSDOM('<!doctype html><div id="ezil-os-root"></div>', {
        url: 'https://app.example/os', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const { window: w } = dom;
    t.after(() => w.close());
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
    t.after(() => assert.deepEqual(errors, []));
    const timeout = w.setTimeout.bind(w), interval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 30_000 ? reaskMs : [5000, 1500].includes(ms) ? 5 : ms === 4000 ? 15 : ms, ...args);
    w.setInterval = (fn, ms, ...args) => interval(fn, ms === 250 ? 5 : ms, ...args);
    w.AbortSignal = { timeout: () => undefined };
    const h = { now: 0, asks: 0, reads: 0, log: [] };
    w.Date.now = () => START + h.now;
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if ( path.includes('/api/trpc/computer.progress') ) {
            h.reads++;
            body = { result: { data: { json: { ...progress(h), computerId: COMPUTER } } } };
        } else if ( Object.values(OPEN_PATHS).includes(path) && init.method === 'POST' ) {
            if ( path === OPEN_PATHS[app] ) { h.asks++; h.log.push(h.now); body = answer(h); } else body = { ok: false, errorCode: 'sandbox_starting' };
        } else if ( path.includes('confirm=frame') ) body = { ok: true, confirmed: true, status: 200 };
        else if ( path.startsWith('/api/shell/desktop') ) body = { ok: true, guacamoleRunning: false };
        return { ok: true, status: 200, json: async () => body };
    };
    w.__EZIL_BOOT__ = {
        user: { id: 'user-1', email: 'test@example.invalid' },
        computer: { id: COMPUTER, name: 'My Computer', slot: 1, isNew: false },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', codePreviewUrl: '/api/shell/code-preview-url',
                previewUrl: '/api/shell/preview-url', feedback: '/api/shell/feedback' } },
    };
    w.eval(icons); w.eval(bundle);
    h.dock = await until(() => w.document.querySelector('.taskbar-item[data-app="desktop"]'), 'the shell');
    h.w = w;
    if ( ! launch ) return h;
    await w.ezil.registry.launch(app, { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState });
    const win = await until(() => w.document.querySelector(`.window[data-app="${app}"]`), 'the window');
    h.win = win;
    h.spinner = win.querySelector('.ezil-app-spinner');
    return h;
}
const frame = h => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://');
const ready = { ok: true, guacamoleUrl: 'https://viewer.example/?embed=1', codePreviewUrl: 'https://code.example/', appPreviewUrl: 'https://preview.example/', frame: { confirmed: true } };

for ( const app of ['desktop', 'code', 'preview'] ) {
    test(`${app}: a move in flight shows the move past ten minutes, re-asks only after reads, then opens the Free computer on commit`, async t => {
        let committed = false;
        const h = await open(t, app, {
            progress: () => committed ? terminalProgress({ outcome: 'committed' }) : movingProgress({ phase: 'importing' }),
            answer: () => committed ? ready : waitingAnswer(),
        });
        await until(() => label(h.spinner) === 'Moving your files to your Free computer');
        assert.equal(line(h.spinner), 'Step 2 of 4: Copying your files. 120 MB of 0.4 GB copied.');
        assert.equal(h.spinner.querySelector('.ezil-opening-bar').dataset.indeterminate, undefined);
        assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
        await until(() => h.asks >= 4, 'repeated asks');
        assert.ok(h.reads >= h.asks - 1, `every re-ask follows a read (${h.reads} reads, ${h.asks} asks)`);
        h.now = 3_600_000; // an hour into the move: past every boot clock
        await wait(60);
        assert.equal(h.spinner.dataset.kind, 'progress');
        assert.equal(label(h.spinner), 'Moving your files to your Free computer');
        assert.doesNotMatch(h.spinner.textContent, /This is taking too long|needs attention|Starting your computer/);
        assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true, 'no Try again mid-move');
        committed = true;
        await until(() => frame(h), 'the Free computer\'s frame');
    });

    test(`${app}: a failed outcome is shown, never auto-opened; [Open my AWS computer] asks once`, async t => {
        let failed = false, opened = false;
        const h = await open(t, app, {
            progress: () => failed ? terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled', stage: 'stopped' }) : movingProgress({ phase: 'exporting' }),
            answer: () => opened ? ready : waitingAnswer(),
        });
        await until(() => label(h.spinner) === 'Moving your files to your Free computer');
        failed = true;
        await until(() => label(h.spinner) === "We couldn't move your files");
        const asks = h.asks;
        await wait(80);
        assert.equal(h.asks, asks, 'no ask after the failed outcome: no D16 hold boot behind the user\'s back');
        assert.equal(line(h.spinner), "They're still on your AWS computer and nothing was deleted.");
        const action = h.spinner.querySelector('.ezil-boot-retry');
        await until(() => ! action.hidden && action.textContent === 'Open my AWS computer', '[Open my AWS computer]');
        opened = true;
        action.click();
        await until(() => frame(h), 'the hold\'s open');
        assert.equal(h.asks, asks + 1, 'the click asks exactly once');
    });

    test(`${app}: the needs-attention answer shows its card at once, with no retry and no re-ask`, async t => {
        const h = await open(t, app, { progress: () => blockedProgress({ reason: 'flip_stuck' }), answer: () => blockedAnswer() });
        await until(() => label(h.spinner) === "We're finishing moving your files");
        await wait(60);
        assert.equal(h.asks, 1);
        assert.equal(h.spinner.querySelector('.ezil-boot-retry').hidden, true);
        assert.equal(line(h.spinner), "Your files are safe and nothing was deleted. Your computer can't open until we've checked this; we're looking into it.");
        assert.doesNotMatch(h.spinner.textContent, /Something went wrong|Your computer needs attention/);
    });

    test(`${app}: the move's watch runs out: still working on it, never a failure`, async t => {
        const h = await open(t, app, { progress: () => movingProgress({ phase: 'committing' }), answer: () => waitingAnswer() });
        await until(() => label(h.spinner) === 'Moving your files to your Free computer');
        h.now = (13_200 + 300) * 1000;
        await until(() => line(h.spinner).startsWith('This is taking longer than usual.'));
        await wait(60);
        assert.equal(h.spinner.querySelector('.ezil-boot-retry').hidden, true);
        assert.doesNotMatch(h.spinner.textContent, /This is taking too long/);
        assert.equal(h.spinner.querySelector('.ezil-opening-feedback').hidden, false, 'Send feedback');
    });
}

test('desktop: after a commit, the Free computer\'s own open timing out is that open\'s failure, never a re-open loop', async t => {
    let committed = false;
    const h = await open(t, 'desktop', {
        progress: () => committed ? terminalProgress({ outcome: 'committed' }) : movingProgress({ phase: 'committing' }),
        answer: () => committed ? { ok: false, errorCode: 'sandbox_starting' } : waitingAnswer(),
    });
    await until(() => label(h.spinner) === 'Moving your files to your Free computer');
    committed = true;
    await until(() => label(h.spinner) === 'Your files are on your Free computer');
    const asked = h.asks;
    await until(() => h.asks > asked + 1, 'the Free computer\'s open');
    h.now += 300_000; // past the re-anchored wake deadline
    await until(() => label(h.spinner) === 'This is taking too long', 'the open\'s own failure');
    const asks = h.asks;
    await wait(120);
    assert.equal(h.asks, asks, 'no automatic re-open after the commit');
    assert.equal(h.spinner.querySelector('.ezil-boot-retry').hidden, false, 'its own Try again');
});

test('desktop: a move handed back after its watch, then committed, opens the Free computer', async t => {
    let committed = false;
    const h = await open(t, 'desktop', {
        progress: () => committed ? terminalProgress({ outcome: 'committed' }) : movingProgress({ phase: 'committing' }),
        answer: () => committed ? ready : waitingAnswer(),
    });
    await until(() => label(h.spinner) === 'Moving your files to your Free computer');
    h.now = (13_200 + 300) * 1000 + 60_000;
    await until(() => line(h.spinner).startsWith('This is taking longer than usual.'));
    const asks = h.asks;
    await wait(60);
    assert.equal(h.asks, asks, 'the loop handed the move back: no more asks while it runs');
    committed = true;
    await until(() => frame(h), 'the Free computer\'s frame');
    assert.ok(h.asks > asks);
});

// ── Review fixes (lane U r6b) ──────────────────────────────────────────────────────────────────────────────────

// R2-M1: the surface polls every 5 s, the open's loop reads every 30 s. Here the 30 s pause outlasts the test, so the
// only way to a fresh open is the click ending the loop's wait: [Open my AWS computer] is never lost.
for ( const app of ['desktop', 'code', 'preview'] ) {
    test(`${app}: [Open my AWS computer] clicked while the open's loop still pauses on the move asks at once`, async t => {
        let failed = false, opened = false;
        const h = await open(t, app, { reaskMs: 60_000,
            progress: () => failed ? terminalProgress({ outcome: 'failed_reopened', reason: 'copy_stalled', stage: 'stopped' }) : movingProgress({ phase: 'exporting' }),
            answer: () => opened ? ready : waitingAnswer(),
        });
        await until(() => label(h.spinner) === 'Moving your files to your Free computer');
        failed = true;
        const action = h.spinner.querySelector('.ezil-boot-retry');
        await until(() => ! action.hidden && action.textContent === 'Open my AWS computer', '[Open my AWS computer]');
        const asks = h.asks;
        opened = true;
        action.click();
        await until(() => frame(h), 'the hold\'s open, at once');
        assert.equal(h.asks, asks + 1, 'one ask, from the click');
    });
}

// R1-M1: the paint-time warm has no window and no signal. It never waits on a move: one ask, its answer handed back,
// no read, and nothing asked at the commit for nobody.
test('desktop: a warm (dock hover) that meets a move and is never claimed asks once, reads nothing, opens nothing at the commit', async t => {
    let committed = false;
    const h = await open(t, 'desktop', { launch: false,
        progress: () => committed ? terminalProgress({ outcome: 'committed' }) : movingProgress({ phase: 'importing' }),
        answer: () => committed ? ready : waitingAnswer(),
    });
    h.dock.dispatchEvent(new h.w.Event('pointerenter'));
    await until(() => h.asks === 1, 'the warm\'s ask');
    await wait(80);
    committed = true;
    h.now = 3_600_000;
    await wait(120);
    assert.equal(h.asks, 1, 'no ask behind no window, before or after the commit');
    assert.equal(h.reads, 0);
});

test('desktop: the window that claims the warm owns the wait; closing it mid-move asks nothing more', async t => {
    let committed = false;
    const h = await open(t, 'desktop', { launch: false,
        progress: () => committed ? terminalProgress({ outcome: 'committed' }) : movingProgress({ phase: 'importing' }),
        answer: () => committed ? ready : waitingAnswer(),
    });
    h.dock.dispatchEvent(new h.w.Event('pointerenter'));
    await h.w.ezil.registry.launch('desktop', { payload: h.w.__EZIL_BOOT__, computer: h.w.__EZIL_BOOT__.computer, desktopState: h.w.__EZIL_BOOT__.desktopState });
    const win = await until(() => h.w.document.querySelector('.window[data-app="desktop"]'), 'the window');
    const spinner = win.querySelector('.ezil-app-spinner');
    await until(() => label(spinner) === 'Moving your files to your Free computer');
    await until(() => h.asks >= 3, 'the window\'s own re-asks');
    // The close itself settles later in jsdom (its animation); the window is disposed at once.
    void h.w.$(win).close();
    await wait(300);
    const asks = h.asks;
    committed = true;
    h.now = 3_600_000;
    await wait(150);
    assert.equal(h.asks, asks, 'a closed window\'s move wait asks nothing, and opens nothing at the commit');
});
