import { runInNewContext } from 'node:vm';
import { expect } from 'bun:test';
import { createHash } from 'node:crypto';

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
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    for (const sources of scriptPolicies(headers)) expect(inlineAllowed(sources, match[1])).toBe(true);
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
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc="([^"]*)"/.exec(match[1]);
    if (src) requestScript(src[1]);
    else {
      for (const sources of scriptPolicies(headers)) expect(inlineAllowed(sources, match[2])).toBe(true);
      loader = match[2];
      runInNewContext(match[2], { window, document, location, URL, URLSearchParams });
      loader = undefined;
    }
  }
  return { urls, hello(origin: string, nonce: string) {
    for (const fn of listeners) fn({ source: parent, origin, data: { type: 'ezil.preview.hello', v: 1, nonce } });
    return messages;
  } };
}
