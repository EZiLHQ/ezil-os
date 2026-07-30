/**
 * Atomic "seed the workspace from the template exactly once" decision logic
 * for `ensureWorkspaceMount` (`src/index.ts`).
 *
 * Factored out of `index.ts` — same split as `./hmac`, `./twen`,
 * `./workspace-diag`, `./project-files` — so this can be unit-tested with
 * plain `bun test` against in-memory fakes, without the Workers runtime or a
 * real Sandbox/R2 bucket (`index.ts` imports `@cloudflare/sandbox`, which
 * cannot be safely exercised outside the Workers runtime — see
 * `boot.test.ts` / `index.test.ts`'s "workspace mount prefix" suite).
 *
 * ## The race this fixes
 *
 * The first preview of a project used to check whether the R2-mounted
 * workspace was empty (container-side `ls -A` against the s3fs FUSE mount)
 * and, if so, copy the project template over it (`cp -a
 * /opt/ezil-sandbox-template/. ${mountPath}/`). That is an unguarded
 * check-then-act, made worse by s3fs listing staleness: a concurrent first
 * `putObject` from the client (or a second concurrent boot of the same
 * project) could race the `ls -A` check and get clobbered by the seed copy,
 * or vice versa.
 *
 * ## The fix
 *
 * 1. An AUTHORITATIVE emptiness check straight against the R2 binding
 *    (`bucket.list({ prefix, limit: 1 })`) — never the container's `ls -A`,
 *    whose local s3fs caching is exactly what made the old check stale. This
 *    guards pre-existing, already-populated production workspaces (real user
 *    files, written before this fix shipped, with no sentinel yet) so they
 *    are NEVER seeded over.
 * 2. An ATOMIC sentinel write (`bucket.put(sentinelKey, ..., { onlyIf:
 *    { etagDoesNotMatch: '*' } })`) — R2's own compare-and-swap primitive:
 *    the put succeeds (returns a non-null `R2Object`) only if no object
 *    currently exists at that key, and returns `null` otherwise. Exactly one
 *    concurrent caller can ever win this write for a given key — that is the
 *    ONLY atomic operation in this whole flow, and it is what makes "whoever
 *    wins performs the seed; everyone else skips" race-free. This was
 *    empirically verified against this repo's installed Workers runtime
 *    (Miniflare, bundled with `wrangler`) under true `Promise.all` — a
 *    concurrent-writes bug in this exact wildcard-etag path
 *    (cloudflare/workerd#2572) was fixed and merged well before this change.
 * 3. Idempotent across restarts: once the sentinel exists, every later boot
 *    (including a container restart) sees `won === null` and skips seeding —
 *    it never re-copies the template over whatever the user has since done
 *    to their files.
 * 4. Must-not-fail-boot: every fallible step (`list`, `put`, `copyTemplate`)
 *    is wrapped so an error is logged LOUDLY (never silently swallowed) and
 *    degrades to "skip seeding", not a thrown/crashed boot.
 *
 * Only available when a real R2 binding is wired (`resolveWorkspaceMountConfig`'s
 * `'r2-binding'` mode) — that binding is the only thing here with a genuine
 * conditional-write primitive. The generic S3-compatible fallback mode (local
 * dev / no native binding) has no such primitive available without adding a
 * raw S3 client, so `index.ts` keeps the previous (racier) `ls -A`/`cp -a`
 * check for that path only — production always resolves to `'r2-binding'`
 * mode, so that residual race is scoped to non-production/local dev.
 */

// ── R2 binding surface this module depends on ───────────────────────────────
//
// Deliberately a minimal structural subset of the real `R2Bucket` type (from
// `@cloudflare/workers-types`) — the same dependency-injection style
// `project-files.ts`'s `R2BucketLike` uses — so `bun test` can inject a small
// in-memory fake instead of requiring the Workers runtime or a real bucket.

export interface SeedR2ObjectLike {
  key: string;
  etag: string;
}

export interface SeedR2ListResultLike {
  objects: SeedR2ObjectLike[];
  truncated: boolean;
}

export interface SeedR2BucketLike {
  put(
    key: string,
    value: string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<SeedR2ObjectLike | null>;
  list(options: { prefix: string; limit: number }): Promise<SeedR2ListResultLike>;
}

/** Sentinel object filename, written directly under the project's real R2 key prefix. */
export const SEED_SENTINEL_FILENAME = '.ezil-seeded';

/**
 * Strip the mandatory leading slash `mountBucket()`'s `prefix` argument
 * carries (a hard requirement of `@cloudflare/sandbox`'s own validation — see
 * `ensureWorkspaceMount`'s doc comment in `index.ts`) to recover the real R2
 * object-key prefix the SDK actually uses once it reaches R2.
 */
export function realR2KeyPrefix(mountPrefix: string): string {
  return mountPrefix.replace(/^\/+/, '');
}

/** The full sentinel object key for a given `mountBucket()` prefix. */
export function sentinelKeyFor(mountPrefix: string): string {
  const real = realR2KeyPrefix(mountPrefix);
  return real ? `${real}/${SEED_SENTINEL_FILENAME}` : SEED_SENTINEL_FILENAME;
}

export type SeedOutcome =
  | { seeded: true }
  | {
      seeded: false;
      reason: 'not_empty' | 'lost_race' | 'list_failed' | 'sentinel_put_failed' | 'copy_failed';
    };

export interface SeedDecisionDeps {
  bucket: SeedR2BucketLike;
  /** The leading-slash `prefix` given to `mountBucket()` (NOT the real R2 key prefix). */
  mountPrefix: string;
  /** Performs the actual template copy into the container's mounted workspace path. */
  copyTemplate: () => Promise<void>;
  /** Loud, non-throwing logger — errors here must never crash boot. */
  log: (message: string) => void;
}

/**
 * Decide whether to seed the workspace from the template, and do so exactly
 * once, race-free, via an atomic R2 sentinel. Never throws — every failure
 * mode logs loudly via `deps.log` and resolves to a `{ seeded: false, ... }`
 * outcome instead.
 */
export async function seedWorkspaceIfAbsent(deps: SeedDecisionDeps): Promise<SeedOutcome> {
  const { bucket, mountPrefix, copyTemplate, log } = deps;
  const realPrefix = realR2KeyPrefix(mountPrefix);
  const sentinelKey = sentinelKeyFor(mountPrefix);

  // 1. Authoritative emptiness check against R2 itself (not the container's
  // s3fs `ls -A`). Protects any workspace with real content — including
  // pre-existing production projects that predate this fix and have no
  // sentinel yet — from ever being seeded over.
  let listing: SeedR2ListResultLike;
  try {
    listing = await bucket.list({ prefix: realPrefix, limit: 1 });
  } catch (err) {
    log(
      `[ensureWorkspaceMount] seed emptiness check failed (prefix=${realPrefix}) — skipping seed, not failing boot: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { seeded: false, reason: 'list_failed' };
  }
  if (listing.objects.length > 0) {
    return { seeded: false, reason: 'not_empty' };
  }

  // 2. Atomic sentinel write — R2's conditional-put compare-and-swap. Only
  // one concurrent caller can ever win this for a given key.
  let won: SeedR2ObjectLike | null;
  try {
    won = await bucket.put(sentinelKey, JSON.stringify({ seededAt: new Date().toISOString() }), {
      onlyIf: { etagDoesNotMatch: '*' },
    });
  } catch (err) {
    log(
      `[ensureWorkspaceMount] seed sentinel write failed (key=${sentinelKey}) — skipping seed, not failing boot: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { seeded: false, reason: 'sentinel_put_failed' };
  }
  if (!won) {
    // Expected, idempotent skip: either a concurrent boot won the race just
    // now, or a prior boot already seeded (container restart case).
    return { seeded: false, reason: 'lost_race' };
  }

  // 3. We won — perform the actual copy. If this fails, the sentinel is
  // already committed (by design: it is the atomic gate, not a 2-phase
  // commit), so a future boot will NOT retry seeding. That is the correct
  // trade-off here: never silently re-seed over whatever a user has since
  // written, even if the one-time seed copy itself failed.
  try {
    await copyTemplate();
  } catch (err) {
    log(
      `[ensureWorkspaceMount] template copy failed after winning seed sentinel (key=${sentinelKey}) — workspace left unseeded, not failing boot: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { seeded: false, reason: 'copy_failed' };
  }

  return { seeded: true };
}
