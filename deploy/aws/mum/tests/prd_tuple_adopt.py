#!/usr/bin/env python3
"""Offline tests for an append-only production tuple recovery."""
from contextlib import nullcontext
from copy import deepcopy
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rebase_release as release
import rebase_tuple_adopt as adopt


def make_tuple(version):
    prefix = "arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-prd-"
    return {
        "amiId": "ami-" + version * 17, "launchTemplateVersion": version,
        "stateMachineVersionArn": prefix + "lifecycle:" + version,
        "lowerImageDigest": "sha256:" + "a" * 64, "previousLowerImageDigest": "sha256:" + "b" * 64,
        "preparationStateMachineVersionArn": prefix + "rebase-preparation:" + version,
        "recoveryStateMachineVersionArn": prefix + "recovery:" + version,
    }


class TupleAdoptTests(unittest.TestCase):
    def setUp(self):
        release.use_namespace("prd")
        self.addCleanup(release.use_namespace, "mum")
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "promotion-ledger.json"
        self.app = "a" * 40
        self.digest = "b" * 64
        self.recovery_digest = "c" * 64
        self.source, self.target = make_tuple("5"), make_tuple("6")
        repo = release.json_tool.REPOSITORY
        self.registry = [{**self.target, "schemaVersion": 1, "accountId": "452630323510", "region": "ap-south-1",
                          "namespace": "prd", "launchTemplateId": release.json_tool.LAUNCH_TEMPLATE,
                          "recipeVersion": "1.0.6", "lowerImageRef": repo + "@" + self.target["lowerImageDigest"],
                          "previousLowerImageRef": repo + "@" + self.target["previousLowerImageDigest"],
                          "agentCommit": self.app, "createdAt": "2026-11-20T10:00:00.000Z"}]
        self.current, self.previous = self.secret(self.target, "restored"), self.secret(self.source, "intermediate")
        before = release.observed_state(self.secret(self.target, "historical-promote"),
                                        self.deployment(self.target), self.app)
        rollback = release.observed_state(self.secret(self.source, "historical-rollback"),
                                          self.deployment(self.source), self.app)
        expected = {key: value for key, value in rollback.items() if key != "secretVersionId"}
        self.ledger = {
            "schemaVersion": 1,
            "entries": [
                {"generation": 1, "planSha256": self.digest, "operation": "promote-canary",
                 "state": "completed", **before},
                {"generation": 2, "planSha256": self.digest, "operation": "rollback",
                 "state": "pending", "before": before, "expected": expected},
                {"generation": 3, "planSha256": self.digest, "operation": "rollback",
                 "state": "completed", **rollback},
            ],
        }
        self.plan = {
            "ledgerGeneration": 3, "basisGeneration": 1, "expectedCurrentVersion": "restored",
            "expectedPreviousVersion": "intermediate",
            "currentTupleSha256": adopt.tuple_hash(self.target),
            "previousTupleSha256": adopt.tuple_hash(self.source),
        }
        self.raw = json.dumps(self.ledger, indent=4) + "\n"
        self.path.write_text(self.raw)

    def deployment(self, value):
        return {"accountId": "452630323510", "region": "ap-south-1", "namespace": "prd",
                "launchTemplateId": release.json_tool.LAUNCH_TEMPLATE, **value, "releases": self.registry}

    def secret(self, value, version, **extra):
        return {"VersionId": version, "SecretString": json.dumps({
            release.json_tool.KEY: {"ap-south-1": self.deployment(value)},
            "EZIL_AWS_KILL_SWITCH": "0", **extra,
        })}

    def observe(self, plan=None, current=None, previous=None):
        return adopt.observations(
            release, plan or self.plan, self.ledger, current or self.current,
            previous or self.previous, self.recovery_digest,
        )

    def test_preserve_entry_bytes_and_next_tool_can_load(self):
        entry = self.observe()
        self.assertEqual((entry["generation"], entry["basisGeneration"], entry["operation"]), (4, 1, "tuple-adopt"))
        self.assertEqual(entry["before"]["secretVersionId"], "historical-rollback")
        self.assertEqual(entry["expected"]["secretVersionId"], "restored")
        release.write_ledger_append(self.path, self.ledger, entry)
        self.assertEqual(release.load_ledger(self.path)["entries"], [*self.ledger["entries"], entry])
        split = self.raw.rfind("]")
        self.assertTrue(self.path.read_text().startswith(self.raw[:split]))
        self.assertTrue(self.path.read_text().endswith(self.raw[split:]))
        with self.assertRaisesRegex(ValueError, "ledger changed"):
            release.write_ledger_append(self.path, self.ledger, entry)

    def test_unchanged_parsed_history_with_different_bytes_is_refused(self):
        original = adopt.sha(self.path.read_bytes())
        self.path.write_text(self.raw.replace("    ", "  "))
        self.assertEqual(release.load_ledger(self.path), self.ledger)
        with self.assertRaisesRegex(ValueError, "ledger bytes changed"):
            release.write_ledger_append(self.path, self.ledger, self.observe(), original)

    def test_fresh_readback_refuses_same_source_stale_image_or_rendered_tuple(self):
        command = "12345678-1234-1234-1234-123456789abc"
        plan = self.plan | {"appImageId": "sha256:" + "e" * 64, "instanceId": "i-" + "1" * 17}
        expected = {
            "deployment": release.rebase_app.public_deployment(self.deployment(self.target)),
            "imageId": plan["appImageId"], "sha": self.app, "appGate": False, "killSwitch": "0",
        }
        entry = self.observe()
        for state in (expected, expected | {"imageId": "sha256:" + "f" * 64},
                      expected | {"deployment": release.rebase_app.public_deployment(self.deployment(self.source))}):
            invocation = {"InstanceId": plan["instanceId"], "CommandId": command,
                          "Status": "Success", "ResponseCode": 0, "StandardOutputContent": json.dumps(state)}
            with self.subTest(state=state == expected), patch.object(release, "aws",
                side_effect=[{"Command": {"CommandId": command}}, invocation]) as aws:
                if state == expected:
                    self.assertEqual(adopt.verify_fresh_app(release, plan, self.current, entry, self.recovery_digest), command)
                    self.assertEqual(aws.call_args_list[0].args[:2], ("ssm", "send-command"))
                    self.assertEqual(aws.call_args_list[1].args[:2], ("ssm", "get-command-invocation"))
                    script = json.loads(aws.call_args_list[0].args[-1])["commands"][0]
                    compile(script.split("<<'EZIL_TUPLE_READBACK'\n", 1)[1].rsplit("\nEZIL_TUPLE_READBACK", 1)[0],
                            "<fresh-readback>", "exec")
                    self.assertNotIn("install-host", script)
                else:
                    with self.assertRaisesRegex(ValueError, "fresh running app differs"):
                        adopt.verify_fresh_app(release, plan, self.current, entry, self.recovery_digest)

    def test_failed_final_provider_cas_never_appends(self):
        plan = self.plan | {"authorization": "ratified:offline-fixture", "ledgerSha256": adopt.sha(self.raw.encode())}
        with patch.object(release, "LEDGER_PATH", self.path), \
             patch.object(release.json_tool, "app_secret_lock", return_value=nullcontext(None)), \
             patch.object(release.json_tool, "secret_aws", side_effect=[self.current, self.previous, self.previous]), \
             patch.object(adopt, "read_recovery", return_value=plan), patch.object(adopt, "assert_lease") as lease, \
             patch.object(adopt, "verify_cloudtrail"), patch.object(adopt, "verify_app"), \
             patch.object(adopt, "verify_fresh_app"), patch.object(release, "write_ledger_append") as append:
            with self.assertRaisesRegex(ValueError, "inputs changed"):
                adopt.run(release, self.path, self.recovery_digest, "owner", True)
            lease.assert_called_once()
            append.assert_not_called()
        self.assertEqual(self.path.read_text(), self.raw)

    def test_provider_drift_and_gate_change_fail_closed(self):
        for snapshot in (
            self.secret(self.target, "incorrect-version"),
            self.secret(self.source, "restored"),
            self.secret(self.target, "restored", AWS_STANDALONE_REPO_OPEN_ENABLED="on"),
        ):
            with self.subTest(version=snapshot["VersionId"]), self.assertRaisesRegex(ValueError, "settings or registry"):
                self.observe(current=snapshot)
        with self.assertRaisesRegex(ValueError, "settings or registry"):
            self.observe(previous=self.secret(self.target, "intermediate"))
        altered = self.deployment(self.target) | {"releases": [self.registry[0] | {"recipeVersion": "1.0.7"}]}
        changed = deepcopy(self.current)
        changed["SecretString"] = json.dumps({release.json_tool.KEY: {"ap-south-1": altered}})
        with self.assertRaisesRegex(ValueError, "settings or registry"):
            self.observe(current=changed)
        with self.assertRaisesRegex(ValueError, "settings or registry"):
            self.observe(plan=self.plan | {"currentTupleSha256": "9" * 64})

    def test_ledger_validator_rejects_extra_change_and_false_history(self):
        valid = self.observe()
        for change in (
            {"basisGeneration": 2}, {"state": "pending"}, {"operation": "promote-canary"},
            {"appGitSha": "c" * 40}, {"registrySha256": "d" * 64}, {"invented": True},
        ):
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.validate_ledger({**self.ledger, "entries": [*self.ledger["entries"], valid | change]})
        tampered = deepcopy(valid)
        tampered["before"]["secretVersionId"] = "unrecorded"
        with self.assertRaisesRegex(ValueError, "historical tuple"):
            release.validate_ledger({**self.ledger, "entries": [*self.ledger["entries"], tampered]})

    def test_apply_rejects_unratified_plan_before_any_lease_or_provider_read(self):
        with patch.object(adopt, "read_recovery", return_value={"authorization": "pending-release-owner"}), \
             patch.object(adopt, "assert_lease") as lease, patch.object(release, "aws") as aws:
            with self.assertRaisesRegex(ValueError, "ratification"):
                adopt.run(release, self.path, self.recovery_digest, "owner", True)
            lease.assert_not_called()
            aws.assert_not_called()


if __name__ == "__main__":
    unittest.main()
