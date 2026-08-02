// display-notice-browser-test.mjs — EZiL-authored. REAL-BROWSER regression test
// for the `ready_unverified` strip's geometry.
//
// Run:  node shell/ezil/display-notice-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as boot-test.mjs and the other `*-browser-test.mjs` files)
//
// Requires playwright, resolvable from here or from $PLAYWRIGHT_REQUIRE_DIR.
// Exits 2 (skip), not 0 (pass), if it is not there.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS CANNOT BE jsdom, AND WHY IT IS WORTH A FILE
// ═══════════════════════════════════════════════════════════════════════════
// `boot-test.mjs` already proves the strip EXISTS, is not hidden, carries EZiL
// copy and does not claim ready. jsdom cannot go further: it has no layout, so
// every one of those checks passes just as happily over a strip nobody can
// read.
//
// And nobody could read it. Measured in Chromium at 1280x860, in exactly the
// state this strip is for: the notice sat at `top: 12`..`94.5` with `z-index: 3`
// while the control drawer — which IS the window's titlebar once full-bleed has
// taken the real one away — sat at `top: 0`..`43` with `z-index: 600`. The
// notice's title line runs `25`..`43.8`. So the drawer painted over
// "We couldn't check your display", and the one sentence naming the problem was
// the part that got clipped.
//
// The z-order is not the thing to change: the drawer is the only way out of a
// full-bleed window and nothing may paint over it. The strip moved down. This
// file pins the result as a NON-OVERLAP between two measured rectangles, not as
// a magic number — a future drawer that grows taller fails here rather than
// silently eating the notice again.

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
    console.error('playwright is not resolvable. This is a LAYOUT test — jsdom cannot stand in. Skipping, not passing.');
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

const HOST = 'https://ezil-display-notice-test.invalid';
const DESKTOP_URL = 'https://8181-guac-x-y-nekodesktop.ezil-display-notice-test.invalid/?usr=EZiL&pwd=x&embed=1';
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

const browser = await chromium.launch();
// Three widths: the strip is `max-width: 720px; margin: 0 auto` and the drawer
// is centred too, so they can only ever meet in the middle — but the strip
// WRAPS at narrow widths and gets taller, which is where an offset tuned on one
// viewport goes wrong.
const VIEWPORTS = [
    { width: 1280, height: 860, name: 'desktop' },
    { width: 1024, height: 768, name: 'small laptop' },
    { width: 820, height: 1180, name: 'tablet' },
];

for ( const vp of VIEWPORTS ) {
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if ( url === `${HOST}/os` ) {
            return route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
        }
        if ( url.includes('/api/shell/desktop') && req.method() === 'POST' ) {
            return json({
                ok: true, guacamoleUrl: DESKTOP_URL, controlMode: 'interactive', mode: 'neko',
                frame: { confirmed: true },
            });
        }
        if ( url.includes('confirm=frame') ) return json({ ok: true, confirmed: true });
        // 🔴 A shape the server could not interpret — the ONLY thing that
        // produces `ready_unverified`, which is the only state this strip
        // appears in.
        if ( url.includes('confirm=display') ) return json({ ok: true, display: 'something-we-do-not-recognise' });
        if ( url.includes('/api/shell/desktop') ) return json({ ok: true, guacamoleRunning: true });
        if ( url.includes('/api/') ) return json({ ok: true });
        if ( url.startsWith(HOST) ) return route.fulfill({ status: 404, body: '' });
        return route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    await page.waitForSelector('.ezil-display-notice:not([hidden])', { timeout: 30_000 });
    // The drawer FLASHES open on full-bleed (`_ezil_drawer_flash`) and collapses
    // a few seconds later. Measure while it is OPEN: that is its largest, and a
    // strip that clears the tongue but not the open drawer is still broken.
    await page.evaluate(() => document.querySelector('.ezil-app-drawer')?.classList.remove('collapsed'));
    await page.waitForTimeout(150);

    const m = await page.evaluate(() => {
        const box = (sel) => {
            const el = document.querySelector(sel);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height };
        };
        const text = document.querySelector('.ezil-display-notice-text');
        return {
            notice: box('.ezil-display-notice'),
            title: box('.ezil-display-notice-title'),
            drawer: box('.ezil-app-drawer'),
            retry: box('.ezil-display-notice-retry'),
            fullbleed: !! document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
            clipped: text ? text.scrollHeight > text.clientHeight + 1 : true,
            viewportH: window.innerHeight,
        };
    });
    await page.close();

    const tag = `${vp.name} ${vp.width}x${vp.height}`;
    push(`${tag}: the desktop is revealed with the strip over it`, m.fullbleed && !! m.notice);

    const overlaps = m.notice && m.drawer
        && m.notice.top < m.drawer.bottom && m.notice.bottom > m.drawer.top
        && m.notice.left < m.drawer.right && m.notice.right > m.drawer.left;
    push(`🔴 ${tag}: the control drawer does not paint over the notice`,
        m.drawer ? ! overlaps : false,
        m.drawer ? `notice ${m.notice.top.toFixed(0)}..${m.notice.bottom.toFixed(0)}`
            + ` vs drawer ${m.drawer.top.toFixed(0)}..${m.drawer.bottom.toFixed(0)}` : 'no drawer');
    push(`🔴 ${tag}: the title line is below the drawer, not under it`,
        !! m.title && !! m.drawer && m.title.top >= m.drawer.bottom,
        `title top ${m.title?.top.toFixed(0)} vs drawer bottom ${m.drawer?.bottom.toFixed(0)}`);
    push(`${tag}: no line of the notice is clipped by its own box`, ! m.clipped);
    push(`${tag}: ...and the Retry it offers is on screen`,
        !! m.retry && m.retry.bottom <= m.viewportH && m.retry.top >= 0,
        `retry ${m.retry?.top.toFixed(0)}..${m.retry?.bottom.toFixed(0)} of ${m.viewportH}`);
}

await browser.close();
const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
