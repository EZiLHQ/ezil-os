/**
 * C-7 migration fence (plan P4c): the terminal `migrated` head, the late
 * Cloudflare flush it must refuse, GC suspension while an export runs, and the
 * system layer's refusal. Runs the REAL snapshot codec on a real filesystem,
 * like `workspace-persist.test.ts`.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  flushWorkspaceToR2, collectSupersededSnapshots, writeMigratedHead, readMigratedHead, parseSnapshot,
  HYDRATE_MARKER_FILENAME, SNAPSHOT_HEAD, MIGRATING_FLAG, serializeHydrateMarker, chunkKey,
  type FlushR2BucketLike, type HydrateR2BucketLike, type FlushContainerLike,
} from './workspace-persist';
import { flushSystemLayer, systemPrefixOf } from './system-persist';

const NO_POSIX_HOST = process.platform === 'win32';
// Each case runs the real codec (python + git) several times; a loaded host needs headroom.
setDefaultTimeout(30_000);
const run = promisify(execFile);
const prefix = 'computer-1/branches/main';
const headKey = `${prefix}/${SNAPSHOT_HEAD}`;
const roots: string[] = [];
const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const log = () => {};

class Bucket implements FlushR2BucketLike, HydrateR2BucketLike {
  data = new Map<string, { bytes: Uint8Array; etag: string; uploaded: Date }>();
  deleted: string[] = [];
  revision = 0;
  onGet?: (key: string) => void | Promise<void>;
  async get(key: string) {
    await this.onGet?.(key);
    const v = this.data.get(key);
    return v ? { etag: v.etag, size: v.bytes.length, arrayBuffer: async () => Uint8Array.from(v.bytes).buffer } : null;
  }
  async put(key: string, bytes: Uint8Array | string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const prior = this.data.get(key);
    if (options?.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    if (options?.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const etag = String(++this.revision);
    const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes.slice();
    this.data.set(key, { bytes: b, etag, uploaded: new Date() });
    return { etag };
  }
  lists = 0;
  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    this.lists++;
    const keys = [...this.data.keys()].filter(k => k.startsWith(options.prefix)).sort();
    return { objects: keys.map(key => ({ key, uploaded: this.data.get(key)!.uploaded })), truncated: false };
  }
  async delete(keys: string[]) { for (const k of keys) { this.data.delete(k); this.deleted.push(k); } }
  headBytes() { return new TextDecoder().decode(this.data.get(headKey)!.bytes); }
}
const container: FlushContainerLike = {
  async mkdir(path, opts) { await mkdir(path, { recursive: opts?.recursive ?? false }); },
  async writeFile(path, content, opts) { await writeFile(path, opts?.encoding === 'base64' ? Buffer.from(content, 'base64') : content); },
  async readFile(path, opts) { const bytes = await readFile(path); return { content: bytes.toString(opts?.encoding === 'base64' ? 'base64' : 'utf8'), encoding: opts?.encoding }; },
  async exists(path) { try { await lstat(path); return { exists: true }; } catch { return { exists: false }; } },
  async exec(command) {
    try { const r = await run('bash', ['-c', command], { env, maxBuffer: 1024 * 1024 }); return { ...r, exitCode: 0 }; }
    catch (error) { return { exitCode: typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1, stdout: '', stderr: 'helper failed' }; }
  },
};
async function workspace() {
  const base = await realpath(await mkdtemp(`${tmpdir()}/ezil-migration-test-`)); roots.push(base);
  const root = `${base}/ws`; await mkdir(root);
  await writeFile(`${root}/${HYDRATE_MARKER_FILENAME}`, serializeHydrateMarker({ version: 1, prefix, mountPath: root, hydratedAt: new Date().toISOString() }));
  return root;
}
const flush = (root: string, bucket: Bucket, beforeCapture?: () => Promise<void>) =>
  flushWorkspaceToR2({ container, bucket, mountPath: root, realPrefix: prefix, hydrationComplete: true, manifest: {}, log, beforeCapture });

async function committed() {
  const root = await workspace();
  const bucket = new Bucket();
  await writeFile(`${root}/a.txt`, 'v1');
  const first = await flush(root, bucket);
  expect(first.ok).toBe(true);
  return { root, bucket, etag: bucket.data.get(headKey)!.etag };
}

describe.skipIf(NO_POSIX_HOST)('terminal migrated head (C-7)', () => {
  it('is written by CAS over the exported head and keeps it addressable', async () => {
    const { bucket, etag } = await committed();
    const exported = parseSnapshot(bucket.headBytes());
    const r = await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: etag });
    expect(r.ok).toBe(true);
    const marker = await readMigratedHead(bucket, prefix);
    expect(marker).toMatchObject({ kind: 'migrated', targetProvider: 'aws-ec2',
      exported: { generation: exported.generation, sha256: exported.sha256, entries: exported.entries } });
    // A Worker WITHOUT this change refuses it too (version 2 is not a snapshot).
    expect(() => parseSnapshot(bucket.headBytes())).toThrow();
  });

  it('refuses when the head moved since the export read it, when absent, or when already migrated', async () => {
    const { root, bucket, etag } = await committed();
    await writeFile(`${root}/a.txt`, 'v2');
    expect((await flush(root, bucket)).ok).toBe(true); // a late checkpoint before commit
    expect(await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: etag }))
      .toEqual({ ok: false, reason: 'head_moved' });
    expect(await writeMigratedHead({ bucket: new Bucket(), realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: '1' }))
      .toEqual({ ok: false, reason: 'no_head' });
    const now = bucket.data.get(headKey)!.etag;
    expect((await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: now })).ok).toBe(true);
    expect(await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: bucket.data.get(headKey)!.etag }))
      .toEqual({ ok: false, reason: 'already_migrated' });
  });

  it('the marker itself is CAS-written: a checkpoint landing between its read and its put wins', async () => {
    const { bucket, etag } = await committed();
    // A Cloudflare checkpoint commits (new etag) right after the marker writer read the head.
    const newer = bucket.data.get(headKey)!;
    const realGet = bucket.get.bind(bucket);
    let raced = false;
    bucket.get = async (key: string) => {
      const value = await realGet(key);
      if (key === headKey && !raced) { raced = true; bucket.data.set(headKey, { ...newer, etag: 'raced', uploaded: new Date() }); }
      return value;
    };
    expect(await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: etag }))
      .toEqual({ ok: false, reason: 'head_moved' });
    expect(bucket.data.get(headKey)!.etag).toBe('raced');
  });

  it('a Cloudflare flush that starts AFTER the marker is refused and leaves it in place', async () => {
    const { root, bucket, etag } = await committed();
    await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: etag });
    const marker = bucket.headBytes();
    await writeFile(`${root}/a.txt`, 'late edit on cloudflare');
    const late = await flush(root, bucket);
    expect(late.ok).toBe(false);
    expect(late.skippedReason).toBe('migrated');
    expect(bucket.headBytes()).toBe(marker);
  });

  it('a Cloudflare flush that read the head BEFORE the marker landed loses the CAS', async () => {
    const { root, bucket, etag } = await committed();
    await writeFile(`${root}/a.txt`, 'edit racing the export');
    let marker = '';
    // The export commits while this flush is between its head read and its head put.
    const late = await flush(root, bucket, async () => {
      expect((await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: etag })).ok).toBe(true);
      marker = bucket.headBytes();
    });
    expect(late.ok).toBe(false);
    expect(marker).toContain('"kind":"migrated"');
    expect(bucket.headBytes()).toBe(marker);
  });
});

describe.skipIf(NO_POSIX_HOST)('garbage collection is suspended during export and after migration', () => {
  async function withGarbage() {
    const { root, bucket } = await committed();
    for (const v of ['v2', 'v3', 'v4']) { await writeFile(`${root}/a.txt`, v); expect((await flush(root, bucket)).ok).toBe(true); }
    return bucket;
  }
  const gc = (bucket: Bucket, extra: Partial<Parameters<typeof collectSupersededSnapshots>[0]> = {}) =>
    collectSupersededSnapshots({ bucket, realPrefix: prefix, log, now: Date.now() + 2 * 3_600_000, ...extra });

  it('positive control: without a flag, old generations are deleted', async () => {
    const bucket = await withGarbage();
    expect((await gc(bucket)).deletedGenerations).toBeGreaterThan(0);
  });

  it('a migrating flag suspends it before any listing: nothing is deleted', async () => {
    const bucket = await withGarbage();
    await bucket.put(`${prefix}/${MIGRATING_FLAG}`, '{}');
    bucket.lists = 0;
    expect(await gc(bucket)).toMatchObject({ ok: true, suspended: 'migrating', deletedGenerations: 0 });
    expect(bucket.deleted).toEqual([]);
    expect(bucket.lists).toBe(0);
  });

  it('a flag raised during the listing is honoured before any delete', async () => {
    const bucket = await withGarbage();
    let heads = 0;
    bucket.onGet = async (key) => {
      if (key === headKey && ++heads === 2) await bucket.put(`${prefix}/${MIGRATING_FLAG}`, '{}');
    };
    expect(await gc(bucket)).toMatchObject({ suspended: 'migrating', deletedGenerations: 0 });
    expect(bucket.deleted).toEqual([]);
  });

  it('the system prefix honours the workspace prefix\'s flag (fencePrefixes)', async () => {
    const bucket = await withGarbage();
    await bucket.put(`other/${MIGRATING_FLAG}`, '{}');
    expect(await gc(bucket, { fencePrefixes: ['other'] })).toMatchObject({ suspended: 'migrating' });
    expect(bucket.deleted).toEqual([]);
  });

  it('a migrated head suspends it: the exported chunks stay addressable', async () => {
    const bucket = await withGarbage();
    const exported = parseSnapshot(bucket.headBytes());
    await writeMigratedHead({ bucket, realPrefix: prefix, targetProvider: 'aws-ec2', expectedEtag: bucket.data.get(headKey)!.etag });
    expect(await gc(bucket)).toMatchObject({ ok: true, suspended: 'migrated', deletedGenerations: 0 });
    expect(bucket.data.has(chunkKey(prefix, exported.chunkGeneration ?? exported.generation, 0))).toBe(true);
  });
});

describe('system layer: a migrated system head is refused as migrated, not as a failure', () => {
  it('returns skippedReason migrated and writes nothing', async () => {
    const bucket = new Bucket();
    const computerPrefix = '22222222-2222-4222-8222-222222222222/branches/main';
    const sp = systemPrefixOf(computerPrefix)!;
    const marker = JSON.stringify({ version: 2, kind: 'migrated', targetProvider: 'aws-ec2', migratedAt: new Date().toISOString(),
      exported: { generation: crypto.randomUUID(), chunkGeneration: crypto.randomUUID(), sha256: 'a'.repeat(64), entries: 1 } });
    await bucket.put(`${sp}/${SNAPSHOT_HEAD}`, marker);
    const before = bucket.revision;
    const out = await flushSystemLayer({ container: { ...container, exec: async () => ({ exitCode: 0, stdout: '{}' }) }, bucket, realPrefix: computerPrefix, log });
    expect(out.skippedReason).toBe('migrated');
    expect(bucket.revision).toBe(before);
  });
});
