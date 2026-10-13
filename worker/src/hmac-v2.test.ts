/**
 * Preview token v2 (docs/AWS-COMPUTERS.md C-5): the verifier against the
 * SHARED vectors in `./preview-token-v2.vectors.json`. The app's minter is
 * held to the same constants by
 * `app/src/server/lib/compute/preview-token-v2.test.ts`, so a drift on either
 * side fails one of the two suites.
 */
import { describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import vectors from './preview-token-v2.vectors.json';
import {
  mintPreviewTokenV2,
  previewTokenV1Accepted,
  verifyPreviewTokenV2,
  type PreviewTokenV2Claims,
} from './hmac';

const { secret, verifyAt, maxAgeMs } = vectors;

describe('v2 shared vectors: the verifier accepts exactly the valid ones', () => {
  for (const v of vectors.valid) {
    it(`accepts ${v.name}`, async () => {
      const r = await verifyPreviewTokenV2(v.token, secret, { method: v.method, path: v.path, body: v.body }, verifyAt);
      expect(r).toEqual({ ok: true, claims: v.claims as PreviewTokenV2Claims });
    });
    it(`${v.name}: payload and signature are reproducible without the Worker's own code`, () => {
      // Independent of hmac.ts: node:crypto over the documented framing.
      const c = v.claims;
      const bodySha = createHash('sha256').update(v.body, 'utf8').digest('hex');
      expect(bodySha).toBe(v.bodySha256);
      const payload = ['v2', c.ts, v.method, v.path, c.sandboxId, c.computerId, c.userId, c.provider, c.store,
        c.generation, c.leaseEpoch, bodySha].join('|');
      expect(payload).toBe(v.payload);
      const sig = createHmac('sha256', secret).update(payload).digest('hex');
      const claimsJson = JSON.stringify({ ts: c.ts, sandboxId: c.sandboxId, computerId: c.computerId, userId: c.userId,
        provider: c.provider, store: c.store, generation: c.generation, leaseEpoch: c.leaseEpoch });
      expect(v.token).toBe(`v2.${Buffer.from(claimsJson, 'utf8').toString('base64url')}.${sig}`);
    });
    it(`${v.name}: the Worker minter emits the same token`, async () => {
      expect(await mintPreviewTokenV2(secret, v.claims as PreviewTokenV2Claims, { method: v.method, path: v.path, body: v.body }))
        .toBe(v.token);
    });
  }
  for (const v of vectors.invalid) {
    it(`refuses ${v.name} (${v.error})`, async () => {
      const r = await verifyPreviewTokenV2(v.token, secret, { method: v.method, path: v.path, body: v.body }, verifyAt);
      expect(r).toEqual({ ok: false, error: v.error });
    });
  }
});

describe('v2 freshness and fail-closed rules', () => {
  const v = vectors.valid[0]!;
  const req = { method: v.method, path: v.path, body: v.body };
  it('refuses an expired token, and one from the future', async () => {
    const ts = v.claims.ts;
    expect(await verifyPreviewTokenV2(v.token, secret, req, ts + maxAgeMs)).toMatchObject({ ok: true });
    expect(await verifyPreviewTokenV2(v.token, secret, req, ts + maxAgeMs + 1)).toEqual({ ok: false, error: 'hmac_token_expired' });
    expect(await verifyPreviewTokenV2(v.token, secret, req, ts - maxAgeMs - 1)).toEqual({ ok: false, error: 'hmac_token_expired' });
  });
  it('fails CLOSED when no secret is configured (no local-dev bypass, #166)', async () => {
    for (const none of [undefined, '', '   ', [], ['', ' ']] as const) {
      expect(await verifyPreviewTokenV2(v.token, none as never, req, verifyAt))
        .toEqual({ ok: false, error: 'hmac_secret_not_configured' });
    }
    await expect(mintPreviewTokenV2('', v.claims as PreviewTokenV2Claims, req)).rejects.toThrow('hmac_secret_not_configured');
  });
  it('accepts against the mission alias as an additional candidate, like v1', async () => {
    expect(await verifyPreviewTokenV2(v.token, ['other-primary', secret], req, verifyAt)).toMatchObject({ ok: true });
  });
  it('refuses a missing / garbage token', async () => {
    expect(await verifyPreviewTokenV2(undefined, secret, req, verifyAt)).toEqual({ ok: false, error: 'hmac_v2_token_missing' });
    expect(await verifyPreviewTokenV2('v2.!!.00', secret, req, verifyAt)).toEqual({ ok: false, error: 'hmac_v2_malformed_token' });
    const extraKey = Buffer.from(JSON.stringify({ ...v.claims, admin: true })).toString('base64url');
    expect(await verifyPreviewTokenV2(`v2.${extraKey}.${v.token.split('.')[2]}`, secret, req, verifyAt))
      .toEqual({ ok: false, error: 'hmac_v2_invalid_claims' });
  });
});

describe('EZIL_PREVIEW_TOKEN_V1_UNTIL', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('absent or blank: v1 accepted (today)', () => {
    expect(previewTokenV1Accepted(undefined, now)).toBe(true);
    expect(previewTokenV1Accepted('  ', now)).toBe(true);
  });
  it('future: accepted; at or after the cutoff: refused', () => {
    expect(previewTokenV1Accepted('2026-10-13T12:00:01Z', now)).toBe(true);
    expect(previewTokenV1Accepted('2026-10-13T12:00:00Z', now)).toBe(false);
    expect(previewTokenV1Accepted('2026-10-01T00:00:00Z', now)).toBe(false);
  });
  it('unparseable: refused (fail closed)', () => {
    for (const bad of ['tomorrow', '2026-13-45T99:00:00Z', '1760000000000', '2026-10-20']) {
      expect(previewTokenV1Accepted(bad, now)).toBe(false);
    }
  });
});

describe('fixture documents the query and replay rules', () => {
  it('pins them so both sides read the same contract', () => {
    expect(vectors.queryPolicy).toContain('hmac_v2_query_not_allowed');
    expect(vectors.replay).toContain('No nonce');
  });
});
