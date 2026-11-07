/**
 * AWS gateway (GATEWAY-CONTRACT-v1 GW-2/GW-4): the gw1 signer against the SHARED vectors in
 * `./aws-gateway.vectors.json` (the host edge's Python verifier reads the same file in
 * `infra/host-agent/test/test_edge.py`), origin naming, the zone allowlist, the browser
 * host gate, and the guarantee that no Cloudflare hostname is ever claimed by this module.
 */
import { describe, expect, it } from 'bun:test';
import vectors from './aws-gateway.vectors.json';
import {
  AWS_EDGE_PORTS,
  awsBrowserUrl,
  AWS_GATEWAY_HEADER,
  awsOriginHostname,
  awsRoutingEnabled,
  decodeControlKey,
  gatewayPayload,
  handleAwsBrowserHost,
  handleAwsPreview,
  parseAwsBrowserHost,
  proxyToAwsOrigin,
  resolveAwsOriginZone,
  sendAwsControl,
  signGatewayHeader,
  verifyGatewayHeader,
  type AwsTunnelRecord,
  type FetchLike,
} from './aws-origin';
import { mintPreviewBootstrapToken, mintPreviewCookie, type PreviewTokenV2Claims } from './hmac';

const KEY = decodeControlKey(vectors.controlKeyBase64)!;
const SECRET = 'aws-origin-test-secret';
const ZONE = 'origin.example.net';
const ROOT = 'preview.example.org';
const CID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const SID = 'guac-0a0a0a0a0a0a0a0a-0b0b0b0b0b0b4b0b';

function record(over: Partial<AwsTunnelRecord> = {}): AwsTunnelRecord {
  return {
    computerId: CID, sandboxId: SID, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0',
    region: 'ap-south-1', publicIp: '13.200.1.2', tunnelId: 't-1', dnsRecordId: 'd-1',
    hostname: `c-${SID}-g1-e2.${ZONE}`, controlKey: vectors.controlKeyBase64, createdAt: 1, originVerified: true,
    originVerifiedAt: Date.now(), ...over,
  };
}

function captureFetch(): { fetch: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return new Response('origin', { status: 200 }); } };
}

describe('gw1 shared vectors', () => {
  it('the signer reproduces every valid vector header byte for byte', async () => {
    for (const v of vectors.valid) {
      expect(gatewayPayload(v, v.ts, v.method, v.path)).toBe(v.payload);
      expect(await signGatewayHeader(KEY, v, v.method, v.path, v.ts)).toBe(v.header);
      expect(await verifyGatewayHeader(v.header, KEY, v, v.method, v.path, v.ts)).toEqual({ ok: true });
    }
  });
  it('every invalid vector is refused with its stated error', async () => {
    for (const v of vectors.invalid) {
      const p = v.present;
      expect(await verifyGatewayHeader(v.header, KEY, p, p.method, p.path, p.ts)).toEqual({ ok: false, error: v.error });
    }
  });
  it('skew window: 120 s past and 5 s future accepted, one more second refused', async () => {
    const v = vectors.valid[0]!;
    expect((await verifyGatewayHeader(v.header, KEY, v, v.method, v.path, v.ts + 120)).ok).toBe(true);
    expect(await verifyGatewayHeader(v.header, KEY, v, v.method, v.path, v.ts + 121)).toEqual({ ok: false, error: 'gw_stale' });
    expect((await verifyGatewayHeader(v.header, KEY, v, v.method, v.path, v.ts - 5)).ok).toBe(true);
    expect(await verifyGatewayHeader(v.header, KEY, v, v.method, v.path, v.ts - 6)).toEqual({ ok: false, error: 'gw_stale' });
  });
  it('a missing header and a framing-breaking path are refused, never signed', async () => {
    const v = vectors.valid[0]!;
    expect(await verifyGatewayHeader(null, KEY, v, v.method, v.path, v.ts)).toEqual({ ok: false, error: 'gw_missing' });
    expect(() => gatewayPayload(v, v.ts, 'GET', '/a|b')).toThrow();
    expect(() => gatewayPayload({ ...v, leaseEpoch: 0 }, v.ts, 'GET', '/')).toThrow();
  });
  it('the control key must be exactly 32 bytes of base64', () => {
    expect(decodeControlKey(vectors.controlKeyBase64)?.length).toBe(32);
    expect(decodeControlKey(btoa('short'))).toBeNull();
    expect(decodeControlKey(undefined)).toBeNull();
  });
});

describe('origin naming and the zone allowlist', () => {
  it('origin hostname is c-<sandboxId>-g<generation>-e<leaseEpoch>.<zone>', () => {
    expect(awsOriginHostname(SID, 1, 2, ZONE)).toBe(`c-${SID}-g1-e2.${ZONE}`);
  });
  it('mixed-case or foreign sandbox ids, epoch 0 and bad zones are unroutable', () => {
    expect(() => awsOriginHostname(SID.toUpperCase(), 1, 2, ZONE)).toThrow();
    expect(() => awsOriginHostname('evil.com', 1, 2, ZONE)).toThrow();
    expect(() => awsOriginHostname(SID, 1, 0, ZONE)).toThrow();
    expect(() => awsOriginHostname(SID, 1, 2, 'localhost')).toThrow();
  });
  it('the zone is used only when it is also on the allowlist', () => {
    expect(resolveAwsOriginZone({ AWS_ORIGIN_ZONE: ZONE, AWS_ORIGIN_ZONE_ALLOWLIST: `other.net, ${ZONE}` })).toBe(ZONE);
    expect(resolveAwsOriginZone({ AWS_ORIGIN_ZONE: ZONE, AWS_ORIGIN_ZONE_ALLOWLIST: 'other.net' })).toBeNull();
    expect(resolveAwsOriginZone({ AWS_ORIGIN_ZONE: ZONE })).toBeNull();
    expect(resolveAwsOriginZone({})).toBeNull();
  });
  it('routing is off unless explicitly enabled', () => {
    expect(awsRoutingEnabled(undefined)).toBe(false);
    expect(awsRoutingEnabled('0')).toBe(false);
    expect(awsRoutingEnabled('on')).toBe(true);
  });
});

describe('Cloudflare hostnames are never claimed (regression)', () => {
  const cfHosts = [
    ROOT, `8181-${SID}-nekodesktop.${ROOT}`, `8080-${SID}-desktop.${ROOT}`, `3002-${SID}-app.${ROOT}`,
    `8443-${SID}-code.${ROOT}`, `aws-9223-${SID}-aws.${ROOT}`, `aws-8181-${SID}-aws.other.org`, `aws-8181-${SID.toUpperCase()}x-aws.${ROOT}`,
    // Without the route suffix the zone catch-all owns the host: never claim it.
    `aws-8181-${SID}.${ROOT}`, `aws-8181-${SID}-awsx.${ROOT}`, `x-aws-8181-${SID}-aws.${ROOT}`,
  ];
  it('parseAwsBrowserHost returns null for every CF preview, bridge and foreign host', () => {
    for (const h of cfHosts) expect(parseAwsBrowserHost(h, ROOT)).toBeNull();
    expect(parseAwsBrowserHost(`aws-8181-${SID}-aws.${ROOT}`, ROOT)).toEqual({ port: 8181, sandboxId: SID });
  });
  it('handleAwsBrowserHost returns null (caller dispatch unchanged) and never fetches', async () => {
    const f = captureFetch();
    for (const h of cfHosts) {
      const res = await handleAwsBrowserHost(new Request(`https://${h}/x`), new URL(`https://${h}/x`), {
        routingEnabled: true, zone: ZONE, secrets: [SECRET], zoneRoot: ROOT, lookup: async () => record(), fetch: f.fetch, nowMs: Date.now,
      });
      expect(res).toBeNull();
    }
    expect(f.calls.length).toBe(0);
  });
  it('the edge port set mirrors the CF exposed ports and excludes the browser sidecar', () => {
    expect([...AWS_EDGE_PORTS].sort()).toEqual([3002, 8080, 8181, 8443]);
  });
});

describe('proxyToAwsOrigin', () => {
  it('signs the /__p/<port> path, strips client gw/auth/preview-cookie, keeps other cookies and query', async () => {
    const f = captureFetch();
    const req = new Request(`https://aws-8443-${SID}-aws.${ROOT}/vscode/a?folder=/root`, {
      method: 'POST', body: 'payload',
      headers: {
        [AWS_GATEWAY_HEADER]: 'gw1.1.forged', 'x-ezil-auth': 'v2.x.y', cookie: `ezil_preview=abc; vscode-tkn=keep`,
        host: 'evil.example', 'x-forwarded-host': 'evil.example, another.example',
        'x-forwarded-proto': 'http', forwarded: 'host=evil.example;proto=http',
        origin: `https://aws-8443-${SID}-aws.${ROOT}`,
      },
    });
    const now = 1791964800;
    await proxyToAwsOrigin(req, new URL(req.url), record(), ZONE, 8443, f.fetch, now);
    expect(f.calls.length).toBe(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(`https://c-${SID}-g1-e2.${ZONE}/__p/8443/vscode/a?folder=/root`);
    const h = new Headers(init.headers);
    expect(h.get('x-ezil-auth')).toBeNull();
    expect(h.get('host')).toBeNull();
    expect(h.get('x-forwarded-host')).toBe(`aws-8443-${SID}-aws.${ROOT}`);
    expect(h.get('x-forwarded-proto')).toBeNull();
    expect(h.get('forwarded')).toBeNull();
    expect(h.get('origin')).toBe(`https://aws-8443-${SID}-aws.${ROOT}`);
    expect(h.get('cookie')).toBe('vscode-tkn=keep');
    expect(await verifyGatewayHeader(h.get(AWS_GATEWAY_HEADER), KEY, record(), 'POST', '/__p/8443/vscode/a', now)).toEqual({ ok: true });
    expect(init.redirect).toBe('manual');
    expect(init.body).not.toBeUndefined();
  });
  it('a WebSocket upgrade keeps its Upgrade header; GET carries no body', async () => {
    const f = captureFetch();
    const req = new Request(`https://aws-8181-${SID}-aws.${ROOT}/api/ws`, { headers: { upgrade: 'websocket', connection: 'Upgrade' } });
    await proxyToAwsOrigin(req, new URL(req.url), record(), ZONE, 8181, f.fetch, 1791964800);
    const h = new Headers(f.calls[0]!.init.headers);
    expect(h.get('upgrade')).toBe('websocket');
    expect(h.get('x-forwarded-host')).toBe(`aws-8181-${SID}-aws.${ROOT}`);
    expect(f.calls[0]!.init.body).toBeUndefined();
  });
  it('a port outside the edge set or a bad control key fails closed without fetching', async () => {
    const f = captureFetch();
    const req = new Request(`https://x/`);
    expect((await proxyToAwsOrigin(req, new URL(req.url), record(), ZONE, 9223, f.fetch, 1)).status).toBe(502);
    expect((await proxyToAwsOrigin(req, new URL(req.url), record({ controlKey: 'bad' }), ZONE, 8181, f.fetch, 1)).status).toBe(502);
    expect(f.calls.length).toBe(0);
  });
});

describe('handleAwsBrowserHost', () => {
  const host = `aws-8181-${SID}-aws.${ROOT}`;
  const deps = (over: Partial<Parameters<typeof handleAwsBrowserHost>[2]> = {}) => {
    const f = captureFetch();
    return { f, d: { routingEnabled: true, zone: ZONE, secrets: [SECRET], zoneRoot: ROOT, lookup: async () => record(), fetch: f.fetch, nowMs: Date.now, ...over } };
  };
  const call = (path: string, d: Parameters<typeof handleAwsBrowserHost>[2], init: RequestInit = {}) =>
    handleAwsBrowserHost(new Request(`https://${host}${path}`, init), new URL(`https://${host}${path}`), d);

  it('disabled routing answers 404 and never forwards', async () => {
    const { f, d } = deps({ routingEnabled: false });
    expect((await call('/', d))!.status).toBe(404);
    expect(f.calls.length).toBe(0);
  });
  it('no secret fails closed (401), unlike the CF local-dev bypass', async () => {
    const { f, d } = deps({ secrets: [] });
    expect((await call('/', d))!.status).toBe(401);
    expect(f.calls.length).toBe(0);
  });
  it('bootstrap: a valid token sets the sandbox-bound cookie and redirects same-origin only', async () => {
    const { d } = deps();
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const ok = (await call(`/preview-bootstrap?token=${encodeURIComponent(token)}&path=/desk?x=1`, d))!;
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/desk?x=1');
    expect(ok.headers.get('set-cookie')).toMatch(/^ezil_preview=guac-.*HttpOnly; Secure; SameSite=None; Partitioned; Path=\/$/);
    const open = (await call(`/preview-bootstrap?token=${encodeURIComponent(token)}&path=//evil.com/x`, d))!;
    expect(open.headers.get('location')).toBe('/');
    const wrong = await mintPreviewBootstrapToken(SECRET, 'guac-other-sandbox');
    expect((await call(`/preview-bootstrap?token=${encodeURIComponent(wrong)}`, d))!.status).toBe(401);
  });
  it('bootstrap: a path whose dot segments normalise to `//host` is invalid_redirect, never a Location', async () => {
    const { d } = deps();
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const boot = (path: string) => call(`/preview-bootstrap?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`, d);
    for (const path of ['/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/%2E//evil.com', '/.%2e//evil.com', '/a/..//evil.com',
      '/\\evil.com', '/\t//evil.com', '/\\[']) {
      const res = (await boot(path))!;
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_redirect' });
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    // A raw `//host` still falls back to the root, and a plain path is forwarded unchanged.
    expect((await boot('//evil.com/x'))!.headers.get('location')).toBe('/');
    const ok = (await boot('/app?x=1'))!;
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/app?x=1');
  });
  it('no or wrong-sandbox cookie: 401 and nothing forwarded', async () => {
    const { f, d } = deps();
    expect((await call('/', d))!.status).toBe(401);
    const other = await mintPreviewCookie(SECRET, 'guac-aaaa-bbbb');
    expect((await call('/', d, { headers: { cookie: `ezil_preview=${other}` } }))!.status).toBe(401);
    expect(f.calls.length).toBe(0);
  });
  it('valid cookie but no record, a record for another sandbox, or an unverified origin: 502', async () => {
    const cookie = `ezil_preview=${await mintPreviewCookie(SECRET, SID)}`;
    for (const lookup of [async () => null, async () => record({ sandboxId: 'guac-x-y' }), async () => record({ originVerified: false })]) {
      const { f, d } = deps({ lookup });
      const res = (await call('/', d, { headers: { cookie } }))!;
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'aws_origin_unavailable' });
      expect(f.calls.length).toBe(0);
    }
  });
  it('stale, legacy and future verification snapshots never forward HTTP or WebSockets', async () => {
    const now = Date.now();
    const cookie = `ezil_preview=${await mintPreviewCookie(SECRET, SID)}`;
    for (const originVerifiedAt of [undefined, now - 60_000, now + 1]) {
      for (const upgrade of [false, true]) {
        const { f, d } = deps({ nowMs: () => now, lookup: async () => record({ originVerifiedAt }) });
        const headers = new Headers({ cookie });
        if (upgrade) headers.set('upgrade', 'websocket');
        expect((await call('/api/ws', d, { headers }))!.status).toBe(502);
        expect(f.calls.length).toBe(0);
      }
    }
  });
  it('auto-connects across tunnel epochs without a credential in the browser URL', async () => {
    let epoch = 2;
    const { f, d } = deps({ lookup: async () => record({ leaseEpoch: epoch }) });
    const cookie = `ezil_preview=${await mintPreviewCookie(SECRET, SID)}`;
    const redirect = (await call('/', d, { headers: { cookie } }))!;
    expect(redirect.status).toBe(302);
    const path = '/?usr=EZiL&pwd=ezil-preview&embed=1';
    expect(redirect.headers.get('location')).toBe(path);
    expect(redirect.headers.get('cache-control')).toBe('no-store');
    expect(f.calls.length).toBe(0);
    expect((await call(path, d, { headers: { cookie } }))!.status).toBe(200);
    const { deriveNekoCredentials } = await import('./hmac');
    const { user } = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: SECRET }, SID);
    expect(path).not.toContain(user);
    const ws = '/ws?password=ezil-preview&username=EZiL';
    for (epoch of [2, 3]) {
      await call(ws, d, { headers: { cookie, upgrade: 'websocket' } });
      const target = new URL(f.calls[f.calls.length - 1]!.url);
      expect(target.hostname).toBe(`c-${SID}-g1-e${epoch}.${ZONE}`);
      expect(target.searchParams.get('password')).toBe(user);
      expect(target.searchParams.get('username')).toBe('EZiL');
    }
  });
});

describe('handleAwsPreview', () => {
  const claims = (over: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims => ({
    ts: Date.now(), sandboxId: SID, computerId: CID, userId: 'u1', provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2, ...over,
  });
  const deps = (over: Partial<Parameters<typeof handleAwsPreview>[1]> = {}) => ({
    zone: ZONE, secrets: [SECRET], zoneRoot: ROOT, lookup: async () => record(),
    verifyOrigin: async () => 'verified' as const, nowMs: Date.now, ...over,
  });
  it('claims naming another epoch, generation or computer: 502', async () => {
    for (const c of [claims({ leaseEpoch: 3 }), claims({ generation: 2 }), claims({ computerId: '1b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' })]) {
      expect((await handleAwsPreview(c, deps())).status).toBe(502);
    }
  });
  it('a cloudflare claim is never served here', async () => {
    expect((await handleAwsPreview(claims({ provider: 'cloudflare' }), deps())).status).toBe(502);
  });
  it('unverified origin: mismatch 502, not yet connected 503, verified 200', async () => {
    const r = record({ originVerified: false });
    expect((await handleAwsPreview(claims(), deps({ lookup: async () => r, verifyOrigin: async () => 'mismatch' }))).status).toBe(502);
    expect((await handleAwsPreview(claims(), deps({ lookup: async () => r, verifyOrigin: async () => 'not_connected' }))).status).toBe(503);
    expect((await handleAwsPreview(claims(), deps({ lookup: async () => r }))).status).toBe(200);
  });
  it('rechecks expired, legacy and future snapshots before preparing the desktop', async () => {
    const now = Date.now();
    for (const originVerifiedAt of [undefined, now - 60_000, now + 1]) {
      for (const verdict of ['mismatch', 'not_connected'] as const) {
        const checked: string[] = [];
        let prepared = 0;
        const res = await handleAwsPreview(claims(), deps({
          nowMs: () => now, lookup: async () => record({ originVerifiedAt }),
          verifyOrigin: async (sid) => { checked.push(sid); return verdict; },
          ensureDesktop: async () => { prepared++; throw new Error('must not prepare an unverified desktop'); },
        }));
        expect(res.status).toBe(verdict === 'mismatch' ? 502 : 503);
        expect(await res.json()).toEqual({ ok: false, error: verdict === 'mismatch' ? 'tunnel_origin_mismatch' : 'aws_origin_starting' });
        expect(checked).toEqual([SID]);
        expect(prepared).toBe(0);
      }
    }
    let checked = 0;
    for (const age of [59_999, 60_000]) {
      const res = await handleAwsPreview(claims(), deps({
        nowMs: () => now, lookup: async () => record({ originVerifiedAt: now - age }),
        verifyOrigin: async () => { checked++; return 'verified'; },
      }));
      expect(res.status).toBe(200);
      expect(checked).toBe(age === 59_999 ? 0 : 1);
    }
  });
  it('success: browser URLs on the AWS hostnames with a sandbox-bound bootstrap token; no key in the body', async () => {
    const res = await handleAwsPreview(claims(), deps());
    const body = (await res.json()) as Record<string, string>;
    expect(body.provider).toBe('aws-ec2');
    expect(new URL(body.guacamoleUrl!).hostname).toBe(`aws-8181-${SID}-aws.${ROOT}`);
    expect(new URL(body.codePreviewUrl!).hostname).toBe(`aws-8443-${SID}-aws.${ROOT}`);
    expect(new URL(body.appPreviewUrl!).hostname).toBe(`aws-3002-${SID}-aws.${ROOT}`);
    expect(JSON.stringify(body)).not.toContain(vectors.controlKeyBase64);
  });
  it('no secret: 401', async () => {
    expect((await handleAwsPreview(claims(), deps({ secrets: [] }))).status).toBe(401);
  });

  // ── Per-tab folder continuity (./code-folder.ts): Code only, a code never a path ──
  const codeDeps = (over: Partial<Parameters<typeof handleAwsPreview>[1]> = {}) => deps({
    surface: 'code', ensureConfig: async () => ({ state: 'applied' }) as never, codeAnswers: async () => true, ...over,
  });
  const answer = async (res: Response) => (await res.json()) as Record<string, unknown> & { codePreviewUrl: string };
  const folderOf = (u: string) => new URL(u).searchParams.get('folder');

  // Code always names its folder, as on Cloudflare: without one, code-server reopens its own last-visited folder
  // (it runs without --ignore-last-opened), even /root or a repository opened by hand (user report 2026-11-05).
  it('no ask: Code opens the workspace root explicitly, and no codeFolder field', async () => {
    const body = await answer(await handleAwsPreview(claims(), codeDeps()));
    expect(body.codeFolder).toBeUndefined();
    expect(folderOf(body.codePreviewUrl)).toBe('/workspace');
    expect(folderOf(body.appPreviewUrl as string)).toBeNull();
    expect(folderOf(body.guacamoleUrl as string)).toBeNull();
    expect(new URL(body.codePreviewUrl).searchParams.get('path')).toBe('/');
  });

  it('an ask with no host walk wired (old host agent / before e1): `unverified`, and the workspace root opens', async () => {
    for (const path of ['/workspace/sports/sports-web', '/workspace']) {
      const body = await answer(await handleAwsPreview(claims(), codeDeps({ codeFolder: { v: 1, path } })));
      expect(body.codeFolder).toEqual({ v: 1, outcome: 'unverified' });
      expect(folderOf(body.codePreviewUrl)).toBe('/workspace');
    }
  });

  it('a walked folder becomes folder= on Code only; the walk gets the remainder below /workspace', async () => {
    const walked: string[] = [];
    const body = await answer(await handleAwsPreview(claims(), codeDeps({
      codeFolder: { v: 1, path: '/workspace/My Project/日本 ü' },
      resolveFolder: async (rec, rel) => { expect(rec.sandboxId).toBe(SID); walked.push(rel); return 'restored'; },
    })));
    expect(walked).toEqual(['My Project/日本 ü']);
    expect(body.codeFolder).toEqual({ v: 1, outcome: 'restored' });
    expect(folderOf(body.codePreviewUrl)).toBe('/workspace/My Project/日本 ü');
    expect(folderOf(body.appPreviewUrl as string)).toBeNull();
    expect(folderOf(body.guacamoleUrl as string)).toBeNull();
    expect(JSON.stringify(body.codeFolder)).not.toContain('Project');
  });

  it('refusals never reach the host: outside, not_allowed, invalid', async () => {
    let walks = 0;
    const resolveFolder = async () => { walks += 1; return 'restored' as const; };
    for (const [path, outcome] of [['/etc', 'outside'], ['/home/neko/project', 'outside'], ['/workspace/.ezil/x', 'not_allowed'],
      ['/workspace/projects/0b0e9b8e-6b1f-4c5e-9d3a-2f1e8c7d6a5b/repository', 'not_allowed'], ['/workspace/../etc', 'invalid']] as const) {
      const body = await answer(await handleAwsPreview(claims(), codeDeps({ codeFolder: { v: 1, path }, resolveFolder })));
      expect({ path, got: body.codeFolder }).toEqual({ path, got: { v: 1, outcome } });
      expect(folderOf(body.codePreviewUrl)).toBe('/workspace'); // never the refused path, never a folder-less URL
    }
    expect(walks).toBe(0);
  });

  it('a host answer other than restored opens the default with its code; a throw is `error`', async () => {
    for (const outcome of ['missing', 'not_directory', 'symlink', 'unverified'] as const) {
      const body = await answer(await handleAwsPreview(claims(), codeDeps({ codeFolder: { v: 1, path: '/workspace/a' }, resolveFolder: async () => outcome })));
      expect(body.codeFolder).toEqual({ v: 1, outcome });
      expect(folderOf(body.codePreviewUrl)).toBe('/workspace');
    }
    const thrown = await answer(await handleAwsPreview(claims(), codeDeps({
      codeFolder: { v: 1, path: '/workspace/a' }, resolveFolder: async () => { throw new Error('host down'); },
    })));
    expect(thrown.codeFolder).toEqual({ v: 1, outcome: 'error' });
    expect(folderOf(thrown.codePreviewUrl)).toBe('/workspace');
  });

  it('a host answer of `file` opens the file\'s own parent with the file beside it (file-url-open-regression)', async () => {
    const file = '/workspace/pages/index.js';
    const body = await answer(await handleAwsPreview(claims(), codeDeps({ codeFolder: { v: 1, path: file }, resolveFolder: async () => 'file' })));
    expect(body.codeFolder).toEqual({ v: 1, outcome: 'file' });
    expect(folderOf(body.codePreviewUrl)).toBe('/workspace/pages');
    expect(new URL(body.codePreviewUrl).searchParams.get('file')).toBe(file);
    expect(JSON.stringify(body)).not.toContain('"file":'); // the answer carries a code, never a path
    // the desktop and app URLs of the same mint never carry it
    for (const u of [body.guacamoleUrl, body.appPreviewUrl]) expect(new URL(u).searchParams.has('file')).toBe(false);
  });

  it('a restore whose bootstrap URL would pass 2000 characters is `too_long` and opens the default', async () => {
    const deep = `/workspace/${Array.from({ length: 12 }, () => '日本語のフォルダ名'.repeat(3)).join('/')}`;
    const body = await answer(await handleAwsPreview(claims(), codeDeps({ codeFolder: { v: 1, path: deep }, resolveFolder: async () => 'restored' })));
    expect(body.codeFolder).toEqual({ v: 1, outcome: 'too_long' });
    expect(folderOf(body.codePreviewUrl)).toBe('/workspace');
    expect(body.codePreviewUrl.length).toBeLessThanOrEqual(2000);
  });

  it('the desktop and app surfaces never ask, walk or answer a folder', async () => {
    let walks = 0;
    for (const surface of [undefined, 'app'] as const) {
      const body = await answer(await handleAwsPreview(claims(), deps({
        surface, ensureConfig: async () => ({ state: 'applied' }) as never,
        codeFolder: { v: 1, path: '/workspace/a' }, resolveFolder: async () => { walks += 1; return 'restored'; },
      })));
      expect(body.codeFolder).toBeUndefined();
      expect(folderOf(body.codePreviewUrl)).toBe('/workspace'); // its Code URL still names the workspace root
    }
    expect(walks).toBe(0);
  });
});

describe('AWS Code bootstrap: folder and ezil_mint (per-tab folder continuity)', () => {
  const at = (port: number) => `aws-${port}-${SID}-aws.${ROOT}`;
  const d = { routingEnabled: true, zone: ZONE, secrets: [SECRET], zoneRoot: ROOT, lookup: async () => record(), fetch: captureFetch().fetch, nowMs: Date.now };
  const boot = async (port: number, query: string) => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const u = `https://${at(port)}/preview-bootstrap?token=${encodeURIComponent(token)}${query}`;
    return (await handleAwsBrowserHost(new Request(u), new URL(u), d))!;
  };

  it('the minted URL round-trips: folder (spaces, Unicode) and ezil_mint reach code-server\'s first request', async () => {
    const minted = new URL(awsBrowserUrl(8443, SID, ROOT, 'TOKEN', '/', '/workspace/My Project/日本 ü'));
    expect(minted.searchParams.get('folder')).toBe('/workspace/My Project/日本 ü');
    const res = await boot(8443, `&path=%2F&folder=${encodeURIComponent('/workspace/My Project/日本 ü')}&ezil_mint=abcdefghijklmnopqrstu_`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'https://x');
    expect(loc.pathname).toBe('/');
    expect(loc.searchParams.get('folder')).toBe('/workspace/My Project/日本 ü');
    expect(loc.searchParams.get('ezil_mint')).toBe('abcdefghijklmnopqrstu_');
  });

  it('the default folder, the workspace root itself, reaches code-server as an explicit folder', async () => {
    const res = await boot(8443, `&path=%2F&folder=${encodeURIComponent('/workspace')}`);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!, 'https://x').searchParams.get('folder')).toBe('/workspace');
  });

  it('awsBrowserUrl sets folder on Code only', () => {
    expect(new URL(awsBrowserUrl(3002, SID, ROOT, 'T', '/', '/workspace/a')).searchParams.has('folder')).toBe(false);
    expect(new URL(awsBrowserUrl(8181, SID, ROOT, 'T', '/', '/workspace/a')).searchParams.has('folder')).toBe(false);
    expect(new URL(awsBrowserUrl(8443, SID, ROOT, 'T')).searchParams.has('folder')).toBe(false);
  });

  it('a walked file is forwarded beside its folder; one that is not a direct child of it, or without a folder, is 400 invalid_folder', async () => {
    const res = await boot(8443, `&path=%2F&folder=${encodeURIComponent('/workspace/My Project')}&file=${encodeURIComponent('/workspace/My Project/日本 ü.md')}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!, 'https://x');
    expect(loc.searchParams.get('folder')).toBe('/workspace/My Project');
    expect(loc.searchParams.get('file')).toBe('/workspace/My Project/日本 ü.md');
    for (const q of [`&file=${encodeURIComponent('/workspace/a/x.js')}`, `&folder=%2Fworkspace%2Fa&file=${encodeURIComponent('/workspace/b/x.js')}`,
      `&folder=%2Fworkspace%2Fa&file=${encodeURIComponent('/workspace/a/b/x.js')}`, '&folder=%2Fworkspace%2Fa&file=%2Fworkspace%2Fa',
      `&folder=%2Fworkspace%2Fa&file=${encodeURIComponent('/workspace/a/../a/x.js')}`, `&folder=%2Fworkspace&file=${encodeURIComponent('/etc/passwd')}`]) {
      const bad = await boot(8443, q);
      expect({ q, status: bad.status }).toEqual({ q, status: 400 });
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_folder' });
    }
    expect(new URL(awsBrowserUrl(8443, SID, ROOT, 'T', '/', '/workspace/a', '/workspace/a/x.js')).searchParams.get('file')).toBe('/workspace/a/x.js');
    expect(new URL(awsBrowserUrl(3002, SID, ROOT, 'T', '/', '/workspace/a', '/workspace/a/x.js')).searchParams.has('file')).toBe(false);
    expect(new URL(awsBrowserUrl(8443, SID, ROOT, 'T', '/', undefined, '/workspace/a/x.js')).searchParams.has('file')).toBe(false);
  });

  it('the critic\'s injection: an open key inside `path` is 400 invalid_folder on Code, with no cookie', async () => {
    for (const hidden of ['/?folder=/etc', '/?workspace=/etc/x.code-workspace', '/?ew=true', '/?payload=%5B%5D', '/?file=/etc/passwd', '/?ezil_mint=AAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await boot(8443, `&path=${encodeURIComponent(hidden)}`);
      expect({ hidden, status: res.status }).toEqual({ hidden, status: 400 });
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_folder' });
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('a folder that is not plain-absolute under /workspace is 400 invalid_folder', async () => {
    for (const bad of ['/etc', '/workspacefoo', '/workspace/../etc', 'workspace/a', '/workspace//a', '/home/neko/project']) {
      const res = await boot(8443, `&folder=${encodeURIComponent(bad)}`);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
    }
  });

  it('a malformed ezil_mint is dropped, never an error', async () => {
    const res = await boot(8443, '&ezil_mint=short');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('desktop and app ports are unchanged: their path query is theirs, folder and ezil_mint are ignored', async () => {
    const app = await boot(3002, `&path=${encodeURIComponent('/files?folder=a')}&folder=%2Fetc&ezil_mint=abcdefghijklmnopqrstu_`);
    expect(app.status).toBe(302);
    expect(app.headers.get('location')).toBe('/files?folder=a');
    const desk = await boot(8181, '&path=%2Fdesk%3Fx%3D1&folder=%2Fetc');
    expect(desk.headers.get('location')).toBe('/desk?x=1');
  });
});

describe('sendAwsControl (GW-5 proposal)', () => {
  it('signs a body-less POST whose path carries the whole command', async () => {
    const f = captureFetch();
    await sendAwsControl(record(), ZONE, 'stop', f.fetch, 1791964800, 60);
    const { url, init } = f.calls[0]!;
    expect(url).toBe(`https://c-${SID}-g1-e2.${ZONE}/__ezil/control/stop/60`);
    expect(init.body).toBeUndefined();
    const h = new Headers(init.headers);
    expect(await verifyGatewayHeader(h.get(AWS_GATEWAY_HEADER), KEY, record(), 'POST', '/__ezil/control/stop/60', 1791964800)).toEqual({ ok: true });
  });
  it('unknown ops and out-of-range warnings are refused', async () => {
    const f = captureFetch();
    await expect(sendAwsControl(record(), ZONE, 'presence' as never, f.fetch, 1)).rejects.toThrow();
    await expect(sendAwsControl(record(), ZONE, 'stop', f.fetch, 1, 901)).rejects.toThrow();
    await expect(sendAwsControl(record(), ZONE, 'fence', f.fetch, 1, 10)).rejects.toThrow();
    expect(f.calls.length).toBe(0);
  });
});
