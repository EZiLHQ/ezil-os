// tabs/computers.js — EZiL-authored. Not Puter code.
//
// The Computers tab: this is where computer management lives now that login
// lands in the OS (`/computers` is still the fallback — see the drift test
// noted in the header of `../index.js`). Two slot rows, always — the cap is
// structural, not a counter — mirroring `/computers`'s own
// `_components/select-computers.tsx` layout decision, redrawn here in plain
// DOM/jQuery because this bundle has no React.
//
// `deleteComputerCopy` is imported VERBATIM from
// `app/src/app/computers/_lib/delete-copy.ts` (read, not edited) — the one
// place that copy is allowed to live, so the confirmation text can never say
// something different here than it does on `/computers`.
import { deleteComputerCopy } from '../../../../../app/src/app/computers/_lib/delete-copy.ts';

import UIAlert from '../../../../src/UI/UIAlert.js';
import registry from '../../../apps/registry.js';
import session from '../../../session.js';
import trpc from '../trpc.js';

const PHASE = 'ezil-os:settings/computers';

/**
 * Hard cap on live computers per user. Mirrors
 * `app/src/utils/constants.ts`'s `MAX_COMPUTERS_PER_USER` (also re-exported
 * from `computer.ts`'s router and enforced again in the db schema's CHECK
 * constraint — three independent copies of "2" by design, per that file's
 * own comment). Not imported: pulling in `constants.ts` for one number would
 * also pull its `Routes`/`getReturnUrlQueryParam` neighbours into a bundle
 * that has no login flow to use them in.
 */
const MAX_COMPUTERS_PER_USER = 2;

const COMPUTERS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>';

// ── module state ─────────────────────────────────────────────────────────
// A fresh Settings window re-runs `init` from scratch (single_instance means
// there is only ever one, and closing it tears everything down), so module
// state living here is scoped to "for as long as any Settings window could
// plausibly still show it" — which is the same lifetime `registry.js`'s own
// module state (`APPS`) already has.
let computers = [];
let loading = false;
let loadError = null;
let editingId = null;
let busyId = null; // a switch/delete in flight for this computer id

const DESKTOP_SELECTOR = '.window[data-app="desktop"]';

/**
 * The computer id the single 'desktop' app window currently streams, as far
 * as module state knows. Only ever a HINT — `desktopStreams()` below is the
 * authority.
 *
 * 🔴 This used to be seeded at MODULE-EVAL time from `session.payload()` and
 * treated as the truth, and the end-to-end harness
 * (`../settings-test.mjs`) caught the whole delete guarantee silently not
 * firing because of it: this module is evaluated as part of `boot.js`'s
 * import chain, so on any path where `window.__EZIL_BOOT__` is not already
 * inlined (the `/api/shell/session` rehydrate path, a headless host) it was
 * seeded `null`, `handleDelete`'s `if (computer.id === activeComputerId)`
 * was false, and `computer.delete` went out with the desktop window still
 * mounted and streaming the container that was about to be destroyed.
 *
 * One id is enough because there is at most one desktop window ever: the
 * 'desktop' app is `single_instance` (`registry.js`), enforced three ways
 * (there too, and again inside `UIWindow` itself).
 */
let activeComputerId;

/**
 * The computer the open desktop window is streaming.
 *
 * @returns {string|null|undefined} the id; `null` if no desktop window is
 *   open at all; `undefined` if one is open but nothing says whose it is.
 *
 * Reads `data-ezil-computer-id`, which `registry.launch()` stamps on every
 * window it opens with a computer in its ctx. The DOM is preferred over
 * module state because it is created and destroyed with the window it
 * describes and cannot go stale behind a rebuild; `activeComputerId` is only
 * the fallback for a desktop window that somehow reached the document without
 * going through `launch`.
 */
function openDesktopComputerId () {
    const el = document.querySelector(DESKTOP_SELECTOR);
    if ( ! el ) return null;
    return el.getAttribute('data-ezil-computer-id') || activeComputerId || undefined;
}

/**
 * Does the open desktop window stream `id`?
 *
 * @returns {true|false|'unknown'} `false` ONLY when it is positively known
 *   NOT to (a different computer, or no window at all).
 */
function desktopStreams (id) {
    const open = openDesktopComputerId();
    if ( open === null ) return false;
    if ( open === undefined ) return 'unknown';
    return open === id;
}

function timeAgo (input) {
    if ( ! input ) return null;
    const date = new Date(input);
    if ( Number.isNaN(date.getTime()) ) return null;
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if ( seconds < 60 ) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if ( minutes < 60 ) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if ( hours < 24 ) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if ( days < 30 ) return `${days}d ago`;
    return date.toLocaleDateString();
}

/**
 * 🔴 `UIAlert`'s `type: 'warning'`/`'error'` look up `window.icons['warning-
 * sign.svg']` / `['danger.svg']` — neither is among the 21 icons this fork
 * actually ported (`shell/src/icons/`, see `PUTER-PROVENANCE.md`; only
 * `'success'` -> `c-check.svg` survived the prune). OBSERVED: without an
 * explicit override, `body_icon` comes back `undefined` and the dialog
 * renders `<img src="undefined">` — not a crash, just a broken image next
 * to the text. Passing `body_icon` explicitly sidesteps it without adding a
 * file to that Puter-derived, provenance-tracked directory for two dialogs —
 * the same reasoning `registry.js`'s `DESKTOP_ICON`/`SETTINGS_ICON` already
 * give for using an inline data URI instead.
 */
const ALERT_WARNING_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e0a030" stroke-width="2">'
    + '<path d="M12 3 2 20h20L12 3Z" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke-linecap="round"/></svg>',
);
const ALERT_ERROR_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#d32f2f" stroke-width="2">'
    + '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6" stroke-linecap="round"/></svg>',
);

/** `UIAlert`'s message goes through `html_encode` and then selectively
 * un-escapes `<p>`/`<strong>`/`<br>` — see `UIAlert.js`. Building the message
 * out of real `<p>` tags (rather than one blob) is what makes that survive
 * as separate paragraphs instead of one run-on line. */
function alertMessage (copy) {
    return `<strong>${copy.title}</strong>` + copy.body.map(p => `<p>${p}</p>`).join('');
}

async function confirmDelete (copy) {
    const value = await UIAlert({
        message: alertMessage(copy),
        type: 'warning',
        body_icon: ALERT_WARNING_ICON,
        buttons: [
            { label: copy.confirmLabel, value: 'confirm', type: 'danger' },
            { label: copy.cancelLabel, value: 'cancel', type: 'secondary' },
        ],
    });
    return value === 'confirm';
}

function reportError (message) {
    void UIAlert({
        message,
        type: 'error',
        body_icon: ALERT_ERROR_ICON,
        buttons: [{ label: 'OK', value: true, type: 'primary' }],
    });
}

/**
 * 🔴 Close whatever the single 'desktop' app window currently shows, and
 * WAIT for it to actually leave the document — not just for `.close()`'s
 * promise to settle.
 *
 * `$.fn.close` (`UIWindow.js`) is itself `async`, but its body runs its real
 * work inside `$(this).each(async function () {...})`, and jQuery's `.each`
 * does not await an async callback — it starts it and moves on. So the
 * promise `.close()` returns can resolve before `on_before_exit` (which
 * `desktop-window.js` uses to stop its poll timers and its in-flight boot)
 * has actually finished. Polling for the node's removal is what this
 * function is actually waiting for; the bounded timeout is the same
 * "don't hang forever on our own defensive check" shape used throughout
 * this fork (see `desktop-window.js`'s `FRAME_CONFIRM_*` constants).
 */
async function closeDesktopWindows () {
    const $wins = $(DESKTOP_SELECTOR);
    if ( $wins.length === 0 ) {
        activeComputerId = null;
        return;
    }
    await Promise.all($wins.toArray().map(el => Promise.resolve($(el).close())));
    const deadline = Date.now() + 3000;
    while ( $(DESKTOP_SELECTOR).length > 0 && Date.now() < deadline ) {
        await new Promise(r => setTimeout(r, 50));
    }
    if ( $(DESKTOP_SELECTOR).length > 0 ) {
        console.warn(`[${PHASE}] a desktop window did not close within the wait budget`);
    } else {
        activeComputerId = null;
    }
}

function rowHtml (slot, computer) {
    if ( ! computer ) {
        return `
            <div class="ezil-settings-row ezil-settings-row-empty" data-slot="${slot}">
                <span class="ezil-settings-row-slot">${slot}</span>
                <div class="ezil-settings-row-meta">
                    <div class="ezil-settings-row-name ezil-settings-muted">Empty slot</div>
                </div>
                <div class="ezil-settings-row-actions">
                    <button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="create">New computer</button>
                </div>
            </div>`;
    }

    // "Current" means "this is the desktop on screen right now", read from
    // the DOM rather than from a remembered id — so closing the desktop
    // window by hand correctly turns the pill back into a Switch button.
    const isActive = openDesktopComputerId() === computer.id;
    const isBusy = busyId === computer.id;
    const isEditing = editingId === computer.id;
    const when = timeAgo(computer.lastOpenedAt ?? computer.createdAt);

    if ( isEditing ) {
        return `
            <div class="ezil-settings-row" data-id="${html_encode(computer.id)}" data-slot="${slot}">
                <span class="ezil-settings-row-slot">${slot}</span>
                <form class="ezil-settings-rename-form" data-role="rename-form">
                    <input type="text" class="ezil-settings-input" data-role="rename-input"
                        value="${html_encode(computer.name)}" maxlength="200" autocomplete="off">
                    <div class="ezil-settings-row-actions">
                        <button type="submit" class="ezil-settings-btn ezil-settings-btn-primary">Save</button>
                        <button type="button" class="ezil-settings-btn" data-action="cancel-rename">Cancel</button>
                    </div>
                </form>
            </div>`;
    }

    return `
        <div class="ezil-settings-row${isActive ? ' active' : ''}" data-id="${html_encode(computer.id)}" data-slot="${slot}">
            <span class="ezil-settings-row-slot">${slot}</span>
            <div class="ezil-settings-row-meta">
                <div class="ezil-settings-row-name">${html_encode(computer.name)}</div>
                <div class="ezil-settings-row-sub">${isActive ? 'Active now' : (when ? `Active ${when}` : 'Never opened')}</div>
            </div>
            <div class="ezil-settings-row-actions">
                ${isActive
                    ? '<span class="ezil-settings-pill">Current</span>'
                    : `<button type="button" class="ezil-settings-btn" data-action="switch" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Switching…' : 'Switch'}</button>`}
                <button type="button" class="ezil-settings-btn" data-action="rename" ${isBusy ? 'disabled' : ''}>Rename</button>
                <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="delete" ${isBusy ? 'disabled' : ''}>
                    ${isBusy ? 'Deleting…' : 'Delete'}
                </button>
            </div>
        </div>`;
}

function render ($win) {
    const $list = $win.find('[data-role="slot-list"]');
    if ( $list.length === 0 ) return; // pane not mounted (wrong tab active) — nothing to draw yet

    if ( loading && computers.length === 0 ) {
        $list.html('<div class="ezil-settings-loading">Loading your computers…</div>');
        return;
    }
    if ( loadError ) {
        $list.html(`
            <div class="ezil-settings-error">
                ${html_encode(loadError)}
                <button type="button" class="ezil-settings-btn" data-action="retry">Retry</button>
            </div>`);
        return;
    }

    const bySlot = new Map(computers.map(c => [c.slot, c]));
    let html = '';
    for ( let slot = 1; slot <= MAX_COMPUTERS_PER_USER; slot++ ) {
        html += rowHtml(slot, bySlot.get(slot));
    }
    $list.html(html);
    // `.trigger('select')` only fires the 'select' EVENT, not the browser's
    // actual text-selection — that needs the native method, hence `.get(0)`.
    const $renameInput = $list.find('[data-role="rename-input"]');
    $renameInput.trigger('focus');
    $renameInput.get(0)?.select();
}

async function load ($win) {
    loading = true;
    loadError = null;
    render($win);
    const res = await trpc.query('computer.list');
    loading = false;
    if ( ! res.ok ) {
        loadError = res.code === 'UNAUTHORIZED'
            ? 'Session expired — sign in again.'
            : 'Could not load your computers.';
        render($win);
        return;
    }
    computers = Array.isArray(res.data) ? res.data : [];
    render($win);
}

async function handleCreate ($win) {
    const res = await trpc.mutate('computer.create', {});
    if ( ! res.ok ) {
        reportError(res.code === 'FORBIDDEN'
            ? "You've reached your computer limit."
            : 'Failed to create computer. Please try again.');
        return;
    }
    await load($win);
}

async function switchTo (computer, ctx, $win) {
    if ( desktopStreams(computer.id) === true || busyId ) return;
    busyId = computer.id;
    render($win);
    try {
        // 🔴 Same reason as delete: only one 'desktop' window can exist
        // (single_instance) and it is currently streaming a DIFFERENT
        // container. Closing it first means its client-side teardown runs
        // on purpose, instead of the iframe being yanked out from under a
        // window that `registry.launch` would otherwise just re-focus.
        await closeDesktopWindows();
        activeComputerId = computer.id;
        const desktopState = ctx?.payload?.desktopState ?? {};
        await registry.launch('desktop', { ...ctx, computer, desktopState });
    } finally {
        busyId = null;
        render($win);
    }
}

async function handleRenameSubmit (computer, name, $win) {
    const trimmed = name.trim();
    if ( trimmed === '' ) {
        reportError('A computer needs a name.');
        return;
    }
    if ( trimmed === computer.name ) {
        editingId = null;
        render($win);
        return;
    }
    const res = await trpc.mutate('computer.rename', { id: computer.id, name: trimmed });
    editingId = null;
    if ( ! res.ok ) {
        reportError('Failed to rename computer. Please try again.');
        render($win);
        return;
    }
    await load($win);
}

async function handleDelete (computer, $win) {
    if ( busyId ) return;
    const copy = deleteComputerCopy({ name: computer.name, slot: computer.slot });
    const confirmed = await confirmDelete(copy);
    if ( ! confirmed ) return;

    busyId = computer.id;
    render($win);
    try {
        // 🔴 THE GUARANTEE. `computer.delete` -> `terminateComputerSandbox`
        // (`app/src/server/api/routers/computer.ts`) destroys the very
        // sandbox any open desktop window is streaming. Closing the window
        // FIRST means the client tears its own connection down on its own
        // terms; calling delete first would leave the user watching their
        // OS die mid-frame while the iframe reconnect-loops against a
        // container that no longer exists.
        //
        // 🔴 FAILS SAFE. The window is closed unless the open desktop is
        // POSITIVELY known to be a different computer. The two errors here
        // are not symmetric: closing a window we did not have to close costs
        // one reopen, while not closing one we should have is precisely the
        // failure this guarantee exists to prevent. Round 1 had this
        // backwards — it closed only on a positive match against a variable
        // that was empty on the rehydrate path.
        if ( desktopStreams(computer.id) !== false ) {
            await closeDesktopWindows();
        }

        const res = await trpc.mutate('computer.delete', { id: computer.id });
        if ( ! res.ok && res.code !== 'NOT_FOUND' ) {
            // NOT_FOUND means it is already gone (another tab, a stale
            // list) — a refresh, not a failure, mirroring `/computers`'
            // own `handleDelete`.
            reportError('Failed to delete computer. Please try again.');
            return;
        }
        await load($win);
    } finally {
        busyId = null;
    }
}

function bind ($win, ctx) {
    const $list = $win.find('[data-role="slot-list"]');

    $list.on('click', '[data-action="create"]', () => { void handleCreate($win); });
    $list.on('click', '[data-action="retry"]', () => { void load($win); });

    $list.on('click', '[data-action="switch"]', function () {
        const id = $(this).closest('.ezil-settings-row').attr('data-id');
        const computer = computers.find(c => c.id === id);
        if ( computer ) void switchTo(computer, ctx, $win);
    });

    $list.on('click', '[data-action="rename"]', function () {
        const id = $(this).closest('.ezil-settings-row').attr('data-id');
        editingId = id;
        render($win);
    });
    $list.on('click', '[data-action="cancel-rename"]', () => {
        editingId = null;
        render($win);
    });
    $list.on('submit', '[data-role="rename-form"]', function (e) {
        e.preventDefault();
        const id = $(this).closest('.ezil-settings-row').attr('data-id');
        const computer = computers.find(c => c.id === id);
        const name = $(this).find('[data-role="rename-input"]').val();
        if ( computer ) void handleRenameSubmit(computer, String(name ?? ''), $win);
    });

    $list.on('click', '[data-action="delete"]', function () {
        const id = $(this).closest('.ezil-settings-row').attr('data-id');
        const computer = computers.find(c => c.id === id);
        if ( computer ) void handleDelete(computer, $win);
    });
}

export default {
    id: 'computers',
    label: 'Computers',
    icon: COMPUTERS_ICON,

    html () {
        return `
            <div class="ezil-settings-pane-body">
                <p class="ezil-settings-lead">
                    Up to ${MAX_COMPUTERS_PER_USER} computers. Deleting one shuts its desktop down and
                    frees the slot — your files stay in storage, but the computer itself can't be
                    reopened.
                </p>
                <div class="ezil-settings-slot-list" data-role="slot-list">
                    <div class="ezil-settings-loading">Loading your computers…</div>
                </div>
            </div>`;
    },

    /**
     * 🔴 Binds EVERY time, and there used to be a `let bound = false` module
     * flag here guarding it. That was a real defect, not a micro-optimisation
     * gone wrong: `bind()` attaches DELEGATED handlers to `$win`'s own
     * `[data-role="slot-list"]` element. Settings is `single_instance` and
     * `show_in_taskbar`, so closing it and reopening it from the dock is the
     * ordinary interaction — and on that second open the module flag was
     * still true, the fresh window's list got no handlers, and Switch / New /
     * Rename / Delete were all dead buttons. i.e. the 2-computer trap,
     * reappearing one interaction later.
     *
     * Re-binding cannot duplicate handlers, because `index.js` calls `init`
     * exactly once per window and each window brings a brand-new element.
     *
     * Transient per-window state is reset for the same reason: an
     * `editingId` or a `busyId` left over from a window that no longer exists
     * would render a rename form, or a permanently disabled row, in the new
     * one. `computers` is deliberately NOT cleared — showing the last known
     * list for the ~100ms until `load()` returns beats flashing a spinner.
     */
    init ($win, ctx) {
        editingId = null;
        busyId = null;
        loadError = null;
        // The fallback hint only — `openDesktopComputerId()` prefers the
        // stamp on the window itself. Read HERE rather than at module-eval
        // time, so the rehydrate path (payload arrives from
        // `/api/shell/session` after this module was imported) is not seeded
        // empty. See the note on `activeComputerId`.
        if ( activeComputerId === undefined ) {
            activeComputerId = ctx?.computer?.id ?? session.payload()?.computer?.id ?? undefined;
        }
        bind($win, ctx);
        void load($win);
    },

    onActivate ($win) {
        // Cheap and idempotent — a re-activation (switching back to this
        // tab) should show current data, not what was true when the window
        // opened.
        void load($win);
    },
};
