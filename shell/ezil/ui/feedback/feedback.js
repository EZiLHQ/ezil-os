// feedback.js — EZiL-authored. Explicit consent, preview, then one submission.
// Wire/API signatures are pinned in docs/FEEDBACK-CONTROLS-CONTRACT.md.
import { build_diagnostics } from './diagnostics.js';
import { scan } from './secret-scan.js';
import { capture_shell_snapshot, tab_capture_supported, capture_tab_frame, capture_desktop_frame, desktop_capture_supported } from './capture.js';
import { open_redact_editor } from './redact-editor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
    + '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>';
const CATEGORIES = ['bug', 'idea', 'other'];
const DRAFT_KEY = 'ezil:feedback:draft:v1:';
const OUTBOX_KEY = 'ezil:feedback:outbox:v1:';
const OUTBOX_MAX = 10;
let chipObserver = null;
let activeDialog = null;
let onlineListening = false;
const inflight = new Set();

function unmount_feedback_chip () {
    chipObserver?.disconnect();
    chipObserver = null;
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
    if ( ! id || ! s ) return;
    try {
        if ( value === null ) s.removeItem(prefix + id);
        else s.setItem(prefix + id, JSON.stringify(value));
    } catch { /* Storage is a convenience: full, blocked or private mode only loses the draft. */ }
}

function read_draft () {
    const d = read_json(DRAFT_KEY);
    if ( ! d || typeof d !== 'object' || typeof d.clientRequestId !== 'string' || ! UUID.test(d.clientRequestId) ) return null;
    return { clientRequestId: d.clientRequestId, category: CATEGORIES.includes(d.category) ? d.category : 'bug',
        description: typeof d.description === 'string' ? d.description.slice(0, 4000) : '' };
}

/** @param {{clientRequestId:string,category:string,description:string}|null} draft */
function write_draft (draft) {
    write_json(DRAFT_KEY, draft && draft.description.trim() ? draft : null);
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
    list.push({ clientRequestId, body });
    write_json(OUTBOX_KEY, list.slice(-OUTBOX_MAX));
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
 * POST one submitted body and settle the local state from the answer. Never
 * throws; resolves `{ status, data }` (status 0 = no response).
 */
async function deliver (clientRequestId, body) {
    if ( inflight.has(clientRequestId) ) return { status: -1, data: null };
    inflight.add(clientRequestId);
    let status = 0, data = null;
    try {
        // The exact, visible preview string is also the request body.
        const response = await fetch(endpoint(), { method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body });
        status = response.status;
        if ( status === 200 || status === 201 ) {
            data = await response.json();
            if ( typeof data?.id !== 'string' || ! UUID.test(data.id) ) { status = 0; data = null; }
        }
    } catch { status = 0; data = null; } finally {
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
                write_draft({ clientRequestId, category: CATEGORIES.includes(sent.category) ? sent.category : 'bug',
                    description: String(sent.description ?? '').slice(0, 4000) });
            } catch { /* An unreadable body has nothing to restore. */ }
        }
    }
    return { status, data };
}

/** Re-send every submitted-but-unconfirmed report, once each, in order. */
export async function flush_feedback_outbox () {
    if ( ! feedback_enabled() || navigator.onLine === false ) return;
    for ( const entry of read_outbox() ) {
        const { status } = await deliver(entry.clientRequestId, entry.body);
        if ( status === 0 ) break; // Still offline or unreachable: wait for the next `online`.
    }
}

function fullbleed_visible () {
    return [...document.querySelectorAll('.window.ezil-fullbleed')].some(el => {
        for ( let node = el; node; node = node.parentElement ) {
            const style = window.getComputedStyle(node);
            if ( style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ) return false;
        }
        return true;
    });
}

/** Mount the top-right Feedback chip (idempotent). */
export function mount_feedback_chip () {
    if ( ! feedback_enabled() || ! document.body ) return;
    let chip = document.querySelector('button.ezil-feedback-chip');
    if ( ! chip ) {
        chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ezil-feedback-chip';
        chip.setAttribute('aria-label', 'Feedback');
        chip.innerHTML = ICON + '<span>Feedback</span>';
        chip.addEventListener('click', () => { chip.focus(); open_feedback_dialog({ source: 'chip' }); });
        document.body.append(chip);
    }
    const sync = () => {
        // Without the floating-controls pill the chip is the only way to reach
        // Feedback from a full-bleed desktop, so it stays, compact, in the
        // top control strip (plan §6.8). With the pill on, the pill offers it.
        const fullbleed = fullbleed_visible();
        const pill = window.__EZIL_BOOT__?.desktopState?.ui?.floatingControls === true;
        const display = ! feedback_enabled() || (fullbleed && pill) ? 'none' : '';
        if ( chip.style.display !== display ) chip.style.display = display;
        if ( chip.classList.contains('ezil-feedback-chip-fullbleed') !== fullbleed ) chip.classList.toggle('ezil-feedback-chip-fullbleed', fullbleed);
    };
    chipObserver?.disconnect();
    chipObserver = new MutationObserver(sync);
    chipObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden'] });
    window.addEventListener('ezil:teardown', unmount_feedback_chip);
    window.addEventListener('pagehide', suspend_feedback_chip);
    sync();
    // A report submitted while offline (or before the tab closed) goes now.
    listen_online();
    if ( read_outbox().length ) void flush_feedback_outbox();
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

/** @param {{ source: 'chip'|'pill'|'troubleshoot' }} [_opts] */
export function open_feedback_dialog (_opts) {
    if ( ! feedback_enabled() ) return;
    if ( activeDialog?.isConnected ) { activeDialog.focus(); return; }
    const opener = document.activeElement;
    const draft = read_draft();
    const clientRequestId = draft?.clientRequestId ?? crypto.randomUUID();
    const waiting = read_outbox().filter(entry => entry.clientRequestId !== clientRequestId && ! inflight.has(entry.clientRequestId)).length;
    const computer = window.__EZIL_BOOT__?.computer?.id;
    const computerId = typeof computer === 'string' && UUID.test(computer) ? computer : null;
    const screenshots = window.__EZIL_BOOT__?.desktopState?.ui?.feedbackScreenshots === true;
    const dialog = document.createElement('dialog');
    dialog.className = 'ezil-feedback-dialog';
    dialog.setAttribute('aria-labelledby', 'ezil-feedback-heading');
    dialog.innerHTML = `
        <h2 id="ezil-feedback-heading">Send feedback</h2>
        <form>
            <fieldset class="ezil-feedback-fields">
                <fieldset class="ezil-feedback-category"><legend>Category</legend>
                    <label><input type="radio" name="category" value="bug" checked> Bug</label>
                    <label><input type="radio" name="category" value="idea"> Idea</label>
                    <label><input type="radio" name="category" value="other"> Other</label>
                </fieldset>
                <label for="ezil-feedback-description">Description</label>
                <textarea id="ezil-feedback-description" name="description" required maxlength="4000" rows="6"
                    aria-describedby="ezil-feedback-counter ezil-feedback-warning" autofocus></textarea>
                <p id="ezil-feedback-counter" class="ezil-feedback-muted" aria-live="polite"></p>
                <p id="ezil-feedback-warning" class="ezil-feedback-warning" role="status" hidden></p>
                <label class="ezil-feedback-consent"><input type="checkbox" name="diagnostics"> Include diagnostics</label>
                ${screenshots ? `<label class="ezil-feedback-consent"><input type="checkbox" name="screenshot"> Include a screenshot</label>
                <section class="ezil-feedback-capture" hidden aria-label="Screenshot">
                    <div class="ezil-feedback-actions">
                        <button type="button" data-capture="shell">Capture EZiL OS window</button>
                        ${tab_capture_supported() ? '<button type="button" data-capture="tab">Capture what I see</button>' : ''}
                        ${desktop_capture_supported() ? '<button type="button" data-capture="desktop">Capture the desktop</button>' : ''}
                    </div>
                    <div class="ezil-feedback-image" hidden>
                        <img alt="Screenshot to include with this report">
                        <button type="button" data-action="remove-screenshot">Remove screenshot</button>
                    </div>
                </section>` : ''}
            </fieldset>
            <details class="ezil-feedback-preview"><summary>Preview exactly what will be sent</summary><pre></pre>
                <p class="ezil-feedback-muted">EZiL also records which version of EZiL OS received the report.</p></details>
            <p class="ezil-feedback-result" role="status" aria-live="polite"></p>
            <div class="ezil-feedback-actions">
                <button type="button" data-action="cancel">Cancel</button>
                <button type="submit">Send feedback</button>
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
    const result = dialog.querySelector('.ezil-feedback-result');
    const submit = dialog.querySelector('[type="submit"]');
    const cancel = dialog.querySelector('[data-action="cancel"]');
    let screenshot = null;
    let serialized = '';
    let sending = false;
    let sent = false;
    let capturing = false;
    let captureGeneration = 0;
    let closed = false;
    let restoreCapture = null;
    let captureController = null;
    if ( draft ) {
        description.value = draft.description;
        for ( const radio of form.elements.category ) radio.checked = radio.value === draft.category;
    }

    function save_draft () {
        if ( sent || closed ) return;
        write_draft({ clientRequestId, category: form.elements.category.value, description: description.value });
    }

    function show_sent (data) {
        sent = true;
        fields.hidden = true;
        dialog.querySelector('.ezil-feedback-preview').hidden = true;
        submit.hidden = true;
        cancel.textContent = 'Close';
        result.textContent = `Thanks — we got it. Report ID: ${data.id}.`
            + (data.screenshotAccepted === false ? " Your image wasn't stored." : '');
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
        if ( result.textContent === 'Preparing screenshot…' ) result.textContent = '';
    }

    function refresh () {
        if ( sending || sent || closed ) return;
        const kinds = [...new Set(scan(description.value).map(match => match.kind))];
        const warning = dialog.querySelector('.ezil-feedback-warning');
        warning.hidden = kinds.length === 0;
        warning.textContent = kinds.length
            ? 'This looks like a token / email address — remove it before sending? ' + kinds.join(', ') : '';
        dialog.querySelector('#ezil-feedback-counter').textContent = `${description.value.length} / 4000`;
        const imageSection = dialog.querySelector('.ezil-feedback-capture');
        if ( imageSection ) imageSection.hidden = ! screenshotConsent.checked;
        const payload = { v: 1, clientRequestId, category: form.elements.category.value,
            description: description.value, computerId,
            diagnostics: diagnostics.checked ? build_diagnostics() : null,
            screenshot: screenshotConsent?.checked ? screenshot : null };
        serialized = JSON.stringify(payload, null, 2);
        preview.textContent = serialized;
        submit.disabled = capturing || ! description.value.trim() || description.value.length > 4000;
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

    for ( const button of dialog.querySelectorAll('[data-capture]') ) {
        button.addEventListener('click', () => {
            if ( capturing || sending || sent || closed || ! screenshotConsent.checked ) return;
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
                if ( button.dataset.capture === 'tab' ) capture = capture_tab_frame({ hide, signal });
                else {
                    hide();
                    capture = button.dataset.capture === 'shell' ? capture_shell_snapshot({ signal }) : capture_desktop_frame({ signal });
                }
            } catch (error) { capture = Promise.reject(error); }
            void finish_capture(capture, generation, signal);
        });
    }
    dialog.querySelector('[data-action="remove-screenshot"]')?.addEventListener('click', () => {
        cancel_capture();
        clear_screenshot();
        refresh();
    });
    screenshotConsent?.addEventListener('change', () => {
        if ( ! screenshotConsent.checked ) { cancel_capture(); clear_screenshot(); }
    });
    form.addEventListener('input', () => { refresh(); save_draft(); });
    form.addEventListener('change', () => { refresh(); save_draft(); });
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if ( sending || sent || capturing || closed ) return;
        refresh();
        if ( submit.disabled || ! form.reportValidity() ) return;
        if ( ! feedback_enabled() ) { result.textContent = error_copy(404); return; }
        sending = true;
        fields.disabled = true;
        submit.disabled = true;
        cancel.textContent = 'Close';
        result.textContent = 'Sending… Closing this window does not cancel the report.';
        // From here the report belongs to the outbox, not the draft: closing
        // the dialog no longer discards it, and a failure that never got an
        // answer is re-sent with this same body when the connection returns.
        const body = serialized;
        outbox_put(clientRequestId, body);
        write_draft(null);
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
        else if ( retryable(outcome.status) ) {
            result.textContent = navigator.onLine === false
                ? "You're offline. Your report is saved and will be sent when you're back online."
                : error_copy(outcome.status) + " We'll also send it automatically when your connection comes back.";
        } else result.textContent = error_copy(outcome.status);
        refresh();
    });

    function cleanup () {
        if ( closed ) return;
        closed = true;
        cancel_capture();
        for ( const type of ['ezil:teardown', 'popstate', 'pagehide', 'hashchange'] ) window.removeEventListener(type, close);
        window.removeEventListener('ezil:feedback-sent', on_sent);
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
    refresh();
    if ( waiting ) result.textContent = waiting === 1
        ? 'One earlier report is waiting to be sent. It will go when you are back online.'
        : `${waiting} earlier reports are waiting to be sent. They will go when you are back online.`;
    dialog.showModal();
    description.focus();
}

/** @returns {Promise<Array<{id:string,createdAt:string,category:string,descriptionPreview:string,hasScreenshot:boolean,status:string}>>} */
export async function list_my_reports () {
    if ( ! feedback_enabled() ) return [];
    const response = await fetch(endpoint(), { method: 'GET', credentials: 'same-origin' });
    if ( ! response.ok ) throw new Error('Could not load your reports. Try again.');
    const data = await response.json();
    if ( ! Array.isArray(data.reports) ) throw new Error('Could not load your reports. Try again.');
    return data.reports.slice(0, 50);
}

/** @param {string} _id @returns {Promise<boolean>} */
export async function delete_my_report (_id) {
    if ( ! feedback_enabled() || typeof _id !== 'string' || ! UUID.test(_id) ) return false;
    const route = endpoint();
    const response = await fetch(`${route}${route.includes('?') ? '&' : '?'}id=${encodeURIComponent(_id)}`,
        { method: 'DELETE', credentials: 'same-origin' });
    return response.status === 204;
}
