// app-link-test.mjs — the app link parser (unit), then the built bundle in
// jsdom: canonical `/app/<id>` routes, the launch context a route gives an
// app, single-instance relaunch, and the history contract (docs/APP-ROUTES.md).
// Run: cd shell && node ezil/app-link-test.mjs   (after build-shell.sh;
// EZIL_SHELL_OUT_DIR points it at a bundle built elsewhere)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const source = readFileSync(new URL('./app-link.js', import.meta.url), 'utf8');
const { parseAppLink, settingsAliasSearch, pathProblem } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks += 1; };
// Values read out of jsdom come from another realm; compare them as data.
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const same = (actual, expected, message) => { assert.deepEqual(plain(actual), plain(expected), message); checks += 1; };

// ── parseAppLink ────────────────────────────────────────────────────────────
const apps = ['desktop', 'code', 'settings'].map(id => ({ id }));
for (const search of ['?app=__proto__', '?app=javascript:alert(1)', '?app=%22%5D', '?app=code&app=browser', '?app=preview', '?app=unknown&settings=billing', '?app=code&app=browser&settings=billing', '?settings=account&settings=billing', '?app=https://evil.example']) same(parseAppLink(search, apps), null, search);
same(parseAppLink('?app=browser&path=%2Fdemo', apps), { id: 'desktop' });
same(parseAppLink('?settings=account', apps), { id: 'settings', initialTab: 'account' });
// The path form, and the alias it canonicalises from, give the same result.
same(parseAppLink('/app/code', apps), { id: 'code' });
same(parseAppLink('/app/browser', apps), { id: 'desktop' }, 'browser stays an alias of desktop');
same(parseAppLink('/app/desktop', apps), { id: 'desktop' });
same(parseAppLink('/app/settings?tab=billing', apps), { id: 'settings', initialTab: 'billing' });
same(parseAppLink('/os?settings=billing&upgrade=pro', apps), parseAppLink('/app/settings?tab=billing&upgrade=pro', apps));
same(parseAppLink('/app/settings?settings=system', apps), { id: 'settings', initialTab: 'system' });
same(parseAppLink('/app/settings?tab=bogus', apps), { id: 'settings' }, 'unknown tab opens Settings at its default');
same(parseAppLink({ pathname: '/app/code', search: '' }, apps), { id: 'code' }, 'a Location-shaped object');
same(parseAppLink('/os?app=code#x', apps), { id: 'code' });
for (const link of ['/app/unknown', '/app/', '/app', '/app/Code', '/app/%63ode', '/app/code/x', '/app/code?app=code', '/app/code?app=browser',
    '/app/preview', '/app/settings?tab=account&settings=billing', '/app/settings?tab=a&tab=b', '/app/code/../settings']) {
    same(parseAppLink(link, apps), null, link);
}
// Code's project parameters (contract item 2).
const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const R = '12345678-9abc-4def-8123-456789abcdef';
const pr = `project=${P}&repo=${R}`;
same(parseAppLink(`/app/code?${pr}&path=src/main.ts`, apps), { id: 'code', project: { projectId: P, repoId: R, path: 'src/main.ts' } });
same(parseAppLink(`/os?app=code&${pr}&path=a.b/c-d_e`, apps), { id: 'code', project: { projectId: P, repoId: R, path: 'a.b/c-d_e' } }, 'the alias parses projects too');
same(parseAppLink(`/app/code?${pr}`, apps), { id: 'code', project: { projectId: P, repoId: R } });
same(parseAppLink(`/app/code?${pr}&url=https://evil.example&ref=main&folder=x&user=u&account=a&token=t`, apps),
    { id: 'code', project: { projectId: P, repoId: R } }, 'nothing but project/repo/path is read');
same(parseAppLink(`/app/code?project=${P.toUpperCase()}&repo=${R}`, apps), { id: 'code', projectRejected: 'project_invalid' });
same(parseAppLink(`/app/code?project=${P}&repo=${R.toUpperCase()}`, apps), { id: 'code', projectRejected: 'repo_invalid' });
same(parseAppLink(`/app/code?project=${P}`, apps), { id: 'code', projectRejected: 'repo_missing' });
same(parseAppLink(`/app/code?repo=${R}`, apps), { id: 'code', projectRejected: 'project_missing' });
same(parseAppLink('/app/code?path=src', apps), { id: 'code', projectRejected: 'project_missing' });
same(parseAppLink(`/app/code?project={${P}}&repo=${R}`, apps), { id: 'code', projectRejected: 'project_invalid' });
for (const dup of [`/app/code?${pr}&project=${P}`, `/app/code?${pr}&repo=${R}`, `/app/code?${pr}&path=a&path=b`, `/os?app=code&${pr}&path=a&path=a`]) {
    same(parseAppLink(dup, apps), null, `duplicate key rejects the whole link: ${dup}`);
}
// An invalid path is dropped (the project is not) and the reason is kept.
for (const [raw, reason] of [['', 'empty'], ['a%2Fb', 'encoded_separator'], ['a%2fb', 'encoded_separator'], ['a%5Cb', 'encoded_separator'],
    ['%2Fabs', 'encoded_separator'], ['/abs', 'absolute'], ['a\\b', 'backslash'], ['a/../b', 'dot_segment'], ['./a', 'dot_segment'],
    ['..', 'dot_segment'], ['a//b', 'segment'], ['a/', 'segment'], ['a%20b', 'segment'], ['a+b', 'segment'], ['a%2500', 'segment'],
    ['%00', 'control'], ['a%0Ab', 'control'], ['%7F', 'control'], [`${'a'.repeat(256)}`, 'too_long'], ['%C3%A9', 'segment']]) {
    same(parseAppLink(`/app/code?${pr}&path=${raw}`, apps), { id: 'code', project: { projectId: P, repoId: R }, pathRejected: reason }, `path=${raw}`);
}
same(parseAppLink(`/app/code?${pr}&path=${'a'.repeat(255)}`, apps).project.path.length, 255, '255 bytes is the limit, not over it');
same(pathProblem('src/x.ts'), null);
same(settingsAliasSearch('/app/settings?tab=billing&upgrade=pro'), '?upgrade=pro&settings=billing');
same(settingsAliasSearch('/os?settings=billing'), '?settings=billing');
same(settingsAliasSearch('/app/code?tab=billing'), '?tab=billing');

// ── the bundle ──────────────────────────────────────────────────────────────
const OS = process.env.EZIL_SHELL_OUT_DIR || fileURLToPath(new URL('../../app/public/os/', import.meta.url));
const bundle = readFileSync(path.join(OS, 'bundle.min.js'), 'utf8');
const icons = readFileSync(path.join(OS, 'icons.js'), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const COMPUTER = '11111111-1111-4111-8111-111111111111';
// What Next.js's App Router keeps in `history.state` (`/os` is one of its
// pages). Its popstate handler reloads the page if an entry lacks `__NA`.
const NEXT_STATE = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', { children: ['os', {}] }], renderedSearch: '' } };
async function boot(entry, { provider = 'cloudflare-guacamole', state = NEXT_STATE, ready = () => wait(250), features } = {}) {
    const dom = new JSDOM('<!doctype html><div id="ezil-os-root"></div>', { url: `https://os.example${entry}`, runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.fetch = async () => ({ ok: true, json: async () => ({ result: { data: { json: [] } } }) });
    w.__EZIL_BOOT__ = { user: { id: 'user', email: 'test@example.com' }, computer: { id: COMPUTER, name: 'Test', slot: 1 }, apps: [{ id: 'desktop' }], desktopState: { configured: false, provider },
        ...(features ? { features } : {}) };
    if (state) w.history.replaceState(state, '', w.location.href);
    const pops = [];
    w.addEventListener('popstate', () => pops.push(w.history.state));
    w.eval(icons); w.eval(bundle);
    // Every ctx Code's `open` receives (patched before the boot's own launch).
    const opens = [];
    const code = w.ezil.registry.getApp('code');
    const open = code.open;
    code.open = launchCtx => { opens.push(launchCtx); return open(launchCtx); };
    await ready(w);
    const url = () => `${w.location.pathname}${w.location.search}`;
    const win = id => w.document.querySelector(`.window[data-app="${id}"]`);
    return { w, url, win, opens, pops, ctx: { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState } };
}
const done = w => w.dispatchEvent(new w.Event('ezil:teardown'));

for (const target of ['code', 'browser']) {
    const { w, ctx, url, win, opens } = await boot(`/os?app=${target}&project=demo&path=%2Fa%20b`);
    const id = target === 'browser' ? 'desktop' : target;
    same([...w.document.querySelectorAll('.window[data-app]')].map(el => el.dataset.app), [id], 'fresh target opens only requested app');
    same(url(), `/app/${id}?project=demo&path=%2Fa%20b`, 'the alias is canonicalised in place, other keys byte for byte');
    same(w.history.length, 1, 'canonicalising adds no history entry');
    if (id === 'code') same(opens.map(c => c.view), ['full'], 'Code opened from its route is full (contract item 3)');
    const original = win(id);
    const relaunches = [];
    original._ezil_relaunch = launchCtx => relaunches.push(launchCtx);
    const again = { ...ctx, view: 'window' };
    // Paced like clicks: `showWindow` focuses 80ms late (`ensureOnTop` at
    // 120ms), and a focus landing after the next launch is a focus change.
    const launch = async (app, launchCtx) => { const el = await w.ezil.registry.launch(app, launchCtx); await wait(150); return el; };
    await Promise.all([launch(id, again), launch(id, again)]);
    same(w.document.querySelectorAll('.window').length, 1);
    ok(relaunches.length === 2 && relaunches.every(c => c === again), 'existing window hears each relaunch, with the same ctx object');
    original._ezil_relaunch = () => { throw new Error('hook failed'); };
    ok(await launch(id, ctx) === original, 'a throwing relaunch hook still focuses the window');
    same(w.history.length, 1, 'relaunching the app the address bar already names adds no entry');
    await launch('settings', ctx);
    ok(w.document.querySelector('[data-pane="account"].active'));
    same(w.history.length, 2, 'a launch of another app pushes one entry');
    await launch('settings', { ...ctx, initialTab: 'system' });
    ok(w.document.querySelector('[data-pane="system"].active'), 'existing Settings honors explicit section');
    same(url(), '/app/settings?tab=system');
    await launch('settings', ctx);
    ok(w.document.querySelector('[data-pane="account"].active'), 'normal Settings opening returns to Account');
    same([url(), w.history.length], ['/app/settings', 2]);
    w.history.back(); await wait(200);
    same(w.document.querySelectorAll('.window').length, 2, 'history app request preserves other windows');
    ok(win(id) === original, 'same app focuses its original window');
    ok(original.classList.contains('window-active'), 'Back focused it');
    same(url(), `/app/${id}?project=demo&path=%2Fa%20b`, 'the entry kept its own URL');
    done(w);
}
{
    const invalid = await boot('/os?app=unknown&settings=billing');
    same(invalid.w.document.querySelectorAll('.window').length, 0, 'invalid app cannot fall through to billing launch');
    same(invalid.url(), '/os?app=unknown&settings=billing', 'an unusable link is left as it was');
    done(invalid.w);
    for (const entry of ['/os?app=code&app=browser', `/app/code?project=${P}&project=${P}&repo=${R}`]) {
        const dup = await boot(entry);
        same([dup.w.document.querySelectorAll('.window').length, dup.url()], [0, entry], `duplicate keys open nothing: ${entry}`);
        done(dup.w);
    }
    const fallback = await boot('/os?app=settings&settings=billing');
    ok(fallback.w.document.querySelector('[data-pane="account"].active'), 'unavailable Billing section falls back to Account');
    same(fallback.url(), '/app/settings?tab=billing');
    done(fallback.w);
    const ordinary = await boot('');
    same(ordinary.w.document.querySelectorAll('.window').length, 0, 'ordinary hosted login does not start compute');
    same(ordinary.url(), '/', 'a page with no link is not rewritten');
    await Promise.all([ordinary.w.ezil.registry.launch('settings', ordinary.ctx), ordinary.w.ezil.registry.launch('settings', ordinary.ctx)]);
    same(ordinary.w.document.querySelectorAll('.window').length, 1, 'concurrent initial opens coalesce');
    same(ordinary.w.history.length, 2, 'two coalesced gesture launches push one entry');
    done(ordinary.w);
}

// ── canonical routes and what they hand the app ─────────────────────────────
for (const [entry, canonical] of [
    [`/os?settings=billing&upgrade=pro&computer=${COMPUTER}`, `/app/settings?tab=billing&computer=${COMPUTER}`],
    [`/app/settings?tab=billing&upgrade=pro&computer=${COMPUTER}`, `/app/settings?tab=billing&computer=${COMPUTER}`],
    [`/os?settings=billing&section=ai-credits`, '/app/settings?tab=billing'],
    [`/os?app=settings&settings=system&computer=${COMPUTER}`, `/app/settings?tab=system&computer=${COMPUTER}`],
    [`/app/browser?computer=${COMPUTER}`, `/app/desktop?computer=${COMPUTER}`],
    [`/os?computer=${COMPUTER}&app=code&${pr}&path=a%2Fb`, `/app/code?computer=${COMPUTER}&${pr}&path=a%2Fb`],
]) {
    const { w, url } = await boot(entry);
    same([url(), w.history.length], [canonical, 1], `${entry} -> ${canonical}`);
    same([w.history.state.__NA, w.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE], [true, NEXT_STATE.__PRIVATE_NEXTJS_INTERNALS_TREE], 'Next keys survive canonicalising');
    done(w);
}
{
    const routed = await boot(`/app/code?${pr}&path=src/main.ts`);
    same(routed.opens.map(c => [c.view, c.project]), [['full', { projectId: P, repoId: R, path: 'src/main.ts' }]], 'route launch context carries view and project');
    // Apps spread their ctx into launches of their own (clicks): a route's
    // historyMode must not ride along and turn those into replaces.
    same(routed.opens.map(c => 'historyMode' in c), [false], 'the app never sees historyMode');
    // A click inside a window a ROUTE opened is still a click: the drawer's
    // Settings button must push, whatever routing keys that window's ctx has.
    routed.w.ezil.registry.settingsDrawerAction({ ...routed.ctx, historyMode: 'replace', view: 'full', initialTab: 'usage' }).onClick();
    await wait(200);
    same([routed.url(), routed.w.history.length], ['/app/settings', 2], "a drawer click pushes, without the route's keys");
    done(routed.w);
    const rejected = await boot(`/os?app=code&${pr}&path=a%2Fb`);
    same(rejected.opens.map(c => c.project), [{ projectId: P, repoId: R }], 'an invalid path is dropped, the project is not');
    done(rejected.w);
    const recorded = await boot('/app/code', { state: { ...NEXT_STATE, ezilApp: 'code', ezilView: 'window' } });
    same(recorded.opens.map(c => c.view), ['window'], 'a reload keeps the view this entry recorded');
    done(recorded.w);
    const otherApp = await boot('/app/code', { state: { ...NEXT_STATE, ezilApp: 'settings', ezilView: 'window' } });
    same(otherApp.opens.map(c => c.view), ['full'], "another app's recorded view is not Code's");
    // Its launch's commit records the view Code opened in (the open itself
    // is not announced): the entry follows the screen.
    same([otherApp.w.history.state.ezilView, otherApp.w.history.state.ezilApp], ['full', 'code']);
    done(otherApp.w);
    const nostate = await boot('/app/code', { state: null });
    same([nostate.opens.map(c => c.view), nostate.w.history.state.ezilApp], [['full'], 'code'], 'no prior state at all');
    done(nostate.w);
}

// ── history: push on a gesture only; focus/close replace; Back never closes ─
{
    const { w, url, win, pops, opens } = await boot(`/os?computer=${COMPUTER}`);
    const dock = id => w.$(`.taskbar-item[data-app="${id}"]`).trigger('click');
    same([url(), w.history.length], [`/os?computer=${COMPUTER}`, 1]);
    dock('settings'); await wait(150);
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 2], 'dock launch pushes, keeping the computer');
    ok(w.history.state.__NA === true && w.history.state.ezilApp === 'settings', 'pushed entry keeps Next keys');
    same(w.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE, NEXT_STATE.__PRIVATE_NEXTJS_INTERNALS_TREE);
    dock('code'); await wait(150);
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 3], 'a second app pushes a second entry');
    same(opens.at(-1).view, undefined, 'a dock launch passes no view (A2 decides)');
    dock('code'); await wait(150);
    same(w.history.length, 3, 'clicking the app the address bar already names adds nothing');
    w.$(win('settings')).focusWindow();
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3], 'focus replaces');
    w.$(win('code')).focusWindow();
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 3]);
    // The focus wrote the view the open Code shows: windowed (a dock launch).
    same(w.history.state.ezilView, 'window', 'a focus of the open Code records its view');
    const views = [];
    win('code')._ezil_relaunch = launchCtx => views.push(launchCtx.view);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'settings', view: 'full' } }));
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'huge' } }));
    same([w.history.state.ezilApp, w.history.state.ezilView], ['code', 'window'], 'a view for another app, or an unknown view, is not recorded');
    // The event alone, as Code would send it (the window itself stays as it is).
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'full' } }));
    same([w.history.state.ezilView, w.history.state.__NA, w.history.length], ['full', true, 3], 'the view is recorded on this entry');
    w.history.back(); await wait(200);
    same(url(), `/app/settings?computer=${COMPUTER}`);
    ok(win('settings').classList.contains('window-active'), 'Back focuses Settings');
    ok(win('code') !== null, '... and never closes Code');
    same(views, [], 'Settings is not Code');
    w.history.forward(); await wait(200);
    same(url(), `/app/code?computer=${COMPUTER}`);
    ok(win('code').classList.contains('window-active'), 'Forward re-focuses Code');
    same(views, [undefined], 'through its relaunch hook, with no view: traversal never resizes an open window');
    same([w.document.querySelectorAll('.window').length, w.history.length], [2, 3], 'traversal opens, closes and pushes nothing');
    await w.$(win('code')).close(); await wait(50);
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3], 'closing replaces with the next focused app');
    same(w.history.state.ezilView, undefined, "Code's view does not stay on Settings' entry");
    await w.$(win('settings')).close(); await wait(50);
    same([url(), w.history.length], [`/os?computer=${COMPUTER}`, 3], 'closing the last app returns to /os');
    w.history.back(); await wait(200);
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3]);
    ok(win('settings') !== null, 'Back to a closed app launches it again (never a push)');
    w.history.go(-1); await wait(200);
    same(url(), `/os?computer=${COMPUTER}`);
    ok(win('settings') !== null, 'Back to /os leaves windows alone');
    ok(pops.length === 4 && pops.every(state => state?.__NA === true), `every traversal landed on a Next-owned entry (${pops.length})`);
    done(w);
}

// ── order through the registry: only the latest intent decides ─────────────
// docs/APP-ROUTES.md §5 "Order". No sleeps: the shell is ready when its dock
// is, a gated `open` waits for the test to release it, and the two delayed
// focuses (UIWindow's 80ms `showWindow`, registry's 120ms `ensureOnTop`) are
// queued and run by hand. Every other timer is the real one.
const appeared = (w, selector) => new Promise(resolve => {
    if (w.document.querySelector(selector)) { resolve(); return; }
    const observer = new w.MutationObserver(() => { if (w.document.querySelector(selector)) { observer.disconnect(); resolve(); } });
    observer.observe(w.document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
});
async function ordered() {
    const booted = await boot(`/os?computer=${COMPUTER}`, { ready: w => appeared(w, '.taskbar-item[data-app="settings"]') });
    const { w, ctx } = booted;
    const delayed = [];
    const setTimeout = w.setTimeout;
    w.setTimeout = (fn, ms, ...args) => (ms === 80 || ms === 120 ? delayed.push({ ms, run: () => fn(...args) }) : setTimeout.call(w, fn, ms, ...args));
    // Every queued callback of that delay, in the order they were queued,
    // with `check` after each one: a write that a later timer would undo is
    // still caught.
    const elapse = (ms, check) => {
        for (const timer of delayed.filter(t => t.ms === ms)) { delayed.splice(delayed.indexOf(timer), 1); timer.run(); check?.(); }
    };
    // The next `open` of `id` waits for the returned release().
    const gate = id => {
        const app = w.ezil.registry.getApp(id);
        const open = app.open;
        let release;
        const held = new Promise(resolve => { release = resolve; });
        app.open = async launchCtx => { app.open = open; await held; return open(launchCtx); };
        return release;
    };
    // Resolves on this module's `count`-th history write from now (a route's
    // `commit` is the last one a Back launch makes).
    const written = (count = 1) => new Promise(resolve => {
        const replace = w.history.replaceState;
        w.history.replaceState = (...args) => {
            replace.apply(w.history, args);
            if ( (count -= 1) === 0 ) { delete w.history.replaceState; resolve(); }
        };
    });
    const launch = id => w.ezil.registry.launch(id, ctx);
    const settle = () => { elapse(80); elapse(120); };
    // The focused window (z-order in this shell is decided by focus).
    const front = () => [...w.document.querySelectorAll('.window.window-active')].map(el => el.dataset.app).join();
    return { ...booted, elapse, gate, written, launch, settle, front };
}
{
    // The coordinator's repro, through the registry: Code's open is slow,
    // Settings is clicked after it and opens first.
    const { w, url, win, elapse, gate, launch, front } = await ordered();
    const release = gate('code');
    const older = launch('code');
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 2], 'a click on Code pushes before its window exists');
    await launch('settings');
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3], 'a click on Settings, which opens first');
    release();
    ok(await older === win('code'), 'Code opens after it');
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3], 'the older launch, resolving last, does not take the address bar');
    const held = () => same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3], "nor do the launches' delayed focuses, one by one (Code's ensureOnTop re-focus included)");
    elapse(80, held);
    same(front(), 'code', 'Code took the front as it was built');
    // Settings' re-focus runs first (positive control: the newest launch's
    // still overrides a later focus); Code's, superseded, stands down.
    elapse(120, () => { held(); same(front(), 'settings', 'after each ensureOnTop, Settings is in front'); });
    w.$(win('code')).focusWindow();
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 3], 'positive control: once it has settled, a focus of Code replaces');
    done(w);
}
{
    // A click on an open window restores it with `showWindow`, which
    // focuses it 80ms later; a click on another app lands before that.
    const { w, url, win, elapse, launch, settle, front } = await ordered();
    await launch('code'); settle();
    await launch('settings'); settle();
    await launch('code');
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 4]);
    await launch('settings');
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 5]);
    const held = () => same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 5], "Code's late showWindow focus, then each ensureOnTop, leave the newer click's URL");
    elapse(80, held);
    elapse(120, () => { held(); same(front(), 'settings', "Code's superseded ensureOnTop does not take the front back"); });
    // Positive control: the same late focus with no newer launch, after a
    // focus elsewhere, names Code.
    await launch('code');
    w.$(win('settings')).focusWindow();
    same(url(), `/app/settings?computer=${COMPUTER}`, 'positive control: focus replaces');
    elapse(80);
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 6], "positive control: the latest launch's late focus names it");
    done(w);
}
{
    // Back to an open Code restores it (its 80ms focus pending); a click on
    // Settings lands before that focus.
    const { w, url, written, launch, settle, elapse, front } = await ordered();
    await launch('code'); settle();
    await launch('settings'); settle();
    // Two writes: the entry takes the view the open Code shows (Code's own
    // entry was pushed before its window existed, with none), then the
    // launch commits.
    const committed = written(2);
    w.history.back();
    await committed;
    same([url(), w.history.length, w.history.state.ezilView], [`/app/code?computer=${COMPUTER}`, 3, 'window'], 'Back to Code commits in place');
    await launch('settings');
    same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3]);
    const held = () => same([url(), w.history.length], [`/app/settings?computer=${COMPUTER}`, 3], "the Back launch's late focus does not take the address bar from the newer click");
    elapse(80, held);
    elapse(120, () => { held(); same(front(), 'settings', "the Back launch's superseded ensureOnTop does not take the front"); });
    done(w);
}
// The boot's own route launch (its link, the billing link), slow to open,
// with a click on another app made while it opens (`click`), or none. The
// 80/120ms focuses wait, as in `ordered`, and run in the order queued once
// the boot's launch has resolved: which window ends in front no longer
// depends on how fast this machine builds one.
async function bootOvertaken(entry, id, click) {
    let release, started;
    const opening = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const delayed = [];
    const booted = await boot(entry, { ready: async w => {
        // Before the boot's first await reaches the launch.
        const app = w.ezil.registry.getApp(id);
        const open = app.open;
        app.open = async launchCtx => { app.open = open; started(); await held; return open(launchCtx); };
        const setTimeout = w.setTimeout;
        w.setTimeout = (fn, ms, ...args) => (ms === 80 || ms === 120 ? delayed.push({ ms, run: () => fn(...args) }) : setTimeout.call(w, fn, ms, ...args));
        await opening;
    } });
    const { w, url, win, ctx } = booted;
    if ( click ) {
        await w.ezil.registry.launch(click, ctx);
        same([url().replace(/\?.*/, ''), w.history.length], [`/app/${click}`, 2], `${entry}: a click on ${click} while it opens pushes once`);
    }
    release();
    await appeared(w, `.window[data-app="${id}"]`); await wait(300);
    ok(win(id), `${entry}: ${id} opened`);
    for (const ms of [80, 120]) for (const timer of delayed.filter(t => t.ms === ms)) timer.run();
    const front = [...w.document.querySelectorAll('.window.window-active')].map(el => el.dataset.app).join();
    return { ...booted, front };
}
for (const [entry, id, click, canonical] of [
    [`/os?app=code&computer=${COMPUTER}`, 'code', 'settings', `/app/code?computer=${COMPUTER}`],
    ['/os?settings=billing&section=ai-credits&x=1', 'settings', 'code', '/app/settings?tab=billing&x=1'],
]) {
    // Review N5 (the boot link) and N11 (the billing link's `adopt`).
    const overtaken = await bootOvertaken(entry, id, click);
    same([overtaken.url().replace(/\?.*/, ''), overtaken.w.history.length, overtaken.w.history.state.ezilApp, overtaken.front], [`/app/${click}`, 2, click, click],
        `${entry}: resolving after the click, the boot's launch takes neither the click's entry nor the front`);
    done(overtaken.w);
    const alone = await bootOvertaken(entry, id, null);
    same([alone.url(), alone.w.history.length, alone.w.history.state.ezilApp, alone.front], [canonical, 1, id, id], `positive control: ${entry} with no click names ${id}`);
    done(alone.w);
}

// A boot's Settings link with Settings' `open` held, and no sleeps: the boot
// is ready when its launch calls `open`; `finish` lets the real `open` run,
// waits for it, then for one turn of the event loop (`turn`, no delay), after
// which every microtask queued before it has run (the launch's commit, a
// coalesced click's end, the boot's adopt). `focuses` runs the queued
// 80/120ms focuses by hand. `opens`: what each `open` of Settings received,
// and the address bar at that moment.
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settingsHeld(entry, { features } = {}) {
    let release, started, opened;
    const opening = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const resolved = new Promise(resolve => { opened = resolve; });
    const delayed = [];
    const opens = [];
    const booted = await boot(entry, { features, ready: async w => {
        // Before the boot's first await reaches the launch.
        const app = w.ezil.registry.getApp('settings');
        const open = app.open;
        app.open = async launchCtx => {
            opens.push({ initialTab: launchCtx.initialTab, openUpgrade: launchCtx.openUpgrade, at: `${w.location.pathname}${w.location.search}` });
            if ( opens.length > 1 ) return open(launchCtx);
            started();
            await held;
            const el = await open(launchCtx);
            opened(el);
            return el;
        };
        const setTimeout = w.setTimeout;
        w.setTimeout = (fn, ms, ...args) => (ms === 80 || ms === 120 ? delayed.push({ ms, run: () => fn(...args) }) : setTimeout.call(w, fn, ms, ...args));
        await opening;
    } });
    const finish = async () => { release(); await resolved; await turn(); };
    const focuses = async () => {
        for (const ms of [80, 120]) for (const timer of delayed.filter(t => t.ms === ms)) { delayed.splice(delayed.indexOf(timer), 1); timer.run(); }
        await turn();
    };
    const front = () => [...booted.w.document.querySelectorAll('.window.window-active')].map(el => el.dataset.app).join();
    return { ...booted, opens, finish, focuses, front };
}
const BILLING = '/os?settings=billing&upgrade=standard&section=ai-credits&x=1';
const STRIPPED = '/os?settings=billing&section=ai-credits&x=1';
const leftBehind = {};
for (const click of [null, 'settings', 'code']) {
    // The recheck of 118ebea9 (2026-10-30). A click on Settings ITSELF while
    // the boot's billing link opens it writes nothing (the alias names
    // Settings already), so the link still canonicalises its own entry. A
    // click on Code pushes its entry and keeps it; the boot's entry is left
    // behind it. No click: positive control. Whatever happens, `upgrade` left
    // the address bar before the launch (Billing still finds `section`).
    const b = await settingsHeld(BILLING);
    const { w, url, win, ctx } = b;
    same(b.opens, [{ initialTab: 'billing', openUpgrade: false, at: STRIPPED }], `${click ?? 'no click'}: Settings opens with upgrade already gone from the address bar, section still on it`);
    let clicked = null;
    if ( click === 'settings' ) {
        clicked = w.ezil.registry.launch('settings', ctx);
        same([url(), w.history.length], [STRIPPED, 1], 'a click on Settings while it opens writes nothing');
    } else if ( click === 'code' ) {
        await w.ezil.registry.launch('code', ctx);
        same([url(), w.history.length], ['/app/code', 2], 'a click on Code while it opens pushes its own entry');
    }
    await b.finish();
    if ( clicked ) ok(await clicked === win('settings'), 'the click and the billing link resolve with one window');
    const named = click === 'code' ? ['/app/code', 2, 'code'] : ['/app/settings?tab=billing&x=1', 1, 'settings'];
    // With Code clicked, Settings' own focus while it is built names it
    // until Code's ensureOnTop runs (a known limit, docs/APP-ROUTES.md §5):
    // plain `/app/settings`, so neither the link's commit nor its adopt
    // wrote over the click's entry.
    same([url(), w.history.length, w.history.state.ezilApp], click === 'code' ? ['/app/settings', 2, 'settings'] : named, click === 'settings'
        ? 'a click on Settings itself took nothing: the billing link canonicalises its entry, one-shot keys gone'
        : click ? 'the click on Code took the entry: the billing link writes nothing over it' : 'positive control: the billing link is canonicalised');
    await b.focuses();
    same([url(), w.history.length, w.history.state.ezilApp, b.front()], [...named, named[2]], `${click ?? 'no click'}: the same after the delayed focuses, its window in front`);
    same(w.document.querySelectorAll('.window[data-app="settings"]').length, 1);
    if ( click === 'code' ) {
        const back = new Promise(resolve => w.addEventListener('popstate', resolve, { once: true }));
        w.history.back(); await back;
        same(url(), STRIPPED, 'Back: the boot entry left behind the click has no upgrade key');
        await turn();
    }
    leftBehind[click ?? 'none'] = url();
    done(w);
}
for (const [label, entry] of [['the entry a click on Settings left', leftBehind.settings], ['the entry a click on Code left behind', leftBehind.code]]) {
    // A reload of either, billing on, does not open the checkout or upgrade
    // sheet again: Settings opens at Billing with no `openUpgrade`.
    const b = await settingsHeld(entry, { features: { billing: true } });
    await b.finish();
    same(b.opens.map(({ initialTab, openUpgrade }) => [initialTab, openUpgrade]), [['billing', false]], `a reload of ${label} (${entry}) opens no sheet`);
    done(b.w);
}
{
    // Positive control: the link itself, billing on, hands Settings its
    // sheet exactly once, and leaves the address bar without the key.
    const b = await settingsHeld('/os?settings=billing&upgrade=standard', { features: { billing: true } });
    await b.finish();
    same([b.opens.map(({ initialTab, openUpgrade, at }) => [initialTab, openUpgrade, at]), b.url()],
        [[['billing', 'standard_monthly_v3', '/os?settings=billing']], '/app/settings?tab=billing'], 'positive control: a fresh billing link opens the sheet once');
    done(b.w);
}
{
    // Not only the billing link: a plain Settings link's canonical form keeps
    // every other key, `tab` included, so `/os?app=settings&tab=billing&
    // upgrade=pro` would reload as a billing link with `upgrade=pro` (review
    // of this lane, 2026-10-30). The key goes before that launch too, and a
    // reload of the entry, billing on, opens no sheet.
    const plain = await settingsHeld('/os?app=settings&tab=billing&upgrade=pro');
    await plain.finish();
    same([plain.opens.map(({ openUpgrade, at }) => [openUpgrade ?? null, at]), plain.url()], [[[null, '/app/settings?tab=billing']], '/app/settings?tab=billing'],
        'a plain Settings link: upgrade gone before its launch, and from its canonical entry');
    done(plain.w);
    const reload = await settingsHeld(plain.url(), { features: { billing: true } });
    await reload.finish();
    same(reload.opens.map(({ initialTab, openUpgrade }) => [initialTab, openUpgrade]), [['billing', false]], `a reload of ${plain.url()}, billing on, opens no sheet`);
    done(reload.w);
}

// ── the entry follows the screen: Back/Forward, then a reload ───────────────
// docs/APP-ROUTES.md §5 "State". Back/Forward never resizes an open Code, so
// the entry it lands on takes the view Code shows NOW, and a reload of that
// entry (a new document booted from its URL and state) reopens Code as it
// was on screen. The real bundle throughout: code.js's full view, its top
// bar, its relaunch hook and its `ezil:app-view-changed`, none stubbed. No
// sleeps: `viewBoot` is ready once its link's Code window is built (the
// `ezil-full-view-host` class goes on in the same synchronous run that
// applies the launch's view) and one turn later, when that launch has
// committed. The 80/120ms focuses and Code's 220ms restore from the taskbar
// are queued and run by hand (`timers`).
const CODE_BUILT = '.window[data-app="code"].ezil-full-view-host';
async function viewBoot(entry, state = NEXT_STATE) {
    const delayed = [];
    const booted = await boot(entry, { state, ready: async w => {
        const setTimeout = w.setTimeout;
        w.setTimeout = (fn, ms, ...args) => ([80, 120, 220].includes(ms) ? delayed.push({ ms, run: () => fn(...args) }) : setTimeout.call(w, fn, ms, ...args));
        await appeared(w, '.taskbar-item[data-app="settings"]');
        if ( entry.startsWith('/app/code') ) await appeared(w, CODE_BUILT);
        await turn();
    } });
    const { w, win, url, ctx } = booted;
    const timers = async () => {
        for (const ms of [80, 120, 220]) for (const timer of delayed.filter(t => t.ms === ms)) { delayed.splice(delayed.indexOf(timer), 1); timer.run(); }
        await turn();
    };
    // A click (a dock icon), then its window's delayed focuses.
    const click = async id => { await w.ezil.registry.launch(id, ctx); await timers(); };
    // Code's own top bar: 'restore' (Restore window) or 'minimize'.
    const bar = action => win('code').querySelector(`:scope > .ezil-full-view-bar [data-action="${action}"]`).click();
    // Back/Forward, resolved by the popstate itself, then by Code's window
    // when the entry names it (a closed Code is built anew). `during` runs
    // right after the shell's own popstate handler, before its launch
    // resolves.
    const traverse = async (delta, during) => {
        const popped = new Promise(resolve => w.addEventListener('popstate', () => { during?.(); resolve(); }, { once: true }));
        w.history.go(delta);
        await popped;
        if ( url().startsWith('/app/code') ) await appeared(w, CODE_BUILT);
        await turn();
        await timers();
    };
    const view = () => w.history.state?.ezilView;
    const full = () => win('code')?.classList.contains('ezil-fullbleed') ?? null;
    // A reload of the current entry: this document goes, a new one boots
    // from the entry's URL and state.
    const reload = () => {
        const [at, kept] = [url(), plain(w.history.state)];
        done(w);
        return viewBoot(at, kept);
    };
    return { ...booted, timers, click, bar, traverse, view, full, reload };
}
for (const [delta, switched] of [[-1, true], [1, true], [-1, false], [1, false]]) {
    // E1: Code from /app/code, full. A click on Settings pushes E2, and a
    // focus of Code renames it, both recording full. (Forward: Back to E1
    // first.) The user restores Code to a window on the entry it is on, or,
    // the positive control, does not, and goes Back (Forward) to the other
    // entry, which still says full. Code is not resized; the entry is.
    const name = `${delta < 0 ? 'Back' : 'Forward'}${switched ? '' : ', no switch'}`;
    const v = await viewBoot('/app/code');
    const { w, win } = v;
    same([v.opens.map(c => c.view), v.full(), v.view()], [['full'], true, 'full'], `${name}: E1, Code opened full from its route, and its commit says so`);
    await v.click('settings');
    same([v.url(), w.history.length, w.history.state.ezilApp, v.full()], ['/app/settings', 2, 'settings', true], `${name}: a click on Settings pushes E2`);
    w.$(win('code')).focusWindow();
    same([v.url(), v.view()], ['/app/code', 'full'], `${name}: a focus of Code renames E2, with the view Code shows`);
    if ( delta > 0 ) {
        await v.traverse(-1);
        same([v.url(), v.view(), v.full()], ['/app/code', 'full', true], `${name}: Back to E1 first`);
    }
    if ( switched ) v.bar('restore');
    same([v.full(), v.view()], switched ? [false, 'window'] : [true, 'full'], switched ? `${name}: Restore window, recorded on this entry` : `${name}: no switch`);
    await v.traverse(delta);
    same([v.url(), w.history.length, v.full(), v.opens.length], ['/app/code', 2, ! switched, 1], `${name}: Code is focused, never resized or reopened`);
    same(v.view(), switched ? 'window' : 'full', `${name}: 🔴 the entry it lands on takes the view Code shows`);
    same([w.history.state.__NA, w.history.state.__PRIVATE_NEXTJS_INTERNALS_TREE], [true, NEXT_STATE.__PRIVATE_NEXTJS_INTERNALS_TREE], `${name}: Next's keys survive`);
    const r = await v.reload();
    same([r.opens.map(c => c.view), r.full(), r.view()], switched ? [['window'], false, 'window'] : [['full'], true, 'full'],
        switched ? `${name}: 🔴 a reload of that entry opens Code WINDOWED, as it was on screen` : `${name}: positive control: a reload opens Code full`);
    done(r.w);
}
{
    // The entry is written at the popstate itself, not only by the Back
    // launch's commit: a click on Settings made before that launch resolves
    // takes the entry, and the commit stands down. Code, closed after that,
    // reopens on a later Back to E1 with the view E1 took when Back landed
    // on it: windowed, as it was then.
    const v = await viewBoot('/app/code');
    const { w, win } = v;
    await v.click('settings');
    w.$(win('code')).focusWindow();
    v.bar('restore');
    same([v.url(), w.history.length, v.view(), v.full()], ['/app/code', 2, 'window', false], 'E2 names Code, windowed');
    let clicked = null;
    await v.traverse(-1, () => { clicked = w.ezil.registry.launch('settings', v.ctx); });
    ok(await clicked === win('settings'));
    await v.timers();
    same([v.url(), w.history.length], ['/app/settings', 2], 'the click right after Back pushed over E2, and the Back launch stood down');
    await w.$(win('code')).close();
    same([v.url(), win('code')], ['/app/settings', null], 'Code closed behind Settings');
    await v.traverse(-1);
    same([v.url(), v.opens.map(c => c.view), v.full(), v.view()], ['/app/code', ['full', 'window'], false, 'window'],
        '🔴 Back to E1 reopens Code WINDOWED: E1 took the view Code showed when Back first landed on it');
    const r = await v.reload();
    same([r.opens.map(c => c.view), r.full()], [['window'], false], '... and so does a reload of E1');
    done(r.w);
}
for (const recorded of ['full', 'window']) {
    // Positive control: Back to the entry of an app that is CLOSED launches
    // it with the view that entry recorded, whatever the user chose since on
    // another entry. E1 records `recorded`; on E2 Code is switched the other
    // way, then closed. With 'full', Code reopens full unannounced while the
    // last view it announced was 'window': the entry asks the window, it
    // keeps no copy of the events.
    const v = await viewBoot('/app/code');
    const { w, win } = v;
    const other = recorded === 'full' ? 'window' : 'full';
    if ( recorded === 'window' ) v.bar('restore');
    same(v.view(), recorded, `E1 records ${recorded}`);
    await v.click('settings');
    w.$(win('code')).focusWindow();
    // Restore window, or the green button's handler (`scale_window`).
    if ( other === 'window' ) v.bar('restore'); else w.scale_window(win('code'));
    same([v.url(), v.view(), v.full()], ['/app/code', other, other === 'full'], `E2: Code switched to ${other}`);
    await w.$(win('code')).close();
    same([v.url(), v.view(), win('code')], ['/app/settings', undefined, null], 'closing Code renames E2 to Settings');
    await v.traverse(-1);
    same([v.url(), v.opens.map(c => c.view), v.full(), v.view()], ['/app/code', ['full', recorded], recorded === 'full', recorded],
        `Back to E1 with Code closed: it reopens with E1's own view, ${recorded}, and E1 still says so`);
    const r = await v.reload();
    same([r.opens.map(c => c.view), r.full(), r.view()], [[recorded], recorded === 'full', recorded], `a reload of E1 opens Code ${recorded} too`);
    done(r.w);
}
{
    // Minimised from full view, Code still WANTS full view (back from the
    // taskbar it re-enters it: code.js's 220ms restore, run by hand), though
    // while hidden it has no `ezil-fullbleed` class. Back to its entry
    // records 'full': the window's state, not its class.
    const v = await viewBoot('/app/code');
    const { w, win } = v;
    v.bar('minimize');
    same([v.full(), win('code').getAttribute('data-is_minimized'), v.view()], [false, 'true', 'full'], 'minimised from full view');
    await v.click('settings');
    same([v.url(), w.history.length, v.full()], ['/app/settings', 2, false]);
    await v.traverse(-1);
    same([v.url(), win('code').getAttribute('data-is_minimized'), v.full(), v.view()], ['/app/code', 'false', true, 'full'],
        'Back to E1 shows Code again, in full view, and E1 says full');
    const r = await v.reload();
    same([r.opens.map(c => c.view), r.full()], [['full'], true], 'a reload of E1 opens Code full');
    done(r.w);
}
for (const switched of [true, false]) {
    // A click on Settings that fails (its open resolves with nothing) gives
    // E1 back. While it was pending the user restored Code to a window: that
    // view change found Settings' entry and recorded nothing, so the
    // give-back writes the view Code shows now. Positive control: no switch.
    const v = await viewBoot('/app/code');
    const { w } = v;
    const settings = w.ezil.registry.getApp('settings');
    const open = settings.open;
    let fail;
    const failing = new Promise(resolve => { fail = resolve; });
    settings.open = async () => { settings.open = open; await failing; return null; };
    const clicked = w.ezil.registry.launch('settings', v.ctx);
    same([v.url(), w.history.length, v.view()], ['/app/settings', 2, undefined], 'the click pushed E2 before Settings opens');
    if ( switched ) v.bar('restore');
    same([v.view(), v.full()], [undefined, ! switched], switched ? "Code's view change finds Settings' entry: nothing recorded" : 'no switch');
    fail();
    same(await clicked, null, 'Settings opened nothing');
    await v.timers();
    same([v.url(), v.view(), v.full()], ['/app/code', switched ? 'window' : 'full', ! switched],
        switched ? "🔴 the give-back names Code with the view it shows now" : 'positive control: the give-back, no switch');
    const r = await v.reload();
    same([r.opens.map(c => c.view), r.full()], [[switched ? 'window' : 'full'], ! switched], `a reload of the entry given back opens Code ${switched ? 'windowed' : 'full'}`);
    done(r.w);
}
for (const path of ['focus', 'close', 'click']) for (const switched of [true, false]) {
    // Not only Back/Forward: every write of an entry for an open Code records
    // the view it shows, with no view change announced on that entry. On E1
    // the user restores Code to a window (or not); a click on Settings
    // pushes E2; then a focus of Code renames E2, or the close of Settings
    // does, or a click on Code's icon pushes E3.
    const name = `${path}${switched ? '' : ', no switch'}`;
    const v = await viewBoot('/app/code');
    const { w, win } = v;
    if ( switched ) v.bar('restore');
    await v.click('settings');
    if ( path === 'focus' ) w.$(win('code')).focusWindow();
    else if ( path === 'close' ) await w.$(win('settings')).close();
    else await v.click('code');
    const shown = switched ? 'window' : 'full';
    same([v.url(), w.history.length, v.view(), v.full()], ['/app/code', path === 'click' ? 3 : 2, shown, ! switched], `${name}: the entry names Code, ${shown}`);
    const r = await v.reload();
    same([r.opens.map(c => c.view), r.full()], [[shown], ! switched], `${name}: a reload opens Code ${shown}`);
    done(r.w);
}

// ── hosts that serve only /os: no rewriting ─────────────────────────────────
for (const provider of ['local-vm', 'native-macos']) {
    const { w, url } = await boot(`/os?app=settings&settings=system`, { provider });
    ok(w.document.querySelector('[data-pane="system"].active'), `${provider}: the link still opens`);
    w.$('.taskbar-item[data-app="settings"]').trigger('click'); await wait(150);
    same([url(), w.history.length], ['/os?app=settings&settings=system', 1], `${provider}: the path is never rewritten`);
    done(w);
}
{
    const { w, url } = await boot('/os?settings=billing&upgrade=pro', { provider: 'local-vm' });
    same(url(), '/os', 'local: the one-shot billing keys are still consumed in place');
    done(w);
}
console.log(`PASS ${checks} checks: app allowlist, /app/<id> routes and alias canonicalisation, project params, direct entry, repeated target, relaunch hook, history push/replace/traversal, launch order through the registry (slow open, late showWindow/ensureOnTop focus, Back launch), the entry follows the screen (Back/Forward then a reload, a launch that stands down, a closed Code, minimised, a failed click, focus/close/click), /os-only hosts`);

process.exit(0);
