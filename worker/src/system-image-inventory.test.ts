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
