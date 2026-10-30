/**
 * AWS desktop WebRTC relay (`./aws-ice`): relay-only config, the digest-in-signed-path push,
 * the status read, renewal through the gateway with Cloudflare's `relayOperation`, and the
 * open flow (`ensureAwsDesktop`) against a fake host that VERIFIES gw1 on every call, holds
 * the pushed config, and runs a neko admin API like the real one (login, /api/relay, logout).
 */
import { describe, expect, it } from 'bun:test';
import vectors from './aws-gateway.vectors.json';
import {
  AI_PUSH_SETTLE_MS,
  awsRelayContainer,
  awsRelayRefresh,
  buildAwsDesktopConfig,
  desktopConfigBody,
  ensureAwsDesktop,
  pushAwsDesktopConfig,
  readAwsDesktopStatus,
  sha256Hex,
  type AwsDesktopConfig,
  type RelayMint,
} from './aws-ice';
import { decodeControlKey, handleAwsPreview, verifyGatewayHeader, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import type { IceServerEntry } from './desktop-mode';
import { RelayFailure } from './relay-refresh';
import type { PreviewTokenV2Claims } from './hmac';

const KEY = decodeControlKey(vectors.controlKeyBase64)!;
const ZONE = 'origin.example.net';
const CID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const SID = 'guac-0a0a0a0a0a0a0a0a-0b0b0b0b0b0b4b0b';
const NOW = 1_800_000_000_000;
const NEKO = { user: 'a'.repeat(32), admin: 'b'.repeat(32) };
const TURN_USER = 'turn-user-SECRET-1';
const TURN_PASS = 'turn-pass-SECRET-2';

function record(over: Partial<AwsTunnelRecord> = {}): AwsTunnelRecord {
  return {
    computerId: CID, sandboxId: SID, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0',
    region: 'us-east-1', publicIp: '13.200.1.2', tunnelId: 't-1', dnsRecordId: 'd-1',
    hostname: `c-${SID}-g1-e2.${ZONE}`, controlKey: vectors.controlKeyBase64, createdAt: 1, originVerified: true,
    ...over,
  };
}

/** What Cloudflare Realtime TURN answers: a STUN entry plus TURN on UDP/TCP/TLS, including the :53 alternates. */
function cloudflareServers(user = TURN_USER, pass = TURN_PASS): IceServerEntry[] {
  return [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
      username: user, credential: pass,
    },
  ];
}

const mintOk = (expiresAt = NOW + 1_800_000): { mint: RelayMint; count: () => number } => {
  let n = 0;
  return { count: () => n, mint: async () => { n += 1; return { servers: cloudflareServers(), expiresAt }; } };
};

// ---------------------------------------------------------------------------- fake host
interface HostState {
  configured: boolean;
  expiresAt: number | null;
  desktop: string;
  ice: string;
  config?: AwsDesktopConfig;
  pushState?: string;
  pushError?: string;
  nekoUp: boolean;
  relay: { runtimeId: string; expiresAt: number };
  /** The desktop unit's state the host reports; undefined = an older host that does not. */
  unit?: string;
  restartsExhausted?: boolean;
  /** Host boot identity and whether the running desktop has the AI config (omitted = an older host). */
  bootId?: string;
  aiConfigured?: boolean;
  /** The host's clock (gw1 freshness), when a test moves time. */
  now?: number;
}

function fakeHost(over: Partial<HostState> = {}) {
  const st: HostState = {
    configured: false, expiresAt: null, desktop: 'absent', ice: 'none', nekoUp: true,
    relay: { runtimeId: 'c'.repeat(32), expiresAt: NOW + 1_200_000 }, ...over,
  };
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const bad: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const u = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    calls.push({ method, path: u.pathname, body });
    if (u.hostname !== `c-${SID}-g1-e2.${ZONE}`) bad.push(`host ${u.hostname}`);
    const v = await verifyGatewayHeader(headers.get('x-ezil-gw'), KEY, record(), method, u.pathname, Math.floor((st.now ?? NOW) / 1000));
    if (!v.ok) return new Response(JSON.stringify({ ok: false, error: v.error }), { status: 401 });
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (method === 'GET' && u.pathname === '/__ezil/control/desktop') {
      return j({ ok: true, configured: st.configured, expiresAt: st.expiresAt, desktop: st.desktop, ice: st.ice,
        ...(st.unit === undefined ? {} : { unit: st.unit, restartsExhausted: st.restartsExhausted === true }),
        ...(st.bootId === undefined ? {} : { bootId: st.bootId, aiConfigured: st.aiConfigured === true }) });
    }
    if (method === 'POST' && u.pathname.startsWith('/__ezil/control/ice/')) {
      if (u.pathname.slice('/__ezil/control/ice/'.length) !== (await sha256Hex(body ?? ''))) return j({ ok: false, error: 'ice_digest_mismatch' }, 400);
      if (st.pushError) return j({ ok: false, error: st.pushError }, 409);
      st.config = JSON.parse(body!) as AwsDesktopConfig;
      st.configured = true;
      st.expiresAt = st.config.expiresAt;
      return j({ ok: true, state: st.pushState ?? 'accepted' });
    }
    if (u.pathname.startsWith('/__p/8181/api/')) {
      if (!st.nekoUp) return j({ ok: false, error: 'desktop_unreachable' }, 502);
      const api = u.pathname.slice('/__p/8181'.length);
      if (api === '/api/login') {
        const creds = JSON.parse(body ?? '{}') as { password?: string };
        return creds.password === NEKO.admin ? j({ token: 'tok-1' }) : j({ message: 'bad' }, 401);
      }
      if (headers.get('authorization') !== 'Bearer tok-1') return j({ message: 'unauth' }, 401);
      if (api === '/api/relay' && method === 'GET') return j(st.relay);
      if (api === '/api/relay' && method === 'POST') {
        const r = JSON.parse(body ?? '{}') as { runtimeId: string; expiresAt: number; backend: AwsDesktopConfig['backend'] };
        if (r.runtimeId !== st.relay.runtimeId) return j({}, 409);
        st.relay = { runtimeId: st.relay.runtimeId, expiresAt: r.expiresAt };
        return j(st.relay);
      }
      if (api === '/api/logout') return j({});
    }
    return j({ ok: false, error: 'not_found' }, 404);
  };
  return { st, calls, bad, fetch };
}

// ------------------------------------------------------------------------------ tests
describe('buildAwsDesktopConfig: relay only, fail closed', () => {
  it('renewal preserves the boot TURN-only backend, including mixed STUN/TURN entries', async () => {
    const h = fakeHost();
    const servers = [{ urls: ['stun:s.example:3478', 'turn:t.example:3478'], username: TURN_USER, credential: TURN_PASS }];
    await awsRelayRefresh({ record: record(), zone: ZONE, fetch: h.fetch, nowMs: () => NOW, admin: NEKO.admin,
      runtimeId: h.st.relay.runtimeId, mint: async () => ({ servers, expiresAt: NOW + 1_740_000 }) });
    const posted = JSON.parse(h.calls.find(c => c.method === 'POST' && c.path.endsWith('/api/relay'))!.body!);
    const boot = buildAwsDesktopConfig(servers, NOW + 1_740_000, NEKO, NOW);
    expect(posted.backend).toEqual(boot.backend);
    expect(posted.frontend).toEqual(boot.frontend);
    expect(posted.backend.flatMap((s: AwsDesktopConfig['backend'][number]) => s.urls)).toEqual(['turn:t.example:3478']);
  });
  it('renewal with no authenticated TURN backend never posts a replacement config', async () => {
    for (const servers of [[{ urls: ['stun:s.example:3478'] }], [{ urls: ['turn:t.example:3478'] }]]) {
      const h = fakeHost();
      await expect(awsRelayRefresh({ record: record(), zone: ZONE, fetch: h.fetch, nowMs: () => NOW, admin: NEKO.admin,
        runtimeId: h.st.relay.runtimeId, mint: async () => ({ servers, expiresAt: NOW + 1_740_000 }) })).rejects.toThrow('turn_unavailable');
      expect(h.calls.some(c => c.method === 'POST' && c.path.endsWith('/api/relay'))).toBe(false);
    }
  });
  it('backend is TURN-only (no STUN, so no server-reflexive gathering); frontend is browser-safe', () => {
    const c = buildAwsDesktopConfig(cloudflareServers(), NOW + 1_800_000, NEKO, NOW);
    const backendUrls = c.backend.flatMap((s) => s.urls);
    expect(backendUrls.length).toBeGreaterThan(0);
    expect(backendUrls.every((u) => u.startsWith('turn:') || u.startsWith('turns:'))).toBe(true);
    expect(c.backend.every((s) => s.username === TURN_USER && s.credential === TURN_PASS)).toBe(true);
    const frontUrls = c.frontend.flatMap((s) => s.urls);
    expect(frontUrls.some((u) => /:53(\?|$)/.test(u))).toBe(false);
    expect(frontUrls.some((u) => u.startsWith('turns:'))).toBe(true);
    expect(c.neko).toEqual(NEKO);
  });
  it('no authenticated TURN relay, an unknown scheme, or too many servers: turn_unavailable', () => {
    const refusals: IceServerEntry[][] = [
      [{ urls: ['stun:stun.example:3478'] }],
      [{ urls: ['turn:t.example:3478'] }],
      [{ urls: ['turn:t.example:3478'], username: 'u' }],
      [{ urls: ['https://t.example'], username: 'u', credential: 'p' }],
      Array.from({ length: 9 }, () => ({ urls: ['turn:t.example:3478'], username: 'u', credential: 'p' })),
      [],
    ];
    for (const servers of refusals) {
      expect(() => buildAwsDesktopConfig(servers, NOW + 600_000, NEKO, NOW)).toThrow('turn_unavailable');
    }
  });
  it('lifetime: more than 60 s and at most 30 min ahead (neko /api/relay rules)', () => {
    expect(() => buildAwsDesktopConfig(cloudflareServers(), NOW + 60_000, NEKO, NOW)).toThrow('turn_unavailable');
    expect(() => buildAwsDesktopConfig(cloudflareServers(), NOW + 1_800_001, NEKO, NOW)).toThrow('turn_unavailable');
    expect(buildAwsDesktopConfig(cloudflareServers(), NOW + 60_001, NEKO, NOW).expiresAt).toBe(NOW + 60_001);
  });
  it('never the keyless local-dev neko defaults, never one value for both roles', () => {
    for (const neko of [{ user: 'neko', admin: 'admin' }, { user: NEKO.user, admin: NEKO.user }, { user: 'A'.repeat(32), admin: NEKO.admin }]) {
      expect(() => buildAwsDesktopConfig(cloudflareServers(), NOW + 600_000, neko, NOW)).toThrow('neko_credentials_unavailable');
    }
  });
});

describe('push and status (GW-5): signed, digest in the signed path', () => {
  it('push: POST /__ezil/control/ice/<sha256(body)> with a valid gw1 over that path', async () => {
    const h = fakeHost();
    const c = buildAwsDesktopConfig(cloudflareServers(), NOW + 600_000, NEKO, NOW);
    const res = await pushAwsDesktopConfig(record(), ZONE, c, h.fetch, NOW / 1000);
    expect(res.status).toBe(200);
    const call = h.calls[0]!;
    expect(call.path).toBe(`/__ezil/control/ice/${await sha256Hex(desktopConfigBody(c))}`);
    expect(call.body).toBe(desktopConfigBody(c));
    expect(h.st.config).toEqual(c);
    expect(h.bad).toEqual([]);
  });
  it('a body that differs from the signed digest is refused by the host check', async () => {
    const h = fakeHost();
    const c = buildAwsDesktopConfig(cloudflareServers(), NOW + 600_000, NEKO, NOW);
    const evil: FetchLike = (url, init) => h.fetch(url, { ...init, body: (init.body as string).replace(TURN_PASS, 'other') });
    expect((await pushAwsDesktopConfig(record(), ZONE, c, evil, NOW / 1000)).status).toBe(400);
    expect(h.st.config).toBeUndefined();
  });
  it('status: parsed from a signed GET; an unreadable answer is aws_desktop_unreachable (503)', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 5, desktop: 'running', ice: 'applied' });
    expect(await readAwsDesktopStatus(record(), ZONE, h.fetch, NOW / 1000)).toEqual({ configured: true, expiresAt: NOW + 5, desktop: 'running', ice: 'applied',
      unit: null, restartsExhausted: false });
    const newer = fakeHost({ desktop: 'absent', unit: 'failed', restartsExhausted: true });
    expect(await readAwsDesktopStatus(record(), ZONE, newer.fetch, NOW / 1000)).toMatchObject({ unit: 'failed', restartsExhausted: true });
    const broken: FetchLike = async () => new Response('{"ok":true}', { status: 200 });
    const err = await readAwsDesktopStatus(record(), ZONE, broken, NOW / 1000).catch((e) => e);
    expect(err).toBeInstanceOf(RelayFailure);
    expect([(err as RelayFailure).code, (err as RelayFailure).status]).toEqual(['aws_desktop_unreachable', 503]);
  });
  it('an unroutable record or a bad control key never reaches fetch', async () => {
    const h = fakeHost();
    const c = buildAwsDesktopConfig(cloudflareServers(), NOW + 600_000, NEKO, NOW);
    for (const r of [record({ controlKey: 'nope' }), record({ sandboxId: 'Bad' })]) {
      await expect(pushAwsDesktopConfig(r, ZONE, c, h.fetch, NOW / 1000)).rejects.toThrow('aws_origin_unavailable');
    }
    expect(h.calls).toEqual([]);
  });
});

describe('renewal through the gateway (relayOperation unchanged)', () => {
  it('the transport signs /__p/8181/<path> and refuses any other port or host', async () => {
    const h = fakeHost();
    const t = awsRelayContainer(record(), ZONE, h.fetch, () => NOW / 1000);
    const res = await t.containerFetch('http://127.0.0.1:8181/api/login', { method: 'POST', body: JSON.stringify({ password: NEKO.admin }) }, 8181);
    expect(res.status).toBe(200);
    expect(h.calls[0]!.path).toBe('/__p/8181/api/login');
    await expect(t.containerFetch('http://127.0.0.1:8443/api/x', {}, 8443)).rejects.toThrow('relay_unavailable');
    await expect(t.containerFetch('http://10.0.0.1:8181/api/x', {}, 8181)).rejects.toThrow('relay_unavailable');
    expect(h.calls.length).toBe(1);
  });
  it('read then renew in place: login with the derived admin, POST /api/relay, logout', async () => {
    const h = fakeHost();
    const state = await awsRelayRefresh({ record: record(), zone: ZONE, fetch: h.fetch, nowMs: () => NOW, admin: NEKO.admin });
    expect(state).toEqual({ runtimeId: 'c'.repeat(32), expiresAt: NOW + 1_200_000 });
    const { mint } = mintOk(NOW + 1_700_000);
    const renewed = await awsRelayRefresh({ record: record(), zone: ZONE, fetch: h.fetch, nowMs: () => NOW, admin: NEKO.admin, runtimeId: state.runtimeId, mint });
    expect(renewed.expiresAt).toBe(NOW + 1_700_000);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toContain('POST /__p/8181/api/relay');
    expect(h.calls.at(-1)!.path).toBe('/__p/8181/api/logout');
  });
});

describe('ensureAwsDesktop: the open flow', () => {
  const run = (h: ReturnType<typeof fakeHost>, mint: RelayMint) =>
    ensureAwsDesktop({ record: record(), zone: ZONE, fetch: h.fetch, nowMs: () => NOW, neko: NEKO, mint });

  it('no config on the host: mint ONCE, push relay-only config, report starting', async () => {
    const h = fakeHost();
    const m = mintOk();
    expect(await run(h, m.mint)).toEqual({ state: 'starting', reason: 'config_pushed' });
    expect(m.count()).toBe(1);
    expect(h.st.config!.backend.flatMap((s) => s.urls).every((u) => /^turns?:/.test(u))).toBe(true);
    expect(h.st.config!.neko).toEqual(NEKO);
  });
  it('a fresh config already on the host while the desktop boots: starting, no mint, no push', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent' });
    const m = mintOk();
    expect(await run(h, m.mint)).toEqual({ state: 'starting', reason: 'desktop_starting' });
    expect(m.count()).toBe(0);
    expect(h.calls.map((c) => c.path)).toEqual(['/__ezil/control/desktop']);
  });
  it('an expiring config while the desktop is not up yet: a fresh one is pushed', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 30_000, desktop: 'absent' });
    const m = mintOk();
    expect((await run(h, m.mint)).state).toBe('starting');
    expect(m.count()).toBe(1);
  });
  it('a desktop that started WITHOUT a relay (timed out): push, the host schedules the restart', async () => {
    const h = fakeHost({ configured: false, desktop: 'running', ice: 'missing', pushState: 'restart_scheduled' });
    const m = mintOk();
    expect(await run(h, m.mint)).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect(m.count()).toBe(1);
  });
  it('a crashed desktop (unit exited or failed) with a fresh config: push, so the host restarts it', async () => {
    for (const unit of ['inactive', 'failed']) {
      const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent', unit, pushState: 'restart_scheduled' });
      const m = mintOk();
      expect(await run(h, m.mint)).toEqual({ state: 'starting', reason: 'restart_scheduled' });
      expect(m.count()).toBe(1);
    }
  });
  it('a desktop whose unit is still starting (or an older host that does not say): starting, no push', async () => {
    for (const unit of ['pending', 'activating', 'active', undefined]) {
      const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent', unit });
      const m = mintOk();
      expect(await run(h, m.mint)).toEqual({ state: 'starting', reason: 'desktop_starting' });
      expect(m.count()).toBe(0);
    }
  });
  it('restarts exhausted: aws_desktop_failed, a clear failure, never another starting and no mint', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent', unit: 'failed', restartsExhausted: true });
    const m = mintOk();
    await expect(run(h, m.mint)).rejects.toMatchObject({ code: 'aws_desktop_failed', status: 502 });
    expect(m.count()).toBe(0);
    const refused = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent', unit: 'failed', pushError: 'desktop_restart_exhausted' });
    await expect(run(refused, mintOk().mint)).rejects.toMatchObject({ code: 'aws_desktop_failed' });
  });
  it('a malformed unit value is ignored (null), never trusted', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent', unit: 'Inactive; x' });
    expect(await run(h, mintOk().mint)).toEqual({ state: 'starting', reason: 'desktop_starting' });
  });
  it('running with a relay far from expiry: ready with the relay state, no mint', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_200_000, desktop: 'running', ice: 'applied' });
    const m = mintOk();
    expect(await run(h, m.mint)).toEqual({ state: 'ready', relay: { runtimeId: 'c'.repeat(32), expiresAt: NOW + 1_200_000 } });
    expect(m.count()).toBe(0);
  });
  it('warm open with the relay expiring within 60 s: renewed in place', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 30_000, desktop: 'running', ice: 'applied',
      relay: { runtimeId: 'c'.repeat(32), expiresAt: NOW + 30_000 } });
    const m = mintOk(NOW + 1_700_000);
    const out = await run(h, m.mint);
    expect(out).toEqual({ state: 'ready', relay: { runtimeId: 'c'.repeat(32), expiresAt: NOW + 1_700_000 } });
    expect(m.count()).toBe(1);
  });
  it('neko not answering yet: starting, never an error', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'running', ice: 'applied', nekoUp: false });
    expect(await run(h, mintOk().mint)).toEqual({ state: 'starting', reason: 'desktop_starting' });
  });
  it('no TURN provider: turn_unavailable; a refused push carries only the host code', async () => {
    await expect(run(fakeHost(), async () => null)).rejects.toThrow('turn_unavailable');
    await expect(run(fakeHost({ pushError: 'ice_config_invalid' }), mintOk().mint)).rejects.toThrow('ice_config_invalid');
  });
  it('no failure message ever carries a TURN credential or a neko value', async () => {
    const msgs: string[] = [];
    for (const h of [fakeHost({ pushError: 'ice_config_invalid' }), fakeHost()]) {
      const bad: RelayMint = async () => ({ servers: [{ urls: ['turn:t.example:3478'], username: TURN_USER }], expiresAt: NOW + 600_000 });
      for (const mint of [mintOk().mint, bad]) {
        try { await run(h, mint); } catch (e) { msgs.push(String((e as Error).message)); }
      }
    }
    expect(msgs.length).toBeGreaterThan(0);
    for (const m of msgs) for (const s of [TURN_USER, TURN_PASS, NEKO.user, NEKO.admin]) expect(m).not.toContain(s);
  });
});

describe('ensureAwsDesktop: the AI config is pushed once per boot and lease epoch (G12)', () => {
  const BOOT = '11111111-1111-4111-8111-111111111111';
  const AI = { baseUrl: 'https://aws-8443-x.example/ai/v1', proxyToken: 'p'.repeat(64) };
  /**
   * A desktop already running WITHOUT the AI config (the host restarts it onto a pushed one at its
   * next tick), and a registry record that evolves like the real one: `aiConfig` mints the boot's
   * nonce (`aiBootId`), `aiDelivered` records an accepted push.
   */
  function scene(over: Partial<HostState> = {}) {
    const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'running', ice: 'applied',
      bootId: BOOT, aiConfigured: false, pushState: 'restart_scheduled', ...over });
    let rec = record();
    const m = mintOk();
    const delivered: Array<{ bootId: string; expiresAt: number }> = [];
    let deliverFails = false;
    const open = (now = NOW) => {
      h.st.now = now;
      return ensureAwsDesktop({ record: rec, zone: ZONE, fetch: h.fetch, nowMs: () => now, neko: NEKO, mint: m.mint,
        aiConfig: async (bootId) => { rec = { ...rec, aiBootId: bootId }; return AI; },
        aiDelivered: async (bootId, expiresAt) => {
          if (deliverFails) throw new Error('registry down');
          delivered.push({ bootId, expiresAt });
          rec = { ...rec, aiDelivered: { bootId, expiresAt, at: now } };
        } });
    };
    const pushes = () => h.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/__ezil/control/ice/')).length;
    return { h, m, delivered, open, pushes, failDelivery: () => { deliverFails = true; } };
  }

  it('one push, recorded; every later open while the host restarts onto it pushes nothing and stays starting', async () => {
    const s = scene();
    expect(await s.open()).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect(s.pushes()).toBe(1);
    expect(s.h.st.config!.ai).toEqual(AI);
    expect(s.delivered).toEqual([{ bootId: BOOT, expiresAt: s.h.st.expiresAt! }]);
    // The client re-asks every ~2 s. The old rule re-minted and re-pushed on each one.
    for (let t = 2_000; t < 60_000; t += 2_000) {
      expect(await s.open(NOW + t)).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    }
    expect(s.pushes()).toBe(1);
    expect(s.m.count()).toBe(1);
    // The host restarted onto it: ready, still one push.
    s.h.st.aiConfigured = true;
    expect((await s.open(NOW + 62_000)).state).toBe('ready');
    expect(s.pushes()).toBe(1);
    expect(s.h.bad).toEqual([]);
  });

  it('a desktop that is still booting from the delivered config is not pushed again either', async () => {
    const s = scene({ configured: false, expiresAt: null, desktop: 'absent', ice: 'none', pushState: 'accepted' });
    expect(await s.open()).toEqual({ state: 'starting', reason: 'config_pushed' });
    for (let t = 2_000; t < 30_000; t += 2_000) {
      expect(await s.open(NOW + t)).toEqual({ state: 'starting', reason: 'desktop_starting' });
    }
    expect(s.pushes()).toBe(1);
  });

  it('a host that never restarts onto it gets one more push only after AI_PUSH_SETTLE_MS', async () => {
    const s = scene();
    await s.open();
    await s.open(NOW + AI_PUSH_SETTLE_MS - 1);
    expect(s.pushes()).toBe(1);
    expect(await s.open(NOW + AI_PUSH_SETTLE_MS)).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect(s.pushes()).toBe(2);
    await s.open(NOW + AI_PUSH_SETTLE_MS + 2_000);
    expect(s.pushes()).toBe(2);
  });

  it('a new host boot, or a held config that changed, is pushed again', async () => {
    const s = scene();
    await s.open();
    s.h.st.bootId = '22222222-2222-4222-8222-222222222222';
    await s.open(NOW + 2_000);
    expect(s.pushes()).toBe(2);
    expect(s.delivered.at(-1)!.bootId).toBe('22222222-2222-4222-8222-222222222222');
    s.h.st.expiresAt = NOW + 900_000; // the host holds some other config now
    await s.open(NOW + 4_000);
    expect(s.pushes()).toBe(3);
  });

  it('an unrecorded push costs one more push, never the open; a refused push is not recorded', async () => {
    const s = scene();
    s.failDelivery();
    expect(await s.open()).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    await s.open(NOW + 2_000);
    expect(s.pushes()).toBe(2);
    const r = scene({ pushError: 'ice_store_failed' });
    await expect(r.open()).rejects.toThrow('ice_store_failed');
    expect(r.delivered).toEqual([]);
  });
});

describe('handleAwsPreview with the desktop relay', () => {
  const claims = (): PreviewTokenV2Claims => ({
    ts: NOW, sandboxId: SID, computerId: CID, userId: 'u1', provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2,
  });
  const deps = (ensureDesktop: Parameters<typeof handleAwsPreview>[1]['ensureDesktop']) => ({
    zone: ZONE, secrets: ['s3cr3t'], zoneRoot: 'preview.example.org', lookup: async () => record(),
    verifyOrigin: async () => 'verified' as const, nowMs: () => NOW, ensureDesktop,
  });
  it('starting: 503 aws_desktop_starting with the reason', async () => {
    const res = await handleAwsPreview(claims(), deps(async () => ({ state: 'starting', reason: 'config_pushed' })));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'aws_desktop_starting', reason: 'config_pushed' });
  });
  it('ready: 200 with the relay state and turnRelay, never a credential', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_200_000, desktop: 'running', ice: 'applied' });
    const res = await handleAwsPreview(claims(), deps((r) => ensureAwsDesktop({ record: r, zone: ZONE, fetch: h.fetch, nowMs: () => NOW, neko: NEKO, mint: mintOk().mint })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.relay).toEqual({ runtimeId: 'c'.repeat(32), expiresAt: NOW + 1_200_000 });
    expect(body.turnRelay).toBe(true);
    for (const s of [TURN_USER, TURN_PASS, NEKO.user, NEKO.admin, vectors.controlKeyBase64]) expect(JSON.stringify(body)).not.toContain(s);
  });
  it('a relay failure answers its code and status only', async () => {
    const res = await handleAwsPreview(claims(), deps(async () => { throw new RelayFailure('turn_unavailable'); }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: 'turn_unavailable' });
    const odd = await handleAwsPreview(claims(), deps(async () => { throw new Error(`boom ${TURN_PASS}`); }));
    expect(await odd.json()).toEqual({ ok: false, error: 'relay_refresh_failed' });
  });
});
