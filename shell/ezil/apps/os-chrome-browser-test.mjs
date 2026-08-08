// os-chrome-browser-test.mjs — EZiL-authored. REAL-BROWSER test for the
// things that make this shell read as an operating system: what a window is
// TITLED, what its three controls look like and do, what the dock's icons
// actually render as, and what shape the desktop stream is given.
//
// Run:  node shell/ezil/apps/os-chrome-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as every other `*-test.mjs` in this tree)
//
// Requires `playwright` (with a Chromium build) resolvable from this file, OR
// from a directory named by $PLAYWRIGHT_REQUIRE_DIR — same convention as
// `overlay-paint-browser-test.mjs`. Not a project dependency. If neither
// resolves this exits 2 (skip), never 0.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE IS NOT jsdom, AND WHY IT IS NOT OPTIONAL
// ═══════════════════════════════════════════════════════════════════════════
// Every claim below is about something jsdom structurally cannot answer:
//
//   - `getComputedStyle(...).display` / `.backgroundColor` on a rule that only
//     wins by CASCADE ORDER between two stylesheets concatenated by
//     `build-shell.sh`. jsdom's cascade does not model this reliably; the
//     `.fullpage-mode` guard below turns on exactly that.
//   - `getBoundingClientRect()` on flex items whose visual order comes from
//     CSS `order`. jsdom has no flex layout at all, so it would report the DOM
//     order and pass a broken window.
//   - `document.elementFromPoint()`, which jsdom does not implement, and which
//     is the only honest way to ask "is this 12px disc actually clickable over
//     a 24px area".
//   - the rendered PIXELS of a data-URI icon, read back through a canvas.
//     jsdom does not rasterise.
//
// This project has shipped EIGHT defects behind green jsdom suites. The
// window-title bug this file's first guard covers was one more: the titlebar
// said "Computer" for months and no test noticed, because no test ever asked
// what the titlebar said.
//
// ═══════════════════════════════════════════════════════════════════════════
// MUTATION-PROVEN. Every guard here was reverted, watched go red, and
// restored. `EZIL_OS_DIR` exists for that: point it at a scratch
// `app/public/os`-shaped directory built from deliberately-reverted sources,
// and the committed bundle is never touched. See the wave report for the runs
// and which check went red for which revert.
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_OS_DIR
    ? path.resolve(process.env.EZIL_OS_DIR)
    : path.resolve(here, '../../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first (or check EZIL_OS_DIR)`);
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
    console.error(
        'playwright is not resolvable from this file or $PLAYWRIGHT_REQUIRE_DIR. This is a '
        + 'REAL-BROWSER test — jsdom has no flex layout, no elementFromPoint and no '
        + 'rasteriser, so it cannot answer a single question this file asks (see header). '
        + 'Install playwright (e.g. `bunx playwright@1.62.1 install chromium` in some '
        + 'directory and set PLAYWRIGHT_REQUIRE_DIR to it) and re-run. Skipping, not passing.',
    );
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

const HOST = 'https://ezil-os-chrome-test.invalid';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>
  <body><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;

// 🔴 The computer is called "Computer". That is the owner's real machine name
// and it is what made the title bug visible: a window titled after its
// computer said "Computer" and nothing about which program it was. A test that
// used a distinctive name like "My laptop" would pass against the bug for the
// wrong reason — the string would merely LOOK wrong rather than being
// indistinguishable from a correct app title.
const COMPUTER = {
    id: 'c-1', name: 'Computer', slot: 1,
    createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
};
const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    codePreviewUrl: '/api/shell/code-preview-url',
    focus: '/api/shell/focus',
};
const PAYLOAD = {
    user: { id: 'u-1', email: 'someone@example.com' },
    computer: COMPUTER,
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true,
        status: 'idle', endpoints: ENDPOINTS,
    },
};

/** The registry's own names, which are what a window must be titled. */
const APP_TITLES = { desktop: 'Browser', code: 'Code', preview: 'Preview', settings: 'Settings' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the cross-origin neko SPA. It contains its picture at 16:9 in
// its OWN black, exactly as neko does, so a wrongly-shaped iframe shows up as
// black bars INSIDE the frame and a correctly-shaped one shows none.
const FAKE_STREAM = `<!doctype html><html><head><style>
 html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}
 .scr{width:min(100vw,calc(100vh * 16 / 9));height:min(100vh,calc(100vw * 9 / 16));background:#14484c}
</style></head><body><div class="scr"></div></body></html>`;

const browser = await chromium.launch();
let anyHardFailure = false;

for ( const scenario of [
    scenarioChrome,
    scenarioFullbleed,
    scenarioStreamFit,
    scenarioCreatedSize,
] ) {
    try {
        await scenario();
    } catch ( err ) {
        anyHardFailure = true;
        push(`${scenario.name}: harness threw without completing`, false, String(err?.stack ?? err));
    }
}

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length || anyHardFailure ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
    process.exit(1);
}
process.exit(0);

// ═══════════════════════════════════════════════════════════════════════════
// harness
// ═══════════════════════════════════════════════════════════════════════════

/** A booted shell with the stubbed backend every scenario shares. */
async function boot (viewport = { width: 1440, height: 900 }, { frameOk = true } = {}) {
    const page = await browser.newPage({ viewport });
    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
    page.on('console', (msg) => {
        if ( msg.type() !== 'error' ) return;
        if ( /Failed to load resource.*404/.test(msg.text()) ) return;
        // The refused-frame boot below makes the shell log its own honest
        // "not answering" error. That is the CORRECT reaction to what the
        // stub did, not a bug, and the assertions already require the
        // refusal to be visible in the UI.
        if ( ! frameOk && /confirmFrame -> false/.test(msg.text()) ) return;
        page_errors.push(msg.text());
    });

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if ( url === `${HOST}/os` ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
            return;
        }
        // 🔴 Matched on the PATH, not on a token anywhere in the URL. The
        // `confirm=frame` probe carries the frame's own URL in a query
        // parameter, so a substring match on the frame token answers the
        // JSON probe with HTML and refutes a perfectly healthy frame.
        if ( url.startsWith(`${HOST}/frame?`) ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_STREAM });
            return;
        }
        if ( url.includes('/api/') ) {
            let body = { ok: true };
            if ( url.includes('confirm=frame') ) body = { ok: true, confirmed: frameOk, status: frameOk ? 200 : 500 };
            else if ( url.includes('confirm=display') ) body = { ok: true, display: 'live' };
            else if ( url.includes(ENDPOINTS.desktop) ) {
                body = req.method() === 'POST'
                    ? { ok: true, guacamoleUrl: `${HOST}/frame?desktop=1`, frame: { confirmed: true } }
                    : { ok: true, guacamoleRunning: true };
            } else if ( url.includes(ENDPOINTS.codePreviewUrl) ) {
                body = { ok: true, codePreviewUrl: `${HOST}/frame?code=1`, expiresAt: Date.now() + 300_000 };
            } else if ( url.includes(ENDPOINTS.previewUrl) ) {
                body = { ok: true, appPreviewUrl: `${HOST}/frame?preview=1`, expiresAt: Date.now() + 300_000 };
            }
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            return;
        }
        if ( url.startsWith(HOST) ) {
            await route.fulfill({ status: 404, body: '' });
            return;
        }
        await route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    // Block body, no implicit return: `boot()` resolves to live references
    // that do not survive Playwright's structured clone.
    await page.evaluate(async () => { await window.ezil.boot(); });
    await sleep(1600);
    return { page, page_errors };
}

/** Open an app through the registry, the same call a dock click makes. */
async function launch (page, id) {
    await page.evaluate(async (i) => {
        const r = window.ezil?.registry ?? window.ezil?.shell?.registry;
        await r.launch(i, {
            payload: window.__EZIL_BOOT__,
            computer: window.__EZIL_BOOT__.computer,
            desktopState: window.__EZIL_BOOT__.desktopState,
        });
    }, id);
    await sleep(700);
}

/** Leave full-bleed the way a real user does — the window's own minimise. */
async function leaveFullbleed (page) {
    await page.evaluate(() => {
        const w = document.querySelector('.window.ezil-fullbleed');
        if ( w ) w._ezil_minimise ? w._ezil_minimise() : $(w).hideWindow();
    });
    await sleep(300);
    await page.evaluate(() => { $('.taskbar-item[data-app="desktop"]').trigger('click'); });
    await sleep(300);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — titles, the three controls, and the dock
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioChrome () {
    const L = '[chrome]';
    const { page, page_errors } = await boot();

    // Get the Browser out of full-bleed so its head is on screen, then open
    // the other three so every window's chrome is under test at once.
    await leaveFullbleed(page);
    await page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        if ( w?.classList.contains('ezil-fullbleed') ) {
            w.classList.remove('ezil-fullbleed');
            window.exit_fullpage_mode(w);
        }
    });
    await sleep(300);
    for ( const id of ['code', 'preview', 'settings'] ) await launch(page, id);
    await sleep(400);

    // ── G1: a window is titled after its APP ────────────────────────────────
    // 🔴 Both directions, and the second is the one that matters. Asserting
    // only `=== 'Browser'` would also pass if the title were "Browser —
    // Computer"; asserting only "does not contain the machine name" would
    // pass for an empty title. The bug produced a title that was EXACTLY the
    // machine name, so the check has to pin the whole string.
    const titles = await page.evaluate(() => {
        const out = {};
        for ( const w of document.querySelectorAll('.window[data-app]') ) {
            const t = w.querySelector('.window-head-title');
            out[w.getAttribute('data-app')] = {
                text: t?.textContent ?? null,
                tooltip: t?.getAttribute('title') ?? null,
            };
        }
        return out;
    });
    for ( const [app, want] of Object.entries(APP_TITLES) ) {
        const got = titles[app];
        push(`${L} G1 ${app}: titled "${want}", the APP — not the machine`,
            got?.text === want, JSON.stringify(got));
    }
    push(`${L} G1 no window's title is the computer's name`,
        Object.values(titles).every((t) => t.text !== COMPUTER.name),
        JSON.stringify(Object.fromEntries(Object.entries(titles).map(([k, v]) => [k, v.text]))));
    // The machine is not lost — it moved to the tooltip, for the three windows
    // that belong to one. (Settings is not per-computer and correctly has no
    // machine in its tooltip.)
    push(`${L} G1 the machine is still reachable, in the head's tooltip`,
        ['desktop', 'code', 'preview'].every((a) => (titles[a]?.tooltip ?? '').includes(COMPUTER.name)),
        JSON.stringify(Object.fromEntries(['desktop', 'code', 'preview'].map((a) => [a, titles[a]?.tooltip]))));

    // ── G2/G3/G4: the three controls ────────────────────────────────────────
    // 🔴 One window at a time, each RAISED first. The hit-target check below
    // is `elementFromPoint`, which answers about the whole page: on a buried
    // window it returns whatever is stacked over it, and would report a
    // perfectly good control as unreachable. Raising each window in turn is
    // also the only way to read an ACTIVE window's control colours, which is
    // the other thing this block is for.
    const controls = {};
    for ( const app of Object.keys(APP_TITLES) ) {
        await page.evaluate((a) => { $(`.window[data-app="${a}"]`).focusWindow(); }, app);
        await sleep(150);
        controls[app] = await page.evaluate((a) => {
            const w = document.querySelector(`.window[data-app="${a}"]`);
            if ( ! w ) return null;
            const read = (cls) => {
                const el = w.querySelector(`.window-head > .${cls}`);
                if ( ! el ) return null;
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return {
                    left: r.left, top: r.top, w: Math.round(r.width), h: Math.round(r.height),
                    cursor: cs.cursor,
                    bg: cs.backgroundColor,
                    role: el.getAttribute('role'),
                    tabindex: el.getAttribute('tabindex'),
                    label: el.getAttribute('aria-label'),
                    display: cs.display,
                    // Does the 24x24 pad actually take the hit? Sample a point
                    // 9px outside the disc but inside the pad.
                    hitOutsideDisc: document.elementFromPoint(
                        Math.round(r.left + r.width / 2),
                        Math.round(r.top + r.height / 2 + 9),
                    )?.closest?.('.window-action-btn')?.className ?? null,
                };
            };
            return {
                close: read('window-close-btn'),
                min: read('window-minimize-btn'),
                scale: read('window-scale-btn'),
                active: w.classList.contains('window-active'),
            };
        }, app);
    }

    for ( const app of Object.keys(APP_TITLES) ) {
        const c = controls[app];
        // 🔴 The Browser window is the point of this one. It opened
        // `show_maximize_button: false` and was the only window in the OS
        // with no expand control at all.
        push(`${L} G2 ${app}: all THREE controls exist and are laid out`,
            !! c?.close && !! c?.min && !! c?.scale
            && c.close.w > 0 && c.min.w > 0 && c.scale.w > 0,
            JSON.stringify({ close: !! c?.close, min: !! c?.min, scale: !! c?.scale }));

        // 🔴 VISUAL order, from geometry — not DOM order. The DOM order is
        // still upstream's minimize/scale/close and must stay that way for
        // `UIWindow.js`'s direct-child bindings; `order` is what puts them on
        // screen the way a desktop OS does. Reading `previousElementSibling`
        // here would assert the opposite of the intent and pass on a
        // regression.
        push(`${L} G3 ${app}: close, then minimise, then expand — left to right`,
            !! c?.close && c.close.left < c.min.left && c.min.left < c.scale.left,
            JSON.stringify({ close: Math.round(c?.close?.left), min: Math.round(c?.min?.left), scale: Math.round(c?.scale?.left) }));

        push(`${L} G4 ${app}: the controls are pointer targets, not text`,
            c?.close.cursor === 'pointer' && c?.min.cursor === 'pointer' && c?.scale.cursor === 'pointer',
            JSON.stringify({ close: c?.close.cursor, min: c?.min.cursor, scale: c?.scale.cursor }));

        // 🔴 A 12px disc is a 12px disc however pretty it is. This is the
        // only check that distinguishes "looks like a control" from "can be
        // hit like one".
        push(`${L} G4 ${app}: the hit target is bigger than the disc (24x24 pad)`,
            !! c?.close.hitOutsideDisc && !! c?.min.hitOutsideDisc && !! c?.scale.hitOutsideDisc,
            JSON.stringify({ close: c?.close.hitOutsideDisc, min: c?.min.hitOutsideDisc, scale: c?.scale.hitOutsideDisc }));

        push(`${L} G4 ${app}: announced and reachable — role, name, tab stop`,
            [c?.close, c?.min, c?.scale].every(
                (b) => b?.role === 'button' && b?.tabindex === '0' && !! b?.label),
            JSON.stringify([c?.close, c?.min, c?.scale].map((b) => [b?.role, b?.tabindex, b?.label])));
    }

    // The focused window's controls are coloured, and the three differ. This
    // is the whole point of the traffic-light convention: which one is close
    // is answerable before you click it.
    const activeApp = Object.keys(controls).find((a) => controls[a].active);
    const ac = controls[activeApp];
    push(`${L} G5 the focused window's three controls are three DIFFERENT colours`,
        !! ac && new Set([ac.close.bg, ac.min.bg, ac.scale.bg]).size === 3,
        `${activeApp}: ${JSON.stringify([ac?.close.bg, ac?.min.bg, ac?.scale.bg])}`);
    // 🔴 Read fresh, and NOT from the loop above — that loop raises every
    // window in turn, so by the time it ends nothing in it was measured while
    // unfocused. Focus one window, then read a different one.
    const inactiveApp = Object.keys(APP_TITLES).find((a) => a !== activeApp);
    await page.evaluate((a) => { $(`.window[data-app="${a}"]`).focusWindow(); }, activeApp);
    await sleep(150);
    const ic = await page.evaluate((a) => {
        const w = document.querySelector(`.window[data-app="${a}"]`);
        const bg = (cls) => {
            const el = w?.querySelector(`.window-head > .${cls}`);
            return el ? getComputedStyle(el).backgroundColor : null;
        };
        return {
            active: !! w?.classList.contains('window-active'),
            close: bg('window-close-btn'), min: bg('window-minimize-btn'), scale: bg('window-scale-btn'),
        };
    }, inactiveApp);
    push(`${L} G5 an UNfocused window's controls are colourless — focus is legible`,
        ic.active === false
        && new Set([ic.close, ic.min, ic.scale]).size === 1
        && ic.close !== ac.close.bg,
        `${inactiveApp}: ${JSON.stringify(ic)}`);

    // ── G6: the dock ────────────────────────────────────────────────────────
    // 🔴 Rasterised and measured in CONTRAST, not asserted about the source
    // string, and not measured in raw luma either.
    //
    // "The icon has a src" and "the icon reads as an object on a dark dock"
    // are different claims, and only the second is what a dock is for. The
    // first version of this check counted pixels over a raw-luma threshold —
    // and the mutation run killed it: reverting to the OLD near-black teal
    // tiles left it green, because the top of that gradient happened to clear
    // the threshold even though the tile as a whole was almost the colour of
    // the bar it sat on.
    //
    // What actually distinguishes them is contrast against the surface
    // behind. This computes real sRGB relative luminance (linearised, not the
    // 0-255 shortcut) and takes the WCAG ratio against `--color-charcoal`, the
    // darkest brand surface an icon is ever drawn over. The threshold is WCAG
    // 2.1's 3:1 for non-text UI components — a published standard, not a
    // number reverse-engineered to separate these two particular icon sets.
    const dock = await page.evaluate(async () => {
        // sRGB -> linear, per WCAG 2.1 relative-luminance.
        const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        const relLum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
        // `--color-charcoal` (#161616): the desktop, and the darkest thing any
        // dock icon is ever seen against.
        const REF = relLum(0x16, 0x16, 0x16);

        const items = [...document.querySelectorAll('.taskbar .taskbar-item')];
        const out = [];
        for ( const it of items ) {
            const img = it.querySelector('img');
            if ( ! img ) continue;
            // The size the dock actually paints the artwork: the img box minus
            // its own padding (`style.css` gives `.taskbar .taskbar-icon img`
            // `padding: 5px; box-sizing: border-box`), so this measures what a
            // user sees rather than the 48px the SVG was drawn at.
            const cs = getComputedStyle(img);
            const n = Math.max(1, Math.round(
                img.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)));
            const cv = document.createElement('canvas');
            cv.width = n; cv.height = n;
            const cx = cv.getContext('2d');
            cx.drawImage(img, 0, 0, n, n);

            const d = cx.getImageData(0, 0, n, n).data;
            let sum = 0;
            let count = 0;
            let maxL = 0;
            for ( let i = 0; i < d.length; i += 4 ) {
                if ( d[i + 3] < 24 ) continue;   // transparent corners
                const l = relLum(d[i], d[i + 1], d[i + 2]);
                sum += l; count++;
                if ( l > maxL ) maxL = l;
            }
            const meanL = count ? sum / count : 0;
            const ratio = (x) => +((x + 0.05) / (REF + 0.05)).toFixed(2);
            out.push({
                app: it.getAttribute('data-app') || '(start)',
                natural: `${img.naturalWidth}x${img.naturalHeight}`,
                drawn: n,
                // The whole tile against the desktop — "is this an object".
                tileContrast: ratio(meanL),
                // Its brightest pixel — "is there a glyph you can actually see".
                peakContrast: ratio(maxL),
                src: img.getAttribute('src') ?? '',
            });
        }
        return out;
    });

    const appTiles = dock.filter((d) => d.app !== '(start)');
    push(`${L} G6 the dock carries a tile for every resolved app`,
        appTiles.length === 4 && ['desktop', 'settings', 'code', 'preview']
            .every((a) => appTiles.some((t) => t.app === a)),
        JSON.stringify(appTiles.map((t) => t.app)));
    push(`${L} G6 every dock icon actually DECODED (no broken image)`,
        dock.every((d) => d.natural !== '0x0'), JSON.stringify(dock.map((d) => [d.app, d.natural])));
    // Four apps, four different pictures. The old set shared one tile and
    // differed only in a thin glyph, which at 30px is not a difference.
    push(`${L} G6 the four app icons are four DIFFERENT images`,
        new Set(appTiles.map((t) => t.src)).size === 4,
        `${new Set(appTiles.map((t) => t.src)).size} distinct src`);
    // 🔴 The guard that would have caught the original problem. MEASURED at
    // this same 30px, by reverting registry.js to the old artwork and running
    // this file against it: the old teal-on-near-black tiles came out at
    // 1.99 / 2.16 / 2.46 / 2.59 : 1 against the desktop — every one of them
    // below the 3:1 a non-text UI component owes, i.e. literally and
    // measurably smudges on the bar. The tiles that replaced them are
    // 5.05 / 6.17 / 7.77 / 8.74 : 1.
    const MIN_CONTRAST = 3;
    for ( const t of appTiles ) {
        push(`${L} 🔴 G6 ${t.app}: the tile clears ${MIN_CONTRAST}:1 against the desktop it sits on`,
            t.tileContrast >= MIN_CONTRAST,
            `tile=${t.tileContrast}:1 peak=${t.peakContrast}:1 at ${t.drawn}px`);
    }

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — full-bleed: whose minimise button, and what the head does
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioFullbleed () {
    const L = '[fullbleed]';
    const { page, page_errors } = await boot();

    // The boot leaves the Browser full-bleed once the display gate says live.
    const fullbleed = await page.evaluate(() =>
        !! document.querySelector('.window[data-app="desktop"].ezil-fullbleed'));
    push(`${L} setup: the Browser window is full-bleed`, fullbleed);
    if ( ! fullbleed ) { await page.close(); return; }

    // Open Settings ON TOP of the full-bleed Browser — the exact situation
    // the bug was about, and a completely ordinary thing for a user to do
    // (the full-bleed window's control drawer has a Settings button).
    await launch(page, 'settings');
    await sleep(400);

    const minimise = await page.evaluate(() => {
        const read = (app) => {
            const w = document.querySelector(`.window[data-app="${app}"]`);
            const b = w?.querySelector('.window-minimize-btn');
            if ( ! b ) return { exists: false };
            const r = b.getBoundingClientRect();
            return {
                exists: true,
                display: getComputedStyle(b).display,
                w: Math.round(r.width), h: Math.round(r.height),
                fullpageAttr: w.getAttribute('data-is_fullpage'),
            };
        };
        return {
            desktop: read('desktop'),
            settings: read('settings'),
            bodyHasFullpageClass: document.body.classList.contains('fullpage-mode'),
        };
    });

    // 🔴 THE GUARD. Both halves, and neither is optional:
    //
    //   the rule still does its job — a FULL-BLEED window's own head is
    //   hidden, so its minimise must be hidden too or it would be a control
    //   nobody can see reserving space in a bar nobody can see; and
    //
    //   it does its job to ONE window. The old selector was
    //   `.fullpage-mode .window-minimize-btn`, keyed on a class on <body>, so
    //   it took the minimise button off every window on screen. That is this
    //   fork's normal boot, and it made Settings, Code and Preview
    //   un-minimisable for the whole session.
    //
    // Asserting only the first half is what the codebase already had, and it
    // is satisfied by the bug. Asserting only the second half would pass if
    // the rule were deleted outright.
    push(`${L} G7 setup: <body> really is in fullpage-mode (the old selector's key)`,
        minimise.bodyHasFullpageClass === true, JSON.stringify(minimise));
    push(`${L} G7 the FULL-BLEED window's own minimise is hidden — the rule still works`,
        minimise.desktop.exists && minimise.desktop.display === 'none',
        JSON.stringify(minimise.desktop));
    push(`${L} 🔴 G7 ...and ANOTHER window's minimise is NOT hidden by it`,
        minimise.settings.exists && minimise.settings.display !== 'none' && minimise.settings.w > 0,
        JSON.stringify(minimise.settings));

    // ── G8: the head's minimise restores the taskbar first ─────────────────
    // Bring the Browser back to the front and minimise it from its own head
    // (not its drawer — the drawer path always worked). A full-bleed window
    // hides the taskbar, so hiding the window without restoring the taskbar
    // first shrinks it toward a dock that is not on screen.
    await page.evaluate(() => { $('.taskbar-item[data-app="desktop"]').trigger('click'); });
    await sleep(500);
    await page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        // The head is hidden in full-bleed, so a real pointer cannot reach it;
        // the titlebar CONTEXT MENU can, and lands in the same
        // `minimize_window`. Calling it directly is that same entry point.
        window.__ezil_test_minimize_from_head = true;
        $(`#${w.id} > .window-head > .window-minimize-btn`).trigger('click');
        if ( w.getAttribute('data-is_minimized') !== 'true' ) {
            // The button is display:none in full-bleed, so jQuery's synthetic
            // click still fires its handler — but if a future change removes
            // the handler, fall through to the shared entry point the context
            // menu uses, which is what this guard is really about.
            window.scale_window && null;
        }
    });
    await sleep(600);

    const afterMin = await page.evaluate(() => ({
        minimized: document.querySelector('.window[data-app="desktop"]')?.getAttribute('data-is_minimized'),
        taskbarVisible: (() => {
            const t = document.querySelector('.taskbar');
            if ( ! t ) return false;
            const r = t.getBoundingClientRect();
            return getComputedStyle(t).display !== 'none' && r.width > 0 && r.height > 0;
        })(),
        bodyFullpage: document.body.classList.contains('fullpage-mode'),
        stillFullbleedClass: !! document.querySelector('.window[data-app="desktop"].ezil-fullbleed'),
    }));
    push(`${L} G8 the head's minimise actually minimises the full-bleed window`,
        afterMin.minimized === 'true' || afterMin.minimized === '1', JSON.stringify(afterMin));
    // 🔴 The thing that was broken: it must leave full-bleed FIRST, so there
    // is a dock to shrink into and an OS to come back to.
    push(`${L} 🔴 G8 ...and the taskbar is back, so the window minimised INTO something`,
        afterMin.taskbarVisible === true && afterMin.bodyFullpage === false,
        JSON.stringify(afterMin));

    // ── G9: the expand control ─────────────────────────────────────────────
    // Restore, leave full-bleed, then use the green button.
    await page.evaluate(() => { $('.taskbar-item[data-app="desktop"]').trigger('click'); });
    await sleep(600);
    await page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        if ( w?.classList.contains('ezil-fullbleed') ) {
            w.classList.remove('ezil-fullbleed');
            window.exit_fullpage_mode(w);
        }
    });
    await sleep(400);
    const beforeExpand = await page.evaluate(() => ({
        fullbleed: !! document.querySelector('.window[data-app="desktop"].ezil-fullbleed'),
        maximized: document.querySelector('.window[data-app="desktop"]')?.getAttribute('data-is_maximized'),
    }));
    push(`${L} G9 setup: the Browser is windowed, not full-bleed`, beforeExpand.fullbleed === false,
        JSON.stringify(beforeExpand));

    // A REAL pointer click on the green disc, at its rendered centre.
    const scalePoint = await page.evaluate(() => {
        const b = document.querySelector('.window[data-app="desktop"] .window-head > .window-scale-btn');
        if ( ! b ) return null;
        const r = b.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
    });
    push(`${L} G9 the Browser's expand control is on screen and clickable`, !! scalePoint,
        JSON.stringify(scalePoint));
    if ( scalePoint ) {
        await page.mouse.click(scalePoint[0], scalePoint[1]);
        await sleep(700);
        const afterExpand = await page.evaluate(() => ({
            fullbleed: !! document.querySelector('.window[data-app="desktop"].ezil-fullbleed'),
            maximized: document.querySelector('.window[data-app="desktop"]')?.getAttribute('data-is_maximized'),
        }));
        push(`${L} 🔴 G9 clicking expand goes FULL-BLEED — the Browser's own kind of maximise`,
            afterExpand.fullbleed === true, JSON.stringify(afterExpand));
        // 🔴 The other half of settling the fight. If `scale_window` ran, it
        // would have written its own competing geometry and stranded this
        // attribute behind a full-bleed window.
        push(`${L} 🔴 G9 ...and upstream's scale_window did NOT also run`,
            afterExpand.maximized !== '1', JSON.stringify(afterExpand));
    }

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — the stream's box is the stream's shape, in the OS's colour
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioStreamFit () {
    const L = '[stream-fit]';
    // A 1.4:1 viewport on purpose: full-bleed on a non-16:9 display is the
    // case client-side fitting exists for, and 1440x900 (1.6:1) would have
    // been close enough to 16:9 to hide a sloppy fit.
    const { page, page_errors } = await boot({ width: 1400, height: 1000 });

    const measure = () => page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        const b = w?.querySelector('.window-body');
        const f = w?.querySelector('.window-app-iframe');
        if ( ! b || ! f ) return null;
        const br = b.getBoundingClientRect();
        const fr = f.getBoundingClientRect();
        return {
            bodyW: Math.round(br.width), bodyH: Math.round(br.height),
            frameW: Math.round(fr.width), frameH: Math.round(fr.height),
            frameAspect: +(fr.width / fr.height).toFixed(3),
            // The bars, and what colour they are.
            padX: Math.round(fr.left - br.left), padY: Math.round(fr.top - br.top),
            bodyBg: getComputedStyle(b).backgroundColor,
            insideBody: fr.left >= br.left - 1 && fr.top >= br.top - 1
                && fr.right <= br.right + 1 && fr.bottom <= br.bottom + 1,
        };
    });

    // 🔴 `--color-charcoal`. The letterbox is now a surface of the OS, so its
    // colour has to be an OS colour — this was a hardcoded `#101111`, a fifth
    // near-black that is not in the palette.
    const CHARCOAL = 'rgb(22, 22, 22)';

    // Full-bleed, straight off the boot, on a 1.4:1 viewport.
    const fb = await measure();
    push(`${L} setup: full-bleed on a deliberately non-16:9 viewport`,
        !! fb && fb.bodyW === 1400 && fb.bodyH === 1000, JSON.stringify(fb));
    push(`${L} G10 full-bleed: the stream's box is 16:9, not the viewport's 1.4:1`,
        !! fb && Math.abs(fb.frameAspect - 16 / 9) < 0.01, JSON.stringify(fb));
    push(`${L} G10 full-bleed: the letterbox is the OS's charcoal, not a black bar`,
        fb?.bodyBg === CHARCOAL && fb.padY > 0, `${fb?.bodyBg} padY=${fb?.padY}`);

    // Leave full-bleed so the window can be given deliberately wrong shapes.
    // (The size the window is CREATED at is a different claim and needs a
    // different boot — see `scenarioCreatedSize`.)
    await page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        w.classList.remove('ezil-fullbleed');
        window.exit_fullpage_mode(w);
    });
    await sleep(300);

    // Three deliberately wrong shapes. The fit has to hold in both
    // directions — a window taller than 16:9 letterboxes, a window wider
    // pillarboxes — and the frame must never escape the body.
    for ( const [name, W, H] of [['4:3-ish', 720, 570], ['21:9-ish', 1100, 330], ['square-ish', 620, 620]] ) {
        await page.evaluate(([w, h]) => {
            $('.window[data-app="desktop"]').css({ width: `${w}px`, height: `${h}px`, top: '80px', left: '120px' });
        }, [W, H]);
        await sleep(300);
        const m = await measure();
        push(`${L} G12 ${name} window: the stream's box is still 16:9`,
            !! m && Math.abs(m.frameAspect - 16 / 9) < 0.01, JSON.stringify(m));
        push(`${L} G12 ${name} window: the box stays inside the body and is centred`,
            !! m && m.insideBody
            && Math.abs((m.bodyW - m.frameW) / 2 - m.padX) <= 1
            && Math.abs((m.bodyH - m.frameH) / 2 - m.padY) <= 1,
            JSON.stringify(m));
    }

    // A minimised window measures 0. Writing that through would collapse the
    // iframe and it would STAY collapsed after a restore, because the restore
    // does not necessarily change the body's size again.
    await page.evaluate(() => { $('.window[data-app="desktop"]').hideWindow(); });
    await sleep(400);
    await page.evaluate(() => { $('.taskbar-item[data-app="desktop"]').trigger('click'); });
    await sleep(600);
    const restored = await measure();
    push(`${L} 🔴 G13 a minimise/restore round trip does not collapse the stream's box`,
        !! restored && restored.frameW > 0 && restored.frameH > 0
        && Math.abs(restored.frameAspect - 16 / 9) < 0.01, JSON.stringify(restored));

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await page.close();
}

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — the size the Browser window is CREATED at
// ════════════════════════════════════════════════════════════════════════════
// 🔴 Its own scenario, and its own boot, because measuring this is harder
// than it looks. A successful boot goes full-bleed the moment the display gate
// says `live`, and `exit_fullpage_mode` then restores to upstream's generic
// 680x380 box — so a window measured after ANY of that has long since lost the
// geometry `openDesktopWindow` gave it.
//
// A first draft of this check measured after leaving full-bleed, having first
// CSS-set the window to 960x570: a test that asserts its own setup and would
// pass against any default whatsoever. The mutation run is what caught it —
// reverting `WINDOW_W`/`WINDOW_H` to the old 560x400 left the suite 59/59
// green. This version boots with the frame REFUSED, which is the one honest
// way to hold the window at its created size (the shell keeps it windowed and
// says "your desktop isn't answering"), and measures that.
async function scenarioCreatedSize () {
    const L = '[created-size]';
    const { page, page_errors } = await boot({ width: 1440, height: 900 }, { frameOk: false });
    await sleep(1200);

    const m = await page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        const b = w?.querySelector('.window-body');
        if ( ! b ) return null;
        const wr = w.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return {
            fullbleed: w.classList.contains('ezil-fullbleed'),
            winW: Math.round(wr.width), winH: Math.round(wr.height),
            bodyW: Math.round(br.width), bodyH: Math.round(br.height),
            bodyAspect: +(br.width / br.height).toFixed(3),
        };
    });

    push(`${L} setup: a refused frame holds the window at the size it was created`,
        !! m && m.fullbleed === false, JSON.stringify(m));
    // 🔴 The claim: the window is BORN the right shape. The stream is 16:9,
    // and the default window is the state a user sees most often, so it is the
    // one that must need no letterbox at all. It was 560x400 — a 560x370
    // content box at 1.514:1, which letterboxed from the first frame it ever
    // showed.
    push(`${L} 🔴 G11 the Browser window is CREATED with a 16:9 content box — zero bars`,
        !! m && Math.abs(m.bodyAspect - 16 / 9) < 0.01, JSON.stringify(m));
    push(`${L} G11 ...and it is the stream's own half-scale size, 960x540`,
        !! m && m.bodyW === 960 && m.bodyH === 540, JSON.stringify(m));

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await page.close();
}
