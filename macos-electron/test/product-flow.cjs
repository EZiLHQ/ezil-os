'use strict';
// Real product inputs only. No host bridge calls, replacement frames, DOM
// mutations, clipboard shortcuts, injected source edits, or console dumps.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { execFile, execFileSync } = require('node:child_process');
const { Workspaces } = require('../src/workspaces.cjs');
const { developmentEnvironment } = require('../src/development-environment.cjs');
const { nativeButtonScript, assertNativeSession, DOWNLOAD } = require('./product-flow-helpers.cjs');
const READY = 30000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = path.join(__dirname, 'fixtures/web-project');
const sourceText = marker => `export const message: string = '${marker}';\n`;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const report = { version: 1, success: false, checks: [], limitations: ['Native folder picker, app restart, external VS Code, and Xcode execution are not tested by this harness.', 'Upload uses the real file input and Playwright filechooser selection; native upload-picker keyboard navigation is not tested.'] };
let evidence, electronApp, shellPage, codeFrame, terminal, project, activeStep = 'preflight';
function required(key) {
  const value = process.env[key];
  if (!value || !path.isAbsolute(value) || value.includes('\0')) throw Error('invalid_configuration');
  return value;
}
function emptyDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw Error('directory_not_empty');
  return fs.realpathSync(dir);
}
async function until(check) {
  const end = Date.now() + READY;
  do { try { const result = await check(); if (result) return result; } catch { /* UI may still be loading. */ } await sleep(150); } while (Date.now() < end);
  throw Error('readiness_timeout');
}
async function step(id, action) {
  activeStep = id; const started = Date.now(); await action();
  report.checks.push({ id, status: 'passed', durationMs: Date.now() - started });
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
}
async function dock(app) {
  await shellPage.locator(`.taskbar-item[data-app="${app}"]`).click();
  const win = shellPage.locator(`.window[data-app="${app}"]`).last();
  await win.waitFor({ state: 'visible' }); return win;
}
async function minimize(app) {
  await shellPage.locator(`.window[data-app="${app}"] > .window-head > .window-minimize-btn`).last().click();
}
async function palette(command) {
  await codeFrame.locator('body').press('Meta+Shift+p');
  const input = codeFrame.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible' }); await input.fill(`>${command}`);
  await codeFrame.locator('.quick-input-list .monaco-list-row').filter({ hasText: command }).first().waitFor({ state: 'visible' });
  await input.press('Enter'); await input.waitFor({ state: 'hidden' });
}
async function edit(marker) {
  const source = codeFrame.getByRole('treeitem', { name: 'src', exact: true });
  await source.waitFor({ state: 'visible' });
  if (await source.getAttribute('aria-expanded') !== 'true') await source.click();
  await codeFrame.getByRole('treeitem', { name: 'message.ts', exact: true }).dblclick();
  const editor = codeFrame.locator('.editor-instance .monaco-editor .view-lines').first();
  await editor.waitFor({ state: 'visible' }); await editor.click({ position: { x: 12, y: 8 } });
  await shellPage.keyboard.press('Meta+a'); await shellPage.keyboard.insertText(sourceText(marker)); await shellPage.keyboard.press('Meta+s');
  await until(() => fs.readFileSync(path.join(project.files, 'src/message.ts'), 'utf8') === sourceText(marker));
}
async function terminalCommand(command) {
  await terminal.focus(); await shellPage.keyboard.insertText(command); await shellPage.keyboard.press('Enter');
}
async function screenshot(name, page = shellPage) {
  await page.screenshot({ path: path.join(evidence, `${name}.png`), timeout: READY });
}
function nativeButton(label, seconds = 45) {
  return new Promise(resolve => execFile('/usr/bin/osascript', ['-e', nativeButtonScript(electronApp.process().pid, label, seconds)],
    { timeout: (seconds + 5) * 1000 }, (error, stdout, stderr) => resolve({ clicked: !error && stdout.trim() === 'clicked',
      ...(error ? { error: error.killed ? 'automation_timeout' : 'accessibility_or_dialog_failed', code: String(error.code ?? '').slice(0, 40), detail: String(stderr || '').slice(0, 600) } : {}) })));
}
function nativeShortcut(action, point) {
  assertNativeSession(execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 5000 }));
  const pid = electronApp.process().pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  const command = { address: 'keystroke "l" using command down', interrupt: 'keystroke "c" using control down' }[action];
  assert.ok(command);
  if (point) assert.ok(Number.isSafeInteger(point.x) && Number.isSafeInteger(point.y));
  // CDP key events do not exercise Electron's before-input-event bridge.
  // Send the real macOS shortcut only to this test application's process.
  execFileSync('/usr/bin/osascript', ['-e', `tell application "System Events"
tell first application process whose unix id is ${pid}
set frontmost to true
delay 0.15
${point ? `click at {${point.x}, ${point.y}}\ndelay 0.15` : ''}
${command}
end tell
end tell`], { timeout: 5000 });
}
async function interruptTerminal() {
  const win = await dock('code');
  if (await win.getAttribute('data-is_maximized') !== '1') await win.locator('.window-scale-btn').click();
  terminal = codeFrame.locator('textarea.xterm-helper-textarea').first();
  const screen = codeFrame.locator('.xterm-screen:visible').first();
  await screen.waitFor({ state: 'visible' });
  // Maximizing animates shell geometry. Native screen clicks must use settled
  // coordinates, not the pre-animation position returned immediately by click().
  let previous, stableSince = Date.now();
  const box = await until(async () => {
    const value = await screen.boundingBox();
    if (!value || value.height <= 0) return false;
    const next = JSON.stringify(value);
    if (next !== previous) { previous = next; stableSince = Date.now(); return false; }
    return Date.now() - stableSince >= 300 ? value : false;
  });
  const hostWindow = await electronApp.browserWindow(shellPage);
  const geometry = await hostWindow.evaluate(win => ({ bounds: win.getContentBounds(), zoom: win.webContents.getZoomFactor() }));
  // Physical input establishes the native WebContents focus as a user click
  // would. DOM focus/CDP key delivery alone does not prove that OS focus moved
  // away from the previous Chromium child view.
  nativeShortcut('interrupt', { x: Math.round(geometry.bounds.x + (box.x + Math.min(20, box.width / 2)) * geometry.zoom),
    y: Math.round(geometry.bounds.y + (box.y + Math.min(20, box.height / 2)) * geometry.zoom) });
}
async function unusedPort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function run() {
  evidence = emptyDirectory(required('EZIL_E2E_EVIDENCE'));
  const executablePath = fs.realpathSync(required('EZIL_E2E_EXECUTABLE'));
  const appRoot = fs.realpathSync(required('EZIL_E2E_APP_ROOT'));
  const dataRoot = emptyDirectory(required('EZIL_E2E_DATA_ROOT'));
  const original = fs.realpathSync(required('EZIL_E2E_PROJECT_ROOT'));
  const kind = process.env.EZIL_E2E_KIND || 'attached';
  assert.ok(['managed', 'attached'].includes(kind)); report.kind = kind;
  // Coordinator supplies a disposable copy with dependencies already installed.
  for (const file of ['package.json', 'index.html', 'second.html', 'tsconfig.json', 'src/main.ts', 'src/message.ts']) {
    assert.equal(fs.readFileSync(path.join(original, file), 'utf8'), fs.readFileSync(path.join(fixture, file), 'utf8'));
  }
  assert.notEqual(original, fs.realpathSync(fixture));
  assert.ok(!fs.readdirSync(original).some(file => file.startsWith('.e2e-')));
  assert.ok(fs.existsSync(path.join(original, 'node_modules/vite/package.json')));
  const { _electron } = require('playwright-core');
  assert.equal(require('playwright-core/package.json').version, '1.62.1');
  const store = new Workspaces(dataRoot); store.guest();
  const managed = store.create('E2E managed', fixture), attached = store.attach('E2E attached', original);
  // Only fixture setup bypasses UI. Runtime edits below must come from Code.
  fs.symlinkSync(path.join(original, 'node_modules'), path.join(managed.files, 'node_modules'), 'dir');
  project = kind === 'managed' ? managed : attached;
  // Disposable fixture setup only: routes run inside the user's terminal Vite
  // process. No browser request interception or runtime DOM/source injection.
  fs.copyFileSync(path.join(__dirname, 'product-flow-helpers.cjs'), path.join(project.files, '.e2e-product-server.cjs'));
  fs.writeFileSync(path.join(project.files, '.e2e-vite.config.mjs'), `import { createRequire } from 'node:module';\nconst harness = createRequire(import.meta.url)('./.e2e-product-server.cjs');\nexport default {plugins:[{name:'ezil-acceptance',configureServer(server){server.middlewares.use(harness.middleware(process.cwd()));}}]};\n`);
  fs.writeFileSync(path.join(project.files, '.e2e-upload.txt'), 'EZIL_BROWSER_UPLOAD\n');
  store.index.activeID = project.id; store.save();
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const isolatedHome = path.join(dataRoot, 'test-home'); fs.mkdirSync(isolatedHome);
  await step('launch_and_shell_ready', async () => {
    const packaged = appRoot.endsWith('.app');
    const resources = packaged ? path.join(appRoot, 'Contents/Resources') : path.dirname(appRoot);
    const env = { ...developmentEnvironment(resources), HOME: isolatedHome, EZIL_NATIVE_APP_DATA: dataRoot };
    // Explicit local development executables only; never inherit provider env.
    for (const key of ['EZIL_BUN_PATH', 'EZIL_HELPER_PATH', 'EZIL_NATIVE_RESOURCES', 'EZIL_SHELL_ASSETS']) if (process.env[key]) env[key] = required(key);
    env.EZIL_NATIVE_SKIP_LEGACY = '1';
    electronApp = await _electron.launch({ executablePath, args: packaged ? [] : [appRoot], env, timeout: READY });
    assert.equal(await electronApp.evaluate(({ app }) => app.isPackaged), packaged, 'application runtime mode must match its distribution');
    shellPage = await electronApp.firstWindow();
    report.rendererErrors = [];
    shellPage.on('pageerror', error => { if (report.rendererErrors.length < 6) report.rendererErrors.push(error.message.slice(0, 240)); });
    shellPage = await until(async () => {
      for (const page of electronApp.windows()) if (await page.locator('.taskbar-item[data-app="code"]').isVisible()) return page;
    });
    shellPage.setDefaultTimeout(READY); shellPage.setDefaultNavigationTimeout(READY);
  });
  await step('browser_and_code_dock', async () => {
    await dock('desktop'); await shellPage.getByRole('textbox', { name: 'Browser address' }).waitFor({ state: 'visible' }); await minimize('desktop');
    const win = await dock('code');
    const iframe = await win.locator('iframe.window-app-iframe').elementHandle();
    codeFrame = await until(async () => { const frame = await iframe.contentFrame(); return frame && await frame.locator('.monaco-workbench').isVisible() ? frame : null; });
    const trust = codeFrame.getByRole('button', { name: /Yes, I trust the authors/ });
    if (await trust.isVisible()) await trust.click();
    const manageTrust = codeFrame.locator('a[href="command:workbench.trust.manage"]').first();
    try { await manageTrust.waitFor({ state: 'visible', timeout: 5000 }); } catch { /* Already trusted folders omit the banner. */ }
    if (await manageTrust.isVisible()) {
      await manageTrust.click();
      await codeFrame.getByRole('button', { name: 'Trust', exact: true }).click();
      await codeFrame.getByText('You trust this folder', { exact: true }).waitFor();
      await codeFrame.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).click();
    }
    await edit('EZIL_SAVED'); await screenshot('code-saved');
  });
  await step('terminal_node_bun_build', async () => {
    await palette('Terminal: Create New Terminal');
    const trust = codeFrame.getByRole('button', { name: 'Trust Folder & Continue', exact: true });
    terminal = codeFrame.locator('textarea.xterm-helper-textarea').first();
    await until(async () => {
      if (await trust.isVisible()) await trust.click();
      if (!await terminal.count()) return false;
      const label = await terminal.getAttribute('aria-label');
      return !label.includes('environment is stale') && /, (?:zsh|bash)/.test(label)
        && await codeFrame.locator('.xterm-decoration.terminal-command-decoration').count() > 0;
    });
    report.terminalInputs = await codeFrame.evaluate(() => [...document.querySelectorAll('textarea, [contenteditable="true"]')].map(el => ({ tag: el.tagName, class: el.className, label: el.getAttribute('aria-label') })));
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    terminal = codeFrame.locator('textarea.xterm-helper-textarea').first();
    await terminal.waitFor({ state: 'attached' });
    await terminalCommand(`cd ${quote(project.files)} && node --version > .e2e-node && bun --version > .e2e-bun && command -v npm > .e2e-npm && npm run build > .e2e-build-log 2>&1; printf '%s' "$?" > .e2e-build-exit`);
    await until(() => fs.existsSync(path.join(project.files, '.e2e-build-exit')));
    assert.equal(fs.readFileSync(path.join(project.files, '.e2e-build-exit'), 'utf8'), '0', 'terminal_build_failed');
    for (const file of ['.e2e-node', '.e2e-bun']) assert.match(fs.readFileSync(path.join(project.files, file), 'utf8').trim(), /^v?\d+\.\d+\.\d+/);
    assert.ok(fs.existsSync(path.join(project.files, 'dist/index.html'))); await screenshot('terminal-build');
  });
  if (process.env.EZIL_E2E_EXTENSION_DIAGNOSTICS === '1') await step('connector_extension_ui', async () => {
    await palette('Extensions: Show Installed Extensions');
    await codeFrame.getByText('EZiL OS Native Connector', { exact: true }).first().click();
    await screenshot('connector-details');
    report.extensionDetails = (await codeFrame.locator('.extension-editor').innerText()).slice(0, 7000);
    await palette('Terminal: Focus Terminal');
  });
  await step('terminal_dev_server', async () => {
    await palette('Terminal: Focus Terminal');
    await terminalCommand(`npm run dev -- --port ${port} --strictPort --config .e2e-vite.config.mjs`);
    await until(async () => { const response = await fetch(origin, { signal: AbortSignal.timeout(1000) }); return response.ok; });
    await minimize('code');
  });
  if (process.env.EZIL_E2E_EXTENSION_DIAGNOSTICS === '1') await step('connector_editor_command', async () => {
    await dock('code');
    await palette('Workspaces: Manage Workspace Trust');
    report.trustDetails = (await codeFrame.locator('.workspace-trust-editor').innerText()).slice(0, 5000);
    await screenshot('workspace-trust');
    await codeFrame.getByRole('button', { name: 'Close Modal Editor (Escape)', exact: true }).click();
    await codeFrame.locator('.workspace-trust-editor').waitFor({ state: 'hidden' });
    await palette('EZiL: Register Loopback Preview Port');
    const input = codeFrame.locator('.quick-input-widget input');
    await input.waitFor({ state: 'visible' }); await input.fill(String(port)); await input.press('Enter');
    await screenshot('connector-command'); await minimize('code');
  });
  await step('browser_url_links_history', async () => {
    const win = await dock('desktop'); const address = win.getByRole('textbox', { name: 'Browser address' });
    await address.fill(origin); await address.press('Enter');
    // WebContentsView is a real Chromium target, never a replacement iframe.
    const browser = await until(() => electronApp.context().pages().find(page => page.url().startsWith(origin + '/')));
    browser.setDefaultTimeout(READY);
    await browser.locator('#message').filter({ hasText: /^EZIL_SAVED$/ }).waitFor();
    await browser.locator('#next').click(); await until(() => browser.url() === `${origin}/second.html`);
    await win.locator('[data-action="back"]').click(); await until(() => browser.url() === `${origin}/`);
    await win.locator('[data-action="forward"]').click(); await until(() => browser.url() === `${origin}/second.html`);
    await browser.locator('#home').click(); await until(() => browser.url() === `${origin}/`);
    await screenshot('browser-shell'); await screenshot('browser-content', browser); await minimize('desktop');
  });
  await step('browser_keyboard_upload_download', async () => {
    const win = await dock('desktop'), address = win.getByRole('textbox', { name: 'Browser address' });
    await address.fill(`${origin}/__ezil_input`); await address.press('Enter');
    const browser = await until(() => electronApp.context().pages().find(page => page.url() === `${origin}/__ezil_input`));
    const typing = browser.locator('#typing'); await typing.click(); await browser.keyboard.type('before-address');
    nativeShortcut('address');
    await until(() => address.evaluate(el => document.activeElement === el));
    await shellPage.keyboard.type('localhost:12345');
    assert.equal(await address.inputValue(), 'localhost:12345', 'address_shortcut_did_not_select');
    assert.equal(await typing.inputValue(), 'before-address', 'address_typing_leaked_to_page');
    await address.press('Escape'); await browser.keyboard.press('Meta+a'); await browser.keyboard.type('after-address');
    assert.equal(await typing.inputValue(), 'after-address');
    const chooser = browser.waitForEvent('filechooser'); await browser.locator('#upload').click();
    await (await chooser).setFiles(path.join(project.files, '.e2e-upload.txt'));
    await browser.locator('#upload-result').filter({ hasText: /^EZIL_BROWSER_UPLOAD\s*$/ }).waitFor();
    const downloadPath = path.join(project.files, 'Downloads/ezil-browser-download.txt');
    assert.equal(fs.existsSync(downloadPath), false, 'download_fixture_already_exists');
    const save = nativeButton('Save', 30);
    await browser.locator('#download').click();
    report.downloadDialog = await save; assert.equal(report.downloadDialog.clicked, true, 'native_download_save_not_confirmed');
    await until(() => fs.existsSync(downloadPath) && fs.readFileSync(downloadPath, 'utf8') === DOWNLOAD);
    await minimize('desktop'); await dock('desktop');
    await typing.click(); await typing.press('Meta+ArrowRight');
    await browser.keyboard.type('-restored'); assert.equal(await typing.inputValue(), 'after-address-restored');
    await screenshot('browser-file-inputs', browser); await minimize('desktop');
  });
  await step('slow_browser_navigation_keeps_shell_responsive', async () => {
    const win = await dock('desktop'), address = win.getByRole('textbox', { name: 'Browser address' });
    await address.fill(`${origin}/__ezil_slow`); await address.press('Enter');
    await until(() => fs.existsSync(path.join(project.files, '.e2e-slow-start')));
    const started = Date.now();
    await minimize('desktop'); await dock('settings'); await minimize('settings'); await dock('desktop');
    await address.click(); await shellPage.keyboard.press('Meta+a'); await shellPage.keyboard.type('localhost:23456');
    assert.equal(await address.inputValue(), 'localhost:23456');
    assert.equal(fs.existsSync(path.join(project.files, '.e2e-slow-end')), false, 'shell_actions_waited_for_navigation');
    report.slowNavigationInputMs = Date.now() - started;
    await address.press('Escape');
    await until(() => fs.existsSync(path.join(project.files, '.e2e-slow-end'))); await minimize('desktop');
  });
  let preview, documentId;
  await step('settings_register_preview', async () => {
    await screenshot('before-settings');
    const settings = await dock('settings'); await settings.locator('[data-tab="system"]').click();
    await settings.locator('#ezil-preview-port').fill(String(port)); await settings.getByRole('button', { name: 'Register preview', exact: true }).click();
    await settings.getByText(`Port ${port} is ready. Open Preview from the dock.`, { exact: true }).waitFor();
    await screenshot('settings-preview'); await minimize('settings');
    const win = await dock('preview'); const frame = await win.locator('iframe.window-app-iframe').elementHandle();
    preview = await until(async () => { const content = await frame.contentFrame(); return content && await content.locator('#message').textContent() === 'EZIL_SAVED' ? content : null; });
    documentId = await preview.locator('body').getAttribute('data-document-id'); assert.ok(documentId);
    await screenshot('preview-before'); await minimize('preview');
  });
  await step('source_save_and_hmr_without_reload', async () => {
    await dock('code'); await edit('EZIL_HMR'); await minimize('code'); await dock('preview');
    await preview.locator('#message').filter({ hasText: /^EZIL_HMR$/ }).waitFor();
    assert.equal(await preview.locator('body').getAttribute('data-document-id'), documentId);
    assert.equal(fs.readFileSync(path.join(project.files, 'src/message.ts'), 'utf8'), sourceText('EZIL_HMR'));
    if (kind === 'managed') assert.equal(fs.readFileSync(path.join(original, 'src/message.ts'), 'utf8'), sourceText('EZIL_INITIAL'));
    await screenshot('preview-hmr'); await minimize('preview');
  });
  await step('ten_code_close_reopen_cycles', async () => {
    for (let count = 0; count < 10; count++) {
      await dock('code');
      await shellPage.locator('.window[data-app="code"] > .window-head > .window-close-btn').click();
      await shellPage.locator('.window[data-app="code"]').waitFor({ state: 'detached' });
      assert.equal((await fetch(origin, { signal: AbortSignal.timeout(1000) })).status, 200);
      const win = await dock('code'), element = await win.locator('iframe.window-app-iframe').elementHandle();
      codeFrame = await until(async () => { const f = await element.contentFrame(); return f && await f.locator('.monaco-workbench').isVisible() ? f : null; });
    }
    terminal = codeFrame.locator('textarea.xterm-helper-textarea').first();
    await terminal.waitFor({ state: 'attached' });
    assert.equal(fs.readFileSync(path.join(project.files, 'src/message.ts'), 'utf8'), sourceText('EZIL_HMR'));
  });
  await step('stop_development_server', async () => {
    await interruptTerminal();
    await until(async () => { try { await fetch(origin, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
  });
  await step('preview_stop_restart_recovery', async () => {
    await minimize('code'); await dock('preview');
    // Reopen through the dock while stopped: cached DOM/HMR content must not
    // stand in for an authoritative readiness check.
    await shellPage.locator('.window[data-app="preview"] > .window-head > .window-close-btn').click();
    await shellPage.locator('.window[data-app="preview"]').waitFor({ state: 'detached' });
    const win = await dock('preview'); await win.getByRole('button', { name: 'Try again', exact: true }).waitFor({ state: 'visible' });
    await minimize('preview'); await dock('code'); await palette('Terminal: Focus Terminal');
    terminal = codeFrame.locator('textarea.xterm-helper-textarea').first();
    await terminalCommand(`npm run dev -- --port ${port} --strictPort --config .e2e-vite.config.mjs`);
    await until(async () => (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok);
    await minimize('code');
    const settings = await dock('settings'); await settings.locator('[data-tab="system"]').click();
    await settings.locator('#ezil-preview-port').fill(String(port)); await settings.getByRole('button', { name: 'Register preview', exact: true }).click();
    await settings.getByText(`Port ${port} is ready. Open Preview from the dock.`, { exact: true }).waitFor(); await minimize('settings');
    const reopened = await dock('preview'); await reopened.getByRole('button', { name: 'Try again', exact: true }).click();
    const element = await reopened.locator('iframe.window-app-iframe').elementHandle();
    preview = await until(async () => { const frame = await element.contentFrame(); return frame && await frame.locator('#message').textContent() === 'EZIL_HMR' ? frame : null; });
    assert.notEqual(await preview.locator('body').getAttribute('data-document-id'), documentId);
    await screenshot('preview-restarted');
    await minimize('preview'); await dock('code'); await palette('Terminal: Focus Terminal');
    await interruptTerminal();
    await until(async () => { try { await fetch(origin, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
  });
  report.success = true;
}
async function cleanup() {
  if (!electronApp) return;
  // Native confirmation is OS UI, outside Chromium. Only click the fixed quit
  // button in our launched PID; Accessibility permission is needed on macOS.
  const child = electronApp.process(), pid = child.pid;
  const dialog = nativeButton('Stop workspace', 45);
  let timer;
  try {
    await Promise.race([electronApp.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('quit_timeout')), 55000); })]);
    report.quitDialog = await dialog;
    assert.equal(report.quitDialog.clicked, true, 'native_quit_confirmation_not_observed');
    const events = JSON.parse(fs.readFileSync(path.join(required('EZIL_E2E_DATA_ROOT'), 'diagnostics.json'))).events;
    assert.ok(!events.some(event => event.code === 'WORKSPACE_CLEANUP_FAILED'), 'workspace cleanup reported an incomplete shutdown');
    report.cleanup = 'closed';
  } catch {
    report.cleanup = 'quit_failed'; report.success = false;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // No broad PID/name matching, and no claim of clean lifecycle acceptance.
    // Failed-run cleanup only, never lifecycle acceptance. Enumerate only
    // descendants of this test's live Electron PID before terminating it.
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([pid]);
    for (let i = 0; i < rows.length; i++) for (const [child, parent] of rows) if (owned.has(parent)) owned.add(child);
    for (const child of [...owned].reverse()) if (child !== pid) { try { process.kill(child, 'SIGTERM'); } catch {} }
    child.kill('SIGKILL');
  } finally { clearTimeout(timer); report.quitDialog = await dialog; }
}
if (require.main === module) {
  run().catch(async error => {
    report.success = false; report.checks.push({ id: activeStep, status: 'failed', code: error?.message === 'readiness_timeout' ? 'readiness_timeout' : 'flow_failed', detail: String(error?.message || '').slice(0, 800) });
    if (shellPage && evidence) await screenshot('failure').catch(() => {});
  }).finally(async () => {
    await cleanup();
    if (evidence) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify(report) + '\n'); process.exitCode = report.success ? 0 : 1;
  });
}
