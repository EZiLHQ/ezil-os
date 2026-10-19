// feedback.js — EZiL-authored. Explicit consent, preview, then one submission.
// Wire/API signatures are pinned in docs/FEEDBACK-CONTROLS-CONTRACT.md.
import { build_diagnostics } from './diagnostics.js';
import { scan } from './secret-scan.js';
import { capture_shell_snapshot, tab_capture_supported, capture_tab_frame, capture_desktop_frame } from './capture.js';
import { open_redact_editor } from './redact-editor.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'
    + '<path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>';
let chipObserver = null;
let activeDialog = null;

function endpoint () { return globalThis.window?.__EZIL_BOOT__?.desktopState?.endpoints?.feedback; }

/** @returns {boolean} true when the boot payload exposes endpoints.feedback */
export function feedback_enabled () { return !! endpoint(); }

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
        const display = ! feedback_enabled() || fullbleed_visible() ? 'none' : '';
        if ( chip.style.display !== display ) chip.style.display = display;
    };
    chipObserver?.disconnect();
    chipObserver = new MutationObserver(sync);
    chipObserver.observe(document.body, { subtree: true, childList: true, attributes: true,
        attributeFilter: ['class', 'style', 'hidden'] });
    sync();
}

function read_blob (blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('image_read_failed'));
        reader.readAsDataURL(blob);
    });
}

function error_copy (status) {
    if ( status === 429 ) return "You've sent a lot of reports recently — try again later.";
    if ( status === 413 ) return 'This report is too large. Remove the screenshot and try again.';
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
    const clientRequestId = crypto.randomUUID();
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
                        <button type="button" data-capture="desktop">Capture the desktop</button>
                    </div>
                    <div class="ezil-feedback-image" hidden>
                        <img alt="Screenshot to include with this report">
                        <button type="button" data-action="remove-screenshot">Remove screenshot</button>
                    </div>
                </section>` : ''}
            </fieldset>
            <details class="ezil-feedback-preview"><summary>Preview exactly what will be sent</summary><pre></pre></details>
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
        const restore = () => { dialog.classList.remove('ezil-feedback-capturing'); };
        restoreCapture = restore;
        return restore;
    }

    async function finish_capture (capture, generation) {
        try {
            const canvas = await capture;
            restoreCapture?.();
            if ( closed || generation !== captureGeneration || ! screenshotConsent.checked ) return;
            if ( ! canvas ) { result.textContent = 'No screenshot captured. You can try another capture option.'; return; }
            const edited = await open_redact_editor(canvas);
            if ( ! edited || closed || generation !== captureGeneration || ! screenshotConsent.checked ) {
                result.textContent = '';
                return;
            }
            if ( ! ['image/png', 'image/jpeg', 'image/webp'].includes(edited.contentType)
                || edited.blob.size === 0 || edited.blob.size > 1.5 * 1024 * 1024
                || ! [edited.width, edited.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096) ) {
                result.textContent = 'The screenshot is too large or unsupported. Crop it further and try again.';
                return;
            }
            const dataBase64 = await read_blob(edited.blob);
            if ( closed || generation !== captureGeneration || ! screenshotConsent.checked ) return;
            screenshot = { contentType: edited.contentType, dataBase64 };
            const image = dialog.querySelector('.ezil-feedback-image');
            image.querySelector('img').src = `data:${screenshot.contentType};base64,${dataBase64}`;
            image.hidden = false;
            result.textContent = '';
        } catch {
            if ( ! closed ) result.textContent = 'Could not capture a screenshot. Try another capture option.';
        } finally {
            restoreCapture?.();
            capturing = false;
            if ( result.textContent === 'Preparing screenshot…' ) result.textContent = '';
            for ( const button of dialog.querySelectorAll('[data-capture]') ) button.disabled = false;
            refresh();
        }
    }

    for ( const button of dialog.querySelectorAll('[data-capture]') ) {
        button.addEventListener('click', () => {
            if ( capturing || sending || ! screenshotConsent.checked ) return;
            capturing = true;
            const generation = ++captureGeneration;
            for ( const el of dialog.querySelectorAll('[data-capture]') ) el.disabled = true;
            result.textContent = 'Preparing screenshot…';
            refresh();
            // No await before capture_tab_frame: preserve the click's browser
            // activation for getDisplayMedia. All three paths use the editor.
            let capture;
            try {
                if ( button.dataset.capture === 'tab' ) capture = capture_tab_frame({ hide });
                else {
                    hide();
                    capture = button.dataset.capture === 'shell' ? capture_shell_snapshot() : capture_desktop_frame();
                }
            } catch (error) { capture = Promise.reject(error); }
            void finish_capture(capture, generation);
        });
    }
    dialog.querySelector('[data-action="remove-screenshot"]')?.addEventListener('click', () => {
        ++captureGeneration;
        clear_screenshot();
        refresh();
    });
    screenshotConsent?.addEventListener('change', () => {
        if ( ! screenshotConsent.checked ) { ++captureGeneration; clear_screenshot(); }
    });
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        if ( sending || sent || capturing || closed ) return;
        refresh();
        if ( submit.disabled || ! form.reportValidity() ) return;
        if ( ! feedback_enabled() ) { result.textContent = error_copy(404); return; }
        sending = true;
        fields.disabled = true;
        submit.disabled = true;
        result.textContent = 'Sending…';
        try {
            // The exact, visible preview string is also the request body.
            const response = await fetch(endpoint(), { method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: serialized });
            if ( response.status !== 201 && response.status !== 200 ) {
                result.textContent = error_copy(response.status);
                return;
            }
            const data = await response.json();
            if ( typeof data.id !== 'string' || ! UUID.test(data.id) ) throw new Error('invalid_response');
            if ( closed ) return;
            sent = true;
            fields.hidden = true;
            dialog.querySelector('.ezil-feedback-preview').hidden = true;
            submit.hidden = true;
            cancel.textContent = 'Close';
            result.textContent = `Feedback sent. Report ID: ${data.id}.`
                + (data.screenshotAccepted === false ? " Your image wasn't stored." : '');
            cancel.focus();
        } catch {
            if ( ! closed ) result.textContent = error_copy(0);
        } finally {
            sending = false;
            fields.disabled = false;
            refresh();
        }
    });

    function cleanup () {
        if ( closed ) return;
        closed = true;
        ++captureGeneration;
        restoreCapture?.();
        clear_screenshot();
        dialog.remove();
        if ( activeDialog === dialog ) activeDialog = null;
        if ( opener?.isConnected ) opener.focus();
    }
    function close () { dialog.close(); cleanup(); }
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', cleanup);
    refresh();
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
