// Exact-image e2e for Code sharing an existing desktop Chrome tab and sending
// browser tool calls through the EZiL Gemini 3.8 Flash gateway double.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR ? `${process.env.PLAYWRIGHT_REQUIRE_DIR}/` : import.meta.url);
const { chromium } = require('playwright');
const CODE_URL = process.env.EZIL_CODE_URL ?? 'http://127.0.0.1:18443';
const FOLDER = process.env.EZIL_E2E_FOLDER ?? '/home/neko/project';
const OUT = process.env.EZIL_E2E_OUT ?? './ezil-e2e-out/local-browser';
const CAPTURE_DIR = process.env.EZIL_E2E_CAPTURE_DIR ?? '/tmp/copilot-ezil-mock';
const CONTAINER = process.env.EZIL_E2E_CONTAINER;
const ORIGIN = 'http://localhost:5173';
const TAB_PATH = '/shared-test-app';
const DECOY_PATH = '/other-test-app';
const MODEL = 'gemini-3.8-flash';
const PROMPT = 'EZIL_E2E_BROWSER_LOCAL: Read the shared desktop browser tab, click the feedback button, and update the app label.';
const LOCAL_TOOLS = ['ezil_local_browser_read', 'ezil_local_browser_click'];
const APP_TOOLS = ['ezil_preview_read', 'ezil_preview_click'];

const APP = String.raw`
const fs = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const [folder, port] = process.argv.slice(1);
const server = createServer((req, res) => {
  res.setHeader('cache-control', 'no-store');
  if (req.url === '/live-label') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(fs.readFileSync(join(folder, 'existing.txt'), 'utf8').trim());
    return;
  }
  const label = req.url === '/shared-test-app' ? 'Send feedback' : 'Other tab control';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>Local browser test app</title><button id="feedback">' + label +
    '</button><output id="clicks">0</output><p id="live-label"></p><script>' +
    'document.querySelector("button").addEventListener("click", event => {' +
    'if (event.isTrusted) document.querySelector("#clicks").value++; });' +
    'async function update() { try { document.querySelector("#live-label").textContent = ' +
    'await (await fetch("/live-label")).text(); } finally { setTimeout(update, 250); } } update();</script>');
});
server.listen(Number(port), '127.0.0.1');
setTimeout(() => server.close(), 10 * 60_000).unref();
`;

// This CDP client runs inside the image and is used only to arrange and observe
// the fixture. Only Code's browser tool clicks the button.
const NATIVE_FIXTURE = String.raw`
const { chromium } = require('/opt/ezil-sidecar/node_modules/playwright-core');
const [mode, sharedUrl, decoyUrl] = process.argv.slice(1);
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  const context = browser.contexts()[0];
  if (!context || !context.pages().length) throw new Error('Desktop Chrome has no running tab');
  if (mode === 'open') {
    const other = context.pages().find(tab => tab.url() === decoyUrl) ?? await context.newPage();
    await other.goto(decoyUrl, { timeout: 8000 });
    const shared = context.pages().find(tab => tab.url() === sharedUrl) ?? await context.newPage();
    await shared.goto(sharedUrl, { timeout: 8000 });
    await shared.bringToFront();
  }
  async function state(url) {
    const page = context.pages().find(tab => tab.url() === url);
    if (!page) throw new Error('Missing native Chrome fixture tab at ' + url);
    return page.evaluate(() => ({
      visible: document.visibilityState === 'visible',
      clicks: Number(document.querySelector('#clicks').value),
      label: document.querySelector('#live-label').textContent,
    }));
  }
  console.log(JSON.stringify({ shared: await state(sharedUrl), other: await state(decoyUrl) }));
})().then(() => process.exit(0), error => { console.error(error.message); process.exit(1); });
`;

function inContainer(...args) {
  return execFileSync('docker', ['exec', CONTAINER, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
  });
}

function nativeState(mode = 'observe') {
  return JSON.parse(inContainer('node', '-e', NATIVE_FIXTURE, '--', mode, ORIGIN + TAB_PATH, ORIGIN + DECOY_PATH));
}

const captures = () => JSON.parse(inContainer('cat', join(CAPTURE_DIR, 'captured.json')));
let captureStart = 0;
function messages(prompt) {
  return captures().filter(record => record.n > captureStart &&
    record.path === '/ai/v1/messages' && record.body?.tools?.length &&
    record.body.messages.some(turn => turn.role === 'user' && JSON.stringify(turn.content).includes(prompt)));
}

async function waitFor(label, test, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await test();
    if (value) return value;
    await delay(300);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + label);
}

function offered(record) {
  return record.body.tools.map(tool => tool.name);
}

async function command(page, title) {
  await page.keyboard.press('F1');
  const palette = page.locator('.quick-input-widget input.input');
  await palette.fill('>' + title);
  await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: title }).first().click();
}

async function send(page, prompt) {
  const input = page.locator('.part.auxiliarybar .chat-input-container .monaco-editor .view-lines').first();
  await input.click();
  await page.keyboard.insertText(prompt);
  await page.keyboard.press('Enter');
}

async function waitForBrowserToolPicker(page, available) {
  // The picker snapshots the currently available tools when opened. Reopen it
  // until VS Code's coalesced update has observed the share or revocation.
  await waitFor(available ? 'the browser tools in the picker' : 'the picker to remove the browser tools', async () => {
    await page.getByRole('button', { name: /Configure Tools/i }).first().click();
    await page.getByText('Built-In', { exact: true }).first().waitFor({ timeout: 10_000 });
    const visible = await page.getByText('EZiL Models', { exact: true }).first().isVisible();
    await page.keyboard.press('Escape');
    return visible === available;
  }, 15_000);
}

async function confirmBrowserClick(page) {
  const confirmation = page.locator('.chat-confirmation-widget-container, .chat-confirmation-widget2')
    .filter({ hasText: 'Click in the shared local browser' }).last();
  await confirmation.waitFor({ timeout: 30_000 });
  assert.equal(nativeState().shared.clicks, 0, 'the native tab was not clicked before confirmation');
  await confirmation.getByRole('button', { name: /^(Allow|Continue|Confirm|Run)\b/i }).first().click();
}

function assertNoBrowserTools(requests) {
  assert.ok(requests.length, 'the Agent prompt reached the gateway');
  for (const request of requests) {
    assert.equal(request.authorized, true);
    assert.equal(request.body.model, MODEL);
    assert.ok(!offered(request).some(name => [...LOCAL_TOOLS, ...APP_TOOLS].includes(name)));
  }
}

let browser;
let page;
const checks = [];
function passed(check) {
  checks.push({ check, ok: true });
  console.log('PASS  local browser: ' + check);
}

mkdirSync(OUT, { recursive: true });
try {
  assert.ok(CONTAINER, 'EZIL_E2E_CONTAINER is required');
  captureStart = captures().at(-1)?.n ?? 0;
  execFileSync('docker', ['exec', '-d', CONTAINER, 'node', '-e', APP, FOLDER, '5173'], { timeout: 10_000 });
  await waitFor('the localhost test app and native Chrome', () => {
    try {
      return inContainer('curl', '--silent', '--fail', '--max-time', '1', ORIGIN + '/live-label').trim() === 'before'
        && inContainer('curl', '--silent', '--fail', '--max-time', '1', 'http://127.0.0.1:9222/json/version').length > 0;
    } catch { return false; }
  });
  assert.equal(nativeState('open').shared.visible, true, 'the test app is visible in the running desktop Chrome');
  await waitFor('the initial app label', () => nativeState().shared.label === 'before');

  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => {
    return new URL(route.request().url()).origin === new URL(CODE_URL).origin ? route.continue() : route.abort();
  });
  page = await context.newPage();
  await page.goto(`${CODE_URL}/?folder=${encodeURIComponent(FOLDER)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.part.auxiliarybar .action-label[aria-label="Models, Gemini 3.8 Flash"]').first().waitFor({ timeout: 90_000 });

  const preflight = 'EZIL_E2E_KIMI browser scope before sharing';
  await send(page, preflight);
  await page.getByText(/EZIL_KIMI_OK/).first().waitFor({ timeout: 30_000 });
  assertNoBrowserTools(messages(preflight));
  passed('the default Gemini 3.8 Flash turn has no browser tools before sharing');

  await command(page, 'Share Local Browser with Agent');
  await page.locator('.quick-input-widget .monaco-list-row').filter({ hasText: ORIGIN }).filter({ hasText: TAB_PATH }).click();
  await page.getByRole('button', { name: 'Share tab', exact: true }).click();
  await page.getByText(`Local browser shared for ${ORIGIN}.`, { exact: true }).first().waitFor({ timeout: 20_000 });
  await waitForBrowserToolPicker(page, true);
  passed('the user explicitly shares the visible localhost tab from Code');

  await send(page, PROMPT);
  await confirmBrowserClick(page);
  await page.getByText(/EZIL_BROWSER_DONE/).first().waitFor({ timeout: 60_000 });
  const turns = messages(PROMPT);
  assert.ok(turns.length >= 4, 'separate read, click, edit and final gateway turns');
  for (const request of turns) {
    assert.equal(request.authorized, true);
    assert.equal(request.body.model, MODEL);
    assert.ok(LOCAL_TOOLS.every(name => offered(request).includes(name)), 'the scoped browser tools are offered');
    assert.ok(APP_TOOLS.every(name => !offered(request).includes(name)), 'the unshared App Preview tools stay hidden');
  }
  const toolResults = turns.flatMap(record => record.body.messages.flatMap(turn => typeof turn.content === 'string' ? [] : turn.content))
    .filter(block => block.type === 'tool_result');
  for (const id of ['ezil_browser_read', 'ezil_browser_click', 'ezil_browser_edit']) {
    assert.ok(toolResults.some(block => block.tool_use_id === id && !block.is_error), `gateway received successful ${id} result`);
  }
  const read = JSON.stringify(toolResults.find(block => block.tool_use_id === 'ezil_browser_read').content);
  assert.match(read, /Send feedback/);
  assert.doesNotMatch(read, /Other tab control/);
  assert.match(JSON.stringify(toolResults.find(block => block.tool_use_id === 'ezil_browser_click').content), /Clicked the shared tab/);
  passed('Gemini gateway turns use the shared browser tools and receive read, click and edit results');

  assert.equal(inContainer('cat', join(FOLDER, 'existing.txt')), 'after browser feedback\n');
  const state = await waitFor('updated app label in native Chrome', () => {
    const current = nativeState();
    return current.shared.label === 'after browser feedback' && current;
  });
  assert.equal(state.shared.clicks, 1, 'the approved click reached the original native tab once');
  assert.equal(state.other.clicks, 0, 'the other native tab was not clicked');
  passed('the original native tab receives one trusted click and displays the saved source edit');

  await command(page, 'Stop Sharing Local Browser');
  await waitForBrowserToolPicker(page, false);
  const revoked = 'EZIL_E2E_KIMI browser scope after revocation';
  await send(page, revoked);
  const after = await waitFor('a gateway turn after revocation', () => {
    const requests = messages(revoked);
    return requests.length ? requests : false;
  });
  assertNoBrowserTools(after);
  passed('stopping the share removes the browser tools from the next agent turn');
} catch (error) {
  console.error(error);
  checks.push({ check: error.message, ok: false });
  if (page) await page.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  writeFileSync(join(OUT, 'checks.json'), JSON.stringify(checks, null, 2) + '\n');
}
