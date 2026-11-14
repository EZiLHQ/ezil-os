// Real built Code window + actual Worker's refused document, at separate local origins.
// No real auth, computer, provider or credential. Registered in the portable CI family.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
const require = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit', 'noop.js'));
let chromium;
try { ({ chromium } = require('playwright')); } catch { console.log('SKIP playwright not resolvable'); process.exit(2); }
const source = stripTypeScriptTypes(readFileSync(new URL('../../../worker/src/code-auth-recovery.ts', import.meta.url), 'utf8'));
const { codeAuthRecovery, codeOriginRecovery } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
const assets = process.env.EZIL_SHELL_OUT_DIR || new URL('../../../app/public/os/', import.meta.url).pathname;
const computerId = '11111111-1111-4111-8111-111111111111';
let running = true, documents = 0, mints = 0, editorOrigin, oldShell = false, authExpired = false, editorHealthy = false, originDown = false;
const topPaths = [];
const shell = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = body => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    if (url.pathname.startsWith('/os/')) {
        const file = url.pathname.slice(4);
        if (!['bundle.min.js','bundle.min.css','icons.js'].includes(file)) { res.writeHead(404); res.end(); return; }
        res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(readFileSync(path.join(assets, file))); return;
    }
    if (url.pathname === '/api/shell/code-preview-url') {
        mints++; json({ ok: true, codePreviewUrl: `${editorOrigin}/preview-bootstrap?token=fixture&folder=/workspace`, expiresAt: Date.now()+300_000 }); return;
    }
    if (url.pathname === '/api/shell/desktop') {
        if (authExpired) { res.statusCode = 401; json({error:{code:'UNAUTHORIZED',message:'Sign in to continue.'}}); return; }
        json(url.searchParams.get('confirm') === 'frame' ? { ok: true, confirmed: true, status: 200 } : { ok: true, guacamoleRunning: running }); return;
    }
    if (url.pathname.startsWith('/api/')) { json({ ok: true }); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (url.pathname === '/login') {
        res.setHeader('content-type','text/html'); res.end('<html><body>Normal OS sign-in fixture</body></html>'); return;
    }
    documents++; topPaths.push(url.pathname + url.search);
    if (authExpired) {
        // The normal OS document bootstrap, unlike its API status read, sends an expired session to sign-in.
        res.writeHead(302,{location:'/login?returnUrl='+encodeURIComponent(url.pathname+url.search)}); res.end(); return;
    }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>');
});
const editor = createServer(async (req, res) => {
    const url = new URL(req.url, editorOrigin);
    if (url.pathname === '/preview-bootstrap') {
        res.writeHead(302, { location: '/?folder=/workspace&ezil_mint=' + (url.searchParams.get('ezil_mint') ?? '') }); res.end(); return;
    }
    if (editorHealthy && !originDown && url.pathname === '/') {
        res.setHeader('content-type','text/html'); res.end('<html><body><button onclick="location.reload()">Reload Code</button></body></html>'); return;
    }
    // S13: the actual Worker's 502 document for an unavailable origin (tunnel absent/fenced/other epoch), never raw JSON.
    const response = (originDown ? codeOriginRecovery : codeAuthRecovery)(new Request(url, { headers: { 'sec-fetch-dest': 'iframe' } }), ['https://os-staging.ezil.work']);
    if (!response) { res.writeHead(404); res.end(); return; }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
});
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r));
await listen(shell); await listen(editor);
const shellOrigin = `http://127.0.0.1:${shell.address().port}`;
editorOrigin = `http://127.0.0.1:${editor.address().port}`;
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
try {
    for (const scenario of ['running', 'stopped', 'old-shell', 'auth-expired', 'origin-unavailable']) {
        running = scenario !== 'stopped'; oldShell = scenario === 'old-shell'; authExpired = false; originDown = false;
        editorHealthy = scenario === 'auth-expired' || scenario === 'origin-unavailable';
        documents = 0; mints = 0; topPaths.length = 0;
        const context = await browser.newContext();
        await context.addInitScript(({computerId, oldShell}) => {
            // Old open shells have no recovery listener. Suppress ONLY this new message
            // while retaining the real built Code window and its production sandbox attrs.
            // The separate exact-old-S8 local proof needs history; this CI test does not.
            if (oldShell) addEventListener('message', event => {
                if (event.data?.type === 'ezil:code-auth-required') event.stopImmediatePropagation();
            }, true);
            window.__EZIL_BOOT__ = { user: {id:'33333333-3333-4333-8333-333333333333', email:'fixture@example.test'},
                computer:{id:computerId,name:'Fixture computer',slot:1},apps:[{id:'desktop'}],
                desktopState:{provider:'cloudflare-guacamole',configured:true,hasHmacSecret:true,status:'idle',ui:{floatingControls:false,feedbackScreenshots:false}} };
            history.replaceState({...history.state,__NA:true},'',location.href);
        }, {computerId, oldShell});
        const page = await context.newPage();
        const target = `/app/code?computer=${computerId}`;
        await page.goto(shellOrigin + target);
        if (oldShell) {
            const frame = await page.waitForFunction(origin => [...document.querySelectorAll('iframe')].some(f => f.src.startsWith(origin)), editorOrigin);
            await frame.dispose();
            const editorLink = page.frameLocator('.window-app-iframe').getByRole('link',{name:'Reload EZiL OS'});
            await editorLink.waitFor({state:'visible'});
            const iframeSandbox = await page.locator('.window-app-iframe').getAttribute('sandbox');
            assert.ok(iframeSandbox.includes('allow-top-navigation-by-user-activation'));
            await page.route('https://os-staging.ezil.work/app/code', route => route.fulfill({status:200, contentType:'text/html', body:'<html><body>Authenticated OS rebootstrap fixture</body></html>'}));
            assert.equal(documents,1,'old shell cannot consume recovery message');
            await editorLink.click();
            await page.waitForURL('https://os-staging.ezil.work/app/code');
            assert.ok((await page.textContent('body')).includes('Authenticated OS rebootstrap fixture'));
            console.log('PASS old-shell absent-handler compatibility: real sandbox permits user-click fixed trusted OS top link');
            await context.close(); continue;
        }
        if (scenario === 'origin-unavailable') {
            // S13: a confirmed editor whose origin then goes away (a placement change, an idle stop). Code's own
            // Reload inside the frame lands on the Worker's 502 document, never raw JSON; the shell reopens once
            // through the mint, then says Code is unreachable until an explicit Try again; the OS never reloads.
            const reloadCode = page.frameLocator('.window-app-iframe').getByRole('button',{name:'Reload Code'});
            await reloadCode.waitFor({state:'visible'});
            await page.waitForFunction(() => document.querySelector('.ezil-app-spinner')?.hidden === true);
            assert.equal(mints,1);
            originDown = true; await reloadCode.click();
            const unavailable = page.locator('.ezil-code-unavailable');
            await page.waitForFunction(() => document.querySelector('.ezil-code-unavailable')?.hidden === false);
            assert.equal(mints,2,'one automatic reopen through the mint, then the guard holds');
            assert.equal(documents,1,'the OS route never reloads for an unavailable origin');
            assert.ok(topPaths.every(p=>p===target));
            const frameText = await page.frameLocator('.window-app-iframe').locator('body').textContent();
            assert.ok(frameText.includes("Code can't reach your computer"), 'the frame shows the recovery document, not JSON');
            assert.ok(!frameText.includes('aws_origin_unavailable'));
            await page.waitForTimeout(300); assert.equal(mints,2,'no reopen loop while the origin stays down');
            // The explicit Try again is the same reopen; while the origin stays down it ends unreachable again.
            await unavailable.getByRole('button',{name:'Try again'}).click();
            await page.waitForFunction(() => document.querySelector('.ezil-app-spinner')?.hidden === false);
            await page.waitForFunction(() => document.querySelector('.ezil-code-unavailable')?.hidden === false);
            assert.equal(mints,3); assert.equal(documents,1);
            // The origin comes back: Try again reopens the editor and the cover goes.
            originDown = false;
            await unavailable.getByRole('button',{name:'Try again'}).click();
            await reloadCode.waitFor({state:'visible'});
            await page.waitForFunction(() => document.querySelector('.ezil-app-spinner')?.hidden === true
                && document.querySelector('.ezil-code-unavailable')?.hidden === true);
            assert.equal(mints,4); assert.equal(documents,1);
            console.log('PASS actual Code502 origin document: one guarded reopen, unreachable cover with Try again, recovery when the origin returns; never raw JSON, never an OS reload');
            await context.close(); continue;
        }
        if (scenario === 'auth-expired') {
            const expireAndReloadCode = async () => {
                const reloadCode = page.frameLocator('.window-app-iframe').getByRole('button',{name:'Reload Code'});
                await reloadCode.waitFor({state:'visible'});
                await page.waitForFunction(() => document.querySelector('.ezil-app-spinner')?.hidden === true);
                authExpired = true; editorHealthy = false; await reloadCode.click();
            };
            await expireAndReloadCode();
            await page.waitForURL(url => url.pathname === '/login');
            assert.equal(documents,2); assert.equal(mints,1,'expired OS bootstrap cannot mint another authenticated Code URL');
            assert.ok(topPaths.every(p=>p===target));
            // The same tab's guard persists: another expired old window must still offer an explicit full reload.
            authExpired = false; editorHealthy = true; documents = 0; mints = 0; topPaths.length = 0;
            await page.goto(shellOrigin+target); await expireAndReloadCode();
            await page.waitForFunction(() => document.querySelector('.ezil-code-state')?.dataset.state === 'unknown');
            assert.equal(documents,1,'guard blocks automatic repeat');
            await page.locator('.ezil-code-state').getByRole('button',{name:'Retry'}).click();
            await page.waitForURL(url => url.pathname === '/login');
            assert.equal(documents,2); assert.equal(mints,1);
            console.log('PASS live Code Reload + actual session401: guarded full OS auth bootstrap, then explicit full reload despite persistent401');
            await context.close(); continue;
        }
        const state = page.locator('.ezil-code-state');
        await state.waitFor({ state:'visible' });
        if (running) {
            await page.waitForFunction(() => document.querySelector('.ezil-code-state')?.dataset.state === 'unknown');
            assert.equal(documents,2); assert.equal(mints,2);
            assert.ok(topPaths.every(p=>p===target));
            await page.waitForTimeout(250); assert.equal(documents,2,'persisted guard stops reload cycle');
            console.log('PASS actual Code401 document reloads whole current OS route once, then offers safe Retry');
        } else {
            await page.waitForFunction(() => document.querySelector('.ezil-code-state')?.dataset.state === 'stopped');
            assert.equal(documents,1); assert.equal(mints,1);
            assert.equal(await state.getByRole('button',{name:'Start computer'}).isVisible(),true);
            running = true; await state.getByRole('button',{name:'Start computer'}).click();
            await page.waitForFunction(() => document.querySelector('.ezil-code-state')?.dataset.state === 'unknown');
            assert.equal(documents,2); assert.equal(mints,3,'explicit Start re-mints; recovery reload boot mints normally');
            console.log('PASS stopped computer requires Start; its fresh boot recovery is not stranded by guard');
        }
        await context.close();
    }
} finally {
    await browser.close();
    await Promise.all([new Promise(r=>shell.close(r)),new Promise(r=>editor.close(r))]);
}
