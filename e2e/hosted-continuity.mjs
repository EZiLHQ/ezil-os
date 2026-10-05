/** Hosted acceptance only. No default computer, simulated ICE, or skipped checks. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP, configureAppContext } from './deployed-target.mjs';
import { verifyCloudDeployment } from './verify-cloud-deployment.mjs';

const required = key => { assert.ok(process.env[key], `Missing prerequisite: ${key}`); return process.env[key]; };
const hash = value => createHash('sha256').update(String(value)).digest('hex');
const evidence = { phases: [], samples: [] };
let browser, context, page, beforeIdentity, computerId;
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
  beforeIdentity = await verifyCloudDeployment(process.env);
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
    window.addEventListener('message', e => {
      const frame = document.querySelector('.window[data-app="desktop"] iframe');
      if (!frame || e.source !== frame.contentWindow || e.origin !== new URL(frame.src).origin) return;
      if (e.data?.source !== 'ezil-mobile' || e.data.type !== 'stream_vitals') return;
      if (e.data.attempt !== new URL(frame.src).searchParams.get('ezilAttempt')) return;
      const raw = e.data.vitals;
      if (!raw || typeof raw !== 'object') return;
      // Only public transport counters/enums; never arbitrary client payload.
      const safe = {};
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
  await page.goto(`${APP}/login?method=email`);
  await page.fill('#email', required('EZIL_E2E_EMAIL')); await page.fill('#password', required('EZIL_E2E_PASSWORD'));
  await Promise.all([page.waitForURL(url => !url.pathname.includes('/login'), { timeout: 60000 }), page.locator('form').filter({ has: page.locator('#email') }).locator('button[type=submit]').click()]);
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
  const launch = async app => {
    if (app === 'desktop') await page.evaluate(() => { window.__continuityVitals = []; });
    await page.evaluate(async app => { const payload = window.ezil.session.payload(); await window.ezil.registry.launch(app, { payload, computer: payload.computer, desktopState: payload.desktopState }); }, app);
  };
  const close = app => page.evaluate(app => window.$(`.window[data-app="${app}"]`).close(), app);
  const code = () => page.frames().find(f => /-code\./.test(f.url()));
  const openCode = async () => { await launch('code'); return bounded('Code workbench', async () => { const f = code(); return f && await f.locator('.monaco-workbench').count() ? f : null; }); };
  const command = async (f, text) => {
    await f.locator('.monaco-workbench').click({ position: { x: 350, y: 180 } });
    await page.keyboard.press('F1');
    await f.locator('.quick-input-widget input').fill('>' + text);
    await page.keyboard.press('Enter'); await wait(1200);
  };
  const setDocument = async (f, text) => {
    await f.locator('.monaco-editor:visible textarea').last().focus();
    await page.keyboard.press('Control+A'); await page.keyboard.insertText(text); await page.keyboard.press('Control+S'); await wait(1200);
  };
  const readDocument = f => f.locator('.monaco-editor:visible .view-lines').last().innerText();
  const verifyDarkTheme = async frame => {
    await bounded('rendered dark workbench', async () => frame.locator('.monaco-workbench').evaluate(el => {
      const color = getComputedStyle(el).getPropertyValue('--vscode-editor-background').trim();
      const match = color.match(/^#([a-f0-9]{6})$/i);
      if (!match) return false;
      const rgb = [0,2,4].map(i => parseInt(match[1].slice(i,i+2),16));
      return el.classList.contains('vs-dark') && Math.max(...rgb) < 100;
    }));
  };
  const settings = '// continuity JSONC\n{"workbench.colorTheme":"Default Dark Modern","security.workspace.trust.enabled":false}\n';
  const bindings = '// continuity binding\n[{"key":"ctrl+alt+k","command":"workbench.action.files.save"}]\n';
  const marker = `continuity-${hash(computerId).slice(0, 10)}.txt`;
  const markerText = `hosted-checkpoint-${Date.now()}`;
  let f = await openCode();
  await command(f, 'Preferences: Open User Settings (JSON)'); await setDocument(f, settings); await verifyDarkTheme(f);
  await command(f, 'Preferences: Open Keyboard Shortcuts (JSON)'); await setDocument(f, bindings);
  await command(f, 'File: New Text File');
  await f.locator('.monaco-editor:visible textarea').last().focus(); await page.keyboard.insertText(markerText);
  await page.keyboard.press('Control+Shift+S');
  const savePath = f.locator('.quick-input-widget input'); await savePath.fill(`${workspace}/${marker}`); await page.keyboard.press('Enter'); await wait(2000);
  const verifyEditor = async () => {
    f = await openCode();
    await command(f, 'Preferences: Open User Settings (JSON)');
    const restoredSettings = await readDocument(f); assert.ok(restoredSettings.includes('Default Dark Modern') && restoredSettings.includes('continuity JSONC'), 'Theme JSONC not restored'); await verifyDarkTheme(f);
    await command(f, 'Preferences: Open Keyboard Shortcuts (JSON)');
    const restoredBindings = await readDocument(f); assert.ok(restoredBindings.includes('ctrl+alt+k') && restoredBindings.includes('continuity binding'), 'Keybinding JSONC not restored');
    await page.keyboard.press('Control+P'); await f.locator('.quick-input-widget input').fill(marker); await page.keyboard.press('Enter'); await wait(1500);
    assert.ok((await readDocument(f)).includes(markerText), 'Workspace marker not restored');
    evidence.checkpointHashes = { settings: hash(restoredSettings), bindings: hash(restoredBindings), marker: hash(markerText) };
  };
  await close('code'); await verifyEditor(); phase('immediate Code close/reopen');
  const relay = () => api(`/api/shell/relay-refresh?computerId=${encodeURIComponent(computerId)}`);
  await launch('desktop');
  const sample = async () => {
    await page.evaluate(() => { const f = document.querySelector('.window[data-app="desktop"] iframe'); if (f) f.contentWindow.postMessage({ source: 'ezil-shell', type: 'viewer_probe', attempt: new URL(f.src).searchParams.get('ezilAttempt') }, new URL(f.src).origin); });
    return page.evaluate(() => window.__continuityVitals.at(-1));
  };
  let fallback = false;
  const live = async () => {
    const initial = await bounded('current viewer statistics', sample);
    return bounded('TURN decoded frame progression', async () => {
      const s = await sample(); if (!s || s.bytesReceived <= initial.bytesReceived || s.framesDecoded <= initial.framesDecoded || s.connectionState !== 'connected') return null;
      assert.ok(s.localCandidateType === 'relay' || s.remoteCandidateType === 'relay', 'Selected ICE pair does not use TURN');
      assert.ok(['udp','tcp','tls'].includes(s.relayProtocol), 'Selected TURN protocol missing');
      if (fallback) assert.ok(['tcp','tls'].includes(s.relayProtocol), 'UDP unavailable test did not select TCP/TLS TURN');
      evidence.samples.push(s); return s;
    });
  };
  await live(); const firstRelay = await relay(); assert.ok(firstRelay.ok && firstRelay.runtimeId && firstRelay.expiresAt, 'Relay identity unavailable');
  if (mode === 'short') assert.ok(firstRelay.expiresAt - Date.now() <= 305000, 'Short gate requires supported five-minute TURN credentials');
  if (mode === 'full') assert.ok(firstRelay.expiresAt - Date.now() > 1200000 && firstRelay.expiresAt - Date.now() <= 1805000, 'Full release gate requires production thirty-minute TURN credentials');
  evidence.runtimeHash = hash(firstRelay.runtimeId); phase('default TURN cold open');
  const videoFrame = () => page.frames().find(f => /nekodesktop/.test(f.url()));
  const inputBefore = hash(await videoFrame().locator('video').screenshot());
  const uniqueHeading = `continuity-input-${Date.now()}`;
  const staleURL = videoFrame().url();
  await videoFrame().locator('video').click();
  await page.keyboard.press('Control+L'); await page.keyboard.type(`data:text/html,<title>${uniqueHeading}</title><body style="background:%23161616;color:white;height:3000px"><h1>${uniqueHeading}</h1><input autofocus><p>scroll marker</p></body>`); await page.keyboard.press('Enter'); await wait(5000);
  // Assert decoded pixels and use the existing signed observation boundary
  // to confirm the navigation and input actually reached cloud Chrome.
  const navigatedFrameHash = hash(await videoFrame().locator('video').screenshot());
  if (mode !== 'essential') assert.equal((await browserSnapshot()).title,uniqueHeading,'Browser navigation did not render requested document');
  assert.notEqual(navigatedFrameHash, inputBefore, 'Navigation produced no visible response');
  await page.keyboard.type('hosted keyboard input'); await wait(1500);
  const typedFrameHash = hash(await videoFrame().locator('video').screenshot());
  if (mode !== 'essential') assert.ok((await browserSnapshot()).snapshot.includes('hosted keyboard input'),'Typed input did not reach cloud Chrome');
  assert.notEqual(typedFrameHash, navigatedFrameHash, 'Typing produced no visible response');
  await page.mouse.wheel(0, 300); await wait(1500);
  const scrolledFrameHash = hash(await videoFrame().locator('video').screenshot());
  assert.notEqual(scrolledFrameHash, typedFrameHash, 'Scrolling produced no visible response');
  await page.setViewportSize({ width: 1280, height: 800 }); await live();
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
  const lifetime = mode === 'full' ? 36 * 60000 : mode === 'short' ? 6 * 60000 : 0;
  const until = Date.now() + lifetime;
  let renewed = false;
  while (Date.now() < until) {
    await wait(Math.min(30000, until - Date.now())); await live();
    const current = await relay(); assert.equal(current.runtimeId, firstRelay.runtimeId, 'Renewal replaced runtime');
    renewed ||= current.expiresAt > firstRelay.expiresAt;
  }
  if (lifetime) assert.ok(renewed, 'Automatic credential renewal did not occur');
  await context.setOffline(true); await wait(3000); await context.setOffline(false); await live(); phase('renewal and reconnect');
  if (mode !== 'essential') {
    try {
      await fault('turn_unavailable');
      const failure = await api('/api/shell/relay-refresh',{computerId,runtimeId:firstRelay.runtimeId});
      assert.equal(failure.ok,false,'Unavailable real TURN incorrectly passed refresh');
      assert.equal(failure.error,'turn_unavailable','TURN fault did not reach real renewal backend');
    } finally {await fault('clear');}
    await live(); phase('unavailable TURN explicit failure and recovery');
    // Force changed bytes so checkpoint cannot reuse an unchanged generation.
    await command(f,'Preferences: Open User Settings (JSON)');
    await setDocument(f,settings + '// force durable checkpoint failure boundary\n');
    try {
      await fault('checkpoint_write_failed');
      const failedStop=await api('/api/shell/stop',{computerId});
      assert.equal(failedStop.ok,false,'Failed durable write incorrectly passed final stop');
      assert.equal(failedStop.terminated,false,'Checkpoint failure stopped the runtime');
      assert.equal((await relay()).runtimeId,firstRelay.runtimeId,'Failed checkpoint replaced active runtime');
    } finally {await fault('clear');}
    phase('checkpoint write failure refuses stop');
  }
  await close('desktop'); await close('code');
  const stopped = await api('/api/shell/stop', { computerId }); assert.ok(stopped.ok && stopped.terminated, 'Final checkpoint/real stop failed');
  const checkpointKey = `${required('EZIL_E2E_R2_PREFIX').replace(/^\/+|\/+$/g, '')}/.ezil-snapshots/latest.json`;
  // Wrangler's supported R2 object read downloads only this committed head.
  // Capture subprocess output privately; CLI errors may contain object paths.
  const checkpointDir = mkdtempSync(join(tmpdir(), 'ezil-checkpoint-'));
  let checkpoint;
  try {
    const checkpointFile = join(checkpointDir, 'head.json');
    execFileSync(required('EZIL_WRANGLER_BIN'), ['r2','object','get',`${required('EZIL_E2E_R2_BUCKET')}/${checkpointKey}`,'--remote','--file',checkpointFile], {
      stdio: 'pipe', timeout: 30000, env: process.env,
    });
    checkpoint = JSON.parse(readFileSync(checkpointFile,'utf8'));
  } finally { rmSync(checkpointDir,{recursive:true,force:true}); }
  assert.equal(checkpoint.version, 1, 'Durable checkpoint format invalid');
  assert.match(checkpoint.sha256, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(checkpoint.chunks) && checkpoint.chunks.length, 'Durable checkpoint chunks missing');
  evidence.durableCheckpoint = { sha256: checkpoint.sha256, manifestHash: hash(JSON.stringify(checkpoint)), chunks: checkpoint.chunks.length };
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
    const text = await frame.locator('body').innerText().catch(() => '');
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
  await context.close(); await browser.close();
  browser = await chromium.launch({ args: [...launchArgs, '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
  context = await browser.newContext({ viewport: {width:1280,height:800}, storageState });
  await configureAppContext(context);
  await context.addInitScript('(' + continuityInit.toString() + ')()');
  page = await context.newPage(); await page.goto(`${APP}/os`);
  await bounded('fallback session ready', () => page.evaluate(() => !!window.ezil?.session?.payload?.()?.computer));
  assert.equal(await page.evaluate(() => window.ezil.session.payload().computer.id), computerId, 'Fallback selects another computer');
  fallback = true; await launch('desktop'); await live(); phase('UDP unavailable TCP/TLS fallback');
  const afterIdentity = await verifyCloudDeployment(process.env);
  assert.deepEqual(afterIdentity, beforeIdentity, 'Application or Worker identity changed during acceptance');
  const cfAfter = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/containers/applications`, { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, signal: AbortSignal.timeout(15000) });
  assert.ok(cfAfter.ok); const afterApplications = (await cfAfter.json()).result;
  assert.equal(afterApplications.find(a => a.name === application.name)?.configuration?.image, application.configuration.image, 'Image changed during acceptance');
  evidence.ok = true;
} catch (error) {
  // Exception messages from browser drivers can include URLs/headers. Publish a
  // fixed failure and keep all diagnostics restricted to whitelisted evidence.
  evidence.ok = false; evidence.failure = 'hosted_continuity_acceptance_failed';
  const missing = String(error?.message).match(/^Missing prerequisite: ([A-Z_]+)$/);
  if (missing) evidence.missingPrerequisite = missing[1];
  evidence.failedPhase = evidence.phases.at(-1)?.name || 'setup';
  console.error('FAIL hosted continuity: prerequisite or assertion failed');
  process.exitCode = 1;
} finally {
  if (page && computerId) {
    try {
      const selected = await page.evaluate(() => window.ezil?.session?.payload?.()?.computer?.id);
      if (selected === computerId) {
        const stopped = await page.evaluate(async computerId => { const r = await fetch('/api/shell/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerId }) }); return r.ok && (await r.json()).terminated; }, computerId);
        assert.ok(stopped, 'Cleanup stop failed'); evidence.cleanupStopped = true;
      }
    } catch { evidence.cleanupStopped = false; evidence.ok = false; evidence.failure = 'cleanup_stop_failed'; process.exitCode = 1; }
  }
  try { await browser?.close(); } catch { evidence.ok = false; evidence.failure = 'browser_cleanup_failed'; process.exitCode = 1; }
  mkdirSync('hosted-continuity-evidence', { recursive: true });
  writeFileSync(`hosted-continuity-evidence/${process.env.EZIL_CONTINUITY_MODE || 'missing'}.json`, JSON.stringify(evidence, null, 2));
}
