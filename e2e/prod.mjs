/**
 * EZiL-OS production end-to-end check.
 *
 * ── Why this exists, and why it runs against PRODUCTION ─────────────────────
 * On 2026-08-22 the worker suite was 1023 green and the container suite 15/15,
 * proving CDP, the ten sidecar verbs, the password mask and that a navigation
 * changes the X display — while production served a desktop window with NO
 * CLIENT AT ALL. A pinned asset hash 404'd, the neko JS never loaded, and no
 * RTCPeerConnection was ever constructed.
 *
 * Nothing local could have caught it. Media here is TURN-relayed, TURN is not
 * wired locally, and the branding overlay is only exercised when the real image
 * is built. "A signed-in human sees a picture" is answerable in one place.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       EZIL_E2E_EMAIL=... EZIL_E2E_PASSWORD=... node e2e/prod.mjs
 *
 * Exit 0 = all checks passed. Exit 1 = a real failure. Exit 2 = could not run
 * (never a pass — the whole point is that a skipped check must not look green).
 */
import { createRequire } from 'node:module';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset'); process.exit(2); }
const require_ = createRequire(REQ_DIR + '/x.js');
let chromium;
try { ({ chromium } = require_('playwright')); }
catch (e) { console.error('SKIP: playwright unresolvable from ' + REQ_DIR); process.exit(2); }

const APP    = process.env.EZIL_E2E_APP   ?? 'https://ezil-os.vercel.app';
const WORKER = process.env.EZIL_E2E_WORKER?? 'https://api-desktop.ezil.org';
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
const check = (tier, name, ok, detail = '') => {
  results.push({ tier, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${tier}] ${name}${detail ? '  — ' + detail : ''}`);
};

// ── TIER 1: SANITY — cheap, no browser, fails fast ────────────────────────
async function sanity() {
  const h = await fetch(`${WORKER}/health`).then(r => r.json()).catch(() => null);
  check('sanity', 'worker /health answers ok', h?.ok === true, JSON.stringify(h ?? {}).slice(0, 90));
  check('sanity', 'worker reports neko mode supported',
    Array.isArray(h?.supportedDesktopModes) && h.supportedDesktopModes.includes('neko'));

  const login = await fetch(`${APP}/`, { redirect: 'manual' });
  check('sanity', 'app root redirects unauthenticated to /login',
    login.status === 307 && (login.headers.get('location') ?? '').includes('/login'),
    `${login.status}`);

  // Every mutating control route must refuse an unsigned caller. A route that
  // 404s here is a route that does not exist; a 200 is a security defect.
  for (const [path, body] of [
    ['/sandbox/guac-e2e-probe/browser/navigate', { url: 'https://example.com' }],
    ['/sandbox/guac-e2e-probe/screen', { width: 1280, height: 720 }],
    ['/sandbox/guac-e2e-probe/logs', {}],
  ]) {
    const r = await fetch(`${WORKER}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }).catch(() => null);
    check('sanity', `unsigned POST ${path.split('/').pop()} is refused`, r?.status === 401, `${r?.status}`);
  }

  // The sidecar must never be reachable except through the signed route.
  const verbLeak = await fetch(`${WORKER}/sandbox/guac-e2e-probe/browser/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }).catch(() => null);
  check('sanity', 'an unknown browser verb does not leak existence before auth',
    verbLeak?.status === 401, `${verbLeak?.status}`);
}

// ── TIER 2/3: REGRESSION + E2E — a signed-in session, a real picture ──────
async function browserTiers() {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    for (const shape of [
      { tier: 'e2e',        label: 'desktop 1440x900', vp: { width: 1440, height: 900 }, mobile: false },
      { tier: 'regression', label: 'phone 390x844',    vp: { width: 390,  height: 844 }, mobile: true  },
    ]) {
      const ctx = await b.newContext({
        viewport: shape.vp,
        ...(shape.mobile ? {
          hasTouch: true, isMobile: true, deviceScaleFactor: 3,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        } : {}),
      });
      const p = await ctx.newPage();
      const consoleErrors = [];
      p.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
      // 🔴 Record the URL, not just the message. A console line saying
      // "Failed to load resource: 404" names nothing, and the defect this
      // suite exists for — a pinned asset hash 404'ing and killing the neko
      // client — is only diagnosable if the suite says WHICH url. A check that
      // reports a problem it cannot locate costs a debugging session.
      const badResponses = [];
      p.on('response', r => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`); });

      await p.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
      await p.fill('#email', EMAIL); await p.fill('#password', PASS);
      await Promise.all([
        p.waitForURL(u => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
        p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
      ]);
      check(shape.tier, `${shape.label}: sign-in leaves /login`, !/\/login/.test(p.url()), p.url().slice(0, 60));

      await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3500);
      const deviceClass = await p.evaluate(() => document.body.className.match(/device-\w+/)?.[0] ?? null);
      if (shape.mobile) check('regression', 'phone UA resolves to device-phone', deviceClass === 'device-phone', String(deviceClass));

      // The mobile scroll-indicator regression: the backdrop must not scroll.
      if (shape.mobile) {
        const ov = await p.evaluate(() => {
          const d = document.querySelector('.desktop'); if (!d) return null;
          const cs = getComputedStyle(d);
          return { x: cs.overflowX, y: cs.overflowY, scrolls: d.scrollWidth > d.clientWidth || d.scrollHeight > d.clientHeight };
        });
        check('regression', 'phone desktop backdrop does not scroll',
          ov?.x === 'hidden' && ov?.y === 'hidden' && ov?.scrolls === false, JSON.stringify(ov));
      }

      const t0 = Date.now();
      try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
      catch { await p.locator('.taskbar-item').nth(1).click({ timeout: 12000 }).catch(() => {}); }
      const frameEl = await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => null);
      check(shape.tier, `${shape.label}: desktop window opens`, !!frameEl, `${Date.now() - t0}ms`);

      // The check the local suites structurally cannot make: real pixels.
      let px = null, ms = null;
      for (let i = 0; i < 45; i++) {
        await p.waitForTimeout(2000);
        const f = p.frames().find(fr => /nekodesktop/.test(fr.url()));
        if (!f) continue;
        px = await f.evaluate(() => {
          const v = document.querySelector('video');
          if (!v || !v.videoWidth) return null;
          const c = document.createElement('canvas'); c.width = 160; c.height = 100;
          const g = c.getContext('2d'); g.drawImage(v, 0, 0, 160, 100);
          const d = g.getImageData(0, 0, 160, 100).data;
          let mn = 255, mx = 0, s = 0, n = 0;
          for (let k = 0; k < d.length; k += 4) { const l = (d[k] + d[k+1] + d[k+2]) / 3; if (l < mn) mn = l; if (l > mx) mx = l; s += l; n++; }
          return { w: v.videoWidth, h: v.videoHeight, min: +mn.toFixed(1), max: +mx.toFixed(1), mean: +(s/n).toFixed(1) };
        }).catch(() => null);
        if (px && px.max > 0) { ms = Date.now() - t0; break; }
      }
      check(shape.tier, `${shape.label}: the streamed desktop PAINTS`, !!px && px.max > 0,
        px ? `${ms}ms ${px.w}x${px.h} mean=${px.mean}` : 'no video / all-black');

      // A 404 on a hashed asset is what silently killed the client before.
      // Only assets that would break the CLIENT count. A 404 on a decorative
      // sprite is noise; a 404 on the neko bundle is the whole product. Split
      // them so the check that matters cannot be drowned by the one that does
      // not — and so nobody is tempted to delete the noisy one and lose both.
      const critical = badResponses.filter(u => /nekodesktop|\/js\/app|\/css\/app|chunk-vendors|ezil-mobile/.test(u));
      const cosmetic = badResponses.filter(u => !critical.includes(u));
      check(shape.tier, `${shape.label}: no failed request for a client-critical asset`,
        critical.length === 0, critical.slice(0, 2).join(' | ').slice(0, 160));
      if (cosmetic.length) console.log(`      note: ${cosmetic.length} non-critical 4xx — ${cosmetic.slice(0, 2).join(' | ').slice(0, 150)}`);

      await ctx.close();
    }
  } finally { await b.close(); }
}

await sanity();
await browserTiers();

const failed = results.filter(r => !r.ok);
console.log(`\n${'='.repeat(64)}`);
for (const t of ['sanity', 'regression', 'e2e']) {
  const g = results.filter(r => r.tier === t);
  if (g.length) console.log(`${t.padEnd(11)} ${g.filter(r => r.ok).length}/${g.length} passed`);
}
console.log(`TOTAL       ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('\nFAILED:'); failed.forEach(f => console.log(`  [${f.tier}] ${f.name} — ${f.detail}`)); }
process.exit(failed.length ? 1 : 0);
