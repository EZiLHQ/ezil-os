#!/usr/bin/env python3
"""Namespace prd (production) operator profile: offline, no AWS.

- common.sh use_namespace and json-tool.py PROFILES name the same resources;
- `json-tool.py --namespace prd namespace-config` accepts the founder's P1-P7 inputs
  (PROD-COMPUTERS-PLAN) and refuses mum/staging values, a partial tuple, a foreign
  origin or enroll URL, and any other app caller;
- prd carries its committed foundation pins and refuses foreign ones; an emptied pin
  still refuses every pinned operation; prd requires immutable image-rebase evidence;
  secret errors stay redacted under --namespace.
"""
import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
sys.path.insert(0, str(TOOLS))
spec = importlib.util.spec_from_file_location("json_tool_prd", TOOLS / "json-tool.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)

A, R = "452630323510", "ap-south-1"
HOST = f"arn:aws:iam::{A}:role/ezil-os-prod-host-InstanceRole-uJIGAhHeIYOr"
SCOPE = {"namespace": "prd", "accountId": A, "region": R}
IDENTITY = {**SCOPE, "githubOidcProviderArn": f"arn:aws:iam::{A}:oidc-provider/token.actions.githubusercontent.com",
            "deploySubject": "repo:EZiLHQ@315435740/ezil-os@1339112799:environment:aws-prd",
            "assetBucketName": f"ezil-prd-deploy-assets-{A}", "killSwitch": False, "poolLifecycle": True, "maxVolumeGiB": 100,
            "appCallerRoleName": "ezil-prd-app-caller"}
OPS = {**SCOPE, "monthlyBudgetUsd": 70, "budgetEmails": ["ops@example.com"], "alertEmails": ["ops@example.com"],
       "egressBytesPer5Min": 3000000000, "quotaAlarmPercent": 80, "capacityAlarmVcpus": 40}
FOUNDATION = {"stage": "prd", "region": R, "zoneIds": ["aps1-az1"], "instanceType": "m6i.large", "rootDeviceName": "/dev/sda1", "rootVolumeGiB": 30}
AMI = {**SCOPE, "version": "1.0.0"}
SHA = "a" * 40
AMI_PARAMETERS = [{"ParameterKey": k, "ParameterValue": v} for k, v in {
    "AssetBucketName": f"ezil-prd-deploy-assets-{A}",
    "ApplicationImageRepositoryUri": f"{A}.dkr.ecr.{R}.amazonaws.com/ezil-prd-foundation-applicationimages439f25f1-xkgzfggtz2w4",
    "SubnetId": "subnet-0123456789abcdef0", "SecurityGroupId": "sg-0123456789abcdef0",
    "UbuntuAmiId": "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
    "AgentSrcS3Uri": f"s3://ezil-prd-deploy-assets-{A}/ami/host-agent-{SHA}.tgz",
    "DesktopImageDigest": "sha256:" + "1" * 64, "DesktopImageId": "sha256:" + "2" * 64,
    "CloudflaredVersion": "2026.10.2", "CloudflaredSha256": "3" * 64,
    "EnrollUrl": "https://os-prod.ezil.work/api/compute/aws/enroll",
    "PreviousDesktopImageDigest": "", "PreviousDesktopImageId": "",
}.items()]
LIFECYCLE = {
    "settings": {"deployment": {
        "accountId": A, "region": R, "zoneId": "aps1-az1", "subnetId": "subnet-0123456789abcdef0",
        "securityGroupId": "sg-0123456789abcdef0", "launchTemplateId": "lt-0b68cfb18ad22869a", "launchTemplateVersion": "2",
        "amiId": "ami-0123456789abcdef0", "namespace": "prd", "instanceTypes": ["m6i.large", "m6i.xlarge", "m6i.2xlarge"],
        "storage": {"rootDeviceName": "/dev/sda1", "rootGiB": 30, "dataMinGiB": 20, "dataMaxGiB": 100},
        "dataKeyArn": f"arn:aws:kms:{R}:{A}:key/00000000-0000-4000-8000-000000000000",
        "stateMachineVersionArn": f"arn:aws:states:{R}:{A}:stateMachine:ezil-prd-lifecycle:1"},
        "authorityOrigin": "https://os-prod.ezil.work",
        "authoritySecretArn": f"arn:aws:secretsmanager:{R}:{A}:secret:ezil/prd/lifecycle-authority-AbCdEf"},
    "authorityKeyArn": f"arn:aws:kms:{R}:{A}:key/00000000-0000-4000-8000-000000000001",
    "notificationsEnabled": True, "alertTopicArn": f"arn:aws:sns:{R}:{A}:ezil-prd-ops-alerts",
    "recoveryVersionArn": f"arn:aws:states:{R}:{A}:stateMachine:ezil-prd-recovery:1", "recoveryEnabled": True,
    "appCaller": {"enabled": True, "roleName": "ezil-prd-app-caller", "providers": [],
                  "ec2CallerRoleArns": [HOST], "ec2CallerEnv": "production"},
    "deploy": {"assetBucketName": f"ezil-prd-deploy-assets-{A}"}, "lambdaReservedConcurrency": 2,
}
GOOD = {"identity": IDENTITY, "keys": SCOPE, "ops": OPS, "foundation": FOUNDATION, "ami": AMI,
        "ami-parameters": AMI_PARAMETERS, "lifecycle": LIFECYCLE}


def edit(value, path, new):
    value = copy.deepcopy(value)
    *parents, last = path
    target = value
    for key in parents:
        target = target[key]
    if new is DELETE:
        del target[last]
    else:
        target[last] = new
    return value


DELETE = object()


def parameter(name, value):
    return [dict(p, ParameterValue=value) if p["ParameterKey"] == name else p for p in AMI_PARAMETERS]


REFUSED = {
    "identity": [
        ("mum's aws-pilot deploy environment", edit(IDENTITY, ["deploySubject"], IDENTITY["deploySubject"].replace("aws-prd", "aws-pilot"))),
        ("bare production environment", edit(IDENTITY, ["deploySubject"], IDENTITY["deploySubject"].replace("aws-prd", "production"))),
        ("cold-mode boundary (pool mode decided)", edit(IDENTITY, ["poolLifecycle"], False)),
        ("pool lifecycle omitted", edit(IDENTITY, ["poolLifecycle"], DELETE)),
        ("image-job boundary without a rebase tuple", edit(IDENTITY, ["imageJobDeployment"], {"namespace": "prd"})),
        ("mum asset bucket", edit(IDENTITY, ["assetBucketName"], f"ezil-mum-deploy-assets-{A}")),
        ("kill switch on at creation", edit(IDENTITY, ["killSwitch"], True)),
        ("app caller role name omitted (CloudFormation cannot check the named role)", edit(IDENTITY, ["appCallerRoleName"], DELETE)),
        ("another app caller role name", edit(IDENTITY, ["appCallerRoleName"], "ezil-prd-other-caller")),
        ("mum namespace", edit(IDENTITY, ["namespace"], "mum")),
    ],
    "keys": [("mum namespace", edit(SCOPE, ["namespace"], "mum")), ("extra field", edit(SCOPE, ["killSwitch"], False)),
             ("other region", edit(SCOPE, ["region"], "us-east-1"))],
    "ops": [("mum namespace", edit(OPS, ["namespace"], "mum")), ("other account", edit(OPS, ["accountId"], "123456789012"))],
    "foundation": [("mum stage", edit(FOUNDATION, ["stage"], "mum")), ("other region", edit(FOUNDATION, ["region"], "us-east-1"))],
    "ami": [("mum namespace", edit(AMI, ["namespace"], "mum")), ("extra field", edit(AMI, ["enrollUrl"], "x"))],
    "ami-parameters": [
        ("staging enroll URL", parameter("EnrollUrl", "https://os-staging.ezil.work/api/compute/aws/enroll")),
        ("pre-cutover Vercel origin", parameter("EnrollUrl", "https://os.ezil.work/api/compute/aws/enroll")),
        ("mum asset bucket", parameter("AssetBucketName", f"ezil-mum-deploy-assets-{A}")),
        ("agent archive in the mum bucket", parameter("AgentSrcS3Uri", f"s3://ezil-mum-deploy-assets-{A}/ami/host-agent-{SHA}.tgz")),
        ("mum ECR repository", parameter("ApplicationImageRepositoryUri", tool.PROFILES["mum"]["repository"])),
        ("previous image pair (rebase)", parameter("PreviousDesktopImageDigest", "sha256:" + "4" * 64)),
    ],
    "lifecycle": [
        ("staging authority origin", edit(LIFECYCLE, ["settings", "authorityOrigin"], "https://os-staging.ezil.work")),
        ("pre-cutover origin", edit(LIFECYCLE, ["settings", "authorityOrigin"], "https://os.ezil.work")),
        ("authority origin omitted", edit(LIFECYCLE, ["settings", "authorityOrigin"], DELETE)),
        ("partial rebase tuple", edit(LIFECYCLE, ["settings", "deployment"], {**LIFECYCLE["settings"]["deployment"],
            "lowerImageDigest": "sha256:" + "5" * 64, "previousLowerImageDigest": None,
            "recoveryStateMachineVersionArn": f"arn:aws:states:{R}:{A}:stateMachine:ezil-prd-recovery:1"})),
        ("partial release registry", edit(LIFECYCLE, ["settings", "deployment", "releases"], [{}])),
        ("mum workflow", edit(LIFECYCLE, ["settings", "deployment", "stateMachineVersionArn"], f"arn:aws:states:{R}:{A}:stateMachine:ezil-mum-lifecycle:1")),
        ("mum recovery", edit(LIFECYCLE, ["recoveryVersionArn"], f"arn:aws:states:{R}:{A}:stateMachine:ezil-mum-recovery:1")),
        ("mum namespace", edit(LIFECYCLE, ["settings", "deployment", "namespace"], "mum")),
        ("mum deploy bucket", edit(LIFECYCLE, ["deploy", "assetBucketName"], f"ezil-mum-deploy-assets-{A}")),
        ("an OIDC provider", edit(LIFECYCLE, ["appCaller", "providers"], [{"name": "github"}])),
        ("the staging host role", edit(LIFECYCLE, ["appCaller", "ec2CallerRoleArns"], [f"arn:aws:iam::{A}:role/ezil-os-billing-staging-host-InstanceRole-rNWO46WOExww"])),
        ("a second EC2 role", edit(LIFECYCLE, ["appCaller", "ec2CallerRoleArns"], [HOST, HOST + "2"])),
        ("the staging caller tag", edit(LIFECYCLE, ["appCaller", "ec2CallerEnv"], "billing-staging")),
        ("caller tag omitted (defaults to staging)", edit(LIFECYCLE, ["appCaller", "ec2CallerEnv"], DELETE)),
        ("generated role name (app-host.yaml pins the ARN)", edit(LIFECYCLE, ["appCaller", "roleName"], DELETE)),
        ("caller disabled", edit(LIFECYCLE, ["appCaller", "enabled"], False)),
    ],
}


def run(*args, tools=TOOLS):
    return subprocess.run([sys.executable, "-B", str(tools / "json-tool.py"), *args], capture_output=True, text=True, timeout=60)


def redirected_tools(folder):
    """A copy of the tooling whose lock paths point into `folder`, as fixture.py does:
    a test must never flock the host's real operator locks."""
    tools = Path(folder) / "tools"
    tools.mkdir()
    for item in TOOLS.iterdir():
        if item.suffix in (".py", ".sh", ".json"):
            (tools / item.name).write_text(item.read_text().replace("/root/ezil-aws-mum/locks", str(Path(folder) / "locks"))
                                           .replace("/root/ezil-aws-prd/locks", str(Path(folder) / "locks")))
    return tools


PRD_REPOSITORY = f"{A}.dkr.ecr.{R}.amazonaws.com/ezil-prd-foundation-applicationimages439f25f1-xkgzfggtz2w4"
PRD_LAUNCH_TEMPLATE = "lt-0b68cfb18ad22869a"


def unpinned_tools(folder):
    """A redirected copy of the tooling with prd's foundation pins emptied: the empty-pin refusal must survive the pin."""
    tools = redirected_tools(folder)
    for name, pins in (("json-tool.py", ((f'f"{{ACCOUNT}}.dkr.ecr.{{REGION}}.amazonaws.com/{PRD_REPOSITORY.split("/", 1)[1]}"', "None"),
                                         (f'"{PRD_LAUNCH_TEMPLATE}"', "None"))),
                       ("common.sh", ((f"repository={PRD_REPOSITORY}", "repository="),
                                      (f"launch_template={PRD_LAUNCH_TEMPLATE}", "launch_template=")))):
        text = (tools / name).read_text()
        for pinned, empty in pins:
            assert text.count(pinned) == 1, (name, pinned)
            text = text.replace(pinned, empty)
        (tools / name).write_text(text)
    return tools


class NamespaceConfigTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)

    def tearDown(self):
        self.folder.cleanup()

    def check(self, kind, value):
        path = self.root / f"{kind}.json"
        path.write_text(json.dumps(value))
        return run("--namespace", "prd", "namespace-config", kind, str(path))

    def test_founder_inputs_pass_with_the_committed_pins(self):
        for kind, value in GOOD.items():
            with self.subTest(kind):
                result = self.check(kind, value)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"{kind} config matches namespace prd", result.stdout)

    def test_inputs_naming_another_repository_or_launch_template_are_refused(self):
        foreign_repo = [{**p, "ParameterValue": f"{A}.dkr.ecr.{R}.amazonaws.com/ezil-prd-foundation-applicationimages0123abcd-a1b2c3d4e5f6"}
                        if p["ParameterKey"] == "ApplicationImageRepositoryUri" else p for p in AMI_PARAMETERS]
        self.assertIn("ECR repository mismatch", self.check("ami-parameters", foreign_repo).stderr)
        foreign_lt = edit(LIFECYCLE, ["settings", "deployment", "launchTemplateId"], "lt-0123456789abcdef0")
        self.assertIn("launch-template identity mismatch", self.check("lifecycle", foreign_lt).stderr)

    def test_mum_staging_rebase_and_foreign_values_are_refused(self):
        for kind, cases in REFUSED.items():
            for why, value in cases:
                with self.subTest(kind=kind, why=why):
                    result = self.check(kind, value)
                    self.assertNotEqual(result.returncode, 0, why)
                    self.assertIn("ERROR:", result.stderr)

    def test_mum_inputs_fail_under_prd_and_prd_inputs_fail_under_mum(self):
        path = self.root / "ami.json"
        path.write_text(json.dumps(AMI))
        self.assertNotEqual(run("--namespace", "mum", "namespace-config", "ami", str(path)).returncode, 0)
        path.write_text(json.dumps({**AMI, "namespace": "mum"}))
        self.assertEqual(run("--namespace", "mum", "namespace-config", "ami", str(path)).returncode, 0)
        self.assertNotEqual(run("--namespace", "prd", "namespace-config", "ami", str(path)).returncode, 0)


class ProfileTests(unittest.TestCase):
    def shell(self, namespace):
        # die is stubbed so the profile can be read even past a refusal.
        script = (f'source "{TOOLS / "common.sh"}"; die() {{ :; }}; use_namespace {namespace}; '
                  'printf "%s\\n" "$namespace" "$bucket" "$exec_role" "$machine" "$repository" "$launch_template" '
                  '"$lock_dir" "$ami_stack" "$foundation_stack" "$lifecycle_stack" "$config_dir" "$release_dir"')
        result = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True)
        return result.stdout.splitlines()

    def test_common_sh_and_json_tool_name_the_same_resources(self):
        for namespace in ("mum", "prd"):
            with self.subTest(namespace):
                tool.use_namespace(namespace)
                try:
                    expected = [namespace, tool.BUCKET, tool.ROLE, tool.MACHINE, tool.REPOSITORY or "", tool.LAUNCH_TEMPLATE or "",
                                str(Path(tool.APP_SECRET_LOCK).parent), f"ezil-{namespace}-ami", f"ezil-{namespace}-foundation",
                                f"ezil-{namespace}-lifecycle", f"/root/ezil-aws-{namespace}/config", f"/root/ezil-aws-{namespace}/release/next"]
                    self.assertEqual(self.shell(namespace), expected)
                finally:
                    tool.use_namespace("mum")

    def test_mum_profile_keeps_the_original_literals(self):
        self.assertEqual((tool.NAMESPACE, tool.MACHINE, tool.SECRET, tool.REPOSITORY, tool.ROLE, tool.LAUNCH_TEMPLATE, tool.APP_SECRET_LOCK), (
            "mum", "arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-mum-lifecycle", "ezil-os/billing-staging/app",
            "452630323510.dkr.ecr.ap-south-1.amazonaws.com/ezil-mum-foundation-applicationimages439f25f1-milwdio3nbs6",
            "arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec", "lt-06f691fc1e4dfe3cc", "/root/ezil-aws-mum/locks/app-secret.lock"))

    def test_prd_profile(self):
        tool.use_namespace("prd")
        try:
            self.assertEqual((tool.SECRET, tool.ORIGIN, tool.BUCKET, tool.ROLE, tool.MACHINE, tool.APP_SECRET_LOCK), (
                "ezil-os/production/app", "https://os-prod.ezil.work", "ezil-prd-deploy-assets-452630323510",
                "arn:aws:iam::452630323510:role/ezil/identity/ezil-prd-cfn-exec",
                "arn:aws:states:ap-south-1:452630323510:stateMachine:ezil-prd-lifecycle", "/root/ezil-aws-prd/locks/app-secret.lock"))
            self.assertEqual((tool.REPOSITORY, tool.LAUNCH_TEMPLATE), (PRD_REPOSITORY, PRD_LAUNCH_TEMPLATE))
            self.assertEqual(tool.PROFILE["appCaller"]["ec2CallerRoleArns"], [HOST])
        finally:
            tool.use_namespace("mum")

    def test_unpinned_prd_refuses_and_unknown_namespaces_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            tools = unpinned_tools(folder)
            result = run("--namespace", "prd", "pair", "/nonexistent", tools=tools)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("no pinned ECR repository/launch template", result.stderr)
            shell = subprocess.run(["bash", "-c", f'source "{tools / "common.sh"}"; use_namespace prd'], capture_output=True, text=True)
            self.assertNotEqual(shell.returncode, 0)
            self.assertIn("not pinned yet", shell.stderr)
        self.assertIn("unknown operator namespace", run("--namespace", "qa", "namespace-config", "keys", "/nonexistent").stderr)

    def test_prd_never_writes_mum_operator_state(self):
        shell = subprocess.run(["bash", "-c", f'source "{TOOLS / "common.sh"}"; release_dir=/root/ezil-aws-mum/release/other; use_namespace prd'],
                               capture_output=True, text=True)
        self.assertNotEqual(shell.returncode, 0)
        self.assertIn("never writes mum operator state", shell.stderr)

    def test_secret_errors_stay_redacted_under_namespace(self):
        with tempfile.TemporaryDirectory() as folder:
            tools = redirected_tools(folder)
            for namespace in ("mum", "prd"):
                result = run("--namespace", namespace, "secret-update", "/nonexistent/before.json", "/nonexistent/after.json", tools=tools)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stderr.strip(), "ERROR: secret operation refused; inspect deployment alignment and AWS access")
            # The app-secret lock taken was the redirected one, never the host's real operator lock.
            self.assertTrue((Path(folder) / "locks/app-secret.lock").exists())

    def test_prd_accepts_full_tuple_but_refuses_partial_and_foreign_workflows(self):
        tool.use_namespace('prd')
        self.addCleanup(tool.use_namespace, 'mum')
        d = {**LIFECYCLE['settings']['deployment'], 'lowerImageDigest':'sha256:'+'a'*64,
             'previousLowerImageDigest':'sha256:'+'b'*64,
             'preparationStateMachineVersionArn':tool.MACHINE.replace('-lifecycle','-rebase-preparation')+':1',
             'recoveryStateMachineVersionArn':LIFECYCLE['recoveryVersionArn']}
        config = edit(LIFECYCLE, ['settings','deployment'], d)
        self.assertEqual(tool.pair(config)['lowerImageDigest'], d['lowerImageDigest'])
        for field in tool.release.TUPLE:
            with self.subTest(field=field), self.assertRaises(ValueError):
                tool.pair(edit(config, ['settings','deployment',field], DELETE))
        for field in ('stateMachineVersionArn','preparationStateMachineVersionArn','recoveryStateMachineVersionArn'):
            with self.assertRaises(ValueError): tool.pair(edit(config, ['settings','deployment',field], d[field].replace('prd','mum')))
        self.assertEqual(tool.pair(LIFECYCLE)['amiId'], LIFECYCLE['settings']['deployment']['amiId'])

    def test_plain_recovery_promotion_requires_both_published_version_readbacks(self):
        tool.use_namespace('prd')
        self.addCleanup(tool.use_namespace, 'mum')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, value in [('before', LIFECYCLE), ('versions', {'stateMachineVersions':[
                {'stateMachineVersionArn':tool.MACHINE+':1'}]}), ('recovery', {'stateMachineVersions':[
                {'stateMachineVersionArn':tool.MACHINE.replace('-lifecycle','-recovery')+':1'}]})]:
                tool.write(root/(name+'.json'), value)
            args = ['plan-promotion', str(root/'before.json'), str(root/'versions.json'), 'ami-'+'2'*17, '3', str(root/'planned.json')]
            with self.assertRaisesRegex(ValueError, 'requires published version readback'): tool.main(args)
            with contextlib.redirect_stdout(io.StringIO()): tool.main([*args, str(root/'recovery.json')])
            planned = tool.read(root/'planned.json')
            self.assertEqual(planned['recoveryVersionArn'], tool.MACHINE.replace('-lifecycle','-recovery')+':2')
            self.assertEqual(planned['settings']['deployment']['stateMachineVersionArn'], tool.MACHINE+':2')
            self.assertFalse(set(tool.release.TUPLE) & planned['settings']['deployment'].keys())
            for bad in ({'stateMachineVersions':[]}, {'stateMachineVersions':[{'stateMachineVersionArn':tool.MACHINE+':1'}]},
                        {'nextToken':'more', 'stateMachineVersions':[{'stateMachineVersionArn':LIFECYCLE['recoveryVersionArn']}] }):
                tool.write(root/'recovery.json', bad)
                with self.assertRaises(ValueError): tool.main([*args, str(root/'recovery.json')])


if __name__ == '__main__':
    unittest.main(verbosity=1)
