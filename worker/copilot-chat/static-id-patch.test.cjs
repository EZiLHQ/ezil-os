// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/static-id-patch.test.cjs
// Applies patch-copilot-chat.sh to copies of the pinned code-server 4.141.0 bundle and checks the static asset
// identity (PATCHES.md "static-id"): code-server serves /<quality>-<commit>/static/* for a year without
// revalidation, so two images whose served workbench files differ must not share a static URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const css = 'out/vs/code/browser/workbench/workbench.css';
const server = 'out/server-main.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb, css, server];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const ROUTE = 'o.startsWith(IE)&&o.charCodeAt(IE.length)===47?this._handleStatic(t,e,o.substring(IE.length))';
const WEBVIEW = 'webviewEndpoint:I+"/out/vs/workbench/contrib/webview/browser/pre"';

test('workbench static path carries a content id', { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-static-id-'));
  let n = 0;
  // A copy of the pinned files, optionally changed before patching (a different image's bytes).
  const copy = (before = () => {}) => {
    const root = path.join(tmp, String(n++));
    for (const file of files) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
    before(root);
    return root;
  };
  const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
  const append = (root, file, text) => fs.appendFileSync(path.join(root, file), text);
  const idOf = root => { const m = [...read(root, server).matchAll(/IE="\/static\/(ezil-[0-9a-f]{20})",Vq="\/callback"/g)]; assert.equal(m.length, 1); return m[0][1]; };
  const patched = before => { const root = copy(before); const r = run(root); assert.equal(r.status, 0, r.stdout + r.stderr); return root; };
  try {
    const base = patched();
    const id = idOf(base);

    await t.test('the route constant is replaced once; the page base, router and webview endpoint all use it', () => {
      const code = read(base, server);
      assert(!code.includes('IE="/static",'));
      for (const p of [ROUTE, 'let I=Be.join(l,this._productPath,IE),', 'WORKBENCH_WEB_BASE_URL:I,', WEBVIEW]) assert.equal(code.split(p).length, 2, p);
      assert(code.startsWith('/* Modified at build time by EZiL'));
      const IE = `/static/${id}`;
      const route = new Function('IE', 'o', `return ${ROUTE.replace(/this\._handleStatic\(t,e,(.*)\)$/, '$1')}:null`);
      // The base the server writes into the page, then the router: new URLs map to the same files, old ones 404.
      const I = path.posix.join('/', '/stable-8b41915d25547e2edd553bab03ea4cbd621f98c5', IE);
      assert.equal(I, `/stable-8b41915d25547e2edd553bab03ea4cbd621f98c5/static/${id}`);
      assert.equal(route(IE, `${IE}/out/vs/code/browser/workbench/workbench.js`), '/out/vs/code/browser/workbench/workbench.js');
      assert.equal(route(IE, `${IE}/out/vs/workbench/contrib/webview/browser/pre/index.html`), '/out/vs/workbench/contrib/webview/browser/pre/index.html');
      assert.equal(route(IE, '/static/out/vs/code/browser/workbench/workbench.js'), null);
      assert.equal(route(IE, `${IE}x/out/vs/code/browser/workbench/workbench.css`), null);
    });

    await t.test('the same bytes give the same id', () => assert.equal(idOf(patched()), id));

    await t.test('different workbench.css, workbench.js or any other served file gives a different id', () => {
      const ids = [
        idOf(patched(root => append(root, css, '\n.x{}'))),
        idOf(patched(root => append(root, wb, '\n;'))),
        idOf(patched(root => { fs.mkdirSync(path.join(root, 'node_modules/x'), { recursive: true }); fs.writeFileSync(path.join(root, 'node_modules/x/a.js'), '1'); })),
      ];
      assert.equal(new Set([id, ...ids]).size, 4, JSON.stringify([id, ...ids]));
    });

    await t.test('later Dockerfile steps (product.json switch, built-in extension) keep the id valid', () => {
      const product = path.join(base, 'product.json');
      const j = JSON.parse(fs.readFileSync(product, 'utf8')); j.enableTelemetry = false; fs.writeFileSync(product, JSON.stringify(j, null, '\t'));
      fs.mkdirSync(path.join(base, 'extensions/ezil.ezil-models/dist'), { recursive: true });
      fs.writeFileSync(path.join(base, 'extensions/ezil.ezil-models/dist/extension.js'), '0');
      const r = run('--verify', base); assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /gate ok \[static-id\] server-main\.js x1/);
    });

    await t.test('verify rejects a served file edited after the id was computed', () => {
      append(base, css, '\n.late{}');
      const r = run('--verify', base); assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[static-id\]/);
    });

    await t.test('patch rejects a moved route constant or a base that no longer uses it', () => {
      let r = run(copy(root => fs.writeFileSync(path.join(root, server), read(root, server).replace('IE="/static",Vq="/callback"', 'IE="/static",Vq="/cb"'))));
      assert.notEqual(r.status, 0); assert.match(r.stderr, /\[static-id\] anchor occurs 0 times/);
      r = run(copy(root => fs.writeFileSync(path.join(root, server), read(root, server).replace(WEBVIEW, 'webviewEndpoint:"/static/out/vs/workbench/contrib/webview/browser/pre"'))));
      assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[static-names\]/);
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
