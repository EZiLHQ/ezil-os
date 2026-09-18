// index.js — EZiL-authored, tab-shell ADAPTED from Puter's `UIDashboard.js`.
//
// "Instead of showing the settings of the system, it shows the settings of
// this entire view" — the owner's framing for why this exists: computer
// management moved here now that login lands in the OS instead of on
// `/computers` first (that page stays the fallback — see the drift-test note
// below).
//
// ── Provenance of the shape ──────────────────────────────────────────────
// Adapted from upstream `src/gui/src/UI/Dashboard/UIDashboard.js` (789
// lines, upstream commit 5a15719 — read in full from the reference clone
// kept outside this repository; UIDashboard.js itself was never ported into
// `shell/src/`, only its removal is recorded in `PUTER-PROVENANCE.md`). Of
// those 789 lines, the part reproduced here (~150-200 LOC across this file)
// is: the sidebar-of-tabs markup shape, the click handler that swaps the
// sidebar's `.active` class and the matching content pane's while calling
// the tab's `onActivate`, and the general "one `UIWindow`, N tab objects with
// `{id,label,icon,html(),init(),onActivate()}`" structure.
//
// Dropped, deliberately, ALL SIX of upstream's tabs (Home/Apps/Files/Usage/
// Account/Security — 7,000+ LOC, already recorded as removed in
// `PUTER-PROVENANCE.md`) and everything else that shape doesn't need:
//   - the `dashboard-will-open`/`dashboard-ready` extension events — no
//     extension system here; this fork's three tabs are hard-coded.
//   - hash-based routing (`dashboard_initial_route`, `parseDashboardRoute`,
//     `hashchange`/`popstate` handlers) — this fork does not own the `/os`
//     address bar, and a Settings window is not a page of its own.
//   - the entire socket.io block (upload/download progress, `item.moved`,
//     `trash.is_empty`, reconnect handling) — no realtime backend; see the
//     LOCAL CODE ONLY rule this whole shell follows.
//   - the user-options menu (save-session for temp users, the logged-in-
//     users switcher) — both `puter.auth`-backed.
//   - `is_fullpage`/`is_maximized`/`has_head:false`. Upstream's Dashboard
//     IS the whole desktop — there is nothing else to switch to, so it hides
//     its own head and borrows the control-drawer chrome instead. This
//     Settings window is one ordinary window among several (the streamed
//     desktop chief among them), so it keeps a normal title bar with its own
//     minimise/close and a modest fixed size, and needs none of that.
//
// ── 🔴 Guarantee #1 (reachability from a full-bleed desktop) — DONE, in
// `./drawer-action.js` + `../../apps/registry.js`'s `launch()`. There are now
// TWO independent ways to reach this window, which is the point: the pinned
// taskbar icon (`registry.js`, `pinned: true`) whenever the taskbar is
// visible, and a Settings button inside the control drawer for when it is
// not — `enter_fullpage_mode` hides the taskbar, and without the drawer entry
// a user whose only desktop is stuck full-bleed could not reach Delete at all.
// Read `./drawer-action.js`'s header for why that button is injected from
// this side rather than declared in `desktop-window.js`'s `actions` array.
//
// ── Guarantee #2 (a drift test for `/computers`) — `./computers-drift.test.mjs`,
// which asserts the `/computers` escape hatch still exists and still reaches
// Delete. Run it with `node shell/ezil/ui/Settings/computers-drift.test.mjs`.
// See that file's header for why it is a standalone node script rather than a
// vitest case under `app/src` (a path this task does not own).
import UIWindow from '../../../src/UI/UIWindow.js';
import telemetry from '../../telemetry.js';
import TabComputers from './tabs/computers.js';
import TabAppearance from './tabs/appearance.js';
import TabSystem from './tabs/system.js';
import TabAbout from './tabs/about.js';
import TabTroubleshoot from './tabs/troubleshoot.js';

const PHASE = 'ezil-os:settings';

/**
 * Hard-coded, not discovered — see the header for why. Order is display
 * order. `troubleshoot` is last — MODIFIED BY EZIL 2026-08-03: a way to
 * restart a stuck desktop's container without losing the workspace, reachable
 * from the same two paths Settings itself is (the pinned taskbar icon, and
 * the control-drawer button `drawer-action.js` injects into a full-bleed
 * window) — see `tabs/troubleshoot.js`'s header.
 */
const TABS = [TabComputers, TabSystem, TabAppearance, TabAbout, TabTroubleshoot];

/**
 * Which tab is showing, so the one being LEFT can be told.
 *
 * Module-scoped for the same reason the tabs' own state is: `single_instance`
 * means there is only ever one Settings window, and closing it tears
 * everything down, so this lives exactly as long as a tab could still be
 * visible.
 */
let previousTabId = TABS[0]?.id ?? null;

function sidebarItemHtml (tab, isActive) {
    return `
        <button type="button" class="ezil-settings-tab${isActive ? ' active' : ''}" data-tab="${tab.id}">
            <span class="ezil-settings-tab-icon" aria-hidden="true">${tab.icon}</span>
            <span class="ezil-settings-tab-label">${html_encode(tab.label)}</span>
        </button>`;
}

function buildHtml () {
    let h = '<div class="ezil-settings">';
    h += '<nav class="ezil-settings-sidebar" role="tablist" aria-label="Settings">';
    for ( const tab of TABS ) h += sidebarItemHtml(tab, tab === TABS[0]);
    h += '</nav>';
    h += '<div class="ezil-settings-content">';
    for ( const tab of TABS ) {
        h += `<div class="ezil-settings-pane${tab === TABS[0] ? ' active' : ''}" data-pane="${tab.id}" role="tabpanel">`;
        h += tab.html();
        h += '</div>';
    }
    h += '</div>';
    h += '</div>';
    return h;
}

/**
 * Open (or focus, via `UIWindow`'s own `single_instance` — `registry.js`
 * guards this a second time before ever calling here) the Settings window.
 *
 * @param {object} [ctx] Whatever `registry.launch('settings', ctx)` was
 *   called with — the boot payload, plus `icon`/`appName` the launcher adds.
 * @returns {Promise<HTMLElement|null>}
 */
export async function openSettingsWindow (ctx = {}) {
    const el_window = await UIWindow({
        title: 'Settings',
        app: 'settings',
        icon: ctx.icon,
        body_content: buildHtml(),
        width: 760,
        height: 560,
        is_resizable: true,
        is_maximized: false,
        has_head: true,
        single_instance: true,
        show_in_taskbar: true,
        is_droppable: false,
        selectable_body: true,
        window_class: 'ezil-settings-window',
        // 🔴 Closing the window must release whatever the visible tab
        // acquired. The System tab has the streamed client publishing stream
        // vitals every 2s while it is on screen; without this the publishing
        // would outlive the window that asked for it and keep costing a
        // 2-vCPU container for a monitor nobody can see any more.
        on_close: () => {
            const leaving = TABS.find(t => t.id === previousTabId);
            try {
                leaving?.onDeactivate?.();
            } catch ( err ) {
                console.error(`[${PHASE}] tab "${previousTabId}" failed to deactivate on close`, err);
            }
            previousTabId = TABS[0]?.id ?? null;
        },
        body_css: {
            padding: '0',
            overflow: 'hidden',
        },
    });

    if ( ! el_window ) {
        console.error(`[${PHASE}] UIWindow returned nothing`);
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:settings#open', code: 'uiwindow_returned_nothing',
        });
        return null;
    }

    const $win = $(el_window);

    // The one piece of behaviour every tab shares: switching the sidebar's
    // `.active` item and the matching pane, then telling the tab it became
    // visible. Mirrors upstream's click handler (`UIDashboard.js` ~L471-507)
    // minus the hash/history bookkeeping this fork has no use for.
    $win.on('click', '.ezil-settings-tab', function () {
        if ( $(this).hasClass('active') ) return;
        const id = $(this).attr('data-tab');

        $win.find('.ezil-settings-tab').removeClass('active');
        $(this).addClass('active');
        $win.find('.ezil-settings-pane').removeClass('active');
        $win.find(`.ezil-settings-pane[data-pane="${id}"]`).addClass('active');

        const tab = TABS.find(t => t.id === id);
        // 🔴 Tell the tab being LEFT that it is no longer visible. Without
        // this, a tab that acquires something while active — the System tab
        // asks the streamed client to publish stream vitals every 2s — would
        // keep paying for it forever, on a 2-vCPU container, with nobody
        // looking at the result. `onActivate` without a matching hook is how a
        // monitor turns into a background cost.
        if ( previousTabId && previousTabId !== id ) {
            const leaving = TABS.find(t => t.id === previousTabId);
            try {
                leaving?.onDeactivate?.($win, ctx);
            } catch ( err ) {
                console.error(`[${PHASE}] tab "${previousTabId}" failed to deactivate`, err);
            }
        }
        previousTabId = id;
        try {
            tab?.onActivate?.($win, ctx);
        } catch ( err ) {
            console.error(`[${PHASE}] tab "${id}" failed to activate`, err);
            // `id` is a Settings TAB id (computers/appearance/about/…), not a
            // member of the app registry's enum — `attrs.app_id` is reserved
            // for that (see `registry.js`), so the tab id rides in `detail`
            // instead, where it needs no schema membership to survive.
            telemetry.capture({
                eventClass: 'window_error', site: 'ezil-os:settings#activate', code: 'tab_activate_threw',
                detail: `${String(id)}: ${err?.message ?? err}`,
            });
        }
    });

    for ( const tab of TABS ) {
        try {
            tab.init?.($win, ctx);
        } catch ( err ) {
            // One broken tab must not take the whole Settings window down —
            // the other two (one of which is the AGPL notice) still matter.
            console.error(`[${PHASE}] tab "${tab.id}" failed to initialise`, err);
            telemetry.capture({
                eventClass: 'window_error', site: 'ezil-os:settings#init', code: 'tab_init_threw',
                detail: `${String(tab.id)}: ${err?.message ?? err}`,
            });
        }
    }

    return el_window;
}

export default { open: openSettingsWindow };
