// feedback.js — EZiL-authored. Optional description and explicit local image attachments.
// Diagnostics and screenshots are selected by default; nothing uploads until Send.
// Wire/API signatures are pinned in docs/FEEDBACK-CONTROLS-CONTRACT.md.
import { app_failure_diagnostics_accepted, build_diagnostics } from './diagnostics.js';
import { scan } from './secret-scan.js';
import { encode_under_limit, open_redact_editor } from './redact-editor.js';
import { uploaded_image_canvas } from './image-file.js';
import { currentComputer } from '../../session.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
    + '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>';
// The form is one optional description. The category is fixed to 'bug' (the
// schema still requires one). Drafts saved by the earlier structured bug form
// keep their text: it is folded into the description.
const CATEGORY = 'bug';
const LEGACY_BUG_FIELDS = [['activity', 'What were you doing?'], ['steps', 'Steps to reproduce'],
    ['expected', 'Expected result'], ['actual', 'Actual result'], ['reproducibility', 'Reproducibility'], ['impact', 'Impact']];
const DESCRIPTION_MAX = 4000;
const IMAGE_BYTES_MAX = Math.floor(1.5 * 1024 * 1024);
const IMAGE_SIDE_MAX = 4096;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
// Keep in sync with app/src/server/feedback/types.ts FEEDBACK_LIMITS.imagesMax / imagesBytesTotal. The
// server advertises its image count as `ui.feedbackScreenshotsMax`; a server that does not keeps one image.
const IMAGES_MAX_SUPPORTED = 5;
const IMAGES_BYTES_TOTAL = Math.floor(1.75 * 1024 * 1024);
/** Decoded size of a base64 image. */
const base64_bytes = data => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
function legacy_text (description, bug) {
    const parts = LEGACY_BUG_FIELDS.map(([key, title]) => [title, String(bug?.[key] ?? '').trim()]).filter(([, value]) => value);
    if ( ! parts.length ) return description;
    return [description.trim() ? ['Summary / context', description.trim()] : null, ...parts]
        .filter(Boolean).map(([title, value]) => `${title}\n${value}`).join('\n\n');
}
const DRAFT_KEY = 'ezil:feedback:draft:v1:';
const OUTBOX_KEY = 'ezil:feedback:outbox:v1:';
const OUTBOX_MAX = 10;
let chipObserver = null;
/** `matchMedia('(pointer: coarse)')` and the icon's sync it calls on a change. */
let chipPointer = null;
let chipPointerSync = null;
let activeDialog = null;
let onlineListening = false;
const inflight = new Set();

function unmount_feedback_chip () {
    chipObserver?.disconnect();
    chipObserver = null;
    chipPointer?.removeEventListener?.('change', chipPointerSync);
    chipPointer = null;
    chipPointerSync = null;
    document.querySelector('button.ezil-feedback-chip')?.remove();
    window.removeEventListener('ezil:teardown', unmount_feedback_chip);
    window.removeEventListener('pagehide', suspend_feedback_chip);
    window.removeEventListener('pageshow', mount_feedback_chip);
    window.removeEventListener('online', flush_feedback_outbox);
    onlineListening = false;
}

function suspend_feedback_chip () {
    unmount_feedback_chip();
    // A page restored from the back/forward cache does not run shell boot.
    window.addEventListener('pageshow', mount_feedback_chip, { once: true });
}

function endpoint () { return globalThis.window?.__EZIL_BOOT__?.desktopState?.endpoints?.feedback; }

/** @returns {boolean} true when the boot payload exposes endpoints.feedback */
export function feedback_enabled () { return !! endpoint(); }

// ── Per-account local state (round 3) ─────────────────────────────────────
// The DRAFT is what the form holds (category, description and its stable
// clientRequestId); it survives closing the dialog and is cleared only by a
// confirmed send. The OUTBOX holds the exact request bodies the user already
// submitted that have not been confirmed; each is re-sent byte-for-byte (same
// clientRequestId, so the server answers a replay with 200 and never stores a
// second row) on the `online` event and when the shell next mounts. Keyed by
// the account id only — never the email — and never sent anywhere.
function account_id () {
    try {
        const id = window.__EZIL_BOOT__?.user?.id;
        return typeof id === 'string' && UUID.test(id) ? id.toLowerCase() : null;
    } catch { return null; }
}

function store () {
    try { return window.localStorage ?? null; } catch { return null; }
}

function read_json (prefix) {
    const id = account_id(), s = store();
    if ( ! id || ! s ) return null;
    try { return JSON.parse(s.getItem(prefix + id) ?? 'null'); } catch { return null; }
}

function write_json (prefix, value) {
    const id = account_id(), s = store();
    if ( ! id || ! s ) return false;
    try {
        const encoded = value === null ? null : JSON.stringify(value);
        if (encoded === null) s.removeItem(prefix + id);
        else s.setItem(prefix + id, encoded);
        return s.getItem(prefix + id) === encoded;
    } catch { return false; }
}

function read_draft () {
    const d = read_json(DRAFT_KEY);
    if ( ! d || typeof d !== 'object' || typeof d.clientRequestId !== 'string' || ! UUID.test(d.clientRequestId) ) return null;
    const text = typeof d.description === 'string' ? d.description : '';
    return { clientRequestId: d.clientRequestId, category: CATEGORY,
        // Never truncated: an over-long migrated draft stays whole and the Send guard asks to shorten it.
        description: d.bug && typeof d.bug === 'object' ? legacy_text(text, d.bug) : text };
}

/** @param {{clientRequestId:string,category:string,description:string}|null} draft */
function write_draft (draft, keepBlank = false) {
    // A blank draft is kept only while its report is queued: reopening must resume that same request.
    write_json(DRAFT_KEY, draft && (keepBlank || draft.description.trim())
        ? { clientRequestId: draft.clientRequestId, category: CATEGORY, description: draft.description } : null);
}

function read_outbox () {
    const list = read_json(OUTBOX_KEY);
    if ( ! Array.isArray(list) ) return [];
    return list.filter(entry => {
        if ( ! entry || typeof entry.body !== 'string' || typeof entry.clientRequestId !== 'string' ) return false;
        try { return JSON.parse(entry.body)?.clientRequestId === entry.clientRequestId; } catch { return false; }
    }).slice(-OUTBOX_MAX);
}

function outbox_put (clientRequestId, body, stagedUploads, paused = false) {
    const list = read_outbox().filter(entry => entry.clientRequestId !== clientRequestId);
    const prior = read_outbox().find(entry => entry.clientRequestId === clientRequestId);
    const draft = read_draft();
    if (list.length >= OUTBOX_MAX) return false;
    list.push({ clientRequestId, body, paused, stagedUploads: stagedUploads ?? prior?.stagedUploads === true,
        draft: prior?.draft ?? (draft?.clientRequestId === clientRequestId ? draft : null) });
    return write_json(OUTBOX_KEY, list);
}

/** Pause only retry metadata; the submitted body and original account remain immutable. */
function outbox_pause (clientRequestId, account) {
    if (!account || !UUID.test(account)) return;
    const storage = store();
    try {
        const list = JSON.parse(storage?.getItem(OUTBOX_KEY + account) ?? 'null');
        if (!Array.isArray(list)) return;
        const entry = list.find(entry => entry.clientRequestId === clientRequestId);
        if (!entry?.stagedUploads) return;
        entry.paused = true;
        storage.setItem(OUTBOX_KEY + account, JSON.stringify(list));
    } catch { /* Existing raw images are still kept if retry metadata cannot be written. */ }
}

/** Explicit edits to a refused staged report replace its local paused copy atomically. */
function replace_paused_report (previousId, clientRequestId, body, description) {
    const list = read_outbox().map(entry => entry.clientRequestId === previousId
        ? { ...entry, clientRequestId, body, paused: true, draft: { clientRequestId, category: CATEGORY, description } } : entry);
    return write_json(OUTBOX_KEY, list);
}

function outbox_remove (clientRequestId) {
    const list = read_outbox().filter(entry => entry.clientRequestId !== clientRequestId);
    write_json(OUTBOX_KEY, list.length ? list : null);
}

function listen_online () {
    if ( onlineListening ) return;
    onlineListening = true;
    window.addEventListener('online', flush_feedback_outbox);
}

/** A send that did not reach a definitive answer: kept and retried with the same body. */
function retryable (status) { return status === 0 || status === 408 || status >= 500; }

/**
 * Roll back optional diagnostic extensions for older strict servers, or null
 * when the body has none. The remaining frozen report stays unchanged.
 */
function without_event_diagnostics (body) {
    try {
        const sent = JSON.parse(body);
        const events = sent?.diagnostics?.recentEvents;
        if (!sent?.diagnostics) return null;
        const before = JSON.stringify(sent.diagnostics);
        delete sent.diagnostics.session; delete sent.diagnostics.tracePhases; delete sent.diagnostics.traceApp;
        delete sent.diagnostics.appFailures;
        for (const event of events || []) { delete event.reason; delete event.correlationId; delete event.ageMs; }
        if (before === JSON.stringify(sent.diagnostics)) return null;
        return JSON.stringify(sent, null, 2);
    } catch { return null; }
}

/**
 * A stalled POST would otherwise leave "Sending…" up forever. The deadline is
 * a fixed allowance plus time to upload the body at a slow uplink, so the
 * client never gives up on a screenshot a weak link is still sending (any
 * server or proxy limit applies on its own and comes back as an answer or a
 * network error). The 1.5 MiB image cap bounds it near 9.5 minutes. Hitting
 * it is an unanswered send (status 0, `timedOut`): the outbox keeps the body,
 * and a re-send reuses its clientRequestId, which the server answers as a replay.
 */
export const SEND_DEADLINE = Object.freeze({ baseMs: 45_000, minUploadBytesPerSecond: 4096 });
export const send_deadline_ms = bytes => SEND_DEADLINE.baseMs + Math.ceil(bytes / SEND_DEADLINE.minUploadBytesPerSecond * 1000);

/** One POST. Never throws; `{ status, data, timedOut }` with status 0 = no usable answer. */
async function post (body, expectedAccount = null) {
    const controller = new AbortController();
    let timedOut = false;
    // Base64 and JSON are ASCII: the length is the byte count, give or take a non-ASCII description.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, send_deadline_ms(body.length));
    try {
        const response = await fetch(endpoint(), { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', ...(expectedAccount ? { 'X-EZiL-Feedback-Account': expectedAccount } : {}) }, body, signal: controller.signal });
        if ( response.status !== 200 && response.status !== 201 ) {
            let error; try { error = (await response.json())?.error; } catch { /* status remains definitive */ }
            return { status: response.status, data: null, timedOut, accountChanged: error === 'account_changed' };
        }
        const data = await response.json();
        return typeof data?.id === 'string' && UUID.test(data.id) ? { status: response.status, data, timedOut } : { status: 0, data: null, timedOut };
    } catch { return { status: 0, data: null, timedOut }; } finally { clearTimeout(timer); }
}

/** Digest of exactly the local image bytes shown in the thumbnail. */
export async function screenshot_sha256 (image) {
    const raw = Uint8Array.from(atob(image.dataBase64), char => char.charCodeAt(0));
    const digest = await crypto.subtle.digest('SHA-256', raw);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Two-phase Send; raw images stay in the original account's local outbox until final confirmation. */
async function send_report (body, stagedUploads, account, progress) {
    const current = () => account_id() === account;
    if (!current()) return { status: 0, data: null, accountChanged: true };
    const sent = JSON.parse(body);
    const images = Array.isArray(sent.screenshots) ? sent.screenshots : sent.screenshot ? [sent.screenshot] : [];
    if (!stagedUploads || !images.length) return post(body, stagedUploads ? account : null);
    const refs = [];
    for (const [index, image] of images.entries()) {
        if (!current()) return { status: 0, data: null, accountChanged: true };
        let expected;
        try { expected = await screenshot_sha256(image); } catch { return { status: 0, data: null }; }
        if (!current()) return { status: 0, data: null, accountChanged: true };
        const bytes = Uint8Array.from(atob(image.dataBase64), char => char.charCodeAt(0));
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, send_deadline_ms(bytes.byteLength));
        try {
            progress?.(`Uploading screenshot ${index + 1} of ${images.length}…`);
            const url = new URL(endpoint(), window.location.href);
            url.searchParams.set('crid', sent.clientRequestId);
            const response = await fetch(url.pathname + url.search, { method: 'PUT', credentials: 'same-origin',
                headers: { 'Content-Type': image.contentType, 'X-EZiL-Feedback-Account': account }, body: bytes, signal: controller.signal });
            if (response.status !== 200 && response.status !== 201) {
                let error; try { error = (await response.json())?.error; } catch { /* fixed status still applies */ }
                return { status: response.status, data: null, timedOut, accountChanged: error === 'account_changed' };
            }
            const data = await response.json();
            if (data?.sha256 !== expected || typeof data.finalized !== 'boolean') return { status: 0, data: null, timedOut };
            refs.push({ sha256: expected, contentType: image.contentType });
        } catch { return { status: 0, data: null, timedOut }; }
        finally { clearTimeout(timer); }
    }
    if (!current()) return { status: 0, data: null, accountChanged: true };
    const finalized = { ...sent, screenshot: null, screenshotRefs: refs };
    delete finalized.screenshots;
    progress?.('Sending feedback…');
    return post(JSON.stringify(finalized, null, 2), account);
}

/**
 * POST one submitted body and settle the local state from the answer. Never
 * throws; resolves `{ status, data, timedOut }` (status 0 = no response).
 */
async function deliver (clientRequestId, body, options = {}) {
    if ( inflight.has(clientRequestId) ) return { status: -1, data: null };
    inflight.add(clientRequestId);
    const savedEntry = read_outbox().find(entry => entry.clientRequestId === clientRequestId);
    const savedDraft = savedEntry?.draft;
    const stagedUploads = options.stagedUploads ?? savedEntry?.stagedUploads === true;
    const account = options.account ?? account_id();
    let status = 0, data = null, timedOut = false, accountChanged = false;
    try {
        ({ status, data, timedOut, accountChanged } = await send_report(body, stagedUploads, account, options.progress));
        // FEEDBACK-DIAG rollback window: a tab that booted on a server advertising
        // `ui.feedbackEventDiagnostics` keeps that payload after the server is
        // rolled back, and the older strict schema 400s a report carrying the two
        // keys. Send it once more without them: it costs two fields, not the report.
        const lean = !accountChanged && account_id() === account && status === 400 ? without_event_diagnostics(body) : null;
        if ( lean ) {
            body = lean;
            outbox_put(clientRequestId, lean, stagedUploads);
            window.dispatchEvent(new window.CustomEvent('ezil:feedback-downgrade', { detail: { clientRequestId, body: lean } }));
            ({ status, data, timedOut, accountChanged } = await send_report(lean, stagedUploads, account, options.progress));
        }
    } finally {
        inflight.delete(clientRequestId);
    }
    // Do not mutate another account's draft/outbox, or retry after a server account comparison failed.
    if (accountChanged || account_id() !== account) {
        outbox_pause(clientRequestId, account);
        return { status: 409, data: null, timedOut, accountChanged: true };
    }
    if ( data ) {
        outbox_remove(clientRequestId);
        if ( read_draft()?.clientRequestId === clientRequestId ) write_draft(null);
        window.dispatchEvent(new window.CustomEvent('ezil:feedback-sent', { detail: { clientRequestId, id: data.id,
            screenshotAccepted: data.screenshotAccepted } }));
    } else if ( retryable(status) ) {
        listen_online();
    } else {
        // A definitive refusal (400/401/404/413/415/429): stop retrying, and
        // put the text back in the draft so it is not lost with the dialog.
        if (stagedUploads) outbox_pause(clientRequestId, account);
        else outbox_remove(clientRequestId);
        if ( ! read_draft() ) {
            try {
                const sent = JSON.parse(body);
                const saved = savedDraft && typeof savedDraft === 'object'
                    ? { ...savedDraft, description: legacy_text(String(savedDraft.description ?? ''), savedDraft.bug) } : null;
                write_draft(saved || { clientRequestId, description: String(sent.description ?? '').slice(0, DESCRIPTION_MAX) }, stagedUploads);
            } catch { /* An unreadable body has nothing to restore. */ }
        }
    }
    return { status, data, timedOut };
}

/**
 * Re-send every submitted-but-unconfirmed report, once each, smallest first:
 * a large screenshot report that a slow link or a server-side limit keeps
 * failing then never holds back the text reports queued with it.
 */
export async function flush_feedback_outbox () {
    if ( ! feedback_enabled() || navigator.onLine === false ) return;
    const account = account_id();
    for ( const entry of read_outbox().sort((a, b) => a.body.length - b.body.length) ) {
        if (entry.paused === true) continue;
        // Flushes can overlap (a back/forward-cache restore runs both the icon's
        // remount and `flush_after_restore`): skip what another one has settled.
        if ( ! read_outbox().some(queued => queued.clientRequestId === entry.clientRequestId) ) continue;
        const { status, timedOut, accountChanged } = await deliver(entry.clientRequestId, entry.body, { account });
        if (accountChanged) break;
        // Still offline or unreachable: wait for the next `online`. A send that
        // only ran out of time stays queued without holding back the rest.
        if ( status === 0 && ! timedOut ) break;
    }
}

/** Rendered: neither the element nor an ancestor is display:none or visibility:hidden. */
function shown (el) {
    for ( let node = el; node; node = node.parentElement ) {
        const style = window.getComputedStyle(node);
        if ( style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ) return false;
    }
    return true;
}

/**
 * The full view in front: of the rendered `.ezil-fullbleed` windows, the one
 * with the highest z-index (the later one in the document on a tie), or null.
 * Every full view fills the viewport, so only that one's strip is on screen.
 */
function front_fullbleed () {
    let front = null;
    let front_z = -Infinity;
    for ( const el of document.querySelectorAll('.window.ezil-fullbleed') ) {
        if ( ! shown(el) ) continue;
        const z = Number.parseInt(window.getComputedStyle(el).zIndex, 10);
        const zz = Number.isFinite(z) ? z : 0;
        if ( zz >= front_z ) { front = el; front_z = zz; }
    }
    return front;
}

/** A plain px length (`43px`, `28.5px`), as the strip height is written in ezil-shell.css. */
const PX = /^\d+(?:\.\d+)?px$/;

/**
 * At least one app window is open: a `.window` that names its app (alerts carry
 * an empty `data-app`), is not a file dialog, is neither minimised nor closing,
 * and is rendered. None means the home screen. Minimised is read from the
 * attribute because a minimised window can keep `display: block` at 0×0.
 */
function app_window_open () {
    return [...document.querySelectorAll('.window[data-app]:not(.window-alert):not(.window-filedialog)')].some(el =>
        el.getAttribute('data-app') && el.getAttribute('data-closing') !== '1'
        && ! ['true', '1'].includes(el.getAttribute('data-is_minimized')) && shown(el));
}

/**
 * Send what was submitted but never confirmed (an offline send, or one cut off
 * by a reload) and keep watching `online` (idempotent). `mount_feedback_chip()`
 * calls this, so it runs whenever boot mounts the shell.
 */
export function resume_feedback_outbox () {
    if ( ! feedback_enabled() ) return;
    listen_online();
    // A page restored from the back/forward cache does not run shell boot.
    window.addEventListener('pageshow', flush_after_restore);
    if ( read_outbox().length ) void flush_feedback_outbox();
}

function flush_after_restore (event) { if ( event.persisted ) void flush_feedback_outbox(); }

/**
 * Mount the in-app Feedback icon (idempotent); boot calls this on every mount.
 * Founder, 2026-10-29: Feedback is not on the home screen, and its main entry
 * is Settings → Feedback (`../Settings/tabs/feedback.js`). While at least one
 * app window is open (full-bleed included) a very small icon-only "Send
 * feedback" button sits in the top-right corner; with no app window open it is
 * hidden. Mounting also resumes the outbox (`resume_feedback_outbox`).
 */
export function mount_feedback_chip () {
    if ( ! feedback_enabled() || ! document.body ) return;
    let chip = document.querySelector('button.ezil-feedback-chip');
    if ( ! chip ) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ezil-feedback-chip';
        chip.setAttribute('aria-label', 'Send feedback');
        chip.title = 'Send feedback';
        chip.innerHTML = ICON;
        chip.addEventListener('click', () => { chip.focus(); open_feedback_dialog({ source: 'chip' }); });
        document.body.append(chip);
    }
    const sync = () => {
        // Shown only while an app window is open: never on the home screen.
        // In a full-bleed desktop it sits inside the top control strip (plan
        // §6.8); with the floating-controls pill on, the pill offers Feedback.
        const front = front_fullbleed();
        const fullbleed = !! front;
        const pill = window.__EZIL_BOOT__?.desktopState?.ui?.floatingControls === true;
        const display = ! feedback_enabled() || ! app_window_open() || (fullbleed && pill) ? 'none' : '';
        if ( chip.style.display !== display ) chip.style.display = display;
        if ( chip.classList.contains('ezil-feedback-chip-fullbleed') !== fullbleed ) chip.classList.toggle('ezil-feedback-chip-fullbleed', fullbleed);
        // Gate G3, 2026-10-31: the strips differ (the Browser's is 43px, Code's
        // 28px; ezil-shell.css), so the icon takes the FRONT full view's strip
        // height and the look it declares (`--ezil-feedback-look`), never one
        // strip's fixed offset. Nothing declared (jsdom, no full view): the
        // CSS fallbacks, which are the Browser's strip and the glass disc.
        // Written only when a value changes, so a window mutation that moves
        // nothing costs the icon no style write.
        const css = front ? window.getComputedStyle(front) : null;
        const strip = css?.getPropertyValue('--ezil-control-strip-height').trim() ?? '';
        const want_strip = PX.test(strip) ? strip : '';
        if ( chip.style.getPropertyValue('--ezil-feedback-strip-h') !== want_strip ) {
            if ( want_strip ) chip.style.setProperty('--ezil-feedback-strip-h', want_strip);
            else chip.style.removeProperty('--ezil-feedback-strip-h');
        }
        const look = css?.getPropertyValue('--ezil-feedback-look').trim() ?? '';
        const want_look = /^[a-z]+$/.test(look) ? look : '';
        if ( (chip.dataset.look ?? '') !== want_look ) {
            if ( want_look ) chip.dataset.look = want_look;
            else delete chip.dataset.look;
        }
    };
    chipObserver?.disconnect();
    chipObserver = new MutationObserver(sync);
    // The strip's height is a `pointer: coarse` media query: re-read it when
    // the pointer changes (no element mutates when a media query flips).
    chipPointer?.removeEventListener?.('change', chipPointerSync);
    chipPointer = window.matchMedia?.('(pointer: coarse)') ?? null;
    chipPointerSync = sync;
    chipPointer?.addEventListener?.('change', chipPointerSync);
    // Windows opening, closing, minimising and restoring all show up here.
    chipObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'data-is_minimized', 'data-closing'] });
    window.addEventListener('ezil:teardown', unmount_feedback_chip);
    window.addEventListener('pagehide', suspend_feedback_chip);
    sync();
    // A report submitted while offline (or before the tab closed) goes now.
    resume_feedback_outbox();
}

function read_blob (blob, signal) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        const abort = () => { reader.abort(); finish(new Error('image_read_cancelled')); };
        function finish (error, data) {
            signal.removeEventListener('abort', abort);
            reader.onload = reader.onerror = null;
            if ( error ) reject(error);
            else resolve(data);
        }
        if ( signal.aborted ) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
        reader.onload = () => finish(null, String(reader.result).split(',')[1]);
        reader.onerror = () => finish(new Error('image_read_failed'));
        reader.readAsDataURL(blob);
    });
}

function error_copy (status) {
    if ( status === 429 ) return "You've sent several reports this hour — try again later.";
    if ( status === 413 ) return 'This report is too large. Remove a screenshot and try again.';
    if ( status === 415 ) return 'This page could not send the report. Reload EZiL OS and try again.';
    if ( status === 400 ) return 'This report could not be accepted. Check the description or remove a screenshot and try again.';
    if ( status === 401 ) return 'Your session expired — sign in again to send feedback.';
    if ( status === 404 ) return 'Feedback is not available in this deployment right now.';
    return 'Could not send feedback. Check your connection and try again.';
}

/**
 * appContext is trusted shell registration context only (never producer message data).
 * It prefills the selection; opening never sends a report.
 * @param {{ source: 'chip'|'pill'|'troubleshoot'|'settings', errorCode?: string, appContext?: {computerId: string, appSession: string} }} [_opts]
 */
export function open_feedback_dialog (_opts) {
    if ( ! feedback_enabled() ) return;
    if ( activeDialog?.isConnected ) { activeDialog.focus(); return; }
    const opener = document.activeElement;
    const ownerAccount = account_id();
    const draft = read_draft() ?? (() => {
        const entry = read_outbox().filter(entry => entry.stagedUploads && entry.paused).at(-1);
        if (!entry) return null;
        const body = JSON.parse(entry.body);
        return entry.draft ?? { clientRequestId: entry.clientRequestId, category: CATEGORY, description: String(body.description ?? '') };
    })();
    let clientRequestId = draft?.clientRequestId ?? crypto.randomUUID();
    const waiting = read_outbox().filter(entry => entry.clientRequestId !== clientRequestId && !entry.paused && ! inflight.has(entry.clientRequestId)).length;
    // The canonical current computer (Settings switches never rewrite the boot
    // payload), snapshotted once: the frozen body keeps it through retries.
    const trusted = _opts?.appContext;
    const hasAppContext = typeof trusted?.computerId === 'string' && UUID.test(trusted.computerId)
        && typeof trusted.appSession === 'string' && trusted.appSession.length > 0;
    const computer = hasAppContext ? trusted.computerId : currentComputer()?.id;
    let computerId = typeof computer === 'string' && UUID.test(computer) ? computer : null;
    const appContext = Object.freeze({ computerId, ...(hasAppContext ? { appSession: trusted.appSession } : {}) });
    const screenshots = window.__EZIL_BOOT__?.desktopState?.ui?.feedbackScreenshots === true;
    let stagedUploads = window.__EZIL_BOOT__?.desktopState?.ui?.feedbackStagedUploads === true;
    const advertisedMax = window.__EZIL_BOOT__?.desktopState?.ui?.feedbackScreenshotsMax;
    /** Images this report may carry: 1 unless the server advertises more. With one, a new image replaces the old. */
    const imagesMax = Number.isInteger(advertisedMax) && advertisedMax >= 1 ? Math.min(advertisedMax, IMAGES_MAX_SUPPORTED) : 1;
    const imagesBytesTotal = imagesMax > 1 ? IMAGES_BYTES_TOTAL : IMAGE_BYTES_MAX;
    // On a touch device the first focus must not land in a text field: that raises the on-screen keyboard over
    // Send. The heading takes it (showModal honours `autofocus`); a fine pointer keeps the description focused.
    const touchPrimary = window.matchMedia?.('(pointer: coarse)')?.matches === true;
    const dialog = document.createElement('dialog');
    dialog.className = 'ezil-feedback-dialog';
    dialog.setAttribute('aria-labelledby', 'ezil-feedback-heading');
    dialog.innerHTML = `
        <h2 id="ezil-feedback-heading" tabindex="-1"${touchPrimary ? ' autofocus' : ''}>Send feedback</h2>
        <form>
            <fieldset class="ezil-feedback-fields">
                <label for="ezil-feedback-description">Description (optional)</label>
                <textarea id="ezil-feedback-description" name="description" maxlength="4000" rows="3"
                    placeholder="You can paste screenshots here too." aria-describedby="ezil-feedback-counter ezil-feedback-warning"${touchPrimary ? '' : ' autofocus'}></textarea>
                <p id="ezil-feedback-counter" class="ezil-feedback-muted" aria-live="polite"></p>
                <p id="ezil-feedback-warning" class="ezil-feedback-warning" role="status" hidden></p>
                <div class="ezil-feedback-consents">
                    <label class="ezil-feedback-consent"><input type="checkbox" name="diagnostics" checked> Diagnostics</label>
                    ${screenshots ? '<label class="ezil-feedback-consent"><input type="checkbox" name="screenshot" checked> Screenshots</label>' : ''}
                </div>
                ${screenshots ? `<section class="ezil-feedback-capture" aria-label="Screenshots">
                    <div class="ezil-feedback-dropzone"><label class="ezil-feedback-upload">Attach images<input type="file" name="screenshotFile" accept="image/png,image/jpeg,image/webp"${imagesMax > 1 ? ' multiple' : ''}></label><span class="ezil-feedback-muted">or drop them here</span></div>
                    <p class="ezil-feedback-muted" data-role="capture-note" role="status" aria-live="polite" hidden></p>
                    <div class="ezil-feedback-image" hidden><ol class="ezil-feedback-images" data-role="images"></ol></div>
                </section>` : ''}
            </fieldset>
            <details class="ezil-feedback-preview"><summary>Preview exactly what will be sent</summary>
                <p class="ezil-feedback-muted" data-role="context-line" hidden></p><pre></pre>
                <p class="ezil-feedback-muted" data-role="app-failure-context" hidden></p>
                <p class="ezil-feedback-muted" data-role="server-context-preview-note">Diagnostics also add a computer-state summary when sent.</p></details>
            <div class="ezil-feedback-footer"><p class="ezil-feedback-result" role="status" aria-live="polite"></p>
                <div class="ezil-feedback-actions"><button type="button" data-action="cancel">Cancel</button><button type="submit">Send feedback</button></div>
            </div>
        </form>`;
    document.body.append(dialog);
    activeDialog = dialog;
    const form = dialog.querySelector('form');
    const fields = dialog.querySelector('.ezil-feedback-fields');
    const description = form.elements.description;
    const diagnostics = form.elements.diagnostics;
    const screenshotConsent = form.elements.screenshot;
    const preview = dialog.querySelector('pre');
    const previewBox = dialog.querySelector('.ezil-feedback-preview');
    const result = dialog.querySelector('.ezil-feedback-result');
    const submit = dialog.querySelector('[type="submit"]');
    const cancel = dialog.querySelector('[data-action="cancel"]');
    /**
     * Local images in preview order: `{ key, contentType, dataBase64, sha256, bytes, source }`.
     * Only explicit file, paste or drop imports and queued images are attached.
     * They live only in this form (never in the draft) until Send freezes them into the request body.
     */
    let images = [];
    let imageKeys = 0;
    let diagnosticSnapshot = null;
    let appContextUnavailable = false;
    let attemptedBody = null;
    const capture_note = dialog.querySelector('[data-role="capture-note"]');
    let settling = false;
    let serialized = '';
    let sending = false;
    let sent = false;
    let capturing = false;
    let captureGeneration = 0;
    let closed = false;
    let captureController = null;
    if ( draft ) description.value = draft.description;
    // A draft whose report is already queued (sent offline or after a server error) reopens as that same
    // request: its diagnostics and screenshot come from the queued body, so a re-send stays byte-identical
    // (same clientRequestId) instead of becoming a second report.
    let restoredFromQueue = false;
    let errorCode = null;
    const queuedEntry = draft ? read_outbox().find(entry => entry.clientRequestId === clientRequestId) : null;
    if ( queuedEntry ) {
        try {
            const queuedBody = JSON.parse(queuedEntry.body);
            stagedUploads = queuedEntry.stagedUploads === true;
            // The queued request keeps the error line it was sent with.
            const queuedCode = /(?:^|\n\n)Error code: ([a-z0-9_:-]{1,64})$/i.exec(String(queuedBody.description ?? ''))?.[1];
            errorCode = typeof queuedCode === 'string' && /^[a-z0-9_:-]{1,64}$/i.test(queuedCode) && scan(queuedCode).length === 0 ? queuedCode : null;
            // The queued request keeps the computer it was sent for, even if the current one changed since.
            computerId = typeof queuedBody.computerId === 'string' && UUID.test(queuedBody.computerId) ? queuedBody.computerId : null;
            diagnosticSnapshot = queuedBody.diagnostics ?? null;
            diagnostics.checked = diagnosticSnapshot !== null;
            if ( screenshotConsent ) {
                const queuedImages = Array.isArray(queuedBody.screenshots) ? queuedBody.screenshots : queuedBody.screenshot ? [queuedBody.screenshot] : [];
                screenshotConsent.checked = queuedImages.length > 0;
                // The queued body is re-sent as it is, whatever this server now advertises.
                images = queuedImages.map(image => ({ key: ++imageKeys, contentType: image.contentType, dataBase64: image.dataBase64,
                    bytes: base64_bytes(String(image.dataBase64)), source: 'queued' }));
            }
            restoredFromQueue = true;
        } catch { /* An unreadable queued body is treated as a new report. */ }
    }
    // The opener's error code (trusted shell context, a bounded machine code that passes the secret scan) is shown
    // as an observed fact and sent as a final "Error code:" line; it is not written into the comment box.
    const valid_code = value => typeof value === 'string' && /^[a-z0-9_:-]{1,64}$/i.test(value) && scan(value).length === 0;
    if ( ! restoredFromQueue ) errorCode = valid_code(_opts?.errorCode) ? _opts.errorCode : null;
    // The description as sent: the comment, then the error line (once, even if an older draft already holds it).
    const with_error_code = text => {
        if ( ! errorCode ) return text;
        const line = `Error code: ${errorCode}`;
        if ( text.split('\n').some(row => row.trim() === line) ) return text;
        return text.trim() ? `${text.trimEnd()}\n\n${line}` : line;
    };

    function save_draft () {
        if ( sent || closed || account_id() !== ownerAccount ) return;
        write_draft({ clientRequestId, category: CATEGORY, description: description.value },
            read_outbox().some(entry => entry.clientRequestId === clientRequestId));
    }

    function show_sent (data) {
        sent = true;
        fields.hidden = true;
        dialog.querySelector('.ezil-feedback-preview').hidden = true;
        submit.hidden = true;
        cancel.textContent = 'Close';
        const sentImages = screenshotConsent?.checked ? images.length : 0;
        result.textContent = `Thanks — we got it. Report ID: ${data.id}.`
            + (sentImages && data.screenshotAccepted === false ? (sentImages > 1 ? " Your images weren't stored." : " Your image wasn't stored.") : '');
        cancel.focus();
    }
    // A queued copy of THIS report went through on reconnect.
    function on_sent (event) {
        if ( closed || sent || sending || event.detail?.clientRequestId !== clientRequestId ) return;
        show_sent(event.detail);
    }
    window.addEventListener('ezil:feedback-sent', on_sent);

    function cancel_capture () {
        ++captureGeneration;
        captureController?.abort();
        captureController = null;
        capturing = false;
        for ( const button of dialog.querySelectorAll('[data-capture]') ) button.disabled = false;
        if (form.elements.screenshotFile) form.elements.screenshotFile.disabled = false;
        if ( result.textContent === 'Preparing screenshot…' ) result.textContent = '';
    }

    function preview_body () {
        if (!stagedUploads || !screenshotConsent?.checked || !images.length) return serialized;
        const body = JSON.parse(serialized);
        body.screenshot = null; delete body.screenshots;
        body.screenshotRefs = images.map(image => ({ sha256: image.sha256, contentType: image.contentType }));
        return JSON.stringify(body, null, 2);
    }

    function refresh () {
        if ( sending || sent || closed ) return;
        const comment = description.value;
        const kinds = [...new Set(scan(comment).map(match => match.kind))];
        const warning = dialog.querySelector('.ezil-feedback-warning');
        warning.hidden = kinds.length === 0;
        warning.textContent = kinds.length
            ? 'This looks like a token / email address — remove it before sending? ' + kinds.join(', ') : '';
        const text = with_error_code(comment);
        // The character count only appears when it matters (near or over the limit), keeping the form short.
        dialog.querySelector('#ezil-feedback-counter').textContent = text.length > DESCRIPTION_MAX - 1000
            ? `${text.length} / ${DESCRIPTION_MAX} characters${text.length > DESCRIPTION_MAX ? ' — shorten the description' : ''}` : '';
        const imageSection = dialog.querySelector('.ezil-feedback-capture');
        if ( imageSection ) imageSection.hidden = ! screenshotConsent.checked;
        // One image keeps the original `screenshot` key (older servers and queued bodies); two or more use `screenshots`.
        const chosen = screenshotConsent?.checked ? images.map(({ contentType, dataBase64 }) => ({ contentType, dataBase64 })) : [];
        const body_of = () => ({ v: 1, clientRequestId, category: CATEGORY,
            description: text, computerId,
            diagnostics: diagnostics.checked ? diagnosticSnapshot : null,
            screenshot: chosen.length === 1 ? chosen[0] : null,
            ...(chosen.length > 1 ? { screenshots: chosen } : {}) });
        let payload = body_of();
        // A snapshot too large for the wire limit is left out; it must never keep Send disabled.
        if ( diagnostics.checked && new TextEncoder().encode(JSON.stringify({ ...payload, screenshot: null, screenshots: undefined }, null, 2)).length > 32 * 1024 ) {
            diagnosticSnapshot = null;
            diagnostics.checked = false;
            result.textContent = 'Diagnostics were too large to include, so they were left out.';
            payload = body_of();
        }
        serialized = JSON.stringify(payload, null, 2);
        const pendingEntry = read_outbox().find(entry => entry.clientRequestId === clientRequestId);
        const pendingBody = pendingEntry?.body ?? attemptedBody;
        if (pendingBody && pendingBody !== serialized) {
            // Edits are a new report; a later receipt for the old request must never hide them.
            const previousId = clientRequestId;
            clientRequestId = crypto.randomUUID();
            attemptedBody = null;
            payload.clientRequestId = clientRequestId;
            serialized = JSON.stringify(payload, null, 2);
            if (pendingEntry?.stagedUploads && pendingEntry.paused) {
                if (replace_paused_report(previousId, clientRequestId, serialized, description.value)) save_draft();
                else result.textContent = 'Could not save these changes. Keep this window open to send them.';
            }
        }
        // Render the exact wire body only when its preview is opened.
        if ( previewBox.open ) preview.textContent = preview_body();
        const appStatus = dialog.querySelector('[data-role="app-failure-context"]');
        appStatus.hidden = !diagnostics.checked || (!appContextUnavailable && !diagnosticSnapshot?.appFailures);
        const appEvents = diagnosticSnapshot?.appFailures || [];
        appStatus.textContent = appContextUnavailable ? 'App failure context is unavailable for this report.'
            : `${appEvents.length} app events (${appEvents.filter(event => event.outcome === 'cancelled').length} cancelled).`;
        render_scope();
        render_context();
        // Blank reports are valid; local image preparation and invalid text hold Send.
        submit.disabled = capturing || settling || text.length > DESCRIPTION_MAX || account_id() !== ownerAccount
            || (stagedUploads && screenshotConsent?.checked && images.some(image => !image.sha256));
    }

    function render_scope () {
        if (form.elements.screenshotFile) form.elements.screenshotFile.disabled = capturing || !can_add();
        if (capture_note) capture_note.hidden = !capture_note.textContent;
        dialog.querySelector('[data-role="server-context-preview-note"]').hidden = !diagnostics.checked;
    }

    /** One row per image: thumbnail, Edit and Remove. Rebuilt only when the images change. */
    function render_images () {
        const box = dialog.querySelector('.ezil-feedback-image');
        if ( ! box ) return;
        const list = box.querySelector('[data-role="images"]');
        list.replaceChildren(...images.map((image, index) => {
            const item = document.createElement('li');
            item.dataset.key = String(image.key);
            const img = document.createElement('img');
            img.alt = images.length > 1 ? `Screenshot ${index + 1} to include with this report` : 'Screenshot to include with this report';
            img.src = `data:${image.contentType};base64,${image.dataBase64}`;
            const edit = document.createElement('button');
            edit.type = 'button'; edit.dataset.capture = 'edit'; edit.textContent = 'Edit';
            edit.setAttribute('aria-label', `Edit screenshot ${index + 1}`);
            const remove = document.createElement('button');
            remove.type = 'button'; remove.dataset.action = 'remove-screenshot';
            remove.textContent = 'Remove';
            remove.setAttribute('aria-label', images.length > 1 ? `Remove screenshot ${index + 1}` : 'Remove screenshot');
            edit.disabled = capturing;
            remove.disabled = capturing;
            // Short actions beside the thumbnail keep several images compact.
            const meta = document.createElement('div');
            meta.className = 'ezil-feedback-image-meta';
            const actions = document.createElement('div');
            actions.append(edit, remove);
            meta.append(actions);
            item.append(img, meta);
            return item;
        }));
        box.hidden = images.length === 0;
    }

    /** One line of facts the shell actually observed and will send: the computer and, with diagnostics on, the app and latest app failure. */
    function render_context () {
        const line = dialog.querySelector('[data-role="context-line"]');
        const parts = [];
        if ( errorCode ) parts.push(`error code ${errorCode}`);
        const known = currentComputer();
        if ( computerId && known?.id === computerId && typeof known.name === 'string' && known.name.trim() ) parts.push(`computer “${known.name.trim().slice(0, 40)}”`);
        if ( diagnostics.checked && diagnosticSnapshot ) {
            if ( typeof diagnosticSnapshot.traceApp === 'string' && diagnosticSnapshot.traceApp ) parts.push(`app ${diagnosticSnapshot.traceApp}`);
            const failure = diagnosticSnapshot.appFailures?.[0];
            if ( failure ) {
                const words = [failure.operation, failure.code].map(word => String(word).replace(/_/g, ' ')).join(' — ');
                parts.push(`latest app failure: ${words}${failure.outcome ? ` (${failure.outcome})` : ''}`);
            }
        }
        line.hidden = ! parts.length;
        line.textContent = parts.join(' · ');
    }

    function clear_screenshot (key = null) {
        images = key === null ? [] : images.filter(image => image.key !== key);
        render_images();
    }

    /** Bytes still free for one image: what the report total leaves after the others, at most the per-image cap. */
    function image_budget (replaceKey = null) {
        const others = images.reduce((sum, image) => sum + (image.key === replaceKey ? 0 : image.bytes), 0);
        return Math.min(IMAGE_BYTES_MAX, imagesBytesTotal - others);
    }

    /**
     * Put an edited image in place of `replaceKey`, or add it (with one image allowed, it replaces the one there).
     * The server refuses the same image twice in one report, so a duplicate of ANOTHER image is not taken: the
     * images stay as they were and false is returned.
     */
    function put_image (image, replaceKey = null) {
        if ( imagesMax > 1 && images.some(other => other.key !== replaceKey
            && other.contentType === image.contentType && other.dataBase64 === image.dataBase64) ) return false;
        const entry = { key: ++imageKeys, ...image };
        const at = images.findIndex(existing => existing.key === replaceKey);
        if ( at >= 0 ) images = images.map((existing, index) => index === at ? entry : existing);
        else if ( imagesMax === 1 ) images = [entry];
        else images = [...images, entry];
        render_images();
        return true;
    }

    /** Room for another image (one allowed: always, it replaces). */
    function can_add () {
        return imagesMax === 1 || (images.length < imagesMax && image_budget() >= 1024);
    }
    const FULL_NOTE = () => 'Remove one screenshot to add another.';

    // Image processing is local. The editor opens only when Edit is chosen.
    let importRun = 0;
    function begin_capture (fromImport = false) {
        if (!fromImport) ++importRun;
        capture_note.textContent = '';
        capturing = true;
        const generation = ++captureGeneration;
        captureController = new AbortController();
        result.textContent = 'Preparing screenshot…';
        render_images(); refresh();
        return { generation, signal: captureController.signal };
    }
    async function finish_capture (capture, generation, signal, source, replaceKey = null, edit = false) {
        const current = () => !closed && generation === captureGeneration && !signal.aborted && screenshotConsent.checked;
        try {
            const canvas = await capture;
            if (!current()) return;
            if (!canvas?.width || !canvas.height) throw new Error('Empty image');
            const limit = image_budget(replaceKey ?? (imagesMax === 1 ? images[0]?.key ?? null : null));
            const encoded = edit ? await open_redact_editor(canvas, { signal, limit }) : null;
            const blob = edit ? encoded?.blob : await encode_under_limit(canvas, limit, { signal });
            if (!current()) return;
            if (edit && !encoded) { result.textContent = ''; return; }
            if (!blob || !IMAGE_TYPES.includes(blob.type) || !blob.size || blob.size > limit
                || ![encoded?.width ?? canvas.width, encoded?.height ?? canvas.height].every(n => Number.isInteger(n) && n > 0 && n <= IMAGE_SIDE_MAX)) {
                result.textContent = 'This image is too large. Try a smaller screenshot.'; return;
            }
            const image = { contentType: blob.type, dataBase64: await read_blob(blob, signal), bytes: blob.size, source };
            image.sha256 = await screenshot_sha256(image);
            if (!current()) return;
            if (!put_image(image, replaceKey)) capture_note.textContent = 'This screenshot is already attached.';
            result.textContent = '';
        } catch {
            if (current()) result.textContent = 'Could not add this image. Try another screenshot.';
        } finally {
            if (current()) { cancel_capture(); render_images(); refresh(); }
        }
    }
    async function import_files (files, source) {
        const run = ++importRun;
        let unsupported = false;
        for (const file of files) {
            if (closed || run !== importRun || sending || sent || settling || !screenshotConsent.checked) return;
            if (!IMAGE_TYPES.includes(file.type)) { unsupported = true; continue; }
            if (!can_add()) { capture_note.textContent = FULL_NOTE(); refresh(); return; }
            const { generation, signal } = begin_capture(true);
            await finish_capture(uploaded_image_canvas(file, { signal }), generation, signal, source);
        }
        if (unsupported && !closed && run === importRun) {
            capture_note.textContent = 'Use PNG, JPEG or WebP images.'; refresh();
        }
    }
    function add_files (files, source) {
        if (!screenshotConsent || !files.length || sending || sent || closed) return;
        if (capturing || settling) { capture_note.textContent = 'Wait for this image to finish, then try again.'; refresh(); return; }
        screenshotConsent.checked = true;
        void import_files(files, source);
    }
    dialog.addEventListener('click', event => {
        const button = event.target.closest?.('[data-capture="edit"], [data-action="remove-screenshot"]');
        if (!button || !dialog.contains(button) || button.disabled || sending || sent || closed) return;
        const key = Number(button.closest('[data-key]')?.dataset.key) || null;
        if (button.dataset.action === 'remove-screenshot') {
            ++importRun; cancel_capture(); clear_screenshot(key); capture_note.textContent = ''; refresh(); return;
        }
        if (capturing || settling || !screenshotConsent.checked) return;
        const editing = images.find(image => image.key === key);
        if (!editing) return;
        const { generation, signal } = begin_capture();
        const capture = (async () => {
            const img = new window.Image(); img.src = `data:${editing.contentType};base64,${editing.dataBase64}`;
            await img.decode();
            const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
            canvas.getContext('2d').drawImage(img, 0, 0); return canvas;
        })();
        void finish_capture(capture, generation, signal, editing.source, key, true);
    });
    form.elements.screenshotFile?.addEventListener('change', () => {
        const input = form.elements.screenshotFile;
        const files = [...(input.files ?? [])]; input.value = ''; add_files(files, 'file');
    });
    dialog.addEventListener('paste', event => {
        const items = [...(event.clipboardData?.items ?? [])].filter(item => item.kind === 'file' && /^image\//.test(item.type));
        if (!screenshotConsent || !items.length) return;
        event.preventDefault(); add_files(items.map(item => item.getAsFile()).filter(Boolean), 'paste');
    });
    // Intercept only file drags. Text drag/drop keeps its native textarea behavior.
    const file_drag = event => [...(event.dataTransfer?.types ?? [])].includes('Files')
        || [...(event.dataTransfer?.items ?? [])].some(item => item.kind === 'file')
        || event.dataTransfer?.files?.length > 0;
    let dragDepth = 0;
    function on_drag (event) {
        if (!file_drag(event)) return;
        event.preventDefault();
        const inside = dialog.contains(event.target);
        if (event.dataTransfer) event.dataTransfer.dropEffect = inside && screenshots ? 'copy' : 'none';
        if (event.type === 'dragenter' && inside) ++dragDepth;
        if (event.type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
        dialog.classList.toggle('ezil-feedback-dragging', screenshots && inside && event.type !== 'dragleave' || dragDepth > 0);
    }
    function on_drop (event) {
        if (!file_drag(event)) return;
        event.preventDefault(); event.stopPropagation(); dragDepth = 0; dialog.classList.remove('ezil-feedback-dragging');
        if (dialog.contains(event.target)) add_files([...(event.dataTransfer?.files ?? [])], 'file');
    }
    for (const type of ['dragenter', 'dragover', 'dragleave']) document.addEventListener(type, on_drag, true);
    document.addEventListener('drop', on_drop, true);
    screenshotConsent?.addEventListener('change', () => {
        if (!screenshotConsent.checked) { ++importRun; cancel_capture(); clear_screenshot(); capture_note.textContent = ''; }
    });
    diagnostics.addEventListener('change', snapshot_diagnostics);
    function snapshot_diagnostics () {
        try {
            diagnosticSnapshot = diagnostics.checked ? build_diagnostics(appContext) : null;
        } catch {
            // A snapshot that cannot be built never blocks the report.
            diagnosticSnapshot = null;
            diagnostics.checked = false;
        }
        appContextUnavailable = diagnostics.checked && app_failure_diagnostics_accepted()
            && !Object.hasOwn(diagnosticSnapshot, 'appFailures');
    }
    function on_downgrade(event) {
        if (closed || event.detail?.clientRequestId !== clientRequestId) return;
        serialized = event.detail.body; preview.textContent = preview_body();
        diagnosticSnapshot = JSON.parse(serialized).diagnostics;
        appContextUnavailable = false;
        dialog.querySelector('[data-role="app-failure-context"]').hidden = true;
    }
    window.addEventListener('ezil:feedback-downgrade', on_downgrade);
    form.addEventListener('input', () => { refresh(); save_draft(); });
    form.addEventListener('change', () => { refresh(); save_draft(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if ( sending || sent || capturing || closed || settling ) return;
        if (account_id() !== ownerAccount) { result.textContent = 'Your account changed. Sign back in to the original account to send this report.'; return; }
        refresh();
        if ( submit.disabled || ! form.reportValidity() ) return;
        if ( ! feedback_enabled() ) { result.textContent = error_copy(404); return; }
        const previousBody = read_outbox().find(entry => entry.clientRequestId === clientRequestId)?.body ?? attemptedBody;
        if (previousBody && previousBody !== serialized) {
            clientRequestId = crypto.randomUUID();
            refresh();
            save_draft();
        }
        sending = true;
        fields.disabled = true;
        submit.disabled = true;
        cancel.textContent = 'Close';
        result.textContent = 'Sending… Closing this window does not cancel the report.';
        // From here the report belongs to the outbox, not the draft: closing
        // the dialog no longer discards it, and a failure that never got an
        // answer is re-sent with this same body when the connection returns.
        const body = serialized;
        const queued = outbox_put(clientRequestId, body, stagedUploads);
        attemptedBody = body;
        if (queued) write_draft(null);
        let outcome;
        try {
            outcome = await deliver(clientRequestId, body, { stagedUploads, account: ownerAccount, progress: text => { if (!closed) result.textContent = text; } });
        } finally {
            sending = false;
            fields.disabled = false;
        }
        if ( closed ) return;
        if ( outcome.data ) { show_sent(outcome.data); return; }
        cancel.textContent = 'Cancel';
        if (outcome.accountChanged) { result.textContent = 'Your account changed. This report is saved for the original account. Sign back in there to retry.'; submit.disabled = true; return; }
        save_draft();
        if ( outcome.status === -1 ) result.textContent = 'This report is already being sent.';
        else if ( retryable(outcome.status) && !queued ) {
            write_draft({ clientRequestId: crypto.randomUUID(), category: CATEGORY, description: description.value });
            result.textContent = 'Could not save this report for automatic retry. Keep this window open and press Send again, or copy your report text before leaving.';
        } else if ( outcome.timedOut ) {
            // The connection may be fine, so no `online` event is coming: say what will retry it.
            result.textContent = "The server didn't answer in time. Your report is saved — press Send to try again. "
                + 'It will also be retried the next time EZiL OS opens.';
        } else if ( retryable(outcome.status) ) {
            result.textContent = navigator.onLine === false
                ? "You're offline. Your report is saved and will be sent when you're back online."
                : outcome.status === 0 ? error_copy(0) + " We'll also send it automatically when your connection comes back."
                // The server answered, so no `online` event is coming either.
                : 'Could not send feedback — the server could not take it right now. Your report is saved — press Send to try again. '
                    + 'It will also be retried the next time EZiL OS opens.';
        } else result.textContent = error_copy(outcome.status);
        refresh();
    });

    function cleanup () {
        if ( closed ) return;
        closed = true;
        cancel_capture();
        for ( const type of ['ezil:teardown', 'popstate', 'pagehide', 'hashchange'] ) window.removeEventListener(type, close);
        window.removeEventListener('ezil:feedback-sent', on_sent);
        window.removeEventListener('ezil:feedback-downgrade', on_downgrade);
        for (const type of ['dragenter', 'dragover', 'dragleave']) document.removeEventListener(type, on_drag, true);
        document.removeEventListener('drop', on_drop, true);
        clear_screenshot();
        dialog.remove();
        if ( activeDialog === dialog ) activeDialog = null;
        if ( opener?.isConnected ) opener.focus();
    }
    function close () { dialog.close(); cleanup(); }
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', cleanup);
    for ( const type of ['ezil:teardown', 'popstate', 'pagehide', 'hashchange'] ) window.addEventListener(type, close);
    previewBox.addEventListener('toggle', () => { if ( previewBox.open ) preview.textContent = preview_body(); });
    // Diagnostics are selected by default: the frozen snapshot is taken now (nothing uploads until Send).
    if ( diagnostics.checked && ! restoredFromQueue ) snapshot_diagnostics();
    render_images();
    if (stagedUploads && images.length) {
        settling = true;
        Promise.all(images.map(async image => { image.sha256 = await screenshot_sha256(image); }))
            .catch(() => { if (!closed) result.textContent = 'Could not prepare these screenshots. Remove them and attach again.'; })
            .finally(() => { settling = false; refresh(); });
    }
    refresh();
    if ( waiting ) result.textContent = waiting === 1
        ? 'One earlier report is waiting to be sent. It will go when you are back online.'
        : `${waiting} earlier reports are waiting to be sent. They will go when you are back online.`;
    dialog.showModal();
    if ( touchPrimary ) dialog.querySelector('#ezil-feedback-heading').focus({ preventScroll: true });
    else description.focus();
}

/** Listing and deleting reports are small requests: a stalled one fails instead of loading forever. */
export const REPORTS_DEADLINE_MS = 20_000;

/** Run one request under `REPORTS_DEADLINE_MS`; the signal also covers reading the response body. */
async function within_reports_deadline (run) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REPORTS_DEADLINE_MS);
    try { return await run(controller.signal); } finally { clearTimeout(timer); }
}

/** @returns {Promise<Array<{id:string,createdAt:string,category:string,descriptionPreview:string,hasScreenshot:boolean,status:string}>>} */
export async function list_my_reports () {
    if ( ! feedback_enabled() ) return [];
    const data = await within_reports_deadline(async signal => {
        let response;
        try { response = await fetch(endpoint(), { method: 'GET', credentials: 'same-origin', signal }); }
        catch { throw new Error('Could not load your reports. Try again.'); }
        if ( ! response.ok ) throw new Error('Could not load your reports. Try again.');
        try { return await response.json(); } catch { throw new Error('Could not load your reports. Try again.'); }
    });
    if ( ! Array.isArray(data?.reports) ) throw new Error('Could not load your reports. Try again.');
    return data.reports.slice(0, 50);
}

/** @param {string} _id @returns {Promise<boolean>} */
export async function delete_my_report (_id) {
    if ( ! feedback_enabled() || typeof _id !== 'string' || ! UUID.test(_id) ) return false;
    const route = endpoint();
    return within_reports_deadline(async signal => {
        try {
            const response = await fetch(`${route}${route.includes('?') ? '&' : '?'}id=${encodeURIComponent(_id)}`,
                { method: 'DELETE', credentials: 'same-origin', signal });
            return response.status === 204;
        } catch { return false; }
    });
}
