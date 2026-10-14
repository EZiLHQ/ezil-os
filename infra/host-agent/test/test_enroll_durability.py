"""A 200 retires the nonce only after its credentials are durable (Codex PR #200, round 4).

The app consumed the nonce when it answered 200, but the host's only proof of that answer is
what it writes next. So enroll() keeps the nonce in local state until tunnel.json,
control.key and enrolled.json are on the host root volume, then retires it in ONE lease
rewrite that also records the edge's routing. A malformed 200, a write error, or a crash
anywhere before that rewrite leaves the nonce, and a re-send takes the app's replay path
(same derived key, same Worker token for the epoch): the sequence converges on the same bytes.
No network: http.request is stubbed; the clock is faked.
"""
import base64
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import cli, config, enroll  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

IID = "i-0abc"
LEASE = {"v": 1, "computerId": "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1", "volumeId": "vol-1", "fsUuid": "f",
         "generation": 1, "leaseEpoch": 2, "nonce": "n" * 43, "provision": False}
SID, ZONE = "guac-1111111111114111-c1c1c1c1c1c14c1c", "ezil.org"
ANSWER = {"tunnelToken": "t" * 40, "controlKey": base64.b64encode(b"k" * 32).decode(), "sandboxId": SID, "zone": ZONE}
OK = (200, json.dumps(ANSWER).encode())
TRUNCATED = (200, OK[1][:37])


class Crash(BaseException):
    """The process dying mid-sequence: not an OSError, so nothing in enroll() catches it."""


class FakeClock:
    def __init__(self):
        self.now, self.sleeps = 1000.0, []

    def __enter__(self):
        self.p = [mock.patch.object(enroll.time, "monotonic", side_effect=lambda: self.now),
                  mock.patch.object(enroll.time, "sleep", side_effect=self.sleep)]
        for p in self.p:
            p.start()
        return self

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s

    def __exit__(self, *a):
        for p in self.p:
            p.stop()


class Durability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ezil-enroll-durability-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(runDir=os.path.join(self.tmp, "run"), stateDir=os.path.join(self.tmp, "state"),
                        enrollUrl="https://app.example.test/api/compute/aws/enroll",
                        enrollRetrySeconds=60, enrollRetryInitialSeconds=1,
                        userDataCopies=[os.path.join(self.tmp, "cloud", "*.txt")])
        os.makedirs(os.path.join(self.tmp, "cloud"))
        with open(os.path.join(self.tmp, "cloud", "user-data.txt"), "w") as f:
            f.write(LEASE["nonce"])
        enroll._write_private(os.path.join(self.cfg.runDir, "lease.json"), json.dumps(LEASE).encode())
        enroll._write_private(os.path.join(self.cfg.runDir, "identity.json"),
                              json.dumps({"document": json.dumps({"instanceId": IID}), "signature": "s" * 20}).encode())

    # -- helpers -------------------------------------------------------------------------
    def lease(self):
        return enroll.load_lease(self.cfg)

    def state(self, name):
        p = os.path.join(self.cfg.stateDir, name)
        if not os.path.exists(p):
            return None
        with open(p, "rb") as f:
            return f.read()

    def go(self, answers, fail_on=None, crash_on=None, instance_id=IID):
        """answers: per request. fail_on/crash_on: {basename: times} — OSError / Crash on the
        n-th write of that file (an OSError models a full disk; a Crash models the process dying)."""
        calls, real = [], enroll._write_private
        fail_on, crash_on = dict(fail_on or {}), dict(crash_on or {})

        def write(path, data):
            name = os.path.basename(path)
            if crash_on.get(name, 0) > 0:
                crash_on[name] -= 1
                raise Crash(name)
            if fail_on.get(name, 0) > 0:
                fail_on[name] -= 1
                raise OSError(28, "No space left on device", path)
            return real(path, data)

        def request(*a, **kw):
            calls.append(json.loads(kw["body"])["nonce"])
            return answers.pop(0)
        with FakeClock() as clock, mock.patch.object(enroll.http, "request", side_effect=request), \
                mock.patch.object(enroll, "_write_private", side_effect=write):
            try:
                return enroll.enroll(self.cfg, dict(self.lease()), instance_id=instance_id), calls, clock
            except Refused as e:
                return e, calls, clock

    def assert_enrolled(self):
        lease = self.lease()
        self.assertNotIn("nonce", lease)
        self.assertTrue(lease["nonceConsumed"])
        self.assertEqual((lease["sandboxId"], lease["zone"]), (SID, ZONE))
        self.assertEqual(json.loads(self.state("tunnel.json")), {"token": "t" * 40, "generation": 1, "leaseEpoch": 2})
        self.assertEqual(self.state("control.key"), b"k" * 32)
        self.assertEqual(json.loads(self.state(enroll.ENROLLED_FILE)),
                         {"instanceId": IID, "generation": 1, "leaseEpoch": 2, "sandboxId": SID, "zone": ZONE})
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "cloud", "user-data.txt")), "cloud-init copy wiped")

    def assert_nonce_kept(self):
        lease = self.lease()
        self.assertEqual(lease.get("nonce"), LEASE["nonce"])
        self.assertNotIn("nonceConsumed", lease)
        self.assertNotIn("sandboxId", lease)
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "cloud", "user-data.txt")))

    # -- a malformed 200 -----------------------------------------------------------------
    def test_a_malformed_200_keeps_the_nonce_and_the_replay_converges(self):
        result, calls, _ = self.go([TRUNCATED, OK])
        self.assertIs(result, True)
        self.assertEqual(calls, [LEASE["nonce"]] * 2, "the same nonce is re-sent: the app replays")
        self.assert_enrolled()

    def test_malformed_until_the_bound_keeps_the_nonce_and_stores_nothing(self):
        result, calls, clock = self.go([TRUNCATED] * 50)
        self.assertIsInstance(result, Refused)
        self.assertEqual(result.code, "enroll_response_malformed")
        self.assertLessEqual(sum(clock.sleeps), 60)
        self.assert_nonce_kept()
        for name in ("tunnel.json", "control.key", enroll.ENROLLED_FILE):
            self.assertIsNone(self.state(name), name)

    # -- a filesystem error mid-write ----------------------------------------------------
    def test_a_write_error_mid_sequence_keeps_the_nonce_and_the_replay_converges(self):
        for name in ("tunnel.json", "control.key", enroll.ENROLLED_FILE, "lease.json"):
            with self.subTest(failing=name):
                self.setUp()
                result, calls, _ = self.go([OK, OK], fail_on={name: 1})
                self.assertIs(result, True)
                self.assertEqual(calls, [LEASE["nonce"]] * 2)
                self.assert_enrolled()

    def test_a_write_error_until_the_bound_keeps_the_nonce(self):
        result, _, _ = self.go([OK] * 50, fail_on={"control.key": 10 ** 6})
        self.assertIsInstance(result, Refused)
        self.assertEqual(result.code, "enroll_persist_failed")
        self.assert_nonce_kept()

    # -- a crash between writes ----------------------------------------------------------
    def test_a_crash_before_the_lease_rewrite_keeps_the_nonce_and_a_new_run_converges(self):
        for name in ("tunnel.json", "control.key", enroll.ENROLLED_FILE, "lease.json"):
            with self.subTest(crash_at=name):
                self.setUp()
                with self.assertRaises(Crash):
                    self.go([OK], crash_on={name: 1})
                self.assert_nonce_kept()
                # The unit fails; a later activation (or a same-instance reboot) runs again and
                # replays: same answer, same bytes.
                result, calls, _ = self.go([OK])
                self.assertIs(result, True)
                self.assertEqual(calls, [LEASE["nonce"]])
                self.assert_enrolled()

    def test_the_nonce_is_retired_last_in_one_lease_write_that_also_carries_the_routing(self):
        order, real = [], enroll._write_private

        def write(path, data):
            order.append(os.path.basename(path))
            if os.path.basename(path) == "lease.json":
                order.append(json.loads(data))
            return real(path, data)
        wiped = []
        with FakeClock(), mock.patch.object(enroll.http, "request", return_value=OK), \
                mock.patch.object(enroll, "_write_private", side_effect=write), \
                mock.patch.object(enroll, "wipe", side_effect=lambda p: wiped.append(order[:]) or os.unlink(p)):
            self.assertIs(enroll.enroll(self.cfg, dict(self.lease()), instance_id=IID), True)
        names = [o for o in order if isinstance(o, str)]
        self.assertEqual(names, ["tunnel.json", "control.key", enroll.ENROLLED_FILE, "lease.json"])
        retired = order[-1]
        self.assertNotIn("nonce", retired)
        self.assertTrue(retired["nonceConsumed"])
        self.assertEqual((retired["sandboxId"], retired["zone"]), (SID, ZONE))
        self.assertEqual(len(wiped), 1, "the cloud-init copy is wiped once...")
        self.assertEqual(wiped[0][-2], "lease.json", "...and only after the lease retired the nonce")

    def test_settled_refusals_still_wipe_the_nonce(self):
        result, calls, _ = self.go([(409, b'{"error":"enroll_conflict"}')])
        self.assertEqual(result.code, "enroll_refused")
        self.assertNotIn("nonce", self.lease())
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "cloud", "user-data.txt")))

    def test_a_stale_temp_from_a_crashed_write_does_not_wedge_the_next(self):
        os.makedirs(self.cfg.stateDir, mode=0o700, exist_ok=True)
        stale = os.path.join(self.cfg.stateDir, f"tunnel.json.tmp.{os.getpid()}")
        with open(stale, "w") as f:
            f.write("half")
        result, _, _ = self.go([OK])
        self.assertIs(result, True)
        self.assertFalse(os.path.exists(stale))
        self.assert_enrolled()


class ReuseAfterCrash(unittest.TestCase):
    """A crash AFTER the lease retired the nonce but before the cloud-init copies were wiped:
    the same instance reboots in the same epoch, re-reads user data (nonce back in the lease),
    and cli.enroll_or_reuse reuses the durable credentials (enrolled.json was written BEFORE
    the nonce was retired) in one lease rewrite, wiping the copies. No request is sent."""

    def setUp(self):
        Durability.setUp(self)

    lease = Durability.lease
    state = Durability.state
    go = Durability.go
    assert_enrolled = Durability.assert_enrolled

    def test_reboot_after_a_crash_in_the_copy_wipe_reuses_without_posting(self):
        with mock.patch.object(enroll, "wipe_nonce_copies", side_effect=Crash("copies")):
            with self.assertRaises(Crash):
                self.go([OK])
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "cloud", "user-data.txt")))
        # reboot: the lease step re-reads user data (the nonce is back), runDir is fresh tmpfs
        enroll._write_private(os.path.join(self.cfg.runDir, "lease.json"), json.dumps(LEASE).encode())
        lease_writes, real = [], enroll._write_private

        def write(path, data):
            if os.path.basename(path) == "lease.json":
                lease_writes.append(json.loads(data))
            return real(path, data)
        with mock.patch.object(enroll.http, "request", side_effect=AssertionError("must not re-post")), \
                mock.patch.object(enroll, "_write_private", side_effect=write):
            out = cli.enroll_or_reuse(self.cfg, dict(LEASE))
        self.assertIn("same-instance reboot", out)
        self.assertEqual(len(lease_writes), 1, "routing and nonce retirement in ONE lease write")
        self.assertEqual((lease_writes[0]["sandboxId"], lease_writes[0].get("nonce")), (SID, None))
        self.assert_enrolled()


if __name__ == "__main__":
    unittest.main()
