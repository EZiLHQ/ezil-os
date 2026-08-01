// preview.js — EZiL-authored. Not Puter code.
//
// The Preview window: the user's own app, over plain HTTP, in an iframe.
// Companion to `desktop-window.js` (the full streamed Linux desktop) — same
// sandbox, a different transport. docs/PLATFORM-NOTES.md §6: there is no UDP
// path to a Cloudflare Container, so the WebRTC desktop is relayed through
// TURN no matter what, while anything renderable as a web page reaches this
// window as a plain reverse-proxied HTTP response. **That makes this window
// the lower-latency way to look at the user's own app whenever the app is a
// web page** — it is easy to under-rate because it is "just an iframe".
//
// ── 🔴 `appPreviewUrl` DOES NOT EXIST IN THIS FILE'S OWNING TASK YET ────────
// This shell task (T4) owns `preview.js` and `desktop-window.js` ONLY.
// `session.js` — the shell's entire server surface — belongs to a PARALLEL
// task (T1), which is the one adding the field this file consumes:
// `session.openDesktop(computerId)` gaining an `appPreviewUrl` (string, a
// short-TTL-tokened URL to the app-preview reverse-proxy host) alongside the
// `url`/`frameConfirmed`/`controlMode` it already returns. AS OF THIS FILE:
// `openDesktop()`'s return object has no such field (verified by reading
// `session.js` — it returns a fixed, curated object and does not pass one
// through), so `res.appPreviewUrl` reads as `undefined` today. That is
// EXPECTED and is exactly the case `render_unavailable()` below exists for —
// this window must never invent a URL to fill that gap. Once T1 lands the
// field for real, no change is needed here: the `typeof === 'string'` guard
// starts passing and the window works.
//
// Likewise `POST /sandbox/:id/focus` (app switching, see `requestFocus`
// below) is a Worker-side route this task does not own either. There is no
// session.js helper for it today, so this file feature-detects a same-origin
// transport for it via `session.payload()?.desktopState?.endpoints?.focus` —
// the SAME "payload carries its own endpoint map" convention `session.js`
// already uses for `session`/`desktop` (see its `endpoint()` helper). If that
// key is absent the switcher is not drawn at all: a button wired to a URL
// this file invented would silently 404, which is worse than no button.
//
// ── 🔴 Mint the token per window-open — NEVER reuse an earlier one ─────────
// The brief for this feature is explicit and matches this codebase's own
// established pattern (`cloudflare-guacamole-canvas.tsx` refetches the full
// desktop's `previewUrl` every 50 minutes because ITS embedded credential
// goes stale): the app-preview URL carries a bootstrap token good for ~5
// minutes. A page can sit open for a long time between load and the user
// actually clicking the Preview icon, so a URL captured at boot-payload time
// — or cached from a PRIOR window-open — is routinely already dead by the
// time a window would use it. The fix is structural, not a TTL check: this
// file NEVER stores an `appPreviewUrl` in module state and NEVER reads one
// from `session.payload()`. The ONLY place a URL is read from is the
// resolved value of a `session.openDesktop()` call made INSIDE `start_boot()`
// AT WINDOW-OPEN TIME. Re-opening a closed instance re-runs `start_boot()`
// (see `registry.launch`'s single-instance restore, which does NOT re-run
// this file — this file's own single_instance is left to `UIWindow`/registry
// exactly like `desktop-window.js`), so every genuine open mints fresh.
//
// ── 🔴 Frame honesty, inherited — not reinvented ────────────────────────────
// `desktop-window.js` was fixed after an iframe reported `ready` over an HTTP
// 500 "Proxy routing error" — `load` fires identically for an error page and
// a real one, and cross-origin script can read neither the status nor the
// document. The fix there is "ask the server, never trust `load`"
// (`session.confirmFrame`, gated through `computeBootUiState`'s
// `frameConfirmed` branch). This file reuses BOTH exactly, unmodified,
// against the app-preview URL instead of the desktop URL — not a parallel
// re-implementation. See `settle_frame` below, which is `desktop-window.js`'s
// `settle_frame` with the desktop-specific full-bleed handoff removed and
// nothing about the honesty gate touched. This is the one place this file
// depends on a T1 change it cannot see from here: `confirmFrame`'s
// `isOwnDesktopOrigin` pin currently scopes to the DESKTOP origin, and must
// be widened (by whoever lands `appPreviewUrl`) to also accept the
// app-preview origin, or a real, healthy preview will be refused as
// unconfirmed forever. Flagged in this task's report for the integrator to
// check once both sides exist in the same tree.
//
// ── App switching ────────────────────────────────────────────────────────
// `POST /sandbox/:id/focus { app: 'vscode' | 'chromium' }` changes which app
// is behind the SAME exposed preview port. Measured cost has two parts that
// must be shown as two different things: the round trip itself (~150-400ms —
// fast, and a real completion signal) and the encoder catching up so the
// switched-to app is actually legible (~1.7s, because at 15fps with
// `keyframe-max-dist=25` the encoder is the bottleneck, not the network —
// PLATFORM-NOTES §7). `switchApp` below never claims the second number is a
// guarantee: it labels it "should be visible" and reloads the iframe once the
// estimate has elapsed, rather than showing a spinner that resolves the
// instant the fast round trip lands while the frame the user sees is still
// the old app.

import session, { DESKTOP_BOOT_TIMEOUT_MS } from '../session.js';
import { computeBootUiState } from '../boot-phases.js';
import BootProgress from '../ui/boot-progress.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:preview';

/** How often the UI re-derives its phase from elapsed time. */
const TICK_MS = 250;
/** How often the cheap status probe runs. It does NOT wake a container. */
const POLL_MS = 2_000;

/**
 * The post-handoff frame confirmation. Kept byte-for-byte in step with
 * `desktop-window.js`'s own constants of the same name — this is the same
 * contract applied to a different URL, not a separate policy. See that file's
 * header for what each one is for.
 */
const FRAME_CONFIRM_FALLBACK_MS = 4_000;
const FRAME_CONFIRM_ATTEMPTS = 3;
const FRAME_CONFIRM_RETRY_MS = 1_500;

/** Generous vs. the measured 150-400ms round trip — this bounds OUR request, not the encoder. */
const FOCUS_TIMEOUT_MS = 8_000;
/**
 * The measured floor before a switched-to app is legible (PLATFORM-NOTES §7:
 * 15fps + `keyframe-max-dist=25`, encoder-bound on a fractional vCPU). A
 * MINIMUM display time for the "switching" state, not a promise — see
 * `switchApp`.
 */
const FOCUS_LEGIBLE_ESTIMATE_MS = 1_700;

/** What the switcher offers, in display order. Matches the Worker's `focus` contract. */
const FOCUS_APPS = [
    { id: 'vscode', label: 'VS Code' },
    { id: 'chromium', label: 'Chromium' },
];

/**
 * `POST` the focus request through a same-origin transport, IF the boot
 * payload says one exists.
 *
 * 🔴 Feature-detected, not guessed. `session.js` (owned by a parallel task)
 * has no helper for this today, and this file does not add one there — it is
 * not this task's file to change. Instead this mirrors the SAME "the payload
 * carries its own endpoint map" convention `session.js`'s own `endpoint()`
 * helper uses for `session`/`desktop`: if a deployment has not wired
 * `desktopState.endpoints.focus`, the switcher must not exist rather than
 * point at a URL this file invented.
 *
 * @returns {Promise<boolean|undefined>} `true`/`false` is a real answer from
 *   the server; `undefined` means OUR request never landed (offline, a
 *   transport failure) and must not be read as either verdict.
 */
async function requestFocus (endpointUrl, computerId, app) {
    let res;
    try {
        res = await fetch(endpointUrl, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ computerId, app }),
            signal: AbortSignal.timeout ? AbortSignal.timeout(FOCUS_TIMEOUT_MS) : undefined,
        });
    } catch {
        return undefined;
    }
    if ( ! res.ok ) return false;
    let data = null;
    try {
        data = await res.json();
    } catch {
        return false;
    }
    return data?.ok === true;
}

/**
 * Open the Preview window.
 *
 * @param {object} ctx
 * @param {object} ctx.payload      `window.__EZIL_BOOT__`
 * @param {object} ctx.computer     `payload.computer`
 * @param {object} ctx.desktopState `payload.desktopState`
 * @param {string} [ctx.icon]       The launching descriptor's icon.
 * @returns {Promise<HTMLElement|null>}
 */
export async function openPreviewWindow (ctx = {}) {
    const computer = ctx.computer ?? ctx.payload?.computer ?? null;
    const desktop_state = ctx.desktopState ?? ctx.payload?.desktopState ?? {};
    const title = computer?.name ? `${computer.name} — Preview` : 'Preview';

    if ( ! computer?.id ) {
        console.error(`[${PHASE}] refusing to open: the boot payload carries no computer`);
        return null;
    }

    const el_window = await UIWindow({
        title,
        app: 'preview',
        icon: ctx.icon,
        // 🔴 Same reasoning as `desktop-window.js`: navigated exactly once,
        // after a freshly minted URL is confirmed. See the header.
        iframe_url: 'about:blank',
        is_fullpage: false,
        width: 720,
        height: 480,
        is_resizable: true,
        // Unlike the desktop window this is a secondary utility surface, not
        // the thing that eats the viewport — a normal maximize is fine here.
        show_maximize_button: true,
        stay_on_top: false,
        single_instance: true,
        show_in_taskbar: true,
        is_droppable: false,
        window_class: 'ezil-preview-window',
        selectable_body: false,
    });

    if ( ! el_window ) {
        console.error(`[${PHASE}] UIWindow returned nothing`);
        return null;
    }

    const el_body = el_window.querySelector('.window-body');
    const el_iframe = el_window.querySelector('.window-app-iframe');
    // A positioning context for the switcher toolbar below, without touching
    // any stylesheet this task does not own. Safe on an element that already
    // fills its window: it only affects where ABSOLUTELY positioned children
    // anchor, not this element's own layout.
    if ( getComputedStyle(el_body).position === 'static' ) el_body.style.position = 'relative';

    let tick_timer = null;
    let poll_timer = null;
    let attempt = 0;
    let running_signal;
    let disposed = false;

    const stop_timers = () => {
        clearInterval(tick_timer); tick_timer = null;
        clearInterval(poll_timer); poll_timer = null;
    };

    const progress = BootProgress({ onRetry: () => { void start_boot(); } });
    el_body.appendChild(progress.el);

    // ── the "no field yet" panel — a DIFFERENT message from any BootProgress
    // state, because "the deployment does not support this" is not the same
    // honest claim as "not configured" or "failed to confirm", and blurring
    // them would tell the user something that is not true. No Retry: the
    // next attempt would fail identically until the deployment changes, and
    // offering one anyway would be exactly the "spinner that lies" this
    // whole feature is warned against building.
    const el_unavailable = document.createElement('div');
    el_unavailable.className = 'ezil-preview-unavailable';
    el_unavailable.hidden = true;
    Object.assign(el_unavailable.style, {
        position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '24px',
        textAlign: 'center', background: '#fff', color: '#333',
    });
    el_unavailable.innerHTML = `
        <div style="font-size:15px;font-weight:600;">Preview isn't available yet</div>
        <div style="font-size:13px;max-width:32em;opacity:0.75;">
            This computer's app preview hasn't been turned on for this deployment.
            The full desktop still works from its own window.
        </div>`;
    el_body.appendChild(el_unavailable);

    const show_panel = () => { progress.el.hidden = false; el_unavailable.hidden = true; };
    const show_unavailable = () => { progress.el.hidden = true; el_unavailable.hidden = false; };

    // ── the app switcher — only drawn if the boot payload says a same-origin
    // transport for `focus` exists. See `requestFocus`'s header.
    const focus_endpoint = session.payload()?.desktopState?.endpoints?.focus;
    let el_switcher = null;
    let el_switch_status = null;
    let switch_in_flight = false;
    if ( focus_endpoint ) {
        el_switcher = document.createElement('div');
        el_switcher.className = 'ezil-preview-switcher';
        Object.assign(el_switcher.style, {
            position: 'absolute', top: '8px', right: '8px', zIndex: '5',
            display: 'flex', alignItems: 'center', gap: '6px',
            background: 'rgba(20,20,20,0.72)', borderRadius: '8px', padding: '4px 6px',
            font: '12px/1.3 -apple-system,BlinkMacSystemFont,sans-serif', color: '#fff',
        });
        el_switcher.hidden = true;
        for ( const app of FOCUS_APPS ) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = app.label;
            btn.setAttribute('data-focus-app', app.id);
            Object.assign(btn.style, {
                background: 'rgba(255,255,255,0.12)', color: '#fff', border: 'none',
                borderRadius: '5px', padding: '3px 8px', cursor: 'pointer', font: 'inherit',
            });
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                void switchApp(app.id, app.label);
            });
            el_switcher.appendChild(btn);
        }
        el_switch_status = document.createElement('span');
        el_switch_status.style.opacity = '0.85';
        el_switch_status.style.marginLeft = '4px';
        el_switcher.appendChild(el_switch_status);
        el_body.appendChild(el_switcher);
    }

    /**
     * Request a focus switch and show HONEST, two-phase progress: the fast
     * round trip is a real completion signal, the legibility floor is an
     * estimate and is labelled as one. Never marks "done" before either the
     * server answered or the estimate elapsed, and never claims MORE than
     * that ("should be visible", not "is visible" — nothing here can prove
     * the pixel actually changed).
     */
    async function switchApp (app, label) {
        if ( switch_in_flight || disposed || ! el_switcher ) return;
        switch_in_flight = true;
        for ( const btn of el_switcher.querySelectorAll('button') ) btn.disabled = true;
        el_switch_status.textContent = `Switching to ${label}…`;

        const t0 = performance.now();
        const ok = await requestFocus(focus_endpoint, computer.id, app);
        if ( disposed ) return;

        if ( ok !== true ) {
            el_switch_status.textContent = ok === undefined
                ? "Couldn't reach the switch — try again"
                : "Switch was refused — try again";
            for ( const btn of el_switcher.querySelectorAll('button') ) btn.disabled = false;
            switch_in_flight = false;
            return;
        }

        // The round trip is done; the encoder is not. Wait out the REST of
        // the measured floor — never less, and never re-timed from zero —
        // then reload so a non-live-updating view actually shows the switch.
        const remaining = Math.max(0, FOCUS_LEGIBLE_ESTIMATE_MS - (performance.now() - t0));
        el_switch_status.textContent = 'Switch requested — rendering can take a couple of seconds…';
        await new Promise((r) => setTimeout(r, remaining));
        if ( disposed ) return;

        try {
            const u = new URL(el_iframe.src);
            u.searchParams.set('_ezilSwitch', String(Date.now()));
            el_iframe.src = u.toString();
        } catch {
            // Non-fatal: the frame may already reflect the switch if the app
            // behind it re-renders live. Say the honest, hedged thing either way.
        }
        el_switch_status.textContent = `Should be showing ${label} now`;
        setTimeout(() => { if ( ! disposed ) el_switch_status.textContent = ''; }, 2_500);
        for ( const btn of el_switcher.querySelectorAll('button') ) btn.disabled = false;
        switch_in_flight = false;
    }

    async function start_boot () {
        if ( disposed ) return;
        const my_attempt = ++attempt;
        stop_timers();
        show_panel();
        running_signal = undefined;
        if ( el_switcher ) el_switcher.hidden = true;

        if ( desktop_state.configured !== true ) {
            console.warn(`[${PHASE}] no desktop provider is configured`);
            progress.render(computeBootUiState({ requestStatus: 'not_configured', elapsedMs: 0 }));
            return;
        }

        const t0 = performance.now();
        const paint = () => {
            if ( disposed || my_attempt !== attempt ) return;
            progress.render(computeBootUiState({
                requestStatus: 'pending',
                elapsedMs: performance.now() - t0,
                confirmedGuacamoleRunning: running_signal,
            }));
        };
        paint();
        tick_timer = setInterval(paint, TICK_MS);

        poll_timer = setInterval(async () => {
            if ( disposed || my_attempt !== attempt ) return;
            const running = await session.desktopRunning(computer.id);
            if ( disposed || my_attempt !== attempt ) return;
            if ( running === true ) {
                running_signal = true;
                clearInterval(poll_timer); poll_timer = null;
                paint();
            }
        }, POLL_MS);

        // 🔴 THE MINT. This call happens exactly once per genuine window-open,
        // right here, right now — never sourced from the boot payload or from
        // a previous open. See the file header.
        console.info(`[${PHASE}] requesting a preview for computer ${computer.id} (budget ${DESKTOP_BOOT_TIMEOUT_MS}ms)`);
        const res = await session.openDesktop(computer.id);

        if ( disposed || my_attempt !== attempt ) return;
        stop_timers();

        if ( ! res.ok ) {
            console.error(`[${PHASE}] preview mint failed after ${Math.round(performance.now() - t0)}ms: ${res.errorCode}`);
            progress.render(computeBootUiState({
                requestStatus: 'error',
                elapsedMs: performance.now() - t0,
                errorCode: res.errorCode,
            }));
            return;
        }

        // 🔴 DEGRADE HONESTLY. `appPreviewUrl` is a field a PARALLEL task is
        // adding to this same response; as of this file it does not exist,
        // and this file must never fabricate a URL to fill the gap. See the
        // header's "does not exist in this file's owning task yet" note.
        const preview_url = res.appPreviewUrl;
        if ( typeof preview_url !== 'string' || preview_url === '' ) {
            console.warn(`[${PHASE}] the desktop opened, but no appPreviewUrl was returned; app preview is not available`);
            show_unavailable();
            return;
        }

        console.info(`[${PHASE}] mint resolved in ${Math.round(performance.now() - t0)}ms`);
        // Same rule as `desktop-window.js`: only the SERVER's confirmation
        // may reveal the frame; render() below still gates on `frameConfirmed`.
        progress.render(computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            frameConfirmed: false,
        }));

        el_iframe.src = preview_url;
        settle_frame(my_attempt);
    }

    /**
     * The post-handoff frame confirmation. This IS `desktop-window.js`'s
     * `settle_frame`, targeted at the app-preview URL instead of the desktop
     * URL, with the full-bleed handoff removed (this window is never
     * full-bleed) — see the file header for why the honesty gate itself is
     * unchanged rather than reimplemented.
     */
    function settle_frame (my_attempt) {
        let settled = false;
        let asks = 0;

        const ask = async () => {
            if ( settled || disposed || my_attempt !== attempt ) return;
            asks++;
            const seen = await session.confirmFrame(computer.id, el_iframe.src);
            if ( settled || disposed || my_attempt !== attempt ) return;

            if ( seen === undefined ) {
                if ( asks < FRAME_CONFIRM_ATTEMPTS ) {
                    setTimeout(() => { void ask(); }, FRAME_CONFIRM_RETRY_MS);
                    return;
                }
                console.warn(`[${PHASE}] gave up confirming the preview frame after ${asks} tries`);
            }

            settled = true;

            if ( seen === true ) {
                progress.el.hidden = true;
                el_unavailable.hidden = true;
                if ( el_switcher ) el_switcher.hidden = false;
                console.info(`[${PHASE}] preview frame confirmed by the server`);
                return;
            }

            console.error(`[${PHASE}] the preview frame is not answering (confirmFrame -> ${String(seen)})`);
            show_panel();
            progress.render(computeBootUiState({
                requestStatus: 'success',
                elapsedMs: 0,
                frameConfirmed: false,
            }));
        };

        el_iframe.addEventListener('load', () => { void ask(); }, { once: true });
        setTimeout(() => { void ask(); }, FRAME_CONFIRM_FALLBACK_MS);
    }

    const dispose = () => {
        disposed = true;
        stop_timers();
        window.removeEventListener('ezil:teardown', dispose);
    };

    el_window.on_before_exit = async () => {
        dispose();
        return true;
    };
    window.addEventListener('ezil:teardown', dispose);

    void start_boot();
    return el_window;
}

export default openPreviewWindow;
