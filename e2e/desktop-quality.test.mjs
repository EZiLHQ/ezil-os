import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { classifyPlacement, countRepeats, desktopQuality, echoSummary, latencySummary,
  parseConnectTimes, parseIpinfo, percentile, qualityChecks,
  QUALITY_STEP_IDS, TYPING_TEXT, EDITOR, EDITOR_LINES, fetchTimings, focusEditor,
  installNekoClipboardProbe, nekoClipboardDiagnostics, nekoClipboardEvidence } from './desktop-quality.mjs';

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

function editorFixture({ mode = 'editContext', focused = false, frameFocused = true,
  clickFocuses = true, width = 480, height = 240 } = {}) {
  const clicks = [], keys = [], listeners = new Map();
  let value = '', localText = '', selected = false, mutation;
  const input = { editContext: mode === 'editContext' ? {} : null,
    matches: () => mode === 'textarea' || mode === 'contenteditable' };
  const document = { activeElement: focused ? input : {}, hasFocus: () => frameFocused,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: name => listeners.delete(name) };
  const element = { ownerDocument: document, contains: node => node === input };
  const lines = { querySelectorAll: () => [{ textContent: value }] };
  const globals = { document, window: {}, performance,
    MutationObserver: class {
      constructor(callback) { mutation = callback; }
      observe() {} disconnect() { mutation = null; }
    }, navigator: { clipboard: {
      writeText: async text => { localText = text; }, readText: async () => localText,
    } } };
  const evaluate = (fn, arg) => runInNewContext(`(${fn.toString()})(arg)`, { ...globals, arg });
  const content = { first() { return this; },
    evaluate: fn => fn({ clientWidth: width, clientHeight: height }),
    async click({ position }) {
      assert.ok(position.x > 0 && position.x < width);
      assert.ok(position.y > 0 && position.y < height);
      clicks.push(position);
      if (clickFocuses) { document.activeElement = input; frameFocused = true; }
    } };
  const editor = { first() { return this; }, async waitFor() {}, evaluate: fn => fn(element),
    locator(selector) {
      assert.equal(selector, '.monaco-scrollable-element.editor-scrollable');
      return content;
    } };
  const frame = { url: () => 'https://code.example.test', evaluate, locator(selector) {
    if (selector === EDITOR) return editor;
    assert.equal(selector, EDITOR_LINES, 'no textarea/contenteditable locator is available');
    return { first() { return this; }, evaluate: (fn, expected) => runInNewContext(
      `(${fn.toString()})(element, expected)`, { ...globals, element: lines, expected }) };
  } };
  const requireFocus = () => {
    assert.equal(document.activeElement, input, 'keyboard must reach the editor');
    assert.equal(frameFocused, true, 'Code frame must own keyboard focus');
  };
  const page = { frames: () => [frame], evaluate, keyboard: {
    async type(text) {
      requireFocus(); keys.push(['type', text]);
      for (const character of text) {
        listeners.get('keydown')?.({ key: character });
        // EditContext may omit DOM beforeinput timestamps; content must still round trip.
        if (mode !== 'editContext') listeners.get('beforeinput')?.({ data: character, inputType: 'insertText' });
        value += character; mutation?.();
      }
    },
    async press(key) {
      requireFocus(); keys.push(['press', key]);
      if (key === 'Control+V') { value += localText; mutation?.(); }
      else if (key === 'Control+A') selected = true;
      else if (key === 'Control+C') { assert.equal(selected, true); localText = value; }
      else assert.fail(`Unexpected key ${key}`);
    },
  } };
  const quality = desktopQuality({ page, context: { grantPermissions: async () => { frameFocused = false; } },
    runId: 'fixture', codeReady: true, browserReady: false, codeFrame: async () => frame,
    clickDock: async () => {}, closeApp: async () => {},
    command: async () => { value = ''; selected = false; } });
  return { frame, quality, clicks, keys };
}

test('editor focus supports native EditContext, legacy textarea and contenteditable without input locators', async () => {
  for (const mode of ['editContext', 'textarea', 'contenteditable']) {
    for (const [focused, frameFocused] of [[false, true], [true, true], [true, false]]) {
      const fixture = editorFixture({ mode, focused, frameFocused });
      await focusEditor(fixture.frame);
      assert.deepEqual(fixture.clicks, focused && frameFocused ? [] : [{ x: 8, y: 80 }]);
    }
  }
});

test('focus click stays inside a small editor viewport and fails if the editor does not acquire focus', async () => {
  const small = editorFixture({ width: 12, height: 40 });
  await focusEditor(small.frame);
  assert.deepEqual(small.clicks, [{ x: 6, y: 20 }]);
  await assert.rejects(focusEditor(editorFixture({ clickFocuses: false }).frame), /did not receive keyboard focus/);
});

test('typing round trips all 200 characters without a textarea and keeps native repeat skipped', async () => {
  for (const mode of ['editContext', 'textarea']) {
    const { quality } = editorFixture({ mode });
    const evidence = {};
    await quality.typing(evidence);
    assert.equal(evidence.mixedText.evidence.observed, TYPING_TEXT);
    assert.equal(evidence.mixedText.evidence.exactEquality, true);
    assert.equal(evidence.mixedText.status, mode === 'editContext' ? 'SKIP' : 'PASS');
    if (mode === 'editContext') assert.equal(evidence.mixedText.reason, 'editor_input_timestamps_unavailable');
    assert.equal(evidence.autoRepeat.status, 'SKIP');
    assert.equal(evidence.autoRepeat.reason, 'native_repeat_not_synthesized');
  }
});

test('both Code clipboard directions use focused keyboard input with native EditContext and legacy textarea', async () => {
  for (const mode of ['editContext', 'textarea']) {
    const { quality, keys } = editorFixture({ mode });
    const evidence = {};
    await quality.clipboard(evidence);
    for (const direction of ['codeLocalToRemote', 'codeRemoteToLocal']) {
      assert.equal(evidence[direction].status, 'PASS');
      assert.equal(evidence[direction].evidence.exactEquality, true);
    }
    assert.deepEqual(keys, [['press', 'Control+V'], ['type', 'code-to-local-fixture'],
      ['press', 'Control+A'], ['press', 'Control+C']]);
    assert.equal(evidence.permissions.length, 2);
  }
});

test('native repeat is explicitly skipped even if an independent mixed-text check fails', async () => {
  const frame = { locator: selector => ({
    first() { return this; }, async waitFor() {},
    async evaluate(fn) {
      if (selector === EDITOR) return true;
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
  clipboard = { writeText: async () => undefined }, user, clientProfile,
  document = { hasFocus: () => true }, dispatchStyle = 'both' } = {}) {
  class Socket {
    static OPEN = 1;
    listeners = [];
    addEventListener(type, fn) { assert.equal(type, 'message'); this.listeners.push(fn); }
    removeEventListener(type, fn) { assert.equal(type, 'message'); this.listeners = this.listeners.filter(item => item !== fn); }
    send() { assert.ok(this instanceof Socket); }
    // Native WebSocket stores the property handler internally via a prototype
    // setter; dispatch does not simply read an overridden own onmessage field.
    get onmessage() { return this.propertyHandler ?? null; }
    set onmessage(fn) { this.propertyHandler = fn; }
    emit(data) {
      const event = { data };
      if (dispatchStyle !== 'property') for (const listener of this.listeners) listener.call(this, event);
      if (dispatchStyle !== 'listener') return this.propertyHandler?.call(this, event);
    }
  }
  const window = { WebSocket: Socket, $client: { $accessor: { user }, profile: clientProfile } };
  window.top = topLevel ? window : {};
  const globals = { window, document, location: { hostname }, navigator: { clipboard } };
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
  assert.equal(snapshot().lifetime.messagesReceived, 6, 'token resets preserve evidence that the socket delivered messages');
});

for (const dispatchStyle of ['property', 'listener', 'both']) {
  test(`Neko observes ${dispatchStyle} delivery on existing sockets, reassignment and reconnect`, () => {
    const fixture = probeFixture({ dispatchStyle });
    fixture.probe.restore();
    const client = fixture.window.$client, socket = client._ws = new fixture.Socket();
    const delivered = [];
    function handler(event) {
      assert.ok(this instanceof fixture.Socket);
      delivered.push(JSON.parse(event.data).event);
      return 'delivered';
    }
    if (dispatchStyle === 'listener') socket.addEventListener('message', handler);
    else socket.onmessage = handler;
    // This startup event predates installation and cannot be recovered.
    socket.emit(JSON.stringify({ event: 'system/init' }));
    fixture.install();
    const probe = fixture.window.__desktopQualityClipboard;
    assert.equal(fixture.snapshot().messagesReceived, 0);
    probe.reset('test-token');
    socket.emit(JSON.stringify({ event: 'control/clipboard', text: 'test-token' }));
    assert.equal(fixture.snapshot().messagesReceived, 1, 'native dual delivery is counted once');
    assert.equal(fixture.snapshot().testTokenEvents, 1);
    if (dispatchStyle !== 'listener') {
      socket.onmessage = null;
      socket.onmessage = handler;
    }
    socket.emit(JSON.stringify({ event: 'control/locked' }));
    assert.equal(fixture.snapshot().messagesReceived, 2);
    probe.reset('next-token');
    assert.equal(fixture.snapshot().messagesReceived, 0);
    assert.equal(fixture.snapshot().lifetime.messagesReceived, 2);
    const reconnected = client._ws = new fixture.window.WebSocket();
    if (dispatchStyle === 'listener') reconnected.addEventListener('message', handler);
    else reconnected.onmessage = handler;
    reconnected.emit(JSON.stringify({ event: 'control/clipboard', text: 'next-token' }));
    reconnected.send(JSON.stringify({ event: 'control/request' }));
    assert.equal(fixture.snapshot().socketsObserved, 2);
    assert.equal(fixture.snapshot().testTokenEvents, 1);
    assert.equal(fixture.snapshot().controlRequests, 1);
    assert.equal(fixture.snapshot().lifetime.controlRequests, 1);
    assert.equal(fixture.snapshot().lifetime.messagesReceived, 3);
    assert.equal(delivered.length, 4, 'upstream handlers still receive each event once');
    assert.equal(probe.restore().restored, true);
    assert.equal(Object.hasOwn(socket, 'onmessage'), false);
    assert.equal(Object.hasOwn(reconnected, 'onmessage'), false);
    if (dispatchStyle !== 'listener') assert.equal(socket.onmessage, handler);
    socket.emit(JSON.stringify({ event: 'control/locked' }));
    assert.equal(delivered.length, 5);
  });
}

test('onmessage hooks preserve property-only adapters, return values, throws and later replacements', () => {
  const fixture = probeFixture();
  fixture.probe.restore();
  const socket = fixture.window.$client._ws = new fixture.Socket();
  const error = new Error('private-error');
  Object.defineProperty(socket, 'onmessage', { configurable: true, writable: true, enumerable: false,
    value(event) { assert.equal(this, socket); return event.data; } });
  fixture.install();
  const probe = fixture.window.__desktopQualityClipboard;
  const event = { data: JSON.stringify({ event: 'system/init' }) };
  assert.equal(socket.onmessage(event), event.data);
  assert.equal(fixture.snapshot().messagesReceived, 1);
  const throwing = () => { throw error; };
  socket.onmessage = throwing;
  assert.throws(() => socket.onmessage({ data: '{}' }), value => value === error);
  assert.equal(fixture.snapshot().messagesReceived, 2);
  assert.equal(probe.restore().restored, true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(socket, 'onmessage'),
    { configurable: true, writable: true, enumerable: false, value: throwing });
  fixture.install();
  const replacement = () => 'replacement';
  Object.defineProperty(socket, 'onmessage', { value: replacement, configurable: true });
  assert.equal(fixture.window.__desktopQualityClipboard.restore().restored, true);
  assert.equal(socket.onmessage, replacement);
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

test('Neko counts legacy and v3 events independently from actual handler execution', async () => {
  const fixture = probeFixture();
  const { window, probe, snapshot } = fixture;
  const socket = new window.WebSocket(), client = window.$client;
  for (const event of ['control/clipboard', 'clipboard/updated']) client[event] = function (payload) {
    assert.equal(this, client); assert.equal(payload.text, 'test-token'); return 'handled';
  };
  probe.reset('test-token');
  socket.emit(JSON.stringify({ event: 'control/clipboard', text: 'test-token' }));
  socket.emit(JSON.stringify({ event: 'clipboard/updated', text: 'test-token' }));
  assert.equal(snapshot().controlClipboardEvents, 1);
  assert.equal(snapshot().clipboardUpdatedEvents, 1);
  assert.equal(snapshot().testTokenEvents, 2);
  assert.equal(snapshot().handlerCalls, 0, 'raw receipt is not execution');
  assert.equal(client['control/clipboard']({ text: 'test-token' }), 'handled');
  assert.equal(client['clipboard/updated']({ text: 'test-token' }), 'handled');
  assert.equal(snapshot().handlerCalls, 2); assert.equal(snapshot().testTokenHandlerCalls, 2);
  socket.emit(JSON.stringify({ event: 'clipboard/updated', data: 'private-unknown-format' }));
  assert.equal(snapshot().clipboardUpdatedEvents, 2); assert.equal(snapshot().testTokenEvents, 2);
  assert.ok(!JSON.stringify(snapshot()).includes('private'));
});

test('handler errors retain names and preserve thrown/rejected values and phase isolation', async () => {
  const { window, probe, snapshot } = probeFixture();
  const error = Object.assign(new Error('private-handler-error'), { name: 'TypeError' });
  window.$client['control/clipboard'] = () => { throw error; };
  probe.reset('test-token');
  assert.throws(() => window.$client['control/clipboard']({ text: 'test-token' }), value => value === error);
  assert.equal(snapshot().handlerErrors, 1); assert.equal(snapshot().lastHandlerErrorName, 'TypeError');
  let reject;
  window.$client['control/clipboard'] = () => new Promise((_resolve, fail) => { reject = fail; });
  probe.reset('test-token');
  const pending = window.$client['control/clipboard']({ text: 'test-token' });
  probe.reset('next-token'); reject(error);
  await assert.rejects(pending, value => value === error);
  assert.equal(snapshot().handlerErrors, 0);
  assert.ok(!JSON.stringify(snapshot()).includes('private'));
});

test('write success is attributed to the matching token and does not mask a rejected token', async () => {
  const clipboard = { writeText: async text => {
    if (text === 'test-token') throw Object.assign(new Error('private'), { name: 'NotAllowedError' });
  } };
  const { probe, snapshot } = probeFixture({ clipboard });
  probe.reset('test-token');
  await assert.rejects(clipboard.writeText('test-token'));
  await clipboard.writeText('unrelated-value');
  assert.equal(snapshot().writeResolved, 1); assert.equal(snapshot().testTokenWriteResolved, 0);
  assert.equal(snapshot().testTokenRejectionName, 'NotAllowedError');
  probe.reset('unrelated-value');
  await clipboard.writeText('unrelated-value');
  assert.equal(snapshot().testTokenWriteResolved, 1);
});

test('Neko records effective policy, current focus and only exposed control booleans', () => {
  let focused = false;
  const fixture = probeFixture({ document: { hasFocus: () => focused,
    featurePolicy: { allowsFeature: feature => feature === 'clipboard-write' } } });
  Object.assign(fixture.window.$client, { connected: true, _channel: { readyState: 'open' },
    $accessor: { remote: { hosting: true, controlling: false, implicitHosting: true,
      locked: false, clipboard: 'private-text', id: 'private-id' } },
    $vue: { $store: { state: { remote: { hosting: 'private', implicitHosting: true, id: 'private-host' } } } } });
  const data = fixture.snapshot();
  assert.equal(data.focused, false);
  assert.deepEqual(data.policy, { available: true, clipboardRead: false, clipboardWrite: true, errorName: null });
  assert.deepEqual(data.control.client, { connected: true, hosting: null, controlling: null, channelOpen: true });
  assert.equal(data.control.accessorRemote.hosting, true); assert.equal(data.control.accessorRemote.controlling, false);
  assert.equal(data.control.storeRemotePresent, true); assert.equal(data.control.storeRemote.hosting, null);
  assert.ok(!JSON.stringify(data).includes('private'));
  focused = true;
  assert.equal(fixture.snapshot().focused, true);
  assert.deepEqual(probeFixture().snapshot().policy,
    { available: false, clipboardRead: null, clipboardWrite: null, errorName: null });
});

test('policy errors are names only and iframe smoke failures do not fabricate successful writes', async () => {
  const error = Object.assign(new Error('private-policy-error'), { name: 'SecurityError' });
  const clipboard = { writeText: async () => { throw error; }, readText: async () => { throw error; } };
  const fixture = probeFixture({ clipboard,
    document: { hasFocus: () => false, featurePolicy: { allowsFeature() { throw error; } } } });
  assert.equal(fixture.snapshot().policy.errorName, 'SecurityError');
  const smoke = JSON.parse(JSON.stringify(await fixture.probe.smoke('private-smoke-token')));
  assert.deepEqual(smoke, { writeResolved: false, readResolved: false, localEquals: null,
    writeErrorName: 'SecurityError', readErrorName: 'SecurityError' });
  assert.ok(!JSON.stringify(smoke).includes('private'));
});

test('existing sockets, reconnects and late client handlers are observed and fully restored', () => {
  const fixture = probeFixture();
  fixture.probe.restore();
  const client = fixture.window.$client, socket = client._ws = new fixture.Socket();
  const original = Object.getOwnPropertyDescriptor(fixture.globals.navigator.clipboard, 'writeText');
  const nativeHandler = () => 'handled';
  const prototype = { 'control/clipboard': nativeHandler };
  Object.setPrototypeOf(client, prototype);
  fixture.install();
  const probe = fixture.window.__desktopQualityClipboard;
  assert.equal(fixture.snapshot().socketsObserved, 1);
  assert.notEqual(client['control/clipboard'], nativeHandler);
  probe.reset('test-token');
  socket.emit(JSON.stringify({ event: 'control/clipboard', text: 'test-token' }));
  socket.send(JSON.stringify({ event: 'control/clipboard', text: 'test-token' }));
  client._ws = new fixture.window.WebSocket();
  fixture.snapshot(); fixture.snapshot();
  assert.equal(fixture.snapshot().socketsObserved, 2, 'no duplicate listener when snapshot reattaches');
  assert.equal(fixture.snapshot().testTokenSends, 1);
  assert.equal(probe.restore().restored, true);
  assert.equal(fixture.window.WebSocket, fixture.Socket);
  assert.deepEqual(Object.getOwnPropertyDescriptor(fixture.globals.navigator.clipboard, 'writeText'), original);
  assert.equal(client['control/clipboard'], nativeHandler);
  assert.equal(Object.hasOwn(client, 'control/clipboard'), false);
  assert.equal(socket.listeners.length, 0); assert.equal(client._ws.listeners.length, 0);
  assert.equal(Object.hasOwn(socket, 'send'), false);
  assert.equal(fixture.window.__desktopQualityClipboard, undefined);
});

test('failed WebSocket sends are not counted and cleanup preserves later third-party replacements', () => {
  const fixture = probeFixture();
  fixture.probe.restore();
  const socket = fixture.window.$client._ws = new fixture.Socket();
  const error = new Error('private-send-error');
  socket.send = () => { throw error; };
  fixture.install();
  const probe = fixture.window.__desktopQualityClipboard;
  probe.reset('test-token');
  assert.throws(() => socket.send(JSON.stringify({ event: 'control/clipboard', text: 'test-token' })), value => value === error);
  assert.equal(fixture.snapshot().testTokenSends, 0);
  const newerWrite = () => {};
  fixture.globals.navigator.clipboard.writeText = newerWrite;
  assert.equal(probe.restore().restored, true);
  assert.equal(fixture.globals.navigator.clipboard.writeText, newerWrite);
});

test('clipboard evidence identifies each missing stage without deriving success from equality alone', () => {
  const complete = { status: 'observed', socketsObserved: 1,
    hooks: { websocket: 'installed', clipboardHandler: 'installed', clipboardWrite: 'installed' },
    controlClipboardEvents: 1, clipboardUpdatedEvents: 0, testTokenEvents: 1, testTokenHandlerCalls: 1,
    testTokenWriteCalls: 1, testTokenWriteResolved: 1, testTokenWriteRejected: 0, testTokenRejectionName: null };
  const passed = nekoClipboardEvidence(complete, { localEquals: true });
  for (const stage of ['remoteCopied', 'eventReceived', 'handlerRan', 'writeResolved', 'localEquals']) assert.equal(passed[stage], true);
  assert.equal(passed.verdict, 'PASS'); assert.equal(passed.reason, null);
  const cases = [
    [{ status: 'unavailable' }, 'clipboard_event_observer_unavailable'],
    [{ socketsObserved: 0 }, 'clipboard_event_observer_unavailable'],
    [{ controlClipboardEvents: 0, testTokenEvents: 0 }, 'no_clipboard_event'],
    [{ testTokenEvents: 0 }, 'clipboard_event_token_unverified'],
    [{ hooks: { ...complete.hooks, clipboardHandler: 'unavailable' } }, 'clipboard_handler_observer_unavailable'],
    [{ testTokenHandlerCalls: 0 }, 'clipboard_handler_not_run'],
    [{ hooks: { ...complete.hooks, clipboardWrite: 'installation_failed' } }, 'clipboard_write_observer_unavailable'],
    [{ testTokenWriteResolved: 0, testTokenWriteRejected: 1, testTokenRejectionName: 'NotAllowedError' }, 'write_rejected:NotAllowedError'],
    [{ testTokenWriteResolved: 0, testTokenWriteCalls: 0 }, 'clipboard_write_not_called'],
    [{ testTokenWriteResolved: 0 }, 'clipboard_write_unresolved'],
  ];
  for (const [change, reason] of cases) {
    const result = nekoClipboardEvidence({ ...complete, ...change }, { localEquals: true });
    assert.equal(result.verdict, 'FAIL', reason); assert.equal(result.reason, reason);
  }
  assert.equal(nekoClipboardEvidence(complete, { localEquals: false }).reason, 'local_clipboard_mismatch');
  assert.equal(nekoClipboardEvidence(complete, { readErrorName: 'SecurityError' }).reason, 'local_read_rejected:SecurityError');
  assert.equal(nekoClipboardEvidence({ ...complete, testTokenEvents: 0 }).remoteCopied, null);
  assert.equal(nekoClipboardEvidence(complete, { localEquals: true }).remoteCopyVerification, 'matching_incoming_clipboard_event');
});

function browserClipboardFixture({ receiveEvent = true, runHandler = true, allowWrite = true,
  callWrite = true, localMatches = true, readAllowed = true, sendUpstream = true,
  eventName = 'control/clipboard', failCopy = false, failGrant = false, delayedSend = false } = {}) {
  let localText = '', remoteText = '', focused = false, opened = false, closed = false, copied = false;
  const actions = [], grants = new Set(), token = 'browser-to-local-fixture';
  const origin = 'https://box-nekodesktop.example.test';
  const remoteClipboard = {
    async writeText(value) {
      assert.equal(focused, true, 'frame write happens after focus');
      assert.ok(grants.has(origin));
      if (!allowWrite) throw Object.assign(new Error('private-write-error'), { name: 'NotAllowedError' });
      localText = localMatches || value !== token ? value : 'private-mismatch';
    },
    async readText() { assert.equal(focused, true); return localText; },
  };
  const nativeWrite = remoteClipboard.writeText;
  const fixture = probeFixture({ clipboard: remoteClipboard, user: { member: { can_access_clipboard: true } },
    document: { hasFocus: () => focused, featurePolicy: { allowsFeature: () => true } } });
  const client = fixture.window.$client;
  Object.assign(client, { connected: true, _channel: { readyState: 'open' } });
  client.$accessor.remote = { hosting: true, controlling: true, locked: false, implicitHosting: true };
  client[eventName] = async function ({ text }) {
    assert.equal(this, client);
    if (callWrite) await remoteClipboard.writeText(text).catch(() => {});
  };
  const nativeHandler = client[eventName];
  const socket = client._ws = new fixture.window.WebSocket();
  socket.onmessage = async ({ data }) => {
    const message = JSON.parse(data);
    if (runHandler) await client[message.event]?.({ text: message.text });
  };
  const input = {
    first() { return this; }, async waitFor() {},
    async click() { assert.ok(grants.has(origin), 'permissions precede the first overlay entry'); focused = true; actions.push('click'); },
    async focus() { focused = true; actions.push('focus'); },
    async dispatchEvent(event) {
      assert.equal(event, 'mouseenter'); assert.equal(focused, true);
      assert.equal(localText, 'local-to-browser-fixture', 'entry sync reads the freshly written clipboard');
      actions.push('mouseenter');
      if (sendUpstream) {
        const send = () => {
          socket.send(JSON.stringify({ event: 'control/clipboard', text: localText }));
          remoteText = localText; actions.push('send');
        };
        if (delayedSend) setTimeout(send, 10);
        else send();
      }
    },
    async evaluate(fn) { return runInNewContext(`(${fn.toString()})()`, fixture.globals); },
    async press(key) {
      actions.push(key);
      if (key === 'Control+v') assert.equal(remoteText, 'local-to-browser-fixture', 'send must complete before paste');
      if (key === 'Control+c') {
        if (failCopy) throw new Error('private-copy-error');
        remoteText = token; copied = true;
        if (receiveEvent) await socket.emit(JSON.stringify({ event: eventName, text: token }));
      }
    },
  };
  const frame = { url: () => `${origin}/`, locator: () => input,
    evaluate: async (fn, arg) => runInNewContext(`(${fn.toString()})(arg)`, { ...fixture.globals, arg }) };
  const page = { frames: () => opened ? [frame] : [], evaluate: (fn, arg) => runInNewContext(`(${fn.toString()})(arg)`, {
    arg, navigator: { clipboard: {
      writeText: async value => { localText = value; actions.push('write-local'); },
      readText: async () => {
        if (!readAllowed && copied) throw Object.assign(new Error('private-read-error'), { name: 'SecurityError' });
        return localText;
      },
    } },
  }) };
  const quality = desktopQuality({ page, context: { grantPermissions: async (_permissions, { origin }) => {
    if (failGrant) throw new Error('permission unavailable');
    grants.add(origin); actions.push('grant');
  } }, runId: 'fixture', codeReady: false, browserReady: true, clipboardTimeoutMs: delayedSend ? 100 : 0,
  openApp: async () => { opened = true; }, closeApp: async () => { closed = true; }, shot: async () => {},
  appWindow: () => ({ locator: () => ({ elementHandle: async () => ({
    contentFrame: async () => frame, dispose: async () => {},
  }) }) }) });
  return { quality, actions, fixture, socket, verifyCleanup() {
    assert.equal(closed, true); assert.equal(fixture.window.__desktopQualityClipboard, undefined);
    assert.equal(fixture.window.WebSocket, fixture.Socket); assert.equal(remoteClipboard.writeText, nativeWrite);
    assert.equal(client[eventName], nativeHandler); assert.equal(socket.listeners.length, 0);
  } };
}

test('Browser grants before overlay entry and waits for the new upstream send before pasting', async () => {
  const fixture = browserClipboardFixture({ delayedSend: true });
  const evidence = {};
  await fixture.quality.clipboard(evidence);
  const browser = evidence.browser.evidence;
  assert.equal(browser.localToRemote.status, 'SKIP');
  assert.equal(browser.localToRemote.reason, 'sidecar_has_no_omnibox_text_readback');
  assert.equal(browser.localToRemote.evidence.upstreamSent, true);
  const actions = fixture.actions;
  for (const [first, second] of [['grant', 'click'], ['write-local', 'focus'], ['focus', 'mouseenter'],
    ['mouseenter', 'send'], ['send', 'Control+v']]) assert.ok(actions.indexOf(first) < actions.indexOf(second));
  assert.equal(browser.smoke.writeResolved, true); assert.equal(browser.smoke.readResolved, true);
  assert.equal(browser.smoke.localEquals, true);
  const result = browser.remoteToLocal.evidence;
  for (const stage of ['remoteCopied', 'eventReceived', 'handlerRan', 'writeResolved', 'localEquals']) assert.equal(result[stage], true);
  assert.equal(result.verdict, 'PASS'); assert.equal(browser.remoteToLocal.status, 'PASS');
  assert.equal(result.diagnosticsBefore.writeCalls, 0, 'smoke and upstream writes are excluded from copy-stage counts');
  assert.equal(result.diagnosticsAfter.testTokenWriteResolved, 1);
  assert.equal(result.diagnosticsAfter.profile.can_access_clipboard, true);
  assert.equal(browser.instrumentationCleanup.restored, true);
  assert.ok(!/private|browser-to-local-fixture|local-to-browser-fixture/.test(JSON.stringify(evidence)));
  fixture.verifyCleanup();
});

test('late clipboard notifications during cleanup do not overwrite the failed verdict snapshot', async () => {
  const fixture = browserClipboardFixture({ receiveEvent: false }), evidence = {};
  const snapshot = fixture.fixture.probe.snapshot;
  let copySnapshots = 0;
  fixture.fixture.probe.snapshot = function () {
    // Wait until the first post-copy poll has decided failure, then simulate
    // a notification just before the next (cleanup) snapshot.
    if (fixture.actions.includes('Control+c')) {
      if (++copySnapshots === 2) fixture.socket.emit(JSON.stringify({ event: 'control/clipboard', text: 'browser-to-local-fixture' }));
    }
    return snapshot();
  };
  await assert.rejects(fixture.quality.clipboard(evidence), /browser/);
  const remote = evidence.browser.evidence.remoteToLocal;
  assert.equal(remote.reason, 'no_clipboard_event'); assert.equal(remote.evidence.eventReceived, false);
  assert.equal(remote.evidence.diagnosticsAfter.controlClipboardEvents, 0);
  assert.equal(evidence.browser.evidence.diagnostics.controlClipboardEvents, 1);
  fixture.verifyCleanup();
});

test('Browser no-event evidence keeps remote copy unverified and local equality false', async () => {
  const fixture = browserClipboardFixture({ receiveEvent: false });
  const evidence = {};
  await assert.rejects(fixture.quality.clipboard(evidence), /browser/);
  const remote = evidence.browser.evidence.remoteToLocal;
  assert.equal(remote.reason, 'no_clipboard_event');
  assert.deepEqual(Object.fromEntries(['remoteCopied', 'eventReceived', 'handlerRan', 'writeResolved', 'localEquals']
    .map(key => [key, remote.evidence[key]])),
  { remoteCopied: null, eventReceived: false, handlerRan: false, writeResolved: false, localEquals: false });
  assert.equal(remote.evidence.copyDispatched, true);
  assert.equal(remote.evidence.remoteCopyVerification, 'remote_copy_unverified');
  fixture.verifyCleanup();
});

test('Browser failures distinguish missing handlers, writes, rejected writes, mismatches and read errors', async () => {
  for (const [options, reason] of [
    [{ runHandler: false }, 'clipboard_handler_not_run'],
    [{ callWrite: false }, 'clipboard_write_not_called'],
    [{ allowWrite: false }, 'write_rejected:NotAllowedError'],
    [{ localMatches: false }, 'local_clipboard_mismatch'],
    [{ readAllowed: false }, 'local_read_rejected:SecurityError'],
  ]) {
    const fixture = browserClipboardFixture(options), evidence = {};
    await assert.rejects(fixture.quality.clipboard(evidence), /browser/);
    const remote = evidence.browser.evidence.remoteToLocal;
    assert.equal(remote.status, 'FAIL'); assert.equal(remote.reason, reason);
    assert.equal(remote.evidence.verdict, 'FAIL'); assert.equal(remote.evidence.reason, reason);
    assert.equal(remote.evidence.remoteCopied, true); assert.equal(remote.evidence.eventReceived, true);
    assert.ok(!JSON.stringify(evidence).includes('private'));
    fixture.verifyCleanup();
  }
});

test('v3 clipboard/updated receipts and handlers appear in Browser evidence', async () => {
  const fixture = browserClipboardFixture({ eventName: 'clipboard/updated' }), evidence = {};
  await fixture.quality.clipboard(evidence);
  const remote = evidence.browser.evidence.remoteToLocal;
  assert.equal(remote.status, 'PASS'); assert.equal(remote.evidence.eventReceived, true);
  assert.equal(remote.evidence.diagnosticsAfter.controlClipboardEvents, 0);
  assert.equal(remote.evidence.diagnosticsAfter.clipboardUpdatedEvents, 1);
  fixture.verifyCleanup();
});

test('missing upstream send prevents paste while preserving the independent remote-copy check', async () => {
  const fixture = browserClipboardFixture({ sendUpstream: false }), evidence = {};
  await assert.rejects(fixture.quality.clipboard(evidence), /browser/);
  const browser = evidence.browser.evidence;
  assert.equal(browser.localToRemote.status, 'FAIL'); assert.equal(browser.localToRemote.reason, 'no_upstream_clipboard_send');
  assert.equal(browser.localToRemote.evidence.upstreamSent, false);
  assert.ok(!fixture.actions.includes('Control+v'));
  assert.equal(browser.remoteToLocal.status, 'PASS');
  fixture.verifyCleanup();
});

test('copy-input and pre-entry permission errors still restore all installed instrumentation', async () => {
  for (const options of [{ failCopy: true }, { failGrant: true }]) {
    const fixture = browserClipboardFixture(options), evidence = {};
    await assert.rejects(fixture.quality.clipboard(evidence), /browser/);
    if (options.failCopy) {
      const result = evidence.browser.evidence.remoteToLocal.evidence;
      assert.equal(result.copyDispatched, false); assert.equal(result.reason, 'clipboard_copy_observation_failed');
      assert.equal(result.verdict, 'FAIL'); assert.ok(!JSON.stringify(evidence).includes('private'));
    } else assert.ok(!fixture.actions.includes('click'));
    fixture.verifyCleanup();
  }
});
