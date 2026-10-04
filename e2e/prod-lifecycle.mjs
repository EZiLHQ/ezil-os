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

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset'); process.exit(2); }
const require_ = createRequire(REQ_DIR + '/x.js');
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { console.error('SKIP: playwright unresolvable from ' + REQ_DIR); process.exit(2); }
const EMAIL = process.env.EZIL_E2E_EMAIL;
const PASS = process.env.EZIL_E2E_PASSWORD;
if (!EMAIL || !PASS) { console.error('SKIP: set EZIL_E2E_EMAIL and EZIL_E2E_PASSWORD'); process.exit(2); }

/** The Worker's flush alarm backs off to 60 s; a release-triggered stop lands within one cycle plus the final checkpoint. */
const AFTER_RELEASE_WAIT_MS = 100_000;
const FILE = 'README.md';
/** VS Code's tab `.label-name` shows the name WITHOUT its extension (the extension is a separate span). */
const TAB_LABEL = FILE.replace(/\.[^.]+$/, '');

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

  // Sign-in is retried once: the redesigned login page occasionally stays put
  // on the first submit in CI (an app-side flake seen across every suite).
  for (let attempt = 1; attempt <= 2 && (attempt === 1 || /\/login/.test(p.url())); attempt++) {
    await p.goto(`${APP}/login?method=email`, { waitUntil: 'domcontentloaded' });
    await p.fill('#email', EMAIL); await p.fill('#password', PASS);
    await Promise.all([
      p.waitForURL(u => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
      p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
    ]);
  }
  check('sign-in leaves /login', !/\/login/.test(p.url()), p.url().slice(0, 60));
  await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
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
  const tabs = async (f) => f.$$eval('.tabs-container .tab .label-name', els => els.map(e => e.textContent)).catch(() => []);
  const closeWindow = (app) => p.evaluate((a) => window.$(`.window[data-app="${a}"]`).close(), app);

  // 1. Code, with a file open.
  const t0 = Date.now();
  let f = await openCode();
  check('Code opens to a live editor', !!f, `${Date.now() - t0}ms`);
  if (f) {
    await p.waitForTimeout(4000);
    await p.locator('.window[data-app="code"] iframe.window-app-iframe').click({ position: { x: 400, y: 300 } }).catch(() => {});
    await p.keyboard.press('Control+P'); await p.waitForTimeout(1000);
    await p.keyboard.type(FILE); await p.waitForTimeout(1500); await p.keyboard.press('Enter');
    await p.waitForTimeout(3000);
  }
  const before = f ? await tabs(f) : [];
  check(`a file opens in Code (${FILE})`, before.includes(TAB_LABEL), JSON.stringify(before));

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

  // 5. Close Code, reopen it on the same computer: where the user left off.
  await closeWindow('code');
  await p.waitForTimeout(3000);
  const t1 = Date.now();
  f = await openCode();
  check('Code reopens to a live editor', !!f, `${Date.now() - t1}ms`);
  await p.waitForTimeout(5000);
  const after = f ? await tabs(f) : [];
  check(`🔴 reopening Code restores the open file (${FILE})`, after.includes(TAB_LABEL), JSON.stringify(after));

  await ctx.close();
} finally {
  await b.close();
}

const failed = results.filter(r => !r.ok).length;
console.log(`\nlifecycle  ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
