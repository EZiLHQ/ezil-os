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
    ok(otherApp.w.history.state.ezilView === undefined && otherApp.w.history.state.ezilApp === 'code');
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
    const views = [];
    win('code')._ezil_relaunch = launchCtx => views.push(launchCtx.view);
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'settings', view: 'full' } }));
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'huge' } }));
    same(w.history.state.ezilView, undefined, 'a view for another app, or an unknown view, is not recorded');
    w.dispatchEvent(new w.CustomEvent('ezil:app-view-changed', { detail: { appId: 'code', view: 'window' } }));
    same([w.history.state.ezilView, w.history.state.__NA, w.history.length], ['window', true, 3], 'the view is recorded on this entry');
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
    observer.observe(w.document, { childList: true, subtree: true });
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
    // Resolves on this module's next history write (a route's `commit`).
    const written = () => new Promise(resolve => {
        w.history.replaceState = (...args) => { delete w.history.replaceState; w.history.replaceState(...args); resolve(); };
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
    const committed = written();
    w.history.back();
    await committed;
    same([url(), w.history.length], [`/app/code?computer=${COMPUTER}`, 3], 'Back to Code commits in place');
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

// The billing link with Settings' `open` held, and no sleeps: the boot is
// ready when its launch calls `open`; `finish` lets the real `open` run,
// waits for it, then for one turn of the event loop (`turn`, no delay), after
// which every microtask queued before it has run (the launch's commit, a
// coalesced click's end, the boot's adopt). `focuses` runs the queued
// 80/120ms focuses by hand. `opens`: what each `open` of Settings received,
// and the address bar at that moment.
const turn = () => new Promise(resolve => setImmediate(resolve));
async function billingHeld(entry, { features } = {}) {
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
    const b = await billingHeld(BILLING);
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
    const b = await billingHeld(entry, { features: { billing: true } });
    await b.finish();
    same(b.opens.map(({ initialTab, openUpgrade }) => [initialTab, openUpgrade]), [['billing', false]], `a reload of ${label} (${entry}) opens no sheet`);
    done(b.w);
}
{
    // Positive control: the link itself, billing on, hands Settings its
    // sheet exactly once, and leaves the address bar without the key.
    const b = await billingHeld('/os?settings=billing&upgrade=standard', { features: { billing: true } });
    await b.finish();
    same([b.opens.map(({ initialTab, openUpgrade, at }) => [initialTab, openUpgrade, at]), b.url()],
        [[['billing', 'standard_monthly_v3', '/os?settings=billing']], '/app/settings?tab=billing'], 'positive control: a fresh billing link opens the sheet once');
    done(b.w);
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
console.log(`PASS ${checks} checks: app allowlist, /app/<id> routes and alias canonicalisation, project params, direct entry, repeated target, relaunch hook, history push/replace/traversal, launch order through the registry (slow open, late showWindow/ensureOnTop focus, Back launch), /os-only hosts`);

process.exit(0);
