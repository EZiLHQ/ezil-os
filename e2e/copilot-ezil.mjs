/**
 * Copilot Chat on EZiL models — image e2e (browser half).
 *
 * Does the SHIPPED desktop image put the bundled open-source Copilot Chat in
 * front of a user, running on an EZiL-configured model, with NO GitHub
 * sign-in, on a COMPLETELY FRESH browser context? Runs against a code-server
 * that `e2e/copilot-ezil-image.sh` has already started from the image. A real
 * Chromium is driven because everything it proves is only visible in the
 * rendered workbench:
 *
 *   1. The secondary sidebar opens by itself and its ACTIVE view is the Chat
 *      view (Copilot Chat), not the EZiL Chat (OpenCode) webview, which is
 *      installed but dormant (`ezilChat.revealOnStartup: false`).
 *   2. Cold-start activation: on a fresh browser profile the core disables
 *      copilot-chat until "chat setup" completes (REPORT.md caveat 1). With
 *      `chat.allowAnonymousAccess: true` in the Machine settings, the very
 *      first prompt must work — no "Sign in to use GitHub Copilot" dialog,
 *      no "Sign in" row in the model picker.
 *   3. Agent mode round trip: "create hello.txt containing hi" reaches the
 *      mock (`e2e/copilot-ezil-mock-provider.mjs`, inside the container, via
 *      the built-in ezil-models provider) WITH Copilot's system prompt and
 *      tool definitions (incl. `create_file`); the mock answers with a
 *      `create_file` tool call; VS Code runs it, the file appears in the
 *      workspace, the tool result goes back to the model, the final text is
 *      rendered.
 *   4. The Language Models editor ("Chat: Manage Language Models") lists the
 *      EZiL vendor and the configured model.
 *   5. Informational: what the mode picker offers (anonymous mode forces
 *      Agent; Plan is expected to be absent — recorded, not asserted).
 *   6. Revision 3 — "EZiL Chat", no GitHub: the chat welcome shows "AI
 *      responses may be inaccurate. Review changes before applying them."
 *      (no Terms / Privacy links); no visible "Copilot" / "GitHub" text
 *      anywhere in the workbench after boot and after the prompt (text
 *      nodes only — ids and class names are not user-visible); the
 *      status-bar item is "EZiL Chat status" and its hover is unbranded; the
 *      Accounts menu has no "Sign in to use GitHub Copilot…" row; the
 *      session-target picker offers no Copilot / Cloud row; the captured
 *      system prompt says "You are EZiL Chat, an AI coding assistant" and no
 *      request mentions GitHub Copilot; every browser-side request that is
 *      not for code-server is aborted and none of them named a GitHub /
 *      githubusercontent / githubcopilot / Microsoft-telemetry / exp-tas /
 *      applicationinsights / vscode-cdn host. (The container side of the same
 *      assertion — DNS sink + in-container listener — lives in
 *      e2e/copilot-ezil-image.sh.)
 *
 * Container-side facts (hello.txt, the mock's capture file) are read through
 * EZIL_E2E_EXEC, a command prefix such as `docker exec <name>`.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/path/to/node_modules \
 *       EZIL_CODE_URL=http://127.0.0.1:8443 EZIL_E2E_FOLDER=/home/neko/project \
 *       EZIL_E2E_EXEC="docker exec <container>" EZIL_E2E_OUT=./out node e2e/copilot-ezil.mjs
 *
 * Artifacts in EZIL_E2E_OUT: workbench.png, chat-panel.png, mode-picker.png,
 * prompt-in-flight.png, after-agent.png, manage-models.png, final.png,
 * video/*.webm, checks.json (every check + captured request summary).
 *
 * Exit 0 = every check passed. Exit 1 = a real failure. Exit 2 = could not run
 * (same convention as e2e/prod.mjs: a skipped check must never look green).
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset (a node_modules with `playwright` and a downloaded chromium)'); process.exit(2); }
const require_ = createRequire(REQ_DIR + '/x.js');
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { console.error('SKIP: playwright unresolvable from ' + REQ_DIR); process.exit(2); }

const CODE_URL = (process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:8443').replace(/\/$/, '');
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out';
const EXEC = process.env.EZIL_E2E_EXEC ?? '';
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const MODEL_NAME = process.env.EZIL_E2E_MODEL_NAME ?? 'EZiL e2e mock';
const API_KEY = process.env.EZIL_E2E_API_KEY ?? 'e2e-key';
const PROMPT = process.env.EZIL_E2E_PROMPT_TEXT ?? 'create hello.txt containing hi';
const T = Number(process.env.EZIL_E2E_TIMEOUT_MS ?? 120_000);

mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const info = (name, detail) => { results.push({ name, ok: true, info: true, detail }); console.log(`INFO  ${name}  — ${detail}`); };

// Container-side reads. No `$` in these commands: they go through `bash -c "…"`.
const sh = (command) => {
  if (!EXEC) throw new Error('EZIL_E2E_EXEC unset');
  return execSync(`${EXEC} bash -c ${JSON.stringify(command)}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};
const trySh = (command) => { try { return sh(command); } catch (e) { return `<exec failed: ${String(e.message).split('\n')[0]}>`; } };
const clean = (s) => s.replace(/\s+/g, ' ').trim();

try {
  const r = await fetch(`${CODE_URL}/healthz`);
  check('code-server answers /healthz', r.ok, `${r.status}`);
} catch (e) {
  console.error(`SKIP: ${CODE_URL} unreachable (${e.message}) — start the container first (e2e/copilot-ezil-image.sh)`);
  process.exit(2);
}

// A brand-new context = a cold browser profile: no IndexedDB, no storage
// state, so the `ensureChatExtensionInitialDisabledState` path runs.
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: join(OUT, 'video'), size: { width: 1440, height: 900 } },
});
// Revision 3: every browser-side request that is not for code-server itself is
// logged and ABORTED — the assertion at the end is "none of them named a
// GitHub / githubusercontent / githubcopilot / Microsoft-telemetry / exp-tas /
// applicationinsights / vscode-cdn host" (open-vsx.org, code-server's gallery,
// is allowed and merely recorded).
const BLOCKED_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|githubcopilot\.com|exp-tas\.com|events\.data\.microsoft\.com|visualstudio\.com|applicationinsights\.azure\.com|vscode-cdn\.net)$/i;
const codeHost = new URL(CODE_URL).host;
const foreignRequests = [];
await context.route('**/*', (route) => {
  const u = new URL(route.request().url());
  if (u.host === codeHost) return route.continue();
  foreignRequests.push({ host: u.hostname, url: route.request().url().slice(0, 160), method: route.request().method() });
  return route.abort();
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 240)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 240)));

const aux = page.locator('.part.auxiliarybar');
const pickerRows = async () => {
  const rows = page.locator('.context-view .monaco-list-row, .quick-input-widget .monaco-list-row, .action-widget .monaco-list-row, .monaco-menu .action-item, .context-view .action-item');
  return (await rows.allInnerTexts()).map(clean).filter(Boolean);
};
const dialogTexts = async () => {
  const d = page.locator('.monaco-dialog-box');
  const n = await d.count(); const out = [];
  for (let i = 0; i < n; i++) out.push(clean(await d.nth(i).innerText().catch(() => '')));
  return out.filter(Boolean);
};
// Visible text nodes anywhere in the workbench that say Copilot or GitHub —
// TEXT only (ids, class names and aria attributes are not user-visible and are
// left alone), hidden elements ignored.
const visibleBranding = async () => page.evaluate(() => {
  const res = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent || '';
    if (!/copilot|github/i.test(t)) continue;
    const el = n.parentElement;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || st.visibility === 'hidden' || st.display === 'none') continue;
    let e = el; const path = [];
    for (let i = 0; e && i < 4; i++, e = e.parentElement) path.push(e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
    res.push({ text: t.trim().slice(0, 120), path: path.join(' < ') });
  }
  return res;
});
const transcript = async () => clean(await aux.locator('.interactive-list .monaco-list-rows, .chat-widget .interactive-list').first().innerText().catch(() => ''));
const busy = async () => (await aux.locator('.chat-input-container [aria-label*="Cancel" i], .chat-input-container [aria-label*="Stop" i], .chat-input-container .codicon-stop-circle').count()) > 0;
const runCommand = async (label) => {
  await page.keyboard.press('F1');
  const input = page.locator('.quick-input-widget input.input');
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.fill('>' + label);
  await page.waitForTimeout(700);
  await page.keyboard.press('Enter');
};
let capturedRequests = [];

try {
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: T });
  await page.locator('.part.sidebar, .part.auxiliarybar').first().waitFor({ state: 'visible', timeout: T });
  check('workbench renders', true);

  // 1. Secondary sidebar visible, Chat view active, EZiL (OpenCode) container dormant.
  let auxVisible = false;
  try { await aux.waitFor({ state: 'visible', timeout: T }); auxVisible = true; } catch { /* asserted */ }
  check('secondary sidebar is visible by default', auxVisible);
  const chatWidget = aux.locator('.interactive-session, .chat-widget').first();
  let chatVisible = false;
  try { await chatWidget.waitFor({ state: 'visible', timeout: T }); chatVisible = true; } catch { /* asserted */ }
  const auxTitle = clean(await aux.locator('.composite.title, .title-label').first().innerText().catch(() => ''));
  check('Chat view (Copilot Chat) is the active view of the secondary sidebar', chatVisible, `title=${JSON.stringify(auxTitle)}`);
  const ezilWebviews = await page.locator('iframe.webview[src*="extensionId=ezil.ezil-chat"]').count();
  const containers = await aux.locator('.composite-bar .action-label').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent ?? '').filter(Boolean));
  check('EZiL Chat (OpenCode) container is NOT the active view — no ezil.ezil-chat webview mounted', ezilWebviews === 0, `webviews=${ezilWebviews} containers=${JSON.stringify(containers)}`);
  info('secondary sidebar containers', JSON.stringify(containers));

  // 2. Cold-start: the model picker must never offer "Sign in"; give the
  // extension host time to activate copilot-chat and ezil-models.
  const inputContainer = aux.locator('.chat-input-container').first();
  await inputContainer.waitFor({ state: 'visible', timeout: T }).catch(() => {});
  let toolbar = '';
  for (let i = 0; i < 40; i++) {
    toolbar = clean(await inputContainer.innerText().catch(() => ''));
    if (toolbar && !/sign in/i.test(toolbar) && /Agent|Auto|Manage|Model|Pick/i.test(toolbar)) break;
    await page.waitForTimeout(750);
  }
  check('model picker does not say "Sign in to use Copilot"', toolbar !== '' && !/sign in/i.test(toolbar), `toolbar=${JSON.stringify(toolbar.slice(0, 160))}`);
  await page.screenshot({ path: join(OUT, 'workbench.png') });
  if (auxVisible) await aux.screenshot({ path: join(OUT, 'chat-panel.png') }).catch(() => {});

  // 6 (revision 3). EZiL Chat branding on the boot path.
  await page.waitForTimeout(1500);
  const NOTICE = 'AI responses may be inaccurate. Review changes before applying them.';
  const disclaimer = aux.locator('.chat-welcome-view-disclaimer').first();
  const disclaimerText = clean(await disclaimer.innerText().catch(() => ''));
  const disclaimerVisible = await disclaimer.isVisible().catch(() => false);
  check('chat welcome shows the EZiL notice (no GitHub Terms / Privacy Statement)', disclaimerVisible && disclaimerText.includes(NOTICE) && !/terms|privacy|github|copilot/i.test(disclaimerText), `visible=${disclaimerVisible} text=${JSON.stringify(disclaimerText.slice(0, 120))}`);
  await aux.screenshot({ path: join(OUT, 'welcome.png') }).catch(() => {});
  const brandingBoot = await visibleBranding();
  check('no visible "Copilot" / "GitHub" text anywhere in the workbench after boot', brandingBoot.length === 0, JSON.stringify(brandingBoot.slice(0, 4)));
  const statusEntry = page.locator('.statusbar-item[id="chat.statusBarEntry"] a, .statusbar-item[id="chat.statusBarEntry"]').first();
  const statusAria = await statusEntry.getAttribute('aria-label').catch(() => null);
  check('status-bar chat item is labelled "EZiL Chat status"', statusAria === 'EZiL Chat status', `aria-label=${JSON.stringify(statusAria)}`);
  if (await statusEntry.count()) {
    await statusEntry.hover().catch(() => {}); await page.waitForTimeout(1500);
    const hover = clean(await page.locator('.workbench-hover, .monaco-hover').first().innerText().catch(() => ''));
    check('status-bar hover carries no Copilot / GitHub text', hover !== '' && !/copilot|github/i.test(hover), hover.slice(0, 160));
    await page.screenshot({ path: join(OUT, 'status-hover.png') });
    await page.mouse.move(700, 300); await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  }
  const accounts = page.locator('.part.activitybar .action-item[aria-label*="Accounts" i]').first();
  if (await accounts.count()) {
    await accounts.click().catch(() => {}); await page.waitForTimeout(1000);
    const rows = await pickerRows();
    check('Accounts menu has no "Sign in to use GitHub Copilot…" entry', rows.length > 0 && !rows.some((r) => /copilot|github|sign in to use/i.test(r)), JSON.stringify(rows.slice(0, 6)));
    await page.screenshot({ path: join(OUT, 'accounts-menu.png') });
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  } else {
    check('Accounts menu has no "Sign in to use GitHub Copilot…" entry', false, 'Accounts activity-bar item not found');
  }
  const targetBtn = aux.locator('.action-label, a, span').filter({ hasText: /^Local$/ }).first();
  if (await targetBtn.count()) {
    await targetBtn.click().catch(() => {}); await page.waitForTimeout(1000);
    const rows = await pickerRows();
    check('session-target picker offers no Copilot / Cloud entry', rows.some((r) => /^Local/.test(r)) && !rows.some((r) => /copilot|cloud/i.test(r)), JSON.stringify(rows.slice(0, 6)));
    await page.screenshot({ path: join(OUT, 'target-picker.png') });
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  } else {
    info('session-target picker', 'no "Local" button found in the chat footer');
  }

  // 5 (informational). Mode picker rows — is Plan there?
  const modeBtn = inputContainer.locator('a.action-label, .action-label').filter({ hasText: /^(Agent|Ask|Edit|Plan)\b/ }).first();
  if (await modeBtn.count()) {
    await modeBtn.click({ timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(OUT, 'mode-picker.png') });
    const rows = await pickerRows();
    info('mode picker rows (anonymous mode forces Agent; Plan expected absent)', JSON.stringify(rows.slice(0, 12)));
    info('Plan agent offered in the mode picker', String(rows.some((r) => /\bPlan\b/.test(r))));
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  } else {
    info('mode picker', 'no mode button found in the chat input toolbar');
  }

  // 3. Agent-mode prompt on the fresh context.
  const editor = inputContainer.locator('.monaco-editor').first();
  await editor.waitFor({ state: 'visible', timeout: 20_000 });
  await page.mouse.move(700, 300); await page.waitForTimeout(400);
  await editor.click({ position: { x: 40, y: 12 }, force: true });
  await page.waitForTimeout(300);
  await page.keyboard.type(PROMPT, { delay: 8 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, 'prompt-in-flight.png') });

  let dialogs = [];
  let hello = '';
  const started = Date.now();
  let sawBusy = false;
  while (Date.now() - started < T) {
    dialogs = await dialogTexts();
    if (dialogs.length) break;
    hello = EXEC ? trySh(`cat ${FOLDER}/hello.txt 2>/dev/null || true`) : '';
    const b = await busy();
    if (b) sawBusy = true;
    if (!b && sawBusy && (Date.now() - started) > 4000) break;
    if (hello.trim() === 'hi' && !b) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2000);
  hello = EXEC ? trySh(`cat ${FOLDER}/hello.txt 2>/dev/null || true`) : hello;
  const text = await transcript();
  check('no dialog ("Sign in to use GitHub Copilot") after sending the first prompt on a cold browser', dialogs.length === 0, dialogs.join(' | ').slice(0, 200));
  check('agent round trip: hello.txt created in the workspace with "hi"', hello.trim() === 'hi', `hello.txt=${JSON.stringify(hello.slice(0, 40))}`);
  check('assistant reply rendered in the chat', /Done|created|hello\.txt/i.test(text), text.slice(0, 200));
  const bodyText = clean(await page.locator('body').innerText().catch(() => ''));
  check('no visible "Sign in to use Copilot" text', !/sign in to use (github )?copilot/i.test(bodyText));
  await aux.screenshot({ path: join(OUT, 'after-agent.png') }).catch(() => {});
  await page.screenshot({ path: join(OUT, 'after-agent-workbench.png') }).catch(() => {});
  const brandingAfter = await visibleBranding();
  check('no visible "Copilot" / "GitHub" text anywhere in the workbench after the Agent prompt', brandingAfter.length === 0, JSON.stringify(brandingAfter.slice(0, 4)));

  // What the model actually received.
  if (EXEC) {
    try { capturedRequests = JSON.parse(sh(`cat ${CAPTURE_DIR}/captured.json 2>/dev/null || echo []`)); } catch (e) { capturedRequests = []; consoleErrors.push('capture parse: ' + e.message); }
  }
  const agent = capturedRequests.find((r) => Array.isArray(r.body?.tools) && r.body.tools.length > 0);
  const toolNames = agent ? agent.body.tools.map((t) => t.function?.name).filter(Boolean) : [];
  const systemMsg = agent?.body?.messages?.find((m) => m.role === 'system');
  const systemText = typeof systemMsg?.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg?.content ?? '');
  check('prompt reached the mock provider through ezil-models', capturedRequests.length >= 1, `requests=${capturedRequests.length}`);
  check('captured Agent-mode request carries Copilot Chat\'s system prompt', !!systemMsg && systemText.length > 1000, `system_chars=${systemText.length} starts=${JSON.stringify(systemText.slice(0, 60))}`);
  check('system prompt identifies the assistant as EZiL Chat, never GitHub Copilot', systemText.includes('You are EZiL Chat, an AI coding assistant') && systemText.includes('respond with "EZiL Chat"') && !/GitHub Copilot/.test(JSON.stringify(capturedRequests)), `identity=${JSON.stringify((systemText.match(/[^.\n]*EZiL Chat[^.\n]*\./) || [''])[0].slice(0, 140))}`);
  check('captured request carries tool definitions including create_file', toolNames.includes('create_file'), `tools=${toolNames.length} sample=${JSON.stringify(toolNames.slice(0, 6))}`);
  check('tool result for the create_file call was sent back to the model', capturedRequests.some((r) => (r.body?.messages ?? []).some((m) => m.role === 'tool')), `requests=${capturedRequests.length}`);
  check('request carried the configured API key (Authorization: Bearer <apiKey>)', !!agent && agent.headers?.authorization === `Bearer ${API_KEY}`, `authorization=${JSON.stringify(agent?.headers?.authorization ?? null)}`);
  check('request was streamed (stream: true)', !!agent && agent.body?.stream === true);

  // 4. Language Models editor lists the EZiL vendor and model.
  await runCommand('Chat: Manage Language Models');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(OUT, 'manage-models.png') });
  const lmText = clean(await page.locator('.monaco-workbench').innerText().catch(() => ''));
  const lmSlice = lmText.match(/Language Models[\s\S]{0,900}/)?.[0] ?? lmText.slice(0, 400);
  check('Language Models editor lists the EZiL vendor', /EZiL/.test(lmSlice), lmSlice.slice(0, 200));
  check(`Language Models editor lists the configured model "${MODEL_NAME}"`, lmText.includes(MODEL_NAME));
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
  await runCommand('View: Close All Editors').catch(() => {});
  await page.waitForTimeout(500);

  const fatal = consoleErrors.filter((t) => /ezil-models|EZiL Models|Cannot read properties of undefined/.test(t));
  check('no workbench console error mentioning ezil-models / undefined product fields', fatal.length === 0, fatal.slice(0, 2).join(' | '));
} catch (e) {
  check('suite completed without an unexpected exception', false, String(e).slice(0, 300));
} finally {
  await page.screenshot({ path: join(OUT, 'final.png') }).catch(() => {});
  await context.close();
  await browser.close();
}

// Revision 3: browser-side network. Everything that was not code-server was aborted and logged.
const foreignHosts = [...new Set(foreignRequests.map((r) => r.host))].sort();
const blockedBrowser = foreignHosts.filter((h) => BLOCKED_HOST_RE.test(h));
check('browser made zero requests to GitHub / githubusercontent / githubcopilot / Microsoft-telemetry / exp-tas / applicationinsights / vscode-cdn hosts', blockedBrowser.length === 0, `blocked=${JSON.stringify(blockedBrowser)} other=${JSON.stringify(foreignHosts)}`);
if (foreignHosts.length) info('other browser-side hosts (aborted, not asserted)', JSON.stringify(foreignHosts));

const summary = capturedRequests.map((r) => ({
  n: r.n, model: r.body?.model, stream: r.body?.stream, tools: (r.body?.tools ?? []).length,
  roles: (r.body?.messages ?? []).map((m) => m.role),
  lastText: clean(String(typeof r.body?.messages?.at?.(-1)?.content === 'string' ? r.body.messages.at(-1).content : JSON.stringify(r.body?.messages?.at?.(-1)?.content ?? ''))).slice(0, 160),
}));
writeFileSync(join(OUT, 'checks.json'), JSON.stringify({ codeUrl: CODE_URL, folder: FOLDER, results, capturedRequests: summary, browserForeignRequests: foreignRequests.slice(0, 60), consoleErrors: consoleErrors.slice(0, 40) }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; artifacts in ${OUT}`);
process.exit(failed.length === 0 ? 0 : 1);
