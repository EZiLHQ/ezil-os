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
 *   GET    /sandbox/:name/status   → { ok, sandboxName, guacamoleRunning, mode,
 *                                     desktopRunning, runningModes, modeSource }
 *          (`mode` is DETECTED from the live exposed-port list when the caller
 *          omits `?desktopMode=`; `guacamoleRunning` means "the desktop port
 *          for the reported `mode` is exposed" — read the two together)
 *   POST   /sandbox/:name/workspace-diag → { ok, sandboxId, op, slot, exists, bytes, sha256, expectedSha256, matches, wrote }
 *          (HMAC-gated diagnostic: mounts the R2 workspace bucket and operates on
 *          named, allowlisted marker slots to prove deterministic R2 persistence
 *          AND A/B/C isolation — never returns raw file content)
 *   POST   /sandbox/:name/cpu-diag → { ok, sandboxId, path, exists, bytes, totalLines, returnedLines, maxLines, truncated, content }
 *          (HMAC-gated retrieval of the opt-in in-container CPU sampler's
 *          `/tmp/neko-cpu-diag.jsonl` — see `EZIL_NEKO_CPU_DIAG_ENABLED` /
 *          `handleCpuDiag`; bounded/tail-capped; degrades cleanly with
 *          `exists: false` when the sampler was never enabled)
 *   DELETE /sandbox/:name          → { ok, sandboxName, terminated, stopped, outcome,
 *                                     wasRunning, runningAfter, mode }
 *          (HMAC-gated with the SAME token envelope as `/sandbox/preview` —
 *          present it as `Authorization: Bearer <token>`, `?token=`, or a JSON
 *          body `{token}`. `terminated` is true ONLY when a running container
 *          was observed before and observed gone after; `outcome` is one of
 *          destroyed | not_running | still_running | destroy_failed)
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

  /**
   * OPTIONAL R2 bucket binding backing the fleet crash-telemetry spool
   * (`ezil-telemetry-spool`) — see `scratchpad/telemetry-design.md` §4.1 and
   * `./telemetry.ts`. Deliberately a SEPARATE bucket from
   * `SANDBOX_WORKSPACE_R2_BUCKET`: that one is FUSE-mounted into user
   * containers, and a mount that ever resolved without a per-computer prefix
   * would put the whole fleet's error log inside a user's file manager.
   * Absent binding (e.g. local dev, or before the bucket is provisioned) is
   * a silent no-op in `spoolTelemetry()` — telemetry must never become a
   * hard dependency of the preview path.
   */
  TELEMETRY_R2_BUCKET?: R2Bucket;

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
   * Non-secret kill-switch for the window-focus control route
   * (`POST /sandbox/:name/focus`, see `handleFocus` / `validateFocusApp`).
   * Enabled by default (HMAC-gated, closed enum body, no arbitrary shell
   * input); set to `off`/`false`/`0`/`disabled`/`no` to hard-disable the
   * surface (returns 404) without a code change.
   */
  SANDBOX_FOCUS?: string;

  /**
   * Non-secret kill-switch for the desktop-restart control route
   * (`POST /sandbox/:name/restart`, see `handleRestart` /
   * `EzilSandboxDO.restartDesktopStack`). Enabled by default (HMAC-gated,
   * neko-mode-only, reuses `terminate_stack`'s own SIGTERM teardown rather
   * than a second one); set to `off`/`false`/`0`/`disabled`/`no` to
   * hard-disable the surface (returns 404) without a code change.
   */
  SANDBOX_RESTART?: string;

  /**
   * Non-secret kill-switch for the activity-heartbeat control route
   * (`POST /sandbox/:name/activity`, see `handleActivity` /
   * `EzilSandboxDO.recordActivity`). Enabled by default (HMAC-gated, writes
   * ONLY `lastActivityAt` to DO storage, never touches the container); set to
   * `off`/`false`/`0`/`disabled`/`no` to hard-disable the surface (returns
   * 404) without a code change. Disabling this does NOT make the idle-stop
   * path more aggressive — it just removes the one signal that can tell it
   * "a human is still here" beyond what preview/flush/hydrate already prove,
   * so a disabled heartbeat degrades toward earlier idle-stops, never later
   * ones.
   */
  SANDBOX_ACTIVITY?: string;

  /**
   * Non-secret kill-switch for BOTH telemetry-drain control routes
   * (`POST /telemetry/drain` + `POST /telemetry/ack`, see
   * `handleTelemetryDrain` / `handleTelemetryAck` and
   * `./telemetry.ts`'s `telemetryDrainDisabled`). Enabled by default
   * (HMAC-gated via `authorizeSignedControlRequest`, read/delete confined to
   * `TELEMETRY_R2_BUCKET`'s own `v1/` spool prefix); set to
   * `off`/`false`/`0`/`disabled`/`no` to hard-disable both surfaces (404)
   * without a code change.
   */
  SANDBOX_TELEMETRY_DRAIN?: string;

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
  codePortFor,
  APP_PREVIEW_PORT,
  CODE_PREVIEW_PORT,
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
  parseBridgeHost,
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
  type BridgeTarget,
} from './preview-bridge';
import {
  parseBridgeHost,
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
  readCookie,
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
// Pure control-surface helpers (signed-token extraction, honest terminate
// reporting, truthful desktop-status derivation) — see `./sandbox-control`.
// Re-exported as functions only; the module's `const`s stay unexported here
// (workerd rejects non-function top-level exports of the entrypoint — see the
// note above `DESKTOP_MODES`).
export {
  extractSignedToken,
  buildTerminateReport,
  describeDesktopStatus,
  validateFocusApp,
  buildFocusAppCommand,
  focusDisabled,
  restartDisabled,
  findDesktopLauncherProcess,
  buildRestartReport,
  type TerminateOutcome,
  type TerminateReport,
  type DesktopStatus,
  type FocusApp,
  type ProcessLike,
  type RestartOutcome,
  type RestartReport,
} from './sandbox-control';
import {
  extractSignedToken,
  buildTerminateReport,
  describeDesktopStatus,
  validateFocusApp,
  buildFocusAppCommand,
  focusDisabled,
  restartDisabled,
  findDesktopLauncherProcess,
  buildRestartReport,
  type TerminateReport,
  type ProcessLike,
  type RestartReport,
} from './sandbox-control';
import {
  seedWorkspaceIfAbsent,
  realR2KeyPrefix,
  buildTemplateCopyCommand,
  templateWasMissing,
  buildEnsureTurbopackConfigCommand,
  parseTurbopackConfigOutcome,
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
  verifyPreviewCookie,
  verifyPreviewBootstrapToken,
  mintPreviewBootstrapToken,
  PREVIEW_COOKIE_NAME,
} from './hmac';
import {
  LifecycleTimeline,
  newCorrelationId,
  createCollectingSink,
  sanitizeErrorMessage,
  type LogEvent,
} from './observability';
import { parseRequestedScreen, formatNekoScreen } from './screen-modes';
import {
  selectTelemetryWorthy,
  toTelemetryEventInput,
  parseContainerTelemetryLines,
  serializeTelemetryBatch,
  buildTelemetryR2Key,
  telemetryDrainDisabled,
  clampDrainLimit,
  parseTelemetryDrainBody,
  parseTelemetryAckKeys,
  TELEMETRY_SPOOL_PREFIX,
} from './telemetry';

// ── Constants ────────────────────────────────────────────────────────────────

/** HTTP+WebSocket port that the Apache Guacamole web app (Tomcat) serves inside the container. */
const DESKTOP_PORT = 8080;
/** Preview validity window reported to the client. */
const SESSION_TTL_MS = 30 * 60 * 1000;
/**
 * Sandbox auto-sleep when idle. BACKSTOP ONLY, not the real mechanism:
 * `EzilSandboxDO.flushWorkspaceScheduled`'s explicit idle-stop path
 * (`IDLE_STOP_MS`, 10 minutes, with a mandatory successful final flush first)
 * is what actually decides when a sandbox sleeps. This platform timer is
 * provably defeatable on its own — the periodic flush alarm's own
 * `containerFetch()` auto-starts a stopped container and/or renews the
 * SDK's activity timeout on every cycle, so left alone this NEVER fires
 * (measured: an instance ran 26 hours idle under the old 30m value; see
 * BILLING-BRIEF.md). Lowered from `'30m'` to `'5m'` so that if the explicit
 * path is ever skipped (e.g. the flush loop never started for this
 * generation), the container still doesn't run unbounded — just later and
 * less predictably than the explicit 10-minute idle-stop.
 */
const SLEEP_AFTER = '5m';
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

/**
 * The `folder=` query param `handlePreview`'s `buildBridgeUrl` should mint
 * for `codePreviewUrl`, given the exact workspace-mount outcome
 * `ensureWorkspaceMount` already computed for this `/sandbox/preview` call.
 *
 * Exported and pure (no I/O) so this is a real, invokable unit test rather
 * than a grep for a string in `handlePreview`'s source — see
 * `index.test.ts`'s "codePreviewFolderParams" suite, which mutation-proves
 * both branches.
 *
 * Fix for "Code opens with an empty file tree" (code-server shows "You have
 * no recent folders" without `?folder=<abs path>` on its first request — see
 * `handlePreviewBootstrap`'s doc comment in `./preview-bridge.ts` for the
 * full mechanism this feeds). `workspace.mountPath` is the SAME value,
 * resolved the SAME way (`resolveWorkspaceMountConfig`), already forwarded
 * into the container as `EZIL_WORKSPACE_ROOT` (see `ensureDesktop`'s
 * `workspaceRootEnv`) — never a literal `/workspace` here, so a future change
 * to the mount path can't silently empty the file tree again.
 *
 * Guarded by the IDENTICAL `mounted` condition `workspaceRootEnv` already
 * uses: when the bucket isn't mounted, the container's own `WORKSPACE_ROOT`
 * falls back to `start-neko.sh`'s `/home/neko/project` default instead, and
 * `folder` must follow that same fallback (by omitting itself, letting
 * code-server use its own launch-time default) rather than pointing at a
 * path nothing actually populated.
 */
export function codePreviewFolderParams(
  workspace: { mounted: boolean; mountPath?: string },
): Record<string, string> | undefined {
  return workspace.mounted && workspace.mountPath ? { folder: workspace.mountPath } : undefined;
}

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
  /**
   * The `POST /sandbox/:name/activity` implementation's DO-side write. See
   * `EzilSandboxDO.recordActivity`'s doc comment: writes ONLY
   * `LAST_ACTIVITY_AT_KEY` to DO storage, touches the container in no way at
   * all (no `exec`, no `containerFetch`) — the whole point of this RPC is
   * feeding the idle-stop decision a genuine presence signal, so it must be
   * structurally incapable of itself being the thing that keeps a container
   * alive.
   */
  recordActivity(lastInputAgoMs: number): Promise<void>;
  /**
   * Observe → flush → cancel the flush loop → destroy → RE-OBSERVE, returning
   * what actually happened. Runs entirely inside the DO because only there is
   * `ctx.container.running` (the ground truth for "is a container alive under
   * this name") readable. See `EzilSandboxDO.terminateSandbox`.
   */
  terminateSandbox(): Promise<TerminateReport>;
  /**
   * The `POST /sandbox/:name/restart` implementation. See
   * `EzilSandboxDO.restartDesktopStack`'s doc comment for the full contract —
   * runs entirely inside the DO because that is where the SDK's own
   * `listProcesses`/`killProcess`/`getProcess` process registry and
   * `getExposedPorts`/`unexposePort` port bookkeeping live.
   */
  restartDesktopStack(
    hostname: string,
    sandboxId: string,
    explicitMode: DesktopMode | undefined,
    fallbackMode: DesktopMode,
  ): Promise<RestartReport & { url?: string; appPreviewUrl?: string | null; codePreviewUrl?: string | null }>;
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
  /**
   * The raw exposed base URL (`https://<port>-<id>-<token>.<host>`) when
   * `exposed` is `true`. Used by `handlePreview` to build `appPreviewUrl` — a
   * ready-to-embed `/preview-bootstrap?token=...` URL — without re-deriving
   * the hostname composition itself.
   */
  url?: string;
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
/**
 * Fixed path `emit_telemetry()` (`scripts/start-neko.sh`) appends one JSON
 * line to per boot phase. Capped at 64 KB (design doc §4.2) — this is a tail
 * read of the MOST RECENT boot's phases, never the whole file history.
 */
const CONTAINER_TELEMETRY_PATH = '/var/log/ezil-telemetry.ndjson';
const CONTAINER_TELEMETRY_MAX_BYTES = 65_536;

/**
 * Best-effort drain of the container's own structured boot-phase log. Never
 * throws — a missing file (older image, or nothing emitted yet) or a read
 * failure just yields `''`, exactly like every other diagnostic read in this
 * file (`pollDesktopReady`, `handleCpuDiag`).
 */
async function drainContainerBootTelemetry(sandbox: Sandbox<unknown>): Promise<string> {
  try {
    const res = await sandbox.exec(
      `tail -c ${CONTAINER_TELEMETRY_MAX_BYTES} ${CONTAINER_TELEMETRY_PATH} 2>/dev/null || true`,
      { origin: 'internal' },
    );
    return res.exitCode === 0 ? (res.stdout ?? '') : '';
  } catch {
    return '';
  }
}

async function ensureDesktop(
  sandbox: Sandbox<unknown>,
  hostname: string,
  mode: DesktopMode = 'guacamole',
  iceEnv: Record<string, string> | null = null,
  startupDelivery: string | null = null,
  workspaceRoot: string | null = null,
  cpuDiagFlag: string | undefined = undefined,
  /**
   * Best-effort sink for the container's own boot-phase/outcome telemetry
   * (`scripts/start-neko.sh`'s `emit_telemetry()`), called with the raw
   * NDJSON tail on BOTH the success path and the failure path right below —
   * this is the fix for "boot phase/outcome data only reaches anywhere on
   * failure": previously only `proc.getLogs()`'s stderr tail was read, and
   * only when `!ready`. Never awaited by the caller's response path; the
   * caller decides what to do with the raw text (parse + spool to R2, or
   * ignore it entirely when telemetry is unconfigured).
   */
  onBootTelemetry?: (raw: string) => void,
): Promise<{ url: string; appPreviewExpose: AppPreviewExposeResult; codePreviewExpose: AppPreviewExposeResult }> {
  const bootT0 = Date.now();
  const { port, readyPath } = portFor(mode);
  const exposed = await sandbox.getExposedPorts(hostname);
  const already = exposed.find((p) => p.port === port);
  if (already) {
    // Fast path: desktop already exposed from a prior call, so the
    // re-exposure work below is skipped (pre-existing behavior) — `attempted`
    // stays `false` and is never reported as an attempt that succeeded.
    //
    // 🔴 But the bridge URLs must NOT go null here. `getExposedPorts` is the
    // authoritative list of what is currently exposed, and it was already
    // fetched above, so read the app/code ports straight out of it. Reporting
    // `exposed: false` on this path — as this did before — meant every WARM
    // `/sandbox/preview` call (i.e. every call after the first, which is most
    // of them) returned `appPreviewUrl: null` / `codePreviewUrl: null` even
    // though both ports were exposed and serving. The shell would then have a
    // working preview window on the very first open of a project and an empty
    // one on every subsequent open, with a 200 and no error anywhere.
    // `exposed: true` here is an OBSERVATION from `getExposedPorts`, not an
    // assumption.
    const alreadyExposeResult = (p: { port: number } | null): AppPreviewExposeResult => {
      if (!p) return { attempted: false, exposed: false };
      const hit = exposed.find((e) => e.port === p.port);
      return hit ? { attempted: false, exposed: true, url: hit.url } : { attempted: false, exposed: false };
    };
    bootLog('container_start', 'end', { status: 'skipped', detail: 'already_exposed', cumulativeMs: Date.now() - bootT0 });
    bootLog('ready', 'end', { status: 'ok', cumulativeMs: Date.now() - bootT0, detail: 'already_exposed' });
    return {
      url: already.url,
      appPreviewExpose: alreadyExposeResult(appPortFor(mode)),
      codePreviewExpose: alreadyExposeResult(codePortFor(mode)),
    };
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
  // in-container (workspace hydration, Xvfb, openbox, code-server/Chrome
  // launch, the window-ready gate, neko's own HTTP bind — the dev-server
  // launch deliberately comes AFTER all of that, see `launch_devserver`) —
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
    // Boot phase/outcome data must reach the ingest path on the FAILURE path
    // too, not just a human-readable stderr tail folded into this Error's
    // message — see this function's `onBootTelemetry` param doc comment.
    if (onBootTelemetry) {
      try {
        onBootTelemetry(await drainContainerBootTelemetry(sandbox));
      } catch {
        /* telemetry drain is best-effort; must never mask the real boot failure */
      }
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
      const exposedAppUrl = await exposePreviewPort(sandbox, hostname, appPreview.port, appPreview.token);
      appPreviewExpose = { attempted: true, exposed: true, url: exposedAppUrl };
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

  // Same best-effort, non-blocking, never-silent contract as the app-preview
  // exposure just above, for the code-server bridge port (`codePortFor`, see
  // `desktop-mode.ts`). Also neko-only (guacamole has no code-server
  // process). A failure here never blocks the desktop preview response —
  // `handleBridgeHost`'s cookie-gated proxy reaches code-server via
  // `containerFetch` regardless of whether this raw exposure succeeds, same
  // as the app-preview port.
  const codePreview = codePortFor(mode);
  let codePreviewExpose: AppPreviewExposeResult = { attempted: false, exposed: false };
  if (codePreview) {
    bootLog('code_preview_expose', 'start');
    codePreviewExpose = { attempted: true, exposed: false };
    try {
      const exposedCodeUrl = await exposePreviewPort(sandbox, hostname, codePreview.port, codePreview.token);
      codePreviewExpose = { attempted: true, exposed: true, url: exposedCodeUrl };
      bootLog('code_preview_expose', 'end', { status: 'ok', cumulativeMs: Date.now() - bootT0 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      codePreviewExpose = { attempted: true, exposed: false, error: message };
      bootLog('code_preview_expose', 'end', { status: 'error', cumulativeMs: Date.now() - bootT0 });
      console.error(
        `[ensureDesktop] code-preview port expose failed (hostname=${hostname}, port=${codePreview.port}): ${message}`,
      );
    }
  }

  bootLog('ready', 'end', { status: 'ok', phaseMs: Date.now() - bootT0, cumulativeMs: Date.now() - bootT0 });
  // Boot phase/outcome data must reach the ingest path on the SUCCESS path
  // too — previously nothing at all read the container's own boot-phase log
  // when the boot went fine (`proc.getLogs()` was only ever consulted on the
  // `!ready` branch above), so a healthy boot's own phase timings/skips were
  // invisible everywhere except a live `wrangler tail`.
  if (onBootTelemetry) {
    try {
      onBootTelemetry(await drainContainerBootTelemetry(sandbox));
    } catch {
      /* telemetry drain is best-effort; must never fail an otherwise-ready desktop */
    }
  }
  return { url: desktopUrl, appPreviewExpose, codePreviewExpose };
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
    // Sanitized AT THE SOURCE, not only where it is logged: `detail` is also
    // returned to the caller in the `/sandbox/preview` response body and
    // re-wrapped by two other call sites (`diag_mount_failed`,
    // `twen_mount_failed`), and an s3fs error carries the mount path — i.e. a
    // username and a project name. `LifecycleTimeline.build` sanitizes again
    // on the way to telemetry; sanitizing is idempotent.
    return {
      mounted: false,
      detail: `mount_failed_after_${MOUNT_ATTEMPTS}_attempts: ${sanitizeErrorMessage(mountErr)}`,
    };
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
      // Same reason as `mount_failed_after_*` above — an ENOENT/EACCES from
      // the seed check names the mount path verbatim.
      detail: `seed_check_failed: ${sanitizeErrorMessage(err)}`,
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

    // GAP (T30): `seedWorkspaceIfAbsent`'s template copy (above, on the
    // genuinely-empty-workspace branch only) is the ONLY place the Turbopack
    // `turbopack: { root: '/' }` fix (PLATFORM-NOTES §18) ever landed — a
    // real, already-hydrated workspace (content already in R2 before this fix
    // shipped, so never empty, so never seeded) never got it, and the
    // Turbopack symlink fatal still greets it on every `next dev`. Run
    // UNCONDITIONALLY here — after EVERY successful hydrate, seeded or not —
    // rather than only on the non-seeded branch: cheap, and a backstop against
    // the template itself ever losing the config file. See
    // `buildEnsureTurbopackConfigCommand`'s doc comment in `./workspace-seed`
    // for the full safety contract (never touches a user's own config, never
    // touches a non-Next project, writes at most once ever per project so it
    // cannot churn the periodic R2 flush).
    try {
      const turbopackResult = await sandbox.exec(buildEnsureTurbopackConfigCommand(mountPath));
      const outcome = parseTurbopackConfigOutcome(turbopackResult.stdout);
      if (outcome === 'written') {
        console.log(
          `[ensureWorkspaceMount] wrote the Turbopack config (turbopack.root fix) into a Next.js workspace at ${mountPath} that had none — likely a pre-existing computer hydrated before this fix shipped.`,
        );
      } else if (outcome === 'skipped_existing_config') {
        console.log(
          `[ensureWorkspaceMount] workspace at ${mountPath} already has its own next.config.* — leaving it untouched.`,
        );
      }
      // 'skipped_not_next' / null: not a Next.js project (or the exec itself
      // produced no recognizable marker) — nothing to fix, nothing to log.
    } catch (err) {
      // Best-effort, like every other step in this function: never fail boot
      // over a config-convenience fix.
      console.error(
        `[ensureWorkspaceMount] Turbopack config check failed (path=${mountPath}) — continuing without it: ${
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
/**
 * 🔴 REMOVED, deliberately — read this before reintroducing anything like it.
 *
 * This key used to hold a boolean "the periodic flush loop is running", and
 * `recordWorkspaceHydration` returned early whenever it was `true`. Production
 * measurement (`wrangler tail` against a full container boot) showed EVERY
 * `workspace_flush` line reading `trigger=explicit` and not one reading
 * `trigger=alarm` — the loop was permanently dead for that sandbox, so the
 * idle-stop never ran AND the workspace only persisted on explicit flushes,
 * against `docs/PLATFORM-NOTES.md` §8 (containers have no guaranteed lifetime;
 * persistence must be continuous and eager).
 *
 * The mechanism, confirmed in the SDK's own source: `@cloudflare/containers`'
 * `alarm()` dispatcher runs a due schedule's callback inside a `try`, logs any
 * throw, and then UNCONDITIONALLY deletes that schedule row
 * (`DELETE FROM container_schedules WHERE id = ...`) — it never reschedules on
 * our behalf. So one throw out of `flushWorkspaceScheduled` (a `listFiles` /
 * `readFile` RPC against a container that went away mid-cycle is enough)
 * deleted the only pending row while this flag stayed `true`. Every later boot
 * then read "already started" and returned early. Dead forever, for that
 * sandbox, with no way back.
 *
 * The lesson is not "reset the flag in one more place": it is that a flag
 * maintained in parallel with the scheduler's own state can disagree with it,
 * and when it does, it wins for the wrong reason. Liveness is now DERIVED from
 * the scheduler — `listSchedules(WORKSPACE_FLUSH_CALLBACK)` + the staleness
 * check in {@link workspaceFlushLoopIsAlive} — which cannot go stale
 * independently of the thing it describes. The key is deleted on every hydrate
 * purely so old sandboxes do not carry a misleading orphan around.
 */
const LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY = 'ezil:workspaceFlushLoopStarted';
/**
 * Set by `terminateSandbox()`/`destroy()`; cleared by the next successful boot
 * (`recordWorkspaceHydration`). While set, the periodic flush loop MUST NOT
 * run and MUST NOT reschedule itself.
 *
 * Why this exists — the container-resurrection bug this fixes:
 * `@cloudflare/containers`' `alarm()` executes every DUE schedule BEFORE it
 * checks `this.container.running`, and `runWorkspaceFlush()` walks the
 * workspace over container RPCs. `Sandbox.containerFetch()` **auto-starts a
 * stopped container** (`startAndWaitForPorts`). So a genuinely destroyed
 * container was brought back to life by its own flush alarm within one
 * `WORKSPACE_FLUSH_INTERVAL_SECONDS` window — teardown could never stick.
 * `destroy()` in the SDK deletes only its OWN storage keys (`portTokens`,
 * `tunnels*`), so nothing upstream cancels our schedule; we must do it here.
 *
 * CRITICAL DISTINCTION from the idle-stop path below: this key means
 * "explicitly torn down by `DELETE /sandbox/:name` — never come back without
 * a fresh boot deciding to". Idle-stop (triggered by `IDLE_STOP_MS` inactivity,
 * see `flushWorkspaceScheduled`) is a DIFFERENT, NEW state — it stops the
 * container the same way (so it stops billing) but does NOT set this
 * tombstone, because the next `/sandbox/preview` for an idle-stopped sandbox
 * must boot normally, exactly like any other cold start. Reusing this key for
 * idle-stop would make every idle-stopped sandbox indistinguishable from an
 * explicitly-deleted one — permanently refusing to reboot until something
 * else happened to clear the tombstone.
 */
const WORKSPACE_TERMINATED_KEY = 'ezil:workspaceTerminated';

/** The `schedule()` callback name for the periodic workspace flush — also the key `deleteSchedules()` cancels by. */
const WORKSPACE_FLUSH_CALLBACK = 'flushWorkspaceScheduled';

/**
 * Last time this sandbox observed GENUINE user-driven activity (`Date.now()`
 * epoch ms). Bumped ONLY by real signals, never by the periodic flush alarm:
 *
 *   - `recordWorkspaceHydration` — a hydrate attempt only ever runs in
 *     response to an authenticated caller reaching `ensureWorkspaceMount`
 *     (`/sandbox/preview`, `/sandbox/:id/workspace-diag`, `/sandbox/:id/twen`
 *     — never the alarm), so it counts as "desktop open/mint" regardless of
 *     whether hydration itself succeeded.
 *   - `runWorkspaceFlush('explicit')` — the pre-handoff flush in
 *     `handlePreview` and the pre-destroy flush in `terminateSandbox`. Both
 *     only ever run from a real inbound request, never from `schedule()`.
 *   - `EzilSandboxDO.recordActivity` — the `POST /sandbox/:name/activity`
 *     heartbeat (see that method's doc comment).
 *
 * `flushWorkspaceScheduled` (trigger `'alarm'`) MUST NEVER write this key.
 * That was the actual root cause of the billing bug this file fixes: the
 * alarm resetting its own idle clock every `WORKSPACE_FLUSH_INTERVAL_SECONDS`
 * by touching the container (`containerFetch()` auto-starts / renews
 * activity). Writing here from the alarm would rebuild that bug byte-for-byte
 * with a different variable name.
 */
const LAST_ACTIVITY_AT_KEY = 'ezil:lastActivityAt';

/**
 * Internal bookkeeping ONLY for `computeNextFlushBackoffSeconds` — the
 * `lastActivityAt` value the alarm observed as of the END of the PREVIOUS
 * flush cycle, so the current cycle can tell "did activity advance since
 * last time" without needing a second, alarm-writable copy of
 * `LAST_ACTIVITY_AT_KEY` itself. Writing here is bookkeeping ABOUT that key,
 * never a write TO it.
 */
const WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY = 'ezil:workspaceFlushLastSeenActivityAt';

/** Current reschedule interval (seconds) for the self-perpetuating flush loop — see `computeNextFlushBackoffSeconds`. */
const WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY = 'ezil:workspaceFlushBackoffSeconds';

/**
 * Backstop ceiling (ms) for `terminateSandbox()`'s primary confirmation
 * signal — `ctx.container.monitor()` settling (see that method for why this
 * is preferred over polling `.running` directly).
 *
 * WHY THIS EXISTS, and why it replaced a blind poll of `.running`: live
 * observation showed 1 in 5 signed DELETEs reporting HTTP 500
 * `still_running` even though the NEXT preview open was a genuine cold
 * first-run boot — proof `destroy()` had actually landed. The bug was never
 * in `buildTerminateReport`'s decision (still-running-after-destroy IS a
 * real failure, in principle); it was in what `runningAfter` was measured
 * from. `ctx.container.running` is a synchronous flag on the SAME native
 * `Container` binding `@cloudflare/containers` itself awaits via
 * `.monitor()` before updating its own internal state (see
 * `setupMonitorCallbacks` in `@cloudflare/containers/dist/lib/container.js`)
 * — i.e. the flag can lag the actual "process has exited" event by more than
 * a fixed short poll window allows for. `monitor()` IS that event: its
 * promise settles (fulfilled on a clean exit, rejected otherwise — a SIGKILL
 * from `destroy()` is not a clean exit) exactly when the container process
 * is gone, so awaiting it is waiting for the real signal instead of guessing
 * how long a control-plane acknowledgement takes. This constant is only a
 * safety ceiling in case that promise never settles (e.g. it was already
 * captured against an instance that raced ahead of us) — generous on
 * purpose, since it backstops an event-driven wait rather than being the
 * measurement itself.
 */
const TERMINATE_MONITOR_BACKSTOP_MS = 10_000;

/**
 * After the monitor-based wait above (or immediately, when nothing was
 * running to monitor in the first place), do one final short poll of
 * `ctx.container.running` for the ground-truth postcondition
 * `buildTerminateReport` needs. This is now a SECONDARY check absorbing only
 * the last sliver of lag between "the monitor promise settled" and "the
 * `.running` flag itself flipped" — it is deliberately short because the
 * primary wait above is what does the real work.
 */
const TERMINATE_CONFIRM_TIMEOUT_MS = 3_000;
const TERMINATE_CONFIRM_INTERVAL_MS = 250;

/**
 * Deadline for `restartDesktopStack()`'s SIGTERM'd launcher to confirm
 * actually stopped, polled via `getProcess()`. Generous on purpose: it must
 * outlast `terminate_stack`'s OWN internal budget (an 8s SIGTERM grace period,
 * `NEKO_TEARDOWN_GRACE` in `start-neko.sh`, plus the SIGKILL escalation and
 * reap that follow it) with real margin, so a clean teardown is never
 * mistaken for a stuck one. If the launcher is STILL running after this, the
 * relaunch is skipped and the call fails loudly (`stop_timed_out`) rather than
 * booting a second stack on top of a maybe-still-alive one.
 */
const RESTART_STOP_DEADLINE_MS = 20_000;
const RESTART_STOP_POLL_INTERVAL_MS = 500;

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
 * How long a sandbox may sit with no GENUINE user-driven activity before
 * `flushWorkspaceScheduled`'s idle-stop path does a final flush and stops the
 * container. See `LAST_ACTIVITY_AT_KEY`'s doc comment for the exhaustive list
 * of what counts as activity — the periodic flush alarm itself never does.
 *
 * 10 minutes: long enough that a user reading/thinking between actions in an
 * open desktop tab is never mistaken for "gone", short enough that the
 * measured failure mode (a container idle for 26 HOURS under the old
 * `SLEEP_AFTER='30m'` platform timer — see BILLING-BRIEF.md) cannot recur:
 * this path does not depend on that platform timer at all.
 */
const IDLE_STOP_MS = 10 * 60_000;

/**
 * The reschedule-interval ladder `computeNextFlushBackoffSeconds` steps
 * through. `[0]` (10s, == `WORKSPACE_FLUSH_INTERVAL_SECONDS`) is also the
 * value every cycle resets to the moment either a file actually changed or
 * genuine activity advanced; the ladder only climbs on a cycle that finds
 * NOTHING to do, and caps at the last entry (60s) rather than growing
 * unbounded.
 */
const WORKSPACE_FLUSH_BACKOFF_STEPS_SECONDS = [WORKSPACE_FLUSH_INTERVAL_SECONDS, 30, 60] as const;

/**
 * How far PAST its own fire time a pending `container_schedules` row may be
 * before {@link workspaceFlushLoopIsAlive} stops believing it.
 *
 * A schedule row is the scheduler's own state, so it cannot drift out of sync
 * with the scheduler the way the old boolean flag did — but it is still not
 * quite the same claim as "an alarm will actually arrive". A row can outlive
 * its alarm (the alarm handler itself throwing past workerd's retry budget,
 * for instance), and a row nobody will ever run is exactly as dead as no row
 * at all. So the check has a liveness component: a row due more than this long
 * ago is treated as debris, not as a running loop.
 *
 * 5 minutes is chosen to sit in the gap between the two clocks it must not
 * confuse:
 *   - comfortably ABOVE every legitimate delay — our own longest reschedule is
 *     60s (`WORKSPACE_FLUSH_BACKOFF_STEPS_SECONDS`' cap) and the SDK's alarm
 *     loop re-arms at worst every 3 minutes, so a healthy loop is never
 *     mistaken for a dead one;
 *   - comfortably BELOW `IDLE_STOP_MS` (10 minutes), so this can never race
 *     the idle-stop decision or resurrect a loop the idle path just retired.
 */
const WORKSPACE_FLUSH_SCHEDULE_STALE_AFTER_MS = 5 * 60_000;

/**
 * Is the periodic flush loop ACTUALLY still pending — asked of the scheduler's
 * own rows, never of a flag we maintain alongside them. See
 * {@link LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY} for the production incident
 * that made this the only acceptable way to answer the question.
 *
 * `Schedule.time` is UNIX SECONDS (the SDK writes `Date.now()/1000 + delay`),
 * hence the `* 1000`. A row whose `time` is not a finite number is debris from
 * a corrupt/foreign write and is NOT counted as alive: an unreadable schedule
 * must never be the reason a workspace stops being persisted.
 *
 * Pure and exported so the ONE decision that can turn continuous persistence
 * off is unit-testable by CALLING it, exactly like `isIdleStopDue`.
 */
export function workspaceFlushLoopIsAlive(params: {
  pendingSchedules: ReadonlyArray<{ time: number }>;
  nowMs: number;
}): boolean {
  return params.pendingSchedules.some(
    (s) => Number.isFinite(s.time) && s.time * 1000 > params.nowMs - WORKSPACE_FLUSH_SCHEDULE_STALE_AFTER_MS,
  );
}

/**
 * Pure idle-stop predicate — no I/O, so this is a real, invokable unit test
 * (`isIdleStopDue`'s own suite) rather than a grep for a string, mirroring
 * `codePreviewFolderParams` above. Isolated from `flushWorkspaceScheduled` so
 * the ONE thing that decides "has this sandbox been idle long enough" can be
 * mutation-tested by calling it, not by reading source text.
 */
export function isIdleStopDue(params: { lastActivityAt: number; now: number }): boolean {
  return params.now - params.lastActivityAt >= IDLE_STOP_MS;
}

/**
 * ── SIGNAL B: is the CONTAINER doing real work, whatever the user is doing ──
 *
 * The owner requirement is literally "no work, AND no activity from the
 * user". `isIdleStopDue` above answers only the second half. A user can
 * legitimately start a long `bun install` / `next build` / test run and then
 * go look at something else — presence goes stale, ten minutes pass, and
 * stopping the container at that moment destroys work that was in progress.
 * So BOTH must be false before an idle stop: nobody present AND nothing
 * running.
 *
 * The probe is `/proc/loadavg`'s 1-minute figure, read over the same
 * `sandbox.exec()` path everything else in this file uses. It runs ONLY once
 * presence is already stale, so in the common case (a user at their desk) it
 * costs nothing at all.
 *
 * ── Why the 1-minute average, and not 5/15 ──────────────────────────────────
 * Consecutive probes are at most `WORKSPACE_FLUSH_BACKOFF_STEPS_SECONDS`'s
 * cap — 60s — apart, so successive 1-minute windows TILE the timeline with no
 * gap: no burst of work can slip between two probes unobserved. It is also
 * the shortest window that still bridges the brief lulls inside a real build
 * (the seconds between `install` finishing and `compile` starting), because
 * the kernel's EWMA decays with a 60s time constant: a second of true idle
 * inside a busy minute moves the figure by under 2%.
 */
const LOADAVG_PROBE_COMMAND = 'cat /proc/loadavg';

/**
 * The 1-minute load average at or above which the container counts as BUSY
 * and an otherwise-due idle stop is refused.
 *
 * ── MEASURED, not guessed ───────────────────────────────────────────────────
 * Bench: the real production image (`ezil-os-worker-sandbox`, this
 * directory's Dockerfile) run under `--cpus=2` to match `wrangler.toml`'s
 * `instance_type = "standard-3"` (2 vCPU), desktop booted through
 * `start-desktop.sh` in `neko` mode with the full resident set up — Xvfb,
 * openbox, pulseaudio, dbus, Chrome (11 processes) on the mandatory landing
 * page, code-server, the dev server, `neko serve`, and the base image's own
 * control-plane Bun server.
 *
 * Container runtimes generally do NOT namespace `/proc/loadavg` (verified on
 * the bench: inside the container it reported the HOST's figure and `nproc`
 * the host's core count), so the kernel's own algorithm was reproduced over
 * the container's PID namespace instead — count tasks in R or D state every
 * 5s (CALC_LOAD_INTERVAL, threads not processes), EWMA with the 1-minute
 * constant EXP_1 = 1884/2048 — which is exactly what a namespaced
 * `/proc/loadavg` reports. Cross-checked against cgroup CPU accounting, and
 * calibrated: one deliberate busy thread moved the figure by exactly 1.0.
 *
 *   A. idle, NO session attached          (8.1 min steady state)
 *        load1  min 0.0000  p50 0.0000  p95 0.0000  max 0.0000
 *        cpu    0.0040 cores mean
 *   B. idle, WebRTC SESSION ATTACHED      (7.1 min steady state)
 *        load1  min 0.0485  p50 0.1793  p95 0.2784  max 0.3055
 *        cpu    0.2366 cores mean
 *   C. one busy thread + session attached (3.1 min steady state)
 *        load1  min 0.8054  p50 1.1177  p95 1.4049  max 1.4402
 *        cpu    1.2539 cores mean
 *
 * 🔴 (B) is the case that decides this number, and it is the one that would
 * have been missed by reasoning instead of measuring. A user who leaves the
 * tab open and walks away is state (B), not state (A): the Neko WebRTC
 * session stays connected and `neko` keeps software-encoding 1920x1080 vp8
 * for nobody, costing a QUARTER OF A CORE continuously. That is a container
 * that MUST still be stoppable — it is precisely the "a tab merely left open
 * must not bill" case from the billing brief — so the threshold has to sit
 * ABOVE (B)'s ceiling, not just above (A)'s.
 *
 * ── Where the number comes from ─────────────────────────────────────────────
 * (B) and (C) are the two bands that must be told apart, and they are cleanly
 * separated: (B) never exceeds 0.3055, (C) never drops below 0.8054. The
 * threshold is their GEOMETRIC mean, sqrt(0.3055 * 0.8054) = 0.4957 -> 0.50,
 * which is the point that leaves the same RATIO of margin on both sides:
 *
 *     1.64x above (B)'s observed maximum      — an abandoned session still stops
 *     1.61x below (C)'s observed minimum      — a working container never does
 *
 * It is round because the measurement made it round, not because 0.5 looked
 * like a nice number. A slower, I/O-bound build averaging only 0.3 cores
 * still lands at ~0.54 with (B)'s baseline underneath it, so it is protected
 * too; and the kernel's EWMA crosses this line after 40s of a single busy
 * thread, well inside the 10 minutes of absence required before the probe
 * runs at all.
 *
 * ── Residual risk, stated ───────────────────────────────────────────────────
 * A container left showing ANIMATED content raises (B) — the encoder has real
 * frames to compress — and could sit above 0.50 with nobody there. That fails
 * in the safe direction (money, not work) and the platform's own `SLEEP_AFTER`
 * still collects it.
 *
 * ── Retuning it ─────────────────────────────────────────────────────────────
 * `EZIL_NEKO_CPU_DIAG_ENABLED=1` makes `scripts/start-neko.sh` sample real
 * `load1` from inside a live production container into
 * `/tmp/neko-cpu-diag.jsonl`, retrievable over the existing
 * `/sandbox/:name/cpu-diag` route (`./cpu-diag.ts`). That is the instrument
 * to re-measure with if the image's resident set ever changes; it is also how
 * to check the one thing the bench CANNOT: whether Cloudflare's container
 * runtime namespaces `/proc/loadavg` at all. If it does not, this probe reads
 * the neighbours' load, always answers BUSY, and idle-stop silently stops
 * happening — which is why `containerBusyFromProbe` returns the observed
 * figure and `flushWorkspaceScheduled` logs it on EVERY probe, stop or no
 * stop.
 */
const CONTAINER_BUSY_LOAD1 = 0.5;

/**
 * Pure parse of `/proc/loadavg`'s first field. The file is one line —
 * `0.42 0.31 0.28 1/512 1234` — and only the first number is read.
 *
 * Returns `null` for anything that is not a finite, non-negative number, so
 * the caller can apply the fail-safe rather than this silently inventing a
 * `0` that would authorize a stop.
 */
export function parseLoadAvg1(stdout: string): number | null {
  const first = String(stdout ?? '').trim().split(/\s+/)[0];
  if (!first) return null;
  // 🔴 Require the WHOLE token to be a plain decimal. The `Number.isFinite`
  // and `< 0` checks below are not sufficient on their own and it is worth
  // being precise about why: they happen to reject the obvious garbage
  // (`cat:` -> NaN, `0.5abc` -> NaN, `-1.0` -> negative), but JS will gladly
  // evaluate `5e-3` to 0.005 and `0x0` to 0 — values BELOW the busy
  // threshold, i.e. authorizations to STOP a container, conjured out of bytes
  // `/proc/loadavg` cannot emit. This format check is the guard that actually
  // carries the fail-safe for that class of input.
  if (!/^\d+(\.\d+)?$/.test(first)) return null;
  const value = Number(first);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * 🔴 THE FAIL-SAFE. Turn a `/proc/loadavg` probe into a busy verdict.
 *
 * Every way of NOT KNOWING resolves to BUSY — the probe threw (`null`), the
 * command exited non-zero, `/proc/loadavg` was missing or unreadable, stdout
 * did not parse. Only an actual number, actually below
 * {@link CONTAINER_BUSY_LOAD1}, is allowed to authorize stopping a container.
 *
 * The asymmetry is deliberate and is the contract: a container that lingers
 * costs money and the platform's own `SLEEP_AFTER` backstop eventually
 * collects it; a container stopped mid-build costs the user work that cannot
 * be recovered.
 *
 * Returns the observed figure alongside the verdict so the caller can log
 * what it actually saw — the only way an operator can tell "genuinely idle"
 * from "this probe has never once returned a usable number".
 */
export function containerBusyFromProbe(
  probe: { exitCode: number; stdout: string } | null,
): { busy: boolean; load1: number | null; reason: string } {
  if (probe === null) {
    return { busy: true, load1: null, reason: 'probe_threw' };
  }
  if (probe.exitCode !== 0) {
    return { busy: true, load1: null, reason: `probe_exit_${probe.exitCode}` };
  }
  const load1 = parseLoadAvg1(probe.stdout);
  if (load1 === null) {
    return { busy: true, load1: null, reason: 'unparseable' };
  }
  return {
    busy: load1 >= CONTAINER_BUSY_LOAD1,
    load1,
    reason: load1 >= CONTAINER_BUSY_LOAD1 ? 'load_above_threshold' : 'load_below_threshold',
  };
}

/**
 * Pure idle-backoff step function backing the "otherwise flush as today"
 * branch of `flushWorkspaceScheduled`. Given what the JUST-COMPLETED cycle
 * observed, decides the interval for the NEXT `schedule()` call:
 *
 *   - a file actually changed (`wroteSomething`), OR genuine activity
 *     advanced since the previous cycle (`activityAdvanced`) → back to the
 *     base interval (steps[0]) — minimize the eviction-window data-loss
 *     exposure while something is actually happening.
 *   - neither → climb one rung of `WORKSPACE_FLUSH_BACKOFF_STEPS_SECONDS`,
 *     capped at the last one — nothing to do, so stop paying the DO-CPU cost
 *     of walking the workspace tree every 10s.
 *
 * `previousIntervalSeconds` not matching any rung (should not happen in
 * practice — this DO is the only writer of that stored value, and always
 * writes a value from this same ladder) falls back to the first climb step
 * rather than throwing.
 */
export function computeNextFlushBackoffSeconds(params: {
  previousIntervalSeconds: number;
  wroteSomething: boolean;
  activityAdvanced: boolean;
}): number {
  const steps = WORKSPACE_FLUSH_BACKOFF_STEPS_SECONDS;
  if (params.wroteSomething || params.activityAdvanced) {
    return steps[0];
  }
  const currentIndex = (steps as readonly number[]).indexOf(params.previousIntervalSeconds);
  const nextIndex = currentIndex === -1 ? 1 : Math.min(currentIndex + 1, steps.length - 1);
  return steps[nextIndex];
}

/**
 * Pure derivation of the absolute `lastActivityAt` timestamp `POST
 * /sandbox/:name/activity` records, from the client-reported "how long ago
 * was real input" duration. Deliberately NOT `now` — the shell heartbeats
 * every 60s for as long as real input happened within the last 30 minutes
 * (see BILLING-BRIEF.md's "Shell" contract), so a heartbeat firing does NOT
 * itself mean "activity just happened"; a user idle for 25 minutes with the
 * tab still open keeps heartbeating with a GROWING `lastInputAgoMs`, and
 * treating that as "now" would reset the idle clock every 60s forever —
 * rebuilding the exact immortality bug this whole change fixes, just moved
 * into the new endpoint instead of the alarm.
 *
 * `lastInputAgoMs` is clamped to `>= 0` defensively (a negative value would
 * push the derived timestamp into the FUTURE, which would make
 * `isIdleStopDue` never fire against real wall-clock time — the same
 * immortality failure mode again). `validateActivityBody` below additionally
 * REJECTS a negative value outright at the route layer (400, not a silent
 * clamp) — this clamp is defense-in-depth for the DO-side RPC itself, which
 * is reachable by any future caller of `EzilWorkspacePersistRpc`, not only
 * this one route.
 */
export function computeActivityTimestamp(params: { now: number; lastInputAgoMs: number }): number {
  const agoMs = Number.isFinite(params.lastInputAgoMs) ? Math.max(0, params.lastInputAgoMs) : 0;
  return params.now - agoMs;
}

/**
 * Validate `POST /sandbox/:name/activity`'s `{ lastInputAgoMs: number }`
 * body. Rejects outright (never coerces/defaults) anything that isn't a
 * finite, non-negative number — same "closed contract, 400 on anything else"
 * discipline as `validateFocusApp` (`./sandbox-control.ts`).
 */
export function validateActivityBody(
  raw: unknown,
): { ok: true; lastInputAgoMs: number } | { ok: false; error: string } {
  const value =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).lastInputAgoMs
      : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { ok: false, error: 'lastInputAgoMs_missing_or_not_a_finite_number' };
  }
  if (value < 0) {
    return { ok: false, error: 'lastInputAgoMs_must_be_non_negative' };
  }
  return { ok: true, lastInputAgoMs: value };
}

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
 *     not), and — ONLY once hydration has actually succeeded, and only when no
 *     flush cycle is genuinely pending — (re)starts the self-rescheduling
 *     flush loop via the `@cloudflare/containers` SDK's own `schedule()`
 *     primitive. "Genuinely pending" is read back OUT of the scheduler
 *     (`workspaceFlushLoopAlive` -> `listSchedules`), never from a boolean we
 *     keep alongside it; see `LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY` for the
 *     measured incident where such a boolean outlived the schedule it
 *     described and left the loop dead forever. That makes every boot a
 *     recovery point. This deliberately does NOT override `alarm()` (the SDK
 *     reserves that for container-lifecycle keepalive — see the
 *     `@cloudflare/containers` README: "Instead of using the default alarm
 *     handler, use `schedule()` instead").
 *   - `flushWorkspaceScheduled()` — the callback name `schedule()` invokes.
 *     Runs one flush pass and reschedules itself on most cycles (neither a
 *     failed flush NOR a thrown one may kill the loop — failures are logged
 *     loudly via `bootLog`/`console.error`, never swallowed), with THREE
 *     exceptions that
 *     do neither, checked in order: the sandbox is tombstoned
 *     (`WORKSPACE_TERMINATED_KEY`, unchanged from before), the container is
 *     already not running (`containerIsRunning()` — never resurrect what
 *     already stopped), or the sandbox has been idle for `IDLE_STOP_MS` (does
 *     a FINAL flush, and only stops the container — via `this.stop()`, NOT
 *     `destroy()` — if that flush actually succeeded). A cycle that keeps
 *     looping backs off its own reschedule interval when it finds nothing to
 *     do (`computeNextFlushBackoffSeconds`).
 *   - `flushWorkspaceNow()` — the same flush pass, called directly by the
 *     Worker (an ordinary Durable Object RPC — the same call style as the
 *     pre-existing `sandbox.exec()`) for the two EXPLICIT flush points this
 *     change adds: immediately before `/sandbox/preview` hands the ready URL
 *     back to the caller, and immediately before `DELETE /sandbox/:name`
 *     calls `destroy()` (see `handlePreview` / `handleTerminate`).
 *   - `recordActivity()` — the `POST /sandbox/:name/activity` heartbeat's
 *     DO-side write. See `LAST_ACTIVITY_AT_KEY`'s doc comment.
 *
 * `class_name = "Sandbox"` in wrangler.toml binds to whatever this module
 * exports under the name `Sandbox` — exporting THIS subclass under that exact
 * name (see `export { EzilSandboxDO as Sandbox }` below) requires ZERO
 * wrangler.toml / migration changes: the underlying DO storage class
 * identity is unchanged, only new methods are added on top of it.
 */
class EzilSandboxDO extends CFSandboxClass<Env> {
  /**
   * Reentrancy guard for `restartDesktopStack()`. A DO instance is a single
   * JS object handling one request at a time cooperatively, but `await`
   * points let a SECOND concurrent restart call interleave with the first —
   * two overlapping kill+relaunch cycles racing is exactly the orphan/
   * port-collision failure mode `terminate_stack` was written to prevent.
   * This makes a second call while one is in flight a fast, honest no-op
   * (`outcome: 'restart_in_progress'`) instead of a race.
   */
  private restartInProgress = false;

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

    // An EXPLICIT flush is always caller-initiated — the `/sandbox/preview`
    // pre-handoff flush and `terminateSandbox()`'s pre-destroy flush both only
    // ever run from a real inbound request, never from `schedule()`. Counts as
    // genuine activity. The `'alarm'` trigger MUST NEVER reach this branch —
    // see `LAST_ACTIVITY_AT_KEY`'s doc comment for why that would rebuild the
    // exact billing bug this file fixes.
    if (trigger === 'explicit') {
      await this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, Date.now());
    }

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
    let outcome: FlushOutcome;
    try {
      outcome = await flushWorkspaceToR2({
        container: this,
        bucket,
        mountPath: wctx.mountPath,
        realPrefix: wctx.prefix,
        manifest,
        hydrationComplete: hydrated,
        log: (message) => console.error(`[workspace_flush] ${message}`),
      });
    } catch (err) {
      // 🔴 A THROW HERE USED TO KILL THE LOOP PERMANENTLY. `flushWorkspaceToR2`
      // walks the workspace over container RPCs (`listFiles` in
      // `walkWorkspaceTree`, then `readFile` per file); a container that goes
      // away mid-cycle makes those REJECT rather than return. That rejection
      // propagated out of `flushWorkspaceScheduled`, and
      // `@cloudflare/containers`' alarm dispatcher responds to a throwing
      // callback by logging it and then deleting the schedule row anyway —
      // without rescheduling. One transient RPC failure therefore ended
      // continuous persistence for that sandbox until the next hydrate.
      //
      // Reported as an ordinary FAILED outcome instead, which keeps two
      // separate contracts intact: the caller reaches its reschedule, and the
      // idle path's "stop only if the FINAL flush succeeded" rule still sees
      // `ok: false` — a flush that threw is emphatically not one that worked.
      // `manifest` is returned unchanged, so nothing is recorded as synced.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[workspace_flush] flush threw (trigger=${trigger}) — treated as a failed cycle: ${message}`);
      bootLog('workspace_flush', 'end', {
        status: 'error',
        phaseMs: Date.now() - t0,
        detail: `trigger=${trigger},reason=flush_threw,hydrated=${hydrated}`,
      });
      return {
        ok: false,
        uploaded: [],
        skippedUnchanged: 0,
        skippedIgnored: 0,
        skippedUnsupported: 0,
        failed: [],
        manifest,
        skippedReason: 'flush_threw',
        heartbeatWritten: false,
      };
    }
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
    // A hydrate attempt only ever runs in response to an authenticated caller
    // reaching `ensureWorkspaceMount` (`/sandbox/preview`,
    // `/sandbox/:id/workspace-diag`, `/sandbox/:id/twen` — NEVER the flush
    // alarm), so it counts as genuine "desktop open/mint" activity regardless
    // of whether hydration itself succeeded. See `LAST_ACTIVITY_AT_KEY`.
    await this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, Date.now());

    await this.ctx.storage.put(WORKSPACE_FLUSH_CONTEXT_KEY, { prefix: params.prefix, mountPath: params.mountPath });
    await this.ctx.storage.put(WORKSPACE_HYDRATED_KEY, params.hydrated);
    // A hydrate attempt means this sandbox is booting again, so any previous
    // explicit terminate is over: clear the tombstone BEFORE the loop-start
    // check below, or the flush loop would stay permanently disabled for a
    // sandbox that was terminated once and later re-created under the same
    // deterministic name (the normal case — `deriveSandboxId` is stable).
    await this.ctx.storage.delete(WORKSPACE_TERMINATED_KEY);
    // Hygiene only — nothing reads this any more. See
    // `LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY`: sandboxes that booted under
    // the old code still carry a `true` here, and leaving that orphan lying
    // around invites someone to trust it again.
    await this.ctx.storage.delete(LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY);
    if (!params.hydrated) return;

    // 🔴 SELF-HEALING GATE. Ask the SCHEDULER whether a flush cycle is
    // genuinely pending; do not ask a boolean we wrote down earlier. The whole
    // measured failure was a `true` that outlived the schedule row it claimed
    // to describe (see `LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY`), so every
    // subsequent boot declined to restart a loop that no longer existed.
    // Asked here, on every hydrate, this makes a boot the recovery point: if
    // nothing is pending — for ANY reason, including reasons we have not
    // thought of — the loop starts again.
    if (await this.workspaceFlushLoopAlive()) return;

    // Fresh container generation, fresh cadence: DO storage (unlike the
    // container filesystem) SURVIVES container recreation, so without this a
    // brand-new boot could inherit a backed-off 60s interval left over from
    // the PREVIOUS generation's idle tail — needlessly widening this
    // generation's own data-loss exposure window from its very first cycle.
    await this.ctx.storage.delete(WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY);
    await this.ctx.storage.delete(WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY);

    // Drop whatever rows the previous generation left (a stale past-due one,
    // or none at all) so the restart below leaves EXACTLY ONE pending cycle
    // rather than stacking a second loop on top of debris. Only reachable once
    // the check above has already ruled the loop dead, so this can never
    // cancel a healthy schedule.
    try {
      this.deleteSchedules(WORKSPACE_FLUSH_CALLBACK);
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=stale_schedule_delete_failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    try {
      await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK);
    } catch (err) {
      // Nothing to un-set: the next hydrate re-derives liveness from the
      // scheduler and will simply find nothing pending, so a failed start
      // retries on its own instead of latching.
      console.error(
        `[ezil-boot] phase=workspace_flush event=schedule_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * "Is a periodic flush cycle actually pending?", answered from the SDK's own
   * `container_schedules` rows via {@link workspaceFlushLoopIsAlive}.
   *
   * 🔴 The `catch` returns FALSE (i.e. "dead — restart it") on purpose, and
   * that direction is load-bearing: a probe that cannot answer must never be
   * the reason a workspace stops being persisted continuously. The cost of
   * being wrong in this direction is bounded and self-limiting (a duplicate
   * schedule row means one extra flush per cycle, and the restart path deletes
   * pre-existing rows first anyway); the cost of being wrong the other way is
   * the unbounded, silent data loss this whole change exists to end.
   */
  private async workspaceFlushLoopAlive(): Promise<boolean> {
    let pending: ReadonlyArray<{ time: number }>;
    try {
      pending = await this.listSchedules(WORKSPACE_FLUSH_CALLBACK);
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=list_schedules_failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
    return workspaceFlushLoopIsAlive({ pendingSchedules: pending, nowMs: Date.now() });
  }

  /**
   * The `schedule()` callback. Checked in order, EXACTLY as documented on the
   * class itself:
   *
   *   1. TOMBSTONED (`WORKSPACE_TERMINATED_KEY`) — unchanged from before this
   *      idle-stop work. Neither flush nor reschedule.
   *   2. NOT RUNNING (`containerIsRunning()`) — the container is already
   *      stopped (a prior idle-stop, an eviction, a crash — doesn't matter
   *      which). `runWorkspaceFlush` reaches into the container over an RPC,
   *      and per the SDK a container RPC AUTO-STARTS a stopped container, so
   *      touching it here would resurrect exactly what stopped it — the same
   *      failure mode `WORKSPACE_TERMINATED_KEY` exists to prevent, just
   *      without an explicit DELETE. Neither flush nor reschedule.
   *   3. IDLE (`isIdleStopDue` against `LAST_ACTIVITY_AT_KEY`) — nobody is
   *      present. That is only HALF the owner requirement ("no work, no
   *      activity from the user"), so before anything else this branch asks
   *      whether the CONTAINER is working: `probeContainerBusy()` reads
   *      `/proc/loadavg` (see `CONTAINER_BUSY_LOAD1`). If it is busy, or if
   *      the probe cannot answer, nothing is stopped — the interval resets to
   *      the base and the same question is asked again next cycle. Only when
   *      the container is POSITIVELY observed quiet does the stop proceed: a
   *      FINAL flush first (`runWorkspaceFlush('alarm')` — trigger stays
   *      `'alarm'` deliberately: this must NOT bump `LAST_ACTIVITY_AT_KEY`),
   *      and ONLY IF THAT SUCCEEDS `this.stop()` — a graceful signal, NOT
   *      `destroy()` — marking the loop stopped WITHOUT setting
   *      `WORKSPACE_TERMINATED_KEY` (see that key's "CRITICAL DISTINCTION"
   *      doc comment: the next preview must boot this sandbox normally). If
   *      the final flush FAILS, stays running and retries the SAME idle check
   *      next cycle at the base interval — losing user work is worse than the
   *      bill, so a flush failure here never gives up.
   *
   * Otherwise (2 and 3 both clear): flushes as before and reschedules,
   * backing off the interval when a cycle finds nothing to do
   * (`nextFlushRescheduleSeconds`).
   *
   * See `WORKSPACE_TERMINATED_KEY`: the tombstone is checked here as well as
   * cancelled in `destroy()` because a schedule row may already be due/
   * in-flight when destroy runs.
   *
   * This outer method is ONLY the survival wrapper — see the `catch` below for
   * why an escaping throw is the one failure this callback cannot afford. The
   * decision logic lives in `runScheduledFlushCycle` immediately after it.
   */
  async flushWorkspaceScheduled(): Promise<void> {
    try {
      await this.runScheduledFlushCycle();
    } catch (err) {
      // 🔴 The SDK's alarm dispatcher deletes this callback's schedule row
      // after it returns — whether it returned or THREW — and never
      // reschedules on our behalf. An escaping throw therefore does not fail
      // one cycle, it ends the loop, and with it continuous persistence (see
      // `LEGACY_WORKSPACE_FLUSH_LOOP_STARTED_KEY` for the production evidence).
      // So the loop is re-armed here rather than allowed to die.
      //
      // Re-arming is SAFE with respect to every guard above: a schedule row
      // touches nothing at all. The tombstone check and the `containerIsRunning()`
      // check both re-run at the top of the next cycle, so a terminated or
      // stopped sandbox is still refused there — this cannot resurrect a
      // container, only re-ask the question.
      console.error(
        `[ezil-boot] phase=workspace_flush event=cycle_threw error=${err instanceof Error ? err.message : String(err)}`,
      );
      try {
        await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK);
      } catch (scheduleErr) {
        console.error(
          `[ezil-boot] phase=workspace_flush event=reschedule_failed error=${
            scheduleErr instanceof Error ? scheduleErr.message : String(scheduleErr)
          }`,
        );
      }
    }
  }

  /** The real body of {@link flushWorkspaceScheduled} — see that method's doc comment for the ordered contract. */
  private async runScheduledFlushCycle(): Promise<void> {
    const terminated = (await this.ctx.storage.get<boolean>(WORKSPACE_TERMINATED_KEY)) ?? false;
    if (terminated) {
      bootLog('workspace_flush', 'end', { status: 'skipped', detail: 'terminated,trigger=alarm' });
      // Returning without rescheduling IS how the loop stops: the SDK deletes
      // this row on the way out, so nothing is pending afterwards and the next
      // successful hydrate is what restarts it.
      return;
    }

    if (!this.containerIsRunning()) {
      bootLog('workspace_flush', 'end', { status: 'skipped', detail: 'not_running,trigger=alarm' });
      // Same reasoning as the tombstone branch above — never touch a container
      // that isn't there, and let the absence of a reschedule be the loop's
      // "stopped" state.
      return;
    }

    const lastActivityAt = (await this.ctx.storage.get<number>(LAST_ACTIVITY_AT_KEY)) ?? Date.now();
    const now = Date.now();
    if (isIdleStopDue({ lastActivityAt, now })) {
      // 🔴 SIGNAL B — "no work" is the OTHER half of the owner requirement.
      // Presence being stale only establishes that nobody is watching; it says
      // nothing about whether the box is mid-`bun install`. Ask the container
      // (see `CONTAINER_BUSY_LOAD1`), and if it is working, leave it alone and
      // look again next cycle. Safe to `exec` here: `containerIsRunning()`
      // above has already established a container is up, so this cannot
      // resurrect a stopped one. Runs ONLY on this branch, so a present user
      // never pays for it.
      const busy = await this.probeContainerBusy();
      if (busy.busy) {
        bootLog('workspace_flush', 'end', {
          status: 'skipped',
          detail: `idle_but_busy,${busy.detail},idleMs=${now - lastActivityAt}`,
        });
        // Back to the base interval — this sandbox is no longer "nothing is
        // happening", so stop treating it as such, and re-ask promptly rather
        // than a minute later. Persist it too, or `nextFlushRescheduleSeconds`
        // would resume climbing from the stale rung on the next quiet cycle.
        await this.ctx.storage.put(WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY, WORKSPACE_FLUSH_INTERVAL_SECONDS);
        try {
          await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK);
        } catch (err) {
          console.error(
            `[ezil-boot] phase=workspace_flush event=reschedule_failed error=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return;
      }

      // Trigger stays `'alarm'` — this must NOT bump `LAST_ACTIVITY_AT_KEY`,
      // idle-triggered or not.
      const outcome = await this.runWorkspaceFlush('alarm');
      if (outcome.ok) {
        bootLog('workspace_flush', 'end', {
          status: 'ok',
          detail: `idle_stop,${busy.detail},idleMs=${now - lastActivityAt}`,
        });
        // A NEW, separate state from `WORKSPACE_TERMINATED_KEY` — deliberately
        // NOT written here. See that key's doc comment: the next
        // `/sandbox/preview` for this sandbox must boot normally, which it
        // does because the absence of a reschedule (below) is the only thing
        // marking this loop retired.
        try {
          await this.stop();
        } catch (err) {
          console.error(
            `[ezil-boot] phase=workspace_flush event=idle_stop_failed error=${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return; // No reschedule: the loop is done. A future hydrate restarts it.
      }

      // 🔴 Never lose user work: the FINAL flush failed, so do not stop. Stay
      // running and retry the same idle check next cycle, at the base
      // interval (not backed off — this sandbox is trying to shut down
      // cleanly and should retry promptly).
      console.error(
        `[ezil-boot] phase=workspace_flush event=idle_final_flush_failed detail=${
          outcome.skippedReason ?? `failed=${outcome.failed.length}`
        }`,
      );
      try {
        await this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK);
      } catch (err) {
        console.error(
          `[ezil-boot] phase=workspace_flush event=reschedule_failed error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }

    const outcome = await this.runWorkspaceFlush('alarm');
    const nextIntervalSeconds = await this.nextFlushRescheduleSeconds(outcome, lastActivityAt);
    try {
      await this.schedule(nextIntervalSeconds, WORKSPACE_FLUSH_CALLBACK);
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=reschedule_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * DO-storage plumbing around the pure `computeNextFlushBackoffSeconds`
   * decision: reads the two bookkeeping keys, computes the next interval, and
   * persists both for the following cycle to compare against. See
   * `WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY`'s doc comment — this writes
   * that key, NEVER `LAST_ACTIVITY_AT_KEY` itself.
   */
  private async nextFlushRescheduleSeconds(outcome: FlushOutcome, lastActivityAtAtCycleStart: number): Promise<number> {
    const previousActivitySeen =
      (await this.ctx.storage.get<number>(WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY)) ?? lastActivityAtAtCycleStart;
    const previousIntervalSeconds =
      (await this.ctx.storage.get<number>(WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY)) ?? WORKSPACE_FLUSH_INTERVAL_SECONDS;

    const nextSeconds = computeNextFlushBackoffSeconds({
      previousIntervalSeconds,
      wroteSomething: outcome.uploaded.length > 0,
      activityAdvanced: lastActivityAtAtCycleStart > previousActivitySeen,
    });

    await this.ctx.storage.put(WORKSPACE_FLUSH_LAST_SEEN_ACTIVITY_AT_KEY, lastActivityAtAtCycleStart);
    await this.ctx.storage.put(WORKSPACE_FLUSH_BACKOFF_SECONDS_KEY, nextSeconds);
    return nextSeconds;
  }

  /** Explicit, on-demand flush — see class doc comment for the two call sites. */
  async flushWorkspaceNow(): Promise<FlushOutcome> {
    return this.runWorkspaceFlush('explicit');
  }

  /**
   * The `POST /sandbox/:name/activity` implementation's DO-side write. See
   * `LAST_ACTIVITY_AT_KEY`'s doc comment for the full contract.
   *
   * Deliberately touches NOTHING else — no `exec`, no `containerFetch`, no
   * container RPC of any kind. This endpoint's entire purpose is helping
   * `flushWorkspaceScheduled` decide when to STOP a container; if writing the
   * activity signal could itself wake one, it would defeat its own purpose
   * (see BILLING-BRIEF.md's contract for this exact wording).
   */
  async recordActivity(lastInputAgoMs: number): Promise<void> {
    const lastActivityAt = computeActivityTimestamp({ now: Date.now(), lastInputAgoMs });
    await this.ctx.storage.put(LAST_ACTIVITY_AT_KEY, lastActivityAt);
  }

  /** True when a container is actually alive under this DO right now. */
  private containerIsRunning(): boolean {
    return this.ctx.container?.running === true;
  }

  /**
   * SIGNAL B's I/O half: read `/proc/loadavg` out of the container and hand
   * it to the pure {@link containerBusyFromProbe} for the verdict. See
   * {@link CONTAINER_BUSY_LOAD1} for the measured threshold.
   *
   * 🔴 The `try` swallows the error deliberately and converts it to `null`,
   * which `containerBusyFromProbe` reads as BUSY. A probe that cannot answer
   * must never be the reason a container gets stopped — the whole point of
   * this guard is that we only stop on a POSITIVE observation of idleness.
   *
   * Only ever called from `flushWorkspaceScheduled`'s idle branch, i.e. after
   * `containerIsRunning()` has already returned true, so this `exec` can
   * never be the thing that starts a container.
   */
  private async probeContainerBusy(): Promise<{ busy: boolean; detail: string }> {
    let probe: { exitCode: number; stdout: string } | null = null;
    try {
      const res = await this.exec(LOADAVG_PROBE_COMMAND, { origin: 'internal' });
      probe = { exitCode: res.exitCode, stdout: res.stdout ?? '' };
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=busy_probe_failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    const verdict = containerBusyFromProbe(probe);
    // Always logged, busy or not: this figure is the only way to tell a
    // genuinely quiet container from a `/proc/loadavg` that is reporting
    // somebody else's machine — see `CONTAINER_BUSY_LOAD1`'s "Retuning it".
    return {
      busy: verdict.busy,
      detail: `load1=${verdict.load1 === null ? 'unknown' : verdict.load1}` + `,busyReason=${verdict.reason}`,
    };
  }

  /**
   * Tombstone this sandbox and cancel the periodic flush loop so nothing can
   * wake the container back up after teardown. Idempotent.
   */
  private async cancelWorkspaceFlushLoop(): Promise<void> {
    await this.ctx.storage.put(WORKSPACE_TERMINATED_KEY, true);
    try {
      // Drops any pending `container_schedules` row for this callback so the
      // next alarm has nothing to run — and, since liveness is now DERIVED
      // from exactly these rows, this is also what records the loop as
      // stopped. Best-effort: the tombstone check at the top of
      // `flushWorkspaceScheduled` is the backstop if this throws.
      this.deleteSchedules(WORKSPACE_FLUSH_CALLBACK);
    } catch (err) {
      console.error(
        `[ezil-boot] phase=workspace_flush event=cancel_schedule_failed error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Every teardown path goes through here, including a bare `sandbox.destroy()`
   * from anywhere else in this Worker — so the flush loop can never outlive the
   * container it flushes.
   */
  override async destroy(): Promise<void> {
    await this.cancelWorkspaceFlushLoop();
    await super.destroy();
  }

  /**
   * The `DELETE /sandbox/:name` implementation, run inside the DO.
   *
   * Ordered so the answer is OBSERVED, never assumed:
   *   1. read `ctx.container.running` BEFORE anything (`wasRunning`);
   *   2. IF running, capture `ctx.container.monitor()` — the promise that
   *      settles exactly when THIS container instance's process exits —
   *      before anything else touches it;
   *   3. flush ONLY if a container is actually up — flushing a sleeping
   *      sandbox would cold-boot it (~20s) purely to kill it again;
   *   4. tombstone + cancel the flush loop (see `destroy()` above);
   *   5. `destroy()`;
   *   6. await the captured monitor promise (bounded), THEN briefly poll
   *      `ctx.container.running` as a final ground-truth check, and report
   *      what was actually observed via `buildTerminateReport`.
   *
   * A name that never ran anything now reports `terminated: false,
   * outcome: 'not_running'` instead of a bogus `terminated: true` — which is
   * exactly the signal that would have surfaced the live incident where
   * DELETEs were sent to `<sandboxId>-nekodesktop` (the preview-hostname
   * label) rather than `<sandboxId>`.
   */
  async terminateSandbox(): Promise<TerminateReport> {
    const wasRunning = this.containerIsRunning();

    // Capture the container's own exit signal BEFORE `destroy()` is issued
    // below, while we know for certain this instance is the one running —
    // see `TERMINATE_MONITOR_BACKSTOP_MS`'s doc comment for why this is the
    // signal to wait on rather than polling `.running` alone. `ctx.container`
    // is the exact same native binding `@cloudflare/containers` itself calls
    // `.monitor()` on internally (`this.container = ctx.container` in its
    // constructor), so this is not reaching into anything private.
    let monitorPromise: Promise<void> | undefined;
    if (wasRunning) {
      try {
        monitorPromise = this.ctx.container?.monitor();
      } catch (err) {
        // Never let this optimization block termination — fall back to the
        // polling loop below unchanged if `.monitor()` itself is unavailable.
        console.error(
          `[terminateSandbox] monitor() capture failed, falling back to polling only: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (wasRunning) {
      // EXPLICIT flush before destroy — the container filesystem (and anything
      // unflushed on it) is gone the moment `destroy()` returns. Best-effort:
      // a flush failure must never block termination (that would let a stuck
      // flush leak a container indefinitely), but it MUST be logged loudly.
      try {
        await this.runWorkspaceFlush('explicit');
      } catch (err) {
        console.error(
          `[terminateSandbox] pre-destroy flush failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await this.cancelWorkspaceFlushLoop();

    let destroyError: string | undefined;
    try {
      // `super.destroy()` — `this.destroy()` would re-run the cancel above
      // harmlessly, but going straight to the SDK keeps this method the single
      // ordered sequence it documents.
      await super.destroy();
    } catch (err) {
      destroyError = err instanceof Error ? err.message : String(err);
      console.error(`[terminateSandbox] destroy() failed: ${destroyError}`);
    }

    if (monitorPromise) {
      // Either settlement — fulfilled OR rejected — means the container
      // process is gone. A SIGKILL from `destroy()` above is not a clean
      // exit, so a rejection here is the EXPECTED path, not a new failure;
      // this is why both branches resolve rather than propagating the
      // rejection. Raced against a bounded backstop so a promise that never
      // settles cannot hang termination forever.
      await Promise.race([
        monitorPromise.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_MONITOR_BACKSTOP_MS)),
      ]);
    }

    // Final ground-truth check: absorbs only the last sliver of lag between
    // the monitor promise settling and `.running` itself flipping false (or
    // covers the case where there was nothing to monitor at all, e.g.
    // `wasRunning` was already false).
    let runningAfter = this.containerIsRunning();
    const deadline = Date.now() + TERMINATE_CONFIRM_TIMEOUT_MS;
    while (runningAfter && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, TERMINATE_CONFIRM_INTERVAL_MS));
      runningAfter = this.containerIsRunning();
    }

    const report = buildTerminateReport({ wasRunning, runningAfter, destroyError });
    bootLog('terminate', 'end', {
      status: report.ok ? 'ok' : 'error',
      detail: `outcome=${report.outcome},wasRunning=${wasRunning},runningAfter=${runningAfter}`,
    });
    return report;
  }

  /**
   * The `POST /sandbox/:name/restart` implementation, run inside the DO.
   *
   * "Someone closed the browser — there is no way to restart the system from
   * settings." This restarts the desktop stack INSIDE the already-running
   * container: it does NOT call `destroy()`/`terminateSandbox()` (the
   * container, and the workspace on its disk, are never touched), it does NOT
   * re-mount or re-hydrate the workspace bucket (the files are already on the
   * container's own filesystem from the original boot — restart only needs to
   * tell the fresh launcher where they live), and it re-derives every other
   * input (TURN/ICE credentials, the neko auto-connect password, the
   * workspace root path) the SAME way a fresh `/sandbox/preview` call does,
   * from `sandboxId` + env alone, so no caller-held secret needs to survive
   * between the original preview call and this one.
   *
   * NEKO MODE ONLY. `start-neko.sh` is the ONLY launcher with a `terminate_stack`
   * teardown trap wired to SIGTERM — Guacamole's `start-desktop.sh` has none
   * (see that script's own doc comment: it just blocks on `wait
   * "$TOMCAT_PID"`), so a SIGTERM there would kill the launcher shell and
   * leave Xvfb/guacd/Tomcat/Chrome running as unreachable orphans — the exact
   * bug `terminate_stack` exists to prevent, for the one mode that has no such
   * trap. Rather than write a second, weaker teardown for that mode, this
   * route refuses it outright (`unsupported_mode`, mapped to HTTP 400 by the
   * caller) until Guacamole gets the same discipline.
   *
   * Sequence, each step OBSERVED rather than assumed (mirrors
   * `terminateSandbox`'s own "describe what actually happened" discipline):
   *   1. Detect the live launcher (`listProcesses()` + `findDesktopLauncherProcess`,
   *      matching on the exact command `ensureDesktop` launches) and the
   *      current/target mode (`describeDesktopStatus`, the SAME helper
   *      `handleStatus` uses).
   *   2. If one is running: SIGTERM it via `killProcess()` — this is the
   *      SAME signal `terminate_stack`'s own trap (`start-neko.sh`) is wired
   *      to, so the ENTIRE teardown (graceful stop of every app's process
   *      group, escalation to SIGKILL, reaping) runs exactly as it does for a
   *      container-runtime-issued SIGTERM. Nothing here reimplements any part
   *      of that. Then poll for confirmed exit, bounded by
   *      `RESTART_STOP_DEADLINE_MS`.
   *   3. If it did not confirm stopped in time: FAIL LOUD (`stop_timed_out`)
   *      and stop — never relaunch on top of a maybe-still-alive stack.
   *   4. Unexpose whatever ports were exposed from the OLD run, so
   *      `ensureDesktop`'s own "already exposed" fast path (which trusts the
   *      DO's exposed-port record, not a live probe) cannot skip the relaunch.
   *   5. Relaunch via `ensureDesktop` — the EXACT SAME boot path
   *      `/sandbox/preview` uses. No second boot sequence.
   *
   * Idempotent: calling this on an already-stopped desktop just (re)starts it
   * (`outcome: 'started'`); calling it twice in a row restarts it twice, each
   * time through the same safe sequence. Safe to press twice AT ONCE: a
   * concurrent call while one is in flight is a fast no-op
   * (`restart_in_progress`), never a race (`restartInProgress` guard above).
   */
  async restartDesktopStack(
    hostname: string,
    sandboxId: string,
    explicitMode: DesktopMode | undefined,
    fallbackMode: DesktopMode,
  ): Promise<RestartReport & { url?: string; appPreviewUrl?: string | null; codePreviewUrl?: string | null }> {
    if (this.restartInProgress) {
      return {
        ok: false,
        mode: explicitMode ?? fallbackMode,
        outcome: 'restart_in_progress',
        wasRunning: false,
        stopConfirmed: false,
        bootOk: false,
        error: 'restart_already_in_progress',
      };
    }
    this.restartInProgress = true;
    try {
      const exposedBefore = await this.getExposedPorts(hostname);
      const status = describeDesktopStatus(exposedBefore, explicitMode, fallbackMode);
      const mode = status.mode;

      if (mode !== 'neko') {
        bootLog('restart', 'end', { status: 'skipped', detail: `unsupported_mode=${mode}` });
        return {
          ok: false,
          mode,
          outcome: 'unsupported_mode',
          wasRunning: status.desktopRunning,
          stopConfirmed: false,
          bootOk: false,
          error: `restart_not_supported_for_mode:${mode}`,
        };
      }

      bootLog('restart', 'start', { detail: `mode=${mode}` });

      // 1) find + 2) stop the running launcher — reusing terminate_stack's
      //    OWN SIGTERM->grace->escalate contract, never a second teardown.
      const processesRaw = await this.listProcesses();
      const processes: readonly ProcessLike[] = Array.isArray(processesRaw) ? (processesRaw as ProcessLike[]) : [];
      const launcher = findDesktopLauncherProcess(processes);
      const wasRunning = Boolean(launcher);
      let stopConfirmed = !wasRunning;

      if (launcher) {
        try {
          await this.killProcess(launcher.id, 'SIGTERM');
        } catch (err) {
          console.error(
            `[restartDesktopStack] killProcess(${launcher.id}) failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        const deadline = Date.now() + RESTART_STOP_DEADLINE_MS;
        while (Date.now() < deadline) {
          let current: { status: string } | null = null;
          try {
            current = await this.getProcess(launcher.id);
          } catch {
            current = null; // treat "cannot find it anymore" as "it is gone"
          }
          if (!current || (current.status !== 'running' && current.status !== 'starting')) {
            stopConfirmed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, RESTART_STOP_POLL_INTERVAL_MS));
        }
      }

      if (!stopConfirmed) {
        bootLog('restart', 'end', { status: 'error', detail: 'stop_timed_out' });
        return buildRestartReport({ mode, wasRunning, stopConfirmed: false, bootOk: false });
      }

      // 3) Unexpose every port left over from the OLD run so `ensureDesktop`'s
      //    "already exposed" fast path cannot short-circuit the relaunch.
      const exposedNow = await this.getExposedPorts(hostname);
      for (const p of exposedNow) {
        try {
          await this.unexposePort(p.port);
        } catch (err) {
          console.error(
            `[restartDesktopStack] unexposePort(${p.port}) failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      // 4) Relaunch via the EXACT SAME boot path `/sandbox/preview` uses.
      // TURN/ICE + the neko auto-connect password are re-derived exactly the
      // way `handlePreview` derives them — deterministic from `sandboxId` +
      // env, no caller-held secret needed. The workspace root is likewise
      // re-derived from env alone (`resolveWorkspaceMountConfig`): the files
      // are already on the container's own disk from the original boot, so
      // this never re-mounts or re-hydrates anything.
      let iceEnv: Record<string, string> | null = null;
      const ice = checkIceConfig(this.env);
      if (!ice.ok) {
        bootLog('restart', 'end', { status: 'error', detail: 'ice_unavailable' });
        return buildRestartReport({ mode, wasRunning, stopConfirmed: true, bootOk: false, bootError: ice.error });
      }
      if (hasTurnConfigured(this.env)) {
        try {
          iceEnv = await resolveNekoIceEnv(this.env);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          if (ice.policy === 'relay' || ice.policy === 'production') {
            bootLog('restart', 'end', { status: 'error', detail: 'turn_unavailable' });
            return buildRestartReport({
              mode,
              wasRunning,
              stopConfirmed: true,
              bootOk: false,
              bootError: `turn_unavailable: ${detail}`,
            });
          }
          iceEnv = null; // diagnostic policy: proceed without relay
        }
      }
      const nekoCreds = await deriveNekoCredentials(this.env, sandboxId);
      iceEnv = {
        ...(iceEnv ?? {}),
        NEKO_MEMBER_MULTIUSER_USER_PASSWORD: nekoCreds.user,
        NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: nekoCreds.admin,
        NEKO_PASSWORD: nekoCreds.user,
        NEKO_PASSWORD_ADMIN: nekoCreds.admin,
      };
      const workspaceRoot = resolveWorkspaceMountConfig(this.env)?.mountPath ?? null;

      try {
        const { url, appPreviewExpose, codePreviewExpose } = await ensureDesktop(
          this,
          hostname,
          mode,
          iceEnv,
          // No sealed workspace-startup delivery on restart — the workspace
          // already lives on the container's disk from the original boot, and
          // `start-neko.sh`'s hydration phase reports `skipped` (not an
          // error) when this is absent. See that script's own doc comment.
          null,
          workspaceRoot,
          this.env.EZIL_NEKO_CPU_DIAG_ENABLED,
        );
        bootLog('restart', 'end', { status: 'ok' });
        const report = buildRestartReport({ mode, wasRunning, stopConfirmed: true, bootOk: true });
        return {
          ...report,
          url,
          appPreviewUrl: appPreviewExpose.exposed ? (appPreviewExpose.url ?? null) : null,
          codePreviewUrl: codePreviewExpose.exposed ? (codePreviewExpose.url ?? null) : null,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        bootLog('restart', 'end', { status: 'error', detail: 'boot_failed' });
        return buildRestartReport({ mode, wasRunning, stopConfirmed: true, bootOk: false, bootError: detail });
      }
    } finally {
      this.restartInProgress = false;
    }
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
 * History: this was briefly `'ezil.work'` (the company's main production
 * website), routed there by mistake and unwound (routes + DNS records
 * removed from Cloudflare). It was then set to the RFC 2606 placeholder
 * `'unset.invalid'` while zero zones were verified safe — `ezil.org` looked
 * off-limits because `*.ezil.org/*` is bound to the live production Worker
 * `cf-guacamole-sandbox` (serves `sandbox.ezil.org` / `neko.ezil.org`), and
 * `zlsocial.ai` turned out to have its own live bare wildcard tunnel
 * catch-all.
 *
 * 2026-07-31, later same day — restored to `'ezil.org'`. The owner approved
 * adding narrow, token-scoped suffix routes on `ezil.org` alongside the
 * existing `*.ezil.org/*` production route, on the basis that Cloudflare
 * Workers routes match most-specific-first: `*-app.ezil.org/*`,
 * `*-desktop.ezil.org/*`, and `*-nekodesktop.ezil.org/*` only win for hosts
 * that literally end in one of those three suffixes, so `sandbox.ezil.org`
 * and `neko.ezil.org` (which don't) keep resolving to `cf-guacamole-sandbox`
 * exactly as before. Verified live, one route at a time, with a byte-level
 * before/after diff of `sandbox.ezil.org`/`neko.ezil.org` after each addition
 * (unchanged throughout) before the next route was added — see the
 * `wrangler.toml` route block below for the three patterns and the rollout
 * rationale.
 */
const PREVIEW_ZONE_ROOT = 'ezil.org';

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
  /**
   * The X screen the container should BOOT at, as `{width, height}` integers
   * the app has already snapped to the closed mode table.
   *
   * 🔴 TYPED `unknown` ON PURPOSE. This is untrusted JSON off the wire, and it
   * ends up next to `Xvfb -screen 0 "$NEKO_SCREEN"`. Nothing reads these two
   * fields directly — `parseRequestedScreen` (`./screen-modes.ts`) is the only
   * reader, it accepts only plain integers, and `formatNekoScreen` REBUILDS
   * the env value from integers it re-checked against the table itself. There
   * is no path from a string here to a command line.
   *
   * Absent (an older app deploy, or a caller that asked for nothing) means the
   * container boots at `start-neko.sh`'s own `${NEKO_SCREEN:-1920x1080x24}`
   * default — i.e. exactly today's behaviour.
   */
  screen?: { width?: unknown; height?: unknown };
}

async function handlePreview(
  request: Request,
  env: Env,
  url: URL,
  ctx?: ExecutionContext,
): Promise<Response> {
  // Correlate every stage of this preview request under one id. Prefer an
  // inbound request id header so the browser/web-API and Worker timelines
  // stitch together; otherwise mint a fresh one.
  const correlationId =
    request.headers.get('x-request-id')?.trim() ||
    request.headers.get('x-correlation-id')?.trim() ||
    newCorrelationId();

  // Every `LogEvent` this request's `LifecycleTimeline` builds is ALSO
  // accumulated here (additive — `createCollectingSink`, `./observability.ts`)
  // so it can be spooled to the telemetry R2 bucket once the response is
  // decided, alongside whatever the container itself emitted during THIS
  // boot (`containerTelemetryRaw`, filled in by `ensureDesktop`'s
  // `onBootTelemetry` callback below). See `spoolTelemetry()`.
  const collectedLogs: LogEvent[] = [];
  let containerTelemetryRaw = '';
  let bootSandboxId: string | undefined;

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
    sink: createCollectingSink(collectedLogs),
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
  bootSandboxId = sandboxId;

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

    // ── Boot-time screen sizing ─────────────────────────────────────────────
    // The desktop was hard-pinned to 1920x1080 and the shell letterboxed it to
    // 16:9 whatever shape the window was — a 390x844 phone got a 390x219 strip.
    // `start-neko.sh:138` has ALWAYS been `${NEKO_SCREEN:-1920x1080x24}`;
    // nothing ever set it. This is the one line that does.
    //
    // 🔴 Injected ONLY when the caller asked for a valid mode. An absent,
    // malformed, or out-of-table `screen` leaves `iceEnv` byte-for-byte as it
    // was, so the container boots at the script's own default and an older app
    // deploy is unaffected. That is the backward-compatibility guarantee, and
    // it is structural: there is no `?? DEFAULT` anywhere on this path.
    //
    // 🔴 The value is REBUILT by `formatNekoScreen` from two integers it
    // re-checked against the closed table — never interpolated from anything
    // the caller sent. See `./screen-modes.ts`'s header for why that matters
    // on a path that ends at an X server command line.
    const requestedScreen = parseRequestedScreen(body.screen);
    const nekoScreen = requestedScreen
      ? formatNekoScreen(requestedScreen.width, requestedScreen.height)
      : null;
    if (nekoScreen) {
      iceEnv.NEKO_SCREEN = nekoScreen;
      tl.event('sandbox_identity', 'sandbox.preview.screen', 'ok', { detail: `screen=${nekoScreen}` });
    } else if (body.screen !== undefined) {
      // Asked for, refused. Loud in the timeline rather than silently 1920x1080:
      // a client that thinks it got a portrait desktop and did not is exactly
      // the state `fit_stream` cannot detect on its own.
      tl.event('sandbox_identity', 'sandbox.preview.screen', 'error', { error: 'screen_not_a_mode' });
    }
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
    const { url: exposedUrl, appPreviewExpose, codePreviewExpose } = await ensureDesktop(
      sandbox,
      normalizeSandboxHostname(url.host),
      mode,
      iceEnv,
      mode === 'neko' ? (body.startupDelivery ?? null) : null,
      workspace.mounted ? workspace.mountPath ?? null : null,
      env.EZIL_NEKO_CPU_DIAG_ENABLED,
      (raw) => {
        containerTelemetryRaw = raw;
      },
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
    if (codePreviewExpose.attempted && !codePreviewExpose.exposed) {
      tl.event('preview_lifecycle', 'sandbox.preview.code_preview_expose_failed', 'error', {
        error: codePreviewExpose.error,
      });
    }

    // A ready-to-embed URL the caller can hand STRAIGHT to a window/iframe:
    // `<https://<port>-<id>-<token>.<host>>/preview-bootstrap?token=<bootstrap>`.
    // Without this, the caller ("the second worker"'s tRPC layer — see
    // `hmac.ts`'s module doc) had to separately mint its own bootstrap token
    // and re-derive the exact same hostname composition this Worker already
    // computed inside `exposePreviewPort`; now it can skip both steps and
    // just navigate to the URL. Best-effort/non-fatal, matching every other
    // "surface, never throw" convention in this handler: a mint failure here
    // must never fail the whole `/sandbox/preview` response, since the
    // desktop preview itself is already ready. `appPreviewUrl`/`codePreviewUrl`
    // are `null` (never omitted) when the corresponding port wasn't exposed,
    // so the caller can tell "not available" from "field doesn't exist yet".
    //
    // 🔴 CALLER CONTRACT — these URLs are SHORT-LIVED. The embedded `token` is
    // a `/preview-bootstrap` token, valid for `PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`
    // (5 minutes, `./hmac.ts`) from the moment THIS response is produced. It is
    // single-purpose, not a session: navigating to it exchanges it for the
    // hour-long `ezil_preview` cookie. So a caller must NAVIGATE to the URL
    // promptly — stashing it in client state and opening the window on a later
    // user click will 401 at the bootstrap with `preview_bootstrap_token_expired`
    // and render an empty window with no visible cause. A caller that needs a
    // window opened later must re-request `/sandbox/preview` (idempotent — the
    // already-exposed fast path makes it cheap) rather than reuse a stale URL.
    const bootstrapSecret = resolvePreviewSecrets(env)[0] ?? 'local-dev';
    const buildBridgeUrl = async (
      exposed: AppPreviewExposeResult,
      extraParams?: Record<string, string>,
    ): Promise<string | null> => {
      if (!exposed.exposed || !exposed.url) return null;
      try {
        const bootstrapToken = await mintPreviewBootstrapToken(bootstrapSecret, sandboxId);
        const bridgeUrl = new URL(exposed.url);
        bridgeUrl.pathname = '/preview-bootstrap';
        bridgeUrl.search = '';
        bridgeUrl.searchParams.set('token', bootstrapToken);
        if (extraParams) {
          for (const [key, value] of Object.entries(extraParams)) {
            bridgeUrl.searchParams.set(key, value);
          }
        }
        return bridgeUrl.toString();
      } catch (err) {
        console.error(
          `[handlePreview] bridge URL mint failed (sandboxId=${sandboxId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return null;
      }
    };
    const appPreviewUrl = await buildBridgeUrl(appPreviewExpose);
    // See `codePreviewFolderParams`'s doc comment above for the full "empty
    // file tree" mechanism/contract this closes.
    const codePreviewUrl = await buildBridgeUrl(codePreviewExpose, codePreviewFolderParams(workspace));

    // EXPLICIT flush before handing the ready preview URL back to the caller
    // (in addition to the alarm-driven periodic flush — see
    // `EzilSandboxDO.flushWorkspaceNow`'s doc comment). Closes the gap so the
    // worst-case staleness is bounded to "the alarm-driven 10s cadence", not
    // "however long until the next preview call happens to run
    // ensureWorkspaceMount again". Best-effort and non-blocking-of-failure: a
    // flush error here must never fail the preview response — logged loudly
    // instead (never a bare `catch {}`).
    //
    // 🔴 PERF (z2-mint-latency): measured live against an ALREADY-RUNNING
    // container, this RPC alone cost 441-754ms (median ~580ms across 6 warm
    // production mints, `wrangler tail` on `ezil-os-worker`) — 15-27% of the
    // Worker's own wall time on the warm path, paid synchronously before the
    // response, even though the response (a streaming-desktop URL) has no
    // dependency on R2 durability. The flush writes local container files TO
    // R2; it reads nothing the caller's response needs. So it is handed to
    // `ctx.waitUntil()` — the EXACT same "run to completion, don't make the
    // response wait for it" contract `spoolTelemetry()` below already uses —
    // instead of being awaited inline. This does NOT weaken the staleness
    // bound described above: `waitUntil()` guarantees the flush still runs to
    // completion on the same cadence as before, it just no longer blocks the
    // bytes the browser is waiting on. Unlike `spoolTelemetry` (which is
    // allowed to be silently dropped when `ctx` is absent), a dropped
    // workspace flush is a real durability loss, so the ORIGINAL inline
    // `await` is kept as the fallback for any caller that has no
    // `ExecutionContext` (test harnesses calling the handler with 2 args) —
    // see `route-auth.test.ts`'s "pre-handoff flush deferral" suite for both
    // branches, mutation-tested.
    const flushOutcome = sandbox.flushWorkspaceNow().catch((err) => {
      console.error(
        `[handlePreview] pre-handoff flushWorkspaceNow failed (sandboxId=${sandboxId}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(flushOutcome);
    } else {
      await flushOutcome;
    }

    const response = json({
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
      codePreviewExpose,
      appPreviewUrl,
      codePreviewUrl,
    });
    // Spool AFTER the response is built, never awaited by it — see
    // `spoolTelemetry`'s own doc comment for the "no telemetry code path is
    // ever awaited by a code path that produces user-visible output"
    // guarantee (design doc §4.6).
    spoolTelemetry(env, ctx, correlationId, bootSandboxId, collectedLogs, containerTelemetryRaw);
    return response;
  } catch (err) {
    tl.event('preview_lifecycle', 'sandbox.preview.failed', 'error', { error: err });
    spoolTelemetry(env, ctx, correlationId, bootSandboxId, collectedLogs, containerTelemetryRaw);
    return json(
      { ok: false, error: err instanceof Error ? err.message : String(err), mode },
      500,
    );
  }
}

/**
 * Spool this request's telemetry-worthy events — the Worker's own
 * `LifecycleTimeline` events (filtered by `selectTelemetryWorthy`) AND
 * whatever the container itself emitted during this boot (parsed by
 * `parseContainerTelemetryLines`) — to the R2 telemetry spool, as ONE NDJSON
 * object keyed by this request's correlation id (design doc §4.1/§4.2).
 *
 * Absent `env.TELEMETRY_R2_BUCKET` (unconfigured deployment) or an empty
 * batch are both silent no-ops — telemetry must never become a hard
 * dependency, and never trip an error path of its own. The PUT is scheduled
 * via `ctx.waitUntil()` when available (real Workers runtime), so it can
 * keep running after the response is already on the wire; a missing `ctx`
 * (e.g. a test harness that calls `fetch(request, env)` with only two
 * arguments) still fires the PUT, just without that extension guarantee —
 * consistent with every other "best-effort, never blocks the response"
 * convention in this handler. NEVER awaited by the caller.
 */
function spoolTelemetry(
  env: Env,
  ctx: ExecutionContext | undefined,
  correlationId: string,
  sandboxId: string | undefined,
  workerLogs: readonly LogEvent[],
  containerTelemetryRaw: string,
): void {
  const bucket = env.TELEMETRY_R2_BUCKET;
  if (!bucket) return;

  const workerEvents = selectTelemetryWorthy(workerLogs).map((e) => toTelemetryEventInput(e));
  const containerEvents = parseContainerTelemetryLines(containerTelemetryRaw, { correlationId, sandboxId });
  const events = [...workerEvents, ...containerEvents];
  if (events.length === 0) return;

  const key = buildTelemetryR2Key(new Date(), correlationId);
  const body = serializeTelemetryBatch(events);
  const put = bucket
    .put(key, body, { httpMetadata: { contentType: 'application/x-ndjson' } })
    .catch((err: unknown) => {
      // A failed telemetry PUT is a no-op, never a 500 (design §4.1/§4.6) —
      // still logged loudly so a persistently-broken spool is observable.
      console.error(`[spoolTelemetry] R2 put failed (key=${key}): ${err instanceof Error ? err.message : String(err)}`);
    });

  if (ctx?.waitUntil) {
    ctx.waitUntil(put);
  }
}

/**
 * `GET /sandbox/:name/status` — the cheap, non-waking readiness probe the boot
 * UI polls.
 *
 * DEFECT FIXED HERE (live: a neko desktop that was actively streaming video
 * reported `{"guacamoleRunning":false,"mode":"guacamole"}`): the mode used to
 * be resolved from `?desktopMode=` / `SANDBOX_DEFAULT_DESKTOP_MODE` ALONE.
 * The app's `getGuacamoleSandboxStatus()` sends no `desktopMode`, and
 * `SANDBOX_DEFAULT_DESKTOP_MODE` is unset in `wrangler.toml`, so the mode was
 * always `guacamole` and the port compared was always 8080 — a neko sandbox
 * (8181) could never match. `guacamoleRunning` was therefore permanently
 * `false`, and since it is the ONLY signal `computeBootUiState` promotes a
 * phase to `confirmed` on, no checkmark could ever appear.
 *
 * The fix is to read the mode off the live exposed-port list, which was
 * already being fetched and is ground truth (`getCurrentPreviewPorts()`
 * returns `[]` unless the container is healthy AND running, and touches only
 * DO storage — so this route still never wakes a container).
 *
 * WIRE CONTRACT: `ok`, `sandboxName`, `guacamoleRunning` and `mode` keep their
 * names and their meanings (`guacamoleRunning` has always meant "the desktop
 * port for the reported `mode` is exposed" — see `describeDesktopStatus`).
 * `desktopRunning`, `runningModes` and `modeSource` are additive.
 */
async function handleStatus(env: Env, url: URL, sandboxName: string, requestedMode?: string): Promise<Response> {
  const modeResult = resolveDesktopMode(requestedMode, env.SANDBOX_DEFAULT_DESKTOP_MODE);
  if (!modeResult.ok) {
    return json({ ok: false, error: modeResult.error }, 400);
  }
  // An EXPLICIT `?desktopMode=` still answers the caller's literal question
  // ("is <mode> up?"); only an omitted one is now detected from live state.
  const explicitMode = requestedMode?.trim() ? modeResult.mode : undefined;
  try {
    const sandbox = openSandbox(env, sandboxName);
    const exposed = await sandbox.getExposedPorts(normalizeSandboxHostname(url.host));
    const status = describeDesktopStatus(exposed, explicitMode, modeResult.mode);
    return json({
      ok: true,
      sandboxName,
      guacamoleRunning: status.guacamoleRunning,
      mode: status.mode,
      desktopRunning: status.desktopRunning,
      runningModes: status.runningModes,
      modeSource: status.modeSource,
    });
  } catch (err) {
    return json(
      {
        ok: false,
        sandboxName,
        error: err instanceof Error ? err.message : String(err),
        mode: modeResult.mode,
      },
      500,
    );
  }
}

/**
 * `POST /sandbox/:name/restart` — restart the desktop stack inside a LIVE
 * container, without destroying the computer or its workspace. See
 * `EzilSandboxDO.restartDesktopStack` for the full contract (SIGTERM reusing
 * `terminate_stack`, neko-mode-only, idempotent, fail-loud on a stuck stop).
 *
 * Mode resolution mirrors `handleStatus` exactly: an explicit
 * `?desktopMode=` answers the caller's literal request; an omitted one lets
 * the DO auto-detect whatever is actually running (or falls back to the env
 * default when nothing is).
 */
async function handleRestart(env: Env, url: URL, sandboxName: string, requestedMode?: string): Promise<Response> {
  const modeResult = resolveDesktopMode(requestedMode, env.SANDBOX_DEFAULT_DESKTOP_MODE);
  if (!modeResult.ok) {
    return json({ ok: false, error: modeResult.error }, 400);
  }
  const explicitMode = requestedMode?.trim() ? modeResult.mode : undefined;
  try {
    const sandbox = openSandbox(env, sandboxName);
    const report = await sandbox.restartDesktopStack(
      normalizeSandboxHostname(url.host),
      sandboxName,
      explicitMode,
      modeResult.mode,
    );
    const status = report.ok ? 200 : report.outcome === 'unsupported_mode' ? 400 : 500;
    return json({ sandboxName, ...report }, status);
  } catch (err) {
    return json(
      { ok: false, sandboxName, error: err instanceof Error ? err.message : String(err) },
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

// ── Window-focus control ─────────────────────────────────────────────────────
//
// POST /sandbox/:name/focus  { token, app: 'vscode' | 'chromium' }
//   Switches which app is foregrounded inside the `neko` desktop-mode
//   container. Gated with the SAME shared-HMAC envelope as the body-less
//   control routes (`DELETE /sandbox/:name`) — see
//   `authorizeSignedControlRequest`'s doc comment for the three places the
//   token may be presented. `app` is a CLOSED ENUM (`validateFocusApp`,
//   `./sandbox-control.ts`) — never a free string — so it can be
//   interpolated into the in-container `neko-switch-app.sh` invocation with
//   no shell-injection surface.
//
// Response: { ok, sandboxId, app } on success; { ok: false, error } otherwise.
async function handleFocus(request: Request, env: Env, sandboxName: string): Promise<Response> {
  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json_body' }, 400);
  }

  const rawApp =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).app
      : undefined;
  const validated = validateFocusApp(rawApp);
  if (!validated.ok) {
    return json({ ok: false, error: validated.error }, 400);
  }
  const { app } = validated;

  try {
    const sandbox = openSandbox(env, sandboxName);
    const result = await sandbox.exec(buildFocusAppCommand(app));
    if (result.exitCode !== 0) {
      return json(
        {
          ok: false,
          sandboxId: sandboxName,
          app,
          error: `focus_switch_failed: exit=${result.exitCode} stderr=${result.stderr?.trim().slice(-300)}`,
        },
        500,
      );
    }
    return json({ ok: true, sandboxId: sandboxName, app });
  } catch (err) {
    return json(
      { ok: false, sandboxId: sandboxName, app, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

// ── Live screen resize ───────────────────────────────────────────────────────
//
// POST /sandbox/:name/screen  { token, width, height }
//   Changes the X screen mode of a LIVE container, so a desktop opened on a
//   phone can become portrait without a reboot. Gated with the SAME
//   shared-HMAC envelope as `/focus` and `DELETE /sandbox/:name`.
//
// 🔴 WHY THIS RUNS IN THE WORKER AND NOT IN THE APP. Neko's admin API is
// reachable two ways: over the public preview hostname (which the app already
// uses for `/api/login` + `/api/room/settings`), or over the container's own
// loopback via `containerFetch`. This route takes the second, because the app
// does not hold the desktop ORIGIN outside the boot request that minted it —
// and the contract's request body (`{computerId, width, height}`) deliberately
// carries no frame URL for it to be handed. The credential is NOT a new one:
// `deriveNekoCredentials(env, sandboxId).admin` is the exact value the app's
// `deriveNekoAdminValue` mirrors, and this Worker is where that derivation
// already lives.
//
// 🔴 WHY IT CAN LEGITIMATELY FAIL, AND MUST SAY SO. The X screen can only grow
// INSIDE the framebuffer the server started with. MEASURED against a real
// container: one pixel over the bound (`1920x1921` against a 1920x1920
// framebuffer) answers `HTTP 422 {"code":422,"message":"cannot set screen
// size"}` and leaves the display untouched. That is `screen_unsupported` — and
// against a container whose framebuffer is smaller than the mode table (an
// older image, or one where the ceiling was never raised) it is a PERMANENT
// property, not a transient error, so the client letterboxes and stops asking
// rather than retrying something that cannot start working.
//
// Every one of the twelve contract modes has been driven through this endpoint
// against a real container and confirmed four ways (`GET /api/room/screen`,
// `xdpyinfo`, `wmctrl`, and a screenshot at exactly that size), so the happy
// path is measured rather than hoped for.
//
// Response: { ok: true, sandboxId, width, height, verified, requested }
//         | { ok: false, error }.
// `error` is the closed vocabulary the app maps to its own five codes
// (`classifyScreenFailure`, app-side): `screen_bad_request`,
// `screen_unsupported`, `screen_upstream_<status>`, `screen_timeout`,
// `screen_login_failed`.

/** Whole budget for one live resize: login + set. */
const SCREEN_SET_BUDGET_MS = 12_000;

/** Neko's own refresh rate field. The modelines are all 60Hz. */
const SCREEN_RATE_HZ = 60;

/**
 * `GET /api/room/screen` — what the X display ACTUALLY is, right now.
 *
 * Returns null for anything that is not a well-formed answer: a non-2xx, a
 * body that is not JSON, or one whose `width`/`height` are not plain integers.
 * The rule is "either we understood the answer or we did not have one", the
 * same rule `probeDesktopDisplay` (app side) applies to `/api/sessions` — a
 * lenient parse here would let a renamed field turn into a confidently wrong
 * size on the wire.
 *
 * 🔴 NOT `/api/room/screen/configurations`. That endpoint returns exactly ONE
 * entry — the framebuffer BOUND, with `rate: 0` — and is a ceiling, not an
 * enumeration of selectable modes. Any size fitting inside it on both axes is
 * settable, so a mode's absence from that list means nothing at all.
 */
async function readNekoScreen(
  sandbox: Sandbox<unknown>,
  origin: string,
  port: number,
  token: string,
  signal: AbortSignal,
): Promise<{ width: number; height: number } | null> {
  try {
    const res = await sandbox.containerFetch(
      `${origin}/api/room/screen`,
      { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }, signal },
      port,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { width?: unknown; height?: unknown };
    if (!Number.isInteger(body.width) || !Number.isInteger(body.height)) return null;
    const width = body.width as number;
    const height = body.height as number;
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

async function handleScreen(request: Request, env: Env, sandboxName: string): Promise<Response> {
  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json_body' }, 400);
  }

  // The ONLY reader of the caller's numbers. Plain integers or nothing — see
  // `./screen-modes.ts`. `formatNekoScreen` is then the membership check: a
  // pair that is not one of the advertised modelines can never be set, so
  // rejecting it here saves a round trip and keeps the wire honest.
  const requested = parseRequestedScreen(body);
  if (!requested || formatNekoScreen(requested.width, requested.height) === null) {
    return json({ ok: false, error: 'screen_bad_request' }, 400);
  }
  const { width, height } = requested;

  const deadline = AbortSignal.timeout(SCREEN_SET_BUDGET_MS);
  const nekoPort = portFor('neko').port;
  const origin = `http://127.0.0.1:${nekoPort}`;

  try {
    const sandbox = openSandbox(env, sandboxName);
    const creds = await deriveNekoCredentials(env, sandboxName);

    // 🔴 No token cache here, deliberately. The app's `nekoAdminTokens` cache
    // exists because the display gate asks the same question every second on a
    // boot's critical path; a resize is a rare, human-paced action (debounced
    // 500ms client-side, deduplicated against the last applied size), so one
    // extra loopback round trip per resize is not worth a second cache that
    // could hand a restarted container a dead token.
    const loginRes = await sandbox.containerFetch(
      `${origin}/api/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'ezil-os-screen', password: creds.admin }),
        signal: deadline,
      },
      nekoPort,
    );
    if (!loginRes.ok) {
      return json({ ok: false, sandboxId: sandboxName, error: `screen_login_failed_${loginRes.status}` }, 502);
    }
    const login = (await loginRes.json()) as { token?: unknown };
    if (typeof login.token !== 'string' || login.token === '') {
      return json({ ok: false, sandboxId: sandboxName, error: 'screen_login_failed_no_token' }, 502);
    }

    // 🔴 NOT a read-modify-write, and that is a difference from
    // `/api/room/settings` rather than an oversight. `/api/room/screen` takes a
    // screen configuration and nothing else — there are no sibling fields for a
    // POST to silently reset, which is the failure `enableImplicitHosting`'s own
    // doc comment records for the settings endpoint.
    const setRes = await sandbox.containerFetch(
      `${origin}/api/room/screen`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` },
        // Built from the two integers validated above, never from the body.
        body: JSON.stringify({ width, height, rate: SCREEN_RATE_HZ }),
        signal: deadline,
      },
      nekoPort,
    );

    if (setRes.ok) {
      // 🔴 READ BACK. THE POST'S OWN BODY IS NOT EVIDENCE.
      //
      // Measured against a real container: `POST /api/room/screen` with
      // `900x1600` answers HTTP 200 and echoes `{"width":900,"height":1600}`
      // while the X display is actually 896x1600 (Xvfb floors the width to a
      // multiple of 8). The POST echoes the REQUEST, not the RESULT. Reporting
      // it as applied would put a size on the wire that never existed, and the
      // client would letterbox to an aspect the stream does not have — the
      // exact class of bug this whole change exists to remove.
      //
      // `GET /api/room/screen` is the observation. When it answers, its numbers
      // are what this route reports. When it does not, the route says so with
      // `verified: false` rather than falling back to the POST's echo and
      // calling it applied; the app then declines to claim `requested`.
      const applied = await readNekoScreen(sandbox, origin, nekoPort, login.token, deadline);
      return json({
        ok: true,
        sandboxId: sandboxName,
        // The observed screen when there is one, the requested one otherwise —
        // and `verified` is the flag that tells them apart. Never merged into
        // one indistinguishable number.
        width: applied ? applied.width : width,
        height: applied ? applied.height : height,
        verified: applied !== null,
        /** What was actually sent to neko, so a divergence is visible in logs. */
        requested: { width, height },
      });
    }

    const detail = (await setRes.text().catch(() => '')).slice(0, 300);
    // 422 is neko's MEASURED answer for a size the X server cannot reach —
    // `{"code":422,"message":"cannot set screen size"}`, observed for one pixel
    // over the framebuffer bound, with the display left unchanged. 400 is
    // included because a malformed body reaches the same dead end from this
    // caller's point of view, and both mean "asking again will not help".
    // Reported as UNSUPPORTED so the client stops asking rather than retrying
    // a thing that cannot start working.
    const unsupported = setRes.status === 400 || setRes.status === 422;
    return json(
      {
        ok: false,
        sandboxId: sandboxName,
        error: unsupported ? `screen_unsupported_${setRes.status}` : `screen_upstream_${setRes.status}`,
        detail,
      },
      502,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return json(
      {
        ok: false,
        sandboxId: sandboxName,
        error: timedOut ? 'screen_timeout' : `screen_upstream_exception`,
        detail: message.slice(0, 300),
      },
      timedOut ? 504 : 502,
    );
  }
}

/**
 * Non-secret production kill-switch for `POST /sandbox/:id/activity`. Same
 * vocabulary (and same per-surface duplication) as `focusDisabled`/
 * `restartDisabled` (`./sandbox-control.ts`), `diagDisabled`
 * (`./workspace-diag.ts`), `twenDisabled` (`./twen.ts`) —
 * `off`/`false`/`0`/`disabled`/`no` hard-disables the route (returns 404)
 * without a code change.
 */
function activityDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

// ── Activity heartbeat ───────────────────────────────────────────────────────
//
// POST /sandbox/:name/activity  { lastInputAgoMs: number }
//   Records a genuine user-presence signal in DO storage
//   (`EzilSandboxDO.recordActivity` -> `LAST_ACTIVITY_AT_KEY`) so
//   `flushWorkspaceScheduled`'s idle-stop path can tell "a tab is merely open"
//   apart from "a human is actually here". Gated with the SAME shared-HMAC
//   envelope as every other control route — see
//   `authorizeSignedControlRequest`'s doc comment for the three places the
//   token may be presented.
//
// Deliberately the ONLY thing this route does: it never touches the
// container (no `exec`, no `containerFetch`) — see
// `EzilSandboxDO.recordActivity`'s doc comment for why an endpoint whose
// whole purpose is helping decide when to SLEEP a container must be
// structurally incapable of itself waking one.
//
// Response: { ok, sandboxId } on success; { ok: false, error } otherwise.
async function handleActivity(request: Request, env: Env, sandboxName: string): Promise<Response> {
  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json_body' }, 400);
  }

  const validated = validateActivityBody(body);
  if (!validated.ok) {
    return json({ ok: false, error: validated.error }, 400);
  }

  try {
    const sandbox = openSandbox(env, sandboxName);
    await sandbox.recordActivity(validated.lastInputAgoMs);
    return json({ ok: true, sandboxId: sandboxName });
  } catch (err) {
    return json(
      { ok: false, sandboxId: sandboxName, error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

// ── Telemetry R2-spool drain ─────────────────────────────────────────────────
//
// POST /telemetry/drain  { token, cursor?, limit? }
//   Lists and reads back a page of the R2 spool `spoolTelemetry()` (above)
//   has been writing to all along — see this module's own `KNOWN GAP` note
//   in `./telemetry.ts`. Gated with the SAME shared-HMAC envelope as
//   `/focus`/`/restart`/`DELETE /sandbox/:name` (`authorizeSignedControlRequest`).
//   Cursor-paged, capped at `TELEMETRY_DRAIN_MAX_OBJECTS` (200) objects per
//   call. Read-only: nothing is deleted here. The caller (the app's cron —
//   `app/src/server/telemetry/spool-drain.ts`) is expected to ingest every
//   object's NDJSON lines into Postgres BEFORE calling `/telemetry/ack` —
//   idempotent on `eventId`, so a crash between the two, or an ack that never
//   arrives, costs nothing: the same objects are simply re-drained (and
//   re-ingested as a no-op) next run.
//
// Response: { ok, objects: [{key, body}], cursor?, truncated } on success.
async function handleTelemetryDrain(request: Request, env: Env): Promise<Response> {
  const bucket = env.TELEMETRY_R2_BUCKET;
  if (!bucket) return json({ ok: false, error: 'telemetry_bucket_not_configured' }, 500);

  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json_body' }, 400);
  }

  const { cursor, limit } = parseTelemetryDrainBody(body);
  const pageLimit = clampDrainLimit(limit);

  try {
    const page = await bucket.list({ prefix: TELEMETRY_SPOOL_PREFIX, cursor, limit: pageLimit });
    const objects: { key: string; body: string }[] = [];
    for (const object of page.objects) {
      const got = await bucket.get(object.key);
      if (!got) continue; // deleted between list() and get() — skip, not fatal
      objects.push({ key: object.key, body: await got.text() });
    }
    return json({
      ok: true,
      objects,
      cursor: page.truncated ? page.cursor : undefined,
      truncated: page.truncated,
    });
  } catch (err) {
    return json(
      { ok: false, error: `telemetry_drain_failed: ${err instanceof Error ? err.message : String(err)}` },
      500,
    );
  }
}

// POST /telemetry/ack  { token, keys: string[] }
//   Deletes the given spool objects — called ONLY after the caller has
//   durably ingested them (see `handleTelemetryDrain`'s doc comment for the
//   ordering guarantee that makes a lost/duplicated ack harmless). `keys` is
//   revalidated here via `parseTelemetryAckKeys`, NOT trusted from the drain
//   response alone — a caller (even one holding a valid HMAC token) can never
//   delete an R2 object outside the `v1/` spool prefix through this route.
//
// Response: { ok, deleted } on success.
async function handleTelemetryAck(request: Request, env: Env): Promise<Response> {
  const bucket = env.TELEMETRY_R2_BUCKET;
  if (!bucket) return json({ ok: false, error: 'telemetry_bucket_not_configured' }, 500);

  let body: unknown = {};
  try {
    const raw = await request.text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json_body' }, 400);
  }

  const keys = parseTelemetryAckKeys(body);
  if (keys.length === 0) return json({ ok: true, deleted: 0 });

  try {
    await bucket.delete(keys);
    return json({ ok: true, deleted: keys.length });
  } catch (err) {
    return json(
      { ok: false, error: `telemetry_ack_failed: ${err instanceof Error ? err.message : String(err)}` },
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

/**
 * Everything on the code-server bridge host except `/preview-bootstrap`.
 *
 * 🔴 Why this is a CATCH-ALL and the app-preview host is not.
 *
 * code-server is launched by the container's `start-codeserver.sh` with
 * `--bind-addr 0.0.0.0:8443 --auth none` and NO proxy base-path flag, so it
 * believes it is mounted at `/`. It emits root-absolute asset URLs
 * (`/_static/...`, `/stable-<commit>/...`, `/manifest.json`, …) and opens its
 * extension-host / integrated-terminal WebSockets against that same root.
 * Under the app-preview dispatcher's contract — where anything outside
 * `/preview*` is a deliberate 404 — every one of those requests would 404 and
 * the editor would render as a blank page with no error anywhere in the
 * response body. That is the exact "correct in isolation, broken in
 * composition" failure this project keeps shipping, so the code host takes the
 * opposite default: EVERY path is proxied to code-server.
 *
 * That widening does NOT widen the auth surface. `handlePreviewProxy` /
 * `handlePreviewWsProxy` gate every single request through
 * `resolvePreviewAuth` (HMAC'd `ezil_preview` cookie, or the `ezil_pv`
 * query-param fallback, both bound to this `sandboxId`), and this host never
 * falls through to `proxyToSandbox`'s raw unauthenticated forward — see the
 * call site in `fetch()`. Given code-server runs `--auth none`, that gate is
 * the ONLY thing standing between the public internet and a root shell in the
 * container, which is why the catch-all routes through the gated proxies
 * rather than around them.
 *
 * A leading `/preview` is stripped when present so BOTH entry shapes work: the
 * bootstrap redirect lands on `/preview/` (shared with the app host), and
 * code-server's own root-absolute follow-up requests arrive bare.
 *
 * WebSocket upgrades are detected by header and sent to
 * `handlePreviewWsProxy`, not by the `/preview-ws/` path prefix the app host
 * uses — code-server never rewrites its socket URLs through that prefix (and
 * must not: `RUNTIME_SHIM`, which is what performs that rewrite for Next/Vite
 * HMR, is deliberately never injected for `target === 'code'`).
 */
async function handleCodeBridge(
  request: Request,
  env: Env,
  url: URL,
  sandboxId: string,
  secrets: string[],
  port: number,
): Promise<Response> {
  const path = url.pathname;
  let codePath = path;
  if (codePath === '/preview') codePath = '/';
  else if (codePath.startsWith('/preview/')) codePath = codePath.slice('/preview'.length);

  const sandbox = openSandbox(env, sandboxId);
  const upgrade = (request.headers.get('upgrade') ?? '').toLowerCase();
  if (upgrade === 'websocket') {
    // `'code'` is load-bearing, not cosmetic: it selects the REAL bridge
    // hostname as `x-forwarded-host`, which is the only value code-server's
    // WS-router origin check can ever accept (see `resolveForwardedHost`).
    return handlePreviewWsProxy(request, sandbox, sandboxId, secrets, codePath, port, 'code');
  }
  return handlePreviewProxy(request, sandbox, sandboxId, secrets, codePath, port, 'code');
}

/**
 * Dispatcher for BOTH bridge hostnames: the app-preview host
 * (`<APP_PREVIEW_PORT>-<id>-app.<zone>`, the user's own dev server) and the
 * code-server host (`<CODE_PREVIEW_PORT>-<id>-code.<zone>`, VS Code Web).
 * `parseBridgeHost` tells us which; `port` is resolved once here and threaded
 * through to every handler that needs to reach the right container port.
 *
 * `/preview-status` and `/preview-inspector.js` are APP-ONLY: the dev-server
 * phase-file probing and the element-inspector postMessage bridge both only
 * make sense against the user's own app, never against code-server. A
 * `target === 'code'` request to either is proxied to code-server like any
 * other path on that host (see `handleCodeBridge`), never handled here.
 *
 * (Renamed from `handleAppPreview` — was app-preview-only before this
 * generalization; `parseAppPreviewHost` → `parseBridgeHost` in
 * `./preview-bridge.ts` is the corresponding rename there.)
 */
async function handleBridgeHost(request: Request, env: Env, url: URL): Promise<Response | null> {
  const route = parseBridgeHost(url.hostname);
  if (!route) return null;
  const { sandboxId, target } = route;
  const path = url.pathname;
  const secrets = resolvePreviewSecrets(env);
  const port = target === 'app' ? APP_PREVIEW_PORT : CODE_PREVIEW_PORT;

  if (request.method === 'GET' && path === '/preview-bootstrap') {
    const cookieSecret = resolveNekoDerivationSecret(env) ?? undefined;
    return handlePreviewBootstrap(url, sandboxId, secrets, cookieSecret, target);
  }

  if (target === 'code') return handleCodeBridge(request, env, url, sandboxId, secrets, port);

  if (target === 'app' && request.method === 'GET' && path === '/preview-status') {
    // Was the ONE unauthenticated route on this hostname (its module doc still
    // described it as such, inherited from the Azure daemon it was ported
    // from) — but it has since become MUTATING: `probeAppPreviewStatus` calls
    // `shouldTriggerDevserverRestart()` and, when that fires, executes
    // `buildDevserverRestartCommand()` in the container, restarting the user's
    // dev server. It also `exec`s unconditionally, and a container RPC
    // AUTO-STARTS a stopped container — so an anonymous GET could restart a
    // dev server and cold-boot (bill) a container.
    //
    // Gated with the SAME credentials its four sibling routes on this exact
    // hostname already use — no new scheme: the `ezil_preview` cookie minted
    // by `/preview-bootstrap` (the browser that renders the preview always has
    // it: `Path=/`, `SameSite=None`, `Secure`), or, for a server-side poller,
    // the same sandboxId-bound `?token=` bootstrap token `/preview-bootstrap`
    // itself verifies. Local dev (no secret configured) is unaffected: both
    // verifiers short-circuit to "allowed" exactly as before.
    const cookie = readCookie(request.headers.get('cookie'), PREVIEW_COOKIE_NAME);
    const cookieOk = await verifyPreviewCookie(cookie, secrets, sandboxId);
    if (!cookieOk) {
      const tokenAuth = await verifyPreviewBootstrapToken(
        url.searchParams.get('token') ?? undefined,
        secrets,
        sandboxId,
      );
      if (!tokenAuth.ok) {
        return json({ ok: false, error: tokenAuth.error }, 401);
      }
    }
    try {
      const sandbox = openSandbox(env, sandboxId);
      const status = await probeAppPreviewStatus(sandbox, env);
      return json(status);
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  if (target === 'app' && request.method === 'GET' && path === '/preview-inspector.js') {
    return handlePreviewInspectorJs(request, sandboxId, secrets);
  }

  if (path === '/preview-ws' || path.startsWith('/preview-ws/')) {
    const sandbox = openSandbox(env, sandboxId);
    const appPath = path === '/preview-ws' ? '/' : path.slice('/preview-ws'.length);
    return handlePreviewWsProxy(request, sandbox, sandboxId, secrets, appPath, port, target);
  }

  if (path === '/preview' || path.startsWith('/preview/')) {
    const sandbox = openSandbox(env, sandboxId);
    const appPath = path === '/preview' ? '/' : path.slice('/preview'.length);
    return handlePreviewProxy(request, sandbox, sandboxId, secrets, appPath, port, target);
  }

  // Anything else on either bridge hostname is outside the Option D
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

/**
 * Verify the SAME shared HMAC envelope on a control request that carries no
 * JSON body of its own (`DELETE /sandbox/:name`).
 *
 * This is deliberately NOT a new scheme: the token is the exact
 * `t=<unix_ms>,v1=<hex>` envelope minted for `POST /sandbox/preview` and
 * verified by `verifyPreviewToken` / `resolvePreviewSecrets` — identical to
 * `authorizeProjectFilesRequest` above and to `/sandbox/:id/{workspace-diag,
 * cpu-diag,twen}`. Only the transport differs: a body-less method has nowhere
 * to put a JSON field, so `Authorization: Bearer <token>` (preferred — keeps
 * the token out of URLs and request logs) and `?token=<token>` (the existing
 * `/preview-bootstrap` precedent) are accepted too, in that order. A JSON body
 * with `{"token":…}` still works if a caller sends one.
 *
 * Local-dev behavior is inherited unchanged from `verifyPreviewToken`: with no
 * secret configured, verification is skipped.
 *
 * Returns a 401 `Response` on failure, `null` on success.
 */
async function authorizeSignedControlRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  let body: unknown;
  // A body is optional here; a malformed one is simply not a token source.
  // Never let body parsing decide the auth outcome — `extractSignedToken`
  // falls through to the header/query sources.
  try {
    const raw = await request.clone().text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    body = undefined;
  }

  const token = extractSignedToken({
    authorization: request.headers.get('authorization'),
    query: url.searchParams.get('token'),
    body,
  });

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

/**
 * `DELETE /sandbox/:name` — HMAC-gated (see the route wiring in `fetch()`) and
 * HONEST.
 *
 * What this replaces: the previous implementation flushed, called
 * `sandbox.destroy()`, and returned `{ terminated: true }` UNCONDITIONALLY —
 * with no authorization at all, and with no check that anything had in fact
 * been running. Because `getSandbox()` happily materializes a brand-new,
 * never-started Durable Object for ANY name, a DELETE aimed at a wrong name
 * (live incident: `<sandboxId>-nekodesktop`, the preview-hostname label, in
 * place of `<sandboxId>`) destroyed an empty DO and still answered
 * `ok:true, terminated:true` while the real container kept running.
 *
 * Now the DO itself observes `ctx.container.running` before and after and
 * reports what actually happened (`terminated` / `stopped` / `outcome`); a
 * container still alive after `destroy()` is a 500, not a success.
 * `mode: 'production'` is retained verbatim for wire compatibility.
 */
async function handleTerminate(env: Env, sandboxName: string): Promise<Response> {
  try {
    const sandbox = openSandbox(env, sandboxName);
    const report = await sandbox.terminateSandbox();
    return json(
      {
        ok: report.ok,
        sandboxName,
        terminated: report.terminated,
        stopped: report.stopped,
        outcome: report.outcome,
        wasRunning: report.wasRunning,
        runningAfter: report.runningAfter,
        mode: 'production',
        ...(report.error ? { error: report.error } : {}),
      },
      report.ok ? 200 : 500,
    );
  } catch (err) {
    return json(
      {
        ok: false,
        sandboxName,
        terminated: false,
        stopped: false,
        outcome: 'destroy_failed',
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

// ── Entrypoint ────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    // 0) Option D bridge hostnames — app-preview (`<APP_PREVIEW_PORT>-<id>-app.<zone>`)
    //    AND code-server (`<CODE_PREVIEW_PORT>-<id>-code.<zone>`): handled
    //    ENTIRELY by our own token/cookie-gated dispatcher, BEFORE
    //    `proxyToSandbox` gets a chance to raw-forward it. Both hostnames are
    //    also registered via `exposePort()` (see `ensureDesktop`) so
    //    `getExposedPorts()` reports them and the URL scheme matches every
    //    other exposed port — but that registration is ONLY for
    //    discoverability; traffic to it must never bypass the cookie/token
    //    auth below by falling through to the SDK's raw pass-through. Returns
    //    `null` (not a Response) for hostnames outside both bridge patterns,
    //    in which case the request continues to the normal `proxyToSandbox`
    //    path below unchanged.
    const bridgeResponse = await handleBridgeHost(request, env, new URL(request.url));
    if (bridgeResponse) return bridgeResponse;

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
      // `service` is an external contract carried forward unchanged from the
      // legacy script name — unknown consumers may match on it, so it stays
      // `cf-guacamole-sandbox` even though this Worker's own name is
      // `ezil-os-worker`. That means the OLD (still-live, separately
      // deployed) `cf-guacamole-sandbox` script and this NEW Worker return an
      // otherwise byte-identical body, which made route-precedence
      // verification during the 2026-07-31 ezil.org preview-route rollout
      // impossible (can't tell which Worker answered a given request). `build`
      // is the added, additive distinguishing marker: only THIS Worker sets
      // it, so its presence/absence is what verification greps for.
      return json({
        ok: true,
        service: 'cf-guacamole-sandbox',
        mode: 'production',
        supportedDesktopModes: DESKTOP_MODES,
        build: 'ezil-os',
      });
    }

    if (method === 'POST' && path === '/sandbox/preview') {
      return handlePreview(request, env, url, ctx);
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

    const focusMatch = path.match(/^\/sandbox\/([^/]+)\/focus$/);
    if (method === 'POST' && focusMatch) {
      // Window-focus control. HMAC-gated (SAME envelope as `DELETE
      // /sandbox/:name`), closed-enum body (`validateFocusApp` — never a free
      // string). Operators can hard-disable it WITHOUT a code change via
      // `SANDBOX_FOCUS=off`.
      if (focusDisabled(env.SANDBOX_FOCUS)) {
        return json({ ok: false, error: 'focus_disabled' }, 404);
      }
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleFocus(request, env, decodeURIComponent(focusMatch[1]));
    }

    const screenMatch = path.match(/^\/sandbox\/([^/]+)\/screen$/);
    if (method === 'POST' && screenMatch) {
      // Live X screen resize. HMAC-gated (SAME envelope as `/focus`), and its
      // body is two integers checked against the closed mode table before
      // anything is sent to the container — never a free string.
      //
      // 🔴 NO KILL SWITCH ENV VAR, unlike its siblings, and that is deliberate
      // rather than an omission: the fix contract fixes the environment-variable
      // set and this route is not in it. The route degrades on its own — under
      // an X server that cannot change mode it answers `screen_unsupported`
      // and the client falls back to letterboxing permanently, which is the
      // same end state a kill switch would produce. If an operator switch is
      // wanted later, `SANDBOX_SCREEN` alongside `SANDBOX_FOCUS` is the shape.
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleScreen(request, env, decodeURIComponent(screenMatch[1]));
    }

    const activityMatch = path.match(/^\/sandbox\/([^/]+)\/activity$/);
    if (method === 'POST' && activityMatch) {
      // Activity heartbeat — the ONE signal `flushWorkspaceScheduled`'s
      // idle-stop path has that a human is present beyond what preview/
      // hydrate/explicit-flush already prove. HMAC-gated (SAME envelope as
      // `/focus`/`/restart`/`DELETE /sandbox/:name`). Operators can
      // hard-disable it WITHOUT a code change via `SANDBOX_ACTIVITY=off`.
      if (activityDisabled(env.SANDBOX_ACTIVITY)) {
        return json({ ok: false, error: 'activity_disabled' }, 404);
      }
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleActivity(request, env, decodeURIComponent(activityMatch[1]));
    }

    if (method === 'POST' && path === '/telemetry/drain') {
      // R2-spool drain. HMAC-gated (SAME envelope as `DELETE
      // /sandbox/:name`/`/focus`). Operators can hard-disable it WITHOUT a
      // code change via `SANDBOX_TELEMETRY_DRAIN=off`.
      if (telemetryDrainDisabled(env.SANDBOX_TELEMETRY_DRAIN)) {
        return json({ ok: false, error: 'telemetry_drain_disabled' }, 404);
      }
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleTelemetryDrain(request, env);
    }

    if (method === 'POST' && path === '/telemetry/ack') {
      // Same envelope and kill switch as `/telemetry/drain` — see that
      // route's doc comment for why the two share one flag.
      if (telemetryDrainDisabled(env.SANDBOX_TELEMETRY_DRAIN)) {
        return json({ ok: false, error: 'telemetry_drain_disabled' }, 404);
      }
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleTelemetryAck(request, env);
    }

    const restartMatch = path.match(/^\/sandbox\/([^/]+)\/restart$/);
    if (method === 'POST' && restartMatch) {
      // Restart the desktop stack inside a LIVE container ("someone closed
      // the browser — there is no way to restart the system"). HMAC-gated
      // (SAME envelope as `DELETE /sandbox/:name` and `/focus`). Operators
      // can hard-disable it WITHOUT a code change via `SANDBOX_RESTART=off`.
      if (restartDisabled(env.SANDBOX_RESTART)) {
        return json({ ok: false, error: 'restart_disabled' }, 404);
      }
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleRestart(
        env,
        url,
        decodeURIComponent(restartMatch[1]),
        url.searchParams.get('desktopMode') ?? undefined,
      );
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
      // HMAC-gated with the SAME envelope every other mutating route on this
      // Worker uses (`verifyPreviewToken` / `resolvePreviewSecrets`).
      //
      // This route used to have NO authorization check whatsoever while every
      // `/project-files/*` route called `authorizeProjectFilesRequest` —
      // verified live: an unauthenticated DELETE returned `ok:true`. The
      // sandbox name is plainly visible in the desktop iframe's `src`, so
      // anyone who saw a URL could destroy that session. See
      // `authorizeSignedControlRequest` for where the token may be presented.
      const unauthorized = await authorizeSignedControlRequest(request, env, url);
      if (unauthorized) return unauthorized;
      return handleTerminate(env, decodeURIComponent(deleteMatch[1]));
    }

    return json({ ok: false, error: `not_found: ${method} ${path}` }, 404);
  },
};
