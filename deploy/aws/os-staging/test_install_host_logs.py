"""D4 (round 5): install-host.sh keeps a gzip snapshot of the outgoing web log, never blocking the install.

Runs the real snapshot_web_log function from install-host.sh under `set -euo pipefail` with a fake
`docker` on PATH; only the log directory path is rewritten to a temporary directory.
"""
import gzip
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent
INSTALLER = HERE / "install-host.sh"
LOG_DIR = "/var/log/ezil-os-staging"


def snapshot_function() -> str:
    text = INSTALLER.read_text()
    start = text.index("snapshot_web_log() {")
    end = text.index("\n}\n", start) + 3
    return text[start:end]


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.logs = self.root / "logs"

    def tearDown(self):
        self.tmp.cleanup()

    def docker(self, body: str):
        fake = self.bin / "docker"
        fake.write_text("#!/usr/bin/env bash\n" + body + "\n")
        fake.chmod(0o755)

    def run_snapshot(self) -> subprocess.CompletedProcess:
        fn = snapshot_function().replace(LOG_DIR, str(self.logs))
        script = "set -euo pipefail\numask 077\n" + fn + "snapshot_web_log\necho AFTER\n"
        env = {**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}"}
        return subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=60)

    def snapshots(self):
        return sorted(self.logs.glob("web-*.log.gz")) if self.logs.exists() else []

    def test_bash_syntax(self):
        subprocess.run(["bash", "-n", str(INSTALLER)], check=True)

    def test_snapshot_written_and_private(self):
        self.docker('case $1 in container) exit 0;; logs) [[ $2 == --timestamps && $3 == ezil-os-staging-web-1 ]] || exit 9;'
                    ' echo "2026-10-29T12:00:00Z out"; echo "2026-10-29T12:00:01Z err" >&2;; esac')
        result = self.run_snapshot()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AFTER", result.stdout)
        [snap] = self.snapshots()
        self.assertRegex(snap.name, r"^web-\d{8}T\d{6}Z\.log\.gz$")
        self.assertEqual(gzip.decompress(snap.read_bytes()).decode(),
                         "2026-10-29T12:00:00Z out\n2026-10-29T12:00:01Z err\n")
        self.assertEqual(snap.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.logs.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list(self.logs.glob("*.partial")), [])

    def test_no_container_first_install_continues(self):
        self.docker("exit 1")
        result = self.run_snapshot()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AFTER", result.stdout)
        self.assertEqual(self.snapshots(), [])

    def test_docker_logs_failure_never_blocks_and_leaves_no_partial(self):
        self.docker("case $1 in container) exit 0;; logs) echo partial; exit 3;; esac")
        result = self.run_snapshot()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AFTER", result.stdout)
        self.assertEqual(list(self.logs.iterdir()), [])

    def test_unwritable_directory_never_blocks(self):
        self.docker("case $1 in container) exit 0;; logs) echo line;; esac")
        self.logs.write_text("not a directory")
        result = self.run_snapshot()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AFTER", result.stdout)

    def test_prunes_snapshots_older_than_seven_days(self):
        self.docker("case $1 in container) exit 0;; logs) echo line;; esac")
        self.logs.mkdir(mode=0o700)
        old, recent, other = (self.logs / "web-20261020T000000Z.log.gz", self.logs / "web-20261027T000000Z.log.gz",
                              self.logs / "keep-me.txt")
        for path in (old, recent, other):
            path.write_bytes(b"x")
        eight_days = time.time() - 8 * 86400
        os.utime(old, (eight_days, eight_days))
        os.utime(other, (eight_days, eight_days))
        os.utime(recent, (time.time() - 6 * 86400,) * 2)
        result = self.run_snapshot()
        self.assertEqual(result.returncode, 0, result.stderr)
        names = {p.name for p in self.logs.iterdir()}
        self.assertNotIn(old.name, names)
        self.assertIn(recent.name, names)
        self.assertIn(other.name, names)
        self.assertEqual(len(self.snapshots()), 2)


if __name__ == "__main__":
    unittest.main()
