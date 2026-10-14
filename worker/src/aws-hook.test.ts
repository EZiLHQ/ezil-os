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
import { decodeControlKey, verifyGatewayHeader } from './aws-origin';
import { AwsTunnelRegistry, type TunnelStorage } from './aws-tunnels';
import { mintPreviewTokenV2, type PreviewTokenV2Claims } from './hmac';

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

function env(over: Record<string, unknown> = {}) {
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
      if (!registries.has(id)) registries.set(id, new AwsTunnelRegistry({ storage: memStorage() }, base, cfApiFetch));
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

describe('AWS routing disabled (the default): behaviour unchanged', () => {
  const e = () => env();
  it('the tunnel API answers 404', async () => {
    expect((await worker.fetch(await signed('POST', '/internal/aws/tunnels', tunnelBody), e())).status).toBe(404);
  });
  it('an AWS browser hostname answers 404 aws_routing_disabled', async () => {
    const res = await worker.fetch(new Request(`https://aws-8181-${SID}.ezil.work/`), e());
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

    const p = await worker.fetch(await signed('POST', '/sandbox/preview', previewBody), e);
    expect(p.status).toBe(200);
    const pv = (await p.json()) as Record<string, string>;
    expect(pv.provider).toBe('aws-ec2');
    const boot = new URL(pv.guacamoleUrl!);
    expect(boot.hostname).toBe(`aws-8181-${SID}.ezil.work`);

    const b = await worker.fetch(new Request(boot.toString()), e);
    expect(b.status).toBe(302);
    const cookie = b.headers.get('set-cookie')!.split(';')[0]!;

    const seen: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response('desktop', { status: 200 });
    }) as typeof fetch;
    const now = Math.floor(Date.now() / 1000);
    const d = await worker.fetch(new Request(`https://aws-8181-${SID}.ezil.work/index.html`, { headers: { cookie } }), e);
    expect(d.status).toBe(200);
    expect(seen[0]!.url).toBe(`https://c-${SID}-g1-e2.${ORIGIN_ZONE}/__p/8181/index.html`);
    const v = await verifyGatewayHeader(seen[0]!.headers.get('x-ezil-gw'), KEY, { computerId: CID, generation: 1, leaseEpoch: 2 }, 'GET', '/__p/8181/index.html', now);
    expect(v).toEqual({ ok: true });
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
