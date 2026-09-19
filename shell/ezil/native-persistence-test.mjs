import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const values = new Map(), applied = [], calls = [], windows = [];
globalThis.__persistenceSession = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
globalThis.__persistenceApply = (kind, value) => applied.push([kind, value]);
const source = readFileSync(new URL('./native-persistence.js', import.meta.url), 'utf8')
    .replace("'./native-runtime.js'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8')).toString('base64')}`))
    .replace("import session from './session.js';", 'const session = globalThis.__persistenceSession;')
    .replace("import { applyWallpaper, applyAccent } from './ui/Settings/tabs/appearance.js';", 'const applyWallpaper = value => globalThis.__persistenceApply("wallpaper", value), applyAccent = value => globalThis.__persistenceApply("accent", value);');
const { safeDesktopPreferences, prepareNativePersistence, restoreNativeDesktop } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const row = { app: 'browser', x: 9999, y: -10, width: 1000, height: 800, minimized: false };
assert.deepEqual(safeDesktopPreferences({ wallpaper: 'https://arbitrary', accent: 'rose', secret: 'discard', previewPort: 80,
    layout: [row, row, { ...row, app: 'exec' }, { ...row, app: 'code', x: NaN }] }, 400, 300),
{ accent: 'rose', layout: [{ app: 'browser', x: 0, y: 0, width: 400, height: 236, minimized: false }] });
globalThis.window = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
globalThis.document = Object.assign(new EventTarget(), { body: {}, querySelectorAll: () => windows });
let observer;
globalThis.MutationObserver = class { constructor(fn) { observer = this; this.callback = fn; } observe() {} disconnect() { this.disconnected = true; } };
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const preferences = { wallpaper: 'aurora', accent: 'violet', previewPort: 3000, browser: { tabs: ['', 'https://example.com/'], activeIndex: 1 }, layout: [row, { ...row, app: 'code', minimized: true }] };
assert.equal(safeDesktopPreferences({ browser: { tabs: ['file:///private'], activeIndex: 0 } }).browser, undefined);
let readOK = true;
window.ezilNative = { async operation(op) { calls.push(op); return op.op === 'desktop.read' ? { ok: readOK, preferences } : { ok: true }; } };
const ctx = { computer: { id: 'workspace-a' }, desktopState: { provider: 'native-macos' } };
assert.equal(await prepareNativePersistence({ ...ctx, desktopState: { provider: 'hosted' } }), null);
assert.equal(calls.length, 0);
readOK = false; assert.equal(await prepareNativePersistence(ctx), null); assert.equal(applied.length, 0); readOK = true;
const saved = await prepareNativePersistence(ctx);
assert.equal(storage.get('ezil:preview-port:workspace-a'), '3000');
assert.deepEqual(applied, [['wallpaper', 'aurora'], ['accent', 'violet']]);
const makeWindow = app => {
    const attrs = new Map([['data-app', app], ['data-ezil-computer-id', 'workspace-a']]);
    return { isConnected: true, style: {}, attrs, getAttribute: key => attrs.get(key),
        getBoundingClientRect() { return { x: parseFloat(this.style.left) || 0, y: parseFloat(this.style.top) || 0,
            width: parseFloat(this.style.width) || 500, height: parseFloat(this.style.height) || 300 }; } };
};
window.$ = el => ({ hideWindow() { el.attrs.set('data-is_minimized', 'true'); } });
const launched = [];
const persistence = await restoreNativeDesktop(saved, ctx, async app => {
    assert.deepEqual(ctx.browserTabs, preferences.browser, 'tabs supplied before Browser launch');
    assert.equal(applied.length, 2, 'appearance restored before app launch');
    assert.equal(storage.get('ezil:preview-port:workspace-a'), '3000');
    launched.push(app); const el = makeWindow(app); windows.push(el); return el;
});
assert.deepEqual(launched, ['desktop', 'code']);
assert.equal(windows[0].style.width, '800px'); assert.equal(windows[1].getAttribute('data-is_minimized'), 'true');
const browser = windows[0]; browser.style.left = '50px'; browser.style.width = '400px';
browser.ezilBrowserTabs = () => ({ tabs: ['https://committed.example/', ''], activeIndex: 0, title: 'must not persist' });
window.dispatchEvent(new CustomEvent('ezil:native-composition', { detail: { window: browser, visible: false } }));
browser.attrs.set('data-is_minimized', 'true'); browser.style.width = '0px';
await persistence.flush();
let written = calls.at(-1).preferences;
assert.equal(written.layout[0].width, 400); assert.equal(written.layout[0].x, 50); assert.equal(written.layout[0].minimized, true);
windows.splice(0, 1); await persistence.flush();
assert.deepEqual(calls.at(-1).preferences.browser, { tabs: ['https://committed.example/', ''], activeIndex: 0 }, 'retain tabs after Browser window closes; strip titles');
assert.deepEqual(ctx.browserTabs, calls.at(-1).preferences.browser, 'dock reopen receives the last committed tabs');
assert.deepEqual(calls.at(-1).preferences.layout.map(x => x.app), ['code'], 'closed window removed');
const outsider = makeWindow('settings'); outsider.attrs.set('data-ezil-computer-id', 'workspace-b'); windows.push(outsider);
values.set('settings.accent', 'rose'); storage.set('unrelated-secret', 'must not copy');
for (let i = 0; i < 5; i++) window.dispatchEvent(new CustomEvent('ezil:preferences-changed'));
const count = calls.length; await new Promise(resolve => setTimeout(resolve, 550));
assert.equal(calls.length, count + 1, 'preference events debounce into one write');
assert.equal(calls.at(-1).preferences.accent, 'rose');
assert.equal(JSON.stringify(calls.at(-1)).includes('must not copy'), false);
assert.deepEqual(calls.at(-1).preferences.layout.map(x => x.app), ['code']);
persistence.dispose(false); assert.equal(observer.disconnected, true);
console.log('PASS native-only read, allowlists, viewport clamping, restore ordering, minimize/close capture, workspace filtering and debounce');
