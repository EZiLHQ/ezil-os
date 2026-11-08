// Image e2e, pass "early" (copilot-ezil-image.sh): a brand-new browser profile sends its first message as soon as the
// chat input shows. On 1.141 such a profile disabled the built-in chat extension until chat setup completed, and an
// early message waited for Copilot's agent from that disabled extension: "Chat took too long to get ready" after 60 s
// and no answer (patch-copilot-chat.sh `chat-enabled`; reproduced on main and staging images, 2026-11-08). Each view
// is a new browser context, so a new profile: a desktop window by mouse and an Android phone by touch.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/early';
const CONTAINER = process.env.EZIL_E2E_CONTAINER;
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
mkdirSync(OUT, { recursive: true });
const VIEWS = [
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, touch: false, deviceScaleFactor: 1 },
  { name: 'android-412x915', viewport: { width: 412, height: 915 }, touch: true, deviceScaleFactor: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
];
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  early: ${name}${detail ? ` — ${detail}` : ''}`); };
const captured = () => {
  if (!CONTAINER) return [];
  try { return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'cat', `${CAPTURE_DIR}/captured.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return []; }
};
const clean = s => s.replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
try {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.touch, hasTouch: v.touch, deviceScaleFactor: v.deviceScaleFactor, ...v.userAgent ? { userAgent: v.userAgent } : {} });
    const page = await ctx.newPage();
    const aux = page.locator('.part.auxiliarybar');
    const transcript = async () => clean(await aux.locator('.interactive-list').first().innerText().catch(() => ''));
    const prompt = `EZIL_E2E_KIMI: early first message ${v.name}`;
    try {
      const t0 = Date.now();
      await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
      const editor = aux.locator('.chat-input-container .monaco-editor').first();
      await editor.waitFor({ state: 'visible', timeout: 120_000 });
      // Monaco's rendered text is only a hint that the prompt landed (it can lag or carry decorations); what proves the
      // send is the Gateway receiving this exact prompt, checked below. Its text goes into the details either way.
      let typed = false, seen = '';
      for (let attempt = 0; attempt < 3 && !typed; attempt++) {
        const lines = editor.locator('.view-lines').first();
        await (v.touch ? lines.tap({ force: true }) : lines.click({ force: true }));
        await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
        await page.keyboard.type(prompt, { delay: 2 });
        // Monaco's text carries non-breaking spaces and wraps: compare without any whitespace.
        // Monaco paints typed text on a later frame: let the rendering settle before retyping (CI on 6df1871d retyped
        // while its screenshot shows the whole prompt in the input).
        for (let i = 0; i < 15 && !typed; i++) {
          seen = await editor.innerText();
          typed = seen.replace(/[\s\u00a0\u200b]+/g, '').includes(prompt.replace(/\s+/g, ''));
          if (!typed) await page.waitForTimeout(200);
        }
        if (!typed) console.log(`[early] ${v.name}: attempt ${attempt + 1}, the input shows ${JSON.stringify(clean(seen).slice(0, 120))}`);
      }
      await page.keyboard.press('Enter');
      const sentAt = (Date.now() - t0) / 1000;
      let answered = false, tooLong = false, reached = false;
      const tSend = Date.now();
      while (Date.now() - tSend < 75_000 && !answered && !tooLong) {
        const t = await transcript();
        answered = /EZIL_KIMI_OK/.test(t);
        tooLong = /took too long to get ready/i.test(t);
        if (!answered && !tooLong) await page.waitForTimeout(500);
      }
      reached = captured().some(r => r.method === 'POST' && r.path === '/ai/v1/messages' && JSON.stringify(r.body?.messages ?? '').includes(prompt));
      const waited = ((Date.now() - tSend) / 1000).toFixed(1);
      await page.screenshot({ path: join(OUT, `${v.name}.png`) });
      const at = `${v.name}${v.touch ? ' (touch)' : ''}, new profile, sent ${sentAt.toFixed(1)} s after navigation`;
      // Only an early send shows the bug: a send after ~40 s takes the setup path, which worked before the patch too.
      check(`${at}: the message went early (within 15 s of navigation)`, sentAt < 15, `${sentAt.toFixed(1)} s`);
      check(`${at}: no "Chat took too long to get ready"`, !tooLong, `after ${waited} s`);
      check(`${at}: the first message is answered`, answered, `after ${waited} s`);
      check(`${at}: the Gateway received the first message`, reached, typed ? '' : `input showed ${JSON.stringify(clean(seen).slice(0, 120))}`);
    } catch (error) {
      check(`${v.name}: ran to completion`, false, String(error).slice(0, 300));
      await page.screenshot({ path: join(OUT, `${v.name}-error.png`) }).catch(() => {});
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
process.exit(results.every(r => r.ok) ? 0 : 1);
