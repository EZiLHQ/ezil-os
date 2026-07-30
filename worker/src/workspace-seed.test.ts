/**
 * Package-local tests for `./workspace-seed`'s atomic seed-once decision
 * logic. Run with `bun test`, no Workers runtime or real R2 bucket required
 * — exercised against an in-memory `SeedR2BucketLike` fake that mirrors the
 * real binding's documented + empirically-verified semantics: `put()` with
 * `onlyIf: { etagDoesNotMatch: '*' }` returns the created object when no
 * object previously existed at that key, and `null` when one already did
 * (verified against this repo's installed Miniflare/wrangler runtime under
 * true concurrent `Promise.all` — see the "atomic primitive choice"
 * investigation in the deploy report for this change).
 */

import { describe, expect, it } from 'bun:test';

import {
  realR2KeyPrefix,
  SEED_SENTINEL_FILENAME,
  seedWorkspaceIfAbsent,
  sentinelKeyFor,
  type SeedR2BucketLike,
  type SeedR2ObjectLike,
} from './workspace-seed';

// ── In-memory fake mirroring R2's conditional-put + list semantics ─────────

function makeFakeBucket(seed: Record<string, string> = {}): SeedR2BucketLike & { store: Map<string, string> } {
  const store = new Map<string, string>(Object.entries(seed));
  let etagCounter = 0;

  const bucket: SeedR2BucketLike & { store: Map<string, string> } = {
    store,
    async put(key, value, options) {
      const exists = store.has(key);
      if (options?.onlyIf?.etagDoesNotMatch === '*' && exists) {
        // Conditional failed: object already exists — R2 returns null.
        return null;
      }
      store.set(key, value);
      const obj: SeedR2ObjectLike = { key, etag: `etag-${etagCounter++}` };
      return obj;
    },
    async list({ prefix, limit }) {
      const objects = [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .slice(0, limit)
        .map((key) => ({ key, etag: 'x' }));
      return { objects, truncated: false };
    },
  };
  return bucket;
}

function noopLog() {
  // swallow in tests that don't assert on logging
}

describe('realR2KeyPrefix / sentinelKeyFor', () => {
  it('strips the mandatory leading slash mountBucket() requires', () => {
    expect(realR2KeyPrefix('/proj123/branches/main')).toBe('proj123/branches/main');
  });

  it('handles a bare root prefix without producing a leading slash', () => {
    expect(realR2KeyPrefix('/')).toBe('');
  });

  it('builds the sentinel key under the real (slash-stripped) prefix', () => {
    expect(sentinelKeyFor('/proj123/branches/main')).toBe(`proj123/branches/main/${SEED_SENTINEL_FILENAME}`);
  });

  it('falls back to a bare filename when the prefix is root', () => {
    expect(sentinelKeyFor('/')).toBe(SEED_SENTINEL_FILENAME);
  });
});

describe('seedWorkspaceIfAbsent', () => {
  it('first writer seeds: empty workspace, no sentinel yet -> wins the race and copies the template', async () => {
    const bucket = makeFakeBucket();
    let copied = false;

    const outcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix: '/proj1/branches/main',
      copyTemplate: async () => {
        copied = true;
      },
      log: noopLog,
    });

    expect(outcome).toEqual({ seeded: true });
    expect(copied).toBe(true);
    expect(bucket.store.has('proj1/branches/main/.ezil-seeded')).toBe(true);
  });

  it('second writer skips: sentinel already exists -> loses the race, does not copy', async () => {
    const bucket = makeFakeBucket({ 'proj1/branches/main/.ezil-seeded': 'prior' });
    let copied = false;

    const outcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix: '/proj1/branches/main',
      copyTemplate: async () => {
        copied = true;
      },
      log: noopLog,
    });

    // The sentinel alone makes the bucket "not empty" from list()'s
    // perspective, so this is reported as not_empty rather than lost_race —
    // both are legitimate skip reasons; the key behavioral assertion is that
    // seeding never happens a second time.
    expect(outcome.seeded).toBe(false);
    expect(copied).toBe(false);
  });

  it('true concurrent race on a fresh workspace: exactly one of two simultaneous callers seeds', async () => {
    const bucket = makeFakeBucket();
    let copyCount = 0;

    const runOne = () =>
      seedWorkspaceIfAbsent({
        bucket,
        mountPrefix: '/proj1/branches/main',
        copyTemplate: async () => {
          copyCount++;
        },
        log: noopLog,
      });

    const [a, b] = await Promise.all([runOne(), runOne()]);
    const results = [a, b];
    const seededCount = results.filter((r) => r.seeded).length;

    expect(seededCount).toBe(1);
    expect(copyCount).toBe(1);
  });

  it('existing non-empty workspace (real user files, no sentinel) is never seeded over', async () => {
    // Simulates a pre-existing production workspace that predates this fix:
    // real content, but no `.ezil-seeded` sentinel yet.
    const bucket = makeFakeBucket({ 'proj1/branches/main/src/index.ts': 'export const x = 1;' });
    let copied = false;

    const outcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix: '/proj1/branches/main',
      copyTemplate: async () => {
        copied = true;
      },
      log: noopLog,
    });

    expect(outcome).toEqual({ seeded: false, reason: 'not_empty' });
    expect(copied).toBe(false);
    // And critically: no sentinel was written either — the check bailed out
    // before ever attempting the conditional put.
    expect(bucket.store.has('proj1/branches/main/.ezil-seeded')).toBe(false);
  });

  it('container restart on an already-seeded workspace is idempotent: no re-seed', async () => {
    const bucket = makeFakeBucket();
    let copyCount = 0;
    const run = () =>
      seedWorkspaceIfAbsent({
        bucket,
        mountPrefix: '/proj1/branches/main',
        copyTemplate: async () => {
          copyCount++;
        },
        log: noopLog,
      });

    const first = await run();
    expect(first).toEqual({ seeded: true });
    expect(copyCount).toBe(1);

    // Simulate a container restart: same project/branch, boot runs again.
    const second = await run();
    expect(second.seeded).toBe(false);
    expect(copyCount).toBe(1); // never re-copied
  });

  it('must not fail boot when list() throws — logs loudly and skips seeding', async () => {
    const bucket: SeedR2BucketLike = {
      async put() {
        throw new Error('should not be called');
      },
      async list() {
        throw new Error('simulated R2 outage');
      },
    };
    const logs: string[] = [];
    let copied = false;

    const outcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix: '/proj1/branches/main',
      copyTemplate: async () => {
        copied = true;
      },
      log: (m) => logs.push(m),
    });

    expect(outcome).toEqual({ seeded: false, reason: 'list_failed' });
    expect(copied).toBe(false);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('simulated R2 outage');
    expect(logs[0]).toContain('ensureWorkspaceMount');
  });

  it('must not fail boot when the sentinel put() throws — logs loudly and skips seeding', async () => {
    const bucket: SeedR2BucketLike = {
      async put() {
        throw new Error('simulated conditional-put failure');
      },
      async list() {
        return { objects: [], truncated: false };
      },
    };
    const logs: string[] = [];
    let copied = false;

    const outcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix: '/proj1/branches/main',
      copyTemplate: async () => {
        copied = true;
      },
      log: (m) => logs.push(m),
    });

    expect(outcome).toEqual({ seeded: false, reason: 'sentinel_put_failed' });
    expect(copied).toBe(false);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('simulated conditional-put failure');
  });

  it('must not fail boot when copyTemplate() throws after winning the race — logs loudly, sentinel stays committed', async () => {
    const bucket = makeFakeBucket();
    const logs: string[] = [];

    const outcome = await seedWorkspaceIfAbsent({
      bucket,
      mountPrefix: '/proj1/branches/main',
      copyTemplate: async () => {
        throw new Error('simulated cp -a failure');
      },
      log: (m) => logs.push(m),
    });

    expect(outcome).toEqual({ seeded: false, reason: 'copy_failed' });
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('simulated cp -a failure');
    // The sentinel is still committed — a retry will NOT re-attempt seeding,
    // which is the deliberate, documented trade-off (never re-seed over
    // whatever the user may have since written).
    expect(bucket.store.has('proj1/branches/main/.ezil-seeded')).toBe(true);
  });
});
