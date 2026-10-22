"""Execute pre-staged, explicitly reviewed CloudFormation change sets.

The review binds every changed property to exact before/candidate template bytes.
This is the initial image-rebase rollout, separate from the narrower AMI-only
promoter. It never creates a change set, publishes unreviewed assets, or deletes a
stack. The lead stages assets/change sets from the reviewed integrated synthesis.
"""
import fnmatch
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
FORBIDDEN = {'ec2:DeleteVolume','ec2:DeleteSnapshot','ec2:ModifyInstanceMetadataOptions','ec2:ModifySnapshotAttribute',
             'ec2:CopySnapshot','ec2:CreateSnapshots','ec2:DetachVolume','ec2:DeleteTags','iam:PassRole'}


def statements(value):
    if isinstance(value,dict):
        if 'Effect' in value and ('Action' in value or 'NotAction' in value): yield value
        else:
            for child in value.values(): yield from statements(child)
    elif isinstance(value,list):
        for child in value: yield from statements(child)


def action_set(statement):
    value=statement.get('Action',[])
    return {value} if isinstance(value,str) else set(value)




def ascii_view(value):
    """CloudFormation returns a live template's non-ASCII characters as '?' (e.g. a boundary
    description's section sign); compare synthesized values the same way (as json-tool does)."""
    if isinstance(value,str):return value.encode('ascii','replace').decode('ascii')
    if isinstance(value,list):return [ascii_view(v) for v in value]
    if isinstance(value,dict):return {k:ascii_view(v) for k,v in value.items()}
    return value

def without_snapshot_read(value):
    if isinstance(value,list):return [without_snapshot_read(v) for v in value if not (isinstance(v,dict) and v.get('Effect')=='Allow' and action_set(v)=={'ec2:DescribeSnapshots'})]
    if isinstance(value,dict):
        return {k:([a for a in v if a!='ec2:DescribeSnapshots'] if k=='Action' and isinstance(v,list) and value.get('Effect')=='Allow' else without_snapshot_read(v)) for k,v in value.items()}
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
        if any(fnmatch.fnmatchcase(action.lower(),pattern.lower()) for pattern in action_set(s)): return True
    return False

IMAGE_JOB_ROLES=('arn:aws:iam::452630323510:role/ezil/mum/ezil-mum-rebase-preparation',
                 'arn:aws:iam::452630323510:role/ezil/mum/ezil-mum-recovery')
ROLE_WRITES={'iam:CreateRole','iam:PutRolePermissionsBoundary','iam:PutRolePolicy','iam:DeleteRolePolicy',
             'iam:AttachRolePolicy','iam:DetachRolePolicy','iam:UpdateAssumeRolePolicy','iam:UpdateRole','iam:DeleteRole'}

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
            and action_set(statement)=={'iam:GetRole'} and isinstance(resources,list) and resources
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

KMS_GRANT_WILDCARDS=frozenset({'kms:GenerateDataKey*','kms:ReEncrypt*'})
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

def validate_templates(phase, before, after, review):
    need(set(review)=={'schemaVersion','changes'} and type(review['schemaVersion']) is int and review['schemaVersion']==1,'invalid exact template review')
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
        shared=[v for k,v in old.items() if k.startswith('Boundary') and v['Type']=='AWS::IAM::ManagedPolicy']
        need(len(shared)==1,'one existing shared workload boundary required')
        for deny in (s for s in statements(shared[0]) if s.get('Effect')=='Deny'):
            need(includes_deny(list(statements(policies[0])),deny),'new image-job boundary omits a shared global deny')
    else:
        roles=[k for k,v in new.items() if v['Type']=='AWS::IAM::Role' and v.get('Properties',{}).get('PermissionsBoundary')==boundary]
        need(len(roles)==2 and any('RebasePreparationRole' in k for k in roles) and any('RecoveryRole' in k for k in roles),'exactly preparation and recovery execution roles require the image-job boundary')

    for logical in old.keys() | new.keys():
        if old.get(logical)==new.get(logical):continue
        left,right=old.get(logical),new.get(logical)
        resource=right or left;kind=resource['Type']
        # Enabling recovery the first time ADDS its reviewed operational resources (alarms, EventBridge
        # rules, reconciler permissions/invoke config, the unconfirmed-dispatch queue). Only as new
        # Recovery* resources in the workflows phase; never a modify/remove of existing ones.
        recovery_add=(phase=='workflows' and left is None and logical.startswith('Recovery') and kind in RECOVERY_ADD_TYPES)
        need(kind in TYPES or recovery_add or phase=='foundation' and kind=='AWS::EC2::LaunchTemplate','storage/network/unrelated resource change refused')
        if phase=='identity':
            boundary_policy=kind=='AWS::IAM::ManagedPolicy' and (logical.startswith('Boundary') or logical.startswith('ImageJobBoundary'))
            if logical.startswith('Boundary'):
                need(left and right and ascii_view(without_snapshot_read(left))==ascii_view(without_snapshot_read(right)),'shared boundary change exceeds DescribeSnapshots')
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
            props=sorted(k for k in left.get('Properties',{}).keys() | right.get('Properties',{}).keys()
                         if ascii_view(left.get('Properties',{}).get(k))!=ascii_view(right.get('Properties',{}).get(k)))
            attrs=sorted(k for k in left.keys() | right.keys() if k!='Properties' and left.get(k)!=right.get(k))
            need(not any(k in attrs for k in ('DeletionPolicy','UpdateReplacePolicy','Condition')),'resource retention/condition change refused')
            if phase=='foundation':need(props==['LaunchTemplateData'] and not attrs,'foundation changes only launch-template AMI')
            actual[logical]={'action':'Modify','properties':props,'attributes':attrs}
        if kind in ('AWS::StepFunctions::StateMachineVersion','AWS::Logs::LogGroup') and right:
            need(right.get('DeletionPolicy')=='Retain' and right.get('UpdateReplacePolicy')=='Retain','workflow versions/logs must be retained')
        if left and right and kind.startswith('AWS::IAM::'):
            old_statements=list(statements(left));new_statements=list(statements(right))
            for deny in (s for s in old_statements if s.get('Effect')=='Deny'):
                need(any({k:v for k,v in s.items() if k!='Action'}=={k:v for k,v in (image_boundary_condition(deny) if phase=='identity' and _a2_role_write(left,right) else deny).items() if k!='Action'} and action_set(s)>=action_set(deny) for s in new_statements),'existing IAM deny weakened')
        if right and kind.startswith('AWS::IAM::'):
            old_allows=[s for s in statements(image_boundary_condition(left) if phase=='identity' and _a2_role_write(left,right) else left) if s.get('Effect')=='Allow'] if left else []
            for statement in (s for s in statements(right) if s.get('Effect')=='Allow' and s not in old_allows):
                need('NotAction' not in statement and 'NotResource' not in statement,'inverse IAM grants refused')
                added=action_set(statement)
                # CDK's key grants emit kms:GenerateDataKey*/kms:ReEncrypt*; accept those two only when the
                # statement targets exactly one KMS key defined in this same template (e.g. a history key).
                own_key=statement.get('Resource')
                own_key=own_key.get('Fn::GetAtt',[None])[0] if isinstance(own_key,dict) and list(own_key)==['Fn::GetAtt'] else None
                kms_ok=lambda action: action in KMS_GRANT_WILDCARDS and own_key is not None and (right_resources.get(own_key) or {}).get('Type')=='AWS::KMS::Key'
                need(not (added & FORBIDDEN) and '*' not in added and not any('*' in action and not kms_ok(action) and not any(action in action_set(s) for s in old_allows) for action in added),'unreviewed destructive/wildcard IAM grants')
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
    need(actual==review['changes'] and bool(actual),'review does not exactly enumerate template changes')
    return actual


def template_body(response):
    value=response['TemplateBody']
    return manifest.loads(value) if isinstance(value,str) else value


def execute(phase, spec, directory, apply, aws, write, digest, sleep=time.sleep):
    need(spec['stackName']==STACKS[phase], 'wrong rollout stack')
    before=manifest.read(spec['beforeTemplatePath']);after=manifest.read(spec['candidateTemplatePath']);review=manifest.read(spec['reviewPath'])
    for name in ('beforeTemplate','candidateTemplate','review'):
        need(digest(spec[name+'Path'])==spec[name+'Sha256'],'reviewed CloudFormation artifact changed')
    allowed=validate_templates(phase,before,after,review)
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
            need(p.get('ParameterValue')==spec['sourceAmiId'],'foundation no longer uses the promoted source AMI')
        expected=spec['amiId'] if phase=='foundation' and key=='HostAmiId' else p.get('ParameterValue')
        need(target.get('ParameterValue',p.get('ParameterValue') if target.get('UsePreviousValue') else None)==expected and target.get('ResolvedValue')==p.get('ResolvedValue'),'parameter or resolved SSM drift')
    seen=set()
    for change in cs['Changes']:
        need(change['Type']=='Resource','non-resource change refused')
        r=change['ResourceChange'];logical=r['LogicalResourceId']
        need(logical in allowed and logical not in seen,'unreviewed/duplicate resource change');seen.add(logical)
        expected=allowed[logical];resource=(before if expected['action']=='Remove' else after)['Resources'][logical]
        need(r['Action']==expected['action'] and r['ResourceType']==resource['Type'],'change-set action/type mismatch')
        if expected['action']=='Modify':
            immutable=resource['Type']=='AWS::StepFunctions::StateMachineVersion'
            # A dependent version replacement is 'Conditional' on the referenced revision (seen live 2026-10-22).
            need(r.get('Replacement') in (('True','Conditional') if immutable else ('False',)),'unexpected resource replacement')
            for detail in r.get('Details',[]):
                need(detail['Target'].get('RequiresRecreation') in (('Always',) if immutable else ('Never',)), 'unexplained property recreation')
                need(detail.get('ChangeSource') in ('DirectModification','ResourceReference','ResourceAttribute','ParameterReference'), 'unexplained property cause')
                if detail.get('ChangeSource')=='ParameterReference':
                    need(phase=='foundation' and detail.get('CausingEntity')=='HostAmiId','unapproved parameter dependency')
            targets={(d['Target'].get('Attribute'),d['Target'].get('Name')) for d in r.get('Details',[])}
            wanted={('Properties',p) for p in expected['properties']} | {(p,None) for p in expected['attributes']}
            need(targets==wanted,'change-set property details differ from exact review')
            need(set(r.get('Scope',[]))==({'Properties'} if expected['properties'] else set()) | set(expected['attributes']),'change-set scope mismatch')
        else:
            need(not r.get('Details') and not r.get('Scope'),'unexpected add/remove details')
    # With --include-property-values CloudFormation leaves out a dependent version's Dynamic
    # StateMachineRevisionId replacement (seen live 2026-10-22); the plain view must still list it.
    omitted=set(allowed)-seen
    if omitted:
        need(all(allowed[l]==DEPENDENT_VERSION and after['Resources'][l]['Type']=='AWS::StepFunctions::StateMachineVersion' for l in omitted),'change-set omits reviewed changes')
        plain=aws('cloudformation','describe-change-set','--stack-name',spec['stackName'],'--change-set-name',spec['changeSetArn'])
        need(plain['ChangeSetId']==spec['changeSetArn'] and not plain.get('NextToken'),'change-set identity/pagination mismatch')
        for change in plain['Changes']:
            r=change['ResourceChange']
            if r['LogicalResourceId'] not in omitted:continue
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
