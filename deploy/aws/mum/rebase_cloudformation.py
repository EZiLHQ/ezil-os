"""Execute pre-staged, explicitly reviewed CloudFormation change sets.

The review binds every changed property to exact before/candidate template bytes.
This is the initial image-rebase rollout, separate from the narrower AMI-only
promoter. It never creates a change set, publishes unreviewed assets, or deletes a
stack. The lead stages assets/change sets from the reviewed integrated synthesis.
"""
import json
from pathlib import Path
import time

import rebase_manifest as manifest

need = manifest.need
STACKS = {'identity':'ezil-identity-mum','foundation':'ezil-mum-foundation','workflows':'ezil-mum-lifecycle'}
ROLE = 'arn:aws:iam::452630323510:role/ezil/identity/ezil-mum-cfn-exec'
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




def without_snapshot_read(value):
    if isinstance(value,list):return [without_snapshot_read(v) for v in value if not (isinstance(v,dict) and v.get('Effect')=='Allow' and action_set(v)=={'ec2:DescribeSnapshots'})]
    if isinstance(value,dict):
        return {k:([a for a in v if a!='ec2:DescribeSnapshots'] if k=='Action' and isinstance(v,list) and value.get('Effect')=='Allow' else without_snapshot_read(v)) for k,v in value.items()}
    return value


def includes_deny(candidates,deny):
    return any({k:v for k,v in s.items() if k!='Action'}=={k:v for k,v in deny.items() if k!='Action'} and action_set(s)>=action_set(deny) for s in candidates)

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
    old,new=before['Resources'],after['Resources'];actual={}
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
        need(kind in TYPES or phase=='foundation' and kind=='AWS::EC2::LaunchTemplate','storage/network/unrelated resource change refused')
        if phase=='identity':
            boundary_policy=kind=='AWS::IAM::ManagedPolicy' and (logical.startswith('Boundary') or logical.startswith('ImageJobBoundary'))
            if logical.startswith('Boundary'):
                need(left and right and without_snapshot_read(left)==without_snapshot_read(right),'shared boundary change exceeds DescribeSnapshots')
            need(boundary_policy or left and right and kind.startswith('AWS::IAM::') and image_boundary_condition(left)==right,'identity change is not the reviewed A2 boundary or exact role-write condition expansion')
        if phase=='foundation':
            need(logical=='ComputerLaunchTemplate' and left and right,'foundation resource change refused')
        if left is None:
            need(kind not in ('AWS::KMS::Key','AWS::IAM::ManagedPolicy') or phase=='identity','unreviewed key or policy addition')
            actual[logical]={'action':'Add','properties':[],'attributes':[]}
        elif right is None:
            need(kind in ('AWS::Lambda::Version','AWS::StepFunctions::StateMachineVersion') and left.get('DeletionPolicy')=='Retain','resource removal requires retained immutable version')
            actual[logical]={'action':'Remove','properties':[],'attributes':[]}
        else:
            need(left['Type']==right['Type'],'resource type change refused')
            props=sorted(k for k in left.get('Properties',{}).keys() | right.get('Properties',{}).keys() if left.get('Properties',{}).get(k)!=right.get('Properties',{}).get(k))
            attrs=sorted(k for k in left.keys() | right.keys() if k!='Properties' and left.get(k)!=right.get(k))
            need(not any(k in attrs for k in ('DeletionPolicy','UpdateReplacePolicy','Condition')),'resource retention/condition change refused')
            if phase=='foundation':need(props==['LaunchTemplateData'] and not attrs,'foundation changes only launch-template AMI')
            actual[logical]={'action':'Modify','properties':props,'attributes':attrs}
        if kind in ('AWS::StepFunctions::StateMachineVersion','AWS::Logs::LogGroup') and right:
            need(right.get('DeletionPolicy')=='Retain' and right.get('UpdateReplacePolicy')=='Retain','workflow versions/logs must be retained')
        if left and right and kind.startswith('AWS::IAM::'):
            old_statements=list(statements(left));new_statements=list(statements(right))
            for deny in (s for s in old_statements if s.get('Effect')=='Deny'):
                need(any({k:v for k,v in s.items() if k!='Action'}=={k:v for k,v in (image_boundary_condition(deny) if phase=='identity' and image_boundary_condition(left)==right else deny).items() if k!='Action'} and action_set(s)>=action_set(deny) for s in new_statements),'existing IAM deny weakened')
        if right and kind.startswith('AWS::IAM::'):
            old_allows=[s for s in statements(image_boundary_condition(left) if phase=='identity' and image_boundary_condition(left)==right else left) if s.get('Effect')=='Allow'] if left else []
            for statement in (s for s in statements(right) if s.get('Effect')=='Allow' and s not in old_allows):
                need('NotAction' not in statement and 'NotResource' not in statement,'inverse IAM grants refused')
                added=action_set(statement)
                need(not (added & FORBIDDEN) and '*' not in added and not any('*' in action and not any(action in action_set(s) for s in old_allows) for action in added),'unreviewed destructive/wildcard IAM grants')
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
    previous={p['ParameterKey']:p for p in stack.get('Parameters',[])}
    actual={p['ParameterKey']:p for p in cs.get('Parameters',[])}
    need(len(previous)==len(stack.get('Parameters',[])) and len(actual)==len(cs.get('Parameters',[])) and previous.keys()==actual.keys(),'parameter coverage mismatch')
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
            need(r.get('Replacement')==('True' if immutable else 'False'),'unexpected resource replacement')
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
    need(seen==set(allowed),'change-set omits reviewed changes')
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
