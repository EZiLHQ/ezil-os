import { isNative } from '../../../native-runtime.js';
// tabs/computers.js — EZiL-authored. Not Puter code.
//
// The Computer tab. On the web there is ONE computer per person (round 3,
// plan §6.1, decision D6): its status, its configuration (switchable on
// Premium), Stop, storage, and any older computer read-only. `/computers` is
// still the fallback page (see the drift test noted in the header of
// `../index.js`) and shows the same one-computer model. The native macOS host
// keeps its own list of local workspaces, rendered by `nativeRowHtml`.
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
import TabBilling from './billing.js';
import { feedback_enabled, open_feedback_dialog } from '../../feedback/feedback.js';
import { TRANSITION_EVENT } from '../../computer-progress.js';

const PHASE = 'ezil-os:settings/computers';

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
 * 🔴 EVERY window bound to a computer sandbox — not a hardcoded app list.
 * This is what `closeSandboxWindows()` below closes on delete/switch, and it
 * is the fix for the defect that shipped `DESKTOP_SELECTOR`-only closing:
 * Preview (Wave A) and Code (Wave B) are container windows on the exact same
 * sandbox as the desktop, opened with the same `ctx.computer` and stamped
 * with the same `data-ezil-computer-id` by `registry.launch()` — but they
 * are a DIFFERENT `data-app` value, so any selector keyed on `data-app`
 * misses them by construction, today and for every future window a next wave
 * adds. MEASURED (CDP `Fetch.requestPaused`, request aborted, nothing
 * deleted): at the instant `computer.delete` left the browser, the DOM still
 * held a live `{app:'preview', src:'http://3002-guac-…-app.'}` iframe into
 * the sandbox about to be destroyed.
 *
 * Matched structurally, on an actual `.window-app-iframe` inside it — the
 * element `UIWindow` builds for every app that passes `iframe_url`
 * (`desktop-window.js`, `preview.js`, `code.js` all do, identically:
 * `el_window.querySelector('.window-app-iframe')`). This is what a "streams
 * the sandbox" window IS, mechanically — not an app name, and not the
 * `data-ezil-computer-id` stamp either, deliberately:
 *
 *   - It is NOT an app name, because that is exactly the bug this replaces:
 *     any selector keyed on `data-app` misses every current and future
 *     iframe-backed app that isn't literally `"desktop"`.
 *   - It is NOT the `data-ezil-computer-id` stamp, for two independent
 *     reasons. First, `registry.launch()` stamps it on ANY window opened
 *     with `ctx.computer.id` set, including Settings itself — reachable
 *     from a sandbox window's own control drawer with that window's ctx
 *     (`registry.js`'s `settingsDrawerAction`). Settings is a plain
 *     DOM+trpc pane, not an iframe into the container, and it is also the
 *     exact window issuing this very delete/switch call — matching on the
 *     stamp alone would try to close its caller out from under itself.
 *     Second, and just as important: requiring the stamp to be PRESENT would
 *     silently exclude a window whose stamp is missing or has been stripped
 *     from being considered a sandbox window AT ALL — exactly the "unknown
 *     ownership" case `windowStreams()` below exists to fail safe on (see
 *     `../settings-test.mjs`'s round-1 regression). A window's OWN presence
 *     as a candidate must not depend on the attribute whose absence is the
 *     scenario being defended against.
 */
const SANDBOX_WINDOW_SELECTOR = '.window';

/** @returns {HTMLElement[]} every currently open sandbox-bound window. */
function sandboxWindowEls () {
    return $(SANDBOX_WINDOW_SELECTOR).toArray()
        .filter(el => el.querySelector('.window-app-iframe') !== null);
}

/**
 * The computer id the single 'desktop' app window currently streams, as far
 * as module state knows. Only ever a HINT — `desktopStreams()` below is the
 * authority. It is the delete guard's hint, NOT "the current computer": that
 * is `session.currentComputer()`, and only that (see `rowHtml`).
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
 * (there too, and again inside `UIWindow` itself). It also doubles as the
 * fallback hint for ANY sandbox window (not just the desktop) whose own
 * stamp is missing — see `windowStreams()` below — because every sandbox
 * window open at once shares one computer: every launch (dock, Start menu,
 * App Store, Switch) opens on `session.currentComputer()`, and a Switch
 * closes every sandbox window before it changes that value.
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

/**
 * Does sandbox window `el` (any of desktop/preview/code/future — anything
 * `sandboxWindowEls()` matched) stream computer `id`? `el` is always a real,
 * currently-open window — the "no window at all" case `desktopStreams()`
 * handles by returning `false` does not arise here, since callers only ever
 * pass elements `sandboxWindowEls()` actually found.
 *
 * @returns {true|false|'unknown'} `false` ONLY when positively known NOT to.
 *   Same fallback chain as `openDesktopComputerId()`, applied to any window:
 *   the window's own stamp wins when present; a falsy stamp (missing OR
 *   stripped) falls back to `activeComputerId`, and `activeComputerId`
 *   itself being falsy (`null` OR `undefined` — both mean "no known active
 *   computer", not "positively none") is what makes the result 'unknown'
 *   rather than a false negative.
 */
function windowStreams (el, id) {
    const own = el.getAttribute('data-ezil-computer-id') || activeComputerId || undefined;
    return own === undefined ? 'unknown' : own === id;
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
 * 🔴 THE GUARANTEE, generalised. Close every open sandbox window (desktop,
 * Preview, Code, whatever a future wave adds) that streams computer `id` —
 * or, with no `id` (the switch path, where we are leaving EVERY currently
 * open window behind regardless of whose it was), every sandbox window,
 * full stop. WAIT for each to actually leave the document — not just for
 * `.close()`'s promise to settle.
 *
 * `$.fn.close` (`UIWindow.js`) is itself `async`, but its body runs its real
 * work inside `$(this).each(async function () {...})`, and jQuery's `.each`
 * does not await an async callback — it starts it and moves on. So the
 * promise `.close()` returns can resolve before `on_before_exit` (which
 * `desktop-window.js`/`preview.js`/`code.js` each use to stop their poll
 * timers and in-flight boot) has actually finished. Polling for the nodes'
 * removal is what this function is actually waiting for; the bounded
 * timeout is the same "don't hang forever on our own defensive check" shape
 * used throughout this fork (see `desktop-window.js`'s `FRAME_CONFIRM_*`
 * constants).
 *
 * @param {string} [id] Close only windows streaming this computer (fails
 *   safe: 'unknown' ownership closes too — see `windowStreams()`). Omitted
 *   entirely closes every open sandbox window unless `keepId` matches.
 * @param {string} [keepId] Keep windows positively streaming this computer
 *   when reopening its desktop; unknown ownership still closes.
 */
async function closeSandboxWindows (id, keepId) {
    const targets = () => sandboxWindowEls()
        .filter(el => (id === undefined || windowStreams(el, id) !== false)
            && (keepId === undefined || windowStreams(el, keepId) !== true));

    const $wins = $(targets());
    if ( $wins.length > 0 ) {
        await Promise.all($wins.toArray().map(el => Promise.resolve($(el).close())));
        const deadline = Date.now() + 3000;
        while ( targets().length > 0 && Date.now() < deadline ) {
            await new Promise(r => setTimeout(r, 50));
        }
        if ( targets().length > 0 ) {
            console.warn(`[${PHASE}] a sandbox window did not close within the wait budget`);
        }
    }
    // 🔴 HOTFIX r5 (ACCEPT-11865d06 B6): a closed window is not a stopped loop.
    // Every desktop/Preview/Code wake loop for this computer (including one whose
    // window is already gone, and the paint-time warm) is cancelled and AWAITED,
    // so no ask can reach the server's ensure() — which starts a STOPPED
    // computer — after the Stop/Delete this precedes. Bounded like the close.
    const cancelled = Promise.resolve(session.cancelComputerOpens?.(id, { keep: keepId }));
    let budget;
    await Promise.race([cancelled, new Promise(r => { budget = setTimeout(r, 3000); })]);
    clearTimeout(budget);
    // The desktop specifically drives `activeComputerId` (see its own
    // comment): re-check it directly rather than assume it was among the
    // windows this call targeted.
    if ( openDesktopComputerId() === null ) activeComputerId = null;
}

// ── One computer (web): configuration, switch, stop, storage ─────────────
// Round 3 (plan §6.1/§6.2, contract v3 D5/D6). The web shell shows ONE
// computer: the one every launch uses (`session.currentComputer()`). There is
// no slot list and nothing that creates a computer. Any other live row is an
// older computer, shown read-only with Delete. The native macOS host keeps its
// workspace list (`nativeRowHtml`), which is a different product surface.
//
// The server owns current vs target (`computer.progress` → `transition`);
// this tab only acknowledges a click until the server answers, then renders
// what the server says. Every open tab polls the same state.

/** Fallback sizes, mirroring `SIZES` in `app/src/server/billing/v2/contract.ts`. */
const SIZE_FALLBACK = {
    'free-cf': { vcpu: 2, memoryGiB: 6, weight: 1 },
    'std-2': { vcpu: 2, memoryGiB: 8, weight: 1 },
    'cmp-4': { vcpu: 4, memoryGiB: 16, weight: 2 },
    'cmp-8': { vcpu: 8, memoryGiB: 32, weight: 4 },
};
const AWS_SIZES = ['std-2', 'cmp-4', 'cmp-8'];
const VCPU_SIZE = { 2: 'std-2', 4: 'cmp-4', 8: 'cmp-8' };
const IN_FLIGHT = new Set(['requested', 'stopping', 'waking']);
const SWITCH_KEY = 'ezil-os:switch.';
/** D11: the AWS ledger cap is not plan time; it gets its own sentence. */
export const AWS_CAP_COPY = "You've used this month's AWS computer time. It resets on the 1st — or contact us.";
const CAP_REASONS = new Set(['billing_user_hours_cap', 'billing_aws_monthly_cap', 'user_hours_cap', 'aws_monthly_cap']);
/** Failure reasons another attempt can fix; billing, retirement or a missing placement cannot. */
const RETRYABLE = /^(capacity_unavailable|capacity:|stop_|release_heal_|wake_timeout|unconfirmed|size_not_applied|placement_unavailable|computer_starting)/;

let summary = null;   // billing.summary (v3) or null when it cannot be read
// computer.progress of the main computer, AS READ DURING THIS ACTIVATION. Follow-up r5
// (ACCEPT-9a755827 FINDING 2): it is cleared whenever a window or the tab goes away and only
// rendered when `progressGen` matches the current activation, so a reopen never paints the
// lifecycle (Stopped without Stop over a running computer, or the reverse) of a previous life.
let progress = null;
let progressGen = -1; // `generation` when `progress` was read
let pendingSwitch = null; // { computerId, current, target } from the click to the server's answer
let notice = null;    // { text, tone } from the last switch/stop answer
let unavailable = new Set();
let pollTimer = null;
let paneActive = false;
let generation = 0;
let stopBusy = false;
let paneCtx = null;
let queuedSwitch = null; // a configuration Billing handed over after an upgrade
const seenInFlight = new Set(); // transition ids this page saw in flight, so "Done" is never a stale record
const dismissed = new Set();
const barFloor = new Map();     // transition id → the highest ratio shown, so the bar never moves back

export function sizeInfo (code, data = summary) {
    const choice = data?.computer?.machineChoice?.find?.(m => m.size === code);
    return choice ? { vcpu: choice.vcpu, memoryGiB: choice.memoryGiB, weight: choice.weight } : SIZE_FALLBACK[code] ?? null;
}
export function sizeLabel (code, data = summary) {
    const size = sizeInfo(code, data);
    return size ? `${size.vcpu} vCPU · ${size.memoryGiB} GB` : 'another configuration';
}
/** `m6i.large` → std-2, `m6i.xlarge` → cmp-4, `m6i.2xlarge` → cmp-8 (AWS's own vCPU rule). */
export function sizeForInstanceType (type) {
    const m = typeof type === 'string' ? /^[a-z][a-z0-9-]*\.(large|xlarge|(\d+)xlarge)$/.exec(type) : null;
    if ( ! m ) return null;
    const vcpu = m[1] === 'large' ? 2 : m[1] === 'xlarge' ? 4 : 4 * Number(m[2]);
    return VCPU_SIZE[vcpu] ?? null;
}

function storageOf () {
    try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}
function mintRequestId () {
    let id = '';
    try { id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : ''; } catch { id = ''; }
    if ( ! id ) id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).padEnd(8, '0');
}
/**
 * One request id per (computer, target), kept in sessionStorage: a double
 * click, a retry after a dropped answer and a reload all send the same id, so
 * the server answers with the same transition instead of starting another.
 */
export function switchRequestId (computerId, target, store = storageOf()) {
    const key = `${SWITCH_KEY}${computerId}.${target}`;
    try {
        const kept = store?.getItem(key);
        if ( kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept) ) return kept;
    } catch { /* storage refused: fall through to a fresh id */ }
    const id = mintRequestId();
    try { store?.setItem(key, id); } catch { /* the id still works for this click */ }
    return id;
}
export function clearSwitchRequestId (computerId, target, store = storageOf()) {
    try { store?.removeItem(`${SWITCH_KEY}${computerId}.${target}`); } catch { /* nothing kept */ }
}

const transitionOf = p => (p && p.transition && typeof p.transition === 'object' ? p.transition : null);
export const inFlight = p => IN_FLIGHT.has(transitionOf(p)?.phase);

/** The cheapest plan that offers `size`, for a locked card ("Premium"). */
function planFor (size, data) {
    const offer = (data?.catalog?.offers ?? []).filter(o => (o.machineChoice ?? []).includes(size))
        .sort((a, b) => a.priceCents - b.priceCents)[0];
    return offer?.name ?? 'Premium';
}

/** Copy for a switch the server refused. */
export function refusalCopy (reason, target, data = summary, current = null) {
    switch ( reason ) {
    case 'switch_in_progress': return 'A switch is already in progress. Wait for it to finish, then try again.';
    case 'not_entitled': return "Your plan doesn't include this configuration right now.";
    case 'capacity_unavailable': {
        const smaller = AWS_SIZES.slice(0, AWS_SIZES.indexOf(target)).reverse()
            .find(code => code !== current && (data?.computer?.machineChoice ?? []).some(m => m.size === code));
        return smaller ? `Not available right now — try ${sizeInfo(smaller, data).vcpu} vCPU or try again later.`
            : 'Not available right now — try again later.';
    }
    case 'computer_busy': return 'Your computer is starting or stopping. Try again in a moment.';
    case 'foreign_computer': return "This computer can't be switched from here.";
    case 'user_hours_cap': case 'aws_monthly_cap': return AWS_CAP_COPY;
    case 'unauthorized': return 'Your session expired — sign in again.';
    default: return "We couldn't switch. Check your connection and try again.";
    }
}

/**
 * Everything the Computer tab shows, from server data only (plus the one
 * pending click). Pure, so the states are unit-tested without a DOM.
 */
export function computerModel ({ computer, data = null, prog = null, pending = null, refusedSizes = new Set(), streaming = false, stopping = false }) {
    // Round 4 (STANDING-CONTRACT): the standing decides what opens; an unknown or missing one keeps the
    // plan-only model. The plan block may still describe a past_due paid subscription after grace.
    const standing = standingOf(data);
    // D16: on Free, but the files are still on the AWS computer. It opens under Free limits; nothing has moved.
    const held = standing === 'files_on_aws';
    const dropped = held || standing === 'free';
    const free = data?.plan?.sku === 'free_v3' || dropped;
    const t = transitionOf(prog);
    const flying = IN_FLIGHT.has(t?.phase) ? t : null;
    const lifecycle = typeof prog?.lifecycleState === 'string' ? prog.lifecycleState : null;
    const running = free && ! held ? streaming : lifecycle === 'RUNNING';
    const stopped = (! free || held) && lifecycle === 'STOPPED';
    const hardware = sizeForInstanceType(prog?.hardware?.instanceType);
    const preference = data?.computer?.size ?? null;
    const current = held ? flying?.current ?? hardware ?? 'std-2' : free ? 'free-cf' : flying?.current ?? hardware ?? preference;
    const choice = new Set((data?.computer?.machineChoice ?? []).map(m => m.size));
    const switching = pending ? { current: pending.current, target: pending.target, phase: 'requested', acknowledged: false }
        : flying && flying.kind !== 'restart' ? { current: flying.current, target: flying.target, phase: flying.phase, acknowledged: true } : null;
    const nextStart = ! switching && ! free && preference && current && preference !== current && (stopped || ! lifecycle) ? preference : null;
    let chip = null;
    if ( switching ) chip = { state: 'switching', text: `Switching to ${sizeInfo(switching.target, data)?.vcpu ?? ''} vCPU` };
    else if ( flying ) chip = { state: 'switching', text: 'Restarting…' };
    // D6: the chip says Stopping… the moment the user confirms, not when the server first reports it.
    else if ( stopping ) chip = { state: 'stopping', text: 'Stopping…' };
    else if ( prog?.needsOperator || t?.phase === 'failed' ) chip = { state: 'attention', text: 'Needs attention' };
    else if ( running ) chip = { state: 'running', text: 'Running' };
    else if ( prog?.operation === 'opening' ) chip = { state: 'starting', text: 'Starting…' };
    else if ( prog?.operation === 'stopping' ) chip = { state: 'stopping', text: 'Stopping…' };
    else if ( stopped ) chip = { state: 'stopped', text: 'Stopped' };
    // Held on AWS: no Cloudflare card (the files are not there) and every AWS configuration is locked.
    const sizes = free && ! held ? ['free-cf', ...AWS_SIZES] : AWS_SIZES;
    const cards = data ? sizes.map(size => {
        const info = sizeInfo(size, data);
        let state = held || (dropped && size !== 'free-cf') ? 'locked' : size === current ? 'current' : ! choice.has(size) ? 'locked' : refusedSizes.has(size) ? 'unavailable' : 'available';
        if ( switching && size === switching.target ) state = 'switching';
        // D6: during a switch only the target is highlighted; the size it leaves is just "from".
        else if ( switching && size === switching.current ) state = 'from';
        else if ( nextStart === size ) state = 'next';
        return { size, vcpu: info.vcpu, memoryGiB: info.memoryGiB, weight: info.weight, state,
            plan: state === 'locked' ? planFor(size, data) : null };
    }) : [];
    const disk = data?.computer?.disk ?? null;
    // Hotfix r5 (ACCEPT #5): "Now running on …" only while it is running — never beside Stopping…/Stopped.
    const done = ! switching && running && ! stopping && prog?.operation !== 'stopping'
        && t?.phase === 'done' && t.kind !== 'restart' && seenInFlight.has(t.transitionId) && ! dismissed.has(t.transitionId) ? t : null;
    const failed = ! switching && t?.phase === 'failed' && t.kind !== 'restart' && ! dismissed.has(t.transitionId) ? t : null;
    const move = data?.computer?.move?.direction === 'to_cloudflare' ? data.computer.move : null; // Phase B; dormant while null
    return { computer, data, free, standing, held, move,
        provider: data ? held ? 'AWS (India) · files kept' : free ? 'Cloudflare' : 'AWS · Mumbai' : null, chip, current, nextStart, switching,
        running, stopped, cards, done, failed, disk, busy: !! (switching || flying || stopping || prog?.operation === 'opening' || prog?.operation === 'stopping') };
}

const STANDINGS = new Set(['paid', 'grace', 'plan_ending', 'files_on_aws', 'free']);
/** The server's standing for the computer (`billing.summary` v3 `computer.standing`), or null. */
export function standingOf (data) {
    const value = data?.computer?.standing;
    return STANDINGS.has(value) ? value : null;
}

/** "27 Nov 2026" from an ISO instant (UTC), or null. Same format as Billing's `dateLabel(iso, true)`. */
function dayLabel (iso) {
    const time = Date.parse(iso ?? '');
    return Number.isFinite(time) ? new Date(time).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : null;
}

/** Round 4 copy. Billing (`billing.js`) carries the same function; billing-test pins the two equal. */
export function standingCopy (standing, data) {
    const plan = data?.plan ?? {};
    if ( standing === 'grace' ) {
        const by = dayLabel(plan.graceEndsAt);
        return `Your payment didn't go through — update it${by ? ` by ${by}` : ''} to keep your ${data?.computer?.filesOn === 'cloudflare' ? 'plan' : 'AWS computer'}.`;
    }
    if ( standing === 'plan_ending' ) {
        const on = dayLabel(plan.planEndsAt ?? plan.cancelsAt);
        const name = plan.name || 'Your plan';
        const ends = on ? `${name} ends on ${on}.` : `${name} ends at the end of this period.`;
        return data?.computer?.filesOn === 'cloudflare' ? `${ends} Your files are kept.`
            : `${ends} After that your files stay on your AWS computer until they are moved to your Free computer; nothing is deleted.`;
    }
    if ( standing === 'files_on_aws' ) return 'Your files are still on your AWS (India) computer. Open it on the Free plan with Free limits, or upgrade to restore full use.';
    return '';
}

const MOVE_STEPS = ['Saving your files', 'Copying your files to your Free computer', 'Checking your files', 'Starting your desktop'];
const MOVE_STEP_OF = { requested: 0, fenced: 0, saving: 0, exporting: 1, copying: 1, exported: 2, restoring: 2, restored: 2, checking: 2, flipping: 3, starting: 3 };

/** A reverse move (AWS → Cloudflare, Phase B) from server fields only: done, failed or a step index. */
export function moveView (move) {
    if ( ! move || move.direction !== 'to_cloudflare' ) return null;
    const stage = String(move.stage ?? '');
    if ( stage === 'committed' || stage === 'done' ) return { kind: 'done' };
    if ( stage.startsWith('failed') ) return { kind: 'failed', code: /^[a-z0-9_:-]{1,64}$/i.test(String(move.reason ?? '')) ? move.reason : `move_${stage}` };
    const index = MOVE_STEP_OF[stage] ?? 0;
    const done = /^\d+$/.test(String(move.bytesDone ?? '')) ? Number(move.bytesDone) : null;
    const total = /^\d+$/.test(String(move.bytesTotal ?? '')) ? Number(move.bytesTotal) : null;
    const bytes = index === 1 && done !== null && total ? `${(done / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} MB of ${(total / 1e9).toLocaleString('en-US', { maximumFractionDigits: 1 })} GB copied` : '';
    const fraction = index === 1 && done !== null && total ? Math.min(1, done / total) : 0;
    return { kind: 'progress', index, steps: MOVE_STEPS, bytes, percent: Math.round(Math.min(0.95, (index + fraction) / MOVE_STEPS.length) * 100) };
}

function moveHtml (model) {
    const view = moveView(model.move);
    if ( ! view ) return '';
    if ( view.kind === 'done' ) {
        // One primary per state (D6): Open desktop lives in the header.
        return `<div class="ezil-computer-switch is-done" data-role="move-done" role="status"><p>Your files are on your Free computer. Open your desktop to continue.</p></div>`;
    }
    if ( view.kind === 'failed' ) {
        return `<div class="ezil-computer-switch is-failed" data-role="move-failed" role="alert">
            <p>We couldn't move your files. They're still on your AWS computer and nothing was deleted.</p><div class="ezil-settings-row-actions">
            <button type="button" class="ezil-settings-btn" data-action="move-retry">Try again</button>
            ${feedback_enabled() ? `<button type="button" class="ezil-settings-btn" data-action="move-feedback" data-code="${html_encode(view.code)}">Send feedback</button>` : ''}</div></div>`;
    }
    return `<div class="ezil-computer-switch" data-role="move-progress" role="status" aria-live="polite">
        <p><strong>Moving your files to your Free computer</strong></p>
        ${view.bytes ? `<p data-role="move-bytes">${html_encode(view.bytes)}</p>` : ''}
        <div class="ezil-computer-bar" role="progressbar" aria-label="Move progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${view.percent}"><span style="width:${view.percent}%"></span></div>
        <ol class="ezil-computer-steps">${view.steps.map((step, i) => `<li data-step="${i + 1}" data-state="${i < view.index ? 'done' : i === view.index ? 'active' : 'todo'}">${html_encode(step)}</li>`).join('')}</ol></div>`;
}

/** Round 4 standing banners (D16-D18): grace, plan ending, files held on AWS. */
function standingHtml (model) {
    const copy = standingCopy(model.standing, model.data);
    if ( model.standing === 'grace' ) {
        return `<div class="ezil-computer-switch is-failed" data-role="payment-grace" role="status"><p>${html_encode(copy)}</p>
            <a class="ezil-settings-btn" data-action="fix-payment" href="/os?settings=billing">Fix payment</a></div>`;
    }
    if ( model.standing === 'plan_ending' ) return `<div class="ezil-computer-switch" data-role="plan-ending" role="status"><p>${html_encode(copy)}</p></div>`;
    if ( model.held ) return `<div class="ezil-computer-switch" data-role="files-held" role="status"><p>${html_encode(copy)}</p></div>`;
    return '';
}

/**
 * The switch's steps from server milestones only. Step 2 says whether a ready
 * machine was found: a switch's expected time is the 60 s stop plus the warm
 * or the cold wake (contract §3), so ≥ 300 s means a machine is being prepared.
 */
export function switchSteps (switching, prog, data = summary) {
    const keys = new Set((prog?.milestones ?? []).map(m => m?.key));
    const cold = Number(prog?.expectedSeconds) >= 300;
    const vcpu = sizeInfo(switching.target, data)?.vcpu;
    const getting = `Getting ${/^(8|11|18)$/.test(String(vcpu)) ? 'an' : 'a'} ${vcpu} vCPU machine`;
    const index = ! switching.acknowledged || switching.phase === 'requested' || switching.phase === 'stopping' ? 0
        : keys.has('files_attached') || keys.has('desktop_starting') ? 3 : keys.has('host_claimed') ? 2 : 1;
    const detail = index === 1 ? cold ? 'preparing a new machine — can take a few minutes' : keys.has('host_claimed') ? 'ready machine found' : ''
        : index > 1 && ! cold ? 'ready machine found' : '';
    return { index, steps: ['Saving and closing your session', detail ? `${getting} — ${detail}` : getting, 'Attaching your files', 'Starting your desktop'] };
}

/** One bar: milestone floor + server-relative elapsed time, capped below 100 % and never moving back. */
export function switchRatio (switching, prog, index) {
    const started = Date.parse(prog?.openingStartedAt ?? ''), observed = Date.parse(prog?.observedAt ?? '');
    const expected = Number(prog?.expectedSeconds);
    const timed = Number.isFinite(started) && Number.isFinite(observed) && expected > 0 ? (observed - started) / 1000 / expected : 0;
    const raw = Math.min(0.95, Math.max(index / 4, Math.min(timed, (index + 1) / 4)));
    const id = transitionOf(prog)?.transitionId ?? 'pending';
    const shown = Math.max(raw, barFloor.get(id) ?? 0);
    barFloor.set(id, shown);
    return shown;
}

/**
 * D6: a configuration tile that sells. Title, ONE honest benefit line, the weight
 * note ("Counts 2× of your monthly time"), and for a locked tile the plan that
 * includes it with a visible Upgrade. No speed promise (scanCopy, honestyBans).
 */
export const CONFIG_BENEFIT = {
    'free-cf': 'Room to try EZiL OS and build small projects',
    'std-2': 'Room for everyday coding with a browser open',
    'cmp-4': 'Room for builds and a few browsers at once',
    'cmp-8': 'Room for large builds and many apps open at once',
};
const LOCK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

function cardHtml (card, model) {
    const title = `${card.vcpu} vCPU · ${card.memoryGiB} GB`;
    const weight = card.size === 'free-cf' ? 'Cloudflare · sessions up to 1 hour' : card.weight > 1 ? `Counts ${card.weight}× of your monthly time` : 'Counts 1× of your monthly time';
    let action = '';
    if ( card.state === 'current' ) action = '<span class="ezil-settings-pill" data-role="config-current">Current</span>';
    else if ( card.state === 'available' ) action = `<button type="button" class="ezil-settings-btn" data-action="switch-config" data-size="${html_encode(card.size)}"${model.busy || stopBusy ? ' disabled' : ''}>Switch</button>`;
    else if ( card.state === 'switching' ) action = '<span class="ezil-settings-pill" data-role="config-switching">Switching…</span>';
    else if ( card.state === 'next' ) action = '<span class="ezil-settings-pill" data-role="config-next">Next start</span>';
    else if ( card.state === 'locked' ) action = `<a class="ezil-settings-btn ezil-computer-upgrade" data-action="config-upgrade" href="/os?settings=billing&amp;upgrade=${card.plan === 'Standard' ? 'standard' : 'premium'}">Upgrade</a>`;
    else if ( card.state === 'unavailable' ) action = `<span class="ezil-computer-unavailable" data-role="config-unavailable">${html_encode(refusalCopy('capacity_unavailable', card.size, model.data, model.current))}</span>`;
    return `<li class="ezil-computer-config" data-size="${html_encode(card.size)}" data-state="${card.state}">
        <div class="ezil-computer-config-body"><strong data-role="config-title">${html_encode(title)}</strong>
            <span class="ezil-computer-config-benefit" data-role="config-benefit">${html_encode(CONFIG_BENEFIT[card.size] ?? '')}</span>
            <span class="ezil-settings-muted" data-role="config-weight">${html_encode(weight)}</span>
            ${card.state === 'locked' ? `<span class="ezil-computer-lock" data-role="config-locked">${LOCK_ICON}${html_encode(`Included in ${card.plan}`)}</span>` : ''}</div>
        <div class="ezil-computer-config-action">${action}</div></li>`;
}

function statusHtml (model, prog) {
    if ( model.switching ) {
        const { index, steps } = switchSteps(model.switching, prog, model.data);
        const ratio = switchRatio(model.switching, prog, index);
        const percent = Math.round(ratio * 100);
        return `<div class="ezil-computer-switch" data-role="switch-progress">
            <p data-role="switching-label" role="status" aria-live="polite"><strong>Switching…</strong></p>
            <p data-role="now-label">Now: ${html_encode(sizeLabel(model.switching.current, model.data))}</p>
            <p data-role="next-label">Next: ${html_encode(sizeLabel(model.switching.target, model.data))}</p>
            <div class="ezil-computer-bar" role="progressbar" aria-label="Switch progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div>
            <ol class="ezil-computer-steps">${steps.map((step, i) => `<li data-step="${i + 1}" data-state="${i < index ? 'done' : i === index ? 'active' : 'todo'}">${html_encode(step)}</li>`).join('')}</ol></div>`;
    }
    if ( model.done ) {
        // One primary per state (D6): Open desktop is the header's.
        return `<div class="ezil-computer-switch is-done" data-role="switch-done" role="status">
            <p>${html_encode(`Now running on ${sizeLabel(model.done.target, model.data)}`)}</p></div>`;
    }
    if ( model.failed ) {
        const t = model.failed;
        const cap = CAP_REASONS.has(t.reason);
        const retry = ! cap && RETRYABLE.test(String(t.reason ?? ''));
        // HF3: the size it actually runs (the placement), else the pre-switch size; never offer a switch to that same size.
        const on = model.current ?? t.current;
        const copy = cap ? AWS_CAP_COPY : `We couldn't switch to ${sizeLabel(t.target, model.data)}. Your computer is on ${sizeLabel(on, model.data)} and your files are safe.`;
        return `<div class="ezil-computer-switch is-failed" data-role="switch-failed" role="alert">
            <p>${html_encode(copy)}</p><div class="ezil-settings-row-actions">
            ${retry ? `<button type="button" class="ezil-settings-btn" data-action="switch-retry" data-size="${html_encode(t.target)}">Try again</button>` : ''}
            ${t.revertAvailable && on !== t.current ? `<button type="button" class="ezil-settings-btn" data-action="switch-back" data-size="${html_encode(t.current)}">${html_encode(`Back to ${sizeLabel(t.current, model.data)}`)}</button>` : ''}
            ${feedback_enabled() ? '<button type="button" class="ezil-settings-btn" data-action="switch-feedback">Send feedback</button>' : ''}</div></div>`;
    }
    if ( model.nextStart ) {
        return `<div class="ezil-computer-switch" data-role="next-start" role="status">
            <p>${html_encode(`Next start: ${sizeLabel(model.nextStart, model.data)}`)}</p>
            <button type="button" class="ezil-settings-btn" data-action="open">Start now</button></div>`;
    }
    return '';
}

function manageHtml (computer) {
    if ( editingId === computer.id ) {
        return `<div class="ezil-settings-row" data-id="${html_encode(computer.id)}" data-role="computer-manage">
            <form class="ezil-settings-rename-form" data-role="rename-form">
                <input type="text" class="ezil-settings-input" data-role="rename-input" value="${html_encode(computer.name)}" maxlength="200" autocomplete="off">
                <div class="ezil-settings-row-actions"><button type="submit" class="ezil-settings-btn ezil-settings-btn-primary">Save</button>
                    <button type="button" class="ezil-settings-btn" data-action="cancel-rename">Cancel</button></div></form></div>`;
    }
    const isBusy = busyId === computer.id;
    return `<div class="ezil-settings-row" data-id="${html_encode(computer.id)}" data-role="computer-manage">
        <div class="ezil-settings-row-meta"><div class="ezil-settings-row-name">${html_encode(computer.name)}</div>
            <div class="ezil-settings-row-sub">Name shown in your browser tab and window titles</div></div>
        <div class="ezil-settings-row-actions"><button type="button" class="ezil-settings-btn" data-action="rename"${isBusy ? ' disabled' : ''}>Rename</button>
            <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="delete" hidden${isBusy ? ' disabled' : ''}>${isBusy ? 'Removing…' : 'Delete'}</button></div></div>`;
}

function olderHtml (rows) {
    if ( rows.length === 0 ) return '';
    // D6, the one-computer model: an older computer is kept (data and the delete path stay) but not shown on the web.
    return `<section class="ezil-computer-section" data-role="older-computers" aria-labelledby="ezil-older-heading" hidden>
        <h4 id="ezil-older-heading">Older computer</h4>
        <p class="ezil-settings-muted">Kept from before you had one computer. It can't be opened from here; delete it when you no longer need it.</p>
        ${rows.map(c => `<div class="ezil-settings-row" data-id="${html_encode(c.id)}" data-role="older-computer">
            <div class="ezil-settings-row-meta"><div class="ezil-settings-row-name">${html_encode(c.name)}</div>
                <div class="ezil-settings-row-sub">${html_encode(timeAgo(c.lastOpenedAt ?? c.createdAt) ? `Last active ${timeAgo(c.lastOpenedAt ?? c.createdAt)}` : 'Never opened')}</div></div>
            <div class="ezil-settings-row-actions"><button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="delete"${busyId === c.id ? ' disabled' : ''}>${busyId === c.id ? 'Removing…' : 'Delete'}</button></div></div>`).join('')}
    </section>`;
}

/** The whole web pane for one computer. Exported for the unit tests. */
export function computerHtml (model, prog = progress, older = []) {
    const { computer, data } = model;
    const size = sizeInfo(model.current, data);
    const disk = model.disk?.provisionedGiB;
    const summaryLine = size ? [`${size.vcpu} vCPU`, `${size.memoryGiB} GB memory`, ...(Number.isFinite(disk) ? [`${disk} GB disk`] : [])].join(' · ') : '';
    const choices = (data?.computer?.machineChoice ?? []).map(m => m.vcpu);
    const premiumOnly = AWS_SIZES.filter(code => ! (data?.computer?.machineChoice ?? []).some(m => m.size === code)).map(code => SIZE_FALLBACK[code].vcpu);
    const planLine = ! data ? '' : model.held ? 'Upgrade to restore full use.' : premiumOnly.length && ! model.free
        ? `Your plan includes ${choices.join(', ')} vCPU. Premium unlocks ${premiumOnly.join(' and ')} vCPU.`
        : model.free ? 'Your plan includes a 2 vCPU computer on Cloudflare. Standard and Premium give you your own computer on AWS (India).'
            : `Your plan includes ${choices.slice(0, -1).join(', ')} and ${choices.at(-1)} vCPU.`;
    const used = typeof model.disk?.usedBytes === 'string' && /^\d+$/.test(model.disk.usedBytes) ? Number(model.disk.usedBytes) / 2 ** 30 : null; // the disk's own unit (GiB), like its size
    const stoppable = model.running && ! model.busy;
    return `<section class="ezil-computer" data-role="your-computer" data-id="${html_encode(computer.id)}">
        <header class="ezil-computer-header" data-role="computer-header">
            <div class="ezil-computer-identity"><h3>Your computer</h3>
                <p class="ezil-computer-meta"><span data-role="computer-name">${html_encode(computer.name)}</span>
                ${model.provider ? `<span class="ezil-settings-muted" data-role="computer-provider">${html_encode(model.provider)}</span>` : ''}
                ${model.chip ? `<span class="ezil-settings-pill ezil-computer-chip" data-role="computer-chip" data-state="${model.chip.state}">${html_encode(model.chip.text)}</span>` : ''}</p>
                ${summaryLine ? `<p class="ezil-computer-summary" data-role="computer-summary">${html_encode(summaryLine)}</p>` : ''}</div>
            <div class="ezil-settings-row-actions" data-role="computer-actions">
                <button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="open"${model.busy || busyId ? ' disabled' : ''}>Open desktop</button>
                ${stoppable || stopBusy ? `<button type="button" class="ezil-settings-btn" data-action="stop"${stopBusy ? ' disabled' : ''}>${stopBusy ? 'Stopping…' : 'Stop'}</button>` : ''}</div>
        </header>
        ${statusHtml(model, prog)}
        ${model.switching ? '' : moveHtml(model)}
        ${standingHtml(model)}
        ${notice ? `<p class="${notice.tone === 'error' ? 'ezil-settings-error' : 'ezil-settings-muted'}" data-role="computer-notice" role="status">${html_encode(notice.text)}</p>` : ''}
        ${model.cards.length ? `<section class="ezil-computer-section" aria-labelledby="ezil-config-heading"><h4 id="ezil-config-heading">Configuration</h4>
            <p class="ezil-settings-muted">${model.free ? 'Pick a size for your computer. More sizes come with Standard and Premium.' : 'Pick a size for your computer. Your files stay on your disk when you switch.'}</p>
            <ul class="ezil-computer-configs" data-role="config-grid">${model.cards.map(card => cardHtml(card, model)).join('')}</ul>
            <p class="ezil-settings-muted" data-role="plan-line">${html_encode(planLine)} <a href="/os?settings=billing&amp;upgrade=pro" data-action="compare-plans">Compare plans</a></p></section>` : ''}
        ${data ? `<section class="ezil-computer-section" data-role="computer-storage" aria-labelledby="ezil-storage-heading"><h4 id="ezil-storage-heading">Storage</h4>
            <p>${html_encode(Number.isFinite(disk) ? `${disk} GB disk for your projects` : 'Your files are saved with your computer.')}</p>
            ${used !== null && Number.isFinite(disk) ? `<p data-role="storage-used">${html_encode(`${used.toLocaleString(undefined, { maximumFractionDigits: 1 })} of ${disk} GB used`)}</p>` : ''}
            ${Number.isFinite(disk) ? `<p class="ezil-settings-muted">${model.disk?.growsOnSwitch === true ? 'It grows when you switch to a larger size and never shrinks.' : 'It keeps its size when you switch configuration.'}</p>` : ''}</section>` : ''}
        ${manageHtml(computer)}
    </section>${olderHtml(older)}`;
}

/** The computer every launch uses; the open desktop's stamp, then the lowest slot, are fallbacks. */
function mainComputer () {
    const id = session.currentComputer()?.id ?? openDesktopComputerId() ?? undefined;
    return computers.find(c => c.id === id) ?? [...computers].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))[0] ?? null;
}

/** This activation's lifecycle read for `computer`, or null while it is unknown. */
function currentProgress (computer) {
    if ( ! progress || progressGen !== generation ) return null;
    return progress.computerId === undefined || progress.computerId === computer.id ? progress : null;
}

function webModel () {
    const computer = mainComputer();
    if ( ! computer ) return null;
    const prog = currentProgress(computer);
    const t = transitionOf(prog);
    if ( t && IN_FLIGHT.has(t.phase) ) seenInFlight.add(t.transitionId);
    return computerModel({ computer, data: summary, prog,
        pending: pendingSwitch?.computerId === computer.id ? pendingSwitch : null,
        refusedSizes: unavailable, streaming: desktopStreams(computer.id) === true, stopping: stopBusy });
}

function renderWeb ($list) {
    const model = webModel();
    if ( ! model ) {
        $list.html('<div class="ezil-settings-muted" data-role="no-computer">Your computer is set up the first time you open the desktop.</div>');
        return;
    }
    $list.html(computerHtml(model, currentProgress(model.computer), computers.filter(c => c.id !== model.computer.id)));
}

function schedulePoll ($win) {
    // A CLOSED window's late caller (its Stop answering after Settings closed) must not
    // cancel the poll of the window that is open now.
    if ( ! $win.get(0)?.isConnected ) return;
    clearTimeout(pollTimer);
    pollTimer = null;
    if ( ! paneActive || isNative() ) return;
    const fast = pendingSwitch || inFlight(progress) || progress?.operation === 'opening' || progress?.operation === 'stopping' || stopBusy;
    pollTimer = setTimeout(() => { void refreshProgress($win); }, fast ? 3000 : 20000);
}

/** Billing's own gate (`tabs/billing.js` `available`): where Billing is off, no summary is requested. */
function billingOn () {
    return TabBilling.available(paneCtx ?? { payload: session.payload() });
}

async function readSummary () {
    if ( ! billingOn() ) { summary = null; return; }
    const res = await trpc.query('billing.summary').catch(() => ({ ok: false }));
    summary = res?.ok && res.data?.enabled === true && res.data.version === 3 ? res.data : null;
}

async function refreshProgress ($win) {
    // A closed window (a Stop that answered after Settings closed) neither reads into nor
    // repaints the window open now; that window reads on its own activation and poll.
    if ( ! $win.get(0)?.isConnected ) return;
    const computer = mainComputer();
    if ( ! computer || ! paneActive ) { schedulePoll($win); return; }
    const mine = generation;
    const before = transitionOf(currentProgress(computer));
    const res = await trpc.query('computer.progress', { computerId: computer.id }).catch(() => ({ ok: false }));
    if ( mine !== generation ) return;
    if ( res?.ok && res.data ) {
        progress = { ...res.data, computerId: res.data.computerId ?? computer.id };
        progressGen = mine;
        const t = transitionOf(progress);
        // Hotfix r5 review: a stop (here or in another tab) ends the run "Now running on …" was about —
        // dismissed, not just hidden, so the next Start does not bring the same done transition back.
        if ( t?.phase === 'done' && (progress.lifecycleState === 'STOPPED' || progress.operation === 'stopping') ) dismissed.add(t.transitionId);
        if ( t && ! IN_FLIGHT.has(t.phase) && (t.phase === 'done' || t.phase === 'failed') ) {
            clearSwitchRequestId(computer.id, t.target);
            if ( before && IN_FLIGHT.has(before.phase) && before.transitionId === t.transitionId ) await readSummary();
        }
    }
    if ( mine !== generation ) return;
    if ( ! editingId ) render($win); // never repaint over a rename in progress
    schedulePoll($win);
}

async function confirmAlert (title, body, confirmLabel) {
    const value = await UIAlert({
        message: `<strong>${html_encode(title)}</strong><p>${html_encode(body)}</p>`,
        type: 'warning', body_icon: ALERT_WARNING_ICON,
        buttons: [{ label: confirmLabel, value: 'confirm', type: 'primary' }, { label: 'Cancel', value: 'cancel', type: 'secondary' }],
    });
    return value === 'confirm';
}

async function postSwitch (computerId, size, requestId) {
    const url = session.payload()?.desktopState?.endpoints?.switch;
    if ( typeof url === 'string' && url ) {
        try {
            const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ computerId, size, requestId }) });
            if ( res.status === 401 ) return { ok: false, reason: 'unauthorized' };
            const data = await res.json().catch(() => null);
            return res.ok && data && typeof data.ok === 'boolean' ? data : { ok: false, reason: 'error' };
        } catch { return { ok: false, reason: 'error' }; }
    }
    const res = await trpc.mutate('computer.switchConfiguration', { computerId, size, requestId });
    return res.ok && res.data && typeof res.data.ok === 'boolean' ? res.data : { ok: false, reason: res.code === 'UNAUTHORIZED' ? 'unauthorized' : 'error' };
}

/**
 * The switch. The card and chip change BEFORE the request leaves (the
 * acknowledgement), and a second click while it is pending does nothing.
 */
/**
 * D6 confirmation copy (mobbin-compute brief): what restarts, what is kept, how
 * long. Pure, so the copy is unit-tested; `confirmAction` shows it.
 */
export function confirmCopy (kind, { target = null, current = null, data = summary } = {}) {
    if ( kind === 'switch' ) {
        const to = sizeInfo(target, data)?.weight ?? 1, from = sizeInfo(current, data)?.weight ?? 1;
        return { title: `Switch to ${sizeLabel(target, data)}?`, confirmLabel: 'Restart and switch', busyLabel: 'Starting switch…', lines: [
            'Your computer restarts on the new size. Open apps close; save your work first.',
            'Your files stay on your disk.',
            'This usually takes 1-4 minutes.',
            ...(to !== from ? [`At this size, an hour of use counts as ${to} hour${to === 1 ? '' : 's'} of your monthly time.`] : []),
        ] };
    }
    return { title: 'Stop your computer?', confirmLabel: 'Stop', busyLabel: 'Stopping…', lines: [
        'Open apps close; save your work first.',
        'Your files stay on your disk.',
        'Start it again any time with Open desktop.',
    ] };
}

/**
 * Shows the confirmation as the shared sheet frame (`../sheet-frame.js`
 * `openConfirmSheet`, reached through the Billing tab module so this file keeps
 * its import list). `onConfirm` runs with the primary disabled; resolves true
 * once it has run, false when the user declined. Without the sheet (a stubbed
 * host) it falls back to the legacy alert.
 */
async function confirmAction ($win, kind, args, onConfirm) {
    const copy = confirmCopy(kind, args);
    if ( typeof TabBilling.confirmSheet === 'function' ) {
        const container = $win?.find?.('.window-body')?.get?.(0) ?? $win?.get?.(0) ?? document.body;
        return TabBilling.confirmSheet({ container, sheet: `confirm-${kind}`, title: copy.title, lines: copy.lines,
            confirmLabel: copy.confirmLabel, busyLabel: copy.busyLabel, onConfirm });
    }
    if ( ! await confirmAlert(copy.title, copy.lines.join(' '), copy.confirmLabel) ) return false;
    await onConfirm?.();
    return true;
}

/**
 * The switch. The card and chip change BEFORE the request leaves (the
 * acknowledgement), and a second click while it is pending does nothing. On a
 * running computer the request leaves from the confirmation's primary, which
 * stays disabled until the server answers.
 */
export async function requestSwitch ($win, target, { confirm = true } = {}) {
    const computer = mainComputer();
    if ( ! computer || pendingSwitch || inFlight(progress) || stopBusy ) return;
    const model = webModel();
    // Back to <previous> after a failure targets the current size on purpose: it reverts the choice.
    if ( ! model || target === model.current && ! model.nextStart && ! model.failed ) return;
    const restarts = model.running || progress?.lifecycleState === 'RUNNING';
    const run = async () => {
        if ( pendingSwitch || inFlight(progress) || stopBusy ) return;
        pendingSwitch = { computerId: computer.id, current: model.current, target };
        notice = null;
        unavailable.delete(target);
        render($win);
        const requestId = switchRequestId(computer.id, target);
        const answer = await postSwitch(computer.id, target, requestId);
        pendingSwitch = null;
        if ( answer.ok ) {
            if ( model.failed ) dismissed.add(model.failed.transitionId);
            if ( answer.effective === 'next_start' ) {
                clearSwitchRequestId(computer.id, target);
                if ( summary?.computer ) summary = { ...summary, computer: { ...summary.computer, size: answer.target } };
            } else {
                seenInFlight.add(answer.transitionId);
                // Open desktop/Code windows follow the transition and re-open on the new size (L4b).
                window.dispatchEvent(new CustomEvent(TRANSITION_EVENT, { detail: { computerId: computer.id, transitionId: answer.transitionId } }));
                progress = { ...(progress ?? {}), computerId: computer.id,
                    transition: { transitionId: answer.transitionId, kind: 'switch', current: answer.current, target: answer.target,
                        phase: transitionOf(progress)?.transitionId === answer.transitionId ? transitionOf(progress).phase : 'requested',
                        reason: null, revertAvailable: false } };
                progressGen = generation; // the server's own answer, in this activation
            }
        } else {
            if ( answer.reason !== 'switch_in_progress' ) clearSwitchRequestId(computer.id, target);
            if ( answer.reason === 'capacity_unavailable' ) unavailable.add(target);
            notice = { text: refusalCopy(answer.reason, target, summary, model.current), tone: 'error' };
        }
        render($win);
        void refreshProgress($win);
    };
    if ( confirm && restarts ) await confirmAction($win, 'switch', { target, current: model.current, data: summary }, run);
    else await run();
}

async function handleStop ($win) {
    const computer = mainComputer();
    if ( ! computer || stopBusy || pendingSwitch || inFlight(progress) ) return;
    // The chip flips to Stopping… as the user confirms; the stop itself (≈ 40 s) runs after the sheet closes.
    let confirmed = false;
    await confirmAction($win, 'stop', { data: summary }, () => {
        if ( stopBusy || pendingSwitch || inFlight(progress) ) return;
        confirmed = true;
        stopBusy = true;
        notice = null;
        render($win);
    });
    if ( ! confirmed ) return;
    // Hotfix r5 review: from the confirm on, no hover over the Browser dock icon may warm (= start)
    // it again — set BEFORE the windows close, so a warm begun meanwhile cannot slip past the cancel.
    session.holdAfterStop?.(computer.id);
    // "Now running on …" belongs to the run that is ending: dismissed, so the next Start does not repeat it.
    const doneT = transitionOf(progress);
    if ( doneT?.phase === 'done' ) dismissed.add(doneT.transitionId);
    try {
        // Same guarantee as Delete: every window on this computer closes first.
        await closeSandboxWindows(computer.id);
        const res = await fetch('/api/shell/stop', { method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerId: computer.id }) }).catch(() => null);
        const data = res ? await res.json().catch(() => null) : null;
        if ( ! res?.ok || data?.ok === false ) notice = { text: "We couldn't confirm the stop. Try again in a moment.", tone: 'error' };
    } finally {
        stopBusy = false;
    }
    await refreshProgress($win);
}

function nativeRowHtml (slot, computer) {
    if ( ! computer ) {
        return `
            <div class="ezil-settings-row ezil-settings-row-empty" data-slot="${slot}">
                <span class="ezil-settings-row-slot">${slot}</span>
                <div class="ezil-settings-row-meta">
                    <div class="ezil-settings-row-name ezil-settings-muted">Empty slot</div>
                </div>
                <div class="ezil-settings-row-actions">
                    <button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="create">New computer</button>
                    ${isNative() ? '<button type="button" class="ezil-settings-btn" data-action="import">Open project folder…</button>' : ''}
                </div>
            </div>`;
    }

    // 🔴 "Current" is `session.currentComputer()` — the SAME value the dock,
    // Start menu and App Store launch with (`registry.js`'s `launchContext`).
    // Founder-reported 2026-10-18: this used to be "the desktop on screen, else this
    // module's own last-switched id" while the dock kept the boot payload's
    // computer, so Settings said Computer 1 while Code opened on Computer 2.
    // The open desktop's stamp is only a fallback for a payload-less host.
    // Closing the desktop window does not change which computer you are on:
    // the row stays Current and offers Open instead of Switch.
    const onScreen = isNative() ? window.__EZIL_BOOT__?.computer?.id : openDesktopComputerId();
    const currentId = isNative() ? (onScreen ?? session.currentComputer()?.id)
        : (session.currentComputer()?.id ?? onScreen);
    const isActive = currentId === computer.id;
    const needsOpen = !isNative() && onScreen !== currentId;
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
                <div class="ezil-settings-row-sub">${isNative() ? (computer.available === false ? 'Folder unavailable — locate it to continue' : computer.kind === 'attached' ? 'Original folder · edits stay in place' : 'EZiL-managed project') : (isActive ? (needsOpen ? 'Your current computer' : 'Active now') : (onScreen === computer.id ? 'Desktop still open' : (when ? `Active ${when}` : 'Never opened')))}</div>
            </div>
            <div class="ezil-settings-row-actions">
                ${isActive
                    ? `<span class="ezil-settings-pill">Current</span>${needsOpen ? `<button type="button" class="ezil-settings-btn" data-action="switch" ${isBusy ? 'disabled' : ''}>${isBusy ? 'Opening…' : 'Open'}</button>` : ''}`
                    : `<button type="button" class="ezil-settings-btn" data-action="switch" ${isBusy || computer.available === false ? 'disabled' : ''}>${isBusy ? 'Switching…' : 'Switch'}</button>`}
                ${isNative() ? (computer.available === false ? '<button type="button" class="ezil-settings-btn" data-action="relink">Locate folder…</button>' : '<button type="button" class="ezil-settings-btn" data-action="reveal">Finder</button><button type="button" class="ezil-settings-btn" data-action="openVSCode">VS Code</button><button type="button" class="ezil-settings-btn" data-action="openXcode">Xcode</button>') : ''}
                <button type="button" class="ezil-settings-btn" data-action="rename" ${isBusy ? 'disabled' : ''}>Rename</button>
                <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="delete" ${isBusy ? 'disabled' : ''}>
                    ${isBusy ? 'Removing…' : isNative() && computer.kind === 'attached' ? 'Detach' : 'Delete'}
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

    if ( isNative() ) {
        const bySlot = new Map(computers.map(c => [c.slot, c]));
        let html = '';
        for ( let slot = 1; slot <= computers.length; slot++ ) html += nativeRowHtml(slot, bySlot.get(slot));
        html += '<div class="ezil-settings-row"><div class="ezil-settings-row-actions"><button type="button" class="ezil-settings-btn ezil-settings-btn-primary" data-action="import">Open project folder…</button><button type="button" class="ezil-settings-btn" data-action="create">Create workspace</button></div></div>';
        $list.html(html);
    } else {
        // A poll repaints the pane; keep keyboard focus on the same control.
        const focused = $list.get(0).contains(document.activeElement) ? document.activeElement : null;
        const action = focused?.dataset?.action, size = focused?.dataset?.size;
        renderWeb($list);
        if ( action ) [...$list.get(0).querySelectorAll('[data-action]')]
            .find(el => el.dataset.action === action && (el.dataset.size ?? null) === (size ?? null) && ! el.disabled)?.focus();
    }
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
    // Only the SHOWN pane reads more: `billing.summary` has side effects
    // (Stripe preview, Gateway read), so a hidden tab must not call it.
    if ( isNative() || ! paneActive ) return;
    // The plan, the configurations it allows and the disk come from the billing
    // summary; the live state (running, stopped, switching) from progress.
    // Follow-up r5 (ACCEPT-9a755827 FINDING 2): asked TOGETHER, so the lifecycle is
    // unknown for one progress request, not for list + the slow summary + progress.
    const mine = ++generation;
    await Promise.all([readSummary(), refreshProgress($win)]);
    if ( mine !== generation ) return;
    if ( ! editingId ) render($win); // the summary may have answered after progress painted
    if ( ! queuedSwitch ) return;
    const size = queuedSwitch;
    queuedSwitch = null;
    void requestSwitch($win, size, { confirm: true });
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

async function handleImport ($win) {
    const res = await trpc.mutate('computer.import', {});
    if ( ! res.ok ) {
        reportError(res.code === 'FORBIDDEN'
            ? "You've reached your computer limit."
            : 'Failed to import the project. Please try again.');
        return;
    }
    await load($win);
}

async function switchTo (computer, ctx, $win) {
    if ( desktopStreams(computer.id) === true || busyId ) return;
    busyId = computer.id;
    render($win);
    try {
        if (isNative(ctx)) {
            const selected = await trpc.mutate('computer.select', { id: computer.id });
            if (!selected.ok) reportError(selected.message || 'Could not switch local workspaces.');
            return; // The host confirms running work before replacing this shell.
        }
        // 🔴 Same reason as delete, generalised: EVERY open sandbox window
        // (desktop AND Preview AND Code — single_instance only bounds each
        // app to one window each, not the count of apps open at once) is
        // currently streaming a DIFFERENT container, about to switch out
        // from under it. Closing them all first means each one's own
        // client-side teardown runs on purpose, instead of its iframe being
        // yanked out from under a window that `registry.launch` would
        // otherwise just re-focus. No `id` argument: we are leaving whatever
        // is open behind regardless of which computer it belonged to.
        //
        // Except on Open (the target already IS the current computer): a Code
        // or Preview window positively streaming it is not being left behind,
        // so it stays. Unknown or other-computer windows still close.
        const keepId = session.currentComputer()?.id === computer.id ? computer.id : undefined;
        await closeSandboxWindows(undefined, keepId);
        if (isNative(ctx)) {
            const selected = await trpc.mutate('computer.select', { id: computer.id });
            if (!selected.ok) { reportError('Could not switch local workspaces.'); return; }
            // Preload may reload /os to renew its workspace-scoped capability.
            window.__EZIL_BOOT__.computer = computer;
            if (ctx.payload) ctx.payload.computer = computer;
        }
        activeComputerId = computer.id;
        session.setCurrentComputer(computer);
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
    const copy = isNative() ? {
        title: `${computer.kind === 'attached' ? 'Detach' : 'Delete'} “${computer.name}”?`,
        body: [computer.kind === 'attached' ? 'Your original project folder and its files will stay exactly where they are. Only its EZiL profiles and association are removed.' : 'This deletes the EZiL-managed project files and its editor and browser profiles. This cannot be undone.'],
        confirmLabel: computer.kind === 'attached' ? 'Detach project' : 'Delete workspace', cancelLabel: 'Cancel'
    } : deleteComputerCopy({ name: computer.name, slot: computer.slot });
    const confirmed = await confirmDelete(copy);
    if ( ! confirmed ) return;

    busyId = computer.id;
    render($win);
    try {
        // 🔴 THE GUARANTEE. `computer.delete` -> `terminateComputerSandbox`
        // (`app/src/server/api/routers/computer.ts`) destroys the very
        // sandbox ANY open sandbox window is streaming — the desktop, but
        // just as much Preview or Code, since all three are container
        // windows on the same sandbox (see `SANDBOX_WINDOW_SELECTOR`'s
        // comment for the measured defect this replaced: a live Preview
        // iframe still pointed at the container the instant `computer.delete`
        // left the browser, because closing was keyed on `data-app="desktop"`
        // and Preview is a different `data-app`). Closing every sandbox
        // window FIRST means each one's client tears its own connection down
        // on its own terms; calling delete first would leave the user
        // watching windows die mid-frame while their iframes reconnect-loop
        // against a container that no longer exists.
        //
        // 🔴 FAILS SAFE. `closeSandboxWindows(computer.id)` closes a window
        // unless it is POSITIVELY known to stream a different computer (see
        // `windowStreams()`). The two errors here are not symmetric: closing
        // a window we did not have to close costs one reopen, while not
        // closing one we should have is precisely the failure this guarantee
        // exists to prevent. Round 1 had this backwards — it closed only on
        // a positive match against a variable that was empty on the
        // rehydrate path.
        if (!isNative()) await closeSandboxWindows(computer.id);

        const res = await trpc.mutate('computer.delete', { id: computer.id });
        if ( ! res.ok && res.code !== 'NOT_FOUND' ) {
            // NOT_FOUND means it is already gone (another tab, a stale
            // list) — a refresh, not a failure, mirroring `/computers`'
            // own `handleDelete`.
            reportError(res.message || 'Failed to delete computer. Please try again.');
            return;
        }
        if ( session.currentComputer()?.id === computer.id ) session.setCurrentComputer(null);
        await load($win);
    } finally {
        busyId = null;
    }
}

function bind ($win, ctx) {
    const $list = $win.find('[data-role="slot-list"]');

    $list.on('click', '[data-action="create"]', () => { void handleCreate($win); });
    $list.on('click', '[data-action="import"]', () => { void handleImport($win); });
    $list.on('click', '[data-action="retry"]', () => { void load($win); });
    $list.on('click', '[data-action="relink"], [data-action="reveal"], [data-action="openVSCode"], [data-action="openXcode"]', async function () {
        if (!isNative(ctx)) return;
        const id = $(this).closest('.ezil-settings-row').attr('data-id');
        const res = await trpc.mutate(`computer.${this.dataset.action}`, { id });
        if (!res.ok) reportError(res.message || 'The action could not complete.');
        if (this.dataset.action === 'relink') await load($win);
    });

    // One computer (web): open, stop and the configuration switch.
    $list.on('click', '[data-action="open"]', () => {
        const computer = mainComputer();
        const t = transitionOf(progress);
        if ( t?.phase === 'done' ) dismissed.add(t.transitionId);
        if ( computer ) void switchTo(computer, ctx, $win);
    });
    $list.on('click', '[data-action="stop"]', () => { void handleStop($win); });
    $list.on('click', '[data-action="switch-config"], [data-action="switch-retry"], [data-action="switch-back"]', function () {
        if ( this.disabled ) return;
        // Back to <previous> and Try again are ordinary switches with a fresh request id.
        if ( this.dataset.action !== 'switch-config' ) { const c = mainComputer(); if ( c ) clearSwitchRequestId(c.id, this.dataset.size); }
        void requestSwitch($win, this.dataset.size, { confirm: this.dataset.action === 'switch-config' });
    });
    $list.on('click', '[data-action="switch-feedback"]', function () {
        if ( feedback_enabled() ) open_feedback_dialog({ source: 'settings-computer' });
    });
    // Phase B (dormant while computer.move is null): the move restarts on the next open (D20).
    $list.on('click', '[data-action="move-retry"]', () => {
        const computer = mainComputer();
        if ( computer ) void switchTo(computer, ctx, $win);
    });
    $list.on('click', '[data-action="move-feedback"]', function () {
        if ( feedback_enabled() ) open_feedback_dialog({ source: 'settings-computer', errorCode: this.dataset.code });
    });

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
    get label () { return isNative() ? 'Computers' : 'Computer'; },
    icon: COMPUTERS_ICON,

    html () {
        return `
            <div class="ezil-settings-pane-body">
                ${isNative() ? `<p class="ezil-settings-lead">Open an original project folder or create a managed workspace. One workspace runs at a time. Attached project files remain yours when detached.</p>` : ''}
                <div class="ezil-settings-slot-list" data-role="slot-list">
                    <div class="ezil-settings-loading">Loading your computer…</div>
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
     * still true, the fresh window's list got no handlers, and every button
     * was dead.
     *
     * Re-binding cannot duplicate handlers, because `index.js` calls `init`
     * exactly once per window and each window brings a brand-new element.
     *
     * Transient per-window state is reset for the same reason: an
     * `editingId`, a `busyId` or a pending switch left over from a window that
     * no longer exists would render a rename form, a permanently disabled
     * row, or a stuck "Switching…" in the new one. The server's progress is
     * read again on every activation.
     */
    init ($win, ctx) {
        editingId = null;
        busyId = null;
        loadError = null;
        pendingSwitch = null;
        notice = null;
        stopBusy = false;
        progress = null; // never paint lifecycle from a previous window's life
        unavailable = new Set();
        // The fallback hint only — `openDesktopComputerId()` prefers the
        // stamp on the window itself. Read HERE rather than at module-eval
        // time, so the rehydrate path (payload arrives from
        // `/api/shell/session` after this module was imported) is not seeded
        // empty. See the note on `activeComputerId`.
        if ( activeComputerId === undefined ) {
            activeComputerId = ctx?.computer?.id ?? session.payload()?.computer?.id ?? undefined;
        }
        paneCtx = ctx ?? null;
        bind($win, ctx);
        const onSwitchRequest = event => { if ( AWS_SIZES.includes(event.detail?.size) ) queuedSwitch = event.detail.size; };
        window.addEventListener('ezil:computer-switch-request', onSwitchRequest);
        $win.on('remove.computers', () => {
            paneActive = false; generation++; clearTimeout(pollTimer); pollTimer = null; queuedSwitch = null; progress = null;
            window.removeEventListener('ezil:computer-switch-request', onSwitchRequest);
        });
        paneActive = false;
        void load($win);
    },

    onActivate ($win) {
        // Cheap and idempotent — a re-activation (switching back to this
        // tab) should show current data, not what was true when the window
        // opened.
        paneActive = true;
        void load($win);
    },

    onDeactivate () {
        paneActive = false;
        generation++;
        progress = null; // the lifecycle may change while the tab is away; read it again on return
        clearTimeout(pollTimer);
        pollTimer = null;
    },
};
