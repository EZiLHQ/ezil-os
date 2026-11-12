import { describe, expect, it } from 'bun:test';
import { codeAuthRecovery } from './code-auth-recovery';
import { handleAwsBrowserHost } from './aws-origin';
import { mintPreviewCookie } from './hmac';
const sid = 'guac-user-computer';
const base = `https://aws-8443-${sid}-aws.preview.example.org`;
const secret = 'local-fixture-only';
function setup() {
  let lookups = 0, forwards = 0;
  return { d: { routingEnabled: true, zone: 'origin.example.org', zoneRoot: 'preview.example.org', secrets: [secret],
    codeShellOrigins: ['https://os-staging.ezil.work'], nowMs: () => Date.now(), lookup: async () => { lookups++; return null; },
    fetch: async () => { forwards++; return new Response('unexpected'); } }, counts: () => [lookups, forwards] };
}
const request = (path = '/', headers: Record<string, string> = { 'sec-fetch-dest': 'iframe' }, method = 'GET') => new Request(base + path, { headers, method });
describe('expired AWS Code navigation', () => {
  it('actual unauthenticated Code gate gives a noncacheable401 document, no cookie/redirect/proxy access', async () => {
    const h = setup(), req = request('/?folder=/workspace/project&token=DO_NOT_REFLECT');
    const res = (await handleAwsBrowserHost(req, new URL(req.url), h.d))!;
    expect(res.status).toBe(401); expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('set-cookie')).toBeNull(); expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = await res.text(); expect(body).toContain('ezil:code-auth-required'); expect(body).toContain('Reload EZiL OS');
    expect(body).not.toContain('DO_NOT_REFLECT'); expect(body).not.toContain('/workspace/project');
    expect(h.counts()).toEqual([0, 0]);
  });
  it('expired and foreign sandbox cookies cannot authenticate through the recovery UI', async () => {
    for (const cookie of [await mintPreviewCookie(secret, sid, Date.now() - 86_400_000), await mintPreviewCookie(secret, 'guac-other-computer')]) {
      const h = setup(), req = request('/', { 'sec-fetch-dest': 'iframe', cookie: `ezil_preview=${cookie}` });
      expect((await handleAwsBrowserHost(req, new URL(req.url), h.d))!.status).toBe(401); expect(h.counts()).toEqual([0, 0]);
    }
  });
  it('API/fetch/assets/POST/WebSocket stay strict JSON401; another port never gets Code recovery', async () => {
    for (const req of [request('/', { 'sec-fetch-dest': 'empty', accept: '*/*' }), request('/api'), request('/asset.js'),
      request('/', { 'sec-fetch-dest': 'iframe' }, 'POST'), request('/', { upgrade: 'websocket', 'sec-fetch-dest': 'iframe' }),
      new Request(base.replace('aws-8443-', 'aws-3002-') + '/', { headers: { 'sec-fetch-dest': 'iframe' } })]) {
      const h = setup(), res = (await handleAwsBrowserHost(req, new URL(req.url), h.d))!;
      expect(res.status).toBe(401); expect(await res.json()).toEqual({ ok: false, error: 'aws_preview_auth_required' }); expect(h.counts()).toEqual([0, 0]);
    }
  });
  it('old shells receive a user-activated fixed trusted OS top link, never request-selected navigation', async () => {
    const req = request('/?parentOrigin=https://attacker.invalid', { 'sec-fetch-dest': 'iframe', referer: 'https://attacker.invalid/', host: 'attacker.invalid' });
    const html = await codeAuthRecovery(req, ['https://os-staging.ezil.work'])!.text();
    expect(html).toContain('href="https://os-staging.ezil.work/app/code" target="_top"');
    expect(html).toContain('rel="noreferrer noopener"'); expect(html).not.toContain('attacker.invalid');
    expect(html).not.toContain('top.location');
  });
  it('unknown or malformed configured origin has no misleading link or request-derived fallback', async () => {
    for (const origins of [[], ['https://ok.example/path'], ['//attacker.invalid'], ['https://ok.example', 'https://other.example'], ['https://ok.example/"onclick="x']]) {
      const html = await codeAuthRecovery(request(), origins)!.text();
      expect(html).not.toContain('<a '); expect(html).toContain('Reload the EZiL OS tab');
    }
  });
  it('all normal document navigation forms are recognized; fetch cannot opt in with accept when dest=empty', () => {
    for (const dest of ['document', 'iframe', 'frame']) expect(codeAuthRecovery(request('/', { 'sec-fetch-dest': dest }))!.status).toBe(401);
    expect(codeAuthRecovery(request('/', { accept: 'text/html,application/xhtml+xml' }))!.status).toBe(401);
    expect(codeAuthRecovery(request('/', { 'sec-fetch-dest': 'empty', accept: 'text/html' }))).toBeNull();
  });
});
