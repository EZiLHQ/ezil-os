// Run: node shell/ezil/ui/feedback/capture-test.mjs
// jsdom has no rasterizer/media picker. Canvas calls and browser media APIs are
// explicit doubles; this tests geometry, privacy filters, lifecycle and UI wiring.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { snapdom as vendoredSnapdom } from '../../../src/lib/snapdom-3.3.4/snapdom.mjs';

const dom = new JSDOM('<!doctype html><body><div id="ezil-os-root"></div></body>', {
    url: 'https://shell.test/', pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;
Object.assign(globalThis, { window, document });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {} });

const contexts = new WeakMap();
window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) {
        const calls = [];
        const stack = [];
        const ctx = {
            calls, fillStyle: '#000000',
            drawImage (...args) { calls.push({ op: 'drawImage', args }); },
            fillRect (...args) { calls.push({ op: 'fillRect', args, style: this.fillStyle }); },
            fillText (...args) { calls.push({ op: 'fillText', args, style: this.fillStyle }); },
            save () { stack.push(this.fillStyle); }, restore () { this.fillStyle = stack.pop(); },
            beginPath () {}, rect () {}, clip () {},
        };
        contexts.set(this, ctx);
    }
    return contexts.get(this);
};
window.HTMLCanvasElement.prototype.toDataURL = function (type) { return `data:${type};base64,AA==`; };
window.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
    callback(new Blob([new Uint8Array(64)], { type }));
};
window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
    this.dispatchEvent(new window.Event('close'));
};

const module_url = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const editorSource = await readFile(new URL('./redact-editor.js', import.meta.url), 'utf8');
const editorUrl = module_url(editorSource);
const { fit_long_edge, flatten, encode_under_limit, open_redact_editor } = await import(editorUrl);
let requestFrame = async () => null;
let snapshotDom = async () => { throw new Error('Not configured'); };
globalThis.__feedbackCaptureTestDoubles = {
    snapdom: (...args) => snapshotDom(...args),
    request_frame_capture: (...args) => requestFrame(...args),
};
// Replace only imports, leaving the production implementation intact. This also
// keeps the concurrently written bridge out of unit-test state and timing.
const rawCaptureSource = await readFile(new URL('./capture.js', import.meta.url), 'utf8');
const captureSource = rawCaptureSource
    .replace("const load_snapdom = () => (snapdom_loading ??= import(SNAPDOM_PATH()).then((m) => m.snapdom));",
        'const load_snapdom = async () => globalThis.__feedbackCaptureTestDoubles.snapdom;')
    .replace("import { request_frame_capture } from '../frame-controls-bridge.js';",
        'const { request_frame_capture } = globalThis.__feedbackCaptureTestDoubles;')
    .replace("'./redact-editor.js'", JSON.stringify(editorUrl));
const { capture_shell_snapshot, tab_capture_supported, capture_tab_frame, capture_desktop_frame } = await import(module_url(captureSource));

function canvas (width = 800, height = 600) {
    const result = document.createElement('canvas');
    result.width = width; result.height = height;
    return result;
}
function set_nav (overrides = {}) {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', platform: 'Linux x86_64', maxTouchPoints: 0,
        mediaDevices: { getDisplayMedia: async () => null }, ...overrides,
    } });
}
function fake_stream () {
    const tracks = ['video', 'audio', 'video'].map(kind => ({
        kind, readyState: 'live', stopCount: 0,
        stop () { this.readyState = 'ended'; this.stopCount++; },
    }));
    return { tracks, getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video') };
}
function all_stopped (stream) {
    assert.ok(stream.tracks.every(t => t.readyState === 'ended' && t.stopCount === 1));
}
function paints (events = []) {
    globalThis.requestAnimationFrame = callback => { events.push('paint'); queueMicrotask(callback); return 1; };
}
function key (target, value, extra = {}) {
    target.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...extra }));
}
const action = name => document.querySelector(`.ezil-redact-editor [data-action="${name}"]`);
const box = () => document.querySelector('.ezil-redact-box');
function pointer (target, type, x, y, id = 1) {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: x, clientY: y, pointerId: id, button: 0 });
    target.dispatchEvent(event);
}
function stage_rect () {
    const stage = document.querySelector('.ezil-redact-stage');
    stage.getBoundingClientRect = () => ({ left: 10, top: 20, width: 400, height: 300 });
    return stage;
}

await test('snapdom is lazy-loaded from /os/vendor, never bundled', () => {
    assert.ok(!/import\s*\{\s*snapdom\s*\}/.test(rawCaptureSource), 'no static snapdom import in capture.js');
    assert.match(rawCaptureSource, /'os', 'vendor', 'snapdom-3\.3\.4\.mjs'/);
});

await test('vendored snapdom 3.3.4 named export is available', () => {
    assert.equal(vendoredSnapdom.version, '3.3.4');
    assert.equal(typeof vendoredSnapdom, 'function');
});

await test('fit_long_edge handles landscape, portrait, square, rounding and invalid sizes', () => {
    for (const [w, h, max, expected] of [
        [3840, 2160, 1920, [1920, 1080]], [2160, 3840, 1920, [1080, 1920]],
        [4000, 4000, 1920, [1920, 1920]], [640, 480, 1920, [640, 480]],
        [3000, 2000, 1920, [1920, 1280]], [99999, 1, 1920, [1920, 1]],
        [0, 50, 1920, [0, 0]], [-1, 50, 1920, [0, 0]], [Infinity, 1, 1920, [0, 0]],
        [1, NaN, 1920, [0, 0]], [1, 1, 0, [0, 0]],
    ]) assert.deepEqual(fit_long_edge(w, h, max), { width: expected[0], height: expected[1] });
});

await test('flatten fills each source-coordinate box, offsets crop, and leaves source untouched', () => {
    const source = canvas();
    const boxes = [{ x: 120, y: 80, width: 40, height: 30 }, { x: 90, y: 40, width: 25, height: 20 }];
    const result = flatten(source, boxes, { x: 100, y: 50, width: 300, height: 200 });
    assert.notEqual(result, source);
    assert.equal(result.width, 300); assert.equal(result.height, 200);
    const calls = result.getContext('2d').calls;
    assert.deepEqual(calls.find(c => c.op === 'drawImage').args, [source, -100, -50]);
    assert.deepEqual(calls.filter(c => c.op === 'fillRect' && c.style === '#000000').map(c => c.args),
        [[20, 30, 40, 30], [-10, -10, 25, 20]]);
    assert.equal(source.getContext('2d').calls.length, 0);
    assert.deepEqual(boxes[0], { x: 120, y: 80, width: 40, height: 30 });
});

await test('flatten rounds redactions outward and clamps crop to the source', () => {
    const result = flatten(canvas(100, 80), [{ x: 4.8, y: 5.2, width: 10.6, height: 2.1 }],
        { x: -10, y: -5, width: 150, height: 200 });
    assert.equal(result.width, 100); assert.equal(result.height, 80);
    assert.deepEqual(result.getContext('2d').calls.find(c => c.style === '#000000').args, [4, 5, 12, 3]);
    assert.throws(() => flatten(canvas(), [{ x: NaN, y: 0, width: 1, height: 1 }]));
});

await test('encoder lowers quality and checks byte limit exactly', async () => {
    const source = canvas();
    const qualities = [];
    source.toBlob = (callback, type, quality) => {
        qualities.push(quality);
        callback(new Blob([new Uint8Array(quality > 0.6 ? 101 : 100)], { type }));
    };
    const result = await encode_under_limit(source, 100);
    assert.equal(result.type, 'image/webp'); assert.equal(result.size, 100);
    assert.deepEqual(qualities, [0.8, 0.7, 0.6]);
});

await test('encoder detects unsupported WebP, rejects MIME substitution, oversize and tainted canvases', async () => {
    const source = canvas();
    source.toDataURL = () => 'data:image/png;base64,AA==';
    assert.equal((await encode_under_limit(source, 100)).type, 'image/jpeg');
    source.toBlob = callback => callback(new Blob(['x'], { type: 'image/png' }));
    assert.equal(await encode_under_limit(source, 100), null);
    source.toBlob = (callback, type) => callback(new Blob([new Uint8Array(101)], { type }));
    assert.equal(await encode_under_limit(source, 100), null);
    source.toDataURL = () => { throw new Error('SecurityError'); };
    assert.equal(await encode_under_limit(source, 100), null);
});

await test('tab support rejects missing API, iOS, desktop-UA iPad, Android and UA-CH mobile', () => {
    set_nav(); assert.equal(tab_capture_supported(), true);
    for (const overrides of [
        { mediaDevices: undefined }, { userAgent: 'iPhone' }, { userAgent: 'iPad' },
        { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', maxTouchPoints: 5 },
        { userAgent: 'Android 15' }, { userAgentData: { mobile: true } },
        { userAgentData: { platform: 'Android', mobile: false } },
    ]) { set_nav(overrides); assert.equal(tab_capture_supported(), false); }
    set_nav({ userAgent: 'Windows', maxTouchPoints: 10 });
    assert.equal(tab_capture_supported(), true);
});

await test('tab capture invokes picker synchronously, hides after grant, paints twice, grabs once and stops ALL tracks', async () => {
    const events = [], stream = fake_stream();
    let options, grabbed = 0, closed = 0;
    set_nav({ mediaDevices: { getDisplayMedia (opts) { events.push('picker'); options = opts; return Promise.resolve(stream); } } });
    paints(events);
    globalThis.ImageCapture = class {
        constructor (track) { assert.equal(track, stream.tracks[0]); }
        async grabFrame () { grabbed++; events.push('grab'); return { width: 1280, height: 720, close () { closed++; } }; }
    };
    const pending = capture_tab_frame({ hide () { events.push('hide'); return () => events.push('restore'); } });
    events.push('caller-returned');
    assert.deepEqual(events, ['picker', 'caller-returned']);
    const result = await pending;
    assert.deepEqual(options, { video: { displaySurface: 'browser' }, audio: false,
        preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude' });
    assert.deepEqual(events, ['picker', 'caller-returned', 'hide', 'paint', 'paint', 'grab', 'restore']);
    assert.equal(result.width, 1280); assert.equal(result.height, 720);
    assert.equal(grabbed, 1); assert.equal(closed, 1); all_stopped(stream);
});

await test('tab capture stops every track and restores UI when grab fails', async () => {
    const stream = fake_stream(); let restored = 0;
    set_nav({ mediaDevices: { getDisplayMedia: async () => stream } }); paints();
    globalThis.ImageCapture = class { async grabFrame () { throw new Error('grab failed'); } };
    assert.equal(await capture_tab_frame({ hide: () => () => restored++ }), null);
    all_stopped(stream); assert.equal(restored, 1);
});

await test('a stalled grab times out, stops tracks, restores UI, and closes a late bitmap', async () => {
    const stream = fake_stream(); let restored = false, closed = false, deliver;
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    const timers = new Map(); let nextTimer = 0;
    set_nav({ mediaDevices: { getDisplayMedia: async () => stream } }); paints();
    globalThis.ImageCapture = class {
        grabFrame () { return new Promise(resolve => { deliver = resolve; }); }
    };
    try {
        globalThis.setTimeout = callback => { const id = ++nextTimer; timers.set(id, callback); return id; };
        globalThis.clearTimeout = id => timers.delete(id);
        const pending = capture_tab_frame({ hide: () => () => { restored = true; } });
        for (let i = 0; i < 30 && !deliver; i++) await Promise.resolve();
        assert.equal(typeof deliver, 'function');
        assert.equal(timers.size, 1);
        [...timers.values()][0]();
        assert.equal(await pending, null); all_stopped(stream); assert.equal(restored, true);
        deliver({ width: 100, height: 100, close () { closed = true; } });
        await Promise.resolve();
        assert.equal(closed, true);
    } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

await test('denied picker and throwing hide callback resolve null without leaking acquired tracks', async () => {
    let hidden = false;
    set_nav({ mediaDevices: { getDisplayMedia: async () => { throw new Error('NotAllowedError'); } } });
    assert.equal(await capture_tab_frame({ hide: () => { hidden = true; } }), null);
    assert.equal(hidden, false);
    const stream = fake_stream();
    set_nav({ mediaDevices: { getDisplayMedia: async () => stream } });
    assert.equal(await capture_tab_frame({ hide: () => { throw new Error('hide failed'); } }), null);
    all_stopped(stream);
});

await test('video fallback captures a loaded frame and removes video on success and play failure', async () => {
    delete globalThis.ImageCapture;
    window.HTMLMediaElement.prototype.pause = function () {};
    for (const failure of [false, true]) {
        const stream = fake_stream();
        set_nav({ mediaDevices: { getDisplayMedia: async () => stream } }); paints();
        window.HTMLMediaElement.prototype.play = function () {
            if (failure) return Promise.reject(new Error('play failed'));
            Object.defineProperties(this, { videoWidth: { value: 640 }, videoHeight: { value: 360 } });
            queueMicrotask(() => this.dispatchEvent(new window.Event('loadeddata')));
            return Promise.resolve();
        };
        const result = await capture_tab_frame({});
        if (failure) assert.equal(result, null);
        else { assert.equal(result.width, 640); assert.equal(result.height, 360); }
        all_stopped(stream); assert.equal(document.querySelector('video'), null);
    }
});

await test('tier C passes 4000ms, handles null/rejection, decodes blob and closes bitmap', async () => {
    requestFrame = async options => { assert.deepEqual(options, { timeoutMs: 4000, signal: undefined }); return null; };
    assert.equal(await capture_desktop_frame(), null);
    requestFrame = async () => { throw new Error('bridge failed'); };
    assert.equal(await capture_desktop_frame(), null);
    const blob = new Blob(['fixture']); let closed = false;
    requestFrame = async () => blob;
    globalThis.createImageBitmap = async value => {
        assert.equal(value, blob); return { width: 640, height: 480, close () { closed = true; } };
    };
    const result = await capture_desktop_frame();
    assert.equal(result.width, 640); assert.equal(closed, true);
});

await test('tier C resolves null when bridge never responds (controlled 4000ms timeout)', async () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    let expire, cleared = false;
    try {
        globalThis.setTimeout = (callback, ms) => { assert.equal(ms, 4000); expire = callback; return 123; };
        globalThis.clearTimeout = id => { assert.equal(id, 123); cleared = true; };
        requestFrame = () => new Promise(() => {});
        const pending = capture_desktop_frame();
        expire();
        assert.equal(await pending, null); assert.equal(cleared, true);
    } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

await test('shell snapshot filters every iframe/private subtree and feedback UI, then paints opaque placeholders', async () => {
    const root = document.getElementById('ezil-os-root');
    // Puter appends windows to <body>, outside #ezil-os-root: the snapshot must
    // cover them (a body-level window's stream iframe is masked too).
    const win = document.createElement('div'); win.className = 'window';
    win.innerHTML = '<iframe class="window-app-iframe"></iframe>';
    document.body.appendChild(win);
    root.innerHTML = '<iframe></iframe><iframe></iframe><input><textarea></textarea>'
        + '<div contenteditable>private text</div><div data-ezil-private><span>secret</span></div>'
        + '<dialog open>feedback</dialog><button id="ezil-feedback-chip">Feedback</button>';
    const elements = [...Array.from(root.children), win.firstElementChild];
    elements.forEach((el, i) => { el.getBoundingClientRect = () => ({ left: 10, top: 20 + 40 * i,
        right: 210, bottom: 50 + 40 * i, width: 200, height: 30 }); });
    snapshotDom = async (element, options) => {
        assert.equal(element, document.body); assert.equal(options.dpr, 1); assert.equal(options.clip, 'viewport');
        for (const el of elements) {
            if (el.matches('dialog, #ezil-feedback-chip')) assert.ok(options.exclude.some(selector => el.matches(selector)));
            assert.equal(options.filter(el), false);
        }
        assert.equal(options.filter(document.createElement('span')), true);
        return { toCanvas: async () => canvas(window.innerWidth, window.innerHeight) };
    };
    const result = await capture_shell_snapshot();
    const calls = result.getContext('2d').calls;
    assert.equal(calls.filter(c => c.op === 'fillRect' && c.style === '#808080').length, 3);
    assert.equal(calls.filter(c => c.op === 'fillRect' && c.style === '#000000').length, 4);
    assert.equal(calls.filter(c => c.op === 'fillText' && c.args[0] === 'Desktop stream not captured').length, 3);
    win.remove();
    assert.equal(root.querySelector('[contenteditable]').textContent, 'private text');
    snapshotDom = async () => { throw new Error('snapshot unavailable'); };
    assert.equal(await capture_shell_snapshot(), null);
    root.replaceChildren();
});

await test('shell snapshot fails closed when a private element cannot be measured', async () => {
    snapshotDom = async (_, options) => {
        const el = document.createElement('input');
        el.getBoundingClientRect = () => { throw new Error('measurement failed'); };
        assert.equal(options.filter(el), false);
        return { toCanvas: async () => { assert.fail('unsafe snapshot must not render'); } };
    };
    assert.equal(await capture_shell_snapshot(), null);
});

await test('editor supports keyboard add/move/resize/delete/undo/clear and restores focus on cancel', async () => {
    const previous = document.createElement('button'); document.body.appendChild(previous); previous.focus();
    const source = canvas(); const pending = open_redact_editor(source);
    assert.ok(document.querySelector('dialog.ezil-redact-editor').open);
    action('add').click();
    assert.match(box().getAttribute('aria-label'), /x 300, y 262, 200 by 75/);
    key(box(), 'ArrowRight'); key(box(), 'ArrowDown', { altKey: true });
    key(box(), 'ArrowRight', { shiftKey: true });
    assert.match(box().getAttribute('aria-label'), /x 310, y 263, 210 by 75/);
    assert.equal(document.activeElement, box());
    action('add').click();
    assert.equal(document.querySelectorAll('.ezil-redact-box').length, 2);
    // Every box is a native, sequentially focusable button (Tab is browser-owned).
    assert.ok([...document.querySelectorAll('.ezil-redact-box')].every(el => el.tabIndex === 0));
    key(document.activeElement, 'Delete'); assert.equal(document.querySelectorAll('.ezil-redact-box').length, 1);
    action('undo').click(); assert.equal(document.querySelectorAll('.ezil-redact-box').length, 2);
    action('clear').click(); assert.equal(box(), null);
    action('undo').click(); assert.equal(document.querySelectorAll('.ezil-redact-box').length, 2);
    action('cancel').click(); assert.equal(await pending, null);
    assert.equal(document.activeElement, previous); previous.remove();
    assert.equal(source.getContext('2d').calls.length, 0);
});

await test('editor maps scaled pointer drags to source pixels and crop is keyboard editable', async () => {
    const pending = open_redact_editor(canvas());
    const stage = stage_rect();
    pointer(stage, 'pointerdown', 60, 70);
    pointer(window, 'pointermove', 160, 170);
    pointer(window, 'pointerup', 160, 170);
    assert.match(box().getAttribute('aria-label'), /x 100, y 100, 200 by 200/);
    action('crop').click();
    let crop = document.querySelector('.ezil-redact-crop');
    key(crop, 'ArrowLeft', { shiftKey: true });
    crop = document.querySelector('.ezil-redact-crop');
    assert.match(crop.getAttribute('aria-label'), /790 by 600/);
    key(crop, 'Delete'); assert.equal(document.querySelector('.ezil-redact-crop'), null);
    pointer(stage, 'pointerdown', 35, 45);
    pointer(window, 'pointerup', 335, 245);
    assert.match(document.querySelector('.ezil-redact-crop').getAttribute('aria-label'), /x 50, y 50, 600 by 400/);
    action('confirm').click();
    const result = await pending;
    assert.equal(result.width, 600); assert.equal(result.height, 400); assert.equal(result.contentType, 'image/webp');
});

await test('editor handles touch fallback and Escape cancellation', async () => {
    const pointerDescriptor = Object.getOwnPropertyDescriptor(window, 'PointerEvent');
    Object.defineProperty(window, 'PointerEvent', { configurable: true, value: undefined });
    const pending = open_redact_editor(canvas()); const stage = stage_rect();
    const touch = (target, type, x, y) => {
        const event = new window.Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'changedTouches', { value: [{ identifier: 7, clientX: x, clientY: y }] });
        target.dispatchEvent(event);
    };
    try {
        touch(stage, 'touchstart', 60, 70); touch(window, 'touchmove', 110, 120); touch(window, 'touchend', 110, 120);
        assert.match(box().getAttribute('aria-label'), /x 100, y 100, 100 by 100/);
        key(document.querySelector('dialog.ezil-redact-editor'), 'Escape');
        assert.equal(await pending, null);
    } finally {
        if (pointerDescriptor) Object.defineProperty(window, 'PointerEvent', pointerDescriptor);
        else delete window.PointerEvent;
    }
});

await test('pointer cancellation rolls back an unfinished rectangle and does not add undo history', async () => {
    const pending = open_redact_editor(canvas()); const stage = stage_rect();
    pointer(stage, 'pointerdown', 60, 70); pointer(window, 'pointermove', 160, 170);
    assert.ok(box());
    pointer(window, 'pointercancel', 160, 170);
    assert.equal(box(), null); assert.equal(action('undo').disabled, true);
    action('cancel').click(); assert.equal(await pending, null);
});

await test('confirmation encodes only a fresh flattened/downscaled canvas, never the original', async () => {
    const source = canvas(3840, 2160); let encoded;
    const original = window.HTMLCanvasElement.prototype.toBlob;
    window.HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
        encoded = this; assert.equal(quality, 0.8); original.call(this, callback, type, quality);
    };
    try {
        const pending = open_redact_editor(source);
        action('add').click(); action('confirm').click();
        const result = await pending;
        assert.equal(result.width, 1920); assert.equal(result.height, 1080);
        assert.notEqual(encoded, source); assert.equal(result.blob.size, 64);
        const flattened = encoded.getContext('2d').calls.find(c => c.op === 'drawImage').args[0];
        assert.ok(flattened.getContext('2d').calls.some(c => c.op === 'fillRect' && c.style === '#000000'));
        assert.equal(source.getContext('2d').calls.length, 0);
    } finally { window.HTMLCanvasElement.prototype.toBlob = original; }
});

await test('native cancel event resolves null and removes dialog', async () => {
    const pending = open_redact_editor(canvas());
    document.querySelector('dialog.ezil-redact-editor').dispatchEvent(new window.Event('cancel', { cancelable: true }));
    assert.equal(await pending, null);
    assert.equal(document.querySelector('dialog.ezil-redact-editor'), null);
});

await test('already cancelled capture/editor requests do not invoke a picker, bridge or snapshot', async () => {
    const controller = new AbortController(); controller.abort();
    const options = { signal: controller.signal };
    snapshotDom = () => assert.fail('snapshot after cancellation');
    requestFrame = () => assert.fail('frame request after cancellation');
    set_nav({ mediaDevices: { getDisplayMedia: () => assert.fail('picker after cancellation') } });
    assert.equal(await capture_shell_snapshot(options), null);
    assert.equal(await capture_tab_frame(options), null);
    assert.equal(await capture_desktop_frame(options), null);
    assert.equal(await open_redact_editor(canvas(), options), null);
    assert.equal(document.querySelector('.ezil-redact-editor'), null);
});

await test('cancelling a pending picker returns promptly and stops a stream granted later exactly once', async () => {
    const controller = new AbortController(), stream = fake_stream();
    let grant, hidden = 0;
    set_nav({ mediaDevices: { getDisplayMedia: () => new Promise(resolve => { grant = resolve; }) } });
    const pending = capture_tab_frame({ signal: controller.signal, hide: () => { hidden++; } });
    assert.equal(typeof grant, 'function', 'picker starts in click stack');
    controller.abort();
    assert.equal(await pending, null);
    grant(stream); await Promise.resolve();
    all_stopped(stream);
    assert.equal(hidden, 0);
});

await test('cancellation while grabbing a frame stops tracks, restores UI and closes a late bitmap', async () => {
    const controller = new AbortController(), stream = fake_stream();
    let deliver, closed = 0, restored = 0;
    set_nav({ mediaDevices: { getDisplayMedia: async () => stream } }); paints();
    globalThis.ImageCapture = class { grabFrame () { return new Promise(resolve => { deliver = resolve; }); } };
    const pending = capture_tab_frame({ signal: controller.signal, hide: () => () => restored++ });
    for (let i = 0; i < 50 && !deliver; i++) await Promise.resolve();
    assert.equal(typeof deliver, 'function');
    controller.abort();
    assert.equal(await pending, null);
    all_stopped(stream); assert.equal(restored, 1);
    deliver({ width: 100, height: 100, close: () => closed++ });
    await Promise.resolve();
    assert.equal(closed, 1);
});

await test('cancellation during video readiness removes the hidden video and stops all tracks', async () => {
    delete globalThis.ImageCapture;
    const controller = new AbortController(), stream = fake_stream();
    set_nav({ mediaDevices: { getDisplayMedia: async () => stream } }); paints();
    window.HTMLMediaElement.prototype.play = () => new Promise(() => {});
    const pending = capture_tab_frame({ signal: controller.signal });
    for (let i = 0; i < 50 && !document.querySelector('video'); i++) await Promise.resolve();
    assert.ok(document.querySelector('video'));
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(document.querySelector('video'), null);
    all_stopped(stream);
});

await test('shell cancellation discards a pending snapshot before any canvas render', async () => {
    const controller = new AbortController(); let deliver;
    snapshotDom = () => new Promise(resolve => { deliver = resolve; });
    const pending = capture_shell_snapshot({ signal: controller.signal });
    for (let i = 0; i < 30 && !deliver; i++) await Promise.resolve();
    assert.equal(typeof deliver, 'function');
    controller.abort();
    assert.equal(await pending, null);
    deliver({ toCanvas: () => assert.fail('cancelled snapshot rendered') });
    await Promise.resolve();
});

await test('desktop cancellation propagates to the bridge and closes a bitmap decoded later', async () => {
    const controller = new AbortController(); let deliver, closed = 0;
    requestFrame = async ({ signal }) => { assert.equal(signal, controller.signal); return new Blob(['fixture']); };
    globalThis.createImageBitmap = () => new Promise(resolve => { deliver = resolve; });
    const pending = capture_desktop_frame({ signal: controller.signal });
    for (let i = 0; i < 30 && !deliver; i++) await Promise.resolve();
    assert.equal(typeof deliver, 'function');
    controller.abort();
    assert.equal(await pending, null);
    deliver({ width: 100, height: 100, close: () => closed++ });
    await Promise.resolve();
    assert.equal(closed, 1);
});

await test('editor cancellation removes listeners and prevents retries when an oversized encoding completes later', async () => {
    const originalEncode = window.HTMLCanvasElement.prototype.toBlob;
    const originalAdd = window.addEventListener, originalRemove = window.removeEventListener;
    const listeners = new Set();
    window.addEventListener = function (type, fn, options) { listeners.add(fn); return originalAdd.call(this, type, fn, options); };
    window.removeEventListener = function (type, fn, options) { listeners.delete(fn); return originalRemove.call(this, type, fn, options); };
    try {
        for (const type of ['cancel-button', 'Escape', 'cancel', 'close', 'abort', 'ezil:teardown', 'popstate', 'pagehide', 'hashchange']) {
            const controller = new AbortController();
            const encodes = [];
            window.HTMLCanvasElement.prototype.toBlob = callback => { encodes.push(callback); };
            const pending = open_redact_editor(canvas(), { signal: controller.signal });
            action('confirm').click();
            assert.equal(encodes.length, 1);
            const editor = document.querySelector('.ezil-redact-editor');
            if (type === 'abort') controller.abort();
            else if (type === 'cancel-button') action('cancel').click();
            else if (type === 'Escape') key(editor, 'Escape');
            else if (type === 'cancel') editor.dispatchEvent(new window.Event('cancel', { cancelable: true }));
            else if (type === 'close') editor.close();
            else window.dispatchEvent(new window.Event(type));
            assert.equal(await pending, null);
            assert.equal(document.querySelector('.ezil-redact-editor'), null);
            assert.equal(listeners.size, 0);
            const focus = document.activeElement;
            encodes[0](new Blob([new Uint8Array(1.5 * 1024 * 1024 + 1)], { type: 'image/webp' }));
            for (let i = 0; i < 10; i++) await Promise.resolve();
            assert.equal(encodes.length, 1, `${type} must not start another encode for a discarded screenshot`);
            assert.equal(document.querySelector('.ezil-redact-editor'), null);
            assert.equal(document.activeElement, focus);
        }
    } finally {
        window.HTMLCanvasElement.prototype.toBlob = originalEncode;
        window.addEventListener = originalAdd; window.removeEventListener = originalRemove;
    }
});

dom.window.close();
