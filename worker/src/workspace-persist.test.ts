import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, lstat, readlink, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import {
  workspaceIsPhysicallyUnhydrated,
  flushWorkspaceToR2, hydrateWorkspaceFromR2, HYDRATE_MARKER_FILENAME, SNAPSHOT_HEAD, collectSupersededSnapshots,
  parseHydrateMarker, parseSnapshot, serializeHydrateMarker,
  type FlushR2BucketLike, type HydrateR2BucketLike, type FlushContainerLike,
} from './workspace-persist';
// The snapshot codec only ever runs in the Linux container; it needs a POSIX host here.
const NO_POSIX_HOST = process.platform === 'win32';

const run = promisify(execFile);
const prefix = 'project/branches/main';
const roots: string[] = [];
const env = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function temp() { const root = await realpath(await mkdtemp('/tmp/ezil-durable-test-')); roots.push(root); return root; }
const log = () => {};
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

class Bucket implements FlushR2BucketLike, HydrateR2BucketLike {
  data = new Map<string, { bytes: Uint8Array; etag: string }>();
  puts: string[] = [];
  revision = 0;
  onPut?: (key: string) => void | Promise<void>;
  failPut?: (key: string) => boolean;
  async get(key: string) {
    const value = this.data.get(key);
    return value ? { etag: value.etag, size: value.bytes.length,
      arrayBuffer: async () => Uint8Array.from(value.bytes).buffer } : null;
  }
  async put(key: string, bytes: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    await this.onPut?.(key);
    if (this.failPut?.(key)) return null;
    const prior = this.data.get(key);
    if (options?.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    if (options?.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const etag = String(++this.revision);
    this.data.set(key, { bytes: bytes.slice(), etag }); this.puts.push(key);
    return { etag };
  }
  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(options.prefix)).sort();
    const offset = Number(options.cursor ?? 0), end = offset + (options.limit ?? 1000);
    return { objects: keys.slice(offset, end).map(key => ({ key })), truncated: end < keys.length,
      cursor: end < keys.length ? String(end) : undefined };
  }
}
const container: FlushContainerLike = {
  async mkdir(path, opts) { await mkdir(path, { recursive: opts?.recursive ?? false }); },
  async writeFile(path, content, opts) { await writeFile(path, opts?.encoding === 'base64' ? Buffer.from(content, 'base64') : content); },
  async readFile(path, opts) { const bytes = await readFile(path); return { content: bytes.toString(opts?.encoding === 'base64' ? 'base64' : 'utf8'), encoding: opts?.encoding }; },
  async exists(path) { try { await lstat(path); return { exists: true }; } catch { return { exists: false }; } },
  async exec(command) {
    try { const result = await run('bash', ['-c', command], { env, maxBuffer: 1024 * 1024 }); return { ...result, exitCode: 0 }; }
    catch (error) { return { exitCode: typeof (error as {code?: unknown}).code === 'number' ? (error as {code:number}).code : 1, stdout: '', stderr: 'snapshot helper failed' }; }
  },
};
async function mark(root: string) {
  await writeFile(`${root}/${HYDRATE_MARKER_FILENAME}`, serializeHydrateMarker({ version: 1, prefix, mountPath: root, hydratedAt: new Date().toISOString() }));
}
async function workspace() { const base = await temp(); const root = `${base}/source`; await mkdir(root); await mark(root); return { base, root }; }
const flush = (root: string, bucket: Bucket) => flushWorkspaceToR2({ container, bucket, mountPath: root, realPrefix: prefix, hydrationComplete: true, manifest: {}, log });
const hydrate = (root: string, bucket: Bucket) => hydrateWorkspaceFromR2({ container, bucket, mountPath: root, realPrefix: prefix, log });
const git = async (root: string, ...args: string[]) => (await run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', root, ...args], { env })).stdout;
const headKey = `${prefix}/${SNAPSHOT_HEAD}`;

describe.skipIf(NO_POSIX_HOST)('atomic Git workspace checkpoints (real filesystem and Git)', () => {
  it('teardown observes physical marker absence without trusting stale or invalid markers', async () => {
    const { root } = await workspace();
    expect(await workspaceIsPhysicallyUnhydrated(container, root)).toBe(false);
    await writeFile(`${root}/${HYDRATE_MARKER_FILENAME}`, 'invalid marker');
    expect(await workspaceIsPhysicallyUnhydrated(container, root)).toBe(false);
    await rm(`${root}/${HYDRATE_MARKER_FILENAME}`);
    expect(await workspaceIsPhysicallyUnhydrated(container, root)).toBe(true);
    await expect(workspaceIsPhysicallyUnhydrated({ ...container, exec: async () => ({exitCode:1,stdout:''}) }, root)).rejects.toThrow('observation failed');
  });
  it('rejects an unhydrated physical replacement before capture can change editor settings', async () => {
    const { root } = await workspace(); const bucket = new Bucket();
    await rm(`${root}/${HYDRATE_MARKER_FILENAME}`);
    let captures = 0;
    const result = await flushWorkspaceToR2({ container, bucket, mountPath: root, realPrefix: prefix,
      hydrationComplete: true, manifest: {}, log, beforeCapture: async () => { captures++; } });
    expect(result.skippedReason).toBe('container_not_hydrated');
    expect(captures).toBe(0);
    expect(bucket.data.size).toBe(0);
  });
  it('restores the exact index, refs, objects, staged/unstaged edits, deletions, modes and safe links after replacement', async () => {
    const { base, root } = await workspace(); const bucket = new Bucket();
    await git(root, 'init', '-b', 'main');
    await writeFile(`${root}/a.txt`, 'committed\n'); await writeFile(`${root}/deleted.txt`, 'gone later');
    await mkdir(`${root}/dist`); await writeFile(`${root}/dist/tracked.txt`, 'tracked build output');
    await git(root, 'add', 'a.txt', 'deleted.txt', 'dist/tracked.txt'); await git(root, 'commit', '-m', 'unpushed commit');
    await writeFile(`${root}/a.txt`, 'staged\n'); await git(root, 'add', 'a.txt');
    await writeFile(`${root}/a.txt`, 'unstaged\n'); await rm(`${root}/deleted.txt`);
    await writeFile(`${root}/run.sh`, '#!/bin/sh\nexit 0\n'); await chmod(`${root}/run.sh`, 0o755);
    await symlink('a.txt', `${root}/link`); await mkdir(`${root}/empty`);
    await mkdir(`${root}/node_modules`); await writeFile(`${root}/node_modules/cache`, 'regenerated');
    // Bookkeeping itself is untracked; compare Git output with it hidden.
    await writeFile(`${root}/.git/info/exclude`, '.ezil-hydrated.json\nnode_modules/\n');
    const status = await git(root, 'status', '--porcelain=v1', '-z');
    const diff = await git(root, 'diff', '--binary'); const staged = await git(root, 'diff', '--cached', '--binary');
    const commit = await git(root, 'rev-parse', 'HEAD'); const index = await readFile(`${root}/.git/index`);
    expect((await flush(root, bucket)).ok).toBe(true);
    const target = `${base}/replacement`;
    expect((await hydrate(target, bucket)).ok).toBe(true);
    expect(await git(target, 'status', '--porcelain=v1', '-z')).toBe(status);
    expect(await git(target, 'diff', '--binary')).toBe(diff);
    expect(await git(target, 'diff', '--cached', '--binary')).toBe(staged);
    expect(await git(target, 'rev-parse', 'HEAD')).toBe(commit);
    // Git status can refresh stat data in the index. Check a second untouched restore.
    const exact = `${base}/exact`; expect((await hydrate(exact, bucket)).ok).toBe(true);
    expect(await readFile(`${exact}/.git/index`)).toEqual(index);
    expect((await lstat(`${target}/run.sh`)).mode & 0o777).toBe(0o755);
    expect(await readlink(`${target}/link`)).toBe('a.txt');
    expect((await lstat(`${target}/empty`)).isDirectory()).toBe(true);
    expect((await container.exists(`${target}/deleted.txt`)).exists).toBe(false);
    expect((await container.exists(`${target}/node_modules`)).exists).toBe(false);
    expect(await readFile(`${target}/dist/tracked.txt`, 'utf8')).toBe('tracked build output');
    await git(target, 'fsck', '--full');
  });

  it('deletions, link changes, binary data and executable-bit-only edits supersede old snapshots', async () => {
    const { base, root } = await workspace(); const bucket = new Bucket();
    await writeFile(`${root}/removed`, 'old'); await writeFile(`${root}/binary`, Buffer.from([0, 255, 128, 1]));
    await symlink('removed', `${root}/link`); expect((await flush(root, bucket)).ok).toBe(true);
    await rm(`${root}/removed`); await rm(`${root}/link`); await symlink('binary', `${root}/link`); await chmod(`${root}/binary`, 0o755);
    expect((await flush(root, bucket)).ok).toBe(true);
    expect((await hydrate(`${base}/restored`, bucket)).ok).toBe(true);
    expect((await container.exists(`${base}/restored/removed`)).exists).toBe(false);
    expect(await readlink(`${base}/restored/link`)).toBe('binary');
    expect(await readFile(`${base}/restored/binary`)).toEqual(Buffer.from([0, 255, 128, 1]));
    expect((await lstat(`${base}/restored/binary`)).mode & 0o777).toBe(0o755);
  });

  it('reuses immutable chunks on an unchanged checkpoint', async () => {
    const { root } = await workspace(); const bucket = new Bucket(); await writeFile(`${root}/a`, 'a');
    const first = await flush(root, bucket); const second = await flush(root, bucket);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(second.checkpoint).not.toBe(first.checkpoint); expect(second.uploaded).toEqual([]);
  });

  it('keeps the prior head on upload failure or edits during upload', async () => {
    const { root } = await workspace(); const bucket = new Bucket(); await writeFile(`${root}/a`, 'old');
    expect((await flush(root, bucket)).ok).toBe(true); const old = bucket.data.get(headKey)!.bytes;
    await writeFile(`${root}/a`, 'new'); bucket.failPut = key => key.endsWith('/0');
    expect((await flush(root, bucket)).ok).toBe(false); expect(bucket.data.get(headKey)!.bytes).toEqual(old);
    bucket.failPut = undefined; bucket.onPut = async key => { if (key.endsWith('/0')) await writeFile(`${root}/a`, 'changed while uploading'); };
    expect((await flush(root, bucket)).ok).toBe(false); expect(bucket.data.get(headKey)!.bytes).toEqual(old);
  });

  it('rejects a competing publisher with conditional manifest commit', async () => {
    const { root } = await workspace(); const bucket = new Bucket(); await writeFile(`${root}/a`, 'a');
    expect((await flush(root, bucket)).ok).toBe(true);
    bucket.onPut = key => { if (key === headKey) bucket.data.get(headKey)!.etag = 'competing-version'; };
    expect((await flush(root, bucket)).ok).toBe(false);
  });

  for (const damage of ['missing chunk', 'corrupt chunk', 'corrupt head', 'unknown version']) {
    it(`fails closed on ${damage} without publishing a partial workspace`, async () => {
      const { base, root } = await workspace(); const bucket = new Bucket(); await writeFile(`${root}/a`, 'a');
      expect((await flush(root, bucket)).ok).toBe(true);
      const chunk = [...bucket.data.keys()].find(k => k.endsWith('/0'))!;
      if (damage === 'missing chunk') bucket.data.delete(chunk);
      if (damage === 'corrupt chunk') bucket.data.get(chunk)!.bytes[0] ^= 1;
      if (damage === 'corrupt head') bucket.data.get(headKey)!.bytes = new TextEncoder().encode('{');
      if (damage === 'unknown version') {
        const value = JSON.parse(new TextDecoder().decode(bucket.data.get(headKey)!.bytes)); value.version = 2;
        bucket.data.get(headKey)!.bytes = new TextEncoder().encode(JSON.stringify(value));
      }
      const target = `${base}/target`; expect((await hydrate(target, bucket)).ok).toBe(false);
      expect((await container.exists(`${target}/${HYDRATE_MARKER_FILENAME}`)).exists).toBe(false);
    });
  }

  it('never overwrites a nonempty warm workspace even when its marker was lost', async () => {
    const { base, root } = await workspace(); const bucket = new Bucket(); await writeFile(`${root}/a`, 'saved');
    expect((await flush(root, bucket)).ok).toBe(true);
    const target = `${base}/target`; await mkdir(target); await writeFile(`${target}/a`, 'unflushed');
    expect((await hydrate(target, bucket)).ok).toBe(false); expect(await readFile(`${target}/a`, 'utf8')).toBe('unflushed');
  });

  for (const target of ['/etc/passwd', '../../escape']) {
    it(`never archives unsafe symlink ${target}: skipped and reported, the rest still checkpoints`, async () => {
      const { base, root } = await workspace(); const bucket = new Bucket(); await symlink(target, `${root}/link`);
      await writeFile(`${root}/keep.txt`, 'keep');
      const out = await flush(root, bucket);
      expect(out.ok).toBe(true); expect(out.skippedUnsupported).toBe(1); expect(bucket.data.has(headKey)).toBe(true);
      expect((await hydrate(`${base}/restored`, bucket)).ok).toBe(true);
      expect((await container.exists(`${base}/restored/link`)).exists).toBe(false);
      expect(await readFile(`${base}/restored/keep.txt`, 'utf8')).toBe('keep');
    });
  }
  it('refuses active Git locks and stale hydration flags after container replacement', async () => {
    const { root } = await workspace(); const bucket = new Bucket(); await git(root, 'init');
    await writeFile(`${root}/.git/index.lock`, ''); expect((await flush(root, bucket)).ok).toBe(false);
    await rm(`${root}/.git/index.lock`); await rm(`${root}/${HYDRATE_MARKER_FILENAME}`);
    expect((await flush(root, bucket)).ok).toBe(false); expect(bucket.data.has(headKey)).toBe(false);
  });

  it('requires complete hydration and a scoped prefix before touching storage', async () => {
    const { root } = await workspace(); const bucket = new Bucket();
    for (const options of [{ hydrationComplete: false, realPrefix: prefix }, { hydrationComplete: true, realPrefix: '' }]) {
      const result = await flushWorkspaceToR2({ container, bucket, mountPath: root, manifest: {}, log, ...options });
      expect(result.ok).toBe(false); expect(bucket.puts).toEqual([]);
    }
  });
});

describe.skipIf(NO_POSIX_HOST)('legacy import and metadata validation', () => {
  it('imports legacy files once and ignores loose stale keys after the first checkpoint', async () => {
    const base = await temp(); const root = `${base}/legacy`; const bucket = new Bucket();
    await bucket.put(`${prefix}/src/a`, new TextEncoder().encode('old'));
    expect((await hydrate(root, bucket)).ok).toBe(true); expect((await flush(root, bucket)).ok).toBe(true);
    await rm(`${root}/src/a`); expect((await flush(root, bucket)).ok).toBe(true);
    expect((await hydrate(`${base}/new`, bucket)).ok).toBe(true);
    expect((await container.exists(`${base}/new/src/a`)).exists).toBe(false);
  });
  it('sentinel-only opens empty, path traversal is skipped (never written), incomplete listings still fail', async () => {
    const base = await temp(); const bucket = new Bucket();
    await bucket.put(`${prefix}/.ezil-seeded.json`, new TextEncoder().encode('seed'));
    // Use the actual sentinel name from the seed module.
    bucket.data.clear(); const { SEED_SENTINEL_FILENAME } = await import('./workspace-seed');
    await bucket.put(`${prefix}/${SEED_SENTINEL_FILENAME}`, new Uint8Array());
    const sentinelOnly = await hydrate(`${base}/sentinel`, bucket);
    expect(sentinelOnly.ok).toBe(true); expect(sentinelOnly.filesWritten).toBe(0);
    bucket.data.clear(); await bucket.put(`${prefix}/../escape`, new Uint8Array([1]));
    await bucket.put(`${prefix}/kept.txt`, new TextEncoder().encode('kept'));
    const traversal = await hydrate(`${base}/traversal`, bucket);
    expect(traversal.ok).toBe(true); expect(traversal.skippedUnsafe).toBe(1);
    expect(await readFile(`${base}/traversal/kept.txt`, 'utf8')).toBe('kept');
    expect((await container.exists(`${base}/escape`)).exists).toBe(false);
    bucket.data.clear(); bucket.list = async () => ({ objects: [], truncated: true, cursor: undefined });
    expect((await hydrate(`${base}/partial`, bucket)).ok).toBe(false);
  });
  it('requires the versioned local marker and validates manifest shape', () => {
    expect(parseHydrateMarker('{"prefix":"p","mountPath":"/workspace","hydratedAt":"today"}')).toBeNull();
    expect(parseHydrateMarker('bad')).toBeNull();
    expect(() => parseSnapshot('{}')).toThrow();
    expect(() => parseSnapshot(JSON.stringify({ version: 1, generation: 'a'.repeat(36), sha256: digest(new Uint8Array()), entries: 1, chunks: [] }))).toThrow();
  });
});

describe.skipIf(NO_POSIX_HOST)('snapshot integrity and writer fencing', () => {
  it('rejects a stale container after a replacement has advanced the checkpoint', async () => {
    const { root, base } = await workspace(); const bucket = new Bucket(); await writeFile(`${root}/a`, 'first');
    expect((await flush(root, bucket)).ok).toBe(true);
    const replacement = `${base}/replacement`; expect((await hydrate(replacement, bucket)).ok).toBe(true);
    await writeFile(`${replacement}/a`, 'replacement edit'); expect((await flush(replacement, bucket)).ok).toBe(true);
    const current = bucket.data.get(headKey)!.bytes;
    await writeFile(`${root}/a`, 'stale writer edit'); expect((await flush(root, bucket)).ok).toBe(false);
    expect(bucket.data.get(headKey)!.bytes).toEqual(current);
  });
  it('restores files spanning several independently verified chunks', async () => {
    const { base, root } = await workspace(); const bucket = new Bucket();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 5, 173); await writeFile(`${root}/large.bin`, bytes);
    const result = await flush(root, bucket); expect(result.ok).toBe(true); expect(result.uploaded.length).toBeGreaterThan(2);
    expect((await hydrate(`${base}/restored`, bucket)).ok).toBe(true);
    expect(await readFile(`${base}/restored/large.bin`)).toEqual(bytes);
  });
  for (const name of ['../escape', '/absolute', 'a/../../escape', '.ezil-hydrated.json']) {
    it(`refuses a hash-valid archive with an unsafe entry ${name}`, async () => {
      const base = await temp(); const bucket = new Bucket(); const archive = `${base}/bad.tar`;
      await run('python3', ['-c', 'import tarfile,sys,io\nwith tarfile.open(sys.argv[1],"w") as t:\n m=tarfile.TarInfo(sys.argv[2]);m.size=1;t.addfile(m,io.BytesIO(b"x"))', archive, name], { env });
      const bytes = await readFile(archive); const generation = crypto.randomUUID();
      const snapshot = { version: 1, generation, sha256: digest(bytes), entries: 1, chunks: [{ size: bytes.length, sha256: digest(bytes) }] };
      await bucket.put(headKey, new TextEncoder().encode(JSON.stringify(snapshot)));
      await bucket.put(`${prefix}/.ezil-snapshots/${generation}/0`, bytes);
      expect((await hydrate(`${base}/restored`, bucket)).ok).toBe(false);
      expect((await container.exists(`${base}/restored/${HYDRATE_MARKER_FILENAME}`)).exists).toBe(false);
      expect((await container.exists(`${base}/escape`)).exists).toBe(false);
    });
  }
});

describe.skipIf(NO_POSIX_HOST)('security regressions', () => {
  it('fences the old writer when a replacement checkpoints an unchanged tree', async () => {
    const { base, root } = await workspace(); const bucket = new Bucket();
    await writeFile(`${root}/a`, 'original'); expect((await flush(root, bucket)).ok).toBe(true);
    const replacement = `${base}/replacement`; expect((await hydrate(replacement, bucket)).ok).toBe(true);
    const acquired = await flush(replacement, bucket); expect(acquired.ok).toBe(true); expect(acquired.uploaded).toEqual([]);
    await writeFile(`${root}/a`, 'orphan edit');
    expect((await flush(root, bucket)).ok).toBe(false);
    expect((await hydrate(`${base}/latest`, bucket)).ok).toBe(true);
    expect(await readFile(`${base}/latest/a`, 'utf8')).toBe('original');
  });

  it('does not confirm unchanged bytes when the durable chunks are missing', async () => {
    const { root } = await workspace(); const bucket = new Bucket();
    expect((await flush(root, bucket)).ok).toBe(true);
    bucket.data.delete([...bucket.data.keys()].find(k => k.endsWith('/0'))!);
    expect((await flush(root, bucket)).ok).toBe(false);
  });

  it('rejects an advancing head during restore without installing the stale tree', async () => {
    const { base, root } = await workspace(); const bucket = new Bucket();
    expect((await flush(root, bucket)).ok).toBe(true);
    const get = bucket.get.bind(bucket);
    bucket.get = async key => {
      if (key.endsWith('/0')) bucket.data.get(headKey)!.etag = 'new-head';
      return get(key);
    };
    expect((await hydrate(`${base}/replacement`, bucket)).ok).toBe(false);
    expect((await container.exists(`${base}/replacement`)).exists).toBe(false);
  });

  it('rejects a legacy object changing during import', async () => {
    const base = await temp(); const bucket = new Bucket();
    await bucket.put(`${prefix}/a`, new TextEncoder().encode('old'));
    const get = bucket.get.bind(bucket); let reads = 0;
    bucket.get = async key => {
      if (key === `${prefix}/a` && ++reads === 2) await bucket.put(key, new TextEncoder().encode('new'));
      return get(key);
    };
    expect((await hydrate(`${base}/replacement`, bucket)).ok).toBe(false);
    expect((await container.exists(`${base}/replacement`)).exists).toBe(false);
  });

  it('never loads repository Git config or runs fsmonitor while reading the index', async () => {
    const { root, base } = await workspace(); const bucket = new Bucket();
    await git(root, 'init'); await mkdir(`${root}/dist`); await writeFile(`${root}/dist/a`, 'tracked');
    await git(root, 'add', 'dist/a'); await git(root, 'update-index', '--split-index');
    const index = await readFile(`${root}/.git/index`);
    // An invalid include would make normal Git fail. The checkpoint must not
    // read it at all, and must not run the fsmonitor command from this config.
    await writeFile(`${root}/.git/config`, `[core]\nrepositoryformatversion = 0\nfsmonitor = touch ${base}/hook-ran\n[include]\npath = ${base}/invalid-config\n`);
    await writeFile(`${base}/invalid-config`, 'not valid Git config\n');
    expect((await flush(root, bucket)).ok).toBe(true);
    expect((await container.exists(`${base}/hook-ran`)).exists).toBe(false);
    expect((await hydrate(`${base}/restored`, bucket)).ok).toBe(true);
    expect(await readFile(`${base}/restored/.git/index`)).toEqual(index);
    expect(await readFile(`${base}/restored/dist/a`, 'utf8')).toBe('tracked');
  });

  it('does not read a marker symlink', async () => {
    const { root, base } = await workspace(); const bucket = new Bucket();
    await rm(`${root}/${HYDRATE_MARKER_FILENAME}`);
    await writeFile(`${base}/outside`, 'private bytes');
    await symlink(`${base}/outside`, `${root}/${HYDRATE_MARKER_FILENAME}`);
    expect((await flush(root, bucket)).ok).toBe(false); expect(bucket.puts).toEqual([]);
  });

  it('does not expose R2, SDK or malformed JSON contents in failure outcomes and logs', async () => {
    const { root } = await workspace(); const messages: string[] = []; const bucket = new Bucket();
    bucket.get = async () => { throw new Error('PRIVATE_CONTENT_OR_CREDENTIAL'); };
    const result = await flushWorkspaceToR2({ bucket, container, mountPath: root, realPrefix: prefix, hydrationComplete: true, manifest: {}, log: m => messages.push(m) });
    expect(result.ok).toBe(false);
    expect(JSON.stringify({ result, messages })).not.toContain('PRIVATE_CONTENT_OR_CREDENTIAL');
    expect(() => parseSnapshot('PRIVATE_CONTENT_OR_CREDENTIAL')).toThrow('invalid workspace snapshot manifest');
    const restored = await hydrateWorkspaceFromR2({ bucket, container, mountPath: root, realPrefix: prefix, log: m => messages.push(m) });
    expect(restored.ok).toBe(false); expect(messages.join(' ')).not.toContain('PRIVATE_CONTENT_OR_CREDENTIAL');
  });

  it('honors a non-throwing SDK write failure during legacy import', async () => {
    const base = await temp(); const bucket = new Bucket();
    await bucket.put(`${prefix}/a`, new TextEncoder().encode('a'));
    const result = await hydrateWorkspaceFromR2({ bucket, container: { ...container, writeFile: async () => ({ success: false }) }, mountPath: `${base}/target`, realPrefix: prefix, log });
    expect(result.ok).toBe(false); expect((await container.exists(`${base}/target`)).exists).toBe(false);
  });
});

// Audits the opened path through /proc/self/fd, which only Linux has (the codec's only runtime).
it.skipIf(process.platform !== 'linux')('pins parent directories so a racing symlink cannot redirect a capture read', async () => {
  const { SNAPSHOT_SCRIPT } = await import('./workspace-snapshot-script');
  const { root, base } = await workspace();
  await mkdir(`${root}/dir`); await writeFile(`${root}/dir/value`, 'workspace bytes');
  await mkdir(`${base}/outside`); await writeFile(`${base}/outside/value`, 'outside bytes');
  const work = `/tmp/ezil-snapshot-${crypto.randomUUID()}`; roots.push(work);
  const injection = `
original_open = os.open
swapped = False
def racing_open(path, flags, *args, **kwargs):
    global swapped
    if path == 'value' and not swapped:
        swapped = True
        os.rename(root + '/dir', root + '/old-dir')
        os.symlink(os.path.dirname(root) + '/outside', root + '/dir')
    fd = original_open(path, flags, *args, **kwargs)
    if path == 'value':
        with open(os.path.dirname(root) + '/opened-path', 'w') as audit:
            audit.write(os.readlink('/proc/self/fd/' + str(fd)))
    return fd
os.open = racing_open
`;
  const script = SNAPSHOT_SCRIPT.replace("try:\n    op = p['op']", `${injection}\ntry:\n    op = p['op']`);
  await expect(run('python3', ['-I', '-c', script, JSON.stringify({ op: 'capture', root, work, prefix, expected: null })], { env })).rejects.toThrow();
  expect(await readFile(`${base}/opened-path`, 'utf8')).toBe(`${root}/old-dir/value`);
});

describe.skipIf(NO_POSIX_HOST)('garbage collection of superseded checkpoint generations', () => {
  class GcBucket extends Bucket {
    uploaded = new Map<string, number>();
    deleted: string[] = [];
    clock = 0;
    override async put(key: string, bytes: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const r = await super.put(key, bytes, options); if (r) this.uploaded.set(key, this.clock); return r;
    }
    override async list(options: { prefix: string; cursor?: string; limit?: number }) {
      const page = await super.list(options);
      return { ...page, objects: page.objects.map(o => ({ ...o, uploaded: this.uploaded.has(o.key) ? new Date(this.uploaded.get(o.key)!) : undefined })) };
    }
    async delete(keys: string[]) { for (const k of keys) { this.data.delete(k); this.deleted.push(k); } }
  }
  const gens = (b: GcBucket) => new Set([...b.data.keys()].filter(k => k.includes('/.ezil-snapshots/') && !k.endsWith(SNAPSHOT_HEAD)).map(k => k.split('/.ezil-snapshots/')[1]!.split('/')[0]));
  const gc = (b: GcBucket, now: number, graceMs = 1000) => collectSupersededSnapshots({ bucket: b, realPrefix: prefix, log, now, graceMs });

  it('keeps the head and previous generations, deletes older ones past the grace window, and the head still restores', async () => {
    const { base, root } = await workspace(); const bucket = new GcBucket();
    for (let i = 0; i < 4; i++) { bucket.clock = i * 10; await writeFile(`${root}/n.txt`, String(i)); expect((await flush(root, bucket)).ok).toBe(true); }
    expect(gens(bucket).size).toBe(4);
    const head = parseSnapshot(new TextDecoder().decode(bucket.data.get(headKey)!.bytes));
    const out = await gc(bucket, 100_000);
    expect(out).toMatchObject({ ok: true, deletedGenerations: 2, keptRecent: 0 });
    expect(gens(bucket)).toEqual(new Set([head.chunkGeneration ?? head.generation, head.previousChunkGeneration!]));
    expect(bucket.data.has(headKey)).toBe(true);
    expect((await hydrate(`${base}/restored`, bucket)).ok).toBe(true);
    expect(await readFile(`${base}/restored/n.txt`, 'utf8')).toBe('3');
  });

  it('never deletes a recent (possibly in-flight) or undated generation, and never acts without a head', async () => {
    const { root } = await workspace(); const bucket = new GcBucket();
    // No head: an orphan generation is not provably garbage.
    await bucket.put(`${prefix}/.ezil-snapshots/${crypto.randomUUID()}/0`, new Uint8Array([1]));
    expect(await gc(bucket, 1e12)).toMatchObject({ ok: true, deletedGenerations: 0 });
    bucket.data.clear(); bucket.uploaded.clear();
    for (let i = 0; i < 3; i++) { bucket.clock = 0; await writeFile(`${root}/n.txt`, String(i)); expect((await flush(root, bucket)).ok).toBe(true); }
    const inflight = `${prefix}/.ezil-snapshots/${crypto.randomUUID()}/0`;
    bucket.clock = 5_000; await bucket.put(inflight, new Uint8Array([2]));      // an uncommitted writer, 0.5 s old
    const undated = `${prefix}/.ezil-snapshots/${crypto.randomUUID()}/0`;
    await bucket.put(undated, new Uint8Array([3])); bucket.uploaded.delete(undated);
    const out = await gc(bucket, 5_500);
    expect(out).toMatchObject({ ok: true, deletedGenerations: 1, keptRecent: 2 });
    expect(bucket.data.has(inflight)).toBe(true); expect(bucket.data.has(undated)).toBe(true);
  });

  it('aborts without deleting when the head moves during collection', async () => {
    const { root } = await workspace(); const bucket = new GcBucket();
    for (let i = 0; i < 3; i++) { await writeFile(`${root}/n.txt`, String(i)); expect((await flush(root, bucket)).ok).toBe(true); }
    const realList = bucket.list.bind(bucket);
    bucket.list = async (o) => { const page = await realList(o); const h = bucket.data.get(headKey)!; bucket.data.set(headKey, { ...h, etag: `${h.etag}-moved` }); return page; };
    const out = await gc(bucket, 1e12);
    expect(out.ok).toBe(false); expect(bucket.deleted).toEqual([]);
  });
});

describe.skipIf(NO_POSIX_HOST)('rate-limited routine checkpoints (deferIfChanged)', () => {
  const flushDeferred = (root: string, bucket: Bucket) => flushWorkspaceToR2({ container, bucket, mountPath: root, realPrefix: prefix, hydrationComplete: true, manifest: {}, log, deferIfChanged: true });
  it('never defers the first checkpoint, defers a changed one without touching storage, and still confirms an unchanged one', async () => {
    const { root } = await workspace(); const bucket = new Bucket();
    await writeFile(`${root}/a.txt`, 'v1');
    const first = await flushDeferred(root, bucket);
    expect(first.ok).toBe(true); expect(first.skippedReason).toBeUndefined();
    const head = bucket.data.get(headKey)!.etag; const puts = bucket.puts.length;
    await writeFile(`${root}/a.txt`, 'v2');
    const deferred = await flushDeferred(root, bucket);
    expect(deferred).toMatchObject({ ok: false, skippedReason: 'deferred', uploaded: [] });
    expect(bucket.puts.length).toBe(puts); expect(bucket.data.get(headKey)!.etag).toBe(head);
    await writeFile(`${root}/a.txt`, 'v1');
    const unchanged = await flushDeferred(root, bucket);
    expect(unchanged.ok).toBe(true); expect(unchanged.uploaded).toEqual([]);
    await writeFile(`${root}/a.txt`, 'v3');
    const committed = await flush(root, bucket);       // not deferred: readiness/teardown/idle-stop path
    expect(committed.ok).toBe(true); expect(committed.uploaded.length).toBeGreaterThan(0);
  });
});
