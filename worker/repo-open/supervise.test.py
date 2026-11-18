"""Real Linux process checks for the standalone CLI supervisor; no network or host calls."""
import os
from pathlib import Path
import hashlib
import json
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import importlib.util


SUPERVISOR = Path(__file__).with_name('supervise.py')
FORKING_CLI = r'''
import os, signal, sys, time
marker, mode = sys.argv[1:]
pid = os.fork()
if pid == 0:
    os.setsid()
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    with open(marker, 'w', encoding='ascii') as handle:
        handle.write(str(os.getpid()) + ' ' + open('/proc/self/stat', encoding='ascii').read().split()[21])
    while True:
        time.sleep(1)
while not os.path.exists(marker):
    time.sleep(0.005)
if mode == 'exit':
    print('{"status":"cloned"}', flush=True)
    os._exit(0)
while True:
    time.sleep(1)
'''


def process_start(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text(encoding='ascii').split()[21]
    except FileNotFoundError:
        return None


class SupervisorDescendants(unittest.TestCase):
    def test_concurrent_legacy_layout_selection_is_serialized_until_rename(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-lock-') as directory:
            os.chmod(directory, 0o700)
            wrapper = Path(directory) / 'checkout'
            subprocess.run(['git', 'init', '--quiet', '--template=', str(wrapper / 'repository')], check=True)
            rid = '44444444-4444-8444-8444-444444444444'
            with module.repo_layout_lock('/workspace', rid, directory):
                # A second process cannot select the soon-to-be-renamed legacy destination.
                probe = "import importlib.util,sys;s=importlib.util.spec_from_file_location('m',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\ntry:m.repo_layout_lock('/workspace',sys.argv[2],sys.argv[3]);sys.exit(1)\nexcept m.RepoFailure as e:sys.exit(0 if e.code=='repo_open_busy' else 2)"
                result = subprocess.run([sys.executable, '-I', '-c', probe, str(SUPERVISOR), rid, directory],
                                        capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr)
                url = 'https://github.ezil.work/default/site.git'
                command = ['ezil', 'clone', url, '--directory', str(wrapper / 'repository')]
                output = json.dumps({'canonicalUrl': url, 'folder': command[4], 'repository': {'canonicalURL': url},
                                     'identity': {}, 'status': 'reused'}).encode()
                module.readable_checkout(output, command)
            with module.repo_layout_lock('/workspace', rid, directory):
                self.assertEqual(os.listdir(wrapper), ['site'])

    def test_refresh_of_missing_checkout_creates_no_directories(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-refresh-') as directory:
            with self.assertRaises(module.RepoFailure):
                module.repo_command(directory, '44444444-4444-4444-8444-444444444444',
                                    'https://github.ezil.work/default/site.git', '0', 'a' * 64,
                                    '0.3.0-standalone.20261110.0', refresh_only=True)
            self.assertEqual(os.listdir(directory), [])
    def test_successful_legacy_reopen_renames_checkout_without_touching_git_or_dirty_files(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-layout-') as directory:
            wrapper = Path(directory) / '44444444-4444-8444-8444-444444444444'
            checkout = wrapper / 'repository'
            (checkout / '.git').mkdir(parents=True)
            subprocess.run(['git', 'init', '--quiet', '--template=', str(checkout)], check=True)
            (checkout / 'tracked.txt').write_text('staged content')
            subprocess.run(['git', '-C', str(checkout), 'add', 'tracked.txt'], check=True)
            (checkout / 'tracked.txt').write_text('unstaged content')
            saved_config = (checkout / '.git' / 'config').read_bytes()
            saved_index = (checkout / '.git' / 'index').read_bytes()
            (checkout / 'dirty.txt').write_text('uncommitted work')
            (checkout / '.vscode').mkdir()
            (checkout / '.vscode' / 'settings.json').write_text('{"untrusted":"configuration"}')
            url = 'https://github.ezil.work/default/site.git'
            command = ['/run/ezil/bin/ezil', 'clone', url, '--directory', str(checkout), '--json', '--grant-fd=3']
            result = {'canonicalUrl': url, 'folder': str(checkout), 'repository': {'canonicalURL': url},
                      'identity': {'issuer': 'https://id.ezil.work/', 'subject': 'auth0|fixture'}, 'status': 'reused'}
            wrong = {**result, 'folder': '/unbound/folder'}
            self.assertEqual(module.readable_checkout(json.dumps(wrong).encode(), command), json.dumps(wrong).encode())
            self.assertTrue(checkout.is_dir())
            output = json.loads(module.readable_checkout(json.dumps(result).encode(), command))
            target = wrapper / 'site'
            self.assertEqual(output['folder'], str(target))
            self.assertFalse(checkout.exists())
            self.assertEqual((target / 'dirty.txt').read_text(), 'uncommitted work')
            self.assertEqual((target / '.git' / 'index').read_bytes(), saved_index)
            self.assertEqual((target / '.git' / 'config').read_bytes(), saved_config)
            self.assertEqual((target / 'tracked.txt').read_text(), 'unstaged content')
            self.assertEqual(subprocess.run(['git', '-C', str(target), 'status', '--porcelain'], capture_output=True).returncode, 0)
            self.assertFalse((wrapper / '.vscode').exists())

    def test_legacy_migration_refuses_anchored_worktree_and_preserves_usable_checkout(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-worktree-') as directory:
            wrapper = Path(directory) / 'wrapper'
            checkout = wrapper / 'repository'
            subprocess.run(['git', 'init', '--quiet', '--template=', str(checkout)], check=True)
            subprocess.run(['git', '-C', str(checkout), 'config', '--local', 'core.worktree', str(checkout)], check=True)
            (checkout / 'dirty.txt').write_text('uncommitted work')
            before = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True)
            self.assertEqual(before.returncode, 0)
            config = (checkout / '.git' / 'config').read_bytes()
            url = 'https://github.ezil.work/default/site.git'
            command = ['ezil', 'clone', url, '--directory', str(checkout)]
            output = json.dumps({'canonicalUrl': url, 'folder': str(checkout), 'repository': {'canonicalURL': url},
                                 'identity': {}, 'status': 'reused'}).encode()
            with self.assertRaises(module.RepoFailure) as refusal:
                module.readable_checkout(output, command)
            self.assertEqual(refusal.exception.code, 'repo_open_folder_conflict')
            self.assertTrue(checkout.is_dir()); self.assertFalse((wrapper / 'site').exists())
            self.assertEqual((checkout / '.git' / 'config').read_bytes(), config)
            self.assertEqual((checkout / 'dirty.txt').read_text(), 'uncommitted work')
            after = subprocess.run(['git', '-C', str(checkout), 'status', '--porcelain'], capture_output=True)
            self.assertEqual(after.returncode, 0); self.assertEqual(after.stdout, before.stdout)

    def test_legacy_migration_refuses_collision_or_symlink(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-layout-') as directory:
            wrapper = Path(directory) / 'wrapper'
            checkout = wrapper / 'repository'
            (checkout / '.git').mkdir(parents=True)
            target = wrapper / 'site'
            target.mkdir()
            url = 'https://github.ezil.work/default/site.git'
            command = ['ezil', 'clone', url, '--directory', str(checkout)]
            output = json.dumps({'canonicalUrl': url, 'folder': str(checkout), 'repository': {'canonicalURL': url},
                                 'identity': {}, 'status': 'reused'}).encode()
            with self.assertRaises(module.RepoFailure):
                module.readable_checkout(output, command)
            self.assertTrue(checkout.is_dir()); self.assertTrue(target.is_dir())
            target.rmdir()
            (checkout / '.git').rmdir()
            (checkout / '.git').symlink_to(directory, target_is_directory=True)
            with self.assertRaises(module.RepoFailure):
                module.readable_checkout(output, command)
            self.assertTrue(checkout.is_dir()); self.assertFalse(target.exists())

    def test_isolated_python_ignores_unpinned_sibling_module(self):
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-import-') as directory:
            script = Path(directory) / 'supervise.py'
            script.write_bytes(SUPERVISOR.read_bytes())
            marker = Path(directory) / 'unpinned-import-ran'
            (Path(directory) / 'json.py').write_text(
                f"open({str(marker)!r}, 'w').write('loaded')\nraise SystemExit(73)\n")
            command = [sys.executable, str(script), '1000', '100', '/bin/true']
            plain = subprocess.run(command, capture_output=True, timeout=3)
            self.assertEqual(plain.returncode, 73)
            self.assertTrue(marker.exists())
            marker.unlink()
            isolated = subprocess.run([sys.executable, '-I', *command[1:]], capture_output=True, timeout=3)
            self.assertEqual(isolated.returncode, 0, isolated.stderr.decode())
            self.assertFalse(marker.exists())

    def test_requires_worker_hash_version_and_private_installed_files(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-') as directory:
            root = Path(directory) / 'workspace'
            root.mkdir()
            bin_dir = Path(directory) / 'bin'
            bin_dir.mkdir(mode=0o700)
            script = b'#!/bin/sh\nprintf "ezil 0.3.0-standalone.20261110.0\\n"\n'
            sha = hashlib.sha256(script).hexdigest()
            cli = bin_dir / 'ezil'
            cli.write_bytes(script)
            cli.chmod(0o500)
            pin = {'sha256': sha, 'version': '0.3.0-standalone.20261110.0'}
            for name in ('cli-pin.json', 'installed-pin.json'):
                path = bin_dir / name
                path.write_text(json.dumps(pin))
                path.chmod(0o400)
            try:
                saved = os.dup(3)
            except OSError:
                saved = None
            reader, writer = os.pipe()
            if reader != 3:
                os.dup2(reader, 3)
                os.close(reader)
            try:
                args = (str(root), '44444444-4444-4444-8444-444444444444',
                        'https://github.ezil.work/default/site.git', '0')
                files = (str(bin_dir / 'cli-pin.json'), str(cli), str(bin_dir / 'installed-pin.json'))
                command = module.repo_command(*args, sha, pin['version'], *files, owner=os.geteuid())
                self.assertEqual(command[-1], '--grant-fd=3')
                self.assertEqual(command[4], str(root / 'projects' / args[1] / 'site'))
                for wrong_sha, wrong_version in (('0' * 64, pin['version']), (sha, '0.3.1')):
                    with self.assertRaises(module.RepoFailure) as refusal:
                        module.repo_command(*args, wrong_sha, wrong_version, *files, owner=os.geteuid())
                    self.assertEqual(refusal.exception.code, 'repo_open_git_missing')
            finally:
                os.close(writer)
                os.close(3)
                if saved is not None:
                    os.dup2(saved, 3)
                    os.close(saved)

    def test_refuses_a_checkout_at_the_code_workspace_root(self):
        spec = importlib.util.spec_from_file_location('ezil_repo_supervise', SUPERVISOR)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-') as directory:
            folder = Path(directory) / 'projects' / '44444444-4444-4444-8444-444444444444'
            (folder / '.git').mkdir(parents=True)
            with self.assertRaises(module.RepoFailure) as refusal:
                module.repo_command(directory, folder.name, 'https://github.ezil.work/default/site.git', '0',
                                    'a' * 64, '0.3.0-standalone.20261110.0')
            self.assertEqual(refusal.exception.code, 'repo_open_folder_conflict')

    def check_case(self, mode):
        with tempfile.TemporaryDirectory(prefix='ezil-supervise-') as directory:
            marker = Path(directory) / 'owned-pid'
            started = time.monotonic()
            proc = subprocess.Popen([
                sys.executable, str(SUPERVISOR), '250' if mode == 'timeout' else '5000', '100',
                sys.executable, '-c', FORKING_CLI, str(marker), mode,
            ], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            owned = None
            try:
                stdout, stderr = proc.communicate(timeout=2)
                self.assertTrue(marker.exists(), stderr.decode())
                owned = marker.read_text(encoding='ascii').split()
                self.assertEqual(proc.returncode, 126, stderr.decode())
                self.assertEqual(stdout, b'', 'interrupted CLI output must not look successful')
                self.assertLess(time.monotonic() - started, 2)
                self.assertIsNone(process_start(int(owned[0])), 'detached owned child was not reaped')
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.communicate(timeout=1)
                # An assertion failure in the regression must never leave its
                # exact probe child behind. Check start time before signalling.
                if marker.exists():
                    pid, start = marker.read_text(encoding='ascii').split()
                    if process_start(int(pid)) == start:
                        os.kill(int(pid), signal.SIGKILL)

    def test_timeout_reaps_detached_descendant(self):
        self.check_case('timeout')

    def test_cli_exit_reaps_detached_descendant(self):
        self.check_case('exit')


if __name__ == '__main__':
    unittest.main()
