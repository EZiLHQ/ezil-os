// code-history-browser-test.mjs — EZiL-authored. REAL-BROWSER test of Code's folder in the address bar
// (folder-url-sync, docs/APP-ROUTES.md §2 and §5 "Code's folder") and of how the editor frame lives through shell
// history, with unsaved work as the rule: the shell never tears a live editor down by itself, and every replacement
// of an editor document goes through that document's own `beforeunload` (code-server's unsaved-work veto).
//
// Run:  node shell/ezil/apps/code-history-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle; or point EZIL_SHELL_OUT_DIR at a build)
// Requires `playwright` (here or under $PLAYWRIGHT_REQUIRE_DIR); exits 2 (skip) without it.
//
// The real shell bundle (router, Code window, folder bridge) runs at one origin; a fake editor runs at ANOTHER
// origin. Each editor document carries the REAL bridge the Worker injects (worker/src/code-folder-bridge.ts,
// imported here, byte for byte the Worker's script) and behaves like VS Code where it matters: its Open Folder,
// Open Recent, Close Folder and workspace opens PUSH a same-path document (`location.href = …`), exactly as
// code-server's workspace provider does. The fake mint answers like the Worker: a folder it walked (`existing`)
// opens, anything else gets the provider default and an outcome code. Each editor document reports `beforeunload`
// and `pagehide` to its own server (sendBeacon), so the test sees whether a document was navigated away (its veto
// ran) or removed (it did not).
//
//   link        /app/code?folder=A opens A (the mint asked for A, over a stale tab record); spaces and Unicode.
//   switch      Open Folder B inside Code: the address becomes ?folder=B with ONE new entry; the editor loads once.
//   back/fwd    Back restores ?folder=A AND the editor at A; Forward restores B (this was F2, an expected failure
//               before: it now passes).
//   reload      reload at B asks the mint for B.
//   reconnect   a restart re-mints at B, navigating the live frame (never removing it).
//   close       Close Folder: bare /app/code, its own entry; Back returns to the folder.
//   multi-root  a workspace: bare /app/code; never named in the address.
//   nested      creating folders inside the root navigates nothing: no entry, same address.
//   invalid     an escaping link folder is dropped with a notice; the address then follows the editor.
//   missing     a folder the server cannot open: the default opens with a notice, the address keeps the ask.
//   repo        a folder beside a repository is refused (repository opens; no own-files ask).
//   unsaved     a dirty editor's veto ("Stay") stops a Back: address and editor stay together; "Leave" proceeds.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIP playwright not resolvable (set PLAYWRIGHT_REQUIRE_DIR)'); process.exit(2); }
const assets = process.env.EZIL_SHELL_OUT_DIR || fileURLToPath(new URL('../../../app/public/os/', import.meta.url));
if ( ! existsSync(path.join(assets, 'bundle.min.js')) ) { console.log(`SKIP missing ${assets}bundle.min.js (run shell/build-shell.sh)`); process.exit(2); }
// The Worker's own bridge (TypeScript; Node strips the types).
const { codeFolderBridgeScript } = await import('../../../worker/src/code-folder-bridge.ts');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; console.log(`PASS  ${msg}`); };

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const DEFAULT = '/workspace';
/** Folders the fake computer has (the Worker's walk answers `restored` for these, `missing` for any other). */
const existing = new Set(['/workspace', '/workspace/a', '/workspace/b', '/workspace/c', '/workspace/my site/日本']);
let mints = 0;
const asks = []; // every mint body's codeFolder / repository, in order
const docs = []; // every editor document the browser loaded, by query, in order (its index is its id)
const events = []; // [{ e: 'beforeunload' | 'pagehide', doc }] the documents reported about themselves
let shellOrigin = '';
let editorOrigin = '';
const shell = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if ( url.pathname.startsWith('/os/') ) {
        const file = path.join(assets, url.pathname.slice('/os/'.length));
        if ( file.startsWith(path.join(assets, path.sep)) && existsSync(file) && statSync(file).isFile() ) {
            res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream'); res.end(readFileSync(file)); return;
        }
        res.statusCode = 404; res.end(); return;
    }
    if ( url.pathname === '/favicon.ico' ) { res.statusCode = 204; res.end(); return; }
    if ( url.pathname === '/api/shell/code-preview-url' ) {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            mints += 1;
            const body = JSON.parse(raw || '{}');
            asks.push({ codeFolder: body.codeFolder, repository: body.repository });
            if ( body.repository ) {
                // As the server for a repository address: its checkout folder, never the asked one.
                const repoFolder = '/workspace/projects/0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
                return json({ ok: true, codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=T${mints}&path=%2F&folder=${encodeURIComponent(repoFolder)}`,
                    repository: { name: 'octocat/Hello-World', id: '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e' } });
            }
            const asked = body.codeFolder?.path;
            const restored = asked && existing.has(asked);
            const folder = restored ? asked : DEFAULT;
            return json({ ok: true, codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=T${mints}&path=%2F&folder=${encodeURIComponent(folder)}`,
                ...(asked ? { codeFolder: { v: 1, outcome: restored ? 'restored' : 'missing' } } : {}) });
        });
        return;
    }
    if ( url.pathname === '/api/shell/desktop' ) {
        if ( url.searchParams.get('confirm') === 'frame' ) return json({ ok: true, confirmed: true, status: 200 });
        return json(req.method === 'POST' ? { ok: true, guacamoleUrl: `${shellOrigin}/blank`, frame: { confirmed: true } } : { ok: true, guacamoleRunning: true });
    }
    if ( url.pathname.startsWith('/api/trpc/') ) return json({ result: { data: { json: null } } });
    if ( url.pathname.startsWith('/api/') ) return json({ ok: true });
    if ( url.pathname === '/blank' ) { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>'); return; }
    if ( url.pathname !== '/os' && ! /^\/app\/[a-z0-9-]+$/.test(url.pathname) ) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
});
// The editor: the Worker's bridge, then VS Code's own behaviour where it matters (a folder switch PUSHES).
const editorHtml = (doc) => `<!doctype html><html><head><script>${codeFolderBridgeScript([shellOrigin])}</script></head><body><pre id="doc"></pre><script>
document.getElementById('doc').textContent = location.search;
const DOC = ${doc};
let dirty = false;
addEventListener('beforeunload', (e) => {
  navigator.sendBeacon('/event?e=beforeunload&doc=' + DOC);
  if ( dirty ) { e.preventDefault(); e.returnValue = ''; } // code-server's veto while a backup is pending
});
addEventListener('pagehide', () => navigator.sendBeacon('/event?e=pagehide&doc=' + DOC));
const go = (q) => { location.href = location.pathname + q; }; // VS Code: workspaceProvider.open, same window
window.openFolder = (p) => go('?folder=' + encodeURIComponent(p).replaceAll('%2F', '/'));
window.closeFolder = () => go('?ew=true');
window.openWorkspace = (p) => go('?workspace=' + encodeURIComponent(p));
window.makeDirty = () => { dirty = true; };
</script></body></html>`;
const editor = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if ( url.pathname === '/preview-bootstrap' ) {
        // As the Worker: the first document, with this mint's id and the folder the mint chose.
        const to = new URLSearchParams();
        if ( url.searchParams.get('folder') ) to.set('folder', url.searchParams.get('folder'));
        const mint = url.searchParams.get('ezil_mint'); if ( mint ) to.set('ezil_mint', mint);
        res.statusCode = 302; res.setHeader('location', `/?${to}`); res.end(); return;
    }
    if ( url.pathname === '/' ) {
        // Every editor document is one request here (no-store: a history reload cannot come from a cache).
        docs.push(url.search);
        res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store');
        res.end(editorHtml(docs.length - 1)); return;
    }
    if ( url.pathname === '/event' ) { events.push({ e: url.searchParams.get('e'), doc: Number(url.searchParams.get('doc')) }); res.statusCode = 204; res.end(); return; }
    res.statusCode = 404; res.end();
});
await new Promise(r => shell.listen(0, '127.0.0.1', r));
await new Promise(r => editor.listen(0, '127.0.0.1', r));
shellOrigin = `http://127.0.0.1:${shell.address().port}`;
editorOrigin = `http://localhost:${editor.address().port}`; // another origin, as the code host is

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const computerId = '11111111-1111-4111-8111-111111111111';
const userId = '33333333-3333-4333-8333-333333333333';
const errors = [];

async function tab (start = '/os', { record } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(({ computerId, userId, record }) => {
        window.__EZIL_BOOT__ = { user: { id: userId, email: 'fixture@example.test' },
            computer: { id: computerId, name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }],
            desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', ui: { floatingControls: false, feedbackScreenshots: false } } };
        // Next's App Router keys, as on the real page (a popstate without them would reload the page).
        history.replaceState({ ...history.state, __NA: true }, '', location.href);
        // A stale tab record, written once per test tab (the explicit link must win over it).
        if ( record && ! sessionStorage.getItem('fixture-seeded') ) {
            sessionStorage.setItem('fixture-seeded', '1');
            sessionStorage.setItem('ezil-os:code.folder.v1', JSON.stringify({ v: 1, entries: { [`${userId}\n${computerId}\n\n`]: { v: 1, kind: 'folder', path: record, at: 1 } } }));
        }
    }, { computerId, userId, record: record ?? null });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', e => errors.push(e.message));
    const at = (p) => page.waitForFunction(x => location.pathname === x, p);
    const address = () => page.evaluate(() => location.pathname + location.search);
    const waitAddress = (want) => page.waitForFunction(x => location.pathname + location.search === x, want).then(() => true, () => false);
    const editorFrame = () => page.frames().find(f => f !== page.mainFrame() && f.url().startsWith(`${editorOrigin}/?`));
    const editorQuery = () => new URL(editorFrame()?.url() ?? `${editorOrigin}/`).search;
    const editorFolder = () => new URLSearchParams(editorQuery()).get('folder');
    const waitEditor = (folder) => page.waitForFunction(() => true).then(async () => {
        const end = Date.now() + 15_000;
        while ( Date.now() < end ) { if ( editorFolder() === folder ) return true; await page.waitForTimeout(100); }
        return false;
    });
    const len = () => page.evaluate(() => history.length);
    const quiet = () => page.waitForTimeout(1500); // a reload or a route follow, if any, has started and been seen
    const notice = () => page.locator('.ezil-code-folder-notice').first();
    await page.goto(`${shellOrigin}${start}`);
    return { context, page, at, address, waitAddress, editorFrame, editorQuery, editorFolder, waitEditor, len, quiet, notice };
}
const enc = (p) => encodeURIComponent(p).replace(/%2F/g, '/');
const on = (e, doc) => events.some(x => x.e === e && x.doc === doc);
const lastAsk = () => asks.at(-1);

// ── link, switch, Back/Forward, reload, reconnect ───────────────────────────────────────────────────────────
{
    const t = await tab(`/app/code?folder=${encodeURIComponent('/workspace/a')}`, { record: '/workspace/c' });
    ok(await t.waitEditor('/workspace/a'), 'link: /app/code?folder=%2Fworkspace%2Fa opens the editor at /workspace/a');
    ok(lastAsk().codeFolder?.path === '/workspace/a', `link: the mint asked for the link's folder, not the stale tab record [${JSON.stringify(lastAsk())}]`);
    ok(await t.waitAddress('/app/code?folder=/workspace/a'), `link: the address names the folder, canonical spelling [${await t.address()}]`);
    const lenA = await t.len();
    const aDoc = docs.length - 1;

    // Open Folder B inside Code (VS Code pushes; the bridge makes it the shell's entry, then replaces).
    await t.editorFrame().evaluate(() => window.openFolder('/workspace/b'));
    ok(await t.waitEditor('/workspace/b'), 'switch: the editor opened /workspace/b');
    ok(await t.waitAddress('/app/code?folder=/workspace/b'), `switch: the address follows the folder opened in Code [${await t.address()}]`);
    await t.quiet();
    ok(await t.len() === lenA + 1, `switch: exactly one new history entry [${lenA} -> ${await t.len()}]`);
    const bDoc = docs.length - 1;
    ok(bDoc === aDoc + 1, `switch: the editor loaded once, never torn down and re-inserted [${docs.slice(aDoc)}]`);
    ok(on('beforeunload', aDoc), 'switch: the document the switch left went through its own beforeunload');

    // Back: the address AND the editor return to A; Forward: both to B (the old F2, now a passing regression).
    await t.page.goBack();
    ok(await t.waitAddress('/app/code?folder=/workspace/a'), `back: the address returns to ?folder=/workspace/a [${await t.address()}]`);
    ok(await t.waitEditor('/workspace/a'), `back: the editor returns to /workspace/a [${t.editorQuery()}]`);
    ok(on('beforeunload', bDoc), 'back: the document Back replaced went through its own beforeunload (its veto ran)');
    await t.quiet();
    await t.page.goForward();
    ok(await t.waitAddress('/app/code?folder=/workspace/b'), `forward: the address returns to ?folder=/workspace/b [${await t.address()}]`);
    ok(await t.waitEditor('/workspace/b'), `forward: the editor returns to /workspace/b [${t.editorQuery()}]`);
    await t.quiet();
    ok(await t.address() === '/app/code?folder=/workspace/b', 'forward: the address is stable afterwards (no follow-up rewrite)');

    // Nested folder creation inside the root navigates nothing: no entry, same address.
    const lenB = await t.len();
    const docsB = docs.length;
    await t.editorFrame().evaluate(() => { document.body.append(Object.assign(document.createElement('div'), { textContent: 'mkdir web/src' })); });
    await t.quiet();
    ok(await t.len() === lenB && docs.length === docsB && await t.address() === '/app/code?folder=/workspace/b', 'nested: a change inside the root adds no entry and keeps the address');

    // Reload at B: the mint asks for B (the address), and B opens.
    const mintsBefore = mints;
    await t.page.reload();
    ok(await t.waitEditor('/workspace/b'), 'reload: the editor reopens at /workspace/b');
    ok(mints === mintsBefore + 1 && lastAsk().codeFolder?.path === '/workspace/b', `reload: one mint, asking for the address's folder [${JSON.stringify(lastAsk())}]`);
    ok(await t.waitAddress('/app/code?folder=/workspace/b'), 'reload: the address keeps ?folder=/workspace/b');

    // Reconnect (a restart re-mints): the live frame is navigated, never removed, at the same folder.
    const old = docs.length - 1;
    await t.page.evaluate((computerId) => window.dispatchEvent(new CustomEvent('ezil:desktop-restarted', { detail: { computerId } })), computerId);
    await t.quiet();
    ok(lastAsk().codeFolder?.path === '/workspace/b', `reconnect: the re-mint asked for the folder on screen [${JSON.stringify(lastAsk())}]`);
    ok(await t.waitEditor('/workspace/b'), 'reconnect: the editor reopens at /workspace/b');
    ok(on('beforeunload', old), 'reconnect: the live editor document went through its own beforeunload (navigated, never removed)');
    ok(await t.waitAddress('/app/code?folder=/workspace/b'), 'reconnect: the address keeps the folder');
    await t.context.close();
}

// ── Close Folder, a workspace, and Back to the folder ─────────────────────────────────────────────────────
{
    const t = await tab(`/app/code?folder=${enc('/workspace/c')}`);
    ok(await t.waitEditor('/workspace/c'), 'close: starts at /workspace/c');
    await t.waitAddress('/app/code?folder=/workspace/c');
    const lenC = await t.len();
    await t.editorFrame().evaluate(() => window.closeFolder());
    ok(await t.waitAddress('/app/code'), `close: Close Folder leaves a bare /app/code [${await t.address()}]`);
    await t.quiet();
    ok(await t.len() === lenC + 1 && new URLSearchParams(t.editorQuery()).get('ew') === 'true', 'close: its own entry; the editor is the empty window');
    await t.editorFrame().evaluate(() => window.openWorkspace('/workspace/multi.code-workspace'));
    await t.quiet();
    ok(new URLSearchParams(t.editorQuery()).has('workspace') && await t.address() === '/app/code', `multi-root: a workspace is never named in the address [${await t.address()}]`);
    ok(await t.len() === lenC + 2, 'multi-root: its own entry too');
    await t.page.goBack(); await t.page.goBack();
    ok(await t.waitAddress('/app/code?folder=/workspace/c'), 'close: Back twice returns to ?folder=/workspace/c');
    ok(await t.waitEditor('/workspace/c'), 'close: and the editor to /workspace/c');
    await t.context.close();
}

// ── spaces and Unicode ───────────────────────────────────────────────────────────────────────────────────
{
    const f = '/workspace/my site/日本';
    const t = await tab(`/app/code?folder=${encodeURIComponent(f)}`);
    ok(await t.waitEditor(f), 'unicode: a folder with a space and Unicode opens');
    ok(lastAsk().codeFolder?.path === f, `unicode: asked byte for byte [${JSON.stringify(lastAsk())}]`);
    ok(await t.waitAddress(`/app/code?folder=${enc(f)}`), `unicode: the address keeps / readable and encodes the rest [${await t.address()}]`);
    await t.context.close();
}

// ── relative and normalised links ────────────────────────────────────────────────────────────────────────
{
    const t = await tab('/app/code?folder=x/../a');
    ok(await t.waitEditor('/workspace/a'), 'relative: folder=x/../a resolves inside /workspace to /workspace/a');
    ok(lastAsk().codeFolder?.path === '/workspace/a', 'relative: the mint asked for the normalised absolute path');
    ok(await t.waitAddress('/app/code?folder=/workspace/a'), 'relative: the address is rewritten to the absolute path');
    await t.context.close();
}

// ── invalid and missing ──────────────────────────────────────────────────────────────────────────────────
{
    const t = await tab('/app/code?folder=../../etc');
    ok(await t.waitEditor(DEFAULT), 'invalid: an escaping folder opens the default folder');
    ok(lastAsk().codeFolder === undefined, `invalid: nothing was asked for [${JSON.stringify(lastAsk())}]`);
    await t.notice().waitFor();
    ok((await t.notice().getAttribute('data-outcome')) === 'link_invalid', 'invalid: a visible notice says the link folder was not used');
    ok(await t.waitAddress(`/app/code?folder=${DEFAULT}`), `invalid: the address then follows the editor [${await t.address()}]`);
    await t.context.close();
}
{
    const t = await tab(`/app/code?folder=${enc('/workspace/nope')}`);
    ok(await t.waitEditor(DEFAULT), 'missing: a folder the server cannot open: the default opens');
    ok(lastAsk().codeFolder?.path === '/workspace/nope', 'missing: it was asked for');
    await t.notice().waitFor();
    ok((await t.notice().getAttribute('data-outcome')) === 'missing', 'missing: a visible notice says so');
    await t.quiet();
    ok(await t.address() === '/app/code?folder=/workspace/nope', `missing: the address keeps the asked folder for a reload or Try again [${await t.address()}]`);
    await t.context.close();
}

// ── a folder beside a repository ─────────────────────────────────────────────────────────────────────────
{
    const t = await tab(`/app/code?repo=${encodeURIComponent('https://github.com/octocat/Hello-World.git')}&folder=web`);
    ok(await t.waitEditor('/workspace/projects/0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e'), 'repo: the repository opens at its own folder');
    ok(lastAsk().repository?.url === 'https://github.com/octocat/Hello-World.git' && lastAsk().codeFolder === undefined,
        `repo: one repository ask, no own-files folder ask [${JSON.stringify(lastAsk())}]`);
    await t.notice().waitFor();
    ok((await t.notice().getAttribute('data-outcome')) === 'with_repository', 'repo: a visible notice says the folder was not opened');
    await t.context.close();
}

// ── unsaved work: a veto stops Back; address and editor stay together ─────────────────────────────────────
{
    const t = await tab(`/app/code?folder=${enc('/workspace/a')}`);
    await t.waitEditor('/workspace/a'); await t.waitAddress('/app/code?folder=/workspace/a');
    await t.editorFrame().evaluate(() => window.openFolder('/workspace/b'));
    await t.waitEditor('/workspace/b'); await t.waitAddress('/app/code?folder=/workspace/b'); await t.quiet();
    await t.editorFrame().evaluate(() => window.makeDirty());
    await t.page.locator('.window[data-app="code"] .window-app-iframe').click(); // the person's own gesture in the editor
    const lenB = await t.len();
    let dialogs = 0;
    t.page.once('dialog', (d) => { dialogs += 1; void d.dismiss(); });
    await t.page.goBack({ timeout: 3_000 }).catch(() => {});
    ok(await t.waitAddress('/app/code?folder=/workspace/b'), `unsaved: after "Stay" the tab is back on the entry the editor still shows [${await t.address()}]`);
    await t.quiet();
    ok(dialogs === 1, `unsaved: Back asked the editor's own unload veto [${dialogs}]`);
    ok(t.editorFolder() === '/workspace/b' && await t.address() === '/app/code?folder=/workspace/b',
        `unsaved: "Stay" keeps the address and the editor together at /workspace/b [${await t.address()} / ${t.editorQuery()}]`);
    ok(await t.len() === lenB, 'unsaved: no entry was added or lost: Back can be asked again');
    t.page.once('dialog', (d) => { void d.accept(); });
    await t.page.goBack({ timeout: 3_000 }).catch(() => {});
    ok(await t.waitAddress('/app/code?folder=/workspace/a') && await t.waitEditor('/workspace/a'), 'unsaved: "Leave" then goes Back with both');
    await t.context.close();
}

ok(errors.length === 0, `no uncaught page errors [${errors.join(' | ')}]`);
await browser.close(); shell.close(); editor.close();
console.log(`PASS ${checks} checks: Code folder in the address bar (link, switch, Back/Forward, reload, reconnect, close, multi-root, nested, unicode, relative, invalid, missing, repository, unsaved veto)`);
