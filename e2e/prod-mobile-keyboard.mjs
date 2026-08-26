/**
 * prod-mobile-keyboard.mjs — the phone keyboard, against the LIVE deployment.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       EZIL_E2E_EMAIL=... EZIL_E2E_PASSWORD=... node e2e/prod-mobile-keyboard.mjs
 *
 * Exit 2 = could not run (never a pass).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS ASSERTS AND WHY IT IS A PRODUCTION TEST
 * ═══════════════════════════════════════════════════════════════════════════
 * Typing "fast" on a phone put "fastfast" into the streamed browser: the
 * client's keyboard delivered every character twice, once as a keysym from
 * `keydown` and once as text from `compositionend`, because a predictive
 * Android keyboard sends real key codes AND runs a composition.
 *
 * It lives here as well as in a container test because the thing that has to
 * be true is that the DEPLOYED image carries the fix — and the image chain is
 * exactly where this nearly went wrong: `ezil-mobile.js` ships in the NEKO
 * BRANDING image, not the worker image, so rebuilding the worker alone leaves
 * the old script in place while every local test passes.
 *
 * Counts the frames that actually leave for the server, by hooking
 * `RTCDataChannel.prototype.send` inside the streamed client's own iframe —
 * not the textarea, and not the DOM, because what matters is what the remote
 * desktop receives.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

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

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  });
  const p = await ctx.newPage();
  await p.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await p.fill('#email', EMAIL); await p.fill('#password', PASS);
  await Promise.all([
    p.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
    p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
  ]);
  check('sign-in leaves /login', !/\/login/.test(p.url()));

  await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3500);
  try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
  catch { await p.locator('.taskbar-item').nth(1).click({ timeout: 12000 }).catch(() => {}); }
  await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => {});

  // Wait for the streamed client to be live inside its own frame.
  let frame = null;
  for (let i = 0; i < 45; i++) {
    await p.waitForTimeout(2000);
    frame = p.frames().find((f) => /nekodesktop/.test(f.url()));
    if (!frame) continue;
    const ready = await frame.evaluate(() => !!document.querySelector('textarea.overlay')).catch(() => false);
    if (ready) break;
  }
  if (!frame) { check('the streamed client frame is reachable', false, 'no nekodesktop frame'); throw new Error('no frame'); }
  check('the streamed client frame is reachable', true);
  await p.waitForTimeout(4000);

  // 🔴 ONE keyboard affordance, at a real touch size.
  const buttons = await frame.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#ezil-kbd-btn, .fa-keyboard, [class*="keyboard"]')) {
      const r = el.getBoundingClientRect();
      if (getComputedStyle(el).display === 'none' || r.width === 0) continue;
      out.push({ id: el.id || null, w: Math.round(r.width), h: Math.round(r.height) });
    }
    return out;
  }).catch(() => []);
  // 🔴 IS THE DEPLOYED CONTAINER EVEN RUNNING THIS BUILD?
  //
  // Everything below asserts BEHAVIOUR, and behaviour is only evidence about
  // the current build if the current build is what is serving. A container
  // keeps the image it was created with until it stops, so a suite can pass
  // perfectly against the PREVIOUS one — which has happened here more than
  // once. Comparing the served client script byte-for-byte against the working
  // tree is the one check that cannot be fooled by that.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const localSrc = fs.readFileSync(
    path.resolve(here, '../worker/assets/neko-branding/www/ezil-mobile.js'), 'utf8');
  const localDigest = crypto.createHash('sha256').update(localSrc).digest('hex');
  const servedDigest = await frame.evaluate(async () => {
    const r = await fetch('ezil-mobile.js');
    const t = await r.text();
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }).catch(() => null);
  check('🔴 the deployed container is serving THIS build of the client script',
    servedDigest === localDigest,
    `served ${String(servedDigest).slice(0, 12)}… local ${localDigest.slice(0, 12)}…`);

  // 🔴 ONE affordance, and it is the CLIENT'S. This asserted the reverse until
  // a real phone showed our own fixed-position button covering the remote
  // browser's tab bar while the client's worked — so the button was removed and
  // the client's grown to a real touch target instead.
  check('🔴 exactly ONE keyboard affordance is on screen (there were two)',
    buttons.length === 1, JSON.stringify(buttons));
  check('…and it clears the 48px Android touch minimum',
    buttons[0] && buttons[0].w >= 48 && buttons[0].h >= 48, JSON.stringify(buttons[0] ?? null));
  check('…and it is the client\'s own control, not one we overlay on the picture',
    buttons[0] && buttons[0].id !== 'ezil-kbd-btn', JSON.stringify(buttons[0] ?? null));

  // 🔴 Each character exactly once, replaying what a predictive keyboard emits.
  const sent = await frame.evaluate(async () => {
    const counts = { keydown: 0, keyup: 0 };
    const orig = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      try {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data)
          : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
        if (buf && buf.length >= 3) {
          if (buf[0] === 0x03) counts.keydown++;
          else if (buf[0] === 0x04) counts.keyup++;
        }
      } catch { /* ignore */ }
      return orig.apply(this, arguments);
    };
    const ta = document.querySelector('textarea.overlay');
    ta.focus();
    const K = (t, i) => ta.dispatchEvent(new KeyboardEvent(t, Object.assign({ bubbles: true }, i)));
    const C = (t, i) => ta.dispatchEvent(new CompositionEvent(t, Object.assign({ bubbles: true }, i)));
    const I = (i) => ta.dispatchEvent(new InputEvent('input', Object.assign({ bubbles: true }, i)));
    C('compositionstart', { data: '' });
    for (const ch of 'fast') {
      const kc = ch.toUpperCase().charCodeAt(0);
      K('keydown', { key: ch, keyCode: kc, which: kc });
      ta.value += ch;
      I({ data: ch, inputType: 'insertCompositionText', isComposing: true });
      K('keyup', { key: ch, keyCode: kc, which: kc });
      await new Promise((r) => setTimeout(r, 25));
    }
    C('compositionend', { data: 'fast' });
    await new Promise((r) => setTimeout(r, 500));
    RTCDataChannel.prototype.send = orig;
    return counts;
  }).catch((e) => ({ error: String(e).slice(0, 120) }));

  check('🔴 typing a 4-character word sends FOUR keydown frames, not eight',
    sent.keydown === 4, JSON.stringify(sent));

  await ctx.close();
} finally { await browser.close(); }

const failed = results.filter((r) => !r.p);
console.log(`\n${'='.repeat(64)}\nmobile keyboard  ${results.length - failed.length}/${results.length} passed`);
if (failed.length) { console.log('\nFAILURES:'); for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ''}`); }
process.exit(failed.length === 0 ? 0 : 1);
