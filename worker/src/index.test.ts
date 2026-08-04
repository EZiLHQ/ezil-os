/**
 * Package-local tests for the Cloudflare Guacamole/Neko sandbox Worker.
 *
 * Scope (Phase 1 — Neko as an alternate desktopMode, Guacamole default):
 *   - desktopMode validation/default
 *   - deriveSandboxId isolation/ID stability
 *   - selected-service readiness (portFor) — not just open TCP
 *   - missing-TURN fail-closed gate
 *   - URL/hostname normalization for the *.ezil.org preview zone
 *   - HMAC token verification regression (unsigned/expired/malformed/valid)
 *   - Guacamole compatibility (mode omitted/'guacamole' behaves identically
 *     to pre-Neko behavior: port 8080, /guacamole/ readyPath, 'desktop' token)
 *
 * No network/container/Docker calls — pure unit tests against exported
 * helpers. Run with `bun test` (package-local, no root-level gate).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('resolveDesktopMode', () => {
  it('defaults to guacamole when nothing is requested and no env default is set', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    const result = resolveDesktopMode(undefined, undefined);
    expect(result).toEqual({ ok: true, mode: 'guacamole' });
  });

  it('accepts an explicit "guacamole" request', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    expect(resolveDesktopMode('guacamole', undefined)).toEqual({ ok: true, mode: 'guacamole' });
  });

  it('accepts an explicit "neko" request', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    expect(resolveDesktopMode('neko', undefined)).toEqual({ ok: true, mode: 'neko' });
  });

  it('is case-insensitive and trims whitespace', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    expect(resolveDesktopMode(' NEKO ', undefined)).toEqual({ ok: true, mode: 'neko' });
  });

  it('falls back to the env-configured default when the request omits desktopMode', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    expect(resolveDesktopMode(undefined, 'neko')).toEqual({ ok: true, mode: 'neko' });
  });

  it('rejects an unknown mode rather than silently coercing to guacamole', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    const result = resolveDesktopMode('novnc', undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid_desktop_mode');
      expect(result.error).toContain('novnc');
    }
  });

  it('rejects an unknown env default the same way', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    const result = resolveDesktopMode(undefined, 'bogus');
    expect(result.ok).toBe(false);
  });
});

describe('checkIceConfig (TURN fail-closed gate)', () => {
  it('passes in the default diagnostic policy with no TURN configured', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({} as never);
    expect(result).toEqual({ ok: true, policy: 'diagnostic', hasTurn: false });
  });

  it('fails closed when policy=relay and no TURN URLs are configured', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({ SANDBOX_NEKO_ICE_POLICY: 'relay' } as never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('turn_required');
  });

  it('fails closed when policy=production and no TURN URLs are configured', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({ SANDBOX_NEKO_ICE_POLICY: 'production' } as never);
    expect(result.ok).toBe(false);
  });

  it('passes when policy=relay and TURN URLs ARE configured (never asserts a value, only presence)', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({
      SANDBOX_NEKO_ICE_POLICY: 'relay',
      SANDBOX_NEKO_TURN_URLS: 'turns:example.invalid:5349',
    } as never);
    expect(result).toEqual({ ok: true, policy: 'relay', hasTurn: true });
  });

  it('never enables TURN itself — result never contains raw credential fields', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({
      SANDBOX_NEKO_ICE_POLICY: 'relay',
      SANDBOX_NEKO_TURN_URLS: 'turns:example.invalid:5349',
    } as never);
    expect(Object.keys(result)).not.toContain('SANDBOX_NEKO_TURN_URLS');
    expect(JSON.stringify(result)).not.toContain('turns:');
  });
});

describe('checkIceConfig passes when a Cloudflare Realtime TURN key is configured', () => {
  it('treats a TURN key id + api token as a configured relay (presence only)', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({
      SANDBOX_NEKO_ICE_POLICY: 'relay',
      SANDBOX_NEKO_TURN_KEY_ID: 'key-id-123',
      SANDBOX_NEKO_TURN_API_TOKEN: 'redacted-token',
    } as never);
    expect(result).toEqual({ ok: true, policy: 'relay', hasTurn: true });
    expect(JSON.stringify(result)).not.toContain('redacted-token');
  });

  it('fails closed when only a key id (no api token) is present', async () => {
    const { checkIceConfig } = await import('./desktop-mode');
    const result = checkIceConfig({
      SANDBOX_NEKO_ICE_POLICY: 'production',
      SANDBOX_NEKO_TURN_KEY_ID: 'key-id-123',
    } as never);
    expect(result.ok).toBe(false);
  });
});

describe('resolveTurnTtlSeconds (bounded ephemeral TTL)', () => {
  it('defaults to 1800s when unset/invalid', async () => {
    const { resolveTurnTtlSeconds } = await import('./desktop-mode');
    expect(resolveTurnTtlSeconds(undefined)).toBe(1800);
    expect(resolveTurnTtlSeconds('not-a-number')).toBe(1800);
    expect(resolveTurnTtlSeconds('0')).toBe(1800);
  });

  it('clamps to the [300, 1800] window (never outlives the ~30m session)', async () => {
    const { resolveTurnTtlSeconds } = await import('./desktop-mode');
    expect(resolveTurnTtlSeconds('60')).toBe(300);
    expect(resolveTurnTtlSeconds('999999')).toBe(1800);
    expect(resolveTurnTtlSeconds('900')).toBe(900);
  });
});

describe('normalizeIceServers', () => {
  it('wraps a single object and passes arrays through, empty for null', async () => {
    const { normalizeIceServers } = await import('./desktop-mode');
    expect(normalizeIceServers(null)).toEqual([]);
    expect(normalizeIceServers({})).toEqual([]);
    expect(normalizeIceServers({ iceServers: { urls: 'turn:x:3478' } })).toEqual([{ urls: 'turn:x:3478' }]);
    expect(normalizeIceServers({ iceServers: [{ urls: ['a'] }, { urls: ['b'] }] })).toHaveLength(2);
  });
});

describe('filterBrowserSafeIceServers (drop alternate port :53)', () => {
  it('removes only the :53 URLs and drops emptied entries', async () => {
    const { filterBrowserSafeIceServers } = await import('./desktop-mode');
    const out = filterBrowserSafeIceServers([
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'],
        username: 'u',
        credential: 'c',
      },
      { urls: ['stun:stun.cloudflare.com:53'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].urls).toEqual(['turn:turn.cloudflare.com:3478?transport=udp']);
    expect(out[0].username).toBe('u');
  });
});

describe('buildNekoIceEnv (neko v3 NEKO_WEBRTC_* env, creds via env not argv)', () => {
  it('returns null for an empty server list', async () => {
    const { buildNekoIceEnv } = await import('./desktop-mode');
    expect(buildNekoIceEnv([])).toBeNull();
  });

  it('emits frontend (browser-safe) + backend (full) JSON with icelite off and trickle on', async () => {
    const { buildNekoIceEnv } = await import('./desktop-mode');
    const env = buildNekoIceEnv([
      {
        urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'],
        username: 'u',
        credential: 'c',
      },
    ]);
    expect(env).not.toBeNull();
    expect(env!.NEKO_WEBRTC_ICELITE).toBe('false');
    expect(env!.NEKO_WEBRTC_ICETRICKLE).toBe('true');
    expect(env!.NEKO_WEBRTC_ICESERVERS_FRONTEND).not.toContain(':53');
    expect(env!.NEKO_WEBRTC_ICESERVERS_BACKEND).toContain(':53');
    expect(Array.isArray(JSON.parse(env!.NEKO_WEBRTC_ICESERVERS_FRONTEND))).toBe(true);
    expect(Array.isArray(JSON.parse(env!.NEKO_WEBRTC_ICESERVERS_BACKEND))).toBe(true);
  });
});

describe('turnGenerateUrl (official Cloudflare Realtime endpoint)', () => {
  it('targets the generate-ice-servers path for the given key id', async () => {
    const { turnGenerateUrl } = await import('./desktop-mode');
    expect(turnGenerateUrl('abc123')).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/abc123/credentials/generate-ice-servers',
    );
  });
});

// deriveSandboxId, normalizeSandboxHostname, verifyPreviewToken, and the
// module); their externally observable contracts are covered indirectly via
// resolveDesktopMode/checkIceConfig above and via existing HMAC/S3-config
// package-local tests in this directory (validate-workspace-s3-config.test.ts).
// The following documents the Guacamole-compatibility contract explicitly:
describe('Guacamole compatibility (Phase 1 non-regression)', () => {
  it('desktopMode omitted resolves to the exact same mode as pre-Neko behavior', async () => {
    const { resolveDesktopMode } = await import('./desktop-mode');
    const omitted = resolveDesktopMode(undefined, undefined);
    const explicit = resolveDesktopMode('guacamole', undefined);
    expect(omitted).toEqual(explicit);
  });
});

// The exposePort token doubles as a DNS label in the preview hostname. The SDK
// rejects any token that is not lowercase-alphanumeric-underscore, and a valid
// hostname label further forbids `_`. A hyphenated token (`neko-desktop`) was
// rejected live by exposePort. Guard both modes' tokens against regression.
describe('portFor token is SDK- and hostname-safe (no hyphen/underscore/uppercase)', () => {
  it('guacamole and neko tokens are lowercase-alphanumeric only', async () => {
    const { portFor } = await import('./desktop-mode');
    for (const mode of ['guacamole', 'neko'] as const) {
      const { token, port } = portFor(mode);
      expect(token).toMatch(/^[a-z0-9]+$/);
      expect(port).toBe(mode === 'neko' ? 8181 : 8080);
    }
    expect(portFor('neko').token).toBe('nekodesktop');
    expect(portFor('guacamole').token).toBe('desktop');
  });
});

// ── Workspace diagnostic slot contract ────────────────────────────────────────
// The diag endpoint proves (1) deterministic R2 persistence and (2) A/B/C
// isolation. Its pure logic (slot allowlist + deterministic marker) lives in
// ./workspace-diag so it can be unit-tested without the Workers runtime.
describe('workspace-diag: deterministic marker content', () => {
  it('is a pure function of the slot name only (no sandbox id / no clock / no entropy)', async () => {
    const { diagMarkerContent } = await import('./workspace-diag');
    const a = diagMarkerContent('alpha');
    const b = diagMarkerContent('alpha');
    expect(a).toBe(b); // stable across calls (no Date.now / no random)
    expect(a).toBe('ezil-workspace-diag;slot=alpha;v=1');
    expect(diagMarkerContent('beta')).not.toBe(a); // slot-scoped
  });

  it('same slot yields the same SHA-256 (basis for the persistence roundtrip assertion)', async () => {
    const { diagMarkerContent } = await import('./workspace-diag');
    const content = diagMarkerContent('persist');
    const digest = async (s: string) => {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
      return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    expect(await digest(content)).toBe(await digest(diagMarkerContent('persist')));
  });

  it('contains no secrets/credentials/user data', async () => {
    const { diagMarkerContent } = await import('./workspace-diag');
    const content = diagMarkerContent('x');
    expect(content).not.toMatch(/secret|token|key|password/i);
  });
});

describe('workspace-diag: parseDiagRequest (op + slot allowlist)', () => {
  it('defaults op to "ensure" (idempotent write) and slot to "default"', async () => {
    const { parseDiagRequest } = await import('./workspace-diag');
    const r = parseDiagRequest(undefined, undefined);
    expect(r).toEqual({ ok: true, op: 'ensure', slot: 'default', write: true });
  });

  it('marks write vs read-only ops correctly', async () => {
    const { parseDiagRequest } = await import('./workspace-diag');
    for (const op of ['write', 'ensure']) {
      const r = parseDiagRequest(op, 's');
      expect(r.ok && r.write).toBe(true);
    }
    for (const op of ['stat', 'read', 'absent']) {
      const r = parseDiagRequest(op, 's');
      expect(r.ok && r.write).toBe(false);
    }
  });

  it('lowercases and accepts allowlisted slot names', async () => {
    const { parseDiagRequest } = await import('./workspace-diag');
    const r = parseDiagRequest('STAT', 'Marker.A-1_b');
    expect(r).toEqual({ ok: true, op: 'stat', slot: 'marker.a-1_b', write: false });
  });

  it('rejects an unknown op rather than silently coercing', async () => {
    const { parseDiagRequest } = await import('./workspace-diag');
    const r = parseDiagRequest('delete', 's');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('diag_invalid_op');
  });

  it('rejects path traversal / separators / shell metacharacters in the slot', async () => {
    const { parseDiagRequest } = await import('./workspace-diag');
    for (const bad of ['../escape', 'a/b', '.hidden', "x';rm -rf /", 'has space', '', 'x'.repeat(65)]) {
      const r = parseDiagRequest('write', bad);
      expect(r.ok, `slot ${JSON.stringify(bad)} must be rejected`).toBe(false);
      if (!r.ok) expect(r.error).toContain('diag_invalid_slot');
    }
  });

  it('maps slots to a deterministic hidden file at the mount root (no mkdir needed)', async () => {
    const { DIAG_SLOT_PREFIX, diagSlotFile } = await import('./workspace-diag');
    // Hidden (leading dot), fixed prefix, no path separator → resolves to
    // exactly one file directly under the writable mount root, so the R2 FUSE
    // mount never has to `mkdir` (which it rejects with EPERM on fresh mounts).
    expect(DIAG_SLOT_PREFIX).toBe('.ezil-diag-');
    expect(diagSlotFile('default')).toBe('.ezil-diag-default');
    expect(diagSlotFile('marker.a-1_b')).toBe('.ezil-diag-marker.a-1_b');
    expect(diagSlotFile('x')).not.toContain('/');
  });
});

describe('workspace-diag: diagDisabled kill-switch (non-secret, enabled by default)', () => {
  it('is enabled (not disabled) when the flag is unset/empty', async () => {
    const { diagDisabled } = await import('./workspace-diag');
    expect(diagDisabled(undefined)).toBe(false);
    expect(diagDisabled('')).toBe(false);
    expect(diagDisabled('on')).toBe(false);
    expect(diagDisabled('true')).toBe(false);
  });

  it('disables on off/false/0/disabled/no (case/space-insensitive)', async () => {
    const { diagDisabled } = await import('./workspace-diag');
    for (const v of ['off', 'FALSE', ' 0 ', 'Disabled', 'no']) {
      expect(diagDisabled(v)).toBe(true);
    }
  });
});

// ── Optional mission-signing HMAC alias ───────────────────────────────────────
// Proves the additive alias contract: the primary/compatibility secret is
// authoritative and unchanged; the optional SANDBOX_MISSION_HMAC_SECRET is
// accepted ONLY when present (never required, never a replacement); invalid
// signatures still fail; freshness/canonicalization are preserved; and no
// secret material is ever surfaced in the verification result.
describe('HMAC mission-alias: resolvePreviewSecrets', () => {
  it('returns only the primary secret when no mission alias is bound', async () => {
    const { resolvePreviewSecrets } = await import('./hmac');
    expect(resolvePreviewSecrets({ SANDBOX_HMAC_SECRET: 'primary' })).toEqual(['primary']);
    expect(resolvePreviewSecrets({ CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'compat' })).toEqual([
      'compat',
    ]);
  });

  it('appends the mission alias only when present (absence changes nothing)', async () => {
    const { resolvePreviewSecrets } = await import('./hmac');
    expect(
      resolvePreviewSecrets({ SANDBOX_HMAC_SECRET: 'primary', SANDBOX_MISSION_HMAC_SECRET: 'mission' }),
    ).toEqual(['primary', 'mission']);
    // Primary stays first/authoritative; a blank alias is ignored (never
    // accidentally disables verification or reorders precedence).
    expect(
      resolvePreviewSecrets({ SANDBOX_HMAC_SECRET: 'primary', SANDBOX_MISSION_HMAC_SECRET: '   ' }),
    ).toEqual(['primary']);
  });

  it('never lets the mission alias alone act as primary (empty set stays empty)', async () => {
    const { resolvePreviewSecrets } = await import('./hmac');
    // With no primary at all the worker is in local-dev mode; a mission alias is
    // still surfaced, but it can only ever be additive, never a stand-in for a
    // configured primary secret in production (primary is always index 0 there).
    expect(resolvePreviewSecrets({ SANDBOX_MISSION_HMAC_SECRET: 'mission' })).toEqual(['mission']);
    expect(resolvePreviewSecrets({})).toEqual([]);
  });
});

describe('HMAC mission-alias: verifyPreviewToken', () => {
  const mint = async (secret: string, ts = Date.now()) => {
    const { hmacSha256Hex, PREVIEW_TOKEN_PAYLOAD } = await import('./hmac');
    const sig = await hmacSha256Hex(secret, PREVIEW_TOKEN_PAYLOAD(ts));
    return `t=${ts},v1=${sig}`;
  };

  it('accepts a signature from the PRIMARY secret (non-regression)', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({ SANDBOX_HMAC_SECRET: 'primary' });
    const token = await mint('primary');
    expect(await verifyPreviewToken(token, secrets)).toEqual({ ok: true });
  });

  it('still accepts the PRIMARY signature when the mission alias is ALSO present', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({
      SANDBOX_HMAC_SECRET: 'primary',
      SANDBOX_MISSION_HMAC_SECRET: 'mission',
    });
    const token = await mint('primary');
    expect(await verifyPreviewToken(token, secrets)).toEqual({ ok: true });
  });

  it('accepts a signature from the optional MISSION secret when it is present', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({
      SANDBOX_HMAC_SECRET: 'primary',
      SANDBOX_MISSION_HMAC_SECRET: 'mission',
    });
    const token = await mint('mission');
    expect(await verifyPreviewToken(token, secrets)).toEqual({ ok: true });
  });

  it('REJECTS a mission-signed token when the mission alias is ABSENT (no effect)', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({ SANDBOX_HMAC_SECRET: 'primary' });
    const token = await mint('mission');
    const res = await verifyPreviewToken(token, secrets);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('hmac_signature_mismatch');
  });

  it('rejects a signature from an unrelated/invalid secret even with the alias present', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({
      SANDBOX_HMAC_SECRET: 'primary',
      SANDBOX_MISSION_HMAC_SECRET: 'mission',
    });
    const token = await mint('attacker');
    const res = await verifyPreviewToken(token, secrets);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('hmac_signature_mismatch');
  });

  it('preserves token freshness (expired timestamp fails before signature check)', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({
      SANDBOX_HMAC_SECRET: 'primary',
      SANDBOX_MISSION_HMAC_SECRET: 'mission',
    });
    const stale = Date.now() - 10 * 60 * 1000; // well past the 5-min window
    const token = await mint('mission', stale);
    const res = await verifyPreviewToken(token, secrets);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('hmac_token_expired');
  });

  it('rejects unsigned/malformed requests when any secret is configured', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({
      SANDBOX_HMAC_SECRET: 'primary',
      SANDBOX_MISSION_HMAC_SECRET: 'mission',
    });
    const unsigned = await verifyPreviewToken(undefined, secrets);
    expect(unsigned.ok).toBe(false);
    if (!unsigned.ok) expect(unsigned.error).toContain('hmac_required');
    const malformed = await verifyPreviewToken('not-a-token', secrets);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error).toBe('hmac_malformed_token');
  });

  it('never leaks secret material in the verification result', async () => {
    const { verifyPreviewToken, resolvePreviewSecrets } = await import('./hmac');
    const secrets = resolvePreviewSecrets({
      SANDBOX_HMAC_SECRET: 'primary-secret-value',
      SANDBOX_MISSION_HMAC_SECRET: 'mission-secret-value',
    });
    const results = [
      await verifyPreviewToken(await mint('mission-secret-value'), secrets),
      await verifyPreviewToken(await mint('attacker'), secrets),
    ];
    for (const r of results) {
      const serialized = JSON.stringify(r);
      expect(serialized).not.toContain('primary-secret-value');
      expect(serialized).not.toContain('mission-secret-value');
    }
  });
});

// ── Wave 4B2A: sealed workspace-startup delivery is env-only, neko-only ───────
// The sealed delivery carries a short-lived capability + nonce, so it MUST reach
// the container startup ENVIRONMENT (`EZIL_WORKSPACE_STARTUP_DELIVERY`) and
// NEVER be interpolated into the `startProcess` command string / argv (where it
// would show up in a process listing). These are static source assertions on
// `ensureDesktop` — cheap, deterministic guards against a regression that would
// move the value onto the command line or drop the neko-only gate.
describe('sealed workspace-startup delivery — env-not-argv contract', () => {
  it('forwards the delivery only through the startProcess env, never the command string', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();

    // The env key exists and is set from the delivery inside an env object.
    expect(src).toContain('EZIL_WORKSPACE_STARTUP_DELIVERY: startupDelivery');
    // ...and is spread into the startProcess `env`, never the command template.
    expect(src).toContain('...startupEnv');

    // The command template passed to startProcess must NOT interpolate the
    // delivery (argv/process-listing exposure). Assert the literal command
    // string carries only DESKTOP_MODE, not the sealed value.
    expect(src).toContain('`DESKTOP_MODE=${mode} bash /usr/local/bin/start-desktop.sh`');
    expect(src).not.toContain('EZIL_WORKSPACE_STARTUP_DELIVERY=${');
    expect(src).not.toContain('${startupDelivery}');
  });

  it('gates the delivery to neko mode both at the call site and inside ensureDesktop', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // Call site only forwards the delivery for neko; guacamole always gets null.
    expect(src).toContain("mode === 'neko' ? (body.startupDelivery ?? null) : null");
    // ensureDesktop double-checks the neko gate before populating the env.
    expect(src).toContain("mode === 'neko' && startupDelivery");
  });

  it('forwards the mounted workspace root only through the startProcess env, never the command string', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();

    // The env key exists and is set from the resolved workspace root inside an env object.
    expect(src).toContain('EZIL_WORKSPACE_ROOT: workspaceRoot');
    // ...and is spread into the startProcess `env`, never the command template.
    expect(src).toContain('...workspaceRootEnv');

    // The command template passed to startProcess must NOT interpolate the
    // workspace root (argv/process-listing exposure).
    expect(src).toContain('`DESKTOP_MODE=${mode} bash /usr/local/bin/start-desktop.sh`');
    expect(src).not.toContain('EZIL_WORKSPACE_ROOT=${');
    expect(src).not.toContain('${workspaceRoot}');
  });

  it('gates the workspace root to neko mode and forwards the call-site mount decision unchanged', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // Call site forwards the mounted path (or null) regardless of mode; ensureDesktop gates it.
    expect(src).toContain('workspace.mounted ? workspace.mountPath ?? null : null');
    // ensureDesktop only populates EZIL_WORKSPACE_ROOT for neko when a root is present.
    expect(src).toContain("mode === 'neko' && workspaceRoot");
    // Neko gate for the sealed delivery remains unchanged alongside the new param.
    expect(src).toContain("mode === 'neko' && startupDelivery");
  });
});

// ── Workspace mount prefix — write/read path parity ─────────────────────────
//
// The whole point of `ensureWorkspaceMount` mounting the R2 workspace bucket
// is that the container sees the SAME objects the write path
// (`ProjectFilesAdapter` / `getProjectBranchScope()` in
// `apps/web/client/src/server/lib/project-files-adapter.ts`) already wrote.
// That write path computes object keys as
// `${projectId}/branches/${branch}/${relativePath}` — no leading slash. The
// `prefix` passed to `mountBucket()` DOES carry a leading slash (a hard
// requirement of `@cloudflare/sandbox`'s own `mountBucket` validation — it
// throws `InvalidMountConfigError` otherwise), but the SDK strips that
// leading slash internally before touching R2, so the ACTUAL R2 key prefix
// used for every list/get/put through the mount still matches the write
// path exactly (see `ensureWorkspaceMount`'s doc comment for the full
// SDK-source citation). These are static source assertions (same style as
// the sealed-delivery/cpu-diag suites above) because `ensureWorkspaceMount`
// calls `sandbox.mountBucket` / `sandbox.exec`, which require the Workers
// runtime and cannot be safely unit tested by importing `./index` directly
// (see `boot.test.ts`).
describe('workspace mount prefix — derived from {projectId, branch}, not sandboxId', () => {
  it('ensureWorkspaceMount takes a {projectId, branch} object, not a bare sandboxId string', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain(
      "{ projectId, branch }: { projectId: string; branch: string },",
    );
  });

  it("computes the default prefix as `/${projectId}/branches/${branch}` (leading slash required by mountBucket's own validation, stripped internally before hitting R2)", async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('config.prefix ?? `/${projectId}/branches/${branch}`');
  });

  it('never falls back to the old sandboxId-derived prefix', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // The pre-fix default that never matched the write path.
    expect(src).not.toContain('config.prefix ?? `/${sandboxId}`');
  });

  it('all three call sites pass an explicit {projectId, branch} object into ensureWorkspaceMount', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const callSites = [...src.matchAll(/ensureWorkspaceMount\(sandbox, env, ([\s\S]{0,120}?)\)/g)];
    expect(callSites.length).toBe(3);
    for (const call of callSites) {
      const args = call[1] ?? '';
      // Every call site supplies both fields — never the bare sandboxId
      // string the old signature took.
      expect(args).toContain('projectId:');
      expect(args).toContain('branch:');
    }
  });

  it('the /sandbox/preview call site sources projectId/branch from the request body, defaulting branch to \'main\' explicitly', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('const workspaceProjectId = scopeId;');
    expect(src).toContain("const workspaceBranch = body.branch?.trim() || 'main';");
  });

  // Regression guard for the cross-tenant prefix hazard: a missing
  // projectId/scopeId used to silently fall back to a globally-shared
  // `'default'` R2 prefix (`/default/branches/<branch>`) — any two callers
  // who both omitted it landed on the exact same workspace. The fallback is
  // now deleted; the request is rejected instead.
  it('no longer falls back to a shared "default" R2 prefix when the scope id is omitted', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).not.toContain("body.projectId ?? 'default'");
    expect(src).not.toContain("const workspaceProjectId = body.projectId ?? 'default';");
  });

  it('rejects a /sandbox/preview request whose scope id (projectId) is missing/blank with a 400, before deriving any sandbox identity', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('const scopeId = body.projectId?.trim();');
    expect(src).toContain("if (!scopeId) {");
    expect(src).toContain("return json({ ok: false, error: 'missing_project_id' }, 400);");
    // The rejection must happen BEFORE sandboxId derivation / workspace mount,
    // not after — it should structurally precede both in the source.
    const rejectIdx = src.indexOf("return json({ ok: false, error: 'missing_project_id' }, 400);");
    const deriveIdx = src.indexOf('const sandboxId = deriveSandboxId(');
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeLessThan(deriveIdx);
  });
});

// ── R2 hydrate/flush replaces mountBucket() for the r2-binding path ─────────
//
// `ensureWorkspaceMount` / `ensureWorkspaceHydratedFromR2` / `EzilSandboxDO`
// call `@cloudflare/sandbox` (`sandbox.exec`, `sandbox.mountBucket`,
// `sandbox.writeFile`, DO `schedule()`, ...), which require the Workers
// runtime and cannot be safely unit tested by importing `./index` directly
// (see `boot.test.ts` and the "workspace mount prefix" suite's own doc
// comment above). These are static source assertions in the same style —
// the actual hydrate/flush LOGIC (diffing, ignore list, no-delete guarantee,
// pagination, the empty-prefix template-seed decision inputs) is unit
// tested directly against in-memory fakes in `./workspace-persist.test.ts`
// and `./workspace-seed.test.ts`.
describe('R2-binding workspace persistence: mountBucket() replaced by hydrate/flush', () => {
  it('the r2-binding branch of ensureWorkspaceMount no longer calls sandbox.mountBucket()', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const r2BranchMatch = src.match(
      /if \(config\.mode === 'r2-binding'\) \{[\s\S]*?\n {2}\}\n\n {2}\/\/ ── Generic S3-compatible fallback/,
    );
    expect(r2BranchMatch).not.toBeNull();
    expect(r2BranchMatch![0]).not.toContain('sandbox.mountBucket');
    expect(r2BranchMatch![0]).toContain('ensureWorkspaceHydratedFromR2');
  });

  it('the generic (non-R2) S3-compatible fallback branch is left mounting via s3fs, deliberately unchanged', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // Exactly one remaining `sandbox.mountBucket` CALL site (not doc-comment
    // mentions) — the s3 fallback.
    expect((src.match(/await sandbox\.mountBucket\(/g) ?? []).length).toBe(1);
  });

  it('empty prefix still template-seeds via the unchanged atomic sentinel (seedWorkspaceIfAbsent), not a fresh mechanism', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('if (initiallyEmpty) {');
    expect(src).toContain('const seedOutcome = await seedWorkspaceIfAbsent({');
    // The template copy itself stays a pure local-disk `cp -a` — it was
    // never mount-dependent, so it is untouched by the hydrate/flush rewrite.
    // The exact shell command now lives in `buildTemplateCopyCommand()`
    // (`./workspace-seed`) so the missing-template case can be detected and
    // logged loudly instead of silently swallowed by `|| true`.
    expect(src).toContain('await sandbox.exec(buildTemplateCopyCommand(mountPath));');
    expect(src).toContain('templateWasMissing(result.stdout)');
  });

  it('falls through to a real hydrateWorkspaceFromR2 pass whenever the atomic seed did not seed (lost race / not empty / list failed / etc.)', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('if (!hydrateOk) {');
    expect(src).toContain('const outcome = await hydrateWorkspaceFromR2({');
  });

  it('every hydrate attempt (success or failure) is recorded via recordHydrationOutcome — the flush gate', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // Called unconditionally at the end of ensureWorkspaceHydratedFromR2 —
    // not only inside the `if (hydrateOk)` branch — so a failed re-hydrate
    // correctly flips the DO-storage hydrated flag back off.
    expect(src).toContain('await recordHydrationOutcome(sandbox, realPrefix, mountPath, hydrateOk);');
  });

  // ── GAP (T30): the Turbopack root fix must reach an EXISTING workspace too ──
  //
  // `seedWorkspaceIfAbsent`'s template copy above only ever runs when R2 finds
  // the prefix genuinely empty, so it never reaches a real, already-hydrated
  // computer. `buildEnsureTurbopackConfigCommand`'s own shell logic is
  // exercised for real (real bash, real filesystem, all safety rules
  // mutation-proven) in `workspace-seed.test.ts` — these assertions pin only
  // that `ensureWorkspaceHydratedFromR2` actually WIRES it in, unconditionally,
  // inside the `if (hydrateOk)` block, so both the seeded-new-workspace path
  // and the hydrated-existing-workspace path both reach it.
  it('runs buildEnsureTurbopackConfigCommand unconditionally inside `if (hydrateOk)`, covering BOTH the seed and hydrate-existing paths', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const hydrateOkMatch = src.match(/if \(hydrateOk\) \{[\s\S]*?\n {2}\}\n\n {2}await recordHydrationOutcome/);
    expect(hydrateOkMatch).not.toBeNull();
    const body = hydrateOkMatch![0];
    expect(body).toContain('await sandbox.exec(buildEnsureTurbopackConfigCommand(mountPath));');
    expect(body).toContain('parseTurbopackConfigOutcome(turbopackResult.stdout)');
  });

  it('EzilSandboxDO is exported as `Sandbox` (same DO binding name — zero wrangler.toml changes) and uses schedule(), not alarm()', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('export { EzilSandboxDO as Sandbox };');
    // The callback name is a single constant so `schedule()` and
    // `deleteSchedules()` can never drift apart (a mismatch would leave the
    // resurrection-causing schedule row uncancelled — see WORKSPACE_TERMINATED_KEY).
    expect(src).toContain("const WORKSPACE_FLUSH_CALLBACK = 'flushWorkspaceScheduled';");
    expect(src).toContain('this.schedule(WORKSPACE_FLUSH_INTERVAL_SECONDS, WORKSPACE_FLUSH_CALLBACK)');
    expect(src).toContain('this.deleteSchedules(WORKSPACE_FLUSH_CALLBACK);');
    // Must NOT override the SDK's reserved `alarm()` container-keepalive hook.
    expect(src).not.toMatch(/class EzilSandboxDO[\s\S]*?\basync alarm\s*\(/);
  });

  it('flush is invoked explicitly before the preview response, and before destroy inside terminateSandbox', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // handlePreview's pre-handoff flush is still a Worker-side RPC.
    expect(src).toContain('await sandbox.flushWorkspaceNow();');
    const callSites = [...src.matchAll(/await sandbox\.flushWorkspaceNow\(\);/g)];
    expect(callSites.length).toBe(1); // handlePreview (pre-handoff) only

    // Terminate's pre-destroy flush moved INSIDE the DO (`terminateSandbox`),
    // where `ctx.container.running` is readable, and is now conditional on a
    // container actually being up: flushing a sleeping sandbox would cold-boot
    // it (~20s) purely in order to kill it again.
    const terminateBody = src.match(/async terminateSandbox\(\)[\s\S]*?\n  \}/)?.[0] ?? '';
    expect(terminateBody).not.toBe('');
    expect(terminateBody).toContain('const wasRunning = this.containerIsRunning();');
    expect(terminateBody).toContain('if (wasRunning) {');
    expect(terminateBody).toContain("await this.runWorkspaceFlush('explicit');");
    // …and the flush must come BEFORE destroy, not after.
    expect(terminateBody.indexOf("await this.runWorkspaceFlush('explicit');")).toBeLessThan(
      terminateBody.indexOf('await super.destroy();'),
    );
  });

  it('the flush interval is 10 seconds', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('const WORKSPACE_FLUSH_INTERVAL_SECONDS = 10;');
  });
});

// ── /sandbox/preview request contract — `branch` ────────────────────────────
describe('PreviewBody request contract carries `branch`', () => {
  it('declares an optional `branch` field alongside `projectId`', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const bodyMatch = src.match(/interface PreviewBody \{[\s\S]*?\n\}/);
    expect(bodyMatch).not.toBeNull();
    const bodySrc = bodyMatch?.[0] ?? '';
    expect(bodySrc).toContain('projectId?: string;');
    expect(bodySrc).toContain('branch?: string;');
  });
});

// ── CPU-saturation diagnostic wiring — flag forwarding + retrieval route ────
//
// The pure command-building/parsing/flag-normalization logic lives in
// `./cpu-diag` and is unit-tested there (`cpu-diag.test.ts`). These tests
// prove the two things a pure-function suite cannot: (1) the Worker-side flag
// is actually threaded from `Env` through `ensureDesktop` into the container
// process env ONLY when explicitly enabled (env-not-argv, mode-gated, default
// OFF — mirrors the sealed workspace-startup delivery tests above), and (2)
// the retrieval route is actually registered and reuses the exact same HMAC
// envelope (`verifyPreviewToken` + `resolvePreviewSecrets`) as
// `workspace-diag`/`twen` — so it inherits the shared HMAC suite's
// required/malformed/expired/mismatch coverage, exactly like `twen.test.ts`
// documents for the Twen route.
describe('cpu-diag: flag forwarded only when set', () => {
  it('Env carries EZIL_NEKO_CPU_DIAG_ENABLED as a non-secret, optional string (default OFF)', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('EZIL_NEKO_CPU_DIAG_ENABLED?: string;');
  });

  it('ensureDesktop accepts the flag and normalizes it via cpuDiagFlagEnabled before forwarding', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('cpuDiagFlag: string | undefined = undefined,');
    expect(src).toContain(
      "mode === 'neko' && cpuDiagFlagEnabled(cpuDiagFlag) ? { EZIL_NEKO_CPU_DIAG_ENABLED: '1' } : {}",
    );
  });

  it('is merged into startProcess env alongside the other opt-in envs, never the command string', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('...workspaceRootEnv, ...cpuDiagEnv');
    // Same command-template guard as the sealed-delivery tests: no interpolation leak.
    expect(src).toContain('`DESKTOP_MODE=${mode} bash /usr/local/bin/start-desktop.sh`');
    expect(src).not.toContain('EZIL_NEKO_CPU_DIAG_ENABLED=${');
  });

  it('the /sandbox/preview call site forwards env.EZIL_NEKO_CPU_DIAG_ENABLED (only set when the Worker var/secret is set)', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('env.EZIL_NEKO_CPU_DIAG_ENABLED,');
  });
});

describe('cpu-diag: retrieval route (HMAC-authed, bounded, degrades cleanly)', () => {
  it('registers POST /sandbox/:name/cpu-diag behind the SANDBOX_CPU_DIAG kill-switch', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain(String.raw`/^\/sandbox\/([^/]+)\/cpu-diag$/`);
    expect(src).toContain('cpuDiagRouteDisabled(env.SANDBOX_CPU_DIAG)');
    expect(src).toContain("json({ ok: false, error: 'cpu_diag_disabled' }, 404)");
  });

  it('handleCpuDiag reuses the exact preview-token HMAC envelope (same as workspace-diag/twen)', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const fnMatch = src.match(/async function handleCpuDiag\([\s\S]*?\n}\n/);
    expect(fnMatch).not.toBeNull();
    const fnSrc = fnMatch?.[0] ?? '';
    expect(fnSrc).toContain('verifyPreviewToken(body.token, resolvePreviewSecrets(env))');
    expect(fnSrc).toContain("return json({ ok: false, error: auth.error }, 401);");
  });

  it('returns bounded content read via cpuDiagContentCommand with the resolved maxLines cap', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    expect(src).toContain('const maxLines = resolveCpuDiagMaxLines(body.maxLines);');
    expect(src).toContain('cpuDiagContentCommand(CPU_DIAG_FILE, CPU_DIAG_MAX_BYTES, maxLines)');
    // truncated is derived from BOTH the line cap and the byte ceiling, so a
    // pathologically-long-line file can't silently evade the cap either.
    expect(src).toContain('stat.totalLines > returnedLines || stat.bytes > CPU_DIAG_MAX_BYTES');
  });

  it('degrades cleanly (200, ok:true, exists:false) instead of a 500 when the file is absent', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const fnMatch = src.match(/async function handleCpuDiag\([\s\S]*?\n}\n/);
    const fnSrc = fnMatch?.[0] ?? '';
    expect(fnSrc).toContain('if (!stat.exists) {');
    expect(fnSrc).toContain("ok: true,");
    expect(fnSrc).toContain('exists: false,');
    expect(fnSrc).not.toMatch(/if \(!stat\.exists\) \{[\s\S]{0,400}?, 500\)/);
  });
});


// ── Preview-zone routing drift guard ──────────────────────────────────────────
// `PREVIEW_ZONE_ROOT` in index.ts and the `[[routes]]` block in wrangler.toml
// are two independent statements of the SAME fact: which hostnames this Worker
// answers on. If they disagree, every preview URL the Worker mints points at a
// hostname it is not routed on — the container boots, the desktop starts, and
// the user gets a Cloudflare error page. There is no runtime signal for this;
// the only place it can be caught is here.
//
// The routes are deliberately token-scoped (`*-<token>.<zone>/*`) rather than a
// bare `*.<zone>/*`, so that this Worker shadows no existing hostname on the
// zone (see the rationale block in wrangler.toml). That safety costs one thing:
// a NEW exposed-port token silently stops being routed. The second assertion
// below is what makes that failure loud — it enumerates every token the Worker
// can actually pass to `exposePort` and requires a matching route pattern.
describe('preview zone routing: index.ts and wrangler.toml cannot drift', () => {
  const wranglerSrc = readFileSync(
    fileURLToPath(new URL('../wrangler.toml', import.meta.url)),
    'utf8',
  );
  const indexSrc = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  const zoneRoot = indexSrc.match(/^const PREVIEW_ZONE_ROOT = '([^']+)';$/m)?.[1];
  // Only uncommented `pattern = "..."` lines count — a commented-out route
  // routes nothing.
  const patterns = wranglerSrc
    .split('\n')
    .filter((line) => /^\s*pattern\s*=/.test(line))
    .map((line) => line.match(/"([^"]+)"/)?.[1] ?? '');

  // The feature CAN be put into a deliberate, fully-off state (no zone
  // verified safe to route sandbox previews on) by adding a
  // `PREVIEW_ROUTES_DISABLED` marker string to wrangler.toml and dropping
  // every `[[routes]]` entry — see git history (2026-07-31, pre-ezil.org
  // rollout) for what that looked like when `ezil.work` had to be unwound and
  // no replacement zone was yet approved. As of the 2026-07-31 ezil.org
  // rollout, three narrow, owner-approved, token-scoped routes are live (see
  // wrangler.toml's rationale comment), so this marker is absent and
  // `routesDisabled` below is `false` — the assertions past this point
  // require full route + token coverage, not the disabled short-circuit.
  const routesDisabled = /PREVIEW_ROUTES_DISABLED/.test(wranglerSrc);

  it('is NOT in the disabled state (real ezil.org routes are live)', () => {
    expect(routesDisabled).toBe(false);
    expect(zoneRoot).toBe('ezil.org');
  });

  it('declares exactly the owner-approved narrow suffix routes on ezil.org — no more, no fewer', () => {
    // Was a hardcoded three-element literal; now DERIVED from the tokens
    // `desktop-mode.ts` can actually mint, so adding a fourth exposed port
    // (the `code` bridge) updates both sides of this guard at once instead of
    // requiring two edits that can drift apart. Both directions still fail
    // loudly: a token with no route (silent 404 in production) and a route
    // with no token (a stale binding this Worker no longer serves).
    expect(new Set(patterns)).toEqual(
      new Set(['*-app.ezil.org/*', '*-desktop.ezil.org/*', '*-nekodesktop.ezil.org/*', '*-code.ezil.org/*']),
    );
    // Never the bare zone wildcard — that would shadow `sandbox.ezil.org` /
    // `neko.ezil.org` (and everything else on the zone), which is exactly the
    // production-takeover this whole narrow-suffix design avoids.
    expect(patterns).not.toContain('*.ezil.org/*');
  });

  it('routes NOTHING this Worker cannot mint (no stale/orphan route bindings)', async () => {
    if (routesDisabled) return;
    const { portFor, appPortFor, codePortFor } = await import('./desktop-mode');
    const tokens = new Set(
      [portFor('guacamole').token, portFor('neko').token, appPortFor('neko')?.token, codePortFor('neko')?.token].filter(
        (t): t is string => typeof t === 'string',
      ),
    );
    for (const pattern of patterns) {
      const token = /^\*-([a-z0-9]+)\./.exec(pattern)?.[1];
      expect(token, `route "${pattern}" is not a token-scoped narrow suffix route`).toBeTruthy();
      expect(tokens.has(token!), `route "${pattern}" binds a token this Worker never mints`).toBe(true);
    }
  });

  it('declares PREVIEW_ZONE_ROOT as a literal (not a template/env lookup)', () => {
    expect(zoneRoot).toBeTruthy();
    // A .workers.dev host makes the SDK throw CustomDomainRequiredError, which
    // is the exact failure this whole route change exists to fix.
    expect(zoneRoot?.endsWith('.workers.dev')).toBe(false);
  });

  it('has at least one enabled route, and every route is on PREVIEW_ZONE_ROOT — unless explicitly disabled', () => {
    if (routesDisabled) {
      // Disabled means NOTHING is declared — a partial route list with the
      // marker still present would be a silent half-broken state, not a
      // clean "off".
      expect(patterns.length).toBe(0);
      return;
    }
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      const host = pattern.split('/')[0];
      expect(
        host === zoneRoot || host.endsWith(`.${zoneRoot}`),
        `route "${pattern}" is not under PREVIEW_ZONE_ROOT "${zoneRoot}"`,
      ).toBe(true);
    }
  });

  it('routes every preview hostname the Worker can mint (token coverage) — unless explicitly disabled', async () => {
    if (routesDisabled) return; // no routes declared at all; nothing to cover yet.
    const { portFor, appPortFor, codePortFor } = await import('./desktop-mode');
    const tokens = [
      portFor('guacamole').token,
      portFor('neko').token,
      appPortFor('neko')?.token,
      // `codePortFor` (code-server bridge, `./preview-bridge.ts`'s
      // `parseBridgeHost` target: 'code') is the newest exposed-port token —
      // exactly the case this guard exists to catch: a NEW token with no
      // matching wrangler.toml route silently 404s in production instead of
      // failing the build. If this assertion fails on `code`, the fix is to
      // add `[[routes]] pattern = "*-code.ezil.org/*"` / `zone_name =
      // "ezil.org"` to wrangler.toml — NOT to relax the guard.
      codePortFor('neko')?.token,
    ].filter((t): t is string => typeof t === 'string');

    for (const token of tokens) {
      // A preview host is `<port>-<sandboxId>-<token>.<zone>`; a route covers it
      // if it is the bare zone wildcard or the token-scoped wildcard.
      const covered = patterns.some(
        (p) => p === `*.${zoneRoot}/*` || p === `*-${token}.${zoneRoot}/*`,
      );
      expect(covered, `no wrangler.toml route covers preview token "${token}"`).toBe(true);
    }
  });

  it('keeps every preview host ONE label under the zone (Universal SSL limit)', () => {
    // Universal SSL on a Free zone covers exactly [apex, *.apex]. A nested
    // wildcard has no certificate (verified live: SNI for `a.b.<zone>` fails
    // with TLS alert 40), so the collapse in normalizeSandboxHostname must
    // return the BARE zone root, never a subdomain of it.
    const fn = indexSrc.match(/function normalizeSandboxHostname\([\s\S]*?\n}\n/)?.[0] ?? '';
    expect(fn).toContain('hostname.endsWith(`.${PREVIEW_ZONE_ROOT}`)');
    expect(fn).toContain('return port ? `${PREVIEW_ZONE_ROOT}:${port}` : PREVIEW_ZONE_ROOT;');
  });
});

// ── /health distinguishing marker ─────────────────────────────────────────────
// The legacy `cf-guacamole-sandbox` script and this Worker (`ezil-os-worker`)
// are two SEPARATE deployed Cloudflare Worker scripts that can both end up
// routed on the same zone. Both return `service: 'cf-guacamole-sandbox'` —
// that field is an external contract, carried forward on purpose, so unknown
// consumers matching on it never break. Left alone, that makes the two
// Workers' `/health` responses byte-identical, which makes it impossible to
// tell which one served any given request — the exact thing route-precedence
// verification needs to observe. `build` is the fix: an additive field only
// this Worker sets, never removed without a replacement, that a live curl can
// grep for.
describe('/health distinguishing marker (route-precedence observability)', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');
  const fnMatch = src.match(/if \(method === 'GET' && path === '\/health'\) \{[\s\S]*?\n {4}\}/);
  const fnSrc = fnMatch?.[0] ?? '';

  it('has a /health handler', () => {
    expect(fnMatch).not.toBeNull();
  });

  it('keeps the external `service` contract string unchanged', () => {
    expect(fnSrc).toContain("service: 'cf-guacamole-sandbox'");
  });

  it('adds a `build` marker that distinguishes this Worker from the legacy script', () => {
    expect(fnSrc).toContain("build: 'ezil-os'");
  });
});

// ── Bridge-host generalization (app-preview + code-server) ─────────────────
// `parseAppPreviewHost` -> `parseBridgeHost`, `handleAppPreview` ->
// `handleBridgeHost`. Static source assertions on the wiring
// `route-auth.test.ts` doesn't already cover end to end (no live sandbox
// fixture makes it worth standing up a real container-fetch fake just for
// this), mirroring this file's existing precedent for verifying generated
// code and call-site wiring (see the cpu-diag/sealed-delivery describe
// blocks above).
describe('bridge-host dispatcher: generalized to app-preview AND code-server', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('renamed handleAppPreview -> handleBridgeHost (no dangling old name)', () => {
    expect(src).toContain('async function handleBridgeHost(');
    expect(src).not.toContain('function handleAppPreview(');
  });

  it('resolves `target` from parseBridgeHost and threads `port` into every handler that needs it', () => {
    expect(src).toContain('const route = parseBridgeHost(url.hostname);');
    expect(src).toContain("const { sandboxId, target } = route;");
    expect(src).toContain("const port = target === 'app' ? APP_PREVIEW_PORT : CODE_PREVIEW_PORT;");
    expect(src).toContain('handlePreviewWsProxy(request, sandbox, sandboxId, secrets, appPath, port, target)');
    expect(src).toContain('handlePreviewProxy(request, sandbox, sandboxId, secrets, appPath, port, target)');
  });

  it('threads `target` into the code-bridge WS call too — it selects the forwarded host', () => {
    // `'code'` is what makes `resolveForwardedHost` forward the REAL bridge
    // hostname; with `'app'` (or the old 6-arg call) code-server's WS-router
    // origin check sees `preview.local` and 403s every single upgrade.
    expect(src).toContain(
      "handlePreviewWsProxy(request, sandbox, sandboxId, secrets, codePath, port, 'code')",
    );
  });

  it('gates /preview-status and /preview-inspector.js to target: app only', () => {
    expect(src).toContain("target === 'app' && request.method === 'GET' && path === '/preview-status'");
    expect(src).toContain("target === 'app' && request.method === 'GET' && path === '/preview-inspector.js'");
  });

  it('ensureDesktop best-effort-exposes the code-server port alongside the app-preview port', () => {
    expect(src).toContain('const codePreview = codePortFor(mode);');
    expect(src).toContain('let codePreviewExpose: AppPreviewExposeResult');
    expect(src).toContain('return { url: desktopUrl, appPreviewExpose, codePreviewExpose };');
  });

  it('the fetch() entrypoint call site was renamed too (no dangling `handleAppPreview` call)', () => {
    expect(src).toContain('await handleBridgeHost(request, env, new URL(request.url));');
  });
});

// ── handlePreview returns appPreviewUrl / codePreviewUrl ────────────────────
describe('handlePreview response carries ready-to-embed bridge URLs', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('mints a bootstrap token and builds appPreviewUrl/codePreviewUrl from the exposed bridge URL', () => {
    expect(src).toContain('const appPreviewUrl = await buildBridgeUrl(appPreviewExpose);');
    expect(src).toContain(
      'const codePreviewUrl = await buildBridgeUrl(codePreviewExpose, codePreviewFolderParams(workspace));',
    );
    expect(src).toContain("bridgeUrl.pathname = '/preview-bootstrap';");
    expect(src).toContain("bridgeUrl.searchParams.set('token', bootstrapToken);");
  });

  it('includes both URLs (never omitted, null when not available) in the JSON response', () => {
    expect(src).toContain('appPreviewExpose,\n      codePreviewExpose,\n      appPreviewUrl,\n      codePreviewUrl,');
  });

  it('a mint failure is caught and degrades to null rather than failing the whole /sandbox/preview response', () => {
    const fnMatch = src.match(/const buildBridgeUrl = async[\s\S]*?\n {4}\};/);
    expect(fnMatch).not.toBeNull();
    expect(fnMatch?.[0]).toContain('} catch (err) {');
    expect(fnMatch?.[0]).toContain('return null;');
  });
});

// ── codePreviewFolderParams — the "empty file tree" fix ─────────────────────
//
// GAP: production never sent `folder=` on the code-server bridge URL, so
// code-server's own UI showed "You have no recent folders" (explorerRows: 0)
// no matter how correctly the process itself was launched. Appending
// `&folder=%2Fworkspace` to the SAME bridge URL measured `explorerRows: 11`
// immediately. This is the pure derivation `handlePreview` calls to mint that
// param — real behavioral tests, not a grep, so reverting the guard condition
// (e.g. dropping the `mounted` check, or hardcoding `/workspace`) fails these.
describe('codePreviewFolderParams', () => {
  it('mints `folder` from the REAL workspace.mountPath when the workspace is mounted', async () => {
    const { codePreviewFolderParams } = await import('./index');
    expect(codePreviewFolderParams({ mounted: true, mountPath: '/workspace' })).toEqual({
      folder: '/workspace',
    });
  });

  it('never hardcodes /workspace — whatever resolveWorkspaceMountConfig resolved wins', async () => {
    const { codePreviewFolderParams } = await import('./index');
    expect(codePreviewFolderParams({ mounted: true, mountPath: '/some/other/root' })).toEqual({
      folder: '/some/other/root',
    });
  });

  it('omits folder when the workspace bucket was never mounted (container falls back to its own default root)', async () => {
    const { codePreviewFolderParams } = await import('./index');
    expect(codePreviewFolderParams({ mounted: false, mountPath: '/workspace' })).toBeUndefined();
    expect(codePreviewFolderParams({ mounted: false })).toBeUndefined();
  });

  it('omits folder when mounted is true but mountPath is missing (defensive — should not happen)', async () => {
    const { codePreviewFolderParams } = await import('./index');
    expect(codePreviewFolderParams({ mounted: true })).toBeUndefined();
  });
});

// ── POST /sandbox/:id/focus wiring ──────────────────────────────────────────
// Route-level auth/enum/kill-switch behavior is covered end-to-end in
// `route-auth.test.ts` against the real `fetch()` table; these assertions
// pin the specific wiring choices the brief called out (closed enum, the
// existing `authorizeSignedControlRequest` gate, a kill switch).
describe('POST /sandbox/:id/focus wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('registers the route behind the SANDBOX_FOCUS kill-switch, gated by authorizeSignedControlRequest', () => {
    expect(src).toContain(String.raw`/^\/sandbox\/([^/]+)\/focus$/`);
    expect(src).toContain('focusDisabled(env.SANDBOX_FOCUS)');
    expect(src).toContain("json({ ok: false, error: 'focus_disabled' }, 404)");
    // Same gate DELETE /sandbox/:name uses — no new auth scheme introduced.
    const focusBlock = src.match(/const focusMatch[\s\S]*?\n {4}\}\n/)?.[0] ?? '';
    expect(focusBlock).toContain('await authorizeSignedControlRequest(request, env, url);');
  });

  it('validates `app` through the closed-enum validateFocusApp, never a free string', () => {
    expect(src).toContain('const validated = validateFocusApp(rawApp);');
    expect(src).not.toMatch(/exec\(`\/usr\/local\/bin\/neko-switch-app\.sh \$\{[^}]*rawApp/);
  });

  it('execs the exact neko-switch-app.sh command via buildFocusAppCommand (no raw string interpolation)', () => {
    expect(src).toContain('await sandbox.exec(buildFocusAppCommand(app));');
  });

  it('Env carries SANDBOX_FOCUS as a non-secret, optional string', () => {
    expect(src).toContain('SANDBOX_FOCUS?: string;');
  });
});

// ── POST /telemetry/drain + /telemetry/ack wiring ───────────────────────────
// End-to-end auth/kill-switch/bucket behavior is covered live in
// `route-auth.test.ts` against the real `fetch()` table; these pin the
// specific wiring choices — same HMAC gate as `/focus`, one shared kill
// switch, no bucket call before the gate runs.
describe('POST /telemetry/drain + /telemetry/ack wiring', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('registers both routes behind SANDBOX_TELEMETRY_DRAIN, gated by authorizeSignedControlRequest', () => {
    expect(src).toContain("path === '/telemetry/drain'");
    expect(src).toContain("path === '/telemetry/ack'");
    expect(src).toContain('telemetryDrainDisabled(env.SANDBOX_TELEMETRY_DRAIN)');
    expect(src).toContain("json({ ok: false, error: 'telemetry_drain_disabled' }, 404)");

    const drainBlock = src.match(/if \(method === 'POST' && path === '\/telemetry\/drain'\) \{[\s\S]*?\n {4}\}\n/)?.[0] ?? '';
    expect(drainBlock).toContain('await authorizeSignedControlRequest(request, env, url);');
    const ackBlock = src.match(/if \(method === 'POST' && path === '\/telemetry\/ack'\) \{[\s\S]*?\n {4}\}\n/)?.[0] ?? '';
    expect(ackBlock).toContain('await authorizeSignedControlRequest(request, env, url);');
  });

  it('Env carries SANDBOX_TELEMETRY_DRAIN as a non-secret, optional string', () => {
    expect(src).toContain('SANDBOX_TELEMETRY_DRAIN?: string;');
  });

  it('the ack route validates keys through parseTelemetryAckKeys, never trusting the body\'s keys array raw', () => {
    expect(src).toContain('const keys = parseTelemetryAckKeys(body);');
    expect(src).not.toMatch(/bucket\.delete\(\s*\(body as[^)]*\)\.keys/);
  });
});

// ── Container boot telemetry drain — reaches BOTH the success and failure path ─
//
// The end-to-end SUCCESS case (a full ndjson batch actually landing in a fake
// R2 bucket) is covered live in `route-auth.test.ts`. What is NOT practical to
// drive live through that harness is the FAILURE branch — it requires making
// the fake container's readiness probe genuinely fail, several layers deep in
// `pollDesktopReady`. These are static source assertions (same style as the
// "sealed workspace-startup delivery" block above) pinning that
// `onBootTelemetry` — the callback `drainContainerBootTelemetry`'s result is
// handed to — is invoked from BOTH branches, so a regression that quietly
// drops one of them (e.g. "only call it on success, like `proc.getLogs()`
// used to be failure-only") fails this test immediately.
describe('container boot-telemetry drain reaches ensureDesktop callers on success AND failure', () => {
  const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8');

  it('drains and forwards telemetry on the FAILURE path, before throwing desktop_failed_to_start', () => {
    const failureBlock = src.match(/if \(!ready\) \{[\s\S]*?throw new Error\(`desktop_failed_to_start[\s\S]*?\n {4}\}/)?.[0] ?? '';
    expect(failureBlock).toContain('if (onBootTelemetry) {');
    expect(failureBlock).toContain('onBootTelemetry(await drainContainerBootTelemetry(sandbox));');
    // The drain must never mask the real boot failure — it is wrapped so a
    // drain error cannot suppress the throw two lines below it.
    expect(failureBlock.indexOf('onBootTelemetry(await drainContainerBootTelemetry')).toBeLessThan(
      failureBlock.indexOf('throw new Error(`desktop_failed_to_start'),
    );
  });

  it('drains and forwards telemetry on the SUCCESS path too — not only on failure', () => {
    const successBlock =
      src.match(/bootLog\('ready', 'end', \{ status: 'ok'[\s\S]*?return \{ url: desktopUrl[^}]*\};/)?.[0] ?? '';
    expect(successBlock).toContain('if (onBootTelemetry) {');
    expect(successBlock).toContain('onBootTelemetry(await drainContainerBootTelemetry(sandbox));');
  });

  it('the drain itself is best-effort — reads a bounded tail and never throws on a missing/unreadable file', () => {
    expect(src).toContain('async function drainContainerBootTelemetry(');
    expect(src).toContain("tail -c ${CONTAINER_TELEMETRY_MAX_BYTES} ${CONTAINER_TELEMETRY_PATH} 2>/dev/null || true");
  });

  it('spoolTelemetry never awaits the R2 put on the response path (fire-and-forget via ctx.waitUntil)', () => {
    const fnBlock = src.match(/function spoolTelemetry\([\s\S]*?\n\}/)?.[0] ?? '';
    expect(fnBlock).not.toContain('await bucket.put');
    expect(fnBlock).toContain('ctx?.waitUntil');
  });
});
