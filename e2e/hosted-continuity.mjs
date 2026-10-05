import { signIn } from './sign-in.mjs';
/** Hosted acceptance only. No default computer, simulated ICE, or skipped checks. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, appHeaders, APP_STOP_FETCH_TIMEOUT_MS, configureAppContext } from './deployed-target.mjs';
import { verifyCloudDeployment } from './verify-cloud-deployment.mjs';
import { observeScreenResizes, readDesktopReadiness, waitForDesktopResize } from './desktop-resize-ready.mjs';
import { requestViewerProbe, waitForViewerProgress } from './viewer-progress.mjs';
import { terminalContinuityCommand, assertProcessContinuity, waitForProcessSample } from './process-continuity.mjs';
import { stopIsolatedComputer } from './isolated-computer.mjs';
import { verifyEditorShortcut } from './editor-shortcut.mjs';
import { verifyRelayLifetime } from './relay-lifetime.mjs';

const required = key => { assert.ok(process.env[key], `Missing prerequisite: ${key}`); return process.env[key]; };
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const evidence = { phases: [], samples: [] };
// Drive the canonical host while verifying its immutable Vercel deployment.
// verifyCloudDeployment also checks both production aliases against that ID.
const identityEnv = { ...process.env, EZIL_E2E_APP: process.env.EZIL_CONTINUITY_IDENTITY_APP || APP };
let browser, context, page, beforeIdentity, computerId, resizeObserver;
let verifiedComputer = false;
const started = Date.now();
const phase = name => evidence.phases.push({ name, elapsedMs: Date.now() - started });
const wait = ms => page.waitForTimeout(ms);
const bounded = async (name, action, timeout = 240000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const result = await action(); if (result) return result; await wait(1000); }
  throw new Error(`${name}: deadline exceeded`);
};
try {
  assert.equal(new URL(APP).protocol, 'https:', 'Hosted HTTPS application required');
  assert.ok(!/localhost|127\.0\.0\.1/.test(APP), 'Loopback is not acceptance');
  computerId = required('EZIL_E2E_COMPUTER_ID');
  assert.match(computerId, /^[a-f0-9-]{36}$/i, 'Explicit isolated computer UUID required');
  const workspace = required('EZIL_E2E_WORKSPACE_PATH');
  assert.ok(workspace.startsWith('/') && !workspace.includes('\n'), 'Explicit absolute test workspace required');
  required('EZIL_WRANGLER_BIN'); required('EZIL_E2E_R2_BUCKET');
  const r2Prefix = required('EZIL_E2E_R2_PREFIX');
  assert.ok(r2Prefix.replace(/^\/+|\/+$/g, '').split('/').every(p => p && p !== '.' && p !== '..'), 'Explicit checkpoint prefix required');
  const mode = required('EZIL_CONTINUITY_MODE');
  assert.ok(['short', 'full', 'essential'].includes(mode));
  if (mode !== 'essential') required('EZIL_ACCEPTANCE_HMAC_SECRET');
  const req = createRequire(required('PLAYWRIGHT_REQUIRE_DIR') + '/test.js');
  const { chromium } = req('playwright');
  beforeIdentity = await verifyCloudDeployment(identityEnv);
  const cf = await fetch(`https://api.cloudflare.com/client/v4/accounts/${required('CLOUDFLARE_ACCOUNT_ID')}/containers/applications`, {
    headers: { authorization: `Bearer ${required('CLOUDFLARE_API_TOKEN')}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  assert.ok(cf.ok, 'Container identity unavailable');
  const applications = (await cf.json()).result;
  const application = applications.find(a => a.name === `${required('EZIL_WORKER_NAME')}-sandbox`);
  const image = application?.configuration?.image?.match(/(?:@|\/)(sha256:[a-f0-9]{64})$/)?.[1];
  assert.ok(image, 'Deployed immutable container image missing');
  evidence.deployment = { sha: beforeIdentity.sha, worker_version: beforeIdentity.worker_version, vercel_deployment: beforeIdentity.vercel_deployment, image, computerHash: hash(computerId), mode };
  const launchArgs = ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'];
  browser = await chromium.launch({ args: launchArgs });
  evidence.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await configureAppContext(context);
  const continuityInit = () => {
    window.__continuityVitals = [];
    window.__continuitySequence = 0;
    window.addEventListener('message', e => {
      const frame = document.querySelector('.window[data-app="desktop"] iframe');
      if (!frame || e.source !== frame.contentWindow || e.origin !== new URL(frame.src).origin) return;
      if (e.data?.source !== 'ezil-mobile' || e.data.type !== 'stream_vitals') return;
      if (e.data.attempt !== new URL(frame.src).searchParams.get('ezilAttempt')) return;
      const raw = e.data.vitals;
      if (!raw || typeof raw !== 'object') return;
      // Only public transport counters/enums; never arbitrary client payload.
      const safe = { sequence: ++window.__continuitySequence, receivedAt: Date.now() };
      for (const key of ['bytesReceived', 'framesDecoded', 'width', 'height']) {
        if (Number.isFinite(raw[key]) && raw[key] >= 0) safe[key] = raw[key];
      }
      for (const [key, values] of Object.entries({ connectionState: ['new','connecting','connected','disconnected','failed','closed'],
        localCandidateType: ['host','srflx','prflx','relay'], remoteCandidateType: ['host','srflx','prflx','relay'], relayProtocol: ['udp','tcp','tls'] })) {
        if (values.includes(raw[key])) safe[key] = raw[key];
      }
      window.__continuityVitals.push(safe);
      window.__continuityVitals = window.__continuityVitals.slice(-120);
    });
  };
  await context.addInitScript(continuityInit);
  page = await context.newPage();
  resizeObserver = observeScreenResizes(page, APP);
  await page.goto(`${APP}/login?method=email`);
  await signIn(page, { email: required('EZIL_E2E_EMAIL'), password: required('EZIL_E2E_PASSWORD') });
  await page.goto(`${APP}/os`);
  await bounded('session ready', () => page.evaluate(() => !!window.ezil?.session?.payload?.()?.computer));
  const api = async (path, body) => {
    const result = await page.evaluate(async ({ path, body }) => {
      const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
      return { status: response.status, json: await response.json() };
    }, { path, body });
    assert.equal(result.status, 200, `HTTP failure ${path.split('?')[0]}`);
    return result.json;
  };
  const sandboxId = await page.evaluate(() => {
    const payload = window.ezil.session.payload();
    const compact = id => id.replace(/[^a-z0-9]/gi,'').slice(0,16);
    return `guac-${compact(payload.user.id)}-${compact(payload.computer.id)}`;
  });
  const fault = async (kind, durationMs=60000) => {
    const timestamp=Date.now();
    const signature=createHmac('sha256',required('EZIL_ACCEPTANCE_HMAC_SECRET')).update(`${timestamp}.POST./sandbox/preview.`).digest('hex');
    const response=await fetch(`${required('EZIL_E2E_WORKER').replace(/\/$/,'')}/sandbox/${encodeURIComponent(sandboxId)}/acceptance-fault`, {
      method:'POST',headers:{authorization:`Bearer t=${timestamp},v1=${signature}`,'content-type':'application/json'},
      body:JSON.stringify({fault:kind,...(kind==='clear'?{}:{durationMs})}),signal:AbortSignal.timeout(15000),redirect:'error',
    });
    assert.equal(response.status,200,'Staging backend fault prerequisite unavailable');
    assert.equal((await response.json()).ok,true,'Staging backend fault rejected');
  };
  const browserSnapshot = async () => {
    const timestamp=Date.now();
    const signature=createHmac('sha256',required('EZIL_ACCEPTANCE_HMAC_SECRET')).update(`${timestamp}.POST./sandbox/preview.`).digest('hex');
    const response=await fetch(`${required('EZIL_E2E_WORKER').replace(/\/$/,'')}/sandbox/${encodeURIComponent(sandboxId)}/browser/snapshot`, {
      method:'POST',headers:{authorization:`Bearer t=${timestamp},v1=${signature}`,'content-type':'application/json'},
      body:'{}',signal:AbortSignal.timeout(45000),redirect:'error',
    });
    assert.ok(response.ok,'Hosted browser observation unavailable');
    const snapshot=await response.json();assert.equal(snapshot.ok,true,'Hosted browser snapshot failed');
    return snapshot;
  };
  const selected = await page.evaluate(() => window.ezil.session.payload().computer.id);
  assert.equal(selected, computerId, 'Authenticated session selects another computer; refusing to launch or stop it');
  verifiedComputer = true;
  const launch = async app => {
    if (app === 'desktop') await page.evaluate(() => { window.__continuityVitals = []; });
    await page.evaluate(async app => { const payload = window.ezil.session.payload(); await window.ezil.registry.launch(app, { payload, computer: payload.computer, desktopState: payload.desktopState }); }, app);
  };
  const close = app => page.evaluate(app => window.$(`.window[data-app="${app}"]`).close(), app);
  const relay = () => api(`/api/shell/relay-refresh?computerId=${encodeURIComponent(computerId)}`);
  const sample = async () => {
    await page.evaluate(requestViewerProbe);
    return page.evaluate(() => window.__continuityVitals.at(-1));
  };
  let fallback = false;
  const live = async (timeoutMs = 60000) => {
    const afterSequence = await page.evaluate(() => window.__continuitySequence);
    const s = await waitForViewerProgress({ sample, afterSequence, fallback, timeoutMs });
    evidence.samples.push(s); return s;
  };
  // Previous staging suites can leave this isolated computer warm. Establish
  // the stopped state before Browser is the first app to request a new runtime.
  const prepareCold = await api('/api/shell/stop', { computerId });
  assert.ok(prepareCold.ok && ['destroyed','not_running'].includes(prepareCold.outcome), 'Cold-start setup failed');
  const confirmCold = await api('/api/shell/stop', { computerId });
  assert.ok(confirmCold.ok && confirmCold.outcome === 'not_running' && confirmCold.terminated === false, 'Computer did not remain stopped before cold Browser launch');
  const coldStartedAt = Date.now();
  await launch('desktop'); await live(225000);
  const firstRelay = await relay();
  assert.ok(firstRelay.ok && firstRelay.runtimeId && firstRelay.expiresAt, 'Relay identity unavailable');
  if (mode === 'short') assert.ok(firstRelay.expiresAt - Date.now() <= 305000, 'Short gate requires supported five-minute TURN credentials');
  if (mode === 'full') assert.ok(firstRelay.expiresAt - Date.now() > 1200000 && firstRelay.expiresAt - Date.now() <= 1805000, 'Full release gate requires production thirty-minute TURN credentials');
  evidence.runtimeHash = hash(firstRelay.runtimeId);
  evidence.coldOpenMs = Date.now() - coldStartedAt;
  phase('default TURN cold Browser open before Code');
  const checkpointKey = `${r2Prefix.replace(/^\/+|\/+$/g, '')}/.ezil-snapshots/latest.json`;
  const readCommittedCheckpoint = () => {
    const directory = mkdtempSync(join(tmpdir(), 'ezil-checkpoint-'));
    try {
      const file = join(directory, 'head.json');
      execFileSync(required('EZIL_WRANGLER_BIN'), ['r2','object','get',`${required('EZIL_E2E_R2_BUCKET')}/${checkpointKey}`,'--remote','--file',file], {
        stdio: 'pipe', timeout: 30000, env: process.env,
      });
      const raw = readFileSync(file);
      assert.ok(raw.length <= 128 * 1024, 'Checkpoint manifest exceeds bound');
      const checkpoint = JSON.parse(raw.toString('utf8'));
      assert.equal(checkpoint.version, 1, 'Durable checkpoint format invalid');
      assert.match(checkpoint.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Array.isArray(checkpoint.chunks) && checkpoint.chunks.length, 'Durable checkpoint chunks missing');
      return { sha256: checkpoint.sha256, manifestHash: hash(JSON.stringify(checkpoint)), chunks: checkpoint.chunks.length };
    } finally { rmSync(directory,{recursive:true,force:true}); }
  };
  const code = () => page.frames().find(f => /-code\./.test(f.url()));
  const openCode = async () => { await launch('code'); return bounded('Code workbench', async () => { const f = code(); return f && await f.locator('.monaco-workbench').count() ? f : null; }); };
  const editorModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const closeModal = async f => {
    const modal = f.locator('.monaco-modal-editor-block:visible');
    if (await modal.count()) {
      await modal.locator('.codicon-close').last().click();
      await bounded('Code file saved and closed', async () => {
        const save = f.getByRole('button', { name: 'Save', exact: true });
        if (await save.isVisible()) await save.click();
        return !await modal.count();
      }, 15000);
    }
  };
  const command = async (f, text) => {
    await launch('code');
    await closeModal(f);
    const quick = f.locator('.quick-input-widget input:visible');
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = f.locator('.quick-input-list .monaco-list-row:visible').filter({hasText:new RegExp('^'+escaped)}).first();
    await bounded('Code command ready',async()=>{
      if(!await quick.count())await f.locator('.command-center').click();
      try {await quick.waitFor({state:'visible',timeout:1000});await quick.fill('>'+text);await row.waitFor({state:'visible',timeout:2000});return true;}catch{return false;}
    },30000);
    await row.click();await quick.waitFor({state:'hidden',timeout:15000});
    if(text === 'Preferences: Open User Settings (JSON)') await f.locator('.monaco-modal-editor-block:visible .monaco-editor:visible .view-line').first().waitFor({state:'visible',timeout:15000});
    await wait(1200);
  };
  const currentEditor = async f => {
    const modal = f.locator('.monaco-modal-editor-block:visible');
    if (await modal.count()) return modal.locator('.monaco-editor:visible').last();
    return f.locator('.editor-instance .monaco-editor:visible').last();
  };
  const focusEditor = async f => {
    const editor = await currentEditor(f);
    await bounded('Code editor input focus',async()=>{
      const line=editor.locator('.view-line').first();
      if(!await line.count()) return false;
      await line.click();
      return editor.evaluate(el=>el.contains(document.activeElement));
    },30000);
  };
  const setDocument = async (f, text) => {
    await focusEditor(f);
    await page.keyboard.press(editorModifier + '+A');
    await page.keyboard.type(text);
    await page.keyboard.press(editorModifier + '+S');
    await wait(1200);
    assert.ok((await readDocument(f)).includes(text.trim().split('\n')[0]),'Code document edit was not applied');
    // Close the edited file and handle Code's explicit Save confirmation.
    // Browser keyboard shortcuts can be intercepted on macOS.
    if (await f.locator('.monaco-modal-editor-block:visible').count()) await closeModal(f);
    else {
      const activeTab = f.locator('.tabs-container .tab.active');
      const fileName = await activeTab.locator('.label-name').innerText();
      const tab = f.locator('.tabs-container .tab').filter({ has: f.locator('.label-name').filter({ hasText: new RegExp('^' + fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) });
      await tab.getByRole('button', { name: /^Close/ }).click();
      await bounded('Code tab saved and closed', async () => {
        const save = f.getByRole('button', { name: 'Save', exact: true });
        if (await save.isVisible()) await save.click();
        return !await tab.count();
      }, 15000);
    }
  };
  const readDocument = async f => (await (await currentEditor(f)).locator('.view-lines').innerText()).replace(/\u00a0/g,' ');
  const verifyDarkTheme = async frame => {
    await bounded('rendered dark workbench', async () => frame.locator('.monaco-workbench').evaluate(el => {
      const color = getComputedStyle(el).getPropertyValue('--vscode-editor-background').trim();
      const match = color.match(/^#([a-f0-9]{6})$/i);
      if (!match) return false;
      const rgb = [0,2,4].map(i => parseInt(match[1].slice(i,i+2),16));
      return el.classList.contains('vs-dark') && Math.max(...rgb) < 100;
    }));
  };
  const settings = '// continuity JSONC\n{"workbench.colorTheme":"Dark Modern","security.workspace.trust.enabled":false,"editor.accessibilitySupport":"on","files.autoSave":"off"}\n';
  const bindings = '// continuity binding\n[{"key":"ctrl+alt+k","command":"workbench.action.files.save"}]\n';
  const markerText = `hosted-checkpoint-${Date.now()}`;
  // Reused test computers retain Code's restored tabs. A fresh file per run
  // avoids overwriting an earlier probe behind a restored editor buffer.
  const marker = `continuity-${hash(computerId).slice(0, 10)}-${hash(markerText).slice(0, 10)}.txt`;
  let shortcutChecks = 0;
  let f = await openCode();
  await command(f, 'Preferences: Open User Settings (JSON)'); await setDocument(f, settings); await verifyDarkTheme(f);
  await command(f, 'Preferences: Open Keyboard Shortcuts (JSON)'); await setDocument(f, bindings);
  await command(f, 'File: New Untitled Text File');
  await focusEditor(f); await page.keyboard.type(markerText);
  await command(f,'File: Save As...');
  const saveDialog = f.locator('.quick-input-widget:visible');
  const savePath = saveDialog.getByRole('textbox', { name: 'Folder path - Save As', exact: true });
  await savePath.waitFor({state:'visible'});
  await savePath.fill(`${workspace}/${marker}`);
  await saveDialog.getByRole('button', { name: 'OK', exact: true }).click();
  await savePath.waitFor({state:'hidden',timeout:15000});
  await bounded('saved marker tab',async()=>{
    const tab = f.locator('.tab').filter({hasText:marker});
    return await tab.count() === 1 && !await tab.evaluate(el=>el.classList.contains('dirty'));
  },15000);
  const verifyEditor = async () => {
    f = await openCode();
    await command(f, 'Preferences: Open User Settings (JSON)');
    const restoredSettings = await readDocument(f); assert.ok(restoredSettings.includes('Dark Modern') && restoredSettings.includes('continuity JSONC'), 'Theme JSONC not restored'); await verifyDarkTheme(f);
    assert.match(restoredSettings, /"files\.autoSave"\s*:\s*"off"/, 'Automatic save must stay disabled during shortcut acceptance');
    await command(f, 'Preferences: Open Keyboard Shortcuts (JSON)');
    const restoredBindings = await readDocument(f); assert.ok(restoredBindings.includes('ctrl+alt+k') && restoredBindings.includes('continuity binding'), 'Keybinding JSONC not restored');
    await closeModal(f);
    await f.locator('.command-center').click();
    await f.locator('.quick-input-widget input:visible').fill(marker);
    await f.locator('.quick-input-list .monaco-list-row:visible').filter({hasText:marker}).first().click();
    await wait(1500);
    // Reopened Code may restore a saved model with an earlier file version.
    // Reload disk before editing; the shortcut must still save a new edit.
    await command(f, 'File: Revert File');
    const persistedMarker = await verifyEditorShortcut({
      read: () => readDocument(f), expected: markerText, proof: `shortcut-save-${++shortcutChecks}`,
      append: async proof => {
        await focusEditor(f);
        await page.keyboard.press(editorModifier === 'Meta' ? 'Meta+ArrowDown' : 'Control+End');
        await page.keyboard.type(`\n${proof}`);
        await bounded('rendered shortcut edit',async()=>(await readDocument(f)).includes(proof),10000);
      },
      pressShortcut: async () => {
        const editor = await currentEditor(f);
        const nativeInput = editor.locator('[role="textbox"]:visible');
        const input = await nativeInput.count() ? nativeInput.first() : editor.locator('textarea').last();
        await input.press('Control+Alt+K');
        await bounded('shortcut saved file', () => f.locator('.tabs-container .tab.active.dirty').count().then(count => count === 0), 10000);
      },
      revert: () => command(f, 'File: Revert File'),
    });
    evidence.shortcutSaveChecks = shortcutChecks;
    evidence.checkpointHashes = { settings: hash(restoredSettings), bindings: hash(restoredBindings), marker: hash(persistedMarker) };
  };
  await close('code'); await verifyEditor(); phase('immediate Code close/reopen');
  const processNonce = hash(`${computerId}-${Date.now()}`).slice(0, 24);
  await command(f, 'Terminal: Create New Terminal');
  const terminalInput = () => f.locator('.xterm-helper-textarea').last();
  // An input textarea can exist before the login shell accepts input. Code's
  // shell integration publishes a command decoration after its actual prompt.
  await bounded('terminal prompt', () => f.locator('.xterm-decoration.terminal-command-decoration').count(), 30000);
  await terminalInput().focus();
  // xterm on macOS does not consistently consume Playwright insertText.
  // Send ordinary keyboard input and confirm the command reached the terminal.
  await terminalInput().pressSequentially(terminalContinuityCommand(processNonce));
  await terminalInput().press('Enter');
  const processSample = async (afterSequence = -1) => {
    await command(f, 'Terminal: Focus Terminal');
    return waitForProcessSample({ nonce: processNonce, afterSequence,
      observe: () => f.locator('.xterm-accessibility-tree').last().innerText({ timeout: 5000 }) });
  };
  const initialProcesses = await processSample();
  let latestProcesses = initialProcesses;
  const verifyProcesses = async () => {
    const current = await processSample(latestProcesses.sequence);
    assertProcessContinuity(initialProcesses, current);
    latestProcesses = current;
  };
  await launch('desktop');
  await live(); assert.equal((await relay()).runtimeId, firstRelay.runtimeId, 'Warm Browser open replaced runtime');
  phase('default TURN warm Browser open');
  await waitForDesktopResize(page, resizeObserver);
  const initialDisplay = (await readDesktopReadiness(page)).video;
  const videoFrame = () => page.frames().find(f => /nekodesktop/.test(f.url()));
  const inputBefore = hash(await videoFrame().locator('video').screenshot());
  const uniqueHeading = `continuity-input-${Date.now()}`;
  const staleURL = videoFrame().url();
  // Neko receives pointer and keyboard input through its textarea overlay.
  // Clicking the decoded video is blocked by this intentional input surface.
  const browserInput = videoFrame().locator('textarea.overlay');
  await browserInput.click();
  await bounded('current viewer owns browser control', () => browserInput.evaluate(() => {
    const client = window.$client, remote = client?.$accessor?.remote;
    return client?.connected && client._channel?.readyState === 'open'
      && remote?.controlling && remote.hosting && !remote.locked;
  }), 15000);
  await wait(1000);
  await browserInput.press('Control+l');
  await wait(1000);
  await browserInput.pressSequentially(`data:text/html,<title>${uniqueHeading}</title><body style="background:%23161616;color:white;height:3000px"><h1>${uniqueHeading}</h1><input autofocus><p>scroll marker</p></body>`, { delay: 20 });
  await browserInput.press('Enter');
  if (mode !== 'essential') await bounded('Browser navigation rendered', async () => (await browserSnapshot()).title === uniqueHeading, 15000);
  else await wait(5000);
  // Assert decoded pixels and use the existing signed observation boundary
  // to confirm the navigation and input actually reached cloud Chrome.
  const navigatedFrameHash = hash(await videoFrame().locator('video').screenshot());
  if (mode !== 'essential') assert.equal((await browserSnapshot()).title,uniqueHeading,'Browser navigation did not render requested document');
  assert.notEqual(navigatedFrameHash, inputBefore, 'Navigation produced no visible response');
  await browserInput.pressSequentially('hosted keyboard input', { delay: 20 }); await wait(1500);
  const typedFrameHash = hash(await videoFrame().locator('video').screenshot());
  if (mode !== 'essential') assert.ok((await browserSnapshot()).snapshot.includes('hosted keyboard input'),'Typed input did not reach cloud Chrome');
  assert.notEqual(typedFrameHash, navigatedFrameHash, 'Typing produced no visible response');
  await page.mouse.wheel(0, 300); await wait(1500);
  const scrolledFrameHash = hash(await videoFrame().locator('video').screenshot());
  assert.notEqual(scrolledFrameHash, typedFrameHash, 'Scrolling produced no visible response');
  await page.setViewportSize({ width: 1280, height: 800 });
  await waitForDesktopResize(page, resizeObserver); await live();
  const resizedDisplay = (await readDesktopReadiness(page)).video;
  assert.ok(resizedDisplay.width !== initialDisplay.width || resizedDisplay.height !== initialDisplay.height, 'Viewport resize did not change decoded display dimensions');
  evidence.display = { initial: initialDisplay, resized: resizedDisplay };
  assert.notEqual(hash(await videoFrame().locator('video').screenshot()), inputBefore, 'Browser inputs produced no visible response');
  // Chrome's streamed pixels must contain a deterministic changed page.
  // A screenshot change alone is supporting evidence, not a DOM assertion.
  evidence.input = { beforeFrameHash: inputBefore, afterFrameHash: hash(await videoFrame().locator('video').screenshot()), navigationMarkerHash: hash(uniqueHeading), navigatedFrameHash, typedFrameHash, scrolledFrameHash };
  phase('navigation typing scrolling resize');
  await close('desktop'); await wait(100000);
  assert.equal(await code().evaluate(async () => (await fetch('/healthz')).status), 200, 'Browser close stopped running Code');
  await launch('desktop'); await live();
  await context.setOffline(true); await wait(5000); await context.setOffline(false); await live(); phase('network recovery');
  const other = await context.newPage(); await other.goto('about:blank'); await wait(3000); await page.bringToFront(); await live(); await other.close(); phase('tab return');
  await verifyProcesses(); phase('shared Browser Code terminal continuity');
  await launch('desktop');
  const lifetime = mode === 'full' ? 36 * 60000 : mode === 'short' ? 6 * 60000 : 0;
  if (lifetime) evidence.sessionHold = await verifyRelayLifetime({
    durationMs: lifetime, expectedRuntimeId: firstRelay.runtimeId,
    readRelay: relay, verifyViewer: live, sleep: wait,
  });
  await context.setOffline(true); await wait(3000); await context.setOffline(false); await live(); phase('renewal and reconnect');
  await verifyProcesses();
  evidence.processContinuity = { initialIdentityHash: hash(JSON.stringify(initialProcesses)),
    heartbeatStart: initialProcesses.sequence, heartbeatEnd: latestProcesses.sequence,
    preserved: ['chrome', 'code', 'terminal', 'shell'] };
  // Stop this test-owned foreground probe before deliberate stop/replacement.
  await terminalInput().focus(); await page.keyboard.press('Control+C');
  phase('processes preserved across renewal and reconnect');
  await launch('desktop');
  if (mode !== 'essential') {
    try {
      await fault('turn_unavailable');
      const failure = await api('/api/shell/relay-refresh',{computerId,runtimeId:firstRelay.runtimeId});
      assert.equal(failure.ok,false,'Unavailable real TURN incorrectly passed refresh');
      assert.equal(failure.error,'turn_unavailable','TURN fault did not reach real renewal backend');
      // Exercise the viewer's actual reconnect path while the backend is still
      // unavailable. An API failure alone cannot establish bounded UI recovery.
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await bounded('TURN failure Retry state', async () => {
        const win = page.locator('.window[data-app="desktop"]');
        return await win.getAttribute('data-relay-state') === 'error'
          && await win.locator('.ezil-boot-retry:visible').first().isVisible();
      }, 45000);
      evidence.turnFailureRetry = true;
    } finally {await fault('clear');}
    await page.locator('.window[data-app="desktop"] .ezil-boot-retry:visible').first().click();
    await live(); phase('unavailable TURN explicit failure and recovery');
    try {
      await fault('checkpoint_write_failed');
      const beforeFailedWrite = readCommittedCheckpoint();
      // Force changed bytes while writes are blocked, preventing periodic
      // checkpoints from committing the edit before the stop fault is tested.
      await command(f,'Preferences: Open User Settings (JSON)');
      await setDocument(f,settings + '// force durable checkpoint failure boundary\n');
      await fault('checkpoint_write_failed');
      const failedStop=await api('/api/shell/stop',{computerId});
      assert.equal(failedStop.ok,false,'Failed durable write incorrectly passed final stop');
      assert.equal(failedStop.outcome,'flush_failed','Stop failure did not reach real checkpoint backend');
      assert.equal(failedStop.terminated,false,'Checkpoint failure stopped the runtime');
      assert.equal((await relay()).runtimeId,firstRelay.runtimeId,'Failed checkpoint replaced active runtime');
      const afterFailedWrite = readCommittedCheckpoint();
      assert.deepEqual(afterFailedWrite, beforeFailedWrite, 'Failed checkpoint changed the durable committed head');
      evidence.failedCheckpoint = { preserved: true, ...afterFailedWrite };
    } finally {await fault('clear');}
    phase('checkpoint write failure refuses stop');
  }
  await close('desktop'); await close('code');
  const stopped = await api('/api/shell/stop', { computerId }); assert.ok(stopped.ok && stopped.terminated, 'Final checkpoint/real stop failed');
  // Wrangler's supported R2 object read downloads only this committed head.
  // Capture subprocess output privately; CLI errors may contain object paths.
  evidence.durableCheckpoint = readCommittedCheckpoint();
  phase('final checkpoint and stop');
  if (mode === 'full') await wait(10 * 60000);
  await verifyEditor(); await launch('desktop'); await live();
  const replaced = await relay(); assert.notEqual(replaced.runtimeId, firstRelay.runtimeId, 'Stop/reopen reused old runtime');
  evidence.replacementRuntimeHash = hash(replaced.runtimeId); phase('replacement persistence');
  // Preview hostnames use stable tokens and become active again on reopen.
  // A previous URL after reopen alone would never exercise the 410 recovery.
  // Stop this explicitly isolated runtime with its Browser window still open.
  const staleStop = await api('/api/shell/stop', { computerId });
  assert.ok(staleStop.ok && staleStop.terminated, 'Stale navigation stop failed');
  const staleResponse = page.waitForResponse(response => response.status() === 410
    && new URL(response.url()).origin === new URL(staleURL).origin, { timeout: 30000 });
  await page.evaluate(url => {
    window.__continuityVitals = [];
    const frame = document.querySelector('.window[data-app="desktop"] iframe');
    const stale = new URL(url);
    // The shell owns the current navigation attempt. Replace only runtime
    // identity so the recovery document can still authenticate its message.
    stale.searchParams.set('ezilAttempt', new URL(frame.src).searchParams.get('ezilAttempt'));
    frame.src = stale.href;
  }, staleURL);
  const recoveryDocument = await staleResponse;
  assert.ok((recoveryDocument.headers()['content-type'] || '').includes('text/html'), 'Stale navigation did not serve recovery HTML');
  assert.equal(recoveryDocument.headers()['cache-control'], 'no-store', 'Stale recovery was cacheable');
  assert.ok(!(await recoveryDocument.text()).includes('STALE_PREVIEW_URL'), 'Stale recovery exposed raw JSON');
  await wait(3000); await live();
  assert.notEqual((await relay()).runtimeId, replaced.runtimeId, 'Stale recovery did not open a replacement runtime');
  await verifyEditor();
  for (const frame of page.frames()) {
    const text = await frame.locator('body').innerText({ timeout: 10000 });
    assert.ok(!text.includes('STALE_PREVIEW_URL'), 'Stale navigation exposed raw JSON');
  }
  phase('stale navigation recovery');
  if (mode === 'full') {
    await close('desktop'); await close('code');
    assert.ok((await api('/api/shell/stop', { computerId })).terminated, 'Second stop failed');
    await wait(30 * 60000); await verifyEditor(); phase('30-minute persistence');
  }
  await close('desktop');
  const storageState = await context.storageState();
  resizeObserver.dispose();
  await context.close(); await browser.close();
  browser = await chromium.launch({ args: [...launchArgs, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  context = await browser.newContext({ viewport: {width:1280,height:800}, storageState });
  await configureAppContext(context);
  await context.addInitScript('(' + continuityInit.toString() + ')()');
  page = await context.newPage(); await page.goto(`${APP}/os`);
  resizeObserver = observeScreenResizes(page, APP);
  await bounded('fallback session ready', () => page.evaluate(() => !!window.ezil?.session?.payload?.()?.computer));
  assert.equal(await page.evaluate(() => window.ezil.session.payload().computer.id), computerId, 'Fallback selects another computer');
  fallback = true; await launch('desktop'); await live(); phase('UDP unavailable TCP/TLS fallback');
  const afterIdentity = await verifyCloudDeployment(identityEnv);
  assert.deepEqual(afterIdentity, beforeIdentity, 'Application or Worker identity changed during acceptance');
  const cfAfter = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
  assert.ok(cfAfter.ok); const afterApplications = (await cfAfter.json()).result;
  assert.equal(afterApplications.find(a => a.name === application.name)?.configuration?.image, application.configuration.image, 'Image changed during acceptance');
  evidence.ok = true;
} catch (error) {
  // Exception messages from browser drivers can include URLs/headers. Publish a
  // fixed failure and keep all diagnostics restricted to whitelisted evidence.
  evidence.ok = false; evidence.failure = 'hosted_continuity_acceptance_failed';
  const missing = String(error?.message).match(/^Missing prerequisite: ([A-Z0-9_]+)$/);
  if (missing) evidence.missingPrerequisite = missing[1];
  evidence.failedPhase = evidence.phases.at(-1)?.name || 'setup';
  console.error('FAIL hosted continuity: prerequisite or assertion failed');
  process.exitCode = 1;
} finally {
  resizeObserver?.dispose();
  if (context && verifiedComputer) {
    try {
      // Uses this authenticated context's cookie jar, independently of a
      // working page. The computer was explicitly verified before any launch.
      // APIRequestContext does not traverse the page's Vercel bypass route.
      await stopIsolatedComputer(context, computerId, APP, appHeaders, APP_STOP_FETCH_TIMEOUT_MS);
      evidence.cleanupStopped = true;
    } catch { evidence.cleanupStopped = false; evidence.ok = false; evidence.failure = 'cleanup_stop_failed'; process.exitCode = 1; }
  }
  try { await browser?.close(); } catch { evidence.ok = false; evidence.failure = 'browser_cleanup_failed'; process.exitCode = 1; }
  mkdirSync('hosted-continuity-evidence', { recursive: true });
  writeFileSync(`hosted-continuity-evidence/${process.env.EZIL_CONTINUITY_MODE || 'missing'}.json`, JSON.stringify(evidence, null, 2));
}
