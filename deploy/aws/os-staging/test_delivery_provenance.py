"""Real archives/generated installer, fake GitHub/AWS: no credentials or network."""
import copy
from contextlib import chdir
import hashlib
import fnmatch
import re
import tempfile
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import zipfile

from fixed_document import definition, document_digest
from release_admission import BUILD_JOB, CHECK_ORIGINS, RELEASE_PATH, REPO, REPO_ID, REQUIRED_CHECKS, admit_remote, bind_source
from check_evidence import record
from staging_candidate import PINNED
from staging_delivery import current_build, deliver, download_artifact
from delivery_permissions import proposed_policy
from public_config import identity, validate as validate_public_config
from activation_source import ROOT, render
from test_deploy_tooling import SandboxTestCase
import test_install_provenance as installer_tests
import test_pipeline_provenance as candidate_tests


def archive_bytes(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w') as archive:
        for name, data in files.items():
            archive.writestr(zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0)), data)
    return stream.getvalue()


class FakeGitHub:
    def __init__(self, contract, request):
        self.calls, self.archives = [], {}
        self.contract, self.request = contract, request
        self.bad_check = self.bad_ref = self.bad_environment = False
        self.app_metadata = self.app_archive = None
        self.receipt_patch, self.run_patch, self.job_patch = {}, {}, {}
        self.build = {'run_id': 100, 'run_attempt': 1, 'path': RELEASE_PATH, 'event': 'workflow_dispatch'}
        self.build_patch = {}

    def run(self, run_id):
        workflow = list(dict.fromkeys(v[0] for v in CHECK_ORIGINS.values()))[run_id - 200] if run_id != 100 else None
        return {'id': run_id, 'head_sha': self.request['source'], 'head_branch': 'fixture-only',
                'repository': {'id': REPO_ID}, 'head_repository': {'id': REPO_ID},
                'path': '.github/workflows/' + workflow if workflow else RELEASE_PATH,
                'event': 'push' if workflow else 'workflow_dispatch', 'run_attempt': 1,
                'status': 'completed', 'conclusion': 'success',
                **(self.run_patch if workflow else self.build_patch)}

    def origin(self, i):
        workflow, key = CHECK_ORIGINS[REQUIRED_CHECKS[i]]
        return 200 + list(dict.fromkeys(v[0] for v in CHECK_ORIGINS.values())).index(workflow), key

    def json(self, path):
        self.calls.append(path)
        if path.startswith('git/ref/'):
            return {'object': {'sha': '0' * 40 if self.bad_ref else self.request['source']}}
        if path == 'environments/staging':
            return {'deployment_branch_policy': {'custom_branch_policies': not self.bad_environment},
                    'protection_rules': [{'type': 'required_reviewers', 'prevent_self_review': True,
                                          'reviewers': [{'type': 'User', 'reviewer': {'id': 123}}]}]}
        if path.endswith('deployment-branch-policies'):
            return {'branch_policies': [{'name': 'fixture-only', 'type': 'branch'}]}
        if path.startswith('commits/'):
            checks = [{'id': i + 10, 'name': name, 'head_sha': self.request['source'],
                       'app': {'slug': 'github-actions'}, 'status': 'completed', 'conclusion': 'success',
                       'details_url': f'https://github.com/EZiLHQ/ezil-os/actions/runs/{self.origin(i)[0]}/job/{i+1000}'}
                      for i, name in enumerate(REQUIRED_CHECKS)]
            if self.bad_check:
                checks[0]['conclusion'] = 'failure'
            return {'check_runs': checks}
        if re.fullmatch(r'actions/runs/[0-9]+', path):
            return self.run(int(path.split('/')[-1]))
        if path.startswith('actions/jobs/'):
            job_id = int(path.split('/')[-1]); i = job_id - 1000
            return {'id': job_id, 'name': REQUIRED_CHECKS[i], 'run_id': self.origin(i)[0], 'run_attempt': 1,
                    'head_sha': self.request['source'], 'status': 'completed', 'conclusion': 'success',
                    'check_run_url': f'https://api.github.com/repos/{REPO}/check-runs/{i+10}', **self.job_patch}
        if '/attempts/' in path:
            return {'jobs': [{'name': BUILD_JOB, 'run_id': 100, 'run_attempt': 1,
                             'head_sha': self.request['source'], 'status': 'completed', 'conclusion': 'success'}]}
        if path.endswith('/artifacts?per_page=100'):
            run_id = int(path.split('/')[2]); artifacts = []
            for i, name in enumerate(REQUIRED_CHECKS):
                run, key = self.origin(i)
                if run != run_id:
                    continue
                receipt = {'head': self.request['source'], 'source': self.request['source'], 'tree': 'a' * 40,
                           'deployment_authorized': False, 'repository': REPO, 'job': key,
                           'workflow_ref': f'{REPO}/.github/workflows/{CHECK_ORIGINS[name][0]}@{self.request["ref"]}',
                           'event': 'push', 'ref': self.request['ref'], 'run_id': run_id, 'run_attempt': 1,
                           **self.receipt_patch}
                data = archive_bytes({'checkout.json': json.dumps(receipt).encode()})
                self.archives[500+i] = data
                artifacts.append({'id': 500+i, 'name': f'os-check-{key}-{run_id}-1', 'expired': False,
                                  'size_in_bytes': len(data), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()})
            return {'artifacts': artifacts}
        if path == 'actions/artifacts/60':
            return self.app_metadata
        raise AssertionError(path)

    def download(self, artifact_id, destination):
        self.calls.append(('download', artifact_id))
        destination.write_bytes(self.app_archive if artifact_id == 60 else self.archives[artifact_id])


class PermissionModel:
    """Evaluator for this proposal's Allow/Action/Resource/conditions subset.

    Every modeled service request must pass it before fake execution. Unknown
    actions or conditions fail closed. This is not AWS's live policy simulator.
    """
    def __init__(self, policy):
        self.policy = policy

    def allows(self, action, resources, context):
        def condition(statement):
            for op, terms in statement.get('Condition', {}).items():
                for key, expected in terms.items():
                    actual = context.get(key)
                    if op == 'StringEquals':
                        valid = actual == expected
                    elif op == 'ForAllValues:StringEquals':
                        valid = all(v in expected for v in (actual or []))
                    elif op == 'Null':
                        valid = (actual is None) == (expected == 'true')
                    else:
                        valid = False
                    if not valid:
                        return False
            return True
        return all(any(s['Effect'] == 'Allow' and action in s['Action'] and
                       any(fnmatch.fnmatchcase(resource, pattern) for pattern in s['Resource']) and condition(s)
                       for s in self.policy['Statement']) for resource in resources)

    def authorize(self, service, operation, args, region):
        def value(flag):
            return args[args.index(flag) + 1]
        context = {'aws:RequestedRegion': region}
        resources = ['*']
        if (service, operation) == ('sts', 'get-caller-identity'):
            return  # STS GetCallerIdentity needs no permission grant.
        if service == 'dynamodb':
            action = {'get-item': 'GetItem', 'put-item': 'PutItem', 'delete-item': 'DeleteItem'}[operation]
            resources = [f'arn:aws:dynamodb:{region}:452630323510:table/{value("--table-name")}']
            key = json.loads(value('--key')).get('scope', {}).get('S')
            if key is not None:
                context['dynamodb:LeadingKeys'] = [key]
        elif service == 's3api':
            action = 'PutObject'
            service = 's3'
            resources = [f'arn:aws:s3:::{value("--bucket")}/{value("--key")}']
        elif service == 'ec2':
            action = 'DescribeInstances'
        elif service == 'ssm':
            action = {'get-document': 'GetDocument', 'describe-document': 'DescribeDocument',
                      'send-command': 'SendCommand', 'get-command-invocation': 'GetCommandInvocation'}[operation]
            if operation in ('get-document', 'describe-document', 'send-command'):
                document = value('--document-name' if operation == 'send-command' else '--name')
                resources = [f'arn:aws:ssm:{region}:452630323510:document/{document}']
            if operation == 'send-command':
                resources.append(f'arn:aws:ec2:{region}:452630323510:instance/{value("--instance-ids")}')
        else:
            raise PermissionError('Unmodeled service')
        if not self.allows(service + ':' + action, resources, context):
            raise PermissionError('Proposed delivery policy denies ' + service + ':' + action)


class FakeAWS:
    def __init__(self, contract):
        self.contract, self.calls, self.uploads = contract, [], {}
        self.permissions = PermissionModel(proposed_policy(contract["ssm_document_name"]))
        self.bad = None
        self.on_upload = None

    def __call__(self, service, operation, *args, **kwargs):
        self.permissions.authorize(service, operation, args, kwargs.get("region", PINNED["region"]))
        self.calls.append((service, operation, args, kwargs))
        def value(flag):
            return args[args.index(flag) + 1]
        if operation == 'get-caller-identity':
            return {'Account': PINNED['account'], 'Arn': 'arn:aws:sts::452630323510:assumed-role/' +
                    ('wrong' if self.bad == 'role' else 'fixture-only') + '/fixture'}
        if operation == 'describe-instances':
            return {'Reservations': [{'Instances': [{'InstanceId': PINNED['instance_id'],
                'VpcId': 'wrong' if self.bad == 'host' else PINNED['vpc_id'], 'State': {'Name': 'running'},
                'Tags': [{'Key': 'Name', 'Value': PINNED['instance_name']},
                         {'Key': 'ezil:env', 'Value': PINNED['instance_environment']}]}]}]}
        if operation == 'get-document':
            doc = definition()
            if self.bad == 'document':
                doc['mainSteps'][0]['inputs']['runCommand'] = ['unreviewed shell']
            return {'Name': self.contract['ssm_document_name'], 'DocumentVersion': self.contract['ssm_document_version'],
                    'Content': json.dumps(doc)}
        if operation == 'describe-document':
            return {'Document': {'Name': self.contract['ssm_document_name'],
                'DocumentVersion': '$LATEST' if self.bad == 'version' else self.contract['ssm_document_version'],
                'HashType': 'Sha256', 'Hash': 'e' * 64}}
        if operation == 'get-item':
            return {'Item': {'owner': {'S': 'other' if self.bad == 'lease' else 'github-os-app-99-1'},
                             'expires_at': {'N': '5000'}}}
        if operation == 'put-object':
            self.uploads[value('--key')] = Path(value('--body')).read_bytes()
            if self.on_upload:
                self.on_upload()
            return {}
        if operation == 'send-command':
            if self.bad == 'uncertain-send':
                raise RuntimeError('transport lost after possible execution')
            return {'Command': {'CommandId': 'fixture-command'}}
        if operation == 'get-command-invocation':
            return {'Status': self.bad if self.bad in ('Failed', 'TimedOut', 'Cancelled') else 'Success'}
        raise AssertionError((service, operation, args))


class DeliveryProvenanceTests(SandboxTestCase):
    def setUp(self):
        super().setUp()
        fixture = candidate_tests.StagingPipelineTests()
        fixture.setUp()
        self.contract = {**fixture.contract, 'required_checks': REQUIRED_CHECKS,
                         'public_config': identity('https://fixture.supabase.co', 'fixture-public-key'),
                         'environment_reviewers': [{'type': 'User', 'id': 123}],
                         'ssm_document_name': 'EZiL-OS-Staging-InstallVerified-fixture',
                         'ssm_document_version': '1', 'ssm_document_sha256': document_digest(definition())}
        self.request = {**fixture.request, 'source': self.box.sha, 'tag': 'v1'}
        self.request['receipt_sha256'] = installer_tests.VerifiedInstallTests.prepare(self, public_config=self.contract['public_config'])
        self.api = FakeGitHub(self.contract, self.request)
        self.aws = FakeAWS(self.contract)
        self.saved = []

    def run_delivery(self, **kw):
        return deliver(self.contract, self.request, self.directory, 'github-os-app-99-1',
                       lambda r: self.saved.append(copy.deepcopy(r)), call=self.aws, now=lambda: 1000,
                       sleep=lambda _: None, health=kw.get('health', lambda: {'ok': True, 'sha': self.box.sha}))

    def assert_no_writes(self):
        self.assertFalse(any(c[1] in ('put-object', 'send-command') for c in self.aws.calls))

    def test_disabled_or_unapproved_contract_never_requests_cloud_access(self):
        disabled = json.loads(Path(__file__).with_name('pipeline.json').read_text())
        with self.assertRaisesRegex(ValueError, 'disabled'):
            admit_remote(disabled, self.request, 'a' * 40, self.api)
        self.assertEqual(self.api.calls, [])
        for field in ('delivery_role_arn', 'release_ref', 'required_checks', 'environment_reviewers',
                      'ssm_document_name', 'ssm_document_version', 'ssm_document_sha256', 'public_config'):
            original = self.contract[field]
            self.contract[field] = None
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.run_delivery()
            self.contract[field] = original
        self.assertEqual(self.aws.calls, [])

    def test_remote_admission_checks_source_tree_branch_environment_and_checks(self):
        self.assertEqual(admit_remote(self.contract, self.request, 'a' * 40, self.api)['source'], self.box.sha)
        for field in ('bad_check', 'bad_ref', 'bad_environment'):
            setattr(self.api, field, True)
            with self.subTest(field=field), self.assertRaises(ValueError):
                admit_remote(self.contract, self.request, 'a' * 40, self.api)
            setattr(self.api, field, False)
        self.api.receipt_patch['tree'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'different source'):
            admit_remote(self.contract, self.request, 'a' * 40, self.api)

    def test_fixed_document_executes_real_installer_with_only_environment_parameters(self):
        doc = definition()
        self.assertEqual(set(doc['parameters']), {'Tag', 'SourceSha', 'ReceiptSha256'})
        self.assertTrue(all(p['interpolationType'] == 'ENV_VAR' for p in doc['parameters'].values()))
        path = self.box.root / 'fixed.sh'
        path.write_text(doc['mainSteps'][0]['inputs']['runCommand'][0])
        _, result = self.box.install([], script=path, SSM_Tag='v1', SSM_SourceSha=self.box.sha,
                                    SSM_ReceiptSha256=self.request['receipt_sha256'],
                                    FAKE_INSPECT_JSON=json.dumps(self.loaded), FAKE_SHA=self.box.sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed TAG: v1', result.stdout)

    def test_fixed_document_missing_agent_interpolation_fails_before_host_changes(self):
        path = self.box.root / 'fixed.sh'
        path.write_text(definition()['mainSteps'][0]['inputs']['runCommand'][0])
        _, result = self.box.install([], script=path)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.box.calls(), [])

    def test_fixed_document_wrong_instance_account_region_refuses_before_mutation(self):
        path = self.box.root / 'fixed.sh'
        path.write_text(definition()['mainSteps'][0]['inputs']['runCommand'][0])
        expected = {'instanceId': PINNED['instance_id'], 'accountId': PINNED['account'], 'region': PINNED['region']}
        for key in expected:
            (self.box.state / 'log').unlink(missing_ok=True)
            with self.subTest(key=key):
                _, result = self.box.install([], script=path, SSM_Tag='v1', SSM_SourceSha=self.box.sha,
                    SSM_ReceiptSha256=self.request['receipt_sha256'], FAKE_INSTANCE_IDENTITY=json.dumps({**expected, key: 'wrong'}))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('refused instance/account/region', result.stderr)
                self.assertNotIn('Installed TAG', result.stdout)
                self.assertTrue(all(c[0] == 'curl' for c in self.box.calls()))
                self.assertNotIn('fixture-imds-token', result.stdout + result.stderr)

    def test_scoped_getitem_is_required_before_upload_and_denies_other_keys_or_writes(self):
        policy = self.aws.permissions.policy
        policy['Statement'] = [s for s in policy['Statement'] if s['Sid'] != 'ReadOnlySharedStagingLease']
        with self.assertRaisesRegex(PermissionError, 'dynamodb:GetItem'):
            self.run_delivery()
        self.assert_no_writes()
        self.assertTrue(self.saved[-1]['lease_release_allowed'])  # Known pre-submission.
        model = PermissionModel(proposed_policy(self.contract['ssm_document_name']))
        table = 'arn:aws:dynamodb:us-east-1:452630323510:table/ezil-ci-staging'
        ctx = {'aws:RequestedRegion': 'us-east-1', 'dynamodb:LeadingKeys': ['shared-staging']}
        self.assertTrue(model.allows('dynamodb:GetItem', [table], ctx))
        for action, resource, context in [
                ('dynamodb:PutItem', table, ctx), ('dynamodb:DeleteItem', table, ctx),
                ('dynamodb:GetItem', table + '-other', ctx),
                ('dynamodb:GetItem', table, {**ctx, 'dynamodb:LeadingKeys': ['other']}),
                ('dynamodb:GetItem', table, {'aws:RequestedRegion': 'us-east-1'}),
                ('dynamodb:GetItem', table, {**ctx, 'aws:RequestedRegion': 'ap-south-1'})]:
            with self.subTest(action=action, context=context):
                self.assertFalse(model.allows(action, [resource], context))

    def test_permission_model_denies_foreign_bucket_host_and_general_shell_document(self):
        model = self.aws.permissions
        for args in [('--bucket', 'production', '--key', 'os-staging/images/v1.source.json'),
                     ('--bucket', PINNED['artifact_bucket'], '--key', 'production/v1.source.json')]:
            with self.assertRaises(PermissionError):
                model.authorize('s3api', 'put-object', args, PINNED['region'])
        for document, host in [('AWS-RunShellScript', PINNED['instance_id']),
                               (self.contract['ssm_document_name'], 'i-other')]:
            with self.assertRaises(PermissionError):
                model.authorize('ssm', 'send-command', ('--document-name', document, '--instance-ids', host), PINNED['region'])

    def test_required_checks_reject_foreign_workflow_pr_checkout_event_job_attempt_and_tree(self):
        cases = [('run_patch', {'path': '.github/workflows/spoof.yml'}),
                 ('run_patch', {'event': 'pull_request'}), ('run_patch', {'head_sha': 'b' * 40}),
                 ('job_patch', {'run_attempt': 2}), ('job_patch', {'run_id': 777}),
                 ('job_patch', {'name': 'duplicate-display-name'}),
                 ('job_patch', {'check_run_url': f'https://api.github.com/repos/{REPO}/check-runs/999'}),
                 ('receipt_patch', {'source': 'b' * 40}), ('receipt_patch', {'tree': 'b' * 40}),
                 ('receipt_patch', {'event': 'pull_request'}), ('receipt_patch', {'run_attempt': 2}),
                 ('receipt_patch', {'job': 'other'}), ('receipt_patch', {'workflow_ref': 'foreign/path'})]
        for attribute, patch in cases:
            self.api = FakeGitHub(self.contract, self.request)
            setattr(self.api, attribute, patch)
            with self.subTest(attribute=attribute, patch=patch), self.assertRaises(ValueError):
                admit_remote(self.contract, self.request, 'a' * 40, self.api)

    def test_public_browser_auth_identity_rejects_wrong_url_key_and_sealed_image_config(self):
        env = {'NEXT_PUBLIC_SUPABASE_URL': 'https://fixture.supabase.co',
               'NEXT_PUBLIC_SUPABASE_ANON_KEY': 'fixture-public-key'}
        self.assertEqual(len(validate_public_config(self.contract, env)), 64)
        for key, value in [('NEXT_PUBLIC_SUPABASE_URL', 'https://wrong.supabase.co'),
                           ('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'other-public-key')]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                validate_public_config(self.contract, {**env, key: value})
        # A self-consistent image+receipt for another backend still cannot deliver.
        wrong = identity('https://wrong.supabase.co', 'other-public-key')
        self.request['receipt_sha256'] = installer_tests.VerifiedInstallTests.prepare(self, public_config=wrong)
        with self.assertRaisesRegex(ValueError, 'not approved for staging'):
            self.run_delivery()
        self.assert_no_writes()
        # Rewriting only the receipt cannot disguise that foreign image config.
        path = self.directory / 'v1.source.json'
        receipt = json.loads(path.read_text()); receipt['public_config'] = self.contract['public_config']
        path.write_text(json.dumps(receipt))
        self.request['receipt_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, 'Image public configuration'):
            self.run_delivery()
        self.assert_no_writes()

    def test_activation_bundle_has_real_push_checks_and_preserves_dco_script_and_test_commands(self):
        before = {str(p): p.read_bytes() for p in (ROOT / '.github/workflows').glob('*.yml')}
        bundle = render(ROOT, 'refs/heads/fixture-only')
        for workflow in ('ci.yml', 'codeql.yml', 'dco.yml'):
            self.assertIn('"fixture-only"', bundle['.github/workflows/' + workflow])
        original_dco = (ROOT / '.github/workflows/dco.yml').read_text().split('        run: |\n', 1)[1].rstrip()
        self.assertIn(original_dco, bundle['.github/workflows/dco.yml'])
        self.assertIn('github.event.pull_request.base.sha || github.event.before', bundle['.github/workflows/dco.yml'])
        for workflow, job in CHECK_ORIGINS.values():
            text = bundle['.github/workflows/' + workflow]
            body = re.search(r'^  ' + re.escape(job) + r':\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)', text, re.M | re.S)[1]
            self.assertIn('check_evidence.py', body)
            self.assertIn('os-check-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}', body)
        start, end = map(int, re.search(r'CI_PRIVATE_PACKAGE_LINES = \{ start: ([0-9]+), end: ([0-9]+)', bundle['tools/triage.ts']).groups())
        paragraph = bundle['.github/workflows/ci.yml'].splitlines()[start-1:end]
        self.assertIn('THE PACKAGE IS PRIVATE', paragraph[0])
        self.assertIn('bare docker exit code.', paragraph[-1])
        for name, data in before.items():
            self.assertEqual(Path(name).read_bytes(), data)
        self.assertIsNone(json.loads((ROOT / 'deploy/aws/os-staging/pipeline.json').read_text())['release_ref'])
        for ref in ('', 'refs/heads/main', 'refs/heads/preview'):
            with self.assertRaises(ValueError):
                render(ROOT, ref)

    def test_delivery_has_exact_resources_parameters_and_immutable_writes(self):
        result = self.run_delivery()
        self.assertEqual(result['state'], 'installed_health_verified')
        self.assertTrue(result['lease_release_allowed'])
        writes = [c for c in self.aws.calls if c[1] == 'put-object']
        self.assertEqual(len(writes), 4)
        self.assertTrue(all(c[2][c[2].index('--bucket') + 1] == PINNED['artifact_bucket'] and
                            '--if-none-match' in c[2] for c in writes))
        self.assertTrue(list(self.aws.uploads)[-1].endswith('.sha256'))
        send, = [c for c in self.aws.calls if c[1] == 'send-command']
        args = send[2]
        self.assertEqual(json.loads(args[args.index('--parameters') + 1]), {
            'Tag': ['v1'], 'SourceSha': [self.box.sha], 'ReceiptSha256': [self.request['receipt_sha256']]})
        self.assertEqual(args[args.index('--document-name') + 1], self.contract['ssm_document_name'])
        self.assertEqual(args[args.index('--document-version') + 1], '1')
        self.assertEqual(args[args.index('--document-hash') + 1], 'e' * 64)
        self.assertEqual(args[args.index('--instance-ids') + 1], PINNED['instance_id'])
        self.assertEqual({c[:2] for c in self.aws.calls}, {
            ('sts', 'get-caller-identity'), ('ec2', 'describe-instances'), ('ssm', 'get-document'),
            ('ssm', 'describe-document'), ('dynamodb', 'get-item'), ('s3api', 'put-object'),
            ('ssm', 'send-command'), ('ssm', 'get-command-invocation')})

    def test_role_target_document_version_and_lease_mismatch_refuse_before_writes(self):
        for case in ('role', 'host', 'document', 'version', 'lease'):
            self.aws = FakeAWS(self.contract)
            self.aws.bad = case
            with self.subTest(case=case), self.assertRaises(ValueError):
                self.run_delivery()
            self.assert_no_writes()

    def test_private_artifact_snapshot_survives_caller_mutation_during_upload(self):
        before = (self.directory / 'v1.runtime.tar.gz').read_bytes()
        self.aws.on_upload = lambda: (self.directory / 'v1.runtime.tar.gz').write_bytes(b'changed')
        self.run_delivery()
        self.assertEqual(self.aws.uploads[PINNED['artifact_prefix'] + 'v1.runtime.tar.gz'], before)

    def test_uncertain_submission_retains_lease_and_never_retries_or_rolls_back(self):
        self.aws.bad = 'uncertain-send'
        with self.assertRaises(RuntimeError):
            self.run_delivery()
        self.assertFalse(self.saved[-1]['lease_release_allowed'])
        self.assertFalse(self.saved[-1]['automatic_rollback'])
        self.assertEqual(len([c for c in self.aws.calls if c[1] == 'send-command']), 1)
        self.assertFalse(any(c[1] == 'delete-item' for c in self.aws.calls))

    def test_terminal_install_or_health_failure_records_owner_recovery(self):
        for failure in ('Failed', 'TimedOut', 'Cancelled', 'health'):
            self.aws = FakeAWS(self.contract)
            self.aws.bad = failure
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                self.run_delivery(health=lambda: {'ok': True, 'sha': '0' * 40})
            self.assertEqual(self.saved[-1]['state'], 'recovery_required')
            self.assertFalse(self.saved[-1]['lease_release_allowed'])
            self.assertEqual(self.saved[-1]['lease_expires_at'], 5000)
            self.assertEqual(len([c for c in self.aws.calls if c[1] == 'send-command']), 1)
            self.assertFalse(self.saved[-1]['automatic_rollback'])
            self.assertEqual(self.saved[-1]['candidate']['previous_app_source'], self.request['previous_app_source'])

    def test_download_binds_artifact_run_repository_digest_and_exact_file_set(self):
        self.api.app_archive = archive_bytes({p.name: p.read_bytes() for p in self.directory.iterdir()})
        digest = hashlib.sha256(self.api.app_archive).hexdigest()
        self.api.app_metadata = {'id': 60, 'expired': False, 'digest': 'sha256:' + digest,
            'name': f'os-staging-app-{self.box.sha}-100-1',
            'workflow_run': {'id': 100, 'head_sha': self.box.sha, 'head_repository_id': REPO_ID}}
        target = self.box.root / 'download'
        target.mkdir()
        download_artifact(self.api, 60, 100, digest, self.request, target, self.api.build)
        for patch in ({'path': '.github/workflows/foreign.yml'}, {'run_attempt': 2}, {'event': 'push'},
                      {'head_branch': 'other'}, {'head_repository': {'id': 12}}):
            self.api.build_patch = patch
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                download_artifact(self.api, 60, 100, digest, self.request, target, self.api.build)
        self.api.build_patch = {}
        with self.assertRaisesRegex(ValueError, 'current release build'):
            download_artifact(self.api, 60, 101, digest, self.request, target, self.api.build)
        self.api.app_metadata['name'] = f'os-staging-app-{self.box.sha}-100-2'
        with self.assertRaisesRegex(ValueError, 'Wrong app artifact'):
            download_artifact(self.api, 60, 100, digest, self.request, target, self.api.build)
        self.api.app_metadata['name'] = f'os-staging-app-{self.box.sha}-100-1'
        self.api.app_metadata['workflow_run']['head_sha'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'Wrong app artifact'):
            download_artifact(self.api, 60, 100, digest, self.request, target, self.api.build)

    def test_current_build_identity_cannot_be_supplied_as_an_unrelated_same_sha_run(self):
        env = {'GITHUB_REPOSITORY': REPO, 'GITHUB_REPOSITORY_ID': str(REPO_ID), 'GITHUB_SHA': self.box.sha,
               'GITHUB_REF': self.request['ref'], 'GITHUB_EVENT_NAME': 'workflow_dispatch',
               'GITHUB_WORKFLOW_REF': f'{REPO}/{RELEASE_PATH}@{self.request["ref"]}',
               'GITHUB_RUN_ID': '100', 'GITHUB_RUN_ATTEMPT': '1'}
        self.assertEqual(current_build(self.request, env), self.api.build)
        for field in ('GITHUB_WORKFLOW_REF', 'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_EVENT_NAME', 'GITHUB_REPOSITORY_ID'):
            with self.subTest(field=field), self.assertRaises(ValueError):
                current_build(self.request, {**env, field: 'foreign'})

    def test_checkout_evidence_and_release_invocation_bind_real_git_tree(self):
        request = {**self.request, 'base': self.box.sha}
        event = self.box.root / 'event.json'
        event.write_text(json.dumps({'after': self.box.sha, 'before': '0' * 40}))
        env = {'GITHUB_REPOSITORY': REPO, 'GITHUB_SHA': self.box.sha, 'GITHUB_REF': request['ref'],
               'GITHUB_EVENT_NAME': 'push', 'GITHUB_EVENT_PATH': str(event), 'GITHUB_JOB': 'worker',
               'GITHUB_RUN_ID': '200', 'GITHUB_RUN_ATTEMPT': '1',
               'GITHUB_WORKFLOW_REF': f'{REPO}/.github/workflows/ci.yml@{request["ref"]}'}
        receipt = record(self.box.root / 'repo', env)
        self.assertEqual(receipt['source'], self.box.sha)
        self.assertEqual(receipt['job'], 'worker')
        self.assertEqual(receipt['run_attempt'], 1)
        release_env = {**env, 'GITHUB_EVENT_NAME': 'workflow_dispatch',
                       'GITHUB_WORKFLOW_REF': f'{REPO}/{RELEASE_PATH}@{request["ref"]}'}
        with chdir(self.box.root / 'repo'), patch.dict('os.environ', release_env):
            self.assertEqual(bind_source(request), receipt['tree'])
            with patch.dict('os.environ', {'GITHUB_EVENT_NAME': 'pull_request'}), self.assertRaises(ValueError):
                bind_source(request)


if __name__ == '__main__':
    unittest.main()
