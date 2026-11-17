// Run through auth-navigation.test.ts, or with Bun and --chromium=/path/to/playwright --executable=/path/to/chromium.
// All routes use real Worker authentication; only the upstream app is a fixture. No network or real secrets.
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { fakeVscode } from '../../../tests/fixtures/fake-vscode.ts';
import { mintPreviewBootstrapToken } from '../../../../../worker/src/hmac.ts';
import { handlePreviewBootstrap, handlePreviewProxy, handlePreviewInspectorJs } from '../../../../../worker/src/preview-bridge.ts';
import { handleAwsBrowserHost } from '../../../../../worker/src/aws-origin.ts';
import { safePath, transportUrl } from '../state.ts';
import vectors from '../../../../../docs/contracts/code-preview-v1.vectors.json';

mock.module('vscode', () => fakeVscode);
const { PreviewPanel } = await import('../panel.ts');
const secret = 'lane-f-synthetic-auth-test-only', sid = 'guac-u1-c1';
const shell = 'https://os.ezil.work', embedded = 'https://ezil.work', top = 'https://ezil.org';
const playwrightPath = process.argv.find(arg => arg.startsWith('--chromium='))?.slice(11);
const executablePath = process.argv.find(arg => arg.startsWith('--executable='))?.slice(13);
let chromium;
if (playwrightPath) {
    const { chromium: runtime } = await import(playwrightPath);
    chromium = await runtime.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
let passed = 0, knownGaps = 0, failed = 0;
async function scenario(name, run, knownGap = false) {
    try {
        await run();
        if (knownGap) { knownGaps++; console.log(`KNOWN BASELINE GAP (not acceptance): ${name}`); }
        else { passed++; console.log(`PASS ${name}`); }
    }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error.message}`); }
}

function server(aws) {
    const origin = aws ? 'https://aws-3002-guac-u1-c1-aws.ezil.org' : 'https://3002-guac-u1-c1-app.ezil.org';
    const upstream = async (url, init) => {
        assert(!String(url).includes('ezil_pv='), 'upstream URL must not receive fallback credentials');
        assert(!new Headers(init?.headers).get('cookie')?.includes('ezil_preview='), 'upstream must not receive preview cookie');
        return new Response('<!doctype html><html><head></head><body><button>App</button></body></html>', { headers: { 'content-type': 'text/html' } });
    };
    const serve = async request => {
        const url = new URL(request.url);
        assert.equal(url.origin, origin, 'only the fixed app origin is routed');
        if (aws) return await handleAwsBrowserHost(request, url, {
            routingEnabled: true, zone: 'origin.example.net', zoneRoot: 'ezil.org', secrets: [secret], nowMs: Date.now,
            lookup: async () => ({ computerId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', sandboxId: sid,
                generation: 1, leaseEpoch: 1, hostname: `c-${sid}-g1-e1.origin.example.net`,
                controlKey: Buffer.alloc(32, 7).toString('base64'), originVerified: true, originVerifiedAt: Date.now() }),
            fetch: upstream,
        });
        if (url.pathname === '/preview-bootstrap') return handlePreviewBootstrap(url, sid, [secret], secret);
        if (url.pathname === '/preview-inspector.js') return handlePreviewInspectorJs(request, sid, [secret]);
        return handlePreviewProxy(request, { containerFetch: upstream }, sid, [secret], url.pathname.replace(/^\/preview/, ''));
    };
    return { origin, serve };
}

// Deterministic browser-context model: cookie keys include the top-level schemeful site and app origin.
// The optional Chromium driver below runs the same scenarios with a real shared browser profile and separate tabs.
class PartitionedBrowser {
    cookies = new Map();
    constructor(serve, blockCookies) { this.serve = serve; this.blockCookies = blockCookies; }
    async navigate(raw, site) {
        let url = new URL(raw);
        for (let i = 0; i < 5; i++) {
            const key = `${site}|${url.origin}`;
            const headers = { accept: 'text/html' };
            if (!this.blockCookies && this.cookies.has(key)) headers.cookie = this.cookies.get(key);
            const response = await this.serve(new Request(url, { headers }));
            const cookie = response.headers.get('set-cookie');
            if (cookie && !this.blockCookies) {
                assert.match(cookie, /; HttpOnly; Secure; SameSite=None; Partitioned; Path=\//);
                this.cookies.set(key, cookie.split(';')[0]);
            }
            const location = response.headers.get('location');
            if (!location) return { status: response.status, url: url.href, body: await response.text() };
            const next = new URL(location, url);
            if (!location.includes('#')) next.hash = url.hash;
            url = next;
        }
        throw new Error('redirect loop');
    }
    async close() {}
}
async function browserFor(serve, blockCookies) {
    if (!chromium) return new PartitionedBrowser(serve, blockCookies);
    const context = await chromium.newContext();
    await context.route('**/*', async route => {
        const request = route.request();
        if (new URL(request.url()).origin === shell) {
            return route.fulfill({ contentType: 'text/html', body: '<iframe name="app"></iframe>' });
        }
        const headers = await request.allHeaders();
        // Force dropped cookies to exercise the fallback independent of browser defaults.
        if (blockCookies) delete headers.cookie;
        const response = await serve(new Request(request.url(), { headers }));
        const out = Object.fromEntries(response.headers);
        if (blockCookies) delete out['set-cookie'];
        await route.fulfill({ status: response.status, headers: out, body: await response.text() });
    });
    const page = await context.newPage(); await page.goto(shell);
    const iframe = page.frame({ name: 'app' });
    return {
        async navigate(url, site) {
            const target = site === embedded ? iframe : await context.newPage();
            const response = await target.goto(url);
            return { status: response.status(), url: target.url(), body: await response.text() };
        },
        close: () => context.close(),
    };
}
async function fixture(aws, blockCookies, run) {
    const { origin, serve } = server(aws), browser = await browserFor(serve, blockCookies);
    const messages = [], copied = [], opened = [], commands = [];
    fakeVscode.commands.executeCommand = async (name, request) => {
        commands.push([name, request]);
        assert.equal(name, '_ezil.previewMint'); assert.deepEqual(Object.keys(request).sort(), ['id', 'v']);
        return { url: `${origin}/preview-bootstrap?token=${encodeURIComponent(await mintPreviewBootstrapToken(secret, sid))}`, expiresAt: Date.now() + 60_000 };
    };
    fakeVscode.env.clipboard = { writeText: async value => { copied.push(value); } };
    fakeVscode.env.openExternal = async url => {
        const result = await browser.navigate(url.href, top); opened.push(result);
        return result.status === 200;
    };
    const panel = { webview: { html: '', cspSource: 'https://webview.test', postMessage: async message => { messages.push(message); },
        onDidReceiveMessage: () => ({ dispose() {} }) }, onDidDispose: () => ({ dispose() {} }) };
    const preview = new PreviewPanel(panel, { path: '/pricing?tab=2#/details?token=old&section=3' });
    try {
        await preview.start();
        const initial = panel.webview.html.match(/data-url="([^"]+)"/)[1].replace(/&amp;/g, '&');
        const first = await browser.navigate(initial, embedded);
        const observe = async path => preview.receive({ type: 'ready', doc: { ...vectors.selection.accept[0].sel.doc, path } });
        await run({ preview, browser, origin, first, observe, messages, copied, opened, commands, serve });
    } finally { preview.dispose(); await browser.close(); }
}
const clean = url => {
    const parsed = new URL(url); parsed.searchParams.delete('ezil_pv');
    return parsed.href;
};
try {
    for (const aws of [false, true]) await scenario(`${aws ? 'AWS' : 'CF'} partitioned iframe vs fresh top-level Open; legacy Copy ignored`, () => fixture(aws, false, async f => {
        assert.equal(f.first.status, 200, 'iframe bootstrap must authenticate');
        const path = '/pricing?tab=2#/details?section=3', safe = transportUrl(f.origin, path);
        await f.observe(path); await f.preview.receive({ type: 'copy' });
        assert.deepEqual(f.copied, [], 'unsupported Copy must not write to the clipboard');
        assert.equal(f.commands.length, 1, 'legacy Copy must not obtain new authorization');
        assert.equal(f.opened.length, 0, 'legacy Copy must not launch a browser');
        assert.equal((await f.browser.navigate(safe, embedded)).status, 200, 'cookie belongs to iframe partition');
        assert.equal((await f.browser.navigate(safe, top)).status, 401, 'credential-free URL has no auth in fresh top-level partition');
        await f.preview.receive({ type: 'external', url: 'https://evil.test', port: 9223 });
        assert.equal(f.opened[0].status, 200, 'Open must mint in the new top-level context');
        assert.equal(clean(f.opened[0].url), safe);
        assert.equal(clean(f.first.url), safe, 'bootstrap restores query and fragment');
        assert.equal(f.commands.length, 2, 'Open obtains a fresh fixed-operation mint');
    }));
    await scenario('CF blocked cookies: Reload/History retain query fallback and inspector authorization', () => fixture(false, true, async f => {
        assert.equal(f.first.status, 200);
        for (const action of [{ type: 'reload' }, { type: 'history', path: '/past?tab=4&token=old#section' }, { type: 'history', path: '/pricing?tab=2' }]) {
            await f.observe('/pricing?tab=2'); await f.preview.receive(action);
            const loaded = await f.browser.navigate(f.messages.findLast(message => message.type === 'load').url, embedded);
            assert.equal(loaded.status, 200, `${action.type} must bootstrap when cookies are blocked`);
            const path = action.path ? safePath(action.path) : '/pricing?tab=2';
            assert.equal(clean(loaded.url), transportUrl(f.origin, path));
            const inspector = new URL('/preview-inspector.js', f.origin);
            inspector.searchParams.set('ezil_pv', new URL(loaded.url).searchParams.get('ezil_pv'));
            assert.equal((await f.browser.navigate(inspector.href, embedded)).status, 200, 'fallback authenticates the inspector');
        }
        assert.equal(f.commands.length, 4);
        await f.preview.receive({ type: 'external' });
        assert.equal(f.opened[0].status, 200, 'Open also bootstraps when the new tab drops cookies');
    }));
    // Primary must change these expectations to 200 only after integrating the Worker E2 fixes.
    await scenario('AWS blocked-cookie navigation requires Worker integration, then assertions must require 200', () => fixture(true, true, async f => {
        assert.equal(f.first.status, 401, 'KNOWN BASELINE GAP, not acceptance: AWS bootstrap supplies only a cookie; require 200 after Worker integration');
        await f.observe('/pricing'); await f.preview.receive({ type: 'reload' });
        const load = f.messages.findLast(message => message.type === 'load');
        assert.equal(new URL(load.url).pathname, '/preview-bootstrap', 'extension still requests a fresh bootstrap');
        assert.equal((await f.browser.navigate(load.url, embedded)).status, 401, 'KNOWN BASELINE GAP, not acceptance: AWS reload needs Worker fallback; require 200 after integration');
    }), true);
    await scenario('real bootstrap verifier refuses invalid and cross-computer tokens', async () => {
        const { origin, serve } = server(false);
        for (const token of ['invalid', await mintPreviewBootstrapToken(secret, 'guac-other-computer'), await mintPreviewBootstrapToken(secret, sid, 1)]) {
            assert.equal((await serve(new Request(`${origin}/preview-bootstrap?token=${encodeURIComponent(token)}`))).status, 401);
        }
    });
} finally { await chromium?.close(); }
console.log(`${passed} pass, ${knownGaps} known baseline gap, ${failed} fail; ${chromium ? 'Chromium contexts' : 'modeled browser contexts'}, real Worker auth`);
process.exitCode = failed ? 1 : 0;
