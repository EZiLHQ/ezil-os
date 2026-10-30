// app-history-test.mjs — the address-bar owner (`app-history.js`), unbundled:
// its pure helpers, then the controller against a bare jsdom window with
// stand-in app windows. The bundled, end-to-end version of the same contract
// is in app-link-test.mjs (jsdom) and app-link-browser-test.mjs (Chromium).
// Run: cd shell && node ezil/app-history-test.mjs   (no build needed)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
// app-history.js imports './app-link.js'; a data: module cannot resolve that.
const link = dataUrl(readFileSync(new URL('./app-link.js', import.meta.url), 'utf8'));
const history = readFileSync(new URL('./app-history.js', import.meta.url), 'utf8').replace("from './app-link.js'", `from '${link}'`);
const { appUrl, encodeQueryValue, linkParams, mergeHistoryState, canonicalUrl, routeLaunchContext, createAppHistory, OS_PATH } = await import(dataUrl(history));
let checks = 0;
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const same = (actual, expected, message) => { assert.deepEqual(plain(actual), plain(expected), message); checks += 1; };
const ok = (value, message) => { assert.ok(value, message); checks += 1; };

const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const R = '12345678-9abc-4def-8123-456789abcdef';
const C = '11111111-1111-4111-8111-111111111111';

// ── pure helpers ────────────────────────────────────────────────────────────
same(OS_PATH, '/os');
same(encodeQueryValue('src/a b&c'), 'src/a%20b%26c', '/ stays readable; everything else is encoded');
same(appUrl('code'), '/app/code');
same(appUrl('code', { project: P, repo: R, path: 'src/main.ts' }), `/app/code?project=${P}&repo=${R}&path=src/main.ts`);
same(appUrl('settings', [['tab', 'billing'], ['computer', C]]), `/app/settings?tab=billing&computer=${C}`);
same(appUrl('settings', { tab: undefined, x: '', y: null }), '/app/settings', 'empty values are left out');
same(linkParams({ id: 'settings', initialTab: 'usage' }), { tab: 'usage' });
same(linkParams({ id: 'code', project: { projectId: P, repoId: R } }), { project: P, repo: R });
same(linkParams({ id: 'desktop' }), {});
same(linkParams(null), {});
// History-state merge: unknown keys (Next's, a later lane's) survive.
const next = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] }, ezilProjectLaunchIntent: { id: 1 }, ezilView: 'full' };
same(mergeHistoryState(next, { ezilApp: 'code' }), { ...next, ezilApp: 'code' });
same(mergeHistoryState(next, { ezilView: undefined }), { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] }, ezilProjectLaunchIntent: { id: 1 } }, 'undefined deletes');
same(mergeHistoryState(null, { ezilApp: 'code' }), { ezilApp: 'code' });
same(mergeHistoryState('legacy', { ezilApp: 'code' }), { ezilApp: 'code' }, 'a non-object state is not spread');
same(mergeHistoryState([1], {}), {});
ok(mergeHistoryState(next, {}) !== next, 'never mutates the previous state');
// Canonical spelling: selectors go, everything else stays byte for byte.
const loc = (search, hash = '') => ({ pathname: '/os', search, hash });
same(canonicalUrl(loc('?app=code&project=a%2Fb&x=%41'), { id: 'code' }), '/app/code?project=a%2Fb&x=%41');
same(canonicalUrl(loc(`?computer=${C}&settings=billing&tab=old`), { id: 'settings', initialTab: 'billing' }), `/app/settings?tab=billing&computer=${C}`);
same(canonicalUrl(loc('?settings=bogus&app=settings&tab=old'), { id: 'settings' }), '/app/settings?tab=old', 'no valid tab: nothing to replace');
same(canonicalUrl(loc('?app=browser', '#h'), { id: 'desktop' }), '/app/desktop#h');
same(canonicalUrl(loc('?app=code&upgrade=pro'), { id: 'code' }, { search: '?keep=1' }), '/app/code?keep=1', 'a consumed query can be passed in');
same(canonicalUrl(loc(''), { id: 'code' }), '/app/code');
same(canonicalUrl(loc('?app%3D=1&%61pp=code'), { id: 'code' }), '/app/code?app%3D=1', 'keys compare decoded');
// The launch context a route gives an app (contract item 3).
same(routeLaunchContext({ id: 'code' }), { view: 'full' });
same(routeLaunchContext({ id: 'code' }, { hasWindow: true }), {}, 'Back to an open Code does not resize it');
same(routeLaunchContext({ id: 'code' }, { hasWindow: true, recordedView: 'full' }), { view: 'full' });
same(routeLaunchContext({ id: 'code' }, { recordedView: 'window' }), { view: 'window' }, "the entry's own choice wins");
same(routeLaunchContext({ id: 'code' }, { recordedView: 'huge' }), { view: 'full' });
same(routeLaunchContext({ id: 'code', project: { projectId: P, repoId: R } }), { project: { projectId: P, repoId: R }, view: 'full' });
same(routeLaunchContext({ id: 'settings', initialTab: 'billing' }), { initialTab: 'billing' });
same(routeLaunchContext({ id: 'desktop' }), {}, 'only Code gets a view');

// ── the controller, against a bare window ───────────────────────────────────
function harness (entry, { provider = 'cloudflare-guacamole', state = { __NA: true } } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: `https://os.example${entry}` });
    const w = dom.window;
    w.history.replaceState(state, '', w.location.href);
    const launches = [];
    const controller = createAppHistory();
    controller.install({
        win: w, payload: { desktopState: { provider } },
        getApps: () => ['desktop', 'code', 'settings'].map(id => ({ id })),
        launch: async (id, ctx) => { launches.push([id, ctx]); return null; },
        launchContext: () => ({ computer: { id: C } }),
    });
    const open = (id, z) => {
        const el = w.document.createElement('div');
        el.className = 'window';
        el.setAttribute('data-app', id);
        el.style.zIndex = String(z);
        w.document.body.append(el);
        return el;
    };
    const focus = el => {
        for (const other of w.document.querySelectorAll('.window')) other.classList.toggle('window-active', other === el);
        w.dispatchEvent(new w.CustomEvent('ezil:window-focus', { detail: { window: el } }));
    };
    const close = el => { el.remove(); w.dispatchEvent(new w.CustomEvent('ezil:window-closed', { detail: { window: el, app: el.getAttribute('data-app') } })); };
    const url = () => `${w.location.pathname}${w.location.search}${w.location.hash}`;
    return { w, controller, launches, open, focus, close, url };
}
{
    const { w, controller, open, focus, close, url } = harness(`/os?computer=${C}`);
    same(controller.enabled, true);
    const settings = open('settings', 10);
    controller.commit('settings', {});
    same([url(), w.history.length, w.history.state], [`/app/settings?computer=${C}`, 2, { __NA: true, ezilApp: 'settings' }], 'push keeps state keys');
    const release = controller.hold();
    const code = open('code', 11);
    focus(code);
    same(url(), `/app/settings?computer=${C}`, 'a focus during a held launch writes nothing');
    release(); release();
    controller.commit('code', { project: { projectId: P, repoId: R, path: 'src' } });
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 3]);
    focus(code);
    same(w.history.length, 3, 'the hold is released exactly once');
    focus(settings);
    same([url(), w.history.length], [`/app/settings?computer=${C}`, 3], 'focus replaces');
    focus(code);
    same(url(), `/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, "focus restores the app's own parameters");
    controller.commit('code', {});
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 3], 'a dock click on the named app: no entry, same URL');
    controller.commit('settings', { initialTab: 'usage' });
    same([url(), w.history.length], [`/app/settings?tab=usage&computer=${C}`, 4]);
    controller.commit('settings', {});
    same([url(), w.history.length], [`/app/settings?computer=${C}`, 4], 'Settings reopened at its default drops the tab, in place');
    controller.commit('settings', { initialTab: 'usage', historyMode: 'none' });
    same(url(), `/app/settings?computer=${C}`, "historyMode 'none' writes nothing");
    controller.commit('code', { historyMode: 'replace' });
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 4], "historyMode 'replace' never pushes");
    controller.commit('unknown', {});
    same(w.history.length, 4, 'an app the registry does not list is ignored');
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'window' } }));
    same([w.history.state.ezilView, controller.recordedView('code'), controller.recordedView('settings')], ['window', 'window', undefined]);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'full' } }));
    same([w.history.state.ezilView, w.history.state.__NA, w.history.length], ['full', true, 4]);
    // Close: the front app takes the entry; a background close changes nothing.
    focus(code);
    close(settings);
    same(url(), `/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 'closing a background window leaves the entry alone');
    same(w.history.state.ezilView, 'full');
    const desktop = open('desktop', 5);
    const settings2 = open('settings', 20);
    code.classList.remove('window-active');
    close(code);
    same(url(), `/app/settings?computer=${C}`, 'no focused window: the most recently focused visible one');
    same(w.history.state.ezilView, undefined, "Code's view leaves with Code");
    settings2.setAttribute('data-is_minimized', '1');
    close(settings2);
    same(url(), `/app/desktop?computer=${C}`, 'a minimised window is not in front');
    close(desktop);
    same([url(), w.history.length, w.history.state.ezilApp], [`/os?computer=${C}`, 4, undefined], 'the last close returns to /os, in place');
    focus(open('code', 30));
    same(url(), `/app/code?computer=${C}`, "a closed app's parameters are forgotten");
}
{
    // Back/Forward: focus or launch, with the entry's own context; never push.
    const { w, launches } = harness('/os', { state: null });
    w.history.pushState({ __NA: true, ezilApp: 'code', ezilView: 'window' }, '', `/app/code?project=${P}&repo=${R}`);
    w.history.pushState({ __NA: true }, '', '/app/settings?tab=billing');
    w.history.pushState({ __NA: true }, '', '/os?app=nothing');
    w.history.back(); await new Promise(resolve => setTimeout(resolve, 30));
    w.history.back(); await new Promise(resolve => setTimeout(resolve, 30));
    w.history.forward(); await new Promise(resolve => setTimeout(resolve, 30));
    w.history.forward(); await new Promise(resolve => setTimeout(resolve, 30));
    same(launches, [
        ['settings', { computer: { id: C }, initialTab: 'billing', historyMode: 'replace' }],
        ['code', { computer: { id: C }, project: { projectId: P, repoId: R }, view: 'window', historyMode: 'replace' }],
        ['settings', { computer: { id: C }, initialTab: 'billing', historyMode: 'replace' }],
    ], 'an unusable entry launches nothing');
    same(w.history.length, 4);
}
{
    // Adopt: the boot's link is canonicalised in place, once, without pushing.
    const { w, controller, url } = harness(`/os?app=code&computer=${C}#top`, { state: { __NA: true, ezilApp: 'settings', ezilView: 'full' } });
    controller.adopt({ id: 'code' });
    same([url(), w.history.length, w.history.state], [`/app/code?computer=${C}#top`, 1, { __NA: true, ezilApp: 'code' }]);
    controller.adopt(null);
    same(url(), `/app/code?computer=${C}#top`);
}
for (const provider of ['native-macos', 'local-vm']) {
    const { w, controller, open, focus, close, url, launches } = harness('/os?settings=billing&upgrade=pro&x=1', { provider });
    same(controller.enabled, false, provider);
    controller.adopt({ id: 'settings', initialTab: 'billing' }, { search: '?x=1' });
    same(url(), '/os?x=1', `${provider}: the consumed keys go, the path stays`);
    controller.adopt({ id: 'settings', initialTab: 'billing' });
    same(url(), '/os?x=1', `${provider}: never canonicalised`);
    const el = open('code', 1);
    controller.commit('code', {});
    focus(el); close(el);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'full' } }));
    same([url(), w.history.length], ['/os?x=1', 1], `${provider}: nothing else writes`);
    w.history.pushState(null, '', '/os?app=code');
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    same(launches.map(([id]) => id), ['code'], `${provider}: Back/Forward still focuses`);
}
{
    // Installing twice binds once (a shell rebuild calls install again).
    const { w, controller, launches } = harness('/os');
    controller.install({ win: w, payload: {}, getApps: () => [{ id: 'code' }], launch: async (id) => { launches.push([id]); }, launchContext: () => ({}) });
    w.history.pushState(null, '', '/app/code');
    w.dispatchEvent(new w.PopStateEvent('popstate'));
    same(launches.length, 1, 'one listener, using the latest getters');
}
console.log(`PASS ${checks} checks: app-history helpers, push/replace/hold, focus, close, view recording, Back/Forward, adopt, /os-only hosts, idempotent install`);
