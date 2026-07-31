/**
 * EBuilder — Cloudflare Guacamole Sandbox Worker (production)
 *
 * Provisions a REAL browser desktop inside a Cloudflare Sandbox container and
 * exposes it to the EBuilder canvas through the genuine Apache Guacamole HTML5
 * client (NOT noVNC).
 *
 * HTTP API (consumed by apps/web/.../cloudflare-guacamole-provider.ts):
 *   GET    /health                 → { ok, service, mode }
 *   POST   /sandbox/preview        → { ok, guacamoleUrl, expiresAt, provider, mode, sandboxId }
 *   GET    /sandbox/:name/status   → { ok, sandboxName, guacamoleRunning, mode }
 *   POST   /sandbox/:name/workspace-diag → { ok, sandboxId, op, slot, exists, bytes, sha256, expectedSha256, matches, wrote }
 *          (HMAC-gated diagnostic: mounts the R2 workspace bucket and operates on
 *          named, allowlisted marker slots to prove deterministic R2 persistence
 *          AND A/B/C isolation — never returns raw file content)
 *   POST   /sandbox/:name/cpu-diag → { ok, sandboxId, path, exists, bytes, totalLines, returnedLines, maxLines, truncated, content }
 *          (HMAC-gated retrieval of the opt-in in-container CPU sampler's
 *          `/tmp/neko-cpu-diag.jsonl` — see `EZIL_NEKO_CPU_DIAG_ENABLED` /
 *          `handleCpuDiag`; bounded/tail-capped; degrades cleanly with
 *          `exists: false` when the sampler was never enabled)
 *   DELETE /sandbox/:name          → { ok, sandboxName, terminated, mode }
 *
 * How it works:
 *   1. `proxyToSandbox(request, env)` runs first. It intercepts requests to the
 *      exposed-port preview subdomain (`<port>-<id>-<token>.<host>`), including
 *      the Guacamole WebSocket tunnel upgrade, and forwards them into the
 *      container — this is what lets the browser reach the Apache Guacamole web
 *      app (Tomcat) on port 8080.
 *   2. `POST /sandbox/preview` derives a deterministic sandbox id, opens the
 *      Sandbox Durable Object, launches the desktop (Xvfb + fluxbox + x11vnc +
 *      guacd + Tomcat/Guacamole + Chrome) via `start-desktop.sh`, waits for the
 *      Guacamole client on port 8080, exposes it, and returns the client URL.
 *
 * Security: `POST /sandbox/preview` is authenticated with the same HMAC token
 * envelope the Azure control plane uses. When no HMAC secret is configured
 * (local dev), verification is skipped.
 */

import { getSandbox, proxyToSandbox, type Sandbox, type SandboxEnv } from '@cloudflare/sandbox';
// Separate value import of the SAME class (under a local alias) so the
// Durable Object subclass below (`EzilSandboxDO`) can `extends` it. The
// `type Sandbox` import above stays untouched — every existing `Sandbox<unknown>`
// annotation in this file keeps referring to the SDK's own (generic) type.
import { Sandbox as CFSandboxClass } from '@cloudflare/sandbox';

// This Worker is a standalone deployable (own package.json/lockfile, not a
// member of the root Bun workspace), so it cannot import `@ezil/constants`
// the way `apps/web/client` does. It used to reach across the repo by
// relative path (`../../../packages/constants/src/preview-timeouts`), but
// that breaks `wrangler deploy` when this directory is built from an
// isolated copy (the path resolves to nothing outside the full monorepo
// checkout). The timeout constant is therefore VENDORED locally in
// `./preview-timeouts.ts` — see that file's doc comment for the full
// rationale and `preview-timeouts.test.ts` for the drift guard that keeps
// it in sync with the canonical `packages/constants` value.
import { WORKER_DESKTOP_READY_TIMEOUT_MS } from './preview-timeouts';

// The Durable Object class that backs each sandbox container. Registered in
// wrangler.toml ([[durable_objects.bindings]] + [[migrations]] new_sqlite_classes)
// under `class_name = "Sandbox"`, which binds to whatever THIS module exports
// under the name `Sandbox` — since workerd resolves the class by NAME from
// this entrypoint module, not by import identity. That export is a small
// subclass (`EzilSandboxDO`, exported as `Sandbox` near `ensureWorkspaceMount`
// below, right after the workspace-persistence helpers it depends on) adding
// the alarm-driven workspace flush loop — see that class's doc comment.
// Zero wrangler.toml / migration changes needed: the underlying DO storage
// class identity is unchanged, only new methods are added.

// Required for the R2-binding workspace mount (`mode: 'r2-binding'` below,
// used with `[[r2_buckets]]` in wrangler.toml): the Sandbox DO's R2-egress
// interception fetchers reference this WorkerEntrypoint class directly
// (outboundHandlersRegistry lookups are not shared between the Durable
// Object's execution context and this class's own WorkerEntrypoint context).
// Without exporting it, `mountBucket(..., { prefix })` on an R2 binding
// throws `InvalidMountConfigError: R2 binding mounts require exporting
// ContainerProxy from the Worker entrypoint`.
export { ContainerProxy } from '@cloudflare/sandbox';

interface Env extends SandboxEnv {
  /** Shared HMAC secret (set via `wrangler secret put SANDBOX_HMAC_SECRET`). */
  SANDBOX_HMAC_SECRET?: string;
  /** Alternate secret name matching the EBuilder env var. Either is accepted. */
  CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string;
  /**
   * OPTIONAL, TEMPORARY mission-signing HMAC alias.
   *
   * When present, a preview/diag signature is accepted if it matches EITHER the
   * primary/compatibility secret (`SANDBOX_HMAC_SECRET` /
   * `CLOUDFLARE_GUACAMOLE_HMAC_SECRET`) OR this mission secret. It is an
   * additive alias only: its ABSENCE changes nothing, it never becomes required,
   * and it never replaces primary auth. This binding is an operational/temporary
   * convenience for signing A/B/C R2 missions with a throwaway key and must
   * normally be ABSENT in production. Never logged or returned.
   */
  SANDBOX_MISSION_HMAC_SECRET?: string;

  // ── R2 binding workspace bucket (preferred, credential-less mount path) ────
  // Bound via [[r2_buckets]] in wrangler.toml. When present, this is the
  // primary workspace persistence mechanism — no S3 access keys required.
  /** R2 bucket binding backing the persistent sandbox workspace (`ezil-sandbox-workspaces`). */
  SANDBOX_WORKSPACE_R2_BUCKET?: R2Bucket;

  // ── S3-compatible workspace bucket (mounted into the sandbox container) ────
  // Names are deliberately prefixed `SANDBOX_WORKSPACE_S3_*` so they never
  // collide with unrelated AWS/Bedrock credential env vars used elsewhere in
  // the monorepo. Generic enough to point at Cloudflare R2, local Supabase
  // Storage's S3-compatible endpoint, or any other S3-compatible service.
  /** S3-compatible endpoint URL, e.g. local Supabase Storage `http://127.0.0.1:8000/storage/v1/s3`. */
  SANDBOX_WORKSPACE_S3_ENDPOINT?: string;
  /** Bucket name backing the sandbox workspace. */
  SANDBOX_WORKSPACE_S3_BUCKET?: string;
  /** Access key id for the workspace bucket (never logged). */
  SANDBOX_WORKSPACE_S3_ACCESS_KEY_ID?: string;
  /** Secret access key for the workspace bucket (never logged). */
  SANDBOX_WORKSPACE_S3_SECRET_ACCESS_KEY?: string;
  /**
   * Optional key prefix scoping the mount to a subdirectory of the bucket.
   * Defaults to `/<projectId>/branches/<branch>` (see
   * `ensureWorkspaceMount`) — MUST start with `/` if set, matching
   * `mountBucket()`'s own validation contract.
   *
   * DELIBERATELY NOT SET IN PRODUCTION: this env var, when present, is read
   * ONCE and applied to EVERY sandbox (see `resolveWorkspaceMountConfig`),
   * which would collapse all users/projects onto one shared workspace
   * prefix. It exists only as an escape hatch for single-tenant local/dev
   * setups that want a fixed mount path.
   */
  SANDBOX_WORKSPACE_S3_PREFIX?: string;
  /** Provider hint ('s3' | 'r2' | 'gcs') for s3fs flag auto-configuration. Defaults to 's3'. */
  SANDBOX_WORKSPACE_S3_PROVIDER?: string;
  /** Absolute in-container path where the workspace bucket is mounted. Defaults to `/workspace`. */
  SANDBOX_WORKSPACE_MOUNT_PATH?: string;

  /**
   * Non-secret kill-switch for the HMAC-gated `workspace-diag` route. Enabled
   * by default; set to `off`/`false`/`0`/`disabled`/`no` to hard-disable the
   * diagnostic surface (returns 404) without a code change.
   */
  SANDBOX_WORKSPACE_DIAG?: string;

  /**
   * Non-secret kill-switch for the Twen orchestration route
   * (`POST /sandbox/:name/twen`). Enabled by default; set to
   * `off`/`false`/`0`/`disabled`/`no` to hard-disable the surface (returns 404)
   * without a code change.
   */
  SANDBOX_TWEN?: string;

  /**
   * Non-secret opt-in flag forwarded verbatim into the container process env
   * as `EZIL_NEKO_CPU_DIAG_ENABLED` (see `ensureDesktop` + `cpu-diag.ts`),
   * which gates `scripts/start-neko.sh`'s in-container CPU sampler. DEFAULT
   * OFF (unset/anything other than a truthy spelling) — a normal boot spawns
   * no extra process and writes no extra file. Toggle with
   * `wrangler secret put EZIL_NEKO_CPU_DIAG_ENABLED` (or a `[vars]` entry —
   * not sensitive) set to `1`, then read back via
   * `POST /sandbox/:name/cpu-diag` (see `handleCpuDiag`).
   */
  EZIL_NEKO_CPU_DIAG_ENABLED?: string;

  /**
   * Non-secret kill-switch for the CPU-diagnostic RETRIEVAL route
   * (`POST /sandbox/:name/cpu-diag`). Enabled by default (HMAC-gated, bounded,
   * read-only); set to `off`/`false`/`0`/`disabled`/`no` to hard-disable the
   * route (returns 404) without a code change. Independent of
   * `EZIL_NEKO_CPU_DIAG_ENABLED` above — the route can stay reachable even
   * when the sampler itself is off; it then simply reports `exists: false`.
   */
  SANDBOX_CPU_DIAG?: string;

  /**
   * Non-secret kill-switch for the `/project-files/*` storage-proxy routes
   * (the `worker_proxy` `ProjectFilesTransport` backend — see `./project-files`).
   * Enabled by default; set to `off`/`false`/`0`/`disabled`/`no` to
   * hard-disable the surface (returns 404) without a code change.
   */
  SANDBOX_PROJECT_FILES_PROXY?: string;

  // ── Desktop runtime mode (Phase 1: Guacamole default, Neko opt-in) ─────────
  /** Optional deployment-wide default for `desktopMode` when the request omits it. */
  SANDBOX_DEFAULT_DESKTOP_MODE?: string;  /**
   * ICE/TURN config for the `neko` runtime mode's WebRTC signaling.
   *
   * `SANDBOX_NEKO_ICE_POLICY` gates behavior: `relay`/`production` require a
   * working TURN relay (fail closed via `checkIceConfig` when none is
   * configured); `diagnostic` (default) does not.
   *
   * TURN is supplied by Cloudflare Realtime TURN: the long-lived key mints
   * short-lived, per-session ephemeral credentials at request time. The key id
   * is a resource identifier (`SANDBOX_NEKO_TURN_KEY_ID`); the api token is a
   * secret stored by NAME (`SANDBOX_NEKO_TURN_API_TOKEN`) and NEVER logged or
   * returned. `SANDBOX_NEKO_TURN_URLS` is a static pre-shared fallback for a
   * non-Cloudflare TURN server. `SANDBOX_NEKO_TURN_TTL_SECONDS` optionally
   * bounds the ephemeral credential TTL (default/ceiling 1800s = session life).
   */
  SANDBOX_NEKO_TURN_URLS?: string;
  SANDBOX_NEKO_ICE_POLICY?: string;
  /** Cloudflare Realtime TURN key id ("TURN Token ID") — a resource id, not a secret. */
  SANDBOX_NEKO_TURN_KEY_ID?: string;
  /** Long-lived Cloudflare Realtime TURN API token (secret, by name — never logged/returned). */
  SANDBOX_NEKO_TURN_API_TOKEN?: string;
  /** Optional ephemeral TURN credential TTL in seconds (clamped to [300, 1800]). */
  SANDBOX_NEKO_TURN_TTL_SECONDS?: string;
}

/**
 * Desktop-mode / ICE-config validation is factored into `./desktop-mode.ts`
 * (no `@cloudflare/sandbox` import there) so it can be unit-tested with plain
 * `bun test`, without needing the Workers runtime. Re-exported here for
 * backwards-compatible imports of this module.
 *
 * NOTE: `DESKTOP_MODES` is intentionally NOT re-exported here. workerd
 * validates every top-level export of the entrypoint module and requires
 * each to be a function/class/`ExportedHandler` — a plain `const` re-export
 * aborts the runtime with `Incorrect type for map entry ... is not of type
 * 'function or ExportedHandler'`. Import it directly from `./desktop-mode`.
 */
export { resolveDesktopMode, checkIceConfig, portFor, type DesktopMode } from './desktop-mode';
import {
  resolveDesktopMode,
  checkIceConfig,
  portFor,
  appPortFor,
  APP_PREVIEW_PORT,
  DESKTOP_MODES,
  type DesktopMode,
  hasTurnConfigured,
  resolveTurnTtlSeconds,
  normalizeIceServers,
  buildNekoIceEnv,
  turnGenerateUrl,
  type IceServerEntry,
  type TurnCredentialsResponse,
} from './desktop-mode';
export {
  parseAppPreviewHost,
  handlePreviewBootstrap,
  handlePreviewProxy,
  handlePreviewWsProxy,
  handlePreviewInspectorJs,
  buildPreviewStatus,
  buildPackageJsonCheckCommand,
  parseDevserverPhase,
  parseDevserverPhaseRecord,
  parseRestartAttempts,
  shouldTriggerDevserverRestart,
  effectiveDevserverPhase,
  computeDevserverRestartBackoffS,
  buildDevserverRestartCommand,
  rewriteResponseHeaders,
  injectRuntimeShim,
  type PreviewStatus,
  type DevserverRestartDecision,
} from './preview-bridge';
import {
  parseAppPreviewHost,
  handlePreviewBootstrap,
  handlePreviewProxy,
  handlePreviewWsProxy,
  handlePreviewInspectorJs,
  buildPreviewStatus,
  buildPackageJsonCheckCommand,
  parseDevserverPhaseRecord,
  parseRestartAttempts,
  shouldTriggerDevserverRestart,
  effectiveDevserverPhase,
  buildDevserverRestartCommand,
  DEVSERVER_PHASE_FILE,
  DEVSERVER_MODE_FILE,
  DEVSERVER_RESTART_COUNT_FILE,
  WORKSPACE_READY_MARKER_PATH,
} from './preview-bridge';
// NOTE: `DIAG_SLOT_PREFIX`, `DIAG_SLOT_RE`, and `DIAG_OPS` are intentionally
// NOT re-exported here — they are plain `const`s, and workerd rejects any
// top-level export of the entrypoint module that isn't a
// function/class/`ExportedHandler` (see the note above `DESKTOP_MODES`).
// Import them directly from `./workspace-diag`.
export { diagSlotFile, diagMarkerContent, parseDiagRequest, isWriteOp, diagDisabled, type DiagOp } from './workspace-diag';
import { diagSlotFile, diagMarkerContent, parseDiagRequest, diagDisabled } from './workspace-diag';
import {
  putProjectFile,
  getProjectFileBytes,
  getProjectFileProperties,
  deleteProjectFile,
  listProjectFiles,
  PROJECT_FILES_MAX_PUT_REQUEST_BYTES,
  PROJECT_FILES_MAX_CONTROL_REQUEST_BYTES,
} from './project-files';
import {
  seedWorkspaceIfAbsent,
  realR2KeyPrefix,
  buildTemplateCopyCommand,
  templateWasMissing,
} from './workspace-seed';
import {
  hydrateWorkspaceFromR2,
  flushWorkspaceToR2,
  parseHydrateMarker,
  serializeHydrateMarker,
  parseFlushManifest,
  serializeFlushManifest,
  HYDRATE_MARKER_FILENAME,
  FLUSH_MANIFEST_FILENAME,
  type FlushOutcome,
  type FlushManifest,
} from './workspace-persist';
// NOTE: `TWEN_SCHEMA`, `TWEN_OPS`, `TWEN_OP_ID_RE`, `TWEN_ALLOWED_FIELDS`,
// `TWEN_MAX_BODY_BYTES`, and `TWEN_STATUS_FILE`/`TWEN_STAT_RETRY_DELAY_MS` are
// intentionally NOT re-exported here — they are plain `const`s, and workerd
// rejects any top-level export of the entrypoint module that isn't a
// function/class/`ExportedHandler` (see the note above `DESKTOP_MODES`).
// Import them directly from `./twen`.
export {
  isTwenWriteOp,
  twenDisabled,
  twenStatusContent,
  parseTwenRequest,
  parseTwenBody,
  twenRequestTooLarge,
  twenStatMaxAttempts,
  twenStatConverged,
  parseTwenStatLines,
  twenWriteCommand,
  twenWriteConfirmed,
  twenWriteDurable,
  twenStaleZero,
  type TwenOp,
} from './twen';
import {
  TWEN_STATUS_FILE,
  twenStatusContent,
  parseTwenBody,
  twenDisabled,
  twenRequestTooLarge,
  twenStatMaxAttempts,
  twenStatConverged,
  parseTwenStatLines,
  twenWriteCommand,
  twenWriteDurable,
  TWEN_STAT_RETRY_DELAY_MS,
} from './twen';
// NOTE: `CPU_DIAG_FILE`, `CPU_DIAG_MAX_BYTES`, `CPU_DIAG_DEFAULT_MAX_LINES`,
// and `CPU_DIAG_MAX_LINES_CEILING` are intentionally NOT re-exported here —
// they are plain `const`s, and workerd rejects any top-level export of the
// entrypoint module that isn't a function/class/`ExportedHandler`. This is
// THE reported boot failure: `Incorrect type for map entry
// 'CPU_DIAG_DEFAULT_MAX_LINES': the provided value is not of type 'function
// or ExportedHandler'`. Import these directly from `./cpu-diag`.
export {
  cpuDiagFlagEnabled,
  cpuDiagRouteDisabled,
  resolveCpuDiagMaxLines,
  cpuDiagStatCommand,
  parseCpuDiagStatLines,
  cpuDiagContentCommand,
  type CpuDiagStat,
} from './cpu-diag';
import {
  CPU_DIAG_FILE,
  CPU_DIAG_MAX_BYTES,
  cpuDiagFlagEnabled,
  cpuDiagRouteDisabled,
  resolveCpuDiagMaxLines,
  cpuDiagStatCommand,
  parseCpuDiagStatLines,
  cpuDiagContentCommand,
} from './cpu-diag';
import {
  resolvePreviewSecrets,
  verifyPreviewToken,
  deriveNekoCredentials,
  resolveNekoDerivationSecret,
} from './hmac';
import { LifecycleTimeline, newCorrelationId } from './observability';

// ── Constants ────────────────────────────────────────────────────────────────

/** HTTP+WebSocket port that the Apache Guacamole web app (Tomcat) serves inside the container. */
const DESKTOP_PORT = 8080;
/** Preview validity window reported to the client. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/** Sandbox auto-sleep when idle (explicit DELETE → destroy() for teardown). */
const SLEEP_AFTER = '30m';
/**
 * Max time to wait for the SELECTED desktop service to bind + serve.
 *
 * This ceiling MUST exceed the slowest in-container readiness path, otherwise
 * the Worker gives up and reports `desktop_failed_to_start` while the container
 * is still legitimately coming up (the live 90s failure observed in run
 * cloud_worker_00b1a940…). The `neko` path is the slowest: start-neko.sh gates
 * readiness on BOTH mandatory app X windows appearing, up to
 * NEKO_WINDOW_READY_TIMEOUT (60s) EACH, now checked CONCURRENTLY rather than
 * sequentially, plus Xvfb/openbox startup and `neko serve` binding 8181 — a
 * cold Firecracker boot where VS Code's first launch alone can take ~60s can
 * still push the whole sequence close to this ceiling. 180s gives that path
 * headroom; the faster Guacamole path is unaffected (it binds long before
 * this ceiling).
 *
 * Sourced from this Worker's own vendored `./preview-timeouts.ts` (kept in
 * sync with the canonical `@ezil/constants`
 * `packages/constants/src/preview-timeouts.ts` by a drift-guard test — see
 * that file's doc comment for why it's vendored rather than imported by
 * relative path) so the client's own cold-start timeout
 * (`SANDBOX_COLD_START_TIMEOUT_MS` in
 * `apps/web/client/src/server/lib/cloudflare-guacamole-provider.ts`) is
 * DERIVED from this value and can never silently drift below it again.
 */
const DESKTOP_READY_TIMEOUT_MS = WORKER_DESKTOP_READY_TIMEOUT_MS;
/** Default in-container mount point for the S3 workspace bucket. */
const DEFAULT_WORKSPACE_MOUNT_PATH = '/workspace';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// ── HMAC verification (Web Crypto) ─────────────────────────────────────────────
// The signed-API auth contract (secret resolution, freshness, canonicalization,
// timing-safe comparison, and the optional mission-secret alias) lives in
// `./hmac` so it can be unit-tested without the Workers runtime.

/** Hex SHA-256 of a UTF-8 string (used to derive/verify diagnostic marker digests). */
async function sha256Hex(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Sandbox helpers ─────────────────────────────────────────────────────────

/**
 * Derive a deterministic sandbox id from a user/scope pair. The second
 * argument is a "scope id" — historically always a projectId, now also a
 * computer id ("your computers" pivot) since this Worker never joins it
 * against any table; it's an opaque UUID either way. Renamed from
 * `projectId` to `scopeId` for that reason; the function body is otherwise
 * byte-for-byte unchanged.
 *
 * MUST match EBuilder's `deriveGuacamoleSandboxId()` exactly (same rename
 * applied there in lockstep) so that preview / status / terminate all
 * address the same Durable Object.
 */
function deriveSandboxId(userId: string, scopeId?: string): string {
  const base = userId.replace(/[^a-z0-9]/gi, '').slice(0, 16);
  const project = (scopeId ?? 'default').replace(/[^a-z0-9]/gi, '').slice(0, 16);
  return `guac-${base}-${project}`;
}

/**
 * The two workspace-persistence RPC methods `EzilSandboxDO` (below,
 * `ensureWorkspaceMount`'s neighbor) adds on top of the SDK's own `Sandbox`
 * class. `getSandbox()`'s return type comes from the SDK's OWN generic
 * `Sandbox<Env>` type, which has no idea a subclass is bound at runtime via
 * wrangler.toml's `class_name` — so `openSandbox()` below widens the return
 * type with this small intersection instead of casting at every call site.
 * These are genuine Durable Object RPC methods (same call style as the
 * `sandbox.exec()` / `sandbox.mountBucket()` calls already in this file) —
 * not a new transport.
 */
interface EzilWorkspacePersistRpc {
  recordWorkspaceHydration(params: { prefix: string; mountPath: string; hydrated: boolean }): Promise<void>;
  flushWorkspaceNow(): Promise<FlushOutcome>;
}

/** Open (or create) the Sandbox DO for an id with consistent options. */
function openSandbox(env: Env, id: string): Sandbox<unknown> & EzilWorkspacePersistRpc {
  // normalizeId:true is REQUIRED — preview hostnames are case-insensitive, so
  // the DO key and the preview-URL token must agree on a lowercase id.
  return getSandbox(env.Sandbox, id, { normalizeId: true, sleepAfter: SLEEP_AFTER }) as Sandbox<unknown> &
    EzilWorkspacePersistRpc;
}

/**
 * Probe the Guacamole web app's HTTP readiness *independently of any launcher
 * process*, by issuing an in-container HTTP GET to `/guacamole/` on port 8080.
 *
 * This is the robust counterpart to `Process.waitForPort()`. The SDK ties
 * `waitForPort()` to the lifetime of the process that started it, so an
 * idempotent bootstrap script that exits 0 immediately (because the desktop is
 * already running) makes `waitForPort()` reject with
 * `ProcessExitedBeforeReadyError` even though port 8080 is healthy.
 * `sandbox.exec()` runs a fresh short-lived command, so this check reflects the
 * ACTUAL port state, not the launcher's lifetime.
 *
 * `wget` ships in the desktop image (see Dockerfile) and exits 0 only on a
 * 2xx response (following 3xx), matching `waitForPort`'s http success window.
 */
async function pollDesktopReady(
  sandbox: Sandbox<unknown>,
  timeoutMs: number,
  intervalMs = 1000,
  port: number = DESKTOP_PORT,
  path: string = '/guacamole/',
): Promise<{ ready: boolean; detail: string }> {
  const deadline = Date.now() + timeoutMs;
  const probe = `wget -q -T 5 -t 1 -O /dev/null http://127.0.0.1:${port}${path}`;
  let last = 'no probe attempted';
  while (Date.now() < deadline) {
    try {
      const res = await sandbox.exec(probe, { origin: 'internal' });
      if (res.exitCode === 0) {
        return { ready: true, detail: `http 2xx on ${path}` };
      }
      last = `wget exit=${res.exitCode}${res.stderr ? ` stderr=${res.stderr.trim().slice(-160)}` : ''}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ready: false, detail: last };
}

/**
 * Expose a container port under a stable preview token, self-healing a
 * stale-token collision.
 *
 * The SDK persists a port→token map in Durable Object storage and enforces that
 * a token maps to at most ONE port. If the token is still attached to a
 * DIFFERENT port left over from a previous implementation (e.g. a legacy
 * `6080` noVNC binding that survived in DO storage across restarts),
 * `exposePort(port, { token })` throws
 * `SandboxSecurityError: Token '<token>' is already in use by port <n>`.
 * `getExposedPorts()` only reports ACTIVE-runtime ports, so that stale binding
 * is invisible to a pre-emptive cleanup and we cannot detect it up front.
 *
 * Recovery: parse the offending port out of the error and revoke it with the
 * idempotent `unexposePort()` (which clears DO-owned preview state only and
 * never contacts/wakes/cleans up the container), then retry. Bounded to a few
 * attempts so a genuinely different failure still surfaces instead of looping.
 *
 * Generic over (port, token) so it backs both the desktop-stream port
 * (`exposeDesktopPort` below) and the app-preview port (`ensureDesktop`'s
 * `appPortFor(mode)` call) with identical self-healing behavior.
 */
async function exposePreviewPort(
  sandbox: Sandbox<unknown>,
  hostname: string,
  port: number,
  token: string,
): Promise<string> {
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      const { url } = await sandbox.exposePort(port, {
        hostname,
        name: token,
        token,
      });
      return url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const collision = /already in use by port (\d+)/.exec(message);
      const stalePort = collision ? Number(collision[1]) : Number.NaN;
      // Only self-heal the specific stale-token collision; rethrow anything else
      // (and give up after a bounded number of heal attempts).
      if (attempt >= MAX_ATTEMPTS || !Number.isInteger(stalePort) || stalePort === port) {
        throw err;
      }
      await sandbox.unexposePort(stalePort);
    }
  }
}

async function exposeDesktopPort(sandbox: Sandbox<unknown>, hostname: string, mode: DesktopMode = 'guacamole'): Promise<string> {
  const { port, token } = portFor(mode);
  return exposePreviewPort(sandbox, hostname, port, token);
}

/**
 * Outcome of the best-effort app-preview raw-port exposure step inside
 * `ensureDesktop` (see that function's doc comment). Never thrown — always
 * returned, so a failure here is OBSERVABLE (logged + surfaced in the
 * `/preview` response) instead of silently discarded.
 */
export interface AppPreviewExposeResult {
  /** `false` when `appPortFor(mode)` returned `null` (guacamole mode — no app-preview surface). */
  attempted: boolean;
  exposed: boolean;
  error?: string;
}

/**
 * Boot-phase observability (Worker side of `ensureDesktop`).
 *
 * Production has no exec/shell route into a live container — `workspace-diag`
 * and `cpu-diag` only touch fixed marker files/slots — so `wrangler tail` is
 * the ONLY window into what a live boot is doing. These lines share the
 * `[ezil-boot]` prefix and the `phase=`/`event=`/`status=`/`phase_ms=`/
 * `cumulative_ms=` vocabulary with the in-container boot log
 * (`scripts/start-neko.sh`), so a single `wrangler tail` interleaves the
 * Worker-side phases (container start, the desktop-ready wait, port exposure)
 * with the container-side phases (Xvfb, openbox, workspace hydration,
 * dev-server launch, VS Code/Chrome launch, the window-ready gate, neko's own
 * HTTP bind) into one greppable stream showing where boot time goes and where
 * a boot died. Always on, cheap (a handful of calls per preview request, no
 * per-request-body work), and never logs payloads, secrets, tokens, or file
 * contents — only phase names, ok/error/skipped outcomes, and integers.
 */
function bootLog(
  phase: string,
  event: 'start' | 'end',
  extra?: { status?: 'ok' | 'error' | 'skipped'; phaseMs?: number; cumulativeMs?: number; detail?: string },
): void {
  const parts = [`[ezil-boot] phase=${phase}`, `event=${event}`];
  if (extra?.status) parts.push(`status=${extra.status}`);
  if (typeof extra?.phaseMs === 'number') parts.push(`phase_ms=${Math.round(extra.phaseMs)}`);
  if (typeof extra?.cumulativeMs === 'number') parts.push(`cumulative_ms=${Math.round(extra.cumulativeMs)}`);
  if (extra?.detail) parts.push(`detail=${extra.detail}`);
  console.log(parts.join(' '));
}

/**
 * Ensure the browser desktop is running inside the sandbox and return the
 * exposed base URL (`https://<port>-<id>-desktop.<hostname>`) that fronts the
 * Apache Guacamole web app, alongside the (best-effort) app-preview port
 * exposure outcome.
 *
 * Idempotent: if the port is already exposed in the active runtime it is
 * reused; otherwise the desktop is (re)launched and the port (re)exposed.
 * Readiness is verified against the real port state (not the launcher process's
 * lifetime) so an already-running desktop is detected instead of failing.
 */
async function ensureDesktop(
  sandbox: Sandbox<unknown>,
  hostname: string,
  mode: DesktopMode = 'guacamole',
  iceEnv: Record<string, string> | null = null,
  startupDelivery: string | null = null,
  workspaceRoot: string | null = null,
  cpuDiagFlag: string | undefined = undefined,
): Promise<{ url: string; appPreviewExpose: AppPreviewExposeResult }> {
  const bootT0 = Date.now();
  const { port, readyPath } = portFor(mode);
  const exposed = await sandbox.getExposedPorts(hostname);
  const already = exposed.find((p) => p.port === port);
  if (already) {
    // Fast path: desktop already exposed from a prior call — the app-preview
    // port re-exposure below is skipped here too (pre-existing behavior,
    // unrelated to this fix), so report it as not attempted rather than
    // silently implying success.
    bootLog('container_start', 'end', { status: 'skipped', detail: 'already_exposed', cumulativeMs: Date.now() - bootT0 });
    bootLog('ready', 'end', { status: 'ok', cumulativeMs: Date.now() - bootT0, detail: 'already_exposed' });
    return { url: already.url, appPreviewExpose: { attempted: false, exposed: false } };
  }

  bootLog('container_start', 'start');
  // start-desktop.sh is idempotent (it no-ops if the selected service is
  // already up), and mode-aware: DESKTOP_MODE selects Guacamole (default,
  // unchanged path) or delegates to start-neko.sh for the `neko` runtime.
  //
  // TURN credentials (when present) are passed as process ENV — never
  // interpolated into the command string — so ephemeral usernames/credentials
  // never appear in the launched command line / argv / process listing. neko
  // reads NEKO_WEBRTC_ICESERVERS_{FRONTEND,BACKEND} natively from its env.
  //
  // The sealed workspace-startup delivery (neko only) is likewise passed ONLY
  // as env `EZIL_WORKSPACE_STARTUP_DELIVERY` — never argv — so the sealed
  // capability never appears in a process listing. The in-container bootstrap
  // (start-neko.sh) reads it, hydrates `/home/neko/project` before readiness,
  // and fails closed if it is absent/tampered.
  const startupEnv: Record<string, string> =
    mode === 'neko' && startupDelivery
      ? { EZIL_WORKSPACE_STARTUP_DELIVERY: startupDelivery }
      : {};
  // When the S3/R2 workspace bucket is mounted (neko only), forward its exact
  // mount path as env `EZIL_WORKSPACE_ROOT` — never argv — so start-neko.sh
  // can hydrate/use the real mounted workspace instead of the fallback
  // `/home/neko/project`. Omitted entirely when unmounted so the fallback
  // path applies unchanged.
  const workspaceRootEnv: Record<string, string> =
    mode === 'neko' && workspaceRoot ? { EZIL_WORKSPACE_ROOT: workspaceRoot } : {};
  // Opt-in CPU-saturation diagnostic sampler (see `./cpu-diag.ts` +
  // `scripts/start-neko.sh`'s "CPU saturation diagnostics" section). Only
  // meaningful for `neko` mode (guacamole mode's start-desktop.sh never reads
  // this var) and only forwarded when the Worker-side flag is explicitly
  // truthy — default OFF, zero cost when unset. Passed as env only (never
  // argv), consistent with every other opt-in toggle above.
  const cpuDiagEnv: Record<string, string> =
    mode === 'neko' && cpuDiagFlagEnabled(cpuDiagFlag) ? { EZIL_NEKO_CPU_DIAG_ENABLED: '1' } : {};
  const proc = await sandbox.startProcess(`DESKTOP_MODE=${mode} bash /usr/local/bin/start-desktop.sh`, {
    env: { DESKTOP_MODE: mode, ...(iceEnv ?? {}), ...startupEnv, ...workspaceRootEnv, ...cpuDiagEnv },
  });
  bootLog('container_start', 'end', {
    status: 'ok',
    phaseMs: Date.now() - bootT0,
    cumulativeMs: Date.now() - bootT0,
  });

  // Readiness is deliberately DECOUPLED from the launcher process lifetime.
  // `Process.waitForPort()` is bound to `proc`; when the desktop is already
  // running, start-desktop.sh exits 0 within ~1s and waitForPort() rejects with
  // `ProcessExitedBeforeReadyError` even though the port is serving. So we use
  // waitForPort() only as a fast path, and fall back to an independent
  // in-container HTTP probe (pollDesktopReady) that reflects the ACTUAL port
  // state, identifying the SELECTED service (readyPath), not just open TCP.
  // The desktop is considered ready if EITHER signal succeeds. From the
  // Worker's side this single wait spans everything start-neko.sh does
  // in-container (Xvfb, openbox, workspace hydration, dev-server launch,
  // VS Code/Chrome launch, the window-ready gate, neko's own HTTP bind) —
  // those finer-grained phases show up separately in the container's own
  // `[ezil-boot]` log lines (see scripts/start-neko.sh), not here.
  bootLog('desktop_ready_wait', 'start');
  const startedAt = Date.now();
  let ready = false;
  let waitDetail = '';
  try {
    await proc.waitForPort(port, {
      mode: 'http',
      path: readyPath,
      timeout: DESKTOP_READY_TIMEOUT_MS,
      interval: 1000,
    });
    ready = true;
  } catch (err) {
    waitDetail = err instanceof Error ? err.message : String(err);
    // waitForPort() failed — commonly ProcessExitedBeforeReadyError for the
    // already-running no-op. Confirm the port directly before giving up.
    const remaining = Math.max(5_000, DESKTOP_READY_TIMEOUT_MS - (Date.now() - startedAt));
    const probe = await pollDesktopReady(sandbox, remaining, 1000, port, readyPath);
    ready = probe.ready;
    if (!ready) waitDetail += ` | port probe: ${probe.detail}`;
  }
  bootLog('desktop_ready_wait', 'end', {
    status: ready ? 'ok' : 'error',
    phaseMs: Date.now() - startedAt,
    cumulativeMs: Date.now() - bootT0,
  });

  if (!ready) {
    let detail = waitDetail;
    try {
      const logs = await proc.getLogs();
      if (logs.stderr) detail += ` | desktop stderr (tail): ${logs.stderr.slice(-600)}`;
    } catch {
      /* logs are best-effort diagnostics */
    }
    bootLog('ready', 'end', { status: 'error', cumulativeMs: Date.now() - bootT0 });
    throw new Error(`desktop_failed_to_start: ${detail}`);
  }

  bootLog('desktop_port_expose', 'start');
  const desktopUrl = await exposeDesktopPort(sandbox, hostname, mode);
  bootLog('desktop_port_expose', 'end', { status: 'ok', cumulativeMs: Date.now() - bootT0 });

  // Option D: also expose the user's dev server port (neko only — guacamole
  // mode already streams the whole interactive desktop). This is the fix for
  // the root cause this whole feature addresses: previously `portFor()` only
  // ever resolved the desktop-stream port, so the app itself was never
  // reachable from the browser. Best-effort in the sense that a failure here
  // must never BLOCK the desktop preview itself from becoming available —
  // the token-gated `/preview-bootstrap` proxy (`./preview-bridge.ts`)
  // reaches the dev server via `containerFetch` regardless of whether this
  // raw exposure succeeds (see that module's doc comment). "Best-effort"
  // does NOT mean "silent": this used to be a bare `catch { /* best-effort */
  // }` that discarded the error entirely, which is exactly how the port-3000
  // reservation bug (`@cloudflare/sandbox` reserves 3000 for its own control
  // plane — see `desktop-mode.ts`) went unnoticed in production: the call
  // failed 100% of the time and nothing ever surfaced it. Now the outcome is
  // always returned to the caller (which logs it via the lifecycle timeline
  // and reflects it in the `/preview` response next to `workspace`) instead
  // of being thrown away.
  const appPreview = appPortFor(mode);
  let appPreviewExpose: AppPreviewExposeResult = { attempted: false, exposed: false };
  if (appPreview) {
    bootLog('app_preview_expose', 'start');
    appPreviewExpose = { attempted: true, exposed: false };
    try {
      await exposePreviewPort(sandbox, hostname, appPreview.port, appPreview.token);
      appPreviewExpose = { attempted: true, exposed: true };
      bootLog('app_preview_expose', 'end', { status: 'ok', cumulativeMs: Date.now() - bootT0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appPreviewExpose = { attempted: true, exposed: false, error: message };
      bootLog('app_preview_expose', 'end', { status: 'error', cumulativeMs: Date.now() - bootT0 });
      console.error(
        `[ensureDesktop] app-preview port expose failed (hostname=${hostname}, port=${appPreview.port}): ${message}`,
      );
    }
  }

  bootLog('ready', 'end', { status: 'ok', phaseMs: Date.now() - bootT0, cumulativeMs: Date.now() - bootT0 });
  return { url: desktopUrl, appPreviewExpose };
}

// ── S3 workspace bucket mount ───────────────────────────────────────────────

/**
 * Resolve the workspace bucket mount configuration from env.
 * Returns `null` when the endpoint/bucket are not configured — the caller
 * treats this as "no workspace bucket wired for this environment" and skips
 * mounting entirely (e.g. local dev without Supabase Storage configured).
 */
type WorkspaceMountConfig =
  | {
      mode: 'r2-binding';
      /** R2 binding name in wrangler.toml — passed to `mountBucket` as the bucket identifier. */
      bindingName: string;
      prefix?: string;
      mountPath: string;
    }
  | {
      mode: 's3';
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      prefix?: string;
      provider?: 'r2' | 's3' | 'gcs';
      mountPath: string;
    };

const R2_BINDING_NAME = 'SANDBOX_WORKSPACE_R2_BUCKET';

function resolveWorkspaceMountConfig(env: Env): WorkspaceMountConfig | null {
  const mountPath = env.SANDBOX_WORKSPACE_MOUNT_PATH?.trim() || DEFAULT_WORKSPACE_MOUNT_PATH;
  const prefix = env.SANDBOX_WORKSPACE_S3_PREFIX?.trim();

  // Preferred path: a real R2 binding is wired ([[r2_buckets]] in
  // wrangler.toml). No S3 access keys required — the Sandbox Durable Object
  // resolves the binding itself via credential-less egress interception.
  if (env.SANDBOX_WORKSPACE_R2_BUCKET) {
    return { mode: 'r2-binding', bindingName: R2_BINDING_NAME, prefix, mountPath };
  }

  // Fallback: generic S3-compatible endpoint (e.g. local Supabase Storage's
  // S3-compatible endpoint for dev, or an external R2/S3 endpoint reached via
  // access keys instead of a native binding).
  const endpoint = env.SANDBOX_WORKSPACE_S3_ENDPOINT?.trim();
  const bucket = env.SANDBOX_WORKSPACE_S3_BUCKET?.trim();
  const accessKeyId = env.SANDBOX_WORKSPACE_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.SANDBOX_WORKSPACE_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  const providerRaw = env.SANDBOX_WORKSPACE_S3_PROVIDER?.trim().toLowerCase();
  const provider = providerRaw === 'r2' || providerRaw === 'gcs' ? providerRaw : 's3';

  return {
    mode: 's3',
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    prefix,
    provider,
    mountPath,
  };
}

/**
 * Ensure the S3-compatible workspace bucket is mounted into the sandbox
 * container at `mountPath` (default `/workspace`), scoped to a per-sandbox
 * prefix so each user/project pair gets an isolated workspace inside a
 * shared bucket.
 *
 * No-ops when the workspace bucket env vars are not configured (local dev
 * without a wired S3 backend). Idempotent: `mountBucket` throwing an
 * "already mounted"/"in use" style error for the same path is treated as
 * success rather than a fatal error, since the mount can legitimately
 * survive across a re-preview of an already-running sandbox.
 *
 * Seeding: when the mounted workspace prefix is empty (first preview for a
 * sandbox), seeds it from the repo's project template so the S3 bucket
 * becomes the source of truth for all subsequent sessions. In `r2-binding`
 * mode this decision is made ATOMICALLY via `./workspace-seed`'s
 * `seedWorkspaceIfAbsent` (R2 conditional-put sentinel) rather than a
 * container-side `ls -A` check-then-act — see that module's doc comment for
 * the race it closes.
 *
 * The mounted prefix MUST resolve to the write path's key scheme EXACTLY
 * or the mount will be empty even though the project has real files in R2:
 * `apps/web/client/src/server/lib/project-files-adapter.ts`'s
 * `getProjectBranchScope()` computes object keys as
 * `${projectId}/branches/${branch}/${relativePath}` — no leading slash
 * (mirrored in `azure-blob.ts`, `r2-transport.ts`,
 * `worker-proxy-transport.ts`). It is NOT derived from the sandbox's
 * Durable Object id (`sandboxId` / `guac-<userId16>-<projectId16>`) — that
 * id is truncated/sanitized for DO naming and was never the write path's
 * key scheme.
 *
 * The `prefix` passed to `mountBucket()` below DOES carry a leading slash
 * (`/${projectId}/branches/${branch}`) — that's a hard requirement of the
 * `@cloudflare/sandbox` SDK itself (`mountBucket` throws
 * `InvalidMountConfigError: Prefix must start with '/'` otherwise). The SDK
 * strips that leading slash internally before touching R2 (see
 * `normalizeObjectKey()` in the SDK's R2-egress interception layer), so the
 * ACTUAL R2 key prefix used for every list/get/put through this mount is
 * `${projectId}/branches/${branch}` — character-for-character identical to
 * `getProjectBranchScope()`'s `prefix` field, despite the literal argument
 * string differing by that one required leading character.
 */
async function ensureWorkspaceMount(
  sandbox: Sandbox<unknown> & EzilWorkspacePersistRpc,
  env: Env,
  { projectId, branch }: { projectId: string; branch: string },
): Promise<{ mounted: boolean; mountPath?: string; detail?: string }> {
  const config = resolveWorkspaceMountConfig(env);
  if (!config) return { mounted: false, detail: 'workspace_bucket_not_configured' };

  // Leading slash required by `mountBucket()`'s own validation (kept for the
  // `s3` fallback branch below) / `seedWorkspaceIfAbsent`'s `mountPrefix`
  // contract (see that module's doc comment) — stripped internally before it
  // ever reaches R2, so the real object-key prefix still matches the write
  // path exactly.
  const prefix = config.prefix ?? `/${projectId}/branches/${branch}`;

  if (config.mode === 'r2-binding') {
    // R2-binding mode NO LONGER MOUNTS ANYTHING: `mountBucket()`'s s3fs mount
    // silently drops every second write (Cloudflare's own in-DO R2 emulator discards
    // `x-amz-meta-*` on its copy-based metadata-update path — no upgrade of
    // `@cloudflare/sandbox` fixes it). `/workspace` is now plain local disk;
    // R2 is reached only through this Worker's own R2 BINDING, which never
    // goes through that emulator. See `ensureWorkspaceHydratedFromR2`.
    return ensureWorkspaceHydratedFromR2(sandbox, env.SANDBOX_WORKSPACE_R2_BUCKET, config.mountPath, prefix);
  }

  // ── Generic S3-compatible fallback (local dev / no native R2 binding) ─────
  // Unaffected by the R2-egress-emulator bug above (a REAL external
  // S3-compatible endpoint, e.g. local Supabase Storage, does not run through
  // Cloudflare's in-DO R2 emulation layer), so this branch is deliberately
  // left mounting via s3fs exactly as before.
  const MOUNT_ATTEMPTS = 4;
  let mountErr = '';
  let mounted = false;
  for (let attempt = 1; attempt <= MOUNT_ATTEMPTS; attempt++) {
    try {
      await sandbox.mountBucket(config.bucket, config.mountPath, {
        endpoint: config.endpoint,
        provider: config.provider,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        prefix,
        s3fsOptions: ['nonempty'],
      });
      mounted = true;
      break;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Idempotent re-preview: mounting the same path twice is not fatal.
      if (/already (mounted|in use)/i.test(message)) {
        mounted = true;
        break;
      }
      mountErr = message;
      if (attempt < MOUNT_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 750 * attempt));
      }
    }
  }
  if (!mounted) {
    return { mounted: false, detail: `mount_failed_after_${MOUNT_ATTEMPTS}_attempts: ${mountErr}` };
  }

  // Fallback for the generic S3-compatible mode only (local dev / no native
  // R2 binding to run an atomic conditional put against — production always
  // resolves to `r2-binding` mode, see `resolveWorkspaceMountConfig`). No
  // atomic "put only if absent" primitive is available here without adding a
  // raw S3 client, so this keeps the previous check-then-act behavior and
  // its residual (non-production) race window.
  try {
    const check = await sandbox.exec(`[ -z "$(ls -A ${config.mountPath} 2>/dev/null)" ] && echo empty || echo seeded`);
    if (check.stdout?.trim() === 'empty') {
      const copyResult = await sandbox.exec(buildTemplateCopyCommand(config.mountPath));
      if (templateWasMissing(copyResult.stdout)) {
        // Loud, not silent: the previous `[ -d ... ] && ... || true` guard
        // swallowed this exact case for weeks — a missing baked-in template
        // meant every new workspace booted to a silently empty desktop. Boot
        // still must not fail on it (see workspace-seed.ts's doc comment),
        // but it must never again pass without a trace in `wrangler tail`.
        console.error(
          `[ensureWorkspaceMount] LOUD: /opt/ezil-sandbox-template is missing from this container image — workspace at ${config.mountPath} was left EMPTY instead of seeded with starter files. The image was built without the template baked in; check the Dockerfile's COPY step.`,
        );
      }
    }
  } catch (err) {
    // Seeding is best-effort; a failure here should not block the preview.
    return {
      mounted: true,
      mountPath: config.mountPath,
      detail: `seed_check_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { mounted: true, mountPath: config.mountPath };
}

/**
 * Best-effort RPC to record this hydrate attempt's outcome on the sandbox's
 * own Durable Object (`EzilSandboxDO.recordWorkspaceHydration`, defined right
 * below). This is what gates the periodic flush loop — a failure to record
 * MUST be logged loudly (never swallowed), but must not fail the preview
 * itself: worst case the flush loop simply never starts for this sandbox
 * (safe — no data loss, just no background persistence until the next
 * successful `ensureWorkspaceMount` call records it).
 */
async function recordHydrationOutcome(
  sandbox: Sandbox<unknown> & EzilWorkspacePersistRpc,
  prefix: string,
  mountPath: string,
  hydrated: boolean,
): Promise<void> {
  try {
    await sandbox.recordWorkspaceHydration({ prefix, mountPath, hydrated });
  } catch (err) {
    console.error(
      `[ensureWorkspaceMount] recordWorkspaceHydration RPC failed (hydrated=${hydrated}, prefix=${prefix}) — the periodic flush loop may not start/update for this sandbox: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Populate `/workspace` (plain local container disk — see `ensureWorkspaceMount`
 * above for why this replaced `mountBucket()`) from the R2 workspace bucket,
 * or template-seed it when the project/branch prefix is genuinely empty.
 *
 * Idempotent PER CONTAINER GENERATION via a local-disk marker file
 * (`HYDRATE_MARKER_FILENAME`): local disk resets whenever the container is
 * evicted/recreated, so "does the marker already exist" correctly answers
 * "has THIS running container already hydrated this exact prefix" — the
 * same question the old s3fs mount's own "already mounted" idempotency check
 * answered, without ever trusting Durable Object storage (which SURVIVES
 * container recreation, and would therefore give a stale "yes" for a fresh,
 * empty disk) to answer it.
 *
 * `mounted:false` is reserved for "could not reach/list R2 at all" (the
 * direct analogue of the old `mount_failed` case). A partially-successful
 * hydrate (some individual files failed) still returns `mounted:true` — the
 * container has SOME usable content — but is recorded as hydration-INCOMPLETE
 * via `recordHydrationOutcome`, which strictly gates the flush loop (see that
 * function and `./workspace-persist`'s `flushWorkspaceToR2` doc comment: "if
 * hydration fails or is incomplete, do not flush at all").
 */
async function ensureWorkspaceHydratedFromR2(
  sandbox: Sandbox<unknown> & EzilWorkspacePersistRpc,
  bucket: R2Bucket | undefined,
  mountPath: string,
  mountPrefix: string,
): Promise<{ mounted: boolean; mountPath?: string; detail?: string }> {
  if (!bucket) return { mounted: false, detail: 'workspace_bucket_not_configured' };

  const realPrefix = realR2KeyPrefix(mountPrefix);
  const markerPath = `${mountPath}/${HYDRATE_MARKER_FILENAME}`;
  const hydrateT0 = Date.now();
  bootLog('workspace_hydrate', 'start');

  let marker: ReturnType<typeof parseHydrateMarker> = null;
  try {
    const existsRes = await sandbox.exists(markerPath);
    if (existsRes.exists) {
      const read = await sandbox.readFile(markerPath, { encoding: 'utf-8' });
      marker = parseHydrateMarker(read.content);
    }
  } catch (err) {
    console.error(
      `[ensureWorkspaceMount] hydrate marker read failed (path=${markerPath}) — proceeding as unhydrated: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (marker && marker.prefix === realPrefix && marker.mountPath === mountPath) {
    bootLog('workspace_hydrate', 'end', {
      status: 'skipped',
      detail: 'already_hydrated_this_container',
      phaseMs: Date.now() - hydrateT0,
    });
    await recordHydrationOutcome(sandbox, realPrefix, mountPath, true);
    return { mounted: true, mountPath, detail: 'already_hydrated' };
  }
  if (marker) {
    // Loud, not silent: this local disk was already hydrated for a DIFFERENT
    // prefix. Reusing it would silently mix content across projects/branches
    // — refuse rather than guess. (This container should not be reachable
    // for a different prefix in normal operation; if it happens, it means a
    // container was reused across sandboxIds/branches unexpectedly.)
    console.error(
      `[ensureWorkspaceMount] LOUD: workspace prefix mismatch — this container's local disk was already hydrated for prefix=${marker.prefix} but this request wants prefix=${realPrefix}. Refusing to reuse it.`,
    );
    bootLog('workspace_hydrate', 'end', { status: 'error', detail: 'prefix_mismatch', phaseMs: Date.now() - hydrateT0 });
    await recordHydrationOutcome(sandbox, realPrefix, mountPath, false);
    return { mounted: false, detail: 'workspace_prefix_mismatch' };
  }

  const copyTemplate = async () => {
    const result = await sandbox.exec(buildTemplateCopyCommand(mountPath));
    if (templateWasMissing(result.stdout)) {
      // Loud, not silent: the previous `[ -d ... ] && ... || true` guard
      // swallowed this exact case for weeks — a missing baked-in template
      // meant every genuinely-new workspace won the seed race and then
      // copied nothing, booting to a silently empty desktop with no trace
      // anywhere. Still must not fail boot (the sentinel is already
      // committed by this point — see this function's doc comment), but it
      // must never again pass without a trace in `wrangler tail`.
      console.error(
        `[ensureWorkspaceMount] LOUD: /opt/ezil-sandbox-template is missing from this container image — new workspace at ${mountPath} was NOT seeded with starter files (boot continues). The image was built without the template baked in; check the Dockerfile's COPY step.`,
      );
    }
  };

  let hydrateOk = false;
  let listOk = true;
  let hydrateDetail = '';

  // Cheap initial emptiness probe (mirrors `seedWorkspaceIfAbsent`'s own
  // check) — decides whether to take the ATOMIC sentinel-gated template-seed
  // path (genuinely empty project) or the real hydrate-from-R2 path.
  let initialListFailed = false;
  let initiallyEmpty = false;
  try {
    const initialCheck = await bucket.list({ prefix: realPrefix, limit: 1 });
    initiallyEmpty = initialCheck.objects.length === 0;
  } catch (err) {
    initialListFailed = true;
    console.error(
      `[ensureWorkspaceMount] initial R2 emptiness check failed (prefix=${realPrefix}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (initiallyEmpty) {
    // Genuinely-empty-prefix path: ATOMIC sentinel-gated template seed
    // (unchanged from before — see `./workspace-seed`'s doc comment for the
    // full race analysis). `copyTemplate` is a pure LOCAL-DISK `cp -a` (the
    // template lives in the image at /opt/ezil-sandbox-template) — that was
    // never mount-dependent, so it needs no changes at all.
    const seedOutcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix,
      copyTemplate,
      log: (message) => console.error(message),
    });
    if (seedOutcome.seeded) {
      hydrateOk = true;
      hydrateDetail = 'seeded';
    }
    // Any `seeded:false` reason (lost_race / not_empty / list_failed /
    // sentinel_put_failed / copy_failed) falls through to a real
    // hydrate-from-R2 pass below instead of leaving local disk empty on a
    // bare skip: either a concurrent winner now has real content in R2
    // (lost_race/not_empty), or we could not safely determine emptiness, or
    // the sentinel/copy step itself failed. Reflecting whatever R2
    // authoritatively holds right now is strictly safer than doing nothing.
  }

  if (!hydrateOk) {
    const outcome = await hydrateWorkspaceFromR2({
      bucket,
      container: sandbox,
      realPrefix,
      mountPath,
      log: (message) => console.error(message),
    });
    hydrateOk = outcome.ok;
    listOk = outcome.listOk && !initialListFailed;
    hydrateDetail = outcome.ok
      ? outcome.emptyPrefix
        ? 'hydrated_empty'
        : `hydrated:${outcome.filesWritten}`
      : `hydrate_incomplete:written=${outcome.filesWritten},failed=${outcome.filesFailed},listOk=${outcome.listOk}`;
  }

  bootLog('workspace_hydrate', 'end', {
    status: hydrateOk ? 'ok' : 'error',
    phaseMs: Date.now() - hydrateT0,
    detail: hydrateDetail,
  });

  if (hydrateOk) {
    try {
      await sandbox.mkdir(mountPath, { recursive: true });
      await sandbox.writeFile(
        markerPath,
        serializeHydrateMarker({ prefix: realPrefix, mountPath, hydratedAt: new Date().toISOString() }),
      );
    } catch (err) {
      // Best-effort: if the marker write fails, a LATER preview call against
      // this same (still-warm) container will simply re-hydrate — wasteful,
      // never unsafe (hydrate only ever writes from R2's own truth).
      console.error(
        `[ensureWorkspaceMount] hydrate marker write failed (path=${markerPath}) — a later call on this container will re-hydrate: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  await recordHydrationOutcome(sandbox, realPrefix, mountPath, hydrateOk);

  return {
    // `mounted:false` reserved for "couldn't reach/list R2 at all" (the
    // direct analogue of the old `mount_failed`); a partial per-file failure
    // still leaves a usable (if incomplete) workspace on disk, so the
    // preview/dev-server tooling downstream is allowed to use it — the flush
    // gate above (`recordHydrationOutcome`) is the strict signal instead.
    mounted: listOk,
    mountPath,
    detail: hydrateDetail,
  };
}

// ── Durable Object storage keys (EzilSandboxDO) ──────────────────────────────
const WORKSPACE_FLUSH_CONTEXT_KEY = 'ezil:workspaceFlushContext';
const WORKSPACE_HYDRATED_KEY = 'ezil:workspaceHydrated';
const WORKSPACE_FLUSH_LOOP_STARTED_KEY = 'ezil:workspaceFlushLoopStarted';

interface WorkspaceFlushContext {
  /** R2 key prefix, NO leading slash — e.g. `${projectId}/branches/${branch}`. */
  prefix: string;
  /** Absolute in-container path, e.g. `/workspace`. */
  mountPath: string;
}

/**
 * Periodic flush interval.
 *
 * Trade-off: shorter = smaller eviction-window data-loss exposure, at the
 * cost of more Durable Object CPU/wall time spent walking the workspace tree
 * every cycle. 10 SECONDS is chosen because:
 *   - The status quo (the s3fs mount this replaces) has UNBOUNDED exposure —
 *     a dropped write can be lost forever with no time bound at all, silently
 *     (0 bytes, exit 0). Any finite interval is a strict improvement; the
 *     task's own framing ("even 10s strictly dominates the status quo")
 *     matches that reasoning.
 *   - In practice the real exposure window is usually much smaller than 10s:
 *     an explicit flush also runs immediately before the `/sandbox/preview`
 *     response hands control back to the caller and immediately before
 *     `DELETE /sandbox/:name` calls `destroy()` (see `handlePreview` /
 *     `handleTerminate`) — the alarm-driven 10s cadence only matters for an
 *     UNCLEAN teardown (crash/OOM/eviction) that skips both of those.
 *   - Cost per cycle is bounded by the manifest short-circuit
 *     (`computeFlushPlan`): a steady-state cycle with no changed files still
 *     walks the (ignore-list-pruned, so typically small — source files only,
 *     no `node_modules`) directory tree once, but uploads nothing. A handful
 *     of `listFiles`/`readFile` RPCs every 10s is well within normal DO
 *     request-driven CPU accounting (this is not a busy-loop; each cycle is
 *     one bounded unit of work dispatched via `schedule()`, not a persistent
 *     process).
 */
const WORKSPACE_FLUSH_INTERVAL_SECONDS = 10;

/**
 * The Durable Object class backing each sandbox container.
 *
 * Extends the SDK's own `Sandbox` class — no new transport, no new daemon —
 * adding exactly the workspace-persistence bookkeeping the hydrate/flush
 * replacement for `mountBucket()` needs:
 *
 *   - `recordWorkspaceHydration()` — called once per hydrate attempt from
 *     `ensureWorkspaceHydratedFromR2` above (success OR failure). Remembers
 *     `{prefix, mountPath}` + the hydration-success flag in DO STORAGE
 *     (survives container eviction even though the container filesystem does
 *     not), and — ONLY once hydration has actually succeeded, and only once
 *     per DO lifetime — starts the self-rescheduling flush loop via the
 *     `@cloudflare/containers` SDK's own `schedule()` primitive. This
 *     deliberately does NOT override `alarm()` (the SDK reserves that for
 *     container-lifecycle keepalive — see the `@cloudflare/containers`
 *     README: "Instead of using the default alarm handler, use `schedule()`
 *     instead").
 *   - `flushWorkspaceScheduled()` — the callback name `schedule()` invokes.
 *     Runs one flush pass then reschedules itself UNCONDITIONALLY (a failed
 *     cycle must not kill the loop — failures are logged loudly via
 *     `bootLog`/`console.error`, never swallowed).
 *   - `flushWorkspaceNow()` — the same flush pass, called directly by the
 *     Worker (an ordinary Durable Object RPC — the same call style as the
 *     pre-existing `sandbox.exec()`) for the two EXPLICIT flush points this
 *     change adds: immediately before `/sandbox/preview` hands the ready URL
 *     back to the caller, and immediately before `DELETE /sandbox/:name`
 *     calls `destroy()` (see `handlePreview` / `handleTerminate`).
 *
 * `class_name = "Sandbox"` in wrangler.toml binds to whatever this module
 * exports under the name `Sandbox` — exporting THIS subclass under that exact
 * name (see `export { EzilSandboxDO as Sandbox }` below) requires ZERO
 * wrangler.toml / migration changes: the underlying DO storage class
 * identity is unchanged, only new methods are added on top of it.
 */
class EzilSandboxDO extends CFSandboxClass<Env> {
  /** Read the flush-manifest cache from local disk. Missing/corrupt -> empty (safe: just re-uploads everything once). */
  private async readFlushManifest(mountPath: string): Promise<FlushManifest> {
    const manifestPath = `${mountPath}/${FLUSH_MANIFEST_FILENAME}`;
    try {
      const exists = await this.exists(manifestPath);
      if (!exists.exists) return {};
      const read = await this.readFile(manifestPath, { encoding: 'utf-8' });
      return parseFlushManifest(read.content);
    } catch (err) {
      console.error(
        `[workspace_flush] manifest read failed (path=${manifestPath}) — starting from an empty manifest this cycle: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {};
    }
  }

  private async writeFlushManifest(mountPath: string, manifest: FlushManifest): Promise<void> {
    const manifestPath = `${mountPath}/${FLUSH_MANIFEST_FILENAME}`;
    try {
      await this.writeFile(manifestPath, serializeFlushManifest(manifest));
    } catch (err) {
      console.error(
        `[workspace_flush] manifest write failed (path=${manifestPath}) — the NEXT cycle may re-upload unchanged files (wasteful, not unsafe): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async runWorkspaceFlush(trigger: 'alarm' | 'explicit'): Promise<FlushOutcome> {
    const t0 = Date.now();
    bootLog('workspace_flush', 'start', { detail: `trigger=${trigger}` });

    const wctx = await this.ctx.storage.get<WorkspaceFlushContext>(WORKSPACE_FLUSH_CONTEXT_KEY);
    if (!wctx) {
      bootLog('workspace_flush', 'end', { status: 'skipped', detail: `no_context,trigger=${trigger}`, phaseMs: Date.now() - t0 });
      return { ok: false, uploaded: [], skippedUnchanged: 0, skippedIgnored: 0, skippedUnsupported: 0, failed: [], manifest: {}, heartbeatWritten: false };
    }

    const hydrated = (await this.ctx.storage.get<boolean>(WORKSPACE_HYDRATED_KEY)) ?? false;
    const bucket = this.env.SANDBOX_WORKSPACE_R2_BUCKET;
    if (!bucket) {
      bootLog('workspace_flush', 'end', { status: 'skipped', detail: `no_r2_binding,trigger=${trigger}`, phaseMs: Date.now() - t0 });
      return { ok: false, uploaded: [], skippedUnchanged: 0, skippedIgnored: 0, skippedUnsupported: 0, failed: [], manifest: {}, heartbeatWritten: false };
    }

    const manifest = await this.readFlushManifest(wctx.mountPath);
    const outcome = await flushWorkspaceToR2({
      container: this,
      bucket,
      mountPath: wctx.mountPath,
      realPrefix: wctx.prefix,
      manifest,
      hydrationComplete: hydrated,
      log: (message) => console.error(`[workspace_flush] ${message}`),
    });
    // Persist the updated manifest even on a partial failure — the entries
    // for files that DID upload successfully must not be re-uploaded next
    // cycle; only the failed ones are (deliberately) absent from
    // `outcome.manifest` so they retry.
    await this.writeFlushManifest(wctx.mountPath, outcome.manifest);

    bootLog('workspace_flush', 'end', {
      status: outcome.ok ? 'ok' : outcome.skippedReason ? 'skipped' : 'error',
      phaseMs: Date.now() - t0,
      detail: `trigger=${trigger},uploaded=${outcome.uploaded.length},failed=${outcome.failed.length},unchanged=${outcome.skippedUnchanged},ignoredDirs=${outcome.skippedIgnored},hydrated=${hydrated},heartbeat=${outcome.heartbeatWritten}${
        outcome.skippedReason ? `,reason=${outcome.skippedReason}` : ''
      }`,
    });
    if (outcome.failed.length > 0) {
      for (const f of outcome.failed) {
        console.error(`[workspace_flush] upload_failed relPath=${f.relPath} error=${f.error}`);
      }
    }
    return outcome;
  }

  /**
   * Called by `ensureWorkspaceHydratedFromR2` after EVERY hydrate attempt
   * (success or failure) — never only on success, so a later failed
   * re-hydrate correctly flips the gate back off instead of leaving a stale
   * `true` from a previous container generation.
   */
  async recordWorkspaceHydration(params: { prefix: string; mountPath: string; hydrated: boolean }): Promise<void> {
    await this.ctx.storage.put(WORKSPACE_FLUSH_CONTEXT_KEY, { prefix: params.prefix, mountPath: params.mountPath });
    await this.ctx.storage.put(WORKSPACE_HYDRATED_KEY, params.hydrated);
    if (!params.hydrated) return;

    const started = (await this.ctx.storage.get<boolean>(WORKSPACE_FLUSH_LOOP_STARTED_KEY)) ?? false;
    if (started) return; // loop already running (or a schedule is already pending) — do not double-schedule

    await this.ctx.storage.put(WORKSPACE_FLUSH_LOOP_STARTED_KEY, true);
    try {
      await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, 'flushWorkspaceScheduled');
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=schedule_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
      // Allow a later successful hydrate to retry starting the loop instead
      // of permanently believing (incorrectly) that it is already running.
      await this.ctx.storage.put(WORKSPACE_FLUSH_LOOP_STARTED_KEY, false);
    }
  }

  /** The `schedule()` callback — self-perpetuating: always reschedules, even after a failed cycle. */
  async flushWorkspaceScheduled(): Promise<void> {
    await this.runWorkspaceFlush('alarm');
    try {
      await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, 'flushWorkspaceScheduled');
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=reschedule_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Explicit, on-demand flush — see class doc comment for the two call sites. */
  async flushWorkspaceNow(): Promise<FlushOutcome> {
    return this.runWorkspaceFlush('explicit');
  }
}

export { EzilSandboxDO as Sandbox };

/**
 * Turn the raw exposed-port base URL into the embeddable Apache Guacamole client
 * URL.
 * - Matches the protocol to the incoming request (http for local wrangler dev,
 *   https in production) so the iframe doesn't attempt TLS against a plain-HTTP
 *   local origin.
 * - Points at the container root (`/`), whose Guacamole-branded landing page
 *   authenticates the preview user via the Guacamole REST API and deep-links
 *   straight into the genuine Guacamole HTML5 client
 *   (`/guacamole/#/client/<id>?token=…`). No noVNC/websockify is involved.
 */
function toGuacamoleUrl(exposedUrl: string, requestProtocol: string): string {
  const u = new URL(exposedUrl);
  u.protocol = requestProtocol;
  u.pathname = '/';
  u.search = '';
  return u.toString();
}

/**
 * Normalize a request's `Host` for use as the `@cloudflare/sandbox` SDK's
 * preview-URL `hostname` option (`exposePort`/`getExposedPorts`).
 *
 * The SDK builds the preview URL by assigning
 * `` `${port}-${sandboxId}-${token}.${host}` `` to `URL.hostname`. Per the
 * WHATWG URL host-parsing algorithm, a hostname that "ends in a number" is
 * parsed as an IPv4 address; a bare-IP host like `127.0.0.1` makes the
 * *composed* string (e.g. `8080-guac-x-desktop.127.0.0.1`) a 5-label
 * candidate, which fails IPv4 parsing (max 4 labels). A failed host-setter
 * assignment is a silent no-op per spec — so with a `127.0.0.1` host the
 * preview URL is left as the original flat `http://127.0.0.1:8787/`,
 * pointing at the Worker root instead of the exposed container port, and is
 * therefore un-proxyable (`proxyToSandbox` requires the subdomain form and
 * a full re-parse of that composed string throws `Invalid URL` outright).
 *
 * `localhost` does not end in a number, so it is unaffected by this — and
 * is exactly what this README's own local quick-start already documents
 * (`http://localhost:8787`), so this only repairs the direct-IP edge case
 * without changing the documented/production hostname path.
 *
 * Zone-root collapse: Cloudflare Universal SSL (the free, no-purchase cert a
 * zone here would rely on) only covers the zone apex plus ONE wildcard label
 * — it does NOT cover a second-level wildcard like `*.os.<zone>`. Verified
 * empirically against `ezil.work` while that zone was still in use here: its
 * certificate pack listed exactly `['ezil.work', '*.ezil.work']`, an SNI
 * handshake for `probe123.ezil.work` succeeded, and one for `a.b.ezil.work`
 * failed with TLS alert 40 (handshake_failure) — the same one-label-only
 * limit applies to whatever zone replaces it. The SDK composes preview
 * hostnames as `${port}-${sandboxId}-${token}.${host}`, so if an inbound API
 * request itself already arrives on a single-label `*.<zone>` subdomain
 * (e.g. an API entrypoint like `os.<zone>`), passing that host straight
 * through would produce a two-level preview hostname with no valid
 * certificate. To guarantee every preview URL is a single label under the
 * zone (`<port>-<sandboxId>-<token>.<zone>`), any inbound host under
 * `PREVIEW_ZONE_ROOT` is collapsed to the bare zone root before being handed
 * to `exposePort`/`getExposedPorts`.
 *
 * PREVIEW_ZONE_ROOT must stay in lockstep with the `[[routes]]` block in
 * `wrangler.toml` — if they disagree, every preview URL points at a hostname
 * this Worker is not routed on. `index.test.ts` has a drift guard that reads
 * `wrangler.toml` and asserts both the zone and that every `portFor`/
 * `appPortFor` token has a matching route pattern.
 *
 * 2026-07-31 correction — PREVIEW_ROUTES_DISABLED: this used to be
 * `'ezil.work'`, the company's main production website, routed there by
 * mistake. The owner said not to touch it; those routes and their DNS
 * records have been removed from Cloudflare (see `wrangler.toml`'s matching
 * comment for the removal record and why the obvious alternatives —
 * `ezil.org` (owned by the production `cf-guacamole-sandbox` Worker) and
 * `zlsocial.ai` (independently re-verified live: proxied apex site + a bare
 * `*.zlsocial.ai` wildcard tunnel catch-all + several more live tunnels) —
 * are not safe replacements either. `unset.invalid` is an RFC 2606 reserved,
 * never-resolvable placeholder: it keeps this constant a truthy, non-
 * `.workers.dev` literal (so it still typechecks and satisfies the "declares
 * a literal" drift-guard test) without referencing any real zone. There are
 * currently zero `[[routes]]` in `wrangler.toml`, so this code path never
 * actually matches a live request either way. Restore a real zone here (and
 * in `wrangler.toml`) once one is verified genuinely unused.
 */
const PREVIEW_ZONE_ROOT = 'unset.invalid';

function normalizeSandboxHostname(host: string): string {
  const [hostname, port] = host.split(':');
  if (hostname === '0.0.0.0' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return port ? `localhost:${port}` : 'localhost';
  }
  if (
    hostname === PREVIEW_ZONE_ROOT ||
    hostname.endsWith(`.${PREVIEW_ZONE_ROOT}`)
  ) {
    return port ? `${PREVIEW_ZONE_ROOT}:${port}` : PREVIEW_ZONE_ROOT;
  }
  return host;
}

// ── Cloudflare Realtime TURN — ephemeral credential generation ───────────────

/**
 * Mint short-lived, per-session TURN credentials from the long-lived Cloudflare
 * Realtime TURN key. The api token is read from env by NAME and used only as an
 * `Authorization: Bearer` header — it is NEVER logged, returned in an API
 * response, or interpolated into a shell command. The returned ephemeral
 * `iceServers` (bounded TTL) are the only thing that reaches the sandbox.
 *
 * Returns `null` when no Cloudflare TURN key is configured (caller then falls
 * back to any static `SANDBOX_NEKO_TURN_URLS`, or fails closed upstream via
 * `checkIceConfig`). Throws with a non-secret error on an API failure so the
 * caller can fail closed rather than launch a relay-less (hanging) session.
 */
async function generateTurnCredentials(env: Env): Promise<IceServerEntry[] | null> {
  const keyId = env.SANDBOX_NEKO_TURN_KEY_ID?.trim();
  const apiToken = env.SANDBOX_NEKO_TURN_API_TOKEN?.trim();
  if (!keyId || !apiToken) return null;

  const ttl = resolveTurnTtlSeconds(env.SANDBOX_NEKO_TURN_TTL_SECONDS);
  let res: Response;
  try {
    res = await fetch(turnGenerateUrl(keyId), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    });
  } catch (err) {
    // Never include the token in the surfaced error.
    throw new Error(`turn_credentials_request_failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    // Status only — response bodies from the credential API do not echo the
    // token, but keep the surfaced detail minimal and non-secret regardless.
    throw new Error(`turn_credentials_http_${res.status}`);
  }

  let body: TurnCredentialsResponse;
  try {
    body = (await res.json()) as TurnCredentialsResponse;
  } catch (err) {
    throw new Error(`turn_credentials_bad_json: ${err instanceof Error ? err.message : String(err)}`);
  }

  const servers = normalizeIceServers(body);
  if (servers.length === 0) {
    throw new Error('turn_credentials_empty: Cloudflare returned no iceServers');
  }
  return servers;
}

/**
 * Resolve the neko WebRTC ICE env (frontend/backend JSON + icelite/icetrickle)
 * for a `neko`-mode preview, minting Cloudflare ephemeral credentials when a
 * TURN key is configured. Falls back to a static pre-shared `SANDBOX_NEKO_TURN_URLS`
 * set (no username/credential) when only that is configured. Returns `null`
 * when neither is configured (diagnostic/no-TURN path — behavior unchanged).
 */
async function resolveNekoIceEnv(env: Env): Promise<Record<string, string> | null> {
  const cloudflare = await generateTurnCredentials(env);
  if (cloudflare) return buildNekoIceEnv(cloudflare);

  const staticUrls = env.SANDBOX_NEKO_TURN_URLS?.trim();
  if (staticUrls) {
    const urls = staticUrls.split(',').map((u) => u.trim()).filter(Boolean);
    return buildNekoIceEnv([{ urls }]);
  }
  return null;
}

// ── Request handlers ──────────────────────────────────────────────────────────

interface PreviewBody {
  sessionId?: string;
  userId?: string;
  projectId?: string;
  /**
   * Project branch whose R2-backed workspace should be mounted. MUST match
   * the branch the write path (EBuilder's `ProjectFilesAdapter` /
   * `getProjectBranchScope()`) is using for this project, or the mounted R2
   * prefix will not contain the files the user actually wrote.
   *
   * Optional only for backward compatibility with callers that predate this
   * field; when absent, `handlePreview` defaults it to `'main'` explicitly
   * (see below) rather than silently mounting an arbitrary prefix.
   */
  branch?: string;
  token?: string;
  withAngularSmoke?: boolean;
  /** Optional runtime mode selector. Defaults to 'guacamole' (unchanged behavior). */
  desktopMode?: string;
  /**
   * Opaque, sealed workspace-startup delivery envelope (serialized JSON string),
   * minted server-side by the EBuilder API. When present (neko mode only), it is
   * forwarded VERBATIM into the container startup ENVIRONMENT
   * (`EZIL_WORKSPACE_STARTUP_DELIVERY`) — never onto a command line / argv — so
   * the in-container bootstrap can hydrate `/home/neko/project` before readiness.
   * This value carries a short-lived capability + nonce: it is NEVER logged,
   * echoed into any response body, or added to a lifecycle timeline.
   */
  startupDelivery?: string;
}

async function handlePreview(request: Request, env: Env, url: URL): Promise<Response> {
  // Correlate every stage of this preview request under one id. Prefer an
  // inbound request id header so the browser/web-API and Worker timelines
  // stitch together; otherwise mint a fresh one.
  const correlationId =
    request.headers.get('x-request-id')?.trim() ||
    request.headers.get('x-correlation-id')?.trim() ||
    newCorrelationId();

  let body: PreviewBody = {};
  try {
    body = (await request.json()) as PreviewBody;
  } catch {
    const tl = new LifecycleTimeline({ correlationId });
    tl.event('web_api', 'sandbox.preview.received', 'error', { error: 'invalid_json_body:' });
    return json({ ok: false, error: 'invalid_json_body' }, 400);
  }

  const tl = new LifecycleTimeline({
    correlationId,
    projectId: body.projectId,
    userId: body.userId,
  });
  tl.event('web_api', 'sandbox.preview.received', 'ok');

  const authDone = tl.stage('project_authorization', 'sandbox.preview.authorize');
  const auth = await verifyPreviewToken(body.token, resolvePreviewSecrets(env));
  if (!auth.ok) {
    authDone('error', auth.error);
    return json({ ok: false, error: auth.error }, 401);
  }
  authDone('ok');

  // The scope id (historically always a projectId; also a computer id since
  // the "your computers" pivot) feeds the R2 workspace mount prefix directly
  // (`workspaceProjectId` below) and is NOT user-namespaced on its own — it is
  // only safe because it is scoped to the authenticated caller's own
  // workspace. A caller that omits it must be REJECTED, not silently routed
  // to a shared `'default'` prefix: that fallback was a cross-tenant data
  // leak (any two callers who both omitted projectId landed on the exact
  // same globally-shared R2 prefix, `/default/branches/<branch>`). There is
  // no legitimate omission case — every real EBuilder caller
  // (`cloudflareGuacamole.previewUrl`) always sends the authenticated user's
  // project/computer id (see `main.tsx`'s `editorEngine.projectId`, which is
  // a non-optional `string`).
  const scopeId = body.projectId?.trim();
  if (!scopeId) {
    tl.event('web_api', 'sandbox.preview.missing_scope_id', 'error', {
      error: 'missing_project_id',
    });
    return json({ ok: false, error: 'missing_project_id' }, 400);
  }

  const modeResult = resolveDesktopMode(body.desktopMode, env.SANDBOX_DEFAULT_DESKTOP_MODE);
  if (!modeResult.ok) {
    tl.event('web_api', 'sandbox.preview.resolve_mode', 'error', { error: modeResult.error });
    return json({ ok: false, error: modeResult.error }, 400);
  }
  const mode = modeResult.mode;

  let iceEnv: Record<string, string> | null = null;
  if (mode === 'neko') {
    const ice = checkIceConfig(env);
    if (!ice.ok) {
      // Fail closed rather than silently degrading to STUN-only media, which
      // would hang indefinitely for clients behind symmetric NAT.
      return json({ ok: false, error: ice.error, mode }, 412);
    }
    // When a TURN provider is configured, mint per-session ephemeral
    // credentials NOW and pass them into the sandbox. A generation failure is
    // fatal for a relay-requiring policy (fail closed) but non-fatal for the
    // default diagnostic policy (which tolerates a relay-less session).
    if (hasTurnConfigured(env)) {
      try {
        iceEnv = await resolveNekoIceEnv(env);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        if (ice.policy === 'relay' || ice.policy === 'production') {
          tl.event('preview_lifecycle', 'sandbox.preview.turn', 'error', {
            error: `turn_unavailable: ${detail}`,
          });
          return json({ ok: false, error: `turn_unavailable: ${detail}`, mode }, 502);
        }
        // diagnostic policy: proceed without relay (media stays gated).
        iceEnv = null;
      }
    }
  }

  const sandboxId = deriveSandboxId(body.userId ?? 'anon', scopeId);
  tl.setSandboxId(sandboxId);

  // The R2 workspace mount prefix is keyed on the FULL scope id + branch
  // (not the truncated/sanitized `sandboxId`) so it matches the write
  // path's key scheme exactly. `branch` defaults to 'main' EXPLICITLY here
  // — matching `getProjectBranchScope()`'s own default — rather than being
  // silently omitted, for callers that predate this field. `scopeId` is
  // guaranteed non-empty here (validated above) — there is deliberately no
  // `?? 'default'` fallback: that fallback was the cross-tenant prefix
  // hazard this change closes.
  const workspaceProjectId = scopeId;
  const workspaceBranch = body.branch?.trim() || 'main';

  // Neko auto-connect: merge the deterministic per-sandbox regular-user + admin
  // credentials into the existing `iceEnv` object so they naturally reach the
  // existing `sandbox.startProcess(..., { env })` path via `ensureDesktop` —
  // seeding `NEKO_MEMBER_MULTIUSER_{USER,ADMIN}_PASSWORD` so an authenticated
  // preview logs straight into the EZiL OS desktop instead of Neko's login
  // form. The pinned Neko build defaults `legacy` to true (the bundled client
  // requires it), and `Member.SetV2()` runs AFTER `Member.Set()` and
  // unconditionally overwrites the V3 multiuser passwords with the V2
  // `NEKO_PASSWORD` / `NEKO_PASSWORD_ADMIN` values — defaulting to `neko` /
  // `admin` when absent. So the legacy keys MUST be seeded with the same
  // derived values, or auto-connect silently reverts to the Neko defaults.
  // Derived from ONLY the primary preview HMAC binding (never the mission
  // alias); neither value is ever logged or returned in the response.
  if (mode === 'neko') {
    const nekoCreds = await deriveNekoCredentials(env, sandboxId);
    iceEnv = {
      ...(iceEnv ?? {}),
      NEKO_MEMBER_MULTIUSER_USER_PASSWORD: nekoCreds.user,
      NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: nekoCreds.admin,
      NEKO_PASSWORD: nekoCreds.user,
      NEKO_PASSWORD_ADMIN: nekoCreds.admin,
    };
  }

  tl.event('sandbox_identity', 'sandbox.preview.identity', 'ok', {
    detail: `mode=${mode} turnRelay=${Boolean(iceEnv)}`,
  });

  try {
    const sandbox = openSandbox(env, sandboxId);
    // Mount (and, on first use, seed) the S3 workspace bucket before the
    // desktop starts so any workspace-backed tooling sees files immediately.
    // Best-effort: a workspace bucket mount failure never blocks the preview
    // itself — desktop-preview mode without a persistent workspace is still
    // useful, and `workspace` in the response tells the caller what happened.
    const mountDone = tl.stage('workspace_mount', 'sandbox.preview.workspace_mount');
    const workspace = await ensureWorkspaceMount(sandbox, env, {
      projectId: workspaceProjectId,
      branch: workspaceBranch,
    });
    mountDone(
      workspace.mounted ? 'ok' : 'error',
      workspace.mounted ? undefined : workspace.detail,
      workspace.mounted ? `mountPath=${workspace.mountPath ?? ''}` : undefined,
    );

    const desktopDone = tl.stage('preview_lifecycle', 'sandbox.preview.desktop_ready');
    const { url: exposedUrl, appPreviewExpose } = await ensureDesktop(
      sandbox,
      normalizeSandboxHostname(url.host),
      mode,
      iceEnv,
      mode === 'neko' ? (body.startupDelivery ?? null) : null,
      workspace.mounted ? workspace.mountPath ?? null : null,
      env.EZIL_NEKO_CPU_DIAG_ENABLED,
    );
    const guacamoleUrl = mode === 'neko' ? exposedUrl : toGuacamoleUrl(exposedUrl, url.protocol);
    desktopDone('ok');

    // Surface (never swallow) an app-preview port exposure failure. This is
    // never fatal to the preview response itself — see `ensureDesktop`'s doc
    // comment — but it MUST be observable: logged onto the lifecycle
    // timeline here, and echoed in the response next to `workspace` so the
    // caller can see it too instead of it disappearing into a bare catch.
    if (appPreviewExpose.attempted && !appPreviewExpose.exposed) {
      tl.event('preview_lifecycle', 'sandbox.preview.app_preview_expose_failed', 'error', {
        error: appPreviewExpose.error,
      });
    }

    // EXPLICIT flush before handing the ready preview URL back to the caller
    // (in addition to the alarm-driven periodic flush — see
    // `EzilSandboxDO.flushWorkspaceNow`'s doc comment). This is the last
    // point control is inside the Worker before the browser/user takes over;
    // closing the gap here bounds the worst case to "the alarm-driven 10s
    // cadence", not "however long until the next preview call happens to run
    // ensureWorkspaceMount again". Best-effort and non-blocking-of-failure:
    // a flush error here must never fail the preview response — logged
    // loudly instead (never a bare `catch {}`).
    try {
      await sandbox.flushWorkspaceNow();
    } catch (err) {
      console.error(
        `[handlePreview] pre-handoff flushWorkspaceNow failed (sandboxId=${sandboxId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return json({
      ok: true,
      guacamoleUrl,
      expiresAt: Date.now() + SESSION_TTL_MS,
      provider: mode === 'neko' ? 'cloudflare-neko' : 'cloudflare-guacamole',
      mode,
      sandboxId,
      correlationId,
      // Report only whether a TURN relay was wired — never the credentials.
      turnRelay: mode === 'neko' ? Boolean(iceEnv) : undefined,
      workspace,
      appPreviewExpose,
    });
  } catch (err) {
    tl.event('preview_lifecycle', 'sandbox.preview.failed', 'error', { error: err });
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err), mode },
      500,
    );
  }
}

async function handleStatus(env: Env, url: URL, sandboxName: string, requestedMode?: string): Promise<Response> {
  const modeResult = resolveDesktopMode(requestedMode, env.SANDBOX_DEFAULT_DESKTOP_MODE);
  if (!modeResult.ok) {
    return json({ ok: false, error: modeResult.error }, 400);
  }
  const mode = modeResult.mode;
  try {
    const sandbox = openSandbox(env, sandboxName);
    const exposed = await sandbox.getExposedPorts(normalizeSandboxHostname(url.host));
    const { port } = portFor(mode);
    const guacamoleRunning = exposed.some((p) => p.port === port);
    return json({ ok: true, sandboxName, guacamoleRunning, mode });
  } catch (err) {
    return json(
      { ok: false, sandboxName, error: err instanceof Error ? err.message : String(err), mode },
      500,
    );
  }
}

/**
 * HMAC-gated workspace diagnostic endpoint.
 *
 * Mounts the R2/S3 workspace bucket (without launching the desktop) and
 * operates on named, allowlisted marker *slots*, each mapped to a deterministic
 * hidden file at the mount root via `DIAG_SLOT_PREFIX` (no `mkdir`). This is
 * the minimal capability needed to prove BOTH deterministic R2 persistence
 * (same-identity, same-slot digest survives explicit terminate+recreate) AND
 * A/B/C isolation (a slot written under identity A is provably ABSENT under
 * identities B/C).
 *
 * Reuses `verifyPreviewToken`'s HMAC envelope so it is gated exactly like
 * `/sandbox/preview`. Under local `wrangler dev` the FUSE mount fails with
 * `fuse: device not found`; this is validated on the Cloudflare-native runtime.
 *
 * POST /sandbox/:name/workspace-diag  { token, op?, slot? }
 *   op:  'write' | 'ensure' (default) — idempotently write the deterministic
 *          marker (preserving an existing slot), sync to backing store.
 *        'stat' | 'read' | 'absent'   — read-only; prove presence/absence.
 *   slot: allowlisted slot name (default 'default').
 *
 * Response (never includes raw file content):
 *   { ok, sandboxId, op, slot, path, workspace, exists, bytes, sha256,
 *     expectedSha256, matches, wrote, checkedAt }
 */
async function handleWorkspaceDiag(
  request: Request,
  env: Env,
  sandboxName: string,
): Promise<Response> {
  const correlationId =
    request.headers.get('x-request-id')?.trim() ||
    request.headers.get('x-correlation-id')?.trim() ||
    newCorrelationId();
  const tl = new LifecycleTimeline({ correlationId, sandboxId: sandboxName });

  let body: { token?: string; op?: string; slot?: string } = {};
  try {
    body = (await request.json()) as { token?: string; op?: string; slot?: string };
  } catch {
    // Allow an empty body — the diagnostic endpoint defaults op/slot.
  }

  const auth = await verifyPreviewToken(body.token, resolvePreviewSecrets(env));
  if (!auth.ok) {
    tl.event('project_authorization', 'sandbox.diag.authorize', 'error', { error: auth.error });
    return json({ ok: false, error: auth.error }, 401);
  }
  tl.event('project_authorization', 'sandbox.diag.authorize', 'ok');

  const parsed = parseDiagRequest(body.op, body.slot);
  if (!parsed.ok) {
    tl.event('web_api', 'sandbox.diag.parse', 'error', { error: parsed.error });
    return json({ ok: false, error: parsed.error }, 400);
  }
  const { op, slot, write: isWrite } = parsed;

  try {
    const sandbox = openSandbox(env, sandboxName);
    const mountDone = tl.stage('workspace_mount', 'sandbox.diag.workspace_mount');
    // This ops/diagnostic route is keyed ONLY by the opaque Durable Object
    // id in the URL (`sandboxName`) — it has no real projectId/branch in its
    // strict `{token, op, slot}` body contract (see `parseDiagRequest`), so
    // there is no real project-scoped prefix to compute here. Use the
    // sandboxName itself as a stand-in projectId with an EXPLICIT 'main'
    // branch so the prefix is at least deterministic/isolated per sandbox;
    // this never aliases onto a real user's `${projectId}/branches/${branch}`
    // R2 prefix (sandboxName is `guac-<userId16>-<projectId16>`, which is not
    // a valid full projectId).
    const workspace = await ensureWorkspaceMount(sandbox, env, {
      projectId: sandboxName,
      branch: 'main',
    });
    if (!workspace.mounted || !workspace.mountPath) {
      mountDone('error', `diag_mount_failed: ${workspace.detail ?? 'workspace_not_mounted'}`);
      return json(
        {
          ok: false,
          sandboxId: sandboxName,
          op,
          slot,
          workspace,
          error: `diag_mount_failed: ${workspace.detail ?? 'workspace_not_mounted'}`,
        },
        500,
      );
    }
    mountDone('ok', undefined, `mountPath=${workspace.mountPath}`);

    // R2 FUSE mounts reject `mkdir` under the mount root, so slots map to a
    // deterministic hidden file written DIRECTLY at the (already existing,
    // writable) mount root — no directory creation involved.
    const path = `${workspace.mountPath}/${diagSlotFile(slot)}`;
    const content = diagMarkerContent(slot);
    const expectedSha256 = await sha256Hex(content);

    let wrote = false;
    if (isWrite) {
      // Write the deterministic marker directly to the mount root with the only
      // operation all live evidence shows is supported by this R2 FUSE mount:
      // a timeout-bounded fixed-file rewrite/close (see `twenWriteCommand`).
      // Explicit flushes are deliberately NOT used: `sync <path>` and zero-byte
      // `dd conv=fsync` produced 0-byte fresh reads, while real-byte
      // `dd conv=fsync` returned EPERM on a clean mount. No `mkdir` — the mount
      // root already exists and is writable.
      //
      // This is an UNCONDITIONAL (idempotent) rewrite, NOT a preserve-if-exists.
      // The marker content is a pure function of the slot name, so a recreate
      // re-writes byte-identical content — persistence semantics are unchanged.
      // Critically, the old preserve-if-exists branch would permanently PRESERVE
      // a stale/empty slot object (a 0-byte `.ezil-diag-<slot>` left behind when
      // the R2 FUSE write buffer never flushed before a prior unmount; see
      // `twenStaleZero`), so every subsequent write echoed `preserved`
      // (wrote=false) over an empty file whose sha256 could never match the
      // expected marker. Always rewriting self-heals that poisoned slot. The
      // write/close is BOUNDED by `timeout` (see `twenWriteCommand`) so it can
      // never wedge the request; actual durability is proven by separated
      // fresh-boundary read-backs below.
      const writeRes = await sandbox.exec(twenWriteCommand(path, content));
      if (writeRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            slot,
            path,
            workspace,
            error: `diag_write_failed: exit=${writeRes.exitCode} stderr=${writeRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      // NOTE: the shell's `echo wrote` (command exit) is NOT authoritative — a
      // 0-byte R2 FUSE write can exit 0 yet never land the bytes. `wrote` is set
      // below from the server-side read-back (twenWriteConfirmed) so it is
      // impossible to report wrote:true without a durable, expected-digest file.
    }

    // Stat the slot WITHOUT returning raw content: existence, byte count, and
    // the on-disk SHA-256 only.
    //
    // FUSE settle-retry AT THE REQUEST LEVEL (mirrors the `twen` path): the R2
    // egress FUSE mount serves a short-TTL attribute/data cache, so a stat
    // issued immediately after a write can keep observing the stale/empty
    // pre-write view for the life of that shell. We therefore re-stat across
    // SEPARATE `exec` calls spaced by a real wall-clock await until the
    // read-back converges — bounded so the request can never wait forever. For
    // a write op we wait for the digest to equal the deterministic expected
    // digest; for a read-only op a legitimately-absent slot returns on the
    // first pass and an existing slot needs only a non-transient (>0 byte) view.
    const statCmd =
      `if [ -f '${path}' ]; then printf 'exists\\n'; wc -c < '${path}'; sha256sum '${path}' | cut -d' ' -f1; ` +
      `else printf 'missing\\n'; fi`;
    const maxStatAttempts = twenStatMaxAttempts(isWrite);
    let statLines: string[] = ['missing'];
    for (let attempt = 1; attempt <= maxStatAttempts; attempt++) {
      const statRes = await sandbox.exec(statCmd);
      if (statRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            slot,
            path,
            workspace,
            error: `diag_stat_failed: exit=${statRes.exitCode} stderr=${statRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      statLines = (statRes.stdout ?? '').split('\n').map((l) => l.trim());
      if (twenStatConverged(isWrite, parseTwenStatLines(statLines), expectedSha256)) break;
      if (attempt < maxStatAttempts)
        await new Promise((r) => setTimeout(r, TWEN_STAT_RETRY_DELAY_MS));
    }

    const lines = statLines;
    const exists = lines[0] === 'exists';
    const bytes = exists ? Number(lines[1] ?? '') : 0;
    const sha256 = exists ? (lines[2] ?? '') : null;

    const matches = exists ? sha256 === expectedSha256 : false;
    // Authoritative success: derived ONLY from separated fresh read-backs, never
    // from the write command's exit and never from the same converged
    // observation. After the in-request stat-retry loop converges we issue TWO
    // separate `exec` stats with a wall-clock gap and require the converged view
    // plus BOTH fresh views to be durable, non-zero, expected-digest files. This
    // structurally rejects both observed false-success shapes:
    //   cached match + fresh empty, and first fresh match + second fresh mismatch.
    if (isWrite) {
      const convergedObs = parseTwenStatLines(lines);
      const firstFreshRes = await sandbox.exec(statCmd);
      if (firstFreshRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            slot,
            path,
            workspace,
            error: `diag_fresh_stat_failed: exit=${firstFreshRes.exitCode} stderr=${firstFreshRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      await new Promise((r) => setTimeout(r, TWEN_STAT_RETRY_DELAY_MS));
      const secondFreshRes = await sandbox.exec(statCmd);
      if (secondFreshRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            slot,
            path,
            workspace,
            error: `diag_fresh_stat_failed: exit=${secondFreshRes.exitCode} stderr=${secondFreshRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      const firstFreshLines = (firstFreshRes.stdout ?? '').split('\n').map((l) => l.trim());
      const secondFreshLines = (secondFreshRes.stdout ?? '').split('\n').map((l) => l.trim());
      wrote = twenWriteDurable(
        convergedObs,
        parseTwenStatLines(firstFreshLines),
        parseTwenStatLines(secondFreshLines),
        expectedSha256,
      );
    }
    tl.event('workspace_mount', 'sandbox.diag.result', 'ok', {
      detail: `op=${op} slot=${slot} exists=${exists} matches=${matches} wrote=${wrote}`,
    });
    return json({
      ok: true,
      sandboxId: sandboxName,
      correlationId,
      op,
      slot,
      path,
      workspace,
      exists,
      bytes: Number.isFinite(bytes) ? bytes : null,
      sha256,
      expectedSha256,
      matches,
      wrote,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    tl.event('workspace_mount', 'sandbox.diag.failed', 'error', { error: err });
    return json(
      { ok: false, sandboxId: sandboxName, op, slot, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * CPU-saturation diagnostic RETRIEVAL endpoint (HMAC-gated).
 *
 * `scripts/start-neko.sh` carries an opt-in in-container CPU sampler (see that
 * script's "CPU saturation diagnostics" section + `ensureDesktop` above, which
 * forwards `EZIL_NEKO_CPU_DIAG_ENABLED` from the Worker env into the container
 * process env). This route is the ONLY way to retrieve what it wrote, since it
 * samples into `/tmp` — outside the R2 workspace mount `workspace-diag`/`twen`
 * operate on — and neither of those routes ever return raw file content by
 * design (this one's whole purpose IS to return the sampled content, bounded).
 *
 * Reuses `verifyPreviewToken`'s HMAC envelope so it is gated exactly like
 * `/sandbox/preview` and `/sandbox/:name/workspace-diag`.
 *
 * POST /sandbox/:name/cpu-diag  { token, maxLines? }
 *   maxLines: optional cap on trailing lines returned, clamped to
 *     [1, CPU_DIAG_MAX_LINES_CEILING] (default CPU_DIAG_DEFAULT_MAX_LINES).
 *
 * Response:
 *   { ok, sandboxId, path, exists, bytes, totalLines, returnedLines,
 *     maxLines, truncated, content, checkedAt, correlationId }
 * `exists: false` (diag never enabled, or no sample written yet) is a CLEAN,
 * informative 200 — never a 500. `content` is '' when `exists` is false.
 */
async function handleCpuDiag(
  request: Request,
  env: Env,
  sandboxName: string,
): Promise<Response> {
  const correlationId =
    request.headers.get('x-request-id')?.trim() ||
    request.headers.get('x-correlation-id')?.trim() ||
    newCorrelationId();
  const tl = new LifecycleTimeline({ correlationId, sandboxId: sandboxName });

  let body: { token?: string; maxLines?: number } = {};
  try {
    body = (await request.json()) as { token?: string; maxLines?: number };
  } catch {
    // Allow an empty body — the diagnostic endpoint defaults maxLines.
  }

  const auth = await verifyPreviewToken(body.token, resolvePreviewSecrets(env));
  if (!auth.ok) {
    tl.event('project_authorization', 'sandbox.cpu_diag.authorize', 'error', { error: auth.error });
    return json({ ok: false, error: auth.error }, 401);
  }
  tl.event('project_authorization', 'sandbox.cpu_diag.authorize', 'ok');

  const maxLines = resolveCpuDiagMaxLines(body.maxLines);
  const checkedAt = () => new Date().toISOString();

  try {
    const sandbox = openSandbox(env, sandboxName);

    const statRes = await sandbox.exec(cpuDiagStatCommand(CPU_DIAG_FILE));
    if (statRes.exitCode !== 0) {
      tl.event('workspace_mount', 'sandbox.cpu_diag.stat_failed', 'error', { error: statRes.stderr });
      return json(
        {
          ok: false,
          sandboxId: sandboxName,
          path: CPU_DIAG_FILE,
          error: `cpu_diag_stat_failed: exit=${statRes.exitCode} stderr=${statRes.stderr?.trim().slice(-300)}`,
        },
        500,
      );
    }
    const statLines = (statRes.stdout ?? '').split('\n').map((l) => l.trim());
    const stat = parseCpuDiagStatLines(statLines);

    if (!stat.exists) {
      // Clean, informative degrade — NOT a 500. The most likely cause is that
      // `EZIL_NEKO_CPU_DIAG_ENABLED` was never set for this sandbox (default
      // OFF), or the desktop hasn't been up long enough for a first sample.
      tl.event('workspace_mount', 'sandbox.cpu_diag.result', 'ok', { detail: 'exists=false' });
      return json({
        ok: true,
        sandboxId: sandboxName,
        correlationId,
        path: CPU_DIAG_FILE,
        exists: false,
        bytes: 0,
        totalLines: 0,
        returnedLines: 0,
        maxLines,
        truncated: false,
        content: '',
        note:
          'cpu_diag_file_absent: sampler not enabled for this sandbox (EZIL_NEKO_CPU_DIAG_ENABLED unset) or no sample has been written yet',
        checkedAt: checkedAt(),
      });
    }

    const contentRes = await sandbox.exec(cpuDiagContentCommand(CPU_DIAG_FILE, CPU_DIAG_MAX_BYTES, maxLines));
    if (contentRes.exitCode !== 0) {
      tl.event('workspace_mount', 'sandbox.cpu_diag.read_failed', 'error', { error: contentRes.stderr });
      return json(
        {
          ok: false,
          sandboxId: sandboxName,
          path: CPU_DIAG_FILE,
          error: `cpu_diag_read_failed: exit=${contentRes.exitCode} stderr=${contentRes.stderr?.trim().slice(-300)}`,
        },
        500,
      );
    }
    const content = contentRes.stdout ?? '';
    const returnedLines = content.length === 0 ? 0 : content.split('\n').filter((l) => l.length > 0).length;
    const truncated = stat.totalLines > returnedLines || stat.bytes > CPU_DIAG_MAX_BYTES;

    tl.event('workspace_mount', 'sandbox.cpu_diag.result', 'ok', {
      detail: `exists=true bytes=${stat.bytes} totalLines=${stat.totalLines} returnedLines=${returnedLines} truncated=${truncated}`,
    });
    return json({
      ok: true,
      sandboxId: sandboxName,
      correlationId,
      path: CPU_DIAG_FILE,
      exists: true,
      bytes: stat.bytes,
      totalLines: stat.totalLines,
      returnedLines,
      maxLines,
      truncated,
      content,
      checkedAt: checkedAt(),
    });
  } catch (err) {
    tl.event('workspace_mount', 'sandbox.cpu_diag.failed', 'error', { error: err });
    return json(
      { ok: false, sandboxId: sandboxName, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

/**
 * Twen workspace orchestration endpoint (HMAC-gated).
 *
 * "Twen" is a first-class, named orchestration action operating on an
 * authenticated EZiL project's EXISTING Cloudflare Sandbox identity and its
 * persistent `/workspace`. Its initial capability creates or idempotently
 * updates a single, server-generated, non-secret status artifact at a FIXED
 * reserved path ({@link TWEN_STATUS_FILE}) — no arbitrary commands, paths, or
 * content are ever accepted. See `./twen` for the full safety contract.
 *
 * Reuses `verifyPreviewToken`'s HMAC envelope so it is gated exactly like
 * `/sandbox/preview`. Under local `wrangler dev` the FUSE mount fails with
 * `fuse: device not found`; this is validated on the Cloudflare-native runtime.
 *
 * POST /sandbox/:name/twen  { token, op?, operationId? }
 *   op:          'sync' (default) — create-or-idempotently-update the artifact.
 *                'status'         — read-only; report artifact metadata.
 *   operationId: allowlisted idempotency key (default 'default').
 *
 * Response (never includes raw file content or secrets):
 *   { ok, sandboxId, op, operationId, path, workspace, exists, bytes, sha256,
 *     expectedSha256, matches, wrote, checkedAt }
 */
async function handleTwen(request: Request, env: Env, sandboxName: string): Promise<Response> {
  // Read the raw body first so we can enforce a hard size ceiling BEFORE
  // parsing — a legitimate Twen body is a tiny JSON object (HMAC token + two
  // short bounded scalars), so anything materially larger is malformed/hostile
  // (e.g. an attempt to smuggle file content) and is rejected up front.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return json({ ok: false, error: 'twen_invalid_body' }, 400);
  }
  // Byte length (not UTF-16 code-unit length) drives the size gate.
  if (twenRequestTooLarge(new TextEncoder().encode(rawBody).length)) {
    return json({ ok: false, error: 'twen_request_too_large' }, 413);
  }

  let body: unknown = {};
  if (rawBody.trim() !== '') {
    try {
      body = JSON.parse(rawBody);
    } catch {
      return json({ ok: false, error: 'invalid_json_body' }, 400);
    }
  }

  // Auth first: an unsigned / wrong-identity / expired request is a 401
  // regardless of any other body content. `token` is read directly here; the
  // strict body validation below proves the body carries nothing else out of
  // contract.
  const token =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? ((body as Record<string, unknown>).token as string | undefined)
      : undefined;
  const auth = await verifyPreviewToken(token, resolvePreviewSecrets(env));
  if (!auth.ok) {
    return json({ ok: false, error: auth.error }, 401);
  }

  // Strict body contract: reject unknown fields (path/content/command/slot/
  // nested payloads) rather than ignoring them, and validate op/operationId.
  const parsed = parseTwenBody(body);
  if (!parsed.ok) {
    return json({ ok: false, error: parsed.error }, 400);
  }
  const { op, operationId, write: isWrite } = parsed;

  try {
    const sandbox = openSandbox(env, sandboxName);
    // Same rationale as `handleWorkspaceDiag` above: Twen's strict
    // `{token, op, operationId}` body contract (`parseTwenBody`) carries no
    // real projectId/branch, so this ops-only route uses the opaque
    // `sandboxName` as a stand-in projectId + an EXPLICIT 'main' branch
    // rather than the real per-project write-path prefix.
    const workspace = await ensureWorkspaceMount(sandbox, env, {
      projectId: sandboxName,
      branch: 'main',
    });
    if (!workspace.mounted || !workspace.mountPath) {
      return json(
        {
          ok: false,
          sandboxId: sandboxName,
          op,
          operationId,
          workspace,
          error: `twen_mount_failed: ${workspace.detail ?? 'workspace_not_mounted'}`,
        },
        500,
      );
    }

    // FIXED, server-side path — the caller can never influence it. Hidden,
    // root-level file so the R2 FUSE mount never has to `mkdir`.
    const path = `${workspace.mountPath}/${TWEN_STATUS_FILE}`;
    const content = twenStatusContent(operationId);
    const expectedSha256 = await sha256Hex(content);

    if (isWrite) {
      // Idempotent create-or-update of the deterministic, server-generated
      // status artifact at the fixed mount-root path (no `mkdir`). Content is a
      // pure function of operationId, so re-running yields identical bytes.
      //
      // A timeout-bounded direct `> path` truncate/write/close is used (a
      // temp-file + `mv` rename is NOT usable here: the R2 FUSE mount rejects
      // rename at the mount root with EPERM). The R2 egress FUSE mount has weak
      // read-after-write consistency, so the read-back is verified/converged by
      // request-level, separated stat calls rather than unsupported `sync`/
      // `fsync` attempts inside the shell.
      const writeRes = await sandbox.exec(twenWriteCommand(path, content));
      if (writeRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            operationId,
            path,
            workspace,
            error: `twen_write_failed: exit=${writeRes.exitCode} stderr=${writeRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      // The write itself succeeded; convergence of the read-back is verified by
      // the fresh-session stat-retry below (the R2 FUSE cache TTL means a stable
      // read must come from a NEW exec spaced in wall-clock time, not an in-shell
      // loop). The shell's `echo wrote` (command exit) is NOT authoritative — a
      // 0-byte R2 FUSE write can exit 0 yet never land the bytes — so `wrote` is
      // set below from the read-back (twenWriteConfirmed), not from stdout.
    }

    // Stat WITHOUT returning raw content: existence, byte count, SHA-256 only.
    //
    // FUSE settle-retry AT THE REQUEST LEVEL: the R2 egress FUSE mount serves a
    // short-TTL attribute/data cache, so a read issued immediately after a write
    // — even from a separate in-shell loop — can keep observing the stale/empty
    // pre-write view for the life of that shell. A fresh `exec` spaced by a real
    // wall-clock await reliably crosses the cache TTL and sees the settled value.
    // We therefore retry the stat across SEPARATE exec calls: for a write op we
    // wait until the read-back digest equals the deterministic expected digest;
    // for a read-only op a single pass suffices, but we still retry a couple of
    // times when the file exists yet reads 0 bytes. A legitimately-absent file
    // (isolation check on a different identity) returns immediately.
    const statCmd =
      `if [ -f '${path}' ]; then printf 'exists\\n'; wc -c < '${path}'; sha256sum '${path}' | cut -d' ' -f1; ` +
      `else printf 'missing\\n'; fi`;
    const maxStatAttempts = twenStatMaxAttempts(isWrite);
    let statLines: string[] = ['missing'];
    for (let attempt = 1; attempt <= maxStatAttempts; attempt++) {
      const statRes = await sandbox.exec(statCmd);
      if (statRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            operationId,
            path,
            workspace,
            error: `twen_stat_failed: exit=${statRes.exitCode} stderr=${statRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      statLines = (statRes.stdout ?? '').split('\n').map((l) => l.trim());
      if (twenStatConverged(isWrite, parseTwenStatLines(statLines), expectedSha256)) break;
      if (attempt < maxStatAttempts)
        await new Promise((r) => setTimeout(r, TWEN_STAT_RETRY_DELAY_MS));
    }

    const lines = statLines;
    const exists = lines[0] === 'exists';
    const bytes = exists ? Number(lines[1] ?? '') : 0;
    const sha256 = exists ? (lines[2] ?? '') : null;

    // Authoritative success: for a write op, require TWO separated, independent
    // read-backs (fresh `exec`/stats issued AFTER the in-request convergence
    // loop) to ALSO confirm the durable expected-digest file. Same-boundary
    // convergence alone is insufficient, and a single fresh match is not enough
    // to reject first-fresh-match / second-fresh-mismatch sequences.
    let wrote = false;
    if (isWrite) {
      const convergedObs = parseTwenStatLines(lines);
      const firstFreshRes = await sandbox.exec(statCmd);
      if (firstFreshRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            operationId,
            path,
            workspace,
            error: `twen_fresh_stat_failed: exit=${firstFreshRes.exitCode} stderr=${firstFreshRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      await new Promise((r) => setTimeout(r, TWEN_STAT_RETRY_DELAY_MS));
      const secondFreshRes = await sandbox.exec(statCmd);
      if (secondFreshRes.exitCode !== 0) {
        return json(
          {
            ok: false,
            sandboxId: sandboxName,
            op,
            operationId,
            path,
            workspace,
            error: `twen_fresh_stat_failed: exit=${secondFreshRes.exitCode} stderr=${secondFreshRes.stderr?.trim().slice(-300)}`,
          },
          500,
        );
      }
      const firstFreshLines = (firstFreshRes.stdout ?? '').split('\n').map((l) => l.trim());
      const secondFreshLines = (secondFreshRes.stdout ?? '').split('\n').map((l) => l.trim());
      wrote = twenWriteDurable(
        convergedObs,
        parseTwenStatLines(firstFreshLines),
        parseTwenStatLines(secondFreshLines),
        expectedSha256,
      );
    }

    return json({
      ok: true,
      sandboxId: sandboxName,
      op,
      operationId,
      path,
      workspace,
      exists,
      bytes: Number.isFinite(bytes) ? bytes : null,
      sha256,
      expectedSha256,
      matches: exists ? sha256 === expectedSha256 : false,
      wrote,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json(
      { ok: false, sandboxId: sandboxName, op, operationId, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

// ── Option D: app-preview reverse proxy dispatcher ───────────────────────────
//
// Handles every path under the app-preview hostname
// (`<APP_PREVIEW_PORT>-<sandboxId>-<APP_PREVIEW_TOKEN>.<zone>`) itself —
// `/preview-bootstrap`, `/preview`, `/preview/<path>`, `/preview-ws/<path>`,
// `/preview-inspector.js`, `/preview-status` — and returns `null` for
// anything else on that hostname (404, deliberately; see the doc comment
// on the call site in `fetch()` for why this hostname is fully "owned" by
// this dispatcher and never falls through to `proxyToSandbox`'s raw,
// unauthenticated forward).

/**
 * Probe `/preview-status`: real checks only, now including the phase file
 * and hydration-ready marker `scripts/start-devserver.sh` /
 * `workspace-bootstrap.ts` write in-container (see `preview-bridge.ts`'s
 * `PreviewStatus` doc for the full field-by-field provenance).
 *
 * Also the dev-server self-heal trigger point: since the client never
 * mounts the preview iframe (so never issues a `/preview/*` request) until
 * this endpoint first reports `is_real_app: true`, THIS is the only
 * request path a crashed dev server ever sees — so the lazy-restart check
 * (`shouldTriggerDevserverRestart`, `preview-bridge.ts`) lives here, not in
 * `handlePreviewProxy`. See that module's "Dev-server self-heal" section for
 * the full trigger/cooldown/backoff design and the Azure-divergence note.
 */
async function probeAppPreviewStatus(sandbox: Sandbox<unknown>, env: Env) {
  const mountPath = env.SANDBOX_WORKSPACE_MOUNT_PATH?.trim() || DEFAULT_WORKSPACE_MOUNT_PATH;
  let portUp = false;
  let hasPackageJson = false;
  let rawPhase: string | null = null;
  let phaseTimestampS: number | null = null;
  let hydrationComplete = false;
  try {
    const res = await sandbox.exec(
      `wget -q -T 3 -t 1 -O /dev/null http://127.0.0.1:${APP_PREVIEW_PORT}/`,
      { origin: 'internal' },
    );
    portUp = res.exitCode === 0;
  } catch {
    portUp = false;
  }
  // Resolved against whichever workspace root start-devserver.sh actually ran
  // in (almost always /home/neko/project or the bootstrap-resolved root),
  // NOT the legacy bucket-mount default — see buildPackageJsonCheckCommand's
  // doc comment for why that fallback is nearly always the wrong path here.
  try {
    const res = await sandbox.exec(buildPackageJsonCheckCommand(mountPath), { origin: 'internal' });
    hasPackageJson = res.exitCode === 0;
  } catch {
    hasPackageJson = false;
  }
  try {
    const res = await sandbox.exec(`cat ${DEVSERVER_PHASE_FILE} 2>/dev/null`, { origin: 'internal' });
    const record = res.exitCode === 0 ? parseDevserverPhaseRecord(res.stdout) : { phase: null, timestampS: null };
    rawPhase = record.phase;
    phaseTimestampS = record.timestampS;
  } catch {
    rawPhase = null;
    phaseTimestampS = null;
  }
  try {
    const res = await sandbox.exec(`test -f ${WORKSPACE_READY_MARKER_PATH}`, { origin: 'internal' });
    hydrationComplete = res.exitCode === 0;
  } catch {
    hydrationComplete = false;
  }
  // Guards is_real_app against the placeholder-still-serving race — see
  // buildPreviewStatus's doc comment for why devserverMode is needed at all.
  let devserverMode: string | null = null;
  try {
    const res = await sandbox.exec(`cat ${DEVSERVER_MODE_FILE} 2>/dev/null`, { origin: 'internal' });
    const raw = res.exitCode === 0 ? (res.stdout ?? '').trim() : '';
    devserverMode = raw.length > 0 ? raw : null;
  } catch {
    devserverMode = null;
  }
  let restartAttempts = 0;
  try {
    const res = await sandbox.exec(`cat ${DEVSERVER_RESTART_COUNT_FILE} 2>/dev/null`, { origin: 'internal' });
    restartAttempts = res.exitCode === 0 ? parseRestartAttempts(res.stdout) : 0;
  } catch {
    restartAttempts = 0;
  }

  const nowS = Date.now() / 1000;
  const decision = shouldTriggerDevserverRestart(rawPhase, phaseTimestampS, nowS, restartAttempts);
  if (decision.restart) {
    try {
      // start-devserver.sh backgrounds the actual install/launch and returns
      // ("starting"/"already-running", exit 0) almost immediately — same
      // non-blocking property start-neko.sh already relies on at boot — so
      // awaiting this exec does not meaningfully delay the /preview-status
      // response. Best-effort: a failure here must never break the status
      // probe itself; the next poll's cooldown check simply tries again.
      await sandbox.exec(buildDevserverRestartCommand(), { origin: 'internal' });
    } catch {
      // ignored — see above
    }
  }

  // The REPORTED phase escalates crashed -> crash_looping once recovery has
  // failed DEVSERVER_RESTART_ESCALATE_ATTEMPTS times in a row, so a
  // persistent failure never looks indistinguishable from "still starting"
  // — see effectiveDevserverPhase's doc comment. error_reason is unaffected
  // (buildPreviewStatus computes it from portUp/hasPackageJson exactly as
  // before; crash_looping is purely additive, like every other phase value).
  const reportedPhase = effectiveDevserverPhase(rawPhase, restartAttempts);

  return buildPreviewStatus(portUp, hasPackageJson, reportedPhase, hydrationComplete, devserverMode);
}

async function handleAppPreview(request: Request, env: Env, url: URL): Promise<Response | null> {
  const route = parseAppPreviewHost(url.hostname);
  if (!route) return null;
  const { sandboxId } = route;
  const path = url.pathname;
  const secrets = resolvePreviewSecrets(env);

  if (request.method === 'GET' && path === '/preview-bootstrap') {
    const cookieSecret = resolveNekoDerivationSecret(env) ?? undefined;
    return handlePreviewBootstrap(url, sandboxId, secrets, cookieSecret);
  }

  if (request.method === 'GET' && path === '/preview-status') {
    try {
      const sandbox = openSandbox(env, sandboxId);
      const status = await probeAppPreviewStatus(sandbox, env);
      return json(status);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  if (request.method === 'GET' && path === '/preview-inspector.js') {
    return handlePreviewInspectorJs(request, sandboxId, secrets);
  }

  if (path === '/preview-ws' || path.startsWith('/preview-ws/')) {
    const sandbox = openSandbox(env, sandboxId);
    const appPath = path === '/preview-ws' ? '/' : path.slice('/preview-ws'.length);
    return handlePreviewWsProxy(request, sandbox, sandboxId, secrets, appPath);
  }

  if (path === '/preview' || path.startsWith('/preview/')) {
    const sandbox = openSandbox(env, sandboxId);
    const appPath = path === '/preview' ? '/' : path.slice('/preview'.length);
    return handlePreviewProxy(request, sandbox, sandboxId, secrets, appPath);
  }

  // Anything else on the app-preview hostname is outside the Option D
  // contract — deliberately 404, never falls through to a raw unauthenticated
  // forward (see `fetch()`'s call site doc comment).
  return json({ ok: false, error: `not_found: ${request.method} ${path}` }, 404);
}

// ── Project files storage proxy (`worker_proxy` ProjectFilesTransport backend) ─
//
// Backs `apps/web/client/src/server/lib/worker-proxy-transport.ts`'s
// `createWorkerProxyTransport()`: an alternative to `createR2Transport()`
// (which needs R2 S3 API credentials only mintable from the Cloudflare
// dashboard) that instead talks HMAC-signed HTTP to THIS Worker, which
// performs the R2 operation itself via the already-wired
// `SANDBOX_WORKSPACE_R2_BUCKET` binding — no S3 credentials anywhere in this
// path. All five pure request/response behaviors (key validation, size
// ceilings, base64, R2-conditional emulation) live in `./project-files`;
// these handlers only add the Workers-runtime plumbing: reading the request,
// verifying the SAME HMAC token envelope every other gated route on this
// Worker uses (`verifyPreviewToken` / `resolvePreviewSecrets` — no new auth
// mechanism), and mapping the pure result to an HTTP `Response`.
//
// Every endpoint is POST with a JSON body carrying `token` — identical shape
// to `/sandbox/preview`, `/sandbox/:id/workspace-diag`, `/sandbox/:id/twen`.
// See `./project-files`'s module doc for the full wire contract.

/** Read + parse a project-files JSON request body, enforcing `maxBytes` BEFORE `JSON.parse` (mirrors `twen.ts`'s pre-parse size gate). */
async function readProjectFilesBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { ok: false, response: json({ ok: false, error: 'invalid_body' }, 400) };
  }
  if (new TextEncoder().encode(rawBody).length > maxBytes) {
    return { ok: false, response: json({ ok: false, error: 'request_too_large' }, 413) };
  }
  let parsed: unknown = {};
  if (rawBody.trim() !== '') {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { ok: false, response: json({ ok: false, error: 'invalid_json_body' }, 400) };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: json({ ok: false, error: 'invalid_json_body' }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** Verify the shared HMAC envelope against a parsed project-files body's `token` field. Returns a 401 `Response` on failure, `null` on success. */
async function authorizeProjectFilesRequest(
  env: Env,
  body: Record<string, unknown>,
): Promise<Response | null> {
  const token = typeof body.token === 'string' ? body.token : undefined;
  const auth = await verifyPreviewToken(token, resolvePreviewSecrets(env));
  if (!auth.ok) return json({ ok: false, error: auth.error }, 401);
  return null;
}

function projectFilesBucket(env: Env): Response | { bucket: NonNullable<Env['SANDBOX_WORKSPACE_R2_BUCKET']> } {
  const bucket = env.SANDBOX_WORKSPACE_R2_BUCKET;
  if (!bucket) return json({ ok: false, error: 'project_files_bucket_not_configured' }, 500);
  return { bucket };
}

async function handleProjectFilesPut(request: Request, env: Env): Promise<Response> {
  const read = await readProjectFilesBody(request, PROJECT_FILES_MAX_PUT_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const unauthorized = await authorizeProjectFilesRequest(env, read.body);
  if (unauthorized) return unauthorized;

  const resolved = projectFilesBucket(env);
  if (resolved instanceof Response) return resolved;

  const result = await putProjectFile(resolved.bucket, {
    key: read.body.key,
    contentType: read.body.contentType,
    bodyBase64: read.body.bodyBase64,
    ifMatchVersion: read.body.ifMatchVersion,
    ifNotExists: read.body.ifNotExists,
  });
  if (!result.ok) return json(result, result.status);
  return json(result);
}

async function handleProjectFilesGet(request: Request, env: Env): Promise<Response> {
  const read = await readProjectFilesBody(request, PROJECT_FILES_MAX_CONTROL_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const unauthorized = await authorizeProjectFilesRequest(env, read.body);
  if (unauthorized) return unauthorized;

  const resolved = projectFilesBucket(env);
  if (resolved instanceof Response) return resolved;

  const result = await getProjectFileBytes(resolved.bucket, read.body.key);
  if (!result.ok) return json(result, result.status);
  return json(result);
}

async function handleProjectFilesHead(request: Request, env: Env): Promise<Response> {
  const read = await readProjectFilesBody(request, PROJECT_FILES_MAX_CONTROL_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const unauthorized = await authorizeProjectFilesRequest(env, read.body);
  if (unauthorized) return unauthorized;

  const resolved = projectFilesBucket(env);
  if (resolved instanceof Response) return resolved;

  const result = await getProjectFileProperties(resolved.bucket, read.body.key);
  if (!result.ok) return json(result, result.status);
  return json(result);
}

async function handleProjectFilesDelete(request: Request, env: Env): Promise<Response> {
  const read = await readProjectFilesBody(request, PROJECT_FILES_MAX_CONTROL_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const unauthorized = await authorizeProjectFilesRequest(env, read.body);
  if (unauthorized) return unauthorized;

  const resolved = projectFilesBucket(env);
  if (resolved instanceof Response) return resolved;

  const result = await deleteProjectFile(resolved.bucket, {
    key: read.body.key,
    ifMatchVersion: read.body.ifMatchVersion,
  });
  if (!result.ok) return json(result, result.status);
  return json(result);
}

async function handleProjectFilesList(request: Request, env: Env): Promise<Response> {
  const read = await readProjectFilesBody(request, PROJECT_FILES_MAX_CONTROL_REQUEST_BYTES);
  if (!read.ok) return read.response;
  const unauthorized = await authorizeProjectFilesRequest(env, read.body);
  if (unauthorized) return unauthorized;

  const resolved = projectFilesBucket(env);
  if (resolved instanceof Response) return resolved;

  const result = await listProjectFiles(resolved.bucket, {
    prefix: read.body.prefix,
    continuationToken: read.body.continuationToken,
    maxResults: read.body.maxResults,
  });
  if (!result.ok) return json(result, result.status);
  return json(result);
}

async function handleTerminate(env: Env, sandboxName: string): Promise<Response> {
  try {
    const sandbox = openSandbox(env, sandboxName);
    // EXPLICIT flush before destroy() — the container filesystem (and
    // anything unflushed on it) is gone the moment `destroy()` returns.
    // Best-effort: a flush failure here must never block termination (that
    // would let a stuck flush leak a container indefinitely), but it MUST be
    // logged loudly — never a bare `catch {}`. Worst case on failure is the
    // same bounded exposure the periodic alarm already accepts (see
    // `EzilSandboxDO`'s flush-interval doc comment), not a new hazard.
    try {
      await sandbox.flushWorkspaceNow();
    } catch (err) {
      console.error(
        `[handleTerminate] pre-destroy flushWorkspaceNow failed (sandboxName=${sandboxName}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    await sandbox.destroy();
    return json({ ok: true, sandboxName, terminated: true, mode: 'production' });
  } catch (err) {
    return json(
      { ok: false, sandboxName, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 0) Option D app-preview hostname (`<APP_PREVIEW_PORT>-<id>-app.<zone>`):
    //    handled ENTIRELY by our own token/cookie-gated dispatcher, BEFORE
    //    `proxyToSandbox` gets a chance to raw-forward it. This hostname is
    //    also registered via `exposePort()` (see `ensureDesktop`) so
    //    `getExposedPorts()` reports it and the URL scheme matches every other
    //    exposed port — but that registration is ONLY for discoverability;
    //    traffic to it must never bypass the cookie/token auth below by
    //    falling through to the SDK's raw pass-through. Returns `null` (not a
    //    Response) for hostnames outside the app-preview pattern, in which
    //    case the request continues to the normal `proxyToSandbox` path below
    //    unchanged.
    const appPreview = await handleAppPreview(request, env, new URL(request.url));
    if (appPreview) return appPreview;

    // 1) Route exposed-port preview traffic (incl. WebSocket upgrades) into the
    //    container. Returns null for everything else.
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (method === 'GET' && path === '/health') {
      return json({ ok: true, service: 'cf-guacamole-sandbox', mode: 'production', supportedDesktopModes: DESKTOP_MODES });
    }

    if (method === 'POST' && path === '/sandbox/preview') {
      return handlePreview(request, env, url);
    }

    const statusMatch = path.match(/^\/sandbox\/([^/]+)\/status$/);
    if (method === 'GET' && statusMatch) {
      return handleStatus(env, url, decodeURIComponent(statusMatch[1]), url.searchParams.get('desktopMode') ?? undefined);
    }

    const workspaceDiagMatch = path.match(/^\/sandbox\/([^/]+)\/workspace-diag$/);
    if (method === 'POST' && workspaceDiagMatch) {
      // Production kill-switch: the diagnostic surface is HMAC-gated, returns no
      // raw file content, and is confined to a hidden per-workspace directory,
      // so it is safe to retain for health diagnostics. Operators can still hard
      // -disable it WITHOUT a code change by setting the non-secret flag
      // `SANDBOX_WORKSPACE_DIAG=off` (any of off/false/0/disabled).
      if (diagDisabled(env.SANDBOX_WORKSPACE_DIAG)) {
        return json({ ok: false, error: 'workspace_diag_disabled' }, 404);
      }
      return handleWorkspaceDiag(request, env, decodeURIComponent(workspaceDiagMatch[1]));
    }

    const cpuDiagMatch = path.match(/^\/sandbox\/([^/]+)\/cpu-diag$/);
    if (method === 'POST' && cpuDiagMatch) {
      // HMAC-gated, read-only, bounded (see `handleCpuDiag`). Operators can
      // hard-disable the RETRIEVAL route WITHOUT a code change via
      // `SANDBOX_CPU_DIAG=off` — independent of the in-container sampler's own
      // `EZIL_NEKO_CPU_DIAG_ENABLED` opt-in flag.
      if (cpuDiagRouteDisabled(env.SANDBOX_CPU_DIAG)) {
        return json({ ok: false, error: 'cpu_diag_disabled' }, 404);
      }
      return handleCpuDiag(request, env, decodeURIComponent(cpuDiagMatch[1]));
    }

    const twenMatch = path.match(/^\/sandbox\/([^/]+)\/twen$/);
    if (method === 'POST' && twenMatch) {
      // First-class Twen orchestration surface. HMAC-gated, returns no raw file
      // content, writes only the fixed server-side status artifact. Operators
      // can hard-disable it WITHOUT a code change via `SANDBOX_TWEN=off`.
      if (twenDisabled(env.SANDBOX_TWEN)) {
        return json({ ok: false, error: 'twen_disabled' }, 404);
      }
      return handleTwen(request, env, decodeURIComponent(twenMatch[1]));
    }

    if (method === 'POST' && path.startsWith('/project-files/')) {
      // `worker_proxy` ProjectFilesTransport backend — see the doc comment
      // above `handleProjectFilesPut` et al. Operators can hard-disable the
      // whole surface WITHOUT a code change via `SANDBOX_PROJECT_FILES_PROXY=off`.
      if (diagDisabled(env.SANDBOX_PROJECT_FILES_PROXY)) {
        return json({ ok: false, error: 'project_files_proxy_disabled' }, 404);
      }
      switch (path) {
        case '/project-files/put':
          return handleProjectFilesPut(request, env);
        case '/project-files/get':
          return handleProjectFilesGet(request, env);
        case '/project-files/head':
          return handleProjectFilesHead(request, env);
        case '/project-files/delete':
          return handleProjectFilesDelete(request, env);
        case '/project-files/list':
          return handleProjectFilesList(request, env);
        default:
          return json({ ok: false, error: `not_found: ${method} ${path}` }, 404);
      }
    }

    const deleteMatch = path.match(/^\/sandbox\/([^/]+)$/);
    if (method === 'DELETE' && deleteMatch) {
      return handleTerminate(env, decodeURIComponent(deleteMatch[1]));
    }

    return json({ ok: false, error: `not_found: ${method} ${path}` }, 404);
  },
};
