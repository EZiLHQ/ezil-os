/** Real route/auth handlers; only container/tunnel I/O and the browser transport are fixtures. */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { handleAwsBrowserHost, type AwsBrowserDeps } from './aws-origin';
import * as hmac from './hmac';
import { mintPreviewBootstrapToken, mintPreviewCookie } from './hmac';
import * as preview from './preview-bridge';
import { codeShellOriginsFor } from './code-folder-bridge';
import { isAiProxyPath } from './ai-proxy';
import { previewPageScripts } from './code-preview-bridge-helpers.test';
import vectors from './aws-gateway.vectors.json';

// No SDK is installed in this lane. Transpile the two production dispatchers byte-for-byte;
// inject real helpers and fake ONLY runtime/container boundaries (never auth booleans).
const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const dispatchSource = indexSource.slice(indexSource.indexOf('async function handleCodeBridge('),
  indexSource.indexOf('// ── Project files storage proxy'));
const dispatchJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(dispatchSource);

const SECRET = 'app-resource-test-secret', SID = 'guac-user1-comp1', ROOT = 'preview.example.org';
type Call = { path: string; method: string; headers: Headers; body: string; port: number; ws: boolean };
const resources: Record<string, [string, string]> = {
  '/': ['text/html', '<html><head><script type="module" src="/src/main.js"></script><link rel="stylesheet" href="/styles/main.css"></head><body>app</body></html>'],
  '/src/main.js': ['application/javascript', 'import "./nested/dep.js";'],
  '/src/nested/dep.js': ['application/javascript', 'export const ok = true;'],
  '/styles/main.css': ['text/css', '@import "./nested/theme.css";'],
  '/styles/nested/theme.css': ['text/css', 'body { background: url("../../assets/bg.svg?size=2") }'],
  '/assets/bg.svg': ['image/svg+xml', '<svg/>'],
};

async function fixture(provider: 'cf' | 'aws') {
  const calls: Call[] = [];
  let lookups = 0;
  const origin = `https://${provider === 'cf' ? `3002-${SID}-app` : `aws-3002-${SID}-aws`}.${ROOT}`;
  const answer = async (url: string, init: RequestInit, port: number, ws: boolean) => {
    const u = new URL(url), path = u.pathname.replace(/^\/__p\/\d+/, '');
    const [contentType, body] = resources[path] ?? ['application/json', '{"ok":true}'];
    calls.push({ path: path + u.search, method: init.method ?? 'GET', headers: new Headers(init.headers),
      body: init.body ? await new Response(init.body).text() : '', port, ws });
    // A transport sentinel, not a fabricated 101: the handler must return the upgrade response intact.
    return new Response(ws ? 'socket-upstream' : body, { headers: { 'content-type': contentType,
      'cache-control': 'public, max-age=3600', 'referrer-policy': 'unsafe-url' } });
  };
  const sandbox = {
    containerFetch: (url: string, init: RequestInit, port: number) => answer(url, init, port, false),
    runningContainerFetch: (url: string, init: RequestInit, port: number) => answer(url, init, port, false),
    wsConnect: (request: Request, port: number) => answer(request.url, { method: request.method, headers: request.headers }, port, true),
    setOptions: async () => {},
  };
  const env = { Sandbox: { idFromName: (name: string) => ({ name }), get: () => sandbox },
    SANDBOX_HMAC_SECRET: SECRET, SANDBOX_PREVIEW_ZONE_ROOT: ROOT };
  const deps: AwsBrowserDeps = { routingEnabled: true, zone: 'origin.example.net', secrets: [SECRET], zoneRoot: ROOT,
    lookup: async () => { lookups++; return { computerId: vectors.valid[0].computerId, sandboxId: SID, generation: 1, leaseEpoch: 2,
      instanceId: 'i-test', region: 'ap-south-1', publicIp: '13.200.1.2', tunnelId: 't-1', dnsRecordId: 'd-1',
      hostname: `c-${SID}-g1-e2.origin.example.net`, controlKey: vectors.controlKeyBase64, createdAt: 1,
      originVerified: true, originVerifiedAt: Date.now() }; },
    fetch: (url, init) => answer(url, init, Number(/\/__p\/(\d+)/.exec(url)![1]), new Headers(init.headers).get('upgrade') === 'websocket'),
    nowMs: Date.now };
  const bindings = { ...preview, ...hmac, APP_PREVIEW_PORT: 3002, CODE_PREVIEW_PORT: 8443, codeShellOriginsFor, isAiProxyPath,
    openSandbox: () => sandbox, resolvePreviewSecrets: () => [SECRET], resolveNekoDerivationSecret: () => SECRET,
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    probeAppPreviewStatus: () => { throw new Error('unexpected status probe'); },
    handleAiProxy: () => { throw new Error('unexpected AI dispatch'); } };
  const bridge = new Function(...Object.keys(bindings), dispatchJs + '\nreturn handleBridgeHost;')(...Object.values(bindings));
  const dispatch = async (request: Request) => provider === 'cf'
    ? (await bridge(request, env, new URL(request.url))) as Response | null : await handleAwsBrowserHost(request, new URL(request.url), deps);
  const get = async (path: string | URL, init: RequestInit = {}) => (await dispatch(new Request(new URL(path, origin), init)))!;
  const boot = async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const res = await get(`/preview-bootstrap?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(302);
    return { res, page: new URL(res.headers.get('location')!, origin) };
  };
  return { origin, calls, get, boot, lookups: () => lookups };
}

function runTransport(html: string, page: URL) {
  const fetches: Request[] = [], xhrs: Array<{ method: string; url: string; rest: unknown[] }> = [], sockets: URL[] = [];
  class XHR { open(method: string, url: string, ...rest: unknown[]) { xhrs.push({ method, url, rest }); } }
  class WS { static OPEN = 1; constructor(url: string | URL) { sockets.push(new URL(url, page)); } }
  const window = { location: page, WebSocket: WS, fetch(input: RequestInfo | URL, init?: RequestInit) {
    fetches.push(input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), page), init));
    return Promise.resolve(new Response('queued'));
  } };
  const originalFetch = window.fetch, originalWS = window.WebSocket, originalOpen = XHR.prototype.open;
  const context = { window, location: page, document: { createElement: () => ({}), head: { appendChild() {} } },
    URL, URLSearchParams, Request, XMLHttpRequest: XHR };
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) runInNewContext(script[1], context);
  return { window, XHR, fetches, xhrs, sockets, originalFetch, originalWS, originalOpen };
}

for (const provider of ['cf', 'aws'] as const) describe(`${provider} ordinary app resource auth`, () => {
  it('cookie-dropped bootstrap → HTML → external JS → module → CSS → CSS asset → fetch/XHR → original-path WS', async () => {
    const f = await fixture(provider), { res: bootstrap, page } = await f.boot();
    expect(bootstrap.headers.get('cache-control')).toContain('no-store');
    expect(bootstrap.headers.get('referrer-policy')).toBe('same-origin');
    const pageResponse = await f.get(page), html = await pageResponse.text();
    expect(pageResponse.status).toBe(200);
    expect(html).not.toContain(page.searchParams.get('ezil_pv')!);
    const script = previewPageScripts(html, page.href, pageResponse.headers).urls.find(u => u.pathname === '/preview-inspector.js')!;
    expect((await f.get(script)).status).toBe(200);

    // Parser requests do not pass through window.fetch. Follow 307s with cookies deliberately absent.
    const resource = async (path: string, referer: URL) => {
      const before = f.calls.length, lookups = f.lookups();
      const first = await f.get(path, { headers: { referer: referer.href } });
      expect(first.status).toBe(307);
      expect(first.headers.get('cache-control')).toContain('no-store');
      expect(first.headers.get('referrer-policy')).toBe('same-origin');
      expect(f.calls).toHaveLength(before); expect(f.lookups()).toBe(lookups);
      const final = new URL(first.headers.get('location')!, referer);
      expect(final.origin).toBe(f.origin);
      expect(final.pathname).toBe(new URL(path, referer).pathname);
      expect(final.searchParams.get('ezil_pv')).toBe(page.searchParams.get('ezil_pv'));
      const response = await f.get(final, { headers: { referer: referer.href } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(response.headers.get('referrer-policy')).toBe('same-origin');
      return { url: final, body: await response.text() };
    };
    const entry = await resource(/type="module" src="([^"]+)"/.exec(html)![1], page);
    await resource(new URL(/import "([^"]+)"/.exec(entry.body)![1], entry.url).href, entry.url);
    const css = await resource(/rel="stylesheet" href="([^"]+)"/.exec(html)![1], page);
    const theme = await resource(new URL(/@import "([^"]+)"/.exec(css.body)![1], css.url).href, css.url);
    await resource(new URL(/url\("([^"]+)"/.exec(theme.body)![1], theme.url).href, theme.url);

    const t = runTransport(html, page);
    await t.window.fetch(new Request(`${f.origin}/api/save?x=1`, { method: 'POST', body: 'fetch-body' }));
    const xhr = new t.XHR(); xhr.open('PUT', '/api/xhr?y=2', true);
    new t.window.WebSocket(`${f.origin.replace('https:', 'wss:')}/_next/webpack-hmr?hot=1`);
    for (const request of t.fetches) { expect(new URL(request.url).searchParams.get('ezil_pv')).toBe(page.searchParams.get('ezil_pv')); expect((await f.get(request.url, { method: request.method, body: await request.text(), headers: { referer: page.href } })).status).toBe(200); }
    expect(new URL(t.xhrs[0].url).searchParams.get('ezil_pv')).toBe(page.searchParams.get('ezil_pv'));
    expect(t.xhrs[0].rest).toEqual([true]);
    expect((await f.get(t.xhrs[0].url, { method: 'PUT', body: 'xhr-body', headers: { referer: page.href } })).status).toBe(200);
    expect(t.sockets[0].pathname).toBe('/_next/webpack-hmr');
    expect(t.sockets[0].searchParams.get('ezil_pv')).toBe(page.searchParams.get('ezil_pv'));
    t.sockets[0].protocol = 'https:';
    expect(await (await f.get(t.sockets[0], { headers: { upgrade: 'websocket', referer: page.href } })).text()).toBe('socket-upstream');
    expect(f.calls.map(c => c.path)).toEqual(['/', '/src/main.js', '/src/nested/dep.js', '/styles/main.css', '/styles/nested/theme.css', '/assets/bg.svg?size=2', '/api/save?x=1', '/api/xhr?y=2', '/_next/webpack-hmr?hot=1']);
    for (const call of f.calls) { expect(call.port).toBe(3002); expect(call.headers.get('referer')).toBeNull(); expect(call.path).not.toContain('ezil_pv'); }
    expect(f.calls[6].body).toBe('fetch-body'); expect(f.calls[7].body).toBe('xhr-body'); expect(f.calls[8].ws).toBe(true);
  });

  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) it(`preserves ${method} path/query/body across verified Referer 307`, async () => {
    const f = await fixture(provider), { page } = await f.boot();
    const init = { method, headers: { referer: page.href }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: 'keep-body' }) };
    const first = await f.get('/api/data?keep=a%2Fb', init);
    expect(first.status).toBe(307); expect(f.calls).toHaveLength(0);
    const next = await f.get(first.headers.get('location')!, init);
    expect(next.status).toBe(200);
    expect(f.calls[0]).toMatchObject({ method, path: '/api/data?keep=a%2Fb', body: init.body ?? '' });
  });

  for (const kind of ['missing', 'origin-only', 'no-referrer', 'foreign', 'wrong-signature', 'expired', 'sandbox-mismatch', 'invalid-direct', 'empty-direct', 'invalid-cookie', 'empty-cookie', 'duplicate-direct', 'invalid-direct-valid-cookie']) it(`fails closed: ${kind}`, async () => {
    const f = await fixture(provider), { page } = await f.boot();
    const headers = new Headers({ referer: page.href });
    const url = new URL('/src/main.js', f.origin);
    if (kind === 'missing' || kind === 'no-referrer') headers.delete('referer');
    if (kind === 'origin-only') headers.set('referer', f.origin + '/');
    if (kind === 'foreign') headers.set('referer', page.href.replace(f.origin, 'https://foreign.example'));
    if (['wrong-signature', 'expired', 'sandbox-mismatch'].includes(kind)) {
      page.searchParams.set('ezil_pv', await mintPreviewCookie(kind === 'wrong-signature' ? 'wrong' : SECRET,
        kind === 'sandbox-mismatch' ? 'guac-other-comp1' : SID, kind === 'expired' ? Date.now() - 7_200_000 : Date.now()));
      headers.set('referer', page.href);
    }
    if (kind.includes('direct')) url.searchParams.set('ezil_pv', kind === 'empty-direct' ? '' : 'invalid');
    if (kind === 'duplicate-direct') url.searchParams.append('ezil_pv', page.searchParams.get('ezil_pv')!);
    if (kind.includes('cookie')) headers.set('cookie', `ezil_preview=${kind === 'empty-cookie' ? '' : kind === 'invalid-direct-valid-cookie' ? page.searchParams.get('ezil_pv') : 'invalid'}`);
    for (const ws of [false, true]) {
      if (ws) headers.set('upgrade', 'websocket');
      const response = await f.get(url, { headers });
      expect(response.status).toBe(401); expect(response.headers.get('location')).toBeNull();
    }
    expect(f.calls).toHaveLength(0); expect(f.lookups()).toBe(0);
  });

  it('accepts direct tokens without Referer; the shim preserves explicit tokens and excludes foreign/downgrade URLs', async () => {
    const f = await fixture(provider), { page } = await f.boot(), response = await f.get(page);
    const t = runTransport(await response.text(), page);
    for (const url of ['https://external.example/data', f.origin.replace('https:', 'http:') + '/data', `${f.origin}/api?ezil_pv=invalid`]) await t.window.fetch(url);
    expect(t.fetches.map(r => r.url)).toEqual(['https://external.example/data', f.origin.replace('https:', 'http:') + '/data', `${f.origin}/api?ezil_pv=invalid`]);
    new t.window.WebSocket('wss://external.example/socket');
    new t.window.WebSocket(f.origin.replace('https:', 'ws:') + '/socket');
    expect(t.sockets.every(u => !u.searchParams.has('ezil_pv'))).toBe(true);
    expect((await f.get(`/api?ezil_pv=${encodeURIComponent(page.searchParams.get('ezil_pv')!)}`)).status).toBe(200);
  });

  for (const carrier of ['direct', 'cookie']) for (const kind of ['wrong-signature', 'expired', 'sandbox-mismatch']) it(`rejects ${kind} ${carrier} despite a valid Referer token`, async () => {
    const f = await fixture(provider), { page } = await f.boot();
    const bad = await mintPreviewCookie(kind === 'wrong-signature' ? 'wrong' : SECRET,
      kind === 'sandbox-mismatch' ? 'guac-other-comp1' : SID, kind === 'expired' ? Date.now() - 7_200_000 : Date.now());
    const url = new URL('/api/data', f.origin), headers = new Headers({ referer: page.href });
    if (carrier === 'direct') url.searchParams.set('ezil_pv', bad);
    else { headers.set('cookie', `ezil_preview=${bad}`); url.searchParams.set('ezil_pv', page.searchParams.get('ezil_pv')!); }
    for (const ws of [false, true]) {
      if (ws) headers.set('upgrade', 'websocket');
      const res = await f.get(url, { headers });
      expect(res.status).toBe(401); expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
    expect(f.calls).toHaveLength(0); expect(f.lookups()).toBe(0);
  });

  it('refuses Referer authority tricks and preserves a direct token over an unrelated Referer', async () => {
    const f = await fixture(provider), { page } = await f.boot();
    const token = page.searchParams.get('ezil_pv')!;
    for (const referer of [f.origin, f.origin.replace('https:', 'http:') + page.pathname + page.search,
      page.href.replace('https://', 'https://user:pass@'), page.href + '&ezil_pv=' + encodeURIComponent(token), 'not a URL']) {
      expect((await f.get('/src/main.js', { headers: { referer } })).status).toBe(401);
    }
    expect((await f.get('//evil.example/x', { headers: { referer: page.href } }))).toBeNull();
    const dangerous = await f.get(f.origin + '//evil.example/x', { headers: { referer: page.href } });
    expect(dangerous.status).toBe(401); expect(dangerous.headers.get('location')).toBeNull();
    expect(f.calls).toHaveLength(0);
    const res = await f.get(`/api/data?keep=1&ezil_pv=${encodeURIComponent(token)}`, { headers: { referer: 'https://external.example/?access_token=secret' } });
    expect(res.status).toBe(200); expect(f.calls[0].path).toBe('/api/data?keep=1'); expect(f.calls[0].headers.get('referer')).toBeNull();
  });

  it('tokenized resources and sockets do not require a Referer', async () => {
    const f = await fixture(provider), { page } = await f.boot();
    const path = '/api/no-referrer?ezil_pv=' + encodeURIComponent(page.searchParams.get('ezil_pv')!);
    expect((await f.get(path, { referrerPolicy: 'no-referrer' })).status).toBe(200);
    expect(await (await f.get(path, { referrerPolicy: 'no-referrer', headers: { upgrade: 'websocket' } })).text()).toBe('socket-upstream');
    expect(f.calls.map(c => c.path)).toEqual(['/api/no-referrer', '/api/no-referrer']);
  });

  it('does not extend Referer carriage to Code, desktop or control hosts', async () => {
    const f = await fixture(provider), { page } = await f.boot();
    const token = page.searchParams.get('ezil_pv')!;
    for (const port of [8443, 8080, 8181]) {
      const origin = provider === 'aws' ? `https://aws-${port}-${SID}-aws.${ROOT}` : `https://${port}-${SID}-${port === 8443 ? 'code' : 'desktop'}.${ROOT}`;
      const res = await f.get(origin + '/asset.js', { headers: { referer: origin + '/?ezil_pv=' + encodeURIComponent(token) } });
      if (provider === 'aws' || port === 8443) expect(res.status).toBe(401); else expect(res).toBeNull();
    }
    for (const host of [`api-desktop.${ROOT}`, `3000-${SID}-app.${ROOT}`, `3003-${SID}-app.${ROOT}`, `8443-${SID}-app.${ROOT}`, `3002-${SID}-code.${ROOT}`]) {
      expect(await f.get(`https://${host}/api`, { headers: { referer: page.href } })).toBeNull();
    }
    expect(f.calls).toHaveLength(0);
  });

  it('cookie auth still works; no-token HTML installs no request wrappers', async () => {
    const f = await fixture(provider), cookie = await mintPreviewCookie(SECRET, SID, undefined, 'app');
    const response = await f.get('/', { headers: { cookie: `ezil_preview=${cookie}; app=keep`, referer: f.origin + '/plain' } });
    expect(response.status).toBe(200);
    const html = await response.text(), t = runTransport(html, new URL('/', f.origin));
    expect(html).not.toContain(cookie); expect(t.window.fetch).toBe(t.originalFetch);
    expect(t.window.WebSocket).toBe(t.originalWS); expect(t.XHR.prototype.open).toBe(t.originalOpen);
    expect(f.calls[0].headers.get('cookie')).toBe('app=keep'); expect(f.calls[0].headers.get('referer')).toBe(f.origin + '/plain');
  });
});

describe('CF app routing segregation', () => {
  it('keeps legacy HTTP/WS stripping and root paths on fixed 3002', async () => {
    const f = await fixture('cf'), { page } = await f.boot(), headers = { cookie: `ezil_preview=${page.searchParams.get('ezil_pv')}` };
    for (const path of ['/preview', '/preview/src/main.js', '/src/main.js', '/_next/static/chunk.js', '/assets/icon.svg', '/api/save']) expect((await f.get(path, { headers })).status).toBe(200);
    for (const path of ['/preview-ws', '/preview-ws/@vite/client', '/socket', '/_next/webpack-hmr']) expect(await (await f.get(path, { headers: { ...headers, upgrade: 'WebSocket' } })).text()).toBe('socket-upstream');
    expect(f.calls.map(c => c.path)).toEqual(['/', '/src/main.js', '/src/main.js', '/_next/static/chunk.js', '/assets/icon.svg', '/api/save', '/', '/@vite/client', '/socket', '/_next/webpack-hmr']);
    expect(f.calls.every(c => c.port === 3002)).toBe(true);
  });
  it('reserves bootstrap/status/inspector and keeps Code/control separate', async () => {
    const f = await fixture('cf'), { page } = await f.boot();
    expect((await f.get('/preview-status', { headers: { referer: page.href } })).status).toBe(401);
    expect((await f.get('/preview-bootstrap?token=invalid', { headers: { referer: page.href } })).status).toBe(401);
    expect((await f.get('/preview-inspector.js?ezil_pv=' + encodeURIComponent(page.searchParams.get('ezil_pv')!))).headers.get('content-type')).toContain('javascript');
    const code = `https://8443-${SID}-code.${ROOT}`;
    const appToken = page.searchParams.get('ezil_pv')!;
    expect((await f.get(code + '/asset.js', { headers: { referer: code + '/?ezil_pv=' + appToken } })).status).toBe(401);
    // The app's value is readable by project code (location.search), so it never opens this sandbox's code-server,
    // as a cookie or as the Code query fallback; only Code's own value does.
    expect((await f.get(code + '/asset.js', { headers: { cookie: `ezil_preview=${appToken}` } })).status).toBe(401);
    expect((await f.get(code + '/asset.js?ezil_pv=' + encodeURIComponent(appToken))).status).toBe(401);
    expect(f.calls).toHaveLength(0);
    expect((await f.get(code + '/asset.js', { headers: { cookie: `ezil_preview=${await mintPreviewCookie(SECRET, SID)}` } })).status).toBe(200);
    expect(f.calls).toHaveLength(1); expect(f.calls[0].port).toBe(8443);
    expect(await f.get(`https://api-desktop.${ROOT}/src/main.js`, { headers: { referer: page.href } })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
});
