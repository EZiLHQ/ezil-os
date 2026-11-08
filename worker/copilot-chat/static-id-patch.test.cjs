// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/static-id-patch.test.cjs
// Applies patch-copilot-chat.sh to copies of the pinned code-server 4.141.0 bundle and checks the static asset
// identity (PATCHES.md "static-id"): code-server serves /<quality>-<commit>/static/* for a year without
// revalidation, so two images whose served workbench files differ must not share a static URL.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFile } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const css = 'out/vs/code/browser/workbench/workbench.css';
const nls = 'out/nls.messages.js';
const server = 'out/server-main.js';
const pre = 'out/vs/workbench/contrib/webview/browser/pre/index.html';
// package.json is lib/vscode's own ("type": "module"): server-main.js is parsed in the context code-server loads it in.
const files = ['package.json', 'extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', nls, 'out/nls.messages.json', wb, css, server, pre];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const runAsync = (...args) => new Promise(resolve => execFile('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ status: err ? err.code : 0, stdout, stderr })));
const ROUTE = 'o.startsWith(IE)&&o.charCodeAt(IE.length)===47?this._handleStatic(t,e,o.substring(IE.length))';
const BASE = 'let I=Be.join(l,this._productPath,IE),';
const PAGE = 'WORKBENCH_WEB_BASE_URL:I,';
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
  const clone = src => { const root = path.join(tmp, String(n++)); fs.cpSync(src, root, { recursive: true }); return root; };
  const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
  const append = (root, file, text) => fs.appendFileSync(path.join(root, file), text);
  // Same-length edit: `from` occurs once (or ends the file) and becomes `to`, so a size-only hash cannot see it.
  const sameLength = (file, from, to, atEnd = false) => root => {
    const p = path.join(root, file), b = fs.readFileSync(p), f = Buffer.from(from), i = atEnd ? b.length - f.length : b.indexOf(f);
    assert.equal(Buffer.byteLength(to), f.length);
    assert(i >= 0 && b.subarray(i, i + f.length).equals(f) && (atEnd || b.indexOf(f, i + 1) < 0), `${file}: ${JSON.stringify(from)}`);
    fs.writeFileSync(p, Buffer.concat([b.subarray(0, i), Buffer.from(to), b.subarray(i + f.length)]));
  };
  const idOf = root => { const m = [...read(root, server).matchAll(/IE="\/static\/(ezil-[0-9a-f]{20})",Vq="\/callback"/g)]; assert.equal(m.length, 1); return m[0][1]; };
  const patched = before => { const root = copy(before); const r = run(root); assert.equal(r.status, 0, r.stdout + r.stderr); return root; };
  try {
    const base = patched();
    const id = idOf(base);

    await t.test('the route constant is replaced once; the page base, router and webview endpoint all use it', () => {
      const code = read(base, server);
      assert(!code.includes('IE="/static",'));
      for (const p of [ROUTE, BASE, PAGE, WEBVIEW]) assert.equal(code.split(p).length, 2, p);
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

    // One copy of the verified tree per late edit: every class of served file, same-length changes included.
    await t.test('verify rejects any served file changed or added after the id was computed', async () => {
      const late = [
        ['an unchanged copy (control)', () => {}],
        ['workbench.js, same length', sameLength(wb, '\n', ' ', true)],
        ['workbench.css, same length', sameLength(css, '\n', ' ', true)],
        ['nls.messages.js, same length', sameLength(nls, ';', ' ', true)],
        ['nls.messages.json', root => append(root, 'out/nls.messages.json', '\n')],
        ['webview pre/index.html (never patched), same length', sameLength(pre, '</html>\n', '</HTML>\n', true)],
        ['a new file', root => fs.writeFileSync(path.join(root, 'out/vs/new.js'), '1')],
        ['a new dotfile', root => fs.writeFileSync(path.join(root, 'out/.new'), '1')],
        ['a new symlink', root => fs.symlinkSync('vs', path.join(root, 'out/new-link'))],
      ];
      const results = await Promise.all(late.map(([, edit]) => { const root = clone(base); edit(root); return runAsync('--verify', root); }));
      late.forEach(([what], i) => {
        const r = results[i];
        if (i === 0) { assert.equal(r.status, 0, what + '\n' + r.stderr); return; }
        assert.notEqual(r.status, 0, what); assert.match(r.stderr, /GATE FAILED \[static-id\]/, what);
      });
    });

    await t.test('a server-main.js that does not parse fails the script, patching and verifying', async () => {
      assert.equal(JSON.parse(read(base, 'package.json')).type, 'module');
      const broken = '\nvar ezilBroken=(;\n';
      const fresh = copy(root => append(root, server, broken));
      const late = clone(base); append(late, server, broken);
      for (const r of await Promise.all([runAsync(fresh), runAsync('--verify', late)])) {
        assert.notEqual(r.status, 0, r.stdout); assert.match(r.stderr, /SyntaxError/); assert(!r.stdout.includes('all gates passed'));
      }
    });

    // server-main.js is not hashed, so only static-names sees these; --verify is the mode the image build re-runs.
    await t.test('verify rejects a server whose router, page base, page or webview endpoint stops using the constant', async () => {
      const edits = [[ROUTE, '===47?', '===47 ?'], [BASE, 'I=', 'I= '], [PAGE, ':I', ': I'], [WEBVIEW, ':I', ': I']];
      const results = await Promise.all(edits.map(([p, from, to]) => {
        const root = clone(base);
        fs.writeFileSync(path.join(root, server), read(root, server).replace(p, () => p.replace(from, to)));
        return runAsync('--verify', root);
      }));
      results.forEach((r, i) => { assert.notEqual(r.status, 0, edits[i][0]); assert.match(r.stderr, /GATE FAILED \[static-names\]/, edits[i][0]); });
    });

    await t.test('patch rejects a moved route constant or a base that no longer uses it', () => {
      let r = run(copy(root => fs.writeFileSync(path.join(root, server), read(root, server).replace('IE="/static",Vq="/callback"', 'IE="/static",Vq="/cb"'))));
      assert.notEqual(r.status, 0); assert.match(r.stderr, /\[static-id\] anchor occurs 0 times/);
      r = run(copy(root => fs.writeFileSync(path.join(root, server), read(root, server).replace(WEBVIEW, 'webviewEndpoint:"/static/out/vs/workbench/contrib/webview/browser/pre"'))));
      assert.notEqual(r.status, 0); assert.match(r.stderr, /GATE FAILED \[static-names\]/);
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
