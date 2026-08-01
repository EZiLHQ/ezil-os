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
// ── The one rule, and its one exception ─────────────────────────────────────
// 🔴 A HOSTED entry exists only if BOTH sides agree it can be launched today:
// this array (the client knows how to draw it) AND `payload.apps` (the server
// confirms it can actually serve it — `SHELL_APPS` in
// `app/src/server/shell/boot-payload.ts`). `resolve()` below intersects the
// two. An icon that opens nothing is worse than a missing icon, because the
// user spends their attention finding out.
//
// 🔴 The exception is `shell_local: true` — see `resolve()`. An app that runs
// ENTIRELY in this bundle has no server side to agree with: there is nothing
// the host could fail to provision, so gating it on a server list cannot
// prevent a broken icon, it can only produce a missing one. `desktop` is
// hosted (a Cloudflare container per computer) and stays gated exactly as
// before; `settings` and `preview` are shell-local.
//
// Wave 1 had exactly one entry: the streamed Linux desktop.
//
// MODIFIED BY EZIL 2026-08-01: added two entries. `settings` is the Settings
// window (`../ui/Settings/index.js`) — computer management, appearance, and
// the AGPL notice, now that login lands in the OS instead of on `/computers`
// first. `preview` is registered here (this file's job, per the brief: "T4
// writes the preview app file itself but does not own the registry") with a
// placeholder `open()` so THIS file's own build never depends on a sibling
// task's file existing yet — see `PREVIEW_PLACEHOLDER_NOTE` below for why,
// and `PUTER-PROVENANCE.md` / the wave-a-t3 report for the full account.
//
// MODIFIED BY EZIL 2026-08-01 (round 2): both new entries are `shell_local`,
// and `launch()` now puts a Settings button in the control drawer of any
// window that declares `wants_settings_in_drawer`. Both changes exist for the
// same reason — round 1 built a Settings window that no real boot could
// reach. See the two 🔴 blocks below and `../ui/Settings/drawer-action.js`.

import { openDesktopWindow } from './desktop-window.js';
import { openPreviewWindow } from './preview.js';
import { openSettingsWindow } from '../ui/Settings/index.js';
import { ensureSettingsDrawerButton, SETTINGS_DRAWER_SVG } from '../ui/Settings/drawer-action.js';

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

/** Preview's icon — the same construction and the same reasoning as the two above. */
const PREVIEW_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
    + '<defs><linearGradient id="gp" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#1f4d50"/><stop offset="1" stop-color="#12292b"/>'
    + '</linearGradient></defs>'
    + '<rect width="48" height="48" rx="11" fill="url(#gp)"/>'
    + '<rect x="10" y="11" width="28" height="26" rx="3" fill="none" stroke="#00adb5" stroke-width="2.4"/>'
    + '<path d="M10 18h28" fill="none" stroke="#00adb5" stroke-width="2.4"/>'
    + '<circle cx="14.5" cy="14.5" r="1.3" fill="#00adb5"/>'
    + '<circle cx="19" cy="14.5" r="1.3" fill="#00adb5"/>'
    + '</svg>',
);

/**
 * @typedef {object} AppDescriptor
 * @property {string} id             Matches `data-app` on the window and the taskbar item.
 * @property {string} name           User-facing. Shown in the taskbar tooltip and the drawer.
 * @property {string} icon           An `<img src>` value, ready to use.
 * @property {boolean} pinned        Sits in the taskbar whether or not it is open.
 * @property {boolean} single_instance  A second launch focuses the first window.
 * @property {boolean} [shell_local] Runs entirely in this bundle; `resolve()`
 *   does not require the server to list it. See "The one rule, and its one
 *   exception" at the top of this file.
 * @property {boolean} [wants_settings_in_drawer] This app's window carries an
 *   `attach_app_drawer` control tray and goes full-bleed, so the tray must
 *   carry a Settings button. See `../ui/Settings/drawer-action.js`.
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
        // Hosted: a Cloudflare container has to exist for this to open, so it
        // stays on the server side of the two-sided handshake.
        shell_local: false,
        // 🔴 This is the app that hides the taskbar. Its tray must carry the
        // way back to Settings — see ../ui/Settings/drawer-action.js.
        wants_settings_in_drawer: true,
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
        // 🔴 Shell-local, and this flag is the whole reason Settings is
        // reachable at all. `SHELL_APPS` in
        // `app/src/server/shell/boot-payload.ts` is
        // `[{ id: 'desktop', ... }]` — an explicit, non-empty list, so
        // `resolve()`'s intersection is authoritative and used to drop
        // `settings` out of EVERY real boot. OBSERVED in round 1: a complete,
        // building, passing Settings window that no `/os` page could ever
        // show. Settings has no server side to provision — it is this
        // bundle's own DOM over `/api/trpc`, which already exists — so
        // requiring the server to announce it was never the right rule for
        // it. Adding `settings` to `SHELL_APPS` would ALSO fix it and is
        // strictly redundant with this; that file is not owned by this task,
        // and this flag makes the shell correct without it.
        shell_local: true,
        open: openSettingsWindow,
    },
    {
        id: 'preview',
        name: 'Preview',
        // Was `SETTINGS_ICON` — a placeholder entry inherited the gear, so
        // Start listed two identical icons with different names.
        icon: PREVIEW_ICON,
        // Not pinned: the dock is for the two things a session is built
        // around. `boot.js`'s Start menu lists every resolved app regardless
        // of `pinned`, so this is reachable in one click from there —
        // verified by `preview-test.mjs`, because "reachable" is exactly the
        // kind of claim that turns out to be false.
        pinned: false,
        single_instance: true,
        // 🔴 Shell-local, and it has to stay that way for this to be
        // reachable at all. `SHELL_APPS` in
        // `app/src/server/shell/boot-payload.ts` is `[{id:'desktop'}]`, an
        // explicit non-empty list, so `resolve()`'s intersection would
        // otherwise drop `preview` out of every real boot — the exact defect
        // the Settings task found on itself. The window IS backed by a host
        // route (`/api/shell/preview-url`), but that route is not a
        // PROVISIONED CAPABILITY the server could fail to offer for one user
        // and not another; when it cannot serve a preview the window says so
        // (`show_unavailable()`). A missing icon cannot say anything.
        shell_local: true,
        // 🔴 The real window, at last. This entry pointed at a
        // `openPreviewPlaceholder` stub ("Preview is not built yet in this
        // deployment") for the whole of Wave A, because the file it needed
        // was being written in a sibling worktree and a static import would
        // not have resolved. Both files are in this tree now, so the import
        // is real and the stub is gone.
        open: openPreviewWindow,
    },
];

/**
 * The `{id,label,svg,onClick}` shape `attach_app_drawer`'s `actions` array
 * expects (`../ui/app-drawer.js`).
 *
 * 🔴 NOT the mechanism the guarantee rests on — `launch()` below injects the
 * button directly, because the `actions` array literal lives in
 * `desktop-window.js`, outside this task's owned paths, and a change there
 * would be discarded at merge. This export is the CLEAN seam for whoever does
 * own that file: dropping `settingsDrawerAction(ctx)` into its `actions`
 * array makes the declarative path the real one, and
 * `ensureSettingsDrawerButton` detects the button already present and stands
 * down. Neither path can produce two buttons.
 *
 * @param {object} ctx Passed through to `launch('settings', ctx)` unchanged.
 * @returns {{id: string, label: string, svg: string, onClick: () => void}}
 */
export function settingsDrawerAction (ctx = {}) {
    return {
        id: 'settings',
        label: 'Settings',
        svg: SETTINGS_DRAWER_SVG,
        onClick: () => { void launch('settings', ctx); },
    };
}

/** @param {string} id @returns {AppDescriptor|undefined} */
export function getApp (id) {
    return APPS.find(a => a.id === id);
}

/**
 * The apps this boot may actually show: every shell-local app, plus the
 * intersection of the HOSTED apps this file knows how to draw with the ones
 * the server said it can serve.
 *
 * A payload with no `apps` array at all is treated as "the server did not
 * say", and we fall back to the full list rather than rendering an empty
 * taskbar — an older/rehydrated payload should degrade to the previous
 * behaviour, not to a shell with nothing in it. A payload that DOES carry an
 * `apps` array is authoritative about HOSTED apps, including when it is empty.
 *
 * 🔴 Order is preserved from `APPS`, which `boot.js` depends on: it opens
 * `apps[0]` as the one window of the boot. `desktop` is first in `APPS` and
 * so stays first here whenever it is served — adding shell-local entries
 * cannot change which window a normal boot opens. (If `desktop` is NOT served,
 * the boot now opens Settings instead of nothing at all, which is the right
 * answer: the user's next move is to look at their computers.)
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
    const allowed = APPS.filter(a => a.shell_local === true || ids.has(a.id));

    // Say so, loudly, in both directions. Either mismatch is a real bug in a
    // two-sided registry and neither is visible from the UI: a client-only
    // app is a button that fails, a server-only app is a capability nobody
    // can reach. Shell-local apps are excluded from the first check by
    // definition — the server is not expected to know about them.
    for ( const a of APPS ) {
        if ( a.shell_local !== true && ! ids.has(a.id) ) {
            console.warn(`[${PHASE}] "${a.id}" is not served by this deployment; hiding it`);
        }
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
            const el_existing = $existing.get(0);
            // Belt and braces: the first open already did this, but a window
            // that somehow lost its button (a re-attached drawer, a rebuild)
            // must not stay without one. Idempotent — see drawer-action.js.
            if ( app.wants_settings_in_drawer && el_existing ) {
                ensureSettingsDrawerButton(
                    el_existing,
                    () => { void launch('settings', ctx); },
                    { expected: true },
                );
            }
            return el_existing;
        }
    }

    try {
        // The descriptor's own icon travels with the launch, so the window
        // head, the taskbar item and the control tray cannot show a different
        // image from the dock tile the user just clicked.
        const el_window = await app.open({ ...ctx, icon: app.icon, appName: app.name });

        // 🔴 Stamp WHICH computer this window is for, on the window itself.
        //
        // Settings has to know whether the open desktop window is streaming
        // the computer the user just asked to delete — get that wrong and
        // either the user watches their OS die mid-frame (deleted without
        // closing) or an unrelated desktop is closed out from under them.
        // Round 1 answered it from a module-level variable seeded at IMPORT
        // time from `session.payload()`, which is empty on the rehydrate path
        // and stale after any switch; the end-to-end harness caught the
        // guarantee silently not firing because of it
        // (`../ui/Settings/settings-test.mjs`).
        //
        // The window element is the honest place for it: it is created and
        // destroyed with the thing it describes, it survives module state
        // being wrong, and it is readable by anything that can see the DOM.
        // Written here rather than in `desktop-window.js` because that file is
        // not owned by this task — and here is strictly better anyway, since
        // `launch` is the one place that knows both the app and the ctx.
        if ( el_window && ctx?.computer?.id ) {
            el_window.setAttribute('data-ezil-computer-id', String(ctx.computer.id));
        }

        // 🔴 GUARANTEE #1. A window that hides the taskbar must carry its own
        // way back to Settings, or deleting a broken computer becomes
        // unreachable. Done HERE, after `open` resolves, because that is the
        // first moment inside an owned file at which the drawer provably
        // exists: `openDesktopWindow` attaches it synchronously
        // (`desktop-window.js:474`) and returns at :523 with no `await`
        // between the two. `ensureSettingsDrawerButton` is idempotent, so the
        // "already open, just refocus" path above and a later rebuild both
        // no-op. See `../ui/Settings/drawer-action.js` for why this is an
        // injection rather than one line in that file's `actions` array.
        if ( app.wants_settings_in_drawer && el_window ) {
            ensureSettingsDrawerButton(
                el_window,
                () => { void launch('settings', ctx); },
                { expected: true },
            );
        }

        return el_window;
    } catch ( err ) {
        // A throwing `open` must not leave the caller (a taskbar click, a
        // Start press) believing something is on its way.
        console.error(`[${PHASE}] "${id}" failed to open`, err);
        return null;
    }
}

export default { APPS, getApp, resolve, launch, settingsDrawerAction };
