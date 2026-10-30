import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const bundle = readFileSync(new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const origin = 'https://aws-8181-guac-test-aws.preview.example';
const bootstrap = `${origin}/preview-bootstrap?token=test-token&path=${encodeURIComponent('/?embed=1')}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    for (let i = 0; i < 200; i++) { const value = fn(); if (value) return value; await wait(5); }
    assert.fail('shell condition did not settle');
}

async function open(t, { url = bootstrap, display = 'unknown', relay = false } = {}) {
    const dom = new JSDOM('<!doctype html><div id="ezil-os-root"></div>', {
        url: 'https://app.example/os', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const { window: w } = dom;
    t.after(() => w.close());
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
    const timeout = w.setTimeout.bind(w);
    // Exercise real deadline callbacks without a minute per negative case.
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 45000 ? 180 : ms === 20000 ? 100 : ms === 1000 ? 30 : ms, ...args);
    w.AbortSignal = { timeout: () => undefined };
    let renewals = 0;
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if (path === '/relay') { renewals++; body = { ok: true, runtimeId: 'a'.repeat(32), expiresAt: Date.now() + 1_740_000 }; }
        else if (path.startsWith('/api/shell/desktop') && init.method === 'POST') body = {
            ok: true, guacamoleUrl: url, frame: { confirmed: true }, mode: 'neko',
            ...(relay ? { relay: { runtimeId: 'a'.repeat(32), expiresAt: Date.now() + 60_001 } } : {}),
        };
        else if (path.includes('confirm=frame')) body = { ok: true, confirmed: true };
        else if (path.includes('confirm=display')) body = { ok: true, display, sessions: 1 };
        else if (path.startsWith('/api/shell/desktop')) body = { ok: true, guacamoleRunning: true };
        return { ok: true, status: 200, json: async () => body };
    };
    w.__EZIL_BOOT__ = {
        user: { id: 'user-1', email: 'test@example.invalid' },
        computer: { id: 'computer-1', name: 'My Computer', slot: 1, isNew: false },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', relayRefresh: '/relay' } },
    };
    w.eval(icons); w.eval(bundle);
    await until(() => w.document.querySelector('.taskbar-item[data-app="desktop"]'));
    w.$('.taskbar-item[data-app="desktop"]').trigger('click');
    const frame = await until(() => {
        const f = w.document.querySelector('.window[data-app="desktop"] .window-app-iframe');
        return f?.src && f.src !== 'about:blank' && f;
    });
    const navigation = new URL(frame.src);
    // Reproduce aws-origin.ts's bootstrap Location, then its autoconnect
    // redirect. Neither copies arbitrary outer bootstrap query parameters.
    const rawDestination = navigation.searchParams.get('path') || '/';
    const destination = navigation.pathname === '/preview-bootstrap'
        ? new URL(rawDestination.startsWith('/') && !rawDestination.startsWith('//') ? rawDestination : '/', navigation)
        : navigation;
    if (navigation.pathname === '/preview-bootstrap') {
        destination.searchParams.set('usr', 'EZiL'); destination.searchParams.set('pwd', 'ezil-preview');
        destination.searchParams.set('embed', '1');
        assert.equal(navigation.searchParams.get('token'), 'test-token');
        if (new URL(url).searchParams.get('path')?.includes('embed=1')) assert.equal(destination.searchParams.get('embed'), '1');
    }
    frame.dispatchEvent(new w.Event('load'));
    const win = w.document.querySelector('.window[data-app="desktop"]');
    const emit = (count, changes = {}, envelope = {}) => w.dispatchEvent(new w.MessageEvent('message', {
        source: frame.contentWindow, origin: destination.origin,
        data: { source: 'ezil-mobile', type: 'stream_vitals', attempt: destination.searchParams.get('ezilAttempt'),
            vitals: { connectionState: 'connected', bytesReceived: count * 100, framesDecoded: count, width: 1920, height: 1080, ...changes } },
        ...envelope,
    }));
    t.after(() => assert.deepEqual(errors, []));
    return { win, navigation, destination, emit, renewals: () => renewals };
}

test('AWS streaming viewer survives both redirects and confirms live despite the admin-only API snapshot', async t => {
    const h = await open(t, { display: 'unknown' });
    assert.ok(h.destination.searchParams.get('ezilAttempt'));
    assert.equal(h.destination.searchParams.get('ezilAttempt'), h.navigation.searchParams.get('ezilAttempt'));
    h.emit(526); h.emit(902);
    await until(() => h.win.classList.contains('ezil-fullbleed'));
    assert.equal(h.win.querySelector('.ezil-boot').dataset.kind, 'ready');
});

test('AWS blank viewer stays covered and reaches Retry even if another API session is watching', async t => {
    const h = await open(t, { display: 'live' });
    h.emit(0); h.emit(0);
    await until(() => h.win.querySelector('.ezil-boot')?.dataset.kind === 'failed');
    assert.equal(h.win.classList.contains('ezil-fullbleed'), false);
});

test('AWS rejects foreign and previous-navigation frame evidence', async t => {
    const h = await open(t);
    h.emit(1, {}, { origin: 'https://foreign.example' }); h.emit(2, {}, { origin: 'https://foreign.example' });
    h.emit(1, {}, { data: { source: 'ezil-mobile', type: 'stream_vitals', attempt: 'previous-navigation' } });
    await until(() => h.win.querySelector('.ezil-boot')?.dataset.kind === 'failed');
    assert.equal(h.win.classList.contains('ezil-fullbleed'), false);
});

test('AWS renewal receives current viewer confirmation and does not repeat the 20-second retry loop', async t => {
    const h = await open(t, { relay: true });
    let count = 1;
    const frames = setInterval(() => h.emit(count++), 10);
    t.after(() => clearInterval(frames));
    await until(() => h.win.dataset.relayState === 'connected');
    await wait(180);
    assert.equal(h.renewals(), 1);
    assert.equal(h.win.querySelector('.ezil-boot').dataset.kind, 'ready');
});

test('Cloudflare direct viewer URL still confirms live without a bootstrap', async t => {
    const h = await open(t, { url: 'https://cf-viewer.example/?embed=1', display: 'live' });
    assert.equal(h.navigation.searchParams.has('path'), false);
    h.emit(1); h.emit(2);
    await until(() => h.win.classList.contains('ezil-fullbleed'));
});

test('a foreign bootstrap destination is left for the server to reject or sanitize', async t => {
    for (const path of ['https://foreign.example/?embed=1', '//foreign.example/?embed=1']) {
        const h = await open(t, { url: `${origin}/preview-bootstrap?token=test-token&path=${encodeURIComponent(path)}` });
        assert.equal(h.navigation.searchParams.get('path'), path);
        assert.equal(h.win.classList.contains('ezil-fullbleed'), false);
    }
});
