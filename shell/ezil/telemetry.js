// telemetry.js — EZiL-authored. Not Puter code.
//
// The shell's half of `docs/telemetry-design.md` (§4.3, §5, §9's
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
//
// `./trace.js` is the ONE exception, and it is safe for a different reason
// than "leaf module": that file has zero top-level side effects (no
// self-installing behaviour, unlike this file's own tail), so importing it
// cannot disturb the "telemetry.js must be the FIRST import" ordering
// `boot.js` depends on — see `trace.js`'s own header for the full account of
// why the dependency runs this direction and not the other.
import { newEventId, ambientCorrelationId } from './trace.js';

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

/** Closed set — mirrors `docs/telemetry-design.md` §1.2 exactly. */
const EVENT_CLASSES = new Set([
    'boot_phase', 'boot_summary', 'boot_stall', 'crash', 'window_error',
    'api_failure', 'display_failure', 'worker_exception', 'contract_violation',
]);

// 🔴 `MAX_PER_KEY` would throttle `boot_summary` to three app-opens per page:
// each app-open's `site` is `ezil-os:trace#<appId>` and `code` is almost
// always `ok`, so opening the SAME app a fourth time in one page life shares
// a key with the first three and gets silently dropped — exactly the traces
// an admin reviewing "what happened on this page" would want to see. These
// two classes (breadcrumbs' own summary, and any future direct `boot_phase`
// emission) are exempted from the per-KEY dedup above and given a shared
// per-PAGE cap instead — see `capture()`'s branch below.
const BOOT_EVENT_CLASSES = new Set(['boot_summary', 'boot_phase']);
const MAX_BOOT_EVENTS_PER_PAGE = 12;

/**
 * The `site` values `docs/BROWSER-FIX-CONTRACT.md` §8 assigns to the
 * twelve-agent browser fix, so the shell-side emitters (the desktop window's
 * screen/close paths, the mobile keyboard affordance) import ONE spelling
 * instead of retyping the string in three files. Mirrors
 * `BROWSER_FIX_SITES` in `app/src/server/telemetry/types.ts`.
 *
 * `site` is not a closed enum on the wire — this constant gates nothing, it
 * just removes the typo. `code` IS charset-constrained (`[a-z0-9_]`), and
 * `normalizeCode` below already maps the contract's hyphenated spellings onto
 * it, so a call site may pass either `screen-unsupported` or
 * `screen_unsupported` and one row comes out.
 */
export const SITES = {
    DESKTOP_SCREEN: 'ezil-os:apps/desktop#screen',
    DESKTOP_CLOSE: 'ezil-os:apps/desktop#close',
    DESKTOP_KEYBOARD: 'ezil-os:apps/desktop#keyboard',
    DESKTOP_PICTURE: 'ezil-os:apps/desktop#picture',
};

// ── The cross-origin bridge for the in-stream mobile script ──────────────────
// `worker/assets/neko-branding/www/ezil-mobile.js` runs INSIDE the neko
// document. That document is a different origin: it cannot import this module,
// cannot read the boot payload, and has no route to `/api/shell/telemetry`. So
// the one §8 row it is responsible for (`ezil-os:apps/desktop#keyboard` /
// `window_error`) cannot be emitted by the code that detects it. It
// `postMessage`s the parent instead, and this listener is what closes the loop.
//
// 🔴 THIS IS UNTRUSTED INPUT FROM ANOTHER ORIGIN and is treated as such. A
// `postMessage` handler that believes its payload is a real attack surface, so:
//
//   1. `event.source` must be the `contentWindow` of an iframe THIS document
//      embedded inside the desktop window, and `event.origin` must equal that
//      iframe's own `src` origin. Both, not either. A nested frame inside the
//      stream page, or any other window that posts to `window.top`, fails the
//      first test; a spoofed `data.source` fails nothing on its own and is
//      therefore never sufficient. Nothing is derived from the message about
//      where it came from — the DOM is the authority.
//   2. `site` must be a key of a CLOSED MAP defined here, and `type` must
//      equal the ONE class that map pairs with that site. Any other site, or
//      the right site under the wrong class, is dropped rather than forwarded
//      — and the class actually recorded is read off the map, not the message.
//   3. `code` is the ONLY free-ish field, and it goes through the same
//      `normalizeCode` every other call site uses (`[a-z0-9_]`, 64 chars).
//   4. `detail`, `attrs`, `correlationId` and `computerId` are NEVER read off
//      the message. A cross-origin page must not be able to write free text
//      into a `detail` column, however well `redact()` works.
//   5. Bounded per page load, independently of `capture()`'s own dedup.
//
// If any of that cannot hold, the correct outcome is a MISSING telemetry row.
const MOBILE_BRIDGE_SOURCE = 'ezil-mobile';

/**
 * The closed set, as a PAIRING of site -> the one class that site may be
 * reported under, plus the `attrs` this shell writes for it (never the
 * message's).
 *
 * It was two independent sets — one of sites, one of classes — which admitted
 * their cross product the moment a second row was added. Pairing them keeps
 * "one more thing the stream may tell us" from also meaning "three more shapes
 * it may tell us in". This NARROWS the previous contract rather than widening
 * it: every message the old sets accepted and this one rejects is a
 * combination no producer has ever emitted.
 *
 * `#picture` is the black-screen detector in
 * `worker/assets/neko-branding/www/ezil-mobile.js`. It is here because the
 * decoded `<video>` lives in THAT origin and cannot be read from this one, so
 * the shell has no independent way to learn that the desktop it just revealed
 * shows nothing at all — which is exactly how 13 of 13 production opens
 * rendered a completely black picture under `outcome: 'ok'`.
 *
 * `attrs` is omitted for `display_failure` on purpose: its server-side
 * allow-list (`ATTRS_ALLOW_LIST` in `app/src/server/telemetry/types.ts`) is
 * `['seen']`, so an `app_id` sent under that class would be stripped on
 * ingest. Sending a key guaranteed to be discarded is how a field comes to be
 * believed in a dashboard that never receives it.
 */
const MOBILE_BRIDGE_CONTRACT = new Map([
    [SITES.DESKTOP_KEYBOARD, { eventClass: 'window_error', attrs: { app_id: 'desktop' } }],
    [SITES.DESKTOP_PICTURE, { eventClass: 'display_failure', attrs: undefined }],
]);
const MAX_MOBILE_BRIDGE_EVENTS = 5;
let mobileBridgeCount = 0;

/**
 * Is this message from an iframe this document itself embedded inside the
 * desktop window, posting from that iframe's own origin?
 *
 * The `.window[data-app="desktop"]` selector is the same DOM contract
 * `ui/Settings/tabs/troubleshoot.js` already reads. If it ever drifts, this
 * returns `false` and the bridge goes silent — it fails CLOSED, which is the
 * only acceptable direction for a trust check.
 */
function fromDesktopFrame (event) {
    if ( typeof document === 'undefined' || ! event || ! event.source ) return false;
    const frames = document.querySelectorAll('.window[data-app="desktop"] iframe');
    for ( const frame of frames ) {
        let contentWindow = null;
        try { contentWindow = frame.contentWindow; } catch { continue; }
        if ( contentWindow === null || contentWindow !== event.source ) continue;
        // Same frame. Now its OWN origin must be the one that posted.
        let frameOrigin = null;
        try { frameOrigin = new URL(frame.src, location.href).origin; } catch { return false; }
        // `about:blank` (the pre-navigation state) and any opaque origin
        // serialise to 'null', which must never match.
        if ( ! frameOrigin || frameOrigin === 'null' ) return false;
        return frameOrigin === event.origin;
    }
    return false;
}

/** The `message` handler itself. Never throws; drops anything it cannot fully vouch for. */
function onMobileBridgeMessage (event) {
    try {
        const data = event?.data;
        if ( ! data || typeof data !== 'object' ) return;
        if ( data.source !== MOBILE_BRIDGE_SOURCE ) return;
        if ( mobileBridgeCount >= MAX_MOBILE_BRIDGE_EVENTS ) return;
        // Cheap shape checks first, the DOM walk only for a plausible message.
        if ( typeof data.site !== 'string' ) return;
        const allowed = MOBILE_BRIDGE_CONTRACT.get(data.site);
        if ( ! allowed ) return;
        if ( data.type !== allowed.eventClass ) return;
        if ( ! fromDesktopFrame(event) ) return;
        mobileBridgeCount += 1;
        // `code` is normalised by `capture()`; nothing else is taken from the
        // message. The class and the attrs come from the CONTRACT above, keyed
        // by site — never from the payload, even though the payload had to name
        // a matching class to get this far.
        capture({
            eventClass: allowed.eventClass,
            site: data.site,
            code: data.code,
            outcome: 'error',
            attrs: allowed.attrs,
        });
    } catch {
        // A hostile or malformed message must never surface as a page error.
    }
}

/**
 * How many recent captures the LOCAL diagnostic mirror keeps (`recentEvents`).
 * Independent of `MAX_BUFFER` — that one is the OUTGOING queue and is drained
 * on every flush, which is exactly why it cannot double as "what happened on
 * this page". Bounded, oldest evicted, same discipline as everything else here.
 */
const MAX_RECENT = 50;
const recent = [];

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
let bootEventCount = 0;    // shared per-page counter for BOOT_EVENT_CLASSES
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
export function redact (input) {
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
        // A QUOTED absolute path is eaten whole, spaces and all — quotes
        // delimit it unambiguously. Must run before the unquoted rule.
        //
        // KNOWN RESIDUAL (stated in `docs/telemetry.md`, not papered over): an
        // UNQUOTED path whose LAST segment contains a space is redacted only
        // up to that space. Nothing can decide where such a path ends, and
        // absorbing the rest of the sentence would eat the diagnosis.
        //
        // Written with a leading capture group rather than the server twin's
        // `(?<!...)` lookbehind ON PURPOSE — a lookbehind in a regex LITERAL
        // is a parse-time SyntaxError on Safari < 16.4, which would take this
        // whole module down at load rather than degrade. This is the
        // best-effort client copy; `sanitizeErrorMessage` on the server is
        // the boundary that actually has to be exact.
        .replace(/(['"])(~?\/[^'"\n]{0,240})\1/g, '$1<path>$1')
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `computerId` every event defaults to: this boot's own computer row id.
 *
 * 🔴 WHY THIS EXISTS. `docs/telemetry.md` §"computer_id and the Worker" states
 * plainly that "`computer_id` is filled in only by the BROWSER, which knows
 * the real UUID" — and the browser never did. Measured 2026-08-19 against the
 * live database: `computer_id` was NULL on 100% of stored rows, so no error
 * could be attributed to a computer and "something failed" could never become
 * "*this* computer failed". Nothing was wrong with the column, the schema or
 * the ingest route; the one producer that has the value simply never sent it.
 * Defaulting it here fixes every existing `capture()` call site at once,
 * exactly the way `ambientCorrelationId()` did for `correlationId`.
 *
 * 🔴 UUID-CHECKED, and this check is not paranoia. The app's ingest schema is
 * `computerId: z.string().uuid()` inside a `.strict()` parse, and a failure
 * drops the WHOLE EVENT — this is the identical trap `worker/src/telemetry.ts`
 * documents for `sandboxId`, where filling the field in did not attach a
 * computer, it silently discarded 100% of that producer's telemetry. A boot
 * payload whose `computer.id` is not a UUID (a test fixture, a future
 * non-UUID id scheme) yields `undefined` here and the field is simply omitted,
 * which costs one join and loses nothing.
 */
function ambientComputerId () {
    const id = bootPayload()?.computer?.id;
    return (typeof id === 'string' && UUID_RE.test(id)) ? id : undefined;
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

// `newEventId()` used to live here. EXTRACTED to `./trace.js` (imported
// above) so `beginTrace()` can mint a trace id with the exact same
// secure-context-safe generator, per the design brief: "do NOT write a
// second uuid generator". See that file's header for the full account,
// including why importing it here does not reintroduce the "leaf module"
// hazard this file's own header warns about for `./session.js`.

function keyFor (eventClass, site, code) {
    return `${eventClass}${site}${code}`;
}

/**
 * Record one capture in the LOCAL diagnostic mirror. Bounded, oldest evicted,
 * never sent anywhere by this module.
 *
 * Why this exists: `shell/ezil/log.js`'s ring buffer was built so a support
 * conversation would not depend on the user having had devtools open — but
 * only ONE module (`apps/registry.js`, six call sites) ever writes to it,
 * while there are ~30 `capture()` call sites covering the crash handlers and
 * every `window_error` / `api_failure` / `contract_violation` in this shell.
 * Reading the console ring back without also reading these would surface the
 * quiet half of the story and miss the loud half.
 *
 * The outgoing `buffer` cannot serve this purpose: it is DRAINED on every
 * flush, so by the time a user opens Settings it is usually empty.
 */
function pushRecent (entry) {
    try {
        recent.push(entry);
        if ( recent.length > MAX_RECENT ) recent.shift();
    } catch { /* a diagnostic mirror must never be able to break capture() */ }
}

/**
 * Snapshot of the recent captures on this page — a copy, so a caller can
 * never mutate the live mirror.
 *
 * Every field here is ALREADY the sanitized closed-vocabulary wire form:
 * `site` and `code` are hand-written low-cardinality literals and `detail`
 * has been through `redact()`. There is nothing in here that is not already
 * permitted to cross the wire, which is what makes it safe for
 * Settings → Troubleshoot to show and for a user to copy.
 */
export function recentEvents () {
    return recent.slice();
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
 * @param {string} [input.correlationId] Groups this event with the rest of
 *   one app-open. Explicit value wins; otherwise defaults to whatever trace
 *   is currently ambient (`./trace.js`'s `beginTrace()`/`ambientCorrelationId()`),
 *   so most callers never need to pass this at all.
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

        const site = normalizeSite(input.site);
        const code = normalizeCode(input.code);
        const detail = redact(input.detail);
        const outcome = (input.outcome === 'ok' || input.outcome === 'skipped') ? input.outcome : 'error';

        // 🔴 BEFORE the arm check, on purpose. The local diagnostic mirror
        // (`recentEvents()`, read by Settings → Troubleshoot) has to work on a
        // deployment whose server has no telemetry route at all — that is
        // precisely the deployment where a user asking "what went wrong" has
        // no other source. It never leaves the browser on its own; only the
        // user's own copy action moves it anywhere.
        pushRecent({ t: Date.now(), eventClass, site, code, outcome, detail });

        if ( ! isArmed() ) return;

        if ( BOOT_EVENT_CLASSES.has(eventClass) ) {
            // 🔴 Exempt from the per-(class+site+code) dedup below — see
            // BOOT_EVENT_CLASSES' own comment for why that dedup would
            // throttle repeat app-opens to three per page. A shared per-page
            // cap still bounds the worst case (a pathological loop of opens).
            if ( bootEventCount >= MAX_BOOT_EVENTS_PER_PAGE ) return;
            bootEventCount += 1;
        } else {
            const key = keyFor(eventClass, site, code);
            const seen = perKeySeen.get(key) ?? 0;
            if ( seen >= MAX_PER_KEY ) return;
            perKeySeen.set(key, seen + 1);
        }

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
            outcome,
        };
        if ( detail ) event.detail = detail;
        if ( typeof input.durationMs === 'number' && Number.isFinite(input.durationMs) ) {
            event.durationMs = Math.max(0, Math.round(input.durationMs));
        }
        // Explicit caller value wins; otherwise default to whatever app-open
        // trace is currently ambient (`registry.js`'s `launch()` opens one) —
        // the single change that groups every existing capture() call site
        // under one app-open's correlation id without editing any of them.
        const correlationId = (typeof input.correlationId === 'string' && input.correlationId)
            ? input.correlationId
            : ambientCorrelationId();
        // 64 chars, per the wire contract (`TELEMETRY_LIMITS.MAX_CORRELATION_ID_LEN`).
        if ( correlationId ) event.correlationId = String(correlationId).slice(0, 64);
        // Explicit caller value wins; otherwise default to this boot's own
        // computer — see `ambientComputerId()` for why the field was NULL on
        // every stored row until now, and why it is UUID-checked.
        // An EXPLICIT value is UUID-checked too: the server drops the whole
        // event on a malformed one, so forwarding a caller's typo would lose
        // the event entirely rather than lose one join.
        const explicitComputerId = (typeof input.computerId === 'string' && UUID_RE.test(input.computerId))
            ? input.computerId
            : undefined;
        const computerId = explicitComputerId ?? ambientComputerId();
        if ( computerId ) event.computerId = computerId;
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

    // The in-stream mobile script's only way home. See `onMobileBridgeMessage`
    // and the block above it for the trust argument — this listener rejects
    // everything it cannot positively attribute to the desktop iframe.
    window.addEventListener('message', onMobileBridgeMessage);
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

export default { capture, installGlobalHandlers, recentEvents, redact, SITES };
