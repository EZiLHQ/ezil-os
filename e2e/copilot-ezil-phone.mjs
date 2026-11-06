// Image e2e, pass "phone" (copilot-ezil-image.sh): on a phone, Explorer and Chat sit side by side and leave the chat
// header about 160 px, so its pickers cannot all keep their labels. The model picker must keep its name, ellipsized
// if need be (patch-copilot-chat.sh `picker-order`), and stay usable: it opens, lists the models and switches to Kimi
// K3. A desktop window keeps every label. No prompt is sent.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/phone';
mkdirSync(OUT, { recursive: true });
const MODEL_NAME = 'Qwen3 Coder Next';
const KIMI_NAME = 'Kimi K3 (no streaming)';
const VIEWS = [
  { name: 'phone-390x844', viewport: { width: 390, height: 844 }, phone: true },
  { name: 'phone-412x915', viewport: { width: 412, height: 915 }, phone: true },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, phone: false },
];

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  phone: ${name}${detail ? ` — ${detail}` : ''}`); };
const rowsSel = '.action-widget .monaco-list-row, .context-view .monaco-list-row';

const browser = await chromium.launch();
try {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.phone, hasTouch: v.phone, deviceScaleFactor: v.phone ? 2 : 1 });
    const page = await ctx.newPage();
    try {
      await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
      await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 90_000 });
      const model = page.locator('.part.auxiliarybar .action-label[aria-label^="Models, "]').first();
      await model.waitFor({ state: 'visible', timeout: 60_000 });
      // Boot shows "Auto" until ezil-models activates and its first Gateway read returns.
      for (let i = 0; i < 60 && !((await model.getAttribute('aria-label')) ?? '').includes(MODEL_NAME); i++) await page.waitForTimeout(1000);
      await page.waitForTimeout(1500);
      const read = () => page.evaluate(() => {
        const m = document.querySelector('.part.auxiliarybar .action-label[aria-label^="Models, "]');
        const item = m?.closest('.action-item');
        const label = m?.querySelector('.chat-input-picker-label');
        const mode = [...document.querySelectorAll('.part.auxiliarybar .chat-input-toolbar .action-item')].find((it) => it !== item && /picker/.test(it.className));
        const b = m?.getBoundingClientRect();
        return {
          aria: m?.getAttribute('aria-label') ?? '', text: (label?.textContent ?? '').trim(), labelWidth: label ? Math.round(label.getBoundingClientRect().width) : 0,
          width: b ? Math.round(b.width) : 0, compact: Boolean(item?.classList.contains('compact-picker')),
          chatWidth: Math.round(document.querySelector('.part.auxiliarybar')?.getBoundingClientRect().width ?? 0),
          mode: mode ? { aria: mode.querySelector('.action-label')?.getAttribute('aria-label') ?? '', compact: mode.classList.contains('compact-picker') } : null,
        };
      });
      const before = await read();
      await page.screenshot({ path: join(OUT, `${v.name}.png`) });
      const at = `${v.name} (chat ${before.chatWidth} px)`;
      check(`${at}: the model picker shows its name, not only an icon`, !before.compact && before.text === MODEL_NAME && before.labelWidth >= 40, JSON.stringify(before));
      check(`${at}: its accessible name is the full model name`, before.aria === `Models, ${MODEL_NAME}`, before.aria);
      check(`${at}: the mode picker keeps an accessible name`, Boolean(before.mode?.aria), JSON.stringify(before.mode));
      if (!v.phone) check(`${at}: a desktop chat keeps every label (the mode picker is not compacted)`, before.mode && !before.mode.compact, JSON.stringify(before.mode));
      await model.click();
      await page.waitForTimeout(1200);
      let kimi = page.locator(rowsSel).filter({ hasText: /Kimi K3/ }).first();
      if (!(await kimi.count())) {
        const other = page.locator(rowsSel).filter({ hasText: /^\s*Other Models/ }).first();
        if (await other.count()) { await other.click(); await page.waitForTimeout(800); }
        kimi = page.locator(rowsSel).filter({ hasText: /Kimi K3/ }).first();
      }
      check(`${at}: the picker opens and lists Kimi K3`, (await kimi.count()) === 1);
      if (await kimi.count()) { await kimi.click(); await page.waitForTimeout(1500); }
      const after = await read();
      await page.screenshot({ path: join(OUT, `${v.name}-kimi.png`) });
      check(`${at}: switching shows the new model's name`, !after.compact && after.text === KIMI_NAME && after.aria === `Models, ${KIMI_NAME}`, JSON.stringify(after));
      for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }
    } catch (e) {
      check(`${v.name}: completed`, false, String(e).slice(0, 300));
      await page.screenshot({ path: join(OUT, `${v.name}-error.png`) }).catch(() => {});
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
writeFileSync(join(OUT, 'checks.json'), JSON.stringify(results, null, 1));
process.exit(results.every((r) => r.ok) ? 0 : 1);
