import { runInNewContext } from 'node:vm';
import { expect } from 'bun:test';

/** Check that restrictive response CSPs permit the exact injected inline code. */
export async function expectPreviewScriptsAllowed(html: string, headers: Headers) {
  const csp = headers.get('content-security-policy') ?? '';
  const directives = new Map(csp.split(';').map(d => { const [name, ...sources] = d.trim().split(/\s+/); return [name, sources]; }));
  const sources = directives.get('script-src-elem') ?? directives.get('script-src') ?? directives.get('default-src') ?? [];
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
    expect(sources).toContain(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  }
  expect(csp).not.toContain("'unsafe-inline'");
}

/** Execute injected inline scripts and collect the external scripts a browser would request. */
export function previewPageScripts(html: string, pageUrl: string) {
  const location = new URL(pageUrl), urls: URL[] = [], messages: unknown[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const parent = { postMessage(data: unknown, origin: string) { messages.push({ data, origin }); } };
  const window = { location, parent, WebSocket: class {}, addEventListener(type: string, fn: (event: unknown) => void) {
    if (type === 'message') listeners.push(fn);
  } };
  const document = { createElement: () => ({ src: '', async: false }), head: {
    appendChild(script: { src: string }) { urls.push(new URL(script.src, location)); },
  } };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const src = /\bsrc="([^"]*)"/.exec(match[1]);
    if (src) urls.push(new URL(src[1], location));
    else runInNewContext(match[2], { window, document, location, URL, URLSearchParams });
  }
  return { urls, hello(origin: string, nonce: string) {
    for (const fn of listeners) fn({ source: parent, origin, data: { type: 'ezil.preview.hello', v: 1, nonce } });
    return messages;
  } };
}
