/**
 * Lead-run Playwright half of copilot-ezil-image.sh. Fresh browser per pass.
 * Asserts branding, models, agent edits, terminal confirmation, Keep/Undo,
 * terminal token removal, and gateway captures. Exit 2 means not run.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { validateBody } from './copilot-ezil-messages-mock.mjs';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset (a node_modules with `playwright` and a downloaded chromium)'); process.exit(2); }
const require_ = createRequire(REQ_DIR + '/x.js');
let chromium;
try { ({ chromium } = require_('playwright')); }
catch { console.error('SKIP: playwright unresolvable from ' + REQ_DIR); process.exit(2); }

const CODE_URL = (process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:8443').replace(/\/$/, '');
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out';
const CONTAINER = process.env.EZIL_E2E_CONTAINER ?? '';
const EXEC = Boolean(CONTAINER);
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const MODEL_NAME = 'Qwen3 Coder Next';
const KIMI_NAME = 'Kimi K3 (no streaming)';
const PROMPT = 'EZIL_E2E_AGENT: create hello.txt containing hi, change existing.txt from before to after, then run the terminal confirmation command.';
const T = Number(process.env.EZIL_E2E_TIMEOUT_MS ?? 120_000);

mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const info = (name, detail) => { results.push({ name, ok: true, info: true, detail }); console.log(`INFO  ${name}  — ${detail}`); };

// Structured argv avoids a second host-shell interpretation of container reads.
const sh = command => {
  if (!CONTAINER) throw new Error('EZIL_E2E_CONTAINER unset');
  return execFileSync('docker', ['exec', CONTAINER, 'bash', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
};
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const file = name => sh(`cat ${quote(join(FOLDER, name))} 2>/dev/null || true`);
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
// VS Code 1.141 lists recent/default models at the top and the rest under "Other Models".
const expandOtherModels = async () => {
  const other = page.locator('.context-view .monaco-list-row, .action-widget .monaco-list-row, .monaco-menu .action-item').filter({ hasText: /^\s*Other Models/ }).first();
  if (!(await other.count())) return false;
  await other.hover().catch(() => {});
  await other.click().catch(() => {});
  await page.waitForTimeout(700);
  return true;
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

  // 1. Secondary sidebar visible, Chat view active.
  let auxVisible = false;
  try { await aux.waitFor({ state: 'visible', timeout: T }); auxVisible = true; } catch { /* asserted */ }
  check('secondary sidebar is visible by default', auxVisible);
  const chatWidget = aux.locator('.interactive-session, .chat-widget').first();
  let chatVisible = false;
  try { await chatWidget.waitFor({ state: 'visible', timeout: T }); chatVisible = true; } catch { /* asserted */ }
  const auxTitle = clean(await aux.locator('.composite.title, .title-label').first().innerText().catch(() => ''));
  check('Chat view (Copilot Chat) is the active view of the secondary sidebar', chatVisible, `title=${JSON.stringify(auxTitle)}`);
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

  // The picker must expose both models, with Qwen selected before any input.
  const modelButton = () => inputContainer.locator('.action-label').filter({ hasText: /Qwen3 Coder Next|Kimi K3|^Auto$/ }).first();
  await modelButton().waitFor({ state: 'visible', timeout: T });
  check('Qwen is selected by default', (await modelButton().innerText()).includes(MODEL_NAME));
  await modelButton().click();
  await page.waitForTimeout(800);
  let models = await pickerRows();
  if (!models.some(row => row.includes(KIMI_NAME)) && await expandOtherModels()) models = [...new Set([...models, ...await pickerRows()])];
  check('model picker contains Qwen and Kimi with no sign-in entry', models.some(row => row.includes(MODEL_NAME)) && models.some(row => row.includes(KIMI_NAME)) && !models.some(row => /sign in/i.test(row)), JSON.stringify(models));
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(200); }

  // Type only once the chat input really has focus, and send only what landed there.
  let sendAttempt = 0;
  const send = async prompt => {
    const editor = aux.locator('.chat-input-container .monaco-editor').first();
    await editor.waitFor({ state: 'visible', timeout: T });
    for (let attempt = 0; attempt < 3; attempt++) {
      await editor.locator('.view-lines').first().click({ force: true });
      await page.waitForTimeout(250);
      await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
      await page.keyboard.type(prompt, { delay: 3 });
      await page.waitForTimeout(250);
      if (clean(await editor.innerText()).includes(prompt.slice(0, 20))) { await page.keyboard.press('Enter'); return; }
      await page.screenshot({ path: join(OUT, `send-attempt-${++sendAttempt}.png`) });
      for (let i = 0; i < 2; i++) await page.keyboard.press('Escape');
    }
    throw new Error('the prompt never reached the chat input: ' + prompt.slice(0, 40));
  };
  const until = async (predicate, label) => {
    const started = Date.now();
    while (Date.now() - started < T) {
      if (await predicate()) return;
      await page.waitForTimeout(500);
    }
    throw new Error('Timed out: ' + label);
  };
  const editAction = async label => {
    const candidates = aux.locator(`[aria-label^="${label}"], [title^="${label}"]`).or(aux.getByRole('button', { name: new RegExp('^' + label + '( All)?(?: Changes| Edits)?$') }));
    await until(async () => {
      for (const candidate of await candidates.all()) {
        if (await candidate.isVisible()) { await candidate.click(); return true; }
      }
      return false;
    }, label + ' action');
  };

  await send(PROMPT);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT, 'after-send.png') });
  const confirmation = aux.locator('.chat-confirmation-widget-container, .chat-confirmation-widget2').filter({ hasText: /terminal-confirmed|printf/ }).first();
  await confirmation.waitFor({ state: 'visible', timeout: T });
  check('terminal tool requires confirmation in the UI', true);
  check('terminal command has not run before confirmation', file('terminal-confirmed.txt') === '');
  await page.screenshot({ path: join(OUT, 'terminal-confirmation.png') });
  // Approve the pending terminal tool. 1.141's markup differs from 1.139's; try accessible names first
  // and dump what the confirmation offers if nothing matches, so a failure is diagnosable.
  const approve = async () => {
    const candidates = [
      aux.getByRole('button', { name: /^(Allow|Continue|Run)\b/i }),
      page.getByRole('button', { name: /^(Allow|Continue|Run)\b/i }),
      aux.locator('.monaco-button, a[role="button"], button').filter({ hasText: /^\s*(Allow|Continue|Run)\b/i }),
    ];
    for (const candidate of candidates) {
      const all = await candidate.all();
      for (const button of all) {
        if (!(await button.isVisible().catch(() => false))) continue;
        // A covering element (tips, hovers) makes a normal click wait forever: fall back to force, then keyboard.
        if (await button.click({ timeout: 5000 }).then(() => true, () => false)) return;
        if (await button.click({ force: true, timeout: 5000 }).then(() => true, () => false)) return;
        if (await button.focus().then(() => page.keyboard.press('Enter')).then(() => true, () => false)) return;
      }
    }
    const names = await aux.locator('[role="button"], button, .monaco-button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean));
    writeFileSync(join(OUT, 'confirmation-buttons.json'), JSON.stringify(names, null, 2));
    writeFileSync(join(OUT, 'confirmation.html'), await confirmation.evaluate(e => e.closest('.interactive-item-container, .chat-tool-invocation-part, .monaco-list-row')?.outerHTML ?? e.outerHTML).catch(() => ''));
    throw new Error('no Allow/Continue/Run button for the terminal confirmation: ' + JSON.stringify(names).slice(0, 300));
  };
  await approve();
  await until(async () => (await transcript()).includes('EZIL_E2E_DONE') && !await busy(), 'agent completion');
  check('agent created hello.txt', file('hello.txt') === 'hi\n');
  check('agent edited existing.txt', file('existing.txt') === 'after\n');
  check('approved terminal command ran', file('terminal-confirmed.txt') === 'confirmed\n');
  await editAction('Keep');
  check('Keep retains created and edited files on disk', file('hello.txt') === 'hi\n' && file('existing.txt') === 'after\n');
  await page.screenshot({ path: join(OUT, 'kept-edits.png') });
  const statusText = clean(await page.locator('.part.statusbar').innerText().catch(() => ''));
  check('status bar offers no Sign In after an agent run', !/sign in/i.test(statusText), statusText.slice(0, 200));

  await runCommand('Chat: New Chat');
  await send('EZIL_E2E_UNDO: change existing.txt from after to undo candidate so I can review and undo it.');
  await until(async () => file('existing.txt') === 'undo candidate\n' && !await busy(), 'undo candidate');
  await editAction('Undo');
  // Some workbench versions confirm discarding the proposed edits.
  // 1.141 asks "This will undo changes made in <file>. Do you want to proceed?" (Yes / Cancel).
  const discard = page.locator('.monaco-dialog-box').getByRole('button', { name: /^(Yes|Undo|Discard)/i }).first();
  if (await discard.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) await discard.click();
  await until(async () => file('existing.txt') === 'after\n', 'Undo restores prior content');
  check('Undo restores the last kept content on disk', true);

  await runCommand('Chat: New Chat');
  await modelButton().click();
  await page.waitForTimeout(600);
  if (!(await pickerRows()).some(row => row.includes(KIMI_NAME))) await expandOtherModels();
  const kimiRow = page.locator('.context-view .monaco-list-row, .quick-input-widget .monaco-list-row, .action-widget .monaco-list-row, .monaco-menu .action-item').filter({ hasText: KIMI_NAME }).first();
  await kimiRow.click();
  await send('EZIL_E2E_KIMI: reply with the JSON smoke-test completion.');
  await until(async () => (await transcript()).includes('EZIL_KIMI_OK') && !await busy(), 'Kimi JSON response');
  check('Kimi completes a chat round trip', true);

  // Run through the integrated terminal UI, not docker exec. Redirecting
  // printenv captures exactly what it would print without exposing any value.
  await runCommand('Terminal: Create New Terminal');
  await page.locator('.terminal .xterm-helper-textarea').last().waitFor({ state: 'attached', timeout: T });
  await page.locator('.terminal .xterm-helper-textarea').last().focus();
  await page.keyboard.type('printenv EZIL_AI_PROXY_TOKEN > /tmp/ezil-terminal-token.txt; printf done > /tmp/ezil-terminal-check-done');
  await page.keyboard.press('Enter');
  await until(async () => trySh('cat /tmp/ezil-terminal-check-done 2>/dev/null') === 'done', 'integrated terminal env check');
  check('integrated terminal printenv EZIL_AI_PROXY_TOKEN prints nothing', sh('wc -c < /tmp/ezil-terminal-token.txt').trim() === '0');
  check('patch --verify passes inside the image', trySh('/usr/local/lib/ezil/patch-copilot-chat.sh --verify /usr/lib/code-server/lib/vscode').includes('all gates passed'));

  const dialogs = await dialogTexts();
  check('no sign-in dialog after agent and model round trips', !dialogs.some(value => /sign in/i.test(value)), dialogs.join(' | '));
  const bodyText = clean(await page.locator('body').innerText());
  check('no visible sign-in-to-Copilot text', !/sign in to use (github )?copilot/i.test(bodyText));
  const brandingAfter = await visibleBranding();
  check('no visible Copilot/GitHub branding after the agent prompt', brandingAfter.length === 0, JSON.stringify(brandingAfter.slice(0, 4)));

  capturedRequests = JSON.parse(sh(`cat ${quote(CAPTURE_DIR + '/captured.json')}`));
  const requests = capturedRequests.filter(record => record.path === '/ai/v1/messages');
  const agent = requests.find(record => record.body?.tools?.some(tool => tool.name === 'create_file'));
  const toolNames = agent?.body.tools.map(tool => tool.name) ?? [];
  const systemText = typeof agent?.body.system === 'string' ? agent.body.system : (agent?.body.system ?? []).map(block => block.text).join('\n');
  check('agent reached the messages gateway with its full system prompt', systemText.length > 1000, `system_chars=${systemText.length}`);
  check('system prompt identifies as EZiL Chat', systemText.includes('You are EZiL Chat, an AI coding assistant') && !/GitHub Copilot/.test(JSON.stringify(requests)));
  check('agent offered create, edit and terminal tools', ['create_file', 'replace_string_in_file', 'run_in_terminal'].every(name => toolNames.includes(name)), `tools=${toolNames.length}`);
  const results = requests.flatMap(record => record.body.messages.flatMap(turn => Array.isArray(turn.content) ? turn.content : [])).filter(block => block.type === 'tool_result');
  check('all three tool results returned to the gateway', ['ezil_create', 'ezil_edit', 'ezil_terminal'].every(id => results.some(block => block.tool_use_id === id && !block.is_error)));
  check('every captured messages body satisfies the Converse subset', requests.length > 0 && requests.every(record => validateBody(record.body, record.bytes) === null));
  check('every gateway request authenticated', capturedRequests.length > 0 && capturedRequests.every(record => record.authorized));
  check('Qwen uses Anthropic SSE', !!agent && agent.body.model === 'qwen.qwen3-coder-next' && agent.body.stream === true);
  const kimi = requests.filter(record => record.body.model === 'us.moonshotai.kimi-k3');
  check('every Kimi request has stream:false', kimi.length > 0 && kimi.every(record => record.body.stream === false));

  // 4. Language Models editor lists the EZiL vendor and model.
  await runCommand('Chat: Manage Language Models');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(OUT, 'manage-models.png') });
  const lmText = clean(await page.locator('.monaco-workbench').innerText().catch(() => ''));
  const lmSlice = lmText.match(/Language Models[\s\S]{0,900}/)?.[0] ?? lmText.slice(0, 400);
  check('Language Models editor lists the EZiL vendor', /EZiL/.test(lmSlice), lmSlice.slice(0, 200));
  check('Language Models editor lists both configured models', lmText.includes(MODEL_NAME) && lmText.includes(KIMI_NAME));
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
