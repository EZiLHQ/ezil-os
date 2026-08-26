/*
 * ezil-mobile.js — the two things only code inside the stream's own document
 * can do.
 *
 * Loaded by /var/www/index.html, so it runs IN the desktop's own origin, in
 * the desktop's own document, with full access to the client app's DOM. The
 * EZiL shell cannot do any of this: the desktop is a cross-origin iframe, so
 * the shell can neither reach this document nor postMessage into a client
 * that does not listen. This file is the only lever there is.
 *
 * TWO INDEPENDENT CONCERNS LIVE HERE, AND THEY ARE GATED DIFFERENTLY:
 *
 *   1. THE BLACK-PICTURE DETECTOR — runs on EVERY device. It is the only code
 *      in the product that can read the decoded picture, because the `<video>`
 *      is in this origin and the shell's is not. See its own banner below for
 *      the measurements behind every threshold. A black desktop is not a phone
 *      problem, so it must never end up behind the touch gate.
 *   2. THE ON-SCREEN-KEYBOARD AFFORDANCE — touch devices only, a hard no-op
 *      otherwise. Everything from the `isTouchDevice()` gate down is this.
 *
 * They share only `NS` and the `postMessage` convention. Keep it that way.
 *
 * The rest of this header is about (2).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THE UPSTREAM CLIENT ALREADY DOES  (read this before changing anything)
 * ───────────────────────────────────────────────────────────────────────────
 * Almost all of the machinery already exists in the compiled client bundle
 * (js/app.4919abb0.js). Verified by reading the bundle and by driving a real
 * container from a touch-enabled browser:
 *
 *   1. `<textarea ref="overlay" class="overlay">` covers the whole player. It
 *      is a REAL, focusable, full-size textarea (transparent text/background,
 *      `resize:none`) — i.e. exactly the "hidden input the OS keyboard
 *      attaches to" that any mobile-keyboard shim would otherwise have to
 *      invent.
 *   2. A Guacamole-derived keyboard is bound to it with `listenTo(overlay)`.
 *      Its `onkeydown`/`onkeyup` call `$client.sendData('keydown'|'keyup')`,
 *      which packs an X keysym into a binary frame and pushes it down the
 *      WebRTC data channel, where the server replays it over XTEST.
 *      That listener already covers hardware keys AND soft keyboards: it
 *      ignores `keydown` with `keyCode === 229` / `isComposing` and instead
 *      routes the `input` event's `.data` through `keyboard.type()`, plus
 *      `compositionstart`/`compositionend` for IME. There is therefore NO
 *      reason to add a second input element or a second key path — doing so
 *      would mean re-implementing keysym translation, modifier tracking and
 *      the macOS remap that the bundle already has. We reuse the overlay.
 *   3. `get is_touch_device()` and `openMobileKeyboard() { overlay.focus() }`
 *      exist, and a `<li>` carrying a keyboard glyph is rendered in
 *      `.video-menu.bottom` when `hosting && is_touch_device`.
 *
 * So this file does NOT build a keyboard. It repairs the two things that stop
 * the existing one from being usable on a phone:
 *
 *   (A) THE AFFORDANCE DISAPPEARS UNLESS WE ARE ALREADY THE HOST.
 *       That `<li>` is gated on `hosting`. The app layer normally flips
 *       `session.implicit_hosting` to true before handing over the URL
 *       (`enableImplicitHosting` in cloudflare-guacamole-provider.ts), which
 *       makes `hosting` true immediately. But that call is explicitly
 *       best-effort and degrades to control mode 'manual' on any failure. In
 *       'manual' mode, verified live: the keyboard button is not in the DOM
 *       at all, the overlay carries `pointer-events: none`, and every
 *       keystroke is dropped by the `hosting && !locked` guard. A phone user
 *       in that state has no way to type and no way to see why. We recover it
 *       by taking control the way the client's own UI does.
 *
 *   (B) THE HIT TARGET IS 30x30 AND LANDS IN THE LETTERBOX.
 *       `.video-menu` is positioned against `.player`, not against the
 *       picture. On a 390x844 phone the picture measures 394x223 while that
 *       button sits at y=799 — roughly 260px below the image, in the black
 *       bar, at 30x30 CSS px, unlabelled. That is under both the 44px iOS and
 *       48px Android minimum touch target. Ours is `position: fixed`, so no
 *       amount of letterboxing can strand it, and it is sized to 48px.
 *
 * It also handles the thing neither side handles today: a raised keyboard
 * shrinks the visual viewport and would otherwise cover the button that
 * dismisses it, so we track `visualViewport` and stay above the keyboard.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT WE DELIBERATELY DO NOT DO
 * ───────────────────────────────────────────────────────────────────────────
 * - We do not raise the keyboard on a tap into the picture. The overlay's own
 *   `touchstart` handler calls `preventDefault()` and re-dispatches the touch
 *   as a mouse event, on purpose: a tap on the stream is a REMOTE click, not
 *   local text entry. Nothing in the client knows, or can know, that a text
 *   field inside the remote desktop just took focus — there is no protocol
 *   message for remote focus. An explicit affordance is the only mechanism
 *   available, which is why upstream added one too.
 * - We do not steal control from another member. We only take control when
 *   nobody holds it (upstream marks that state with the `faded` class).
 * - We do not touch any element the compiled bundle owns, beyond calling
 *   `focus()` / `blur()` / `click()` on it — the same calls its own handlers
 *   make. Nothing is re-parented, restyled or removed, so a Vue re-render can
 *   never fight us.
 * - We are a hard no-op on non-touch devices. The gate is capability, not
 *   viewport width: a narrow desktop window must never sprout this button.
 */
(function () {
    'use strict';

    var NS = 'ezil-mobile';
    var STATE = { armed: false, reason: null, open: false, tookControl: false, inputGuarded: false, errors: [] };
    // Readable from a verifier's `page.evaluate()`; not part of any wire contract.
    try {
        Object.defineProperty(window, '__ezilMobileKeyboard', { value: STATE, writable: false });
    } catch (e) {
        window.__ezilMobileKeyboard = STATE;
    }

    function warn(code, detail) {
        STATE.errors.push(code);
        try {
            console.warn('[' + NS + '] ' + code + (detail ? ' — ' + detail : ''));
        } catch (e) {
            /* console can be absent in some embedded webviews */
        }
        // The shell listens for this (`onMobileBridgeMessage` in
        // `shell/ezil/telemetry.js`) and turns it into the
        // `ezil-os:apps/desktop#keyboard` / `window_error` row that cannot be
        // emitted from this origin. Only `type`, `site` and `code` are read
        // there — `detail` and `attrs` are deliberately never taken off a
        // cross-origin message — and both `type` and `site` must be in the
        // bridge's closed set, so adding a new one here means adding it there.
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(
                    { source: 'ezil-mobile', type: 'window_error', site: 'ezil-os:apps/desktop#keyboard', code: code },
                    '*',
                );
            }
        } catch (e) {
            /* cross-origin parent may reject; never fatal */
        }
    }


    // ═══════════════════════════════════════════════════════════════════════
    // CONCERN 1 of 2 — THE BLACK-PICTURE DETECTOR.
    //
    // 🔴 THIS HALF RUNS ON EVERY DEVICE. The touch gate below it belongs to
    // the keyboard affordance and to nothing else. A black desktop is not a
    // phone problem: production rendered EVERY sampled pixel at exactly 0 on
    // 13 of 13 opens from a desktop browser, while the shell reported `ready`
    // and telemetry recorded `outcome: 'ok'`. Do not move this below the gate.
    //
    // WHY THIS FILE. The `<video>` carrying the desktop lives in THIS
    // document's origin. The shell embeds that document as a cross-origin
    // iframe, so no code in the shell can draw the video into a canvas and
    // read it back — and `getStats()` on the peer connection is equally out of
    // reach there. This script is the only place in the product that can see
    // whether there is a picture at all. Everything else — the container's
    // window-ready gate, `?confirm=frame`, `?confirm=display`, neko's own
    // `is_watching` bookkeeping — answers a question about plumbing, and all
    // of them answered "fine" on a completely black screen.
    //
    // TWO SIGNALS, AND WHICH ONE IS THE VERDICT.
    //
    //   1. PIXELS (the verdict). `drawImage(video)` + `getImageData`. WebRTC
    //      MediaStreams do not taint a canvas, so this is a direct read of the
    //      decoded picture. Measured:
    //        production black   meanLuma 0.000, maxLuma 0, nonzeroFrac 0.0000
    //                           (13/13 opens, 23,040 px/reading, 6 per open,
    //                           two resolutions, before and after injected input)
    //        healthy, idle      meanLuma 33.6–34.7, nonzeroFrac 1.0000
    //        calibration loop   meanLuma 197.97, nonzeroFrac 1.0000
    //      The failure is not "dim". It is exactly zero everywhere.
    //
    //   2. NORMALISED BITRATE (the fallback). Video bitrate divided by frame
    //      area, from `getStats()`. Used only when the pixels cannot be read
    //      (a tainted canvas, no 2D context). Measured:
    //        black,   1440x900  (n=10)          0.0371 kbps/kpx
    //        black,   1920x1080 (n=1)           0.0355 kbps/kpx
    //        healthy, 1920x1080, EQUALLY IDLE   0.1419 kbps/kpx
    //      ~3.8x apart, and the two black runs at different resolutions agree
    //      to within 5% — which is what a content-determined metric should do.
    //      Reported under a DIFFERENT code, because it is a proxy and the
    //      pixel read is not.
    //
    // WHY IT DOES NOT FIRE ON A STATIC SCREEN. An idle desktop showing a still
    // page is not black: the healthy reference above was equally idle and
    // still read meanLuma 33.6 and 0.142 kbps/kpx. "Nothing is moving" and
    // "there is nothing to see" are different measurements, and this samples
    // the second one. On top of that the watch is ONE-SHOT and anchored at the
    // start of the stream (see `GRACE_TICKS`): the first non-black sample ends
    // it for good, so a user who later opens a full-screen dark editor is
    // never looked at. A user cannot have blanked a screen they have not been
    // shown yet, which is exactly why the boot window is the safe place to ask.
    // The cost of that choice is stated plainly: a desktop that goes black
    // MID-SESSION is not detected here. It is detected on the next open.
    // ═══════════════════════════════════════════════════════════════════════

    var PICTURE_SITE = 'ezil-os:apps/desktop#picture';

    // 2/255 is "nothing in this frame is brighter than decode noise". It
    // leaves room for a limited-range decode of a 0 source and no room at all
    // for content: the dimmest healthy frame ever measured has a mean 17x
    // above this and a max of 255.
    var BLACK_MAX_LUMA = 2;

    // The geometric mean of the two measured clusters (0.037 and 0.142):
    // ~1.95x above black, ~1.97x below healthy. With exactly two calibration
    // clusters and no distribution for either, the log-midpoint is the
    // placement that maximises the margin on both sides.
    var STARVED_KBPS_PER_KPX = 0.072;

    // Sampling is TICK-counted, not clock-counted, on purpose. A hidden or
    // backgrounded iframe has its timers throttled, and a throttled tick makes
    // the sustain window longer in wall-clock terms, never shorter. For a
    // detector that writes an error row, erring conservative is the only
    // acceptable direction.
    var SAMPLE_INTERVAL_MS = 1000;
    var GRACE_TICKS = 3;       // ramp-up and the first keyframe (up to 4.3s observed)
    var VERDICT_TICKS = 8;     // consecutive black samples before we say so
    var WATCH_TICKS_MAX = 90;  // stop looking for a stream that never arrives

    var PICTURE = {
        // idle -> watching -> healthy | verdict | gave-up | error
        state: 'idle',
        ticks: 0,
        liveTicks: 0,
        blackRun: 0,
        lastLuma: null,
        lastNorm: null,
        reported: null,
    };
    // Readable from a verifier's `page.evaluate()`; not part of any wire contract.
    try {
        Object.defineProperty(window, '__ezilPicture', { value: PICTURE, writable: false });
    } catch (e) {
        window.__ezilPicture = PICTURE;
    }

    /**
     * The one wire home. `code` is the ONLY field the shell's bridge reads off
     * this message — it never reads `detail`, `attrs`, `correlationId` or
     * `computerId` from a cross-origin post, deliberately — so every number
     * measured here has to collapse into a code before it leaves this origin.
     * That is why there are two codes and not one: they carry how much the
     * reader should believe.
     *
     *   `picture_black`   the pixels were read and they were black. A verdict.
     *   `picture_starved` the pixels could not be read; the encoder is
     *                     producing ~2% of its configured bitrate for the
     *                     frame area it claims. A proxy.
     */
    function reportPicture(code) {
        if (PICTURE.reported) return;
        PICTURE.reported = code;
        try {
            console.warn(
                '[' + NS + '] ' + code
                + ' — luma=' + JSON.stringify(PICTURE.lastLuma)
                + ' norm=' + PICTURE.lastNorm,
            );
        } catch (e) {
            /* console can be absent in some embedded webviews */
        }
        try {
            if (window.parent && window.parent !== window) {
                window.parent.postMessage(
                    { source: 'ezil-mobile', type: 'display_failure', site: PICTURE_SITE, code: code },
                    '*',
                );
            }
        } catch (e) {
            /* cross-origin parent may reject; never fatal */
        }
    }

    // ── Reaching the peer connection ────────────────────────────────────────
    // We do NOT replace `window.RTCPeerConnection`. Swapping a global
    // constructor out from under a WebRTC bundle risks breaking the stream,
    // and a broken stream is a far worse outcome than a missing telemetry row.
    // Wrapping one prototype method leaves construction, object identity and
    // the prototype chain untouched, and `setRemoteDescription` is called by
    // every peer that receives media, so it cannot be missed.
    var peers = [];

    function hookPeers() {
        try {
            var P = window.RTCPeerConnection;
            if (!P || !P.prototype) return;
            if (P.prototype.__ezilPeerHook) return;
            var orig = P.prototype.setRemoteDescription;
            if (typeof orig !== 'function') return;
            P.prototype.setRemoteDescription = function () {
                try {
                    if (peers.indexOf(this) === -1) peers.push(this);
                } catch (e) {
                    /* never let bookkeeping break the handshake */
                }
                return orig.apply(this, arguments);
            };
            try {
                Object.defineProperty(P.prototype, '__ezilPeerHook', { value: true });
            } catch (e) {
                P.prototype.__ezilPeerHook = true;
            }
        } catch (e) {
            /* stats half disabled; the pixel verdict does not depend on it */
        }
    }

    // ── The picture ─────────────────────────────────────────────────────────
    var canvas = null;
    var ctx = null;

    /**
     * The stream's `<video>`, but only once it is safe to read.
     *
     * 🔴 `readyState >= 2` (HAVE_CURRENT_DATA) is the single most important
     * false-positive defence in this file. `drawImage` from a video with no
     * decoded frame leaves the canvas untouched, and an untouched canvas reads
     * back as transparent black — i.e. it would manufacture the exact fault we
     * are looking for, on every healthy desktop, during every boot.
     */
    function liveVideo() {
        var v;
        try {
            v = document.querySelector('video');
        } catch (e) {
            return null;
        }
        if (!v) return null;
        if (!v.videoWidth || !v.videoHeight) return null;
        if (typeof v.readyState === 'number' && v.readyState < 2) return null;
        return v;
    }

    /** Rec. 601 luma over a 64x36 downsample. `null` if the pixels are unreadable. */
    function sampleLuma(v) {
        try {
            if (!canvas) {
                canvas = document.createElement('canvas');
                canvas.width = 64;
                canvas.height = 36;
                ctx = canvas.getContext('2d', { willReadFrequently: true });
            }
            if (!ctx) return null;
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            var d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            var n = d.length / 4;
            if (!n) return null;
            var max = 0;
            var sum = 0;
            var nonzero = 0;
            for (var i = 0; i < d.length; i += 4) {
                var y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
                sum += y;
                if (y > max) max = y;
                if (y > 0) nonzero += 1;
            }
            return { max: max, mean: sum / n, nonzeroFrac: nonzero / n };
        } catch (e) {
            // SecurityError on a tainted canvas, or no 2D context at all.
            return null;
        }
    }

    // ── The normalised bitrate ──────────────────────────────────────────────
    var statsPrev = null;

    function pumpStats() {
        var pc = peers.length ? peers[peers.length - 1] : null;
        if (!pc || typeof pc.getStats !== 'function') return;
        var promise;
        try {
            promise = pc.getStats();
        } catch (e) {
            return;
        }
        if (!promise || typeof promise.then !== 'function') return;
        promise.then(function (report) {
            try {
                var s = null;
                report.forEach(function (entry) {
                    if (entry && entry.type === 'inbound-rtp' && entry.kind === 'video') s = entry;
                });
                if (!s || typeof s.bytesReceived !== 'number') return;
                var v = liveVideo();
                var w = s.frameWidth || (v ? v.videoWidth : 0) || 0;
                var h = s.frameHeight || (v ? v.videoHeight : 0) || 0;
                var at = Date.now();
                if (statsPrev && w > 0 && h > 0) {
                    var dtSec = (at - statsPrev.at) / 1000;
                    var dBytes = s.bytesReceived - statsPrev.bytes;
                    // Guard the clock and the counter. A suspended tab, a clock
                    // step or a stats reset would otherwise manufacture a
                    // starved reading out of arithmetic alone.
                    if (dtSec >= 0.5 && dtSec <= 10 && dBytes >= 0) {
                        PICTURE.lastNorm = ((dBytes * 8) / 1000 / dtSec) / ((w * h) / 1000);
                    }
                }
                statsPrev = { at: at, bytes: s.bytesReceived };
            } catch (e) {
                /* a stats shape we do not recognise is not evidence of anything */
            }
        }, function () {
            /* getStats rejects on a closing connection; not our business */
        });
    }

    // ── The loop ────────────────────────────────────────────────────────────
    var pictureTimer = null;

    function stopWatch(state) {
        PICTURE.state = state;
        if (pictureTimer !== null) {
            try {
                clearInterval(pictureTimer);
            } catch (e) {
                /* ignore */
            }
            pictureTimer = null;
        }
    }

    function pictureTick() {
        try {
            PICTURE.ticks += 1;
            if (PICTURE.ticks > WATCH_TICKS_MAX) {
                // No stream ever arrived. That is a different failure, and the
                // shell's own frame/display gates already own it. Say nothing.
                stopWatch('gave-up');
                return;
            }
            // Idempotent, and re-tried every tick: the bundle constructs its
            // peer after a signalling round trip, which can land after us.
            hookPeers();

            var v = liveVideo();
            if (!v) return;
            PICTURE.state = 'watching';
            PICTURE.liveTicks += 1;
            pumpStats();
            if (PICTURE.liveTicks <= GRACE_TICKS) return;

            var luma = sampleLuma(v);
            PICTURE.lastLuma = luma;

            var black;
            if (luma) {
                black = luma.max <= BLACK_MAX_LUMA;
            } else if (typeof PICTURE.lastNorm === 'number') {
                black = PICTURE.lastNorm < STARVED_KBPS_PER_KPX;
            } else {
                // No pixels and no stats. Silence is the correct output.
                return;
            }

            if (!black) {
                // 🔴 This is what makes the detector free on a healthy desktop:
                // one canvas readback and it is done, permanently. It also
                // means a legitimately dark screen later in the session is
                // never judged.
                stopWatch('healthy');
                return;
            }

            PICTURE.blackRun += 1;
            if (PICTURE.blackRun >= VERDICT_TICKS) {
                reportPicture(luma ? 'picture_black' : 'picture_starved');
                stopWatch('verdict');
            }
        } catch (e) {
            // A detector that throws into the stream's own document would be
            // worse than no detector.
            stopWatch('error');
        }
    }

    hookPeers();
    try {
        pictureTimer = setInterval(pictureTick, SAMPLE_INTERVAL_MS);
    } catch (e) {
        PICTURE.state = 'error';
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONCERN 2 of 2 — THE ON-SCREEN-KEYBOARD AFFORDANCE. Touch devices only.
    // Everything below this banner is the keyboard and nothing else; the
    // `return` in the gate exits the keyboard half, not the file. The
    // detector above has already been started and is unaffected by it.
    // ═══════════════════════════════════════════════════════════════════════

    // ── The gate ────────────────────────────────────────────────────────────
    // Same predicate the client's own `is_touch_device` uses, deliberately:
    // two different definitions of "is this a touch device" in one document is
    // how the button and the thing it drives end up disagreeing.
    function isTouchDevice() {
        try {
            var hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
            return hasTouch && window.matchMedia('(pointer: coarse)').matches;
        } catch (e) {
            return false;
        }
    }

    if (!isTouchDevice()) {
        STATE.reason = 'not-a-touch-device';
        return;
    }

    // ── Finding the client's overlay ────────────────────────────────────────
    // The app is a deferred module bundle, so the overlay does not exist at
    // parse time. Observe rather than poll-forever, and give up loudly.
    var ARM_DEADLINE_MS = 60000;
    var startedAt = Date.now();

    function overlayEl() {
        return document.querySelector('textarea.overlay');
    }

    function whenOverlay(cb) {
        var found = overlayEl();
        if (found) {
            cb(found);
            return;
        }
        var obs = new MutationObserver(function () {
            var el = overlayEl();
            if (el) {
                obs.disconnect();
                clearInterval(tick);
                cb(el);
            } else if (Date.now() - startedAt > ARM_DEADLINE_MS) {
                obs.disconnect();
                clearInterval(tick);
                warn('keyboard-arm-failed', 'no player overlay after ' + ARM_DEADLINE_MS + 'ms');
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
        // MutationObserver misses nothing here, but a cheap timer keeps the
        // deadline honest even if the app mounts before we observe.
        var tick = setInterval(function () {
            var el = overlayEl();
            if (el) {
                obs.disconnect();
                clearInterval(tick);
                cb(el);
            } else if (Date.now() - startedAt > ARM_DEADLINE_MS) {
                obs.disconnect();
                clearInterval(tick);
                warn('keyboard-arm-failed', 'no player overlay after ' + ARM_DEADLINE_MS + 'ms');
            }
        }, 500);
    }

    // ── Control state, read straight off the client's own bindings ──────────
    // `:style="{ pointerEvents: hosting ? 'auto' : 'none' }"` on the overlay is
    // the client's own `hosting` flag rendered into the DOM. Reading it is
    // stable across a minified rebuild in a way that poking at Vue internals
    // (`__vue__`, `$accessor`) is not.
    function isHosting(overlay) {
        try {
            return getComputedStyle(overlay).pointerEvents === 'auto';
        } catch (e) {
            return false;
        }
    }

    // The client renders a pointer glyph for taking control whenever implicit
    // hosting is off and control is not locked. `faded` = nobody is host;
    // `disabled` = somebody else is. Click it only in the first case.
    function takeControlIfFree() {
        var icon = document.querySelector('.video-menu .fa-computer-mouse');
        if (!icon) return false;
        var cls = ' ' + icon.className + ' ';
        if (cls.indexOf(' disabled ') !== -1) return false;
        if (cls.indexOf(' faded ') === -1) return false;
        try {
            icon.click();
            STATE.tookControl = true;
            return true;
        } catch (e) {
            warn('keyboard-control-failed', String(e));
            return false;
        }
    }

    // ── The button ──────────────────────────────────────────────────────────
    var CSS = [
        // ── (D) TWO KEYBOARD BUTTONS ───────────────────────────────────────
        // Reported from a phone, with a screenshot: two keyboard affordances
        // on screen at once. Measured in a real client — upstream's
        // `<i class="fas fa-keyboard">` at 30x30 sitting at y=799 in the black
        // letterbox, and ours at 48x48 at y=784.
        //
        // (B) above explains why ours exists: upstream's is 30x30, unlabelled,
        // positioned against `.player` rather than the picture, and on a
        // 390x844 phone it lands roughly 260px BELOW the image — under both
        // the 44px iOS and 48px Android minimum touch targets. What (B) never
        // did was hide the one it replaces, so when `hosting` is true both are
        // rendered and the user is offered the same action twice, one of which
        // barely works.
        //
        // 🔴 A STYLESHEET RULE, NOT AN INLINE STYLE, and that is the whole
        // reason this is safe. This file's contract is that it never re-parents
        // or restyles an element the compiled bundle owns, so a Vue re-render
        // can never fight it. A rule in OUR stylesheet keeps that property: Vue
        // re-rendering that `<li>` does not remove our rule, whereas an inline
        // `style.display` would be wiped on the next patch. Nothing is removed
        // from the DOM, so the bundle's own handlers stay bound and intact.
        //
        // Both rules are deliberate. `:has()` hides the whole list item so no
        // empty tap target is left behind; the second is the fallback for a
        // browser without `:has()`, which at least removes the duplicate glyph.
        '.video-menu li:has(> .fa-keyboard){display:none !important;}',
        '.video-menu .fa-keyboard{display:none !important;}',
        '#ezil-kbd-btn{',
        'position:fixed;left:12px;bottom:12px;z-index:2147483000;',
        'width:48px;height:48px;padding:0;margin:0;border:0;border-radius:12px;',
        'display:flex;align-items:center;justify-content:center;',
        'background:rgba(22,22,22,.82);color:#00adb5;',
        'box-shadow:0 2px 10px rgba(0,0,0,.45);',
        'cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;',
        'transition:background .12s ease,color .12s ease;',
        '}',
        '#ezil-kbd-btn:active{background:rgba(0,173,181,.28);}',
        '#ezil-kbd-btn[data-open="true"]{background:#00adb5;color:#161616;}',
        '#ezil-kbd-btn svg{width:24px;height:24px;display:block;pointer-events:none;}',
    ].join('');

    // Inline mark, so the button does not depend on the bundle's icon font
    // being loaded (or on any particular glyph surviving a future rebuild).
    var ICON =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
        '<rect x="2" y="5" width="20" height="14" rx="2"/>' +
        '<path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M10 13h.01M14 13h.01M18 13h.01M8 16.5h8"/>' +
        '</svg>';

    // ── (C) THE SOFT KEYBOARD TYPES EVERYTHING TWICE ───────────────────────
    //
    // Reported from a phone: typing "fast" put "fastfast" in the remote
    // browser, and it got worse the longer you typed. Reproduced against a
    // real container by replaying what a predictive Android keyboard actually
    // emits — 4 characters produced 8 keydown frames on the wire.
    //
    // The cause is in the compiled client's Guacamole-derived keyboard, which
    // listens on the overlay like this (deminified from app.48a1d8f5.js):
    //
    //     keydown:          if (!e.isComposing && e.keyCode !== 229) -> send keysym
    //     input:            if (e.data && !e.isComposing)            -> type(e.data)
    //     compositionstart: removeEventListener("input", n)
    //     compositionend:   if (e.data)                              -> type(e.data)
    //
    // Two separate defects fall out of that on a phone:
    //
    //   A. SwiftKey (and Gboard) send REAL key codes per character AND run a
    //      composition. `keyCode !== 229` is therefore true, so every
    //      character goes out once as a keysym from `keydown` and again as
    //      text from `compositionend`. Hence "fast" -> "fastfast".
    //
    //   B. `compositionstart` REMOVES the input listener and nothing ever adds
    //      it back. After the first composed word, a character typed without
    //      composition has no delivery path left at all.
    //
    // Neither is reachable from a desktop browser, which is why it shipped.
    //
    // The repair is two `stopPropagation()` calls in the CAPTURE phase on
    // `window`, which runs before the overlay's own listeners and so can
    // withhold an event from the bundle without touching it:
    //
    //   * printable `keydown`/`keypress` never reach the keysym path, so text
    //     is delivered once, by the `input`/`compositionend` path that was
    //     built for it. Non-printable keys — Backspace, Enter, Tab, arrows,
    //     modifiers — are let through untouched, because they carry no text
    //     and the keysym path is the only thing that can send them.
    //
    //   * `compositionstart` never reaches the bundle, so its input listener
    //     is never removed and (B) cannot happen. Nothing else is bound to
    //     that event, and the bundle's own composition handling still works:
    //     `input` continues to ignore itself while `isComposing` is true, and
    //     `compositionend` still delivers the finished word.
    //
    // Touch devices only, like everything else in this file. A desktop
    // browser keeps the upstream behaviour exactly.
    function guardInput(overlay) {
        if (STATE.inputGuarded) return;

        // A single printable character. `key` is 'a', '.', '€'; anything
        // longer is a named key ('Backspace', 'Enter', 'ArrowLeft', 'Shift').
        function isPrintable(ev) {
            var k = ev.key;
            if (typeof k !== 'string') return false;
            // Array.from, not .length: an emoji is one character in two code
            // units, and treating it as a named key would let it through the
            // keysym path where it cannot be represented.
            return Array.from(k).length === 1;
        }

        function onKey(ev) {
            if (ev.target !== overlay) return;
            // Ctrl/Alt/Meta chords are commands, not text, and never arrive as
            // an `input` event — they must keep the keysym path.
            if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
            if (ev.isComposing || ev.keyCode === 229 || isPrintable(ev)) {
                ev.stopPropagation();
            }
        }

        try {
            window.addEventListener('keydown', onKey, true);
            window.addEventListener('keypress', onKey, true);
            // keyup is deliberately NOT suppressed. The bundle tracks modifier
            // state from it, and a swallowed keyup is how a remote desktop
            // ends up with a key stuck down.
            window.addEventListener('compositionstart', function (ev) {
                if (ev.target === overlay) ev.stopPropagation();
            }, true);
            STATE.inputGuarded = true;
        } catch (e) {
            warn('input-guard-failed', String((e && e.message) || e));
        }
    }

    function arm(overlay) {
        // Install the duplicate-input guard even if the button is already
        // there: they are independent repairs and the guard is idempotent.
        guardInput(overlay);
        if (document.getElementById('ezil-kbd-btn')) return;

        var style = document.createElement('style');
        style.id = 'ezil-kbd-style';
        style.textContent = CSS;
        document.head.appendChild(style);

        var btn = document.createElement('button');
        btn.id = 'ezil-kbd-btn';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Show keyboard');
        btn.setAttribute('title', 'Show keyboard');
        btn.setAttribute('data-open', 'false');
        btn.innerHTML = ICON;
        document.body.appendChild(btn);

        // Where the button can safely sit.
        //
        // Bottom-left is the reachable place for a thumb, and it is correct
        // wherever `visualViewport` reports the keyboard inset (Android Chrome,
        // and any top-level document). It is NOT correct on iOS inside a
        // cross-origin iframe: there the keyboard does not shrink the frame's
        // visual viewport, the inset reads 0, and a bottom-anchored button ends
        // up buried under the keys with no way to dismiss them. So when the
        // keyboard is up and we could not measure an inset, we do not guess —
        // we move to the top, which no keyboard can cover.
        function place() {
            var buried = STATE.open && !STATE.keyboardInset;
            if (buried) {
                btn.style.top = '12px';
                btn.style.bottom = 'auto';
            } else {
                btn.style.top = 'auto';
                btn.style.bottom = (STATE.keyboardInset || 0) + 12 + 'px';
            }
        }

        function setOpen(open) {
            STATE.open = open;
            btn.setAttribute('data-open', open ? 'true' : 'false');
            var label = open ? 'Hide keyboard' : 'Show keyboard';
            btn.setAttribute('aria-label', label);
            btn.setAttribute('title', label);
            place();
        }

        // Keep the button from taking focus when it is TAPPED, while leaving it
        // reachable by Tab. Without this, a tap moves focus off the overlay
        // before the click handler runs, so the handler sees "overlay is not
        // focused", re-focuses it, and the button can never dismiss the
        // keyboard — observed exactly that way before this line existed.
        // `mousedown` is the event that performs pointer focus (it fires on
        // touch too, synthesized after touchend), and cancelling it suppresses
        // the focus change without suppressing the click that follows.
        btn.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
        });

        // `click` — not `pointerdown`/`touchend` — because iOS honours a
        // programmatic focus() only from inside a user-gesture handler, `click`
        // is such a handler, and binding one event rather than two removes any
        // chance of the touch's synthesized click firing this twice.
        btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();

            var el = overlayEl() || overlay;
            if (!el) {
                warn('keyboard-arm-failed', 'overlay vanished');
                return;
            }

            if (document.activeElement === el) {
                // Second tap dismisses. Blur is what lowers the OS keyboard.
                try {
                    el.blur();
                } catch (e) {
                    /* ignore */
                }
                setOpen(false);
                return;
            }

            // Recover from control mode 'manual': without this, focus lands but
            // every keystroke is dropped by the client's `hosting` guard. Fired
            // before focus() and never awaited — the round trip completes long
            // before a human types, and blocking here would cost the gesture.
            if (!isHosting(el)) takeControlIfFree();

            try {
                // preventScroll: the overlay is full-bleed; scrolling it into
                // view would jerk the letterboxed picture around for no gain.
                el.focus({ preventScroll: true });
            } catch (e) {
                try {
                    el.focus();
                } catch (e2) {
                    warn('keyboard-focus-failed', String(e2));
                    return;
                }
            }
            setOpen(document.activeElement === el);
        });

        // The OS keyboard can also be dismissed by the platform's own "done"
        // key, which fires blur without any tap on our button. Track the real
        // state rather than assuming ours is authoritative.
        overlay.addEventListener('focus', function () {
            setOpen(true);
        });
        overlay.addEventListener('blur', function () {
            setOpen(false);
        });

        // `visualViewport` is the only API that reports the keyboard inset at
        // all. Where it works, use it and stay just above the keys; where it
        // reports nothing, `place()` falls back to the top edge.
        var vv = window.visualViewport;
        if (vv) {
            var reposition = function () {
                STATE.keyboardInset = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
                place();
            };
            vv.addEventListener('resize', reposition);
            vv.addEventListener('scroll', reposition);
            reposition();
        } else {
            STATE.keyboardInset = 0;
            place();
        }

        STATE.armed = true;
        STATE.reason = 'armed';
    }

    if (document.body) {
        whenOverlay(arm);
    } else {
        document.addEventListener('DOMContentLoaded', function () {
            whenOverlay(arm);
        });
    }
})();
