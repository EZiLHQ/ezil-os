/**
 * Persistent-compute check: the atomic checkpoint module (`workspace-persist.ts`)
 * driving a REAL desktop image through `docker exec`, with the compute boundary
 * actually replaced (`docker rm -f`, no volumes or bind mounts) between capture
 * and restore.
 *
 * What it proves: the image's own python3/git run the snapshot codec; a fresh
 * container restores the exact workspace from the store alone; failures are
 * refusals, never partial trees. What it does NOT exercise: the Durable Object
 * alarm loop, the Sandbox SDK's RPC transport, and Cloudflare's own restarts.
 *
 * Gated like the other `*.container.test.ts` suites: skipped unless the image
 * exists locally. Run:
 *   EZIL_CHECKPOINT_IMAGE=ezil-desktop:rev3 bun test src/workspace-checkpoint.container.test.ts
 * Store under test: an R2-semantics fake by default. Set EZIL_CHECKPOINT_STORE=s3
 * with EZIL_CHECKPOINT_S3_* (endpoint, bucket, region, access key, secret) to run
 * the same assertions against an S3 endpoint through the S3 store adapter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import {
  flushWorkspaceToR2, hydrateWorkspaceFromR2, HYDRATE_MARKER_FILENAME, SNAPSHOT_HEAD, serializeHydrateMarker,
  type FlushContainerLike, type FlushR2BucketLike, type HydrateR2BucketLike,
} from './workspace-persist';

const run = promisify(execFile);
const IMAGE = process.env.EZIL_CHECKPOINT_IMAGE ?? process.env.EZIL_VALIDATE_IMAGE ?? 'ezil-integrated:local';
const RUN_ID = `ezq-ckpt-${randomBytes(4).toString('hex')}`;
const ROOT = '/workspace';
const T = 600_000;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const log = () => {};

const imagePresent = await run('docker', ['image', 'inspect', IMAGE]).then(() => true, () => false);

// ── Store under test ─────────────────────────────────────────────────────────
type Store = FlushR2BucketLike & HydrateR2BucketLike & {
  corrupt?(key: string): Promise<void>;
  failPutFor?: (key: string) => boolean;
  beforePut?: (key: string) => Promise<void>;
};

/** R2 binding semantics (as in workspace-persist.test.ts): etag CAS on put, paginated list. */
class R2Fake implements Store {
  data = new Map<string, { bytes: Uint8Array; etag: string }>();
  revision = 0;
  failPutFor?: (key: string) => boolean;
  beforePut?: (key: string) => Promise<void>;
  async get(key: string) {
    const v = this.data.get(key);
    return v ? { etag: v.etag, size: v.bytes.length, arrayBuffer: async () => Uint8Array.from(v.bytes).buffer } : null;
  }
  async put(key: string, bytes: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    await this.beforePut?.(key);
    if (this.failPutFor?.(key)) return null;
    const prior = this.data.get(key);
    if (options?.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    if (options?.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const etag = `r2-${++this.revision}`;
    this.data.set(key, { bytes: bytes.slice(), etag });
    return { etag };
  }
  async list(o: { prefix: string; cursor?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(o.prefix)).sort();
    const start = Number(o.cursor ?? 0), end = start + (o.limit ?? 1000);
    return { objects: keys.slice(start, end).map(key => ({ key, size: this.data.get(key)!.bytes.length })),
      truncated: end < keys.length, cursor: end < keys.length ? String(end) : undefined };
  }
  async corrupt(key: string) {
    const v = this.data.get(key)!; const b = v.bytes.slice(); b[b.length >> 1] ^= 0xff;
    this.data.set(key, { bytes: b, etag: v.etag });
  }
}

async function makeStore(): Promise<Store> {
  if (process.env.EZIL_CHECKPOINT_STORE !== 's3') return new R2Fake();
  // Same assertions through the S3 adapter (feat/persistent-compute-s3-adapter).
  const mod = await import('./workspace-store-s3' as string);
  const inner = mod.createS3WorkspaceStore({
    endpoint: process.env.EZIL_CHECKPOINT_S3_ENDPOINT, bucket: process.env.EZIL_CHECKPOINT_S3_BUCKET!,
    region: process.env.EZIL_CHECKPOINT_S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.EZIL_CHECKPOINT_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.EZIL_CHECKPOINT_S3_SECRET_ACCESS_KEY!,
    keyPrefix: `${RUN_ID}/`,
  }) as FlushR2BucketLike & HydrateR2BucketLike;
  const store: Store = {
    get: k => inner.get(k), list: o => inner.list(o),
    put: async (k, b, o) => { await store.beforePut?.(k); return store.failPutFor?.(k) ? null : inner.put(k, b, o); },
    corrupt: async (k) => {
      const body = await inner.get(k); const b = new Uint8Array(await body!.arrayBuffer()); b[b.length >> 1] ^= 0xff;
      await inner.put(k, b);
    },
  };
  return store;
}

// ── Real container, SDK-shaped adapter ───────────────────────────────────────
const containers: string[] = [];
function docker(args: string[], input?: Uint8Array | string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = []; let err = '';
    p.stdout.on('data', d => out.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('close', code => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
    p.stdin.end(input ?? '');
  });
}
async function startComputer(tag: string): Promise<string> {
  const name = `${RUN_ID}-${tag}`;
  // No volumes, no bind mounts, no network: nothing can survive `rm -f` except the store.
  const r = await docker(['run', '-d', '--name', name, '--network', 'none', '--entrypoint', 'sleep', IMAGE, 'infinity']);
  if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
  containers.push(name);
  return name;
}
async function destroyComputer(name: string) { await docker(['rm', '-f', name]); }
async function sh(name: string, script: string, input?: string) {
  const r = await docker(['exec', '-i', name, 'bash', '-c', script], input);
  return { exitCode: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr };
}
async function must(name: string, script: string) {
  const r = await sh(name, script);
  if (r.exitCode !== 0) throw new Error(`exec failed (${r.exitCode}): ${script}\n${r.stderr}`);
  return r.stdout;
}
/** Mirrors the Sandbox SDK surface the module uses (exec/readFile/writeFile/mkdir/exists). */
function sdk(name: string): FlushContainerLike {
  return {
    async exec(command) { return sh(name, command); },
    async readFile(path, opts) {
      const r = await docker(['exec', name, 'cat', '--', path]);
      if (r.code !== 0) throw new Error('readFile failed');
      return opts?.encoding === 'base64' ? { content: r.stdout.toString('base64'), encoding: 'base64' } : { content: r.stdout.toString('utf8') };
    },
    async writeFile(path, content, opts) {
      const bytes = opts?.encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
      const r = await docker(['exec', '-i', name, 'bash', '-c', 'cat > "$1"', '_', path], bytes);
      if (r.code !== 0) throw new Error('writeFile failed');
      return { success: true };
    },
    async mkdir(path, opts) {
      const r = await docker(['exec', name, 'mkdir', ...(opts?.recursive ? ['-p'] : []), '--', path]);
      if (r.code !== 0) throw new Error('mkdir failed'); // non-recursive on an existing dir fails, like the SDK
      return { success: true };
    },
    async exists(path) { return { exists: (await docker(['exec', name, 'test', '-e', path])).code === 0 }; },
  };
}
const flush = (name: string, store: Store, prefix: string) => flushWorkspaceToR2({
  container: sdk(name), bucket: store, mountPath: ROOT, realPrefix: prefix, manifest: {}, hydrationComplete: true, log });
const hydrate = (name: string, store: Store, prefix: string) => hydrateWorkspaceFromR2({
  container: sdk(name), bucket: store, mountPath: ROOT, realPrefix: prefix, log });
const markHydrated = (name: string, prefix: string) => sdk(name).writeFile(`${ROOT}/${HYDRATE_MARKER_FILENAME}`,
  serializeHydrateMarker({ version: 1, prefix, mountPath: ROOT, hydratedAt: new Date().toISOString() }));
const prefixFor = (label: string) => `${crypto.randomUUID()}/branches/${label}`;

/** Everything the user would notice, as one comparable fingerprint (bookkeeping files excluded). */
const FINGERPRINT = String.raw`
set -e; cd /workspace
find . -path ./node_modules -prune -o \( -name '.ezil-*' -prune \) -o -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' p; do
  if [ -L "$p" ]; then printf 'L %s -> %s\n' "$p" "$(readlink "$p")";
  elif [ -d "$p" ]; then printf 'D %s %s %s\n' "$p" "$(stat -c '%a %u:%g' "$p")";
  else printf 'F %s %s %s\n' "$p" "$(stat -c '%a %u:%g' "$p")" "$(sha256sum < "$p" | cut -c1-64)"; fi
done
G="git -C repo -c safe.directory=*"
echo "HEAD $($G rev-parse HEAD)"; echo "BRANCHES"; $G for-each-ref --format='%(refname) %(objectname)' refs/heads refs/stash
echo "STATUS"; $G status --porcelain=v1 -uall; echo "STAGED $($G diff --cached --binary | sha256sum | cut -c1-64)"
echo "UNSTAGED $($G diff --binary | sha256sum | cut -c1-64)"; echo "STASH"; $G stash list --format='%gd %s'
`;

const UNICODE_NAME = 'ünïcødé файл.txt';
const SEED = String.raw`
set -e; mkdir -p /workspace && cd /workspace
printf 'hello sentinel\n' > a.txt
mkdir -p deep/x/y && head -c 3145728 /dev/urandom > deep/x/y/big.bin      # 3 MiB: spans 3+ chunks
printf '#!/bin/sh\necho ok\n' > run.sh && chmod 755 run.sh
ln -s a.txt link && mkdir empty
mkdir -p node_modules/pkg && printf 'cache' > node_modules/pkg/index.js   # expected: excluded
printf 'will be deleted in gen 2\n' > gone.txt
echo 'echo HOME-SENTINEL' >> /root/.bash_history                          # expected: lost (HOME is not persisted)
G="git -C repo -c user.name=QA -c user.email=qa@example.invalid"
git init -q -b main repo; printf 'v1\n' > repo/f.txt; $G add f.txt; $G commit -qm one
printf 'v2\n' > repo/f.txt; $G commit -qam two
$G checkout -qb feature; printf 'feat\n' > repo/g.txt; $G add g.txt; $G commit -qm feat; $G checkout -q main
printf 'stashed\n' >> repo/f.txt; $G stash push -q -m 'qa stash'
printf 'staged\n' > repo/s.txt; $G add s.txt; printf 'unstaged\n' >> repo/f.txt; printf 'untracked\n' > repo/u.txt
`;

describe.skipIf(!imagePresent)(`persistent compute: checkpoint survives real container replacement (${IMAGE})`, () => {
  beforeAll(async () => {
    const v = await run('docker', ['run', '--rm', '--entrypoint', 'sh', IMAGE, '-c', 'python3 --version; git --version; id -u']);
    console.log(`[checkpoint.container] image=${IMAGE} ${v.stdout.replace(/\n/g, ' ')}`);
  });
  afterAll(async () => { await Promise.all(containers.map(destroyComputer)); }, 120_000);

  it('restores the exact workspace (files, modes, links, unicode, empty dirs, Git refs/stash/index) into a NEW container; deletions stay deleted; caches and HOME are not carried', async () => {
    const store = await makeStore(); const prefix = prefixFor('main');
    // Generation 1 on computer A.
    const a = await startComputer('a');
    expect((await hydrate(a, store, prefix)).emptyPrefix).toBe(true);
    await must(a, SEED);
    // Created from a normal JS string: Bun's String.raw escapes non-ASCII into literal \\uXXXX text.
    await sdk(a).writeFile(`${ROOT}/${UNICODE_NAME}`, 'u\n');
    await markHydrated(a, prefix);
    const gen1 = await flush(a, store, prefix);
    expect(gen1.ok).toBe(true);
    // Generation 2 on the same computer: delete a file, edit another.
    await must(a, 'cd /workspace && rm gone.txt && printf "edited\\n" >> a.txt');
    const gen2 = await flush(a, store, prefix);
    expect(gen2.ok).toBe(true);
    expect(gen2.checkpoint).not.toBe(gen1.checkpoint);
    const before = await must(a, FINGERPRINT);
    const bigBefore = await must(a, 'sha256sum /workspace/deep/x/y/big.bin | cut -c1-64');

    // Replace the compute boundary. Nothing but the store survives.
    await destroyComputer(a);
    expect((await docker(['inspect', a])).code).not.toBe(0);
    const b = await startComputer('b');
    expect((await must(b, 'ls -A /workspace | wc -l')).trim()).toBe('0');
    const restored = await hydrate(b, store, prefix);
    expect(restored.ok).toBe(true);

    const after = await must(b, FINGERPRINT);
    expect(after).toBe(before);
    expect(await must(b, 'sha256sum /workspace/deep/x/y/big.bin | cut -c1-64')).toBe(bigBefore);
    expect((await sh(b, 'test -e /workspace/gone.txt')).exitCode).not.toBe(0);           // deletion honoured
    expect((await sh(b, 'test -e /workspace/node_modules')).exitCode).not.toBe(0);       // cache excluded
    expect((await sh(b, 'grep -q HOME-SENTINEL /root/.bash_history')).exitCode).not.toBe(0); // HOME lost (expected)
    expect(await must(b, 'stat -c %u:%g /workspace/a.txt /workspace/repo/.git/HEAD')).toBe('0:0\n0:0\n'); // desktop user is root
    // Git works for the desktop user with no safe.directory override, and the object store is intact.
    await must(b, 'cd /workspace/repo && git status --porcelain >/dev/null && git fsck --full --strict');
    expect((await must(b, 'git -C /workspace/repo log --format=%s main')).trim().split('\n')).toEqual(['two', 'one']);
    expect((await must(b, 'git -C /workspace/repo stash list')).trim()).toContain('qa stash');
    // The restored computer can checkpoint again (it is a normal, hydrated workspace).
    const again = await flush(b, store, prefix);
    expect(again.ok).toBe(true);
  }, T);

  it('two computers racing on one prefix: exactly one checkpoint commits', async () => {
    const store = await makeStore(); const prefix = prefixFor('race');
    const [a, b] = [await startComputer('race-a'), await startComputer('race-b')];
    for (const [c, v] of [[a, 'A'], [b, 'B']] as const) { await must(c, `mkdir -p /workspace && echo ${v} > /workspace/who.txt`); await markHydrated(c, prefix); }
    let arrived = 0; let release!: () => void; const both = new Promise<void>(r => { release = r; });
    store.beforePut = async (key) => { if (key.endsWith(SNAPSHOT_HEAD)) { if (++arrived === 2) release(); await both; } };
    const results = await Promise.all([flush(a, store, prefix), flush(b, store, prefix)]);
    store.beforePut = undefined;
    expect(results.filter(r => r.ok)).toHaveLength(1);
    const c = await startComputer('race-c');
    expect((await hydrate(c, store, prefix)).ok).toBe(true);
    const winner = results[0]!.ok ? 'A' : 'B';
    expect((await must(c, 'cat /workspace/who.txt')).trim()).toBe(winner);
  }, T);

  it('a corrupted chunk is refused on restore and leaves no partial tree', async () => {
    const store = await makeStore(); const prefix = prefixFor('corrupt');
    const a = await startComputer('cor-a');
    await must(a, 'mkdir -p /workspace && head -c 2500000 /dev/urandom > /workspace/data.bin'); await markHydrated(a, prefix);
    const gen = await flush(a, store, prefix); expect(gen.ok).toBe(true);
    await store.corrupt!(`${prefix}/.ezil-snapshots/${gen.checkpoint}/1`);
    await destroyComputer(a);
    const b = await startComputer('cor-b');
    expect((await hydrate(b, store, prefix)).ok).toBe(false);
    expect((await must(b, 'ls -A /workspace | wc -l')).trim()).toBe('0');
  }, T);

  it('a failing store put fails the checkpoint (ok:false) and leaves the previous head authoritative', async () => {
    const store = await makeStore(); const prefix = prefixFor('putfail');
    const a = await startComputer('pf-a');
    await must(a, 'mkdir -p /workspace && echo v1 > /workspace/v.txt'); await markHydrated(a, prefix);
    expect((await flush(a, store, prefix)).ok).toBe(true);
    await must(a, 'echo v2 > /workspace/v.txt');
    store.failPutFor = (key) => key.includes('/.ezil-snapshots/') && !key.endsWith(SNAPSHOT_HEAD);
    expect((await flush(a, store, prefix)).ok).toBe(false);
    store.failPutFor = undefined;
    const b = await startComputer('pf-b');
    expect((await hydrate(b, store, prefix)).ok).toBe(true);
    expect((await must(b, 'cat /workspace/v.txt')).trim()).toBe('v1');
  }, T);

  it('another computer prefix sees nothing (tenant isolation by prefix)', async () => {
    const store = await makeStore(); const prefix = prefixFor('tenant-a');
    const a = await startComputer('ten-a');
    await must(a, 'mkdir -p /workspace && echo secret > /workspace/private.txt'); await markHydrated(a, prefix);
    expect((await flush(a, store, prefix)).ok).toBe(true);
    const b = await startComputer('ten-b');
    const other = await hydrate(b, store, prefixFor('tenant-b'));
    expect(other.ok).toBe(true); expect(other.emptyPrefix).toBe(true);
    expect((await must(b, 'ls -A /workspace | wc -l')).trim()).toBe('0');
  }, T);

  it('FINDING: each changed checkpoint stores a full new snapshot and superseded generations are never deleted (unbounded growth)', async () => {
    const store = await makeStore(); const prefix = prefixFor('growth');
    const a = await startComputer('gro-a');
    await must(a, 'mkdir -p /workspace && head -c 1500000 /dev/urandom > /workspace/blob.bin && echo 0 > /workspace/n.txt'); await markHydrated(a, prefix);
    for (let i = 1; i <= 3; i++) { await must(a, `echo ${i} > /workspace/n.txt`); expect((await flush(a, store, prefix)).ok).toBe(true); }
    const generations = new Set<string>(); let bytes = 0; let cursor: string | undefined;
    do {
      const page = await store.list({ prefix: `${prefix}/.ezil-snapshots/`, cursor });
      for (const o of page.objects) { const g = o.key.slice(prefix.length + 1).split('/')[1]!; if (g !== 'latest.json') { generations.add(g); bytes += o.size ?? 0; } }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    // A one-byte edit re-uploads the whole 1.5 MB workspace; all three generations remain.
    expect(generations.size).toBe(3);
    expect(bytes).toBeGreaterThan(3 * 1_500_000);
  }, T);

  it('FINDING: a backslash in any file name, an escaping symlink, or a >512 MiB workspace makes every checkpoint fail (readiness would 503)', async () => {
    const store = await makeStore();
    const c = await startComputer('lim-c'); const p0 = prefixFor('backslash');
    await must(c, "mkdir -p /workspace && echo x > '/workspace/win\\path.txt' && ls /workspace | grep -c '\\\\'"); await markHydrated(c, p0);
    expect((await flush(c, store, p0)).ok).toBe(false);
    const a = await startComputer('lim-a'); const p1 = prefixFor('escape');
    await must(a, 'mkdir -p /workspace && echo x > /workspace/ok.txt && ln -s /etc/passwd /workspace/escape'); await markHydrated(a, p1);
    expect((await flush(a, store, p1)).ok).toBe(false);
    const b = await startComputer('lim-b'); const p2 = prefixFor('big');
    await must(b, 'mkdir -p /workspace && head -c 540000000 /dev/urandom > /workspace/huge.bin'); await markHydrated(b, p2);
    expect((await flush(b, store, p2)).ok).toBe(false);
  }, T);
});
