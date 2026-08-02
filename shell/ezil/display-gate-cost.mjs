// display-gate-cost.mjs — EZiL-authored. What does the display gate COST?
//
// Run:  node shell/ezil/display-gate-cost.mjs            (all three scenarios)
//       node shell/ezil/display-gate-cost.mjs happy      (one of them)
//       SAMPLES=7 node shell/ezil/display-gate-cost.mjs
//       (after shell/build-shell.sh — it measures the BUILT bundle)
//
// Requires playwright, resolvable from here or from $PLAYWRIGHT_REQUIRE_DIR,
// same convention as the other `*-browser-test.mjs` files. Exits 2 (skip) if it
// is not there: a benchmark that silently measures nothing is worse than one
// that refuses to run.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS
// ═══════════════════════════════════════════════════════════════════════════
// The display gate (`desktop-window.js` `settle_display`) is the last thing
// between a booted container and the user's desktop. It was shipped correct and
// measured expensive: a warm boot went 5.1s -> 6.8s (+30%) in production, and
// the gate's own share was a median 1508ms across five samples. Two failure
// paths were worse: a probe that could not answer pushed settle from 7s to
// 29.7s, and a peer that negotiated slowly could be called `blank` — hiding a
// desktop that was about to work.
//
// None of that is visible to a unit test. It is a property of WHEN requests are
// issued relative to each other, which needs a real event loop, a real fetch
// stack and real DOM timing. So: real Chromium, the real built bundle, and a
// router that answers the shell's own endpoints after DELIBERATE, DECLARED
// latencies taken from the production measurement (see LATENCY below).
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS DOES AND DOES NOT PROVE
// ═══════════════════════════════════════════════════════════════════════════
// The latencies below are a MODEL. This harness cannot tell you what a boot
// costs in production — only production can, and the numbers it is calibrated
// against came from there. What it CAN do, and what it is for, is compare two
// revisions of the shell under an identical, declared network: if the same
// model produces a smaller number after a change, the change moved real work
// off the critical path rather than moving the measurement.
//
// It also deliberately does NOT model the server-side probe's internals. That
// half (login round trip vs. reused token) is measured against a real HTTP
// server in `app/src/server/lib/desktop-display-honesty.test.ts`'s cost block.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
    if ( dir ) {
        try {
            const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
            ({ chromium } = req('playwright'));
        } catch ( e2 ) {
            console.error(`playwright not found via PLAYWRIGHT_REQUIRE_DIR=${dir}: ${e2?.message ?? e2}`);
        }
    }
}
if ( ! chromium ) {
    console.error('playwright is not resolvable. Skipping, not passing.');
    process.exit(2);
}

// ── the declared network ───────────────────────────────────────────────────
//
// Calibrated against the production run that produced the numbers this task
// exists to improve:
//
//   PREVIEW  the warm `POST /sandbox/preview`. The whole warm boot measured
//            5.1s before the gate existed, of which the preview request is the
//            dominant term.
//   FRAME    `GET ?confirm=frame` — one server-side GET to an edge hostname.
//   DISPLAY  `GET ?confirm=display` — the measured median of the probe's own
//            serial round trip, 1454ms (login + sessions + our own hop).
//   STATUS   the cheap 2s status poll.
//
// 🔴 These are constants, not measurements of this machine. Changing one
// changes every number this file prints, so a before/after pair is only
// meaningful when both halves ran the same values.
const LATENCY = {
    PREVIEW: 3_400,
    FRAME: 420,
    DISPLAY: 1_454,
    STATUS: 90,
};

/** The shell's own per-request budget (`session.js` STATUS_TIMEOUT_MS). */
const CLIENT_TIMEOUT_MS = 12_000;

const SAMPLES = Number(process.env.SAMPLES ?? 5);
const WANTED = process.argv.slice(2).filter((a) => ! a.startsWith('-'));

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

const HOST = 'https://ezil-gate-cost.invalid';
const DESKTOP_URL = 'https://8181-guac-x-y-nekodesktop.ezil-gate-cost.invalid/?usr=EZiL&pwd=x&embed=1';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>`
    + '<body class="min-h-full flex flex-col"><div id="ezil-os-root"></div></body></html>';

const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: 'computer-1', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop' },
    },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

/**
 * The desktop-frame stub. `answer(elapsedSinceNavMs)` returns what
 * `GET ?confirm=display` should say — `'live'`, `'blank'`, `undefined` for a
 * body the server could not interpret, or `'hang'` to never answer at all
 * (which is what a degraded probe actually looks like from the browser: the
 * request sits until the shell's own 12s budget kills it).
 */
async function run_once (browser, answer) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const marks = { nav: 0, frame_ok: 0, first_display_ask: 0, settled: 0 };
    let t_nav = 0;

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        const json = async (body, delay) => {
            if ( delay ) await sleep(delay);
            if ( page.isClosed() ) return;
            try {
                await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            } catch { /* the page went away mid-flight; nothing to report */ }
        };

        if ( url === `${HOST}/os` ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
            return;
        }
        if ( url.includes('/api/shell/desktop') && req.method() === 'POST' ) {
            await sleep(LATENCY.PREVIEW);
            // The navigation is the instant the shell hands the URL to the
            // iframe, which is immediately after this resolves. Everything the
            // gate can possibly overlap with starts here.
            t_nav = Date.now();
            await json({
                ok: true, guacamoleUrl: DESKTOP_URL, controlMode: 'interactive', mode: 'neko',
                frame: { confirmed: true },
            });
            return;
        }
        if ( url.includes('confirm=frame') ) {
            await sleep(LATENCY.FRAME);
            marks.frame_ok = Date.now();
            await json({ ok: true, confirmed: true });
            return;
        }
        if ( url.includes('confirm=display') ) {
            if ( ! marks.first_display_ask ) marks.first_display_ask = Date.now();
            const said = answer(Date.now() - (t_nav || Date.now()));
            if ( said === 'hang' ) {
                // Never fulfil. The shell's AbortSignal is what ends this.
                await sleep(CLIENT_TIMEOUT_MS + 2_000);
                try { await route.abort('timedout'); } catch { /* page gone */ }
                return;
            }
            await sleep(LATENCY.DISPLAY);
            await json({ ok: true, display: said });
            return;
        }
        if ( url.includes('/api/shell/desktop') ) {
            await json({ ok: true, guacamoleRunning: true }, LATENCY.STATUS);
            return;
        }
        if ( url.includes('/api/') ) { await json({ ok: true }); return; }
        if ( url.startsWith(HOST) ) { await route.fulfill({ status: 404, body: '' }); return; }
        await route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    const t_boot = Date.now();
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });

    // The iframe will never load a real document (the desktop host 404s), so
    // fire `load` the way a real frame would once the src is set. This is the
    // shell's earliest trigger for the frame check and must not be skipped.
    await page.waitForSelector('.window[data-app="desktop"] .window-app-iframe', { timeout: 15_000 });
    await page.waitForFunction(
        (u) => document.querySelector('.window-app-iframe')?.getAttribute('src') === u,
        DESKTOP_URL, { timeout: 30_000 });

    // Settled = the gate let go, whichever way it went.
    await page.waitForFunction(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        const panel = document.querySelector('.ezil-boot');
        return !! w?.classList.contains('ezil-fullbleed')
            || panel?.getAttribute('data-kind') === 'failed';
    }, undefined, { timeout: 120_000 });
    marks.settled = Date.now();

    const kind = await page.evaluate(() => ({
        fullbleed: !! document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
        panel: document.querySelector('.ezil-boot')?.getAttribute('data-kind') ?? null,
        notice: document.querySelector('.ezil-display-notice')?.hidden === false,
    }));
    await page.close();

    return {
        // 🔴 THE HEADLINE NUMBER, and the one that is comparable across
        // revisions: how long the display gate held the desktop back AFTER
        // everything the gate replaced had already finished. Before this task
        // the gate started here; the point of the change is that it no longer
        // does.
        gate_ms: marks.settled - marks.frame_ok,
        settle_ms: marks.settled - t_boot,
        // How early the first display ask went out relative to the navigation.
        // Negative is impossible; 0 means fully overlapped.
        first_ask_after_nav_ms: marks.first_display_ask - (t_nav || marks.first_display_ask),
        ask_after_frame_ms: marks.first_display_ask - marks.frame_ok,
        ...kind,
    };
}

const SCENARIOS = {
    // The warm, healthy boot. The peer is already connected by the time anyone
    // asks — production answered `live` on the first ask 10/10.
    happy: { answer: () => 'live', expect: 'fullbleed' },
    // The probe cannot answer at all. Before this task every user paid the full
    // 20s deadline for this, on top of two 12s client timeouts.
    degraded: { answer: () => 'hang', expect: 'fullbleed+notice' },
    // A peer that needs 25s to negotiate — plausible over the mandatory TURN
    // relay (PLATFORM-NOTES §6). It MUST reach the desktop, not `blank`.
    slowpeer: { answer: (age) => (age < 25_000 ? 'blank' : 'live'), expect: 'fullbleed' },
};

const browser = await chromium.launch();
const names = WANTED.length ? WANTED : Object.keys(SCENARIOS);
let bad = 0;

for ( const name of names ) {
    const sc = SCENARIOS[name];
    if ( ! sc ) { console.error(`unknown scenario ${name}`); bad++; continue; }
    const runs = [];
    for ( let i = 0; i < SAMPLES; i++ ) runs.push(await run_once(browser, sc.answer));

    const gate = runs.map((r) => r.gate_ms);
    const settle = runs.map((r) => r.settle_ms);
    console.log(`\n── ${name} (${SAMPLES} samples) ──────────────────────────────`);
    console.log(`  gate    median ${median(gate)}ms   [${gate.join(', ')}]`);
    console.log(`  settle  median ${median(settle)}ms   [${settle.join(', ')}]`);
    console.log(`  first display ask: +${median(runs.map((r) => r.first_ask_after_nav_ms))}ms after nav,`
        + ` ${median(runs.map((r) => r.ask_after_frame_ms))}ms relative to the frame check`);
    const ends = runs.map((r) => `${r.fullbleed ? 'fullbleed' : `panel=${r.panel}`}${r.notice ? '+notice' : ''}`);
    console.log(`  outcome: ${[...new Set(ends)].join(' / ')}`);
    if ( new Set(ends).size !== 1 ) { console.log('  🔴 NOT DETERMINISTIC'); bad++; }
}

await browser.close();
process.exit(bad ? 1 : 0);
