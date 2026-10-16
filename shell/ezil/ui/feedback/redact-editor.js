// Keep in sync with app/src/server/feedback/types.ts: FEEDBACK_LIMITS.imageBytesMax.
// Importing the server's TypeScript/zod module would add a runtime dependency.
const IMAGE_BYTES_MAX = Math.floor(1.5 * 1024 * 1024);
const LONG_EDGE_MAX = 1920;

/** Fit without upscaling; invalid/empty dimensions produce an empty size. */
export function fit_long_edge (w, h, max) {
    if (![w, h, max].every(n => Number.isFinite(n) && n > 0) || max < 1) {
        return { width: 0, height: 0 };
    }
    const scale = Math.min(1, Math.floor(max) / Math.max(w, h));
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function crop_bounds (source, crop) {
    if (!crop) return { x: 0, y: 0, width: source.width, height: source.height };
    if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
        || crop.width <= 0 || crop.height <= 0) throw new Error('Invalid crop');
    const x = clamp(Math.floor(crop.x), 0, source.width - 1);
    const y = clamp(Math.floor(crop.y), 0, source.height - 1);
    const right = clamp(Math.ceil(crop.x + crop.width), x + 1, source.width);
    const bottom = clamp(Math.ceil(crop.y + crop.height), y + 1, source.height);
    return { x, y, width: right - x, height: bottom - y };
}

/** Fresh canvas at source resolution. Boxes/crop use {x,y,width,height} source pixels. */
export function flatten (sourceCanvas, boxes = [], crop = null) {
    if (!(sourceCanvas?.width > 0 && sourceCanvas?.height > 0)) throw new Error('Empty screenshot');
    const bounds = crop_bounds(sourceCanvas, crop);
    const canvas = (sourceCanvas.ownerDocument || document).createElement('canvas');
    canvas.width = bounds.width;
    canvas.height = bounds.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sourceCanvas, -bounds.x, -bounds.y);
    ctx.fillStyle = '#000000';
    for (const box of boxes) {
        if (![box.x, box.y, box.width, box.height].every(Number.isFinite)
            || box.width <= 0 || box.height <= 0) throw new Error('Invalid redaction');
        // Round outward to cover every touched source pixel, including crop edges.
        const x = Math.floor(box.x);
        const y = Math.floor(box.y);
        ctx.fillRect(x - bounds.x, y - bounds.y,
            Math.ceil(box.x + box.width) - x, Math.ceil(box.y + box.height) - y);
    }
    return canvas;
}

/** @returns {Promise<Blob|null>} WebP q0.8, or JPEG; lower quality until within limit. */
export async function encode_under_limit (canvas, limit) {
    if (!(limit > 0)) return null;
    try {
        const type = canvas.toDataURL('image/webp', 0.8).startsWith('data:image/webp')
            ? 'image/webp' : 'image/jpeg';
        for (let step = 8; step >= 1; step--) {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, type, step / 10));
            // Browsers may silently substitute PNG; never mislabel that payload.
            if (!blob || blob.type !== type) return null;
            if (blob.size > 0 && blob.size <= limit) return blob;
        }
    } catch { /* Includes tainted canvases and unsupported encoders. */ }
    return null;
}

/**
 * @param {HTMLCanvasElement} _canvas
 * @returns {Promise<{blob: Blob, contentType: string, width: number, height: number} | null>}
 */
export async function open_redact_editor (_canvas) {
    let source;
    try { source = flatten(_canvas); } catch { return null; }
    const doc = source.ownerDocument;
    const view = doc.defaultView;
    const dialog = doc.createElement('dialog');
    if (typeof dialog.showModal !== 'function') return null;
    dialog.className = 'ezil-redact-editor';
    dialog.setAttribute('aria-label', 'Edit screenshot');
    dialog.setAttribute('data-feedback-ui', 'redaction');
    dialog.setAttribute('data-capture', 'exclude');
    dialog.innerHTML = `
        <h2>Edit screenshot</h2>
        <p>Cover private information with solid black boxes, then choose Use screenshot.</p>
        <div class="ezil-redact-tools" role="group" aria-label="Screenshot tools">
            <button type="button" data-action="redact" aria-label="Draw redaction rectangles" aria-pressed="true">Redact</button>
            <button type="button" data-action="crop" aria-label="Select crop area" aria-pressed="false">Crop</button>
            <button type="button" data-action="add" aria-label="Add centred redaction box">Add box</button>
            <button type="button" data-action="undo" aria-label="Undo last change" disabled>Undo</button>
            <button type="button" data-action="clear" aria-label="Clear all redactions and crop" disabled>Clear</button>
        </div>
        <p class="ezil-redact-help">Drag to draw. Tab through boxes; arrows move, Shift + arrows resize.
            Steps are 10 pixels, or 1 with Alt. Delete removes the selected box or crop.</p>
        <div class="ezil-redact-viewport">
            <div class="ezil-redact-stage" role="group" aria-label="Screenshot editing area">
                <canvas aria-label="Screenshot preview" role="img"></canvas>
                <div class="ezil-redact-overlays"></div>
            </div>
        </div>
        <p class="ezil-redact-status" role="status" aria-live="polite"></p>
        <div class="ezil-redact-actions">
            <button type="button" data-action="cancel" aria-label="Cancel screenshot">Cancel</button>
            <button type="button" data-action="confirm" aria-label="Use edited screenshot">Use screenshot</button>
        </div>`;
    const previousFocus = doc.activeElement;
    const stage = dialog.querySelector('.ezil-redact-stage');
    const overlays = dialog.querySelector('.ezil-redact-overlays');
    const preview = dialog.querySelector('canvas');
    const status = dialog.querySelector('.ezil-redact-status');
    const button = action => dialog.querySelector(`[data-action="${action}"]`);
    let boxes = [], crop = null, selected = null, tool = 'redact';
    let history = [], gesture = null, busy = false, settled = false;
    const snapshot = () => ({ boxes: boxes.map(box => ({ ...box })), crop: crop && { ...crop }, selected });
    const restore = state => { boxes = state.boxes; crop = state.crop; selected = state.selected; };
    const remember = state => {
        history.push(state);
        if (history.length > 100) history.shift();
    };
    const selected_rect = () => selected === 'crop' ? crop : boxes[selected];
    const describe = (rect, label) => `${label}: x ${Math.round(rect.x)}, y ${Math.round(rect.y)}, `
        + `${Math.round(rect.width)} by ${Math.round(rect.height)} pixels`;

    function render (focus = false) {
        const hadFocus = overlays.contains(doc.activeElement);
        overlays.replaceChildren();
        const add_overlay = (rect, key, label, className) => {
            const el = doc.createElement('button');
            el.type = 'button';
            el.className = className;
            el.dataset.box = String(key);
            el.setAttribute('aria-label', describe(rect, label));
            el.setAttribute('aria-pressed', String(selected === key));
            el.disabled = busy;
            Object.assign(el.style, {
                left: `${rect.x / source.width * 100}%`, top: `${rect.y / source.height * 100}%`,
                width: `${rect.width / source.width * 100}%`, height: `${rect.height / source.height * 100}%`,
            });
            el.addEventListener('focus', () => {
                selected = key;
                for (const sibling of overlays.children) sibling.setAttribute('aria-pressed', String(sibling === el));
                status.textContent = describe(rect, label);
            });
            overlays.appendChild(el);
            if ((focus || hadFocus) && selected === key) el.focus({ preventScroll: true });
        };
        boxes.forEach((rect, index) => add_overlay(rect, index, `Redaction box ${index + 1}`, 'ezil-redact-box'));
        if (crop) add_overlay(crop, 'crop', 'Crop area', 'ezil-redact-crop');
        button('undo').disabled = busy || !history.length;
        button('clear').disabled = busy || (!boxes.length && !crop);
        button('redact').setAttribute('aria-pressed', String(tool === 'redact'));
        button('crop').setAttribute('aria-pressed', String(tool === 'crop'));
        stage.dataset.tool = tool;
        if (focus && !selected_rect()) button('add').focus();
    }

    function resize () {
        const availableWidth = dialog.querySelector('.ezil-redact-viewport').clientWidth || Math.max(1, view.innerWidth - 64);
        const availableHeight = Math.max(100, view.innerHeight * 0.9 - 300);
        const scale = Math.min(1, availableWidth / source.width, availableHeight / source.height);
        stage.style.width = `${Math.max(1, Math.floor(source.width * scale))}px`;
        stage.style.height = `${Math.max(1, Math.floor(source.height * scale))}px`;
    }

    function point (event) {
        const rect = stage.getBoundingClientRect();
        return {
            x: clamp((event.clientX - rect.left) * source.width / rect.width, 0, source.width),
            y: clamp((event.clientY - rect.top) * source.height / rect.height, 0, source.height),
        };
    }

    function drag_start (event) {
        if (busy || gesture || (event.button !== undefined && event.button !== 0)) return;
        event.preventDefault();
        const start = point(event);
        if (!Number.isFinite(start.x) || !Number.isFinite(start.y)) return;
        const before = snapshot();
        const hit = event.target.closest('[data-box]');
        if (hit) selected = hit.dataset.box === 'crop' ? 'crop' : Number(hit.dataset.box);
        else {
            start.x = Math.min(start.x, source.width - 1);
            start.y = Math.min(start.y, source.height - 1);
            if (tool === 'crop') { selected = 'crop'; crop = { ...start, width: 1, height: 1 }; }
            else { selected = boxes.length; boxes.push({ ...start, width: 1, height: 1 }); }
        }
        gesture = { start, before, moving: !!hit, rect: { ...selected_rect() }, id: event.pointerId };
        try { stage.setPointerCapture(event.pointerId); } catch { /* Window listeners handle older engines. */ }
        render(true);
    }

    function drag_move (event) {
        if (!gesture || (event.pointerId !== undefined && event.pointerId !== gesture.id)) return;
        event.preventDefault();
        const current = point(event);
        const rect = selected_rect();
        if (gesture.moving) {
            rect.x = clamp(gesture.rect.x + current.x - gesture.start.x, 0, source.width - rect.width);
            rect.y = clamp(gesture.rect.y + current.y - gesture.start.y, 0, source.height - rect.height);
        } else {
            rect.x = Math.min(gesture.start.x, current.x);
            rect.y = Math.min(gesture.start.y, current.y);
            rect.width = Math.max(1, Math.abs(current.x - gesture.start.x));
            rect.height = Math.max(1, Math.abs(current.y - gesture.start.y));
        }
        render();
    }

    function drag_end (event, cancel = false) {
        if (!gesture || (event.pointerId !== undefined && event.pointerId !== gesture.id)) return;
        const { before, id } = gesture;
        if (!cancel) drag_move(event);
        gesture = null;
        if (cancel) restore(before);
        else remember(before);
        try { stage.releasePointerCapture(id); } catch { /* Already released or touch fallback. */ }
        render(true);
    }

    // Pointer events cover mouse, pen and touch. Old touch engines use the same geometry.
    const touch_event = event => {
        const touch = Array.from(event.changedTouches || []).find(t => !gesture || t.identifier === gesture.id);
        return touch && { clientX: touch.clientX, clientY: touch.clientY, pointerId: touch.identifier,
            target: event.target, preventDefault: () => event.preventDefault() };
    };
    const touch_start = event => { const e = touch_event(event); if (e) drag_start(e); };
    const touch_move = event => { const e = touch_event(event); if (e) drag_move(e); };
    const touch_end = event => { const e = touch_event(event); if (e) drag_end(e, event.type === 'touchcancel'); };
    const pointer_cancel = event => drag_end(event, true);

    return new Promise(resolve => {
        function finish (result) {
            if (settled) return;
            settled = true;
            view.removeEventListener('resize', resize);
            view.removeEventListener('pointermove', drag_move);
            view.removeEventListener('pointerup', drag_end);
            view.removeEventListener('pointercancel', pointer_cancel);
            view.removeEventListener('touchmove', touch_move);
            view.removeEventListener('touchend', touch_end);
            view.removeEventListener('touchcancel', touch_end);
            try { dialog.close(); } catch { /* Detached dialogs can already be closed. */ }
            dialog.remove();
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
            resolve(result);
        }

        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        dialog.addEventListener('close', () => finish(null));
        dialog.addEventListener('keydown', event => {
            if (event.key === 'Escape') { event.preventDefault(); finish(null); return; }
            if (busy || gesture || !event.target.closest('[data-box]')) return;
            const rect = selected_rect();
            if (!rect) return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                remember(snapshot());
                if (selected === 'crop') crop = null;
                else boxes.splice(selected, 1);
                selected = boxes.length ? Math.min(Number(selected) || 0, boxes.length - 1) : crop ? 'crop' : null;
                render(true);
                return;
            }
            const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            const direction = directions[event.key];
            if (!direction) return; // Native Tab order visits every box, then exits to the actions.
            event.preventDefault();
            remember(snapshot());
            const step = event.altKey ? 1 : 10;
            if (event.shiftKey) {
                rect.width = clamp(rect.width + direction[0] * step, 1, source.width - rect.x);
                rect.height = clamp(rect.height + direction[1] * step, 1, source.height - rect.y);
            } else {
                rect.x = clamp(rect.x + direction[0] * step, 0, source.width - rect.width);
                rect.y = clamp(rect.y + direction[1] * step, 0, source.height - rect.height);
            }
            render(true);
        });
        dialog.addEventListener('click', async event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'cancel') { finish(null); return; }
            if (busy || gesture || !action) return;
            if (action === 'redact' || action === 'crop') {
                tool = action;
                if (tool === 'crop' && !crop) {
                    // A full-image crop gives keyboard users an editable starting point.
                    remember(snapshot());
                    crop = { x: 0, y: 0, width: source.width, height: source.height };
                    selected = 'crop';
                    render(true);
                } else render();
            } else if (action === 'add') {
                remember(snapshot());
                const width = Math.max(1, Math.round(source.width / 4));
                const height = Math.max(1, Math.round(source.height / 8));
                boxes.push({ x: Math.floor((source.width - width) / 2), y: Math.floor((source.height - height) / 2), width, height });
                selected = boxes.length - 1;
                tool = 'redact';
                render(true);
            } else if (action === 'undo' && history.length) {
                restore(history.pop());
                render(true);
            } else if (action === 'clear') {
                remember(snapshot());
                boxes = []; crop = null; selected = null;
                render();
                status.textContent = 'Redactions and crop cleared.';
            } else if (action === 'confirm') {
                busy = true;
                for (const el of dialog.querySelectorAll('button:not([data-action="cancel"])')) el.disabled = true;
                status.textContent = 'Preparing screenshot…';
                try {
                    let output = flatten(source, boxes, crop);
                    const size = fit_long_edge(output.width, output.height, LONG_EDGE_MAX);
                    if (size.width !== output.width || size.height !== output.height) {
                        const scaled = doc.createElement('canvas');
                        scaled.width = size.width; scaled.height = size.height;
                        const ctx = scaled.getContext('2d');
                        if (!ctx) throw new Error('Canvas unavailable');
                        ctx.drawImage(output, 0, 0, scaled.width, scaled.height);
                        output = scaled;
                    }
                    const blob = await encode_under_limit(output, IMAGE_BYTES_MAX);
                    if (settled) return;
                    if (blob) { finish({ blob, contentType: blob.type, width: output.width, height: output.height }); return; }
                    status.textContent = 'Could not prepare an image under 1.5 MiB. Try a smaller crop.';
                } catch {
                    status.textContent = 'Could not prepare this screenshot. Try again or cancel.';
                }
                busy = false;
                for (const el of dialog.querySelectorAll('button')) el.disabled = false;
                render();
            }
        });
        try {
            const size = fit_long_edge(source.width, source.height, LONG_EDGE_MAX);
            preview.width = size.width; preview.height = size.height;
            const ctx = preview.getContext('2d');
            if (!ctx) throw new Error('Canvas unavailable');
            ctx.drawImage(source, 0, 0, preview.width, preview.height);
            doc.body.appendChild(dialog);
            dialog.showModal();
            resize();
            view.addEventListener('resize', resize);
            stage.addEventListener('pointerdown', drag_start);
            view.addEventListener('pointermove', drag_move, { passive: false });
            view.addEventListener('pointerup', drag_end);
            view.addEventListener('pointercancel', pointer_cancel);
            if (!view.PointerEvent) {
                stage.addEventListener('touchstart', touch_start, { passive: false });
                view.addEventListener('touchmove', touch_move, { passive: false });
                view.addEventListener('touchend', touch_end, { passive: false });
                view.addEventListener('touchcancel', touch_end, { passive: false });
            }
            render();
            button('add').focus();
        } catch { finish(null); }
    });
}
