// billing-layout-browser-test.mjs — EZiL-authored. REAL-BROWSER layout checks
// for the Round 5 (D6) Billing pane and the confirm sheet, against the BUILT
// stylesheet (app/public/os/bundle.min.css).
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> node shell/ezil/ui/Settings/billing-layout-browser-test.mjs
//       (after shell/build-shell.sh)
//
// Why a browser: jsdom resolves neither container queries nor the cascade
// between `.ezil-upgrade-sheet button` and `.ezil-confirm-actions
// .ezil-settings-btn`. The L5b design review found both by rendering:
//   - the three plan cards stacked inside the fixed 760x560 Settings window
//     (a 640 px container query never matched the ~512 px pane), and
//   - the confirm sheet's Cancel painted the same accent as its primary.
// Exit 2 (skip) when playwright is not resolvable — never a silent pass.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { summaryV3 } from './billing-v3-fixtures.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
if ( ! fs.existsSync(path.join(OS, 'bundle.min.css')) ) {
    console.error(`missing ${path.join(OS, 'bundle.min.css')} — run shell/build-shell.sh first`);
    process.exit(2);
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

// The real renderers, bundled from source (the same way settings-design-test does).
const { buildSync } = require(require.resolve('esbuild', { paths: [path.resolve(here, '../../../../app')] }));
const renderers = buildSync({
    stdin: { contents: `
        import { summaryV3Html } from './tabs/billing.js';
        import { openConfirmSheet } from './sheet-frame.js';
        window.layout = { summaryV3Html, openConfirmSheet };
    `, resolveDir: here },
    bundle: true, write: false, format: 'iife', target: 'es2022',
}).outputFiles[0].text;
const css = fs.readFileSync(path.join(OS, 'bundle.min.css'), 'utf8');

function billingSummary (tier) {
    const s = summaryV3(tier);
    s.ai.state = 'ok';
    s.computer.disk = tier === 'free' ? { provisionedGiB: null, usedBytes: null, growsOnSwitch: false } : { provisionedGiB: 50, usedBytes: null, growsOnSwitch: false };
    s.computer.standing = tier === 'free' ? 'free' : 'paid';
    if ( tier !== 'free' ) s.ai.included = { granted: s.ai.grant.amount, remaining: Math.floor(s.ai.grant.amount * 0.8), periodEnd: '2026-11-01T00:00:00Z' };
    s.actions.topup = true;
    s.catalog.packs = [{ sku: 'ai_pack_100_v2', aiCredits: 1000, creditCents: 10000, discountPercent: 20, totalCents: 8000, currency: 'usd' }];
    return s;
}

// The Settings window's own structure (index.js buildHtml), at its default 760x560.
const page_html = width => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>
    <style>html, body { margin: 0; background: #000; }</style>
    <script>window.html_encode = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));</script></head><body>
    <div class="window ezil-settings-window" style="display: block; position: absolute; left: 0; top: 0; width: ${width}px; height: 560px;">
        <div class="window-body" style="height: 100%; overflow: auto;">
            <div class="ezil-settings">
                <nav class="ezil-settings-sidebar" role="tablist" aria-label="Settings"><button type="button" class="ezil-settings-tab active">Billing</button></nav>
                <div class="ezil-settings-content"><div class="ezil-settings-pane active" data-pane="billing" role="tabpanel">
                    <div class="ezil-settings-billing"><div data-role="billing-body"></div></div>
                </div></div>
            </div>
        </div>
    </div></body></html>`;

const browser = await chromium.launch();
try {
    for ( const [label, viewport, width] of [['desktop 760x560 window', { width: 1440, height: 1000 }, 760], ['phone 390 px', { width: 390, height: 844 }, 390]] ) {
        const page = await browser.newPage({ viewport });
        await page.setContent(page_html(width));
        await page.addScriptTag({ content: renderers });
        for ( const tier of ['free', 'standard', 'premium'] ) {
            const html = await page.evaluate(summary => window.layout.summaryV3Html(summary), billingSummary(tier));
            const m = await page.evaluate(html => {
                const body = document.querySelector('[data-role="billing-body"]');
                body.innerHTML = html;
                const offers = [...document.querySelectorAll('[data-role="plan-offer"]')].map(el => el.getBoundingClientRect());
                const pane = document.querySelector('.ezil-settings-billing');
                const summary = document.querySelector('[data-role="ai-topup"] summary');
                return {
                    tops: offers.map(r => Math.round(r.top)), widths: offers.map(r => Math.round(r.width)),
                    paneWidth: Math.round(pane.getBoundingClientRect().width),
                    overflow: pane.scrollWidth - pane.clientWidth,
                    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    marker: summary ? getComputedStyle(summary, '::after').content : 'none',
                };
            }, html);
            if ( width === 760 ) {
                push(`${label} · ${tier}: Free | Standard | Premium sit side by side`, m.tops.length === 3 && new Set(m.tops).size === 1, `pane ${m.paneWidth}px tops ${m.tops} widths ${m.widths}`);
                push(`${label} · ${tier}: each plan card is at least 140 px wide`, m.widths.every(w => w >= 140), `${m.widths}`);
            } else {
                push(`${label} · ${tier}: the plan cards stack`, m.tops.length === 3 && new Set(m.tops).size === 3, `${m.tops}`);
            }
            push(`${label} · ${tier}: no horizontal overflow`, m.overflow <= 0 && m.docOverflow <= 0, `pane ${m.overflow} doc ${m.docOverflow}`);
            push(`${label} · ${tier}: the Add AI credits disclosure shows a marker`, m.marker !== 'none' && m.marker !== 'normal', m.marker);
        }
        // Identity credits (`ai.account`): the headline and the exact details line fit the pane, with a bar over the total.
        const identity = billingSummary('premium');
        identity.ai.account = { userId: null, state: 'ok', asOf: '2026-10-26T05:00:00Z', totalMicro: '1500000000', remainingMicro: '1246750000', heldMicro: '500000',
            usedMicro: '252750000', planBaselineMicro: '1000000000', labelled: true, grants: [
                { kind: 'plan', creditsMicro: '1000000000', remainingMicro: '746750000', expiresAt: '2026-11-04T00:00:00Z' },
                { kind: 'added', creditsMicro: '500000000', remainingMicro: '500000000', expiresAt: '2027-06-01T00:00:00Z' }] };
        const a = await page.evaluate(html => {
            document.querySelector('[data-role="billing-body"]').innerHTML = html;
            const pane = document.querySelector('.ezil-settings-billing'), row = document.querySelector('[data-role="meter-ai"]');
            const details = row.querySelector('[data-role="ai-details"]'), gauge = row.querySelector('[role="meter"]');
            return { value: row.querySelector('.ezil-billing-meter-value').textContent, details: details.textContent.replace(/\s+/g, ' ').trim(),
                fits: details.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5, gauge: gauge?.getAttribute('aria-valuenow') ?? null,
                fill: gauge ? Math.round(gauge.querySelector('span').getBoundingClientRect().width / gauge.getBoundingClientRect().width * 100) : null,
                overflow: pane.scrollWidth - pane.clientWidth, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        }, await page.evaluate(summary => window.layout.summaryV3Html(summary), identity));
        push(`${label} · identity credits: headline over the live-grant total`, a.value === '1,246 credits left of 1,500', a.value);
        push(`${label} · identity credits: exact details line`, a.details === 'Plan 1,000 · Added 500 · Used 252.75 · Reserved 0.5 · Remaining 1,246.75', a.details);
        push(`${label} · identity credits: the bar is 83 % (1,246.75 of 1,500) and painted to match`, a.gauge === '83' && Math.abs(a.fill - 83) <= 1, `${a.gauge} / ${a.fill}`);
        push(`${label} · identity credits: details wrap inside the row; no horizontal overflow`, a.fits && a.overflow <= 0 && a.docOverflow <= 0, `pane ${a.overflow} doc ${a.docOverflow}`);
        // Payment grace (D17) on a nearly spent total: the row warns from the total, and this period's credits wait for the payment.
        const grace = billingSummary('premium');
        Object.assign(grace.plan, { status: 'past_due', paymentIssue: 'payment_failed' });
        Object.assign(grace.ai, { included: { granted: 0, remaining: 0, periodEnd: '2026-11-01T00:00:00Z' }, pendingFromRenewal: { credits: 1000, at: '2026-11-01T00:00:00Z' },
            account: { ...identity.ai.account, totalMicro: '1000000000', remainingMicro: '64000000', heldMicro: '0', usedMicro: '936000000', grants: [
                { kind: 'previous', creditsMicro: '1000000000', remainingMicro: '64000000', expiresAt: '2026-11-04T00:00:00Z' }] } });
        const g = await page.evaluate(html => {
            document.querySelector('[data-role="billing-body"]').innerHTML = html;
            const pane = document.querySelector('.ezil-settings-billing'), row = document.querySelector('[data-role="meter-ai"]');
            const notes = [...row.querySelectorAll('.ezil-billing-note')], note = notes.find(p => /payment goes through/.test(p.textContent));
            const low = notes.find(p => p.textContent === '! Running low');
            return { warn: row.classList.contains('is-warn') && !! low && low.getBoundingClientRect().height > 0, text: row.textContent.replace(/\s+/g, ' '),
                note: note?.textContent ?? null, fits: !! note && note.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
                overflow: pane.scrollWidth - pane.clientWidth, docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
        }, await page.evaluate(summary => window.layout.summaryV3Html(summary), grace));
        push(`${label} · identity grace: 64 of 1,000 left warns on the row ("! Running low" shown)`, g.warn, g.text.slice(0, 80));
        push(`${label} · identity grace: this period's credits wait for the payment, never "more from"`,
            g.note === '1,000 credits for this period. Added once your payment goes through.' && ! /more from/.test(g.text), g.note);
        push(`${label} · identity grace: the note wraps inside the row; no horizontal overflow`, g.fits && g.overflow <= 0 && g.docOverflow <= 0, `pane ${g.overflow} doc ${g.docOverflow}`);
        await page.close();
    }

    // The confirm sheet: ONE accent button. Cancel is a quiet secondary; both reach 44 px.
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.setContent(page_html(760));
    await page.addScriptTag({ content: renderers });
    const sheet = await page.evaluate(() => {
        void window.layout.openConfirmSheet({ container: document.querySelector('.window-body'), sheet: 'confirm-switch', title: 'Switch to 4 vCPU · 16 GB?',
            lines: ['Your computer restarts on the new size. Open apps close; save your work first.'], confirmLabel: 'Restart and switch' });
        const dialog = document.querySelector('[data-sheet="confirm-switch"]');
        const style = el => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, h: el.getBoundingClientRect().height }; };
        return { cancel: style(dialog.querySelector('[data-action="cancel"]')), primary: style(dialog.querySelector('[data-action="confirm"]')),
            focused: document.activeElement?.dataset.action ?? null };
    });
    push('confirm sheet: Cancel and the primary do not share a fill', sheet.cancel.bg !== sheet.primary.bg, `cancel ${sheet.cancel.bg} primary ${sheet.primary.bg}`);
    push('confirm sheet: the primary is the accent', sheet.primary.bg === 'rgb(0, 173, 181)', sheet.primary.bg);
    push('confirm sheet: Cancel and the primary are at least 44 px tall', sheet.cancel.h >= 44 && sheet.primary.h >= 44, `${sheet.cancel.h} / ${sheet.primary.h}`);
    push('confirm sheet: initial focus is Cancel', sheet.focused === 'cancel', sheet.focused);
    await page.close();
} finally {
    await browser.close();
}

const failed = checks.filter(c => ! c.pass);
console.log(`\n${checks.length - failed.length} passed, ${failed.length} failed (billing layout, real browser)`);
process.exit(failed.length ? 1 : 0);
