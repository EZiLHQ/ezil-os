"""Offline checks for app-host.yaml and db-access.yaml per environment (no AWS calls).

A small resolver evaluates Ref, FindInMap, Sub, If, Equals, Not and Or with the
parameters given, so the staging and production stacks can be compared as
CloudFormation would see them, and the Rules can be exercised.
"""
from pathlib import Path
import re
import unittest

import yaml

HERE = Path(__file__).parent
PSEUDO = {"AWS::Partition": "aws", "AWS::Region": "ap-south-1", "AWS::AccountId": "452630323510"}
NO_VALUE = object()
PROD_VPC, PROD_SUBNET = "vpc-040bdd6e09e35425f", "subnet-0e7c19ed848d0fcea"
PROD_BUCKET, PROD_DB_SG = "ezil-main-prod-artifacts-452630323510-aps1", "sg-0f3151c94e0ed4ee6"
# The prd lifecycle's caller: roleName ezil-prd-app-caller under the /ezil/prd/ workload path.
PRD_CALLER = "arn:aws:iam::452630323510:role/ezil/prd/ezil-prd-app-caller"
MUM_CALLER = "arn:aws:iam::452630323510:role/ezil/mum/ezil-mum-lifecycle-AppCallerRoleEA1CB1F0-example"


class Loader(yaml.SafeLoader):
    pass


def _tag(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
        if suffix == "GetAtt":
            value = value.split(".", 1)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {"Ref" if suffix == "Ref" else f"Fn::{suffix}": value}


Loader.add_multi_constructor("!", _tag)


def load(name):
    return yaml.load((HERE / name).read_text(), Loader=Loader)


class Resolver:
    def __init__(self, template, parameters):
        self.template = template
        self.parameters = {name: spec.get("Default") for name, spec in template["Parameters"].items()}
        self.parameters.update(parameters)
        missing = [name for name, value in self.parameters.items() if value is None]
        if missing:
            raise ValueError(f"No value for {missing}")

    def ref(self, name):
        if name == "AWS::NoValue":
            return NO_VALUE
        if name in PSEUDO:
            return PSEUDO[name]
        if name in self.parameters:
            return self.parameters[name]
        return {"Ref": name}  # A resource: stays symbolic.

    def sub(self, text, variables):
        def replace(match):
            name = match.group(1)
            if name in variables:
                return variables[name]
            value = self.ref(name) if "." not in name else None
            return value if isinstance(value, str) else match.group(0)
        return re.sub(r"\$\{([^}!]+)\}", replace, text)

    def condition(self, name):
        return self.resolve(self.template["Conditions"][name])

    def resolve(self, node):
        if isinstance(node, list):
            return [item for item in (self.resolve(item) for item in node) if item is not NO_VALUE]
        if not isinstance(node, dict):
            return node
        if len(node) == 1:
            (key, value), = node.items()
            if key == "Ref":
                return self.ref(value)
            if key == "Fn::FindInMap":
                mapping, first, second = (self.resolve(item) for item in value)
                return self.template["Mappings"][mapping][first][second]
            if key == "Fn::Sub":
                text, variables = (value, {}) if isinstance(value, str) else value
                return self.sub(text, {k: self.resolve(v) for k, v in variables.items()})
            if key == "Fn::Equals":
                left, right = (self.resolve(item) for item in value)
                return left == right
            if key == "Fn::Not":
                return not self.resolve(value[0])
            if key == "Fn::Or":
                return any(self.resolve(item) is True for item in value)
            if key == "Fn::If":
                name, yes, no = value
                return self.resolve(yes if self.condition(name) else no)
        return {key: item for key, item in ((k, self.resolve(v)) for k, v in node.items()) if item is not NO_VALUE}

    def resources(self):
        return self.resolve(self.template["Resources"])

    def failed_rules(self):
        failed = []
        for rule in self.template.get("Rules", {}).values():
            if self.resolve(rule.get("RuleCondition", True)):
                failed += [a["AssertDescription"] for a in rule["Assertions"] if not self.resolve(a["Assert"])]
        return failed


def tags(resource):
    return {tag["Key"]: tag["Value"] for tag in resource["Properties"]["Tags"]}


PRODUCTION_HOST = {"Environment": "production", "VpcId": PROD_VPC, "SubnetId": PROD_SUBNET,
                   "ArtifactBucket": PROD_BUCKET, "AppCallerRoleArn": ""}
STAGING_HOST = {"ArtifactBucket": "ezil-preview-artifacts-example"}


class AppHostTemplateTests(unittest.TestCase):
    def setUp(self):
        self.template = load("app-host.yaml")

    def test_staging_resolves_to_the_original_literals(self):
        resolver = Resolver(self.template, STAGING_HOST)
        self.assertEqual(resolver.parameters["Environment"], "staging")
        resources = resolver.resources()
        self.assertEqual(resources["AppSecurityGroup"]["Properties"]["GroupDescription"], "OS billing staging HTTP and HTTPS")
        for name in ("AppSecurityGroup", "InstanceRole", "PublicIp"):
            self.assertEqual(resources[name]["Properties"]["Tags"],
                             [{"Key": "ezil:env", "Value": "billing-staging"}, {"Key": "ezil:purpose", "Value": "os-staging"}])
        self.assertEqual(resources["AppInstance"]["Properties"]["Tags"],
                         [{"Key": "Name", "Value": "ezil-os-billing-staging-host"},
                          {"Key": "ezil:env", "Value": "billing-staging"}, {"Key": "ezil:purpose", "Value": "os-staging"}])
        policy, = resources["InstanceRole"]["Properties"]["Policies"]
        self.assertEqual(policy["PolicyName"], "BillingStagingRuntime")
        self.assertEqual([s["Resource"] for s in policy["PolicyDocument"]["Statement"]], [
            "arn:aws:s3:::ezil-preview-artifacts-example/os-staging/images/*",
            "arn:aws:secretsmanager:ap-south-1:452630323510:secret:ezil-os/billing-staging/app-*"])
        # UserData is byte-identical to the checked-in staging bootstrap (no instance update).
        self.assertEqual(resources["AppInstance"]["Properties"]["UserData"]["Fn::Base64"],
                         (HERE / "bootstrap-host.sh").read_text())
        self.assertEqual(resolver.failed_rules(), [])

    def test_production_resolves_to_production_names(self):
        resolver = Resolver(self.template, PRODUCTION_HOST)
        resources = resolver.resources()
        self.assertEqual(tags(resources["AppInstance"]),
                         {"Name": "ezil-os-prod-host", "ezil:env": "production", "ezil:purpose": "os"})
        for name in ("AppSecurityGroup", "InstanceRole", "PublicIp"):
            self.assertEqual(tags(resources[name]), {"ezil:env": "production", "ezil:purpose": "os"})
        policy, = resources["InstanceRole"]["Properties"]["Policies"]
        self.assertEqual(policy["PolicyName"], "OsProductionRuntime")
        self.assertEqual([s["Resource"] for s in policy["PolicyDocument"]["Statement"]], [
            f"arn:aws:s3:::{PROD_BUCKET}/os/images/*",
            "arn:aws:secretsmanager:ap-south-1:452630323510:secret:ezil-os/production/app-*"])
        user_data = resources["AppInstance"]["Properties"]["UserData"]["Fn::Base64"]
        self.assertEqual(user_data, (HERE / "bootstrap-host.sh").read_text().replace(
            "/var/lib/ezil-os-staging", "/var/lib/ezil-os-production"))
        # Nothing but the shared bootstrap comments mentions staging.
        code = [line for line in user_data.splitlines() if not line.lstrip().startswith("#")]
        resources["AppInstance"]["Properties"]["UserData"] = "\n".join(code)
        self.assertNotIn("staging", repr(resources).lower())
        self.assertEqual(resolver.failed_rules(), [])

    def test_rules_keep_environments_apart(self):
        cases = {
            "Production uses the prod VPC": {**PRODUCTION_HOST, "VpcId": "vpc-0f6bc19fdfd4209aa"},
            "Production uses the prod subnet": {**PRODUCTION_HOST, "SubnetId": "subnet-0dd4cf8f7d3d92e20"},
            "Production uses ezil-main-prod-artifacts": {**PRODUCTION_HOST, "ArtifactBucket": "ezil-preview-artifacts-example"},
            "Production passes '' or exactly the prd app caller": {**PRODUCTION_HOST, "AppCallerRoleArn": "arn:aws:iam::452630323510:role/caller"},
            "Production passes '' or exactly the prd app caller (mum)": {**PRODUCTION_HOST, "AppCallerRoleArn": MUM_CALLER},
            "Production passes '' or exactly the prd app caller (suffix)": {**PRODUCTION_HOST, "AppCallerRoleArn": PRD_CALLER + "x"},
            "Production passes '' or exactly the prd app caller (path)": {**PRODUCTION_HOST,
                "AppCallerRoleArn": "arn:aws:iam::452630323510:role/ezil-prd-app-caller"},
            "Staging never uses the production app caller": {**STAGING_HOST, "AppCallerRoleArn": PRD_CALLER},
            "Staging never uses the prod VPC": {**STAGING_HOST, "VpcId": PROD_VPC},
            "Staging never uses the prod subnet": {**STAGING_HOST, "SubnetId": PROD_SUBNET},
            "Staging never uses a production bucket": {**STAGING_HOST, "ArtifactBucket": PROD_BUCKET},
        }
        for message, parameters in cases.items():
            with self.subTest(message):
                failed = Resolver(self.template, parameters).failed_rules()
                self.assertEqual(len(failed), 1, failed)
                self.assertIn(message.split(" (")[0], failed[0])
        # Positive controls: each environment's own values pass.
        self.assertEqual(Resolver(self.template, PRODUCTION_HOST).failed_rules(), [])
        self.assertEqual(Resolver(self.template, {**PRODUCTION_HOST, "AppCallerRoleArn": PRD_CALLER}).failed_rules(), [])
        self.assertEqual(Resolver(self.template, {**STAGING_HOST,
                         "AppCallerRoleArn": "arn:aws:iam::452630323510:role/caller"}).failed_rules(), [])

    def test_production_with_the_prd_caller_changes_only_the_role_policy(self):
        without = Resolver(self.template, PRODUCTION_HOST).resources()
        with_caller = Resolver(self.template, {**PRODUCTION_HOST, "AppCallerRoleArn": PRD_CALLER}).resources()
        policy, = with_caller["InstanceRole"]["Properties"]["Policies"]
        self.assertEqual(policy["PolicyDocument"]["Statement"][-1],
                         {"Effect": "Allow", "Action": "sts:AssumeRole", "Resource": PRD_CALLER})
        policy["PolicyDocument"]["Statement"].pop()
        self.assertEqual(with_caller, without)
        self.assertTrue(re.fullmatch(self.template["Parameters"]["AppCallerRoleArn"]["AllowedPattern"], PRD_CALLER))

    def test_bucket_pattern_admits_only_the_production_artifacts_bucket(self):
        pattern = self.template["Parameters"]["ArtifactBucket"]["AllowedPattern"]
        for bucket in ("ezil-preview-artifacts-example", PROD_BUCKET):
            self.assertTrue(re.fullmatch(pattern, bucket), bucket)
        for bucket in ("ezil-main-prod-backups-452630323510-aps1", "ezil-main-prod-objects-452630323510-aps1",
                       PROD_BUCKET + "x", "ezil-main-prod-artifacts-452630323510-aps2"):
            self.assertIsNone(re.fullmatch(pattern, bucket), bucket)


class DbAccessTemplateTests(unittest.TestCase):
    def setUp(self):
        self.template = load("db-access.yaml")

    def test_descriptions_per_environment(self):
        staging = Resolver(self.template, {"DbSecurityGroupId": "sg-0aaaaaaaaaaaaaaaa", "AppSecurityGroupId": "sg-0bbbbbbbbbbbbbbbb"})
        self.assertEqual(staging.resources()["AppToPostgres"]["Properties"], {
            "GroupId": "sg-0aaaaaaaaaaaaaaaa", "SourceSecurityGroupId": "sg-0bbbbbbbbbbbbbbbb", "IpProtocol": "tcp",
            "FromPort": 5432, "ToPort": 5432, "Description": "OS billing staging to preview PostgreSQL proxy"})
        production = Resolver(self.template, {"Environment": "production", "DbSecurityGroupId": PROD_DB_SG,
                                              "AppSecurityGroupId": "sg-0bbbbbbbbbbbbbbbb"})
        self.assertEqual(production.resources()["AppToPostgres"]["Properties"]["Description"],
                         "OS production app to private PostgreSQL")
        self.assertEqual(staging.failed_rules(), [])
        self.assertEqual(production.failed_rules(), [])

    def test_rules_pin_the_production_db_security_group(self):
        wrong = Resolver(self.template, {"Environment": "production", "DbSecurityGroupId": "sg-0aaaaaaaaaaaaaaaa",
                                         "AppSecurityGroupId": "sg-0bbbbbbbbbbbbbbbb"}).failed_rules()
        self.assertEqual(len(wrong), 1)
        self.assertIn("sg-0f3151c94e0ed4ee6", wrong[0])
        staging = Resolver(self.template, {"DbSecurityGroupId": PROD_DB_SG,
                                           "AppSecurityGroupId": "sg-0bbbbbbbbbbbbbbbb"}).failed_rules()
        self.assertEqual(staging, ["Staging never opens the prod DB security group."])


if __name__ == "__main__":
    unittest.main()
