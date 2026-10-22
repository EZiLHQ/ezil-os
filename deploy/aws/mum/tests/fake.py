#!/usr/bin/env python3
"""Offline command doubles. All state and synthetic secrets live in the test tempdir."""
import json
import os
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
    if tool == "npm" and "synth:ami" in args:
        assert Path(flag("--prefix")).name == "app-computers"
        assert args[2:6] == ["run", "synth:ami", "--", "ezil-mum-ami"]
        candidate = Path(os.environ["EZIL_AMI_CONFIG"])
        assert candidate != root / "ami-config.json"
        config = json.loads(candidate.read_text())
        save("synth-config.json", config)
        value = read("template.json")["TemplateBody"]
        resources = value["Resources"]
        for logical in ("Component", "Recipe"):
            resources[logical]["Properties"]["Version"] = config["version"]
        if scenario.get("non_ascii_data"):
            # Live template holds '?' where the source has '…'; synth emits the original.
            resources["Component"]["Properties"]["Data"] = resources["Component"]["Properties"]["Data"].replace("?", "\u2026")
        if scenario.get("large_template"):
            resources["Component"]["Properties"]["Data"] += "x" * scenario["large_template"]
        if scenario.get("template_iam"):
            resources["BuildRole"]["Properties"]["RoleName"] = "unexpected"
        if scenario.get("template_parameter"):
            value["Parameters"]["FutureParameter"]["Default"] = "unexpected"
        if scenario.get("forced_config_version"):
            for logical in ("Infrastructure", "Distribution"):
                resources[logical]["Properties"]["Name"] = "ezil-host-mum-" + config["version"]
        if scenario.get("unforced_config"):
            resources["Infrastructure"]["Properties"]["SubnetId"] = "subnet-unexpected"
        if scenario.get("synth_version_mismatch"):
            resources["Recipe"]["Properties"]["Version"] = "1.0.0"
        assert "--output" not in args, "synth:ami pins its own -o; a second --output is rejected"
        output = Path(flag("--prefix")) / "cdk.out" / "ami"
        output.mkdir(parents=True, exist_ok=True)
        (output / "ezil-mum-ami.template.json").write_text(json.dumps(value))
        save("synth-template.json", value)
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
            pushed = "sha256:" + "d" * 64
            if scenario.get("image_index"):
                manifest["manifests"] = []
            if scenario.get("image_index_ok") or scenario.get("image_index_two"):
                # containerd store: the local image ID is the index digest.
                pushed = "sha256:" + "b" * 64
                manifest = {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [
                    {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": "sha256:" + "e" * 64, "platform": {"architecture": "amd64", "os": "linux"}},
                    {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": "sha256:" + "f" * 64, "platform": {"architecture": "arm64", "os": "linux"}}
                    if scenario.get("image_index_two") else
                    {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": "sha256:" + "f" * 64, "platform": {"architecture": "unknown", "os": "unknown"},
                     "annotations": {"vnd.docker.reference.type": "attestation-manifest"}}]}
            out({"images": [{"imageId": {"imageDigest": pushed}, "imageManifest": json.dumps(manifest)}], "failures": []})
        else:
            raise SystemExit("unexpected ECR command")
    elif service == "s3":
        assert operation == "cp"
        if "/ami/templates/" in args[-1]:
            save("uploaded-template.json", json.loads(Path(args[-2]).read_text()))
            save("template-upload.json", args[-1])
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
            value = read("template.json")
            if scenario.get("live_version_drift"):
                value["TemplateBody"]["Resources"]["Recipe"]["Properties"]["Version"] = "1.0.0"
            out(value)
        elif operation == "create-change-set":
            if not lifecycle:
                save("requested.json", json.loads(Path(flag("--parameters").removeprefix("file://")).read_text()))
                if "--template-body" in args or "--template-url" in args:
                    assert "--use-previous-template" not in args
                    submitted = json.loads(Path(flag("--template-body").removeprefix("file://")).read_text()) if "--template-body" in args else read("uploaded-template.json")
                    save("submitted-template.json", submitted)
                    assert read("ami-config.json") == read("original-ami-config.json")
        elif operation == "wait":
            if not lifecycle and "stack-update-complete" in args:
                assert read("ami-config.json") == read("original-ami-config.json")
                if scenario.get("config_race"):
                    value = read("ami-config.json")
                    value["version"] = "1.0.9"
                    save("ami-config.json", value)
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
                if (root / "submitted-template.json").exists():
                    def modification(logical, kind, names, replacement="True", source="DirectModification", cause=None):
                        return {"Type": "Resource", "ResourceChange": {"Action": "Modify", "LogicalResourceId": logical, "ResourceType": "AWS::ImageBuilder::" + kind,
                            "Scope": ["Properties"], "Replacement": replacement, "Details": [
                                {"Target": {"Attribute": "Properties", "Name": name, "RequiresRecreation": "Always" if replacement == "True" else "Never"}, "ChangeSource": source,
                                 **({"CausingEntity": cause} if cause else {})} for name in names]}}
                    cs["Changes"] = [
                        modification("Component", "Component", ["Version"] + (["Data"] if scenario.get("large_template") else [])),
                        modification("Recipe", "ImageRecipe", ["Version"]),
                        modification("Pipeline", "ImagePipeline", ["ImageRecipeArn"], "False", "ResourceReference", "Recipe"),
                    ]
                    cs["Changes"][1]["ResourceChange"]["Details"].extend([
                        {"Target": {"Attribute": "Properties", "Name": "Components", "RequiresRecreation": "Always"}, "ChangeSource": source, "CausingEntity": cause}
                        for source, cause in [("ResourceReference", "Component"), *[("ParameterReference", k) for k in ("AgentSrcS3Uri", "DesktopImageDigest", "DesktopImageId")]]
                    ])
                    if scenario.get("iam_change"):
                        cs["Changes"].append({"Type": "Resource", "ResourceChange": {"Action": "Modify", "LogicalResourceId": "BuildRole", "ResourceType": "AWS::IAM::Role"}})
                    if scenario.get("forced_config_version"):
                        for logical, kind in (("Infrastructure", "InfrastructureConfiguration"), ("Distribution", "DistributionConfiguration")):
                            cs["Changes"].append(modification(logical, kind, ["Name"]))
                            cs["Changes"][2]["ResourceChange"]["Details"].extend(modification("Pipeline", "ImagePipeline", [kind + "Arn"], "False", "ResourceReference", logical)["ResourceChange"]["Details"])
                    if scenario.get("unexplained_config"):
                        cs["Changes"].append(modification("Infrastructure", "InfrastructureConfiguration", ["Name"]))
                    if scenario.get("delete_recipe"):
                        cs["Changes"][1]["ResourceChange"]["Action"] = "Remove"
                    if scenario.get("missing_component"):
                        cs["Changes"].pop(0)
                    if scenario.get("pipeline_replacement"):
                        cs["Changes"][2]["ResourceChange"]["Replacement"] = "True"
                    if scenario.get("pagination"):
                        cs["NextToken"] = "more"
            out(cs)
        elif operation == "execute-change-set":
            if lifecycle:
                (root / "executed").touch()
            else:
                assert read("ami-config.json") == read("original-ami-config.json")
                if scenario.get("execute_fail"):
                    raise SystemExit(1)
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
            if (root / "submitted-template.json").exists():
                assert read("ami-config.json") == read("synth-config.json")
                assert read("release/previous-ami-config.json") == read("original-ami-config.json")
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
