// code-full-view-browser-test.mjs — EZiL-authored. REAL-BROWSER test of the
// geometry of Code's full view (gate G3, 2026-10-31; docs/APP-CODE-FULL-VIEW.md
// §3): a compact dark strip holding exactly two things while the drawer is
// shut — the drawer's grab notch, centred, and the Feedback icon, flush right —
// with the editor below it, never under it.
//
// Run:  node shell/ezil/apps/code-full-view-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle; or point
//       EZIL_SHELL_OUT_DIR / EZIL_OS_DIR at a build)
//
// Requires `playwright`, resolvable from this file or from
// $PLAYWRIGHT_REQUIRE_DIR; $PLAYWRIGHT_CHROMIUM_EXECUTABLE may name an
// installed Chromium. If either the bundle or playwright is missing this exits
// 2 (skip), never 0.
//
// 🔴 PROVISIONAL visuals: the founder's reference pixels were not readable
// when the strip was built, so these checks pin RELATIONSHIPS — inside, centred,
// clear of, below — and the two provisional strip heights only as ranges (a
// fine strip lower than the Browser's 43px that still fits the 24px icon; a
// coarse strip with 44px targets). Every rect is read once nothing is moving:
// no jQuery animation, no CSS transition on the window or the drawer, the mouse
// parked over the editor (a hover opens the tray). No timed waits.
//
// At 1440x900 and 900x700 on a fine pointer (1440x900 twice: once with the
// Next pages' border-box preflight), and 390x844 and 1024x768 under
// `pointer: coarse` (hasTouch + isMobile), with Feedback enabled and a fake
// editor in Code's frame whose first row of text sits at the frame's very
// top-left, so an overlap would hide it:
//   - the strip is the window's top band, empty of controls of its own;
//   - the shut notch is inside the strip, centred both ways, at most 72px wide;
//     its hit area runs the strip's full height (44px under coarse) and stops
//     at the strip's bottom edge, where the editor takes the click;
//   - sampled across the strip, exactly two buttons answer: the notch and the
//     Feedback icon;
//   - the Feedback icon is a real "Send feedback" <button>, outlined, its
//     right edge within 8px of the viewport's, vertically centred in the
//     strip, clear of the notch and of the open tray;
//   - the editor frame, and its first row, start at or below the strip;
//   - "Reconnecting…" covers the editor below the strip, never the strip;
//   - the keyboard path: Tab reaches the tray's toggle (it opens the tray),
//     Tab reaches Show desktop then Restore window with a visible focus ring,
//     Enter leaves full view for the 980x680 window; the green button, focused
//     and Enter, enters it again.
// And once, at 1440x900: the icon follows the FRONT full view — Code's strip
// while Code is full over a full-bleed Browser; the Browser's strip (9.5px),
// with its glass look, once Code is minimised. That is the positive control
// for "the Browser is unchanged".
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || process.env.EZIL_OS_DIR || path.resolve(here, '../../../app/public/os');
for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`SKIP: missing ${path.join(OS, f)} — run shell/build-shell.sh first (or set EZIL_SHELL_OUT_DIR).`);
        process.exit(2);
    }
}
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
    if ( process.env.PLAYWRIGHT_REQUIRE_DIR ) {
        const external = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'probe.cjs'));
        try { ({ chromium } = external('playwright')); } catch { /* Explicit skip below. */ }
    }
}
if ( ! chromium ) {
    console.error('SKIP: installed Playwright is unavailable; a DOM simulation cannot measure layout.');
    process.exit(2);
}

const icons = fs.readFileSync(path.join(OS, 'icons.js'), 'utf8');
const bundle = fs.readFileSync(path.join(OS, 'bundle.min.js'), 'utf8');
const css = fs.readFileSync(path.join(OS, 'bundle.min.css'), 'utf8');

const origin = 'https://code-full-view.test';
const COMPUTER = '11111111-1111-4111-8111-111111111111';
const ENDPOINTS = { session: '/api/shell/session', desktop: '/api/shell/desktop', focus: '/api/shell/focus', feedback: '/api/shell/feedback' };
const boot = { user: { id: '33333333-3333-4333-8333-333333333333', email: 'fixture@example.test' },
    computer: { id: COMPUTER, name: 'Computer', slot: 1, createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: ENDPOINTS, ui: { floatingControls: false, feedbackScreenshots: false } } };
const page_html = (preflight) => `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
${preflight ? '<style>*, ::before, ::after { box-sizing: border-box; }</style>' : ''}
<style>${css}</style></head><body><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;
// The Browser's stream: reports decoded frames so its window goes full-bleed.
const stream_html = `<!doctype html><html><body style="margin:0;background:#14484c"><script>
let n = 0;
setInterval(() => { n++; parent.postMessage({ source: 'ezil-mobile', type: 'stream_vitals',
    attempt: new URL(location.href).searchParams.get('ezilAttempt'),
    vitals: { connectionState: 'connected', framesDecoded: n, bytesReceived: n * 100, width: 1280, height: 720 } }, location.origin); }, 100);
</script></body></html>`;
// The editor: dark, its first row flush with the frame's top-left corner.
const editor_html = `<!doctype html><html><head><style>
html,body{margin:0;padding:0;background:#1e1e1e;color:#d4d4d4;font:13px/18px monospace}
#row1{margin:0;padding:0;white-space:pre}</style></head>
<body><div id="row1">1  FIRST ROW, TOP-LEFT</div><div>2  const strip = 'above me';</div></body></html>`;

// `preflight`: the page also carries the border-box preflight the Next pages'
// global CSS applies (`*, ::before, ::after { box-sizing: border-box }`), as
// on real Next, where the shut notch measured 56x16 with its border inside.
// The strip must centre it the same either way.
const VIEWPORTS = [
    { width: 1440, height: 900, coarse: false },
    { width: 1440, height: 900, coarse: false, preflight: true },
    { width: 900, height: 700, coarse: false },
    { width: 390, height: 844, coarse: true },
    { width: 1024, height: 768, coarse: true },
];
const CODE = '.window[data-app="code"]';

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass || ! detail ? '' : `  [${detail}]`}`);
    return !! pass;
};
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function open ({ width, height, coarse, preflight = false }) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: coarse, isMobile: coarse });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await context.route('**/*', route => {
        const request = route.request();
        const url = new URL(request.url());
        const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if ( url.origin !== origin ) return route.abort('blockedbyclient');
        if ( url.pathname === '/os' ) return route.fulfill({ contentType: 'text/html', body: page_html(preflight) });
        if ( url.pathname === '/frame' ) return route.fulfill({ contentType: 'text/html', body: stream_html });
        if ( url.pathname === '/editor' ) return route.fulfill({ contentType: 'text/html', body: editor_html });
        if ( url.pathname === ENDPOINTS.feedback ) return json({ reports: [] });
        if ( url.pathname.startsWith('/api/') ) {
            if ( url.searchParams.get('confirm') === 'frame' ) return json({ ok: true, confirmed: true, status: 200 });
            if ( url.searchParams.get('confirm') === 'display' ) return json({ ok: true, display: 'live' });
            if ( url.pathname === ENDPOINTS.desktop ) return json(request.method() === 'POST'
                ? { ok: true, guacamoleUrl: `${origin}/frame?desktop=1`, frame: { confirmed: true } } : { ok: true, guacamoleRunning: true });
            if ( url.pathname === '/api/shell/code-preview-url' ) return json({ ok: true, codePreviewUrl: `${origin}/editor?code=1` });
            return json({ ok: true });
        }
        return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${origin}/os`);
    await page.evaluate(payload => { window.__EZIL_BOOT__ = payload; }, boot);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    await page.evaluate(async () => { await window.ezil.boot(); });
    await page.waitForSelector('.taskbar-item[data-app="desktop"]');
    await page.waitForFunction(() => window.$(':animated').length === 0);
    return { context, page, errors };
}

const launchCode = page => page.evaluate(async () => {
    const p = window.__EZIL_BOOT__;
    await window.ezil.registry.launch('code', { payload: p, computer: p.computer, desktopState: p.desktopState, view: 'full' });
});

/** The editor shown, the window and the drawer still, the drawer shut (or open). */
async function settle (page, { tray = 'shut' } = {}) {
    const vp = page.viewportSize();
    if ( tray === 'shut' ) await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height * 0.7));
    await page.waitForFunction(sel => !! document.querySelector(`${sel} .window-app-iframe`)?.contentDocument?.querySelector('#row1'), CODE);
    await page.waitForFunction(({ sel, tray }) => {
        const w = document.querySelector(sel);
        const d = w?.querySelector(':scope > .ezil-app-drawer');
        return !! d && ! window.$(w).is(':animated') && w.getAnimations().length === 0
            && d.classList.contains('collapsed') === (tray === 'shut') && d.getAnimations({ subtree: true }).length === 0;
    }, { sel: CODE, tray });
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

const measure = page => page.evaluate(sel => {
    const box = el => { if ( ! el ) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const w = document.querySelector(sel);
    const frame = w.querySelector('.window-app-iframe');
    const fr = frame.getBoundingClientRect();
    const row = frame.contentDocument.querySelector('#row1').getBoundingClientRect();
    const chip = document.querySelector('button.ezil-feedback-chip');
    const disc = chip.querySelector('svg');
    const drawer = w.querySelector(':scope > .ezil-app-drawer');
    const toggle = drawer.querySelector('.dashboard-app-drawer-toggle');
    const strip = Number.parseFloat(getComputedStyle(w).getPropertyValue('--ezil-control-strip-height'));
    const bar = w.querySelector(':scope > .ezil-full-view-bar');
    // Every distinct button that answers a click along the strip's midline.
    const answering = [];
    for ( let x = 0.5; x < innerWidth; x += 2 ) {
        const b = document.elementFromPoint(x, strip / 2)?.closest('button');
        if ( b && ! answering.includes(b) ) answering.push(b);
    }
    const name = b => (b === toggle ? 'notch' : b === chip ? 'feedback' : b.className || b.tagName);
    // The notch's hit column at its centre: which rows of the strip (and the
    // row just below it) a click lands on the toggle.
    const cx = box(drawer).x + box(drawer).w / 2;
    const hitRows = [];
    for ( let y = 0.5; y < strip + 4; y += 1 ) if ( document.elementFromPoint(cx, y)?.closest('button') === toggle ) hitRows.push(y);
    let hitW = 0;
    for ( let x = 0.5; x < innerWidth; x += 1 ) if ( document.elementFromPoint(x, strip / 2)?.closest('button') === toggle ) hitW++;
    return {
        vp: [innerWidth, innerHeight], coarse: matchMedia('(pointer: coarse)').matches,
        full: w.classList.contains('ezil-fullbleed'), win: box(w), strip, bar: box(bar),
        barEmpty: bar.children.length === 0 && bar.textContent === '',
        notch: box(drawer), collapsed: drawer.classList.contains('collapsed'),
        hitTop: hitRows[0] ?? null, hitBottom: hitRows.at(-1) ?? null, hitRows: hitRows.length, hitW,
        belowStrip: document.elementFromPoint(cx, strip + 1)?.className ?? null,
        iframe: box(frame), row: { x: fr.x + row.x, y: fr.y + row.y, w: row.width, h: row.height },
        chip: box(chip), disc: box(disc), chipShown: getComputedStyle(chip).display !== 'none',
        chipTag: chip.tagName, chipLabel: chip.getAttribute('aria-label'), chipType: chip.type,
        look: chip.dataset.look ?? null, discBg: getComputedStyle(disc).backgroundColor, discRing: getComputedStyle(disc).boxShadow,
        answering: answering.map(name),
    };
}, CODE);

/** Tab from a blurred document until the tray's toggle has focus (bounded), then report where focus is. */
const focusInfo = page => page.evaluate(() => {
    const el = document.activeElement;
    return { cls: el?.className ?? null, label: el?.getAttribute?.('aria-label') ?? null,
        ring: el ? getComputedStyle(el).outlineStyle : 'none', visible: !! el?.matches?.(':focus-visible'),
        expanded: el?.getAttribute?.('aria-expanded') ?? null };
});

try {
    for ( const vpo of VIEWPORTS ) {
        const L = `[${vpo.width}x${vpo.height} ${vpo.coarse ? 'coarse' : 'fine'}${vpo.preflight ? ' preflight' : ''}]`;
        const { context, page, errors } = await open(vpo);
        // One viewport's failure is recorded and the next viewport still runs.
        try {
            const vw = vpo.width;
            await launchCode(page);
            await settle(page);
            const m = await measure(page);
            push(`${L} setup: the emulated pointer is the one this pass is about, and Code is full`,
                m.coarse === vpo.coarse && m.full && m.win.x === 0 && m.win.y === 0 && m.win.w === vw && m.win.h === vpo.height,
                JSON.stringify({ coarse: m.coarse, win: m.win }));

            // ── the strip ──
            push(`${L} the strip is the window's top band, full width, strip high, with nothing of its own in it`,
                m.bar.x === 0 && m.bar.y === 0 && m.bar.w === vw && m.bar.h === m.strip && m.barEmpty, JSON.stringify({ bar: m.bar, strip: m.strip }));
            push(vpo.coarse ? `${L} (PROVISIONAL) under a coarse pointer the strip holds 44px targets`
                : `${L} (PROVISIONAL) on a fine pointer the strip is lower than the Browser's 43px and still fits the 24px icon`,
            vpo.coarse ? m.strip >= 44 : m.strip >= 26 && m.strip <= 32, String(m.strip));

            // ── the notch ──
            const n = m.notch;
            push(`${L} 🔴 the shut notch is inside the strip`,
                m.collapsed && n.x >= 0 && n.y >= 0 && n.x + n.w <= vw && n.y + n.h <= m.strip, JSON.stringify({ notch: n, strip: m.strip }));
            push(`${L} 🔴 the shut notch is centred, across the viewport and down the strip`,
                Math.abs(n.x + n.w / 2 - vw / 2) <= 0.5 && Math.abs(n.y + n.h / 2 - m.strip / 2) <= 0.5, JSON.stringify(n));
            push(`${L} the shut notch is compact: at most 72px wide`, n.w > 0 && n.w <= 72, String(n.w));
            push(`${L} 🔴 the notch's hit area runs the strip's full height (${vpo.coarse ? 'a 44px touch target' : 'top edge to bottom edge'})…`,
                m.hitTop === 0.5 && m.hitBottom === m.strip - 0.5 && m.hitRows === m.strip && (! vpo.coarse || (m.hitRows >= 44 && m.hitW >= 44)),
                JSON.stringify({ top: m.hitTop, bottom: m.hitBottom, rows: m.hitRows, width: m.hitW }));
            push(`${L} 🔴 …and stops at the strip's bottom edge: 1px below it the editor takes the click`,
                m.belowStrip === 'window-app-iframe', String(m.belowStrip));

            // ── exactly two things ──
            push(`${L} 🔴 across the strip exactly two buttons answer: the notch and the Feedback icon`,
                m.answering.length === 2 && m.answering.includes('notch') && m.answering.includes('feedback'), JSON.stringify(m.answering));

            // ── Feedback ──
            push(`${L} the Feedback icon is a real "Send feedback" button, shown while Code is open`,
                m.chipShown && m.chipTag === 'BUTTON' && m.chipType === 'button' && m.chipLabel === 'Send feedback');
            push(`${L} 🔴 the Feedback icon's right edge is within 8px of the viewport's`,
                vw - (m.chip.x + m.chip.w) >= 0 && vw - (m.chip.x + m.chip.w) <= 8 && vw - (m.disc.x + m.disc.w) <= (vpo.coarse ? 12 : 8),
                JSON.stringify({ chip: m.chip, disc: m.disc }));
            push(`${L} 🔴 the Feedback icon is inside the strip and vertically centred in it`,
                m.chip.y >= 0 && m.chip.y + m.chip.h <= m.strip && Math.abs(m.disc.y + m.disc.h / 2 - m.strip / 2) <= 0.5
                && Math.abs(m.chip.y + m.chip.h / 2 - m.strip / 2) <= 0.5, JSON.stringify({ chip: m.chip, disc: m.disc, strip: m.strip }));
            push(`${L} 🔴 the Feedback icon and the notch do not intersect`, ! intersects(m.chip, m.notch), JSON.stringify({ chip: m.chip, notch: m.notch }));
            push(`${L} the Feedback icon is the outlined one Code's strip declares: a ring, no glass`,
                m.look === 'outline' && m.discBg === 'rgba(0, 0, 0, 0)' && /inset/.test(m.discRing) && ! /0px 1px 3px/.test(m.discRing),
                JSON.stringify({ look: m.look, bg: m.discBg, ring: m.discRing }));
            push(`${L} the Feedback icon's hit target: ${vpo.coarse ? '44px' : '24px'} square, a 16-20px visual`,
                (vpo.coarse ? m.chip.w >= 44 && m.chip.h >= 44 : m.chip.w === 24 && m.chip.h === 24) && m.disc.w >= 16 && m.disc.w <= 20,
                JSON.stringify({ chip: m.chip, disc: m.disc }));

            // ── the editor ──
            push(`${L} 🔴 the editor frame's top edge is at or below the strip's bottom`, m.iframe.y >= m.strip, JSON.stringify({ iframe: m.iframe, strip: m.strip }));
            push(`${L} 🔴 the editor's first row starts at or below the strip (positive control: it IS the frame's top row)`,
                m.row.y >= m.strip && m.row.y === m.iframe.y && m.row.x === m.iframe.x, JSON.stringify({ row: m.row, iframe: m.iframe }));

            // ── the tray, open: may cover the editor, never the Feedback icon ──
            await page.focus(`${CODE} > .ezil-app-drawer .dashboard-app-drawer-toggle`);
            await settle(page, { tray: 'open' });
            const t = await page.evaluate(sel => {
                const d = document.querySelector(`${sel} > .ezil-app-drawer`);
                const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
                return { tray: box(d), title: d.querySelector('.dashboard-app-drawer-title').textContent,
                    actions: [...d.querySelectorAll('.dashboard-app-drawer-btn')].map(b => ({ label: b.getAttribute('aria-label'), ...box(b) })) };
            }, CODE);
            push(`${L} the open tray carries ${vw > 500 ? 'the title and ' : ''}Show desktop / Restore window / Close`,
                t.title === 'Code' && t.actions.map(a => a.label).join() === 'Show desktop,Restore window,Close' && t.actions.every(a => a.w > 0),
                JSON.stringify(t.actions));
            push(`${L} the open tray and its actions stay clear of the Feedback icon`,
                ! intersects(t.tray, m.chip) && t.actions.every(a => ! intersects(a, m.chip)), JSON.stringify({ tray: t.tray, chip: m.chip }));

            // ── "Reconnecting…" stays below the strip ──
            await page.evaluate(id => window.dispatchEvent(new CustomEvent('ezil:computer-transition', { detail: { computerId: id } })), COMPUTER);
            await page.waitForSelector(`${CODE} .ezil-code-state[data-state="reconnecting"]`, { state: 'visible' });
            const cover = await page.evaluate(sel => {
                const r = document.querySelector(`${sel} .ezil-code-state`).getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
            }, CODE);
            push(`${L} 🔴 "Reconnecting…" covers the editor from the strip's bottom down, never the strip`,
                cover.y >= m.strip && cover.y + cover.h === vpo.height && cover.w === vw, JSON.stringify({ cover, strip: m.strip }));

            // ── the keyboard: tray toggle -> Restore window exits; the green button enters ──
            await page.evaluate(() => document.activeElement?.blur?.());
            await page.mouse.move(Math.round(vw / 2), Math.round(vpo.height * 0.7));
            let tabs = 0;
            let at = await focusInfo(page);
            while ( tabs < 40 && ! /dashboard-app-drawer-toggle/.test(at.cls ?? '') ) {
                await page.keyboard.press('Tab');
                tabs++;
                at = await focusInfo(page);
            }
            push(`${L} 🔴 Tab reaches the tray's toggle, which opens the tray and shows a focus ring`,
                /dashboard-app-drawer-toggle/.test(at.cls ?? '') && at.expanded === 'true' && at.visible && at.ring !== 'none',
                JSON.stringify({ tabs, at }));
            await page.keyboard.press('Tab');
            const showDesktop = await focusInfo(page);
            await page.keyboard.press('Tab');
            const restore = await focusInfo(page);
            push(`${L} Tab then reaches Show desktop and Restore window, each with a visible focus ring`,
                showDesktop.label === 'Show desktop' && restore.label === 'Restore window'
                && [showDesktop, restore].every(f => f.visible && f.ring !== 'none'), JSON.stringify({ showDesktop, restore }));
            await page.keyboard.press('Enter');
            await page.waitForSelector(`${CODE}:not(.ezil-fullbleed)`);
            await page.waitForFunction(sel => { const w = document.querySelector(sel); return ! window.$(w).is(':animated') && w.getAnimations().length === 0; }, CODE);
            const windowed = await page.evaluate(sel => {
                const w = document.querySelector(sel);
                const r = w.getBoundingClientRect();
                return { rect: [r.x, r.y, r.width, r.height], full: w.classList.contains('ezil-fullbleed'),
                    head: getComputedStyle(w.querySelector(':scope > .window-head')).display,
                    drawer: getComputedStyle(w.querySelector(':scope > .ezil-app-drawer')).display };
            }, CODE);
            // A phone lays every window out at the viewport, so there the rect is
            // not the evidence; the class, the head and the hidden notch are.
            push(`${L} 🔴 Enter on Restore window leaves full view: the head is back, the strip's notch is gone`,
                ! windowed.full && windowed.head !== 'none' && windowed.drawer === 'none', JSON.stringify(windowed));
            if ( ! vpo.coarse ) {
                push(`${L} …at the 980x680 window Code was created as`, windowed.rect[2] === 980 && windowed.rect[3] === 680, JSON.stringify(windowed.rect));
                await page.focus(`${CODE} > .window-head .window-scale-btn`);
                await page.keyboard.press('Enter');
                await page.waitForSelector(`${CODE}.ezil-fullbleed`);
                await settle(page);
                const back = await measure(page);
                push(`${L} 🔴 positive control: the green button, focused and Enter, enters full view again, notch centred, editor below`,
                    back.full && back.win.w === vw && Math.abs(back.notch.x + back.notch.w / 2 - vw / 2) <= 0.5 && back.iframe.y >= back.strip,
                    JSON.stringify({ win: back.win, notch: back.notch }));
            }

            // ── the icon follows the FRONT full view (once) ──
            if ( vpo.width === 1440 && ! vpo.preflight ) {
                const chipNow = () => page.evaluate(() => {
                    const c = document.querySelector('button.ezil-feedback-chip');
                    const r = c.getBoundingClientRect();
                    return { y: r.y, h: r.height, look: c.dataset.look ?? null, bg: getComputedStyle(c.querySelector('svg')).backgroundColor };
                });
                // Code is full (the green button above). The dock is hidden, so the
                // Browser opens through the registry, as a dock click does; it goes
                // full-bleed in front once its frames decode.
                await page.evaluate(async () => {
                    const p = window.__EZIL_BOOT__;
                    await window.ezil.registry.launch('desktop', { payload: p, computer: p.computer, desktopState: p.desktopState });
                });
                await page.waitForSelector('.window[data-app="desktop"].ezil-fullbleed', { timeout: 30_000 });
                await page.mouse.move(720, 600);
                await page.waitForFunction(() => {
                    const w = document.querySelector('.window[data-app="desktop"]');
                    const d = w.querySelector(':scope > .ezil-app-drawer');
                    return d.classList.contains('collapsed') && d.getAnimations({ subtree: true }).length === 0 && w.getAnimations().length === 0;
                });
                const browserFront = await chipNow();
                const browserNotch = await page.evaluate(() => {
                    const r = document.querySelector('.window[data-app="desktop"] > .ezil-app-drawer').getBoundingClientRect();
                    return { x: r.x, y: r.y, w: r.width, h: r.height };
                });
                push(`${L} 🔴 positive control: the Browser in front keeps its own strip and look (top 9.5px in its 43px strip, glass disc, notch as before)`,
                    browserFront.y === 9.5 && browserFront.look === null && browserFront.bg === 'rgba(24, 24, 28, 0.62)'
                    && JSON.stringify(browserNotch) === JSON.stringify({ x: 691, y: 13.5, w: 58, h: 18 }), JSON.stringify({ browserFront, browserNotch }));
                // Code to the front again: a relaunch onto its open window (Back/Forward does this).
                await page.evaluate(async () => {
                    const p = window.__EZIL_BOOT__;
                    await window.ezil.registry.launch('code', { payload: p, computer: p.computer, desktopState: p.desktopState, view: 'full' });
                });
                await settle(page);
                const codeFront = await chipNow();
                const strip = (await measure(page)).strip;
                push(`${L} 🔴 Code full over the full-bleed Browser: the icon moves into Code's strip, outlined`,
                    Math.abs(codeFront.y + codeFront.h / 2 - strip / 2) <= 0.5 && codeFront.look === 'outline', JSON.stringify({ codeFront, strip }));
                await page.focus(`${CODE} > .ezil-app-drawer .dashboard-app-drawer-toggle`);
                await page.locator(`${CODE} > .ezil-app-drawer .dashboard-app-drawer-minimize`).click();
                await page.waitForFunction(sel => ['true', '1'].includes(document.querySelector(sel).getAttribute('data-is_minimized')), CODE);
                await page.waitForFunction(() => document.querySelector('button.ezil-feedback-chip').getBoundingClientRect().y === 9.5);
                const backToBrowser = await chipNow();
                push(`${L} 🔴 Code minimised: the icon is back in the Browser's strip with the Browser's look`,
                    backToBrowser.y === 9.5 && backToBrowser.look === null && backToBrowser.bg === 'rgba(24, 24, 28, 0.62)', JSON.stringify(backToBrowser));
            }
        } catch ( err ) {
            push(`${L} completed without throwing`, false, String(err?.message ?? err).split('\n')[0]);
        }
        push(`${L} no page errors`, errors.length === 0, JSON.stringify(errors));
        await context.close();
    }
} catch ( err ) {
    push('harness completed without throwing', false, String(err?.stack ?? err));
} finally {
    await browser.close();
}

const failed = checks.filter(c => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (built bundle; local route mock; no network)`);
process.exit(failed.length ? 1 : 0);
