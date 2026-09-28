/** Container-side snapshot codec. Python is already present in the sandbox image.
 * No shell expansion, tar extraction, symlink following, or repository hooks.
 * Files are transferred in bounded chunks through the existing Sandbox RPCs.
 */
export const SNAPSHOT_SCRIPT = String.raw`
import os, sys, json, stat, tarfile, hashlib, shutil, subprocess, tempfile
from contextlib import contextmanager

CHUNK = 1024 * 1024
LIMIT = 512 * CHUNK
MAX_ENTRIES = 100000
INTERNAL = {'.ezil-hydrated.json', '.ezil-flush-manifest.json'}
CACHES = {'node_modules', '.next', '.turbo', 'dist'}
p = json.loads(sys.argv[1])
root = p['root']
work = p['work']
assert os.path.isabs(root) and root != '/' and os.path.realpath(root) == root, 'invalid workspace root'
assert os.path.dirname(work) == '/tmp' and os.path.basename(work).startswith('ezil-snapshot-'), 'invalid staging path'

def safe_name(name):
    assert isinstance(name, str) and name and not name.startswith('/') and '\\' not in name
    assert all(x not in ('', '.', '..') for x in name.split('/')), 'unsafe archive path'
    assert name.split('/')[0] not in INTERNAL, 'reserved archive path'

def safe_link(name, target):
    assert target and not os.path.isabs(target) and '\\' not in target, 'unsafe symlink'
    resolved = os.path.normpath(os.path.join(os.path.dirname(name), target))
    assert resolved != '..' and not resolved.startswith('../'), 'escaping symlink'

@contextmanager
def directory_fd(path, base=None):
    # Pin every ancestor. O_NOFOLLOW on just the final file is insufficient:
    # a concurrently replaced parent could otherwise redirect reads outside.
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY) if base is None else os.dup(base)
    try:
        for part in path.split('/'):
            if not part: continue
            assert part not in ('.', '..')
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally: os.close(fd)

@contextmanager
def workspace_file(name):
    parent, leaf = os.path.split(name)
    with directory_fd(root) as root_fd, directory_fd(parent, root_fd) as fd:
        f = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(f, 'rb') as stream:
            assert stat.S_ISREG(os.fstat(stream.fileno()).st_mode), 'not a regular file'
            yield stream

def marker():
    with workspace_file('.ezil-hydrated.json') as f:
        m = json.loads(f.read(CHUNK))
    assert m.get('version') == 1 and m.get('prefix') == p['prefix'] and m.get('mountPath') == root, 'hydration incomplete'
    assert m.get('checkpoint') == p.get('expected'), 'workspace writer is stale'

def inventory():
    tracked = set()
    # Read ONLY the index with Git, in a private repository with no user config,
    # hooks, fsmonitor, external includes, or environment-supplied Git options.
    # Copy shared indexes as well so split-index workspaces remain supported.
    with directory_fd(root) as root_fd:
        if '.git' in os.listdir(root_fd):
            with directory_fd('.git', root_fd) as git_fd:
                names = os.listdir(git_fd)
                if 'index' in names:
                    with tempfile.TemporaryDirectory(dir=work) as git_dir:
                        os.mkdir(os.path.join(git_dir, 'objects'))
                        os.mkdir(os.path.join(git_dir, 'refs'))
                        with open(os.path.join(git_dir, 'HEAD'), 'w') as f: f.write('ref: refs/heads/main\n')
                        copied = 0
                        for name in names:
                            if name != 'index' and not name.startswith('sharedindex.'): continue
                            with workspace_file('.git/' + name) as src, open(os.path.join(git_dir, name), 'xb') as dst:
                                while True:
                                    data = src.read(CHUNK)
                                    if not data: break
                                    copied += len(data)
                                    assert copied <= LIMIT, 'Git index byte limit'
                                    dst.write(data)
                        git_env = {'PATH': '/usr/bin:/bin', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_OPTIONAL_LOCKS': '0'}
                        # File output bounds process memory even for a corrupt index.
                        with tempfile.TemporaryFile(dir=work) as output:
                            r = subprocess.run(['/usr/bin/git', '--git-dir=' + git_dir, '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--sparse'],
                                cwd=work, env=git_env, stdout=output, stderr=subprocess.DEVNULL, timeout=30)
                            assert r.returncode == 0, 'cannot read Git index'
                            assert output.tell() <= 16 * CHUNK, 'Git paths byte limit'
                            output.seek(0)
                            for path in output.read().decode('utf-8').split('\0'):
                                parts = path.split('/')
                                tracked.update('/'.join(parts[:i]) for i in range(1, len(parts)+1))
    entries = []
    def visit(directory, rel=''):
        with os.scandir(directory) as iterator:
            children = sorted(iterator, key=lambda e: e.name)
        for e in children:
            name = rel + '/' + e.name if rel else e.name
            if name in INTERNAL:
                continue
            in_git = '.git' in name.split('/')
            if not in_git and e.name in CACHES and name not in tracked:
                continue
            safe_name(name)
            s = e.stat(follow_symlinks=False)
            assert not (in_git and name.endswith('.lock')), 'Git operation in progress'
            assert not (e.name == '.git' and not stat.S_ISDIR(s.st_mode)), 'external Git directory unsupported'
            assert not (name.endswith('/objects/info/alternates') and s.st_size), 'external Git objects unsupported'
            assert stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode), 'unsupported file type'
            target = os.readlink(e.name, dir_fd=directory) if stat.S_ISLNK(s.st_mode) else None
            if target is not None:
                safe_link(name, target)
                assert os.path.commonpath([root, os.path.realpath(os.path.join(root, name))]) == root, 'escaping symlink chain'
            entries.append((name, s, target))
            assert len(entries) <= MAX_ENTRIES, 'snapshot entry limit'
            if stat.S_ISDIR(s.st_mode):
                with directory_fd(e.name, directory) as child:
                    assert os.fstat(child).st_ino == s.st_ino, 'workspace changed'
                    visit(child, name)
    with directory_fd(root) as fd: visit(fd)
    return entries

def stamp(entries):
    return [(n, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_ino, t) for n,s,t in entries]

def capture(path):
    marker()
    entries = inventory()
    with tarfile.open(path, 'w', format=tarfile.PAX_FORMAT) as tar:
        for name, s, target in entries:
            info = tarfile.TarInfo(name)
            info.mode = stat.S_IMODE(s.st_mode) & 0o777
            # Stable serialization; archive ownership never grants privileges.
            if stat.S_ISDIR(s.st_mode):
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif target is not None:
                info.type = tarfile.SYMTYPE
                info.linkname = target
                tar.addfile(info)
            else:
                info.size = s.st_size
                assert tar.offset + info.size <= LIMIT, 'snapshot byte limit'
                with workspace_file(name) as f:
                    before = os.fstat(f.fileno())
                    assert (before.st_dev, before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (s.st_dev, s.st_ino, s.st_mode, s.st_size, s.st_mtime_ns, s.st_ctime_ns), 'workspace changed'
                    tar.addfile(info, f)
    assert stamp(entries) == stamp(inventory()), 'workspace changed'
    assert os.path.getsize(path) <= LIMIT, 'snapshot byte limit'
    digest = hashlib.sha256()
    chunks = []
    with open(path, 'rb') as f:
        while True:
            data = f.read(CHUNK)
            if not data: break
            digest.update(data)
            chunks.append({'size':len(data), 'sha256':hashlib.sha256(data).hexdigest()})
    return {'sha256':digest.hexdigest(), 'chunks':chunks, 'entries':len(entries)}

def restore():
    archive = os.path.join(work, 'archive.tar')
    digest = hashlib.sha256()
    with open(archive, 'wb') as out:
        for i, chunk in enumerate(p['snapshot']['chunks']):
            with open(os.path.join(work, str(i)), 'rb') as f: data = f.read(CHUNK + 1)
            assert len(data) == chunk['size'] and hashlib.sha256(data).hexdigest() == chunk['sha256'], 'corrupt chunk'
            out.write(data)
            digest.update(data)
    assert digest.hexdigest() == p['snapshot']['sha256'], 'corrupt archive'
    stage = root + '.ezil-restore-' + os.path.basename(work)
    os.mkdir(stage, 0o700)
    try:
        with tarfile.open(archive, 'r:') as tar:
            members = []
            for m in tar:
                members.append(m)
                assert len(members) <= min(p['snapshot']['entries'], MAX_ENTRIES), 'archive entry limit'
            assert len(members) == p['snapshot']['entries'] and len(members) <= MAX_ENTRIES, 'incomplete archive'
            seen = {}
            total = 0
            for m in members:
                safe_name(m.name)
                assert m.name not in seen, 'duplicate archive path'
                assert m.isfile() or m.isdir() or m.issym(), 'unsupported archive type'
                assert 0 <= m.mode <= 0o777 and m.size >= 0, 'invalid archive metadata'
                if m.issym(): safe_link(m.name, m.linkname)
                seen[m.name] = m
                total += m.size
                assert total <= LIMIT, 'archive byte limit'
            for m in members:
                parts = m.name.split('/')
                for i in range(1, len(parts)):
                    parent = seen.get('/'.join(parts[:i]))
                    assert parent is not None and parent.isdir(), 'non-directory archive parent'
                path = os.path.join(stage, m.name)
                if m.isdir(): os.makedirs(path, exist_ok=True)
                elif m.isfile():
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    with tar.extractfile(m) as src, open(path, 'xb') as dst:
                        shutil.copyfileobj(src, dst, CHUNK)
                    os.chmod(path, m.mode)
            # Links last; writes never traverse a link supplied by an archive.
            for m in members:
                if m.issym(): os.symlink(m.linkname, os.path.join(stage, m.name))
            for m in members:
                if m.issym():
                    assert os.path.commonpath([stage, os.path.realpath(os.path.join(stage, m.name))]) == stage, 'escaping symlink chain'
            for m in reversed(members):
                if m.isdir(): os.chmod(os.path.join(stage, m.name), m.mode)
        with open(os.path.join(stage, '.ezil-hydrated.json'), 'x') as f:
            json.dump(p['marker'], f)
        # Never overwrite a warm, unmarked workspace or its unpersisted edits.
        assert not os.path.exists(root) or (os.path.isdir(root) and not os.listdir(root)), 'workspace is not empty'
        os.chmod(stage, 0o755)
        os.replace(stage, root)
    finally:
        if os.path.exists(stage): shutil.rmtree(stage)

try:
    op = p['op']
    if op == 'capture':
        os.mkdir(work, 0o700)
        result = capture(os.path.join(work, 'archive.tar'))
        with open(os.path.join(work, 'archive.tar'), 'rb') as f:
            for i in range(len(result['chunks'])):
                with open(os.path.join(work, str(i)), 'xb') as out: out.write(f.read(CHUNK))
        print(json.dumps(result))
    elif op == 'verify':
        result = capture(os.path.join(work, 'verify.tar'))
        assert result['sha256'] == p['sha256'], 'workspace changed during checkpoint'
    elif op == 'restore': restore()
    elif op == 'confirm':
        marker()
        path = os.path.join(root, '.ezil-hydrated.json')
        with workspace_file('.ezil-hydrated.json') as f: m = json.loads(f.read(CHUNK))
        m['checkpoint'] = p['generation']
        fd, tmp = tempfile.mkstemp(dir=root, prefix='.ezil-marker-')
        try:
            with os.fdopen(fd, 'w') as f: json.dump(m, f)
            os.replace(tmp, path)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
    elif op in ('adopt', 'cleanup-legacy'):
        stage = p['stage']
        assert stage == root + '.ezil-legacy-' + os.path.basename(work)[len('ezil-snapshot-'):], 'invalid legacy staging path'
        if op == 'adopt':
            assert not os.path.exists(root) or (os.path.isdir(root) and not os.listdir(root)), 'workspace is not empty'
            os.replace(stage, root)
        elif os.path.exists(stage): shutil.rmtree(stage)
    elif op == 'cleanup': shutil.rmtree(work, ignore_errors=True)
    else: raise ValueError('unknown operation')
except Exception as e:
    # No file contents, Git config, environment, or credentials in errors.
    print('workspace snapshot failed: ' + type(e).__name__, file=sys.stderr)
    sys.exit(1)
`;

export function snapshotCommand(params: Record<string, unknown>): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
  return `python3 -I -c ${quote(SNAPSHOT_SCRIPT)} ${quote(JSON.stringify(params))}`;
}
