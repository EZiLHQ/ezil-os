import {
  MIGRATING_FLAG, SNAPSHOT_HEAD, SNAPSHOT_CHUNK_BYTES, chunkKey, parseMigratedHead,
  parseSnapshot, readBounded, type FlushR2BucketLike, type Snapshot,
} from './workspace-persist';

export class MigrationRequestError extends Error {
  constructor(readonly reason: string, readonly status = 409) { super(reason); }
}

/** Reads either head format without weakening the normal Cloudflare writer fence. */
async function record(bucket: FlushR2BucketLike, prefix: string) {
  const object = await bucket.get(`${prefix}/${SNAPSHOT_HEAD}`);
  if (!object?.etag) throw new MigrationRequestError('no_checkpoint');
  const raw = new TextDecoder().decode(await readBounded(object, 128 * 1024));
  const migrated = parseMigratedHead(raw);
  return { etag: object.etag, migrated, snapshot: migrated ? migrated.previous : parseSnapshot(raw) };
}

// Both layers share the workspace migration flag; each pins its own head etag.
export async function exportedSnapshot(bucket: FlushR2BucketLike, prefix: string, workspacePrefix = prefix) {
  const head = await record(bucket, prefix);
  if (!head.migrated) {
    const flag = await bucket.get(`${workspacePrefix}/${MIGRATING_FLAG}`);
    if (!flag) throw new MigrationRequestError('migration_not_started');
    const fence = JSON.parse(new TextDecoder().decode(await readBounded(flag, 4096)));
    const expectedEtag = prefix === workspacePrefix ? fence?.headEtag : fence?.systemHeadEtag;
    if (expectedEtag !== head.etag) throw new MigrationRequestError('head_moved');
  }
  if (!head.snapshot) throw new MigrationRequestError('previous_head_missing');
  return { etag: head.etag, snapshot: head.snapshot };
}

/** Stream a chunk from either layer, retaining the same fencing and integrity guards. */
export async function exportedChunk(bucket: FlushR2BucketLike, prefix: string, index: number, generation?: string,
  workspacePrefix = prefix) {
  const head = await exportedSnapshot(bucket, prefix, workspacePrefix);
  if (!Number.isSafeInteger(index) || index < 0 || index >= head.snapshot.chunks.length) {
    throw new MigrationRequestError('invalid_chunk_index', 400);
  }
  if (generation !== undefined && generation !== head.snapshot.generation) throw new MigrationRequestError('generation_mismatch');
  const owner = head.snapshot.chunkGeneration ?? head.snapshot.generation;
  const chunk = head.snapshot.chunks[index];
  const object = await bucket.get(chunkKey(prefix, owner, index));
  if (!object || object.size !== chunk.size) throw new MigrationRequestError('chunk_unavailable');
  // A head/flag change during storage I/O must not return bytes from a different export.
  const current = await exportedSnapshot(bucket, prefix, workspacePrefix);
  if (current.snapshot.generation !== head.snapshot.generation
    || (current.snapshot.chunkGeneration ?? current.snapshot.generation) !== owner) {
    throw new MigrationRequestError('generation_mismatch');
  }
  return { body: object.body ?? await readBounded(object, SNAPSHOT_CHUNK_BYTES), chunk };
}

/** Keep the workspace fenced until the system restore has succeeded; failures are retryable. */
export async function reopenMigrationHeads(bucket: FlushR2BucketLike & { delete(keys: string[]): Promise<unknown> },
  prefix: string, systemPrefix: string | null, expectedMigratedEtag: string) {
  const head = await record(bucket, prefix);
  if (!head.migrated) throw new MigrationRequestError('not_migrated');
  if (head.etag !== expectedMigratedEtag) throw new MigrationRequestError('head_moved');
  if (!head.snapshot) throw new MigrationRequestError('previous_head_missing');
  const restore = async (p: string, etag: string, snapshot: Snapshot) => {
    const result = await bucket.put(`${p}/${SNAPSHOT_HEAD}`, new TextEncoder().encode(JSON.stringify(snapshot)),
      { onlyIf: { etagMatches: etag } });
    if (!result) throw new MigrationRequestError('head_moved');
  };
  if (systemPrefix && await bucket.get(`${systemPrefix}/${SNAPSHOT_HEAD}`)) {
    const system = await record(bucket, systemPrefix);
    if (system.migrated) {
      if (!system.snapshot) throw new MigrationRequestError('previous_head_missing');
      await restore(systemPrefix, system.etag, system.snapshot);
    }
  }
  await restore(prefix, head.etag, head.snapshot);
  await bucket.delete([`${prefix}/${MIGRATING_FLAG}`, ...(systemPrefix ? [`${systemPrefix}/${MIGRATING_FLAG}`] : [])]);
  return { ok: true as const };
}
