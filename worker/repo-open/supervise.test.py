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
