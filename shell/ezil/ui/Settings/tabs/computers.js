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

import UIAlert from '../../../src/UI/UIAlert.js';
import registry from '../../apps/registry.js';
import session from '../../session.js';
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

/**
 * The computer id the single 'desktop' app window currently streams, or
 * null if none is open. Seeded from the boot payload — `/os` always opens
 * the payload's own computer first (`boot.js`'s `build()`) — and kept in
 * sync by `switchTo`/`handleDelete` below, which are the only two places
 * that can change what the desktop window shows after boot.
 *
 * One id is enough because there is at most one desktop window ever: the
 * 'desktop' app is `single_instance` (`registry.js`), enforced three ways
 * (there too, and again inside `UIWindow` itself).
 */
let activeComputerId = session.payload()?.computer?.id ?? null;

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
        buttons: [
            { label: copy.confirmLabel, value: 'confirm', type: 'danger' },
            { label: copy.cancelLabel, value: 'cancel', type: 'secondary' },
        ],
    });
    return value === 'confirm';
}

function reportError (message) {
    void UIAlert({ message, type: 'error', buttons: [{ label: 'OK', value: true, type: 'primary' }] });
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
    const $wins = $('.window[data-app="desktop"]');
    if ( $wins.length === 0 ) return;
    await Promise.all($wins.toArray().map(el => Promise.resolve($(el).close())));
    const deadline = Date.now() + 3000;
    while ( $('.window[data-app="desktop"]').length > 0 && Date.now() < deadline ) {
        await new Promise(r => setTimeout(r, 50));
    }
    if ( $('.window[data-app="desktop"]').length > 0 ) {
        console.warn(`[${PHASE}] a desktop window did not close within the wait budget`);
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

    const isActive = computer.id === activeComputerId;
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
    const $list = $win.find('[data-role="computers-list"]');
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
    $list.find('[data-role="rename-input"]').trigger('focus').trigger('select');
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
    if ( computer.id === activeComputerId || busyId ) return;
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
        if ( computer.id === activeComputerId ) {
            await closeDesktopWindows();
            activeComputerId = null;
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
    const $list = $win.find('[data-role="computers-list"]');

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

let bound = false;

export default {
    id: 'computers',
    label: 'Computers',
    icon: COMPUTERS_ICON,

    html () {
        return `
            <div class="ezil-settings-computers">
                <p class="ezil-settings-lead">
                    Up to ${MAX_COMPUTERS_PER_USER} computers. Deleting one shuts its desktop down and
                    frees the slot — your files stay in storage, but the computer itself can't be
                    reopened.
                </p>
                <div class="ezil-settings-computer-list" data-role="computers-list">
                    <div class="ezil-settings-loading">Loading your computers…</div>
                </div>
            </div>`;
    },

    init ($win, ctx) {
        if ( ! bound ) {
            bound = true;
            bind($win, ctx);
        }
        void load($win);
    },

    onActivate ($win) {
        // Cheap and idempotent — a re-activation (switching back to this
        // tab) should show current data, not what was true when the window
        // opened.
        void load($win);
    },
};
