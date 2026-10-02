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
  flushWorkspaceToR2, hydrateWorkspaceFromR2, collectSupersededSnapshots, HYDRATE_MARKER_FILENAME, SNAPSHOT_HEAD, serializeHydrateMarker,
  type FlushContainerLike, type FlushR2BucketLike, type HydrateR2BucketLike,
  WORKSPACE_HEARTBEAT_FILENAME,
} from './workspace-persist';
import { SEED_SENTINEL_FILENAME } from './workspace-seed';

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
  delete?(keys: string[]): Promise<unknown>;
  corrupt?(key: string): Promise<void>;
  failPutFor?: (key: string) => boolean;
  beforePut?: (key: string) => Promise<void>;
};

/** R2 binding semantics (as in workspace-persist.test.ts): etag CAS on put, paginated list. */
class R2Fake implements Store {
  data = new Map<string, { bytes: Uint8Array; etag: string; uploaded: Date }>();
  revision = 0;
  failPutFor?: (key: string) => boolean;
  beforePut?: (key: string) => Promise<void>;
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    const v = this.data.get(key);
    if (!v) return null;
    // R2 semantics: `size` is the whole object's size even for a range read.
    const bytes = options?.range ? v.bytes.slice(options.range.offset, options.range.offset + options.range.length) : v.bytes;
    return { etag: v.etag, size: v.bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  }
  async put(key: string, bytes: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    await this.beforePut?.(key);
    if (this.failPutFor?.(key)) return null;
    const prior = this.data.get(key);
    if (options?.onlyIf?.etagMatches && prior?.etag !== options.onlyIf.etagMatches) return null;
    if (options?.onlyIf?.etagDoesNotMatch === '*' && prior) return null;
    const etag = `r2-${++this.revision}`;
    this.data.set(key, { bytes: bytes.slice(), etag, uploaded: new Date() });
    return { etag };
  }
  async list(o: { prefix: string; cursor?: string; limit?: number }) {
    const keys = [...this.data.keys()].filter(k => k.startsWith(o.prefix)).sort();
    const start = Number(o.cursor ?? 0), end = start + (o.limit ?? 1000);
    return { objects: keys.slice(start, end).map(key => ({ key, size: this.data.get(key)!.bytes.length, uploaded: this.data.get(key)!.uploaded })),
      truncated: end < keys.length, cursor: end < keys.length ? String(end) : undefined };
  }
  async corrupt(key: string) {
    const v = this.data.get(key)!; const b = v.bytes.slice(); b[b.length >> 1] ^= 0xff;
    this.data.set(key, { ...v, bytes: b });
  }
  async delete(keys: string[]) { for (const k of keys) this.data.delete(k); }
}

async function makeStore(): Promise<Store> {
  if (process.env.EZIL_CHECKPOINT_STORE !== 's3') return new R2Fake();
  // Same assertions through the S3 adapter (feat/persistent-compute-s3-adapter).
  const { S3WorkspaceStore } = await import('./workspace-store-s3');
  const inner = new S3WorkspaceStore({
    endpoint: process.env.EZIL_CHECKPOINT_S3_ENDPOINT, bucket: process.env.EZIL_CHECKPOINT_S3_BUCKET!,
    region: process.env.EZIL_CHECKPOINT_S3_REGION ?? 'us-east-1',
    accessKeyId: process.env.EZIL_CHECKPOINT_S3_ACCESS_KEY_ID!, secretAccessKey: process.env.EZIL_CHECKPOINT_S3_SECRET_ACCESS_KEY!,
    keyPrefix: `${RUN_ID}/`,
    // Test-environment only: Bun's pooled connection stalls on the request after
    // a 404 from moto's development server. No connection reuse avoids it.
    fetchImpl: (req: Request) => fetch(req, { keepalive: false } as RequestInit),
  });
  const store: Store = {
    get: (k, o) => inner.get(k, o), list: o => inner.list(o), delete: keys => inner.delete(keys),
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

  // ── Upgrade path: what every EXISTING production workspace meets on its first boot ──
  // origin/main's flush stores each regular file as a loose object `${prefix}/${relPath}`
  // (no size cap, any name the filesystem allows), plus the heartbeat and seed sentinel.
  async function seedLegacy(store: Store, prefix: string, files: Record<string, Uint8Array>) {
    for (const [rel, bytes] of Object.entries(files)) await store.put(`${prefix}/${rel}`, bytes);
    await store.put(`${prefix}/${SEED_SENTINEL_FILENAME}`, new TextEncoder().encode('{"seededAt":"2026-09-20T00:00:00Z"}'));
    await store.put(`${prefix}/${WORKSPACE_HEARTBEAT_FILENAME}`, new TextEncoder().encode('2026-10-01T00:00:00Z'));
  }
  const legacyFiles = (): Record<string, Uint8Array> => ({
    'README.md': new TextEncoder().encode('# my project\n'),
    'src/app/page.tsx': new TextEncoder().encode('export default function Page() { return null }\n'),
    'assets/video.bin': new Uint8Array(randomBytes(9 * 1024 * 1024)),   // > 8 MiB: main uploads it whole
    'data/db.sqlite': new Uint8Array(randomBytes(300_000)),
  });
  async function expectFiles(c: string, files: Record<string, Uint8Array>) {
    for (const [rel, bytes] of Object.entries(files)) {
      expect((await must(c, `sha256sum "/workspace/${rel}" | cut -c1-64`)).trim()).toBe(sha(bytes));
    }
  }

  it('UPGRADE: a workspace written by main (loose objects, one > 8 MiB) imports, checkpoints, and restores again', async () => {
    const store = await makeStore(); const prefix = prefixFor('legacy'); const files = legacyFiles();
    await seedLegacy(store, prefix, files);
    const a = await startComputer('up-a');
    const imported = await hydrate(a, store, prefix);
    expect(imported.ok).toBe(true);
    await expectFiles(a, files);
    expect((await flush(a, store, prefix)).ok).toBe(true);           // first checkpoint after the upgrade
    await destroyComputer(a);
    const b = await startComputer('up-b');
    expect((await hydrate(b, store, prefix)).ok).toBe(true);        // now from the committed snapshot
    await expectFiles(b, files);
  }, T);

  it('UPGRADE: orphan chunks from a checkpoint that died before its head put do not hide legacy files', async () => {
    const store = await makeStore(); const prefix = prefixFor('legacy-orphan'); const files = { 'app.js': new TextEncoder().encode('ok\n') };
    await seedLegacy(store, prefix, files);
    await store.put(`${prefix}/.ezil-snapshots/${crypto.randomUUID()}/0`, new Uint8Array(randomBytes(1000)));
    const a = await startComputer('uporph-a');
    expect((await hydrate(a, store, prefix)).ok).toBe(true);
    await expectFiles(a, files);
  }, T);

  it('UPGRADE: a prefix with only bookkeeping (seed sentinel, heartbeat) opens as an empty workspace', async () => {
    const store = await makeStore(); const prefix = prefixFor('legacy-empty');
    await seedLegacy(store, prefix, {});
    const a = await startComputer('upempty-a');
    const r = await hydrate(a, store, prefix);
    expect(r.ok).toBe(true);
    expect((await must(a, 'ls -A /workspace | wc -l')).trim()).toBe('0');
  }, T);

  it('UPGRADE: a legacy object whose name contains a backslash does not lock the user out', async () => {
    const store = await makeStore(); const prefix = prefixFor('legacy-bs');
    const files = { 'notes.txt': new TextEncoder().encode('keep me\n') };
    await seedLegacy(store, prefix, { ...files, 'win\\path.txt': new TextEncoder().encode('x') });
    const a = await startComputer('upbs-a');
    expect((await hydrate(a, store, prefix)).ok).toBe(true);
    await expectFiles(a, files);
  }, T);

  it('each changed checkpoint stores a full snapshot; GC bounds storage to the head + previous generation and the head still restores', async () => {
    const store = await makeStore(); const prefix = prefixFor('growth');
    const a = await startComputer('gro-a');
    await must(a, 'mkdir -p /workspace && head -c 1500000 /dev/urandom > /workspace/blob.bin && echo 0 > /workspace/n.txt'); await markHydrated(a, prefix);
    for (let i = 1; i <= 4; i++) { await must(a, `echo ${i} > /workspace/n.txt`); expect((await flush(a, store, prefix)).ok).toBe(true); }
    const census = async () => {
      const generations = new Set<string>(); let bytes = 0; let cursor: string | undefined;
      do {
        const page = await store.list({ prefix: `${prefix}/.ezil-snapshots/`, cursor });
        for (const o of page.objects) { const g = o.key.slice(prefix.length + 1).split('/')[1]!; if (g !== 'latest.json') { generations.add(g); bytes += o.size ?? 0; } }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return { generations: generations.size, bytes };
    };
    // A one-byte edit re-uploads the whole workspace; without GC every generation stays.
    expect((await census()).generations).toBe(4);
    if (!store.delete) return; // the S3 adapter run exercises GC once it implements delete
    const gc = await collectSupersededSnapshots({ bucket: store as never, realPrefix: prefix, log, graceMs: 0 });
    expect(gc).toMatchObject({ ok: true, deletedGenerations: 2 });
    expect((await census()).generations).toBe(2);
    await destroyComputer(a);
    const b = await startComputer('gro-b');
    expect((await hydrate(b, store, prefix)).ok).toBe(true);
    expect((await must(b, 'cat /workspace/n.txt')).trim()).toBe('4');
  }, T);

  it('unsupported entries (backslash names, escaping/absolute links, sockets) are skipped and reported; the checkpoint succeeds and restores without them', async () => {
    const store = await makeStore(); const prefix = prefixFor('skips');
    const a = await startComputer('skip-a');
    await must(a, String.raw`mkdir -p /workspace && cd /workspace && echo keep > keep.txt && echo x > 'win\path.txt' && ln -s /etc/passwd abs-link && ln -s ../../etc esc-link && ln -s keep.txt ok-link && python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind('/workspace/dev.sock')"`);
    await markHydrated(a, prefix);
    const out = await flush(a, store, prefix);
    expect(out.ok).toBe(true);
    expect(out.skippedUnsupported).toBe(4);
    await destroyComputer(a);
    const b = await startComputer('skip-b');
    expect((await hydrate(b, store, prefix)).ok).toBe(true);
    expect((await must(b, 'cd /workspace && ls -A | grep -v "^.ezil" | LC_ALL=C sort')).trim().split('\n')).toEqual(['keep.txt', 'ok-link']);
  }, T);

  it('a workspace over the 512 MiB snapshot limit fails as the distinct, permanent too_large (readiness/idle-stop/teardown degrade on it)', async () => {
    const store = await makeStore();
    const b = await startComputer('lim-b'); const p2 = prefixFor('big');
    await must(b, 'mkdir -p /workspace && head -c 540000000 /dev/urandom > /workspace/huge.bin'); await markHydrated(b, p2);
    const out = await flush(b, store, p2);
    expect(out.ok).toBe(false);
    expect(out.skippedReason).toBe('too_large');
    expect((await store.list({ prefix: `${p2}/` })).objects).toEqual([]);   // nothing half-written
  }, T);
});
