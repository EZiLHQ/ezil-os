/**
 * Reverse move, Worker side: a held Free user's `/workspace` comes back from their AWS
 * computer to their Cloudflare computer (docs/compute/REVERSE-MOVE-CONTRACT.md §4).
 *
 * The export boot's host stages the workspace as a v1 snapshot (§2). The app drives four
 * signed control routes, `POST /sandbox/<name>/migrate/import/{begin,pull,commit,abort}`, and
 * this module runs them inside the computer's Sandbox Durable Object:
 *   begin   check the heads at P, fence P (flag + DO key), ask the host to export;
 *   pull    poll the host's status, then copy its chunks into P's store, hash-checked;
 *   commit  `verifyOnly`: prove every chunk landed; then (flipping) CAS P's head to the new
 *           v1 snapshot, revert the system head, re-arm the next Cloudflare open;
 *   abort   delete this move's chunks and fences (never after the commit's head CAS).
 *
 * The bytes go host → Worker → R2 and never through the app. v1 is R2-only. Every 409 is a
 * closed code the app maps (§4.6, §5.5); a transient store or host failure is a 503.
 *
 * 🔴 Never call `ensureAwsDesktop`/`ensureAwsDesktopConfig` (./aws-ice) from here, and never
 * claim the tunnel record's `restartPush*`: the export boot's desktop is the host agent's to
 * stop (§2.5 step 3), and a desktop config push would restart it under the capture. The only
 * tunnel call is `lookupAwsTunnel` (the deps' `host.lookup`); the only host calls are the
 * export routes in ./aws-origin.
 */
import { readAwsExport, startAwsExport, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import { systemPrefixOf } from './system-persist';
import {
  MIGRATING_FLAG, SNAPSHOT_CHUNK_BYTES, SNAPSHOT_HEAD, chunkKey, parseMigratedHead, parseSnapshot, sha256,
  type MigratedHead, type Snapshot,
} from './workspace-persist';
import { importWorkspacePrefix } from './workspace-prefix';
import { normalizeEtag } from './workspace-store-s3';

// ── Durable Object storage (§4.1; every value far below the 128 KiB value limit) ──
export const REVERSE_IMPORT_KEY = 'ezil:reverseImport';
export const REVERSE_IMPORT_HEAD_KEY = `${REVERSE_IMPORT_KEY}:head`;
export const REVERSE_IMPORT_PUT_PREFIX = `${REVERSE_IMPORT_KEY}:put:`;
/** DO storage batch operations take at most 128 keys. */
const DO_BATCH_KEYS = 128;

// ── Limits ──
/** The v1 codec's limits (workspace-persist.ts): the import is a valid Cloudflare snapshot or nothing. */
const MAX_CHUNKS = 512;
const MAX_ENTRIES = 100_000;
const MAX_BYTES = MAX_CHUNKS * SNAPSHOT_CHUNK_BYTES;
/** `readHead`'s bound, for heads and for the host's export head (§2.3). */
const HEAD_MAX_BYTES = 128 * 1024;
const FLAG_MAX_BYTES = 4096;
/** Host answers other than the head and the chunks are small JSON objects. */
const HOST_JSON_MAX_BYTES = 16 * 1024;
/** One pull: at most this many chunk transfers in flight, and no new one after this much wall time (§4.3, §5.4). */
export const PULL_CONCURRENCY = 4;
export const PULL_TRANSFER_WINDOW_MS = 20_000;
export const PULL_MAX_COUNT = 64;
/**
 * Per host request. The app's own timeouts are begin 60 s and pull 40 s (§4.1): a pull's
 * status and head reads plus a chunk started at the 20 s mark still end inside 40 s.
 */
export const EXPORT_POST_TIMEOUT_MS = 10_000;
export const EXPORT_READ_TIMEOUT_MS = 6_000;
/** A chunk GET's floor: one started at the 20 s mark ends by 32 s, as `PULL_CHUNK_DEADLINE_MS`. */
export const EXPORT_CHUNK_TIMEOUT_MS = 12_000;
/** No chunk GET runs past this much wall time from the pull's arrival (`chunkTimeoutMs`). */
export const PULL_CHUNK_DEADLINE_MS = PULL_TRANSFER_WINDOW_MS + EXPORT_CHUNK_TIMEOUT_MS;

/**
 * One chunk GET's timeout: the time left to `PULL_CHUNK_DEADLINE_MS`, and never less than
 * `EXPORT_CHUNK_TIMEOUT_MS`. A transfer starts by the 20 s mark, so none runs past 32 s, the
 * same bound a flat 12 s gives. But an early transfer on a slow host gets the whole span:
 * with 4 in flight, a flat 12 s stores nothing below about 0.33 MiB/s (4 MiB per 12 s), and a
 * slow copy would stall instead of running slower (§5.4's floor is 0.5 MiB/s, T0 (e2)).
 */
export function chunkTimeoutMs(startedAt: number, now: number): number {
  return Math.max(EXPORT_CHUNK_TIMEOUT_MS, startedAt + PULL_CHUNK_DEADLINE_MS - now);
}
/** The commit's chunk listing never needs more than the 512 chunk keys of one generation. */
const LIST_MAX_OBJECTS = 4 * MAX_CHUNKS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

// ── Wire: requests (§4.2–§4.5) ──

export const IMPORT_OPS = ['begin', 'pull', 'commit', 'abort'] as const;
export type ImportOp = (typeof IMPORT_OPS)[number];
interface ImportIds { moveId: string; generation: string; computerId: string }
/** The export boot's placement counters: the tunnel record must carry exactly these (§4.1 "Host binding"). */
interface ExportBinding { placementGeneration: number; leaseEpoch: number }
export type ImportRequest =
  | ({ op: 'begin' } & ImportIds & ExportBinding)
  | ({ op: 'pull'; from: number; count: number } & ImportIds & ExportBinding)
  | ({ op: 'commit'; sha256: string; chunkCount: number; verifyOnly: boolean } & ImportIds)
  | ({ op: 'abort' } & ImportIds);

const isEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isIndex = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/**
 * The route's body check (400 `invalid_body` when null). `<name>` is the app's
 * `deriveGuacamoleSandboxId(userId, computerId)`: its scope part must be the body's computer,
 * so one computer's import can never land in another computer's Durable Object.
 */
export function parseImportRequest(op: string, raw: unknown, name: string): ImportRequest | null {
  if (!(IMPORT_OPS as readonly string[]).includes(op) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.moveId !== 'string' || !UUID.test(b.moveId) || typeof b.generation !== 'string' || !UUID.test(b.generation)
    || typeof b.computerId !== 'string' || !UUID.test(b.computerId)) return null;
  const scope = /^guac-[a-z0-9]*-([a-z0-9]+)$/i.exec(name)?.[1];
  if (scope === undefined || scope !== b.computerId.replace(/[^a-z0-9]/gi, '').slice(0, 16)) return null;
  const ids: ImportIds = { moveId: b.moveId, generation: b.generation, computerId: b.computerId };
  if (op === 'abort') return { op, ...ids };
  if (op === 'commit') {
    if (typeof b.sha256 !== 'string' || !HASH.test(b.sha256) || !isIndex(b.chunkCount, MAX_CHUNKS) || b.chunkCount < 1
      || typeof b.verifyOnly !== 'boolean') return null;
    return { op, ...ids, sha256: b.sha256, chunkCount: b.chunkCount, verifyOnly: b.verifyOnly };
  }
  if (!isEpoch(b.placementGeneration) || !isEpoch(b.leaseEpoch)) return null;
  const binding: ExportBinding = { placementGeneration: b.placementGeneration, leaseEpoch: b.leaseEpoch };
  if (op === 'begin') return { op, ...ids, ...binding };
  if (!isIndex(b.from, MAX_CHUNKS - 1) || !isIndex(b.count, PULL_MAX_COUNT)) return null;
  return { op: 'pull', ...ids, ...binding, from: b.from, count: b.count };
}

// ── Wire: answers ──

/** The closed 409 vocabulary (§4.6, plus `head_moved` and `workspace_too_large`, which the app already maps). */
export const IMPORT_CONFLICT_CODES = [
  'container_running', 'head_invalid', 'head_unreadable', 'head_moved', 'system_head_moved', 'import_busy',
  'import_not_started', 'import_mismatch', 'store_unsupported', 'prefix_mismatch', 'export_host_mismatch', 'export_refused',
  'export_head_invalid', 'workspace_too_large', 'export_workspace_missing', 'export_capture_failed',
  'export_desktop_stop_failed', 'export_staging_space', 'chunk_mismatch', 'already_imported', 'not_verified',
  'commit_in_progress',
] as const;
export type ImportConflictCode = (typeof IMPORT_CONFLICT_CODES)[number];
/** 503s: the host or tunnel did not answer, or the store or DO storage failed. The app retries both. */
export type ImportUnavailableCode = 'export_unreachable' | 'store_unavailable';
export interface ImportAnswer { status: 200 | 409 | 503; body: Record<string, unknown> }

class ImportRefusal extends Error {
  constructor(readonly code: ImportConflictCode | ImportUnavailableCode, readonly status: 409 | 503 = 409) { super(code); }
}
const refuse = (code: ImportConflictCode) => new ImportRefusal(code);
const unreachable = () => new ImportRefusal('export_unreachable', 503);

// ── Host export status (§2.4) and head (§2.3) ──

const HOST_EXPORT_ERRORS = ['workspace_too_large', 'workspace_missing', 'capture_failed', 'desktop_stop_failed', 'staging_space_low'] as const;
type HostExportError = (typeof HOST_EXPORT_ERRORS)[number];
/** `failed` → the top-level 409 the app keys on (§4.3 step 2): never a sub-field. */
const FAILED_EXPORT_CODES: Record<HostExportError, ImportConflictCode> = {
  workspace_too_large: 'workspace_too_large',
  workspace_missing: 'export_workspace_missing',
  capture_failed: 'export_capture_failed',
  desktop_stop_failed: 'export_desktop_stop_failed',
  staging_space_low: 'export_staging_space',
};
export interface ExportStatus {
  ok: true;
  state: 'none' | 'capturing' | 'ready' | 'failed';
  moveId: string | null;
  generation: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastServedAt: string | null;
  error: HostExportError | null;
  entries?: number;
  bytes?: number;
  skipped?: number;
}

const nullableUuid = (v: unknown): v is string | null => v === null || (typeof v === 'string' && UUID.test(v));
const nullableTime = (v: unknown): v is string | null => v === null
  || (typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)));
const count = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;

/** Rebuilt from validated fields only: host JSON is never passed through to the app. */
export function parseExportStatus(raw: unknown): ExportStatus | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.ok !== true || !['none', 'capturing', 'ready', 'failed'].includes(s.state as string) || !nullableUuid(s.moveId)
    || !nullableUuid(s.generation) || !nullableTime(s.startedAt) || !nullableTime(s.finishedAt) || !nullableTime(s.lastServedAt)
    || !(s.error === null || (HOST_EXPORT_ERRORS as readonly unknown[]).includes(s.error))
    || (s.state === 'failed') !== (s.error !== null)) return null;
  const status: ExportStatus = { ok: true, state: s.state as ExportStatus['state'], moveId: s.moveId, generation: s.generation,
    startedAt: s.startedAt, finishedAt: s.finishedAt, lastServedAt: s.lastServedAt, error: s.error as HostExportError | null };
  if (status.state === 'ready') {
    if (!count(s.entries, MAX_ENTRIES) || !count(s.bytes, MAX_BYTES) || !count(s.skipped)) return null;
    Object.assign(status, { entries: s.entries, bytes: s.bytes, skipped: s.skipped });
  }
  return status;
}

export interface ExportHead {
  v: 1;
  moveId: string;
  generation: string;
  sha256: string;
  entries: number;
  skipped: number;
  bytes: number;
  chunks: Array<{ i: number; size: number; sha256: string }>;
}

/** §2.3, bound to this move: the same rules as the app's `validExportHead`, plus `v` and `moveId`. */
export function parseExportHead(raw: unknown, ids: { moveId: string; generation: string }): ExportHead | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const h = raw as Record<string, unknown>;
  if (h.v !== 1 || h.moveId !== ids.moveId || h.generation !== ids.generation || typeof h.sha256 !== 'string' || !HASH.test(h.sha256)
    || !count(h.entries, MAX_ENTRIES) || !count(h.skipped) || !count(h.bytes, MAX_BYTES)
    || !Array.isArray(h.chunks) || h.chunks.length < 1 || h.chunks.length > MAX_CHUNKS) return null;
  const chunks: ExportHead['chunks'] = [];
  let bytes = 0;
  for (const [index, entry] of (h.chunks as unknown[]).entries()) {
    const c = entry as Record<string, unknown> | null;
    const last = index === h.chunks.length - 1;
    if (!c || typeof c !== 'object' || c.i !== index || typeof c.sha256 !== 'string' || !HASH.test(c.sha256)
      || !count(c.size, SNAPSHOT_CHUNK_BYTES) || c.size < 1 || (!last && c.size !== SNAPSHOT_CHUNK_BYTES)) return null;
    chunks.push({ i: index, size: c.size, sha256: c.sha256 });
    bytes += c.size;
  }
  if (h.bytes !== bytes) return null;
  return { v: 1, moveId: ids.moveId, generation: ids.generation, sha256: h.sha256, entries: h.entries, skipped: h.skipped, bytes, chunks };
}

/** The v1 head the commit writes (`i` dropped, no `previousChunkGeneration`: the pre-move generation becomes garbage). */
function importedSnapshot(head: ExportHead): Snapshot {
  return parseSnapshot(JSON.stringify({ version: 1, generation: head.generation, chunkGeneration: head.generation,
    sha256: head.sha256, entries: head.entries, chunks: head.chunks.map(({ size, sha256: hash }) => ({ size, sha256: hash })) }));
}

// ── Dependencies (the Sandbox Durable Object supplies them; tests fake them) ──

/** The subset of Durable Object storage this module uses. */
export interface ImportStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
/** The common workspace-store surface (`WorkspaceStore`, workspace-store-s3.ts): no R2 `head()`, no customMetadata. */
export interface ImportBucket {
  get(key: string): Promise<{ etag?: string; size?: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }): Promise<{ etag?: string } | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size?: number; etag?: string }>; truncated: boolean; cursor?: string;
  }>;
  delete(keys: string[]): Promise<unknown>;
}
/** The export boot's host: its tunnel record (lookup only) and the zone and fetch to reach it. */
export interface ExportHostAccess {
  zone: string;
  lookup(): Promise<AwsTunnelRecord | null>;
  fetch: FetchLike;
}
export interface ReverseImportDeps {
  /** This Durable Object's sandbox name: a fresh-provision fence placeholder lives at `<name>/branches/main`. */
  sandboxName: string;
  storage: ImportStorage;
  /** `selectWorkspaceStore()` (pin, else env); null when it does not resolve. */
  selectStore(): Promise<{ kind: string; bucket: ImportBucket | undefined } | null>;
  /** `SANDBOX_WORKSPACE_S3_PREFIX` as the open reads it (./workspace-prefix `workspacePrefixOverride`). */
  prefixOverride: string | undefined;
  /** The DO's `WORKSPACE_FLUSH_CONTEXT_KEY`. */
  flushContext(): Promise<{ prefix: string; freshProvision?: boolean } | undefined>;
  containerRunning(): boolean;
  /** The DO's start queue (`withMigrationStart`): no container start interleaves with begin's check-and-fence. */
  withStartQueue<T>(operation: () => Promise<T>): Promise<T>;
  /** Commit step 4: flush context `{prefix, mountPath: '/workspace'}`, both size flags and the hydrated flag false, `pinWorkspaceStore('r2')`. */
  adoptImportedWorkspace(prefix: string): Promise<void>;
  /** Null when AWS routing, the tunnel registry or the origin zone is absent: nothing reaches a host. */
  host: ExportHostAccess | null;
  now(): number;
}

/** `ezil:reverseImport` (§4.1). At most one exists per Durable Object. */
export interface ReverseImportState extends ImportIds, ExportBinding {
  store: 'r2';
  prefix: string;
  headKind: 'none' | 'migrated';
  migratedEtag: string | null;
  systemMigratedEtag: string | null;
  startedAt: string;
  verified?: { sha256: string; chunkCount: number };
  committing?: true;
  /**
   * Commit step 3's own write, recorded BEFORE it: the generation of the system head it puts back.
   * A retry that finds that v1 system head knows the revert already landed (step 3 stays
   * idempotent, §4.4); any other v1 system head is `system_head_moved`.
   */
  systemRevertGeneration?: string;
}
/** `ezil:reverseImport:put:<i>`: recorded from the bytes this Worker hashed and the etag its own put returned. */
interface ChunkRecord { etag: string; size: number; sha256: string }

// ── Store reads ──

type HeadRead =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'migrated'; head: MigratedHead; etag: string }
  | { kind: 'snapshot'; snapshot: Snapshot; etag: string };

/**
 * Either head format, with its etag (`readHead` throws on a migrated head and drops the etag).
 * A store failure throws (503); a head that cannot be parsed is `unreadable`.
 */
async function readAnyHead(bucket: ImportBucket, prefix: string): Promise<HeadRead> {
  const object = await bucket.get(`${prefix}/${SNAPSHOT_HEAD}`);
  if (!object) return { kind: 'none' };
  if (typeof object.size !== 'number' || !Number.isSafeInteger(object.size) || object.size > HEAD_MAX_BYTES || !object.etag) {
    return { kind: 'unreadable' };
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length > HEAD_MAX_BYTES) return { kind: 'unreadable' };
  const raw = new TextDecoder().decode(bytes);
  try {
    const migrated = parseMigratedHead(raw);
    if (migrated) return { kind: 'migrated', head: migrated, etag: object.etag };
    return { kind: 'snapshot', snapshot: parseSnapshot(raw), etag: object.etag };
  } catch {
    return { kind: 'unreadable' };
  }
}

/** This move's own committed head: the commit writes `generation` = `chunkGeneration` = the move's import generation. */
const isOwnHead = (read: HeadRead, generation: string): boolean => read.kind === 'snapshot'
  && read.snapshot.generation === generation && (read.snapshot.chunkGeneration ?? read.snapshot.generation) === generation;

const flagKey = (prefix: string) => `${prefix}/${MIGRATING_FLAG}`;

/**
 * `P/.ezil-snapshots/migrating.json` = `{startedAt, reverse:{moveId, generation}}`. It fences every
 * Cloudflare hydrate, flush, system checkpoint and GC of P, and goes stale 40 min after
 * `startedAt`, so every begin, pull and commit rewrites it once, before any other write (§4.1).
 */
async function raiseFlag(bucket: ImportBucket, prefix: string, ids: ImportIds, deps: ReverseImportDeps): Promise<void> {
  const body = encoder.encode(JSON.stringify({ startedAt: new Date(deps.now()).toISOString(),
    reverse: { moveId: ids.moveId, generation: ids.generation } }));
  if (!await bucket.put(flagKey(prefix), body)) throw new Error('migrating flag write refused');
}

/**
 * Whether P's flag is this move's (abort lowers only its own). A read failure throws (503, the
 * abort is retried): only a flag that is readable and not this move's counts as not own.
 */
async function flagIsOwn(bucket: ImportBucket, prefix: string, ids: ImportIds): Promise<boolean> {
  const object = await bucket.get(flagKey(prefix));
  if (!object || typeof object.size !== 'number' || object.size > FLAG_MAX_BYTES) return false;
  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    const flag = JSON.parse(new TextDecoder().decode(bytes)) as { reverse?: { moveId?: unknown; generation?: unknown } };
    return flag?.reverse?.moveId === ids.moveId && flag.reverse.generation === ids.generation;
  } catch {
    return false;
  }
}

/** Every object under `prefix`, paginated; a repeated cursor or an oversized listing is a store failure (503). */
async function listAll(bucket: ImportBucket, prefix: string): Promise<Array<{ key: string; size?: number; etag?: string }>> {
  const objects: Array<{ key: string; size?: number; etag?: string }> = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    if (objects.length > LIST_MAX_OBJECTS) throw new Error('import listing too large');
    cursor = page.truncated ? page.cursor : undefined;
    if (page.truncated && (!cursor || cursors.has(cursor))) throw new Error('incomplete import listing');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return objects;
}

// ── DO-storage helpers ──

const sameIds = (state: ImportIds, ids: ImportIds) => state.moveId === ids.moveId && state.generation === ids.generation
  && state.computerId === ids.computerId;

/**
 * 🔴 The export boot's binding, recorded at begin, is the only host this import ever asks
 * (§4.1 "Host binding"). A request at another binding is refused before any write or host
 * call, also when the tunnel record carries it: after an abort that never landed, the
 * computer's next hold open is a live desktop at N+2/E+2, and an export POST would stop it
 * (§2.5 step 3). The app's export boot is immutable per move, so its own requests always match.
 */
const sameBinding = (state: ExportBinding, binding: ExportBinding) => state.placementGeneration === binding.placementGeneration
  && state.leaseEpoch === binding.leaseEpoch;

/** Every `ezil:reverseImport*` key, the main key LAST: a crash in between leaves no chunk record without its owner. */
async function clearImportKeys(storage: ImportStorage): Promise<void> {
  const keys = [...(await storage.list<unknown>({ prefix: REVERSE_IMPORT_KEY })).keys()].filter(key => key !== REVERSE_IMPORT_KEY);
  for (let i = 0; i < keys.length; i += DO_BATCH_KEYS) await storage.delete(keys.slice(i, i + DO_BATCH_KEYS));
  await storage.delete([REVERSE_IMPORT_KEY]);
}

async function recordedChunks(storage: ImportStorage): Promise<Map<number, ChunkRecord>> {
  const recorded = new Map<number, ChunkRecord>();
  for (const [key, value] of await storage.list<ChunkRecord>({ prefix: REVERSE_IMPORT_PUT_PREFIX })) {
    const index = Number(key.slice(REVERSE_IMPORT_PUT_PREFIX.length));
    if (Number.isSafeInteger(index) && index >= 0 && index < MAX_CHUNKS) recorded.set(index, value);
  }
  return recorded;
}

// ── Common checks (§4.1) ──

/** A fresh-provision context at `<name>/branches/main` fences a never-used workspace; it is not P and is not compared. */
const isPlaceholder = (wctx: { prefix: string; freshProvision?: boolean }, name: string) => wctx.freshProvision === true
  && wctx.prefix === `${name}/branches/main`;

/**
 * The gate, before any write: never under a deployment-wide prefix, v1 is R2-only, and the
 * DO's own context must be P's. Refuses `prefix_mismatch` or `store_unsupported` only.
 */
async function importTarget(ids: ImportIds, deps: ReverseImportDeps): Promise<{ bucket: ImportBucket; prefix: string }> {
  // A deployment-wide prefix would make this head every computer's (§4.1 env-prefix rule).
  if (deps.prefixOverride !== undefined) throw refuse('prefix_mismatch');
  const selected = await deps.selectStore();
  if (!selected || selected.kind !== 'r2' || !selected.bucket) throw refuse('store_unsupported');
  const prefix = importWorkspacePrefix(ids.computerId);
  const wctx = await deps.flushContext();
  if (wctx && !isPlaceholder(wctx, deps.sandboxName) && wctx.prefix !== prefix) throw refuse('prefix_mismatch');
  return { bucket: selected.bucket, prefix };
}

/** A step after begin must resolve as begin did. */
function checkStateTarget(state: ReverseImportState, prefix: string): void {
  if (state.store !== 'r2') throw refuse('store_unsupported');
  if (state.prefix !== prefix) throw refuse('prefix_mismatch');
}

async function requireState(storage: ImportStorage, ids: ImportIds): Promise<ReverseImportState> {
  const state = await storage.get<ReverseImportState>(REVERSE_IMPORT_KEY);
  if (!state) throw refuse('import_not_started');
  if (!sameIds(state, ids)) throw refuse('import_mismatch');
  return state;
}

// ── Host access (§4.1 "Host binding") ──

/** Reads at most `limit` bytes of a host answer; null when it is longer. Cancels what it does not read. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

async function readHostJson(response: Response, limit: number): Promise<unknown> {
  const bytes = await readCapped(response, limit);
  if (!bytes) return undefined;
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return undefined; }
}

const discard = async (response: Response) => { await response.body?.cancel().catch(() => {}); };

/** The export boot's tunnel record and the way to reach its host, resolved once per request. */
interface ExportTarget { record: AwsTunnelRecord; host: ExportHostAccess }

/**
 * Only the host at the move's own placement generation and lease epoch is ever asked
 * (`export_host_mismatch` otherwise, also when the record is gone). The tunnel is only looked up.
 */
async function exportHost(deps: ReverseImportDeps, ids: ImportIds, binding: ExportBinding): Promise<ExportTarget> {
  const host = deps.host;
  if (!host) throw unreachable();
  let record: AwsTunnelRecord | null;
  try { record = await host.lookup(); } catch { throw unreachable(); }
  if (!record || record.computerId !== ids.computerId || record.generation !== binding.placementGeneration
    || record.leaseEpoch !== binding.leaseEpoch) throw refuse('export_host_mismatch');
  return { record, host };
}

const nowSeconds = (deps: ReverseImportDeps) => Math.floor(deps.now() / 1000);

/** §4.2 step 7: start (or resume) the host's export. 202 → its status. */
async function requestExport(deps: ReverseImportDeps, to: ExportTarget, ids: ImportIds): Promise<ExportStatus> {
  let response: Response;
  let answer: unknown;
  try {
    response = await startAwsExport(to.record, to.host.zone, ids.moveId, ids.generation, to.host.fetch, nowSeconds(deps), EXPORT_POST_TIMEOUT_MS);
    answer = await readHostJson(response, HOST_JSON_MAX_BYTES);
  } catch { throw unreachable(); }
  if (response.status === 202) {
    const status = parseExportStatus(answer);
    if (!status) throw unreachable();
    return status;
  }
  // §4.2 step 7's list (r7), and only it: another move holds the host (`export_busy`), the agent
  // refused the message (`export_invalid`: the edge sends it only for a refusal the agent itself
  // answered after the Sequencer's one retry, bad_mac/wrong_epoch/stale/replayed, which a retry on
  // the same host cannot clear), or the host refused the body (any 400). Anything else is retried,
  // including any other 409 (a relayed raw agent error) and the edge's 503 agent_unavailable.
  const error = (answer as { error?: unknown } | undefined)?.error;
  if (response.status === 400 || (response.status === 409 && (error === 'export_busy' || error === 'export_invalid'))) {
    throw refuse('export_refused');
  }
  throw unreachable();
}

async function readExportStatus(deps: ReverseImportDeps, to: ExportTarget): Promise<ExportStatus> {
  let response: Response;
  try { response = await readAwsExport(to.record, to.host.zone, 'status', to.host.fetch, nowSeconds(deps), EXPORT_READ_TIMEOUT_MS); }
  catch { throw unreachable(); }
  if (response.status !== 200) { await discard(response); throw unreachable(); }
  let status: ExportStatus | null;
  try { status = parseExportStatus(await readHostJson(response, HOST_JSON_MAX_BYTES)); } catch { throw unreachable(); }
  if (!status) throw unreachable();
  return status;
}

async function readExportHead(deps: ReverseImportDeps, to: ExportTarget, ids: ImportIds): Promise<ExportHead> {
  let response: Response;
  try { response = await readAwsExport(to.record, to.host.zone, 'head', to.host.fetch, nowSeconds(deps), EXPORT_READ_TIMEOUT_MS); }
  catch { throw unreachable(); }
  if (response.status !== 200) { await discard(response); throw unreachable(); }
  let raw: Uint8Array | null;
  try { raw = await readCapped(response, HEAD_MAX_BYTES); } catch { throw unreachable(); }
  let parsed: unknown;
  try { parsed = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined; } catch { parsed = undefined; }
  const head = parseExportHead(parsed, ids);
  if (!head) throw refuse('export_head_invalid');
  return head;
}

/** One chunk, hash-checked against the export head before it is stored; its record comes from this Worker's own put. */
async function transferChunk(deps: ReverseImportDeps, to: ExportTarget, store: { bucket: ImportBucket; prefix: string },
  head: ExportHead, index: number, timeoutMs: number): Promise<void> {
  const expected = head.chunks[index]!;
  let response: Response;
  try { response = await readAwsExport(to.record, to.host.zone, { chunk: index }, to.host.fetch, nowSeconds(deps), timeoutMs); }
  catch { throw unreachable(); }
  if (response.status !== 200) { await discard(response); throw unreachable(); }
  const declared = response.headers.get('content-length');
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) !== expected.size) {
    await discard(response);
    throw refuse('chunk_mismatch');
  }
  let bytes: Uint8Array | null;
  try { bytes = await readCapped(response, expected.size); } catch { throw unreachable(); }
  if (!bytes || bytes.length !== expected.size || await sha256(bytes) !== expected.sha256) throw refuse('chunk_mismatch');
  const put = await store.bucket.put(chunkKey(store.prefix, head.generation, index), bytes);
  if (!put?.etag) throw new Error('chunk put refused');
  await deps.storage.put<ChunkRecord>(`${REVERSE_IMPORT_PUT_PREFIX}${index}`, { etag: put.etag, size: expected.size, sha256: expected.sha256 });
}

// ── §4.2 begin ──

async function begin(request: Extract<ImportRequest, { op: 'begin' }>, deps: ReverseImportDeps): Promise<ImportAnswer> {
  if (deps.containerRunning()) throw refuse('container_running');
  const target = await importTarget(request, deps);
  const existing = await deps.storage.get<ReverseImportState>(REVERSE_IMPORT_KEY);
  if (existing) {
    // Another move holds this computer. The same move goes to step 7 (§4.2 step 3), and only
    // at its export boot's binding.
    if (!sameIds(existing, request)) throw refuse('import_busy');
    checkStateTarget(existing, target.prefix);
    if (!sameBinding(existing, request)) throw refuse('export_host_mismatch');
    await raiseFlag(target.bucket, target.prefix, request, deps);
    const status = await requestExport(deps, await exportHost(deps, request, request), request);
    return { status: 200, body: { ok: true, headKind: existing.headKind, export: status } };
  }
  const state = await deps.withStartQueue(async () => {
    // Inside the start queue: no container start lands between this check and the fence.
    if (deps.containerRunning()) throw refuse('container_running');
    const head = await readAnyHead(target.bucket, target.prefix);
    let headKind: ReverseImportState['headKind'] = 'none';
    let migratedEtag: string | null = null;
    if (head.kind === 'unreadable') throw refuse('head_unreadable');
    if (head.kind === 'snapshot') throw refuse(isOwnHead(head, request.generation) ? 'already_imported' : 'head_moved');
    if (head.kind === 'migrated') {
      // Only a computer this Worker exported to AWS. A Cloudflare v1 head is never overwritten.
      if (head.head.targetProvider !== 'aws-ec2') throw refuse('head_invalid');
      headKind = 'migrated';
      migratedEtag = head.etag;
    }
    const systemPrefix = systemPrefixOf(target.prefix);
    if (!systemPrefix) throw refuse('prefix_mismatch');
    const system = await readAnyHead(target.bucket, systemPrefix);
    if (system.kind === 'snapshot') throw refuse('system_head_moved');
    if (system.kind === 'unreadable') throw refuse('head_unreadable');
    // Step 6: the flag is the first write (§4.1). A begin that dies before its key leaves only
    // this move's flag, which an abort lowers (and which goes stale on its own).
    await raiseFlag(target.bucket, target.prefix, request, deps);
    // An earlier move's commit or abort that died between its key deletes must not lend
    // this move its chunk records.
    await clearImportKeys(deps.storage);
    const fresh: ReverseImportState = {
      moveId: request.moveId, generation: request.generation, computerId: request.computerId,
      placementGeneration: request.placementGeneration, leaseEpoch: request.leaseEpoch, store: 'r2', prefix: target.prefix,
      headKind, migratedEtag, systemMigratedEtag: system.kind === 'migrated' ? system.etag : null,
      startedAt: new Date(deps.now()).toISOString(),
    };
    await deps.storage.put(REVERSE_IMPORT_KEY, fresh);
    return fresh;
  });
  const status = await requestExport(deps, await exportHost(deps, request, request), request);
  return { status: 200, body: { ok: true, headKind: state.headKind, export: status } };
}

// ── §4.3 pull ──

async function pull(request: Extract<ImportRequest, { op: 'pull' }>, deps: ReverseImportDeps, startedAt: number): Promise<ImportAnswer> {
  // The ids pick the import (§4.3 step 1); the binding begin recorded is the only host.
  const state = await requireState(deps.storage, request);
  const target = await importTarget(request, deps);
  checkStateTarget(state, target.prefix);
  if (!sameBinding(state, request)) throw refuse('export_host_mismatch');
  await raiseFlag(target.bucket, target.prefix, request, deps);
  const to = await exportHost(deps, request, request);
  const status = await readExportStatus(deps, to);
  const notReady = (exportStatus: ExportStatus): ImportAnswer => ({ status: 200,
    body: { ok: true, export: exportStatus, head: null, stored: [], next: request.from } });
  if (status.state === 'none' || status.moveId !== request.moveId || status.generation !== request.generation) {
    // The host lost the POST or never got it (or still reports another job, which the POST refuses).
    return notReady(await requestExport(deps, to, request));
  }
  if (status.state === 'failed') throw refuse(FAILED_EXPORT_CODES[status.error!]);
  if (status.state === 'capturing') return notReady(status);
  let head = await deps.storage.get<ExportHead>(REVERSE_IMPORT_HEAD_KEY);
  if (!head) {
    head = await readExportHead(deps, to, request);
    await deps.storage.put(REVERSE_IMPORT_HEAD_KEY, head);
  }
  const recorded = await recordedChunks(deps.storage);
  const end = Math.min(request.from + request.count, head.chunks.length);
  const stored = new Set<number>();
  const pending: number[] = [];
  for (let i = request.from; i < end; i++) {
    if (recorded.has(i)) stored.add(i);
    else pending.push(i);
  }
  let mismatch: ImportRefusal | undefined;
  let transient: unknown;
  let landed = 0;
  let nextPending = 0;
  const worker = async () => {
    // No new transfer after a failure or after the window; the ones in flight finish.
    while (mismatch === undefined && transient === undefined && nextPending < pending.length) {
      if (deps.now() - startedAt >= PULL_TRANSFER_WINDOW_MS) return;
      const index = pending[nextPending++]!;
      try {
        await transferChunk(deps, to, target, head!, index, chunkTimeoutMs(startedAt, deps.now()));
        stored.add(index);
        landed++;
      } catch (err) {
        if (err instanceof ImportRefusal && err.status === 409) mismatch ??= err;
        else transient ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PULL_CONCURRENCY, pending.length) }, worker));
  // 🔴 A chunk that is not the export head's is never stored, and the app reopens (§4.3 step 4,
  // §5.5 `import_corrupt`): that answer wins over any progress.
  if (mismatch) throw mismatch;
  if (transient !== undefined) {
    // A host, tunnel or store failure. With nothing new landed it is this pull's 503 (§4.1).
    // Otherwise the pull answers what landed, as when the 20 s window ends: the app records it
    // as progress, and the next pull starts at `next`, the first chunk still missing. A 503 here
    // would drop that progress and count a copy that is advancing as a retry (§5.4, §5.5).
    if (landed === 0) throw transient;
    console.warn(`[reverse-import] pull stopped early: ${transient instanceof ImportRefusal ? transient.code : 'store_unavailable'}`);
  }
  let next: number | null = null;
  for (let i = request.from; i < head.chunks.length; i++) {
    if (!recorded.has(i) && !stored.has(i)) { next = i; break; }
  }
  return { status: 200, body: { ok: true, export: status, head, stored: [...stored].sort((a, b) => a - b), next } };
}

// ── §4.4 commit ──

async function verify(request: Extract<ImportRequest, { op: 'commit' }>, deps: ReverseImportDeps): Promise<ImportAnswer> {
  const state = await requireState(deps.storage, request);
  const target = await importTarget(request, deps);
  checkStateTarget(state, target.prefix);
  await raiseFlag(target.bucket, target.prefix, request, deps);
  const head = await deps.storage.get<ExportHead>(REVERSE_IMPORT_HEAD_KEY);
  if (!head || head.sha256 !== request.sha256 || head.chunks.length !== request.chunkCount) throw refuse('not_verified');
  const recorded = await recordedChunks(deps.storage);
  // One paginated listing of this generation: no per-chunk HEAD, no customMetadata, no re-hash.
  // Integrity rests on the sha256 checked at pull, the etag pinned at put, and the first
  // Cloudflare hydrate re-verifying every chunk.
  const listed = new Map((await listAll(target.bucket, `${target.prefix}/.ezil-snapshots/${request.generation}/`)).map(o => [o.key, o]));
  for (const [index, chunk] of head.chunks.entries()) {
    const put = recorded.get(index);
    const object = listed.get(chunkKey(target.prefix, request.generation, index));
    if (!put || put.size !== chunk.size || put.sha256 !== chunk.sha256 || !object || object.size !== put.size
      || !object.etag || normalizeEtag(object.etag) !== normalizeEtag(put.etag)) throw refuse('not_verified');
  }
  try { importedSnapshot(head); } catch { throw refuse('not_verified'); }
  await deps.storage.put<ReverseImportState>(REVERSE_IMPORT_KEY, { ...state, verified: { sha256: head.sha256, chunkCount: head.chunks.length } });
  return { status: 200, body: { ok: true, verified: true } };
}

const COMMITTED: ImportAnswer = { status: 200, body: { ok: true, committed: true, store: 'r2' } };

/**
 * Commit steps 3–5, each idempotent: revert the system head, re-arm the next Cloudflare open,
 * lower the fences. Runs after this move's v1 head is at P (the point of no return).
 */
async function completeCommit(state: ReverseImportState, target: { bucket: ImportBucket; prefix: string }, deps: ReverseImportDeps): Promise<void> {
  // Step 3. A migrated system head blocks system saves forever (system-persist.ts); `previous`
  // brings back the user's pre-move Cloudflare settings.
  const systemPrefix = systemPrefixOf(target.prefix)!;
  const system = await readAnyHead(target.bucket, systemPrefix);
  if (system.kind === 'migrated') {
    if (system.etag !== state.systemMigratedEtag) throw refuse('system_head_moved');
    if (system.head.previous) {
      await deps.storage.put<ReverseImportState>(REVERSE_IMPORT_KEY, { ...state, systemRevertGeneration: system.head.previous.generation });
      const put = await target.bucket.put(`${systemPrefix}/${SNAPSHOT_HEAD}`, encoder.encode(JSON.stringify(system.head.previous)),
        { onlyIf: { etagMatches: system.etag } });
      if (!put) throw refuse('system_head_moved');
    } else {
      // A legacy marker without `previous`: nothing to bring back.
      await target.bucket.delete([`${systemPrefix}/${SNAPSHOT_HEAD}`]);
    }
  } else if (system.kind === 'snapshot') {
    if (!state.systemRevertGeneration || system.snapshot.generation !== state.systemRevertGeneration) throw refuse('system_head_moved');
  } else if (system.kind === 'unreadable') {
    throw refuse('system_head_moved');
  }
  // Step 4. A fresh-provision placeholder's own fence goes first, so a retry still sees the placeholder.
  const wctx = await deps.flushContext();
  if (wctx && isPlaceholder(wctx, deps.sandboxName)) await target.bucket.delete([flagKey(wctx.prefix)]);
  await deps.adoptImportedWorkspace(target.prefix);
  // Step 5.
  await target.bucket.delete([flagKey(target.prefix)]);
  await clearImportKeys(deps.storage);
}

async function commit(request: Extract<ImportRequest, { op: 'commit' }>, deps: ReverseImportDeps): Promise<ImportAnswer> {
  const target = await importTarget(request, deps);
  // P first, before any DO-key check: a successful commit deletes the key, so a retry after a
  // lost answer must recognise its own head.
  const current = await readAnyHead(target.bucket, target.prefix);
  const state = await deps.storage.get<ReverseImportState>(REVERSE_IMPORT_KEY);
  if (isOwnHead(current, request.generation)) {
    // 🔴 Every step already ran: touch nothing. Raising the flag again would fence the first
    // Cloudflare open (`migrating`) for 40 minutes.
    if (!state) return COMMITTED;
    if (!sameIds(state, request)) throw refuse('import_mismatch');
    checkStateTarget(state, target.prefix);
    await raiseFlag(target.bucket, target.prefix, request, deps);
    await completeCommit(state, target, deps);
    return COMMITTED;
  }
  if (!state) throw refuse('not_verified');
  if (!sameIds(state, request)) throw refuse('import_mismatch');
  checkStateTarget(state, target.prefix);
  const head = await deps.storage.get<ExportHead>(REVERSE_IMPORT_HEAD_KEY);
  if (!state.verified || state.verified.sha256 !== request.sha256 || state.verified.chunkCount !== request.chunkCount
    || !head || head.sha256 !== request.sha256 || head.chunks.length !== request.chunkCount) throw refuse('not_verified');
  let snapshot: Snapshot;
  try { snapshot = importedSnapshot(head); } catch { throw refuse('not_verified'); }
  await raiseFlag(target.bucket, target.prefix, request, deps);
  // Step 1: persisted BEFORE the CAS, so abort refuses (`commit_in_progress`) from here on.
  const committing: ReverseImportState = { ...state, committing: true };
  await deps.storage.put(REVERSE_IMPORT_KEY, committing);
  // Step 2: the point of no return on the Worker side.
  const put = await target.bucket.put(`${target.prefix}/${SNAPSHOT_HEAD}`, encoder.encode(JSON.stringify(snapshot)), {
    onlyIf: state.headKind === 'migrated' ? { etagMatches: state.migratedEtag ?? '' } : { etagDoesNotMatch: '*' },
  });
  if (!put && !isOwnHead(await readAnyHead(target.bucket, target.prefix), request.generation)) {
    // Cloudflare wrote since (or the head changed some other way): never overwritten.
    const { committing: _released, ...released } = committing;
    await deps.storage.put<ReverseImportState>(REVERSE_IMPORT_KEY, released);
    throw refuse('head_moved');
  }
  await completeCommit(committing, target, deps);
  return COMMITTED;
}

// ── §4.5 abort ──

const ABORTED: ImportAnswer = { status: 200, body: { ok: true } };

async function abort(request: Extract<ImportRequest, { op: 'abort' }>, deps: ReverseImportDeps): Promise<ImportAnswer> {
  const state = await deps.storage.get<ReverseImportState>(REVERSE_IMPORT_KEY);
  if (state?.committing) throw refuse('commit_in_progress');
  const own = state !== undefined && sameIds(state, request);
  let target: { bucket: ImportBucket; prefix: string };
  try {
    target = await importTarget(request, deps);
  } catch (err) {
    // 🔴 With no key of this move, abort is idempotent (§4.5), also behind a refusing gate.
    // Begin refuses before any write there, and every later write needs this move's key.
    // At most a flag remains, from a begin that died before its key under a gate that let
    // it through then; it goes stale on its own. Answering the refusal instead would turn the
    // compensation of a refused begin into `abort_unconfirmed` (§5.5, §5.7). A key of this
    // move keeps the 409: its chunks cannot be cleaned through this gate.
    if (!own && err instanceof ImportRefusal && (err.code === 'prefix_mismatch' || err.code === 'store_unsupported')) return ABORTED;
    throw err;
  }
  if (isOwnHead(await readAnyHead(target.bucket, target.prefix), request.generation)) throw refuse('already_imported');
  const chunks = (await listAll(target.bucket, `${target.prefix}/.ezil-snapshots/${request.generation}/`)).map(o => o.key);
  for (let i = 0; i < chunks.length; i += 1000) await target.bucket.delete(chunks.slice(i, i + 1000));
  if (await flagIsOwn(target.bucket, target.prefix, request)) await target.bucket.delete([flagKey(target.prefix)]);
  if (own) await clearImportKeys(deps.storage);
  // Nothing is sent to the host: the app retires the export boot.
  return ABORTED;
}

/**
 * Run one import op. The caller serialises all four ops of one Durable Object through one
 * queue, so commit and abort never interleave around the store I/O. `startedAt` is when the
 * request arrived (before that queue): pull's 20 s transfer window counts the wait.
 */
export async function runReverseImport(request: ImportRequest, deps: ReverseImportDeps, startedAt = deps.now()): Promise<ImportAnswer> {
  // A deployment-wide prefix would make this head every computer's: no op runs under one,
  // whatever else holds (§4.1 env-prefix rule). Abort meets it in its gate, after its key read:
  // with no key of this move it is idempotent (§4.5).
  if (deps.prefixOverride !== undefined && request.op !== 'abort') return { status: 409, body: { ok: false, error: 'prefix_mismatch' } };
  try {
    switch (request.op) {
      case 'begin': return await begin(request, deps);
      case 'pull': return await pull(request, deps, startedAt);
      case 'commit': return await (request.verifyOnly ? verify(request, deps) : commit(request, deps));
      case 'abort': return await abort(request, deps);
    }
  } catch (err) {
    if (err instanceof ImportRefusal) return { status: err.status, body: { ok: false, error: err.code } };
    // A store or DO-storage failure: transient, never a 409. Never log its message (keys, bytes).
    console.error(`[reverse-import] ${request.op} failed: store_unavailable`);
    return { status: 503, body: { ok: false, error: 'store_unavailable' } };
  }
}
