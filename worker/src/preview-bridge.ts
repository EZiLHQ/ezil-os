/**
 * preview-bridge.ts — EBuilder preview reverse-proxy (Option D), ported to the
 * Cloudflare Sandbox Worker.
 *
 * This is the Cloudflare-runtime port of the Azure control-plane daemon's
 * Option D contract. The canonical reference implementation is
 * `preview_bridge.py` in the sibling `Sandboxes` repo
 * (`infra/sandbox-desktop/preview_bridge.py`, wired into
 * `infra/sandbox-desktop/atspi_daemon.py`); see also
 * `docs/PREVIEW_MIGRATION_PLAN.md` for the target architecture this mirrors.
 *
 * Endpoints exposed under the app-preview hostname
 * (`<APP_PREVIEW_PORT>-<sandboxId>-<APP_PREVIEW_TOKEN>.<zone>`):
 *
 *   GET /preview-bootstrap?token=<t=ts,v1=hmac>[&path=/foo]
 *       Validates the short-lived, sandboxId-bound HMAC token (see
 *       `./hmac`'s module doc for why this Worker binds sandboxId into the
 *       payload, unlike Azure's per-session-secret model), sets the
 *       `ezil_preview` HttpOnly cookie, and 302-redirects to `/preview/<path>`.
 *
 *   * /preview/<path>
 *       Cookie-gated HTTP reverse-proxy to the container's dev server
 *       (`APP_PREVIEW_PORT`, default 3002 — NOT 3000, which the
 *       `@cloudflare/sandbox` SDK reserves for its own control plane) via
 *       `sandbox.containerFetch()`.
 *       Strips `X-Frame-Options` / CSP `frame-ancestors`, rewrites
 *       `Set-Cookie` to the proxy's own path/SameSite/Secure, and injects the
 *       HMR-rewrite shim + inspector script tag into HTML responses.
 *
 *   GET/WS /preview-ws/<path>
 *       Cookie-gated WebSocket reverse-proxy (Next.js HMR / Vite client).
 *
 *   GET /preview-inspector.js
 *       Cookie-gated static inspector script (element selection, click/hover
 *       postMessage bridge — ported verbatim from the Python daemon).
 *
 *   GET /preview-status
 *       Unauthenticated JSON dev-server readiness probe. See the module doc
 *       further down for the exact shape. This Worker's `probeAppPreviewStatus`
 *       (`src/index.ts`) now also reads the phase file + hydration-ready
 *       marker written by `scripts/start-devserver.sh` (ported from Azure's
 *       `start-devserver.sh` writing `/tmp/devserver.phase` etc.), so `phase`
 *       and `hydration_complete` reflect real container state instead of
 *       always being `null`.
 *
 * Deliberately avoids importing `@cloudflare/sandbox` (or any
 * `cloudflare:workers` transitive import) so the pure logic here — header
 * rewriting, HTML shim injection, hostname parsing, response shaping — can be
 * unit-tested with plain `bun test`, mirroring `./desktop-mode` and `./hmac`.
 * The one piece that genuinely needs container I/O (`containerFetch`) is
 * expressed against a minimal structural interface (`ContainerFetcher`) below,
 * not the concrete `Sandbox` class, so it stays mockable in tests too.
 */

import {
  mintPreviewCookie,
  PREVIEW_COOKIE_NAME,
  PREVIEW_COOKIE_TTL_S,
  verifyPreviewBootstrapToken,
  verifyPreviewCookie,
} from './hmac';
import { APP_PREVIEW_PORT, APP_PREVIEW_TOKEN, CODE_PREVIEW_PORT, CODE_PREVIEW_TOKEN } from './desktop-mode';

// ── Hostname parsing ─────────────────────────────────────────────────────────

/**
 * Which container-side surface a bridge hostname resolves to. `'app'` is the
 * user's own dev server (`APP_PREVIEW_PORT`); `'code'` is code-server
 * (`CODE_PREVIEW_PORT`) — see `desktop-mode.ts`'s doc comments for both.
 */
export type BridgeTarget = 'app' | 'code';

/**
 * Parse `<port>-<sandboxId>-<token>.<rest>` the same way the SDK's own
 * `proxyToSandbox` (`extractSandboxRoute`, `@cloudflare/sandbox/dist/index.js`)
 * does — critically using `lastIndexOf('-')` to split the token off the END
 * of the subdomain, so a `sandboxId` that itself contains hyphens (this
 * Worker's `guac-<user>-<project>` ids always do) is parsed correctly.
 *
 * Generalized (was `parseAppPreviewHost`, app-only) to also recognize the
 * code-server bridge port/token, returning WHICH surface matched as `target`.
 * Returns `null` for any other exposed port/token (desktop, guacamole) —
 * those intentionally stay on the existing raw `proxyToSandbox` path,
 * unchanged.
 */
export function parseBridgeHost(hostname: string): { sandboxId: string; target: BridgeTarget } | null {
  const dotIndex = hostname.indexOf('.');
  const subdomain = dotIndex === -1 ? hostname : hostname.slice(0, dotIndex);

  const firstHyphen = subdomain.indexOf('-');
  if (firstHyphen === -1) return null;
  const portStr = subdomain.slice(0, firstHyphen);
  if (!/^\d{1,5}$/.test(portStr)) return null;
  const portNum = Number(portStr);

  let target: BridgeTarget;
  if (portNum === APP_PREVIEW_PORT) target = 'app';
  else if (portNum === CODE_PREVIEW_PORT) target = 'code';
  else return null;

  const rest = subdomain.slice(firstHyphen + 1);
  const lastHyphen = rest.lastIndexOf('-');
  if (lastHyphen === -1) return null;
  const sandboxId = rest.slice(0, lastHyphen);
  const token = rest.slice(lastHyphen + 1);
  const expectedToken = target === 'app' ? APP_PREVIEW_TOKEN : CODE_PREVIEW_TOKEN;
  if (token !== expectedToken) return null;
  if (sandboxId.length === 0) return null;

  return { sandboxId, target };
}

// ── Response header rewriting ────────────────────────────────────────────────

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/** Response headers stripped so the iframe can embed and content isn't stale-cached. */
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-length', // recomputed by the Response constructor when we rewrite HTML
  'content-security-policy-report-only',
  'etag',
  'last-modified',
]);

/**
 * Rewrite a `Set-Cookie` value emitted by the dev server so it survives the
 * proxy hop: force `Path=/preview`, `SameSite=None`, `Secure`; drop any
 * `Domain=` so the browser defaults to the proxy's own origin. Mirrors
 * `preview_bridge.py`'s `_rewrite_set_cookie`.
 */
export function rewriteSetCookie(value: string): string {
  const parts = value.split(';').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return value;
  const rebuilt: string[] = [parts[0] as string];
  let sawPath = false;
  let sawSameSite = false;
  let sawSecure = false;
  for (const p of parts.slice(1)) {
    const lower = p.toLowerCase();
    if (lower.startsWith('domain=')) continue;
    if (lower.startsWith('path=')) {
      rebuilt.push('Path=/preview');
      sawPath = true;
      continue;
    }
    if (lower.startsWith('samesite=')) {
      rebuilt.push('SameSite=None');
      sawSameSite = true;
      continue;
    }
    if (lower === 'secure') {
      rebuilt.push('Secure');
      sawSecure = true;
      continue;
    }
    rebuilt.push(p);
  }
  if (!sawPath) rebuilt.push('Path=/preview');
  if (!sawSameSite) rebuilt.push('SameSite=None');
  if (!sawSecure) rebuilt.push('Secure');
  return rebuilt.join('; ');
}

/**
 * Strip CSP `frame-ancestors` directives from a `Content-Security-Policy`
 * value while preserving every other directive (XSS protections the dev
 * server sets stay in effect). Returns `null` when nothing is left after
 * stripping (the header should be dropped entirely).
 */
export function stripFrameAncestors(value: string): string | null {
  const parts = value
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.toLowerCase().startsWith('frame-ancestors'));
  if (parts.length === 0) return null;
  return parts.join('; ');
}

/**
 * Copy upstream response headers, applying the same rewrites as
 * `preview_bridge.py`'s `_rewrite_response_headers`: drop hop-by-hop and
 * frame-blocking headers, strip CSP `frame-ancestors`, rewrite `Set-Cookie`.
 */
export function rewriteResponseHeaders(upstream: Headers): Headers {
  const out = new Headers();
  upstream.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIP_RESPONSE_HEADERS.has(lower)) return;
    if (lower === 'content-security-policy') {
      const stripped = stripFrameAncestors(value);
      if (stripped !== null) out.append(key, stripped);
      return;
    }
    if (lower === 'set-cookie') {
      out.append(key, rewriteSetCookie(value));
      return;
    }
    out.append(key, value);
  });
  return out;
}

// ── Query-param fallback for the `ezil_preview` cookie (CHIPS / 3p-cookie gap) ──
//
// Root cause this fixes: `handlePreviewBootstrap` sets `ezil_preview` with
// `SameSite=None` (needed because the preview host is a DIFFERENT origin than
// whatever site embeds it in an iframe — a genuinely third-party context).
// Chrome's CHIPS proposal blocks a `SameSite=None` cookie from being usable in
// a third-party iframe UNLESS it is also `Partitioned` (see the `Partitioned`
// attribute added to `handlePreviewBootstrap` below); Firefox partitions it
// automatically; Safari's ITP blocks third-party cookies outright and does not
// implement CHIPS/`Partitioned` at all — no cookie attribute makes it stick
// there. In every one of these failure modes the symptom is IDENTICAL and
// silent: the bootstrap 302 succeeds, the browser never persists (or never
// sends) the cookie, and every subsequent `/preview/*` request 401s — the
// window just looks broken, with nothing in the response body to explain why.
//
// This query param is the fallback: `handlePreviewBootstrap` mints the SAME
// cookie value and embeds it here on the redirect `Location`, so the very
// first `/preview/<path>` request succeeds even in a browser that drops the
// cookie outright. `RUNTIME_SHIM` (below) then propagates it onto same-origin
// `fetch`/`XMLHttpRequest`/HMR-`WebSocket` calls the previewed page makes
// client-side, so SPA navigation/asset-fetching keeps working without a
// cookie for the lifetime of that page load. It is verified with the exact
// same `verifyPreviewCookie` the cookie itself uses — same value shape, same
// HMAC, same sandboxId binding — so it carries no weaker guarantee than the
// cookie it stands in for. Always stripped before forwarding to the upstream
// dev server so the app itself never sees this internal auth parameter.
//
// Declared here (before `RUNTIME_SHIM`, which embeds it verbatim into the
// injected client-side script via `JSON.stringify`) rather than down with
// `resolvePreviewAuth`/`stripPreviewQueryParam` below — `RUNTIME_SHIM`'s
// initializer runs at module-load time, top-to-bottom, so referencing a
// `const` declared later in the file would throw `ReferenceError` (temporal
// dead zone) the instant this module is imported, breaking every route.
export const PREVIEW_COOKIE_QUERY_PARAM = 'ezil_pv';

// ── HTML shim injection ──────────────────────────────────────────────────────

/**
 * Runtime shim injected into every HTML response. Rewrites the Next.js/Vite
 * HMR WebSocket URL to flow through `/preview-ws/...`, loads the inspector
 * script, and — when the current page was reached via the `ezil_pv`
 * query-param fallback (see `PREVIEW_COOKIE_QUERY_PARAM`'s module doc in this
 * file: the `ezil_preview` cookie a browser dropped outright, e.g. Safari
 * ITP) — propagates that same fallback value onto same-origin
 * `fetch`/`XMLHttpRequest`/WebSocket calls the page makes itself, so
 * client-side navigation and asset/data fetching keep working for the
 * lifetime of that page load without ever needing the cookie. No-op (reads
 * `null`, patches nothing) when the page was reached normally with a working
 * cookie — this never changes behavior for the common case. Ported verbatim
 * (semantics-preserving) from `preview_bridge.py`'s `_RUNTIME_SHIM`, plus the
 * fallback-propagation addition.
 */
export const RUNTIME_SHIM = `
<script>
(function () {
  var FALLBACK_PARAM = ${JSON.stringify(PREVIEW_COOKIE_QUERY_PARAM)};
  var fallbackValue = null;
  try {
    fallbackValue = new URLSearchParams(window.location.search).get(FALLBACK_PARAM);
  } catch (e) { fallbackValue = null; }

  if (fallbackValue) {
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        try {
          var reqUrl = (typeof Request !== 'undefined' && input instanceof Request) ? input.url : input;
          var u = new URL(reqUrl, window.location.href);
          if (u.host === window.location.host && !u.searchParams.has(FALLBACK_PARAM)) {
            u.searchParams.set(FALLBACK_PARAM, fallbackValue);
            input = (typeof Request !== 'undefined' && input instanceof Request) ? new Request(u.toString(), input) : u.toString();
          }
        } catch (e) { /* fall through with original input */ }
        return origFetch.call(this, input, init);
      };
    }

    if (typeof XMLHttpRequest !== 'undefined') {
      var origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, reqUrl) {
        try {
          var u = new URL(reqUrl, window.location.href);
          if (u.host === window.location.host && !u.searchParams.has(FALLBACK_PARAM)) {
            u.searchParams.set(FALLBACK_PARAM, fallbackValue);
            reqUrl = u.toString();
          }
        } catch (e) { /* fall through with original url */ }
        var rest = Array.prototype.slice.call(arguments, 2);
        return origOpen.apply(this, [method, reqUrl].concat(rest));
      };
    }
  }

  var origWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    try {
      var u = new URL(url, window.location.href);
      var sameOrigin = u.host === window.location.host;
      var changed = false;
      if (
        sameOrigin &&
        (u.pathname.indexOf('/_next/') === 0 ||
         u.pathname.indexOf('/__nextjs') === 0 ||
         u.pathname.indexOf('/_next/turbopack') === 0 ||
         u.pathname.indexOf('/@vite/') === 0 ||
         u.pathname.indexOf('/@hmr') === 0 ||
         u.pathname.indexOf('/__webpack_hmr') === 0)
      ) {
        u.pathname = '/preview-ws' + u.pathname;
        changed = true;
      }
      if (fallbackValue && sameOrigin && !u.searchParams.has(FALLBACK_PARAM)) {
        u.searchParams.set(FALLBACK_PARAM, fallbackValue);
        changed = true;
      }
      if (changed) url = u.toString();
    } catch (e) { /* fall through with original url */ }
    return protocols ? new origWS(url, protocols) : new origWS(url);
  };
  window.WebSocket.prototype = origWS.prototype;
  window.WebSocket.CONNECTING = origWS.CONNECTING;
  window.WebSocket.OPEN = origWS.OPEN;
  window.WebSocket.CLOSING = origWS.CLOSING;
  window.WebSocket.CLOSED = origWS.CLOSED;
})();
</script>
<script src="/preview-inspector.js" async></script>
`.trim();

const HEAD_OPEN_RE = /<head\b[^>]*>/i;

/** Inject `RUNTIME_SHIM` right after the opening `<head>` tag. No-op if absent. */
export function injectRuntimeShim(html: string): string {
  const match = HEAD_OPEN_RE.exec(html);
  if (!match) return html;
  const idx = match.index + match[0].length;
  return html.slice(0, idx) + RUNTIME_SHIM + html.slice(idx);
}

/**
 * Inspector script served at `/preview-inspector.js`. Ported verbatim from
 * `preview_bridge.py`'s `_INSPECTOR_JS` (element hover/click/select over
 * postMessage, EID/ORID `data-eid`/`data-oid` compatible).
 */
export const INSPECTOR_JS = `
(function () {
  if (window.__ezilInspectorInstalled) return;
  window.__ezilInspectorInstalled = true;

  var parent = window.parent;
  if (!parent || parent === window) return;

  function postToParent(type, detail) {
    try { parent.postMessage({ __ezil: true, type: type, detail: detail }, '*'); } catch (e) {}
  }

  function inAppPath() {
    var p = location.pathname || '/';
    if (p.indexOf('/preview/') === 0) p = p.slice('/preview'.length) || '/';
    else if (p === '/preview') p = '/';
    return p + (location.search || '') + (location.hash || '');
  }

  function elementEid(el) {
    if (!el || !el.getAttribute) return null;
    return el.getAttribute('data-eid') || el.getAttribute('data-oid') || null;
  }

  function findEidTarget(node) {
    var el = node;
    while (el && el.nodeType === 1) {
      if (elementEid(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return {
      x: r.left, y: r.top, width: r.width, height: r.height,
      vw: window.innerWidth, vh: window.innerHeight,
    };
  }

  function describe(el) {
    return {
      oid: elementEid(el),
      framework: el.hasAttribute('data-eid') ? 'eid' : 'orid',
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: el.className ? String(el.className).split(/\\s+/).filter(Boolean).slice(0, 20) : undefined,
      rect: rectOf(el),
      text: (el.innerText || '').slice(0, 200),
    };
  }

  var hoverEl = null, rafHover = 0;
  function onMove(e) {
    if (rafHover) return;
    rafHover = requestAnimationFrame(function () {
      rafHover = 0;
      var el = findEidTarget(e.target);
      if (el !== hoverEl) {
        hoverEl = el;
        postToParent('hover', el ? describe(el) : null);
      } else if (el) {
        postToParent('hover', describe(el));
      }
    });
  }
  function onLeave() { hoverEl = null; postToParent('hover', null); }
  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('mouseleave', onLeave, { passive: true });

  var selectMode = false;
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || !d.__ezil) return;
    if (d.type === 'set-select-mode') selectMode = !!d.detail;
    else if (d.type === 'get-tree') {
      postToParent('tree', serializeTree(document.body, 8));
    } else if (d.type === 'ping') {
      postToParent('pong', { href: location.href, path: inAppPath(), title: document.title });
    }
  });

  document.addEventListener('click', function (e) {
    if (!selectMode) return;
    var el = findEidTarget(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    postToParent('select', describe(el));
  }, true);

  function serializeTree(root, maxDepth) {
    function visit(node, depth) {
      if (!node || node.nodeType !== 1) return null;
      var eid = elementEid(node);
      var children = [];
      if (depth < maxDepth) {
        for (var i = 0; i < node.children.length; i++) {
          var c = visit(node.children[i], depth + 1);
          if (c) children.push(c);
        }
      }
      return {
        oid: eid,
        framework: node.hasAttribute('data-eid') ? 'eid' : (node.hasAttribute('data-oid') ? 'orid' : null),
        tag: node.tagName.toLowerCase(),
        id: node.id || undefined,
        rect: rectOf(node),
        children: children,
      };
    }
    return visit(root, 0);
  }

  postToParent('ready', { href: location.href, path: inAppPath(), title: document.title });

  var origPush = history.pushState;
  history.pushState = function () {
    var r = origPush.apply(this, arguments);
    postToParent('navigate', { href: location.href, path: inAppPath() });
    return r;
  };
  window.addEventListener('popstate', function () {
    postToParent('navigate', { href: location.href, path: inAppPath() });
  });
})();
`.trimStart();

// ── "Dev server not up" diagnostic page ──────────────────────────────────────

/**
 * Every STATE the client (second worker) must handle from this bridge is
 * documented here as the literal `reason` strings this module returns:
 *
 *   'no_package_json'   — workspace has no package.json yet (project not
 *                          scaffolded / R2 workspace still syncing).
 *   'port_not_listening' — package.json exists but nothing answers
 *                          APP_PREVIEW_PORT yet (dev server starting or not
 *                          started — see the honest gap noted in the module
 *                          doc: nothing in this container image starts it).
 *   'upstream_error'    — port answered before but the proxied request itself
 *                          failed (connection reset mid-session, etc.).
 *
 * These three reasons are the ONLY diagnostic reasons this Worker can
 * currently produce; unlike Azure's daemon (which also reports
 * `placeholder_mode`, `dev_server_crashed`, `dev_server_timeout`,
 * `installing_deps`, `starting` from phase files written by
 * `start-devserver.sh`), this Cloudflare container image has no devserver
 * lifecycle script yet, so those richer phases are NOT available. See the
 * report's "deviation" section.
 */
export type PreviewDiagnosticReason = 'no_package_json' | 'port_not_listening' | 'upstream_error';

export function buildDiagnosticResponse(reason: PreviewDiagnosticReason, port: number, detail?: string): Response {
  const label =
    reason === 'no_package_json'
      ? 'No project scaffolded yet'
      : reason === 'port_not_listening'
        ? 'Dev server not running'
        : 'Preview upstream error';
  const escapedDetail = detail ? escapeHtml(detail).slice(-800) : '';
  const body = `<!doctype html>
<html><head><title>EZiL Preview — ${escapeHtml(label)}</title>
<meta http-equiv="refresh" content="3">
<style>
*{box-sizing:border-box}
body{background:#1a1017;color:#f0d0d0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:2rem}
.card{background:#2a1520;border:1px solid #6b2020;border-radius:12px;padding:2rem 2.5rem;max-width:620px;text-align:center}
h1{font-weight:500;font-size:1.4rem;color:#ff6b6b;margin:0 0 .75rem}
p{opacity:0.85;line-height:1.5;margin:0.5rem 0}
pre{background:#0d0508;border:1px solid #4a1515;border-radius:6px;padding:1rem;text-align:left;font-size:0.75rem;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:#cc9999}
.badge{display:inline-block;background:#6b2020;color:#ffaaaa;padding:4px 12px;border-radius:20px;font-size:0.8rem;margin-top:1rem}
.hint{font-size:0.8rem;opacity:0.55;margin-top:1rem}
</style>
</head><body>
<div class="card">
  <h1>${escapeHtml(label)}</h1>
  <p>No application is currently serving on port ${port}.</p>
  <p>The preview will appear automatically once the dev server is up.</p>
  ${escapedDetail ? `<pre>${escapedDetail}</pre>` : ''}
  <span class="badge">STATUS: ${reason.toUpperCase().replace(/_/g, ' ')}</span>
  <p class="hint">Auto-refreshing every 3s.</p>
</div>
</body></html>`;
  return new Response(body, {
    status: 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache, no-store',
      'retry-after': '3',
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Cookie extraction ─────────────────────────────────────────────────────────

/** Read a single named cookie out of a raw `Cookie` request header. */
export function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return undefined;
}

/** Drop the `ezil_preview` cookie from an outgoing `Cookie` header before forwarding upstream. */
export function stripPreviewCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;
  const kept = cookieHeader
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith(`${PREVIEW_COOKIE_NAME}=`));
  return kept.length > 0 ? kept.join('; ') : undefined;
}

// ── Query-param fallback for the `ezil_preview` cookie ──────────────────────
// `PREVIEW_COOKIE_QUERY_PARAM` is declared up near `RUNTIME_SHIM` (see the
// doc comment there for why, and for the full failure mode this closes).

/**
 * Resolve preview auth from a request: the `ezil_preview` cookie if present
 * and valid, else the `?ezil_pv=` query-string fallback. Cookie takes
 * precedence when both are present and valid — the fallback exists only for
 * the browsers/paths that never had a cookie to begin with.
 */
export async function resolvePreviewAuth(
  request: Request,
  url: URL,
  secrets: string[],
  sandboxId: string,
): Promise<boolean> {
  const cookie = readCookie(request.headers.get('cookie'), PREVIEW_COOKIE_NAME);
  if (await verifyPreviewCookie(cookie, secrets, sandboxId)) return true;
  const fallback = url.searchParams.get(PREVIEW_COOKIE_QUERY_PARAM) ?? undefined;
  if (!fallback) return false;
  return verifyPreviewCookie(fallback, secrets, sandboxId);
}

/** Strip the `ezil_pv` fallback query param before forwarding a request upstream. */
export function stripPreviewQueryParam(search: string): string {
  if (!search) return search;
  const params = new URLSearchParams(search);
  if (!params.has(PREVIEW_COOKIE_QUERY_PARAM)) return search;
  params.delete(PREVIEW_COOKIE_QUERY_PARAM);
  const rebuilt = params.toString();
  return rebuilt ? `?${rebuilt}` : '';
}

// ── Container fetch — minimal structural interface (mockable in tests) ──────

/** The one method this module needs from `Sandbox<unknown>` — kept minimal so tests can fake it. */
export interface ContainerFetcher {
  containerFetch(requestOrUrl: Request | string, portOrInit?: number | RequestInit, port?: number): Promise<Response>;
}

// ── /preview-bootstrap ────────────────────────────────────────────────────────

export interface BootstrapResult {
  response: Response;
}

/**
 * Handle `GET /preview-bootstrap?token=...&path=...`. Verifies the
 * sandboxId-bound HMAC token, mints the `ezil_preview` cookie, and
 * 302-redirects to `/preview<path>`.
 */
export async function handlePreviewBootstrap(
  url: URL,
  sandboxId: string,
  secrets: string[],
  cookieSecret: string | undefined,
): Promise<Response> {
  const token = url.searchParams.get('token') ?? undefined;
  const auth = await verifyPreviewBootstrapToken(token, secrets, sandboxId);
  if (!auth.ok) {
    return new Response(JSON.stringify({ ok: false, error: auth.error }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  let destPath = url.searchParams.get('path') || '/';
  if (!destPath.startsWith('/')) destPath = `/${destPath}`;

  const cookie = await mintPreviewCookie(cookieSecret, sandboxId);
  // `Partitioned` (CHIPS) is what lets Chrome/Edge actually send this
  // `SameSite=None` cookie back on a third-party-iframe request at all —
  // without it, current/upcoming Chrome versions block the cookie outright
  // for a cross-site embed, not just "don't partition it". Firefox partitions
  // automatically regardless. Safari implements neither CHIPS nor
  // `SameSite=None` third-party cookies, so `Partitioned` is a no-op there —
  // that gap is exactly what `PREVIEW_COOKIE_QUERY_PARAM` below covers. See
  // the module doc above `PREVIEW_COOKIE_QUERY_PARAM` for the full failure
  // mode this closes.
  const cookieAttrs = [
    `${PREVIEW_COOKIE_NAME}=${cookie}`,
    `Max-Age=${PREVIEW_COOKIE_TTL_S}`,
    'HttpOnly',
    'Secure',
    'SameSite=None',
    'Partitioned',
    'Path=/',
  ].join('; ');

  // Belt-and-suspenders: embed the SAME cookie value as a `?ezil_pv=` query
  // param on the redirect target, so the very first `/preview/<path>`
  // request succeeds even in a browser that drops the `Set-Cookie` above
  // entirely (Safari ITP) — see `resolvePreviewAuth`. `RUNTIME_SHIM` then
  // carries it forward onto same-origin client-side requests for the rest of
  // that page load.
  const locationUrl = new URL(`/preview${destPath}`, url);
  locationUrl.searchParams.set(PREVIEW_COOKIE_QUERY_PARAM, cookie);
  const location = `${locationUrl.pathname}${locationUrl.search}`;

  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Set-Cookie': cookieAttrs,
    },
  });
}

// ── /preview and /preview/<path> ─────────────────────────────────────────────

/**
 * Cookie-gate + reverse-proxy an HTTP request into the container's dev server
 * (`target: 'app'`) or code-server (`target: 'code'`). `containerFetch`
 * reaches the port directly — it does NOT require the port to have been
 * registered via `exposePort()` (that's a separate, orthogonal public-hostname
 * registration; see the deviation note in the report re: "expose the
 * application port").
 *
 * `port`/`target` default to the original app-preview values so every
 * pre-existing call site (and its tests) keeps working unchanged.
 *
 * `target === 'code'` NEVER gets `RUNTIME_SHIM` injected, even for an
 * `text/html` response: the shim monkey-patches `window.WebSocket` to rewrite
 * Next.js/Vite HMR paths through `/preview-ws/...`, and code-server's own
 * WebSocket traffic (extension host, integrated terminal, editor sync) is NOT
 * an HMR channel — rewriting/wrapping it breaks the extension host
 * immediately and silently (it just never connects). This is a known, narrow
 * landmine: keep this check target-based, never port-based or content-type
 * heuristic-based, so it can't regress if the ports are ever renumbered.
 */
export async function handlePreviewProxy(
  request: Request,
  sandbox: ContainerFetcher,
  sandboxId: string,
  secrets: string[],
  appPath: string,
  port: number = APP_PREVIEW_PORT,
  target: BridgeTarget = 'app',
): Promise<Response> {
  const url = new URL(request.url);
  const authorized = await resolvePreviewAuth(request, url, secrets, sandboxId);
  if (!authorized) {
    return new Response(
      JSON.stringify({ ok: false, error: 'preview_cookie_missing_or_invalid: re-fetch /preview-bootstrap' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }

  const targetPath = `/${appPath.replace(/^\/+/, '')}`;
  const forwardSearch = stripPreviewQueryParam(url.search);
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${forwardSearch}`;

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('host');
  forwardHeaders.delete('content-length');
  const strippedCookie = stripPreviewCookie(request.headers.get('cookie'));
  if (strippedCookie) forwardHeaders.set('cookie', strippedCookie);
  else forwardHeaders.delete('cookie');
  forwardHeaders.set('x-forwarded-proto', 'https');
  forwardHeaders.set('x-forwarded-host', 'preview.local');

  const init: RequestInit = {
    method: request.method,
    headers: forwardHeaders,
    body: ['GET', 'HEAD'].includes(request.method.toUpperCase()) ? undefined : await request.arrayBuffer(),
  };

  let upstream: Response;
  try {
    upstream = await sandbox.containerFetch(targetUrl, init, port);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Connection-refused / not-yet-listening is the common case — surface the
    // explicit "waiting for dev server" diagnostic rather than a hard 502.
    return buildDiagnosticResponse('port_not_listening', port, message);
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const outHeaders = rewriteResponseHeaders(upstream.headers);

  if (contentType.includes('text/html')) {
    const bodyText = await upstream.text();
    const injected = target === 'code' ? bodyText : injectRuntimeShim(bodyText);
    outHeaders.set('cache-control', 'no-cache, no-store');
    return new Response(injected, { status: upstream.status, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// ── /preview-inspector.js ─────────────────────────────────────────────────────

export async function handlePreviewInspectorJs(
  request: Request,
  sandboxId: string,
  secrets: string[],
): Promise<Response> {
  const authorized = await resolvePreviewAuth(request, new URL(request.url), secrets, sandboxId);
  if (!authorized) {
    return new Response(
      JSON.stringify({ ok: false, error: 'preview_cookie_missing_or_invalid: re-fetch /preview-bootstrap' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response(INSPECTOR_JS, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}

// ── /preview-status ───────────────────────────────────────────────────────────

/**
 * Shape of the (unauthenticated) `/preview-status` response.
 *
 * Field-for-field this mirrors Azure's `/preview-status` shape
 * (`preview_bridge.py`'s `preview_status` handler): `port_up` and
 * `has_package_json` are real TCP/HTTP + workspace probes (unchanged);
 * `phase` and `hydration_complete` are now ALSO real, sourced by
 * `probeAppPreviewStatus` (`src/index.ts`) from the phase file and
 * hydration-ready marker `scripts/start-devserver.sh` /
 * `workspace-bootstrap.ts` write in-container — not fabricated.
 *
 * `phase` is intentionally NOT part of the `error_reason` enum below: the
 * client's existing `errorReason` union
 * (`no_package_json | port_not_listening | upstream_error`) is a settled
 * wire contract another surface already type-checks against, so this Worker
 * never emits a new `error_reason` value. Instead, `phase` carries the
 * FINER-grained distinction (e.g. `installing_deps` / `starting` / `running`
 * / `crashed` / `timeout` / `placeholder`) as an additive, purely informational
 * field a caller MAY read for richer messaging without breaking anyone who
 * only reads `error_reason` today. In particular `phase: 'crashed'` or
 * `'timeout'` alongside `error_reason: 'port_not_listening'` is how a caller
 * can tell "the dev server failed" apart from "the dev server is still
 * starting" (both otherwise report the same `port_not_listening` reason —
 * see `buildPreviewStatus`'s doc comment).
 */
export interface PreviewStatus {
  ok: true;
  mode: 'neko';
  port: number;
  port_up: boolean;
  has_package_json: boolean;
  is_real_app: boolean;
  error_reason: PreviewDiagnosticReason | null;
  /**
   * First token of `/tmp/devserver.phase` (format `"<phase> <unix_ts>"`,
   * written by `scripts/start-devserver.sh`'s `write_phase()`): one of
   * `placeholder | installing_deps | starting | running | crashed |
   * timeout | error_port_busy | error_workspace_missing`, or `null` when the
   * launcher has not run yet (e.g. an older image, or before the async
   * launch request from `start-neko.sh` lands) — PLUS one Worker-side-only
   * value, `crash_looping`, that `effectiveDevserverPhase` reports INSTEAD of
   * `crashed` once `DEVSERVER_RESTART_ESCALATE_ATTEMPTS` consecutive
   * automatic restarts have failed to recover the dev server (see that
   * function's doc comment). `probeAppPreviewStatus` (`src/index.ts`) also
   * uses a `crashed` reading here to trigger the lazy self-heal restart
   * itself (`shouldTriggerDevserverRestart`) — see the "Dev-server self-heal"
   * section above.
   */
  phase: string | null;
  /**
   * Whether the workspace hydration readiness marker
   * (`WORKSPACE_READY_MARKER_ENV` default
   * `/run/ezil/workspace-ready.json`, written by
   * `workspace-bootstrap.ts`'s `runWorkspaceBootstrap` on its ONLY success
   * path) is present. `false` (never `null`) when a sealed startup delivery
   * was never used (legacy/pre-ready path) — the marker genuinely never gets
   * written in that case, so `false` is the honest answer, not "unknown".
   */
  hydration_complete: boolean | null;
}

// ── /preview-ws/<path> ────────────────────────────────────────────────────────

/**
 * Cookie-gate + reverse-proxy a WebSocket upgrade into the container's dev
 * server (Next.js HMR / Vite `@vite/client`). Uses the standard Workers
 * container-WebSocket-passthrough pattern: forward the Upgrade request via
 * `containerFetch`, and if the resulting Response carries a `webSocket`, hand
 * it back to the client as a 101 response.
 *
 * UNVERIFIED: there is no live sandbox available in this environment to
 * confirm `containerFetch` actually completes a WebSocket upgrade end to end
 * (as opposed to plain HTTP request/response) — see the report's "could not
 * verify" section. The header handling here mirrors the HTTP proxy path and
 * `preview_bridge.py`'s WS proxy (cookie auth, `x-forwarded-*`, cookie
 * stripped before forwarding).
 */
export async function handlePreviewWsProxy(
  request: Request,
  sandbox: ContainerFetcher,
  sandboxId: string,
  secrets: string[],
  appPath: string,
  port: number = APP_PREVIEW_PORT,
): Promise<Response> {
  const url = new URL(request.url);
  const authorized = await resolvePreviewAuth(request, url, secrets, sandboxId);
  if (!authorized) {
    return new Response('invalid preview cookie', { status: 401 });
  }

  const targetPath = `/${appPath.replace(/^\/+/, '')}`;
  const forwardSearch = stripPreviewQueryParam(url.search);
  const targetUrl = `http://127.0.0.1:${port}${targetPath}${forwardSearch}`;

  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete('host');
  const strippedCookie = stripPreviewCookie(request.headers.get('cookie'));
  if (strippedCookie) forwardHeaders.set('cookie', strippedCookie);
  else forwardHeaders.delete('cookie');
  forwardHeaders.set('x-forwarded-proto', 'https');
  forwardHeaders.set('x-forwarded-host', 'preview.local');

  let upstream: Response;
  try {
    upstream = await sandbox.containerFetch(
      targetUrl,
      { method: request.method, headers: forwardHeaders },
      port,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`preview ws upstream unavailable: ${message}`, { status: 502 });
  }

  const upgraded = upstream.webSocket;
  if (upgraded) {
    return new Response(null, { status: 101, webSocket: upgraded });
  }
  return upstream;
}

/**
 * Build the `/preview-status` response. `phase`, `hydrationComplete`, and
 * `devserverMode` are OPTIONAL (default `null`) so existing call sites (and
 * this module's own 2/3/4-arg unit tests) keep working unchanged;
 * `src/index.ts`'s `probeAppPreviewStatus` passes all of them once it has
 * read the phase file, hydration marker, and `/tmp/devserver.mode`.
 *
 * `error_reason` is computed EXACTLY as before — `phase` never widens or
 * changes that enum (see `PreviewStatus`'s doc comment for why: the client's
 * `errorReason` union is a settled wire contract this Worker must not grow
 * new values for). A crashed or timed-out dev server still reports
 * `error_reason: 'port_not_listening'` (truthful: nothing IS listening); the
 * NEW information is carried purely in `phase`.
 *
 * `devserverMode` guards `is_real_app` against a real false-positive this
 * Worker's own placeholder server (`scripts/start-devserver.sh`, mode file
 * `/tmp/devserver.mode`) can otherwise produce: the placeholder genuinely
 * listens on the port, so if a `package.json` later appears in the workspace
 * WITHOUT the launcher re-running (there is currently no trigger that
 * re-invokes it after the one boot-time call — see the report's divergence
 * callout re: Azure's lazy per-request restart), `portUp && hasPackageJson`
 * alone would be `true` while the iframe is still actually showing the
 * "No Project Loaded" placeholder page. Requiring `devserverMode !==
 * 'placeholder'` (permissive default when unknown/null, so an older image or
 * an early boot race before the mode file exists never produces a false
 * NEGATIVE) closes that gap.
 */
export function buildPreviewStatus(
  portUp: boolean,
  hasPackageJson: boolean,
  phase: string | null = null,
  hydrationComplete: boolean | null = null,
  devserverMode: string | null = null,
): PreviewStatus {
  const isRealApp = portUp && hasPackageJson && devserverMode !== 'placeholder';
  let errorReason: PreviewDiagnosticReason | null = null;
  if (!hasPackageJson) errorReason = 'no_package_json';
  // Also covers the placeholder-still-serving race described above: the
  // launcher hasn't swapped to the real app yet, so — same as a genuinely
  // down port — the real app is not listening. Keeps error_reason and
  // is_real_app mutually consistent instead of leaving a
  // `{ is_real_app: false, error_reason: null }` gap the client's
  // `resolveAppPreviewUiState` would otherwise fall through to `'unknown'`.
  else if (!portUp || devserverMode === 'placeholder') errorReason = 'port_not_listening';
  return {
    ok: true,
    mode: 'neko',
    port: APP_PREVIEW_PORT,
    port_up: portUp,
    has_package_json: hasPackageJson,
    is_real_app: isRealApp,
    error_reason: errorReason,
    phase,
    hydration_complete: hydrationComplete,
  };
}

// ── In-container state files written by scripts/start-devserver.sh ──────────
// (and the hydration-ready marker written by workspace-bootstrap.ts) that
// `probeAppPreviewStatus` (src/index.ts) reads via `sandbox.exec`. Kept here,
// alongside pure helpers to build/parse them, so the shell-command
// composition and phase-string parsing are unit-testable without the
// Workers runtime — only the actual `sandbox.exec` I/O stays in index.ts.

/** Written by `write_phase()` in `scripts/start-devserver.sh` as `"<phase> <unix_ts>"`. */
export const DEVSERVER_PHASE_FILE = '/tmp/devserver.phase';

/**
 * Written by `scripts/start-devserver.sh` as a single word: `placeholder` or
 * `app`. Read by `buildPreviewStatus`'s `devserverMode` param to guard
 * `is_real_app` against the placeholder-still-serving race — see that
 * function's doc comment.
 */
export const DEVSERVER_MODE_FILE = '/tmp/devserver.mode';

/**
 * Written unconditionally at the top of `scripts/start-devserver.sh` with
 * the ABSOLUTE workspace root it was invoked against (almost always
 * `/home/neko/project` or the sealed-delivery bootstrap's resolved root —
 * NOT the legacy `SANDBOX_WORKSPACE_MOUNT_PATH` bucket-mount default this
 * module's callers otherwise fall back to).
 */
export const DEVSERVER_WORKSPACE_ROOT_FILE = '/tmp/devserver.workspace-root';

/**
 * Written by `workspace-bootstrap.ts`'s `runWorkspaceBootstrap` (see
 * `WORKSPACE_READY_MARKER_ENV` / `DEFAULT_WORKSPACE_READY_MARKER` there) on
 * its ONLY success path — i.e. only when a sealed startup delivery was
 * present AND hydration succeeded.
 */
export const WORKSPACE_READY_MARKER_PATH = '/run/ezil/workspace-ready.json';

/**
 * Consecutive-recovery-attempt counter written by `scripts/start-devserver.sh`:
 * a bare integer, incremented each time the launcher is (re)invoked while the
 * PRIOR phase was `crashed`/`timeout` (i.e. this run is itself an automatic
 * recovery attempt, not the original boot-time launch), and reset to `0` the
 * moment the dev server successfully binds its port (`running` phase). Read
 * by `probeAppPreviewStatus` (`src/index.ts`) and fed into
 * `shouldTriggerDevserverRestart`/`effectiveDevserverPhase` below.
 */
export const DEVSERVER_RESTART_COUNT_FILE = '/tmp/devserver.restart-count';

/** Default location of `scripts/start-devserver.sh` inside the built image (see the `Dockerfile`'s `COPY`/`chmod` lines). */
export const DEFAULT_DEVSERVER_BIN_PATH = '/usr/local/bin/start-devserver.sh';

/**
 * Parse the first whitespace-separated token out of a `DEVSERVER_PHASE_FILE`
 * read (format `"<phase> <unix_ts>"`). Returns `null` for empty/missing
 * content so a container that has never run the launcher (or an exec
 * failure) reports an honest "no phase data" rather than a fabricated one.
 */
export function parseDevserverPhase(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const word = trimmed.split(/\s+/)[0];
  return word && word.length > 0 ? word : null;
}

/** `parseDevserverPhase` plus the unix-seconds timestamp `write_phase()` writes alongside it. */
export interface DevserverPhaseRecord {
  phase: string | null;
  /** Unix seconds the phase last changed, or `null` if missing/unparsable. */
  timestampS: number | null;
}

/**
 * Parse the FULL `DEVSERVER_PHASE_FILE` record (`"<phase> <unix_ts>"`),
 * including the timestamp — needed by `shouldTriggerDevserverRestart` below,
 * which must know WHEN the phase last changed (not just what it currently
 * is) to compute its cooldown/backoff. `parseDevserverPhase` stays as the
 * phase-only convenience every other existing call site uses.
 */
export function parseDevserverPhaseRecord(raw: string | null | undefined): DevserverPhaseRecord {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { phase: null, timestampS: null };
  const parts = trimmed.split(/\s+/);
  const phase = parts[0] && parts[0].length > 0 ? parts[0] : null;
  const tsRaw = parts[1];
  const timestampS = tsRaw !== undefined && /^\d+$/.test(tsRaw) ? Number(tsRaw) : null;
  return { phase, timestampS };
}

/**
 * Parse `DEVSERVER_RESTART_COUNT_FILE`'s content (a bare integer written by
 * `start-devserver.sh`). Missing/garbage content is honestly `0` attempts —
 * never negative, never `NaN` — so a container that has never crashed (or an
 * exec failure reading the file) never fabricates a nonzero attempt count.
 */
export function parseRestartAttempts(raw: string | null | undefined): number {
  const trimmed = (raw ?? '').trim();
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

// ── Dev-server self-heal: lazy restart on crash ──────────────────────────────
//
// Closes the HIGH-severity gap this module's earlier doc comments flagged:
// `start-devserver.sh` is only ever invoked ONCE, at boot, by `start-neko.sh`
// — nothing re-triggers it, so a dev server that crashes (bad import, OOM,
// syntax error, port conflict — all routine) stays dead until the whole
// container restarts. The Azure reference (`preview_bridge.py`'s
// `_ensure_devserver_starting`) closes the equivalent gap by lazily
// re-invoking its launcher on every proxied `/preview/*` request, gated by a
// flat 5s cooldown (`DEVSERVER_START_COOLDOWN_S`) plus the launcher script's
// own idempotency (a no-op if the process is already alive and the port is
// up).
//
// This Worker CANNOT trigger on `/preview/*` requests the same way: the
// client (`cloudflare-app-preview-canvas.tsx`) never even mounts the preview
// iframe — so never issues a single `/preview/*` request — until
// `/preview-status` first reports `is_real_app: true`. While the dev server
// is down, `/preview-status` (polled every 3s) is the ONLY request path this
// hostname ever sees. So the trigger point here is necessarily
// `probeAppPreviewStatus` (`src/index.ts`), not `handlePreviewProxy` — a
// deliberate divergence from Azure's exact trigger site, forced by this
// client's different iframe-mounting strategy, not a design preference. The
// cooldown/backoff semantics below otherwise match Azure's intent closely
// (same 5s base cooldown), extended with exponential backoff + a bounded
// escalation because a 3s poll interval hammers a instantly-crashing dev
// server far more aggressively than Azure's proxy-request trigger ever would.

/** Base cooldown before the first automatic restart after a crash — matches Azure's `DEVSERVER_START_COOLDOWN_S` (`preview_bridge.py`) exactly. */
export const DEVSERVER_RESTART_COOLDOWN_BASE_S = 5;

/**
 * Backoff cap: the cooldown between restart attempts never grows past this,
 * no matter how many consecutive times the dev server has crashed. This is
 * what keeps self-heal from EITHER burning container CPU in a tight relaunch
 * loop (a dev server crashing instantly on a real code error must not be
 * relaunched on every 3s poll) OR giving up on recovery entirely (a fixed,
 * finite retry cap would silently re-introduce the exact "unrecoverable
 * until container restart" bug this change exists to close, for the common
 * case of a user editing code to fix the crash while the sandbox stays up).
 */
export const DEVSERVER_RESTART_MAX_BACKOFF_S = 60;

/**
 * Once this many consecutive automatic recovery attempts have failed to
 * reach `running` since the last success, `effectiveDevserverPhase` escalates
 * the REPORTED phase from `crashed` to `crash_looping` — see that function's
 * doc comment for why this matters (a persistent failure must stay visibly
 * distinct from a transient one-off crash, not look like "still starting"
 * forever).
 */
export const DEVSERVER_RESTART_ESCALATE_ATTEMPTS = 5;

/**
 * Exponential backoff for the Nth (0-indexed `attempts`) automatic restart
 * since the last successful `running` phase, capped at
 * `DEVSERVER_RESTART_MAX_BACKOFF_S`. `attempts=0` (no failed recovery attempt
 * yet since the last success — i.e. this is the first crash) uses the flat
 * base cooldown, matching Azure's flat 5s cooldown for a first-time restart;
 * only REPEATED failures escalate the wait.
 */
export function computeDevserverRestartBackoffS(attempts: number): number {
  const exp = DEVSERVER_RESTART_COOLDOWN_BASE_S * 2 ** Math.max(0, attempts);
  return Math.min(exp, DEVSERVER_RESTART_MAX_BACKOFF_S);
}

export interface DevserverRestartDecision {
  /** Whether `probeAppPreviewStatus` should re-invoke the launcher right now. */
  restart: boolean;
  /** Seconds still remaining before the next attempt is allowed (`0` when `restart` is `true`). */
  cooldownRemainingS: number;
}

/**
 * Decide whether this `/preview-status` poll should re-invoke
 * `start-devserver.sh`. Mirrors `preview_bridge.py`'s
 * `_ensure_devserver_starting`: a cooldown gates how often we retry, so a
 * dev server that crashes instantly on every launch is retried at a bounded
 * rate instead of hammering the container on every 3s poll from the client.
 *
 * Trigger condition: `phase === 'crashed'` ONLY. `timeout` is deliberately
 * EXCLUDED, unlike Azure's unconditional-retry-relying-on-idempotency
 * approach: a `timeout` phase means the ready-waiter gave up waiting for the
 * port, but the dev-server PROCESS may still be alive and legitimately
 * compiling something slow — auto-restarting it would kill real progress
 * instead of recovering a dead process. Only a phase the ready-waiter
 * recorded as a confirmed process exit (`crashed`) is auto-restarted.
 *
 * Cooldown is measured from the phase file's OWN timestamp
 * (`phaseTimestampS` — when the launcher last wrote `crashed`), not a value
 * this function tracks itself: once a restart actually launches, the script
 * immediately transitions phase away from `crashed` (to `installing_deps` /
 * `starting`), so the crash timestamp naturally resets only on the NEXT
 * genuine crash. This needs no separate "last attempt" bookkeeping on the
 * Worker side — reusing the existing phase-file state machine rather than
 * inventing a parallel one.
 */
export function shouldTriggerDevserverRestart(
  phase: string | null,
  phaseTimestampS: number | null,
  nowS: number,
  attempts: number,
): DevserverRestartDecision {
  if (phase !== 'crashed') return { restart: false, cooldownRemainingS: 0 };
  if (phaseTimestampS === null) return { restart: true, cooldownRemainingS: 0 };
  const backoff = computeDevserverRestartBackoffS(attempts);
  const elapsed = nowS - phaseTimestampS;
  const remaining = backoff - elapsed;
  if (remaining <= 0) return { restart: true, cooldownRemainingS: 0 };
  return { restart: false, cooldownRemainingS: remaining };
}

/**
 * The `phase` value actually reported by `/preview-status`: identical to the
 * raw `DEVSERVER_PHASE_FILE` content EXCEPT once `attempts` (consecutive
 * recovery attempts since the last successful `running` phase — see
 * `DEVSERVER_RESTART_COUNT_FILE`) reaches `DEVSERVER_RESTART_ESCALATE_ATTEMPTS`
 * while the raw phase is still `crashed`, this reports `crash_looping`
 * instead.
 *
 * `crash_looping` is purely an ADDITIVE, informational `phase` value — like
 * every other phase value, it is NOT part of the client's settled
 * `error_reason` union (`no_package_json | port_not_listening |
 * upstream_error`) and never changes `error_reason`, which stays
 * `port_not_listening` throughout (nothing IS listening, whether this is the
 * first crash or the fifth). Its entire purpose is so a PERSISTENT,
 * currently-unrecovered failure stays visibly distinct — to logs, to any
 * future client work, to a human reading `/preview-status` directly — from
 * either "still starting" or "just crashed once, restart in flight". Without
 * this, an observer watching only `phase` cycle `crashed` -> `installing_deps`
 * -> `starting` -> `crashed` -> ... on every failed retry could mistake an
 * endless crash loop for ordinary startup progress.
 */
export function effectiveDevserverPhase(phase: string | null, attempts: number): string | null {
  if (phase === 'crashed' && attempts >= DEVSERVER_RESTART_ESCALATE_ATTEMPTS) return 'crash_looping';
  return phase;
}

/**
 * Shell command `probeAppPreviewStatus` execs to actually re-invoke the
 * launcher for a recovery attempt. Mirrors exactly how `start-neko.sh`
 * invokes it at boot (`"$DEVSERVER_BIN" "$WORKSPACE_ROOT"`), reading the
 * workspace root back out of `DEVSERVER_WORKSPACE_ROOT_FILE` (written
 * unconditionally by the launcher on every invocation, including the very
 * first) rather than re-deriving it, so a restart always targets the SAME
 * root the original boot-time launch resolved (sealed-delivery relocation,
 * etc.) — never `SANDBOX_WORKSPACE_MOUNT_PATH`. If the file is empty/missing
 * (defensive — should not happen once the launcher has run once), the empty
 * `"$root"` argument still resolves correctly: `start-devserver.sh`'s own
 * `${1:-...}` default falls through to `$EZIL_WORKSPACE_ROOT`/the neko
 * default for an empty positional argument, same as for an unset one.
 */
export function buildDevserverRestartCommand(devserverBinPath: string = DEFAULT_DEVSERVER_BIN_PATH): string {
  const escapedBin = devserverBinPath.replace(/'/g, `'\\''`);
  return `root="$(cat ${DEVSERVER_WORKSPACE_ROOT_FILE} 2>/dev/null)"; '${escapedBin}' "$root"`;
}

/**
 * Build the shell snippet that resolves the `has_package_json` check against
 * whichever workspace root `scripts/start-devserver.sh` last recorded in
 * `DEVSERVER_WORKSPACE_ROOT_FILE`, falling back to `fallbackMountPath`
 * (`SANDBOX_WORKSPACE_MOUNT_PATH`/`DEFAULT_WORKSPACE_MOUNT_PATH`) only when
 * the launcher has never run. Exits 0 iff `<root>/package.json` exists —
 * callers check the exec result's `exitCode`, mirroring every other probe in
 * `probeAppPreviewStatus`.
 */
export function buildPackageJsonCheckCommand(fallbackMountPath: string): string {
  const escapedFallback = fallbackMountPath.replace(/'/g, `'\\''`);
  return (
    `root="$(cat ${DEVSERVER_WORKSPACE_ROOT_FILE} 2>/dev/null)"; ` +
    `[ -n "$root" ] || root='${escapedFallback}'; ` +
    `test -f "$root/package.json"`
  );
}
