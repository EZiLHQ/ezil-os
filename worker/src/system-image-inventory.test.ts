// Exercise the actual Python capture/restore codec in a disposable filesystem.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_SNAPSHOT_SCRIPT } from './system-snapshot-script';

const python = spawnSync('python3', ['-c', 'import tarfile'], { encoding: 'utf8' }).status === 0;
const HARNESS = String.raw`
import contextlib, io, json, os, sys
stage = json.loads(sys.argv[1])['work']
root = stage + '/rootfs'
source = open(stage + '/codec.py').read().split("\ntry:\n    op = p['op']")[0]
# Remap every system root before executing, so no host files are read or changed.
for path in ('/usr', '/etc', '/opt', '/var', '/root', '/home'):
    source = source.replace("'" + path, "'" + root + path)
exec(source)
for path in ROOTS: os.makedirs(path, exist_ok=True)
os.makedirs(STATE, exist_ok=True)
files = [root + '/etc/' + name for name in (
    'ezil-image-id', 'ezil-image-manifest.tsv', 'ezil-image-apt-manual.txt', 'ezil-image-npm-global.txt')]
for path in files:
    with open(path, 'w') as f: f.write('receiving-image' if path == files[0] else '')
user_file = root + '/etc/user-setting'
with open(user_file, 'w') as f: f.write('user setting')
with open(BASELINE, 'w') as f: f.write('0')
os.utime(BASELINE, (0, 0))
mark_hydrated(None)
# Old manifests must not reintroduce baked files into a capture.
with open(MANIFEST, 'w') as f: json.dump({'paths': files}, f)
# Avoid invoking the host package manager: replay lists are unrelated to file capture.
replay_lists = lambda: {'apt': [], 'npm': []}
captured = capture(stage + '/capture.tar')
with tarfile.open(stage + '/capture.tar') as tar:
    members = ['/' + member.name for member in tar]
assert all(path not in members for path in files), members
assert user_file in members
assert captured['imageId'] == 'receiving-image'
# A tombstone in an old manifest must also stay out of the next capture.
os.unlink(files[2])
with open(MANIFEST, 'w') as f: json.dump({'deleted': [files[2]]}, f)
capture(stage + '/capture-deleted.tar')
with tarfile.open(stage + '/capture-deleted.tar') as tar:
    assert files[2] not in json.load(tar.extractfile(DELETED_MEMBER))
with open(files[2], 'w') as f: f.write('')
os.unlink(MANIFEST)

# Simulate a legacy archive containing stale baked files, including a symlink.
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode='w') as tar:
    for i, path in enumerate(files + [user_file]):
        member = tarfile.TarInfo(path.lstrip('/'))
        member.mode, member.uid, member.gid = 0o600, os.getuid(), os.getgid()
        if i == 2:
            member.type, member.linkname = tarfile.SYMTYPE, user_file
            tar.addfile(member)
        else:
            data = b'snapshot-value'
            member.size = len(data)
            tar.addfile(member, io.BytesIO(data))
    data = json.dumps(files).encode()
    member = tarfile.TarInfo(DELETED_MEMBER); member.size = len(data)
    tar.addfile(member, io.BytesIO(data))
data = archive.getvalue()
digest = hashlib.sha256(data).hexdigest()
with open(stage + '/0', 'wb') as f: f.write(data)
p['snapshot'] = {'imageId': json.loads(sys.argv[1])['snapshotImageId'], 'generation': 'test-generation',
    'sha256': digest, 'chunks': [{'size': len(data), 'sha256': digest}]}
before = {path: open(path).read() for path in files}
# A second read after applying the snapshot would be wrong even if another
# process changed the marker concurrently. Restore must use its initial read.
real_image_id = image_id
image_reads = []
def image_id():
    image_reads.append(True)
    return real_image_id() if len(image_reads) == 1 else 'late-marker'
output = io.StringIO()
with contextlib.redirect_stdout(output): restore()
result = json.loads(output.getvalue())
assert result['sameImage'] == (p['snapshot']['imageId'] == 'receiving-image'), result
assert result['imageId'] == 'receiving-image', result
assert len(image_reads) == 1
assert all(not os.path.islink(path) and open(path).read() == before[path] for path in files)
assert open(user_file).read() == 'snapshot-value'
manifest = json.load(open(MANIFEST))
assert manifest['paths'] == [user_file], manifest
assert manifest['deleted'] == [], manifest
assert manifest['imageId'] == 'receiving-image', manifest
print(json.dumps(result))
`;

describe.skipIf(!python)('system-layer baked image inventory', () => {
  for (const snapshotImageId of ['old-image', 'receiving-image']) {
    test(`capture excludes inventory; restore preserves receiving files and identity (${snapshotImageId})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ezil-system-inventory-'));
      try {
        writeFileSync(join(dir, 'codec.py'), SYSTEM_SNAPSHOT_SCRIPT);
        const run = spawnSync('python3', ['-c', HARNESS, JSON.stringify({ work: dir, snapshotImageId })], { encoding: 'utf8' });
        expect(run.stderr).toBe('');
        expect(run.status).toBe(0);
        expect(JSON.parse(run.stdout).imageId).toBe('receiving-image');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
});


// Use the real codec, with every system root redirected before execution.
const MANAGED_CODE_HARNESS = String.raw`
import contextlib, io, json, os, sys
stage = json.loads(sys.argv[1])['work']
root = stage + '/rootfs'
source = open(stage + '/codec.py').read().split("\ntry:\n    op = p['op']")[0]
for path in ('/usr', '/etc', '/opt', '/var', '/root', '/home'):
    source = source.replace("'" + path, "'" + root + path)
exec(source)
for path in ROOTS: os.makedirs(path, exist_ok=True)
os.makedirs(STATE, exist_ok=True)
with open(root + '/etc/ezil-image-id', 'w') as f: f.write('receiving-image')
with open(IMAGE_MANIFEST, 'w') as f: f.write('')
scenario = json.loads(sys.argv[1])['scenario']
managed = [root + path for path in (
    '/usr/lib/code-server/lib/vscode/extensions/ezil.ezil-models/dist/extension.js',
    '/usr/lib/code-server/lib/vscode/extensions/copilot/dist/extension.js',
    '/usr/lib/code-server/lib/vscode/out/vs/code/browser/workbench/workbench.js',
    '/usr/lib/code-server/lib/vscode/out/server-main.js')]
users = [root + path for path in (
    '/etc/user-setting', '/usr/local/bin/user-tool',
    '/root/.local/share/code-server/extensions/user.plugin/extension.js')]
retained = root + '/usr/local/bin/retained-tool'
deleted_user = root + '/usr/local/bin/deleted-tool'
for i, path in enumerate(managed + users + [retained, deleted_user]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f: f.write('receiving-' + str(i))
before = {path: open(path, 'rb').read() for path in managed}
user_link = root + '/usr/local/bin/user-link'
os.symlink(managed[0], user_link)
if scenario == 'capture':
    with open(BASELINE, 'w') as f: f.write('0')
    os.utime(BASELINE, (0, 0))
    mark_hydrated(None)
    replay_lists = lambda: {'apt': [], 'npm': []}
    with open(MANIFEST, 'w') as f: json.dump({'paths': managed + users}, f)
    capture(stage + '/captured.tar')
    with tarfile.open(stage + '/captured.tar') as tar:
        members = ['/' + member.name for member in tar]
        assert all(path not in members for path in managed), members
        assert all(path in members for path in users), members
    for path in managed: os.unlink(path)
    with open(MANIFEST, 'w') as f: json.dump({'deleted': managed}, f)
    capture(stage + '/captured-deletions.tar')
    with tarfile.open(stage + '/captured-deletions.tar') as tar:
        deleted = json.load(tar.extractfile(DELETED_MEMBER))
        assert all(path not in deleted for path in managed), deleted
    print(json.dumps({'scenario': scenario, 'protected': len(managed)}))
    sys.exit(0)

archive = io.BytesIO()
alias_children = []
with tarfile.open(fileobj=archive, mode='w') as tar:
    def member(path, data=b'stale-product', link=None):
        m = tarfile.TarInfo(path.lstrip('/'))
        m.mode, m.uid, m.gid = 0o600, os.getuid(), os.getgid()
        if link is not None:
            m.type, m.linkname = tarfile.SYMTYPE, link
            tar.addfile(m)
        else:
            m.size = len(data)
            tar.addfile(m, io.BytesIO(data))
    for i, path in enumerate(managed):
        if scenario == 'regular': member(path)
        elif scenario == 'symlink': member(path, link=users[0])
        elif scenario in ('alias', 'deletions'):
            alias = root + '/opt/code-alias-' + str(i)
            target = os.path.dirname(path)
            link = target if i % 2 else os.path.relpath(target, os.path.dirname(alias))
            os.symlink(link, alias)
            alias_path = alias + '/' + os.path.basename(path)
            alias_children.append(alias_path)
            if scenario == 'alias':
                member(alias, link=link)
                member(alias_path)
        elif scenario == 'ancestor-symlink':
            target = root + '/opt/user-code-' + str(i)
            os.makedirs(target)
            with open(target + '/' + os.path.basename(path), 'w') as f: f.write('stale-product')
            member(os.path.dirname(path), link=target)
    for i, path in enumerate(users): member(path, ('user-snapshot-' + str(i)).encode())
    # Changing a user-owned final symlink never writes its old product target.
    member(user_link, link=users[0])
    if scenario == 'deletions':
        ancestors = set()
        for path in managed:
            parent = os.path.dirname(path)
            while parent.startswith(root + '/usr'):
                ancestors.add(parent)
                parent = os.path.dirname(parent)
        member(DELETED_MEMBER, json.dumps(managed + alias_children + sorted(ancestors) + [deleted_user]).encode())
data = archive.getvalue()
digest = hashlib.sha256(data).hexdigest()
with open(stage + '/0', 'wb') as f: f.write(data)
p['snapshot'] = {'imageId': json.loads(sys.argv[1])['snapshotImageId'], 'generation': 'test-generation',
    'sha256': digest, 'chunks': [{'size': len(data), 'sha256': digest}]}
output = io.StringIO()
with contextlib.redirect_stdout(output): restore()
result = json.loads(output.getvalue())
assert result['sameImage'] == (p['snapshot']['imageId'] == 'receiving-image'), result
assert all(not os.path.islink(path) and open(path, 'rb').read() == before[path] for path in managed), scenario
for i, path in enumerate(users): assert open(path).read() == 'user-snapshot-' + str(i), path
assert open(retained).read() == 'receiving-7'
assert os.path.islink(user_link) and os.readlink(user_link) == users[0]
assert os.path.exists(deleted_user) == (scenario != 'deletions' or not result['sameImage'])
manifest = json.load(open(MANIFEST))
assert all(path not in manifest['paths'] and path not in manifest['deleted'] for path in managed + alias_children), manifest
assert all(path in manifest['paths'] for path in users), manifest
if scenario == 'alias': assert all(os.path.islink(os.path.dirname(path)) for path in alias_children)
print(json.dumps({'scenario': scenario, 'sameImage': result['sameImage'], 'protected': len(managed), 'userFiles': len(users)}))
`;

describe.skipIf(!python)('system-layer managed Code products', () => {
  for (const snapshotImageId of ['old-image', 'receiving-image']) {
    for (const scenario of ['regular', 'symlink', 'alias', 'ancestor-symlink', 'deletions', 'capture']) {
      test(`${scenario}: preserve managed products and user installs (${snapshotImageId})`, () => {
        const dir = mkdtempSync(join(tmpdir(), 'ezil-system-managed-code-'));
        try {
          writeFileSync(join(dir, 'codec.py'), SYSTEM_SNAPSHOT_SCRIPT);
          const run = spawnSync('python3', ['-c', MANAGED_CODE_HARNESS, JSON.stringify({ work: dir, snapshotImageId, scenario })], { encoding: 'utf8' });
          expect(run.stderr).toBe('');
          expect(run.status).toBe(0);
          expect(JSON.parse(run.stdout).protected).toBe(4);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      });
    }
  }
});
