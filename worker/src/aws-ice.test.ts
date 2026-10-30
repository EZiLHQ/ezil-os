/**
 * AWS desktop WebRTC relay (`./aws-ice`): relay-only config, the digest-in-signed-path push,
 * the status read, renewal through the gateway with Cloudflare's `relayOperation`, and the
 * open flow (`ensureAwsDesktop`) against a fake host that VERIFIES gw1 on every call, holds
 * the pushed config, and runs a neko admin API like the real one (login, /api/relay, logout).
 */
import { describe, expect, it } from 'bun:test';
import vectors from './aws-gateway.vectors.json';
import {
  AWS_DESKTOP_CONFIG_APPLY_MS,
  AWS_DESKTOP_STATUS_TIMEOUT_MS,
  awsRelayContainer,
  awsRelayRefresh,
  buildAwsDesktopConfig,
  awsSurfaceAnswers,
  desktopConfigBody,
  ensureAwsDesktop,
  ensureAwsDesktopConfig,
  pushAwsDesktopConfig,
  readAwsDesktopStatus,
  sha256Hex,
  type AwsDesktopConfig,
  type RelayMint,
} from './aws-ice';
import { awsPreviewSurface, decodeControlKey, handleAwsPreview, verifyGatewayHeader, type AwsPreviewSurface, type AwsTunnelRecord, type FetchLike } from './aws-origin';
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
  /** The host kernel's boot id and whether the running desktop has Chat's AI env (reported together). */
  bootId?: string;
  aiConfigured?: boolean;
  /** code-server answers on 8443; otherwise the edge's 502 desktop_unreachable. */
  codeUp?: boolean;
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
    const v = await verifyGatewayHeader(headers.get('x-ezil-gw'), KEY, record(), method, u.pathname, Math.floor(NOW / 1000));
    if (!v.ok) return new Response(JSON.stringify({ ok: false, error: v.error }), { status: 401 });
    const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (method === 'GET' && u.pathname === '/__ezil/control/desktop') {
      return j({ ok: true, configured: st.configured, expiresAt: st.expiresAt, desktop: st.desktop, ice: st.ice,
        ...(st.unit === undefined ? {} : { unit: st.unit, restartsExhausted: st.restartsExhausted === true }),
        ...(st.bootId === undefined ? {} : { bootId: st.bootId, aiConfigured: st.aiConfigured === true }) });
    }
    if (method === 'GET' && u.pathname === '/__p/8443/healthz') {
      return st.codeUp ? j({ status: 'alive', lastHeartbeat: NOW }) : j({ ok: false, error: 'desktop_unreachable' }, 502);
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
  it('status: a host that never answers is aws_desktop_unreachable (503) after the explicit timeout', async () => {
    let signal: AbortSignal | null | undefined;
    const hung: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const err = await readAwsDesktopStatus(record(), ZONE, hung, NOW / 1000, 25).catch((e) => e);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect([(err as RelayFailure).code, (err as RelayFailure).status]).toEqual(['aws_desktop_unreachable', 503]);
    // The default bound is explicit too: every status read carries a signal.
    const h = fakeHost({ configured: true, expiresAt: NOW + 5, desktop: 'running', ice: 'applied' });
    let seen: AbortSignal | null | undefined;
    await readAwsDesktopStatus(record(), ZONE, (u, i) => { seen = i.signal; return h.fetch(u, i); }, NOW / 1000);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(AWS_DESKTOP_STATUS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(AWS_DESKTOP_STATUS_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
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

describe('ensureAwsDesktop: one config push per host boot while the host applies it', () => {
  const BOOT = '11111111-1111-4111-8111-111111111111';
  const ai = async () => ({ baseUrl: `https://aws-8443-${SID}-aws.preview.example.org/ai/v1`, proxyToken: 'f'.repeat(64) });
  /** Opens against one host, with the record the registry would hand each ask (a push for this boot is recorded on it). */
  function opener(h: ReturnType<typeof fakeHost>, start: Partial<AwsTunnelRecord> = {}) {
    const m = mintOk(NOW + 1_600_000);
    const reg = { rec: record(start), writes: 0, failWrite: false };
    let now = NOW;
    const ask = (at = now) => {
      now = at;
      return ensureAwsDesktop({ record: reg.rec, zone: ZONE, fetch: h.fetch, nowMs: () => now, neko: NEKO, mint: m.mint, aiConfig: ai,
        restartPush: async (bootId, expiresAt) => {
          reg.writes += 1;
          if (reg.failWrite) throw new Error('registry down');
          reg.rec = { ...reg.rec, restartPushBootId: bootId, restartPushExpiresAt: expiresAt, restartPushAt: now };
        } });
    };
    const pushes = () => h.calls.filter((c) => c.path.startsWith('/__ezil/control/ice/')).length;
    return { ask, reg, mints: m.count, pushes };
  }

  it('10-30 live: a running desktop without Chat\'s AI env is pushed ONCE; every later ask waits (config_pending), no mint, no push', async () => {
    // The host keeps aiConfigured=false until its next tick restarts the desktop; each push re-arms that restart.
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false,
      pushState: 'restart_scheduled' });
    const o = opener(h, { aiBootId: BOOT });
    // Asks every ~2 s for ~110 s (inside the fake host's gw1 skew window around NOW).
    const start = NOW - 110_000;
    expect(await o.ask(start)).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect(h.st.config!.ai).toBeDefined();
    for (let i = 1; i <= 55; i++) expect(await o.ask(start + i * 2_000)).toEqual({ state: 'starting', reason: 'config_pending' });
    expect([o.pushes(), o.mints(), o.reg.writes]).toEqual([1, 1, 1]);
    expect(o.reg.rec).toMatchObject({ restartPushBootId: BOOT, restartPushExpiresAt: h.st.expiresAt!, restartPushAt: start });
    // The restart applied it: ready, with no further push.
    h.st.aiConfigured = true;
    expect((await o.ask(NOW + 2_000)).state).toBe('ready');
    expect(o.pushes()).toBe(1);
  });
  it('a desktop that started without a relay (ice missing) gets one push per boot too', async () => {
    for (const aiConfigured of [false, true]) {
      const h = fakeHost({ configured: false, desktop: 'running', ice: 'missing', bootId: BOOT, aiConfigured, pushState: 'restart_scheduled' });
      const o = opener(h);
      expect(await o.ask()).toEqual({ state: 'starting', reason: 'restart_scheduled' });
      expect(await o.ask(NOW + 2_000)).toEqual({ state: 'starting', reason: 'config_pending' });
      expect(o.pushes()).toBe(1);
    }
  });
  it('a push the host never applies within the bound is a coded failure, never an endless starting', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false });
    const o = opener(h, { aiBootId: BOOT, restartPushBootId: BOOT, restartPushExpiresAt: NOW + 1_700_000,
      restartPushAt: NOW - AWS_DESKTOP_CONFIG_APPLY_MS + 1 });
    expect(await o.ask()).toEqual({ state: 'starting', reason: 'config_pending' });
    await expect(o.ask(NOW + 1)).rejects.toMatchObject({ code: 'aws_desktop_config_unapplied', status: 502 });
    expect([o.pushes(), o.mints()]).toEqual([0, 0]);
    // The bound sits inside the shell's 215 s wake deadline, so the waiting open receives the code.
    expect(AWS_DESKTOP_CONFIG_APPLY_MS).toBeGreaterThanOrEqual(120_000);
    expect(AWS_DESKTOP_CONFIG_APPLY_MS).toBeLessThan(215_000);
  });
  it('another fresh config held instead of the recorded one (the Restart route staged it) gets its own bound, with no push', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_650_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false });
    // Our recorded push is long past its bound, but the host now holds another config.
    const o = opener(h, { aiBootId: BOOT, restartPushBootId: BOOT, restartPushExpiresAt: NOW + 1_000_000,
      restartPushAt: NOW - 2 * AWS_DESKTOP_CONFIG_APPLY_MS });
    expect(await o.ask()).toEqual({ state: 'starting', reason: 'config_pending' });
    expect([o.pushes(), o.mints(), o.reg.writes]).toEqual([0, 0, 1]);
    expect(o.reg.rec).toMatchObject({ restartPushExpiresAt: NOW + 1_650_000, restartPushAt: NOW });
    expect(await o.ask(NOW + 2_000)).toEqual({ state: 'starting', reason: 'config_pending' });
    expect(o.reg.writes).toBe(1);
    // Its own bound: the adopted record ends in the coded failure once that config sits unapplied as long.
    const later = opener(h, { ...o.reg.rec, restartPushAt: NOW - AWS_DESKTOP_CONFIG_APPLY_MS });
    await expect(later.ask()).rejects.toMatchObject({ code: 'aws_desktop_config_unapplied' });
    expect(o.pushes()).toBe(0);
  });
  it('a recorded push whose config the host no longer holds (expired) is a past episode: push again, never the terminal code', async () => {
    // e.g. the desktop crashed long after the first push and restarted without a relay once its config expired.
    const h = fakeHost({ configured: false, desktop: 'running', ice: 'missing', bootId: BOOT, aiConfigured: false, pushState: 'restart_scheduled' });
    const o = opener(h, { aiBootId: BOOT, restartPushBootId: BOOT, restartPushAt: NOW - 40 * 60_000 });
    expect(await o.ask()).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect([o.pushes(), o.reg.writes]).toEqual([1, 1]);
    expect(o.reg.rec.restartPushAt).toBe(NOW);
    expect(await o.ask(NOW + 2_000)).toEqual({ state: 'starting', reason: 'config_pending' });
  });
  it('a new host boot (another bootId) is pushed again; so is an older host that reports no boot id', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false,
      pushState: 'restart_scheduled' });
    const o = opener(h, { aiBootId: '22222222-2222-4222-8222-222222222222', restartPushBootId: '22222222-2222-4222-8222-222222222222',
      restartPushAt: NOW - 1_000 });
    expect(await o.ask()).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect(o.pushes()).toBe(1);
    const old = fakeHost({ configured: false, desktop: 'running', ice: 'missing', pushState: 'restart_scheduled' });
    const p = opener(old);
    await p.ask();
    await p.ask(NOW + 2_000);
    expect([p.pushes(), p.reg.writes]).toEqual([2, 0]);
  });
  it('a lost registry write never fails the open: the push already went out', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false,
      pushState: 'restart_scheduled' });
    const o = opener(h, { aiBootId: BOOT });
    o.reg.failWrite = true;
    expect(await o.ask()).toEqual({ state: 'starting', reason: 'restart_scheduled' });
    expect([o.pushes(), o.reg.writes]).toEqual([1, 1]);
  });
  it('a desktop still starting with this boot\'s AI config already held: config_pending, no re-push', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'absent', unit: 'activating', bootId: BOOT, aiConfigured: false });
    const o = opener(h, { aiBootId: BOOT });
    expect(await o.ask()).toEqual({ state: 'starting', reason: 'config_pending' });
    expect([o.pushes(), o.mints()]).toEqual([0, 0]);
    // No AI config minted for this boot yet: pushed once with it, as before.
    const fresh = opener(fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'absent', bootId: BOOT, aiConfigured: false }));
    expect(await fresh.ask()).toEqual({ state: 'starting', reason: 'config_pushed' });
    expect(fresh.pushes()).toBe(1);
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

describe('handleAwsPreview: the Code and app surfaces never wait on the desktop', () => {
  const BOOT = '11111111-1111-4111-8111-111111111111';
  const claims = (): PreviewTokenV2Claims => ({
    ts: NOW, sandboxId: SID, computerId: CID, userId: 'u1', provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2,
  });
  const ai = async () => ({ baseUrl: `https://aws-8443-${SID}-aws.preview.example.org/ai/v1`, proxyToken: 'f'.repeat(64) });
  /** The index.ts wiring, against one fake host: the desktop path is counted, background work is collected. */
  function wired(h: ReturnType<typeof fakeHost>, surface?: AwsPreviewSurface, start: Partial<AwsTunnelRecord> = {}) {
    let rec = record(start);
    const tasks: Promise<unknown>[] = [];
    const seen = { desktop: 0, probes: 0 };
    const params = (r: AwsTunnelRecord) => ({ record: r, zone: ZONE, fetch: h.fetch, nowMs: () => NOW, neko: NEKO, mint: mintOk().mint, aiConfig: ai,
      restartPush: async (bootId: string, expiresAt: number) => { rec = { ...rec, restartPushBootId: bootId, restartPushExpiresAt: expiresAt, restartPushAt: NOW }; } });
    const deps = {
      zone: ZONE, secrets: ['s3cr3t'], zoneRoot: 'preview.example.org', lookup: async () => rec,
      verifyOrigin: async () => 'verified' as const, nowMs: () => NOW, surface,
      ensureDesktop: (r: AwsTunnelRecord) => { seen.desktop += 1; return ensureAwsDesktop(params(r)); },
      ensureConfig: (r: AwsTunnelRecord) => ensureAwsDesktopConfig(params(r)),
      surfaceAnswers: (r: AwsTunnelRecord, s: 'code' | 'app') => { seen.probes += 1; return awsSurfaceAnswers(r, ZONE, s, h.fetch, () => NOW); },
      background: (t: Promise<unknown>) => { tasks.push(t); },
    };
    const pushes = () => h.calls.filter((c) => c.path.startsWith('/__ezil/control/ice/')).length;
    return { deps, tasks, seen, pushes };
  }

  it('10-30 live: code-server answers while the desktop waits on its AI config -> Code gets its URL now; the config goes out once, after', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false,
      nekoUp: false, codeUp: true, pushState: 'restart_scheduled' });
    const w = wired(h, 'code', { aiBootId: BOOT });
    const res = await handleAwsPreview(claims(), w.deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.codePreviewUrl)).toContain(`https://aws-8443-${SID}-aws.preview.example.org/preview-bootstrap?token=`);
    expect(body.relay).toBeUndefined();
    expect(body.turnRelay).toBeUndefined();
    expect(w.seen.desktop).toBe(0);
    // Chat's AI env (code-server's ezil-models extension) is not dropped: pushed once, in the background.
    expect(w.tasks.length).toBe(1);
    await Promise.all(w.tasks);
    expect(w.pushes()).toBe(1);
    expect(h.st.config!.ai).toBeDefined();
    // The next Code ask neither waits nor pushes again.
    const again = await handleAwsPreview(claims(), w.deps);
    expect(again.status).toBe(200);
    await Promise.all(w.tasks);
    expect(w.pushes()).toBe(1);
  });
  it('the desktop surface is unchanged on that same host: it still waits (503 aws_desktop_starting) and never probes Code', async () => {
    for (const surface of [undefined, 'desktop'] as const) {
      const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false,
        nekoUp: false, codeUp: true, pushState: 'restart_scheduled' });
      const w = wired(h, surface, { aiBootId: BOOT });
      const res = await handleAwsPreview(claims(), w.deps);
      expect([res.status, await res.json()]).toEqual([503, { ok: false, error: 'aws_desktop_starting', reason: 'restart_scheduled' }]);
      expect([w.seen.desktop, w.seen.probes, w.tasks.length]).toEqual([1, 0, 0]);
      h.st.aiConfigured = true;
      h.st.nekoUp = true;
      const ready = await handleAwsPreview(claims(), w.deps);
      expect(ready.status).toBe(200);
      expect(((await ready.json()) as Record<string, unknown>).turnRelay).toBe(true);
    }
  });
  it('a cold host (no config, Code not up): the Code ask still pushes the config inline and answers starting', async () => {
    const h = fakeHost({ bootId: BOOT, aiConfigured: false });
    const w = wired(h, 'code');
    const res = await handleAwsPreview(claims(), w.deps);
    expect([res.status, await res.json()]).toEqual([503, { ok: false, error: 'aws_desktop_starting', reason: 'config_pushed' }]);
    expect([w.pushes(), w.tasks.length, w.seen.desktop]).toEqual([1, 0, 0]);
    expect(h.st.config!.ai).toBeDefined();
  });
  it('the desktop runs with its config but code-server is not up yet: 503 code_starting, no push', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: true });
    const w = wired(h, 'code');
    const res = await handleAwsPreview(claims(), w.deps);
    expect([res.status, await res.json()]).toEqual([503, { ok: false, error: 'aws_desktop_starting', reason: 'code_starting' }]);
    expect(w.pushes()).toBe(0);
  });
  it('a config failure while Code is not up answers its code; a background failure never touches Code\'s answer', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 600_000, desktop: 'absent', unit: 'failed', restartsExhausted: true });
    const w = wired(h, 'code');
    const res = await handleAwsPreview(claims(), w.deps);
    expect([res.status, await res.json()]).toEqual([502, { ok: false, error: 'aws_desktop_failed' }]);
    const up = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', codeUp: true });
    const v = wired(up, 'code');
    v.deps.ensureConfig = async () => { throw new RelayFailure('turn_unavailable'); };
    expect((await handleAwsPreview(claims(), v.deps)).status).toBe(200);
    await Promise.all(v.tasks);
  });
  it('the hosted app surface is served once the desktop container runs, without waiting on neko or the AI config', async () => {
    const h = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'running', ice: 'applied', bootId: BOOT, aiConfigured: false, nekoUp: false });
    const w = wired(h, 'app', { aiBootId: BOOT });
    const res = await handleAwsPreview(claims(), w.deps);
    expect(res.status).toBe(200);
    expect(String(((await res.json()) as Record<string, unknown>).appPreviewUrl)).toContain('https://aws-3002-');
    expect(w.seen.desktop).toBe(0);
    const down = fakeHost({ configured: true, expiresAt: NOW + 1_700_000, desktop: 'absent', unit: 'activating' });
    const res2 = await handleAwsPreview(claims(), wired(down, 'app').deps);
    expect([res2.status, await res2.json()]).toEqual([503, { ok: false, error: 'aws_desktop_starting', reason: 'desktop_starting' }]);
  });
  it('awsSurfaceAnswers: a gw1-signed GET of code-server\'s /healthz; an edge 502, a throw or a hang is not up', async () => {
    const h = fakeHost({ codeUp: true });
    expect(await awsSurfaceAnswers(record(), ZONE, 'code', h.fetch, () => NOW)).toBe(true);
    expect(h.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /__p/8443/healthz']);
    expect(h.bad).toEqual([]);
    h.st.codeUp = false;
    expect(await awsSurfaceAnswers(record(), ZONE, 'code', h.fetch, () => NOW)).toBe(false);
    expect(await awsSurfaceAnswers(record(), ZONE, 'code', async () => { throw new Error('reset'); }, () => NOW)).toBe(false);
    const hung: FetchLike = (_u, init) => new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    expect(await awsSurfaceAnswers(record(), ZONE, 'code', hung, () => NOW, 25)).toBe(false);
    expect(await awsSurfaceAnswers(record({ controlKey: 'nope' }), ZONE, 'code', h.fetch, () => NOW)).toBe(false);
  });
  it('the surface comes only from the exact signed body values; anything else is the desktop', () => {
    expect(['code', 'app', 'desktop', undefined, 'CODE', 'neko', 1, {}].map(awsPreviewSurface))
      .toEqual(['code', 'app', 'desktop', 'desktop', 'desktop', 'desktop', 'desktop', 'desktop']);
  });
});
