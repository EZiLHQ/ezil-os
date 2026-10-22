#!/usr/bin/env python3
"""Real flock/process tests with synthetic AWS data and private script copies."""
import copy
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = Path(__file__).resolve().parent


class LockingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ezil-mum-lock-tests.")
        self.root = Path(self.temp.name) / "case"
        subprocess.run([sys.executable, str(HERE / "fixture.py"), str(self.root), "{}"], check=True)
        self.scripts = self.root / "checkout/deploy/aws/mum"
        self.env = {**os.environ, "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"]}
        self.processes = []
        target = copy.deepcopy(self.read("config.json"))
        target["settings"]["deployment"].update(amiId="ami-" + "2" * 17, launchTemplateVersion="8",
            stateMachineVersionArn="arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle:11")
        self.save("target.json", target)

    def tearDown(self):
        (self.root / "secret-continue").touch()
        (self.root / "writer-continue").touch()
        for process in self.processes:
            try:
                process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
        self.temp.cleanup()

    def read(self, name):
        return json.loads((self.root / name).read_text())

    def save(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def start(self, args):
        process = subprocess.Popen(args, env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.processes.append(process)
        return process

    def finish(self, process, code=0):
        stdout, stderr = process.communicate(timeout=20)
        self.assertEqual(process.returncode, code, stdout + stderr)
        self.assertNotIn("synthetic-private-do-not-print", stdout + stderr)
        return stdout + stderr

    def wait_for(self, name):
        deadline = time.monotonic() + 10
        while not (self.root / name).exists():
            self.assertLess(time.monotonic(), deadline, "test barrier timed out: " + name)
            time.sleep(0.01)

    def updater(self):
        return self.start([sys.executable, str(self.scripts / "json-tool.py"), "secret-update",
                           str(self.root / "config.json"), str(self.root / "target.json")])

    def writer(self, pause=False):
        # Represents the lead's whole-secret read/modify/write command. Its first
        # read is INSIDE the wrapper. No real credential or secret file is used.
        command = """
import json,sys,time
from pathlib import Path
root=Path(sys.argv[1])
(root/'writer-started').touch()
deadline=time.monotonic()+15
while sys.argv[2]=='pause' and not (root/'writer-continue').exists():
    assert time.monotonic()<deadline
    time.sleep(.01)
envelope=json.loads((root/'secret.json').read_text())
secret=json.loads(envelope['SecretString'])
secret['otherWriter']='preserved'
envelope.update(SecretString=json.dumps(secret),VersionId='external-write')
(root/'secret.json').write_text(json.dumps(envelope))
"""
        return self.start(["bash", str(self.scripts / "with-app-secret-lock.sh"), sys.executable, "-c", command,
                           str(self.root), "pause" if pause else "go"])

    def assert_final_secret(self):
        secret = json.loads(self.read("secret.json")["SecretString"])
        self.assertEqual(secret["otherWriter"], "preserved")
        deployments = json.loads(secret["EZIL_AWS_LIFECYCLE_DEPLOYMENTS"])
        self.assertEqual(deployments["ap-south-1"], self.read("target.json")["settings"]["deployment"])
        self.assertEqual(deployments["us-east-1"], {"amiId": "other-region", "untouched": [3, 4]})

    def assert_operator_blocks(self, script, flags):
        locks = self.root / "locks"
        locks.mkdir()
        with (locks / "operator.lock").open("w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            # A different checkout and a different release must use the SAME lock.
            other = self.root / "other-checkout/deploy/aws/mum"
            shutil.copytree(self.scripts, other)
            for scripts, release in ((self.scripts, "release-a"), (other, "release-b")):
                result = self.start(["bash", str(scripts / script), *flags, "--config", str(self.root / "missing-config"),
                                     "--release-dir", str(self.root / release)])
                output = self.finish(result, 1)
                self.assertIn("holds the common lock", output)
                self.assertEqual((self.root / "calls.jsonl").read_text(), "")
                self.assertFalse((self.root / release).exists())

    def test_rebuild_dry_lock_precedes_config_read_across_checkouts(self):
        self.assert_operator_blocks("rebuild-ami.sh", ["--desktop-image", "desktop:test", "--source-sha", "aaaaaaaa", "--recipe-version", "1.0.2"])

    def test_promotion_apply_lock_precedes_config_read_across_checkouts(self):
        self.assert_operator_blocks("promote-ami.sh", ["--ami", "ami-" + "2" * 17, "--apply"])

    def test_synth_directories_unique_and_cleaned(self):
        for _ in range(2):
            self.finish(self.start(["bash", str(self.scripts / "rebuild-ami.sh"), "--desktop-image", "desktop:test",
                "--source-sha", "aaaaaaaa", "--recipe-version", "1.0.2", "--config", str(self.root / "ami-config.json"),
                "--release-dir", str(self.root / "release")]))
        calls = [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]
        paths = [Path(call[call.index("--prefix") + 1]) for call in calls if call[0] == "npm"]
        self.assertEqual(len(set(paths)), 2)
        self.assertTrue(all(str(path).startswith("/tmp/ezil-mum.") and not path.exists() for path in paths))
        self.assertEqual(self.read("ami-config.json"), self.read("original-ami-config.json"))

    def test_update_waits_for_external_writer_before_first_read(self):
        writer = self.writer(pause=True)
        self.wait_for("writer-started")
        update = self.updater()
        time.sleep(0.15)
        self.assertIsNone(update.poll())
        self.assertEqual((self.root / "calls.jsonl").read_text(), "")
        (self.root / "writer-continue").touch()
        self.finish(writer)
        self.finish(update)
        self.assert_final_secret()

    def test_external_writer_waits_across_version_recheck_put_and_verify(self):
        self.save("scenario.json", {"secret_pause": True})
        update = self.updater()
        self.wait_for("secret-recheck")
        writer = self.writer()
        time.sleep(0.15)
        self.assertIsNone(writer.poll())
        self.assertFalse((self.root / "writer-started").exists())
        (self.root / "secret-continue").touch()
        self.finish(update)
        self.finish(writer)
        self.assert_final_secret()
        calls = [json.loads(line) for line in (self.root / "calls.jsonl").read_text().splitlines()]
        operations = [call[call.index("secretsmanager") + 1] for call in calls]
        self.assertEqual(operations, ["get-secret-value", "get-secret-value", "put-secret-value", "get-secret-value"])

    def test_killed_wrapper_keeps_child_writer_locked(self):
        writer = self.writer(pause=True)
        self.wait_for("writer-started")
        writer.terminate()
        writer.wait(timeout=5)
        with (self.root / "locks/app-secret.lock").open("r+") as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        update = self.updater()
        time.sleep(0.15)
        self.assertIsNone(update.poll())
        (self.root / "writer-continue").touch()
        self.finish(update)
        self.assert_final_secret()

    def test_readback_checks_version_even_if_payload_matches(self):
        self.save("scenario.json", {"secret_verify_version": True})
        self.assertIn("secret operation refused", self.finish(self.updater(), 1))

    def test_wrapper_returns_child_failure_and_releases_lock(self):
        self.finish(self.start(["bash", str(self.scripts / "with-app-secret-lock.sh"), "bash", "-c", "exit 23"]), 23)
        with (self.root / "locks/app-secret.lock").open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)


if __name__ == "__main__":
    unittest.main(verbosity=2)
