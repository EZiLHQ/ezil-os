/**
 * Tests for the Option D app-preview reverse-proxy contract
 * (`./preview-bridge.ts` + the bootstrap-token/cookie additions in
 * `./hmac.ts`).
 *
 * Pure unit tests against exported helpers — no network/container/Docker
 * calls, no Workers runtime. Run with `bun test` (package-local).
 *
 * Coverage:
 *   - hostname parsing (`parseAppPreviewHost`) — including sandboxIds that
 *     themselves contain hyphens (this Worker's real ids always do:
 *     `guac-<user>-<project>`), and rejection of non-app ports/tokens.
 *   - bootstrap token: sandboxId-bound HMAC, cross-sandboxId replay rejection,
 *     freshness, malformed/missing, local-dev bypass.
 *   - preview cookie: mint/verify roundtrip, sandboxId binding, TTL,
 *     local-dev bypass.
 *   - response header rewriting: X-Frame-Options stripped, CSP
 *     frame-ancestors stripped (other directives kept), Set-Cookie rewritten.
 *   - HTML shim injection.
 *   - end-to-end `handlePreviewBootstrap` / `handlePreviewProxy` against a
 *     fake `ContainerFetcher`.
 */

import { describe, expect, it } from 'bun:test';

import {
  parseAppPreviewHost,
  rewriteResponseHeaders,
  rewriteSetCookie,
  stripFrameAncestors,
  injectRuntimeShim,
  readCookie,
  stripPreviewCookie,
  handlePreviewBootstrap,
  handlePreviewProxy,
  buildPreviewStatus,
  parseDevserverPhase,
  parseDevserverPhaseRecord,
  parseRestartAttempts,
  computeDevserverRestartBackoffS,
  shouldTriggerDevserverRestart,
  effectiveDevserverPhase,
  buildDevserverRestartCommand,
  buildPackageJsonCheckCommand,
  DEVSERVER_WORKSPACE_ROOT_FILE,
  DEVSERVER_RESTART_COOLDOWN_BASE_S,
  DEVSERVER_RESTART_MAX_BACKOFF_S,
  DEVSERVER_RESTART_ESCALATE_ATTEMPTS,
  type ContainerFetcher,
} from './preview-bridge';
import {
  mintPreviewBootstrapToken,
  verifyPreviewBootstrapToken,
  mintPreviewCookie,
  verifyPreviewCookie,
  PREVIEW_COOKIE_NAME,
} from './hmac';
import { APP_PREVIEW_PORT, APP_PREVIEW_TOKEN, appPortFor } from './desktop-mode';

// ── Hostname parsing ─────────────────────────────────────────────────────────

describe('parseAppPreviewHost', () => {
  it('parses the app-preview hostname, including a hyphenated sandboxId', () => {
    const sandboxId = 'guac-user1-proj1';
    const host = `${APP_PREVIEW_PORT}-${sandboxId}-${APP_PREVIEW_TOKEN}.ezil.org`;
    expect(parseAppPreviewHost(host)).toEqual({ sandboxId });
  });

  it('rejects a different port', () => {
    const host = `8181-guac-user1-proj1-app.ezil.org`;
    expect(parseAppPreviewHost(host)).toBeNull();
  });

  it('rejects a different token (e.g. the desktop token on the app port)', () => {
    const host = `${APP_PREVIEW_PORT}-guac-user1-proj1-nekodesktop.ezil.org`;
    expect(parseAppPreviewHost(host)).toBeNull();
  });

  it('rejects a hostname with no hyphen at all', () => {
    expect(parseAppPreviewHost('ezil.org')).toBeNull();
  });

  it('rejects an empty sandboxId', () => {
    const host = `${APP_PREVIEW_PORT}-${APP_PREVIEW_TOKEN}.ezil.org`;
    // firstHyphen splits "3002" from "app.ezil.org" (no sandboxId segment) —
    // rest="app", lastHyphen===-1 → null.
    expect(parseAppPreviewHost(host)).toBeNull();
  });

  it('handles a bare hostname with no dot (local dev without a domain)', () => {
    const sandboxId = 'guac-user1-proj1';
    const host = `${APP_PREVIEW_PORT}-${sandboxId}-${APP_PREVIEW_TOKEN}`;
    expect(parseAppPreviewHost(host)).toEqual({ sandboxId });
  });
});

describe('appPortFor', () => {
  it('resolves the app-preview port/token for neko mode', () => {
    expect(appPortFor('neko')).toEqual({ port: APP_PREVIEW_PORT, token: APP_PREVIEW_TOKEN });
  });

  it('resolves to null for guacamole mode (no app-preview surface)', () => {
    expect(appPortFor('guacamole')).toBeNull();
  });
});

// ── Bootstrap token ───────────────────────────────────────────────────────────

describe('preview-bootstrap token (sandboxId-bound HMAC)', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';
  const SID2 = 'guac-user2-proj1';

  it('mints a token accepted for the SAME sandboxId', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const result = await verifyPreviewBootstrapToken(token, [SECRET], SID);
    expect(result).toEqual({ ok: true });
  });

  it('REJECTS the same token replayed against a DIFFERENT sandboxId (cross-tenant bypass check)', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const result = await verifyPreviewBootstrapToken(token, [SECRET], SID2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('preview_bootstrap_token_signature_mismatch');
  });

  it('accepts a signature from the mission-alias secret (matches resolvePreviewSecrets pattern)', async () => {
    const token = await mintPreviewBootstrapToken('mission', SID);
    const result = await verifyPreviewBootstrapToken(token, [SECRET, 'mission'], SID);
    expect(result).toEqual({ ok: true });
  });

  it('rejects an expired token', async () => {
    const stale = Date.now() - 10 * 60 * 1000;
    const token = await mintPreviewBootstrapToken(SECRET, SID, stale);
    const result = await verifyPreviewBootstrapToken(token, [SECRET], SID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('preview_bootstrap_token_expired');
  });

  it('rejects a missing token when a secret is configured', async () => {
    const result = await verifyPreviewBootstrapToken(undefined, [SECRET], SID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('preview_bootstrap_token_missing');
  });

  it('rejects a malformed token', async () => {
    const result = await verifyPreviewBootstrapToken('not-a-token', [SECRET], SID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('preview_bootstrap_token_malformed');
  });

  it('local dev: accepts anything (including undefined) when no secret is configured', async () => {
    expect(await verifyPreviewBootstrapToken(undefined, [], SID)).toEqual({ ok: true });
    expect(await verifyPreviewBootstrapToken('garbage', [], SID)).toEqual({ ok: true });
  });

  it('never leaks the secret in the verification result', async () => {
    const token = await mintPreviewBootstrapToken('attacker-guess', SID);
    const result = await verifyPreviewBootstrapToken(token, [SECRET], SID);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

// ── Preview cookie ────────────────────────────────────────────────────────────

describe('ezil_preview cookie (mint/verify)', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';
  const SID2 = 'guac-user2-proj1';

  it('round-trips: a freshly minted cookie verifies for its own sandboxId', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    expect(await verifyPreviewCookie(cookie, [SECRET], SID)).toBe(true);
  });

  it('rejects the cookie against a different sandboxId', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    expect(await verifyPreviewCookie(cookie, [SECRET], SID2)).toBe(false);
  });

  it('rejects a tampered cookie (bit-flipped hmac)', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const tampered = cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0');
    expect(await verifyPreviewCookie(tampered, [SECRET], SID)).toBe(false);
  });

  it('rejects an expired cookie (older than the TTL)', async () => {
    const stale = Date.now() - 2 * 60 * 60 * 1000; // 2h, past the 1h TTL
    const cookie = await mintPreviewCookie(SECRET, SID, stale);
    expect(await verifyPreviewCookie(cookie, [SECRET], SID)).toBe(false);
  });

  it('rejects a missing/malformed cookie when a secret is configured', async () => {
    expect(await verifyPreviewCookie(undefined, [SECRET], SID)).toBe(false);
    expect(await verifyPreviewCookie('not-enough-parts', [SECRET], SID)).toBe(false);
  });

  it('local dev: mints an unsigned placeholder and accepts anything when no secret configured', async () => {
    const cookie = await mintPreviewCookie(undefined, SID);
    expect(cookie).toContain('.nohmac');
    expect(await verifyPreviewCookie(cookie, [], SID)).toBe(true);
    expect(await verifyPreviewCookie(undefined, [], SID)).toBe(true);
  });
});

// ── Response header rewriting ────────────────────────────────────────────────

describe('rewriteResponseHeaders', () => {
  it('strips X-Frame-Options entirely', () => {
    const upstream = new Headers({ 'X-Frame-Options': 'DENY', 'content-type': 'text/html' });
    const out = rewriteResponseHeaders(upstream);
    expect(out.has('x-frame-options')).toBe(false);
    expect(out.get('content-type')).toBe('text/html');
  });

  it('strips CSP frame-ancestors but keeps other directives', () => {
    const upstream = new Headers({
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
    });
    const out = rewriteResponseHeaders(upstream);
    const csp = out.get('content-security-policy');
    expect(csp).not.toBeNull();
    expect(csp).not.toContain('frame-ancestors');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
  });

  it('drops the CSP header entirely when frame-ancestors was the only directive', () => {
    const upstream = new Headers({ 'Content-Security-Policy': "frame-ancestors 'none'" });
    const out = rewriteResponseHeaders(upstream);
    expect(out.has('content-security-policy')).toBe(false);
  });

  it('drops hop-by-hop headers', () => {
    const upstream = new Headers({ Connection: 'keep-alive', 'Transfer-Encoding': 'chunked' });
    const out = rewriteResponseHeaders(upstream);
    expect(out.has('connection')).toBe(false);
    expect(out.has('transfer-encoding')).toBe(false);
  });

  it('rewrites Set-Cookie to Path=/preview, SameSite=None, Secure and drops Domain', () => {
    const upstream = new Headers();
    upstream.append('Set-Cookie', 'session=abc123; Domain=localhost; Path=/; HttpOnly');
    const out = rewriteResponseHeaders(upstream);
    const rewritten = out.get('set-cookie');
    expect(rewritten).toContain('session=abc123');
    expect(rewritten).toContain('Path=/preview');
    expect(rewritten).toContain('SameSite=None');
    expect(rewritten).toContain('Secure');
    expect(rewritten).not.toContain('Domain=');
    expect(rewritten).toContain('HttpOnly');
  });
});

describe('stripFrameAncestors', () => {
  it('returns null when nothing is left', () => {
    expect(stripFrameAncestors("frame-ancestors 'self'")).toBeNull();
  });
  it('preserves ordering of remaining directives', () => {
    expect(stripFrameAncestors("a 'x'; frame-ancestors 'y'; b 'z'")).toBe("a 'x'; b 'z'");
  });
});

describe('rewriteSetCookie', () => {
  it('adds missing attributes when the dev server sets a bare cookie', () => {
    const out = rewriteSetCookie('foo=bar');
    expect(out).toBe('foo=bar; Path=/preview; SameSite=None; Secure');
  });
});

// ── HTML shim injection ──────────────────────────────────────────────────────

describe('injectRuntimeShim', () => {
  it('injects right after the opening <head> tag', () => {
    const html = '<html><head><title>x</title></head><body></body></html>';
    const out = injectRuntimeShim(html);
    expect(out.indexOf('<head>')).toBeLessThan(out.indexOf('preview-inspector.js'));
    expect(out.indexOf('preview-inspector.js')).toBeLessThan(out.indexOf('<title>'));
  });

  it('is a no-op when there is no <head> tag', () => {
    const html = '<div>no head here</div>';
    expect(injectRuntimeShim(html)).toBe(html);
  });

  it('matches a <head> tag with attributes', () => {
    const html = '<head lang="en"><title>x</title></head>';
    const out = injectRuntimeShim(html);
    expect(out).toContain('preview-inspector.js');
  });
});

// ── Cookie header helpers ─────────────────────────────────────────────────────

describe('readCookie / stripPreviewCookie', () => {
  it('reads a named cookie out of a multi-cookie header', () => {
    const header = `foo=1; ${PREVIEW_COOKIE_NAME}=abc.123.def; bar=2`;
    expect(readCookie(header, PREVIEW_COOKIE_NAME)).toBe('abc.123.def');
  });

  it('returns undefined when the cookie is absent', () => {
    expect(readCookie('foo=1; bar=2', PREVIEW_COOKIE_NAME)).toBeUndefined();
    expect(readCookie(null, PREVIEW_COOKIE_NAME)).toBeUndefined();
  });

  it('strips only the ezil_preview cookie, keeping the rest for the upstream dev server', () => {
    const header = `foo=1; ${PREVIEW_COOKIE_NAME}=abc.123.def; bar=2`;
    const stripped = stripPreviewCookie(header);
    expect(stripped).not.toContain(PREVIEW_COOKIE_NAME);
    expect(stripped).toContain('foo=1');
    expect(stripped).toContain('bar=2');
  });

  it('returns undefined when stripping leaves nothing', () => {
    const header = `${PREVIEW_COOKIE_NAME}=abc.123.def`;
    expect(stripPreviewCookie(header)).toBeUndefined();
  });
});

// ── buildPreviewStatus ───────────────────────────────────────────────────────

describe('buildPreviewStatus', () => {
  it('reports ready when the port is up and package.json exists', () => {
    const status = buildPreviewStatus(true, true);
    expect(status.is_real_app).toBe(true);
    expect(status.error_reason).toBeNull();
  });

  it('reports no_package_json when package.json is missing, regardless of port', () => {
    expect(buildPreviewStatus(true, false).error_reason).toBe('no_package_json');
    expect(buildPreviewStatus(false, false).error_reason).toBe('no_package_json');
  });

  it('reports port_not_listening when package.json exists but the port is down', () => {
    expect(buildPreviewStatus(false, true).error_reason).toBe('port_not_listening');
  });

  it('defaults phase and hydration_complete to null when omitted (back-compat with 2-arg call sites)', () => {
    const status = buildPreviewStatus(true, true);
    expect(status.phase).toBeNull();
    expect(status.hydration_complete).toBeNull();
  });

  it('carries phase and hydration_complete through verbatim when provided', () => {
    const status = buildPreviewStatus(false, true, 'installing_deps', false);
    expect(status.phase).toBe('installing_deps');
    expect(status.hydration_complete).toBe(false);
    expect(status.error_reason).toBe('port_not_listening');
  });

  it('a crashed dev server still reports error_reason: port_not_listening (enum never widens) with phase carrying the distinction', () => {
    const status = buildPreviewStatus(false, true, 'crashed', true);
    expect(status.error_reason).toBe('port_not_listening');
    expect(status.phase).toBe('crashed');
  });

  it('a timed-out dev server is distinguishable from a crashed one only via phase, not error_reason', () => {
    const crashed = buildPreviewStatus(false, true, 'crashed', true);
    const timedOut = buildPreviewStatus(false, true, 'timeout', true);
    expect(crashed.error_reason).toBe(timedOut.error_reason);
    expect(crashed.phase).not.toBe(timedOut.phase);
  });

  it('is_real_app is false when the port is up and package.json exists but devserverMode is still "placeholder" (the placeholder-still-serving race)', () => {
    const status = buildPreviewStatus(true, true, 'running', true, 'placeholder');
    expect(status.is_real_app).toBe(false);
    expect(status.error_reason).toBe('port_not_listening');
  });

  it('is_real_app is true when devserverMode is "app" (the normal ready case)', () => {
    const status = buildPreviewStatus(true, true, 'running', true, 'app');
    expect(status.is_real_app).toBe(true);
    expect(status.error_reason).toBeNull();
  });

  it('devserverMode defaults to null (permissive — never produces a false negative on an older image or an early-boot race)', () => {
    const status = buildPreviewStatus(true, true);
    expect(status.is_real_app).toBe(true);
  });
});

// ── parseDevserverPhase ───────────────────────────────────────────────────────

describe('parseDevserverPhase', () => {
  it('extracts the phase word from the "<phase> <unix_ts>" format write_phase() writes', () => {
    expect(parseDevserverPhase('running 1690000000')).toBe('running');
    expect(parseDevserverPhase('installing_deps 1690000000\n')).toBe('installing_deps');
  });

  it('returns null for empty, missing, or whitespace-only content', () => {
    expect(parseDevserverPhase('')).toBeNull();
    expect(parseDevserverPhase(null)).toBeNull();
    expect(parseDevserverPhase(undefined)).toBeNull();
    expect(parseDevserverPhase('   \n')).toBeNull();
  });

  it('tolerates a bare phase word with no timestamp', () => {
    expect(parseDevserverPhase('crashed')).toBe('crashed');
  });
});

// ── parseDevserverPhaseRecord ─────────────────────────────────────────────────

describe('parseDevserverPhaseRecord', () => {
  it('extracts both phase and timestamp', () => {
    expect(parseDevserverPhaseRecord('crashed 1690000000')).toEqual({
      phase: 'crashed',
      timestampS: 1690000000,
    });
  });

  it('returns a null timestamp when the record has no second token', () => {
    expect(parseDevserverPhaseRecord('crashed')).toEqual({ phase: 'crashed', timestampS: null });
  });

  it('returns a null timestamp for a non-numeric second token instead of NaN', () => {
    expect(parseDevserverPhaseRecord('crashed not-a-number').timestampS).toBeNull();
  });

  it('returns nulls for empty/missing content', () => {
    expect(parseDevserverPhaseRecord('')).toEqual({ phase: null, timestampS: null });
    expect(parseDevserverPhaseRecord(null)).toEqual({ phase: null, timestampS: null });
    expect(parseDevserverPhaseRecord(undefined)).toEqual({ phase: null, timestampS: null });
  });
});

// ── parseRestartAttempts ───────────────────────────────────────────────────────

describe('parseRestartAttempts', () => {
  it('parses a plain integer', () => {
    expect(parseRestartAttempts('3')).toBe(3);
    expect(parseRestartAttempts('3\n')).toBe(3);
  });

  it('defaults to 0 for missing/empty/garbage content — never negative, never NaN', () => {
    expect(parseRestartAttempts('')).toBe(0);
    expect(parseRestartAttempts(null)).toBe(0);
    expect(parseRestartAttempts(undefined)).toBe(0);
    expect(parseRestartAttempts('not-a-number')).toBe(0);
    expect(parseRestartAttempts('-5')).toBe(0);
  });

  it('floors a fractional value defensively', () => {
    expect(parseRestartAttempts('2.9')).toBe(2);
  });
});

// ── computeDevserverRestartBackoffS ───────────────────────────────────────────

describe('computeDevserverRestartBackoffS', () => {
  it('uses the flat base cooldown for the first attempt (attempts=0), matching Azure\'s flat 5s cooldown', () => {
    expect(computeDevserverRestartBackoffS(0)).toBe(DEVSERVER_RESTART_COOLDOWN_BASE_S);
  });

  it('doubles for each subsequent consecutive failure', () => {
    expect(computeDevserverRestartBackoffS(1)).toBe(DEVSERVER_RESTART_COOLDOWN_BASE_S * 2);
    expect(computeDevserverRestartBackoffS(2)).toBe(DEVSERVER_RESTART_COOLDOWN_BASE_S * 4);
    expect(computeDevserverRestartBackoffS(3)).toBe(DEVSERVER_RESTART_COOLDOWN_BASE_S * 8);
  });

  it('caps at DEVSERVER_RESTART_MAX_BACKOFF_S no matter how many consecutive failures — backoff never grows unbounded', () => {
    expect(computeDevserverRestartBackoffS(10)).toBe(DEVSERVER_RESTART_MAX_BACKOFF_S);
    expect(computeDevserverRestartBackoffS(1000)).toBe(DEVSERVER_RESTART_MAX_BACKOFF_S);
  });

  it('treats a negative attempts count the same as 0 (defensive)', () => {
    expect(computeDevserverRestartBackoffS(-1)).toBe(DEVSERVER_RESTART_COOLDOWN_BASE_S);
  });
});

// ── shouldTriggerDevserverRestart ─────────────────────────────────────────────

describe('shouldTriggerDevserverRestart', () => {
  it('never restarts a healthy (running) server', () => {
    const decision = shouldTriggerDevserverRestart('running', 1000, 1000 + 3600, 0);
    expect(decision.restart).toBe(false);
  });

  it('never restarts while installing_deps/starting (not a crash)', () => {
    expect(shouldTriggerDevserverRestart('installing_deps', 1000, 1000 + 3600, 0).restart).toBe(false);
    expect(shouldTriggerDevserverRestart('starting', 1000, 1000 + 3600, 0).restart).toBe(false);
  });

  it('does NOT trigger on timeout — the process may still be alive and legitimately compiling', () => {
    expect(shouldTriggerDevserverRestart('timeout', 1000, 1000 + 3600, 0).restart).toBe(false);
  });

  it('does not restart while placeholder mode (no project scaffolded yet)', () => {
    expect(shouldTriggerDevserverRestart('placeholder', 1000, 1000 + 3600, 0).restart).toBe(false);
  });

  it('triggers on a crashed phase once the base cooldown has elapsed', () => {
    const decision = shouldTriggerDevserverRestart(
      'crashed',
      1000,
      1000 + DEVSERVER_RESTART_COOLDOWN_BASE_S,
      0,
    );
    expect(decision.restart).toBe(true);
    expect(decision.cooldownRemainingS).toBe(0);
  });

  it('suppresses a rapid re-trigger within the cooldown window (restart storm guard)', () => {
    const decision = shouldTriggerDevserverRestart('crashed', 1000, 1001, 0);
    expect(decision.restart).toBe(false);
    expect(decision.cooldownRemainingS).toBeGreaterThan(0);
  });

  it('applies the escalated (attempts-aware) backoff, not just the base cooldown, on repeated failures', () => {
    // attempts=2 -> backoff = 5 * 2^2 = 20s. At +6s (past the base 5s but
    // within the escalated 20s) it must still hold off.
    const tooSoon = shouldTriggerDevserverRestart('crashed', 1000, 1000 + 6, 2);
    expect(tooSoon.restart).toBe(false);
    const longEnough = shouldTriggerDevserverRestart('crashed', 1000, 1000 + 21, 2);
    expect(longEnough.restart).toBe(true);
  });

  it('restarts immediately when the phase file has no timestamp (defensive fallback)', () => {
    const decision = shouldTriggerDevserverRestart('crashed', null, 1000, 0);
    expect(decision.restart).toBe(true);
  });
});

// ── effectiveDevserverPhase ────────────────────────────────────────────────────

describe('effectiveDevserverPhase', () => {
  it('passes healthy/transient phases through unchanged', () => {
    expect(effectiveDevserverPhase('running', 0)).toBe('running');
    expect(effectiveDevserverPhase('installing_deps', 0)).toBe('installing_deps');
    expect(effectiveDevserverPhase(null, 0)).toBeNull();
  });

  it('reports a first crash as plain "crashed" (transient, not yet a loop)', () => {
    expect(effectiveDevserverPhase('crashed', 1)).toBe('crashed');
    expect(effectiveDevserverPhase('crashed', DEVSERVER_RESTART_ESCALATE_ATTEMPTS - 1)).toBe('crashed');
  });

  it('escalates to "crash_looping" once attempts reaches the escalation threshold', () => {
    expect(effectiveDevserverPhase('crashed', DEVSERVER_RESTART_ESCALATE_ATTEMPTS)).toBe('crash_looping');
    expect(effectiveDevserverPhase('crashed', DEVSERVER_RESTART_ESCALATE_ATTEMPTS + 10)).toBe('crash_looping');
  });

  it('never escalates a phase other than crashed, even with a high attempt count', () => {
    expect(effectiveDevserverPhase('timeout', 99)).toBe('timeout');
    expect(effectiveDevserverPhase('running', 99)).toBe('running');
  });
});

// ── buildDevserverRestartCommand ──────────────────────────────────────────────

describe('buildDevserverRestartCommand', () => {
  it('references the workspace-root state file and the launcher binary path', () => {
    const cmd = buildDevserverRestartCommand('/usr/local/bin/start-devserver.sh');
    expect(cmd).toContain(DEVSERVER_WORKSPACE_ROOT_FILE);
    expect(cmd).toContain('/usr/local/bin/start-devserver.sh');
  });

  it('uses the default bin path when omitted', () => {
    expect(buildDevserverRestartCommand()).toContain('/usr/local/bin/start-devserver.sh');
  });

  it('single-quote-escapes a bin path containing a single quote', () => {
    const cmd = buildDevserverRestartCommand("/tmp/o'brien/start-devserver.sh");
    expect(cmd).toContain(`'/tmp/o'\\''brien/start-devserver.sh'`);
  });
});

// ── buildPackageJsonCheckCommand ──────────────────────────────────────────────

describe('buildPackageJsonCheckCommand', () => {
  it('references the devserver workspace-root state file', () => {
    const cmd = buildPackageJsonCheckCommand('/workspace');
    expect(cmd).toContain(DEVSERVER_WORKSPACE_ROOT_FILE);
  });

  it('falls back to the provided mount path when the state file is absent/empty', () => {
    const cmd = buildPackageJsonCheckCommand('/workspace');
    expect(cmd).toContain("root='/workspace'");
  });

  it('single-quote-escapes a fallback path containing a single quote', () => {
    const cmd = buildPackageJsonCheckCommand("/weird'path");
    // Must not produce an unterminated single-quoted string.
    expect(cmd).toContain(String.raw`/weird'\''path`);
  });

  it('is a valid, executable-shaped shell command (test -f on the resolved root)', () => {
    const cmd = buildPackageJsonCheckCommand('/workspace');
    expect(cmd).toContain('test -f "$root/package.json"');
  });
});

// ── End-to-end: handlePreviewBootstrap ───────────────────────────────────────

describe('handlePreviewBootstrap', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';

  it('302-redirects to /preview<path> and sets the cookie on a valid token', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&path=%2Fabout`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/preview/about');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain(`${PREVIEW_COOKIE_NAME}=${SID}.`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=None');
  });

  it('defaults to /preview/ when no path is given', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    expect(res.headers.get('location')).toBe('/preview/');
  });

  it('returns 401 on an invalid token', async () => {
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=t=1,v1=deadbeef`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    expect(res.status).toBe(401);
  });
});

// ── End-to-end: handlePreviewProxy against a fake ContainerFetcher ──────────

function fakeContainerFetcher(handler: (url: string, init?: RequestInit) => Response): ContainerFetcher {
  return {
    async containerFetch(requestOrUrl, portOrInit) {
      const url = typeof requestOrUrl === 'string' ? requestOrUrl : requestOrUrl.url;
      const init = typeof portOrInit === 'object' ? portOrInit : undefined;
      return handler(url, init);
    },
  };
}

describe('handlePreviewProxy', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';

  it('returns 401 without a valid cookie', async () => {
    const sandbox = fakeContainerFetcher(() => new Response('should not be reached'));
    const request = new Request(`https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview/`);
    const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(401);
  });

  it('proxies through with a valid cookie and injects the shim into HTML', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeContainerFetcher((url) => {
      expect(url).toContain(`127.0.0.1:${APP_PREVIEW_PORT}/about`);
      return new Response('<html><head></head><body>hi</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' },
      });
    });
    const request = new Request(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview/about`,
      { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } },
    );
    const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/about');
    expect(res.status).toBe(200);
    expect(res.headers.has('x-frame-options')).toBe(false);
    const body = await res.text();
    expect(body).toContain('preview-inspector.js');
  });

  it('returns the diagnostic 503 page when the container connection fails', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox: ContainerFetcher = {
      async containerFetch() {
        throw new Error('connect ECONNREFUSED 127.0.0.1:3002');
      },
    };
    const request = new Request(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview/`,
      { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } },
    );
    const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('Dev server not running');
  });
});
