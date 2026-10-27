#!/usr/bin/env python3
"""Offline command doubles. All state and synthetic secrets live in the test tempdir."""
import json
import fcntl
import os
from pathlib import Path
import subprocess
import sys
import time

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


def lifecycle_template(config):
    return {"Parameters": {"Keep": {"Type": "String"}}, "Resources": {
        "Observer": {"Type": "AWS::Lambda::Function", "Properties": {
            "Environment": {"Variables": {"EZIL_LIFECYCLE_SETTINGS": json.dumps(config["settings"], separators=(",", ":"))}},
            "Code": {"S3Bucket": "fixed-assets", "S3Key": "fixed-code.zip"}, "MemorySize": 256}},
        "Policy": {"Type": "AWS::IAM::Policy", "Properties": {"PolicyDocument": {"Version": "2012-10-17", "Statement": []}}},
        "Bucket": {"Type": "AWS::S3::Bucket", "Properties": {}},
        "Key": {"Type": "AWS::KMS::Key", "Properties": {}},
        "Nested": {"Type": "AWS::CloudFormation::Stack", "Properties": {"TemplateURL": "fixed"}},
    }}


def assert_locked(name):
    with (root / "locks" / name).open("r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
    raise AssertionError("required common lock was not held")


with (root / "calls.jsonl").open("a") as calls:
    calls.write(json.dumps([tool, *args]) + "\n")

if tool == "git":
    if "rev-parse" in args:
        out("a" * 40)
    elif "cat-file" in args:
        out("blob" if args[-1].endswith("/maintenance.py") else "tree")
    elif "archive" in args:
        Path(flag("--output")).write_bytes(b"synthetic archive")
    elif "merge-base" in args:
        assert len(args) == 6 and args[0] == '-C' and args[2:4] == ['merge-base', '--is-ancestor']
        raise SystemExit(scenario.get('git_ancestor_status', 0))
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
    if tool in ("npm", "npx"):
        assert_locked("operator.lock")
    if scenario.get("synth_fail") and tool == "npm":
        raise SystemExit(1)
    if tool == "npm" and "synth:ami" in args:
        assert Path(flag("--prefix")).name == "app-computers"
        assert str(Path(flag("--prefix"))).startswith("/tmp/ezil-mum.")
        assert args[2:6] == ["run", "synth:ami", "--", "ezil-mum-ami"]
        candidate = Path(os.environ["EZIL_AMI_CONFIG"])
        assert candidate != root / "ami-config.json"
        config = json.loads(candidate.read_text())
        save("synth-config.json", config)
        value = read("template.json")["TemplateBody"]
        resources = value["Resources"]
        parts = read("ami-previous-bindings.json")
        for section in ("Parameters", "Conditions", "Rules"):
            value.setdefault(section, {}).update(parts[section])
        resources["Recipe"]["Properties"]["Components"][0]["Parameters"].extend(parts["Bindings"])
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
    elif tool == "npm" and "synth:lifecycle" in args:
        project = Path(flag("--prefix"))
        assert str(project).startswith("/tmp/ezil-mum.")
        assert "--output" not in args
        config = Path(os.environ["EZIL_LIFECYCLE_CONFIG"])
        phase = config.stem
        assert phase in ("before", "target")
        value = lifecycle_template(json.loads(config.read_text()))
        if scenario.get("lifecycle_template_drift"):
            value["Resources"]["Observer"]["Properties"]["MemorySize"] = 512
        if phase == "target":
            mutation = scenario.get("lifecycle_template_change")
            if mutation in ("Policy", "Bucket", "Key", "Nested"):
                value["Resources"][mutation]["Properties"]["Unexpected"] = True
            elif mutation == "version":
                value["Resources"]["NewVersion"] = {"Type": "AWS::Lambda::Version", "Properties": {"FunctionName": {"Ref": "Observer"}}}
            elif mutation == "code":
                value["Resources"]["Observer"]["Properties"]["Code"]["S3Key"] = "different.zip"
            elif mutation == "environment":
                variables = value["Resources"]["Observer"]["Properties"]["Environment"]["Variables"]
                settings = json.loads(variables["EZIL_LIFECYCLE_SETTINGS"])
                settings["deployment"]["keep"] = [9]
                variables["EZIL_LIFECYCLE_SETTINGS"] = json.dumps(settings, separators=(",", ":"))
            elif mutation == "parameter":
                value["Parameters"]["Keep"]["Default"] = "changed"
        output = project / "cdk.out/lifecycle"
        output.mkdir(parents=True)
        (output / "ezil-mum-lifecycle.template.json").write_text(json.dumps(value))
        save("synth-lifecycle-" + phase + ".json", value)
    elif tool == "npx":
        assert str(Path.cwd()).startswith("/tmp/ezil-mum.")
        assert (Path.cwd() / "cdk.out/lifecycle/ezil-mum-lifecycle.template.json").exists()
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
    if (root / "rebase-readbacks.json").exists() and service not in ("sts", "secretsmanager", "cloudformation"):
        evidence = read("rebase-readbacks.json")
        if (service, operation) == ('ec2','describe-instances'):
            out({'Reservations':[{'Instances':[{'InstanceId':'i-014810524754b9ed0','State':{'Name':'running'},'Tags':[{'Key':'ezil:env','Value':'billing-staging'},{'Key':'ezil:purpose','Value':'os-staging'}]}]}]})
        elif (service,operation) in (('s3api','put-object'),('s3api','delete-object')):
            out({})
        elif (service,operation)==('ssm','send-command'):
            out({'Command':{'CommandId':'11111111-1111-4111-8111-111111111111'}})
        elif (service,operation)==('ssm','get-command-invocation'):
            out({'Status':scenario.get('rebase_ssm_status','Success'),'ResponseCode':0,'StandardOutputContent':json.dumps(read('schema-readback.json'))})
        elif (service,operation)==('ssm','list-commands'):
            out({'Commands':[{'CommandId':flag('--command-id'),'Status':scenario.get('rebase_ssm_status','Success')}]})
        elif (service, operation) == ("imagebuilder", "get-image"):
            out(evidence["build"])
        elif (service, operation) == ("ec2", "describe-images"):
            out(evidence["image"])
        elif (service, operation) == ("ec2", "describe-launch-template-versions"):
            out(evidence["template"])
        elif service == "stepfunctions":
            key = next(k for k, v in evidence['versions'].items() if v['stateMachineVersions'][0]['stateMachineVersionArn'].rsplit(':', 1)[0] == flag('--state-machine-arn').rsplit(':', 1)[0] or v['stateMachineVersions'][0]['stateMachineVersionArn'].rsplit(':', 1)[0] == flag('--state-machine-arn'))
            out(evidence['versions' if operation == 'list-state-machine-versions' else 'workflows'][key])
        else:
            raise SystemExit('unexpected rebase readback')
        raise SystemExit(0)
    if (service, operation) == ("sts", "get-caller-identity"):
        out(("000000000000" if scenario.get("wrong_account") else "452630323510") if "--query" in args else {"Account":"000000000000" if scenario.get("wrong_account") else "452630323510"})
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
        if flag("--stack-name") == "ezil-identity-mum":
            assert_locked("app-secret.lock")
            assert "--change-set-name" not in args
            if operation == "get-template":
                assert flag("--template-stage") == "Original"
                out(read("identity-live-template.json"))
            elif operation == "describe-stacks":
                out(read("identity-live-stack.json"))
            else:
                raise SystemExit("unexpected unchanged identity command")
            raise SystemExit(0)
        if flag("--stack-name") == "ezil-mum-foundation":
            value = read("foundation-stack.json")
            role = "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec"
            template_id = "lt-06f691fc1e4dfe3cc"
            if operation == "describe-stacks":
                if scenario.get("foundation_role") or (scenario.get("foundation_role_race") and (root / "foundation-requested.json").exists()):
                    value["Stacks"][0]["RoleARN"] = "arn:aws:iam::452630323510:role/wrong"
                if scenario.get("foundation_no_role"):
                    value["Stacks"][0].pop("RoleARN")
                if scenario.get("foundation_stack_race") and (root / "foundation-requested.json").exists():
                    value["Stacks"][0]["Parameters"][1]["ParameterValue"] = "changed"
                if scenario.get("foundation_post_parameter") and (root / "foundation-executed").exists():
                    value["Stacks"][0]["Parameters"][1]["ParameterValue"] = "changed"
                out(value)
            elif operation == "describe-stack-resource":
                assert flag("--logical-resource-id") == "ComputerLaunchTemplate"
                out({"StackResourceDetail": {"LogicalResourceId": "ComputerLaunchTemplate", "ResourceType": "AWS::EC2::LaunchTemplate",
                    "PhysicalResourceId": "lt-00000000000000000" if scenario.get("foundation_identity") else template_id}})
            elif operation == "create-change-set":
                assert_locked("operator.lock")
                assert "--use-previous-template" in args and "--template-url" not in args and "--template-body" not in args
                assert flag("--role-arn") == role and flag("--change-set-type") == "UPDATE"
                assert read("config.json") == read("original-config.json")
                save("foundation-requested.json", json.loads(Path(flag("--parameters").removeprefix("file://")).read_text()))
            elif operation == "describe-change-set":
                previous = {p["ParameterKey"]: p for p in value["Stacks"][0]["Parameters"]}
                actual = [previous[p["ParameterKey"]] if p.get("UsePreviousValue") else p for p in read("foundation-requested.json")]
                data = read("launch-template-versions.json")[-1]["LaunchTemplateData"]
                after = {**data, "ImageId": actual[0]["ParameterValue"]}
                resource = {"Action": "Modify", "LogicalResourceId": "ComputerLaunchTemplate", "PhysicalResourceId": template_id,
                    "ResourceType": "AWS::EC2::LaunchTemplate", "Replacement": "False", "Scope": ["Properties"], "Details": [
                        {"Target": {"Attribute": "Properties", "Name": "LaunchTemplateData", "RequiresRecreation": "Never"},
                         "ChangeSource": "ParameterReference", "CausingEntity": "HostAmiId", "Evaluation": "Static"}],
                    "BeforeContext": json.dumps({"Properties": {"LaunchTemplateData": data}}),
                    "AfterContext": json.dumps({"Properties": {"LaunchTemplateData": after}})}
                cs = {"Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "Parameters": actual,
                    "Changes": [{"Type": "Resource", "ResourceChange": resource}]}
                if scenario.get("foundation_extra_resource"):
                    cs["Changes"].append({"Type": "Resource", "ResourceChange": {"LogicalResourceId": "Bucket", "Action": "Remove"}})
                if scenario.get("foundation_extra_parameter"):
                    actual[1]["ParameterValue"] = "changed"
                if scenario.get("foundation_ssm"):
                    actual[2]["ResolvedValue"] = "changed"
                if scenario.get("foundation_property"):
                    resource["Details"][0]["Target"]["Name"] = "LaunchTemplateName"
                if scenario.get("foundation_path"):
                    resource["Details"][0]["Target"]["Path"] = "/Properties/LaunchTemplateData/InstanceType"
                if scenario.get("foundation_context"):
                    resource["AfterContext"] = json.dumps({"Properties": {"LaunchTemplateData": {**after, "InstanceType": "m5.large"}}})
                if scenario.get("foundation_replacement"):
                    resource["Replacement"] = "True"
                if scenario.get("foundation_page"):
                    cs["NextToken"] = "more"
                if scenario.get("foundation_dynamic"):
                    resource["Details"].append({"Target": {"Attribute": "Properties", "Name": "LaunchTemplateData", "RequiresRecreation": "Never"},
                        "ChangeSource": "DirectModification", "Evaluation": "Dynamic"})
                out(cs)
            elif operation == "execute-change-set":
                assert read("config.json") == read("original-config.json")
                assert not (root / "executed").exists()
                (root / "foundation-executed").touch()
                wanted = read("foundation-requested.json")[0]["ParameterValue"]
                value["Stacks"][0]["Parameters"][0]["ParameterValue"] = wanted
                save("foundation-stack.json", value)
                versions = read("launch-template-versions.json")
                versions.append({**versions[-1], "VersionNumber": versions[-1]["VersionNumber"] + (2 if scenario.get("foundation_readback_version") else 1),
                    "LaunchTemplateData": {**versions[-1]["LaunchTemplateData"], "ImageId": wanted}})
                if scenario.get("foundation_readback_mismatch"):
                    versions[-1]["LaunchTemplateData"]["ImageId"] = "ami-" + "9" * 17
                if scenario.get("foundation_readback_data"):
                    versions[-1]["LaunchTemplateData"]["InstanceType"] = "m5.large"
                save("launch-template-versions.json", versions)
            elif operation == "wait":
                if scenario.get("foundation_wait_fail") and "stack-update-complete" in args:
                    raise SystemExit(1)
            else:
                raise SystemExit("unexpected foundation command")
            raise SystemExit(0)
        lifecycle = flag("--stack-name") == "ezil-mum-lifecycle"
        if operation == "describe-stacks":
            value = read("stack.json")
            if lifecycle:
                value["Stacks"][0]["Parameters"] = [{"ParameterKey": "Keep", "ParameterValue": "unchanged", "ResolvedValue": "fixed"}]
                if scenario.get("lifecycle_no_role"):
                    value["Stacks"][0].pop("RoleARN", None)
                value["Stacks"][0]["Outputs"] = [{"OutputKey": "WorkflowVersionArn", "OutputValue": read("config.json")["settings"]["deployment"]["stateMachineVersionArn"]}]
                if scenario.get("wrong_output"):
                    value["Stacks"][0]["Outputs"][0]["OutputValue"] += "9"
            out(value)
        elif operation == "get-template":
            if lifecycle:
                if "--change-set-name" in args:
                    value = {"TemplateBody": read("synth-lifecycle-target.json")}
                    if scenario.get("lifecycle_submitted_drift"):
                        value["TemplateBody"]["Resources"]["Observer"]["Properties"]["MemorySize"] = 900
                else:
                    if scenario.get("noop_rollback") and (root / "executed").exists():
                        save("live-lifecycle-config.json", read("original-config.json"))
                    value = {"TemplateBody": lifecycle_template(read("live-lifecycle-config.json"))}
            else:
                value = read("template.json")
            if not lifecycle and scenario.get("live_version_drift"):
                value["TemplateBody"]["Resources"]["Recipe"]["Properties"]["Version"] = "1.0.0"
            out(value)
        elif operation == "create-change-set":
            if lifecycle:
                assert flag("--role-arn") == "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec"
                assert json.loads(Path(flag("--parameters").removeprefix("file://")).read_text()) == [{"ParameterKey": "Keep", "UsePreviousValue": True}]
            else:
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
                cs["RoleARN"] = "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec"
                cs["Parameters"] = [{"ParameterKey": "Keep", "ParameterValue": "unchanged", "ResolvedValue": "fixed"}]
                cs["Changes"] = [{"Type": "Resource", "ResourceChange": {"Action": "Modify", "LogicalResourceId": "Observer", "ResourceType": "AWS::Lambda::Function", "Replacement": "False",
                    "Scope": ["Properties"], "Details": [{"Target": {"Attribute": "Properties", "Name": "Environment", "RequiresRecreation": "Never"}, "ChangeSource": "DirectModification", "Evaluation": "Static"}]}}]
                if scenario.get("noop_rollback") and flag("--change-set-name").startswith("rollback-"):
                    cs.update(Status="FAILED", ExecutionStatus="UNAVAILABLE", Changes=[], StatusReason="The submitted information didn't contain changes.")
                if scenario.get("durable"):
                    cs["Changes"][0]["ResourceChange"].update(ResourceType="AWS::KMS::Key", Replacement="True")
                mutation = scenario.get("lifecycle_change")
                r = cs["Changes"][0]["ResourceChange"] if cs["Changes"] else {}
                if mutation in ("Policy", "Bucket", "Key", "Nested"):
                    cs["Changes"].append({"Type": "Resource", "ResourceChange": {"Action": "Remove", "LogicalResourceId": mutation, "ResourceType": lifecycle_template(read("config.json"))["Resources"][mutation]["Type"]}})
                elif mutation == "replacement":
                    r["Replacement"] = "True"
                elif mutation == "conditional":
                    r["Replacement"] = "Conditional"
                elif mutation == "code":
                    r["Details"][0]["Target"]["Name"] = "Code"
                elif mutation == "dynamic":
                    r["Details"][0]["Evaluation"] = "Dynamic"
                elif mutation == "missing":
                    r["Details"] = []
                elif mutation == "parameter":
                    cs["Parameters"][0]["ParameterValue"] = "changed"
                elif mutation == "ssm":
                    cs["Parameters"][0]["ResolvedValue"] = "changed"
                elif mutation == "page":
                    cs["NextToken"] = "more"
                elif mutation == "context":
                    # Real contexts hold resolved values on both sides; After must be the
                    # AMI/version substitution of Before. An extra change must be refused.
                    before = read("synth-lifecycle-target.json")["Resources"]["Observer"]["Properties"]
                    after = json.loads(json.dumps(before))
                    after["MemorySize"] = 512
                    r["BeforeContext"] = json.dumps({"Properties": before})
                    r["AfterContext"] = json.dumps({"Properties": after})
            else:
                old = {p["ParameterKey"]: p for p in read("stack.json")["Stacks"][0]["Parameters"]}
                cs["Parameters"] = [old[p["ParameterKey"]] if p.get("UsePreviousValue") else p for p in read("requested.json")]
                if scenario.get("extra_parameter"):
                    next(p for p in cs["Parameters"] if p["ParameterKey"] == "EnrollUrl")["ParameterValue"] = "https://wrong.example"
                if scenario.get("ssm_drift") or scenario.get("base_review"):
                    next(p for p in cs["Parameters"] if p["ParameterKey"] == "UbuntuAmiId")["ResolvedValue"] = "ami-" + "9" * 17
                if scenario.get("base_path_changed"):
                    next(p for p in cs["Parameters"] if p["ParameterKey"] == "UbuntuAmiId")["ParameterValue"] = "/aws/changed"
                if scenario.get("other_ssm"):
                    next(p for p in cs["Parameters"] if p["ParameterKey"] == scenario["other_ssm"])["ResolvedValue"] = "ami-" + "9" * 17
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
                    if scenario.get("base_live_shape"):
                        # Live CloudFormation 2026-10-23: re-resolved SSM parent is Static/DirectModification, no cause.
                        detail = {"Target": {"Attribute": "Properties", "Name": "ParentImage", "RequiresRecreation": "Always"},
                                  "ChangeSource": "DirectModification", "Evaluation": "Static"}
                        if scenario.get("base_live_cause"):
                            detail["CausingEntity"] = scenario["base_live_cause"]
                        cs["Changes"][1]["ResourceChange"]["Details"].append(detail)
                    elif scenario.get("base_review") or scenario.get("base_unexplained_parent"):
                        cs["Changes"][1]["ResourceChange"]["Details"].extend([
                            {"Target": {"Attribute": "Properties", "Name": "ParentImage", "RequiresRecreation": "Always"},
                             "ChangeSource": "ParameterReference", "CausingEntity": scenario.get("base_parent_cause", "UbuntuAmiId")},
                            {"Target": {"Attribute": "Properties", "Name": "ParentImage", "RequiresRecreation": "Always"},
                             "ChangeSource": "DirectModification", "Evaluation": "Dynamic"},
                        ])
                    if scenario.get("maintenance_static_empty"):
                        # Live CloudFormation 2026-10-27: a maintenance bake empties PreviousDesktopImage*; the
                        # emptied Components value is Static/DirectModification, no cause, no ParameterReference.
                        detail = {"Target": {"Attribute": "Properties", "Name": "Components", "RequiresRecreation": "Always",
                                             "BeforeValue": "452630323510.dkr.ecr.ap-south-1.amazonaws.com/x@sha256:" + "a" * 64,
                                             "AfterValue": scenario.get("maintenance_static_value", "")},
                                  "ChangeSource": "DirectModification", "Evaluation": "Static"}
                        if scenario.get("maintenance_static_cause"):
                            detail["CausingEntity"] = scenario["maintenance_static_cause"]
                        cs["Changes"][1]["ResourceChange"]["Details"].append(detail)
                    if scenario.get("live_dynamic") or scenario.get("dynamic_unexplained"):
                        # Real CloudFormation also lists value-only Dynamic entries for referenced properties.
                        dyn = lambda name, rec: {"Target": {"Attribute": "Properties", "Name": name, "RequiresRecreation": rec}, "ChangeSource": "DirectModification", "Evaluation": "Dynamic"}
                        cs["Changes"][1]["ResourceChange"]["Details"].append(dyn("Components", "Always"))
                        cs["Changes"][2]["ResourceChange"]["Details"].append(dyn("ImageRecipeArn", "Never"))
                        if scenario.get("dynamic_unexplained"):
                            cs["Changes"][1]["ResourceChange"]["Details"].append(dyn("ParentImage", "Always"))
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
                save("live-lifecycle-config.json", read("config.json"))
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
        if operation == "describe-launch-template-versions":
            assert flag("--launch-template-id") == "lt-06f691fc1e4dfe3cc"
            if scenario.get("foundation_readback_fail") and (root / "foundation-executed").exists():
                raise SystemExit(1)
            values = read("launch-template-versions.json")
            if scenario.get("foundation_version_race") and (root / "foundation-requested.json").exists():
                values[-1]["VersionNumber"] += 1
            number = flag("--versions")
            selected = [values[-1]] if number == "$Latest" else [v for v in values if str(v["VersionNumber"]) == number]
            if scenario.get("configured_template_mismatch") and number == "3":
                selected[0]["LaunchTemplateData"]["ImageId"] = "ami-" + "9" * 17
            out({"LaunchTemplateVersions": selected})
        else:
            assert operation == "describe-images"
            if "--owners" not in args:
                ids = args[args.index("--image-ids") + 1:args.index("--output")]
                assert len(ids) == 2 and ids[0] == "ami-" + "1" * 17
                if scenario.get("base_describe_fail"):
                    raise SystemExit("synthetic describe-images failure")
                images = [
                    {"ImageId": ids[0], "CreationDate": scenario.get("base_old_date", "2026-10-17T10:41:57.000Z")},
                    {"ImageId": ids[1], "OwnerId": "099720109477", "State": "available", "Architecture": "x86_64",
                     "Name": "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20261023",
                     "CreationDate": "2026-10-23T10:41:57Z", **scenario.get("base_image", {})},
                ]
                out({"Images": images[:scenario.get("base_image_count", 2)],
                     **({"NextToken": "more"} if scenario.get("base_image_page") else {})})
            else:
                out({"Images": [{"ImageId": flag("--image-ids"), "OwnerId": "452630323510", "State": "available", "Architecture": "x86_64"}]})
    elif service == "secretsmanager":
        assert_locked("app-secret.lock")
        if operation == "get-secret-value":
            envelope = read("secret.json")
            count = read("secret-reads.json") if (root / "secret-reads.json").exists() else 0
            save("secret-reads.json", count + 1)
            if scenario.get("secret_pause") and count == 1:
                (root / "secret-recheck").touch()
                deadline = time.monotonic() + 15
                while not (root / "secret-continue").exists():
                    assert time.monotonic() < deadline, "test barrier timed out"
                    time.sleep(0.01)
            if scenario.get("secret_verify_version") and envelope["VersionId"] == "updated":
                envelope["VersionId"] = "unexpected-version"
            if scenario.get("secret_race"):
                envelope["VersionId"] += "x"
                save("secret.json", envelope)
            out(envelope)
        elif operation == "put-secret-value":
            source = flag("--cli-input-json")
            # The payload arrives through a private 0600 file, never argv or a pipe.
            assert source.startswith("file://") and "ezil-secret." in source, source
            request_path = Path(source[len("file://"):])
            assert (request_path.stat().st_mode & 0o777) == 0o600
            request = json.loads(request_path.read_text())
            assert request["SecretId"] == "ezil-os/billing-staging/app"
            save("secret.json", {"VersionId": "updated", "SecretString": request["SecretString"]})
            out({"VersionId": "updated"})
        else:
            raise SystemExit("unexpected secrets command")
    else:
        raise SystemExit("unexpected AWS command")
else:
    raise SystemExit("unexpected tool")
