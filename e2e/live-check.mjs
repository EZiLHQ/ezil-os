/** Fast deployed smoke test. No Playwright or deployment imports during unit tests. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const MAX_RUN_MS = 8 * 60_000;
export const CHECK_NAMES = Object.freeze([
  'setup', 'sign-in', 'os-session-ready', 'warm-browser-paint',
  'relay-read', 'relay-renew', 'warm-code-ready', 'warm-terminal',
  'close-windows', 'stop', 'cold-os-session-ready', 'cold-browser-paint',
  'close-desktop', 'cold-code-ready', 'cold-marker', 'browser-close',
  'deadline', 'evidence',
]);

/** Terminal accessibility text may soft-wrap anywhere. The printf command
 * keeps its marker separate from "[", so even its echo cannot match output. */
export function parseTerminalMarker(text, marker) {
  if (typeof text !== 'string' || typeof marker !== 'string' || !marker) return null;
  const compact = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\s/g, '');
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...compact.matchAll(new RegExp(`${escaped}\\[([^\\]]*)\\]`, 'g'))].at(-1)?.[1] ?? null;
}

/** Commands only accept our random hex nonce, never user-provided shell text. */
export function terminalProbeCommand(nonce, cold = false) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{20}$/.test(nonce)) throw new Error('Invalid probe nonce');
  if (cold) {
    return `opencode --version >/dev/null 2>&1 && printf '%s[%s]\\n' C${nonce} "$(cat /root/.ezil-live-mark 2>/dev/null)"`;
  }
  const session = `ezil_live_${nonce}`;
  return `tmux new-session -d -s ${session} 'sleep 600' && tmux has-session -t ${session}`
    + ` && opencode --version >/dev/null 2>&1 && printf '%s\\n' ${nonce} > /root/.ezil-live-mark`
    + ` && printf '%s[%s]\\n' W${nonce} ok; tmux kill-session -t ${session} >/dev/null 2>&1`;
}

/** Allowlist evidence instead of trying to scrub arbitrary driver/API errors.
 * No URLs, IDs, terminal output, headers, cookies, or error messages survive. */
export function redactEvidence(value) {
  const known = CHECK_NAMES.includes(value?.check);
  const validMs = Number.isFinite(value?.ms) && value.ms >= 0;
  return {
    check: known ? value.check : 'unknown',
    ok: known && validMs && value?.ok === true,
    ms: validMs ? Math.round(value.ms) : 0,
  };
}

export function aggregateResults(checks) {
  const safe = checks.map(redactEvidence);
  return { result: safe.length > 0 && safe.every(check => check.ok) ? 'PASS' : 'FAIL', checks: safe };
}

export function isRealStop(response) {
  return response?.status === 200 && response.json?.ok === true
    && response.json.outcome === 'destroyed' && response.json.terminated === true;
}

export function isValidRelayRenewal(read, response, now) {
  const renew = response?.json;
  return response?.status === 200 && renew?.ok === true
    && typeof read?.runtimeId === 'string' && read.runtimeId.length > 0
    && renew.runtimeId === read.runtimeId
    && Number.isSafeInteger(read.expiresAt) && Number.isSafeInteger(renew.expiresAt)
    && renew.expiresAt > now && renew.expiresAt > read.expiresAt;
}

async function bounded(action, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Deadline exceeded')), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function runLiveCheck() {
  const started = performance.now();
  // Reserve time for failure evidence and browser shutdown within the hard cap.
  const deadline = started + MAX_RUN_MS - 15_000;
  const out = resolve(process.env.EZIL_LIVE_OUT || join(tmpdir(), 'ezil-live-check'));
  const checks = [];
  const abort = new AbortController();
  let browser, context, page, target, deployment, signIn, active, stepDeadline;
  let finished = false;
  const emit = value => writeSync(1, `${JSON.stringify(value)}\n`);
  const record = (check, ok, ms) => {
    const result = redactEvidence({ check, ok, ms });
    checks.push(result);
    emit(result);
  };
  const remaining = (limit = 10_000) => {
    const ms = Math.min(limit, deadline - performance.now(), (stepDeadline ?? deadline) - performance.now());
    if (abort.signal.aborted || ms <= 0) throw new Error('Deadline exceeded');
    return Math.max(1, Math.floor(ms));
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    try { writeFileSync(join(out, 'live-check.json'), `${JSON.stringify(aggregateResults(checks), null, 2)}\n`, { mode: 0o600 }); }
    catch { record('evidence', false, 0); }
    const report = aggregateResults(checks);
    emit(report);
    process.exitCode = report.result === 'PASS' ? 0 : 1;
  };
  const hardTimer = setTimeout(() => {
    if (active) record(active.check, false, performance.now() - active.started);
    else record('deadline', false, performance.now() - started);
    finish();
    process.exit(1);
  }, MAX_RUN_MS);

  // Route-handler rejections can contain headers/URLs in Playwright call logs.
  // Convert them to a failed current check without ever printing the exception.
  let rejectRoute;
  const routeFailure = new Promise((_, reject) => { rejectRoute = reject; });
  routeFailure.catch(() => {});
  const onUnhandled = () => rejectRoute(new Error('Browser request failed'));
  process.on('unhandledRejection', onUnhandled);

  async function check(name, timeout, action) {
    active = { check: name, started: performance.now() };
    stepDeadline = Math.min(deadline, active.started + timeout);
    try {
      const result = await bounded(() => Promise.race([action(), routeFailure]), remaining(timeout));
      record(name, true, performance.now() - active.started);
      return result;
    } catch {
      record(name, false, performance.now() - active.started);
      throw new Error('Live check failed');
    } finally { active = undefined; stepDeadline = undefined; }
  }

  async function go(path) {
    for (let attempt = 1; ; attempt++) {
      try { return await page.goto(`${target.app}${path}`, { waitUntil: 'domcontentloaded', timeout: remaining(60_000) }); }
      catch (error) {
        if (attempt >= 5 || !/ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_NAME/.test(String(error))) throw error;
        await sleep(remaining(3000));
      }
    }
  }

  async function sessionReady() {
    await go('/os');
    await page.waitForFunction(() => !!window.ezil?.session?.payload?.()?.computer?.id,
      null, { timeout: remaining(60_000) });
    return page.evaluate(() => window.ezil.session.payload().computer.id);
  }

  async function api(path, body, timeout = 60_000) {
    const cookies = await context.cookies(target.app);
    const response = await deployment.appRequest(`${target.app}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...target.headers, cookie: deployment.cookieHeader(cookies),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout: remaining(timeout), signal: abort.signal,
    });
    let json = null;
    try { json = JSON.parse(response.body.toString('utf8')); } catch {}
    return { status: response.status, json };
  }

  async function openBrowserAndPaint() {
    // Stable app identity avoids accidentally clicking another pinned app.
    await page.locator('.taskbar-item[data-app="desktop"]').first().click({ timeout: remaining(12_000) });
    for (;;) {
      remaining();
      for (const frame of page.frames().filter(frame => /nekodesktop/.test(frame.url()))) {
        const painted = await frame.evaluate(() => {
          const video = document.querySelector('video');
          if (!video?.videoWidth || video.readyState < 2) return false;
          const canvas = document.createElement('canvas');
          canvas.width = 64; canvas.height = 36;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, 64, 36);
          const pixels = ctx.getImageData(0, 0, 64, 36).data;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 30) return true;
          }
          return false;
        }).catch(() => false);
        if (painted) return;
      }
      await sleep(remaining(1000));
    }
  }

  async function codeFrame() {
    await page.evaluate(async () => {
      const payload = window.ezil.session.payload();
      await window.ezil.registry.launch('code', { payload, computer: payload.computer, desktopState: payload.desktopState });
    });
    for (;;) {
      remaining();
      for (const frame of page.frames().filter(frame => /-code\./.test(frame.url()))) {
        if (await frame.locator('.monaco-workbench').isVisible().catch(() => false)) return frame;
      }
      await sleep(remaining(1000));
    }
  }

  async function command(frame, name, id) {
    const quick = frame.locator('.quick-input-widget input:visible');
    for (let attempt = 0; attempt < 5; attempt++) {
      remaining();
      try {
        if (!await quick.isVisible()) await frame.locator('.command-center').click({ timeout: remaining(2000) });
        await quick.fill(`>${name}`, { timeout: remaining(2000) });
        await frame.locator(`.quick-input-list .monaco-list-row:visible [data-quick-input-id="${id}"]`)
          .click({ timeout: remaining(3000) });
        return;
      } catch { await sleep(remaining(1000)); }
    }
    throw new Error('Code command unavailable');
  }

  async function terminalRun(frame, cmd, marker) {
    if (!await frame.getByText('Screen Reader Optimized', { exact: true }).count()) {
      await command(frame, 'Toggle Screen Reader Accessibility Mode', 'editor.action.toggleScreenReaderAccessibilityMode');
      await sleep(remaining(1000));
    }
    await command(frame, 'Terminal: Create New Terminal', 'workbench.action.terminal.new');
    // Keep the prototype's brief shell-startup grace: the old terminal may
    // remain visible while Code creates and focuses the new terminal.
    await sleep(remaining(4000));
    await frame.locator('.xterm-screen').last().click({ timeout: remaining() });
    const input = frame.locator('.xterm-helper-textarea').last();
    await input.pressSequentially(cmd, { delay: 1, timeout: remaining() });
    await input.press('Enter', { timeout: remaining() });
    for (;;) {
      const text = await frame.locator('.xterm-accessibility-tree').last()
        .innerText({ timeout: remaining(2000) }).catch(() => '');
      const result = parseTerminalMarker(text, marker);
      if (result !== null) return result;
      await sleep(remaining(1000));
    }
  }

  async function closeWindows(selector) {
    await page.evaluate(selector => {
      for (const win of document.querySelectorAll(selector)) window.$(win).close();
    }, selector);
    await page.waitForFunction(selector => document.querySelectorAll(selector).length === 0,
      selector, { timeout: remaining() });
  }

  async function failureScreenshot() {
    if (!page || page.isClosed()) return;
    // Remote pixels/terminal text can contain arbitrary secrets. Preserve host
    // layout only; never fall back to an unmasked screenshot or dump HTML.
    await page.screenshot({ path: join(out, 'live-failure.png'), timeout: 4000,
      mask: [page.locator('iframe, input, textarea, video, canvas, img, svg, object, embed')],
      style: `*, *::before, *::after { color: transparent !important;
        -webkit-text-fill-color: transparent !important; text-shadow: none !important;
        background-image: none !important; caret-color: transparent !important; }
        iframe, input, textarea, video, canvas, img, svg, object, embed { visibility: hidden !important; }`,
    }).catch(() => {});
  }

  try {
    await check('setup', 30_000, async () => {
      mkdirSync(out, { recursive: true, mode: 0o700 });
      if (!process.env.EZIL_E2E_EMAIL || !process.env.EZIL_E2E_PASSWORD || !process.env.PLAYWRIGHT_REQUIRE_DIR) {
        throw new Error('Missing live check inputs');
      }
      deployment = await import('./deployed-target.mjs');
      target = deployment.deployedTarget();
      ({ signIn } = await import('./sign-in.mjs'));
      const require = createRequire(join(resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'live-check.cjs'));
      const { chromium } = require('playwright');
      browser = await chromium.launch({ headless: true, timeout: remaining(25_000),
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
      context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(10_000);
      await deployment.configureAppContext(context, target);
      page = await context.newPage();
    });
    await check('sign-in', 90_000, async () => {
      await go('/login?method=email&returnUrl=%2Fcomputers');
      await signIn(page, { email: process.env.EZIL_E2E_EMAIL, password: process.env.EZIL_E2E_PASSWORD, destination: '/computers' });
    });
    const computerId = await check('os-session-ready', 60_000, sessionReady);
    await check('warm-browser-paint', 120_000, openBrowserAndPaint);
    const relay = await check('relay-read', 60_000, async () => {
      const response = await api(`/api/shell/relay-refresh?computerId=${encodeURIComponent(computerId)}`);
      if (response.status !== 200 || response.json?.ok !== true || !response.json.runtimeId
          || !Number.isSafeInteger(response.json.expiresAt) || response.json.expiresAt <= Date.now()) {
        throw new Error('Relay read failed');
      }
      return response.json;
    });
    await check('relay-renew', 60_000, async () => {
      const response = await api('/api/shell/relay-refresh', { computerId, runtimeId: relay.runtimeId });
      if (!isValidRelayRenewal(relay, response, Date.now())) throw new Error('Relay renewal failed');
    });
    const nonce = randomBytes(10).toString('hex');
    const warmFrame = await check('warm-code-ready', 60_000, codeFrame);
    await check('warm-terminal', 45_000, async () => {
      if (await terminalRun(warmFrame, terminalProbeCommand(nonce), `W${nonce}`) !== 'ok') {
        throw new Error('Terminal probe failed');
      }
    });
    await check('close-windows', 15_000, () => closeWindows('.window'));
    if (process.env.EZIL_LIVE_SKIP_COLD !== '1') {
      await check('stop', 290_000, async () => {
        if (!isRealStop(await api('/api/shell/stop', { computerId }, 290_000))) throw new Error('Real stop unconfirmed');
      });
      await check('cold-os-session-ready', 60_000, async () => {
        if (await sessionReady() !== computerId) throw new Error('Selected computer changed');
      });
      await check('cold-browser-paint', 180_000, openBrowserAndPaint);
      await check('close-desktop', 15_000, () => closeWindows('.window[data-app="desktop"]'));
      const coldFrame = await check('cold-code-ready', 60_000, codeFrame);
      await check('cold-marker', 45_000, async () => {
        if (await terminalRun(coldFrame, terminalProbeCommand(nonce, true), `C${nonce}`) !== nonce) {
          throw new Error('System layer marker did not survive');
        }
      });
    }
  } catch {
    abort.abort();
    await bounded(failureScreenshot, 5000).catch(() => {});
  } finally {
    abort.abort();
    if (browser) {
      const closing = performance.now();
      try {
        await bounded(() => browser.close(), 5000);
        record('browser-close', true, performance.now() - closing);
      } catch {
        record('browser-close', false, performance.now() - closing);
        await bounded(failureScreenshot, 4000).catch(() => {});
      }
    }
    finish();
    clearTimeout(hardTimer);
    process.removeListener('unhandledRejection', onUnhandled);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runLiveCheck();
  // A failed browser shutdown must not leave the CLI held open by sockets.
  process.exit(process.exitCode ?? 1);
}
