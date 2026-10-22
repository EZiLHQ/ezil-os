#!/usr/bin/env python3
"""Offline command doubles. All state and synthetic secrets live in the test tempdir."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[0]).absolute().parent.parent
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
scenario = json.loads((root / "scenario.json").read_text())


def out(value):
    print(json.dumps(value) if isinstance(value, (dict, list)) else value)


def flag(name):
    return args[args.index(name) + 1]


def read(name):
    return json.loads((root / name).read_text())


def save(name, value):
    (root / name).write_text(json.dumps(value))


with (root / "calls.jsonl").open("a") as calls:
    calls.write(json.dumps([tool, *args]) + "\n")

if tool == "git":
    if "rev-parse" in args:
        out("a" * 40)
    elif "cat-file" in args:
        out("tree")
    elif "archive" in args:
        Path(flag("--output")).write_bytes(b"synthetic archive")
    else:
        raise SystemExit("unexpected git command")
elif tool == "docker":
    if "inspect" in args:
        out("linux/arm64" if scenario.get("arm") else "linux/amd64") if "Architecture" in flag("--format") else out("sha256:" + "b" * 64)
    elif "login" in args:
        assert sys.stdin.read().strip() == "synthetic-login"
    elif not any(x in args for x in ("tag", "push")):
        raise SystemExit("unexpected docker command")
elif tool in ("npm", "npx", "sleep"):
    if scenario.get("synth_fail") and tool == "npm":
        raise SystemExit(1)
elif tool == "timeout":
    assert args[0].endswith("s") and 0 < int(args[0][:-1]) <= 5400
    if scenario.get("poll_timeout"):
        raise SystemExit(124)
    raise SystemExit(subprocess.run(args[1:], check=False).returncode)
elif tool == "aws":
    assert flag("--profile") == "ezil-admin"
    assert flag("--region") == "ap-south-1"
    start = args.index("--no-cli-pager") + 1
    service, operation = args[start:start + 2]
    if (service, operation) == ("sts", "get-caller-identity"):
        out("000000000000" if scenario.get("wrong_account") else "452630323510")
    elif service == "ecr":
        if operation == "get-login-password":
            out("synthetic-login")
        elif operation == "batch-get-image":
            manifest = {"schemaVersion": 2, "config": {"digest": "sha256:" + ("c" if scenario.get("image_mismatch") else "b") * 64}}
            if scenario.get("image_index"):
                manifest["manifests"] = []
            out({"images": [{"imageId": {"imageDigest": "sha256:" + "d" * 64}, "imageManifest": json.dumps(manifest)}], "failures": []})
        else:
            raise SystemExit("unexpected ECR command")
    elif service == "s3":
        assert operation == "cp"
    elif service == "cloudformation":
        lifecycle = flag("--stack-name") == "ezil-mum-lifecycle"
        if operation == "describe-stacks":
            value = read("stack.json")
            if lifecycle:
                value["Stacks"][0]["Outputs"] = [{"OutputKey": "WorkflowVersionArn", "OutputValue": read("config.json")["settings"]["deployment"]["stateMachineVersionArn"]}]
                if scenario.get("wrong_output"):
                    value["Stacks"][0]["Outputs"][0]["OutputValue"] += "9"
            out(value)
        elif operation == "get-template":
            out(read("template.json"))
        elif operation == "create-change-set":
            if not lifecycle:
                save("requested.json", json.loads(Path(flag("--parameters").removeprefix("file://")).read_text()))
        elif operation == "wait":
            if scenario.get("stack_fail") and "stack-update-complete" in args:
                raise SystemExit(1)
            if scenario.get("noop_rollback") and "change-set-create-complete" in args and flag("--change-set-name").startswith("rollback-"):
                raise SystemExit(1)
        elif operation == "describe-change-set":
            cs = {"Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "Changes": []}
            if lifecycle:
                cs["Changes"] = [{"ResourceChange": {"Action": "Modify", "LogicalResourceId": "Observer", "ResourceType": "AWS::Lambda::Function", "Replacement": "False"}}]
                if scenario.get("noop_rollback") and flag("--change-set-name").startswith("rollback-"):
                    cs.update(Status="FAILED", ExecutionStatus="UNAVAILABLE", Changes=[], StatusReason="The submitted information didn't contain changes.")
                if scenario.get("durable"):
                    cs["Changes"][0]["ResourceChange"].update(ResourceType="AWS::KMS::Key", Replacement="True")
            else:
                old = {p["ParameterKey"]: p for p in read("stack.json")["Stacks"][0]["Parameters"]}
                cs["Parameters"] = [old[p["ParameterKey"]] if p.get("UsePreviousValue") else p for p in read("requested.json")]
                if scenario.get("extra_parameter"):
                    next(p for p in cs["Parameters"] if p["ParameterKey"] == "EnrollUrl")["ParameterValue"] = "https://wrong.example"
                if scenario.get("ssm_drift"):
                    next(p for p in cs["Parameters"] if p["ParameterKey"] == "UbuntuAmiId")["ResolvedValue"] = "ami-" + "9" * 17
                mutable = scenario.get("non_replacing_double", False)
                cs["Changes"] = [{"Type": "Resource", "ResourceChange": {"Action": "Modify", "LogicalResourceId": "Recipe", "ResourceType": "AWS::ImageBuilder::ImageRecipe", "Scope": ["Properties"], "Replacement": "False" if mutable else "True", "Details": [
                    {"Target": {"Attribute": "Properties", "Name": "Components", "RequiresRecreation": "Never" if mutable else "Always"}, "ChangeSource": "ParameterReference", "CausingEntity": key}
                    for key in ("AgentSrcS3Uri", "DesktopImageDigest", "DesktopImageId")
                ]}}]
                if scenario.get("extra_resource"):
                    cs["Changes"].insert(0, {"Type": "Resource", "ResourceChange": {"Action": "Modify", "LogicalResourceId": "BuildRole"}})
            out(cs)
        elif operation == "execute-change-set":
            if lifecycle:
                (root / "executed").touch()
        else:
            raise SystemExit("unexpected CFN command")
    elif service == "stepfunctions":
        assert operation == "list-state-machine-versions"
        count = int((root / "version-reads").read_text()) if (root / "version-reads").exists() else 0
        (root / "version-reads").write_text(str(count + 1))
        published = [4, 2, 10, 1]  # deliberately unordered, config still pins :4
        if (root / "executed").exists() or (scenario.get("version_race") and count > 0):
            published.append(11)
        out({"stateMachineVersions": [{"stateMachineVersionArn": f"arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle:{n}"} for n in published]})
    elif service == "imagebuilder":
        if operation == "start-image-pipeline-execution":
            out("arn:aws:imagebuilder:ap-south-1:452630323510:image/ezil-host-mum/1.0.2/1")
        elif operation == "get-image":
            count = int((root / "polls").read_text()) if (root / "polls").exists() else 0
            (root / "polls").write_text(str(count + 1))
            status = "FAILED" if scenario.get("build_fail") else ("BUILDING" if count == 0 else "AVAILABLE")
            out({"image": {"state": {"status": status}, "outputResources": {"amis": [{"region": "ap-south-1", "image": "ami-" + "2" * 17}]}}})
    elif service == "ec2":
        assert operation == "describe-images"
        out({"Images": [{"ImageId": flag("--image-ids"), "OwnerId": "452630323510", "State": "available", "Architecture": "x86_64"}]})
    elif service == "secretsmanager":
        if operation == "get-secret-value":
            envelope = read("secret.json")
            if scenario.get("secret_race"):
                envelope["VersionId"] += "x"
                save("secret.json", envelope)
            out(envelope)
        elif operation == "put-secret-value":
            assert flag("--cli-input-json") == "file:///dev/stdin"
            request = json.load(sys.stdin)
            assert request["SecretId"] == "ezil-os/billing-staging/app"
            save("secret.json", {"VersionId": "updated", "SecretString": request["SecretString"]})
            out({"VersionId": "updated"})
        else:
            raise SystemExit("unexpected secrets command")
    else:
        raise SystemExit("unexpected AWS command")
else:
    raise SystemExit("unexpected tool")
