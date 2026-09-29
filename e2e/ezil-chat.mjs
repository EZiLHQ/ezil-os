/**
 * EZiL Chat image e2e — does the SHIPPED desktop image put EZiL Chat, and
 * nothing Copilot, in front of a user?
 *
 * Runs against a code-server that `e2e/ezil-chat-image.sh` has already
 * started from the image (or any code-server URL you point it at). It drives
 * a real Chromium, because the three things it proves are only visible in the
 * rendered workbench, not in any file in the image:
 *
 *   1. The secondary sidebar opens by itself and holds the "EZiL" container
 *      with the EZiL Chat webview (extension baked in as a built-in, Machine
 *      settings `workbench.secondarySideBar.defaultVisibility: visible`).
 *   2. Nothing Copilot: no element whose aria-label/title mentions Copilot,
 *      no "Chat" command-center button in the title bar, no built-in chat
 *      view (`chat.disableAIFeatures` + the deleted `copilot` built-in +
 *      the stripped `product.json#defaultChatAgent`).
 *   3. (unless EZIL_CHAT_E2E_PROMPT=0) A prompt typed into the panel comes
 *      back rendered as an assistant message, and the per-turn token readout
 *      appears — i.e. webview -> extension host -> `opencode serve` ->
 *      provider -> back works on this image. The runner points OpenCode at
 *      `e2e/ezil-chat-mock-provider.mjs`, so no model credentials are needed
 *      and the expected reply is known (`EZIL_CHAT_E2E_EXPECT_REPLY`).
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

  // 1. Secondary sidebar with the EZiL container and the EZiL Chat webview.
  const aux = page.locator('.part.auxiliarybar');
  let auxVisible = false;
  try { await aux.waitFor({ state: 'visible', timeout: T }); auxVisible = true; } catch { /* asserted below */ }
  check('secondary sidebar is visible by default', auxVisible);
  // The container label appears once the extension host has scanned the
  // built-in, a moment after the (possibly empty) bar itself is laid out.
  let auxText = '';
  try {
    await aux.locator('.composite-bar .action-label[aria-label*="EZiL"], .composite-bar .action-label:has-text("EZiL"), .title-label:has-text("EZiL")').first().waitFor({ state: 'visible', timeout: T });
    auxText = (await aux.innerText()).replace(/\s+/g, ' ');
  } catch { auxText = auxVisible ? (await aux.innerText().catch(() => '')).replace(/\s+/g, ' ') : ''; }
  check('secondary sidebar shows the EZiL container', /EZiL/.test(auxText), auxText.slice(0, 120));

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

  // 2. Nothing Copilot.
  const copilotHits = await page.locator('[aria-label*="Copilot" i], [title*="Copilot" i]').count();
  check('no element with aria-label/title mentioning Copilot', copilotHits === 0, `hits=${copilotHits}`);
  const chatButton = await page.locator('.part.titlebar .command-center [aria-label*="Chat" i], .part.titlebar .action-item[aria-label*="Chat" i], .part.titlebar [aria-label*="Copilot" i]').count();
  check('no Chat/Copilot button in the title bar command center', chatButton === 0, `hits=${chatButton}`);
  const builtinChatView = await page.locator('[id="workbench.panel.chat"], [id="workbench.view.chat"], .chat-viewpane, .interactive-session').count();
  check('no built-in chat view in the DOM', builtinChatView === 0, `hits=${builtinChatView}`);
  // A user-visible reference anywhere would also count.
  const bodyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('no visible "Copilot" text anywhere in the workbench', !/copilot/i.test(bodyText));

  await page.screenshot({ path: join(OUT, 'workbench.png'), fullPage: false });
  if (auxVisible) await aux.screenshot({ path: join(OUT, 'panel.png') });

  // 3. Prompt round trip through OpenCode.
  if (DO_PROMPT && webviewFrame) {
    const textarea = webviewFrame.locator('textarea').first();
    // The composer is disabled until `opencode serve` reports ready.
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

  const fatal = consoleErrors.filter((t) => /defaultChatAgent|Cannot read properties of undefined/.test(t));
  check('no workbench console error mentioning defaultChatAgent / undefined product fields', fatal.length === 0, fatal.slice(0, 2).join(' | '));
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
