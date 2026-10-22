import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateResults, classifyHost, createRedactor, guardPlaywright,
  isAIAccountError, parseResources, redactEvidence, terminalBlock, command, ensureTerminal,
  closeApp, restartPane, restartUnavailableReason } from './billing-staging-journey.mjs';

const credentials = { email: 'qa+staging@example.test', password: 'P@ss word!"\\$?&' };

test('redaction removes both credentials, repeats, case variants and URL encodings', () => {
  const redact = createRedactor(credentials);
  for (const secret of Object.values(credentials)) {
    const variants = [secret, secret.toUpperCase(), encodeURIComponent(secret), encodeURI(secret),
      encodeURIComponent(encodeURIComponent(secret)),
      new URLSearchParams({ value: secret }).toString().slice(6),
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret).replace(/%[\dA-F]{2}/g, text => text.toLowerCase())];
    for (const value of variants) assert.equal(redact(`before ${value} / ${value} after`), 'before [REDACTED] / [REDACTED] after');
  }
  assert.equal(createRedactor()('ordinary text'), 'ordinary text');
  assert.equal(redact('No credentials here'), 'No credentials here');
});

test('redaction covers error messages, nested evidence and overlapping secrets', () => {
  const redact = createRedactor(credentials);
  assert.equal(redact(new Error(`fill(${credentials.password}) ${credentials.email}`)), 'fill([REDACTED]) [REDACTED]');
  const result = redactEvidence({ text: credentials.email, nested: [credentials.password, { reason: new Error(credentials.email) }] }, redact);
  assert.deepEqual(result, { text: '[REDACTED]', nested: ['[REDACTED]', { reason: '[REDACTED]' }] });
  assert.equal(createRedactor({ email: 'abcdef', password: 'abc' })('abcdef abc'), '[REDACTED] [REDACTED]');
});

test('guard redacts synchronous locator failures and async fill/keyboard/frame errors', async () => {
  const leak = `${credentials.email} ${encodeURIComponent(credentials.password)}`;
  const page = guardPlaywright({
    locator() { return { first() { return this; }, async fill() { throw new Error(leak); } }; },
    getByRole() { throw new Error(leak); },
    keyboard: { async press() { throw new Error(leak); } },
    frames() { return [{ locator() { throw new Error(leak); } }]; },
  }, createRedactor(credentials));
  const safe = error => {
    assert.equal(error.message, '[REDACTED] [REDACTED]');
    assert.equal(error.cause, undefined);
    assert.ok(!error.stack.includes(credentials.email));
    return true;
  };
  assert.throws(() => page.getByRole('button'), safe);
  assert.throws(() => page.frames()[0].locator('body'), safe);
  await assert.rejects(page.locator('input').first().fill(credentials.password), safe);
  await assert.rejects(page.keyboard.press('Enter'), safe);
});

test('guard preserves locator identity in arguments and ordinary result data', async () => {
  class Locator { filter({ has }) { assert.equal(has, this); return this; } async count() { return 2; } }
  const guarded = guardPlaywright(new Locator(), createRedactor(credentials));
  assert.equal(await guarded.filter({ has: guarded }).count(), 2);
  const data = { sha: '123456', ok: true };
  assert.deepEqual(await guardPlaywright({ async json() { return data; } }, createRedactor()).json(), data);
});

test('host classification uses hostname only; Mumbai is inferred only for AWS', () => {
  assert.deepEqual(classifyHost('https://8080-box-nekodesktop.ezil.work/?secret=hidden'),
    { host: '8080-box-nekodesktop.ezil.work', hostClass: 'cloudflare', mumbai: null });
  assert.deepEqual(classifyHost('aws-box-aws.ezil.work'),
    { host: 'aws-box-aws.ezil.work', hostClass: 'aws', mumbai: true });
  assert.equal(classifyHost('https://AWS-BOX-AWS.EZIL.WORK').hostClass, 'aws');
  assert.equal(classifyHost('https://example.test/nekodesktop?x=-aws.').hostClass, 'unknown');
  assert.equal(classifyHost('https://nekodesktop@unknown.example/').hostClass, 'unknown');
  assert.equal(classifyHost('https://8443-guac-61ee4784407c4a77-03f419f2908f4fe8-code.ezil.work/').hostClass, 'cloudflare');
  assert.equal(classifyHost('https://guac-61ee-code.ezil.work/').hostClass, 'cloudflare');
  assert.equal(classifyHost('https://aws-8443-guac-61ee-03f4-aws.ezil.work/').hostClass, 'aws');
  assert.equal(classifyHost('about:blank').hostClass, 'unknown');
  assert.equal(classifyHost('not a host').hostClass, 'unknown');
});

test('parse free -m plus nproc with CRLF and terminal formatting', () => {
  const text = '$ free -m | head -2 && nproc\r\n              total used free shared buff/cache available\r\n'
    + '\x1b[32mMem:           15872  2080  1700  0  12092  13120\x1b[0m\r\n4\r\nuser@host:~$';
  assert.deepEqual(parseResources(text), { ramMiB: 15872, vcpus: 4 });
  assert.deepEqual(parseResources('99\nMem: 7680 123 7000 0 0 0\nSwap: 0 0 0\n2\nE2E_RC=0'), { ramMiB: 7680, vcpus: 2 });
});

test('resource parser does not invent missing RAM or CPU from commands/prompts', () => {
  assert.deepEqual(parseResources('echo free -m && nproc\n4'), { ramMiB: null, vcpus: null });
  assert.deepEqual(parseResources('Mem: 2048 40 2000\nuser@host:~$ 8'), { ramMiB: 2048, vcpus: null });
  assert.deepEqual(parseResources('Mem: 0 0 0\n0'), { ramMiB: null, vcpus: null });
  assert.deepEqual(parseResources('Mem: 9999999999999999999 0 0\n9999999999999999999'), { ramMiB: null, vcpus: null });
});

test('aggregation keeps all statuses, durations and explicit skip reasons', () => {
  const steps = [{ id: 'health', status: 'PASS', ms: 12, evidence: { sha: 'abc' } },
    { id: 'code', status: 'FAIL', ms: 100 }, { id: 'chat', status: 'SKIP', reason: 'no_ai_account', ms: 3 }];
  assert.deepEqual(aggregateResults(steps), { status: 'FAIL', counts: { PASS: 1, FAIL: 1, SKIP: 1 },
    statuses: { health: 'PASS', code: 'FAIL', chat: 'SKIP:no_ai_account' }, ms: 115 });
  assert.equal(steps[0].evidence.sha, 'abc');
  assert.equal(aggregateResults([]).status, 'SKIP');
  assert.equal(aggregateResults(steps.slice(0, 1)).status, 'PASS');
  assert.equal(aggregateResults([steps[2]]).status, 'SKIP');
});

test('aggregation rejects invalid durations, statuses and duplicate step ids', () => {
  for (const step of [{ id: 'a', status: 'OK', ms: 1 }, { id: 'a', status: 'PASS', ms: -1 },
    { id: 'a', status: 'PASS', ms: NaN }]) assert.throws(() => aggregateResults([step]));
  assert.throws(() => aggregateResults([{ id: 'a', status: 'PASS', ms: 1 }, { id: 'a', status: 'FAIL', ms: 1 }]));
});

test('desktop diagnostic failures remain results alongside later journey steps', () => {
  const result = aggregateResults([
    { id: 'placement', status: 'PASS', ms: 10 }, { id: 'latency', status: 'FAIL', ms: 20 },
    { id: 'typing', status: 'FAIL', ms: 30 }, { id: 'clipboard', status: 'SKIP', reason: 'sidecar_has_no_omnibox_text_readback', ms: 40 },
    { id: 'fonts', status: 'SKIP', reason: 'glyph_rendering_requires_visual_review', ms: 50 },
    { id: 'persistence', status: 'PASS', ms: 60 },
  ]);
  assert.deepEqual(result.counts, { PASS: 2, FAIL: 2, SKIP: 2 });
  assert.equal(result.statuses.persistence, 'PASS');
  assert.equal(result.ms, 210);
});

test('terminal output requires complete fresh standalone markers', () => {
  assert.equal(terminalBlock("$ printf 'BEGIN'; cat file; printf 'END'", 'BEGIN', 'END'), null);
  assert.equal(terminalBlock('BEGIN\r\ne2e-run-id\r\nEND\r\n$', 'BEGIN', 'END'), 'e2e-run-id');
  assert.equal(terminalBlock('BEGIN\nold\nEND\nBEGIN\nnew', 'BEGIN', 'END'), null);
});

test('AI account notices skip while generic service failures remain failures', () => {
  for (const message of ['no_ai_account', 'No AI account connected', 'AI account is required',
    'Sign in to use GitHub Copilot', 'Invalid API key']) assert.equal(isAIAccountError(message), true, message);
  for (const message of ['OK', 'Network timeout', 'Rate limit exceeded', 'Internal server error']) assert.equal(isAIAccountError(message), false, message);
});

const timeoutError = () => Object.assign(new Error('Timed out'), { name: 'TimeoutError' });

function terminalFixture({ open = false, shortcutOpens = true, idFound = true, clickError = false,
  clickOpens = true, lookupOpens = false, lookupError = null } = {}) {
  const calls = [];
  let palette = false;
  const locator = name => ({
    first() { return this; }, last() { return this; }, filter() { return this; },
    locator: child => locator(child),
    async isVisible() { return name.includes('terminal') ? open : palette; },
    async fill() {},
    async press(key) {
      calls.push(key);
      if (key === 'Control+Shift+P') palette = true;
      if (key === 'Escape') palette = false;
    },
    async waitFor({ state }) {
      calls.push(`wait:${name}:${state}`);
      if (name === '.terminal:visible') {
        if (shortcutOpens) { open = true; return; }
        throw timeoutError();
      }
      if (name.includes('data-quick-input-id')) {
        if (lookupOpens) open = true;
        if (lookupError) throw lookupError;
        if (!idFound) throw timeoutError();
      }
      if (name.includes('quick-input-widget') && state === 'hidden') assert.equal(palette, false);
      if (name.includes('xterm')) assert.equal(open, true, 'xterm readiness waits for an open panel');
    },
    async click() {
      calls.push(`click:${name}`);
      if (name.includes('quick-input-list')) {
        if (clickOpens) { open = true; palette = false; }
        if (clickError) throw timeoutError();
      }
    },
  });
  return { frame: { locator }, calls, ready: async () => open };
}

test('terminal waits for the shortcut to open its panel and input before using any palette', async () => {
  const { frame, calls } = terminalFixture();
  await ensureTerminal(frame);
  assert.deepEqual(calls, ['Control+Backquote', 'wait:.terminal:visible:visible',
    'wait:.xterm-screen:visible', 'wait:.xterm-helper-textarea:attached']);
});

test('already open terminal waits for xterm readiness without toggling or dispatching', async () => {
  const { frame, calls } = terminalFixture({ open: true });
  await ensureTerminal(frame);
  assert.deepEqual(calls, ['wait:.xterm-screen:visible', 'wait:.xterm-helper-textarea:attached']);
});

test('terminal palette fallback runs once only after the shortcut readiness timeout', async () => {
  const { frame, calls } = terminalFixture({ shortcutOpens: false, idFound: false });
  await ensureTerminal(guardPlaywright(frame, createRedactor()));
  assert.ok(calls.indexOf('Control+Shift+P') > calls.indexOf('wait:.terminal:visible:visible'));
  assert.equal(calls.filter(call => call.startsWith('click:.quick-input-list')).length, 1);
});

test('terminal appearing during palette lookup dismisses the palette without dispatch', async () => {
  const { frame, calls } = terminalFixture({ shortcutOpens: false, idFound: false, lookupOpens: true });
  await ensureTerminal(frame);
  assert.ok(calls.includes('Escape'));
  assert.equal(calls.filter(call => call.startsWith('click:.quick-input-list')).length, 0);
});

test('a command click that dispatched before a timeout never triggers a second click', async () => {
  const { frame, calls, ready } = terminalFixture({ clickError: true });
  await command(frame, 'Terminal: Focus Terminal', 'terminal.focus', ready);
  assert.equal(calls.filter(call => call.startsWith('click:.quick-input-list')).length, 1);
});

test('failed command click and non-timeout lookup errors propagate without another dispatch', async () => {
  for (const options of [{ clickError: true, clickOpens: false }, { lookupError: new Error('Frame detached') }]) {
    const { frame, calls } = terminalFixture(options);
    await assert.rejects(command(frame, 'Some Command', 'command.id'));
    assert.ok(calls.filter(call => call.startsWith('click:.quick-input-list')).length <= 1);
  }
});

test('restart skips only explicit deployment/stack limitations, never missing prerequisites or failures', () => {
  assert.equal(restartUnavailableReason('Not available in this deployment yet.'), 'restart_not_supported_by_deployment');
  assert.equal(restartUnavailableReason("This deployment hasn't turned on desktop restarts yet."), 'restart_not_supported_by_deployment');
  assert.equal(restartUnavailableReason('This desktop runs on an older stack that cannot be restarted in place.'), 'restart_not_supported_by_desktop_stack');
  for (const text of ['', 'Open a desktop first, then come back here.', 'Restarting…', 'Your session expired — sign in again.',
    "Your desktop isn't answering", 'Could not reach the server.', 'Something went wrong. Please try again.']) assert.equal(restartUnavailableReason(text), null);
});

function restartFixture({ unsupported = false, expanded = false } = {}) {
  const calls = [];
  let checks = 0;
  const locator = (selector, parent = '') => ({
    last() { return this; }, locator(child) {
      const scope = parent + selector;
      if (child.startsWith('.dashboard-app-drawer')) assert.equal(scope, '.window[data-app="desktop"]:not([data-closing="1"])');
      else if (child === '[data-action="restart"]') assert.equal(scope,
        '.window[data-app="settings"]:not([data-closing="1"])[data-pane="troubleshoot"]');
      else assert.equal(scope, '.window[data-app="settings"]:not([data-closing="1"])');
      return locator(child, scope);
    },
    async count() { return 1; },
    async getAttribute(name) {
      if (selector.includes('drawer-toggle')) { assert.equal(name, 'aria-expanded'); return String(expanded); }
      assert.equal(name, 'data-ezil-computer-id'); return 'fixture-computer';
    },
    async isVisible() { return true; },
    async isEnabled() { return !unsupported && ++checks >= 2; },
    async click() { calls.push(selector); },
    async waitFor() {},
    async evaluate(callback) {
      const hr = { tagName: 'HR' };
      return callback({ nextElementSibling: { tagName: 'P', matches: () => true,
        textContent: unsupported ? 'Not available in this deployment yet.' : '', nextElementSibling: hr } });
    },
  });
  return { page: { locator }, calls };
}

test('restart uses the open Browser drawer and waits for the control to enable', async () => {
  for (const expanded of [false, true]) {
    const { page, calls } = restartFixture({ expanded });
    const evidence = {};
    assert.equal((await restartPane(page, evidence)).reason, null);
    assert.deepEqual(calls, [...(expanded ? [] : ['.dashboard-app-drawer-toggle']),
      '.dashboard-app-drawer-settings', '[data-tab="troubleshoot"]']);
    assert.equal(evidence.desktopHasComputerId, true);
    assert.equal(evidence.enabled, true);
    assert.ok(!JSON.stringify(evidence).includes('fixture-computer'));
  }
});

test('restart retains the disabled explanation when deployment support is absent', async () => {
  const { page } = restartFixture({ unsupported: true });
  const evidence = {};
  assert.equal((await restartPane(page, evidence)).reason, 'restart_not_supported_by_deployment');
  assert.equal(evidence.enabled, false);
  assert.equal(evidence.explanation, 'Not available in this deployment yet.');
});

function windowFixture({ fullpage = true, expanded = false, codeOpen = true } = {}) {
  const calls = [];
  const windows = { desktop: { open: true, fullpage, expanded },
    code: { open: codeOpen, fullpage: false }, settings: { open: true, fullpage: false } };
  const dockVisible = () => !windows.desktop.open || !windows.desktop.fullpage;
  const page = { locator(selector) {
    if (selector === '[data-action="close-sheet"]:visible') return { all: async () => [] };
    const match = selector.match(/^\.(window|taskbar-item)\[data-app="(desktop|code|settings)"\]/);
    assert.ok(match, `Unexpected page locator ${selector}`);
    const [, kind, id] = match, state = windows[id];
    if (kind === 'taskbar-item') return {
      first() { return this; }, isVisible: async () => dockVisible(), async click() {
        assert.ok(dockVisible(), 'Browser must release the dock first'); calls.push(`dock:${id}`);
      },
    };
    return {
      last() { return this; }, count: async () => Number(state.open),
      getAttribute: async name => { assert.equal(name, 'data-is_fullpage'); return state.fullpage ? '1' : '0'; },
      async waitFor({ state: expected }) {
        assert.equal(expected, 'hidden'); assert.equal(state.open, false); calls.push(`closed:${id}`);
      },
      locator(child) {
        assert.ok(['.dashboard-app-drawer-toggle', '.dashboard-app-drawer-close', '.window-close-btn'].includes(child));
        return {
          first() { return this; },
          async getAttribute(name) { assert.equal(name, 'aria-expanded'); return String(state.expanded); },
          async click() {
            if (child === '.dashboard-app-drawer-toggle') {
              assert.equal(state.expanded, false); state.expanded = true; calls.push(`expand:${id}`); return;
            }
            if (child === '.dashboard-app-drawer-close') {
              assert.equal(state.fullpage, true); assert.equal(state.expanded, true);
            } else {
              assert.equal(state.fullpage, false);
              if (id === 'code') assert.ok(dockVisible(), 'Browser iframe intercepts the Code titlebar');
            }
            state.open = false; calls.push(`close:${id}:${child}`);
          },
        };
      },
    };
  } };
  return { page, calls, windows };
}

test('post-restart Code reopen uncovers its Close button through the Browser drawer first', async () => {
  for (const expanded of [false, true]) {
    const { page, calls } = windowFixture({ expanded });
    await closeApp(page, 'code');
    assert.deepEqual(calls, [...(expanded ? [] : ['expand:desktop']),
      'close:desktop:.dashboard-app-drawer-close', 'closed:desktop', 'dock:code',
      'close:code:.window-close-btn', 'closed:code']);
  }
});

test('closing Settings above the full-bleed Browser preserves the restart computer identity', async () => {
  const { page, calls, windows } = windowFixture();
  await closeApp(page, 'settings');
  assert.equal(windows.desktop.open, true);
  assert.deepEqual(calls, ['close:settings:.window-close-btn', 'closed:settings']);
});

test('windowed Browser closes through its titlebar and an absent Code needs no cleanup', async () => {
  const { page, calls } = windowFixture({ fullpage: false });
  await closeApp(page, 'desktop');
  assert.deepEqual(calls, ['dock:desktop', 'close:desktop:.window-close-btn', 'closed:desktop']);
  const absent = windowFixture({ codeOpen: false });
  await closeApp(absent.page, 'code');
  assert.deepEqual(absent.calls, []);
});
