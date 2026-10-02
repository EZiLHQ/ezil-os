/**
 * S3-backed durable workspace store (founder decision 2026-10-02).
 *
 * The atomic checkpoint module (`./workspace-persist.ts`) and the one-time seed
 * decision (`./workspace-seed.ts`) talk to durable storage ONLY through the
 * structural `get` / `put(onlyIf)` / `list` surface those modules declare
 * (`FlushR2BucketLike`, `HydrateR2BucketLike`, `SeedR2BucketLike`). This module
 * implements that same surface against AWS S3 (or any S3-compatible endpoint),
 * so the checkpoint/seed logic runs UNCHANGED on top of it — the only thing
 * that changes is where the bytes land.
 *
 * Three things live here:
 *   1. `S3WorkspaceStore` — a plain S3 object store (SigV4 via aws4fetch).
 *   2. `MigratingWorkspaceStore` — a read-through wrapper used when a computer
 *      is being switched from the R2 binding to S3: reads fall back to R2 until
 *      S3 holds the checkpoint head, writes always go to S3, and an existing R2
 *      checkpoint is copied forward into S3 so the first flush is never fenced.
 *   3. `resolveWorkspaceStore(env)` — the FAIL-CLOSED selector.
 *
 * ── Why the store is never an s3fs mount ────────────────────────────────────
 * `docs/PLATFORM-NOTES.md` §1: `sandbox.mountBucket()` (s3fs) silently drops
 * every second write. This store is reached from the Worker's own
 * hydrate/flush path (`index.ts` `hydrateWorkspace` / `runWorkspaceFlush`),
 * never mounted into the container as a filesystem.
 *
 * ── ETag domain note ────────────────────────────────────────────────────────
 * `get()` returns etags NORMALIZED (no weak `W/` marker, no surrounding
 * quotes); `put(onlyIf.etagMatches)` RE-QUOTES before sending `If-Match`. The
 * checkpoint module compares etags from `get()` for equality (restore-time
 * stability checks) and feeds a prior `get()` etag straight back into a later
 * `put(onlyIf)` (the compare-and-swap commit). Normalizing on the way in and
 * re-quoting on the way out keeps those two uses consistent against a server
 * that echoes quoted ETags.
 */
import {
  SNAPSHOT_HEAD,
  SNAPSHOT_CHUNK_BYTES,
  parseSnapshot,
} from './workspace-persist';

// ── Public structural surface ───────────────────────────────────────────────
//
// Deliberately a minimal structural type, assignable to all three of the
// checkpoint/seed module interfaces, so one object serves hydrate, flush AND
// seed. `list` objects carry `size` (hydrate reads it) and `etag` (seed's
// result type requires it); callers that only need `key` ignore the rest.

export interface WorkspaceObjectBody {
  /** Normalized: no weak `W/` marker, no surrounding quotes. */
  etag: string;
  /** From `Content-Length`. The caller refuses an unknown/invalid size. */
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WorkspacePutResult {
  key: string;
  etag: string;
}

export interface WorkspaceListResult {
  objects: Array<{ key: string; size: number; etag: string; uploaded?: Date }>;
  truncated: boolean;
  cursor?: string;
}

export interface WorkspacePutOptions {
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
}

export interface WorkspaceGetOptions {
  /** Partial read (large legacy objects). `size` on the result stays the WHOLE object's size, as on R2. */
  range?: { offset: number; length: number };
}

export interface WorkspaceStore {
  get(key: string, options?: WorkspaceGetOptions): Promise<WorkspaceObjectBody | null>;
  put(key: string, value: Uint8Array | string, options?: WorkspacePutOptions): Promise<WorkspacePutResult | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<WorkspaceListResult>;
  /** Used only by checkpoint garbage collection (never by the put-only flush). */
  delete(keys: string[]): Promise<unknown>;
}

/** Injectable `fetch` (tests inject an in-process fake S3 HTTP handler). */
export type FetchLike = (input: Request) => Promise<Response>;

export interface S3WorkspaceStoreConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style endpoint (MinIO / local / tests). Absent → virtual-hosted AWS. */
  endpoint?: string;
  /** Static prefix inside the bucket, applied to all keys and stripped from listings. */
  keyPrefix?: string;
  /** Server-side encryption header, optional. */
  sse?: 'AES256' | 'aws:kms';
  kmsKeyId?: string;
  /** Force path-style even without an endpoint (rarely needed). */
  forcePathStyle?: boolean;
  fetchImpl?: FetchLike;
}

// A read object with the body already buffered (bounded). Returning the buffer
// synchronously keeps `arrayBuffer()` cheap and never leaves a response stream
// dangling, which some runtimes treat as a leak.
const MAX_GET_BYTES = 64 * 1024 * 1024;

export function normalizeEtag(raw: string): string {
  let e = raw.trim();
  if (e.startsWith('W/')) e = e.slice(2);
  if (e.length >= 2 && e.startsWith('"') && e.endsWith('"')) e = e.slice(1, -1);
  return e;
}

function requoteEtag(etag: string): string {
  return `"${normalizeEtag(etag)}"`;
}

/** Encode one object key: each `/`-separated segment encoded once, slashes kept. */
function encodeObjectPath(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    switch (body) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'amp': return '&';
      case 'quot': return '"';
      case 'apos': return "'";
      default: return whole;
    }
  });
}

/**
 * Decode an S3 `encoding-type=url` key. S3 percent-encodes the key; botocore
 * decodes it with `unquote` (NOT `unquote_plus`), i.e. `%20` → space and a
 * literal `+` stays `+`. `decodeURIComponent` matches that exactly (it never
 * maps `+` to space). NOTE: this `+`/space assumption is NOT verified against
 * live S3 here — see the module/report notes.
 */
function decodeS3Key(key: string): string {
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const DRAIN_LIMIT_BYTES = 64 * 1024;
async function drain(res: Response): Promise<void> {
  // Read small (error/empty) bodies to the end so the connection can be
  // reused cleanly; only an unexpectedly large body is cancelled.
  try {
    const reader = res.body?.getReader();
    if (!reader) return;
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value?.byteLength ?? 0;
      if (total > DRAIN_LIMIT_BYTES) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    /* best-effort */
  }
}

// aws4fetch is a dependency of @cloudflare/sandbox (worker/bun.lock) and is
// declared directly in worker/package.json. Signing is done via `sign()` + an
// injectable fetch (never `AwsClient.fetch`, which retries 5xx/429 — a retried
// conditional PUT that actually landed would come back 412 and read as a false
// conflict).
import { AwsClient } from 'aws4fetch';

export class S3WorkspaceStore implements WorkspaceStore {
  private readonly client: AwsClient;
  private readonly fetchImpl: FetchLike;
  private readonly bucket: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private readonly pathStyle: boolean;
  private readonly keyPrefix: string;
  private readonly sse?: 'AES256' | 'aws:kms';
  private readonly kmsKeyId?: string;

  constructor(config: S3WorkspaceStoreConfig) {
    this.bucket = config.bucket;
    this.region = config.region;
    this.endpoint = config.endpoint;
    this.pathStyle = config.forcePathStyle ?? !!config.endpoint;
    // Normalize keyPrefix to either '' or something ending in exactly one '/'.
    const kp = (config.keyPrefix ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
    this.keyPrefix = kp ? `${kp}/` : '';
    this.sse = config.sse;
    this.kmsKeyId = config.kmsKeyId;
    this.fetchImpl = config.fetchImpl ?? ((input) => fetch(input));
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
      // We call sign()+fetchImpl ourselves; never AwsClient.fetch. retries:0 is
      // belt-and-braces against a conditional PUT being silently replayed.
      retries: 0,
    });
  }

  private fullKey(key: string): string {
    return this.keyPrefix + key;
  }

  private stripKeyPrefix(fullKey: string): string {
    return this.keyPrefix && fullKey.startsWith(this.keyPrefix)
      ? fullKey.slice(this.keyPrefix.length)
      : fullKey;
  }

  private originAndBucketPath(): string {
    if (this.pathStyle) {
      const origin = (this.endpoint ?? `https://s3.${this.region}.amazonaws.com`).replace(/\/+$/, '');
      return `${origin}/${encodeURIComponent(this.bucket)}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com`;
  }

  private objectUrl(key: string): string {
    return `${this.originAndBucketPath()}/${encodeObjectPath(this.fullKey(key))}`;
  }

  private listUrl(params: URLSearchParams): string {
    return `${this.originAndBucketPath()}/?${params.toString()}`;
  }

  private async send(
    method: string,
    url: string,
    extraHeaders: Record<string, string>,
    body?: Uint8Array | string,
  ): Promise<Response> {
    const signed = await this.client.sign(url, { method, headers: extraHeaders, body });
    return this.fetchImpl(signed);
  }

  async get(key: string, options?: WorkspaceGetOptions): Promise<WorkspaceObjectBody | null> {
    // Accept-Encoding: identity so no edge/transfer compression can strip the
    // Content-Length we rely on (see docs/PLATFORM-NOTES for the R2 HEAD case).
    const range = options?.range;
    if (range && (!Number.isInteger(range.offset) || range.offset < 0 || !Number.isInteger(range.length) || range.length <= 0)) {
      throw new Error('workspace store invalid range');
    }
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    if (range) headers['range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    const res = await this.send('GET', this.objectUrl(key), headers);
    if (res.status === 404) {
      await drain(res);
      return null;
    }
    if (!res.ok) {
      await drain(res);
      // Never include response bodies/keys/credentials in the message.
      throw new Error(`workspace store get failed (status ${res.status})`);
    }
    const etagRaw = res.headers.get('etag');
    if (!etagRaw) {
      await drain(res);
      throw new Error('workspace store get missing etag');
    }
    const lenRaw = res.headers.get('content-length');
    const size = lenRaw == null ? Number.NaN : Number(lenRaw);
    if (!Number.isInteger(size) || size < 0) {
      await drain(res);
      throw new Error('workspace store get missing content-length');
    }
    if (size > MAX_GET_BYTES) {
      await drain(res);
      throw new Error('workspace store object too large');
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== size) {
      throw new Error('workspace store content-length mismatch');
    }
    const etag = normalizeEtag(etagRaw);
    if (range) {
      // 206 + `Content-Range: bytes a-b/total`: report the whole object's size (R2 semantics).
      const total = res.status === 206 ? /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1] : undefined;
      if (total === undefined) throw new Error('workspace store range not honoured');
      return { etag, size: Number(total), arrayBuffer: async () => buf };
    }
    return { etag, size, arrayBuffer: async () => buf };
  }

  async delete(keys: string[]): Promise<void> {
    // One DeleteObject per key: DeleteObjects needs Content-MD5/checksums and GC is rare and bounded.
    for (const key of keys) {
      const res = await this.send('DELETE', this.objectUrl(key), {});
      await drain(res);
      if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
        throw new Error(`workspace store delete failed (status ${res.status})`);
      }
    }
  }

  async put(key: string, value: Uint8Array | string, options?: WorkspacePutOptions): Promise<WorkspacePutResult | null> {
    const headers: Record<string, string> = {};
    const onlyIf = options?.onlyIf;
    if (onlyIf !== undefined) {
      const { etagMatches, etagDoesNotMatch } = onlyIf;
      if (etagMatches != null && etagDoesNotMatch != null) {
        throw new Error('workspace store unsupported precondition');
      }
      if (etagMatches != null) {
        headers['if-match'] = requoteEtag(etagMatches);
      } else if (etagDoesNotMatch === '*') {
        headers['if-none-match'] = '*';
      } else {
        // etagDoesNotMatch set to something other than '*', or an empty onlyIf.
        throw new Error('workspace store unsupported precondition');
      }
    }
    if (this.sse) {
      headers['x-amz-server-side-encryption'] = this.sse;
      if (this.sse === 'aws:kms' && this.kmsKeyId) {
        headers['x-amz-server-side-encryption-aws-kms-key-id'] = this.kmsKeyId;
      }
    }
    const res = await this.send('PUT', this.objectUrl(key), headers, value);
    // 412 PreconditionFailed and 409 ConditionalRequestConflict are the two
    // "your precondition lost" outcomes. NEVER retried — a retry of a PUT that
    // actually landed would itself come back 412 and read as a false conflict.
    if (res.status === 412 || res.status === 409) {
      await drain(res);
      return null;
    }
    if (!res.ok) {
      await drain(res);
      throw new Error(`workspace store put failed (status ${res.status})`);
    }
    const etagRaw = res.headers.get('etag');
    await drain(res);
    return { key, etag: etagRaw ? normalizeEtag(etagRaw) : '' };
  }

  async list(options: { prefix: string; cursor?: string; limit?: number }): Promise<WorkspaceListResult> {
    const params = new URLSearchParams();
    params.set('list-type', '2');
    params.set('encoding-type', 'url');
    const fullPrefix = this.fullKey(options.prefix);
    if (fullPrefix) params.set('prefix', fullPrefix);
    if (options.limit != null) params.set('max-keys', String(options.limit));
    if (options.cursor) params.set('continuation-token', options.cursor);
    const res = await this.send('GET', this.listUrl(params), { 'accept-encoding': 'identity' });
    if (!res.ok) {
      await drain(res);
      throw new Error(`workspace store list failed (status ${res.status})`);
    }
    const xml = await res.text();
    return this.parseListXml(xml);
  }

  private parseListXml(xml: string): WorkspaceListResult {
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
    const cursorMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    const cursor = cursorMatch ? decodeXmlEntities(cursorMatch[1].trim()) : undefined;
    const objects: WorkspaceListResult['objects'] = [];
    const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = contentsRe.exec(xml)) !== null) {
      const block = m[1];
      const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
      if (!keyMatch) continue;
      const sizeMatch = block.match(/<Size>\s*(\d+)\s*<\/Size>/);
      const etagMatch = block.match(/<ETag>([\s\S]*?)<\/ETag>/);
      const modifiedMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
      // `encoding-type=url` means the key is percent-encoded in the XML; XML
      // entities (if any) are decoded first, then the percent-encoding.
      const key = this.stripKeyPrefix(decodeS3Key(decodeXmlEntities(keyMatch[1])));
      const size = sizeMatch ? Number(sizeMatch[1]) : Number.NaN;
      const etag = etagMatch ? normalizeEtag(decodeXmlEntities(etagMatch[1].trim())) : '';
      const uploaded = modifiedMatch ? new Date(modifiedMatch[1].trim()) : undefined;
      objects.push({ key, size: Number.isInteger(size) ? size : 0, etag,
        ...(uploaded && !Number.isNaN(uploaded.getTime()) ? { uploaded } : {}) });
    }
    return { objects, truncated, cursor: truncated ? cursor : undefined };
  }
}

// ── Migrating read-through store (R2 → S3 one-way) ───────────────────────────
//
// Used ONLY when EZIL_WORKSPACE_STORE='s3' AND the R2 binding is still present.
// Per prefix it decides, once, where reads come from:
//   * S3 already holds `${prefix}/.ezil-snapshots/latest.json`  → read S3.
//   * else R2 holds a committed checkpoint head                 → COPY IT FORWARD
//       into S3 (head + its chunks, same keys), then read S3.
//   * else R2 still has loose legacy files                      → read R2.
//   * else (R2 empty, nothing to migrate)                       → read S3.
// WRITES ALWAYS GO TO S3. The routing decision is cached per prefix for the
// life of THIS store instance (one hydrate / one flush) so the checkpoint
// module's repeated readHead/etag-stability checks stay consistent.
//
// ── Why copy-forward, not "first flush writes a full snapshot" ───────────────
// The brief's model ("reads fall back to R2, the first flush writes a full
// snapshot to S3") holds for the LEGACY-loose-files and BRAND-NEW cases, where
// the restored workspace marker carries no `checkpoint` and a flush with
// `expected=null` is accepted. It does NOT hold when R2 has a COMMITTED
// checkpoint: `workspace-snapshot-script.ts`'s capture step asserts the local
// marker's `checkpoint` equals the flush's `expected`, and an R2 restore writes
// `checkpoint=<R2 generation>`. A flush that saw an empty S3 head (expected=null)
// is then fenced with "workspace writer is stale" and the switch would brick
// every R2-checkpointed computer. Copying the R2 head+chunks forward so S3 holds
// `<R2 generation>` BEFORE the flush makes the first flush an ordinary CAS
// advance. This one divergence from the brief's wording is reported, not worked
// around silently (MANDATORY clause 3).
//
// ── One-way ─────────────────────────────────────────────────────────────────
// Once any write has gone to S3, R2 is stale. Switching EZIL_WORKSPACE_STORE
// back to 'r2' after that would restore an out-of-date workspace. See
// docs/WORKSPACE-STORE.md.

type ReadRoute = 's3' | 'r2';

/** Mirrors `workspace-persist.ts`'s private chunk-key layout (kept in sync by tests). */
function chunkKey(prefix: string, generation: string, index: number): string {
  return `${prefix}/.ezil-snapshots/${generation}/${index}`;
}

function headKey(prefix: string): string {
  return `${prefix}/${SNAPSHOT_HEAD}`;
}

/** Strip the trailing slash(es) a `${prefix}/` list argument carries. */
function normalizePrefix(prefix: string): string {
  return prefix.replace(/\/+$/, '');
}

export class MigratingWorkspaceStore implements WorkspaceStore {
  private readonly routes = new Map<string, Promise<ReadRoute>>();

  constructor(
    private readonly s3: WorkspaceStore,
    private readonly r2: WorkspaceStore,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /** Derive the logical prefix a key belongs to (for read routing). */
  private prefixOfKey(key: string): string | null {
    const marker = '/.ezil-snapshots/';
    const idx = key.indexOf(marker);
    if (idx > 0) return key.slice(0, idx);
    // Legacy loose key `${prefix}/${rel}` or the seed sentinel: match the
    // longest prefix already routed this hydrate (the head get / list that
    // precedes any legacy get always establishes it first).
    let best: string | null = null;
    for (const p of this.routes.keys()) {
      if ((key === p || key.startsWith(`${p}/`)) && (best === null || p.length > best.length)) best = p;
    }
    return best;
  }

  private route(prefix: string): Promise<ReadRoute> {
    const key = normalizePrefix(prefix);
    const cached = this.routes.get(key);
    if (cached) return cached;
    const decision = this.decideRoute(key);
    this.routes.set(key, decision);
    return decision;
  }

  private async decideRoute(prefix: string): Promise<ReadRoute> {
    // 1. S3 already migrated?
    const s3Head = await this.s3.get(headKey(prefix));
    if (s3Head) return 's3';
    // 2. R2 committed checkpoint → copy it forward into S3, then read S3.
    const r2Head = await this.r2.get(headKey(prefix));
    if (r2Head) {
      await this.copyForward(prefix, r2Head);
      return 's3';
    }
    // 3. R2 still has loose legacy files → read R2 (one-time legacy import).
    const probe = await this.r2.list({ prefix: `${prefix}/`, limit: 1 });
    if (probe.objects.length > 0) return 'r2';
    // 4. Nothing to migrate (R2 empty) → read S3 natively, so an S3-side
    //    seed sentinel is honored exactly as the pure-R2 path honors it.
    return 's3';
  }

  /**
   * Copy a committed R2 checkpoint (head + every chunk) into S3 under identical
   * keys, verifying each chunk against the manifest, then commit the S3 head
   * create-only. Idempotent and safe under a lost race (a concurrent migrator
   * that already created the S3 head just makes our head put a no-op).
   */
  private async copyForward(prefix: string, r2Head: WorkspaceObjectBody): Promise<void> {
    if (r2Head.size > 128 * 1024) throw new Error('workspace migrate head too large');
    const headBytes = new Uint8Array(await r2Head.arrayBuffer());
    const snapshot = parseSnapshot(new TextDecoder().decode(headBytes));
    const generation = snapshot.chunkGeneration ?? snapshot.generation;
    for (let i = 0; i < snapshot.chunks.length; i++) {
      const ck = chunkKey(prefix, generation, i);
      if (await this.s3.get(ck)) continue; // already copied
      const r2Chunk = await this.r2.get(ck);
      if (!r2Chunk) throw new Error('workspace migrate chunk missing');
      if (r2Chunk.size > SNAPSHOT_CHUNK_BYTES) throw new Error('workspace migrate chunk too large');
      const bytes = new Uint8Array(await r2Chunk.arrayBuffer());
      const meta = snapshot.chunks[i];
      if (bytes.length !== meta.size || (await sha256Hex(bytes)) !== meta.sha256) {
        throw new Error('workspace migrate chunk corrupt');
      }
      await this.s3.put(ck, bytes);
    }
    // Refuse to publish a copy known to be stale: R2 head must be unchanged.
    const recheck = await this.r2.get(headKey(prefix));
    if (!recheck || recheck.etag !== r2Head.etag) {
      throw new Error('workspace migrate head changed during copy');
    }
    // Commit the S3 head create-only. null => a concurrent migrator won; the
    // head now exists in S3 either way, which is all we need.
    await this.s3.put(headKey(prefix), headBytes, { onlyIf: { etagDoesNotMatch: '*' } });
  }

  private async readStore(key: string): Promise<WorkspaceStore> {
    const prefix = this.prefixOfKey(key);
    if (prefix === null) {
      // Unroutable key with no established prefix: default to S3 (the write
      // target / native store) rather than silently reading stale R2.
      return this.s3;
    }
    return (await this.route(prefix)) === 's3' ? this.s3 : this.r2;
  }

  async get(key: string, options?: WorkspaceGetOptions): Promise<WorkspaceObjectBody | null> {
    return (await this.readStore(key)).get(key, options);
  }

  // GC deletes only from S3. The legacy R2 copy is never modified.
  async delete(keys: string[]): Promise<unknown> {
    return this.s3.delete(keys);
  }

  async list(options: { prefix: string; cursor?: string; limit?: number }): Promise<WorkspaceListResult> {
    const route = await this.route(options.prefix);
    return (route === 's3' ? this.s3 : this.r2).list(options);
  }

  // Writes ALWAYS go to S3.
  async put(key: string, value: Uint8Array | string, options?: WorkspacePutOptions): Promise<WorkspacePutResult | null> {
    return this.s3.put(key, value, options);
  }
}

// ── Adapter: an R2 binding as a WorkspaceStore ───────────────────────────────
//
// Only `get`/`list` are used by the migrating store (writes go to S3); `put` is
// provided for completeness and type-fit but never called on the R2 side.

interface R2BucketLike {
  get(key: string, options?: WorkspaceGetOptions): Promise<{ etag: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: Uint8Array | string,
    options?: WorkspacePutOptions,
  ): Promise<{ key: string; etag: string } | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; size: number; etag: string; uploaded?: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
  /** The R2 binding's own delete (string or batch of up to 1,000 keys). */
  delete(keys: string | string[]): Promise<unknown>;
}

export function r2AsWorkspaceStore(r2: R2BucketLike): WorkspaceStore {
  return {
    async get(key, options) {
      const o = await r2.get(key, options);
      if (!o) return null;
      // Lazy body: the caller (readBounded) refuses an unknown/over-limit size
      // from `o.size` BEFORE any bytes are buffered — matching the pure-R2 path,
      // so a huge legacy loose file fails cheaply instead of being buffered whole.
      return { etag: normalizeEtag(o.etag), size: o.size, arrayBuffer: () => o.arrayBuffer() };
    },
    async put(key, value, options) {
      const o = await r2.put(key, value, options);
      return o ? { key: o.key, etag: normalizeEtag(o.etag) } : null;
    },
    async list(options) {
      const r = await r2.list(options);
      return {
        objects: r.objects.map((x) => ({ key: x.key, size: x.size, etag: normalizeEtag(x.etag), ...(x.uploaded ? { uploaded: x.uploaded } : {}) })),
        truncated: r.truncated,
        cursor: r.cursor,
      };
    },
    async delete() {
      throw new Error('the legacy R2 store is read-only during migration');
    },
  };
}

// ── FAIL-CLOSED store selection ──────────────────────────────────────────────

/** Minimal env surface this selector reads. `index.ts`'s `Env` satisfies it. */
export interface WorkspaceStoreEnv {
  EZIL_WORKSPACE_STORE?: string;
  EZIL_WORKSPACE_S3_BUCKET?: string;
  EZIL_WORKSPACE_S3_REGION?: string;
  EZIL_WORKSPACE_S3_ACCESS_KEY_ID?: string;
  EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY?: string;
  EZIL_WORKSPACE_S3_ENDPOINT?: string;
  EZIL_WORKSPACE_S3_KEY_PREFIX?: string;
  EZIL_WORKSPACE_S3_SSE?: string;
  EZIL_WORKSPACE_S3_KMS_KEY_ID?: string;
  /** The R2 binding, present in production; drives migration when store='s3'. */
  SANDBOX_WORKSPACE_R2_BUCKET?: R2BucketLike;
}

export type WorkspaceStoreResolution =
  | { ok: true; kind: 'r2'; store: R2BucketLike | undefined }
  | { ok: true; kind: 's3'; store: WorkspaceStore }
  | { ok: false; detail: 'workspace_store_misconfigured' };

const MISCONFIGURED: WorkspaceStoreResolution = { ok: false, detail: 'workspace_store_misconfigured' };

function trimmed(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

/**
 * Decide which durable workspace store backs this computer. FAIL CLOSED: when
 * EZIL_WORKSPACE_STORE='s3' but any required S3 value is missing/invalid, or
 * when the value is anything other than 'r2'/'s3'/unset, this returns an
 * explicit `workspace_store_misconfigured` error — it NEVER silently falls back
 * to R2.
 *
 * - unset / 'r2'  → the R2 binding (existing behavior).
 * - 's3'          → an S3 store; wrapped in the migrating read-through store
 *                   when the R2 binding is also present.
 */
export function resolveWorkspaceStore(
  env: WorkspaceStoreEnv,
  options?: { fetchImpl?: FetchLike; log?: (message: string) => void },
): WorkspaceStoreResolution {
  const raw = env.EZIL_WORKSPACE_STORE?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'r2') {
    return { ok: true, kind: 'r2', store: env.SANDBOX_WORKSPACE_R2_BUCKET };
  }
  if (raw !== 's3') {
    return MISCONFIGURED;
  }

  const bucket = trimmed(env.EZIL_WORKSPACE_S3_BUCKET);
  const region = trimmed(env.EZIL_WORKSPACE_S3_REGION);
  const accessKeyId = trimmed(env.EZIL_WORKSPACE_S3_ACCESS_KEY_ID);
  const secretAccessKey = trimmed(env.EZIL_WORKSPACE_S3_SECRET_ACCESS_KEY);
  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    return MISCONFIGURED;
  }

  const sseRaw = trimmed(env.EZIL_WORKSPACE_S3_SSE);
  let sse: 'AES256' | 'aws:kms' | undefined;
  if (sseRaw !== undefined) {
    if (sseRaw !== 'AES256' && sseRaw !== 'aws:kms') return MISCONFIGURED;
    sse = sseRaw;
  }

  const s3 = new S3WorkspaceStore({
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    endpoint: trimmed(env.EZIL_WORKSPACE_S3_ENDPOINT),
    keyPrefix: trimmed(env.EZIL_WORKSPACE_S3_KEY_PREFIX),
    sse,
    kmsKeyId: trimmed(env.EZIL_WORKSPACE_S3_KMS_KEY_ID),
    fetchImpl: options?.fetchImpl,
  });

  const r2 = env.SANDBOX_WORKSPACE_R2_BUCKET;
  if (r2) {
    return { ok: true, kind: 's3', store: new MigratingWorkspaceStore(s3, r2AsWorkspaceStore(r2), options?.log) };
  }
  return { ok: true, kind: 's3', store: s3 };
}
