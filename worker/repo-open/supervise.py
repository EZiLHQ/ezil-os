#!/usr/bin/env python3
"""Linux-only CLI deadline. Own one process group, reap it, never remove files."""
import ctypes
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import sys
import time


class RepoFailure(Exception):
    def __init__(self, code):
        self.code = code


def checked_dir(path, create=False):
    try:
        if create:
            os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    try:
        item = os.lstat(path)
        if not stat.S_ISDIR(item.st_mode) or os.path.realpath(path) != path:
            raise RepoFailure('repo_open_folder_conflict')
    except FileNotFoundError:
        raise RepoFailure('repo_open_workspace_unavailable')


def repo_command(root, repository_id, url, hydrated,
                 pin_path='/opt/ezil-repo-open/cli-pin.json', cli_path='/opt/ezil-cli/ezil',
                 installed_pin_path='/opt/ezil-cli/pin.json'):
    if (not root.startswith('/') or os.path.normpath(root) != root or root == '/'
            or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', repository_id)
            or not re.fullmatch(r'https://github\.ezil\.work/[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9._-]{0,99}\.git', url)
            or '..' in url or url.endswith('.git.git')):
        raise RepoFailure('repo_open_invalid_request')
    if hydrated not in ('0', '1'):
        raise RepoFailure('repo_open_invalid_request')
    checked_dir(root)
    if hydrated == '1' and not os.path.isfile(os.path.join(root, '.ezil-hydrated.json')):
        raise RepoFailure('repo_open_workspace_not_ready')
    projects = os.path.join(root, 'projects')
    checked_dir(projects, True)
    folder = os.path.join(projects, repository_id)
    checked_dir(folder, True)
    entries = set(os.listdir(folder))
    if '.git' in entries:
        destination = folder  # Preserve an older root-level checkout.
    elif entries <= {'repository'}:
        destination = os.path.join(folder, 'repository')
    else:
        raise RepoFailure('repo_open_folder_conflict')
    if os.path.lexists(destination):
        if not stat.S_ISDIR(os.lstat(destination).st_mode) or os.path.realpath(destination) != destination:
            raise RepoFailure('repo_open_folder_conflict')
    try:
        with open(pin_path, encoding='utf8') as handle:
            pin = json.load(handle)
        with open(installed_pin_path, encoding='utf8') as handle:
            installed = json.load(handle)
        if pin != installed or not stat.S_ISREG(os.stat(cli_path).st_mode):
            raise ValueError('pin mismatch')
        digest = hashlib.sha256()
        with open(cli_path, 'rb') as handle:
            for block in iter(lambda: handle.read(65536), b''):
                digest.update(block)
        if digest.hexdigest() != pin['sha256']:
            raise ValueError('bundle mismatch')
        if not stat.S_ISFIFO(os.fstat(3).st_mode) and not stat.S_ISSOCK(os.fstat(3).st_mode):
            raise ValueError('private grant is not a pipe')
    except (OSError, ValueError, KeyError, TypeError):
        raise RepoFailure('repo_open_git_missing')
    return [cli_path, 'clone', url, '--directory', destination, '--json', '--grant-fd=3']


def main():
    # Reparent orphaned Git/helper grandchildren here rather than container PID 1.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return 125
    timeout_ms, grace_ms = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= timeout_ms <= 180000 or not 1 <= grace_ms <= 5000:
        return 125
    child = None
    deadline = time.monotonic() + timeout_ms / 1000
    stopping = False
    kill_at = None
    forced = False
    output = bytearray()
    output_valid = True

    def stop(_signum=None, _frame=None):
        nonlocal stopping, kill_at
        if stopping:
            return
        stopping = True
        kill_at = time.monotonic() + grace_ms / 1000
        try:
            if child is not None:
                os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if stopping:
        return 124
    command = sys.argv[3:]
    if command and command[0] == '--repo-open':
        if len(command) != 5:
            return 125
        try:
            command = repo_command(*command[1:])
        except RepoFailure as error:
            sys.stdout.write('ezil-repo-open:error:' + error.code + '\n')
            return 0
    child = subprocess.Popen(command, start_new_session=True, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             pass_fds=(3,) if '--grant-fd=3' in command else ())
    if '--grant-fd=3' in command:
        os.close(3)
    if stopping:  # signal during Popen must not leave its just-created group running
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    while True:
        now = time.monotonic()
        if now >= deadline:
            stop()
        if kill_at is not None and now >= kill_at:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                forced = True
            except ProcessLookupError:
                pass
            kill_at = None
        for key, _ in selector.select(0.025):
            chunk = os.read(key.fd, 65536)
            if not chunk:
                selector.unregister(key.fileobj)
                child.stdout.close()
            elif len(output) + len(chunk) > 65536:
                stop()  # bounded output; never forward partial/oversized JSON
                output.clear()
                output_valid = False
            elif output_valid:
                output.extend(chunk)
        parent_code = child.poll()
        if parent_code is not None:
            # poll reaps the direct child first. Only adopted descendants remain.
            remaining = False
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        remaining = True
                        break
                except ChildProcessError:
                    break
            if remaining:
                stop()  # a CLI exit never licenses descendants to continue
            elif not selector.get_map():
                break
    selector.close()
    try:
        error = json.loads(output).get("error", {}) if output_valid else {}
        recovery = error.get("code") == "clone-failed" and error.get("message") == (
            "Repository open interrupted; recovery required after forced Git termination.")
    except (ValueError, AttributeError):
        recovery = False
    if recovery:
        return 126  # CLI escalated its own Git child; ordinary exit does not prove cleanup.
    if stopping:
        # No stdout from an interrupted operation can masquerade as success.
        return 126 if forced or parent_code is None or parent_code < 0 else 124
    sys.stdout.buffer.write(output)
    return parent_code if parent_code is not None and parent_code >= 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(125)
