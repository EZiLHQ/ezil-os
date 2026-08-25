// desktop-screen-test.mjs — EZiL-authored. Unit test for the desktop's sizing
// decisions: what box to ask for, how to letterbox what arrives, and when (and
// when NOT) to ask again.
//
// Run: node ezil/apps/desktop-screen-test.mjs
//
// These are PURE function and injected-clock tests, deliberately not browser
// ones — for the same reason `activity-heartbeat-test.mjs` is: a 500ms trailing
// debounce cannot be proven by a test that drags a real window for 500ms, and
// the property that actually matters ("a drag of forty ticks produces exactly
// one request") is invisible at that level anyway. The WIRING — the
// ResizeObserver, the real `session.setScreen`, the real iframe geometry — is
// `apps/desktop-window.js`'s and is exercised by `os-chrome-browser-test.mjs`
// and `boot-test.mjs`.
//
// 🔴 WHAT THIS FILE CANNOT PROVE, and says so rather than implying otherwise:
// whether a real container HONOURS a mode change. That needs a container, and
// under Xvfb the honest answer is that it does not — see `createScreenController`'s
// UNSUPPORTED handling, which is the behaviour these tests DO cover.

import {
    MAX_DEVICE_PIXEL_RATIO,
    RESIZE_DEBOUNCE_MS,
    computeFitBox,
    createScreenController,
    isScreenContractViolation,
    keyboardInsetPx,
    measureDesktopBox,
    readAppliedScreen,
} from './desktop-screen.js';

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });
const eq = (name, got, want) =>
    push(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const body = (w, h) => ({ clientWidth: w, clientHeight: h });
const view = (w, h, dpr = 1) => ({ innerWidth: w, innerHeight: h, devicePixelRatio: dpr });

// ── measureDesktopBox ───────────────────────────────────────────────────────

// 🔴 200ms, down from 500ms, and BOUNDED ON BOTH SIDES on purpose.
//
// The old 500ms was the price of a belief — that a mode change costs "a
// visible interruption plus a full software-vp8 re-init" — which was never
// measured and turned out to be false: sampled at 40ms inside the neko client
// on production across a live change, including landscape -> portrait, the
// picture never blacked out and never dropped a frame.
//
// What it really costs is container CPU, so the debounce still has a job: one
// encoder restart per gesture rather than one per tick. 200ms is the measured
// answer. A real drag recorded through a `ResizeObserver` produced 90 ticks
// over 1762ms at a p50 gap of 17ms with a longest natural hesitation of 148ms;
// replayed, 500/200/150ms all cost ONE restart for that gesture, 100ms cost
// two and 60ms cost three.
//
// The lower bound is the point of this check. Anything under ~150ms starts
// charging an extra encoder restart every time a user hesitates mid-drag, on a
// 2-vCPU container, and the symptom would be CPU rather than anything visible
// — which is exactly the kind of regression that gets shipped unnoticed.
push('RESIZE_DEBOUNCE_MS is 500ms — reverted from 200ms after a production regression, see desktop-screen.js',
    RESIZE_DEBOUNCE_MS === 500, String(RESIZE_DEBOUNCE_MS));
push('🔴 …and never drops below the 150ms knee, where a mid-drag hesitation starts costing extra encoder restarts',
    RESIZE_DEBOUNCE_MS >= 150, String(RESIZE_DEBOUNCE_MS));

eq('a phone viewport at 3x asks in DEVICE pixels, not CSS pixels',
    measureDesktopBox({ view: view(390, 844, 3) }), { width: 1170, height: 2532 });

eq('a 1x desktop viewport asks for its own pixels',
    measureDesktopBox({ view: view(1920, 1080, 1) }), { width: 1920, height: 1080 });

eq('devicePixelRatio is clamped, so an absurd zoom cannot ask for an absurd screen',
    measureDesktopBox({ view: view(1000, 1000, 12) }),
    { width: 1000 * MAX_DEVICE_PIXEL_RATIO, height: 1000 * MAX_DEVICE_PIXEL_RATIO });

for ( const bad of [0, -1, NaN, Infinity, undefined, 'two'] ) {
    eq(`devicePixelRatio ${String(bad)} falls back to 1 rather than producing nonsense`,
        measureDesktopBox({ view: { innerWidth: 800, innerHeight: 600, devicePixelRatio: bad } }),
        { width: 800, height: 600 });
}

// 🔴 THE ONE NON-OBVIOUS RULE. The Browser window opens windowed at 960x540
// and goes full-bleed as soon as the desktop is confirmed, so at the moment a
// size has to be chosen the body is measuring a box the desktop occupies for
// about a second. Measuring the body alone would boot every desktop at half
// its eventual size.
eq('🔴 a small window body loses to the viewport it is about to fill',
    measureDesktopBox({ body: body(960, 510), view: view(1920, 1080, 1) }),
    { width: 1920, height: 1080 });

eq('🔴 …but a body BIGGER than the viewport wins, so a deliberately huge window is honoured',
    measureDesktopBox({ body: body(2400, 1400), view: view(1920, 1080, 1) }),
    { width: 2400, height: 1400 });

eq('on a phone the body and the viewport are the same box, so the answer is portrait either way',
    measureDesktopBox({ body: body(390, 800), view: view(390, 844, 3) }),
    { width: 1170, height: 2532 });

push('a body with no layout is ignored rather than measured as 0',
    JSON.stringify(measureDesktopBox({ body: body(0, 0), view: view(800, 600) }))
        === JSON.stringify({ width: 800, height: 600 }));

push('nothing measurable at all -> null, never a made-up size',
    measureDesktopBox({}) === null);
push('a body with no layout and no view -> null', measureDesktopBox({ body: body(0, 0) }) === null);
push('a view with nonsense dimensions -> null',
    measureDesktopBox({ view: { innerWidth: NaN, innerHeight: 0, devicePixelRatio: 1 } }) === null);
push('an absurdly large measurement -> null (out of the server\'s accepted range)',
    measureDesktopBox({ view: view(100000, 100000, 1) }) === null);

// ── keyboardInsetPx — a raised keyboard is geometry, not resolution ─────────

const docWith = (inline, computed) => ({
    body: { style: { getPropertyValue: (k) => (k === '--ezil-kb' ? (inline ?? '') : '') } },
    defaultView: computed === undefined ? undefined : {
        getComputedStyle: () => ({ getPropertyValue: (k) => (k === '--ezil-kb' ? computed : '') }),
    },
});

push('reads the inline --ezil-kb `boot.js` publishes', keyboardInsetPx(docWith('336px')) === 336);
push('reads a bare number too', keyboardInsetPx(docWith('336')) === 336);
push('falls back to the computed value when nothing is inline',
    keyboardInsetPx(docWith('', '336px')) === 336);
push('no keyboard -> 0', keyboardInsetPx(docWith('0px')) === 0);
push('🔴 a MISSING signal reads as 0, so an older bundle behaves exactly as before',
    keyboardInsetPx(docWith('')) === 0 && keyboardInsetPx({}) === 0 && keyboardInsetPx(null) === 0);
push('garbage reads as 0 rather than NaN', keyboardInsetPx(docWith('tall')) === 0);
push('a negative value reads as 0', keyboardInsetPx(docWith('-40px')) === 0);
push('a body that throws on read is survivable',
    keyboardInsetPx({ body: { style: { getPropertyValue () { throw new Error('nope'); } } } }) === 0);

// ── computeFitBox — §4.3, the half that survives without live resize ────────

eq('a 16:9 stream in a 16:9 box fills it exactly, no bars',
    computeFitBox(1600, 900, 1920, 1080), { w: 1600, h: 900, left: 0, top: 0 });

eq('a 16:9 stream in a tall box gets horizontal bars',
    computeFitBox(1000, 1000, 1920, 1080), { w: 1000, h: 563, left: 0, top: 219 });

eq('a 16:9 stream in a wide box gets vertical bars',
    computeFitBox(2000, 500, 1920, 1080), { w: 889, h: 500, left: 556, top: 0 });

// 🔴 THE WHOLE POINT OF §4.3. Before this change the box was hardcoded 16:9,
// so a portrait desktop would have been letterboxed inside a landscape box —
// strictly worse than the bug being fixed.
eq('🔴 a PORTRAIT stream in a portrait box fills it, instead of being letterboxed to 16:9',
    computeFitBox(390, 800, 1080, 1920), { w: 390, h: 693, left: 0, top: 54 });

eq('🔴 a portrait stream in a phone box of the same aspect has NO bars at all',
    computeFitBox(1080, 1920, 1080, 1920), { w: 1080, h: 1920, left: 0, top: 0 });

push('a hardcoded 16:9 fit would have been wrong for that box (mutation check)',
    JSON.stringify(computeFitBox(390, 800, 1920, 1080)) !== JSON.stringify(computeFitBox(390, 800, 1080, 1920)),
    'if these agree, `fit_stream` is not actually reading the stream size');

push('the centring offsets always add up to the body (no uneven bars)', (() => {
    for ( const [bw, bh, sw, sh] of [[1000, 1000, 1920, 1080], [777, 333, 1080, 1920], [640, 481, 1280, 1024]] ) {
        const box = computeFitBox(bw, bh, sw, sh);
        if ( ! box ) return false;
        if ( box.left * 2 + box.w > bw + 1 || box.top * 2 + box.h > bh + 1 ) return false;
        if ( box.w > bw || box.h > bh ) return false;
    }
    return true;
})());

push('a zero-size body writes nothing (null), rather than collapsing the iframe',
    computeFitBox(0, 0, 1920, 1080) === null && computeFitBox(100, 0, 1920, 1080) === null);
push('a nonsense stream size writes nothing',
    computeFitBox(100, 100, 0, 1080) === null && computeFitBox(100, 100, NaN, 1080) === null);

// ── readAppliedScreen — trust the server, but only when it said something ───

eq('reads a well-formed answer', readAppliedScreen({ width: 1080, height: 1920, source: 'snapped' }),
    { width: 1080, height: 1920, source: 'snapped' });
push('🔴 an OLDER server (no field) reads as null, not as 1920x1080',
    readAppliedScreen(undefined) === null && readAppliedScreen(null) === null);
push('a partial or stringly-typed answer reads as null',
    readAppliedScreen({ width: '1080', height: 1920 }) === null
    && readAppliedScreen({ width: 1080.5, height: 1920 }) === null
    && readAppliedScreen({ width: 1080 }) === null
    && readAppliedScreen({ width: 0, height: 0 }) === null);
push('an unrecognised source is reported as unknown, not silently accepted',
    readAppliedScreen({ width: 800, height: 600, source: 'whatever' }).source === 'unknown');

// ── isScreenContractViolation ───────────────────────────────────────────────

push('`requested` that matches the ask is not a violation',
    isScreenContractViolation({ width: 1080, height: 1920 }, { width: 1080, height: 1920, source: 'requested' }) === false);
push('🔴 `requested` that does NOT match the ask IS a violation',
    isScreenContractViolation({ width: 1080, height: 1920 }, { width: 1920, height: 1080, source: 'requested' }) === true);
push('`snapped` is never a violation — it is the server saying it chose differently',
    isScreenContractViolation({ width: 1170, height: 2532 }, { width: 1080, height: 1920, source: 'snapped' }) === false);
push('nothing was asked -> nothing to violate',
    isScreenContractViolation(null, { width: 1080, height: 1920, source: 'requested' }) === false);

// ── createScreenController ──────────────────────────────────────────────────
//
// Injected clock: `timers` holds the armed callbacks, and `tick()` runs the
// most recent one. That is enough to model a trailing debounce exactly, and it
// makes "forty ticks produce one request" an assertion rather than a wait.

function fakeClock () {
    let next_id = 1;
    const timers = new Map();
    return {
        setTimeout: (fn) => { const id = next_id++; timers.set(id, fn); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        pending: () => timers.size,
        async run () {
            const entries = [...timers.entries()];
            timers.clear();
            for ( const [, fn] of entries ) await fn();
        },
    };
}

function harness ({ endpoint = '/api/shell/screen', reply } = {}) {
    const clock = fakeClock();
    const sent = [];
    const applied = [];
    const failed = [];
    const ctl = createScreenController({
        endpoint,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        send: async (w, h) => {
            sent.push([w, h]);
            return reply ? reply(w, h) : { ok: true, width: w, height: h, source: 'requested' };
        },
        onApplied: (a) => applied.push(a),
        onFailure: (f) => failed.push(f),
    });
    return { ctl, clock, sent, applied, failed };
}

{
    // 🔴 THE DRAG. A ResizeObserver fires continuously for the whole gesture;
    // sending each tick would restart the capture pipeline dozens of times.
    const { ctl, clock, sent } = harness();
    for ( let i = 0; i < 40; i++ ) ctl.request(1000 + i, 600 + i);
    push('🔴 forty ticks of a drag send NOTHING until the size settles', sent.length === 0);
    push('…and exactly one timer is armed, not forty', clock.pending() === 1, String(clock.pending()));
    await clock.run();
    eq('…then exactly one request, for the FINAL size', sent, [[1039, 639]]);
}

{
    const { ctl, clock, sent } = harness();
    ctl.seed(1920, 1080);
    ctl.request(1920, 1080);
    push('🔴 a resize back to the size already applied arms no timer and sends nothing',
        clock.pending() === 0 && sent.length === 0);
    await clock.run();
    push('…and still sends nothing after the clock runs', sent.length === 0);
}

{
    const { ctl, clock, sent, applied } = harness({
        reply: () => ({ ok: true, width: 1080, height: 1920, source: 'snapped' }),
    });
    ctl.request(1170, 2532);
    await clock.run();
    eq('a snap is reported with the SERVER\'s numbers, not the ask\'s', applied,
        [{ width: 1080, height: 1920, source: 'snapped' }]);
    eq('…and `applied()` remembers what the server said', ctl.applied(), { width: 1080, height: 1920 });

    // 🔴 THE LOOP THIS CLOSES. The server snaps 1170x2532 to 1080x1920, so the
    // applied size never equals the box the ResizeObserver keeps reporting. A
    // controller that deduplicated only against the APPLIED size would re-send
    // the same measurement after every settle, restarting the capture pipeline
    // forever for a size it has already been told it cannot have.
    ctl.request(1170, 2532);
    push('🔴 re-asking for a box already asked (and snapped) arms no timer',
        clock.pending() === 0, `pending ${clock.pending()}`);
    await clock.run();
    eq('…and sends nothing further', sent.length, 1);

    // A genuinely different box still gets through.
    ctl.request(1170, 2000);
    await clock.run();
    eq('…while a DIFFERENT box is still sent', sent.length, 2);
}

{
    // The boot seed: what the desktop is, plus the measurement that produced
    // it. Without the second half the first observer tick after the window
    // opens re-sends the boot measurement.
    const { ctl, clock, sent } = harness();
    ctl.seed(1080, 1920, { width: 1170, height: 2532 });
    ctl.request(1170, 2532);
    push('🔴 the first tick after a snapped BOOT does not re-ask',
        clock.pending() === 0 && sent.length === 0);
    await clock.run();
    push('…and still sends nothing', sent.length === 0);
}

{
    const { ctl, clock, sent, failed } = harness({
        reply: () => ({ ok: false, code: 'UNSUPPORTED', message: 'fixed framebuffer' }),
    });
    ctl.request(1080, 1920);
    await clock.run();
    push('an X server that cannot change mode reports UNSUPPORTED once',
        sent.length === 1 && failed.length === 1 && failed[0].code === 'UNSUPPORTED');
    push('🔴 …and the controller DISARMS — under Xvfb this is every container, forever',
        ctl.isArmed() === false);
    ctl.request(720, 1280);
    ctl.request(900, 1600);
    await clock.run();
    push('🔴 …so no amount of further resizing sends anything (no retry loop)', sent.length === 1,
        `sent ${sent.length}`);
}

{
    const { ctl, clock, sent, failed } = harness({
        reply: () => ({ ok: false, code: 'UPSTREAM', message: 'neko refused' }),
    });
    ctl.request(1080, 1920);
    await clock.run();
    push('a TRANSIENT failure does not disarm', ctl.isArmed() === true && failed[0].code === 'UPSTREAM');
    ctl.request(720, 1280);
    await clock.run();
    push('…so the next settled size tries again', sent.length === 2, `sent ${sent.length}`);
    // 🔴 And the SAME size too. A network blip must not permanently pin the
    // desktop to a shape the window no longer is, which is what would happen
    // if a failed attempt still counted as "already asked".
    ctl.request(720, 1280);
    await clock.run();
    push('🔴 …including a retry of a size whose attempt FAILED', sent.length === 3, `sent ${sent.length}`);
}

{
    const { ctl, clock, sent, failed } = harness({
        reply: () => { throw new Error('network down'); },
    });
    ctl.request(1080, 1920);
    await clock.run();
    push('a transport that THREW is a failure, never a success',
        failed.length === 1 && failed[0].code === 'UPSTREAM' && sent.length === 1);
    push('…and the controller stays armed', ctl.isArmed() === true);
}

{
    const { ctl, clock, sent } = harness({ endpoint: null });
    push('🔴 no `endpoints.screen` -> permanently dark, and it says so', ctl.isArmed() === false);
    ctl.request(1080, 1920);
    push('…arms no timer', clock.pending() === 0);
    await clock.run();
    push('…and never invents a URL to POST to', sent.length === 0);
}

{
    // 🔴 THE KEYBOARD. A raised keyboard shrinks the window for ~300ms and
    // gives it back. The refit must happen; the mode request must not. This is
    // the controller half — `desktop-window.js`'s observer is what decides to
    // call `cancel()` instead of `request()`.
    const { ctl, clock, sent } = harness();
    ctl.request(1170, 2000);   // the drag, mid-gesture
    ctl.cancel();              // …then a keyboard came up
    push('cancel() drops the armed request', clock.pending() === 0);
    await clock.run();
    push('…so a keyboard-shrunk box is never sent', sent.length === 0);
    push('…and the controller is STILL armed (unlike dispose)', ctl.isArmed() === true);
    ctl.request(1170, 2532);
    await clock.run();
    eq('…so a genuine resize afterwards still works', sent, [[1170, 2532]]);
}

{
    const { ctl, clock, sent } = harness();
    ctl.request(1080, 1920);
    ctl.dispose();
    push('dispose clears the armed timer', clock.pending() === 0);
    await clock.run();
    push('…so a window that closed mid-drag sends nothing', sent.length === 0);
    ctl.request(720, 1280);
    push('…and stays dark afterwards', ctl.isArmed() === false);
}

{
    const { ctl, clock, sent } = harness();
    for ( const bad of [[NaN, 1920], [1080.5, 1920], [0, 0], [-1, -1], ['1080', 1920]] ) {
        ctl.request(bad[0], bad[1]);
    }
    push('a non-integer measurement is never sent', clock.pending() === 0 && sent.length === 0);
    await clock.run();
    push('…and still is not after the clock runs', sent.length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// reconcile() — the controller learning it was WRONG
// ═══════════════════════════════════════════════════════════════════════════
// The defect these close: `seed` records a truth and the ask that produced it
// together, which is right at boot. But a screen can change with NO ask from
// this side — the Worker's troubleshoot restart resets the container to
// 1920x1080 and deliberately sets no NEKO_SCREEN, and a warm container gets
// handed to a window that never sized it. `last_sent` then still holds the boot
// measurement, every observer tick matches it, `settled()` returns true, and
// the controller sits forever believing a size the desktop stopped being. The
// picture stays letterboxed to an aspect the stream does not have until the
// window is closed and reopened. There was no way to tell it otherwise.

{
    // 🔴 THE BUG, reproduced first so the fix below is not proving a tautology.
    const { ctl, clock, sent } = harness();
    ctl.seed(1080, 1920, { width: 1170, height: 2532 });   // boot: asked 1170x2532, got 1080x1920
    // …the container restarts out of band and is now 1920x1080. The observer
    // keeps reporting the same viewport it always did.
    ctl.request(1170, 2532);
    await clock.run();
    push('🔴 WITHOUT reconcile, a stale belief silently swallows every later tick',
        sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

{
    const { ctl, clock, sent } = harness();
    ctl.seed(1080, 1920, { width: 1170, height: 2532 });
    const r = ctl.reconcile(1920, 1080);                    // the observation
    push('reconcile reports that it CONTRADICTED the previous belief', r.changed === true);
    push('…and the controller now reports the observed size, not the seeded one',
        JSON.stringify(ctl.applied()) === JSON.stringify({ width: 1920, height: 1080 }),
        JSON.stringify(ctl.applied()));
    ctl.request(1170, 2532);
    await clock.run();
    eq('🔴 the very next tick is allowed through — the loop is closed', sent, [[1170, 2532]]);
}

{
    // The other half, and the one that keeps a reconcile FREE: agreeing must
    // not clear the dedup, or every restore would cost a capture restart.
    const { ctl, clock, sent } = harness();
    ctl.seed(1080, 1920, { width: 1170, height: 2532 });
    const r = ctl.reconcile(1080, 1920);
    push('an AGREEING reconcile reports no change', r.changed === false);
    ctl.request(1170, 2532);
    await clock.run();
    push('🔴 …and sends nothing — a restore that changed nothing costs nothing',
        sent.length === 0, `sent=${JSON.stringify(sent)}`);
}

{
    const { ctl } = harness();
    ctl.seed(1080, 1920, { width: 1170, height: 2532 });
    for ( const bad of [[NaN, 1080], [0, 0], [-1, 720], [1920.5, 1080], ['1920', 1080]] ) {
        const r = ctl.reconcile(bad[0], bad[1]);
        if ( r.changed !== false ) { push(`reconcile rejects ${JSON.stringify(bad)}`, false); break; }
    }
    push('reconcile rejects every non-measurement rather than adopting it',
        JSON.stringify(ctl.applied()) === JSON.stringify({ width: 1080, height: 1920 }),
        JSON.stringify(ctl.applied()));
}

// ───────────────────────────────────────────────────────────────────────────
const failed_checks = checks.filter((c) => ! c.pass);
for ( const c of checks ) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed_checks.length}/${checks.length} checks passed`);
process.exit(failed_checks.length === 0 ? 0 : 1);
