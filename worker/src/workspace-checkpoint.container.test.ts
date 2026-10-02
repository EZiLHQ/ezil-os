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
import { baselineSystemLayer, flushSystemLayer, hydrateSystemLayer, systemPrefixOf } from './system-persist';

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

  // Found only in the real runtime (wrangler dev + Sandbox SDK): the restore REPLACED /workspace,
  // so the SDK session shell and code-server (cwd = /workspace) were left in a deleted directory
  // and code-server crashed on getcwd -> no desktop. Restore and legacy import must keep the inode.
  for (const mode of ['checkpoint restore', 'legacy import'] as const) {
    it(`${mode} installs INTO the existing /workspace: same inode, a process whose cwd is the workspace keeps working`, async () => {
      const store = await makeStore(); const prefix = prefixFor(mode === 'legacy import' ? 'cwd-legacy' : 'cwd-restore');
      if (mode === 'legacy import') {
        await store.put(`${prefix}/src/app.js`, new TextEncoder().encode('console.log(1)\n'));
        await store.put(`${prefix}/${SEED_SENTINEL_FILENAME}`, new TextEncoder().encode('{}'));
      } else {
        const a = await startComputer('cwd-a');
        await must(a, 'mkdir -p /workspace/src && echo "console.log(1)" > /workspace/src/app.js'); await markHydrated(a, prefix);
        expect((await flush(a, store, prefix)).ok).toBe(true);
        await destroyComputer(a);
      }
      const b = await startComputer(mode === 'legacy import' ? 'cwd-bl' : 'cwd-br');
      const inode = (await must(b, 'stat -c %i /workspace')).trim();
      await docker(['exec', '-d', b, 'sh', '-c', 'cd /workspace && exec sleep 600']);
      const pid = (await must(b, 'for i in 1 2 3 4 5; do p=$(pgrep -x sleep | tail -1); [ -n "$p" ] && break; sleep 0.2; done; echo $p')).trim();
      expect(pid).toMatch(/^\d+$/);
      expect((await hydrate(b, store, prefix)).ok).toBe(true);
      expect((await must(b, 'stat -c %i /workspace')).trim()).toBe(inode);
      expect((await must(b, `readlink /proc/${pid}/cwd`)).trim()).toBe('/workspace');
      expect((await must(b, `ls /proc/${pid}/cwd/src`)).trim()).toBe('app.js');
    }, T);
  }

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

  // Found on staging: Cloudflare replaced a running container for an image rollout. The new
  // one has an empty /workspace and no marker, while the Worker still thought it hydrated.
  it('a replacement container that was never hydrated reports container_not_hydrated and never commits', async () => {
    const store = await makeStore(); const prefix = prefixFor('rollout');
    const a = await startComputer('roll-a');
    await must(a, 'mkdir -p /workspace && echo keep > /workspace/keep.txt'); await markHydrated(a, prefix);
    expect((await flush(a, store, prefix)).ok).toBe(true);
    const key = `${prefix}/.ezil-snapshots/latest.json`;
    const good = new TextDecoder().decode(await (await store.get(key))!.arrayBuffer());
    await must(a, 'rm -rf /workspace/keep.txt /workspace/.ezil-hydrated.json');      // what the replacement looks like
    const out = await flush(a, store, prefix);
    expect(out).toMatchObject({ ok: false, skippedReason: 'container_not_hydrated' });
    expect(new TextDecoder().decode(await (await store.get(key))!.arrayBuffer())).toBe(good);
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

// ── System layer: changes OUTSIDE /workspace (apt/dpkg, npm -g, HOME) ─────────
// Founder-reported 2026-10-02: "the moment I install any package it disappears
// after I close the browser or sign out". Offline fixtures: a .deb built here,
// a local package for npm -g.
describe.skipIf(!imagePresent)(`persistent compute: system installs survive container replacement (${IMAGE})`, () => {
  afterAll(async () => { await Promise.all(containers.map(destroyComputer)); }, 120_000);
  const sysFlush = (c: string, store: Store, prefix: string) => flushSystemLayer({ container: sdk(c), bucket: store, realPrefix: prefix, log });
  const sysHydrate = (c: string, store: Store, prefix: string) => hydrateSystemLayer({ container: sdk(c), bucket: store, realPrefix: prefix, log });
  const INSTALLS = String.raw`
set -e
mkdir -p /tmp/ezq-deb/ezq-tool/DEBIAN /tmp/ezq-deb/ezq-tool/usr/local/bin
printf 'Package: ezq-tool\nVersion: 1.0\nArchitecture: all\nMaintainer: qa\nDescription: qa fixture\n' > /tmp/ezq-deb/ezq-tool/DEBIAN/control
printf '#!/bin/sh\necho ezq-tool-ok\n' > /tmp/ezq-deb/ezq-tool/usr/local/bin/ezq-tool && chmod 755 /tmp/ezq-deb/ezq-tool/usr/local/bin/ezq-tool
dpkg-deb --build /tmp/ezq-deb/ezq-tool /tmp/ezq-tool.deb >/dev/null && dpkg -i /tmp/ezq-tool.deb >/dev/null
mkdir -p /tmp/ezq-npm && printf '{"name":"ezq-cli","version":"1.0.0","bin":{"ezq-cli":"cli.js"}}' > /tmp/ezq-npm/package.json
printf '#!/usr/bin/env node\nconsole.log("ezq-cli-ok")\n' > /tmp/ezq-npm/cli.js
# A packed tarball installs as a COPY (a folder path would install a symlink back into /tmp).
(cd /tmp/ezq-npm && npm pack --silent >/dev/null) && npm install -g --offline --no-audit --no-fund /tmp/ezq-npm/ezq-cli-1.0.0.tgz >/dev/null 2>&1
echo 'export EZQ_DOTFILE=1' >> /root/.bashrc
mkdir -p /opt/ezq && echo opt-ok > /opt/ezq/marker
`;

  it('apt/dpkg, npm -g, /opt and dotfiles installed after the baseline come back on a NEW container, working', async () => {
    const store = await makeStore(); const prefix = prefixFor('system');
    const a = await startComputer('sys-a'); await sysHydrate(a, store, prefix);
    expect(await baselineSystemLayer(sdk(a))).toBe(true);
    await new Promise(r => setTimeout(r, 1100));
    await must(a, INSTALLS);
    const out = await sysFlush(a, store, prefix);
    expect(out.ok).toBe(true);
    expect(out.entries).toBeGreaterThan(5);
    await destroyComputer(a);
    const b = await startComputer('sys-b');
    expect((await sh(b, 'command -v ezq-tool')).exitCode).not.toBe(0);           // fresh container: nothing yet
    const back = await sysHydrate(b, store, prefix);
    expect(back).toMatchObject({ ok: true, sameImage: true, conflicts: 0 });
    expect(back.restored).toBeGreaterThan(5);
    expect((await must(b, 'ezq-tool')).trim()).toBe('ezq-tool-ok');
    expect((await must(b, "dpkg -s ezq-tool | grep '^Status'")).trim()).toBe('Status: install ok installed');
    expect((await must(b, 'ezq-cli')).trim()).toBe('ezq-cli-ok');
    expect((await must(b, 'cat /opt/ezq/marker')).trim()).toBe('opt-ok');
    expect((await must(b, 'grep -c EZQ_DOTFILE /root/.bashrc')).trim()).toBe('1');
    // Restoring twice on one container is refused (manifest marks it done).
    expect((await sysHydrate(b, store, prefix)).skippedReason).toBe('already_restored');
    // Nothing changed since the restore — only platform-style churn (identical content
    // rewritten, directory mtimes bumped): the next checkpoint must not re-upload the layer.
    await baselineSystemLayer(sdk(b)); await new Promise(r => setTimeout(r, 1100));
    await must(b, 'cp /opt/ezq/marker /tmp/m && cat /tmp/m > /opt/ezq/marker && touch /opt/ezq /usr/local/bin && touch /opt/.uuid');
    const again = await sysFlush(b, store, prefix);
    expect(again).toMatchObject({ ok: true, unchanged: true, uploaded: 0 });
    // A real change after that is saved.
    await must(b, 'echo changed > /opt/ezq/marker');
    expect(await sysFlush(b, store, prefix)).toMatchObject({ ok: true });
    expect((await sysFlush(b, store, prefix)).unchanged).toBe(true);
  }, T);

  // Found on staging: Cloudflare gives untouched image files fresh ctimes when they are first read,
  // so a ctime-only delta captured ~6,900 image files (zoneinfo, perl, gconv...). Only entries that
  // DIFFER from the baked image manifest may be captured.
  it('untouched image files whose ctime changed (as on Cloudflare) are NOT captured', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-ctime');
    const a = await startComputer('sysct-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    // A no-op mode change bumps ctime without changing the file, like Cloudflare's lazy image reads.
    await must(a, 'find /usr/share/zoneinfo /usr/share/perl -type f -exec chmod u+r {} + 2>/dev/null; find /usr/share/zoneinfo -type f | wc -l');
    await must(a, 'echo "export ONLY_ME=1" >> /root/.bashrc');
    const out = await sysFlush(a, store, prefix);
    expect(out.ok).toBe(true);
    expect(out.entries).toBeLessThan(10);                                            // .bashrc (+ its parent), not ~1,800 files
  }, T);

  it('an uninstall is saved too: apt remove on the restored computer stays removed on the next one', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-rm');
    const a = await startComputer('sysrm-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, INSTALLS);
    expect((await sysFlush(a, store, prefix)).ok).toBe(true);
    await destroyComputer(a);
    const b = await startComputer('sysrm-b');
    expect((await sysHydrate(b, store, prefix)).ok).toBe(true);
    await baselineSystemLayer(sdk(b)); await new Promise(r => setTimeout(r, 1100));
    await must(b, 'dpkg -r ezq-tool >/dev/null && rm /usr/share/zoneinfo/Zulu');
    expect((await sysFlush(b, store, prefix)).ok).toBe(true);
    const head = JSON.parse(new TextDecoder().decode(await (await store.get(`${systemPrefixOf(prefix)}/.ezil-snapshots/latest.json`))!.arrayBuffer()));
    expect(head.deleted).toBeUndefined();                                          // deletions travel inside the archive
    await destroyComputer(b);
    const c = await startComputer('sysrm-c');
    expect((await sysHydrate(c, store, prefix)).ok).toBe(true);
    expect((await sh(c, 'command -v ezq-tool')).exitCode).not.toBe(0);
    expect((await must(c, "dpkg -s ezq-tool 2>&1 | grep -E '^Status|not installed' | head -1")).trim()).not.toBe('Status: install ok installed');
    expect((await must(c, 'ezq-cli')).trim()).toBe('ezq-cli-ok');                    // the rest is still there
    expect((await sh(c, 'test -e /usr/share/zoneinfo/Zulu')).exitCode).not.toBe(0); // a deleted image file stays deleted
  }, T);

  // CI rebuilds the image on every release; apt can pull newer image packages. The user's
  // pip / /opt / /usr/local files and apt packages must survive that; the image's own
  // package files and dpkg records must win.
  it('after an image update: user installs survive, the new image keeps its own package files and dpkg records', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-img');
    const a = await startComputer('sysimg-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, INSTALLS);
    // The user also edited a file that belongs to an image package.
    await must(a, 'echo user-edit >> /usr/share/zoneinfo/iso3166.tab');
    expect((await sysFlush(a, store, prefix)).ok).toBe(true);
    const head = await store.get(`${systemPrefixOf(prefix)}/.ezil-snapshots/latest.json`);
    const snap = JSON.parse(new TextDecoder().decode(await head!.arrayBuffer()));
    expect(snap.replay.apt).toContain('ezq-tool');
    await destroyComputer(a);
    const b = await startComputer('sysimg-b');
    // A "new image": a different package-set id, and an image package at a newer version.
    await must(b, "echo different-image-build > /etc/ezil-image-id && sed -i '/^Package: bash$/,/^$/ s/^Version: .*/Version: 99.0-ezq/' /var/lib/dpkg/status");
    const back = await sysHydrate(b, store, prefix);
    expect(back).toMatchObject({ ok: true, sameImage: false, conflicts: 0 });
    expect(back.skippedImageScoped).toBeGreaterThan(0);
    expect((await must(b, 'ezq-tool')).trim()).toBe('ezq-tool-ok');                 // user apt package, files
    expect((await must(b, "dpkg -s ezq-tool | grep '^Status'")).trim()).toBe('Status: install ok installed'); // and its dpkg record
    expect((await must(b, 'ezq-cli')).trim()).toBe('ezq-cli-ok');                   // npm -g
    expect((await must(b, 'cat /opt/ezq/marker')).trim()).toBe('opt-ok');           // /opt
    expect((await must(b, 'grep -c EZQ_DOTFILE /root/.bashrc')).trim()).toBe('1');  // HOME
    expect((await must(b, "dpkg -s bash | grep '^Version'")).trim()).toBe('Version: 99.0-ezq'); // image's record wins
    expect((await sh(b, 'grep -q user-edit /usr/share/zoneinfo/iso3166.tab')).exitCode).not.toBe(0); // image's file wins
    expect((await must(b, 'dpkg --audit; echo audit=$?')).trim()).toBe('audit=0');
  }, T);

  // Two containers for one computer (a replacement booting while the old one still flushes):
  // the old one must never overwrite what the new one committed.
  it('a stale container cannot checkpoint over a newer system layer (generation fencing)', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-fence');
    const sysPrefix = systemPrefixOf(prefix)!;
    const a = await startComputer('sysfn-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, 'mkdir -p /opt/fence && echo one > /opt/fence/v');
    expect((await sysFlush(a, store, prefix)).ok).toBe(true);
    const b = await startComputer('sysfn-b');
    expect((await sysHydrate(b, store, prefix)).ok).toBe(true);
    await baselineSystemLayer(sdk(b)); await new Promise(r => setTimeout(r, 1100));
    await must(b, 'echo two > /opt/fence/v');
    expect((await sysFlush(b, store, prefix)).ok).toBe(true);
    const newer = new TextDecoder().decode(await (await store.get(`${sysPrefix}/.ezil-snapshots/latest.json`))!.arrayBuffer());
    await must(a, 'echo stale > /opt/fence/v');
    expect((await sysFlush(a, store, prefix)).skippedReason).toBe('stale');
    expect(new TextDecoder().decode(await (await store.get(`${sysPrefix}/.ezil-snapshots/latest.json`))!.arrayBuffer())).toBe(newer);
    // The writer that holds the head keeps saving.
    await must(b, 'echo three > /opt/fence/v');
    expect((await sysFlush(b, store, prefix)).ok).toBe(true);
  }, T);

  it('capture is refused while dpkg/apt hold their lock, and has no baseline until the desktop is up', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-lock');
    const a = await startComputer('syslock-a');
    expect((await sysFlush(a, store, prefix)).skippedReason).toBe('not_restored');
    expect(await sysHydrate(a, store, prefix)).toMatchObject({ ok: true, skippedReason: 'no_snapshot' });
    expect((await sysFlush(a, store, prefix)).skippedReason).toBe('no_baseline');
    await baselineSystemLayer(sdk(a));
    await docker(['exec', '-d', a, 'python3', '-c', 'import fcntl,os,time; fd=os.open("/var/lib/dpkg/lock-frontend", os.O_RDWR|os.O_CREAT); fcntl.lockf(fd, fcntl.LOCK_EX); time.sleep(60)']);
    await new Promise(r => setTimeout(r, 800));
    expect((await sysFlush(a, store, prefix)).skippedReason).toBe('busy');
  }, T);

  // A container whose restore failed holds the bare image: committing it would erase the user's installs.
  it('a failed system restore never lets that container checkpoint over the committed system layer', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-guard');
    const sysPrefix = systemPrefixOf(prefix)!;
    const a = await startComputer('sysgd-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, INSTALLS);
    const first = await sysFlush(a, store, prefix);
    expect(first.ok).toBe(true);
    await destroyComputer(a);
    const headBefore = await store.get(`${sysPrefix}/.ezil-snapshots/latest.json`);
    const good = new TextDecoder().decode(await headBefore!.arrayBuffer());
    await store.corrupt!(`${sysPrefix}/.ezil-snapshots/${first.checkpoint}/0`);
    const b = await startComputer('sysgd-b');
    expect((await sysHydrate(b, store, prefix))).toMatchObject({ ok: false, skippedReason: 'failed' });
    await baselineSystemLayer(sdk(b)); await new Promise(r => setTimeout(r, 1100));
    await must(b, 'echo "export LATER=1" >> /root/.bashrc');
    expect((await sysFlush(b, store, prefix)).skippedReason).toBe('not_restored');
    const headAfter = await store.get(`${sysPrefix}/.ezil-snapshots/latest.json`);
    expect(new TextDecoder().decode(await headAfter!.arrayBuffer())).toBe(good);   // the committed layer is untouched
  }, T);

  // The first build's layers (staging only) were captured without the image manifest diff.
  it('a layer from the older format is discarded, never restored, and the next capture replaces it', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-legacy');
    const sysPrefix = systemPrefixOf(prefix)!;
    const a = await startComputer('syslg-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, 'mkdir -p /opt/legacy && echo old > /opt/legacy/f');
    expect((await sysFlush(a, store, prefix)).ok).toBe(true);
    await destroyComputer(a);
    // Rewrite the head as the older format would have stored it (no format marker).
    const key = `${sysPrefix}/.ezil-snapshots/latest.json`;
    const head = JSON.parse(new TextDecoder().decode(await (await store.get(key))!.arrayBuffer()));
    delete head.format;
    await store.put(key, new TextEncoder().encode(JSON.stringify(head)));
    const b = await startComputer('syslg-b');
    expect(await sysHydrate(b, store, prefix)).toMatchObject({ ok: true, skippedReason: 'legacy_discarded', restored: 0 });
    expect((await sh(b, 'test -e /opt/legacy/f')).exitCode).not.toBe(0);
    await baselineSystemLayer(sdk(b)); await new Promise(r => setTimeout(r, 1100));
    await must(b, 'mkdir -p /opt/fresh && echo new > /opt/fresh/f');
    expect((await sysFlush(b, store, prefix)).ok).toBe(true);
    const next = JSON.parse(new TextDecoder().decode(await (await store.get(key))!.arrayBuffer()));
    expect(next.format).toBe(2);
  }, T);

  // Final checkpoints now gate idle-stop/teardown, so ordinary churn (temp files, SQLite
  // journals appearing and vanishing in HOME) must never fail a capture.
  it('files created and deleted while the capture runs never fail it', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-churn');
    const a = await startComputer('sysch-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, 'mkdir -p /root/churn /opt/big && head -c 60000000 /dev/urandom > /opt/big/blob');
    await docker(['exec', '-d', a, 'bash', '-c', 'end=$((SECONDS+40)); i=0; while [ $SECONDS -lt $end ]; do i=$((i+1)); echo $i > /root/churn/t$i; ln -sf t$i /root/churn/l$i; rm -f /root/churn/t$((i-3)) /root/churn/l$((i-3)); done']);
    await new Promise(r => setTimeout(r, 500));
    for (let i = 0; i < 3; i++) expect((await sysFlush(a, store, prefix)).ok).toBe(true);
  }, T);

  it('a system delta over the snapshot limit is reported as too_large and never half-written', async () => {
    const store = await makeStore(); const prefix = prefixFor('system-big');
    const a = await startComputer('sysbig-a'); await sysHydrate(a, store, prefix);
    await baselineSystemLayer(sdk(a)); await new Promise(r => setTimeout(r, 1100));
    await must(a, 'mkdir -p /opt/big && head -c 540000000 /dev/urandom > /opt/big/blob');
    expect((await sysFlush(a, store, prefix)).skippedReason).toBe('too_large');
    expect((await store.list({ prefix: `${systemPrefixOf(prefix)}/` })).objects).toEqual([]);
  }, T);
});
