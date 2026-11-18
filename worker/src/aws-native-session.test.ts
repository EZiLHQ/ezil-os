import { describe, expect, it } from 'bun:test';
import { deliverAwsNativeSession, readAwsNativeSessionStatus, NATIVE_BODY_MAX_BYTES, type AwsNativeSessionDeps } from './aws-native-session';
import { verifyGatewayHeader, decodeControlKey, type AwsTunnelRecord } from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';

const now = 1_794_405_600_000;
const uid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222';
const sid = 'guac-1111111111114111-2222222222224222', op = '33333333-3333-4333-8333-333333333333';
const claims: PreviewTokenV2Claims = { ts: now, userId: uid, computerId: cid, sandboxId: sid, provider: 'aws-ec2', store: '', generation: 2, leaseEpoch: 4 };
const record = { computerId: cid, sandboxId: sid, generation: 2, leaseEpoch: 4, originVerified: true,
  controlKey: btoa('k'.repeat(32)) } as AwsTunnelRecord;
const delivery = (over: Record<string, unknown> = {}) => ({
  v: 1, kind: 'create', profileId: 'ezil-native-claude-v1', operationId: op, sessionId: '44444444-4444-4444-8444-444444444444',
  computerId: cid, ownerUserId: uid,
  placement: { generation: '2', leaseEpoch: '4', instanceId: 'i-0123456789abcdef0', fenceToken: '55555555-5555-4555-8555-555555555555' },
  leaseUntil: '2026-11-17T00:00:00.000Z', sourceAuthorization: {}, task: {}, grant: {}, ...over });
const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

function setup(answers: Array<Response | Error>, deps: Partial<AwsNativeSessionDeps> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const d: AwsNativeSessionDeps = { enabled: true, zone: 'origin.example.net', now: () => now, lookup: async () => record,
    fetch: async (url, init) => { calls.push({ url, init: init! }); const a = answers.shift()!; if (a instanceof Error) throw a; return a; }, ...deps };
  return { calls, deliver: (b: Uint8Array, c = claims) => deliverAwsNativeSession(new Request('https://w.example/x'), c, sid, b, d),
    status: (id: string) => readAwsNativeSessionStatus(new Request('https://w.example/x'), claims, sid, id, d) };
}

describe('AWS native session delivery hop', () => {
  it('forwards the exact signed bytes under gw1 to the digest path and acknowledges only running', async () => {
    const body = bytes(delivery());
    const { calls, deliver } = setup([Response.json({ ok: true, state: 'running' })]);
    const res = await deliver(body);
    expect([res.status, await res.json()]).toEqual([200, { ok: true, outcome: 'acknowledged' }]);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', body)), b => b.toString(16).padStart(2, '0')).join('');
    const path = `/__ezil/control/native-session/${digest}`;
    expect(new URL(calls[0]!.url).pathname).toBe(path);
    expect(calls[0]!.init.body).toBe(body);
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(await verifyGatewayHeader(new Headers(calls[0]!.init.headers).get('x-ezil-gw'), decodeControlKey(record.controlKey)!,
      record, 'POST', path, now / 1000)).toEqual({ ok: true });
  });

  it('maps held, failed and closed answers without ever retrying', async () => {
    const cases: Array<[Response | Error, number, Record<string, unknown>]> = [
      [Response.json({ ok: true, state: 'starting' }, { status: 202 }), 502, { ok: false, outcome: 'unknown', reason: 'host_no_ack' }],
      [Response.json({ ok: false, error: 'renew_unsupported' }, { status: 409 }), 409, { ok: false, outcome: 'refused', reason: 'host_refused' }],
      [Response.json({ ok: false, error: 'placement_mismatch' }, { status: 409 }), 409, { ok: false, outcome: 'refused', reason: 'placement_mismatch' }],
      [Response.json({ ok: false, error: 'something_new' }, { status: 409 }), 502, { ok: false, outcome: 'unknown', reason: 'host_no_ack' }],
      [Response.json({ ok: false, error: 'agent_unavailable' }, { status: 503 }), 502, { ok: false, outcome: 'unknown', reason: 'host_no_ack' }],
      [Response.json({ ok: false, error: 'gw_bad_mac' }, { status: 401 }), 409, { ok: false, outcome: 'refused', reason: 'host_refused' }],
      [new Error('reset'), 502, { ok: false, outcome: 'unknown', reason: 'host_no_ack' }],
    ];
    for (const [a, status, want] of cases) {
      const { calls, deliver } = setup([a]);
      const res = await deliver(bytes(delivery()));
      expect([res.status, await res.json(), calls.length]).toEqual([status, want, 1]);
    }
  });

  it('refuses before any host call when claims, body binding, record or gate disagree', async () => {
    const bad: Array<[Uint8Array, PreviewTokenV2Claims, Partial<AwsNativeSessionDeps>, string]> = [
      [bytes(delivery({ ownerUserId: cid })), claims, {}, 'host_refused'],
      [bytes(delivery({ placement: { ...delivery().placement, generation: '02' } })), claims, {}, 'host_refused'],
      [bytes(delivery({ kind: 'renew' })), claims, {}, 'host_refused'],
      [bytes(delivery({ extra: 1 })), claims, {}, 'host_refused'],
      [bytes(delivery()), { ...claims, generation: 2_147_483_648, leaseEpoch: 4 }, {}, 'host_refused'],
      [bytes(delivery()), claims, { lookup: async () => ({ ...record, leaseEpoch: 5 }) }, 'placement_mismatch'],
      [bytes(delivery()), claims, { enabled: false }, 'host_unavailable'],
      [new Uint8Array(NATIVE_BODY_MAX_BYTES + 1), claims, {}, 'host_refused'],
    ];
    for (const [b, c, d, reason] of bad) {
      const { calls, deliver } = setup([], d);
      const res = await deliver(b, c);
      expect([res.status, (await res.json() as { reason: string }).reason, calls.length]).toEqual([409, reason, 0]);
    }
  });

  it('reads exact-operation status read-only and closed', async () => {
    const { calls, status } = setup([Response.json({ ok: true, state: 'quarantined', reason: 'agent_restart' }),
      Response.json({ ok: true, state: 'running', extra: 'x' })]);
    let res = await status(op);
    expect([res.status, await res.json()]).toEqual([200, { ok: true, state: 'quarantined', reason: 'agent_restart' }]);
    expect(calls[0]!.init.method).toBe('GET');
    expect(new URL(calls[0]!.url).pathname).toBe(`/__ezil/control/native-session-status/${op}`);
    res = await status(op);
    expect(res.status).toBe(502);
    expect((await status('not-a-uuid')).status).toBe(400);
  });
});
