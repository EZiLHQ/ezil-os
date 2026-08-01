/**
 * Pure helpers for the sandbox CONTROL surface — signed-request token
 * extraction, honest terminate reporting, and truthful desktop-status
 * derivation.
 *
 * Deliberately isolated from `./index.ts` (which imports `@cloudflare/sandbox`,
 * itself importing `cloudflare:workers`, a module only resolvable inside the
 * Workers runtime) so all of this can be unit-tested with plain `bun test` —
 * mirroring `./desktop-mode`, `./hmac`, `./preview-bridge` and
 * `./workspace-diag`.
 *
 * Nothing here mints or verifies signatures itself: verification stays in
 * `./hmac` (`verifyPreviewToken`), which is the SAME envelope
 * `/sandbox/preview`, `/sandbox/:id/workspace-diag`, `/sandbox/:id/cpu-diag`,
 * `/sandbox/:id/twen` and all five `/project-files/*` routes already use. This
 * module only decides WHERE a token is read from and HOW an outcome is
 * described.
 */

import { DESKTOP_MODES, portFor, type DesktopMode } from './desktop-mode';

// ── Signed-request token extraction ─────────────────────────────────────────

/**
 * The three places a caller may present the shared HMAC preview token on a
 * control request, in precedence order:
 *
 *   1. `Authorization: Bearer <token>` — the only option for a body-less
 *      `DELETE`, and the one that keeps the token out of URLs (and therefore
 *      out of Cloudflare's request logs / `Referer` headers). PREFERRED.
 *   2. `?token=<token>` — the existing precedent on this Worker
 *      (`GET /preview-bootstrap?token=…`, see `handlePreviewBootstrap`).
 *   3. a JSON body `{ "token": "…" }` — byte-identical to the envelope every
 *      POST route on this Worker already accepts.
 *
 * No new signing scheme is introduced: whatever this returns is handed to
 * `verifyPreviewToken()` unchanged.
 */
export interface SignedTokenSources {
  /** Raw `Authorization` header value, if any. */
  authorization?: string | null;
  /** Raw `?token=` query parameter value, if any. */
  query?: string | null;
  /** Already-parsed JSON request body, if any. */
  body?: unknown;
}

// ── Window-focus control (`POST /sandbox/:id/focus`) ────────────────────────
//
// Switches which app is foregrounded inside the `neko` desktop-mode container
// (`/usr/local/bin/neko-switch-app.sh <app>`). The ONLY caller-supplied input
// is `app`, and it is validated against a closed enum here — NEVER accepted as
// a free string — so it can be interpolated into the in-container command with
// no shell-injection surface, mirroring the same "strict allowlist, never
// arbitrary input" contract `./twen.ts` documents for its own `op`/
// `operationId` fields.

/** The only two apps `neko-switch-app.sh` knows how to foreground. */
export const FOCUS_APPS = ['vscode', 'chromium'] as const;
export type FocusApp = (typeof FOCUS_APPS)[number];

/**
 * Validate the caller-supplied `app` field of `POST /sandbox/:id/focus`.
 * Rejects anything outside the closed enum explicitly (never silently
 * coerced/defaulted) — a typo or an attempted injection is a 400, not a
 * guess.
 */
export function validateFocusApp(raw: unknown): { ok: true; app: FocusApp } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: `focus_app_missing_or_not_a_string: expected one of ${FOCUS_APPS.join(', ')}` };
  }
  const trimmed = raw.trim();
  if ((FOCUS_APPS as readonly string[]).includes(trimmed)) {
    return { ok: true, app: trimmed as FocusApp };
  }
  return { ok: false, error: `invalid_focus_app: '${trimmed}' (expected one of: ${FOCUS_APPS.join(', ')})` };
}

/**
 * Build the exact in-container command for `POST /sandbox/:id/focus`. Safe to
 * interpolate `app` directly — `validateFocusApp` guarantees it is EXACTLY
 * `'vscode'` or `'chromium'` (a closed, hardcoded enum), never caller-shaped
 * free text.
 */
export function buildFocusAppCommand(app: FocusApp): string {
  return `/usr/local/bin/neko-switch-app.sh ${app}`;
}

/**
 * Non-secret production kill-switch for `POST /sandbox/:id/focus`. Enabled by
 * default (HMAC-gated via `authorizeSignedControlRequest`, closed-enum body,
 * no arbitrary shell input); set to `off`/`false`/`0`/`disabled`/`no` to
 * hard-disable the route (returns 404) without a code change — same
 * vocabulary as `./workspace-diag`'s `diagDisabled` and `./twen`'s
 * `twenDisabled`.
 */
export function focusDisabled(flag: string | undefined): boolean {
  if (!flag) return false;
  return ['off', 'false', '0', 'disabled', 'no'].includes(flag.trim().toLowerCase());
}

/** Read the shared HMAC token from a control request. Returns `undefined` when absent everywhere. */
export function extractSignedToken(sources: SignedTokenSources): string | undefined {
  const authorization = sources.authorization?.trim();
  if (authorization) {
    // Scheme match is case-insensitive per RFC 7235; the token itself is not.
    const bearer = /^bearer\s+(.+)$/i.exec(authorization);
    if (bearer) {
      const value = bearer[1].trim();
      if (value) return value;
    }
  }

  const query = sources.query?.trim();
  if (query) return query;

  const body = sources.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const raw = (body as Record<string, unknown>).token;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }

  return undefined;
}

// ── Honest terminate reporting ──────────────────────────────────────────────

/**
 * What actually happened to the container during a `DELETE /sandbox/:name`.
 *
 *   `destroyed`      — a container WAS running under this name and is not now.
 *                      The action happened.
 *   `not_running`    — nothing was running under this name. Idempotent success
 *                      with respect to the postcondition, but NOTHING WAS
 *                      DESTROYED, and `terminated` is `false` so the caller can
 *                      tell. This is what a mistyped/misderived sandbox name
 *                      now reports instead of a bogus `terminated: true`.
 *   `still_running`  — `destroy()` returned but the container is STILL up. An
 *                      error (HTTP 500): reporting success here would be the
 *                      exact defect this replaces.
 *   `destroy_failed` — `destroy()` threw.
 */
export type TerminateOutcome = 'destroyed' | 'not_running' | 'still_running' | 'destroy_failed';

export interface TerminateObservation {
  /** `ctx.container.running` observed BEFORE any teardown work. */
  wasRunning: boolean;
  /** `ctx.container.running` observed AFTER `destroy()` settled (post-poll). */
  runningAfter: boolean;
  /** Message from a throwing `destroy()`, if it threw. */
  destroyError?: string;
}

export interface TerminateReport {
  /** The request was handled AND the postcondition holds. Maps to HTTP 200 vs 500. */
  ok: boolean;
  /**
   * A running container was destroyed BY THIS CALL. Never `true` for a name
   * that had nothing running — that is the whole point of this field.
   */
  terminated: boolean;
  /** Postcondition: no container is running under this name now. */
  stopped: boolean;
  outcome: TerminateOutcome;
  wasRunning: boolean;
  runningAfter: boolean;
  error?: string;
}

/**
 * Describe a terminate attempt from what was actually OBSERVED, never from
 * what was requested. The single rule: `terminated` is true if and only if a
 * container was observed running before and observed not running after.
 */
export function buildTerminateReport(observation: TerminateObservation): TerminateReport {
  const { wasRunning, runningAfter } = observation;
  const destroyError = observation.destroyError?.trim() || undefined;

  if (destroyError) {
    return {
      ok: false,
      terminated: false,
      stopped: !runningAfter,
      outcome: 'destroy_failed',
      wasRunning,
      runningAfter,
      error: destroyError,
    };
  }

  if (runningAfter) {
    return {
      ok: false,
      terminated: false,
      stopped: false,
      outcome: 'still_running',
      wasRunning,
      runningAfter,
      error: 'container_still_running_after_destroy',
    };
  }

  if (wasRunning) {
    return { ok: true, terminated: true, stopped: true, outcome: 'destroyed', wasRunning, runningAfter };
  }

  return { ok: true, terminated: false, stopped: true, outcome: 'not_running', wasRunning, runningAfter };
}

// ── Truthful desktop status ─────────────────────────────────────────────────

/** The only field of a `getExposedPorts()` entry this module needs. */
export interface ExposedPortLike {
  port: number;
}

/**
 * How `mode` in the `/status` response was arrived at.
 *
 *   `requested` — the caller passed an explicit `?desktopMode=`; the caller's
 *                 question is answered literally, exactly as before.
 *   `detected`  — no explicit request, and a desktop port IS currently exposed,
 *                 so the mode is read off the live port list (ground truth).
 *   `default`   — no explicit request and nothing running; falls back to the
 *                 env default (the pre-existing behavior, now only used when
 *                 there is genuinely nothing to observe).
 */
export type DesktopModeSource = 'requested' | 'detected' | 'default';

export interface DesktopStatus {
  mode: DesktopMode;
  modeSource: DesktopModeSource;
  /** Every supported mode whose in-container desktop port is currently exposed. */
  runningModes: DesktopMode[];
  /** True when ANY supported desktop is currently serving. */
  desktopRunning: boolean;
  /**
   * The desktop port for the REPORTED `mode` is currently exposed.
   *
   * NAME PRESERVED DELIBERATELY — unknown external consumers read it, and the
   * client's `computeBootUiState` uses it as the sole signal that promotes a
   * boot phase to `confirmed`. Its meaning is unchanged from the original
   * implementation (`exposed.some(p => p.port === portFor(mode).port)`); what
   * is fixed is that `mode` is now DETECTED rather than defaulted, so a neko
   * desktop that is genuinely streaming finally reports `true` instead of a
   * permanent `false`. Always read it together with `mode`.
   */
  guacamoleRunning: boolean;
}

/**
 * Derive the desktop status from the live exposed-port list.
 *
 * `getExposedPorts()` is ground truth AND cheap: `getCurrentPreviewPorts()` in
 * `@cloudflare/sandbox` reads only Durable Object storage plus
 * `ctx.container.running`, never issuing a container fetch, and returns `[]`
 * unless the container state is `healthy` and the container is actually
 * running. So a port appearing here means "that desktop is up right now".
 *
 * @param exposed          entries from `sandbox.getExposedPorts(hostname)`
 * @param requestedMode    the caller's EXPLICIT `?desktopMode=`, already validated; `undefined` when omitted
 * @param fallbackMode     resolved env/default mode, used only when nothing is running
 */
export function describeDesktopStatus(
  exposed: readonly ExposedPortLike[],
  requestedMode: DesktopMode | undefined,
  fallbackMode: DesktopMode,
): DesktopStatus {
  const runningModes = DESKTOP_MODES.filter((candidate) =>
    exposed.some((entry) => entry.port === portFor(candidate).port),
  );

  let mode: DesktopMode;
  let modeSource: DesktopModeSource;
  if (requestedMode) {
    mode = requestedMode;
    modeSource = 'requested';
  } else if (runningModes.length > 0) {
    // Prefer the configured default when it IS one of the running modes, so a
    // deployment that runs both never flips its reported mode arbitrarily.
    mode = runningModes.includes(fallbackMode) ? fallbackMode : runningModes[0];
    modeSource = 'detected';
  } else {
    mode = fallbackMode;
    modeSource = 'default';
  }

  return {
    mode,
    modeSource,
    runningModes: [...runningModes],
    desktopRunning: runningModes.length > 0,
    guacamoleRunning: runningModes.includes(mode),
  };
}
