/**
 * A preview URL whose container runtime is gone must never become the page the
 * user sees. Founder screenshots, os.ezil.org 2026-10-04: inside the desktop
 * window, raw `{"error":"Preview URL is stale because the sandbox runtime is not
 * active","code":"STALE_PREVIEW_URL"}`. That is the SDK's 410 body, passed
 * straight through by `proxyToSandbox` for a NAVIGATION of the desktop iframe
 * after the runtime it was minted on was replaced (image rollout, crash, an
 * idle-stop the user came back to).
 */
import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

/** Byte-for-byte what `@cloudflare/sandbox` 0.12.1 `stalePreviewURLResponse()` returns. */
const sdkStale = () => new Response(JSON.stringify({
  error: 'Preview URL is stale because the sandbox runtime is not active',
  code: 'STALE_PREVIEW_URL',
}), { status: 410, headers: { 'Content-Type': 'application/json' } });

const req = (headers: Record<string, string>, method = 'GET') =>
  new Request('https://8181-guac-a-b-nekodesktop.ezil.org/?usr=EZiL', { method, headers });

describe('a stale preview runtime never reaches the user as raw JSON', () => {
  it('🔴 the desktop iframe navigating to a stale runtime gets a page that recovers, not the SDK JSON', async () => {
    const { recoverableStalePreview, PREVIEW_RUNTIME_STALE_MESSAGE } = await import('./stale-preview');
    const res = await recoverableStalePreview(req({ 'sec-fetch-dest': 'iframe', accept: 'text/html' }), sdkStale());
    const body = await res.text();
    expect(res.status).toBe(410);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).not.toContain('STALE_PREVIEW_URL');
    expect(body).not.toContain('"error"');
    expect(body).toContain('Reconnecting to your computer');
    expect(body).toContain(PREVIEW_RUNTIME_STALE_MESSAGE);   // tells the shell to mint against the active runtime
  });

  it('retains the navigation attempt without allowing inline-script breakout', async () => {
    const { recoverableStalePreview } = await import('./stale-preview');
    const attempt = '</script><script>alert("injected")</script>';
    const url = new URL('https://viewer.example/');
    url.searchParams.set('ezilAttempt', attempt);
    const response = await recoverableStalePreview(new Request(url, {
      headers: { 'sec-fetch-dest': 'iframe' },
    }), sdkStale());
    const body = await response.text();
    expect((body.match(/<script>/g) ?? []).length).toBe(1);
    expect((body.match(/<\/script>/g) ?? []).length).toBe(1);
    const script = body.match(/<script>([\s\S]*?)<\/script>/)![1];
    let received: unknown;
    new Function('parent', script)({ postMessage: (data: unknown) => { received = data; } });
    expect(received).toEqual({ type: 'ezil:preview-runtime-stale', attempt });
  });

  it('a top-level document navigation (no fetch metadata, HTML accepted) is treated the same', async () => {
    const { recoverableStalePreview } = await import('./stale-preview');
    const res = await recoverableStalePreview(req({ accept: 'text/html,application/xhtml+xml' }), sdkStale());
    expect(await res.text()).not.toContain('STALE_PREVIEW_URL');
  });

  it('XHR/fetch from the neko client keeps the SDK JSON (its own reconnect logic reads it)', async () => {
    const { recoverableStalePreview } = await import('./stale-preview');
    const res = await recoverableStalePreview(req({ 'sec-fetch-dest': 'empty', accept: '*/*' }), sdkStale());
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('STALE_PREVIEW_URL');
  });

  it('only the SDK stale answer is rewritten: other statuses and other 410 bodies pass through', async () => {
    const { recoverableStalePreview } = await import('./stale-preview');
    const ok = new Response('<html>neko</html>', { status: 200 });
    expect(await recoverableStalePreview(req({ 'sec-fetch-dest': 'iframe' }), ok)).toBe(ok);
    const other410 = new Response('gone', { status: 410 });
    expect(await (await recoverableStalePreview(req({ 'sec-fetch-dest': 'iframe' }), other410)).text()).toBe('gone');
    expect((await recoverableStalePreview(req({ 'sec-fetch-dest': 'iframe' }, 'POST'), sdkStale())).headers.get('content-type'))
      .toContain('application/json');
  });

  it('the Worker routes EVERY proxied preview answer through it', () => {
    const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
    expect(src).toContain('const proxied = await proxyToSandbox(request, env);\n    if (proxied) return recoverableStalePreview(request, proxied);');
  });
});
