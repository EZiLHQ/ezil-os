// registry.js — EZiL-authored. Not Puter code.
//
// What the shell is allowed to open, and how.
//
// ── What this replaces ──────────────────────────────────────────────────────
// Upstream Puter's `helpers/launch_app.js` is 805 lines. Almost none of it is
// about launching anything: it resolves an app name against `puter.apps` over
// the network, mints a per-instance auth token from `puter.auth`, opens an
// `IPC.js` message channel so the app can call the cloud filesystem back
// through the parent frame, registers the instance in a service registry, and
// deals with app-to-app parenting and deep links. Every one of those is the
// cloud backend this fork removed, so `launch_app` resolves to the rejecting
// stub in `../../src/ezil-stubs.js` and this file is what the shell uses
// instead.
//
// It is a static array because that is the honest shape. EZiL's shell has no
// app store to query and no remote manifest to fetch: the set of things it can
// open is fixed at build time, and pretending otherwise would mean a network
// round trip whose answer never changes.
//
// ── The one rule ────────────────────────────────────────────────────────────
// 🔴 An entry exists only if BOTH sides agree it can be launched today:
// this array (the client knows how to draw it) AND `payload.apps` (the server
// confirms it can actually serve it — `SHELL_APPS` in
// `app/src/server/shell/boot-payload.ts`). `resolve()` below intersects the
// two. An icon that opens nothing is worse than a missing icon, because the
// user spends their attention finding out.
//
// Wave 1 therefore has exactly one entry: the streamed Linux desktop.

import { openDesktopWindow } from './desktop-window.js';

const PHASE = 'ezil-os:apps';

/**
 * @typedef {object} AppDescriptor
 * @property {string} id             Matches `data-app` on the window and the taskbar item.
 * @property {string} name           User-facing. Shown in the taskbar tooltip and the drawer.
 * @property {string} icon           Key into `window.icons` (see build-shell.sh's icons.js).
 * @property {boolean} pinned        Sits in the taskbar whether or not it is open.
 * @property {boolean} single_instance  A second launch focuses the first window.
 * @property {(ctx: object) => Promise<HTMLElement|null>} open
 */

/** @type {readonly AppDescriptor[]} */
export const APPS = [
    {
        id: 'desktop',
        name: 'Linux Desktop',
        // 'app.svg' rather than a bespoke desktop glyph: the icon set is the
        // 21 files ported from upstream, and inventing a 22nd here would mean
        // an icon in the bundle with no provenance line.
        icon: 'app.svg',
        pinned: true,
        // 🔴 Two windows competing for one cold container is the worst
        // possible first run: both show a boot spinner, one of them is lying,
        // and the user cannot tell which. Enforced in `launch()` below AND
        // again by `UIWindow`'s own `single_instance` option, because the
        // guard has to hold even if something opens the window directly.
        single_instance: true,
        open: openDesktopWindow,
    },
];

/** @param {string} id @returns {AppDescriptor|undefined} */
export function getApp (id) {
    return APPS.find(a => a.id === id);
}

/**
 * The apps this boot may actually show: the intersection of what this file
 * knows how to draw and what the server said it can serve.
 *
 * A payload with no `apps` array at all is treated as "the server did not
 * say", and we fall back to the full list rather than rendering an empty
 * taskbar — an older/rehydrated payload should degrade to the previous
 * behaviour, not to a shell with nothing in it. A payload that DOES carry an
 * `apps` array is authoritative, including when it is empty.
 *
 * @param {object|null} payload `window.__EZIL_BOOT__`
 * @returns {AppDescriptor[]}
 */
export function resolve (payload) {
    const served = payload?.apps;
    if ( ! Array.isArray(served) ) {
        console.warn(`[${PHASE}] boot payload carried no app list; showing all known apps`);
        return [...APPS];
    }

    const ids = new Set(served.map(a => a?.id).filter(Boolean));
    const allowed = APPS.filter(a => ids.has(a.id));

    // Say so, loudly, in both directions. Either mismatch is a real bug in a
    // two-sided registry and neither is visible from the UI: a client-only
    // app is a button that fails, a server-only app is a capability nobody
    // can reach.
    for ( const a of APPS ) {
        if ( ! ids.has(a.id) ) console.warn(`[${PHASE}] "${a.id}" is not served by this deployment; hiding it`);
    }
    for ( const id of ids ) {
        if ( ! getApp(id) ) console.warn(`[${PHASE}] server offers "${id}" but this shell cannot open it`);
    }
    return allowed;
}

/**
 * Open an app, or bring its existing window forward.
 *
 * @param {string} id
 * @param {object} ctx Passed through to the descriptor's `open`. Carries the
 *   boot payload (`payload`, `computer`, `desktopState`).
 * @returns {Promise<HTMLElement|null>} the window element, or null if nothing opened.
 */
export async function launch (id, ctx = {}) {
    const app = getApp(id);
    if ( ! app ) {
        console.error(`[${PHASE}] no such app: ${id}`);
        return null;
    }

    if ( app.single_instance ) {
        const $existing = $(`.window[data-app="${id}"]`);
        if ( $existing.length > 0 ) {
            // Already open. It may be minimised, buried, or right there — all
            // three want the same thing, and `showWindow` on a visible window
            // is harmless.
            console.info(`[${PHASE}] "${id}" is already open; restoring it`);
            $existing.showWindow();
            return $existing.get(0);
        }
    }

    try {
        return await app.open(ctx);
    } catch ( err ) {
        // A throwing `open` must not leave the caller (a taskbar click, a
        // Start press) believing something is on its way.
        console.error(`[${PHASE}] "${id}" failed to open`, err);
        return null;
    }
}

export default { APPS, getApp, resolve, launch };
