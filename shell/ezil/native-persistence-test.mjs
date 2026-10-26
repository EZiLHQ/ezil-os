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
globalThis.MutationObserver = class { constructor(fn) { observer = this; this.callback = fn; } observe() {} takeRecords() { return []; } disconnect() { this.disconnected = true; } };
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
const preferences = { wallpaper: 'aurora', accent: 'violet', previewPort: 3000, browser: { tabs: ['', 'https://example.com/'], activeIndex: 1 }, layout: [row, { ...row, app: 'code', minimized: true }] };
assert.equal(safeDesktopPreferences({ browser: { tabs: ['file:///private'], activeIndex: 0 } }).browser, undefined);
let readOK = true, remote = structuredClone(preferences);
window.ezilNative = { async operation(op) { calls.push(op); if (op.op === 'desktop.write') remote = structuredClone(op.preferences); return op.op === 'desktop.read' ? { ok: readOK, preferences: remote } : { ok: true }; } };
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
assert.equal(calls.length, count + 2, 'preference events debounce into one read/merge/write');
assert.equal(calls.at(-1).preferences.accent, 'rose');
assert.equal(JSON.stringify(calls.at(-1)).includes('must not copy'), false);
assert.deepEqual(calls.at(-1).preferences.layout.map(x => x.app), ['code']);
persistence.dispose(false); assert.equal(observer.disconnected, true);
console.log('PASS native-only read, allowlists, viewport clamping, restore ordering, minimize/close capture, workspace filtering and debounce');

// A second app-targeted OS tab does not replay all saved windows or discard
// their layout/tabs when this tab flushes its own state.
windows.length = 0; launched.length = 0; remote = structuredClone(saved.preferences);
const targeted = await restoreNativeDesktop(saved, ctx, async app => {
    launched.push(app); const el = makeWindow(app); windows.push(el); return el;
}, { onlyApp: 'code' });
assert.deepEqual(launched, ['code']);
await targeted.flush();
assert.deepEqual(calls.at(-1).preferences.layout.map(row => row.app).sort(), ['browser', 'code']);
assert.deepEqual(calls.at(-1).preferences.browser, preferences.browser);
windows.length = 0; await targeted.flush();
assert.deepEqual(calls.at(-1).preferences.layout.map(row => row.app), ['browser'], 'closing target retains unopened windows');
windows.push(makeWindow('desktop')); await targeted.flush();
windows.length = 0; await targeted.flush();
assert.deepEqual(calls.at(-1).preferences.layout, [], 'opening then closing deferred Browser is an explicit close');
targeted.dispose(false);
console.log('PASS targeted restore preserves unopened windows and Browser tabs');

// Rapid open then close before the debounce sees a live window.
remote = structuredClone(saved.preferences);
const quick = await restoreNativeDesktop(saved, ctx, async app => { const el = makeWindow(app); windows.push(el); return el; }, { onlyApp: 'code' });
const transient = makeWindow('desktop'); transient.matches = selector => selector === '.window';
observer.callback([{ type: 'childList', addedNodes: [transient], removedNodes: [transient] }]);
await quick.flush();
assert.equal(remote.layout.some(row => row.app === 'browser'), false, 'rapid explicit close is not resurrected');
quick.dispose(false); windows.length = 0;

// Another renderer changes/ closes windows after our read. An unrelated local
// preference write preserves that newer layout and its newer Browser tabs.
remote = structuredClone(saved.preferences);
const stale = await restoreNativeDesktop(saved, ctx, async app => { const el = makeWindow(app); windows.push(el); return el; }, { onlyApp: 'code' });
await stale.flush();
remote.layout = [{ ...saved.preferences.layout[1], app: 'settings', x: 33 }];
remote.browser = { tabs: ['https://newer.example/'], activeIndex: 0 };
values.set('settings.accent', 'amber');
await stale.flush();
assert.deepEqual(remote.layout.map(row => row.app), ['settings'], 'unrelated save preserves other renderer close and open');
assert.deepEqual(remote.browser, { tabs: ['https://newer.example/'], activeIndex: 0 });
assert.equal(remote.accent, 'amber');
stale.dispose(false);
console.log('PASS rapid open/close and stale renderer merge');

// Two renderers queue writes together. Web Locks serialize their host reads,
// so each merges against the other's committed result rather than a stale read.
remote = structuredClone(saved.preferences); windows.length = 0;
let lockQueue = Promise.resolve(), lockCalls = 0;
window.navigator = { locks: { request: (name, fn) => {
    assert.equal(name, 'ezil-desktop:workspace-a'); lockCalls++;
    const result = lockQueue.then(fn); lockQueue = result.catch(() => {}); return result;
} } };
const first = await restoreNativeDesktop(saved, ctx, async app => { const el = makeWindow(app); windows.push(el); return el; }, { onlyApp: 'code' });
windows[0].attrs.set('data-is_minimized', 'false'); windows[0].style.left = '91px'; windows[0].style.width = '400px';
const firstWrite = first.flush();
windows.length = 0;
const second = await restoreNativeDesktop(saved, ctx, async () => null, { onlyApp: 'settings' });
const settings = makeWindow('settings'); settings.style.left = '40px'; windows.push(settings);
await Promise.all([firstWrite, second.flush()]);
assert.equal(lockCalls, 2);
assert.equal(remote.layout.find(row => row.app === 'code').x, 91);
assert.equal(remote.layout.find(row => row.app === 'settings').x, 40);
assert.ok(remote.layout.some(row => row.app === 'browser'));
first.dispose(false); second.dispose(false);
console.log('PASS simultaneous renderer writes merge under a workspace Web Lock');
