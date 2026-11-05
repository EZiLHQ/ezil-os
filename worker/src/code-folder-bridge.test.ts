import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';

import { handleAwsBrowserHost, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import {
  BRIDGE_MARKER,
  codeFolderBridgeScript,
  GO_FALLBACK_MS,
  injectCodeFolderBridge,
  isHtmlDocument,
  isWorkbenchDocumentRequest,
  parseShellOrigins,
} from './code-folder-bridge';
import { CODE_PREVIEW_PORT, CODE_PREVIEW_TOKEN } from './desktop-mode';
import { mintPreviewCookie } from './hmac';
import { handlePreviewProxy, type ContainerFetcher } from './preview-bridge';
import vectors from './aws-gateway.vectors.json';

const SHELL = 'https://os-staging.ezil.work';
const EDITOR = 'https://8443-guac-u-c-code.ezil.work';

/** The shape of code-server 4.141's workbench.html head: nonce'd inline scripts, a CSP header elsewhere. */
const WORKBENCH = `<!-- Copyright (C) Microsoft Corporation. All rights reserved. -->
<!DOCTYPE html>
<html>
\t<head>
\t\t<script nonce="0f3c1e9a-8b7d-4c2e-9f10-3a5b6c7d8e9f">
\t\t\tperformance.mark('code/didStartRenderer');
\t\t</script>
\t\t<meta charset="utf-8" />
\t</head>
\t<body aria-label=""></body>
\t<script nonce="0f3c1e9a-8b7d-4c2e-9f10-3a5b6c7d8e9f">globalThis._VSCODE_FILE_ROOT = '/out/';</script>
\t<script type="module" src="/stable-1/static/out/vs/code/browser/workbench/workbench.js"></script>
</html>`;

describe('parseShellOrigins', () => {
  it('takes plain https origins, comma separated, deduplicated', () => {
    expect(parseShellOrigins(SHELL)).toEqual([SHELL]);
    expect(parseShellOrigins(` ${SHELL} , https://os.ezil.work,${SHELL}`)).toEqual([SHELL, 'https://os.ezil.work']);
  });
  it('anything else voids the whole list: no bridge rather than a wider or narrower one', () => {
    for (const bad of [undefined, null, '', ' , ', 'http://os-staging.ezil.work', 'https://os-staging.ezil.work/', 'https://os-staging.ezil.work:8443',
      'https://*.ezil.work', 'https://user@os.ezil.work', 'https://OS.ezil.work', 'os-staging.ezil.work', `${SHELL},*`, `${SHELL},javascript:alert(1)`,
      'https://localhost', ['a', 'b', 'c', 'd', 'e'].map((h) => `https://${h}.ezil.work`).join(',')]) {
      expect(parseShellOrigins(bad as string | undefined)).toEqual([]);
    }
  });
});

describe('injectCodeFolderBridge', () => {
  it('adds one script first in <head>, with the page\'s own nonce, and nothing else changes', () => {
    const out = injectCodeFolderBridge(WORKBENCH, [SHELL]);
    const tag = `<script nonce="0f3c1e9a-8b7d-4c2e-9f10-3a5b6c7d8e9f" ${BRIDGE_MARKER}="1">`;
    expect(out.indexOf(tag)).toBeGreaterThan(out.indexOf('<head>'));
    expect(out.indexOf(tag)).toBeLessThan(out.indexOf("performance.mark('code/didStartRenderer')"));
    expect(out.split(BRIDGE_MARKER).length - 1).toBe(1);
    expect(out.replace(/\n<script nonce="[^"]*" data-ezil-folder-bridge="1">[\s\S]*?<\/script>/, '')).toBe(WORKBENCH);
    expect(out).toContain(JSON.stringify([SHELL]));
  });
  it('is idempotent and inert without origins, without a usable nonce or without a <head>', () => {
    const once = injectCodeFolderBridge(WORKBENCH, [SHELL]);
    expect(injectCodeFolderBridge(once, [SHELL])).toBe(once);
    expect(injectCodeFolderBridge(WORKBENCH, [])).toBe(WORKBENCH);
    const noNonce = WORKBENCH.replaceAll(/ nonce="[^"]*"/g, '');
    expect(injectCodeFolderBridge(noNonce, [SHELL])).toBe(noNonce);
    const quoteNonce = WORKBENCH.replace('0f3c1e9a-8b7d-4c2e-9f10-3a5b6c7d8e9f', 'x" onload="alert(1)');
    expect(injectCodeFolderBridge(quoteNonce, [SHELL])).toBe(quoteNonce);
    const noHead = WORKBENCH.replace('<head>', '').replace('</head>', '');
    expect(injectCodeFolderBridge(noHead, [SHELL])).toBe(noHead);
  });
  it('the script never closes its own tag and never targets "*"', () => {
    const script = codeFolderBridgeScript([SHELL]);
    expect(script).not.toMatch(/<\/|<!--/);
    expect(script).not.toContain('"*"');
    expect(script).not.toContain("'*'");
  });
});

describe('isWorkbenchDocumentRequest / isHtmlDocument', () => {
  it('only a GET of code-server\'s root, never an upgrade', () => {
    expect(isWorkbenchDocumentRequest('GET', '/', null)).toBe(true);
    expect(isWorkbenchDocumentRequest('get', '/', '')).toBe(true);
    for (const [m, p, u] of [['POST', '/', null], ['GET', '/stable-1/static/out/vs/workbench/contrib/webview/browser/pre/index.html', null],
      ['GET', '/callback', null], ['GET', '//', null], ['GET', '/', 'websocket']] as const) {
      expect(isWorkbenchDocumentRequest(m, p, u)).toBe(false);
    }
  });
  it('only a 2xx text/html answer', () => {
    expect(isHtmlDocument(200, 'text/html; charset=utf-8')).toBe(true);
    expect(isHtmlDocument(302, 'text/html')).toBe(false);
    expect(isHtmlDocument(200, 'application/json')).toBe(false);
    expect(isHtmlDocument(200, null)).toBe(false);
  });
});

// ── The script itself, run against a stand-in window ─────────────────────────────────────────────────────────────

interface Posted { m: Record<string, unknown>; o: string }
function run(opts: { search?: string; pathname?: string; framed?: boolean; navigation?: boolean; origins?: string[] } = {}) {
  const { search = '?folder=/workspace/a&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA', pathname = '/', framed = true, navigation = true, origins = [SHELL] } = opts;
  const posted: Posted[] = [];
  const replaced: string[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared?: boolean }> = [];
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const navListeners: Array<(ev: unknown) => void> = [];
  const parent = { postMessage: (m: Record<string, unknown>, o: string) => posted.push({ m: structuredClone(m), o }) };
  const g: Record<string, unknown> = {
    URLSearchParams, URL, crypto, btoa, Uint8Array, Map, String, JSON,
    location: { search, pathname, origin: EDITOR, replace: (u: string) => replaced.push(u) },
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: (id: number) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    addEventListener: (type: string, fn: (ev: unknown) => void) => { (listeners[type] ??= []).push(fn); },
  };
  g.window = g;
  g.parent = framed ? parent : g;
  if (navigation) g.navigation = { addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === 'navigate') navListeners.push(fn); } };
  runInNewContext(codeFolderBridgeScript(origins), g);
  const message = (data: unknown, over: { source?: unknown; origin?: string } = {}) =>
    (listeners.message ?? []).forEach((fn) => fn({ source: over.source ?? parent, origin: over.origin ?? SHELL, data }));
  const navigate = (url: string, over: Record<string, unknown> = {}) => {
    const ev = { navigationType: 'push', cancelable: true, hashChange: false, downloadRequest: null, destination: { url }, prevented: false,
      preventDefault() { this.prevented = true; }, ...over };
    navListeners.forEach((fn) => fn(ev));
    return ev;
  };
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  return { posted, replaced, timers, message, navigate, fire, parent, navListeners };
}
const NONCE = 'BBBBBBBBBBBBBBBBBBBBBB';

describe('the bridge script', () => {
  it('does nothing at all when not framed', () => {
    const b = run({ framed: false });
    expect(b.posted).toEqual([]);
    expect(b.navListeners.length).toBe(0);
  });
  it('says ready to each allowed origin, and nowhere else', () => {
    const b = run({ origins: [SHELL, 'https://os.ezil.work'] });
    expect(b.posted).toEqual([{ m: { type: 'ezil.code.ready', v: 1 }, o: SHELL }, { m: { type: 'ezil.code.ready', v: 1 }, o: 'https://os.ezil.work' }]);
  });
  it('answers a valid hello with its own folder, mint and base', () => {
    const b = run({ search: '?folder=/workspace/my%20site/%E6%97%A5&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA', pathname: '/preview/' });
    b.posted.length = 0;
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE });
    expect(b.posted).toEqual([{ m: { type: 'ezil.code.folder', v: 1, nonce: NONCE, mint: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'folder', path: '/workspace/my site/日', base: '/preview/' }, o: SHELL }]);
  });
  it('reports each kind from its own address', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['?ew=true', { kind: 'empty', base: '/' }],
      ['', { kind: 'empty', base: '/' }],
      ['?workspace=/home/coder/.local/share/code-server/User/Workspaces/1/workspace.json', { kind: 'workspace' }],
      ['?folder=vscode-vfs%3A%2F%2Fgithub%2Fx', { kind: 'foreign' }],
      ['?folder=/a+b', { kind: 'folder', path: '/a b', base: '/' }],
    ];
    for (const [search, report] of cases) {
      const b = run({ search });
      b.posted.length = 0;
      b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE });
      expect(b.posted[0]!.m).toEqual({ type: 'ezil.code.folder', v: 1, nonce: NONCE, mint: null, ...report });
    }
  });
  it('ignores a hello from another window, another origin, a bad nonce or another version', () => {
    const b = run();
    b.posted.length = 0;
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE }, { source: {} });
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE }, { origin: 'https://evil.example' });
    b.message({ type: 'ezil.code.hello', v: 1, nonce: 'short' });
    b.message({ type: 'ezil.code.hello', v: 2, nonce: NONCE });
    b.message('ezil.code.hello');
    expect(b.posted).toEqual([]);
  });
  it('turns the editor\'s own folder switch into: ask the shell, then replace on its "go"', () => {
    const b = run();
    b.posted.length = 0;
    const ev = b.navigate(`${EDITOR}/?folder=/workspace/b`);
    expect(ev.prevented).toBe(true);
    expect(b.replaced).toEqual([]);
    const open = b.posted[0]!;
    expect(open.o).toBe(SHELL);
    expect(open.m).toMatchObject({ type: 'ezil.code.open', v: 1, kind: 'folder', path: '/workspace/b' });
    expect(String(open.m.id)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    b.message({ type: 'ezil.code.go', v: 1, id: 'CCCCCCCCCCCCCCCCCCCCCC' }); // not its id
    expect(b.replaced).toEqual([]);
    b.message({ type: 'ezil.code.go', v: 1, id: open.m.id }, { origin: 'https://evil.example' });
    expect(b.replaced).toEqual([]);
    b.message({ type: 'ezil.code.go', v: 1, id: open.m.id });
    expect(b.replaced).toEqual([`${EDITOR}/?folder=/workspace/b`]);
    b.message({ type: 'ezil.code.go', v: 1, id: open.m.id }); // once
    b.fire(); // its fallback was cleared
    expect(b.replaced.length).toBe(1);
  });
  it('Close Folder and a workspace are asked for too; without a "go" the editor replaces by itself', () => {
    for (const [dest, kind] of [['/?ew=true', 'empty'], ['/?workspace=/w.code-workspace', 'workspace']] as const) {
      const b = run();
      b.posted.length = 0;
      expect(b.navigate(`${EDITOR}${dest}`).prevented).toBe(true);
      expect(b.posted[0]!.m).toMatchObject({ type: 'ezil.code.open', kind });
      expect(b.timers[0]!.ms).toBe(GO_FALLBACK_MS);
      b.fire();
      expect(b.replaced).toEqual([`${EDITOR}${dest}`]);
    }
  });
  it('leaves every other navigation alone', () => {
    const b = run();
    const others: Array<[string, Record<string, unknown>]> = [
      [`${EDITOR}/?folder=/x`, { navigationType: 'replace' }],
      [`${EDITOR}/?folder=/x`, { navigationType: 'reload' }],
      [`${EDITOR}/?folder=/x`, { navigationType: 'traverse' }],
      [`${EDITOR}/?folder=/x`, { cancelable: false }],
      [`${EDITOR}/?folder=/x#y`, { hashChange: true }],
      [`${EDITOR}/?folder=/x`, { downloadRequest: 'f' }],
      [`${EDITOR}/other?folder=/x`, {}],
      ['https://evil.example/?folder=/x', {}],
      [`${EDITOR}/?q=1`, {}],
    ];
    for (const [url, over] of others) expect(b.navigate(url, over).prevented).toBe(false);
    expect(b.replaced).toEqual([]);
  });
  it('without the Navigation API it still reports, and the editor switches as it always did', () => {
    const b = run({ navigation: false });
    expect(b.navListeners.length).toBe(0);
    b.posted.length = 0;
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE });
    expect(b.posted[0]!.m).toMatchObject({ kind: 'folder', path: '/workspace/a' });
  });
});

// ── Where the Worker puts it ──────────────────────────────────────────────────────────────────────────────────────

describe('Cloudflare code host (handlePreviewProxy, code target)', () => {
  const SECRET = 'bridge-test-secret';
  const SID = 'guac-user1-proj1';
  const fetcher = (body: string, type = 'text/html; charset=utf-8', status = 200): ContainerFetcher => ({
    async containerFetch() { return new Response(body, { status, headers: { 'content-type': type } }); },
  });
  const get = async (path: string, codePath: string, origins: string[], f = fetcher(WORKBENCH)) => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const req = new Request(`https://${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.work${path}`, { headers: { cookie: `ezil_preview=${cookie}` } });
    return handlePreviewProxy(req, f, SID, [SECRET], codePath, CODE_PREVIEW_PORT, 'code', origins);
  };
  it('the workbench document gets the bridge', async () => {
    const res = await get('/preview/?folder=/workspace', '/', [SHELL]);
    expect(await res.text()).toContain(BRIDGE_MARKER);
  });
  it('no origin configured, another document, another type or status: untouched', async () => {
    expect(await (await get('/preview/?folder=/workspace', '/', [])).text()).toBe(WORKBENCH);
    expect(await (await get('/stable-1/static/out/vs/workbench/contrib/webview/browser/pre/index.html', '/stable-1/static/out/vs/workbench/contrib/webview/browser/pre/index.html', [SHELL])).text()).toBe(WORKBENCH);
    expect(await (await get('/preview/', '/', [SHELL], fetcher(WORKBENCH, 'text/plain'))).text()).toBe(WORKBENCH);
    expect(await (await get('/preview/', '/', [SHELL], fetcher(WORKBENCH, 'text/html', 500))).text()).toBe(WORKBENCH);
  });
  it('the app target never gets it', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const req = new Request(`https://3002-${SID}-app.ezil.work/preview/`, { headers: { cookie: `ezil_preview=${cookie}` } });
    const res = await handlePreviewProxy(req, fetcher(WORKBENCH), SID, [SECRET], '/', 3002, 'app', [SHELL]);
    expect(await res.text()).not.toContain(BRIDGE_MARKER);
  });
});

describe('AWS code port (handleAwsBrowserHost)', () => {
  const SECRET = 'aws-bridge-secret';
  const SID = 'guac-0a0a0a0a0a0a0a0a-0b0b0b0b0b0b4b0b';
  const ROOT = 'preview.example.org';
  const ZONE = 'origin.example.net';
  const record = (): AwsTunnelRecord => ({
    computerId: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c', sandboxId: SID, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0',
    region: 'ap-south-1', publicIp: '13.200.1.2', tunnelId: 't-1', dnsRecordId: 'd-1', hostname: `c-${SID}-g1-e2.${ZONE}`,
    controlKey: vectors.controlKeyBase64, createdAt: 1, originVerified: true, originVerifiedAt: Date.now(),
  });
  const call = async (port: number, path: string, answer: Response, origins: string[] = [SHELL], init: RequestInit = {}) => {
    const fetch: FetchLike = async () => answer;
    const cookie = `ezil_preview=${await mintPreviewCookie(SECRET, SID)}`;
    const host = `aws-${port}-${SID}-aws.${ROOT}`;
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    return (await handleAwsBrowserHost(new Request(`https://${host}${path}`, { ...init, headers }), new URL(`https://${host}${path}`), {
      routingEnabled: true, zone: ZONE, secrets: [SECRET], zoneRoot: ROOT, lookup: async () => record(), fetch, nowMs: Date.now,
      codeShellOrigins: origins,
    }))!;
  };
  const html = () => new Response(WORKBENCH, { headers: { 'content-type': 'text/html', 'content-length': String(WORKBENCH.length), 'x-keep': '1' } });
  it('the workbench document gets the bridge, without its stale length', async () => {
    const res = await call(CODE_PREVIEW_PORT, '/?folder=/workspace', html());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(BRIDGE_MARKER);
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('x-keep')).toBe('1');
  });
  it('other ports, paths, methods and answers pass through untouched', async () => {
    expect(await (await call(CODE_PREVIEW_PORT, '/?folder=/workspace', html(), [])).text()).toBe(WORKBENCH);
    expect(await (await call(CODE_PREVIEW_PORT, '/stable-1/x.html', html())).text()).toBe(WORKBENCH);
    expect(await (await call(3002, '/', html())).text()).toBe(WORKBENCH);
    const redirect = await call(CODE_PREVIEW_PORT, '/', new Response(null, { status: 302, headers: { location: './?folder=/workspace' } }));
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('./?folder=/workspace');
  });
});
