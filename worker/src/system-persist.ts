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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

/** `<computerId>/branches/<branch>` -> `<computerId>/system` (the system layer is per computer, not per branch). */
export function systemPrefixOf(realPrefix: string): string | null {
  const computer = realPrefix.split('/')[0] ?? '';
  return UUID.test(computer) ? `${computer}/system` : null;
}

export interface SystemSnapshot extends Snapshot {
  imageId?: string;
  replay?: { apt?: string[]; npm?: string[] };
}

export interface SystemFlushOutcome {
  ok: boolean;
  uploaded: number;
  entries: number;
  unchanged?: boolean;
  checkpoint?: string;
  skippedReason?: 'no_computer' | 'no_baseline' | 'busy' | 'too_large' | 'failed';
}

export interface SystemHydrateOutcome {
  ok: boolean;
  restored: number;
  skippedImageScoped: number;
  conflicts: number;
  sameImage?: boolean;
  replayStarted?: boolean;
  skippedReason?: 'no_computer' | 'no_snapshot' | 'already_restored' | 'failed';
}

class SystemTooLargeError extends Error {}

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
    if (captured.skipped === 'no_baseline' || captured.skipped === 'busy') {
      return { ...outcome, skippedReason: captured.skipped };
    }
    const { imageId, replay, ...shape } = captured;
    const snapshot = parseSnapshot(JSON.stringify({ ...shape, version: SYSTEM_SNAPSHOT_VERSION, generation })) as SystemSnapshot;
    outcome.entries = snapshot.entries;
    if (previous?.snapshot.sha256 === snapshot.sha256) return { ...outcome, ok: true, unchanged: true };
    for (const [i, c] of snapshot.chunks.entries()) {
      const file = await container.readFile(`${work}/${i}`, { encoding: 'base64' });
      if (file.encoding !== 'base64') throw new Error('system chunk encoding missing');
      const bytes = base64ToBytes(file.content);
      if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('corrupt system chunk');
      if (!await bucket.put(chunkKey(prefix, generation, i), bytes)) throw new Error('system chunk upload rejected');
      outcome.uploaded++;
    }
    const committed: SystemSnapshot = {
      ...snapshot,
      ...(typeof imageId === 'string' ? { imageId } : {}),
      ...(replay && typeof replay === 'object' ? { replay: replay as SystemSnapshot['replay'] } : {}),
      ...(previous ? { previousChunkGeneration: previous.snapshot.chunkGeneration ?? previous.snapshot.generation } : {}),
    };
    const put = await bucket.put(`${prefix}/${SNAPSHOT_HEAD}`, encoder.encode(JSON.stringify(committed)), {
      onlyIf: previous ? { etagMatches: previous.etag } : { etagDoesNotMatch: '*' },
    });
    if (!put) throw new Error('system checkpoint conflict');
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
 * image change, the recorded apt / npm-global installs replay in the
 * background instead of restoring raw files.
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
    if (!head) return { ...outcome, ok: true, skippedReason: 'no_snapshot' };
    const snapshot = head.snapshot as SystemSnapshot;
    await container.mkdir(work, { recursive: false });
    for (const [i, c] of snapshot.chunks.entries()) {
      const body = await bucket.get(chunkKey(prefix, snapshot.chunkGeneration ?? snapshot.generation, i));
      if (!body) throw new Error('system chunk missing');
      const bytes = await readBounded(body, SNAPSHOT_CHUNK_BYTES);
      if (bytes.length !== c.size || await sha256(bytes) !== c.sha256) throw new Error('system chunk corrupt');
      requireSdkSuccess(await container.writeFile(`${work}/${i}`, bytesToBase64(bytes), { encoding: 'base64' }));
    }
    const result = JSON.parse(await run(container, { op: 'sys-restore', work, snapshot }, 900_000)) as Record<string, unknown>;
    if (result.skipped === 'already_restored') return { ...outcome, ok: true, skippedReason: 'already_restored' };
    Object.assign(outcome, {
      ok: true,
      restored: Number(result.restored) || 0,
      skippedImageScoped: Number(result.skippedImageScoped) || 0,
      conflicts: Number(result.conflicts) || 0,
      sameImage: result.sameImage === true,
    });
    if (result.replayPending === true && snapshot.replay) {
      // Background: package installs can take minutes; the desktop must not wait.
      const cmd = systemSnapshotCommand({ op: 'sys-replay', work: '/tmp/ezil-system-replay', replay: snapshot.replay });
      await container.exec(`(${cmd}) > /tmp/ezil-system-replay.log 2>&1 &`, { timeout: 30_000 });
      outcome.replayStarted = true;
    }
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
