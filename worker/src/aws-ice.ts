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
import { filterBrowserSafeIceServers, type IceServerEntry } from './desktop-mode';
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
  /** The host holds an unexpired config for this epoch. */
  configured: boolean;
  expiresAt: number | null;
  /** runc state of the desktop: running | absent | stopped | created | … */
  desktop: string;
  /** How the running desktop was started: applied (with relay) | missing (timed out) | none. */
  ice: string;
}

/** GW-5 `desktop`: the host's config and desktop state for this epoch. */
export async function readAwsDesktopStatus(
  record: AwsTunnelRecord,
  zone: string,
  fetchFn: FetchLike,
  nowSeconds: number,
): Promise<AwsDesktopStatus> {
  const { host, key } = originFor(record, zone);
  const header = await signGatewayHeader(key, record, 'GET', DESKTOP_STATUS_PATH, nowSeconds);
  let res: Response;
  try {
    res = await fetchFn(`https://${host}${DESKTOP_STATUS_PATH}`, { method: 'GET', headers: { [AWS_GATEWAY_HEADER]: header }, redirect: 'manual' });
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
  };
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

export type RelayMint = (signal: AbortSignal) => Promise<{ servers: IceServerEntry[]; expiresAt: number } | null>;

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

export type AwsDesktopReadiness =
  | { state: 'starting'; reason: 'config_pushed' | 'restart_scheduled' | 'desktop_starting' }
  | { state: 'ready'; relay: RelayState };

/**
 * What an open does for an AWS computer's desktop (mirrors Cloudflare's preview path):
 *   - the host has no usable config for this epoch, or its desktop runs WITHOUT a relay
 *     (it timed out waiting) -> mint once, push, report `starting`;
 *   - the desktop is not running yet -> `starting` (no mint);
 *   - it runs with a relay -> read neko's relay state; renew in place when it expires within
 *     60 s (warm open); report `ready` with the relay state the client renews from.
 * neko still booting (its admin API not answering yet) is `starting`, never an error.
 */
export async function ensureAwsDesktop(p: {
  record: AwsTunnelRecord;
  zone: string;
  fetch: FetchLike;
  nowMs: () => number;
  neko: { user: string; admin: string };
  mint: RelayMint;
  budgetMs?: number;
}): Promise<AwsDesktopReadiness> {
  const nowS = () => Math.floor(p.nowMs() / 1000);
  const status = await readAwsDesktopStatus(p.record, p.zone, p.fetch, nowS());
  const running = status.desktop === 'running';
  const fresh = status.configured && status.expiresAt !== null && status.expiresAt > p.nowMs() + RELAY_MIN_AHEAD_MS;
  if ((!running && !fresh) || (running && status.ice !== 'applied')) {
    const minted = await p.mint(AbortSignal.timeout(20_000));
    if (!minted) throw new RelayFailure('turn_unavailable');
    const config = buildAwsDesktopConfig(minted.servers, minted.expiresAt, p.neko, p.nowMs());
    const res = await pushAwsDesktopConfig(p.record, p.zone, config, p.fetch, nowS());
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* an unreadable answer is a failed push */
    }
    if (!res.ok || body.ok !== true) {
      throw new RelayFailure(typeof body.error === 'string' && /^[a-z_]{1,64}$/.test(body.error) ? body.error : 'aws_desktop_config_refused', 502);
    }
    return { state: 'starting', reason: body.state === 'restart_scheduled' ? 'restart_scheduled' : 'config_pushed' };
  }
  if (!running) return { state: 'starting', reason: 'desktop_starting' };
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
