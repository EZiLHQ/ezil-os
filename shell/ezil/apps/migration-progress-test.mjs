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

// Hotfix 3: an AWS opening shows ONE loading-stage sentence keyed by the server's reached milestone
// (receipts-hf3 reached1-opening.png); moving and ordinary Cloudflare opens keep one status line
// (no body); hold states keep one sentence.
const copies = {
    attention: ['Your computer needs attention', 'Check the computer’s current status before trying again.'],
    unavailable: ['Opening', ''],
    paused: ['Computer startup is temporarily paused', 'Check this view later for an update.'],
    moving: ['Getting your AWS computer', ''],
    launching: ['Starting your computer', 'A machine is ready and starting up.'],
    both: ['Getting your AWS computer', ''],
};

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
    let mode = initialMode, now = 0;
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
        } else if (path.includes('confirm=frame')) body = { ok: true, confirmed: true, status: 200 };
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
    await until(() => initialMode === 'unavailable' ? spinner.querySelector('.ezil-app-spinner-label').textContent.startsWith('Opening ') && spinner.dataset.progress === 'unavailable' : spinner.querySelector('.ezil-app-spinner-label').textContent === copies[initialMode][0]);
    return { w, win, spinner, asks, setMode: m => { mode = m; }, setNow: ms => { now = ms; } };
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
            await wait(40); // Past the desktop phase reveal timer: observed copy must remain visible.
            assert.equal(h.spinner.hidden, false);
            const sub = h.spinner.querySelector('.ezil-app-spinner-sub');
            if (mode === 'moving') assert.equal(sub.hidden, true, 'one status line while moving');
            else {
                assert.equal(sub.hidden, false, 'opening shows its loading-stage sentence');
                assert.equal(sub.textContent, copies.launching[1]);
            }
            assert.equal(h.spinner.querySelector('.ezil-opening-bar').hidden, false);
            assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
            h.setNow(300_000); // Longer than the old AWS timeout.
            await wait(20);
            assert.equal(h.spinner.dataset.kind, 'progress');
            h.setMode('waking');
            await until(() => h.spinner.querySelector('.ezil-app-spinner-label').textContent === 'Attaching your files');
            assert.equal(h.spinner.querySelector('.ezil-app-spinner-sub').textContent, 'Your files are attached. The desktop is starting.');
            assert.equal(h.spinner.querySelector('ol'), null, 'no step list');
            assert.doesNotMatch(h.spinner.textContent, /\d+%|min left/, 'no percentage text or countdown');
            if (app === 'desktop') {
                assert.equal(h.spinner.hidden, false);
                assert.equal(h.win.querySelector('.ezil-boot').hidden, true);
            }
            h.setNow(mode === 'moving' ? 480_000 : 400_000); // Migration restarts at commit; replacement retains its original deadline.
            h.setMode('ready');
            await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
            assert.ok(h.asks[app] > 1);
        });

        test(`${app}: ${mode} timeout keeps active progress until the calm ten-minute retry`, async t => {
            const h = await open(t, app, mode);
            h.setNow(480_000);
            await until(() => h.spinner.querySelector('.ezil-opening-meta').textContent.startsWith('Taking a little longer than usual'));
            assert.equal(h.spinner.dataset.kind, 'progress');
            assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
            assert.doesNotMatch(h.spinner.textContent, /This is taking too long/);
            const bar = Number(h.spinner.querySelector('.ezil-opening-bar').getAttribute('aria-valuenow'));
            assert.ok(bar > 0 && bar <= 90, `an overdue bar holds below 90% until ready (${bar})`);
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

    test(`${app}: migration copy wins when a replacement is also observed`, async t => {
        const h = await open(t, app, 'both');
        await wait(40);
        assert.equal(h.spinner.hidden, false);
        assert.equal(h.spinner.querySelector('.ezil-app-spinner-label').textContent, copies.moving[0]);
        assert.equal(h.spinner.querySelector('.ezil-app-spinner-sub').textContent, copies.moving[1]);
        h.setMode('ready');
        await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
    });
}
