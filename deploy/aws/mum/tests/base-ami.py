#!/usr/bin/env python3
"""Reviewed Ubuntu base changes through the offline rebuild/fake-AWS harness."""
import json
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from rebase_release import BAKE_KEYS

spec = importlib.util.spec_from_file_location("base_json_tool", HERE.parent / "json-tool.py")
TOOL = importlib.util.module_from_spec(spec)
spec.loader.exec_module(TOOL)

OLD = "ami-" + "1" * 17
NEW = "ami-" + "9" * 17
NAME = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261023"


class BaseImageTests(unittest.TestCase):
    def run_bake(self, scenario=None, flag=NEW, apply=True):
        directory = tempfile.TemporaryDirectory(prefix="base-ami-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        subprocess.run([sys.executable, "-B", str(HERE / "fixture.py"), str(root),
                        json.dumps({"base_review": True, **(scenario or {})})], check=True, capture_output=True)
        args = ["bash", str(root / "checkout/deploy/aws/mum/rebuild-ami.sh"),
                "--desktop-image", "desktop:test", "--source-sha", "aaaaaaaa",
                "--recipe-version", "1.0.2", "--config", str(root / "ami-config.json"),
                "--release-dir", str(root / "release")]
        if flag is not None:
            args.extend(["--reviewed-base-ami", flag])
        if apply:
            args.append("--apply")
        result = subprocess.run(args, env=dict(os.environ, PATH=str(root / "bin") + ":" + os.environ["PATH"],
                                               PYTHONDONTWRITEBYTECODE="1"), capture_output=True, text=True, timeout=30)
        calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
        return root, result, calls

    def refuse(self, scenario, message, flag=NEW):
        root, result, calls = self.run_bake(scenario, flag)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(message, result.stdout + result.stderr)
        self.assertFalse(any("execute-change-set" in c or "start-image-pipeline-execution" in c for c in calls))
        self.assertFalse((root / "release/base-image-review.json").exists())
        self.assertEqual((root / "ami-config.json").read_bytes(), (root / "original-ami-config.json").read_bytes())
        return calls

    def test_accepted(self):
        for suffix in ("", ".1"):
            with self.subTest(suffix=suffix):
                root, result, calls = self.run_bake({"base_image": {"Name": NAME + suffix}})
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(json.loads((root / "release/base-image-review.json").read_text()),
                                 {"oldId": OLD, "newId": NEW, "name": NAME + suffix, "creationDate": "2026-10-23T10:41:57Z"})
                self.assertEqual(set(json.loads((root / "release/bake-inputs.json").read_text())), set(BAKE_KEYS))
                self.assertTrue((root / "release/ami-id.txt").exists())
                describe = next(i for i, c in enumerate(calls) if "describe-images" in c and NEW in c)
                execute = next(i for i, c in enumerate(calls) if "execute-change-set" in c)
                self.assertLess(describe, execute)
                self.assertIn(OLD, calls[describe])
                self.assertIn("ezil-admin", calls[describe])
                self.assertIn("ap-south-1", calls[describe])

    def test_without_flag(self):
        calls = self.refuse({}, "resolved SSM parameter changed", flag=None)
        self.assertFalse(any("describe-images" in c for c in calls))

    def test_flag_mismatch(self):
        self.refuse({}, "reviewed base AMI does not match resolved value", flag="ami-" + "8" * 17)

    def test_owner(self):
        self.refuse({"base_image": {"OwnerId": "452630323510"}}, "reviewed base image owner is not Canonical")

    def test_name(self):
        for name in (NAME.replace("24.04", "24x04"), NAME.replace("noble", "jammy"), NAME + "-extra", "prefix/" + NAME):
            with self.subTest(name=name):
                self.refuse({"base_image": {"Name": name}}, "reviewed base image name mismatch")

    def test_state(self):
        self.refuse({"base_image": {"State": "pending"}}, "reviewed base image is not available")

    def test_architecture(self):
        self.refuse({"base_image": {"Architecture": "arm64"}}, "reviewed base image architecture mismatch")

    def test_date_newer(self):
        for date in ("2026-10-16T10:41:57Z", "2026-10-17T10:41:57Z"):
            with self.subTest(date=date):
                self.refuse({"base_image": {"CreationDate": date}}, "reviewed base image is not newer")

    def test_date_valid(self):
        self.refuse({"base_image": {"CreationDate": "2026-10-24T10:41:57"}}, "invalid base image creation date")
        self.refuse({"base_old_date": "2026-10-17T10:41:57"}, "invalid base image creation date")

    def test_response(self):
        for scenario in ({"base_image": {"ImageId": OLD}}, {"base_image_count": 1}, {"base_image_page": True}):
            with self.subTest(scenario=scenario):
                self.refuse(scenario, "reviewed base image response mismatch")

    def test_image_identity(self):
        with self.assertRaisesRegex(ValueError, "invalid reviewed base AMI identity"):
            TOOL.base_image_review("invalid", NEW, "/nonexistent-base-images.json")

    def test_live_identity(self):
        with tempfile.TemporaryDirectory(prefix="base-identity-") as directory:
            path = Path(directory) / "stack.json"
            path.write_text(json.dumps({"Stacks": [{"StackStatus": "UPDATE_COMPLETE", "Parameters": [
                {"ParameterKey": "UbuntuAmiId", "ResolvedValue": "invalid"}]}]}))
            with self.assertRaisesRegex(ValueError, "invalid live base AMI ID"):
                TOOL.main(["base-ami-id", str(path)])

    def test_describe_failure(self):
        self.refuse({"base_describe_fail": True}, "synthetic describe-images failure")

    def test_path_changed(self):
        self.refuse({"base_path_changed": True}, "extra parameter change in change set")

    def test_other_parameters(self):
        self.refuse({"extra_parameter": True}, "extra parameter change in change set")

    def test_other_ssm(self):
        for key in ("FutureParameter", "DesktopImageDigest"):
            with self.subTest(key=key):
                self.refuse({"other_ssm": key}, "resolved SSM parameter changed")

    def test_parent_details(self):
        self.refuse({"base_parent_cause": "FutureParameter"}, "unexpected versioned Image Builder property change")
        self.refuse({"base_review": False, "base_unexplained_parent": True}, "unexpected versioned Image Builder property change")

    def test_live_parent_shape(self):
        # Live CloudFormation on 2026-10-23 reported the re-resolved parent as Static/DirectModification
        # with no causing entity; it is accepted only with the reviewed base change.
        root, result, _ = self.run_bake({"base_live_shape": True})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue((root / "release/ami-id.txt").exists())
        self.refuse({"base_review": False, "base_live_shape": True}, "unexpected versioned Image Builder property change")
        # The live shape is admitted only without a causing entity.
        self.refuse({"base_live_shape": True, "base_live_cause": "FutureParameter"}, "unexpected versioned Image Builder property change")

    def test_maintenance_emptied_previous(self):
        # A maintenance bake clears the previous lower: the emptied value arrives Static with no cause.
        # This fixture's template delta already lists Components, so direct modifications are
        # explained by the template rule here; the live 2026-10-27 change set is the refusal evidence.
        self.run_bake({"maintenance_static_empty": True})

    def test_unrelated_resource(self):
        self.refuse({"iam_change": True}, "unexpected resource change")

    def test_unchanged_and_dry(self):
        root, result, _ = self.run_bake({"base_review": False})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((root / "release/base-image-review.json").exists())
        root, result, calls = self.run_bake(apply=False)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((root / "release").exists())
        self.assertIn(NEW, result.stdout)
        self.assertFalse(any("describe-images" in c or "execute-change-set" in c for c in calls))

    def test_invalid_flag(self):
        for flag in ("", "--apply", "ami-wrong"):
            with self.subTest(flag=flag):
                calls = self.refuse({}, "reviewed base AMI must be an AMI ID", flag=flag)
                self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
