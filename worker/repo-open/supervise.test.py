"""Real Linux process checks for the private CLI supervisor; no network or host calls."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest


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
