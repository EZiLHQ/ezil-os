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
// Wave 1 had exactly one entry: the streamed Linux desktop (user-facing name
// "Browser" as of 2026-08-03 — see that entry's own comment below).
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
//
// MODIFIED BY EZIL 2026-08-01 (Wave B / T7): added `code` — the Code window
// (`../apps/code.js`), the icon the whole "code-server replaced Electron VS
// Code" migration had been missing an entry point for. Same shape as
// `preview`: `shell_local: true` for the identical reason (a real host route
// backs it, `/api/shell/code-preview-url`, but it is not a provisioned
// capability the server could offer to one user and not another — the window
// itself says so honestly when it cannot serve one).

import { openDesktopWindow } from './desktop-window.js';
import { openPreviewWindow } from './preview.js';
import { openCodeWindow } from './code.js';
import { openSettingsWindow } from '../ui/Settings/index.js';
import { ensureSettingsDrawerButton, SETTINGS_DRAWER_SVG } from '../ui/Settings/drawer-action.js';
import telemetry from '../telemetry.js';
import { beginTrace } from '../trace.js';
import log from '../log.js';

const PHASE = 'ezil-os:apps';

/**
 * How long `launch()` will wait for an `owns_boot_trace` app to end its OWN
 * trace before giving up on it and closing the trace out itself — never
 * silently, and never as `'ok'`.
 *
 * 🔴 A FORGETFUL APP MUST NOT LEAK A NEVER-ENDED TRACE. Without this, a bug in
 * `desktop-window.js`/`preview.js`/`code.js` that reaches neither a `ready`
 * nor a `failed`/`unavailable` branch (an uncaught throw inside `start_boot`,
 * a code path this file's own review missed) would produce NO `boot_summary`
 * for that open at all — worse than the original defect, which at least
 * always emitted a (wrong) row.
 *
 * 🔴 The fallback closes the trace as `'error'`, not a fourth `'unknown'`
 * value — `OUTCOMES` (`app/src/server/telemetry/types.ts`, mirrored in
 * `worker/src/observability.ts`) is a closed 3-value wire enum (`ok`/`error`/
 * `skipped`), owned by neither this task nor this tree, and a value outside
 * it is exactly the kind of "the client invents its own vocabulary" defect
 * this whole telemetry effort exists to avoid. `'error'` is also the
 * semantically honest choice: whatever happened, it was not a confirmed
 * success. What DOES distinguish a real, fast `mint_error`/`confirm_error`
 * from "this app never called back" is `attrs.phases` itself — a fallback
 * closure carries only the registry's OWN bookkeeping steps
 * (`launch_start`, `open_resolved`, …) with none of the app's own
 * `mint_*`/`confirm_*`/`display_*` breadcrumbs after them, because the app
 * never got that far.
 *
 * The value has to clear every EXPLICIT end path this file's owned apps
 * exercise on a slow-but-real boot, or a healthy slow boot would get its
 * trace closed out from under it before it ever reaches its own terminal
 * state. The longest such path is `desktop-window.js`'s own mint budget
 * (`DESKTOP_BOOT_TIMEOUT_MS`, `session.js` — 215s) — a mint that itself times
 * out ends the trace immediately as `'error'` on its own, so it never reaches
 * this fallback; this value only needs enough headroom OVER that figure to be
 * "generous", not to reconstruct every deadline in every owned file by hand.
 */
export const TRACE_FALLBACK_TIMEOUT_MS = 240_000;

/**
 * ════════════════════════════════════════════════════════════════════════════
 * THE APP ICONS
 * ════════════════════════════════════════════════════════════════════════════
 * EZiL-authored, inline data URIs, and NOT `window.icons` lookups, for two
 * reasons that have not changed since Wave 1:
 *
 *   1. There is nothing in the ported set that means any of these things. The
 *      nearest, `app.svg`, is a manila folder — OBSERVED in Chromium rendering
 *      as a folder in both the dock and the control tray, which reads as "a
 *      place to put files", the one thing none of these apps is.
 *   2. `shell/src/icons/` is the Puter-DERIVED tree, enumerated file by file in
 *      PUTER-PROVENANCE.md, and `build-shell.sh` globs exactly that directory.
 *      Dropping EZiL-authored SVGs into it would put unattributed work inside
 *      the attribution record; changing the build's glob to add a second
 *      directory is a bigger change than the icons are worth.
 *
 * `UITaskbarItem` and `attach_app_drawer` each take a raw `src` string, so a
 * data URI costs nothing anywhere else. URI-encoded rather than base64 so the
 * artwork stays readable in a diff.
 *
 * ── MODIFIED BY EZIL 2026-08-08: redrawn, and built by a shared function ────
 * The first version was four hand-written strings that each drew a teal
 * line-art glyph on the SAME near-black teal tile (`#1f4d50` -> `#12292b`).
 * OBSERVED in Chromium at the size a dock tile is actually rendered — 30x30,
 * after `style.css`'s `.taskbar .taskbar-icon img { padding: 5px }` eats 5px a
 * side out of the 40px item — two things were wrong with that:
 *
 *   - The tiles were nearly the same colour as the dock they sit on
 *     (`--taskbar-*` resolves to a dark translucent bar over a dark desktop),
 *     so the icons read as faint smudges rather than as objects. The Start
 *     button, which is Puter's own light `start.svg`, dominated the dock.
 *   - All four tiles being one colour meant the ONLY thing distinguishing four
 *     apps was a thin 2.4px-stroke glyph shrunk to 30px. "Browser" (a monitor)
 *     and "Preview" (a window with a titlebar) were, at that size, the same
 *     small rounded rectangle.
 *
 * So the tiles now carry the distinction — a different hue each, the way a
 * real dock does — and the glyphs are white and heavy enough to survive the
 * downscale. What makes them a SET rather than four unrelated pictures is that
 * every one is generated by `appIcon()` below from the same squircle, the same
 * gradient direction, the same top highlight and the same glyph weight. That
 * is deliberate: a shared visual language enforced by a shared function cannot
 * drift the way four copy-pasted strings did.
 *
 * 🔴 These are FUNCTIONAL app glyphs — a globe, a cog, `</>`, an eye. None of
 * them is, and none of them may become, an EZiL brand mark. This repo has no
 * logo and inventing one is not this file's job.
 */

/** The brand off-white, `--color-offwhite`. Every glyph, so they read as a set. */
const GLYPH = '#f5f5f4';

/**
 * Build one dock icon.
 *
 * One squircle, one vertical gradient, one hairline top highlight for the
 * "lit from above" read every desktop icon set uses, and one white glyph. The
 * only per-app inputs are the two gradient stops and the glyph's own paths.
 *
 * @param {string} id    Unique gradient id. Data-URI images are isolated
 *   documents so collisions could not actually happen, but a duplicate id in
 *   the source is a copy-paste tell and this keeps them honest.
 * @param {string} from  Gradient top stop.
 * @param {string} to    Gradient bottom stop.
 * @param {string} glyph SVG markup drawn over the tile, in a 48x48 viewBox.
 *   Stroked glyphs should use `stroke-width` 3-3.6: MEASURED, anything under
 *   ~2.8 disappears at the 30px the dock actually renders.
 * @returns {string} An `<img src>`-ready data URI.
 */
function appIcon (id, from, to, glyph) {
    return 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
        + `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>`
        + '</linearGradient></defs>'
        + `<rect width="48" height="48" rx="11.5" fill="url(#${id})"/>`
        // The highlight: a hairline just inside the squircle's own edge, which
        // is what stops a dark tile dissolving into a dark dock.
        + '<rect x="0.75" y="0.75" width="46.5" height="46.5" rx="10.75" fill="none"'
        + ' stroke="rgba(255,255,255,0.22)" stroke-width="1.5"/>'
        + glyph
        + '</svg>',
    );
}

/**
 * Browser — the streamed Linux desktop, whose one focusable app IS a browser
 * (`FOCUS_APPS` in `./desktop-window.js` has a single entry, chromium), which
 * is why the app is named "Browser" and why this is a globe rather than the
 * monitor it used to be. Brand teal, because this is the app the session is
 * built around and the one the boot opens.
 */
const DESKTOP_ICON = appIcon('ezg-browser', '#17c2ca', '#05737b',
    `<g fill="none" stroke="${GLYPH}" stroke-width="3" stroke-linecap="round">`
    + '<circle cx="24" cy="24" r="12.5"/>'
    + '<ellipse cx="24" cy="24" rx="5.4" ry="12.5"/>'
    + '<path d="M12.4 19.6h23.2M12.4 28.4h23.2"/>'
    + '</g>');

/**
 * Settings — a cog. Graphite, so the one app that is not a workspace does not
 * compete with the three that are.
 *
 * 🔴 Drawn as a thick ring plus eight SHORT, THICK teeth, not as the previous
 * thin circle plus eight long thin rays. At 30px those rays read as a sun —
 * OBSERVED, and the Troubleshoot tab's own brightness-looking glyph sits right
 * next to it in the Settings sidebar. Teeth that barely clear the ring read as
 * a cog; spokes that reach twice the ring's radius do not.
 */
const SETTINGS_ICON = appIcon('ezg-settings', '#7c858b', '#3a4247',
    `<g fill="none" stroke="${GLYPH}" stroke-linecap="round">`
    + '<circle cx="24" cy="24" r="10.6" stroke-width="5"/>'
    + '<g stroke-width="4.4">'
    + '<path d="M37 24h3.2M7.8 24H11M24 11V7.8M24 37v3.2"/>'
    + '<path d="M33.2 33.2l2.3 2.3M12.5 12.5l2.3 2.3M33.2 14.8l2.3-2.3M12.5 35.5l2.3-2.3"/>'
    + '</g></g>');

/**
 * Preview — the user's own app, served over HTTP into an iframe. An EYE, not
 * the window-with-a-titlebar it used to be: that was the same rounded
 * rectangle as the old Browser monitor at dock size, and "a window" is what
 * every app in this OS is. An eye says "look at the thing", which is what this
 * window is for. Amber, the warmest hue in the set, so it is unmistakable
 * beside the teal and the indigo.
 */
const PREVIEW_ICON = appIcon('ezg-preview', '#f5b23f', '#c9761b',
    `<g fill="none" stroke="${GLYPH}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M9.5 24S15.8 14.5 24 14.5 38.5 24 38.5 24 32.2 33.5 24 33.5 9.5 24 9.5 24Z"/>'
    + '<circle cx="24" cy="24" r="4.4"/>'
    + '</g>');

/**
 * Code — code-server. The `</>` every editor uses, with the slash, at a weight
 * that survives 30px.
 *
 * Violet, not the indigo it was drawn in first: OBSERVED in the dock, an
 * indigo tile sat two places from Puter's own `start.svg`, which is a
 * cornflower-blue disc, and at 30px the two read as a matched pair rather than
 * as the launcher and an app. Violet clears it, and stays far enough from both
 * the teal and the amber that the three workspace apps are three different
 * colours at a glance.
 */
const CODE_ICON = appIcon('ezg-code', '#a274f5', '#5b2ec4',
    `<g fill="none" stroke="${GLYPH}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">`
    + '<path d="M18.5 16.5 10 24l8.5 7.5M29.5 16.5 38 24l-8.5 7.5"/>'
    + '<path d="M26.6 13.6 21.4 34.4" stroke-width="3"/>'
    + '</g>');

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
 * @property {boolean} [owns_boot_trace] `open()` returning does NOT mean the
 *   boot is over — it kicked off async work (a container mint, a display
 *   confirmation) that reaches ITS OWN terminal state (ready/failed/
 *   unavailable) well after `open()`'s promise resolves. An app that sets
 *   this ends its OWN `ctx.trace` at that later moment instead of `launch()`
 *   ending it the instant `open()` resolves — see `launch()` below for why
 *   ending it early is exactly the bug this flag exists to prevent, measured
 *   as `durationMs` off by ~500x and `outcome=ok` reported for boots that
 *   then crashed. Unset (the default) means `open()` resolving IS the whole
 *   story — true of `settings`, false of `desktop`/`preview`/`code`.
 * @property {(ctx: object) => Promise<HTMLElement|null>} open
 */

/** @type {readonly AppDescriptor[]} */
export const APPS = [
    {
        id: 'desktop',
        // MODIFIED BY EZIL 2026-08-03: renamed from 'Linux Desktop', per the
        // owner directly — "It shows Linux desktop computer code, something
        // like that. I think we should rename that as a browser and a code."
        // The container's default (and, today, only) focusable app IS a
        // browser (`FOCUS_APPS` in `../apps/desktop-window.js` has one entry:
        // "Show the browser" / chromium), so this is not a euphemism, it is
        // what a user actually sees on first boot. `id: 'desktop'` is left
        // alone — it is wire/DOM plumbing (`data-app="desktop"`, every
        // `.window[data-app="desktop"]` selector across this shell and its
        // tests), not a user-facing string.
        name: 'Browser',
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
        // `open()` returns the instant `UIWindow()` exists — the container
        // mint, the frame confirmation and the display gate all run AFTER,
        // inside the `void start_boot()` this file's own comment on that line
        // calls out as fire-and-forget. See `owns_boot_trace`'s own doc.
        owns_boot_trace: true,
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
        // Same fire-and-forget shape as `desktop` — `void start_boot()` runs
        // its mint/confirm well after `open()` returns. See `owns_boot_trace`.
        owns_boot_trace: true,
        open: openPreviewWindow,
    },
    {
        id: 'code',
        name: 'Code',
        icon: CODE_ICON,
        // Not pinned, same reasoning as `preview`: reachable from the Start
        // menu, not a dock permanent.
        pinned: false,
        single_instance: true,
        // 🔴 Shell-local, and for the SAME reason `preview` is — see that
        // entry's comment. code-server is a feature the Worker can genuinely
        // fail to serve for one deployment (no `codePreviewUrl` field, no
        // exposed port) and the window says so
        // (`show_unavailable()` in `../apps/code.js`); it is not a capability
        // the server list could withhold from one user and not another.
        shell_local: true,
        // 🔴 Wave B / T7 — the whole point of the container swap from
        // Electron VS Code to code-server: an HTTP window, not a focus
        // target inside the streamed desktop. See `../apps/code.js`'s file
        // header for why "focus code in the stream" is not a smaller version
        // of this feature but a different, impossible one.
        // Same fire-and-forget shape as `desktop`/`preview` — `void
        // start_boot()` runs its mint/confirm well after `open()` returns.
        // See `owns_boot_trace`.
        owns_boot_trace: true,
        open: openCodeWindow,
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
 * Turn a `./trace.js` `.end()` summary into the ONE `boot_summary` event for
 * this app-open, and send it. `trace.end()` is idempotent (returns `null` on
 * a second call), so this is naturally "exactly one boot_summary per
 * app-open" — a caller that ends the same trace twice sends nothing the
 * second time, rather than a duplicate row.
 *
 * `attrs.phases`/`attrs.total_ms` are the two keys `ATTRS_ALLOW_LIST.boot_summary`
 * actually allows (`app/src/server/telemetry/types.ts`) — anything else
 * would be silently stripped server-side anyway, so this only ever builds
 * those two.
 *
 * @param {{correlationId:string,name:string,outcome:string,totalMs:number,phases:string}|null} summary
 */
function emitBootSummary (summary) {
    if ( ! summary ) return;
    const attrs = { total_ms: summary.totalMs };
    if ( summary.phases ) attrs.phases = summary.phases;
    telemetry.capture({
        eventClass: 'boot_summary',
        site: `ezil-os:trace#${summary.name}`,
        code: summary.outcome === 'ok' ? 'ok' : summary.outcome,
        outcome: summary.outcome,
        durationMs: summary.totalMs,
        correlationId: summary.correlationId,
        attrs,
    });
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
        log.warn(`[${PHASE}] boot payload carried no app list; showing all known apps`);
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
            log.warn(`[${PHASE}] "${a.id}" is not served by this deployment; hiding it`);
        }
    }
    for ( const id of ids ) {
        if ( ! getApp(id) ) log.warn(`[${PHASE}] server offers "${id}" but this shell cannot open it`);
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
        log.error(`[${PHASE}] no such app: ${id}`);
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:apps/registry#launch', code: 'unknown_app',
            detail: String(id),
        });
        return null;
    }

    if ( app.single_instance ) {
        // 🔴 D2: `:not([data-closing="1"])` excludes a window mid-teardown
        // from `$.fn.close` (UIWindow.js). That flag is stamped SYNCHRONOUSLY
        // the instant `.close()` is called, before any of its own
        // await-ing teardown runs, specifically so a relaunch landing
        // anywhere in that window -- 20ms later, same tick, doesn't matter --
        // cannot mistake a dying window for a live one here, "restore" it,
        // and then have the in-flight close delete it anyway. MEASURED
        // before this fix: real close-button click + relaunch 20ms later ->
        // 0 windows, nothing on screen (the relaunch was silently swallowed
        // by exactly this check).
        const $existing = $(`.window[data-app="${id}"]:not([data-closing="1"])`);
        if ( $existing.length > 0 ) {
            // Already open. It may be minimised, buried, or right there — all
            // three want the same thing, and `showWindow` on a visible window
            // is harmless.
            log.info(`[${PHASE}] "${id}" is already open; restoring it`);
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

    // Opens a trace for THIS app-open and makes it ambient
    // (`../trace.js#beginTrace`) — every `telemetry.capture()` call made
    // anywhere below, and anywhere `app.open()` itself (or anything it calls
    // transitively, e.g. `desktop-window.js`'s own boot-phase telemetry)
    // reaches WHILE THE TRACE IS STILL OPEN, now shares ONE `correlationId`
    // without any of those ~30 existing call sites being edited. `.step()`
    // marks the checkpoints this file itself can see; a richer breadcrumb
    // trail (real boot-phase timings) is `ctx.trace.step(code)` below,
    // callable from any owned file without importing this one.
    const trace = beginTrace(id);
    trace.step('launch_start');

    // 🔴 WHO ENDS THIS TRACE, AND WHEN, IS THE WHOLE FIX.
    //
    // `app.open()` resolving is NOT the same moment as "this app-open is
    // over" for an `owns_boot_trace` app: `openDesktopWindow` (and
    // `preview`/`code`'s identically-shaped windows) return the instant their
    // `UIWindow` exists and fire off `void start_boot()` — deliberately
    // fire-and-forget, so the caller is not stuck awaiting a container mint,
    // a frame confirmation and a display gate before the window even paints.
    // Ending the trace here, right after `await app.open(...)`, used to mean
    // ending it BEFORE any of that ran: MEASURED, real desktop opens of
    // 11150ms and 3631ms each produced `durationMs=22`/`12` and an `ok`
    // outcome for an open that, in one measured case, went on to fail with a
    // sandbox crash the trace had already closed its books on.
    //
    // So `finishTrace` — the one and only path to `emitBootSummary` — is
    // handed to the app itself via `ctx.trace.end`, and THIS file only calls
    // it directly for an app that does NOT declare `owns_boot_trace`, or for
    // an owning app whose `open()` returned `null` (nothing async was kicked
    // off — see the early-return contract-violation/UIWindow-failure paths in
    // `desktop-window.js`/`preview.js`/`code.js`, none of which reach their
    // own `void start_boot()`).
    let fallback_timer = null;
    const finishTrace = (outcome) => {
        if ( fallback_timer !== null ) { clearTimeout(fallback_timer); fallback_timer = null; }
        emitBootSummary(trace.end(outcome));
    };

    try {
        // The descriptor's own icon travels with the launch, so the window
        // head, the taskbar item and the control tray cannot show a different
        // image from the dock tile the user just clicked. `trace` rides along
        // too: an `owns_boot_trace` app reaches back into it (`.step()` for
        // its own mint/confirm/display checkpoints, `.end()` at its own
        // terminal state) without this file importing anything of theirs.
        const el_window = await app.open({ ...ctx, icon: app.icon, appName: app.name, trace: { step: trace.step, end: finishTrace } });
        trace.step('open_resolved');

        // An `owns_boot_trace` app that actually kicked off its async boot
        // (i.e. returned a real window) is now responsible for its own
        // trace — start the bounded fallback so a version of that app which
        // never reaches a terminal state cannot leave this open forever (see
        // `TRACE_FALLBACK_TIMEOUT_MS`). `finishTrace` is idempotent (via
        // `trace.end`'s own idempotence), so this racing the app's real
        // `.end()` call is harmless either way — whichever runs first wins,
        // and the loser's call is a no-op.
        if ( app.owns_boot_trace && el_window ) {
            // `'error'`, not a wire value outside the closed `OUTCOMES` enum —
            // see `TRACE_FALLBACK_TIMEOUT_MS`'s own doc for why.
            fallback_timer = setTimeout(() => finishTrace('error'), TRACE_FALLBACK_TIMEOUT_MS);
        }

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
            trace.step('drawer_ready');
        }

        if ( ! ( app.owns_boot_trace && el_window ) ) {
            // Either this app's `open()` resolving IS its whole story
            // (`settings`, any future synchronous app), or an `owns_boot_trace`
            // app declined to open at all (`el_window === null` — a contract
            // violation or a `UIWindow()` failure caught before that app's own
            // `void start_boot()` ever ran, so nothing async is left racing
            // this call). Either way, THIS is the terminal moment: one
            // `boot_summary` for this app-open, success or "opened nothing"
            // alike. Emitted AFTER the `capture()` calls above have already
            // run, so they were captured WHILE this trace was still ambient
            // and share its correlation id; `.end()` clears the ambient
            // pointer itself.
            finishTrace(el_window ? 'ok' : 'skipped');
        }
        // Else: `el_window` is real and `app.owns_boot_trace` is set — the
        // fallback timer above is armed and the app itself now owns ending
        // this trace, at its own terminal state, via the `ctx.trace.end` it
        // was handed. Nothing further to do here.

        return el_window;
    } catch ( err ) {
        // A throwing `open` must not leave the caller (a taskbar click, a
        // Start press) believing something is on its way. A throw means
        // `open()` never reached its own `void start_boot()` either, so
        // there is nothing async left racing this — safe to end the trace
        // unconditionally, `owns_boot_trace` or not.
        log.error(`[${PHASE}] "${id}" failed to open`, err);
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:apps/registry#launch', code: 'app_open_threw',
            detail: err, attrs: { app_id: String(id) },
        });
        // Captured above WHILE the trace was still ambient, so it already
        // carries this same correlation id — `.end()` runs last and closes
        // the trace with the one boot_summary row for this failed open.
        finishTrace('error');
        return null;
    }
}

export default { APPS, getApp, resolve, launch, settingsDrawerAction };
