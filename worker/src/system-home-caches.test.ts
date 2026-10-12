import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SYSTEM_SNAPSHOT_SCRIPT } from './system-snapshot-script';

// Package-manager caches in EVERY home (PR195 review r4246120551): restore-deps
// repopulates them as the home's user, so capturing them can push HOME past the
// snapshot limits and freeze saving again. One predicate, excluded(), must keep
// them out of capture, restore, deletion detection and the dirty probe alike.
const run = promisify(execFile);
async function python(scenario: string, op = 'sys-dirty', mapped = true) {
  const setup = String.raw`
import tempfile, io, contextlib, tarfile
test_dir = tempfile.TemporaryDirectory(prefix='ezil-system-home-caches-test-')
test_root = test_dir.name
ROOTS = [test_root + '/root', test_root + '/home']
for r in ROOTS: os.mkdir(r)
STATE = test_root + '/state'
os.mkdir(STATE)
CAPTURE_STARTED = STATE + '/capture-started'
BASELINE = STATE + '/baseline'
HYDRATED = STATE + '/hydrated'
MANIFEST = STATE + '/manifest.json'
COMMITTED_META = STATE + '/committed-meta.json'
BASELINE_MISSING = STATE + '/baseline-missing.json'
IMAGE_MANIFEST = STATE + '/image.tsv'
IMAGE_ID = STATE + '/image-id'
OLD = 1700000000000000000
def stamp(path, ns=OLD): os.utime(path, ns=(ns, ns), follow_symlinks=False)
work = test_root + '/work'
if ${mapped ? 'True' : 'False'}:
    # Run the real predicate on the fixture's homes: strip the temp prefix first.
    EXCLUDE = [STATE] + [test_root + e for e in EXCLUDE if e.startswith('/root/') or e.startswith('/home/')]
    if 'home_cache' in globals():
        real_home_cache = home_cache
        home_cache = lambda path: path.startswith(test_root + '/') and real_home_cache(path[len(test_root):])
def put(rel, data=b'x'):
    path = test_root + rel
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f: f.write(data)
    return path
CACHES = ['/root/.local/share/pnpm/store/v3/files/00/a', '/home/alice/.npm/_cacache/content-v2/sha512/aa',
          '/home/alice/.npm/_logs/debug.log', '/home/alice/.cache/node/x', '/home/bob/.bun/install/cache/pkg/index.js',
          '/home/bob/.local/share/pnpm/store/v3/files/00/b']
KEPT = ['/home/alice/.yarn/berry/cache/pkg.zip', '/home/alice/.npmrc', '/home/alice/app/.cache-notes',
        '/home/bob/.local/share/other', '/root/.opencode/bin/opencode', '/home/alice/.cache-old/x']
`;
  const insertion = '\ntry:\n    op = p[\'op\']';
  expect(SYSTEM_SNAPSHOT_SCRIPT).toContain(insertion);
  const script = SYSTEM_SNAPSHOT_SCRIPT.replace(insertion, `\n${setup}\n${scenario}\n${insertion}`);
  const result = await run('python3', ['-I', '-c', script,
    JSON.stringify({ op, work: '/tmp/ezil-system-test' })], { env: { PATH: '/usr/bin:/bin' } });
  return JSON.parse(result.stdout);
}

const NO_POSIX_HOST = process.platform === 'win32';
describe.skipIf(NO_POSIX_HOST)('system layer: package caches in every home', () => {
  it('the shared predicate excludes caches under /root and every /home/<user>, and keeps the Yarn berry cache', async () => {
    expect(await python(`
print(json.dumps({'caches': [excluded(p) for p in CACHES], 'kept': [excluded(p) for p in KEPT],
                  'edge': [excluded('/home/.cache'), excluded('/home/alice/app/.cache/x'), excluded('/home/alice/.cache')]}))
sys.exit(0)
`, 'sys-dirty', false)).toEqual({ caches: [true, true, true, true, true, true], kept: [false, false, false, false, false, false],
      edge: [false, false, true] });
  });

  it('capture leaves caches out and keeps everything else', async () => {
    const result = await python(`
for rel in CACHES + KEPT: put(rel)
picked = inventory(OLD - 1, {})
print(json.dumps({'caches': [test_root + p in picked for p in CACHES], 'kept': [test_root + p in picked for p in KEPT]}))
sys.exit(0)
`);
    expect(result).toEqual({ caches: [false, false, false, false, false, false], kept: [true, true, true, true, true, true] });
  });

  it('restore skips caches that an older snapshot archived', async () => {
    const result = await python(`
hold_package_locks = lambda block: []
image_id = lambda: 'test'
os.mkdir(work)
archive = test_root + '/built.tar'
with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
    for rel in CACHES + KEPT:
        info = tarfile.TarInfo((test_root + rel).lstrip('/'))
        info.mode, info.uid, info.gid, info.mtime, info.size = 0o644, os.getuid(), os.getgid(), 1700000000, 1
        tar.addfile(info, io.BytesIO(b'x'))
    info = tarfile.TarInfo(DELETED_MEMBER); info.size, info.mode = 2, 0o600
    tar.addfile(info, io.BytesIO(b'[]'))
with open(archive, 'rb') as f: data = f.read()
with open(work + '/0', 'wb') as f: f.write(data)
digest = hashlib.sha256(data).hexdigest()
p['snapshot'] = {'chunks': [{'size': len(data), 'sha256': digest}], 'sha256': digest, 'archiveSha256': digest,
                 'imageId': 'test', 'generation': 'g1'}
with contextlib.redirect_stdout(io.StringIO()): restore()
print(json.dumps({'caches': [os.path.exists(test_root + p) for p in CACHES], 'kept': [os.path.exists(test_root + p) for p in KEPT]}))
sys.exit(0)
`);
    expect(result).toEqual({ caches: [false, false, false, false, false, false], kept: [true, true, true, true, true, true] });
  });

  it('a cleared cache is never recorded as a deletion', async () => {
    const result = await python(`
image = {test_root + p: ('f', 1, 1700000000, '', None) for p in CACHES + KEPT}
missing = missing_image_paths(image)
print(json.dumps({'caches': [test_root + p in missing for p in CACHES], 'kept': [test_root + p in missing for p in KEPT]}))
sys.exit(0)
`);
    expect(result).toEqual({ caches: [false, false, false, false, false, false], kept: [true, true, true, true, true, true] });
  });

  it('writes into caches never make the layer dirty', async () => {
    expect(await python(`
for rel in CACHES: put(rel)
for d, dirs, files in os.walk(test_root):
    for n in dirs + files: stamp(os.path.join(d, n))
    stamp(d)
open(CAPTURE_STARTED, 'w').close()
stamp(CAPTURE_STARTED)
for rel in CACHES:
    stamp(test_root + rel, OLD + 1)
    stamp(os.path.dirname(test_root + rel), OLD + 1)
`)).toEqual({ dirty: false });
  });
});
