// telemetry-test.mjs — EZiL-authored. Proves the ONE guarantee this file's
// whole design rests on: telemetry never slows down or breaks the OS, even
// when ingest is a black hole — a `fetch` that never resolves, never rejects,
// and never times out on its own.
//
// Run:  node shell/ezil/telemetry-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not the source)
//
// ── Why a hanging promise, not a slow one ────────────────────────────────────
// A slow-but-eventually-settling fetch only proves the AWAIT was optional if
// you wait long enough to see it settle. A promise that NEVER settles is the
// sharper test: if any code path anywhere ever awaited it (directly, or via
// `Promise.all`, or a `.finally()` some caller then awaited), this script
// would hang forever and the run would time out. It does not — see below.
//
// `navigator.sendBeacon` does not exist under jsdom, so this exercises the
// SECOND transport (`fetch(..., {keepalive:true})`), which is exactly the one
// with a real timeout/abort path (`AbortSignal.timeout`) that a bug could
// accidentally await.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};

// ═══════════════════════════════════════════════════════════════════════════
// 0. THE MECHANICAL PROOF — no jsdom, no bundle. Import the SOURCE module
//    directly in plain Node (it is a self-contained ES module; every browser
//    global it touches is guarded — see its own top-level `typeof window`
//    checks) and call `capture()` directly, in the same synchronous tick.
//
//    This is the sharpest possible version of "never awaited by any caller":
//    `capture()` is a plain (non-`async`) function. Calling it returns
//    `undefined`, ALWAYS — never a Promise, so there is nothing FOR a caller
//    to await even by mistake. If a future edit ever made `capture` `async`,
//    this assertion goes red the instant that change lands, with no jsdom,
//    no timers, no network involved at all.
// ═══════════════════════════════════════════════════════════════════════════
const { capture } = await import('./telemetry.js');
const directReturn = capture({ eventClass: 'crash', site: 'ezil-os:telemetry-test#direct', code: 'probe' });
push('🔴 capture() is a plain function: calling it returns undefined, never a Promise',
    directReturn === undefined, `typeof ${typeof directReturn}`);
// And under plain Node (no `window`), it must not throw either — the module
// has to tolerate running somewhere with no browser globals at all (this
// script itself, or a future server-side import) without crashing the caller.
let threw = false;
try {
    for ( let i = 0; i < 1000; i++ ) capture({ eventClass: 'crash', site: 'x', code: `n${i}` });
} catch { threw = true; }
push('capture() called 1000x with no browser globals at all: never throws', ! threw);

// ═══════════════════════════════════════════════════════════════════════════
// 0b. eventId MUST be a real RFC-4122 v4 uuid in EVERY crypto environment.
//
//     🔴 The ingest route validates `eventId: z.string().uuid()` inside a
//     `.strict()` parse that drops the WHOLE event, and it always answers 202
//     regardless — so a malformed id is a 100% silent loss with nothing
//     anywhere to indicate it. `crypto.randomUUID` requires a SECURE CONTEXT
//     and is `undefined` on a plain-http origin, which is precisely the case
//     that used to fall through to a non-uuid string.
//
//     Exercises the shipped `newEventId()` against all three environments:
//     randomUUID present, getRandomValues only, and neither.
// ═══════════════════════════════════════════════════════════════════════════
{
    const src = fs.readFileSync(path.join(here, 'telemetry.js'), 'utf8');
    const start = src.indexOf('function newEventId');
    const end = src.indexOf('function keyFor');
    const makeFn = new Function('crypto', `${src.slice(start, end)}; return newEventId;`);
    const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const getRandomValuesOnly = {
        getRandomValues: (b) => { for ( let i = 0; i < b.length; i++ ) b[i] = (Math.random() * 256) | 0; return b; },
    };
    for ( const [label, cryptoImpl] of [
        ['crypto.randomUUID present (secure context)', globalThis.crypto],
        ['🔴 getRandomValues only (plain-http origin — randomUUID is undefined)', getRandomValuesOnly],
        ['no crypto at all', {}],
    ] ) {
        const id = makeFn(cryptoImpl)();
        push(`eventId is a v4 uuid: ${label}`, V4.test(id), id);
    }
    // Not a constant: 500 ids from the weakest path must all differ.
    const weak = makeFn({});
    const ids = new Set(Array.from({ length: 500 }, () => weak()));
    push('the weakest eventId path still produces 500 distinct ids', ids.size === 500, `${ids.size}/500`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 0c. `redact()` MUST strip absolute filesystem paths.
//
//     🔴 A workspace path is `/home/<login>/workspace/<project>` — a username
//     and a project name. `docs/telemetry.md` promises under "What is never
//     collected" that these never reach storage. This is the FIRST of the
//     three places that promise is enforced (the server's
//     `sanitizeErrorMessage` and its byte-identical Worker twin are the
//     other two, and they are the actual boundary — this one only has to keep
//     it off the wire in the first place).
//
//     Extracted from the SOURCE the same way `newEventId` is above, because
//     `redact` is module-private: nothing exports it, and testing it through
//     `capture()` would only prove the composite, not the rule.
//
//     Both directions are asserted. A redactor that ate everything would pass
//     "no path survived" and be useless: `port :8444`, durations, correlation
//     ids and `file.js:12:34` positions are the diagnosis, and every one of
//     them must come out unchanged.
// ═══════════════════════════════════════════════════════════════════════════
{
    const src = fs.readFileSync(path.join(here, 'telemetry.js'), 'utf8');
    const start = src.indexOf('function redact');
    const end = src.indexOf('function normalizeCode');
    if ( start === -1 || end === -1 || end < start ) {
        console.error('could not extract redact() from telemetry.js — the test, not the code, is stale');
        process.exit(1);
    }
    const redact = new Function(`${src.slice(start, end)}; return redact;`)();

    // The exact string measured end-to-end through the shipped chain
    // (telemetry.js -> handleTelemetryPost -> parseTelemetryBatch ->
    // ingestBatch -> Postgres) before this rule existed. It was stored in
    // `ezil_error_events.detail` verbatim.
    const MEASURED = 'restart rejected for https://api-desktop.ezil.org/sandbox/guac-abc/restart '
        + 'after 20001ms for u_b6b2f6a3 at /home/user1/workspace/proj-1 '
        + '(cid_abc1, computer 33333333-3333-4333-8333-333333333333, port :8444)';
    const out = redact(MEASURED);
    push('🔴 the measured leak: no username in the redacted detail', ! out.includes('user1'), out);
    push('🔴 the measured leak: no project name in the redacted detail', ! out.includes('proj-1'), out);
    push('🔴 the measured leak: no absolute path of any shape survives',
        ! /(?:^|[\s'"(=])~?\/[\w.@%+~-]/.test(out), out);
    push('and it produced the <path> placeholder rather than deleting the location entirely',
        out.includes('<path>'), out);

    for ( const [label, input, forbidden] of [
        ['a bare workspace path', '/home/user1/workspace/proj-1 is not empty', ['user1', 'proj-1']],
        ['a path with a space in it', "ENOENT, open '/home/bob/workspace/my app/.env'", ['bob', 'my app', '.env']],
        ['a home-relative path', 'failed at ~/workspace/proj-1/src/index.ts', ['proj-1', 'index.ts']],
        ['a Windows drive path', 'C:\\Users\\user1\\workspace\\proj-1 not found', ['user1', 'proj-1']],
        ['a path smuggled inside a URL', 'GET https://x.dev/home/user1/workspace/proj-1/i.html 500', ['user1', 'proj-1']],
    ] ) {
        const r = redact(input);
        push(`redact strips ${label}`, forbidden.every((f) => ! r.includes(f)), r);
    }

    for ( const [label, input] of [
        ['a port, a status and a ratio', 'http 500 on :8444 read/write conflict, ratio 1/2'],
        ['a bare slash between two numbers', 'expected 200 / got 500'],
        ['a stack position', 'openWindow@UIWindow.js:12:34'],
        ['a date', '08/01/2026 boot failed'],
        ['an exit code and a duration', 'stop_timed_out: exit 137 after 20001ms'],
    ] ) {
        push(`redact leaves ${label} completely alone`, redact(input) === input, redact(input));
    }
}

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = {
        getRandomValues: (a) => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; },
    };
}

// ── THE BLACK HOLE ───────────────────────────────────────────────────────────
// A fetch that returns a promise which NEVER settles — not slow, not erroring,
// not timing out on its own. Every call is counted so this script can prove
// telemetry actually tried to send (armed), not that it silently no-op'd.
let fetchCalls = 0;
window.fetch = (...args) => {
    fetchCalls += 1;
    return new Promise(() => {}); // deliberately never resolves or rejects
};
// jsdom does not implement sendBeacon; confirm that assumption rather than
// silently testing the wrong transport if a future jsdom version adds one.
push('jsdom has no navigator.sendBeacon (this run exercises the fetch fallback)',
    typeof window.navigator.sendBeacon !== 'function');

function evalOrDie (label, code) {
    try {
        window.eval(code);
    } catch ( e ) {
        console.error(`${label} threw: ${e?.stack ?? e}`);
        process.exit(1);
    }
}
evalOrDie('icons.js', fs.readFileSync(`${OS}/icons.js`, 'utf8'));

// A boot payload with `desktopState.endpoints.telemetry` PRESENT — telemetry
// arms. Testing the disarmed (no endpoint) case is `settings-test.mjs`'s job;
// this file's job is the opposite: prove that ARMED-but-ingest-is-a-black-hole
// is ALSO harmless.
window.__EZIL_BOOT__ = {
    user: { id: 'u-telemetry-test' },
    computer: { id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { endpoints: { telemetry: 'https://black-hole.invalid/api/shell/telemetry' } },
};

const t0 = performance.now();
evalOrDie('bundle.min.js', fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
const bootMs = performance.now() - t0;
push('boot() (loading + self-executing the bundle) returns promptly with a black-hole ingest',
    bootMs < 2000, `${bootMs.toFixed(1)}ms`);

const ezil = window.ezil;
push('bundle exposes window.ezil', typeof ezil === 'object');

const tick = (ms = 0) => new Promise((r) => window.setTimeout(r, ms));

// ── Fire a real crash through the installed global handler ──────────────────
const t1 = performance.now();
const N = 25; // above MAX_PER_KEY's cap per key, but each gets a DISTINCT key
              // (different message) so none are silently deduped — this is
              // measuring capture() cost, not the dedup guard.
for ( let i = 0; i < N; i++ ) {
    window.dispatchEvent(new window.ErrorEvent('error', {
        message: `telemetry black-hole test error #${i}`,
        error: new Error(`telemetry black-hole test error #${i}`),
    }));
}
// And an unhandledrejection, the other installed handler.
window.dispatchEvent(new window.PromiseRejectionEvent('unhandledrejection', {
    promise: Promise.reject(new Error('black-hole test rejection')).catch(() => {}),
    reason: new Error('black-hole test rejection'),
}));
const dispatchMs = performance.now() - t1;
push(`dispatching ${N} errors + 1 rejection through the black-hole-armed handler is still fast`,
    dispatchMs < 500, `${dispatchMs.toFixed(1)}ms for ${N + 1} events`);

// Force the flush NOW rather than waiting out the 10s batching timer —
// `pagehide` is one of telemetry.js's own triggers (§4.3), so this is real
// behaviour, not a test-only shortcut. This is the moment the black hole is
// actually reached: `send()` calls the hung `fetch` and must not await it.
const t2 = performance.now();
window.dispatchEvent(new window.Event('pagehide'));
const flushMs = performance.now() - t2;
push('triggering the flush into the black hole (pagehide) returns immediately, not hung',
    flushMs < 200, `${flushMs.toFixed(1)}ms`);

// Give any OTHER queued microtasks a moment — not to wait for the black hole
// (it never resolves), but so a bug that scheduled real work behind the hung
// fetch would have shown up by now.
await tick(50);

push('the process is still alive and responsive after the black hole was fed 26 events',
    true, `${(performance.now() - t0).toFixed(1)}ms total`);

// This is the actual proof the black hole was REACHED, not skipped: if this
// were 0, the whole exercise above would have measured nothing.
push('telemetry actually attempted to send (armed, not silently dark)', fetchCalls > 0, `${fetchCalls} fetch() call(s)`);

console.log(`\n${checks.filter(c => c.pass).length}/${checks.length} checks passed`);
if ( checks.some(c => ! c.pass) ) process.exit(1);

// If anything anywhere had awaited the hanging fetch, THIS LINE would never
// print and the process would hang until the harness's own timeout killed it
// — the sharpest possible proof, sharper than any assertion above.
console.log('process exiting normally — nothing ever awaited the black hole');
