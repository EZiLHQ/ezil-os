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
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb, 'out/vs/code/browser/workbench/workbench.css', 'out/server-main.js'];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const between = (code, start, end) => {
  const i = code.indexOf(start); assert(i >= 0, `missing ${start.slice(0, 40)}`);
  const j = code.indexOf(end, i); assert(j > i, `missing ${end.slice(0, 40)}`);
  return code.slice(i, j);
};

function restoreRequest(code, raw, local = true) {
  const method = between(code, '_deserializeRequest(e){', 'reviveVariableData(e){');
  const deserialize = new Function('yH', 'v2o', 'A4i', 'h8o', 'Yi', 'oUe', 'Ws',
    'return ({' + method + '})._deserializeRequest;')(
    class { constructor(opts) { Object.assign(this, opts, { id: opts.restoredId, shouldBeBlocked: { get: () => false } }); } },
    value => value, () => undefined, value => value, (part, fields) => Object.keys(fields).every(key => key in part),
    class { constructor(opts) { Object.assign(this, opts); } },
    { parseLocalSessionId: () => local ? 'local-session' : undefined },
  );
  return deserialize.call({ reviveVariableData: () => ({ variables: [] }) }, raw);
}

function renderedErrors(code, response) {
  const expression = between(code, 'e.model.response===e.model.entireResponse&&(!e.isCanceled', ';let a=this.getChatFileChangesSummaryPart(e)');
  const errors = [];
  const content = response.responseContent;
  new Function('e', 'n', 'O$', 'QGi', expression).call({}, {
    isCanceled: response.modelState.value === 2,
    errorDetails: response.result?.errorDetails,
    model: { response: content, entireResponse: content },
  }, errors, 'Canceled', () => undefined);
  return errors.map(error => error.errorDetails);
}
// A fixed stdin script, never a caller-supplied command string: editor-state.sh is sourced from $1 and the
// remaining paths stay positional arguments, so spaces, quotes and $(...) in them are never evaluated.
const PREPARE_EDITOR = 'set -euo pipefail\n. "$1"\nshift\nexport EZIL_HOSTS_FILE="$3"; : >"$3"; ezil_editor_prepare "$1" "$2"\n';
const prepareEditor = (userData, workspace, hostsFile, cwd) =>
  spawnSync('bash', ['-s', '--', editorState, userData, workspace, hostsFile], { encoding: 'utf8', input: PREPARE_EDITOR, cwd });

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
  const localStat = p => {
    const st = fs.lstatSync(p);
    return { isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), isFile: st.isFile(), mtime: st.mtimeMs };
  };
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
          return { children: names.map(name => ({ name, ...localStat(path.join(fsPath(u), name)) })) };
        },
        async readFile(u) { calls.read++; calls.readPaths.push(u.path); try { return { value: new Ue(fs.readFileSync(fsPath(u))) }; } catch { throw notFound(); } },
        async del(u) { calls.del.push(u.path); try { fs.unlinkSync(fsPath(u)); } catch { throw notFound(); } },
        async exists(u) { return fs.existsSync(fsPath(u)); },
        async stat(u) {
          calls.stat++;
          if (stat) return stat(u, calls.stat);
          try { return localStat(fsPath(u)); } catch { throw notFound(); }
        },
        async createFolder(u) {
          fs.mkdirSync(fsPath(u), { recursive: true });
          return localStat(fsPath(u));
        },
        async move(source, target, overwrite) {
          assert.equal(overwrite, false);
          if (!fs.existsSync(fsPath(source))) throw notFound();
          assert(!fs.existsSync(fsPath(target)), 'must not overwrite a migrated file');
          fs.renameSync(fsPath(source), fsPath(target));
        },
        async createFile(u, contents, { overwrite }) {
          assert.equal(overwrite, false);
          fs.writeFileSync(fsPath(u), contents.toString(), { flag: 'wx' });
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
    const prep = prepareEditor(userData, workspace, path.join(tmp, 'hosts'));
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

    await t.test('managed Git history uses one durable repository scope and recovers only that profile', async () => {
      const ids = ['8b70ec91-3fcc-4efa-834c-c2bf44c45ca3', '96ab99e4-a6ed-4d53-94eb-5fd65ded182f'];
      const folders = ids.map(id => path.join(workspace, 'projects', id));
      for (const folder of folders) fs.mkdirSync(path.join(folder, 'checkout'), { recursive: true });
      const legacy = path.join(wsHome, '31384936', 'chatSessions');
      const foreign = path.join(wsHome, 'abcdef', 'chatSessions');
      fs.mkdirSync(legacy, { recursive: true });
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(legacy, 'old-turn.jsonl'), log('old-turn', { title: 'Saved turn before upgrade' }));
      fs.writeFileSync(path.join(foreign, 'foreign-turn.jsonl'), log('foreign-turn', { title: 'A different project session' }));

      const first = h.create({ folder: folders[0], wsHome, id: '31384936' });
      const scoped = path.join(workspace, '.ezil', 'repo-chat', ids[0]);
      assert.equal(await first.ready(), scoped);
      assert.equal((await first.store.getIndex())['old-turn'].title, 'Saved turn before upgrade');
      assert.equal(fs.existsSync(path.join(legacy, 'old-turn.jsonl')), false);
      assert.equal(fs.existsSync(path.join(foreign, 'foreign-turn.jsonl')), true);
      assert.deepEqual(fs.readdirSync(folders[0]), ['checkout']);

      const reloaded = h.create({ folder: folders[0], wsHome, id: '-2ec3769a' });
      const other = h.create({ folder: folders[1], wsHome, id: 'f' });
      assert.equal(await reloaded.ready(), scoped);
      assert.equal((await reloaded.store.getIndex())['old-turn'].title, 'Saved turn before upgrade');
      assert.deepEqual(Object.keys(await other.store.getIndex()), []);
      assert.equal((await make().store.getIndex())['old-turn'], undefined);

      fs.writeFileSync(path.join(legacy, 'old-turn.json'), log('old-turn', { title: 'Conflicting profile copy' }));
      const conflict = h.create({ folder: folders[0], wsHome, id: '31384936' });
      assert.equal((await conflict.store.getIndex())['old-turn'].title, 'Saved turn before upgrade');
      assert.equal(fs.readFileSync(path.join(scoped, '.legacy-31384936', 'old-turn.json'), 'utf8'),
        log('old-turn', { title: 'Conflicting profile copy' }));

      fs.writeFileSync(path.join(legacy, 'old-turn.json'), log('old-turn', { title: 'Second conflicting profile copy' }));
      const repeated = h.create({ folder: folders[0], wsHome, id: '31384936' });
      assert.equal(await repeated.ready(), scoped);
      assert.equal((await repeated.store.getIndex())['old-turn'].title, 'Saved turn before upgrade');
      assert.equal(fs.readdirSync(path.join(scoped, '.legacy-31384936')).length, 2);

      const blocked = path.join(workspace, '.ezil', 'repo-chat', ids[1]);
      fs.rmdirSync(blocked);
      fs.symlinkSync(scoped, blocked);
      const fallback = h.create({ folder: folders[1], wsHome, id: 'abc91' });
      const profilePath = path.join(wsHome, 'abc91');
      assert.equal(await fallback.ready(), path.join(profilePath, 'chatSessions'));
      const marker = JSON.parse(fs.readFileSync(path.join(profilePath, 'ezil-repository-chat.json'), 'utf8'));
      assert.equal(marker.folder, 'vscode-remote://remote' + folders[1]);
    });

    await t.test('a lookalike project outside a managed workspace keeps profile storage', async () => {
      const folder = path.join(tmp, 'other-enclosing', 'projects', '8b70ec91-3fcc-4efa-834c-c2bf44c45ca3');
      fs.mkdirSync(folder, { recursive: true });
      const legacy = h.create({ folder, wsHome, id: 'plain' });
      assert.equal(await legacy.ready(), path.join(wsHome, 'plain', 'chatSessions'));
      assert.equal(fs.existsSync(path.join(tmp, 'other-enclosing', '.ezil')), false);
    });

    await t.test('a transient error is retried; a lasting one keeps upstream and is logged as an error', async () => {
      const flaky = make({ stat: (u, n) => { if (n < 3) throw new Error('remote not connected'); return { isDirectory: true }; } });
      assert.equal(await flaky.ready(), chat);
      assert.equal(flaky.calls.stat, 4);
      const down = make({ id: 'down', stat: () => { throw new Error('remote not connected'); } });
      assert.equal(await down.ready(), path.join(wsHome, 'down', 'chatSessions'));
      assert.equal(down.calls.stat, 6);
      assert(down.calls.logs.some(l => l[0] === 'error' && /unreadable/.test(l[1])));
    });

    await t.test('restoring a pending JSON turn keeps the prompt and shows an interruption without replay', async () => {
      const prompt = 'Fix the login form with the nonstreaming model';
      const original = { ...request(prompt, 1000), modelId: 'ezil:us.moonshotai.kimi-k3', modelState: { value: 0 } };
      const file = path.join(chat, 'pending-kimi.jsonl');
      fs.writeFileSync(file, log('pending-kimi', { requests: [original] }));
      try {
        const { store } = make();
        const saved = await store.readSession('pending-kimi');
        assert.deepEqual(saved.value.requests, [original]);
        const recovered = restoreRequest(code, saved.value.requests[0]);
        assert.equal(recovered.message.text, prompt);
        assert.deepEqual(recovered.response.responseContent, []);
        assert.equal(recovered.response.modelState.value, 2);
        const warning = {
          code: 'ezil_turn_interrupted',
          message: 'This response was interrupted before it finished. Review any changes before retrying.',
        };
        assert.deepEqual(renderedErrors(code, recovered.response), [warning]);

        const partial = [{ kind: 'markdownContent', content: { value: 'I made one change.' } }];
        const needsInput = restoreRequest(code, { ...original, response: partial, modelState: { value: 4 } });
        assert.deepEqual(needsInput.response.responseContent, partial);
        assert.deepEqual(renderedErrors(code, needsInput.response), [warning]);
        const reopenedAgain = restoreRequest(code, {
          ...original, modelState: recovered.response.modelState, result: recovered.response.result,
        });
        assert.deepEqual(renderedErrors(code, reopenedAgain.response), [warning]);
        for (const state of [1, 2]) {
          const settled = restoreRequest(code, { ...original, modelState: { value: state, completedAt: 2000 } });
          assert.equal(settled.response.modelState.value, state);
          assert.deepEqual(renderedErrors(code, settled.response), []);
        }
        assert.deepEqual(renderedErrors(code, restoreRequest(code, original, false).response), []);
        const existing = { code: 'other_error', message: 'Prior provider error' };
        const priorError = restoreRequest(code, { ...original, result: { errorDetails: existing } });
        assert.deepEqual(priorError.response.result?.errorDetails, existing);
      } finally {
        fs.unlinkSync(file);
      }
    });

    await t.test('auto-approve and Autopilot progress describe scheduled retries without claiming success', () => {
      const extension = fs.readFileSync(path.join(root, 'extensions/copilot/dist/extension.js'), 'utf8');
      assert.doesNotMatch(extension, /(?:Autopilot )?[Rr]ecovered from a request error/);
      const progress = between(extension,
        'this.options.request.permissionLevel==="autopilot"?this.showAutopilotProgress(n,wl.t("Autopilot: request failed. Retrying',
        ',await Li(1e3,r);continue}');
      const runProgress = new Function('n', 'wl', 'return ' + progress);
      for (const [permissionLevel, pending, scheduled] of [
        ['autoApprove', 'Request failed. Retrying…', 'Retry scheduled after a request error'],
        ['autopilot', 'Autopilot: request failed. Retrying…', 'Autopilot scheduled a retry after a request error'],
      ]) {
        const output = Symbol('progress stream');
        const context = { options: { request: { permissionLevel } }, showAutopilotProgress: (...args) => args };
        assert.deepEqual(runProgress.call(context, output, { t: value => value }), [output, pending, scheduled]);
      }
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

    await t.test('the picker resolves local history before it lists', async () => {
      const picker = src => new Function('A', 'y6', 'cn', 'd', `return class { ${between(src, 'async pickAgentSession(){', 'createPickerItems(o){')} }`)(
        class { add(v) { return v; } dispose() {} }, class {}, { Local: 'local' }, () => 'placeholder');
      const order = async src => {
        const seen = []; let sessions = [];
        const P = picker(src); const p = Object.assign(new P(), {
          anchor: undefined, options: undefined,
          agentSessionsService: { model: { resolve: async type => { seen.push('resolve:' + type); await new Promise(r => setImmediate(r)); sessions = ['s1']; } } },
          quickInputService: { createQuickPick: () => ({ set items(v) { seen.push('items:' + v.length); }, onDidAccept: () => ({}), onDidTriggerItemButton: () => ({}), onDidHide: () => ({}), show: () => seen.push('show') }) },
          instantiationService: { createInstance: () => ({}) }, createPickerItems: () => sessions.slice(),
        });
        await p.pickAgentSession(); return seen;
      };
      assert.deepEqual(await order(code), ['resolve:local', 'items:1', 'show']);
      assert.deepEqual(await order(pristine), ['items:0', 'show'], 'control: upstream listed the unresolved snapshot');
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

// Runs without a pristine bundle: it exercises only editor-state.sh through the prepareEditor harness.
test('editor-state receives paths with spaces, quotes and $() literally; the harness never evaluates them', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-chat-literal-'));
  try {
    // A workspace path carrying every shell hazard: a space, single and double quotes, and a command
    // substitution. `injected` is a bare name; were $(...) ever evaluated, touch would drop it in cwd (tmp).
    const workspace = path.join(tmp, `ws $(touch injected) 'q" end`);
    fs.mkdirSync(workspace);
    const prep = prepareEditor(path.join(tmp, 'user'), workspace, path.join(tmp, 'hosts'), tmp);
    assert.equal(prep.status, 0, prep.stderr);
    assert(!fs.existsSync(path.join(tmp, 'injected')), 'the $(...) in the path must never run');
    assert(fs.statSync(path.join(workspace, '.ezil', 'chat')).isDirectory(), 'the literal path reached ezil_editor_prepare');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
