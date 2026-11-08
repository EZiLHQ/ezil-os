// Image e2e, pass "flash" (copilot-ezil-image.sh, mock Gateway with EZIL_MOCK_FLASH=1): when the Gateway's catalog lists
// Gemini 3.8 Flash as available for this caller with tool calling and names it `default_model`, a fresh profile starts
// on it, and its turn names gemini-3.8-flash with no temperature/top_p (the Gateway refuses them). A model the user
// picks (Qwen3 Coder Next) is what the Gateway receives, and it stays picked after a reload and in a new chat. One
// Android touch view, one desktop mouse view. No real model is called.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/flash';
const CONTAINER = process.env.EZIL_E2E_CONTAINER;
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
mkdirSync(OUT, { recursive: true });
const FLASH = 'gemini-3.8-flash', FLASH_NAME = 'Gemini 3.8 Flash';
const QWEN = 'qwen.qwen3-coder-next', QWEN_NAME = 'Qwen3 Coder Next';
const VIEWS = [
  { name: 'android-412x915', viewport: { width: 412, height: 915 }, touch: true, deviceScaleFactor: 2.625,
    userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36' },
  { name: 'desktop-1440x900', viewport: { width: 1440, height: 900 }, touch: false, deviceScaleFactor: 1 },
];

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  flash: ${name}${detail ? ` — ${detail}` : ''}`); };
const rowsSel = '.action-widget .monaco-list-row, .context-view .monaco-list-row';
const messages = () => {
  try { return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'cat', `${CAPTURE_DIR}/captured.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).filter(r => r.method === 'POST' && r.path === '/ai/v1/messages'); } catch { return []; }
};

const browser = await chromium.launch();
try {
  if (!CONTAINER) throw new Error('EZIL_E2E_CONTAINER is required');
  for (const v of VIEWS) {
    const ctx = await browser.newContext({ viewport: v.viewport, isMobile: v.touch, hasTouch: v.touch, deviceScaleFactor: v.deviceScaleFactor, ...v.userAgent ? { userAgent: v.userAgent } : {} });
    const page = await ctx.newPage();
    const press = (locator) => v.touch ? locator.tap() : locator.click();
    const model = page.locator('.part.auxiliarybar .action-label[aria-label^="Models, "]').first();
    const label = async () => (await model.getAttribute('aria-label')) ?? '';
    const ready = async (name) => {
      await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 90_000 });
      await model.waitFor({ state: 'visible', timeout: 60_000 });
      for (let i = 0; i < 60 && !(await label()).includes(name); i++) await page.waitForTimeout(1000);
      await page.waitForTimeout(1500);
    };
    const lines = page.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first();
    // The turn is the request that carries the Agent tools; a chat title is a utility request on Qwen.
    const sendTurn = async (prompt) => {
      const before = messages().length;
      await (v.touch ? lines.tap({ force: true }) : lines.click({ force: true }));
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
      await page.keyboard.type(prompt, { delay: 3 });
      await page.keyboard.press('Enter');
      for (let i = 0; i < 60 && !messages().slice(before).some(r => r.body?.tools?.length); i++) await page.waitForTimeout(500);
      await page.waitForTimeout(1500);
      return messages().slice(before).filter(r => r.body?.tools?.length && JSON.stringify(r.body.messages).includes(prompt));
    };
    const at = `${v.name}${v.touch ? ' (touch)' : ''}`;
    try {
      await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
      await ready(FLASH_NAME);
      await page.screenshot({ path: join(OUT, `${v.name}-fresh.png`) });
      check(`${at}: a fresh profile starts on the Gateway's suggested ${FLASH_NAME}`, (await label()) === `Models, ${FLASH_NAME}`, await label());
      let turns = await sendTurn(`EZIL_E2E_KIMI ${v.name} flash`);
      check(`${at}: the turn names ${FLASH} and carries no temperature/top_p`, turns.length > 0 && turns.every(r => r.body.model === FLASH && !('temperature' in r.body) && !('top_p' in r.body)),
        JSON.stringify(turns.map(r => [r.body.model, r.body.temperature, r.body.top_p])));

      await press(model);
      await page.waitForTimeout(1200);
      let qwen = page.locator(rowsSel).filter({ hasText: /Qwen3 Coder Next/ }).first();
      if (!(await qwen.count())) {
        const other = page.locator(rowsSel).filter({ hasText: /^\s*Other Models/ }).first();
        if (await other.count()) { await press(other); await page.waitForTimeout(800); }
        qwen = page.locator(rowsSel).filter({ hasText: /Qwen3 Coder Next/ }).first();
      }
      if (await qwen.count()) { await press(qwen); await page.waitForTimeout(1500); }
      check(`${at}: the user picks ${QWEN_NAME}`, (await label()) === `Models, ${QWEN_NAME}`, await label());
      for (let i = 0; i < 2; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

      await page.waitForTimeout(4000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(QWEN_NAME);
      await (v.touch ? lines.tap({ force: true }) : lines.click({ force: true }));
      await page.keyboard.press('Control+L');
      await page.waitForTimeout(2500);
      const shown = await page.locator('.part.auxiliarybar .interactive-item-container').count();
      check(`${at}: after a reload, a new chat keeps the picked ${QWEN_NAME}, not the suggested default`, shown === 0 && (await label()) === `Models, ${QWEN_NAME}`, `${await label()}; turns shown ${shown}`);
      turns = await sendTurn(`EZIL_E2E_KIMI ${v.name} picked`);
      check(`${at}: that chat's turn goes to ${QWEN}`, turns.length > 0 && turns.every(r => r.body.model === QWEN), JSON.stringify(turns.map(r => r.body.model)));
      await page.screenshot({ path: join(OUT, `${v.name}-picked.png`) });
    } catch (e) {
      check(`${v.name}: completed`, false, String(e).slice(0, 300));
      await page.screenshot({ path: join(OUT, `${v.name}-error.png`) }).catch(() => {});
    } finally { await ctx.close(); }
  }
} catch (e) {
  check('completed', false, String(e).slice(0, 300));
} finally { await browser.close(); }
writeFileSync(join(OUT, 'checks.json'), JSON.stringify(results, null, 1));
process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
