// log.js — EZiL-authored. Not Puter code.
//
// `debug`/`info`/`warn`/`error` to the console AND a small in-memory ring
// buffer, so a support conversation ("what did the console say right before
// this broke?") does not depend on the user having had devtools open at the
// time. Level is configurable, DEFAULTS TO `info` so nothing about this
// shell's existing console output changes for anyone who has not opted in.
//
// ── This is NOT telemetry ────────────────────────────────────────────────────
// `./telemetry.js` sends structured, sanitized, closed-vocabulary EVENTS to
// the server. This file is a local, in-memory convenience for reading the
// console back later (e.g. a future Settings/Troubleshoot pane, or a
// developer pasting `ezil.log.ringBuffer()` into a bug report) — it never
// sends anything anywhere on its own. The two are complementary, not
// duplicates: a `capture()` call site is free to ALSO log through this module
// (or plain `console.*`) without changing what reaches the server.
//
// ── Level selection, resolved ONCE per page load ─────────────────────────────
// `localStorage['ezil.logLevel']` (persistent, a developer's own setting) or
// `?ezilDebug=1` (a one-off query param, wins over localStorage so a shared
// debug link works regardless of what is already stored) — checked in that
// order, first match wins, default `info`. Read lazily on first use, not at
// import time: `localStorage`/`location` are real browser globals this
// module must tolerate being absent (same "never crash a leaf module under
// plain Node" discipline `telemetry.js` follows), and reading them at module
// top level would make import order matter for something this simple.
//
// ── Migration is OPPORTUNISTIC, not wholesale ────────────────────────────────
// Existing `console.error`/`console.warn`/`console.info` call sites across
// this shell are NOT batch-rewritten to use this module — that is a much
// larger, separately-reviewable diff for near-zero behavioural gain today
// (every one of them already prints; this module's value is the RING BUFFER,
// which nothing yet reads). New/touched call sites in owned files may adopt
// it opportunistically (see `./apps/registry.js` for a few done this way).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const DEFAULT_LEVEL = 'info';
/** Bounded so a chatty page cannot grow this forever — same "oldest evicted,
 * a counter kept" shape as `telemetry.js`'s own buffer discipline. */
const RING_MAX = 200;
/** Per-entry message cap — this is a debug aid, not a log-shipping pipeline;
 * a huge object dump must not make the ring itself heavy to hold or read. */
const MAX_MSG_LEN = 500;

const ring = [];

function readQueryDebugFlag () {
    try {
        if ( typeof location === 'undefined' || typeof URLSearchParams === 'undefined' ) return null;
        const qp = new URLSearchParams(location.search);
        return qp.get('ezilDebug') === '1' ? 'debug' : null;
    } catch {
        return null;
    }
}

function readStoredLevel () {
    try {
        if ( typeof localStorage === 'undefined' ) return null;
        const stored = localStorage.getItem('ezil.logLevel');
        return (stored && Object.hasOwn(LEVELS, stored)) ? stored : null;
    } catch {
        return null;
    }
}

function computeLevel () {
    return readQueryDebugFlag() ?? readStoredLevel() ?? DEFAULT_LEVEL;
}

let cachedLevel = null;

function currentLevel () {
    if ( cachedLevel === null ) cachedLevel = computeLevel();
    return cachedLevel;
}

/** Test/debug seam: re-read `localStorage`/the query string on the NEXT log
 * call, rather than trusting the value cached at first use. A real page
 * never needs this (the level is fixed for the page's lifetime); a test
 * harness that flips `localStorage` mid-run does. */
export function resetLevelCache () {
    cachedLevel = null;
}

function stringifyArg (v) {
    if ( typeof v === 'string' ) return v;
    if ( v instanceof Error ) return v.message ?? String(v);
    try { return JSON.stringify(v); } catch { return String(v); }
}

function pushRing (level, args) {
    const msg = args.map(stringifyArg).join(' ').slice(0, MAX_MSG_LEN);
    ring.push({ t: Date.now(), level, msg });
    if ( ring.length > RING_MAX ) ring.shift();
}

function make (level, consoleFn) {
    return (...args) => {
        // The ring buffer records EVERY call regardless of the active level —
        // it is the whole point of this module: a `debug()` call the console
        // never showed (level=info) can still be read back later.
        try { pushRing(level, args); } catch { /* never let logging throw */ }
        if ( LEVELS[level] >= LEVELS[currentLevel()] ) {
            try { consoleFn(...args); } catch { /* console itself must never throw upward */ }
        }
    };
}

const consoleDebug = (typeof console !== 'undefined' && typeof console.debug === 'function')
    ? console.debug.bind(console)
    : (typeof console !== 'undefined' ? console.log.bind(console) : () => {});
const consoleInfo = (typeof console !== 'undefined' && typeof console.info === 'function')
    ? console.info.bind(console)
    : (typeof console !== 'undefined' ? console.log.bind(console) : () => {});
const consoleWarn = (typeof console !== 'undefined' && typeof console.warn === 'function')
    ? console.warn.bind(console)
    : (typeof console !== 'undefined' ? console.log.bind(console) : () => {});
const consoleError = (typeof console !== 'undefined' && typeof console.error === 'function')
    ? console.error.bind(console)
    : (typeof console !== 'undefined' ? console.log.bind(console) : () => {});

export const debug = make('debug', consoleDebug);
export const info = make('info', consoleInfo);
export const warn = make('warn', consoleWarn);
export const error = make('error', consoleError);

/** A snapshot copy — callers can never mutate the live ring through this. */
export function ringBuffer () {
    return ring.slice();
}

export default { debug, info, warn, error, ringBuffer, resetLevelCache };
