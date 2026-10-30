// Run: node --test shell/ezil/apps/frame-confirmation-test.mjs
// Exercise the committed bundle with a virtual clock and a stubbed authenticated
// transport. No resources are fetched; iframe load is deliberately absent unless
// a test dispatches it. This proves scheduling and gating, not editor pixels.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const out = process.env.EZIL_SHELL_OUT_DIR || new URL('../../../app/public/os/', import.meta.url);
const asset = name => fs.readFileSync(new URL(name, typeof out === 'string' ? `file://${out}/` : out), 'utf8');
const bundle = asset('bundle.min.js');
const icons = asset('icons.js');

async function open(app, answer) {
    const dom = new JSDOM('<div id="ezil-os-root"></div>', {
        url: 'https://ezil.local/os', runScripts: 'outside-only', pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    const w = dom.window;
    w.focus = () => {};
    const observers = [];
    const Observer = w.MutationObserver;
    w.MutationObserver = class extends Observer {
        constructor(callback) { super(callback); observers.push(this); }
    };
    let now = 0, nextId = 0;
    const timers = new Map();
    const schedule = (fn, ms, repeat, args) => {
        const id = ++nextId;
        timers.set(id, { fn, at: now + Number(ms || 0), repeat, args });
        return id;
    };
    w.setTimeout = (fn, ms, ...args) => schedule(fn, ms, 0, args);
    w.setInterval = (fn, ms, ...args) => schedule(fn, ms, Math.max(1, ms), args);
    w.clearTimeout = w.clearInterval = id => timers.delete(id);
    w.performance.now = () => now;
    const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
    async function advance(ms) {
        const end = now + ms;
        await flush();
        let turns = 0;
        while (true) {
            const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            assert.ok(++turns < 10000, 'virtual clock must not spin');
            const [id, timer] = due;
            now = timer.at;
            if (timer.repeat) timer.at += timer.repeat;
            else timers.delete(id);
            timer.fn(...timer.args);
            await flush();
        }
        now = end;
        await flush();
    }
    const calls = [];
    const mints = [];
    const json = data => ({ ok: true, status: 200, json: async () => data });
    const frameUrl = `https://${app === 'code' ? '8443-code' : '3002-app'}.example/preview-bootstrap?token=test`;
    w.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), w.location.href);
        if (u.searchParams.get('confirm') === 'frame') {
            calls.push({ at: now, url: u, opts });
            const confirmed = await answer({ now, count: calls.length, window: w });
            // Use real Response objects for HTTP envelope/error parsing tests.
            if (confirmed instanceof Response) return confirmed;
            return json(confirmed === undefined ? { ok: false }
                : typeof confirmed === 'object' ? { ok: true, ...confirmed }
                    : { ok: true, confirmed, status: confirmed ? 200 : 500 });
        }
        if (u.pathname.endsWith('/code-preview-url')) {
            mints.push({ at: now, url: u, opts });
            return json({ ok: true, codePreviewUrl: frameUrl });
        }
        if (u.pathname.endsWith('/preview-url')) return json({ ok: true, appPreviewUrl: frameUrl });
        return json({ ok: true, guacamoleRunning: true });
    };
    const payload = {
        user: { id: 'u-1', email: 'test@example.com' },
        computer: { id: 'c-1', name: 'Computer', slot: 1 },
        apps: [{ id: 'desktop', name: 'Browser', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle' },
    };
    w.__EZIL_BOOT__ = payload;
    w.eval(icons);
    w.eval(bundle);
    w.ezil.boot();
    await advance(0);
    const launch = w.ezil.registry.launch(app, { payload, computer: payload.computer, desktopState: payload.desktopState });
    await advance(0);
    await launch;
    const win = w.document.querySelector(`.window[data-app="${app}"]`);
    assert.ok(win, `${app} window opens`);
    const frame = win.querySelector('.window-app-iframe');
    assert.equal(frame.src, frameUrl);
    const panel = win.querySelector('[data-kind]');
    let navigations = 0;
    new w.MutationObserver(records => {
        navigations += records.filter(r => r.attributeName === 'src').length;
    }).observe(frame, { attributes: true });
    return { w, win, frame, panel, calls, mints, advance, frameUrl, get navigations() { return navigations; }, close: () => {
        w.dispatchEvent(new w.Event('ezil:teardown'));
        for (const observer of observers) observer.disconnect();
        dom.window.close();
    } };
}

const starting = (status = 502) => ({ confirmed: false, reason: 'http_error', status });

for (const status of [401, 403]) {
    for (const body of ['json-error', 'non-json', 'contradictory-success']) {
        test(`code: actual HTTP ${status} ${body} is terminal before a later healthy response`, async () => {
            const h = await open('code', ({ count }) => count > 1 ? true
                : body === 'non-json' ? new Response('Access denied', { status })
                    : Response.json(body === 'json-error'
                        ? { error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' } }
                        : { ok: true, confirmed: true, status: 200 }, { status }));
            try {
                await h.advance(500);
                assert.equal(h.panel.hidden, false);
                assert.equal(h.panel.dataset.kind, 'failed');
                h.frame.dispatchEvent(new h.w.Event('load'));
                await h.advance(60000);
                assert.equal(h.calls.length, 1, 'transport auth refusal never re-probes');
                assert.equal(h.navigations, 0, 'transport auth refusal never reloads');
                assert.equal(h.mints.length, 1, 'no extra provider open');
            } finally { h.close(); }
        });
    }
}

for (const reply of [
    { confirmed: true, reason: 'not_own_origin', status: 403 },
    { confirmed: true, reason: 'not_own_origin', status: 200 },
    { confirmed: true, reason: null, status: 200 },
    { confirmed: true },
    { confirmed: true, status: 403 },
    { confirmed: true, status: 500 },
    { confirmed: true, status: '200' },
    { confirmed: true, status: null },
    { confirmed: true, status: 199 },
    { confirmed: true, status: 200.5 },
    { ok: false, confirmed: true, status: 200 },
]) {
    test(`code: malformed post-reload confirmation ${JSON.stringify(reply)} stays terminal`, async () => {
        const h = await open('code', ({ count }) => count === 1 ? starting()
            : count === 3 ? Response.json({ ok: true, ...reply }) : true);
        try {
            await h.advance(1000);
            assert.equal(h.navigations, 1, 'healthy recovery reloads once');
            assert.equal(h.panel.hidden, false, 'replacement must be confirmed');
            h.frame.dispatchEvent(new h.w.Event('load'));
            await h.advance(0);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'failed');
            h.frame.dispatchEvent(new h.w.Event('load'));
            await h.advance(60000);
            assert.equal(h.calls.length, 3, 'malformed confirmation never reaches the later healthy response');
            assert.equal(h.navigations, 1, 'no further reload');
            assert.equal(h.mints.length, 1, 'no extra provider open');
        } finally { h.close(); }
    });
}

for (const status of [200, 204, 302, 399]) {
    test(`code: valid HTTP ${status} positive confirmation preserves the warm fast path`, async () => {
        const h = await open('code', () => Response.json({ ok: true, confirmed: true, status }));
        try {
            await h.advance(500);
            assert.equal(h.panel.hidden, true);
            assert.equal(h.navigations, 0);
            assert.equal(h.calls.length, 1);
            assert.equal(h.mints.length, 1);
            await h.advance(60000);
            assert.equal(h.calls.length, 1);
        } finally { h.close(); }
    });
}

test('code: a cold backend recovers automatically, reloads the error document and reconfirms', async () => {
    const h = await open('code', ({ now }) => now < 15000 ? starting() : true);
    let navigations = 0;
    const observer = new h.w.MutationObserver(records => {
        navigations += records.filter(r => r.attributeName === 'src').length;
    });
    observer.observe(h.frame, { attributes: true });
    try {
        h.frame.dispatchEvent(new h.w.Event('load')); // The original 502 document loads normally.
        await h.advance(10000);
        assert.equal(h.panel.dataset.kind, 'progress', 'cold boot is not immediately fatal');
        assert.equal(h.panel.hidden, false);
        await h.advance(12000);
        assert.equal(navigations, 1, 'health recovery replaces the already loaded error page');
        assert.equal(h.panel.hidden, false, 'server health alone cannot reveal the stale document');
        const asks = h.calls.length;
        h.frame.dispatchEvent(new h.w.Event('load'));
        await h.advance(0);
        assert.equal(h.calls.length, asks + 1, 'the replacement document is reconfirmed');
        assert.equal(h.panel.hidden, true);
        await h.advance(60000);
        assert.equal(h.calls.length, asks + 1, 'success cancels recovery');
    } finally { observer.disconnect(); h.close(); }
});

for (const reply of [starting(500), starting(502), starting(503), starting(504),
    { confirmed: false, reason: 'unreachable' }]) {
    test(`code: ${JSON.stringify(reply)} retries but stays bounded`, async () => {
        const h = await open('code', () => reply);
        try {
            await h.advance(1000);
            assert.equal(h.panel.dataset.kind, 'progress');
            await h.advance(45000);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'failed');
            assert.ok(h.calls.length > 1 && h.calls.length <= 12);
            const count = h.calls.length;
            await h.advance(60000);
            assert.equal(h.calls.length, count);
        } finally { h.close(); }
    });
}

for (const reply of [starting(401), starting(403), starting(410),
    { confirmed: false, reason: 'not_own_origin', status: 503 },
    { confirmed: false, reason: 'provider_not_configured' },
    { confirmed: false }]) {
    test(`code: refusal ${JSON.stringify(reply)} never retries or reloads`, async () => {
        const h = await open('code', () => reply);
        try {
            await h.advance(500);
            assert.equal(h.panel.dataset.kind, 'failed');
            await h.advance(60000);
            assert.equal(h.calls.length, 1);
        } finally { h.close(); }
    });
}

test('code: recovered health without a replacement load never removes the panel', async () => {
    const h = await open('code', ({ count }) => count === 1 ? starting() : true);
    try {
        await h.advance(45000);
        assert.equal(h.panel.hidden, false);
        assert.equal(h.panel.dataset.kind, 'failed');
        h.frame.dispatchEvent(new h.w.Event('load'));
        await h.advance(1000);
        assert.equal(h.panel.hidden, false);
        assert.equal(h.calls.length, 2, 'late load cannot overwrite the deadline');
    } finally { h.close(); }
});

test('code: disposal cancels a scheduled cold-backend recovery', async () => {
    const h = await open('code', () => starting());
    try {
        await h.advance(500);
        await h.win.on_before_exit();
        await h.advance(60000);
        assert.equal(h.calls.length, 1);
    } finally { h.close(); }
});

test('code: a refusal on the replacement document stays terminal', async () => {
    const h = await open('code', ({ count }) => count === 1 ? starting()
        : count === 2 ? true : { confirmed: false, reason: 'not_own_origin' });
    try {
        await h.advance(1000);
        assert.equal(h.panel.hidden, false);
        h.frame.dispatchEvent(new h.w.Event('load'));
        await h.advance(60000);
        assert.equal(h.panel.dataset.kind, 'failed');
        assert.equal(h.calls.length, 3);
    } finally { h.close(); }
});

test('code: a URL replaced during recovery cannot be reloaded or revealed', async () => {
    let resolve;
    const h = await open('code', ({ count }) => count === 1 ? starting()
        : new Promise(r => { resolve = r; }));
    try {
        await h.advance(1000);
        h.frame.src = 'https://foreign.example/';
        resolve(true);
        await h.advance(0);
        assert.equal(h.frame.src, 'https://foreign.example/');
        assert.equal(h.panel.hidden, false);
        assert.equal(h.panel.dataset.kind, 'failed');
        await h.advance(60000);
        assert.equal(h.calls.length, 2);
    } finally { h.close(); }
});

test('code: repeated recoveries share the request cap and never reveal an unconfirmed replacement', async () => {
    const h = await open('code', ({ count }) => count % 2 ? starting() : true);
    const observer = new h.w.MutationObserver(records => {
        if (records.some(r => r.attributeName === 'src')) h.frame.dispatchEvent(new h.w.Event('load'));
    });
    observer.observe(h.frame, { attributes: true });
    try {
        await h.advance(45000);
        assert.equal(h.panel.hidden, false);
        assert.equal(h.panel.dataset.kind, 'failed');
        assert.equal(h.calls.length, 12);
        await h.advance(60000);
        assert.equal(h.calls.length, 12);
    } finally { observer.disconnect(); h.close(); }
});

for (const app of ['code', 'preview']) {
    test(`${app}: confirms without load and removes the loader before 4 s`, async () => {
        const h = await open(app, () => true);
        try {
            assert.equal(h.panel.hidden, false);
            await h.advance(249);
            assert.equal(h.calls.length, 0);
            await h.advance(251);
            assert.equal(h.calls.length, 1);
            assert.ok(h.calls[0].at >= 250 && h.calls[0].at <= 500);
            assert.equal(h.calls[0].opts.credentials, 'same-origin');
            assert.equal(h.calls[0].url.searchParams.get('computerId'), 'c-1');
            assert.equal(h.calls[0].url.searchParams.get('frameUrl'), h.frameUrl);
            assert.equal(h.panel.hidden, true);
            await h.advance(10000);
            assert.equal(h.calls.length, 1, 'success cancels later probes');
        } finally { h.close(); }
    });

    test(`${app}: a late confirmation still succeeds after 6 s`, async () => {
        const h = await open(app, ({ now }) => now >= 6000 ? true : undefined);
        try {
            await h.advance(3999);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'progress');
            assert.ok(h.calls.length >= 3, 'polls early instead of waiting 4 s');
            await h.advance(4001);
            assert.equal(h.panel.hidden, true);
            assert.ok(h.calls.length <= 6);
        } finally { h.close(); }
    });

    test(`${app}: explicit refusal keeps the failure panel and never retries`, async () => {
        const h = await open(app, () => false);
        try {
            await h.advance(500);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'failed');
            h.frame.dispatchEvent(new h.w.Event('load'));
            await h.advance(45000);
            assert.equal(h.calls.length, 1);
        } finally { h.close(); }
    });

    test(`${app}: unknown answers exhaust a spaced, finite retry budget`, async () => {
        const h = await open(app, () => undefined);
        try {
            await h.advance(6999);
            assert.equal(h.panel.dataset.kind, 'progress', 'retains the old late retry window');
            await h.advance(1);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'failed');
            assert.equal(h.calls.length, 6);
            for (let i = 1; i < h.calls.length; i++) assert.ok(h.calls[i].at - h.calls[i - 1].at >= 500);
            await h.advance(60000);
            assert.equal(h.calls.length, 6);
        } finally { h.close(); }
    });

    test(`${app}: load and timer cannot overlap an in-flight confirmation`, async () => {
        const h = await open(app, ({ window }) => new Promise(resolve => window.setTimeout(() => resolve(true), 2000)));
        try {
            await h.advance(400);
            h.frame.dispatchEvent(new h.w.Event('load'));
            h.frame.dispatchEvent(new h.w.Event('load'));
            await h.advance(1000);
            assert.equal(h.calls.length, 1);
            assert.equal(h.panel.hidden, false, 'load alone is not readiness');
            await h.advance(2000);
            assert.equal(h.panel.hidden, true);
            assert.equal(h.calls.length, 1);
        } finally { h.close(); }
    });

    test(`${app}: load can trigger confirmation immediately but is not a verdict`, async () => {
        let resolve;
        const h = await open(app, () => new Promise(r => { resolve = r; }));
        try {
            h.frame.dispatchEvent(new h.w.Event('load'));
            await h.advance(0);
            assert.equal(h.calls.length, 1);
            assert.equal(h.calls[0].at, 0);
            assert.equal(h.panel.hidden, false);
            resolve(true);
            await h.advance(500);
            assert.equal(h.panel.hidden, true);
            assert.equal(h.calls.length, 1);
        } finally { h.close(); }
    });

    test(`${app}: confirmation for a replaced URL cannot reveal the new frame`, async () => {
        let resolve;
        const h = await open(app, () => new Promise(r => { resolve = r; }));
        try {
            await h.advance(500);
            h.frame.src = 'https://foreign.example/';
            resolve(true);
            await h.advance(0);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'failed');
            assert.equal(h.calls[0].url.searchParams.get('frameUrl'), h.frameUrl);
        } finally { h.close(); }
    });

    test(`${app}: deadline rejects late results and disposal cancels probes`, async () => {
        let resolve;
        const h = await open(app, () => new Promise(r => { resolve = r; }));
        try {
            await h.advance(45000);
            assert.equal(h.panel.hidden, false);
            assert.equal(h.panel.dataset.kind, 'failed');
            resolve?.(true);
            await h.advance(10000);
            assert.equal(h.panel.hidden, false, 'late success cannot overwrite timeout');
            assert.equal(h.calls.length, 1);
        } finally { h.close(); }
        const disposed = await open(app, () => true);
        try {
            await disposed.win.on_before_exit();
            disposed.frame.dispatchEvent(new disposed.w.Event('load'));
            await disposed.advance(45000);
            assert.equal(disposed.calls.length, 0);
        } finally { disposed.close(); }
    });
}
