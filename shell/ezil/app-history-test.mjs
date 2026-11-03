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
const { appUrl, encodeQueryValue, linkParams, mergeHistoryState, canonicalUrl, withoutKeys, routeLaunchContext, createAppHistory, OS_PATH } = await import(dataUrl(history));
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
// One-shot keys leave the address bar before their launch (`consume`).
same(withoutKeys(loc('?settings=billing&upgrade=standard&section=ai-credits&x=%41', '#h'), ['upgrade']), '/os?settings=billing&section=ai-credits&x=%41#h',
    'the key goes, every other pair byte for byte');
same(withoutKeys(loc('?%75pgrade=pro&upgrade=x&keep=1'), ['upgrade']), '/os?keep=1', 'keys compare decoded, and every copy goes');
same(withoutKeys(loc('?upgrade=pro'), ['upgrade']), '/os', 'nothing left: no `?`');
same(withoutKeys({ pathname: '/app/settings', search: '?tab=billing&upgrade=pro' }, ['upgrade']), '/app/settings?tab=billing', 'the path form too');
same(withoutKeys(loc('?upgrades=1&keep=1'), ['upgrade']), '/os?upgrades=1&keep=1', 'positive control: any other key stays');
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
    // E1 recorded one view; the user later chose the other on E2 (relabelled
    // Code by a focus). Back to E1 must not resize an open Code back, so E1
    // takes the view Code shows NOW, at the popstate itself (no launch
    // commits here): a reload of E1 reopens what is on screen. A closed Code
    // reopens with E1's own view (and with 'window', that is not the route's
    // default 'full').
    const { w, controller, launches, open, focus, url, traverse } = harness('/os');
    const code = open('code', 1);
    // Code's `_ezil_view`: what the window shows, which its events report.
    let shows = 'window';
    code._ezil_view = () => shows;
    const view = next => { shows = next; w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: next } })); };
    controller.begin('code').end(code);
    controller.settled(code);
    view(recorded);
    controller.begin('settings').end(open('settings', 2));
    focus(code);
    same([url(), w.history.state.ezilView], ['/app/code', recorded], `a focus names Code on E2 with the view it shows, ${recorded}`);
    view(later);
    same([url(), w.history.length, w.history.state.ezilView], ['/app/code', 3, later], `E2 names Code, ${later}`);
    if ( ! codeOpen ) code.remove();
    await traverse(-1);
    same([url(), w.history.state.ezilView], ['/app/code', codeOpen ? later : recorded], codeOpen
        ? `Back lands on E1, which takes the view the open Code shows, ${later}` : `positive control: with Code closed, E1 keeps ${recorded}`);
    same(launches, [['code', { computer: { id: C }, ...(codeOpen ? {} : { view: recorded }), historyMode: 'replace' }]],
        codeOpen ? 'Back to an open Code passes no view' : "positive control: a closed Code reopens with E1's view");
    ok(w.history.state.__NA === true, "Next's key survives the refresh");
}
for (const reports of [undefined, 'throws', 'huge', 'window']) {
    // An open window that reports no view (every app but Code; a value that
    // is not a view; an accessor that throws): Back to it REMOVES the view its
    // entry recorded, rather than keep a stale one, and never throws.
    // Positive control: one that reports a view gets it.
    const { w, controller, open, url, traverse } = harness('/app/settings', { state: { __NA: true, ezilApp: 'settings', ezilView: 'full', other: 1 } });
    const settings = open('settings', 1);
    if ( reports === 'throws' ) settings._ezil_view = () => { throw new Error('no view'); };
    else if ( reports ) settings._ezil_view = () => reports;
    controller.begin('code').end(open('code', 2));
    same([url(), w.history.length], ['/app/code', 2]);
    await traverse(-1);
    same([url(), w.history.state], ['/app/settings', { __NA: true, ezilApp: 'settings', other: 1, ...(reports === 'window' ? { ezilView: 'window' } : {}) }],
        reports === 'window' ? 'positive control: a window that reports a view records it' : `an open window that reports ${String(reports)} leaves its entry with no view`);
}
{
    // Every other write of an entry for an app whose window is open records
    // the view that window shows then, even when no event said so (`shows`
    // changes silently here): a focus, a close naming the front app, a click
    // on the open app (its push), a route's commit, sync, and a failed
    // click's give-back. Each write is checked against a view it did not
    // already have.
    const { w, controller, open, focus, close, url } = harness('/os');
    const code = open('code', 1);
    let shows = 'window';
    code._ezil_view = () => shows;
    controller.begin('code').end(code); controller.settled(code);
    same([url(), w.history.state.ezilView], ['/app/code', 'window'], 'a click on a Code already open: its push records the view it shows');
    const settings = open('settings', 2);
    controller.begin('settings').end(settings); controller.settled(settings);
    shows = 'full';
    focus(code);
    same([url(), w.history.state.ezilView], ['/app/code', 'full'], 'a focus');
    focus(settings);
    same([url(), w.history.state.ezilView], ['/app/settings', undefined], "positive control: Code's view leaves with Code");
    shows = 'window';
    close(settings);
    same([url(), w.history.state.ezilView], ['/app/code', 'window'], 'a close that names the front app');
    const again = open('settings', 3);
    controller.begin('settings').end(again); controller.settled(again);
    shows = 'full';
    const length = w.history.length;
    controller.begin('code').end(code);
    same([url(), w.history.length, w.history.state.ezilView], ['/app/code', length + 1, 'full'], 'a click on the open Code pushes the view it shows');
    shows = 'window';
    controller.commit('code', { historyMode: 'replace' }, code);
    same(w.history.state.ezilView, 'window', "a route's commit");
    shows = 'full';
    focus(code);
    w.history.replaceState(w.history.state, '', '/app/settings');
    controller.sync();
    same([url(), w.history.state.ezilView], ['/app/code', 'full'], 'sync, naming the front app');
    const failing = controller.begin('settings');
    same([url(), w.history.state.ezilView], ['/app/settings', undefined]);
    shows = 'window';
    failing.end(null);
    same([url(), w.history.state.ezilView, w.history.state.__NA], ['/app/code', 'window', true], "a failed click gives Code's entry back with the view Code shows now");
}
{
    // Positive control: an app with no window keeps the view its entry
    // recorded (the boot's adopt, before its launch: a reload).
    const { w, controller } = harness('/app/code', { state: { __NA: true, ezilApp: 'code', ezilView: 'window' } });
    controller.adopt({ id: 'code' });
    same([w.history.state, controller.recordedView('code')], [{ __NA: true, ezilApp: 'code', ezilView: 'window' }, 'window'], 'a reload keeps the recorded view');
}
{
    // Adopt: the boot's link is canonicalised in place, once, without pushing.
    const { w, controller, url } = harness(`/os?app=code&computer=${C}#top`, { state: { __NA: true, ezilApp: 'settings', ezilView: 'full' } });
    controller.adopt({ id: 'code' });
    same([url(), w.history.length, w.history.state], [`/app/code?computer=${C}#top`, 1, { __NA: true, ezilApp: 'code' }]);
    controller.adopt(null);
    same(url(), `/app/code?computer=${C}#top`);
}
{
    // Consume: the billing link's `upgrade` leaves the address bar in place,
    // before its launch. The state (Next's keys, the entry's app) is kept,
    // and a key that is not there writes nothing.
    const { w, controller, url } = harness('/os?settings=billing&upgrade=standard&section=ai-credits&x=1', { state: { __NA: true, ezilApp: 'settings' } });
    const writes = [];
    const replace = w.history.replaceState.bind(w.history);
    w.history.replaceState = (...args) => { writes.push(args[2]); replace(...args); };
    controller.consume(['upgrade']);
    same([url(), w.history.length, w.history.state, writes.length], ['/os?settings=billing&section=ai-credits&x=1', 1, { __NA: true, ezilApp: 'settings' }, 1],
        'upgrade goes, in place; section and unknown keys stay');
    controller.consume(['upgrade']);
    same(writes.length, 1, 'nothing left to drop: nothing written');
}
for (const provider of ['native-macos', 'local-vm']) {
    const { w, controller, open, focus, close, url, launches } = harness('/os?settings=billing&upgrade=pro&x=1', { provider });
    same(controller.enabled, false, provider);
    controller.consume(['upgrade']);
    same(url(), '/os?settings=billing&x=1', `${provider}: the one-shot key still goes before the launch, the path stays`);
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
    // address bar from its begin(). A click that fails gives it back to the
    // one before it, and that one, if it failed meanwhile, to the one before
    // it in turn: the address bar names the newest click that has not
    // failed (still pending, or opened), else `/os`.
    const ids = ['desktop', 'code', 'settings'];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    let cases = 0;
    for (const order of orders) for (let failing = 0; failing < 8; failing += 1) {
        const { w, controller, open, url } = harness('/os');
        const launches = ids.map(id => controller.begin(id));
        const opened = ids.map((id, i) => ((failing >> i) & 1 ? null : open(id, 10 + i)));
        const ended = ids.map(() => false);
        const named = () => {
            const i = [2, 1, 0].find(j => ! ended[j] || opened[j]);
            return i === undefined ? ['/os', 4, undefined] : [`/app/${ids[i]}`, 4, ids[i]];
        };
        const label = order.map(i => `${ids[i]} ${opened[i] ? 'opens' : 'fails'}`).join(', then ');
        for (const i of order) {
            launches[i].end(opened[i]);
            ended[i] = true;
            same([url(), w.history.length, w.history.state.ezilApp], named(), `${label}: after ${ids[i]} ends`);
        }
        cases += 1;
    }
    same(cases, 48, 'every order x every outcome');
}
{
    // The same cascade, spelled out (review of 2026-10-30; the end values
    // are base ba36b095's): newest-first failures walk the address bar back
    // down to the launch that opened.
    const { w, controller, open, url } = harness('/os');
    const [desktop, code, settings] = ['desktop', 'code', 'settings'].map(id => controller.begin(id));
    settings.end(null);
    same(url(), '/app/code', 'Settings fails: Code, still pending, has the address bar back');
    code.end(null);
    same(url(), '/app/desktop', 'then Code fails: Desktop, still pending, has it');
    desktop.end(open('desktop', 10));
    same([url(), w.history.length, w.history.state.ezilApp], ['/app/desktop', 4, 'desktop'], 'then Desktop opens: it is named');
}
{
    // ... to `/os`, when every launch fails.
    const { w, controller, url } = harness('/os');
    const [desktop, code, settings] = ['desktop', 'code', 'settings'].map(id => controller.begin(id));
    settings.end(null); code.end(null); desktop.end(null);
    same([url(), w.history.length, w.history.state], ['/os', 4, { __NA: true }], 'all three fail, newest first: /os and its own state');
}
for (const newerFirst of [true, false]) {
    // Two clicks that both fail, in either order: the older one's failure,
    // overtaken when it happened, is given back once the newer one fails.
    const { w, controller, url } = harness('/os');
    const code = controller.begin('code');
    const settings = controller.begin('settings');
    for (const launch of newerFirst ? [settings, code] : [code, settings]) launch.end(null);
    same([url(), w.history.length, w.history.state], ['/os', 3, { __NA: true }], `Code and Settings both fail, ${newerFirst ? 'newer' : 'older'} first: /os`);
}
{
    // Two clicks on the same app (the second pushes nothing), both failing.
    const { w, controller, url } = harness('/os');
    const first = controller.begin('code');
    const second = controller.begin('code');
    same([url(), w.history.length], ['/app/code', 2]);
    second.end(null);
    same(url(), '/app/code', 'the second fails: the first, still pending, keeps the entry');
    first.end(null);
    same([url(), w.history.length], ['/os', 2], 'then the first fails: /os');
}
for (const closed of [true, false]) {
    // A close between the newer launch and its failure: the close decided,
    // and nothing gives back over it. Positive control: without the close,
    // the cascade runs.
    const { w, controller, open, close, url } = harness('/os');
    settledLaunch(controller, 'desktop', open('desktop', 5));
    const settingsWindow = open('settings', 6);
    settledLaunch(controller, 'settings', settingsWindow);
    const code = controller.begin('code');
    const settings = controller.begin('settings');
    if ( closed ) {
        close(settingsWindow);
        same(url(), '/app/desktop', 'the close names the front app');
    }
    settings.end(null);
    same(url(), closed ? '/app/desktop' : '/app/code', closed ? 'Settings fails after the close: nothing given back' : 'positive control: Settings fails, Code has it back');
    code.end(null);
    same([url(), w.history.length], [closed ? '/app/desktop' : '/app/settings', 5], closed ? 'then Code fails: still the close\'s' : 'positive control: then Code fails, the URL it replaced');
}
for (const olderFirst of [true, false]) for (const closed of [true, false]) {
    // A close BETWEEN two clicks: the newer one fails and gives back to the
    // close's URL, and the older one's give-back, reached through it, finds
    // the entry taken by the close and stays put, in either end order.
    // Positive control: without the close, the cascade walks back to `/os`.
    const { w, controller, open, close, url } = harness('/os');
    const settings = open('settings', 5);
    const desktop = open('desktop', 4);
    const code = controller.begin('code');
    if ( closed ) {
        close(settings);
        same(url(), '/app/desktop', 'the close names the front app');
    }
    const newer = controller.begin('settings');
    for (const launch of olderFirst ? [code, newer] : [newer, code]) launch.end(null);
    same([url(), w.history.length], closed ? ['/app/desktop', 3] : ['/os', 3], closed
        ? `${olderFirst ? 'older' : 'newer'} fails first: nothing is given back over the close`
        : `positive control (${olderFirst ? 'older' : 'newer'} first): both give back, to /os`);
    void desktop;
}
{
    // A newer launch that fails gives the front back too: the older launch's
    // window, still settling, is no longer superseded (its ensureOnTop runs,
    // registry.js), and its late focus counts again.
    const { controller, open, focus, url } = harness('/os');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    const older = controller.begin('code');
    const newer = controller.begin('desktop');
    const code = open('code', 10);
    older.end(code);
    same([url(), controller.superseded(code)], ['/app/desktop', true], 'while the newer launch is pending, the older window stands down');
    newer.end(null);
    same([url(), controller.superseded(code)], ['/app/code', false], 'the newer launch fails: Code has the address bar back, and the front');
    focus(settings);
    same(url(), '/app/settings', 'positive control: focus replaces');
    focus(code);
    same(url(), '/app/code', "Code's late focus, still before it settles, names it");
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
for (const order of ['older first', 'newer first']) {
    // Two clicks on Code that resolve with the same (single-instance)
    // window, in either order: it is the newer launch's.
    const { w, controller, open, focus, url } = harness('/os');
    const settings = open('settings', 5);
    settledLaunch(controller, 'settings', settings);
    const older = controller.begin('code');
    const newer = controller.begin('code');
    const code = open('code', 10);
    for (const launch of order === 'older first' ? [older, newer] : [newer, older]) launch.end(code);
    same(controller.superseded(code), false, `${order}: not superseded`);
    focus(settings); focus(code);
    same([url(), w.history.length], ['/app/code', 3], `${order}: its late focus still names it`);
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
    // A route the boot starts itself (`route`: its own link, the billing
    // link) is numbered as a Back/Forward is. Review N5: the boot's link
    // resolves after a click made while it opened.
    const { w, controller, open, url } = harness('/os?app=code');
    controller.adopt({ id: 'code' });
    const boot = controller.route({ computer: { id: C }, view: 'full', historyMode: 'replace' });
    same([url(), w.history.length], ['/app/code', 1]);
    controller.begin('settings').end(open('settings', 20));
    same([url(), w.history.length], ['/app/settings', 2], 'a click while the boot link opens');
    const code = open('code', 10);
    controller.commit('code', boot, code);
    same([url(), w.history.length, w.history.state.ezilApp], ['/app/settings', 2, 'settings'], "the boot link, resolving after the click, does not relabel the click's entry");
    same(controller.superseded(code), true, '... and its window stands down');
}
{
    // Positive control: with no newer intent the boot link names its app,
    // and its window is the latest launch's.
    const { w, controller, open, url } = harness('/os?app=code');
    controller.adopt({ id: 'code' });
    const code = open('code', 10);
    controller.commit('code', controller.route({ historyMode: 'replace' }), code);
    same([url(), w.history.length, w.history.state.ezilApp, controller.superseded(code)], ['/app/code', 1, 'code', false], 'positive control: the boot link commits');
}
for (const click of [null, 'opens', 'fails']) {
    // The billing link (review N11): Settings opens, then `adopt` drops the
    // one-shot keys. A click made meanwhile keeps its entry; one that
    // failed gave it back (positive controls: no click, a failed click).
    const { w, controller, open, url } = harness('/os?settings=billing&section=ai-credits&x=1');
    const route = controller.route({ initialTab: 'billing', historyMode: 'replace' });
    if ( click ) controller.begin('code').end(click === 'opens' ? open('code', 20) : null);
    controller.commit('settings', route, open('settings', 10));
    controller.adopt({ id: 'settings', initialTab: 'billing' }, { search: '?x=1', route });
    same([url(), w.history.length, w.history.state.ezilApp],
        click === 'opens' ? ['/app/code', 2, 'code'] : ['/app/settings?tab=billing&x=1', click ? 2 : 1, 'settings'],
        click === 'opens' ? "a click while the billing link opens keeps its entry: neither commit nor adopt relabels it"
            : `positive control (${click ? 'a click that failed' : 'no click'}): the billing link is canonicalised`);
}
for (const [tab, order] of [[undefined, 'commit first'], [undefined, 'click first'], ['billing', 'commit first'], ['usage', 'commit first']]) {
    // The recheck of 118ebea9 (2026-10-30): a click on Settings ITSELF while
    // the billing link opens it. The alias already names Settings and no tab
    // of its own is recorded yet, so a plain click writes nothing and takes
    // nothing: the link's commit and adopt still canonicalise the boot's
    // entry (base ba36b095 did; 118ebea9 left `upgrade`/`section` on it). A
    // click at a tab rewrites the entry in place: that click took it, and
    // keeps it (positive controls). The two launches share one window.
    const { w, controller, open, url } = harness('/os?settings=billing&section=ai-credits&x=1');
    const route = controller.route({ initialTab: 'billing', historyMode: 'replace' });
    const click = controller.begin('settings', tab ? { initialTab: tab } : {});
    same([url(), w.history.length], [tab ? `/app/settings?tab=${tab}` : '/os?settings=billing&section=ai-credits&x=1', 1],
        tab ? `a click at ${tab}: rewritten in place` : 'a plain click on Settings: nothing written');
    const settings = open('settings', 10);
    if ( order === 'click first' ) click.end(settings);
    controller.commit('settings', route, settings);
    if ( order === 'commit first' ) click.end(settings);
    controller.adopt({ id: 'settings', initialTab: 'billing' }, { search: '?x=1', route });
    same([url(), w.history.length, w.history.state.ezilApp, controller.superseded(settings)],
        [tab ? `/app/settings?tab=${tab}` : '/app/settings?tab=billing&x=1', 1, 'settings', false],
        tab ? `a click at ${tab} took the entry: the billing link writes nothing over it`
            : `a plain click on Settings (${order}): the billing link still canonicalises its entry`);
}
for (const renames of [false, true]) {
    // A close takes the entry only if it renames it. Behind the front window
    // it renames nothing, and a Back launch still opening still commits (its
    // write, counted); a close of the front window renames it, and the Back
    // launch writes nothing (positive control).
    const routes = [];
    const { w, open, focus, close, url, traverse } = harness('/os', { routes });
    const desktop = open('desktop', 5);
    const settings = open('settings', 6);
    focus(settings);
    w.history.pushState({ __NA: true }, '', '/app/settings?tab=usage');
    w.history.pushState({ __NA: true }, '', '/app/code');
    await traverse(-1);
    // Settings is open, so the entry names it (and its view) at once.
    same([url(), w.history.state.ezilApp, routes.map(r => r.id)], ['/app/settings?tab=usage', 'settings', ['settings']], 'Back to Settings at Usage, still opening');
    close(renames ? settings : desktop);
    same(url(), renames ? '/app/desktop' : '/app/settings?tab=usage', renames ? 'the close of the front window renames the entry' : 'a close behind it renames nothing');
    const writes = [];
    const replace = w.history.replaceState.bind(w.history);
    w.history.replaceState = (...args) => { writes.push(args[2]); replace(...args); };
    routes.shift().resolve(renames ? open('settings', 20) : settings);
    same([url(), w.history.state.ezilApp, writes], renames ? ['/app/desktop', 'desktop', []] : ['/app/settings?tab=usage', 'settings', ['/app/settings?tab=usage']],
        renames ? 'it took the entry: the Back launch writes nothing over it' : 'it took nothing: the Back launch commits');
}
{
    // The independent review's interleavings (2026-10-30), wired as boot.js
    // calls `route` (N5 and N11 are the boot-link and billing-link cases
    // above). N5 and N8's lengths were 3 and 4 in the review's harness: a
    // route launch never pushes and a click on the named app at a new
    // project replaces in place, so 2 and 3 are right.
    const ids = ['desktop', 'code', 'settings'];
    const apps = (w) => [...w.document.querySelectorAll('.window[data-app]')].map(el => el.getAttribute('data-app'));
    {
        const { w, controller, open, url } = harness('/os');
        const [a, b, c] = ids.map(id => controller.begin(id));
        c.end(null); b.end(null); a.end(open('desktop', 10));
        same([url(), apps(w)], ['/app/desktop', ['desktop']], 'N1: Settings fails, Code fails, Desktop opens: Desktop is named');
    }
    {
        const { w, controller, url } = harness('/os');
        const [a, b, c] = ids.map(id => controller.begin(id));
        c.end(null); b.end(null); a.end(null);
        same([url(), apps(w)], ['/os', []], 'N1b: all three fail, newest first: /os');
    }
    {
        const { w, controller, url } = harness('/os');
        const a = controller.begin('code'); const b = controller.begin('settings');
        b.end(null); a.end(null);
        same([url(), apps(w)], ['/os', []], 'N2: Settings fails, then Code fails: /os');
    }
    {
        const { controller, open, focus, url, traverse } = harness('/os');
        const code = open('code', 10);
        controller.begin('code').end(code);
        await traverse(-1);
        const afterBack = url();
        focus(code);
        const afterLateFocus = url();
        controller.settled(code);
        focus(code);
        same([afterBack, afterLateFocus, url()], ['/os', '/os', '/app/code'], "N3: Back while Code settles; Code's late focus does not name it, the user's later focus does");
    }
    {
        const { w, controller, open, close, url } = harness('/os');
        const older = controller.begin('code'); const newer = controller.begin('settings');
        const s = open('settings', 20); newer.end(s);
        close(s);
        const afterClose = url();
        older.end(open('code', 10));
        same([afterClose, url(), apps(w)], ['/os', '/os', ['code']], "N4: the newer window closes, then the older launch opens: it was superseded and names nothing (its next focus that counts does)");
    }
    {
        const { w, controller, open, url, traverse } = harness('/os');
        w.history.pushState({ __NA: true }, '', '/app/code');
        controller.adopt({ id: 'code' });
        const boot = controller.route({ computer: { id: C }, view: 'full', historyMode: 'replace' });
        await traverse(-1);
        const afterBack = url();
        controller.commit('code', boot, open('code', 10));
        same([afterBack, url()], ['/os', '/os'], 'N6: the boot link resolves after Back: it writes nothing over the entry Back moved to');
    }
    {
        const { controller, open, focus, url } = harness('/os?app=code');
        controller.adopt({ id: 'code' });
        const boot = controller.route({ computer: { id: C }, view: 'full', historyMode: 'replace' });
        const code = open('code', 10);
        controller.commit('code', boot, code);
        const committed = url();
        const settings = open('settings', 20);
        controller.begin('settings').end(settings); controller.settled(settings);
        focus(code);
        same([committed, url()], ['/app/code', '/app/settings'], "N7: the boot link commits, a click lands, then the boot window's late focus: the click keeps the address bar");
    }
    {
        const routes = [];
        const { w, controller, open, url, traverse } = harness('/os', { routes });
        w.history.pushState({ __NA: true }, '', '/app/code');
        settledLaunch(controller, 'settings', open('settings', 5));
        await traverse(-1);
        const click = controller.begin('code', { project: { projectId: P, repoId: R } });
        const code = open('code', 10);
        click.end(code);
        const mid = url();
        routes.shift().resolve(code);
        same([mid, url(), w.history.length], [`/app/code?project=${P}&repo=${R}`, `/app/code?project=${P}&repo=${R}`, 3],
            'N8: Back to Code, a click on Code at a project (in place), then the Back launch resolves: it writes nothing over the click');
    }
    {
        const { controller, open, url } = harness('/os');
        const [a, b, c] = ids.map(id => controller.begin(id));
        b.end(null); c.end(open('settings', 30)); a.end(open('desktop', 10));
        same(url(), '/app/settings', 'N9: the middle one fails, the newest opens, then the oldest: the newest keeps it');
    }
    {
        const { w, controller, open, url } = harness('/os');
        const a = controller.begin('code'); const b = controller.begin('settings');
        const code = open('code', 10);
        b.end(null);
        a.end(code);
        same([url(), apps(w)], ['/app/code', ['code']], 'N10: the newer fails, then the older opens: the older is named');
    }
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
console.log(`PASS ${checks} checks: app-history helpers (consume included), push-before-open, rollback, replace, focus, close, view recording, the entry follows the screen (an open window's view on Back/Forward, focus, close, push, commit, sync and give-back; none reported, none kept), Back/Forward, adopt, /os-only hosts, idempotent install, order (the entry's owner decides: 48 launch orders x outcomes, late focus, close/reopen, Back/Forward and route launches while pending, a click on Settings itself while the billing link opens, a close that renames nothing, review interleavings N1-N11, parameters)`);
