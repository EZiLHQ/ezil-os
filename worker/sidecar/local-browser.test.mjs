import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createLocalBrowserServer, localOrigin, startLocalBrowserSocket } from './local-browser.mjs';
import { ROUTES } from './server.mjs';

async function post(socketPath, path, body, headers = {}) {
    const json = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = request({ socketPath, path, method: 'POST', agent: false,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json), ...headers } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
        });
        req.on('error', reject);
        req.end(json);
    });
}

test('only loopback application origins are allowed; the external contract stays separate', () => {
    assert.equal(localOrigin('http://localhost:5173/foo'), 'http://localhost:5173');
    assert.equal(localOrigin('http://127.0.0.1:3002/'), 'http://127.0.0.1:3002');
    assert.equal(localOrigin('https://[::1]:3010/?query=x'), 'https://[::1]:3010');
    for (const url of ['https://os-staging.ezil.work', 'file:///tmp/foo', 'http://localhost.ezil.work:5173/',
        'http://me:password@localhost:5173/', 'http://localhost/', 'http://localhost:9222/', 'http://localhost:8181/', 'http://localhost:3000/']) {
        assert.equal(localOrigin(url), undefined, url);
    }
    assert.equal(ROUTES.length, 10);
    assert.ok(ROUTES.every(route => !/candidates|share|revoke/.test(route)));
});

test('private socket HTTP boundary accepts only fixed same-user requests', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-browser-api-'));
    const socket = join(dir, 'test.sock');
    let reads = 0;
    const server = createLocalBrowserServer({ read() { reads++; return { ok: true }; } });
    t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
    server.listen(socket);
    await once(server, 'listening');
    const body = { capability: 'a'.repeat(48) };
    for (const [path, input, headers] of [
        ['/read', { ...body, url: 'http://localhost:5173' }],
        ['/read', { capability: 'guess' }],
        ['/read?query=1', body],
        ['/evaluate', body],
        ['/read', body, { origin: 'http://localhost:5173' }],
    ]) assert.deepEqual(await post(socket, path, input, headers), { ok: false, error: 'bad_request' });
    assert.equal(reads, 0);
    assert.deepEqual(await post(socket, '/read', body), { ok: true });
    assert.equal(reads, 1);
});

const executable = process.env.EZIL_LOCAL_BROWSER_CHROME;
test('scoped capability attaches to actual Chromium, clicks the chosen tab and revokes on navigation', { skip: !executable, timeout: 30_000 }, async t => {
    const { chromium } = await import('playwright-core');
    const { BrowserSurface } = await import('./browser.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'ezil-browser-chrome-'));
    const socket = join(dir, 'ezil-local-browser.sock');
    const app = createServer((req, res) => {
        res.setHeader('content-type', 'text/html');
        res.end(`<title>Local test</title><p id="state">Before click</p>
            <input type="password" value="sample-secret-token"><p>Echo sample-secret-token</p>
            <button onclick="document.querySelector('#state').textContent='After click'">Apply</button>
            <a href="https://example.invalid/">External</a><a href="/more">Local link</a>`);
    });
    const other = createServer((req, res) => res.end('another local origin'));
    let chrome;
    let listener;
    let browser;
    let surface;
    t.after(async () => {
        if (listener) await new Promise(resolve => listener.close(resolve));
        await browser?.close().catch(() => {});
        await surface?.browser?.close().catch(() => {});
        if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
            chrome.kill();
            await once(chrome, 'exit');
        }
        await Promise.all([app, other].map(server => new Promise(resolve => server.close(resolve))));
        await rm(dir, { recursive: true, force: true });
    });
    app.listen(0, '127.0.0.1');
    other.listen(0, '127.0.0.1');
    await Promise.all([once(app, 'listening'), once(other, 'listening')]);
    chrome = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
        '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
    let port;
    for (let i = 0; i < 100 && !port; i++) {
        await delay(60);
        try { [port] = (await readFile(join(dir, 'profile', 'DevToolsActivePort'), 'utf8')).split('\n'); } catch {}
    }
    assert.match(port ?? '', /^[0-9]+$/);
    const cdp = 'http://127.0.0.1:' + port;
    browser = await chromium.connectOverCDP(cdp);
    const page = browser.contexts()[0].pages()[0];
    const origin = 'http://127.0.0.1:' + app.address().port;
    await page.goto(origin);
    surface = new BrowserSurface(cdp);
    listener = startLocalBrowserSocket(surface, dir);
    await once(listener, 'listening');
    assert.equal((await stat(socket)).mode & 0o777, 0o600);
    const grant = async () => {
        const { candidates } = await post(socket, '/candidates', {});
        assert.equal(candidates.length, 1);
        assert.equal(candidates[0].origin, origin);
        const reply = await post(socket, '/share', { key: candidates[0].key, origin });
        assert.equal(reply.ok, true);
        return reply.capability;
    };
    const one = await grant();
    const two = await grant();
    const snapshot = await post(socket, '/read', { capability: one });
    assert.match(snapshot.text, /Before click/);
    assert.match(snapshot.text, /\[redacted\]/);
    assert.equal(JSON.stringify(snapshot).includes('sample-secret-token'), false);
    assert.deepEqual(snapshot.targets.map(target => target.label), ['Apply', 'Local link']);
    const ref = snapshot.targets[0].ref;
    assert.deepEqual(await post(socket, '/click', { capability: two, ref }), { ok: false, error: 'stale_ref' });
    assert.deepEqual(await post(socket, '/click', { capability: one, ref }), { ok: true });
    assert.equal(await page.locator('#state').textContent(), 'After click');
    assert.deepEqual(await post(socket, '/click', { capability: one, ref }), { ok: false, error: 'stale_ref' });
    const changed = await post(socket, '/read', { capability: one });
    await page.locator('button').evaluate(button => { button.textContent = 'New label'; });
    assert.deepEqual(await post(socket, '/click', { capability: one, ref: changed.targets[0].ref }), { ok: false, error: 'stale_ref' });
    await post(socket, '/revoke', { capability: two });
    assert.deepEqual(await post(socket, '/probe', { capability: two }), { ok: false });
    await page.goto('http://127.0.0.1:' + other.address().port);
    assert.deepEqual(await post(socket, '/probe', { capability: one }), { ok: false });
    await page.goto(origin);
    assert.deepEqual(await post(socket, '/read', { capability: one }), { ok: false, error: 'share_unavailable' });
});
