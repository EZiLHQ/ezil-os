"""Plan and verify the R5-exception maintenance role and instance profile for lower attestation.

Source only: this module makes no AWS call and runs no command. `plan` renders the
pinned template's hashes and the exact AWS CLI argv for Root; `verify-changeset`,
`verify-readback`, `verify-prelaunch` and `verify-host` check the JSON that Root's
commands saved.
Targets are fixed constants (no account/region/name overrides).

The profile is for a FRESH lower-attestation maintenance host only, attached by the
operator's RunInstances after reservation. The lower-attestation verifier does NOT pin
the instance profile: CloudTrail `requestParameters.iamInstanceProfile` passes through
unread. This contract and Root's launch gate are the only control.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

import rebase_cloudformation as cfn
import rebase_manifest as manifest

need = manifest.need
ACCOUNT, REGION, NAMESPACE, PROFILE = '452630323510', 'ap-south-1', 'mum', 'ezil-admin'
# Outside the deploy role's stack/ezil-<ns>-* scope (identity.ts stackPrefix).
STACK = 'attest-maintenance-iam-mum'
NAME = 'ezil-attest-maintenance-host'  # role and instance profile
# Outside role/ezil/<ns>/* (workloadRoles: exec/deploy write and PassRole scope) and /ezil/identity/;
# a namespace cannot contain '-', so no namespace's workload path can equal it.
PATH = '/ezil/r5-attestation/'
ROLE_ARN = f'arn:aws:iam::{ACCOUNT}:role{PATH}{NAME}'
PROFILE_ARN = f'arn:aws:iam::{ACCOUNT}:instance-profile{PATH}{NAME}'
POLICY_NAME = 'ssm-agent-channels-only'
TEMPLATE = 'deploy/aws/mum/attest-maintenance-iam.template.json'
REPO = Path(__file__).resolve().parents[3]
TEMPLATE_SHA256 = 'dd47706621fab6c80630d647d76660bcb62b414d504825c7f3745b35e420b570'
TRUST_SHA256 = '8c2f34a1e287584995c9092bb178b4f2b16db8803602822a6065d0f1d0c6259f'
POLICY_SHA256 = '8d8908397ef48da65e951b2a58886f962d10934fe9ac3be46c008daea92b1073'
RESOURCES = {'MaintenanceInstanceProfile': 'AWS::IAM::InstanceProfile', 'MaintenanceRole': 'AWS::IAM::Role'}
TAGS = {'ezil:purpose': 'attest-maintenance-host', 'ezil:exception': 'r5-fresh-attestation-host-only',
        'ezil:attestation-namespace': NAMESPACE}
REGION_ONLY = {'StringEquals': {'aws:RequestedRegion': REGION}}
# AWS service reference (v1): these name no resource type, so '*' is the only possible Resource.
UNSCOPED = {'ssmmessages:createcontrolchannel', 'ssmmessages:createdatachannel', 'ssmmessages:opencontrolchannel'}
SCOPED = {'ssm:updateinstanceinformation': f'arn:aws:ec2:{REGION}:{ACCOUNT}:instance/*',
          'ssmmessages:opendatachannel': f'arn:aws:ssm:{REGION}:{ACCOUNT}:session/*'}
ACTIONS = UNSCOPED | set(SCOPED)
# First SSM Agent that takes Run Command over ssmmessages; older agents need ec2messages (not granted).
MIN_AGENT = (3, 3, 40, 0)
LIVE = ('pending', 'running', 'shutting-down', 'stopping', 'stopped')  # every state but terminated
STACK_ARN = re.compile(rf'arn:aws:cloudformation:{REGION}:{ACCOUNT}:stack/{STACK}/[0-9a-f-]{{36}}')
LIMIT = 1 << 20


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def as_list(value):
    value = [value] if isinstance(value, str) else value
    need(isinstance(value, list) and value and all(isinstance(v, str) for v in value), 'invalid policy element')
    return value


def doc_sha(doc):
    """Statement order and action case/order do not matter; every other byte of meaning does."""
    need(isinstance(doc, dict) and set(doc) == {'Version', 'Statement'} and isinstance(doc['Statement'], list)
         and all(isinstance(s, dict) for s in doc['Statement']), 'invalid policy document')
    return sha(canonical({'Version': doc['Version'], 'Statement': sorted(cfn.statement_key(s) for s in doc['Statement'])}))


def check_trust(doc):
    need(isinstance(doc, dict) and doc.get('Version') == '2012-10-17' and isinstance(doc.get('Statement'), list)
         and len(doc['Statement']) == 1 and isinstance(doc['Statement'][0], dict), 'trust must be exactly one statement')
    s = doc['Statement'][0]
    need(set(s) <= {'Sid', 'Effect', 'Principal', 'Action'}, 'trust condition or extra field refused')
    need(s.get('Effect') == 'Allow' and s.get('Principal') == {'Service': 'ec2.amazonaws.com'},
         'trust principal must be exactly ec2.amazonaws.com')
    need([a.casefold() for a in as_list(s.get('Action'))] == ['sts:assumerole'], 'trust action must be sts:AssumeRole')
    need(doc_sha(doc) == TRUST_SHA256, 'trust differs from reviewed document')


def check_policy(doc):
    need(isinstance(doc, dict) and doc.get('Version') == '2012-10-17' and isinstance(doc.get('Statement'), list),
         'invalid policy document')
    seen = set()
    for s in doc['Statement']:
        need(isinstance(s, dict) and set(s) <= {'Sid', 'Effect', 'Action', 'Resource', 'Condition'} and s.get('Effect') == 'Allow',
             'policy statement shape refused (Deny/NotAction/NotResource/Principal)')
        actions = {a.casefold() for a in as_list(s.get('Action'))}
        need(actions <= ACTIONS, 'unexpected IAM action')
        for resource in as_list(s.get('Resource')):
            if resource == '*':
                need(actions <= UNSCOPED, 'wildcard resource on a resource-scopable action')
            else:
                need(all(SCOPED.get(a) == resource for a in actions), 'resource outside pinned account/region/type')
        need(s.get('Condition') == REGION_ONLY, 'aws:RequestedRegion ap-south-1 condition required')
        seen |= actions
    need(seen == ACTIONS, 'required agent action missing')
    need(doc_sha(doc) == POLICY_SHA256, 'policy differs from reviewed document')


def tags_of(items):
    need(isinstance(items, list) and all(isinstance(t, dict) and set(t) == {'Key', 'Value'} for t in items)
         and len({t['Key'] for t in items}) == len(items), 'invalid tags')
    return {t['Key']: t['Value'] for t in items}


def check_template(t):
    need(isinstance(t, dict) and set(t) == {'AWSTemplateFormatVersion', 'Description', 'Resources', 'Outputs'},
         'unexpected template section (Parameters/Conditions/Transform refused)')
    need(isinstance(t['Resources'], dict) and all(isinstance(r, dict) for r in t['Resources'].values())
         and {k: r.get('Type') for k, r in t['Resources'].items()} == RESOURCES,
         'template must declare exactly the role and the instance profile')
    role, profile = t['Resources']['MaintenanceRole'], t['Resources']['MaintenanceInstanceProfile']
    for r in (role, profile):
        need({k: v for k, v in r.items() if k != 'Properties'} == {'Type': r['Type'], 'DeletionPolicy': 'Delete', 'UpdateReplacePolicy': 'Delete'},
             'unexpected resource attribute')
    p = role.get('Properties')
    need(isinstance(p, dict) and set(p) == {'RoleName', 'Path', 'Description', 'MaxSessionDuration', 'AssumeRolePolicyDocument', 'Policies', 'Tags'},
         'unexpected role property (managed policy/boundary refused)')
    need(p['RoleName'] == NAME and p['Path'] == PATH and p['MaxSessionDuration'] == 3600, 'role name/path mismatch')
    need(tags_of(p['Tags']) == TAGS, 'role tags mismatch')
    check_trust(p['AssumeRolePolicyDocument'])
    need(isinstance(p['Policies'], list) and len(p['Policies']) == 1 and isinstance(p['Policies'][0], dict)
         and set(p['Policies'][0]) == {'PolicyName', 'PolicyDocument'} and p['Policies'][0]['PolicyName'] == POLICY_NAME,
         'exactly one inline policy required')
    check_policy(p['Policies'][0]['PolicyDocument'])
    need(profile.get('Properties') == {'InstanceProfileName': NAME, 'Path': PATH, 'Roles': [{'Ref': 'MaintenanceRole'}]},
         'instance profile binding mismatch')
    need(t['Outputs'] == {'InstanceProfileArn': {'Value': {'Fn::GetAtt': ['MaintenanceInstanceProfile', 'Arn']}},
                          'RoleArn': {'Value': {'Fn::GetAtt': ['MaintenanceRole', 'Arn']}}}, 'unexpected outputs')
    return t


def load_template(path=None, pin=None):
    raw = Path(path or REPO / TEMPLATE).read_bytes()
    need(sha(raw) == (pin or TEMPLATE_SHA256), 'template bytes differ from pinned sha256')
    return check_template(manifest.loads(raw.decode('utf-8')))


def aws(*argv):
    return ['aws', '--profile', PROFILE, '--region', REGION, '--no-cli-pager', *argv]


def render_plan():
    """Deterministic: no clock, host path or credential. Every argv is for Root; none is run here."""
    change_set = 'attest-maint-' + TEMPLATE_SHA256[:16]
    stack = ['--stack-name', STACK]
    cs = [*stack, '--change-set-name', change_set]
    tool = ['python3', 'deploy/aws/mum/attest_maintenance_iam.py']
    associations = aws('ssm', 'list-associations', '--output', 'json')
    fleet = aws('ec2', 'describe-instances', '--filters', f'Name=iam-instance-profile.arn,Values={PROFILE_ARN}',
                'Name=instance-state-name,Values=' + ','.join(LIVE), '--output', 'json')
    return {
        'schemaVersion': 1, 'account': ACCOUNT, 'region': REGION, 'namespace': NAMESPACE, 'stack': STACK, 'changeSet': change_set,
        'roleArn': ROLE_ARN, 'instanceProfileArn': PROFILE_ARN, 'policyName': POLICY_NAME, 'templatePath': TEMPLATE,
        'templateSha256': TEMPLATE_SHA256, 'trustSha256': TRUST_SHA256, 'policySha256': POLICY_SHA256,
        'steps': [
            {'name': 'preflight', 'expect': 'Account equals ' + ACCOUNT + '; the other three fail NoSuchEntity / does not exist',
             'argv': [aws('sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'),
                      aws('iam', 'get-role', '--role-name', NAME),
                      aws('iam', 'get-instance-profile', '--instance-profile-name', NAME),
                      aws('cloudformation', 'describe-stacks', *stack)]},
            {'name': 'create-change-set', 'expect': 'CREATE change set; no --role-arn/--parameters/--tags/--import-existing-resources',
             'argv': [aws('cloudformation', 'create-change-set', *cs, '--change-set-type', 'CREATE', '--template-body', 'file://' + TEMPLATE,
                          '--capabilities', 'CAPABILITY_NAMED_IAM'),
                      aws('cloudformation', 'wait', 'change-set-create-complete', *cs)]},
            {'name': 'inspect-change-set', 'saves': {
                'changeset.json': aws('cloudformation', 'describe-change-set', *cs, '--include-property-values', '--output', 'json'),
                'submitted.json': aws('cloudformation', 'get-template', *cs, '--template-stage', 'Original', '--output', 'json'),
                'stack.json': aws('cloudformation', 'describe-stacks', *stack, '--output', 'json')},
             'argv': [[*tool, 'verify-changeset', '--dir', 'DIR', '--plan-sha256', 'PLAN_SHA256']]},
            {'name': 'execute', 'expect': 'Root specific GO only',
             'argv': [aws('cloudformation', 'execute-change-set', *cs),
                      aws('cloudformation', 'wait', 'stack-create-complete', *stack)]},
            {'name': 'drift', 'expect': 'detection DETECTION_COMPLETE before saving drifts.json',
             'argv': [aws('cloudformation', 'detect-stack-drift', *stack, '--output', 'json'),
                      aws('cloudformation', 'describe-stack-drift-detection-status', '--stack-drift-detection-id', 'DETECTION_ID')]},
            {'name': 'readback', 'saves': {
                'stack.json': aws('cloudformation', 'describe-stacks', *stack, '--output', 'json'),
                'resources.json': aws('cloudformation', 'describe-stack-resources', *stack, '--output', 'json'),
                'drifts.json': aws('cloudformation', 'describe-stack-resource-drifts', *stack, '--output', 'json'),
                'role.json': aws('iam', 'get-role', '--role-name', NAME, '--output', 'json'),
                'role-policies.json': aws('iam', 'list-role-policies', '--role-name', NAME, '--output', 'json'),
                'role-policy.json': aws('iam', 'get-role-policy', '--role-name', NAME, '--policy-name', POLICY_NAME, '--output', 'json'),
                'attached.json': aws('iam', 'list-attached-role-policies', '--role-name', NAME, '--output', 'json'),
                'profile.json': aws('iam', 'get-instance-profile', '--instance-profile-name', NAME, '--output', 'json'),
                'profiles-for-role.json': aws('iam', 'list-instance-profiles-for-role', '--role-name', NAME, '--output', 'json')},
             'argv': [[*tool, 'verify-readback', '--dir', 'DIR', '--plan-sha256', 'PLAN_SHA256']]},
            {'name': 'pre-launch', 'expect': 'before every launch, after a fresh readback (own DIR); no profiled live instance, no association',
             'saves': {'associations.json': associations, 'profile-fleet.json': fleet},
             'argv': [[*tool, 'verify-prelaunch', '--dir', 'DIR']]},
            {'name': 'host-ready', 'expect': 'per fresh host, read-only (own DIR); never a bootstrap command; fail closed',
             'saves': {
                'associations.json': associations, 'profile-fleet.json': fleet,
                'instance.json': aws('ec2', 'describe-instances', '--instance-ids', 'INSTANCE_ID', '--output', 'json'),
                'instance-information.json': aws('ssm', 'describe-instance-information', '--filters', 'Key=InstanceIds,Values=INSTANCE_ID', '--output', 'json'),
                'effective-associations.json': aws('ssm', 'describe-effective-instance-associations', '--instance-id', 'INSTANCE_ID', '--output', 'json')},
             'argv': [[*tool, 'verify-host', '--dir', 'DIR', '--instance-id', 'INSTANCE_ID', '--instance-profile-id', 'READBACK_INSTANCE_PROFILE_ID']]},
        ]}


def plan_sha256():
    return sha(canonical(render_plan()))


def read(d, name):
    return manifest.read(Path(d) / name, LIMIT)


def page(doc, key):
    """CLI auto-pagination merges pages; any surviving token means an incomplete read."""
    need(isinstance(doc, dict) and not doc.get('NextToken') and not doc.get('IsTruncated') and not doc.get('Marker'),
         'incomplete paginated read')
    return doc.get(key)


def one_stack(doc):
    stacks = page(doc, 'Stacks')
    need(isinstance(stacks, list) and len(stacks) == 1 and isinstance(stacks[0], dict), 'stack read must name exactly one stack')
    return stacks[0]


def check_plan(pin):
    need(pin == plan_sha256(), 'stale plan')


def verify_changeset(d, pin):
    check_plan(pin)
    template = load_template()
    cs = read(d, 'changeset.json')
    changes = page(cs, 'Changes')
    need(cs.get('StackName') == STACK and cs.get('ChangeSetName') == render_plan()['changeSet']
         and STACK_ARN.fullmatch(str(cs.get('StackId'))), 'change set targets another stack/account/region')
    need(cs.get('Status') == 'CREATE_COMPLETE' and cs.get('ExecutionStatus') == 'AVAILABLE', 'change set not ready')
    need(cs.get('Capabilities') == ['CAPABILITY_NAMED_IAM'] and not any(cs.get(k) for k in (
        'Parameters', 'Tags', 'RoleARN', 'NotificationARNs', 'IncludeNestedStacks', 'ImportExistingResources', 'ParentChangeSetId', 'RootChangeSetId')),
         'change set options differ from plan (role/parameters/tags/import refused)')
    need(isinstance(changes, list) and len(changes) == 2, 'change set must have exactly two changes')
    added = {}
    for c in changes:
        rc = c.get('ResourceChange') if isinstance(c, dict) and c.get('Type') == 'Resource' else None
        need(isinstance(rc, dict) and rc.get('Action') == 'Add', 'non-Add change refused')
        need(not any(rc.get(k) for k in ('Replacement', 'PhysicalResourceId', 'Details', 'Scope')), 'change touches an existing resource')
        added[rc.get('LogicalResourceId')] = rc.get('ResourceType')
    need(added == RESOURCES, 'unexpected change-set resource')
    body = read(d, 'submitted.json').get('TemplateBody')
    body = manifest.loads(body) if isinstance(body, str) else body
    need(canonical(body) == canonical(template), 'submitted template differs from pinned template')
    s = one_stack(read(d, 'stack.json'))
    need(s.get('StackName') == STACK and s.get('StackId') == cs['StackId'] and s.get('StackStatus') == 'REVIEW_IN_PROGRESS'
         and not s.get('Outputs') and not s.get('RoleARN'), 'stack must be new (REVIEW_IN_PROGRESS) with no role')
    return {'verified': 'change-set', 'planSha256': pin, 'templateSha256': TEMPLATE_SHA256, 'changeSet': cs['ChangeSetName'],
            'actions': sorted(f'Add {k}' for k in added)}


def verify_readback(d, pin):
    check_plan(pin)
    load_template()
    s = one_stack(read(d, 'stack.json'))
    need(s.get('StackName') == STACK and STACK_ARN.fullmatch(str(s.get('StackId'))) and s.get('StackStatus') == 'CREATE_COMPLETE'
         and not s.get('RoleARN') and not s.get('Parameters') and s.get('Capabilities') == ['CAPABILITY_NAMED_IAM'], 'stack not created as planned')
    outputs = s.get('Outputs')
    need(isinstance(outputs, list) and len(outputs) == 2 and all(isinstance(o, dict) for o in outputs)
         and {o.get('OutputKey'): o.get('OutputValue') for o in outputs} == {'InstanceProfileArn': PROFILE_ARN, 'RoleArn': ROLE_ARN},
         'stack outputs differ')
    resources = page(read(d, 'resources.json'), 'StackResources')
    need(isinstance(resources, list) and all(isinstance(x, dict) for x in resources) and sorted(
        (x.get('LogicalResourceId'), x.get('ResourceType'), x.get('PhysicalResourceId'), x.get('ResourceStatus')) for x in resources) == sorted(
        (k, v, NAME, 'CREATE_COMPLETE') for k, v in RESOURCES.items()), 'stack resources differ')
    role = read(d, 'role.json').get('Role')
    need(isinstance(role, dict) and role.get('RoleName') == NAME and role.get('Path') == PATH and role.get('Arn') == ROLE_ARN
         and re.fullmatch(r'AROA[A-Z0-9]{16,}', str(role.get('RoleId'))), 'role identity mismatch')
    need('PermissionsBoundary' not in role, 'permissions boundary present')
    tags = tags_of(role.get('Tags', []))
    need(all(v == STACK for k, v in tags.items() if k == 'aws:cloudformation:stack-name'), 'role tagged by another stack')
    need(role.get('MaxSessionDuration') == 3600 and {k: v for k, v in tags.items() if not k.startswith('aws:cloudformation:')} == TAGS,
         'role settings/tags drifted')
    check_trust(role.get('AssumeRolePolicyDocument'))
    need(page(read(d, 'role-policies.json'), 'PolicyNames') == [POLICY_NAME], 'unexpected inline policy set')
    inline = read(d, 'role-policy.json')
    need(inline.get('RoleName') == NAME and inline.get('PolicyName') == POLICY_NAME, 'inline policy read mismatch')
    check_policy(inline.get('PolicyDocument'))
    need(page(read(d, 'attached.json'), 'AttachedPolicies') == [], 'managed policy attached')
    profile = read(d, 'profile.json').get('InstanceProfile')
    need(isinstance(profile, dict) and profile.get('InstanceProfileName') == NAME and profile.get('Path') == PATH and profile.get('Arn') == PROFILE_ARN
         and re.fullmatch(r'AIPA[A-Z0-9]{16,}', str(profile.get('InstanceProfileId'))), 'instance profile identity mismatch')
    bound = profile.get('Roles')
    # RoleId, not name: a deleted and recreated same-name role is a different binding.
    need(isinstance(bound, list) and len(bound) == 1 and isinstance(bound[0], dict) and bound[0].get('RoleId') == role['RoleId']
         and bound[0].get('Arn') == ROLE_ARN, 'instance profile must hold exactly this role')
    profiles = page(read(d, 'profiles-for-role.json'), 'InstanceProfiles')
    need(isinstance(profiles, list) and [(p.get('Arn'), p.get('InstanceProfileId')) for p in profiles if isinstance(p, dict)]
         == [(PROFILE_ARN, profile['InstanceProfileId'])] and len(profiles) == 1, 'role bound to another instance profile')
    drifts = page(read(d, 'drifts.json'), 'StackResourceDrifts')
    status = {x.get('LogicalResourceId'): x.get('StackResourceDriftStatus') for x in drifts if isinstance(x, dict)} if isinstance(drifts, list) else None
    # The profile's exact binding is read back above, so NOT_CHECKED is tolerated for it alone.
    need(status is not None and len(status) == len(drifts) and set(status) == set(RESOURCES) and status['MaintenanceRole'] == 'IN_SYNC'
         and status['MaintenanceInstanceProfile'] in ('IN_SYNC', 'NOT_CHECKED'), 'stack drift detected or unread')
    return {'verified': 'readback', 'planSha256': pin, 'templateSha256': TEMPLATE_SHA256, 'trustSha256': TRUST_SHA256,
            'policySha256': POLICY_SHA256, 'roleArn': ROLE_ARN, 'instanceProfileArn': PROFILE_ARN, 'roleId': role['RoleId'],
            'instanceProfileId': profile['InstanceProfileId'], 'managedPolicies': 0, 'boundary': None, 'drift': status}


def instances(doc):
    reservations = page(doc, 'Reservations')
    need(isinstance(reservations, list) and all(isinstance(r, dict) and isinstance(r.get('Instances'), list) for r in reservations),
         'invalid describe-instances read')
    found = [i for r in reservations for i in r['Instances']]
    need(all(isinstance(i, dict) for i in found), 'invalid describe-instances read')
    return found


def no_associations(d):
    need(page(read(d, 'associations.json'), 'Associations') == [],
         'State Manager associations exist in the region (could run on the host before the proof)')


def verify_prelaunch(d):
    no_associations(d)
    need(instances(read(d, 'profile-fleet.json')) == [], 'a live instance already carries the maintenance profile')
    return {'verified': 'pre-launch', 'instanceProfileArn': PROFILE_ARN, 'profiledLiveInstances': 0, 'associations': 0}


def verify_host(d, instance_id, profile_id):
    need(isinstance(instance_id, str) and re.fullmatch(r'i-[0-9a-f]{17}', instance_id), 'invalid instance id')
    need(isinstance(profile_id, str) and re.fullmatch(r'AIPA[A-Z0-9]{16,}', profile_id), 'invalid instance profile id')
    no_associations(d)
    host = instances(read(d, 'instance.json'))
    need(len(host) == 1 and host[0].get('InstanceId') == instance_id, 'instance read must name exactly the host')
    # Id, not only ARN: a deleted and recreated same-name profile is a different profile.
    need(host[0].get('IamInstanceProfile') == {'Arn': PROFILE_ARN, 'Id': profile_id}, 'host does not carry exactly the qualified profile')
    need([i.get('InstanceId') for i in instances(read(d, 'profile-fleet.json'))] == [instance_id],
         'maintenance profile is on another live instance')
    info = page(read(d, 'instance-information.json'), 'InstanceInformationList')
    need(isinstance(info, list) and len(info) == 1 and isinstance(info[0], dict) and info[0].get('InstanceId') == instance_id
         and info[0].get('ResourceType') == 'EC2Instance', 'host not registered exactly once')
    need(info[0].get('PingStatus') == 'Online', 'agent not Online (fail closed; never bootstrap)')
    version = re.fullmatch(r'([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)', str(info[0].get('AgentVersion')))
    need(version is not None and tuple(map(int, version.groups())) >= MIN_AGENT,
         'SSM Agent older than 3.3.40.0 needs ec2messages: return to Root')
    need(page(read(d, 'effective-associations.json'), 'Associations') == [], 'effective association targets the host')
    return {'verified': 'host-ready', 'instanceId': instance_id, 'instanceProfileArn': PROFILE_ARN, 'instanceProfileId': profile_id,
            'agentVersion': info[0]['AgentVersion'], 'associations': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('plan')
    for name in ('verify-changeset', 'verify-readback'):
        p = sub.add_parser(name)
        p.add_argument('--dir', required=True)
        p.add_argument('--plan-sha256', required=True)
    sub.add_parser('verify-prelaunch').add_argument('--dir', required=True)
    p = sub.add_parser('verify-host')
    p.add_argument('--dir', required=True)
    p.add_argument('--instance-id', required=True)
    p.add_argument('--instance-profile-id', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'plan':
            load_template()
            result = {'planSha256': plan_sha256(), 'plan': render_plan()}
        elif args.command == 'verify-changeset':
            result = verify_changeset(args.dir, args.plan_sha256)
        elif args.command == 'verify-readback':
            result = verify_readback(args.dir, args.plan_sha256)
        elif args.command == 'verify-prelaunch':
            result = verify_prelaunch(args.dir)
        else:
            result = verify_host(args.dir, args.instance_id, args.instance_profile_id)
    except (ValueError, OSError) as error:
        print('REFUSE: ' + str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
