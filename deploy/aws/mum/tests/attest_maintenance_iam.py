#!/usr/bin/env python3
"""Offline cases for the R5 maintenance role/profile plan and read-back verifiers.

No AWS, credentials or network: every input is a synthetic CLI JSON fixture. Each
refusal case starts from a fixture set that passes, changes one thing, and asserts
the specific refusal, so an all-refusing verifier cannot pass.
"""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import attest_maintenance_iam as m

STACK_ID = f'arn:aws:cloudformation:{m.REGION}:{m.ACCOUNT}:stack/{m.STACK}/11111111-2222-4333-8444-555555555555'
ROLE_ID, PROFILE_ID = 'AROAEXAMPLEEXAMPLE0001', 'AIPAEXAMPLEEXAMPLE0001'
INSTANCE = 'i-0123456789abcdef0'
TEMPLATE = m.load_template()
ROLE_PROPS = TEMPLATE['Resources']['MaintenanceRole']['Properties']
TRUST = ROLE_PROPS['AssumeRolePolicyDocument']
POLICY = ROLE_PROPS['Policies'][0]['PolicyDocument']


def changeset_fixture():
    return {
        'changeset.json': {
            'StackName': m.STACK, 'StackId': STACK_ID, 'ChangeSetName': m.render_plan()['changeSet'],
            'ChangeSetId': f'arn:aws:cloudformation:{m.REGION}:{m.ACCOUNT}:changeSet/{m.render_plan()["changeSet"]}/x',
            'Status': 'CREATE_COMPLETE', 'ExecutionStatus': 'AVAILABLE', 'Capabilities': ['CAPABILITY_NAMED_IAM'],
            'Changes': [{'Type': 'Resource', 'ResourceChange': {'Action': 'Add', 'LogicalResourceId': k, 'ResourceType': v, 'Scope': [], 'Details': []}}
                        for k, v in sorted(m.RESOURCES.items())]},
        'submitted.json': {'TemplateBody': copy.deepcopy(TEMPLATE), 'StagesAvailable': ['Original', 'Processed']},
        'stack.json': {'Stacks': [{'StackName': m.STACK, 'StackId': STACK_ID, 'StackStatus': 'REVIEW_IN_PROGRESS'}]},
    }


def readback_fixture():
    role_ref = {'RoleName': m.NAME, 'Path': m.PATH, 'Arn': m.ROLE_ARN, 'RoleId': ROLE_ID}
    profile = {'InstanceProfileName': m.NAME, 'Path': m.PATH, 'Arn': m.PROFILE_ARN, 'InstanceProfileId': PROFILE_ID, 'Roles': [dict(role_ref)]}
    return {
        'stack.json': {'Stacks': [{'StackName': m.STACK, 'StackId': STACK_ID, 'StackStatus': 'CREATE_COMPLETE', 'Capabilities': ['CAPABILITY_NAMED_IAM'],
                                   'Outputs': [{'OutputKey': 'InstanceProfileArn', 'OutputValue': m.PROFILE_ARN},
                                               {'OutputKey': 'RoleArn', 'OutputValue': m.ROLE_ARN}]}]},
        'resources.json': {'StackResources': [{'LogicalResourceId': k, 'ResourceType': v, 'PhysicalResourceId': m.NAME, 'ResourceStatus': 'CREATE_COMPLETE'}
                                              for k, v in m.RESOURCES.items()]},
        'drifts.json': {'StackResourceDrifts': [{'LogicalResourceId': k, 'StackResourceDriftStatus': 'IN_SYNC'} for k in m.RESOURCES]},
        'role.json': {'Role': {**role_ref, 'AssumeRolePolicyDocument': copy.deepcopy(TRUST), 'MaxSessionDuration': 3600,
                               'Description': ROLE_PROPS['Description'], 'Tags': copy.deepcopy(ROLE_PROPS['Tags'])}},
        'role-policies.json': {'PolicyNames': [m.POLICY_NAME]},
        'role-policy.json': {'RoleName': m.NAME, 'PolicyName': m.POLICY_NAME, 'PolicyDocument': copy.deepcopy(POLICY)},
        'attached.json': {'AttachedPolicies': []},
        'profile.json': {'InstanceProfile': profile},
        'profiles-for-role.json': {'InstanceProfiles': [copy.deepcopy(profile)]},
    }


def reservations(*ids, profile=True):
    return {'Reservations': [{'Instances': [{'InstanceId': i, **({'IamInstanceProfile': {'Arn': m.PROFILE_ARN, 'Id': PROFILE_ID}} if profile else {})}]}
                             for i in ids]}


def prelaunch_fixture():
    return {'associations.json': {'Associations': []}, 'profile-fleet.json': {'Reservations': []}}


def host_fixture(version='3.3.1802.0'):
    return {
        'associations.json': {'Associations': []},
        'instance.json': reservations(INSTANCE),
        'profile-fleet.json': reservations(INSTANCE),
        'instance-information.json': {'InstanceInformationList': [{'InstanceId': INSTANCE, 'ResourceType': 'EC2Instance',
                                                                   'PingStatus': 'Online', 'AgentVersion': version}]},
        'effective-associations.json': {'Associations': []},
    }


def statement(sid):
    return next(s for s in POLICY['Statement'] if s['Sid'] == sid)


class Case(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        self.pin = m.plan_sha256()

    def write(self, files):
        for name, value in files.items():
            (self.dir / name).write_text(value if isinstance(value, str) else json.dumps(value))

    def run_kind(self, kind, files):
        self.write(files)
        if kind == 'changeset':
            return m.verify_changeset(self.dir, self.pin)
        if kind == 'readback':
            return m.verify_readback(self.dir, self.pin)
        if kind == 'prelaunch':
            return m.verify_prelaunch(self.dir)
        return m.verify_host(self.dir, INSTANCE, PROFILE_ID)

    def refuse(self, kind, mutate, message):
        good = {'changeset': changeset_fixture, 'readback': readback_fixture, 'host': host_fixture, 'prelaunch': prelaunch_fixture}[kind]()
        self.assertTrue(self.run_kind(kind, good)['verified'])  # the base fixture passes
        bad = copy.deepcopy(good)
        mutate(bad)
        with self.assertRaises(ValueError) as caught:
            self.run_kind(kind, bad)
        self.assertIn(message, str(caught.exception))


class TemplateTests(unittest.TestCase):
    def test_committed_template_matches_pin(self):
        self.assertEqual(m.sha((m.REPO / m.TEMPLATE).read_bytes()), m.TEMPLATE_SHA256)

    def test_template_byte_drift_refused(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 't.json'
            path.write_bytes((m.REPO / m.TEMPLATE).read_bytes().replace(b'3600', b'3601'))
            with self.assertRaisesRegex(ValueError, 'template bytes differ'):
                m.load_template(path)

    def template_refuses(self, mutate, message):
        t = copy.deepcopy(TEMPLATE)
        m.check_template(copy.deepcopy(t))
        mutate(t)
        with self.assertRaises(ValueError) as caught:
            m.check_template(t)
        self.assertIn(message, str(caught.exception))

    def test_template_mutations(self):
        role = lambda t: t['Resources']['MaintenanceRole']['Properties']
        pol = lambda t: role(t)['Policies'][0]['PolicyDocument']['Statement']
        cases = [
            (lambda t: role(t).update(ManagedPolicyArns=['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']), 'unexpected role property'),
            (lambda t: role(t).update(PermissionsBoundary='arn:aws:iam::452630323510:policy/x'), 'unexpected role property'),
            (lambda t: t.update(Parameters={'Account': {'Type': 'String'}}), 'unexpected template section'),
            (lambda t: t['Resources'].update(Extra={'Type': 'AWS::IAM::Policy'}), 'exactly the role and the instance profile'),
            (lambda t: t['Resources']['MaintenanceInstanceProfile']['Properties'].update(Roles=[{'Ref': 'Other'}]), 'instance profile binding mismatch'),
            (lambda t: t['Resources']['MaintenanceRole'].update(DeletionPolicy='Retain'), 'unexpected resource attribute'),
            (lambda t: role(t).update(RoleName='ezil-mum-maintenance'), 'role name/path mismatch'),
            (lambda t: role(t).update(Path='/ezil/mum/'), 'role name/path mismatch'),
            (lambda t: role(t)['Tags'][2].update(Value='pilot'), 'role tags mismatch'),
            (lambda t: pol(t)[0].update(Resource='arn:aws:ec2:ap-south-1:111111111111:instance/*'), 'resource outside pinned account/region/type'),
            (lambda t: pol(t)[0].update(Resource='arn:aws:ec2:us-east-1:452630323510:instance/*'), 'resource outside pinned account/region/type'),
            (lambda t: pol(t)[1].update(Condition={'StringEquals': {'aws:RequestedRegion': 'us-east-1'}}), 'aws:RequestedRegion ap-south-1 condition required'),
            (lambda t: role(t)['Policies'].append({'PolicyName': 'extra', 'PolicyDocument': {}}), 'exactly one inline policy required'),
            (lambda t: t['Outputs'].pop('RoleArn'), 'unexpected outputs'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.template_refuses(mutate, message)


class PolicyTests(unittest.TestCase):
    def policy_refuses(self, mutate, message, check=m.check_policy, base=POLICY):
        doc = copy.deepcopy(base)
        check(copy.deepcopy(doc))
        mutate(doc)
        with self.assertRaises(ValueError) as caught:
            check(doc)
        self.assertIn(message, str(caught.exception))

    def test_reorder_and_action_case_are_canonical(self):
        doc = copy.deepcopy(POLICY)
        doc['Statement'].reverse()
        doc['Statement'][1]['Action'] = [a.upper() for a in reversed(doc['Statement'][1]['Action'])]
        m.check_policy(doc)

    def test_policy_mutations(self):
        st = lambda d, sid: next(s for s in d['Statement'] if s['Sid'] == sid)
        cases = [
            (lambda d: st(d, 'AgentChannels')['Action'].append('ssm:SendCommand'), 'unexpected IAM action'),
            (lambda d: st(d, 'AgentChannels')['Action'].append('ssm:StartSession'), 'unexpected IAM action'),
            (lambda d: st(d, 'AgentChannels')['Action'].append('ec2messages:GetMessages'), 'unexpected IAM action'),
            (lambda d: st(d, 'AgentChannels')['Action'].append('ssm:GetParameters'), 'unexpected IAM action'),
            (lambda d: st(d, 'AgentChannels')['Action'].append('secretsmanager:GetSecretValue'), 'unexpected IAM action'),
            (lambda d: st(d, 'AgentChannels')['Action'].append('ssmmessages:*'), 'unexpected IAM action'),
            (lambda d: d['Statement'].append({'Effect': 'Allow', 'Action': 's3:GetObject', 'Resource': '*', 'Condition': m.REGION_ONLY}), 'unexpected IAM action'),
            (lambda d: st(d, 'AgentRegistration').update(Resource='*'), 'wildcard resource on a resource-scopable action'),
            (lambda d: st(d, 'AgentDataChannel').update(Resource='*'), 'wildcard resource on a resource-scopable action'),
            (lambda d: st(d, 'AgentRegistration').update(Resource='arn:aws:ssm:ap-south-1:452630323510:managed-instance/*'), 'resource outside pinned account/region/type'),
            (lambda d: st(d, 'AgentChannels').pop('Condition'), 'aws:RequestedRegion ap-south-1 condition required'),
            (lambda d: st(d, 'AgentChannels')['Action'].remove('ssmmessages:OpenControlChannel'), 'required agent action missing'),
            (lambda d: st(d, 'AgentChannels').update(Effect='Deny'), 'policy statement shape refused'),
            (lambda d: st(d, 'AgentChannels').update(NotAction='iam:*'), 'policy statement shape refused'),
            (lambda d: st(d, 'AgentChannels').update(Principal='*'), 'policy statement shape refused'),
            (lambda d: st(d, 'AgentChannels').update(Sid='Renamed'), 'policy differs from reviewed document'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.policy_refuses(mutate, message)

    def test_trust_mutations(self):
        s0 = lambda d: d['Statement'][0]
        cases = [
            (lambda d: s0(d).update(Principal={'AWS': '*'}), 'trust principal must be exactly ec2.amazonaws.com'),
            (lambda d: s0(d).update(Principal='*'), 'trust principal must be exactly ec2.amazonaws.com'),
            (lambda d: s0(d).update(Principal={'Service': ['ec2.amazonaws.com', 'ssm.amazonaws.com']}), 'trust principal must be exactly ec2.amazonaws.com'),
            (lambda d: s0(d).update(Principal={'AWS': 'arn:aws:iam::452630323510:root'}), 'trust principal must be exactly ec2.amazonaws.com'),
            (lambda d: s0(d).update(Action='sts:*'), 'trust action must be sts:AssumeRole'),
            (lambda d: s0(d).update(Action=['sts:AssumeRole', 'sts:TagSession']), 'trust action must be sts:AssumeRole'),
            (lambda d: s0(d).update(Condition={'StringEquals': {'aws:SourceAccount': m.ACCOUNT}}), 'trust condition or extra field refused'),
            (lambda d: d['Statement'].append(copy.deepcopy(s0(d))), 'trust must be exactly one statement'),
            (lambda d: s0(d).update(Sid='Renamed'), 'trust differs from reviewed document'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.policy_refuses(mutate, message, m.check_trust, TRUST)


class ChangeSetTests(Case):
    def test_changeset_mutations(self):
        cs = lambda f: f['changeset.json']
        rc = lambda f, i=0: cs(f)['Changes'][i]['ResourceChange']
        cases = [
            (lambda f: rc(f).update(Action='Modify'), 'non-Add change refused'),
            (lambda f: rc(f).update(Action='Import'), 'non-Add change refused'),
            (lambda f: rc(f, 1).update(Action='Remove'), 'non-Add change refused'),
            (lambda f: rc(f).update(Replacement='True'), 'change touches an existing resource'),
            (lambda f: rc(f).update(PhysicalResourceId=m.NAME), 'change touches an existing resource'),
            (lambda f: cs(f)['Changes'].append(copy.deepcopy(cs(f)['Changes'][0])), 'change set must have exactly two changes'),
            (lambda f: cs(f)['Changes'].pop(), 'change set must have exactly two changes'),
            (lambda f: rc(f).update(ResourceType='AWS::IAM::ManagedPolicy'), 'unexpected change-set resource'),
            (lambda f: rc(f).update(LogicalResourceId='OtherRole'), 'unexpected change-set resource'),
            (lambda f: cs(f).update(RoleARN='arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec'), 'change set options differ'),
            (lambda f: cs(f).update(Parameters=[{'ParameterKey': 'A', 'ParameterValue': 'b'}]), 'change set options differ'),
            (lambda f: cs(f).update(Tags=[{'Key': 'k', 'Value': 'v'}]), 'change set options differ'),
            (lambda f: cs(f).update(ImportExistingResources=True), 'change set options differ'),
            (lambda f: cs(f).update(Capabilities=['CAPABILITY_IAM']), 'change set options differ'),
            (lambda f: cs(f).update(NextToken='more'), 'incomplete paginated read'),
            (lambda f: cs(f).update(StackId=STACK_ID.replace(m.ACCOUNT, '111111111111')), 'change set targets another stack/account/region'),
            (lambda f: cs(f).update(StackId=STACK_ID.replace(m.REGION, 'us-east-1')), 'change set targets another stack/account/region'),
            (lambda f: cs(f).update(StackName='ezil-mum-foundation'), 'change set targets another stack/account/region'),
            (lambda f: cs(f).update(ChangeSetName='other'), 'change set targets another stack/account/region'),
            (lambda f: cs(f).update(Status='FAILED'), 'change set not ready'),
            (lambda f: f['submitted.json']['TemplateBody']['Resources']['MaintenanceRole']['Properties'].update(
                ManagedPolicyArns=['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']), 'submitted template differs'),
            (lambda f: f['stack.json']['Stacks'][0].update(StackStatus='UPDATE_COMPLETE'), 'stack must be new'),
            (lambda f: f['stack.json']['Stacks'][0].update(RoleARN='arn:aws:iam::452630323510:role/x'), 'stack must be new'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.refuse('changeset', mutate, message)

    def test_submitted_template_string_accepted(self):
        files = changeset_fixture()
        files['submitted.json']['TemplateBody'] = (m.REPO / m.TEMPLATE).read_text()
        self.assertEqual(self.run_kind('changeset', files)['actions'], ['Add MaintenanceInstanceProfile', 'Add MaintenanceRole'])

    def test_stale_plan_refused(self):
        self.write(changeset_fixture())
        with self.assertRaisesRegex(ValueError, 'stale plan'):
            m.verify_changeset(self.dir, '0' * 64)


class ReadbackTests(Case):
    def test_readback_mutations(self):
        role = lambda f: f['role.json']['Role']
        doc = lambda f: f['role-policy.json']['PolicyDocument']
        prof = lambda f: f['profile.json']['InstanceProfile']
        cases = [
            (lambda f: f['attached.json']['AttachedPolicies'].append(
                {'PolicyName': 'AmazonSSMManagedInstanceCore', 'PolicyArn': 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'}), 'managed policy attached'),
            (lambda f: f['attached.json'].update(IsTruncated=True), 'incomplete paginated read'),
            (lambda f: role(f).update(PermissionsBoundary={'PermissionsBoundaryArn': 'arn:aws:iam::452630323510:policy/b'}), 'permissions boundary present'),
            (lambda f: f['role-policies.json']['PolicyNames'].append('extra'), 'unexpected inline policy set'),
            (lambda f: doc(f)['Statement'][1]['Action'].append('ssm:SendCommand'), 'unexpected IAM action'),
            (lambda f: role(f)['AssumeRolePolicyDocument']['Statement'][0].update(Principal={'AWS': '*'}), 'trust principal must be exactly ec2.amazonaws.com'),
            (lambda f: role(f).update(Path='/ezil/mum/'), 'role identity mismatch'),
            (lambda f: role(f).update(Arn=m.ROLE_ARN.replace(m.ACCOUNT, '111111111111')), 'role identity mismatch'),
            (lambda f: role(f)['Tags'][2].update(Value='pilot'), 'role settings/tags drifted'),
            (lambda f: role(f)['Tags'].append({'Key': 'aws:cloudformation:stack-name', 'Value': 'ezil-mum-foundation'}), 'role tagged by another stack'),
            (lambda f: prof(f)['Roles'][0].update(RoleId='AROAEXAMPLEEXAMPLE0002'), 'instance profile must hold exactly this role'),
            (lambda f: prof(f)['Roles'].append({'RoleId': 'AROAEXAMPLEEXAMPLE0003', 'Arn': 'arn:aws:iam::452630323510:role/other'}), 'instance profile must hold exactly this role'),
            (lambda f: prof(f).update(Arn=m.PROFILE_ARN.replace('/ezil/r5-attestation/', '/ezil/mum/')), 'instance profile identity mismatch'),
            (lambda f: f['profiles-for-role.json']['InstanceProfiles'].append(
                {'Arn': f'arn:aws:iam::{m.ACCOUNT}:instance-profile/other', 'InstanceProfileId': 'AIPAEXAMPLEEXAMPLE0009'}), 'role bound to another instance profile'),
            (lambda f: f['drifts.json']['StackResourceDrifts'][1].update(StackResourceDriftStatus='MODIFIED'), 'stack drift detected or unread'),
            (lambda f: f['drifts.json']['StackResourceDrifts'].pop(), 'stack drift detected or unread'),
            (lambda f: f['stack.json']['Stacks'][0]['Outputs'][0].update(OutputValue='arn:aws:iam::452630323510:instance-profile/other'), 'stack outputs differ'),
            (lambda f: f['stack.json']['Stacks'][0].update(RoleARN='arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec'), 'stack not created as planned'),
            (lambda f: f['resources.json']['StackResources'].append(
                {'LogicalResourceId': 'X', 'ResourceType': 'AWS::IAM::Policy', 'PhysicalResourceId': 'x', 'ResourceStatus': 'CREATE_COMPLETE'}), 'stack resources differ'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.refuse('readback', mutate, message)

    def test_profile_drift_not_checked_tolerated_with_exact_binding(self):
        files = readback_fixture()
        for x in files['drifts.json']['StackResourceDrifts']:
            if x['LogicalResourceId'] == 'MaintenanceInstanceProfile':
                x['StackResourceDriftStatus'] = 'NOT_CHECKED'
        receipt = self.run_kind('readback', files)
        self.assertEqual((receipt['managedPolicies'], receipt['boundary'], receipt['policySha256']), (0, None, m.POLICY_SHA256))

    def test_role_drift_not_checked_refused(self):
        def mutate(f):
            for x in f['drifts.json']['StackResourceDrifts']:
                if x['LogicalResourceId'] == 'MaintenanceRole':
                    x['StackResourceDriftStatus'] = 'NOT_CHECKED'
        self.refuse('readback', mutate, 'stack drift detected or unread')


class HostTests(Case):
    def test_host_mutations(self):
        info = lambda f: f['instance-information.json']['InstanceInformationList']
        cases = [
            (lambda f: info(f)[0].update(AgentVersion='3.3.39.9'), 'SSM Agent older than 3.3.40.0'),
            (lambda f: info(f)[0].update(AgentVersion='3.2.2303.0'), 'SSM Agent older than 3.3.40.0'),
            (lambda f: info(f)[0].update(AgentVersion='unknown'), 'SSM Agent older than 3.3.40.0'),
            (lambda f: info(f)[0].update(PingStatus='ConnectionLost'), 'agent not Online'),
            (lambda f: info(f).append(copy.deepcopy(info(f)[0])), 'host not registered exactly once'),
            (lambda f: info(f)[0].update(InstanceId='i-0fedcba9876543210'), 'host not registered exactly once'),
            (lambda f: f['associations.json']['Associations'].append({'Name': 'AWS-GatherSoftwareInventory', 'Targets': [{'Key': 'InstanceIds', 'Values': ['*']}]}),
             'State Manager associations exist'),
            (lambda f: f['effective-associations.json']['Associations'].append({'AssociationId': 'a'}), 'effective association targets the host'),
            (lambda f: f['instance-information.json'].update(NextToken='more'), 'incomplete paginated read'),
            (lambda f: f.update({'instance.json': reservations(INSTANCE, profile=False)}), 'host does not carry exactly the qualified profile'),
            (lambda f: f['instance.json']['Reservations'][0]['Instances'][0]['IamInstanceProfile'].update(
                Arn='arn:aws:iam::452630323510:instance-profile/ezil/identity/ezil-mum-build'), 'host does not carry exactly the qualified profile'),
            (lambda f: f['instance.json']['Reservations'][0]['Instances'][0]['IamInstanceProfile'].update(Id='AIPAEXAMPLEEXAMPLE0002'),
             'host does not carry exactly the qualified profile'),
            (lambda f: f.update({'instance.json': reservations(INSTANCE, 'i-0fedcba9876543210')}), 'instance read must name exactly the host'),
            (lambda f: f.update({'profile-fleet.json': reservations(INSTANCE, 'i-0fedcba9876543210')}), 'maintenance profile is on another live instance'),
            (lambda f: f.update({'profile-fleet.json': {'Reservations': []}}), 'maintenance profile is on another live instance'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.refuse('host', mutate, message)

    def test_minimum_agent_boundary_accepted(self):
        self.assertEqual(self.run_kind('host', host_fixture('3.3.40.0'))['agentVersion'], '3.3.40.0')

    def test_invalid_instance_and_profile_ids_refused(self):
        self.write(host_fixture())
        with self.assertRaisesRegex(ValueError, 'invalid instance id'):
            m.verify_host(self.dir, 'i-123', PROFILE_ID)
        with self.assertRaisesRegex(ValueError, 'invalid instance profile id'):
            m.verify_host(self.dir, INSTANCE, m.PROFILE_ARN)

    def test_prelaunch_mutations(self):
        cases = [
            (lambda f: f.update({'profile-fleet.json': reservations('i-0fedcba9876543210')}), 'a live instance already carries the maintenance profile'),
            (lambda f: f['associations.json']['Associations'].append({'Name': 'AWS-UpdateSSMAgent'}), 'State Manager associations exist'),
            (lambda f: f['profile-fleet.json'].update(NextToken='more'), 'incomplete paginated read'),
        ]
        for mutate, message in cases:
            with self.subTest(message=message):
                self.refuse('prelaunch', mutate, message)


class PlanTests(unittest.TestCase):
    def all_argv(self):
        for step in m.render_plan()['steps']:
            yield from step['argv']
            yield from step.get('saves', {}).values()

    def test_plan_is_deterministic(self):
        self.assertEqual(m.render_plan(), m.render_plan())
        self.assertEqual(m.plan_sha256(), m.sha(m.canonical(m.render_plan())))
        self.assertNotIn('/root', json.dumps(m.render_plan()))

    def test_plan_commands_are_bounded(self):
        allowed_ssm = {'list-associations', 'describe-instance-information', 'describe-effective-instance-associations'}
        for argv in self.all_argv():
            text = ' '.join(argv)
            for forbidden in ('send-command', 'start-session', 'create-association', 'run-instances', 'put-role-policy', 'attach-role-policy',
                              'update-assume-role-policy', 'add-role-to-instance-profile', '--role-arn', '--import-existing-resources',
                              '--parameters', '--tags', 'ec2messages', 'update-stack', 'delete-stack', 'associate-iam-instance-profile'):
                self.assertNotIn(forbidden, text)
            if argv[0] == 'aws':
                self.assertEqual(argv[1:7], ['--profile', 'ezil-admin', '--region', 'ap-south-1', '--no-cli-pager', argv[6]])
                self.assertIn(argv[6], {'sts', 'iam', 'cloudformation', 'ssm', 'ec2'})
                if argv[6] == 'ssm':
                    self.assertIn(argv[7], allowed_ssm)
                if argv[6] == 'ec2':
                    self.assertEqual(argv[7], 'describe-instances')
            else:
                self.assertEqual(argv[:2], ['python3', 'deploy/aws/mum/attest_maintenance_iam.py'])

    def test_create_change_set_is_add_only_create(self):
        create = next(a for a in self.all_argv() if 'create-change-set' in a)
        self.assertEqual(create[create.index('--change-set-type') + 1], 'CREATE')
        self.assertEqual(create[create.index('--capabilities') + 1], 'CAPABILITY_NAMED_IAM')
        self.assertEqual(create[create.index('--template-body') + 1], 'file://' + m.TEMPLATE)

    def test_module_has_no_cloud_or_process_client(self):
        source = Path(m.__file__).read_text()
        for forbidden in ('import subprocess', 'import boto', 'import urllib', 'import socket', 'os.system', 'import http'):
            self.assertNotIn(forbidden, source)

    def test_cli_plan_and_refusal_exit_codes(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(m.main(['plan']), 0)
            self.assertEqual(json.loads(out.getvalue())['planSha256'], m.plan_sha256())
            with tempfile.TemporaryDirectory() as d:
                self.assertEqual(m.main(['verify-readback', '--dir', d, '--plan-sha256', m.plan_sha256()]), 2)
        self.assertIn('REFUSE:', err.getvalue())


if __name__ == '__main__':
    unittest.main()
