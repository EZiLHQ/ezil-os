// Run: node shell/ezil/apps/floating-window-test.mjs
// The complete window source runs with dependency stubs: DRAWER/NEKO/FSHELL
// ship in parallel (FEEDBACK-CONTROLS-CONTRACT.md:24). No browser or bundle is
// needed. jsdom proves DOM wiring; it cannot prove native focus or layout.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { confirm_close, should_confirm } from '../ui/close-confirm.js';
import { isCurrentViewerMessage, viewerFramesAdvance } from './viewer-evidence.js';

const source = readFileSync(new URL('./desktop-window.js', import.meta.url), 'utf8');
function load_window (dependencies = {}) {
    // Replace imports only, keeping all executable production code intact.
    const script = source.replace(/^import[\s\S]*?from ['"][^'"]+['"];\n/gm, '')
        .replace(/^export default openDesktopWindow;$/m, '').replace(/^export /gm, '');
    const context = vm.createContext({ setTimeout, clearTimeout, console, ...dependencies });
    vm.runInContext(script + '\nglobalThis.api = { debounce_measure, attach_with_floating_fallback, bind_floating_fullscreen, floating_focus_order, openDesktopWindow };', context);
    return context.api;
}
const helpers = load_window();
function clock () {
    let now = 0, serial = 0;
    const pending = new Map();
    return {
        setTimer (fn, delay) { const id = ++serial; pending.set(id, { at: now + delay, fn }); return id; },
        clearTimer (id) { pending.delete(id); },
        tick (ms) {
            const end = now + ms;
            for (;;) {
                const next = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                now = next[1].at; pending.delete(next[0]); next[1].fn();
            }
            now = end;
        },
    };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

await test('resize burst waits 500ms from the LAST event and measures exactly once; cancellation removes work', () => {
    const time = clock();
    let measures = 0;
    const schedule = helpers.debounce_measure(() => measures++, time);
    for (let i = 0; i < 20; i++) { schedule(); time.tick(20); }
    time.tick(479); assert.equal(measures, 0);
    time.tick(1); assert.equal(measures, 1);
    time.tick(1000); assert.equal(measures, 1);
    schedule(); time.tick(500); assert.equal(measures, 2);
    schedule(); schedule.cancel(); time.tick(500); assert.equal(measures, 2);
});

await test('should_confirm covers the complete shared/skip truth table', () => {
    for (const shared of [false, true]) for (const skip of [false, true]) {
        assert.equal(should_confirm({ shared, skip }), !shared && !skip);
    }
});

await test('floating null or throw falls back to identical legacy options; disabled never tries floating', () => {
    const el = {}, legacy = { title: 'Browser', actions: [] }, floating = { variant: 'floating' };
    for (const failure of ['null', 'throw']) {
        const calls = [];
        const actual = helpers.attach_with_floating_fallback((node, options) => {
            assert.equal(node, el); calls.push(options);
            if (options === floating) { if (failure === 'throw') throw Error('attach'); return null; }
            return 'legacy drawer';
        }, el, legacy, floating);
        assert.equal(actual, 'legacy drawer'); assert.deepEqual(calls, [floating, legacy]);
    }
    const calls = [];
    assert.equal(helpers.attach_with_floating_fallback((_, o) => { calls.push(o); return 'drawer'; }, el, legacy, null), 'drawer');
    assert.deepEqual(calls, [legacy]);
    assert.equal(helpers.attach_with_floating_fallback((_, o) => o, el, legacy, floating), floating);
    assert.equal(helpers.attach_with_floating_fallback(() => null, el, legacy, floating), null);
});

await test('fullscreen enter/exit, rejection status, shared resize debounce and disposal', async () => {
    const dom = new JSDOM(); const doc = dom.window.document; const time = clock();
    let measures = 0, entered = 0, exited = 0;
    const states = [], statuses = [];
    doc.documentElement.requestFullscreen = async () => { entered++; };
    doc.exitFullscreen = async () => { exited++; };
    const binding = helpers.bind_floating_fullscreen({ ezil_controls: {
        set_fullscreen: value => states.push(value), set_status: value => statuses.push(value),
    } }, helpers.debounce_measure(() => measures++, time), doc, dom.window);
    await binding.toggle(); assert.equal(entered, 1);
    doc.fullscreenElement = doc.documentElement;
    doc.dispatchEvent(new dom.window.Event('fullscreenchange'));
    await binding.toggle(); assert.equal(exited, 1); assert.deepEqual(states, [false, true]);
    for (let i = 0; i < 8; i++) { time.tick(40); dom.window.dispatchEvent(new dom.window.Event('resize')); }
    time.tick(499); assert.equal(measures, 0); time.tick(1); assert.equal(measures, 1);
    doc.fullscreenElement = null;
    doc.documentElement.requestFullscreen = async () => { throw Error('denied'); };
    await binding.toggle(); assert.match(statuses[0], /Couldn't change full screen/);
    doc.fullscreenElement = doc.documentElement; doc.exitFullscreen = () => { throw Error('denied'); };
    await binding.toggle(); assert.equal(statuses.length, 2);
    dom.window.dispatchEvent(new dom.window.Event('resize')); binding.dispose(); time.tick(500);
    doc.dispatchEvent(new dom.window.Event('fullscreenchange'));
    dom.window.dispatchEvent(new dom.window.Event('resize')); time.tick(500);
    assert.equal(measures, 1); assert.deepEqual(states, [false, true]); dom.window.close();
});

await test('full-bleed grabber sorts first; hidden shell is inert; exact attributes restore without moving iframe', () => {
    const dom = new JSDOM(`<body><button tabindex="5">earlier</button><div class="desktop"><button>icon</button>
      <div class="window"><div class="window-head"><button>head</button></div><iframe></iframe>
      <div class="drawer"><button aria-expanded="false" tabindex="0">grabber</button></div></div></div>
      <div class="taskbar" inert="already"><button>dock</button></div></body>`);
    const doc = dom.window.document, el = doc.querySelector('.window'), drawer = doc.querySelector('.drawer');
    const iframe = el.querySelector('iframe'), frameWindow = iframe.contentWindow;
    const before = doc.body.innerHTML;
    const restore = helpers.floating_focus_order(el, drawer);
    assert.equal(drawer.firstElementChild.tabIndex, 1);
    assert.equal(doc.querySelector('body > button').tabIndex, 0);
    assert.equal(doc.querySelector('.desktop > button').hasAttribute('inert'), true);
    assert.equal(el.hasAttribute('inert'), false);
    assert.equal(doc.querySelector('.window-head').hasAttribute('inert'), true);
    assert.equal(doc.querySelector('.taskbar').hasAttribute('inert'), true);
    assert.equal(iframe.contentWindow, frameWindow);
    restore(); restore(); assert.equal(doc.body.innerHTML, before); dom.window.close();
});

function modal_dom () {
    const dom = new JSDOM('<button id="red">Close</button>', { url: 'https://shell.test' });
    globalThis.window = dom.window; globalThis.document = dom.window.document;
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    document.getElementById('red').focus();
    return dom;
}
await test('modal wording, accessible description, default focus, Escape and focus restoration', async () => {
    const dom = modal_dom(); const result = confirm_close({ shared: false });
    const dialog = document.querySelector('dialog');
    assert.equal(dialog.getAttribute('aria-label'), 'Close Browser?');
    assert.equal(document.getElementById(dialog.getAttribute('aria-describedby')).textContent,
        'Your computer keeps running about a minute, then saves files and stops. Unsaved changes inside apps may be lost.');
    assert.equal(dialog.querySelector('input').checked, false);
    assert.equal(document.activeElement.textContent, 'Minimise instead');
    dialog.querySelector('input').checked = true;
    dialog.dispatchEvent(new window.Event('cancel', { cancelable: true }));
    assert.equal(await result, 'cancel'); assert.equal(document.querySelector('dialog'), null);
    assert.equal(document.activeElement.id, 'red'); assert.equal(window.localStorage.length, 0); dom.window.close();
});
await test('Minimise does not save skip; Close saves skip; shared and remembered closes bypass modal', async () => {
    const dom = modal_dom(); let result = confirm_close({ shared: false });
    document.querySelector('input').checked = true; document.querySelector('dialog button').click();
    assert.equal(await result, 'minimize'); assert.equal(window.localStorage.length, 0);
    result = confirm_close({ shared: false }); document.querySelector('input').checked = true;
    document.querySelector('dialog button:last-child').click(); assert.equal(await result, 'close');
    assert.equal(window.localStorage.getItem('ezil:close-confirm:skip'), '1');
    assert.equal(await confirm_close({ shared: false }), 'close'); assert.equal(document.querySelector('dialog'), null);
    window.localStorage.clear(); assert.equal(await confirm_close({ shared: true }), 'close');
    assert.equal(document.querySelector('dialog'), null); dom.window.close();
});
await test('storage getter/read/write failures ask and never reject; unknown stored values still ask', async () => {
    for (const kind of ['getter', 'read', 'write', 'unknown']) {
        const dom = modal_dom();
        if (kind === 'getter') Object.defineProperty(window, 'localStorage', { get () { throw Error('blocked'); } });
        if (kind === 'read' || kind === 'write') Object.defineProperty(window, 'localStorage', { value: {
            getItem () { if (kind === 'read') throw Error('blocked'); return null; }, setItem () { throw Error('blocked'); },
        } });
        if (kind === 'unknown') window.localStorage.setItem('ezil:close-confirm:skip', 'yes');
        const result = confirm_close({ shared: false }); assert.ok(document.querySelector('dialog'));
        document.querySelector('input').checked = true; document.querySelector('dialog button:last-child').click();
        assert.equal(await result, 'close'); dom.window.close();
    }
});
await test('unavailable native modality cancels safely, and external dialog close cancels', async () => {
    const dom = modal_dom(); window.HTMLDialogElement.prototype.showModal = () => { throw Error('unavailable'); };
    assert.equal(await confirm_close({ shared: false }), 'cancel'); assert.equal(document.querySelector('dialog'), null);
    window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    const result = confirm_close({ shared: false }); document.querySelector('dialog').dispatchEvent(new window.Event('close'));
    assert.equal(await result, 'cancel'); dom.window.close();
});
await test('shell teardown removes the modal, and a later click cannot record consent', async () => {
    const dom = modal_dom(); const result = confirm_close({ shared: false });
    const dialog = document.querySelector('dialog'); dialog.querySelector('input').checked = true;
    window.dispatchEvent(new window.Event('ezil:teardown'));
    assert.equal(await result, 'cancel'); assert.equal(document.querySelector('dialog'), null);
    dialog.querySelector('button:last-child').click(); assert.equal(window.localStorage.length, 0);
    dom.window.close();
});

async function harness ({ flag = true, feedback = true, focus = true, attachFailure = false, configured = false, fullscreenEnabled = false } = {}) {
    const dom = new JSDOM('<body><div class="desktop"><button>icon</button></div><div class="taskbar"><button>dock</button></div></body>', { url: 'https://shell.test', pretendToBeVisual: true });
    const { window } = dom, doc = window.document, time = clock();
    const calls = { attach: [], statuses: [], reveals: 0, grabbers: 0, closes: 0, hides: 0, confirms: 0, releases: 0, measures: 0, requests: 0, captures: [], feedback: [], frames: 0 };
    let choice = 'cancel', confirmResolve, resizeObserver, inset = 0;
    const payload = { desktopState: { configured, ui: { floatingControls: flag }, endpoints: { ...(focus ? { focus: '/focus' } : {}) } } };
    if (flag === null) delete payload.desktopState.ui;
    doc.fullscreenEnabled = fullscreenEnabled;
    window.__EZIL_BOOT__ = payload;
    window.enter_fullpage_mode = el => { el.classList.add('fullpage'); };
    window.exit_fullpage_chrome = el => { el.classList.remove('fullpage'); };
    const $ = el => ({
        attr (name, value) { if (value === undefined) return el.getAttribute(name); el.setAttribute(name, value); return this; },
        focusWindow () {}, hideWindow () { calls.hides++; el.setAttribute('data-is_minimized', 'true'); },
        async close () { calls.closes++; await el.on_before_exit(); el.remove(); },
    });
    const component = () => ({ el: doc.createElement('div'), render () {}, hide () {}, show () {} });
    const api = load_window({
        window, document: doc, $, URL, crypto: globalThis.crypto, performance: { now: () => 0 },
        setTimeout: time.setTimer, clearTimeout: time.clearTimer, setInterval: () => 1, clearInterval () {},
        console: { info () {}, warn () {}, error () {} }, MutationObserver: window.MutationObserver,
        ResizeObserver: class { constructor (callback) { resizeObserver = callback; } observe () {} disconnect () {} },
        isNative: () => false, telemetry: { capture () {} },
        session: { payload: () => payload, screenEndpoint: () => '/screen', activityEndpoint: () => '/activity',
            releaseDesktop: async () => { calls.releases++; return true; }, focusApp: async () => false,
            confirmDisplay: async () => undefined, getScreen: async () => undefined },
        DESKTOP_BOOT_TIMEOUT_MS: 10000, HEARTBEAT_INTERVAL_MS: 10000,
        isPresent: () => false, shouldHeartbeat: () => false, watchRuntimeOnReturn: () => () => {},
        BootProgress: component, AppSpinner: component, DisplayNotice: component,
        computeBootUiState: () => ({ kind: 'progress' }), applyDisplayEvidence: () => ({}),
        computeFitBox: () => null, readAppliedScreen: () => null, keyboardInsetPx: () => inset,
        measureDesktopBox: () => { calls.measures++; return { width: 1280, height: 720 }; },
        createScreenController: () => ({ cancel () {}, request () { calls.requests++; }, reconcile: () => ({ changed: false }) }),
        claimWarm: async () => ({ ok: true, url: 'https://frame.test/', frameConfirmed: false }),
        isCurrentViewerMessage, viewerFramesAdvance: (...args) => { calls.frames++; return viewerFramesAdvance(...args); },
        classify_frame_controls_message: (event, expected) => event.source === expected.source && event.origin === expected.origin
            && event.data?.source === 'ezil-mobile' && ['edge_reveal', 'controls_hotkey'].includes(event.data.type) ? { type: event.data.type } : null,
        register_capture_target: (iframe, origin) => calls.captures.push({ iframe, origin }),
        feedback_enabled: () => feedback, open_feedback_dialog: args => calls.feedback.push(args.source),
        confirm_close: () => { calls.confirms++; return choice === 'pending' ? new Promise(r => { confirmResolve = r; }) : Promise.resolve(choice); },
        UIWindow: async () => {
            const el = doc.createElement('div'); el.className = 'window'; el.dataset.ezilComputerId = 'c1';
            el.innerHTML = '<div class="window-head"><button>Close</button></div><div class="window-body"><iframe class="window-app-iframe"></iframe></div>';
            doc.body.append(el); return el;
        },
        attach_app_drawer: (el, options) => {
            calls.attach.push(options);
            if (options.variant === 'floating' && attachFailure) return null;
            const drawer = doc.createElement('div'); drawer.className = options.variant === 'floating' ? 'ezil-floating-drawer' : 'legacy';
            drawer.innerHTML = '<button aria-expanded="false">grabber</button><button class="dashboard-app-drawer-close">Close</button><span class="dashboard-app-drawer-title">Browser</span>';
            drawer.ezil_controls = { set_status: text => calls.statuses.push(text), set_fullscreen () {}, reveal () { calls.reveals++; }, focus_grabber () { calls.grabbers++; } };
            el.append(drawer); return drawer;
        },
    });
    const el = await api.openDesktopWindow({ computer: { id: 'c1' }, desktopState: payload.desktopState });
    await flush();
    return { dom, window, doc, el, calls, time, options: calls.attach.at(-1),
        choice: value => { choice = value; }, resolve: value => confirmResolve(value), inset: value => { inset = value; },
        resize: () => resizeObserver(), dispose: () => { window.dispatchEvent(new window.Event('ezil:teardown')); dom.window.close(); } };
}

await test('window flag is strict; fallback and off path retain the legacy option shape', async () => {
    for (const flag of [null, false, 'true', 1]) {
        const h = await harness({ flag });
        assert.equal(h.calls.attach.length, 1); assert.equal(h.options.variant, undefined);
        assert.deepEqual(Object.keys(h.options), ['title', 'icon', 'flash_on_attach', 'actions']);
        const before = h.calls.measures; h.resize(); assert.equal(h.calls.measures, before + 1); h.dispose();
    }
    const h = await harness({ attachFailure: true }); assert.equal(h.calls.attach.length, 2);
    assert.equal(h.options.variant, undefined); h.el._ezil_maximise(); assert.equal(h.doc.querySelector('.desktop').hasAttribute('inert'), false); h.dispose();
});
await test('floating options expose traffic and conditional feedback/focus with pinned hooks', async () => {
    for (const enabled of [true, false]) {
        const h = await harness({ feedback: enabled, focus: enabled, fullscreenEnabled: enabled });
        assert.equal(h.options.variant, 'floating'); assert.equal(h.options.traffic.expand_supported, enabled);
        assert.equal(h.options.overflow.length, enabled ? 1 : 0);
        assert.equal(typeof h.options.on_feedback, enabled ? 'function' : 'undefined');
        if (enabled) {
            assert.equal(h.options.overflow[0].className, 'dashboard-app-drawer-focus-chromium');
            h.options.on_feedback(); assert.deepEqual(h.calls.feedback, ['pill']);
            h.options.overflow[0].onClick(); await flush();
            assert.deepEqual(h.calls.statuses, ['Show the browser…', 'Your computer refused that']);
        }
        h.dispose();
    }
});
await test('red cancels/refocuses, minimises without release, closes via existing release, and shared skips confirmation', async () => {
    for (const choice of ['cancel', 'minimize', 'close', 'shared']) {
        const h = await harness(); h.el._ezil_maximise();
        if (choice === 'shared') { const other = h.doc.createElement('div'); other.className = 'window'; other.dataset.ezilComputerId = 'c1'; h.doc.body.append(other); }
        h.choice(choice); h.options.traffic.on_close(); await flush();
        assert.equal(h.calls.confirms, choice === 'shared' ? 0 : 1);
        assert.equal(h.calls.closes, ['shared', 'close'].includes(choice) ? 1 : 0);
        assert.equal(h.calls.releases, choice === 'close' ? 1 : 0);
        assert.equal(h.calls.hides, choice === 'minimize' ? 1 : 0);
        if (choice === 'cancel') assert.equal(h.doc.activeElement.className, 'dashboard-app-drawer-close');
        else assert.equal(h.doc.querySelector('.desktop').hasAttribute('inert'), false);
        h.dispose();
    }
});
await test('repeated red clicks open one confirmation and a late answer after disposal cannot close', async () => {
    const h = await harness(); h.choice('pending'); h.options.traffic.on_close(); h.options.traffic.on_close();
    assert.equal(h.calls.confirms, 1); h.dispose(); h.resolve('close'); await flush();
    h.options.traffic.on_close(); assert.equal(h.calls.closes, 0); assert.equal(h.calls.confirms, 1);
});
await test('body and viewport resize share one measurement; keyboard/minimise/dispose cancel pending work', async () => {
    const h = await harness(); const before = h.calls.measures;
    h.resize(); h.time.tick(200); h.window.dispatchEvent(new h.window.Event('resize'));
    h.time.tick(499); assert.equal(h.calls.measures, before); h.time.tick(1); assert.equal(h.calls.measures, before + 1);
    h.resize(); h.inset(300); h.time.tick(500); assert.equal(h.calls.measures, before + 1);
    h.resize(); h.inset(0); h.time.tick(500); assert.equal(h.calls.measures, before + 1);
    h.resize(); h.options.traffic.on_minimize(); h.time.tick(500); assert.equal(h.calls.measures, before + 1);
    h.window.dispatchEvent(new h.window.Event('resize')); h.time.tick(500); assert.equal(h.calls.measures, before + 1);
    h.el.setAttribute('data-is_minimized', 'false'); h.resize(); h.dispose(); h.time.tick(500);
    assert.equal(h.calls.measures, before + 1);
    h.resize(); h.time.tick(500); assert.equal(h.calls.measures, before + 1);
});
await test('capture registration and no-attempt controls coexist with strict source/origin/attempt viewer gate', async () => {
    const h = await harness({ configured: true }); const iframe = h.el.querySelector('iframe');
    assert.equal(h.calls.captures.length, 1); assert.equal(h.calls.captures[0].iframe, iframe);
    assert.equal(h.calls.captures[0].origin, 'https://frame.test');
    const attempt = new URL(iframe.src).searchParams.get('ezilAttempt');
    const send = (type, overrides = {}) => h.window.dispatchEvent(new h.window.MessageEvent('message', {
        source: iframe.contentWindow, origin: 'https://frame.test', data: { source: 'ezil-mobile', type }, ...overrides,
    }));
    send('edge_reveal'); send('controls_hotkey'); assert.equal(h.calls.reveals, 2); assert.equal(h.calls.grabbers, 1);
    send('controls_hotkey', { origin: 'https://wrong.test' }); send('edge_reveal', { source: h.window });
    assert.equal(h.calls.reveals, 2);
    send('stream_vitals'); send('stream_vitals', { data: { source: 'ezil-mobile', type: 'stream_vitals', attempt: 'stale' } });
    assert.equal(h.calls.frames, 0);
    send('stream_vitals', { data: { source: 'ezil-mobile', type: 'stream_vitals', attempt } }); assert.equal(h.calls.frames, 1);
    h.dispose();
});
