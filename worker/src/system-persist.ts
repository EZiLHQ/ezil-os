/**
 * The SYSTEM layer: user changes outside /workspace (apt/dpkg, `npm -g`,
 * /usr/local, /opt, HOME dotfiles and tool state), captured as a delta and
 * restored onto the next container. Same storage format and commit protocol
 * as the workspace checkpoint (`workspace-persist.ts`): immutable chunks, one
 * conditional head put, GC by `collectSupersededSnapshots` — under a separate
 * per-computer prefix `<computerId>/system`.
 *
 * Never blocks the desktop: every failure is reported and logged; the
 * workspace checkpoint remains the readiness gate.
 */
import { base64ToBytes, bytesToBase64 } from './project-files';
import {
  chunkKey, parseSnapshot, readBounded, readHead, requireSdkSuccess, sha256, validPrefix,
  SNAPSHOT_CHUNK_BYTES, SNAPSHOT_HEAD,
  type FlushContainerLike, type FlushR2BucketLike, type HydrateContainerLike, type HydrateR2BucketLike, type Snapshot,
} from './workspace-persist';
import { systemSnapshotCommand } from './system-snapshot-script';

export const SYSTEM_MANIFEST_PATH = '/var/lib/ezil-system/manifest.json';
const SYSTEM_SNAPSHOT_VERSION = 1;
/**
 * Layers captured by the first system-layer build (staging only) had no image
 * manifest to diff against and hold thousands of stale image files; restoring
 * them onto a newer image could shadow platform files. Only this format restores.
 */
const SYSTEM_LAYER_FORMAT = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

/** `<computerId>/branches/<branch>` -> `<computerId>/system` (the system layer is per computer, not per branch). */
export function systemPrefixOf(realPrefix: string): string | null {
  const computer = realPrefix.split('/')[0] ?? '';
  return UUID.test(computer) ? `${computer}/system` : null;
}

export interface SystemSnapshot extends Snapshot {
  format?: number;
  imageId?: string;
  replay?: { apt?: string[]; npm?: string[] };
}

export interface SystemFlushOutcome {
  ok: boolean;
  uploaded: number;
  entries: number;
  unchanged?: boolean;
  checkpoint?: string;
  skippedReason?: 'no_computer' | 'not_restored' | 'stale' | 'no_baseline' | 'no_manifest' | 'busy' | 'too_large' | 'failed';
}

export interface SystemHydrateOutcome {
  ok: boolean;
  restored: number;
  skippedImageScoped: number;
  conflicts: number;
  sameImage?: boolean;
  skippedReason?: 'no_computer' | 'no_snapshot' | 'already_restored' | 'legacy_discarded' | 'failed';
}

class SystemTooLargeError extends Error {}

/** Chunk transfers in flight per flush / restore: each is a DO <-> container round trip plus an R2 call. */
export const SYSTEM_TRANSFER_CONCURRENCY = 4;
/** `readHead` refuses heads over this size; a head that could not be read back would lock the computer out. */
const SYSTEM_HEAD_MAX_BYTES = 120 * 1024;

async function forEachLimit<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const i = next++;
      try { await fn(items[i]!, i); } catch (err) { failure ??= err; }
    }
  };
  // Every worker settles before this returns: nothing touches the staging dir after cleanup.
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure;
}

async function run(container: HydrateContainerLike, params: Record<string, unknown>, timeout = 300_000): Promise<string> {
  const result = await container.exec(systemSnapshotCommand(params), { timeout });
  if (result.exitCode === 3 && params.op === 'sys-capture') throw new SystemTooLargeError('system snapshot too large');
  // The codec prints only its own fixed messages / exception type names (never file contents).
  if (result.exitCode !== 0) throw new Error(`system snapshot ${String(params.op)} failed: ${(result.stderr ?? '').trim().slice(-160)}`);
  return result.stdout;
}

/** Capture what changed outside /workspace and commit it as the computer's system layer. */
export async function flushSystemLayer(deps: {
  container: FlushContainerLike; bucket: FlushR2BucketLike; realPrefix: string; log: (message: string) => void;
}): Promise<SystemFlushOutcome> {
  const { container, bucket, log } = deps;
  const prefix = systemPrefixOf(deps.realPrefix);
  const outcome: SystemFlushOutcome = { ok: false, uploaded: 0, entries: 0 };
  if (!prefix || !validPrefix(prefix)) return { ...outcome, skippedReason: 'no_computer' };
  const generation = crypto.randomUUID();
  const work = `/tmp/ezil-system-${generation}`;
  try {
    const previous = await readHead(bucket, prefix);
    const captured = JSON.parse(await run(container, { op: 'sys-capture', work })) as Record<string, unknown>;
    if (captured.skipped === 'not_restored') {
      log('[system-persist] system layer was not restored on this container; not checkpointing over it');
      return { ...outcome, skippedReason: 'not_restored' };
    }
    if (captured.skipped === 'no_baseline' || captured.skipped === 'busy' || captured.skipped === 'no_manifest') {
      return { ...outcome, skippedReason: captured.skipped };
    }
    // Fencing: only the container holding the committed generation may replace it.
    // Another writer committed since this container restored (or a head appeared
    // that it never saw): its state is stale and must not overwrite the newer one.
    const expected = captured.expectedGeneration ?? null;
    const actual = previous?.snapshot.generation ?? null;
    if (expected !== actual) {
      log('[system-persist] another writer committed this computer\'s system layer; not checkpointing over it');
      return { ...outcome, skippedReason: 'stale' };
    }
    const { imageId, replay, expectedGeneration: _expected, deletedCount: _deleted, ...shape } = captured;
    const snapshot = parseSnapshot(JSON.stringify({ ...shape, version: SYSTEM_SNAPSHOT_VERSION, generation })) as SystemSnapshot;
    outcome.entries = snapshot.entries;
    if (previous?.snapshot.sha256 === snapshot.sha256) return { ...outcome, ok: true, unchanged: true };
    await forEachLimit(snapshot.chunks, SYSTEM_TRANSFER_CONCURRENCY, async (c, i) => {
      const file = await container.readFile(`${work}/${i}`, { encoding: 'base64' });
      if (file.encoding !== 'base64') throw new Error('system chunk encoding missing');
      const bytes = base64ToBytes(file.content);
      if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('corrupt system chunk');
      if (!await bucket.put(chunkKey(prefix, generation, i), bytes)) throw new Error('system chunk upload rejected');
      outcome.uploaded++;
    });
    const committed: SystemSnapshot = {
      ...snapshot,
      format: SYSTEM_LAYER_FORMAT,
      ...(typeof imageId === 'string' ? { imageId } : {}),
      ...(replay && typeof replay === 'object' ? { replay: replay as SystemSnapshot['replay'] } : {}),
      ...(previous ? { previousChunkGeneration: previous.snapshot.chunkGeneration ?? previous.snapshot.generation } : {}),
    };
    const head = encoder.encode(JSON.stringify(committed));
    if (head.length > SYSTEM_HEAD_MAX_BYTES) throw new SystemTooLargeError('system head too large');
    const put = await bucket.put(`${prefix}/${SNAPSHOT_HEAD}`, head, {
      onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    });
    if (!put) throw new Error('system checkpoint conflict');
    // This container now holds the committed generation. If recording that fails,
    // the next capture is refused as stale: fail-safe, the head stays good.
    try { await run(container, { op: 'sys-hydrated', work, generation }, 60_000); } catch { log('[system-persist] could not record the committed generation'); }
    return { ...outcome, ok: true, checkpoint: generation };
  } catch (err) {
    if (err instanceof SystemTooLargeError) {
      log('[system-persist] system changes exceed the snapshot limits; not checkpointed');
      return { ...outcome, skippedReason: 'too_large' };
    }
    log(`[system-persist] system checkpoint failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { ...outcome, skippedReason: 'failed' };
  } finally {
    try { await run(container, { op: 'sys-cleanup', work }, 60_000); } catch { log('[system-persist] staging cleanup failed'); }
  }
}

/**
 * Restore the computer's system layer onto a fresh container, before its
 * desktop starts. Once per container (a manifest marks it done). After an
 * image change, the codec keeps the new image's own package files and merges
 * dpkg's database, restoring everything else (see system-snapshot-script.ts).
 */
export async function hydrateSystemLayer(deps: {
  container: HydrateContainerLike & { exists?: (path: string) => Promise<{ exists: boolean }> };
  bucket: HydrateR2BucketLike; realPrefix: string; log: (message: string) => void;
}): Promise<SystemHydrateOutcome> {
  const { container, bucket, log } = deps;
  const prefix = systemPrefixOf(deps.realPrefix);
  const outcome: SystemHydrateOutcome = { ok: false, restored: 0, skippedImageScoped: 0, conflicts: 0 };
  if (!prefix || !validPrefix(prefix)) return { ...outcome, skippedReason: 'no_computer' };
  const work = `/tmp/ezil-system-${crypto.randomUUID()}`;
  try {
    if ((await container.exists?.(SYSTEM_MANIFEST_PATH))?.exists) return { ...outcome, ok: true, skippedReason: 'already_restored' };
    const head = await readHead(bucket, prefix);
    if (!head) {
      // Nothing committed yet: this container's state IS the computer's system layer.
      await run(container, { op: 'sys-hydrated', work, generation: null }, 60_000);
      return { ...outcome, ok: true, skippedReason: 'no_snapshot' };
    }
    const snapshot = head.snapshot as SystemSnapshot;
    if (snapshot.format !== SYSTEM_LAYER_FORMAT) {
      // Never restored. Recording its generation lets this container's next capture replace it.
      log('[system-persist] discarding a system layer from an older format');
      await run(container, { op: 'sys-hydrated', work, generation: snapshot.generation }, 60_000);
      return { ...outcome, ok: true, skippedReason: 'legacy_discarded' };
    }
    await container.mkdir(work, { recursive: false });
    await forEachLimit(snapshot.chunks, SYSTEM_TRANSFER_CONCURRENCY, async (c, i) => {
      const body = await bucket.get(chunkKey(prefix, snapshot.chunkGeneration ?? snapshot.generation, i));
      if (!body) throw new Error('system chunk missing');
      const bytes = await readBounded(body, SNAPSHOT_CHUNK_BYTES);
      if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('system chunk corrupt');
      requireSdkSuccess(await container.writeFile(`${work}/${i}`, bytesToBase64(bytes), { encoding: 'base64' }));
    });
    // On success the codec also marks the container hydrated, which unlocks capture.
    const result = JSON.parse(await run(container, { op: 'sys-restore', work, snapshot }, 900_000)) as Record<string, unknown>;
    if (result.skipped === 'already_restored') return { ...outcome, ok: true, skippedReason: 'already_restored' };
    Object.assign(outcome, {
      ok: true,
      restored: Number(result.restored) || 0,
      skippedImageScoped: Number(result.skippedImageScoped) || 0,
      conflicts: Number(result.conflicts) || 0,
      sameImage: result.sameImage === true,
    });
    return outcome;
  } catch (err) {
    log(`[system-persist] system restore failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return { ...outcome, skippedReason: 'failed' };
  } finally {
    try { await run(container, { op: 'sys-cleanup', work }, 60_000); } catch { /* best effort */ }
  }
}

/** Start capturing user changes: set once the desktop is up, so platform boot writes are not captured. */
export async function baselineSystemLayer(container: HydrateContainerLike): Promise<boolean> {
  try {
    await run(container, { op: 'sys-baseline', work: '/tmp/ezil-system-baseline' }, 60_000);
    return true;
  } catch {
    return false;
  }
}
