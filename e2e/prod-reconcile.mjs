/**
 * prod-reconcile.mjs — the reconcile path, against the LIVE deployment.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       EZIL_E2E_EMAIL=... EZIL_E2E_PASSWORD=... node e2e/prod-reconcile.mjs
 *
 * Exit 2 = could not run (never a pass).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PROVES THAT NOTHING ELSE CAN
 * ═══════════════════════════════════════════════════════════════════════════
 * The troubleshoot restart resets a container to 1920x1080 and deliberately
 * sets no NEKO_SCREEN. Before the read route existed, the shell had no way to
 * discover that: `stream` is written only by the boot read-back and by a
 * successful resize, and the controller's dedup is seeded with the boot ASK,
 * so every later measurement was dropped as settled against a belief that had
 * stopped being true. On a phone the picture stayed letterboxed into a
 * landscape aspect until the window was closed and reopened.
 *
 * That cannot be simulated honestly anywhere but here — it needs a real
 * container to actually restart underneath a real shell.
 *
 * It also does something this deploy needs on its own: a restart FORCES A
 * FRESH CONTAINER, so whatever this measures afterwards is measuring the
 * newly rolled image rather than a warm instance of the previous one.
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
// 🔴 NO CREDENTIAL DEFAULTS. This suite signs in to the LIVE deployment, so a
// hardcoded fallback here is a working production account published in a
// public repository. Absent config is "could not run" (exit 2), never a pass
// and never a silent sign-in as somebody.
const EMAIL = process.env.EZIL_E2E_EMAIL;
const PASS = process.env.EZIL_E2E_PASSWORD;
if (!EMAIL || !PASS) {
  console.error('SKIP: set EZIL_E2E_EMAIL and EZIL_E2E_PASSWORD to run this suite against the live deployment.');
  process.exit(2);
}
const results = [];
const check = (n, p, d = '') => { results.push({ n, p: !!p, d }); console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // A PHONE, deliberately. The defect is only visible when the desktop's
  // correct shape and the post-restart 1920x1080 are different aspects — on a
  // landscape desktop a stale 1920x1080 looks approximately right.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const p = await ctx.newPage();
  const screenCalls = [];
  p.on('request', r => {
    if (/\/api\/shell\/screen/.test(r.url())) screenCalls.push(`${r.method()} ${r.url().split('?')[0]}`);
  });

  await p.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await p.fill('#email', EMAIL); await p.fill('#password', PASS);
  await Promise.all([
    p.waitForURL(u => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
    p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
  ]);
  check('sign-in leaves /login', !/\/login/.test(p.url()), p.url().slice(0, 50));

  await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
  catch { await p.locator('.taskbar-item').nth(1).click({ timeout: 12000 }).catch(() => {}); }
  const opened = await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => null);
  check('the desktop window opens', !!opened);
  await p.waitForFunction(() => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'), null, { timeout: 60000 }).catch(() => {});
  await p.waitForTimeout(6000);

  const geo = () => p.evaluate(() => {
    const el = document.querySelector('.window[data-app="desktop"]');
    const b = el?.querySelector('.window-body');
    const i = el?.querySelector('iframe.window-app-iframe');
    const R = n => n ? n.getBoundingClientRect() : null;
    const br = R(b), ir = R(i);
    return { body: br && { w: Math.round(br.width), h: Math.round(br.height) },
             frame: ir && { w: Math.round(ir.width), h: Math.round(ir.height) } };
  });

  const before = await geo();
  const portraitBefore = !!before.frame && before.frame.h > before.frame.w;
  check('setup: the phone desktop is PORTRAIT before the restart', portraitBefore, JSON.stringify(before));

  // ── the restart: a real container, really restarted ──────────────────────
  const restart = await p.evaluate(async () => {
    const cid = window.__EZIL_BOOT__?.computer?.id;
    if (!cid) return { ok: false, why: 'no computer id on the boot payload' };
    const r = await fetch('/api/shell/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ computerId: cid }),
    });
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* non-JSON */ }
    // 🔴 THE BODY, NOT THE STATUS. This route answers HTTP 200 with
    // `{ok:false, errorCode}` on failure — the whole `/api/shell/*` family
    // does. Checking `r.ok` here passed a run in which the restart had
    // plainly failed, which is precisely the "success and failure render
    // identically" trap this suite exists to catch elsewhere.
    return { httpOk: r.ok, status: r.status, ok: parsed?.ok === true,
             errorCode: parsed?.errorCode ?? parsed?.error?.code ?? null,
             body: text.slice(0, 240) };
  });
  check('the desktop restart actually succeeded (body.ok, NOT just HTTP 200)',
    restart.ok === true,
    `http=${restart.status} ok=${restart.ok} errorCode=${restart.errorCode} body=${String(restart.body).slice(0, 120)}`);

  // Let the container actually go away and come back, then let the shell
  // notice. The reconcile fires on a restore, so drive one.
  await sleep(45000);
  await p.evaluate(async () => {
    const el = document.querySelector('.window[data-app="desktop"]');
    el?.querySelector('.window-head .window-minimize-btn')?.click();
    await new Promise(r => setTimeout(r, 900));
    document.querySelector('.taskbar-item[data-app="desktop"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(20000);

  const reads = screenCalls.filter(c => c.startsWith('GET'));
  check('🔴 the shell READ the screen (the route that did not exist before this deploy)',
    reads.length > 0, `${reads.length} GET /api/shell/screen call(s); all calls: ${JSON.stringify(screenCalls.slice(-4))}`);

  const after = await geo();
  check('🔴 the picture is still PORTRAIT after a restart — not letterboxed into a stale 1920x1080',
    !!after.frame && after.frame.h > after.frame.w,
    `before=${before.frame?.w}x${before.frame?.h} after=${after.frame?.w}x${after.frame?.h}`);
  const wasted = after.frame ? 100 * (1 - (after.frame.w * after.frame.h) / (after.body.w * after.body.h)) : 100;
  check('🔴 …and it still fills the window (a stale landscape mode would waste ~60%)',
    wasted <= 12, `wasted=${wasted.toFixed(1)}%  frame=${after.frame?.w}x${after.frame?.h} body=${after.body?.w}x${after.body?.h}`);

  await ctx.close();
} finally { await browser.close(); }

const failed = results.filter(r => !r.p);
console.log(`\n${'='.repeat(64)}\nreconcile  ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('\nFAILURES:'); for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ''}`); }
process.exit(failed.length === 0 ? 0 : 1);
