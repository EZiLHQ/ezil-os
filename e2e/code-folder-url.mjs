// code-folder-url.mjs — EZiL-authored. Code's folder in the address bar against REAL code-server (folder-url-sync,
// docs/APP-ROUTES.md §5 "Code's folder"): the editor of a desktop image, behind a stand-in for the Worker that
// injects the REAL bridge (worker/src/code-folder-bridge.ts) into the workbench document, framed by the REAL shell
// bundle. Drives VS Code's own File > Open Folder, Back/Forward, an edited file across switches, and a reload.
// Started by code-folder-url-image.sh (no network egress; no staging contact).
// Args: <code-server ip> <evidence dir>
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const [CS_IP, EVIDENCE] = process.argv.slice(2);
const TREE = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
const { chromium } = require('playwright');
const { injectCodeFolderBridge } = await import(`${TREE}/worker/src/code-folder-bridge.ts`);
const assets = `${TREE}/app/public/os/`;
mkdirSync(EVIDENCE, { recursive: true });
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
let checks = 0;
const ok = (cond, msg) => { log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (cond) checks += 1; else { writeFileSync(`${EVIDENCE}/code-folder-url.log`, lines.join('\n')); assert.fail(msg); } };

let shellOrigin = '', editorOrigin = '';
const asks = [];
const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const shell = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (b) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
  if (url.pathname.startsWith('/os/')) {
    const file = path.join(assets, url.pathname.slice(4));
    if (file.startsWith(assets) && existsSync(file) && statSync(file).isFile()) { res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream'); res.end(readFileSync(file)); return; }
    res.statusCode = 404; res.end(); return;
  }
  if (url.pathname === '/api/shell/code-preview-url') {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      asks.push(body.codeFolder ?? null);
      const folder = body.codeFolder?.path ?? '/workspace';
      // As the Worker after its walk (every seeded folder exists): the asked folder, else the default.
      json({ ok: true, codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=T&path=%2F&folder=${encodeURIComponent(folder)}`, ...(body.codeFolder ? { codeFolder: { v: 1, outcome: 'restored' } } : {}) });
    }); return;
  }
  if (url.pathname === '/api/shell/desktop') {
    if (url.searchParams.get('confirm') === 'frame') return json({ ok: true, confirmed: true, status: 200 });
    return json(req.method === 'POST' ? { ok: true, guacamoleUrl: `${shellOrigin}/blank`, frame: { confirmed: true } } : { ok: true, guacamoleRunning: true });
  }
  if (url.pathname.startsWith('/api/trpc/')) return json({ result: { data: { json: null } } });
  if (url.pathname.startsWith('/api/')) return json({ ok: true });
  if (url.pathname === '/blank') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>'); return; }
  if (url.pathname !== '/os' && !/^\/app\/[a-z0-9-]+$/.test(url.pathname)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><html><head><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
});
// The Worker stand-in: bootstrap redirect as the Worker's, the bridge into the workbench document, all else passed through.
let injected = 0;
const editor = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/preview-bootstrap') {
    const to = new URLSearchParams();
    if (url.searchParams.get('folder')) to.set('folder', url.searchParams.get('folder'));
    if (url.searchParams.get('ezil_mint')) to.set('ezil_mint', url.searchParams.get('ezil_mint'));
    res.writeHead(302, { location: `/?${to}` }); res.end(); return;
  }
  const headers = { ...req.headers };
  delete headers['accept-encoding'];
  const up = httpRequest({ host: CS_IP, port: 8443, method: req.method, path: req.url, headers }, (ur) => {
    const html = req.method === 'GET' && url.pathname === '/' && ur.statusCode === 200 && /text\/html/.test(ur.headers['content-type'] ?? '');
    if (!html) { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); return; }
    const chunks = []; ur.on('data', (c) => chunks.push(c)); ur.on('end', () => {
      const out = injectCodeFolderBridge(Buffer.concat(chunks).toString('utf8'), [shellOrigin]);
      if (out.includes('data-ezil-folder-bridge')) injected += 1;
      const h = { ...ur.headers }; delete h['content-length'];
      res.writeHead(ur.statusCode, h); res.end(out);
    });
  });
  up.on('error', () => { res.statusCode = 502; res.end(); });
  req.pipe(up);
});
editor.on('upgrade', (req, socket, head) => {
  const up = net.connect(8443, CS_IP, () => {
    up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
});
await new Promise((r) => shell.listen(0, '127.0.0.1', r));
await new Promise((r) => editor.listen(0, '127.0.0.1', r));
shellOrigin = `http://127.0.0.1:${shell.address().port}`;
editorOrigin = `http://localhost:${editor.address().port}`;

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  window.__EZIL_BOOT__ = { user: { id: '33333333-3333-4333-8333-333333333333', email: 'fixture@example.test' },
    computer: { id: '11111111-1111-4111-8111-111111111111', name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', ui: { floatingControls: false, feedbackScreenshots: false } } };
  history.replaceState({ ...history.state, __NA: true }, '', location.href);
});
const page = await context.newPage();
page.setDefaultTimeout(60_000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const dialogs = [];
page.on('dialog', (d) => { dialogs.push(d.type()); void d.accept(); });
const address = () => page.evaluate(() => location.pathname + location.search);
const waitAddress = (want, ms = 60_000) => page.waitForFunction((x) => location.pathname + location.search === x, want, { timeout: ms }).then(() => true, () => false);
const frame = () => page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(`${editorOrigin}/?`));
const frameFolder = () => new URLSearchParams(new URL(frame()?.url() ?? `${editorOrigin}/`).search).get('folder');
const waitFrameFolder = async (want, ms = 60_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (frameFolder() === want) return true; await page.waitForTimeout(200); } return false; };
const workbench = async () => { const f = frame(); await f.locator('.monaco-workbench').waitFor({ timeout: 90_000 }); await f.locator('.explorer-folders-view, .explorer-viewlet').first().waitFor({ timeout: 90_000 }).catch(() => {}); return f; };
const explorerTitle = async () => (await frame().locator('.pane-header[aria-label*="Explorer"], .explorer-folders-view').first().getAttribute('aria-label').catch(() => null)) ?? '';
const shot = (name) => page.screenshot({ path: `${EVIDENCE}/${name}.png` });

// 1. The link opens A in real code-server.
await page.goto(`${shellOrigin}/app/code?folder=${encodeURIComponent('/workspace/a')}`);
ok(await waitFrameFolder('/workspace/a', 120_000), 'link: real code-server opened /workspace/a');
let f = await workbench();
ok(injected >= 1, `the workbench document carried the bridge (${injected} injected)`);
ok(await waitAddress('/app/code?folder=/workspace/a'), `link: address ${await address()}`);
await page.waitForTimeout(2000);
await shot('01-link-a');
const len0 = await page.evaluate(() => history.length);

// 2. VS Code's own Open Folder (File > Open Folder…, the simple file dialog) to B.
async function openFolder (target) {
  const f = frame();
  await f.locator('.monaco-workbench').click({ position: { x: 700, y: 400 } }).catch(() => {});
  await page.keyboard.press('F1');
  const input = f.locator('.quick-input-widget input');
  await input.waitFor();
  await input.fill('>File: Open Folder');
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await input.fill(target.endsWith('/') ? target : `${target}/`);
  await page.waitForTimeout(800);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 3 && frameFolder() !== target; i += 1) {
    await page.waitForTimeout(1500);
    if (frameFolder() !== target && await f.locator('.quick-input-widget').isVisible().catch(() => false)) {
      // The dialog may first navigate into the folder; OK accepts it.
      const okButton = f.locator('.quick-input-widget .monaco-button', { hasText: /^OK$/ }).first();
      if (await okButton.count()) await okButton.click().catch(() => {}); else await page.keyboard.press('Enter');
    }
  }
}
await openFolder('/workspace/b');
ok(await waitFrameFolder('/workspace/b', 90_000), `switch: VS Code itself opened /workspace/b [frame ${frameFolder()}]`);
ok(await waitAddress('/app/code?folder=/workspace/b'), `switch: the address followed [${await address()}]`);
await workbench();
await page.waitForTimeout(1500);
const len1 = await page.evaluate(() => history.length);
ok(len1 === len0 + 1, `switch: exactly one new entry [${len0} -> ${len1}]`);
await shot('02-open-folder-b');

// 3. Back/Forward restore both.
await page.goBack();
ok(await waitAddress('/app/code?folder=/workspace/a'), `back: address ${await address()}`);
ok(await waitFrameFolder('/workspace/a'), `back: real editor at ${frameFolder()}`);
await workbench(); await page.waitForTimeout(1500);
await shot('03-back-a');
await page.goForward();
ok(await waitAddress('/app/code?folder=/workspace/b'), `forward: address ${await address()}`);
ok(await waitFrameFolder('/workspace/b'), `forward: real editor at ${frameFolder()}`);
f = await workbench(); await page.waitForTimeout(1500);
await shot('04-forward-b');

// 4. An edited file survives a folder switch and the way back (code-server's own autosave/backup; the frame is
//    navigated, never removed). Quick Open notes.txt, type, wait for the editor, then Back and Forward.
await f.locator('.monaco-workbench').click({ position: { x: 700, y: 400 } }).catch(() => {});
await page.keyboard.press('Control+P');
await f.locator('.quick-input-widget input').fill('notes.txt');
await page.waitForTimeout(1000);
await page.keyboard.press('Enter');
await f.locator('.monaco-editor .view-lines').first().waitFor();
await f.locator('.monaco-editor .view-lines').first().click();
await page.keyboard.press('Control+End');
await page.keyboard.type(' edited-by-folder-url-test', { delay: 15 });
await page.waitForTimeout(3500); // past code-server's autosave delay / backup
await shot('05-edited-b');
const beforeDialogs = dialogs.length;
await page.goBack();
ok(await waitAddress('/app/code?folder=/workspace/a'), `edited: Back still restores the address [${await address()}] (dialogs: ${dialogs.slice(beforeDialogs).join(',') || 'none'})`);
ok(await waitFrameFolder('/workspace/a'), 'edited: and the editor');
await workbench(); await page.waitForTimeout(1500);
await page.goForward();
ok(await waitFrameFolder('/workspace/b'), 'edited: Forward returns to /workspace/b');
f = await workbench(); await page.waitForTimeout(2500);
await f.locator('.monaco-workbench').click({ position: { x: 700, y: 400 } }).catch(() => {});
await page.keyboard.press('Control+P');
await f.locator('.quick-input-widget input').fill('notes.txt');
await page.waitForTimeout(1000);
await page.keyboard.press('Enter');
await f.locator('.monaco-editor .view-lines').first().waitFor();
await page.waitForTimeout(1500);
const text = await f.locator('.monaco-editor .view-lines').first().innerText();
ok(text.includes('edited-by-folder-url-test'), `edited: the edit is still there after Back and Forward [${JSON.stringify(text.slice(0, 120))}]`);
await shot('06-edit-survived');

// 5. Reload keeps B (the address asks the mint for it).
const asksBefore = asks.length;
await page.reload();
ok(await waitFrameFolder('/workspace/b', 120_000), 'reload: real code-server reopened /workspace/b');
ok(asks.length === asksBefore + 1 && asks.at(-1)?.path === '/workspace/b', `reload: the mint asked for /workspace/b [${JSON.stringify(asks.at(-1))}]`);
await workbench(); await page.waitForTimeout(1500);
await shot('07-reload-b');
ok(errors.length === 0, `no uncaught shell page errors [${errors.join(' | ')}]`);
log(`PASS ${checks} checks: real code-server 4.141 (live image) + Worker bridge + real shell bundle`);
writeFileSync(`${EVIDENCE}/code-folder-url.log`, lines.join('\n'));
await browser.close(); shell.close(); editor.close();
