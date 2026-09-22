'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const { Workspaces } = require('./workspaces.cjs');
const { atomic, privateDir } = require('./files.cjs');
const { discover, cleanEnvironment } = require('./vscode.cjs');
const { workspaceStatus } = require('./helper.cjs');
const { once } = require('node:events');
function scriptLiteral(value) {
  return JSON.stringify(value).replace(/[<>\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function providerFixtures(input) {
  if (!input) throw Error('Explicit provider fixture required');
  const file = path.resolve(input);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768 || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw Error('Invalid provider fixture file');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Object.keys(value).sort().join(',') !== 'azure,bedrock') throw Error('Both provider fixtures are required');
  return [value.azure, value.bedrock];
}
async function proveProvider(vault, broker, config, fetchImpl = fetch) {
  vault.set(config);
  const descriptor = JSON.parse(fs.readFileSync(broker.descriptor, 'utf8'));
  const headers = { authorization: `Bearer ${descriptor.capability}` };
  const models = await fetchImpl(`${descriptor.url}/v1/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  assert.equal(models.ok, true); const listed = await models.json();
  const model = config.deployment || config.model; assert.deepEqual(listed.models, [model]);
  const chat = await fetchImpl(`${descriptor.url}/v1/chat`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(70_000),
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 8 }) });
  assert.equal(chat.ok, true); assert.ok((await chat.arrayBuffer()).byteLength > 0);
}
async function run(host) {
  const { app, dataRoot, store, editors, embedded, vault, broker, openWorkspace, getHost, getDesktop, closeWorkspace } = host;
  const evidenceRoot = privateDir(path.join(dataRoot, 'evidence'));
  const report = { version: 1, artifactSHA256: process.env.EZIL_ARTIFACT_SHA256, arch: process.arch, checks: [], optional: { providers: 'not-requested', externalVSCode: 'not-requested', xcode: 'unavailable', metal: 'unavailable', cloud: 'not-requested' }, success: false };
  let server; const sockets = new Set();
  const check = name => report.checks.push({ name, passed: true });
  try {
    assert.match(report.artifactSHA256 || '', /^[a-f0-9]{64}$/); assert.equal(process.arch, 'arm64'); assert.equal(process.platform, 'darwin');
    const guest = store.guest(); assert.equal(new Workspaces(dataRoot).guest().id, guest.id);
    const workspace = store.create('Offline guest smoke');
    fs.writeFileSync(path.join(workspace.files, 'build.ts'), 'await Bun.write("built.txt", "native-arm64-build");\n');
    const bun = path.join(process.resourcesPath, 'bun', 'bun');
    execFileSync(bun, ['--no-env-file', path.join(workspace.files, 'build.ts')], { cwd: workspace.files, env: cleanEnvironment(), stdio: 'ignore' });
    assert.equal(fs.readFileSync(path.join(workspace.files, 'built.txt'), 'utf8'), 'native-arm64-build'); check('guest persistence and bundled runtime build');
    const findTool = name => {
      try { const value = execFileSync('/usr/bin/xcrun', ['--find', name], { env: cleanEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); return path.isAbsolute(value) ? value : null; }
      catch { return null; }
    };
    const swiftc = findTool('swiftc');
    if (swiftc) {
      const source = path.join(workspace.files, 'NativeProbe.swift'), binary = path.join(workspace.files, 'native-probe');
      fs.writeFileSync(source, 'import Foundation\ntry "xcode-native".write(toFile: "xcode-built.txt", atomically: true, encoding: .utf8)\n');
      // xcrun supplies the selected SDK; calling the toolchain binary directly
      // can omit the standard-library search root on current macOS/Xcode.
      execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', 'swiftc', source, '-o', binary], { cwd: workspace.files, env: cleanEnvironment(), stdio: 'ignore' });
      execFileSync(binary, [], { cwd: workspace.files, env: cleanEnvironment(), stdio: 'ignore' });
      assert.equal(fs.readFileSync(path.join(workspace.files, 'xcode-built.txt'), 'utf8'), 'xcode-native');
      report.optional.xcode = 'passed'; check('installed Apple toolchain executes native code');
    }
    const metal = findTool('metal'), metallib = findTool('metallib');
    if (metal && metallib) {
      const source = path.join(workspace.files, 'NativeProbe.metal'), air = path.join(workspace.files, 'NativeProbe.air'), library = path.join(workspace.files, 'NativeProbe.metallib');
      fs.writeFileSync(source, '#include <metal_stdlib>\nusing namespace metal;\nkernel void ezil_probe(device float *values [[buffer(0)]], uint i [[thread_position_in_grid]]) { values[i] += 1.0; }\n');
      execFileSync(metal, ['-c', source, '-o', air], { cwd: workspace.files, env: cleanEnvironment(), stdio: 'ignore' });
      execFileSync(metallib, [air, '-o', library], { cwd: workspace.files, env: cleanEnvironment(), stdio: 'ignore' });
      assert.ok(fs.statSync(library).size > 0); report.optional.metal = 'passed'; check('installed Metal toolchain compiles a native library');
    }
    await openWorkspace(workspace.id);
    const desktop = getDesktop(), current = getHost();
    assert.equal(new URL(desktop.webContents.getURL()).pathname, '/os');
    assert.ok(await desktop.webContents.executeJavaScript('document.body.textContent.trim().length > 10'));
    const waitForDesktop = async (contents, expression) => {
      const deadline = Date.now() + 10000;
      while (!await contents.executeJavaScript(expression)) {
        if (Date.now() >= deadline) throw Error('Smoke desktop not ready');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    await waitForDesktop(desktop.webContents, 'typeof window.ezilFlushDesktop === "function" && !!document.querySelector(\'.taskbar-item[data-app="settings"]\')');
    check('packaged shared shell startup');
    // The helper receives a new loopback origin on restart. Persist a real
    // allowlisted setting through the UI/host contract, not arbitrary storage.
    await desktop.webContents.executeJavaScript('document.querySelector(\'.taskbar-item[data-app="settings"]\').click()');
    await waitForDesktop(desktop.webContents, '!!document.querySelector(\'.window[data-app="settings"] .ezil-settings-tab[data-tab="appearance"]\')');
    await desktop.webContents.executeJavaScript('document.querySelector(\'.window[data-app="settings"] .ezil-settings-tab[data-tab="appearance"]\').click()');
    await waitForDesktop(desktop.webContents, '!!document.querySelector(\'.window[data-app="settings"] [data-accent="violet"]\')');
    await desktop.webContents.executeJavaScript('document.querySelector(\'.window[data-app="settings"] [data-accent="violet"]\').click()');
    assert.equal(await desktop.webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--select-hue")'), '262');
    await desktop.webContents.executeJavaScript('document.querySelector(\'.window[data-app="settings"] .window-head > .window-close-btn\').click()');
    await waitForDesktop(desktop.webContents, '!document.querySelector(\'.window[data-app="settings"]\')');
    await desktop.webContents.executeJavaScript('window.ezilFlushDesktop()');
    const preferences = await desktop.webContents.executeJavaScript(`window.ezilNative.operation(${scriptLiteral({ op: 'desktop.read', workspaceId: workspace.id })})`);
    assert.equal(preferences.ok, true); assert.equal(preferences.preferences.accent, 'violet');
    const status = await desktop.webContents.executeJavaScript('window.ezilNative.request({op:"status"})');
    let sequence = status.sequence;
    const invoke = async (op, extra = {}) => desktop.webContents.executeJavaScript(`window.ezilNative.host(${scriptLiteral({ op, workspaceId: workspace.id, generation: status.generation, sequence: ++sequence, ...extra })})`);
    const editor = await invoke('editor.start'); assert.equal(editor.state, 'ready');
    await desktop.webContents.executeJavaScript(`(() => { const frame = document.createElement('iframe'); frame.id = 'native-editor-smoke'; frame.src = ${scriptLiteral(editor.url)}; frame.style.cssText = 'position:fixed;inset:100px;width:800px;height:500px'; document.body.appendChild(frame); })()`);
    let workbench = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const frame = desktop.webContents.mainFrame.frames.find(f => f.url.startsWith(editor.url));
      if (frame) {
        workbench = await frame.executeJavaScript('!!document.querySelector(".monaco-workbench")').catch(() => false);
        if (workbench) { assert.equal(await frame.executeJavaScript('typeof require'), 'undefined'); assert.equal(await frame.executeJavaScript('typeof window.ezilNative'), 'undefined'); break; }
      }
    }
    assert.equal(workbench, true); assert.equal(embedded.state(workspace.id), 'ready'); check('embedded editor iframe workbench');
    const unauthenticated = await fetch(editor.url, { redirect: 'manual' }); assert.equal(unauthenticated.status, 403); check('loopback editor rejects missing authentication');
    // No provider setup or remote URL is used by the mandatory guest path.
    server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<title>Offline browser</title><h1>Guest preview</h1><script>window.hmr = new Promise(resolve => { const socket = new WebSocket('ws://127.0.0.1:${server.address().port}/hmr'); socket.onmessage = event => resolve(event.data); });</script>`);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      const message = Buffer.from('hmr-ready'); socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browserSequence = sequence;
    const browserOp = async (op, fields = {}) => {
      const input = { op, workspaceId: workspace.id, generation: status.generation, sequence: ++browserSequence, viewId: 'offline-smoke', ...fields };
      sequence = browserSequence - 1; return invoke('browser', { operation: input });
    };
    const previewURL = `http://127.0.0.1:${server.address().port}/`;
    const pageReady = async wc => {
      const deadline = Date.now() + 10000;
      while (wc.getURL() !== previewURL || wc.isLoadingMainFrame()) {
        if (Date.now() >= deadline) throw Error('Smoke page not ready');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    await browserOp('create', { url: previewURL, bounds: { x: 100, y: 100, width: 600, height: 400 } });
    const view = current.browser.views.get('offline-smoke').view;
    await pageReady(view.webContents);
    assert.equal(current.browser.window, desktop); assert.ok(desktop.contentView.children.includes(view));
    assert.equal(await view.webContents.executeJavaScript('typeof require'), 'undefined'); assert.equal(await view.webContents.executeJavaScript('typeof window.ezilNative'), 'undefined');
    assert.equal(await view.webContents.executeJavaScript('window.hmr'), 'hmr-ready');
    await view.webContents.executeJavaScript('localStorage.setItem("guest-canary", "persisted")');
    const snapshot = await browserOp('snapshot'); assert.match(snapshot.snapshot, /^data:image\//); assert.equal(desktop.contentView.children.includes(view), false);
    await browserOp('restore'); assert.equal(desktop.contentView.children.includes(view), true);
    // Closing a WebContents is asynchronous; observe actual destruction
    // before checking cleanup or recreating the same browser slot.
    const closingContents = view.webContents;
    const destroyed = once(closingContents, 'destroyed', { signal: AbortSignal.timeout(5000) });
    await browserOp('destroy'); await destroyed; assert.equal(closingContents.isDestroyed(), true);
    await browserOp('create', { url: previewURL, bounds: { x: 100, y: 100, width: 600, height: 400 } });
    await pageReady(current.browser.views.get('offline-smoke').view.webContents);
    assert.equal(await current.browser.views.get('offline-smoke').view.webContents.executeJavaScript('localStorage.getItem("guest-canary")'), 'persisted');
    await browserOp('destroy'); check('browser composition, WS, occlusion, cleanup and profile persistence');
    // Snapshot bytes remain in memory; evidence contains only fixed check names.
    check('mandatory offline guest completed without providers or external VS Code');
    if (process.env.EZIL_SMOKE_EXTERNAL_VSCODE === '1') {
      assert.ok(discover()); assert.equal((await editors.start(workspace, { connector: current.helper.connector?.descriptor, model: broker.descriptor })).status, 'running');
      await editors.stop(workspace); report.optional.externalVSCode = 'passed';
    }
    if (process.env.EZIL_PHYSICAL_PROVIDER_FIXTURES) {
      try { for (const fixture of providerFixtures(process.env.EZIL_PHYSICAL_PROVIDER_FIXTURES)) await proveProvider(vault, broker, fixture); report.optional.providers = 'passed'; }
      finally { vault.remove(); }
    }
    await closeWorkspace();
    await openWorkspace(workspace.id); assert.equal(store.index.activeID, workspace.id);
    assert.equal(fs.readFileSync(path.join(workspace.files, 'built.txt'), 'utf8'), 'native-arm64-build');
    await waitForDesktop(getDesktop().webContents, 'typeof window.ezilFlushDesktop === "function"');
    assert.equal(await getDesktop().webContents.executeJavaScript('document.documentElement.style.getPropertyValue("--select-hue")'), '262');
    const reopened = getHost();
    await reopened.browser.operation({ op: 'create', workspaceId: workspace.id, generation: reopened.generation, sequence: 1, viewId: 'restart-smoke', url: previewURL, bounds: { x: 100, y: 100, width: 600, height: 400 } });
    await pageReady(reopened.browser.views.get('restart-smoke').view.webContents);
    assert.equal(await reopened.browser.views.get('restart-smoke').view.webContents.executeJavaScript('localStorage.getItem("guest-canary")'), 'persisted');
    await reopened.browser.operation({ op: 'destroy', workspaceId: workspace.id, generation: reopened.generation, sequence: 2, viewId: 'restart-smoke' });
    check('files, shell preferences and browser profile survive workspace restart');
    await closeWorkspace(); report.success = true;
  } catch (error) { report.failure = 'PACKAGED_SMOKE_FAILED'; report.failureAt = /smoke\.cjs:\d+:\d+/.exec(String(error?.stack))?.[0] || 'unavailable'; }
  finally {
    await closeWorkspace(); for (const socket of sockets) socket.destroy(); server?.close();
    atomic(path.join(evidenceRoot, 'result.json'), JSON.stringify(report, null, 2)); app.exit(report.success ? 0 : 1);
  }
}
module.exports = { run, providerFixtures, proveProvider, scriptLiteral };
