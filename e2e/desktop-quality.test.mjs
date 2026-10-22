import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { classifyPlacement, countRepeats, desktopQuality, echoSummary, latencySummary,
  parseConnectTimes, parseIpinfo, percentile, qualityChecks,
  QUALITY_STEP_IDS, TYPING_TEXT, EDITOR_INPUT, fetchTimings, focusEditor,
  installNekoClipboardProbe, nekoClipboardDiagnostics } from './desktop-quality.mjs';

test('ipinfo keeps egress fields without inferring compute placement', () => {
  assert.deepEqual(parseIpinfo('{"ip":"203.0.113.8","org":"AS64500 Example","city":"Singapore","region":"Central","country":"SG"}'),
    { ip: '203.0.113.8', org: 'AS64500 Example', city: 'Singapore', region: 'Central', country: 'SG' });
  assert.equal(parseIpinfo('{"ip":"2001:db8::1"}').ip, '2001:db8::1');
  assert.equal(parseIpinfo('{"city":"  Mumbai  "}').city, 'Mumbai');
});

test('ipinfo rejects invalid JSON, IPs and non-string fields without inventing data', () => {
  const empty = { ip: null, org: null, city: null, region: null, country: null };
  for (const value of ['', '<html>error</html>', 'null', '[]', '{"error":"rate limited"}',
    '{"ip":"999.1.1.1","city":32,"org":{},"region":" ","country":false}']) {
    assert.deepEqual(parseIpinfo(value), empty);
  }
});

test('nearest-rank latency percentiles handle 10 samples, empty and invalid samples', () => {
  const values = [10, 2, 9, 1, 4, 6, 5, 3, 8, 7];
  assert.equal(percentile(values, 50), 5);
  assert.equal(percentile(values, 95), 10);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 100), 10);
  assert.deepEqual(values, [10, 2, 9, 1, 4, 6, 5, 3, 8, 7]);
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([NaN, -1, Infinity, null, '8', 0, 0.5], 95), 0.5);
  assert.deepEqual(latencySummary([1.5]), { samplesMs: [1.5], p50Ms: 1.5, p95Ms: 1.5, percentileMethod: 'nearest-rank' });
  for (const invalid of [-1, 101, NaN, '95']) assert.throws(() => percentile(values, invalid), RangeError);
});

test('repeat counting uses literal Unicode code points and preserves bounds', () => {
  assert.equal(countRepeats('', 'q'), 0);
  assert.equal(countRepeats('qqxqq', 'q'), 4);
  assert.equal(countRepeats('..a.', '.'), 3);
  assert.equal(countRepeats('🙂🙂é🙂', '🙂'), 3);
  assert.equal(countRepeats('éé e\u0301', 'é'), 2);
  for (const count of [1, 2, 59, 60]) assert.equal(countRepeats('q'.repeat(count), 'q'), count);
  for (const key of ['', 'qq', null]) assert.throws(() => countRepeats('q', key), TypeError);
});

test('typing fixture has exactly 200 characters and all requested scripts', () => {
  assert.equal(TYPING_TEXT.length, 200);
  assert.equal([...TYPING_TEXT].length, 200);
  for (const text of ['Az09', 'é', 'ß', 'ñ', '日本語', 'हिन्दी']) assert.ok(TYPING_TEXT.includes(text));
});

test('echo timing never reports an earlier key as the final character', () => {
  const inputs = [{ prefix: 'a', echoMs: 3 }, { prefix: 'ab', echoMs: 5 }];
  assert.equal(echoSummary(inputs, 'ab', 30).lastCharacterEchoMs, 5);
  assert.equal(echoSummary(inputs, 'abc', 30).lastCharacterEchoMs, null);
  assert.equal(echoSummary([], 'abc', null).lastCharacterEchoMs, null);
  assert.equal(echoSummary([{ prefix: 'abc', echoMs: null }], 'abc', null).p95Ms, null);
  assert.equal(echoSummary(inputs, 'ab', 30).timeUntilLastCharacterMs, 30);
});

test('unreachable guest IMDS does not turn successful placement into a failure', async () => {
  const quality = desktopQuality({ codeReady: true, codeFrame: async () => ({ url: () => 'https://code-box-aws.example.test' }),
    terminalRun: async () => ({ exitCode: 0, text: 'IPINFO_RC=0\nIPINFO={"ip":"203.0.113.9","city":"Singapore"}\n'
      + 'DMI=Amazon EC2|c7i.large\nIMDS_RC=28\nIMDS=\nHOSTNAME=guest\nNPROC=4\nMem: 7800 800 7000\n' }) });
  const evidence = {};
  assert.equal(await quality.placement(evidence), null);
  assert.equal(evidence.egressLocation.city, 'Singapore');
  assert.equal(evidence.hostPlacement.hostClass, 'aws');
  assert.equal(evidence.hostPlacement.region, null);
  assert.equal(evidence.hostPlacement.imds.exitCode, 28);
});

test('host placement uses hostname and DMI, keeping absent IMDS region unknown', () => {
  const aws = classifyPlacement('https://code-box-aws.example.test', 'Amazon EC2|c7i.large', '');
  assert.equal(aws.hostClass, 'aws'); assert.equal(aws.region, null);
  assert.equal(aws.dmiVendor, 'Amazon EC2'); assert.equal(aws.dmiProduct, 'c7i.large');
  const cloudflare = classifyPlacement('https://guac-box.example.test', 'QEMU|Standard PC', '');
  assert.equal(cloudflare.hostClass, 'cloudflare'); assert.equal(cloudflare.dmiClass, 'other');
  assert.equal(classifyPlacement('https://box-nekodesktop.example.test').hostClass, 'cloudflare');
  assert.equal(classifyPlacement('https://code.example.test/guac-?q=-aws.', 'Amazon EC2').hostClass, 'aws');
  assert.equal(classifyPlacement('https://code.example.test/guac-?q=-aws.').hostClass, 'unknown');
  assert.equal(classifyPlacement('about:blank', 'Amazon EC2', 'ap-south-1').region, 'ap-south-1');
  assert.equal(classifyPlacement('https://code.example.test', '', 'Unauthorized').region, null);
  assert.equal(classifyPlacement('https://guac-box.example.test', 'Amazon EC2').conflict, true);
});

test('curl connect seconds become milliseconds, retaining failed observations', () => {
  assert.deepEqual(parseConnectTimes('0.012345\r\nCONNECT_RC=0\r\n0.000000\nCONNECT_RC=7\nE2E_RC=0'),
    [{ connectMs: 12.345, exitCode: 0 }, { connectMs: 0, exitCode: 7 }]);
  assert.deepEqual(parseConnectTimes("$ curl -w '%{time_connect}'\nCONNECT_RC=0\n1.2 seconds\nCONNECT_RC=0"), []);
  assert.deepEqual(parseConnectTimes('0.100000\nCONNECT_RC=0\n'.repeat(5)).map(item => item.connectMs), [100, 100, 100, 100, 100]);
});

test('component failures preserve sibling PASS/SKIP evidence before failing the step', async () => {
  const evidence = {};
  await assert.rejects(qualityChecks(evidence, {
    first: async data => { data.samplesMs = [5]; throw new Error('sample failed'); },
    second: async data => { data.exactEquality = true; },
    third: async () => 'unavailable',
  }), /first/);
  assert.equal(evidence.first.status, 'FAIL'); assert.deepEqual(evidence.first.evidence.samplesMs, [5]);
  assert.equal(evidence.second.status, 'PASS'); assert.equal(evidence.second.evidence.exactEquality, true);
  assert.equal(evidence.third.status, 'SKIP'); assert.equal(evidence.third.reason, 'unavailable');
  assert.equal(await qualityChecks({}, { skipped: async () => 'missing' }), 'incomplete:skipped');
  assert.equal(await qualityChecks({}, { passed: async () => null }), null);
});

test('all quality steps exist and missing Code skips without accessing browser APIs', async () => {
  const quality = desktopQuality({ codeReady: false, browserReady: false });
  assert.deepEqual(Object.keys(quality), QUALITY_STEP_IDS);
  for (const name of ['placement', 'typing']) assert.equal(await quality[name]({}), 'code_unavailable');
});

test('browser health samples continue when Code is unavailable, using the page realm', async () => {
  const calls = [];
  const page = { url: () => 'https://os-staging.ezil.work/os',
    evaluate: async (_callback, args) => {
      calls.push(args);
      return Array.from({ length: 10 }, (_, index) => ({ ms: index + 1, ok: true, httpStatus: 200 }));
    } };
  const evidence = {};
  const quality = desktopQuality({ page, codeReady: false });
  assert.equal(await quality.latency(evidence), 'incomplete:codeOrigin,guestAiConnect');
  assert.deepEqual(calls, [{ url: '/api/health', method: 'GET' }]);
  assert.equal(evidence.osHealth.status, 'PASS');
  assert.equal(evidence.osHealth.evidence.p95Ms, 10);
  assert.equal(evidence.guestAiConnect.reason, 'code_unavailable');
});

test('Code asset latency requests GET in the Code frame and requires all ten successful samples', async () => {
  for (const successful of [true, false]) {
    const requests = [];
    const samples = Array.from({ length: 10 }, () => ({ ms: 1, ok: successful, httpStatus: successful ? 200 : 405 }));
    const frame = { url: () => 'https://code.example.test/', evaluate: async (_fn, args) => {
      if (!args) return 'https://code.example.test/workbench.css';
      requests.push(args); return samples;
    } };
    const quality = desktopQuality({ page: { url: () => 'https://os.example.test', evaluate: async () => samples },
      codeReady: true, codeFrame: async () => frame,
      terminalRun: async () => ({ text: '0.01\nCONNECT_RC=0\n'.repeat(5) }) });
    const evidence = {};
    if (successful) await quality.latency(evidence);
    else await assert.rejects(quality.latency(evidence), /codeOrigin/);
    assert.deepEqual(requests, [{ url: 'https://code.example.test/workbench.css', method: 'GET' }]);
    assert.equal(evidence.codeOrigin.evidence.method, 'GET');
    assert.equal(evidence.codeOrigin.status, successful ? 'PASS' : 'FAIL');
  }
});

test('GET timings reject HTTP errors, redirects, HTML types and disguised HTML bodies', async () => {
  const responses = [
    [200, 'text/css', '.editor { color: red; }'], [200, 'application/javascript', 'export default 1;'],
    [405, 'text/plain', 'Method Not Allowed'], [302, 'text/plain', 'redirect'],
    [200, 'text/html; charset=utf-8', 'fallback'], [200, 'application/xhtml+xml', 'fallback'],
    [200, 'text/css', '\n<!DOCTYPE html><html>fallback</html>'], [200, '', '<html>fallback</html>'],
    [200, '', '<body>fallback</body>'], null,
  ];
  let index = 0;
  const realm = { evaluate: (fn, args) => runInNewContext(`(${fn.toString()})(args)`, {
    args, performance, AbortSignal: { timeout: () => 'fixture-signal' },
    fetch: async (url, options) => {
      assert.equal(url, '/asset.css'); assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error'); assert.equal(options.cache, 'no-store');
      const entry = responses[index++];
      if (!entry) throw Object.assign(new Error('fixture request failed'), { name: 'TypeError' });
      const [status, type, body] = entry;
      return { status, ok: status >= 200 && status < 300, headers: { get: () => type }, text: async () => body };
    },
  }) };
  const result = await fetchTimings(realm, '/asset.css', 'GET');
  assert.equal(result.samplesMs.length, 2);
  assert.equal(result.observations.length, 10);
  assert.equal(result.observations[2].httpStatus, 405);
  assert.ok(result.observations.slice(4, 9).every(item => item.htmlFallback && !item.ok));
  assert.equal(result.observations[9].error, 'TypeError');
});

test('editor focus targets the input and preserves an already focused input', async () => {
  for (const [alreadyFocused, frameFocused] of [[false, true], [true, true], [true, false]]) {
    let focusCalls = 0;
    const frame = { locator(selector) {
      assert.equal(selector, EDITOR_INPUT);
      return { first() { return this; }, async waitFor() {}, async focus() { focusCalls++; } };
    }, evaluate: (fn, selector) => runInNewContext(`(${fn.toString()})(selector)`, {
      selector, document: { hasFocus: () => frameFocused, activeElement: { matches: actual => {
        assert.ok(!actual.includes(':visible')); return alreadyFocused;
      } } },
    }) };
    await focusEditor(frame);
    assert.equal(focusCalls, alreadyFocused && frameFocused ? 0 : 1);
  }
});

test('native repeat is explicitly skipped even if an independent mixed-text check fails', async () => {
  const frame = { locator: selector => ({
    first() { return this; }, async waitFor() {}, async focus() {},
    async evaluate(fn) {
      if (selector === EDITOR_INPUT) throw new Error('Unexpected input evaluation');
      if (fn.toString().includes('__desktopQualityEcho')) throw new Error('fixture echo observer unavailable');
      return '';
    },
  }), evaluate: async () => true };
  const quality = desktopQuality({ codeReady: true, codeFrame: async () => frame,
    clickDock: async () => {}, command: async () => {} });
  const evidence = {};
  await assert.rejects(quality.typing(evidence), /mixedText/);
  assert.equal(evidence.autoRepeat.status, 'SKIP');
  assert.equal(evidence.autoRepeat.reason, 'native_repeat_not_synthesized');
});

function probeFixture({ hostname = 'box-nekodesktop.example.test', topLevel = false,
  clipboard = { writeText: async () => undefined }, user, clientProfile } = {}) {
  class Socket {
    static OPEN = 1;
    listeners = [];
    addEventListener(type, fn) { assert.equal(type, 'message'); this.listeners.push(fn); }
    emit(data) { for (const listener of this.listeners) listener({ data }); }
  }
  const window = { WebSocket: Socket, $client: { $accessor: { user }, profile: clientProfile } };
  window.top = topLevel ? window : {};
  const globals = { window, location: { hostname }, navigator: { clipboard } };
  const install = () => runInNewContext(`(${installNekoClipboardProbe.toString()})()`, globals);
  install();
  return { window, globals, install, Socket, probe: window.__desktopQualityClipboard,
    snapshot: () => JSON.parse(JSON.stringify(window.__desktopQualityClipboard.snapshot())) };
}

test('Neko hooks install only in matching child frames and are idempotent', () => {
  for (const options of [{ topLevel: true }, { hostname: 'os.example.test' },
    { hostname: 'nekodesktop.example.test' }, { hostname: 'nekodesktop.evil.example.test' }]) {
    const { window, Socket } = probeFixture(options);
    assert.equal(window.__desktopQualityClipboard, undefined);
    assert.equal(window.WebSocket, Socket);
  }
  const fixture = probeFixture();
  const hook = fixture.window.WebSocket;
  fixture.install();
  assert.equal(fixture.window.WebSocket, hook);
  assert.equal(fixture.window.WebSocket.OPEN, 1);
  assert.ok(new fixture.window.WebSocket() instanceof fixture.Socket);
});

test('Neko records received clipboard events and token equality without retaining any payloads', () => {
  const { window, probe, snapshot } = probeFixture();
  assert.equal(snapshot().controlClipboardReceived, null, 'no observed socket is not negative evidence');
  const socket = new window.WebSocket('wss://fixture.invalid/?password=private-url-fixture');
  probe.reset('browser-to-local-fixture');
  assert.equal(snapshot().controlClipboardReceived, false);
  socket.emit(JSON.stringify({ event: 'control/clipboard', text: 'private-clipboard-fixture' }));
  socket.emit(JSON.stringify({ event: 'control/clipboard', text: 'browser-to-local-fixture' }));
  socket.emit(JSON.stringify({ event: 'member/connected', profile: 'private-member-fixture' }));
  socket.emit('malformed'); socket.emit(new Uint8Array([1])); socket.emit('null');
  const data = snapshot();
  assert.equal(data.controlClipboardReceived, true);
  assert.equal(data.controlClipboardEvents, 2); assert.equal(data.testTokenEvents, 1);
  assert.equal(data.parseFailures, 1); assert.equal(data.nonTextMessages, 1);
  assert.equal(data.messagesReceived, 6);
  assert.ok(!JSON.stringify(data).includes('fixture'));
  probe.reset('next-token');
  assert.equal(snapshot().controlClipboardEvents, 0);
  assert.equal(snapshot().socketsObserved, 1);
});

test('Neko writeText wrapper preserves receiver, fulfillment and rejection without leaking errors or text', async () => {
  const rejection = Object.assign(new Error('private-error-fixture'), { name: 'NotAllowedError' });
  const clipboard = { writeText(text) {
    assert.equal(this, clipboard);
    return text === 'test-token' ? Promise.reject(rejection) : Promise.resolve('success');
  } };
  const { probe, snapshot } = probeFixture({ clipboard });
  probe.reset('test-token');
  assert.equal(await clipboard.writeText('private-text-fixture'), 'success');
  await assert.rejects(clipboard.writeText('test-token'), error => error === rejection);
  const data = snapshot();
  assert.equal(data.writeCalls, 2); assert.equal(data.writeResolved, 1); assert.equal(data.writeRejected, 1);
  assert.equal(data.testTokenWriteCalls, 1); assert.equal(data.testTokenWriteRejected, 1);
  assert.equal(data.clipboardWriteRejected, true); assert.equal(data.lastRejectionName, 'NotAllowedError');
  assert.ok(!JSON.stringify(data).includes('fixture'));
});

test('Neko accounts for synchronous write errors and does not assign late rejections to a later phase', async () => {
  const secretName = Object.assign(new Error('private'), { name: 'private-name' });
  const throwing = { writeText() { throw secretName; } };
  const first = probeFixture({ clipboard: throwing });
  assert.throws(() => throwing.writeText('private'), error => error === secretName);
  assert.equal(first.snapshot().lastRejectionName, 'OtherError');
  let reject;
  const clipboard = { writeText: () => new Promise((_resolve, fail) => { reject = fail; }) };
  const second = probeFixture({ clipboard });
  second.probe.reset('first');
  const pending = clipboard.writeText('first');
  second.probe.reset('second');
  reject(secretName);
  await assert.rejects(pending);
  assert.equal(second.snapshot().writeRejected, 0);
});

test('Neko records only the current profile clipboard flag, including false and absent values', () => {
  const self = probeFixture({ user: { id: 'self', members: {
    self: { profile: { can_access_clipboard: false, name: 'private-name' } },
    other: { profile: { can_access_clipboard: true } },
  } } });
  assert.deepEqual(self.snapshot().profile, { can_access_clipboard: false, source: 'user.members[self].profile', reason: null });
  assert.equal(probeFixture({ user: { member: { can_access_clipboard: true } } }).snapshot().profile.can_access_clipboard, true);
  for (const user of [undefined, { members: { other: { can_access_clipboard: true } } }, { profile: { can_access_clipboard: 'true' } }]) {
    assert.deepEqual(probeFixture({ user }).snapshot().profile,
      { can_access_clipboard: null, source: null, reason: 'logged_in_profile_flag_not_exposed' });
  }
});

test('Neko retains only the logged-in system/init profile flag when the client store omits it', () => {
  const { window, snapshot, probe } = probeFixture();
  const socket = new window.WebSocket();
  socket.emit(JSON.stringify({ event: 'member/connected', profile: { can_access_clipboard: true } }));
  assert.equal(snapshot().profile.can_access_clipboard, null);
  socket.emit(JSON.stringify({ event: 'system/init', profile: { can_access_clipboard: false, name: 'private-profile' } }));
  probe.reset('test-token');
  assert.deepEqual(snapshot().profile, { can_access_clipboard: false, source: 'system/init.profile', reason: null });
  assert.ok(!JSON.stringify(snapshot()).includes('private-profile'));
});

test('unavailable clipboard hooks and lost frames produce explicit diagnostic gaps', async () => {
  const absent = probeFixture({ clipboard: {} }).snapshot();
  assert.equal(absent.hooks.clipboardWrite, 'unavailable');
  assert.equal(absent.clipboardWriteRejected, null);
  const frozen = probeFixture({ clipboard: Object.freeze({ writeText: async () => {} }) }).snapshot();
  assert.equal(frozen.hooks.clipboardWrite, 'installation_failed');
  const fixture = probeFixture();
  const frame = { evaluate: (fn, token) => runInNewContext(`(${fn.toString()})(token)`, { ...fixture.globals, token }) };
  assert.equal((await nekoClipboardDiagnostics(frame, 'test-token')).status, 'observed');
  assert.equal((await nekoClipboardDiagnostics({ evaluate: async () => { throw new Error('Frame gone'); } })).reason,
    'neko_frame_unavailable_for_diagnostics');
  const missing = { evaluate: (fn, token) => runInNewContext(`(${fn.toString()})(token)`, { window: {}, token }) };
  assert.equal((await nekoClipboardDiagnostics(missing)).reason, 'neko_probe_not_installed');
});

test('Browser clipboard still requires exact equality and saves Neko diagnostics on both PASS and FAIL', async () => {
  for (const allowWrite of [true, false]) {
    let localText = '', closed = false;
    const token = 'browser-to-local-fixture';
    const remoteClipboard = { async writeText(value) {
      if (!allowWrite) throw Object.assign(new Error('fixture denial'), { name: 'NotAllowedError' });
      localText = value;
    } };
    const fixture = probeFixture({ clipboard: remoteClipboard, user: { member: { can_access_clipboard: true } } });
    const socket = new fixture.window.WebSocket();
    const input = {
      first() { return this; }, async waitFor() {}, async click() {}, async evaluate() { return true; },
      async press(key) {
        if (key === 'Control+c') {
          socket.emit(JSON.stringify({ event: 'control/clipboard', text: token }));
          // The pinned Neko client logs rejected writes and leaves local state unchanged.
          await remoteClipboard.writeText(token).catch(() => {});
        }
      },
    };
    const frame = { url: () => 'https://box-nekodesktop.example.test/', locator: () => input,
      evaluate: (fn, arg) => runInNewContext(`(${fn.toString()})(arg)`, { ...fixture.globals, arg }) };
    const page = { frames: () => [frame], evaluate: (fn, arg) => runInNewContext(`(${fn.toString()})(arg)`, {
      arg, navigator: { clipboard: {
        writeText: async value => { localText = value; }, readText: async () => localText,
      } },
    }) };
    const quality = desktopQuality({ page, context: { grantPermissions: async () => {} },
      runId: 'fixture', codeReady: false, browserReady: true, openApp: async () => {},
      closeApp: async () => { closed = true; }, shot: async () => {},
      appWindow: () => ({ locator: () => ({ elementHandle: async () => ({
        contentFrame: async () => frame, dispose: async () => {},
      }) }) }),
    });
    const evidence = {};
    if (allowWrite) await quality.clipboard(evidence);
    else await assert.rejects(quality.clipboard(evidence), /browser/);
    const browser = evidence.browser.evidence;
    assert.equal(browser.localToRemote.status, 'SKIP');
    assert.equal(browser.localToRemote.reason, 'sidecar_has_no_omnibox_text_readback');
    assert.equal(browser.remoteToLocal.status, allowWrite ? 'PASS' : 'FAIL');
    assert.equal(browser.remoteToLocal.evidence.exactEquality, allowWrite);
    const observed = browser.remoteToLocal.evidence.diagnosticsAfter;
    assert.equal(observed.controlClipboardReceived, true);
    assert.equal(observed.testTokenEvents, 1);
    assert.equal(observed.clipboardWriteRejected, !allowWrite);
    assert.equal(observed.profile.can_access_clipboard, true);
    assert.equal(closed, true);
  }
});
