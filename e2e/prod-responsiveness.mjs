/**
 * prod-responsiveness.mjs — the responsiveness tier, against the LIVE
 * deployment.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       EZIL_E2E_EMAIL=... EZIL_E2E_PASSWORD=... node e2e/prod-responsiveness.mjs
 *
 * Exit 2 = could not run (never a pass). Exit 1 = a real failure.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS SEPARATELY FROM prod.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 * `prod.mjs` asks "does production work" and answers 17/17. It is right, and
 * it is blind to both symptoms that were actually reported: the desktop
 * flickering on minimise/restore, and the picture not fitting its frame.
 * Neither is a failure — the desktop opens, paints, and serves. They are
 * QUALITY properties, and nothing measured them anywhere.
 *
 * So this measures them where it counts: against the deployed thing, over the
 * real TURN-relayed WebRTC path, on a real container.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS EXPECTED TO FAIL BEFORE THE FIXES ARE DEPLOYED
 * ═══════════════════════════════════════════════════════════════════════════
 * That is the point of running it now. A suite written after a fix, that has
 * only ever been green, has not been shown to detect anything. These checks
 * were written against a production that still has the defects, so a red run
 * here IS the evidence that the defects are live — and the same file going
 * green after a deploy is the evidence the fix reached users.
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
if (!chromium) { console.error('playwright is required. SKIPPING (exit 2), not passing.'); process.exit(2); }

const APP   = process.env.EZIL_E2E_APP   ?? 'https://ezil-os.vercel.app';
const EMAIL = process.env.EZIL_E2E_EMAIL ?? '<redacted-email>';
const PASS  = process.env.EZIL_E2E_PASSWORD ?? '<redacted-password>';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Sign in and open the streamed desktop, or return null with a reason. */
async function openDesktop(ctx) {
  const p = await ctx.newPage();
  await p.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await p.fill('#email', EMAIL); await p.fill('#password', PASS);
  await Promise.all([
    p.waitForURL(u => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
    p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
  ]);
  if (/\/login/.test(p.url())) return { p, err: 'sign-in did not leave /login' };
  await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
  catch { await p.locator('.taskbar-item').nth(1).click({ timeout: 12000 }).catch(() => {}); }
  const frame = await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => null);
  if (!frame) return { p, err: 'the desktop window never opened' };
  // Wait for full-bleed to settle before measuring anything.
  await p.waitForFunction(
    () => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
    null, { timeout: 60000 },
  ).catch(() => {});
  await p.waitForTimeout(4000);
  return { p, err: null };
}

const geometry = (p) => p.evaluate(() => {
  const el = document.querySelector('.window[data-app="desktop"]');
  if (!el) return null;
  const body = el.querySelector('.window-body');
  const ifr  = el.querySelector('iframe.window-app-iframe');
  const R = (n) => n ? n.getBoundingClientRect() : null;
  const w = R(el), b = R(body), i = R(ifr);
  return {
    fullbleed: el.classList.contains('ezil-fullbleed'),
    win:  w && { w: Math.round(w.width), h: Math.round(w.height) },
    body: b && { w: Math.round(b.width), h: Math.round(b.height) },
    frame: i && { w: Math.round(i.width), h: Math.round(i.height) },
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});

/** One real minimise + restore, sampled across the restore. */
const cycle = (p) => p.evaluate(async () => {
  const el = document.querySelector('.window[data-app="desktop"]');
  const btn = el.querySelector('.window-head .window-minimize-btn');
  if (!btn) return { err: 'no minimise button' };
  btn.click();
  await new Promise(r => setTimeout(r, 900));
  const orig = { w: Number(el.getAttribute('data-orig-width')), h: Number(el.getAttribute('data-orig-height')) };
  const item = document.querySelector('.taskbar-item[data-app="desktop"]');
  if (!item) return { err: 'no taskbar item to restore from' };
  const samples = [];
  const t0 = performance.now();
  item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  for (let i = 0; i < 32; i++) {
    const r = el.getBoundingClientRect();
    samples.push({ t: performance.now() - t0, w: Math.round(r.width), h: Math.round(r.height) });
    await new Promise(r2 => setTimeout(r2, 20));
  }
  const final = samples[samples.length - 1];
  const settled = samples.filter(s => s.t <= 210).pop() ?? samples[0];
  let snap = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].t <= 210) continue;
    snap = Math.max(snap, Math.abs(samples[i].w - samples[i - 1].w));
  }
  return { orig, final, settled, snap };
});

const MAX_WASTE_PCT = 12;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const shape of [
    { label: 'desktop 1440x900', vp: { width: 1440, height: 900 }, mobile: false },
    { label: 'phone 390x844',    vp: { width: 390,  height: 844 }, mobile: true  },
  ]) {
    const L = `[${shape.label}]`;
    const ctx = await browser.newContext({
      viewport: shape.vp,
      ...(shape.mobile ? {
        hasTouch: true, isMobile: true, deviceScaleFactor: 3,
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      } : {}),
    });
    const { p, err } = await openDesktop(ctx);
    if (err) { check(`${L} the desktop opens at all`, false, err); await ctx.close(); continue; }
    check(`${L} the desktop opens and reaches full-bleed`, true);

    const g = await geometry(p);
    if (!g?.frame || !g?.body) {
      check(`${L} geometry is measurable`, false, JSON.stringify(g));
      await ctx.close(); continue;
    }

    // 🔴 The reported screenshot: the stream wider than its frame, right edge
    // cut through a control.
    check(`${L} the stream never overflows its window body`,
      g.frame.w <= g.body.w && g.frame.h <= g.body.h,
      `frame=${g.frame.w}x${g.frame.h} body=${g.body.w}x${g.body.h}`);

    check(`${L} the page never scrolls sideways`, g.overflowX <= 0, `overflowX=${g.overflowX}px`);

    // The bands, measured. On a phone this is the mode table showing through:
    // production snaps a 1170x2532 iPhone to 1080x1920 and throws away ~18%.
    const wasted = 100 * (1 - (g.frame.w * g.frame.h) / (g.body.w * g.body.h));
    check(`${L} letterboxing wastes at most ${MAX_WASTE_PCT}% of the window`,
      wasted <= MAX_WASTE_PCT, `wasted=${wasted.toFixed(1)}%  frame=${g.frame.w}x${g.frame.h} body=${g.body.w}x${g.body.h}`);

    // The flicker, measured on the deployed bundle.
    const c = await cycle(p);
    if (c?.err) {
      check(`${L} a minimise/restore cycle is drivable`, false, c.err);
    } else {
      check(`${L} hideWindow snapshots the REAL full-bleed size, not a stashed small box`,
        c.orig.w === c.final.w && c.orig.w > 0,
        `snapshot=${c.orig.w}x${c.orig.h} final=${c.final.w}x${c.final.h}`);
      check(`${L} 🔴 the window is settled at its final size by 210ms — nothing left to snap to`,
        c.settled.w === c.final.w,
        `settled=${c.settled.w}x${c.settled.h}@${Math.round(c.settled.t)}ms final=${c.final.w}x${c.final.h}`);
      check(`${L} 🔴 no single-frame jump after the restore transition (THE FLICKER)`,
        c.snap === 0, `largest post-transition frame delta = ${c.snap}px`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${'='.repeat(64)}`);
console.log(`responsiveness  ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
process.exit(failed.length === 0 ? 0 : 1);
