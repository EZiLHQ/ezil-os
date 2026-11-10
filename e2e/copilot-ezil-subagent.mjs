// Image e2e, pass "subagent" (copilot-ezil-image.sh): can an Agent-mode turn start a subagent on another EZiL model?
// The subagent is VS Code 1.141's own runSubagent tool (workbench, not Copilot Chat and not the Gateway). Its input
// has an optional `model` ("<name> (<vendor>)"), which the workbench resolves among the registered language models
// (lookupLanguageModelByQualifiedName) and uses as the child request's model; without one the child inherits the
// parent's model, and a name that is not registered fails the tool call before any request. The mock Gateway scripts
// the parent's tool call (EZIL_E2E_SUBAGENT) and answers the child (EZIL_E2E_CHILD); this pass compares the model of
// each request it received. No real model is called.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/subagent';
const CONTAINER = process.env.EZIL_E2E_CONTAINER;
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
mkdirSync(OUT, { recursive: true });
const QWEN = 'qwen.qwen3-coder-next';
const KIMI = 'us.moonshotai.kimi-k3';

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  subagent: ${name}${detail ? ` — ${detail}` : ''}`); };
const messages = () => {
  try { return JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'cat', `${CAPTURE_DIR}/captured.json`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).filter(r => r.method === 'POST' && r.path === '/ai/v1/messages'); } catch { return []; }
};
const userText = (r) => (r.body?.messages ?? []).filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.map(b => b.type === 'text' ? b.text : b.type === 'tool_result' ? JSON.stringify(b.content) : '').join('\n')).join('\n');

const browser = await chromium.launch();
try {
  if (!CONTAINER) throw new Error('EZIL_E2E_CONTAINER is required');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 90_000 });
  const model = page.locator('.part.auxiliarybar .action-label[aria-label^="Models, "]').first();
  await model.waitFor({ state: 'visible', timeout: 60_000 });
  for (let i = 0; i < 60 && !((await model.getAttribute('aria-label')) ?? '').includes('Qwen3 Coder Next'); i++) await page.waitForTimeout(1000);
  await page.waitForTimeout(1500);
  check('the parent chat runs on Qwen3 Coder Next', (await model.getAttribute('aria-label')) === 'Models, Qwen3 Coder Next');
  const editor = page.locator('.part.auxiliarybar .chat-input-container .monaco-editor').first();
  // Send one prompt in a new chat and return the requests it caused once the parent's final answer has arrived.
  const run = async (prompt, done) => {
    const before = messages().length;
    await editor.locator('.view-lines').first().click({ force: true });
    await page.keyboard.press('Control+L');
    await page.waitForTimeout(1500);
    await editor.locator('.view-lines').first().click({ force: true });
    await page.keyboard.type(prompt, { delay: 3 });
    await page.keyboard.press('Enter');
    for (let i = 0; i < 90; i++) {
      if (await page.locator('.part.auxiliarybar .interactive-item-container').filter({ hasText: done }).count()) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(1500);
    return messages().slice(before);
  };
  const turns = (sent, marker) => sent.filter(r => Array.isArray(r.body?.tools) && r.body.tools.length && userText(r).includes(marker));

  const qualified = 'Kimi K3 (no streaming) (ezil)';
  let sent = await run(`EZIL_E2E_SUBAGENT model=[${qualified}]`, 'EZIL_SUBAGENT_DONE');
  await page.screenshot({ path: join(OUT, 'explicit-model.png') });
  const parent = turns(sent, 'EZIL_E2E_SUBAGENT'), child = turns(sent, 'EZIL_E2E_CHILD');
  const offered = parent[0]?.body.tools.find(t => t.name === 'runSubagent');
  check('Agent mode offers runSubagent with an optional model', Boolean(offered?.input_schema?.properties?.model) && !offered.input_schema.required?.includes('model'), JSON.stringify(offered?.input_schema?.properties?.model ?? null));
  check(`the parent's turns go to ${QWEN}`, parent.length >= 2 && parent.every(r => r.body.model === QWEN), JSON.stringify(parent.map(r => r.body.model)));
  check(`a subagent asked for "${qualified}" runs on ${KIMI}`, child.length >= 1 && child.every(r => r.body.model === KIMI && r.body.stream !== true), JSON.stringify(child.map(r => [r.body.model, r.body.stream])));
  check('the child answer comes back to the parent as the tool result', parent.some(r => userText(r).includes('EZIL_CHILD_OK')));

  sent = await run('EZIL_E2E_SUBAGENT', 'EZIL_SUBAGENT_DONE');
  const inherited = turns(sent, 'EZIL_E2E_CHILD');
  check(`a subagent without a model inherits the parent's (${QWEN})`, inherited.length >= 1 && inherited.every(r => r.body.model === QWEN), JSON.stringify(inherited.map(r => r.body.model)));

  sent = await run('EZIL_E2E_SUBAGENT model=[Gemini 3.8 Flash (ezil)]', 'EZIL_SUBAGENT_DONE');
  await page.screenshot({ path: join(OUT, 'unlisted-model.png') });
  const refused = turns(sent, 'EZIL_E2E_SUBAGENT');
  check('a model that is not in the picker starts no subagent request', turns(sent, 'EZIL_E2E_CHILD').length === 0, JSON.stringify(sent.map(r => r.body?.model)));
  check('the parent is told the model was not found', refused.some(r => /Requested model .*not found/.test(userText(r))), refused.map(r => userText(r).match(/Requested model[^"\\]*/)?.[0]).filter(Boolean).join(' | ').slice(0, 300));
  await ctx.close();
} catch (e) {
  check('completed', false, String(e).slice(0, 300));
} finally { await browser.close(); }
writeFileSync(join(OUT, 'checks.json'), JSON.stringify(results, null, 1));
process.exit(results.every((r) => r.ok) ? 0 : 1);
