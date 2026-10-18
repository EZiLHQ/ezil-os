/**
 * AWS computers: per-epoch Cloudflare tunnels, created and deleted ONLY by this Worker
 * (GATEWAY-CONTRACT-v1 GW-1; C-6 steps 5-6). The Worker alone holds the Cloudflare API
 * token; the app asks through `POST|DELETE /internal/aws/tunnels` with a v2 token whose
 * claims must name exactly the body's computer and epoch.
 *
 * State lives in one `AwsTunnelRegistry` Durable Object per sandbox (single writer). It
 * keeps only the newest epoch's record, and deletes an older epoch's tunnel, connections
 * and DNS record BEFORE creating the next one (fence-first). Operations inside one object
 * are serialized with an in-memory chain, because a Durable Object's input gate opens
 * during outbound fetches to the Cloudflare API.
 *
 * Nothing here logs or returns the control key or the API token; the tunnel token is
 * returned exactly once, to the create call.
 */
import {
  AWS_EDGE_PORT_DEFAULT,
  awsOriginHostname,
  decodeControlKey,
  isComputerId,
  isAwsOriginFresh,
  isRoutableSandboxId,
  resolveAwsOriginZone,
  type AwsTunnelRecord,
  type FetchLike,
} from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';

export class TunnelApiError extends Error {}

export interface CloudflareTunnelApi {
  createTunnel(name: string): Promise<{ id: string }>;
  /** The live (not deleted) tunnel with exactly this name, or null. Recovers an id whose create response was lost. */
  findTunnelByName(name: string): Promise<{ id: string } | null>;
  getTunnelToken(id: string): Promise<string>;
  putTunnelIngress(id: string, hostname: string, service: string): Promise<void>;
  createDnsCname(hostname: string, target: string): Promise<{ id: string }>;
  /** The CNAME with exactly this name, or null. Recovers an id whose create response was lost. */
  findDnsCname(hostname: string): Promise<{ id: string; content: string } | null>;
  deleteDnsRecord(id: string): Promise<void>;
  deleteTunnel(id: string): Promise<void>;
  /** Origin IPs of the tunnel's active connector connections. */
  listConnectorOrigins(id: string): Promise<string[]>;
}

/** The Cloudflare REST implementation. Errors carry only the HTTP status, never a body or token. */
export function createCloudflareTunnelApi(cfg: { accountId: string; zoneId: string; apiToken: string; fetch: FetchLike }): CloudflareTunnelApi {
  const base = 'https://api.cloudflare.com/client/v4';
  const call = async (method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<unknown> => {
    const res = await cfg.fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiToken}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (okStatuses.includes(res.status)) return null;
    let parsed: { success?: boolean; result?: unknown } | null = null;
    try {
      parsed = (await res.json()) as { success?: boolean; result?: unknown };
    } catch {
      parsed = null;
    }
    if (!res.ok || !parsed || parsed.success !== true) throw new TunnelApiError(`cf_api_${res.status}`);
    return parsed.result;
  };
  const acct = `/accounts/${encodeURIComponent(cfg.accountId)}/cfd_tunnel`;
  return {
    async createTunnel(name) {
      const r = (await call('POST', acct, { name, config_src: 'cloudflare' })) as { id?: unknown };
      if (typeof r?.id !== 'string' || !r.id) throw new TunnelApiError('cf_api_bad_result');
      return { id: r.id };
    },
    async findTunnelByName(name) {
      const r = await call('GET', `${acct}?name=${encodeURIComponent(name)}&is_deleted=false`);
      const hits = (Array.isArray(r) ? r : []).filter((t) => (t as { name?: unknown }).name === name
        && !(t as { deleted_at?: unknown }).deleted_at && typeof (t as { id?: unknown }).id === 'string');
      if (hits.length > 1) throw new TunnelApiError('cf_api_duplicate_tunnel');
      return hits.length === 1 ? { id: (hits[0] as { id: string }).id } : null;
    },
    async getTunnelToken(id) {
      const r = await call('GET', `${acct}/${encodeURIComponent(id)}/token`);
      if (typeof r !== 'string' || r.length < 16) throw new TunnelApiError('cf_api_bad_result');
      return r;
    },
    async putTunnelIngress(id, hostname, service) {
      await call('PUT', `${acct}/${encodeURIComponent(id)}/configurations`, {
        config: { ingress: [{ hostname, service }, { service: 'http_status:404' }] },
      });
    },
    async createDnsCname(hostname, target) {
      const r = (await call('POST', `/zones/${encodeURIComponent(cfg.zoneId)}/dns_records`, {
        type: 'CNAME', name: hostname, content: target, proxied: true,
      })) as { id?: unknown };
      if (typeof r?.id !== 'string' || !r.id) throw new TunnelApiError('cf_api_bad_result');
      return { id: r.id };
    },
    async findDnsCname(hostname) {
      const r = await call('GET', `/zones/${encodeURIComponent(cfg.zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`);
      const hits = (Array.isArray(r) ? r : []).filter((d) => (d as { name?: unknown }).name === hostname
        && typeof (d as { id?: unknown }).id === 'string' && typeof (d as { content?: unknown }).content === 'string');
      if (hits.length > 1) throw new TunnelApiError('cf_api_duplicate_dns');
      return hits.length === 1 ? { id: (hits[0] as { id: string }).id, content: (hits[0] as { content: string }).content } : null;
    },
    async deleteDnsRecord(id) {
      await call('DELETE', `/zones/${encodeURIComponent(cfg.zoneId)}/dns_records/${encodeURIComponent(id)}`, undefined, [404]);
    },
    async deleteTunnel(id) {
      // Connections first: a tunnel with live connectors cannot be deleted.
      await call('DELETE', `${acct}/${encodeURIComponent(id)}/connections`, undefined, [404]);
      await call('DELETE', `${acct}/${encodeURIComponent(id)}`, undefined, [404]);
    },
    async listConnectorOrigins(id) {
      const r = await call('GET', `${acct}/${encodeURIComponent(id)}/connections`);
      const origins: string[] = [];
      for (const connector of Array.isArray(r) ? r : []) {
        for (const conn of Array.isArray((connector as { conns?: unknown }).conns) ? (connector as { conns: unknown[] }).conns : []) {
          const ip = (conn as { origin_ip?: unknown }).origin_ip;
          if (typeof ip === 'string') origins.push(ip);
        }
      }
      return origins;
    },
  };
}

/** The subset of DurableObjectStorage the registry uses. */
export interface TunnelStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const RECORD_KEY = 'tunnel';
const FENCE_KEY = 'fenced_epoch';
/**
 * Written BEFORE a create's first Cloudflare call and deleted once the record is stored. The
 * tunnel name and hostname are deterministic for (sandbox, generation, epoch), so a retry, a
 * removal or the next epoch can find by NAME whatever a create left behind when its response
 * was lost, and adopt or delete it.
 */
const PENDING_KEY = 'pending_create';
interface PendingCreate { computerId: string; sandboxId: string; generation: number; leaseEpoch: number; tunnelName: string; hostname: string }
export const tunnelNameFor = (sandboxId: string, generation: number, leaseEpoch: number) => `ezil-c-${sandboxId}-g${generation}-e${leaseEpoch}`;
const INSTANCE_ID = /^i-[0-9a-f]{8,17}$/;
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
const CREATE_KEYS = 'computerId,controlKey,generation,instanceId,leaseEpoch,publicIp,region,sandboxId';
const CREATE_REPLAY_KEYS = 'computerId,controlKey,generation,instanceId,leaseEpoch,publicIp,region,replay,sandboxId';
const DELETE_KEYS = 'computerId,generation,leaseEpoch';

export interface TunnelCreateBody {
  computerId: string;
  sandboxId: string;
  generation: number;
  leaseEpoch: number;
  instanceId: string;
  region: string;
  publicIp: string;
  controlKey: string;
  /** Read-only replay of this epoch's completed create (see `create`). */
  replay?: true;
}

export interface TunnelDeleteBody {
  computerId: string;
  generation: number;
  leaseEpoch: number;
}

export type TunnelResult = { status: number; body: Record<string, unknown> };

const fail = (status: number, error: string): TunnelResult => ({ status, body: { ok: false, error } });

function isEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

/** A public, unicast IPv4 address (the instance's public IP in a public subnet). */
export function isPublicIpv4(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x, i) => x > 255 || String(x) !== m[i + 1])) return false;
  const [a, b] = o as [number, number, number, number];
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

function parseStrict(text: string, keys: string): Record<string, unknown> | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return Object.keys(v).sort().join(',') === keys ? (v as Record<string, unknown>) : null;
}

export function parseCreateBody(text: string): TunnelCreateBody | null {
  const b = parseStrict(text, CREATE_KEYS) ?? parseStrict(text, CREATE_REPLAY_KEYS);
  if (!b || ('replay' in b && b.replay !== true)) return null;
  const ok = isComputerId(b.computerId) && isRoutableSandboxId(b.sandboxId) && isEpoch(b.generation) && isEpoch(b.leaseEpoch)
    && typeof b.instanceId === 'string' && INSTANCE_ID.test(b.instanceId) && typeof b.region === 'string' && REGION.test(b.region)
    && isPublicIpv4(b.publicIp) && decodeControlKey(b.controlKey) !== null;
  return ok ? (b as unknown as TunnelCreateBody) : null;
}

export function parseDeleteBody(text: string): TunnelDeleteBody | null {
  const b = parseStrict(text, DELETE_KEYS);
  if (!b) return null;
  return isComputerId(b.computerId) && isEpoch(b.generation) && isEpoch(b.leaseEpoch) ? (b as unknown as TunnelDeleteBody) : null;
}

/** The v2 claims must name exactly this computer and epoch, for an AWS computer. */
function claimsMatch(c: PreviewTokenV2Claims, b: { computerId: string; generation: number; leaseEpoch: number; sandboxId?: string }): boolean {
  return c.provider === 'aws-ec2' && c.computerId === b.computerId && c.generation === b.generation && c.leaseEpoch === b.leaseEpoch
    && (b.sandboxId === undefined || c.sandboxId === b.sandboxId);
}

/** How long after a tunnel's create an exact replay may still read its token: the enrollment nonce's lifetime. */
export const TUNNEL_REPLAY_WINDOW_MS = 10 * 60_000;

/** Same computer, sandbox, epoch, instance and address, and the same control key (constant time). */
function isExactReplay(existing: AwsTunnelRecord, body: TunnelCreateBody): boolean {
  if (existing.computerId !== body.computerId || existing.sandboxId !== body.sandboxId || existing.generation !== body.generation
    || existing.leaseEpoch !== body.leaseEpoch || existing.instanceId !== body.instanceId || existing.region !== body.region
    || existing.publicIp !== body.publicIp) return false;
  const a = new TextEncoder().encode(existing.controlKey);
  const b = new TextEncoder().encode(body.controlKey);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export interface AwsTunnelServiceDeps {
  api: CloudflareTunnelApi | null;
  storage: TunnelStorage;
  zone: string | null;
  edgePort?: number;
  nowMs?: () => number;
}

export function createAwsTunnelService(deps: AwsTunnelServiceDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const edgePort = deps.edgePort ?? AWS_EDGE_PORT_DEFAULT;
  const now = deps.nowMs ?? Date.now;

  async function fencedEpoch(): Promise<number> {
    return (await deps.storage.get<number>(FENCE_KEY)) ?? 0;
  }

  async function fenceThrough(epoch: number): Promise<void> {
    const previous = await fencedEpoch();
    if (epoch > previous) await deps.storage.put(FENCE_KEY, epoch);
  }

  async function liveRecord(): Promise<AwsTunnelRecord | null> {
    const rec = (await deps.storage.get<AwsTunnelRecord>(RECORD_KEY)) ?? null;
    return rec && rec.leaseEpoch > await fencedEpoch() ? rec : null;
  }

  /** Persist the fence before teardown; retain it after removing the tunnel record. */
  async function destroy(api: CloudflareTunnelApi, rec: AwsTunnelRecord): Promise<void> {
    await fenceThrough(rec.leaseEpoch);
    await api.deleteDnsRecord(rec.dnsRecordId);
    await api.deleteTunnel(rec.tunnelId);
    await deps.storage.delete(RECORD_KEY);
  }

  /** Delete, by name, whatever an unfinished create left behind; then forget it. */
  async function cleanupPending(api: CloudflareTunnelApi, pending: PendingCreate): Promise<void> {
    const dns = await api.findDnsCname(pending.hostname);
    if (dns) await api.deleteDnsRecord(dns.id);
    const tunnel = await api.findTunnelByName(pending.tunnelName);
    if (tunnel) await api.deleteTunnel(tunnel.id);
    await deps.storage.delete(PENDING_KEY);
  }

  /** This epoch's tunnel: adopt the one a lost create response left (same deterministic name), else create. */
  async function ensureTunnel(api: CloudflareTunnelApi, name: string): Promise<string> {
    const found = await api.findTunnelByName(name);
    if (found) return found.id;
    try {
      return (await api.createTunnel(name)).id;
    } catch (err) {
      // Ambiguous: Cloudflare may have committed the create before the response was lost.
      const after = await api.findTunnelByName(name).catch(() => null);
      if (after) return after.id;
      throw err;
    }
  }

  /** This epoch's CNAME: adopt one already pointing at the tunnel; replace one pointing elsewhere. */
  async function ensureDns(api: CloudflareTunnelApi, hostname: string, target: string): Promise<string> {
    const found = await api.findDnsCname(hostname);
    if (found && found.content === target) return found.id;
    // The hostname is this sandbox+generation+epoch's own name: a record pointing elsewhere is an
    // orphan of a rolled-back attempt for this same epoch, never another computer's.
    if (found) await api.deleteDnsRecord(found.id);
    try {
      return (await api.createDnsCname(hostname, target)).id;
    } catch (err) {
      const after = await api.findDnsCname(hostname).catch(() => null);
      if (after && after.content === target) return after.id;
      throw err;
    }
  }

  async function verifyOrigin(rec: AwsTunnelRecord): Promise<'verified' | 'mismatch' | 'not_connected'> {
    if (!deps.api) return 'not_connected';
    const checkedAt = now();
    if (isAwsOriginFresh(rec, checkedAt)) return 'verified';
    const origins = await deps.api.listConnectorOrigins(rec.tunnelId).catch(() => null);
    if (!origins || origins.length === 0) return 'not_connected';
    if (origins.every((ip) => ip === rec.publicIp)) {
      await deps.storage.put(RECORD_KEY, { ...rec, originVerified: true, originVerifiedAt: checkedAt });
      return 'verified';
    }
    await destroy(deps.api, rec).catch(() => undefined);
    return 'mismatch';
  }

  return {
    // Browser forwarding uses this lookup, so it must never return a stale verified record.
    get: (): Promise<AwsTunnelRecord | null> => serial(async () => {
      const rec = await liveRecord();
      if (!rec || !rec.originVerified) return rec;
      return await verifyOrigin(rec) === 'verified' ? liveRecord() : null;
    }),

    create: (claims: PreviewTokenV2Claims | undefined, text: string): Promise<TunnelResult> => serial(async () => {
      const body = parseCreateBody(text);
      if (!body) return fail(400, 'tunnel_request_invalid');
      if (!claims || !claimsMatch(claims, body)) return fail(401, 'tunnel_claims_mismatch');
      if (body.leaseEpoch <= await fencedEpoch()) return fail(409, 'stale_epoch');
      if (!deps.api || !deps.zone) return fail(503, 'tunnel_api_not_configured');
      const api = deps.api;
      const existing = (await deps.storage.get<AwsTunnelRecord>(RECORD_KEY)) ?? null;
      if (body.replay) {
        // Read-only replay of THIS epoch's completed create: the app re-derives the same control key
        // when a host retries an enrollment whose 200 was lost. Only the exact record, key included,
        // inside the window, gets the SAME tunnel's token; a replay never creates or replaces anything.
        // No record for THIS epoch at all (its create never completed): 404, so the app may create it.
        // A record that is not this exact key/instance/address, or is past the window: 409, final.
        if (!existing || existing.leaseEpoch !== body.leaseEpoch || existing.generation !== body.generation) {
          return fail(404, 'tunnel_absent');
        }
        if (!isExactReplay(existing, body) || now() - existing.createdAt > TUNNEL_REPLAY_WINDOW_MS) {
          return fail(409, 'tunnel_replay_refused');
        }
        try {
          return { status: 200, body: { tunnelToken: await api.getTunnelToken(existing.tunnelId) } };
        } catch {
          return fail(502, 'tunnel_create_failed');
        }
      }
      if (existing) {
        if (existing.leaseEpoch > body.leaseEpoch || (existing.leaseEpoch === body.leaseEpoch && existing.generation !== body.generation)) {
          return fail(409, 'stale_epoch');
        }
        if (existing.leaseEpoch === body.leaseEpoch) return fail(409, 'tunnel_exists');
        try {
          await destroy(api, existing); // fence-first: the older epoch is gone before the next exists
        } catch {
          return fail(502, 'tunnel_fence_failed');
        }
      }
      const hostname = awsOriginHostname(body.sandboxId, body.generation, body.leaseEpoch, deps.zone);
      const pending: PendingCreate = {
        computerId: body.computerId, sandboxId: body.sandboxId, generation: body.generation, leaseEpoch: body.leaseEpoch,
        tunnelName: tunnelNameFor(body.sandboxId, body.generation, body.leaseEpoch), hostname,
      };
      try {
        // An older epoch's unfinished create: fence-first, delete its leftovers before this one exists.
        const prior = (await deps.storage.get<PendingCreate>(PENDING_KEY)) ?? null;
        if (prior && (prior.leaseEpoch !== pending.leaseEpoch || prior.generation !== pending.generation || prior.computerId !== pending.computerId)) {
          if (prior.leaseEpoch > pending.leaseEpoch) return fail(409, 'stale_epoch');
          await cleanupPending(api, prior);
        }
        // Before the first Cloudflare call, so a lost response is always recoverable by name.
        await deps.storage.put(PENDING_KEY, pending);
        const tunnelId = await ensureTunnel(api, pending.tunnelName);
        await api.putTunnelIngress(tunnelId, hostname, `http://127.0.0.1:${edgePort}`);
        const dnsRecordId = await ensureDns(api, hostname, `${tunnelId}.cfargotunnel.com`);
        const tunnelToken = await api.getTunnelToken(tunnelId);
        const record: AwsTunnelRecord = {
          computerId: body.computerId, sandboxId: body.sandboxId, generation: body.generation, leaseEpoch: body.leaseEpoch,
          instanceId: body.instanceId, region: body.region, publicIp: body.publicIp, tunnelId, dnsRecordId, hostname,
          controlKey: body.controlKey, createdAt: now(), originVerified: false,
        };
        await deps.storage.put(RECORD_KEY, record);
        await deps.storage.delete(PENDING_KEY);
        return { status: 200, body: { tunnelToken } };
      } catch {
        // No blind rollback: an id whose response was lost cannot be deleted by id anyway. The pending
        // marker stays, so a retry ADOPTS by name, and a removal or the next epoch deletes by name.
        return fail(502, 'tunnel_create_failed');
      }
    }),

    remove: (claims: PreviewTokenV2Claims | undefined, text: string): Promise<TunnelResult> => serial(async () => {
      const body = parseDeleteBody(text);
      if (!body) return fail(400, 'tunnel_request_invalid');
      if (!claims || !claimsMatch(claims, body)) return fail(401, 'tunnel_claims_mismatch');
      const existing = (await deps.storage.get<AwsTunnelRecord>(RECORD_KEY)) ?? null;
      if (existing && (existing.computerId !== body.computerId || existing.leaseEpoch > body.leaseEpoch)) {
        return { status: 200, body: { deleted: false } };
      }
      try {
        await fenceThrough(body.leaseEpoch);
        const pending = (await deps.storage.get<PendingCreate>(PENDING_KEY)) ?? null;
        const cleanable = pending && pending.computerId === body.computerId && pending.leaseEpoch <= body.leaseEpoch;
        if (!existing && !cleanable) return { status: 200, body: { deleted: false } };
        if (!deps.api) return fail(503, 'tunnel_api_not_configured');
        if (existing) await destroy(deps.api, existing);
        if (cleanable) await cleanupPending(deps.api, pending);
      } catch {
        return fail(502, 'tunnel_fence_failed');
      }
      return { status: 200, body: { deleted: true } };
    }),

    /** C-6 step 5: the connector must come from the instance's public address. */
    verifyOrigin: (): Promise<'verified' | 'mismatch' | 'not_connected'> => serial(async () => {
      const rec = await liveRecord();
      return rec ? verifyOrigin(rec) : 'not_connected';
    }),
  };
}

export interface AwsTunnelEnv {
  AWS_ORIGIN_ZONE?: string;
  AWS_ORIGIN_ZONE_ALLOWLIST?: string;
  AWS_EDGE_PORT?: string;
  AWS_TUNNEL_CF_ACCOUNT_ID?: string;
  AWS_TUNNEL_CF_ZONE_ID?: string;
  AWS_TUNNEL_CF_API_TOKEN?: string;
}

/** Internal protocol between the Worker and its registry object (never exposed to clients). */
export const REGISTRY_PATHS = { create: '/create', remove: '/remove', get: '/get', verifyOrigin: '/verify-origin' } as const;

/**
 * One per sandbox (`idFromName(sandboxId)`). Classic Durable Object `fetch` interface, so
 * it needs no `cloudflare:workers` import; bound as `AWS_TUNNELS` (see the index hook).
 */
export class AwsTunnelRegistry {
  private readonly service: ReturnType<typeof createAwsTunnelService>;

  constructor(
    state: { storage: TunnelStorage },
    env: AwsTunnelEnv,
    fetchFn: FetchLike = (u, i) => fetch(u, i),
    resolveZone: (env: AwsTunnelEnv) => string | null = resolveAwsOriginZone,
    nowMs: () => number = Date.now,
  ) {
    const configured = env.AWS_TUNNEL_CF_ACCOUNT_ID && env.AWS_TUNNEL_CF_ZONE_ID && env.AWS_TUNNEL_CF_API_TOKEN;
    const port = Number(env.AWS_EDGE_PORT ?? AWS_EDGE_PORT_DEFAULT);
    this.service = createAwsTunnelService({
      api: configured
        ? createCloudflareTunnelApi({ accountId: env.AWS_TUNNEL_CF_ACCOUNT_ID!, zoneId: env.AWS_TUNNEL_CF_ZONE_ID!, apiToken: env.AWS_TUNNEL_CF_API_TOKEN!, fetch: fetchFn })
        : null,
      storage: state.storage,
      zone: resolveZone(env),
      nowMs,
      edgePort: Number.isSafeInteger(port) && port > 1024 && port < 65536 ? port : AWS_EDGE_PORT_DEFAULT,
    });
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const reply = (r: TunnelResult) => new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    if (request.method === 'GET' && path === REGISTRY_PATHS.get) {
      return new Response(JSON.stringify({ record: await this.service.get() }), { headers: { 'content-type': 'application/json' } });
    }
    if (request.method === 'POST' && path === REGISTRY_PATHS.verifyOrigin) {
      return new Response(JSON.stringify({ verdict: await this.service.verifyOrigin() }), { headers: { 'content-type': 'application/json' } });
    }
    if (request.method === 'POST' && (path === REGISTRY_PATHS.create || path === REGISTRY_PATHS.remove)) {
      let envelope: { claims?: PreviewTokenV2Claims; body?: string };
      try {
        envelope = (await request.json()) as { claims?: PreviewTokenV2Claims; body?: string };
      } catch {
        return reply(fail(400, 'tunnel_request_invalid'));
      }
      const text = typeof envelope.body === 'string' ? envelope.body : '';
      return reply(path === REGISTRY_PATHS.create ? await this.service.create(envelope.claims, text) : await this.service.remove(envelope.claims, text));
    }
    return reply(fail(404, 'not_found'));
  }
}

/** A registry stub: anything with a `fetch` (the DO stub in production, the object itself in tests). */
export type RegistryFor = (sandboxId: string) => { fetch(request: Request): Promise<Response> };

/**
 * `POST|DELETE /internal/aws/tunnels`. `claims` are the v2 claims the Worker's pre-check
 * already verified against this exact body; none means 401. The registry is the one
 * for the claims' sandbox, so a body naming another sandbox fails `claimsMatch` there.
 */
export async function routeAwsTunnels(method: string, claims: PreviewTokenV2Claims | undefined, bodyText: string, registryFor: RegistryFor): Promise<Response> {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (method !== 'POST' && method !== 'DELETE') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!claims) return json({ ok: false, error: 'hmac_v2_required' }, 401);
  if (claims.provider !== 'aws-ec2' || !isRoutableSandboxId(claims.sandboxId)) return json({ ok: false, error: 'tunnel_claims_mismatch' }, 401);
  const path = method === 'POST' ? REGISTRY_PATHS.create : REGISTRY_PATHS.remove;
  return registryFor(claims.sandboxId).fetch(new Request(`https://aws-tunnels${path}`, {
    method: 'POST',
    body: JSON.stringify({ claims, body: bodyText }),
    headers: { 'content-type': 'application/json' },
  }));
}

export async function lookupAwsTunnel(registryFor: RegistryFor, sandboxId: string): Promise<AwsTunnelRecord | null> {
  if (!isRoutableSandboxId(sandboxId)) return null;
  const res = await registryFor(sandboxId).fetch(new Request(`https://aws-tunnels${REGISTRY_PATHS.get}`));
  if (!res.ok) return null;
  const { record } = (await res.json()) as { record: AwsTunnelRecord | null };
  return record && record.sandboxId === sandboxId ? record : null;
}

export async function verifyAwsTunnelOrigin(registryFor: RegistryFor, sandboxId: string): Promise<'verified' | 'mismatch' | 'not_connected'> {
  const res = await registryFor(sandboxId).fetch(new Request(`https://aws-tunnels${REGISTRY_PATHS.verifyOrigin}`, { method: 'POST' }));
  if (!res.ok) return 'not_connected';
  const { verdict } = (await res.json()) as { verdict: 'verified' | 'mismatch' | 'not_connected' };
  return verdict;
}
