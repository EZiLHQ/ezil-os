// app-history.js — EZiL-authored. THE ONE OWNER OF THIS TAB'S ADDRESS BAR.
//
// Nothing else in this shell calls `history.pushState`/`replaceState`. Apps
// that want the URL to change say so with an event (see `install`) and this
// module decides. The contract, as implemented, is docs/APP-ROUTES.md:
//
//   - a user-gesture launch PUSHES `/app/<id>` (one new entry, and only when
//     the address bar is not already naming that app);
//   - focus moving to another app's window REPLACES the current entry;
//   - closing a window REPLACES it with the next focused app, or `/os`;
//   - Back/Forward (`popstate`) focuses that app's window, or launches it.
//     It NEVER closes a window, stops a computer or deletes state;
//   - an entry written for an app whose window is open records the view
//     that window shows now (`viewOf`), so a reload reopens what was on
//     screen. One whose app has no window keeps the view it recorded.
//
// 🔴 ONLY THE LATEST INTENT DECIDES. Launches resolve out of order (a click
// on Code, then on Settings; Settings opens first). A launch, or a
// Back/Forward launch, that resolves after a newer intent took the entry
// (wrote it, or moved to another) writes nothing for it — see `owner` below
// and docs/APP-ROUTES.md §5 "Order".
//
// 🔴 EVERY WRITE STARTS FROM `history.state`. `/os` is a Next.js App Router
// page, and Next keeps its own keys there (`__NA`, its route tree). Its
// popstate handler RELOADS THE PAGE on a non-null state without `__NA` —
// which would throw away every open window on the first Back. Next also
// patches push/replaceState to copy those keys, but only once its own effect
// has run; merging here keeps them either way, and keeps any key a later
// lane adds (e.g. `ezilProjectLaunchIntent`).
//
// 🔴 ONLY WHERE THE HOST SERVES `/app/<id>`. The native Mac host and the
// local runtime serve the shell at `/os` alone (the native one refuses any
// query string), so a rewritten URL there would be a 404 on reload. On those
// providers this module never rewrites the path; Back/Forward still focuses.
import { parseAppLink } from './app-link.js';

export const OS_PATH = '/os';
// Page-level: the server picks the computer from it on a reload, so it rides
// on every URL written here, whichever app is focused.
const PAGE_KEYS = ['computer'];
// The alias form's app selectors. The path names the app instead.
const SELECTOR_KEYS = new Set(['app', 'settings']);
const OS_ONLY_PROVIDERS = new Set(['native-macos', 'local-vm']);
const VIEWS = new Set(['full', 'window']);

/** A query value with `/` left readable; app-link.js rejects an encoded one. */
export function encodeQueryValue (value) {
    return encodeURIComponent(String(value)).replace(/%2F/g, '/');
}

function query (entries) {
    const pairs = entries.filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${encodeQueryValue(key)}=${encodeQueryValue(value)}`);
    return pairs.length ? `?${pairs.join('&')}` : '';
}

/**
 * `/app/<id>` plus its parameters, in the given order.
 * @param {string} id  A registry app id.
 * @param {Record<string, string|undefined>|[string, string][]} [params]
 */
export function appUrl (id, params = {}) {
    return `/app/${encodeURIComponent(id)}${query(Array.isArray(params) ? params : Object.entries(params))}`;
}

/** The URL parameters that belong to one app, from a parsed link. */
export function linkParams (link) {
    if ( ! link ) return {};
    if ( link.id === 'settings' ) return link.initialTab ? { tab: link.initialTab } : {};
    if ( link.id === 'code' && link.project ) {
        return { project: link.project.projectId, repo: link.project.repoId, path: link.project.path };
    }
    return {};
}

/**
 * `previous` with `patch` applied. Keys this module does not know are kept;
 * a patch value of `undefined` deletes that key.
 */
export function mergeHistoryState (previous, patch = {}) {
    const next = previous && typeof previous === 'object' && ! Array.isArray(previous) ? { ...previous } : {};
    for ( const [key, value] of Object.entries(patch) ) {
        if ( value === undefined ) delete next[key];
        else next[key] = value;
    }
    return next;
}

function decodedKey (pair) {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    try { return decodeURIComponent(name.replace(/\+/g, ' ')); } catch { return name; }
}

/**
 * `location`'s path, query and hash without the query pairs whose (decoded)
 * key is in `keys`. Every other pair is kept BYTE FOR BYTE, as in
 * `canonicalUrl`.
 * @param {{pathname: string, search?: string, hash?: string}} location
 * @param {string[]} keys
 */
export function withoutKeys (location, keys) {
    const drop = new Set(keys);
    const kept = String(location.search ?? '').replace(/^\?/, '').split('&')
        .filter(pair => pair !== '' && ! drop.has(decodedKey(pair)));
    return `${location.pathname}${kept.length ? `?${kept.join('&')}` : ''}${location.hash ?? ''}`;
}

/**
 * The canonical `/app/<id>` spelling of the location `link` was parsed from.
 * Every query pair other than the alias selectors is kept BYTE FOR BYTE, so
 * canonicalising never turns a value the parser rejected (`path=a%2Fb`) into
 * one it accepts.
 * @param {{search?: string, hash?: string}} location
 * @param {{id: string, initialTab?: string}} link
 * @param {{search?: string}} [options] use this query instead of `location.search`
 */
export function canonicalUrl (location, link, { search } = {}) {
    const raw = String(search ?? location.search ?? '').replace(/^\?/, '');
    const tabbed = link.id === 'settings' && link.initialTab;
    const kept = raw.split('&').filter(pair => pair !== '' && ! SELECTOR_KEYS.has(decodedKey(pair))
        && ! (tabbed && decodedKey(pair) === 'tab'));
    if ( tabbed ) kept.unshift(`tab=${encodeQueryValue(link.initialTab)}`);
    return `/app/${encodeURIComponent(link.id)}${kept.length ? `?${kept.join('&')}` : ''}${location.hash ?? ''}`;
}

/**
 * The launch context a ROUTE contributes (contract item 3). An app that is
 * already open gets NO view: Back/Forward focuses it and must not resize it
 * (contract item 5), and an entry's recorded view can be older than the
 * user's latest choice, which lives on whichever entry was current then.
 * Otherwise the view this entry recorded, else full-screen for Code.
 */
export function routeLaunchContext (link, { hasWindow = false, recordedView } = {}) {
    const view = hasWindow ? undefined
        : VIEWS.has(recordedView) ? recordedView
            : link.id === 'code' ? 'full' : undefined;
    return {
        ...(link.initialTab ? { initialTab: link.initialTab } : {}),
        ...(link.project ? { project: link.project } : {}),
        ...(view ? { view } : {}),
    };
}

export function createAppHistory () {
    let deps = null;
    let enabled = false;
    let holds = 0;
    let pageParams = [];
    // Each open app's own parameters (Code's project, Settings' tab), so
    // focusing it again restores the URL it was opened with.
    const params = new Map();
    // Every intent takes the next number (`issued`, never reused): a click's
    // launch (`begin`), Back/Forward, a route launch the boot starts
    // (`route`), a close or a focus this module writes for.
    //
    // 🔴 THE ENTRY'S OWNER, not the latest number, decides what a pending
    // launch may still write. `owner` is the number of the intent that last
    // TOOK the current entry: wrote it (a click's push, or its replace in
    // place; a close or focus that renamed it) or moved to another one
    // (Back/Forward). An intent that wrote nothing took nothing: a click on
    // the app the entry already names, with the same parameters (it
    // coalesces with that app's launch if one is still opening), a close
    // behind the front window, the boot's `route` (its `commit` writes
    // later). A pending launch keeps the owner it began under (`held`: its
    // own number if it took the entry, else the owner it found), and writes
    // for the entry (`commit`, `adopt`, the give-back in `end(null)`) only
    // while `owner` is still that one. Its own late write (`end`, `commit`,
    // `adopt`) takes nothing: it is made under the owner it held. A failed
    // click gives `owner` back to the one before it.
    //
    // `launchGeneration` is the newest LAUNCH intent (a click, Back/Forward,
    // a boot route), given back the same way. It decides the front: which
    // launch names its app when it opens (`end`), and whose window's late
    // focus counts (`superseded`).
    let issued = 0;
    let owner = 0;
    let launchGeneration = 0;
    // A click's launch that failed while it could not give back (a newer
    // intent had taken the entry, or a newer launch still stood) -> a retry
    // of its give-back, run when the front comes back to it (every newer
    // launch failed too). An intent that took the entry and cannot fail
    // (Back/Forward, a close, a focus) ends every such chain.
    const failed = new Map();
    const take = () => { failed.clear(); owner = issued += 1; return owner; };
    // A route launch's ctx (Back/Forward, or the boot's own through `route`)
    // -> `{ gen, held }`: its number, and the owner it began under, for
    // `commit` and `adopt`. Keyed by the object `registry.launch` hands
    // back: a key added to the ctx itself would reach the app.
    const routes = new WeakMap();
    // A launched window -> the launch number it opened under, until
    // `settled`. Until then its focus events are the launch's own (UIWindow's
    // 80ms `showWindow` focus, registry's 120ms `ensureOnTop` re-focus), and
    // they count only while that launch is the latest one.
    // Two launches can resolve with the same single-instance window, in
    // either order: it keeps the newer one's number.
    const settling = new WeakMap();
    const settle = (el, gen) => { if ( el && typeof el === 'object' && ! (settling.get(el) > gen) ) settling.set(el, gen); };
    const superseded = el => settling.has(el) && settling.get(el) !== launchGeneration;

    const win = () => deps.win;
    const apps = () => deps.getApps() ?? [];
    const known = id => typeof id === 'string' && apps().some(app => app.id === id);
    const currentApp = () => parseAppLink(win().location, apps())?.id ?? null;
    const here = () => `${win().location.pathname}${win().location.search}${win().location.hash}`;
    const urlFor = id => (id ? appUrl(id, [...Object.entries(params.get(id) ?? {}), ...pageParams])
        : `${OS_PATH}${query(pageParams)}`);
    const liveWindow = id => win().document.querySelector(`.window[data-app="${id}"]:not([data-closing="1"])`);
    // 🔴 THE ENTRY FOLLOWS THE SCREEN. The view an open window shows NOW,
    // asked of the window itself (Code: `_ezil_view`, its full-view state),
    // never a copy kept here: a copy drifts (an open is not announced, a
    // minimise is not a change of view). Undefined when it reports none.
    const viewOf = el => {
        try { const view = el?._ezil_view?.(); return VIEWS.has(view) ? view : undefined; } catch { return undefined; }
    };
    // `ezilView` describes the entry's app: an app with an open window gets
    // that window's view (or none), and a recorded one never outlives a change
    // of app. An app with no window keeps what its entry recorded, which is
    // how a reload, or a Back that launches it, reopens it.
    const stateFor = id => {
        const el = id ? liveWindow(id) : null;
        if ( el ) return { ezilApp: id, ezilView: viewOf(el) };
        return { ezilApp: id ?? undefined, ...(win().history.state?.ezilApp === id ? {} : { ezilView: undefined }) };
    };
    // `state` with its app's view refreshed, if that app has a window open.
    const withView = state => {
        const el = known(state?.ezilApp) ? liveWindow(state.ezilApp) : null;
        return el ? mergeHistoryState(state, { ezilView: viewOf(el) }) : state;
    };
    const write = (method, url, patch) => {
        win().history[method](mergeHistoryState(win().history.state, patch), '', url);
    };
    // Record what this launch says about the app's own URL parameters:
    // Settings' tab always follows the launch (it reopens at Account without
    // one), Code's project only when one is given. True if they changed.
    // Always a new object, so a failed launch can tell whether a later one
    // has set this app's parameters since (`end`).
    const remember = (id, ctx) => {
        const before = JSON.stringify(params.get(id) ?? {});
        if ( id === 'settings' ) params.set(id, ctx.initialTab ? { tab: ctx.initialTab } : {});
        else if ( ctx.project ) params.set(id, linkParams({ id, project: ctx.project }));
        else params.set(id, { ...params.get(id) });
        return JSON.stringify(params.get(id)) !== before;
    };

    function onPopState () {
        // The newest intent, and it moved to another entry, whichever one it
        // lands on (`/os` included): a click's launch or an earlier
        // traversal's still opening must not write over it.
        const gen = launchGeneration = take();
        const link = parseAppLink(win().location, apps());
        if ( ! link ) return;
        params.set(link.id, linkParams(link));
        const state = win().history.state;
        const open = liveWindow(link.id);
        // An open window is focused, never resized (§3), so the entry it
        // lands on takes the view that window shows now, here, before the
        // launch: a launch that stands down (a click before its `commit`)
        // must not leave the entry's older view for a reload to reopen.
        if ( open && enabled ) write('replaceState', here(), { ezilApp: link.id, ezilView: viewOf(open) });
        const ctx = {
            ...deps.launchContext(),
            ...routeLaunchContext(link, {
                hasWindow: !! open,
                recordedView: state?.ezilApp === link.id ? state.ezilView : undefined,
            }),
            historyMode: 'replace',
        };
        routes.set(ctx, { gen, held: gen });
        void deps.launch(link.id, ctx);
    }

    function onFocus (event) {
        // A gesture launch in flight has already pushed its entry (`begin`);
        // until it ends, a late focus of some other window must not
        // overwrite it — `end` puts the launched app back if one did. This
        // includes the new window's own focus, which UIWindow gives it while
        // it is built.
        if ( ! enabled || holds > 0 ) return;
        const el = event.detail?.window;
        const id = el?.getAttribute?.('data-app');
        if ( ! known(id) || el.getAttribute('data-closing') === '1' ) return;
        // A window whose launch has not settled, and a newer launch has
        // begun since: this is that launch's late focus, not the user's.
        if ( superseded(el) ) return;
        if ( currentApp() === id ) return;
        take();
        write('replaceState', urlFor(id), stateFor(id));
    }

    // The app now in front: the focused window, else the visible one focused
    // most recently. A close does not always move focus (upstream's
    // `window_stack` is never filled), and a window still on screen is what
    // the address bar should name.
    function frontApp () {
        const visible = [...win().document.querySelectorAll('.window[data-app]:not([data-closing="1"])')]
            .filter(el => known(el.getAttribute('data-app'))
                && ! ['1', 'true'].includes(el.getAttribute('data-is_minimized')) && el.style.display !== 'none');
        const front = visible.find(el => el.classList.contains('window-active'))
            // `focusWindow` stamps an increasing inline z-index on every focus.
            ?? visible.reduce((top, el) => (top && (Number.parseInt(top.style.zIndex, 10) || 0)
                > (Number.parseInt(el.style.zIndex, 10) || 0) ? top : el), null);
        return front?.getAttribute('data-app') ?? null;
    }

    function onClosed (event) {
        if ( ! enabled ) return;
        const closed = event.detail?.app;
        if ( known(closed) && ! liveWindow(closed) ) params.delete(closed);
        const next = frontApp();
        if ( currentApp() === next ) return;
        // The close of an app window that renames the entry takes it: a
        // launch still opening may not give back, over what this decides,
        // the URL it replaced (`end(null)`). Not a LAUNCH intent: a launch
        // whose window opens still names it. One that renames nothing takes
        // nothing.
        if ( known(closed) ) take();
        write('replaceState', urlFor(next), stateFor(next));
    }

    function onViewChanged (event) {
        const { appId, view } = event.detail ?? {};
        if ( ! enabled || ! VIEWS.has(view) || ! known(appId) || currentApp() !== appId ) return;
        write('replaceState', here(), { ezilApp: appId, ezilView: view });
    }

    return {
        get enabled () { return enabled; },

        /**
         * Bind once; a shell rebuild calls this again and only refreshes the
         * getters.
         * @param {{win: Window, payload: object, getApps: () => {id: string}[],
         *   launch: (id: string, ctx: object) => Promise<unknown>,
         *   launchContext: () => object}} options
         */
        install (options) {
            const first = deps === null;
            deps = options;
            enabled = ! OS_ONLY_PROVIDERS.has(options.payload?.desktopState?.provider);
            if ( ! first ) return;
            const search = new URLSearchParams(options.win.location.search);
            pageParams = PAGE_KEYS.filter(key => search.getAll(key).length === 1).map(key => [key, search.get(key)]);
            options.win.addEventListener('popstate', onPopState);
            options.win.addEventListener('ezil:window-focus', onFocus);
            options.win.addEventListener('ezil:window-closed', onClosed);
            options.win.addEventListener('ezil:app-view-changed', onViewChanged);
        },

        /**
         * The boot's own link: rewrite the alias to `/app/<id>` in place.
         * @param {{search?: string, route?: object}} [options] `search`: the
         *   query to keep, when the caller has already consumed some of it
         *   (the billing deep link). `route`: the ctx of the launch this
         *   adopts after (numbered by `route`); once a newer intent has taken
         *   the entry, this writes nothing.
         */
        adopt (link, { search, route } = {}) {
            if ( ! deps || ! link ) return;
            params.set(link.id, linkParams(link));
            // A click made while it opened took the entry (pushed, or
            // rewrote it): it is that click's now. One that wrote nothing (a
            // click on Settings itself) did not.
            if ( routes.has(route) && routes.get(route).held !== owner ) return;
            if ( enabled ) {
                write('replaceState', canonicalUrl(win().location, link, { search }), stateFor(link.id));
            } else if ( search !== undefined ) {
                write('replaceState', `${win().location.pathname}${search}${win().location.hash}`, {});
            }
        },

        /**
         * Number a route launch the boot starts itself (its link, the
         * billing link) as a LAUNCH intent, as `popstate` does a
         * Back/Forward's. It takes nothing yet: the entry is the boot's, and
         * its `commit` (and `adopt`, given it) canonicalise it, unless a
         * click, Back/Forward, close or focus after it has taken the entry.
         * @param {object} ctx the ctx it will pass to `registry.launch`
         * @returns {object} `ctx`
         */
        route (ctx) {
            if ( deps && ctx && typeof ctx === 'object' ) routes.set(ctx, { gen: launchGeneration = issued += 1, held: owner });
            return ctx;
        },

        /**
         * Drop one-shot query keys (the billing link's `upgrade`) from the
         * address bar, in place, BEFORE the launch they are for: whatever
         * happens to that launch, no entry keeps them for a reload to
         * replay. Every other pair is kept byte for byte. Takes nothing: the
         * entry names what it named. Also on an /os-only host (the path is
         * never rewritten).
         * @param {string[]} keys
         */
        consume (keys) {
            if ( ! deps ) return;
            const url = withoutKeys(win().location, keys);
            if ( url !== here() ) write('replaceState', url, {});
        },

        /**
         * Make the entry name the app in front, or `/os`: after a shell
         * rebuild, whose destroyed windows never reported closing.
         */
        sync () {
            if ( ! deps || ! enabled ) return;
            for ( const id of [...params.keys()] ) if ( ! liveWindow(id) ) params.delete(id);
            const next = frontApp();
            if ( currentApp() !== next ) write('replaceState', urlFor(next), stateFor(next));
        },

        /** The view this entry recorded for `id`, if any. */
        recordedView (id) {
            const state = deps ? win().history.state : null;
            return state?.ezilApp === id && VIEWS.has(state.ezilView) ? state.ezilView : undefined;
        },

        /**
         * A user's click is about to launch `id`: add its entry NOW, before
         * the window exists. 🔴 Not after: Chromium files a frame navigation
         * under the entry that was current when it STARTED, and the Code and
         * Browser windows start their iframes' navigations while they are
         * built — committing after a later push, they prune it (MEASURED:
         * `history.length` 3 -> 2, Back skipped the app). No entry is added
         * when the address bar already names `id`.
         *
         * Until `end(el)`, focus changes write nothing (the new window
         * focuses itself on the way). `end(null)` — the app did not open —
         * puts back the URL and state this replaced; the extra entry stays,
         * as a duplicate of the one before it.
         *
         * Out of order (docs/APP-ROUTES.md §5 "Order"): `end(el)` names the
         * app only while it is the newest launch (no newer click or
         * Back/Forward: its window is the one in front); `end(null)` gives
         * back only while it still holds the entry (no newer intent has
         * taken it, a close included) and is still the newest launch, and
         * the app's parameters only while no later launch has set them. A
         * launch that fails gives the address bar back to the intent it took
         * it from: an older launch still pending decides again, and one that
         * failed meanwhile gives it back in turn.
         * @returns {{end: (el: Element|null) => void}|null} null when this
         *   module will not write for `id` (an /os-only host, an unknown app).
         */
        begin (id, ctx = {}) {
            if ( ! deps || ! enabled || ! known(id) ) return null;
            const prior = { owner, launch: launchGeneration };
            const gen = launchGeneration = issued += 1;
            holds += 1;
            const before = { url: here(), state: win().history.state, params: params.get(id) };
            const pushed = currentApp() !== id;
            // A push, or a replace in place (the app's own parameters
            // changed), takes the entry. A click on the app the entry already
            // names, with the same parameters, writes nothing and takes
            // nothing: it holds the entry under the owner it found.
            if ( remember(id, ctx) || pushed ) {
                owner = gen;
                // A new entry records no view, unless the app is open already
                // (a click on its dock icon): then the one its window shows.
                write(pushed ? 'pushState' : 'replaceState', urlFor(id), pushed ? { ezilApp: id, ezilView: viewOf(liveWindow(id)) } : stateFor(id));
            }
            const held = owner;
            const mine = params.get(id);
            // As if this launch never happened: the URL and state it
            // replaced, the owner and the newest launch from before it. If
            // that launch failed meanwhile, it gives back too. The state goes
            // back with the view its app's window shows now: the user may
            // have changed it while this launch was pending.
            const giveBack = () => {
                if ( pushed ) win().history.replaceState(withView(before.state), '', before.url);
                ({ owner, launch: launchGeneration } = prior);
                const older = failed.get(launchGeneration);
                failed.delete(launchGeneration);
                older?.();
            };
            // Only while it still holds the entry and is still the newest
            // launch: a newer launch that took nothing (a click on the same
            // app, which shares this one's window and outcome) defers it,
            // and gives it back with its own.
            const mayGiveBack = () => owner === held && launchGeneration === gen;
            let ended = false;
            return {
                end (el) {
                    if ( ended ) return;
                    ended = true;
                    holds -= 1;
                    if ( el ) {
                        // Not for a window already gone again (closed, or
                        // destroyed by a rebuild while the launch was open).
                        if ( el.isConnected === false ) return;
                        settle(el, gen);
                        if ( gen === launchGeneration && currentApp() !== id ) write('replaceState', urlFor(id), stateFor(id));
                        return;
                    }
                    if ( params.get(id) === mine ) {
                        if ( before.params === undefined ) params.delete(id);
                        else params.set(id, before.params);
                    }
                    if ( mayGiveBack() ) giveBack();
                    else failed.set(gen, () => { if ( mayGiveBack() ) giveBack(); });
                },
            };
        },

        /**
         * The launch that opened `el` has settled (registry's `ensureOnTop`
         * has run): its focus events are the user's from now on.
         */
        settled (el) {
            if ( el && typeof el === 'object' ) settling.delete(el);
        },

        /**
         * `el`'s launch has not settled and a newer click or Back/Forward
         * has begun since. False for a window this module never saw launch
         * (an /os-only host marks nothing).
         */
        superseded (el) {
            return superseded(el);
        },

        /**
         * A ROUTE's launch (`historyMode` 'replace': the boot's link,
         * Back/Forward) resolved with a window: never adds an entry. The
         * entry's URL is kept as it is when it already names `id`, unless the
         * launch changed the app's own parameters. 'none' writes nothing,
         * and so does a numbered route launch (Back/Forward, `route`) once a
         * newer intent has taken the entry.
         * @param {Element} [el] the window it resolved with
         */
        commit (id, ctx = {}, el = null) {
            if ( ! deps || ! enabled || ctx.historyMode === 'none' || ! known(id) ) return;
            const route = routes.get(ctx);
            settle(el, route?.gen ?? launchGeneration);
            if ( route && route.held !== owner ) return;
            const changed = remember(id, ctx);
            const same = currentApp() === id;
            write('replaceState', same && ! changed ? here() : urlFor(id), stateFor(id));
        },
    };
}

// The bundle's one instance: `boot.js` installs it, `apps/registry.js`
// reports launches to it.
export default createAppHistory();
