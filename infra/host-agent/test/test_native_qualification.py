"""Offline cross-language qualification receipt vectors. No host admission."""
import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from ezil_host import native_authority as authority
from ezil_host import native_qualification as qualification
from ezil_host import native_isolation as isolation
from ezil_host.config import Config
from ezil_host.fsops import Refused


class QualificationReceipt(unittest.TestCase):
    def setUp(self):
        prefix = "00000000-0000-4000-8000-00000000000"
        placement = {"generation": "11", "leaseEpoch": "29", "instanceId": "i-0123456789abcdef0"}
        self.target = {"v": 1, "computerId": prefix + "1", "bootId": prefix + "3", "placement": placement,
                       "profileDigest": "sha256:" + "a" * 64, "manifestSha256": "b" * 64}
        self.challenge = dict(self.target, nonce="AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
                              issuedAt="2026-11-19T00:00:00.000Z", expiresAt="2026-11-19T00:05:00.000Z")
        self.receipt = dict(self.challenge, ownerUserId=prefix + "2", placement=dict(placement, fenceToken=prefix + "4"),
                            expiresAt="2026-11-19T00:03:00.000Z")
        self.envelope = {"receipt": self.receipt,
                         "signature": "v1=30c732e7ae647c398480a78f5690c5ff741b5119472486c99b6e5524a2896285"}
        self.key = bytes.fromhex("141d9a358387b337ac9424aee29f6e1165cdc1cef6290dd55bd34fadbaf9d44d")
        self.now = authority.parse_ms("2026-11-19T00:00:01.000Z")

    def verify(self, *, envelope=None, challenge=None, target=None, key=None, now=None):
        return qualification.validate_receipt(envelope or self.envelope, challenge or self.challenge,
                                              target or self.target, key or self.key, now or self.now)

    def test_cross_language_mac_and_receipt(self):
        self.assertEqual(qualification.digest(authority.canonical(self.receipt)),
                         "0b36ebbb0cdceb08f0a1dcdc299817f40a652b9d7f7741af9fc6d996bec4e7b3")
        self.assertEqual(self.verify(), self.receipt)

    def test_rejects_supplied_or_stale_authority(self):
        modified = copy.deepcopy(self.envelope)
        modified["receipt"]["placement"]["fenceToken"] = self.receipt["computerId"]
        for overrides in (
            {"envelope": modified},
            {"key": b"x" * 32},
            {"challenge": dict(self.challenge, nonce="x" * 43)},
            {"target": dict(self.target, bootId=self.target["computerId"])},
            {"now": authority.parse_ms(self.receipt["expiresAt"])},
        ):
            with self.subTest(overrides=list(overrides)), self.assertRaises(Refused):
                self.verify(**overrides)

    def test_scoped_transport_uses_only_enrollment_origin_and_validates_the_receipt(self):
        cfg = Config(nativeQualificationComputerId=self.challenge["computerId"],
                     enrollUrl="https://os.example/api/internal/computers/enroll", caFile=None)
        with patch.object(qualification.http, "request", return_value=(200, authority.canonical(self.envelope))) as request:
            proof = qualification.request_placement_receipt(cfg, self.challenge, self.key)
        method, uri = request.call_args.args
        self.assertEqual((method, uri), ("POST", "https://os.example/api/compute/aws/native-qualification"))
        self.assertEqual(request.call_args.kwargs["body"], authority.canonical(self.challenge))
        self.assertEqual(request.call_args.kwargs["headers"]["X-Ezil-Signature"],
                         "v1=577b3fbde130ac5a30588218c7b98f6d2e8a53e6e2c137d5aac89555ac4d4a4e")
        self.assertEqual(self.verify(envelope=proof), self.receipt)

    def test_foreign_target_and_untrusted_origins_refuse_before_network(self):
        path = "/api/internal/computers/enroll"
        for uri, computer in (
            ("https://os.example" + path, self.target["bootId"]),
            ("http://os.example" + path, self.challenge["computerId"]),
            ("https://user@os.example" + path, self.challenge["computerId"]),
            ("https://os.example:8443" + path, self.challenge["computerId"]),
            ("https://os.example" + path + "?q=1", self.challenge["computerId"]),
        ):
            cfg = Config(nativeQualificationComputerId=computer, enrollUrl=uri, caFile=None)
            with self.subTest(uri=uri), patch.object(qualification.http, "request") as request:
                with self.assertRaises(Refused):
                    qualification.request_placement_receipt(cfg, self.challenge, self.key)
                request.assert_not_called()

    def test_refusal_and_transport_timeout_are_bounded(self):
        cfg = Config(nativeQualificationComputerId=self.challenge["computerId"],
                     enrollUrl="https://os.example/api/internal/computers/enroll", caFile=None)
        for result, error in (((404, b"{}"), None), ((200, b"x" * 4097), None), (None, TimeoutError())):
            with patch.object(qualification.http, "request", return_value=result, side_effect=error) as request:
                with self.assertRaises(Refused):
                    qualification.request_placement_receipt(cfg, self.challenge, self.key)
                self.assertEqual(request.call_count, 1)


class ProductionDeviceSpec(unittest.TestCase):
    def test_extra_runc_devices_are_masked_from_the_workload(self):
        spec = isolation.build_cli_spec(rootfs="/rootfs", artifact_dir="/artifact", workspace="/workspace",
                                       state_leaves=[], uid_base=300000, service_uid=299000,
                                       cgroups_path="/ezil/cgroup", netns_path="/run/netns/example",
                                       seccomp=None, args=["/artifact/cli"], env={}, cwd="/workspace")
        self.assertTrue({"/dev/full", "/dev/tty"}.issubset(spec["linux"]["maskedPaths"]))


if __name__ == "__main__":
    unittest.main()
