/**
 * AWS tunnels (GATEWAY-CONTRACT-v1 GW-1): fence-first per-epoch tunnels created and deleted
 * only by the Worker, claims bound to the body, the connector-origin check, serialization,
 * and the Cloudflare REST client's request shapes (against a fake fetch; no real calls).
 */
import { describe, expect, it } from 'bun:test';
import vectors from './aws-gateway.vectors.json';
import type { AwsTunnelRecord, FetchLike } from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';
import {
  AwsTunnelRegistry,
  createAwsTunnelService,
  createCloudflareTunnelApi,
  isPublicIpv4,
  lookupAwsTunnel,
  routeAwsTunnels,
  type CloudflareTunnelApi,
  type TunnelStorage,
  TUNNEL_REPLAY_WINDOW_MS,
} from './aws-tunnels';

const ZONE = 'origin.example.net';
const CID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const SID = 'guac-0a0a0a0a0a0a0a0a-0b0b0b0b0b0b4b0b';

function memStorage(): TunnelStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(k: string) { return map.get(k) as T | undefined; },
    async put<T>(k: string, v: T) { map.set(k, structuredClone(v)); },
    async delete(k: string) { return map.delete(k); },
  };
}

/**
 * A stateful fake of the Cloudflare API: tunnels by name and CNAMEs by hostname exist until
 * deleted, so the by-name lookups (which recover an id whose create response was lost) see
 * exactly what earlier calls left. Mutations are logged in `calls`; lookups in `lookups`.
 */
function fakeApi(over: Partial<CloudflareTunnelApi> = {}) {
  const calls: string[] = [];
  const lookups: string[] = [];
  const tunnels = new Map<string, string>(); // name -> id
  const dns = new Map<string, { id: string; content: string }>(); // hostname -> record
  let n = 0;
  const api: CloudflareTunnelApi = {
    async createTunnel(name) { calls.push(`createTunnel ${name}`); const id = `tun-${++n}`; tunnels.set(name, id); return { id }; },
    async findTunnelByName(name) { lookups.push(`findTunnel ${name}`); const id = tunnels.get(name); return id ? { id } : null; },
    async getTunnelToken(id) { calls.push(`getTunnelToken ${id}`); return `token-for-${id}-0123456789`; },
    async putTunnelIngress(id, host, service) { calls.push(`ingress ${id} ${host} ${service}`); },
    async createDnsCname(host, target) { calls.push(`dns ${host} -> ${target}`); const r = { id: `dns-${n}`, content: target }; dns.set(host, r); return { id: r.id }; },
    async findDnsCname(host) { lookups.push(`findDns ${host}`); return dns.get(host) ?? null; },
    async deleteDnsRecord(id) { calls.push(`deleteDns ${id}`); for (const [h, r] of dns) if (r.id === id) dns.delete(h); },
    async deleteTunnel(id) { calls.push(`deleteTunnel ${id}`); for (const [k, v] of tunnels) if (v === id) tunnels.delete(k); },
    async listConnectorOrigins(id) { calls.push(`list ${id}`); return ['13.200.1.2']; },
    ...over,
  };
  return { api, calls, lookups, tunnels, dns };
}

const claims = (over: Partial<PreviewTokenV2Claims> = {}): PreviewTokenV2Claims => ({
  ts: Date.now(), sandboxId: SID, computerId: CID, userId: 'u1', provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2, ...over,
});
const body = (over: Record<string, unknown> = {}) => JSON.stringify({
  computerId: CID, sandboxId: SID, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0',
  region: 'ap-south-1', publicIp: '13.200.1.2', controlKey: vectors.controlKeyBase64, ...over,
});

describe('replay of a completed create (Codex PR #200: enrollment 200 lost)', () => {
  const OTHER_KEY = Buffer.alloc(32, 0x5a).toString('base64');
  const replay = (over: Record<string, unknown> = {}) => body({ replay: true, ...over });

  it('an exact replay gets the SAME tunnel token and creates nothing', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    let t = 1_000;
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => t });
    const first = await svc.create(claims(), body());
    calls.length = 0;
    t += TUNNEL_REPLAY_WINDOW_MS;
    expect(await svc.create(claims(), replay())).toEqual(first);
    expect(calls).toEqual(['getTunnelToken tun-1']);
    expect((s.map.get('tunnel') as AwsTunnelRecord).tunnelId).toBe('tun-1');
  });

  it.each([
    ['another control key (another nonce)', { controlKey: OTHER_KEY }],
    ['another instance', { instanceId: 'i-0123456789abcdef9' }],
    ['another address', { publicIp: '13.200.1.9' }],
  ])('%s is refused without any Cloudflare call', async (_name, over) => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    calls.length = 0;
    expect(await svc.create(claims(), replay(over))).toEqual({ status: 409, body: { ok: false, error: 'tunnel_replay_refused' } });
    expect(calls).toEqual([]);
  });

  it('past the window, with no record, or after the epoch was fenced: refused, and a replay never creates a tunnel', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    let t = 1_000;
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => t });
    // No record for this epoch: 404 tunnel_absent (the app may then create it), still no Cloudflare mutation.
    expect(await svc.create(claims(), replay())).toEqual({ status: 404, body: { ok: false, error: 'tunnel_absent' } });
    expect(calls).toEqual([]);
    await svc.create(claims(), body());
    t += TUNNEL_REPLAY_WINDOW_MS + 1;
    expect((await svc.create(claims(), replay())).body.error).toBe('tunnel_replay_refused');
    await svc.remove(claims(), JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 2 }));
    t = 1_000;
    expect((await svc.create(claims(), replay())).status).toBe(409);
  });

  it('a create without the replay flag stays refused for a live epoch', async () => {
    const s = memStorage(); const { api } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    expect((await svc.create(claims(), body())).body.error).toBe('tunnel_exists');
  });

  it('the replay flag must be exactly true', async () => {
    const svc = createAwsTunnelService({ api: fakeApi().api, storage: memStorage(), zone: ZONE });
    expect((await svc.create(claims(), body({ replay: false }))).body.error).toBe('tunnel_request_invalid');
    expect((await svc.create(claims(), body({ replay: 'yes' }))).body.error).toBe('tunnel_request_invalid');
  });
});

describe('create (fence-first, once per epoch)', () => {
  it('creates tunnel, ingress to the edge, proxied CNAME, stores an unverified record, returns only the token', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => 42 });
    const r = await svc.create(claims(), body());
    expect(r).toEqual({ status: 200, body: { tunnelToken: 'token-for-tun-1-0123456789' } });
    expect(calls).toEqual([
      `createTunnel ezil-c-${SID}-g1-e2`,
      `ingress tun-1 c-${SID}-g1-e2.${ZONE} http://127.0.0.1:18080`,
      `dns c-${SID}-g1-e2.${ZONE} -> tun-1.cfargotunnel.com`,
      'getTunnelToken tun-1',
    ]);
    const rec = s.map.get('tunnel') as AwsTunnelRecord;
    expect(rec).toMatchObject({ computerId: CID, sandboxId: SID, generation: 1, leaseEpoch: 2, tunnelId: 'tun-1', dnsRecordId: 'dns-1', originVerified: false, createdAt: 42 });
    expect(JSON.stringify(r.body)).not.toContain(vectors.controlKeyBase64);
  });
  it('a repeat for the same epoch is 409 tunnel_exists with no Cloudflare call', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    calls.length = 0;
    expect(await svc.create(claims(), body())).toEqual({ status: 409, body: { ok: false, error: 'tunnel_exists' } });
    expect(calls).toEqual([]);
  });
  it('an older epoch (or same epoch, other generation) is 409 stale_epoch', async () => {
    const s = memStorage(); const { api } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims({ leaseEpoch: 3 }), body({ leaseEpoch: 3 }));
    expect((await svc.create(claims(), body())).status).toBe(409);
    expect((await svc.create(claims({ leaseEpoch: 3, generation: 2 }), body({ leaseEpoch: 3, generation: 2 }))).body.error).toBe('stale_epoch');
  });
  it('a newer epoch deletes the old DNS record and tunnel BEFORE creating the next', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    calls.length = 0;
    expect((await svc.create(claims({ generation: 2, leaseEpoch: 3 }), body({ generation: 2, leaseEpoch: 3 }))).status).toBe(200);
    expect(calls.slice(0, 3)).toEqual(['deleteDns dns-1', 'deleteTunnel tun-1', `createTunnel ezil-c-${SID}-g2-e3`]);
    expect((s.map.get('tunnel') as AwsTunnelRecord).leaseEpoch).toBe(3);
  });
  it('if the old epoch cannot be fenced, nothing new is created and the old record stays', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    api.deleteTunnel = async () => { throw new Error('cf down'); };
    calls.length = 0;
    expect(await svc.create(claims({ leaseEpoch: 3 }), body({ leaseEpoch: 3 }))).toEqual({ status: 502, body: { ok: false, error: 'tunnel_fence_failed' } });
    expect(calls.some((c) => c.startsWith('createTunnel'))).toBe(false);
    expect((s.map.get('tunnel') as AwsTunnelRecord).leaseEpoch).toBe(2);
  });
  it('a partial create keeps a pending marker and no record; the retry ADOPTS the tunnel by name (one tunnel)', async () => {
    const s = memStorage();
    let failDns = true;
    const f = fakeApi();
    const realDns = f.api.createDnsCname;
    f.api.createDnsCname = async (h, t) => { if (failDns) throw new Error('dns'); return realDns(h, t); };
    const svc = createAwsTunnelService({ api: f.api, storage: s, zone: ZONE });
    expect((await svc.create(claims(), body())).body.error).toBe('tunnel_create_failed');
    expect(s.map.has('tunnel')).toBe(false);
    expect(s.map.get('pending_create')).toMatchObject({ computerId: CID, generation: 1, leaseEpoch: 2, tunnelName: `ezil-c-${SID}-g1-e2` });
    failDns = false;
    expect((await svc.create(claims(), body())).status).toBe(200);
    expect(f.calls.filter((c) => c.startsWith('createTunnel'))).toEqual([`createTunnel ezil-c-${SID}-g1-e2`]);
    expect((s.map.get('tunnel') as AwsTunnelRecord).tunnelId).toBe('tun-1');
    expect(s.map.has('pending_create')).toBe(false);
  });

  it('Codex PR #200: a LOST createTunnel response (committed, then threw) is adopted by name, never duplicated', async () => {
    const s = memStorage();
    const f = fakeApi();
    const real = f.api.createTunnel;
    f.api.createTunnel = async (name) => { await real(name); throw new Error('socket hang up'); };
    const svc = createAwsTunnelService({ api: f.api, storage: s, zone: ZONE });
    // The re-lookup after the ambiguous failure finds the committed tunnel inside the same call.
    expect((await svc.create(claims(), body())).status).toBe(200);
    expect(f.tunnels.size).toBe(1);
    expect((s.map.get('tunnel') as AwsTunnelRecord).tunnelId).toBe('tun-1');
  });

  it('Codex PR #200: a LOST CNAME response is adopted when it points at this tunnel; an orphan pointing elsewhere is replaced', async () => {
    const s = memStorage();
    const f = fakeApi();
    const real = f.api.createDnsCname;
    let lose = true;
    f.api.createDnsCname = async (h, t) => { const r = await real(h, t); if (lose) { lose = false; throw new Error('timeout'); } return r; };
    const svc = createAwsTunnelService({ api: f.api, storage: s, zone: ZONE });
    expect((await svc.create(claims(), body())).status).toBe(200);
    expect(f.dns.size).toBe(1);
    expect(f.calls.filter((c) => c.startsWith('dns '))).toHaveLength(1);

    // An orphan CNAME for this epoch's hostname, left pointing at a rolled-back tunnel id.
    const s2 = memStorage();
    const g = fakeApi();
    const host = `c-${SID}-g1-e2.${ZONE}`;
    g.dns.set(host, { id: 'dns-orphan', content: 'tun-old.cfargotunnel.com' });
    const svc2 = createAwsTunnelService({ api: g.api, storage: s2, zone: ZONE });
    expect((await svc2.create(claims(), body())).status).toBe(200);
    expect(g.calls).toContain('deleteDns dns-orphan');
    expect(g.dns.get(host)).toEqual({ id: expect.any(String), content: 'tun-1.cfargotunnel.com' });
  });

  it('never adopts another epoch: a tunnel named for epoch 1 is not this create for epoch 2', async () => {
    const s = memStorage();
    const f = fakeApi();
    f.tunnels.set(`ezil-c-${SID}-g1-e1`, 'tun-foreign');
    const svc = createAwsTunnelService({ api: f.api, storage: s, zone: ZONE });
    expect((await svc.create(claims(), body())).status).toBe(200);
    expect((s.map.get('tunnel') as AwsTunnelRecord).tunnelId).not.toBe('tun-foreign');
    expect(f.lookups).toContain(`findTunnel ezil-c-${SID}-g1-e2`);
  });

  it('remove and the next epoch delete, by name, what an unfinished create left behind', async () => {
    const s = memStorage();
    const f = fakeApi();
    const realToken = f.api.getTunnelToken;
    let failToken = true;
    f.api.getTunnelToken = async (id) => { if (failToken) throw new Error('token'); return realToken(id); };
    const svc = createAwsTunnelService({ api: f.api, storage: s, zone: ZONE });
    expect((await svc.create(claims(), body())).status).toBe(502);
    expect(f.tunnels.size).toBe(1);
    expect(f.dns.size).toBe(1);
    // The epoch is removed: its leftovers go too, and the marker is forgotten.
    expect((await svc.remove(claims(), JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 2 }))).body).toEqual({ deleted: true });
    expect(f.tunnels.size).toBe(0);
    expect(f.dns.size).toBe(0);
    expect(s.map.has('pending_create')).toBe(false);

    // A newer epoch cleans an older unfinished create before creating its own (fence-first).
    const s2 = memStorage();
    const g = fakeApi();
    const realToken2 = g.api.getTunnelToken;
    let fail2 = true;
    g.api.getTunnelToken = async (id) => { if (fail2) throw new Error('token'); return realToken2(id); };
    const svc2 = createAwsTunnelService({ api: g.api, storage: s2, zone: ZONE });
    expect((await svc2.create(claims(), body())).status).toBe(502);
    fail2 = false;
    expect((await svc2.create(claims({ leaseEpoch: 3 }), body({ leaseEpoch: 3 }))).status).toBe(200);
    expect([...g.tunnels.keys()]).toEqual([`ezil-c-${SID}-g1-e3`]);
    expect([...g.dns.keys()]).toEqual([`c-${SID}-g1-e3.${ZONE}`]);
  });
  it('claims that do not name exactly this AWS computer and epoch: 401; none: 401', async () => {
    const svc = createAwsTunnelService({ api: fakeApi().api, storage: memStorage(), zone: ZONE });
    for (const c of [claims({ leaseEpoch: 3 }), claims({ generation: 2 }), claims({ sandboxId: 'guac-a-b' }), claims({ computerId: '1b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b' }), claims({ provider: 'cloudflare' })]) {
      expect((await svc.create(c, body())).status).toBe(401);
    }
    expect((await svc.create(undefined, body())).status).toBe(401);
  });
  it('strict body: an extra key, a private IP, a short control key or a bad instance id is 400', async () => {
    const svc = createAwsTunnelService({ api: fakeApi().api, storage: memStorage(), zone: ZONE });
    for (const b of [body({ extra: 1 }), body({ publicIp: '10.0.0.5' }), body({ controlKey: btoa('short') }), body({ instanceId: 'i-xyz' }), 'not json']) {
      expect((await svc.create(claims(), b)).status).toBe(400);
    }
  });
  it('no API configuration or no zone: 503, nothing stored', async () => {
    const s = memStorage();
    expect((await createAwsTunnelService({ api: null, storage: s, zone: ZONE }).create(claims(), body())).status).toBe(503);
    expect((await createAwsTunnelService({ api: fakeApi().api, storage: s, zone: null }).create(claims(), body())).status).toBe(503);
    expect(s.map.size).toBe(0);
  });
  it('two concurrent creates for one epoch: exactly one tunnel', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    const [a, b] = await Promise.all([svc.create(claims(), body()), svc.create(claims(), body())]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(calls.filter((c) => c.startsWith('createTunnel')).length).toBe(1);
  });
});

describe('remove', () => {
  it('deletes when the stored epoch is at or below the request; otherwise reports deleted:false', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims({ leaseEpoch: 3 }), body({ leaseEpoch: 3 }));
    expect((await svc.remove(claims(), JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 2 }))).body).toEqual({ deleted: false });
    calls.length = 0;
    expect((await svc.remove(claims({ leaseEpoch: 4 }), JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 4 }))).body).toEqual({ deleted: true });
    expect(calls).toEqual(['deleteDns dns-1', 'deleteTunnel tun-1']);
    expect(s.map.has('tunnel')).toBe(false);
    expect(s.map.get('fenced_epoch')).toBe(4);
    expect((await svc.remove(claims({ leaseEpoch: 4 }), JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 4 }))).body).toEqual({ deleted: false });
  });
  it('retains fences across restart and delete-before-create', async () => {
    for (const created of [false, true]) {
      const s = memStorage(); const { api, calls } = fakeApi();
      let svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
      if (created) await svc.create(claims(), body());
      const deletion = JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 4 });
      expect((await svc.remove(claims({ leaseEpoch: 4 }), deletion)).body).toEqual({ deleted: created });
      svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
      calls.length = 0;
      for (const leaseEpoch of [2, 3, 4]) {
        const result = await svc.create(claims({ leaseEpoch }), body({ leaseEpoch }));
        expect(result).toEqual({ status: 409, body: { ok: false, error: 'stale_epoch' } });
      }
      expect(calls).toEqual([]);
      expect((await svc.create(claims({ leaseEpoch: 5 }), body({ leaseEpoch: 5 }))).status).toBe(200);
    }
  });
  it('mismatched claims are refused', async () => {
    const svc = createAwsTunnelService({ api: fakeApi().api, storage: memStorage(), zone: ZONE });
    expect((await svc.remove(claims({ leaseEpoch: 9 }), JSON.stringify({ computerId: CID, generation: 1, leaseEpoch: 2 }))).status).toBe(401);
  });
});

describe('verifyOrigin (C-6 step 5)', () => {
  it('no connection yet: not_connected; matching origin: verified and persisted', async () => {
    const s = memStorage(); const { api } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    api.listConnectorOrigins = async () => [];
    expect(await svc.verifyOrigin()).toBe('not_connected');
    api.listConnectorOrigins = async () => ['13.200.1.2', '13.200.1.2'];
    expect(await svc.verifyOrigin()).toBe('verified');
    expect((s.map.get('tunnel') as AwsTunnelRecord).originVerified).toBe(true);
  });
  it('any connector from another address: the tunnel and record are deleted (fenced)', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    const svc = createAwsTunnelService({ api, storage: s, zone: ZONE });
    await svc.create(claims(), body());
    api.listConnectorOrigins = async () => ['13.200.1.2', '203.0.113.9'];
    calls.length = 0;
    expect(await svc.verifyOrigin()).toBe('mismatch');
    expect(calls).toEqual(['deleteDns dns-1', 'deleteTunnel tun-1']);
    expect(s.map.has('tunnel')).toBe(false);
    expect(s.map.get('fenced_epoch')).toBe(2);
  });
  it('caches for 60 seconds across restart and serializes refreshes at the exact boundary', async () => {
    const s = memStorage(); const { api, calls } = fakeApi();
    let now = 0;
    let svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => now });
    await svc.create(claims(), body());
    expect(await svc.verifyOrigin()).toBe('verified');
    expect((s.map.get('tunnel') as AwsTunnelRecord).originVerifiedAt).toBe(0);
    svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => now });
    now = 59_999;
    expect((await svc.get())?.originVerifiedAt).toBe(0);
    expect(await svc.verifyOrigin()).toBe('verified');
    expect(calls.filter((c) => c === 'list tun-1').length).toBe(1);
    now = 60_000;
    const [first, verdict, last] = await Promise.all([svc.get(), svc.verifyOrigin(), svc.get()]);
    expect(first?.originVerifiedAt).toBe(60_000);
    expect(verdict).toBe('verified');
    expect(last?.originVerifiedAt).toBe(60_000);
    expect(calls.filter((c) => c === 'list tun-1').length).toBe(2);
    now = 120_000;
    api.listConnectorOrigins = async () => ['13.200.1.2', '203.0.113.9'];
    expect(await svc.verifyOrigin()).toBe('mismatch');
    expect(calls.slice(-2)).toEqual(['deleteDns dns-1', 'deleteTunnel tun-1']);
    expect(s.map.has('tunnel')).toBe(false);
    expect(s.map.get('fenced_epoch')).toBe(2);
  });
  it('rechecks legacy records and timestamps ahead of the clock', async () => {
    for (const originVerifiedAt of [undefined, 1001]) {
      const s = memStorage(); const { api } = fakeApi();
      const svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => 1000 });
      await svc.create(claims(), body());
      await s.put('tunnel', { ...(s.map.get('tunnel') as AwsTunnelRecord), originVerified: true, originVerifiedAt });
      api.listConnectorOrigins = async () => ['203.0.113.9'];
      expect(await svc.get()).toBeNull();
      expect(s.map.get('fenced_epoch')).toBe(2);
    }
  });
  it('expired checks with no connections or an API failure fail closed without renewing the cache', async () => {
    for (const failure of ['empty', 'error']) {
      const s = memStorage(); const { api } = fakeApi();
      let now = 0;
      const svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => now });
      await svc.create(claims(), body());
      expect(await svc.verifyOrigin()).toBe('verified');
      now = 60_000;
      api.listConnectorOrigins = async () => {
        if (failure === 'error') throw new Error('cf down');
        return [];
      };
      expect(await svc.verifyOrigin()).toBe('not_connected');
      expect(await svc.get()).toBeNull();
      expect((s.map.get('tunnel') as AwsTunnelRecord).originVerifiedAt).toBe(0);
      api.listConnectorOrigins = async () => ['13.200.1.2'];
      expect((await svc.get())?.originVerifiedAt).toBe(60_000);
    }
  });
  it('an expired mismatch fences before teardown even when DNS or tunnel deletion fails', async () => {
    for (const operation of ['deleteDnsRecord', 'deleteTunnel'] as const) {
      const s = memStorage(); const { api } = fakeApi();
      let now = 0;
      let svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => now });
      await svc.create(claims(), body());
      expect(await svc.verifyOrigin()).toBe('verified');
      now = 60_000;
      api.listConnectorOrigins = async () => ['13.200.1.2', '203.0.113.9'];
      const fences: unknown[] = [];
      api[operation] = async () => { fences.push(s.map.get('fenced_epoch')); throw new Error('cf down'); };
      expect(await svc.get()).toBeNull();
      expect(fences).toEqual([2]);
      svc = createAwsTunnelService({ api, storage: s, zone: ZONE, nowMs: () => now });
      expect(await svc.get()).toBeNull();
      expect(await svc.verifyOrigin()).toBe('not_connected');
      expect((await svc.create(claims(), body())).body.error).toBe('stale_epoch');
    }
  });
});

describe('Cloudflare REST client (fake fetch only)', () => {
  function capture(result: unknown = { id: 'x' }, status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const f: FetchLike = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ success: status < 400, result }), { status }); };
    return { calls, api: createCloudflareTunnelApi({ accountId: 'acct', zoneId: 'zone', apiToken: 'SECRET-TOKEN', fetch: f }) };
  }
  it('uses the documented endpoints with a bearer token', async () => {
    const { calls, api } = capture({ id: 'tid' });
    await api.createTunnel('ezil-c-x');
    await api.putTunnelIngress('tid', 'h.example', 'http://127.0.0.1:18080');
    await api.createDnsCname('h.example', 'tid.cfargotunnel.com');
    expect(calls.map((c) => `${c.init.method} ${c.url.replace('https://api.cloudflare.com/client/v4', '')}`)).toEqual([
      'POST /accounts/acct/cfd_tunnel', 'PUT /accounts/acct/cfd_tunnel/tid/configurations', 'POST /zones/zone/dns_records',
    ]);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer SECRET-TOKEN');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ name: 'ezil-c-x', config_src: 'cloudflare' });
    expect(JSON.parse(calls[1]!.init.body as string).config.ingress.at(-1)).toEqual({ service: 'http_status:404' });
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ type: 'CNAME', name: 'h.example', content: 'tid.cfargotunnel.com', proxied: true });
  });
  it('lookups by deterministic name: exact-name GETs; deleted or other names ignored; a duplicate refuses', async () => {
    const t = capture([{ id: 't-1', name: 'ezil-c-x' }, { id: 't-2', name: 'ezil-c-xy' }, { id: 't-3', name: 'ezil-c-x', deleted_at: '2026-10-14T00:00:00Z' }]);
    expect(await t.api.findTunnelByName('ezil-c-x')).toEqual({ id: 't-1' });
    expect(`${t.calls[0]!.init.method} ${t.calls[0]!.url.split('/v4')[1]}`).toBe('GET /accounts/acct/cfd_tunnel?name=ezil-c-x&is_deleted=false');
    expect(await capture([]).api.findTunnelByName('ezil-c-x')).toBeNull();
    expect(await capture([{ id: 'a', name: 'n' }, { id: 'b', name: 'n' }]).api.findTunnelByName('n').catch((e: Error) => e.message)).toBe('cf_api_duplicate_tunnel');
    const d = capture([{ id: 'd-1', name: 'h.example', content: 'tid.cfargotunnel.com' }, { id: 'd-2', name: 'other.example', content: 'x' }]);
    expect(await d.api.findDnsCname('h.example')).toEqual({ id: 'd-1', content: 'tid.cfargotunnel.com' });
    expect(`${d.calls[0]!.init.method} ${d.calls[0]!.url.split('/v4')[1]}`).toBe('GET /zones/zone/dns_records?type=CNAME&name=h.example');
    expect(await capture([]).api.findDnsCname('h.example')).toBeNull();
  });
  it('deleting removes connections first and tolerates 404; a refusal error never carries the token', async () => {
    const c404 = capture(null, 404);
    await c404.api.deleteTunnel('tid');
    expect(c404.calls.map((c) => `${c.init.method} ${c.url.split('/v4')[1]}`)).toEqual([
      'DELETE /accounts/acct/cfd_tunnel/tid/connections', 'DELETE /accounts/acct/cfd_tunnel/tid',
    ]);
    const c500 = capture(null, 500);
    const err = await c500.api.createTunnel('x').catch((e: Error) => e);
    expect(String(err)).toContain('cf_api_500');
    expect(String(err)).not.toContain('SECRET-TOKEN');
  });
  it('connector origins come from every connection of every connector', async () => {
    const { api } = capture([{ conns: [{ origin_ip: '1.2.3.4' }, { origin_ip: '5.6.7.8' }] }, { conns: [] }, {}]);
    expect(await api.listConnectorOrigins('tid')).toEqual(['1.2.3.4', '5.6.7.8']);
  });
});

describe('registry protocol and the internal route', () => {
  const env = { AWS_TUNNEL_CF_ACCOUNT_ID: 'acct', AWS_TUNNEL_CF_ZONE_ID: 'zone', AWS_TUNNEL_CF_API_TOKEN: 'tok', AWS_ORIGIN_ZONE: ZONE, AWS_ORIGIN_ZONE_ALLOWLIST: ZONE };
  it('routeAwsTunnels: no claims 401, cloudflare claims 401, wrong method 405 — none reach the registry', async () => {
    let reached = 0;
    const reg = () => ({ fetch: async () => { reached++; return new Response('{}'); } });
    expect((await routeAwsTunnels('POST', undefined, body(), reg)).status).toBe(401);
    expect((await routeAwsTunnels('POST', claims({ provider: 'cloudflare' }), body(), reg)).status).toBe(401);
    expect((await routeAwsTunnels('GET', claims(), body(), reg)).status).toBe(405);
    expect(reached).toBe(0);
  });
  it('a real registry with the default zone resolver: create via the route, then lookup returns the record', async () => {
    const f: FetchLike = async (url) => {
      const result = url.endsWith('/token') ? 'tunnel-token-0123456789' : { id: 'tid' };
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    };
    const reg = new AwsTunnelRegistry({ storage: memStorage() }, env, f);
    const res = await routeAwsTunnels('POST', claims(), body(), () => reg);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tunnelToken: 'tunnel-token-0123456789' });
    const rec = await lookupAwsTunnel(() => reg, SID);
    expect(rec?.hostname).toBe(`c-${SID}-g1-e2.${ZONE}`);
    expect(await lookupAwsTunnel(() => reg, 'guac-other-sandbox')).toBeNull();
  });
  it('public IPv4 check refuses private, loopback, link-local, CGNAT and multicast', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '0.1.2.3', '1.2.3', '01.2.3.4']) {
      expect(isPublicIpv4(ip)).toBe(false);
    }
    expect(isPublicIpv4('13.200.1.2')).toBe(true);
  });
});
