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

// ── Template-copy command + its "the image was built without the template"
// loud-failure signal ───────────────────────────────────────────────────────
//
// The template copy used to be a single `[ -d /opt/ezil-sandbox-template ]
// && cp -a ... || true` shell one-liner. That `|| true` exists so a missing
// template directory never fails boot (a workspace with no starter files
// still beats no boot at all) — but it ALSO meant a genuinely missing
// template (e.g. the Dockerfile's COPY step silently not shipping it, which
// is exactly what happened in production for weeks) produced no signal
// whatsoever: `sandbox.exec()` returns success either way, the emptiness
// check passed, and every new workspace booted to a silently empty desktop.
//
// Fix: keep the "never fail boot" contract, but make the two outcomes
// (copied vs. missing) distinguishable on stdout so the caller can log the
// missing case LOUDLY via `console.error`/`deps.log` instead of it
// disappearing into an untested `|| true`.

/** Marker line `buildTemplateCopyCommand`'s shell prints when the baked-in template directory is absent. */
export const TEMPLATE_MISSING_MARKER = 'EZIL_TEMPLATE_MISSING';

/**
 * Shell command that copies the image's baked-in starter template
 * (`/opt/ezil-sandbox-template`, `COPY`'d there by the Dockerfile) into
 * `targetPath` when present, or prints `TEMPLATE_MISSING_MARKER` on stdout
 * when it is not — never throws/fails on a missing template (still
 * boot-safe), but always reports which branch it took. Callers MUST check
 * the returned `ExecResult.stdout` with `templateWasMissing()` and log
 * loudly on a hit.
 */
export function buildTemplateCopyCommand(targetPath: string): string {
  return `if [ -d /opt/ezil-sandbox-template ]; then cp -a /opt/ezil-sandbox-template/. ${targetPath}/; else echo ${TEMPLATE_MISSING_MARKER}; fi`;
}

/** True when `buildTemplateCopyCommand`'s stdout reports the template directory was missing from the image. */
export function templateWasMissing(stdout: string | undefined | null): boolean {
  return (stdout ?? '').includes(TEMPLATE_MISSING_MARKER);
}

// ── Turbopack config for a PRE-EXISTING, already-hydrated workspace ─────────
//
// GAP (T30): `worker/sandbox-template/next.config.js` (the `turbopack: {
// root: '/' }` fix for the symlinked-node_modules Turbopack fatal —
// PLATFORM-NOTES §18) is only ever placed by `seedWorkspaceIfAbsent`, which
// by design skips any workspace `bucket.list()` finds non-empty. A real
// computer whose workspace was hydrated before this fix shipped — content
// already in R2, no sentinel needed because it was never empty — NEVER goes
// through the seed path, so it never gets the file and the Turbopack fatal
// still greets it on every `next dev`.
//
// Fix: a SEPARATE, idempotent, existing-workspace-safe pass, run
// unconditionally after every successful hydrate in `ensureWorkspaceHydratedFromR2`
// (`src/index.ts`) — covers both the brand-new-workspace path (finds the
// config `seedWorkspaceIfAbsent`'s template copy just wrote, no-ops) and the
// pre-existing-workspace path this gap is actually about.
//
// No env var / CLI flag alternative exists: `turbopack.root` is read ONLY
// from the resolved `next.config.*` object (`next/dist/server/config.js`,
// confirmed against the exact Next.js version this template pins) — there is
// no `TURBOPACK_ROOT`-style environment variable Turbopack itself reads
// instead (checked: no match anywhere in `next/dist` for that or any
// `TURBOPACK_*`/`TURBO_*` root override). Writing the file is therefore not
// a preference, it is the only lever that exists.
//
// Safety, in order of priority:
//   1. NEVER overwrites a user's own config — checked BEFORE anything else,
//      across all three extensions Next.js itself accepts (`.js`/`.ts`/`.mjs`).
//      A config in any of the three counts as "has one"; only the exact
//      literal absence of all three is "has none".
//   2. NEVER touches a non-Next project — gated on `package.json` naming
//      `next` as a dependency (the one reliable signal available at hydrate
//      time, BEFORE `node_modules` exists: dependencies are not installed
//      until `start-devserver.sh` runs later in boot, so checking for an
//      installed `next` binary is not yet possible here).
//   3. Idempotent / no flush-loop churn: writes at most ONCE ever per
//      project — the very first hydrate after this ships. That write is
//      itself what `flushWorkspaceToR2` (`./workspace-persist.ts`) picks up
//      and persists to R2 on its next cycle, so every LATER hydrate
//      downloads the config as part of the workspace's own existing files
//      and this command's own existence check (step 1) short-circuits to a
//      no-op — never a second write, on this container or any other.

/** Every `next.config.*` extension Next.js itself resolves — see this section's doc comment, safety rule 1. */
export const NEXT_CONFIG_FILENAMES = ['next.config.js', 'next.config.ts', 'next.config.mjs'] as const;

/** In-image path (baked in by the Dockerfile, same as `buildTemplateCopyCommand`'s template dir) of the Turbopack-fixed config to copy in. */
export const TEMPLATE_NEXT_CONFIG_PATH = '/opt/ezil-sandbox-template/next.config.js';

/** `buildEnsureTurbopackConfigCommand`'s stdout marker: wrote the config into a Next project that had none. */
export const TURBOPACK_CONFIG_WRITTEN_MARKER = 'EZIL_TURBOPACK_CONFIG_WRITTEN';
/** `buildEnsureTurbopackConfigCommand`'s stdout marker: left an existing user config (any of the three extensions) untouched. */
export const TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER = 'EZIL_TURBOPACK_CONFIG_SKIPPED_EXISTING';
/** `buildEnsureTurbopackConfigCommand`'s stdout marker: not a Next.js project (no `package.json`, or no `next` dependency) — nothing to fix. */
export const TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER = 'EZIL_TURBOPACK_CONFIG_SKIPPED_NOT_NEXT';

/**
 * Build the shell snippet `ensureWorkspaceHydratedFromR2` execs, unconditionally,
 * after every successful hydrate. See this section's module doc comment above
 * for the full safety contract (never clobber a user config, never touch a
 * non-Next project, idempotent/no flush churn) — this function is the exact
 * shell encoding of those three rules, checked in order:
 *   1. any of `next.config.{js,ts,mjs}` already exists -> leave it, report
 *      `TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER`;
 *   2. else, `package.json` exists AND names `next` as a dependency -> copy
 *      the template's config in, report `TURBOPACK_CONFIG_WRITTEN_MARKER`;
 *   3. else -> not a Next project, report `TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER`.
 * Never fails the exec (no branch exits non-zero on its own), matching the
 * "must-not-fail-boot" convention `buildTemplateCopyCommand` already follows.
 *
 * `templateConfigPath` defaults to the real in-image path
 * (`TEMPLATE_NEXT_CONFIG_PATH`) for every production call site; it is an
 * explicit parameter (not a hardcoded literal in the body) SPECIFICALLY so
 * `workspace-seed.test.ts` can point it at a throwaway fixture file and run
 * the actual generated string through a real shell against a real temp
 * directory — proving the shell logic itself, not just the JS that builds
 * it — without touching the real `/opt/ezil-sandbox-template`.
 */
export function buildEnsureTurbopackConfigCommand(
  targetPath: string,
  templateConfigPath: string = TEMPLATE_NEXT_CONFIG_PATH,
): string {
  const hasConfig = NEXT_CONFIG_FILENAMES.map((name) => `[ -f "${targetPath}/${name}" ]`).join(' || ');
  return (
    `if ${hasConfig}; then ` +
    `echo ${TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER}; ` +
    `elif [ -f "${targetPath}/package.json" ] && grep -q "\\"next\\":" "${targetPath}/package.json"; then ` +
    `cp ${templateConfigPath} "${targetPath}/next.config.js" && echo ${TURBOPACK_CONFIG_WRITTEN_MARKER}; ` +
    `else echo ${TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER}; fi`
  );
}

/** The three possible outcomes `buildEnsureTurbopackConfigCommand`'s stdout can report — see that function's doc comment. */
export type TurbopackConfigOutcome = 'written' | 'skipped_existing_config' | 'skipped_not_next' | null;

/**
 * Parse `buildEnsureTurbopackConfigCommand`'s stdout into one of its three
 * declared outcomes, or `null` for anything unrecognized (e.g. `sandbox.exec`
 * itself failed before the command's own `echo` ran) — mirrors
 * `parseDevserverPhase`'s "unparseable is honestly unknown, never a guess"
 * convention.
 */
export function parseTurbopackConfigOutcome(stdout: string | undefined | null): TurbopackConfigOutcome {
  const trimmed = (stdout ?? '').trim();
  if (trimmed.includes(TURBOPACK_CONFIG_WRITTEN_MARKER)) return 'written';
  if (trimmed.includes(TURBOPACK_CONFIG_SKIPPED_EXISTING_MARKER)) return 'skipped_existing_config';
  if (trimmed.includes(TURBOPACK_CONFIG_SKIPPED_NOT_NEXT_MARKER)) return 'skipped_not_next';
  return null;
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
