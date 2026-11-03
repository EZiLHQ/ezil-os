// code-history-browser-test.mjs — EZiL-authored. REAL-BROWSER test that shell
// Back/Forward never reloads the Code editor at an older document (F2) and that
// a re-mint never adds a history entry for the editor (apps/code.js `loadFrame`).
//
// Run:  node shell/ezil/apps/code-history-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle; or point
//       EZIL_SHELL_OUT_DIR at a build)
// Requires `playwright` (here or under $PLAYWRIGHT_REQUIRE_DIR); exits 2 (skip) without it.
//
// The real shell bundle (router, Code window, folder bridge) runs at one
// origin; a fake editor runs at ANOTHER origin and speaks the patched
// workbench's bridge (worker/code-folder-bridge): `ezil.code.ready`, a report
// per hello `{mint, kind, path, base}` to the shell origin only, and an
// in-editor Open Folder as `location.replace` (the bridge's B3). Its bootstrap
// 302s to the first document with `ezil_mint`, as the Worker does on AWS.
//
//   F2           Code open, another app pushed, Code back (push), Open Folder in
//                the editor: Back/Forward walk the shell entries and the editor
//                document never reloads; the folder record stays on the new one.
//   control      the same with an editor that reports no `base` (an older
//                bridge): the shell cannot reload it, and Back DOES reload the
//                editor at the mint's first folder. Proves the check sees F2.
//   no push      Open Folder with no shell push since the frame loaded: no
//                extra load at all.
//   remint       a restart re-mints Code: no new history entry; Back leaves the
//                shell, never takes the editor to the expired bootstrap URL.
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

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; console.log(`PASS  ${msg}`); };

const TYPES = { '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
let mints = 0;
const docs = []; // every editor document the browser loaded, by query, in order
let reportBase = true;
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
        mints += 1;
        return json({ ok: true, codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=T${mints}&path=%2F` });
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
// The editor: what the patched workbench's bridge says and does, nothing more.
const editorHtml = () => `<!doctype html><html><body><pre id="doc"></pre><script>
const SHELL = ${JSON.stringify(shellOrigin)};
const q = new URLSearchParams(location.search);
const m = q.get('ezil_mint');
const mint = m && /^[A-Za-z0-9_-]{22}$/.test(m) ? m : null;
const folder = q.get('folder');
const report = folder ? { kind: 'folder', path: folder } : { kind: 'empty' };
${reportBase ? 'report.base = location.pathname;' : ''}
document.getElementById('doc').textContent = location.search;
addEventListener('message', (ev) => {
  const d = ev.data;
  if ( ev.source !== parent || ev.origin !== SHELL || ! d || d.type !== 'ezil.code.hello' || d.v !== 1 || ! /^[A-Za-z0-9_-]{22}$/.test(d.nonce || '') ) return;
  parent.postMessage({ type: 'ezil.code.folder', v: 1, nonce: d.nonce, mint, ...report }, SHELL);
});
parent.postMessage({ type: 'ezil.code.ready', v: 1 }, SHELL);
window.openFolder = (p) => location.replace(location.pathname + '?folder=' + encodeURIComponent(p));
</script></body></html>`;
const editor = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if ( url.pathname === '/preview-bootstrap' ) {
        // As the Worker on AWS: the first document, with this mint's id and the provider default folder.
        const to = new URLSearchParams({ folder: '/workspace/a' });
        const mint = url.searchParams.get('ezil_mint'); if ( mint ) to.set('ezil_mint', mint);
        res.statusCode = 302; res.setHeader('location', `/?${to}`); res.end(); return;
    }
    if ( url.pathname === '/' ) {
        // Every editor document is one request here (no-store: a history reload cannot come from a cache).
        docs.push(url.search);
        res.setHeader('content-type', 'text/html'); res.setHeader('cache-control', 'no-store'); res.end(editorHtml()); return;
    }
    res.statusCode = 404; res.end();
});
await new Promise(r => shell.listen(0, '127.0.0.1', r));
await new Promise(r => editor.listen(0, '127.0.0.1', r));
shellOrigin = `http://127.0.0.1:${shell.address().port}`;
editorOrigin = `http://localhost:${editor.address().port}`; // another origin, as the code host is

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
const computerId = '11111111-1111-4111-8111-111111111111';
const errors = [];

async function tab () {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(({ computerId }) => {
        window.__EZIL_BOOT__ = { user: { id: '33333333-3333-4333-8333-333333333333', email: 'fixture@example.test' },
            computer: { id: computerId, name: 'Fixture computer', slot: 1 }, apps: [{ id: 'desktop' }],
            desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', ui: { floatingControls: false, feedbackScreenshots: false } } };
        // Next's App Router keys, as on the real page (a popstate without them would reload the page).
        history.replaceState({ ...history.state, __NA: true }, '', location.href);
    }, { computerId });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', e => errors.push(e.message));
    const loads = docs; // the editor server's own count, not navigation events (Playwright reports some twice)
    const at = (p) => page.waitForFunction(x => location.pathname === x, p);
    const editorFrame = () => page.frames().find(f => f !== page.mainFrame() && f.url().startsWith(`${editorOrigin}/?`));
    const record = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('ezil-os:code.folder.v1') ?? '{}')?.entries ?? {})
        .then(e => Object.values(e)[0]?.path ?? null);
    const waitRecord = (p) => page.waitForFunction(x => Object.values(JSON.parse(sessionStorage.getItem('ezil-os:code.folder.v1') ?? '{}')?.entries ?? {})[0]?.path === x, p);
    const quiet = () => page.waitForTimeout(1200); // a reload, if any, has started and been seen by then
    await page.goto(`${shellOrigin}/os`);
    await page.locator('.taskbar-item[data-app="code"]').waitFor();
    return { context, page, loads, at, editorFrame, record, waitRecord, quiet };
}

async function openCodeFromDock (t) {
    await t.page.locator('.taskbar-item[data-app="code"]').click();
    await t.at('/app/code');
    await t.waitRecord('/workspace/a'); // the mint's first document reported, bound to this mint
}

// ── F2 and its control ─────────────────────────────────────────────────────
for ( const withBase of [true, false] ) {
    reportBase = withBase;
    const label = withBase ? 'F2' : 'control (no base)';
    const t = await tab();
    await openCodeFromDock(t);
    await t.page.locator('.taskbar-item[data-app="settings"]').click(); await t.at('/app/settings');
    await t.page.locator('.taskbar-item[data-app="code"]').click(); await t.at('/app/code');
    const before = t.loads.length;
    await t.editorFrame().evaluate(() => window.openFolder('/workspace/b'));
    await t.waitRecord('/workspace/b');
    await t.quiet();
    const opened = t.loads.length - before;
    if ( withBase ) ok(opened === 2, `${label}: Open Folder after a shell push loads the editor twice (its replace, then a fresh frame) [${opened}]`);
    else ok(opened === 1, `${label}: an editor without a document path is not reloaded by the shell [${opened}]`);
    const afterOpen = t.loads.length;
    const len = await t.page.evaluate(() => history.length);
    await t.page.goBack(); await t.at('/app/settings'); await t.quiet();
    await t.page.goBack(); await t.at('/app/code'); await t.quiet();
    const back = t.loads.slice(afterOpen);
    if ( withBase ) {
        ok(back.length === 0, `${label}: Back twice across the shell entries never reloads the editor [${JSON.stringify(back)}]`);
        ok(new URL(t.editorFrame().url()).searchParams.get('folder') === '/workspace/b', `${label}: the editor still shows /workspace/b after Back`);
        ok(await t.record() === '/workspace/b', `${label}: the folder record stays /workspace/b after Back`);
        await t.page.goForward(); await t.at('/app/settings'); await t.quiet();
        await t.page.goForward(); await t.at('/app/code'); await t.quiet();
        ok(t.loads.length === afterOpen, `${label}: Forward twice never reloads the editor [${JSON.stringify(t.loads.slice(afterOpen))}]`);
        ok(await t.page.evaluate(() => history.length) === len, `${label}: the shell's history length is unchanged by any of it`);
    } else {
        ok(back.some(u => new URLSearchParams(u).get('folder') === '/workspace/a'),
            `${label}: positive control: Back DOES reload the editor at the mint's first folder (F2 is visible to this check) [${JSON.stringify(back)}]`);
    }
    await t.context.close();
}
reportBase = true;

// ── no push since the frame loaded: no extra load ──────────────────────────
{
    const t = await tab();
    await openCodeFromDock(t);
    const before = t.loads.length;
    await t.editorFrame().evaluate(() => window.openFolder('/workspace/c'));
    await t.waitRecord('/workspace/c'); await t.quiet();
    ok(t.loads.length - before === 1, `no push: Open Folder loads the editor once, no shell reload [${t.loads.length - before}]`);
    await t.context.close();
}

// ── remint: no history entry; Back never loads the expired bootstrap URL ────
{
    const t = await tab();
    await openCodeFromDock(t);
    const len = await t.page.evaluate(() => history.length);
    const firstMint = mints;
    await t.page.evaluate((computerId) => window.dispatchEvent(new CustomEvent('ezil:desktop-restarted', { detail: { computerId } })), computerId);
    await t.quiet();
    ok(mints === firstMint + 1, `remint: the restart re-minted once [${mints - firstMint}]`);
    await t.waitRecord('/workspace/a'); await t.quiet();
    ok(await t.page.evaluate(() => history.length) === len, 'remint: no history entry added by the re-mint');
    const afterRemint = t.loads.length;
    await t.page.goBack(); await t.at('/os'); await t.quiet();
    const back = t.loads.slice(afterRemint);
    ok(back.length === 0, `remint: Back leaves the shell entry and loads no editor document (never the expired bootstrap's) [${JSON.stringify(back)}]`);
    await t.context.close();
}

ok(errors.length === 0, `no uncaught page errors [${errors.join(' | ')}]`);
await browser.close(); shell.close(); editor.close();
console.log(`PASS ${checks} checks: Code history (F2 Back/Forward, its control, no push, remint)`);
