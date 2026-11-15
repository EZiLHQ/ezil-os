#!/usr/bin/env python3
"""Linux-only CLI deadline. Reap the CLI and its adopted children, never remove files."""
import ctypes
import contextlib
import fcntl
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


def repo_layout_lock(root, repository_id, run_dir='/run/ezil'):
    """Serialize destination selection, CLI reuse and legacy rename as one operation."""
    item = os.lstat(run_dir)
    if (not stat.S_ISDIR(item.st_mode) or item.st_uid != os.geteuid()
            or stat.S_IMODE(item.st_mode) != 0o700 or os.path.realpath(run_dir) != run_dir):
        raise RepoFailure('repo_open_git_missing')
    slot = hashlib.sha256((root + '\n' + repository_id).encode()).hexdigest()
    fd = os.open(os.path.join(run_dir, '.repo-layout-' + slot + '.lock'),
                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        item = os.fstat(fd)
        if (not stat.S_ISREG(item.st_mode) or item.st_uid != os.geteuid()
                or stat.S_IMODE(item.st_mode) != 0o600):
            raise RepoFailure('repo_open_git_missing')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RepoFailure('repo_open_busy')
        return os.fdopen(fd, 'rb')  # Kept open until CLI completion and any layout migration.
    except BaseException:
        os.close(fd)
        raise


def repo_command(root, repository_id, url, hydrated, expected_sha, expected_version,
                 pin_path='/run/ezil/bin/cli-pin.json', cli_path='/run/ezil/bin/ezil',
                 installed_pin_path='/run/ezil/bin/installed-pin.json', owner=0, refresh_only=False):
    if (not root.startswith('/') or os.path.normpath(root) != root or root == '/'
            or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', repository_id)
            or not re.fullmatch(r'https://github\.ezil\.work/[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9._-]{0,99}\.git', url)
            or '..' in url or url.endswith('.git.git')
            or not re.fullmatch(r'[0-9a-f]{64}', expected_sha)
            or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?', expected_version)):
        raise RepoFailure('repo_open_invalid_request')
    if hydrated not in ('0', '1'):
        raise RepoFailure('repo_open_invalid_request')
    checked_dir(root)
    if hydrated == '1' and not os.path.isfile(os.path.join(root, '.ezil-hydrated.json')):
        raise RepoFailure('repo_open_workspace_not_ready')
    projects = os.path.join(root, 'projects')
    checked_dir(projects, not refresh_only)
    folder = os.path.join(projects, repository_id)
    checked_dir(folder, not refresh_only)
    entries = set(os.listdir(folder))
    if '.git' in entries:
        raise RepoFailure('repo_open_folder_conflict')  # Code must never open the checkout as its workspace root.
    name = url.rsplit('/', 1)[1][:-4]
    if entries <= {name}:
        destination = os.path.join(folder, name)
    elif entries == {'repository'}:
        # Reopen and verify the earlier layout before moving its checkout.
        destination = os.path.join(folder, 'repository')
    else:
        raise RepoFailure('repo_open_folder_conflict')
    if os.path.lexists(destination):
        if not stat.S_ISDIR(os.lstat(destination).st_mode) or os.path.realpath(destination) != destination:
            raise RepoFailure('repo_open_folder_conflict')
    elif refresh_only:
        raise RepoFailure('repo_open_workspace_unavailable')
    try:
        with open(pin_path, encoding='utf8') as handle:
            pin = json.load(handle)
        with open(installed_pin_path, encoding='utf8') as handle:
            installed = json.load(handle)
        if pin != installed or pin.get('sha256') != expected_sha or pin.get('version') != expected_version:
            raise ValueError('pin mismatch')
        for path, mode in ((pin_path, 0o400), (installed_pin_path, 0o400), (cli_path, 0o500)):
            item = os.lstat(path)
            if not stat.S_ISREG(item.st_mode) or item.st_uid != owner or stat.S_IMODE(item.st_mode) != mode:
                raise ValueError('runtime file ownership')
        digest = hashlib.sha256()
        with open(cli_path, 'rb') as handle:
            for block in iter(lambda: handle.read(65536), b''):
                digest.update(block)
        if digest.hexdigest() != expected_sha:
            raise ValueError('bundle mismatch')
        version = subprocess.run([cli_path, '--version'], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2,
                                 check=False, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/run/ezil'})
        if version.returncode != 0 or version.stdout != f'ezil {expected_version}\n'.encode():
            raise ValueError('CLI version mismatch')
        if not stat.S_ISFIFO(os.fstat(3).st_mode) and not stat.S_ISSOCK(os.fstat(3).st_mode):
            raise ValueError('CLI packet is not a pipe')
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
        raise RepoFailure('repo_open_git_missing')
    return [cli_path, 'clone', url, '--directory', destination, '--json', '--grant-fd=3']


def readable_checkout(output, command):
    """Rename only a successfully rebound legacy checkout; never touch its Git state."""
    url, destination = command[2], command[4]
    name = url.rsplit('/', 1)[1][:-4]
    target = os.path.join(os.path.dirname(destination), name)
    if target == destination:
        return output
    try:
        value = json.loads(output)
    except (ValueError, UnicodeError):
        return output
    if (not isinstance(value, dict) or set(value) != {'canonicalUrl', 'folder', 'repository', 'identity', 'status'}
            or value['canonicalUrl'] != url or value['folder'] != destination
            or not isinstance(value['repository'], dict) or value['repository'].get('canonicalURL') != url
            or value['status'] not in ('cloned', 'reused')):
        return output
    checked_dir(os.path.dirname(destination))
    checked_dir(destination)
    checked_dir(os.path.join(destination, '.git'))
    if set(os.listdir(os.path.dirname(destination))) != {'repository'} or os.path.lexists(target):
        raise RepoFailure('repo_open_folder_conflict')
    # A user-configured worktree can anchor Git to the old absolute path. Do not
    # rewrite their intent or move a checkout that would stop being usable.
    # Inspect without inherited Git settings, hooks, prompts or any grant FD.
    try:
        worktree = subprocess.run(
            ['git', '-C', destination, 'config', '--local', '--includes', '--get-all', 'core.worktree'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=2, check=False, close_fds=True,
            env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/run/ezil',
                 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
                 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_COUNT': '3',
                 'GIT_CONFIG_KEY_0': 'core.hooksPath', 'GIT_CONFIG_VALUE_0': '/dev/null',
                 'GIT_CONFIG_KEY_1': 'core.fsmonitor', 'GIT_CONFIG_VALUE_1': 'false',
                 'GIT_CONFIG_KEY_2': 'core.askPass', 'GIT_CONFIG_VALUE_2': ''})
    except (OSError, subprocess.SubprocessError):
        raise RepoFailure('repo_open_folder_conflict')
    if worktree.returncode != 1:  # 1 means that no such setting exists; other errors refuse too.
        raise RepoFailure('repo_open_folder_conflict')
    # Linux renameat2 with NOREPLACE: even an empty foreign directory is never overwritten.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(destination), -100, os.fsencode(target), 1) != 0:
        raise RepoFailure('repo_open_folder_conflict')
    value['folder'] = target
    return (json.dumps(value, separators=(',', ':')) + '\n').encode()


def supervise(resources):
    # Reparent orphaned Git/helper grandchildren here rather than container PID 1.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return 125
    # pidfds bind signals to the exact child identity even if a PID is reused.
    # /proc's children list contains only our direct children, including those
    # reparented to this subreaper after a helper calls setsid().
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return 125
    children_path = f'/proc/self/task/{os.getpid()}/children'
    try:
        with open(children_path, encoding='ascii'):
            pass
    except OSError:
        return 125
    timeout_ms, grace_ms = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= timeout_ms <= 180000 or not 1 <= grace_ms <= 5000:
        return 125
    child = None
    deadline = time.monotonic() + timeout_ms / 1000
    stopping = False
    kill_at = None
    finish_at = None
    forced = False
    output = bytearray()
    output_valid = True
    adopted = {}

    def signal_adopted(sig):
        for fd in adopted.values():
            try:
                signal.pidfd_send_signal(fd, sig)
            except ProcessLookupError:
                pass

    def capture_adopted():
        with open(children_path, encoding='ascii') as handle:
            children = handle.read().split()
        for item in children:
            pid = int(item)
            if (pid == child.pid and child.returncode is None) or pid in adopted:
                continue
            try:
                fd = os.pidfd_open(pid)
            except ProcessLookupError:
                continue
            try:
                with open(f'/proc/{pid}/status', encoding='ascii') as handle:
                    still_ours = any(line.strip() == f'PPid:\t{os.getpid()}' for line in handle)
            except FileNotFoundError:
                still_ours = False
            if not still_ours:
                os.close(fd)
                continue
            adopted[pid] = fd
            if stopping:
                try:
                    signal.pidfd_send_signal(fd, signal.SIGKILL if forced else signal.SIGTERM)
                except ProcessLookupError:
                    pass

    def stop(_signum=None, _frame=None):
        nonlocal stopping, kill_at, finish_at
        if stopping:
            return
        stopping = True
        kill_at = time.monotonic() + grace_ms / 1000
        finish_at = kill_at + 0.5  # a stuck child must not hold the supervisor forever
        try:
            if child is not None and child.returncode is None:
                os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        signal_adopted(signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if stopping:
        return 124
    command = sys.argv[3:]
    repo_open = command and command[0] in ('--repo-open', '--repo-refresh')
    refresh_only = repo_open and command[0] == '--repo-refresh'
    if repo_open:
        if len(command) != 7:
            return 125
        try:
            resources.enter_context(repo_layout_lock(command[1], command[2]))
            command = repo_command(*command[1:], refresh_only=refresh_only)
        except RepoFailure as error:
            sys.stdout.write('ezil-repo-open:error:' + error.code + '\n')
            return 0
    child_env = os.environ.copy()
    for key in tuple(child_env):
        if key.startswith('GIT_') or key in ('NODE_OPTIONS', 'NODE_PATH', 'EZIL_REPO_OPEN_CLI_PACKET'):
            del child_env[key]
    child_env['PATH'] = '/usr/local/bin:/usr/bin:/bin'
    child = subprocess.Popen(command, start_new_session=True, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             pass_fds=(3,) if '--grant-fd=3' in command else (), env=child_env)
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
                if child.returncode is None:
                    os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            signal_adopted(signal.SIGKILL)
            forced = True
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
            # poll reaps the direct CLI first. An escaped session is still an
            # exact adopted child and is signalled through its own pidfd.
            capture_adopted()
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        break
                    fd = adopted.pop(pid, None)
                    if fd is not None:
                        os.close(fd)
                except ChildProcessError:
                    break
            capture_adopted()
            with open(children_path, encoding='ascii') as handle:
                remaining = bool(handle.read().strip())
            if remaining:
                stop()  # a CLI exit never licenses descendants to continue
            elif not selector.get_map():
                break
        if finish_at is not None and now >= finish_at:
            forced = True
            break
    selector.close()
    for fd in adopted.values():
        os.close(fd)
    if finish_at is not None and forced:
        # Reaching the hard deadline is failure even if the CLI printed JSON.
        return 126
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
    if repo_open and not refresh_only and parent_code == 0 and output_valid:
        try:
            output = readable_checkout(output, command)
        except RepoFailure as error:
            sys.stdout.write('ezil-repo-open:error:' + error.code + '\n')
            return 0
    sys.stdout.buffer.write(output)
    return parent_code if parent_code is not None and parent_code >= 0 else 1


def main():
    with contextlib.ExitStack() as resources:
        return supervise(resources)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(125)
