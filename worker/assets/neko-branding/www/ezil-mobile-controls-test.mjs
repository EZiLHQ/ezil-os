// Run: node worker/assets/neko-branding/www/ezil-mobile-controls-test.mjs
// jsdom checks the message/input boundary, not WebRTC decoding or canvas PNG
// encoding. Those need the rebuilt image (assets/neko-branding/Dockerfile:26).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

// jsdom is already a shell dev dependency; do not add a Worker dependency just
// to exercise the page shared with that shell (shell/package.json:13).
const require = createRequire(new URL('../../../../shell/package.json', import.meta.url));
const { JSDOM } = require('jsdom');
const pageCode = readFileSync(new URL('./ezil-mobile.js', import.meta.url), 'utf8');
const shellOrigin = 'https://os.ezil.org';

function harness(t, options = {}) {
    const dom = new JSDOM('<div class="video-container"><video></video><textarea class="overlay"></textarea></div>', {
        url: 'https://test-nekodesktop.ezil.org/', runScripts: 'outside-only', pretendToBeVisual: true,
        referrer: 'https://untrusted-parent.test/os',
    });
    const win = dom.window;
    const posted = [], draws = [], encodes = [], timers = new Map();
    const parent = { postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }) };
    Object.defineProperty(win, 'parent', { value: parent });
    if ('origins' in options) win.EZIL_SHELL_ORIGINS = options.origins;
    if (options.configScript) win.eval(options.configScript);
    win.matchMedia = () => ({ matches: false });
    let now = 0, timerId = 0, finishEncoding;
    win.Date.now = () => now;
    win.setTimeout = (fn, delay = 0) => {
        const id = ++timerId;
        timers.set(id, { fn, at: now + delay });
        return id;
    };
    win.clearTimeout = id => timers.delete(id);
    // The existing detector/vitals intervals are separate concerns, already
    // covered in worker/scripts/neko-branding.test.ts:638.
    win.setInterval = () => ++timerId;
    win.clearInterval = () => {};
    const advance = ms => {
        const end = now + ms;
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].fn();
        }
        now = end;
    };
    const video = win.document.querySelector('video');
    Object.defineProperties(video, {
        videoWidth: { value: options.width ?? 1920 }, videoHeight: { value: 1080 },
        readyState: { value: options.readyState ?? 4 },
    });
    if (options.noVideo) video.remove();
    win.HTMLCanvasElement.prototype.getContext = function (kind) {
        assert.equal(kind, '2d');
        if (options.noContext) return null;
        return { drawImage: (...args) => {
            if (options.drawThrows) throw new Error('tainted canvas');
            draws.push({ canvas: this, args });
        } };
    };
    win.HTMLCanvasElement.prototype.toBlob = function (done, type) {
        if (options.encodeThrows) throw new Error('encoding failed');
        encodes.push({ width: this.width, height: this.height, type });
        finishEncoding = () => done(options.nullBlob ? null : new win.Blob(['PNG'], { type }));
        if (!options.deferredEncoding) finishEncoding();
    };
    win.eval(pageCode);
    const request = (data = {}, event = {}) => win.dispatchEvent(new win.MessageEvent('message', {
        origin: shellOrigin, source: parent,
        data: { source: 'ezil-shell', type: 'frame_capture_request', nonce: 'request-1', ...data }, ...event,
    }));
    const pointer = (pointerType, clientY = 1, type = 'pointermove', relatedTarget = null) => {
        const ev = new win.MouseEvent(type, { bubbles: true, clientY, relatedTarget });
        Object.defineProperty(ev, 'pointerType', { value: pointerType });
        win.document.querySelector('textarea').dispatchEvent(ev);
    };
    t.after(() => dom.window.close());
    return { win, parent, posted, draws, encodes, advance, request, pointer, video, finish: () => finishEncoding() };
}

test('capture rejects non-allowlisted, opaque and spoofed origins, wrong sources and malformed requests', t => {
    const h = harness(t);
    for (const origin of [
        'https://untrusted-parent.test', 'https://os.ezil.org.attacker.test', 'null', '*',
        'http://localhost.attacker.test:3000', 'http://127.0.0.1.attacker.test:3000',
        'http://127.1:3000', 'https://localhost:3000', `${shellOrigin}/path`,
    ]) h.request({}, { origin });
    h.request({}, { source: h.win });
    h.request({}, { source: null });
    for (const nonce of [null, undefined, 7, {}, 'x'.repeat(65)]) h.request({ nonce });
    h.request({ source: 'other' });
    h.request({ type: 'other' });
    h.request({}, { data: null });
    assert.equal(h.posted.length, 0);
    assert.equal(h.draws.length, 0);
    h.request();
    assert.equal(h.encodes.length, 1, 'invalid requests do not consume the capture budget');
});

test('allowlisted capture replies to the exact origin with the nonce and intrinsic PNG size', t => {
    const h = harness(t);
    h.request({ nonce: 'x'.repeat(64) });
    const result = h.posted[0];
    assert.equal(result.targetOrigin, shellOrigin);
    assert.equal(result.data.source, 'ezil-mobile');
    assert.equal(result.data.type, 'frame_capture_result');
    assert.equal(result.data.nonce, 'x'.repeat(64));
    assert.ok(result.data.blob instanceof h.win.Blob);
    assert.equal(result.data.blob.type, 'image/png');
    assert.deepEqual(h.encodes, [{ width: 1920, height: 1080, type: 'image/png' }]);
    assert.deepEqual(h.draws[0].args, [h.video, 0, 0, 1920, 1080]);
    assert.ok(h.posted.every(reply => reply.targetOrigin !== '*'));
});

test('default allowlist supports production, Vercel, and exact HTTP loopback hosts at any port', t => {
    const h = harness(t);
    for (const origin of [shellOrigin, 'https://ezil-os.vercel.app', 'http://localhost', 'http://localhost:3000',
        'http://127.0.0.1', 'http://127.0.0.1:5173']) {
        h.request({}, { origin });
        assert.equal(h.posted.at(-1).targetOrigin, origin);
        assert.ok(h.posted.at(-1).data.blob instanceof h.win.Blob);
        h.advance(2000);
    }
});

test('explicit staging allowlist replaces defaults and malformed or empty config fails closed', t => {
    const staging = 'https://os-staging.ezil.work';
    const h = harness(t, { origins: [staging] });
    h.request();
    assert.equal(h.posted.length, 0);
    h.request({}, { origin: staging });
    assert.equal(h.posted[0].targetOrigin, staging);
    assert.ok(h.posted[0].data.blob instanceof h.win.Blob);
    for (const origins of [[], null, '*', [shellOrigin + '/'], ['*'], ['https://*.ezil.org']]) {
        const disabled = harness(t, { origins });
        disabled.request();
        assert.equal(disabled.posted.length, 0);
    }
});

test('capture allows at most one encoding per two seconds', t => {
    const h = harness(t);
    h.request();
    h.advance(1999);
    h.request({ nonce: 'throttled' });
    assert.equal(h.encodes.length, 1);
    assert.equal(h.posted[1].data.nonce, 'throttled');
    assert.equal(h.posted[1].data.blob, null);
    assert.equal(h.posted[1].targetOrigin, shellOrigin);
    h.advance(1);
    h.request({ nonce: 'next' });
    assert.equal(h.encodes.length, 2);
    assert.ok(h.posted[2].data.blob instanceof h.win.Blob);
});

test('pending PNG encoding is not overlapped, and a delayed callback preserves its request origin and nonce', t => {
    const staging = 'https://os-staging.ezil.work';
    const h = harness(t, { origins: [shellOrigin, staging], deferredEncoding: true });
    h.request({ nonce: 'original' });
    h.advance(2000);
    h.request({ nonce: 'overlap' }, { origin: staging });
    assert.equal(h.encodes.length, 1);
    assert.equal(h.posted[0].data.blob, null);
    assert.equal(h.posted[0].targetOrigin, staging);
    h.finish();
    assert.equal(h.posted[1].data.nonce, 'original');
    assert.equal(h.posted[1].targetOrigin, shellOrigin);
    assert.ok(h.posted[1].data.blob instanceof h.win.Blob);
});

test('missing frames, canvas failures, and PNG failures reply with null to the validated origin', t => {
    for (const options of [{ noVideo: true }, { width: 0 }, { readyState: 1 }, { noContext: true },
        { drawThrows: true }, { encodeThrows: true }, { nullBlob: true }]) {
        const h = harness(t, options);
        h.request();
        assert.equal(h.posted.length, 1);
        assert.equal(h.posted[0].data.blob, null);
        assert.equal(h.posted[0].targetOrigin, shellOrigin);
    }
});

test('D9 Ctrl+Alt+Shift+ArrowUp prevents default and cannot reach remote input handlers', t => {
    const h = harness(t);
    const overlay = h.win.document.querySelector('textarea');
    let remoteKeys = 0;
    overlay.addEventListener('keydown', () => remoteKeys++);
    const hotkey = new h.win.KeyboardEvent('keydown', {
        key: 'ArrowUp', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    assert.equal(overlay.dispatchEvent(hotkey), false);
    assert.equal(hotkey.defaultPrevented, true);
    assert.equal(remoteKeys, 0);
    assert.deepEqual(JSON.parse(JSON.stringify(h.posted[0].data)), { source: 'ezil-mobile', type: 'controls_hotkey' });
    for (const changes of [{ ctrlKey: false }, { altKey: false }, { shiftKey: false }, { key: 'ArrowDown' }, { metaKey: true }]) {
        const normal = new h.win.KeyboardEvent('keydown', {
            key: 'ArrowUp', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true, cancelable: true, ...changes,
        });
        overlay.dispatchEvent(normal);
        assert.equal(normal.defaultPrevented, false);
    }
    assert.equal(remoteKeys, 5);
    assert.equal(h.posted.length, 1);
});

test('mouse top-edge dwell waits 250ms and throttles reveals to one per 1500ms', t => {
    const h = harness(t);
    h.pointer('mouse', 2);
    h.advance(249);
    assert.equal(h.posted.length, 0);
    h.pointer('mouse', 1);
    h.advance(1);
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0].data.type, 'edge_reveal');
    h.pointer('mouse', 1);
    for (let n = 0; n < 10; n++) { h.advance(100); h.pointer('mouse', 1); }
    h.advance(499);
    assert.equal(h.posted.length, 1);
    h.advance(1);
    assert.equal(h.posted.length, 2);
});

test('touch/pen never reveal; leaving the edge, leaving the frame, blur or hiding breaks dwell', t => {
    const h = harness(t);
    for (const type of ['touch', 'pen', '']) {
        h.pointer(type, 0);
        h.advance(2000);
    }
    assert.equal(h.posted.length, 0);
    const cancellations = [
        () => h.pointer('mouse', 3), () => h.pointer('touch', 0),
        () => h.pointer('mouse', 1, 'pointerout'), () => h.pointer('mouse', 1, 'pointercancel'),
        () => h.win.dispatchEvent(new h.win.Event('blur')),
        () => {
            Object.defineProperty(h.win.document, 'hidden', { configurable: true, value: true });
            h.win.document.dispatchEvent(new h.win.Event('visibilitychange'));
            Object.defineProperty(h.win.document, 'hidden', { configurable: true, value: false });
        },
    ];
    for (const cancel of cancellations) {
        h.pointer('mouse', 1);
        h.advance(200);
        cancel();
        h.advance(1000);
        assert.equal(h.posted.length, 0);
    }
    h.pointer('mouse', 1);
    h.advance(249);
    assert.equal(h.posted.length, 0);
    h.advance(1);
    assert.equal(h.posted.length, 1);
});

test('Worker config safely serializes comma-separated origins and the image loads it before the page bridge', t => {
    const worker = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    const helper = worker.slice(worker.indexOf('export function nekoShellOriginsScript('), worker.indexOf('\nasync function ensureDesktop('));
    const js = stripTypeScriptTypes(helper.replace('export function', 'function'));
    const serialize = new Function(`${js}\nreturn nekoShellOriginsScript;`)();
    const staging = 'https://os-staging.ezil.work';
    const h = harness(t, { configScript: serialize(` ${shellOrigin}, ${staging}, ,`) });
    h.request({}, { origin: staging });
    assert.ok(h.posted[0].data.blob instanceof h.win.Blob);
    const payload = '\"];window.injected=true;//</script>\u2028\u2029tail';
    h.win.eval(serialize(payload));
    assert.equal(h.win.injected, undefined);
    assert.deepEqual(Array.from(h.win.EZIL_SHELL_ORIGINS), [payload]);
    h.win.eval(serialize(''));
    assert.deepEqual(Array.from(h.win.EZIL_SHELL_ORIGINS), []);
    h.win.eval(serialize(undefined));
    assert.equal(h.win.EZIL_SHELL_ORIGINS, undefined);
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    assert.match(dockerfile, /src="ezil-shell-origins\.js"><\/script><script defer="defer" src="ezil-mobile\.js"/);
    const ensure = worker.slice(worker.indexOf('\nasync function ensureDesktop('));
    assert.ok(ensure.indexOf("sandbox.writeFile('/var/www/ezil-shell-origins.js'") < ensure.indexOf('sandbox.getExposedPorts('));
    assert.match(worker, /EZIL_SHELL_ORIGINS: this\.env\.EZIL_SHELL_ORIGINS/);
    assert.match(worker, /EZIL_SHELL_ORIGINS: env\.EZIL_SHELL_ORIGINS/);
});

test('Worker writes config before warm reuse or cold start, preserves launch env, and never writes it for Guacamole', async () => {
    // Execute the real helper and boot function with only the sandbox boundary
    // stubbed: importing the full entrypoint needs the unavailable Worker SDK.
    const worker = readFileSync(new URL('../../../src/index.ts', import.meta.url), 'utf8');
    const functions = worker.slice(worker.indexOf('export function nekoShellOriginsScript('), worker.indexOf('// ── S3 workspace bucket mount'));
    const js = stripTypeScriptTypes(functions.replace('export function', 'function'));
    const ensureDesktop = new Function('portFor', 'appPortFor', 'codePortFor', 'bootLog',
        'cpuDiagFlagEnabled', 'DESKTOP_READY_TIMEOUT_MS', 'exposeDesktopPort', `${js}\nreturn ensureDesktop;`)(
        mode => ({ port: mode === 'neko' ? 8181 : 8080, readyPath: '/' }),
        () => null, () => null, () => {}, () => false, 1000, async () => 'https://frame.test',
    );
    for (const warm of [false, true]) {
        for (const mode of ['neko', 'guacamole']) {
            const calls = [];
            const env = { EZIL_SHELL_ORIGINS: 'https://os-staging.ezil.work', NEKO_PASSWORD: 'test-only' };
            const sandbox = {
                writeFile: async (path, contents) => calls.push({ action: 'config', path, contents }),
                getExposedPorts: async () => {
                    calls.push({ action: 'ports' });
                    return warm ? [{ port: mode === 'neko' ? 8181 : 8080, url: 'https://frame.test' }] : [];
                },
                startProcess: async (command, options) => {
                    calls.push({ action: 'start', command, env: options.env });
                    return { waitForPort: async () => {} };
                },
            };
            assert.equal((await ensureDesktop(sandbox, 'ezil.org', mode, env)).url, 'https://frame.test');
            if (mode === 'neko') {
                assert.equal(calls[0].action, 'config');
                assert.equal(calls[0].path, '/var/www/ezil-shell-origins.js');
                assert.equal(calls[0].contents, 'window.EZIL_SHELL_ORIGINS = ["https://os-staging.ezil.work"];\n');
            } else assert.ok(calls.every(call => call.action !== 'config'));
            const start = calls.find(call => call.action === 'start');
            if (warm) assert.equal(start, undefined);
            else assert.deepEqual(start.env, { DESKTOP_MODE: mode, ...env });
        }
    }
    // A failed config write must NOT block opening the desktop: the page falls
    // back to its built-in first-party origin list (lead decision, availability first).
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
        const opened = await ensureDesktop({
            writeFile: async () => { throw new Error('config write failed'); },
            getExposedPorts: async () => [{ port: 8181, url: 'https://frame.test' }],
        }, 'ezil.org', 'neko');
        assert.equal(opened.url, 'https://frame.test');
    } finally {
        console.warn = realWarn;
    }
    assert.ok(warnings.some((w) => /shell-origins config not written/.test(w)), 'the failed write is logged');
});
