#!/usr/bin/env python3
"""Strict JSON transforms for the M5 scripts. Secret payloads stay in memory."""
import copy
import argparse
from contextlib import contextmanager
from datetime import datetime
import fcntl
import json
import os
import re
import subprocess
import sys
import tempfile

import rebase_app
import rebase_manifest as release

ACCOUNT = "452630323510"
REGION = "ap-south-1"
MACHINE = f"arn:aws:states:{REGION}:{ACCOUNT}:stateMachine:ezil-mum-lifecycle"
KEY = "EZIL_AWS_LIFECYCLE_DEPLOYMENTS"
SECRET = "ezil-os/billing-staging/app"
BASE_ALLOWED = {"DesktopImageDigest", "DesktopImageId", "AgentSrcS3Uri"}
PREVIOUS = {"PreviousDesktopImageDigest", "PreviousDesktopImageId"}
ALLOWED = BASE_ALLOWED | PREVIOUS
REPOSITORY = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/ezil/identity/ezil-mum-cfn-exec"
LAUNCH_TEMPLATE = "lt-06f691fc1e4dfe3cc"
APP_SECRET_LOCK = "/root/ezil-aws-mum/locks/app-secret.lock"


def need(ok, message):
    if not ok:
        raise ValueError(message)


def read(path):
    return release.read(path)


def write(path, value, *, serialized=None):
    """Atomic, private file for NONSECRET configuration and release evidence only."""
    need(serialized is None or release.loads(serialized) == value, 'serialized evidence mismatch')
    folder = os.path.dirname(os.path.abspath(path))
    fd, temp = tempfile.mkstemp(dir=folder, prefix=".mum-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            if serialized is None:
                json.dump(value, out, indent=2)
                out.write("\n")
            else:
                out.write(serialized)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, path)
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
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
    need(isinstance(d.get("launchTemplateVersion"), str) and re.fullmatch(r"[1-9][0-9]{0,9}", d["launchTemplateVersion"]), "invalid launch-template version")
    release.deployment_tuple(d)
    if "recoveryVersionArn" in config:
        need(config["recoveryVersionArn"] == d.get("recoveryStateMachineVersionArn"), "recovery version config mismatch")
    return {k: d[k] for k in ("amiId", "stateMachineVersionArn", "launchTemplateVersion", *release.TUPLE) if k in d}


def versions(path):
    arns = [v["stateMachineVersionArn"] for v in read(path)["stateMachineVersions"]]
    need(arns and all(re.fullmatch(re.escape(MACHINE) + r":[1-9][0-9]*", a) for a in arns), "invalid/empty published lifecycle versions")
    return arns


def check_changeset(cs):
    need(cs["Status"] == "CREATE_COMPLETE" and cs["ExecutionStatus"] == "AVAILABLE", "change set is not executable")
    need(not cs.get("NextToken"), "incomplete change set; pagination must be resolved")
    need(cs.get("RoleARN", ROLE) == ROLE, "change set uses unexpected role")
    need(bool(cs.get("Changes")), "empty change set")


def foundation_stack(path):
    value = stack(path)
    need(value.get("RoleARN") == ROLE, "foundation stack must use its execution role")
    parameters = mapping(value.get("Parameters") or [])
    need("HostAmiId" in parameters, "foundation HostAmiId parameter missing")
    return value, parameters


def foundation_resource(path):
    resource = read(path)["StackResourceDetail"]
    need(resource.get("LogicalResourceId") == "ComputerLaunchTemplate" and
         resource.get("ResourceType") == "AWS::EC2::LaunchTemplate" and
         resource.get("PhysicalResourceId") == LAUNCH_TEMPLATE,
         "foundation launch-template identity mismatch")


def launch_template(path):
    response = read(path)
    values = response["LaunchTemplateVersions"]
    need(not response.get("NextToken") and len(values) == 1, "expected one launch-template version")
    value = values[0]
    need(value.get("LaunchTemplateId") == LAUNCH_TEMPLATE and type(value.get("VersionNumber")) is int and
         0 < value["VersionNumber"] < 10**10, "launch-template identity/version mismatch")
    need(isinstance(value.get("LaunchTemplateData"), dict), "launch-template data missing")
    return value


def check_launch_template(config_path, version_path):
    config = read(config_path)
    deployment = pair(config)
    need(config["settings"]["deployment"].get("launchTemplateId") == LAUNCH_TEMPLATE, "configured launch-template identity mismatch")
    value = launch_template(version_path)
    need(str(value["VersionNumber"]) == deployment["launchTemplateVersion"] and
         value["LaunchTemplateData"].get("ImageId") == deployment["amiId"], "launch-template read-back AMI/version mismatch")
    return value


def foundation_parameters(previous, actual, ami):
    need(previous.keys() == actual.keys(), "foundation parameter coverage mismatch")
    for key, old in previous.items():
        value = actual[key]
        expected = ami if key == "HostAmiId" else old.get("ParameterValue")
        need(value.get("ParameterValue", old.get("ParameterValue") if value.get("UsePreviousValue") else None) == expected and
             value.get("ResolvedValue") == old.get("ResolvedValue"), "foundation extra parameter/resolved SSM change refused")


def foundation_changeset(cs_path, stack_path, wanted_path):
    _, previous = foundation_stack(stack_path)
    wanted = mapping(read(wanted_path))
    need(wanted.keys() == previous.keys(), "foundation parameter coverage mismatch")
    ami = wanted["HostAmiId"]["ParameterValue"]
    for key in previous.keys() - {"HostAmiId"}:
        need(wanted[key] == {"ParameterKey": key, "UsePreviousValue": True}, "foundation extra parameter change requested")
    cs = read(cs_path)
    check_changeset(cs)
    foundation_parameters(previous, mapping(cs.get("Parameters") or []), ami)
    need(len(cs["Changes"]) == 1, "unexpected foundation resource change")
    change = cs["Changes"][0]
    r = change["ResourceChange"]
    need(change.get("Type") == "Resource" and r.get("Action") == "Modify" and
         r.get("LogicalResourceId") == "ComputerLaunchTemplate" and r.get("ResourceType") == "AWS::EC2::LaunchTemplate" and
         r.get("PhysicalResourceId") == LAUNCH_TEMPLATE, "unexpected foundation resource change")
    need(r.get("Replacement") == "False" and r.get("Scope") == ["Properties"] and r.get("Details"),
         "foundation replacement/unexplained change refused")
    explained = any(d.get("ChangeSource") == "ParameterReference" and d.get("CausingEntity") == "HostAmiId" for d in r["Details"])
    for detail in r["Details"]:
        target = detail["Target"]
        parameter = detail.get("ChangeSource") == "ParameterReference" and detail.get("CausingEntity") == "HostAmiId"
        dynamic = detail.get("ChangeSource") == "DirectModification" and detail.get("Evaluation") == "Dynamic" and not detail.get("CausingEntity") and explained
        need(target.get("Attribute") == "Properties" and target.get("Name") == "LaunchTemplateData" and
             target.get("RequiresRecreation") == "Never" and (parameter or dynamic) and
             target.get("Path") in (None, "/Properties/LaunchTemplateData", "/Properties/LaunchTemplateData/ImageId"),
             "unexpected foundation property change")
    # With property values present, an ImageId update must explain the entire context.
    if r.get("BeforeContext") is not None or r.get("AfterContext") is not None:
        before, after = json.loads(r["BeforeContext"]), json.loads(r["AfterContext"])
        expected = copy.deepcopy(before)
        need(expected["Properties"]["LaunchTemplateData"]["ImageId"] == previous["HostAmiId"]["ParameterValue"],
             "foundation change-set ImageId differs from HostAmiId")
        expected["Properties"]["LaunchTemplateData"]["ImageId"] = ami
        need(same_json(expected, after), "foundation change-set values are not only the AMI change")


def foundation_readback(before_path, after_path, resource_path, old_version_path, new_version_path, config_path):
    _, previous = foundation_stack(before_path)
    _, actual = foundation_stack(after_path)
    foundation_resource(resource_path)
    deployment = pair(read(config_path))
    foundation_parameters(previous, actual, deployment["amiId"])
    old = launch_template(old_version_path)
    new = check_launch_template(config_path, new_version_path)
    need(new["VersionNumber"] == old["VersionNumber"] + 1, "launch-template latest version differs from prediction")
    expected = {**old["LaunchTemplateData"], "ImageId": deployment["amiId"]}
    need(same_json(expected, new["LaunchTemplateData"]), "launch-template read-back changed data outside ImageId")


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


def previous_bindings():
    return [
        {"Name": "PreviousDesktopImageRef", "Value": [{"Fn::If": ["HasPreviousDesktopImage",
            {"Fn::Sub": ["${RepositoryUri}@${Digest}", {"RepositoryUri": {"Ref": "ApplicationImageRepositoryUri"},
                "Digest": {"Ref": "PreviousDesktopImageDigest"}}]}, ""]}]},
        {"Name": "PreviousDesktopImageId", "Value": [{"Ref": "PreviousDesktopImageId"}]},
    ]


def normalize_previous_template(value):
    value = copy.deepcopy(value)
    parameters = value.get("Parameters", {})
    present = PREVIOUS & parameters.keys()
    if not present:
        return value
    need(present == PREVIOUS, "partial previous parameter definitions")
    for key in PREVIOUS:
        need(parameters.pop(key) == {"Type": "String", "Default": "", "AllowedPattern": "^(sha256:[0-9a-f]{64})?$"},
             "unexpected template parameter definition")
    condition = {"Fn::Not": [{"Fn::Equals": [{"Ref": "PreviousDesktopImageDigest"}, ""]}]}
    rule = {"Assertions": [
        {"Assert": {"Fn::Or": [
            {"Fn::And": [{"Fn::Equals": [{"Ref": "PreviousDesktopImageDigest"}, ""]},
                         {"Fn::Equals": [{"Ref": "PreviousDesktopImageId"}, ""]}]},
            {"Fn::And": [{"Fn::Not": [{"Fn::Equals": [{"Ref": "PreviousDesktopImageDigest"}, ""]}]},
                         {"Fn::Not": [{"Fn::Equals": [{"Ref": "PreviousDesktopImageId"}, ""]}]}]}]},
         "AssertDescription": "Previous desktop digest and ID must be supplied together"},
        {"Assert": {"Fn::Or": [{"Fn::Equals": [{"Ref": "PreviousDesktopImageId"}, ""]},
            {"Fn::Not": [{"Fn::Equals": [{"Ref": "PreviousDesktopImageId"}, {"Ref": "DesktopImageId"}]}]}]},
         "AssertDescription": "Previous and current lower IDs must differ"}]}
    for section, key, expected in (("Conditions", "HasPreviousDesktopImage", condition), ("Rules", "PreviousDesktopImagePair", rule)):
        need(value.get(section, {}).pop(key, None) == expected, "unexpected previous parameter rule/condition")
        if not value[section]:
            value.pop(section)
    return value


def normalize_components(value):
    result = copy.deepcopy(value)
    need(isinstance(result, list) and len(result) == 1, "expected one recipe component")
    params = result[0].get("Parameters", [])
    if any(p.get("Name", "").startswith("PreviousDesktop") for p in params):
        need(params[-2:] == previous_bindings(), "unexpected previous component bindings")
        result[0]["Parameters"] = params[:-2]
    return result


def ami_template(old_path, candidate_path, before_path, after_path):
    """Prove the synthesized template contains only the authorized version update.

    In particular, an allowed Image Builder type does not grant permission to
    change its subnet, role, KMS key, parent AMI or any other build settings.
    """
    previous_version, next_version = version_pair(before_path, after_path)
    previous, candidate = template(old_path), read(candidate_path)
    normalized_old, normalized_new = normalize_previous_template(previous), normalize_previous_template(candidate)
    need(not (PREVIOUS & previous.get("Parameters", {}).keys()) or PREVIOUS <= candidate.get("Parameters", {}).keys(), "previous parameter removal refused")
    need({k: v for k, v in normalized_old.items() if k != "Resources"} ==
         {k: v for k, v in normalized_new.items() if k != "Resources"}, "unexpected template parameter/output/metadata change")
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
        delta = {key for key in a if ascii_view(a[key]) != ascii_view(b[key])}
        if kind in (types["Component"], types["ImageRecipe"]):
            need(a.get("Version") == previous_version, "live recipe/component version differs from local config")
            need(b.get("Version") == next_version, "synthesized recipe/component version mismatch")
            permitted = {"Version", "Data"} if kind == types["Component"] else {"Version", "Components"}
            if "Components" in delta:
                need(normalize_components(a["Components"]) == normalize_components(b["Components"]) and
                     PREVIOUS <= candidate.get("Parameters", {}).keys(), "unexpected recipe component change")
                need(b["Components"][0]["Parameters"][-2:] == previous_bindings(), "previous component binding removal refused")
            need(delta <= permitted, "unexpected component/recipe property change")
        elif delta:
            # Today's CDK source does not put the version into these resources.
            # Accept only a literal version substitution if a reviewed source
            # does so; no unrelated distribution/infrastructure changes.
            need(replace_version(a, previous_version, next_version) == b,
                 "configuration change is not forced by the version string: " + logical)
        changes[logical] = delta
    return old, changes


def ascii_view(value):
    """CloudFormation stores the live template with non-ASCII characters as '?'
    (e.g. a description's '…'), so compare synthesized values the same way."""
    if isinstance(value, str):
        return value.encode("ascii", "replace").decode("ascii")
    if isinstance(value, list):
        return [ascii_view(v) for v in value]
    if isinstance(value, dict):
        return {k: ascii_view(v) for k, v in value.items()}
    return value


def versioned_ami_changes(cs, resources, template_changes, reviewed_base_change=False):
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
        dependencies = {"ImageRecipeArn": recipe}
        for kind, prop in (("InfrastructureConfiguration", "InfrastructureConfigurationArn"), ("DistributionConfiguration", "DistributionConfigurationArn")):
            dependency = by_type.get("AWS::ImageBuilder::" + kind)
            if dependency and template_changes.get(dependency):
                dependencies[prop] = dependency

        def referenced(name, source, cause):
            if reviewed_base_change and logical == recipe and name == "ParentImage":
                # Live CloudFormation (2026-10-23) reports a re-resolved SSM parent as
                # Static/DirectModification with no causing entity. ami_template() already
                # refuses any template-level ParentImage change, so this only admits the
                # validated, reviewed base re-resolution.
                return (source == "ParameterReference" and cause == "UbuntuAmiId") or (source == "DirectModification" and cause == "")
            if logical == recipe and name == "Components":
                return (source == "ParameterReference" and cause in ALLOWED) or (source in ("ResourceReference", "ResourceAttribute") and cause == component)
            if logical == pipeline:
                return name in dependencies and source in ("ResourceReference", "ResourceAttribute") and cause == dependencies[name]
            return False

        explained = {d["Target"]["Name"] for d in r["Details"]
                     if referenced(d["Target"]["Name"], d["ChangeSource"], d.get("CausingEntity", "").split(".")[0])}
        for detail in r["Details"]:
            target = detail["Target"]
            need(target["Attribute"] == "Properties", "non-property resource change")
            name, source = target["Name"], detail["ChangeSource"]
            cause = detail.get("CausingEntity", "").split(".")[0]
            targets.add(name)
            expected = name in direct and source == "DirectModification"
            expected |= referenced(name, source, cause)
            # CloudFormation also lists a value-only "DirectModification / Dynamic" entry
            # for a property whose change comes from a reference; accept it only when that
            # same property is already explained by an allowed reference in this change.
            expected |= source == "DirectModification" and detail.get("Evaluation") == "Dynamic" and name in explained
            # A maintenance bake clears PreviousDesktopImage*: live CloudFormation (2026-10-27) reports the
            # emptied Components value as Static/DirectModification with no cause and no ParameterReference.
            # Accept exactly that: an empty after-value on a property already explained by an allowed reference.
            expected |= (logical == recipe and name == "Components" and source == "DirectModification"
                         and detail.get("Evaluation") == "Static" and cause == "" and not target.get("AfterValue")
                         and name in explained)
            need(expected, "unexpected versioned Image Builder property change")
        need(direct <= targets, "change set omits synthesized property changes")
        if logical in (component, recipe):
            need(r.get("Replacement") == "True" and "Version" in targets, "version bump must replace component and recipe")
        elif not direct:
            need(r.get("Replacement") == "False", "unexpected dependent resource replacement")
    need({component, recipe} <= seen, "change set omits component/recipe version replacement")


def base_image_review(old_id, new_id, images_path):
    need(all(isinstance(i, str) and re.fullmatch(r"ami-[0-9a-f]{17}", i) for i in (old_id, new_id)),
         "invalid reviewed base AMI identity")
    response = read(images_path)
    images = response["Images"]
    need(not response.get("NextToken") and len(images) == 2 and
         {i.get("ImageId") for i in images} == {old_id, new_id}, "reviewed base image response mismatch")
    previous = next(i for i in images if i["ImageId"] == old_id)
    candidate = next(i for i in images if i["ImageId"] == new_id)
    need(candidate.get("OwnerId") == "099720109477", "reviewed base image owner is not Canonical")
    need(re.fullmatch(r"ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24\.04-amd64-server-[0-9]{8}(\.[0-9]+)?",
                      candidate.get("Name", "")), "reviewed base image name mismatch")
    need(candidate.get("State") == "available", "reviewed base image is not available")
    need(candidate.get("Architecture") == "x86_64", "reviewed base image architecture mismatch")

    def creation_date(image):
        value = image.get("CreationDate", "")
        need(isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z", value),
             "invalid base image creation date")
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    need(creation_date(candidate) > creation_date(previous), "reviewed base image is not newer")
    return {"oldId": old_id, "newId": new_id, "name": candidate["Name"], "creationDate": candidate["CreationDate"]}


def ami_changeset(old_path, wanted_path, cs_path, template_path, *version_paths,
                  reviewed_base_ami=None, base_images_path=None):
    old = mapping(stack(old_path)["Parameters"])
    wanted = mapping(read(wanted_path))
    cs = read(cs_path)
    check_changeset(cs)
    actual = mapping(cs["Parameters"])
    additions = wanted.keys() - old.keys()
    need(old.keys() <= wanted.keys() == actual.keys() and additions <= PREVIOUS, "parameter coverage mismatch")
    need(not additions or version_paths and PREVIOUS <= read(version_paths[0]).get("Parameters", {}).keys(), "new parameters require reviewed template")
    review = None
    for key in wanted:
        if key in ALLOWED:
            need(actual[key].get("ParameterValue") == wanted[key]["ParameterValue"], "unexpected allowed parameter value")
        else:
            need(wanted[key] == {"ParameterKey": key, "UsePreviousValue": True}, "extra parameter change requested")
            need(actual[key].get("ParameterValue", old[key].get("ParameterValue") if actual[key].get("UsePreviousValue") else None) == old[key].get("ParameterValue"), "extra parameter change in change set")
        if actual[key].get("ResolvedValue") != old.get(key, {}).get("ResolvedValue"):
            need(key == "UbuntuAmiId" and reviewed_base_ami, "resolved SSM parameter changed")
            need(reviewed_base_ami == actual[key].get("ResolvedValue"), "reviewed base AMI does not match resolved value")
            review = base_image_review(old[key].get("ResolvedValue"), reviewed_base_ami, base_images_path)
    if version_paths:
        resources, changes = ami_template(template_path, *version_paths)
        versioned_ami_changes(cs, resources, changes, reviewed_base_change=review is not None)
        return review
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
    return review


def same_json(a, b):
    """JSON equality must not equate booleans and numbers as Python does."""
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def promotion_literal(value):
    """Resolve only local Join/Sub strings; never query CFN or evaluate arbitrary refs."""
    if isinstance(value, str):
        return value
    if not isinstance(value, dict):
        return None
    if set(value) == {"Fn::Join"}:
        delimiter, parts = value["Fn::Join"]
        strings = [promotion_literal(v) for v in parts]
        return delimiter.join(strings) if all(isinstance(v, str) for v in strings) else None
    if set(value) == {"Fn::Sub"}:
        sub = value["Fn::Sub"]
        text, variables = (sub, {}) if isinstance(sub, str) else sub
        variables = {"AWS::Partition": "aws", "AWS::Region": REGION, "AWS::AccountId": ACCOUNT, **variables}
        tokens = re.findall(r"\$\{([^}]+)\}", text)
        resolved = {k: promotion_literal(variables.get(k)) for k in tokens}
        if all(isinstance(v, str) for v in resolved.values()):
            return re.sub(r"\$\{([^}]+)\}", lambda m: resolved[m[1]], text)
    return None


def promotion_substitution(value, old_pair, new_pair, version_ids=None):
    """Replace complete identifiers recursively; qualify numeric version arguments.

    A launch-template version changes only in serialized deployment settings.
    A bare workflow number changes only inside a Join/Sub resolving to its ARN.
    IAM condition values and unrelated numbers stay fixed.
    Logical ID substitutions come only from the independently checked Version pair.
    """
    if isinstance(value, str):
        try:
            settings = json.loads(value)
        except (ValueError, TypeError):
            settings = None
        if isinstance(settings, dict) and isinstance(settings.get("deployment"), dict) and all(
                settings["deployment"].get(k) == v for k, v in old_pair.items()):
            expected = copy.deepcopy(settings)
            for key in release.PROMOTION:
                if key not in new_pair:
                    expected["deployment"].pop(key, None)
            expected["deployment"].update(new_pair)
            match = re.search(r'"deployment"\s*:\s*', value)
            if match:
                _, length = json.JSONDecoder().raw_decode(value[match.end():])
                original = value[match.end():match.end() + length]
                separators = (", ", ": ") if '": ' in original else (",", ":")
                adjusted = value[:match.end()] + json.dumps(expected["deployment"], separators=separators) + value[match.end() + length:]
                if same_json(json.loads(adjusted), expected):
                    value = adjusted
        replacements = {old_pair[key]: new_pair[key] for key in ("amiId", "stateMachineVersionArn", "preparationStateMachineVersionArn", "recoveryStateMachineVersionArn") if key in old_pair and key in new_pair}
        pattern = r"(?<![A-Za-z0-9_])(?:" + "|".join(re.escape(k) for k in replacements) + r")(?![A-Za-z0-9_])"
        return re.sub(pattern, lambda match: replacements[match[0]], value)
    if isinstance(value, list):
        return [promotion_substitution(v, old_pair, new_pair, version_ids) for v in value]
    if not isinstance(value, dict):
        return value
    result = {k: promotion_substitution(v, old_pair, new_pair, version_ids) for k, v in value.items()}
    version_ids = version_ids or {}
    # A paired Version's logical ID may change only as a CFN reference, never
    # as a matching literal (for example an IAM Sid or an environment value).
    if set(value) == {"Ref"} and value["Ref"] in version_ids:
        result["Ref"] = version_ids[value["Ref"]]
    if set(value) == {"Fn::GetAtt"}:
        getatt = value["Fn::GetAtt"]
        logical = getatt[0] if isinstance(getatt, list) else getatt.split(".")[0]
        if logical in version_ids:
            result["Fn::GetAtt"] = ([version_ids[logical], getatt[1]] if isinstance(getatt, list)
                                    else version_ids[logical] + getatt[len(logical):])
    if set(value) == {"Fn::Sub"}:
        sub = result["Fn::Sub"]
        text, variables = (sub, {}) if isinstance(sub, str) else sub

        def reference(match):
            token = match[1]
            logical = token.split(".")[0]
            if token not in variables and logical in version_ids:
                return "${" + version_ids[logical] + token[len(logical):] + "}"
            return match[0]

        text = re.sub(r"\$\{([^}]+)\}", reference, text)
        if isinstance(sub, str):
            result["Fn::Sub"] = text
        else:
            result["Fn::Sub"][0] = text
    old_arn, new_arn = old_pair["stateMachineVersionArn"], new_pair["stateMachineVersionArn"]
    if promotion_literal(value) == old_arn and promotion_literal(result) != new_arn:
        # Only the terminal version component can change, and the fully resolved
        # expression must then equal the new ARN. Never replace every matching digit.
        previous, target = old_arn.rsplit(":", 1)[1], new_arn.rsplit(":", 1)[1]
        adjusted = copy.deepcopy(result)
        if "Fn::Join" in value:
            tail = value["Fn::Join"][1][-1]
            if isinstance(tail, str) and tail.endswith(previous):
                adjusted["Fn::Join"][1][-1] = tail[:-len(previous)] + target
        elif "Fn::Sub" in value:
            sub = value["Fn::Sub"]
            text, variables = (sub, {}) if isinstance(sub, str) else sub
            placeholder = re.search(r"\$\{([^}]+)\}$", text)
            if placeholder and isinstance(variables.get(placeholder[1]), str) and variables[placeholder[1]].endswith(previous):
                adjusted["Fn::Sub"][1][placeholder[1]] = variables[placeholder[1]][:-len(previous)] + target
            elif text.endswith(previous):
                text = text[:-len(previous)] + target
                if isinstance(sub, str):
                    adjusted["Fn::Sub"] = text
                else:
                    adjusted["Fn::Sub"][0] = text
        if promotion_literal(adjusted) == new_arn:
            result = adjusted
    return result


def lifecycle_version_pair(old, new, old_pair, new_pair):
    removed, added = old.keys() - new.keys(), new.keys() - old.keys()
    if not removed and not added:
        return {}
    need(len(removed) == len(added), "lifecycle resource addition/removal refused: unmatched Lambda Version pairs")
    result = {}
    for previous in sorted(removed):
        resource = old[previous]
        need(resource["Type"] == "AWS::Lambda::Version", "lifecycle resource addition/removal refused: only Lambda Version pairs")
        matches = [key for key in added if new[key]["Type"] == "AWS::Lambda::Version" and
                   new[key].get("Properties", {}).get("FunctionName") == resource.get("Properties", {}).get("FunctionName")]
        need(len(matches) == 1, "lifecycle resource addition/removal refused: expected one Lambda Version for the same function")
        target = matches[0]
        need(target not in result.values(), "duplicate Lambda Version target")
        a, b = old[previous], new[target]
        need(a["Type"] == b["Type"] == "AWS::Lambda::Version",
             "lifecycle resource addition/removal refused: only a Lambda Version pair is permitted")
        function = a.get("Properties", {}).get("FunctionName")
        need(function == b.get("Properties", {}).get("FunctionName") and isinstance(function, dict) and
             set(function) == {"Ref"}, "Lambda Version pair must reference the same function")
        logical = function["Ref"]
        need(logical in old and logical in new and
             old[logical]["Type"] == new[logical]["Type"] == "AWS::Lambda::Function",
             "Lambda Version pair must reference the same existing function")
        old_props, new_props = old[logical].get("Properties", {}), new[logical].get("Properties", {})
        need(not same_json(old_props.get("Environment"), new_props.get("Environment")) and
             same_json(promotion_substitution(old_props.get("Environment"), old_pair, new_pair), new_props.get("Environment")) and
             same_json({k: v for k, v in old_props.items() if k != "Environment"},
                       {k: v for k, v in new_props.items() if k != "Environment"}),
             "Lambda Version pair is not forced by the substituted function environment")
        # The pinned CDK derives the currentVersion logical ID hash from Environment.
        # Its Version properties (including any explicit CodeSha256/Description) are
        # unchanged; never treat those fields as an unchecked escape hatch.
        need(same_json(promotion_substitution(a, old_pair, new_pair), b),
             "Lambda Version pair properties/attributes are not forced by AMI/version pair")
        result[previous] = target
    return result


def lifecycle_template(live_path, baseline_path, candidate_path, before_path, after_path, rollback="false"):
    """Derive exact changes from substitution, with independently proven environment-forced Version pairs."""
    before, after = read(before_path), read(after_path)
    old_pair, new_pair = pair(before), pair(after)
    expected = copy.deepcopy(before)
    for key in release.PROMOTION:
        if key not in new_pair:
            expected["settings"]["deployment"].pop(key, None)
    expected["settings"]["deployment"].update(new_pair)
    need(same_json(expected, after), "unexpected lifecycle config change outside AMI/version pair")
    live, baseline, candidate = template(live_path), read(baseline_path), read(candidate_path)
    # A failed promotion can leave the stack at the rollback target already.
    if rollback == "true" and same_json(ascii_view(live), ascii_view(candidate)):
        return live, candidate, {}
    need(same_json(ascii_view(live), ascii_view(baseline)), "live lifecycle template differs from baseline synth; reconcile drift separately")
    need(same_json({k: v for k, v in baseline.items() if k != "Resources"},
                   {k: v for k, v in candidate.items() if k != "Resources"}), "unexpected lifecycle template parameter/output/metadata change")
    old, new = baseline["Resources"], candidate["Resources"]
    version_ids = lifecycle_version_pair(old, new, old_pair, new_pair)
    changes = {}
    for previous, target in version_ids.items():
        changes[previous] = {"action": "Remove", "properties": set(), "attributes": set()}
        changes[target] = {"action": "Add", "properties": set(), "attributes": set()}
    for logical in sorted(old.keys() & new.keys()):
        resource, proposed = old[logical], new[logical]
        if same_json(resource, proposed):
            continue
        need(resource["Type"] == proposed["Type"], "lifecycle resource change refused: resource type changed: " + logical)
        need(resource.keys() == proposed.keys(), "lifecycle resource change refused: resource attribute addition/removal: " + logical)
        a, b = resource.get("Properties", {}), proposed.get("Properties", {})
        need(a.keys() == b.keys(), "lifecycle resource change refused: lifecycle property addition/removal: " + logical)
        delta = {key for key in a if not same_json(a[key], b[key])}
        attributes = {key for key in resource if key != "Properties" and not same_json(resource[key], proposed[key])}
        for key in delta:
            need(same_json(promotion_substitution(a[key], old_pair, new_pair, version_ids), b[key]),
                 "unexpected lifecycle property change; lifecycle change is not forced by AMI/version pair: " + logical + "." + key)
        for key in attributes:
            forced = promotion_substitution(resource[key], old_pair, new_pair, version_ids)
            if key == "DependsOn":
                forced = ([version_ids.get(v, v) for v in resource[key]] if isinstance(resource[key], list)
                          else version_ids.get(resource[key], resource[key]))
            need(same_json(forced, proposed[key]),
                 "unexpected lifecycle resource attributes: " + logical + "." + key)
        changes[logical] = {"action": "Modify", "properties": delta, "attributes": attributes}
    return live, candidate, changes


def version_references(value, source, entity):
    """Find actual CloudFormation references, not arbitrary matching string values."""
    if isinstance(value, list):
        return any(version_references(v, source, entity) for v in value)
    if not isinstance(value, dict):
        return False
    if source == "ResourceReference" and value.get("Ref") == entity:
        return True
    getatt = value.get("Fn::GetAtt")
    if source == "ResourceAttribute" and isinstance(getatt, list) and ".".join(getatt) == entity:
        return True
    if source == "ResourceAttribute" and isinstance(getatt, str) and getatt == entity:
        return True
    sub = value.get("Fn::Sub")
    if sub is not None:
        text, variables = (sub, {}) if isinstance(sub, str) else sub
        if any(token not in variables and token == entity and
               source == ("ResourceAttribute" if "." in token else "ResourceReference")
               for token in re.findall(r"\$\{([^}]+)\}", text)):
            return True
    return any(version_references(v, source, entity) for v in value.values())


KNOWN_AFTER_APPLY = "{{changeSet:KNOWN_AFTER_APPLY}}"
TRUNCATED = "(Truncated-Signature):"


def context_match(expected, actual):
    """Equal, except that CloudFormation's KNOWN_AFTER_APPLY placeholder matches any value."""
    if actual == KNOWN_AFTER_APPLY:
        return True
    if isinstance(expected, dict) and isinstance(actual, dict):
        return expected.keys() == actual.keys() and all(context_match(expected[k], actual[k]) for k in expected)
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(context_match(e, x) for e, x in zip(expected, actual))
    if isinstance(expected, str) and isinstance(actual, str) and KNOWN_AFTER_APPLY in actual:
        parts = actual.split(KNOWN_AFTER_APPLY)
        return re.fullmatch(".*".join(re.escape(p) for p in parts), expected, re.S) is not None
    return expected == actual


def version_context_match(expected, actual):
    """Check Version context literals; physical reference values are resolved by CFN."""
    if isinstance(expected, dict) and len(expected) == 1 and next(iter(expected)).startswith(("Ref", "Fn::")) and isinstance(actual, str):
        literal = promotion_literal(expected)
        return literal is None or context_match(literal, actual)
    if isinstance(expected, dict) and isinstance(actual, dict):
        return expected.keys() == actual.keys() and all(version_context_match(expected[k], actual[k]) for k in expected)
    if isinstance(expected, list) and isinstance(actual, list):
        return len(expected) == len(actual) and all(version_context_match(e, a) for e, a in zip(expected, actual))
    return context_match(expected, actual)


def lifecycle_changeset(cs_path, stack_path, *template_paths):
    live, candidate, allowed = lifecycle_template(*template_paths)
    cs = read(cs_path)
    check_changeset(cs)
    # DescribeChangeSet does not return RoleARN; the role is passed at creation and the
    # stack's own RoleARN is verified separately (lifecycle-parameters).
    need(cs.get("RoleARN") in (ROLE, None), "lifecycle change set must use its execution role")
    previous = mapping(stack(stack_path).get("Parameters") or [])
    actual = mapping(cs.get("Parameters") or [])
    need(previous.keys() == actual.keys(), "lifecycle parameter coverage mismatch")
    for key, old in previous.items():
        value = actual[key]
        need(value.get("ParameterValue", old.get("ParameterValue") if value.get("UsePreviousValue") else None) == old.get("ParameterValue") and
             value.get("ResolvedValue") == old.get("ResolvedValue"), "lifecycle parameter/resolved SSM change refused")
    version_ids = {logical for logical, change in allowed.items() if change["action"] in ("Add", "Remove")}
    context_old_pair, context_new_pair = pair(read(template_paths[3])), pair(read(template_paths[4]))
    context_version_ids = lifecycle_version_pair(live["Resources"], candidate["Resources"], context_old_pair, context_new_pair)
    seen = set()
    for change in cs["Changes"]:
        need(change.get("Type") == "Resource", "unexpected lifecycle non-resource change")
        r = change["ResourceChange"]
        logical = r["LogicalResourceId"]
        need(logical in allowed and logical not in seen and r["Action"] == allowed[logical]["action"], "unexpected lifecycle resource change")
        seen.add(logical)
        expected = allowed[logical]
        resource = (live if r["Action"] == "Remove" else candidate)["Resources"][logical]
        need(r["ResourceType"] == resource["Type"], "lifecycle resource type mismatch")
        if r["Action"] in ("Add", "Remove"):
            need(r.get("Replacement") in (None, "False") and not r.get("Scope") and not r.get("Details"),
                 "unexplained Lambda Version pair change")
            context = r.get("AfterContext" if r["Action"] == "Add" else "BeforeContext")
            if context is not None:
                context = json.loads(context) if isinstance(context, str) else context
                need(version_context_match(resource.get("Properties", {}), context.get("Properties", {})),
                     "Lambda Version change-set values differ from the validated template")
        else:
            need(r.get("Replacement") == "False", "lifecycle resource replacement refused")
            scope = expected["attributes"] | ({"Properties"} if expected["properties"] else set())
            need(set(r.get("Scope", [])) == scope and r.get("Details"), "unexplained lifecycle resource change")
            targets, attributes = set(), set()

            def detail_kind(detail):
                target = detail["Target"]
                attribute, name = target.get("Attribute"), target.get("Name")
                direct = (detail.get("ChangeSource") == "DirectModification" and
                          detail.get("Evaluation", "Static") == "Static" and not detail.get("CausingEntity"))
                entity = detail.get("CausingEntity") or ""
                cause = entity.split(".")[0]
                dependency = (attribute == "Properties" and cause in version_ids and
                    detail.get("ChangeSource") in ("ResourceReference", "ResourceAttribute") and
                    detail.get("Evaluation") in ("Static", "Dynamic") and any(
                        version_references(t["Resources"].get(logical, {}).get("Properties", {}).get(name),
                                           detail["ChangeSource"], entity)
                        for t in (live, candidate)))
                return direct, dependency

            explained = {d["Target"].get("Name") for d in r["Details"] if any(detail_kind(d))}
            for detail in r["Details"]:
                target = detail["Target"]
                attribute, name = target.get("Attribute"), target.get("Name")
                direct = (detail.get("ChangeSource") == "DirectModification" and
                          detail.get("Evaluation", "Static") == "Static" and not detail.get("CausingEntity"))
                # CloudFormation adds a value-only DirectModification/Dynamic entry next to a
                # reference-caused change; accept it only for an already explained property.
                direct = direct or (detail.get("ChangeSource") == "DirectModification" and
                                    detail.get("Evaluation") == "Dynamic" and not detail.get("CausingEntity") and
                                    name in explained)
                # CFN can also describe the validated Version reference as a
                # dynamic dependency. Only a reference present in this exact
                # changed property may explain it; no blanket dynamic allowance.
                entity = detail.get("CausingEntity") or ""
                cause = entity.split(".")[0]
                dependency = (attribute == "Properties" and cause in version_ids and
                    detail.get("ChangeSource") in ("ResourceReference", "ResourceAttribute") and
                    detail.get("Evaluation") in ("Static", "Dynamic") and any(
                        version_references(t["Resources"].get(logical, {}).get("Properties", {}).get(name),
                                           detail["ChangeSource"], entity)
                        for t in (live, candidate)))
                property_change = attribute == "Properties" and name in expected["properties"]
                attribute_change = attribute in expected["attributes"] and not name
                need((property_change or attribute_change) and target.get("RequiresRecreation") == "Never" and
                     (direct or dependency), "unexpected lifecycle property change")
                if property_change:
                    targets.add(name)
                else:
                    attributes.add(attribute)
            need(targets == expected["properties"] and attributes == expected["attributes"],
                 "change set omits synthesized lifecycle property changes")
        # Before/AfterContext carry RESOLVED values (physical names, stringified numbers,
        # KNOWN_AFTER_APPLY placeholders), so they cannot equal template intrinsics. For a
        # modified resource, After must equal Before with only the AMI/version substitution;
        # a KNOWN_AFTER_APPLY placeholder stands for a value CloudFormation resolves later.
        # The Version Add/Remove pair is verified at template level above.
        if r["Action"] == "Modify" and "BeforeContext" in r and "AfterContext" in r:
            before_ctx = json.loads(r["BeforeContext"]) if isinstance(r["BeforeContext"], str) else r["BeforeContext"]
            after_ctx = json.loads(r["AfterContext"]) if isinstance(r["AfterContext"], str) else r["AfterContext"]
            need(isinstance(before_ctx, dict) and isinstance(after_ctx, dict), "unreadable lifecycle change-set context")
            before_props = dict(before_ctx.get("Properties") or {})
            after_props = dict(after_ctx.get("Properties") or {})
            # Large values arrive as "(Truncated-Signature):<hash>" and cannot be compared here.
            # Accept that only for a property the template-level substitution check already
            # allows to change (expected["properties"] for this resource).
            for key in list(before_props):
                if (str(before_props[key]).startswith(TRUNCATED) and str(after_props.get(key, "")).startswith(TRUNCATED)):
                    need(key in allowed.get(logical, {}).get("properties", set()) or before_props[key] == after_props.get(key),
                         "truncated change-set value for a property the template does not change")
                    before_props.pop(key); after_props.pop(key, None)
            expected_after = promotion_substitution(before_props, context_old_pair, context_new_pair, context_version_ids)
            need(context_match(ascii_view(expected_after), ascii_view(after_props)),
                 "lifecycle change-set values are not the AMI/version substitution of the live values; values differ")
        print(r["Action"], logical, r["ResourceType"], r.get("Replacement", ""))
    need(seen == allowed.keys(), "change set omits synthesized lifecycle resource changes")


def secret_aws(args, payload=None, lock_fd=None):
    # AWS CLI v2 does not read --cli-input-json file:///dev/stdin from a pipe ("Invalid
    # JSON received"), so the payload goes through a private 0600 file, removed at once.
    tmpdir = path = None
    if payload is not None and "file:///dev/stdin" in args:
        tmpdir = tempfile.mkdtemp(prefix="ezil-secret.")
        path = os.path.join(tmpdir, "request.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(payload)
        args = ["file://" + path if a == "file:///dev/stdin" else a for a in args]
        payload = None
    command = ["aws", "--profile", "ezil-admin", "--region", REGION, "--no-cli-pager", "secretsmanager", *args]
    try:
        result = subprocess.run(command, input=payload, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=90,
                                pass_fds=() if lock_fd is None else (lock_fd,))
    finally:
        if path:
            os.unlink(path)
            os.rmdir(tmpdir)
    # Do not relay AWS stderr: a validation error can contain request material.
    need(result.returncode == 0, "Secrets Manager command failed (details suppressed)")
    return json.loads(result.stdout)


def edit_secret(envelope, before, after):
    outer = release.loads(envelope["SecretString"])
    need(isinstance(outer, dict), "app secret must be an object")
    raw = outer[KEY]
    deployments = release.loads(raw) if isinstance(raw, str) else copy.deepcopy(raw)
    need(isinstance(deployments, dict) and isinstance(deployments.get(REGION), dict), "regional deployments missing")
    d = deployments[REGION]
    release.deployment_tuple(d)
    keys = set(before) | set(after) | set(release.TUPLE)
    current = {k: d[k] for k in keys if k in d}
    need(current in (before, after), "secret deployment drift; refusing overwrite")
    for key in keys:
        d.pop(key, None)
    d.update(after)
    outer[KEY] = json.dumps(deployments, separators=(",", ":")) if isinstance(raw, str) else deployments
    return outer


def edit_release_secret(envelope, before, after, records):
    """CAS the complete tuple and append immutable records; capacity fails closed.

    Retaining ALL records satisfies placement/job retention without racing the DB.
    A separately reviewed garbage collector is required when nineteen slots are full.
    """
    updated = edit_secret(envelope, before, after)
    raw = updated[KEY]
    deployments = release.loads(raw) if isinstance(raw, str) else copy.deepcopy(raw)
    d = deployments[REGION]
    retained = d.get("releases", [])
    need(isinstance(retained, list) and len(retained) <= 19, "invalid release registry")
    for record in retained:
        release.validate(record, source=True, repository=REPOSITORY)
        need(all(record[k] == d[k] for k in ("accountId", "region", "namespace", "launchTemplateId")), "foreign registry record")
    identity = lambda r: (r["lowerImageDigest"], r["amiId"])
    need(len({identity(r) for r in retained}) == len(retained), "duplicate release pair")
    for record in records:
        release.validate(record, source=True, repository=REPOSITORY)
        need(all(record[k] == d[k] for k in ("accountId", "region", "namespace", "launchTemplateId")), "foreign release record")
        need(all(identity(r) != identity(record) or r == record for r in retained), "immutable release pair rewrite refused")
        if record not in retained:
            retained.append(copy.deepcopy(record))
    need(1 <= len(retained) <= 19, "release registry full; retained placement/job evidence must never be dropped")
    retained.sort(key=lambda r: r["createdAt"])
    targets = [r for r in retained if all(r[k] == after.get(k) for k in release.PROMOTION)]
    # Legacy rollback remains a source-only deployment, never a rebase target.
    if set(release.TUPLE) <= after.keys():
        need(len(targets) == 1, "target release is not unique")
        release.validate(targets[0], repository=REPOSITORY)
    d["releases"] = retained
    readback = {"gitSha": "0" * 40, "killSwitch": "1", "deployment": rebase_app.public_deployment(d)}
    need(len(json.dumps(readback, separators=(",", ":")).encode("utf-8")) <= 24000,
         'release registry readback exceeds SSM 24000-byte limit')
    updated[KEY] = json.dumps(deployments, separators=(",", ":")) if isinstance(raw, str) else deployments
    return updated


@contextmanager
def app_secret_lock():
    # flock(2), shared with with-app-secret-lock.sh and every external writer.
    os.makedirs(os.path.dirname(APP_SECRET_LOCK), mode=0o700, exist_ok=True)
    fd = os.open(APP_SECRET_LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield fd
    finally:
        os.close(fd)


def secret_update(before_path, after_path, apply):
    with app_secret_lock() as fd:
        _secret_update(before_path, after_path, apply, fd)


def _secret_update(before_path, after_path, apply, lock_fd):
    def aws(args, payload=None):
        return secret_aws(args, payload, lock_fd=lock_fd)

    before, after = pair(read(before_path)), pair(read(after_path))
    envelope = aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"])
    outer = release.loads(envelope["SecretString"])
    deployments = release.loads(outer[KEY]) if isinstance(outer[KEY], str) else outer[KEY]
    if "releases" in deployments[REGION]:
        records = read(after_path)["settings"]["deployment"].get("releases", [])
        updated = edit_release_secret(envelope, before, after, records)
    else:
        updated = edit_secret(envelope, before, after)
    if apply:
        request = {"SecretId": SECRET, "SecretString": json.dumps(updated, separators=(",", ":"))}
        payload = json.dumps(request)
        check = aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"])
        need(check["VersionId"] == envelope["VersionId"], "secret changed during promotion; rerun after review")
        written = aws(["put-secret-value", "--cli-input-json", "file:///dev/stdin", "--output", "json"], payload)
        verify = aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"])
        need(verify["VersionId"] == written["VersionId"] and json.loads(verify["SecretString"]) == updated, "secret verification failed")
    print("App deployment fields verified" if not apply else "App deployment fields updated and verified")


def main(args):
    op, *a = args
    if op == "parameters":
        current = stack(a[0])
        old = mapping(current["Parameters"])
        need(BASE_ALLOWED <= old.keys(), "required AMI parameters missing")
        need(old["AssetBucketName"]["ParameterValue"] == "ezil-mum-deploy-assets-452630323510", "asset bucket mismatch")
        need(old["ApplicationImageRepositoryUri"]["ParameterValue"] == f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6", "ECR repository mismatch")
        values = dict(zip(("DesktopImageDigest", "DesktopImageId", "AgentSrcS3Uri"), a[1:4]))
        if len(a) > 5:
            need(len(a) == 7, "previous parameters require both values")
            previous_ref, previous_id = a[5:7]
            need(bool(previous_ref) == bool(previous_id), "previous reference/ID must be paired")
            previous_digest = ""
            if previous_ref:
                _, previous_digest = release.image_ref(previous_ref, ACCOUNT, REGION, REPOSITORY)
                need(release.matches(release.DIGEST, previous_id) and previous_id != a[2], "invalid/equal previous lower ID")
            values.update(PreviousDesktopImageDigest=previous_digest, PreviousDesktopImageId=previous_id)
        elif PREVIOUS & old.keys():
            # Omission explicitly removes N-1; never inherit a previous build's pair.
            values.update(PreviousDesktopImageDigest="", PreviousDesktopImageId="")
        keys = list(old) + sorted(values.keys() - old.keys())
        write(a[4], [{"ParameterKey": key, **({"ParameterValue": values[key]} if key in values else {"UsePreviousValue": True})} for key in keys])
    elif op == "previous-parameters":
        need(PREVIOUS <= mapping(stack(a[0])["Parameters"]).keys(), "previous pair requires a recipe version bump")
    elif op in ("previous-release", "secret-predecessor", "secret-retained"):
        manifest = release.load(a[0], source=True, repository=REPOSITORY)
        need(manifest["accountId"] == ACCOUNT and manifest["region"] == REGION and manifest["namespace"] == "mum", "previous release identity mismatch")
        if op == "previous-release":
            need((manifest["lowerImageRef"], manifest["lowerImageDigest"]) == tuple(a[1:3]), "previous release lower mismatch")
        else:
            with app_secret_lock() as fd:
                envelope = secret_aws(["get-secret-value", "--secret-id", SECRET, "--output", "json"], lock_fd=fd)
                outer = release.loads(envelope["SecretString"])
                deployments = release.loads(outer[KEY]) if isinstance(outer[KEY], str) else outer[KEY]
                d = deployments[REGION]
                if op == "secret-retained":
                    release.retained_release(d, manifest)
                else:
                    release.promoted_release(d, manifest)
    elif op in ("maintenance-agent", "maintenance-lower"):
        manifest = release.load(a[0], source=True, repository=REPOSITORY)
        if op == "maintenance-agent":
            need(release.matches(r"[0-9a-f]{40}", a[1]) and a[1] != manifest["agentCommit"], "maintenance bake requires a new reviewed agent commit")
        else:
            need(a[1] == manifest["lowerImageDigest"], "maintenance bake must preserve the promoted lower ID")
    elif op == "bake-inputs":
        params = mapping(read(a[0]))
        def value(key):
            return params.get(key, {}).get("ParameterValue", "")
        version = a[2]
        if not version:
            recipes = [r["Properties"]["Version"] for r in template(a[3])["Resources"].values() if r["Type"] == "AWS::ImageBuilder::ImageRecipe"]
            need(len(recipes) == 1, "recipe version evidence missing")
            version = recipes[0]
        recipe_version(version)
        write(a[4], {"schemaVersion": 1, "accountId": ACCOUNT, "region": REGION, "namespace": "mum",
            "recipeVersion": version, "lowerImageDigest": value("DesktopImageId"),
            "lowerImageRef": REPOSITORY + "@" + value("DesktopImageDigest"),
            "previousLowerImageDigest": value("PreviousDesktopImageId") or None,
            "previousLowerImageRef": REPOSITORY + "@" + value("PreviousDesktopImageDigest") if value("PreviousDesktopImageDigest") else None,
            "agentCommit": a[1]})
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
        parser = argparse.ArgumentParser(prog="json-tool.py ami-changeset")
        parser.add_argument("paths", nargs="+")
        parser.add_argument("--reviewed-base-ami")
        parser.add_argument("--base-images")
        parser.add_argument("--base-review-output")
        options = parser.parse_args(a)
        review = ami_changeset(*options.paths, reviewed_base_ami=options.reviewed_base_ami,
                               base_images_path=options.base_images)
        if review is not None:
            write(options.base_review_output, review)
    elif op == "base-ami-id":
        base_id = mapping(stack(a[0])["Parameters"])["UbuntuAmiId"].get("ResolvedValue", "")
        need(re.fullmatch(r"ami-[0-9a-f]{17}", base_id), "invalid live base AMI ID")
        print(base_id)
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
        # CDK appends a hash to output keys (e.g. LifecycleWorkflowVersionArn1FFCF530):
        # match the exact key or <name><8 hex>, and still require exactly one.
        outputs = [o["OutputValue"] for o in stack(a[0]).get("Outputs") or []
                   if o["OutputKey"] == a[1] or re.fullmatch(r"(?:\w*)" + re.escape(a[1]) + r"[0-9A-F]{8}", o["OutputKey"])]
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
        need(not (set(release.TUPLE) & previous.keys()), "rebase deployment requires manifest promotion")
        published = versions(a[1])
        need(previous["stateMachineVersionArn"] in published, "configured lifecycle version is not published")
        need(previous["amiId"] != a[2], "AMI already configured")
        version = max(int(v.rsplit(":", 1)[1]) for v in published) + 1
        config["settings"]["deployment"].update(amiId=a[2], stateMachineVersionArn=f"{MACHINE}:{version}", launchTemplateVersion=a[3])
        pair(config)
        write(a[4], config)
        print(json.dumps({"previous": previous, "target": pair(config)}, indent=2))
    elif op == "pair":
        p = pair(read(a[0])); print(p["amiId"], p["stateMachineVersionArn"], p["launchTemplateVersion"])
    elif op == "launch-template-version":
        check_launch_template(*a)
    elif op == "foundation-check":
        foundation_stack(a[0])
        foundation_resource(a[1])
    elif op == "foundation-plan":
        _, previous = foundation_stack(a[0])
        latest = launch_template(a[1])
        need(latest["LaunchTemplateData"].get("ImageId") == previous["HostAmiId"]["ParameterValue"],
             "foundation HostAmiId differs from latest launch-template AMI")
        need(previous["HostAmiId"]["ParameterValue"] != a[2], "foundation AMI already configured; reconcile previous promotion before retrying")
        write(a[3], [{"ParameterKey": key, **({"ParameterValue": a[2]} if key == "HostAmiId" else {"UsePreviousValue": True})} for key in previous])
        print(latest["VersionNumber"] + 1)
    elif op == "foundation-changeset":
        foundation_changeset(*a)
    elif op == "foundation-unchanged":
        before, _ = foundation_stack(a[0])
        after, _ = foundation_stack(a[1])
        need(all(same_json(before.get(k), after.get(k)) for k in ("StackId", "LastUpdatedTime", "Parameters")) and
             same_json(launch_template(a[2]), launch_template(a[3])), "foundation changed since planning; refuse execution")
    elif op == "foundation-readback":
        foundation_readback(*a)
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
        lifecycle_changeset(*a)
    elif op == "carry-cdk-metadata":
        live = template(a[0])
        carried = {k: v for k, v in live.get("Resources", {}).items() if v.get("Type") == "AWS::CDK::Metadata"}
        for path in a[1:3]:
            value = read(path)
            for k, v in carried.items():
                existing = value["Resources"].get(k)
                need(existing is None or same_json(existing, v), "synthesized CDK metadata conflicts with the live stack")
                need(not v.get("Condition") or v["Condition"] in value.get("Conditions", {}), "live CDK metadata condition missing from synth")
                value["Resources"][k] = copy.deepcopy(v)
            write(path, value)
    elif op == "lifecycle-template":
        lifecycle_template(*a)
    elif op == "lifecycle-equal":
        need(ascii_view(template(a[0])) == ascii_view(read(a[1])), "submitted lifecycle template mismatch")
    elif op == "lifecycle-parameters":
        current = stack(a[0])
        need(current.get("RoleARN") == ROLE, "lifecycle stack must use its execution role")
        write(a[1], [{"ParameterKey": key, "UsePreviousValue": True} for key in mapping(current.get("Parameters") or [])])
    elif op == "lifecycle-noop":
        cs = read(a[0])
        reason = cs.get("StatusReason", "")
        # CloudFormation omits RoleARN on a FAILED (empty) change set.
        need(not cs.get("NextToken") and cs.get("RoleARN") in (ROLE, None) and
             cs.get("Status") == "FAILED" and cs.get("ExecutionStatus") == "UNAVAILABLE" and not cs.get("Changes") and
             ("didn't contain changes" in reason or "No updates are to be performed" in reason), "failed change set is not a verified no-op")
        print("Rollback stack already matches the previous configuration; restoring app deployment fields")
    elif op in ("secret-check", "secret-update"):
        secret_update(*a, apply=op == "secret-update")
    elif op == "with-app-secret-lock":
        need(bool(a), "Usage: with-app-secret-lock.sh <cmd> [args...]")
        with app_secret_lock() as fd:
            # The parent retains the lock until the complete command has exited.
            # Inherit it too: killing the wrapper must not unlock a live writer.
            result = subprocess.run(a, check=False, pass_fds=(fd,)).returncode
            sys.exit(result if result >= 0 else 128 - result)
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
