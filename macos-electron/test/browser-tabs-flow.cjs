'use strict';
// Product-flow acceptance for the development app. Fixture setup is separate
// from product actions: no injected frames, bridge calls or DOM mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { _electron } = require('playwright-core');
const { Workspaces } = require('../src/workspaces.cjs');
const { developmentEnvironment } = require('../src/development-environment.cjs');
const root = path.resolve(__dirname, '../..');
const appRoot = process.env.EZIL_TABS_APP || path.join(root, 'macos-electron');
const packaged = appRoot.endsWith('.app');
const executablePath = process.env.EZIL_TABS_EXECUTABLE || (packaged ? path.join(appRoot, 'Contents/MacOS/Electron') : path.join(root, 'macos-electron/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'));
const resources = packaged ? path.join(appRoot, 'Contents/Resources') : root;
const evidenceRoot = process.env.EZIL_TABS_EVIDENCE;
assert.ok(evidenceRoot && path.isAbsolute(evidenceRoot), 'Set an absolute EZIL_TABS_EVIDENCE directory');
fs.mkdirSync(evidenceRoot, { recursive: true });
const evidence = fs.mkdtempSync(path.join(evidenceRoot, 'tabs-flow-'));
const dataRoot = path.join(evidence, 'app-data');
const store = new Workspaces(dataRoot); store.guest();
const workspace = store.create('Browser tabs acceptance');
store.index.activeID = workspace.id; store.save();
const report = { passed: false, checks: [], limitations: [
  packaged ? 'Packaged application; isolated test data, not the normal user profile.' : 'Development app, not installed/release bytes; Node may not match the release pin.',
  'Shell and Chromium screenshots are separate, not a composed native-window capture.',
  'OS-native shortcuts, popup gestures, pickers and menus require separate Accessibility acceptance.',
  'The fixture server is host-started, not a Code terminal/HMR test.',
] };
const requests = new Map();
let app, page, browser, address, activeStep, slowStarted = false, slowFinished = false;
const slowTimers = new Set();
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  requests.set(route, (requests.get(route) || 0) + 1);
  const name = ({ '/one': 'One', '/two': 'Two', '/one-next': 'Next', '/slow': 'Slow', '/pending': 'Pending' })[route] || 'Fixture';
  const respond = () => {
    res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
    res.end(`<!doctype html><meta charset="utf-8"><title>${name}</title><style>body{font:18px system-ui;background:#eef7ff;padding:32px;color:#18354d}input{font:inherit;padding:8px}a{display:block;margin:20px 0}</style><h1>${name}</h1><label>Tab notes <input id="notes"></label><a id="next" href="/one-next">Next page</a><a href="/two" target="_blank">Open Two in new tab</a>`);
  };
  if (route === '/slow' || route === '/pending' && requests.get(route) === 1) {
    if (route === '/slow') slowStarted = true;
    const timer = setTimeout(() => { slowTimers.delete(timer); if (route === '/slow') slowFinished = true; respond(); }, 12000);
    slowTimers.add(timer);
  } else respond();
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, ms = 12000) {
  const deadline = Date.now() + ms;
  do { const result = await check(); if (result) return result; await delay(50); } while (Date.now() < deadline);
  throw Error('acceptance_timeout');
}
function save() { fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2)); }
async function step(id, run) {
  activeStep = id; const start = Date.now(); await run();
  report.checks.push({ id, status: 'passed', durationMs: Date.now() - start }); save();
}
async function dock(id) {
  await page.locator(`.taskbar-item[data-app="${id}"]`).click();
  const win = page.locator(`.window[data-app="${id}"]`).last(); await win.waitFor({ state: 'visible' }); return win;
}
const tabs = () => browser.getByRole('tab');
async function navigate(url, title) {
  await address.fill(url); await address.press('Enter');
  const content = await until(() => app.context().pages().find(p => p !== page && p.url() === url.replace(/^localhost:/, 'http://localhost:')));
  await content.getByRole('heading', { name: title, exact: true }).waitFor();
  await until(() => browser.getByRole('tab', { name: title, exact: true }).count());
  return content;
}
async function composition() {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:'));
    return win.contentView.children.filter(v => v.webContents && v.webContents !== win.webContents)
      .map(v => ({ url: v.webContents.getURL(), bounds: v.getBounds() }));
  });
}
async function onlyVisible(url) {
  await until(async () => { const children = await composition(); return children.length === 1 && children[0].url === url; });
}
async function launch() {
  app = await _electron.launch({ executablePath,
    args: packaged ? [] : [appRoot], timeout: 20000,
    env: { ...developmentEnvironment(resources), EZIL_NATIVE_APP_DATA: dataRoot, EZIL_NATIVE_SKIP_LEGACY: '1',
      EZIL_NATIVE_RESOURCES: root, EZIL_SHELL_ASSETS: path.join(root, 'app/public/os'),
      EZIL_BUN_PATH: process.env.EZIL_BUN_PATH || path.join(root, '.native-tools/bin/bun') } });
  page = await app.firstWindow(); page.setDefaultTimeout(8000);
  await page.locator('.taskbar-item[data-app="desktop"]').waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:')).setSize(1280, 800));
}
async function close() {
  if (!app) return;
  const instance = app, child = instance.process(); app = null;
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  await instance.close(); assert.equal(await exited, 0, 'app must exit normally');
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, origin = `http://localhost:${port}`;
  report.runtime = { node: process.version, electron: require('electron/package.json').version, playwright: require('playwright-core/package.json').version };
  let one, two;
  await step('actual_dock_and_first_local_tab', async () => {
    await launch(); browser = await dock('desktop'); address = browser.getByRole('textbox', { name: 'Browser address' });
    assert.equal(await tabs().count(), 1);
    one = await navigate(`localhost:${port}/one`, 'One');
    await until(async () => await address.inputValue() === `${origin}/one`);
    await one.locator('#notes').fill('one stays in memory'); await onlyVisible(`${origin}/one`);
    assert.deepEqual(await one.evaluate(() => [typeof window.ezilNative, typeof window.require, typeof window.process]), ['undefined', 'undefined', 'undefined']);
  });
  await step('new_switch_tabs_and_independent_drafts', async () => {
    await browser.getByRole('button', { name: 'New tab', exact: true }).click();
    assert.equal(await tabs().count(), 2); assert.equal(await address.inputValue(), '');
    two = await navigate(`${origin}/two`, 'Two'); await two.locator('#notes').fill('two stays in memory');
    await browser.getByRole('tab', { name: 'One', exact: true }).click(); await onlyVisible(`${origin}/one`);
    assert.equal(await one.locator('#notes').inputValue(), 'one stays in memory');
    await address.fill('an unfinished search');
    await browser.getByRole('tab', { name: 'Two', exact: true }).click(); await onlyVisible(`${origin}/two`);
    assert.equal(await address.inputValue(), `${origin}/two`); assert.equal(await two.locator('#notes').inputValue(), 'two stays in memory');
    await browser.getByRole('tab', { name: 'One', exact: true }).click();
    assert.equal(await address.inputValue(), 'an unfinished search'); await address.press('Escape');
    assert.equal(await address.inputValue(), `${origin}/one`);
    await page.screenshot({ path: path.join(evidence, 'tabs-shell-1280.png') });
    await one.screenshot({ path: path.join(evidence, 'tab-one-native.png') });
  });
  await step('content_zoom_preserves_shell_geometry', async () => {
    const before = await browser.boundingBox(), width = await one.evaluate(() => window.innerWidth);
    const shellZoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:')).webContents.getZoomFactor());
    await browser.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await browser.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await until(async () => await browser.getByRole('button', { name: 'Reset page zoom', exact: true }).innerText() === '125%');
    assert.ok(await one.evaluate(() => window.innerWidth) < width * 0.9, 'real document viewport did not zoom');
    assert.deepEqual(await browser.boundingBox(), before);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('http:')).webContents.getZoomFactor()), shellZoom);
    await one.screenshot({ path: path.join(evidence, 'page-zoom-125.png') });
    await page.screenshot({ path: path.join(evidence, 'page-zoom-toolbar.png') });
    await browser.getByRole('button', { name: 'Zoom out', exact: true }).click();
    await until(async () => await browser.getByRole('button', { name: 'Reset page zoom', exact: true }).innerText() === '110%');
    await browser.getByRole('button', { name: 'Reset page zoom', exact: true }).click();
    await until(async () => await one.evaluate(() => window.innerWidth) === width);
    await address.click(); await page.keyboard.press('Meta+=');
    await until(async () => await browser.getByRole('button', { name: 'Reset page zoom', exact: true }).innerText() === '110%');
    await page.keyboard.press('Meta+0');
    await until(async () => await browser.getByRole('button', { name: 'Reset page zoom', exact: true }).innerText() === '100%');
  });
  await step('links_and_per_tab_history', async () => {
    await one.locator('#next').click(); await until(() => one.url() === `${origin}/one-next`);
    await browser.getByRole('button', { name: 'Back', exact: true }).click(); await until(() => one.url() === `${origin}/one`);
    await browser.getByRole('button', { name: 'Forward', exact: true }).click(); await until(() => one.url() === `${origin}/one-next`);
    await browser.getByRole('tab', { name: 'Two', exact: true }).click();
    assert.equal(two.url(), `${origin}/two`); assert.equal(await browser.getByRole('button', { name: 'Back', exact: true }).isDisabled(), true);
  });
  await step('shell_keyboard_tab_controls', async () => {
    await address.click(); await page.keyboard.press('Meta+t');
    await until(async () => await tabs().count() === 3); assert.equal(await address.inputValue(), '');
    await page.keyboard.press('Control+Shift+Tab');
    assert.equal(await tabs().nth(1).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Control+Tab');
    assert.equal(await tabs().nth(2).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Meta+w'); await until(async () => await tabs().count() === 2);
  });
  await step('background_close_active_close_and_last_tab', async () => {
    await browser.getByRole('button', { name: 'Close Next', exact: true }).click();
    await until(() => one.isClosed()); assert.equal(await tabs().count(), 1); await onlyVisible(`${origin}/two`);
    await browser.getByRole('button', { name: 'Close Two', exact: true }).click();
    await until(() => two.isClosed()); assert.equal(await tabs().count(), 1); assert.equal(await address.inputValue(), '');
    one = await navigate(`${origin}/one`, 'One');
    await browser.getByRole('button', { name: 'New tab', exact: true }).click(); two = await navigate(`${origin}/two`, 'Two');
  });
  await step('stalled_page_tab_switch_drag_and_settings', async () => {
    await browser.getByRole('button', { name: 'New tab', exact: true }).click();
    await address.fill(`${origin}/slow`); await address.press('Enter'); await until(() => slowStarted);
    const start = Date.now();
    await browser.getByRole('tab', { name: 'One', exact: true }).click(); await onlyVisible(`${origin}/one`);
    const titlebar = await browser.locator('> .window-head').boundingBox();
    await page.mouse.move(titlebar.x + titlebar.width / 2, titlebar.y + 12); await page.mouse.down();
    await page.mouse.move(titlebar.x + titlebar.width / 2 + 24, titlebar.y + 28, { steps: 5 }); await page.mouse.up();
    await browser.locator('> .window-head > .window-minimize-btn').click();
    const settings = await dock('settings'); await until(async () => (await composition()).length === 0);
    await settings.locator('> .window-head > .window-minimize-btn').click(); browser = await dock('desktop');
    address = browser.getByRole('textbox', { name: 'Browser address' }); await onlyVisible(`${origin}/one`);
    report.stalledCompositionMs = Date.now() - start;
    assert.equal(slowFinished, false, 'shell waited for stalled navigation');
    assert.ok(report.stalledCompositionMs < 4000, 'shell controls too slow');
    await until(() => slowFinished, 15000);
    await browser.getByRole('tab', { name: 'Slow', exact: true }).click(); await onlyVisible(`${origin}/slow`);
    await browser.getByRole('tab', { name: 'Two', exact: true }).click(); await onlyVisible(`${origin}/two`);
  });
  await step('quit_and_lazy_restore', async () => {
    await close();
    const saved = JSON.parse(fs.readFileSync(path.join(workspace.dir, 'desktop.json'), 'utf8'));
    assert.deepEqual(saved.browser, { tabs: [`${origin}/one`, `${origin}/two`, `${origin}/slow`], activeIndex: 1 });
    requests.clear(); await launch();
    browser = page.locator('.window[data-app="desktop"]'); await browser.waitFor(); address = browser.getByRole('textbox', { name: 'Browser address' });
    await until(async () => await tabs().count() === 3); await onlyVisible(`${origin}/two`);
    assert.equal(requests.get('/one') || 0, 0); assert.equal(requests.get('/slow') || 0, 0);
    assert.equal(await tabs().nth(1).getAttribute('aria-selected'), 'true');
    await tabs().nth(0).click(); await onlyVisible(`${origin}/one`); assert.equal(requests.get('/one'), 1);
    await page.screenshot({ path: path.join(evidence, 'tabs-restored-shell.png') });
  });
  await step('close_browser_window_and_reopen', async () => {
    await browser.locator('> .window-head > .window-close-btn').click(); await browser.waitFor({ state: 'detached' });
    await until(async () => (await composition()).length === 0);
    browser = await dock('desktop'); address = browser.getByRole('textbox', { name: 'Browser address' });
    assert.equal(await tabs().count(), 3); await onlyVisible(`${origin}/one`);
  });
  await step('narrow_window_real_resize', async () => {
    const before = await browser.boundingBox(), grip = await browser.locator('.ui-resizable-se').boundingBox();
    assert.ok(grip, 'resize handle missing');
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2); await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 - (before.width - 530), grip.y + grip.height / 2 - 140, { steps: 8 }); await page.mouse.up();
    const after = await browser.boundingBox(); assert.ok(after.width >= 480 && after.width <= 580);
    const geometry = await browser.evaluate(el => {
      const toolbar = el.querySelector('.ezil-native-browser-toolbar'), strip = el.querySelector('.ezil-native-browser-tab-row');
      return { toolbarWidth: toolbar.clientWidth, toolbarScroll: toolbar.scrollWidth, tabRowWidth: strip.clientWidth, tabRowScroll: strip.scrollWidth };
    });
    assert.equal(geometry.toolbarWidth, geometry.toolbarScroll); assert.equal(geometry.tabRowWidth, geometry.tabRowScroll);
    report.narrowWindow = { width: after.width, ...geometry };
    await page.mouse.move(10, 10); await page.screenshot({ path: path.join(evidence, 'tabs-narrow-shell.png') });
  });
  await step('pending_destination_survives_browser_close', async () => {
    await browser.getByRole('button', { name: 'New tab', exact: true }).click();
    await address.fill(`${origin}/pending`); await address.press('Enter');
    await until(() => requests.get('/pending') === 1);
    assert.equal(await address.inputValue(), `${origin}/pending`);
    await browser.locator('> .window-head > .window-close-btn').click(); await browser.waitFor({ state: 'detached' });
    browser = await dock('desktop'); address = browser.getByRole('textbox', { name: 'Browser address' });
    await until(() => requests.get('/pending') === 2); await onlyVisible(`${origin}/pending`);
    assert.equal(await tabs().count(), 4);
    await browser.getByRole('tab', { name: 'Pending', exact: true }).waitFor();
  });
  await step('ten_browser_window_cycles_dispose_native_pages', async () => {
    for (let cycle = 0; cycle < 10; cycle++) {
      await browser.locator('> .window-head > .window-close-btn').click(); await browser.waitFor({ state: 'detached' });
      await until(async () => (await composition()).length === 0 && app.context().pages().filter(p => p !== page).length === 0);
      browser = await dock('desktop'); address = browser.getByRole('textbox', { name: 'Browser address' });
      assert.equal(await tabs().count(), 4); await onlyVisible(`${origin}/pending`);
    }
  });
  await step('normal_quit_cleanup', close);
  report.passed = true;
}
run().catch(error => { report.failure = { step: activeStep, message: error.message }; process.exitCode = 1; })
  .finally(async () => {
    await close().catch(error => { report.cleanupError = error.message; process.exitCode = 1; });
    for (const timer of slowTimers) clearTimeout(timer);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    save(); console.log(JSON.stringify({ evidence, ...report }, null, 2));
  });
