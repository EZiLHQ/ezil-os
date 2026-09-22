'use strict';
// Isolated fixture setup; all runtime actions use Code, native window controls,
// and the Dock. Never automate account credentials or attach to Chrome.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { _electron } = require('playwright-core');
const { Workspaces } = require('../src/workspaces.cjs');
const { developmentEnvironment } = require('../src/development-environment.cjs');
const { nativeButtonScript, assertNativeSession } = require('./product-flow-helpers.cjs');
const root = process.env.EZIL_RECOVERY_EVIDENCE, bundle = process.env.EZIL_RECOVERY_APP;
assert.ok(path.isAbsolute(root || '') && path.isAbsolute(bundle || ''));
fs.mkdirSync(root, { recursive: true });
const evidence = fs.mkdtempSync(path.join(root, 'recovery-flow-')), data = path.join(evidence, 'data');
const store = new Workspaces(data); store.guest(); const workspace = store.create('Recovery acceptance');
fs.writeFileSync(path.join(workspace.files, 'saved.txt'), 'EZIL_PRESERVED\n'); store.index.activeID = workspace.id; store.save();
const report = { passed: false, cycles: [], limitations: ['Isolated packaged UI test, not the normal installed profile.', 'Launch uses Electron test instrumentation; Chrome sign-in is never automated.'] };
let app, page, frame, stage = 'launch';
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(check, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const result = await check(); if (result) return result; } catch {} await delay(150); }
  throw Error(`${stage}: timeout`);
}
function native(script) {
  assertNativeSession(execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 5000 }));
  return execFileSync('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 45000 });
}
function processAction(script) { return native(`tell application "System Events" to tell first application process whose unix id is ${app.process().pid}\nset frontmost to true\n${script}\nend tell`); }
async function desktop() {
  page = await until(async () => { for (const p of app.windows()) if (await p.locator('.taskbar-item[data-app="code"]').isVisible()) return p; });
  page.setDefaultTimeout(30000);
}
async function code() {
  await page.locator('.taskbar-item[data-app="code"]').click();
  const win = page.locator('.window[data-app="code"]');
  const handle = await win.locator('iframe.window-app-iframe').elementHandle();
  frame = await until(async () => { const f = await handle.contentFrame(); return f && await f.locator('.monaco-workbench').isVisible() ? f : null; });
  const trust = frame.getByRole('button', { name: /Yes, I trust the authors/ });
  if (await trust.isVisible()) await trust.click();
  return win;
}
async function terminal() {
  await frame.locator('body').press('Meta+Shift+p');
  const input = frame.locator('.quick-input-widget input'); await input.fill('>Terminal: Create New Terminal');
  await frame.locator('.quick-input-list .monaco-list-row').filter({ hasText: 'Terminal: Create New Terminal' }).first().waitFor(); await input.press('Enter');
  const trust = frame.getByRole('button', { name: 'Trust Folder & Continue', exact: true });
  // A textarea exists before zsh has finished its login startup. Pasting then
  // can leave input buffered without executing Enter. Wait for the real prompt
  // decoration, which VS Code creates after shell integration reports readiness.
  await until(async () => {
    if (await trust.isVisible()) await trust.click();
    return await frame.locator('.xterm-decoration.terminal-command-decoration').count() > 0;
  });
  return frame.locator('textarea.xterm-helper-textarea').first();
}
async function command(input, text) { await input.focus(); await page.keyboard.insertText(text); await page.keyboard.press('Enter'); }
function processes() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
    return m ? [{ pid: +m[1], ppid: +m[2], birth: m[3], comm: m[4] }] : [];
  });
}
function supervised() {
  const rows = processes(), owned = new Set([app.process().pid]); let changed;
  do { changed = false; for (const row of rows) if (!owned.has(row.pid) && owned.has(row.ppid)) { owned.add(row.pid); changed = true; } } while (changed);
  return rows.filter(row => row.pid !== app.process().pid && owned.has(row.pid) && /code-server|\/bun$|\/node$|\/zsh$|\/bash$/.test(row.comm));
}
async function closeWindow(confirm = true) {
  processAction('perform action "AXPress" of (first button of window 1 whose subrole is "AXCloseButton")');
  assert.equal(native(nativeButtonScript(app.process().pid, confirm ? 'Stop workspace' : 'Cancel', 30)).trim(), 'clicked');
  if (confirm) await until(() => page.isClosed());
}
function dockReopen() {
  native('tell application "System Events" to tell process "Dock"\nperform action "AXPress" of (first UI element of list 1 whose name is "EZiL OS")\nend tell');
}
async function main() {
  const env = { ...developmentEnvironment(path.join(bundle, 'Contents/Resources')), EZIL_NATIVE_APP_DATA: data, EZIL_NATIVE_SKIP_LEGACY: '1' };
  app = await _electron.launch({ executablePath: path.join(bundle, 'Contents/MacOS/EZiL OS'), args: [], env, timeout: 35000 });
  await desktop();
  for (let cycle = 0; cycle < 10; cycle++) {
    stage = `cycle-${cycle + 1}-code`; const start = Date.now(); await code();
    assert.equal(fs.readFileSync(path.join(workspace.files, 'saved.txt'), 'utf8'), 'EZIL_PRESERVED\n');
    const input = await terminal(), port = 49500 + cycle;
    await command(input, `bun -e 'Bun.serve({hostname:"127.0.0.1",port:${port},fetch:()=>new Response("EZIL_BUN_${cycle}")})'`);
    await until(async () => (await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).text()) === `EZIL_BUN_${cycle}`);
    const codeAndBunReadyMs = Date.now() - start;
    if (cycle === 0) {
      stage = 'cancel-close'; await closeWindow(false); assert.equal(page.isClosed(), false);
      const win = page.locator('.window[data-app="code"]'); await win.locator('.window-minimize-btn').click();
      await page.locator('.taskbar-item[data-app="desktop"]').click();
      const address = page.getByRole('textbox', { name: 'Browser address' }); await address.fill(`http://127.0.0.1:${port}`); await address.press('Enter');
      await until(async () => { for (const p of app.context().pages()) if (p.url() === `http://127.0.0.1:${port}/` && (await p.locator('body').innerText()).includes('EZIL_BUN_0')) return true; });
      await page.screenshot({ path: path.join(evidence, 'bun-browser-shell.png') });
    }
    const owned = supervised(); assert.ok(owned.length > 0);
    stage = `cycle-${cycle + 1}-close`; await closeWindow();
    await until(async () => { try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } });
    await until(() => !processes().some(row => owned.some(old => old.pid === row.pid && old.birth === row.birth)));
    report.cycles.push({ cycle: cycle + 1, codeAndBunReadyMs, cycleThroughShutdownMs: Date.now() - start, supervisedStopped: owned.length });
    fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2));
    stage = `cycle-${cycle + 1}-dock`; dockReopen(); await desktop();
  }
  await code(); await page.screenshot({ path: path.join(evidence, 'reopened-code.png') });
  report.passed = true;
}
main().catch(async error => { report.failure = { stage, message: String(error.message).slice(0, 1000) }; if (page && !page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {}); process.exitCode = 1; }).finally(async () => {
  if (app) {
    const child = app.process();
    const owned = supervised();
    let timer;
    try {
      await Promise.race([(async () => {
        if (page && !page.isClosed()) await closeWindow();
        await app.close();
      })(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('test_cleanup_timeout')), 55000); })]);
      report.cleanup = 'closed';
    } catch (error) {
      report.cleanup = 'failed'; report.passed = false; process.exitCode = 1;
      report.cleanupFailure = String(error.message).slice(0, 200);
      // Failed-test cleanup only. Revalidate recorded process identities before
      // signaling; do not count this fallback as successful lifecycle behavior.
      for (const old of owned.reverse()) {
        if (processes().some(row => row.pid === old.pid && row.birth === old.birth && row.comm === old.comm)) {
          try { process.kill(old.pid, 'SIGTERM'); } catch {}
        }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    } finally { clearTimeout(timer); }
  }
  fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); console.log(evidence); console.log(JSON.stringify(report));
});
