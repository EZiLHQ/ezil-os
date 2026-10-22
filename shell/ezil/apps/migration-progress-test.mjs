// Runs the committed shell bundle; all HTTP responses and time are local fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const bundle = readFileSync(new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await wait(5); }
    assert.fail('migration UI did not settle');
}

async function open(t, app) {
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
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 1500 ? 5 : ms === 4000 ? 15 : ms, ...args);
    w.setInterval = (fn, ms, ...args) => interval(fn, ms === 250 ? 5 : ms, ...args);
    w.AbortSignal = { timeout: () => undefined };
    let mode = 'moving', now = 0;
    w.Date.now = () => now;
    const asks = { desktop: 0, code: 0 };
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if ((path === '/api/shell/desktop' || path === '/api/shell/code-preview-url') && init.method === 'POST') {
            asks[path.includes('code') ? 'code' : 'desktop']++;
            body = mode === 'ready'
                ? { ok: true, guacamoleUrl: 'https://viewer.example/?embed=1', codePreviewUrl: 'https://code.example/', frame: { confirmed: true } }
                : { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2',
                    ...(mode === 'moving' ? { computeMigrating: true } : {}) };
        } else if (path.includes('confirm=frame')) body = { ok: true, confirmed: true };
        else if (path.startsWith('/api/shell/desktop')) body = { ok: true, guacamoleRunning: false };
        return { ok: true, status: 200, json: async () => body };
    };
    w.__EZIL_BOOT__ = {
        user: { id: 'user-1', email: 'test@example.invalid' },
        computer: { id: 'computer-1', name: 'My Computer', slot: 1, isNew: false },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', codePreviewUrl: '/api/shell/code-preview-url' } },
    };
    w.eval(icons); w.eval(bundle);
    await until(() => w.document.querySelector('.taskbar-item[data-app="desktop"]'));
    const registry = w.ezil.registry;
    assert.ok(registry, 'built bundle exports its app registry');
    await registry.launch(app, { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState });
    const win = await until(() => w.document.querySelector(`.window[data-app="${app}"]`));
    const spinner = win.querySelector('.ezil-app-spinner');
    await until(() => spinner.querySelector('.ezil-app-spinner-label').textContent === 'Moving your computer to Mumbai');
    return { w, win, spinner, asks, setMode: m => { mode = m; }, setNow: ms => { now = ms; } };
}

for (const app of ['code', 'desktop']) {
    test(`${app}: built loader shows migration copy, then ordinary progress after commit`, async t => {
        const h = await open(t, app);
        await wait(40); // Past the desktop phase reveal timer: migration copy must remain visible.
        assert.equal(h.spinner.hidden, false);
        assert.equal(h.spinner.querySelector('.ezil-app-spinner-sub').textContent,
            'This first start takes a few minutes. Your files come with you.');
        assert.equal(h.spinner.querySelector('.ezil-boot-actions').hidden, true);
        h.setNow(300_000); // Longer than the old AWS timeout.
        await wait(20);
        assert.equal(h.spinner.dataset.kind, 'progress');
        h.setMode('waking');
        await until(() => h.spinner.querySelector('.ezil-app-spinner-label').textContent.startsWith('Opening '));
        assert.equal(h.spinner.querySelector('.ezil-app-spinner-sub').hidden, true);
        if (app === 'desktop') {
            assert.equal(h.spinner.hidden, true);
            assert.equal(h.win.querySelector('.ezil-boot').hidden, false);
        }
        h.setNow(480_000); // Still inside the AWS budget restarted at commit.
        h.setMode('ready');
        await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://'));
        assert.ok(h.asks[app === 'code' ? 'code' : 'desktop'] > 1);
    });

    test(`${app}: migration timeout retains the existing taking-too-long and Retry path`, async t => {
        const h = await open(t, app);
        h.setNow(480_000);
        await until(() => h.spinner.dataset.kind === 'failed');
        const visible = [...h.win.querySelectorAll('.ezil-app-spinner, .ezil-boot')].filter(el => !el.hidden);
        assert.ok(visible.length > 0);
        assert.ok(visible.some(el => el.textContent.includes('This is taking too long')));
        assert.ok(visible.some(el => el.textContent.includes('background')));
        assert.ok(visible.some(el => el.querySelector('.ezil-boot-actions')?.hidden === false));
    });
}
