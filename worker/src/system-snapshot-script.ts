/**
 * Container-side codec for the SYSTEM layer: what a user changed outside
 * /workspace — apt/dpkg installs, `npm -g`, files under /usr/local and /opt,
 * dotfiles and tool state in HOME. Cloudflare Containers have no persistent
 * disk, so these are captured as a delta and restored onto the next container.
 *
 * Delta = entries under ROOTS that DIFFER from the image's baked manifest
 * (/etc/ezil-image-manifest.tsv: kind/size/mtime/link) AND were touched after
 * the baseline marker (written once the desktop is up, so platform boot
 * writes are excluded) — plus everything restored earlier that still exists.
 * ctime alone is not enough: on Cloudflare, untouched image files get fresh
 * ctimes when first read. Image files the user deleted are recorded (inside
 * the archive, so the head stays small) and re-deleted on restore (same image
 * only). "Unchanged" is a LOGICAL fingerprint — paths, kinds, modes, owners,
 * content hashes, link targets, deletions — never the tar bytes, so platform
 * rewrites of identical content (mtime churn) do not re-upload the layer. Ownership,
 * full mode bits and absolute symlinks are kept (system files need them; the
 * snapshot only ever goes back into the same user's own container).
 *
 * Restore writes file by file (temp + rename in the same directory) and never
 * replaces a directory: processes run with their cwd inside these trees.
 * When the snapshot was taken on a different image (its package set changed),
 * everything is restored EXCEPT files owned by a package the new image ships
 * (the image's version wins), and dpkg's status database is merged stanza by
 * stanza (image packages from the image, the user's added packages from the
 * snapshot) — so pip, /opt, /usr/local and user apt packages survive an image
 * update instead of being dropped.
 *
 * Any write error fails the restore (nothing marks the container hydrated, so
 * capture stays refused and the next open retries). The hydrated marker records
 * the generation restored, and capture reports it so the Worker can refuse a
 * stale writer.
 */
/**
 * Which HOME workspace members a locked root's install rebuilds (PR195 r4241774149).
 * Embedded VERBATIM in worker/scripts/ezil-restore-deps.sh too, so the trees the
 * system layer leaves out are exactly the ones restore-deps rebuilds; a test pins
 * the two copies byte for byte. Needs os, json and fnmatch imported.
 */
export const WORKSPACE_PREDICATE_PY = String.raw`def lockfile_manager(directory, exists):
    # ezil-restore-deps.sh lockfile_pm's precedence: the manager that installs this dir.
    if exists(os.path.join(directory, 'bun.lock')) or exists(os.path.join(directory, 'bun.lockb')): return 'bun'
    if exists(os.path.join(directory, 'pnpm-lock.yaml')): return 'pnpm'
    if exists(os.path.join(directory, 'yarn.lock')): return 'yarn'
    if exists(os.path.join(directory, 'package-lock.json')): return 'npm'
    return None

def yaml_without_comment(line):
    if line.lstrip().startswith('#'): return ''
    at = line.find(' #')
    return line if at < 0 else line[:at]

def pnpm_workspace_packages(text):
    # The 'packages' list of pnpm-workspace.yaml, read without a YAML library: a block list
    # of plain or quoted scalars, or a one-line flow list. Any other shape (anchors, tags,
    # nested values, multi-line flow) returns None: claim no member rather than guess.
    def scalar(raw):
        raw = raw.strip()
        if raw[:1] in ('"', "'"):
            end = raw.find(raw[0], 1)
            return raw[1:end] if end > 1 and not raw[end + 1:].strip() else None
        return raw if raw and raw[0] not in '&*!|>[]{}@%,?:-' else None
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if not line.startswith('packages:'): continue
        rest = yaml_without_comment(line[len('packages:'):]).strip()
        if rest:
            if not (rest.startswith('[') and rest.endswith(']')): return None
            items = [scalar(x) for x in rest[1:-1].split(',') if x.strip()]
            return items if items and None not in items else None
        items = []
        for follow in lines[i + 1:]:
            body = yaml_without_comment(follow)
            if not body.strip(): continue
            if not follow[:1].isspace(): break
            stripped = body.strip()
            item = scalar(stripped[2:]) if stripped.startswith('- ') else None
            if item is None: return None
            items.append(item)
        return items or None
    return None

def workspace_patterns(root, manager, read):
    if manager == 'pnpm':
        text = read(os.path.join(root, 'pnpm-workspace.yaml'))
        return None if text is None else pnpm_workspace_packages(text)
    text = read(os.path.join(root, 'package.json'))
    try: manifest = json.loads(text) if text is not None else None
    except ValueError: return None
    workspaces = manifest.get('workspaces') if isinstance(manifest, dict) else None
    if isinstance(workspaces, dict) and manager in ('yarn', 'bun'): workspaces = workspaces.get('packages')
    return workspaces if isinstance(workspaces, list) else None

WORKSPACE_GLOB_UNSUPPORTED = set('{}[]()?+')

def glob_segments_match(parts, segments):
    if not parts: return not segments
    if parts[0] == '**':
        if len(parts) == 1: return len(segments) >= 1
        return any(glob_segments_match(parts[1:], segments[i:]) for i in range(len(segments) + 1))
    return bool(segments) and fnmatch.fnmatchcase(segments[0], parts[0]) and glob_segments_match(parts[1:], segments[1:])

def workspace_member(patterns, rel):
    # rel: the member dir relative to the root. Subset of the package managers' globs:
    # literal segments, '*' within one segment, '**' across segments (a trailing '**' needs
    # one), './' and '/' trims, and '!' exclusions (any match excludes). Any other syntax,
    # an absolute or parent path, matches nothing; an exclusion this reader cannot evaluate
    # claims no member at all.
    if not rel or not isinstance(patterns, list): return False
    segments = rel.split('/')
    included = False
    for raw in patterns:
        if not isinstance(raw, str): return False
        negate = raw.startswith('!')
        pattern = raw[1:] if negate else raw
        while pattern.startswith('./'): pattern = pattern[2:]
        pattern = pattern.rstrip('/')
        parts = pattern.split('/')
        if (not pattern or any(c in WORKSPACE_GLOB_UNSUPPORTED for c in pattern)
                or any(part in ('', '.', '..') for part in parts)):
            if negate: return False
            continue
        if glob_segments_match(parts, segments):
            if negate: return False
            included = True
    return included

def workspace_root_within(home, project, exists, read):
    # The root whose install builds this member's trees (project: the member's segments
    # below home): the nearest ancestor (home itself included) with package.json and a
    # supported lockfile, and only when that root's package manager declares the member.
    for depth in range(len(project) - 1, -1, -1):
        root = os.path.join(home, *project[:depth])
        manager = lockfile_manager(root, exists)
        if manager is None or not exists(os.path.join(root, 'package.json')): continue
        return root if workspace_member(workspace_patterns(root, manager, read), '/'.join(project[depth:])) else None
    return None
`;

export const SYSTEM_SNAPSHOT_SCRIPT = String.raw`
import os, sys, json, stat, tarfile, hashlib, shutil, subprocess, tempfile, time, fcntl, fnmatch

CHUNK = 1024 * 1024
LIMIT = 512 * CHUNK
MAX_ENTRIES = 100000
STATE = '/var/lib/ezil-system'
MANIFEST = STATE + '/manifest.json'
BASELINE = STATE + '/baseline'
CAPTURE_STARTED = STATE + '/capture-started'
# Written only once this container holds the computer's committed system layer
# (restored, or there was none). Capture refuses without it: a container whose
# restore failed must never commit its bare image over the user's installs.
HYDRATED = STATE + '/hydrated'
# Kind/mode/owner of every entry in the committed layer (restored, or the last
# committed capture). sys-dirty compares metadata-only changes against it.
COMMITTED_META = STATE + '/committed-meta.json'
DELETED_MEMBER = '.ezil-deleted.json'
DPKG_STATUS = '/var/lib/dpkg/status'
BASELINE_MISSING = STATE + '/baseline-missing.json'
IMAGE_MANIFEST = '/etc/ezil-image-manifest.tsv'
IMAGE_ID = '/etc/ezil-image-id'
MAX_DELETED = 20000
ROOTS = ['/usr', '/etc', '/opt', '/var/lib/dpkg', '/var/lib/apt', '/root', '/home']
# Caches, logs, per-boot platform files and anything credential-like the
# platform writes at boot. Persisting browser logins is a separate decision.
EXCLUDE = [
    STATE, '/var/lib/apt/lists', '/var/lib/dpkg/lock', '/var/lib/dpkg/lock-frontend', '/var/lib/apt/lists/lock',
    '/etc/hostname', '/etc/hosts', '/etc/resolv.conf', '/etc/mtab', '/etc/machine-id', '/etc/neko',
    '/root/.cache', '/root/.npm/_cacache', '/root/.npm/_logs', '/root/.bun/install/cache', '/root/.config/chromium',
    '/root/.local/share/code-server/logs', '/root/.local/share/code-server/coder-logs', '/root/.config/code-server',
    '/root/.pki', '/root/.local/share/pki', '/root/.Xauthority', '/root/.config/google-chrome/Crash Reports',
    '/var/lib/dpkg/status-old', '/var/lib/dpkg/available-old', '/var/lib/dpkg/triggers/Lock',
    '/usr/lib/locale/locale-archive',
]
# Regenerated by the platform on every boot (fontconfig's per-directory ids).
EXCLUDE_NAMES = ('.uuid',)
# Package-manager caches and stores in EVERY home (/root and /home/<user>): restore-deps
# repopulates them as that user, and they are regenerable. ~/.yarn/berry/cache stays
# captured on purpose: Yarn PnP projects run from it.
HOME_CACHES = ('.cache', '.npm/_cacache', '.npm/_logs', '.bun/install/cache', '.local/share/pnpm/store')
# A project's dependency and build trees under a home directory (~/app/node_modules, ~/app/.next):
# regenerated from the lockfile on boot ('ezil-restore-deps.sh --homes'), like /workspace projects.
# Such trees are large (a Next.js 16 node_modules is ~350 MiB / ~11k entries); with tools and build
# caches beside them they pass the snapshot limits and freeze every later capture (too_large). Excluded EXACTLY where that restore reaches: a project dir at most 3 levels below
# /root or /home/<user> (the home itself included), with no hidden or 'dist' dir on the way. Hidden
# tool dirs (~/.opencode, ~/.nvm, ~/.npm-global), /usr/local/lib/node_modules (npm -g) and deeper
# projects stay captured. The project must currently have package.json AND a supported
# lockfile, exactly like restore-deps; a global npm prefix or an unlocked project cannot
# be rebuilt. Use this same predicate for capture, restore and deletion detection.
# If the lockfile disappears later, the next capture keeps the trees again. Older
# snapshots keep their own manifest + lockfile for rebuilding; exclusion itself never
# records a tree as deleted, so removing a lockfile cannot cause a later restore to wipe it.
# A workspace MEMBER (~/repo/apps/web with no lockfile of its own) counts too when its
# nearest locked ancestor in the same home (~/repo: package.json + a supported lockfile)
# declares it: restore-deps installs that root, and the root's install builds the member's
# trees. Only the root's own package manager's declaration counts, chosen by the same
# lockfile precedence as restore-deps (bun, pnpm, yarn, npm): pnpm reads
# pnpm-workspace.yaml 'packages'; npm reads package.json "workspaces" as an array; Yarn and
# Bun also read {"packages": [...]}. Globs are a strict subset (workspace_member); anything
# this reader cannot be sure of claims no member, so that member's trees stay captured.
PROJECT_REGENERABLE = ('node_modules', '.next')
PROJECT_LOCKFILES = ('bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json')
PROJECT_MAX_DEPTH = 3
p = json.loads(sys.argv[1])
work = p['work']
assert os.path.dirname(work) == '/tmp' and os.path.basename(work).startswith('ezil-system-'), 'invalid staging path'

def split_home(path):
    if path.startswith('/root/'): return '/root', path[len('/root/'):].split('/')
    if path.startswith('/home/'):
        parts = path[len('/home/'):].split('/')
        return '/home/' + parts[0], parts[1:]
    return None

def regenerable_project_directory(path):
    found = split_home(path)
    if found is None: return None
    home, rel = found
    for i, seg in enumerate(rel):
        if seg in PROJECT_REGENERABLE:
            project = rel[:i]
            if len(project) > PROJECT_MAX_DEPTH or any(s.startswith('.') or s == 'dist' for s in project):
                return None
            return os.path.join(home, *project)
    return None

def read_small_text(path, limit=CHUNK):
    try:
        with open(path, 'rb') as f: data = f.read(limit + 1)
    except OSError: return None
    return None if len(data) > limit else data.decode('utf-8', 'replace')

${WORKSPACE_PREDICATE_PY}
def workspace_root_of(directory, exists, read):
    found = split_home(directory + '/')
    return None if found is None else workspace_root_within(found[0], [s for s in found[1] if s], exists, read)

def project_rebuildable(directory, exists, read):
    # package.json AND either its own lockfile (restore-deps installs it) or a workspace root
    # whose install builds it (restore-deps installs that root).
    if not exists(os.path.join(directory, 'package.json')): return False
    return (any(exists(os.path.join(directory, lock)) for lock in PROJECT_LOCKFILES)
            or workspace_root_of(directory, exists, read) is not None)

# Per process: one decision per project directory, not one per file in a captured tree.
REBUILDABLE = {}

def project_regenerable(path, restore_projects=None):
    directory = regenerable_project_directory(path)
    if directory is None: return False
    if restore_projects is not None: return directory in restore_projects
    if directory not in REBUILDABLE: REBUILDABLE[directory] = project_rebuildable(directory, os.path.isfile, read_small_text)
    return REBUILDABLE[directory]

def home_cache(path):
    if path.startswith('/root/'): rel = path[len('/root/'):]
    elif path.startswith('/home/'):
        parts = path[len('/home/'):].split('/', 1)
        if len(parts) < 2 or not parts[0]: return False
        rel = parts[1]
    else: return False
    return any(rel == c or rel.startswith(c + '/') for c in HOME_CACHES)

def excluded(path, restore_projects=None):
    # The image's own id and manifest belong to the image: capturing them (they get a
    # fresh ctime when read) would roll a newer image back to the old ones on restore.
    return (path == IMAGE_MANIFEST or path == IMAGE_ID or os.path.basename(path) in EXCLUDE_NAMES
            or any(path == e or path.startswith(e + '/') for e in EXCLUDE)
            or home_cache(path) or project_regenerable(path, restore_projects))

def meta_of(path, s):
    if stat.S_ISDIR(s.st_mode): kind = 'd'
    elif stat.S_ISLNK(s.st_mode): kind = 'l'
    else: kind = 'f'
    return [kind, None if kind == 'l' else stat.S_IMODE(s.st_mode), s.st_uid, s.st_gid]

def write_committed_meta(path, entries):
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(path + '.tmp', 'w') as f: json.dump({'version': 1, 'entries': entries}, f)
    os.replace(path + '.tmp', path)

def system_dirty():
    try: since = os.lstat(CAPTURE_STARTED).st_mtime_ns
    except FileNotFoundError: return True
    known = {}
    def metadata_changed(path, s):
        # chmod/chown bump ctime only. Count one exactly where the next capture would hold a
        # different entry than the committed layer. ctime alone never counts: on Cloudflare
        # an untouched image file gets a fresh ctime when it is first read. Loaded on the
        # first ctime-only candidate, so mtime hits and quiet walks never pay for it.
        if not known:
            try:
                with open(COMMITTED_META) as f: known['committed'] = json.load(f).get('entries')
            except (OSError, ValueError, AttributeError): known['committed'] = None
            known['previous'] = load_manifest()[0]
            try: known['baseline'] = os.lstat(BASELINE).st_mtime_ns
            except OSError: known['baseline'] = None
            try: known['image'] = load_image_manifest()
            except (OSError, ValueError): known['image'] = None
        committed = known['committed']
        if isinstance(committed, dict) and path in committed:
            # Back to the baked mode counts too: the layer still holds the user's.
            return committed[path] != meta_of(path, s)
        if path in ROOTS or known['image'] is None: return False  # capture never takes a root alone
        # Restored by a codec that kept no record: capture takes it, so compare with the image.
        if path in known['previous']: return differs(known['image'], path, s)
        # Elsewhere capture takes only entries changed after the baseline (not platform boot).
        if known['baseline'] is None or s.st_ctime_ns <= known['baseline']: return False
        return differs(known['image'], path, s)
    def newer(path):
        try: s = os.lstat(path)
        except OSError: return False  # An install can remove an entry during the probe.
        if not (stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode)): return False
        if s.st_mtime_ns > since: return True
        return s.st_ctime_ns > since and metadata_changed(path, s)
    for root in ROOTS:
        if excluded(root): continue
        if newer(root): return True
        if not os.path.isdir(root) or os.path.islink(root): continue
        for dirpath, dirnames, filenames in os.walk(root):
            if excluded(dirpath):
                dirnames[:] = []
                continue
            dirnames[:] = [d for d in dirnames if not excluded(os.path.join(dirpath, d))]
            for name in dirnames + filenames:
                path = os.path.join(dirpath, name)
                if not excluded(path) and newer(path): return True
    return False

def image_id():
    try:
        with open(IMAGE_ID) as f: return f.read().strip() or 'unknown'
    except OSError: return 'unknown'

def in_roots(path):
    return any(path == r or path.startswith(r + '/') for r in ROOTS)

def root_ancestor(path):
    # '/var' and '/var/lib' sit above the '/var/lib/dpkg' root: never captured or restored.
    return any(r.startswith(path.rstrip('/') + '/') for r in ROOTS)

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

def hold_package_locks(block):
    # The same locks apt/dpkg take. Held for a whole capture (no install can
    # start half-way through) or a whole restore. None = an install is running.
    fds = []
    for lock in ('/var/lib/dpkg/lock-frontend', '/var/lib/dpkg/lock'):
        try:
            fd = os.open(lock, os.O_RDWR | os.O_CREAT, 0o640)
        except OSError:
            continue
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX if block else fcntl.LOCK_EX | fcntl.LOCK_NB)
            fds.append(fd)
        except OSError:
            os.close(fd)
            for held in fds: os.close(held)
            return None
    return fds

def unesc(value):
    out, i = [], 0
    while i < len(value):
        c = value[i]
        if c == '\\' and i + 1 < len(value):
            n = value[i + 1]
            out.append({'t': '\t', 'n': '\n', '\\': '\\'}.get(n, n))
            i += 2
        else:
            out.append(c)
            i += 1
    return ''.join(out)

def load_image_manifest():
    image = {}
    with open(IMAGE_MANIFEST, encoding='utf-8', errors='surrogateescape') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) not in (5, 8): continue
            owner = tuple(int(x) for x in parts[5:8]) if len(parts) == 8 else None
            image[unesc(parts[0])] = (parts[1], int(parts[2]), int(parts[3]), unesc(parts[4]), owner)
    return image

def describe(path, s):
    if stat.S_ISDIR(s.st_mode): return ('d', 0, None, '')
    if stat.S_ISLNK(s.st_mode): return ('l', 0, None, os.readlink(path))
    return ('f', s.st_size, int(s.st_mtime), '')

def differs(image, path, s):
    known = image.get(path)
    if known is None: return True
    kind, size, mtime, link = describe(path, s)
    if kind != known[0]: return True
    # A chmod/chown of an image file is a user change too.
    if known[4] is not None and kind != 'l' and known[4] != (stat.S_IMODE(s.st_mode), s.st_uid, s.st_gid): return True
    if kind == 'd': return False
    if kind == 'l': return link != known[3]
    return size != known[1] or mtime != known[2]

def load_manifest():
    try:
        with open(MANIFEST) as f: m = json.load(f)
        return set(m.get('paths', [])), set(m.get('deleted', []))
    except (OSError, ValueError): return set(), set()

def missing_image_paths(image):
    return {p for p, v in image.items() if in_roots(p) and not excluded(p) and not os.path.lexists(p)}

def inventory(since_ns, image):
    previous, _ = load_manifest()
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
                if path in previous or (s.st_ctime_ns > since_ns and differs(image, path, s)):
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

def set_dirty_baseline():
    # Right after a restore (or a start with nothing committed) the disk IS the
    # committed state: changes from here on are what sys-dirty must report. Without
    # this every fresh container looks dirty and runs a full capture at boot.
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(CAPTURE_STARTED, 'a'): pass
    os.utime(CAPTURE_STARTED, None)

def mark_hydrated(generation):
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(HYDRATED + '.tmp', 'w') as f: json.dump({'generation': generation, 'at': time.time()}, f)
    os.replace(HYDRATED + '.tmp', HYDRATED)

def hydrated_generation():
    try:
        with open(HYDRATED) as f: return json.load(f).get('generation')
    except (OSError, ValueError, AttributeError): return 'unknown'

class HashingReader:
    def __init__(self, f):
        self.f, self.h = f, hashlib.sha256()
    def read(self, n=-1):
        data = self.f.read(n)
        self.h.update(data)
        return data

def capture(path, mark_started=True):
    if not os.path.exists(HYDRATED):
        return {'skipped': 'not_restored'}
    if not os.path.exists(BASELINE):
        return {'skipped': 'no_baseline'}
    if not os.path.exists(IMAGE_MANIFEST):
        return {'skipped': 'no_manifest'}
    locks = hold_package_locks(block=False)
    if locks is None:
        return {'skipped': 'busy'}
    if mark_started:
        # The start of this walk becomes the dirty baseline ONLY once the Worker
        # has committed it (op sys-committed): a capture that fails, is refused
        # or loses the R2 race must leave its changes dirty. Kept across retries
        # so writes during either walk stay dirty afterwards.
        os.makedirs(STATE, mode=0o700, exist_ok=True)
        with open(CAPTURE_STARTED + '.pending', 'a'): pass
        os.utime(CAPTURE_STARTED + '.pending', None)
    since = os.lstat(BASELINE).st_mtime_ns
    image = load_image_manifest()
    picked = inventory(since, image)
    names = sorted(picked)
    try:
        with open(BASELINE_MISSING) as f: missing_at_baseline = set(json.load(f))
    except (OSError, ValueError): missing_at_baseline = set()
    _, previously_deleted = load_manifest()
    deleted = sorted((missing_image_paths(image) - missing_at_baseline) | {p for p in previously_deleted if not excluded(p) and not os.path.lexists(p)})
    assert len(deleted) <= MAX_DELETED, 'snapshot entry limit'
    logical = hashlib.sha256()
    entries = 0
    record = {}
    with tarfile.open(path, 'w', format=tarfile.PAX_FORMAT) as tar:
        for name in names:
            s = picked[name]
            info = tarfile.TarInfo(name.lstrip('/'))
            info.mode = stat.S_IMODE(s.st_mode)
            info.uid, info.gid, info.mtime = s.st_uid, s.st_gid, int(s.st_mtime)
            if stat.S_ISDIR(s.st_mode):
                info.type = tarfile.DIRTYPE
                tar.addfile(info)
                fingerprint = 'd'
            elif stat.S_ISLNK(s.st_mode):
                info.type = tarfile.SYMTYPE
                try:
                    info.linkname = os.readlink(name)
                except FileNotFoundError:
                    continue        # removed since the walk: absence is the state to commit
                tar.addfile(info)
                fingerprint = 'l:' + info.linkname
            else:
                # Removed since the walk (temp files, journals): absence is the state to commit.
                # Any OTHER read error fails closed: the file would silently drop out of the layer.
                try:
                    f = open(name, 'rb')
                except FileNotFoundError:
                    continue
                with f:
                    st = os.fstat(f.fileno())
                    if (st.st_ino, st.st_size, st.st_mtime_ns) != (s.st_ino, s.st_size, s.st_mtime_ns):
                        raise AssertionError('system changed during capture')
                    info.size = st.st_size
                    assert tar.offset + info.size <= LIMIT, 'snapshot byte limit'
                    reader = HashingReader(f)
                    tar.addfile(info, reader)
                    fingerprint = 'f:' + reader.h.hexdigest()
            entries += 1
            record[name] = meta_of(name, s)
            logical.update(json.dumps([name, info.mode, info.uid, info.gid, fingerprint]).encode() + b'\n')
        data = json.dumps(deleted).encode()
        info = tarfile.TarInfo(DELETED_MEMBER)
        info.size, info.mode = len(data), 0o600
        import io
        tar.addfile(info, io.BytesIO(data))
        logical.update(b'deleted\n' + data)
    for fd in locks: os.close(fd)
    assert os.path.getsize(path) <= LIMIT, 'snapshot byte limit'
    # What this capture archived. It becomes the committed record only with sys-committed.
    write_committed_meta(COMMITTED_META + '.pending', record)
    digest, chunks = hashlib.sha256(), []
    with open(path, 'rb') as f:
        while True:
            data = f.read(CHUNK)
            if not data: break
            digest.update(data)
            chunks.append({'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    return {'sha256': logical.hexdigest(), 'archiveSha256': digest.hexdigest(), 'chunks': chunks, 'entries': entries,
            'imageId': image_id(), 'replay': replay_lists(), 'deletedCount': len(deleted),
            'expectedGeneration': hydrated_generation()}

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

def dpkg_stanzas(text):
    out = []
    for block in text.split('\n\n'):
        block = block.strip('\n')
        if not block: continue
        fields = {}
        for line in block.split('\n'):
            if line[:1] not in (' ', '\t') and ':' in line:
                k, v = line.split(':', 1)
                fields[k] = v.strip()
        out.append(((fields.get('Package', ''), fields.get('Architecture', '')), block))
    return out

def image_packages():
    # What the NEW image's dpkg ships: package names and every path they own.
    names, owned = set(), set()
    try:
        with open(DPKG_STATUS, encoding='utf-8', errors='surrogateescape') as f:
            for (name, _), _ in dpkg_stanzas(f.read()): names.add(name)
    except OSError:
        pass
    info = '/var/lib/dpkg/info'
    for entry in os.listdir(info) if os.path.isdir(info) else []:
        if not entry.endswith('.list') or entry.rsplit('.', 1)[0].split(':')[0] not in names: continue
        try:
            with open(os.path.join(info, entry), encoding='utf-8', errors='surrogateescape') as f:
                owned.update(l.rstrip('\n') for l in f if l.strip())
        except OSError:
            pass
    return names, owned

def merged_dpkg_status(snapshot_text):
    # Image packages as the image has them; the user's added packages from the snapshot.
    with open(DPKG_STATUS, encoding='utf-8', errors='surrogateescape') as f: image = dpkg_stanzas(f.read())
    keys = {k for k, _ in image}
    blocks = [b for _, b in image] + [b for k, b in dpkg_stanzas(snapshot_text) if k not in keys and k[0]]
    return ('\n\n'.join(blocks) + '\n').encode('utf-8', 'surrogateescape')

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
    assert digest.hexdigest() == p['snapshot'].get('archiveSha256', p['snapshot']['sha256']), 'corrupt archive'
    same_image = p['snapshot'].get('imageId') == image_id() and image_id() != 'unknown'
    image_names, image_owned = (set(), set()) if same_image else image_packages()
    locks = hold_package_locks(block=True) or []
    restored, skipped, conflicts, times = [], 0, 0, []
    deleted_list = list(p['snapshot'].get('deleted') or [])
    with tarfile.open(archive, 'r:') as tar:
        members = []
        for m in tar:
            if m.name == DELETED_MEMBER and m.isfile():
                with tar.extractfile(m) as f: deleted_list += json.loads(f.read(64 * CHUNK))
            elif m.name and m.name != '.':
                members.append(m)
        members.sort(key=lambda m: (0 if m.isdir() else 1, m.name))
        # Old snapshots include dependency/build trees, often ordered before their
        # package files. Decide exclusions before any extraction, from the union
        # of regular archive files and files already on disk (deltas can split them).
        archive_files, projects = {}, set()
        for m in members:
            assert not any(part == '..' for part in m.name.split('/')), 'unsafe archive path'
            path = '/' + os.path.normpath(m.name).lstrip('/')
            if m.isfile(): archive_files[path] = m
            directory = regenerable_project_directory(path)
            if directory is not None: projects.add(directory)
        def project_file_exists(path):
            return path in archive_files or os.path.isfile(path)
        def project_file_text(path):
            # The archive's version is what this restore writes, so it decides.
            m = archive_files.get(path)
            if m is None: return read_small_text(path)
            if m.size > CHUNK: return None
            with tar.extractfile(m) as f: return f.read().decode('utf-8', 'replace')
        restore_projects = {directory for directory in projects
                            if project_rebuildable(directory, project_file_exists, project_file_text)}
        for m in members:
            path = '/' + os.path.normpath(m.name).lstrip('/')
            assert not any(part == '..' for part in m.name.split('/')), 'unsafe archive path'
            if m.isdir() and root_ancestor(path): continue
            assert in_roots(path), 'path outside system roots'
            if excluded(path, restore_projects): continue
            if not same_image and m.isfile() and path == DPKG_STATUS:
                with tar.extractfile(m) as src:
                    merged = merged_dpkg_status(src.read().decode('utf-8', 'surrogateescape'))
                import io
                member = tarfile.TarInfo(m.name); member.uid, member.gid, member.mode, member.mtime = m.uid, m.gid, m.mode, time.time()
                write_file_atomically(member, io.BytesIO(merged), path)
                restored.append(path)
                continue
            # /etc stays the user's: an edited config file is the user's intent.
            if not same_image and not m.isdir() and ((path in image_owned and not path.startswith('/etc/')) or (
                    path.startswith('/var/lib/dpkg/info/') and os.path.basename(path).rsplit('.', 1)[0].split(':')[0] in image_names)):
                skipped += 1        # the new image's own version of a package file wins
                continue
            # A type clash with the image (a directory where the user had a file) is
            # permanent and counted; any other write error fails the whole restore.
            if m.isdir():
                if os.path.lexists(path) and not os.path.isdir(path):
                    conflicts += 1
                    continue
                os.makedirs(path, exist_ok=True)
                os.chown(path, m.uid, m.gid, follow_symlinks=False)
                os.chmod(path, m.mode)
                times.append((path, m.mtime))
            elif m.issym():
                if os.path.isdir(path) and not os.path.islink(path):
                    conflicts += 1
                    continue
                os.makedirs(os.path.dirname(path), exist_ok=True)
                if os.path.lexists(path): os.unlink(path)
                os.symlink(m.linkname, path)
                os.chown(path, m.uid, m.gid, follow_symlinks=False)
                times.append((path, m.mtime))
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
    deleted = []
    # Deletions of image files only make sense against the image they were made on.
    if same_image:
        for path in sorted(deleted_list, key=lambda x: -x.count('/')):
            if not in_roots(path) or excluded(path): continue
            if os.path.islink(path) or os.path.isfile(path):
                os.unlink(path); deleted.append(path)
            elif os.path.isdir(path) and not os.listdir(path):
                os.rmdir(path); deleted.append(path)
            elif not os.path.lexists(path):
                deleted.append(path)
    # Last, deepest first: writing a child bumps its directory's mtime.
    for path, mtime in sorted(times, key=lambda t: -t[0].count('/')):
        try: os.utime(path, (mtime, mtime), follow_symlinks=False)
        except OSError: pass
    for fd in locks: os.close(fd)
    record = {}
    for path in restored:
        try: record[path] = meta_of(path, os.lstat(path))
        except OSError: pass
    write_committed_meta(COMMITTED_META, record)
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(MANIFEST + '.tmp', 'w') as f:
        json.dump({'paths': restored, 'deleted': deleted, 'imageId': image_id(), 'snapshotImageId': p['snapshot'].get('imageId'), 'restoredAt': time.time()}, f)
    os.replace(MANIFEST + '.tmp', MANIFEST)
    mark_hydrated(p['snapshot'].get('generation'))
    set_dirty_baseline()
    print(json.dumps({'restored': len(restored), 'skippedImageScoped': skipped, 'conflicts': conflicts, 'sameImage': same_image}))

def promote_committed():
    # The committed capture's start becomes the dirty baseline, and what it archived
    # becomes the committed record.
    try: os.replace(CAPTURE_STARTED + '.pending', CAPTURE_STARTED); promoted = True
    except FileNotFoundError: promoted = False
    try: os.replace(COMMITTED_META + '.pending', COMMITTED_META)
    except FileNotFoundError: pass
    return promoted

def baseline():
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    if os.path.exists(BASELINE) and not p.get('force'):
        print(json.dumps({'baseline': 'kept'}))
        return
    missing = []
    try:
        if os.path.exists(IMAGE_MANIFEST):
            missing = sorted(missing_image_paths(load_image_manifest()))
    except Exception:
        missing = []
    with open(BASELINE_MISSING, 'w') as f: json.dump(missing, f)
    with open(BASELINE, 'w') as f: f.write(str(time.time()))
    print(json.dumps({'baseline': 'set', 'missingAtBaseline': len(missing)}))

try:
    op = p['op']
    if op in ('sys-capture', 'sys-dirty'):
        # Background saves must never compete with the desktop, Code or the user's
        # own processes: lowest CPU priority and the idle I/O class (best effort).
        try: os.nice(15)
        except OSError: pass
        try:
            import ctypes, platform
            nr = {'x86_64': 251, 'aarch64': 30}.get(platform.machine())
            if nr: ctypes.CDLL(None, use_errno=True).syscall(nr, 1, 0, 3 << 13)  # IOPRIO_WHO_PROCESS, self, IDLE
        except Exception: pass
    if op == 'sys-capture':
        os.mkdir(work, 0o700)
        # A file rewritten mid-capture: one fresh attempt before the flush reports failure.
        for attempt in (1, 2):
            try:
                result = capture(os.path.join(work, 'archive.tar'), mark_started=attempt == 1)
                break
            except AssertionError as e:
                if str(e) != 'system changed during capture' or attempt == 2: raise
        if 'chunks' in result:
            with open(os.path.join(work, 'archive.tar'), 'rb') as f:
                for i in range(len(result['chunks'])):
                    with open(os.path.join(work, str(i)), 'xb') as out: out.write(f.read(CHUNK))
        print(json.dumps(result))
    elif op == 'sys-dirty': print(json.dumps({'dirty': system_dirty()}))
    elif op == 'sys-committed': print(json.dumps({'committed': promote_committed()}))
    elif op == 'sys-restore': restore()
    elif op == 'sys-baseline': baseline()
    elif op == 'sys-hydrated':
        mark_hydrated(p.get('generation'))
        if p.get('baseline') is True: set_dirty_baseline()
        print(json.dumps({'hydrated': True}))
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
