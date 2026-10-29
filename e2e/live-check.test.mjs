import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateResults, isMeaningfulFrame, isRealStop, isValidRelayRenewal, MAX_CHECK_MS, FINAL_STOP_TIMEOUT_MS, MAX_RUN_MS, parseTerminalMarker, redactEvidence, renewWithOneRetry, runLiveCheck, terminalProbeCommand } from './live-check.mjs';
import { APP_STOP_FETCH_TIMEOUT_MS } from './deployed-target.mjs';
import { verifySelectedComputer, stopIsolatedComputer } from './isolated-computer.mjs';

const nonce = 'a1'.repeat(10);

function sampleFrame(colorAt = () => [0, 0, 0]) {
  return Uint8ClampedArray.from(Array.from({ length: 64 * 36 }, (_, i) => [...colorAt(i), 255]).flat());
}

const desktopFrame = sampleFrame(i => i % 64 < 12 ? [225, 230, 235] : [18, 32, 60]);

test('paint verdict rejects all-black, one cursor pixel, and uniform grey frames', () => {
  assert.equal(isMeaningfulFrame(sampleFrame()), false);
  assert.equal(isMeaningfulFrame(sampleFrame(i => i === 1152 ? [255, 255, 255] : [0, 0, 0])), false);
  assert.equal(isMeaningfulFrame(sampleFrame(() => [128, 128, 128])), false);
});

test('paint verdict accepts a desktop-like distribution and requires sufficient visible area and contrast', () => {
  assert.equal(isMeaningfulFrame(desktopFrame), true);
  assert.equal(isMeaningfulFrame(sampleFrame(i => i < 46 ? [255, 255, 255] : [0, 0, 0])), false);
  assert.equal(isMeaningfulFrame(sampleFrame(i => i < 47 ? [255, 255, 255] : [0, 0, 0])), true);
  assert.equal(isMeaningfulFrame(sampleFrame(i => i % 2 ? [50, 50, 50] : [80, 80, 80])), false);
  assert.equal(isMeaningfulFrame(sampleFrame(i => i % 2 ? [10, 10, 10] : [24, 24, 24])), false);
  for (const pixels of [null, [], [255, 255, 255, 255]]) assert.equal(isMeaningfulFrame(pixels), false);
  assert.equal(isMeaningfulFrame(desktopFrame, 32, 72), false);
});

test('marker parsing ignores echoed warm and cold commands, including soft wraps', () => {
  for (const cold of [false, true]) {
    const marker = `${cold ? 'C' : 'W'}${nonce}`;
    const command = terminalProbeCommand(nonce, cold);
    assert.equal(parseTerminalMarker(command, marker), null);
    assert.equal(parseTerminalMarker(command.match(/.{1,37}/g).join('\n'), marker), null);
    const expected = cold ? nonce : 'ok';
    const output = `${marker}[${expected}]`.match(/.{1,7}/g).join('\n');
    assert.equal(parseTerminalMarker(`root@computer:~# ${command}\n${output}\nroot@computer:~#`, marker), expected);
  }
});

test('marker parsing rejects absent, stale, and incomplete output', () => {
  const marker = `C${nonce}`;
  for (const text of ['', `C${'b2'.repeat(10)}[${nonce}]`, `${marker}[unfinished`]) {
    assert.equal(parseTerminalMarker(text, marker), null);
  }
  assert.equal(parseTerminalMarker(`${marker}[]`, marker), '');
  assert.equal(parseTerminalMarker(null, marker), null);
  assert.equal(parseTerminalMarker('[]', ''), null);
});

test('marker parsing handles ANSI formatting, literal markers, and latest output', () => {
  assert.equal(parseTerminalMarker('\x1b[32mPROBE.1[old]\x1b[0m\nPROBE.1[new]', 'PROBE.1'), 'new');
  assert.equal(parseTerminalMarker('PROBEx1[wrong]', 'PROBE.1'), null);
});

test('terminal probes require tmux and opencode success before emitting a marker', () => {
  const command = terminalProbeCommand(nonce);
  assert.match(command, /tmux new-session -d .* && tmux has-session -t /);
  assert.match(command, /&& opencode --version >\/dev\/null 2>&1 && printf/);
  assert.match(command, / > \/root\/\.ezil-live-mark && printf '%s\[%s\]\\n'/);
  assert.match(command, /; tmux kill-session -t /);
  assert.match(terminalProbeCommand(nonce, true), /cat \/root\/\.ezil-live-mark/);
  assert.throws(() => terminalProbeCommand('$(unsafe)'), /Invalid probe nonce/);
});

test('aggregation passes only nonempty successful checks and fails on any failure', () => {
  const passed = [{ check: 'sign-in', ok: true, ms: 2 }, { check: 'warm-browser-paint', ok: true, ms: 20 }];
  assert.equal(aggregateResults(passed).result, 'PASS');
  assert.equal(aggregateResults([]).result, 'FAIL');
  for (let index = 0; index < passed.length; index++) {
    assert.equal(aggregateResults(passed.map((check, i) => ({ ...check, ok: i !== index }))).result, 'FAIL');
  }
  for (const malformed of [null, {}, { check: 'stop', ok: 'true', ms: 0 }, { check: 'stop', ok: true, ms: NaN }]) {
    assert.equal(aggregateResults([...passed, malformed]).result, 'FAIL');
  }
});

test('evidence redaction drops credentials, cookies, token URLs, UUIDs, and arbitrary diagnostics', () => {
  const privateData = {
    email: 'private@example.test', password: 'private-password', cookie: 'session=private-cookie',
    headers: { authorization: 'Bearer private-token', 'x-vercel-protection-bypass': 'private-bypass' },
    url: 'https://frame.example.test/?token=private-token', computerId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    error: new Error('private-password'), output: 'private terminal text',
  };
  const raw = { check: 'relay-read', ok: false, ms: 12.2, ...privateData };
  assert.deepEqual(redactEvidence(raw), { check: 'relay-read', ok: false, ms: 12 });
  assert.deepEqual(aggregateResults([raw]), { result: 'FAIL', checks: [{ check: 'relay-read', ok: false, ms: 12 }] });
  for (const check of [privateData.url, privateData.computerId, privateData.cookie, privateData.password]) {
    assert.deepEqual(redactEvidence({ check, ok: true, ms: privateData.password }), { check: 'unknown', ok: false, ms: 0 });
  }
  assert.equal(raw.password, privateData.password, 'redaction must not mutate the source');
});

test('real stop rejects already stopped, incomplete, failed, and non-200 responses', () => {
  const good = { status: 200, json: { ok: true, outcome: 'destroyed', terminated: true } };
  assert.equal(isRealStop(good), true);
  for (const response of [null, { ...good, status: 502 }, { status: 200, json: null },
    { ...good, json: { ...good.json, ok: false } },
    { ...good, json: { ...good.json, outcome: 'not_running', terminated: false } },
    { ...good, json: { ...good.json, terminated: false } },
    { ...good, json: { ok: true, terminated: true } }]) {
    assert.equal(isRealStop(response), false);
  }
});

test('relay renewal requires the runtime from the preceding read', () => {
  const read = { runtimeId: 'runtime-a', expiresAt: 2000 };
  const renew = { status: 200, json: { ok: true, ...read, expiresAt: 3000 } };
  assert.equal(isValidRelayRenewal(read, renew, 1000), true);
  for (const runtimeId of ['runtime-b', '', undefined, null]) {
    assert.equal(isValidRelayRenewal(read, { ...renew, json: { ...renew.json, runtimeId } }, 1000), false);
  }
});

test('relay renewal must strictly extend expiry, even when the old expiry is still in the future', () => {
  const read = { runtimeId: 'runtime-a', expiresAt: 2000 };
  for (const expiresAt of [2000, 1999, 1000, '3000', NaN, Infinity, undefined]) {
    assert.equal(isValidRelayRenewal(read, { status: 200, json: { ok: true, ...read, expiresAt } }, 1000), false);
  }
  const renew = { status: 200, json: { ok: true, ...read, expiresAt: 3000 } };
  assert.equal(isValidRelayRenewal(read, renew, 3000), false);
  for (const response of [null, { ...renew, status: 500 }, { status: 200, json: null },
    { ...renew, json: { ...renew.json, ok: false } }]) {
    assert.equal(isValidRelayRenewal(read, response, 1000), false);
  }
});

test('relay renewal succeeds immediately without re-reading or sleeping', async () => {
  const initialRead = { runtimeId: 'runtime-a', expiresAt: 2000 };
  const response = { status: 200, json: { ok: true, ...initialRead, expiresAt: 3000 } };
  let renewals = 0;
  assert.equal(await renewWithOneRetry({
    initialRead,
    read: async () => assert.fail('unexpected re-read'),
    renew: async current => {
      assert.equal(current, initialRead);
      renewals++;
      return response;
    },
    sleep: async () => assert.fail('unexpected pause'),
    now: () => 1000,
  }), response);
  assert.equal(renewals, 1);
});

test('relay renewal retries once after a fresh read and a short pause', async () => {
  const initialRead = { runtimeId: 'runtime-a', expiresAt: 2000 };
  const freshRead = { ...initialRead, expiresAt: 4000 };
  const response = { status: 200, json: { ok: true, ...freshRead, expiresAt: 5000 } };
  const events = [];
  assert.equal(await renewWithOneRetry({
    initialRead,
    read: async () => { events.push('read'); return freshRead; },
    renew: async current => {
      events.push(current);
      return current === initialRead ? { status: 200, json: { ok: true, ...initialRead } } : response;
    },
    sleep: async ms => { events.push(ms); },
    now: () => 1000,
  }), response);
  assert.deepEqual(events, [initialRead, 'read', 2000, freshRead]);
});

test('relay renewal fails after two invalid attempts and compares retry expiry to the fresh read', async () => {
  const initialRead = { runtimeId: 'runtime-a', expiresAt: 2000 };
  const freshRead = { ...initialRead, expiresAt: 4000 };
  const events = [];
  await assert.rejects(renewWithOneRetry({
    initialRead,
    read: async () => { events.push('read'); return freshRead; },
    renew: async current => {
      events.push(current);
      return { status: 200, json: { ok: true, ...current,
        expiresAt: current === initialRead ? 2000 : 3000 } };
    },
    sleep: async ms => { events.push(ms); },
    now: () => 1000,
  }), /Relay renewal failed/);
  assert.deepEqual(events, [initialRead, 'read', 2000, freshRead]);
});

test('relay renewal fails if re-reading finds a replacement runtime', async () => {
  const initialRead = { runtimeId: 'runtime-a', expiresAt: 2000 };
  const events = [];
  await assert.rejects(renewWithOneRetry({
    initialRead,
    read: async () => {
      events.push('read');
      return { runtimeId: 'runtime-b', expiresAt: 4000 };
    },
    renew: async current => {
      assert.equal(current, initialRead, 'must not renew a replacement runtime');
      events.push('renew');
      return { status: 200, json: { ok: true, ...current } };
    },
    sleep: async () => assert.fail('must reject a replacement runtime immediately'),
    now: () => 1000,
  }), /Relay runtime changed/);
  assert.deepEqual(events, ['renew', 'read']);
});

test('relay retry still rejects a mismatched runtime or an expiry that has elapsed during the pause', async () => {
  const initialRead = { runtimeId: 'runtime-a', expiresAt: 2000 };
  const freshRead = { ...initialRead, expiresAt: 4000 };
  for (const invalid of [{ runtimeId: 'runtime-b', expiresAt: 6000 }, { expiresAt: 5000 }]) {
    let time = 3000, renewals = 0;
    await assert.rejects(renewWithOneRetry({
      initialRead,
      read: async () => freshRead,
      renew: async current => {
        renewals++;
        return { status: 200, json: { ok: true, ...current, ...(renewals === 2 ? invalid : {}) } };
      },
      sleep: async ms => { time += ms; },
      now: () => time,
    }), /Relay renewal failed/);
    assert.equal(renewals, 2);
  }
});

// Public values the programmatic sign-in needs (see sign-in.mjs).
const supabase = { NEXT_PUBLIC_SUPABASE_URL: 'https://db.example.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'public-anon-key' };

test('CLI setup failure exits 1 and writes redacted JSON without loading a browser', () => {
  const out = mkdtempSync(join(tmpdir(), 'ezil-live-unit-'));
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./live-check.mjs', import.meta.url))], {
      encoding: 'utf8', timeout: 5000,
      env: { EZIL_E2E_APP: 'invalid-origin?token=private-token', EZIL_E2E_EMAIL: 'private@example.test',
        EZIL_E2E_PASSWORD: 'private-password', VERCEL_AUTOMATION_BYPASS_SECRET: 'private-bypass',
        PLAYWRIGHT_REQUIRE_DIR: out, EZIL_LIVE_OUT: out, ...supabase },
    });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    const lines = child.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].check, 'setup');
    assert.equal(lines[0].ok, false);
    assert.equal(lines[1].result, 'FAIL');
    assert.deepEqual(lines[1].checks, [lines[0]]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'live-check.json'), 'utf8')), lines[1]);
    assert.doesNotMatch(child.stdout, /private|invalid-origin|token|cookie/i);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

const isolatedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const otherId = '11111111-2222-3333-4444-555555555555';

async function fakeLiveRun(t, { selectedId = isolatedId, coldId = isolatedId, failWarm = false,
  failStop = false, alreadyStopped = false, relayRace = false, env: overrides = {},
  onWarm = () => {}, onScreenshot = () => {}, onStop = () => {}, onSignIn = () => {} } = {}) {
  const out = mkdtempSync(join(tmpdir(), 'ezil-live-fake-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const events = [], requests = [], emitted = [], visited = [];
  let selected = selectedId, visits = 0, output, warmNonce, relayRenewals = 0;
  const codeLocator = {
    isVisible: async () => true, click: async () => {}, fill: async () => {}, press: async () => {},
    last() { return this; },
    pressSequentially: async command => {
      const [, phase, nonce] = command.match(/([WC])([a-f0-9]{20})/);
      if (phase === 'W') warmNonce = nonce;
      output = `${phase}${nonce}[${phase === 'W' ? 'ok' : warmNonce}]`;
    },
    innerText: async () => output,
  };
  const page = {
    goto: async url => {
      visited.push(new URL(url).pathname);
      if (url.endsWith('/os')) {
        selected = ++visits === 1 ? selectedId : coldId;
        events.push('session-ready');
      }
    },
    waitForFunction: async () => {},
    evaluate: async fn => {
      if (String(fn).includes('computer.id')) return selected;
      if (String(fn).includes('registry.launch')) events.push(`code:${selected}`);
    },
    locator: () => ({ first() { return this; }, click: async () => {
      events.push(`browser:${selected}`);
      onWarm();
      if (failWarm) {
        selected = otherId;
        throw new Error('private mid-run failure');
      }
    } }),
    frames: () => [
      { url: () => 'https://nekodesktop.example.test', evaluate: async () => desktopFrame },
      { url: () => 'https://test-code.example.test', locator: () => codeLocator,
        getByText: () => ({ count: async () => 1 }) },
    ],
    isClosed: () => false,
    screenshot: async () => { events.push('screenshot'); onScreenshot(); },
  };
  const context = {
    setDefaultTimeout: () => {}, newPage: async () => page,
    cookies: async app => {
      assert.equal(app, 'https://live.example.test');
      return [{ name: 'session', value: 'private-cookie' }];
    },
  };
  const browser = { newContext: async () => context, close: async () => { events.push('browser-close'); } };
  const expiry = Date.now() + 60_000;
  const deployment = {
    deployedTarget: () => ({ app: 'https://live.example.test', headers: { 'x-vercel-protection-bypass': 'private-bypass' } }),
    configureAppContext: async () => {},
    cookieHeader: cookies => cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
    appRequest: async (url, options) => {
      assert.equal(options.signal.aborted, false, 'cleanup must not inherit the failed run signal');
      requests.push({ url, ...options });
      if (url.endsWith('/stop')) {
        events.push(`stop:${JSON.parse(options.body).computerId}`);
        onStop();
        if (failStop) throw new Error('private stop failure');
        return { status: 200, body: Buffer.from(JSON.stringify({ ok: true,
          outcome: alreadyStopped ? 'not_running' : 'destroyed', terminated: !alreadyStopped })) };
      }
      let expiresAt = expiry;
      if (options.method === 'POST') {
        relayRenewals++;
        if (!relayRace || relayRenewals > 1) expiresAt += 60_000;
      } else if (relayRace && relayRenewals > 0) expiresAt += 30_000;
      return { status: 200, body: Buffer.from(JSON.stringify({ ok: true, runtimeId: 'test-runtime', expiresAt })) };
    },
  };
  const report = await runLiveCheck({
    env: { EZIL_E2E_EMAIL: 'test@example.test', EZIL_E2E_PASSWORD: 'private-password', PLAYWRIGHT_REQUIRE_DIR: out, ...supabase,
      EZIL_E2E_COMPUTER_ID: isolatedId, EZIL_E2E_REQUIRE_TARGET: '1', EZIL_LIVE_OUT: out, ...overrides },
    loadDependencies: async () => ({ deployment, signIn: async (_page, options) => onSignIn(options),
      chromium: { launch: async () => browser }, verifySelectedComputer, stopIsolatedComputer }),
    emit: value => emitted.push(value),
  });
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'live-check.json'), 'utf8')), report);
  assert.deepEqual(emitted.at(-1), report);
  assert.doesNotMatch(JSON.stringify(emitted), /private|aaaaaaaa|11111111/);
  return { report, events, requests, visited };
}

test('live check signs in programmatically on the target origin, never through /login', async t => {
  let options;
  const { report, visited } = await fakeLiveRun(t, { env: { EZIL_LIVE_SKIP_COLD: '1' }, onSignIn: value => { options = value; } });
  assert.equal(report.result, 'PASS');
  assert.equal(options.app, 'https://live.example.test');
  assert.equal(options.destination, '/computers');
  assert.equal(options.env.NEXT_PUBLIC_SUPABASE_URL, supabase.NEXT_PUBLIC_SUPABASE_URL);
  assert.equal(visited.some(path => path.startsWith('/login')), false);
});

test('live check setup fails without the public Supabase sign-in inputs', async t => {
  for (const name of Object.keys(supabase)) {
    let signedIn = false;
    const { report } = await fakeLiveRun(t, { env: { [name]: '' }, onSignIn: () => { signedIn = true; } });
    assert.equal(report.result, 'FAIL');
    assert.deepEqual(report.checks.map(check => [check.check, check.ok]).slice(0, 1), [['setup', false]]);
    assert.equal(signedIn, false);
  }
});

test('live check retries a relay race using a fresh GET and the original computer for both renewals', async t => {
  const { report, requests } = await fakeLiveRun(t, { relayRace: true, env: { EZIL_LIVE_SKIP_COLD: '1' } });
  assert.equal(report.result, 'PASS');
  assert.equal(report.checks.find(check => check.check === 'relay-renew').ok, true);
  const relayRequests = requests.filter(({ url }) => url.includes('/relay-refresh'));
  assert.deepEqual(relayRequests.map(({ method }) => method), ['GET', 'POST', 'GET', 'POST']);
  for (const request of relayRequests) {
    if (request.method === 'GET') {
      assert.equal(new URL(request.url).searchParams.get('computerId'), isolatedId);
    } else {
      assert.deepEqual(JSON.parse(request.body), { computerId: isolatedId, runtimeId: 'test-runtime' });
    }
  }
});

test('live check refuses a mismatched or missing required computer before any operation', async t => {
  for (const options of [{ selectedId: otherId }, { env: { EZIL_E2E_COMPUTER_ID: '' } },
    { env: { EZIL_E2E_COMPUTER_ID: 'invalid' } }]) {
    const { report, events, requests } = await fakeLiveRun(t, options);
    assert.equal(report.result, 'FAIL');
    assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.check), ['os-session-ready']);
    assert.deepEqual(events, ['session-ready', 'screenshot', 'browser-close']);
    assert.deepEqual(requests, []);
    assert.ok(!report.checks.some(check => check.check === 'final-stop'));
  }
});

test('final stop runs after a mid-run failure and targets only the previously validated id', async t => {
  for (const alreadyStopped of [false, true]) {
    const { report, events, requests } = await fakeLiveRun(t, { failWarm: true, alreadyStopped });
    assert.equal(report.result, 'FAIL');
    assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.check), ['warm-browser-paint']);
    assert.equal(report.checks.find(check => check.check === 'final-stop').ok, true);
    assert.deepEqual(events, ['session-ready', `browser:${isolatedId}`, 'screenshot', `stop:${isolatedId}`, 'browser-close']);
    assert.equal(requests.length, 1);
    assert.deepEqual(JSON.parse(requests[0].body), { computerId: isolatedId });
    assert.equal(requests[0].headers.cookie, 'session=private-cookie');
    assert.equal(requests[0].headers['x-vercel-protection-bypass'], 'private-bypass');
    assert.equal(requests[0].timeout, APP_STOP_FETCH_TIMEOUT_MS);
  }
});

test('exhausting normal checks leaves the full stop budget plus evidence and browser shutdown time', async t => {
  assert.equal(MAX_CHECK_MS, 8 * 60_000);
  assert.equal(FINAL_STOP_TIMEOUT_MS, APP_STOP_FETCH_TIMEOUT_MS);
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const delays = [];
  const realSetTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
    delays.push(ms);
    return realSetTimeout(callback, ms, ...args);
  });
  const { report, requests, events } = await fakeLiveRun(t, {
    onWarm: () => { elapsed = MAX_CHECK_MS; },
    onScreenshot: () => { elapsed += 5000; },
    onStop: () => { elapsed += APP_STOP_FETCH_TIMEOUT_MS - 1; },
  });
  assert.equal(report.result, 'FAIL');
  assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.check), ['warm-browser-paint']);
  assert.equal(report.checks.find(check => check.check === 'final-stop').ok, true);
  assert.equal(requests.length, 1, 'no normal API calls may run after the deadline');
  assert.equal(requests[0].timeout, APP_STOP_FETCH_TIMEOUT_MS);
  assert.deepEqual(events.slice(-2), [`stop:${isolatedId}`, 'browser-close']);
  assert.equal(delays[0], MAX_RUN_MS, 'hard exit must include cleanup and shutdown');
  assert.ok(delays.includes(APP_STOP_FETCH_TIMEOUT_MS), 'cleanup bound must allow the full stop');
  assert.ok(elapsed + 10_000 < MAX_RUN_MS, 'browser close and evidence must fit after a slow stop');
});

test('final-stop failure preserves earlier failure evidence and still closes the browser', async t => {
  const { report, events } = await fakeLiveRun(t, { failWarm: true, failStop: true });
  assert.equal(report.result, 'FAIL');
  assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.check), ['warm-browser-paint', 'final-stop']);
  assert.equal(events.filter(event => event === 'screenshot').length, 1);
  assert.equal(events.at(-1), 'browser-close');
});

test('cold reload revalidates before cold actions and cannot redirect cleanup to another computer', async t => {
  const { report, events } = await fakeLiveRun(t, { coldId: otherId });
  assert.equal(report.result, 'FAIL');
  assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.check), ['cold-os-session-ready']);
  assert.deepEqual(events.filter(event => /^(browser|code):/.test(event)), [`browser:${isolatedId}`, `code:${isolatedId}`]);
  assert.deepEqual(events.filter(event => event.startsWith('stop:')), [`stop:${isolatedId}`, `stop:${isolatedId}`]);
  assert.equal(report.checks.find(check => check.check === 'final-stop').ok, true);
});

test('successful cold run stops the cold-started computer before browser shutdown', async t => {
  const { report, events } = await fakeLiveRun(t);
  assert.equal(report.result, 'PASS');
  assert.deepEqual(events.filter(event => event.startsWith('stop:')), [`stop:${isolatedId}`, `stop:${isolatedId}`]);
  assert.deepEqual(events.slice(-2), [`stop:${isolatedId}`, 'browser-close']);
  assert.equal(report.checks.find(check => check.check === 'final-stop').ok, true);
});

test('final-stop failure fails an otherwise successful run', async t => {
  const { report } = await fakeLiveRun(t, { failStop: true, env: { EZIL_LIVE_SKIP_COLD: '1' } });
  assert.equal(report.result, 'FAIL');
  assert.deepEqual(report.checks.filter(check => !check.ok).map(check => check.check), ['final-stop']);
});

test('manual local runs without a required target work and skip unvalidated final cleanup', async t => {
  const { report, events } = await fakeLiveRun(t, {
    env: { EZIL_E2E_COMPUTER_ID: '', EZIL_E2E_REQUIRE_TARGET: '', EZIL_LIVE_SKIP_COLD: '1' },
  });
  assert.equal(report.result, 'PASS');
  assert.ok(events.includes(`browser:${isolatedId}`));
  assert.ok(!events.some(event => event.startsWith('stop:')));
  assert.ok(!report.checks.some(check => check.check === 'final-stop'));
});
