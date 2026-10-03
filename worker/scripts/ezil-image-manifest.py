#!/usr/bin/env python3
"""Bake what this image ships under the system-layer roots (src/system-persist.ts).

Writes /etc/ezil-image-manifest.tsv (path, kind, size, mtime-seconds, link
target, mode, uid, gid) and /etc/ezil-image-id. The system
layer captures only entries that DIFFER from this manifest: on Cloudflare a
container's image files get fresh ctimes when first read, so ctime alone
cannot tell "the user changed it" from "something read it".

The image id decides whether a computer's saved system files may be restored
raw (same id) or only HOME plus an apt/npm replay (different id). It is the
installed PACKAGE SET, not the file manifest: every CI deploy rebuilds from a
fresh checkout, so file mtimes (and so the manifest) change on every deploy
even when no package did, and a manifest id would drop every user's installs
to the replay path on each release.
"""
import hashlib, os, stat, subprocess

ROOTS = ['/usr', '/etc', '/opt', '/var/lib/dpkg', '/var/lib/apt', '/root', '/home']
OUT = '/etc/ezil-image-manifest.tsv'
SKIP = {OUT, '/etc/ezil-image-id', '/etc/hostname', '/etc/hosts', '/etc/resolv.conf', '/etc/mtab'}

def esc(value):
    return value.replace('\\', '\\\\').replace('\t', '\\t').replace('\n', '\\n')

rows = []
for root in ROOTS:
    if not os.path.isdir(root) or os.path.islink(root):
        continue
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames + filenames:
            path = os.path.join(dirpath, name)
            if path in SKIP:
                continue
            try:
                s = os.lstat(path)
            except OSError:
                continue
            if stat.S_ISDIR(s.st_mode):
                kind, size, link = 'd', 0, ''
            elif stat.S_ISLNK(s.st_mode):
                kind, size, link = 'l', 0, os.readlink(path)
            elif stat.S_ISREG(s.st_mode):
                kind, size, link = 'f', s.st_size, ''
            else:
                continue
            rows.append('\t'.join([esc(path), kind, str(size), str(int(s.st_mtime)), esc(link),
                                    str(stat.S_IMODE(s.st_mode)), str(s.st_uid), str(s.st_gid)]))
rows.sort()
body = ('\n'.join(rows) + '\n').encode()
with open(OUT, 'wb') as f:
    f.write(body)
def package_set():
    parts = []
    for cmd in (['dpkg-query', '-W', '-f', '${Package}:${Architecture}=${Version}\\n'],
                ['npm', 'ls', '-g', '--depth=0', '--parseable', '--long'],
                ['node', '--version']):
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=300).stdout
        except (OSError, subprocess.SubprocessError):
            out = ''
        parts.append(' '.join(cmd[:1]) + '\n' + '\n'.join(sorted(out.splitlines())))
    try:
        with open('/etc/os-release') as f: parts.append(f.read())
    except OSError:
        pass
    return '\n'.join(parts).encode()

packages = package_set()
assert b'=' in packages, 'dpkg-query produced no package set'
with open('/etc/ezil-image-id', 'w') as f:
    f.write(hashlib.sha256(packages).hexdigest()[:32] + '\n')
print(f'ezil-image-manifest: {len(rows)} entries')
