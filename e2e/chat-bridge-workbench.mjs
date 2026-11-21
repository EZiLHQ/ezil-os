/**
 * Playwright half of e2e/chat-bridge-workbench.sh: a real code-server 4.141.0 workbench with the
 * [chat-bridge] patch, the real ezil-models extension (sync client) and Copilot Chat, against the
 * in-container stand-in OS (chat-bridge-os-standin.mjs) and the offline messages mock. No paid inference.
 * The person opens EZiL Chat and sends one message; then the stand-in OS sends an instruction into THAT
 * session through the bridge, and later a slow one that it cancels. Exit 2 means not run.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REQ_DIR = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!REQ_DIR) { console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR unset'); process.exit(2); }
const { chromium } = createRequire(REQ_DIR + '/x.js')('playwright');
const CODE_URL = (process.env.EZIL_CODE_URL ?? '').replace(/\/$/, '');
const CONTAINER = process.env.EZIL_E2E_CONTAINER ?? '';
const OUT = process.env.EZIL_E2E_OUT ?? './chat-bridge-e2e-out';
const T = 120_000;
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const clean = (s) => s.replace(/\s+/g, ' ').trim();
const bridgeState = () => JSON.parse(execFileSync('docker', ['exec', CONTAINER, 'curl', '-fsS', 'http://127.0.0.1:4142/bridge-state'], { encoding: 'utf8' }));
const until = async (predicate, ms = 90_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const s = bridgeState(); if (predicate(s)) return s; await new Promise((r) => setTimeout(r, 1000)); }
  return bridgeState();
};
const opOf = (s, role) => s.ops.find((o) => o.role === role);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route('**/*', (route) => (new URL(route.request().url()).host === new URL(CODE_URL).host ? route.continue() : route.abort()));
const page = await context.newPage();
const aux = page.locator('.part.auxiliarybar');
const editor0 = () => aux.locator('.chat-input-container .monaco-editor').first();
const transcript = async () => clean(await aux.locator('.interactive-list').first().innerText().catch(() => ''));
let failed = false;
try {
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent('/home/neko/project')}`, { waitUntil: 'domcontentloaded' });
  await aux.locator('.chat-input-container .monaco-editor').first().waitFor({ state: 'visible', timeout: T });
  check('workbench and EZiL Chat render', true);
  // The window's extension host syncs with the bridge token (never the AI token) once it has connected.
  const idle = await until((s) => s.syncs > 0, 60_000);
  check('the extension syncs with the bridge token (never the AI token)', idle.syncs > 0 && idle.refused.length === 0, JSON.stringify({ syncs: idle.syncs, refused: idle.refused }));

  if (process.env.EZIL_STANDIN_NEWCHAT) {
    // Experiment (not a release check): after one exchange, open a new chat and let the stand-in target it.
    for (let i = 0; i < 40 && !/Agent|Ask|Auto|Model|Pick/i.test(clean(await aux.locator('.chat-view-title-container').first().innerText().catch(() => ''))); i++) await page.waitForTimeout(750);
    await page.waitForTimeout(Number(process.env.EZIL_E2E_SETTLE_MS ?? 45_000));
    await editor0().locator('.view-lines').first().click({ force: true });
    await page.keyboard.type('Hello from the person', { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /EZiL Chat/.test(document.querySelector('.part.auxiliarybar .interactive-list')?.textContent ?? ''), null, { timeout: T });
    await until((s) => s.used.length > 0 && s.sessions.some((x) => x.status === 'idle'), 60_000);
    await page.keyboard.press('Control+L');
    const done = await until((s) => ['completed', 'cancelled', 'failed', 'uncertain', 'rejected'].includes(opOf(s, 'newchat')?.status), 120_000);
    const n = opOf(done, 'newchat');
    check('experiment: an instruction into a new chat opened after a used one', true, JSON.stringify({ status: n?.status, response: n?.responseText?.slice(0, 40),
      reports: done.reports.filter((r) => r.operationId === n?.id).map((r) => [r.status, r.reason ?? null]), sessions: done.sessions.length }));
    await page.screenshot({ path: join(OUT, 'newchat.png') });
    writeFileSync(join(OUT, 'bridge-state.json'), JSON.stringify(done, null, 2));
    throw new Error('experiment finished');
  }
  // Before the person has used chat in this cold profile, Copilot Chat cannot be activated: an instruction is held
  // (not_delivered, agent_not_ready), never sent, and stays queued at OS.
  const held = await until((s) => s.reports.some((r) => r.operationId === opOf(s, 'early')?.id && r.reason === 'agent_not_ready'), 90_000);
  const heldEarly = opOf(held, 'early');
  check('before the chat agent is available, an instruction is held (agent_not_ready), not sent',
    !!heldEarly && heldEarly.status !== 'completed' && !(await transcript()).includes('EZIL_BRIDGE_EARLY'),
    JSON.stringify({ status: heldEarly?.status, held: held.reports.filter((r) => r.operationId === heldEarly?.id).length }));

  // The person sends one message, so the session is live and open in this window.
  const editor = aux.locator('.chat-input-container .monaco-editor').first();
  for (let i = 0; i < 40 && !/Agent|Ask|Auto|Model|Pick/i.test(clean(await aux.locator('.chat-view-title-container').first().innerText().catch(() => ''))); i++) await page.waitForTimeout(750);
  // Give Copilot Chat time to activate before the first request (a request sent earlier can time out
  // waiting for the chat agent: "Chat took too long to get ready"), as the image e2e does.
  await page.waitForTimeout(Number(process.env.EZIL_E2E_SETTLE_MS ?? 45_000));
  await editor.locator('.view-lines').first().click({ force: true });
  await page.keyboard.type('Hello from the person', { delay: 5 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /EZiL Chat/.test(document.querySelector('.part.auxiliarybar .interactive-list')?.textContent ?? ''), null, { timeout: T });
  check('the person\'s own message is answered by the offline mock', true);

  // Once the person has used chat, the held instruction runs (once) and completes.
  const afterEarly = await until((s) => ['completed', 'cancelled', 'failed', 'uncertain', 'rejected'].includes(opOf(s, 'early')?.status), 120_000);
  const early = opOf(afterEarly, 'early');
  check('the held instruction then runs once and completes', early?.status === 'completed'
    && afterEarly.reports.filter((r) => r.operationId === early?.id && r.status === 'running').length === 1, JSON.stringify({ status: early?.status }));
  const afterPing = await until((s) => ['completed', 'failed', 'uncertain', 'rejected'].includes(opOf(s, 'ping')?.status));
  const ping = opOf(afterPing, 'ping');
  check('the editor listed the open session', afterPing.sessions.some((s) => s.open), JSON.stringify(afterPing.sessions.map((s) => ({ open: s.open, status: s.status }))));
  check('the stand-in OS instruction ran in that session and completed with its own response', ping?.status === 'completed' && /EZiL Chat/.test(ping?.responseText ?? ''), JSON.stringify({ status: ping?.status, mode: ping?.mode, model: ping?.selectedModelId, response: ping?.responseText?.slice(0, 80) }));
  await page.waitForTimeout(1500);
  const shown = await transcript();
  // The list virtualizes older items, so only the latest exchange is checked in the DOM.
  check('the instruction appears in the SAME chat the person sees', shown.includes('EZIL_BRIDGE_PING') && afterPing.sessions.filter((x) => x.open).length === 1, shown.slice(0, 240));
  await page.screenshot({ path: join(OUT, 'after-ping.png') });

  const afterCancel = await until((s) => ['cancelled', 'completed', 'failed', 'uncertain'].includes(opOf(s, 'slow')?.status), 120_000);
  const slow = opOf(afterCancel, 'slow');
  const cancel = opOf(afterCancel, 'cancel');
  check('a running bridged request is cancelled only through the bridge', slow?.status === 'cancelled' && cancel?.status === 'cancel_requested', JSON.stringify({ slow: slow?.status, cancel: cancel?.status }));
  const reportsFor = (id) => afterCancel.reports.filter((r) => r.operationId === id && r.applied).map((r) => r.status);
  check('each instruction was sent once (one attempt, reports in order)', JSON.stringify(reportsFor(ping?.id)).startsWith('["running"') && afterCancel.ops.every((o) => o.status !== 'delivered'), JSON.stringify({ ping: reportsFor(ping?.id), slow: reportsFor(slow?.id) }));
  await page.screenshot({ path: join(OUT, 'after-cancel.png') });
  writeFileSync(join(OUT, 'bridge-state.json'), JSON.stringify(afterCancel, null, 2));
} catch (error) {
  failed = true;
  check('run completed', false, String(error?.message ?? error).slice(0, 300));
  await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
} finally {
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  await browser.close();
}
process.exit(failed || results.some((r) => !r.ok) ? 1 : 0);
