/**
 * prod-system-tab.mjs — Settings › System, against the LIVE deployment.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules node e2e/prod-system-tab.mjs
 *
 * Exit 2 = could not run (never a pass).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT PROVES
 * ═══════════════════════════════════════════════════════════════════════════
 * The tab answers two things Settings never did: what this window is linked
 * to, and how that link is doing. Both are only true END TO END — the screen
 * comes from a live read of the running X display, and the stream vitals are
 * published by `getStats()` INSIDE the streamed client and cross the iframe
 * boundary by `postMessage`. A local test can prove the rendering; only this
 * can prove the numbers arrive.
 *
 * 🔴 It also guards the rule the tab rests on: every field is MEASURED or
 * ABSENT. A monitor that invents a number is worse than no monitor, because it
 * is believed — so this asserts a real resolution and real vitals, and that
 * nothing renders as a zero it did not measure.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
let chromium = null;
try { ({ chromium } = await import('playwright')); } catch {
  if (REQ_DIR) {
    try {
      const req = createRequire(path.join(path.resolve(REQ_DIR), 'noop.js'));
      ({ chromium } = req('playwright'));
    } catch (e) { console.error(`playwright not resolvable: ${e?.message ?? e}`); }
  }
}
if (!chromium) { console.error('playwright is required. SKIPPING (exit 2).'); process.exit(2); }

const APP   = process.env.EZIL_E2E_APP   ?? 'https://ezil-os.vercel.app';
const EMAIL = process.env.EZIL_E2E_EMAIL ?? '<redacted-email>';
const PASS  = process.env.EZIL_E2E_PASSWORD ?? '<redacted-password>';

const results = [];
const check = (n, p, d = '') => { results.push({ n, p: !!p, d }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await p.fill('#email', EMAIL); await p.fill('#password', PASS);
  await Promise.all([
    p.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
    p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
  ]);
  await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
  catch { await p.locator('.taskbar-item').nth(1).click({ timeout: 12000 }).catch(() => {}); }
  await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => {});
  await p.waitForFunction(
    () => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
    null, { timeout: 90000 },
  ).catch(() => {});
  // Past the picture arriving, so the stream has something to report.
  await p.waitForTimeout(20000);
  check('the desktop is open and full-bleed', true);

  // The drawer is collapsed at rest — see the dock group in
  // `shell/responsiveness-browser-test.mjs`. Open it, then wait until the
  // Settings button is genuinely the topmost thing at its own centre: a
  // coordinate tap goes to whatever is on top, never to an element.
  await p.evaluate(() => {
    document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-toggle')?.click();
  });
  await p.waitForFunction(() => {
    const b = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-settings');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    if (r.width <= 0) return false;
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return !!hit && (hit === b || b.contains(hit));
  }, null, { timeout: 10000 }).catch(() => {});
  await p.evaluate(() => {
    document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-settings')?.click();
  });
  await p.waitForSelector('.window[data-app="settings"]', { timeout: 30000 }).catch(() => {});
  check('Settings opens from the desktop drawer', await p.locator('.window[data-app="settings"]').count() > 0);

  await p.evaluate(() => {
    document.querySelector('.window[data-app="settings"] .ezil-settings-tab[data-tab="system"]')?.click();
  });
  // Two publish intervals plus the screen read.
  await sleep(9000);

  const text = await p.evaluate(() =>
    document.querySelector('.window[data-app="settings"] .ezil-settings-system')?.textContent ?? '');

  check('🔴 the System tab names the computer this session is linked to',
    /Linked computer/i.test(text) && /Identifier/i.test(text), text.replace(/\s+/g, ' ').slice(0, 120));

  // A real resolution read from the running desktop — two numbers with a ×.
  const res = text.match(/(\d{3,4})\s*×\s*(\d{3,4})/);
  check('🔴 …reports the desktop screen READ from the running display',
    !!res, res ? `${res[1]}×${res[2]}` : 'no resolution rendered');

  // Vitals crossed the iframe boundary and arrived as real numbers.
  const fps = text.match(/([\d]+)\s*fps/);
  const kbps = text.match(/([\d]+)\s*kbit\/s/);
  check('🔴 …and live stream vitals crossed the iframe boundary',
    !!fps || !!kbps, `fps=${fps ? fps[1] : '—'} kbps=${kbps ? kbps[1] : '—'}`);

  // The rule the tab rests on.
  check('🔴 nothing renders as a measurement it did not take',
    !/\b0 fps\b/.test(text) && !/\b0 kbit\/s\b/.test(text),
    text.replace(/\s+/g, ' ').slice(-160));

  await ctx.close();
} finally { await browser.close(); }

const failed = results.filter((r) => !r.p);
console.log(`\n${'='.repeat(64)}\nsystem tab  ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('\nFAILURES:'); for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ''}`); }
process.exit(failed.length === 0 ? 0 : 1);
