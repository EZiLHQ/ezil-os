import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const runtimeURL = moduleURL(readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8'));
const { browserAddress, selectRuntimeAdapter, NATIVE_CAPABILITIES } = await import(runtimeURL);
for (const [input, expected] of [['localhost:3000', 'http://localhost:3000/'], ['127.0.0.1:8080/a', 'http://127.0.0.1:8080/a'], ['[::1]:4000', 'http://[::1]:4000/'], ['example.com', 'https://example.com/'], ['javascript:alert(1)', null], ['https://u:p@example.com', null], ['http://example.com', null]]) assert.equal(browserAddress(input), expected);
const dom = new JSDOM('<div class="window window-active"><div class="window-head-title"></div><div class="window-body"><iframe class="window-app-iframe"></iframe></div></div>', { pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
const ctx = { computer: { id: randomUUID() }, desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES } };
const states = new Set(), shortcuts = new Set(), calls = [];
let removed = 0;
const state = { revision: 1, url: 'https://example.com/', title: 'Example', loading: false, error: null, canGoBack: true, canGoForward: false };
window.ezilNative = {
    subscribeBrowserState(fn) { states.add(fn); return () => { states.delete(fn); removed++; }; },
    subscribeBrowserShortcut(fn) { shortcuts.add(fn); return () => { shortcuts.delete(fn); removed++; }; },
    async operation(op) { calls.push(op); return { ...op, ok: true, state: 'ready', ...(op.op === 'browser.attach' ? { browserState: state } : {}) }; },
};
const flush = () => new Promise(resolve => setImmediate(resolve));
const surface = selectRuntimeAdapter(ctx).surface('browser');
const received = []; surface.subscribeBrowserState(s => received.push(s));
await surface.open(); const identity = calls.at(-1);
const emit = value => { for (const fn of states) fn({ ...identity, ...value }); };
emit({ ...state, revision: 2, surfaceId: randomUUID() });
emit({ ...state, revision: 2, generation: 99 });
emit({ ...state, revision: 2, url: 'file:///private' });
assert.equal(received.length, 1);
emit({ ...state, revision: 3, title: 'New', secret: 'discard' });
emit({ ...state, revision: 2, title: 'Old' });
assert.equal(received.length, 2); assert.equal(received[1].title, 'New'); assert.equal(received[1].secret, undefined);
surface.dispose(); assert.equal(removed, 2); await flush();

const source = readFileSync(new URL('./apps/native.js', import.meta.url), 'utf8')
    .replace("'../native-runtime.js'", JSON.stringify(runtimeURL))
    .replace("import AppSpinner from '../ui/app-spinner.js';", 'const AppSpinner = () => ({ el: document.createElement("div"), render() {} });')
    .replace("import { computeBootUiState } from '../boot-phases.js';", 'const computeBootUiState = x => x;');
const { bindNativeBrowser } = await import(moduleURL(source));
const el = document.querySelector('.window'); bindNativeBrowser(el, { ...ctx, browserTabs: { tabs: [state.url], activeIndex: 0 } }); await flush();
const viewport = el.querySelector('.ezil-native-browser-viewport'), address = el.querySelector('input');
for (const [action, label] of [['back', 'Back'], ['forward', 'Forward'], ['reload', 'Reload']]) {
    assert.equal(el.querySelector(`[data-action="${action}"]`).getAttribute('aria-label'), label);
}
viewport.getBoundingClientRect = () => ({ x: 10, y: 80, width: 800, height: 500 });
const signal = detail => window.dispatchEvent(new window.CustomEvent('ezil:native-composition', { detail }));
signal({ focus: el, pointer: true }); await flush();
assert.equal(address.value, state.url); assert.equal(el.querySelector('.window-head-title').textContent, 'Example');
const focusCount = () => calls.filter(op => op.op === 'browser.focus').length;
const before = focusCount(); address.focus(); address.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
signal({ focus: el, pointer: true }); await flush(); assert.equal(focusCount(), before);
assert.equal(document.activeElement, address);
const attach = calls.findLast(op => op.op === 'browser.attach');
for (const fn of states) fn({ ...attach, ...state, revision: 2, url: 'https://redirect.example/' });
assert.equal(address.value, state.url, 'editing survives state changes');
address.value = 'localhost:3000'; address.form.dispatchEvent(new window.Event('submit', { cancelable: true })); await flush();
assert.equal(calls.findLast(op => op.op === 'browser.navigate').url, 'http://localhost:3000/');
signal({ overlay: 'menu', open: true }); await flush();
assert.equal(calls.at(-1).occluded, true); assert.ok(!calls.some(op => op.op === 'browser.snapshot'));
signal({ overlay: 'popover', open: true }); signal({ overlay: 'menu', open: false }); await flush();
assert.equal(calls.at(-1).occluded, true);
signal({ overlay: 'popover', open: false }); await flush(); assert.equal(calls.at(-1).occluded, false);
signal({ window: el, visible: false }); await flush(); assert.equal(calls.at(-1).visible, false);
signal({ window: el, visible: true }); await flush(); assert.equal(calls.at(-1).visible, true);
for (const fn of shortcuts) fn({ ...attach, action: 'address' }); assert.equal(document.activeElement, address);
await el.on_before_exit(); await flush(); assert.equal(states.size, 0); assert.equal(shortcuts.size, 0);
dom.window.close();
console.log('PASS browser address, state identity/revision filtering, disposal, toolbar focus, shortcuts and explicit composition');
