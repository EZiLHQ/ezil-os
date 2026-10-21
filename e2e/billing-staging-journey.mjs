#!/usr/bin/env node
/**
 * Opt-in staging journey. Importing this file does not read credentials, load
 * Playwright, start a browser, or make requests. Run with E2E_CREDS_FILE and
 * optionally E2E_BASE_URL, E2E_OUT, E2E_UPGRADE=standard|premium|none.
 *
 * Static selector references (the deployed version may differ):
 * login: app/src/app/login/login-form.tsx:121,135,143
 * dock: shell/ezil/boot.js:854; shell/src/UI/UITaskbarItem.js:50
 * names: shell/ezil/apps/registry.js:309,333,359,372
 * frames: shell/ezil/apps/code.js:279; apps/desktop-window.js:597
 * loaders: apps/code.js:296; apps/desktop-window.js:1051;
 *          shell/ezil/ui/app-spinner.js:60; ui/boot-progress.js:44
 *          app/src/components/desktop/boot-phases.shell.js:588
 * settings: shell/ezil/ui/Settings/index.js:107,120
 * billing: ui/Settings/tabs/billing.js:205,209; billing-sheets.js:250
 * Stripe: ui/Settings/upgrade-sheet.js:149 (secure child DOM is external)
 * restart: ui/Settings/tabs/troubleshoot.js:291,310,337
 * chat: worker/copilot-chat/PATCHES.md:95 preserves workbench.action.chat.*;
 *       e2e/copilot-ezil.mjs:145,216 uses the interactive chat/Monaco input.
 * terminal: e2e/live-check.mjs:262 (accessibility mode and xterm tree).
 *
 * Unknown until execution: staging SHA, account plan, Stripe fields, chat
 * entitlement, allocated resources, and restart/persistence outcomes. Mumbai
 * is inferred from the AWS hostname contract, not independently geolocated.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const STEP_IDS = ['health', 'sign_in', 'billing', 'code', 'browser', 'chat', 'persistence'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const elapsed = start => Math.round(performance.now() - start);
const compact = text => String(text).replace(/\s+/g, ' ').trim();
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Redact raw, JSON-escaped, percent-encoded, and form-encoded credentials. */
export function createRedactor({ email = '', password = '' } = {}) {
  const variants = new Set();
  for (const secret of [email, password]) {
    if (typeof secret !== 'string' || !secret) continue;
    let layer = [secret];
    for (let depth = 0; depth < 3; depth++) {
      const next = [];
      for (const value of layer) {
        variants.add(value);
        variants.add(JSON.stringify(value).slice(1, -1));
        try {
          next.push(encodeURIComponent(value), encodeURI(value),
            new URLSearchParams({ v: value }).toString().slice(2),
            encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`));
        } catch { /* A malformed Unicode credential is still redacted raw. */ }
      }
      layer = next;
    }
  }
  const expression = variants.size
    ? new RegExp([...variants].sort((a, b) => b.length - a.length).map(escapeRegex).join('|'), 'gi') : null;
  return value => {
    const text = value instanceof Error ? value.message : String(value ?? '');
    return expression ? text.replace(expression, '[REDACTED]') : text;
  };
}

export function redactEvidence(value, redact) {
  if (value instanceof Error || typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactEvidence(item, redact));
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redact(key), redactEvidence(item, redact)]));
  return value;
}

/** Wrap fluent page/locator/frame/API objects, including synchronous failures.
 * Never retain the original error as a cause: Playwright logs fill arguments.
 */
export function guardPlaywright(root, redact) {
  const wrapped = new WeakMap(), originals = new WeakMap();
  const safeError = error => {
    const safe = new Error(redact(error));
    safe.name = 'JourneyError';
    safe.stack = redact(safe.stack);
    return safe;
  };
  const unwrap = value => {
    if (!value || typeof value !== 'object') return value;
    if (originals.has(value)) return originals.get(value);
    if (Array.isArray(value)) return value.map(unwrap);
    if (Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, unwrap(item)]));
    return value;
  };
  const wrap = value => {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.then === 'function') return value.then(wrap, error => { throw safeError(error); });
    if (Array.isArray(value)) return value.map(wrap);
    if (Buffer.isBuffer(value) || value instanceof Date) return value;
    // Plain return data stays plain; duck-typed test doubles with methods wrap.
    if (Object.getPrototypeOf(value) === Object.prototype
        && !Object.values(value).some(item => typeof item === 'function')) return value;
    if (wrapped.has(value)) return wrapped.get(value);
    const proxy = new Proxy(value, {
      get(target, key) {
        try {
          const member = Reflect.get(target, key, target);
          if (typeof member !== 'function') return wrap(member);
          return (...args) => {
            try { return wrap(Reflect.apply(member, target, args.map(unwrap))); }
            catch (error) { throw safeError(error); }
          };
        } catch (error) { throw safeError(error); }
      },
    });
    wrapped.set(value, proxy); originals.set(proxy, value);
    return proxy;
  };
  return wrap(root);
}

export function classifyHost(input) {
  let host = '';
  try { host = new URL(String(input).includes('://') ? input : `https://${input}`).hostname.toLowerCase(); }
  catch { return { host: '', hostClass: 'unknown', mumbai: null }; }
  const hostClass = host.includes('nekodesktop') ? 'cloudflare' : host.includes('-aws.') ? 'aws' : 'unknown';
  return { host, hostClass, mumbai: hostClass === 'aws' ? true : null };
}

/** Parse only a Mem: row and the first following standalone nproc integer.
 * Missing/ambiguous output remains null instead of silently becoming zero.
 */
export function parseResources(text) {
  const lines = String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').split('\n');
  const index = lines.findIndex(line => /^\s*Mem:\s+\d+\s+\d+/i.test(line));
  if (index < 0) return { ramMiB: null, vcpus: null };
  const ramMiB = Number(lines[index].match(/^\s*Mem:\s+(\d+)/i)[1]);
  const cpuLine = lines.slice(index + 1).find(line => /^\s*[1-9]\d*\s*$/.test(line));
  const cpu = cpuLine ? Number(cpuLine.trim()) : null;
  return { ramMiB: Number.isSafeInteger(ramMiB) && ramMiB > 0 ? ramMiB : null,
    vcpus: Number.isSafeInteger(cpu) ? cpu : null };
}

export function aggregateResults(steps) {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
  const statuses = {};
  for (const step of steps) {
    if (!Object.hasOwn(counts, step.status)) throw new Error('Invalid step status');
    if (Object.hasOwn(statuses, step.id)) throw new Error('Duplicate step id');
    if (!Number.isFinite(step.ms) || step.ms < 0) throw new Error('Invalid step duration');
    counts[step.status]++;
    Object.defineProperty(statuses, step.id, { enumerable: true, configurable: true,
      value: step.status === 'SKIP' && step.reason ? `SKIP:${step.reason}` : step.status });
  }
  return { status: counts.FAIL ? 'FAIL' : counts.PASS ? 'PASS' : 'SKIP', counts, statuses,
    ms: steps.reduce((total, step) => total + step.ms, 0) };
}

/** Markers must occupy whole output lines; echoed commands cannot satisfy it. */
export function terminalBlock(text, begin, end) {
  const lines = String(text).replace(/\r/g, '').split('\n').map(line => line.trim());
  const start = lines.lastIndexOf(begin);
  const finish = lines.indexOf(end, start + 1);
  return start >= 0 && finish > start ? lines.slice(start + 1, finish).join('\n') : null;
}

export function isAIAccountError(text) {
  return /no_ai_account|(?:no|missing|not configured|not linked|not connected).{0,45}AI account|AI account.{0,65}(?:missing|not |required|error|unavailable)|(?:sign in|log in|connect|link).{0,45}(?:Copilot|AI account)|(?:API key|authentication|unauthori[sz]ed).{0,45}(?:missing|invalid|required)|(?:missing|invalid).{0,30}API key/i.test(text);
}

async function until(check, label, timeout = 30_000, interval = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check(Math.max(1, end - Date.now()));
    if (result) return result;
    await sleep(Math.min(interval, Math.max(0, end - Date.now())));
  }
  throw new Error(`Timed out: ${label}`);
}

const appWindow = (page, id) => page.locator(`.window[data-app="${id}"]:not([data-closing="1"])`).last();
const dock = (page, id) => page.locator(`.taskbar-item[data-app="${id}"]`).first();

async function closeApp(page, id) {
  const win = appWindow(page, id);
  if (!await win.count()) return;
  if (id === 'settings') {
    // A failed/cancelled checkout must not block the independent app steps.
    for (const close of await page.locator('[data-action="close-sheet"]:visible').all()) await close.click();
  }
  // Restore before closing, as a full-bleed app may be underneath another app.
  await dock(page, id).click();
  const close = win.getByRole('button', { name: 'Close', exact: true });
  if (!await close.first().isVisible()) {
    await win.locator('.dashboard-app-drawer-toggle').click();
  }
  for (const button of await close.all()) {
    if (await button.isVisible()) { await button.click(); break; }
  }
  await win.waitFor({ state: 'hidden', timeout: 15_000 });
}

async function settingsTab(page, tab) {
  await dock(page, 'settings').click();
  const win = appWindow(page, 'settings');
  await win.locator(`[data-tab="${tab}"]`).click();
  const pane = win.locator(`[data-pane="${tab}"]`);
  await pane.waitFor({ state: 'visible' });
  return pane;
}

async function planText(pane) {
  const card = pane.locator('[data-role="plan-card"]');
  await card.waitFor({ state: 'visible' });
  return compact(await card.innerText());
}

async function codeFrame(page) {
  const element = await appWindow(page, 'code').locator('iframe.window-app-iframe').elementHandle();
  try {
    const frame = await element?.contentFrame();
    if (!frame) throw new Error('Code frame is unavailable');
    await frame.locator('.monaco-workbench').waitFor({ state: 'visible', timeout: 60_000 });
    return frame;
  } finally { await element?.dispose(); }
}

async function openApp(page, id, evidence) {
  await closeApp(page, id);
  // Start the clock on the actual dock click and observe attachment separately
  // from navigation: the shell creates an about:blank iframe immediately.
  await page.evaluate(app => {
    window.__billingJourneyWatch?.stop();
    const data = { clickMs: null, loaderShownMs: null, frameAttachedMs: null,
      frameNavigatedMs: null, loaderGoneMs: null, ttiMs: null, loaderText: '' };
    let start = null;
    const visible = el => !!el && !el.hidden && el.getClientRects().length > 0
      && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const scan = () => {
      if (start === null) return;
      const ms = Math.round(performance.now() - start);
      const win = document.querySelector(`.window[data-app="${app}"]:not([data-closing="1"])`);
      const loaders = [...(win?.querySelectorAll('.ezil-app-spinner, .ezil-boot') ?? [])];
      const loader = loaders.find(visible);
      const frame = win?.querySelector('iframe.window-app-iframe');
      if (loader && data.loaderShownMs === null) {
        data.loaderShownMs = ms;
        data.loaderText = loader.querySelector('.ezil-boot-title')?.textContent ?? '';
      }
      if (frame && data.frameAttachedMs === null) data.frameAttachedMs = ms;
      const navigated = frame && /^https?:/.test(frame.src);
      if (navigated && data.frameNavigatedMs === null) data.frameNavigatedMs = ms;
      if (data.loaderShownMs !== null && !loader && navigated && visible(frame) && data.ttiMs === null) {
        data.loaderGoneMs = ms; data.ttiMs = ms;
      }
      data.failure = loaders.find(el => visible(el) && ['failed', 'not_configured', 'error'].includes(el.dataset.kind))?.textContent ?? '';
    };
    const clicked = event => {
      if (start === null && event.target.closest(`.taskbar-item[data-app="${app}"]`)) {
        start = performance.now(); data.clickMs = 0; queueMicrotask(scan);
      }
    };
    document.addEventListener('click', clicked, true);
    const observer = new MutationObserver(scan);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const timer = setInterval(scan, 50);
    window.__billingJourneyWatch = { data, stop() {
      observer.disconnect(); clearInterval(timer); document.removeEventListener('click', clicked, true);
    } };
  }, id);
  try {
    await dock(page, id).click();
    await until(async () => {
      const data = await page.evaluate(() => window.__billingJourneyWatch.data);
      Object.assign(evidence, data);
      if (data.failure) throw new Error(`App loader failed: ${data.failure}`);
      return data.ttiMs !== null;
    }, `${id} loader and iframe readiness`, 240_000);
    const src = await appWindow(page, id).locator('iframe.window-app-iframe').getAttribute('src');
    Object.assign(evidence, classifyHost(src));
    evidence.regionEvidence = evidence.mumbai ? 'AWS hostname implies Mumbai' : 'Region not established';
    if (id === 'code') await codeFrame(page);
  } finally {
    const observed = await page.evaluate(() => {
      const watch = window.__billingJourneyWatch;
      watch?.stop(); return watch?.data;
    }).catch(() => null);
    if (observed) Object.assign(evidence, observed);
  }
}

async function stripeFrames(page) {
  const element = await page.locator('#ezil-embedded-checkout iframe').first().elementHandle();
  try {
    const root = await element?.contentFrame();
    if (!root) return [];
    const descend = frame => [frame, ...frame.childFrames().flatMap(descend)];
    return descend(root);
  } finally { await element?.dispose(); }
}

async function stripeField(page, name, role = 'textbox', timeout = 20_000) {
  return until(async () => {
    for (const frame of await stripeFrames(page)) {
      for (const locator of [frame.getByRole(role, { name }), frame.getByLabel(name)]) {
        for (const candidate of await locator.all()) if (await candidate.isVisible()) return candidate;
      }
    }
    return null;
  }, `Stripe field ${name}`, timeout);
}

async function checkout(page, upgrade, email, evidence) {
  const pane = appWindow(page, 'settings').locator('[data-pane="billing"]');
  const change = pane.getByRole('button', { name: 'Change plan', exact: true });
  if (await change.isVisible()) await change.click();
  await page.locator(`[data-action="checkout"][data-sku="${upgrade}_monthly_v3"]`).click();
  await page.locator('#ezil-embedded-checkout iframe').first().waitFor({ state: 'visible', timeout: 60_000 });
  for (const frame of await stripeFrames(page)) {
    const card = frame.getByRole('button', { name: /^(?:Pay with )?Card$/i }).first();
    if (await card.isVisible()) { await card.click(); break; }
  }
  await (await stripeField(page, /card number/i)).fill('4242424242424242');
  await (await stripeField(page, /expiration|expiry|MM\s*\/\s*YY/i)).fill('12/34');
  await (await stripeField(page, /security code|CVC|CVV/i)).fill('123');
  for (const [name, value] of [[/cardholder|name on card|full name/i, 'EZiL Billing E2E'], [/email/i, email]]) {
    const field = await stripeField(page, name, 'textbox', 1500).catch(() => null);
    if (field && await field.isEditable()) await field.fill(value);
  }
  const country = await stripeField(page, /country/i, 'combobox');
  if (await country.evaluate(el => el.tagName === 'SELECT')) await country.selectOption('US');
  else {
    await country.click();
    await (await stripeField(page, /^United States$/, 'option')).click();
  }
  await (await stripeField(page, /ZIP|postal code/i)).fill('10001');
  const submit = await stripeField(page, /^(?:Subscribe|Pay(?:\s+(?:USD\s*)?[$€£₹]?[\d.,]+)?)$/i, 'button');
  await submit.click();
  evidence.checkoutSubmitted = true;
  const started = performance.now();
  // Allow Stripe's redirect/payment confirmation to finish before reloading.
  await sleep(5000);
  await waitForPlan(page, upgrade, evidence, started);
}

// Standard → Premium on the saved card: billing-sheets.js upgrade sheet (preview, then pay).
async function upgradeInPlace(page, upgrade, evidence) {
  const pane = appWindow(page, 'settings').locator('[data-pane="billing"]');
  await pane.locator('[data-action="upgrade"]').first().click();
  const pay = page.getByRole('button', { name: /^Pay .+ and upgrade$/ });
  await pay.waitFor({ state: 'visible', timeout: 30_000 });
  evidence.upgradeDue = compact(await page.locator('.ezil-billing-sheet-total').first().innerText());
  await pay.click();
  evidence.upgradeSubmitted = true;
  const started = performance.now();
  await page.getByText(new RegExp(`You're on ${upgrade}`, 'i')).first().waitFor({ state: 'visible', timeout: 60_000 });
  evidence.confirmedMs = elapsed(started);
  await waitForPlan(page, upgrade, evidence, started);
}

async function waitForPlan(page, upgrade, evidence, started) {
  const deadline = started + 120_000;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, deadline - performance.now());
    await page.goto(new URL('/os?settings=billing', page.url()).href, {
      waitUntil: 'domcontentloaded', timeout: Math.min(30_000, remaining),
    });
    const card = page.locator('.window[data-app="settings"] [data-pane="billing"] [data-role="plan-card"]');
    await card.waitFor({ state: 'visible', timeout: Math.min(15_000, Math.max(1, deadline - performance.now())) });
    evidence.planAfter = compact(await card.innerText({ timeout: Math.max(1, deadline - performance.now()) }));
    if (new RegExp(`\\b${upgrade}\\b`, 'i').test(evidence.planAfter)
        && await card.locator('[data-role="plan-status"][data-status="active"]').count()) {
      evidence.activationMs = elapsed(started); return;
    }
    await sleep(Math.min(5000, Math.max(0, deadline - performance.now())));
  }
  throw new Error('Purchased plan did not become Active within 120 seconds');
}

async function command(frame, name, id) {
  await frame.locator('.monaco-workbench').click({ position: { x: 8, y: 8 } });
  await frame.locator('body').press('Control+Shift+P');
  const input = frame.locator('.quick-input-widget input:visible').first();
  await input.fill(`>${name}`);
  // Command ids survived the EZiL branding patches. Match them when exposed.
  const row = frame.locator(`.quick-input-list [data-quick-input-id="${id}"]:visible`).first();
  try { await row.waitFor({ state: 'visible', timeout: 3000 }); await row.click(); }
  catch {
    const fallback = frame.locator('.quick-input-list .monaco-list-row:visible')
      .filter({ hasText: new RegExp(escapeRegex(name), 'i') }).first();
    await fallback.click();
  }
  await input.waitFor({ state: 'hidden' });
}

async function chat(page, evidence, redact) {
  await dock(page, 'code').click();
  const frame = await codeFrame(page);
  let input = frame.locator('.chat-input-container .monaco-editor:visible').first();
  if (!await input.isVisible()) {
    await command(frame, 'Chat: Open Chat', 'workbench.action.chat.open');
    await input.waitFor({ state: 'visible', timeout: 15_000 });
  }
  const replies = frame.locator('.interactive-item-container.interactive-response .rendered-markdown:visible, .interactive-response .value:visible');
  const errors = frame.locator('.notifications-toasts .notification-list-item:visible, .interactive-session .chat-error:visible, .interactive-session .chat-warning:visible');
  const beforeReplies = await replies.allTextContents();
  const beforeErrors = await errors.allTextContents();
  // Existing account notices still explain why a request cannot be sent.
  const accountNotice = beforeErrors.find(isAIAccountError);
  if (accountNotice) { evidence.visibleText = redact(compact(accountNotice)).slice(0, 200); return 'no_ai_account'; }
  await input.locator('.view-lines').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Say OK');
  await page.keyboard.press('Enter');
  evidence.prompt = 'Say OK';
  const started = performance.now();
  return until(async () => {
    const errorText = (await errors.allTextContents()).filter(text => !beforeErrors.includes(text)).join('\n');
    const replyText = (await replies.allTextContents()).filter(text => !beforeReplies.includes(text)).join('\n');
    const text = compact(errorText || replyText);
    if (!text) return false;
    evidence.visibleText = redact(text).slice(0, 200);
    evidence.replyMs = elapsed(started);
    if (isAIAccountError(text)) return 'no_ai_account';
    if (errorText || /sorry.{0,50}(?:failed|error)|request failed|an error occurred|quota exceeded|rate limit/i.test(text)) {
      throw new Error(`Chat error: ${evidence.visibleText}`);
    }
    // Do not report a streamed first token or "Thinking…" as a completed reply.
    const stop = frame.getByRole('button', { name: /^(?:Stop|Cancel)(?: generating| request| response)?(?:\s*\(.*\))?$/i });
    for (const button of await stop.all()) if (await button.isVisible()) return false;
    return /^(?:thinking|working|loading)[.…\s]*$/i.test(text) ? false : 'replied';
  }, 'EZiL Chat reply or error', 60_000);
}

async function terminalRun(page, frame, script, runId, phase) {
  await dock(page, 'code').click();
  await frame.locator('.monaco-workbench').click({ position: { x: 8, y: 8 } });
  // Requested shortcut, then inspect/focus the actual terminal input.
  if (!await frame.locator('.terminal .xterm-helper-textarea:visible').count()) {
    await frame.locator('body').press('Control+Backquote');
  }
  if (!await frame.locator('.xterm-accessibility-tree').count()) {
    await command(frame, 'Toggle Screen Reader Accessibility Mode', 'editor.action.toggleScreenReaderAccessibilityMode');
  }
  await command(frame, 'Terminal: Focus Terminal', 'workbench.action.terminal.focus');
  const terminal = frame.locator('.terminal:visible').last();
  const input = terminal.locator('.xterm-helper-textarea').last();
  await input.waitFor({ state: 'attached' });
  await input.focus();
  const begin = `E2E_BEGIN_${phase}_${runId}`, end = `E2E_END_${phase}_${runId}`;
  // Clear scrollback through the terminal UI, preserving its shell/processes.
  await input.pressSequentially(`printf '\\033[3J\\033[H\\033[2J'; printf '\\n${begin}\\n'; ${script}; rc=$?; printf '\\nE2E_RC=%s\\n${end}\\n' "$rc"`, { delay: 1 });
  await input.press('Enter');
  return until(async () => {
    const tree = terminal.locator('.xterm-accessibility-tree');
    const rows = terminal.locator('.xterm-rows');
    const text = await (await tree.count() ? tree : rows).last().innerText({ timeout: 3000 });
    const block = terminalBlock(text, begin, end);
    return block === null ? false : { text: block, exitCode: Number(block.match(/^E2E_RC=(\d+)$/m)?.[1] ?? -1) };
  }, 'terminal output markers', 30_000);
}

async function persistence(page, runId, evidence) {
  const frame = await codeFrame(page);
  const initial = await terminalRun(page, frame,
    `echo e2e-${runId} > ~/e2e-persist.txt && tmux new -d -s e2e 'sleep 3600' && free -m | head -2 && nproc`, runId, 'before');
  evidence.beforeTerminal = initial.text;
  evidence.resources = parseResources(initial.text);
  if (initial.exitCode !== 0) throw new Error('Persistence setup command failed (an existing tmux session named e2e also causes this)');
  if (!evidence.resources.ramMiB || !evidence.resources.vcpus) throw new Error('RAM/vCPU output was not readable');
  const win = await settingsTab(page, 'troubleshoot').catch(async error => {
    if (!await appWindow(page, 'settings').locator('[data-tab="troubleshoot"]').count()) return null;
    throw error;
  });
  if (!win) return 'restart_control_missing';
  const restart = win.locator('[data-action="restart"]');
  if (!await restart.count() || !await restart.isVisible()) return 'restart_control_missing';
  if (!await restart.isEnabled()) return 'restart_unavailable';
  evidence.restartControl = 'Settings → Troubleshoot → Restart desktop';
  await restart.click();
  await page.getByRole('button', { name: 'Restart', exact: true }).click();
  const started = performance.now();
  await until(async () => {
    const error = win.locator('.ezil-settings-error');
    if (await error.count()) throw new Error(`Restart failed: ${await error.innerText()}`);
    return (await win.innerText()).includes('Restart requested.');
  }, 'restart acknowledgement', 120_000);
  evidence.restartMs = elapsed(started);
  await closeApp(page, 'settings');
  evidence.desktopAfterRestart = {};
  await openApp(page, 'desktop', evidence.desktopAfterRestart);
  evidence.codeAfterRestart = {};
  await openApp(page, 'code', evidence.codeAfterRestart);
  const after = await terminalRun(page, await codeFrame(page),
    'cat ~/e2e-persist.txt; file_rc=$?; tmux ls; tmux_rc=$?; printf "\\nFILE_RC=%s TMUX_RC=%s\\n" "$file_rc" "$tmux_rc"; test "$file_rc" -eq 0', runId, 'after');
  evidence.afterTerminal = after.text;
  evidence.filePersisted = after.text.split('\n').includes(`e2e-${runId}`);
  evidence.tmuxSessionPresent = /^e2e:\s/m.test(after.text);
  evidence.tmuxExitCode = Number(after.text.match(/TMUX_RC=(\d+)/)?.[1] ?? -1);
  if (after.exitCode !== 0 || !evidence.filePersisted) throw new Error('Persistence marker was not restored after restart');
  // This restart restarts the desktop stack, not necessarily the tmux server.
  // Record process survival separately; file persistence is the assertion.
  return null;
}

async function loadPlaywright() {
  for (const url of [import.meta.url, new URL('../app/package.json', import.meta.url), new URL('../shell/package.json', import.meta.url)]) {
    for (const name of ['playwright', '@playwright/test']) {
      try { return createRequire(url)(name); } catch { /* Try existing local dependencies only. */ }
    }
  }
  throw new Error('Playwright is not installed locally; install it and Chromium before running the journey');
}

export async function main(env = process.env) {
  const startedAt = new Date().toISOString(), runId = randomUUID();
  const out = resolve(env.E2E_OUT || `e2e-results/billing-staging-${runId}`);
  const report = { runId, startedAt, steps: [] };
  let redact = createRedactor(), browser, page, credentials;
  const originalWrites = [process.stdout.write, process.stderr.write];
  let outputGuarded = false;
  const save = async () => {
    report.summary = aggregateResults(report.steps);
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'results.json'), JSON.stringify(redactEvidence(report, redact), null, 2) + '\n', { mode: 0o600 });
  };
  const shot = async (id, evidence) => {
    if (!page) return;
    const filename = `${id}.png`;
    // App-only screenshots omit Settings/account chrome. Also mask credential
    // input/text nodes in every frame (do not capture a failed login page).
    const masks = [];
    for (const frame of page.frames()) {
      masks.push(frame.locator('input[type="email"], input[type="password"]'));
      for (const secret of [credentials.email, credentials.password]) masks.push(frame.getByText(secret, { exact: false }));
    }
    await appWindow(page, id).screenshot({ path: join(out, filename), mask: masks });
    evidence.screenshot = filename;
  };
  const record = async (id, work, skip) => {
    const start = performance.now();
    const step = { id, status: skip ? 'SKIP' : 'PASS', ms: 0, evidence: {} };
    try {
      if (skip) step.reason = skip;
      else {
        const reason = await work(step.evidence);
        if (reason) { step.status = 'SKIP'; step.reason = reason; }
      }
    } catch (error) { step.status = 'FAIL'; step.evidence.error = redact(error); }
    step.ms = elapsed(start);
    report.steps.push(redactEvidence(step, redact));
    await save();
    return step.status === 'PASS';
  };
  try {
    // Suppress JSON parse/read diagnostics, which can include the file contents.
    try { credentials = JSON.parse(await readFile(env.E2E_CREDS_FILE, 'utf8')); }
    catch { throw new Error('E2E_CREDS_FILE must identify a readable JSON credentials file'); }
    redact = createRedactor(credentials ?? {});
    if (typeof credentials?.email !== 'string' || !credentials.email
        || typeof credentials?.password !== 'string' || !credentials.password) throw new Error('Credentials require nonempty email and password strings');
    // Playwright can emit diagnostics when the caller has DEBUG enabled. Guard
    // both sinks as well as page/locator errors.
    for (const [index, stream] of [process.stdout, process.stderr].entries()) {
      stream.write = function (chunk, ...args) {
        return originalWrites[index].call(this, redact(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk), ...args);
      };
    }
    outputGuarded = true;
    const base = new URL(env.E2E_BASE_URL || 'https://os-staging.ezil.work');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('E2E_BASE_URL must be an HTTP(S) URL without user information');
    const upgrade = env.E2E_UPGRADE || 'none';
    if (!['none', 'standard', 'premium'].includes(upgrade)) throw new Error('E2E_UPGRADE must be standard, premium, or none');
    report.baseUrl = base.origin; report.upgrade = upgrade;
    await save();
    // Health does not depend on a successful browser launch or login.
    await record('health', async evidence => {
      const response = await fetch(new URL('/api/health', base), { signal: AbortSignal.timeout(20_000) });
      evidence.httpStatus = response.status;
      const body = await response.json();
      evidence.sha = body.sha ?? null;
      if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
      if (!evidence.sha) throw new Error('Health response did not include sha');
    });
    // Do not forward browser/page consoles, trace files, or auth storage state.
    const playwright = guardPlaywright(await loadPlaywright(), redact);
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(60_000);
    const signedIn = await record('sign_in', async evidence => {
      await page.goto(new URL('/login?method=email', base).href, { waitUntil: 'domcontentloaded' });
      await page.locator('input[type="email"]').fill(credentials.email);
      await page.locator('input[type="password"]').fill(credentials.password);
      const started = performance.now();
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.waitForURL(url => url.origin === base.origin && /^\/os\/?$/.test(url.pathname));
      evidence.timeToOsMs = elapsed(started);
      await dock(page, 'settings').waitFor({ state: 'visible' });
    });
    await record('billing', async evidence => {
      const pane = await settingsTab(page, 'billing');
      evidence.planBefore = await planText(pane);
      const name = await pane.locator('[data-role="plan-card"] h4').innerText();
      evidence.upgrade = upgrade;
      if (upgrade !== 'none' && /^Free$/i.test(name.trim())) await checkout(page, upgrade, credentials.email, evidence);
      else if (upgrade === 'premium' && /^Standard$/i.test(name.trim())) await upgradeInPlace(page, upgrade, evidence);
      else evidence.upgradeSkipped = upgrade === 'none' ? 'not_requested' : 'plan_not_free';
    }, signedIn ? null : 'sign_in_failed');
    let codeReady = false;
    codeReady = await record('code', async evidence => {
      await closeApp(page, 'settings');
      await openApp(page, 'code', evidence);
      await shot('code', evidence);
    }, signedIn ? null : 'sign_in_failed');
    await record('browser', async evidence => {
      await closeApp(page, 'settings');
      await openApp(page, 'desktop', evidence);
      await shot('desktop', evidence);
    }, signedIn ? null : 'sign_in_failed');
    await record('chat', async evidence => {
      const outcome = await chat(page, evidence, redact);
      return outcome === 'no_ai_account' ? outcome : null;
    }, codeReady ? null : 'code_unavailable');
    await record('persistence', evidence => persistence(page, runId, evidence), codeReady ? null : 'code_unavailable');
  } catch (error) {
    report.steps.push({ id: 'setup', status: 'FAIL', ms: 0, evidence: { error: redact(error) } });
  } finally {
    if (browser) await browser.close().catch(error => {
      report.steps.push({ id: 'cleanup', status: 'FAIL', ms: 0, evidence: { error: redact(error) } });
    });
    for (const id of STEP_IDS) if (!report.steps.some(step => step.id === id)) {
      report.steps.push({ id, status: 'SKIP', reason: 'setup_failed', ms: 0, evidence: {} });
    }
    report.finishedAt = new Date().toISOString();
    try { await save(); }
    catch (error) {
      report.steps.push({ id: 'output', status: 'FAIL', ms: 0, evidence: { error: redact(error) } });
    }
    // Only fixed step identifiers/statuses are printed, including on failure.
    process.stdout.write(JSON.stringify(aggregateResults(report.steps).statuses) + '\n');
    if (outputGuarded) {
      process.stdout.write = originalWrites[0]; process.stderr.write = originalWrites[1];
    }
    process.exitCode = 0;
  }
  return redactEvidence(report, redact);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => {
    process.stdout.write('{"setup":"FAIL"}\n');
    process.exitCode = 0;
  });
}
