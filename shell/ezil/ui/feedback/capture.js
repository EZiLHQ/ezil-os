// One-shot feedback captures. Raw canvases must pass through the redaction editor.
import { request_frame_capture } from '../frame-controls-bridge.js';
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

/** Tier A: exclude private subtrees before snapdom can read or clone them. */
export async function capture_shell_snapshot ({ signal } = {}) {
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
        const snapshot = await with_timeout(snapdom(root, {
            // Viewport coordinates also work for the fixed-position shell windows.
            clip: 'viewport', dpr: 1, scale: Math.min(1, 1920 / Math.max(width, height)),
            cache: 'disabled', burst: false, embedFonts: false,
            exclude: [FEEDBACK_UI], excludeMode: 'hide', filterMode: 'hide',
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
        for (const { rect, frame } of masks.values()) {
            if (rect.width <= 0 || rect.height <= 0) continue;
            const x = Math.floor(rect.left * sx);
            const y = Math.floor(rect.top * sy);
            const w = Math.ceil(rect.right * sx) - x;
            const h = Math.ceil(rect.bottom * sy) - y;
            ctx.save();
            ctx.fillStyle = frame ? '#808080' : '#000000';
            ctx.fillRect(x, y, w, h);
            if (frame) {
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.clip();
                ctx.fillStyle = '#ffffff';
                ctx.font = `${Math.max(10, 14 * sx)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Desktop stream not captured', x + w / 2, y + h / 2, Math.max(1, w - 8));
            }
            ctx.restore();
        }
        return canvas;
    } catch {
        return null;
    }
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
