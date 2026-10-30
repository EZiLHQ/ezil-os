// appearance-browser-test.mjs — EZiL-authored. Settings → Appearance in a
// REAL Chromium (round 3, plan §6.7, decision D8).
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> node shell/ezil/ui/Settings/appearance-browser-test.mjs
//       (after shell/build-shell.sh; EZIL_SHELL_OUT_DIR picks another build directory)
//
// jsdom cannot answer these: it has no cascade for custom properties. What is
// measured is `getComputedStyle` of real accent-bearing chrome:
//   1. picking Violet changes the computed colour of the active Settings tab
//      icon (a `var(--accent)` control) and the window-control focus ring
//      (`var(--ezil-accent)` in ezil-shell.css);
//   2. both survive a reload (the saved choice, per account on this browser);
//   3. both, and the wallpaper, survive an `ensure_intact` rebuild of the
//      desktop (the rebuilt `.desktop` used to come back without it);
//   4. another tab of the same account follows a change (`storage` event);
//   5. every preset's text colour on the accent clears WCAG AA (4.5:1).
// Exit 0 pass, 1 fail, 2 skip (no playwright or no bundle) — see run-tests.sh.
import { fixtureUrl } from '../../../fixture-url-test-support.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
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
    console.error('playwright is not resolvable. This is a REAL-BROWSER test. Skipping, not passing.');
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
const HOST = 'https://ezil-appearance-test.invalid';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>`
    + '<body class="min-h-full flex flex-col"><div id="ezil-os-root"></div></body></html>';
const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: { id: '11111111-1111-4111-8111-111111111111', name: 'My Computer', slot: 1, createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', endpoints: {} },
};
const TEAL = 'rgb(0, 173, 181)', VIOLET = 'rgb(124, 59, 237)', AMBER = 'rgb(245, 159, 10)';
const CHARCOAL = 'rgb(22, 22, 22)';

const browser = await chromium.launch();
const errors = [];
async function open (context) {
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(String(e)));
    await page.route('**/*', async route => {
        const target = fixtureUrl(route.request().url(), HOST);
        if ( ! target ) return route.abort();
        if ( target.pathname === '/os' ) return route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
        if ( target.pathname.startsWith('/api/trpc/computer.list') ) {
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { data: { json: [PAYLOAD.computer] } } }) });
        }
        if ( target.pathname.startsWith('/api/') ) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
        return route.fulfill({ status: 404, body: '' });
    });
    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate(p => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    await page.waitForSelector('.taskbar-item', { timeout: 15_000 });
    return page;
}
const settingsTab = async (page, id) => {
    if ( ! await page.$('.window[data-app="settings"]') ) {
        await page.evaluate(() => window.ezil.registry.launch('settings', window.ezil.registry.launchContext
            ? window.ezil.registry.launchContext({ payload: window.__EZIL_BOOT__, computer: window.__EZIL_BOOT__.computer, desktopState: window.__EZIL_BOOT__.desktopState })
            : { payload: window.__EZIL_BOOT__, computer: window.__EZIL_BOOT__.computer, desktopState: window.__EZIL_BOOT__.desktopState }));
        await page.waitForSelector('.window[data-app="settings"] .ezil-settings-tab', { timeout: 10_000 });
    }
    await page.click(`.window[data-app="settings"] .ezil-settings-tab[data-tab="${id}"]`);
    await page.waitForTimeout(150);
};
/** Computed colours of real accent-bearing chrome. */
const measure = page => page.evaluate(() => {
    const icon = document.querySelector('.window[data-app="settings"] .ezil-settings-tab.active .ezil-settings-tab-icon');
    // The window-control focus ring (ezil-shell.css `.window-action-btn:focus-visible`), read from a real control.
    const btn = document.querySelector('.window .window-action-btn');
    let ring = null;
    if ( btn ) {
        const rule = [...document.styleSheets].flatMap(sheet => { try { return [...sheet.cssRules]; } catch { return []; } })
            .find(r => r.selectorText === '.window-action-btn:focus-visible');
        const probe = document.createElement('div');
        probe.style.outlineColor = rule?.style.getPropertyValue('outline-color') || '';
        probe.style.outline = rule?.style.getPropertyValue('outline') || '';
        btn.parentElement.append(probe);
        ring = getComputedStyle(probe).outlineColor;
        probe.remove();
    }
    const desktop = document.querySelector('.desktop');
    return {
        icon: icon ? getComputedStyle(icon).color : null,
        ring,
        token: getComputedStyle(document.documentElement).getPropertyValue('--ezil-accent').trim(),
        contrast: getComputedStyle(document.documentElement).getPropertyValue('--ezil-accent-contrast').trim(),
        desktopBg: desktop ? getComputedStyle(desktop).backgroundColor : null,
        stored: { accent: localStorage.getItem('ezil-os:settings.user-1.accent'), wallpaper: localStorage.getItem('ezil-os:settings.user-1.wallpaper'),
            legacy: localStorage.getItem('ezil-os:settings.accent') },
    };
});

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // A pre-round-3 browser: one shared key. It must move to this account once.
    await context.addInitScript(() => {
        if ( ! sessionStorage.getItem('seeded') ) { localStorage.setItem('ezil-os:settings.wallpaper', '"aurora"'); sessionStorage.setItem('seeded', '1'); }
    });
    const page = await open(context);
    await settingsTab(page, 'appearance');
    const before = await measure(page);
    push('default: the active tab icon and the focus ring are the brand teal', before.icon === TEAL && before.ring === TEAL, JSON.stringify(before));
    push('the old shared wallpaper key moved to this account once', before.stored.wallpaper === '"aurora"'
        && await page.evaluate(() => localStorage.getItem('ezil-os:settings.wallpaper')) === null, JSON.stringify(before.stored));

    await page.click('.window[data-app="settings"] [data-accent="violet"]');
    await page.click('.window[data-app="settings"] [data-wallpaper="charcoal"]');
    await page.waitForTimeout(200);
    const violet = await measure(page);
    push('🔴 picking Violet recolours the real Settings control (computed colour)', violet.icon === VIOLET, violet.icon);
    push('🔴 …and the shell focus ring (ezil-shell.css)', violet.ring === VIOLET, violet.ring);
    push('the wallpaper applies to the desktop', violet.desktopBg === CHARCOAL, violet.desktopBg);
    push('saved per account on this browser', violet.stored.accent === '"violet"' && violet.stored.wallpaper === '"charcoal"', JSON.stringify(violet.stored));
    push('the pane says where it is saved', (await page.textContent('.window[data-app="settings"] [data-role="appearance-scope"]'))?.trim() === 'Saved on this browser.');

    await page.reload({ waitUntil: 'load' });
    await page.evaluate(p => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });
    await page.waitForSelector('.taskbar-item', { timeout: 15_000 });
    const reloadedEarly = await measure(page);
    push('🔴 after a reload the accent and wallpaper are applied before Settings opens',
        reloadedEarly.token === '#7c3bed' && reloadedEarly.desktopBg === CHARCOAL, JSON.stringify(reloadedEarly));
    await settingsTab(page, 'appearance');
    const reloaded = await measure(page);
    push('🔴 …and the Settings control is still Violet', reloaded.icon === VIOLET && reloaded.ring === VIOLET, `${reloaded.icon} ${reloaded.ring}`);

    // ensure_intact: the host regenerates its contents; the shell rebuilds the desktop.
    const oldDesktop = await page.evaluateHandle(() => document.querySelector('.desktop'));
    await page.evaluate(() => document.getElementById('ezil-os-root')?.remove());
    await page.waitForFunction(old => { const d = document.querySelector('.desktop'); return d && d !== old && d.isConnected; }, oldDesktop, { timeout: 15_000 });
    await page.waitForTimeout(300);
    const rebuilt = await measure(page);
    push('🔴 an ensure_intact rebuild keeps the wallpaper on the NEW desktop', rebuilt.desktopBg === CHARCOAL, rebuilt.desktopBg);
    push('🔴 …and the accent token', rebuilt.token === '#7c3bed', rebuilt.token);
    await settingsTab(page, 'appearance');
    const rebuiltSettings = await measure(page);
    push('…and a Settings window opened after the rebuild is Violet', rebuiltSettings.icon === VIOLET, rebuiltSettings.icon);

    // Another tab of the same account.
    const other = await open(context);
    await settingsTab(other, 'appearance');
    await other.click('.window[data-app="settings"] [data-accent="amber"]');
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--ezil-accent').trim() === '#f59f0a', null, { timeout: 5_000 }).catch(() => {});
    const synced = await measure(page);
    push('a change in another tab of the same account reaches this tab (storage event)', synced.icon === AMBER && synced.token === '#f59f0a', `${synced.icon} ${synced.token}`);
    push('…and its open Appearance pane marks the new choice',
        await page.getAttribute('.window[data-app="settings"] [data-accent].active', 'data-accent') === 'amber');

    // Contrast of the text colour on each accent (WCAG AA, normal text).
    const lum = hex => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const pins = { teal: ['#00adb5', '#04060c'], violet: ['#7c3bed', '#ffffff'], amber: ['#f59f0a', '#04060c'], rose: ['#e7405c', '#04060c'] };
    for ( const [id, [accent, ink]] of Object.entries(pins) ) {
        await page.click(`.window[data-app="settings"] [data-accent="${id}"]`);
        await page.waitForTimeout(50);
        const m = await measure(page);
        push(`${id}: --ezil-accent ${accent} with text ${ink} clears AA`, m.token === accent && m.contrast === ink && ratio(accent, ink) >= 4.5,
            `${m.token} / ${m.contrast} = ${ratio(m.token || '#000000', m.contrast || '#000000').toFixed(2)}`);
    }
    push('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch ( error ) {
    push('scenario completes without throwing', false, error?.stack ?? String(error));
} finally {
    await browser.close();
}
const failed = checks.filter(c => ! c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} appearance checks passed`);
process.exit(failed ? 1 : 0);
