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


def ami_changeset(old_path, wanted_path, cs_path, template_path):
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
        need(manifest.get("schemaVersion") == 2 and "manifests" not in manifest, "single-platform schema-2/OCI image required")
        digest, image_id = record["imageId"]["imageDigest"], manifest["config"]["digest"]
        need(all(re.fullmatch(r"sha256:[0-9a-f]{64}", d) for d in (digest, image_id)), "invalid ECR digest")
        need(image_id == a[1], "image ID mismatch between ECR and local Docker image")
        print(digest)
    elif op == "ami-changeset":
        ami_changeset(*a)
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
