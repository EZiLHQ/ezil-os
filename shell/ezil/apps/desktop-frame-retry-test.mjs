// Run: node --test shell/ezil/apps/desktop-frame-retry-test.mjs
//
// G12 (PROD-COMPUTERS-PLAN §6.3): the desktop window's frame check
// (`settle_frame` in `desktop-window.js`) used to give up after three asks in
// total, so one unanswered check (our 12 s status timeout) after two negatives
// was final, and so was a negative whose `desktopRunning` read did not answer.
// These drive the COMMITTED bundle (`app/public/os`, rebuilt by
// `shell/build-shell.sh`) with a virtual clock and stubbed HTTP, and pin:
//   - unanswered checks are re-asked until the boot deadline, on a bounded
//     backoff (1.5 s, 3 s, 6 s, then every 8 s), and a later yes confirms;
//   - a negative is re-asked while the computer is not known to be down
//     (`desktopRunning` true OR unknown), and fails at once when it is down;
//   - our own route's refusal (403) stays terminal at once;
//   - while it asks, the opening surface shows progress, never the terminal
//     "isn't answering" (the old 45 s paint deadline), and the failure at the
//     deadline carries asks/running/elapsed_ms telemetry.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const out = process.env.EZIL_SHELL_OUT_DIR || new URL('../../../app/public/os/', import.meta.url);
const asset = name => fs.readFileSync(new URL(name, typeof out === 'string' ? `file://${out}/` : out), 'utf8');
const bundle = asset('bundle.min.js');
const icons = asset('icons.js');

const URL_OK = 'https://preview.example.invalid/guac/abc';
/** The window's boot budget (session.DESKTOP_BOOT_TIMEOUT_MS); the mint resolves at t≈0 here. */
const DEADLINE_MS = 215_000;

/**
 * Open the desktop window on a virtual clock.
 * @param {{ frame: (n: number) => 'none' | boolean | object | Response,
 *           running?: () => boolean | undefined, minted?: object }} opts
 *   `frame` answers the nth `confirm=frame`: 'none' = OUR request failed (503),
 *   a boolean = an observation, an object = the JSON body, a Response = as is.
 *   `running` answers `guacamoleRunning` (undefined = the status read failed).
 */
async function open({ frame, running = () => true, minted = {} }) {
    const dom = new JSDOM('<div id="ezil-os-root"></div>', {
        url: 'https://ezil.local/os', runScripts: 'outside-only', pretendToBeVisual: true,
        virtualConsole: new VirtualConsole(),
    });
    const w = dom.window;
    w.focus = () => {};
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
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
            assert.ok(++turns < 20000, 'virtual clock must not spin');
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
    const asks = [];
    const statusReads = [];
    const telemetry = [];
    const warns = [];
    w.console.warn = (...a) => warns.push(a.join(' '));
    w.console.error = () => {};
    w.console.info = () => {};
    const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    w.fetch = async (url, opts = {}) => {
        const u = new URL(String(url), w.location.href);
        if (u.pathname === '/api/shell/telemetry') {
            telemetry.push(...(JSON.parse(opts.body ?? '{}').events ?? []));
            return json({ ok: true });
        }
        if (u.pathname === '/api/shell/desktop' && (opts.method ?? 'GET') === 'POST') {
            return json({ ok: true, guacamoleUrl: URL_OK, controlMode: 'interactive', mode: 'neko', ...minted });
        }
        if (u.searchParams.get('confirm') === 'frame') {
            asks.push(now);
            const a = frame(asks.length);
            if (a instanceof Response) return a;
            if (a === 'none') return json({}, 503);
            return json(typeof a === 'object' ? { ok: true, ...a } : { ok: true, confirmed: a, status: a ? 200 : 502, ...(a ? {} : { reason: 'http_error' }) });
        }
        if (u.searchParams.get('confirm') === 'display') return json({ ok: true, display: 'live' });
        if (u.pathname === '/api/shell/desktop') {
            statusReads.push(now);
            const r = running();
            return r === undefined ? json({}, 503) : json({ ok: true, guacamoleRunning: r });
        }
        return json({ ok: true });
    };
    const payload = {
        user: { id: 'u-1', email: 'test@example.com' },
        computer: { id: 'c-1', name: 'Computer', slot: 1 },
        apps: [{ id: 'desktop', name: 'Browser', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', telemetry: '/api/shell/telemetry' } },
    };
    w.__EZIL_BOOT__ = payload;
    w.eval(icons);
    w.eval(bundle);
    w.ezil.boot();
    await advance(0);
    const launch = w.ezil.registry.launch('desktop', { payload, computer: payload.computer, desktopState: payload.desktopState });
    await advance(0);
    await launch;
    await advance(0);
    const win = w.document.querySelector('.window[data-app="desktop"]');
    assert.ok(win, 'desktop window opens');
    const iframe = win.querySelector('.window-app-iframe');
    assert.ok(iframe?.src?.startsWith(URL_OK), `the desktop frame navigated (${iframe?.src})`);
    // Start the frame check now rather than at the 4 s fallback.
    iframe.dispatchEvent(new w.Event('load'));
    await advance(0);
    const kinds = () => [win.querySelector('.ezil-boot')?.dataset.kind, win.querySelector('.ezil-app-spinner')?.dataset.kind];
    const failed = () => kinds().includes('failed');
    /** The viewer reports decoded frames (jsdom cannot decode video; boot-test uses the same wiring). */
    const emitViewerFrames = () => {
        const url = new URL(iframe.src);
        for (const count of [1, 2]) w.dispatchEvent(new w.MessageEvent('message', {
            source: iframe.contentWindow, origin: url.origin,
            data: { source: 'ezil-mobile', type: 'stream_vitals', attempt: url.searchParams.get('ezilAttempt'),
                vitals: { connectionState: 'connected', bytesReceived: count * 100, framesDecoded: count, width: 1280, height: 720 } },
        }));
    };
    const events = async () => { w.dispatchEvent(new w.Event('pagehide')); await advance(0); return telemetry; };
    return {
        w, win, asks, statusReads, warns, errors, advance, kinds, failed, emitViewerFrames, events,
        get now() { return now; },
        close: () => { w.dispatchEvent(new w.Event('ezil:teardown')); dom.window.close(); },
    };
}

/** Advance in steps, asserting the surface never shows a failure on the way. */
async function advanceWithoutFailure(h, ms, step = 1_000) {
    for (let t = 0; t < ms; t += step) {
        await h.advance(Math.min(step, ms - t));
        assert.equal(h.failed(), false, `no failure at ${h.now} ms (${h.kinds()})`);
    }
}

test('desktop: five unanswered frame checks, then a yes: the frame confirms (the old rule failed at the third)', async () => {
    const h = await open({ frame: n => n <= 5 ? 'none' : true });
    try {
        await advanceWithoutFailure(h, 40_000);
        assert.equal(h.asks.length, 6, `asked until the yes (${h.asks})`);
        await advanceWithoutFailure(h, 20_000);
        assert.equal(h.asks.length, 6, 'a confirmed frame is not asked about again');
        // Positive control: the frame check really released the display gate.
        h.emitViewerFrames();
        await h.advance(2_000);
        assert.ok(h.win.classList.contains('ezil-fullbleed'), `revealed (${h.kinds()})`);
        assert.deepEqual(h.errors, []);
    } finally { h.close(); }
});

test('desktop: unanswered until the deadline shows progress past 45 s, fails AT the deadline, and backs off', async () => {
    const h = await open({ frame: () => 'none' });
    try {
        await advanceWithoutFailure(h, 46_000);
        assert.ok(h.kinds().includes('progress'), `still opening past the old 45 s paint deadline (${h.kinds()})`);
        await advanceWithoutFailure(h, DEADLINE_MS - 46_000 - 1_000);
        assert.equal(h.failed(), false, 'not before the deadline');
        await h.advance(2_000);
        assert.equal(h.failed(), true, `failed at the deadline (${h.kinds()})`);
        assert.equal(h.win.querySelector('.ezil-boot-title')?.textContent, "Your desktop isn't answering");
        // Bounded backoff: 1.5 s, 3 s, 6 s, then 8 s at most, the last clamped to the deadline.
        const gaps = h.asks.slice(1).map((at, i) => at - h.asks[i]);
        assert.deepEqual(gaps.slice(0, 5), [1_500, 3_000, 6_000, 8_000, 8_000], `gaps ${gaps}`);
        assert.ok(gaps.every(g => g <= 8_000), `capped (${gaps})`);
        assert.ok(h.asks.at(-1) >= DEADLINE_MS - 1 && h.asks.at(-1) <= DEADLINE_MS + 1, `last ask at the deadline (${h.asks.at(-1)})`);
        // Bounded by the deadline, not unbounded polling: at most one ask per 8 s after the ramp.
        assert.ok(h.asks.length <= 4 + Math.ceil(DEADLINE_MS / 8_000), `bounded asks (${h.asks.length})`);
        const asksAtFailure = h.asks.length;
        await h.advance(60_000);
        assert.equal(h.asks.length, asksAtFailure, 'nothing asks after the verdict');
        assert.ok(h.warns.some(l => l.includes('gave up confirming the frame')), h.warns.join('\n'));
        const fail = (await h.events()).find(e => e.code === 'frame_not_answering');
        assert.ok(fail, 'frame_not_answering was reported');
        assert.equal(fail.attrs.seen, 'undefined');
        assert.equal(fail.attrs.asks, asksAtFailure);
        assert.equal(fail.attrs.running, 'unasked');
        assert.ok(fail.attrs.elapsed_ms >= DEADLINE_MS - 1, `elapsed_ms ${fail.attrs.elapsed_ms}`);
    } finally { h.close(); }
});

test('desktop: a negative while the status read is unknown keeps asking; a later yes confirms (the old rule failed)', async () => {
    const h = await open({ frame: n => n >= 4, running: () => undefined });
    try {
        await advanceWithoutFailure(h, 30_000);
        assert.equal(h.asks.length, 4, `asked until the yes (${h.asks})`);
        assert.equal(h.statusReads.length >= 3, true, `each negative read the status (${h.statusReads.length})`);
        h.emitViewerFrames();
        await h.advance(2_000);
        assert.ok(h.win.classList.contains('ezil-fullbleed'), `revealed (${h.kinds()})`);
    } finally { h.close(); }
});

test('desktop: a negative with the computer known NOT running fails at once', async () => {
    const h = await open({ frame: () => false, running: () => false });
    try {
        await h.advance(500);
        assert.equal(h.failed(), true, `failed at once (${h.kinds()})`);
        assert.equal(h.asks.length, 1);
        const fail = (await h.events()).find(e => e.code === 'frame_not_answering');
        assert.equal(fail?.attrs.seen, 'false');
        assert.equal(fail?.attrs.running, 'false');
        assert.equal(fail?.attrs.reason, 'http_error');
        assert.equal(fail?.attrs.status, 502);
        assert.equal(fail?.attrs.asks, 1);
        assert.ok(!h.warns.some(l => l.includes('gave up confirming the frame')), 'a refutation is not a give-up');
    } finally { h.close(); }
});

test('desktop: our own route refusing the check (403) stays terminal at once, with no status re-read', async () => {
    const h = await open({ frame: () => new Response('denied', { status: 403 }), running: () => undefined });
    try {
        await h.advance(500);
        assert.equal(h.failed(), true, `failed at once (${h.kinds()})`);
        assert.equal(h.asks.length, 1);
        await h.advance(60_000);
        assert.equal(h.asks.length, 1, 'a refusal is never re-asked');
        const fail = (await h.events()).find(e => e.code === 'frame_not_answering');
        assert.equal(fail?.attrs.reason, 'route_refused');
    } finally { h.close(); }
});

test('desktop: a server-confirmed mint (warm path) also rides out unanswered checks', async () => {
    const h = await open({ frame: n => n <= 4 ? 'none' : true, minted: { frame: { confirmed: true } } });
    try {
        await advanceWithoutFailure(h, 30_000);
        assert.equal(h.asks.length, 5, `asked until the yes (${h.asks})`);
        h.emitViewerFrames();
        await h.advance(2_000);
        assert.ok(h.win.classList.contains('ezil-fullbleed'), `revealed (${h.kinds()})`);
    } finally { h.close(); }
});
