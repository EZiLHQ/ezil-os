// feedback.js — EZiL-authored. One optional description; diagnostics and a window screenshot are
// selected by default (each can be switched off), previewable, and uploaded only on Send.
// Wire/API signatures are pinned in docs/FEEDBACK-CONTROLS-CONTRACT.md.
import { app_failure_diagnostics_accepted, build_diagnostics } from './diagnostics.js';
import { scan } from './secret-scan.js';
import { capture_shell_snapshot, tab_capture_supported, capture_tab_frame, capture_desktop_frame, desktop_capture_supported } from './capture.js';
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
/** How long Send waits for the default screenshot before sending without it. */
export const AUTO_CAPTURE_WAIT_MS = 3000;
/** The default screenshot is abandoned (never blocking) after this long. */
const AUTO_CAPTURE_TIMEOUT_MS = 10_000;
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

function outbox_put (clientRequestId, body) {
    const list = read_outbox().filter(entry => entry.clientRequestId !== clientRequestId);
    const prior = read_outbox().find(entry => entry.clientRequestId === clientRequestId);
    const draft = read_draft();
    if (list.length >= OUTBOX_MAX) return false;
    list.push({ clientRequestId, body, draft: prior?.draft ?? (draft?.clientRequestId === clientRequestId ? draft : null) });
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
async function post (body) {
    const controller = new AbortController();
    let timedOut = false;
    // Base64 and JSON are ASCII: the length is the byte count, give or take a non-ASCII description.
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, send_deadline_ms(body.length));
    try {
        const response = await fetch(endpoint(), { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal });
        if ( response.status !== 200 && response.status !== 201 ) return { status: response.status, data: null, timedOut };
        const data = await response.json();
        return typeof data?.id === 'string' && UUID.test(data.id) ? { status: response.status, data, timedOut } : { status: 0, data: null, timedOut };
    } catch { return { status: 0, data: null, timedOut }; } finally { clearTimeout(timer); }
}

/**
 * POST one submitted body and settle the local state from the answer. Never
 * throws; resolves `{ status, data, timedOut }` (status 0 = no response).
 */
async function deliver (clientRequestId, body) {
    if ( inflight.has(clientRequestId) ) return { status: -1, data: null };
    inflight.add(clientRequestId);
    const savedDraft = read_outbox().find(entry => entry.clientRequestId === clientRequestId)?.draft;
    let status = 0, data = null, timedOut = false;
    try {
        // The exact, visible preview string is also the request body.
        ({ status, data, timedOut } = await post(body));
        // FEEDBACK-DIAG rollback window: a tab that booted on a server advertising
        // `ui.feedbackEventDiagnostics` keeps that payload after the server is
        // rolled back, and the older strict schema 400s a report carrying the two
        // keys. Send it once more without them: it costs two fields, not the report.
        const lean = status === 400 ? without_event_diagnostics(body) : null;
        if ( lean ) {
            body = lean;
            outbox_put(clientRequestId, lean);
            window.dispatchEvent(new window.CustomEvent('ezil:feedback-downgrade', { detail: { clientRequestId, body: lean } }));
            ({ status, data, timedOut } = await post(lean));
        }
    } finally {
        inflight.delete(clientRequestId);
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
        outbox_remove(clientRequestId);
        if ( ! read_draft() ) {
            try {
                const sent = JSON.parse(body);
                const saved = savedDraft && typeof savedDraft === 'object'
                    ? { ...savedDraft, description: legacy_text(String(savedDraft.description ?? ''), savedDraft.bug) } : null;
                write_draft(saved || { clientRequestId, description: String(sent.description ?? '').slice(0, DESCRIPTION_MAX) });
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
    for ( const entry of read_outbox().sort((a, b) => a.body.length - b.body.length) ) {
        // Flushes can overlap (a back/forward-cache restore runs both the icon's
        // remount and `flush_after_restore`): skip what another one has settled.
        if ( ! read_outbox().some(queued => queued.clientRequestId === entry.clientRequestId) ) continue;
        const { status, timedOut } = await deliver(entry.clientRequestId, entry.body);
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
    if ( status === 413 ) return 'This report is too large. Remove the screenshot and try again.';
    if ( status === 415 ) return 'This page could not send the report. Reload EZiL OS and try again.';
    if ( status === 400 ) return 'This report could not be accepted. Check the description or remove the screenshot and try again.';
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
    const draft = read_draft();
    let clientRequestId = draft?.clientRequestId ?? crypto.randomUUID();
    const waiting = read_outbox().filter(entry => entry.clientRequestId !== clientRequestId && ! inflight.has(entry.clientRequestId)).length;
    // The canonical current computer (Settings switches never rewrite the boot
    // payload), snapshotted once: the frozen body keeps it through retries.
    const trusted = _opts?.appContext;
    const hasAppContext = typeof trusted?.computerId === 'string' && UUID.test(trusted.computerId)
        && typeof trusted.appSession === 'string' && trusted.appSession.length > 0;
    const computer = hasAppContext ? trusted.computerId : currentComputer()?.id;
    const computerId = typeof computer === 'string' && UUID.test(computer) ? computer : null;
    const appContext = Object.freeze({ computerId, ...(hasAppContext ? { appSession: trusted.appSession } : {}) });
    const screenshots = window.__EZIL_BOOT__?.desktopState?.ui?.feedbackScreenshots === true;
    const dialog = document.createElement('dialog');
    dialog.className = 'ezil-feedback-dialog';
    dialog.setAttribute('aria-labelledby', 'ezil-feedback-heading');
    dialog.innerHTML = `
        <h2 id="ezil-feedback-heading">Send feedback</h2>
        <form>
            <fieldset class="ezil-feedback-fields">
                <label for="ezil-feedback-description">Description (optional)</label>
                <textarea id="ezil-feedback-description" name="description" maxlength="4000" rows="5"
                    aria-describedby="ezil-feedback-counter ezil-feedback-warning" autofocus></textarea>
                <p id="ezil-feedback-counter" class="ezil-feedback-muted" aria-live="polite"></p>
                <p id="ezil-feedback-warning" class="ezil-feedback-warning" role="status" hidden></p>
                <label class="ezil-feedback-consent"><input type="checkbox" name="diagnostics" checked> Include diagnostics</label>
                <p class="ezil-feedback-muted">A frozen snapshot of browser/OS, viewport, page age, network state and recent machine-coded events. No console text, URLs, cookies or form values. Nothing uploads until Send.</p>
                <button type="button" data-action="refresh-diagnostics">Refresh diagnostic snapshot</button>
                ${screenshots ? `<label class="ezil-feedback-consent"><input type="checkbox" name="screenshot" checked> Include a screenshot</label>
                <section class="ezil-feedback-capture" aria-label="Screenshot">
                    <p class="ezil-feedback-muted" data-role="capture-note" role="status" aria-live="polite"></p>
                    <div class="ezil-feedback-image" hidden>
                        <img alt="Screenshot to include with this report">
                        <button type="button" data-capture="edit">Edit / crop / redact</button>
                        <button type="button" data-action="remove-screenshot">Remove screenshot</button>
                    </div>
                    <details class="ezil-feedback-capture-options"><summary>Change screenshot</summary>
                        <label class="ezil-feedback-upload">Attach a screenshot <input type="file" name="screenshotFile" accept="image/png,image/jpeg,image/webp"></label>
                        <p class="ezil-feedback-muted">PNG, JPEG or WebP (up to 8 MiB and 4096 pixels per side). The EZiL window option masks embedded apps. Tab capture asks you to choose a surface; crop and cover private areas before attaching.</p>
                        ${!tab_capture_supported() ? '<p class="ezil-feedback-muted">This browser cannot capture a tab. Attach a screenshot from your device to include embedded app content.</p>' : ''}
                        <div class="ezil-feedback-actions">
                            <button type="button" data-capture="shell">Capture EZiL OS window</button>
                            ${tab_capture_supported() ? '<button type="button" data-capture="tab">Capture what I see</button>' : ''}
                            ${desktop_capture_supported() ? '<button type="button" data-capture="desktop">Capture the desktop</button>' : ''}
                        </div>
                    </details>
                </section>` : '<p class="ezil-feedback-muted">Screenshots are not available here yet. Describe the visible error in your report.</p>'}
            </fieldset>
            <details class="ezil-feedback-preview"><summary>Preview exactly what will be sent</summary><pre></pre>
                <p class="ezil-feedback-muted" data-role="app-failure-context" hidden></p>
                <p class="ezil-feedback-muted">Your report includes its time, reference number and the version of EZiL OS. Technical details and screenshots are included only while they are selected.</p></details>
            <div class="ezil-feedback-footer">
                <p class="ezil-feedback-result" role="status" aria-live="polite"></p>
                <div class="ezil-feedback-actions">
                    <button type="button" data-action="cancel">Cancel</button>
                    <button type="submit">Send feedback</button>
                </div>
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
    let screenshot = null;
    let diagnosticSnapshot = null;
    let appContextUnavailable = false;
    let attemptedBody = null;
    const capture_note = dialog.querySelector('[data-role="capture-note"]');
    // The default screenshot runs in the background and never sets `capturing`,
    // so it cannot block Send. It is settled (waited for briefly, then aborted)
    // before the body is frozen, and a late result is discarded.
    let autoPending = null;
    let autoController = null;
    let autoGeneration = 0;
    let settling = false;
    let serialized = '';
    let sending = false;
    let sent = false;
    let capturing = false;
    let captureGeneration = 0;
    let closed = false;
    let restoreCapture = null;
    let captureController = null;
    if ( draft ) description.value = draft.description;
    // A draft whose report is already queued (sent offline or after a server error) reopens as that same
    // request: its diagnostics and screenshot come from the queued body, so a re-send stays byte-identical
    // (same clientRequestId) instead of becoming a second report.
    let restoredFromQueue = false;
    const queuedEntry = draft ? read_outbox().find(entry => entry.clientRequestId === clientRequestId) : null;
    if ( queuedEntry ) {
        try {
            const queuedBody = JSON.parse(queuedEntry.body);
            diagnosticSnapshot = queuedBody.diagnostics ?? null;
            diagnostics.checked = diagnosticSnapshot !== null;
            if ( screenshotConsent ) {
                screenshotConsent.checked = !! queuedBody.screenshot;
                if ( queuedBody.screenshot ) {
                    screenshot = queuedBody.screenshot;
                    const image = dialog.querySelector('.ezil-feedback-image');
                    image.querySelector('img').src = `data:${screenshot.contentType};base64,${screenshot.dataBase64}`;
                    image.hidden = false;
                }
            }
            restoredFromQueue = true;
        } catch { /* An unreadable queued body is treated as a new report. */ }
    }
    if ( typeof _opts?.errorCode === 'string' && /^[a-z0-9_:-]{1,64}$/i.test(_opts.errorCode) ) {
        // Opened from the opening screen's "Send feedback": name the error code so the report can be routed.
        // Round 4: also with a saved draft (appended once, within the 4,000-character limit).
        const line = `Error code: ${_opts.errorCode}`;
        const text = description.value;
        if ( ! text.trim() ) description.value = `${line}\n\n`;
        else if ( ! text.split('\n').some(row => row.trim() === line) && text.trimEnd().length + line.length + 2 <= 4000 ) {
            description.value = `${text.trimEnd()}\n\n${line}`;
        }
    }

    function save_draft () {
        if ( sent || closed ) return;
        write_draft({ clientRequestId, category: CATEGORY, description: description.value },
            read_outbox().some(entry => entry.clientRequestId === clientRequestId));
    }

    function show_sent (data) {
        sent = true;
        fields.hidden = true;
        dialog.querySelector('.ezil-feedback-preview').hidden = true;
        submit.hidden = true;
        cancel.textContent = 'Close';
        result.textContent = `Thanks — we got it. Report ID: ${data.id}.`
            + (screenshot && data.screenshotAccepted === false ? " Your image wasn't stored." : '');
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
        restoreCapture?.();
        restoreCapture = null;
        capturing = false;
        for ( const button of dialog.querySelectorAll('[data-capture]') ) button.disabled = false;
        if (form.elements.screenshotFile) form.elements.screenshotFile.disabled = false;
        if ( result.textContent === 'Preparing screenshot…' ) result.textContent = '';
    }

    function refresh () {
        if ( sending || sent || closed ) return;
        const text = description.value;
        const kinds = [...new Set(scan(text).map(match => match.kind))];
        const warning = dialog.querySelector('.ezil-feedback-warning');
        warning.hidden = kinds.length === 0;
        warning.textContent = kinds.length
            ? 'This looks like a token / email address — remove it before sending? ' + kinds.join(', ') : '';
        dialog.querySelector('#ezil-feedback-counter').textContent = `${text.length} / ${DESCRIPTION_MAX} characters${text.length > DESCRIPTION_MAX ? ' — shorten the description' : ''}`;
        const imageSection = dialog.querySelector('.ezil-feedback-capture');
        if ( imageSection ) imageSection.hidden = ! screenshotConsent.checked;
        const body_of = () => ({ v: 1, clientRequestId, category: CATEGORY,
            description: text, computerId,
            diagnostics: diagnostics.checked ? diagnosticSnapshot : null,
            screenshot: screenshotConsent?.checked ? screenshot : null });
        let payload = body_of();
        // A snapshot too large for the wire limit is left out; it must never keep Send disabled.
        if ( diagnostics.checked && new TextEncoder().encode(JSON.stringify({ ...payload, screenshot: null }, null, 2)).length > 32 * 1024 ) {
            diagnosticSnapshot = null;
            diagnostics.checked = false;
            result.textContent = 'Diagnostics were too large to include, so they were left out.';
            payload = body_of();
        }
        serialized = JSON.stringify(payload, null, 2);
        const pendingBody = read_outbox().find(entry => entry.clientRequestId === clientRequestId)?.body ?? attemptedBody;
        if (pendingBody && pendingBody !== serialized) {
            // Edits are a new report; a later receipt for the old request must never hide them.
            clientRequestId = crypto.randomUUID();
            attemptedBody = null;
            payload.clientRequestId = clientRequestId;
            serialized = JSON.stringify(payload, null, 2);
        }
        // With a default screenshot the body is ~2 MB of base64: render it only while the preview is open.
        if ( previewBox.open ) preview.textContent = serialized;
        const appStatus = dialog.querySelector('[data-role="app-failure-context"]');
        appStatus.hidden = !diagnostics.checked || (!appContextUnavailable && !diagnosticSnapshot?.appFailures);
        const appEvents = diagnosticSnapshot?.appFailures || [];
        appStatus.textContent = appContextUnavailable ? 'App failure context is unavailable for this report.'
            : `${appEvents.length} app events (${appEvents.filter(event => event.outcome === 'cancelled').length} cancelled).`;
        // A blank description is a valid report: only a running manual capture, the settle wait or an over-long text hold Send.
        submit.disabled = capturing || settling || text.length > DESCRIPTION_MAX;
    }

    function clear_screenshot () {
        screenshot = null;
        const image = dialog.querySelector('.ezil-feedback-image');
        if ( image ) { image.hidden = true; image.querySelector('img').removeAttribute('src'); }
    }

    // Keep the native dialog open (and modal) while excluding it and its
    // backdrop from capture. FCAPTURE owns when to call the returned restore.
    function hide () {
        dialog.classList.add('ezil-feedback-capturing');
        const restore = () => {
            if ( restoreCapture !== restore ) return;
            dialog.classList.remove('ezil-feedback-capturing');
            restoreCapture = null;
        };
        restoreCapture = restore;
        return restore;
    }

    async function finish_capture (capture, generation, signal) {
        const current = () => ! closed && generation === captureGeneration && ! signal.aborted;
        try {
            const canvas = await capture;
            if ( ! current() ) return;
            restoreCapture?.();
            if ( ! screenshotConsent.checked ) return;
            if ( ! canvas ) { result.textContent = 'No screenshot captured. You can try another capture option.'; return; }
            const edited = await open_redact_editor(canvas, { signal });
            if ( ! current() ) return;
            if ( ! edited || ! screenshotConsent.checked ) {
                result.textContent = '';
                return;
            }
            if ( ! ['image/png', 'image/jpeg', 'image/webp'].includes(edited.contentType)
                || edited.blob.size === 0 || edited.blob.size > 1.5 * 1024 * 1024
                || ! [edited.width, edited.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096) ) {
                result.textContent = 'The screenshot is too large or unsupported. Crop it further and try again.';
                return;
            }
            const dataBase64 = await read_blob(edited.blob, signal);
            if ( ! current() || ! screenshotConsent.checked ) return;
            screenshot = { contentType: edited.contentType, dataBase64 };
            const image = dialog.querySelector('.ezil-feedback-image');
            image.querySelector('img').src = `data:${screenshot.contentType};base64,${dataBase64}`;
            image.hidden = false;
            result.textContent = '';
        } catch {
            if ( current() ) result.textContent = 'Could not capture a screenshot. Try another capture option.';
        } finally {
            if ( current() ) { cancel_capture(); refresh(); }
        }
    }

    const NO_AUTO_CAPTURE = 'No screenshot was captured automatically. Send still works, or use "Change screenshot".';
    let autoTimer = null;
    function abort_auto () {
        ++autoGeneration;
        clearTimeout(autoTimer);
        autoTimer = null;
        autoController?.abort();
        autoController = null;
        autoPending = null;
    }
    /**
     * Best-effort default screenshot: the masked EZiL OS window snapshot only (the
     * same capability as "Capture EZiL OS window"; no picker, no permission, no other
     * app). Encoded within the existing limits and attached without the editor, which
     * stays one click away ("Edit / crop / redact"). Any failure leaves the report as is.
     */
    function start_auto_capture () {
        if ( ! screenshotConsent?.checked || screenshot || capturing || autoPending || closed || sent || sending ) return;
        const generation = ++autoGeneration;
        autoController = new AbortController();
        const { signal } = autoController;
        const current = () => ! closed && generation === autoGeneration && ! signal.aborted && screenshotConsent.checked;
        capture_note.textContent = 'Capturing a screenshot of the EZiL OS window…';
        autoTimer = setTimeout(() => {
            if ( generation !== autoGeneration ) return;
            abort_auto();
            capture_note.textContent = NO_AUTO_CAPTURE;
        }, AUTO_CAPTURE_TIMEOUT_MS);
        autoPending = (async () => {
            try {
                const canvas = await capture_shell_snapshot({ signal });
                if ( ! current() ) return;
                const fits = canvas?.width > 0 && canvas.height > 0 && canvas.width <= IMAGE_SIDE_MAX && canvas.height <= IMAGE_SIDE_MAX;
                const blob = fits ? await encode_under_limit(canvas, IMAGE_BYTES_MAX, { signal }) : null;
                if ( ! current() ) return;
                if ( ! blob || blob.size === 0 || blob.size > IMAGE_BYTES_MAX || ! ['image/png', 'image/jpeg', 'image/webp'].includes(blob.type) ) {
                    capture_note.textContent = NO_AUTO_CAPTURE;
                    return;
                }
                const dataBase64 = await read_blob(blob, signal);
                if ( ! current() ) return;
                screenshot = { contentType: blob.type, dataBase64 };
                const image = dialog.querySelector('.ezil-feedback-image');
                image.querySelector('img').src = `data:${screenshot.contentType};base64,${dataBase64}`;
                image.hidden = false;
                capture_note.textContent = '';
            } catch {
                if ( current() ) capture_note.textContent = NO_AUTO_CAPTURE;
            } finally {
                if ( generation === autoGeneration ) {
                    clearTimeout(autoTimer);
                    autoTimer = null;
                    autoController = null;
                    autoPending = null;
                    refresh();
                }
            }
        })();
    }

    for ( const button of dialog.querySelectorAll('[data-capture]') ) {
        button.addEventListener('click', () => {
            if ( capturing || sending || sent || closed || settling || ! screenshotConsent.checked ) return;
            abort_auto();
            capture_note.textContent = '';
            capturing = true;
            const generation = ++captureGeneration;
            captureController = new AbortController();
            const { signal } = captureController;
            for ( const el of dialog.querySelectorAll('[data-capture]') ) el.disabled = true;
            result.textContent = 'Preparing screenshot…';
            refresh();
            // No await before capture_tab_frame: preserve the click's browser
            // activation for getDisplayMedia. All three paths use the editor.
            let capture;
            try {
                if (button.dataset.capture === 'edit') {
                    const img = dialog.querySelector('.ezil-feedback-image img');
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    capture = Promise.resolve(canvas.width && canvas.height ? canvas : null);
                } else if ( button.dataset.capture === 'tab' ) capture = capture_tab_frame({ hide, signal });
                else {
                    hide();
                    capture = button.dataset.capture === 'shell' ? capture_shell_snapshot({ signal }) : capture_desktop_frame({ signal });
                }
            } catch (error) { capture = Promise.reject(error); }
            void finish_capture(capture, generation, signal);
        });
    }
    form.elements.screenshotFile?.addEventListener('change', () => {
        const input = form.elements.screenshotFile;
        const file = input.files?.[0];
        input.value = '';
        if (!file || capturing || sending || sent || closed || settling || !screenshotConsent.checked) return;
        abort_auto();
        capture_note.textContent = '';
        capturing = true;
        const generation = ++captureGeneration;
        captureController = new AbortController();
        const { signal } = captureController;
        for (const button of dialog.querySelectorAll('[data-capture]')) button.disabled = true;
        input.disabled = true;
        result.textContent = 'Preparing screenshot…';
        refresh();
        void finish_capture(uploaded_image_canvas(file, { signal }), generation, signal);
    });
    dialog.querySelector('[data-action="remove-screenshot"]')?.addEventListener('click', () => {
        abort_auto();
        cancel_capture();
        clear_screenshot();
        capture_note.textContent = '';
        refresh();
    });
    screenshotConsent?.addEventListener('change', () => {
        if ( ! screenshotConsent.checked ) { abort_auto(); cancel_capture(); clear_screenshot(); capture_note.textContent = ''; }
        else start_auto_capture();
    });
    diagnostics.addEventListener('change', () => {
        snapshot_diagnostics();
        dialog.querySelector('[data-action="refresh-diagnostics"]').hidden = !diagnostics.checked;
    });
    dialog.querySelector('[data-action="refresh-diagnostics"]').addEventListener('click', () => {
        if (diagnostics.checked) snapshot_diagnostics();
        refresh();
    });
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
        serialized = event.detail.body; preview.textContent = serialized;
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
        if ( autoPending ) {
            // Give the default screenshot a short, bounded moment, then freeze the body without it: a
            // late capture must never change `serialized` (that would mint a second clientRequestId).
            settling = true;
            submit.disabled = true;
            capture_note.textContent = 'Finishing the screenshot…';
            let timer;
            try {
                await Promise.race([autoPending, new Promise(resolve => { timer = setTimeout(resolve, AUTO_CAPTURE_WAIT_MS); })]);
            } finally {
                clearTimeout(timer);
                abort_auto();
                settling = false;
            }
            if ( closed ) return;
            if ( ! screenshot ) capture_note.textContent = NO_AUTO_CAPTURE;
            else capture_note.textContent = '';
        }
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
        const queued = outbox_put(clientRequestId, body);
        attemptedBody = body;
        if (queued) write_draft(null);
        let outcome;
        try {
            outcome = await deliver(clientRequestId, body);
        } finally {
            sending = false;
            fields.disabled = false;
        }
        if ( closed ) return;
        if ( outcome.data ) { show_sent(outcome.data); return; }
        cancel.textContent = 'Cancel';
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
        abort_auto();
        cancel_capture();
        for ( const type of ['ezil:teardown', 'popstate', 'pagehide', 'hashchange'] ) window.removeEventListener(type, close);
        window.removeEventListener('ezil:feedback-sent', on_sent);
        window.removeEventListener('ezil:feedback-downgrade', on_downgrade);
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
    previewBox.addEventListener('toggle', () => { if ( previewBox.open ) preview.textContent = serialized; });
    // Diagnostics are selected by default: the frozen snapshot is taken now (nothing uploads until Send).
    if ( diagnostics.checked && ! restoredFromQueue ) snapshot_diagnostics();
    dialog.querySelector('[data-action="refresh-diagnostics"]').hidden = ! diagnostics.checked;
    refresh();
    if ( waiting ) result.textContent = waiting === 1
        ? 'One earlier report is waiting to be sent. It will go when you are back online.'
        : `${waiting} earlier reports are waiting to be sent. They will go when you are back online.`;
    dialog.showModal();
    description.focus();
    if ( ! restoredFromQueue ) start_auto_capture();
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
