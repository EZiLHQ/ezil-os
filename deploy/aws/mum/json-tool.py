#!/usr/bin/env python3
"""Strict JSON transforms for the M5 scripts. Secret payloads stay in memory."""
import copy
from contextlib import contextmanager
import fcntl
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
APP_SECRET_LOCK = "/root/ezil-aws-mum/locks/app-secret.lock"


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
        delta = {key for key in a if ascii_view(a[key]) != ascii_view(b[key])}
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
        dependencies = {"ImageRecipeArn": recipe}
        for kind, prop in (("InfrastructureConfiguration", "InfrastructureConfigurationArn"), ("DistributionConfiguration", "DistributionConfigurationArn")):
            dependency = by_type.get("AWS::ImageBuilder::" + kind)
            if dependency and template_changes.get(dependency):
                dependencies[prop] = dependency

        def referenced(name, source, cause):
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

    A bare number is a version only inside a Join/Sub resolving to the configured
    workflow version ARN. IAM condition values and unrelated numbers stay fixed.
    Logical ID substitutions come only from the independently checked Version pair.
    """
    if isinstance(value, str):
        replacements = {old_pair[key]: new_pair[key] for key in old_pair}
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
    need(len(removed) == len(added) == 1,
         "lifecycle resource addition/removal refused: expected one Lambda Version pair")
    previous, target = next(iter(removed)), next(iter(added))
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
    return {previous: target}


def lifecycle_template(live_path, baseline_path, candidate_path, before_path, after_path, rollback="false"):
    """Derive exact changes from substitution, with one environment-forced Version pair."""
    before, after = read(before_path), read(after_path)
    old_pair, new_pair = pair(before), pair(after)
    expected = copy.deepcopy(before)
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


def lifecycle_changeset(cs_path, stack_path, *template_paths):
    live, candidate, allowed = lifecycle_template(*template_paths)
    cs = read(cs_path)
    check_changeset(cs)
    need(cs.get("RoleARN") == ROLE, "lifecycle change set must use its execution role")
    previous = mapping(stack(stack_path).get("Parameters", []))
    actual = mapping(cs.get("Parameters", []))
    need(previous.keys() == actual.keys(), "lifecycle parameter coverage mismatch")
    for key, old in previous.items():
        value = actual[key]
        need(value.get("ParameterValue", old.get("ParameterValue") if value.get("UsePreviousValue") else None) == old.get("ParameterValue") and
             value.get("ResolvedValue") == old.get("ResolvedValue"), "lifecycle parameter/resolved SSM change refused")
    version_ids = {logical for logical, change in allowed.items() if change["action"] in ("Add", "Remove")}
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
        else:
            need(r.get("Replacement") == "False", "lifecycle resource replacement refused")
            scope = expected["attributes"] | ({"Properties"} if expected["properties"] else set())
            need(set(r.get("Scope", [])) == scope and r.get("Details"), "unexplained lifecycle resource change")
            targets, attributes = set(), set()
            for detail in r["Details"]:
                target = detail["Target"]
                attribute, name = target.get("Attribute"), target.get("Name")
                direct = (detail.get("ChangeSource") == "DirectModification" and
                          detail.get("Evaluation", "Static") == "Static" and not detail.get("CausingEntity"))
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
        for context, expected_template in (("BeforeContext", live), ("AfterContext", candidate)):
            if context in r:
                body = json.loads(r[context]) if isinstance(r[context], str) else r[context]
                expected_resource = expected_template["Resources"].get(logical)
                if expected_resource is None:
                    need(not body, "unexpected context for absent Lambda Version")
                else:
                    need(isinstance(body, dict) and same_json(ascii_view(body.get("Properties")), ascii_view(expected_resource.get("Properties", {}))),
                         "lifecycle change-set values differ from synthesized template")
        print(r["Action"], logical, r["ResourceType"], r.get("Replacement", ""))
    need(seen == allowed.keys(), "change set omits synthesized lifecycle resource changes")


def secret_aws(args, payload=None, lock_fd=None):
    command = ["aws", "--profile", "ezil-admin", "--region", REGION, "--no-cli-pager", "secretsmanager", *args]
    result = subprocess.run(command, input=payload, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=90,
                            pass_fds=() if lock_fd is None else (lock_fd,))
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
        write(a[1], [{"ParameterKey": key, "UsePreviousValue": True} for key in mapping(current.get("Parameters", []))])
    elif op == "lifecycle-noop":
        cs = read(a[0])
        reason = cs.get("StatusReason", "")
        need(not cs.get("NextToken") and cs.get("RoleARN") == ROLE and
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
