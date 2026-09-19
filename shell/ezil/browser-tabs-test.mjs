import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const runtimeURL = moduleURL(readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8'));
const { browserOmnibox, safeBrowserTabs, NATIVE_CAPABILITIES } = await import(runtimeURL);
for (const [input, expected] of [
    ['weather in London', 'https://www.google.com/search?q=weather%20in%20London'], ['cats', 'https://www.google.com/search?q=cats'],
    ['example.com', 'https://example.com/'], ['localhost:3000/path', 'http://localhost:3000/path'], ['[::1]:3000', 'http://[::1]:3000/'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'], ['example.com:8443', 'https://example.com:8443/'],
]) assert.equal(browserOmnibox(input), expected, input);
for (const input of ['', 'file:///private/test', 'javascript:alert(1)', 'data:text/html,hello', 'https://u:p@example.com', 'u:p@example.com',
    '/Users/test/document.txt', '~/Documents', '../secret', './secret', 'C:\\Users\\test', '\\\\server\\file', 'src/private',
    'http://example.com', 'https://', 'example..com', 'localhost:99999', 'example.com:bad', 'https://bad host', 'hello\nworld']) {
    assert.equal(browserOmnibox(input), null, `must never search: ${input}`);
}
assert.deepEqual(safeBrowserTabs({ tabs: ['', 'https://example.com/'], activeIndex: 1, secret: 'discard' }), { tabs: ['', 'https://example.com/'], activeIndex: 1 });
assert.equal(browserOmnibox('a'.repeat(4096)), null, 'encoded search URL must fit the bridge/persistence limit');
assert.equal(browserOmnibox('猫'.repeat(1000)), null, 'percent encoding cannot bypass the URL length limit');
for (const value of [{ tabs: [], activeIndex: 0 }, { tabs: Array(21).fill(''), activeIndex: 0 }, { tabs: ['https://example.com'], activeIndex: 0 },
    { tabs: ['file:///private'], activeIndex: 0 }, { tabs: [''], activeIndex: 1 }]) assert.equal(safeBrowserTabs(value), null);

const dom = new JSDOM('<div class="window window-active"><div class="window-head-title"></div><div class="window-body"><iframe class="window-app-iframe"></iframe></div></div>', { pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, { window, document: window.document, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window) });
const ctx = { computer: { id: randomUUID() }, desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES },
    browserTabs: { tabs: ['https://a.example/', 'https://b.example/', 'https://c.example/'], activeIndex: 1 } };
const listeners = { state: new Set(), shortcut: new Set(), newTab: new Set() }, calls = [], visible = new Set(), identities = new Map();
let blockAttach = false, releaseAttach, failAttach = false, blockHide = false, releaseHide;
const initial = { revision: 1, url: '', title: '', loading: false, error: null, canGoBack: false, canGoForward: false, zoomFactor: 1 };
const subscribe = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
window.ezilNative = {
    subscribeBrowserState: subscribe('state'), subscribeBrowserShortcut: subscribe('shortcut'), subscribeBrowserNewTab: subscribe('newTab'),
    async operation(op) {
        calls.push(op);
        if (op.op === 'browser.attach') {
            identities.set(op.surfaceId, op);
            if (blockAttach) { blockAttach = false; await new Promise(resolve => { releaseAttach = resolve; }); }
            if (failAttach) { failAttach = false; return { ok: false }; }
        }
        if (op.op === 'browser.layout') {
            if (!op.visible && blockHide) { blockHide = false; await new Promise(resolve => { releaseHide = resolve; }); }
            if (op.visible && !op.occluded) visible.add(op.surfaceId); else visible.delete(op.surfaceId);
            assert.ok(visible.size <= 1, 'never expose two native surfaces together');
        }
        if (op.op === 'browser.detach') visible.delete(op.surfaceId);
        return { ...op, ok: true, state: 'ready', ...(op.op === 'browser.attach' ? { browserState: initial } : {}) };
    },
};
const source = readFileSync(new URL('./apps/native.js', import.meta.url), 'utf8').replace("'../native-runtime.js'", JSON.stringify(runtimeURL))
    .replace("import AppSpinner from '../ui/app-spinner.js';", 'const AppSpinner = () => ({ el: document.createElement("div"), render() {} });')
    .replace("import { computeBootUiState } from '../boot-phases.js';", 'const computeBootUiState = x => x;');
const { bindNativeBrowser } = await import(moduleURL(source));
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const el = document.querySelector('.window'); bindNativeBrowser(el, ctx);
const chrome = el.querySelector('.ezil-native-browser-chrome');
chrome.getBoundingClientRect = () => ({ x: 0, y: 0, width: 500, height: 112 });
el.querySelector('.ezil-native-browser-viewport').getBoundingClientRect = () => ({ x: 0, y: 78, width: 800, height: 500 });
const signal = detail => window.dispatchEvent(new window.CustomEvent('ezil:native-composition', { detail }));
const emit = (kind, id, value) => { for (const fn of listeners[kind]) fn({ ...identities.get(id), ...value }); };
const tabs = () => [...el.querySelectorAll('[role="tab"]')];
const address = el.querySelector('input'), add = el.querySelector('.ezil-native-browser-add');
const type = value => { address.focus(); address.value = value; address.dispatchEvent(new window.Event('input')); };
const key = (value, extra = {}) => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, metaKey: true, cancelable: true, ...extra }));
await flush(); signal({}); await flush();
assert.equal(chrome.dataset.compact, 'true', 'compact layout follows Browser window width, not outer viewport');
assert.equal(el.querySelector('.window-body').style.getPropertyValue('--ezil-browser-chrome-height'), '112px');
chrome.getBoundingClientRect = () => ({ x: 0, y: 0, width: 531, height: 78 }); signal({}); await flush();
assert.equal(chrome.dataset.compact, 'false');
assert.equal(el.querySelector('.ezil-native-browser-zoom-value').textContent, '100%');
assert.equal(identities.size, 1, 'only active restored tab attaches');
const b = [...identities.keys()][0]; assert.equal(calls.find(op => op.op === 'browser.navigate').url, 'https://b.example/');
emit('state', b, { ...initial, revision: 2, url: 'https://b.example/', title: 'Bee' });
emit('state', b, { ...initial, revision: 3, url: 'https://b.example/', title: 'Bee', zoomFactor: 1.25 });
assert.equal(el.querySelector('.ezil-native-browser-zoom-value').textContent, '125%');
key('='); await flush(); assert.equal(calls.findLast(op => op.op.startsWith('browser.zoom')).op, 'browser.zoom-in');
type('unfinished draft');
blockHide = true; tabs()[0].click(); await flush();
assert.equal(identities.size, 2); assert.equal(visible.has(b), true, 'old tab remains until hide acknowledgment');
const a = [...identities.keys()][1]; assert.ok(!visible.has(a)); releaseHide(); await flush();
assert.deepEqual([...visible], [a]);
emit('state', a, { ...initial, revision: 2, url: 'https://a.example/', title: 'Aye' });
emit('state', b, { ...initial, revision: 4, url: 'https://b.example/', title: 'Bee background', loading: true, error: 'navigation_failed' });
assert.equal(address.value, 'https://a.example/'); assert.equal(tabs()[1].getAttribute('aria-busy'), 'true');
assert.equal(tabs()[1].dataset.failed, 'true');
tabs()[1].click(); await flush(); assert.equal(address.value, 'unfinished draft');
assert.equal(el.ezilBrowserTabs().tabs[1], 'https://b.example/', 'drafts are never persisted');
emit('newTab', b, { url: 'https://background.example/', background: true }); await flush();
assert.equal(tabs().length, 4); assert.equal(identities.size, 2, 'background popup remains lazy');
for (const value of [{ url: 'file:///private', background: true }, { url: 'https://safe.example/', background: true, generation: 999 },
    { url: 'https://safe.example/', background: true, workspaceId: randomUUID() }]) emit('newTab', b, value);
assert.equal(tabs().length, 4);
key('Tab', { metaKey: false, ctrlKey: true }); await flush(); assert.equal(el.ezilBrowserTabs().activeIndex, 2);
key('Tab', { metaKey: false, ctrlKey: true, shiftKey: true }); await flush(); assert.equal(el.ezilBrowserTabs().activeIndex, 1);
type('weather in London'); address.form.dispatchEvent(new window.Event('submit', { cancelable: true })); await flush();
assert.equal(calls.findLast(op => op.op === 'browser.navigate').url, 'https://www.google.com/search?q=weather%20in%20London');
assert.equal(address.value, 'https://www.google.com/search?q=weather%20in%20London');
assert.equal(el.ezilBrowserTabs().tabs[1], address.value, 'validated pending destination survives close/reopen');
emit('state', b, { ...initial, revision: 5, url: 'https://b.example/', loading: true });
assert.equal(el.ezilBrowserTabs().tabs[1], 'https://www.google.com/search?q=weather%20in%20London', 'old loading URL cannot discard the submission');
emit('state', b, { ...initial, revision: 6, url: 'https://www.google.com/search?q=weather%20in%20London', loading: false });
assert.equal(el.ezilBrowserTabs().tabs[1], 'https://www.google.com/search?q=weather%20in%20London');
const beforeBad = calls.filter(op => op.op === 'browser.navigate').length;
type('file:///private'); address.form.dispatchEvent(new window.Event('submit', { cancelable: true })); await flush();
assert.equal(calls.filter(op => op.op === 'browser.navigate').length, beforeBad);
assert.equal(address.getAttribute('aria-invalid'), 'true');
blockAttach = true; key('t'); await flush(); const pendingId = [...identities.keys()].at(-1);
key('w'); releaseAttach(); await flush();
assert.equal(calls.filter(op => op.op === 'browser.detach' && op.surfaceId === pendingId).length, 1);
assert.ok(!visible.has(pendingId)); const afterClose = tabs().length;
emit('newTab', pendingId, { url: 'https://late.example/', background: false }); assert.equal(tabs().length, afterClose);
failAttach = true; add.click(); await flush();
assert.equal(tabs().at(-1).dataset.failed, 'true'); el.querySelector('[data-action="reload"]').click(); await flush();
assert.equal(tabs().at(-1).dataset.failed, 'false', 'retry is local to failed tab');
while (tabs().length < 20) { add.click(); await flush(); }
assert.equal(add.disabled, true); key('t'); await flush(); assert.equal(tabs().length, 20);
signal({ overlay: 'menu', open: true }); await flush(); assert.equal(visible.size, 0);
signal({ overlay: 'menu', open: false }); await flush(); assert.equal(visible.size, 1);
signal({ window: el, visible: false }); await flush(); assert.equal(visible.size, 0);
signal({ window: el, visible: true }); await flush(); assert.equal(visible.size, 1);
await el.on_before_exit(); await flush(); assert.equal(visible.size, 0);
for (const set of Object.values(listeners)) assert.equal(set.size, 0);
dom.window.close();
console.log('PASS omnibox safety, lazy restored tabs, independent drafts/state, hide-before-show, popup identity, shortcuts, close/open races, retries, cap, occlusion and disposal');
