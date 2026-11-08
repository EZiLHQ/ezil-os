// Coordinator-run real shell -> real Code -> extension host -> renderer -> Worker bridge -> shell store QA.
// Args: <container bridge IP> <evidence directory>. Node with TypeScript stripping, Playwright already installed.
// Artifacts contain only fixed pass/fail lines and screenshots with every iframe masked. No trace/HAR/console.
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import net from 'node:net';
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_NAME } from './code-app-failure-mock.mjs';
import { assertFailureRecord } from './code-app-failure-support.mjs';
import { randomUUID } from 'node:crypto';

const [CS_IP, EVIDENCE] = process.argv.slice(2);
const TREE = fileURLToPath(new URL('..', import.meta.url));
const variant = process.env.FAULT_VARIANT || 'missing_terminal';
const computerId = '11111111-1111-4111-8111-111111111111';
const lines = [];
let browser, shell, editor;
const sockets = new Set();
let phase = 'preflight';
const pass = label => { lines.push(`PASS ${label}`); process.stdout.write(`PASS ${label}\n`); };
const track = server => server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
try {
  assert.ok(net.isIP(CS_IP) && EVIDENCE);
  assert.ok(['missing_terminal', 'settlement_pending'].includes(variant));
  mkdirSync(EVIDENCE, { recursive: true });
  const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
  const { chromium } = require('playwright');
  const { injectCodeFolderBridge } = await import(new URL('../worker/src/code-folder-bridge.ts', import.meta.url));
  const { injectCodeDiagBridge } = await import(new URL('../worker/src/code-diag-bridge.ts', import.meta.url));
  // Test-side validation only: the consumer's own validator, imported from its source. The served bundle is NOT changed.
  const { validate_failure } = await import(new URL('../shell/ezil/ui/feedback/app-failures.js', import.meta.url));
  const assets = path.resolve(process.env.SHELL_ASSETS_DIR || path.join(TREE, 'app/public/os'));
  // The production shell bundle, byte for byte: the consumer is reached only through its public Feedback UI.
  const bundle = readFileSync(path.join(assets, 'bundle.min.js'));
  // The real serialized feedback submission, kept in memory for assertions only (never written to evidence).
  const submissions = [];
  let shellOrigin = '', editorOrigin = '', folderInjections = 0, diagInjections = 0;
  const types = { '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
  shell = track(createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/os/bundle.min.js') { res.setHeader('content-type', types['.js']); res.end(bundle); return; }
    if (url.pathname.startsWith('/os/')) {
      const file = path.resolve(assets, url.pathname.slice(4));
      if (file.startsWith(`${assets}${path.sep}`) && existsSync(file) && statSync(file).isFile()) {
        res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream'); res.end(readFileSync(file));
      } else { res.statusCode = 404; res.end(); }
      return;
    }
    // No endpoint inspects a request body. The test has one known workspace and never submits feedback.
    if (url.pathname === '/api/shell/code-preview-url') return json({ ok: true,
      codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=fixture&path=%2F&folder=%2Fworkspace` });
    if (url.pathname === '/api/shell/desktop') {
      if (url.searchParams.get('confirm') === 'frame') return json({ ok: true, confirmed: true, status: 200 });
      return json(req.method === 'POST' ? { ok: true, guacamoleUrl: `${shellOrigin}/blank`, frame: { confirmed: true } }
        : { ok: true, guacamoleRunning: true });
    }
    if (url.pathname === '/api/feedback' && req.method === 'POST') {
      const chunks = []; req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => { submissions.push(Buffer.concat(chunks).toString('utf8')); res.statusCode = 201; json({ id: randomUUID() }); });
      return;
    }
    if (url.pathname === '/api/feedback') { res.statusCode = 405; res.end(); return; }
    if (url.pathname.startsWith('/api/trpc/')) return json({ result: { data: { json: null } } });
    if (url.pathname.startsWith('/api/')) return json({ ok: true });
    res.setHeader('content-type', 'text/html');
    if (url.pathname === '/blank') { res.end('<!doctype html><body>'); return; }
    if (url.pathname !== '/os' && url.pathname !== '/app/code') { res.statusCode = 404; res.end(); return; }
    res.end('<!doctype html><html><head><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
  }));
  editor = track(createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/preview-bootstrap') {
      const to = new URLSearchParams({ folder: '/workspace' });
      if (url.searchParams.has('ezil_mint')) to.set('ezil_mint', url.searchParams.get('ezil_mint'));
      res.writeHead(302, { location: `/?${to}` }); res.end(); return;
    }
    if (url.pathname === '/unregistered') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>'); return; }
    const headers = { ...req.headers, 'x-forwarded-host': req.headers.host };
    delete headers['accept-encoding'];
    const up = httpRequest({ host: CS_IP, port: Number(process.env.CODE_SERVER_PORT || 8443), method: req.method, path: req.url, headers }, ur => {
      const html = req.method === 'GET' && url.pathname === '/' && ur.statusCode === 200 && /text\/html/.test(ur.headers['content-type'] || '');
      if (!html) { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); return; }
      const chunks = []; ur.on('data', chunk => chunks.push(chunk)); ur.on('end', () => {
        const out = injectCodeDiagBridge(injectCodeFolderBridge(Buffer.concat(chunks).toString('utf8'), [shellOrigin]), [shellOrigin]);
        if (out.includes('data-ezil-folder-bridge')) folderInjections++;
        if (out.includes('data-ezil-diag-bridge')) diagInjections++;
        const h = { ...ur.headers }; delete h['content-length'];
        res.writeHead(ur.statusCode, h); res.end(out);
      });
    });
    up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(up);
  }));
  editor.on('upgrade', (req, socket, head) => {
    const up = net.connect(Number(process.env.CODE_SERVER_PORT || 8443), CS_IP, () => {
      const headers = { ...req.headers, 'x-forwarded-host': req.headers.host };
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    sockets.add(up); up.on('close', () => sockets.delete(up));
    up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
    socket.on('close', () => up.destroy());
  });
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => editor.listen(0, '127.0.0.1', resolve));
  shellOrigin = `http://127.0.0.1:${shell.address().port}`;
  editorOrigin = `http://127.0.0.1:${editor.address().port}`;
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return [shellOrigin, editorOrigin].includes(url.origin) ? route.continue() : route.abort();
  });
  await context.addInitScript(({ computerId, shellOrigin, editorOrigin }) => {
    if (window.parent !== window) return;
    window.__EZIL_BOOT__ = { user: { id: '33333333-3333-4333-8333-333333333333', email: 'fixture@example.test' },
      computer: { id: computerId, name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }],
      desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: { feedback: `${shellOrigin}/api/feedback` },
        ui: { floatingControls: false, feedbackScreenshots: false, feedbackAppFailures: true } } };
    history.replaceState({ ...history.state, __NA: true }, '', location.href);
    window.__failureWire = { ready: [], failures: [] };
    window.addEventListener('message', event => {
      const iframe = [...document.querySelectorAll('iframe')].find(el => el.contentWindow === event.source && el.src.startsWith(editorOrigin));
      if (!iframe || event.origin !== editorOrigin) return;
      if (event.data?.type === 'ezil.code.diag.ready') window.__failureWire.ready.push(event.data);
      if (event.data?.type === 'ezil.code.failure') window.__failureWire.failures.push(event.data);
    });
  }, { computerId, shellOrigin, editorOrigin });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  // The real Feedback dialog: category Other (no bug fields), a synthetic description, diagnostics on, preview open.
  const openFeedback = async () => {
    await page.locator('button.ezil-feedback-chip').click();
    const dialog = page.locator('dialog.ezil-feedback-dialog'); await dialog.waitFor();
    await dialog.locator('input[name="category"][value="other"]').check();
    await dialog.locator('textarea[name="description"]').fill('Synthetic transport check report.');
    await dialog.locator('input[name="diagnostics"]').check();
    await dialog.locator('.ezil-feedback-preview summary').click();
    return dialog;
  };
  const previewOf = dialog => dialog.locator('.ezil-feedback-preview pre').evaluate(el => el.textContent);
  const appStatusOf = dialog => dialog.locator('[data-role="app-failure-context"]').evaluate(el => ({ hidden: el.hidden, text: el.textContent }));
  const screenshot = name => page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), mask: [page.locator('iframe')] });
  phase = 'real shell and Code readiness';
  await page.goto(`${shellOrigin}/app/code`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__failureWire?.ready.length > 0, null, { timeout: 120_000 });
  const frame = page.frames().find(f => f !== page.mainFrame() && f.url().startsWith(`${editorOrigin}/?`));
  assert.ok(frame); await frame.locator('.monaco-workbench').waitFor({ timeout: 120_000 });
  assert.ok(folderInjections && diagInjections);
  const ready = await page.evaluate(() => window.__failureWire.ready.at(-1));
  assert.deepEqual(Object.keys(ready).sort(), ['nonce', 'type', 'v']); assert.equal(ready.v, 1);
  {
    // Healthy, zero errors: the real preview carries no app failure and does not call the context unavailable.
    const dialog = await openFeedback();
    const healthy = JSON.parse(await previewOf(dialog));
    assert.equal((healthy.diagnostics.appFailures ?? []).length, 0);
    const status = await appStatusOf(dialog); assert.ok(!/unavailable/i.test(status.text));
    await dialog.locator('[data-action="cancel"]').click(); await dialog.waitFor({ state: 'detached' }).catch(() => {});
  }
  pass('real registered Code frame answered diag.ready; the real Feedback preview shows app failure context available and empty');
  await screenshot('01-ready');

  phase = 'real chat model selection and send';
  const aux = frame.locator('.part.auxiliarybar');
  await aux.waitFor({ timeout: 120_000 });
  const modelButton = aux.locator('.action-label[aria-label^="Models, "]').first();
  await modelButton.waitFor({ timeout: 120_000 });
  // The composer shortens the visible label on narrow panels ("Qwen3 Cod…"); the accessible label keeps the full name.
  const selected = async () => `${await modelButton.getAttribute('aria-label')} ${await modelButton.innerText()}`.includes(MODEL_NAME);
  // EZiL Models registers its catalog models after the chat view renders ("Auto" until then): wait for the default.
  for (let i = 0; i < 60 && !(await selected()); i++) await page.waitForTimeout(1000);
  if (!(await selected())) {
    await modelButton.click();
    const rows = frame.locator('.context-view .monaco-list-row, .action-widget .monaco-list-row, .monaco-menu .action-item');
    let model = rows.filter({ hasText: MODEL_NAME }).first();
    if (!(await model.count())) {
      const other = rows.filter({ hasText: /^\s*Other Models/ }).first();
      if (await other.count()) { await other.hover(); await other.click(); }
    }
    await model.waitFor(); await model.click();
  }
  assert.ok(await selected());
  const input = aux.locator('.chat-input-container .monaco-editor').first();
  await input.locator('.view-lines').first().click({ force: true });
  await page.keyboard.type('Reply briefly for this synthetic transport check.', { delay: 3 });
  // No input text or response text crosses back into Node or an artifact.
  await page.keyboard.press('Enter');
  pass('one synthetic chat message sent through real UI with the mock model selected');

  phase = 'failure UI and bridge delivery';
  // Read text only inside the page to detect the known failure UI; return a boolean, never the transcript.
  await frame.waitForFunction(() => {
    const chat = document.querySelector('.part.auxiliarybar .interactive-list');
    return !!chat && /interrupted|settlement.pending|provider.error|stream.interrupted/i.test(chat.textContent || '');
  }, null, { timeout: 120_000 });
  // Copilot sends several model requests for one message (the turn and its side requests); the mock fails each.
  const requests = () => JSON.parse(execFileSync('docker', ['exec', process.env.CONTAINER, 'curl', '-fsS', 'http://127.0.0.1:4142/stats'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).messages;
  const delivered = () => page.evaluate(() => window.__failureWire.failures.length);
  let settled = -1;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(1500);
    const count = await delivered();
    if (count > 0 && count === settled && count === requests()) break;
    settled = count;
  }
  const sent = requests(); assert.ok(sent >= 1);
  const wire = await page.evaluate(() => window.__failureWire.failures);
  assert.equal(wire.length, sent);
  const failures = wire.map(message => {
    assert.deepEqual(Object.keys(message).sort(), ['failure', 'nonce', 'type', 'v']);
    assert.equal(message.nonce, ready.nonce); assert.equal(message.v, 1);
    assertFailureRecord(message.failure, variant); assert.deepEqual(validate_failure(message.failure), message.failure);
    return message.failure;
  });
  assert.equal(new Set(failures.map(f => f.clientRequestId)).size, failures.length);
  assert.equal(new Set(failures.map(f => f.eventId)).size, failures.length);
  const ids = failures.map(f => f.eventId).sort();
  pass(`failure visible; the bridge delivered one canonical envelope per real model request (${sent}), each with its own client key and the mock Gateway ID`);
  await screenshot('02-failure-masked');

  phase = 'consumer negative controls';
  // A same-origin sibling bypasses the bridge and posts a valid envelope directly; the consumer must reject its source.
  await page.evaluate(origin => { const el = document.createElement('iframe'); el.id = 'unregistered'; el.src = `${origin}/unregistered`; document.body.append(el); }, editorOrigin);
  await page.locator('#unregistered').waitFor();
  const rogue = await page.locator('#unregistered').elementHandle().then(el => el.contentFrame());
  await rogue.waitForURL(`${editorOrigin}/unregistered`, { waitUntil: 'domcontentloaded' });
  await rogue.evaluate(({ origin, nonce, failure }) => parent.postMessage({ type: 'ezil.code.failure', v: 1, nonce,
    failure: { ...failure, eventId: 'a0000000-0000-4000-8000-0000000000e2' } }, origin), { origin: shellOrigin, nonce: ready.nonce, failure: failures[0] });
  // Registered frame, correct nonce and origin, but a forged extra field.
  await frame.evaluate(({ origin, nonce, failure }) => parent.postMessage({ type: 'ezil.code.failure', v: 1, nonce,
    failure: { ...failure, eventId: 'a0000000-0000-4000-8000-0000000000e3', extra: {} } }, origin), { origin: shellOrigin, nonce: ready.nonce, failure: failures[0] });
  await page.waitForTimeout(500);
  await page.locator('#unregistered').evaluate(el => el.remove());

  phase = 'real feedback preview and submission';
  const dialog = await openFeedback();
  await page.waitForFunction(count => {
    try { return JSON.parse(document.querySelector('.ezil-feedback-preview pre').textContent).diagnostics.appFailures.length === count; }
    catch { return false; }
  }, failures.length);
  const previewText = await previewOf(dialog);
  const preview = JSON.parse(previewText).diagnostics.appFailures;
  // Exactly the bridge-delivered set: neither the unregistered frame's post nor the extra-key forgery got in.
  assert.deepEqual(preview.map(entry => entry.eventId).sort(), ids);
  for (const { app, ageMs, ...entry } of preview) {
    assert.equal(app, 'code'); assert.ok(Number.isInteger(ageMs) && ageMs >= 0 && ageMs <= 1800000);
    assert.deepEqual(entry, failures.find(f => f.eventId === entry.eventId));
  }
  const status = await appStatusOf(dialog);
  assert.equal(status.hidden, false); assert.equal(status.text, `${failures.length} app events (0 cancelled).`);
  pass('consumer rejected the unregistered frame and the extra-key forgery: the real preview holds exactly the delivered records');
  await page.waitForTimeout(100);
  assert.equal(await previewOf(dialog), previewText); // frozen
  await screenshot('03-frozen-preview');
  await dialog.locator('button[type="submit"]').click();
  await page.waitForFunction(() => /Thanks/.test(document.querySelector('dialog.ezil-feedback-dialog .ezil-feedback-result')?.textContent || ''));
  assert.equal(submissions.length, 1);
  // The exact visible preview string is the request body (feedback.js deliver()).
  assert.equal(submissions[0], previewText);
  assert.deepEqual(JSON.parse(submissions[0]).diagnostics.appFailures, preview);
  pass('the real Feedback submission POSTed exactly the previewed body, with every app-failure record');
} catch {
  // Never print assertion operands, Playwright errors, stacks, console output, HTML or transcripts.
  lines.push(`FAIL ${phase}`); process.stderr.write(`FAIL ${phase}\n`); process.exitCode = 1;
} finally {
  if (EVIDENCE) { mkdirSync(EVIDENCE, { recursive: true }); writeFileSync(path.join(EVIDENCE, 'result.log'), `${lines.join('\n')}\n`); }
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  for (const server of [shell, editor]) if (server?.listening) await new Promise(resolve => server.close(resolve));
}
