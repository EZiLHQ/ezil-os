// One-shot feedback captures. Raw canvases must pass through the redaction editor.
import { capture_target_registered, request_frame_capture } from '../frame-controls-bridge.js';
import { fit_long_edge } from './redact-editor.js';

// snapdom (~260 KB, shell/src/lib/snapdom-3.3.4) is NOT bundled: the shell's
// boot budget (app/src/app/os/page.tsx) should not pay for a capture tool most
// sessions never open. build-shell.sh copies it to /os/vendor/, and tier A
// imports it on first use. The path is assembled at runtime so esbuild leaves
// the import() alone instead of trying to bundle it.
const SNAPDOM_PATH = () => ['', 'os', 'vendor', 'snapdom-3.3.4.mjs'].join('/');
let snapdom_loading = null;
const load_snapdom = () => (snapdom_loading ??= import(SNAPDOM_PATH()).then((m) => m.snapdom));

const PRIVATE = 'input, textarea, [contenteditable], [data-ezil-private]';
const FEEDBACK_UI = 'dialog, #ezil-feedback-chip, .ezil-feedback-chip, '
    + '#feedback-chip, .feedback-chip, [data-ezil-feedback], [data-feedback-ui], '
    + '[id^="ezil-feedback-"], .ezil-feedback-dialog, .ezil-redact-editor';

/**
 * Tier A: exclude private subtrees before snapdom can read or clone them.
 * `info.frameCoverage` (when an object is passed) is set to the share of the viewport, 0..1, that
 * masked embedded frames cover, so a caller can tell a mostly grey snapshot from a useful one.
 */
export async function capture_shell_snapshot ({ signal, info } = {}) {
    try {
        if (signal?.aborted) return null;
        // 🔴 The whole body, not #ezil-os-root: Puter appends every window and
        // the taskbar directly to <body> (UIWindow / UITaskbar), so the root
        // holds only the wallpaper and a root snapshot showed no windows at
        // all. Feedback UI is excluded and frames/private fields masked below.
        const root = document.body;
        if (!root) return null;
        const view = document.defaultView;
        const width = document.documentElement.clientWidth || view.innerWidth;
        const height = document.documentElement.clientHeight || view.innerHeight;
        const size = fit_long_edge(width, height, 1920);
        if (!size.width || !size.height) return null;
        const masks = new Map();
        let unsafe = false;
        const snapdom = await with_timeout(load_snapdom(), null, signal);
        if (signal?.aborted) return null;
        const placed = new Set();
        const snapshot = await with_timeout(snapdom(root, {
            // Viewport coordinates also work for the fixed-position shell windows.
            clip: 'viewport', dpr: 1, scale: Math.min(1, 1920 / Math.max(width, height)),
            cache: 'disabled', burst: false, embedFonts: false,
            exclude: [FEEDBACK_UI], excludeMode: 'hide', filterMode: 'hide',
            plugins: [mask_in_clone(masks, placed)],
            filter (node) {
                try {
                    if (node.nodeType !== 1) return true;
                    if (node.matches(FEEDBACK_UI)) return false;
                    const frame = node.localName === 'iframe';
                    if (!frame && !node.matches(PRIVATE)) return true;
                    // No values, content, iframe URLs, or frame documents are read.
                    masks.set(node, { rect: node.getBoundingClientRect(), frame });
                    return false;
                } catch {
                    // snapdom otherwise keeps a node when a filter throws.
                    unsafe = true;
                    return false;
                }
            },
        }), null, signal);
        if (unsafe || signal?.aborted) return null;
        const captured = await with_timeout(snapshot.toCanvas(), null, signal);
        if (signal?.aborted) return null;
        const canvas = document.createElement('canvas');
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        if (!ctx || unsafe) return null;
        ctx.drawImage(captured, 0, 0, canvas.width, canvas.height);
        const sx = canvas.width / width;
        const sy = canvas.height / height;
        if (info && typeof info === 'object') info.frameCoverage = frame_coverage(masks.values(), width, height);
        // 🔴 Masks belong at each element's own layer, painted in the clone (`mask_in_clone`). Painting them
        // over the finished image also covered shell overlays stacked ABOVE a frame (needs_operator, progress,
        // errors) and left a reported screenshot almost entirely grey. Only a private field the clone pass could
        // not place is still covered here; its content is hidden either way. An unplaced frame needs nothing:
        // its document is never cloned, so that area shows what lies beneath it.
        for (const [node, { rect, frame }] of masks) {
            if (frame || placed.has(node) || rect.width <= 0 || rect.height <= 0) continue;
            const x = Math.floor(rect.left * sx);
            const y = Math.floor(rect.top * sy);
            ctx.fillStyle = '#000000';
            ctx.fillRect(x, y, Math.ceil(rect.right * sx) - x, Math.ceil(rect.bottom * sy) - y);
        }
        return canvas;
    } catch {
        return null;
    }
}

export const FRAME_MASK_TEXT = 'Desktop stream not captured';
const PLACEMENT = ['position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'transform', 'transform-origin',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'vertical-align'];

/**
 * snapdom plugin: give every filtered node's clone (snapdom keeps it as an invisible box of the same size,
 * `filterMode: 'hide'`) a visible mask inside it, so the mask sits at that node's place in the stacking
 * order and anything the shell draws above it stays visible. Frames get a grey box with a label, private
 * fields a black one. Nothing of the source node is read beyond its identity. `placed` collects the
 * source nodes that received a mask.
 */
export function mask_in_clone (masks, placed) {
    return {
        name: 'ezil-feedback-masks',
        afterClone (context) {
            const doc = context?.clone?.ownerDocument;
            if (!doc || !(context.nodeMap instanceof Map)) return;
            // snapdom 3.3.4 maps clone → source for the nodes it cloned; a filtered node's placeholder is unmapped.
            const reverse = new Map();
            for (const [clone, source] of context.nodeMap) reverse.set(source, clone);
            for (const [source, { frame }] of masks) {
                const clone = placeholder_of(context.nodeMap, reverse, source);
                // Never touch a live node: only a detached clone may receive a mask.
                if (!clone || clone === source || document.contains(clone)) continue;
                // snapdom's placeholder keeps only the box size: give it the source's placement and layer too
                // (layout properties only, never content), so it lands where the node was, under what was above it.
                const style = source.ownerDocument.defaultView.getComputedStyle(source);
                for (const property of PLACEMENT) clone.style.setProperty(property, style.getPropertyValue(property));
                const mask = doc.createElement('div');
                mask.setAttribute('data-ezil-capture-mask', frame ? 'frame' : 'private');
                // The placeholder keeps `visibility: hidden`; a visible child of it is painted in its place.
                mask.style.cssText = 'display:flex;align-items:center;justify-content:center;box-sizing:border-box;margin:0;padding:0;'
                    + 'width:100%;height:100%;overflow:hidden;visibility:visible;opacity:1;'
                    + `background:${frame ? '#808080' : '#000000'};color:#ffffff;font:14px sans-serif;text-align:center;`;
                if (frame) mask.textContent = FRAME_MASK_TEXT;
                clone.replaceChildren(mask);
                placed.add(source);
            }
        },
    };
}

/**
 * The clone placeholder of a filtered source node: inside its parent's clone, the unmapped element children
 * stand for the parent's unmapped (filtered) source children, in the same order. Only an invisible box
 * (`visibility: hidden`, as snapdom's hide mode makes it) is accepted; anything else returns null.
 */
function placeholder_of (nodeMap, reverse, source) {
    try {
        const parent = source.parentElement;
        const cloneParent = parent && reverse.get(parent);
        if (!cloneParent) return null;
        const cloneKids = [...cloneParent.children];
        let cursor = 0;
        for (const child of parent.children) {
            const mapped = reverse.get(child);
            if (mapped) {
                const at = cloneKids.indexOf(mapped);
                if (at >= cursor) cursor = at + 1;
                continue;
            }
            while (cursor < cloneKids.length && nodeMap.has(cloneKids[cursor])) cursor++;
            const candidate = cloneKids[cursor++];
            if (child !== source) continue;
            return candidate && candidate.style?.visibility === 'hidden' ? candidate : null;
        }
    } catch { /* No placeholder found: the caller falls back. */ }
    return null;
}

/**
 * Share of the viewport covered by masked frames, 0..1. Rectangles are clipped to the viewport and
 * overlaps are counted once (a coarse grid is exact enough to decide "mostly grey").
 */
export function frame_coverage (masks, width, height) {
    if (!(width > 0 && height > 0)) return 0;
    const frames = [...masks].filter(mask => mask.frame && mask.rect.width > 0 && mask.rect.height > 0);
    if (!frames.length) return 0;
    const cols = 64, rows = 64;
    let covered = 0;
    for (let row = 0; row < rows; row++) {
        const y = (row + 0.5) * height / rows;
        for (let col = 0; col < cols; col++) {
            const x = (col + 0.5) * width / cols;
            if (frames.some(({ rect }) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom)) covered++;
        }
    }
    return covered / (cols * rows);
}

/** @returns {boolean} whether tier B (getDisplayMedia tab capture) is offered here */
export function tab_capture_supported () {
    const nav = globalThis.navigator;
    if (!nav?.mediaDevices?.getDisplayMedia) return false;
    const ua = nav.userAgent || '';
    const ipad = /Macintosh|MacIntel/i.test(`${ua} ${nav.platform || ''}`) && nav.maxTouchPoints > 1;
    return !(/iPhone|iPad|iPod|Android/i.test(ua) || ipad || nav.userAgentData?.mobile
        || /Android|iOS/i.test(nav.userAgentData?.platform || ''));
}

function with_timeout (promise, timeoutMs = 4000, signal) {
    let timer, abort;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            abort = () => reject(new Error('Capture cancelled'));
            if (signal?.aborted) { abort(); return; }
            signal?.addEventListener('abort', abort, { once: true });
            if (timeoutMs !== null) timer = setTimeout(() => reject(new Error('Capture timed out')), timeoutMs);
        }),
    ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
    });
}

function next_paint () {
    return new Promise(resolve => requestAnimationFrame(resolve));
}

function image_to_canvas (image, width = image.width, height = image.height) {
    if (!(width > 0 && height > 0)) return null;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    return canvas;
}

async function video_frame (stream, signal) {
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('aria-hidden', 'true');
    video.setAttribute('data-capture', 'exclude');
    video.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    let ready, failed;
    const loaded = new Promise((resolve, reject) => {
        ready = resolve;
        failed = () => reject(new Error('Video frame unavailable'));
        video.addEventListener('loadeddata', ready);
        video.addEventListener('error', failed);
    });
    try {
        document.body.appendChild(video);
        video.srcObject = stream;
        const playing = video.play();
        if (video.readyState >= 2) ready();
        await with_timeout(Promise.all([loaded, playing]), 4000, signal);
        if (signal?.aborted) return null;
        return image_to_canvas(video, video.videoWidth, video.videoHeight);
    } finally {
        video.removeEventListener('loadeddata', ready);
        video.removeEventListener('error', failed);
        try { video.pause(); } catch { /* Still detach and stop the tracks. */ }
        video.srcObject = null;
        video.remove();
    }
}

/** Tier B. MUST be called synchronously from a click handler. */
export async function capture_tab_frame ({ hide, signal } = {}) {
    let stream, restore;
    let finished = false;
    const stop = value => {
        for (const track of value.getTracks()) {
            try { track.stop(); } catch { /* Attempt every track even if one fails. */ }
        }
    };
    try {
        if (signal?.aborted || !tab_capture_supported()) return null;
        // Invoke the picker before any await to preserve transient activation.
        // A browser picker cannot be dismissed programmatically. If granted
        // after cancellation, stop its stream without displaying an editor.
        const acquiring = navigator.mediaDevices.getDisplayMedia({
            video: { displaySurface: 'browser' }, audio: false,
            preferCurrentTab: true, selfBrowserSurface: 'include',
            surfaceSwitching: 'exclude', monitorTypeSurfaces: 'exclude',
        }).then(value => {
            if (finished || signal?.aborted) { stop(value); return null; }
            stream = value;
            return value;
        });
        await with_timeout(acquiring, null, signal);
        if (!stream || signal?.aborted) return null;
        restore = hide?.();
        await with_timeout(next_paint().then(next_paint), 4000, signal);
        if (signal?.aborted) return null;
        const track = stream.getVideoTracks()[0];
        if (!track) return null;
        const Capture = globalThis.ImageCapture;
        if (typeof Capture !== 'function') return await video_frame(stream, signal);
        let bitmap, frameFinished = false;
        try {
            await with_timeout(new Capture(track).grabFrame().then(frame => {
                if (frameFinished || signal?.aborted) { frame.close?.(); return null; }
                bitmap = frame;
                return frame;
            }), 4000, signal);
            return bitmap && !signal?.aborted ? image_to_canvas(bitmap) : null;
        } finally {
            frameFinished = true;
            bitmap?.close?.();
        }
    } catch {
        return null;
    } finally {
        finished = true;
        if (stream) stop(stream);
        try { if (typeof restore === 'function') restore(); } catch { /* Capture stays non-throwing. */ }
    }
}

/** Tier C is offered only while a desktop frame is registered (round-3 F4). */
export function desktop_capture_supported () {
    return capture_target_registered();
}

/** Tier C: cooperative in-frame capture of the remote desktop. */
export async function capture_desktop_frame ({ signal } = {}) {
    let bitmap;
    let finished = false;
    try {
        if (signal?.aborted) return null;
        const blob = await with_timeout(request_frame_capture({ timeoutMs: 4000, signal }), 4000, signal);
        if (!blob || signal?.aborted || typeof globalThis.createImageBitmap !== 'function') return null;
        await with_timeout(createImageBitmap(blob).then(frame => {
            if (finished || signal?.aborted) { frame.close?.(); return null; }
            bitmap = frame;
            return frame;
        }), 4000, signal);
        return bitmap && !signal?.aborted ? image_to_canvas(bitmap) : null;
    } catch {
        return null;
    } finally {
        finished = true;
        bitmap?.close?.();
    }
}
