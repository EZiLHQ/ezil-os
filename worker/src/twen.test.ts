/**
 * Package-local tests for the Twen workspace orchestration contract.
 *
 * Twen is a first-class, named EZiL OS orchestration action operating on an
 * authenticated project's EXISTING sandbox identity + persistent `/workspace`.
 * These tests assert the HARD SAFETY CONTRACT of its pure (runtime-free) helpers
 * in `./twen` — no network/container calls. Run with `bun test`.
 *
 * Coverage:
 *   - op/operationId validation + defaults
 *   - operation-id allowlist: traversal / separators / shell metacharacters
 *     / length rejected
 *   - strict whole-body contract: unknown fields (`path`/`content`/`command`/
 *     `slot`/nested payloads) REJECTED (not ignored); non-object bodies rejected
 *   - oversized request guard (large body rejected before parsing)
 *   - deterministic, non-secret artifact content (persistence-roundtrip basis)
 *   - FIXED reserved artifact path (caller can never influence it)
 *   - no arbitrary content/path/command/slot input surface
 *   - non-secret kill-switch
 *
 * HMAC gating (required / malformed / expired / mismatch / no-leak) — i.e. the
 * unsigned / invalid-or-expired authorization / wrong-identity cases — is proven
 * by the shared `./hmac` suite in `index.test.ts`; the Twen route reuses that
 * exact `verifyPreviewToken` envelope, so it inherits those guarantees.
 */

import { describe, expect, it } from 'bun:test';

const sha256 = async (s: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
};

describe('twen: parseTwenRequest (op + operationId validation)', () => {
  it('defaults op to "sync" (idempotent write) and operationId to "default"', async () => {
    const { parseTwenRequest } = await import('./twen');
    expect(parseTwenRequest(undefined, undefined)).toEqual({
      ok: true,
      op: 'sync',
      operationId: 'default',
      write: true,
    });
  });

  it('marks write vs read-only ops correctly', async () => {
    const { parseTwenRequest } = await import('./twen');
    const sync = parseTwenRequest('sync', 'op1');
    expect(sync.ok && sync.write).toBe(true);
    const status = parseTwenRequest('status', 'op1');
    expect(status.ok && status.write).toBe(false);
  });

  it('lowercases and accepts allowlisted operation ids', async () => {
    const { parseTwenRequest } = await import('./twen');
    expect(parseTwenRequest('STATUS', 'Op.A-1_b')).toEqual({
      ok: true,
      op: 'status',
      operationId: 'op.a-1_b',
      write: false,
    });
  });

  it('rejects an unknown op rather than silently coercing', async () => {
    const { parseTwenRequest } = await import('./twen');
    const r = parseTwenRequest('delete', 'op1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('twen_invalid_op');
  });

  it('rejects path traversal / separators / shell metacharacters / bad length in operationId', async () => {
    const { parseTwenRequest } = await import('./twen');
    for (const bad of [
      '../escape',
      'a/b',
      '.hidden',
      "x';rm -rf /",
      'has space',
      '$(whoami)',
      'a|b',
      '',
      'x'.repeat(65),
    ]) {
      const r = parseTwenRequest('sync', bad);
      expect(r.ok, `operationId ${JSON.stringify(bad)} must be rejected`).toBe(false);
      if (!r.ok) expect(r.error).toContain('twen_invalid_operation_id');
    }
  });
});

describe('twen: fixed reserved artifact path (caller cannot influence it)', () => {
  it('is a hidden, root-level, FUSE-safe file with no path separator', async () => {
    const { TWEN_STATUS_FILE } = await import('./twen');
    expect(TWEN_STATUS_FILE).toBe('.ezil-twen-status.json');
    expect(TWEN_STATUS_FILE.startsWith('.')).toBe(true); // hidden
    expect(TWEN_STATUS_FILE).not.toContain('/'); // no mkdir / traversal
  });

  it('exposes no arbitrary content/path/command/slot input on the request contract', async () => {
    const { parseTwenRequest } = await import('./twen');
    // parseTwenRequest only accepts (op, operationId) — there is no code path
    // that reads a caller-supplied path or content. Any such extra wire fields
    // are actively REJECTED by parseTwenBody (see the strict-contract suite),
    // never silently ignored.
    expect(parseTwenRequest.length).toBe(2);
  });
});

describe('twen: parseTwenBody strict contract (reject unknown fields, not ignore)', () => {
  it('accepts a minimal body (op/operationId default) with only the allowed token field', async () => {
    const { parseTwenBody } = await import('./twen');
    expect(parseTwenBody({ token: 'abc' })).toEqual({
      ok: true,
      op: 'sync',
      operationId: 'default',
      write: true,
    });
    expect(parseTwenBody({})).toEqual({
      ok: true,
      op: 'sync',
      operationId: 'default',
      write: true,
    });
  });

  it('accepts the full allowed field set (token + op + operationId)', async () => {
    const { parseTwenBody } = await import('./twen');
    expect(parseTwenBody({ token: 't', op: 'status', operationId: 'op1' })).toEqual({
      ok: true,
      op: 'status',
      operationId: 'op1',
      write: false,
    });
  });

  it('REJECTS (does not ignore) out-of-contract fields: path/content/command/slot', async () => {
    const { parseTwenBody } = await import('./twen');
    for (const field of ['path', 'content', 'command', 'slot']) {
      const r = parseTwenBody({ token: 't', op: 'sync', [field]: 'x' });
      expect(r.ok, `field ${field} must be rejected, not ignored`).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('twen_unknown_field');
        expect(r.error).toContain(field);
      }
    }
  });

  it('rejects an arbitrary/unexpected extra field verbatim', async () => {
    const { parseTwenBody } = await import('./twen');
    const r = parseTwenBody({ token: 't', hax: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('twen_unknown_field: hax');
  });

  it('rejects nested / non-scalar payloads smuggled in op or operationId (no coercion)', async () => {
    const { parseTwenBody } = await import('./twen');
    const nestedOp = parseTwenBody({ token: 't', op: { $ne: null } });
    expect(nestedOp.ok).toBe(false);
    if (!nestedOp.ok) expect(nestedOp.error).toContain('twen_invalid_op');

    const nestedId = parseTwenBody({ token: 't', operationId: ['a', 'b'] });
    expect(nestedId.ok).toBe(false);
    if (!nestedId.ok) expect(nestedId.error).toContain('twen_invalid_operation_id');
  });

  it('rejects a non-object body (null / array / scalar)', async () => {
    const { parseTwenBody } = await import('./twen');
    for (const bad of [null, [], ['token'], 'string', 42, true]) {
      const r = parseTwenBody(bad as unknown);
      expect(r.ok, `body ${JSON.stringify(bad)} must be rejected`).toBe(false);
      if (!r.ok) expect(r.error).toContain('twen_invalid_body');
    }
  });

  it('still rejects malformed operation ids through the whole-body path', async () => {
    const { parseTwenBody } = await import('./twen');
    for (const bad of ['../escape', 'a/b', '$(whoami)', 'x'.repeat(65)]) {
      const r = parseTwenBody({ token: 't', operationId: bad });
      expect(r.ok, `operationId ${JSON.stringify(bad)} must be rejected`).toBe(false);
      if (!r.ok) expect(r.error).toContain('twen_invalid_operation_id');
    }
  });

  it('rejects an unknown op through the whole-body path', async () => {
    const { parseTwenBody } = await import('./twen');
    const r = parseTwenBody({ token: 't', op: 'delete' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('twen_invalid_op');
  });
});

describe('twen: oversized request guard', () => {
  it('bounds the raw body to a small ceiling', async () => {
    const { TWEN_MAX_BODY_BYTES } = await import('./twen');
    expect(TWEN_MAX_BODY_BYTES).toBeGreaterThan(0);
    expect(TWEN_MAX_BODY_BYTES).toBeLessThanOrEqual(8192);
  });

  it('flags a body over the ceiling and passes one at/under it', async () => {
    const { twenRequestTooLarge, TWEN_MAX_BODY_BYTES } = await import('./twen');
    expect(twenRequestTooLarge(TWEN_MAX_BODY_BYTES)).toBe(false);
    expect(twenRequestTooLarge(TWEN_MAX_BODY_BYTES + 1)).toBe(true);
    // A body smuggling large file content is rejected before parsing.
    const oversized = new TextEncoder().encode(
      JSON.stringify({ token: 't', content: 'A'.repeat(TWEN_MAX_BODY_BYTES) }),
    ).length;
    expect(twenRequestTooLarge(oversized)).toBe(true);
  });
});

describe('twen: allowed-field allowlist is exhaustive and closed', () => {
  it('lists exactly token/op/operationId — no path/content/command/slot', async () => {
    const { TWEN_ALLOWED_FIELDS } = await import('./twen');
    expect([...TWEN_ALLOWED_FIELDS].sort()).toEqual(['op', 'operationId', 'token']);
    for (const forbidden of ['path', 'content', 'command', 'slot']) {
      expect(TWEN_ALLOWED_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('twen: deterministic, non-secret status artifact content', () => {
  it('is a pure function of operationId only (no clock / no entropy / no sandbox id)', async () => {
    const { twenStatusContent } = await import('./twen');
    const a = twenStatusContent('op-alpha');
    const b = twenStatusContent('op-alpha');
    expect(a).toBe(b); // stable across calls
    expect(twenStatusContent('op-beta')).not.toBe(a); // operationId-scoped
  });

  it('same operationId yields the same SHA-256 (persistence-roundtrip basis)', async () => {
    const { twenStatusContent } = await import('./twen');
    expect(await sha256(twenStatusContent('persist'))).toBe(
      await sha256(twenStatusContent('persist')),
    );
  });

  it('is canonical JSON carrying the schema + operationId, and no secrets/user data', async () => {
    const { twenStatusContent, TWEN_SCHEMA } = await import('./twen');
    const content = twenStatusContent('op1');
    const parsed = JSON.parse(content);
    expect(parsed.schema).toBe(TWEN_SCHEMA);
    expect(parsed.operationId).toBe('op1');
    expect(parsed.origin).toBe('twen');
    expect(content).not.toMatch(/secret|token|key|password|credential/i);
  });
});

describe('twen: twenDisabled kill-switch (non-secret, enabled by default)', () => {
  it('is enabled (not disabled) when the flag is unset/empty/on/true', async () => {
    const { twenDisabled } = await import('./twen');
    expect(twenDisabled(undefined)).toBe(false);
    expect(twenDisabled('')).toBe(false);
    expect(twenDisabled('on')).toBe(false);
    expect(twenDisabled('true')).toBe(false);
  });

  it('disables on off/false/0/disabled/no (case/space-insensitive)', async () => {
    const { twenDisabled } = await import('./twen');
    for (const v of ['off', 'FALSE', ' 0 ', 'Disabled', 'no']) {
      expect(twenDisabled(v)).toBe(true);
    }
  });
});

describe('twen: FUSE stat convergence loop (bounded retry, expected-hash success, no content leak)', () => {
  it('bounds the retry budget: writes get more attempts than reads, both finite', async () => {
    const {
      twenStatMaxAttempts,
      TWEN_STAT_MAX_ATTEMPTS_WRITE,
      TWEN_STAT_MAX_ATTEMPTS_READ,
      TWEN_STAT_RETRY_DELAY_MS,
    } = await import('./twen');
    expect(twenStatMaxAttempts(true)).toBe(TWEN_STAT_MAX_ATTEMPTS_WRITE);
    expect(twenStatMaxAttempts(false)).toBe(TWEN_STAT_MAX_ATTEMPTS_READ);
    // Finite, small, and write > read (write must wait for the digest to settle).
    expect(TWEN_STAT_MAX_ATTEMPTS_WRITE).toBeGreaterThan(TWEN_STAT_MAX_ATTEMPTS_READ);
    expect(TWEN_STAT_MAX_ATTEMPTS_READ).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(TWEN_STAT_MAX_ATTEMPTS_WRITE)).toBe(true);
    // A hard worst-case wall-clock ceiling exists (no infinite wait).
    const worstCaseMs = (TWEN_STAT_MAX_ATTEMPTS_WRITE - 1) * TWEN_STAT_RETRY_DELAY_MS;
    expect(worstCaseMs).toBeGreaterThan(0);
    expect(worstCaseMs).toBeLessThan(60_000);
  });

  it('parses stat lines into a content-free view (exists/bytes/sha only, never raw bytes)', async () => {
    const { parseTwenStatLines } = await import('./twen');
    const present = parseTwenStatLines(['exists', '42', 'deadbeef']);
    expect(present).toEqual({ exists: true, bytes: 42, sha256: 'deadbeef' });
    const absent = parseTwenStatLines(['missing']);
    expect(absent).toEqual({ exists: false, bytes: 0, sha256: null });
    // The observation shape carries no field that could hold file content.
    expect(Object.keys(present).sort()).toEqual(['bytes', 'exists', 'sha256']);
  });

  it('write op converges ONLY when the read-back digest equals the expected digest', async () => {
    const { twenStatConverged, parseTwenStatLines } = await import('./twen');
    const expected = await sha256('artifact-bytes');
    const wrong = await sha256('other-bytes');
    // Stale/empty pre-write view: not converged -> loop must keep retrying.
    expect(twenStatConverged(true, parseTwenStatLines(['missing']), expected)).toBe(false);
    // File exists but transient/mismatched digest: not converged.
    expect(twenStatConverged(true, parseTwenStatLines(['exists', '0', '']), expected)).toBe(false);
    expect(twenStatConverged(true, parseTwenStatLines(['exists', '12', wrong]), expected)).toBe(
      false,
    );
    // Settled at the deterministic expected digest: converged.
    expect(twenStatConverged(true, parseTwenStatLines(['exists', '12', expected]), expected)).toBe(
      true,
    );
  });

  it('read op converges on a legitimate absence or a non-transient (>0 byte) view', async () => {
    const { twenStatConverged, parseTwenStatLines } = await import('./twen');
    const expected = await sha256('anything');
    // Legitimately absent (isolation check on a different identity): terminal.
    expect(twenStatConverged(false, parseTwenStatLines(['missing']), expected)).toBe(true);
    // Present but transient 0-byte view: keep waiting.
    expect(twenStatConverged(false, parseTwenStatLines(['exists', '0', '']), expected)).toBe(false);
    // Present with real bytes: terminal regardless of digest (read-only).
    expect(twenStatConverged(false, parseTwenStatLines(['exists', '7', 'abc']), expected)).toBe(
      true,
    );
  });

  it('a persistently stale FUSE view never converges a write (guaranteeing loop exhaustion, not hang)', async () => {
    const { twenStatConverged, parseTwenStatLines, twenStatMaxAttempts } = await import('./twen');
    const expected = await sha256('never-shows-up');
    // Simulate the loop: the FUSE view stays empty for every bounded attempt.
    let converged = false;
    const attempts = twenStatMaxAttempts(true);
    for (let i = 0; i < attempts; i++) {
      converged = twenStatConverged(true, parseTwenStatLines(['missing']), expected);
      if (converged) break;
    }
    // It never converges, but the loop is bounded by `attempts` — it exits, not hangs.
    expect(converged).toBe(false);
    expect(attempts).toBeLessThan(Infinity);
  });
});

describe('twen: fixed-slot write primitive (R2 FUSE close-only rewrite + read-back proof)', () => {
  it('uses a timeout-bounded close-only rewrite at the fixed path (no unsupported flush primitive)', async () => {
    const { twenWriteCommand, TWEN_WRITE_TIMEOUT_SECONDS } = await import('./twen');
    const cmd = twenWriteCommand('/mnt/ws/.ezil-diag-alpha', 'marker-bytes');
    // The deterministic fixture bytes are written by an ordinary shell close;
    // durability is proven by separated read-backs, not by unsupported fsync.
    expect(cmd).toContain(
      `timeout ${TWEN_WRITE_TIMEOUT_SECONDS} sh -c 'printf %s "$1" > "$2"' sh 'marker-bytes' '/mnt/ws/.ezil-diag-alpha'`,
    );
    expect(cmd).toContain('echo wrote');
  });

  it('NEVER uses the discredited count=0 / notrunc-empty-fsync no-op', async () => {
    const { twenWriteCommand } = await import('./twen');
    const cmd = twenWriteCommand('/p', 'c');
    // `count=0` copied zero bytes and never re-issued the data write — the live
    // false success. It must be gone, as must `if=/dev/null` (empty source).
    expect(cmd).not.toContain('count=0');
    expect(cmd).not.toContain('if=/dev/null');
    expect(cmd).not.toContain('notrunc');
  });

  it('does NOT use explicit sync/fsync/dd after clean-mount fsync EPERM evidence', async () => {
    const { twenWriteCommand } = await import('./twen');
    const cmd = twenWriteCommand('/mnt/ws/.ezil-twen-status.json', 'bytes');
    // The clean single-sandbox run returned `dd: fsync failed ... Operation not
    // permitted`, so explicit fsync is not part of the rebuilt primitive.
    expect(cmd).not.toContain('dd ');
    expect(cmd).not.toContain('conv=fsync');
    expect(cmd).not.toContain('fsync');
    expect(cmd).not.toMatch(/\bsync\s+'/); // no `sync <path>` durability claim
    expect(cmd).not.toMatch(/&&\s*sync\s*&&/); // no bare unbounded `sync`
  });

  it('does NOT swallow a failed durability-critical write with `|| true`', async () => {
    const { twenWriteCommand } = await import('./twen');
    // A timed-out/failed close-only rewrite must surface as a non-zero exit, not
    // a no-op.
    expect(twenWriteCommand('/p', 'c')).not.toContain('|| true');
  });

  it('bounds the durability-critical write in a finite, small `timeout` (no infinite wait)', async () => {
    const { TWEN_WRITE_TIMEOUT_SECONDS } = await import('./twen');
    expect(Number.isFinite(TWEN_WRITE_TIMEOUT_SECONDS)).toBe(true);
    expect(TWEN_WRITE_TIMEOUT_SECONDS).toBeGreaterThan(0);
    expect(TWEN_WRITE_TIMEOUT_SECONDS).toBeLessThanOrEqual(60);
  });

  it('honours a caller-provided (sanitized) write timeout override', async () => {
    const { twenWriteCommand } = await import('./twen');
    expect(twenWriteCommand('/p', 'c', 5)).toContain(
      `timeout 5 sh -c 'printf %s "$1" > "$2"' sh 'c' '/p'`,
    );
  });

  it('preserves the exact fixture bytes / SHA-256 (printf %s — no trailing newline)', async () => {
    const { twenWriteCommand, twenStatusContent } = await import('./twen');
    const content = twenStatusContent('persist');
    const cmd = twenWriteCommand('/p', content);
    // The fixture content is emitted verbatim by `printf %s` — no `\n`, no
    // `echo`, so the byte count (and therefore the SHA-256) is exact.
    expect(cmd).toContain('printf %s "$1"');
    expect(cmd).toContain(`'${content}'`);
    expect(cmd).not.toContain('printf %s\\n');
    expect(cmd).not.toMatch(/\becho\s+'?\$?\{?content/);
  });
});

describe('twen: separated fresh-boundary write durability', () => {
  it('cached match -> fresh empty is never durable', async () => {
    const { twenWriteDurable, parseTwenStatLines } = await import('./twen');
    const expected = await sha256('ezil-workspace-diag;slot=alpha;v=1');
    const good = parseTwenStatLines(['exists', '34', expected]);
    // Same-boundary success + fresh-boundary EMPTY ⇒ the live false success ⇒ false.
    expect(
      twenWriteDurable(
        good,
        parseTwenStatLines(['exists', '0', '']),
        good,
        expected,
      ),
    ).toBe(false);
    // Same-boundary success + fresh-boundary MISSING ⇒ false.
    expect(twenWriteDurable(good, parseTwenStatLines(['missing']), good, expected)).toBe(false);
  });

  it('first fresh match -> second fresh mismatch is never durable', async () => {
    const { twenWriteDurable, parseTwenStatLines } = await import('./twen');
    const expected = await sha256('right');
    const wrong = await sha256('wrong');
    const good = parseTwenStatLines(['exists', '5', expected]);
    expect(
      twenWriteDurable(good, good, parseTwenStatLines(['exists', '5', wrong]), expected),
    ).toBe(false);
  });

  it('two separated fresh matches are required for wrote:true', async () => {
    const { twenWriteDurable, parseTwenStatLines } = await import('./twen');
    const expected = await sha256('right');
    const good = parseTwenStatLines(['exists', '5', expected]);
    // Fresh observations confirmed but the convergence view stale/empty ⇒ still false.
    expect(
      twenWriteDurable(parseTwenStatLines(['exists', '0', '']), good, good, expected),
    ).toBe(false);
    // Converged + both separated fresh observations confirm the expected digest.
    expect(twenWriteDurable(good, good, good, expected)).toBe(true);
  });
});

describe('twen: stale-zero self-heal predicate', () => {
  it('flags an existing 0-byte poisoned slot (must be rewritten, never preserved)', async () => {
    const { twenStaleZero, parseTwenStatLines } = await import('./twen');
    expect(twenStaleZero(parseTwenStatLines(['exists', '0', '']))).toBe(true);
    // A real, non-empty artifact is not stale-zero.
    expect(twenStaleZero(parseTwenStatLines(['exists', '34', 'abc']))).toBe(false);
    // An absent slot is not stale-zero (nothing to self-heal).
    expect(twenStaleZero(parseTwenStatLines(['missing']))).toBe(false);
  });
});

describe('twen: authoritative write-success predicate (wrote:true impossible without durable read-back)', () => {
  it('confirms ONLY a non-zero, expected-digest read-back (structurally forbids 0-byte false-success)', async () => {
    const { twenWriteConfirmed, parseTwenStatLines } = await import('./twen');
    const expected = await sha256('ezil-workspace-diag;slot=alpha;v=1');
    // Empty file: the observed regression — SHA of "" can never match a marker.
    const emptySha = await sha256('');
    expect(
      twenWriteConfirmed(parseTwenStatLines(['exists', '0', emptySha]), expected),
    ).toBe(false);
    // Absent file: not a successful write.
    expect(twenWriteConfirmed(parseTwenStatLines(['missing']), expected)).toBe(false);
    // Present but wrong digest: not confirmed.
    const wrong = await sha256('other');
    expect(twenWriteConfirmed(parseTwenStatLines(['exists', '12', wrong]), expected)).toBe(false);
    // Present, non-zero bytes, matching digest: the ONLY confirmed state.
    expect(twenWriteConfirmed(parseTwenStatLines(['exists', '30', expected]), expected)).toBe(true);
  });

  it('requires strictly positive bytes even if a (degenerate) digest somehow matched', async () => {
    const { twenWriteConfirmed } = await import('./twen');
    const expected = 'deadbeef';
    // 0 bytes is never a confirmed write regardless of the reported digest.
    expect(
      twenWriteConfirmed({ exists: true, bytes: 0, sha256: expected }, expected),
    ).toBe(false);
  });
});