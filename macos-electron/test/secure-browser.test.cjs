'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { SecureBrowser, secureDestination } = require('../src/secure-browser.cjs');

function fixture(t, overrides = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secure-browser-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, 'Applications/Google Chrome.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), 'fixture');
  fs.writeFileSync(path.join(app, 'Contents/MacOS/Google Chrome'), 'fixture', { mode: 0o755 });
  const w = { id: 'one', dir: path.join(root, 'one'), browser: path.join(root, 'one/browser') };
  fs.mkdirSync(w.dir, { mode: 0o700 });
  const f = { root, app, w, rows: [{ pid: 1, start: 'system', chrome: false }], launches: [], version: '153.0.0.0', binary: 'Google Chrome', bundle: 'com.google.Chrome' };
  const run = (file, args, options) => {
    assert.equal(options.shell, false); assert.ok(options.timeout <= 10000);
    assert.equal(options.env.AZURE_API_KEY, undefined);
    if (!args.at(-1).startsWith(app)) throw Error('Only fixture may be verified');
    if (file === '/usr/bin/codesign') {
      assert.ok(args.includes('--strict')); assert.ok(args.includes('--deep'));
      assert.ok(args.includes('=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"'));
      if (f.badSignature) throw Error('signature rejected');
      f.verified = true; return '';
    }
    assert.ok(f.verified);
    return { 'Print :CFBundleIdentifier': f.bundle, 'Print :CFBundleShortVersionString': f.version, 'Print :CFBundleExecutable': f.binary }[args[1]];
  };
  const launch = (file, args, options) => {
    f.launches.push({ file, args, options });
    const profile = args[1].slice('--user-data-dir='.length);
    const existing = f.rows.some(r => r.chrome && r.profile === profile);
    const child = new EventEmitter(); child.pid = 122 + f.launches.length; child.unref = () => { f.unref = true; };
    f.child = child;
    queueMicrotask(() => {
      if (!existing) f.rows.push({ pid: child.pid, start: 'birth', chrome: true, profile, executable: file });
      child.emit('spawn');
      if (existing) child.emit('exit', 0);
    });
    return child;
  };
  f.options = { platform: 'darwin', home: root, run, launch, snapshot: () => f.rows, ...overrides };
  f.browser = new SecureBrowser(f.options);
  return f;
}

test('destination keeps only credential-free HTTPS origins', () => {
  assert.equal(secureDestination(), 'https://www.google.com/');
  assert.equal(secureDestination('https://accounts.google.com/signin?token=secret#fragment'), 'https://www.google.com/');
  assert.equal(secureDestination('https://example.com:8443/login?token=secret#x'), 'https://example.com:8443/');
  const prefix = 'https://example.com/';
  assert.equal(secureDestination(prefix + 'a'.repeat(4096 - prefix.length)), prefix);
  assert.throws(() => secureDestination(prefix + 'a'.repeat(4097 - prefix.length)));
  for (const value of ['', null, 123, 'http://example.com', 'file:///tmp/x', 'https://u:p@example.com', 'https://@example.com', 'https://example.com\\@evil.test', ' https://example.com', 'https://example.com\n']) assert.throws(() => secureDestination(value));
});
test('signature, signed manifest, executable and minimum version are enforced', async t => {
  const f = fixture(t);
  assert.deepEqual(await f.browser.status(), { available: true, version: '153.0.0.0' });
  f.version = '152.9.0.0'; assert.equal((await f.browser.status()).reason, 'outdated');
  for (const version of ['153', 'invalid', '153.0.0.0 extra']) { f.version = version; assert.equal((await f.browser.status()).reason, 'untrusted'); }
  f.version = '154.0.1.2'; f.badSignature = true;
  assert.equal((await f.browser.status()).reason, 'untrusted');
  assert.deepEqual(await f.browser.open(f.w), { opened: false, reason: 'untrusted' });
  f.badSignature = false;
  for (const binary of ['../Google Chrome', '/bin/sh', 'Other']) { f.binary = binary; assert.equal((await f.browser.status()).reason, 'untrusted'); }
  f.binary = 'Google Chrome'; f.bundle = 'com.fake.Chrome'; assert.equal((await f.browser.status()).reason, 'untrusted');
  assert.equal(f.launches.length, 0);
  assert.equal((await new SecureBrowser({ platform: 'linux' }).status()).reason, 'unavailable');
  fs.rmSync(f.app, { recursive: true });
  // Missing is deterministic even on Macs with a real system installation.
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => file === '/Applications/Google Chrome.app' ? undefined : original(file, ...args));
  assert.equal((await f.browser.status()).reason, 'missing');
});
test('normal detached launch isolates profile and persists ownership across host restart', async t => {
  const f = fixture(t);
  await f.browser.assertRemovable(f.w);
  assert.deepEqual(await f.browser.open(f.w, 'https://example.com/login?password=secret'), { opened: true });
  assert.deepEqual(f.launches[0].args, ['--new-window', `--user-data-dir=${f.w.browser}/secure-chrome`, 'https://example.com/']);
  const options = f.launches[0].options;
  assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore'); assert.equal(options.shell, false);
  assert.equal(options.env.EZIL_NATIVE_ADMIN_CAPABILITY, undefined); assert.equal(options.env.AZURE_API_KEY, undefined);
  assert.ok(f.unref);
  assert.equal(fs.statSync(path.join(f.w.browser, 'secure-chrome')).mode & 0o777, 0o700);
  const restarted = new SecureBrowser(f.options);
  await assert.rejects(restarted.assertRemovable(f.w), { code: 'secure_browser_busy' });
  const marker = fs.readFileSync(path.join(f.w.browser, 'secure-chrome/.ezil-owner.json'), 'utf8');
  assert.deepEqual(await restarted.open(f.w), { opened: true });
  assert.equal(fs.readFileSync(path.join(f.w.browser, 'secure-chrome/.ezil-owner.json'), 'utf8'), marker);
  f.rows = [{ pid: 1, start: 'system', chrome: false }, { pid: 123, start: 'reused', chrome: false }];
  await restarted.assertRemovable(f.w);
  assert.deepEqual(await restarted.open(f.w), { opened: true });
});
test('locks, incomplete inventories and corrupt or pending metadata fail closed', async t => {
  const f = fixture(t); await f.browser.open(f.w);
  f.rows = [{ pid: 1, start: 'system', chrome: false }];
  const profile = path.join(f.w.browser, 'secure-chrome');
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    fs.symlinkSync('foreign-host-123', path.join(profile, name));
    await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
    fs.unlinkSync(path.join(profile, name));
  }
  fs.symlinkSync(`${os.hostname()}-99`, path.join(profile, 'SingletonLock'));
  f.rows.push({ pid: 99, start: 'other', chrome: true });
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_busy' });
  fs.unlinkSync(path.join(profile, 'SingletonLock'));
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  f.rows = []; await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  f.rows = [{ pid: 1, start: 'system', chrome: false }];
  fs.writeFileSync(path.join(profile, '.ezil-owner.json'), '{}');
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
});
test('failed launches are bounded, retain profile data, and allow removal after definite spawn failure', async t => {
  const f = fixture(t, { launch: () => { throw Error('ENOENT'); } });
  assert.deepEqual(await f.browser.open(f.w), { opened: false, reason: 'unavailable' });
  await f.browser.assertRemovable(f.w);
  const profile = path.join(f.w.browser, 'secure-chrome');
  fs.writeFileSync(path.join(profile, 'keep'), 'persistent');
  const child = new EventEmitter(); child.unref = () => {}; child.pid = 44;
  const hanging = new SecureBrowser({ ...f.options, timeout: 10, launch: () => child });
  const pending = hanging.open(f.w);
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_busy' });
  assert.deepEqual(await f.browser.open(f.w), { opened: false, reason: 'profile_busy' });
  assert.deepEqual(await pending, { opened: false, reason: 'unavailable' });
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  assert.equal(fs.readFileSync(path.join(profile, 'keep'), 'utf8'), 'persistent');
});
test('path escape, symlinks, public directories and replacement races are rejected', async t => {
  const f = fixture(t);
  assert.equal((await f.browser.open({ ...f.w, browser: f.root })).opened, false);
  fs.symlinkSync(f.root, f.w.browser);
  assert.equal((await f.browser.open(f.w)).opened, false);
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  fs.unlinkSync(f.w.browser); fs.mkdirSync(f.w.browser, { mode: 0o755 });
  assert.equal((await f.browser.open(f.w)).opened, false);
  fs.chmodSync(f.w.browser, 0o700);
  const racing = new SecureBrowser({ ...f.options, snapshot: () => {
    fs.renameSync(f.w.browser, `${f.w.browser}-old`); fs.mkdirSync(f.w.browser, { mode: 0o700 });
    return f.rows;
  } });
  assert.equal((await racing.open(f.w)).opened, false);
  assert.equal(f.launches.length, 0);
});
test('asynchronous spawn failure is removable; exit and timeout without ownership stay unknown', async t => {
  for (const event of ['error', 'exit', 'timeout']) {
    const f = fixture(t, { timeout: 5, launch: () => {
      const child = new EventEmitter(); child.unref = () => {};
      if (event !== 'timeout') queueMicrotask(() => child.emit(event, event === 'error' ? Error('spawn failed') : 1));
      return child;
    } });
    assert.deepEqual(await f.browser.open(f.w), { opened: false, reason: 'unavailable' });
    if (event === 'error') await f.browser.assertRemovable(f.w);
    else await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  }
});
test('workspaces use distinct persistent profiles; launch intent left by another host blocks access', async t => {
  const f = fixture(t);
  f.rows.push({ pid: 98, start: 'personal', chrome: true, profile: path.join(f.root, 'personal'), executable: path.join(f.app, 'Contents/MacOS/Google Chrome') });
  await f.browser.open(f.w);
  const w2 = { id: 'two', dir: path.join(f.root, 'two'), browser: path.join(f.root, 'two/browser') };
  fs.mkdirSync(w2.dir, { mode: 0o700 });
  assert.deepEqual(await f.browser.open(w2), { opened: true });
  assert.notEqual(f.launches[0].args[1], f.launches[1].args[1]);
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_busy' });
  await assert.rejects(f.browser.assertRemovable(w2), { code: 'secure_browser_busy' });
  assert.deepEqual(await f.browser.open(f.w, 'https://example.com/login'), { opened: true });
  f.rows = [{ pid: 1, start: 'system', chrome: false }];
  fs.writeFileSync(path.join(f.w.browser, 'secure-chrome/.ezil-launch'), '', { mode: 0o600 });
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  assert.deepEqual(await f.browser.open(f.w), { opened: false, reason: 'profile_busy' });
});

test('async verification and ps yield to the event loop; status exposes only its frozen fields', async t => {
  const f = fixture(t);
  const commands = [];
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 1);
  t.after(() => clearInterval(ticker));
  const browser = new SecureBrowser({ ...f.options, snapshot: undefined, run: async (file, args, options) => {
    commands.push(file);
    await new Promise(resolve => setTimeout(resolve, 5));
    if (file === '/bin/ps') return { stdout: '1 0 Sun Sep 20 10:00:00 2026 /sbin/launchd' };
    return { stdout: f.options.run(file, args, options) };
  } });
  const status = await browser.status();
  assert.deepEqual(status, { available: true, version: '153.0.0.0' });
  assert.ok(ticks >= 3);
  assert.ok(commands.includes('/usr/bin/codesign')); assert.ok(commands.includes('/usr/libexec/PlistBuddy'));
  fs.mkdirSync(f.w.browser, { mode: 0o700 });
  fs.mkdirSync(path.join(f.w.browser, 'secure-chrome'), { mode: 0o700 });
  const before = ticks;
  await browser.assertRemovable(f.w);
  assert.ok(ticks > before); assert.ok(commands.includes('/bin/ps'));
  const stalled = new SecureBrowser({ ...f.options, timeout: 5, run: () => new Promise(() => {}) });
  assert.deepEqual(await stalled.status(), { available: false, version: '', reason: 'unavailable' });
  const killed = new SecureBrowser({ ...f.options, run: () => { throw Object.assign(Error('timed out'), { killed: true }); } });
  assert.deepEqual(await killed.status(), { available: false, version: '', reason: 'unavailable' });
  const stalledSnapshot = new SecureBrowser({ ...f.options, timeout: 5, snapshot: () => new Promise(() => {}) });
  await assert.rejects(stalledSnapshot.assertRemovable(f.w), { code: 'secure_browser_unknown' });
});

test('scoped ps distinguishes personal and explicit profiles, validates birth, and discards other arguments', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.w.browser, { mode: 0o700 });
  const profile = path.join(f.w.browser, 'secure-chrome');
  fs.mkdirSync(profile, { mode: 0o700 });
  const other = path.join(f.root, 'other profile'); fs.mkdirSync(other);
  const executable = path.join(f.app, 'Contents/MacOS/Google Chrome');
  const start = 'Sun Sep 20 10:00:00 2026';
  let command = `${executable} --user-data-dir=${other} --new-window https://example.com/`;
  let birth = start;
  const browser = new SecureBrowser({ ...f.options, snapshot: undefined, run: async (file, args, options) => {
    if (file !== '/bin/ps') return f.options.run(file, args, options);
    if (args[0] === '-axo') return `1 0 ${start} /sbin/launchd\n21 1 ${start} ${executable}\n22 1 ${start} ${executable}\n23 22 ${start} /Chrome/Google Chrome Helper`;
    assert.deepEqual(args.slice(0, 2), ['-ww', '-p']);
    assert.ok(['21', '22'].includes(args[2])); // No arguments read for unrelated processes/helpers.
    return args[2] === '21' ? `${start} ${executable}` : `${birth} ${command}`;
  } });
  await browser.assertRemovable(f.w); // Personal Chrome plus another explicit profile.
  const rows = await browser.snapshot();
  assert.equal(rows.find(r => r.pid === 23).profile, other);
  assert.ok(!JSON.stringify(rows).includes('https://'));
  command = `${executable} --user-data-dir=${profile} --new-window https://example.com/`;
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_busy' });
  assert.deepEqual(await browser.open(f.w), { opened: false, reason: 'profile_busy' }); // No owned marker.
  command = `${executable} --user-data-dir=${other} --user-data-dir=${profile}`;
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  command = `${executable} --user-data-dir=${other}`; birth = 'Sun Sep 20 11:00:00 2026';
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
});

test('repeat open requires matching owned profile, executable, and lock; failed forwarding retains ownership', async t => {
  const f = fixture(t); await f.browser.open(f.w);
  const profile = path.join(f.w.browser, 'secure-chrome');
  const row = f.rows.find(r => r.chrome);
  const marker = fs.readFileSync(path.join(profile, '.ezil-owner.json'), 'utf8');
  fs.symlinkSync(`${os.hostname()}-${row.pid}`, path.join(profile, 'SingletonLock'));
  fs.symlinkSync('/unread/socket', path.join(profile, 'SingletonSocket'));
  assert.deepEqual(await f.browser.open(f.w), { opened: true });
  const failing = new SecureBrowser({ ...f.options, launch: () => { throw Error('spawn failure'); } });
  assert.deepEqual(await failing.open(f.w), { opened: false, reason: 'unavailable' });
  assert.equal(fs.readFileSync(path.join(profile, '.ezil-owner.json'), 'utf8'), marker);
  await assert.rejects(failing.assertRemovable(f.w), { code: 'secure_browser_busy' });
  row.profile = path.join(f.root, 'wrong');
  assert.deepEqual(await f.browser.open(f.w), { opened: false, reason: 'profile_busy' });
  await assert.rejects(f.browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
});

test('reparented signed Chrome crash reporters are scoped to their database without exposing arguments', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.w.browser, { mode: 0o700 });
  const profile = path.join(f.w.browser, 'secure-chrome'); fs.mkdirSync(profile, { mode: 0o700 });
  const personal = path.join(f.root, 'personal profile'); fs.mkdirSync(path.join(personal, 'Crashpad'), { recursive: true });
  const reporter = path.join(f.app, 'Contents/Frameworks/Google Chrome Framework.framework/Versions/153.0.0.0/Helpers/chrome_crashpad_handler');
  fs.mkdirSync(path.dirname(reporter), { recursive: true }); fs.writeFileSync(reporter, 'fixture', { mode: 0o755 });
  const start = 'Sun Sep 20 10:00:00 2026';
  let birth = start, executable = reporter, argumentsText = `--database=${personal}/Crashpad --annotation=discard-me --url=https://example.com/private`;
  const browser = new SecureBrowser({ ...f.options, snapshot: undefined, run: async (file, args, options) => {
    if (file !== '/bin/ps') return f.options.run(file, args, options);
    if (args[0] === '-axo') return `1 0 ${start} /sbin/launchd\n42 1 ${start} ${executable}`;
    assert.deepEqual(args, ['-ww', '-p', '42', '-o', 'lstart=,command=']);
    return `${birth} ${executable} ${argumentsText}`;
  } });
  // Tests model an installed bundle without touching the real Chrome app.
  const original = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => file === '/Applications/Google Chrome.app' ? undefined : original(file, ...args));
  await browser.assertRemovable(f.w);
  const rows = await browser.snapshot();
  assert.equal(rows.find(r => r.pid === 42).profile, personal);
  assert.doesNotMatch(JSON.stringify(rows), /discard-me|https:/);
  fs.mkdirSync(path.join(profile, 'Crashpad'));
  argumentsText = `--database=${profile}/Crashpad`;
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_busy' });
  for (const args of [`--database=${personal}/Crashpad --database=${profile}/Crashpad`, `--database=${personal}/unknown`, `--database="${personal}/Crashpad"`, '--url=https://example.com/']) {
    argumentsText = args;
    await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  }
  argumentsText = `--database=${personal}/Crashpad`; birth = 'Sun Sep 20 11:00:00 2026';
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  birth = start; f.badSignature = true;
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
  f.badSignature = false; executable = '/untrusted/Google Chrome/chrome_crashpad_handler';
  await assert.rejects(browser.assertRemovable(f.w), { code: 'secure_browser_unknown' });
});

test('separate workspace launches can be in flight concurrently with personal Chrome present', async t => {
  const f = fixture(t);
  f.rows.push({ pid: 90, start: 'personal', chrome: true, profile: path.join(f.root, 'personal'), executable: path.join(f.app, 'Contents/MacOS/Google Chrome') });
  const second = { id: 'second', dir: path.join(f.root, 'second'), browser: path.join(f.root, 'second/browser') };
  fs.mkdirSync(second.dir, { mode: 0o700 });
  assert.deepEqual(await Promise.all([f.browser.open(f.w), f.browser.open(second)]), [{ opened: true }, { opened: true }]);
  f.rows = f.rows.filter(r => r.profile !== path.join(f.w.browser, 'secure-chrome'));
  await f.browser.assertRemovable(f.w); // Other workspace and personal Chrome remain live.
  await assert.rejects(f.browser.assertRemovable(second), { code: 'secure_browser_busy' });
});
