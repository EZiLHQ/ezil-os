import { describe, expect, it } from 'bun:test';
import { codeAuthRecovery, codeOriginRecovery } from './code-auth-recovery';
import { handleAwsBrowserHost } from './aws-origin';
import { mintPreviewCookie } from './hmac';
import vectors from './aws-gateway.vectors.json';
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

// S13: a Code navigation whose origin is not up (tunnel absent, fenced or of another epoch; the gateway or the
// host not answering behind it) renders the recovery document, never the raw `aws_origin_unavailable` JSON.
const CID = '11111111-1111-4111-8111-111111111111';
const rec = (over: Record<string, unknown> = {}) => ({
  computerId: CID, sandboxId: sid, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0', region: 'ap-south-1',
  publicIp: '13.200.1.2', tunnelId: 't-1', dnsRecordId: 'd-1', hostname: `c-${sid}-g1-e2.origin.example.org`,
  controlKey: vectors.controlKeyBase64, createdAt: 1, originVerified: true, originVerifiedAt: Date.now(), ...over,
}) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof handleAwsBrowserHost>[2]['lookup']>>>;
const authed = async (path = '/', headers: Record<string, string> = { 'sec-fetch-dest': 'iframe' }, method = 'GET') =>
  request(path, { ...headers, cookie: `ezil_preview=${await mintPreviewCookie(secret, sid)}` }, method);
const expectRecovery = async (res: Response, counts: number[], forwards: number) => {
  expect(res.status).toBe(502); expect(res.headers.get('content-type')).toContain('text/html');
  expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('set-cookie')).toBeNull();
  expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  const body = await res.text();
  expect(body).toContain('ezil:code-origin-unavailable'); expect(body).toContain('Try again'); expect(body).toContain('Reload EZiL OS');
  expect(body).not.toContain('DO_NOT_REFLECT'); expect(body).not.toContain('/workspace/project');
  expect(counts[1]).toBe(forwards);
};
describe('unavailable AWS Code origin', () => {
  it('a Code navigation with no live tunnel for this epoch gets the 502 recovery document, never raw JSON', async () => {
    const stale = [null, rec({ sandboxId: 'guac-other-computer' }), rec({ originVerified: false }), rec({ originVerifiedAt: Date.now() - 60_000 })];
    for (const found of stale) {
      const h = setup(); h.d.lookup = async () => found;
      const req = await authed('/?folder=/workspace/project&token=DO_NOT_REFLECT');
      await expectRecovery((await handleAwsBrowserHost(req, new URL(req.url), h.d))!, h.counts(), 0);
    }
    const h = setup(); h.d.zone = null; h.d.lookup = async () => rec();
    const req = await authed('/');
    await expectRecovery((await handleAwsBrowserHost(req, new URL(req.url), h.d))!, h.counts(), 0);
  });
  it('fetches, assets, WebSockets, POST and another port keep the strict 502 JSON refusal', async () => {
    for (const req of [await authed('/', { 'sec-fetch-dest': 'empty', accept: '*/*' }), await authed('/api'), await authed('/asset.js'),
      await authed('/', { 'sec-fetch-dest': 'iframe' }, 'POST'), await authed('/', { upgrade: 'websocket', 'sec-fetch-dest': 'iframe' })]) {
      const h = setup(), res = (await handleAwsBrowserHost(req, new URL(req.url), h.d))!;
      expect(res.status).toBe(502); expect(await res.json()).toEqual({ ok: false, error: 'aws_origin_unavailable' }); expect(h.counts()[1]).toBe(0);
    }
    const other = new Request(base.replace('aws-8443-', 'aws-3002-') + '/', { headers: { 'sec-fetch-dest': 'iframe', cookie: `ezil_preview=${await mintPreviewCookie(secret, sid)}` } });
    const h = setup(), res = (await handleAwsBrowserHost(other, new URL(other.url), h.d))!;
    expect(res.status).toBe(502); expect(await res.json()).toEqual({ ok: false, error: 'aws_origin_unavailable' });
  });
  it("a gateway 502/503/504 for the document becomes the recovery document; code-server's own answers and assets pass through", async () => {
    for (const status of [502, 503, 504]) {
      const h = setup(); h.d.lookup = async () => rec();
      let forwarded = 0;
      h.d.fetch = async () => { forwarded++; return new Response('<html>gateway says ' + status + '</html>', { status, headers: { 'content-type': 'text/html' } }); };
      const doc = await authed('/?folder=/workspace/project');
      const res = (await handleAwsBrowserHost(doc, new URL(doc.url), h.d))!;
      const body = await res.clone().text();
      await expectRecovery(res, [0, forwarded], 1);
      expect(body).not.toContain('gateway says');
      const asset = await authed('/static/x.js', { 'sec-fetch-dest': 'script' });
      const passed = (await handleAwsBrowserHost(asset, new URL(asset.url), h.d))!;
      expect(passed.status).toBe(status); expect(await passed.text()).toContain('gateway says');
    }
    for (const status of [200, 401, 403, 404]) {
      const h = setup(); h.d.lookup = async () => rec();
      h.d.fetch = async () => new Response('<html><body>ide ' + status + '</body></html>', { status, headers: { 'content-type': 'text/html' } });
      const doc = await authed('/');
      const res = (await handleAwsBrowserHost(doc, new URL(doc.url), h.d))!;
      expect(res.status).toBe(status); expect(await res.text()).toContain('ide ' + status);
    }
  });
  it('a forward that throws gives the document the recovery UI and every other request the JSON refusal, never a 500', async () => {
    const boom = async () => { throw new Error('https://secret.origin.invalid/__p/8443/?token=DO_NOT_REFLECT'); };
    const h = setup(); h.d.lookup = async () => rec(); h.d.fetch = boom;
    const doc = await authed('/');
    await expectRecovery((await handleAwsBrowserHost(doc, new URL(doc.url), h.d))!, h.counts(), 0);
    const asset = await authed('/asset.js');
    const res = (await handleAwsBrowserHost(asset, new URL(asset.url), h.d))!;
    expect(res.status).toBe(502); expect(await res.json()).toEqual({ ok: false, error: 'aws_origin_unavailable' });
  });
  it('the 502 document reflects nothing from the request and links only the fixed trusted OS origin', async () => {
    const req = request('/?parentOrigin=https://attacker.invalid', { 'sec-fetch-dest': 'iframe', referer: 'https://attacker.invalid/', host: 'attacker.invalid' });
    const html = await codeOriginRecovery(req, ['https://os-staging.ezil.work'])!.text();
    expect(html).toContain('href="https://os-staging.ezil.work/app/code" target="_top"'); expect(html).not.toContain('attacker.invalid');
    expect(html).not.toContain('top.location'); expect(html).toContain('id="retry"');
    for (const origins of [[], ['https://ok.example/path'], ['//attacker.invalid'], ['https://ok.example', 'https://other.example']]) {
      const plain = await codeOriginRecovery(request(), origins)!.text();
      expect(plain).not.toContain('<a '); expect(plain).toContain('reload the EZiL OS tab');
    }
    expect(codeOriginRecovery(request('/', { 'sec-fetch-dest': 'empty', accept: 'text/html' }))).toBeNull();
    expect(codeOriginRecovery(request('/api'))).toBeNull();
    expect(codeOriginRecovery(request('/', { 'sec-fetch-dest': 'iframe' }, 'POST'))).toBeNull();
  });
});
