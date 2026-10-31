import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { aggregateResults, classifyHost, createRedactor, guardPlaywright,
  isAIAccountError, parseResources, redactEvidence, terminalBlock, command, ensureTerminal,
  closeApp, persistence, restartUnavailableReason, terminalCommand, terminalResult,
  RESTART_COMPUTER_UI, RESTART_COMPUTER_WAIT_MS } from './billing-staging-journey.mjs';

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

const UI = RESTART_COMPUTER_UI;
const SETTINGS = '.window[data-app="settings"]:not([data-closing="1"])';
const PANE = `${SETTINGS} [data-pane="troubleshoot"]`;
// Restart computer's DOM (troubleshoot.js render() and confirmRestartComputer(),
// sheet-frame.js), spelled out apart from the step's own RESTART_COMPUTER_UI so
// the fake below does not follow the step if the step drifts.
const DOM = {
  control: '[data-action="restart-computer"]',
  status: '[data-role="restart-computer-status"]',
  failed: '.ezil-settings-error[data-role="restart-computer-status"]',
  sheet: '[role="dialog"][data-sheet="confirm-restart-computer"]',
  confirm: 'Restart computer',
};
// Restart computer's own lines (troubleshoot.js render() and reasonCopy()). The
// source pin below proves each is in the tab, so the fake draws what the tab draws.
const COPY = {
  restarting: 'Restarting your computer… this usually takes 1–4 minutes. Your files stay.',
  restarted: 'Your computer restarted. Open the desktop to continue.',
  unavailable: 'Not available in this deployment yet.',
  needsDesktop: 'Open a desktop first, then come back here.',
  notRunning: "Your computer isn't running. Open the desktop to start it.",
  transitionFailed: "We couldn't restart your computer. Your files are safe. Try again in a moment.",
};
const RUN = '6f1d1c2e-5d0e-4c1b-9f43-1f4b2a7d9e10';

test('Restart computer skips only on its explicit unavailable line, never on prerequisites or failures', () => {
  assert.equal(restartUnavailableReason(COPY.unavailable), 'restart_not_supported_by_deployment');
  assert.equal(restartUnavailableReason(` ${COPY.unavailable}\n`), 'restart_not_supported_by_deployment');
  // The removed Restart desktop's own limitation lines are no longer skips either.
  for (const text of ['', "This deployment hasn't turned on desktop restarts yet.",
    'This desktop runs on an older stack that cannot be restarted in place.', COPY.needsDesktop,
    COPY.restarting, COPY.restarted, COPY.notRunning, COPY.transitionFailed, 'Your session expired — sign in again.',
    'Could not reach the server. Check your connection and try again.', 'Something went wrong. Please try again.',
    `${COPY.unavailable} ${COPY.needsDesktop}`]) assert.equal(restartUnavailableReason(text), null, text);
});

/** The computer behind the terminal: the step's real scripts, wrapped by the
 * real terminalCommand(), run in bash against a scratch directory standing in
 * for ~, /workspace and the kernel's boot id. Shell functions stand in for
 * tmux, hostname, free and nproc. A restart (reboot) ends every tmux session
 * unless told otherwise, changes the boot id, and deletes the files in `lose`.
 */
function fakeComputer({ lose = [], tmuxSurvives = false, workspace = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-persistence-'));
  for (const dir of ['home', 'tmp']) mkdirSync(join(root, dir));
  // Without a workspace directory, writing the /workspace marker fails.
  if (workspace) mkdirSync(join(root, 'workspace')); else writeFileSync(join(root, 'workspace'), '');
  writeFileSync(join(root, 'boot_id'), 'boot-1\n');
  writeFileSync(join(root, 'tmux'), '');
  const calls = [];
  let rebooted = false;
  const prelude = [
    'tmux() { case "$1" in',
    '  ls) if [ -s "$FAKE/tmux" ]; then cat "$FAKE/tmux"; else echo "no server running on /tmp/tmux-0/default" >&2; return 1; fi ;;',
    '  new) printf \'%s: 1 windows (created today)\\n\' "$4" >> "$FAKE/tmux" ;;',
    '  kill-session) grep -v "^$3:" "$FAKE/tmux" > "$FAKE/tmux.next"; mv "$FAKE/tmux.next" "$FAKE/tmux" ;;',
    '  *) return 2 ;;',
    'esac; }',
    'hostname() { echo computer-a; }',
    'free() { printf \'%s\\n\' "               total        used        free" "Mem:            7680         123        7000" "Swap:              0           0           0"; }',
    'nproc() { echo 2; }',
  ].join('\n');
  const terminal = async (script, runId, phase) => {
    calls.push(`terminal:${phase}`);
    if (phase === 'after') assert.ok(rebooted, 'the markers are read back only after the restart finished');
    const { begin, end, out, line } = terminalCommand(script, runId, phase);
    const file = join(root, 'tmp', basename(out));
    // The computer's own paths, moved into this run's directory; ~ is $HOME.
    const local = line.replaceAll(out, file).replaceAll('/workspace/', `${root}/workspace/`)
      .replaceAll('/proc/sys/kernel/random/boot_id', join(root, 'boot_id'));
    execFileSync('bash', ['-c', `${prelude}\n${local}`],
      { env: { PATH: process.env.PATH, HOME: join(root, 'home'), FAKE: root }, timeout: 10_000 });
    const result = terminalResult(readFileSync(file, 'utf8'), begin, end);
    assert.ok(result, 'the output file holds both markers');
    return result;
  };
  const reboot = () => {
    calls.push('reboot');
    rebooted = true;
    writeFileSync(join(root, 'boot_id'), 'boot-2\n');
    if (!tmuxSurvives) writeFileSync(join(root, 'tmux'), '');
    // No force: the marker must have been written before it can be lost.
    for (const path of lose) rmSync(join(root, path));
  };
  return { calls, terminal, reboot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Settings → Troubleshoot as troubleshoot.js draws it, behind the Playwright
 * calls the step makes, over a fakeComputer(). Any other selector or call throws,
 * so the removed Restart desktop control or a page-wide button lookup cannot pass.
 * The server's transition settles on the `polls`-th read of the status line.
 */
function restartFixture({ supported = true, desktop = true, outcome = 'done', polls = 3,
  failure = COPY.transitionFailed, ...machine } = {}) {
  const computer = fakeComputer(machine);
  const { calls } = computer;
  const ui = { open: false, tab: false, status: 'idle', sheet: false, reads: 0 };
  const line = () => ({ restarting: COPY.restarting, restarted: COPY.restarted, failed: failure })[ui.status]
    ?? (!supported ? COPY.unavailable : !desktop ? COPY.needsDesktop : null);
  const disabled = () => ui.status === 'restarting' || !supported || !desktop;
  const settle = () => {
    if (ui.status !== 'restarting' || ++ui.reads < polls) return;
    if (outcome === 'done') { ui.status = 'restarted'; computer.reboot(); }
    if (outcome === 'failed') ui.status = 'failed';
  };
  const handlers = {
    '.taskbar-item[data-app="settings"]': {
      isVisible: () => true,
      click: () => { calls.push('dock:settings'); ui.open = true; },
    },
    [`${SETTINGS} [data-tab="troubleshoot"]`]: {
      click: () => { assert.ok(ui.open, 'Settings is open'); calls.push('tab:troubleshoot'); ui.tab = true; },
    },
    [PANE]: { waitFor: ({ state }) => { assert.equal(state, 'visible'); assert.ok(ui.tab, 'Troubleshoot is showing'); } },
    [`${PANE} ${DOM.control}`]: {
      isVisible: () => ui.tab,
      isEnabled: () => !disabled(),
      click: () => { assert.ok(!disabled(), 'a disabled control is never clicked'); calls.push('control'); ui.sheet = true; },
    },
    [`${PANE} ${DOM.status}`]: {
      count: () => { settle(); return Number(line() !== null); },
      innerText: () => line() ?? assert.fail('no status line to read'),
    },
    [`${PANE} ${DOM.failed}`]: { count: () => Number(ui.status === 'failed') },
    [DOM.sheet]: { waitFor: ({ state }) => { assert.equal(state, 'visible'); assert.ok(ui.sheet, 'the confirm sheet is open'); } },
    [`${DOM.sheet} button "${DOM.confirm}"`]: {
      click: () => { assert.ok(ui.sheet); calls.push('confirm'); ui.sheet = false; ui.status = 'restarting'; },
    },
  };
  const node = key => {
    const call = method => async (...args) => {
      const handler = handlers[key]?.[method];
      if (!handler) throw new Error(`Unexpected ${method}() on ${key}`);
      return handler(...args);
    };
    return {
      first() { return this; }, last() { return this; },
      locator: child => node(`${key} ${child}`),
      getByRole(role, { name, exact } = {}) {
        assert.equal(exact, true, 'an exact name');
        return node(`${key} ${role} "${name}"`);
      },
      ...Object.fromEntries(['isVisible', 'isEnabled', 'click', 'waitFor', 'count', 'innerText'].map(name => [name, call(name)])),
    };
  };
  const steps = {
    terminal: computer.terminal,
    closeApp: async id => {
      calls.push(`close:${id}`);
      // A fresh Settings window re-runs the tab's init: status back to idle.
      if (id === 'settings') Object.assign(ui, { open: false, tab: false, status: 'idle', sheet: false, reads: 0 });
    },
    openApp: async (id, evidence) => { calls.push(`open:${id}`); evidence.ttiMs = 0; },
  };
  return { page: { locator: node }, steps, calls, cleanup: computer.cleanup };
}

/** The step through guardPlaywright, on node:test's mocked clock: until()'s
 * polls and its real 15 s and 360 s budgets pass in simulated time. The status
 * is main()'s record() verdict: a throw FAILs, a returned reason SKIPs.
 */
async function runStep(t, fixture, evidence) {
  t.after(fixture.cleanup);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  try {
    let settled = false;
    const status = persistence(guardPlaywright(fixture.page, createRedactor()), RUN, evidence, { steps: fixture.steps })
      .then(reason => reason ? `SKIP:${reason}` : 'PASS', error => `FAIL:${error.message}`)
      .finally(() => { settled = true; });
    while (!settled) {
      assert.ok(Date.now() < 3_600_000, 'the step settles within a simulated hour');
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(100);
    }
    return { status: await status, ms: Date.now() };
  } finally { t.mock.timers.reset(); }
}

test('persistence: Restart computer through its sheet keeps both markers; a lost tmux session is evidence only', async t => {
  for (const tmuxSurvives of [false, true]) {
    const fixture = restartFixture({ tmuxSurvives });
    const evidence = {};
    const { status, ms } = await runStep(t, fixture, evidence);
    assert.equal(status, 'PASS', tmuxSurvives);
    assert.ok(ms < 5_000, ms);
    assert.deepEqual(fixture.calls, ['terminal:before', 'close:settings', 'dock:settings', 'tab:troubleshoot',
      'control', 'confirm', 'reboot', 'close:settings', 'open:desktop', 'open:code', 'terminal:after']);
    assert.deepEqual(evidence.restartControl, { path: 'Settings → Troubleshoot → Restart computer', visible: true,
      enabled: true, explanation: '', unavailableReason: null, status: COPY.restarted, restartingSeen: true });
    assert.equal(evidence.filePersisted, true);
    assert.equal(evidence.workspaceFilePersisted, true);
    // The session was started before the restart; whether it is back is recorded either way.
    assert.match(evidence.beforeTerminal, /^E2E_RC=0$/m);
    assert.equal(evidence.tmuxSessionPresent, tmuxSurvives);
    assert.equal(evidence.tmuxExitCode, tmuxSurvives ? 0 : 1);
    assert.equal(evidence.bootIdChanged, true);
    assert.deepEqual([evidence.host, evidence.hostAfter], ['computer-a', 'computer-a']);
    assert.deepEqual(evidence.resources, { ramMiB: 7680, vcpus: 2 });
    assert.deepEqual([evidence.priorMarker, evidence.priorWorkspaceMarker, evidence.priorTmux], [null, null, null]);
    assert.equal(typeof evidence.restartComputerMs, 'number');
    assert.deepEqual([evidence.desktopAfterRestart, evidence.codeAfterRestart], [{ ttiMs: 0 }, { ttiMs: 0 }]);
    for (const gone of ['restartMs', 'desktopBeforeRestart']) assert.ok(!(gone in evidence), gone);
  }
});

test('persistence FAILs, never SKIPs, when either marker is lost across the restart', async t => {
  for (const [lose, path] of [['home/e2e-persist.txt', '~/e2e-persist.txt'],
    ['workspace/.e2e-persist.txt', '/workspace/.e2e-persist.txt']]) {
    const fixture = restartFixture({ lose: [lose] });
    const evidence = {};
    assert.equal((await runStep(t, fixture, evidence)).status, `FAIL:Persistence marker was not restored after restart: ${path}`);
    assert.equal(evidence.filePersisted, lose.startsWith('workspace'), lose);
    assert.equal(evidence.workspaceFilePersisted, lose.startsWith('home'), lose);
    assert.equal(fixture.calls.at(-1), 'terminal:after');
  }
});

test('persistence FAILs before restarting when a marker could not be written', async t => {
  const fixture = restartFixture({ workspace: false });
  assert.equal((await runStep(t, fixture, {})).status, 'FAIL:Persistence marker was not written: /workspace/.e2e-persist.txt');
  assert.deepEqual(fixture.calls, ['terminal:before']);
});

test('persistence FAILs on Restart computer\'s failure copy and reads nothing back', async t => {
  // A refused request shows at the first read; a failed transition after a few.
  for (const [failure, polls] of [[COPY.notRunning, 1], [COPY.transitionFailed, 3]]) {
    const fixture = restartFixture({ outcome: 'failed', failure, polls });
    const evidence = {};
    assert.equal((await runStep(t, fixture, evidence)).status, `FAIL:Restart computer failed: ${failure}`);
    assert.equal(evidence.restartControl.status, failure);
    assert.deepEqual(fixture.calls.slice(-2), ['control', 'confirm']);
  }
});

test('persistence SKIPs on the explicit unavailable line without touching the control or the sheet', async t => {
  const fixture = restartFixture({ supported: false });
  const evidence = {};
  assert.equal((await runStep(t, fixture, evidence)).status, 'SKIP:restart_not_supported_by_deployment');
  assert.deepEqual(fixture.calls, ['terminal:before', 'close:settings', 'dock:settings', 'tab:troubleshoot']);
  assert.deepEqual(evidence.restartControl, { path: 'Settings → Troubleshoot → Restart computer', visible: true,
    enabled: false, explanation: COPY.unavailable, unavailableReason: 'restart_not_supported_by_deployment' });
});

test('persistence FAILs with the missing prerequisite\'s own copy after the 15 s control wait', async t => {
  const fixture = restartFixture({ desktop: false });
  const evidence = {};
  const { status, ms } = await runStep(t, fixture, evidence);
  assert.equal(status, `FAIL:Restart computer did not enable: ${COPY.needsDesktop}`);
  assert.ok(ms >= 15_000 && ms < 16_000, ms);
  assert.equal(evidence.restartControl.unavailableReason, null);
  assert.ok(!fixture.calls.includes('control'));
});

test('persistence FAILs when the restart never settles, at a budget that covers the promised 1–4 minutes', async t => {
  assert.ok(RESTART_COMPUTER_WAIT_MS >= 300_000, RESTART_COMPUTER_WAIT_MS);
  const fixture = restartFixture({ outcome: 'stuck' });
  const evidence = {};
  const { status, ms } = await runStep(t, fixture, evidence);
  assert.equal(status, 'FAIL:Timed out: Restart computer outcome');
  assert.ok(ms >= RESTART_COMPUTER_WAIT_MS && ms < RESTART_COMPUTER_WAIT_MS + 1_000, ms);
  assert.equal(evidence.restartControl.status, COPY.restarting);
  assert.equal(evidence.restartControl.restartingSeen, true);
  assert.deepEqual(fixture.calls.slice(-2), ['control', 'confirm']);
});

test('source pin: every Restart computer selector and line the step uses is in the tab; Restart desktop is not', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const tab = read('../shell/ezil/ui/Settings/tabs/troubleshoot.js');
  const sheet = read('../shell/ezil/ui/Settings/sheet-frame.js');
  const journey = read('./billing-staging-journey.mjs');
  const statusLine = copy => assert.ok(tab.includes(`data-role="restart-computer-status">${copy}`), copy);
  const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pins = {
    path: () => {
      assert.ok(tab.includes("label: 'Troubleshoot'"));
      assert.ok(tab.includes('<h3>Restart computer</h3>'));
    },
    control: () => assert.match(tab, new RegExp(`<button [^>]*${escapeRegex(DOM.control.slice(1, -1))}`)),
    status: () => assert.ok(tab.includes(DOM.status.slice(1, -1))),
    failed: () => assert.ok(tab.includes(`<p class="ezil-settings-error" ${DOM.status.slice(1, -1)}>`)),
    sheet: () => {
      assert.equal(DOM.sheet, '[role="dialog"][data-sheet="confirm-restart-computer"]');
      assert.ok(tab.includes("sheet: 'confirm-restart-computer'"));
      assert.ok(sheet.includes('<div class="ezil-upgrade-sheet" role="dialog"'));
      assert.ok(sheet.includes('dialog.dataset.sheet = sheet;'));
    },
    confirm: () => {
      assert.ok(tab.includes(`confirmLabel: '${DOM.confirm}'`));
      assert.ok(sheet.includes('primary.textContent = confirmLabel;'));
    },
    restarting: () => statusLine(UI.restarting),
    restarted: () => statusLine(UI.restarted),
    unavailable: () => statusLine(`${UI.unavailable}<`),
  };
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(UI).sort(), 'every value the step relies on is pinned');
  for (const pin of Object.values(pins)) pin();
  // The step uses the DOM pinned here.
  for (const [key, value] of Object.entries(DOM)) assert.equal(UI[key], value, key);
  // The fake's lines are the tab's own.
  for (const copy of [COPY.restarting, COPY.restarted, COPY.unavailable, COPY.needsDesktop]) statusLine(`${copy}<`);
  for (const copy of [COPY.notRunning, COPY.transitionFailed]) assert.ok(tab.includes(`"${copy}"`), copy);
  assert.ok(COPY.restarting.startsWith(UI.restarting) && COPY.restarted.startsWith(UI.restarted));
  // Restart desktop is gone from the tab and from the step. The same files carry
  // the restart-computer spellings (the pins above), so these reads are live.
  for (const [name, source] of [['troubleshoot.js', tab], ['billing-staging-journey.mjs', journey]]) {
    assert.ok(source.includes('data-action="restart-computer"'), name);
    assert.ok(!source.includes('data-action="restart"'), name);
    assert.ok(!source.includes('Restart requested.'), name);
  }
  assert.ok(!journey.includes("name: 'Restart', exact: true"));
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

test('closing Settings above the full-bleed Browser leaves the Browser open', async () => {
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
