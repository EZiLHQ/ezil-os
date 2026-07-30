/**
 * Neko auto-connect credential derivation + wiring tests.
 *
 * Proves the secure Neko auto-connect contract on the Worker side:
 *   - fixed exact per-sandbox user/admin vectors (regression pins)
 *   - user vs admin separation (distinct roles → distinct values)
 *   - sandbox separation (distinct sandboxId → distinct values)
 *   - blank-primary → compatibility (`CLOUDFLARE_GUACAMOLE_HMAC_SECRET`) fallback
 *   - mission alias (`SANDBOX_MISSION_HMAC_SECRET`) is IRRELEVANT to derivation
 *   - keyless local defaults `{ user: 'neko', admin: 'admin' }`
 *   - static source evidence that BOTH the V3 multiuser keys AND the legacy V2
 *     compatibility keys (`NEKO_PASSWORD` / `NEKO_PASSWORD_ADMIN`) merge into
 *     `iceEnv` from the SAME derived values, and that none of the four keys
 *     appear in the process command or the preview response
 *
 * Pure unit tests against exported helpers + static source inspection. No
 * network/container calls. Run with `bun test` (package-local).
 */

import { describe, expect, it } from 'bun:test';

import {
  deriveNekoCredentials,
  resolveNekoDerivationSecret,
  hmacSha256Hex,
} from './hmac';

// Fixed regression vectors — recomputed independently below to guard against a
// silent change to the payload shape / truncation / casing.
const PRIMARY = 'test-primary-secret';
const SID = 'guac-user1-proj1';
const SID2 = 'guac-user2-proj1';

// Vectors captured from HMAC-SHA256(PRIMARY, `ezil-neko:<role>:<sid>:v1`),
// lowercase hex, first 32 chars.
const EXPECT_USER = 'f98620a825e875121c8a416193eb8652';
const EXPECT_ADMIN = '6f3855c3c35296aa8bddd57245152947';
const EXPECT_USER_SID2 = '3c1d9ddc625adc3b36f1057b4c6c47f1';

describe('deriveNekoCredentials — fixed vectors', () => {
  it('derives the exact expected per-sandbox user + admin values', async () => {
    const creds = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    expect(creds.user).toBe(EXPECT_USER);
    expect(creds.admin).toBe(EXPECT_ADMIN);
  });

  it('values are lowercase hex, exactly 32 chars', async () => {
    const creds = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    for (const v of [creds.user, creds.admin]) {
      expect(v).toMatch(/^[0-9a-f]{32}$/);
      expect(v.length).toBe(32);
    }
  });

  it('the vectors are exactly the first 32 hex chars of the full HMAC payload', async () => {
    const fullUser = await hmacSha256Hex(PRIMARY, `ezil-neko:user:${SID}:v1`);
    const fullAdmin = await hmacSha256Hex(PRIMARY, `ezil-neko:admin:${SID}:v1`);
    expect(fullUser.toLowerCase().slice(0, 32)).toBe(EXPECT_USER);
    expect(fullAdmin.toLowerCase().slice(0, 32)).toBe(EXPECT_ADMIN);
  });
});

describe('deriveNekoCredentials — separation properties', () => {
  it('user and admin values differ for the same sandbox', async () => {
    const creds = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    expect(creds.user).not.toBe(creds.admin);
  });

  it('user value differs across distinct sandbox ids', async () => {
    const a = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    const b = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID2);
    expect(a.user).toBe(EXPECT_USER);
    expect(b.user).toBe(EXPECT_USER_SID2);
    expect(a.user).not.toBe(b.user);
    expect(a.admin).not.toBe(b.admin);
  });

  it('is deterministic for the same secret + sandbox', async () => {
    const a = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    const b = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    expect(a).toEqual(b);
  });
});

describe('deriveNekoCredentials — secret resolution', () => {
  it('falls back to CLOUDFLARE_GUACAMOLE_HMAC_SECRET when SANDBOX_HMAC_SECRET is blank', async () => {
    const viaPrimary = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    const viaCompat = await deriveNekoCredentials(
      { SANDBOX_HMAC_SECRET: '   ', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: PRIMARY },
      SID,
    );
    // A blank primary must resolve to the compatibility secret, yielding the
    // exact same vectors as if the primary carried that value.
    expect(viaCompat).toEqual(viaPrimary);
    expect(viaCompat.user).toBe(EXPECT_USER);
  });

  it('nonblank SANDBOX_HMAC_SECRET wins over the compatibility secret', () => {
    expect(
      resolveNekoDerivationSecret({
        SANDBOX_HMAC_SECRET: PRIMARY,
        CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'other',
      }),
    ).toBe(PRIMARY);
  });

  it('the mission alias is IRRELEVANT — it never affects derivation', async () => {
    // Presence/absence of SANDBOX_MISSION_HMAC_SECRET (even set to the primary)
    // must not change the derived values: derivation reads ONLY the primary/
    // compatibility binding.
    const withoutMission = await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: PRIMARY }, SID);
    const withMission = await deriveNekoCredentials(
      // @ts-expect-error — mission alias is intentionally not part of the
      // derivation env type; it must be ignored even if passed at runtime.
      { SANDBOX_HMAC_SECRET: PRIMARY, SANDBOX_MISSION_HMAC_SECRET: 'mission-throwaway' },
      SID,
    );
    expect(withMission).toEqual(withoutMission);

    // With ONLY a mission alias configured (no primary/compat), derivation must
    // fall back to local defaults — the mission key can never seed credentials.
    const onlyMission = await deriveNekoCredentials(
      // @ts-expect-error — see above.
      { SANDBOX_MISSION_HMAC_SECRET: 'mission-throwaway' },
      SID,
    );
    expect(onlyMission).toEqual({ user: 'neko', admin: 'admin' });
  });
});

describe('deriveNekoCredentials — keyless local defaults', () => {
  it('preserves Neko local defaults when no primary/compat secret is set', async () => {
    expect(await deriveNekoCredentials({}, SID)).toEqual({ user: 'neko', admin: 'admin' });
    expect(
      await deriveNekoCredentials({ SANDBOX_HMAC_SECRET: '', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: '  ' }, SID),
    ).toEqual({ user: 'neko', admin: 'admin' });
    expect(resolveNekoDerivationSecret({})).toBeNull();
  });
});

describe('index.ts wiring — static source evidence', () => {
  it('merges all FOUR derived keys into iceEnv only for neko mode', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // Import wired.
    expect(src).toContain('deriveNekoCredentials');
    // Derivation happens inside the neko branch and merges into iceEnv.
    expect(src).toContain("if (mode === 'neko')");
    expect(src).toContain('NEKO_MEMBER_MULTIUSER_USER_PASSWORD');
    expect(src).toContain('NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD');
    // Legacy V2 compatibility keys: the pinned Neko build defaults `legacy` to
    // true and `Member.SetV2()` runs AFTER `Member.Set()`, so it overwrites the
    // V3 multiuser passwords with these V2 keys (defaulting to `neko`/`admin`
    // when absent) unless they are seeded here with the SAME derived values.
    expect(src).toContain('NEKO_PASSWORD:');
    expect(src).toContain('NEKO_PASSWORD_ADMIN:');
    expect(src).toContain('...(iceEnv ?? {})');
  });

  it('seeds the legacy keys from the exact same nekoCreds values as the V3 keys', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    const mergeStart = src.indexOf('const nekoCreds = await deriveNekoCredentials(env, sandboxId);');
    const mergeEnd = src.indexOf("tl.event('sandbox_identity'", mergeStart);
    expect(mergeStart).toBeGreaterThan(-1);
    expect(mergeEnd).toBeGreaterThan(mergeStart);
    const mergeBlock = src.slice(mergeStart, mergeEnd);
    expect(mergeBlock).toContain('NEKO_MEMBER_MULTIUSER_USER_PASSWORD: nekoCreds.user');
    expect(mergeBlock).toContain('NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: nekoCreds.admin');
    expect(mergeBlock).toContain('NEKO_PASSWORD: nekoCreds.user');
    expect(mergeBlock).toContain('NEKO_PASSWORD_ADMIN: nekoCreds.admin');
  });

  it('never places a derived value on the process command line or in the response', async () => {
    const src = await Bun.file(new URL('./index.ts', import.meta.url)).text();
    // The credentials only ever flow via the env object (iceEnv → startProcess
    // { env }); they must not be interpolated into the launched command string.
    expect(src).toContain('DESKTOP_MODE=${mode} bash /usr/local/bin/start-desktop.sh');
    expect(src).not.toContain('NEKO_MEMBER_MULTIUSER_USER_PASSWORD=${');
    expect(src).not.toContain('NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=${');
    expect(src).not.toContain('NEKO_PASSWORD=${');
    expect(src).not.toContain('NEKO_PASSWORD_ADMIN=${');
    // The preview JSON response never echoes any credential env keys.
    const responseSlice = src.slice(src.indexOf('return json({\n      ok: true'));
    expect(responseSlice).not.toContain('NEKO_MEMBER_MULTIUSER_USER_PASSWORD');
    expect(responseSlice).not.toContain('NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD');
    expect(responseSlice).not.toContain('NEKO_PASSWORD');
    expect(responseSlice).not.toContain('nekoCreds');
  });
});
