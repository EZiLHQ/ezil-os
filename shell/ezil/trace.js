// trace.js — EZiL-authored. Not Puter code.
//
// Correlation ids + boot breadcrumbs for "what happened during this
// app-open" (`docs/telemetry-design.md` / the observability plan's W1).
//
// ── The problem this fixes ───────────────────────────────────────────────────
// `telemetry.js` has ~30 `capture()` call sites scattered across this shell,
// none of which carry a `correlationId` — so `/admin/telemetry` can show
// THAT a window failed to open, never the sequence of events that led there.
// And a cold boot's own phase timings (mint/confirm/display-equivalent) are
// currently nowhere: emitting one telemetry EVENT per phase would both spam
// the ingest pipeline and still not answer "how long did each phase take
// during THIS open" without a client-side join.
//
// ── The fix: one ambient trace per app-open, breadcrumbs, one boot_summary ──
// `beginTrace(name)` opens a trace and makes it "ambient" (module-level
// state, one at a time — see `ambientCorrelationId()`). `registry.js`'s
// `launch()` is the caller: it opens a trace when an app-open begins, calls
// `.step(code)` at the checkpoints IT can observe (app.open() resolving,
// the settings-drawer button being attached, etc.), and calls `.end(outcome)`
// exactly once when the open finishes or fails. `.end()` is idempotent — a
// second call is a no-op — so "exactly one boot_summary per app-open" holds
// even if a caller accidentally calls it twice.
//
// This module is deliberately PURE: it does not import `./telemetry.js` and
// does not call `capture()` itself. `end()` returns a plain summary object;
// the caller (`registry.js`) turns that into a `telemetry.capture({
// eventClass: 'boot_summary', ... })` call. Two reasons:
//   1. No circular import. `telemetry.js` DOES need something from this file
//      (see below), and a two-way dependency would make module-evaluation
//      order load-bearing in a way neither file's own header wants to own.
//   2. Testability. This file has zero dependencies and can be imported and
//      exercised directly under plain Node, no bundle, no jsdom — see
//      `trace-test.mjs`.
//
// ── Why `telemetry.js` imports FROM here, not the other way round ───────────
// `telemetry.js` used to define its own `newEventId()` (a `crypto.randomUUID`
// -> `getRandomValues` -> `Math.random` fallback chain, carrying a real
// secure-context fix — see that file's own history). This trace module needs
// the SAME uuid generator for a trace's `id` (which doubles as its
// `correlationId`), and the design brief is explicit: "do NOT write a second
// uuid generator". So the function moved HERE (its only home now) and
// `telemetry.js` imports it back. This makes `telemetry.js -> trace.js` the
// one direction of the dependency; this file never imports `telemetry.js`,
// so there is no cycle. `trace.js` has NO top-level side effects (no
// self-installing behaviour, unlike `telemetry.js`'s tail), so this does not
// disturb `boot.js`'s "telemetry.js must be the FIRST import" ordering
// requirement in the slightest — importing this file transitively costs
// nothing before `telemetry.js`'s own body runs.
//
// `telemetry.js`'s `capture()` also reads `ambientCorrelationId()` from here
// to default every call's `correlationId` — the single change that groups
// all ~30 existing capture sites (crash handlers, `window_error`,
// `contract_violation`, ...) under one app-open's trace without editing any
// of them.

const MAX_BREADCRUMBS = 24;
/** Matches `TELEMETRY_LIMITS.MAX_ATTR_STRING_LEN` (`app/src/server/telemetry/types.ts`)
 * — the wire cap on any `attrs` string value, including `attrs.phases`. */
const MAX_PHASES_STRING_LEN = 160;

function now () {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
        ? performance.now()
        : Date.now();
}

/**
 * A real RFC-4122 v4 uuid, always. Moved verbatim from `telemetry.js` — see
 * this file's header for why it lives here now.
 *
 * 🔴 `crypto.randomUUID` requires a SECURE CONTEXT — it is `undefined` on a
 * plain-http origin. The fallback chain below (`getRandomValues`, then
 * `Math.random`) is what keeps every id well-formed regardless, which matters
 * here for the SAME reason it matters for `telemetry.js`'s own event ids: a
 * malformed `correlationId` is bounded (`MAX_CORRELATION_ID_LEN`) but a
 * malformed trace `id` used as one would still just be an ugly string, not a
 * validation failure — there is no `.uuid()` requirement on `correlationId`
 * server-side. The fallback exists anyway so every id this shell mints is
 * uniformly well-formed, not because this ONE call site is validated.
 */
export function newEventId () {
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

/** The single active trace, module-level. One app-open at a time is the
 * honest shape: `launch()` is not reentrant for the SAME window (see
 * `registry.js`'s `single_instance` guard), and a nested/overlapping trace
 * simply replaces the ambient pointer — the outer trace's OWN `.step()`/
 * `.end()` calls still work fine against its own closure, it just stops
 * being what `ambientCorrelationId()` returns while a nested one is open. */
let ambientTrace = null;

/**
 * Open a new trace and make it ambient. Returns `{id, step, end}`.
 *
 * @param {string} name Short logical label, e.g. an app id (`'desktop'`).
 *   Becomes part of the `site` field when the caller builds its
 *   `boot_summary` event (`ezil-os:trace#<name>`).
 */
export function beginTrace (name) {
    const id = newEventId();
    const t0 = now();
    const breadcrumbs = [];
    let ended = false;

    const trace = {
        id,
        name: String(name ?? 'unknown'),

        /** Record one breadcrumb. Capped at `MAX_BREADCRUMBS` — additional
         * calls are silently dropped, same "oldest guarantee kept, never an
         * unbounded buffer" discipline `telemetry.js`'s own buffer uses,
         * except here it is FEWER crumbs accepted rather than the oldest
         * evicted, since breadcrumbs are read in order once at `.end()` and
         * the earliest phases are the ones most worth keeping. */
        step (code) {
            if ( ended || breadcrumbs.length >= MAX_BREADCRUMBS ) return;
            const t = Math.max(0, Math.round(now() - t0));
            const safeCode = String(code ?? '').trim().slice(0, 64) || 'step';
            breadcrumbs.push({ t, code: safeCode });
        },

        /**
         * Finalise the trace. Idempotent: a second call returns `null` and
         * does nothing — this is what makes "exactly one boot_summary per
         * app-open" hold even if a caller (bug, or a legitimate
         * belt-and-braces call from two code paths) calls `.end()` twice.
         *
         * @param {'ok'|'error'|'skipped'} [outcome]
         * @returns {{correlationId:string,name:string,outcome:string,totalMs:number,phases:string}|null}
         */
        end (outcome = 'ok') {
            if ( ended ) return null;
            ended = true;
            const totalMs = Math.max(0, Math.round(now() - t0));
            const safeOutcome = (outcome === 'ok' || outcome === 'skipped' || outcome === 'error') ? outcome : 'error';
            let phases = breadcrumbs.map((b) => `${b.code}:${b.t}`).join(',');
            if ( phases.length > MAX_PHASES_STRING_LEN ) phases = phases.slice(0, MAX_PHASES_STRING_LEN);
            if ( ambientTrace === trace ) ambientTrace = null;
            return { correlationId: id, name: trace.name, outcome: safeOutcome, totalMs, phases };
        },
    };

    ambientTrace = trace;
    return trace;
}

/** What `telemetry.js`'s `capture()` defaults `correlationId` to when a
 * caller does not supply one explicitly. `undefined` when no trace is open —
 * `capture()` already treats an absent `correlationId` as "omit the field",
 * so this never needs its own sentinel. */
export function ambientCorrelationId () {
    return ambientTrace ? ambientTrace.id : undefined;
}

/** Test/debug seam: the currently-ambient trace object itself, or `null`. */
export function ambientTraceRef () {
    return ambientTrace;
}

export default { beginTrace, ambientCorrelationId, ambientTraceRef, newEventId };
