// responsiveness-browser-test.mjs — EZiL-authored.
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit node shell/responsiveness-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as every other `*-browser-test.mjs`.)
//
// Exits 2 (skip), never 0 (pass), when it cannot run.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═══════════════════════════════════════════════════════════════════════════
// Two symptoms were reported against the streamed desktop: it "flickers when
// I minimize or maximize it", and the picture does not fit its frame. Both
// turned out to be real, both had a named cause, and NEITHER was caught by
// any existing suite — not because the suites were thin, but because each one
// asserted the thing next to the defect:
//
//   * `window-chrome-browser-test.mjs` installs its OWN `_ezil_minimise`
//     stand-in that calls the CORRECT function, then asserts the property
//     production violated. Honest about being a seam test; it simply never
//     ran the shipped hook.
//   * `seam-minimise-browser-test.mjs` DOES run the shipped hook, and asserted
//     that the `ezil-fullbleed` CLASS came back after a restore — never the
//     SIZE. The window was full-bleed one frame later, so it stayed green
//     while the user watched it snap.
//   * nothing at all measured the desktop at more than one viewport.
//
// So this file asserts SIZE and SHAPE, at many device shapes, plus the
// interaction storms a real user produces. It is the responsiveness tier.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS REAL HERE AND WHAT IS A FIXTURE
// ═══════════════════════════════════════════════════════════════════════════
// REAL: the built bundle, a real Chromium, real layout, real animation
// timing, the real `_ezil_minimise`/`go_fullbleed`/`fit_stream` code paths,
// and the real `createScreenController` debounce.
//
// FIXTURE: the server. There is no container, so `/api/shell/screen` is
// mocked — but it snaps with the SAME algorithm and the SAME mode table as
// production, and GROUP 0 fails if the table in this file has drifted from
// `worker/src/screen-modes.ts`. A fixture that quietly disagreed with the
// server would let this whole file assert the wrong answers confidently.
//
// NOT REAL, and deliberately so: the stream itself. The desktop is a
// cross-origin neko SPA; its `<video>` is unreachable by construction. Every
// claim here is about the BOX the stream is fitted into, which is the half
// this side owns and the half that was broken.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../app/public/os');
const MODES_TS = path.resolve(here, '../worker/src/screen-modes.ts');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

let chromium;
try { ({ chromium } = await import('playwright')); } catch {
    const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
    if ( dir ) {
        try {
            const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
            ({ chromium } = req('playwright'));
        } catch ( e ) { console.error(`playwright not found via PLAYWRIGHT_REQUIRE_DIR: ${e?.message ?? e}`); }
    }
}
if ( ! chromium ) {
    console.error('playwright is not resolvable. This is a REAL-BROWSER test — jsdom has no layout model. Skipping, not passing.');
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 0 — the fixture's mode table is the SERVER'S mode table
// ═══════════════════════════════════════════════════════════════════════════
// Read out of the .ts rather than copied, so this cannot silently drift. If it
// ever throws or comes back empty the file skips (2) rather than passing on a
// table it invented.
const SCREEN_MODES = [...fs.readFileSync(MODES_TS, 'utf8')
    .matchAll(/^\s*\{ width: (\d+), height: (\d+) \},/gm)]
    .map((m) => ({ width: Number(m[1]), height: Number(m[2]) }));
if ( SCREEN_MODES.length === 0 ) {
    console.error(`parsed ZERO modes out of ${MODES_TS} — a green run would be a false green. Skipping.`);
    process.exit(2);
}
push('GROUP 0: the mode table was read from worker/src/screen-modes.ts, not invented here',
    SCREEN_MODES.length >= 12, `${SCREEN_MODES.length} modes`);

/** The server's rule, verbatim: nearest aspect in log space, then nearest area. */
const ASPECT_CLASS_TOLERANCE = 0.01;
function snapScreenMode (w, h) {
    if ( SCREEN_MODES.some((m) => m.width === w && m.height === h) ) return { width: w, height: h };
    const askA = Math.log(w / h);
    const askArea = w * h;
    let best = SCREEN_MODES[0], bestA = Infinity, bestAr = Infinity;
    for ( const m of SCREEN_MODES ) {
        const a = Math.abs(Math.log(m.width / m.height) - askA);
        const ar = Math.abs(m.width * m.height - askArea);
        if ( a < bestA - ASPECT_CLASS_TOLERANCE ) { best = m; bestA = a; bestAr = ar; }
        else if ( a <= bestA + ASPECT_CLASS_TOLERANCE && ar < bestAr ) { best = m; bestA = Math.min(bestA, a); bestAr = ar; }
    }
    return best;
}

const HOST = 'https://ezil-responsiveness-test.invalid';
const DESKTOP_URL = 'https://8181-guac-x-y-nekodesktop.ezil-responsiveness-test.invalid/?usr=EZiL&pwd=x&embed=1';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>`
    + '<body class="min-h-full flex flex-col"><div id="ezil-os-root"></div></body></html>';

const PAYLOAD = (screenEndpoint) => ({
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: '11111111-1111-4111-8111-111111111111', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: {
            session: '/api/shell/session',
            desktop: '/api/shell/desktop',
            // Present -> the live-resize path is ARMED. Absent -> the shell
            // stays permanently dark, which is a different (also correct)
            // behaviour that `desktop-screen-test.mjs` already covers.
            ...(screenEndpoint ? { screen: '/api/shell/screen' } : {}),
        },
    },
});

const browser = await chromium.launch();

/**
 * Boot the real shell at a given device shape.
 *
 * A fresh page per shape rather than `setViewportSize`, because
 * `devicePixelRatio` is fixed at context creation and dpr is half of what the
 * shell asks for — a phone measured at dpr 1 asks for a different mode than
 * the same phone at dpr 3, and getting that wrong would make every phone
 * assertion here meaningless.
 */
async function boot ({ width, height, dpr = 1, screen = true, serverScreen = null }) {
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: dpr,
        hasTouch: dpr > 1,
    });
    const page = await context.newPage();
    const state = {
        asks: [],                       // every {width,height} the shell POSTed
        applied: serverScreen,          // what the fixture server says the screen IS
        reads: 0,                       // GET /api/shell/screen count
        errors: [],
    };
    page.on('pageerror', (e) => state.errors.push(String(e)));

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if ( url === `${HOST}/os` ) return route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });

        if ( url.includes('/api/shell/screen') ) {
            if ( req.method() === 'GET' ) {
                state.reads++;
                // For the mutation proof: put the shell back in the state it
                // was in before a read existed at all.
                if ( state.blockReads ) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"ok":false}' });
                if ( ! state.applied ) return json({ ok: false, error: { code: 'UPSTREAM', message: 'no screen' } });
                return json({ ok: true, ...state.applied, source: 'observed' });
            }
            const body = JSON.parse(req.postData() || '{}');
            state.asks.push({ width: body.width, height: body.height });
            const m = snapScreenMode(body.width, body.height);
            state.applied = { width: m.width, height: m.height };
            return json({
                ok: true, width: m.width, height: m.height,
                source: (m.width === body.width && m.height === body.height) ? 'requested' : 'snapped',
            });
        }
        if ( url.includes('/api/shell/desktop') && req.method() === 'POST' ) {
            const body = JSON.parse(req.postData() || '{}');
            // The BOOT ask travels on openDesktop, exactly as in production.
            if ( body?.screen?.width && body?.screen?.height ) {
                state.asks.push({ width: body.screen.width, height: body.screen.height, boot: true });
                const m = snapScreenMode(body.screen.width, body.screen.height);
                state.applied = { width: m.width, height: m.height };
            }
            return json({
                ok: true, guacamoleUrl: DESKTOP_URL, controlMode: 'interactive', mode: 'neko',
                frame: { confirmed: true },
                ...(state.applied ? { screen: { ...state.applied, source: 'snapped' } } : {}),
            });
        }
        if ( url.includes('confirm=frame') ) return json({ ok: true, confirmed: true });
        if ( url.includes('confirm=display') ) return json({ ok: true, display: 'live' });
        if ( url.includes('/api/shell/desktop') ) return json({ ok: true, guacamoleRunning: true });
        if ( url.includes('/api/') ) return json({ ok: true });
        if ( url.startsWith(HOST) ) return route.fulfill({ status: 404, body: '' });
        return route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD(screen));
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    await page.waitForSelector('.taskbar-item', { timeout: 15_000 });
    // Open the desktop the way a user does.
    await page.click('.taskbar-item[data-app="desktop"]').catch(() => {});
    await page.waitForFunction(
        () => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
        null, { timeout: 15_000 },
    ).catch(() => {});
    await sleep(700);   // past go_fullbleed + the 500ms resize debounce
    return { page, context, state };
}

/** The geometry that matters, measured — never read off CSS. */
const geometry = (page) => page.evaluate(() => {
    const el = document.querySelector('.window[data-app="desktop"]');
    if ( ! el ) return null;
    const body = el.querySelector('.window-body');
    const ifr = el.querySelector('iframe');
    const r = (n) => (n ? n.getBoundingClientRect() : null);
    const wr = r(el), br = r(body), ir = r(ifr);
    return {
        fullbleed: el.classList.contains('ezil-fullbleed'),
        win: wr && { w: Math.round(wr.width), h: Math.round(wr.height) },
        body: br && { w: Math.round(br.width), h: Math.round(br.height) },
        frame: ir && { w: Math.round(ir.width), h: Math.round(ir.height) },
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
        pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — the desktop at many device shapes
// ═══════════════════════════════════════════════════════════════════════════
// The bands the user photographed are the mode table showing through: a
// viewport whose aspect is not in the table can only be letterboxed. This
// asserts a CEILING on that, per shape, plus the two things that are never
// acceptable at any shape — a stream wider than the box it sits in, and a
// page that scrolls sideways.
const MAX_WASTE_PCT = 12;

const SHAPES = [
    { label: 'laptop 1440x900',        width: 1440, height: 900,  dpr: 1 },
    { label: 'desktop 1920x1080',      width: 1920, height: 1080, dpr: 1 },
    { label: 'ultrawide 21:9',         width: 1720, height: 720,  dpr: 2 },
    { label: 'MacBook Air 13"',        width: 1512, height: 830,  dpr: 2 },
    { label: 'iPhone 14 portrait',     width: 390,  height: 844,  dpr: 3 },
    { label: 'Pixel 7 portrait',       width: 412,  height: 915,  dpr: 3 },
    { label: 'iPhone 14 landscape',    width: 844,  height: 390,  dpr: 3 },
    { label: 'iPad portrait',          width: 820,  height: 1180, dpr: 2 },
    { label: 'small laptop 1024x640',  width: 1024, height: 640,  dpr: 1 },
    { label: 'tiny phone 320x568',     width: 320,  height: 568,  dpr: 2 },
];

for ( const shape of SHAPES ) {
    const L = `[${shape.label}]`;
    const { page, context, state } = await boot(shape);
    const g = await geometry(page);

    if ( ! g || ! g.frame || ! g.body ) {
        push(`${L} the desktop window and its stream exist`, false, JSON.stringify(g));
        await context.close();
        continue;
    }

    push(`${L} the desktop reaches full-bleed`, g.fullbleed === true, JSON.stringify(g.win));

    // 🔴 NEVER acceptable, at any shape: the stream sticking out of its box.
    // This is what the reported screenshot showed — a right edge cut through
    // a control.
    push(`${L} 🔴 the stream never overflows its window body`,
        g.frame.w <= g.body.w && g.frame.h <= g.body.h,
        `frame=${g.frame.w}x${g.frame.h} body=${g.body.w}x${g.body.h}`);

    push(`${L} 🔴 the page never scrolls sideways`,
        g.pageOverflowX <= 0, `overflowX=${g.pageOverflowX}px`);

    const wasted = 100 * (1 - (g.frame.w * g.frame.h) / (g.body.w * g.body.h));
    push(`${L} letterboxing wastes at most ${MAX_WASTE_PCT}% of the window`,
        wasted <= MAX_WASTE_PCT, `wasted=${wasted.toFixed(1)}%`);

    // The ask is the shell's, the answer is the table's — this checks the two
    // agree, i.e. the shell is fitting to a mode the server could really apply.
    const lastAsk = state.asks[state.asks.length - 1];
    if ( lastAsk ) {
        const expected = snapScreenMode(lastAsk.width, lastAsk.height);
        push(`${L} the shell asked for a real measurement and the table answered a real mode`,
            !! state.applied && state.applied.width === expected.width && state.applied.height === expected.height,
            `ask=${lastAsk.width}x${lastAsk.height} -> ${state.applied?.width}x${state.applied?.height}`);
        // The stream's aspect must be the APPLIED mode's aspect, not the ask's
        // — fitting to the ask is the defect the read-back exists to prevent.
        const modeAspect = state.applied.width / state.applied.height;
        const frameAspect = g.frame.w / g.frame.h;
        push(`${L} 🔴 the stream is fitted to the APPLIED mode's aspect, not the ask's`,
            Math.abs(modeAspect - frameAspect) < 0.02,
            `mode=${modeAspect.toFixed(3)} frame=${frameAspect.toFixed(3)}`);
    } else {
        push(`${L} the shell asked the server for a screen size`, false, 'no ask was made');
    }

    push(`${L} no uncaught page errors`, state.errors.length === 0, JSON.stringify(state.errors.slice(0, 2)));
    await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — the flicker, at three shapes, with the storms a real user makes
// ═══════════════════════════════════════════════════════════════════════════
// `seam-minimise-browser-test.mjs` proves the single clean cycle at one
// viewport. This proves it survives repetition and impatience, which is when
// a restore lands on top of a transition that has not finished.
const FLICKER_SETTLE_MS = 210;

/** One minimise + restore, sampled across the restore. */
const cycle = (page) => page.evaluate(async () => {
    const el = document.querySelector('.window[data-app="desktop"]');
    el.querySelector('.window-head .window-minimize-btn')?.click();
    await new Promise((r) => setTimeout(r, 650));
    const orig = {
        w: Number(el.getAttribute('data-orig-width')),
        h: Number(el.getAttribute('data-orig-height')),
    };
    const samples = [];
    const t0 = performance.now();
    document.querySelector('.taskbar-item[data-app="desktop"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for ( let i = 0; i < 32; i++ ) {
        const r = el.getBoundingClientRect();
        samples.push({ t: performance.now() - t0, w: Math.round(r.width), h: Math.round(r.height) });
        await new Promise((r2) => setTimeout(r2, 20));
    }
    const final = samples[samples.length - 1];
    const settled = samples.filter((s) => s.t <= 210).pop() ?? samples[0];
    let snap = 0;
    for ( let i = 1; i < samples.length; i++ ) {
        if ( samples[i].t <= 210 ) continue;
        snap = Math.max(snap, Math.abs(samples[i].w - samples[i - 1].w));
    }
    return { orig, final, settled, snap };
});

for ( const shape of [SHAPES[0], SHAPES[1], SHAPES[4]] ) {
    const L = `[flicker ${shape.label}]`;
    const { page, context, state } = await boot(shape);

    const c1 = await cycle(page);
    push(`${L} hideWindow snapshots the REAL full-bleed size, not a stashed small box`,
        c1.orig.w === c1.final.w && c1.orig.w > 0,
        `snapshot=${c1.orig.w}x${c1.orig.h} final=${c1.final.w}x${c1.final.h}`);
    push(`${L} 🔴 settled at its final size by ${FLICKER_SETTLE_MS}ms — nothing left to snap to`,
        c1.settled.w === c1.final.w, JSON.stringify({ settled: c1.settled, final: c1.final }));
    push(`${L} 🔴 no single-frame jump after the transition (the snap itself)`,
        c1.snap === 0, `largest post-transition frame delta = ${c1.snap}px`);

    // THE STORM. Three cycles back to back, each starting while the previous
    // restore's inline transition may still be live.
    let worst = 0, mismatched = 0;
    for ( let i = 0; i < 3; i++ ) {
        const c = await cycle(page);
        worst = Math.max(worst, c.snap);
        if ( c.settled.w !== c.final.w ) mismatched++;
    }
    push(`${L} 🔴 three back-to-back minimise/restore cycles never snap`,
        worst === 0 && mismatched === 0, `worst delta=${worst}px, unsettled cycles=${mismatched}`);

    push(`${L} no uncaught page errors across the storm`,
        state.errors.length === 0, JSON.stringify(state.errors.slice(0, 2)));
    await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — the resize storm stays one request
// ═══════════════════════════════════════════════════════════════════════════
// A mode change restarts the capture pipeline. A drag is a stream of
// ResizeObserver ticks. The debounce is the only thing between the two, and
// this asserts it against a real observer rather than a fake clock (which
// `desktop-screen-test.mjs` already does).
{
    const L = '[resize storm]';
    const { page, context, state } = await boot({ width: 1440, height: 900, dpr: 1 });
    const before = state.asks.length;

    for ( const [w, h] of [[1400, 880], [1360, 860], [1320, 840], [1280, 820], [1200, 800], [1100, 780]] ) {
        await page.setViewportSize({ width: w, height: h });
        await sleep(60);      // faster than the 500ms debounce, like a real drag
    }
    await sleep(200);
    push(`${L} 🔴 nothing is sent while the "drag" is still moving`,
        state.asks.length === before, `${state.asks.length - before} request(s) mid-drag`);

    await sleep(900);         // past the 500ms trailing debounce
    const after = state.asks.length - before;
    push(`${L} 🔴 exactly one request once it settles, not one per tick`,
        after <= 1, `${after} request(s) after settling`);

    const g = await geometry(page);
    push(`${L} the stream still fits its box after the storm`,
        !! g?.frame && g.frame.w <= g.body.w && g.frame.h <= g.body.h,
        g ? `frame=${g.frame?.w}x${g.frame?.h} body=${g.body?.w}x${g.body?.h}` : 'no geometry');
    push(`${L} no uncaught page errors`, state.errors.length === 0, JSON.stringify(state.errors.slice(0, 2)));
    await context.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — reconcile: the desktop changes underneath the shell
// ═══════════════════════════════════════════════════════════════════════════
// The structural defect. `stream` is written twice (boot read-back, successful
// resize) and the controller seeds its dedup with the boot ASK, so a screen
// that changes with no ask from this side could never be discovered: every
// later measurement was dropped as settled against a belief that had stopped
// being true, and the picture stayed letterboxed to an aspect the stream did
// not have until the window was closed and reopened.
//
// Simulated here exactly as production produces it: the fixture server's
// screen is changed out of band, the way a troubleshoot restart resets a
// container to 1920x1080 without telling anyone.
{
    const L = '[reconcile]';
    const { page, context, state } = await boot({ width: 390, height: 844, dpr: 3 });

    const believed = state.applied ? { ...state.applied } : null;
    push(`${L} setup: the phone booted to a portrait mode`,
        !! believed && believed.height > believed.width, JSON.stringify(believed));
    const asksBefore = state.asks.length;
    const readsBefore = state.reads;

    // Out of band. Nothing tells the shell — exactly how a troubleshoot
    // restart resets a container to 1920x1080.
    state.applied = { width: 1920, height: 1080 };

    const minimiseRestore = async () => {
        await page.evaluate(async () => {
            const el = document.querySelector('.window[data-app="desktop"]');
            el.querySelector('.window-head .window-minimize-btn')?.click();
            await new Promise((r) => setTimeout(r, 650));
            document.querySelector('.taskbar-item[data-app="desktop"]')
                ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await sleep(1400);
    };
    await minimiseRestore();

    push(`${L} 🔴 the shell READ the screen on restore — it had no way to before`,
        state.reads > readsBefore, `reads ${readsBefore} -> ${state.reads}`);

    // 🔴 THE ASSERTION THAT MATTERS, and it is not "the picture went
    // landscape". Watching what actually happens is better than what I first
    // expected: the shell reads 1920x1080, sees it contradicts what it
    // believed, CLEARS the dedup, and the next observer tick re-asks for the
    // phone's real measurement — so the server puts the desktop back to the
    // portrait mode this device should have. The shell does not merely notice
    // the drift, it REPAIRS it.
    //
    // The second ask is the whole proof. Before reconcile existed it could
    // never be sent: `last_sent` still held the boot measurement, every tick
    // matched it, `settled()` returned true, and the desktop stayed at
    // 1920x1080 letterboxed into a portrait phone until the window was closed
    // and reopened.
    const newAsks = state.asks.length - asksBefore;
    push(`${L} 🔴 a NEW ask reached the server after the out-of-band change`,
        newAsks >= 1, `${newAsks} new ask(s): ${JSON.stringify(state.asks.slice(asksBefore))}`);
    push(`${L} 🔴 …and the desktop ends on a PORTRAIT mode again, not the stale 1920x1080`,
        !! state.applied && state.applied.height > state.applied.width,
        `applied=${state.applied?.width}x${state.applied?.height}`);

    const after = await geometry(page);
    push(`${L} the stream fits its box after the repair`,
        !! after?.frame && after.frame.w <= after.body.w && after.frame.h <= after.body.h,
        `frame=${after?.frame?.w}x${after?.frame?.h} body=${after?.body?.w}x${after?.body?.h}`);
    push(`${L} no uncaught page errors`, state.errors.length === 0, JSON.stringify(state.errors.slice(0, 2)));
    await context.close();
}

// ── BOTH DIRECTIONS ────────────────────────────────────────────────────────
// Take the read away and the SAME sequence must fail to repair. Without this,
// the group above could be passing because something else re-asked, and the
// reconcile path would be decoration.
{
    const L = '[reconcile mutation]';
    const { page, context, state } = await boot({ width: 390, height: 844, dpr: 3 });

    // Remove the shell's ability to OBSERVE — the state the code was in
    // before `session.getScreen` existed. Done at the fixture rather than in
    // the page: the desktop is a cross-origin iframe, so anything that walks
    // `window` to monkeypatch trips a SecurityError.
    state.blockReads = true;

    const asksBefore = state.asks.length;
    state.applied = { width: 1920, height: 1080 };   // the same out-of-band change

    await page.evaluate(async () => {
        const el = document.querySelector('.window[data-app="desktop"]');
        el.querySelector('.window-head .window-minimize-btn')?.click();
        await new Promise((r) => setTimeout(r, 650));
        document.querySelector('.taskbar-item[data-app="desktop"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await sleep(1400);

    push(`${L} 🔴 MUTATION PROOF: with the read gone the drift is never noticed and never repaired`,
        state.asks.length === asksBefore && state.applied.width === 1920,
        `new asks=${state.asks.length - asksBefore}, applied=${state.applied.width}x${state.applied.height}`);
    await context.close();
}

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('\nFAILURES:');
    for ( const c of failed ) console.log(`  - ${c.name}${c.detail ? ` [${c.detail}]` : ''}`);
}
process.exit(failed.length === 0 ? 0 : 1);
