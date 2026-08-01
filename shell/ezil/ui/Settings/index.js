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
// ── 🔴 Guarantee #1 (reachability from a full-bleed desktop) — READY, NOT
// WIRED. `desktop-window.js` (not owned by this task) already has the seam:
// `attach_app_drawer(el_window, { actions: [...] })`, with the comment
// "Settings drops in here in a later wave — the drawer renders whatever this
// array contains, in order, before Close." `registry.js`'s
// `settingsDrawerAction()` (this task) builds exactly the `{id,label,svg,
// onClick}` shape that array expects. Wiring it in is a one-line change to
// `desktop-window.js`'s `actions` array — outside this task's owned paths
// (`shell/ezil/ui/Settings/**`, `shell/ezil/apps/registry.js`,
// `shell/PUTER-PROVENANCE.md`) — and is NOT done here. Until it lands, a user
// whose desktop is full-bleed can still reach Settings via its pinned
// taskbar icon whenever the taskbar is visible (i.e. whenever no window is
// full-bleed), but NOT while one is — see this task's report for the full
// account.
//
// ── Guarantee #2 (a drift test for `/computers`) — NOT ADDED, same reason.
// A Next.js route test belongs under `app/`, which this task does not own.
import UIWindow from '../../../src/UI/UIWindow.js';
import TabComputers from './tabs/computers.js';
import TabAppearance from './tabs/appearance.js';
import TabAbout from './tabs/about.js';

const PHASE = 'ezil-os:settings';

/** Hard-coded, not discovered — see the header for why. Order is display order. */
const TABS = [TabComputers, TabAppearance, TabAbout];

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
        body_css: {
            padding: '0',
            overflow: 'hidden',
        },
    });

    if ( ! el_window ) {
        console.error(`[${PHASE}] UIWindow returned nothing`);
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
        try {
            tab?.onActivate?.($win, ctx);
        } catch ( err ) {
            console.error(`[${PHASE}] tab "${id}" failed to activate`, err);
        }
    });

    for ( const tab of TABS ) {
        try {
            tab.init?.($win, ctx);
        } catch ( err ) {
            // One broken tab must not take the whole Settings window down —
            // the other two (one of which is the AGPL notice) still matter.
            console.error(`[${PHASE}] tab "${tab.id}" failed to initialise`, err);
        }
    }

    return el_window;
}

export default { open: openSettingsWindow };
