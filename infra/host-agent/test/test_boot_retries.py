"""Bounded retries in the boot chain (Codex PR #200, round 2). No network, no disks: http,
the clock and the device probes are stubbed.

- enroll: the nonce is re-sent only after an answer that consumed nothing (transport error,
  the app's `retryable: true`, a 5xx the app did not author); every other answer settles it
  (wiped, final). Retrying is bounded; when it ends the nonce is KEPT.
- guard: the data volume is attached after the instance runs, so the guard waits, bounded,
  for it (wake: its by-id link; provision: any non-root EBS disk) before resolving it.
- lease: an IMDS transport error early in boot is retried, bounded; an HTTP refusal is not.
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
from ezil_host import config, enroll, guard, lease as leasemod  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

LEASE = {"v": 1, "computerId": "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1", "volumeId": "vol-1", "fsUuid": "f",
         "generation": 1, "leaseEpoch": 2, "nonce": "n" * 43, "provision": False}
OK = (200, json.dumps({"tunnelToken": "t" * 40, "controlKey": base64.b64encode(b"k" * 32).decode(),
                       "sandboxId": "guac-1111111111114111-c1c1c1c1c1c14c1c", "zone": "ezil.org"}).encode())
RETRY = (503, json.dumps({"error": "enroll_describe_unavailable", "retryable": True}).encode())
PLATFORM_502 = (502, b"<html>502 Bad Gateway</html>")


class FakeClock:
    """time.monotonic/time.sleep for one module: sleeping advances the clock."""

    def __init__(self, module):
        self.now, self.sleeps = 1000.0, []
        p1 = mock.patch.object(module.time, "monotonic", side_effect=lambda: self.now)
        p2 = mock.patch.object(module.time, "sleep", side_effect=self.sleep)
        self.patches = (p1, p2)

    def sleep(self, s):
        self.sleeps.append(s)
        self.now += s

    def __enter__(self):
        for p in self.patches:
            p.start()
        return self

    def __exit__(self, *a):
        for p in self.patches:
            p.stop()


class EnrollRetry(unittest.TestCase):
    def setUp(self):
        evidence = mock.patch.object(enroll.guard, "committed_digest", return_value="sha256:" + "a" * 64)
        evidence.start()
        self.addCleanup(evidence.stop)
        self.tmp = tempfile.mkdtemp(prefix="ezil-boot-retries-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(runDir=os.path.join(self.tmp, "run"), stateDir=os.path.join(self.tmp, "state"),
                        enrollUrl="https://app.example.test/api/compute/aws/enroll",
                        enrollRetrySeconds=60, enrollRetryInitialSeconds=1)
        enroll._write_private(os.path.join(self.cfg.runDir, "lease.json"), json.dumps(LEASE).encode())
        enroll._write_private(os.path.join(self.cfg.runDir, "identity.json"),
                              json.dumps({"document": "{}", "signature": "s" * 20}).encode())

    def run_enroll(self, answers):
        calls = []

        def request(*a, **kw):
            calls.append(json.loads(kw["body"])["nonce"])
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a
        with FakeClock(enroll) as clock, mock.patch.object(enroll.http, "request", side_effect=request):
            try:
                return enroll.enroll(self.cfg, dict(LEASE)), calls, clock
            except Refused as e:
                return e, calls, clock

    def lease(self):
        return enroll.load_lease(self.cfg)

    def test_answers_that_consumed_nothing_are_retried_with_the_same_nonce_then_enrolled(self):
        result, calls, clock = self.run_enroll([ConnectionResetError("reset"), RETRY, PLATFORM_502, OK])
        self.assertIs(result, True)
        self.assertEqual(calls, [LEASE["nonce"]] * 4)
        self.assertEqual(clock.sleeps, [1, 2, 4])            # bounded exponential backoff
        self.assertTrue(self.lease()["nonceConsumed"])
        self.assertNotIn("nonce", self.lease())

    def test_settled_answers_are_final_and_wipe_the_nonce(self):
        finals = [(403, b'{"error":"enroll_nonce_invalid"}'), (502, b'{"error":"tunnel_unavailable"}'),
                  (409, b'{"error":"enroll_conflict"}'), (403, b'{"error":"enroll_volume_mismatch","retryable":false}'),
                  (404, b"not found"), (400, b"<html>bad</html>")]
        for answer in finals:
            with self.subTest(answer=answer):
                self.setUp()
                result, calls, clock = self.run_enroll([answer])
                self.assertIsInstance(result, Refused)
                self.assertEqual(result.code, "enroll_refused")
                self.assertEqual(len(calls), 1)
                self.assertEqual(clock.sleeps, [])
                self.assertNotIn("nonce", self.lease())

    def test_retrying_is_bounded_and_keeps_the_nonce_when_it_ends(self):
        result, calls, clock = self.run_enroll([RETRY] * 50)
        self.assertIsInstance(result, Refused)
        self.assertEqual(result.code, "enroll_retry_exhausted")
        self.assertLessEqual(sum(clock.sleeps), 60)
        self.assertEqual(len(calls), len(clock.sleeps) + 1)
        self.assertEqual(self.lease()["nonce"], LEASE["nonce"])  # a later run may still use it
        self.assertNotIn("nonceConsumed", self.lease())

    def test_classification(self):
        self.assertFalse(enroll.retryable(*OK))
        self.assertTrue(enroll.retryable(*RETRY))
        self.assertTrue(enroll.retryable(*PLATFORM_502))
        self.assertTrue(enroll.retryable(504, b'{"message":"gateway timeout"}'))   # not app-authored
        self.assertFalse(enroll.retryable(502, b'{"error":"tunnel_unavailable"}'))  # app-authored, final
        self.assertFalse(enroll.retryable(503, b'{"error":"x","retryable":"yes"}'))  # only literal true
        self.assertFalse(enroll.retryable(429, b"slow down"))


class VolumeWait(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ezil-volume-wait-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(deviceByIdDir=self.tmp, volumeWaitSeconds=30, volumeWaitIntervalSeconds=2)
        self.link = os.path.join(self.tmp, "nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0")
        self.target = os.path.join(self.tmp, "nvme0n1")
        open(self.target, "w").close()

    def test_wake_waits_for_the_volume_link_then_resolves_it(self):
        with FakeClock(guard) as clock, mock.patch.object(guard, "device_for_volume", return_value="/dev/nvme1n1") as dev:
            def sleep(s):
                clock.sleeps.append(s)
                clock.now += s
                if len(clock.sleeps) == 3:
                    os.symlink(self.target, self.link)        # attached during the third wait
            with mock.patch.object(guard.time, "sleep", side_effect=sleep):
                self.assertEqual(guard.wait_device_for_volume(self.cfg, "vol-0123456789abcdef0"), "/dev/nvme1n1")
        self.assertEqual(clock.sleeps, [2, 2, 2])
        dev.assert_called_once_with(self.cfg, "vol-0123456789abcdef0")

    def test_wake_wait_is_bounded_and_then_refuses_as_before(self):
        with FakeClock(guard) as clock:
            with self.assertRaisesRegex(Refused, "volume_device_missing"):
                guard.wait_device_for_volume(self.cfg, "vol-0123456789abcdef0")
        self.assertEqual(sum(clock.sleeps), 30)

    def test_mount_data_uses_the_wait(self):
        with mock.patch.object(guard, "wait_device_for_volume", side_effect=Refused("volume_device_missing", "x")) as w:
            with self.assertRaisesRegex(Refused, "volume_device_missing"):
                guard.mount_data(self.cfg, {"volumeId": "vol-0123456789abcdef0"})
        w.assert_called_once()

    def test_provision_waits_for_a_non_root_disk_then_resolves_it(self):
        seen = [set(), set(), {("vol-0123456789abcdef0", "/dev/nvme1n1")}]
        with FakeClock(guard) as clock, mock.patch.object(guard, "_root_devices", return_value={"259:0"}), \
                mock.patch.object(guard, "_ebs_candidates", side_effect=lambda *a: seen.pop(0) if seen else {1}), \
                mock.patch.object(guard, "provision_volume", return_value="vol-0123456789abcdef0") as prov:
            self.assertEqual(guard.wait_provision_volume(self.cfg), "vol-0123456789abcdef0")
        self.assertEqual(clock.sleeps, [2, 2])
        prov.assert_called_once_with(self.cfg)

    def test_fetch_lease_provision_uses_the_wait(self):
        raw = json.dumps({**LEASE, "volumeId": None, "provision": True}).encode()
        self.cfg.update(runDir=os.path.join(self.tmp, "run"))
        with mock.patch.object(enroll, "_imds_lease_and_identity", return_value=(raw, "{}", "sig")), \
                mock.patch.object(leasemod, "parse", return_value=dict(LEASE, volumeId=None, provision=True)), \
                mock.patch.object(guard, "wait_provision_volume", return_value="vol-0123456789abcdef0") as w:
            self.assertEqual(enroll.fetch_lease(self.cfg)["volumeId"], "vol-0123456789abcdef0")
        w.assert_called_once_with(self.cfg)


class ImdsRetry(unittest.TestCase):
    def test_transport_errors_are_retried_bounded_http_refusals_are_not(self):
        cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        cfg.update(imdsRetrySeconds=10)
        answers = [ConnectionRefusedError(), ConnectionResetError(), ("ud", "doc", "sig")]

        def lease_and_identity(_self):
            a = answers.pop(0)
            if isinstance(a, Exception):
                raise a
            return a
        with FakeClock(enroll) as clock, mock.patch.object(leasemod.Imds, "lease_and_identity", lease_and_identity):
            self.assertEqual(enroll._imds_lease_and_identity(cfg), ("ud", "doc", "sig"))
        self.assertEqual(len(clock.sleeps), 2)
        with FakeClock(enroll) as clock, mock.patch.object(leasemod.Imds, "lease_and_identity", side_effect=OSError("down")):
            with self.assertRaises(OSError):
                enroll._imds_lease_and_identity(cfg)
        self.assertLessEqual(sum(clock.sleeps), 11)
        with FakeClock(enroll) as clock, mock.patch.object(leasemod.Imds, "lease_and_identity",
                                                           side_effect=leasemod.LeaseError("imds_get_failed: 404")):
            with self.assertRaises(leasemod.LeaseError):
                enroll._imds_lease_and_identity(cfg)
        self.assertEqual(clock.sleeps, [])


if __name__ == "__main__":
    unittest.main()
