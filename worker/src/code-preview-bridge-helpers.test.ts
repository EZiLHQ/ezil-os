import { runInNewContext } from 'node:vm';
import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { inlineScriptBodies } from './inline-script';

/** `<script …>…</script>` elements of a served page, by linear scanning (attributes and body). */
function scriptElements(html: string): Array<{ attrs: string; body: string }> {
  const lower = html.toLowerCase(), out: Array<{ attrs: string; body: string }> = [];
  for (let at = 0; ;) {
    const start = lower.indexOf('<script', at);
    if (start < 0) break;
    const tagEnd = html.indexOf('>', start);
    if (tagEnd < 0) break;
    const end = lower.indexOf('</script>', tagEnd + 1);
    if (end < 0) break;
    out.push({ attrs: html.slice(start + '<script'.length, tagEnd), body: html.slice(tagEnd + 1, end) });
    at = end + '</script>'.length;
  }
  return out;
}

export const inspectorCspPolicies = [
  "script-src 'nonce-existing'",
  "script-src 'nonce-existing'; script-src-elem 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='",
  "default-src 'none'",
  "default-src 'none'; script-src-elem 'none'",
  "script-src 'unsafe-inline'; img-src 'none'",
  "script-src 'nonce-existing' 'strict-dynamic'; script-src-elem 'nonce-existing' 'strict-dynamic'",
  "frame-ancestors 'none'; script-src 'nonce-existing', default-src 'none'; frame-ancestors 'none'; img-src https://images.example",
  "default-src 'none', script-src-elem 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; connect-src 'none'",
];

// A focused CSP evaluator for these classic-script fixtures. Policies intersect; the first
// occurrence of a directive wins. External hashes alone cannot authorize a tag without integrity.
function scriptPolicies(headers: Headers) {
  return (headers.get('content-security-policy') ?? '').split(',').map(policy => {
    const directives = new Map<string, string[]>();
    for (const d of policy.split(';')) {
      const [name, ...sources] = d.trim().split(/\s+/);
      if (!directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
    }
    return directives.get('script-src-elem') ?? directives.get('script-src') ?? directives.get('default-src');
  });
}
const scriptHash = (code: string) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`;
const inlineAllowed = (sources: string[] | undefined, code: string) => !sources || sources.includes(scriptHash(code))
  || (sources.includes("'unsafe-inline'") && !sources.some(s => /^'(nonce-|sha(?:256|384|512)-)/.test(s)));

export function previewExternalScriptAllowed(headers: Headers, pageUrl: string, scriptUrl: string, loader?: string) {
  const page = new URL(pageUrl), script = new URL(scriptUrl, page);
  return scriptPolicies(headers).every(sources => {
    if (!sources) return true;
    if (sources.includes("'strict-dynamic'")) return loader !== undefined && sources.includes(scriptHash(loader));
    return sources.some(source => {
      if (source === "'self'") return script.origin === page.origin;
      if (source === '*') return true;
      if (/^https?:$/.test(source)) return script.protocol === source;
      try {
        const allowed = new URL(source);
        return allowed.origin === script.origin && (allowed.pathname === '/' || (allowed.pathname.endsWith('/')
          ? script.pathname.startsWith(allowed.pathname) : script.pathname === allowed.pathname));
      } catch { return false; }
    });
  });
}

/** Check that restrictive response CSPs permit the exact injected inline code. */
export async function expectPreviewScriptsAllowed(html: string, headers: Headers) {
  for (const body of inlineScriptBodies(html)) {
    for (const sources of scriptPolicies(headers)) expect(inlineAllowed(sources, body)).toBe(true);
  }
}

/** Execute injected inline scripts and collect the external scripts a browser would request. */
export function previewPageScripts(html: string, pageUrl: string, headers = new Headers()) {
  const location = new URL(pageUrl), urls: URL[] = [], messages: unknown[] = [];
  let loader: string | undefined;
  const requestScript = (src: string) => {
    expect(previewExternalScriptAllowed(headers, pageUrl, src, loader)).toBe(true);
    urls.push(new URL(src, location));
  };
  const listeners: Array<(event: unknown) => void> = [];
  const parent = { postMessage(data: unknown, origin: string) { messages.push({ data, origin }); } };
  const window = { location, parent, WebSocket: class {}, addEventListener(type: string, fn: (event: unknown) => void) {
    if (type === 'message') listeners.push(fn);
  } };
  const document = { createElement: () => ({ src: '', async: false }), head: {
    appendChild(script: { src: string }) { requestScript(script.src); },
  } };
  for (const { attrs, body } of scriptElements(html)) {
    const src = /\bsrc="([^"]*)"/.exec(attrs);
    if (src) requestScript(src[1]);
    else {
      for (const sources of scriptPolicies(headers)) expect(inlineAllowed(sources, body)).toBe(true);
      loader = body;
      runInNewContext(body, { window, document, location, URL, URLSearchParams });
      loader = undefined;
    }
  }
  return { urls, hello(origin: string, nonce: string) {
    for (const fn of listeners) fn({ source: parent, origin, data: { type: 'ezil.preview.hello', v: 1, nonce } });
    return messages;
  } };
}
