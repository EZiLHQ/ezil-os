// Runs the committed shell bundle; all HTTP responses and time are local fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const assets = process.env.EZIL_SHELL_OUT_DIR;
const bundle = readFileSync(assets ? `${assets}/bundle.min.js` : new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(assets ? `${assets}/icons.js` : new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await wait(5); }
    assert.fail('migration UI did not settle');
}

// Round 5 (D5): ONE surface. While opening, the title is "Opening {App}…" and the ONE status line
// is the loading-stage sentence (the retired round-3 rule "no body line while opening" is gone);
// a hold puts the server's title and its one sentence in their place.
const copies = {
    attention: ['Your computer needs attention', 'Check the computer’s current status before trying again.'],
    unavailable: ['Opening', ''],
    paused: ['Computer startup is temporarily paused', 'Check this view later for an update.'],
    moving: ['Getting your AWS computer'],
    launching: ['A machine is ready and starting up.'],
    both: ['Getting your AWS computer'],
};
const TITLES = { code: 'Opening Code…', desktop: 'Opening Browser…', preview: 'Opening Preview…' };
const label = spinner => spinner.querySelector('.ezil-app-spinner-label').textContent;
const line = spinner => spinner.querySelector('.ezil-app-spinner-sub');

async function open(t, app, initialMode = 'moving') {
    const dom = new JSDOM('<!doctype html><div id="ezil-os-root"></div>', {
        url: 'https://app.example/os', runScripts: 'outside-only', pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    const { window: w } = dom;
    t.after(() => w.close());
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
    t.after(() => assert.deepEqual(errors, []));
    const timeout = w.setTimeout.bind(w), interval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 5000 ? 5 : ms === 1500 ? 5 : ms === 4000 ? 15 : ms, ...args);
    w.setInterval = (fn, ms, ...args) => interval(fn, ms === 250 ? 5 : ms, ...args);
    w.AbortSignal = { timeout: () => undefined };
    let mode = initialMode, now = 0, frameGate = null;
    w.Date.now = () => now;
    const asks = { desktop: 0, code: 0, preview: 0 };
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if (path.includes('/api/trpc/computer.progress')) {
            const stage = mode === 'attention' ? 'needs_operator' : mode === 'unavailable' ? 'unavailable' : mode === 'paused' ? 'operations_paused' : ['moving','both'].includes(mode) ? 'provisioning' : mode === 'waking' ? 'mounting' : 'starting';
            body = {result:{data:{json:{version:1,computerId:'computer-1',stage,recordedStage:mode==='attention'?'unconfirmed':'provisioning',operationsPaused:mode==='paused',active:mode!=='paused',operation:['moving','both','paused'].includes(mode)?'migration':'opening',durable:['moving','both','paused'].includes(mode),resumePolicy:'saved_workspace_only',bytes:{transferred:null,total:null},percent:null,etaSeconds:null}}}};
        } else if (['/api/shell/desktop', '/api/shell/code-preview-url', '/api/shell/preview-url'].includes(path) && init.method === 'POST') {
            asks[path.includes('code') ? 'code' : path.includes('preview') ? 'preview' : 'desktop']++;
            body = mode === 'ready'
                ? { ok: true, guacamoleUrl: 'https://viewer.example/?embed=1', codePreviewUrl: 'https://code.example/', appPreviewUrl: 'https://preview.example/', frame: { confirmed: true } }
                : { ok: false, errorCode: mode === 'attention' ? 'computer_recovering' : 'sandbox_starting', computeProvider: 'aws-ec2',
                    ...(['moving', 'both'].includes(mode) ? { computeMigrating: true } : {}),
                    ...(['launching', 'both'].includes(mode) ? { computeLaunching: true } : {}) };
        } else if (path.includes('confirm=frame')) { if (frameGate) await frameGate; body = { ok: true, confirmed: true, status: 200 }; }
        else if (path.startsWith('/api/shell/desktop')) body = { ok: true, guacamoleRunning: false };
        return { ok: true, status: 200, json: async () => body };
    };
    w.__EZIL_BOOT__ = {
        user: { id: 'user-1', email: 'test@example.invalid' },
        computer: { id: 'computer-1', name: 'My Computer', slot: 1, isNew: false },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', codePreviewUrl: '/api/shell/code-preview-url', previewUrl: '/api/shell/preview-url' } },
    };
    w.eval(icons); w.eval(bundle);
    await until(() => w.document.querySelector('.taskbar-item[data-app="desktop"]'));
    const registry = w.ezil.registry;
    assert.ok(registry, 'built bundle exports its app registry');
    await registry.launch(app, { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState });
    const win = await until(() => w.document.querySelector(`.window[data-app="${app}"]`));
    const spinner = win.querySelector('.ezil-app-spinner');
    await until(() => initialMode === 'unavailable' ? label(spinner).startsWith('Opening ') && spinner.dataset.progress === 'unavailable'
        : ['attention', 'paused'].includes(initialMode) ? label(spinner) === copies[initialMode][0]
        : label(spinner) === TITLES[app] && line(spinner).textContent === copies[initialMode][0]);
    const holdFrame = () => { let release; frameGate = new Promise(r => { release = r; }); return () => { frameGate = null; release(); }; };
    return { w, win, spinner, asks, holdFrame, setMode: m => { mode = m; }, setNow: ms => { now = ms; } };
}

for (const app of ['code', 'desktop', 'preview']) {
    test(`${app}: terminal mint with generic UNCONFIRMED retains the normal retry`, async t => {
        const h = await open(t, app, 'attention');
        await until(() => h.spinner.dataset.kind === 'failed');
        assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, false);
        const before = h.asks[app];
        await wait(30);
        assert.equal(h.asks[app], before, 'read-only progress does not resume the stopped mint loop');
        h.setMode('ready');
        h.spinner.querySelector('.ezil-boot-retry').click();
        await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
        assert.equal(h.asks[app], before + 1, 'normal retry opens exactly one new mint attempt');
    });
    test(`${app}: ordinary CF with no AWS record keeps physical pending app copy`, async t => {
        const h = await open(t, app, 'unavailable');
        assert.match(h.spinner.querySelector('.ezil-app-spinner-label').textContent, /^Opening /);
        assert.equal(h.spinner.querySelector('.ezil-opening-bar').dataset.indeterminate, 'true', 'no basis for a determinate bar');
        assert.equal(h.spinner.querySelector('.ezil-app-spinner-sub').hidden, true, 'one status line, no unavailable notice');
        assert.doesNotMatch(h.spinner.textContent, /Moving your computer/);
        h.setNow(480_000);
        await until(() => h.spinner.dataset.kind === 'failed');
        assert.match(h.spinner.textContent, /This is taking too long/);
        assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, false);
    });
    test(`${app}: authoritative pause wins over recorded migration and hides active transfer`, async t => {
        const h = await open(t, app, 'paused');
        assert.equal(h.spinner.querySelector('.ezil-opening-bar').hidden, true, 'a held computer shows no bar');
        assert.equal(h.spinner.querySelector('ol'), null);
        assert.equal(h.spinner.querySelector('.ezil-app-spinner-sub').textContent, copies.paused[1]);
        assert.doesNotMatch(h.spinner.textContent, /Moving your computer|\d+%/);
    });
    for (const mode of ['moving', 'launching']) {
        test(`${app}: built loader shows ${mode} copy, then ordinary progress and a ready frame beyond the old deadline`, async t => {
            const h = await open(t, app, mode);
            await wait(40); // Past the old desktop phase reveal timer: the one surface stays.
            assert.equal(h.spinner.hidden, false);
            assert.equal(label(h.spinner), TITLES[app], 'the title names the app');
            assert.equal(line(h.spinner).hidden, false, 'ONE status line: the loading stage');
            assert.equal(line(h.spinner).textContent, copies[mode][0]);
            assert.equal(h.spinner.querySelector('.ezil-opening-bar').hidden, false);
            assert.equal(h.spinner.querySelector('.ezil-opening-bar').dataset.indeterminate, undefined, 'an observed opening has a determinate bar');
            assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
            h.setNow(300_000); // Longer than the old AWS timeout.
            await wait(20);
            assert.equal(h.spinner.dataset.kind, 'progress');
            h.setMode('waking');
            await until(() => line(h.spinner).textContent === 'Your files are attached. The desktop is starting.');
            assert.equal(label(h.spinner), TITLES[app]);
            assert.equal(h.spinner.querySelector('ol'), null, 'no step list');
            assert.doesNotMatch(h.spinner.textContent, /\d+%|min left|Next session|Last recorded update/, 'no percentage text, countdown or dev line');
            // One surface: in the Desktop window the legacy `.ezil-boot` hook IS the spinner.
            const loaders = [...new Set(h.win.querySelectorAll('.ezil-app-spinner, .ezil-boot'))];
            assert.deepEqual(loaders, [h.spinner]);
            h.setNow(mode === 'moving' ? 480_000 : 400_000); // Migration restarts at commit; replacement retains its original deadline.
            h.setMode('ready');
            await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
            assert.ok(h.asks[app] > 1);
        });

        test(`${app}: ${mode} timeout keeps active progress until the calm ten-minute retry`, async t => {
            const h = await open(t, app, mode);
            h.setNow(480_000);
            await until(() => h.spinner.querySelector('.ezil-opening-meta').textContent.startsWith('Taking longer than usual · '));
            assert.equal(h.spinner.dataset.state, 'long');
            assert.equal(h.spinner.dataset.kind, 'progress');
            assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
            assert.doesNotMatch(h.spinner.textContent, /This is taking too long/);
            const bar = Number(h.spinner.querySelector('.ezil-opening-bar').dataset.percent);
            assert.ok(bar > 0 && bar < 100, `an overdue bar never reaches 100 before ready (${bar})`);
            h.setNow(599_000);
            await wait(30);
            assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
            h.setNow(600_000);
            await until(() => h.spinner.querySelector('.ezil-boot-actions').hidden === false);
            const visible = [...h.win.querySelectorAll('.ezil-app-spinner, .ezil-boot')].filter(el => !el.hidden);
            assert.ok(visible.length > 0);
            assert.ok(visible.every(el => !el.textContent.includes('This is taking too long')));
            assert.ok(visible.some(el => el.textContent.includes("This is taking longer than usual. We're still working on it — you can keep this open or come back later.")));
            assert.ok(visible.some(el => el.querySelector('.ezil-boot-actions')?.hidden === false));
            h.setMode('ready');
            h.spinner.querySelector('.ezil-boot-retry').click();
            await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
        });
    }

    if (app !== 'desktop') {
        test(`${app}: the URL answer lifts the bar to the opening-app floor; only the confirmed frame is 100 and concludes the open`, async t => {
            const h = await open(t, app, 'launching');
            const release = h.holdFrame();
            t.after(release);
            h.setMode('ready');
            const pct = () => Number(h.spinner.querySelector('.ezil-opening-bar').dataset.percent);
            await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://') && pct() >= 85);
            assert.ok(pct() < 100, `never 100 before the frame confirms (${pct()})`);
            assert.equal(h.spinner.dataset.state, 'opening');
            release();
            await until(() => h.spinner.hidden === true);
            assert.equal(h.spinner.dataset.state, 'done', 'the real ready signal concludes the open on the surface');
            assert.equal(pct(), 100);
        });
    }
    if (app === 'code') {
        test('code: a restart an hour after a confirmed open is a fresh open (no stale clock, bar or countdown)', async t => {
            const h = await open(t, app, 'launching');
            h.setMode('ready');
            await until(() => h.spinner.hidden === true);
            h.setNow(3_600_000);
            h.setMode('launching');
            h.w.dispatchEvent(new h.w.CustomEvent('ezil:desktop-restarted', { detail: { computerId: 'computer-1' } }));
            await until(() => h.spinner.hidden === false && h.spinner.dataset.kind === 'progress' && line(h.spinner).textContent === copies.launching[0]);
            await wait(30);
            assert.equal(h.spinner.dataset.state, 'opening');
            assert.doesNotMatch(h.spinner.querySelector('.ezil-opening-meta').textContent, /Taking longer|60:/);
            assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true, 'no Try again from a stale clock');
            assert.ok(! (Number(h.spinner.querySelector('.ezil-opening-bar').dataset.percent) >= 85), 'no carried opening-app floor');
        });
    }

    test(`${app}: migration copy wins when a replacement is also observed`, async t => {
        const h = await open(t, app, 'both');
        await wait(40);
        assert.equal(h.spinner.hidden, false);
        assert.equal(label(h.spinner), TITLES[app]);
        assert.equal(line(h.spinner).textContent, copies.moving[0]);
        h.setMode('ready');
        await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
    });
}
