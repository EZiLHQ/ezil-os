"""Offline cross-language qualification receipt vectors. No host admission."""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from ezil_host import native_authority as authority
from ezil_host import native_qualification as qualification
from ezil_host import native_isolation as isolation
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


class ProductionDeviceSpec(unittest.TestCase):
    def test_extra_runc_devices_are_masked_from_the_workload(self):
        spec = isolation.build_cli_spec(rootfs="/rootfs", artifact_dir="/artifact", workspace="/workspace",
                                       state_leaves=[], uid_base=300000, service_uid=299000,
                                       cgroups_path="/ezil/cgroup", netns_path="/run/netns/example",
                                       seccomp=None, args=["/artifact/cli"], env={}, cwd="/workspace")
        self.assertTrue({"/dev/full", "/dev/tty"}.issubset(spec["linux"]["maskedPaths"]))


if __name__ == "__main__":
    unittest.main()
