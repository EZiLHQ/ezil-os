// credits-real-shape-browser-test.mjs — EZiL-authored. REAL-BROWSER checks of the
// identity AI credit meter (Settings → Usage and Billing) with the summaries the
// SERVER produces from the real Gateway `/v1/me/balance` shape of staging account
// e2e-standard (2026-11-01: 1,300 live, 1,263.815391 left, 17.409094 reserved,
// two revoked grants). The summaries are pinned in ai-account-real-shape.fixture.json
// by app/src/server/billing/ai-account-real-shape.test.ts, which fails when the
// server would send anything else, so this file renders exactly the server's output.
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> [CREDITS_SHOTS_DIR=<dir>] \
//       node shell/ezil/ui/Settings/credits-real-shape-browser-test.mjs
//
// Two harnesses, both in Chromium with the BUILT stylesheet:
//   1. the source modules (tabs/usage.js, tabs/billing.js, billing-format.js, bundled
//      by esbuild as billing-layout-browser-test does) inside the Settings window's own
//      structure at 760 and 390 px;
//   2. the committed shell bundle (app/public/os/bundle.min.js) booted on loopback with
//      a stub tRPC that serves the pinned summaries: Settings opened by its deep link,
//      the Usage tab's kept balance on a failed refresh, and a user A → B switch.
// Exit 2 (skip) when playwright or the bundle is missing — never a silent pass.
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
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

const SHOTS = process.env.CREDITS_SHOTS_DIR ? path.resolve(process.env.CREDITS_SHOTS_DIR) : null;
if ( SHOTS ) fs.mkdirSync(SHOTS, { recursive: true });
const shots = [];
const shot = async (target, name) => {
    if ( ! SHOTS ) return;
    const file = path.join(SHOTS, `${name}.png`);
    await target.screenshot({ path: file });
    shots.push(file);
};

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, 'ai-account-real-shape.fixture.json'), 'utf8'));
const { a: USER_A, b: USER_B } = FIXTURE.users;
// The pinned server output must be the real-shape account, or every check below proves nothing.
if ( FIXTURE.ok?.ai?.account?.totalMicro !== '1300000000' || FIXTURE.ok.ai.account.userId !== USER_A || FIXTURE.userB?.ai?.account?.userId !== USER_B
    || FIXTURE.unavailableB?.ai?.account?.userId !== USER_B ) {
    console.error('ai-account-real-shape.fixture.json is not the pinned real-shape summary. Skipping, not passing.');
    process.exit(2);
}

// What the shipped formatter makes of these exact microcredits (floored, trailing zeros trimmed).
const A_HEADLINE = '1,263 credits left of 1,300';
const A_DETAILS = 'Plan 200 · Starter 100 · Added 1,000 · Used 18.77 · Reserved 17.4 · Remaining 1,263.81';
const A_DETAILS_UNPROVEN = 'Plan 200 · Starter 100 · Added 1,000 · Reserved 17.4 · Remaining 1,263.81';
const A_TITLES = ['200 credits', '100 credits', '1,000 credits', '18.775515 credits', '17.409094 credits', '1,263.815391 credits'];
const B_HEADLINE = '37 credits left of 100';
const B_DETAILS = 'Starter 100 · Used 62.75 · Remaining 37.25';
// 1,263.815391 of 1,300 = 97.2 %, floored.
const A_PERCENT = '97';
// Catalog denominators (Premium 1,000, Standard 200) and the rounded old headline must never be the meter's.
const CATALOG = /\bof (1,000|200)\b|1,264/;

const { build } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const renderers = (await build({
    stdin: { contents: `
        import usageTab, { usageHtml } from './tabs/usage.js';
        import { summaryV3Html } from './tabs/billing.js';
        import { accountCredits, creditsDecimal, creditsLabel } from './billing-format.js';
        window.real = { usageHtml, usageTabHtml: usageTab.html(), summaryV3Html, accountCredits, creditsDecimal, creditsLabel };
    `, resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022', logLevel: 'silent',
})).outputFiles[0].text;
const css = fs.readFileSync(path.join(OS, 'bundle.min.css'), 'utf8');

// The Settings window's own structure (index.js buildHtml), at a given width.
const windowHtml = (width, pane, inner) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>
    <style>html, body { margin: 0; background: #000; }</style>
    <script>window.html_encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));</script></head><body>
    <div class="window ezil-settings-window" style="display: block; position: absolute; left: 0; top: 0; width: ${width}px; height: 900px;">
        <div class="window-body" style="height: 100%; overflow: auto;">
            <div class="ezil-settings">
                <nav class="ezil-settings-sidebar" role="tablist" aria-label="Settings"><button type="button" class="ezil-settings-tab active">${pane === 'usage' ? 'Usage' : 'Billing'}</button></nav>
                <div class="ezil-settings-content"><div class="ezil-settings-pane active" data-pane="${pane}" role="tabpanel">${inner}</div></div>
            </div>
        </div>
    </div></body></html>`;

/** Reads the AI meter of whichever pane is on the page (Usage `[data-usage="ai"]`, Billing `[data-role="meter-ai"]`). */
async function readAiMeter (page) {
    return page.evaluate(() => {
        const text = el => el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
        const usageRow = document.querySelector('[data-usage="ai"]');
        const row = usageRow ?? document.querySelector('[data-role="meter-ai"]');
        if ( ! row ) return null;
        const value = text(row.querySelector(usageRow ? '.usage-value' : '.ezil-billing-meter-value'));
        // Usage joins its notes with <br>; Billing gives the details their own paragraph.
        const lines = usageRow
            ? row.querySelector('.usage-note').innerHTML.split(/<br\s*\/?>/i).map(html => { const d = document.createElement('div'); d.innerHTML = html; return text(d); }).filter(Boolean)
            : [...row.querySelectorAll('.ezil-billing-note')].map(text).filter(Boolean);
        const detailsEl = usageRow ? row.querySelector('.usage-note') : row.querySelector('[data-role="ai-details"]');
        const details = lines.find(line => / · Remaining /.test(line) || /^Remaining /.test(line)) ?? null;
        const titles = detailsEl ? [...detailsEl.querySelectorAll('span[title]')].map(s => s.getAttribute('title')) : [];
        const bar = row.querySelector(usageRow ? '[role="progressbar"]' : '[role="meter"]');
        const fill = bar ? bar.querySelector('span').getBoundingClientRect().width / bar.getBoundingClientRect().width * 100 : null;
        const pane = row.closest('.ezil-settings-pane') ?? row.closest('.ezil-settings-content') ?? document.body;
        const rowRect = row.getBoundingClientRect();
        const inside = [...row.querySelectorAll('*')].every(el => { const r = el.getBoundingClientRect(); return r.width === 0 || r.right <= rowRect.right + 0.5; });
        const status = text(document.querySelector('[data-role="usage-refresh-status"]'));
        return { value, lines, details, titles, rowText: text(row), bar: bar?.getAttribute('aria-valuenow') ?? null, fill,
            inside, paneOverflow: pane.scrollWidth - pane.clientWidth, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            rowWidth: Math.round(rowRect.width), status };
    });
}

/** The full set for a readable account: headline, exact details with every microcredit in titles, a bar, no catalog figure, no overflow. */
function expectAccount (label, m, { headline, details, titles = null, percent = null, stale = false }) {
    push(`${label}: headline`, m?.value === headline, m?.value);
    push(`${label}: exact details line`, m?.details === details, m?.details);
    if ( titles ) push(`${label}: every microcredit in the titles`, JSON.stringify(m.titles) === JSON.stringify(titles), m.titles.join(' | '));
    if ( percent !== null ) push(`${label}: the bar is ${percent} % of the live total and painted to match`, m.bar === percent && Math.abs(m.fill - Number(percent)) <= 1, `${m.bar} / ${m.fill?.toFixed(1)}`);
    push(`${label}: no catalog denominator or rounded figure in the AI row`, ! CATALOG.test(m.rowText), m.rowText.slice(0, 120));
    push(`${label}: ${stale ? 'says it could not refresh, as of the kept time' : 'is not marked stale'}`,
        stale ? m.lines.includes("Couldn't refresh · as of 07:00") : ! /Couldn't refresh/.test(m.rowText), m.lines[0]);
    push(`${label}: the row fits; no horizontal overflow`, m.inside && m.paneOverflow <= 0 && m.docOverflow <= 0, `row ${m.rowWidth}px pane ${m.paneOverflow} doc ${m.docOverflow}`);
}
/** No readable balance for this user: say so, show no figure and no bar. */
function expectUnavailable (label, m, { value, note }) {
    push(`${label}: value "${value}"`, m?.value === value, m?.value);
    push(`${label}: says it couldn't read the balance`, m.lines.includes(note), m.lines.join(' | '));
    push(`${label}: no bar`, m.bar === null, String(m.bar));
    push(`${label}: no figure from the catalog, the kept balance or another user`, ! /1,263|1,300|1,264|\b200\b|1,000|\b37\b/.test(`${m.value} ${m.lines.filter(l => l !== 'Used by EZiL AI in Code and Chat.').join(' ')}`), m.rowText.slice(0, 120));
    push(`${label}: no horizontal overflow`, m.paneOverflow <= 0 && m.docOverflow <= 0, `pane ${m.paneOverflow} doc ${m.docOverflow}`);
}

const browser = await chromium.launch();
try {
    // ── 1. Source modules in the Settings window structure ───────────────────
    const context = await browser.newContext({ timezoneId: 'UTC', locale: 'en-US' });
    const page = await context.newPage();
    await page.setContent(windowHtml(760, 'usage', ''));
    await page.addScriptTag({ content: renderers });
    // The shipped formatter itself, on these microcredits.
    const fmt = await page.evaluate(() => ['18775515', '17409094', '1263815391', '1300000000'].map(m => [window.real.creditsDecimal(m), window.real.creditsDecimal(m, 6), window.real.creditsLabel(m)]));
    push('formatter: Used 18.775515 → "18.77" (floored, never rounded up)', fmt[0][0] === '18.77' && fmt[0][1] === '18.775515', fmt[0].join(' / '));
    push('formatter: Reserved 17.409094 → "17.4" (2 dp floored is 17.40; trailing zero trimmed)', fmt[1][0] === '17.4' && fmt[1][1] === '17.409094', fmt[1].join(' / '));
    push('formatter: Remaining 1,263.815391 → "1,263.81", headline "1,263"', fmt[2][0] === '1,263.81' && fmt[2][2] === '1,263', fmt[2].join(' / '));
    push('formatter: total 1,300', fmt[3][2] === '1,300', fmt[3].join(' / '));

    const render = async (width, pane, html) => {
        await page.setViewportSize({ width: Math.max(width, 390), height: 1000 });
        await page.evaluate(([w, p, inner]) => {
            const win = document.querySelector('.ezil-settings-window');
            win.style.width = `${w}px`;
            const el = document.querySelector('.ezil-settings-pane');
            el.dataset.pane = p;
            el.innerHTML = inner;
            document.querySelector('.ezil-settings-tab').textContent = p === 'usage' ? 'Usage' : 'Billing';
        }, [width, pane, html]);
        return readAiMeter(page);
    };
    const usagePane = (usage, summary, options) => page.evaluate(([u, s, o]) => {
        const shell = document.createElement('div');
        shell.innerHTML = window.real.usageTabHtml;
        shell.querySelector('[data-role="usage-body"]').innerHTML = window.real.usageHtml(u, s, o);
        return shell.innerHTML;
    }, [usage, summary, options]);
    const billingPane = (summary, options, usage = FIXTURE.usageA) => page.evaluate(([s, o, u]) =>
        `<div class="ezil-settings-billing"><div data-role="billing-body">${window.real.summaryV3Html(s, u, o)}</div></div>`, [summary, options, usage]);
    const windowShot = name => shot(page.locator('.ezil-settings-window'), name);

    for ( const width of [760, 390] ) {
        const at = `source ${width} px`;
        // The real shape, as the server sends it.
        expectAccount(`${at} · Usage · e2e-standard`, await render(width, 'usage', await usagePane(FIXTURE.usageA, FIXTURE.ok, { userId: USER_A })),
            { headline: A_HEADLINE, details: A_DETAILS, titles: A_TITLES, percent: A_PERCENT });
        await windowShot(`source-usage-${width}-ok`);
        expectAccount(`${at} · Billing · e2e-standard`, await render(width, 'billing', await billingPane(FIXTURE.ok, { userId: USER_A })),
            { headline: A_HEADLINE, details: A_DETAILS, titles: A_TITLES, percent: A_PERCENT });
        await windowShot(`source-billing-${width}-ok`);
        // Held credits the usage page doesn't explain: no "Used" (the lane's rule), everything else the same.
        for ( const pane of ['usage', 'billing'] ) {
            expectAccount(`${at} · ${pane} · used unproven`, await render(width, pane, pane === 'usage'
                ? await usagePane(FIXTURE.usageA, FIXTURE.unproven, { userId: USER_A }) : await billingPane(FIXTURE.unproven, { userId: USER_A })),
            { headline: A_HEADLINE, details: A_DETAILS_UNPROVEN, percent: A_PERCENT });
        }
        await windowShot(`source-billing-${width}-unproven`);
        // Gateway unavailable, nothing kept: no figure at all, never the catalog's 200.
        expectUnavailable(`${at} · Usage · gateway unavailable (cold)`, await render(width, 'usage', await usagePane(FIXTURE.usageA, FIXTURE.unavailable, { userId: USER_A })),
            { value: 'Unavailable', note: "We couldn't read your balance." });
        await windowShot(`source-usage-${width}-unavailable`);
        expectUnavailable(`${at} · Billing · gateway unavailable (cold)`, await render(width, 'billing', await billingPane(FIXTURE.unavailable, { userId: USER_A })),
            { value: '—', note: "We couldn't read your credits. Try again later." });
        await windowShot(`source-billing-${width}-unavailable`);
        // Gateway unavailable with this user's last balance kept: shown as of its time.
        for ( const pane of ['usage', 'billing'] ) {
            const options = { userId: USER_A, lastAccount: FIXTURE.ok.ai.account };
            expectAccount(`${at} · ${pane} · gateway unavailable (kept)`, await render(width, pane, pane === 'usage'
                ? await usagePane(FIXTURE.usageA, FIXTURE.unavailable, options) : await billingPane(FIXTURE.unavailable, options)),
            { headline: A_HEADLINE, details: A_DETAILS, percent: A_PERCENT, stale: true });
            await windowShot(`source-${pane}-${width}-unavailable-kept`);
        }
        // User A → B: B signed in with A's balance still kept from before.
        for ( const pane of ['usage', 'billing'] ) {
            const kept = { userId: USER_B, lastAccount: FIXTURE.ok.ai.account };
            const html = summary => pane === 'usage' ? usagePane(FIXTURE.usageB, summary, kept) : billingPane(summary, kept, FIXTURE.usageB);
            expectAccount(`${at} · ${pane} · A→B: B's own balance`, await render(width, pane, await html(FIXTURE.userB)),
                { headline: B_HEADLINE, details: B_DETAILS, percent: '37' });
            if ( pane === 'billing' ) await windowShot(`source-billing-${width}-user-b`);
            expectUnavailable(`${at} · ${pane} · A→B: B's read failed, A's kept balance never shown`, await render(width, pane, await html(FIXTURE.unavailableB)),
                pane === 'usage' ? { value: 'Unavailable', note: "We couldn't read your balance." } : { value: '—', note: "We couldn't read your credits. Try again later." });
            expectUnavailable(`${at} · ${pane} · A→B: a summary read for A, shown to B, is refused`, await render(width, pane, await html(FIXTURE.ok)),
                pane === 'usage' ? { value: 'Unavailable', note: "We couldn't read your balance." } : { value: '—', note: "We couldn't read your credits. Try again later." });
        }
    }
    await context.close();

    // ── 2. The committed shell bundle, booted on loopback ────────────────────
    let serve = { summary: FIXTURE.ok, usage: FIXTURE.usageA };
    const requests = [];
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if ( url.pathname.startsWith('/os/') ) {
            const file = path.join(OS, url.pathname.slice('/os/'.length));
            if ( file.startsWith(path.join(OS, path.sep)) && fs.existsSync(file) && fs.statSync(file).isFile() ) {
                res.setHeader('content-type', file.endsWith('.js') || file.endsWith('.mjs') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
                res.end(fs.readFileSync(file)); return;
            }
            res.statusCode = 404; res.end(); return;
        }
        if ( url.pathname === '/favicon.ico' ) { res.statusCode = 204; res.end(); return; }
        requests.push(url.pathname);
        const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result: { data: { json: body } } })); };
        if ( url.pathname === '/api/trpc/billing.summary' ) return json(serve.summary);
        if ( url.pathname === '/api/trpc/billing.usage' ) return json(serve.usage);
        if ( url.pathname.startsWith('/api/') ) return json([]);
        if ( url.pathname !== '/os' ) { res.statusCode = 404; res.end(); return; }
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const errors = [];
    const boot = async (userId, viewport) => {
        const ctx = await browser.newContext({ viewport, timezoneId: 'UTC', locale: 'en-US' });
        await ctx.addInitScript(id => {
            window.__EZIL_BOOT__ = { user: { id, email: 'fixture@example.com' }, features: { billing: true },
                computer: { id: '11111111-1111-4111-8111-111111111111', name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }],
                desktopState: { provider: 'cloudflare-guacamole', configured: false } };
        }, userId);
        const p = await ctx.newPage();
        p.on('pageerror', error => errors.push(error.message));
        return { ctx, page: p };
    };
    const settled = async (p, selector) => {
        await p.waitForFunction(sel => {
            const row = document.querySelector(sel);
            return row && /credits left|Unavailable|—/.test(row.textContent) && ! document.querySelector('[data-role="usage-body"][aria-busy="true"]');
        }, selector, { timeout: 15000 });
        return readAiMeter(p);
    };
    const settingsWidth = p => p.evaluate(() => Math.round(document.querySelector('.window[data-app="settings"]')?.getBoundingClientRect().width ?? 0));
    try {
        for ( const [label, viewport] of [['bundle desktop', { width: 1280, height: 900 }], ['bundle phone 390', { width: 390, height: 844 }]] ) {
            serve = { summary: FIXTURE.ok, usage: FIXTURE.usageA };
            const { ctx, page: p } = await boot(USER_A, viewport);
            await p.goto(`${origin}/os?settings=usage`);
            const usage = await settled(p, '[data-usage="ai"]');
            const width = await settingsWidth(p);
            push(`${label} · Usage: the pane loaded (no "Couldn't load")`, usage && ! /Couldn't/.test(usage.status ?? ''), `${usage?.status} · Settings window ${width}px`);
            expectAccount(`${label} · Usage · e2e-standard`, usage, { headline: A_HEADLINE, details: A_DETAILS, titles: A_TITLES, percent: A_PERCENT });
            await shot(p, `bundle-usage-${viewport.width}-ok`);
            // Refresh while the Gateway is down: this user's balance is kept, as of its own time.
            serve = { summary: FIXTURE.unavailable, usage: FIXTURE.usageA };
            await p.click('[data-action="refresh-usage"]');
            await p.waitForFunction(() => /Couldn't refresh/.test(document.querySelector('[data-usage="ai"]')?.textContent ?? ''), null, { timeout: 15000 });
            expectAccount(`${label} · Usage · refresh with the gateway unavailable (kept)`, await readAiMeter(p),
                { headline: A_HEADLINE, details: A_DETAILS, percent: A_PERCENT, stale: true });
            await shot(p, `bundle-usage-${viewport.width}-unavailable-kept`);
            // Billing, from its own deep link.
            serve = { summary: FIXTURE.ok, usage: FIXTURE.usageA };
            await p.goto(`${origin}/os?settings=billing`);
            const billing = await settled(p, '[data-role="meter-ai"]');
            expectAccount(`${label} · Billing · e2e-standard`, billing, { headline: A_HEADLINE, details: A_DETAILS, titles: A_TITLES, percent: A_PERCENT });
            await p.locator('[data-role="meter-ai"]').scrollIntoViewIfNeeded();
            await shot(p, `bundle-billing-${viewport.width}-ok`);
            await ctx.close();
        }
        // Gateway unavailable on open: nothing to keep, nothing shown.
        serve = { summary: FIXTURE.unavailable, usage: FIXTURE.usageA };
        {
            const { ctx, page: p } = await boot(USER_A, { width: 1280, height: 900 });
            await p.goto(`${origin}/os?settings=usage`);
            expectUnavailable('bundle desktop · Usage · gateway unavailable (cold)', await settled(p, '[data-usage="ai"]'), { value: 'Unavailable', note: "We couldn't read your balance." });
            await shot(p, 'bundle-usage-1280-unavailable');
            await p.goto(`${origin}/os?settings=billing`);
            expectUnavailable('bundle desktop · Billing · gateway unavailable (cold)', await settled(p, '[data-role="meter-ai"]'), { value: '—', note: "We couldn't read your credits. Try again later." });
            await ctx.close();
        }
        // User A → B: B sees B's own numbers; a summary read for A is never shown to B.
        for ( const [label, summary, usage] of [['B\'s own summary', FIXTURE.userB, FIXTURE.usageB], ['a summary read for A', FIXTURE.ok, FIXTURE.usageB]] ) {
            serve = { summary, usage };
            const { ctx, page: p } = await boot(USER_B, { width: 1280, height: 900 });
            await p.goto(`${origin}/os?settings=usage`);
            const u = await settled(p, '[data-usage="ai"]');
            if ( summary === FIXTURE.userB ) {
                expectAccount(`bundle desktop · Usage · signed in as B, ${label}`, u, { headline: B_HEADLINE, details: B_DETAILS, percent: '37' });
                await shot(p, 'bundle-usage-1280-user-b');
            } else {
                expectUnavailable(`bundle desktop · Usage · signed in as B, ${label}`, u, { value: 'Unavailable', note: "We couldn't read your balance." });
                await shot(p, 'bundle-usage-1280-user-b-gets-a');
            }
            await p.goto(`${origin}/os?settings=billing`);
            await p.waitForFunction(() => /credits left|—|Couldn't|Try again/.test(document.querySelector('[data-role="billing-body"]')?.textContent ?? ''), null, { timeout: 15000 });
            const b = await readAiMeter(p);
            if ( summary === FIXTURE.userB ) expectAccount(`bundle desktop · Billing · signed in as B, ${label}`, b, { headline: B_HEADLINE, details: B_DETAILS, percent: '37' });
            else {
                const text = await p.evaluate(() => document.querySelector('[data-role="billing-body"]').textContent.replace(/\s+/g, ' ').trim());
                push(`bundle desktop · Billing · signed in as B, ${label}: A's balance is not shown`, ! /1,263|1,300/.test(text), text.slice(0, 120));
                await shot(p, 'bundle-billing-1280-user-b-gets-a');
            }
            await ctx.close();
        }
        push('bundle: no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
        push('bundle: the panes read billing.summary and billing.usage from the stub', requests.includes('/api/trpc/billing.summary') && requests.includes('/api/trpc/billing.usage'), [...new Set(requests)].join(' '));
    } finally {
        server.close();
    }
} finally {
    await browser.close();
}

if ( shots.length ) console.log(`\nscreenshots:\n${shots.join('\n')}`);
const failed = checks.filter(c => ! c.pass);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed (identity credits, real-shape fixture, real browser)`);
process.exit(failed.length ? 1 : 0);
