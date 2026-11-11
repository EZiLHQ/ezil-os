#!/usr/bin/env python3
"""CI-only Noble apt failover. Keep archive signatures, source fields and test commands."""
from __future__ import annotations
import datetime as dt
import email.utils
import ipaddress
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile

SOURCES = Path('/etc/apt/sources.list.d/ubuntu.sources')
MIRROR_LIST = Path('/etc/apt/apt-mirrors.txt')
KEYRING = Path('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
MIRROR = 'https://mirrors.edge.kernel.org/ubuntu/'
LIST_URI = 'mirror+file:/etc/apt/apt-mirrors.txt'
HOSTS = ('azure.archive.ubuntu.com', 'archive.ubuntu.com', 'security.ubuntu.com')
URIS = {scheme + '://' + host + '/ubuntu' + slash for scheme in ('http', 'https') for host in HOSTS for slash in ('', '/')}
POCKETS = {'noble', 'noble-updates', 'noble-security', 'noble-backports'}
FIELDS = {'Types', 'URIs', 'Suites', 'Components', 'Signed-By', 'Architectures',
          'Architectures-Add', 'Architectures-Remove', 'Languages', 'Targets',
          'PDiffs', 'By-Hash', 'Check-Valid-Until', 'Enabled'}
LIMIT = 1048576

class Refused(Exception):
    pass

def need(condition, message):
    if not condition:
        raise Refused(message)

def parse_sources(raw: bytes, mirrors: bytes | None):
    need(len(raw) <= 65536 and b'\r' not in raw and b'\x00' not in raw, 'source_format')
    text = raw.decode('ascii')
    replacements, suites, components, hosts = [], set(), set(), set()
    offset = 0
    for block in re.split(r'(\n[ \t]*\n)', text):
        if not block.strip() or re.fullmatch(r'\n[ \t]*\n', block):
            offset += len(block)
            continue
        fields = {}
        for line in block.splitlines(keepends=True):
            if line.startswith('#') or not line.strip():
                continue
            match = re.fullmatch(r'([A-Za-z][A-Za-z-]*):([ \t]+)([^\n]*)(\n?)', line)
            need(match is not None, 'source_format')
            key, value = match[1], match[3]
            need(key in FIELDS and key not in fields and value.strip(), 'source_field')
            fields[key] = value.strip()
        if not fields:
            offset += len(block)
            continue
        need({'Types', 'URIs', 'Suites', 'Components', 'Signed-By'} <= fields.keys(), 'source_fields')
        need(fields['Signed-By'] == str(KEYRING), 'source_keyring')
        need(set(fields['Types'].split()) <= {'deb', 'deb-src'}, 'source_types')
        need(fields.get('Enabled', 'yes') == 'yes' and fields.get('Check-Valid-Until', 'yes') == 'yes', 'source_options')
        pocket = set(fields['Suites'].split())
        need(pocket and pocket <= POCKETS, 'source_pocket')
        part = set(fields['Components'].split())
        need(part and part <= {'main', 'restricted', 'universe', 'multiverse'}, 'source_components')
        suites |= pocket
        components |= part
        tokens = fields['URIs'].split()
        need(tokens and all(token in URIS or token == LIST_URI for token in tokens), 'source_uri')
        for token in tokens:
            if token == LIST_URI:
                need(mirrors is not None and len(mirrors) <= 4096, 'mirror_list')
                lines = mirrors.decode('ascii').splitlines()
                expected = [
                    'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1',
                    'https://archive.ubuntu.com/ubuntu/\tpriority:2',
                    'https://security.ubuntu.com/ubuntu/\tpriority:3',
                ]
                need(lines == expected, 'mirror_list')
                hosts.update(HOSTS)
            else:
                hosts.add(token.split('/')[2])
        for m in re.finditer(r'^URIs:[ \t]+([^\n]+)', block, re.M):
            before = m[1]
            after = re.sub(r'\S+', MIRROR, before)
            replacements.append((offset + m.start(1), offset + m.end(1), after))
        offset += len(block)
    need({'noble', 'noble-updates', 'noble-security'} <= suites and replacements, 'source_pockets')
    return text, replacements, suites, components, hosts

def release_fields(payload: bytes):
    need(len(payload) <= LIMIT and b'\x00' not in payload, 'release_size')
    fields = {}
    for line in payload.decode('ascii').splitlines():
        if line.startswith((' ', '\t')) or not line:
            continue
        match = re.fullmatch(r'([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)', line)
        need(match is not None and match[1] not in fields, 'release_format')
        fields[match[1]] = match[2]
    return fields

def validate_release(payload: bytes, pocket: str, components: set[str], now: dt.datetime):
    f = release_fields(payload)
    need(f.get('Origin') == 'Ubuntu' and f.get('Label') == 'Ubuntu'
         and f.get('Codename') == 'noble' and f.get('Suite') == pocket, 'release_identity')
    need('amd64' in f.get('Architectures', '').split()
         and components <= set(f.get('Components', '').split()), 'release_content')
    def timestamp(key):
        value = email.utils.parsedate_to_datetime(f.get(key, ''))
        need(value.tzinfo is not None and value.utcoffset() == dt.timedelta(0), 'release_time')
        return value
    date = timestamp('Date')
    need(date <= now + dt.timedelta(minutes=5), 'release_future')
    if pocket != 'noble':
        need(now - date <= dt.timedelta(days=7), 'release_stale')
    if 'Valid-Until' in f:
        until = timestamp('Valid-Until')
        need(until > now and until >= date, 'release_expired')

def recover(raw, mirrors, resolve, fetch, verify, now):
    text, replacements, suites, components, hosts = parse_sources(raw, mirrors)
    if all(resolve(host) for host in sorted(hosts)):
        return None
    for pocket in sorted(suites):
        signed = fetch(MIRROR + 'dists/' + pocket + '/InRelease')
        need(0 < len(signed) <= LIMIT, 'release_size')
        validate_release(verify(signed), pocket, components, now)
    for start, end, value in reversed(replacements):
        text = text[:start] + value + text[end:]
    return text.encode('ascii')

def resolve(host):
    try:
        r = subprocess.run(['getent', 'ahostsv4', host], capture_output=True, timeout=5, check=False)
        return r.returncode == 0 and any(ipaddress.ip_address(line.split()[0].decode()).version == 4 for line in r.stdout.splitlines())
    except (subprocess.TimeoutExpired, ValueError):
        return False

def fetch(url):
    need(url.startswith(MIRROR + 'dists/'), 'release_url')
    r = subprocess.run(['curl', '--disable', '--fail', '--silent', '--show-error', '--location',
        '--proto', '=https', '--proto-redir', '=https', '--max-time', '15',
        '--max-filesize', str(LIMIT), url], capture_output=True, timeout=17, check=False)
    need(r.returncode == 0 and len(r.stdout) <= LIMIT, 'release_download')
    return r.stdout

def verify(signed):
    with tempfile.TemporaryDirectory(prefix='ezil-apt-verify-') as folder:
        source, output = Path(folder) / 'InRelease', Path(folder) / 'Release'
        source.write_bytes(signed)
        r = subprocess.run(['gpgv', '--homedir', folder, '--keyring', str(KEYRING),
            '--output', str(output), str(source)], capture_output=True, timeout=5, check=False)
        need(r.returncode == 0 and output.is_file(), 'release_signature')
        return output.read_bytes()


def read_owned(path: Path, limit: int):
    need(path in (SOURCES, MIRROR_LIST, KEYRING), 'fixed_path')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
             and not info.st_mode & 0o022 and info.st_size <= limit, 'unsafe_source_file')
        data = os.read(fd, limit + 1)
        need(len(data) <= limit, 'source_size')
        return data, info
    finally:
        os.close(fd)

def write_sources(before: bytes, info, after: bytes):
    parent = SOURCES.parent
    for path in (Path('/etc'), Path('/etc/apt'), parent):
        item = path.lstat()
        need(stat.S_ISDIR(item.st_mode) and item.st_uid == 0 and not item.st_mode & 0o022, 'unsafe_source_directory')
    current, observed = read_owned(SOURCES, 65536)
    need(current == before and (observed.st_dev, observed.st_ino) == (info.st_dev, info.st_ino), 'source_changed')
    fd, name = tempfile.mkstemp(prefix='.ezil-ubuntu-', dir=parent)
    try:
        os.fchmod(fd, stat.S_IMODE(info.st_mode))
        with os.fdopen(fd, 'wb') as out:
            out.write(after)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name, SOURCES)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def main():
    release = dict(re.findall(r'^([A-Z_]+)=["\x27]?([^"\x27\n]+)["\x27]?$', Path('/etc/os-release').read_text(), re.M))
    if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '24.04':
        print('Ubuntu apt mirror: unchanged (not Ubuntu 24.04)')
        return
    need(release.get('VERSION_CODENAME') == 'noble' and os.geteuid() == 0, 'noble_root_required')
    raw, info = read_owned(SOURCES, 65536)
    mirrors = read_owned(MIRROR_LIST, 4096)[0] if LIST_URI.encode() in raw else None
    read_owned(KEYRING, LIMIT)
    after = recover(raw, mirrors, resolve, fetch, verify, dt.datetime.now(dt.timezone.utc))
    if after is None:
        print('Ubuntu apt mirror: unchanged (configured DNS available)')
        return
    write_sources(raw, info, after)
    print('Ubuntu apt mirror: verified signed Noble pockets; updated Ubuntu URI tokens only')

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No exception/source/environment content: every failure is closed before mutation.
        print('Ubuntu apt mirror: refused; no unverified source is accepted', file=__import__('sys').stderr)
        raise SystemExit(1)

