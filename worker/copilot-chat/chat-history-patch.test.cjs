// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/chat-history-patch.test.cjs
// Exercises the PATCHED code-server 4.141.0 ChatSessionStore (extracted from the real
// workbench.js, its collaborators stubbed) against session files on disk in the
// <workspace>/.ezil/chat folder editor-state.sh prepares. Skips without a local pristine bundle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const editorState = path.join(__dirname, '..', 'scripts', 'editor-state.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb, 'out/vs/code/browser/workbench/workbench.css'];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const between = (code, start, end) => {
  const i = code.indexOf(start); assert(i >= 0, `missing ${start.slice(0, 40)}`);
  const j = code.indexOf(end, i); assert(j > i, `missing ${end.slice(0, 40)}`);
  return code.slice(i, j);
};
const bash = (command, ...args) => spawnSync('bash', ['-c', `set -euo pipefail\n. "$1"\nshift\n${command}`, 'bash', editorState, ...args], { encoding: 'utf8' });

// Minimal stand-ins for the workbench services the store calls. Files are real.
function harness(code) {
  class Ue {
    constructor(buffer) { this.buffer = buffer; this.byteLength = buffer.length; }
    static fromString(s) { return new Ue(Buffer.from(s)); }
    indexOf(other, from) { return this.buffer.indexOf(typeof other === 'number' ? other : other.buffer, from); }
    slice(a, b) { return new Ue(this.buffer.subarray(a, b)); }
    toString() { return this.buffer.toString(); }
  }
  const uri = p => ({ path: p, fsPath: p, scheme: 'vscode-remote', toString: () => `vscode-remote://remote${p}` });
  const Wn = { joinPath: (u, ...parts) => uri(path.posix.join(u.path, ...parts)), isEqual: (a, b) => a.path === b.path, dirname: u => uri(path.posix.dirname(u.path)) };
  const notFound = () => Object.assign(new Error('not found'), { fileOperationResult: 1 });
  const body = [
    between(code, 'var Umi=class{', 'var QNr=s=>'),
    between(code, 'function y7t(s){', 'function O4i(s){'),
    between(code, 'function ywe(s,o,e=""){', 'function Mi(s){'),
    'var fte=class extends Umi{constructor(){super(null,1024)}};',
    'class sC{' + between(code, 'static getDefaultTitle(e){', 'get repoData(){') + '}',
    between(code, 'var zSn=400,HTt="chat.ChatSessionStore.index"', 'async function qSn(s,o){'),
    'return { Store: lme, HTt, zSn };',
  ].join('\n');
  const names = ['x', 'Kd', 'Ve', 'Wn', 'd', 'I', 'm', 'Ws', 'Lr', 'Se', 'ba', 'pn', 'Ue', 'UNr', 'fa', 'cDe', 'WSn', 'nt', 'p7t', 'L', 'setTimeout',
    'ye', 'yo', 'se', 'Be', 'Te', 'me', 'Go', 'xn', 'V', 'yy', 'Ct', 'rt'];
  const values = [
    class { _register(v) { return v; } },
    class { constructor() { this.tail = Promise.resolve(); } queue(fn) { const r = this.tail.then(fn); this.tail = r.catch(() => {}); return r; } },
    (u, ...parts) => Wn.joinPath(u, ...parts), Wn,
    (i) => ({ 12653: 'New Chat', 12652: 'Saving chat sessions' })[i] ?? `nls${i}`,
    (_, cls) => cls, () => undefined,
    { parseLocalSessionId: () => undefined }, v => v, class { constructor(v) { this.value = v; } },
    e => e?.fileOperationResult, e => String(e?.message ?? e), Ue, Ue.fromString('\n'),
    v => { throw new Error('unexpected log entry ' + JSON.stringify(v)); }, v => JSON.stringify(v), () => {},
    () => require('node:crypto').randomUUID(), async () => undefined, { revive: v => v },
    fn => setImmediate(fn),   // the root decision's retry back-off, without the wait
  ];
  const { Store, HTt, zSn } = new Function(...names, body)(...values);
  return {
    HTt, zSn,
    // A single-folder window on <folder>; upstream location <wsHome>/<id>/chatSessions.
    create({ folder, wsHome, id = 'ws-id', index, listing, stat, folders } = {}) {
      const stored = new Map(index ? [[HTt, JSON.stringify(index)]] : []);
      const calls = { resolve: 0, read: 0, readPaths: [], del: [], stat: 0, logs: [] };
      const fsPath = u => u.path;
      const fileService = {
        async resolve(u) {
          calls.resolve++;
          if (listing) return listing(u);
          let names; try { names = fs.readdirSync(fsPath(u)); } catch { throw notFound(); }
          return { children: names.map(name => { const st = fs.statSync(path.join(fsPath(u), name)); return { name, isDirectory: st.isDirectory(), mtime: st.mtimeMs }; }) };
        },
        async readFile(u) { calls.read++; calls.readPaths.push(u.path); try { return { value: new Ue(fs.readFileSync(fsPath(u))) }; } catch { throw notFound(); } },
        async del(u) { calls.del.push(u.path); try { fs.unlinkSync(fsPath(u)); } catch { throw notFound(); } },
        async exists(u) { return fs.existsSync(fsPath(u)); },
        async stat(u) {
          calls.stat++;
          if (stat) return stat(u, calls.stat);
          let st; try { st = fs.statSync(fsPath(u)); } catch { throw notFound(); }
          return { isDirectory: st.isDirectory() };
        },
        async writeFile() { throw new Error('unexpected write'); },
      };
      const storageService = { get: k => stored.get(k), store: (k, v) => stored.set(k, typeof v === 'string' ? v : JSON.stringify(v)) };
      const store = new Store(
        fileService, { workspaceStorageHome: uri(wsHome) },
        { info: (...a) => calls.logs.push(['info', ...a]), error: (...a) => calls.logs.push(['error', ...a]), trace() {} },
        { getWorkspace: () => ({ id, folders: folders ?? [{ uri: uri(folder) }] }) },
        { publicLog2() {} }, storageService, { onWillShutdown: () => ({}) },
        { defaultProfile: { globalStorageHome: uri('/global') } }, { getValue: () => undefined },
        { onDidEnterWorkspace: () => ({}) }, {}, {},
      );
      // Every store operation is queued behind the root decision; this waits for it.
      const ready = () => store.storeQueue.queue(async () => store.getChatStorageFolder().path);
      return { store, stored, calls, ready };
    },
  };
}

// A session log exactly as the store writes it: an initial snapshot, then set/push entries.
const request = (text, timestamp) => ({ requestId: `r${timestamp}`, message: { text, parts: [] }, timestamp, response: [] });
const log = (id, { title, location = 'panel', requests = [request('Fix the login form\nsecond line', 1000)], more = [] } = {}) =>
  [{ kind: 0, v: { version: 3, creationDate: 500, ...(title ? { customTitle: title } : {}), initialLocation: location, responderUsername: 'EZiL Chat', sessionId: id, requests } }, ...more]
    .map(e => JSON.stringify(e)).join('\n') + '\n';

// `test.skip` rather than the `skip` option: bun's node:test shim runs the body otherwise.
(source ? test : test.skip)('EZiL Chat history: patched store lists, prunes and deletes session files in the workspace', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-chat-history-'));
  try {
    const root = path.join(tmp, 'vscode');
    for (const file of files) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
    for (const args of [[root], ['--verify', root]]) { const r = run(...args); assert.equal(r.status, 0, r.stdout + r.stderr); }
    const pristine = fs.readFileSync(path.join(source, wb), 'utf8');
    const code = fs.readFileSync(path.join(root, wb), 'utf8');
    const h = harness(code);

    await t.test('upstream keys chat storage to the browser host, so it cannot be predicted per computer', () => {
      assert(pristine.includes('remoteAuthority:location.host}'), 'code-server embedder: remoteAuthority is location.host');
      assert(pristine.includes('function QUn(s){return Nr(s.toString()).toString(16)}'), 'workspace id hashes the folder URI');
      assert(pristine.includes('Ve(this.environmentService.workspaceStorageHome,b,"chatSessions")'), 'upstream root is <workspaceStorage>/<id>/chatSessions');
    });

    // The real folder from editor-state.sh, the real patched store using it.
    const workspace = path.join(tmp, 'workspace'), userData = path.join(tmp, 'user');
    const wsHome = path.join(userData, 'User', 'workspaceStorage');
    fs.mkdirSync(workspace);
    const prep = bash('export EZIL_HOSTS_FILE="$3"; : >"$3"; ezil_editor_prepare "$1" "$2"', userData, workspace, path.join(tmp, 'hosts'));
    assert.equal(prep.status, 0, prep.stderr);
    const chat = path.join(workspace, '.ezil', 'chat');
    assert(fs.statSync(chat).isDirectory());
    const make = (opts = {}) => h.create({ folder: workspace, wsHome, ...opts });

    await t.test('a single-folder window with .ezil/chat stores sessions there, whatever the host id', async () => {
      for (const id of ['-2ec3769a', '31384936']) {
        const { ready, calls } = make({ id });
        assert.equal(await ready(), chat);
        assert(calls.logs.some(l => l[0] === 'info' && l[1].startsWith('EZiL: chat history in ')));
      }
    });

    await t.test('without .ezil/chat, or with several folders, the upstream location is kept', async () => {
      const other = path.join(tmp, 'other-folder'); fs.mkdirSync(other);
      const plain = h.create({ folder: other, wsHome, id: 'abc' });
      assert.equal(await plain.ready(), path.join(wsHome, 'abc', 'chatSessions'));
      assert.equal(plain.calls.logs.filter(l => l[0] === 'error').length, 0);
      const multi = make({ id: 'multi', folders: [{ uri: { path: workspace } }, { uri: { path: other } }] });
      assert.equal(await multi.ready(), path.join(wsHome, 'multi', 'chatSessions'));
      assert.equal(multi.calls.stat, 0);
    });

    await t.test('a transient error is retried; a lasting one keeps upstream and is logged as an error', async () => {
      const flaky = make({ stat: (u, n) => { if (n < 3) throw new Error('remote not connected'); return { isDirectory: true }; } });
      assert.equal(await flaky.ready(), chat);
      assert.equal(flaky.calls.stat, 3);
      const down = make({ id: 'down', stat: () => { throw new Error('remote not connected'); } });
      assert.equal(await down.ready(), path.join(wsHome, 'down', 'chatSessions'));
      assert.equal(down.calls.stat, 6);
      assert(down.calls.logs.some(l => l[0] === 'error' && /unreadable/.test(l[1])));
    });

    fs.writeFileSync(path.join(chat, 'a.jsonl'), log('a', { title: 'Named', more: [{ kind: 2, k: ['requests'], v: [request('follow-up', 3000)], i: 1 }] }));
    fs.writeFileSync(path.join(chat, 'b.jsonl'), log('b'));
    fs.writeFileSync(path.join(chat, 'c.json'), JSON.stringify({ version: 3, creationDate: 200, initialLocation: 'panel', responderUsername: 'EZiL Chat', sessionId: 'c', requests: [request('flat legacy file', 2000)] }));
    fs.writeFileSync(path.join(chat, 'empty.jsonl'), log('empty', { requests: [] }));
    fs.writeFileSync(path.join(chat, 'bad.jsonl'), 'not json\n');
    fs.writeFileSync(path.join(chat, 'mismatch.jsonl'), log('someone-else'));
    fs.mkdirSync(path.join(chat, 'dir.jsonl'));

    await t.test('a missing index (new browser, new origin, CF restart, move) is rebuilt from the files', async () => {
      const { store, stored, calls } = make();
      const entries = await store.getIndex();
      assert.deepEqual(Object.keys(entries).sort(), ['a', 'b', 'c', 'empty']);
      assert.equal(entries.a.title, 'Named');
      assert.equal(entries.a.lastMessageDate, 3000);
      assert.equal(entries.b.title, 'Fix the login form');
      assert.equal(entries.c.title, 'flat legacy file');
      for (const k of ['a', 'b', 'c']) { assert.equal(entries[k].initialLocation, 'panel'); assert.equal(entries[k].isEmpty, false); assert.equal(entries[k].isExternal, false); }
      assert.equal(entries.empty.isEmpty, true);
      assert.deepEqual(Object.keys(JSON.parse(stored.get(h.HTt)).entries).sort(), ['a', 'b', 'c', 'empty']);
      const reads = calls.read;
      await store.getIndex();
      assert.equal(calls.read, reads, 'reconciled once per window');
      assert.equal(calls.resolve, 1);
      assert(calls.logs.some(l => l[0] === 'info' && /\+4 -0/.test(l[1])));
    });

    await t.test('stale local entries are dropped, external ones kept, known ones not re-read', async () => {
      const known = { sessionId: 'a', title: 'Named', lastMessageDate: 3000, initialLocation: 'panel', isEmpty: false, isExternal: false };
      const index = { version: 1, entries: { a: known, gone: { ...known, sessionId: 'gone' }, 'copilotcli:/x': { ...known, sessionId: 'x', isExternal: true } } };
      const { store, calls } = make({ index });
      const entries = await store.getIndex();
      assert.equal(entries.gone, undefined);
      assert(entries['copilotcli:/x'], 'external session kept');
      assert.equal(entries.a.title, 'Named');
      assert(!calls.readPaths.some(p => p.endsWith('/a.jsonl')), 'known session not re-read');
      assert(entries.b && entries.c);
      assert(calls.logs.some(l => l[0] === 'info' && /\+3 -1/.test(l[1])));
    });

    await t.test('a failed listing changes nothing and is retried; a missing directory prunes nothing', async () => {
      const known = { sessionId: 'gone', title: 'x', lastMessageDate: 1, initialLocation: 'panel', isEmpty: false, isExternal: false };
      let fail = true;
      const { store } = make({ index: { version: 1, entries: { gone: known } }, listing: () => { if (fail) throw new Error('connection lost'); return { children: [] }; } });
      assert.deepEqual(Object.keys(await store.getIndex()), ['gone']);
      fail = false;
      assert.deepEqual(Object.keys(await store.getIndex()), [], 'retried on the next read');
      const nowhere = path.join(tmp, 'nowhere'); fs.mkdirSync(nowhere);
      const missing = h.create({ folder: nowhere, wsHome: path.join(tmp, 'nowhere-home'), index: { version: 1, entries: { gone: known } } });
      assert.deepEqual(Object.keys(await missing.store.getIndex()), ['gone']);
      await missing.store.getIndex();
      assert.equal(missing.calls.resolve, 1, 'not-found is final for the window');
    });

    await t.test('the 400-entry cap holds: older files than a full index are not read back', async () => {
      const entries = {};
      for (let i = 0; i < h.zSn; i++) entries[`n${i}`] = { sessionId: `n${i}`, title: 't', lastMessageDate: Date.now() + 1e6 + i, initialLocation: 'panel', isEmpty: false, isExternal: false };
      const listing = () => ({ children: [...Object.keys(entries).map(k => ({ name: `${k}.jsonl`, isDirectory: false, mtime: entries[k].lastMessageDate })), { name: 'old.jsonl', isDirectory: false, mtime: 1 }] });
      const { store, calls } = make({ index: { version: 1, entries }, listing });
      assert.equal(Object.keys(await store.getIndex()).length, h.zSn);
      assert.equal(calls.read, 0);
    });

    await t.test('deleting in the editor removes the only copy, and it does not come back', async () => {
      const { store, calls } = make();
      await store.getIndex();
      await store.deleteSession('b');
      assert(calls.del.some(p => p.endsWith('/b.jsonl')));
      assert(!fs.existsSync(path.join(chat, 'b.jsonl')));
      const again = make({ id: 'another-host' });
      assert.equal((await again.store.getIndex()).b, undefined);
    });

    await t.test('the chat title (history entry) renders on an empty chat', () => {
      const shouldRender = new Function(`return {${between(code, 'shouldRender(){return!0}', 'getHeight(){')}}`)().shouldRender;
      assert.equal(shouldRender.call({ model: undefined }), true);
      assert.equal(shouldRender.call({ model: { title: '' } }), true);
      assert(code.includes('static{this.DEFAULT_TITLE="Chat history"}'));
      assert(code.includes('this.titleContainer.classList.toggle("visible",this.shouldRender())'));
      const old = new Function(`return {${between(pristine, 'shouldRender(){return!!this.model?.title}', 'getHeight(){')}}`)().shouldRender;
      assert.equal(old.call({ model: { title: '' } }), false, 'control: upstream hid the title on an empty chat');
      // doUpdate on an empty chat: the label reads "Chat history" and the title is visible.
      const methods = src => new Function('Se', 'Ar', 'X2', `return new (class { ${between(src, 'doUpdate(){let e=new Se(this.model?.title??"");', 'getHeight(){')} })()`)(class { constructor(v) { this.value = v; } }, m => m.value, { DEFAULT_TITLE: 'Chat history' });
      const render = src => {
        const seen = {}; const ctl = Object.assign(methods(src), {
          model: { title: '', sessionResource: {} }, delegate: { getInputUri: () => undefined },
          titleContainer: { classList: { toggle: (c, on) => { seen[c] = on; } } }, titleLabel: { value: { updateTitle: t => { seen.label = t; } } },
        });
        ctl.doUpdate(); return seen;
      };
      assert.deepEqual(render(code), { visible: true, label: 'Chat history' });
      assert.deepEqual(render(pristine), { visible: false, label: '' }, 'control: upstream rendered nothing');
      // The label the toolbar creates later reads the same default (measured live: it was empty).
      const provider = between(code, 'actionViewItemProvider:i=>{if(i.id===X2.PICK_AGENT_SESSION_ACTION_ID)', 'hiddenItemStrategy:');
      assert(provider.includes('updateTitle(this.title||X2.DEFAULT_TITLE)'), provider);
      assert(!code.includes('this.title??X2.DEFAULT_TITLE'));
    });

    await t.test('patch and verify reject a moved anchor or a renamed collaborator', () => {
      const fresh = () => { for (const file of files) fs.copyFileSync(path.join(source, file), path.join(root, file)); };
      fresh();
      fs.writeFileSync(path.join(root, wb), pristine.replace('async getIndex(){return this.storeQueue', 'async getIndex(){return  this.storeQueue'));
      let r = run(root); assert.notEqual(r.status, 0); assert.match(r.stderr, /\[history-index\] anchor occurs 0 times/);
      fresh(); fs.writeFileSync(path.join(root, wb), pristine.replace('async function KSn(s){', 'async function KSm(s){'));
      r = run(root); assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[history-names\]/);
      fresh(); r = run(root); assert.equal(r.status, 0, r.stderr);
      fs.writeFileSync(path.join(root, wb), code.replace('shouldRender(){return!0}', 'shouldRender(){return!!this.model?.title}'));
      r = run('--verify', root); assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[history-entry\]/);
      fs.writeFileSync(path.join(root, wb), code.replace('this.storeQueue.queue(()=>this._ezilUseWorkspaceChat(f.folders[0].uri))', 'void 0'));
      r = run('--verify', root); assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[history-root\]/);
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
