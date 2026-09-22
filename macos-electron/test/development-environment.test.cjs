'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const realSpawnSync = cp.spawnSync;
const { developmentEnvironment, createLoginPathLookup, configureTerminalEnvironment } = require('../src/development-environment.cjs');
const { cleanEnvironment } = require('../src/vscode.cjs');
// Never execute the real user's startup files in a unit test.
test.before(() => test.mock.method(cp, 'spawnSync', () => ({ status: 1 })));
test('developer environment keeps host home, host tools before bundled fallbacks, and no inherited secrets', t => {
  const previous = process.env.PATH; process.env.PATH = '/host/nvm/bin:relative::/usr/bin';
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  const env = developmentEnvironment('/fixture/resources');
  assert.equal(env.HOME, os.homedir());
  assert.ok(env.PATH.startsWith('/host/nvm/bin:')); assert.ok(!env.PATH.split(':').includes('relative')); assert.ok(!env.PATH.split(':').includes(''));
  assert.ok(env.PATH.indexOf('/opt/homebrew/bin') < env.PATH.indexOf('/fixture/resources/bun'));
  assert.ok(env.PATH.endsWith('/fixture/resources/bun:/fixture/resources/code-server/lib'));
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER']);
  assert.equal(cleanEnvironment().SHELL, undefined); assert.ok(!cleanEnvironment().PATH.includes('/fixture/resources'));
  assert.throws(() => developmentEnvironment('relative'));
});
test('Finder login PATH is sanitized, bounded, exclusively captured, and cached', () => {
  let calls = 0;
  const lookup = createLoginPathLookup({ platform: 'darwin', run: (_shell, args, options) => {
    calls++; assert.deepEqual(args.slice(0, 3), ['-i', '-l', '-c']);
    assert.match(args[3], /PATH.*>&3/);
    assert.deepEqual(options.stdio.slice(0, 3), ['ignore', 'ignore', 'ignore']);
    assert.equal(options.timeout, 1800); assert.equal(options.killSignal, 'SIGKILL');
    assert.equal(options.env.HOME, os.homedir());
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'USER']);
    fs.writeSync(options.stdio[3], '/fixture/version-manager/bin:/usr/bin');
    return { status: 0, stdout: 'discarded startup output', stderr: 'discarded startup output' };
  } });
  assert.equal(lookup(), '/fixture/version-manager/bin:/usr/bin'); assert.equal(lookup(), '/fixture/version-manager/bin:/usr/bin'); assert.equal(calls, 1);
});
test('failed and timed-out shell lookups cache a safe empty fallback', () => {
  for (const result of [{ status: 1 }, { status: null, error: { code: 'ETIMEDOUT' } }]) {
    let calls = 0; const lookup = createLoginPathLookup({ platform: 'darwin', run: () => { calls++; return result; } });
    assert.equal(lookup(), ''); assert.equal(lookup(), ''); assert.equal(calls, 1);
  }
});
test('interactive login discovers zshrc tool paths using only a synthetic HOME', t => {
  if (process.platform !== 'darwin') return t.skip('macOS zsh fixture');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-zsh-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.zshrc'), 'export PATH="/fixture/nvm/node/bin:$PATH"\nprintf "discarded startup text"\n');
  const user = os.userInfo();
  t.mock.method(os, 'homedir', () => home); t.mock.method(os, 'userInfo', () => ({ ...user, homedir: home, shell: '/bin/zsh' }));
  const lookup = createLoginPathLookup({ platform: 'darwin', run: realSpawnSync });
  assert.ok(lookup().startsWith('/fixture/nvm/node/bin:'));
  assert.ok(!lookup().includes('discarded startup text'));
});
function profile(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-profile-env-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const editorData = path.join(dir, 'editor-data'); fs.mkdirSync(path.join(editorData, 'User'), { recursive: true });
  return { dir, editorData };
}
test('terminal removals preserve JSONC comments and unrelated settings in both owned profiles', t => {
  const w = profile(t), file = path.join(w.editorData, 'User/settings.json');
  fs.writeFileSync(file, '{\n// keep comment\n"editor.fontSize": 16,\n"terminal.integrated.env.osx": {"KEEP_ME":"yes", "OPENAI_API_KEY":"fixture-only",},\n"files.exclude": {"**/cache":true},\n}\n');
  configureTerminalEnvironment(w);
  const text = fs.readFileSync(file, 'utf8'); assert.ok(text.includes('// keep comment')); assert.ok(text.includes('"editor.fontSize": 16')); assert.ok(text.includes('"files.exclude": {"**/cache":true}'));
  assert.match(text, /"KEEP_ME": "yes"/); assert.match(text, /"EZIL_BROKER_FILE": null/); assert.match(text, /"EZIL_AI_BROKER_FILE": null/); assert.match(text, /"OPENAI_API_KEY": null/);
  configureTerminalEnvironment(w); assert.equal(fs.readFileSync(file, 'utf8'), text);
  configureTerminalEnvironment(w, { external: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.editorData, 'external-vscode/User/settings.json')))['terminal.integrated.env.osx'].EZIL_BROKER_FILE, null);
});
test('new removal key supports trailing commas and refuses unsafe or malformed profile files', t => {
  const w = profile(t), file = path.join(w.editorData, 'User/settings.json');
  fs.writeFileSync(file, '{"editor.fontSize": 16, // retain\n}'); configureTerminalEnvironment(w); assert.match(fs.readFileSync(file, 'utf8'), /\/\/ retain/);
  for (const invalid of ['broken', '{"terminal.integrated.env.osx": 1}', '{"terminal.integrated.env.osx":{},"terminal.integrated.env.osx":{}}']) {
    fs.writeFileSync(file, invalid); assert.throws(() => configureTerminalEnvironment(w)); assert.equal(fs.readFileSync(file, 'utf8'), invalid);
  }
  fs.unlinkSync(file); const target = path.join(w.dir, 'canary'); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, file);
  assert.throws(() => configureTerminalEnvironment(w)); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  fs.unlinkSync(file); fs.linkSync(target, file); assert.throws(() => configureTerminalEnvironment(w)); assert.equal(fs.readFileSync(target, 'utf8'), '{}');
  assert.throws(() => configureTerminalEnvironment({ ...w, editorData: os.homedir() }));
});
