// Image e2e, pass "phone" (copilot-ezil-image.sh): on a phone, Explorer and Chat sit side by side and leave the chat
// header about 160 px, so its pickers cannot all keep their labels. The model picker must keep its name, ellipsized
// if need be (patch-copilot-chat.sh `picker-order`), and be usable by touch (`picker-touch`, `title-tap`): real taps
// (touch events, not mouse clicks: a mouse click in a touch context never showed that a tap did nothing) open it, it
// stays open, and a tapped Kimi K3 is the model the Gateway receives for the turn. The pick survives a reload and a
// new chat (no configured chat.defaultModel), and a fresh profile starts on the declared default, Qwen3 Coder Next.
// Chromium with an Android and with an iPhone user agent: the workbench takes its iOS path (pointerdown) only for the
// latter, so the iPhone view shows that a tap opens a picker once; real Safari is not run here. A desktop window keeps
// every label and works by mouse.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/phone';
const CONTAINER = process.env.EZIL_E2E_CONTAINER;
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
mkdirSync(OUT, { recursive: true });
const MODEL_NAME = 'Qwen3 Coder Next';
const KIMI_NAME = 'Kimi K3 (no streaming)';
const KIMI = 'us.moonshotai.kimi-k3';
const VIEWS = [
  { name: 'android-412x915', viewport: { width: 412, height: 915 }, touch: true, deviceScaleFactor: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
  { name: 'iphone-390x844', viewport: { width: 390, height: 844 }, touch: true, deviceScaleFactor: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, touch: false, deviceScaleFactor: 1 },
];

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  phone: ${name}${detail ? ` — ${detail}` : ''}`); };
const rowsSel = '.action-widget .monaco-list-row, .context-view .monaco-list-row';
const captured = () => {
  if (!CONTAINER) return [];
  try { return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'cat', `${CAPTURE_DIR}/captured.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return []; }
};
const messages = () => captured().filter(r => r.method === 'POST' && r.path === '/ai/v1/messages');

const browser = await chromium.launch();
try {
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.touch, hasTouch: v.touch, deviceScaleFactor: v.deviceScaleFactor, ...v.userAgent ? { userAgent: v.userAgent } : {} });
    const page = await ctx.newPage();
    const press = (locator) => v.touch ? locator.tap() : locator.click();
    const model = page.locator('.part.auxiliarybar .action-label[aria-label^="Models, "]').first();
    const modelLabel = async () => (await model.getAttribute('aria-label')) ?? '';
    // Boot shows "Auto" until ezil-models activates and its first Gateway read returns.
    const ready = async (name) => {
      await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 90_000 });
      await model.waitFor({ state: 'visible', timeout: 60_000 });
      for (let i = 0; i < 60 && !/Qwen3 Coder Next|Kimi K3/.test(await modelLabel()); i++) await page.waitForTimeout(1000);
      if (name) for (let i = 0; i < 15 && !(await modelLabel()).includes(name); i++) await page.waitForTimeout(1000);
      await page.waitForTimeout(1500);
    };
    // Type only once the chat input really has focus, then wait for the Gateway request it causes.
    const send = async (prompt) => {
      const before = messages().length;
      const lines = page.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first();
      for (let attempt = 0; attempt < 3; attempt++) {
        await (v.touch ? lines.tap({ force: true }) : lines.click({ force: true }));
        await page.waitForTimeout(300);
        await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
        await page.keyboard.type(prompt, { delay: 3 });
        await page.waitForTimeout(250);
        // A phone's composer wraps inside words: compare without whitespace.
        const text = await page.locator('.part.auxiliarybar .chat-input-container .monaco-editor').first().innerText();
        if (text.replace(/\s+/g, '') === prompt.replace(/\s+/g, '')) { await page.keyboard.press('Enter'); break; }
        for (let i = 0; i < 2; i++) await page.keyboard.press('Escape');
      }
      for (let i = 0; i < 60 && messages().length === before; i++) await page.waitForTimeout(500);
      await page.waitForTimeout(1500);
      return messages().slice(before).filter(r => JSON.stringify(r.body?.messages ?? '').includes(prompt));
    };
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
    try {
      await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
      await ready(MODEL_NAME);
      const before = await read();
      await page.screenshot({ path: join(OUT, `${v.name}.png`) });
      const at = `${v.name} (chat ${before.chatWidth} px${v.touch ? ', touch' : ''})`;
      check(`${at}: a fresh profile starts on the declared default, ${MODEL_NAME}`, before.aria === `Models, ${MODEL_NAME}`, before.aria);
      check(`${at}: the model picker shows its name, not only an icon`, !before.compact && before.text === MODEL_NAME && before.labelWidth >= 40, JSON.stringify(before));
      check(`${at}: the mode picker keeps an accessible name`, Boolean(before.mode?.aria), JSON.stringify(before.mode));
      if (!v.touch) check(`${at}: a desktop chat keeps every label (the mode picker is not compacted)`, before.mode && !before.mode.compact, JSON.stringify(before.mode));

      // The mode picker sits in the same header: a tap opens it and it stays open.
      const modeLabel = page.locator('.part.auxiliarybar .chat-input-toolbar .action-item.chat-input-picker-item:not(.model-picker-item) .action-label').first();
      if (await modeLabel.count()) { await press(modeLabel); await page.waitForTimeout(1200); }
      check(`${at}: the mode picker opens and stays open`, (await modeLabel.count()) > 0 && (await page.locator(rowsSel).count()) > 0);
      for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

      await press(model);
      await page.waitForTimeout(1200);
      check(`${at}: the model picker opens and stays open`, (await page.locator(rowsSel).count()) > 0);
      let kimi = page.locator(rowsSel).filter({ hasText: /Kimi K3/ }).first();
      if (!(await kimi.count())) {
        const other = page.locator(rowsSel).filter({ hasText: /^\s*Other Models/ }).first();
        if (await other.count()) { await press(other); await page.waitForTimeout(800); }
        kimi = page.locator(rowsSel).filter({ hasText: /Kimi K3/ }).first();
      }
      check(`${at}: the picker lists Kimi K3`, (await kimi.count()) === 1);
      if (await kimi.count()) { await press(kimi); await page.waitForTimeout(1500); }
      const after = await read();
      await page.screenshot({ path: join(OUT, `${v.name}-kimi.png`) });
      check(`${at}: switching shows the new model's name`, !after.compact && after.text === KIMI_NAME && after.aria === `Models, ${KIMI_NAME}`, JSON.stringify(after));
      for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

      // The turn itself is the request that carries the Agent tools; a chat title is a utility request on Qwen.
      const turnModels = (sent) => sent.filter(r => Array.isArray(r.body?.tools) && r.body.tools.length).map(r => [r.body.model, r.body.stream === true]);
      if (CONTAINER) {
        const turns = turnModels(await send(`EZIL_E2E_KIMI ${v.name} picked`));
        check(`${at}: the Gateway receives the picked model for the turn (${KIMI}, not streamed)`, turns.length > 0 && turns.every(([m, stream]) => m === KIMI && !stream), JSON.stringify(turns));
      }
      // The workbench writes the remembered model to browser storage on a short delay; then reload.
      await page.waitForTimeout(4000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(KIMI_NAME);
      check(`${at}: after a reload the picked model is still selected`, (await modelLabel()) === `Models, ${KIMI_NAME}`, await modelLabel());
      await page.screenshot({ path: join(OUT, `${v.name}-reloaded.png`) });
      // A new, empty chat is where a configured chat.defaultModel used to win over the remembered pick.
      // On a phone the title's New Chat action is in its overflow menu: use New Chat's keybinding from the input.
      const newChat = page.locator('.part.auxiliarybar .action-label[aria-label^="New Chat"]').first();
      if (await newChat.isVisible().catch(() => false)) await press(newChat);
      else {
        const lines = page.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first();
        await (v.touch ? lines.tap({ force: true }) : lines.click({ force: true }));
        await page.keyboard.press('Control+L');
      }
      await page.waitForTimeout(2000);
      const turnsShown = await page.locator('.part.auxiliarybar .interactive-item-container').count();
      check(`${at}: a new chat after the reload keeps the picked model`, turnsShown === 0 && (await modelLabel()) === `Models, ${KIMI_NAME}`, `${await modelLabel()}; turns shown ${turnsShown}`);
      if (CONTAINER) {
        const turns = turnModels(await send(`EZIL_E2E_KIMI ${v.name} new chat`));
        check(`${at}: the new chat's turn goes to ${KIMI}`, turns.length > 0 && turns.every(([m]) => m === KIMI), JSON.stringify(turns));
      }
    } catch (e) {
      check(`${v.name}: completed`, false, String(e).slice(0, 300));
      await page.screenshot({ path: join(OUT, `${v.name}-error.png`) }).catch(() => {});
    } finally { await ctx.close(); }
  }
} finally { await browser.close(); }
if (!CONTAINER) check('Gateway requests were checked (EZIL_E2E_CONTAINER set)', false);
writeFileSync(join(OUT, 'checks.json'), JSON.stringify(results, null, 1));
process.exit(results.every((r) => r.ok) ? 0 : 1);
