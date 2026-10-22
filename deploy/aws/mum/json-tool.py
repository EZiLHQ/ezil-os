#!/usr/bin/env python3
"""Strict JSON transforms for the M5 scripts. Secret payloads stay in memory."""
import copy
import json
import os
import re
import subprocess
import sys
import tempfile

ACCOUNT = "452630323510"
REGION = "ap-south-1"
MACHINE = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:ezil-mum-lifecycle"
KEY = "EZIL_AWS_LIFECYCLE_DEPLOYMENTS"
SECRET = "ezil-os/billing-staging/app"
ALLOWED = {"DesktopImageDigest", "DesktopImageId", "AgentSrcS3Uri"}
ROLE = f"arn:aws:iam::{ACCOUNT}:role/ezil/identity/ezil-mum-cfn-exec"


def need(ok, message):
    if not ok:
        raise ValueError(message)


def read(path):
    with open(path, encoding="utf-8") as source:
        return json.load(source)


def write(path, value):
    """Atomic, private file for NONSECRET configuration and release evidence only."""
    folder = os.path.dirname(os.path.abspath(path))
    fd, temp = tempfile.mkstemp(dir=folder, prefix=".mum-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            json.dump(value, out, indent=2)
            out.write("\n")
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def mapping(parameters):
    result = {p["ParameterKey"]: p for p in parameters}
    need(len(result) == len(parameters), "duplicate parameter")
    return result


def stack(path):
    stacks = read(path)["Stacks"]
    need(len(stacks) == 1, "expected one stack")
    value = stacks[0]
    need(value["StackStatus"] in ("CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"), "stack is not stable")
    need(value.get("RoleARN", ROLE) == ROLE, "unexpected CloudFormation execution role")
    return value


def template(path):
    body = read(path)["TemplateBody"]
    return json.loads(body) if isinstance(body, str) else body


def pair(config):
    d = config["settings"]["deployment"]
    need(d["accountId"] == ACCOUNT and d["region"] == REGION and d["namespace"] == "mum", "config account/region/namespace mismatch")
    need(re.fullmatch(r"ami-[0-9a-f]{17}", d["amiId"]), "invalid AMI")
    need(re.fullmatch(re.escape(MACHINE) + r":[1-9][0-9]*", d["stateMachineVersionArn"]), "invalid lifecycle version")
    return {k: d[k] for k in ("amiId", "stateMachineVersionArn")}


def versions(path):
    arns = [v["stateMachineVersionArn"] for v in read(path)["stateMachineVersions"]]
    need(arns and all(re.fullmatch(re.escape(MACHINE) + r":[1-9][0-9]*", a) for a in arns), "invalid/empty published lifecycle versions")
    return arns


def check_changeset(cs):
    need(cs["Status"] == "CREATE_COMPLETE" and cs["ExecutionStatus"] == "AVAILABLE", "change set is not executable")
    need(not cs.get("NextToken"), "incomplete change set; pagination must be resolved")
    need(cs.get("RoleARN", ROLE) == ROLE, "change set uses unexpected role")
    need(bool(cs.get("Changes")), "empty change set")


def recipe_version(value):
    need(isinstance(value, str) and re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", value), "recipe version must be x.y.z without leading zeroes")
    parts = tuple(int(p) for p in value.split("."))
    need(all(p <= 1073741823 for p in parts), "recipe version exceeds Image Builder limits")
    return parts


def ami_config(path):
    value = read(path)
    need(set(value) == {"namespace", "accountId", "region", "version"}, "unexpected AMI config fields")
    need(value["namespace"] == "mum" and value["accountId"] == ACCOUNT and value["region"] == REGION, "AMI config account/region/namespace mismatch")
    recipe_version(value["version"])
    return value


def version_pair(before_path, after_path):
    before, after = ami_config(before_path), ami_config(after_path)
    need(recipe_version(after["version"]) > recipe_version(before["version"]), "recipe version must be greater than current version")
    need({**before, "version": after["version"]} == after, "unexpected AMI config change")
    return before["version"], after["version"]


def replace_version(value, before, after):
    if isinstance(value, str):
        return value.replace(before, after)
    if isinstance(value, list):
        return [replace_version(v, before, after) for v in value]
    if isinstance(value, dict):
        return {k: replace_version(v, before, after) for k, v in value.items()}
    return value


def ami_template(old_path, candidate_path, before_path, after_path):
    """Prove the synthesized template contains only the authorized version update.

    In particular, an allowed Image Builder type does not grant permission to
    change its subnet, role, KMS key, parent AMI or any other build settings.
    """
    previous_version, next_version = version_pair(before_path, after_path)
    previous, candidate = template(old_path), read(candidate_path)
    need({k: v for k, v in previous.items() if k != "Resources"} ==
         {k: v for k, v in candidate.items() if k != "Resources"}, "unexpected template parameter/output/metadata change")
    old, new = previous["Resources"], candidate["Resources"]
    need(old.keys() == new.keys(), "unexpected template resource addition/removal")
    types = {name: "AWS::ImageBuilder::" + name for name in (
        "Component", "ImageRecipe", "ImagePipeline", "DistributionConfiguration", "InfrastructureConfiguration")}
    for kind in ("Component", "ImageRecipe", "ImagePipeline"):
        need(sum(r["Type"] == types[kind] for r in old.values()) == 1, "expected one component, recipe and pipeline")
    changes = {}
    for logical, resource in old.items():
        proposed = new[logical]
        need(resource["Type"] == proposed["Type"], "unexpected template resource type change")
        kind = resource["Type"]
        if kind not in types.values():
            need(resource == proposed, "unexpected template resource change: " + logical)
            continue
        need({k: v for k, v in resource.items() if k != "Properties"} ==
             {k: v for k, v in proposed.items() if k != "Properties"}, "unexpected resource attributes: " + logical)
        a, b = resource.get("Properties", {}), proposed.get("Properties", {})
        need(a.keys() == b.keys(), "unexpected property addition/removal: " + logical)
        delta = {key for key in a if a[key] != b[key]}
        if kind in (types["Component"], types["ImageRecipe"]):
            need(a.get("Version") == previous_version, "live recipe/component version differs from local config")
            need(b.get("Version") == next_version, "synthesized recipe/component version mismatch")
            permitted = {"Version", "Data"} if kind == types["Component"] else {"Version"}
            need(delta <= permitted, "unexpected component/recipe property change")
        elif delta:
            # Today's CDK source does not put the version into these resources.
            # Accept only a literal version substitution if a reviewed source
            # does so; no unrelated distribution/infrastructure changes.
            need(replace_version(a, previous_version, next_version) == b,
                 "configuration change is not forced by the version string: " + logical)
        changes[logical] = delta
    return old, changes


def versioned_ami_changes(cs, resources, template_changes):
    by_type = {r["Type"]: k for k, r in resources.items() if r["Type"].startswith("AWS::ImageBuilder::")}
    component = by_type["AWS::ImageBuilder::Component"]
    recipe = by_type["AWS::ImageBuilder::ImageRecipe"]
    pipeline = by_type["AWS::ImageBuilder::ImagePipeline"]
    seen = set()
    for change in cs["Changes"]:
        need(change["Type"] == "Resource", "unexpected non-resource change")
        r = change["ResourceChange"]
        logical = r["LogicalResourceId"]
        need(logical in template_changes and logical not in seen and r["Action"] == "Modify", "unexpected resource change")
        seen.add(logical)
        need(r["ResourceType"] == resources[logical]["Type"], "resource type mismatch")
        need(set(r["Scope"]) == {"Properties"} and bool(r.get("Details")), "unexplained resource change")
        direct = template_changes[logical]
        targets = set()
        for detail in r["Details"]:
            target = detail["Target"]
            need(target["Attribute"] == "Properties", "non-property resource change")
            name, source = target["Name"], detail["ChangeSource"]
            cause = detail.get("CausingEntity", "").split(".")[0]
            targets.add(name)
            expected = name in direct and source == "DirectModification"
            if logical == recipe and name == "Components":
                expected |= (source == "ParameterReference" and cause in ALLOWED) or (source in ("ResourceReference", "ResourceAttribute") and cause == component)
            if logical == pipeline:
                dependencies = {"ImageRecipeArn": recipe}
                for kind, prop in (("InfrastructureConfiguration", "InfrastructureConfigurationArn"), ("DistributionConfiguration", "DistributionConfigurationArn")):
                    dependency = by_type.get("AWS::ImageBuilder::" + kind)
                    if dependency and template_changes.get(dependency):
                        dependencies[prop] = dependency
                expected |= name in dependencies and source in ("ResourceReference", "ResourceAttribute") and cause == dependencies[name]
            need(expected, "unexpected versioned Image Builder property change")
        need(direct <= targets, "change set omits synthesized property changes")
        if logical in (component, recipe):
            need(r.get("Replacement") == "True" and "Version" in targets, "version bump must replace component and recipe")
        elif not direct:
            need(r.get("Replacement") == "False", "unexpected dependent resource replacement")
    need({component, recipe} <= seen, "change set omits component/recipe version replacement")


def ami_changeset(old_path, wanted_path, cs_path, template_path, *version_paths):
    old = mapping(stack(old_path)["Parameters"])
    wanted = mapping(read(wanted_path))
    cs = read(cs_path)
    check_changeset(cs)
    actual = mapping(cs["Parameters"])
    need(old.keys() == wanted.keys() == actual.keys(), "parameter coverage mismatch")
    for key in old:
        if key in ALLOWED:
            need(actual[key].get("ParameterValue") == wanted[key]["ParameterValue"], "unexpected allowed parameter value")
        else:
            need(wanted[key] == {"ParameterKey": key, "UsePreviousValue": True}, "extra parameter change requested")
            need(actual[key].get("ParameterValue", old[key].get("ParameterValue") if actual[key].get("UsePreviousValue") else None) == old[key].get("ParameterValue"), "extra parameter change in change set")
            need(actual[key].get("ResolvedValue") == old[key].get("ResolvedValue"), "resolved SSM parameter changed")
    if version_paths:
        resources, changes = ami_template(template_path, *version_paths)
        versioned_ami_changes(cs, resources, changes)
        return
    resources = template(template_path)["Resources"]
    recipes = [k for k, v in resources.items() if v["Type"] == "AWS::ImageBuilder::ImageRecipe"]
    pipelines = [k for k, v in resources.items() if v["Type"] == "AWS::ImageBuilder::ImagePipeline"]
    need(len(recipes) == len(pipelines) == 1, "expected one recipe and pipeline")
    recipe, pipeline = recipes[0], pipelines[0]
    for change in cs["Changes"]:
        need(change["Type"] == "Resource", "unexpected non-resource change")
        r = change["ResourceChange"]
        logical = r["LogicalResourceId"]
        need(logical in (recipe, pipeline) and r["Action"] == "Modify", "unexpected resource change")
        need(r["ResourceType"] == resources[logical]["Type"], "resource type mismatch")
        need(set(r["Scope"]) == {"Properties"} and bool(r.get("Details")), "unexplained resource change")
        for detail in r["Details"]:
            target = detail["Target"]
            need(target["Attribute"] == "Properties", "non-property resource change")
            if logical == recipe:
                need(target["Name"] == "Components" and detail["ChangeSource"] == "ParameterReference" and detail["CausingEntity"] in ALLOWED, "unexpected recipe change")
            else:
                need(target["Name"] == "ImageRecipeArn" and detail["ChangeSource"] in ("ResourceReference", "ResourceAttribute") and detail["CausingEntity"].split(".")[0] == recipe, "unexpected pipeline change")
        if logical == recipe:
            # --use-previous-template fixes Name + Version. Components require a
            # replacement, which cannot create a second identical name/version.
            need(r.get("Replacement") == "False" and all(d["Target"].get("RequiresRecreation") == "Never" for d in r["Details"]),
                 "immutable Image Builder recipe replacement: contract needs a reviewed recipe version bump; refusing execution")


def secret_aws(args, payload=None):
    command = ["aws", "--profile", "ezil-admin", "--region", REGION, "--no-cli-pager", "secretsmanager", *args]
    result = subprocess.run(command, input=payload, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=90)
    # Do not relay AWS stderr: a validation error can contain request material.
    need(result.returncode == 0, "Secrets Manager command failed (details suppressed)")
    return json.loads(result.stdout)


def edit_secret(envelope, before, after):
    outer = json.loads(envelope["SecretString"])
    need(isinstance(outer, dict), "app secret must be an object")
    raw = outer[KEY]
    deployments = json.loads(raw) if isinstance(raw, str) else copy.deepcopy(raw)
    need(isinstance(deployments, dict) and isinstance(deployments.get(REGION), dict), "regional deployments missing")
    d = deployments[REGION]
    # Both fields must match together: do not accept a half-applied deployment.
    current = {k: d.get(k) for k in before}
    need(current in (before, after), "secret deployment drift; refusing overwrite")
    d.update(after)
    outer[KEY] = json.dumps(deployments, separators=(",", ":")) if isinstance(raw, str) else deployments
    return outer


def secret_update(before_path, after_path, apply):
    before, after = pair(read(before_path)), pair(read(after_path))
    envelope = secret_aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"])
    updated = edit_secret(envelope, before, after)
    if apply:
        check = secret_aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"])
        need(check["VersionId"] == envelope["VersionId"], "secret changed during promotion; rerun after review")
        request = {"SecretId": SECRET, "SecretString": json.dumps(updated, separators=(",", ":"))}
        secret_aws(["put-secret-value", "--cli-input-json", "file:///dev/stdin", "--output", "json"], json.dumps(request))
        verify = secret_aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"])
        need(json.loads(verify["SecretString"]) == updated, "secret verification failed")
    print("App deployment fields verified" if not apply else "App deployment fields updated and verified")


def main(args):
    op, *a = args
    if op == "parameters":
        current = stack(a[0])
        old = mapping(current["Parameters"])
        need(ALLOWED <= old.keys(), "required AMI parameters missing")
        need(old["AssetBucketName"]["ParameterValue"] == "ezil-mum-deploy-assets-452630323510", "asset bucket mismatch")
        need(old["ApplicationImageRepositoryUri"]["ParameterValue"] == f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6", "ECR repository mismatch")
        values = dict(zip(("DesktopImageDigest", "DesktopImageId", "AgentSrcS3Uri"), a[1:4]))
        write(a[4], [{"ParameterKey": key, **({"ParameterValue": values[key]} if key in ALLOWED else {"UsePreviousValue": True})} for key in old])
    elif op == "manifest":
        response = read(a[0])
        need(not response.get("failures") and len(response["images"]) == 1, "ECR did not return one image")
        record = response["images"][0]
        manifest = json.loads(record["imageManifest"])
        pushed = record["imageId"]["imageDigest"]
        need(manifest.get("schemaVersion") == 2 and re.fullmatch(r"sha256:[0-9a-f]{64}", pushed), "invalid ECR manifest")
        if "manifests" in manifest:
            # containerd image store: the local ID is the index digest. Accept exactly one
            # linux/amd64 image plus attestation manifests only, and pin the AMI to that
            # child manifest (the bake host also uses the containerd store, so its pulled
            # image ID is the digest it pulled; the live AMI already has digest == id).
            need(pushed == a[1], "image ID mismatch between ECR index and local Docker image")
            images = [m for m in manifest["manifests"] if (m.get("annotations") or {}).get("vnd.docker.reference.type") != "attestation-manifest"]
            need(len(images) == 1 and images[0].get("platform") == {"architecture": "amd64", "os": "linux"}, "index must hold exactly one linux/amd64 image")
            need(all((m.get("annotations") or {}).get("vnd.docker.reference.type") == "attestation-manifest" for m in manifest["manifests"] if m is not images[0]), "index holds unexpected manifests")
            child = images[0]["digest"]
            need(re.fullmatch(r"sha256:[0-9a-f]{64}", child), "invalid child digest")
            print(child, child)
        else:
            config = manifest["config"]["digest"]
            need(re.fullmatch(r"sha256:[0-9a-f]{64}", config), "invalid ECR digest")
            if pushed == a[1]:
                print(pushed, pushed)  # containerd store, single manifest: ID == manifest digest
            else:
                need(config == a[1], "image ID mismatch between ECR and local Docker image")
                print(pushed, config)  # classic store: ID == config digest
    elif op == "ami-changeset":
        ami_changeset(*a)
    elif op == "plan-ami":
        value = ami_config(a[0])
        need(recipe_version(a[1]) > recipe_version(value["version"]), "recipe version must be greater than current version")
        value["version"] = a[1]
        write(a[2], value)
    elif op == "ami-template":
        ami_template(*a)
    elif op == "persist-ami":
        version_pair(a[1], a[2])
        need(not os.path.islink(a[0]), "AMI config became a symlink")
        with open(a[0], "rb") as current, open(a[1], "rb") as backup:
            need(current.read() == backup.read(), "AMI config changed after stack update; reconcile saved config and stack before baking")
        write(a[0], ami_config(a[2]))
    elif op == "output":
        outputs = [o["OutputValue"] for o in stack(a[0]).get("Outputs", []) if o["OutputKey"] == a[1]]
        need(len(outputs) == 1, "missing/duplicate stack output")
        print(outputs[0])
    elif op == "build":
        image = read(a[0])["image"]
        status = image["state"]["status"]
        if status == "AVAILABLE":
            amis = [v["image"] for v in image["outputResources"]["amis"] if v["region"] == REGION and v.get("accountId", ACCOUNT) == ACCOUNT]
            need(len(amis) == 1 and re.fullmatch(r"ami-[0-9a-f]{17}", amis[0]), "expected one Mumbai AMI")
            print(status, amis[0])
        else:
            print(status)
    elif op == "image":
        images = read(a[0])["Images"]
        need(len(images) == 1, "expected one AMI")
        i = images[0]
        need(i["ImageId"] == a[1] and i["OwnerId"] == ACCOUNT and i["State"] == "available" and i["Architecture"] == "x86_64", "AMI identity/state/architecture mismatch")
    elif op == "plan-promotion":
        config = read(a[0]); previous = pair(config)
        published = versions(a[1])
        need(previous["stateMachineVersionArn"] in published, "configured lifecycle version is not published")
        need(previous["amiId"] != a[2], "AMI already configured")
        version = max(int(v.rsplit(":", 1)[1]) for v in published) + 1
        config["settings"]["deployment"].update(amiId=a[2], stateMachineVersionArn=f"{MACHINE}:{version}")
        pair(config)
        write(a[3], config)
        print(json.dumps({"previous": previous, "target": pair(config)}, indent=2))
    elif op == "pair":
        p = pair(read(a[0])); print(p["amiId"], p["stateMachineVersionArn"])
    elif op == "copy-config":
        config = read(a[0]); pair(config); write(a[1], config)
    elif op == "journal":
        need(not os.path.exists(a[2]), "promotion journal exists; rollback or archive the prior release directory")
        before, after = read(a[0]), read(a[1])
        pair(before); pair(after)
        write(a[2], {"previous": before, "target": after})
    elif op == "rollback":
        record, current = read(a[0]), read(a[1])
        need(current in (record["previous"], record["target"]), "config drift since promotion; refusing rollback")
        need(pair(record["previous"])["stateMachineVersionArn"] in versions(a[2]), "previous lifecycle version no longer published")
        write(a[3], record["previous"])
        write(a[4], record["target"])
        print(json.dumps({"rollback": pair(record["previous"])}, indent=2))
    elif op == "published":
        need(a[1] in versions(a[0]), "expected lifecycle version not published")
    elif op == "lifecycle-changeset":
        cs = read(a[0]); check_changeset(cs)
        # Named stack, existing reviewed CDK source. Show resource-only summary;
        # reject deletion/replacement of durable resources before execution.
        durable = {"AWS::KMS::Key", "AWS::Logs::LogGroup", "AWS::SQS::Queue", "AWS::StepFunctions::StateMachine"}
        for c in cs["Changes"]:
            r = c["ResourceChange"]
            need(r["ResourceType"] not in durable or (r["Action"] == "Modify" and r.get("Replacement") == "False"), "durable lifecycle resource replacement/removal refused")
            print(r["Action"], r["LogicalResourceId"], r["ResourceType"], r.get("Replacement", ""))
    elif op == "lifecycle-noop":
        cs = read(a[0])
        reason = cs.get("StatusReason", "")
        need(cs.get("Status") == "FAILED" and cs.get("ExecutionStatus") == "UNAVAILABLE" and not cs.get("Changes") and
             ("didn't contain changes" in reason or "No updates are to be performed" in reason), "failed change set is not a verified no-op")
        print("Rollback stack already matches the previous configuration; restoring app deployment fields")
    elif op in ("secret-check", "secret-update"):
        secret_update(*a, apply=op == "secret-update")
    else:
        raise ValueError("unknown operation")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        # Never include data/exception values on the secret path.
        secret_op = len(sys.argv) > 1 and sys.argv[1].startswith("secret-")
        print("ERROR: secret operation refused; inspect deployment alignment and AWS access" if secret_op else f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
