// late-focus-browser-test.mjs — EZiL-authored.
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit \
//       node shell/ezil/ui/Settings/late-focus-browser-test.mjs
//
// Exits 2 (skip), never 0 (pass), when it cannot run.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE BUG: A WINDOW THAT OPENS INVISIBLY
// ═══════════════════════════════════════════════════════════════════════════
// On a phone, tapping Settings in the full-bleed desktop's drawer opened a
// Settings window the user could not see or touch. `document.elementFromPoint`
// at Settings' OWN close button returned the DESKTOP's body.
// `mobile-browser-test.mjs` failed 4 runs in 5 on it, and reported it as "the
// Settings close control never became tappable" — which reads like a harness
// problem and is not one.
//
// ── WHY, AND WHY THE COUNTER WAS A RED HERRING ─────────────────────────────
// Z-ORDER IN THIS SHELL IS DECIDED BY FOCUS. `style.css` gives every `.window`
// `z-index: 9999999 !important`, so the inline value `UIWindow` assigns from
// `window.last_window_zindex` is overridden and orders nothing — measured
// directly: a desktop with inline z-index 4 computed to 9999999. The rule that
// actually orders windows is focused = 9999999, unfocused = 9999998.
//
// Two fixes aimed at the counter were tried first and moved the failure rate
// not at all (1/5 -> 2/5 -> 1/5); both were reverted. The counter was never
// the mechanism.
//
// ── THE RACE ───────────────────────────────────────────────────────────────
// `$.fn.showWindow` focuses on a `setTimeout(..., 80)`. So a desktop window
// being restored lands its focus up to 80ms in the FUTURE. Open Settings from
// that desktop's drawer inside that window and the desktop's late focus
// arrives after Settings opened: Settings drops to 9999998, underneath a
// full-screen desktop.
//
// This file reproduces that race deterministically — it schedules the late
// focus itself rather than waiting for one — and proves both directions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../../app/public/os');
const MODES_TS = path.resolve(here, '../../../../worker/src/screen-modes.ts');

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

// The server's live-resize rule, mirrored. 🔴 The constants are READ OUT OF
// `worker/src/screen-modes.ts`, not copied, so a fixture that quietly
// disagreed with the server cannot let this whole file assert wrong answers
// confidently — the same discipline as the mode table above.
const readConst = (name, fallback) => {
    const src = fs.readFileSync(MODES_TS, 'utf8');
    const m = src.match(new RegExp(`export const ${name}[^=]*=\\s*([0-9*\\s]+);`));
    if (!m) return fallback;
    // eslint-disable-next-line no-eval
    return Number(m[1].split('*').reduce((a, b) => a * Number(b.trim()), 1));
};
// 🔴 The debounce is READ FROM SOURCE, not hardcoded, and every wait below is
// derived from it. This test previously slept a literal 200ms to mean "still
// mid-drag"; when the debounce was shortened from 500ms to 200ms that literal
// became exactly the firing boundary and the check went red for a timing
// coincidence rather than a defect. A test whose timings are relative to the
// thing under test cannot rot that way.
const DEBOUNCE_MS = Number(
    (fs.readFileSync(path.resolve(here, '../../apps/desktop-screen.js'), 'utf8')
        .match(/export const RESIZE_DEBOUNCE_MS\s*=\s*(\d+)/) ?? [])[1] ?? 0,
);
if ( ! DEBOUNCE_MS ) {
    console.error('could not read RESIZE_DEBOUNCE_MS from desktop-screen.js — skipping, not passing.');
    process.exit(2);
}
const FRAMEBUFFER_AXIS = readConst('SCREEN_FRAMEBUFFER_AXIS', 1920);
const PIXEL_CEILING = readConst('SCREEN_PIXEL_CEILING', 1920 * 1080);
const WIDTH_ALIGNMENT = readConst('SCREEN_WIDTH_ALIGNMENT', 8);
const MIN_AXIS = readConst('MIN_REQUESTED_AXIS', 64);
push('GROUP 0: the fit constants were read from the same file the server uses',
    FRAMEBUFFER_AXIS === 1920 && PIXEL_CEILING === 1920 * 1080 && WIDTH_ALIGNMENT === 8,
    `framebuffer=${FRAMEBUFFER_AXIS} ceiling=${PIXEL_CEILING} align=${WIDTH_ALIGNMENT}`);

/**
 * `fitScreenRequest`, mirrored: ONE uniform factor for the framebuffer on both
 * axes and the pixel ceiling, then width floored to the alignment and height
 * to even. Clamping per-axis before scaling would ruin the aspect — that bug
 * was written once already and caught by a unit test.
 */
function fitScreenRequest (w, h) {
    if ( ! Number.isFinite(w) || ! Number.isFinite(h) || w <= 0 || h <= 0 ) return null;
    const k = Math.min(1, FRAMEBUFFER_AXIS / w, FRAMEBUFFER_AXIS / h, Math.sqrt(PIXEL_CEILING / (w * h)));
    const width = Math.floor((w * k) / WIDTH_ALIGNMENT) * WIDTH_ALIGNMENT;
    const height = Math.floor((h * k) / 2) * 2;
    if ( width < MIN_AXIS || height < MIN_AXIS ) return null;
    return { width, height };
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
            const m = fitScreenRequest(body.width, body.height);
            if ( ! m ) return json({ ok: false, error: { code: 'BAD_REQUEST' } });
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
                const m = fitScreenRequest(body.screen.width, body.screen.height);
                if ( ! m ) return json({ ok: true, guacamoleUrl: DESKTOP_URL, controlMode: 'interactive', mode: 'neko', frame: { confirmed: true } });
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
    await sleep(500 + DEBOUNCE_MS);   // past go_fullbleed and the trailing resize debounce
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
// THE RACE, REPRODUCED DETERMINISTICALLY
// ═══════════════════════════════════════════════════════════════════════════
/** Which window is on top, by the rule that actually decides it: computed z. */
const topWindow = (page) => page.evaluate(() => {
    let best = null, bestZ = -1;
    for ( const el of document.querySelectorAll('.window') ) {
        const z = Number.parseInt(getComputedStyle(el).zIndex, 10) || 0;
        if ( z > bestZ ) { bestZ = z; best = el; }
    }
    return { app: best?.getAttribute('data-app') ?? null, z: bestZ };
});

/** Is Settings' own close button the thing a tap at its centre would hit? */
const closeButtonReachable = (page) => page.evaluate(() => {
    const s = document.querySelector('.window[data-app="settings"]');
    if ( ! s ) return { ok: false, why: 'no settings window' };
    const b = s.querySelector('.window-head > .window-close-btn');
    if ( ! b ) return { ok: false, why: 'no close button' };
    const r = b.getBoundingClientRect();
    if ( r.width <= 0 || r.height <= 0 ) return { ok: false, why: 'close button has no box' };
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    const owner = hit?.closest?.('.window')?.getAttribute?.('data-app') ?? null;
    return { ok: owner === 'settings', why: `topmost belongs to "${owner}"`, owner };
});

/**
 * Open Settings from the desktop's drawer WHILE a late focus is in flight for
 * the desktop — exactly what `$.fn.showWindow`'s `setTimeout(..., 80)` does
 * when a desktop is restored.
 */
async function openSettingsUnderLateFocus (page, { breakFix = false } = {}) {
    if ( breakFix ) {
        // 🔴 THE MUTATION. `ensureOnTop` re-asserts focus at 120ms, after the
        // late focus has landed. Neutering `focusWindow` for exactly that
        // window puts the code back in the state that shipped.
        await page.evaluate(() => {
            const orig = window.$.fn.focusWindow;
            window.__focusCalls = 0;
            window.$.fn.focusWindow = function (...a) {
                const app = this?.[0]?.getAttribute?.('data-app');
                // Swallow only the LATE re-assert on settings (the fix), never
                // the ordinary focus every window gets as it opens.
                if ( app === 'settings' && window.__settingsOpened ) { window.__focusCalls++; return this; }
                return orig.apply(this, a);
            };
        });
    }
    const btn = await page.evaluate(() => {
        const b = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-settings');
        if ( ! b ) return null;
        const r = b.getBoundingClientRect();
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    });
    if ( ! btn ) return false;
    // Arm the late focus on the DESKTOP, then open Settings inside its window.
    await page.evaluate(() => {
        window.__settingsOpened = true;
        const desk = document.querySelector('.window[data-app="desktop"]');
        setTimeout(() => { try { window.$(desk).focusWindow(); } catch { /* ignore */ } }, 80);
    });
    await page.touchscreen.tap(btn[0], btn[1]);
    await sleep(1600);   // past the 80ms late focus AND the 120ms re-assert
    return true;
}

{
    const L = '[late focus]';
    const { page, context } = await boot({ width: 390, height: 844, dpr: 3 });

    push(`${L} setup: the desktop is full-bleed and owns the top of the stack`,
        (await topWindow(page)).app === 'desktop', JSON.stringify(await topWindow(page)));

    const opened = await openSettingsUnderLateFocus(page);
    push(`${L} setup: the drawer's Settings button exists and was tapped`, opened === true);

    const top = await topWindow(page);
    push(`${L} 🔴 Settings ends up ON TOP even though a late focus fired for the desktop mid-open`,
        top.app === 'settings', JSON.stringify(top));

    const reach = await closeButtonReachable(page);
    push(`${L} 🔴 …and its own close button is what a tap at its centre actually hits`,
        reach.ok === true, reach.why);
    await context.close();
}

// ── BOTH DIRECTIONS ────────────────────────────────────────────────────────
// Without the late re-assert the SAME sequence must bury Settings. If this
// stays green the checks above are proving nothing.
{
    const L = '[late focus mutation]';
    const { page, context } = await boot({ width: 390, height: 844, dpr: 3 });
    const opened = await openSettingsUnderLateFocus(page, { breakFix: true });
    push(`${L} setup: the drawer's Settings button was tapped`, opened === true);

    const top = await topWindow(page);
    const reach = await closeButtonReachable(page);
    push(`${L} 🔴 MUTATION PROOF: without the re-assert the desktop's late focus buries Settings`,
        top.app === 'desktop' || reach.ok === false,
        `top=${JSON.stringify(top)} reach=${reach.why}`);
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
