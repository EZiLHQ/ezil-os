// telemetry.js — EZiL-authored. Not Puter code.
//
// The shell's half of `scratchpad/telemetry-design.md` (§4.3, §5, §9's
// "shell-side" column) — read that document in full before touching this
// file. This module turns the ~35 `console.error` sites this shell already
// has (`PUTER-PROVENANCE.md`-adjacent inventory in the design doc's §1.1)
// into a best-effort beacon to `/api/shell/telemetry`, PLUS the global crash
// handlers that did not exist anywhere in this codebase before this file.
//
// ── THE ONE RULE EVERYTHING ELSE SERVES ─────────────────────────────────────
// 🔴 TELEMETRY MUST NEVER BREAK THE OS, NEVER SLOW IT DOWN, AND NEVER BE
// TRUSTED. No caller of `capture()` may ever `await` it, branch on its
// return value, or have its own behaviour change because telemetry is up,
// down, slow, or 500ing. Every failure mode below resolves to "the user sees
// nothing" — see the design doc's §4.6 table, reproduced here as the
// authority this file is built against:
//
//   capture() itself throws        -> swallowed; a re-entrancy guard stops a
//                                      telemetry bug from recursing through
//                                      the global handler IT installed
//   buffer overflows                -> oldest events dropped, a counter kept
//   sendBeacon rejected              -> falls through to `keepalive` fetch
//   fetch throws/times out/4xx/5xx  -> `.catch(() => {})`; response never read
//   two consecutive transport fails -> this session's telemetry goes dark
//   the route does not exist        -> feature-detected; the module never
//                                      arms in the first place (see below)
//
// A reviewer can check the guarantee by grepping this file for `await` next
// to anything that reaches the network — there is exactly one, and it is
// wrapped so nothing downstream of it can ever run synchronously with a
// caller's own control flow (`queue()` below never returns a promise its
// caller could mistakenly chain on).
//
// ── FEATURE DETECTION, NOT A ROUTE THIS FILE INVENTED ───────────────────────
// `window.__EZIL_BOOT__.desktopState?.endpoints?.telemetry` (via the local
// `bootPayload()` below — see its own comment for why this file reads that
// global directly instead of importing `session.js`) is read fresh on every
// arm-check, the same way `desktop-window.js` gates its app-switcher on
// `endpoints.focus` (see that file's header). At the time this file was
// written `app/src/server/shell/boot-payload.ts` (not owned by this task)
// had not published a `telemetry` endpoint yet. It does as of 2026-08-03
// (`telemetry: '/api/shell/telemetry'`), so on a current server build this
// module DOES arm. An older server build is still a real state — the bundle
// and the server deploy separately — a deployment on that server
// build simply never arms, and every `capture()` call below is then a no-op
// that costs one property read. Nothing here assumes the route exists, and
// nothing here POSTs to a URL it invented.
//
// ── WHAT NEVER CROSSES THE WIRE ──────────────────────────────────────────────
// No `payload().user.id`, no `payload().user.email`, no raw stack (one frame,
// `functionName@file.js`, no line/column, no absolute path), no cookie, no
// token, no full URL. `redact()` below is a client-side, best-effort pass —
// the design doc's §3.1 says the ingest route re-runs its own sanitiser as
// defence in depth, and this file's job is to not be the ONLY line of
// defence, not to be a complete one.
// 🔴 NO IMPORT OF `./session.js` HERE, ON PURPOSE. `boot.js` imports this
// module FIRST, specifically so its top-level `installGlobalHandlers()` call
// (see the tail of this file) runs before any other module's own top-level
// code — including `session.js`'s. Importing `session.js` back from here
// would make the two modules a circular pair and put this file's own arm
// check at the mercy of import-graph ordering it does not control. Reading
// `window.__EZIL_BOOT__` directly is the same one-line contract
// `session.js`'s own `payload()` uses, kept local so this file has zero
// shell-internal dependencies — a leaf module, deliberately.
function bootPayload () {
    const raw = typeof window === 'undefined' ? null : window.__EZIL_BOOT__;
    if ( ! raw || typeof raw !== 'object' ) return null;
    if ( ! raw.user || typeof raw.user.id !== 'string' ) return null;
    return raw;
}

const SCHEMA_VERSION = 1;
const MAX_BUFFER = 50;
const MAX_BATCH = 50;
const MAX_FLUSHES = 10;
const MAX_PER_KEY = 3; // per (eventClass+site+code) per page life
const FLUSH_MS = 10_000;
const SEND_TIMEOUT_MS = 3_000;

/** Closed set — mirrors `scratchpad/telemetry-design.md` §1.2 exactly. */
const EVENT_CLASSES = new Set([
    'boot_phase', 'boot_summary', 'boot_stall', 'crash', 'window_error',
    'api_failure', 'display_failure', 'worker_exception', 'contract_violation',
]);

// ── module state ────────────────────────────────────────────────────────────
// One page load, one buffer. Nothing here is meant to survive a reload — an
// unflushed tail is an accepted, documented loss (design doc §10.2), not a
// bug this file tries to paper over with localStorage.
let armed = null;          // null = not yet checked; true/false once known
let buffer = [];
let flushCount = 0;
let consecutiveFailures = 0;
let killed = false;        // two consecutive transport failures -> stop for good
let flushTimer = null;
let dropped = 0;
const perKeySeen = new Map();
let reentering = false;    // stops capture() recursing through its own onerror

function endpointUrl () {
    const url = bootPayload()?.desktopState?.endpoints?.telemetry;
    return typeof url === 'string' && url !== '' ? url : null;
}

function isArmed () {
    if ( killed ) return false;
    if ( armed === null ) armed = endpointUrl() !== null;
    return armed;
}

/**
 * Best-effort, NOT a security boundary (the ingest route re-sanitises). Caps
 * at 200 chars per the wire contract. Order matters less here than in the
 * server's `normalizeDetail` — this only has to keep the obvious things
 * (tokens, cookies, IPs, long opaque ids) off the wire, not produce a stable
 * fingerprint.
 */
function redact (input) {
    if ( input === undefined || input === null ) return undefined;
    let s;
    if ( input instanceof Error ) {
        s = input.message ?? String(input);
    } else if ( typeof input === 'string' ) {
        s = input;
    } else {
        try { s = JSON.stringify(input); } catch { s = String(input); }
    }
    if ( typeof s !== 'string' || s === '' ) return undefined;
    s = s
        .replace(/\b(?:authorization|cookie|set-cookie)\s*:\s*\S+/gi, '[redacted-header]')
        .replace(/\bbearer\s+[\w.-]+/gi, '[redacted-token]')
        .replace(/\b(?:key|secret|token|password|sig|hmac)=[^\s'"&]+/gi, '[redacted]')
        .replace(/\b(?:data|blob):[^\s'"]+/gi, '<uri>')
        .replace(/\bhttps?:\/\/[^\s'"<>)\]]+/gi, '<url>')
        // Absolute filesystem paths. A workspace path is
        // `/home/<login>/workspace/<project>` — a username and a project
        // name, which `docs/telemetry.md` promises is never stored. Anchored
        // on a `/` NOT preceded by a word char, `:`, `/`, `@`, `.`, `~` or
        // `$`, so `and/or`, `1/2`, `08/01/2026` and a URL's own path survive.
        // A segment may hold single spaces only when another `/` follows, so
        // a project called `my app` is eaten while `expected 200 / got 500`
        // is not. `:` is excluded from the segment class on purpose:
        // `file.js:12:34` keeps its position and `port :8444` keeps its port.
        //
        // Written with a leading capture group rather than the server twin's
        // `(?<!...)` lookbehind ON PURPOSE — a lookbehind in a regex LITERAL
        // is a parse-time SyntaxError on Safari < 16.4, which would take this
        // whole module down at load rather than degrade. This is the
        // best-effort client copy; `sanitizeErrorMessage` on the server is
        // the boundary that actually has to be exact.
        .replace(/(^|[^\w:/@.~$-])(~?(?:\/[\w.@%+~-]+(?: [\w.@%+~-]+)*(?=\/))*\/[\w.@%+~-]+\/?)/g, '$1<path>')
        .replace(/\b[a-z]:\\(?:[\w.@%+~-]+(?: [\w.@%+~-]+)*\\)*[\w.@%+~-]*/gi, '<path>')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '<opaque>')
        .trim();
    return s.slice(0, 200);
}

/** `[a-z0-9_]{1,64}`, per the wire contract. Never rejects — normalises. */
function normalizeCode (code) {
    const s = String(code ?? 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return (s || 'unknown').slice(0, 64);
}

/** Max 96 chars, logical origin — callers already pass a hand-written literal. */
function normalizeSite (site) {
    return String(site ?? 'unknown').slice(0, 96);
}

/** One frame only: `functionName@file.js`, no line/col, no absolute path. */
function firstFrame (err) {
    const stack = err && typeof err.stack === 'string' ? err.stack : '';
    const line = stack.split('\n').find((l, i) => i > 0 && l.trim() !== '');
    if ( ! line ) return undefined;
    // `at functionName (path/to/file.js:12:34)` or `funcName@path/to/file.js:12:34`
    const m = line.match(/at\s+([^\s(]+)\s*\(?([^():]+):\d+:\d+\)?/) ?? line.match(/([^@]*)@([^:]+):\d+:\d+/);
    if ( ! m ) return undefined;
    const fn = (m[1] || '<anonymous>').trim().slice(0, 60);
    const file = String(m[2] || '').split('/').pop() ?? '';
    return file ? `${fn}@${file}`.slice(0, 96) : undefined;
}

/**
 * A real RFC-4122 v4 uuid, always.
 *
 * 🔴 `crypto.randomUUID` requires a SECURE CONTEXT — it is `undefined` on a
 * plain-http origin. The previous fallback here was
 * `String(Date.now()) + Math.random()...`, which is not a uuid, and the ingest
 * route's zod schema is `eventId: z.string().uuid()` inside a `.strict()`
 * parse that drops the WHOLE event. So on any non-secure origin this module
 * would have armed, buffered, flushed, got its 202 (the route always answers
 * 202) and had 100% of its events silently discarded server-side, with
 * nothing anywhere to indicate it. `crypto.getRandomValues` has no
 * secure-context requirement, so it covers the gap; `Math.random` is the last
 * resort and still produces a well-formed v4.
 */
function newEventId () {
    try {
        if ( typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ) {
            return crypto.randomUUID();
        }
        const b = new Uint8Array(16);
        if ( typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function' ) {
            crypto.getRandomValues(b);
        } else {
            for ( let i = 0; i < 16; i++ ) b[i] = Math.floor(Math.random() * 256);
        }
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10x
        const h = [];
        for ( let i = 0; i < 16; i++ ) h.push(b[i].toString(16).padStart(2, '0'));
        return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}`
            + `-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
    } catch {
        return '00000000-0000-4000-8000-000000000000';
    }
}

function keyFor (eventClass, site, code) {
    return `${eventClass}${site}${code}`;
}

function scheduleFlush () {
    if ( flushTimer !== null ) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_MS);
}

/**
 * The ONE place this file touches the network. Never awaited by anything
 * outside this module, and never lets its own outcome escape as a rejection
 * a caller could observe.
 */
function send (url, body) {
    let ok = false;
    try {
        if ( typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ) {
            const blob = typeof Blob === 'function'
                ? new Blob([body], { type: 'application/json' })
                : body;
            ok = navigator.sendBeacon(url, blob);
        }
    } catch {
        ok = false;
    }
    if ( ok ) {
        consecutiveFailures = 0;
        return;
    }
    if ( typeof fetch !== 'function' ) {
        consecutiveFailures += 1;
        if ( consecutiveFailures >= 2 ) killed = true;
        return;
    }
    try {
        const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(SEND_TIMEOUT_MS)
            : undefined;
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body,
            keepalive: true,
            signal,
        }).then(
            () => { consecutiveFailures = 0; },
            () => {
                consecutiveFailures += 1;
                if ( consecutiveFailures >= 2 ) killed = true;
            },
        );
    } catch {
        consecutiveFailures += 1;
        if ( consecutiveFailures >= 2 ) killed = true;
    }
}

function flush () {
    try {
        if ( killed || buffer.length === 0 ) return;
        if ( flushCount >= MAX_FLUSHES ) { buffer = []; return; }
        const url = endpointUrl();
        if ( ! url ) return; // route disappeared (rehydrate onto an older payload) — stay dark
        const events = buffer.slice(0, MAX_BATCH);
        buffer = buffer.slice(events.length);
        flushCount += 1;
        const body = JSON.stringify({ schemaVersion: SCHEMA_VERSION, events });
        send(url, body);
    } catch {
        // A telemetry bug must not surface as an uncaught rejection/throw.
    }
}

/**
 * Record one telemetry event, ALONGSIDE whatever `console.error`/`console.warn`
 * the call site already does — never in place of it. Fully synchronous,
 * never throws, never returns anything a caller could branch on.
 *
 * @param {object} input
 * @param {string} input.eventClass One of the nine closed classes.
 * @param {string} input.site Hand-written logical origin, e.g.
 *   `ezil-os:apps/preview#mint`. Never a file:line.
 * @param {string|number} [input.code] Short code; normalised to `[a-z0-9_]{1,64}`.
 * @param {'ok'|'error'|'skipped'} [input.outcome] Defaults to `'error'` — every
 *   call site this ships beside is itself an error path.
 * @param {unknown} [input.detail] Redacted and capped at 200 chars.
 * @param {number} [input.durationMs]
 * @param {string} [input.computerId]
 * @param {Record<string, string|number|boolean>} [input.attrs] Bounded extras;
 *   the ingest route strips anything not on its per-class allow-list, so this
 *   file does not need its own copy of that list.
 */
export function capture (input) {
    if ( reentering ) return;
    reentering = true;
    try {
        if ( killed ) return;
        if ( ! input || typeof input !== 'object' ) return;
        const eventClass = EVENT_CLASSES.has(input.eventClass) ? input.eventClass : undefined;
        if ( ! eventClass ) return; // an unrecognised class is a bug in THIS file's own call sites
        if ( ! isArmed() ) return;

        const site = normalizeSite(input.site);
        const code = normalizeCode(input.code);
        const key = keyFor(eventClass, site, code);
        const seen = perKeySeen.get(key) ?? 0;
        if ( seen >= MAX_PER_KEY ) return;
        perKeySeen.set(key, seen + 1);

        if ( buffer.length >= MAX_BUFFER ) {
            buffer.shift();
            dropped += 1;
        }

        const event = {
            eventId: newEventId(),
            schemaVersion: SCHEMA_VERSION,
            eventClass,
            source: 'shell',
            occurredAt: new Date().toISOString(),
            site,
            code,
            outcome: (input.outcome === 'ok' || input.outcome === 'skipped') ? input.outcome : 'error',
        };
        const detail = redact(input.detail);
        if ( detail ) event.detail = detail;
        if ( typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ) {
            event.durationMs = Math.max(0, Math.round(input.durationMs));
        }
        if ( typeof input.computerId === 'string' && input.computerId ) event.computerId = input.computerId;
        if ( input.attrs && typeof input.attrs === 'object' ) {
            const attrs = {};
            for ( const [k, v] of Object.entries(input.attrs) ) {
                if ( typeof v === 'string' ) attrs[k] = v.slice(0, 120);
                else if ( typeof v === 'number' || typeof v === 'boolean' ) attrs[k] = v;
            }
            if ( Object.keys(attrs).length > 0 ) event.attrs = attrs;
        }
        if ( dropped > 0 ) {
            event.attrs = { ...(event.attrs ?? {}), dropped };
        }

        buffer.push(event);
        scheduleFlush();
    } catch {
        // See the file header: capture() must never throw, ever, for any input.
    } finally {
        reentering = false;
    }
}

let installed = false;

/**
 * Install the global crash handlers. Idempotent — safe to call more than
 * once (a rehydrate, a test harness re-running `boot()`), and installs
 * exactly one pair of listeners no matter how many times it is called.
 *
 * Called from `boot.js`, as the first statement in its body — see that
 * file's header for why "first thing that can run" and "first import" are
 * not the same point, and this is the former.
 */
export function installGlobalHandlers () {
    if ( installed ) return;
    if ( typeof window === 'undefined' || typeof window.addEventListener !== 'function' ) return;
    installed = true;

    window.addEventListener('error', (ev) => {
        try {
            capture({
                eventClass: 'crash',
                site: 'ezil-os:window#onerror',
                code: (ev?.error && ev.error.name) ? ev.error.name : 'error',
                detail: redact(ev?.error ?? ev?.message),
                attrs: { stack_head: firstFrame(ev?.error) },
            });
        } catch { /* never let the handler itself throw */ }
    });

    window.addEventListener('unhandledrejection', (ev) => {
        try {
            const reason = ev?.reason;
            capture({
                eventClass: 'crash',
                site: 'ezil-os:window#unhandledrejection',
                code: (reason && reason.name) ? reason.name : 'unhandled_rejection',
                detail: redact(reason),
                attrs: { stack_head: firstFrame(reason) },
            });
        } catch { /* never let the handler itself throw */ }
    });
}

/** Best-effort final flush. Still fire-and-forget — see the file header. */
function flushOnHide () {
    if ( document.visibilityState === 'hidden' ) flush();
}

if ( typeof document !== 'undefined' && typeof document.addEventListener === 'function' ) {
    document.addEventListener('visibilitychange', flushOnHide);
    // Not `beforeunload` — design doc §4.3: unreliable, and can block the unload.
    window.addEventListener('pagehide', () => { flush(); });
}

// Self-installing. Importing this module IS "installing the handlers" — see
// `boot.js`'s "FIRST IMPORT, ON PURPOSE" comment for why that has to happen
// before any other module's own top-level code runs, not merely before
// `boot()` is called. `installGlobalHandlers` itself stays idempotent and
// exported for a test harness that wants to (re-)arm it explicitly.
installGlobalHandlers();

export default { capture, installGlobalHandlers };
