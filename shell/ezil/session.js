// session.js — EZiL-authored. The shell's ENTIRE server surface.
//
// 🔴 LOCAL CODE ONLY. Upstream Puter's GUI talks to a cloud backend for
// identity (`puter.auth`), files (`puter.fs`, 71 calls), preferences
// (`puter.kv`, ~40 calls), app metadata (`puter.apps`) and realtime
// (socket.io). None of that came across. This module is what replaced all of
// it, and it is deliberately small enough to read in one sitting:
//
//   - preferences  -> localStorage, right here (`get`/`set`/`del`).
//   - identity     -> `window.__EZIL_BOOT__`, inlined into the /os document by
//                     `app/src/app/os/page.tsx`. The shell NEVER asks who the
//                     user is; the answer is already in its first paint.
//   - the desktop  -> two plain-JSON Route Handlers under `/api/shell/*`.
//
// No `@trpc/client`, no `superjson`, no socket. Those handlers are a transport
// over `appRouter.createCaller`, so `protectedProcedure` and the
// ownership-scoped row filters remain the single authorization implementation
// — see `app/src/server/shell/http.ts`. Bundling a tRPC client here would add
// a second serialization format and 100KB+ to a page whose budget is 200ms,
// and buy nothing.
//
// EVERY function below is failure-first: nothing throws at the call site for
// an expected failure, and nothing invents a success. A rejected fetch comes
// back as a typed `{ ok: false, errorCode }` the boot UI already knows how to
// render honestly (see `boot-phases.js`).

const NS = 'ezil-os:';

/**
 * The shell's client budget for a cold desktop boot.
 *
 * `POST /api/shell/desktop` -> `cloudflareGuacamole.previewUrl` ->
 * `requestGuacamolePreview`, whose own budget is `SANDBOX_COLD_START_TIMEOUT_MS`
 * = 210s (180s Worker ceiling + 30s margin;
 * `app/src/server/lib/cloudflare-guacamole-provider.ts`). This must sit ABOVE
 * that and BELOW the route's `maxDuration = 300`, or the browser gives up on
 * a request the server is still about to answer successfully — the user then
 * sees a timeout for a desktop that actually booted.
 *
 * A cold boot is ~22s measured (docs/PLATFORM-NOTES.md §11). This ceiling is
 * not a target; it is the point past which we stop waiting.
 */
export const DESKTOP_BOOT_TIMEOUT_MS = 215_000;

/** The cheap status probe never wakes a container, so it gets a short leash. */
const STATUS_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Preferences — the `puter.kv` replacement
// ---------------------------------------------------------------------------
// `UI/UITaskbar.js` imports this module for `taskbar_position` and
// `taskbar_items`; upstream read both from the cloud. Same keys, same
// semantics, no network, and namespaced so the shell cannot collide with the
// Next app's own localStorage on the same origin.

/** localStorage can throw, not just return null (Safari private mode, disabled storage, quota). */
function storage () {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

export function get (key, fallback = null) {
    const s = storage();
    if ( ! s ) return fallback;
    try {
        const raw = s.getItem(NS + key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function set (key, value) {
    const s = storage();
    if ( ! s ) return false;
    try {
        s.setItem(NS + key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

export function del (key) {
    const s = storage();
    if ( ! s ) return false;
    try {
        s.removeItem(NS + key);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Identity — `window.__EZIL_BOOT__`
// ---------------------------------------------------------------------------

/**
 * The inlined boot payload, or `null` if the page did not provide one.
 *
 * Returning `null` rather than a plausible empty object is the whole point:
 * a shell with no payload is a shell that must NOT draw a desktop for nobody.
 * `boot.js` treats it as a hard stop.
 */
export function payload () {
    const raw = typeof window === 'undefined' ? null : window.__EZIL_BOOT__;
    if ( ! raw || typeof raw !== 'object' ) return null;
    // The one field every consumer dereferences. A payload without it is
    // malformed, not partial.
    if ( ! raw.user || typeof raw.user.id !== 'string' ) return null;
    return raw;
}

/** Where the Route Handlers live. Mirrors `SHELL_API_ROUTES` in boot-payload.ts. */
export const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
};

/** The payload carries its own endpoint map; prefer it, fall back to the mirror. */
function endpoint (name) {
    return payload()?.desktopState?.endpoints?.[name] ?? ENDPOINTS[name];
}

// ---------------------------------------------------------------------------
// The two Route Handlers
// ---------------------------------------------------------------------------

/**
 * One fetch, one shape out. Never throws for an HTTP-level failure — a
 * caller that has to `try` around every network call ends up with one
 * `catch` that cannot tell 401 from offline, and then shows the same wrong
 * message for both.
 *
 * @returns {Promise<{ok: true, data: any} | {ok: false, code: string, status: number, message: string}>}
 */
async function request (url, { method = 'GET', body, timeoutMs } = {}) {
    let res;
    try {
        res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        });
    } catch ( err ) {
        // `AbortSignal.timeout` rejects with a DOMException named
        // 'TimeoutError'; everything else here is a genuine transport
        // failure. The distinction survives into the boot UI's copy.
        const timedOut = err && err.name === 'TimeoutError';
        return {
            ok: false,
            code: timedOut ? 'TIMEOUT' : 'NETWORK',
            status: 0,
            message: timedOut ? 'The request took too long.' : 'Could not reach the server.',
        };
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if ( ! res.ok ) {
        return {
            ok: false,
            code: data?.error?.code ?? `HTTP_${res.status}`,
            status: res.status,
            message: data?.error?.message ?? 'Something went wrong.',
        };
    }
    return { ok: true, data };
}

/** `GET /api/shell/session` — read-only. `computer` may be null. */
export function readSession () {
    return request(endpoint('session'), { timeoutMs: STATUS_TIMEOUT_MS });
}

/** `POST /api/shell/session` — get-or-create the default computer. Idempotent. */
export function openSession () {
    return request(endpoint('session'), { method: 'POST', body: {}, timeoutMs: STATUS_TIMEOUT_MS });
}

/**
 * `POST /api/shell/desktop` — the long one. Starts (or attaches to) the
 * computer's desktop and resolves only at the end.
 *
 * 🔴 This is the ONLY way the shell may obtain a desktop URL. It routes to
 * `cloudflareGuacamole.previewUrl`, which runs `enableImplicitHosting`
 * SERVER-SIDE before returning — the Neko client reads that flag once, at
 * websocket init, so it must already be true when the iframe is created. A
 * shell that composed its own URL would produce a desktop that renders
 * perfectly and silently ignores every click.
 *
 * @returns {Promise<{ok: true, url: string, frameConfirmed: boolean, controlMode?: string, mode?: string, workspace?: any}
 *                  | {ok: false, errorCode: string, message?: string}>}
 */
export async function openDesktop (computerId) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to open.' };
    }
    const res = await request(endpoint('desktop'), {
        method: 'POST',
        body: { computerId },
        timeoutMs: DESKTOP_BOOT_TIMEOUT_MS,
    });

    if ( ! res.ok ) {
        // Transport/HTTP failure. `TIMEOUT` is the one code `previewUrl`
        // itself can never produce and the boot UI has real copy for.
        if ( res.code === 'TIMEOUT' ) return { ok: false, errorCode: 'timeout', message: res.message };
        if ( res.code === 'NETWORK' ) return { ok: false, errorCode: 'fetch_failed', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: res.message };
        return { ok: false, errorCode: 'unknown', message: res.message };
    }

    // `previewUrl` returns operational + deterministic failures as VALUES on
    // a 200, so that a retrying client cannot re-ask a question whose answer
    // is fixed. Pass the code straight through; `classifyFailure` in
    // boot-phases.js owns the mapping to user-facing copy.
    const data = res.data ?? {};
    if ( data.ok !== true ) {
        return { ok: false, errorCode: data.errorCode ?? 'unknown' };
    }
    if ( typeof data.guacamoleUrl !== 'string' || data.guacamoleUrl === '' ) {
        // Reported success with nothing to show. Loud, not silent.
        console.error('[ezil-os:session] previewUrl returned ok with no URL');
        return { ok: false, errorCode: 'unknown' };
    }
    return {
        ok: true,
        url: data.guacamoleUrl,
        // 🔴 Whether the SERVER observed the desktop origin answering, before
        // it handed this URL over. Strict `=== true`, and never defaulted to
        // true: a response that omits the field is a server that did not check,
        // and `computeBootUiState` must treat that as "not confirmed" rather
        // than inherit the old assumption that a URL implies a desktop.
        frameConfirmed: data.frame?.confirmed === true,
        controlMode: data.controlMode,
        mode: data.mode,
        workspace: data.workspace,
    };
}

/**
 * `GET /api/shell/desktop?confirm=frame` — ask the server to check, right now,
 * that the URL the iframe is showing is a desktop and not an error page.
 *
 * 🔴 WHY THE `load` EVENT IS NOT THIS. An iframe fires `load` for an HTTP 500
 * error page exactly as it does for a working desktop, and cross-origin script
 * cannot read the status code or the document. On 2026-07-31 the preview host
 * returned 500 "Proxy routing error" and the shell hid its boot panel over it
 * on `load`. The browser has no honest signal here; the server does, because it
 * can make a plain HTTP request to that origin and read the status line.
 *
 * Cheap: one GET to an edge hostname. No Worker call, no container wake.
 *
 * @returns {Promise<boolean | undefined>} `true` = the origin answered without
 *   an error status. `false` = it answered with one, or did not answer at all.
 *   `undefined` = OUR request never landed, which is not an observation of the
 *   desktop and must not be read as either verdict.
 */
export async function confirmFrame (computerId, frameUrl) {
    if ( ! computerId || ! frameUrl ) return undefined;
    const url = `${endpoint('desktop')}?computerId=${encodeURIComponent(computerId)}`
        + `&confirm=frame&frameUrl=${encodeURIComponent(frameUrl)}`;
    const res = await request(url, { timeoutMs: STATUS_TIMEOUT_MS });
    if ( ! res.ok ) return undefined;
    if ( res.data?.ok !== true ) return undefined;
    return res.data.confirmed === true;
}

/**
 * `GET /api/shell/desktop?computerId=` — the cheap poll. Does NOT wake a
 * sleeping container, so it is safe to run every 2s WHILE the boot request
 * above is in flight. It is the single genuine mid-boot signal the browser
 * has; everything else the progress UI shows is an estimate and says so.
 *
 * @returns {Promise<boolean | undefined>} `guacamoleRunning`, or `undefined`
 *   when no answer landed. `undefined` must NOT be read as `false` — that
 *   would fabricate a negative signal we do not have.
 */
export async function desktopRunning (computerId) {
    if ( ! computerId ) return undefined;
    const url = `${endpoint('desktop')}?computerId=${encodeURIComponent(computerId)}`;
    const res = await request(url, { timeoutMs: STATUS_TIMEOUT_MS });
    if ( ! res.ok ) return undefined;
    return res.data?.ok === true ? res.data.guacamoleRunning : undefined;
}

export default {
    get, set, del,
    payload,
    readSession, openSession,
    openDesktop, desktopRunning, confirmFrame,
    ENDPOINTS,
    DESKTOP_BOOT_TIMEOUT_MS,
};
