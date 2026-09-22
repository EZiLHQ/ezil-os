'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { middleware, nativeButtonScript, assertNativeSession, DOWNLOAD } = require('./product-flow-helpers.cjs');
test('native input preflight rejects a locked or unavailable console session', () => {
  const console = '<key>kCGSSessionOnConsoleKey</key>\n<true/>';
  assert.doesNotThrow(() => assertNativeSession(console));
  assert.doesNotThrow(() => assertNativeSession(console + '<key>CGSSessionScreenIsLocked</key><false/>'));
  assert.throws(() => assertNativeSession(console + '<key>CGSSessionScreenIsLocked</key>\n<true/>'), /macos_screen_locked/);
  assert.throws(() => assertNativeSession(''), /macos_console_unavailable/);
});
function response() { return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } }; }
test('acceptance routes serve real upload controls and a downloadable attachment', () => {
  const route = middleware('/fixture'), page = response(), download = response();
  route({ url: '/__ezil_input' }, page, () => assert.fail('missing page'));
  assert.match(page.body, /type="file"/); assert.match(page.body, /files\[0\]\.text\(\)/);
  route({ url: '/__ezil_download' }, download, () => assert.fail('missing download'));
  assert.equal(download.headers['Content-Disposition'], 'attachment; filename="ezil-browser-download.txt"'); assert.equal(download.body, DOWNLOAD);
  let passed = false; route({ url: '/src/main.ts' }, response(), () => { passed = true; }); assert.equal(passed, true);
});
test('slow route records request start before delayed response; no network or real waiting', () => {
  const writes = []; let finish, timeout;
  const route = middleware('/fixture', { write: (file, value) => writes.push([file, value]), delay: (fn, ms) => { finish = fn; timeout = ms; } });
  const res = response(); route({ url: '/__ezil_slow' }, res, () => assert.fail('missing slow route'));
  assert.deepEqual(writes, [['/fixture/.e2e-slow-start', 'started']]); assert.equal(res.body, undefined); assert.equal(timeout, 12000);
  finish(); assert.equal(writes.at(-1)[0], '/fixture/.e2e-slow-end'); assert.match(res.body, /Slow complete/);
});
test('native confirmation targets exact process/button and reports polling exhaustion as failure', () => {
  const script = nativeButtonScript(123, 'Stop workspace');
  assert.match(script, /unix id is 123/); assert.match(script, /entire contents of win/); assert.match(script, /return "clicked"/);
  assert.match(script, /error "native_dialog_not_found" number 1001/); assert.match(script, /\+ 45/);
  assert.doesNotMatch(script, /sheet 1|window 1|exit repeat/);
  assert.match(nativeButtonScript(123, 'Save', 30), /name of candidateControl is "Save"/);
  assert.match(nativeButtonScript(123, 'Cancel', 30), /name of candidateControl is "Cancel"/);
  for (const args of [[0, 'Save'], [123, 'Quit'], [123, 'Save', 0], ['123', 'Save']]) assert.throws(() => nativeButtonScript(...args));
});
test('native confirmation scripts compile with the macOS AppleScript parser', { skip: process.platform !== 'darwin' }, t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-applescript-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const label of ['Save', 'Stop workspace', 'Cancel']) require('node:child_process').execFileSync('/usr/bin/osacompile', ['-o', path.join(directory, `${label}.scpt`), '-'], {
    input: nativeButtonScript(123, label), stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
  });
});
