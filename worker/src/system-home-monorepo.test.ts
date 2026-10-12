import { describe, expect, it } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SYSTEM_SNAPSHOT_SCRIPT } from './system-snapshot-script';

// PR195 review r4241774149: a HOME monorepo (~/repo/package-lock.json owning
// ~/repo/apps/web through "workspaces") installs every member from the ROOT, so a
// member's node_modules and .next are as regenerable as the root's own. Requiring a
// lockfile beside the member kept them in the system layer, where a large Next.js
// or pnpm monorepo passes the snapshot limits and freezes every later save (the
// HOME-freeze class). One predicate must decide for capture, restore, deletion
// detection and the dirty probe, and it must never claim a member the root's own
// package manager would not install (that member's trees would then be lost).
const run = promisify(execFile);
async function python(scenario: string, op = 'sys-dirty') {
  const setup = String.raw`
import tempfile, io, contextlib, tarfile
test_dir = tempfile.TemporaryDirectory(prefix='ezil-system-home-monorepo-test-')
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
EXCLUDE = [STATE]
OLD = 1700000000000000000
def stamp(path, ns=OLD): os.utime(path, ns=(ns, ns), follow_symlinks=False)
work = test_root + '/work'
# Run the real predicate on the fixture's homes: strip the temp prefix first.
if 'split_home' in globals():
    real_split_home = split_home
    def split_home(path):
        if not path.startswith(test_root + '/'): return None
        found = real_split_home(path[len(test_root):])
        return None if found is None else (test_root + found[0], found[1])
else:
    real_project_directory = regenerable_project_directory
    def regenerable_project_directory(path):
        if not path.startswith(test_root + '/'): return None
        directory = real_project_directory(path[len(test_root):])
        return test_root + directory if directory is not None else None
FILES = {}
def put(rel, data='x'):
    FILES[rel] = data
    path = test_root + rel
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f: f.write(data)
    return path
WS = lambda *patterns: json.dumps({'name': 'root', 'private': True, 'workspaces': list(patterns)})
def layout():
    # npm workspaces: apps/* and packages/** (a trailing ** needs one segment)
    put('/root/repo/package.json', WS('apps/*', 'packages/**'))
    put('/root/repo/package-lock.json', '{}')
    put('/root/repo/node_modules/dep/index.js')
    put('/root/repo/apps/web/package.json', '{"name":"web"}')
    put('/root/repo/apps/web/node_modules/dep/index.js')
    put('/root/repo/apps/web/.next/server/page.js')
    put('/root/repo/apps/web/src/page.js')
    put('/root/repo/packages/ui/package.json', '{"name":"ui"}')
    put('/root/repo/packages/ui/node_modules/x/index.js')
    put('/root/repo/tools/gen/package.json', '{"name":"gen"}')          # not declared
    put('/root/repo/tools/gen/node_modules/x/index.js')
    # pnpm: members come from pnpm-workspace.yaml only; negation honoured
    put('/root/mono/package.json', '{"name":"mono"}')
    put('/root/mono/pnpm-lock.yaml', 'lockfileVersion: 9')
    put('/root/mono/pnpm-workspace.yaml', "packages:\n  - 'apps/*'   # every app\n  - \"!apps/legacy\"\n")
    put('/root/mono/apps/site/package.json', '{"name":"site"}')
    put('/root/mono/apps/site/node_modules/x/index.js')
    put('/root/mono/apps/legacy/package.json', '{"name":"legacy"}')
    put('/root/mono/apps/legacy/node_modules/x/index.js')
    # pnpm lockfile but workspaces only in package.json: pnpm installs no members
    put('/root/pn2/package.json', WS('apps/*'))
    put('/root/pn2/pnpm-lock.yaml', 'lockfileVersion: 9')
    put('/root/pn2/apps/a/package.json', '{"name":"a"}')
    put('/root/pn2/apps/a/node_modules/x/index.js')
    # no lockfile at the root: nothing can rebuild the members
    put('/root/free/package.json', WS('apps/*'))
    put('/root/free/apps/a/package.json', '{"name":"a"}')
    put('/root/free/apps/a/node_modules/x/index.js')
    # npm does not read the {packages: [...]} form; Yarn does
    put('/root/npmobj/package.json', json.dumps({'workspaces': {'packages': ['apps/*']}}))
    put('/root/npmobj/package-lock.json', '{}')
    put('/root/npmobj/apps/a/package.json', '{"name":"a"}')
    put('/root/npmobj/apps/a/node_modules/x/index.js')
    put('/root/yarnobj/package.json', json.dumps({'workspaces': {'packages': ['apps/*']}}))
    put('/root/yarnobj/yarn.lock', '')
    put('/root/yarnobj/apps/a/package.json', '{"name":"a"}')
    put('/root/yarnobj/apps/a/node_modules/x/index.js')
    # an unsupported glob (braces) never claims a member
    put('/root/brace/package.json', WS('apps/{a,b}'))
    put('/root/brace/package-lock.json', '{}')
    put('/root/brace/apps/a/package.json', '{"name":"a"}')
    put('/root/brace/apps/a/node_modules/x/index.js')
    # a hidden tool dir is never a project, workspace or not
    put('/root/.tool/package.json', WS('apps/*'))
    put('/root/.tool/package-lock.json', '{}')
    put('/root/.tool/apps/a/package.json', '{"name":"a"}')
    put('/root/.tool/apps/a/node_modules/x/index.js')
    # another user's home, Bun workspaces
    put('/home/alice/proj/package.json', WS('web'))
    put('/home/alice/proj/bun.lock', '{}')
    put('/home/alice/proj/web/package.json', '{"name":"web"}')
    put('/home/alice/proj/web/node_modules/x/index.js')
    put('/home/alice/proj/web/.next/cache/x')
EXCLUDED = ['/root/repo/node_modules/dep/index.js', '/root/repo/apps/web/node_modules/dep/index.js',
            '/root/repo/apps/web/.next/server/page.js', '/root/repo/packages/ui/node_modules/x/index.js',
            '/root/mono/apps/site/node_modules/x/index.js', '/root/yarnobj/apps/a/node_modules/x/index.js',
            '/home/alice/proj/web/node_modules/x/index.js', '/home/alice/proj/web/.next/cache/x']
KEPT = ['/root/repo/apps/web/src/page.js', '/root/repo/tools/gen/node_modules/x/index.js',
        '/root/mono/apps/legacy/node_modules/x/index.js', '/root/pn2/apps/a/node_modules/x/index.js',
        '/root/free/apps/a/node_modules/x/index.js', '/root/npmobj/apps/a/node_modules/x/index.js',
        '/root/brace/apps/a/node_modules/x/index.js', '/root/.tool/apps/a/node_modules/x/index.js']
# predicate(rel) is True when the codec leaves rel out of the layer.
def report(predicate):
    return {'excluded': [rel for rel in EXCLUDED if not predicate(rel)], 'kept': [rel for rel in KEPT if predicate(rel)]}
`;
  const insertion = '\ntry:\n    op = p[\'op\']';
  expect(SYSTEM_SNAPSHOT_SCRIPT).toContain(insertion);
  const script = SYSTEM_SNAPSHOT_SCRIPT.replace(insertion, `\n${setup}\n${scenario}\n${insertion}`);
  const result = await run('python3', ['-I', '-c', script,
    JSON.stringify({ op, work: '/tmp/ezil-system-test' })], { env: { PATH: '/usr/bin:/bin' } });
  return JSON.parse(result.stdout);
}

// Every list below is "what went wrong": empty means the predicate decided right.
const RIGHT = { excluded: [], kept: [] };
const NO_POSIX_HOST = process.platform === 'win32';
describe.skipIf(NO_POSIX_HOST)('system layer: HOME monorepo members', () => {
  it('capture leaves out a member\'s node_modules and .next exactly where the root\'s package manager installs it', async () => {
    expect(await python(`
layout()
picked = inventory(OLD - 1, {})
print(json.dumps(report(lambda rel: test_root + rel not in picked)))
sys.exit(0)
`)).toEqual(RIGHT);
  });

  it('a large monorepo no longer passes the entry limit and freezes saving', async () => {
    expect(await python(`
put('/root/repo/package.json', WS('apps/*'))
put('/root/repo/package-lock.json', '{}')
put('/root/repo/apps/web/package.json', '{"name":"web"}')
for i in range(40): put('/root/repo/apps/web/node_modules/dep%d/index.js' % i)
for i in range(40): put('/root/repo/apps/web/.next/chunk%d.js' % i)
MAX_ENTRIES = 50
try:
    picked = inventory(OLD - 1, {})
    print(json.dumps({'entries': sorted(path[len(test_root):] for path in picked)}))
except AssertionError as e:
    print(json.dumps({'error': str(e)}))
sys.exit(0)
`)).toEqual({ entries: ['/root', '/root/repo', '/root/repo/apps', '/root/repo/apps/web', '/root/repo/apps/web/package.json',
      '/root/repo/package-lock.json', '/root/repo/package.json'] });
  });

  it('restore of an older snapshot that archived member trees skips them, reading the root from the archive', async () => {
    expect(await python(`
hold_package_locks = lambda block: []
image_id = lambda: 'test'
layout()
names = dict(FILES)
for d, dirs, files in os.walk(test_root + '/root', topdown=False):
    for n in files: os.unlink(os.path.join(d, n))
    for n in dirs: os.rmdir(os.path.join(d, n))
shutil.rmtree(test_root + '/home/alice')
os.mkdir(work)
archive = test_root + '/built.tar'
with tarfile.open(archive, 'w', format=tarfile.PAX_FORMAT) as tar:
    for rel, data in names.items():
        raw = data.encode()
        info = tarfile.TarInfo((test_root + rel).lstrip('/'))
        info.mode, info.uid, info.gid, info.mtime, info.size = 0o644, os.getuid(), os.getgid(), 1700000000, len(raw)
        tar.addfile(info, io.BytesIO(raw))
    info = tarfile.TarInfo(DELETED_MEMBER); info.size, info.mode = 2, 0o600
    tar.addfile(info, io.BytesIO(b'[]'))
with open(archive, 'rb') as f: data = f.read()
with open(work + '/0', 'wb') as f: f.write(data)
digest = hashlib.sha256(data).hexdigest()
p['snapshot'] = {'chunks': [{'size': len(data), 'sha256': digest}], 'sha256': digest, 'archiveSha256': digest,
                 'imageId': 'test', 'generation': 'g1'}
with contextlib.redirect_stdout(io.StringIO()): restore()
print(json.dumps(report(lambda rel: not os.path.exists(test_root + rel))))
sys.exit(0)
`)).toEqual(RIGHT);
  });

  it('deletion detection and the dirty probe follow the same predicate', async () => {
    expect(await python(`
layout()
image = {test_root + rel: ('f', 1, 1700000000, '', None) for rel in EXCLUDED + KEPT}
for rel in EXCLUDED + KEPT: os.unlink(test_root + rel)
missing = missing_image_paths(image)
print(json.dumps(report(lambda rel: test_root + rel not in missing)))
sys.exit(0)
`)).toEqual(RIGHT);
    expect(await python(`
layout()
for d, dirs, files in os.walk(test_root):
    for n in dirs + files: stamp(os.path.join(d, n))
    stamp(d)
open(CAPTURE_STARTED, 'w').close()
stamp(CAPTURE_STARTED)
for rel in EXCLUDED:
    stamp(test_root + rel, OLD + 1)
    stamp(os.path.dirname(test_root + rel), OLD + 1)
`)).toEqual({ dirty: false });
  });

  it('a member that the root does not install stays captured and dirty', async () => {
    expect(await python(`
layout()
for d, dirs, files in os.walk(test_root):
    for n in dirs + files: stamp(os.path.join(d, n))
    stamp(d)
open(CAPTURE_STARTED, 'w').close()
stamp(CAPTURE_STARTED)
stamp(test_root + '/root/mono/apps/legacy/node_modules/x/index.js', OLD + 1)
`)).toEqual({ dirty: true });
  });

  it('pnpm-workspace.yaml: block and flow lists, comments and quotes; anything else claims nothing', async () => {
    expect(await python(`
cases = {
  'block': "packages:\\n  - apps/*\\n  - 'packages/*' # ui\\n\\ncatalog:\\n  react: 19\\n",
  'flow': "packages: ['apps/*', \\"packages/*\\"]\\n",
  'anchor': "packages: &p\\n  - apps/*\\n",
  'nested': "packages:\\n  - apps/*\\n    extra: 1\\n",
  'none': "catalog:\\n  react: 19\\n",
}
print(json.dumps({k: pnpm_workspace_packages(v) for k, v in cases.items()}))
sys.exit(0)
`)).toEqual({ block: ['apps/*', 'packages/*'], flow: ['apps/*', 'packages/*'], anchor: null, nested: null, none: null });
  });

  it('glob subset: * is one segment, a trailing ** needs one, ! excludes, unsupported syntax matches nothing', async () => {
    expect(await python(`
cases = [
  (['apps/*'], 'apps/web'), (['apps/*'], 'apps/web/x'), (['apps/*'], 'apps'),
  (['packages/**'], 'packages'), (['packages/**'], 'packages/a'), (['packages/**'], 'packages/a/b'),
  (['**/web'], 'web'), (['**/web'], 'apps/web'), (['./apps/*/'], 'apps/web'), (['apps/web-*'], 'apps/web-1'),
  (['apps/*', '!apps/old'], 'apps/old'), (['apps/{a,b}'], 'apps/a'), (['apps/[ab]'], 'apps/a'), (['apps/?'], 'apps/a'),
  (['apps/*'], ''), ([], 'apps/a'), (['/abs'], 'abs'), (['../up'], 'up'),
]
print(json.dumps([workspace_member(patterns, rel) for patterns, rel in cases]))
sys.exit(0)
`)).toEqual([true, false, false, false, true, true, true, true, true, true, false, false, false, false, false, false, false, false]);
  });
});
