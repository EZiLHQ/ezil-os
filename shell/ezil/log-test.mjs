// log-test.mjs — EZiL-authored. Plain-Node proof of `log.js` — a pure module
// (no bundle needed): default level, console gating, and the ring buffer.
//
// Run:  node shell/ezil/log-test.mjs
//
// 🔴 `log.js` binds `console.debug`/`.info`/`.warn`/`.error` ONCE, at module
// evaluation time (a real perf/robustness choice — see that file's own
// comment). That means a test that swaps `console.*` AFTER importing the
// module is testing nothing: the module already captured the old references.
// So every case below swaps `console.*` FIRST, then imports a FRESH module
// instance (a `?case=` query suffix busts Node's ESM module cache, exactly
// like `?v=` on a script tag) so the new instance binds to the mocked console.

let caseId = 0;
async function freshLogModule () {
    caseId += 1;
    return import(`./log.js?case=${caseId}`);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};

// 🔴 MUST be `async` and MUST `await fn(calls)` inside the `try` — a bare
// `return fn(calls)` hands back a pending promise while `finally` runs
// SYNCHRONOUSLY right away, restoring the real console before the async body
// (which does the dynamic `import()` that binds to whatever console is
// current AT THAT MOMENT) has actually run. Measured: without the `await`
// here, every case below silently ran against the REAL console instead of
// the mock, and printed straight to this script's own stdout.
async function withMockConsole (fn) {
    const calls = { debug: [], info: [], warn: [], error: [] };
    const orig = { debug: console.debug, info: console.info, warn: console.warn, error: console.error };
    console.debug = (...a) => calls.debug.push(a);
    console.info = (...a) => calls.info.push(a);
    console.warn = (...a) => calls.warn.push(a);
    console.error = (...a) => calls.error.push(a);
    try {
        await fn(calls);
    } finally {
        Object.assign(console, orig);
    }
}

// ── default level is "info" — NOTHING changes by default ────────────────────
await withMockConsole(async (calls) => {
    const mod = await freshLogModule();
    mod.debug('a debug message');
    mod.info('an info message');
    mod.warn('a warn message');
    mod.error('an error message');
    push('default level: debug() does NOT print to console', calls.debug.length === 0);
    push('default level: info() DOES print to console', calls.info.length === 1);
    push('default level: warn() DOES print to console', calls.warn.length === 1);
    push('default level: error() DOES print to console', calls.error.length === 1);
});

// ── the ring buffer records EVERY call, even ones the console gate suppressed ─
await withMockConsole(async () => {
    const mod = await freshLogModule();
    mod.debug('suppressed at default level, but must still be recorded');
    const ring = mod.ringBuffer();
    push('ringBuffer() recorded the debug() call the console never showed', ring.some((e) => e.level === 'debug' && e.msg.includes('suppressed at default level')));
});

// ── ringBuffer() returns a snapshot copy, not the live array ─────────────────
await withMockConsole(async () => {
    const mod = await freshLogModule();
    const a = mod.ringBuffer();
    const b = mod.ringBuffer();
    push('two ringBuffer() calls return different array instances', a !== b);
    a.push({ t: 0, level: 'debug', msg: 'mutated locally' });
    push('mutating a returned snapshot does not affect the next snapshot', ! mod.ringBuffer().some((e) => e.msg === 'mutated locally'));
});

// ── ?ezilDebug=1 raises the level to debug ───────────────────────────────────
await withMockConsole(async (calls) => {
    globalThis.location = { search: '?ezilDebug=1' };
    const mod = await freshLogModule();
    mod.debug('now visible');
    push('?ezilDebug=1 makes debug() print to console', calls.debug.length === 1);
    delete globalThis.location;
});

// ── localStorage['ezil.logLevel'] also raises/lowers the level ──────────────
await withMockConsole(async (calls) => {
    globalThis.localStorage = { getItem: (k) => (k === 'ezil.logLevel' ? 'warn' : null) };
    const mod = await freshLogModule();
    mod.info('should be suppressed at level=warn');
    mod.warn('should print at level=warn');
    push('localStorage level=warn suppresses info()', calls.info.length === 0);
    push('localStorage level=warn still prints warn()', calls.warn.length === 1);
    delete globalThis.localStorage;
});

// ── ?ezilDebug=1 wins over a stricter stored level (a shared debug link works) ─
await withMockConsole(async (calls) => {
    globalThis.location = { search: '?ezilDebug=1' };
    globalThis.localStorage = { getItem: (k) => (k === 'ezil.logLevel' ? 'error' : null) };
    const mod = await freshLogModule();
    mod.debug('should still be visible — query wins');
    push('?ezilDebug=1 overrides a stricter localStorage level', calls.debug.length === 1);
    delete globalThis.location;
    delete globalThis.localStorage;
});

// ── an invalid stored level is IGNORED, not crashed on, falling back to info ─
await withMockConsole(async (calls) => {
    globalThis.localStorage = { getItem: () => 'not-a-real-level' };
    let threw = false;
    let mod;
    try {
        mod = await freshLogModule();
        mod.info('x');
        mod.debug('y');
    } catch { threw = true; }
    push('an invalid stored level never throws', ! threw);
    push('an invalid stored level falls back to the "info" default', calls.info.length === 1 && calls.debug.length === 0);
    delete globalThis.localStorage;
});

// ── never throws with no browser globals at all ──────────────────────────────
await withMockConsole(async () => {
    const mod = await freshLogModule();
    let threw = false;
    try {
        for ( let i = 0; i < 100; i++ ) { mod.debug('x'); mod.info('x'); mod.warn('x'); mod.error(new Error('boom')); }
    } catch { threw = true; }
    push('100x debug/info/warn/error calls with no window/localStorage/location never throws', ! threw);
});

// ── resetLevelCache() lets a later call re-read the level (test/debug seam) ──
await withMockConsole(async (calls) => {
    const mod = await freshLogModule();
    mod.debug('before: suppressed at default info level');
    push('before resetLevelCache(): debug() suppressed', calls.debug.length === 0);
    globalThis.localStorage = { getItem: (k) => (k === 'ezil.logLevel' ? 'debug' : null) };
    mod.resetLevelCache();
    mod.debug('after: should now print');
    push('after resetLevelCache() + a debug-level localStorage: debug() prints', calls.debug.length === 1);
    delete globalThis.localStorage;
});

console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
if ( checks.some((c) => ! c.pass) ) process.exit(1);
