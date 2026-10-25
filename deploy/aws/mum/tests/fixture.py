#!/usr/bin/env python3
import json
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
(root / "bin").mkdir()
# Run copied scripts with fixed lock paths redirected ONLY inside this fixture.
# Production exposes no lock override that could bypass cross-release exclusion.
source = Path(__file__).resolve().parents[1]
checkout = root / "checkout"
scripts = checkout / "deploy/aws/mum"
scripts.mkdir(parents=True)
for item in source.iterdir():
    if item.suffix in (".sh", ".py", ".json"):
        (scripts / item.name).write_text(item.read_text().replace("/root/ezil-aws-mum/locks", str(root / "locks")))
(checkout / "infra").mkdir()
(checkout / "infra/app-computers").symlink_to(source.parents[2] / "infra/app-computers", target_is_directory=True)
(checkout / "infra/host-agent").symlink_to(source.parents[2] / "infra/host-agent", target_is_directory=True)
for tool in ("aws", "docker", "git", "npm", "npx", "sleep", "timeout"):
    shutil.copyfile(Path(__file__).with_name("fake.py"), root / "bin" / tool)
    (root / "bin" / tool).chmod(0o755)


def save(name, value):
    (root / name).write_text(json.dumps(value))


shutil.copyfile(Path(__file__).parent / "fixtures/ami-previous-bindings.json", root / "ami-previous-bindings.json")
save("scenario.json", json.loads(sys.argv[2]))
save("calls.jsonl", [])
(root / "calls.jsonl").write_text("")
params = {
    "AssetBucketName": "ezil-mum-deploy-assets-452630323510",
    "ApplicationImageRepositoryUri": "452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6",
    "SubnetId": "subnet-example", "SecurityGroupId": "sg-example", "UbuntuAmiId": "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
    "AgentSrcS3Uri": "s3://example/old.tgz", "DesktopImageDigest": "sha256:" + "0" * 64,
    "DesktopImageId": "sha256:" + "1" * 64, "CloudflaredVersion": "2026.10.2",
    "CloudflaredSha256": "0" * 64, "EnrollUrl": "https://os-staging.ezil.work/api/compute/aws/enroll",
    "FutureParameter": "must-remain",  # proves coverage is discovered, not hard-coded
}
save("stack.json", {"Stacks": [{"StackStatus": "UPDATE_COMPLETE", **({} if json.loads(sys.argv[2]).get("no_stack_role") else {"RoleARN": "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec"}), "Parameters": [
    {"ParameterKey": k, "ParameterValue": v, **({"ResolvedValue": "ami-" + "1" * 17} if k == "UbuntuAmiId" else {})} for k, v in params.items()
], "Outputs": [{"OutputKey": "PipelineArn", "OutputValue": "arn:aws:imagebuilder:ap-south-1:452630323510:image-pipeline/ezil-host-mum"}]}]})
if json.loads(sys.argv[2]).get("other_ssm"):
    value = json.loads((root / "stack.json").read_text())
    next(p for p in value["Stacks"][0]["Parameters"] if p["ParameterKey"] == json.loads(sys.argv[2])["other_ssm"])["ResolvedValue"] = "ami-" + "1" * 17
    save("stack.json", value)
save("ami-config.json", {"namespace": "mum", "accountId": "452630323510", "region": "ap-south-1", "version": "1.0.1"})
shutil.copyfile(root / "ami-config.json", root / "original-ami-config.json")
save("template.json", {"TemplateBody": {"Parameters": {k: {"Type": "String"} for k in params}, "Resources": {
    "Component": {"Type": "AWS::ImageBuilder::Component", "Properties": {"Name": "ezil-host-mum", "Version": "1.0.1", "Data": "synthetic component (config digest sha256:?)"}},
    "Recipe": {"Type": "AWS::ImageBuilder::ImageRecipe", "Properties": {"Name": "ezil-host-mum", "Version": "1.0.1", "Components": [{"ComponentArn": {"Ref": "Component"}, "Parameters": []}]}},
    "Pipeline": {"Type": "AWS::ImageBuilder::ImagePipeline", "Properties": {"ImageRecipeArn": {"Ref": "Recipe"}}},
    "Infrastructure": {"Type": "AWS::ImageBuilder::InfrastructureConfiguration", "Properties": {"Name": "ezil-host-mum", "SubnetId": {"Ref": "SubnetId"}}},
    "Distribution": {"Type": "AWS::ImageBuilder::DistributionConfiguration", "Properties": {"Name": "ezil-host-mum"}},
    "BuildRole": {"Type": "AWS::IAM::Role", "Properties": {"RoleName": "ezil-mum-ami-build"}},
}}})
if json.loads(sys.argv[2]).get("forced_config_version"):
    value = json.loads((root / "template.json").read_text())
    for logical in ("Infrastructure", "Distribution"):
        value["TemplateBody"]["Resources"][logical]["Properties"]["Name"] += "-1.0.1"
    save("template.json", value)
d = {"accountId": "452630323510", "region": "ap-south-1", "namespace": "mum", "amiId": "ami-" + "1" * 17,
     "launchTemplateId": "lt-06f691fc1e4dfe3cc", "launchTemplateVersion": "3",
     "stateMachineVersionArn": "arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle:4", "keep": [1, 2]}
save("foundation-stack.json", {"Stacks": [{"StackStatus": "UPDATE_COMPLETE",
    "RoleARN": "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec", "Parameters": [
        {"ParameterKey": "HostAmiId", "ParameterValue": d["amiId"]},
        {"ParameterKey": "FutureParameter", "ParameterValue": "must-remain"},
        {"ParameterKey": "Parent", "ParameterValue": "/aws/example", "ResolvedValue": "fixed"}]}]})
save("launch-template-versions.json", [{"LaunchTemplateId": d["launchTemplateId"], "VersionNumber": n,
    "LaunchTemplateData": {"ImageId": d["amiId"], "MetadataOptions": {"HttpTokens": "required"}, "InstanceType": "t3a.large"}}
    for n in (3, 7)])  # The configured version need not be the latest.
shutil.copyfile(root / "launch-template-versions.json", root / "original-launch-template-versions.json")
save("config.json", {"settings": {"deployment": d}, "preserve": {"nested": True}})
save("original-config.json", {"settings": {"deployment": d}, "preserve": {"nested": True}})
save("live-lifecycle-config.json", {"settings": {"deployment": d}, "preserve": {"nested": True}})
deployments = {"ap-south-1": d, "us-east-1": {"amiId": "other-region", "untouched": [3, 4]}}
if json.loads(sys.argv[2]).get("secret_drift"):
    d["amiId"] = "ami-" + "9" * 17
if json.loads(sys.argv[2]).get("secret_template_drift"):
    d["launchTemplateVersion"] = "99"
raw = deployments if json.loads(sys.argv[2]).get("object_secret") else json.dumps(deployments)
secret = {"keepSynthetic": "synthetic-private-do-not-print", "unicode": "£☺\\\n", "EZIL_AWS_LIFECYCLE_DEPLOYMENTS": raw}
save("secret.json", {"VersionId": "initial", "SecretString": json.dumps(secret)})
save("original-secret.json", secret)
