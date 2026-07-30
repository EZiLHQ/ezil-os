/**
 * Pure (runtime-light) hydrate/flush logic that REPLACES `mountBucket()`'s s3fs
 * mount as the sandbox workspace persistence mechanism (`src/index.ts`'s
 * `ensureWorkspaceMount`).
 *
 * Factored out of `index.ts` — same split as `./hmac`, `./twen`,
 * `./workspace-diag`, `./project-files`, `./workspace-seed` — so the
 * diff/ignore/walk logic can be unit-tested with plain `bun test` against
 * in-memory fakes, without the Workers runtime or a real Sandbox/R2 bucket.
 *
 * ## Why s3fs is gone
 *
 * Mounting R2 via s3fs silently drops every SECOND write: 0 bytes, `exec`
 * exits 0. Root cause is inside Cloudflare's own in-DO S3 emulator
 * (`@cloudflare/sandbox`'s `r2EgressHandler`): the even write takes s3fs's
 * copy-based metadata-update path, which discards the request's
 * `x-amz-meta-*` custom metadata and gets rejected with a 403 that only
 * surfaces from FUSE `close(2)` — which shell redirection never checks, and
 * which s3fs's own retry logic does not retry (it only retries 5xx). No
 * retry wrapper is possible around VS Code/git/npm writing through the mount.
 * Present in the latest published `@cloudflare/sandbox` (0.12.4) — no upgrade
 * fixes it.
 *
 * ## The replacement
 *
 * `/workspace` becomes plain local container disk (no mount at all). R2 is
 * reached only through the Worker's own R2 BINDING (`env.SANDBOX_WORKSPACE_R2_BUCKET`),
 * which never goes through s3fs / the R2-egress emulator:
 *
 *   - `hydrateWorkspaceFromR2()` — on (re)boot, lists every object under the
 *     project/branch's R2 prefix and writes each one into the container's
 *     local disk via the Sandbox SDK's own file RPCs (`writeFile`/`mkdir` —
 *     the SAME `sandbox.*` object `index.ts` already calls `.exec()` on, no
 *     new transport).
 *   - `flushWorkspaceToR2()` — walks the local disk (skipping the ignore
 *     list) and `bucket.put()`s files whose size/mtime changed since the last
 *     flush, using the identical `${projectId}/branches/${branch}/${rel}` key
 *     scheme `/project-files/*` already writes with (see `./project-files`),
 *     so client-side and container-side writes land on the SAME R2 objects.
 *
 * ## THE DELETE HAZARD (read this before touching `flushWorkspaceToR2`)
 *
 * A flush that treats "absent locally" as "delete in R2" would DESTROY a
 * user's project the moment it ran against a partially-hydrated workspace
 * (cold container, hydrate still in flight, or a hydrate that failed
 * part-way through). Flush here is therefore structurally incapable of
 * deleting anything:
 *
 *   - `FlushR2BucketLike` (the ONLY R2 surface `flushWorkspaceToR2` is given)
 *     declares exactly one method, `put()`. There is no `delete` in its
 *     type — the compiler itself proves this module cannot call
 *     `bucket.delete(...)`, because there is nothing typed to call it on.
 *   - `flushWorkspaceToR2` never enumerates R2 objects at all (no `list()` /
 *     `get()` in `FlushR2BucketLike` either) — it has no way to notice, and
 *     therefore no way to react to, a file that exists in R2 but not locally.
 *   - Deletion handling is explicitly OUT OF SCOPE for this module. Future
 *     work (deleting an R2 object when a user deletes a local file) belongs
 *     behind explicit filesystem-delete events observed AFTER a
 *     verified-complete hydration — not here.
 *
 * `flushWorkspaceToR2` also refuses to run at all unless the caller asserts
 * `hydrationComplete: true` (see `FlushDeps`) — a flush against a
 * partially-hydrated workspace is skipped outright, not attempted.
 */

import { base64ToBytes, bytesToBase64 } from './project-files';
import { SEED_SENTINEL_FILENAME } from './workspace-seed';

// ── Ignore list (flush) ──────────────────────────────────────────────────────
//
// These directory NAMES (matched at any depth, exact basename match) are
// NEVER walked or uploaded by flush. `bun install` / the dev server / a
// template `cp -a` regenerate every one of them from source-controlled
// inputs already present after hydrate — so excluding them is a throughput
// requirement (whole files pass through the Durable Object one RPC call at a
// time; walking/uploading `node_modules` would dominate every flush cycle),
// not merely an optimization.
export const WORKSPACE_FLUSH_IGNORE_DIR_NAMES = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  '.turbo',
] as const;

export function isIgnoredDirName(name: string): boolean {
  return (WORKSPACE_FLUSH_IGNORE_DIR_NAMES as readonly string[]).includes(name);
}

/**
 * Root-level bookkeeping files this module itself writes into the workspace
 * (the hydrate-generation marker and the flush manifest cache). These are
 * container-local implementation detail, never real project content, and
 * must never be uploaded to R2 (nor would hydrate ever download them back —
 * they are never written to R2 in the first place, a closed loop).
 */
export const HYDRATE_MARKER_FILENAME = '.ezil-hydrated.json';
export const FLUSH_MANIFEST_FILENAME = '.ezil-flush-manifest.json';
const RESERVED_ROOT_FILENAMES: readonly string[] = [HYDRATE_MARKER_FILENAME, FLUSH_MANIFEST_FILENAME];

/**
 * R2-side-only heartbeat object key (basename), written unconditionally on
 * EVERY flush cycle that gets past the prefix/hydration gates — regardless
 * of whether any real project file changed that cycle.
 *
 * WHY THIS EXISTS: a computer-list UI derives "running / sleeping / off" from
 * how recently objects were flushed under a computer's R2 prefix, because
 * probing the live container directly costs several `sandbox.exec()` calls
 * and wakes it. If the flush cycle only touched R2 when a real file changed,
 * an actively-running-but-idle computer (nothing edited for a while) would
 * show a stale max-object-timestamp and read as "sleeping/off" even though
 * it is up and flushing successfully every cycle. This object's `uploaded`
 * timestamp is therefore the STABLE liveness signal to key the UI off of —
 * not the max mtime across all objects under the prefix, which is
 * content-driven and can go quiet for reasons that have nothing to do with
 * whether the computer is running.
 *
 * Lives ONLY in R2 (never written to/read from local disk) — hydrate skips
 * downloading it (see `hydrateWorkspaceFromR2`), exactly like the seed
 * sentinel, so it never round-trips into a real local file that flush would
 * then re-upload as if it were project content.
 */
export const WORKSPACE_HEARTBEAT_FILENAME = '.ezil-heartbeat';

// ── Hydrate: R2 → local disk ────────────────────────────────────────────────

export interface HydrateR2ObjectLike {
  key: string;
}

export interface HydrateR2ListResultLike {
  objects: HydrateR2ObjectLike[];
  truncated: boolean;
  cursor?: string;
}

export interface HydrateR2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Deliberately a MINIMAL structural subset of the real `R2Bucket` binding —
 * `list` + `get` only. Hydrate reads from R2; it never writes or deletes.
 */
export interface HydrateR2BucketLike {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<HydrateR2ListResultLike>;
  get(key: string): Promise<HydrateR2ObjectBodyLike | null>;
}

/**
 * Minimal structural subset of the Sandbox SDK's own file RPCs (the same
 * `sandbox` object `index.ts` already calls `.exec()` on — no new transport).
 * Hydrate only ever creates directories and writes files; it never deletes.
 */
export interface HydrateContainerLike {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
}

export interface HydrateDeps {
  bucket: HydrateR2BucketLike;
  container: HydrateContainerLike;
  /** R2 key prefix with NO leading slash, e.g. `${projectId}/branches/${branch}`. */
  realPrefix: string;
  /** Absolute in-container path the workspace lives at, e.g. `/workspace`. */
  mountPath: string;
  /** Loud, non-throwing logger — a per-file failure must never crash boot. */
  log: (message: string) => void;
  /** Page size for `bucket.list()` pagination. Defaults to 1000 (R2's own ceiling). */
  pageSize?: number;
}

export interface HydrateOutcome {
  /** True iff the R2 listing itself completed AND every listed object was written locally. */
  ok: boolean;
  /** True iff the R2 listing completed (even if some individual files then failed to write). */
  listOk: boolean;
  filesWritten: number;
  filesFailed: number;
  /** True when the prefix had zero real objects (sentinel aside) — nothing to hydrate. */
  emptyPrefix: boolean;
}

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/**
 * Download every object under `realPrefix` (except the seed sentinel) into
 * `mountPath` on local container disk. Never deletes, never lists R2 objects
 * outside the given prefix, and continues past individual file failures
 * (logging each loudly) rather than aborting the whole pass — a single
 * corrupt/oversized object must not block every other file from hydrating.
 */
export async function hydrateWorkspaceFromR2(deps: HydrateDeps): Promise<HydrateOutcome> {
  const { bucket, container, realPrefix, mountPath, log } = deps;
  const pageSize = deps.pageSize ?? 1000;

  // Prefix isolation is security-critical: each computer/project is a
  // distinct R2 prefix, and `bucket.list({ prefix: '' })` matches the ENTIRE
  // bucket — every other user's/project's files. This function must NEVER
  // widen or default the prefix it was given; if it were ever called with an
  // empty/falsy prefix, refuse outright rather than silently operating
  // bucket-wide. (Callers are responsible for never passing one — this is a
  // defense-in-depth backstop, not a fix for any known caller bug.)
  if (!realPrefix) {
    log('[hydrateWorkspaceFromR2] REFUSING to hydrate: realPrefix is empty — would list/read the ENTIRE bucket');
    return { ok: false, listOk: false, filesWritten: 0, filesFailed: 0, emptyPrefix: false };
  }

  const sentinelKey = `${realPrefix}/${SEED_SENTINEL_FILENAME}`;
  const heartbeatKey = `${realPrefix}/${WORKSPACE_HEARTBEAT_FILENAME}`;

  let filesWritten = 0;
  let filesFailed = 0;
  let sawAnyObject = false;
  let cursor: string | undefined;
  let listOk = true;

  do {
    let page: HydrateR2ListResultLike;
    try {
      page = await bucket.list({ prefix: realPrefix, cursor, limit: pageSize });
    } catch (err) {
      log(
        `[hydrateWorkspaceFromR2] R2 list FAILED (prefix=${realPrefix}, cursor=${cursor ?? '<start>'}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      listOk = false;
      break;
    }

    for (const object of page.objects) {
      if (object.key === sentinelKey || object.key === heartbeatKey) continue; // internal bookkeeping only, never a real file
      sawAnyObject = true;
      // `realPrefix` is guaranteed non-empty (guarded above), so a key that
      // does NOT start with `${realPrefix}/` cannot legitimately belong to
      // this project/branch — skip it loudly rather than ever writing it
      // somewhere under THIS workspace's local disk (would cross-contaminate
      // one project's container with another's file path).
      if (!object.key.startsWith(`${realPrefix}/`)) {
        log(`[hydrateWorkspaceFromR2] SKIPPING out-of-prefix key from list() result: ${object.key} (expected prefix ${realPrefix}/)`);
        continue;
      }
      const relPath = object.key.slice(realPrefix.length + 1);
      if (!relPath) continue;

      const targetPath = `${mountPath}/${relPath}`;
      try {
        const body = await bucket.get(object.key);
        if (!body) {
          // Deleted between list() and get() — not an error, just skip it this pass.
          continue;
        }
        const bytes = new Uint8Array(await body.arrayBuffer());
        const parentDir = dirnameOf(targetPath);
        if (parentDir && parentDir !== mountPath) {
          await container.mkdir(parentDir, { recursive: true });
        }
        await container.writeFile(targetPath, bytesToBase64(bytes), { encoding: 'base64' });
        filesWritten++;
      } catch (err) {
        filesFailed++;
        log(
          `[hydrateWorkspaceFromR2] FAILED to hydrate key=${object.key} -> ${targetPath}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return {
    ok: listOk && filesFailed === 0,
    listOk,
    filesWritten,
    filesFailed,
    emptyPrefix: !sawAnyObject,
  };
}

// ── Flush: local disk → R2 ───────────────────────────────────────────────────

export interface FlushFileInfoLike {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modifiedAt: string;
}

export interface FlushListFilesResultLike {
  files: FlushFileInfoLike[];
}

export interface FlushReadFileResultLike {
  content: string;
  /** 'base64' for binary content, anything else (or absent) treated as UTF-8 text. */
  encoding?: string;
}

/**
 * Minimal structural subset of the Sandbox SDK's own file RPCs. Note there is
 * no `deleteFile` here — flush never removes anything from local disk either.
 */
export interface FlushContainerLike {
  listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<FlushListFilesResultLike>;
  readFile(path: string, options?: { encoding?: string }): Promise<FlushReadFileResultLike>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
  exists(path: string): Promise<{ exists: boolean }>;
}

export interface FlushR2PutResultLike {
  etag?: string;
}

/**
 * THE delete-hazard guardrail: this type is the ENTIRE R2 surface
 * `flushWorkspaceToR2` is given. It declares exactly one method. There is no
 * `delete`, no `list`, no `get` — the compiler itself is the proof that this
 * module cannot issue a delete (nor even discover what R2 currently holds).
 */
export interface FlushR2BucketLike {
  put(key: string, value: Uint8Array): Promise<FlushR2PutResultLike | null>;
}

export interface FlushManifestEntry {
  size: number;
  modifiedAt: string;
}

/** relPath -> last-flushed {size, modifiedAt}. */
export type FlushManifest = Record<string, FlushManifestEntry>;

export interface RelFileInfo {
  relPath: string;
  size: number;
  modifiedAt: string;
}

/**
 * Directory-lister the walker needs — just the `listFiles` slice of
 * `FlushContainerLike`, so `walkWorkspaceTree` can be exercised in isolation
 * from read/write/exists with a narrower fake.
 */
export type WalkFileInfoLike = FlushFileInfoLike;
export type WalkListFilesResultLike = FlushListFilesResultLike;
export type WalkContainerLike = Pick<FlushContainerLike, 'listFiles'>;

export interface WalkResult {
  files: RelFileInfo[];
  skippedIgnoredDirs: number;
  skippedUnsupported: number;
}

/**
 * Walk the workspace tree WITHOUT ever descending into an ignored directory
 * (`node_modules`, `.git`, ...) — a throughput requirement, not an
 * optimization: the Sandbox file RPCs have no server-side exclude-glob for
 * `listFiles`, so the only way to avoid enumerating a multi-thousand-file
 * `node_modules` tree is to never issue the recursive call in the first
 * place. Each directory is listed non-recursively; only entries whose name
 * is NOT in the ignore list are recursed into.
 */
export async function walkWorkspaceTree(container: WalkContainerLike, mountPath: string): Promise<WalkResult> {
  const files: RelFileInfo[] = [];
  let skippedIgnoredDirs = 0;
  let skippedUnsupported = 0;

  // [absolutePath, relPathPrefix] queue — BFS, bounded by directory count, not
  // total file count (ignored subtrees are never enqueued).
  const queue: Array<{ absPath: string; relPrefix: string }> = [{ absPath: mountPath, relPrefix: '' }];
  const MAX_DIRS = 200_000; // pathological-input guard, not a normal-case ceiling
  let dirsVisited = 0;

  while (queue.length > 0) {
    const { absPath, relPrefix } = queue.shift()!;
    dirsVisited++;
    if (dirsVisited > MAX_DIRS) break;

    const listing = await container.listFiles(absPath, { recursive: false, includeHidden: true });
    for (const entry of listing.files) {
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      if (entry.type === 'directory') {
        if (isIgnoredDirName(entry.name)) {
          skippedIgnoredDirs++;
          continue;
        }
        queue.push({ absPath: `${absPath}/${entry.name}`, relPrefix: relPath });
        continue;
      }

      if (entry.type !== 'file') {
        // symlink/other: no well-defined "read bytes, base64, re-create"
        // semantics here — skip rather than risk misreading a symlink target.
        skippedUnsupported++;
        continue;
      }

      if (RESERVED_ROOT_FILENAMES.includes(relPath)) continue; // our own bookkeeping, never flushed

      files.push({ relPath, size: entry.size, modifiedAt: entry.modifiedAt });
    }
  }

  return { files, skippedIgnoredDirs, skippedUnsupported };
}

export interface FlushPlan {
  changed: RelFileInfo[];
  unchangedCount: number;
}

/** Pure diff: a file is "changed" iff absent from the manifest or its size/modifiedAt differ. */
export function computeFlushPlan(files: RelFileInfo[], manifest: FlushManifest): FlushPlan {
  const changed: RelFileInfo[] = [];
  let unchangedCount = 0;
  for (const file of files) {
    const prior = manifest[file.relPath];
    if (prior && prior.size === file.size && prior.modifiedAt === file.modifiedAt) {
      unchangedCount++;
    } else {
      changed.push(file);
    }
  }
  return { changed, unchangedCount };
}

export interface FlushDeps {
  container: FlushContainerLike;
  bucket: FlushR2BucketLike;
  /** Absolute in-container path the workspace lives at, e.g. `/workspace`. */
  mountPath: string;
  /** R2 key prefix with NO leading slash, e.g. `${projectId}/branches/${branch}`. */
  realPrefix: string;
  /** Last-known manifest (from a prior flush this container's lifetime). Not mutated. */
  manifest: FlushManifest;
  /**
   * MUST be true or this function does nothing at all. Set by the caller from
   * the recorded outcome of the most recent `hydrateWorkspaceFromR2` call —
   * flushing a partially-hydrated (or never-hydrated) workspace risks
   * uploading incomplete/inconsistent local state over good R2 content. See
   * module doc — this is the "gate flush on hydration success" requirement.
   */
  hydrationComplete: boolean;
  log: (message: string) => void;
}

export interface FlushOutcome {
  ok: boolean;
  uploaded: string[];
  skippedUnchanged: number;
  skippedIgnored: number;
  skippedUnsupported: number;
  failed: Array<{ relPath: string; error: string }>;
  /** Updated manifest the caller should persist for the next flush cycle. */
  manifest: FlushManifest;
  skippedReason?: 'hydration_incomplete' | 'empty_prefix';
  /** True iff the `.ezil-heartbeat` liveness object was written this cycle (see `WORKSPACE_HEARTBEAT_FILENAME`). */
  heartbeatWritten: boolean;
}

/**
 * Upload every LOCAL file that changed since the last flush to R2, under the
 * SAME `${realPrefix}/${relPath}` key scheme `/project-files/*` writes with.
 *
 * STRICTLY ADDITIVE/UPDATING — see the module doc's "THE DELETE HAZARD"
 * section for why this function is structurally incapable of deleting
 * anything from R2 (`FlushR2BucketLike` has no delete-shaped method at all).
 */
export async function flushWorkspaceToR2(deps: FlushDeps): Promise<FlushOutcome> {
  const { container, bucket, mountPath, realPrefix, log } = deps;

  // Prefix isolation is security-critical (each computer/project is a
  // distinct R2 prefix). An empty `realPrefix` would make every uploaded key
  // land at the BUCKET ROOT, indistinguishable from — and colliding with —
  // every other computer/project that ever hit this same bug. Refuse
  // outright rather than ever defaulting/widening. Checked BEFORE the
  // hydration-complete gate: this is the more fundamental of the two safety
  // conditions.
  if (!realPrefix) {
    log('[flushWorkspaceToR2] REFUSING to flush: realPrefix is empty — would write to the bucket root');
    return {
      ok: false,
      uploaded: [],
      skippedUnchanged: 0,
      skippedIgnored: 0,
      skippedUnsupported: 0,
      failed: [],
      manifest: deps.manifest,
      skippedReason: 'empty_prefix',
      heartbeatWritten: false,
    };
  }

  if (!deps.hydrationComplete) {
    log('[flushWorkspaceToR2] skipped: hydration not recorded complete for this workspace');
    return {
      ok: false,
      uploaded: [],
      skippedUnchanged: 0,
      skippedIgnored: 0,
      skippedUnsupported: 0,
      failed: [],
      manifest: deps.manifest,
      skippedReason: 'hydration_incomplete',
      heartbeatWritten: false,
    };
  }

  const walk = await walkWorkspaceTree(container, mountPath);
  const plan = computeFlushPlan(walk.files, deps.manifest);

  const uploaded: string[] = [];
  const failed: Array<{ relPath: string; error: string }> = [];
  const newManifest: FlushManifest = {};

  // Carry forward manifest entries for files that are unchanged AND still
  // present (drops entries for files no longer present locally — a harmless
  // cache cleanup; it never causes an R2 delete, it only affects whether a
  // FUTURE reappearance of that relPath is treated as "changed").
  for (const file of walk.files) {
    const prior = deps.manifest[file.relPath];
    if (prior && prior.size === file.size && prior.modifiedAt === file.modifiedAt) {
      newManifest[file.relPath] = prior;
    }
  }

  for (const file of plan.changed) {
    const absPath = `${mountPath}/${file.relPath}`;
    try {
      const read = await container.readFile(absPath);
      const bytes = read.encoding === 'base64' ? base64ToBytes(read.content) : new TextEncoder().encode(read.content);
      const key = `${realPrefix}/${file.relPath}`;
      await bucket.put(key, bytes);
      uploaded.push(file.relPath);
      newManifest[file.relPath] = { size: file.size, modifiedAt: file.modifiedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[flushWorkspaceToR2] FAILED to upload relPath=${file.relPath}: ${message}`);
      failed.push({ relPath: file.relPath, error: message });
      // Deliberately NOT added to newManifest — a failed upload must be
      // retried on the next cycle, not silently treated as "already synced".
    }
  }

  // Unconditional liveness heartbeat — written on EVERY cycle that gets past
  // the gates above, regardless of whether any real project file changed.
  // See `WORKSPACE_HEARTBEAT_FILENAME`'s doc comment for why: a computer-list
  // UI derives running/sleeping/off from R2 object recency, and a real-file
  // no-op cycle (nothing edited) must still advance a timestamp somewhere
  // under the prefix, or an idle-but-running computer would misreport as
  // sleeping/off. Best-effort: a heartbeat failure is logged loudly but must
  // not flip `ok` (that stays about file-upload/hydration correctness).
  let heartbeatWritten = false;
  try {
    const heartbeatKey = `${realPrefix}/${WORKSPACE_HEARTBEAT_FILENAME}`;
    await bucket.put(heartbeatKey, new TextEncoder().encode(new Date().toISOString()));
    heartbeatWritten = true;
  } catch (err) {
    log(`[flushWorkspaceToR2] heartbeat write FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    ok: failed.length === 0,
    uploaded,
    skippedUnchanged: plan.unchangedCount,
    skippedIgnored: walk.skippedIgnoredDirs,
    skippedUnsupported: walk.skippedUnsupported,
    failed,
    manifest: newManifest,
    heartbeatWritten,
  };
}

// ── Hydrate-generation marker (local disk only, never uploaded to R2) ───────

export interface HydrateMarker {
  prefix: string;
  mountPath: string;
  hydratedAt: string;
}

export function parseHydrateMarker(raw: string): HydrateMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<HydrateMarker>;
    if (typeof parsed.prefix === 'string' && typeof parsed.mountPath === 'string' && typeof parsed.hydratedAt === 'string') {
      return { prefix: parsed.prefix, mountPath: parsed.mountPath, hydratedAt: parsed.hydratedAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function serializeHydrateMarker(marker: HydrateMarker): string {
  return JSON.stringify(marker);
}

// ── Flush manifest (de)serialization (local disk cache, never uploaded) ─────

export function parseFlushManifest(raw: string): FlushManifest {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: FlushManifest = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const entry = value as Partial<FlushManifestEntry> | undefined;
        if (entry && typeof entry.size === 'number' && typeof entry.modifiedAt === 'string') {
          out[key] = { size: entry.size, modifiedAt: entry.modifiedAt };
        }
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

export function serializeFlushManifest(manifest: FlushManifest): string {
  return JSON.stringify(manifest);
}
