import { expect, it } from 'bun:test';
import { handleAwsRestart } from './aws-restart';
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
