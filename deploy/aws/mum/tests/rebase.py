#!/usr/bin/env python3
"""Offline lane-E contract tests; all cloud/host objects here are local doubles."""
import contextlib
import copy
import importlib.util
import json
import os
import shutil
from unittest.mock import patch
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import rebase_manifest as manifest


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


TOOL = module('json_tool', HERE.parent / 'json-tool.py')
AMI = HERE.parents[3] / 'infra/host-agent/ami'
LOWERS = module('lowers', AMI / 'validate-lowers.py')
RELEASE = module('release_ops', HERE.parent / 'rebase_release.py')
COMPUTER = module('computer_ops', HERE.parent / 'rebase_computer.py')


def release_record():
    return {
        'schemaVersion': 1, 'accountId': TOOL.ACCOUNT, 'region': TOOL.REGION, 'namespace': 'mum',
        'amiId': 'ami-' + '2' * 17, 'recipeVersion': '1.0.2',
        'lowerImageDigest': 'sha256:' + 'b' * 64, 'lowerImageRef': TOOL.REPOSITORY + '@sha256:' + 'c' * 64,
        'previousLowerImageDigest': 'sha256:' + 'a' * 64,
        'previousLowerImageRef': TOOL.REPOSITORY + '@sha256:' + 'd' * 64,
        'agentCommit': 'e' * 40, 'stateMachineVersionArn': TOOL.MACHINE + ':2',
        'preparationStateMachineVersionArn': TOOL.MACHINE.replace('-lifecycle', '-rebase-preparation') + ':1',
        'recoveryStateMachineVersionArn': TOOL.MACHINE.replace('-lifecycle', '-recovery') + ':1',
        'launchTemplateId': TOOL.LAUNCH_TEMPLATE, 'launchTemplateVersion': '2', 'createdAt': '2026-10-22T12:00:00.000Z',
    }


def seed_ledger(path, envelope, plan_sha='0'*64):
    outer = manifest.loads(envelope['SecretString'])
    ds = outer[TOOL.KEY]
    d = manifest.loads(ds)[TOOL.REGION] if isinstance(ds, str) else ds[TOOL.REGION]
    TOOL.write(path, {'schemaVersion': 1, 'entries': [{'generation': 1, 'planSha256': plan_sha,
        'operation': 'promote-canary', 'secretVersionId': envelope['VersionId'],
        'tuple': RELEASE.ledger_tuple(d), 'appGitSha': 'e'*40}]})


class RegistryGcLedgerTests(unittest.TestCase):
    def test_strict_registry_gc_schema_and_terminal_binding(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'ledger.json'
            d = release_record()
            initial = {'generation': 1, 'operation': 'apply-app', 'planSha256': 'a' * 64,
                       'state': 'completed', **RELEASE.observed_state({'VersionId': 'v1'}, dict(d, releases=[d]), 'e' * 40)}
            before = {k: initial[k] for k in ('secretVersionId', 'tuple', 'appGitSha', 'registrySha256')}
            expected = {k: v for k, v in before.items() if k != 'secretVersionId'}
            expected['registrySha256'] = 'b' * 64
            pending = {'generation': 2, 'operation': 'registry-gc', 'planSha256': 'a' * 64,
                       'state': 'pending', 'before': before, 'expected': expected}
            completed = {'generation': 3, 'operation': 'registry-gc', 'planSha256': 'a' * 64,
                         'state': 'completed', 'secretVersionId': 'v2', **expected}
            valid = {'schemaVersion': 1, 'entries': [initial, pending, completed]}
            TOOL.write(path, valid)
            self.assertEqual(RELEASE.load_ledger(path), valid)
            cases = []
            bad = copy.deepcopy(valid); del bad['entries'][2]['state']
            cases.append((bad, 'explicit state'))
            for state, field in [(1, 'before'), (1, 'expected'), (2, None)]:
                bad = copy.deepcopy(valid)
                snapshot = bad['entries'][state][field] if field else bad['entries'][state]
                del snapshot['registrySha256']
                cases.append((bad, 'registry pins'))
            for field, value in [('tuple', dict(expected['tuple'], amiId='ami-' + 'f' * 17)),
                                 ('appGitSha', 'f' * 40), ('registrySha256', before['registrySha256'])]:
                bad = copy.deepcopy(valid); bad['entries'][1]['expected'][field] = value
                cases.append((bad, 'only registry identity'))
            bad = copy.deepcopy(valid); bad['entries'][2]['registrySha256'] = 'c' * 64
            cases.append((bad, 'terminal state mismatch'))
            bad = {'schemaVersion': 1, 'entries': [dict(completed, generation=1)]}
            cases.append((bad, 'pending predecessor'))
            for bad, message in cases:
                TOOL.write(path, bad)
                with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                    RELEASE.load_ledger(path)

    def test_serialized_append_payload_must_match_json(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'evidence.json'
            with self.assertRaisesRegex(ValueError, 'serialized evidence mismatch'):
                TOOL.write(path, {'reviewed': True}, serialized='{"reviewed":false}')
            self.assertFalse(path.exists())


class ManifestTests(unittest.TestCase):
    def test_schema_order_and_classic_id_differs_from_registry_digest(self):
        value = release_record()
        self.assertEqual(list(manifest.validate(dict(reversed(list(value.items()))))), list(value))
        self.assertNotEqual(value['lowerImageDigest'], value['lowerImageRef'].split('@')[1])

    def test_containerd_child_manifest_id(self):
        value = release_record()
        value['lowerImageDigest'] = value['lowerImageRef'].split('@')[1]
        self.assertEqual(manifest.validate(value), value)

    def test_first_release_is_not_rebase_target(self):
        value = release_record()
        value.update(previousLowerImageDigest=None, previousLowerImageRef=None)
        manifest.validate(value)
        with self.assertRaises(ValueError):
            manifest.validate(value, target=True)

    def test_closed_strict_schema_and_semantic_negatives(self):
        value = release_record()
        cases = [dict(value, extra=1), {k: v for k, v in value.items() if k != 'agentCommit'}]
        for key, bad in [
            ('schemaVersion', True), ('schemaVersion', '1'), ('schemaVersion', 1.0), ('recipeVersion', '01.0.0'),
            ('recipeVersion', '1073741824.0.0'), ('namespace', 'identity'), ('createdAt', '2026-02-30T12:00:00.000Z'),
            ('createdAt', '2026-10-22T12:00:00Z'), ('createdAt', '2026-10-22T12:00:60.000Z'),
            ('previousLowerImageDigest', value['lowerImageDigest']), ('previousLowerImageRef', None),
            ('previousLowerImageDigest', None), ('lowerImageDigest', 'sha256:' + 'A' * 64),
            ('launchTemplateVersion', 2), ('launchTemplateVersion', '0'), ('launchTemplateVersion', '1' * 11),
            ('agentCommit', 'abcd1234'), ('stateMachineVersionArn', TOOL.MACHINE + ':live'),
            ('preparationStateMachineVersionArn', TOOL.MACHINE + ':1'),
            ('recoveryStateMachineVersionArn', value['recoveryStateMachineVersionArn'].replace(TOOL.ACCOUNT, '123456789012')),
            ('lowerImageRef', TOOL.REPOSITORY + ':latest'), ('lowerImageRef', value['lowerImageRef'] + '\n'),
            ('lowerImageRef', value['lowerImageRef'].replace('/ezil-', '/extra.amazonaws.com/ezil-')),
            ('previousLowerImageRef', value['previousLowerImageRef'].replace('/ezil-', '/other-')),
            ('lowerImageRef', value['lowerImageRef'].replace(TOOL.REGION, 'eu-west-1')),
        ]:
            cases.append(dict(value, **{key: bad}))
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                manifest.validate(bad)

    def test_duplicate_nonfinite_and_size_rejected(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '{"a":-Infinity}', '{"a":1e999}'):
            with self.assertRaises(ValueError):
                manifest.loads(raw)
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'manifest.json'
            path.write_text(json.dumps(release_record()) + ' ' * 16384)
            with self.assertRaises(ValueError):
                manifest.load(path)

    def test_tuple_all_or_none_and_config_recovery_equal(self):
        d = release_record()
        TOOL.pair({'settings': {'deployment': d}, 'recoveryVersionArn': d['recoveryStateMachineVersionArn']})
        for field in manifest.TUPLE:
            bad = dict(d)
            bad.pop(field)
            with self.assertRaises(ValueError):
                TOOL.pair({'settings': {'deployment': bad}})
        with self.assertRaises(ValueError):
            TOOL.pair({'settings': {'deployment': d}, 'recoveryVersionArn': TOOL.MACHINE + ':1'})

    def test_secret_full_tuple_roundtrip_preserves_outer_encoding_and_regions(self):
        new = TOOL.pair({'settings': {'deployment': release_record()}})
        old = dict(new, amiId='ami-' + '1' * 17, lowerImageDigest='sha256:' + 'a' * 64, previousLowerImageDigest=None)
        for encoded in (True, False):
            deployments = {TOOL.REGION: dict(release_record(), **old, unrelated='retained'), 'us-east-1': {'keep': True}}
            outer = {'keep': 'local-double', TOOL.KEY: json.dumps(deployments) if encoded else deployments}
            envelope = {'SecretString': json.dumps(outer)}
            after = TOOL.edit_secret(envelope, old, new)
            back = TOOL.edit_secret({'SecretString': json.dumps(after)}, new, old)
            self.assertEqual(back['keep'], outer['keep'])
            self.assertEqual(isinstance(back[TOOL.KEY], str), encoded)
            restored = json.loads(back[TOOL.KEY]) if encoded else back[TOOL.KEY]
            self.assertEqual(restored, deployments)
            drift = copy.deepcopy(deployments)
            drift[TOOL.REGION]['previousLowerImageDigest'] = 'sha256:' + 'f' * 64
            with self.assertRaises(ValueError):
                TOOL.edit_secret({'SecretString': json.dumps(dict(outer, **{TOOL.KEY: drift}))}, old, new)

    def test_tuple_only_environment_substitution(self):
        old = TOOL.pair({'settings': {'deployment': release_record()}})
        new = dict(old, lowerImageDigest='sha256:' + 'f' * 64, previousLowerImageDigest=old['lowerImageDigest'])
        settings = {'deployment': dict(release_record()), 'unrelated': old['lowerImageDigest']}
        raw = json.dumps(settings, separators=(',', ':'))
        result = json.loads(TOOL.promotion_substitution(raw, old, new))
        self.assertEqual(result['deployment']['lowerImageDigest'], new['lowerImageDigest'])
        self.assertEqual(result['unrelated'], old['lowerImageDigest'])


class LowerTests(unittest.TestCase):
    def test_inputs_reject_partial_equal_mutable_foreign_and_injection(self):
        value = release_record()
        valid = [value['lowerImageRef'], value['lowerImageDigest'], value['previousLowerImageRef'], value['previousLowerImageDigest']]
        cases = [(valid, 0), ([*valid[:2], '', ''], 0)]
        for index, bad in [(0, 'repo:latest'), (1, 'bad'), (2, ''), (3, ''), (3, valid[1]),
                           (2, valid[2].replace('/ezil-', '/other-')), (2, valid[2] + "'; echo bad")]:
            changed = valid.copy(); changed[index] = bad; cases.append((changed, 1))
        for args, expected in cases:
            result = subprocess.run(['bash', '-c', 'source "$1"; DESKTOP_IMAGE_REF=$2; DESKTOP_IMAGE_ID=$3; PREVIOUS_DESKTOP_IMAGE_REF=$4; PREVIOUS_DESKTOP_IMAGE_ID=$5; validate_lower_inputs', 'test', str(AMI / 'lower-inputs.sh'), *args])
            self.assertEqual(result.returncode, expected)

    def make_lowers(self, temp):
        lowers, config = Path(temp) / 'lowers', Path(temp) / 'config'
        lowers.mkdir(); config.mkdir()
        current, previous = 'sha256:' + 'b' * 64, 'sha256:' + 'a' * 64
        metadata = json.dumps({'Env': ['HOME=/root'], 'WorkingDir': '/'})
        for image in (current, previous):
            lower = lowers / image[7:]
            for directory in ('usr', 'etc', 'var/lib/dpkg'):
                (lower / directory).mkdir(parents=True)
            (lower / 'var/lib/dpkg/status').write_text('Package: bash\nStatus: install ok installed\n')
            (lowers / (image[7:] + '.image-id')).write_text(image + '\n')
            (lowers / (image[7:] + '.image-config.json')).write_text(metadata)
        (config / 'lower-image-digest').write_text(current + '\n')
        (config / 'previous-lower-image-digest').write_text(previous + '\n')
        (config / 'image-config.json').write_text(metadata)
        return lowers, config, current, previous

    def test_both_lowers_metadata_and_ids(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.make_lowers(temp)
            LOWERS.validate(*args)
            with self.assertRaises(ValueError):
                LOWERS.validate(*args[:3], args[2])

    def test_missing_previous_and_bad_package_and_stored_id(self):
        for kind in ('missing', 'package', 'id', 'symlink', 'config'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temp:
                lowers, config, current, previous = self.make_lowers(temp)
                if kind == 'missing':
                    (lowers / previous[7:]).rename(lowers / 'elsewhere')
                elif kind == 'package':
                    (lowers / previous[7:] / 'var/lib/dpkg/status').write_text('not packages')
                elif kind == 'id':
                    (lowers / (previous[7:] + '.image-id')).write_text(current)
                elif kind == 'config':
                    (config / 'image-config.json').write_text('{}')
                else:
                    status = lowers / previous[7:] / 'var/lib/dpkg/status'
                    status.rename(status.with_name('real')); status.symlink_to('real')
                with self.assertRaises(ValueError):
                    LOWERS.validate(lowers, config, current, previous)


class SharedDenyInclusionTests(unittest.TestCase):
    """The image-job boundary must refuse everything a shared global deny refuses (A2)."""
    def setUp(self):
        import rebase_cloudformation
        self.inc = rebase_cloudformation.includes_deny
        self.backup = {"Action": "ec2:CreateTags", "Effect": "Deny", "Resource": "*",
                       "Condition": {"ForAnyValue:StringEquals": {"aws:TagKeys": ["ezil:backup"]}, "Null": {"ec2:CreateAction": "true"}}}
        self.attr = {"Action": "ec2:DescribeInstanceAttribute", "Effect": "Deny", "Resource": "arn:aws:ec2:r:a:instance/*",
                     "Condition": {"StringNotEquals": {"aws:ResourceTag/ezil:stage": "mum"}}}
        self.allow_tags = {"Action": ["ec2:CreateSnapshot", "ec2:CreateTags"], "Effect": "Allow", "Resource": "*"}

    def test_identical_deny(self):
        self.assertTrue(self.inc([self.allow_tags, dict(self.backup)], self.backup))

    def test_superset_tag_keys_is_broader(self):
        wider = json.loads(json.dumps(self.backup)); wider["Condition"]["ForAnyValue:StringEquals"]["aws:TagKeys"] += ["ezil:purpose"]
        self.assertTrue(self.inc([self.allow_tags, wider], self.backup))

    def test_subset_or_changed_condition_is_refused(self):
        narrower = json.loads(json.dumps(self.backup)); narrower["Condition"]["ForAnyValue:StringEquals"]["aws:TagKeys"] = ["ezil:purpose"]
        self.assertFalse(self.inc([self.allow_tags, narrower], self.backup))
        other = json.loads(json.dumps(self.backup)); other["Condition"]["Null"] = {"ec2:CreateAction": "false"}
        self.assertFalse(self.inc([self.allow_tags, other], self.backup))
        resource = json.loads(json.dumps(self.backup)); resource["Resource"] = "arn:aws:ec2:r::snapshot/*"
        self.assertFalse(self.inc([self.allow_tags, resource], self.backup))

    def test_never_allowed_action_is_implicitly_denied(self):
        self.assertTrue(self.inc([self.allow_tags], self.attr))

    def test_allowed_action_without_deny_is_refused(self):
        self.assertFalse(self.inc([self.allow_tags], self.backup))
        wildcard = {"Action": "ec2:Describe*", "Effect": "Allow", "Resource": "*"}
        self.assertFalse(self.inc([wildcard], self.attr))
        self.assertFalse(self.inc([{"NotAction": "iam:*", "Effect": "Allow", "Resource": "*"}], self.attr))


class AsciiViewTests(unittest.TestCase):
    def test_live_question_mark_equals_synthesized_section_sign(self):
        import rebase_cloudformation as c
        self.assertEqual(c.ascii_view({'Description': 'boundary (doc \u00a75)'}), {'Description': 'boundary (doc ?5)'})
        self.assertNotEqual(c.ascii_view('doc ?5'), c.ascii_view('doc ?6'))


class DependentVersionReviewTests(unittest.TestCase):
    """CloudFormation reports a published version Modify when only its state machine changed."""
    def docs(self, review_extra):
        import rebase_cloudformation as c
        machine = {'Type': 'AWS::StepFunctions::StateMachine', 'Properties': {'DefinitionString': 'a'}}
        version = {'Type': 'AWS::StepFunctions::StateMachineVersion', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain',
                   'Properties': {'StateMachineArn': {'Ref': 'Wf'}, 'StateMachineRevisionId': {'Fn::GetAtt': ['Wf', 'StateMachineRevisionId']}}}
        role = lambda: {'Type': 'AWS::IAM::Role', 'Properties': {'PermissionsBoundary': 'arn:aws:iam::452630323510:policy/ezil/mum/ezil-mum-image-job-boundary'}}
        before = {'Resources': {'Wf': machine, 'Ver': version, 'PrepRebasePreparationRole1': role(), 'RecoveryRecoveryRole1': role()}}
        after = json.loads(json.dumps(before)); after['Resources']['Wf']['Properties']['DefinitionString'] = 'b'
        review = {'schemaVersion': 1, 'changes': {'Wf': {'action': 'Modify', 'properties': ['DefinitionString'], 'attributes': []}, **review_extra}}
        return c, before, after, review

    def test_dependent_version_entry_is_accepted(self):
        c, b, a, r = self.docs({'Ver': {'action': 'Modify', 'properties': ['StateMachineRevisionId'], 'attributes': []}})
        self.assertIn('Ver', c.validate_templates('workflows-test', b, a, r))

    def test_other_extra_entries_are_refused(self):
        c, b, a, r = self.docs({'Ver': {'action': 'Modify', 'properties': ['StateMachineArn'], 'attributes': []}})
        with self.assertRaises(ValueError): c.validate_templates('workflows-test', b, a, r)
        c, b, a, r = self.docs({'Ver': {'action': 'Modify', 'properties': ['StateMachineRevisionId'], 'attributes': []}})
        a['Resources']['Wf']['Properties']['DefinitionString'] = 'a'; r['changes'].pop('Wf')
        with self.assertRaises(ValueError): c.validate_templates('workflows-test', b, a, r)


class DependentVersionExecuteTests(DependentVersionReviewTests):
    """The property-values change-set view omits the dependent version; the plain view must list it."""
    def run_execute(self, plain_details):
        import hashlib, tempfile
        c, b, a, r = self.docs({'Ver': {'action': 'Modify', 'properties': ['StateMachineRevisionId'], 'attributes': []}})
        root = Path(tempfile.mkdtemp()); spec = {'stackName': c.STACKS['workflows'], 'roleArn': c.ROLE,
            'changeSetArn': 'arn:aws:cloudformation:ap-south-1:452630323510:changeSet/x/11111111-1111-4111-8111-111111111111'}
        for key, value in (('beforeTemplate', b), ('candidateTemplate', a), ('review', r)):
            path = root / (key + '.json'); path.write_text(json.dumps(value)); spec[key + 'Path'] = str(path)
            spec[key + 'Sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        wf = {'ResourceChange': {'LogicalResourceId': 'Wf', 'ResourceType': 'AWS::StepFunctions::StateMachine', 'Action': 'Modify', 'Replacement': 'False', 'Scope': ['Properties'],
              'Details': [{'Target': {'Attribute': 'Properties', 'Name': 'DefinitionString', 'RequiresRecreation': 'Never'}, 'ChangeSource': 'DirectModification'}]}, 'Type': 'Resource'}
        ver = {'ResourceChange': {'LogicalResourceId': 'Ver', 'ResourceType': 'AWS::StepFunctions::StateMachineVersion', 'Action': 'Modify', 'Replacement': 'Conditional',
               'Scope': ['Properties'], 'Details': plain_details}, 'Type': 'Resource'}
        def aws(*args):
            if args[1] == 'describe-change-set':
                changes = [wf] if '--include-property-values' in args else [wf, ver]
                return {'ChangeSetId': spec['changeSetArn'], 'StackName': spec['stackName'], 'Status': 'CREATE_COMPLETE', 'ExecutionStatus': 'AVAILABLE', 'Changes': changes, 'Parameters': None}
            if args[1] == 'get-template': return {'TemplateBody': a if '--change-set-name' in args else b}
            if args[1] == 'describe-stacks': return {'Stacks': [{'StackStatus': 'UPDATE_COMPLETE', 'RoleARN': c.ROLE}]}
            raise AssertionError(args)
        digest = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()
        with contextlib.redirect_stdout(io.StringIO()): return c.execute('workflows', spec, root, False, aws, None, digest)

    def test_plain_view_dependent_version_satisfies_review(self):
        self.assertIsNone(self.run_execute([{'Target': {'Attribute': 'Properties', 'Name': 'StateMachineRevisionId', 'RequiresRecreation': 'Always'},
                                             'ChangeSource': 'ResourceAttribute', 'Evaluation': 'Dynamic', 'CausingEntity': 'Wf.StateMachineRevisionId'}]))

    def test_plain_view_must_explain_the_dependent_version(self):
        for bad in ([], [{'Target': {'Attribute': 'Properties', 'Name': 'StateMachineArn', 'RequiresRecreation': 'Always'}, 'ChangeSource': 'ResourceAttribute', 'CausingEntity': 'Wf.StateMachineRevisionId'}],
                    [{'Target': {'Attribute': 'Properties', 'Name': 'StateMachineRevisionId', 'RequiresRecreation': 'Always'}, 'ChangeSource': 'ResourceAttribute', 'CausingEntity': 'Other.StateMachineRevisionId'}]):
            with self.assertRaises(ValueError): self.run_execute(bad)


class RecoveryAddTypesTests(DependentVersionReviewTests):
    def test_recovery_operational_resources_may_only_be_added(self):
        c, b, a, r = self.docs({})
        a['Resources']['RecoveryQueue1'] = {'Type': 'AWS::SQS::Queue', 'Properties': {}}
        r['changes']['RecoveryQueue1'] = {'action': 'Add', 'properties': [], 'attributes': []}
        self.assertIn('RecoveryQueue1', c.validate_templates('workflows', b, a, r))
        b2 = json.loads(json.dumps(b)); b2['Resources']['RecoveryQueue1'] = {'Type': 'AWS::SQS::Queue', 'Properties': {'X': 1}}
        r2 = json.loads(json.dumps(r)); r2['changes']['RecoveryQueue1'] = {'action': 'Modify', 'properties': ['X'], 'attributes': []}
        with self.assertRaises(ValueError): c.validate_templates('workflows', b2, a, r2)
        a3 = json.loads(json.dumps(a)); a3['Resources']['OtherQueue1'] = a3['Resources'].pop('RecoveryQueue1')
        r3 = json.loads(json.dumps(r)); r3['changes']['OtherQueue1'] = r3['changes'].pop('RecoveryQueue1')
        with self.assertRaises(ValueError): c.validate_templates('workflows', b, a3, r3)


class KmsGrantWildcardTests(DependentVersionReviewTests):
    def build(self, resource):
        c, b, a, r = self.docs({})
        a['Resources']['RecoveryHistoryKey1'] = {'Type': 'AWS::KMS::Key', 'DeletionPolicy': 'Retain', 'UpdateReplacePolicy': 'Retain',
                                                 'Properties': {'EnableKeyRotation': True, 'Tags': [{'Key': 'ezil:namespace', 'Value': 'mum'}]}}
        a['Resources']['RecoveryRolePolicy1'] = {'Type': 'AWS::IAM::Policy', 'Properties': {'PolicyDocument': {'Statement': [
            {'Effect': 'Allow', 'Action': ['kms:Decrypt', 'kms:GenerateDataKey*', 'kms:ReEncrypt*'], 'Resource': resource}]}}}
        for k in ('RecoveryHistoryKey1', 'RecoveryRolePolicy1'): r['changes'][k] = {'action': 'Add', 'properties': [], 'attributes': []}
        return c, b, a, r

    def test_cdk_key_grant_on_own_key_is_accepted(self):
        c, b, a, r = self.build({'Fn::GetAtt': ['RecoveryHistoryKey1', 'Arn']})
        self.assertIn('RecoveryRolePolicy1', c.validate_templates('workflows', b, a, r))

    def test_other_key_additions_are_refused(self):
        c, b, a, r = self.build({'Fn::GetAtt': ['RecoveryHistoryKey1', 'Arn']})
        a['Resources']['RecoveryHistoryKey1']['Properties']['EnableKeyRotation'] = False
        with self.assertRaises(ValueError): c.validate_templates('workflows', b, a, r)

    def test_wildcards_on_any_other_resource_are_refused(self):
        for resource in ('*', 'arn:aws:kms:ap-south-1:452630323510:key/other', {'Fn::GetAtt': ['Wf', 'Arn']}):
            c, b, a, r = self.build(resource)
            with self.assertRaises(ValueError): c.validate_templates('workflows', b, a, r)


class TemplateTests(unittest.TestCase):
    def test_only_exact_previous_definitions_and_bindings(self):
        parts = json.loads((HERE / 'fixtures/ami-previous-bindings.json').read_text())
        template = {k: parts[k] for k in ('Parameters', 'Conditions', 'Rules')}
        self.assertEqual(TOOL.normalize_previous_template(template), {'Parameters': {}})
        self.assertEqual(parts['Bindings'], TOOL.previous_bindings())
        component = [{'ComponentArn': {'Ref': 'Component'}, 'Parameters': parts['Bindings']}]
        self.assertEqual(TOOL.normalize_components(component), [{'ComponentArn': {'Ref': 'Component'}, 'Parameters': []}])
        for section in ('Parameters', 'Conditions', 'Rules'):
            bad = copy.deepcopy(template)
            bad[section][next(iter(bad[section]))] = {'unreviewed': True}
            with self.assertRaises(ValueError):
                TOOL.normalize_previous_template(bad)
        bad = copy.deepcopy(component)
        bad[0]['Parameters'][0]['Value'] = ['unapproved-repository']
        with self.assertRaises(ValueError):
            TOOL.normalize_components(bad)

    def test_full_tuple_secret_update_under_real_lock(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'case'
            subprocess.run([sys.executable, str(HERE / 'fixture.py'), str(root), '{}'], check=True)
            old = release_record()
            old.update(amiId='ami-' + '1' * 17, lowerImageDigest='sha256:' + 'a' * 64, previousLowerImageDigest=None)
            new = release_record()
            for name, value in (('before', old), ('after', new)):
                (root / (name + '.json')).write_text(json.dumps({'settings': {'deployment': value}}))
            outer = {'keep': 'retained', TOOL.KEY: {TOOL.REGION: old, 'us-east-1': {'keep': True}}}
            (root / 'secret.json').write_text(json.dumps({'VersionId': 'initial', 'SecretString': json.dumps(outer)}))
            env = dict(os.environ, PATH=str(root / 'bin') + ':' + os.environ['PATH'])
            command = [sys.executable, str(root / 'checkout/deploy/aws/mum/json-tool.py'), 'secret-update']
            for before, after in (('before', 'after'), ('after', 'before')):
                result = subprocess.run(command + [str(root / (before + '.json')), str(root / (after + '.json'))], env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            restored = json.loads(json.loads((root / 'secret.json').read_text())['SecretString'])
            self.assertEqual(restored, outer)


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'case'
        subprocess.run([sys.executable, str(HERE / 'fixture.py'), str(self.root), '{}'], check=True)
        self.directory = self.root / 'release'; self.directory.mkdir()
        self.value = release_record()
        self.config = self.root / 'candidate-config.json'
        self.config.write_text(json.dumps({'settings': {'deployment': self.value, 'authorityOrigin': COMPUTER.ORIGIN}}))
        bake = {k: self.value[k] for k in RELEASE.BAKE_KEYS}
        build_arn = 'arn:aws:imagebuilder:ap-south-1:452630323510:image/ezil-host-mum/1.0.2/1'
        bindings = {'DesktopImageRef': self.value['lowerImageRef'], 'DesktopImageId': self.value['lowerImageDigest'],
            'PreviousDesktopImageRef': self.value['previousLowerImageRef'], 'PreviousDesktopImageId': self.value['previousLowerImageDigest'],
            'AgentSrcS3Uri': 's3://ezil-mum-deploy-assets-452630323510/ami/host-agent-' + self.value['agentCommit'] + '.tgz'}
        self.evidence = {
            'build': {'image': {'arn': build_arn, 'state': {'status': 'AVAILABLE'}, 'outputResources': {'amis': [{'region': TOOL.REGION, 'image': self.value['amiId']}]},
                'imageRecipe': {'name': 'ezil-host-mum', 'version': '1.0.2', 'components': [{'parameters': [{'name': k, 'value': [v]} for k, v in bindings.items()]}]}}},
            'image': {'Images': [{'ImageId': self.value['amiId'], 'OwnerId': TOOL.ACCOUNT, 'State': 'available', 'Architecture': 'x86_64', 'Public': False}]},
            'template': {'LaunchTemplateVersions': [{'LaunchTemplateId': self.value['launchTemplateId'], 'VersionNumber': 2, 'LaunchTemplateData': {'ImageId': self.value['amiId']}}]},
            'versions': {k: {'stateMachineVersions': [{'stateMachineVersionArn': self.value[k]}]} for k in RELEASE.VERSION_KEYS},
            'workflows': {k: {'stateMachineArn': self.value[k], 'type': 'STANDARD', 'status': 'ACTIVE'} for k in RELEASE.VERSION_KEYS},
        }
        self.plan = {'bake': bake, 'amiId': self.value['amiId'], 'buildArn': build_arn, 'configPath': str(self.config)}
        source = dict(self.value, amiId='ami-' + '1' * 17, lowerImageDigest=self.value['previousLowerImageDigest'], lowerImageRef=self.value['previousLowerImageRef'], previousLowerImageDigest=None, previousLowerImageRef=None)
        for name, data in [('bake-inputs.json', bake), ('image.json', self.evidence['image']), ('build.json', self.evidence['build']), ('previous-rebase-release.json', source), ('deployed-release.json', source)]:
            (self.directory / name).write_text(json.dumps(data))
        (self.directory / 'build-arn.txt').write_text(build_arn)
        (self.root / 'rebase-readbacks.json').write_text(json.dumps(self.evidence))
        identity = self.root / 'identity.json'
        identity.write_text(json.dumps({'accountId': TOOL.ACCOUNT, 'region': TOOL.REGION, 'namespace': 'mum'}))
        schema_dir = self.root / 'checkout/docs/aws-computers/sql'; schema_dir.mkdir(parents=True)
        shutil.copyfile(HERE / 'fixtures/0002_image_rebase.sql.txt', schema_dir / '0002_image_rebase.sql.txt')
        self.identity = identity
        envelope = {'VersionId': 'initial', 'SecretString': json.dumps({'EZIL_AWS_KILL_SWITCH':'1', TOOL.KEY:{TOOL.REGION:dict(source, releases=[source])}})}
        TOOL.write(self.root/'secret.json', envelope)
        self.ledger = self.root/'promotion-ledger.json'
        seed_ledger(self.ledger, envelope)
        self.env = dict(os.environ, PATH=str(self.root / 'bin') + ':' + os.environ['PATH'])

    def cli(self, *args, expected=0):
        result = subprocess.run(['bash', str(self.root / 'checkout/deploy/aws/mum/rebase-release.sh'), *args, '--ledger', str(self.ledger)], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_rebuild_previous_pair_through_parameters_and_bake_evidence(self):
        (self.root / 'rebase-readbacks.json').unlink()
        seed = self.root / 'seed'
        self.directory.rename(seed)
        source_path = seed / 'previous-rebase-release.json'
        source = manifest.read(source_path)
        source['lowerImageRef'] = TOOL.REPOSITORY + '@sha256:' + 'e' * 64
        source_path.write_text(json.dumps(source))
        deployed = dict(self.value, recipeVersion='1.0.5', amiId='ami-'+'5'*17)
        deployed_path=seed/'deployed-release.json';TOOL.write(deployed_path,deployed)
        outer = {TOOL.KEY: {TOOL.REGION: dict(deployed, releases=[source,deployed])}}
        (self.root / 'secret.json').write_text(json.dumps({'VersionId': 'initial', 'SecretString': json.dumps(outer)}))
        target = self.root / 'release'
        result = subprocess.run(['bash', str(self.root / 'checkout/deploy/aws/mum/rebuild-ami.sh'),
            '--desktop-image', 'desktop:test', '--source-sha', 'aaaaaaaa', '--recipe-version', '1.0.6',
            '--config', str(self.root / 'ami-config.json'), '--release-dir', str(target),
            '--previous-desktop-image-ref', source['lowerImageRef'], '--previous-desktop-image-id', source['lowerImageDigest'],
            '--previous-release', str(source_path), '--deployed-release', str(deployed_path), '--apply'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        params = {v['ParameterKey']: v for v in manifest.read(target / 'ami-parameters.json')}
        self.assertEqual(params['PreviousDesktopImageDigest']['ParameterValue'], 'sha256:' + 'e' * 64)
        self.assertEqual(params['PreviousDesktopImageId']['ParameterValue'], source['lowerImageDigest'])
        bake = manifest.read(target / 'bake-inputs.json')
        self.assertEqual(bake['lowerImageDigest'], 'sha256:' + 'b' * 64)
        self.assertEqual(bake['previousLowerImageDigest'], source['lowerImageDigest'])
        self.assertEqual(bake['previousLowerImageRef'], source['lowerImageRef'])
        self.assertEqual(bake['recipeVersion'],'1.0.6')
        self.assertEqual(manifest.read(target/'deployed-release.json'),deployed)
        self.assertEqual(manifest.read(target/'previous-rebase-release.json'),source)

    def test_deployed_must_match_promoted_secret_before_bake(self):
        envelope=manifest.read(self.root/'secret.json'); outer=manifest.loads(envelope['SecretString']); outer[TOOL.KEY][TOOL.REGION]['amiId']='ami-'+'9'*17; envelope['SecretString']=json.dumps(outer); TOOL.write(self.root/'secret.json',envelope)
        (self.root / 'rebase-readbacks.json').unlink()
        source = manifest.read(self.directory / 'previous-rebase-release.json')
        result = subprocess.run(['bash', str(self.root / 'checkout/deploy/aws/mum/rebuild-ami.sh'),
            '--desktop-image', 'desktop:test', '--source-sha', 'aaaaaaaa', '--recipe-version', '1.0.2',
            '--config', str(self.root / 'ami-config.json'), '--release-dir', str(self.root / 'new-bake'),
            '--previous-desktop-image-ref', source['lowerImageRef'], '--previous-desktop-image-id', source['lowerImageDigest'],
            '--previous-release', str(self.directory / 'previous-rebase-release.json'), '--deployed-release', str(self.directory / 'previous-rebase-release.json'), '--apply'], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertFalse(any('get-login-password' in call or 'push' in call for call in calls))
        self.assertNotIn('synthetic-private-do-not-print', result.stdout + result.stderr)

    def test_bake_refuses_unretained_predecessor_and_lower_ref_mismatch(self):
        (self.root/'rebase-readbacks.json').unlink()
        source=manifest.read(self.directory/'previous-rebase-release.json')
        for kind in ('retained','lower','ref'):
            envelope=manifest.read(self.root/'secret.json');outer=manifest.loads(envelope['SecretString'])
            outer[TOOL.KEY][TOOL.REGION]['releases']=[] if kind=='retained' else [source]
            envelope['SecretString']=json.dumps(outer);TOOL.write(self.root/'secret.json',envelope)
            args=['--desktop-image','desktop:test','--source-sha','aaaaaaaa','--recipe-version','1.0.6',
                  '--config',str(self.root/'ami-config.json'),'--release-dir',str(self.root/('bake-'+kind)),
                  '--previous-release',str(self.directory/'previous-rebase-release.json'),
                  '--deployed-release',str(self.directory/'deployed-release.json'),
                  '--previous-desktop-image-ref',source['lowerImageRef'] if kind!='ref' else TOOL.REPOSITORY+'@sha256:'+'f'*64,
                  '--previous-desktop-image-id',source['lowerImageDigest'] if kind!='lower' else 'sha256:'+'f'*64,'--apply']
            result=subprocess.run(['bash',str(self.root/'checkout/deploy/aws/mum/rebuild-ami.sh'),*args],env=self.env,capture_output=True,text=True)
            self.assertEqual(result.returncode,1,result.stdout+result.stderr)
            self.assertIn('secret operation refused' if kind=='retained' else 'lower mismatch',result.stdout+result.stderr)
        calls=[json.loads(line) for line in (self.root/'calls.jsonl').read_text().splitlines()]
        self.assertFalse(any('push' in c or 'execute-change-set' in c for c in calls))

    def test_finalize_actual_cli_refuses_missing_phase_receipts(self):
        self.cli('plan', '--release-dir', str(self.directory), '--config', str(self.config), '--identity-config', str(self.identity))
        plan = str(self.directory / 'rebase-plan.json')
        for flags in ([], ['--apply']):
            self.cli('finalize', '--plan', plan, *flags, expected=1)
        self.assertFalse((self.directory / 'rebase-release.json').exists())
        self.config.write_text(self.config.read_text() + ' ')
        self.cli('finalize', '--plan', plan, '--apply', expected=1)

    def test_final_readbacks_require_both_lowers_and_published_tuple(self):
        self.assertEqual(RELEASE.final_manifest(self.plan, self.evidence, self.value['createdAt']), self.value)
        for kind in ('previous', 'current', 'ami', 'template', 'unpublished', 'wrong-machine', 'pending', 'public'):
            bad = copy.deepcopy(self.evidence)
            if kind in ('previous', 'current'):
                index = 2 if kind == 'previous' else 1
                bad['build']['image']['imageRecipe']['components'][0]['parameters'][index]['value'] = ['incorrect']
            elif kind == 'ami': bad['image']['Images'][0]['OwnerId'] = '123456789012'
            elif kind == 'template': bad['template']['LaunchTemplateVersions'][0]['VersionNumber'] = True
            elif kind == 'unpublished': bad['versions']['preparationStateMachineVersionArn']['stateMachineVersions'] = []
            elif kind == 'wrong-machine': bad['workflows']['recoveryStateMachineVersionArn']['stateMachineArn'] = TOOL.MACHINE
            elif kind == 'pending': bad['build']['image']['state']['status'] = 'TESTING'
            elif kind == 'public': bad['image']['Images'][0]['Public'] = True
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                RELEASE.final_manifest(self.plan, bad)

    def test_missing_schema_or_foreign_identity_refuses_planning(self):
        self.identity.write_text(json.dumps({'accountId': '123456789012', 'region': TOOL.REGION, 'namespace': 'mum'}))
        self.cli('plan', '--release-dir', str(self.directory), '--config', str(self.config), '--identity-config', str(self.identity), expected=1)
        self.assertFalse((self.directory / 'rebase-plan.json').exists())

    def test_deployment_phases_require_complete_reviewed_plan(self):
        (self.directory / 'rebase-release.json').write_text(json.dumps(self.value))
        for operation in ('apply-schema', 'apply-identity', 'apply-workflows', 'apply-app', 'promote-canary'):
            self.cli(operation, '--manifest', str(self.directory / 'rebase-release.json'), '--apply', expected=1)
        calls = [json.loads(line) for line in (self.root / 'calls.jsonl').read_text().splitlines()]
        self.assertTrue(all('get-caller-identity' in call for call in calls))


class ComputerTests(unittest.TestCase):
    computer = '22222222-2222-4222-8222-222222222222'
    job = '11111111-1111-4111-8111-111111111111'
    secret = 'a' * 64

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.journal = Path(self.temp.name) / 'job.json'
        quiet = patch('sys.stdout', new_callable=io.StringIO); quiet.start(); self.addCleanup(quiet.stop)

    def reply(self, sent):
        return dict(schemaVersion=1, computerId=self.computer, jobId=self.job, phase='reserved', eligible=True, failureCode=None)

    def test_exact_request_order_hmac_and_response_validation(self):
        sent = COMPUTER.request('prepare', self.computer, None)
        self.assertEqual(list(sent), ['schemaVersion', 'operation', 'computerId', 'jobId'])
        body = json.dumps(sent, separators=(',', ':')).encode()
        headers = COMPUTER.headers(body, self.secret, 1792670400)
        import hashlib, hmac
        signing = b'ezil-lifecycle-authority-v1\nPOST\n/api/internal/computers/image-rebase\n1792670400\n' + hashlib.sha256(body).hexdigest().encode()
        self.assertEqual(headers['x-ezil-workflow-signature'], hmac.new(bytes.fromhex(self.secret), signing, hashlib.sha256).hexdigest())
        COMPUTER.response(self.reply(sent), sent)
        for key, value in [('schemaVersion', True), ('eligible', 1), ('extra', 1), ('phase', 'running'), ('failureCode', 'provider error'), ('computerId', self.job)]:
            with self.assertRaises(ValueError):
                COMPUTER.response(dict(self.reply(sent), **{key: value}), sent)

    def test_dry_run_never_submits_or_creates_journal(self):
        calls = []
        COMPUTER.operate('prepare', self.computer, None, self.journal, False, '', lambda *args: calls.append(args))
        self.assertEqual(calls, []); self.assertFalse(self.journal.exists())

    def test_prepare_launch_resume_use_exact_job_and_durable_pending(self):
        calls = []
        def sender(sent, secret):
            self.assertEqual(secret, self.secret)
            self.assertEqual(manifest.read(self.journal)['pending'], sent)
            calls.append(sent.copy())
            return 202, self.reply(sent)
        COMPUTER.operate('prepare', self.computer, None, self.journal, True, self.secret, sender)
        COMPUTER.operate('prepare', self.computer, None, self.journal, True, self.secret, sender)
        COMPUTER.operate('launch', self.computer, None, self.journal, True, self.secret, sender)
        self.assertEqual([v['jobId'] for v in calls], [None, self.job, self.job])
        self.assertNotIn(self.secret, self.journal.read_text())

    def test_lost_prepare_reconciles_before_retry_and_keeps_uncertainty(self):
        def lost(*_): raise TimeoutError()
        with self.assertRaises(TimeoutError):
            COMPUTER.operate('prepare', self.computer, None, self.journal, True, self.secret, lost)
        def absent(sent, _):
            self.assertEqual(sent['operation'], 'plan')
            return 200, dict(self.reply(sent), jobId=None, phase=None)
        with self.assertRaises(ValueError):
            COMPUTER.operate('prepare', self.computer, None, self.journal, True, self.secret, absent)
        self.assertIsNotNone(manifest.read(self.journal)['pending'])
        calls = []
        def found(sent, _):
            calls.append(sent.copy()); return 200, self.reply(sent)
        COMPUTER.operate('prepare', self.computer, None, self.journal, True, self.secret, found)
        self.assertEqual([v['operation'] for v in calls], ['plan', 'prepare'])
        self.assertEqual(calls[1]['jobId'], self.job)

    def test_recover_requires_exact_job_and_uses_null_computer(self):
        with self.assertRaises(ValueError): COMPUTER.request('recover', None, None)
        calls = []
        def sender(sent, _): calls.append(sent); return 202, self.reply(sent)
        COMPUTER.operate('recover', None, self.job, self.journal, True, self.secret, sender)
        COMPUTER.operate('recover', None, self.job, self.journal, True, self.secret, sender)
        self.assertTrue(all(v['computerId'] is None and v['jobId'] == self.job for v in calls))

    def test_staging_origin_refuses_btgq_and_curomaa_without_http(self):
        for origin in ('https://btgq.supabase.co', 'https://curomaa.example.com', 'https://os.ezil.work', COMPUTER.ORIGIN + '/extra'):
            with patch.object(sys, 'argv', ['rebase_computer.py', 'plan', '--computer', self.computer, '--origin', origin]), self.assertRaises(ValueError):
                COMPUTER.main()


if __name__ == '__main__':
    unittest.main(verbosity=2)
