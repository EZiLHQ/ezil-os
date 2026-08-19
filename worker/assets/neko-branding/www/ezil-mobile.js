/*
 * ezil-mobile.js — the on-screen-keyboard affordance for the streamed desktop.
 *
 * Loaded by /var/www/index.html, so it runs IN the desktop's own origin, in
 * the desktop's own document, with full access to the client app's DOM. The
 * EZiL shell cannot do any of this: the desktop is a cross-origin iframe, so
 * the shell can neither reach this document nor postMessage into a client
 * that does not listen. This file is the only lever there is.
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
    var STATE = { armed: false, reason: null, open: false, tookControl: false, errors: [] };
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
        // Best-effort outward signal. Nothing listens for this yet; a shell-side
        // listener would let it become the `ezil-os:apps/desktop#keyboard`
        // `window_error` telemetry, which cannot be emitted from this origin.
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

    function arm(overlay) {
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
