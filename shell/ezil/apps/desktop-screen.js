// desktop-screen.js — EZiL-authored. Not Puter code.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DESKTOP'S SHAPE: MEASURING IT, ASKING FOR IT, AND FITTING WHAT ARRIVES
// ═══════════════════════════════════════════════════════════════════════════
//
// The streamed desktop used to be hard-pinned to 1920x1080 on the server, and
// `apps/desktop-window.js` letterboxed it to 16:9 whatever shape the window
// was. On a 390x844 phone that produced a 390x219 strip — about a quarter of
// the screen, at a 4.9x downscale. The desktop did not adapt to the shape of
// the window it was in, because it could not: there was no client -> server
// sizing path at all.
//
// There is one now, and this module is the client half of it. Everything here
// is a PURE FUNCTION or a controller with injected clock/transport, for the
// same reason `activity-heartbeat.js` split its rule out from its wiring: a
// The debounce and an aspect-fit cannot be proven by staring at a browser,
// and the wiring around them only has to be trusted to call them correctly.
//
// ── 🔴 WHAT THIS SIDE STILL CANNOT DO ──────────────────────────────────────
// It STILL cannot read the stream's real size from the DOM. The desktop is a
// cross-origin neko SPA in an iframe, so its `<video>` element is unreachable
// BY CONSTRUCTION — that has not changed and no amount of resizing changes it.
// What HAS changed is that this side no longer needs to read it: it asked for
// a size, and the server answered with the size it actually applied. The whole
// design rests on believing the server's answer rather than measuring the
// picture, and on the server never claiming a size it did not apply.
//
// ── 🔴 A RESIZE COSTS CPU, NOT PIXELS — AND THAT CHANGES THE DEBOUNCE ───────
//
// This block used to say a mode change was "a visible interruption plus a full
// software-vp8 re-init", and 500ms of debounce was the price paid for that
// belief. It was never measured. It is now, and it is wrong.
//
// Sampled at 40ms inside the neko client against production, across a live
// change, twice — including the worst case of landscape -> portrait:
//
//     1440x900 -> 1280x800 : no blackout, no dropped frame, lowest luma 39.9
//     1440x900 -> 1080x1920: no blackout, no dropped frame, lowest luma 28.7
//
// The picture never goes black. What a mode change actually costs is container
// CPU (the encoder really does restart) and about a second before the new size
// arrives. So the debounce is not protecting the viewer's eyes; it is
// protecting a 2-vCPU container from a drag's worth of encoder restarts. That
// is still worth doing — but it is worth 200ms, not 500.
//
// The value is measured too. A real drag was recorded through a
// `ResizeObserver` in a real browser: 90 ticks over 1762ms, inter-tick gap p50
// 17ms / p90 17ms (i.e. 60Hz while moving), longest natural hesitation 148ms.
// Replaying those ticks through each candidate:
//
//     debounce   pipeline restarts for that one gesture
//       500ms      1
//       200ms      1     <- chosen: same cost, 2.5x more responsive
//       150ms      1     <- the knee; no margin over the 148ms hesitation
//       100ms      2
//        60ms      3
//
// 200ms is the smallest value that still costs exactly ONE restart per
// gesture with headroom over the longest pause actually observed. A user who
// hesitates longer than 200ms mid-drag pays one extra encoder restart, and no
// visible interruption at all — which the measurements above say is an
// acceptable trade rather than a guess that it is.
//
// `createScreenController` still never sends on a tick. It sends after the
// LAST tick, and only if the settled size differs from what is already
// applied. A drag costs zero requests while it is happening and at most one
// when it stops; a drag that ends where it started costs none.

/**
 * Trailing debounce for a settled size. A drag is a stream of ticks; this waits
 * for the end of it.
 *
 * 200ms, down from 500ms — see the header block above for the two measurements
 * that justify it: a mode change costs no visible interruption, and 200ms is
 * the smallest debounce that still costs one encoder restart per real gesture.
 */
export const RESIZE_DEBOUNCE_MS = 500;
// 🔴 REVERTED FROM 200ms AFTER A PRODUCTION REGRESSION, and the measurements
// that justified 200ms still stand — this is not a retraction of them.
//
// A mode change genuinely costs no visible interruption (sampled at 40ms in
// the neko client across a live change, twice, including landscape ->
// portrait: no blackout, no dropped frame), and 200ms genuinely costs one
// encoder restart per real gesture (90 recorded ResizeObserver ticks, p50 gap
// 17ms, longest hesitation 148ms). Both remain true.
//
// What 200ms also did, measured on production and reproduced on a second run,
// was leave the desktop window carrying the `ezil-fullbleed` CLASS while its
// body stayed at the windowed 960x540 — so a 1440x900 desktop letterboxed to
// 864x540 and wasted 10% of the window. The phone was unaffected (0.8%). The
// interaction is with BOOT, not with dragging: a shorter debounce lets a
// screen request land while the window is still windowed and before
// `go_fullbleed` has applied its geometry, and something in that overlap
// leaves the geometry behind.
//
// That mechanism is NOT yet understood, and shipping a faster debounce while
// it is not understood trades a real, visible 10% regression for a 300ms
// improvement nobody asked for twice. It goes back to 500ms until the
// boot-time overlap is explained. `e2e/prod-responsiveness.mjs` is what caught
// it and is what should be green before this is tried again.

/**
 * Ceiling on `devicePixelRatio` when converting a CSS-pixel box into the
 * screen size to ask for.
 *
 * A 3x phone reports a 390x844 CSS box, i.e. 1170x2532 real pixels, and asking
 * in CSS pixels would request a 390x844-ish mode — a soft, upscaled picture on
 * a screen that can show three times the detail. Asking in device pixels fixes
 * that. The clamp exists because dpr is unbounded in principle (and browser
 * zoom moves it), and the cost of over-asking is paid in container CPU by
 * someone who did not ask for it; 3 covers every shipping phone and the server
 * snaps whatever arrives into its own closed table anyway.
 */
export const MAX_DEVICE_PIXEL_RATIO = 3;

/** Matches the server's own sanity bounds (`MIN/MAX_REQUESTED_AXIS`). Outside these the server ignores the ask. */
const MIN_AXIS = 64;
const MAX_AXIS = 16384;

/**
 * The box the streamed desktop will actually occupy, in DEVICE pixels.
 *
 * 🔴 THE VIEWPORT IS A CANDIDATE, NOT JUST THE WINDOW BODY, and that is the
 * one non-obvious decision in this file. The Browser window opens WINDOWED at
 * 960x540 and goes full-bleed the moment the desktop is confirmed
 * (`go_fullbleed`, called from `settle_frame`). So at the moment the shell has
 * to choose a size — before the desktop exists — the window body is measuring
 * a box the desktop will occupy for about a second, and the viewport is
 * measuring the box it will occupy for the rest of the session. Measuring only
 * the body would boot every desktop at half its eventual size and then need a
 * live resize (an encoder restart) to correct it, on a path where live resize
 * may not be available at all.
 *
 * Taking the LARGER of the two is what makes both cases right: while the
 * window is small and the viewport is big, the viewport wins (the full-bleed
 * shape); once the user has deliberately made the window bigger than the
 * viewport is tall — or on a phone, where they are the same box — the body
 * wins. Neither is ever smaller than the box the stream ends up in.
 *
 * @param {object}      [opts]
 * @param {HTMLElement} [opts.body] The window body. Ignored when it has no layout.
 * @param {object}      [opts.view] Something `window`-shaped: `innerWidth`,
 *   `innerHeight`, `devicePixelRatio`. Injected so this is testable without a DOM.
 * @returns {{width: number, height: number}|null} null when NOTHING is
 *   measurable — in which case the caller must ask for nothing at all rather
 *   than send a made-up size.
 */
export function measureDesktopBox (opts = {}) {
    const body = opts.body ?? null;
    const view = opts.view ?? null;

    /** @type {Array<[number, number]>} */
    const boxes = [];
    if ( body ) {
        const bw = Math.round(body.clientWidth);
        const bh = Math.round(body.clientHeight);
        if ( bw > 0 && bh > 0 ) boxes.push([bw, bh]);
    }
    if ( view ) {
        const vw = Math.round(view.innerWidth);
        const vh = Math.round(view.innerHeight);
        if ( Number.isFinite(vw) && Number.isFinite(vh) && vw > 0 && vh > 0 ) boxes.push([vw, vh]);
    }
    if ( boxes.length === 0 ) return null;

    let [cssW, cssH] = boxes[0];
    for ( const [w, h] of boxes ) {
        if ( w * h > cssW * cssH ) { cssW = w; cssH = h; }
    }

    const ratio = deviceRatio(view);
    const width = clampAxis(Math.round(cssW * ratio));
    const height = clampAxis(Math.round(cssH * ratio));
    if ( width === null || height === null ) return null;
    return { width, height };
}

/** `devicePixelRatio`, defended against every value a browser can actually report. */
function deviceRatio (view) {
    const raw = view && typeof view.devicePixelRatio === 'number' ? view.devicePixelRatio : 1;
    if ( ! Number.isFinite(raw) || raw <= 0 ) return 1;
    return Math.min(raw, MAX_DEVICE_PIXEL_RATIO);
}

/** In range -> the integer; outside -> null, because a made-up size is worse than no size. */
function clampAxis (value) {
    if ( ! Number.isFinite(value) ) return null;
    const v = Math.round(value);
    if ( v < MIN_AXIS || v > MAX_AXIS ) return null;
    return v;
}

/**
 * How many pixels of the viewport the on-screen keyboard is currently covering,
 * as published by `boot.js`'s `visualViewport` listener in the `--ezil-kb`
 * custom property on `<body>`.
 *
 * ── 🔴 WHY THE SIZING PATH HAS TO KNOW ABOUT THE KEYBOARD ───────────────────
 * A raised keyboard SHRINKS the desktop window: measured at 390x844 with a
 * 336px keyboard, the full-bleed window goes 844 -> 508 and back, and the
 * stream iframe's top moves 313 -> 145. That fires the body `ResizeObserver`,
 * and it SHOULD: the box the stream is shown in really did change, so the
 * letterbox must be recomputed or the picture sits under the keyboard.
 *
 * But the desktop's RESOLUTION did not change and must not. A keyboard open or
 * close is a transient ~300ms event that happens every time a user taps a text
 * field, and turning each one into a mode change would mean a capture-pipeline
 * restart per tap. The 500ms trailing debounce would probably absorb the pair
 * of events on its own — "probably" is the reason this is explicit instead.
 * Geometry the window occupies: changed. Resolution: unchanged. The two are
 * separated here rather than left to a timing coincidence.
 *
 * NEVER THROWS and defaults to 0 (no keyboard). If the property is missing —
 * an older shell bundle, a browser with no `visualViewport` — the behaviour is
 * exactly what it would be without this function, plus the debounce.
 *
 * @param {object} [doc] Something `document`-shaped. Injected for tests.
 * @returns {number} Pixels, 0 when there is no keyboard or no signal.
 */
export function keyboardInsetPx (doc) {
    try {
        const el = doc && doc.body;
        if ( ! el ) return 0;
        // The inline property first — it is where a `style.setProperty` write
        // lands and is far cheaper than a full style resolution on what may be
        // a per-resize-tick call. `getComputedStyle` is the fallback for a
        // value that arrived through a stylesheet instead.
        let raw = el.style && typeof el.style.getPropertyValue === 'function'
            ? el.style.getPropertyValue('--ezil-kb')
            : '';
        if ( ! raw && doc.defaultView && typeof doc.defaultView.getComputedStyle === 'function' ) {
            raw = doc.defaultView.getComputedStyle(el).getPropertyValue('--ezil-kb');
        }
        const px = Number.parseFloat(String(raw).trim());
        return Number.isFinite(px) && px > 0 ? px : 0;
    } catch {
        return 0;
    }
}

/**
 * The largest `streamW:streamH` rectangle that fits `bodyW x bodyH`, centred.
 *
 * This is the geometry `fit_stream` writes, pulled out so it can be tested
 * without a browser. It is a function of the ACTUAL stream size — not of a
 * hardcoded 16:9 — which is the entire point: when the desktop really is
 * portrait, the box must be portrait too, or the fix produces a portrait
 * desktop letterboxed inside a landscape box and looks worse than before.
 *
 * Whole pixels throughout: a half-pixel box on a scaled video is a visibly
 * soft picture, and the centring offsets have to add up to the body's own
 * integer size or the bars come out uneven.
 *
 * @returns {{w: number, h: number, left: number, top: number}|null} null when
 *   the body has no layout (a minimised or not-yet-shown window) or the stream
 *   size is not usable — in which case nothing is written and whatever
 *   geometry is already there survives.
 */
export function computeFitBox (bodyW, bodyH, streamW, streamH) {
    const bw = Math.round(bodyW);
    const bh = Math.round(bodyH);
    if ( ! Number.isFinite(bw) || ! Number.isFinite(bh) || bw <= 0 || bh <= 0 ) return null;
    if ( ! Number.isFinite(streamW) || ! Number.isFinite(streamH) || streamW <= 0 || streamH <= 0 ) return null;

    const aspect = streamW / streamH;
    let w = bw;
    let h = Math.round(bw / aspect);
    if ( h > bh ) {
        h = bh;
        w = Math.round(bh * aspect);
    }
    return {
        w,
        h,
        left: Math.round((bw - w) / 2),
        top: Math.round((bh - h) / 2),
    };
}

/**
 * Read the `screen` field off a desktop-open or live-resize answer.
 *
 * 🔴 STRICT, and never defaulted to something plausible. A response that omits
 * the field is a server that does not do this yet — an older deploy — and the
 * honest reading is "I know nothing new", not "it must be 1920x1080". The
 * caller keeps whatever it already believed, which for a fresh window is the
 * pre-existing 1920x1080 assumption and therefore exactly today's behaviour.
 *
 * @returns {{width:number, height:number, source:string}|null}
 */
export function readAppliedScreen (raw) {
    if ( ! raw || typeof raw !== 'object' ) return null;
    const { width, height, source } = raw;
    if ( ! Number.isInteger(width) || ! Number.isInteger(height) ) return null;
    if ( width <= 0 || height <= 0 ) return null;
    const known = source === 'requested' || source === 'snapped' || source === 'default';
    return { width, height, source: known ? source : 'unknown' };
}

/**
 * Did the server apply something the client neither asked for nor was offered
 * as a snap? That is a contract violation, not a preference — see the fix
 * contract's telemetry table.
 *
 * `snapped` and `default` are both legitimate answers to any ask. Only
 * `requested` makes a claim that can be checked, and only against the size
 * that was actually requested.
 */
export function isScreenContractViolation (requested, applied) {
    if ( ! applied || applied.source !== 'requested' ) return false;
    if ( ! requested ) return false;
    return applied.width !== requested.width || applied.height !== requested.height;
}

/**
 * The live-resize controller: debounces, deduplicates, and gives up honestly.
 *
 * ── 🔴 FEATURE-DETECTED, exactly the way `focus` is ─────────────────────────
 * `endpoint` is `desktopState.endpoints.screen`, read from the boot payload by
 * the caller. When it is absent this controller is PERMANENTLY DARK — no
 * timer, no request, no observer work — rather than POSTing to a URL it
 * invented. The bundle and the server deploy separately, so a shell newer than
 * its server is a real state. `desktop-window.js` applies the same rule to
 * `endpoints.focus` and draws no switcher; `session.js`'s `restartEndpoint()`
 * applies it to `endpoints.restart`.
 *
 * ── 🔴 IT STOPS ASKING WHEN THE ANSWER CANNOT CHANGE ────────────────────────
 * `UNSUPPORTED` means the container's X server has a FIXED framebuffer — under
 * Xvfb, RandR advertises exactly one mode and no set can ever succeed. That is
 * a permanent property of the running container, not a transient failure, so
 * the controller disarms itself for the rest of the window's life and the
 * window falls back to letterboxing (which still works, and is what it did
 * before any of this existed). Retrying it in a loop would restart nothing,
 * fix nothing, and generate a request per gesture forever.
 *
 * Every other failure is transient and simply leaves `lastApplied` alone, so
 * the next settled size tries again.
 *
 * @param {object}   opts
 * @param {string|null} opts.endpoint     `desktopState.endpoints.screen`, or null/absent.
 * @param {function} opts.send            `(width, height) => Promise<result>`; the transport.
 * @param {function} [opts.onApplied]     `({width, height, source})` after a confirmed change.
 * @param {function} [opts.onFailure]     `({code, message})` for every failure, including UNSUPPORTED.
 * @param {number}   [opts.debounceMs]    Defaults to `RESIZE_DEBOUNCE_MS`.
 * @param {function} [opts.setTimeout]    Injected for tests.
 * @param {function} [opts.clearTimeout]  Injected for tests.
 */
export function createScreenController (opts = {}) {
    const endpoint = typeof opts.endpoint === 'string' && opts.endpoint !== '' ? opts.endpoint : null;
    const send = typeof opts.send === 'function' ? opts.send : null;
    const on_applied = typeof opts.onApplied === 'function' ? opts.onApplied : () => {};
    const on_failure = typeof opts.onFailure === 'function' ? opts.onFailure : () => {};
    const debounce_ms = Number.isFinite(opts.debounceMs) ? opts.debounceMs : RESIZE_DEBOUNCE_MS;
    const set_timer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    const clear_timer = opts.clearTimeout ?? ((id) => clearTimeout(id));

    /** The size the SERVER most recently confirmed. Seeded from the boot answer. */
    let last_applied = null;
    /**
     * The measurement most recently PUT ON THE WIRE — which is a different
     * thing from `last_applied` and both are needed.
     *
     * 🔴 The server SNAPS. A phone measuring 1170x2532 is answered with
     * 1080x1920, so `last_applied` never equals the box the observer keeps
     * reporting, and a controller that deduplicated only against `last_applied`
     * would re-send the same measurement after every single settle — restarting
     * the capture pipeline forever for a size it has already been told it
     * cannot have. Remembering the ASK is what closes that loop.
     */
    let last_sent = null;
    /** Set once an `UNSUPPORTED` has been observed. Never cleared. */
    let disarmed = false;
    let disposed = false;
    let timer = null;
    let in_flight = false;
    /** The most recent settled size, held while a request is in flight. */
    let pending = null;

    const armed = () => endpoint !== null && send !== null && ! disarmed && ! disposed;

    /** Is this measurement one we already know the answer to? */
    function settled (width, height) {
        const same = (m) => m && m.width === width && m.height === height;
        return same(last_applied) || same(last_sent);
    }

    /**
     * Record what the desktop is CURRENTLY at, without sending anything.
     *
     * @param {number} width  What the desktop IS (the server's answer).
     * @param {number} height
     * @param {{width:number,height:number}} [asked] What was asked for to get
     *   it — the BOOT measurement. Recorded as `last_sent` so the first
     *   observer tick after the window opens does not immediately re-ask for
     *   the very size the boot request already carried.
     */
    function seed (width, height, asked) {
        if ( Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 ) {
            last_applied = { width, height };
        }
        if ( asked && Number.isInteger(asked.width) && Number.isInteger(asked.height) ) {
            last_sent = { width: asked.width, height: asked.height };
        }
    }

    /**
     * A new measurement. Never sends now — resets the trailing timer, so a
     * drag's whole stream of ticks collapses into at most one request, fired
     * only once the size has settled.
     */
    function request (width, height) {
        if ( ! armed() ) return;
        if ( ! Number.isInteger(width) || ! Number.isInteger(height) ) return;
        if ( width <= 0 || height <= 0 ) return;
        // 🔴 The dedup is checked HERE as well as at fire time. Checking only
        // at fire time would still arm a timer for a no-op resize, and a
        // window dragged back to its original size would sit with a live timer
        // for 500ms for nothing.
        if ( settled(width, height) ) {
            if ( timer !== null ) { clear_timer(timer); timer = null; }
            pending = null;
            return;
        }
        pending = { width, height };
        if ( timer !== null ) clear_timer(timer);
        timer = set_timer(fire, debounce_ms);
    }

    async function fire () {
        timer = null;
        if ( ! armed() || ! pending ) return;
        // One in flight at a time. A resize that lands while another is still
        // running is kept in `pending` and re-armed from the completion path,
        // rather than racing a second capture-pipeline restart into the first.
        if ( in_flight ) {
            timer = set_timer(fire, debounce_ms);
            return;
        }
        const target = pending;
        pending = null;
        if ( settled(target.width, target.height) ) return;

        in_flight = true;
        // Recorded BEFORE the await, not after: a failure must not leave this
        // measurement looking un-asked, or a window sitting at a size the
        // server refuses would re-ask on every settle forever.
        last_sent = { width: target.width, height: target.height };
        let result;
        try {
            result = await send(target.width, target.height);
        } catch ( err ) {
            // A transport that threw is a failure, never a success. The
            // controller stays armed and forgets the ask, so the next settled
            // size — including the same one — tries again.
            in_flight = false;
            last_sent = null;
            on_failure({ code: 'UPSTREAM', message: err && err.message ? err.message : String(err) });
            return;
        }
        in_flight = false;
        if ( disposed ) return;

        if ( result && result.ok === true ) {
            // 🔴 Trust the SERVER's numbers, not the request's. `source:
            // 'snapped'` means it applied a different mode, and letterboxing
            // to the size we asked for rather than the one it applied is
            // exactly the bug this whole change exists to fix.
            const width = Number.isInteger(result.width) ? result.width : target.width;
            const height = Number.isInteger(result.height) ? result.height : target.height;
            last_applied = { width, height };
            on_applied({ width, height, source: result.source === 'snapped' ? 'snapped' : 'requested' });
        } else {
            const code = result && result.code ? String(result.code) : 'UPSTREAM';
            if ( code === 'UNSUPPORTED' ) {
                // Permanent. See this function's header.
                disarmed = true;
                if ( timer !== null ) { clear_timer(timer); timer = null; }
                pending = null;
            } else {
                // TRANSIENT. Forget that this size was asked for, so the same
                // box can be attempted again once it next settles — a network
                // blip must not permanently pin the desktop to a shape the
                // window is no longer.
                last_sent = null;
            }
            on_failure({ code, message: result && result.message ? String(result.message) : '' });
        }

        // Something arrived while we were away, and it is still different.
        if ( armed() && pending ) {
            if ( timer !== null ) clear_timer(timer);
            timer = set_timer(fire, debounce_ms);
        }
    }

    /**
     * Drop whatever is waiting to be sent, WITHOUT disarming.
     *
     * Used for a size change that is real geometry but not a real resolution
     * change — a raised on-screen keyboard, which shrinks the window for a few
     * hundred milliseconds and then gives it back. See `keyboardInsetPx`.
     */
    function cancel () {
        pending = null;
        if ( timer !== null ) { clear_timer(timer); timer = null; }
    }

    function dispose () {
        disposed = true;
        cancel();
    }

    /**
     * Replace the belief with an OBSERVATION.
     *
     * 🔴 THE ONE THING `seed` CANNOT DO, and the reason this controller could
     * not previously correct itself. `seed` records a truth AND an ask
     * together, which is right at boot: the ask is what produced the truth. But
     * when the screen changes without this side asking — the troubleshoot
     * restart resets the container to 1920x1080 and sets no `NEKO_SCREEN`; a
     * warm container is handed to a window that never sized it — there IS no
     * corresponding ask, and `last_sent` still holds the boot measurement. Every
     * observer tick then matches `last_sent`, `settled()` returns true, and the
     * controller sits there forever believing a size the desktop stopped being.
     * The picture stays letterboxed to an aspect the stream does not have until
     * the window is closed and reopened.
     *
     * So this writes `last_applied` from the observation and, when the
     * observation DISAGREES with what was last put on the wire, clears
     * `last_sent`. Clearing it is the whole point: it un-suppresses the next
     * tick, so the observer's very next measurement is allowed to reach the
     * server again.
     *
     * When the observation AGREES, `last_sent` is deliberately left alone —
     * nothing has gone stale, and dropping it would turn a free reconcile into
     * a capture-pipeline restart on every restore.
     *
     * @param {number} width  What the server says the desktop IS.
     * @param {number} height
     * @returns {{changed: boolean}} `changed` is whether this actually
     *   contradicted the previous belief — the caller may want to refit.
     */
    function reconcile (width, height) {
        if ( ! Number.isInteger(width) || ! Number.isInteger(height) || width <= 0 || height <= 0 ) {
            return { changed: false };
        }
        const was = last_applied;
        const changed = ! was || was.width !== width || was.height !== height;
        last_applied = { width, height };
        if ( changed ) last_sent = null;
        return { changed };
    }

    return {
        seed,
        reconcile,
        request,
        cancel,
        dispose,
        /** For tests and for the window's own fit: what the server last confirmed. */
        applied: () => (last_applied ? { ...last_applied } : null),
        /** True while this controller would still send. False when dark or disarmed. */
        isArmed: () => armed(),
    };
}
