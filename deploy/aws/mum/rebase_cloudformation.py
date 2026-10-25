"""Execute reviewed CloudFormation change sets or verify unchanged identity.

The review binds every changed property to exact before/candidate template bytes.
This is the initial image-rebase rollout, separate from the narrower AMI-only
promoter. It never creates a change set, publishes unreviewed assets, or deletes a
stack. The lead stages assets/change sets from the reviewed integrated synthesis.
"""
import fnmatch
from collections import Counter
import hashlib
import json
from pathlib import Path
import time

import rebase_manifest as manifest

need = manifest.need
STACKS = {'identity':'ezil-identity-mum','foundation':'ezil-mum-foundation','workflows':'ezil-mum-lifecycle'}
ROLE = 'arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec'
DEPENDENT_VERSION = {'action':'Modify','properties':['StateMachineRevisionId'],'attributes':[]}
TYPES = {'AWS::IAM::Role','AWS::IAM::Policy','AWS::IAM::ManagedPolicy','AWS::Lambda::Function',
         'AWS::Lambda::Version','AWS::StepFunctions::StateMachine','AWS::StepFunctions::StateMachineVersion',
         'AWS::Logs::LogGroup','AWS::KMS::Key'}
FORBIDDEN = {'ec2:deletevolume','ec2:deletesnapshot','ec2:modifyinstancemetadataoptions','ec2:modifysnapshotattribute',
             'ec2:copysnapshot','ec2:createsnapshots','ec2:detachvolume','ec2:deletetags','iam:passrole'}
SHARED_BOUNDARY = 'BoundaryEA298153'
POOL_CONTROLLER = 'LifecycleControllerRoleDefaultPolicy31C0D948'


def is_shared_boundary(logical,resource):
    return logical==SHARED_BOUNDARY and bool(resource) and resource['Type']=='AWS::IAM::ManagedPolicy'


def statements(value):
    if isinstance(value,dict):
        if 'Effect' in value and ('Action' in value or 'NotAction' in value): yield value
        else:
            for child in value.values(): yield from statements(child)
    elif isinstance(value,list):
        for child in value: yield from statements(child)


def action_set(statement):
    value=statement.get('Action',[])
    return {action.casefold() for action in ([value] if isinstance(value,str) else value)}


POOL_ACTIONS = {'ec2:detachvolume','ec2:deletetags'}
POOL_SCOPED_ACTIONS = POOL_ACTIONS | {'ec2:terminateinstances'}


def canonical_iam(value):
    """IAM action names ignore case and order; preserve other arrays and values."""
    if isinstance(value,list):return [canonical_iam(v) for v in value]
    if isinstance(value,dict):
        return {k:(v.casefold() if isinstance(v,str) else sorted(a.casefold() for a in v))
                if k in ('Action','NotAction') and 'Effect' in value
                else canonical_iam(v) for k,v in value.items()}
    return value


def statement_key(statement):
    return json.dumps(canonical_iam(statement),sort_keys=True,separators=(',',':'))


def canonical_template(template):
    return {**template,'Resources':{key:canonical_iam(resource) if resource['Type'].startswith('AWS::IAM::') else resource
                                   for key,resource in template['Resources'].items()}}


def iam_delta(before,after):
    """Exact statement multisets, per logical IAM resource (duplicates count)."""
    old,new=before['Resources'],after['Resources'];delta={}
    for logical in sorted(old.keys() | new.keys()):
        if not (new.get(logical) or old[logical])['Type'].startswith('AWS::IAM::'):continue
        a=Counter(statement_key(s) for s in statements(old.get(logical)))
        b=Counter(statement_key(s) for s in statements(new.get(logical)))
        if a!=b:
            delta[logical]={'added':[json.loads(s) for s in sorted((b-a).elements())],
                            'removed':[json.loads(s) for s in sorted((a-b).elements())]}
    return delta


def pool_resource_tags(statement,namespace):
    equals={key.casefold():value for key,value in statement.get('Condition',{}).get('StringEquals',{}).items()}
    return all(any(equals.get(prefix+'/ezil:'+tag)==value for prefix in ('aws:resourcetag','ec2:resourcetag'))
               for tag,value in (('managed-by','app-computer-platform'),('stage',namespace)))


def pool_type_deny():
    return {'Effect':'Deny','Action':'ec2:RunInstances',
            'Resource':'arn:aws:ec2:ap-south-1:452630323510:instance/*',
            'Condition':{'Null':{'aws:RequestTag/ezil:pool':'false'},
                         'StringNotEquals':{'ec2:InstanceType':['m6i.large','m6i.xlarge']}}}


def same_except_action(a,b):
    return {k:v for k,v in a.items() if k!='Action'}=={k:v for k,v in b.items() if k!='Action'}


def validate_pool_iam(phase,before,after,review):
    if review is None:return {}
    need(isinstance(review,dict) and set(review)=={'schemaVersion','namespace','stacks'}
         and type(review['schemaVersion']) is int and review['schemaVersion']==1
         and isinstance(review['stacks'],dict) and set(review['stacks'])=={'identity','workflows'}
         and all(isinstance(resources,dict) and all(isinstance(logical,str) and isinstance(delta,dict)
                 and set(delta)=={'added','removed'} and (delta['added'] or delta['removed'])
                 and all(isinstance(delta[name],list) and all(isinstance(s,dict) and s.get('Effect') in ('Allow','Deny')
                         and ('Action' in s or 'NotAction' in s) for s in delta[name]) for name in ('added','removed'))
                 for logical,delta in resources.items()) for resources in review['stacks'].values()),
         'invalid pool IAM review')
    need(review['namespace']=='mum','pool IAM namespace mismatch')
    for resources in review['stacks'].values():
        for delta in resources.values():
            for s in delta['added']:
                if s.get('Effect')=='Allow' and action_set(s) & POOL_SCOPED_ACTIONS:
                    need(pool_resource_tags(s,review['namespace']),'pool IAM Allow requires managed-by and stage resource conditions')
    type_deny=statement_key(pool_type_deny())
    need(not any(statement_key(s)==type_deny for delta in review['stacks']['workflows'].values()
                 for s in delta['removed']), 'pool IAM RunInstances type Deny removal refused')
    controller=after['Resources'].get(POOL_CONTROLLER,{})
    # Incremental review (pool already enabled): identity cannot inspect workflows, so it may
    # proceed only with an empty identity delta; the workflows phase proves the Deny is live.
    need((any(logical==POOL_CONTROLLER
             and any(statement_key(s)==statement_key(pool_type_deny()) for s in delta['added'])
             for logical,delta in review['stacks']['workflows'].items())
          or phase=='identity' and not review['stacks']['identity']
          or phase not in ('identity','workflows')  # the artifact grants other phases nothing
          or phase=='workflows' and any(statement_key(s)==type_deny for s in statements(
              controller.get('Properties',{}).get('PolicyDocument',{}).get('Statement',[]))))
         and (phase!='workflows' or after['Resources'].get(POOL_CONTROLLER,{}).get('Type')=='AWS::IAM::Policy'),
         'pool IAM RunInstances type Deny required')
    if phase not in ('identity','workflows'):return {}
    expected={logical:{name:sorted(canonical_iam(delta[name]),key=statement_key) for name in ('added','removed')}
              for logical,delta in review['stacks'][phase].items()}
    actual=iam_delta(before,after)
    need(actual==expected,'pool IAM statement delta differs from review')
    for logical,delta in actual.items():
        left=before['Resources'].get(logical);right=after['Resources'].get(logical)
        candidates=list(statements(right))
        for deny in (s for s in delta['removed'] if s.get('Effect')=='Deny'):
            baseline=image_boundary_condition(deny) if phase=='identity' and _a2_role_write(left,right) else deny
            if any(same_except_action(s,baseline) and action_set(s)>=action_set(deny) for s in candidates):continue
            need(phase=='identity' and is_shared_boundary(logical,left) and is_shared_boundary(logical,right)
                 and any(same_except_action(s,deny) and POOL_ACTIONS<=action_set(deny)
                         and action_set(s)==action_set(deny)-POOL_ACTIONS for s in candidates),
                 'pool IAM deny removal exceeds shared boundary allowance')
            need(any(s.get('Effect')=='Allow' and pool_resource_tags(s,review['namespace'])
                     and POOL_ACTIONS<=action_set(s) and any(old.get('Effect')=='Allow'
                         and same_except_action(old,s) and action_set(s)-action_set(old)==POOL_ACTIONS
                         and action_set(old)<=action_set(s) for old in delta['removed']) for s in delta['added']),
                 'pool IAM boundary requires matching conditioned Allow')
    return actual


def restore_pool_boundary(value,delta):
    """Undo only the reviewed two-action edit; all other boundary fields stay fenced."""
    if isinstance(value,dict):
        if 'Effect' in value and value in delta.get('added',[]):
            for old in delta['removed']:
                if (same_except_action(value,old) and action_set(value)^action_set(old)==POOL_ACTIONS
                        and (value['Effect']=='Allow' and action_set(old)<=action_set(value)
                             or value['Effect']=='Deny' and action_set(value)<=action_set(old))):return old
        return {k:restore_pool_boundary(v,delta) for k,v in value.items()}
    if isinstance(value,list):return [restore_pool_boundary(v,delta) for v in value]
    return value


def load_pool_iam(rollout,digest):
    if rollout is None or 'poolIam' not in rollout:return None
    need(digest(rollout['poolIam'])==rollout['poolIamSha256'],'reviewed pool IAM artifact changed')
    return manifest.read(rollout['poolIam'])




def ascii_view(value):
    """CloudFormation returns a live template's non-ASCII characters as '?' (e.g. a boundary
    description's section sign); compare synthesized values the same way (as json-tool does)."""
    if isinstance(value,str):return value.encode('ascii','replace').decode('ascii')
    if isinstance(value,list):return [ascii_view(v) for v in value]
    if isinstance(value,dict):return {k:ascii_view(v) for k,v in value.items()}
    return value

def without_snapshot_read(value):
    if isinstance(value,list):return [without_snapshot_read(v) for v in value if not (isinstance(v,dict) and v.get('Effect')=='Allow' and action_set(v)=={'ec2:describesnapshots'})]
    if isinstance(value,dict):
        return {k:([a for a in v if a.casefold()!='ec2:describesnapshots'] if k=='Action' and isinstance(v,list) and value.get('Effect')=='Allow' else without_snapshot_read(v)) for k,v in value.items()}
    return value


def _broader_condition(candidate,shared):
    """A candidate deny condition that matches at least whenever the shared one does.

    Only one widening is accepted: a ForAnyValue:StringEquals key list that is a superset
    (more tag keys refused). Every other operator/key/value must be identical.
    """
    if candidate==shared: return True
    if not isinstance(candidate,dict) or not isinstance(shared,dict) or candidate.keys()!=shared.keys(): return False
    for op,keys in shared.items():
        other=candidate[op]
        if other==keys: continue
        if op!='ForAnyValue:StringEquals' or not isinstance(keys,dict) or not isinstance(other,dict) or other.keys()!=keys.keys(): return False
        for key,values in keys.items():
            mine,theirs=other[key],values
            mine={mine} if isinstance(mine,str) else set(mine); theirs={theirs} if isinstance(theirs,str) else set(theirs)
            if not mine>=theirs: return False
    return True

def _allowed(candidates,action):
    """Whether any Allow in this boundary could grant the action (wildcards honoured; NotAction treated as granting)."""
    for s in candidates:
        if s.get('Effect')!='Allow': continue
        if 'NotAction' in s: return True
        if any(fnmatch.fnmatchcase(action.casefold(),pattern) for pattern in action_set(s)): return True
    return False

IMAGE_JOB_ROLES=('arn:aws:iam::452630323510:role/ezil/mum/ezil-mum-rebase-preparation',
                 'arn:aws:iam::452630323510:role/ezil/mum/ezil-mum-recovery')
ROLE_WRITES={'iam:createrole','iam:putrolepermissionsboundary','iam:putrolepolicy','iam:deleterolepolicy',
             'iam:attachrolepolicy','iam:detachrolepolicy','iam:updateassumerolepolicy','iam:updaterole','iam:deleterole'}

def _narrow_image_role_allow(statement):
    """An added Allow that only lets role writes target the two exact image-job roles with the image-job boundary."""
    resources=statement.get('Resource');resources=[resources] if isinstance(resources,str) else resources
    return (statement.get('Effect')=='Allow' and 'NotAction' not in statement and 'NotResource' not in statement
            and action_set(statement) and action_set(statement)<=ROLE_WRITES
            and isinstance(resources,list) and resources and set(resources)<=set(IMAGE_JOB_ROLES)
            and statement.get('Condition')=={'StringEquals':{'iam:PermissionsBoundary':
                'arn:aws:iam::452630323510:policy/ezil/mum/ezil-mum-image-job-boundary'}}
            and set(statement)<={'Sid','Effect','Action','Resource','Condition'})

IMAGE_JOB_ROLE_NAMES=tuple(arn.replace(':role/ezil/mum/',':role/') for arn in IMAGE_JOB_ROLES)

def _image_role_existence_read(statement):
    """An added Allow of only iam:GetRole on the two image-job roles' path-less ARNs: IAM authorizes
    CloudFormation's pre-create GetRole on a not-yet-existing named role against role/<name>."""
    resources=statement.get('Resource');resources=[resources] if isinstance(resources,str) else resources
    return (statement.get('Effect')=='Allow' and set(statement)<={'Sid','Effect','Action','Resource'}
            and action_set(statement)=={'iam:getrole'} and isinstance(resources,list) and resources
            and set(resources)<=set(IMAGE_JOB_ROLE_NAMES))

def _without_tightening(right,expected):
    """Drop statements added to `right` that only tighten (any Deny), the narrow image-role Allow,
    or the image-role pre-create existence read."""
    if isinstance(right,dict) and isinstance(expected,dict):
        out={}
        for k,v in right.items():
            if k=='Statement' and isinstance(v,list) and isinstance(expected.get(k),list):
                out[k]=[st for st in v if st in expected[k] or not (st.get('Effect')=='Deny' or _narrow_image_role_allow(st) or _image_role_existence_read(st))]
            else: out[k]=_without_tightening(v,expected.get(k))
        return out
    if isinstance(right,list) and isinstance(expected,list) and len(right)==len(expected):
        return [_without_tightening(a,b) for a,b in zip(right,expected)]
    return right

def _a2_role_write(left,right):
    """`right` is A2's role-write condition widening of `left`, optionally with tightening additions only."""
    return bool(left and right) and _without_tightening(right,image_boundary_condition(left)) in (left,image_boundary_condition(left))

KMS_GRANT_WILDCARDS=frozenset({'kms:generatedatakey*','kms:reencrypt*'})
RECOVERY_ADD_TYPES=frozenset({'AWS::CloudWatch::Alarm','AWS::Events::Rule','AWS::Lambda::Permission',
                              'AWS::Lambda::EventInvokeConfig','AWS::SQS::Queue','AWS::SQS::QueuePolicy'})

def includes_deny(candidates,deny):
    """The candidate boundary refuses everything the shared deny refuses.

    Satisfied by an identical-or-broader deny (same Effect/Resource/NotResource, superset actions,
    condition identical except a superset tag-key list), or because no Allow in the candidate
    boundary grants any of the deny's actions (a permissions boundary denies what it does not allow).
    """
    rest=lambda s:{k:v for k,v in s.items() if k not in ('Action','Condition','Sid')}
    if any(s.get('Effect')=='Deny' and rest(s)==rest(deny) and action_set(s)>=action_set(deny)
           and _broader_condition(s.get('Condition'),deny.get('Condition')) for s in candidates):
        return True
    return 'NotAction' not in deny and bool(action_set(deny)) and not any(_allowed(candidates,a) for a in action_set(deny))

def image_boundary_condition(value):
    """A2 permits the new boundary alongside the shared boundary on role writes.

    Only this existing condition key can expand; trust, actions, resources,
    other conditions, and the identity role itself are unchanged.
    """
    old='arn:aws:iam::452630323510:policy/ezil/identity/ezil-mum-boundary'
    new='arn:aws:iam::452630323510:policy/ezil/mum/ezil-mum-image-job-boundary'
    if isinstance(value,list):return [image_boundary_condition(v) for v in value]
    if isinstance(value,dict):return {k:([old,new] if k=='iam:PermissionsBoundary' and v==old else image_boundary_condition(v)) for k,v in value.items()}
    return value

def dependent_lambda_arns(logical, entry, old, new, actual):
    """Unchanged EventBridge targets/permissions can follow a modified Lambda's ARN."""
    resource=new.get(logical)
    if not resource or old.get(logical)!=resource:return set()
    kind=resource['Type'];props=resource.get('Properties',{})
    if kind=='AWS::Events::Rule':
        property_name='Targets';values=[target.get('Arn') for target in props.get('Targets',[])]
    elif kind=='AWS::Lambda::Permission':
        property_name='FunctionName';values=[props.get('FunctionName')]
    else:return set()
    if entry!={'action':'Modify','properties':[property_name],'attributes':[]}:return set()
    sources=set()
    for value in values:
        if not isinstance(value,dict) or set(value)!={'Fn::GetAtt'}:continue
        ref=value['Fn::GetAtt']
        if not isinstance(ref,list) or len(ref)!=2 or not isinstance(ref[0],str) or ref[1]!='Arn':continue
        source=ref[0]
        if (new.get(source,{}).get('Type')=='AWS::Lambda::Function'
                and actual.get(source,{}).get('action')=='Modify'):
            sources.add(source+'.Arn')
    return sources

def validate_templates(phase, before, after, review, unchanged=False, pool_iam=None):
    need(set(review)=={'schemaVersion','changes'} and type(review['schemaVersion']) is int and review['schemaVersion']==1,'invalid exact template review')
    raw_old,raw_new=before['Resources'],after['Resources']
    action_reorder=before!=after
    before,after=canonical_template(before),canonical_template(after)
    action_reorder=action_reorder and before==after
    pool_delta=validate_pool_iam(phase,before,after,pool_iam)
    if unchanged:
        need(phase=='identity','null change set is only allowed for identity')
        # Artifacts must already include the existing carry-cdk-metadata rule.
        need(before==after,'unchanged identity requires equal reviewed templates')
        need(review['changes']=={},'unchanged identity review must show no changes')
        return {}
    # Output/parameter/condition drift can delete/export or route resources.
    # New outputs are allowed only when they are explicit reviewed additions.
    a={k:v for k,v in before.items() if k not in ('Resources','Outputs')}
    b={k:v for k,v in after.items() if k not in ('Resources','Outputs')}
    need(a==b,'template parameter/condition/metadata drift refused')
    need(all(after.get('Outputs',{}).get(k)==v for k,v in before.get('Outputs',{}).items()),'existing outputs/exports must remain unchanged')
    if phase=='foundation':
        need(before==after, 'foundation must reuse its exact existing template')
        exact={'ComputerLaunchTemplate':{'action':'Modify','properties':['LaunchTemplateData'],'attributes':[]}}
        need(review['changes']==exact,'foundation review must contain only its parameter-forced AMI change')
        return exact
    old,new=before['Resources'],after['Resources'];actual={};right_resources=new
    boundary='arn:aws:iam::452630323510:policy/ezil/mum/ezil-mum-image-job-boundary'
    if phase=='identity':
        policies=[v for v in new.values() if v['Type']=='AWS::IAM::ManagedPolicy' and v.get('Properties',{}).get('ManagedPolicyName')=='ezil-mum-image-job-boundary']
        need(len(policies)==1 and policies[0]['Properties'].get('Path')=='/ezil/mum/', 'amendment A2 image-job boundary required')
        need(len(json.dumps(policies[0]['Properties']['PolicyDocument'],separators=(',',':')).encode())<=6144,'image-job managed policy exceeds size limit')
        shared=[v for k,v in old.items() if is_shared_boundary(k,v)]
        need(len(shared)==1,'one existing shared workload boundary required')
        for deny in (s for s in statements(shared[0]) if s.get('Effect')=='Deny'):
            need(includes_deny(list(statements(policies[0])),deny),'new image-job boundary omits a shared global deny')
    else:
        roles=[k for k,v in new.items() if v['Type']=='AWS::IAM::Role' and v.get('Properties',{}).get('PermissionsBoundary')==boundary]
        need(len(roles)==2 and any('RebasePreparationRole' in k for k in roles) and any('RecoveryRole' in k for k in roles),'exactly preparation and recovery execution roles require the image-job boundary')

    for logical in old.keys() | new.keys():
        if old.get(logical)==new.get(logical):
            # A provider may still enumerate a PolicyDocument modification for an
            # Action reorder. Admit its exact property review, without an IAM delta.
            if logical not in review['changes'] or raw_old.get(logical)==raw_new.get(logical):continue
        left,right=old.get(logical),new.get(logical)
        resource=right or left;kind=resource['Type']
        # Enabling recovery the first time ADDS its reviewed operational resources (alarms, EventBridge
        # rules, reconciler permissions/invoke config, the unconfirmed-dispatch queue). Only as new
        # Recovery* resources in the workflows phase; never a modify/remove of existing ones.
        recovery_add=(phase=='workflows' and left is None and logical.startswith('Recovery') and kind in RECOVERY_ADD_TYPES)
        need(kind in TYPES or recovery_add or phase=='foundation' and kind=='AWS::EC2::LaunchTemplate','storage/network/unrelated resource change refused')
        if phase=='identity':
            boundary_policy=is_shared_boundary(logical,resource) or kind=='AWS::IAM::ManagedPolicy' and logical.startswith('ImageJobBoundary')
            if is_shared_boundary(logical,resource):
                restored=restore_pool_boundary(right,pool_delta.get(logical,{}))
                need(left and right and ascii_view(without_snapshot_read(left))==ascii_view(without_snapshot_read(restored)),'shared boundary change exceeds DescribeSnapshots')
            need(boundary_policy or left and right and kind.startswith('AWS::IAM::')
                 and _without_tightening(right,image_boundary_condition(left)) in (left,image_boundary_condition(left)),
                 'identity change is not the reviewed A2 boundary or exact role-write condition expansion')
        if phase=='foundation':
            need(logical=='ComputerLaunchTemplate' and left and right,'foundation resource change refused')
        if left is None:
            # First enablement of recovery adds its own retained, rotating history key (mirrors the
            # lifecycle history key); no other key or managed policy may be added outside identity.
            recovery_key=(phase=='workflows' and kind=='AWS::KMS::Key' and logical.startswith('RecoveryHistoryKey')
                          and right.get('DeletionPolicy')=='Retain' and right.get('UpdateReplacePolicy')=='Retain'
                          and right.get('Properties',{}).get('EnableKeyRotation') is True
                          and {'Key':'ezil:namespace','Value':'mum'} in right.get('Properties',{}).get('Tags',[]))
            need(kind not in ('AWS::KMS::Key','AWS::IAM::ManagedPolicy') or phase=='identity' or recovery_key,'unreviewed key or policy addition')
            actual[logical]={'action':'Add','properties':[],'attributes':[]}
        elif right is None:
            need(kind in ('AWS::Lambda::Version','AWS::StepFunctions::StateMachineVersion') and left.get('DeletionPolicy')=='Retain','resource removal requires retained immutable version')
            actual[logical]={'action':'Remove','properties':[],'attributes':[]}
        else:
            need(left['Type']==right['Type'],'resource type change refused')
            raw_left,raw_right=raw_old[logical],raw_new[logical]
            props=sorted(k for k in raw_left.get('Properties',{}).keys() | raw_right.get('Properties',{}).keys()
                         if ascii_view(raw_left.get('Properties',{}).get(k))!=ascii_view(raw_right.get('Properties',{}).get(k)))
            attrs=sorted(k for k in raw_left.keys() | raw_right.keys() if k!='Properties' and raw_left.get(k)!=raw_right.get(k))
            need(not any(k in attrs for k in ('DeletionPolicy','UpdateReplacePolicy','Condition')),'resource retention/condition change refused')
            if phase=='foundation':need(props==['LaunchTemplateData'] and not attrs,'foundation changes only launch-template AMI')
            actual[logical]={'action':'Modify','properties':props,'attributes':attrs}
        if kind in ('AWS::StepFunctions::StateMachineVersion','AWS::Logs::LogGroup') and right:
            need(right.get('DeletionPolicy')=='Retain' and right.get('UpdateReplacePolicy')=='Retain','workflow versions/logs must be retained')
        if left and right and kind.startswith('AWS::IAM::'):
            old_statements=list(statements(left));new_statements=list(statements(right))
            for deny in (s for s in old_statements if s.get('Effect')=='Deny'):
                need(deny in pool_delta.get(logical,{}).get('removed',[]) or any({k:v for k,v in s.items() if k!='Action'}=={k:v for k,v in (image_boundary_condition(deny) if phase=='identity' and _a2_role_write(left,right) else deny).items() if k!='Action'} and action_set(s)>=action_set(deny) for s in new_statements),'existing IAM deny weakened')
        if right and kind.startswith('AWS::IAM::'):
            old_allows=[s for s in statements(image_boundary_condition(left) if phase=='identity' and _a2_role_write(left,right) else left) if s.get('Effect')=='Allow'] if left else []
            for statement in (s for s in statements(right) if s.get('Effect')=='Allow' and s not in old_allows):
                need('NotAction' not in statement and 'NotResource' not in statement,'inverse IAM grants refused')
                added=action_set(statement)
                reviewed_pool_actions=POOL_ACTIONS if statement in pool_delta.get(logical,{}).get('added',[]) else set()
                # CDK's key grants emit kms:GenerateDataKey*/kms:ReEncrypt*; accept those two only when the
                # statement targets exactly one KMS key defined in this same template (e.g. a history key).
                own_key=statement.get('Resource')
                own_key=own_key.get('Fn::GetAtt',[None])[0] if isinstance(own_key,dict) and list(own_key)==['Fn::GetAtt'] else None
                kms_ok=lambda action: action in KMS_GRANT_WILDCARDS and own_key is not None and (right_resources.get(own_key) or {}).get('Type')=='AWS::KMS::Key'
                need(not (added & (FORBIDDEN-reviewed_pool_actions)) and '*' not in added and not any('*' in action and not kms_ok(action) and not any(action in action_set(s) for s in old_allows) for action in added),'unreviewed destructive/wildcard IAM grants')
    # A published Step Functions version whose own template is unchanged still changes when its
    # state machine changes: CloudFormation reports Modify StateMachineRevisionId (Dynamic,
    # ResourceAttribute). Only that exact dependent entry may be added to the template diff.
    for logical,entry in review['changes'].items():
        if logical in actual:continue
        resource=new.get(logical)
        revision=(resource or {}).get('Properties',{}).get('StateMachineRevisionId')
        source=revision.get('Fn::GetAtt',[None])[0] if isinstance(revision,dict) else None
        if (resource and old.get(logical)==resource and resource['Type']=='AWS::StepFunctions::StateMachineVersion'
                and revision=={'Fn::GetAtt':[source,'StateMachineRevisionId']}
                and actual.get(source,{}).get('action')=='Modify'
                and entry==DEPENDENT_VERSION):
            actual[logical]=entry
        elif dependent_lambda_arns(logical,entry,old,new,actual):
            # Full resource equality also pins every other target field.
            actual[logical]=entry
    need(actual==review['changes'] and (bool(actual) or action_reorder),'review does not exactly enumerate template changes')
    return actual


def template_body(response):
    value=response['TemplateBody']
    return manifest.loads(value) if isinstance(value,str) else value


def template_sha256(value):
    """Hash semantic JSON independently of AWS/file formatting and object key order."""
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def parameters(value):
    """Retain literal and resolved SSM values; parameter order is immaterial."""
    need(isinstance(value,list) and all(isinstance(p,dict) and
         {'ParameterKey','ParameterValue'}<=set(p)<={'ParameterKey','ParameterValue','ResolvedValue'} and
         all(isinstance(v,str) for v in p.values()) and p['ParameterKey'] for p in value),
         'invalid identity parameter snapshot')
    need(len({p['ParameterKey'] for p in value})==len(value),'duplicate identity parameter keys')
    return sorted(value,key=lambda p:p['ParameterKey'])


def unchanged_identity(spec, after, apply, aws):
    live=template_body(aws('cloudformation','get-template','--stack-name',spec['stackName'],'--template-stage','Original'))
    need(live==after,'identity stack drifted from the reviewed template')
    stacks=aws('cloudformation','describe-stacks','--stack-name',spec['stackName'])['Stacks']
    need(len(stacks)==1,'one unchanged identity stack required')
    stack=stacks[0];status=stack.get('StackStatus','')
    need(isinstance(status,str) and status.endswith('_COMPLETE') and 'ROLLBACK' not in status and status!='DELETE_COMPLETE',
         'identity stack must be stable COMPLETE without rollback')
    need(spec['roleArn'] is None and stack.get('RoleARN') is None,'unchanged identity execution role drift')
    current=parameters(stack.get('Parameters') or [])
    if 'beforeParameters' in spec:
        need(current==parameters(spec['beforeParameters']),'identity stack parameters drifted from the review')
    if not apply:
        print('DRY RUN: unchanged identity live template and parameters verified')
        return None
    return {'changeSetArn':None,'candidateSha256':spec['candidateTemplateSha256'],'status':'unchanged',
            'liveTemplateSha256':template_sha256(live),'parameters':current}


def validate_change_details(phase, r, expected, resource, lambda_arns):
    """Apply the same exact change/detail guards in either CloudFormation view."""
    need(r['Action']==expected['action'] and r['ResourceType']==resource['Type'],'change-set action/type mismatch')
    if expected['action']=='Modify':
        immutable=resource['Type']=='AWS::StepFunctions::StateMachineVersion'
        permission=bool(lambda_arns) and resource['Type']=='AWS::Lambda::Permission'
        # A dependent version replacement is 'Conditional' on the referenced revision (seen live 2026-10-22).
        # Unchanged permissions may be Conditional, but their source Lambda must stay in place.
        need(r.get('Replacement') in (('True','Conditional') if immutable else ('False','Conditional') if permission else ('False',)),'unexpected resource replacement')
        for detail in r.get('Details',[]):
            need(detail['Target'].get('RequiresRecreation') in (('Always',) if immutable or permission else ('Never',)), 'unexplained property recreation')
            if lambda_arns:
                need(detail.get('Evaluation')=='Dynamic' and detail.get('ChangeSource')=='ResourceAttribute'
                     and detail.get('CausingEntity') in lambda_arns, 'unexplained Lambda ARN dependency')
            need(detail.get('ChangeSource') in ('DirectModification','ResourceReference','ResourceAttribute','ParameterReference'), 'unexplained property cause')
            if detail.get('ChangeSource')=='ParameterReference':
                need(phase=='foundation' and detail.get('CausingEntity')=='HostAmiId','unapproved parameter dependency')
        targets={(d['Target'].get('Attribute'),d['Target'].get('Name')) for d in r.get('Details',[])}
        wanted={('Properties',p) for p in expected['properties']} | {(p,None) for p in expected['attributes']}
        need(targets==wanted,'change-set property details differ from exact review')
        need(set(r.get('Scope',[]))==({'Properties'} if expected['properties'] else set()) | set(expected['attributes']),'change-set scope mismatch')
    else:
        need(not r.get('Details') and not r.get('Scope'),'unexpected add/remove details')


def execute(phase, spec, directory, apply, aws, write, digest, sleep=time.sleep, pool_iam=None):
    need(spec['stackName']==STACKS[phase], 'wrong rollout stack')
    before=manifest.read(spec['beforeTemplatePath']);after=manifest.read(spec['candidateTemplatePath']);review=manifest.read(spec['reviewPath'])
    for name in ('beforeTemplate','candidateTemplate','review'):
        need(digest(spec[name+'Path'])==spec[name+'Sha256'],'reviewed CloudFormation artifact changed')
    allowed=validate_templates(phase,before,after,review,unchanged=spec['changeSetArn'] is None,
                               pool_iam=load_pool_iam(pool_iam,digest))
    if spec['changeSetArn'] is None:
        return unchanged_identity(spec,after,apply,aws)
    cs=aws('cloudformation','describe-change-set','--stack-name',spec['stackName'],'--change-set-name',spec['changeSetArn'],'--include-property-values')
    need(cs['ChangeSetId']==spec['changeSetArn'] and cs['StackName']==spec['stackName'] and not cs.get('NextToken'),'change-set identity/pagination mismatch')
    submitted=template_body(aws('cloudformation','get-template','--stack-name',spec['stackName'],'--change-set-name',spec['changeSetArn'],'--template-stage','Original'))
    need(submitted==after,'submitted template differs from reviewed candidate')
    stacks=aws('cloudformation','describe-stacks','--stack-name',spec['stackName'])['Stacks'];need(len(stacks)==1,'one stack required');stack=stacks[0]
    need(cs.get('RoleARN',spec['roleArn'])==spec['roleArn'],'change set role drift')
    need(stack.get('RoleARN')==(spec['roleArn']), 'stack execution role drift')
    need(spec['roleArn']==(None if phase=='identity' else ROLE),'unapproved stack execution role')
    previous={p['ParameterKey']:p for p in (stack.get('Parameters') or [])}
    actual={p['ParameterKey']:p for p in (cs.get('Parameters') or [])}
    need(len(previous)==len(stack.get('Parameters') or []) and len(actual)==len((cs.get('Parameters') or [])) and previous.keys()==actual.keys(),'parameter coverage mismatch')
    for key,p in previous.items():
        target=actual[key]
        if phase=='foundation' and key=='HostAmiId' and cs['ExecutionStatus']=='AVAILABLE':
            # sourceAmiId is the pinned deployed AMI, not the image predecessor.
            need(p.get('ParameterValue')==spec['sourceAmiId'],'foundation no longer uses the deployed AMI')
        expected=spec['amiId'] if phase=='foundation' and key=='HostAmiId' else p.get('ParameterValue')
        need(target.get('ParameterValue',p.get('ParameterValue') if target.get('UsePreviousValue') else None)==expected and target.get('ResolvedValue')==p.get('ResolvedValue'),'parameter or resolved SSM drift')
    seen=set()
    for change in cs['Changes']:
        need(change['Type']=='Resource','non-resource change refused')
        r=change['ResourceChange'];logical=r['LogicalResourceId']
        need(logical in allowed and logical not in seen,'unreviewed/duplicate resource change');seen.add(logical)
        expected=allowed[logical];resource=(before if expected['action']=='Remove' else after)['Resources'][logical]
        lambda_arns=dependent_lambda_arns(logical,expected,before['Resources'],after['Resources'],allowed)
        validate_change_details(phase,r,expected,resource,lambda_arns)
    # With --include-property-values CloudFormation omits Dynamic dependent versions and
    # Lambda ARN dependents (seen live 2026-10-23); verify every omission in the plain view.
    omitted=set(allowed)-seen
    if omitted:
        need(all((allowed[l]==DEPENDENT_VERSION and after['Resources'][l]['Type']=='AWS::StepFunctions::StateMachineVersion')
                 or dependent_lambda_arns(l,allowed[l],before['Resources'],after['Resources'],allowed) for l in omitted),'change-set omits reviewed changes')
        plain=aws('cloudformation','describe-change-set','--stack-name',spec['stackName'],'--change-set-name',spec['changeSetArn'])
        need(plain['ChangeSetId']==spec['changeSetArn'] and not plain.get('NextToken'),'change-set identity/pagination mismatch')
        for change in plain['Changes']:
            r=change['ResourceChange']
            if r['LogicalResourceId'] not in omitted:continue
            logical=r['LogicalResourceId'];expected=allowed[logical];resource=after['Resources'][logical]
            lambda_arns=dependent_lambda_arns(logical,expected,before['Resources'],after['Resources'],allowed)
            if lambda_arns:
                validate_change_details(phase,r,expected,resource,lambda_arns)
            else:
                source=after['Resources'][r['LogicalResourceId']]['Properties']['StateMachineRevisionId']['Fn::GetAtt'][0]
                need(r['Action']=='Modify' and r['ResourceType']=='AWS::StepFunctions::StateMachineVersion' and r.get('Replacement') in ('True','Conditional')
                     and bool(r.get('Details')) and all(d['Target'].get('Attribute')=='Properties' and d['Target'].get('Name')=='StateMachineRevisionId'
                         and d['Target'].get('RequiresRecreation')=='Always' and d.get('ChangeSource')=='ResourceAttribute'
                         and d.get('CausingEntity')==source+'.StateMachineRevisionId' for d in r['Details']),'unexplained dependent version change')
            omitted.discard(r['LogicalResourceId'])
    need(not omitted,'change-set omits reviewed changes')
    live=template_body(aws('cloudformation','get-template','--stack-name',spec['stackName'],'--template-stage','Original'))
    path=Path(directory)/(phase+'-cloudformation.json')
    state=manifest.read(path) if path.exists() else None
    binding={'changeSetArn':spec['changeSetArn'],'candidateSha256':spec['candidateTemplateSha256']}
    if state:need(all(state.get(k)==v for k,v in binding.items()),'CloudFormation journal drift')
    if not apply:
        need(live in (before,after),'live template drift')
        print('DRY RUN: exact reviewed '+phase+' change set verified')
        return None
    if cs['ExecutionStatus']=='EXECUTE_COMPLETE':
        need(live==after and stack['StackStatus']=='UPDATE_COMPLETE','executed stack readback mismatch')
    elif cs['ExecutionStatus']=='AVAILABLE':
        need(live==before and stack['StackStatus'] in ('CREATE_COMPLETE','UPDATE_COMPLETE','UPDATE_ROLLBACK_COMPLETE'),'stack is not at reviewed baseline')
        need(state is None,'uncertain execution; reconcile before another execute-change-set')
        need(cs['Status']=='CREATE_COMPLETE','change set not executable')
        write(path,{**binding,'status':'executing'})
        aws('cloudformation','execute-change-set','--stack-name',spec['stackName'],'--change-set-name',spec['changeSetArn'])
    else:
        need(cs['ExecutionStatus']=='EXECUTE_IN_PROGRESS' and state is not None,'unexpected change-set execution state')
    for _ in range(180):
        stack=aws('cloudformation','describe-stacks','--stack-name',spec['stackName'])['Stacks'][0]
        if stack['StackStatus'] in ('UPDATE_IN_PROGRESS','UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'):
            sleep(5);continue
        need(stack['StackStatus']=='UPDATE_COMPLETE','stack update failed; retain journal')
        live=template_body(aws('cloudformation','get-template','--stack-name',spec['stackName'],'--template-stage','Original'))
        need(live==after,'post-deployment template mismatch')
        receipt={**binding,'status':'complete'};write(path,receipt);return receipt
    raise ValueError('stack still updating; resume journal')
