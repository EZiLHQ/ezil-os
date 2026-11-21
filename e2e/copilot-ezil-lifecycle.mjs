// Run against a code-server image or a loopback standalone copy with the demo mock.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { KIMI, KIMI_LIFECYCLE_REPLY } from './copilot-ezil-messages-mock.mjs';

const origin = new URL(process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:8443').origin;
const folder = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const capture = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const container = process.env.EZIL_E2E_CONTAINER;
const out = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out';
const requireDir = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!requireDir) {
  console.error('SKIP: PLAYWRIGHT_REQUIRE_DIR is required');
  process.exit(2);
}
const { chromium } = createRequire(join(requireDir, 'lifecycle-test.js'))('playwright');

const fixtureNode = (source, ...args) => execFileSync(container ? 'docker' : process.execPath,
  [...container ? ['exec', container, 'node'] : [], '-e', source, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const records = () => JSON.parse(fixtureNode("try{process.stdout.write(require('node:fs').readFileSync(process.argv[1]))}catch(e){if(e.code!=='ENOENT')throw e;process.stdout.write('[]')}", join(capture, 'captured.json')));
const release = marker => fixtureNode("require('node:fs').writeFileSync(process.argv[1],'')", join(capture, marker + '.release'));
const savedTranscript = (directory, marker) => fixtureNode(`
  const fs = require('node:fs');
  const path = require('node:path');
  const [folder, marker] = process.argv.slice(1);
  const matches = [];
  for (const name of fs.readdirSync(folder).filter(name => name.endsWith('.jsonl'))) {
    try {
      const data = fs.readFileSync(path.join(folder, name), 'utf8');
      if (data.includes(marker)) matches.push({ name, data });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (matches.length === 1) process.stdout.write(JSON.stringify(matches[0]));
`, directory, marker);

function savedTurn(directory, marker) {
  const raw = savedTranscript(directory, marker);
  if (!raw) return;
  try {
    const { name, data } = JSON.parse(raw);
    const [initial, ...changes] = data.trim().split('\n').map(line => JSON.parse(line));
    const sessionId = initial.v?.sessionId;
    if (name !== sessionId + '.jsonl') return;
    let requests = initial.v?.requests ?? [];
    for (const change of changes) {
      const key = change.k?.join('/');
      if (key === 'requests') {
        if (change.kind === 1) requests = change.v;
        if (change.kind === 2) requests = [...requests.slice(0, change.i ?? requests.length), ...change.v];
      } else if (key === 'requests/0/modelState' && change.kind === 1) {
        requests[0].modelState = change.v;
      } else if (key === 'requests/0/response') {
        if (change.kind === 1) requests[0].response = change.v ?? [];
        if (change.kind === 2) {
          const response = requests[0].response ?? [];
          requests[0].response = [...response.slice(0, change.i ?? response.length), ...change.v];
        }
      }
    }
    if (requests.length === 1 && requests[0].message?.text === marker) return { sessionId, ...requests[0] };
  } catch (error) {
    // The last line can be in the middle of an append.
    if (!(error instanceof SyntaxError)) throw error;
  }
}

async function waitFor(read, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(200);
  }
  assert.fail(description);
}

async function send(frame, marker) {
  const model = frame.locator('.part.auxiliarybar .action-label[aria-label^="Models, "]').first();
  // This pass has a separate model configuration so UI picker timing cannot
  // affect whether the lifecycle action races a currently pending JSON reply.
  await waitFor(async () => /Kimi K3/.test(await model.getAttribute('aria-label', { timeout: 1500 }).catch(() => '')), 'Kimi active in Code', 60_000);
  const input = frame.locator('.part.auxiliarybar .chat-input-container .monaco-editor').first();
  const lines = input.locator('.view-lines').first();
  const page = frame.page();
  await page.bringToFront();
  await lines.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText(marker);
  // Monaco's rendered lines can wrap and include zero-width layout characters.
  await waitFor(async () => (await lines.textContent()).replace(/[\s\u200b\ufeff]/g, '') === marker,
    'synthetic prompt did not reach the Code editor input', 10_000);
  await page.keyboard.press('Enter');
}

const transcript = frame => frame.locator('.part.auxiliarybar .interactive-list').first();
const messageCount = async (frame, marker) =>
  (await transcript(frame).innerText({ timeout: 1500 }).catch(() => '')).replace(/\s/g, '').split(marker).length - 1;
const markerInLatestMessage = (r, marker) => r.method === 'POST' && r.path === '/ai/v1/messages'
  && r.body?.model === KIMI && r.body.tools?.length && JSON.stringify(r.body.messages?.at(-1)).includes(marker);

async function reopenSavedChat(frame, marker) {
  const aux = frame.locator('.part.auxiliarybar');
  await frame.locator('.monaco-workbench').waitFor({ timeout: 60_000 });
  await aux.locator('.chat-input-container').first().waitFor({ timeout: 60_000 });
  if (await messageCount(frame, marker)) return 'restored-view';

  // The Sessions panel can be collapsed, and the prior view can reopen on an empty chat.
  // The normal Chat history picker explicitly resolves the local session provider on open.
  await aux.locator('.chat-view-title-container.visible .chat-view-title-action-item').first().click();
  const picker = frame.locator('.quick-input-widget:visible');
  const rows = picker.locator('.monaco-list-row:visible');
  const entry = await waitFor(async () => {
    // The editor may restore the chat while its history picker is opening.
    if (await messageCount(frame, marker)) return 'restored-view';
    const titled = rows.filter({ hasText: marker });
    if (await titled.count() === 1) return titled;
    // Some incomplete chats are still indexed by their generic title. This
    // isolated workspace has exactly one saved turn with the fixture marker.
    const generic = rows.filter({ hasText: 'EZiL Chat' });
    if (await rows.count() === 1 && await generic.count() === 1) return generic;
  }, 'the pending conversation reopens or is listed in Chat history');
  if (entry === 'restored-view') {
    if (await picker.isVisible()) await frame.page().keyboard.press('Escape');
    return entry;
  }
  await entry.click();
  return 'chat-history';
}

const results = [];
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
  headless: process.env.EZIL_E2E_HEADED !== '1',
});
try {
  for (const mode of ['browser-tab', 'hidden-frame', 'full-reload']) {
    const marker = 'EZIL_E2E_KIMI_LIFECYCLE_' + randomUUID().replaceAll('-', '');
    const workspace = join(folder, 'lifecycle-' + marker.slice(-32));
    const chat = join(workspace, '.ezil', 'chat');
    fixtureNode("require('node:fs').mkdirSync(process.argv[1],{recursive:true})", chat);
    const workbench = new URL('/?folder=' + encodeURIComponent(workspace), origin).href;
    const shell = new URL('/ezil-e2e-lifecycle-shell', origin).href;
    const otherUrl = new URL('/ezil-e2e-lifecycle-other', origin).href;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    let released = false;
    let backgroundVisibility;
    let replyEvidence;
    let reloadEvidence;
    let page;
    try {
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url === shell) return route.fulfill({ contentType: 'text/html', body:
          '<button id="hide" onclick="document.querySelector(\'iframe\').hidden=true">Hide Code</button>' +
          '<button id="show" onclick="document.querySelector(\'iframe\').hidden=false">Show Code</button>' +
          '<iframe src="' + workbench + '" width="1400" height="850"></iframe>' });
        if (url === otherUrl) return route.fulfill({ contentType: 'text/html', body: '<title>Other browser tab</title>' });
        return new URL(url).origin === origin ? route.continue() : route.abort();
      });
      page = await context.newPage();
      await page.goto(mode === 'hidden-frame' ? shell : workbench, { waitUntil: 'domcontentloaded' });
      const frame = mode === 'hidden-frame'
        ? await waitFor(() => page.frames().find(child => child.url() === workbench), 'Code iframe loaded') : page.mainFrame();
      await send(frame, marker);
      const calls = () => records().filter(r => markerInLatestMessage(r, marker));
      const held = await waitFor(() => calls().find(r => r.jsonReply === 'held'), 'mock must hold a Kimi request');
      assert.equal(held.body.stream, false);
      assert.equal(calls().length, 1);
      await waitFor(() => messageCount(frame, marker), 'original prompt appears in Code');
      const stamp = await frame.evaluate(() => window.ezilLifecycleFixtureDocument = crypto.randomUUID());

      if (mode === 'browser-tab') {
        // Playwright emulates focus by default, including when a real tab loses it.
        const browserWindow = async target => {
          const cdp = await context.newCDPSession(target);
          await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
          return (await cdp.send('Browser.getWindowForTarget')).windowId;
        };
        const originalWindow = await browserWindow(page);
        // An anchor target opens a tab in the same Chromium window; context.newPage can open another window.
        const [other] = await Promise.all([context.waitForEvent('page'), page.evaluate(url => {
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          // A transient fixture link on the real workbench, outside its UI.
          link.click();
        }, otherUrl)]);
        assert.equal(await browserWindow(other), originalWindow, 'the second tab must be in the same browser window');
        await other.bringToFront();
        await waitFor(() => page.evaluate(() => !document.hasFocus()), 'workbench tab must lose actual focus');
        backgroundVisibility = await page.evaluate(() => document.visibilityState);
        release(marker);
        released = true;
        await waitFor(() => calls().some(r => r.jsonReply === 'sent'), 'Kimi response produced while workbench tab is in the background');
        await page.bringToFront();
        await waitFor(() => page.evaluate(() => document.hasFocus()), 'workbench tab focused again');
        await other.close();
      } else if (mode === 'hidden-frame') {
        await page.locator('#hide').click();
        assert.equal(await page.locator('iframe').isVisible(), false);
        release(marker);
        released = true;
        await waitFor(() => calls().some(r => r.jsonReply === 'sent'), 'Kimi response produced while the Code iframe is hidden');
        await page.locator('#show').click();
        await frame.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first().click({ force: true });
      } else {
        const pending = await waitFor(() => {
          const turn = savedTurn(chat, marker);
          return [0, 4].includes(turn?.modelState?.value) ? turn : null;
        }, 'workbench must persist the exact prompt as a pending request before reload', 100_000);
        assert.equal(calls()[0].jsonReply, 'held', 'the original Kimi response is still held when reloading');
        await page.reload({ waitUntil: 'domcontentloaded' });
        assert.equal(await frame.evaluate(() => window.ezilLifecycleFixtureDocument), undefined, 'reload replaces the workbench document');
        const restoredVia = await reopenSavedChat(frame, marker);
        assert.equal(await waitFor(() => messageCount(frame, marker), 'original prompt appears in restored chat'), 1);
        await transcript(frame).getByText('This response was interrupted before it finished. Review any changes before retrying.', { exact: true }).waitFor();
        reloadEvidence = { sessionId: pending.sessionId, pendingState: pending.modelState.value, documentReplaced: true, restoredVia };
        release(marker);
        released = true;
      }

      if (mode !== 'full-reload') {
        assert.equal(await frame.evaluate(() => window.ezilLifecycleFixtureDocument), stamp);
        replyEvidence = await waitFor(async () => {
          const error = transcript(frame).locator('.chat-notification-widget:has(.chat-error-codicon)').first();
          assert.equal(await error.isVisible(), false, 'the retained chat must not display a reply error');
          const visible = await messageCount(frame, KIMI_LIFECYCLE_REPLY);
          if (visible) {
            assert.equal(visible, 1);
            return 'workbench';
          }
          // A zero-sized iframe can leave the list virtualized after showing it.
          // The matched, completed workbench JSONL proves the response still arrived.
          const turn = mode === 'hidden-frame' ? savedTurn(chat, marker) : null;
          if (turn?.modelState?.value !== 1) return null;
          // Ignore copies in the stored model result or trace metadata.
          const saved = JSON.stringify(turn.response ?? []).split(KIMI_LIFECYCLE_REPLY).length - 1;
          assert.equal(saved, 1);
          return 'saved-transcript';
        }, 'one unbroken JSON reply reaches the retained Code workbench', 50_000);
      }
      await sleep(1600); // Copilot's retry delay is one second; keep the fixture observable after release.
      assert.equal(calls().length, 1, 'no duplicate Kimi inference');
      results.push({ mode, calls: calls().length, jsonReply: calls()[0].jsonReply, backgroundVisibility, replyEvidence, reloadEvidence });
      console.log('PASS', mode, 'one Kimi JSON inference',
        mode === 'full-reload' ? 'saved interruption' : 'one reply via ' + replyEvidence);
    } catch (error) {
      mkdirSync(out, { recursive: true });
      await page?.screenshot({ path: join(out, mode + '-failure.png'), timeout: 5000 }).catch(() => {});
      throw error;
    } finally {
      if (!released) release(marker);
      await context.close();
    }
  }
} finally {
  await browser.close();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'kimi-lifecycle-checks.json'), JSON.stringify(results, null, 2) + '\n');
}
