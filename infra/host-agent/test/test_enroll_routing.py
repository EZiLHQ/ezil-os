"""enroll.enroll() keeps the browser-host binding the app returns (Codex PR #200).

The edge trusts `x-forwarded-host` only for `aws-<port>-<sandboxId>-aws.<zone>`, and it reads
sandboxId + zone from the lease. Enrollment is the only place the host learns them, so a
successful answer records both in the lease (0600), and an answer without a well-formed
binding is malformed: no token, no key, no binding stored, and the nonce is still wiped.
No network: http.request is stubbed.
"""
import base64
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import config, edge, enroll  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

LEASE = {"v": 1, "computerId": "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1", "volumeId": "vol-1", "fsUuid": "f",
         "generation": 1, "leaseEpoch": 2, "nonce": "n" * 43, "provision": False}
OK = {"tunnelToken": "t" * 40, "controlKey": base64.b64encode(b"k" * 32).decode(),
      "sandboxId": "guac-1111111111114111-c1c1c1c1c1c14c1c", "zone": "ezil.org"}


class EnrollRouting(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ezil-enroll-routing-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(runDir=os.path.join(self.tmp, "run"), stateDir=os.path.join(self.tmp, "state"),
                        enrollUrl="https://app.example.test/api/compute/aws/enroll")
        enroll._write_private(os.path.join(self.cfg.runDir, "lease.json"), json.dumps(LEASE).encode())
        enroll._write_private(os.path.join(self.cfg.runDir, "identity.json"),
                              json.dumps({"document": "{}", "signature": "s" * 20}).encode())

    def run_enroll(self, answer):
        with mock.patch.object(enroll.http, "request", return_value=(200, json.dumps(answer).encode())):
            return enroll.enroll(self.cfg, dict(LEASE))

    def lease(self):
        return enroll.load_lease(self.cfg)

    def test_success_records_the_binding_in_the_lease(self):
        self.assertTrue(self.run_enroll(OK))
        lease = self.lease()
        self.assertEqual((lease["sandboxId"], lease["zone"]), (OK["sandboxId"], OK["zone"]))
        self.assertNotIn("nonce", lease)
        self.assertTrue(lease["nonceConsumed"])
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.cfg.runDir, "lease.json")).st_mode), 0o600)
        # ...and the edge built from that lease trusts exactly the Worker's browser host.
        e = edge.Edge(config.Config({}), lease, b"k" * 32, sequencer=mock.Mock())
        self.assertTrue(e.browser_host_re.fullmatch(f"aws-8181-{OK['sandboxId']}-aws.ezil.org"))
        self.assertIsNone(e.browser_host_re.fullmatch(f"aws-8181-{OK['sandboxId']}.ezil.org"))

    def test_an_answer_without_a_well_formed_binding_is_malformed_and_stores_nothing(self):
        bad = [{k: v for k, v in OK.items() if k != "zone"}, {k: v for k, v in OK.items() if k != "sandboxId"},
               {**OK, "sandboxId": "c1c1c1c1c1c14c1c"}, {**OK, "sandboxId": "guac-A-b"}, {**OK, "zone": "org"},
               {**OK, "zone": "ezil..org"}, {**OK, "zone": "evil.org/x"}, {**OK, "zone": 7}, {**OK, "zone": "10.0.0.1"}]
        for answer in bad:
            with self.subTest(answer=answer):
                self.setUp()
                with self.assertRaises(Refused) as cm:
                    self.run_enroll(answer)
                self.assertEqual(cm.exception.code, "enroll_response_malformed")
                self.assertFalse(os.path.exists(os.path.join(self.cfg.stateDir, enroll.TOKEN_FILE)))
                self.assertFalse(os.path.exists(os.path.join(self.cfg.stateDir, "control.key")))
                lease = self.lease()
                self.assertNotIn("sandboxId", lease)
                self.assertNotIn("nonce", lease)


if __name__ == "__main__":
    unittest.main()
