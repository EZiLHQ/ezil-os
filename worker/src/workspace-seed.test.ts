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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  realR2KeyPrefix,
  SEED_SENTINEL_FILENAME,
  seedWorkspaceIfAbsent,
  sentinelKeyFor,
  buildEnsureTurbopackConfigCommand,
  parseTurbopackConfigOutcome,
  TURBOPACK_CONFIG_WRITTEN_MARKER,
  TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER,
  TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER,
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

// ── buildEnsureTurbopackConfigCommand / parseTurbopackConfigOutcome ─────────
//
// GAP (T30): `seedWorkspaceIfAbsent`'s template copy (above) is the ONLY
// place the Turbopack `turbopack: { root: '/' }` fix (PLATFORM-NOTES §18)
// ever lands, and it only ever runs against a workspace R2 finds genuinely
// empty. A real, pre-existing, already-hydrated computer (content already in
// R2, no sentinel needed because it was never empty) never goes through that
// path and never gets the fix. These tests run the ACTUAL generated shell
// command through a real `bash -c`, against a real temp directory — not a
// grep of the JS that builds it — to prove the three safety rules in
// `buildEnsureTurbopackConfigCommand`'s doc comment: never clobber a user's
// own config, never touch a non-Next project, and behave identically on a
// second run (no churn).

const TEMPLATE_CONFIG_MARKER = 'TURBOPACK_ROOT_FIX_TEMPLATE_CONTENT';

/** Runs `buildEnsureTurbopackConfigCommand`'s output through a real `bash -c`, against a real temp dir. Returns trimmed stdout. */
function runEnsureTurbopackConfig(targetPath: string, templateConfigPath: string): string {
  const command = buildEnsureTurbopackConfigCommand(targetPath, templateConfigPath);
  const stdout = execFileSync('bash', ['-c', command], { encoding: 'utf8' });
  return stdout.trim();
}

describe('buildEnsureTurbopackConfigCommand — real shell, real filesystem', () => {
  let root: string;
  let templateConfigPath: string;

  const freshDir = (): string => {
    const dir = join(root, Math.random().toString(36).slice(2));
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  const setUp = () => {
    root = mkdtempSync(join(tmpdir(), 'ezil-turbopack-config-test-'));
    templateConfigPath = join(root, 'template-next.config.js');
    writeFileSync(templateConfigPath, TEMPLATE_CONFIG_MARKER);
  };
  const tearDown = () => {
    rmSync(root, { recursive: true, force: true });
  };

  it('writes the template config into a pre-existing Next.js workspace that has none — THE GAP FIX', () => {
    setUp();
    try {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { next: '16.2.12' } }));
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_WRITTEN_MARKER);
      expect(parseTurbopackConfigOutcome(stdout)).toBe('written');
      expect(existsSync(join(dir, 'next.config.js'))).toBe(true);
      expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toBe(TEMPLATE_CONFIG_MARKER);
    } finally {
      tearDown();
    }
  });

  it('NEVER overwrites a user’s own next.config.js', () => {
    setUp();
    try {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { next: '16.2.12' } }));
      writeFileSync(join(dir, 'next.config.js'), 'USER_OWNED_CONFIG_CONTENT');
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER);
      expect(parseTurbopackConfigOutcome(stdout)).toBe('skipped_existing_config');
      expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toBe('USER_OWNED_CONFIG_CONTENT');
    } finally {
      tearDown();
    }
  });

  it('NEVER overwrites a user’s own next.config.ts (a different extension than the template writes)', () => {
    setUp();
    try {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { next: '16.2.12' } }));
      writeFileSync(join(dir, 'next.config.ts'), 'USER_OWNED_TS_CONFIG');
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER);
      expect(existsSync(join(dir, 'next.config.js'))).toBe(false);
      expect(readFileSync(join(dir, 'next.config.ts'), 'utf8')).toBe('USER_OWNED_TS_CONFIG');
    } finally {
      tearDown();
    }
  });

  it('NEVER overwrites a user’s own next.config.mjs', () => {
    setUp();
    try {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { next: '16.2.12' } }));
      writeFileSync(join(dir, 'next.config.mjs'), 'USER_OWNED_MJS_CONFIG');
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER);
      expect(existsSync(join(dir, 'next.config.js'))).toBe(false);
    } finally {
      tearDown();
    }
  });

  it('never touches a non-Next project — no next.config.js appears', () => {
    setUp();
    try {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { express: '4.0.0' } }));
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER);
      expect(parseTurbopackConfigOutcome(stdout)).toBe('skipped_not_next');
      expect(existsSync(join(dir, 'next.config.js'))).toBe(false);
    } finally {
      tearDown();
    }
  });

  it('never touches a workspace with no package.json at all', () => {
    setUp();
    try {
      const dir = freshDir();
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER);
      expect(existsSync(join(dir, 'next.config.js'))).toBe(false);
    } finally {
      tearDown();
    }
  });

  it('is idempotent: running it a second time after a real write is a no-op, not a re-copy', () => {
    setUp();
    try {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { next: '16.2.12' } }));
      const first = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(first).toBe(TURBOPACK_CONFIG_WRITTEN_MARKER);

      // Simulate a later hydrate: the user has since edited the file that got
      // written (this is EXACTLY what must never be clobbered by a second run).
      writeFileSync(join(dir, 'next.config.js'), 'EDITED_AFTER_FIRST_WRITE');

      const second = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(second).toBe(TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER);
      expect(readFileSync(join(dir, 'next.config.js'), 'utf8')).toBe('EDITED_AFTER_FIRST_WRITE');
    } finally {
      tearDown();
    }
  });

  it('does not false-positive on a package.json that merely mentions "next" inside another package name', () => {
    setUp();
    try {
      const dir = freshDir();
      // "next-auth" contains the substring "next" but is NOT the `next`
      // dependency itself — the pattern requires the exact `"next":` key.
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'next-auth': '1.0.0' } }));
      const stdout = runEnsureTurbopackConfig(dir, templateConfigPath);
      expect(stdout).toBe(TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER);
      expect(existsSync(join(dir, 'next.config.js'))).toBe(false);
    } finally {
      tearDown();
    }
  });
});

describe('parseTurbopackConfigOutcome', () => {
  it('recognizes all three markers', () => {
    expect(parseTurbopackConfigOutcome(TURBOPACK_CONFIG_WRITTEN_MARKER)).toBe('written');
    expect(parseTurbopackConfigOutcome(TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER)).toBe('skipped_existing_config');
    expect(parseTurbopackConfigOutcome(TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER)).toBe('skipped_not_next');
  });

  it('returns null for empty/missing/unrecognized stdout — honest "unknown", never a guess', () => {
    expect(parseTurbopackConfigOutcome('')).toBeNull();
    expect(parseTurbopackConfigOutcome(undefined)).toBeNull();
    expect(parseTurbopackConfigOutcome(null)).toBeNull();
    expect(parseTurbopackConfigOutcome('some unrelated exec output')).toBeNull();
  });
});
