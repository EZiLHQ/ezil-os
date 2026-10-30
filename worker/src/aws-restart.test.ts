import { expect, it, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sha256Hex } from './aws-ice';
import { handleAwsRestart as restartHandler, type RestartBootstrap } from './aws-restart';
import { decodeControlKey, sendAwsControl, verifyGatewayHeader, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import { mintPreviewTokenV2 } from './hmac';
import vectors from './aws-gateway.vectors.json';

const now = Date.now(), secret = 'restart-test-secret';
const record: AwsTunnelRecord = {
  computerId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b', sandboxId: 'guac-test-0b0b0b0b0b0b4b0b', generation: 1, leaseEpoch: 2,
  instanceId: 'i-0123456789abcdef0', region: 'ap-south-1', publicIp: '13.200.1.2', tunnelId: 't', dnsRecordId: 'd', hostname: '',
  controlKey: vectors.controlKeyBase64, createdAt: now, originVerified: true,
};
const target = { record, zone: 'origin.example.net' };
const bootId = '11111111-1111-4111-8111-111111111111';
const neko = { user: 'c'.repeat(32), admin: 'd'.repeat(32) };
const ai = { baseUrl: `https://aws-8443-${record.sandboxId}-aws.preview.example/ai/v1`, proxyToken: 'e'.repeat(64) };
const bootstrap: RestartBootstrap = {
  mint: async () => ({ servers: [{ urls: ['turn:relay.example:3478'], username: 'test-user', credential: 'test-pass' }], expiresAt: Date.now() + 240_000 }),
  neko: async () => neko, aiConfig: async () => ai,
};
const hostStatus = (over = {}) => Response.json({ ok: true, desktop: 'running', ice: 'applied', configured: false, expiresAt: null, bootId, aiConfigured: true, ...over });
// Existing auth/dispatch cases keep their restart transport; bootstrap is real,
// with synthetic status/config endpoints. Nothing calls an external transport.
const handleAwsRestart = (req: Request, t: typeof target, secrets: string[], fetchFn: FetchLike, at: number) =>
  restartHandler(req, t, secrets, async (url, init) => {
    if (url.endsWith('/__ezil/control/desktop')) return hostStatus();
    if (url.includes('/__ezil/control/ice/')) return Response.json({ ok: true, state: 'already_running' });
    return fetchFn(url, init);
  }, bootstrap, at);
const path = `/sandbox/${record.sandboxId}/restart`;
const body = JSON.stringify({ requestId: 'a'.repeat(64) });
async function request(raw = body, claims = {}, pathname = path, method = 'POST') {
  const token = await mintPreviewTokenV2(secret, { ts: now, sandboxId: record.sandboxId, computerId: record.computerId,
    userId: 'test', provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2, ...claims }, { method, path: pathname, body: raw });
  return new Request(`https://worker.example${pathname}`, { method, headers: { 'x-ezil-auth': token }, ...(method === 'GET' ? {} : { body: raw }) });
}
const noFetch: FetchLike = async () => { throw new Error('unexpected dispatch'); };
it('signed restart binds the action and ID to gw1; duplicate requests have identical host paths', async () => {
  const paths: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    const u = new URL(url); paths.push(u.pathname);
    expect(u.hostname).toBe(`c-${record.sandboxId}-g1-e2.${target.zone}`);
    expect(await verifyGatewayHeader(new Headers(init.headers).get('x-ezil-gw'), decodeControlKey(record.controlKey)!,
      record, 'POST', u.pathname, Math.floor(now / 1000))).toEqual({ ok: true });
    expect(init.body).toBeUndefined(); expect(init.redirect).toBe('manual'); expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ ok: true, state: 'restart_requested' });
  };
  for (let i = 0; i < 2; i++) {
    const response = await handleAwsRestart(await request(), target, [secret], fetch, now);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, outcome: 'restart_requested' });
  }
  expect(paths).toEqual(Array(2).fill(`/__ezil/control/restart-desktop/${'a'.repeat(64)}`));
});
it('unsigned and tampered envelopes never dispatch', async () => {
  let calls = 0;
  const fetch: FetchLike = async () => { calls++; return Response.json({}); };
  expect((await handleAwsRestart(new Request(`https://worker.example${path}`, { method: 'POST', body }), target, [secret], fetch, now)).status).toBe(401);
  const req = await request(); req.headers.set('x-ezil-auth', 'bad');
  expect((await handleAwsRestart(req, target, [secret], fetch, now)).status).toBe(401);
  expect((await handleAwsRestart(await request(), target, [], fetch, now)).status).toBe(401);
  expect(calls).toBe(0);
});
it.each([{ provider: 'cloudflare' }, { generation: 9 }, { leaseEpoch: 9 }, { computerId: 'foreign' }, { sandboxId: 'foreign' }])(
  'foreign binding refuses: %j', async claims => {
    expect((await handleAwsRestart(await request(body, claims), target, [secret], noFetch, now)).status).toBe(409);
  });
it('unverified origin refuses', async () => {
  expect((await handleAwsRestart(await request(), { ...target, record: { ...record, originVerified: false } }, [secret], noFetch, now)).status).toBe(409);
});
it.each([JSON.stringify({ requestId: 'a'.repeat(64), action: 'exec' }), JSON.stringify({ requestId: '../stop' }), '{}', 'x'.repeat(257)])(
  'body allowlist and size refuse: %s', async raw => {
    expect((await handleAwsRestart(await request(raw), target, [secret], noFetch, now)).status).toBe(400);
  });
it('wrong method path or query refuses', async () => {
  for (const [p, m] of [[path, 'GET'], [path + '?action=exec', 'POST'], ['/sandbox/foreign/restart', 'POST']]) {
    expect((await handleAwsRestart(await request(body, {}, p, m), target, [secret], noFetch, now)).status).toBe(400);
  }
});
it('only an exact host acknowledgment is accepted; failures are redacted', async () => {
  for (const response of [Response.json({ ok: true, state: 'running' }), Response.json({ ok: false, error: 'LEAK' }),
    Response.json({ ok: true, state: 'restart_requested' }, { status: 503 }), new Response('LEAK'), Response.json(null)]) {
    const result = await handleAwsRestart(await request(), target, [secret], async () => response, now);
    expect(result.status).toBe(503); expect(await result.json()).toEqual({ ok: false, outcome: 'restart_unavailable' });
  }
  expect((await handleAwsRestart(await request(), target, [secret], async () => { throw Error('LEAK'); }, now)).status).toBe(503);
});
it('control allowlist rejects foreign actions, malformed IDs and extra parameters', async () => {
  for (const [op, warn, id] of [['exec', undefined, undefined], ['restart-desktop', undefined, undefined], ['restart-desktop', 1, 'a'.repeat(64)],
    ['restart-desktop', undefined, '../stop'], ['stop', undefined, 'a'.repeat(64)]] as const) {
    await expect(sendAwsControl(record, target.zone, op as never, noFetch, now / 1000, warn, id)).rejects.toThrow('gw_invalid_control_op');
  }
});

function bootstrapHost(status = () => hostStatus(), stored = () => Response.json({ ok: true, state: 'already_running' })) {
  const calls: { path: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init });
    if (path.endsWith('/desktop')) return status();
    if (path.includes('/ice/')) return stored();
    return Response.json({ ok: true, state: 'restart_requested' });
  };
  return { calls, fetch, dispatched: () => calls.some(c => c.path.includes('/restart-desktop/')) };
}

it('expired host boot config is replaced before restart with signed fresh TURN, derived login and the same boot-bound Chat identity', async () => {
  const h = bootstrapHost();
  const seen: string[] = [];
  const res = await restartHandler(await request(), target, [secret], h.fetch, {
    ...bootstrap, aiConfig: async boot => { seen.push(boot); return ai; },
    mint: async (signal, purpose) => { expect(signal).toBeInstanceOf(AbortSignal); expect(purpose).toBe('boot'); return bootstrap.mint(signal); },
  }, now);
  expect(res.status).toBe(202);
  expect(h.calls.map(c => c.path.split('/')[3])).toEqual(['desktop', 'ice', 'restart-desktop']);
  const push = h.calls[1]!;
  const config = JSON.parse(String(push.init.body));
  expect(config.neko).toEqual(neko);
  expect(config.ai).toEqual(ai);
  expect(config.expiresAt).toBeGreaterThan(Date.now() + 180_000);
  expect(config.backend.flatMap((s: { urls: string[] }) => s.urls).every((u: string) => u.startsWith('turn:'))).toBe(true);
  expect(push.path).toBe(`/__ezil/control/ice/${await sha256Hex(String(push.init.body))}`);
  expect(await verifyGatewayHeader(new Headers(push.init.headers).get('x-ezil-gw'), decodeControlKey(record.controlKey)!, record,
    'POST', push.path, Math.floor(Date.now() / 1000))).toEqual({ ok: true });
  expect(seen).toEqual([bootId]);
  expect(h.calls.every(c => c.init.signal === h.calls[0]!.init.signal)).toBe(true);
});

it('restart also replaces a currently valid boot config before it can expire during stop', async () => {
  const h = bootstrapHost(() => hostStatus({ configured: true, expiresAt: Date.now() + 70_000 }));
  expect((await restartHandler(await request(), target, [secret], h.fetch, bootstrap, now)).status).toBe(202);
  expect(h.calls[1]!.path).toContain('/ice/');
});

it.each([undefined, 'invalid'])('missing or invalid host boot identity refuses before config or restart: %s', async bootId => {
  const h = bootstrapHost(() => hostStatus({ bootId }));
  expect((await restartHandler(await request(), target, [secret], h.fetch, bootstrap, now)).status).toBe(503);
  expect(h.calls).toHaveLength(1);
});
it('mint failure leaves the old desktop running and pushes nothing', async () => {
  const h = bootstrapHost();
  expect((await restartHandler(await request(), target, [secret], h.fetch, { ...bootstrap, mint: async () => null }, now)).status).toBe(503);
  expect(h.calls).toHaveLength(1);
});
it.each([60_001, 180_000, 180_001])('requires enough relay lifetime for stop and startup: %d ms', async lifetime => {
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    const h = bootstrapHost();
    const mint: RestartBootstrap['mint'] = async signal => ({ ...(await bootstrap.mint(signal))!, expiresAt: now + lifetime });
    const res = await restartHandler(await request(), target, [secret], h.fetch, { ...bootstrap, mint }, now);
    expect(res.status).toBe(lifetime > 180_000 ? 202 : 503);
    expect(h.dispatched()).toBe(lifetime > 180_000);
    if (lifetime <= 180_000) expect(h.calls).toHaveLength(1);
  } finally { clock.mockRestore(); }
});
it.each([
  [503, { ok: true, state: 'already_running' }], [200, { ok: false, state: 'already_running' }],
  [200, { ok: true, state: 'LEAK' }], [200, null],
])('config push must acknowledge storage before stopping: %j', async (status, body) => {
  const h = bootstrapHost(undefined, () => Response.json(body, { status: status as number }));
  expect((await restartHandler(await request(), target, [secret], h.fetch, bootstrap, now)).status).toBe(503);
  expect(h.dispatched()).toBe(false);
});
it.each(['accepted', 'already_running', 'restart_scheduled'])('known config storage acknowledgment permits dispatch: %s', async state => {
  const h = bootstrapHost(undefined, () => Response.json({ ok: true, state }));
  expect((await restartHandler(await request(), target, [secret], h.fetch, bootstrap, now)).status).toBe(202);
});
it('Chat identity failure preserves the existing config and never stops the desktop', async () => {
  const h = bootstrapHost();
  const res = await restartHandler(await request(), target, [secret], h.fetch, { ...bootstrap, aiConfig: async () => { throw Error('LEAK'); } }, now);
  expect(res.status).toBe(503);
  expect(await res.text()).not.toContain('LEAK');
  expect(h.calls).toHaveLength(1);
});
it.each(['mint', 'push'])('a spent shared budget cannot dispatch after %s', async stage => {
  const controller = new AbortController();
  const timeout = spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  const h = bootstrapHost(undefined, () => { if (stage === 'push') controller.abort(); return Response.json({ ok: true, state: 'already_running' }); });
  try {
    const res = await restartHandler(await request(), target, [secret], h.fetch, {
      ...bootstrap, mint: async signal => { if (stage === 'mint') controller.abort(); return bootstrap.mint(signal); },
    }, now);
    expect(res.status).toBe(503);
    expect(h.dispatched()).toBe(false);
    expect(h.calls).toHaveLength(stage === 'mint' ? 1 : 2);
    expect(timeout.mock.calls[0]).toEqual([12_000]);
  } finally { timeout.mockRestore(); }
});

it('production AWS restart route wires relay mint, derived login and the shared Chat factory', async () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('if (aws) return (await import(\'./aws-restart\')).handleAwsRestart(');
  const route = source.slice(start, source.indexOf('      return handleRestart(', start));
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(route.replace("(await import('./aws-restart')).handleAwsRestart", 'handler'));
  let args: unknown[] = [];
  const fn = new Function('aws', 'request', 'env', 'resolvePreviewSecrets', 'fetch', 'awsRelayMint', 'deriveNekoCredentials', 'awsDesktopAiConfig', 'handler', js);
  fn(target, await request(), {}, () => [secret], hNeverFetch, () => bootstrap.mint, async () => neko, () => bootstrap.aiConfig,
    (...values: unknown[]) => { args = values; });
  const wired = args[4] as RestartBootstrap;
  expect(wired.mint).toBe(bootstrap.mint);
  expect(await wired.neko()).toEqual(neko);
  expect(wired.aiConfig).toBe(bootstrap.aiConfig);
});
const hNeverFetch = () => { throw Error('unexpected external fetch'); };
