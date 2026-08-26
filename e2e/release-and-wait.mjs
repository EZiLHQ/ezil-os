/**
 * release-and-wait.mjs — force a genuinely FRESH container, then wait for it.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules \
 *       EZIL_E2E_EMAIL=... EZIL_E2E_PASSWORD=... node e2e/release-and-wait.mjs
 *
 * Exit 0 = a fresh container is serving. Exit 1 = it never arrived.
 * Exit 2 = could not run (never a pass).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 WHY THIS IS NEEDED AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 * A container keeps the image it was created with until it actually STOPS.
 * `restartDesktopStack` does not help: it re-runs the boot script inside the
 * SAME container. So after deploying a new image, anything that verifies
 * container behaviour against a warm session is measuring the PREVIOUS build.
 *
 * That is not hypothetical here. A full production suite has passed 17/17
 * against a container running an older image, and a keyboard fix reported the
 * old behaviour minutes after a successful deploy for exactly this reason.
 *
 * Reporting stale activity marks the session idle so the reaper stops the
 * container; the poll then waits for one that carries the marker.
 *
 * The marker is deliberately a STRING FROM THE CURRENT SOURCE, read at run
 * time out of `worker/assets/neko-branding/www/ezil-mobile.js`, so this cannot
 * drift into checking for something the build no longer contains — the failure
 * mode where the poll passes instantly and proves nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
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
const DEADLINE_MS = Number(process.env.EZIL_FRESH_DEADLINE_MS ?? 30 * 60 * 1000);

/**
 * A distinctive string from the CURRENT client script — the evidence that the
 * container is running this build. Picked from the source rather than
 * hardcoded so it cannot go stale; if the source stops containing any of them,
 * that is an error, not a pass.
 */
function markerFromSource() {
  const src = fs.readFileSync(
    path.resolve(here, '../worker/assets/neko-branding/www/ezil-mobile.js'), 'utf8',
  );
  for (const candidate of ['insertReplacementText', 'client-keyboard', 'stream_vitals', 'guardInput']) {
    if (src.includes(candidate)) return candidate;
  }
  return null;
}

const MARKER = markerFromSource();
if (!MARKER) {
  console.error('could not find a marker in ezil-mobile.js — refusing to poll for nothing. SKIPPING (exit 2).');
  process.exit(2);
}
console.log(`waiting for a container whose client script contains ${JSON.stringify(MARKER)}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sign in, open the desktop, and run `fn` against the streamed client frame. */
async function withDesktop(fn) {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
    const p = await ctx.newPage();
    await p.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
    await p.fill('#email', EMAIL); await p.fill('#password', PASS);
    await Promise.all([
      p.waitForURL((u) => !/\/login/.test(u.toString()), { timeout: 60000 }).catch(() => {}),
      p.locator('form').filter({ has: p.locator('#email') }).locator('button[type=submit]').click(),
    ]);
    if (/\/login/.test(p.url())) throw new Error('sign-in failed');
    await p.goto(`${APP}/os`, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(3000);
    return await fn(p);
  } finally { await browser.close(); }
}

// ── 1. Release: report presence as long past, so the reaper stops it ────────
const released = await withDesktop(async (p) => p.evaluate(async () => {
  const cid = window.__EZIL_BOOT__?.computer?.id;
  if (!cid) return { ok: false, why: 'no computer id on the boot payload' };
  const res = await fetch('/api/shell/activity', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ computerId: cid, lastInputAgoMs: 24 * 60 * 60 * 1000 }),
  });
  const body = await res.text();
  let parsed = null; try { parsed = JSON.parse(body); } catch { /* non-JSON */ }
  // The body, not the status: this family answers HTTP 200 with {ok:false}.
  return { ok: parsed?.ok === true, status: res.status, body: body.slice(0, 160) };
})).catch((e) => ({ ok: false, why: String(e).slice(0, 120) }));

console.log('release:', JSON.stringify(released));
if (!released.ok) { console.error('could not release the desktop; not waiting for something that will not happen.'); process.exit(1); }

// ── 2. Poll until a container carrying the marker is serving ───────────────
const started = Date.now();
let attempt = 0;
for (;;) {
  attempt++;
  const fresh = await withDesktop(async (p) => {
    try { await p.locator('.taskbar-item').filter({ hasText: /browser/i }).first().click({ timeout: 12000 }); }
    catch { await p.locator('.taskbar-item').nth(1).click({ timeout: 12000 }).catch(() => {}); }
    await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe', { timeout: 180000 }).catch(() => {});
    for (let i = 0; i < 30; i++) {
      await p.waitForTimeout(2000);
      const frame = p.frames().find((f) => /nekodesktop/.test(f.url()));
      if (!frame) continue;
      const ready = await frame.evaluate(() => !!document.querySelector('textarea.overlay')).catch(() => false);
      if (!ready) continue;
      return frame.evaluate(async (m) => {
        const r = await fetch('ezil-mobile.js');
        return (await r.text()).includes(m);
      }, MARKER).catch(() => false);
    }
    return false;
  }).catch(() => false);

  if (fresh) {
    console.log(`fresh container serving the current build (after ${attempt} check(s), ${Math.round((Date.now() - started) / 1000)}s)`);
    process.exit(0);
  }
  if (Date.now() - started > DEADLINE_MS) {
    console.error(`no fresh container within ${Math.round(DEADLINE_MS / 60000)} minutes — the deploy may not have rolled.`);
    process.exit(1);
  }
  console.log(`  check ${attempt}: still the previous image; waiting`);
  await sleep(180_000);
}
