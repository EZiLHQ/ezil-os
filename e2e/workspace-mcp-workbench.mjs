// Drive the real Code MCP client against the packaged extension on an isolated network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const { chromium } = createRequire(process.env.PLAYWRIGHT_REQUIRE_DIR + '/workspace-test.cjs')('playwright');
const [container, address] = process.argv.slice(2);
const inside = (...args) => execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const forward = net.createServer(client => {
  const remote = net.connect(8443, address);
  client.pipe(remote).pipe(client);
  remote.on('error', () => client.destroy());
  client.on('error', () => remote.destroy());
});
const sockets = new Set();
forward.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise(resolve => forward.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + forward.address().port;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const widget = page.locator('.quick-input-widget:visible').first();
  const rows = widget.locator('.monaco-list-row:visible');

  async function command(label) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('F1');
    await widget.locator('input').first().fill('>' + label);
    await rows.filter({ hasText: label }).filter({ hasNotText: 'Ask in Chat' }).first().click();
    await page.waitForTimeout(900);
  }

  async function list() {
    await command('MCP: List Servers');
    const text = await widget.innerText();
    await page.keyboard.press('Escape');
    return text;
  }

  async function grant() {
    await command('Attach Workspace MCP');
    await page.getByRole('button', { name: 'Attach for this window', exact: true }).click();
  }

  async function readFixtureFile(filename) {
    for (let attempt = 0; attempt < 80; attempt++) {
      try { return inside('cat', filename); }
      catch { await delay(250); }
    }
    throw new Error('Timed out waiting for ' + filename);
  }

  async function probe() {
    const file = '/tmp/workspace-info-probe.json';
    inside('rm', '-f', file);
    await command('QA: Invoke workspace_info');
    return JSON.parse(await readFixtureFile(file));
  }

  async function check(label, operation) {
    await operation();
    console.log('PASS ' + label);
  }

  await page.goto(origin + '/?folder=/tmp/owned-workspace', { waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-workbench').waitFor();
  await check('fresh Code window has no workspace MCP server', async () => assert.doesNotMatch(await list(), /EZiL Workspace/));
  await grant();
  await command('MCP: List Servers');
  await rows.filter({ hasText: 'EZiL Workspace' }).click();
  await rows.filter({ hasText: 'Start Server' }).click();
  await page.getByText(/Discovered\s+1\s+tools?/).first().waitFor({ timeout: 30000 });
  await check('the Code client invokes workspace_info', async () => {
    const receipt = await probe();
    assert.equal(receipt.available, true);
    assert.deepEqual(JSON.parse(receipt.text).entries, [{ name: 'Owner.txt', kind: 'file' }]);
    console.log(receipt.tool, receipt.text);
  });
  await command('Detach Workspace MCP');
  await check('detach removes the server definition', async () => assert.doesNotMatch(await list(), /EZiL Workspace/));
  await check('the same client loses access to the tool', async () => assert.deepEqual(await probe(), { available: false }));
  await check('the owner Terminal still executes commands', async () => {
    await command('Terminal: Create New Terminal');
    await page.locator('.xterm-screen:visible').first().waitFor();
    await page.keyboard.type("printf 'owner-terminal' >/tmp/workspace-mcp-terminal-check");
    await page.keyboard.press('Enter');
    assert.equal(await readFixtureFile('/tmp/workspace-mcp-terminal-check'), 'owner-terminal');
  });
  await grant();
  await check('the owner can grant fresh access', async () => assert.match(await list(), /EZiL Workspace/));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.monaco-workbench').waitFor();
  await check('reloading Code clears the prior grant', async () => assert.doesNotMatch(await list(), /EZiL Workspace/));
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => forward.close(resolve));
}
