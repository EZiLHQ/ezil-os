/**
 * Versioned workspace checkpoints: immutable, bounded tar chunks followed by one
 * conditional R2 manifest put. The manifest is the commit point. Missing files
 * are deletions; older blobs are never consulted or merged during restore.
 *
 * The container codec preserves Git metadata, modes and safe relative links.
 * It checks for concurrent edits before publication. A checkpoint is a point in
 * time, not a filesystem journal: edits after it still require another flush.
 */
import { base64ToBytes, bytesToBase64 } from './project-files';
import { SEED_SENTINEL_FILENAME } from './workspace-seed';
import { snapshotCommand } from './workspace-snapshot-script';

export const HYDRATE_MARKER_FILENAME = '.ezil-hydrated.json';
export const FLUSH_MANIFEST_FILENAME = '.ezil-flush-manifest.json';
export const WORKSPACE_HEARTBEAT_FILENAME = '.ezil-heartbeat';
export const SNAPSHOT_HEAD = '.ezil-snapshots/latest.json';
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNKS = 512;
const MAX_ENTRIES = 100_000;
const HASH = /^[a-f0-9]{64}$/;
const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();

export interface Snapshot {
  version: 1;
  generation: string;
  /** Immutable chunk owner; a no-op commit still advances the writer fence. */
  chunkGeneration?: string;
  /** Chunk owner of the previously committed head; garbage collection keeps it as the fallback. */
  previousChunkGeneration?: string;
  sha256: string;
  entries: number;
  chunks: Array<{ size: number; sha256: string }>;
}
export interface HydrateR2ObjectBodyLike {
  etag?: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}
export interface HydrateR2BucketLike {
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size?: number }>;
    truncated: boolean;
    cursor?: string;
  }>;
  /** `range` reads part of an object (R2 binding / S3 Range); used only for large legacy objects. */
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<HydrateR2ObjectBodyLike | null>;
}
export interface FlushR2BucketLike {
  get(key: string): Promise<HydrateR2ObjectBodyLike | null>;
  put(key: string, value: Uint8Array, options?: {
    onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  }): Promise<{ etag?: string } | null>;
}
export interface HydrateContainerLike {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<unknown>;
  exec(command: string, options?: { timeout?: number }): Promise<{ exitCode: number; stdout: string; stderr?: string }>;
}
export interface FlushContainerLike extends HydrateContainerLike {
  readFile(path: string, options?: { encoding?: string }): Promise<{ content: string; encoding?: string }>;
  exists(path: string): Promise<{ exists: boolean }>;
}
// Retained for DO cache compatibility; never trusted to skip byte verification.
export type FlushManifest = Record<string, { size: number; modifiedAt: string }>;
export interface FlushOutcome {
  ok: boolean;
  uploaded: string[];
  skippedUnchanged: number;
  skippedIgnored: number;
  skippedUnsupported: number;
  failed: Array<{ relPath: string; error: string }>;
  manifest: FlushManifest;
  /**
   * 'too_large': the workspace exceeds the snapshot limits (512 MiB / 100,000
   * entries). Permanent; callers must not wait for it to succeed.
   */
  skippedReason?: 'hydration_incomplete' | 'empty_prefix' | 'flush_threw' | 'deferred' | 'too_large';
  heartbeatWritten: boolean;
  checkpoint?: string;
}
export interface HydrateOutcome {
  ok: boolean;
  listOk: boolean;
  filesWritten: number;
  filesFailed: number;
  emptyPrefix: boolean;
  /** Legacy objects left in the store and NOT imported (unsafe/reserved names). Visible, never fatal. */
  skippedUnsafe?: number;
}
export interface HydrateDeps {
  bucket: HydrateR2BucketLike;
  container: HydrateContainerLike;
  realPrefix: string;
  mountPath: string;
  log: (message: string) => void;
  pageSize?: number;
}
export interface FlushDeps {
  container: FlushContainerLike;
  bucket: FlushR2BucketLike;
  mountPath: string;
  realPrefix: string;
  manifest: FlushManifest;
  hydrationComplete: boolean;
  log: (message: string) => void;
  /**
   * Rate limit: a CHANGED workspace is captured but not uploaded
   * (skippedReason 'deferred'). Never applies to the first checkpoint. The
   * caller enables it only for routine alarm cycles, never for readiness,
   * teardown or idle-stop checkpoints.
   */
  deferIfChanged?: boolean;
}

export function parseSnapshot(raw: string): Snapshot {
  let s: Snapshot;
  try { s = JSON.parse(raw) as Snapshot; }
  catch { throw new Error('invalid workspace snapshot manifest'); }
  if (!s || s.version !== SNAPSHOT_VERSION || !GENERATION.test(s.generation) || !HASH.test(s.sha256)
    || (s.chunkGeneration !== undefined && !GENERATION.test(s.chunkGeneration))
    || (s.previousChunkGeneration !== undefined && !GENERATION.test(s.previousChunkGeneration))
    || !Number.isInteger(s.entries) || s.entries < 0 || s.entries > MAX_ENTRIES
    || !Array.isArray(s.chunks) || !s.chunks.length || s.chunks.length > MAX_CHUNKS
    || s.chunks.some(c => !c || !HASH.test(c.sha256) || !Number.isInteger(c.size) || c.size <= 0 || c.size > SNAPSHOT_CHUNK_BYTES)) {
    throw new Error('invalid workspace snapshot manifest');
  }
  return s;
}
function validPrefix(prefix: string): boolean {
  return !!prefix && prefix.split('/').every(p => p && p !== '.' && p !== '..');
}
/** Largest legacy object read in one piece; larger ones are imported in ranges. */
const LEGACY_INLINE_BYTES = 8 * SNAPSHOT_CHUNK_BYTES;
function legacyImportable(rel: string): boolean {
  return safeRelative(rel) && ![HYDRATE_MARKER_FILENAME, FLUSH_MANIFEST_FILENAME].includes(rel.split('/')[0]!);
}
function safeRelative(path: string): boolean {
  return !!path && !/[\\\x00-\x1f\x7f]/.test(path) && path.split('/').every(p => p && p !== '.' && p !== '..');
}
async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(b => b.toString(16).toLowerCase().padStart(2, '0')).join('');
}
async function readBounded(body: HydrateR2ObjectBodyLike, limit: number): Promise<Uint8Array> {
  // R2ObjectBody always includes size. Refuse an unknown bound before buffering.
  if (typeof body.size !== 'number' || !Number.isInteger(body.size) || body.size < 0 || body.size > limit) throw new Error('snapshot object too large');
  const bytes = new Uint8Array(await body.arrayBuffer());
  if (bytes.length > limit) throw new Error('snapshot object too large');
  return bytes;
}
async function readHead(bucket: Pick<HydrateR2BucketLike, 'get'>, prefix: string) {
  const body = await bucket.get(`${prefix}/${SNAPSHOT_HEAD}`);
  if (!body) return null;
  const snapshot = parseSnapshot(new TextDecoder().decode(await readBounded(body, 128 * 1024)));
  if (!body.etag) throw new Error('snapshot manifest etag missing');
  return { snapshot, etag: body.etag };
}
class SnapshotTooLargeError extends Error {}
async function command(container: HydrateContainerLike, params: Record<string, unknown>) {
  const result = await container.exec(snapshotCommand(params), { timeout: 120_000 });
  if (result.exitCode === 3 && params.op === 'capture') throw new SnapshotTooLargeError('workspace snapshot too large');
  if (result.exitCode !== 0) throw new Error(`workspace snapshot ${params.op} failed`);
  return result.stdout;
}
function requireSdkSuccess(result: unknown): void {
  if (result && typeof result === 'object' && 'success' in result && result.success === false) {
    throw new Error('workspace file operation failed');
  }
}
function chunkKey(prefix: string, generation: string, index: number): string {
  return `${prefix}/.ezil-snapshots/${generation}/${index}`;
}

export async function flushWorkspaceToR2(deps: FlushDeps): Promise<FlushOutcome> {
  const { bucket, container, mountPath: root, realPrefix: prefix, log } = deps;
  const outcome: FlushOutcome = { ok: false, uploaded: [], skippedUnchanged: 0,
    skippedIgnored: 0, skippedUnsupported: 0, failed: [], manifest: {}, heartbeatWritten: false };
  if (!validPrefix(prefix)) return { ...outcome, skippedReason: 'empty_prefix' };
  if (!deps.hydrationComplete) return { ...outcome, skippedReason: 'hydration_incomplete' };
  const generation = crypto.randomUUID();
  const work = `/tmp/ezil-snapshot-${generation}`;
  try {
    // Read before capture: CAS rejects another container publishing in between.
    const previous = await readHead(bucket, prefix);
    const expected = previous?.snapshot.generation ?? null;
    const raw = await command(container, { op: 'capture', root, work, prefix, expected });
    const { skipped, ...captured } = JSON.parse(raw) as Record<string, unknown>;
    outcome.skippedUnsupported = Number.isInteger(skipped) ? skipped as number : 0;
    if (outcome.skippedUnsupported) log(`[workspace-persist] ${outcome.skippedUnsupported} unsupported entries (unsafe names, escaping links, special files) not checkpointed`);
    const snapshot = parseSnapshot(JSON.stringify({ ...captured, version: SNAPSHOT_VERSION, generation }));
    if (deps.deferIfChanged && previous && previous.snapshot.sha256 !== snapshot.sha256) {
      outcome.skippedReason = 'deferred';
      return outcome; // `finally` still removes the staging directory
    }
    if (previous?.snapshot.sha256 !== snapshot.sha256) {
      for (const [i, c] of snapshot.chunks.entries()) {
        const file = await container.readFile(`${work}/${i}`, { encoding: 'base64' });
        if (file.encoding !== 'base64') throw new Error('snapshot chunk encoding missing');
        const bytes = base64ToBytes(file.content);
        if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('corrupt snapshot chunk');
        const key = chunkKey(prefix, generation, i);
        if (!await bucket.put(key, bytes)) throw new Error('snapshot chunk upload rejected');
        outcome.uploaded.push(key);
      }
    } else {
      // Immutable keys may still have been deleted/corrupted externally. A
      // no-op must confirm durable bytes, not just trust the manifest hash.
      for (const [i, c] of previous.snapshot.chunks.entries()) {
        const body = await bucket.get(chunkKey(prefix, previous.snapshot.chunkGeneration ?? previous.snapshot.generation, i));
        if (!body) throw new Error('snapshot chunk missing');
        const bytes = await readBounded(body, SNAPSHOT_CHUNK_BYTES);
        if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('corrupt snapshot chunk');
      }
      outcome.skippedUnchanged = snapshot.entries;
    }
    // Re-read the tree, including contents/modes/Git index, after network I/O.
    await command(container, { op: 'verify', root, work, prefix, expected, sha256: snapshot.sha256 });
    // Even a no-op checkpoint uses CAS: it must not confirm a stale head.
    const committed: Snapshot = previous?.snapshot.sha256 === snapshot.sha256
      ? { ...snapshot, chunkGeneration: previous.snapshot.chunkGeneration ?? previous.snapshot.generation,
          ...(previous.snapshot.previousChunkGeneration ? { previousChunkGeneration: previous.snapshot.previousChunkGeneration } : {}) }
      : { ...snapshot, ...(previous ? { previousChunkGeneration: previous.snapshot.chunkGeneration ?? previous.snapshot.generation } : {}) };
    const put = await bucket.put(`${prefix}/${SNAPSHOT_HEAD}`, encoder.encode(JSON.stringify(committed)), {
      onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    });
    if (!put) throw new Error('workspace checkpoint conflict');
    await command(container, { op: 'confirm', root, work, prefix, expected, generation: committed.generation });
    outcome.checkpoint = committed.generation;
    outcome.ok = true;
    try {
      outcome.heartbeatWritten = !!await bucket.put(`${prefix}/${WORKSPACE_HEARTBEAT_FILENAME}`, encoder.encode(new Date().toISOString()));
    } catch { log('[workspace-persist] heartbeat failed after committed checkpoint'); }
  } catch (err) {
    if (err instanceof SnapshotTooLargeError) outcome.skippedReason = 'too_large';
    // SDK/R2 errors and malformed JSON can contain file bytes or credentials.
    const error = err instanceof SnapshotTooLargeError ? 'workspace too large to checkpoint' : 'workspace checkpoint failed';
    log(`[workspace-persist] ${error}`);
    outcome.failed.push({ relPath: SNAPSHOT_HEAD, error });
  } finally {
    try { await command(container, { op: 'cleanup', root, work }); }
    catch { log('[workspace-persist] snapshot staging cleanup failed'); }
  }
  return outcome;
}

export async function hydrateWorkspaceFromR2(deps: HydrateDeps): Promise<HydrateOutcome> {
  const { bucket, container, mountPath: root, realPrefix: prefix, log } = deps;
  const outcome: HydrateOutcome = { ok: false, listOk: false, filesWritten: 0, filesFailed: 0, emptyPrefix: false };
  if (!validPrefix(prefix)) return outcome;
  const work = `/tmp/ezil-snapshot-${crypto.randomUUID()}`;
  const marker: HydrateMarker = { version: 1, prefix, mountPath: root, hydratedAt: new Date().toISOString() };
  try {
    const head = await readHead(bucket, prefix);
    if (head) {
      await container.mkdir(work, { recursive: false });
      for (const [i, c] of head.snapshot.chunks.entries()) {
        const body = await bucket.get(chunkKey(prefix, head.snapshot.chunkGeneration ?? head.snapshot.generation, i));
        if (!body) throw new Error('snapshot chunk missing');
        const bytes = await readBounded(body, SNAPSHOT_CHUNK_BYTES);
        if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('snapshot chunk corrupt');
        requireSdkSuccess(await container.writeFile(`${work}/${i}`, bytesToBase64(bytes), { encoding: 'base64' }));
      }
      if ((await readHead(bucket, prefix))?.etag !== head.etag) throw new Error('workspace checkpoint changed');
      await command(container, { op: 'restore', root, work, snapshot: head.snapshot,
        marker: { ...marker, checkpoint: head.snapshot.generation } });
      if ((await readHead(bucket, prefix))?.etag !== head.etag) throw new Error('workspace checkpoint changed');
      return { ...outcome, ok: true, listOk: true, filesWritten: head.snapshot.entries };
    }
    // One-time legacy import. Never merge loose keys into a committed snapshot.
    // A sentinel without content, incomplete pagination, or orphan snapshot
    // chunks is not proof of an empty workspace and must not authorize a seed.
    const keys: string[] = [];
    const sizes = new Map<string, number>();
    let skippedUnsafe = 0;
    let orphanChunks = 0;
    const seenKeys = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let bookkeeping = false;
    do {
      const page = await bucket.list({ prefix: `${prefix}/`, cursor, limit: deps.pageSize ?? 1000 });
      for (const object of page.objects) {
        if (!object.key.startsWith(`${prefix}/`)) throw new Error('out-of-prefix object');
        const rel = object.key.slice(prefix.length + 1);
        // No head means no snapshot was ever committed (acknowledged): chunks
        // left by a checkpoint that failed before its head put are not data.
        if (rel.startsWith('.ezil-snapshots/')) { orphanChunks++; continue; }
        if ([SEED_SENTINEL_FILENAME, WORKSPACE_HEARTBEAT_FILENAME].includes(rel)) { bookkeeping = true; continue; }
        // Names the codec cannot restore safely stay in the store untouched
        // (recoverable) and are reported; they must not lock the user out.
        if (!legacyImportable(rel)) { skippedUnsafe++; continue; }
        if (seenKeys.has(rel) || keys.length >= MAX_ENTRIES) throw new Error('invalid legacy listing');
        seenKeys.add(rel);
        keys.push(rel);
        sizes.set(rel, typeof object.size === 'number' ? object.size : -1);
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (page.truncated && (!cursor || cursors.has(cursor))) throw new Error('incomplete legacy listing');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    outcome.listOk = true;
    outcome.skippedUnsafe = skippedUnsafe;
    if (skippedUnsafe) log(`[workspace-persist] ${skippedUnsafe} legacy objects with unsafe names left in place, not imported`);
    if (orphanChunks) log(`[workspace-persist] ${orphanChunks} uncommitted snapshot chunks ignored`);
    if (!keys.length) {
      // Only bookkeeping or uncommitted chunks: no user content was ever made
      // durable, so the workspace is empty (what main's copy-sync restored too).
      return { ...outcome, ok: true, emptyPrefix: !bookkeeping && !orphanChunks, skippedUnsafe };
    }
    const stage = `${root}.ezil-legacy-${work.slice('/tmp/ezil-snapshot-'.length)}`;
    await container.mkdir(work, { recursive: false });
    await container.mkdir(stage, { recursive: false });
    let total = 0;
    const versions = new Map<string, string>();
    try {
      for (const rel of keys) {
        const parent = rel.lastIndexOf('/');
        if (parent !== -1) await container.mkdir(`${stage}/${rel.slice(0, parent)}`, { recursive: true });
        const listedSize = sizes.get(rel) ?? -1;
        if (listedSize > LEGACY_INLINE_BYTES) {
          // main stored files whole, with no size cap. Stream them in bounded
          // ranges so neither the Durable Object nor one SDK call holds the file.
          let version: string | undefined;
          for (let offset = 0; offset < listedSize; offset += SNAPSHOT_CHUNK_BYTES) {
            const length = Math.min(SNAPSHOT_CHUNK_BYTES, listedSize - offset);
            const part = await bucket.get(`${prefix}/${rel}`, { range: { offset, length } });
            if (!part) throw new Error('legacy object disappeared');
            if (!part.etag || (version !== undefined && part.etag !== version)) throw new Error('legacy workspace changed');
            version = part.etag;
            const bytes = new Uint8Array(await part.arrayBuffer());
            if (bytes.length !== length) throw new Error('legacy range read short');
            total += length;
            if (total > MAX_CHUNKS * SNAPSHOT_CHUNK_BYTES) throw new Error('legacy workspace too large');
            const partPath = `${work}/legacy-part`;
            requireSdkSuccess(await container.writeFile(partPath, bytesToBase64(bytes), { encoding: 'base64' }));
            await command(container, { op: 'append', root, work, stage, rel, part: partPath, create: offset === 0 });
          }
          versions.set(rel, version!);
          continue;
        }
        const body = await bucket.get(`${prefix}/${rel}`);
        if (!body) throw new Error('legacy object disappeared');
        if (!body.etag) throw new Error('legacy version missing');
        versions.set(rel, body.etag);
        const bytes = await readBounded(body, LEGACY_INLINE_BYTES);
        total += bytes.length;
        if (total > MAX_CHUNKS * SNAPSHOT_CHUNK_BYTES) throw new Error('legacy workspace too large');
        requireSdkSuccess(await container.writeFile(`${stage}/${rel}`, bytesToBase64(bytes), { encoding: 'base64' }));
      }
      // Legacy storage has no atomic manifest. Refuse a changed listing or
      // changed object rather than publish an import known to be stale.
      const remaining = new Set(keys);
      let checkCursor: string | undefined;
      const checkedCursors = new Set<string>();
      do {
        const page = await bucket.list({ prefix: `${prefix}/`, cursor: checkCursor, limit: deps.pageSize ?? 1000 });
        for (const object of page.objects) {
          if (!object.key.startsWith(`${prefix}/`)) throw new Error('out-of-prefix object');
          const rel = object.key.slice(prefix.length + 1);
          if ([SEED_SENTINEL_FILENAME, WORKSPACE_HEARTBEAT_FILENAME].includes(rel)) continue;
          if (rel.startsWith('.ezil-snapshots/') || !legacyImportable(rel)) continue;
          if (!remaining.delete(rel)) throw new Error('legacy workspace changed');
          // A one-byte range is enough to compare the version without re-reading the file.
          const body = await bucket.get(object.key, (sizes.get(rel) ?? 0) > LEGACY_INLINE_BYTES ? { range: { offset: 0, length: 1 } } : undefined);
          if (!body || body.etag !== versions.get(rel)) throw new Error('legacy workspace changed');
        }
        checkCursor = page.truncated ? page.cursor : undefined;
        if (page.truncated && (!checkCursor || checkedCursors.has(checkCursor))) throw new Error('incomplete legacy listing');
        if (checkCursor) checkedCursors.add(checkCursor);
      } while (checkCursor);
      if (remaining.size) throw new Error('legacy workspace changed');
      requireSdkSuccess(await container.writeFile(`${stage}/${HYDRATE_MARKER_FILENAME}`, serializeHydrateMarker(marker)));
      if (await readHead(bucket, prefix)) throw new Error('workspace checkpoint changed');
      await command(container, { op: 'adopt', root, work, stage });
      outcome.filesWritten = keys.length;
      outcome.ok = true;
    } finally {
      await command(container, { op: 'cleanup-legacy', root, work, stage });
    }
  } catch {
    outcome.ok = false;
    outcome.filesFailed++;
    log('[workspace-persist] hydrate failed');
  } finally {
    try { await command(container, { op: 'cleanup', root, work }); }
    catch { log('[workspace-persist] restore staging cleanup failed'); }
  }
  return outcome;
}
// ── Garbage collection of superseded checkpoint generations ─────────────────
export interface GcR2BucketLike {
  get(key: string): Promise<HydrateR2ObjectBodyLike | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; uploaded?: Date | string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string[]): Promise<unknown>;
}
export interface GcOutcome { ok: boolean; deletedGenerations: number; deletedObjects: number; keptRecent: number }
/** A generation must be at least this old before it may be deleted: an uncommitted writer may still be uploading it. */
export const SNAPSHOT_GC_GRACE_MS = 60 * 60_000;
const GC_MAX_OBJECTS = 20_000;
const CHUNK_KEY = /^\.ezil-snapshots\/([a-f0-9-]{36})\/(\d+)$/;

/**
 * Deletes chunk generations that are neither the head's nor the previous
 * head's, and only once every object in them is older than the grace window.
 * Separate from the put-only flush path by design. No head: nothing is
 * provably garbage, so nothing is deleted. A head that moves mid-run aborts.
 */
export async function collectSupersededSnapshots(deps: {
  bucket: GcR2BucketLike; realPrefix: string; log: (message: string) => void; now?: number; graceMs?: number;
}): Promise<GcOutcome> {
  const { bucket, realPrefix: prefix, log } = deps;
  const outcome: GcOutcome = { ok: false, deletedGenerations: 0, deletedObjects: 0, keptRecent: 0 };
  if (!validPrefix(prefix)) return outcome;
  try {
    const head = await readHead(bucket, prefix);
    if (!head) return { ...outcome, ok: true };
    const keep = new Set([head.snapshot.chunkGeneration ?? head.snapshot.generation, head.snapshot.previousChunkGeneration]
      .filter((g): g is string => !!g));
    const now = deps.now ?? Date.now();
    const grace = deps.graceMs ?? SNAPSHOT_GC_GRACE_MS;
    const generations = new Map<string, { keys: string[]; recent: boolean }>();
    let cursor: string | undefined; let seen = 0;
    do {
      const page = await bucket.list({ prefix: `${prefix}/.ezil-snapshots/`, cursor, limit: 1000 });
      for (const object of page.objects) {
        if (++seen > GC_MAX_OBJECTS) throw new Error('gc listing too large');
        if (!object.key.startsWith(`${prefix}/`)) throw new Error('out-of-prefix object');
        const match = CHUNK_KEY.exec(object.key.slice(prefix.length + 1));
        if (!match || !GENERATION.test(match[1]!) || keep.has(match[1]!)) continue;
        const uploaded = object.uploaded === undefined ? NaN : new Date(object.uploaded).getTime();
        const g = generations.get(match[1]!) ?? { keys: [], recent: false };
        g.keys.push(object.key);
        // Unknown age counts as recent: never delete what cannot be dated.
        if (!(now - uploaded >= grace)) g.recent = true;
        generations.set(match[1]!, g);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if ((await readHead(bucket, prefix))?.etag !== head.etag) throw new Error('workspace checkpoint changed');
    for (const g of generations.values()) {
      if (g.recent) { outcome.keptRecent++; continue; }
      for (let i = 0; i < g.keys.length; i += 1000) await bucket.delete(g.keys.slice(i, i + 1000));
      outcome.deletedGenerations++; outcome.deletedObjects += g.keys.length;
    }
    outcome.ok = true;
  } catch {
    log('[workspace-persist] snapshot garbage collection failed');
  }
  return outcome;
}
export interface HydrateMarker { version: 1; prefix: string; mountPath: string; hydratedAt: string; checkpoint?: string }
export function parseHydrateMarker(raw: string): HydrateMarker | null {
  try {
    const m = JSON.parse(raw) as HydrateMarker;
    return m?.version === 1 && typeof m.prefix === 'string' && typeof m.mountPath === 'string'
      && typeof m.hydratedAt === 'string' ? m : null;
  } catch { return null; }
}
export function serializeHydrateMarker(marker: HydrateMarker): string { return JSON.stringify(marker); }
export function parseFlushManifest(_raw: string): FlushManifest { return {}; }
export function serializeFlushManifest(_manifest: FlushManifest): string { return '{}'; }
