// Per-tab Code folder continuity: the build-time editor bridge (patch-folder-bridge.sh).
// Run: node --test worker/code-folder-bridge/folder-bridge.test.cjs   (also discovered by `bun test` in worker/)
//
// Always: the script against a synthetic workbench.js carrying the three exact anchors (count gates, refusal
// without a write, --verify, origin allowlist), and the PATCHED bridge text itself, run in a VM: allowlist,
// source, nonce, version, the mint read from this document's URL, folder / foreign / workspace / empty, the
// top-level no-op, provider identity, a throwing provider, and B3's location.replace.
// With FOLDER_BRIDGE_TEST_ROOT set to an unmodified, locally extracted code-server 4.141.0 lib/vscode (or the
// shipped image's copy), the same script is applied to the real workbench.js and gated, and its bridge is run too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'patch-folder-bridge.sh');
const WB = 'out/vs/code/browser/workbench/workbench.js';
const A_B2 = '(function(){dt.document.getElementById("vscode-startup-fallback")?.remove();';
const FIXTURE = [
  '/*! fixture: the three anchors of code-server 4.141.0 workbench.js, in their own syntactic positions */',
  'var dt=globalThis;class KDo{static create(e){return{workspace:e&&e.ws}}}',
  'function mk(e){return{workspaceProvider:KDo.create(e),x:1}}',
  'function openIt(e,t){if(e?.reuse)return dt.location.href=t,!0;return!1}',
  `${A_B2}})();`,
  '',
].join('\n');
const run = (args, env = {}) => spawnSync('bash', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 4 * 1024 * 1024 });
const tmpRoot = (content) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-folder-bridge-'));
  fs.mkdirSync(path.join(root, path.dirname(WB)), { recursive: true });
  fs.writeFileSync(path.join(root, WB), content);
  return root;
};
const read = (root) => fs.readFileSync(path.join(root, WB), 'utf8');

/** The bridge text exactly as patched, run in a VM with a fake window/location. */
function bridgeFrom(patched) {
  const start = patched.indexOf('globalThis.__ezilFolderBridge=(p=>');
  const end = patched.indexOf(`;${A_B2}`, start);
  assert(start >= 0 && end > start, 'bridge text present right before the bootstrap IIFE');
  const src = patched.slice(start, end + 1);
  return (provider, { framed = true, host = 'aws-8443-guac-a-b-aws.ezil.work', search = '?folder=%2Fworkspace&ezil_mint=MMMMMMMMMMMMMMMMMMMMMM' } = {}) => {
    const listeners = []; const posted = []; const parent = { postMessage: (m, o) => posted.push({ m, o }) };
    const win = { addEventListener: (t, f) => t === 'message' && listeners.push(f) };
    win.parent = framed ? parent : win;
    const ctx = { window: win, location: { host, search }, URLSearchParams, globalThis: null };
    ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(src, ctx);
    const ret = ctx.__ezilFolderBridge(provider);
    return { ret, posted, fire: (ev) => listeners.forEach(f => f(ev)), parent };
  };
}
const N = 'AAAAAAAAAAAAAAAAAAAAAA';
const MINT = 'MMMMMMMMMMMMMMMMMMMMMM';
const fp = (p, authority = 'aws-8443-guac-a-b-aws.ezil.work', scheme = 'vscode-remote') => ({ workspace: { folderUri: { scheme, authority, path: p } } });
const plain = (v) => JSON.parse(JSON.stringify(v));

function bridgeBehaviour(patched, origins = ['https://os-staging.ezil.work']) {
  const bridge = bridgeFrom(patched);
  const ALLOWED = origins[origins.length - 1];
  // framed folder with spaces + Unicode: `ready` to each allowed origin (no data); a hello is answered once, to its origin
  let t = bridge(fp('/workspace/My Project/日本 ü'));
  assert.deepEqual(t.posted.map(p => p.o), origins);
  assert(t.posted.every(p => p.m.type === 'ezil.code.ready' && Object.keys(p.m).length === 2));
  t.posted.length = 0;
  t.fire({ source: t.parent, origin: 'https://os-staging.ezil.work', data: { type: 'ezil.code.hello', v: 1, nonce: N } });
  assert.deepEqual(plain(t.posted), [{ o: 'https://os-staging.ezil.work',
    m: { type: 'ezil.code.folder', v: 1, nonce: N, mint: MINT, kind: 'folder', path: '/workspace/My Project/日本 ü' } }]);
  // a document the person navigated to (Open Folder dropped ezil_mint) reports mint:null; a malformed mint is null
  for (const search of ['?folder=%2Fworkspace%2Fb', '?folder=%2Fw&ezil_mint=bad', `?ezil_mint=${MINT}x`]) {
    const u = bridge(fp('/workspace/b'), { search }); u.posted.length = 0;
    u.fire({ source: u.parent, origin: ALLOWED, data: { type: 'ezil.code.hello', v: 1, nonce: N } });
    assert.equal(u.posted[0].m.mint, null, search);
  }
  // refusals: another origin, another source, a bad nonce, another version, a string payload
  t.posted.length = 0;
  t.fire({ source: t.parent, origin: 'https://evil.example', data: { type: 'ezil.code.hello', v: 1, nonce: N } });
  t.fire({ source: t.parent, origin: `${ALLOWED}.evil.example`, data: { type: 'ezil.code.hello', v: 1, nonce: N } });
  if (!origins.includes('https://os.ezil.work')) t.fire({ source: t.parent, origin: 'https://os.ezil.work', data: { type: 'ezil.code.hello', v: 1, nonce: N } });
  t.fire({ source: {}, origin: ALLOWED, data: { type: 'ezil.code.hello', v: 1, nonce: N } });
  t.fire({ source: t.parent, origin: ALLOWED, data: { type: 'ezil.code.hello', v: 1, nonce: 'short' } });
  t.fire({ source: t.parent, origin: ALLOWED, data: { type: 'ezil.code.hello', v: 2, nonce: N } });
  t.fire({ source: t.parent, origin: ALLOWED, data: '{"type":"ezil.code.hello","v":1}' });
  t.fire({ source: t.parent, origin: ALLOWED, data: null });
  assert.equal(t.posted.length, 0);
  // kinds: foreign authority or scheme, a workspace file, an empty window, an absurdly long path
  const kind = (prov) => { const r = bridge(prov); r.posted.length = 0; r.fire({ source: r.parent, origin: ALLOWED, data: { type: 'ezil.code.hello', v: 1, nonce: N } }); return r.posted[0].m; };
  assert.equal(kind(fp('/workspace', 'other-host')).kind, 'foreign');
  assert.equal(kind(fp('/workspace', 'aws-8443-guac-a-b-aws.ezil.work', 'file')).kind, 'foreign');
  assert.equal(kind(fp('/workspace', 'other-host')).path, undefined);
  assert.equal(kind({ workspace: { workspaceUri: {} } }).kind, 'workspace');
  assert.equal(kind({ workspace: { workspaceUri: {} } }).path, undefined);
  assert.equal(kind({ workspace: undefined }).kind, 'empty');
  assert.equal(kind(fp(`/${'a'.repeat(5000)}`)).kind, 'foreign');
  // top level (not framed): nothing posted, no listener needed, the provider returned unchanged
  const prov = fp('/workspace');
  t = bridge(prov, { framed: false });
  assert.equal(t.posted.length, 0); assert.equal(t.ret, prov);
  // provider identity preserved; a throwing provider never breaks the workbench
  assert.equal(bridge(prov).ret, prov);
  const bad = { get workspace () { throw new Error('x'); } };
  assert.equal(bridge(bad).ret, bad);
}

test('synthetic workbench: patch, gates, refusal without a write, origin allowlist, bridge behaviour, B3', () => {
  const root = tmpRoot(FIXTURE);
  try {
    let r = run([root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run(['--verify', root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const patched = read(root);
    assert(patched.includes('workspaceProvider:globalThis.__ezilFolderBridge(KDo.create(e)),'));
    assert(patched.includes('if(e?.reuse)return dt.location.replace(t),!0;'));
    assert(!patched.includes('dt.location.href=t'));
    assert(patched.trimEnd().endsWith('MIT License. */'), 'modification notice appended');
    assert(!patched.includes('"*")'), 'never a * target');
    bridgeBehaviour(patched);
    // The default allowlist is the staging shell only: the production shell origin gets nothing.
    const st = bridgeFrom(patched)(fp('/workspace'));
    assert.deepEqual(st.posted.map(p => p.o), ['https://os-staging.ezil.work']);
    st.posted.length = 0;
    st.fire({ source: st.parent, origin: 'https://os.ezil.work', data: { type: 'ezil.code.hello', v: 1, nonce: N } });
    assert.equal(st.posted.length, 0);

    // B3: a same-frame open REPLACES the entry (no push); B1: the provider goes through the bridge
    const calls = [];
    const ctx = { location: { replace: (u) => calls.push(['replace', u]) }, document: { getElementById: () => null }, window: null, URLSearchParams };
    Object.defineProperty(ctx.location, 'href', { set: (u) => calls.push(['href', u]) });
    ctx.window = ctx; ctx.window.parent = ctx; ctx.globalThis = ctx;
    vm.createContext(ctx); vm.runInContext(`${patched}\n;globalThis.__t={open:openIt(${JSON.stringify({ reuse: true })},'https://x/?folder=%2Fw'),prov:mk({ws:1})};`, ctx);
    assert.deepEqual(calls, [['replace', 'https://x/?folder=%2Fw']]);
    assert.equal(ctx.__t.open, true);
    assert.deepEqual(plain(ctx.__t.prov), { workspaceProvider: { workspace: 1 }, x: 1 });

    // an already patched file is refused BEFORE any write
    const before = read(root);
    r = run([root]);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[B2-unpatched\]/);
    assert.equal(read(root), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the notice never carries the copilot-chat patch\'s prefix, which it gates to exactly one per file', () => {
  const COPILOT = 'Modified at build time by EZiL';
  const root = tmpRoot(`/* ${COPILOT} (worker/copilot-chat/patch-copilot-chat.sh, see PATCHES.md): fixture. */\n${FIXTURE}`);
  try {
    let r = run([root]); assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run(['--verify', root]); assert.equal(r.status, 0, r.stdout + r.stderr);
    const patched = read(root);
    assert.equal(patched.split(COPILOT).length - 1, 1, `'${COPILOT}' still occurs once after the bridge patch`);
    assert.match(patched.trimEnd().split('\n').pop(), /^\/\* EZiL build-time modification \(worker\/code-folder-bridge\/patch-folder-bridge\.sh\): .* MIT License\. \*\/$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a moved or duplicated anchor fails the build and leaves the file untouched', () => {
  for (const [label, content, id] of [
    ['B1 moved', FIXTURE.replace('workspaceProvider:KDo.create(e),', 'workspaceProvider:KDo.make(e),'), 'B1'],
    ['B3 moved', FIXTURE.replace('dt.location.href=t,!0;', 'dt.location.assign(t),!0;'), 'B3'],
    ['B2 twice', `${FIXTURE}${A_B2}})();\n`, 'B2'],
  ]) {
    const root = tmpRoot(content);
    try {
      const r = run([root]);
      assert.notEqual(r.status, 0, label);
      assert.match(r.stderr, new RegExp(`\\[${id}\\] anchor occurs`), label);
      assert.equal(read(root), content, `${label}: unchanged`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('the shell origin allowlist is validated and embedded as given', () => {
  for (const bad of ['[]', '["http://os.ezil.work"]', '["https://os.ezil.work/x"]', '["https://evil\\"});alert(1)//"]', 'nope', '"https://os.ezil.work"']) {
    const root = tmpRoot(FIXTURE);
    try {
      const r = run([root], { EZIL_SHELL_ORIGINS_JSON: bad });
      assert.notEqual(r.status, 0, bad);
      assert.equal(read(root), FIXTURE, `${bad}: unchanged`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // Empty is unset (the Dockerfile's ARG EZIL_SHELL_ORIGINS_JSON defaults to empty): the staging shell only.
  const empty = tmpRoot(FIXTURE);
  try {
    let r = run([empty], { EZIL_SHELL_ORIGINS_JSON: '' }); assert.equal(r.status, 0, r.stderr);
    r = run(['--verify', empty], { EZIL_SHELL_ORIGINS_JSON: '' }); assert.equal(r.status, 0, r.stderr);
    assert(read(empty).includes('const O=["https://os-staging.ezil.work"];'));
  } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  const root = tmpRoot(FIXTURE);
  try {
    // An explicit list (a production image would add its shell origin this way, once approved).
    const r = run([root], { EZIL_SHELL_ORIGINS_JSON: '["https://os.ezil.work","https://os-staging.ezil.work"]' });
    assert.equal(r.status, 0, r.stderr);
    bridgeBehaviour(read(root), ['https://os.ezil.work', 'https://os-staging.ezil.work']);
    const t = bridgeFrom(read(root))(fp('/workspace'));
    t.posted.length = 0;
    t.fire({ source: t.parent, origin: 'https://os-dev.ezil.work', data: { type: 'ezil.code.hello', v: 1, nonce: N } });
    assert.equal(t.posted.length, 0, 'an origin outside the build-time allowlist gets nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real code-server 4.141.0 workbench (FOLDER_BRIDGE_TEST_ROOT)', () => {
  const source = process.env.FOLDER_BRIDGE_TEST_ROOT;
  if (!source) { console.log('folder-bridge: FOLDER_BRIDGE_TEST_ROOT unset; the real-bundle case did not run'); return; }
  const root = tmpRoot(fs.readFileSync(path.join(source, WB), 'utf8'));
  try {
    let r = run([root]); assert.equal(r.status, 0, r.stdout + r.stderr);
    r = run(['--verify', root]); assert.equal(r.status, 0, r.stdout + r.stderr);
    bridgeBehaviour(read(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
