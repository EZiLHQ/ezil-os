/**
 * AWS computers: the Worker side of the gateway to an AWS host.
 *
 * Built to GATEWAY-CONTRACT-v1 (reports/2026-10-14-aws-azure-first-lead/):
 *   GW-2  every request proxied to an `aws-ec2` origin carries
 *         `x-ezil-gw: gw1.<ts>.<hex>` = HMAC-SHA256(controlKey, "gw1|ts|computerId|
 *         generation|leaseEpoch|METHOD|path"); a client-supplied `x-ezil-gw` is stripped.
 *   GW-4  `provider: "aws-ec2"` routes to `c-<sandboxId>-g<generation>-e<leaseEpoch>.<zone>`,
 *         the zone from a Worker-side allowlist only; everything unknown fails closed with
 *         502 `aws_origin_unavailable`. Cloudflare routing does not pass through this module.
 *
 * Browser traffic reaches an AWS computer on `aws-<port>-<sandboxId>-aws.<preview zone>`. The
 * leading letters keep the SDK's `<port>-<id>-<token>` preview parser and the bridge
 * parser (`<port>-<id>-app|code`) from ever matching it. The fixed `-aws` suffix lets one
 * narrow route (`*-aws.<zone>/*`, wrangler.toml) claim these hosts: Cloudflare route
 * wildcards may only lead, and without a fixed suffix the zone's `*.<zone>/*` catch-all
 * (another Worker) would answer them. The browser authenticates with
 * the same sandbox-bound bootstrap token → `ezil_preview` cookie as the Cloudflare
 * bridges, but FAIL CLOSED: no configured secret means 401, never the local-dev bypass.
 *
 * The container port travels in the SIGNED path (`/__p/<port><path>`), so the host edge
 * forwards only to a port the Worker chose from `AWS_EDGE_PORTS`, and the contract's
 * path-only signature still covers it.
 */
import type { AwsDesktopConfigReadiness, AwsDesktopReadiness } from './aws-ice';
import { APP_PREVIEW_PORT, CODE_PREVIEW_PORT, portFor } from './desktop-mode';
import { relayFailureResult, type RelayState } from './relay-refresh';
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_COOKIE_TTL_S,
  deriveNekoCredentials,
  mintPreviewBootstrapToken,
  mintPreviewCookie,
  timingSafeEqualHex,
  verifyPreviewBootstrapToken,
  verifyPreviewCookie,
  type PreviewTokenV2Claims,
} from './hmac';

export const AWS_GATEWAY_HEADER = 'x-ezil-gw';
export const AWS_GATEWAY_SKEW = { pastSeconds: 120, futureSeconds: 5 } as const;
export const AWS_DESKTOP_PORT = portFor('neko').port;
/** The container ports the Cloudflare route exposes: neko desktop, guacamole, app preview, code-server. */
export const AWS_EDGE_PORTS: readonly number[] = [AWS_DESKTOP_PORT, portFor('guacamole').port, APP_PREVIEW_PORT, CODE_PREVIEW_PORT];
export const AWS_EDGE_PORT_DEFAULT = 18080;
/** How long the bootstrap-minted browser URLs are good for (the cookie TTL). */
export const AWS_PREVIEW_TTL_MS = PREVIEW_COOKIE_TTL_S * 1000;
/** Maximum age of a successful connector-origin check. */
export const AWS_ORIGIN_VERIFY_TTL_MS = 60_000;

const COMPUTER_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** `deriveSandboxId` output for a lowercase user and computer id; anything else is unroutable (DNS is case-folding). */
const SANDBOX_ID = /^guac-[a-z0-9]{1,16}-[a-z0-9]{1,16}$/;
const METHOD = /^[A-Z]{1,16}$/;
const PATH = /^\/[\x21-\x7e]{0,2047}$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROL_OPS = ['stop', 'fence', 'restart-desktop'] as const;
export type AwsControlOp = (typeof CONTROL_OPS)[number];

/** The Worker's durable record of one computer's current tunnel epoch (GW-1). */
export interface AwsTunnelRecord {
  computerId: string;
  sandboxId: string;
  generation: number;
  leaseEpoch: number;
  instanceId: string;
  region: string;
  publicIp: string;
  tunnelId: string;
  dnsRecordId: string;
  hostname: string;
  /** base64 of exactly 32 bytes; never logged or returned. */
  controlKey: string;
  createdAt: number;
  /** Whether a connector-origin check has succeeded (C-6 step 5). */
  originVerified: boolean;
  /** Check time in milliseconds; legacy records without it must be rechecked. */
  originVerifiedAt?: number;
  /** Worker-generated AI nonce, rotated when the trusted host reports a new boot. */
  aiProxyNonce?: string;
  aiBootId?: string;
  /**
   * The host boot whose RUNNING desktop was last pushed a config, that config's expiry (which
   * identifies it in the host's status; absent while the claiming ask still pushes it) and when
   * (ms). The host applies it only by restarting the desktop, so later asks wait for that
   * instead of pushing again (aws-ice.ts `ensureAwsDesktopConfig`, aws-tunnels.ts `restartPush`).
   */
  restartPushBootId?: string;
  restartPushExpiresAt?: number;
  restartPushAt?: number;
}

export function isAwsOriginFresh(record: AwsTunnelRecord, nowMs: number): boolean {
  return record.originVerified && typeof record.originVerifiedAt === 'number'
    && record.originVerifiedAt <= nowMs
    && nowMs - record.originVerifiedAt < AWS_ORIGIN_VERIFY_TTL_MS;
}

export interface GatewayBinding {
  computerId: string;
  generation: number;
  leaseEpoch: number;
}

export function isComputerId(v: unknown): v is string {
  return typeof v === 'string' && COMPUTER_ID.test(v);
}

export function isRoutableSandboxId(v: unknown): v is string {
  return typeof v === 'string' && SANDBOX_ID.test(v);
}

function isEpoch(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

export function awsRoutingEnabled(value: string | undefined): boolean {
  return /^(1|true|on|yes)$/i.test((value ?? '').trim());
}

function validZoneName(zone: string): boolean {
  return zone.length <= 253 && zone.split('.').length >= 2 && zone.split('.').every((l) => DNS_LABEL.test(l));
}

/**
 * The origin zone: `AWS_ORIGIN_ZONE`, and only if it is also listed in
 * `AWS_ORIGIN_ZONE_ALLOWLIST`. Never derived from a request. `null` = unroutable.
 */
export function resolveAwsOriginZone(env: { AWS_ORIGIN_ZONE?: string; AWS_ORIGIN_ZONE_ALLOWLIST?: string }): string | null {
  const zone = (env.AWS_ORIGIN_ZONE ?? '').trim().toLowerCase();
  if (!zone || !validZoneName(zone)) return null;
  const allow = (env.AWS_ORIGIN_ZONE_ALLOWLIST ?? '')
    .split(',')
    .map((z) => z.trim().toLowerCase())
    .filter((z) => z && validZoneName(z));
  return allow.includes(zone) ? zone : null;
}

/** `c-<sandboxId>-g<generation>-e<leaseEpoch>.<zone>`; throws on anything that is not a clean DNS name. */
export function awsOriginHostname(sandboxId: string, generation: number, leaseEpoch: number, zone: string): string {
  if (!isRoutableSandboxId(sandboxId) || !isEpoch(generation) || !isEpoch(leaseEpoch) || !validZoneName(zone)) {
    throw new Error('aws_origin_unroutable');
  }
  const label = `c-${sandboxId}-g${generation}-e${leaseEpoch}`;
  if (!DNS_LABEL.test(label)) throw new Error('aws_origin_unroutable');
  return `${label}.${zone}`;
}

/** The canonical gw1 signed string. Throws on a field that could break the framing. */
export function gatewayPayload(b: GatewayBinding, ts: number, method: string, path: string): string {
  if (!isComputerId(b.computerId) || !isEpoch(b.generation) || !isEpoch(b.leaseEpoch)) throw new Error('gw_invalid_binding');
  if (!Number.isSafeInteger(ts) || ts <= 0) throw new Error('gw_invalid_ts');
  if (!METHOD.test(method) || !PATH.test(path) || path.includes('|')) throw new Error('gw_invalid_request');
  return ['gw1', ts, b.computerId, b.generation, b.leaseEpoch, method, path].join('|');
}

export function decodeControlKey(b64: unknown): Uint8Array | null {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(b64)) return null;
  try {
    const bin = atob(b64);
    const key = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

async function hmacHex(key: Uint8Array, payload: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new Uint8Array(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(payload)));
  return [...sig].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function signGatewayHeader(
  controlKey: Uint8Array,
  b: GatewayBinding,
  method: string,
  path: string,
  nowSeconds: number,
): Promise<string> {
  const ts = Math.floor(nowSeconds);
  return `gw1.${ts}.${await hmacHex(controlKey, gatewayPayload(b, ts, method, path))}`;
}

/** The host's check, mirrored here so both sides are held to the shared vectors. */
export async function verifyGatewayHeader(
  header: string | null,
  controlKey: Uint8Array,
  b: GatewayBinding,
  method: string,
  path: string,
  nowSeconds: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const m = /^gw1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return { ok: false, error: header ? 'gw_malformed' : 'gw_missing' };
  const ts = Number(m[1]);
  if (ts < nowSeconds - AWS_GATEWAY_SKEW.pastSeconds || ts > nowSeconds + AWS_GATEWAY_SKEW.futureSeconds) {
    return { ok: false, error: 'gw_stale' };
  }
  let payload: string;
  try {
    payload = gatewayPayload(b, ts, method, path);
  } catch {
    return { ok: false, error: 'gw_invalid_request' };
  }
  return timingSafeEqualHex(await hmacHex(controlKey, payload), m[2]!) ? { ok: true } : { ok: false, error: 'gw_bad_mac' };
}

/** The route token: browser hosts end in `-aws.<zoneRoot>` (wrangler.toml `*-aws.<zone>/*`). */
export const AWS_BROWSER_ROUTE_TOKEN = 'aws';

/** `aws-<port>-<sandboxId>-aws.<zoneRoot>` → its parts, or null for every other hostname. */
export function parseAwsBrowserHost(hostname: string, zoneRoot: string): { port: number; sandboxId: string } | null {
  const host = hostname.toLowerCase();
  const suffix = `.${zoneRoot.toLowerCase()}`;
  if (!zoneRoot || !host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  const m = /^aws-(\d{4,5})-(guac-[a-z0-9]{1,16}-[a-z0-9]{1,16})-aws$/.exec(label);
  if (!m) return null;
  const port = Number(m[1]);
  return AWS_EDGE_PORTS.includes(port) ? { port, sandboxId: m[2]! } : null;
}

export function awsBrowserUrl(port: number, sandboxId: string, zoneRoot: string, bootstrapToken: string, path = '/'): string {
  const u = new URL(`https://aws-${port}-${sandboxId}-${AWS_BROWSER_ROUTE_TOKEN}.${zoneRoot}/preview-bootstrap`);
  u.searchParams.set('token', bootstrapToken);
  u.searchParams.set('path', path);
  return u.toString();
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const unavailable = (): Response => json({ ok: false, error: 'aws_origin_unavailable' }, 502);

function readCookie(header: string | null, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Drop our own preview cookie from a forwarded Cookie header; keep the desktop apps' cookies. */
function stripPreviewCookie(header: string | null): string | null {
  if (!header) return null;
  const kept = header
    .split(';')
    .map((p) => p.trim())
    .filter((p) => p && p.slice(0, p.indexOf('=') < 0 ? p.length : p.indexOf('=')).trim() !== PREVIEW_COOKIE_NAME);
  return kept.length ? kept.join('; ') : null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Forward one browser request to the computer's origin through its tunnel, signed with
 * gw1 over `/__p/<port><pathname>`. WebSocket upgrades ride the same fetch (the Upgrade
 * header is forwarded and the 101 response is returned as is).
 */
export async function proxyToAwsOrigin(
  request: Request,
  url: URL,
  record: AwsTunnelRecord,
  zone: string,
  port: number,
  fetchFn: FetchLike,
  nowSeconds: number,
): Promise<Response> {
  const key = decodeControlKey(record.controlKey);
  if (!key || !AWS_EDGE_PORTS.includes(port)) return unavailable();
  let host: string;
  let signed: string;
  const method = request.method.toUpperCase();
  const originPath = `/__p/${port}${url.pathname}`;
  try {
    host = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone);
    signed = await signGatewayHeader(key, record, method, originPath, nowSeconds);
  } catch {
    return unavailable();
  }
  const headers = new Headers(request.headers);
  headers.delete(AWS_GATEWAY_HEADER);
  headers.delete('x-ezil-auth');
  headers.delete('host');
  headers.delete('x-forwarded-proto');
  headers.delete('forwarded');
  // code-server checks Origin against the authenticated browser hostname.
  headers.set('x-forwarded-host', url.hostname);
  const cookie = stripPreviewCookie(request.headers.get('cookie'));
  if (cookie === null) headers.delete('cookie');
  else headers.set('cookie', cookie);
  headers.set(AWS_GATEWAY_HEADER, signed);
  const init: RequestInit = { method, headers, redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') init.body = request.body;
  return fetchFn(`https://${host}${originPath}${url.search}`, init);
}

export interface AwsBrowserDeps {
  routingEnabled: boolean;
  zone: string | null;
  /** The primary preview secret only; empty = fail closed. */
  secrets: string[];
  zoneRoot: string;
  /** The registry rechecks expired verified records before returning them. */
  lookup: (sandboxId: string) => Promise<AwsTunnelRecord | null>;
  fetch: FetchLike;
  nowMs: () => number;
}

/**
 * Browser traffic for `aws-<port>-<sandboxId>.<zoneRoot>`. Returns null for any other
 * hostname so the caller's existing dispatch runs unchanged.
 */
export async function handleAwsBrowserHost(request: Request, url: URL, deps: AwsBrowserDeps): Promise<Response | null> {
  const route = parseAwsBrowserHost(url.hostname, deps.zoneRoot);
  if (!route) return null;
  if (!deps.routingEnabled) return json({ ok: false, error: 'aws_routing_disabled' }, 404);
  const secrets = deps.secrets.filter((s) => s && s.trim());
  if (secrets.length === 0) return json({ ok: false, error: 'hmac_secret_not_configured' }, 401);
  const { port, sandboxId } = route;

  if (request.method === 'GET' && url.pathname === '/preview-bootstrap') {
    const auth = await verifyPreviewBootstrapToken(url.searchParams.get('token') ?? undefined, secrets, sandboxId);
    if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
    // Same-origin only: a `//host` or absolute `path` must not become an open redirect.
    const raw = url.searchParams.get('path') || '/';
    const dest = new URL(raw.startsWith('/') && !raw.startsWith('//') ? raw : '/', url);
    if (dest.origin !== url.origin) return json({ ok: false, error: 'invalid_redirect' }, 400);
    const cookie = await mintPreviewCookie(secrets[0], sandboxId, deps.nowMs());
    const attrs = [`${PREVIEW_COOKIE_NAME}=${cookie}`, `Max-Age=${PREVIEW_COOKIE_TTL_S}`, 'HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/'];
    return new Response(null, { status: 302, headers: { location: dest.pathname + dest.search, 'set-cookie': attrs.join('; ') } });
  }

  const cookieOk = await verifyPreviewCookie(readCookie(request.headers.get('cookie'), PREVIEW_COOKIE_NAME), secrets, sandboxId);
  if (!cookieOk) return json({ ok: false, error: 'aws_preview_auth_required' }, 401);
  if (!deps.zone) return unavailable();
  const record = await deps.lookup(sandboxId);
  if (!record || record.sandboxId !== sandboxId || !isAwsOriginFresh(record, deps.nowMs())) return unavailable();
  if (port === AWS_DESKTOP_PORT && request.method === 'GET') {
    // Reuse CF's usr/pwd/embed auto-connect, but keep the real password
    // out of browser URLs, history and client-side WebSocket diagnostics.
    const placeholder = 'ezil-preview';
    const upgrade = request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if (!upgrade && (url.pathname === '/' || url.pathname === '/index.html')) {
      const dest = new URL(url);
      dest.searchParams.set('usr', 'EZiL');
      dest.searchParams.set('pwd', placeholder);
      dest.searchParams.set('embed', '1');
      if (dest.search !== url.search) {
        return new Response(null, { status: 302, headers: {
          location: dest.pathname + dest.search,
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
        } });
      }
    }
    if (upgrade && url.searchParams.get('password') === placeholder) {
      // The cookie above authorizes this login; the placeholder is not a credential.
      try {
        const { user } = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: secrets[0] }, sandboxId);
        const upstream = new URL(url);
        upstream.searchParams.set('password', user);
        upstream.searchParams.set('username', 'EZiL');
        return await proxyToAwsOrigin(request, upstream, record, deps.zone, port, deps.fetch, Math.floor(deps.nowMs() / 1000));
      } catch {
        // A fetch exception may contain its URL: never propagate or log it.
        return unavailable();
      }
    }
  }
  return proxyToAwsOrigin(request, url, record, deps.zone, port, deps.fetch, Math.floor(deps.nowMs() / 1000));
}

/** Which window asks for the preview: the streamed desktop, Code (code-server) or the hosted app. */
export type AwsPreviewSurface = 'desktop' | 'code' | 'app';

/** The `/sandbox/preview` body's `surface` (covered by the v2 body digest); anything but `code`/`app` is the desktop. */
export function awsPreviewSurface(value: unknown): AwsPreviewSurface {
  return value === 'code' || value === 'app' ? value : 'desktop';
}

export interface AwsPreviewDeps {
  zone: string | null;
  secrets: string[];
  zoneRoot: string;
  lookup: (sandboxId: string) => Promise<AwsTunnelRecord | null>;
  /** GW-1's connector check; the registry caches successful checks for a bounded TTL. */
  verifyOrigin: (sandboxId: string) => Promise<'verified' | 'mismatch' | 'not_connected'>;
  /**
   * The desktop's WebRTC relay (`./aws-ice` `ensureAwsDesktop`), once the origin is verified:
   * pushes the per-epoch relay config while the host needs one, renews it in place on a warm
   * open. `starting` answers 503 `aws_desktop_starting` (the client's wake loop retries).
   */
  ensureDesktop?: (record: AwsTunnelRecord) => Promise<AwsDesktopReadiness>;
  /** The asking surface; absent is the desktop (today's app sends none). */
  surface?: AwsPreviewSurface;
  /** Code/app: the desktop config alone, no relay (`./aws-ice` `ensureAwsDesktopConfig`). */
  ensureConfig?: (record: AwsTunnelRecord) => Promise<AwsDesktopConfigReadiness>;
  /** Code: whether code-server answers on the origin (`./aws-ice` `awsCodeServerAnswers`). */
  codeAnswers?: (record: AwsTunnelRecord) => Promise<boolean>;
  nowMs: () => number;
}

/**
 * `POST /sandbox/preview` for a v2 token with `provider: "aws-ec2"` (GW-4): the app's
 * claims must name exactly the stored tunnel epoch; the answer carries browser URLs on
 * the AWS hostnames. The caller has already checked the claims against the body.
 */
export async function handleAwsPreview(claims: PreviewTokenV2Claims, deps: AwsPreviewDeps): Promise<Response> {
  const secrets = deps.secrets.filter((s) => s && s.trim());
  if (claims.provider !== 'aws-ec2' || !deps.zone || !deps.zoneRoot || !isRoutableSandboxId(claims.sandboxId)) return unavailable();
  if (secrets.length === 0) return json({ ok: false, error: 'hmac_secret_not_configured' }, 401);
  const record = await deps.lookup(claims.sandboxId);
  if (
    !record ||
    record.computerId !== claims.computerId ||
    record.sandboxId !== claims.sandboxId ||
    record.generation !== claims.generation ||
    record.leaseEpoch !== claims.leaseEpoch
  ) {
    return unavailable();
  }
  if (!isAwsOriginFresh(record, deps.nowMs())) {
    const verdict = await deps.verifyOrigin(claims.sandboxId);
    if (verdict === 'mismatch') return json({ ok: false, error: 'tunnel_origin_mismatch' }, 502);
    if (verdict !== 'verified') return json({ ok: false, error: 'aws_origin_starting' }, 503);
  }
  let relay: RelayState | undefined;
  const surface = deps.surface ?? 'desktop';
  if (surface !== 'desktop' && deps.ensureConfig && (surface === 'app' || deps.codeAnswers)) {
    // Code and the hosted app run in the desktop's container but never use neko or its relay,
    // so they never wait on those. They do wait for the desktop config to be applied: the host
    // applies a config to a RUNNING desktop only by restarting that container (agent.py
    // `_accept_relay`), code-server and the user's dev server with it, and Chat's AI env reaches
    // code-server's ezil-models extension only that way (desktop.py `build_spec`). An answer
    // before then would hand out a window that the host's next tick tears down.
    let readiness: AwsDesktopConfigReadiness;
    try {
      readiness = await deps.ensureConfig(record);
    } catch (error) {
      const failure = relayFailureResult(error);
      return json({ ok: false, error: failure.error }, failure.status);
    }
    if (readiness.state === 'starting') return json({ ok: false, error: 'aws_desktop_starting', reason: readiness.reason }, 503);
    // Applied: the container runs. The hosted app's dev server is the user's (one that is absent
    // is normal, and the app's own page says so); Code waits for code-server itself.
    if (surface === 'code' && (await deps.codeAnswers?.(record)) !== true) {
      return json({ ok: false, error: 'aws_desktop_starting', reason: 'code_starting' }, 503);
    }
  } else if (deps.ensureDesktop) {
    let readiness: AwsDesktopReadiness;
    try {
      readiness = await deps.ensureDesktop(record);
    } catch (error) {
      // Codes only: a relay failure never carries a credential (relay-refresh.ts).
      const failure = relayFailureResult(error);
      return json({ ok: false, error: failure.error }, failure.status);
    }
    if (readiness.state === 'starting') return json({ ok: false, error: 'aws_desktop_starting', reason: readiness.reason }, 503);
    relay = readiness.relay;
  }
  const now = deps.nowMs();
  const token = await mintPreviewBootstrapToken(secrets[0]!, claims.sandboxId, now);
  const url = (port: number) => awsBrowserUrl(port, claims.sandboxId, deps.zoneRoot, token);
  return json({
    ok: true,
    provider: 'aws-ec2',
    mode: 'neko',
    sandboxId: claims.sandboxId,
    generation: record.generation,
    leaseEpoch: record.leaseEpoch,
    guacamoleUrl: url(AWS_DESKTOP_PORT),
    appPreviewUrl: url(APP_PREVIEW_PORT),
    codePreviewUrl: url(CODE_PREVIEW_PORT),
    expiresAt: now + AWS_PREVIEW_TTL_MS,
    // Like Cloudflare: the relay state the client renews from, and only WHETHER a relay is wired.
    ...(relay ? { relay, turnRelay: true } : {}),
  });
}

/**
 * GW-5 `export` (docs/compute/REVERSE-MOVE-CONTRACT.md §2.2): the export boot's host stages
 * `/workspace` as a v1 snapshot; the reverse import (./workspace-migration-import) starts the job
 * and pulls its status, head and chunks. Same gw1 signer as every other host call, bound to the
 * tunnel record's placement generation and lease epoch.
 */
export const EXPORT_CONTROL_PATH = '/__ezil/control/export';
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The host's chunk-index grammar: decimal, no leading zeros, below the 512-chunk cap. */
const MAX_EXPORT_CHUNKS = 512;

/**
 * The export POST's exact bytes, built ONCE (this key order, no whitespace). The signature covers
 * the path only, so the body's sha256 travels in the signed path and the host compares it with
 * the bytes it read before parsing (§2.2 "Body bytes"): never re-serialize between hash and send.
 */
export function awsExportBody(moveId: string, generation: string): string {
  if (!LOWER_UUID.test(moveId) || !LOWER_UUID.test(generation)) throw new Error('gw_invalid_control_op');
  return JSON.stringify({ v: 1, moveId, generation });
}

async function sha256HexOf(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function exportOrigin(record: AwsTunnelRecord, zone: string): { host: string; key: Uint8Array } {
  const key = decodeControlKey(record.controlKey);
  if (!key) throw new Error('gw_invalid_binding');
  return { host: awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone), key };
}

/** `POST /__ezil/control/export/<sha256hex(body)>`: start (or resume, idempotently) this move's export. */
export async function startAwsExport(
  record: AwsTunnelRecord,
  zone: string,
  moveId: string,
  generation: string,
  fetchFn: FetchLike,
  nowSeconds: number,
  timeoutMs: number,
): Promise<Response> {
  const body = awsExportBody(moveId, generation);
  const { host, key } = exportOrigin(record, zone);
  const path = `${EXPORT_CONTROL_PATH}/${await sha256HexOf(body)}`;
  const header = await signGatewayHeader(key, record, 'POST', path, nowSeconds);
  return fetchFn(`https://${host}${path}`, {
    method: 'POST', headers: { [AWS_GATEWAY_HEADER]: header, 'content-type': 'application/json' }, body,
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
}

/** What the import reads from the host edge: served from disk, never through the agent socket. */
export type AwsExportRead = 'status' | 'head' | { chunk: number };

/** `GET /__ezil/control/export/{status,head,chunk/<i>}`: no body, no query, so the signed path is the whole request. */
export async function readAwsExport(
  record: AwsTunnelRecord,
  zone: string,
  read: AwsExportRead,
  fetchFn: FetchLike,
  nowSeconds: number,
  timeoutMs: number,
): Promise<Response> {
  if (typeof read === 'object' && (!Number.isSafeInteger(read.chunk) || read.chunk < 0 || read.chunk >= MAX_EXPORT_CHUNKS)) {
    throw new Error('gw_invalid_control_op');
  }
  const { host, key } = exportOrigin(record, zone);
  const path = `${EXPORT_CONTROL_PATH}/${typeof read === 'object' ? `chunk/${read.chunk}` : read}`;
  const header = await signGatewayHeader(key, record, 'GET', path, nowSeconds);
  // Identity: the chunk's Content-Length is checked against the export head.
  return fetchFn(`https://${host}${path}`, {
    method: 'GET', headers: { [AWS_GATEWAY_HEADER]: header, 'accept-encoding': 'identity' },
    redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * GW-5 (proposed): a control-plane command relayed to the host agent through the edge.
 * Every parameter is in the SIGNED path (`/__ezil/control/<op>[/<warnSeconds>]`), the
 * body is empty, so the contract's path-only signature covers the whole command.
 */
export async function sendAwsControl(
  record: AwsTunnelRecord,
  zone: string,
  op: AwsControlOp,
  fetchFn: FetchLike,
  nowSeconds: number,
  warnSeconds?: number,
  requestId?: string,
): Promise<Response> {
  if (!(CONTROL_OPS as readonly string[]).includes(op)) throw new Error('gw_invalid_control_op');
  if (warnSeconds !== undefined && (!Number.isSafeInteger(warnSeconds) || warnSeconds < 0 || warnSeconds > 900 || op !== 'stop')) {
    throw new Error('gw_invalid_control_op');
  }
  if (op === 'restart-desktop' ? !/^[0-9a-f]{64}$/.test(requestId ?? '') : requestId !== undefined) {
    throw new Error('gw_invalid_control_op');
  }
  const key = decodeControlKey(record.controlKey);
  if (!key) throw new Error('gw_invalid_binding');
  const path = `/__ezil/control/${op}${requestId ? `/${requestId}` : warnSeconds === undefined ? '' : `/${warnSeconds}`}`;
  const host = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone);
  const header = await signGatewayHeader(key, record, 'POST', path, nowSeconds);
  return fetchFn(`https://${host}${path}`, { method: 'POST', headers: { [AWS_GATEWAY_HEADER]: header }, redirect: 'manual',
    ...(op === 'restart-desktop' ? { signal: AbortSignal.timeout(10_000) } : {}) });
}
