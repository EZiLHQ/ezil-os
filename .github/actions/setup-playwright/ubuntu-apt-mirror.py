#!/usr/bin/env python3
"""CI-only Noble apt failover. Keep archive signatures, source fields and test commands."""
from __future__ import annotations
import datetime as dt
import email.utils
import errno
import ipaddress
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

SOURCES = Path('/etc/apt/sources.list.d/ubuntu.sources')
MIRROR_LIST = Path('/etc/apt/apt-mirrors.txt')
KEYRING = Path('/usr/share/keyrings/ubuntu-archive-keyring.gpg')
PROTECTED_KEYRING = Path('/etc/apt/keyrings/ezil-ci-ubuntu-archive.gpg')
FINGERPRINT = 'F6ECB3762474EDA9D21B7022871920D1991BC93C'
SIGNED_BY = str(PROTECTED_KEYRING) + ' ' + FINGERPRINT + '!'
MIRROR = 'https://mirrors.edge.kernel.org/ubuntu/'
LIST_URI = 'mirror+file:/etc/apt/apt-mirrors.txt'
HOSTS = ('azure.archive.ubuntu.com', 'archive.ubuntu.com', 'security.ubuntu.com')
URIS = {scheme + '://' + host + '/ubuntu' + slash for scheme in ('http', 'https') for host in HOSTS for slash in ('', '/')}
POCKETS = {'noble', 'noble-updates', 'noble-security', 'noble-backports'}
FIELDS = {'Types', 'URIs', 'Suites', 'Components', 'Signed-By', 'Architectures',
          'Architectures-Add', 'Architectures-Remove', 'Languages', 'Targets',
          'PDiffs', 'By-Hash', 'Check-Valid-Until', 'Enabled'}
LIMIT = 1048576
# One bounded retry of the same HTTPS URL. HTTP status is not captured: curl 22
# means HTTP failure, not a claim about a particular server response code.
FETCH_RETRYABLE_CURL_CODES = {5, 6, 7, 16, 18, 22, 28, 35, 52, 55, 56, 92}
FETCH_BUDGET_SECONDS = 31  # two existing 15 s transfers plus at most 1 s backoff

class Refused(Exception):
    pass

PHASE = 'startup'
PHASES = {'startup', 'os_release', 'source_read', 'mirror_list_read', 'keyring_read',
          'protected_keyring_read', 'protected_keyring_write', 'source_parse', 'configured_dns', 'release_fetch', 'release_verify', 'release_metadata', 'source_write'}
REASONS = {
    'source_format', 'source_field', 'source_fields', 'source_keyring', 'source_types',
    'source_options', 'source_pocket', 'source_components', 'source_uri', 'mirror_list',
    'source_pockets', 'release_size', 'release_format', 'release_identity', 'release_content',
    'release_time', 'release_future', 'release_stale', 'release_expired', 'release_url',
    'release_download', 'release_signature', 'fixed_path', 'source_size',
    'unsafe_source_directory', 'source_changed', 'noble_root_required', 'release_signer',
    'protected_keyring_parent', 'protected_keyring_mode', 'protected_keyring_mismatch',
} | {label + '_' + code for label in ('source', 'mirror_list', 'keyring', 'protected_keyring')
     for code in ('missing', 'symlink', 'unreadable', 'not_regular', 'not_root_owned', 'multiple_links', 'writable', 'too_large')}

def public_failure(error):
    reason = error.args[0] if isinstance(error, Refused) and error.args else None
    reason = reason if isinstance(reason, str) and reason in REASONS else (
        'command_timeout' if isinstance(error, subprocess.TimeoutExpired) else
        'io_error' if isinstance(error, OSError) else
        'invalid_metadata_time' if isinstance(error, ValueError) else 'unexpected')
    return 'Ubuntu apt mirror: refused phase=' + (PHASE if PHASE in PHASES else 'startup') + ' reason=' + reason + '; no unverified source is accepted'

def need(condition, message):
    if not condition:
        raise Refused(message)

def parse_sources(raw: bytes, mirrors: bytes | None):
    global PHASE
    PHASE = 'source_parse'
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
        need(fields['Signed-By'] in (str(KEYRING), SIGNED_BY), 'source_keyring')
        need(set(fields['Types'].split()) <= {'deb', 'deb-src'}, 'source_types')
        need(fields.get('Enabled', 'yes') == 'yes' and fields.get('Check-Valid-Until', 'yes') == 'yes', 'source_options')
        pocket = set(fields['Suites'].split())
        need(pocket and pocket <= POCKETS, 'source_pocket')
        part = set(fields['Components'].split())
        need(part and part <= {'main', 'restricted', 'universe', 'multiverse'}, 'source_components')
        suites |= pocket
        components |= part
        tokens = fields['URIs'].split()
        need(tokens and all(token in URIS or token in (LIST_URI, MIRROR) for token in tokens), 'source_uri')
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
            replacements.append((offset + m.start(1), offset + m.end(1), after, 'uri'))
        for m in re.finditer(r'^Signed-By:[ \t]+([^\n]+)', block, re.M):
            replacements.append((offset + m.start(1), offset + m.end(1), SIGNED_BY, 'key'))
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

def recover(raw, mirrors, resolve, fetch, verify, now, pin_required=False):
    text, replacements, suites, components, hosts = parse_sources(raw, mirrors)
    global PHASE
    PHASE = 'configured_dns'
    dns_available = all(resolve(host) for host in sorted(hosts))
    if dns_available and not pin_required:
        return None
    for pocket in sorted(suites):
        PHASE = 'release_fetch'
        signed = fetch(MIRROR + 'dists/' + pocket + '/InRelease')
        need(0 < len(signed) <= LIMIT, 'release_size')
        PHASE = 'release_verify'
        payload = verify(signed)
        PHASE = 'release_metadata'
        validate_release(payload, pocket, components, now)
    for start, end, value, kind in sorted(replacements, reverse=True):
        if kind == 'key' or not dns_available:
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
    started = time.monotonic()
    deadline = started + FETCH_BUDGET_SECONDS
    for attempt in (1, 2):
        remaining = deadline - time.monotonic()
        need(remaining > 0, 'release_download')
        r = subprocess.run(['curl', '--disable', '--fail', '--silent', '--show-error', '--location',
            '--proto', '=https', '--proto-redir', '=https', '--max-time', '15',
            '--max-filesize', str(LIMIT), url], capture_output=True, timeout=min(17, remaining), check=False)
        # Fixed numeric diagnostics only: never echo stderr, payloads, URLs or environment.
        elapsed_ms = max(0, int((time.monotonic() - started) * 1000))
        print(f'Ubuntu apt mirror: fetch attempt={attempt}/2 curl_rc={r.returncode} elapsed_ms={elapsed_ms}')
        if r.returncode == 0 and len(r.stdout) <= LIMIT:
            return r.stdout
        # Oversize/local/trust failures do not become transport retries. Signature
        # and release-policy verification remain outside this fetch-only loop.
        need(len(r.stdout) <= LIMIT and r.returncode in FETCH_RETRYABLE_CURL_CODES
             and attempt == 1, 'release_download')
        time.sleep(min(1, max(0, deadline - time.monotonic())))
    raise Refused('release_download')

def verify(signed, keyring):
    need(0 < len(keyring) <= LIMIT, 'release_size')
    with tempfile.TemporaryDirectory(prefix='ezil-apt-verify-') as folder:
        source, output = Path(folder) / 'InRelease', Path(folder) / 'Release'
        private_keyring = Path(folder) / 'archive.gpg'
        private_keyring.write_bytes(keyring)
        private_keyring.chmod(0o600)
        source.write_bytes(signed)
        r = subprocess.run(['gpgv', '--homedir', folder, '--status-fd', '1',
            '--keyring', str(private_keyring), '--output', str(output), str(source)],
            capture_output=True, timeout=5, check=False)
        need(r.returncode == 0 and output.is_file(), 'release_signature')
        statuses = [line.split() for line in r.stdout.decode('ascii').splitlines()
                    if line.startswith('[GNUPG:] VALIDSIG ')]
        need(len(statuses) == 1 and len(statuses[0]) == 12
             and statuses[0][2] == FINGERPRINT and statuses[0][-1] == FINGERPRINT, 'release_signer')
        return output.read_bytes()


def read_owned(path: Path, limit: int):
    global PHASE
    label = {SOURCES: 'source', MIRROR_LIST: 'mirror_list', KEYRING: 'keyring', PROTECTED_KEYRING: 'protected_keyring'}.get(path)
    need(label is not None, 'fixed_path')
    PHASE = label + '_read'
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        code = 'missing' if error.errno == errno.ENOENT else 'symlink' if error.errno == errno.ELOOP else 'unreadable'
        raise Refused(label + '_' + code) from None
    try:
        info = os.fstat(fd)
        need(stat.S_ISREG(info.st_mode), label + '_not_regular')
        need(info.st_uid == 0, label + '_not_root_owned')
        need(info.st_nlink == 1, label + '_multiple_links')
        need(path == KEYRING or not info.st_mode & 0o022, label + '_writable')
        need(info.st_size <= limit, label + '_too_large')
        data = os.read(fd, limit + 1)
        need(len(data) <= limit, 'source_size')
        return data, info
    finally:
        os.close(fd)

def protected_parent(create=False):
    parent = PROTECTED_KEYRING.parent
    for path in (Path('/etc'), Path('/etc/apt')):
        info = path.lstat()
        need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022, 'protected_keyring_parent')
    if create:
        try:
            parent.mkdir(mode=0o755)
        except FileExistsError:
            pass
    info = parent.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
         and stat.S_IMODE(info.st_mode) == 0o755, 'protected_keyring_parent')

def existing_keyring(keyring):
    protected_parent()
    data, info = read_owned(PROTECTED_KEYRING, LIMIT)
    need(stat.S_IMODE(info.st_mode) == 0o644, 'protected_keyring_mode')
    need(data == keyring, 'protected_keyring_mismatch')

def install_keyring(keyring):
    global PHASE
    PHASE = 'protected_keyring_write'
    protected_parent(create=True)
    if PROTECTED_KEYRING.exists() or PROTECTED_KEYRING.is_symlink():
        existing_keyring(keyring)
        return
    fd, name = tempfile.mkstemp(prefix='.ezil-ci-ubuntu-', dir=PROTECTED_KEYRING.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(keyring)
            out.flush()
            os.fchmod(out.fileno(), 0o644)
            os.fsync(out.fileno())
        # Atomic create without overwriting a foreign destination.
        try:
            os.link(name, PROTECTED_KEYRING, follow_symlinks=False)
        except FileExistsError:
            os.unlink(name)
            existing_keyring(keyring)
            return
        os.unlink(name)
        existing_keyring(keyring)
    finally:
        if os.path.exists(name):
            os.unlink(name)

def write_sources(before: bytes, info, after: bytes):
    global PHASE
    PHASE = 'source_write'
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
    global PHASE
    PHASE = 'os_release'
    release = dict(re.findall(r'^([A-Z_]+)=["\x27]?([^"\x27\n]+)["\x27]?$', Path('/etc/os-release').read_text(), re.M))
    if release.get('ID') != 'ubuntu' or release.get('VERSION_ID') != '24.04':
        print('Ubuntu apt mirror: unchanged (not Ubuntu 24.04)')
        return
    need(release.get('VERSION_CODENAME') == 'noble' and os.geteuid() == 0, 'noble_root_required')
    raw, info = read_owned(SOURCES, 65536)
    mirrors = read_owned(MIRROR_LIST, 4096)[0] if LIST_URI.encode() in raw else None
    keyring, key_info = read_owned(KEYRING, LIMIT)
    if SIGNED_BY.encode() in raw:
        existing_keyring(keyring)
    after = recover(raw, mirrors, resolve, fetch, lambda signed: verify(signed, keyring),
                    dt.datetime.now(dt.timezone.utc), pin_required=bool(key_info.st_mode & 0o022))
    if after is None:
        print('Ubuntu apt mirror: unchanged (configured DNS available)')
        return
    install_keyring(keyring)
    write_sources(raw, info, after)
    print('Ubuntu apt mirror: verified signed Noble pockets; protected signer pin installed')

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only closed phase/reason codes; no exception/source/environment content.
        print(public_failure(error), file=__import__('sys').stderr)
        raise SystemExit(1)

