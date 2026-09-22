'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { configurePasskeys, PasskeyAccounts } = require('../src/passkeys.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
function signing(overrides = {}) {
  const configured = [], calls = [];
  return { configured, calls, hasProfile: () => true, app: { isPackaged: true, getPath: () => '/Applications/EZiL OS.app/Contents/MacOS/EZiL OS', configureWebAuthn: value => configured.push(value) },
    systemPreferences: { canPromptTouchID: () => true }, platform: 'darwin',
    run: async (bin, args, options) => { calls.push({ bin, args, options }); return { stdout: 'A1B2C3D4E5.com.ezil.os.native.webauthn\n' }; }, ...overrides };
}
test('passkeys require packaged Apple trust, exact main-app group and Touch ID; never leak paths', async () => {
  const f = signing(), result = await configurePasskeys(f);
  assert.deepEqual(result, { embeddedTouchID: true, syncedPasskeys: false, existingPasskeys: 'secure-browser' });
  assert.equal(f.configured.length, 1);
  assert.equal(f.configured[0].touchID.keychainAccessGroup, 'A1B2C3D4E5.com.ezil.os.native.webauthn');
  assert.equal(f.calls[1].args.at(-1), '/Applications/EZiL OS.app');
  assert.match(f.calls[1].args.join(' '), /anchor apple generic.*identifier "com.ezil.os.native".*subject.OU.*keychain-access-groups/);
  assert.equal(f.calls[1].options.timeout, 5000);
  assert.equal('platformPasskeys' in f.configured[0], false);
  for (const f of [signing({ platform: 'linux' }), signing({ app: { isPackaged: false, configureWebAuthn() { assert.fail(); } } }),
    signing({ app: { isPackaged: true } }), signing({ run: async () => { throw Error('/private/secret'); } }),
    signing({ run: async () => ({ stdout: 'OTHER.app.webauthn' }) }), signing({ hasProfile: () => false }), signing({ systemPreferences: { canPromptTouchID: () => false } })]) {
    const status = await configurePasskeys(f);
    assert.equal(status.embeddedTouchID, false); assert.equal(f.configured.length, 0);
    assert.ok(!JSON.stringify(status).includes('private'));
  }
  const untrusted = signing(); untrusted.run = async (bin) => { if (bin.endsWith('codesign')) throw Error('bad signature'); return { stdout: 'A1B2C3D4E5.com.ezil.os.native.webauthn' }; };
  assert.equal((await configurePasskeys(untrusted)).reason, 'signing_required'); assert.equal(untrusted.configured.length, 0);
});
function fixture(t, timeout) {
  const session = new EventEmitter(), window = new EventEmitter(), wc = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false });
  Object.assign(wc, { isDestroyed: () => false, mainFrame: { url: 'https://login.example.test/' } });
  const frame = wc.mainFrame; frame.top = frame;
  const dialogs = [], responses = []; let visible = true;
  const manager = new PasskeyAccounts(session, window, f => visible && f?.top === frame ? wc : null, { timeout,
    dialog: { showMessageBox: async (_window, options) => new Promise((resolve, reject) => dialogs.push({ options, resolve, reject })) } });
  const details = { frame, relyingPartyId: 'example.test', accounts: [{ credentialId: 'first', name: 'alice@example.test' }, { credentialId: 'second', name: 'bob@example.test' }] };
  const request = value => session.emit('select-webauthn-account', {}, value || details, id => responses.push(id));
  t.after(() => manager.close());
  return { session, window, wc, frame, dialogs, responses, manager, details, request, hide() { visible = false; manager.reconcile(); } };
}
test('native account selection exposes only the chosen supplied ID and safe origin labels', async t => {
  const f = fixture(t); f.details.accounts[0].name = '\u202eevil\nname'; f.request();
  assert.equal(f.dialogs.length, 1);
  assert.match(f.dialogs[0].options.message, /example.test/);
  assert.match(f.dialogs[0].options.detail, /https:\/\/login.example.test/);
  assert.equal(f.dialogs[0].options.buttons[1], '1. evilname');
  assert.equal(f.dialogs[0].options.defaultId, 0);
  f.dialogs[0].resolve({ response: 2 }); await tick();
  assert.deepEqual(f.responses, ['second']); assert.equal(f.manager.pending, null);
  assert.equal(f.wc.listenerCount('did-start-navigation'), 0);
});
test('cancel, UI failure and invalid native selection always settle once', async t => {
  for (const outcome of [0, 99, -1, 1.5, '1', 'reject']) {
    const f = fixture(t); f.request();
    outcome === 'reject' ? f.dialogs[0].reject(Error('private error')) : f.dialogs[0].resolve({ response: outcome });
    await tick(); assert.deepEqual(f.responses, [undefined]);
  }
});
test('rejects foreign/detached frames, RP mismatch, insecure URLs and invalid accounts without UI', t => {
  const cases = [d => ({ ...d, frame: null }), d => ({ ...d, frame: { ...d.frame, top: {} } }),
    d => ({ ...d, frame: { ...d.frame, detached: true } }), d => ({ ...d, relyingPartyId: 'evil.test' }),
    d => ({ ...d, frame: { ...d.frame, url: 'http://example.test/' } }), d => ({ ...d, frame: { ...d.frame, url: 'file:///private' } }),
    d => ({ ...d, accounts: [] }), d => ({ ...d, accounts: [{ credentialId: 'with padding=' }] }),
    d => ({ ...d, accounts: [d.accounts[0], d.accounts[0]] })];
  for (const change of cases) { const f = fixture(t); f.request(change(f.details)); assert.equal(f.dialogs.length, 0); assert.deepEqual(f.responses, [undefined]); }
});
test('pending selection cancels on navigation, tab occlusion, window lifecycle, renderer loss and session close', async t => {
  for (const cancel of [f => f.wc.emit('did-start-navigation'), f => f.wc.emit('destroyed'), f => f.wc.emit('render-process-gone'), f => f.hide(),
    f => f.window.emit('hide'), f => f.window.emit('minimize'), f => f.window.emit('closed'), f => f.manager.close()]) {
    const f = fixture(t); f.request(); cancel(f);
    assert.deepEqual(f.responses, [undefined]); assert.equal(f.dialogs[0].options.signal.aborted, true);
    f.dialogs[0].resolve({ response: 1 }); await tick(); assert.deepEqual(f.responses, [undefined]);
  }
});
test('revalidates exact frame and origin after UI; concurrent requests do not overlap', async t => {
  const f = fixture(t); f.request(); f.request(); assert.equal(f.dialogs.length, 1);
  f.frame.url = 'https://other.example.test/'; f.dialogs[0].resolve({ response: 1 }); await tick();
  assert.deepEqual(f.responses, [undefined, undefined]);
  f.manager.close(); assert.equal(f.session.listenerCount('select-webauthn-account'), 0);
});
test('large account lists paginate; timeout cancels a stalled native chooser', async t => {
  const f = fixture(t); f.details.accounts = Array.from({ length: 6 }, (_, i) => ({ credentialId: `credential${i}`, name: `User ${i}` }));
  f.request(); assert.equal(f.dialogs[0].options.buttons.at(-1), 'More accounts');
  f.dialogs[0].resolve({ response: 6 }); await tick();
  assert.equal(f.dialogs[1].options.buttons[1], '6. User 5');
  f.dialogs[1].resolve({ response: 1 }); await tick(); assert.deepEqual(f.responses, ['credential5']);
  const g = fixture(t, 10); g.request(); await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(g.responses, [undefined]); g.dialogs[0].resolve({ response: 1 }); await tick(); assert.equal(g.responses.length, 1);
});
test('sibling iframe navigation preserves selection; requesting frame or ancestor navigation cancels', async t => {
  const f = fixture(t); f.request();
  f.wc.emit('did-start-navigation', { frame: { parent: f.frame }, isMainFrame: false });
  assert.equal(f.responses.length, 0);
  f.dialogs[0].resolve({ response: 1 }); await tick(); assert.deepEqual(f.responses, ['first']);
  for (const ancestor of [false, true]) {
    const g = fixture(t); const child = { top: g.frame, parent: g.frame, url: 'https://login.example.test/child' };
    g.request({ ...g.details, frame: child });
    g.wc.emit('did-start-navigation', { frame: ancestor ? g.frame : child, isMainFrame: ancestor });
    assert.deepEqual(g.responses, [undefined]); g.dialogs[0].resolve({ response: 1 }); await tick(); assert.equal(g.responses.length, 1);
  }
});
