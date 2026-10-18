/**
 * The index.ts hook for AWS computers (GATEWAY-CONTRACT-v1), through the REAL route table
 * (`default.fetch`), with a real AwsTunnelRegistry behind a fake namespace and fake
 * Cloudflare/origin fetches. Proves: everything AWS is 404/401 while AWS_ROUTING_ENABLED is
 * unset (today's behaviour, incl. `provider_not_routable`); when enabled, tunnel → preview →
 * bootstrap → gw1-signed origin forward; and Cloudflare bridge hosts still reach their own
 * dispatcher. Shipped with the hook in gw-index-hook.patch.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcTarget: class {},
  RpcStub: class {},
  env: {},
}));

import vectors from './aws-gateway.vectors.json';
import { decodeControlKey, verifyGatewayHeader, type FetchLike } from './aws-origin';
import { AwsTunnelRegistry, type TunnelStorage } from './aws-tunnels';
import { deriveNekoCredentials, mintPreviewTokenV2, type PreviewTokenV2Claims } from './hmac';
import { sha256Hex } from './aws-ice';

const worker = (await import('./index')).default;
const SECRET = 'aws-hook-test-secret';
const USER = 'u0a0a0a0a0a0a0a0a';
const CID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const SID = 'guac-u0a0a0a0a0a0a0a0-0b0b0b0b0b0b4b0b';
const ORIGIN_ZONE = 'origin.ezil.work';
const KEY = decodeControlKey(vectors.controlKeyBase64)!;

function memStorage(): TunnelStorage {
  const map = new Map<string, unknown>();
  return {
    async get<T>(k: string) { return map.get(k) as T | undefined; },
    async put<T>(k: string, v: T) { map.set(k, structuredClone(v)); },
    async delete(k: string) { return map.delete(k); },
  };
}

/** Cloudflare API fake: tunnel/dns ids, a token, and connections from the instance IP. */
const cfApiFetch = async (url: string): Promise<Response> => {
  const result = url.endsWith('/token') ? 'tunnel-token-0123456789'
    : url.endsWith('/connections') ? [{ conns: [{ origin_ip: '13.200.1.2' }] }]
    : { id: 'tid' };
  return new Response(JSON.stringify({ success: true, result }), { status: 200 });
};

function env(over: Record<string, unknown> = {}, tunnelFetch: FetchLike = cfApiFetch, nowMs: () => number = Date.now) {
  const registries = new Map<string, AwsTunnelRegistry>();
  const base = {
    SANDBOX_HMAC_SECRET: SECRET,
    SANDBOX_PREVIEW_ZONE_ROOT: 'ezil.work',
    AWS_ORIGIN_ZONE: ORIGIN_ZONE,
    AWS_ORIGIN_ZONE_ALLOWLIST: ORIGIN_ZONE,
    AWS_TUNNEL_CF_ACCOUNT_ID: 'acct', AWS_TUNNEL_CF_ZONE_ID: 'zone', AWS_TUNNEL_CF_API_TOKEN: 'tok',
  };
  const ns = {
    idFromName: (n: string) => n,
    get: (id: string) => {
      if (!registries.has(id)) registries.set(id, new AwsTunnelRegistry({ storage: memStorage() }, base, tunnelFetch, undefined, nowMs));
      return registries.get(id)!;
    },
  };
  return { ...base, AWS_TUNNELS: ns, Sandbox: {}, ...over } as never;
}

const claims = (over: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims => ({
  ts: Date.now(), sandboxId: SID, computerId: CID, userId: USER, provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2, ...over,
});

async function signed(method: string, path: string, body: string, c = claims()): Promise<Request> {
  const token = await mintPreviewTokenV2(SECRET, c, { method, path, body });
  return new Request(`https://api.ezil.work${path}`, { method, body, headers: { 'x-ezil-auth': token, 'content-type': 'application/json' } });
}

const tunnelBody = JSON.stringify({
  computerId: CID, sandboxId: SID, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0',
  region: 'ap-south-1', publicIp: '13.200.1.2', controlKey: vectors.controlKeyBase64,
});
const previewBody = JSON.stringify({ userId: USER, projectId: CID });

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/**
 * A fake AWS host behind the origin (gw1 verified on every call: status, ice push, neko admin
 * API) plus a fake Cloudflare Realtime TURN API. Records what the Worker sent.
 */
interface FakeHost {
  configured: boolean; desktop: string; ice: string; relayExpiresAt: number; screen: { width: number; height: number };
  pushed?: { neko: { user: string; admin: string }; backend: Array<{ urls: string[] }> };
  turnCalls: number; bad: string[]; paths: string[];
}
function installAwsHost(over: Partial<FakeHost> = {}): FakeHost {
  const h: FakeHost = { configured: false, desktop: 'absent', ice: 'none', relayExpiresAt: Date.now() + 1_200_000,
    screen: { width: 1280, height: 720 }, turnCalls: 0, bad: [], paths: [], ...over };
  const runtimeId = 'c'.repeat(32);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.hostname === 'rtc.live.cloudflare.com') {
      h.turnCalls++;
      if (headers.get('authorization') !== 'Bearer turn-api-token') h.bad.push('turn auth');
      return j({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'tu', credential: 'tp' }] }, 201);
    }
    h.paths.push(`${method} ${url.pathname}`);
    if (url.hostname !== `c-${SID}-g1-e2.${ORIGIN_ZONE}`) h.bad.push(`host ${url.hostname}`);
    const v = await verifyGatewayHeader(headers.get('x-ezil-gw'), KEY, { computerId: CID, generation: 1, leaseEpoch: 2 }, method, url.pathname, Math.floor(Date.now() / 1000));
    if (!v.ok) { h.bad.push(`gw ${url.pathname} ${v.error}`); return j({ ok: false }, 401); }
    if (url.pathname === '/__ezil/control/desktop') return j({ ok: true, configured: h.configured, expiresAt: null, desktop: h.desktop, ice: h.ice });
    if (url.pathname.startsWith('/__ezil/control/ice/')) {
      if (url.pathname.slice(20) !== (await sha256Hex(body))) h.bad.push('digest');
      h.pushed = JSON.parse(body);
      return j({ ok: true, state: 'accepted' });
    }
    const neko = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: SECRET }, SID);
    if (url.pathname === '/__p/8181/api/login') return (JSON.parse(body) as { password: string }).password === neko.admin ? j({ token: 't' }) : j({}, 401);
    if (url.pathname === '/__p/8181/api/relay' && method === 'GET') return j({ runtimeId, expiresAt: h.relayExpiresAt });
    if (url.pathname === '/__p/8181/api/relay' && method === 'POST') {
      h.relayExpiresAt = (JSON.parse(body) as { expiresAt: number }).expiresAt;
      return j({ runtimeId, expiresAt: h.relayExpiresAt });
    }
    if (url.pathname === '/__p/8181/api/room/screen') {
      if (headers.get('authorization') !== 'Bearer t') { h.bad.push('screen auth'); return j({}, 401); }
      if (method === 'POST') {
        const b = JSON.parse(body) as { width: number; height: number };
        h.screen = { width: b.width, height: b.height };
        return j({});
      }
      return j(h.screen);
    }
    if (url.pathname === '/__p/8181/api/logout') return j({});
    return j({ ok: false }, 404);
  }) as typeof fetch;
  return h;
}

describe('AWS routing disabled (the default): behaviour unchanged', () => {
  const e = () => env();
  it('the tunnel API answers 404', async () => {
    expect((await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), e())).status).toBe(404);
  });
  it('an AWS browser hostname answers 404 aws_routing_disabled', async () => {
    const res = await worker.fetch(new Request(`https://aws-8181-${SID}-aws.ezil.work/`), e());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'aws_routing_disabled' });
  });
  it('an aws-ec2 v2 preview is still refused provider_not_routable', async () => {
    const res = await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: 'provider_not_routable' });
  });
  it('enabled flag but no AWS_TUNNELS binding: still off', async () => {
    const res = await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), env({ AWS_ROUTING_ENABLED: '1', AWS_TUNNELS: undefined }));
    expect(res.status).toBe(404);
  });
});

describe('AWS routing enabled: tunnel → preview → bootstrap → signed origin forward', () => {
  it('runs the whole chain and forwards with a gw1 header bound to the epoch', async () => {
    const e = env({ AWS_ROUTING_ENABLED: '1' });
    // unsigned and mis-claimed tunnel calls are refused
    expect((await worker.fetch(new Request('https://api.ezil.work/internal/aws/tunnels', { method: 'POST', body: tunnelBody }), e)).status).toBe(401);
    expect((await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody, claims({ leaseEpoch: 3 })), e)).status).toBe(401);

    const t = await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), e);
    expect(t.status).toBe(200);
    expect(await t.json()).toEqual({ tunnelToken: 'tunnel-token-0123456789' });

    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    const p = await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e);
    expect(p.status).toBe(200);
    const pv = (await p.json()) as Record<string, string>;
    expect(pv.provider).toBe('aws-ec2');
    expect(pv.relay).toEqual({ runtimeId: 'c'.repeat(32), expiresAt: host.relayExpiresAt } as never);
    expect(host.bad).toEqual([]);
    globalThis.fetch = realFetch;
    const boot = new URL(pv.guacamoleUrl!);
    expect(boot.hostname).toBe(`aws-8181-${SID}-aws.ezil.work`);

    const b = await worker.fetch(new Request(boot.toString()), e);
    expect(b.status).toBe(302);
    const cookie = b.headers.get('set-cookie')!.split(';')[0]!;
    const codeBoot = await worker.fetch(new Request(pv.codePreviewUrl!), e);
    expect(codeBoot.status).toBe(302);
    const codeCookie = codeBoot.headers.get('set-cookie')!.split(';')[0]!;

    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response('desktop', { status: 200 });
    }) as typeof fetch;
    const now = Math.floor(Date.now() / 1000);
    // First visit: the auto-connect redirect adds neko's usr/embed and a non-secret pwd placeholder.
    const r = await worker.fetch(new Request(`https://aws-8181-${SID}-aws.ezil.work/index.html`, { headers: { cookie } }), e);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/index.html?usr=EZiL&pwd=ezil-preview&embed=1');
    expect(seen.length).toBe(0);
    const d = await worker.fetch(new Request(`https://aws-8181-${SID}-aws.ezil.work/index.html?usr=EZiL&pwd=ezil-preview&embed=1`, { headers: { cookie } }), e);
    expect(d.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://c-${SID}-g1-e2.${ORIGIN_ZONE}/__p/8181/index.html?usr=EZiL&pwd=ezil-preview&embed=1`);
    const v = await verifyGatewayHeader(seen[0]!.headers.get('x-ezil-gw'), KEY, { computerId: CID, generation: 1, leaseEpoch: 2 }, 'GET', '/__p/8181/index.html', now);
    expect(v).toEqual({ ok: true });
    expect(seen[0]!.headers.get('x-forwarded-host')).toBe(boot.hostname);
    const codeHost = `aws-8443-${SID}-aws.ezil.work`;
    for (const upgrade of [false, true]) {
      const headers = new Headers({
        cookie: codeCookie, origin: `https://${codeHost}`, host: 'evil.example',
        'x-forwarded-host': 'evil.example, other.example', 'x-forwarded-proto': 'http',
        forwarded: 'host=evil.example;proto=http',
      });
      if (upgrade) headers.set('upgrade', 'websocket');
      expect((await worker.fetch(new Request(`https://${codeHost}/vscode`, { headers }), e)).status).toBe(200);
      const forwarded = seen[seen.length - 1]!.headers;
      expect(forwarded.get('x-forwarded-host')).toBe(codeHost);
      expect(forwarded.get('x-forwarded-proto')).toBeNull();
      expect(forwarded.get('forwarded')).toBeNull();
      expect(forwarded.get('origin')).toBe(`https://${codeHost}`);
      expect(forwarded.get('upgrade')).toBe(upgrade ? 'websocket' : null);
    }
  });

  it('preview, HTTP and WebSocket requests recheck expired origins and fence mismatches', async () => {
    for (const target of ['preview', 'http', 'websocket']) {
      let now = Date.now();
      let origins = ['13.200.1.2'];
      let checks = 0;
      const deleted: string[] = [];
      const tunnelFetch: FetchLike = async (url, init) => {
        if (init.method === 'DELETE') {
          deleted.push(url.split('/client/v4')[1]!);
          return new Response(JSON.stringify({ success: true, result: null }));
        }
        if (url.endsWith('/connections')) {
          checks++;
          return new Response(JSON.stringify({ success: true, result: [{ conns: origins.map((origin_ip) => ({ origin_ip })) }] }));
        }
        return cfApiFetch(url);
      };
      const e = env({ AWS_ROUTING_ENABLED: '1' }, tunnelFetch, () => now);
      expect((await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), e)).status).toBe(200);
      const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
      const preview = await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e);
      expect(preview.status).toBe(200);
      const previewUrls = (await preview.json()) as { codePreviewUrl: string };
      const bootstrap = await worker.fetch(new Request(previewUrls.codePreviewUrl), e);
      expect(bootstrap.status).toBe(302);
      expect(host.bad).toEqual([]);
      expect(checks).toBe(1);
      const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
      let forwarded = 0;
      globalThis.fetch = (async () => { forwarded++; return new Response('origin'); }) as typeof fetch;
      origins = ['13.200.1.2', '203.0.113.9'];
      now += 60_000;
      const headers = new Headers({ cookie });
      if (target === 'websocket') headers.set('upgrade', 'websocket');
      const request = target === 'preview'
        ? await signed('POST', '/sandbox/preview', previewBody)
        : new Request(`https://aws-8443-${SID}-aws.ezil.work/vscode`, { headers });
      expect((await worker.fetch(request, e)).status).toBe(502);
      expect(checks).toBe(2);
      expect(forwarded).toBe(0);
      expect(deleted).toEqual([
        '/zones/zone/dns_records/tid',
        '/accounts/acct/cfd_tunnel/tid/connections',
        '/accounts/acct/cfd_tunnel/tid',
      ]);
      const retry = await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), e);
      expect(retry.status).toBe(409);
      expect(await retry.json()).toEqual({ ok: false, error: 'stale_epoch' });
    }
  });

  it('a Cloudflare bridge hostname still reaches its own dispatcher (not claimed by the AWS hook)', async () => {
    const e = env({ AWS_ROUTING_ENABLED: '1' });
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response('x'); }) as typeof fetch;
    const res = await worker.fetch(new Request(`https://3002-${SID}-app.ezil.work/preview-status`), e);
    // the bridge's own cookie/token gate answers, exactly as before the hook
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/^preview_bootstrap_token/);
    expect(called).toBe(0);
  });
});

describe('AWS desktop relay through the hook (aws-ice)', () => {
  const relayEnv = (over: Record<string, unknown> = {}) => env({
    AWS_ROUTING_ENABLED: '1', SANDBOX_NEKO_TURN_KEY_ID: 'turn-key-id', SANDBOX_NEKO_TURN_API_TOKEN: 'turn-api-token', ...over,
  });
  async function withTunnel(e: never) {
    expect((await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), e)).status).toBe(200);
  }

  it('a host without a config: TURN minted once, relay-only config with the DERIVED neko values pushed, 503 starting', async () => {
    const e = relayEnv();
    await withTunnel(e);
    const host = installAwsHost();
    const res = await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'aws_desktop_starting', reason: 'config_pushed' });
    expect(host.turnCalls).toBe(1);
    expect(host.pushed!.neko).toEqual(await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: SECRET }, SID));
    expect(host.pushed!.backend.flatMap((s) => s.urls).every((u) => /^turns?:/.test(u))).toBe(true);
    expect(host.bad).toEqual([]);
  });

  it('no TURN provider configured: fail closed (502 turn_unavailable), nothing pushed', async () => {
    const e = relayEnv({ SANDBOX_NEKO_TURN_KEY_ID: undefined, SANDBOX_NEKO_TURN_API_TOKEN: undefined });
    await withTunnel(e);
    const host = installAwsHost();
    const res = await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'turn_unavailable' });
    expect(host.pushed).toBeUndefined();
  });

  it('relay-refresh for an AWS computer: read, then renew in place through the gateway', async () => {
    const e = relayEnv();
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    // origin verification happens on the first preview
    expect((await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e)).status).toBe(200);
    const path = `/sandbox/${SID}/relay-refresh`;
    const got = await worker.fetch(await signed('GET', path, ''), e);
    expect(got.status).toBe(200);
    const state = (await got.json()) as { ok: boolean; runtimeId: string; expiresAt: number };
    expect(state.ok).toBe(true);
    const renewBody = JSON.stringify({ runtimeId: state.runtimeId });
    const renewed = await worker.fetch(await signed('POST', path, renewBody), e);
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { expiresAt: number }).expiresAt).toBe(host.relayExpiresAt);
    expect(host.paths).toContain('POST /__p/8181/api/relay');
    expect(host.bad).toEqual([]);
  });

  /** Records every touch of the Cloudflare Sandbox namespace; any use throws. */
  function sandboxRecorder() {
    const opened: string[] = [];
    const ns = new Proxy({}, { get: (_t, p) => {
      if (typeof p === 'string') opened.push(p);
      return () => { throw new Error('cloudflare sandbox opened'); };
    } });
    return { opened, ns };
  }

  it('focus for an AWS computer is refused as unsupported and never opens a Cloudflare sandbox', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    expect((await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e)).status).toBe(200);
    const res = await worker.fetch(await signed('POST', `/sandbox/${SID}/focus`, JSON.stringify({ app: 'code' })), e);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: 'focus_unsupported' });
    expect(rec.opened).toEqual([]);
    expect(host.bad).toEqual([]);
  });

  it('screen read and resize for an AWS computer go to its neko through the gateway, never a Cloudflare sandbox', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied', screen: { width: 1024, height: 768 } });
    expect((await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e)).status).toBe(200);
    const read = await worker.fetch(await signed('GET', `/sandbox/${SID}/screen`, ''), e);
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: true, sandboxId: SID, width: 1024, height: 768 });
    const set = await worker.fetch(await signed('POST', `/sandbox/${SID}/screen`, JSON.stringify({ width: 1920, height: 1080 })), e);
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ ok: true, width: 1920, height: 1080 });
    expect(host.screen).toEqual({ width: 1920, height: 1080 });
    expect(host.paths).toContain('POST /__p/8181/api/room/screen');
    expect(rec.opened).toEqual([]);
    expect(host.bad).toEqual([]);
  });

  it('screen for an AWS computer whose desktop is not running yet is screen_starting (no neko call)', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    expect((await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e)).status).toBe(200);
    host.desktop = 'starting';
    host.paths.length = 0;
    const res = await worker.fetch(await signed('GET', `/sandbox/${SID}/screen`, ''), e);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, sandboxId: SID, error: 'screen_starting' });
    expect(host.paths.some((p) => p.includes('/api/'))).toBe(false);
    expect(rec.opened).toEqual([]);
  });

  it('focus and screen with v2 claims for ANOTHER sandbox are refused before any host call', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    const other = claims({ sandboxId: 'guac-u0a0a0a0a0a0a0a0-1b0b0b0b0b0b4b0b' });
    expect((await worker.fetch(await signed('POST', `/sandbox/${SID}/focus`, JSON.stringify({ app: 'code' }), other), e)).status).toBe(401);
    expect((await worker.fetch(await signed('GET', `/sandbox/${SID}/screen`, '', other), e)).status).toBe(401);
    expect(host.paths).toEqual([]);
    expect(rec.opened).toEqual([]);
  });

  it('positive control: with AWS routing on, a computer WITHOUT a tunnel keeps the Cloudflare path', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    installAwsHost();
    const cf = 'guac-u0a0a0a0a0a0a0a0-2b0b0b0b0b0b4b0b';
    const c = claims({ sandboxId: cf, provider: 'cloudflare' });
    await worker.fetch(await signed('POST', `/sandbox/${cf}/focus`, JSON.stringify({ app: 'code' }), c), e);
    await worker.fetch(await signed('GET', `/sandbox/${cf}/screen`, '', c), e);
    expect(rec.opened.length).toBeGreaterThan(0);
  });

  /** Every AWS-claimed control route, signed for `c`. */
  async function awsControls(e: never, c = claims()) {
    return [
      await worker.fetch(await signed('POST', `/sandbox/${SID}/focus`, JSON.stringify({ app: 'code' }), c), e),
      await worker.fetch(await signed('GET', `/sandbox/${SID}/screen`, '', c), e),
      await worker.fetch(await signed('POST', `/sandbox/${SID}/screen`, JSON.stringify({ width: 1920, height: 1080 }), c), e),
      await worker.fetch(await signed('GET', `/sandbox/${SID}/relay-refresh`, '', c), e),
    ];
  }

  it('Codex PR #200: an AWS-claimed control with NO tunnel record is refused, never served by a Cloudflare sandbox', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    const host = installAwsHost();
    for (const res of await awsControls(e)) {
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'aws_origin_unavailable' });
    }
    expect(rec.opened).toEqual([]);
    expect(host.paths).toEqual([]);
  });

  it('an AWS-claimed control for a fenced or replaced epoch is refused, never Cloudflare', async () => {
    const rec = sandboxRecorder();
    const e = relayEnv({ Sandbox: rec.ns });
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    for (const res of await awsControls(e, claims({ leaseEpoch: 3 }))) {
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ ok: false, error: 'aws_origin_unavailable' });
    }
    expect(rec.opened).toEqual([]);
    expect(host.paths).toEqual([]);
  });

  it('with AWS routing OFF an AWS-claimed control is refused too (never falls back to Cloudflare)', async () => {
    const rec = sandboxRecorder();
    const e = env({ Sandbox: rec.ns });
    for (const res of await awsControls(e)) expect(res.status).toBe(502);
    expect(rec.opened).toEqual([]);
  });

  it('relay-refresh with v2 claims for ANOTHER sandbox is refused before any host call', async () => {
    const e = relayEnv();
    await withTunnel(e);
    const host = installAwsHost({ configured: true, desktop: 'running', ice: 'applied' });
    const other = 'guac-u0a0a0a0a0a0a0a0-1b0b0b0b0b0b4b0b';
    const res = await worker.fetch(await signed('GET', `/sandbox/${SID}/relay-refresh`, '', claims({ sandboxId: other })), e);
    expect(res.status).toBe(401);
    expect(host.paths).toEqual([]);
  });
});
