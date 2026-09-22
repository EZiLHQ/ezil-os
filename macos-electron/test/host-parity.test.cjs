'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Diagnostics, redact } = require('../src/diagnostics.cjs');
const { Browser, bounds, scaleBounds } = require('../src/browser.cjs');
const { hostSchema, authorize } = require('../src/host-ipc.cjs');
const { authenticatedHeaders } = require('../src/helper.cjs');
const { EditorSupervisor } = require('../src/editor.cjs');
const { checkClosure } = require('../scripts/bundle-helper.cjs');
const id = randomUUID(), generation = randomUUID();
function editorWorkspace(root) {
  const editorData = path.join(root, 'editor-data'); fs.mkdirSync(editorData);
  return { id, dir: root, files: root, editorData, extensions: path.join(root, 'extensions') };
}
function fakeBrowser() {
  const window = new EventEmitter(), contents = new EventEmitter();
  Object.assign(window, { webContents: contents, isDestroyed: () => false, getContentSize: () => [800, 600], contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView(v) { this.children = this.children.filter(x => x !== v); } } });
  class View {
    constructor(options) {
      this.options = options; this.webContents = new EventEmitter();
      Object.assign(this.webContents, { setWindowOpenHandler() {}, loadURL: async url => { this.url = url; }, isDestroyed: () => !!this.destroyed, close: () => { this.destroyed = true; this.webContents.emit('destroyed'); }, focus: () => { this.focused = true; }, capturePage: async () => ({ resize: () => ({ toDataURL: () => 'data:image/png;base64,fixture' }) }) });
    }
    setBounds(value) { this.bounds = value; } getBounds() { return this.bounds; } setVisible(value) { this.visible = value; }
  }
  const session = new EventEmitter(); Object.assign(session, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, closeAllConnections: async () => {}, clearStorageData: async () => {}, clearCache: async () => {}, webRequest: { onBeforeRequest() {} } });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-views-')));
  const files = path.join(directory, 'files'); fs.mkdirSync(files);
  return { window, View, directory, files, session, browser: new Browser({ id, browser: directory, files }, window, generation, { WebContentsView: View, session: { fromPath: () => session } }) };
}
test('structured diagnostics allowlist fields and double-redact all export material', () => {
  const diagnostics = new Diagnostics();
  diagnostics.note('EDITOR_STATE', { state: 'failed', password: 'secret', url: 'https://private.test/project', snapshot: 'screenshot' });
  diagnostics.note('https://private.test/secret');
  const report = JSON.parse(diagnostics.report());
  assert.equal(report.version, 1); assert.equal(report.events[0].state, 'failed');
  assert.equal(report.events[1].code, 'NATIVE_OPERATION_FAILED');
  assert.doesNotMatch(diagnostics.report(), /secret|private|snapshot|screenshot/);
  for (const [input, secrets] of [
    ['Bearer x', [' x']], ['Cookie: a=short; b=another; c=last', ['short', 'another', 'last']],
    ['{"password":"ab\\\"cd", "token":"z"}', ['ab', 'cd', '"z"']],
    ['https://private.test/p?q=secret /Users/alice/project C:\\Users\\alice\\project', ['private.test', 'alice', 'secret']]
  ]) for (const secret of secrets) assert.ok(!redact(redact(input)).includes(secret));
});
test('workspace IPC refuses forged frame, workspace, stale generation and sequence', () => {
  const frame = { url: 'http://127.0.0.1:1234/os' }, wc = { mainFrame: frame };
  const caller = { wc, url: frame.url, role: 'desktop', workspaceId: id, generation, sequence: 0 };
  const host = { workspace: { id }, generation }, event = { sender: wc, senderFrame: frame };
  const input = hostSchema({ op: 'editor.start', workspaceId: id, generation, sequence: 1 });
  for (const forged of [{ ...event, sender: {} }, { ...event, senderFrame: { ...frame } }]) assert.throws(() => authorize(forged, caller, host, input));
  for (const extra of [{ workspaceId: randomUUID() }, { generation: randomUUID() }]) assert.throws(() => authorize(event, caller, host, { ...input, ...extra }));
  authorize(event, caller, host, input); assert.throws(() => authorize(event, caller, host, input));
  assert.throws(() => hostSchema({ ...input, target: 'http://evil.test' }));
});
test('helper headers never expose admin and reject remote frames and mismatched webContents', () => {
  const helper = { origin: 'http://127.0.0.1:1234', url: 'http://127.0.0.1:1234/os', capability: 'admin', shellCapability: 'shell', webContentsId: 42 };
  const details = { url: helper.url, resourceType: 'mainFrame', webContentsId: 42, requestHeaders: { Cookie: 'a=b', Authorization: 'forged' } };
  assert.equal(authenticatedHeaders(details, helper).Authorization, 'Bearer shell');
  for (const override of [{ webContentsId: 43 }, { resourceType: 'xhr', initiator: 'https://evil.test' }, { url: 'http://127.0.0.1:12345/os' }]) assert.deepEqual(authenticatedHeaders({ ...details, ...override }, helper), {});
});
test('browser owns sandboxed children, safe downloads, clamps DIP bounds and clears snapshots and orphans', async t => {
  const { window, directory, files, session, browser } = fakeBrowser(); t.after(async () => { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let sequence = 0;
  const op = (action, fields = {}) => browser.operation({ op: action, workspaceId: id, generation, sequence: ++sequence, viewId: 'tab', ...fields });
  await op('create', { url: 'https://example.com', bounds: { x: -5, y: 590, width: 1000, height: 100 } });
  const view = browser.views.get('tab').view;
  assert.deepEqual(view.bounds, { x: 0, y: 590, width: 800, height: 10 });
  assert.equal(window.contentView.children.length, 1); assert.equal(view.options.webPreferences.preload, undefined); assert.equal(view.options.webPreferences.nodeIntegration, false);
  let saveOptions;
  session.emit('will-download', {}, { getFilename: () => '../../report.txt', setSaveDialogOptions: value => { saveOptions = value; } });
  assert.equal(saveOptions.defaultPath, path.join(files, 'Downloads', 'report.txt'));
  assert.equal(fs.statSync(path.dirname(saveOptions.defaultPath)).mode & 0o777, 0o700);
  const snapshot = await op('snapshot'); assert.equal(snapshot.state, 'hidden'); assert.ok(snapshot.snapshot.startsWith('data:image/')); assert.equal(window.contentView.children.length, 0);
  await op('restore'); assert.equal(browser.views.get('tab').snapshot, null); assert.equal(window.contentView.children.length, 1);
  await op('hide'); await op('visibility', { visible: true }); assert.equal(window.contentView.children.length, 0);
  await op('restore'); await op('focus'); assert.equal(view.focused, true);
  await assert.rejects(browser.operation({ op: 'destroy', workspaceId: id, generation, sequence, viewId: 'tab' }));
  window.webContents.emit('did-start-navigation', {}, '', false, true); assert.equal(browser.views.size, 0); assert.equal(window.contentView.children.length, 0); assert.equal(view.destroyed, true);
  assert.throws(() => bounds({ x: NaN, y: 0, width: 1, height: 1 }, [800, 600]));
  assert.deepEqual(scaleBounds({ x: 5, y: 10, width: 400, height: 300 }, 1.5), { x: 7.5, y: 15, width: 600, height: 450 });
  assert.throws(() => scaleBounds({ x: 0, y: 0, width: 1, height: 1 }, Infinity));
});
test('late capture cannot restore a destroyed or newly visible view', async t => {
  const { directory, browser } = fakeBrowser(); t.after(async () => { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = { workspaceId: id, generation, viewId: 'tab' };
  await browser.operation({ ...base, op: 'create', sequence: 1, url: 'https://example.com', bounds: { x: 0, y: 0, width: 30, height: 30 } });
  let release; browser.views.get('tab').view.webContents.capturePage = () => new Promise(resolve => { release = resolve; });
  const capture = browser.operation({ ...base, op: 'snapshot', sequence: 2 });
  await browser.operation({ ...base, op: 'restore', sequence: 3 }); release({}); await assert.rejects(capture, /Stale/);
});
test('supervisor deduplicates starts, keeps secrets out of child env/args, stops and retries failures', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-supervisor-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = editorWorkspace(root);
  let launches = 0, socketFailure; const states = [];
  // Real private socket stat, injected login. Socket transport is covered separately.
  const net = require('node:net'); let server;
  const supervisor = new EditorSupervisor({ resources: root, timeout: 1000, note: (_code, fields) => states.push(fields.state), authenticate: async () => 'session=opaque', launch: (_file, args, options) => {
    launches++; assert.equal(options.env.PASSWORD, undefined); assert.equal(options.env.EZIL_NATIVE_ADMIN_CAPABILITY, undefined);
    const config = args[args.indexOf('--config') + 1], contents = fs.readFileSync(config, 'utf8');
    const password = JSON.parse(contents.match(/password: (.+)/)[1]); assert.ok(!JSON.stringify(args).includes(password)); assert.ok(!JSON.stringify(options.env).includes(password));
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    const socketPath = JSON.parse(contents.match(/^socket: (.+)/m)[1]);
    const child = new EventEmitter(); child.kill = () => { server?.close(); queueMicrotask(() => child.emit('exit', 0)); };
    server = net.createServer(); server.on('error', error => { socketFailure = error; child.emit('error', error); }); server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
    return child;
  } });
  t.after(() => supervisor.close());
  const first = supervisor.start(workspace), second = supervisor.start(workspace);
  const outcomes = await Promise.allSettled([first, second]);
  if (outcomes[0].status === 'rejected' && ['EPERM', 'EACCES'].includes(socketFailure?.code)) { assert.equal(supervisor.state(id), 'failed'); t.skip('Unix listen is unavailable in this sandbox; hosted macOS runs this gate'); return; }
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(launches, 1); assert.equal(outcomes[0].value, outcomes[1].value); assert.equal(supervisor.state(id), 'ready');
  const runtime = outcomes[0].value.runtime;
  await supervisor.stop(id); assert.equal(supervisor.state(id), 'stopped'); assert.equal(fs.existsSync(runtime), false);
  await supervisor.start(workspace); assert.equal(launches, 2); await supervisor.close();
  assert.ok(states.includes('starting') && states.includes('ready') && states.includes('stopping') && states.includes('stopped'));
});
test('closure verifier rejects unbundled packages and relative runtime imports', () => {
  for (const dependency of ['missing-package', '../local/server.ts']) assert.throws(() => checkClosure({ inputs: { source: {} }, outputs: { bundle: { imports: [{ path: dependency, external: true }] } } }));
  checkClosure({ inputs: { source: {} }, outputs: { bundle: { imports: [{ path: 'node:fs', external: true }] } } });
});
test('supervisor ready, failed, stopped, cancellation and restart transitions without socket binding', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-state-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = editorWorkspace(root);
  let mode = 'ready', launches = 0, child; const states = [];
  const supervisor = new EditorSupervisor({ resources: root, timeout: 10,
    socketStat: () => ({ isSocket: () => true, mode: 0o600 }),
    authenticate: async () => { if (mode === 'failed') throw Error('not ready'); return 'cookie=opaque'; },
    note: (_code, fields) => states.push(fields.state),
    launch: () => {
      launches++; child = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('exit')); };
      return child;
    }
  });
  t.after(() => supervisor.close());
  const [first, second] = await Promise.all([supervisor.start(workspace), supervisor.start(workspace)]);
  assert.equal(first, second); assert.equal(launches, 1); assert.equal(supervisor.state(id), 'ready');
  child.emit('exit'); assert.equal(supervisor.state(id), 'failed');
  await supervisor.start(workspace); assert.equal(launches, 2); await supervisor.stop(id); assert.equal(supervisor.state(id), 'stopped');
  mode = 'failed'; await assert.rejects(supervisor.start(workspace)); assert.equal(supervisor.state(id), 'failed');
  mode = 'ready'; await supervisor.start(workspace); await supervisor.stop(id);
  assert.ok(['stopped', 'starting', 'ready', 'failed', 'stopping'].every(state => states.includes(state)));
});
test('supervisor does not signal a process group again after graceful exit', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-graceful-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = editorWorkspace(root);
  const signals = [];
  const supervisor = new EditorSupervisor({ resources: root,
    socketStat: () => ({ isSocket: () => true, mode: 0o600 }), authenticate: async () => 'cookie=opaque',
    launch: () => {
      const child = new EventEmitter(); child.kill = signal => { signals.push(signal); queueMicrotask(() => child.emit('exit')); }; return child;
    }
  });
  await supervisor.start(workspace); await supervisor.stop(id);
  assert.deepEqual(signals, ['SIGTERM']);
});
test('navigation fails asynchronously while real creation failure leaves no native child', async t => {
  const { directory, browser, View, window } = fakeBrowser(); t.after(async () => { await browser.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  browser.WebContentsView = class extends View { constructor(options) { super(options); this.webContents.loadURL = async () => { throw Error('Navigation failed'); }; } };
  const create = { op: 'create', workspaceId: id, generation, sequence: 1, viewId: 'failed', url: 'https://example.com', bounds: { x: 0, y: 0, width: 10, height: 10 } };
  assert.deepEqual(await browser.operation(create), { state: 'created' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.state('failed').error, 'navigation_failed');
  assert.equal(browser.views.size, 1); assert.equal(window.contentView.children.length, 1);
  browser.destroy('failed');
  browser.WebContentsView = class { constructor() { throw Error('View allocation failed'); } };
  await assert.rejects(browser.operation({ ...create, sequence: 2 }), /View allocation failed/);
  assert.equal(browser.views.size, 0); assert.equal(window.contentView.children.length, 0);
});
test('editor cancellation while authenticating cannot publish ready or leave runtime files', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-cancel-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = editorWorkspace(root);
  let release;
  const supervisor = new EditorSupervisor({ resources: root, socketStat: () => ({ isSocket: () => true, mode: 0o600 }), authenticate: () => new Promise(resolve => { release = resolve; }), launch: () => {
    const child = new EventEmitter(); child.kill = () => queueMicrotask(() => child.emit('exit')); return child;
  } });
  const pending = supervisor.start(workspace), runtime = supervisor.instances.get(id).runtime;
  await supervisor.stop(id); release('cookie=must-not-publish'); await assert.rejects(pending);
  assert.equal(supervisor.state(id), 'stopped'); assert.equal(fs.existsSync(runtime), false); assert.equal(supervisor.instances.get(id).cookie, null);
});
