import { signIn } from './sign-in.mjs';
import { openQuickInput } from './code-picker.mjs';
/**
 * EZiL-OS lifecycle check against a deployed stack: a computer must not be
 * stopped under a window that is still using it, and the editor must reopen
 * where the user left off.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Production 2026-10-04 05:59Z, founder-reported: closing the desktop window
 * released the computer ("presence ended 30 minutes ago") in the same second
 * other windows were opened on it; the Worker idle-stopped it 15 s later and
 * every request from the still-open windows answered
 * `410 {"code":"STALE_PREVIEW_URL"}` — raw JSON inside the window — while the
 * whole CI/CD suite was green. Nothing in the suite closed a window and kept
 * using the computer.
 *
 *   1. Open Code and a file in it.
 *   2. Open the desktop, then CLOSE it (the release).
 *   3. Wait past the Worker's flush alarm (<= 60 s) plus a stop.
 *   4. 🔴 The Code window's origin must still answer — not 410 STALE.
 *   5. Close Code and reopen it on the same computer: the file's tab is back.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       EZIL_E2E_EMAIL=... EZIL_E2E_PASSWORD=... node e2e/prod-lifecycle.mjs
 * Exit 0 = all checks passed. Exit 1 = a real failure. Exit 2 = could not run.
 */
import { createRequire } from 'node:module';
import { APP, configureAppContext } from './deployed-target.mjs';
import { verifySelectedComputer } from './isolated-computer.mjs';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('FAIL: PLAYWRIGHT_REQUIRE_DIR unset'); process.exit(2); }
const require_ = createRequire(REQ_DIR + '/x.js');
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { console.error('FAIL: playwright unresolvable'); process.exit(2); }
const EMAIL = process.env.EZIL_E2E_EMAIL;
const PASS = process.env.EZIL_E2E_PASSWORD;
if (!EMAIL || !PASS) { console.error('FAIL: set EZIL_E2E_EMAIL and EZIL_E2E_PASSWORD'); process.exit(2); }

/** The Worker's flush alarm backs off to 60 s; a release-triggered stop lands within one cycle plus the final checkpoint. */
const AFTER_RELEASE_WAIT_MS = 100_000;
const FILE = 'README.md';
const fileTab = frame => frame.locator('.tabs-container .tab').filter({hasText:FILE});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await configureAppContext(ctx);
  const p = await ctx.newPage();
  const stale = [];
  p.on('response', r => { if (r.status() === 410) stale.push(r.url()); });

  await p.goto(`${APP}/login?method=email`, { waitUntil: 'domcontentloaded' });
  await signIn(p, { email: EMAIL, password: PASS });
  check('sign-in leaves /login', !/\/login/.test(p.url()), p.url().slice(0, 60));
  await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
  await verifySelectedComputer(p);
  await p.waitForTimeout(3500);

  const codeFrame = () => p.frames().find(f => /-code\./.test(f.url()));
  const openCode = async () => {
    // The shell's own registry first (the same call its dock makes); the dock tile as fallback.
    const launched = await p.evaluate(() => {
      const ez = window.ezil;
      const payload = ez?.session?.payload?.();
      if (!ez?.registry?.launch || !payload?.computer) return false;
      void ez.registry.launch('code', { payload, computer: payload.computer, desktopState: payload.desktopState });
      return true;
    }).catch(() => false);
    if (!launched) await p.locator('.taskbar-item[data-app="code"]').first().click({ timeout: 15000 }).catch(() => {});
    for (let i = 0; i < 90; i++) {
      const f = codeFrame();
      if (f && await f.$('.monaco-workbench').catch(() => null)) return f;
      await p.waitForTimeout(2000);
    }
    // Say what the window shows instead, so a failure here is diagnosable.
    const seen = await p.evaluate(() => {
      const w = document.querySelector('.window[data-app="code"]');
      return { windows: [...document.querySelectorAll('.window')].map(x => x.getAttribute('data-app')),
               src: w?.querySelector('iframe')?.getAttribute('src')?.replace(/token=[^&]*/, 'token=…') ?? null,
               text: (w?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200) };
    }).catch(e => String(e));
    console.log('      code window:', JSON.stringify(seen), 'launched-via-registry:', launched,
      'frames:', JSON.stringify(p.frames().map(fr => fr.url().split('?')[0].slice(0, 80))));
    return null;
  };
  // 🔴 What the founder saw: the SDK's raw JSON as the page inside a window.
  const rawStaleVisible = async () => {
    for (const fr of p.frames()) {
      const text = await fr.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (text.includes('STALE_PREVIEW_URL')) return fr.url().split('?')[0];
    }
    return null;
  };
  const desktopPaints = async () => {
    for (let i = 0; i < 45; i++) {
      await p.waitForTimeout(2000);
      const f = p.frames().find(fr => /nekodesktop/.test(fr.url()));
      if (!f) continue;
      const px = await f.evaluate(() => {
        const v = document.querySelector('video'); if (!v || !v.videoWidth) return null;
        const c = document.createElement('canvas'); c.width = 64; c.height = 40;
        const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 40);
        const d = g.getImageData(0, 0, 64, 40).data; let mx = 0;
        for (let k = 0; k < d.length; k += 4) mx = Math.max(mx, d[k], d[k + 1], d[k + 2]);
        return { w: v.videoWidth, max: mx };
      }).catch(() => null);
      if (px && px.max > 0) return px;
    }
    return null;
  };
  const tabs = async (f) => f.$$eval('.tabs-container .tab .label-name', els => els.map(e => e.textContent)).catch(() => []);
  const closeWindow = (app) => p.evaluate((a) => window.$(`.window[data-app="${a}"]`).close(), app);

  // 1. Code, with a file open.
  const t0 = Date.now();
  let f = await openCode();
  check('Code opens to a live editor', !!f, `${Date.now() - t0}ms`);
  if (f) {
    // Use Code's visible file picker. An iframe click can leave focus in the
    // workbench or welcome page, where the host shortcut never opens a file.
    await (await openQuickInput(f)).fill(FILE);
    await f.locator('.quick-input-list .monaco-list-row:visible').filter({hasText:FILE}).first().click();
    await fileTab(f).first().waitFor({state:'visible',timeout:15000});
    // Pin the editor tab so a preview tab can be restored on reopen.
    await fileTab(f).first().dblclick();
  }
  const before = f ? await tabs(f) : [];
  check(`a file opens in Code (${FILE})`, !!f && await fileTab(f).count() === 1, JSON.stringify(before));

  // 2. The desktop, then close it: the release.
  try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
  catch { await p.locator('.taskbar-item[data-app="desktop"]').first().click({ timeout: 12000 }).catch(() => {}); }
  const desk = await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => null);
  check('the desktop window opens', !!desk);
  await p.waitForTimeout(5000);
  await closeWindow('desktop');
  await p.waitForTimeout(1000);
  check('the desktop window is closed', (await p.$$('.window[data-app="desktop"]')).length === 0);

  // 3/4. Past the alarm, the Code window's computer must still be serving.
  await p.waitForTimeout(AFTER_RELEASE_WAIT_MS);
  f = codeFrame();
  const status = f ? await f.evaluate(async () => (await fetch('/healthz', { cache: 'no-store' })).status).catch(e => String(e)) : 'no frame';
  check('🔴 closing the desktop did not stop the computer under the open Code window (its origin still answers, not 410 STALE)',
    status === 200, `status=${status}`);
  check('🔴 no request on the page answered 410 STALE_PREVIEW_URL', stale.length === 0, stale.slice(0, 2).join(' | ').slice(0, 160));
  const rawAfterRelease = await rawStaleVisible();
  check('🔴 no window shows the raw STALE_PREVIEW_URL JSON', !rawAfterRelease, String(rawAfterRelease ?? ''));

  // 5. Close Code, reopen it on the same computer: where the user left off.
  await closeWindow('code');
  await p.waitForTimeout(3000);
  const t1 = Date.now();
  f = await openCode();
  check('Code reopens to a live editor', !!f, `${Date.now() - t1}ms`);
  await p.waitForTimeout(5000);
  const after = f ? await tabs(f) : [];
  check(`🔴 reopening Code restores the open file (${FILE})`, !!f && await fileTab(f).count() === 1, JSON.stringify(after));

  // 6. The Browser/Desktop surface: reopen the desktop after its own release.
  try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
  catch { await p.locator('.taskbar-item[data-app="desktop"]').first().click({ timeout: 12000 }).catch(() => {}); }
  const t2 = Date.now();
  const px = await desktopPaints();
  check('🔴 the desktop reopened after its release PAINTS (a fresh URL against the active runtime)', !!px,
    px ? `${Date.now() - t2}ms ${px.w}px` : 'no video');
  const rawEnd = await rawStaleVisible();
  check('🔴 …and no window shows the raw STALE_PREVIEW_URL JSON at the end either', !rawEnd, String(rawEnd ?? ''));

  await ctx.close();
} finally {
  await b.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\nlifecycle  ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
