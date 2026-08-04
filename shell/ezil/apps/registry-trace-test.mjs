// registry-trace-test.mjs — EZiL-authored. End-to-end proof that
// `registry.js#launch()` produces exactly one `boot_summary` telemetry event
// per app-open, carrying an ordered phase string and a real correlation id —
// against the SHIPPED bundle in a DOM, not the source in isolation (see
// `settings-test.mjs`'s own header for why this project insists on that).
//
// Run:  node shell/ezil/apps/registry-trace-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not the source)
//
// ── 🔴 Sections 1-3 did not, and could not, catch the Y1 defect ─────────────
// `settings` (the only app these first three sections ever open) is
// SYNCHRONOUS: `openSettingsWindow`'s promise does not resolve until the
// window is fully built, and nothing it does continues afterward. Ending the
// trace the instant `open()` resolves is therefore, for `settings`, exactly
// right — which is precisely how a registry that ends every trace at that
// moment sailed through this whole file for a whole task's worth of green
// runs while `desktop`/`preview`/`code` (all fire-and-forget: `open()`
// returns the moment `UIWindow()` exists, and `void start_boot()` runs the
// real mint/confirm/display work afterward, unawaited) each shipped with a
// trace that closed its books before the boot it was supposed to measure had
// even started.
//
// Sections 4-6 below open `preview` instead — same fire-and-forget shape as
// `desktop`, but without `desktop`'s own extra display-gate machinery, so the
// mint + frame-confirm round trip is the whole story and easy to drive by
// hand through a stubbed `window.fetch` (same technique as
// `preview-focus-test.mjs`). There is no seam in `registry.js` for injecting
// a literal fake app into `APPS`, and a fake one would risk exactly the
// "its `open()` happened to be synchronous" accident that let this bug
// through in the first place — a REAL async app is the only honest fixture.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../app/public/os');

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

// ── controllable stub state for sections 4-7 (the ASYNC-app trace lifecycle) ─
// Defaults are "everything resolves immediately and successfully", so
// sections 1-3 below (which only ever open `settings`, and never hit any of
// these routes) are completely unaffected by any of this.
let previewMintGate = Promise.resolve();
let previewMintMode = 'ok'; // 'ok' | 'error'
let confirmFrameAnswer = true;
let desktopMintGate = Promise.resolve();
let desktopMintMode = 'ok'; // 'ok' | 'error'
let desktopFrameConfirmedByServer = true; // `res.frameConfirmed`, in `openDesktop`'s own response
let confirmDisplayAnswer = 'live'; // 'live' | 'blank' | 'unknown'

const json = (payload, status = 200) => ({
    ok: status < 400, status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
});

// Every telemetry POST this run makes, in order, body already JSON-parsed.
const sent = [];
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    if ( u.includes('telemetry') ) {
        try { sent.push(JSON.parse(opts.body)); } catch { /* ignore parse errors here */ }
        return json({}, 202);
    }
    // `preview.js`'s mint — held open by `previewMintGate` so section 4/6 can
    // measure/exploit exactly how long it stays in flight.
    if ( u.startsWith('/api/shell/preview-url') ) {
        await previewMintGate;
        if ( previewMintMode === 'error' ) return json({ ok: false, errorCode: 'unknown' });
        return json({
            ok: true,
            appPreviewUrl: 'https://3002-guac-trace-test.ezil.org/preview-bootstrap?token=t=1,v1=deadbeef',
            expiresAt: Date.now() + 300_000,
        });
    }
    // `desktop-window.js`'s mint (via `warm.js#claim` on the FIRST attempt,
    // which — for a computer id never warmed before — just calls
    // `session.openDesktop` directly, same as any retry), and the two
    // post-handoff questions it asks afterward, all share this one route.
    if ( u.startsWith('/api/shell/desktop') ) {
        if ( (opts.method ?? 'GET') === 'POST' ) {
            await desktopMintGate;
            if ( desktopMintMode === 'error' ) return json({ ok: false, errorCode: 'unknown' });
            return json({
                ok: true, guacamoleUrl: 'https://8181-guac-trace-test.ezil.org/',
                controlMode: 'interactive', mode: 'neko',
                frame: { confirmed: desktopFrameConfirmedByServer },
            });
        }
        // `session.confirmFrame` — the post-handoff question `settle_frame`
        // asks (shared verbatim between `desktop-window.js` and `preview.js`).
        if ( u.includes('confirm=frame') ) return json({ ok: true, confirmed: confirmFrameAnswer });
        // `session.confirmDisplay` — `desktop-window.js`'s OWN second gate;
        // `preview.js` has no equivalent.
        if ( u.includes('confirm=display') ) return json({ ok: true, display: confirmDisplayAnswer });
        // `session.desktopRunning` — the cheap mid-boot poll. Never claims running.
        return json({ ok: true, guacamoleRunning: false });
    }
    return json({}, 202);
};

function evalOrDie (label, code) {
    try {
        window.eval(code);
    } catch ( e ) {
        console.error(`${label} threw: ${e?.stack ?? e}`);
        process.exit(1);
    }
}
evalOrDie('icons.js', fs.readFileSync(`${OS}/icons.js`, 'utf8'));
evalOrDie('bundle.min.js', fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));

const ezil = window.ezil;
push('bundle exposes window.ezil', typeof ezil === 'object');
// `ezil.boot()` runs with NO `window.__EZIL_BOOT__` set — a deliberate no-op
// (same technique `settings-test.mjs` uses), so nothing auto-opens and
// telemetry is not yet armed while we set up the harness below.
ezil.boot();

const tick = (ms = 0) => new Promise((r) => window.setTimeout(r, ms));
const settle = async (n = 8, ms = 20) => { for ( let i = 0; i < n; i++ ) await tick(ms); };

/** Force telemetry.js's own batching timer to flush NOW, via the same
 * `pagehide` trigger `telemetry-test.mjs`'s black-hole test uses. */
function forceFlush () {
    window.dispatchEvent(new window.Event('pagehide'));
}

function bootSummaries () {
    return sent.flatMap((batch) => batch.events ?? []).filter((e) => e.eventClass === 'boot_summary');
}

// Arm telemetry NOW, mid-run — exactly how a real page's boot payload would
// already be present before this bundle's first line runs; done here so the
// harness controls exactly when it starts observing sends.
window.__EZIL_BOOT__ = {
    user: { id: 'u-trace-test' },
    desktopState: { endpoints: { telemetry: 'https://telemetry.invalid/api/shell/telemetry' } },
};

const ctx = {
    payload: window.__EZIL_BOOT__,
    computer: { id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    desktopState: {},
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. ONE app-open -> exactly ONE boot_summary, ordered phases, real correlation id.
// ═══════════════════════════════════════════════════════════════════════════
await ezil.registry.launch('settings', ctx);
await settle();
forceFlush();
await settle(4);

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
{
    const summaries = bootSummaries();
    push('🔴 exactly one boot_summary event was sent for one app-open', summaries.length === 1, `${summaries.length} sent`);
    const s = summaries[0];
    if ( s ) {
        push('boot_summary carries source: shell', s.source === 'shell');
        push('boot_summary carries a v4-uuid correlationId', typeof s.correlationId === 'string' && V4.test(s.correlationId), s.correlationId);
        push('boot_summary outcome is "ok" for a successful open', s.outcome === 'ok', s.outcome);
        push('boot_summary code is a valid [a-z0-9_]+ token', /^[a-z0-9_]+$/.test(s.code), s.code);
        push('boot_summary site names the app via ezil-os:trace#<id>', s.site === 'ezil-os:trace#settings', s.site);
        push('🔴 attrs.phases is a non-empty ORDERED "code:ms,code:ms" string', typeof s.attrs?.phases === 'string' && /^[a-z0-9_]+:\d+(,[a-z0-9_]+:\d+)*$/.test(s.attrs.phases), s.attrs?.phases);
        const codes = (s.attrs?.phases ?? '').split(',').map((p) => p.split(':')[0]);
        push('phases include launch_start then open_resolved, in that order', codes.indexOf('launch_start') === 0 && codes.includes('open_resolved') && codes.indexOf('launch_start') < codes.indexOf('open_resolved'), JSON.stringify(codes));
        push('attrs.total_ms is present and non-negative', typeof s.attrs?.total_ms === 'number' && s.attrs.total_ms >= 0, s.attrs?.total_ms);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. REOPENING an already-open window (refocus branch) must NOT mint a second
//    trace/boot_summary — it is the same window, nothing "opened" again.
// ═══════════════════════════════════════════════════════════════════════════
sent.length = 0;
await ezil.registry.launch('settings', ctx); // already open -> refocus branch
await settle();
forceFlush();
await settle(4);
push('reopening an already-open (single_instance) window sends NO additional boot_summary', bootSummaries().length === 0, `${bootSummaries().length} sent`);

// ═══════════════════════════════════════════════════════════════════════════
// 3. 🔴 boot_summary is EXEMPT from telemetry.js's MAX_PER_KEY=3 dedup.
//    Every open below shares the exact same (eventClass, site, code) key —
//    without the exemption in `telemetry.js`'s `capture()`, the 4th open's
//    boot_summary would be silently dropped. Closing and reopening 4 times
//    in one page life must still produce 4 boot_summary events.
// ═══════════════════════════════════════════════════════════════════════════
sent.length = 0;
for ( let i = 0; i < 4; i++ ) {
    window.$('.window[data-app="settings"]').close();
    await settle(2);
    await ezil.registry.launch('settings', ctx);
    await settle(2);
}
forceFlush();
await settle(4);
push('🔴 4 same-key app-opens in one page life still produce 4 boot_summary events (MAX_PER_KEY=3 exemption)', bootSummaries().length === 4, `${bootSummaries().length} sent`);

/** Poll the DOM for `preview`'s iframe once it has been navigated away from `about:blank`. */
async function waitForPreviewIframe (tries = 60, ms = 20) {
    for ( let i = 0; i < tries; i++ ) {
        const el = window.document.querySelector('.window[data-app="preview"] .window-app-iframe');
        if ( el && el.getAttribute('src') !== 'about:blank' ) return el;
        await tick(ms);
    }
    return null;
}

const previewCtx = {
    computer: { id: 'c-trace', name: 'Trace computer', slot: 2, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    // `preview.js` reads `configured` straight off `ctx.desktopState` — see
    // `openPreviewWindow`'s own destructure. Nothing else in this ctx needs
    // an `endpoints` map: `session.previewUrl`/`confirmFrame` fall back to
    // their own default mirror (`ENDPOINTS` in `session.js`) when the boot
    // payload (`window.__EZIL_BOOT__`, set once above) does not carry one —
    // exactly the routes this file's `window.fetch` stub already answers.
    desktopState: { configured: true },
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. 🔴 THE Y1 DEFECT ITSELF — an ASYNC app's `boot_summary` must span the
//    REAL open, not just `open()`'s promise resolving.
//
//    MUTATION PROOF (revert `registry.js`'s `owns_boot_trace` skip — i.e. go
//    back to always `emitBootSummary(trace.end(el_window ? 'ok' : 'skipped'))`
//    the instant `app.open()` resolves): the FIRST assertion below goes red
//    immediately — a summary is sent the moment the window exists, with the
//    mint still held open — and every other assertion in this section goes
//    red behind it (`durationMs` collapses to a few ms; `attrs.phases` never
//    gets `mint_ok`/`confirm_ok` because the trace closed before `preview.js`
//    ever recorded them).
// ═══════════════════════════════════════════════════════════════════════════
sent.length = 0;
let releaseMint;
previewMintGate = new Promise((r) => { releaseMint = r; });
previewMintMode = 'ok';
confirmFrameAnswer = true;

const t_launch = Date.now();
const el_preview = await ezil.registry.launch('preview', previewCtx);
await settle(2);
// `telemetry.js` batches — a `capture()` call does not itself reach `sent`
// until a flush happens. `forceFlush()` here is what makes "no boot_summary
// exists yet" an honest read of whether the trace has ended, rather than an
// artefact of the batching timer not having fired yet (which would read as
// "0 sent" whether or not the bug is present, and prove nothing).
forceFlush();
await settle(2);

push('🔴 THE FIX: `open()` resolving does NOT close the trace for an async app',
    !! el_preview && bootSummaries().length === 0,
    `window=${!! el_preview} summaries-at-open-resolve=${bootSummaries().length}`);

// Hold the mint open for a real, measurable stretch — the "N ms" the
// acceptance criterion asks `durationMs` to land within ~10% of.
const HOLD_MS = 2_000;
await tick(HOLD_MS);
forceFlush();
await settle(2);
push('...and it is STILL open a full 2s later — nothing ended it early',
    bootSummaries().length === 0, `${bootSummaries().length} sent`);

releaseMint();
const iframe = await waitForPreviewIframe();
push('the mint landed and navigated the iframe', !! iframe, iframe?.getAttribute('src'));
iframe?.dispatchEvent(new window.Event('load'));
await settle(6);
const measured_ms = Date.now() - t_launch;
forceFlush();
await settle(4);

{
    const summaries = bootSummaries().filter((s) => s.site === 'ezil-os:trace#preview');
    push('🔴 exactly one boot_summary for the async preview open', summaries.length === 1, `${summaries.length} sent`);
    const s = summaries[0];
    if ( s ) {
        // Generous slack (not a bare 10%) for jsdom/timer jitter in a shared
        // CI box — the point being proven is "hundreds of ms, tracking the
        // real wait", not "collapsed to single-digit ms" (measured before
        // this fix: 22ms/12ms for real opens of 11150ms/3631ms).
        const within = Math.abs((s.attrs?.total_ms ?? 0) - measured_ms) <= measured_ms * 0.2 + 100;
        push('🔴 durationMs reflects the REAL open (the held mint + confirm), tracking measured wall time',
            within, `total_ms=${s.attrs?.total_ms} measured=${measured_ms}ms`);
        push('outcome is "ok" for a boot that actually succeeded', s.outcome === 'ok', s.outcome);
        push('🔴 attrs.phases carries REAL mint/confirm stage timings, not just registry bookkeeping',
            /(^|,)mint_ok:\d+(,|$)/.test(s.attrs?.phases ?? '') && /(^|,)confirm_ok:\d+(,|$)/.test(s.attrs?.phases ?? ''),
            s.attrs?.phases);
        push('correlationId is a real v4 uuid', typeof s.correlationId === 'string' && V4.test(s.correlationId), s.correlationId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. 🔴 A FAILING boot: `outcome != 'ok'`, AND the error captured MID-BOOT
//    carries the SAME correlationId as that open's boot_summary.
//
//    This is the literal defect measured in the task brief: a jsdom run
//    against a failing mint produced `boot_summary code=ok` beside
//    `api_failure ... corr=ABSENT` — the trace had already closed (and
//    nulled the ambient pointer) before the failure was ever captured.
//
//    MUTATION PROOF: revert the fix and the failure capture below runs AFTER
//    `registry.js` already ended the trace at `open()`-resolve time, so
//    `ambientCorrelationId()` is `undefined` when it fires — the SECOND
//    assertion (a real v4 uuid on the captured error) goes red, and with it
//    the THIRD (same id as the summary). The FIRST assertion (outcome !=
//    'ok') goes red too: the summary was already sent as `'ok'` well before
//    `confirmFrame` ever answered.
// ═══════════════════════════════════════════════════════════════════════════
window.$('.window[data-app="preview"]').close();
await settle(2);
sent.length = 0;
previewMintGate = Promise.resolve();
previewMintMode = 'ok';
confirmFrameAnswer = false; // the origin never confirms as a desktop

await ezil.registry.launch('preview', previewCtx);
await settle(2);
const iframe2 = await waitForPreviewIframe();
iframe2?.dispatchEvent(new window.Event('load'));
await settle(6);
forceFlush();
await settle(4);

{
    const events = sent.flatMap((b) => b.events ?? []);
    const summaries = events.filter((e) => e.eventClass === 'boot_summary' && e.site === 'ezil-os:trace#preview');
    const failures = events.filter((e) => e.eventClass === 'display_failure' && e.site === 'ezil-os:apps/preview#confirmFrame');
    push('a display_failure event was captured mid-boot', failures.length === 1, `${failures.length} sent`);
    push('exactly one boot_summary for the failed open', summaries.length === 1, `${summaries.length} sent`);
    const s = summaries[0];
    const f = failures[0];
    push('🔴 the failed boot_summary outcome is NOT "ok"', !! s && s.outcome !== 'ok', s?.outcome);
    push('🔴 the mid-boot error carries a REAL correlationId (measured before this fix: ABSENT)',
        typeof f?.correlationId === 'string' && V4.test(f.correlationId), f?.correlationId);
    push('🔴 …and it is the SAME correlationId as this open\'s boot_summary',
        !! s && !! f && s.correlationId === f.correlationId, `${s?.correlationId} vs ${f?.correlationId}`);
}
window.$('.window[data-app="preview"]').close();
await settle(2);

// ═══════════════════════════════════════════════════════════════════════════
// 6. 🔴 THE BOUNDED FALLBACK — a forgetful app must not leak a never-ended
//    trace. `previewMintGate` here never resolves, so `preview.js`'s
//    `start_boot()` never reaches ANY of its own terminal points; nothing but
//    `registry.js`'s own fallback timer can close this trace.
//
//    Sped up by intercepting ONLY `setTimeout` calls scheduled at EXACTLY
//    `registry.js`'s `TRACE_FALLBACK_TIMEOUT_MS` — every other timer in this
//    bundle (`TICK_MS`, `POLL_MS`, the frame-confirm retry/fallback) keeps
//    its real delay, so this is a surgical time-skip, not a global
//    fast-forward that would also collapse the wait this section is
//    supposed to be proving is bounded rather than instant.
//
//    🔴 The literal number below MUST be kept in sync with `registry.js`'s
//    own `TRACE_FALLBACK_TIMEOUT_MS` export by hand — this harness evals the
//    SHIPPED, minified bundle (see the file header for why) rather than
//    importing the source module, so there is no single place both read it
//    from. If this assertion ever goes red for no other reason, check that
//    number FIRST.
//
//    MUTATION PROOF: revert the `if (app.owns_boot_trace && el_window)`
//    fallback-arming block in `registry.js#launch` and this section's
//    summary count stays 0 forever (no assertion here waits out real minutes
//    to find that out — it fails within this file's normal `settle()` budget).
// ═══════════════════════════════════════════════════════════════════════════
const TRACE_FALLBACK_TIMEOUT_MS = 240_000;
const real_setTimeout = window.setTimeout.bind(window);
window.setTimeout = (fn, ms, ...args) => {
    if ( ms === TRACE_FALLBACK_TIMEOUT_MS ) return real_setTimeout(fn, 0, ...args);
    return real_setTimeout(fn, ms, ...args);
};

sent.length = 0;
previewMintGate = new Promise(() => {}); // never resolves — the forgetful app
previewMintMode = 'ok';

await ezil.registry.launch('preview', previewCtx);
await settle(6);
forceFlush();
await settle(4);

{
    const summaries = bootSummaries().filter((s) => s.site === 'ezil-os:trace#preview');
    push('🔴 a boot stuck forever still gets exactly one boot_summary (the bounded fallback fired)',
        summaries.length === 1, `${summaries.length} sent`);
    push('🔴 …reported as "error" (never "ok", never silently dropped — OUTCOMES has no 4th value)',
        summaries[0]?.outcome === 'error', summaries[0]?.outcome);
    push('🔴 …and attrs.phases shows the app NEVER got as far as its own mint step (this really is the fallback, not a fast real mint_error)',
        ! /mint_/.test(summaries[0]?.attrs?.phases ?? ''), summaries[0]?.attrs?.phases);
}

window.setTimeout = real_setTimeout;
window.$('.window[data-app="preview"]').close();
await settle(2);

// ═══════════════════════════════════════════════════════════════════════════
// 7. 🔴 THE VERBATIM MEASURED DEFECT — `desktop`, not just `preview`.
//
//    The task brief measured this bug on REAL desktop opens of 11150ms and
//    3631ms, each producing `durationMs=22`/`12` — `desktop-window.js` has
//    its OWN extra display-gate phase `preview.js`/`code.js` do not, so this
//    section exists to prove the fix holds for that richer shape too, not
//    only for the two structurally-simpler siblings sections 4-6 already
//    cover. `desktop` reaches `frameConfirmed: true` from the mint itself, so
//    `settle_frame`'s `seen === true` hands off to `start_display_gate`,
//    whose OWN `'live'` verdict is what actually ends the trace here — a
//    third distinct code path from anything sections 4-6 exercised.
// ═══════════════════════════════════════════════════════════════════════════
const desktopCtx = {
    computer: { id: 'c-trace-desktop', name: 'Trace desktop', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false },
    desktopState: { configured: true },
};

sent.length = 0;
let releaseDesktopMint;
desktopMintGate = new Promise((r) => { releaseDesktopMint = r; });
desktopMintMode = 'ok';
desktopFrameConfirmedByServer = true;
confirmFrameAnswer = true;
confirmDisplayAnswer = 'live';

const t_launch_desktop = Date.now();
const el_desktop = await ezil.registry.launch('desktop', desktopCtx);
await settle(2);
forceFlush();
await settle(2);
push('🔴 same fix, richer app: `open()` resolving does not close the desktop trace either',
    !! el_desktop && bootSummaries().length === 0,
    `window=${!! el_desktop} summaries-at-open-resolve=${bootSummaries().length}`);

const DESKTOP_HOLD_MS = 1_500;
await tick(DESKTOP_HOLD_MS);
releaseDesktopMint();

const desktop_iframe = await (async () => {
    for ( let i = 0; i < 80; i++ ) {
        const el = window.document.querySelector('.window[data-app="desktop"] .window-app-iframe');
        if ( el && el.getAttribute('src') !== 'about:blank' ) return el;
        await tick(20);
    }
    return null;
})();
push('the desktop mint landed and navigated the iframe', !! desktop_iframe, desktop_iframe?.getAttribute('src'));
desktop_iframe?.dispatchEvent(new window.Event('load'));
// Poll for the actual reveal (full-bleed) rather than a fixed `settle()` —
// a blind sleep long enough to be SAFE against two independent asks (the
// frame confirm and the display gate's own poll) landing would routinely
// overshoot the real terminal moment by tens to hundreds of ms, which is
// exactly the slack `measured_desktop_ms` below must NOT include: it exists
// to catch `durationMs` collapsing to near-zero, not to be loose enough to
// hide it.
const win_desktop = window.document.querySelector('.window[data-app="desktop"]');
for ( let i = 0; i < 100 && ! win_desktop?.classList.contains('ezil-fullbleed'); i++ ) await tick(20);
const measured_desktop_ms = Date.now() - t_launch_desktop;
forceFlush();
await settle(4);

{
    const summaries = bootSummaries().filter((s) => s.site === 'ezil-os:trace#desktop');
    push('🔴 exactly one boot_summary for the async desktop open', summaries.length === 1, `${summaries.length} sent`);
    const s = summaries[0];
    if ( s ) {
        const within = Math.abs((s.attrs?.total_ms ?? 0) - measured_desktop_ms) <= measured_desktop_ms * 0.2 + 100;
        push('🔴 durationMs tracks the REAL open, through the display gate — not ~500x short',
            within, `total_ms=${s.attrs?.total_ms} measured=${measured_desktop_ms}ms`);
        push('outcome is "ok" for a desktop that actually became ready', s.outcome === 'ok', s.outcome);
        push('🔴 attrs.phases carries the desktop-specific mint/confirm/display stages',
            /(^|,)mint_ok:\d+(,|$)/.test(s.attrs?.phases ?? '')
            && /(^|,)confirm_ok:\d+(,|$)/.test(s.attrs?.phases ?? '')
            && /(^|,)display_live:\d+(,|$)/.test(s.attrs?.phases ?? ''),
            s.attrs?.phases);
        push('correlationId is a real v4 uuid', typeof s.correlationId === 'string' && V4.test(s.correlationId), s.correlationId);
    }
}
window.$('.window[data-app="desktop"]').close();
await settle(2);

console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
// Force exit rather than let Node wait out any dangling timer a full window
// (Settings, unlike the black-hole harness in `telemetry-test.mjs`, may set
// one — a polling interval, a debounce) leaves running. The assertions above
// have already run; nothing after this line is being tested.
process.exit(checks.some((c) => ! c.pass) ? 1 : 0);
