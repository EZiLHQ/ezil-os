"""Install the reviewed public CLI and OS supervisor into ephemeral /run only."""
import base64
import fcntl
import hashlib
import io
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request

RUN_DIR = '/run/ezil'
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024
MAX_MEMBER_BYTES = 2 * 1024 * 1024
PATH = '/usr/local/bin:/usr/bin:/bin'
HEX64 = re.compile(r'[0-9a-f]{64}\Z')
HEX40 = re.compile(r'[0-9a-f]{40}\Z')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?\Z')


class StageError(Exception):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_pin(pin):
    if not isinstance(pin, dict) or set(pin) != {
            'url', 'archiveSha256', 'cliSha256', 'supervisorSha256', 'sourceCommit', 'version'}:
        raise StageError('invalid pin')
    if not all(isinstance(pin[key], str) for key in pin):
        raise StageError('invalid pin')
    if not all(HEX64.fullmatch(pin[key]) for key in ('archiveSha256', 'cliSha256', 'supervisorSha256')):
        raise StageError('invalid digest')
    if not HEX40.fullmatch(pin['sourceCommit']) or not VERSION.fullmatch(pin['version']):
        raise StageError('invalid provenance')
    url = urllib.parse.urlsplit(pin['url'])
    if '-standalone.' not in pin['version']:
        raise StageError('invalid standalone version')
    release = pin['version'].split('-standalone.', 1)[1]
    expected_path = (f'/EZiLHQ/ezil-cli/releases/download/standalone-{release}/'
                     f'ezil-cli-{pin["version"]}.tar.gz')
    if (url.scheme, url.netloc, url.path, url.query, url.fragment) != (
            'https', 'github.com', expected_path, '', ''):
        raise StageError('unapproved archive URL')


class ApprovedRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        url = urllib.parse.urlsplit(newurl)
        if (url.scheme != 'https' or url.hostname not in (
                'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')
                or url.username or url.password or url.port):
            raise StageError('unapproved redirect')
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def download(url):
    opener = urllib.request.build_opener(ApprovedRedirect, urllib.request.ProxyHandler({}))
    request = urllib.request.Request(url, headers={'User-Agent': 'EZiL-OS-cli-bootstrap/1'})
    with opener.open(request, timeout=8) as response:
        data = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(data) > MAX_ARCHIVE_BYTES:
        raise StageError('archive too large')
    return data


def cli_from_archive(archive, pin):
    prefix = f'ezil-cli-{pin["version"]}/'
    selected = {}
    seen = set()
    total = 0
    try:
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            members = package.getmembers()
            if len(members) > 32:
                raise StageError('archive entries')
            for member in members:
                name = member.name
                if (not (name.startswith(prefix) or name == prefix[:-1] and member.isdir()) or name.startswith('/') or
                        any(part in ('', '.', '..') for part in name.rstrip('/').split('/')) or
                        not (member.isdir() or member.isfile())):
                    raise StageError('unsafe archive entry')
                total += member.size
                if member.size > MAX_MEMBER_BYTES or total > 5 * MAX_MEMBER_BYTES:
                    raise StageError('archive content too large')
                if name in seen:
                    raise StageError('duplicate archive entry')
                seen.add(name)
                if name in (prefix + 'dist/ezil.js', prefix + 'package.json', prefix + 'SOURCE.json'):
                    if not member.isfile():
                        raise StageError('missing archive file')
                    selected[name] = package.extractfile(member).read()
    except (tarfile.TarError, OSError, ValueError) as error:
        raise StageError('invalid archive') from error
    if set(selected) != {prefix + 'dist/ezil.js', prefix + 'package.json', prefix + 'SOURCE.json'}:
        raise StageError('missing archive metadata')
    cli = selected[prefix + 'dist/ezil.js']
    if digest(cli) != pin['cliSha256'] or not cli.startswith(b'#!/usr/bin/env node\n'):
        raise StageError('CLI digest')
    try:
        package = json.loads(selected[prefix + 'package.json'])
        source = json.loads(selected[prefix + 'SOURCE.json'])
    except (UnicodeError, ValueError) as error:
        raise StageError('archive provenance') from error
    if (package.get('name') != '@ezilhq/cli' or package.get('version') != pin['version']
            or source.get('commit') != pin['sourceCommit'] or source.get('version') != pin['version']):
        raise StageError('archive provenance')
    return cli


def checked_dir(path, owner):
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    item = os.lstat(path)
    if not stat.S_ISDIR(item.st_mode) or item.st_uid != owner or stat.S_IMODE(item.st_mode) != 0o700:
        raise StageError('unsafe runtime directory')


def checked_file(path, owner, mode):
    try:
        item = os.lstat(path)
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(item.st_mode) or item.st_uid != owner or stat.S_IMODE(item.st_mode) != mode:
        raise StageError('unsafe runtime file')
    return True


def node_binary():
    for path in ('/usr/local/bin/node', '/usr/bin/node', '/bin/node'):
        if os.path.isfile(path) and os.access(path, os.X_OK):
            return path
    raise StageError('Node missing')


def command_version(command, expected, timeout=2):
    result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, check=False,
                            env={'PATH': PATH, 'HOME': RUN_DIR})
    if result.returncode != 0 or result.stdout != expected:
        raise StageError('version mismatch')


def check_node():
    if not any(os.path.isfile(path) and os.access(path, os.X_OK)
               for path in ('/usr/local/bin/git', '/usr/bin/git', '/bin/git')):
        raise StageError('Git missing')
    result = subprocess.run([node_binary(), '--version'], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2,
                            check=False, env={'PATH': PATH, 'HOME': RUN_DIR})
    if result.returncode != 0:
        raise StageError('Node version')
    match = re.fullmatch(rb'v([0-9]+)\.[0-9]+\.[0-9]+\n', result.stdout)
    if not match or int(match.group(1)) < 22:
        raise StageError('Node below 22')


def verify_files(bin_dir, pin, supervisor, owner):
    cli_path = os.path.join(bin_dir, 'ezil')
    supervisor_path = os.path.join(bin_dir, 'supervise.py')
    metadata = {'sha256': pin['cliSha256'], 'version': pin['version'],
                'sourceCommit': pin['sourceCommit'], 'supervisorSha256': pin['supervisorSha256']}
    for path, mode in ((cli_path, 0o500), (supervisor_path, 0o500),
                       (os.path.join(bin_dir, 'cli-pin.json'), 0o400),
                       (os.path.join(bin_dir, 'installed-pin.json'), 0o400)):
        if not checked_file(path, owner, mode):
            return False
    with open(cli_path, 'rb') as handle:
        if digest(handle.read(MAX_MEMBER_BYTES + 1)) != pin['cliSha256']:
            return False
    with open(supervisor_path, 'rb') as handle:
        if digest(handle.read(MAX_MEMBER_BYTES + 1)) != pin['supervisorSha256']:
            return False
    if digest(supervisor) != pin['supervisorSha256']:
        raise StageError('supervisor source mismatch')
    for name in ('cli-pin.json', 'installed-pin.json'):
        with open(os.path.join(bin_dir, name), 'rb') as handle:
            if json.loads(handle.read(1025)) != metadata:
                return False
    command_version([cli_path, '--version'], f'ezil {pin["version"]}\n'.encode())
    return True


def install_file(bin_dir, name, data, mode, owner):
    target = os.path.join(bin_dir, name)
    checked_file(target, owner, mode)
    fd, temporary = tempfile.mkstemp(prefix='.ezil-stage-', dir=bin_dir)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def stage(pin, supervisor, fetch=download, root=RUN_DIR, owner=0):
    validate_pin(pin)
    if digest(supervisor) != pin['supervisorSha256']:
        raise StageError('supervisor source mismatch')
    if owner != os.geteuid():
        raise StageError('wrong runtime owner')
    if root == RUN_DIR:
        parent = os.lstat('/run')
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0 or parent.st_mode & 0o022:
            raise StageError('unsafe runtime parent')
    check_node()
    checked_dir(root, owner)
    bin_dir = os.path.join(root, 'bin')
    checked_dir(bin_dir, owner)
    lock_path = os.path.join(root, '.cli-stage.lock')
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, 'rb') as lock:
        item = os.fstat(lock.fileno())
        if not stat.S_ISREG(item.st_mode) or item.st_uid != owner or stat.S_IMODE(item.st_mode) != 0o600:
            raise StageError('unsafe runtime lock')
        deadline = time.monotonic() + 2
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise StageError('runtime lock busy')
                time.sleep(0.05)
        if verify_files(bin_dir, pin, supervisor, owner):
            return
        archive = fetch(pin['url'])
        if len(archive) > MAX_ARCHIVE_BYTES or digest(archive) != pin['archiveSha256']:
            raise StageError('archive digest')
        cli = cli_from_archive(archive, pin)
        install_file(bin_dir, 'ezil', cli, 0o500, owner)
        install_file(bin_dir, 'supervise.py', supervisor, 0o500, owner)
        metadata = json.dumps({'sha256': pin['cliSha256'], 'version': pin['version'],
                               'sourceCommit': pin['sourceCommit'],
                               'supervisorSha256': pin['supervisorSha256']},
                              sort_keys=True, separators=(',', ':')).encode()
        install_file(bin_dir, 'cli-pin.json', metadata, 0o400, owner)
        install_file(bin_dir, 'installed-pin.json', metadata, 0o400, owner)
        if not verify_files(bin_dir, pin, supervisor, owner):
            raise StageError('install verification')


def main():
    try:
        signal.alarm(18)
        if len(sys.argv) != 3:
            raise StageError('arguments')
        pin = json.loads(sys.argv[1])
        supervisor = base64.b64decode(sys.argv[2], validate=True)
        stage(pin, supervisor)
        print('ezil-cli-bootstrap:ok')
        return 0
    except Exception:
        print('ezil-cli-bootstrap:error')
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    sys.exit(main())
