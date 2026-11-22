"""Exercise the generated runtime command's real Git and isolated loopback behavior."""
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("assignment-preload.py")
PORT = 5679
EVENT = "46fc47ce-b0af-4d4f-81b9-3b1f23c3061e"
ATTEMPT = "33ac68a4-750a-400b-a2ca-512e3975a849"
OWNER = "b" * 64
REPO = "12345678-1234-8234-8234-123456781234"
URL = f"https://github.ezil.work/default/u-{OWNER[:16]}-a-{ATTEMPT}.git"


class PrivateAssignmentPreloadTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.checkout = Path(self.temp.name) / "projects" / REPO / "repository"
        self.marker = self.checkout / ".ezil" / "assignment.json"
        self.marker.parent.mkdir(parents=True)
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Controlled Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.write()
        self.commit()

    def git(self, *args):
        subprocess.run(["git", "-C", self.checkout, *args], capture_output=True, check=True)

    def write(self, version=2):
        marker = {
            "schema": f"ezil.assignment/v{version}", "recorder": "assignment-recorder-v1",
            "repositoryUrl": URL, "consentVersion": 3, "notice": "Controlled assignment fixture.",
        }
        if version == 2:
            marker["preload"] = {
                "protocol": "ezil.assignment-open/v1", "trigger": "repo-open", "host": "127.0.0.1", "port": PORT,
            }
        self.marker.write_bytes((json.dumps(marker, separators=(",", ":")) + "\n").encode())
        self.digest = hashlib.sha256(self.marker.read_bytes()).hexdigest()

    def commit(self):
        self.git("add", "-A")
        self.git("commit", "-m", "Fixture marker")

    def invoke(self, checkout=None):
        witness = json.dumps({
            "eventId": EVENT, "attemptId": ATTEMPT, "ownerSha256": OWNER, "canonicalURL": URL,
            "repositoryId": REPO, "ref": "refs/heads/main", "manifestSha256": self.digest,
        })
        return subprocess.run(
            [sys.executable, "-I", SCRIPT, checkout or self.checkout, witness],
            capture_output=True, timeout=3, check=False,
        )

    def denies(self, checkout=None):
        result = self.invoke(checkout)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout + result.stderr, b"")

    def test_real_git_checkout_notifies_and_retry_releases_the_port(self):
        for _ in range(2):
            result = self.invoke()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b"ezil-assignment-preload:ack\n")
            with socket.socket() as verifier:
                verifier.settimeout(0.2)
                self.assertNotEqual(verifier.connect_ex(("127.0.0.1", PORT)), 0)

    def test_foreign_listener_cannot_ack_and_receives_no_connection(self):
        with socket.socket() as foreign:
            foreign.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            foreign.bind(("127.0.0.1", PORT))
            foreign.listen()
            foreign.settimeout(0.05)
            self.denies()
            with self.assertRaises(TimeoutError):
                foreign.accept()

    def test_other_interface_on_same_port_is_not_the_assignment_listener(self):
        with socket.socket() as other_interface:
            other_interface.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            other_interface.bind(("127.0.0.2", PORT))
            other_interface.listen()
            other_interface.settimeout(0.05)
            result = self.invoke()
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"ezil-assignment-preload:ack\n")
            with self.assertRaises(TimeoutError):
                other_interface.accept()

    def test_modified_marker_does_not_notify(self):
        with self.marker.open("ab") as marker:
            marker.write(b" ")
        self.denies()

    def test_missing_marker_does_not_notify(self):
        self.marker.unlink()
        self.denies()

    def test_exact_historical_c1_even_with_matching_digest_does_not_notify(self):
        self.write(version=1)
        self.commit()
        self.denies()

    def test_working_marker_must_still_be_tracked_at_head(self):
        marker = self.marker.read_bytes()
        self.marker.unlink()
        self.commit()
        self.marker.write_bytes(marker)
        self.denies()

    def test_symlink_file_and_symlink_parent_are_refused(self):
        copied = self.marker.with_name("source.json")
        self.marker.rename(copied)
        self.marker.symlink_to(copied.name)
        self.denies()
        projects = self.checkout.parent.parent
        other = projects.with_name("alias")
        other.symlink_to(projects, target_is_directory=True)
        self.denies(other / REPO / "repository")

    def test_other_branch_does_not_notify(self):
        self.git("checkout", "-b", "different")
        self.denies()

    def test_executable_marker_is_refused(self):
        self.marker.chmod(self.marker.stat().st_mode | 0o100)
        self.denies()


if __name__ == "__main__":
    unittest.main()
