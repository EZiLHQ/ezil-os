// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/chat-history-patch.test.cjs
// Exercises the PATCHED code-server 4.141.0 ChatSessionStore (extracted from the real
// workbench.js, its collaborators stubbed) against session files on disk, reached
// through the link editor-state.sh creates. Skips without a local pristine bundle.
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
  const names = ['x', 'Kd', 'Ve', 'Wn', 'd', 'I', 'm', 'Ws', 'Lr', 'Se', 'ba', 'pn', 'Ue', 'UNr', 'fa', 'cDe', 'WSn', 'nt', 'p7t', 'L',
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
  ];
  const { Store, HTt, zSn } = new Function(...names, body)(...values);
  return {
    HTt, zSn,
    create(root, { index, listing } = {}) {
      const stored = new Map(index ? [[HTt, JSON.stringify(index)]] : []);
      const calls = { resolve: 0, read: 0, readPaths: [], del: [], logs: [] };
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
        async writeFile() { throw new Error('unexpected write'); },
      };
      const storageService = { get: k => stored.get(k), store: (k, v) => stored.set(k, typeof v === 'string' ? v : JSON.stringify(v)) };
      const store = new Store(
        fileService, { workspaceStorageHome: uri(path.dirname(path.dirname(root))) },
        { info: (...a) => calls.logs.push(['info', ...a]), error: (...a) => calls.logs.push(['error', ...a]), trace() {} },
        { getWorkspace: () => ({ id: path.basename(path.dirname(root)), folders: [{}] }) },
        { publicLog2() {} }, storageService, { onWillShutdown: () => ({}) },
        { defaultProfile: { globalStorageHome: uri('/global') } }, { getValue: () => undefined },
        { onDidEnterWorkspace: () => ({}) }, {}, {},
      );
      assert.equal(store.getChatStorageFolder().path, root, 'storage root is <workspaceStorage>/<id>/chatSessions');
      return { store, stored, calls };
    },
  };
}

// A session log exactly as the store writes it: an initial snapshot, then set/push entries.
const request = (text, timestamp) => ({ requestId: `r${timestamp}`, message: { text, parts: [] }, timestamp, response: [] });
const log = (id, { title, location = 'panel', requests = [request('Fix the login form\nsecond line', 1000)], more = [] } = {}) =>
  [{ kind: 0, v: { version: 3, creationDate: 500, ...(title ? { customTitle: title } : {}), initialLocation: location, responderUsername: 'EZiL Chat', sessionId: id, requests } }, ...more]
    .map(e => JSON.stringify(e)).join('\n') + '\n';

test('EZiL Chat history: patched store lists, prunes and deletes session files in the workspace', { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-chat-history-'));
  try {
    const root = path.join(tmp, 'vscode');
    for (const file of files) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
    for (const args of [[root], ['--verify', root]]) { const r = run(...args); assert.equal(r.status, 0, r.stdout + r.stderr); }
    const pristine = fs.readFileSync(path.join(source, wb), 'utf8');
    const code = fs.readFileSync(path.join(root, wb), 'utf8');
    const h = harness(code);

    await t.test('workspace id matches the bundle hash of vscode-remote://remote<folder>', () => {
      const fn = new Function(between(pristine, 'function YA(s,o){', 'function XMi(s,o){') + 'return s=>o0(s,0).toString(16);')();
      for (const folder of ['/workspace', '/home/neko/project', '/workspace/', '/srv/a-b_c.d~e']) {
        const r = bash('ezil_editor_chat_workspace_ids "$1"', folder);
        assert.equal(r.status, 0, r.stderr);
        assert(r.stdout.trim().split('\n').includes(fn(`vscode-remote://remote${folder}`)), folder);
      }
      // The URI the embedder builds for ?folder=/workspace (workbench.js QUERY_PARAM_FOLDER branch).
      assert(pristine.includes('case s.QUERY_PARAM_FOLDER:o.remoteAuthority&&r.startsWith(Ko.sep)?t={folderUri:L.from({scheme:X.vscodeRemote,path:r,authority:o.remoteAuthority})}'));
      assert(pristine.includes('function QUn(s){return Nr(s.toString()).toString(16)}'));
    });

    // The real link from editor-state.sh, the real patched store behind it.
    const workspace = path.join(tmp, 'workspace'), userData = path.join(tmp, 'user');
    fs.mkdirSync(workspace);
    const prep = bash('export EZIL_HOSTS_FILE="$3"; : >"$3"; ezil_editor_prepare "$1" "$2"', userData, workspace, path.join(tmp, 'hosts'));
    assert.equal(prep.status, 0, prep.stderr);
    const id = bash('ezil_editor_chat_workspace_ids "$1"', workspace).stdout.trim();
    const sessions = path.join(userData, 'User', 'workspaceStorage', id, 'chatSessions');
    const chat = path.join(workspace, '.ezil', 'chat');
    assert.equal(fs.readlinkSync(sessions), chat);
    fs.writeFileSync(path.join(chat, 'a.jsonl'), log('a', { title: 'Named', more: [{ kind: 2, k: ['requests'], v: [request('follow-up', 3000)], i: 1 }] }));
    fs.writeFileSync(path.join(chat, 'b.jsonl'), log('b'));
    fs.writeFileSync(path.join(chat, 'c.json'), JSON.stringify({ version: 3, creationDate: 200, initialLocation: 'panel', responderUsername: 'EZiL Chat', sessionId: 'c', requests: [request('flat legacy file', 2000)] }));
    fs.writeFileSync(path.join(chat, 'empty.jsonl'), log('empty', { requests: [] }));
    fs.writeFileSync(path.join(chat, 'bad.jsonl'), 'not json\n');
    fs.writeFileSync(path.join(chat, 'mismatch.jsonl'), log('someone-else'));
    fs.mkdirSync(path.join(chat, 'dir.jsonl'));

    await t.test('a missing index (new browser, new origin, CF restart, move) is rebuilt from the files', async () => {
      const { store, stored, calls } = h.create(sessions);
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
      const { store, calls } = h.create(sessions, { index });
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
      const { store } = h.create(sessions, { index: { version: 1, entries: { gone: known } }, listing: () => { if (fail) throw new Error('connection lost'); return { children: [] }; } });
      assert.deepEqual(Object.keys(await store.getIndex()), ['gone']);
      fail = false;
      assert.deepEqual(Object.keys(await store.getIndex()), [], 'retried on the next read');
      const missing = h.create(path.join(tmp, 'nowhere', 'x', 'chatSessions'), { index: { version: 1, entries: { gone: known } } });
      assert.deepEqual(Object.keys(await missing.store.getIndex()), ['gone']);
      await missing.store.getIndex();
      assert.equal(missing.calls.resolve, 1, 'not-found is final for the window');
    });

    await t.test('the 400-entry cap holds: older files than a full index are not read back', async () => {
      const entries = {};
      for (let i = 0; i < h.zSn; i++) entries[`n${i}`] = { sessionId: `n${i}`, title: 't', lastMessageDate: Date.now() + 1e6 + i, initialLocation: 'panel', isEmpty: false, isExternal: false };
      const listing = () => ({ children: [...Object.keys(entries).map(k => ({ name: `${k}.jsonl`, isDirectory: false, mtime: entries[k].lastMessageDate })), { name: 'old.jsonl', isDirectory: false, mtime: 1 }] });
      const { store, calls } = h.create(sessions, { index: { version: 1, entries }, listing });
      assert.equal(Object.keys(await store.getIndex()).length, h.zSn);
      assert.equal(calls.read, 0);
    });

    await t.test('deleting in the editor removes the only copy, and it does not come back', async () => {
      const { store, calls } = h.create(sessions);
      await store.getIndex();
      await store.deleteSession('b');
      assert(calls.del.some(p => p.endsWith('/b.jsonl')));
      assert(!fs.existsSync(path.join(chat, 'b.jsonl')));
      const again = h.create(sessions);
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
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
