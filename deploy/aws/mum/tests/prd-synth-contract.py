#!/usr/bin/env python3
"""Optional real, offline CDK probe for namespace prd (requires installed infra deps).

Synthesizes the founder's prd lifecycle (PROD-COMPUTERS-PLAN P7: recovery on, no
release tuple, EC2-only app caller) before and after an AMI promotion, then runs the
prd promotion validators of json-tool.py on the real templates: they must refuse it,
because the recovery workflow would republish while recoveryVersionArn stays old. The
same promotion without recovery must pass. The tooling copy gets the test pin
stand-ins, exactly as the offline suite does.
"""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
import namespaces  # noqa: E402
import prd_namespace as fixtures  # noqa: E402

passed = failed = 0


def check(label, ok, details=""):
    global passed, failed
    if ok:
        passed += 1
        print("PASS " + label, flush=True)
    else:
        failed += 1
        print("FAIL " + label + "\n" + details, flush=True)


repo = Path(__file__).resolve().parents[4]
source = repo / "infra/app-computers"
role = "arn:aws:iam::452630323510:role/ezil/identity/ezil-prd-cfn-exec"
with tempfile.TemporaryDirectory(prefix="ezil-prd-real-synth.") as folder:
    root = Path(folder)
    tools = root / "tools"
    tools.mkdir()
    for item in (repo / "deploy/aws/mum").iterdir():
        if item.suffix in (".py", ".sh", ".json"):
            # Never the host's real operator locks (as fixture.py does).
            text = item.read_text().replace("/root/ezil-aws-mum/locks", str(root / "locks")).replace("/root/ezil-aws-prd/locks", str(root / "locks"))
            for unpinned, pinned in namespaces.PINS:
                text = text.replace(unpinned, pinned)
            (tools / item.name).write_text(text)
    baseline = copy.deepcopy(fixtures.LIFECYCLE)
    baseline["settings"]["deployment"]["launchTemplateId"] = namespaces.PRD_LAUNCH_TEMPLATE
    config = copy.deepcopy(baseline)
    config["settings"]["deployment"].update(amiId="ami-22222222222222222", launchTemplateVersion="3",
        stateMachineVersionArn="arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-prd-lifecycle:2")
    # The same promotion with recovery unwired: the plain --ami path the tooling admits.
    plain_baseline, plain_config = copy.deepcopy(baseline), copy.deepcopy(config)
    for value in (plain_baseline, plain_config):
        del value["recoveryVersionArn"], value["recoveryEnabled"]
    templates = []
    for phase, value in (("before", baseline), ("target", config), ("plain-before", plain_baseline), ("plain-target", plain_config)):
        project = root / phase / "app-computers"
        project.mkdir(parents=True)
        for name in ("package.json", "package-lock.json", "cdk.json", "tsconfig.json", "bin", "lib"):
            path = source / name
            (shutil.copytree if path.is_dir() else shutil.copyfile)(path, project / name)
        (project / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
        config_path = root / (phase + ".json")
        config_path.write_text(json.dumps(value))
        result = subprocess.run(["env", "EZIL_LIFECYCLE_CONFIG=" + str(config_path), "npm", "--offline",
            "--prefix", str(project), "run", "synth:lifecycle"], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("offline synth failed: " + result.stdout[-2000:] + result.stderr[-2000:])
        check(phase + " actual offline prd synth", True)
        templates.append(json.loads((project / "cdk.out/lifecycle/ezil-prd-lifecycle.template.json").read_text()))

    text = json.dumps(templates)
    check("prd templates name no mum/staging resource or origin",
          not any(t in text for t in ("ezil-mum", "billing-staging", "os-staging", "ezil-pilot")))
    check("lifecycle callback origin is os-prod", "https://os-prod.ezil.work" in text)
    resources = templates[1]["Resources"]
    callers = [r for r in resources.values() if r["Type"] == "AWS::IAM::Role" and r["Properties"].get("RoleName") == "ezil-prd-app-caller"]
    check("app caller is the fixed /ezil/prd/ezil-prd-app-caller with one production EC2 trust",
          len(callers) == 1 and callers[0]["Properties"]["Path"] == "/ezil/prd/" and
          callers[0]["Properties"]["AssumeRolePolicyDocument"]["Statement"] == [{"Action": "sts:AssumeRole",
              "Condition": {"StringEquals": {"aws:PrincipalTag/ezil:env": "production"}}, "Effect": "Allow",
              "Principal": {"AWS": fixtures.HOST}}], json.dumps(callers))
    check("recovery workflow synthesized without a release tuple",
          any(r["Type"] == "AWS::StepFunctions::StateMachine" and "ezil-prd-recovery" in json.dumps(r) for r in resources.values()))
    check("plain shape synthesizes no recovery workflow",
          not any("ezil-prd-recovery" in json.dumps(r) for t in templates[2:] for r in t["Resources"].values()))
    (root / "stack.json").write_text(json.dumps({"Stacks": [{"StackStatus": "UPDATE_COMPLETE", "RoleARN": role, "Parameters": []}]}))

    def changeset(before, after):
        result = {"Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "RoleARN": role, "Parameters": [], "Changes": []}
        for logical in sorted(before["Resources"].keys() | after["Resources"].keys()):
            a, b = before["Resources"].get(logical), after["Resources"].get(logical)
            if a == b:
                continue
            resource = {"LogicalResourceId": logical, "ResourceType": (a or b)["Type"]}
            if a is None or b is None:
                resource["Action"] = "Add" if a is None else "Remove"
            else:
                resource.update(Action="Modify", Replacement="False", Scope=["Properties"], Details=[
                    {"Target": {"Attribute": "Properties", "Name": key, "RequiresRecreation": "Never"},
                     "ChangeSource": "DirectModification", "Evaluation": "Static"}
                    for key in a["Properties"] if a["Properties"][key] != b["Properties"][key]])
            for context, value in (("BeforeContext", a), ("AfterContext", b)):
                resource[context] = json.dumps({"Properties": value.get("Properties", {})} if value else {})
            result["Changes"].append({"Type": "Resource", "ResourceChange": resource})
        return result

    def validate(label, before, candidate, configs, error=None, cs=None, reverse=False):
        for name, value in (("live", {"TemplateBody": before}), ("baseline", before), ("candidate", candidate),
                            ("config-before", configs[0]), ("config-after", configs[1])):
            (root / (name + ".json")).write_text(json.dumps(value))
        paths = [str(root / (name + ".json")) for name in ("live", "baseline", "candidate", "config-before", "config-after")]
        if reverse:
            paths.append("true")
        operation = "lifecycle-template"
        if cs is not None:
            operation = "lifecycle-changeset"
            (root / "changeset.json").write_text(json.dumps(cs))
            paths = [str(root / "changeset.json"), str(root / "stack.json"), *paths]
        result = subprocess.run(["python3", "-B", str(tools / "json-tool.py"), "--namespace", "prd", operation, *paths],
                                capture_output=True, text=True)
        ok = result.returncode == 0 if error is None else result.returncode == 1 and error in result.stderr
        check(label, ok, result.stdout + result.stderr)

    # Founder shape: CloudFormation would republish the recovery workflow while
    # recoveryVersionArn stays old, so the Reconciler would keep the old observer.
    old, new = templates[:2]
    recovery = "cannot promote a lifecycle with recovery"
    validate("real prd promotion with recovery and no tuple refused", old, new, (baseline, config), error=recovery)
    validate("exact real prd change set with recovery refused", old, new, (baseline, config), cs=changeset(old, new), error=recovery)
    validate("real prd rollback with recovery refused", new, old, (config, baseline), reverse=True, error=recovery)
    old, new = templates[2:]
    baseline, config = plain_baseline, plain_config
    validate("real prd promotion accepted", old, new, (baseline, config))
    validate("exact real prd change set accepted", old, new, (baseline, config), cs=changeset(old, new))
    validate("real prd rollback accepted", new, old, (config, baseline), reverse=True)
    validate("exact prd rollback change set accepted", new, old, (config, baseline), cs=changeset(new, old), reverse=True)

    def mutated(mutate):
        value = copy.deepcopy(new)
        mutate(value["Resources"])
        return value

    caller = next(k for k, r in new["Resources"].items() if r["Properties"].get("RoleName") == "ezil-prd-app-caller")
    validate("widened app-caller trust refused", old, mutated(lambda r: r[caller]["Properties"]["AssumeRolePolicyDocument"]["Statement"].append(
        {"Action": "sts:AssumeRole", "Effect": "Allow", "Principal": {"AWS": "arn:aws:iam::452630323510:role/other"}})), (baseline, config),
        error="not forced by AMI/version pair")
    observer = next(k for k, r in new["Resources"].items() if r["Type"] == "AWS::Lambda::Function" and
                    "EZIL_LIFECYCLE_SETTINGS" in json.dumps(r["Properties"].get("Environment", {})))

    def staging_origin(resources):
        env = resources[observer]["Properties"]["Environment"]["Variables"]
        env["EZIL_LIFECYCLE_SETTINGS"] = json.dumps(env["EZIL_LIFECYCLE_SETTINGS"]).replace("os-prod", "os-staging") \
            if not isinstance(env["EZIL_LIFECYCLE_SETTINGS"], str) else env["EZIL_LIFECYCLE_SETTINGS"].replace("os-prod", "os-staging")
    validate("authority origin moved to staging refused", old, mutated(staging_origin), (baseline, config), error="not forced")
    staging = copy.deepcopy(config)
    staging["settings"]["authorityOrigin"] = "https://os-staging.ezil.work"
    validate("prd config with the staging origin refused", old, new, (baseline, staging), error="authority origin mismatch")
    tuple_config = copy.deepcopy(config)
    tuple_config["settings"]["deployment"]["releases"] = []
    validate("prd config with a release registry refused", old, new, (baseline, tuple_config), error="no rebase tuple")
print(f"RESULT: {passed} passed, {failed} failed")
raise SystemExit(1 if failed else 0)
