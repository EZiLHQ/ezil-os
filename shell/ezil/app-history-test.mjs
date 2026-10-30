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
same(routeLaunchContext({ id: 'code' }, { hasWindow: true, recordedView: 'full' }), {}, "... not even with the entry's recorded view");
same(routeLaunchContext({ id: 'code', project: { projectId: P, repoId: R } }, { hasWindow: true, recordedView: 'window' }), { project: { projectId: P, repoId: R } }, 'current behaviour: the guard drops only the view (project on traversal belongs to the later lane)');
same(routeLaunchContext({ id: 'code' }, { recordedView: 'window' }), { view: 'window' }, "the entry's own choice wins");
same(routeLaunchContext({ id: 'code' }, { recordedView: 'huge' }), { view: 'full' });
same(routeLaunchContext({ id: 'code', project: { projectId: P, repoId: R } }), { project: { projectId: P, repoId: R }, view: 'full' });
same(routeLaunchContext({ id: 'settings', initialTab: 'billing' }), { initialTab: 'billing' });
same(routeLaunchContext({ id: 'desktop' }), {}, 'only Code gets a view');

// ── the controller, against a bare window ───────────────────────────────────
// `routes`: Back/Forward launches wait in it until the test resolves one
// with a window (or null), which commits it then and there, as
// `registry.launch` does when its open resolves.
function harness (entry, { provider = 'cloudflare-guacamole', state = { __NA: true }, routes = null } = {}) {
    const dom = new JSDOM('<!doctype html><body></body>', { url: `https://os.example${entry}` });
    const w = dom.window;
    w.history.replaceState(state, '', w.location.href);
    const launches = [];
    const controller = createAppHistory();
    controller.install({
        win: w, payload: { desktopState: { provider } },
        getApps: () => ['desktop', 'code', 'settings'].map(id => ({ id })),
        launch: (id, ctx) => {
            launches.push([id, ctx]);
            if ( ! routes ) return Promise.resolve(null);
            return new Promise(done => routes.push({ id, resolve: el => { if ( el ) controller.commit(id, ctx, el); done(el); } }));
        },
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
    // Back/Forward by `delta`, resolved by the popstate itself (no timer).
    const traverse = delta => new Promise(resolve => { w.addEventListener('popstate', resolve, { once: true }); w.history.go(delta); });
    return { w, controller, launches, open, focus, close, url, traverse };
}
{
    const { w, controller, open, focus, close, url } = harness(`/os?computer=${C}`);
    same(controller.enabled, true);
    // A user's click: `begin` before the window exists, `end` with what opened.
    const gesture = (id, ctx = {}, opened = {}) => controller.begin(id, ctx)?.end(opened);
    const settings = open('settings', 10);
    gesture('settings');
    same([url(), w.history.length, w.history.state], [`/app/settings?computer=${C}`, 2, { __NA: true, ezilApp: 'settings' }], 'push keeps state keys');
    const launching = controller.begin('code', { project: { projectId: P, repoId: R, path: 'src' } });
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 3], 'the entry exists before the window does');
    const code = open('code', 11);
    focus(settings);
    same(url(), `/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 'a focus during the launch writes nothing');
    launching.end(code); launching.end(null);
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 3], 'end() runs once; the opened app keeps the entry');
    controller.settled(code); // registry's `ensureOnTop`, 120ms after the open
    focus(code);
    same(w.history.length, 3);
    focus(settings);
    same([url(), w.history.length], [`/app/settings?computer=${C}`, 3], 'focus replaces');
    focus(code);
    same(url(), `/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, "focus restores the app's own parameters");
    gesture('code');
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 3], 'a click on the named app: no entry, same URL');
    gesture('settings', { initialTab: 'usage' });
    same([url(), w.history.length], [`/app/settings?tab=usage&computer=${C}`, 4]);
    gesture('settings');
    same([url(), w.history.length], [`/app/settings?computer=${C}`, 4], 'Settings reopened at its default drops the tab, in place');
    const before = w.history.state;
    controller.begin('code', {}).end(null);
    same([url(), w.history.length, w.history.state], [`/app/settings?computer=${C}`, 5, before], 'an app that did not open gives the entry back (as a duplicate)');
    focus(code);
    same(url(), `/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, '... and keeps the parameters it had');
    controller.commit('settings', { initialTab: 'usage', historyMode: 'none' });
    same(url(), `/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, "historyMode 'none' writes nothing");
    controller.commit('settings', { historyMode: 'replace' });
    same([url(), w.history.length], [`/app/settings?computer=${C}`, 5], 'a route launch never pushes');
    controller.commit('code', { historyMode: 'replace' });
    same([url(), w.history.length], [`/app/code?project=${P}&repo=${R}&path=src&computer=${C}`, 5]);
    same([controller.begin('unknown'), w.history.length], [null, 5], 'an app the registry does not list is ignored');
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'settings', view: 'window' } }));
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'huge' } }));
    same(w.history.state.ezilView, undefined, "another app's view, or an unknown one, is not recorded on Code's entry");
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'window' } }));
    same([w.history.state.ezilView, controller.recordedView('code'), controller.recordedView('settings')], ['window', 'window', undefined]);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'full' } }));
    same([w.history.state.ezilView, w.history.state.__NA, w.history.length], ['full', true, 5]);
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
    same([url(), w.history.length, w.history.state.ezilApp], [`/os?computer=${C}`, 5, undefined], 'the last close returns to /os, in place');
    const again = open('code', 30);
    focus(again);
    same(url(), `/app/code?computer=${C}`, "a closed app's parameters are forgotten");
    // A rebuild destroyed the windows without a close: sync names what is left.
    again.remove();
    controller.sync();
    same([url(), w.history.length], [`/os?computer=${C}`, 5], 'sync: nothing open, so /os, in place');
    const front = open('settings', 40);
    focus(front);
    w.history.replaceState(w.history.state, '', '/app/code');
    controller.sync();
    same(url(), `/app/settings?computer=${C}`, 'sync: the app in front');
    // A launch that resolves after its window was destroyed does not
    // re-name it; one whose window is alive does.
    const gone = open('code', 50);
    const late = controller.begin('code', {});
    gone.remove(); focus(front); controller.sync();
    w.history.replaceState(w.history.state, '', `/app/settings?computer=${C}`);
    late.end(gone);
    same(url(), `/app/settings?computer=${C}`, 'a destroyed window is not re-named');
    const alive = open('code', 60);
    const live = controller.begin('code', {});
    w.history.replaceState(w.history.state, '', `/app/settings?computer=${C}`);
    live.end(alive);
    same(url(), `/app/code?computer=${C}`, 'positive control: a live one is');
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
for (const [recorded, later] of [['full', 'window'], ['window', 'full']]) for (const codeOpen of [true, false]) {
    // A stale recorded view: E1 recorded one view; the user later chose the
    // other on E2 (relabelled Code by a focus). Back to E1 must not resize an
    // open Code back; a closed one reopens with E1's own view (and with
    // 'window', that is not the route's default 'full').
    const { w, controller, launches, open, focus, url } = harness('/os');
    const code = open('code', 1);
    controller.begin('code').end(code);
    controller.settled(code);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: recorded } }));
    controller.begin('settings').end(open('settings', 2));
    focus(code);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: later } }));
    same([url(), w.history.length, w.history.state.ezilView], ['/app/code', 3, later], `E2 names Code, ${later}`);
    if ( ! codeOpen ) code.remove();
    w.history.back(); await new Promise(resolve => setTimeout(resolve, 30));
    same([url(), w.history.state.ezilView], ['/app/code', recorded], `Back lands on E1, which recorded ${recorded}`);
    same(launches, [['code', { computer: { id: C }, ...(codeOpen ? {} : { view: recorded }), historyMode: 'replace' }]],
        codeOpen ? 'Back to an open Code passes no view' : "positive control: a closed Code reopens with E1's view");
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
    same(controller.begin('code', {}), null, `${provider}: a click writes nothing`);
    controller.commit('code', { historyMode: 'replace' });
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

// ── order: only the latest intent decides (docs/APP-ROUTES.md §5 "Order") ──
// Every case below is driven by explicit calls and the popstate event alone.
const settledLaunch = (controller, id, el) => { controller.begin(id).end(el); controller.settled(el); };
for (const fail of [false, true]) {
    // The coordinator's repro (2026-10-30): a click on Code, then on
    // Settings; Settings opens first, Code's launch resolves after it.
    const { w, controller, open, url } = harness('/os');
    const older = controller.begin('code');
    const code = open('code', 10);
    const newer = controller.begin('settings');
    newer.end(open('settings', 20));
    same([url(), w.history.length, w.history.state.ezilApp], ['/app/settings', 3, 'settings']);
    older.end(fail ? null : code);
    same([url(), w.history.length, w.history.state], ['/app/settings', 3, { __NA: true, ezilApp: 'settings' }],
        fail ? 'an older launch that failed does not roll back over the newer one' : 'an older launch that opened does not name itself over the newer one');
}
for (const fail of [false, true]) {
    // Positive control: the same end() with no newer intent still decides.
    const { w, controller, open, url } = harness('/os');
    settledLaunch(controller, 'settings', open('settings', 20));
    const launch = controller.begin('code');
    same([url(), w.history.length], ['/app/code', 3], 'positive control: a single click pushes exactly one entry');
    launch.end(fail ? null : open('code', 10));
    same([url(), w.history.length, w.history.state.ezilApp], fail ? ['/app/settings', 3, 'settings'] : ['/app/code', 3, 'code'],
        fail ? 'positive control: the latest launch that failed rolls back' : 'positive control: the latest launch keeps its entry');
}
{
    // Three clicks before anything opens, ending in every order, each one
    // opening or failing: 6 x 8 cases. The newest click (Settings) owns the
    // address bar from its begin(); if it fails it gives back the URL it
    // replaced, Code's, whatever became of Code.
    const ids = ['desktop', 'code', 'settings'];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let cases = 0;
    for (const order of orders) for (let failing = 0; failing < 8; failing += 1) {
        const { w, controller, open, url } = harness('/os');
        const launches = ids.map(id => controller.begin(id));
        const opened = ids.map((id, i) => ((failing >> i) & 1 ? null : open(id, 10 + i)));
        const final = opened[2] ? ['/app/settings', 4, 'settings'] : ['/app/code', 4, 'code'];
        const label = order.map(i => `${ids[i]} ${opened[i] ? 'opens' : 'fails'}`).join(', then ');
        for (const i of order) {
            launches[i].end(opened[i]);
            same([url(), w.history.length, w.history.state.ezilApp], order.indexOf(2) <= order.indexOf(i) ? final : ['/app/settings', 4, 'settings'],
                `${label}: after ${ids[i]} ends`);
        }
        cases += 1;
    }
    same(cases, 48, 'every order x every outcome');
}
{
    // The late focus: UIWindow focuses a restored window 80ms after
    // `showWindow`, and registry's `ensureOnTop` re-focuses a launched one at
    // 120ms. Landing after a newer click, neither is the user's.
    const { w, controller, open, focus, url } = harness('/os');
    const code = open('code', 10);
    controller.begin('code').end(code);
    const newer = controller.begin('settings');
    focus(code);
    same(url(), '/app/settings', 'during the newer launch: nothing');
    const settings = open('settings', 20);
    newer.end(settings);
    same([controller.superseded(code), controller.superseded(settings), controller.superseded(open('desktop', 1))], [true, false, false],
        "what registry's ensureOnTop asks: only the older launch's window stands down (a window never launched here does not)");
    focus(code);
    same([url(), w.history.length], ['/app/settings', 3], "after it: the older launch's late focus does not take the address bar");
    focus(settings);
    same(url(), '/app/settings', "the newer launch's own late focus is accepted");
    controller.settled(code);
    same(controller.superseded(code), false, 'settled: no longer');
    focus(code);
    same([url(), w.history.length], ['/app/code', 3], 'positive control: once its launch has settled, a focus of it replaces');
}
{
    // Positive control: a window still settling, with no newer launch, is
    // named by its late focus (a focus elsewhere in between is not a launch).
    const { w, controller, open, focus, url } = harness('/os');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    const code = open('code', 10);
    controller.begin('code').end(code);
    focus(settings);
    same(url(), '/app/settings', 'positive control: focus replaces');
    focus(code);
    same([url(), w.history.length], ['/app/code', 3], 'the latest launch\'s late focus still names it');
}
for (const order of ['older first', 'newer first']) for (const olderOpened of [true, false]) {
    // Close, then reopen, while the first launch is still pending.
    const { w, controller, open, close, url } = harness('/os');
    settledLaunch(controller, 'settings', open('settings', 5));
    const older = controller.begin('code', { project: { projectId: P, repoId: R } });
    const first = open('code', 10);
    close(first);
    same([url(), w.history.length], ['/app/settings', 3], 'positive control: a close moves the entry to the front app');
    const newer = controller.begin('code');
    const second = open('code', 20);
    const ends = [() => older.end(olderOpened ? first : null), () => newer.end(second)];
    for (const end of order === 'older first' ? ends : ends.reverse()) end();
    same([url(), w.history.length], ['/app/code', 4], `${order}, the first ${olderOpened ? 'resolving with its closed window' : 'failing'}: the reopen decides`);
}
for (const opened of [true, false]) {
    // Closing ANOTHER window while a click's launch is pending.
    const { w, controller, open, focus, close, url } = harness('/os');
    const desktop = open('desktop', 5);
    settledLaunch(controller, 'desktop', desktop);
    const settings = open('settings', 6);
    settledLaunch(controller, 'settings', settings);
    focus(settings);
    const launch = controller.begin('code');
    close(settings);
    same([url(), w.history.length], ['/app/desktop', 4], 'the close names the front app');
    launch.end(opened ? open('code', 30) : null);
    same([url(), w.history.length], [opened ? '/app/code' : '/app/desktop', 4], opened
        ? 'a close is not a launch: the window that opened still names itself'
        : "a failed launch does not give back, over the close, a closed app's URL");
}
for (const [delta, landing] of [[-2, '/os'], [-1, '/app/settings']]) for (const opened of [true, false]) {
    // Back while a click's launch is pending.
    const { w, controller, open, url, traverse } = harness('/os');
    settledLaunch(controller, 'settings', open('settings', 5));
    const launch = controller.begin('code');
    await traverse(delta);
    same([url(), w.history.length], [landing, 3], `Back ${-delta}`);
    launch.end(opened ? open('code', 10) : null);
    same([url(), w.history.length], [landing, 3], `Back ${-delta}, then the launch ${opened ? 'opens: it does not name itself' : 'fails: it does not roll back'}`);
}
{
    // Forward while a launch that did not push (Settings, at another tab) is
    // pending: the forward entry is not relabelled.
    const { w, controller, open, url, traverse } = harness('/os');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    settledLaunch(controller, 'code', open('code', 6));
    await traverse(-1);
    same(url(), '/app/settings');
    const launch = controller.begin('settings', { initialTab: 'usage' });
    same([url(), w.history.length], ['/app/settings?tab=usage', 3], 'no push: Settings is already named');
    await traverse(1);
    launch.end(settings);
    same([url(), w.history.length], ['/app/code', 3], 'Forward: the launch does not write over it');
}
{
    // A Back/Forward launch that resolves after a newer intent: a click...
    const routes = [];
    const { w, controller, open, url, traverse } = harness('/os', { routes });
    w.history.pushState({ __NA: true }, '', '/app/code');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    await traverse(-1);
    same([url(), routes.map(route => route.id)], ['/app/code', ['code']], 'Back to a closed Code launches it');
    controller.begin('settings').end(settings);
    same([url(), w.history.length], ['/app/settings', 3], 'a click while it opens');
    routes.shift().resolve(open('code', 10));
    same([url(), w.history.length], ['/app/settings', 3], 'the Back launch, resolving after the click, does not write over it');
}
{
    // ... or a focus.
    const routes = [];
    const { w, controller, open, focus, url, traverse } = harness('/os', { routes });
    w.history.pushState({ __NA: true }, '', '/app/code');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    await traverse(-1);
    focus(settings);
    same(url(), '/app/settings', 'a focus while the Back launch opens');
    routes.shift().resolve(open('code', 10));
    same(url(), '/app/settings', '... is not overwritten by it either');
}
{
    // Positive control: with no newer intent the Back launch commits
    // (stamping the entry's app), and its window settles like a click's.
    const routes = [];
    const { w, controller, open, focus, url, traverse } = harness('/os', { routes });
    w.history.pushState({ __NA: true }, '', '/app/code');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    await traverse(-1);
    const code = open('code', 10);
    routes.shift().resolve(code);
    same([url(), w.history.state], ['/app/code', { __NA: true, ezilApp: 'code' }], 'positive control: the Back launch commits');
    controller.begin('settings').end(settings);
    focus(code);
    same(url(), '/app/settings', "the Back launch's late focus, after a newer click, does not take the address bar");
}
{
    // Parameters: an older failed launch leaves a newer launch's alone...
    const { controller, open, focus, url } = harness('/os');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    const first = controller.begin('code', { project: { projectId: P, repoId: R } });
    const second = controller.begin('code', { project: { projectId: R, repoId: P } });
    const code = open('code', 10);
    first.end(null);
    second.end(code); controller.settled(code);
    focus(settings); focus(code);
    same(url(), `/app/code?project=${R}&repo=${P}`, "an older failed launch leaves the newer launch's parameters");
}
{
    // ... including ones a newer launch kept without restating them (a
    // plain click on Code while its project launch is in flight).
    const { controller, open, focus, url } = harness('/os');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    const first = controller.begin('code', { project: { projectId: P, repoId: R } });
    const second = controller.begin('code');
    const code = open('code', 10);
    first.end(null);
    second.end(code); controller.settled(code);
    focus(settings); focus(code);
    same(url(), `/app/code?project=${P}&repo=${R}`, 'an older failed launch leaves the parameters a newer launch kept');
}
{
    // ... and still takes back its own when nothing newer set them.
    const { controller, open, url } = harness('/os');
    const older = controller.begin('code', { project: { projectId: P, repoId: R } });
    controller.begin('settings').end(open('settings', 5));
    older.end(null);
    controller.begin('code');
    same(url(), '/app/code', "a failed launch's parameters do not ride on the next plain click");
}
console.log(`PASS ${checks} checks: app-history helpers, push-before-open, rollback, replace, focus, close, view recording, Back/Forward, adopt, /os-only hosts, idempotent install, order (latest intent decides: 48 launch orders x outcomes, late focus, close/reopen, Back/Forward and route launches while pending, parameters)`);
