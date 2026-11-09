import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { DIAG_BRIDGE_MARKER } from './code-diag-bridge';

import { handleAwsBrowserHost, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import {
  BRIDGE_MARKER,
  codeShellOriginsFor,
  codeFolderBridgeScript,
  GO_FALLBACK_MS,
  injectCodeFolderBridge,
  isHtmlDocument,
  isWorkbenchDocumentRequest,
  LEGACY_NOTICE_HIDE_CSS,
  LEGACY_NOTICE_MARKER,
  parseShellOrigins,
} from './code-folder-bridge';
import { CODE_PREVIEW_PORT, CODE_PREVIEW_TOKEN } from './desktop-mode';
import { mintPreviewCookie } from './hmac';
import { handlePreviewProxy, stripFrameAncestors, type ContainerFetcher } from './preview-bridge';
import vectors from './aws-gateway.vectors.json';

const SHELL = 'https://os-staging.ezil.work';
/** Production's app (.github/scripts/release-state.mjs `canonical`; pinned below). */
const PROD_SHELL = 'https://os.ezil.work';
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
/** code-server 4.141's served workbench CSP, as both editor images (67c939f0, 2031b2c1) send it (measured 2026-11-05). */
const SERVED_CSP = "default-src 'self'; img-src 'self' https: data: blob:; media-src 'self'; script-src 'self' 'unsafe-eval'  blob: "
  + "'nonce-0f3c1e9a-8b7d-4c2e-9f10-3a5b6c7d8e9f' 'sha256-daEgfo2VIXpx2Np71KqCCbkeQwv+68vPrx54XRcbdcs=' "
  + "'sha256-/r7rqQ+yrxt57sxLuQ6AMYcy/lUpvAIzHjIJt/OeLWU=' ; child-src 'self'; frame-src 'self' https://*.vscode-cdn.net data:; "
  + "worker-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss: https:; font-src 'self' blob:; manifest-src 'self';";
/** The notice rule in the older image's workbench.css (AMI 1.0.30, desktop 67c939f0), verbatim. */
const LEGACY_NOTICE_RULE = '.chat-viewpane .interactive-session>.interactive-input-part::after{content:"AI responses may be inaccurate. '
  + 'Review changes before applying them.";display:block;padding:2px 4px 0;font-size:11px;line-height:16px;'
  + 'color:var(--vscode-descriptionForeground);text-align:center}';
const LEGACY_STYLE = `<style ${LEGACY_NOTICE_MARKER}="1">${LEGACY_NOTICE_HIDE_CSS}</style>`;

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

describe('codeShellOriginsFor (no setting of its own: the existing preview zone picks the realm)', () => {
  it('staging\'s zone has the staging shell, read the way resolvePreviewZoneRoot reads it', () => {
    expect(codeShellOriginsFor('ezil.work')).toEqual([SHELL]);
    expect(codeShellOriginsFor(' EZIL.WORK ')).toEqual([SHELL]);
  });
  it('production (unset, or its own ezil.org) has exactly the production app\'s origin', () => {
    for (const zone of [undefined, 'ezil.org', ' EZIL.ORG ']) expect(codeShellOriginsFor(zone)).toEqual([PROD_SHELL]);
  });
  it('anything else: no origins, so no bridge (never the former host, the provider alias or a shell host as a zone)', () => {
    for (const zone of ['', 'evil.work', 'os.ezil.org', 'os.ezil.work', 'os-staging.ezil.work', 'ezil-os-preview-ezil1.vercel.app',
      'ezil.org.evil.example', 'constructor', '__proto__', 'toString']) {
      expect(codeShellOriginsFor(zone)).toEqual([]);
    }
    expect(codeShellOriginsFor(null as unknown as string)).toEqual([]);
  });
  it('production\'s origin IS the release contract\'s canonical public origin, and its editors are on ezil.org', () => {
    const release = readFileSync(new URL('../../.github/scripts/release-state.mjs', import.meta.url), 'utf8');
    const canonical = /^export const canonical = '([^']+)';$/m.exec(release)?.[1];
    expect(canonical).toBe(PROD_SHELL);
    expect(codeShellOriginsFor(undefined)).toEqual([canonical!]);
    // The production Worker's code hosts (default env, no zone override) are the zone the table keys on.
    const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const top = wrangler.slice(0, wrangler.indexOf('[env.staging]'));
    for (const route of ['*-code.ezil.org/*', '*-aws.ezil.org/*']) expect(top).toContain(`pattern = "${route}"`);
    expect(top).not.toMatch(/^SANDBOX_PREVIEW_ZONE_ROOT\s*=/m);
  });
});

describe('the bridge script in production (parent https://os.ezil.work, editor on ezil.org)', () => {
  const prod = () => run({ origins: codeShellOriginsFor(undefined), origin: PROD_SHELL });
  it('says ready to the production app only', () => {
    expect(prod().posted).toEqual([{ m: { type: 'ezil.code.ready', v: 1 }, o: PROD_SHELL }]);
  });
  it('round trip: a hello from the production app is answered there with the folder, byte for byte', () => {
    const b = run({ origins: codeShellOriginsFor(undefined), origin: PROD_SHELL,
      search: '?folder=/workspace/my%20site/%E6%97%A5&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA', pathname: '/' });
    b.posted.length = 0;
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE });
    expect(b.posted).toEqual([{ m: { type: 'ezil.code.folder', v: 1, nonce: NONCE, mint: 'AAAAAAAAAAAAAAAAAAAAAA', kind: 'folder',
      path: '/workspace/my site/日', base: '/' }, o: PROD_SHELL }]);
  });
  it('a hello from the former host, the provider alias, staging or another window is never answered', () => {
    const b = prod();
    b.posted.length = 0;
    for (const origin of ['https://os.ezil.org', 'https://ezil-os-preview-ezil1.vercel.app', SHELL, 'http://os.ezil.work',
      'https://os.ezil.work.evil.example']) {
      b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE }, { origin });
    }
    const stranger: Posted[] = [];
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE }, { source: { postMessage: (m: Record<string, unknown>, o: string) => stranger.push({ m, o }) } });
    expect(stranger).toEqual([]);
    expect(b.posted).toEqual([]);
  });
});

describe('injectCodeFolderBridge', () => {
  it('adds one script right after the head\'s <meta charset>, with the page\'s own nonce, and nothing else changes', () => {
    const out = injectCodeFolderBridge(WORKBENCH, [SHELL]);
    const tag = `<script nonce="0f3c1e9a-8b7d-4c2e-9f10-3a5b6c7d8e9f" ${BRIDGE_MARKER}="1">`;
    const meta = '<meta charset="utf-8" />';
    expect(out.indexOf(tag)).toBe(out.indexOf(meta) + meta.length + 1);
    // The charset declaration stays where code-server put it, inside the first 1024 bytes (review N2).
    expect(out.indexOf(meta)).toBe(WORKBENCH.indexOf(meta));
    expect(out.indexOf(meta)).toBeLessThan(1024);
    expect(out.indexOf(tag)).toBeLessThan(out.indexOf('globalThis._VSCODE_FILE_ROOT'));
    expect(out.split(BRIDGE_MARKER).length - 1).toBe(1);
    expect(out.replace(/\n<script nonce="[^"]*" data-ezil-folder-bridge="1">[\s\S]*?<\/script><style data-ezil-legacy-notice="1">[^<]*<\/style>/, ''))
      .toBe(WORKBENCH);
    expect(out).toContain(JSON.stringify([SHELL]));
  });
  it('without a <meta charset> in the head, the script goes first in <head>', () => {
    for (const html of [WORKBENCH.replace('<meta charset="utf-8" />', ''), WORKBENCH.replace('<meta charset="utf-8" />', '').replace('</head>', '</head><meta charset="utf-8">')]) {
      const out = injectCodeFolderBridge(html, [SHELL]);
      expect(out.indexOf(BRIDGE_MARKER)).toBeGreaterThan(out.indexOf('<head>'));
      expect(out.indexOf(BRIDGE_MARKER)).toBeLessThan(out.indexOf("performance.mark('code/didStartRenderer')"));
    }
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

describe('the older image\'s composer notice (hidden by the same insertion)', () => {
  it('one plain style follows the bridge in <head>, before every workbench stylesheet and script', () => {
    const out = injectCodeFolderBridge(WORKBENCH, [SHELL]);
    expect(out.split(LEGACY_NOTICE_MARKER).length - 1).toBe(1);
    expect(out).toContain(`</script>${LEGACY_STYLE}`);
    expect(out.indexOf(LEGACY_STYLE)).toBeLessThan(out.indexOf('</head>'));
    // No nonce of its own: the served CSP allows inline styles ('unsafe-inline', no style nonce), as for
    // code-server's own startup-fallback <style>.
    expect(SERVED_CSP).toContain("style-src 'self' 'unsafe-inline';");
    expect(LEGACY_STYLE).not.toContain('nonce');
  });
  it('hides exactly the generated box of the older image\'s rule, and nothing else', () => {
    const selector = (rule: string) => rule.slice(0, rule.indexOf('{'));
    expect(selector(LEGACY_NOTICE_HIDE_CSS)).toBe(selector(LEGACY_NOTICE_RULE));
    expect(LEGACY_NOTICE_HIDE_CSS.slice(LEGACY_NOTICE_HIDE_CSS.indexOf('{'))).toBe('{content:none!important;display:none!important}');
    // One rule, on that pseudo-element only: never the input, its toolbars, the welcome message or another notice.
    expect(LEGACY_NOTICE_HIDE_CSS.split('{').length - 1).toBe(1);
    expect(LEGACY_NOTICE_HIDE_CSS).not.toMatch(/[<@,]|welcome|chat-input-container|monaco|ezil-chat/);
  });
  it('nowhere without the bridge: production (no origins), no usable nonce, no <head>, or a second pass', () => {
    expect(injectCodeFolderBridge(WORKBENCH, [])).not.toContain(LEGACY_NOTICE_MARKER);
    expect(injectCodeFolderBridge(WORKBENCH.replaceAll(/ nonce="[^"]*"/g, ''), [SHELL])).not.toContain(LEGACY_NOTICE_MARKER);
    expect(injectCodeFolderBridge(WORKBENCH.replace('<head>', '').replace('</head>', ''), [SHELL])).not.toContain(LEGACY_NOTICE_MARKER);
    const once = injectCodeFolderBridge(WORKBENCH, [SHELL]);
    expect(injectCodeFolderBridge(once, [SHELL]).split(LEGACY_NOTICE_MARKER).length - 1).toBe(1);
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
function run(opts: { search?: string; pathname?: string; framed?: boolean; navigation?: boolean; origins?: string[]; origin?: string } = {}) {
  const { search = '?folder=/workspace/a&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA', pathname = '/', framed = true, navigation = true, origins = [SHELL],
    origin: parentOrigin = SHELL } = opts;
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
    (listeners.message ?? []).forEach((fn) => fn({ source: over.source ?? parent, origin: over.origin ?? parentOrigin, data }));
  const navigate = (url: string, over: Record<string, unknown> = {}) => {
    const ev = { navigationType: 'push', cancelable: true, hashChange: false, downloadRequest: null, destination: { url }, prevented: false,
      preventDefault() { this.prevented = true; }, ...over };
    navListeners.forEach((fn) => fn(ev));
    return ev;
  };
  const fire = () => { for (const t of timers.splice(0)) if (!t.cleared) t.fn(); };
  const unload = () => (listeners.beforeunload ?? []).forEach((fn) => fn({}));
  return { posted, replaced, timers, message, navigate, fire, unload, parent, navListeners };
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
    // Another window that COULD be answered: a reply to it would land in `stranger` (review N1: an object without
    // postMessage would only make the reply throw, which hid a missing source check).
    const stranger: Posted[] = [];
    b.message({ type: 'ezil.code.hello', v: 1, nonce: NONCE }, { source: { postMessage: (m: Record<string, unknown>, o: string) => stranger.push({ m, o }) } });
    expect(stranger).toEqual([]);
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
    b.message({ type: 'ezil.code.go', v: 1, id: open.m.id }, { source: { postMessage: () => {} } }); // not the parent (review N1)
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
  it('says it is leaving at its beforeunload, to the allowed origins only, and never vetoes', () => {
    const b = run();
    b.posted.length = 0;
    b.unload();
    expect(b.posted).toEqual([{ m: { type: 'ezil.code.leaving', v: 1 }, o: SHELL }]);
    expect(codeFolderBridgeScript([SHELL])).not.toMatch(/preventDefault\(\)[^;]*returnValue|returnValue/);
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
    const body = await res.text();
    expect(body).toContain(BRIDGE_MARKER);
    expect(body).toContain(DIAG_BRIDGE_MARKER);
  });
  it('and the legacy-notice style, with every header (CSP included) as without the injection', async () => {
    const f: ContainerFetcher = {
      async containerFetch() { return new Response(WORKBENCH, { headers: { 'content-type': 'text/html', 'content-security-policy': SERVED_CSP } }); },
    };
    const res = await get('/preview/?folder=/workspace', '/', [SHELL], f);
    const plain = await get('/preview/?folder=/workspace', '/', [], f);
    expect([...res.headers]).toEqual([...plain.headers]);
    // This host's existing rewrite only drops frame-ancestors and re-joins the directives; style-src is code-server's.
    expect(res.headers.get('content-security-policy')).toBe(stripFrameAncestors(SERVED_CSP));
    expect(res.headers.get('content-security-policy')).toContain("style-src 'self' 'unsafe-inline';");
    expect((await res.text()).split(LEGACY_STYLE).length - 1).toBe(1);
    expect(await plain.text()).toBe(WORKBENCH);
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
    const body = await res.text();
    expect(body).not.toContain(BRIDGE_MARKER);
    expect(body).not.toContain(LEGACY_NOTICE_MARKER);
    expect(body).not.toContain(DIAG_BRIDGE_MARKER);
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
  const html = () => new Response(WORKBENCH, { headers: { 'content-type': 'text/html', 'content-length': String(WORKBENCH.length), 'x-keep': '1',
    etag: 'W/"1"', 'last-modified': 'Thu, 05 Nov 2026 00:00:00 GMT', 'content-security-policy': SERVED_CSP } });
  it('the workbench document gets the bridge, without its stale length or validators, never cached', async () => {
    const res = await call(CODE_PREVIEW_PORT, '/?folder=/workspace', html());
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(BRIDGE_MARKER);
    expect(body.split(LEGACY_STYLE).length - 1).toBe(1);
    expect(body).toContain(DIAG_BRIDGE_MARKER);
    expect(res.headers.get('content-security-policy')).toBe(SERVED_CSP);
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('etag')).toBeNull();
    expect(res.headers.get('last-modified')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store');
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
