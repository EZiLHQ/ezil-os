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
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expectPreviewScriptsAllowed, previewPageScripts, previewExternalScriptAllowed, inspectorCspPolicies } from './code-preview-bridge-test-helpers';

import {
  previewInspectorScript,
  previewInspectorOrigins,
  buildDiagnosticResponse,
  parseBridgeHost,
  rewriteResponseHeaders,
  rewriteSetCookie,
  stripFrameAncestors,
  injectRuntimeShim,
  allowPreviewInlineScripts,
  readCookie,
  stripPreviewCookie,
  handlePreviewBootstrap,
  handlePreviewProxy,
  handlePreviewWsProxy,
  handlePreviewInspectorJs,
  resolvePreviewAuth,
  stripPreviewQueryParam,
  PREVIEW_COOKIE_QUERY_PARAM,
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
  APP_FORWARDED_HOST,
  resolveForwardedHost,
  type ContainerFetcher,
  type ContainerWebSocketConnector,
} from './preview-bridge';
import {
  mintPreviewBootstrapToken,
  verifyPreviewBootstrapToken,
  mintPreviewCookie,
  verifyPreviewCookie,
  PREVIEW_COOKIE_NAME,
} from './hmac';
import {
  APP_PREVIEW_PORT,
  APP_PREVIEW_TOKEN,
  CODE_PREVIEW_PORT,
  CODE_PREVIEW_TOKEN,
  appPortFor,
  codePortFor,
} from './desktop-mode';

// ── Hostname parsing ─────────────────────────────────────────────────────────

describe('parseBridgeHost', () => {
  it('parses the app-preview hostname, including a hyphenated sandboxId', () => {
    const sandboxId = 'guac-user1-proj1';
    const host = `${APP_PREVIEW_PORT}-${sandboxId}-${APP_PREVIEW_TOKEN}.ezil.org`;
    expect(parseBridgeHost(host)).toEqual({ sandboxId, target: 'app' });
  });

  it('parses the code-server bridge hostname, including a hyphenated sandboxId', () => {
    const sandboxId = 'guac-user1-proj1';
    const host = `${CODE_PREVIEW_PORT}-${sandboxId}-${CODE_PREVIEW_TOKEN}.ezil.org`;
    expect(parseBridgeHost(host)).toEqual({ sandboxId, target: 'code' });
  });

  it('rejects a different port', () => {
    const host = `8181-guac-user1-proj1-app.ezil.org`;
    expect(parseBridgeHost(host)).toBeNull();
  });

  it('rejects a different token (e.g. the desktop token on the app port)', () => {
    const host = `${APP_PREVIEW_PORT}-guac-user1-proj1-nekodesktop.ezil.org`;
    expect(parseBridgeHost(host)).toBeNull();
  });

  it('rejects the app token on the code-server port and vice versa', () => {
    expect(parseBridgeHost(`${CODE_PREVIEW_PORT}-guac-user1-proj1-${APP_PREVIEW_TOKEN}.ezil.org`)).toBeNull();
    expect(parseBridgeHost(`${APP_PREVIEW_PORT}-guac-user1-proj1-${CODE_PREVIEW_TOKEN}.ezil.org`)).toBeNull();
  });

  it('rejects a hostname with no hyphen at all', () => {
    expect(parseBridgeHost('ezil.org')).toBeNull();
  });

  it('rejects an empty sandboxId', () => {
    const host = `${APP_PREVIEW_PORT}-${APP_PREVIEW_TOKEN}.ezil.org`;
    // firstHyphen splits "3002" from "app.ezil.org" (no sandboxId segment) —
    // rest="app", lastHyphen===-1 → null.
    expect(parseBridgeHost(host)).toBeNull();
  });

  it('handles a bare hostname with no dot (local dev without a domain)', () => {
    const sandboxId = 'guac-user1-proj1';
    const host = `${APP_PREVIEW_PORT}-${sandboxId}-${APP_PREVIEW_TOKEN}`;
    expect(parseBridgeHost(host)).toEqual({ sandboxId, target: 'app' });
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

describe('codePortFor', () => {
  it('resolves the code-server bridge port/token for neko mode', () => {
    expect(codePortFor('neko')).toEqual({ port: CODE_PREVIEW_PORT, token: CODE_PREVIEW_TOKEN });
  });

  it('resolves to null for guacamole mode (no code-server surface)', () => {
    expect(codePortFor('guacamole')).toBeNull();
  });

  it('never collides with any other reserved port on the stack', () => {
    expect(CODE_PREVIEW_PORT).not.toBe(3000); // @cloudflare/sandbox control plane
    expect(CODE_PREVIEW_PORT).not.toBe(APP_PREVIEW_PORT); // user's own dev server
    expect(CODE_PREVIEW_PORT).not.toBe(8080); // guacamole
    expect(CODE_PREVIEW_PORT).not.toBe(8181); // neko WebRTC/noVNC
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
    // `Partitioned` is not cosmetic: every cookie here is forced to
    // `SameSite=None`, and Chrome blocks a `SameSite=None` cookie outright in
    // a third-party iframe unless it is also partitioned. Without it the
    // previewed app's own session/CSRF cookies vanish the moment the shell
    // embeds the window cross-site — the same silent failure the
    // `ezil_preview` cookie had.
    expect(out).toBe('foo=bar; Path=/preview; SameSite=None; Secure; Partitioned');
  });

  it('does not duplicate attributes the upstream already set', () => {
    const out = rewriteSetCookie('foo=bar; Path=/api; SameSite=Lax; Secure; Partitioned; HttpOnly');
    expect(out).toBe('foo=bar; Path=/preview; SameSite=None; Secure; Partitioned; HttpOnly');
    expect(out.match(/Partitioned/g)).toHaveLength(1);
    expect(out.match(/Secure/g)).toHaveLength(1);
    expect(out.match(/Path=/g)).toHaveLength(1);
  });

  it('drops Domain= (Partitioned is invalid with a Domain attribute)', () => {
    const out = rewriteSetCookie('foo=bar; Domain=.example.com');
    expect(out).not.toContain('Domain');
    expect(out).toContain('Partitioned');
  });

  it('pins the code-server host cookies to `/`, not `/preview`', () => {
    // code-server is served from the ROOT of its own bridge host
    // (`handleCodeBridge`); a `/preview`-scoped cookie would never be sent
    // back on any of its root-absolute requests.
    expect(rewriteSetCookie('foo=bar', '/')).toBe('foo=bar; Path=/; SameSite=None; Secure; Partitioned');
    expect(rewriteSetCookie('foo=bar; Path=/deep/nested', '/')).toContain('Path=/;');
  });

  it('rewriteResponseHeaders threads the cookie path through', () => {
    const upstream = new Headers();
    upstream.append('set-cookie', 'a=1');
    expect(rewriteResponseHeaders(upstream).get('set-cookie')).toContain('Path=/preview');
    expect(rewriteResponseHeaders(upstream, '/').get('set-cookie')).toContain('Path=/');
  });
});

// ── HTML shim injection ──────────────────────────────────────────────────────

describe('injectRuntimeShim', () => {
  it('keeps existing unrestricted inline CSP behavior and does not add a policy when absent', async () => {
    for (const policy of [null, "script-src 'self' 'unsafe-inline'", "img-src 'none'"]) {
      const headers = new Headers(policy ? { 'content-security-policy': policy } : {});
      await allowPreviewInlineScripts(headers, injectRuntimeShim('<head></head>'));
      expect(headers.get('content-security-policy')).toBe(policy);
    }
  });
  it('adds only the injected script hashes to nonce/none policies, retaining unrelated restrictions', async () => {
    const headers = new Headers({ 'content-security-policy': "default-src 'none'; script-src 'nonce-existing'; script-src-elem 'none'; img-src https://images.example" });
    const html = injectRuntimeShim('<head></head>');
    await allowPreviewInlineScripts(headers, html); await expectPreviewScriptsAllowed(html, headers);
    const policy = headers.get('content-security-policy')!;
    expect(policy).toContain("default-src 'none'"); expect(policy).toContain("script-src 'nonce-existing'");
    expect(policy).toContain('img-src https://images.example'); expect(policy).not.toContain("script-src-elem 'none'");
  });
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

  // ── Client-side fallback-param propagation (Safari ITP / no-cookie case) ───
  // Static assertions on the generated shim source — mirrors this project's
  // precedent for verifying generated code (see `index.test.ts`'s
  // `expect(src).toContain(...)` guards) since there is no DOM/jsdom
  // available in this package's plain `bun test` runner to execute it.
  it('embeds PREVIEW_COOKIE_QUERY_PARAM as the client-side fallback param name', () => {
    const out = injectRuntimeShim('<html><head></head><body></body></html>');
    expect(out).toContain(JSON.stringify(PREVIEW_COOKIE_QUERY_PARAM));
  });

  it('patches fetch and XMLHttpRequest to propagate the fallback param', () => {
    const out = injectRuntimeShim('<html><head></head><body></body></html>');
    expect(out).toContain('window.fetch = function');
    expect(out).toContain('XMLHttpRequest.prototype.open = function');
  });

  it('keeps original HMR paths for the provider-neutral app catchall', () => {
    const out = injectRuntimeShim('<html><head></head><body></body></html>');
    expect(out).not.toContain("u.pathname = '/preview-ws' + u.pathname");
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
    // Path is unchanged; the fallback query param (`ezil_pv`, see below) is
    // ADDITIVE — asserted separately.
    expect(new URL(res.headers.get('location')!, 'https://example.com').pathname).toBe('/preview/about');
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
    expect(new URL(res.headers.get('location')!, 'https://example.com').pathname).toBe('/preview/');
  });

  it('returns 401 on an invalid token', async () => {
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=t=1,v1=deadbeef`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    expect(res.status).toBe(401);
  });

  // ── CHIPS (Partitioned) + query-param fallback ──────────────────────────────
  // Root cause: without `Partitioned`, Chrome/Edge can refuse to send this
  // `SameSite=None` cookie back at all in a third-party-iframe context, and
  // Safari's ITP blocks third-party cookies outright regardless of any
  // attribute — in both cases the bootstrap 302 "succeeds" while every
  // subsequent `/preview/*` request silently 401s. These assertions pin the
  // fix: the cookie is `Partitioned`, AND the same auth value is ALSO on the
  // redirect target as a query param so the very first request never depends
  // on the cookie having landed.
  it('sets Partitioned on the cookie (CHIPS) so a 3p-iframe context can use it at all', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('Partitioned');
    // Still carries every pre-existing attribute — Partitioned is additive.
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
  });

  it('embeds the SAME cookie value as an `ezil_pv` query-param fallback on the redirect target', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&path=%2Fabout`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    const location = res.headers.get('location')!;
    const setCookie = res.headers.get('set-cookie')!;
    const cookieValue = setCookie.split(';')[0]!.split('=').slice(1).join('=');
    expect(location.startsWith('/preview/about?')).toBe(true);
    const locUrl = new URL(location, 'https://example.com');
    expect(locUrl.searchParams.get(PREVIEW_COOKIE_QUERY_PARAM)).toBe(cookieValue);
  });

  it('preserves an existing query string in `path` alongside the fallback param', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&path=${encodeURIComponent('/about?x=1')}`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
    const locUrl = new URL(res.headers.get('location')!, 'https://example.com');
    expect(locUrl.pathname).toBe('/preview/about');
    expect(locUrl.searchParams.get('x')).toBe('1');
    expect(locUrl.searchParams.has(PREVIEW_COOKIE_QUERY_PARAM)).toBe(true);
  });

  it('refuses a `path` whose `..` segments pop /preview into `//host` (invalid_redirect, no cookie), both targets', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    for (const [port, label, target] of [
      [APP_PREVIEW_PORT, APP_PREVIEW_TOKEN, 'app'],
      [CODE_PREVIEW_PORT, CODE_PREVIEW_TOKEN, 'code'],
    ] as const) {
      for (const path of ['/..//evil.com', '/../..//evil.com', '/%2e%2e//evil.com', '/%2E%2E//evil.com', '/.%2e//evil.com', '/a/../..//evil.com']) {
        const url = new URL(
          `https://${port}-${SID}-${label}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}`,
        );
        const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET, target);
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(await res.json()).toEqual({ ok: false, error: 'invalid_redirect' });
        expect(res.headers.get('location')).toBeNull();
        expect(res.headers.get('set-cookie')).toBeNull();
      }
    }
    // A `//host` or `/.//host` path stays under /preview, and a plain path still redirects.
    for (const [path, pathname] of [['//evil.com', '/preview//evil.com'], ['/.//evil.com', '/preview//evil.com'], ['/app?x=1', '/preview/app']]) {
      const url = new URL(
        `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path!)}`,
      );
      const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')!.startsWith(`${pathname}?`)).toBe(true);
    }
  });

  // ── `folder=` passthrough — the "Code opens with an empty file tree" fix ───
  //
  // GAP: production never sent `folder=` on the code-server bridge URL, so
  // code-server's own UI showed "You have no recent folders" (explorerRows:
  // 0). Even once the minting side (`buildBridgeUrl` in `./index.ts`) is
  // fixed to embed `folder=`, this redirect handler builds a BRAND NEW
  // `locationUrl` — every query param other than `path`/the cookie fallback
  // is silently dropped unless explicitly named here. These tests prove
  // `folder` survives the 302 for the code target, is dropped for the app
  // target (which has no matching concept and must not risk confusing a
  // user's own dev server routing), and is absent when the caller never
  // supplied one.
  it('forwards `folder=` onto the redirect target for the CODE bridge', async () => {
    const codeSid = 'guac-user1-proj1';
    const token = await mintPreviewBootstrapToken(SECRET, codeSid);
    const url = new URL(
      `https://${CODE_PREVIEW_PORT}-${codeSid}-${CODE_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&folder=%2Fworkspace`,
    );
    const res = await handlePreviewBootstrap(url, codeSid, [SECRET], SECRET, 'code');
    expect(res.status).toBe(302);
    const locUrl = new URL(res.headers.get('location')!, 'https://example.com');
    expect(locUrl.searchParams.get('folder')).toBe('/workspace');
  });

  it('does NOT forward `folder=` for the APP bridge, even if present on the request', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&folder=%2Fworkspace`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET, 'app');
    const locUrl = new URL(res.headers.get('location')!, 'https://example.com');
    expect(locUrl.searchParams.has('folder')).toBe(false);
  });

  it('omits `folder=` on the code bridge when the caller never supplied one', async () => {
    const codeSid = 'guac-user1-proj1';
    const token = await mintPreviewBootstrapToken(SECRET, codeSid);
    const url = new URL(
      `https://${CODE_PREVIEW_PORT}-${codeSid}-${CODE_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}`,
    );
    const res = await handlePreviewBootstrap(url, codeSid, [SECRET], SECRET, 'code');
    const locUrl = new URL(res.headers.get('location')!, 'https://example.com');
    expect(locUrl.searchParams.has('folder')).toBe(false);
  });

  // ── Per-tab folder continuity (./code-folder.ts): the code bootstrap never trusts a raw folder ──
  const codeBootstrap = async (query: string) => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}${query}`,
    );
    return handlePreviewBootstrap(url, SID, [SECRET], SECRET, 'code');
  };
  const locationOf = (res: Response) => new URL(res.headers.get('location')!, 'https://example.com');

  it('code: a traversal, relative or control-character folder is 400 invalid_folder, never forwarded', async () => {
    for (const bad of ['/workspace/../etc', 'workspace', './workspace', '/workspace//a', '/workspace/a\nb', '/workspace/a\\b']) {
      const res = await codeBootstrap(`&folder=${encodeURIComponent(bad)}`);
      expect({ bad, status: res.status }).toEqual({ bad, status: 400 });
      expect(await res.json()).toEqual({ ok: false, error: 'invalid_folder' });
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });

  it('code: a plain folder with spaces and Unicode is forwarded exactly (one trailing slash dropped)', async () => {
    const res = await codeBootstrap(`&folder=${encodeURIComponent('/workspace/My Project/日本 ü/')}`);
    expect(res.status).toBe(302);
    expect(locationOf(res).searchParams.get('folder')).toBe('/workspace/My Project/日本 ü');
  });

  it('code: the project folder repo-open composes still passes', async () => {
    const res = await codeBootstrap(`&folder=${encodeURIComponent('/workspace/projects/0b0e9b8e-6b1f-4c5e-9d3a-2f1e8c7d6a5b')}`);
    expect(res.status).toBe(302);
    expect(locationOf(res).searchParams.get('folder')).toBe('/workspace/projects/0b0e9b8e-6b1f-4c5e-9d3a-2f1e8c7d6a5b');
  });

  it('code: an open key hidden inside `path` is refused (the `path=/?folder=/etc` injection)', async () => {
    for (const hidden of ['/?folder=/etc', '/?workspace=/etc/x.code-workspace', '/?ew=true', '/?payload=%5B%5D', '/?ezil_mint=AAAAAAAAAAAAAAAAAAAAAA']) {
      const res = await codeBootstrap(`&path=${encodeURIComponent(hidden)}`);
      expect({ hidden, status: res.status }).toEqual({ hidden, status: 400 });
    }
    // An ordinary query in `path` is still forwarded on the code target.
    const ok = await codeBootstrap(`&path=${encodeURIComponent('/?x=1')}`);
    expect(ok.status).toBe(302);
    expect(locationOf(ok).searchParams.get('x')).toBe('1');
  });

  it('app: the same hidden keys stay the dev server\'s business (unchanged)', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&path=${encodeURIComponent('/files?folder=a&ew=1')}`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET, 'app');
    expect(res.status).toBe(302);
    expect(locationOf(res).searchParams.get('folder')).toBe('a');
  });

  it('code: a well-formed ezil_mint is forwarded; a malformed one is dropped, never an error', async () => {
    const mint = 'abcdefghijklmnopqrstu_';
    const good = await codeBootstrap(`&folder=%2Fworkspace&ezil_mint=${mint}`);
    expect(good.status).toBe(302);
    expect(locationOf(good).searchParams.get('ezil_mint')).toBe(mint);
    expect(locationOf(good).searchParams.get('folder')).toBe('/workspace');
    for (const bad of ['short', `${mint}x`, 'AAAAAAAAAAAAAAAAAAAA+/']) {
      const res = await codeBootstrap(`&ezil_mint=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(302);
      expect(locationOf(res).searchParams.has('ezil_mint')).toBe(false);
    }
  });

  it('app: ezil_mint is never forwarded', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const url = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&ezil_mint=abcdefghijklmnopqrstu_`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET, 'app');
    expect(locationOf(res).searchParams.has('ezil_mint')).toBe(false);
  });

  it('an invalid token is still 401 before any folder check', async () => {
    const url = new URL(
      `https://${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=t=1,v1=deadbeef&folder=..`,
    );
    const res = await handlePreviewBootstrap(url, SID, [SECRET], SECRET, 'code');
    expect(res.status).toBe(401);
  });
});

// ── Query-param fallback auth (resolvePreviewAuth / stripPreviewQueryParam) ──

describe('resolvePreviewAuth', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';

  it('accepts a valid cookie with no fallback param present', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const request = new Request('https://example.ezil.org/preview/', {
      headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` },
    });
    const ok = await resolvePreviewAuth(request, new URL(request.url), [SECRET], SID);
    expect(ok).toBe(true);
  });

  it('accepts a valid `ezil_pv` query param when there is no cookie at all (Safari ITP case)', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const request = new Request(`https://example.ezil.org/preview/?${PREVIEW_COOKIE_QUERY_PARAM}=${encodeURIComponent(cookie)}`);
    const ok = await resolvePreviewAuth(request, new URL(request.url), [SECRET], SID);
    expect(ok).toBe(true);
  });

  it('rejects when neither the cookie nor the query param is valid', async () => {
    const request = new Request(`https://example.ezil.org/preview/?${PREVIEW_COOKIE_QUERY_PARAM}=garbage`);
    const ok = await resolvePreviewAuth(request, new URL(request.url), [SECRET], SID);
    expect(ok).toBe(false);
  });

  it('rejects a fallback param minted for a DIFFERENT sandboxId (no cross-tenant reuse)', async () => {
    const cookie = await mintPreviewCookie(SECRET, 'guac-user2-proj1');
    const request = new Request(`https://example.ezil.org/preview/?${PREVIEW_COOKIE_QUERY_PARAM}=${encodeURIComponent(cookie)}`);
    const ok = await resolvePreviewAuth(request, new URL(request.url), [SECRET], SID);
    expect(ok).toBe(false);
  });

  it('prefers a valid cookie over the query param when both are present', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const request = new Request(`https://example.ezil.org/preview/?${PREVIEW_COOKIE_QUERY_PARAM}=garbage`, {
      headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` },
    });
    const ok = await resolvePreviewAuth(request, new URL(request.url), [SECRET], SID);
    expect(ok).toBe(true);
  });
});

describe('stripPreviewQueryParam', () => {
  it('removes only the fallback param, keeping every other query param intact', () => {
    expect(stripPreviewQueryParam(`?a=1&${PREVIEW_COOKIE_QUERY_PARAM}=xyz&b=2`)).toBe('?a=1&b=2');
  });

  it('returns an empty string when the fallback param was the only one', () => {
    expect(stripPreviewQueryParam(`?${PREVIEW_COOKIE_QUERY_PARAM}=xyz`)).toBe('');
  });

  it('is a no-op when the param is absent', () => {
    expect(stripPreviewQueryParam('?a=1&b=2')).toBe('?a=1&b=2');
    expect(stripPreviewQueryParam('')).toBe('');
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

  it('accepts a valid `ezil_pv` query param when the cookie is missing (Safari ITP fallback)', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeContainerFetcher(() => new Response('ok'));
    const request = new Request(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview/?${PREVIEW_COOKIE_QUERY_PARAM}=${encodeURIComponent(cookie)}`,
    );
    const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(200);
  });

  for (const status of [200, 201, 299, 301, 400, 404, 500, 502, 503, 504]) it(`app HTML status ${status} preserves the document and only 2xx can become ready`, async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const page = `https://3002-${SID}-app.ezil.org/preview/`;
    const html = '<html><head></head><body>Original upstream document</body></html>';
    const sandbox = fakeContainerFetcher(() => new Response(html, { status, headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'self'" } }));
    const res = await handlePreviewProxy(new Request(page, { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } }), sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(status);
    const body = await res.text(); expect(body).toContain('<body>Original upstream document</body>');
    await expectPreviewScriptsAllowed(body, res.headers);
    const scripts = previewPageScripts(body, page);
    if (status < 300) {
      expect(scripts.urls.map(u => u.pathname)).toEqual(['/preview-inspector.js']);
      expect(body).toContain('window.WebSocket = function');
      expect(body).not.toContain("u.pathname = '/preview-ws' + u.pathname");
    } else {
      expect(scripts.urls).toEqual([]); expect(body).not.toContain('window.WebSocket');
      const origin = `https://8443-${SID}-code.ezil.org`;
      expect(scripts.hello(origin, INSPECTOR_NONCE)).toEqual([{ origin, data: { type: 'ezil.preview.state', v: 1, nonce: INSPECTOR_NONCE, state: 'upstream_error' } }]);
    }
  });

  for (const fallback of [false, true]) it(`loads the inspector through its real auth gate using ${fallback ? 'query fallback' : 'cookie'}`, async () => {
    const cookie = await mintPreviewCookie(SECRET, SID), origin = `https://3002-${SID}-app.ezil.org`;
    const page = `${origin}/preview/${fallback ? '?ezil_pv=' + encodeURIComponent(cookie) : ''}`;
    const headers = fallback ? {} : { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` };
    const sandbox = fakeContainerFetcher(() => new Response('<html><head></head><body>App</body></html>', { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src-elem 'self'" } }));
    const res = await handlePreviewProxy(new Request(page, { headers }), sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(200);
    const html = await res.text(); expect(html).not.toContain(cookie);
    await expectPreviewScriptsAllowed(html, res.headers);
    const scripts = previewPageScripts(html, page, res.headers); expect(scripts.urls).toHaveLength(1);
    const scriptUrl = scripts.urls[0]; expect(scriptUrl.pathname).toBe('/preview-inspector.js');
    expect(scriptUrl.searchParams.get('ezil_pv')).toBe(fallback ? cookie : null);
    expect((await handlePreviewInspectorJs(new Request(scriptUrl, { headers }), SID, [SECRET])).status).toBe(200);
    expect((await handlePreviewInspectorJs(new Request(`${origin}/preview-inspector.js`), SID, [SECRET])).status).toBe(401);
  });
  for (const csp of inspectorCspPolicies) it(`authorizes the actual external inspector narrowly under CSP: ${csp}`, async () => {
    const cookie = await mintPreviewCookie(SECRET, SID), origin = `https://3002-${SID}-app.ezil.org`;
    const page = `${origin}/preview/?ezil_pv=${encodeURIComponent(cookie)}`;
    const upstream = new Headers({ 'content-type': 'text/html', 'content-security-policy': csp });
    const sandbox = fakeContainerFetcher(() => new Response('<head></head><body>App</body>', { headers: upstream }));
    const res = await handlePreviewProxy(new Request(page), sandbox, SID, [SECRET], '/');
    const scripts = previewPageScripts(await res.text(), page, res.headers);
    expect(scripts.urls).toHaveLength(1);
    expect((await handlePreviewInspectorJs(new Request(scripts.urls[0]), SID, [SECRET])).status).toBe(200);
    const policy = res.headers.get('content-security-policy')!;
    expect(policy).toContain(`${origin}/preview-inspector.js`);
    expect(policy).not.toContain(cookie); expect(policy).not.toContain("'self'"); expect(policy).not.toContain('https: ');
    for (const url of [`${origin}/other.js`, `${origin}/preview-inspector.js/child`, 'https://other.test/preview-inspector.js'])
      expect(previewExternalScriptAllowed(res.headers, page, url)).toBe(false);
    if (csp.includes('img-src')) expect(policy).toContain(csp.includes('images.example') ? 'img-src https://images.example' : "img-src 'none'");
    expect(policy.split(',')).toHaveLength(csp.split(',').length);
  });
  it('preserves HTML statuses that cannot carry a response body', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const request = new Request(`https://3002-${SID}-app.ezil.org/preview/`, { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } });
    for (const status of [204, 205, 304]) {
      const sandbox = fakeContainerFetcher(() => new Response(null, { status, headers: { 'content-type': 'text/html' } }));
      const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/');
      expect(res.status).toBe(status); expect(await res.text()).toBe('');
    }
  });

  it('strips the `ezil_pv` fallback param before forwarding upstream', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeContainerFetcher((url) => {
      expect(url).not.toContain(PREVIEW_COOKIE_QUERY_PARAM);
      expect(url).toContain('keep=1');
      return new Response('ok');
    });
    const request = new Request(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview/?keep=1&${PREVIEW_COOKIE_QUERY_PARAM}=${encodeURIComponent(cookie)}`,
    );
    const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(200);
  });

  // ── Generalized `port`/`target` parameters (code-server bridge) ────────────
  describe('with an explicit port and target: code', () => {
    it('proxies to the given port instead of APP_PREVIEW_PORT', async () => {
      const cookie = await mintPreviewCookie(SECRET, SID);
      const sandbox = fakeContainerFetcher((url) => {
        expect(url).toContain(`127.0.0.1:${CODE_PREVIEW_PORT}/`);
        return new Response('<html><head></head><body>code-server</body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      });
      const request = new Request(
        `https://${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.org/preview/`,
        { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } },
      );
      const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code');
      expect(res.status).toBe(200);
    });

    it('NEVER injects RUNTIME_SHIM into an HTML response — code-server WebSocket traffic is not HMR', async () => {
      const cookie = await mintPreviewCookie(SECRET, SID);
      const sandbox = fakeContainerFetcher(
        () =>
          new Response('<html><head><title>vscode</title></head><body>code-server</body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      );
      const request = new Request(
        `https://${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.org/preview/`,
        { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } },
      );
      const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code');
      const body = await res.text();
      expect(body).not.toContain('preview-inspector.js');
      expect(body).not.toContain('window.WebSocket');
      expect(body).toBe('<html><head><title>vscode</title></head><body>code-server</body></html>');
    });

    it('still injects RUNTIME_SHIM for target: app (the default) — no regression', async () => {
      const cookie = await mintPreviewCookie(SECRET, SID);
      const sandbox = fakeContainerFetcher(
        () =>
          new Response('<html><head></head><body>app</body></html>', {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      );
      const request = new Request(
        `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview/`,
        { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } },
      );
      const res = await handlePreviewProxy(request, sandbox, SID, [SECRET], '/');
      const body = await res.text();
      expect(body).toContain('preview-inspector.js');
    });
  });
});

// ── End-to-end: /preview-bootstrap -> /preview really hands `folder=` to the
//    container, exactly as observed in production ("You have no recent
//    folders" -> `explorerRows: 11` once `&folder=%2Fworkspace` reaches
//    code-server). Chains the REAL `handlePreviewBootstrap` redirect into the
//    REAL `handlePreviewProxy` forward — not a mock of either — against a
//    fake `ContainerFetcher`, so this fails if EITHER hop drops the param.
describe('bootstrap -> proxy carries folder= all the way to the container fetch', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';

  it('a folder= minted on the bootstrap request reaches containerFetch on the code bridge', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const bootstrapUrl = new URL(
      `https://${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&folder=%2Fworkspace`,
    );
    const bootstrapRes = await handlePreviewBootstrap(bootstrapUrl, SID, [SECRET], SECRET, 'code');
    expect(bootstrapRes.status).toBe(302);
    const location = bootstrapRes.headers.get('location')!;

    let seenUrl = '';
    const sandbox = fakeContainerFetcher((url) => {
      seenUrl = url;
      return new Response('<html><head></head><body>code-server</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    // The browser's actual follow-up request: same host, the 302's Location,
    // carrying whatever Set-Cookie the bootstrap minted.
    const setCookie = bootstrapRes.headers.get('set-cookie')!;
    const cookiePair = setCookie.split(';')[0]!;
    const followUpUrl = new URL(location, bootstrapUrl);
    const followUpRequest = new Request(followUpUrl.toString(), { headers: { cookie: cookiePair } });
    const codePath = followUpUrl.pathname === '/preview' ? '/' : followUpUrl.pathname.slice('/preview'.length) || '/';
    const proxyRes = await handlePreviewProxy(
      followUpRequest,
      sandbox,
      SID,
      [SECRET],
      codePath,
      CODE_PREVIEW_PORT,
      'code',
    );
    expect(proxyRes.status).toBe(200);
    expect(seenUrl).toContain(`127.0.0.1:${CODE_PREVIEW_PORT}`);
    expect(seenUrl).toContain('folder=%2Fworkspace');
  });

  it('the SAME chain on the APP bridge never leaks folder= to the dev server', async () => {
    const token = await mintPreviewBootstrapToken(SECRET, SID);
    const bootstrapUrl = new URL(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-bootstrap?token=${encodeURIComponent(token)}&folder=%2Fworkspace`,
    );
    const bootstrapRes = await handlePreviewBootstrap(bootstrapUrl, SID, [SECRET], SECRET, 'app');
    const location = bootstrapRes.headers.get('location')!;
    const followUpUrl = new URL(location, bootstrapUrl);
    expect(followUpUrl.searchParams.has('folder')).toBe(false);

    let seenUrl = '';
    const sandbox = fakeContainerFetcher((url) => {
      seenUrl = url;
      return new Response('ok');
    });
    const setCookie = bootstrapRes.headers.get('set-cookie')!;
    const cookiePair = setCookie.split(';')[0]!;
    const followUpRequest = new Request(followUpUrl.toString(), { headers: { cookie: cookiePair } });
    await handlePreviewProxy(followUpRequest, sandbox, SID, [SECRET], '/');
    expect(seenUrl).not.toContain('folder');
  });
});

// ── The WebSocket path: the two bugs that made code-server unusable ────────
//
// 1. BUG B — `containerFetch` is a Durable Object **JSRPC** method, and a
//    `Response` carrying a `webSocket` cannot be serialized across an RPC
//    boundary. Every upgrade died as a 502 with
//    `Could not serialize object of type "WebSocket"…`. The old tests could
//    not see it because their fake returned `new Response(null,{status:101})`
//    with NO `webSocket` property, i.e. the one shape that survives RPC.
//    `rpcContainerFetch()` below models the real boundary instead.
//
// 2. BUG A — the forwarded host was pinned to `preview.local`, a host no
//    browser can present as an `Origin`, so code-server's WS-router origin
//    check rejected every upgrade. No test set `Origin` or looked at
//    `x-forwarded-host` at all. `simulateCodeServerEnsureOrigin()` below runs
//    code-server's actual algorithm against the headers we forward.

/**
 * `containerFetch` as the Durable Object RPC boundary really behaves: fine for
 * ordinary responses, and — for a WebSocket upgrade, where the container
 * answers 101 + `webSocket` — it rejects with workerd's own serializer error.
 * Verified against real workerd (a DO RPC method returning
 * `new Response(null,{status:101,webSocket})` throws exactly this string).
 *
 * Any code path that reaches the container's WebSocket through `containerFetch`
 * therefore fails here, loudly and for the production reason.
 */
function rpcContainerFetch(): ContainerFetcher['containerFetch'] {
  return async (requestOrUrl, portOrInit) => {
    const headers = new Headers(
      requestOrUrl instanceof Request
        ? requestOrUrl.headers
        : typeof portOrInit === 'object'
          ? portOrInit.headers
          : undefined,
    );
    if ((headers.get('upgrade') ?? '').toLowerCase() === 'websocket') {
      throw new Error('Could not serialize object of type "WebSocket". This type does not support serialization.');
    }
    return new Response('no upgrade');
  };
}

/** Opaque stand-in for a `WebSocket` — identity is all these tests compare. */
const FAKE_UPSTREAM_WS = { id: 'upstream-ws' } as unknown as WebSocket;

interface WsConnectCall {
  url: string;
  port: number;
  method: string;
  headers: Record<string, string>;
}

/**
 * A sandbox fake exposing BOTH surfaces: the working `wsConnect` (DO
 * `fetch()` hop — 101 + `webSocket` crosses intact) and the RPC
 * `containerFetch` that cannot carry one. Reverting the handler to
 * `containerFetch` therefore turns every assertion below red with the real
 * production error message, not a generic mismatch.
 */
function fakeWsSandbox(options: { upgrade?: boolean } = {}): ContainerWebSocketConnector &
  ContainerFetcher & { calls: WsConnectCall[] } {
  const calls: WsConnectCall[] = [];
  return {
    calls,
    containerFetch: rpcContainerFetch(),
    async wsConnect(request: Request, port: number) {
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        headers[k] = v;
      });
      calls.push({ url: request.url, port, method: request.method, headers });
      if (options.upgrade === false) return new Response('not an upgrade', { status: 200 });
      const res = new Response(null, { status: 101 });
      Object.defineProperty(res, 'webSocket', { value: FAKE_UPSTREAM_WS, configurable: true });
      return res;
    },
  };
}

/**
 * code-server's `authenticateOrigin` (`src/node/http.ts`), ported faithfully.
 * It runs on the WS router only — which is exactly why the editor renders over
 * HTTP and only the sockets 403.
 *
 *   - a missing `Origin` is allowed through (non-browser client);
 *   - otherwise `new URL(origin).host` must equal `getHost(req)`;
 *   - `getHost` honours `Forwarded` first, then `X-Forwarded-Host`, then `Host`.
 *
 * Throws on rejection (code-server maps that to HTTP 403).
 */
function simulateCodeServerEnsureOrigin(headers: Record<string, string>, origin: string | null): void {
  if (!origin) return;
  const originHost = new URL(origin).host.trim().toLowerCase();
  let host: string | undefined;
  if (headers['forwarded'] !== undefined) {
    host = /host="?([^";]+)"?/.exec(headers['forwarded'])?.[1]?.trim().toLowerCase();
  } else if (headers['x-forwarded-host'] !== undefined && headers['x-forwarded-host'] !== '') {
    host = headers['x-forwarded-host'].split(',')[0]?.trim().toLowerCase();
  } else {
    host = headers['host'];
  }
  if (host === undefined) throw new Error('no host headers found');
  if (host !== originHost) throw new Error(`incorrect origin: ${originHost} does not match host ${host}`);
}

describe('resolveForwardedHost', () => {
  it('pins the APP target to the synthetic constant (unchanged Azure behaviour)', () => {
    const url = new URL(`https://${APP_PREVIEW_PORT}-guac-a-b-${APP_PREVIEW_TOKEN}.ezil.org/preview-ws/`);
    expect(resolveForwardedHost(url, 'app')).toBe(APP_FORWARDED_HOST);
    expect(APP_FORWARDED_HOST).toBe('preview.local');
  });

  it('gives the CODE target the real bridge host — the only value an Origin can match', () => {
    const url = new URL(`https://${CODE_PREVIEW_PORT}-guac-a-b-${CODE_PREVIEW_TOKEN}.ezil.org/?type=ExtensionHost`);
    expect(resolveForwardedHost(url, 'code')).toBe(`${CODE_PREVIEW_PORT}-guac-a-b-${CODE_PREVIEW_TOKEN}.ezil.org`);
  });

  it('keeps a non-default port, because an Origin host carries one', () => {
    expect(resolveForwardedHost(new URL('http://localhost:8787/'), 'code')).toBe('localhost:8787');
  });
});

describe('handlePreviewWsProxy', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';
  const CODE_HOST = `${CODE_PREVIEW_PORT}-${SID}-${CODE_PREVIEW_TOKEN}.ezil.org`;
  const APP_HOST = `${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org`;

  /** The upgrade a browser actually sends for code-server's extension host. */
  function codeUpgradeRequest(cookie: string, extra: Record<string, string> = {}): Request {
    return new Request(`https://${CODE_HOST}/?type=ExtensionHost&reconnectionToken=abc`, {
      headers: {
        cookie: `${PREVIEW_COOKIE_NAME}=${cookie}`,
        upgrade: 'websocket',
        connection: 'Upgrade',
        origin: `https://${CODE_HOST}`,
        ...extra,
      },
    });
  }

  it('returns 401 without a valid cookie, and never touches the container', async () => {
    const sandbox = fakeWsSandbox();
    const request = new Request(`https://${APP_HOST}/preview-ws/`);
    const res = await handlePreviewWsProxy(request, sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(401);
    expect(sandbox.calls).toHaveLength(0);
  });

  it('defaults to APP_PREVIEW_PORT when no port is given', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    const request = new Request(`https://${APP_HOST}/preview-ws/`, {
      headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` },
    });
    await handlePreviewWsProxy(request, sandbox, SID, [SECRET], '/');
    expect(sandbox.calls[0]?.port).toBe(APP_PREVIEW_PORT);
  });

  it('reaches the code-server port when an explicit port is given', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    await handlePreviewWsProxy(codeUpgradeRequest(cookie), sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code');
    expect(sandbox.calls[0]?.port).toBe(CODE_PREVIEW_PORT);
    expect(sandbox.calls[0]?.url).toBe(`http://127.0.0.1:${CODE_PREVIEW_PORT}/?type=ExtensionHost&reconnectionToken=abc`);
  });

  it('accepts the `ezil_pv` query-param fallback when the cookie is missing', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    const request = new Request(
      `https://${APP_HOST}/preview-ws/?${PREVIEW_COOKIE_QUERY_PARAM}=${encodeURIComponent(cookie)}`,
      { headers: { upgrade: 'websocket', connection: 'Upgrade' } },
    );
    const res = await handlePreviewWsProxy(request, sandbox, SID, [SECRET], '/');
    expect(res.status).toBe(101);
    expect(sandbox.calls).toHaveLength(1);
    expect(sandbox.calls[0]?.url).not.toContain(PREVIEW_COOKIE_QUERY_PARAM);
  });

  // ── BUG B ────────────────────────────────────────────────────────────────
  it('🔴 hands the client a REAL 101 carrying the upstream WebSocket', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    const res = await handlePreviewWsProxy(
      codeUpgradeRequest(cookie), sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    expect(res.status).toBe(101);
    // The whole point of the fix: the socket object survives the hop. A 101
    // with no `webSocket` is what the old test asserted, and it is exactly the
    // shape that cannot happen in production.
    expect(res.webSocket).toBe(FAKE_UPSTREAM_WS);
  });

  it('🔴 never routes the upgrade through the JSRPC `containerFetch` boundary', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    // Only `wsConnect` exists here; a handler that reaches for `containerFetch`
    // gets a TypeError, which the handler reports as its 502 diagnostic.
    const wsOnly = { wsConnect: fakeWsSandbox().wsConnect } as ContainerWebSocketConnector;
    const res = await handlePreviewWsProxy(
      codeUpgradeRequest(cookie), wsOnly, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    expect(res.status).toBe(101);
  });

  it('🔴 surfaces an upstream failure as the 502 diagnostic rather than throwing', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox: ContainerWebSocketConnector = {
      async wsConnect() {
        throw new Error('container is not listening in the TCP address 10.0.0.1:8443');
      },
    };
    const res = await handlePreviewWsProxy(
      codeUpgradeRequest(cookie), sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('preview ws upstream unavailable');
  });

  it('🔴 re-asserts Upgrade/Connection so the SDK cannot misroute to its 3000 control plane', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    // Inbound request deliberately WITHOUT the hop-by-hop `Connection` header:
    // `Sandbox.fetch()` only takes its WebSocket branch when it sees both, and
    // otherwise silently falls back to port 3000.
    const request = new Request(`https://${CODE_HOST}/?type=ExtensionHost`, {
      headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}`, upgrade: 'websocket', origin: `https://${CODE_HOST}` },
    });
    await handlePreviewWsProxy(request, sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code');
    expect(sandbox.calls[0]?.headers.upgrade).toBe('websocket');
    expect((sandbox.calls[0]?.headers.connection ?? '').toLowerCase()).toContain('upgrade');
  });

  // ── BUG A ────────────────────────────────────────────────────────────────
  it('🔴 forwards the REAL bridge host for target: code, so the Origin check can pass', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    await handlePreviewWsProxy(
      codeUpgradeRequest(cookie), sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    expect(sandbox.calls[0]?.headers['x-forwarded-host']).toBe(CODE_HOST);
    expect(sandbox.calls[0]?.headers['x-forwarded-host']).not.toBe('preview.local');
  });

  it("🔴 code-server's own ensureOrigin ACCEPTS the headers we forward for the browser's Origin", async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    await handlePreviewWsProxy(
      codeUpgradeRequest(cookie), sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    const forwarded = sandbox.calls[0]!.headers;
    // The document that opens the extension-host socket is served from the
    // bridge host, so this is the Origin the browser really sends.
    expect(() => simulateCodeServerEnsureOrigin(forwarded, `https://${CODE_HOST}`)).not.toThrow();
    // …and it stays a real same-origin check, not a rubber stamp.
    expect(() => simulateCodeServerEnsureOrigin(forwarded, 'https://evil.example')).toThrow(/incorrect origin/);
    // A non-browser client sends no Origin at all; code-server allows that,
    // and the bridge's HMAC cookie gate upstream is what actually stops it.
    expect(() => simulateCodeServerEnsureOrigin(forwarded, null)).not.toThrow();
  });

  it('🔴 the OLD `preview.local` value is provably rejected by that same check', async () => {
    // Reproduces the shipped bug exactly: every origin measured in production
    // (app origin, the bridge's own self-origin, garbage) 403s.
    for (const origin of [`https://${CODE_HOST}`, 'https://ezil-os.vercel.app', 'https://garbage.example']) {
      expect(() => simulateCodeServerEnsureOrigin({ 'x-forwarded-host': 'preview.local' }, origin)).toThrow(
        /incorrect origin/,
      );
    }
  });

  it('keeps `preview.local` for target: app — the dev server never learns the bridge host', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    const request = new Request(`https://${APP_HOST}/preview-ws/`, {
      headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` },
    });
    await handlePreviewWsProxy(request, sandbox, SID, [SECRET], '/');
    expect(sandbox.calls[0]?.headers['x-forwarded-host']).toBe(APP_FORWARDED_HOST);
    expect(sandbox.calls[0]?.headers['x-forwarded-host']).not.toContain(SID);
  });

  it('🔴 drops a client-supplied `Forwarded` header, which outranks x-forwarded-host', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    await handlePreviewWsProxy(
      codeUpgradeRequest(cookie, { forwarded: 'host=attacker.example;proto=https' }),
      sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    const forwarded = sandbox.calls[0]!.headers;
    expect(forwarded.forwarded).toBeUndefined();
    // Left in place it would have chosen the host the origin check compares to.
    expect(() => simulateCodeServerEnsureOrigin(forwarded, `https://${CODE_HOST}`)).not.toThrow();
  });

  it('strips the `ezil_preview` cookie before the container ever sees it', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox();
    await handlePreviewWsProxy(
      codeUpgradeRequest(cookie, { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}; keep=yes` }),
      sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    expect(sandbox.calls[0]?.headers.cookie).toBe('keep=yes');
    expect(sandbox.calls[0]?.headers.cookie).not.toContain(PREVIEW_COOKIE_NAME);
  });

  it('passes a non-upgrade upstream response straight through', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const sandbox = fakeWsSandbox({ upgrade: false });
    const res = await handlePreviewWsProxy(
      codeUpgradeRequest(cookie), sandbox, SID, [SECRET], '/', CODE_PREVIEW_PORT, 'code',
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('not an upgrade');
  });
});

describe('handlePreviewInspectorJs', () => {
  const SECRET = 'test-primary-secret';
  const SID = 'guac-user1-proj1';

  it('returns 401 without a valid cookie', async () => {
    const request = new Request(`https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-inspector.js`);
    const res = await handlePreviewInspectorJs(request, SID, [SECRET]);
    expect(res.status).toBe(401);
  });

  it('serves the inspector script with a valid cookie', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const request = new Request(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-inspector.js`,
      { headers: { cookie: `${PREVIEW_COOKIE_NAME}=${cookie}` } },
    );
    const res = await handlePreviewInspectorJs(request, SID, [SECRET]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
  });

  it('accepts the `ezil_pv` query-param fallback when the cookie is missing', async () => {
    const cookie = await mintPreviewCookie(SECRET, SID);
    const request = new Request(
      `https://${APP_PREVIEW_PORT}-${SID}-${APP_PREVIEW_TOKEN}.ezil.org/preview-inspector.js?${PREVIEW_COOKIE_QUERY_PARAM}=${encodeURIComponent(cookie)}`,
    );
    const res = await handlePreviewInspectorJs(request, SID, [SECRET]);
    expect(res.status).toBe(200);
  });
});

// Script-string harness, like code-billing-bridge.test.ts; no installed DOM dependency in worker/.
class PreviewElement {
  nodeType = 1;
  parentElement: PreviewElement | null = null;
  childNodes: any[] = [];
  hidden = false;
  isContentEditable = false;
  style: Record<string, string> = {};
  rect = { x: 1.4, y: -2.6, width: 120.2, height: 30.8 };
  constructor(public tagName = 'BUTTON', public attrs: Record<string, string> = {}) { this.tagName = tagName.toUpperCase(); }
  get id() { return this.attrs.id ?? ''; }
  get classList() { return (this.attrs.class ?? '').split(/\s+/).filter(Boolean); }
  get previousElementSibling(): PreviewElement | null {
    const siblings = this.parentElement?.childNodes.filter(n => n.nodeType === 1) ?? [];
    return siblings[siblings.indexOf(this) - 1] ?? null;
  }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  hasAttribute(k: string) { return Object.hasOwn(this.attrs, k); }
  getBoundingClientRect() { return this.rect; }
  append(...nodes: Array<PreviewElement | string>) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? { nodeType: 3, textContent: node, parentElement: this } : node;
      child.parentElement = this; this.childNodes.push(child);
    }
    return this;
  }
}
const INSPECTOR_PARENT = 'https://8443-guac-u-c-code.ezil.org', INSPECTOR_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
function inspector(script = previewInspectorScript([INSPECTOR_PARENT]), capture?: (helpers: any) => void, viteClient?: any) {
  let now = 0, counter = 0, mutation: Function = () => {};
  const timers = new Map<number, { at: number; fn: Function }>();
  const messages: any[] = [], winListeners: Record<string, Function[]> = {}, docListeners: Record<string, Function[]> = {};
  const parent = { postMessage(data: any, origin: string) { messages.push({ data: structuredClone(data), origin }); } };
  const window = { parent, innerWidth: 1280, innerHeight: 800, devicePixelRatio: 2, addEventListener(t: string, fn: Function) { (winListeners[t] ??= []).push(fn); } };
  const document = { title: 'Pricing', querySelector: () => viteClient ? { src: '/@vite/client' } : null, addEventListener(t: string, fn: Function) { (docListeners[t] ??= []).push(fn); } };
  const location = new URL('https://3002-guac-u-c-app.ezil.org/preview/pricing?token=private&plan=pro#faq');
  const history = { pushState(_a: unknown, _b: unknown, path: string) { location.href = new URL(path, location).href; },
    replaceState(_a: unknown, _b: unknown, path: string) { location.href = new URL(path, location).href; } };
  const context = { window, document, location, history, URL, URLSearchParams, crypto, Uint8Array, btoa, loadVite: async () => viteClient,
    getComputedStyle: (el: PreviewElement) => ({ ...el.style, getPropertyValue: (k: string) => el.style[k] ?? '' }),
    MutationObserver: class { constructor(fn: Function) { mutation = fn; } observe() {} },
    Date: { now: () => now }, setTimeout: (fn: Function, delay: number) => { timers.set(++counter, { at: now + delay, fn }); return counter; }, capture };
  const globals = Object.keys(context);
  if (viteClient) script = script.replace('import(vite.href)', 'loadVite(vite.href)');
  runInNewContext(capture ? script.replace('const gen=', 'capture({validSelection,sanitizeUrl});const gen=') : script, context);
  expect(Object.keys(context)).toEqual(globals);
  expect(Object.keys(window)).toEqual(['parent', 'innerWidth', 'innerHeight', 'devicePixelRatio', 'addEventListener']);
  const event = (type: string, extra: any = {}, doc = false) => {
    const ev = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of (doc ? docListeners : winListeners)[type] ?? []) fn(ev);
    return ev;
  };
  const message = (data: any, over: any = {}) => event('message', { data, source: parent, origin: INSPECTOR_PARENT, ...over });
  const hello = (nonce = INSPECTOR_NONCE) => message({ type: 'ezil.preview.hello', v: 1, nonce });
  const mode = (mode = 'select', nonce = INSPECTOR_NONCE) => message({ type: 'ezil.preview.mode', v: 1, nonce, mode });
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = until;
  };
  const selects = () => messages.filter(m => m.data.type === 'ezil.preview.select').map(m => m.data.sel);
  return { messages, message, hello, mode, event, advance, selects, history, location, document, mutate: () => mutation() };
}
const previewVectors = JSON.parse(readFileSync(new URL('../../docs/contracts/code-preview-v1.vectors.json', import.meta.url), 'utf8'));

describe('strict preview inspector v1', () => {
  it('requires the parent/origin/nonce handshake, never uses wildcard targets, and ignores selections in interact mode', () => {
    const b = inspector(), el = new PreviewElement().append('Sign up'), hello = { type: 'ezil.preview.hello', v: 1, nonce: INSPECTOR_NONCE };
    for (const over of [{ source: {} }, { origin: 'https://other.test' }, { origin: '*' }, { origin: 'null' }]) b.message(hello, over);
    for (const nonce of ['short', INSPECTOR_NONCE + '\n', 22]) b.message({ ...hello, nonce });
    b.message({ ...hello, extra: true }); b.message({ __ezil: true, type: 'set-select-mode', detail: true });
    b.event('click', { target: el }, true); expect(b.messages).toEqual([]);
    b.hello(); expect(b.messages).toHaveLength(1); expect(b.messages[0].data.type).toBe('ezil.preview.ready');
    expect(b.messages[0].data.doc.gen).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(b.messages[0].data.doc.path).toBe('/pricing?plan=pro#faq');
    b.mode('select', 'BBBBBBBBBBBBBBBBBBBBBB'); b.event('click', { target: el }, true); expect(b.selects()).toEqual([]);
    for (const over of [{ source: {} }, { origin: 'https://other.test' }]) b.message({ type: 'ezil.preview.mode', v: 1, nonce: INSPECTOR_NONCE, mode: 'select' }, over);
    expect(b.event('click', { target: el }, true).defaultPrevented).toBe(false);
    b.mode(); expect(b.event('click', { target: el }, true).defaultPrevented).toBe(true);
    expect(b.selects()[0].el).toMatchObject({ tag: 'button', text: 'Sign up' }); expect(b.selects()[0].el.source).toBeUndefined();
    b.hello('BBBBBBBBBBBBBBBBBBBBBB'); b.mode(); b.event('click', { target: el }, true); expect(b.selects()).toHaveLength(1);
    expect(b.messages.every(m => m.origin === INSPECTOR_PARENT)).toBe(true); expect(previewInspectorScript([INSPECTOR_PARENT])).not.toContain('__ezil');
  });
  it('selects the ordinary target, using data-eid/data-oid only as explicit source metadata', () => {
    const b = inspector(), parent = new PreviewElement('section', { 'data-oid': 'src/page.tsx:12' }), el = new PreviewElement('h1', { id: 'title' }).append('Welcome');
    parent.append(el); b.hello(); b.mode(); b.event('click', { target: el }, true);
    expect(b.selects()[0].el).toMatchObject({ tag: 'h1', id: 'title', source: { eid: 'src/page.tsx:12' }, selector: 'h1#title' });
    expect(b.selects()[0].ancestors).toEqual([{ tag: 'section', classes: [] }]);
    el.attrs['data-eid'] = 'own'; b.event('click', { target: el }, true); expect(b.selects()[1].el.source).toEqual({ eid: 'own' });
  });
  it('supports keyboard and touch while suppressing synthetic duplicate clicks', () => {
    const b = inspector(), el = new PreviewElement().append('Go'); b.hello(); b.mode();
    for (const key of ['Enter', ' ']) expect(b.event('keydown', { key, target: el }, true).defaultPrevented).toBe(true);
    b.event('keydown', { key: 'Escape', target: el }, true); b.event('keydown', { key: 'Enter', repeat: true, target: el }, true);
    b.event('touchend', { target: el }, true); b.event('click', { target: el }, true); expect(b.selects()).toHaveLength(3);
    b.advance(751); b.event('click', { target: el }, true); expect(b.selects()).toHaveLength(4);
  });
  it('never reads/emits field values, editable text, credentials or hidden descendants', () => {
    const b = inspector(); b.hello(); b.mode(); const parent = new PreviewElement('main').append('Visible');
    for (const [tag, attrs] of [['input', {}], ['input', { type: 'password' }], ['textarea', {}], ['select', {}],
      ['div', { contenteditable: '' }], ['span', { autocomplete: 'current-password' }]] as Array<[string, Record<string, string>]>) {
      const field = new PreviewElement(tag, { ...attrs, placeholder: 'private-hint' }).append('private-value');
      Object.defineProperty(field, 'value', { get() { throw Error('value must not be read'); } });
      parent.append(field); b.event('click', { target: field }, true);
      expect(b.selects().at(-1).el.text).toBe(''); expect(b.selects().at(-1).el.attrs.placeholder).toBeUndefined();
      if (tag === 'div') { const child = new PreviewElement('span').append('nested-private'); field.append(child); b.event('click', { target: child }, true); expect(b.selects().at(-1).el.text).toBe(''); }
    }
    const hidden = new PreviewElement('span').append('hidden-private'); hidden.style.display = 'none'; parent.append(hidden);
    b.event('click', { target: parent }, true); expect(b.selects().at(-1).el.text).toBe('Visible');
    expect(JSON.stringify(b.selects())).not.toContain('private-value'); expect(JSON.stringify(b.selects())).not.toContain('private-hint');
  });
  it('bounds records, drops unknown attrs/styles and sanitizes links before truncation', () => {
    const b = inspector(); b.hello(); b.mode(); let root = new PreviewElement('main');
    for (let i = 0; i < 10; i++) { const child = new PreviewElement('section'); root.append(child); root = child; }
    const el = new PreviewElement('a', { id: 'i'.repeat(100), class: Array.from({ length: 20 }, (_, i) => 'c'.repeat(80) + i).join(' '),
      href: 'https://user:pw@cdn.example.com/p?token=private&q=ok', onclick: 'private()', value: 'private', placeholder: 'p'.repeat(220), 'aria-label': 'n'.repeat(150) }).append('word '.repeat(200));
    el.style = { color: 'x'.repeat(150), content: 'private', 'background-image': 'private' }; root.append(el);
    b.event('click', { target: el }, true); const s = b.selects()[0];
    expect(s.el.id).toHaveLength(64); expect(s.el.classes).toHaveLength(12); expect(s.el.classes.every((c: string) => c.length <= 64)).toBe(true);
    expect(s.el.text).toHaveLength(300); expect(s.el.name).toHaveLength(120); expect(s.el.selector.length).toBeLessThanOrEqual(512);
    expect(s.el.styles).toEqual({ color: 'x'.repeat(120) }); expect(s.ancestors).toHaveLength(6);
    expect(s.el.attrs.href).toBe('https://cdn.example.com/p?q=ok'); expect(s.el.attrs.onclick).toBeUndefined(); expect(s.el.attrs.value).toBeUndefined();
    expect(s.el.rect).toEqual({ x: 1, y: -3, w: 120, h: 31 });
    el.attrs.href = 'javascript:alert(1)'; b.event('click', { target: el }, true); expect(b.selects().at(-1).el.attrs.href).toBe('');
  });
  for (const vector of [...previewVectors.sanitizeUrl,
    { in: '/cb#access_token=https://auth.example/?private=1&tab=2', out: '/cb#tab=2' },
    { in: '/cb#Access_Token=private&csrf_token=private&tab=2', out: '/cb#tab=2' },
    { in: '/#/cb?Access_Token=private&csrf_token=private&tab=2', out: '/#/cb?tab=2' },
    { in: '/cb#%61ccess_token=private', out: '/cb' },
    { in: '/cb#', out: '/cb' },
    { in: '/#/cb?', out: '/#/cb' },
  ]) it(`sanitizes URL vector ${vector.in}`, () => {
    let helpers: any; const b = inspector(undefined, h => { helpers = h; }); expect(helpers.sanitizeUrl(vector.in)).toBe(vector.out);
    const el = new PreviewElement('a', { href: vector.in, src: vector.in }); b.hello(); b.mode(); b.event('click', { target: el }, true);
    expect(b.selects()[0].el.attrs).toEqual({ href: vector.out, src: vector.out });
    if (vector.in.startsWith('/')) {
      b.location.href = new URL('/preview' + vector.in, b.location).href;
      b.hello(); expect(b.messages.at(-1).data.doc.path).toBe(vector.out);
      b.mode(); b.event('click', { target: el }, true); expect(b.selects().at(-1).doc.path).toBe(vector.out);
    }
  });
  for (const vector of previewVectors.selection.accept) it(`accepts selection vector: ${vector.name}`, () => {
    let helpers: any; inspector(undefined, h => { helpers = h; }); expect(helpers.validSelection(vector.sel)).toBe(true);
  });
  for (const vector of previewVectors.selection.refuse) it(`refuses selection vector: ${vector.name}`, () => {
    let helpers: any; inspector(undefined, h => { helpers = h; }); const s = structuredClone(previewVectors.selection.accept[0].sel);
    const expand = (value: any): any => {
      const repeat = typeof value === 'string' && /^@repeat:(.):(\d+)$/.exec(value);
      if (repeat) return repeat[1].repeat(Number(repeat[2]));
      if (Array.isArray(value)) return value.map(expand);
      return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v)])) : value;
    };
    for (const [path, raw] of Object.entries(vector.patch ?? {})) {
      const parts = path.split('.'); let target = s; for (const part of parts.slice(0, -1)) target = target[part] ??= {};
      target[parts.at(-1)!] = expand(raw);
    }
    expect(helpers.validSelection(vector.replace ?? s)).toBe(false);
  });
  it('keeps AWS direct paths and escapes selectors without truncating DOM identifiers', () => {
    const b = inspector(); b.location.hostname = 'aws-3002-guac-u-c-aws.ezil.org'; b.location.pathname = '/preview/demo';
    b.hello(); expect(b.messages[0].data.doc.path).toBe('/preview/demo?plan=pro#faq'); b.mode();
    const el = new PreviewElement('button', { id: '123' }); b.event('click', { target: el }, true);
    expect(b.selects()[0].el.selector).toBe('button#\\31 23');
    el.attrs.id = 'i'.repeat(65); b.event('click', { target: el }, true);
    expect(b.selects()[1].el.selector).toBe('button:nth-of-type(1)');
  });
  it('caps huge source ids and trims escaped class-heavy records to the whole-selection limit', () => {
    const b = inspector(); b.hello(); b.mode();
    const classes = Array.from({ length: 100 }, (_, i) => '"'.repeat(64) + i).join(' ');
    let parent = new PreviewElement('main', { class: classes, id: '"'.repeat(64) });
    for (let i = 0; i < 6; i++) { const child = new PreviewElement('section', { class: classes, id: '"'.repeat(64) }); parent.append(child); parent = child; }
    const el = new PreviewElement('button', { class: classes, 'data-eid': '\u0001' + 'e'.repeat(50000) }).append('text '.repeat(100));
    el.style = { color: '"'.repeat(120), 'font-family': '"'.repeat(120), margin: '"'.repeat(120), padding: '"'.repeat(120) };
    parent.append(el); b.event('click', { target: el }, true);
    expect(b.selects()).toHaveLength(1); const sel = b.selects()[0];
    expect(sel.el.source.eid).toBe('e'.repeat(200));
    expect(sel.el.classes).toHaveLength(12); expect(sel.el.classes.every((c: string) => c.length <= 64)).toBe(true);
    expect(JSON.stringify(sel).length).toBeLessThanOrEqual(12000);
    expect(sel.ancestors.length).toBeLessThan(6);
    el.tagName = 'X-' + 'Y'.repeat(12000); b.event('click', { target: el }, true); expect(b.selects()).toHaveLength(1);
  });
  it('refuses oversized selections before traversing their fields', () => {
    let helpers: any; inspector(undefined, h => { helpers = h; });
    const sel = structuredClone(previewVectors.selection.accept[0].sel); sel.el.text = 'x'.repeat(12000);
    Object.defineProperty(sel, 'doc', { enumerable: false, get() { throw Error('must size-check first'); } });
    expect(helpers.validSelection(sel)).toBe(false);
  });
  it('makes hash-only navigation and every other navigation a document revision', () => {
    const b = inspector(); b.hello(); b.mode(); const el = new PreviewElement();
    b.event('click', { target: el }, true); const selected = b.selects()[0].doc;
    b.location.hash = '#new'; b.event('hashchange'); b.advance(300);
    expect(b.messages.at(-1).data.doc).toMatchObject({ gen: selected.gen, mut: selected.mut + 1, path: '/pricing?plan=pro#new' });
    let mut = b.messages.at(-1).data.doc.mut;
    for (const navigate of [() => b.history.pushState({}, '', '#push'), () => b.history.replaceState({}, '', '#replace'), () => b.event('popstate')]) {
      navigate(); b.advance(300); expect(b.messages.at(-1).data.doc.mut).toBe(++mut);
    }
    b.mutate(); b.advance(300); expect(b.messages.at(-1).data.doc.mut).toBe(++mut);
  });
  it('subscribes to the existing Vite client hot event bus without import.meta.hot', async () => {
    let update: Function | undefined;
    const b = inspector(undefined, undefined, { createHotContext: () => ({ on: (name: string, fn: Function) => {
      expect(name).toBe('vite:afterUpdate'); update = fn;
    } }) });
    b.hello(); await Promise.resolve(); await Promise.resolve(); expect(update).toBeDefined();
    update!(); b.advance(50); expect(b.messages.at(-1).data.type).toBe('ezil.preview.changed');
    expect(b.messages.at(-1).data.doc.mut).toBe(1);
  });
  it('tracks document generations, DOM batches and HMR, rate-limiting changed/navigate', () => {
    const b = inspector(); b.mutate(); b.hello(); const gen = b.messages[0].data.doc.gen; expect(b.messages[0].data.doc.mut).toBe(1);
    for (let i = 0; i < 100; i++) b.mutate(); b.event('vite:afterUpdate'); b.event('vite:afterUpdate', {}, true);
    b.advance(50); expect(b.messages.at(-1).data.doc.mut).toBe(103);
    for (let i = 0; i < 100; i++) { b.mutate(); b.history.pushState({}, '', '/next?code=private&q=ok'); b.advance(10); }
    const changed = b.messages.filter(m => m.data.type === 'ezil.preview.changed');
    expect(changed.length).toBeLessThanOrEqual(5); expect(changed.every(m => m.data.doc.gen === gen)).toBe(true);
    expect(b.messages.filter(m => m.data.type === 'ezil.preview.navigate').length).toBeLessThanOrEqual(4);
    b.advance(300); b.history.replaceState({}, '', '/replaced?state=private'); b.advance(300); expect(b.messages.at(-1).data.doc.path).toBe('/replaced');
    for (const type of ['popstate', 'hashchange']) { b.event(type); b.advance(300); expect(b.messages.at(-1).data.type).toBe('ezil.preview.navigate'); }
    const next = inspector(); next.hello(); expect(next.messages[0].data.doc.gen).not.toBe(gen);
  });
  it('computes origins per Cloudflare request', async () => {
    for (const zone of ['ezil.org', 'ezil.work']) {
      const hostname = `3002-guac-u-c-app.${zone}`, origins = previewInspectorOrigins(hostname);
      expect(origins).toEqual([`https://8443-guac-u-c-code.${zone}`, zone === 'ezil.org' ? 'https://os.ezil.work' : 'https://os-staging.ezil.work']);
      const response = await handlePreviewInspectorJs(new Request(`https://${hostname}/preview-inspector.js`), 'guac-u-c', []);
      expect(await response.text()).toBe(previewInspectorScript(origins)); expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    expect(previewInspectorOrigins('8443-guac-u-c-code.ezil.org')).toEqual([]);
  });
  for (const reason of ['no_package_json', 'port_not_listening', 'upstream_error'] as const) it(`diagnostic ${reason} answers state only and keeps meta refresh`, async () => {
    const html = await buildDiagnosticResponse(reason, 3002, undefined, [INSPECTOR_PARENT]).text();
    expect(html).toContain('<meta http-equiv="refresh" content="3">'); expect(html).not.toContain('ezil.preview.ready');
    const b = inspector(/<script>([\s\S]*?)<\/script>/.exec(html)![1]);
    b.message({ type: 'ezil.preview.hello', v: 1, nonce: INSPECTOR_NONCE }, { source: {} });
    b.message({ type: 'ezil.preview.hello', v: 1, nonce: INSPECTOR_NONCE }, { origin: 'https://evil.test' });
    expect(b.messages).toEqual([]); b.hello();
    expect(b.messages).toEqual([{ data: { type: 'ezil.preview.state', v: 1, nonce: INSPECTOR_NONCE, state: reason }, origin: INSPECTOR_PARENT }]);
  });
});
