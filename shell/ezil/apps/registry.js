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
//
// MODIFIED BY EZIL 2026-08-01: added two entries. `settings` is the Settings
// window (`../ui/Settings/index.js`) — computer management, appearance, and
// the AGPL notice, now that login lands in the OS instead of on `/computers`
// first. `preview` is registered here (this file's job, per the brief: "T4
// writes the preview app file itself but does not own the registry") with a
// placeholder `open()` so THIS file's own build never depends on a sibling
// task's file existing yet — see `PREVIEW_PLACEHOLDER_NOTE` below for why,
// and `PUTER-PROVENANCE.md` / the wave-a-t3 report for the full account.
// Also exports `settingsDrawerAction()`: the full-bleed desktop window's
// control drawer (`apps/desktop-window.js`, not owned by this task) needs a
// Settings button so a user whose only desktop is stuck full-bleed can still
// reach delete — this is the ready-to-consume action descriptor for that
// drawer's `actions` array. Wiring it in is one line in a file this task
// does not own; see that file's own comment ("Settings drops in here in a
// later wave") and this task's report.

import { openDesktopWindow } from './desktop-window.js';
import { openSettingsWindow } from '../ui/Settings/index.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:apps';

/**
 * The Desktop app's icon. EZiL-authored, inline, and NOT a `window.icons`
 * lookup, for two reasons:
 *
 *   1. There is no icon in the ported set that means "your Linux computer".
 *      The nearest, `app.svg`, is a manila folder — OBSERVED in Chromium
 *      rendering as a folder in both the dock and the control tray, which
 *      reads as "a place to put files", the one thing this app is not.
 *   2. `shell/src/icons/` is the Puter-DERIVED tree, enumerated file by file
 *      in PUTER-PROVENANCE.md, and `build-shell.sh` globs exactly that
 *      directory. Dropping an EZiL-authored SVG into it would put unattributed
 *      work inside the attribution record; changing the build's glob to add a
 *      second directory is a bigger change than the icon is worth.
 *
 * A data URI in the descriptor sidesteps both. `UITaskbarItem` and
 * `attach_app_drawer` each take a raw `src` string, so nothing else changes.
 * URI-encoded rather than base64 so it stays readable in a diff.
 */
const DESKTOP_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
    + '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#1f4d50"/><stop offset="1" stop-color="#12292b"/>'
    + '</linearGradient></defs>'
    + '<rect width="48" height="48" rx="11" fill="url(#g)"/>'
    + '<rect x="9.5" y="12.5" width="29" height="19" rx="2.5" fill="none" stroke="#00adb5" stroke-width="2.4"/>'
    + '<path d="M19 37h10M24 31.5V37" fill="none" stroke="#00adb5" stroke-width="2.4" stroke-linecap="round"/>'
    + '</svg>',
);

/** Settings' icon. Same construction as `DESKTOP_ICON` above and for the
 * same two reasons (no suitable icon in the ported `src/icons/` set; a data
 * URI sidesteps touching that Puter-derived, provenance-tracked directory). */
const SETTINGS_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
    + '<defs><linearGradient id="gs" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#1f4d50"/><stop offset="1" stop-color="#12292b"/>'
    + '</linearGradient></defs>'
    + '<rect width="48" height="48" rx="11" fill="url(#gs)"/>'
    + '<circle cx="24" cy="24" r="6.5" fill="none" stroke="#00adb5" stroke-width="2.4"/>'
    + '<path d="M24 13.5v3.2M24 31.3v3.2M34.5 24h-3.2M16.7 24h-3.2'
    + 'M31.3 16.7l-2.3 2.3M19 28.7l-2.3 2.3M31.3 31.3l-2.3-2.3M19 19.3l-2.3-2.3"'
    + ' fill="none" stroke="#00adb5" stroke-width="2.4" stroke-linecap="round"/>'
    + '</svg>',
);

/**
 * 🔴 PREVIEW_PLACEHOLDER_NOTE — read before replacing this.
 *
 * The brief for this task ("wave-a/t3-shell-settings") says to register a
 * Preview entry here because "T4 writes the preview app file itself but
 * does not own the registry" — i.e. this file's job is to add the entry,
 * a DIFFERENT task's job is to write what it opens. At the time this was
 * written, no such file exists yet anywhere under `shell/` (checked: no
 * `*preview*` path in this tree). Waves run in separate git worktrees off
 * the same base commit, so T4's file living in ITS worktree does not make
 * it exist in THIS one — importing it statically here (`import { x } from
 * './preview-window.js'`) would make esbuild fail to resolve it and break
 * this task's own build, for a task this one does not control the timing
 * of.
 *
 * So this stays a self-contained placeholder — a real, working window, not
 * a silent no-op — until whoever lands the real Preview app replaces the
 * body of `open` below with an import of it. That is a one-line change
 * here, in a file this task DOES own, so it is not blocked on anyone.
 */
async function openPreviewPlaceholder (ctx = {}) {
    return UIWindow({
        title: 'Preview',
        app: 'preview',
        icon: ctx.icon,
        body_content: '<div style="padding:24px;color:#b9b9b7;font:13px sans-serif;">'
            + 'Preview is not built yet in this deployment.</div>',
        width: 420,
        height: 220,
        is_resizable: true,
        single_instance: true,
        show_in_taskbar: true,
        window_class: 'ezil-preview-window',
    });
}

/**
 * @typedef {object} AppDescriptor
 * @property {string} id             Matches `data-app` on the window and the taskbar item.
 * @property {string} name           User-facing. Shown in the taskbar tooltip and the drawer.
 * @property {string} icon           An `<img src>` value, ready to use.
 * @property {boolean} pinned        Sits in the taskbar whether or not it is open.
 * @property {boolean} single_instance  A second launch focuses the first window.
 * @property {(ctx: object) => Promise<HTMLElement|null>} open
 */

/** @type {readonly AppDescriptor[]} */
export const APPS = [
    {
        id: 'desktop',
        name: 'Linux Desktop',
        icon: DESKTOP_ICON,
        pinned: true,
        // 🔴 Two windows competing for one cold container is the worst
        // possible first run: both show a boot spinner, one of them is lying,
        // and the user cannot tell which. Enforced in `launch()` below AND
        // again by `UIWindow`'s own `single_instance` option, because the
        // guard has to hold even if something opens the window directly.
        single_instance: true,
        open: openDesktopWindow,
    },
    {
        id: 'settings',
        name: 'Settings',
        icon: SETTINGS_ICON,
        // Pinned so it survives its window being closed and stays reachable
        // from the taskbar without depending on anyone remembering to open
        // it once — the same reasoning `desktop` already gets. This is the
        // ONLY escape hatch from the 2-computer cap while the taskbar is
        // visible; see `settingsDrawerAction()` below for the full-bleed case.
        pinned: true,
        single_instance: true,
        open: openSettingsWindow,
    },
    {
        id: 'preview',
        name: 'Preview',
        icon: SETTINGS_ICON,
        pinned: false,
        single_instance: true,
        // See PREVIEW_PLACEHOLDER_NOTE above — replace this, not the entry.
        open: openPreviewPlaceholder,
    },
];

/**
 * The `{id,label,svg,onClick}` shape `attach_app_drawer`'s `actions` array
 * expects (`../ui/app-drawer.js`) — built here, not in `desktop-window.js`,
 * because that file is outside this task's ownership. See
 * `PREVIEW_PLACEHOLDER_NOTE`'s sibling note above `SETTINGS_ICON` and this
 * task's report for why the actual wiring (one line inside
 * `desktop-window.js`'s `actions: [...]`) is not done here.
 *
 * @param {object} ctx Passed through to `launch('settings', ctx)` unchanged.
 * @returns {{id: string, label: string, svg: string, onClick: () => void}}
 */
export function settingsDrawerAction (ctx = {}) {
    return {
        id: 'settings',
        label: 'Settings',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
            + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>'
            + '</svg>',
        onClick: () => { void launch('settings', ctx); },
    };
}

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
        // The descriptor's own icon travels with the launch, so the window
        // head, the taskbar item and the control tray cannot show a different
        // image from the dock tile the user just clicked.
        return await app.open({ ...ctx, icon: app.icon, appName: app.name });
    } catch ( err ) {
        // A throwing `open` must not leave the caller (a taskbar click, a
        // Start press) believing something is on its way.
        console.error(`[${PHASE}] "${id}" failed to open`, err);
        return null;
    }
}

export default { APPS, getApp, resolve, launch, settingsDrawerAction };
