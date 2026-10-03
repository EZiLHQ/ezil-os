/**
 * EZiL Chat (OpenCode panel) image e2e — does the SHIPPED desktop image still
 * carry a working EZiL Chat panel next to the bundled Copilot Chat?
 *
 * Since image revision 2 the panel is INSTALLED BUT DORMANT: the secondary
 * sidebar opens on the Chat view (Copilot Chat on EZiL models — proven by
 * e2e/copilot-ezil.mjs), and `ezilChat.autoStart` / `ezilChat.revealOnStartup`
 * are false in the Machine settings. This suite therefore opens the panel the
 * way a user would (click its "EZiL" tab; palette fallback) and proves,
 * in a real Chromium, what is only visible in the rendered workbench:
 *
 *   1. The secondary sidebar is visible by default and the Chat view — not
 *      EZiL Chat — is what it opened on (recorded), i.e. the panel did not
 *      steal the sidebar.
 *   2. After opening it, the "EZiL" container is active and the EZiL Chat
 *      webview mounts (extension baked in as a built-in).
 *   3. (unless EZIL_CHAT_E2E_PROMPT=0) A prompt typed into the panel comes
 *      back rendered as an assistant message, and the per-turn token readout
 *      appears — i.e. webview -> extension host -> `opencode serve` (started
 *      on first open, not at boot) -> provider -> back works on this image.
 *      The runner points OpenCode at `e2e/ezil-chat-mock-provider.mjs`, so no
 *      model credentials are needed and the expected reply is known
 *      (`EZIL_CHAT_E2E_EXPECT_REPLY`).
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules \
 *       EZIL_CODE_URL=http://127.0.0.1:8443 EZIL_CHAT_E2E_FOLDER=/home/neko/project \
 *       EZIL_CHAT_E2E_OUT=./ezil-e2e-out node e2e/ezil-chat.mjs
 *
 * Artifacts in EZIL_CHAT_E2E_OUT: workbench.png (full window), panel.png (the
 * secondary sidebar), after-reply.png, video/*.webm, checks.json.
 *
 * Exit 0 = every check passed. Exit 1 = a real failure. Exit 2 = could not run
 * (same convention as e2e/prod.mjs: a skipped check must never look green).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset (a node_modules with `playwright` and a downloaded chromium)'); process.exit(2); }
const require_ = createRequire(REQ_DIR + '/x.js');
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { console.error('SKIP: playwright unresolvable from ' + REQ_DIR); process.exit(2); }

const CODE_URL = (process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:8443').replace(/\/$/, '');
const FOLDER = process.env.EZIL_CHAT_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_CHAT_E2E_OUT ?? './ezil-e2e-out';
const DO_PROMPT = process.env.EZIL_CHAT_E2E_PROMPT !== '0';
const PROMPT = process.env.EZIL_CHAT_E2E_PROMPT_TEXT ?? 'ping';
const EXPECT = process.env.EZIL_CHAT_E2E_EXPECT_REPLY ?? 'pong';
const T = Number(process.env.EZIL_CHAT_E2E_TIMEOUT_MS ?? 90_000);

mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// code-server must answer before a browser is worth launching.
try {
  const r = await fetch(`${CODE_URL}/healthz`);
  check('code-server answers /healthz', r.ok, `${r.status}`);
} catch (e) {
  console.error(`SKIP: ${CODE_URL} unreachable (${e.message}) — start the container first (e2e/ezil-chat-image.sh)`);
  process.exit(2);
}

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } },
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

try {
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
  const workbench = page.locator('.monaco-workbench');
  await workbench.waitFor({ state: 'visible', timeout: T });
  // The explorer title means the workbench finished its first layout.
  await page.locator('.part.sidebar, .part.auxiliarybar').first().waitFor({ state: 'visible', timeout: T });
  check('workbench renders', true);

  // 1. Secondary sidebar visible, opened on the Chat view; the EZiL panel is
  // dormant until asked for.
  const aux = page.locator('.part.auxiliarybar');
  let auxVisible = false;
  try { await aux.waitFor({ state: 'visible', timeout: T }); auxVisible = true; } catch { /* asserted below */ }
  check('secondary sidebar is visible by default', auxVisible);
  const chatFirst = await aux.locator('.interactive-session, .chat-widget').first().waitFor({ state: 'visible', timeout: 30_000 }).then(() => true).catch(() => false);
  const ezilBeforeOpen = await page.locator('iframe.webview[src*="extensionId=ezil.ezil-chat"]').count();
  check('sidebar opened on the Chat view and the EZiL Chat webview was NOT mounted yet (panel dormant)', chatFirst && ezilBeforeOpen === 0, `chatVisible=${chatFirst} ezilWebviews=${ezilBeforeOpen}`);

  // 2. Open the panel the way a user would: click the "EZiL" tab in the
  // secondary sidebar's composite bar (it appears once the extension host has
  // scanned the built-in), falling back to the palette command.
  const ezilTab = aux.locator('.composite-bar .action-label[aria-label="EZiL"], .composite-bar .action-label[aria-label^="EZiL"]').first();
  let opened = false;
  try {
    await ezilTab.waitFor({ state: 'visible', timeout: T });
    await ezilTab.click({ timeout: 10_000 });
    opened = true;
  } catch { /* fall back below */ }
  if (!opened) {
    await page.keyboard.press('F1');
    const palette = page.locator('.quick-input-widget input.input');
    await palette.waitFor({ state: 'visible', timeout: 10_000 });
    await palette.fill('>EZiL Chat: Open');
    await page.waitForTimeout(700);
    await palette.locator('xpath=ancestor::*[contains(@class,"quick-input-widget")]//*[contains(@class,"monaco-list-row") and contains(., "EZiL Chat: Open")]').first().click({ timeout: 5_000 }).catch(() => page.keyboard.press('Enter'));
  }
  await page.waitForTimeout(1000);
  let auxText = '';
  try {
    await aux.locator('.composite-bar .action-label[aria-label*="EZiL"], .composite-bar .action-label:has-text("EZiL"), .title-label:has-text("EZiL")').first().waitFor({ state: 'visible', timeout: T });
    auxText = (await aux.innerText()).replace(/\s+/g, ' ');
  } catch { auxText = auxVisible ? (await aux.innerText().catch(() => '')).replace(/\s+/g, ' ') : ''; }
  check('opening the EZiL tab reveals the EZiL container', /EZiL/.test(auxText), auxText.slice(0, 120));

  // VS Code does not put webview iframes inside the view's DOM: every outer
  // `iframe.webview` sits in a workbench-level layer, absolutely positioned
  // over its view, and the extension's own document is the nested
  // `#active-frame`. The outer iframe's src carries `extensionId=<id>` and
  // `purpose=webviewView`, which is how ours is told apart.
  const outer = page.locator('iframe.webview[src*="extensionId=ezil.ezil-chat"]');
  let webviewFrame = null;
  try {
    await outer.first().waitFor({ state: 'attached', timeout: T });
    const panel = page.frameLocator('iframe.webview[src*="extensionId=ezil.ezil-chat"]').first().frameLocator('#active-frame');
    await panel.locator('textarea').first().waitFor({ state: 'attached', timeout: T });
    webviewFrame = panel;
  } catch (e) {
    check('EZiL Chat webview is mounted in the secondary sidebar', false, e.message.split('\n')[0]);
  }
  if (webviewFrame) {
    const placeholder = await webviewFrame.locator('textarea').first().getAttribute('placeholder');
    check('EZiL Chat webview is mounted in the secondary sidebar', /Ask EZiL/.test(placeholder ?? ''), `placeholder=${JSON.stringify(placeholder)}`);
  }

  // Both containers coexist: Chat (Copilot Chat on EZiL models) and EZiL.
  const containers = await aux.locator('.composite-bar .action-label').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? '').filter(Boolean));
  check('secondary sidebar carries both the Chat and the EZiL containers', containers.some((c) => /^Chat/.test(c)) && containers.some((c) => /EZiL/.test(c)), JSON.stringify(containers));

  await page.screenshot({ path: join(OUT, 'workbench.png'), fullPage: false });
  if (auxVisible) await aux.screenshot({ path: join(OUT, 'panel.png') });

  // 3. Prompt round trip through OpenCode.
  if (DO_PROMPT && webviewFrame) {
    const textarea = webviewFrame.locator('textarea').first();
    // The composer is disabled until `opencode serve` reports ready — with
    // `ezilChat.autoStart: false` that server was only spawned by the open above.
    let ready = false;
    try { await webviewFrame.locator('textarea:not([disabled])').first().waitFor({ state: 'attached', timeout: T }); ready = true; } catch { /* asserted */ }
    const banner = await webviewFrame.locator('.banner').allInnerTexts().catch(() => []);
    check('opencode server reaches ready (composer enabled)', ready, banner.join(' | ').slice(0, 160));
    if (ready) {
      await textarea.fill(PROMPT);
      await textarea.press('Enter');
      let replied = false;
      try {
        await webviewFrame.locator('.message.assistant .text', { hasText: EXPECT }).first().waitFor({ state: 'visible', timeout: T });
        replied = true;
      } catch { /* asserted */ }
      const errors = await webviewFrame.locator('.message .error, .banner').allInnerTexts().catch(() => []);
      check(`assistant reply containing ${JSON.stringify(EXPECT)} renders in the webview`, replied, errors.join(' | ').slice(0, 200));
      let usage = '';
      try {
        const u = webviewFrame.locator('.usage span', { hasText: 'last turn: in' }).first();
        await u.waitFor({ state: 'visible', timeout: 30_000 });
        usage = await u.innerText();
      } catch { /* asserted */ }
      check('per-turn token readout appears', /last turn: in \d+ · out \d+/.test(usage), usage.slice(0, 120));
      const meta = await webviewFrame.locator('.message.assistant .meta').allInnerTexts().catch(() => []);
      check('assistant message carries model + token meta', meta.some((m) => /in \d+ · out \d+/.test(m)), meta.join(' | ').slice(0, 160));
      await aux.screenshot({ path: join(OUT, 'after-reply.png') }).catch(() => {});
    }
  } else if (DO_PROMPT) {
    check('prompt round trip', false, 'webview not mounted');
  }

  const fatal = consoleErrors.filter((t) => /ezil-chat|EZiL Chat|Cannot read properties of undefined/.test(t));
  check('no workbench console error mentioning ezil-chat / undefined product fields', fatal.length === 0, fatal.slice(0, 2).join(' | '));
} catch (e) {
  check('suite completed without an unexpected exception', false, String(e).slice(0, 300));
} finally {
  await page.screenshot({ path: join(OUT, 'final.png') }).catch(() => {});
  await context.close();
  await browser.close();
}

writeFileSync(join(OUT, 'checks.json'), JSON.stringify({ codeUrl: CODE_URL, folder: FOLDER, results, consoleErrors: consoleErrors.slice(0, 40) }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; artifacts in ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
