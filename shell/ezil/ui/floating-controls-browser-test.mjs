// EZiL-authored. Browser acceptance for docs/FEEDBACK-CONTROLS-CONTRACT.md.
// Tests the committed bundle, including its real CSS and window manager.
// Run after integration/build: node shell/ezil/ui/floating-controls-browser-test.mjs
// PLAYWRIGHT_REQUIRE_DIR supplies an external Playwright install; EZIL_OS_DIR
// optionally selects another built bundle. Exit 0 PASS / 1 FAIL / 2 SKIP.
// Only the backend, media transport, hybrid media query and Fullscreen API
// are fixtures. No drawer implementation, focus handling or layout is mocked.

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
        console.error(`SKIP  missing ${path.join(OS, f)} — run shell/build-shell.sh first (or check EZIL_OS_DIR)`);
        process.exit(2);
    }
}

let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    if ( process.env.PLAYWRIGHT_REQUIRE_DIR ) {
        try {
            const req = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'noop.js'));
            ({ chromium } = req('playwright'));
        } catch (err) {
            console.error(`playwright not found via PLAYWRIGHT_REQUIRE_DIR: ${err.message}`);
        }
    }
}
if ( ! chromium ) {
    console.error('SKIP  playwright is not resolvable here or via PLAYWRIGHT_REQUIRE_DIR; real Chromium layout and input are required.');
    process.exit(2);
}

const checks = [];
function push (name, pass, detail = '') {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (value) => JSON.stringify(value);
async function eventually (name, read, accept, timeout = 4000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
        value = await read();
        if ( accept(value) ) return push(name, true, describe(value));
        await sleep(50);
    } while ( Date.now() < deadline );
    return push(name, false, describe(value));
}

const icons = fs.readFileSync(path.join(OS, 'icons.js'), 'utf8');
const bundle = fs.readFileSync(path.join(OS, 'bundle.min.js'), 'utf8');
const css = fs.readFileSync(path.join(OS, 'bundle.min.css'), 'utf8');
const HOST = 'https://ezil-floating-controls-test.invalid';
const DOC_HTML = `<!doctype html><html class="h-full"><head>
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <style>${css}</style><style>html{height:100%}body{min-height:100%;margin:0}</style>
 </head><body class="min-h-full"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;
const COMPUTER = {
    id: 'c-1', name: 'Computer', slot: 1,
    createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
};
const ENDPOINTS = {
    session: '/api/shell/session', desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url', codePreviewUrl: '/api/shell/code-preview-url',
    focus: '/api/shell/focus', activity: '/api/shell/activity',
};
const SCREEN_ENDPOINT = '/api/shell/screen';
const WIN = '.window[data-app="desktop"]';
const DRAWER = `${WIN} .ezil-floating-drawer`;
// The contract pins aria-expanded, but does not give the grabber a class.
// Menu triggers have their own aria-haspopup and must not be mistaken for it.
const GRABBER = `${DRAWER} button[aria-expanded]:not([aria-haspopup])`;
const RED = `${DRAWER} .dashboard-app-drawer-close`;
const YELLOW = `${DRAWER} .dashboard-app-drawer-minimize`;
const GREEN = `${DRAWER} .ezil-traffic-expand`;
const PHONE = {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

// Same independent server mode table / snapping rule as mobile-browser-test.
const SCREEN_MODES = [
    [1920, 1080], [1600, 900], [1280, 720], [1440, 900], [1280, 800], [1024, 768],
    [1280, 1024], [1200, 1600], [1080, 1920], [896, 1600], [720, 1280], [768, 1024],
];
function snapScreen (asked) {
    if ( ! asked || ! (asked.width > 0) || ! (asked.height > 0) ) return null;
    const modes = SCREEN_MODES.slice().sort(([aw, ah], [bw, bh]) =>
        Math.abs(aw / ah - asked.width / asked.height) - Math.abs(bw / bh - asked.width / asked.height)
        || Math.abs(aw * ah - asked.width * asked.height) - Math.abs(bw * bh - asked.width * asked.height));
    const [width, height] = modes[0];
    return { width, height, source: width === asked.width && height === asked.height ? 'requested' : 'snapped' };
}
function fakeStream ({ width, height }) {
    return `<!doctype html><html><head><style>
      html,body{margin:0;height:100%;background:#161616}
      .scr{width:100%;height:100%;background:#14484c}
      </style></head><body><div class="scr"></div><script>
      window.__hits = [];
      for (const type of ['pointerdown','touchstart','mousedown','click']) {
        window.addEventListener(type, () => window.__hits.push(type), true);
      }
      let framesDecoded = 0;
      setInterval(() => {
        framesDecoded++;
        parent.postMessage({source:'ezil-mobile', type:'stream_vitals',
          attempt:new URL(location.href).searchParams.get('ezilAttempt'),
          vitals:{connectionState:'connected', framesDecoded, bytesReceived:framesDecoded*100,
            width:${width}, height:${height}}}, location.origin);
      }, 100);
      </script></body></html>`;
}

async function boot (ctx, options, errors) {
    const page = await ctx.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', (err) => errors.push(String(err)));
    const requests = [];
    let applied = { width: 1280, height: 720, source: 'observed' };
    // Install BEFORE the bundle's self-boot. The Fullscreen fixture changes
    // only browser state and emits its event; the shell must wire the green
    // control and react to fullscreenchange itself.
    await page.addInitScript(({ hybrid }) => {
        let fullscreenElement = null;
        window.__fullscreenCalls = { enter: 0, exit: 0 };
        Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, get: () => true });
        Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
        // On the prototype: init scripts run before <html> exists, so
        // document.documentElement is still null here.
        Element.prototype.requestFullscreen = async function () {
            window.__fullscreenCalls.enter++;
            fullscreenElement = this;
            document.dispatchEvent(new Event('fullscreenchange'));
        };
        document.exitFullscreen = async () => {
            window.__fullscreenCalls.exit++;
            fullscreenElement = null;
            document.dispatchEvent(new Event('fullscreenchange'));
        };
        if ( hybrid ) {
            const nativeMatchMedia = window.matchMedia.bind(window);
            window.matchMedia = (query) => {
                // Leave primary pointer, hover, device detection and every
                // unrelated query native. Also covers combined media queries.
                const effective = query.replace(/\(\s*any-pointer\s*:\s*coarse\s*\)/gi, '(min-width: 0px)');
                const result = nativeMatchMedia(effective);
                if ( effective !== query ) Object.defineProperty(result, 'media', { value: query });
                return result;
            };
        }
    }, { hybrid: !! options.hybrid });

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        let body = null;
        try { body = req.postDataJSON(); } catch { /* GET or non-JSON resource */ }
        if ( url.origin === HOST && url.pathname.startsWith('/api/') ) {
            requests.push({ path: url.pathname, method: req.method(), body, at: Date.now() });
        }
        const json = (data) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
        if ( url.origin === HOST && url.pathname === '/os' ) {
            return route.fulfill({ contentType: 'text/html', body: DOC_HTML });
        }
        // Match the actual path, never a frame URL inside confirm=frame's query.
        if ( url.origin === HOST && url.pathname === '/frame' ) {
            return route.fulfill({ contentType: 'text/html', body: fakeStream(applied) });
        }
        if ( url.origin === HOST && url.pathname.startsWith('/api/') ) {
            if ( url.searchParams.get('confirm') === 'frame' ) return json({ ok: true, confirmed: true, status: 200 });
            if ( url.searchParams.get('confirm') === 'display' ) return json({ ok: true, display: 'live' });
            if ( url.pathname === SCREEN_ENDPOINT ) {
                if ( req.method() === 'POST' ) applied = snapScreen(body) ?? applied;
                return json({ ok: true, ...applied });
            }
            if ( url.pathname === ENDPOINTS.desktop ) {
                if ( req.method() !== 'POST' ) return json({ ok: true, guacamoleRunning: true });
                const screen = options.legacy ? null : snapScreen(body?.screen);
                if ( screen ) applied = screen;
                return json({ ok: true, guacamoleUrl: `${HOST}/frame?desktop=1`,
                    frame: { confirmed: true }, controlMode: 'interactive', mode: 'neko',
                    ...(screen ? { screen } : {}) });
            }
            if ( url.pathname === ENDPOINTS.previewUrl ) return json({ ok: true, appPreviewUrl: `${HOST}/frame?preview=1`, expiresAt: Date.now() + 300_000 });
            if ( url.pathname === ENDPOINTS.codePreviewUrl ) return json({ ok: true, codePreviewUrl: `${HOST}/frame?code=1`, expiresAt: Date.now() + 300_000 });
            return json({ ok: true });
        }
        // Fixtures never need live services or external resource downloads.
        return route.fulfill({ status: 404, body: '' });
    });
    const payload = {
        user: { id: 'u-1', email: 'someone@example.com' }, computer: COMPUTER,
        apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
        desktopState: {
            provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { ...ENDPOINTS, ...(options.screen ? { screen: SCREEN_ENDPOINT } : {}) },
            ...(options.flag === 'absent' ? {} : { ui: { floatingControls: options.flag !== false } }),
        },
    };
    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, payload);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(async () => { await window.ezil.boot(); });
    await page.locator('.taskbar-item[data-app="desktop"]').waitFor();
    await page.evaluate(() => { $('.taskbar-item[data-app="desktop"]').trigger('click'); });
    await page.locator(`${WIN}.ezil-fullbleed .window-app-iframe`).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForFunction((sel) => {
        const frame = document.querySelector(`${sel} .window-app-iframe`);
        return frame?.contentWindow?.__hits !== undefined;
    }, WIN);
    // Let boot/full-bleed geometry and the initial screen debounce settle.
    await sleep(900);
    return { page, requests };
}

function geometry (page) {
    return page.evaluate((sel) => {
        const w = document.querySelector(sel);
        const rect = (el) => {
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
        };
        const body = w?.querySelector('.window-body-app');
        return { win: rect(w), body: rect(body), drawer: rect(w?.querySelector('.ezil-app-drawer')),
            frame: rect(w?.querySelector('.window-app-iframe')), bodyBg: body ? getComputedStyle(body).backgroundColor : null };
    }, WIN);
}
async function expanded (page) { return page.locator(GRABBER).getAttribute('aria-expanded'); }
async function collapse (page) {
    await page.mouse.move(5, 800);
    await page.evaluate((sel) => {
        document.activeElement?.blur();
        const drawer = document.querySelector(sel);
        if ( ! drawer?.ezil_controls ) throw new Error('Contract API drawer.ezil_controls is missing');
        drawer.ezil_controls.collapse();
    }, DRAWER);
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'false', GRABBER);
    await sleep(250);
}
async function reveal (page) {
    // Use a public contract method only to arrange cases whose subject is
    // another control. Hover and keyboard scenarios reveal with real input.
    await page.evaluate((sel) => document.querySelector(sel).ezil_controls.reveal(), DRAWER);
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('aria-expanded') === 'true', GRABBER);
}
function overflow (page) {
    // No overflow class is pinned; select the specified visible ellipsis.
    return page.locator(DRAWER).getByRole('button').filter({ hasText: /^\s*(?:⋯|…|\.{3})\s*$/ });
}

// Measure effective targets just like mobile-browser-test: a hit belongs to
// the button or its descendants ONLY. Ancestors would inflate a target to
// the entire drawer. Keep the four edges for the collapsed-tongue test.
function hitBox (page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if ( ! el ) return null;
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const owns = (x, y) => {
            const hit = document.elementFromPoint(x, y);
            return !! hit && (hit === el || el.contains(hit));
        };
        if ( r.width <= 0 || r.height <= 0 || ! owns(cx, cy) ) return { width: 0, height: 0, reason: 'empty or covered centre' };
        const walk = (dx, dy) => {
            let n = 0;
            while ( n < Math.max(innerWidth, innerHeight) && owns(cx + dx * (n + 1), cy + dy * (n + 1)) ) n++;
            return n;
        };
        const left = cx - walk(-1, 0), right = cx + walk(1, 0);
        const top = cy - walk(0, -1), bottom = cy + walk(0, 1);
        return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1 };
    }, selector);
}
function sameBody (a, b) {
    return !! a && !! b && ['left', 'top', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= 1);
}
function releases (requests) {
    // Heartbeats use the same endpoint. A >=10 minute presence age is the
    // existing close/release signal (desktop-close-test pins this boundary).
    return requests.filter((r) => r.path === ENDPOINTS.activity && r.method === 'POST'
        && Number(r.body?.lastInputAgoMs) >= 10 * 60_000);
}
function screenPosts (requests) { return requests.filter((r) => r.path === SCREEN_ENDPOINT && r.method === 'POST'); }

let legacyGeometry;
async function legacyCase ({ page }, label) {
    push(`${label}: no floating drawer or window hook`, await page.locator('.ezil-floating-drawer, .ezil-floating-controls').count() === 0);
    // Exactly the os-chrome scenarioStreamFit setup and its 1400x1000
    // viewport, without negotiating a new screen size in the boot response.
    await page.evaluate((sel) => document.querySelector(`${sel} .ezil-app-drawer`).classList.remove('collapsed'), WIN);
    await sleep(250);
    const m = await geometry(page);
    push(`${label}: legacy reserved strip geometry (os-chrome parity)`,
        !! m.body && !! m.drawer && Math.round(m.body.width) === 1400
        && Math.round(m.body.height) > 900 && Math.round(m.body.height) < 1000
        && Math.round(m.drawer.top) >= 0 && Math.round(m.drawer.bottom) <= Math.round(m.body.top), describe(m));
    push(`${label}: legacy stream stays contained at 16:9 with charcoal letterboxing`,
        !! m.frame && !! m.body && Math.abs(m.frame.width / m.frame.height - 16 / 9) < 0.01
        && m.bodyBg === 'rgb(22, 22, 22)' && m.frame.top > m.body.top
        && m.frame.left >= m.body.left - 1 && m.frame.top >= m.body.top - 1
        && m.frame.right <= m.body.right + 1 && m.frame.bottom <= m.body.bottom + 1, describe(m));
    if ( legacyGeometry ) push(`${label}: absent and false flags have identical geometry`,
        sameBody(m.body, legacyGeometry.body) && sameBody(m.drawer, legacyGeometry.drawer) && sameBody(m.frame, legacyGeometry.frame), describe(m));
    else legacyGeometry = m;
}

async function overlayCase ({ page }, label) {
    const media = await page.evaluate(() => ({ fine: matchMedia('(pointer: fine)').matches,
        hover: matchMedia('(hover: hover)').matches, anyCoarse: matchMedia('(any-pointer: coarse)').matches,
        desktop: document.body.classList.contains('device-desktop'), width: innerWidth, height: innerHeight }));
    push(`${label}: setup is a 1440x900 desktop with fine pointer and hover only`,
        media.fine && media.hover && ! media.anyCoarse && media.desktop && media.width === 1440 && media.height === 900, describe(media));
    push(`${label}: floating window and overlay drawer hooks`,
        await page.locator(`${WIN}.ezil-floating-controls .ezil-floating-drawer.ezil-mode-overlay`).count() === 1
        && await page.locator(`${DRAWER}.ezil-mode-strip`).count() === 0);
    await collapse(page);
    const before = await geometry(page);
    push(`${label}: body starts at window top with no reserved strip`,
        !! before.body && Math.abs(before.body.top - before.win.top) <= 1, describe(before));
    const hit = await hitBox(page, GRABBER);
    push(`${label}: collapsed tongue hit box stays within visible drawer plus 4px per side`,
        !! hit && hit.width > 0 && hit.height > 0 && !! before.drawer
        && hit.left >= before.drawer.left - 4 && hit.right <= before.drawer.right + 4
        && hit.top >= before.drawer.top - 4 && hit.bottom <= before.drawer.bottom + 4,
        describe({ hit, visible: before.drawer }));
    // Also sample outside the tongue: a large transparent ancestor can own
    // input without contributing to the grabber's own hit rectangle.
    const blockers = await page.evaluate((sel) => {
        const d = document.querySelector(sel), r = d.getBoundingClientRect(), bad = [];
        for ( let y = Math.max(0, Math.floor(r.top - 8)); y < Math.min(innerHeight, r.bottom + 40); y += 2 ) {
            for ( let x = 1; x < innerWidth; x += 4 ) {
                if ( x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4 ) continue;
                const hit = document.elementFromPoint(x, y);
                if ( hit && (hit === d || d.contains(hit)) && bad.length < 5 ) bad.push({ x, y, tag: hit.tagName });
            }
        }
        return bad;
    }, DRAWER);
    push(`${label}: no invisible drawer pad intercepts input beyond the tongue`, blockers.length === 0, describe(blockers));
    const collapsedRed = await hitBox(page, RED);
    push(`${label}: collapsed pill controls cannot intercept input`, collapsedRed?.width === 0 && collapsedRed?.height === 0, describe(collapsedRed));
    await page.locator(GRABBER).hover();
    await eventually(`${label}: hovering the tongue reveals the pill`, () => expanded(page), (v) => v === 'true');
    await sleep(250);
    const redHit = await hitBox(page, RED);
    push(`${label}: revealed traffic light is hit-testable`, redHit?.width > 0 && redHit?.height > 0, describe(redHit));
    push(`${label}: reveal does not resize the stream body`, sameBody(before.body, (await geometry(page)).body));
    // Observe the actual ARIA change so polling latency cannot make a short
    // (e.g. 900ms legacy) timer look like the required ~1.5s timer.
    await page.evaluate((sel) => {
        const g = document.querySelector(sel);
        window.__collapseTiming = { start: performance.now(), elapsed: null };
        const observer = new MutationObserver(() => {
            if ( g.getAttribute('aria-expanded') === 'false' ) {
                window.__collapseTiming.elapsed = performance.now() - window.__collapseTiming.start;
                observer.disconnect();
            }
        });
        observer.observe(g, { attributes: true, attributeFilter: ['aria-expanded'] });
    }, GRABBER);
    await page.mouse.move(5, 800);
    await eventually(`${label}: leaving hides the pill`, () => expanded(page), (v) => v === 'false', 2800);
    const timing = await page.evaluate(() => window.__collapseTiming.elapsed);
    push(`${label}: hide delay is approximately 1.5s (1100–2400ms)`, timing >= 1100 && timing <= 2400, `${timing}ms`);
    await sleep(250);
    const hiddenRed = await hitBox(page, RED);
    push(`${label}: auto-hide retracts the controls without resizing the body`,
        hiddenRed?.width === 0 && hiddenRed?.height === 0 && sameBody(before.body, (await geometry(page)).body), describe(hiddenRed));
    await page.locator(GRABBER).hover();
    await page.locator(RED).focus();
    await page.mouse.move(5, 800);
    await sleep(2100);
    push(`${label}: focus inside prevents auto-hide`, await expanded(page) === 'true' && await page.locator(RED).evaluate((el) => el === document.activeElement));
    await overflow(page).click();
    await page.getByRole('menu').waitFor({ state: 'visible' });
    await page.mouse.move(5, 800);
    await sleep(2100);
    push(`${label}: an open menu prevents auto-hide`, await expanded(page) === 'true' && await page.getByRole('menu').isVisible());
}

async function trafficCase ({ page }, label) {
    await reveal(page);
    for ( const [name, selector] of [['red Close', RED], ['yellow Minimise', YELLOW], ['green Fullscreen', GREEN]] ) {
        const b = page.locator(selector);
        push(`${label}: ${name} has its contract hook and a nonempty aria-label`,
            await b.count() === 1 && !! (await b.getAttribute('aria-label'))?.trim());
    }
    push(`${label}: red and yellow keep the shared button hook`,
        await page.locator(`${RED}.dashboard-app-drawer-btn, ${YELLOW}.dashboard-app-drawer-btn`).count() === 2);
    push(`${label}: green starts with aria-pressed=false`, await page.locator(GREEN).getAttribute('aria-pressed') === 'false');
    push(`${label}: status is a polite live region`, await page.locator(`${DRAWER} .ezil-drawer-status[aria-live="polite"]`).count() === 1);
    push(`${label}: Settings is not exposed until overflow opens`, ! await page.locator(`${DRAWER} .dashboard-app-drawer-settings`).isVisible());
    await overflow(page).click();
    await page.getByRole('menu').waitFor({ state: 'visible' });
    push(`${label}: ellipsis opens role=menu containing Settings`,
        await page.getByRole('menu').locator('.dashboard-app-drawer-settings').isVisible());
}

async function keyboardCase ({ page }, label) {
    await collapse(page);
    // A blur alone retains Chromium's last sequential-navigation position.
    // Focusing the document body resets it without adding a tabbable control.
    await page.evaluate(() => {
        const old = document.body.getAttribute('tabindex');
        document.body.tabIndex = -1;
        document.body.focus();
        if ( old === null ) document.body.removeAttribute('tabindex');
        else document.body.setAttribute('tabindex', old);
        getSelection()?.removeAllRanges();
    });
    await page.keyboard.press('Tab');
    push(`${label}: first Tab from document start lands on grabber in full-bleed`,
        await page.locator(`${WIN}.ezil-fullbleed`).count() === 1
        && await page.locator(GRABBER).evaluate((el) => el === document.activeElement));
    await page.keyboard.press('Enter');
    await eventually(`${label}: Enter reveals controls`, () => expanded(page), (v) => v === 'true');
    const toolbarState = () => page.locator(DRAWER).getByRole('toolbar').evaluate((toolbar) => {
        const buttons = [...toolbar.querySelectorAll('button, [role="button"]')].filter((el) => {
            const r = el.getBoundingClientRect(), s = getComputedStyle(el);
            return ! el.disabled && r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
        });
        return { count: buttons.length, index: buttons.indexOf(document.activeElement),
            stops: buttons.filter((el) => el.tabIndex === 0).length };
    });
    if ( (await toolbarState()).index < 0 ) await page.keyboard.press('Tab');
    const start = await toolbarState();
    push(`${label}: toolbar has one roving Tab stop and receives focus`, start.count >= 3 && start.stops === 1 && start.index >= 0, describe(start));
    await page.keyboard.press('ArrowRight');
    const right = await toolbarState();
    push(`${label}: Right roves to the next toolbar control`, right.index === (start.index + 1) % start.count && right.stops === 1, describe(right));
    await page.keyboard.press('ArrowLeft');
    const left = await toolbarState();
    push(`${label}: Left roves back`, left.index === start.index && left.stops === 1, describe(left));
    await page.keyboard.press('End');
    const end = await toolbarState();
    push(`${label}: End reaches the last toolbar control`, end.index === end.count - 1, describe(end));
    await page.keyboard.press('Home');
    const home = await toolbarState();
    push(`${label}: Home reaches the first toolbar control`, home.index === 0, describe(home));
    await page.keyboard.press('Escape');
    await eventually(`${label}: Escape collapses`, () => expanded(page), (v) => v === 'false');
    push(`${label}: Escape restores grabber focus`, await page.locator(GRABBER).evaluate((el) => el === document.activeElement));
}

async function phoneCase ({ page }, label) {
    const media = await page.evaluate(() => ({ coarse: matchMedia('(pointer: coarse)').matches,
        hover: matchMedia('(hover: hover)').matches, phone: document.body.classList.contains('device-phone'),
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
    push(`${label}: setup is a coarse, touch-only iPhone-class viewport`, media.coarse && ! media.hover && media.phone
        && media.width === 390 && media.height === 844 && media.dpr === 3, describe(media));
    push(`${label}: phone uses strip mode`, await page.locator(`${DRAWER}.ezil-mode-strip`).count() === 1
        && await page.locator(`${DRAWER}.ezil-mode-overlay`).count() === 0);
    await reveal(page);
    await sleep(250);
    for ( const [name, selector] of [['red', RED], ['yellow', YELLOW], ['green', GREEN]] ) {
        const target = await hitBox(page, selector);
        push(`${label}: ${name} has a real >=44x44px touch target`, target?.width >= 44 && target?.height >= 44, describe(target));
    }
    const initialBody = (await geometry(page)).body;
    for ( const state of ['expanded', 'collapsed'] ) {
        if ( state === 'collapsed' ) await collapse(page);
        const point = await page.evaluate((sel) => {
            const w = document.querySelector(sel), f = w.querySelector('.window-app-iframe');
            const r = f.getBoundingClientRect(), d = w.querySelector('.ezil-floating-drawer').getBoundingClientRect();
            const b = w.querySelector('.window-body-app').getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + 28);
            const hit = document.elementFromPoint(x, y);
            return { x, y, hitsIframe: hit === f, hit: hit?.tagName,
                drawerTop: d.top, drawerBottom: d.bottom, bodyTop: b.top, windowBottom: w.getBoundingClientRect().bottom };
        }, WIN);
        push(`${label}: ${state} strip leaves remote address-bar point owned ONLY by iframe (#90)`,
            point.hitsIframe && point.drawerTop >= 0 && point.drawerBottom <= point.bodyTop + 1
            && point.drawerBottom <= point.windowBottom + 1, describe(point));
        const frame = page.frames().find((f) => new URL(f.url()).pathname === '/frame');
        if ( ! frame ) throw new Error('Fake desktop frame is missing');
        await frame.evaluate(() => { window.__hits = []; });
        // Unforced coordinate tap: locator.tap({force:true}) would bypass the
        // exact parent hit testing that caused the deployed address-bar bug.
        await page.touchscreen.tap(point.x, point.y);
        const hits = await frame.evaluate(() => window.__hits.slice());
        push(`${label}: ${state} address-bar tap really reaches the stream`, hits.includes('touchstart') || hits.includes('pointerdown'), describe(hits));
    }
    push(`${label}: expanding/collapsing strip preserves the stream body`, sameBody(initialBody, (await geometry(page)).body));
}

async function hybridCase ({ page }, label) {
    const media = await page.evaluate(() => ({ fine: matchMedia('(pointer: fine)').matches,
        hover: matchMedia('(hover: hover)').matches, coarse: matchMedia('(any-pointer: coarse)').matches,
        desktop: document.body.classList.contains('device-desktop') }));
    push(`${label}: setup retains desktop/fine/hover plus any-pointer:coarse`, media.fine && media.hover && media.coarse && media.desktop, describe(media));
    push(`${label}: secondary coarse pointer forces strip mode`, await page.locator(`${DRAWER}.ezil-mode-strip`).count() === 1
        && await page.locator(`${DRAWER}.ezil-mode-overlay`).count() === 0);
    await reveal(page);
    await sleep(250);
    const m = await geometry(page);
    push(`${label}: strip remains reserved above the stream`, !! m.drawer && !! m.body
        && m.body.top > m.win.top && m.drawer.bottom <= m.body.top + 1, describe(m));
}

async function fullscreenCase ({ page, requests }, label) {
    await reveal(page);
    push(`${label}: green starts unpressed`, await page.locator(GREEN).getAttribute('aria-pressed') === 'false');
    const baseline = screenPosts(requests).length;
    await page.locator(GREEN).click();
    await eventually(`${label}: green enters fullscreen and becomes pressed`, async () => ({
        pressed: await page.locator(GREEN).getAttribute('aria-pressed'),
        state: await page.evaluate(() => ({ root: document.fullscreenElement === document.documentElement, ...window.__fullscreenCalls })),
    }), (v) => v.pressed === 'true' && v.state.root && v.state.enter === 1);
    // Include the fullscreenchange in this burst's observation window. Real
    // geometry changes prevent a disconnected controller satisfying <=1 with 0.
    let lastResize;
    const sizes = [[1380, 860], [1320, 820], [1240, 780], [1100, 740]];
    for ( const [index, [width, height]] of sizes.entries() ) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => {
            for ( let n = 0; n < 5; n++ ) window.dispatchEvent(new Event('resize'));
        });
        lastResize = Date.now();
        if ( index < sizes.length - 1 ) await sleep(60);
    }
    await eventually(`${label}: changed viewport reaches the screen endpoint (positive control)`,
        () => screenPosts(requests).slice(baseline), (v) => v.length > 0, 4500);
    // Retain the observation window to catch a second delayed POST too.
    await sleep(1200);
    const posts = screenPosts(requests).slice(baseline);
    push(`${label}: resize burst produces at most ONE screen POST`, posts.length <= 1, describe(posts));
    push(`${label}: screen POST follows at least 500ms resize quiet (50ms transport allowance)`,
        posts.length === 1 && posts[0].at - lastResize >= 450, describe(posts.map((p) => p.at - lastResize)));
    await reveal(page);
    await page.locator(GREEN).click();
    await eventually(`${label}: green exits fullscreen and clears aria-pressed`, async () => ({
        pressed: await page.locator(GREEN).getAttribute('aria-pressed'),
        state: await page.evaluate(() => ({ exited: document.fullscreenElement === null, ...window.__fullscreenCalls })),
    }), (v) => v.pressed === 'false' && v.state.exited && v.state.exit === 1);
    // A browser-originated change (e.g. browser Escape) must update ARIA too.
    await page.evaluate(() => document.documentElement.requestFullscreen());
    await eventually(`${label}: external fullscreenchange updates green`, () => page.locator(GREEN).getAttribute('aria-pressed'), (v) => v === 'true');
    await page.evaluate(() => document.exitFullscreen());
    await eventually(`${label}: external exit clears green`, () => page.locator(GREEN).getAttribute('aria-pressed'), (v) => v === 'false');
}

async function closeCase ({ page, requests }, label, action) {
    push(`${label}: setup has one unshared computer window`, await page.locator('.window').count() === 1
        && await page.evaluate(() => localStorage.getItem('ezil:close-confirm:skip')) === null);
    await reveal(page);
    await page.locator(RED).click();
    const dialog = page.getByRole('dialog').or(page.getByRole('alertdialog'));
    await dialog.waitFor({ state: 'visible' });
    push(`${label}: red opens a dialog before sending a release`, await dialog.isVisible() && releases(requests).length === 0);
    if ( action === 'cancel' ) {
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await sleep(350);
        push(`${label}: Escape cancels without releasing or minimising`, releases(requests).length === 0
            && await page.locator(WIN).isVisible()
            && ! ['1', 'true'].includes(await page.locator(WIN).getAttribute('data-is_minimized')));
    } else if ( action === 'minimize' ) {
        await dialog.getByRole('button', { name: /^Minimise instead$/i }).click();
        await dialog.waitFor({ state: 'hidden' });
        await eventually(`${label}: Minimise instead minimises the existing window`,
            () => page.locator(WIN).getAttribute('data-is_minimized'), (v) => ['1', 'true'].includes(v));
        await sleep(350);
        push(`${label}: minimising sends no release and restores the taskbar`, releases(requests).length === 0
            && await page.locator(WIN).count() === 1 && await page.locator('.taskbar').isVisible());
    } else {
        await dialog.getByRole('button', { name: /^Close$/i }).click();
        await eventually(`${label}: confirmed Close sends the existing release request`, () => releases(requests), (v) => v.length > 0);
        await page.locator(WIN).waitFor({ state: 'detached' });
        const sent = releases(requests);
        push(`${label}: Close releases exactly once for this computer and removes the window`,
            sent.length === 1 && sent[0].body.computerId === COMPUTER.id && await page.locator(WIN).count() === 0, describe(sent));
    }
}

async function reducedMotionCase ({ page }, label) {
    push(`${label}: reduced-motion media preference is active`, await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
    for ( const state of ['collapsed', 'expanded'] ) {
        if ( state === 'collapsed' ) await collapse(page);
        else await reveal(page);
        const transitions = await page.locator(DRAWER).evaluate((drawer) => {
            const offenders = [];
            for ( const pseudo of [null, '::before', '::after'] ) {
                const style = getComputedStyle(drawer, pseudo);
                const properties = style.transitionProperty.split(',').map((s) => s.trim());
                const durations = style.transitionDuration.split(',').map((s) => s.trim());
                properties.forEach((property, i) => {
                    const raw = durations[i % durations.length];
                    const duration = parseFloat(raw) * (raw.endsWith('ms') ? 1 : 1000);
                    if ( /^(all|(?:min-|max-)?width|(?:min-|max-)?height)$/.test(property) && duration > 0 ) {
                        offenders.push({ pseudo, property, duration });
                    }
                });
            }
            return offenders;
        });
        push(`${label}: ${state} drawer has no width/height transition, including all and pseudo-elements`, transitions.length === 0, describe(transitions));
    }
}

const scenarios = [
    { name: 'flag=false', options: { flag: false, legacy: true }, context: { viewport: { width: 1400, height: 1000 } }, test: legacyCase },
    { name: 'flag absent', options: { flag: 'absent', legacy: true }, context: { viewport: { width: 1400, height: 1000 } }, test: legacyCase },
    { name: 'desktop overlay', test: overlayCase },
    { name: 'traffic lights and overflow', test: trafficCase },
    { name: 'keyboard', test: keyboardCase },
    { name: 'phone', context: PHONE, test: phoneCase },
    { name: 'hybrid', options: { hybrid: true }, test: hybridCase },
    { name: 'fullscreen', options: { screen: true }, test: fullscreenCase },
    ...['cancel', 'minimize', 'close'].map((action) => ({
        name: `close confirm: ${action}`, test: (fixture, label) => closeCase(fixture, label, action),
    })),
    { name: 'reduced motion', context: { reducedMotion: 'reduce' }, test: reducedMotionCase },
];

let browser;
try {
    browser = await chromium.launch();
    for ( const scenario of scenarios ) {
        const label = `[${scenario.name}]`, errors = [];
        let ctx;
        try {
            ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...scenario.context });
            const fixture = await boot(ctx, scenario.options ?? {}, errors);
            await scenario.test(fixture, label);
        } catch (err) {
            push(`${label}: scenario could not complete`, false, String(err?.stack ?? err));
        } finally {
            push(`${label}: no uncaught page errors`, errors.length === 0, describe(errors));
            if ( ctx ) await ctx.close();
        }
    }
} catch (err) {
    // A broken browser installation is a failure, not an unavailable-module skip.
    push('browser harness', false, String(err?.stack ?? err));
} finally {
    if ( browser ) await browser.close();
}
const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
}
process.exit(failed.length ? 1 : 0);
