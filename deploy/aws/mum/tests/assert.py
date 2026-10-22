#!/usr/bin/env python3
import json
from pathlib import Path
import sys

root, mode = Path(sys.argv[1]), sys.argv[2]
calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
output = (root / "output").read_text()


def has(*parts):
    return any(all(part in call for part in parts) for call in calls)


def read(name):
    return json.loads((root / name).read_text())


def preserved():
    before, after = read("original-secret.json"), json.loads(read("secret.json")["SecretString"])
    for key in before.keys() - {"EZIL_AWS_LIFECYCLE_DEPLOYMENTS"}:
        assert before[key] == after[key]
    b, a = before["EZIL_AWS_LIFECYCLE_DEPLOYMENTS"], after["EZIL_AWS_LIFECYCLE_DEPLOYMENTS"]
    assert type(b) is type(a)
    b, a = (json.loads(b), json.loads(a)) if isinstance(b, str) else (b, a)
    assert b["us-east-1"] == a["us-east-1"]
    for key in b["ap-south-1"].keys() - {"amiId", "stateMachineVersionArn"}:
        assert b["ap-south-1"][key] == a["ap-south-1"][key]
    assert "synthetic-private-do-not-print" not in output
    assert "keepSynthetic" not in output
    return b, a


if mode == "dry-rebuild":
    assert not any(has(x) for x in ("tag", "push", "get-login-password", "archive", "create-change-set", "start-image-pipeline-execution"))
    assert not (root / "release").exists()
    assert "UsePreviousValue" in output and "FutureParameter" in output
    sequence = ["docker tag", "push", "batch-get-image", "archive", "s3 cp", "create-change-set", "wait change-set-create-complete", "describe-change-set", "execute-change-set", "wait stack-update-complete", "start-image-pipeline-execution", "imagebuilder get-image"]
    positions = [output.index(p) for p in sequence]
    assert positions == sorted(positions)
    assert "host-aaaaaaaaaaaa-" in output and "immutable" in output
elif mode == "parameters":
    parameters = read("requested.json")
    old = read("stack.json")["Stacks"][0]["Parameters"]
    allowed = {"DesktopImageDigest", "DesktopImageId", "AgentSrcS3Uri"}
    assert {p["ParameterKey"] for p in parameters} == {p["ParameterKey"] for p in old}
    for p in parameters:
        assert p == {"ParameterKey": p["ParameterKey"], "UsePreviousValue": True} if p["ParameterKey"] not in allowed else "ParameterValue" in p
    archive = next(c for c in calls if c[0] == "git" and "archive" in c)
    assert archive[-1] == "a" * 40 + ":infra/host-agent"
    assert "--format=tar.gz" in archive
    assert has("create-change-set", "--use-previous-template", "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec")
    assert not has("execute-change-set")
elif mode.startswith("refuse-"):
    token = mode.removeprefix("refuse-")
    assert token in output, output
    assert not has("execute-change-set")
    if token in ("wrong AWS account", "region must", "image ID mismatch", "schema-2", "linux/amd64"):
        assert not has("create-change-set")
elif mode == "dry-promote":
    assert read("config.json") == read("original-config.json")
    assert not (root / "release").exists()
    assert not has("npm") and not has("npx") and not has("create-change-set") and not has("secretsmanager")
    assert "lifecycle:11" in output
    sequence = ["Edit ", "synth:lifecycle", "publish-assets", "s3 cp", "create-change-set", "wait change-set-create-complete", "describe-change-set", "execute-change-set", "wait stack-update-complete", "put-secret-value"]
    positions = [output.index(p) for p in sequence]
    assert positions == sorted(positions)
elif mode == "promote":
    b, a = preserved()
    assert a["ap-south-1"]["amiId"] == "ami-" + "2" * 17
    assert a["ap-south-1"]["stateMachineVersionArn"].endswith(":11")
    assert read("config.json")["preserve"] == {"nested": True}
    assert has("npm", "synth:lifecycle") and has("npx", "publish-assets")
    assert has("put-secret-value", "file:///dev/stdin")
    assert read("release/promotion.json")["previous"] == read("original-config.json")
elif mode == "rollback":
    b, a = preserved()
    assert b == a
    assert read("config.json") == read("original-config.json")
elif mode == "no-secret-write":
    assert not has("put-secret-value")
    assert "synthetic-private-do-not-print" not in output
elif mode == "available":
    assert (root / "release/ami-id.txt").read_text().strip() == "ami-" + "2" * 17
    assert has("start-image-pipeline-execution") and has("get-image")
    assert read("polls") == 2
elif mode == "failed-build":
    assert not (root / "release/ami-id.txt").exists()
    assert (root / "release/build-arn.txt").exists()
    assert "Image Builder FAILED" in output
elif mode == "poll-timeout":
    assert not (root / "release/ami-id.txt").exists()
    assert (root / "release/build-arn.txt").exists()
    assert "poll failed/timed out" in output
    assert has("timeout")
else:
    raise AssertionError(mode)
assert not any(has(command) for command in ("deregister-image", "delete-snapshot", "delete-image", "commit", "checkout"))
assert not has("git", "push")
