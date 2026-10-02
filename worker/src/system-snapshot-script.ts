/**
 * Container-side codec for the SYSTEM layer: what a user changed outside
 * /workspace — apt/dpkg installs, `npm -g`, files under /usr/local and /opt,
 * dotfiles and tool state in HOME. Cloudflare Containers have no persistent
 * disk, so these are captured as a delta and restored onto the next container.
 *
 * Delta = entries under ROOTS whose ctime is newer than the baseline marker
 * (written once the desktop is up, so platform boot writes are not captured),
 * plus everything this layer restored earlier that still exists. Ownership,
 * full mode bits and absolute symlinks are kept (system files need them; the
 * snapshot only ever goes back into the same user's own container).
 *
 * Restore writes file by file (temp + rename in the same directory) and never
 * replaces a directory: processes run with their cwd inside these trees.
 * When the snapshot was taken on a different image, image-scoped roots are
 * NOT restored raw (stale files could shadow the new image's libraries);
 * HOME is, and the recorded apt/npm-global lists are replayed instead.
 */
export const SYSTEM_SNAPSHOT_SCRIPT = String.raw`
import os, sys, json, stat, tarfile, hashlib, shutil, subprocess, tempfile, time, fcntl

CHUNK = 1024 * 1024
LIMIT = 512 * CHUNK
MAX_ENTRIES = 100000
STATE = '/var/lib/ezil-system'
MANIFEST = STATE + '/manifest.json'
BASELINE = STATE + '/baseline'
ROOTS = ['/usr', '/etc', '/opt', '/var/lib/dpkg', '/var/lib/apt', '/root', '/home']
IMAGE_SCOPED = ('/usr', '/etc', '/opt', '/var/lib/dpkg', '/var/lib/apt')
# Caches, logs, per-boot platform files and anything credential-like the
# platform writes at boot. Persisting browser logins is a separate decision.
EXCLUDE = [
    STATE, '/var/lib/apt/lists', '/var/lib/dpkg/lock', '/var/lib/dpkg/lock-frontend', '/var/lib/apt/lists/lock',
    '/etc/hostname', '/etc/hosts', '/etc/resolv.conf', '/etc/mtab', '/etc/machine-id', '/etc/neko',
    '/root/.cache', '/root/.npm/_cacache', '/root/.npm/_logs', '/root/.bun/install/cache', '/root/.config/chromium',
    '/root/.local/share/code-server/logs', '/root/.config/code-server', '/root/.pki', '/root/.Xauthority',
    '/usr/lib/locale/locale-archive',
]
p = json.loads(sys.argv[1])
work = p['work']
assert os.path.dirname(work) == '/tmp' and os.path.basename(work).startswith('ezil-system-'), 'invalid staging path'

def excluded(path):
    return any(path == e or path.startswith(e + '/') for e in EXCLUDE)

def image_id():
    try:
        with open('/etc/ezil-image-id') as f: return f.read().strip() or 'unknown'
    except OSError: return 'unknown'

def in_roots(path):
    return any(path == r or path.startswith(r + '/') for r in ROOTS)

def root_ancestor(path):
    # '/var' and '/var/lib' sit above the '/var/lib/dpkg' root: never captured or restored.
    return any(r.startswith(path.rstrip('/') + '/') for r in ROOTS)

def image_scoped(path):
    return any(path == r or path.startswith(r + '/') for r in IMAGE_SCOPED)

def read_lines(path):
    try:
        with open(path) as f: return sorted({l.strip() for l in f if l.strip()})
    except OSError: return []

def replay_lists():
    # What the user installed on top of the image, as package names.
    apt = []
    try:
        r = subprocess.run(['apt-mark', 'showmanual'], capture_output=True, text=True, timeout=60)
        if r.returncode == 0:
            base = set(read_lines('/etc/ezil-image-apt-manual.txt'))
            apt = sorted({l.strip() for l in r.stdout.splitlines() if l.strip()} - base)
    except Exception: pass
    npm = []
    try:
        base = set(read_lines('/etc/ezil-image-npm-global.txt'))
        root = '/usr/local/lib/node_modules'
        names = []
        for n in sorted(os.listdir(root)):
            if n.startswith('@'):
                names += [n + '/' + m for m in sorted(os.listdir(os.path.join(root, n)))]
            elif not n.startswith('.'):
                names.append(n)
        npm = [n for n in names if n not in base]
    except Exception: pass
    return {'apt': apt, 'npm': npm}

def package_manager_busy():
    for lock in ('/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock'):
        try:
            fd = os.open(lock, os.O_RDWR)
        except OSError:
            continue
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.lockf(fd, fcntl.LOCK_UN)
        except OSError:
            return True
        finally:
            os.close(fd)
    return False

def load_manifest():
    try:
        with open(MANIFEST) as f: m = json.load(f)
        return set(m.get('paths', []))
    except (OSError, ValueError): return set()

def inventory(since_ns):
    previous = load_manifest()
    picked = {}
    for root in ROOTS:
        if not os.path.isdir(root) or os.path.islink(root): continue
        for dirpath, dirnames, filenames in os.walk(root):
            if excluded(dirpath):
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if not excluded(os.path.join(dirpath, d))]
            for name in dirnames + filenames:
                path = os.path.join(dirpath, name)
                if excluded(path): continue
                try: s = os.lstat(path)
                except OSError: continue
                if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode)): continue
                if s.st_ctime_ns > since_ns or path in previous:
                    picked[path] = s
                    assert len(picked) <= MAX_ENTRIES, 'snapshot entry limit'
    # Parent directories of every picked entry, so modes/owners come back too.
    for path in list(picked):
        parent = os.path.dirname(path)
        while parent not in ('/', '') and parent not in picked and in_roots(parent):
            try: picked[parent] = os.lstat(parent)
            except OSError: break
            parent = os.path.dirname(parent)
    return picked

def capture(path):
    if not os.path.exists(BASELINE):
        return {'skipped': 'no_baseline'}
    if package_manager_busy():
        return {'skipped': 'busy'}
    since = os.lstat(BASELINE).st_mtime_ns
    picked = inventory(since)
    names = sorted(picked)
    with tarfile.open(path, 'w', format=tarfile.PAX_FORMAT) as tar:
        for name in names:
            s = picked[name]
            info = tarfile.TarInfo(name.lstrip('/'))
            info.mode = stat.S_IMODE(s.st_mode)
            info.uid, info.gid, info.mtime = s.st_uid, s.st_gid, int(s.st_mtime)
            if stat.S_ISDIR(s.st_mode):
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
            elif stat.S_ISLNK(s.st_mode):
                info.type = tarfile.SYMTYPE
                info.linkname = os.readlink(name)
                tar.addfile(info)
            else:
                try:
                    f = open(name, 'rb')
                except OSError:
                    continue
                with f:
                    st = os.fstat(f.fileno())
                    if (st.st_ino, st.st_size, st.st_mtime_ns) != (s.st_ino, s.st_size, s.st_mtime_ns):
                        raise AssertionError('system changed during capture')
                    info.size = st.st_size
                    assert tar.offset + info.size <= LIMIT, 'snapshot byte limit'
                    tar.addfile(info, f)
    assert os.path.getsize(path) <= LIMIT, 'snapshot byte limit'
    digest, chunks = hashlib.sha256(), []
    with open(path, 'rb') as f:
        while True:
            data = f.read(CHUNK)
            if not data: break
            digest.update(data)
            chunks.append({'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return {'sha256': digest.hexdigest(), 'chunks': chunks, 'entries': len(names), 'imageId': image_id(), 'replay': replay_lists()}

def write_file_atomically(member, src, path):
    parent = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=parent, prefix='.ezil-sys-')
    try:
        with os.fdopen(fd, 'wb') as out:
            shutil.copyfileobj(src, out, CHUNK)
            os.fchown(out.fileno(), member.uid, member.gid)
            os.fchmod(out.fileno(), member.mode)
        os.utime(tmp, (member.mtime, member.mtime))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)

def restore():
    if os.path.exists(MANIFEST):
        print(json.dumps({'skipped': 'already_restored'}))
        return
    archive = os.path.join(work, 'archive.tar')
    digest = hashlib.sha256()
    with open(archive, 'wb') as out:
        for i, chunk in enumerate(p['snapshot']['chunks']):
            with open(os.path.join(work, str(i)), 'rb') as f: data = f.read(CHUNK + 1)
            assert len(data) == chunk['size'] and hashlib.sha256(data).hexdigest() == chunk['sha256'], 'corrupt chunk'
            out.write(data)
            digest.update(data)
    assert digest.hexdigest() == p['snapshot']['sha256'], 'corrupt archive'
    same_image = p['snapshot'].get('imageId') == image_id() and image_id() != 'unknown'
    restored, skipped, conflicts = [], 0, 0
    with tarfile.open(archive, 'r:') as tar:
        members = [m for m in tar if m.name and m.name != '.']
        members.sort(key=lambda m: (0 if m.isdir() else 1, m.name))
        for m in members:
            path = '/' + os.path.normpath(m.name).lstrip('/')
            assert not any(part == '..' for part in m.name.split('/')), 'unsafe archive path'
            if m.isdir() and root_ancestor(path): continue
            assert in_roots(path), 'path outside system roots'
            if excluded(path): continue
            if image_scoped(path) and not same_image:
                skipped += 1
                continue
            try:
                if m.isdir():
                    if os.path.lexists(path) and not os.path.isdir(path):
                        conflicts += 1
                        continue
                    os.makedirs(path, exist_ok=True)
                    os.chown(path, m.uid, m.gid, follow_symlinks=False)
                    os.chmod(path, m.mode)
                elif m.issym():
                    if os.path.isdir(path) and not os.path.islink(path):
                        conflicts += 1
                        continue
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    if os.path.lexists(path): os.unlink(path)
                    os.symlink(m.linkname, path)
                    os.chown(path, m.uid, m.gid, follow_symlinks=False)
                elif m.isfile():
                    if os.path.isdir(path) and not os.path.islink(path):
                        conflicts += 1
                        continue
                    os.makedirs(os.path.dirname(path), exist_ok=True)
                    with tar.extractfile(m) as src:
                        write_file_atomically(m, src, path)
                else:
                    continue
                restored.append(path)
            except OSError:
                conflicts += 1
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(MANIFEST + '.tmp', 'w') as f:
        json.dump({'paths': restored, 'imageId': image_id(), 'snapshotImageId': p['snapshot'].get('imageId'), 'restoredAt': time.time()}, f)
    os.replace(MANIFEST + '.tmp', MANIFEST)
    replay = p['snapshot'].get('replay') or {}
    print(json.dumps({'restored': len(restored), 'skippedImageScoped': skipped, 'conflicts': conflicts,
                      'sameImage': same_image, 'replayPending': (not same_image) and bool(replay.get('apt') or replay.get('npm'))}))

def replay():
    # After an image change: reinstall what the user had added, by name.
    lists = p.get('replay') or {}
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive')
    apt = [n for n in lists.get('apt', []) if n and not n.startswith('-')]
    npm = [n for n in lists.get('npm', []) if n and not n.startswith('-')]
    results = {}
    if apt:
        subprocess.run(['apt-get', 'update', '-qq'], env=env, timeout=600)
        results['apt'] = subprocess.run(['apt-get', 'install', '-y', '-qq', '--no-install-recommends'] + apt, env=env, timeout=1800).returncode
    if npm:
        results['npm'] = subprocess.run(['npm', 'install', '-g', '--no-audit', '--no-fund'] + npm, env=env, timeout=1800).returncode
    print(json.dumps(results))

def baseline():
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    if os.path.exists(BASELINE) and not p.get('force'):
        print(json.dumps({'baseline': 'kept'}))
        return
    with open(BASELINE, 'w') as f: f.write(str(time.time()))
    print(json.dumps({'baseline': 'set'}))

try:
    op = p['op']
    if op == 'sys-capture':
        os.mkdir(work, 0o700)
        result = capture(os.path.join(work, 'archive.tar'))
        if 'chunks' in result:
            with open(os.path.join(work, 'archive.tar'), 'rb') as f:
                for i in range(len(result['chunks'])):
                    with open(os.path.join(work, str(i)), 'xb') as out: out.write(f.read(CHUNK))
        print(json.dumps(result))
    elif op == 'sys-restore': restore()
    elif op == 'sys-replay': replay()
    elif op == 'sys-baseline': baseline()
    elif op == 'sys-cleanup': shutil.rmtree(work, ignore_errors=True)
    else: raise ValueError('unknown operation')
except AssertionError as e:
    if p.get('op') == 'sys-capture' and str(e) in ('snapshot byte limit', 'snapshot entry limit'):
        print('system snapshot too large', file=sys.stderr)
        sys.exit(3)
    print('system snapshot failed: ' + str(e)[:80], file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print('system snapshot failed: ' + type(e).__name__, file=sys.stderr)
    sys.exit(1)
`;

export function systemSnapshotCommand(params: Record<string, unknown>): string {
  const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
  return `python3 -I -c ${quote(SYSTEM_SNAPSHOT_SCRIPT)} ${quote(JSON.stringify(params))}`;
}
