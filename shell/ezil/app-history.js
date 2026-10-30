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
//     It NEVER closes a window, stops a computer or deletes state.
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

    const win = () => deps.win;
    const apps = () => deps.getApps() ?? [];
    const known = id => typeof id === 'string' && apps().some(app => app.id === id);
    const currentApp = () => parseAppLink(win().location, apps())?.id ?? null;
    const here = () => `${win().location.pathname}${win().location.search}${win().location.hash}`;
    const urlFor = id => (id ? appUrl(id, [...Object.entries(params.get(id) ?? {}), ...pageParams])
        : `${OS_PATH}${query(pageParams)}`);
    // `ezilView` describes the entry's app; it does not survive a change of app.
    const stateFor = id => ({ ezilApp: id ?? undefined,
        ...(win().history.state?.ezilApp === id ? {} : { ezilView: undefined }) });
    const write = (method, url, patch) => {
        win().history[method](mergeHistoryState(win().history.state, patch), '', url);
    };
    const liveWindow = id => win().document.querySelector(`.window[data-app="${id}"]:not([data-closing="1"])`);
    // Record what this launch says about the app's own URL parameters:
    // Settings' tab always follows the launch (it reopens at Account without
    // one), Code's project only when one is given. True if they changed.
    const remember = (id, ctx) => {
        const before = JSON.stringify(params.get(id) ?? {});
        if ( id === 'settings' ) params.set(id, ctx.initialTab ? { tab: ctx.initialTab } : {});
        else if ( ctx.project ) params.set(id, linkParams({ id, project: ctx.project }));
        else if ( ! params.has(id) ) params.set(id, {});
        return JSON.stringify(params.get(id)) !== before;
    };

    function onPopState () {
        const link = parseAppLink(win().location, apps());
        if ( ! link ) return;
        params.set(link.id, linkParams(link));
        const state = win().history.state;
        void deps.launch(link.id, {
            ...deps.launchContext(),
            ...routeLaunchContext(link, {
                hasWindow: !! liveWindow(link.id),
                recordedView: state?.ezilApp === link.id ? state.ezilView : undefined,
            }),
            historyMode: 'replace',
        });
    }

    function onFocus (event) {
        // A gesture launch in flight has already pushed its entry (`begin`);
        // until it ends, a late focus of some other window must not
        // overwrite it — `end` puts the launched app back if one did.
        if ( ! enabled || holds > 0 ) return;
        const el = event.detail?.window;
        const id = el?.getAttribute?.('data-app');
        if ( ! known(id) || el.getAttribute('data-closing') === '1' ) return;
        if ( currentApp() === id ) return;
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
         * @param {{search?: string}} [options] the query to keep, when the
         *   caller has already consumed some of it (the billing deep link).
         */
        adopt (link, { search } = {}) {
            if ( ! deps || ! link ) return;
            params.set(link.id, linkParams(link));
            if ( enabled ) {
                write('replaceState', canonicalUrl(win().location, link, { search }), stateFor(link.id));
            } else if ( search !== undefined ) {
                write('replaceState', `${win().location.pathname}${search}${win().location.hash}`, {});
            }
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
         * @returns {{end: (el: Element|null) => void}|null} null when this
         *   module will not write for `id` (an /os-only host, an unknown app).
         */
        begin (id, ctx = {}) {
            if ( ! deps || ! enabled || ! known(id) ) return null;
            holds += 1;
            const before = { url: here(), state: win().history.state, params: params.get(id) };
            const pushed = currentApp() !== id;
            if ( remember(id, ctx) || pushed ) {
                write(pushed ? 'pushState' : 'replaceState', urlFor(id), pushed ? { ezilApp: id, ezilView: undefined } : stateFor(id));
            }
            let ended = false;
            return {
                end (el) {
                    if ( ended ) return;
                    ended = true;
                    holds -= 1;
                    if ( el ) {
                        // Not for a window already gone again (closed, or
                        // destroyed by a rebuild while the launch was open).
                        if ( el.isConnected !== false && currentApp() !== id ) write('replaceState', urlFor(id), stateFor(id));
                        return;
                    }
                    if ( before.params === undefined ) params.delete(id);
                    else params.set(id, before.params);
                    if ( pushed ) win().history.replaceState(before.state, '', before.url);
                },
            };
        },

        /**
         * A ROUTE's launch (`historyMode` 'replace': the boot's link,
         * Back/Forward) resolved with a window: never adds an entry. The
         * entry's URL is kept as it is when it already names `id`, unless the
         * launch changed the app's own parameters. 'none' writes nothing.
         */
        commit (id, ctx = {}) {
            if ( ! deps || ! enabled || ctx.historyMode === 'none' || ! known(id) ) return;
            const changed = remember(id, ctx);
            const same = currentApp() === id;
            write('replaceState', same && ! changed ? here() : urlFor(id), stateFor(id));
        },
    };
}

// The bundle's one instance: `boot.js` installs it, `apps/registry.js`
// reports launches to it.
export default createAppHistory();
