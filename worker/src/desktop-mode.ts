/**
 * Pure desktop-mode / ICE-config validation helpers — deliberately isolated
 * from `./index.ts` (which imports `@cloudflare/sandbox`, itself importing
 * `cloudflare:workers`, a module only resolvable inside the Workers runtime).
 * Keeping this logic here lets it be unit-tested with plain `bun test`
 * without needing `wrangler`/Miniflare.
 */

/** Runtime desktop modes supported by the Worker. Guacamole remains the default/rollback path. */
export type DesktopMode = 'guacamole' | 'neko';
export const DESKTOP_MODES: readonly DesktopMode[] = ['guacamole', 'neko'];

/**
 * Validate and normalize the `desktopMode` field at the narrow API boundary
 * (POST /sandbox/preview). Unknown/invalid values are rejected explicitly
 * rather than silently coerced, so a typo never silently falls back to
 * Guacamole and masks caller intent.
 */
export function resolveDesktopMode(
  requested: string | undefined,
  envDefault: string | undefined,
): { ok: true; mode: DesktopMode } | { ok: false; error: string } {
  const raw = (requested ?? envDefault ?? 'guacamole').trim().toLowerCase();
  if ((DESKTOP_MODES as readonly string[]).includes(raw)) {
    return { ok: true, mode: raw as DesktopMode };
  }
  return {
    ok: false,
    error: `invalid_desktop_mode: '${raw}' (expected one of: ${DESKTOP_MODES.join(', ')})`,
  };
}

/** Minimal env shape this module reads — a structural subset of the Worker's `Env`. */
export interface IceConfigEnv {
  SANDBOX_NEKO_ICE_POLICY?: string;
  SANDBOX_NEKO_TURN_URLS?: string;
  /**
   * Cloudflare Realtime TURN key id (a.k.a. "TURN Token ID"). This is a
   * resource identifier, not a secret — it appears in the credential-generation
   * URL path. Presence of a key id + api token means the Worker can mint
   * short-lived ephemeral TURN credentials at request time.
   */
  SANDBOX_NEKO_TURN_KEY_ID?: string;
  /**
   * Long-lived Cloudflare Realtime TURN API token (secret). Stored as a
   * Worker secret by NAME only (`wrangler secret put SANDBOX_NEKO_TURN_API_TOKEN`)
   * and NEVER logged/returned. Used server-side to generate ephemeral creds.
   */
  SANDBOX_NEKO_TURN_API_TOKEN?: string;
}

/**
 * True when the Worker has a way to supply a TURN relay for `neko` mode —
 * either a static pre-shared TURN URL set, OR a Cloudflare Realtime TURN key
 * id + api token pair it can use to mint short-lived ephemeral credentials.
 * Only checks PRESENCE; never reads or returns any credential/token value.
 */
export function hasTurnConfigured(env: IceConfigEnv): boolean {
  const hasStaticUrls = Boolean(env.SANDBOX_NEKO_TURN_URLS?.trim());
  const hasCloudflareKey =
    Boolean(env.SANDBOX_NEKO_TURN_KEY_ID?.trim()) && Boolean(env.SANDBOX_NEKO_TURN_API_TOKEN?.trim());
  return hasStaticUrls || hasCloudflareKey;
}

/**
 * Diagnostic ICE/TURN gate for `neko` mode's WebRTC signaling.
 * Fails closed: when the effective ICE policy requires a TURN relay
 * (`relay` or `production`) but no TURN provider is configured (neither
 * static URLs nor a Cloudflare Realtime TURN key), this returns a clear,
 * non-secret error instead of silently degrading to STUN-only (which would
 * hang for any client behind symmetric NAT). Never reads/returns credential
 * values — only presence booleans.
 */
export function checkIceConfig(
  env: IceConfigEnv,
): { ok: true; policy: string; hasTurn: boolean } | { ok: false; error: string } {
  const policy = env.SANDBOX_NEKO_ICE_POLICY?.trim().toLowerCase() || 'diagnostic';
  const hasTurn = hasTurnConfigured(env);
  if ((policy === 'relay' || policy === 'production') && !hasTurn) {
    return {
      ok: false,
      error:
        'turn_required: SANDBOX_NEKO_ICE_POLICY requires a TURN relay but no TURN provider is configured (set SANDBOX_NEKO_TURN_KEY_ID + SANDBOX_NEKO_TURN_API_TOKEN, or SANDBOX_NEKO_TURN_URLS)',
    };
  }
  return { ok: true, policy, hasTurn };
}

// ── Cloudflare Realtime TURN — ephemeral credential plumbing ─────────────────
// Docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/
// (verified 2026-07-13; doc dateModified 2026-04-21). The long-lived TURN key
// mints short-lived credentials via
//   POST https://rtc.live.cloudflare.com/v1/turn/keys/<KEY_ID>/credentials/generate-ice-servers
// returning { iceServers: [...] } — an array of RTCIceServer entries that neko
// consumes directly via NEKO_WEBRTC_ICESERVERS_{FRONTEND,BACKEND}.

/** A single ICE server entry as returned by Cloudflare / consumed by neko. */
export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Shape of the Cloudflare `generate-ice-servers` 201 response body. */
export interface TurnCredentialsResponse {
  iceServers?: IceServerEntry | IceServerEntry[];
}

/**
 * Bound the ephemeral credential TTL. The sandbox/session lifetime is ~30m
 * (SESSION_TTL_MS / SLEEP_AFTER), so the default and ceiling are 1800s; a
 * short floor prevents a mis-set value from minting a uselessly-brief
 * credential. Never exceeds the session lifetime so a leaked credential can
 * never outlive the session it was scoped to.
 */
export const TURN_TTL_DEFAULT_SECONDS = 1800;
export const TURN_TTL_MAX_SECONDS = 1800;
export const TURN_TTL_MIN_SECONDS = 300;

export function resolveTurnTtlSeconds(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return TURN_TTL_DEFAULT_SECONDS;
  return Math.min(TURN_TTL_MAX_SECONDS, Math.max(TURN_TTL_MIN_SECONDS, n));
}

/** Normalize the Cloudflare response `iceServers` (object or array) to an array. */
export function normalizeIceServers(body: TurnCredentialsResponse | null | undefined): IceServerEntry[] {
  const raw = body?.iceServers;
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

/**
 * Drop TURN/STUN URLs on the alternate port `:53`. Per Cloudflare's docs, port
 * 53 is blocked by browsers and (without trickle ICE) causes a connection
 * timeout; filtering keeps the frontend candidate set clean. Entries left with
 * an empty `urls` list are dropped entirely.
 */
export function filterBrowserSafeIceServers(servers: IceServerEntry[]): IceServerEntry[] {
  const keep = (u: string) => !/:53(\?|$)/.test(u);
  const out: IceServerEntry[] = [];
  for (const s of servers) {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(keep);
    if (urls.length > 0) out.push({ ...s, urls });
  }
  return out;
}

/**
 * Build the neko WebRTC ICE env vars from a resolved ICE server list. Returns
 * a plain env record passed to `startProcess({ env })` so the credential
 * values travel as process env — NEVER interpolated into a shell command line
 * (where they could leak into `ps`/argv/logs).
 *
 * - `NEKO_WEBRTC_ICESERVERS_FRONTEND`: browser-safe set (port 53 filtered).
 * - `NEKO_WEBRTC_ICESERVERS_BACKEND`: full set — the neko server itself is
 *   behind Cloudflare's HTTP/WS-only edge with no publicly reachable UDP, so
 *   it must gather relay candidates through the TURN server too.
 * - `NEKO_WEBRTC_ICELITE=false`: required when ICE servers are configured
 *   (neko docs) — ICE-lite servers never use relays.
 * - `NEKO_WEBRTC_ICETRICKLE=true`: trickle candidates so no wait on any slow
 *   alternate-port URL.
 *
 * Returns `null` when there is nothing usable to configure.
 */
export function buildNekoIceEnv(servers: IceServerEntry[]): Record<string, string> | null {
  if (!servers || servers.length === 0) return null;
  const frontend = filterBrowserSafeIceServers(servers);
  return {
    NEKO_WEBRTC_ICESERVERS_FRONTEND: JSON.stringify(frontend.length > 0 ? frontend : servers),
    NEKO_WEBRTC_ICESERVERS_BACKEND: JSON.stringify(servers),
    NEKO_WEBRTC_ICELITE: 'false',
    NEKO_WEBRTC_ICETRICKLE: 'true',
  };
}

/** Cloudflare Realtime TURN credential-generation endpoint for a given key id. */
export function turnGenerateUrl(keyId: string): string {
  return `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
}

/**
 * Resolve the in-container port + preview token to use for a given desktop mode.
 *
 * The `token` becomes both the `@cloudflare/sandbox` exposePort token AND a DNS
 * label in the composed preview hostname (`<port>-<id>-<token>.<host>`). The SDK
 * rejects any token that is not `[a-z0-9_]+`, and a valid hostname label further
 * forbids `_`, so the token MUST be lowercase-alphanumeric only. `neko-desktop`
 * (with a hyphen split by `<id>-<token>`) was rejected by the SDK at exposePort
 * with `Custom token must contain only lowercase letters (a-z), numbers (0-9),
 * and underscores (_)`, so `neko` mode uses the hyphen-free `nekodesktop`.
 */
export function portFor(mode: DesktopMode): { port: number; token: string; readyPath: string } {
  return mode === 'neko'
    ? { port: 8181, token: 'nekodesktop', readyPath: '/' }
    : { port: 8080, token: 'desktop', readyPath: '/guacamole/' };
}

// ── App preview port (Option D: iframe-over-reverse-proxy) ───────────────────
//
// Root cause this section fixes: `portFor()` above only ever resolved the
// desktop-stream port (8181 neko / 8080 guacamole). The user's own dev server
// — which the neko container's `EZIL_WORKSPACE_ROOT`/workspace mount makes
// available on `APP_PREVIEW_PORT` inside the container — was NEVER exposed,
// so EZiL OS could only ever show the user the whole remote desktop instead
// of their running app. This mirrors the Azure control-plane daemon's Option D
// contract (see `infra/sandbox-desktop/atspi_daemon.py` /
// `../Sandboxes/infra/sandbox-desktop/preview_bridge.py` and
// `docs/PREVIEW_MIGRATION_PLAN.md`), ported to the Cloudflare Sandbox runtime
// in `./preview-bridge.ts`.
//
// `neko` only: guacamole mode already streams a full interactive desktop, so
// there is no separate "show me just the app" surface for it.

/**
 * In-container port the user's dev server listens on (matches Option D's
 * `EZIL_DEV_PORT` default and the shipped `ezil-sandbox-template`'s
 * `next dev --port 3002`).
 *
 * MUST NOT be 3000 — that port is reserved by the `@cloudflare/sandbox` SDK
 * itself (its own control-plane Bun server; see the Dockerfile's base-image
 * doc comment). `validatePort()`/`exposePort()`/`unexposePort()`/`connect()`
 * all throw `SandboxSecurityError` for port 3000, so a dev server actually
 * listening there could never be exposed anyway.
 */
export const APP_PREVIEW_PORT = 3002;

/**
 * Preview-URL token for the app port. Lowercase-alphanumeric only — see the
 * `portFor()` doc comment above for why (SDK + hostname-label constraints).
 */
export const APP_PREVIEW_TOKEN = 'app';

/**
 * Resolve the app-preview port/token for a desktop mode, or `null` when the
 * mode has no app-preview surface (`guacamole`).
 */
export function appPortFor(mode: DesktopMode): { port: number; token: string } | null {
  return mode === 'neko' ? { port: APP_PREVIEW_PORT, token: APP_PREVIEW_TOKEN } : null;
}

// ── Code-server bridge port (VS Code in the browser, alongside the app preview) ──
//
// The `neko` desktop-mode image runs code-server (VS Code Web) for its editor
// surface. Historically the ONLY way to reach it was through the full neko
// WebRTC pixel-stream (`portFor('neko')`, port 8181) — heavier, higher-latency,
// and coupled to the whole desktop session. This gives code-server its own
// direct iframe-over-reverse-proxy bridge, mirroring `appPortFor` exactly, so
// the shell can embed a plain "code" window the same way it embeds a preview
// window, without going through WebRTC at all.

/**
 * In-container port code-server listens on. Deliberately distinct from every
 * other reserved port on this stack: 3000 is the `@cloudflare/sandbox` SDK's
 * own control plane (see `APP_PREVIEW_PORT`'s doc comment / platform notes
 * §5 — `validatePort(3000) === false`), 3002 is the user's own dev server
 * (`APP_PREVIEW_PORT`), 8080 is guacamole (`portFor('guacamole')`), 8181 is
 * the neko WebRTC/noVNC stream (`portFor('neko')`). 8443 collides with none
 * of them.
 */
export const CODE_PREVIEW_PORT = 8443;

/**
 * Preview-URL token for the code-server bridge port. Lowercase-alphanumeric
 * only — see `portFor()`'s doc comment for why (SDK + hostname-label
 * constraints: `@cloudflare/sandbox`'s `exposePort` rejects anything outside
 * `[a-z0-9_]+`, and a valid hostname label further forbids `_`).
 */
export const CODE_PREVIEW_TOKEN = 'code';

/**
 * Resolve the code-server bridge port/token for a desktop mode, or `null`
 * when the mode has no code-server surface (`guacamole` streams the whole X
 * desktop and has no separate code-server process to bridge to).
 */
export function codePortFor(mode: DesktopMode): { port: number; token: string } | null {
  return mode === 'neko' ? { port: CODE_PREVIEW_PORT, token: CODE_PREVIEW_TOKEN } : null;
}
