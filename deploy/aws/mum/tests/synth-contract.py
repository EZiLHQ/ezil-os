#!/usr/bin/env python3
"""Optional real, offline CDK probe using only the repository's example config.

Requires installed, pinned infra dependencies. Exercises the real promotion and
rollback diffs and refuses template/change-set mutations outside that contract.
"""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

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
with tempfile.TemporaryDirectory(prefix="ezil-mum-real-synth.") as folder:
    root = Path(folder)
    config = json.loads((source / "config/lifecycle.example.json").read_text()
                        .replace("123456789012", "452630323510").replace("pilot", "mum"))
    config.pop("recoveryVersionArn", None)
    # json-tool pins each namespace's lifecycle callback origin (mum: billing staging).
    config["settings"]["authorityOrigin"] = "https://os-staging.ezil.work"
    baseline = copy.deepcopy(config)
    config["settings"]["deployment"].update(amiId="ami-22222222222222222", launchTemplateVersion="2",
        stateMachineVersionArn="arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle:2")
    templates = []
    for phase, value in (("before", baseline), ("target", config)):
        project = root / phase / "app-computers"
        project.mkdir(parents=True)
        for name in ("package.json", "package-lock.json", "cdk.json", "tsconfig.json", "bin", "lib"):
            path = source / name
            if path.is_dir():
                shutil.copytree(path, project / name)
            else:
                shutil.copyfile(path, project / name)
        (project / "node_modules").symlink_to(source / "node_modules", target_is_directory=True)
        config_path = root / (phase + ".json")
        config_path.write_text(json.dumps(value))
        result = subprocess.run(["env", "EZIL_LIFECYCLE_CONFIG=" + str(config_path), "npm", "--offline",
            "--prefix", str(project), "run", "synth:lifecycle"], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("offline synth failed: " + result.stdout[-2000:] + result.stderr[-2000:])
        check(phase + " actual offline synth", True)
        templates.append(json.loads((project / "cdk.out/lifecycle/ezil-mum-lifecycle.template.json").read_text()))
    old, new = [t["Resources"] for t in templates]
    assert any(r["Type"] == "AWS::Lambda::Version" for k, r in new.items() if k not in old)
    assert any(r["Type"] == "AWS::IAM::Policy" and r != new.get(k) for k, r in old.items())
    for logical in sorted(old.keys() | new.keys()):
        if old.get(logical) != new.get(logical):
            action = "ADD" if logical not in old else "REMOVE" if logical not in new else "MODIFY"
            print(action, logical, (old.get(logical) or new[logical])["Type"])
    policy = next(k for k in old if old[k]["Type"] == "AWS::IAM::Policy" and old[k] != new[k])
    observer = next(k for k in old if old[k]["Type"] == "AWS::Lambda::Function" and old[k] != new[k])
    workflow = next(k for k in old if old[k]["Type"] == "AWS::StepFunctions::StateMachine" and old[k] != new[k])
    removed, added = next(iter(old.keys() - new.keys())), next(iter(new.keys() - old.keys()))
    role = "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec"
    stack = {"Stacks": [{"StackStatus": "UPDATE_COMPLETE", "RoleARN": role, "Parameters": []}]}
    (root / "stack.json").write_text(json.dumps(stack))

    def changeset(before, after):
        result = {"Status": "CREATE_COMPLETE", "ExecutionStatus": "AVAILABLE", "RoleARN": role,
                  "Parameters": [], "Changes": []}
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

    def validate(label, candidate=None, error=None, cs=None, before=None, reverse=False):
        a = templates[0] if before is None else before
        b = templates[1] if candidate is None else candidate
        config_a, config_b = baseline, config
        if reverse:
            config_a, config_b = config, baseline
        for name, value in (("live", {"TemplateBody": a}), ("baseline", a), ("candidate", b),
                            ("config-before", config_a), ("config-after", config_b)):
            (root / (name + ".json")).write_text(json.dumps(value))
        paths = [str(root / (name + ".json")) for name in
                 ("live", "baseline", "candidate", "config-before", "config-after")]
        if reverse:
            paths.append("true")
        operation = "lifecycle-template"
        if cs is not None:
            operation = "lifecycle-changeset"
            (root / "changeset.json").write_text(json.dumps(cs))
            paths = [str(root / "changeset.json"), str(root / "stack.json"), *paths]
        result = subprocess.run(["python3", str(repo / "deploy/aws/mum/json-tool.py"), operation, *paths],
                                capture_output=True, text=True)
        ok = result.returncode == 0 if error is None else result.returncode == 1 and error in result.stderr
        check(label, ok, result.stdout + result.stderr)

    validate("real offline promotion accepted")
    exact_cs = changeset(*templates)
    validate("exact real synth change set accepted", cs=exact_cs)
    validate("real offline rollback accepted", before=templates[1], candidate=templates[0], reverse=True)
    validate("exact rollback change set accepted", before=templates[1], candidate=templates[0],
             cs=changeset(templates[1], templates[0]), reverse=True)

    # All template mutations start with the real synthesized candidate; the
    # authorized AMI, environment and Version changes remain present throughout.
    def template_case(label, mutate, error="not forced"):
        candidate = copy.deepcopy(templates[1])
        mutate(candidate["Resources"])
        validate(label, candidate=candidate, error=error)

    def statements(resources):
        return resources[policy]["Properties"]["PolicyDocument"]["Statement"]

    def add_action(resources):
        statement = next(s for s in statements(resources) if isinstance(s["Action"], list))
        statement["Action"].append("iam:PassRole")

    template_case("extra IAM action refused", add_action)
    template_case("widened IAM Resource refused", lambda r: statements(r)[0].update(Resource="*"))
    template_case("extra IAM principal refused", lambda r: statements(r)[0].update(Principal={"AWS": "*"}))
    template_case("extra IAM statement refused", lambda r: statements(r).append(
        {"Effect": "Allow", "Action": "iam:*", "Resource": "*"}))
    def renumber_condition(resources):
        condition = next(s["Condition"]["StringEquals"] for s in statements(resources)
                         if s.get("Condition", {}).get("StringEquals", {}).get("aws:ResourceTag/ezil:pool") == "1")
        condition["aws:ResourceTag/ezil:pool"] = "2"

    template_case("unrelated numeric IAM condition refused", renumber_condition)
    key = next(k for k, v in new.items() if v["Type"] == "AWS::KMS::Key")
    template_case("boolean-to-number property mutation refused", lambda r: r[key]["Properties"].update(EnableKeyRotation=1))
    template_case("unrelated environment setting refused", lambda r:
        r[observer]["Properties"]["Environment"]["Variables"].update(EZIL_LIFECYCLE_SETTINGS="{}"))
    template_case("extra resource refused", lambda r: r.update(UnexpectedBucket={"Type": "AWS::S3::Bucket"}),
                  "resource addition/removal refused")
    template_case("non-paired Version removal refused", lambda r: r.pop(added), "resource addition/removal refused")
    template_case("non-paired Version addition refused", lambda r: r.update({removed: copy.deepcopy(old[removed])}),
                  "resource addition/removal refused")
    template_case("second Version pair refused", lambda r: r.update(ExtraVersion=copy.deepcopy(r[added])),
                  "resource addition/removal refused")
    template_case("Version pair for another function refused", lambda r:
        r[added]["Properties"].update(FunctionName={"Ref": "OtherFunction"}), "same function")
    template_case("unforced Version property refused", lambda r:
        r[added]["Properties"].update(ProvisionedConcurrencyConfig={"ProvisionedConcurrentExecutions": 5}))
    template_case("unproven Version code hash refused", lambda r:
        r[added]["Properties"].update(CodeSha256="unrelated-code-hash"))
    template_case("unproven Version description refused", lambda r:
        r[added]["Properties"].update(Description="unrelated description"))
    template_case("Version attribute change refused", lambda r: r[added].update(DeletionPolicy="Delete"))
    template_case("Version pair without environment change refused", lambda r:
        r[observer]["Properties"].update(Environment=copy.deepcopy(old[observer]["Properties"]["Environment"])))
    template_case("Lambda code change refused", lambda r:
        r[observer]["Properties"]["Code"].update(S3Key="unrelated.zip"))
    template_case("unrelated existing property change refused", lambda r: r[observer]["Properties"].update(MemorySize=512))
    template_case("extra property refused", lambda r: r[observer]["Properties"].update(Description="unrelated"),
                  "not forced")
    template_case("resource type change refused", lambda r: r[policy].update(Type="AWS::IAM::ManagedPolicy"),
                  "resource type changed")
    template_case("metadata change refused", lambda r: r[policy]["Metadata"].update(unrelated=True),
                  "resource attributes")

    # Nested Join/Sub strings and a standalone published version number. The
    # literals contain unrelated account/number strings which must stay intact.
    intrinsic_templates = copy.deepcopy(templates)
    for index, (value, deployment) in enumerate(zip(intrinsic_templates, (baseline, config))):
        d = deployment["settings"]["deployment"]
        version = removed if index == 0 else added
        statements(value["Resources"])[0]["Resource"] = {"Fn::Sub": "${" + version + "}"}
        statements(value["Resources"]).append({"Effect": "Allow", "Action": "states:StartExecution", "Resource": {
            "Fn::Join": ["", [{"Fn::Sub": ["${Machine}:${Number}", {
                "Machine": d["stateMachineVersionArn"].rsplit(":", 1)[0],
                "Number": d["stateMachineVersionArn"].rsplit(":", 1)[1]}]},
                {"Fn::Sub": ["${Ami}", {"Ami": d["amiId"]}]}]]}})
    validate("recursive Join/Sub and published number substitutions accepted", before=intrinsic_templates[0],
             candidate=intrinsic_templates[1])
    number_templates = copy.deepcopy(templates)
    for index, value in enumerate(number_templates):
        d = (baseline, config)[index]["settings"]["deployment"]
        number = d["stateMachineVersionArn"].rsplit(":", 1)[1]
        for resource in (
            {"Fn::Join": [":", [d["stateMachineVersionArn"].rsplit(":", 1)[0], number]]},
            {"Fn::Sub": "arn:${AWS::Partition}:states:${AWS::Region}:${AWS::AccountId}:stateMachine:ezil-mum-lifecycle:" + number},
        ):
            statements(value["Resources"]).append({"Effect": "Allow", "Action": "states:StartExecution", "Resource": resource})
    validate("qualified Join suffix and Sub literal version numbers accepted", before=number_templates[0],
             candidate=number_templates[1])

    prefix_templates = copy.deepcopy(templates)
    for index, value in enumerate(prefix_templates):
        statements(value["Resources"]).append({"Effect": "Allow", "Action": "states:StartExecution",
            "Resource": (baseline, config)[index]["settings"]["deployment"]["stateMachineVersionArn"] + "0"})
    validate("version substitution cannot rewrite a different version's prefix", before=prefix_templates[0],
             candidate=prefix_templates[1], error="not forced")

    literal_templates = copy.deepcopy(templates)
    for index, value in enumerate(literal_templates):
        statements(value["Resources"])[0]["Sid"] = removed if index == 0 else added
    validate("Version logical IDs in unrelated literals cannot change", before=literal_templates[0],
             candidate=literal_templates[1], error="not forced")
    shadowed_templates = copy.deepcopy(templates)
    for index, value in enumerate(shadowed_templates):
        statements(value["Resources"])[0]["Resource"] = {"Fn::Sub": [
            "${" + (removed if index == 0 else added) + "}", {removed: "fixed", added: "fixed"}]}
    validate("Sub variables shadowing Version IDs cannot be renamed", before=shadowed_templates[0],
             candidate=shadowed_templates[1], error="not forced")

    def entry(cs, logical):
        return next(c["ResourceChange"] for c in cs["Changes"] if c["ResourceChange"]["LogicalResourceId"] == logical)

    def changeset_case(label, mutate, error="unexpected lifecycle resource change"):
        cs = copy.deepcopy(exact_cs)
        mutate(cs)
        validate(label, cs=cs, error=error)

    changeset_case("extra change-set resource refused", lambda cs: cs["Changes"].append({"Type": "Resource",
        "ResourceChange": {"Action": "Add", "LogicalResourceId": "Extra", "ResourceType": "AWS::S3::Bucket"}}))
    changeset_case("missing change-set resource refused", lambda cs: cs["Changes"].pop(), "omits synthesized")
    changeset_case("duplicate change-set resource refused", lambda cs: cs["Changes"].append(copy.deepcopy(cs["Changes"][0])))
    changeset_case("change-set Version pair must include addition", lambda cs:
        cs["Changes"].remove(next(c for c in cs["Changes"] if c["ResourceChange"]["LogicalResourceId"] == added)),
        "omits synthesized")
    changeset_case("change-set Version pair must include removal", lambda cs:
        cs["Changes"].remove(next(c for c in cs["Changes"] if c["ResourceChange"]["LogicalResourceId"] == removed)),
        "omits synthesized")
    changeset_case("Version pair cannot be a Modify entry", lambda cs: entry(cs, added).update(Action="Modify"))
    changeset_case("unrelated resource replacement refused", lambda cs: entry(cs, policy).update(Replacement="True"),
                  "resource replacement refused")
    changeset_case("conditional replacement refused", lambda cs: entry(cs, observer).update(Replacement="Conditional"),
                  "resource replacement refused")
    changeset_case("extra change-set property refused", lambda cs: entry(cs, observer)["Details"].append({
        "Target": {"Attribute": "Properties", "Name": "MemorySize", "RequiresRecreation": "Never"},
        "ChangeSource": "DirectModification", "Evaluation": "Static"}), "unexpected lifecycle property")
    changeset_case("missing change-set property refused", lambda cs: entry(cs, policy).update(Details=[]),
                  "unexplained lifecycle resource change")
    changeset_case("mismatched change-set property values refused", lambda cs: entry(cs, policy).update(
        AfterContext=json.dumps({"Properties": {"PolicyDocument": {}}})), "values differ")
    changeset_case("mismatched Version context refused", lambda cs: entry(cs, added).update(
        AfterContext=json.dumps({"Properties": {"FunctionName": {"Ref": "OtherFunction"}}})), "values differ")
    changeset_case("Version action cannot hide replacement metadata", lambda cs: entry(cs, added).update(Replacement="True"),
                  "unexplained Lambda Version pair")

    dynamic_cs = copy.deepcopy(exact_cs)
    for logical in (policy, workflow):
        detail = copy.deepcopy(entry(dynamic_cs, logical)["Details"][0])
        detail.update(ChangeSource="ResourceReference", CausingEntity=added, Evaluation="Dynamic")
        entry(dynamic_cs, logical)["Details"].append(detail)
    validate("exact Version reference dependencies accepted", cs=dynamic_cs)
    validate("Fn::Sub Version reference dependencies accepted", before=intrinsic_templates[0],
             candidate=intrinsic_templates[1], cs={
                 **dynamic_cs, "Changes": [{"Type": c["Type"], "ResourceChange": {
                     k: v for k, v in c["ResourceChange"].items() if k not in ("BeforeContext", "AfterContext")}}
                     for c in dynamic_cs["Changes"]]})
    changeset_case("unrelated dynamic reference refused", lambda cs: entry(cs, observer)["Details"][0].update(
        ChangeSource="ResourceReference", CausingEntity=added, Evaluation="Dynamic"), "unexpected lifecycle property")
    changeset_case("unexplained dynamic modification refused", lambda cs: entry(cs, observer)["Details"][0].update(
        Evaluation="Dynamic"), "unexpected lifecycle property")
    changeset_case("wrong Version reference attribute refused", lambda cs: entry(cs, policy)["Details"][0].update(
        ChangeSource="ResourceAttribute", CausingEntity=added + ".Bogus", Evaluation="Dynamic"), "unexpected lifecycle property")

print(f"RESULT: {passed} passed, {failed} failed")
raise SystemExit(bool(failed))
