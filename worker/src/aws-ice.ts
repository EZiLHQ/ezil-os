/**
 * AWS computers: the WebRTC relay for the streamed desktop (neko) on an AWS host.
 *
 * An AWS host has NO inbound security-group rule, so the only working media path is a TURN
 * relay over outbound TCP/TLS. On Cloudflare the Worker mints ephemeral Cloudflare Realtime
 * TURN credentials and hands them to neko as process env at container start
 * (`buildNekoIceEnv`), then renews them in place through neko's admin `/api/relay`
 * (`relayOperation`). This module does the same for an AWS host, over the gateway:
 *
 *   1. Desktop config push (GW-5 `ice`). Before the desktop starts, the Worker pushes one
 *      per-epoch config to the host: the relay-only ICE server sets, their expiry, and the
 *      sandbox's DERIVED neko credentials (`deriveNekoCredentials`, the same values the app
 *      mirrors, so the app's neko login and the Worker's relay renewal both work). The body
 *      is not covered by the gw1 path signature, so its sha256 travels IN the signed path:
 *      `POST /__ezil/control/ice/<sha256hex(body)>`; the host edge refuses a body whose
 *      digest differs. The host keeps the config only in its tmpfs runDir (never on the data
 *      volume) and puts it into the desktop's env exactly as Cloudflare does.
 *   2. Status (GW-5 `desktop`). `GET /__ezil/control/desktop` says whether the host has a
 *      config for this epoch and whether the desktop runs with it, so an open mints TURN
 *      credentials only when the host actually needs them.
 *   3. Renewal. `relayOperation` unchanged, through a transport that signs every neko call
 *      with gw1 and sends it to `/__p/8181/...` on the computer's origin.
 *
 * Relay only: the BACKEND (the host's own candidate gathering) gets TURN URLs only, so the
 * host never gathers server-reflexive candidates; the FRONTEND (the browser) keeps the
 * browser-safe set, like Cloudflare. Credentials are never logged, never put in an error,
 * and never returned to a caller of this module except inside the pushed body.
 */
import { CODE_PREVIEW_PORT, filterBrowserSafeIceServers, type IceServerEntry } from './desktop-mode';
import { relayOperation, RelayFailure, type RelayState } from './relay-refresh';
import {
  AWS_DESKTOP_PORT,
  AWS_GATEWAY_HEADER,
  awsOriginHostname,
  decodeControlKey,
  signGatewayHeader,
  type AwsTunnelRecord,
  type FetchLike,
} from './aws-origin';

export const AWS_DESKTOP_CONFIG_VERSION = 1;
/** neko's `/api/relay` accepts an expiry more than 60 s and at most 30 min ahead (relay.go). */
export const RELAY_MIN_AHEAD_MS = 60_000;
export const RELAY_MAX_AHEAD_MS = 1_800_000;
/** Renew when the running relay expires within this window (the Cloudflare warm-open rule). */
export const RELAY_RENEW_WITHIN_MS = 60_000;
export const ICE_CONTROL_PREFIX = '/__ezil/control/ice/';
export const DESKTOP_STATUS_PATH = '/__ezil/control/desktop';
/** The host refuses a bigger body; a Cloudflare TURN answer is ~1 KiB. */
export const MAX_DESKTOP_CONFIG_BYTES = 16_384;
/** The host answers its status from the agent within seconds; a hung edge or tunnel must not hold the open. */
export const AWS_DESKTOP_STATUS_TIMEOUT_MS = 8_000;
/** code-server's own liveness route (it runs with `--auth none` behind the gateway). */
export const CODE_HEALTH_PATH = '/healthz';
/** A Code open asks again within seconds; one probe must not hold it. */
export const AWS_SURFACE_PROBE_TIMEOUT_MS = 5_000;
/**
 * How long a config pushed to a RUNNING desktop may stay unapplied. The host applies it only by
 * restarting the desktop (agent.py `_accept_relay`), on its next tick (30 s, config.py `idle`),
 * through the unit's stop (TimeoutStopSec=90) and the desktop step that rebuilds the spec.
 * Inside the shell's 215 s wake deadline, so the open that waited receives the coded failure.
 */
export const AWS_DESKTOP_CONFIG_APPLY_MS = 150_000;
const MAX_SERVERS = 8;
const MAX_URLS = 8;
const NEKO_VALUE = /^[0-9a-f]{32}$/;
const ICE_URL = /^(turns?|stun):[\x21-\x7e]{1,255}$/;
const CREDENTIAL = /^[\x20-\x7e]{1,512}$/;

export interface AwsIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface AwsDesktopConfig {
  v: 1;
  /** Unix ms; becomes neko's initial `EZIL_RELAY_EXPIRES_AT`. */
  expiresAt: number;
  /** What the browser gets (browser-safe; may include STUN). */
  frontend: AwsIceServer[];
  /** What the host's neko gathers with: TURN only (relay-only). */
  backend: AwsIceServer[];
  /** The sandbox's derived neko credentials (32 hex each). */
  neko: { user: string; admin: string };
  /** Body-bound signed control delivery; no user JWT ever enters the host. */
  ai?: { baseUrl: string; proxyToken: string };
}

const isTurn = (u: string) => u.startsWith('turn:') || u.startsWith('turns:');

function asUrls(s: IceServerEntry): string[] {
  return (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u): u is string => typeof u === 'string');
}

/** One entry, normalized; throws when a URL or credential could not be a valid ICE server. */
function normalizeEntry(s: IceServerEntry, keep: (u: string) => boolean): AwsIceServer | null {
  const urls = asUrls(s).filter(keep);
  if (urls.length === 0) return null;
  if (urls.length > MAX_URLS || !urls.every((u) => ICE_URL.test(u))) throw new RelayFailure('turn_unavailable');
  if (!urls.some(isTurn)) return { urls };
  if (typeof s.username !== 'string' || typeof s.credential !== 'string'
      || !CREDENTIAL.test(s.username) || !CREDENTIAL.test(s.credential)) {
    throw new RelayFailure('turn_unavailable');
  }
  return { urls, username: s.username, credential: s.credential };
}

function normalizeSet(servers: IceServerEntry[], keep: (u: string) => boolean): AwsIceServer[] {
  const out = servers.map((s) => normalizeEntry(s, keep)).filter((s): s is AwsIceServer => s !== null);
  if (out.length === 0 || out.length > MAX_SERVERS || !out.some((s) => s.urls.some(isTurn))) {
    throw new RelayFailure('turn_unavailable');
  }
  return out;
}

/**
 * The per-epoch desktop config from freshly minted ICE servers. Fails closed (`turn_unavailable`)
 * unless both sets carry an authenticated TURN relay, and refuses the keyless local-dev neko
 * defaults (`neko`/`admin`): an AWS computer is never started with credentials anyone knows.
 */
export function buildAwsDesktopConfig(
  servers: IceServerEntry[],
  expiresAt: number,
  neko: { user: string; admin: string },
  nowMs: number,
): AwsDesktopConfig {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= nowMs + RELAY_MIN_AHEAD_MS || expiresAt > nowMs + RELAY_MAX_AHEAD_MS) {
    throw new RelayFailure('turn_unavailable');
  }
  if (!NEKO_VALUE.test(neko.user) || !NEKO_VALUE.test(neko.admin) || neko.user === neko.admin) {
    throw new RelayFailure('neko_credentials_unavailable');
  }
  const safe = filterBrowserSafeIceServers(servers);
  return {
    v: AWS_DESKTOP_CONFIG_VERSION,
    expiresAt,
    frontend: normalizeSet(safe.length > 0 ? safe : servers, () => true),
    backend: normalizeSet(servers, isTurn),
    neko: { user: neko.user, admin: neko.admin },
  };
}

/** The exact bytes pushed (fixed key order), so the signed digest is reproducible. */
export function desktopConfigBody(c: AwsDesktopConfig): string {
  const entry = (s: AwsIceServer) =>
    s.username === undefined ? { urls: s.urls } : { urls: s.urls, username: s.username, credential: s.credential };
  return JSON.stringify({
    v: c.v,
    expiresAt: c.expiresAt,
    frontend: c.frontend.map(entry),
    backend: c.backend.map(entry),
    neko: { user: c.neko.user, admin: c.neko.admin },
    ...(c.ai ? { ai: c.ai } : {}),
  });
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function originFor(record: AwsTunnelRecord, zone: string): { host: string; key: Uint8Array } {
  const key = decodeControlKey(record.controlKey);
  if (!key) throw new RelayFailure('aws_origin_unavailable');
  let host: string;
  try {
    host = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone);
  } catch {
    throw new RelayFailure('aws_origin_unavailable');
  }
  return { host, key };
}

/** GW-5 `ice`: push the config; the body's sha256 is in the signed path. */
export async function pushAwsDesktopConfig(
  record: AwsTunnelRecord,
  zone: string,
  config: AwsDesktopConfig,
  fetchFn: FetchLike,
  nowSeconds: number,
): Promise<Response> {
  const { host, key } = originFor(record, zone);
  const body = desktopConfigBody(config);
  if (new TextEncoder().encode(body).length > MAX_DESKTOP_CONFIG_BYTES) throw new RelayFailure('turn_unavailable');
  const path = `${ICE_CONTROL_PREFIX}${await sha256Hex(body)}`;
  const header = await signGatewayHeader(key, record, 'POST', path, nowSeconds);
  return fetchFn(`https://${host}${path}`, {
    method: 'POST',
    headers: { [AWS_GATEWAY_HEADER]: header, 'content-type': 'application/json' },
    body,
    redirect: 'manual',
  });
}

export interface AwsDesktopStatus {
  bootId?: string;
  aiConfigured?: boolean;
  /** The host holds an unexpired config for this epoch. */
  configured: boolean;
  expiresAt: number | null;
  /** runc state of the desktop: running | absent | stopped | created | … */
  desktop: string;
  /** How the running desktop was started: applied (with relay) | missing (timed out) | none. */
  ice: string;
  /**
   * The host's desktop unit (systemd): active | activating | deactivating | reloading | pending
   * (its start still waits) | inactive (it ran and exited) | failed | unknown. Null from a host
   * that does not report it (older AMI): the caller then keeps the old behaviour.
   */
  unit: string | null;
  /** The host restarted its desktop as often as it may within its window. */
  restartsExhausted: boolean;
}

/** A desktop unit nothing will start again on its own: it exited (a crash) or failed. */
export const STALLED_DESKTOP_UNITS: readonly string[] = ['inactive', 'failed'];
const UNIT_STATE = /^[a-z]{1,16}$/;

/** GW-5 `desktop`: the host's config and desktop state for this epoch. A read that outlives `timeoutMs` is unreachable. */
export async function readAwsDesktopStatus(
  record: AwsTunnelRecord,
  zone: string,
  fetchFn: FetchLike,
  nowSeconds: number,
  timeoutMs = AWS_DESKTOP_STATUS_TIMEOUT_MS,
): Promise<AwsDesktopStatus> {
  const { host, key } = originFor(record, zone);
  const header = await signGatewayHeader(key, record, 'GET', DESKTOP_STATUS_PATH, nowSeconds);
  let res: Response;
  try {
    res = await fetchFn(`https://${host}${DESKTOP_STATUS_PATH}`, { method: 'GET', headers: { [AWS_GATEWAY_HEADER]: header },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new RelayFailure('aws_desktop_unreachable', 503);
  }
  if (!res.ok) throw new RelayFailure('aws_desktop_unreachable', 503);
  let d: Record<string, unknown>;
  try {
    d = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new RelayFailure('aws_desktop_unreachable', 503);
  }
  if (d.ok !== true || typeof d.configured !== 'boolean' || typeof d.desktop !== 'string' || typeof d.ice !== 'string') {
    throw new RelayFailure('aws_desktop_unreachable', 503);
  }
  const exp = d.expiresAt;
  return {
    configured: d.configured,
    expiresAt: typeof exp === 'number' && Number.isSafeInteger(exp) ? exp : null,
    desktop: d.desktop,
    ice: d.ice,
    unit: typeof d.unit === 'string' && UNIT_STATE.test(d.unit) ? d.unit : null,
    restartsExhausted: d.restartsExhausted === true,
    ...(typeof d.bootId === 'string' && /^[0-9a-f-]{36}$/.test(d.bootId) ? { bootId: d.bootId, aiConfigured: d.aiConfigured === true } : {}),
  };
}

/**
 * Whether a Code or hosted-app surface answers on this computer's origin, whatever the desktop
 * (neko, its relay, Chat's AI config) is doing. Code: code-server's own `/healthz` answers a
 * gw1-signed GET on `/__p/8443/healthz` (the host edge answers 502 `desktop_unreachable` while
 * nothing listens). The hosted app: the desktop container runs; its dev server is the user's,
 * so one that is absent is normal and the app's own page says so. Any failure is "not yet".
 */
export async function awsSurfaceAnswers(
  record: AwsTunnelRecord,
  zone: string,
  surface: 'code' | 'app',
  fetchFn: FetchLike,
  nowMs: () => number,
  timeoutMs = AWS_SURFACE_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const nowSeconds = Math.floor(nowMs() / 1000);
    if (surface === 'app') return (await readAwsDesktopStatus(record, zone, fetchFn, nowSeconds, timeoutMs)).desktop === 'running';
    const { host, key } = originFor(record, zone);
    const path = `/__p/${CODE_PREVIEW_PORT}${CODE_HEALTH_PATH}`;
    const header = await signGatewayHeader(key, record, 'GET', path, nowSeconds);
    const res = await fetchFn(`https://${host}${path}`, { method: 'GET', headers: { [AWS_GATEWAY_HEADER]: header },
      redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * `relayOperation`'s container transport for an AWS computer: each neko admin call to
 * `http://127.0.0.1:8181<path>` becomes a gw1-signed request to `/__p/8181<path>` on the
 * computer's origin. Only the desktop port; anything else is refused before any fetch.
 */
export function awsRelayContainer(record: AwsTunnelRecord, zone: string, fetchFn: FetchLike, nowSeconds: () => number) {
  const { host, key } = originFor(record, zone);
  return {
    async containerFetch(url: string, init: RequestInit = {}, port?: number): Promise<Response> {
      const u = new URL(url);
      if ((port !== undefined && port !== AWS_DESKTOP_PORT) || u.hostname !== '127.0.0.1' || Number(u.port) !== AWS_DESKTOP_PORT) {
        throw new RelayFailure('relay_unavailable');
      }
      const method = (init.method ?? 'GET').toUpperCase();
      const path = `/__p/${AWS_DESKTOP_PORT}${u.pathname}`;
      const headers = new Headers(init.headers);
      headers.delete(AWS_GATEWAY_HEADER);
      headers.set(AWS_GATEWAY_HEADER, await signGatewayHeader(key, record, method, path, nowSeconds()));
      return fetchFn(`https://${host}${path}${u.search}`, { ...init, method, headers, redirect: 'manual' });
    },
  };
}

/** What the screen routes need from a desktop: reachability and neko's admin API on its port. */
export interface ScreenDesktop {
  desktopReachable(): Promise<boolean>;
  runningContainerFetch(url: string, init: RequestInit, port: number): Promise<Response>;
}

/**
 * The screen routes' desktop for an AWS computer: neko's admin API on the desktop port
 * through the gateway (`awsRelayContainer`), and reachable only while the host reports its
 * desktop `running` (GW-5 `desktop`). Any other port is refused before a fetch.
 */
export function awsScreenDesktop(record: AwsTunnelRecord, zone: string, fetchFn: FetchLike, nowMs: () => number): ScreenDesktop {
  const nowSeconds = () => Math.floor(nowMs() / 1000);
  const container = awsRelayContainer(record, zone, fetchFn, nowSeconds);
  return {
    async desktopReachable() {
      try {
        return (await readAwsDesktopStatus(record, zone, fetchFn, nowSeconds())).desktop === 'running';
      } catch {
        return false;
      }
    },
    runningContainerFetch: (url, init, port) => container.containerFetch(url, init, port),
  };
}

/** Boot and renewal both use a clock-margined expiry accepted by the host. */
export type RelayMint = (signal: AbortSignal, purpose?: 'boot' | 'renewal') => Promise<{ servers: IceServerEntry[]; expiresAt: number } | null>;

/** Cloudflare's `relayRefresh`, for an AWS computer: read the relay state, or renew it in place. */
export async function awsRelayRefresh(p: {
  record: AwsTunnelRecord;
  zone: string;
  fetch: FetchLike;
  nowMs: () => number;
  admin: string;
  runtimeId?: string;
  mint?: RelayMint;
  budgetMs?: number;
}): Promise<RelayState> {
  const container = awsRelayContainer(p.record, p.zone, p.fetch, () => Math.floor(p.nowMs() / 1000));
  const mint = p.mint;
  return relayOperation(container, p.admin, {
    runtimeId: p.runtimeId,
    budgetMs: p.budgetMs,
    // Preserve the boot contract on every renewal, including mixed STUN/TURN
    // entries. normalizeSet also refuses a missing authenticated TURN server.
    backendIceServers: (servers) => normalizeSet(servers, isTurn),
    ...(p.runtimeId && mint
      ? {
          mint: async (signal: AbortSignal) => {
            const minted = await mint(signal);
            if (!minted) throw new RelayFailure('turn_unavailable');
            return minted;
          },
        }
      : {}),
  });
}

export type AwsDesktopStarting = {
  state: 'starting';
  reason: 'config_pushed' | 'restart_scheduled' | 'desktop_starting' | 'config_pending';
};
/** The config half alone: `applied` = the desktop runs with this epoch's config. */
export type AwsDesktopConfigReadiness = AwsDesktopStarting | { state: 'applied' };
export type AwsDesktopReadiness = AwsDesktopStarting | { state: 'ready'; relay: RelayState };

export interface AwsDesktopParams {
  record: AwsTunnelRecord;
  zone: string;
  fetch: FetchLike;
  nowMs: () => number;
  neko: { user: string; admin: string };
  mint: RelayMint;
  aiConfig?: (bootId: string) => Promise<NonNullable<AwsDesktopConfig['ai']>>;
  /**
   * Records, on the tunnel record, a push to the RUNNING desktop of this host boot. The next
   * asks read it back (`record.restartPushBootId`/`restartPushAt`) and wait instead of pushing.
   */
  restartPush?: (bootId: string) => Promise<void>;
  budgetMs?: number;
}

/** Mint once and push this epoch's config (with Chat's AI config when the host reports its boot). */
async function pushDesktopConfig(p: AwsDesktopParams, status: AwsDesktopStatus): Promise<AwsDesktopStarting> {
  const minted = await p.mint(AbortSignal.timeout(20_000), 'boot');
  if (!minted) throw new RelayFailure('turn_unavailable');
  const config = buildAwsDesktopConfig(minted.servers, minted.expiresAt, p.neko, p.nowMs());
  if (p.aiConfig && status.bootId) config.ai = await p.aiConfig(status.bootId);
  const res = await pushAwsDesktopConfig(p.record, p.zone, config, p.fetch, Math.floor(p.nowMs() / 1000));
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* an unreadable answer is a failed push */
  }
  if (!res.ok || body.ok !== true) {
    if (body.error === 'desktop_restart_exhausted') throw new RelayFailure('aws_desktop_failed', 502);
    throw new RelayFailure(typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'aws_desktop_config_refused', 502);
  }
  return { state: 'starting', reason: body.state === 'restart_scheduled' ? 'restart_scheduled' : 'config_pushed' };
}

/**
 * The config half of an open (no relay; the Code and app surfaces use it alone):
 *   - the host has no usable config for this epoch while its desktop is down, or the desktop is
 *     not running and its unit exited or failed (a crash: nothing would start it) -> mint once,
 *     push, report `starting` (the host restarts it);
 *   - the RUNNING desktop lacks the pushed config (it started without a relay, or without Chat's
 *     AI env) -> the host can apply a config only by restarting the desktop, and every push
 *     re-arms that restart (agent.py `_accept_relay`): on 10-30 a push on every ~2 s ask kept a
 *     computer's desktop restarting and its Code waiting ~2 min. So push ONCE per host boot and
 *     record it (`restartPush`); later asks answer `config_pending` with no mint and no push,
 *     and a push still unapplied after AWS_DESKTOP_CONFIG_APPLY_MS fails with
 *     `aws_desktop_config_unapplied`, never an endless `starting`. A host that reports no boot
 *     id (an older AMI) keeps the push on every ask;
 *   - the desktop is not running yet and holds a fresh config: `starting` (no mint).
 *     `config_pending` when the AI config still waits for it (this boot's Chat nonce is minted,
 *     so the held config carries it and the desktop step applies it on start);
 *   - the host's desktop restarts are exhausted -> `aws_desktop_failed` (a clear failure,
 *     never an endless `starting`); a push the host refuses for that reason fails the same way.
 */
export async function ensureAwsDesktopConfig(p: AwsDesktopParams): Promise<AwsDesktopConfigReadiness> {
  const status = await readAwsDesktopStatus(p.record, p.zone, p.fetch, Math.floor(p.nowMs() / 1000));
  const running = status.desktop === 'running';
  if (!running && status.restartsExhausted) throw new RelayFailure('aws_desktop_failed', 502);
  const now = p.nowMs();
  const fresh = status.configured && status.expiresAt !== null && status.expiresAt > now + RELAY_MIN_AHEAD_MS;
  const stalled = !running && status.unit !== null && STALLED_DESKTOP_UNITS.includes(status.unit);
  const needsAi = !!(p.aiConfig && status.bootId && !status.aiConfigured);
  if (!running && (!fresh || stalled)) return pushDesktopConfig(p, status);
  if (running && (status.ice !== 'applied' || needsAi)) {
    const boot = status.bootId;
    if (!boot || !p.restartPush) return pushDesktopConfig(p, status);
    const { restartPushBootId, restartPushAt } = p.record;
    if (restartPushBootId === boot && typeof restartPushAt === 'number') {
      if (now - restartPushAt >= AWS_DESKTOP_CONFIG_APPLY_MS) throw new RelayFailure('aws_desktop_config_unapplied', 502);
      return { state: 'starting', reason: 'config_pending' };
    }
    const pushed = await pushDesktopConfig(p, status);
    // A lost record costs at most another push on the next ask (today's behaviour), never this open.
    await p.restartPush(boot).catch(() => undefined);
    return pushed;
  }
  if (!running) {
    if (!needsAi) return { state: 'starting', reason: 'desktop_starting' };
    return p.record.aiBootId === status.bootId ? { state: 'starting', reason: 'config_pending' } : pushDesktopConfig(p, status);
  }
  return { state: 'applied' };
}

/**
 * What an open does for an AWS computer's desktop (mirrors Cloudflare's preview path): the
 * config half (`ensureAwsDesktopConfig`), then, once the desktop runs with it, read neko's relay
 * state; renew in place when it expires within 60 s (warm open); report `ready` with the relay
 * state the client renews from. neko still booting (its admin API not answering yet) is
 * `starting`, never an error.
 */
export async function ensureAwsDesktop(p: AwsDesktopParams): Promise<AwsDesktopReadiness> {
  const config = await ensureAwsDesktopConfig(p);
  if (config.state !== 'applied') return config;
  try {
    let relay = await awsRelayRefresh({ record: p.record, zone: p.zone, fetch: p.fetch, nowMs: p.nowMs, admin: p.neko.admin, budgetMs: p.budgetMs });
    if (relay.expiresAt <= p.nowMs() + RELAY_RENEW_WITHIN_MS) {
      relay = await awsRelayRefresh({
        record: p.record, zone: p.zone, fetch: p.fetch, nowMs: p.nowMs, admin: p.neko.admin,
        runtimeId: relay.runtimeId, mint: p.mint, budgetMs: p.budgetMs,
      });
    }
    return { state: 'ready', relay };
  } catch (error) {
    if (error instanceof RelayFailure && ['relay_login_failed', 'relay_unavailable'].includes(error.code)) {
      return { state: 'starting', reason: 'desktop_starting' };
    }
    throw error;
  }
}
