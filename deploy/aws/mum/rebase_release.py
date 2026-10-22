#!/usr/bin/env python3
"""Nonsecret plan and final evidence handling for the staged rebase release."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
from pathlib import Path
import re
import subprocess
import sys

import rebase_manifest as manifest
import rebase_schema
import rebase_ssm
import rebase_app
import rebase_cloudformation as cfn
import json

spec = importlib.util.spec_from_file_location('mum_json', Path(__file__).with_name('json-tool.py'))
json_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(json_tool)
need = manifest.need
REPO = Path(__file__).resolve().parents[3]
BAKE_KEYS = ('schemaVersion', 'accountId', 'region', 'namespace', 'recipeVersion', 'lowerImageDigest',
             'lowerImageRef', 'previousLowerImageDigest', 'previousLowerImageRef', 'agentCommit')
PLAN_KEYS = ('schemaVersion', 'accountId', 'region', 'namespace', 'bake', 'buildArn', 'amiId',
             'configPath', 'configSha256', 'identityConfigPath', 'identityConfigSha256', 'schemaPath', 'schemaSha256', 'databaseSystemIdentifier', 'maintenance', 'rollout', 'evidence')
VERSION_KEYS = ('stateMachineVersionArn', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn')


def safe_path(path):
    path = Path(path)
    need(path.is_absolute() and path.is_file() and not path.is_symlink(), 'regular absolute artifact path required')
    return path


def digest(path):
    return hashlib.sha256(safe_path(path).read_bytes()).hexdigest()


def staging(config):
    d = config['settings']['deployment']
    need((d['accountId'], d['region'], d['namespace']) == (json_tool.ACCOUNT, json_tool.REGION, 'mum'), 'staging deployment identity mismatch')
    need(config['settings'].get('authorityOrigin') == 'https://os-staging.ezil.work', 'staging authority origin required; btgq/curomaa refused')
    json_tool.pair(config)
    return d


def bake_evidence(directory):
    bake = manifest.read(directory / 'bake-inputs.json', 16384)
    need(isinstance(bake, dict) and set(bake) == set(BAKE_KEYS), 'bake evidence fields mismatch')
    image = manifest.read(directory / 'image.json')
    need(len(image['Images']) == 1, 'one baked AMI required')
    ami = image['Images'][0]['ImageId']
    json_tool.main(['image', str(directory / 'image.json'), ami])
    build_arn = safe_path(directory / 'build-arn.txt').read_text().strip()
    need(manifest.matches(r'arn:aws:imagebuilder:ap-south-1:452630323510:image/ezil-host-mum/[0-9]+\.[0-9]+\.[0-9]+/[1-9][0-9]*', build_arn), 'build ARN mismatch')
    return bake, ami, build_arn


def make_plan(directory, config_path, identity_path, system_id=None, rollout_path=None):
    directory = Path(directory).resolve()
    config_path, identity_path = safe_path(config_path), safe_path(identity_path)
    config = manifest.read(config_path)
    deployment = staging(config)
    identity = manifest.read(identity_path)
    need((identity['accountId'], identity['region'], identity['namespace']) == (json_tool.ACCOUNT, json_tool.REGION, 'mum'), 'staging identity config mismatch')
    need(system_id is None or manifest.matches(r'[0-9]{1,20}', system_id), 'independently verified DB system identifier required')
    bake, ami, build_arn = bake_evidence(directory)
    maintenance = (directory / 'maintenance-source-release.json').is_file()
    # Draft references can be desired versions, but no manifest is made until published readbacks.
    candidate = {**bake, **{k: deployment[k] for k in (*VERSION_KEYS, 'launchTemplateId', 'launchTemplateVersion')},
                 'amiId': ami, 'createdAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
    manifest.validate(candidate, target=not maintenance, repository=json_tool.REPOSITORY)
    need(all(deployment[k] == candidate[k] for k in (*manifest.PROMOTION, 'launchTemplateId')), 'desired deployment and bake disagree')
    schema = (REPO / 'docs/aws-computers/sql/0002_image_rebase.sql.txt').resolve()
    source_name = 'maintenance-source-release.json' if maintenance else 'previous-rebase-release.json'
    evidence = {name: digest(directory / name) for name in ('bake-inputs.json', 'build-arn.txt', 'build.json', 'image.json', source_name)}
    source = manifest.load(directory / source_name, source=True, repository=json_tool.REPOSITORY)
    if maintenance:
        need(bake['previousLowerImageDigest'] is None and bake['previousLowerImageRef'] is None, 'maintenance previous must be null')
        need(source['lowerImageDigest'] == bake['lowerImageDigest'] and source['agentCommit'] != bake['agentCommit'], 'maintenance source lower/new agent mismatch')
    else:
        need((source['lowerImageDigest'], source['lowerImageRef']) == (bake['previousLowerImageDigest'], bake['previousLowerImageRef']), 'source release and bake disagree')
    plan = dict(zip(PLAN_KEYS, (1, json_tool.ACCOUNT, json_tool.REGION, 'mum', bake, build_arn, ami,
        str(config_path), digest(config_path), str(identity_path), digest(identity_path), str(schema), digest(schema), system_id, maintenance, pin_rollout(rollout_path, bake) if rollout_path else None, evidence)))
    path = directory / 'rebase-plan.json'
    if path.exists():
        need(manifest.read(path) == plan, 'existing plan differs; retain the release and use a new directory')
    else:
        json_tool.write(path, plan)
    print(f'Reviewed plan: {path}')


def load_plan(path):
    path = safe_path(path)
    plan = manifest.read(path, 65536)
    need(isinstance(plan, dict) and set(plan) == set(PLAN_KEYS) and type(plan['schemaVersion']) is int and plan['schemaVersion'] == 1, 'invalid plan schema')
    need((plan['accountId'], plan['region'], plan['namespace']) == (json_tool.ACCOUNT, json_tool.REGION, 'mum'), 'staging plan identity mismatch')
    need(plan['schemaPath'] == str((REPO / 'docs/aws-computers/sql/0002_image_rebase.sql.txt').resolve()), 'unreviewed schema path')
    for field in ('config', 'identityConfig', 'schema'):
        need(digest(plan[field + 'Path']) == plan[field + 'Sha256'], 'reviewed input changed: ' + field)
    need(type(plan['maintenance']) is bool and (plan['databaseSystemIdentifier'] is None or manifest.matches(r'[0-9]{1,20}', plan['databaseSystemIdentifier'])), 'invalid release mode or database identity')
    source_name = 'maintenance-source-release.json' if plan['maintenance'] else 'previous-rebase-release.json'
    need(set(plan['evidence']) == {'bake-inputs.json', 'build-arn.txt', 'build.json', 'image.json', source_name}, 'plan evidence fields mismatch')
    for name, expected in plan['evidence'].items():
        need(digest(path.parent / name) == expected, 'bake evidence changed')
    bake, ami, build_arn = bake_evidence(path.parent)
    need(plan['bake'] == bake and plan['amiId'] == ami and plan['buildArn'] == build_arn, 'plan bake mismatch')
    staging(manifest.read(plan['configPath']))
    if plan['rollout'] is not None:
        verify_rollout(plan['rollout'])
    return plan


def aws(*args):
    # Only reviewed nonsecret readbacks. No SDK/default provider or credential file reads here.
    result = subprocess.run(['aws', '--profile', 'ezil-admin', '--region', json_tool.REGION, '--no-cli-pager', *args, '--output', 'json'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
    need(result.returncode == 0, 'AWS readback failed (provider details suppressed)')
    need(len(result.stdout) <= 4 * 1024 * 1024, 'AWS readback too large')
    return manifest.loads(result.stdout.decode('utf-8')) if result.stdout.strip() else {}


def readbacks(plan):
    deployment = staging(manifest.read(plan['configPath']))
    return {
        'build': aws('imagebuilder', 'get-image', '--image-build-version-arn', plan['buildArn']),
        'image': aws('ec2', 'describe-images', '--image-ids', plan['amiId'], '--owners', json_tool.ACCOUNT),
        'template': aws('ec2', 'describe-launch-template-versions', '--launch-template-id', deployment['launchTemplateId'], '--versions', deployment['launchTemplateVersion']),
        'versions': {key: aws('stepfunctions', 'list-state-machine-versions', '--state-machine-arn', deployment[key].rsplit(':', 1)[0]) for key in VERSION_KEYS},
        'workflows': {key: aws('stepfunctions', 'describe-state-machine', '--state-machine-arn', deployment[key]) for key in VERSION_KEYS},
    }


def final_manifest(plan, evidence, now=None):
    deployment = staging(manifest.read(plan['configPath']))
    value = manifest.validate({**plan['bake'], 'amiId': plan['amiId'],
        **{k: deployment[k] for k in (*VERSION_KEYS, 'launchTemplateId', 'launchTemplateVersion')},
        'createdAt': now or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}, target=not plan.get('maintenance', False), repository=json_tool.REPOSITORY)
    need(all(deployment[k] == value[k] for k in (*manifest.PROMOTION, 'launchTemplateId')), 'manifest/deployment mismatch')
    build = evidence['build']['image']
    need(build['arn'] == plan['buildArn'] and build['state']['status'] == 'AVAILABLE', 'bake not available')
    amis = build['outputResources']['amis']
    need(len(amis) == 1 and amis[0]['image'] == value['amiId'] and amis[0]['region'] == value['region'] and amis[0].get('accountId', value['accountId']) == value['accountId'], 'build output identity mismatch')
    recipe = build['imageRecipe']
    need(recipe['version'] == value['recipeVersion'] and recipe['name'] == 'ezil-host-mum', 'bake recipe mismatch')
    need(len(recipe['components']) == 1, 'unexpected bake components')
    bindings = recipe['components'][0]['parameters']
    params = {v['name']: v['value'] for v in bindings}
    need(len(params) == len(bindings), 'duplicate component binding')
    for key, expected in {'DesktopImageRef': value['lowerImageRef'], 'DesktopImageId': value['lowerImageDigest'],
                          'PreviousDesktopImageRef': value['previousLowerImageRef'], 'PreviousDesktopImageId': value['previousLowerImageDigest'],
                          'AgentSrcS3Uri': f"s3://ezil-mum-deploy-assets-452630323510/ami/host-agent-{value['agentCommit']}.tgz"}.items():
        need(params.get(key) == [expected if expected is not None else ''], 'bake binding mismatch: ' + key)
    images = evidence['image']['Images']
    need(not evidence['image'].get('NextToken') and len(images) == 1, 'AMI readback incomplete')
    image = images[0]
    need(all(image.get(k) == v for k, v in {'ImageId': value['amiId'], 'OwnerId': value['accountId'], 'State': 'available', 'Architecture': 'x86_64', 'Public': False}.items()), 'AMI readback mismatch')
    templates = evidence['template']['LaunchTemplateVersions']
    need(not evidence['template'].get('NextToken') and len(templates) == 1, 'launch-template readback incomplete')
    template = templates[0]
    need(template['LaunchTemplateId'] == value['launchTemplateId'] and type(template['VersionNumber']) is int and str(template['VersionNumber']) == value['launchTemplateVersion'] and template['LaunchTemplateData']['ImageId'] == value['amiId'], 'launch-template tuple mismatch')
    for key in VERSION_KEYS:
        versions = evidence['versions'][key]
        need(not versions.get('nextToken'), 'workflow version readback incomplete')
        need(value[key] in [v['stateMachineVersionArn'] for v in versions['stateMachineVersions']], 'workflow version is not published')
        workflow = evidence['workflows'][key]
        need(workflow['stateMachineArn'] in (value[key], value[key].rsplit(':', 1)[0]) and workflow['type'] == 'STANDARD' and workflow['status'] == 'ACTIVE', 'workflow readback mismatch')
    return value


def finalize(path, apply):
    plan = load_plan(path)
    for phase in ('apply-schema', 'apply-identity', 'apply-workflows'):
        require_receipt(path, phase)
    evidence = readbacks(plan)
    target = Path(path).parent / 'rebase-release.json'
    existing = manifest.load(target, target=not plan['maintenance'], repository=json_tool.REPOSITORY) if target.exists() else None
    value = final_manifest(plan, evidence, existing['createdAt'] if existing else None)
    need(existing is None or existing == value, 'final manifest is immutable; use another release directory')
    # Recheck pinned inputs after potentially slow readbacks.
    need(load_plan(path) == plan, 'plan changed during finalization')
    if apply:
        json_tool.write(Path(path).parent / 'rebase-readbacks.json', evidence)
        if existing is None:
            json_tool.write(target, value)
        print(f'Final manifest verified: {target}')
    else:
        print('DRY RUN: final evidence verified; add --apply to write rebase-release.json')



def apply_schema(path, apply):
    plan = load_plan(path)
    system_id = plan['databaseSystemIdentifier']
    need(system_id is not None, 'plan requires --expect-system-id independently observed on the preview DB host')
    sql = safe_path(plan['schemaPath']).read_bytes()
    body = rebase_schema.body(sql, system_id)
    receipt = rebase_ssm.run(Path(path).parent, 'apply-schema', body, apply, aws, json_tool.write)
    need(load_plan(path) == plan, 'plan changed during schema application')
    if receipt is not None:
        rebase_schema.validate_receipt(receipt, sql, system_id)
        json_tool.write(Path(path).parent / 'apply-schema-receipt.json', {'planSha256': digest(path), 'evidence': receipt})
        print('Staging schema verified; receipt retained')



def pin_rollout(path, bake):
    value=manifest.read(safe_path(path))
    need(set(value)=={'schemaVersion','stacks','app'} and type(value['schemaVersion']) is int and value['schemaVersion']==1,'invalid rollout review')
    need(set(value['stacks'])==set(cfn.STACKS),'all three stack reviews required')
    for phase,spec in value['stacks'].items():
        need(set(spec)=={'stackName','changeSetArn','roleArn','beforeTemplatePath','candidateTemplatePath','reviewPath'},'invalid stack review fields')
        need(spec['stackName']==cfn.STACKS[phase] and manifest.matches(r'arn:aws:cloudformation:ap-south-1:452630323510:changeSet/[A-Za-z0-9-]+/[a-zA-Z0-9-]+',spec['changeSetArn']),'invalid staged change set identity')
        for name in ('beforeTemplate','candidateTemplate','review'):
            spec[name+'Path']=str(safe_path(spec[name+'Path']))
            spec[name+'Sha256']=digest(spec[name+'Path'])
        cfn.validate_templates(phase,manifest.read(spec['beforeTemplatePath']),manifest.read(spec['candidateTemplatePath']),manifest.read(spec['reviewPath']))
    app=value['app']
    need(set(app)=={'tag','gitSha','checksumSha256'},'invalid app review fields')
    need(app['gitSha']==bake['agentCommit'],'app and host must use the same reviewed integrated source commit')
    installer=REPO/'deploy/aws/os-staging/install-host.sh'
    rebase_app.body(safe_path(installer).read_text(),app,install=False)
    value['installerSha256']=digest(installer)
    return value


def verify_rollout(value):
    for phase,spec in value['stacks'].items():
        for name in ('beforeTemplate','candidateTemplate','review'):
            need(digest(spec[name+'Path'])==spec[name+'Sha256'],'rollout artifact changed')
        cfn.validate_templates(phase,manifest.read(spec['beforeTemplatePath']),manifest.read(spec['candidateTemplatePath']),manifest.read(spec['reviewPath']))
    need(digest(REPO/'deploy/aws/os-staging/install-host.sh')==value['installerSha256'],'staging installer changed')


def write_receipt(path,phase,evidence):
    json_tool.write(Path(path).parent/(phase+'-receipt.json'),{'planSha256':digest(path),'evidence':evidence})


def require_receipt(path,phase):
    receipt=manifest.read(safe_path(Path(path).parent/(phase+'-receipt.json')))
    need(set(receipt)=={'planSha256','evidence'} and receipt['planSha256']==digest(path),'phase receipt does not match plan: '+phase)
    evidence=receipt['evidence'];plan=load_plan(path)
    if phase=='apply-schema':
        rebase_schema.validate_receipt(evidence,safe_path(plan['schemaPath']).read_bytes(),plan['databaseSystemIdentifier'])
    elif phase in ('apply-identity','apply-workflows'):
        need(plan['rollout'] is not None,'cloud receipt requires pinned rollout')
        names=('identity',) if phase=='apply-identity' else ('foundation','workflows')
        need(set(evidence)==set(names) | ({'readbacks'} if phase=='apply-workflows' else set()),'invalid cloud receipt fields')
        for name in names:
            expected=plan['rollout']['stacks'][name]
            need(evidence[name]=={'changeSetArn':expected['changeSetArn'],'candidateSha256':expected['candidateTemplateSha256'],'status':'complete'},'invalid cloud completion evidence')
        if phase=='apply-workflows':final_manifest(plan,evidence['readbacks'])
    elif phase=='apply-app':
        need(evidence['gitSha']==plan['rollout']['app']['gitSha'] and evidence['killSwitch']=='1','invalid app compatibility receipt')
    return evidence


def secret_deployment(envelope):
    outer=manifest.loads(envelope['SecretString'])
    rebase_app.gate(outer)
    ds=manifest.loads(outer[json_tool.KEY]) if isinstance(outer[json_tool.KEY],str) else outer[json_tool.KEY]
    d=ds[json_tool.REGION]
    need((d['accountId'],d['region'],d['namespace'],d['launchTemplateId'])==(json_tool.ACCOUNT,json_tool.REGION,'mum',json_tool.LAUNCH_TEMPLATE),'secret deployment identity mismatch')
    manifest.deployment_tuple(d)
    return outer,d



def static_deployment(plan,d):
    desired=staging(manifest.read(plan['configPath']))
    keys=(rebase_app.public_deployment(d).keys() | rebase_app.public_deployment(desired).keys()) - set(manifest.PROMOTION) - {'releases'}
    need(all(d.get(k)==desired.get(k) for k in keys),'deployment network/storage/identity changed outside the promotion tuple')

def app_operation(path,plan,operation,apply,expected=None,install=True):
    need(plan['rollout'] is not None,'plan requires --rollout with reviewed staged change sets and app artifact')
    body=rebase_app.body(safe_path(REPO/'deploy/aws/os-staging/install-host.sh').read_text(),plan['rollout']['app'],expected,install)
    result=rebase_ssm.run(Path(path).parent,operation,body,apply,aws,json_tool.write,fresh=not install)
    if result is not None:
        need(result['killSwitch']=='1','app admission gate is not active')
        if install:need(result['gitSha']==plan['rollout']['app']['gitSha'],'installed app commit mismatch')
        if expected is not None:need(result['deployment']==expected,'running app deployment mismatch')
        if install:
            observed=app_operation(path,plan,operation+'-verify',True,expected,install=False)
            need(observed['gitSha']==plan['rollout']['app']['gitSha'],'current app source commit changed')
            result=observed
    return result


def apply_cloud(path,phase,apply):
    plan=load_plan(path)
    need(plan['rollout'] is not None,'reviewed rollout artifacts required')
    require_receipt(path,'apply-schema')
    if phase=='apply-workflows':require_receipt(path,'apply-identity')
    with json_tool.app_secret_lock() as fd:
        envelope=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        _,d=secret_deployment(envelope)
        static_deployment(plan,d)
        # Verify the running app is gated, not merely a pending secret update.
        app_operation(path,plan,phase+'-gate',apply,install=False)
        results={}
        for name in (('identity',) if phase=='apply-identity' else ('foundation','workflows')):
            spec=dict(plan['rollout']['stacks'][name],amiId=plan['amiId'],sourceAmiId=d['amiId'])
            results[name]=cfn.execute(name,spec,Path(path).parent,apply,aws,json_tool.write,digest)
        if apply and phase=='apply-workflows':
            evidence=readbacks(plan);final_manifest(plan,evidence)
            source_name='maintenance-source-release.json' if plan['maintenance'] else 'previous-rebase-release.json'
            source=manifest.load(Path(path).parent/source_name,source=True,repository=json_tool.REPOSITORY)
            prior=aws('ec2','describe-launch-template-versions','--launch-template-id',source['launchTemplateId'],'--versions',source['launchTemplateVersion'])['LaunchTemplateVersions']
            need(len(prior)==1,'source launch template missing')
            a=prior[0]['LaunchTemplateData'];b=evidence['template']['LaunchTemplateVersions'][0]['LaunchTemplateData']
            need(a['ImageId']==source['amiId'] and {k:v for k,v in a.items() if k!='ImageId'}=={k:v for k,v in b.items() if k!='ImageId'},'foundation launch data changed outside AMI')
            results['readbacks']=evidence
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'],'app secret changed during rollout')
    need(load_plan(path)==plan,'plan changed during cloud deployment')
    if apply:write_receipt(path,phase,results)


def apply_app(manifest_path,apply):
    path=Path(manifest_path).parent/'rebase-plan.json';plan=load_plan(path)
    value=manifest.load(manifest_path,target=not plan['maintenance'],repository=json_tool.REPOSITORY)
    need(final_manifest(plan,readbacks(plan),value['createdAt'])==value,'final manifest readbacks changed')
    for phase in ('apply-schema','apply-identity','apply-workflows'):require_receipt(path,phase)
    with json_tool.app_secret_lock() as fd:
        envelope=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        _,d=secret_deployment(envelope)
        static_deployment(plan,d)
        result=app_operation(path,plan,'apply-app',apply,rebase_app.public_deployment(d))
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'],'secret changed during app deployment')
    need(load_plan(path)==plan,'plan changed during app deployment')
    if apply:write_receipt(path,'apply-app',result)


def source_readbacks(value):
    image=aws('ec2','describe-images','--image-ids',value['amiId'],'--owners',json_tool.ACCOUNT)['Images']
    need(len(image)==1 and all(image[0].get(k)==v for k,v in {'ImageId':value['amiId'],'OwnerId':json_tool.ACCOUNT,'Public':False,'State':'available','Architecture':'x86_64'}.items()),'rollback AMI mismatch')
    versions=aws('ec2','describe-launch-template-versions','--launch-template-id',value['launchTemplateId'],'--versions',value['launchTemplateVersion'])['LaunchTemplateVersions']
    need(len(versions)==1 and str(versions[0]['VersionNumber'])==value['launchTemplateVersion'] and versions[0]['LaunchTemplateId']==value['launchTemplateId'] and versions[0]['LaunchTemplateData']['ImageId']==value['amiId'],'rollback launch template mismatch')
    for key in VERSION_KEYS:
        if value[key] is None:continue
        versions=aws('stepfunctions','list-state-machine-versions','--state-machine-arn',value[key].rsplit(':',1)[0])
        need(not versions.get('nextToken') and value[key] in [v['stateMachineVersionArn'] for v in versions['stateMachineVersions']],'rollback version missing')
        workflow=aws('stepfunctions','describe-state-machine','--state-machine-arn',value[key])
        need(workflow['type']=='STANDARD' and workflow['status']=='ACTIVE' and workflow['stateMachineArn'] in (value[key],value[key].rsplit(':',1)[0]),'rollback workflow mismatch')


def promote(manifest_path,apply,rollback=False):
    path=Path(manifest_path).parent/'rebase-plan.json';plan=load_plan(path)
    need(not plan['maintenance'],'maintenance releases are source artifacts; do not authorize a rebase target')
    target=manifest.load(manifest_path,target=True,repository=json_tool.REPOSITORY)
    if not rollback:
        need(final_manifest(plan,readbacks(plan),target['createdAt'])==target,'target manifest no longer matches readbacks')
    for phase in ('apply-schema','apply-identity','apply-workflows','apply-app'):require_receipt(path,phase)
    source=manifest.load(Path(path).parent/'previous-rebase-release.json',source=True,repository=json_tool.REPOSITORY)
    source_readbacks(source)
    journal_path=Path(path).parent/'rebase-promotion.json'
    journal=manifest.read(journal_path) if journal_path.exists() else None
    if journal and not rollback:need(journal['status']!='rolled-back','release was rolled back; a new promotion requires a new reviewed plan')
    if journal:need(journal['planSha256']==digest(path) and journal['source']==source and journal['target']==target,'promotion journal drift')
    need(not rollback or journal is not None,'rollback requires the durable promotion journal')
    with json_tool.app_secret_lock() as fd:
        envelope=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        _,d=secret_deployment(envelope)
        static_deployment(plan,d)
        current=json_tool.pair({'settings':{'deployment':d}})
        if journal is None:
            keys=manifest.PROMOTION if set(manifest.TUPLE)<=d.keys() else manifest.PROMOTION[:3]
            need(all(d[k]==source[k] for k in (*keys,'accountId','region','namespace','launchTemplateId')),'source is not the last promoted release')
            journal={'schemaVersion':1,'planSha256':digest(path),'source':source,'target':target,'before':current,
                     'after':{k:target[k] for k in manifest.PROMOTION},'beforeDeployment':rebase_app.public_deployment(d),'status':'planned'}
        before,after=(journal['after'],journal['before']) if rollback else (journal['before'],journal['after'])
        need(current in (before,after),'complete deployment tuple drift')
        updated=json_tool.edit_release_secret(envelope,before,after,[source,target])
        _,next_d=secret_deployment({'SecretString':json.dumps(updated)})
        journal['rollbackDeployment' if rollback else 'afterDeployment']=rebase_app.public_deployment(next_d)
        if not apply:
            print('DRY RUN: complete tuple and retained release registry verified under secret lock');return
        journal['status']='rollback-pending' if rollback else 'promotion-pending';json_tool.write(journal_path,journal)
        # Recheck every pinned input before the only secret write.
        need(load_plan(path)==plan,'plan changed before promotion')
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'],'secret changed before CAS')
        if manifest.loads(envelope['SecretString'])!=updated:
            result=json_tool.secret_aws(['put-secret-value','--cli-input-json','file:///dev/stdin','--output','json'],json.dumps({'SecretId':json_tool.SECRET,'SecretString':json.dumps(updated,separators=(',',':'))}),lock_fd=fd)
            envelope=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
            need(envelope['VersionId']==result['VersionId'] and manifest.loads(envelope['SecretString'])==updated,'secret verification failed; admission remains gated')
        app_operation(path,plan,'rollback-app' if rollback else 'promote-app',True,rebase_app.public_deployment(next_d))
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'] and manifest.loads(check['SecretString'])==updated,'app secret drift after restart')
        journal['status']='rolled-back' if rollback else 'promoted';json_tool.write(journal_path,journal)
    print('Full deployment tuple and registry verified; admission remains gated for the lead canary')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('plan', 'finalize', 'apply-schema', 'apply-identity', 'apply-workflows', 'apply-app', 'promote-canary', 'rollback'))
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--config', type=Path, default=Path('/root/ezil-aws-mum/config/lifecycle.mum.json'))
    parser.add_argument('--identity-config', type=Path, default=Path('/root/ezil-aws-mum/config/identity.mum.json'))
    parser.add_argument('--expect-system-id')
    parser.add_argument('--rollout', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.operation == 'plan':
        need(args.release_dir is not None and args.plan is None and args.manifest is None, 'plan requires --release-dir')
        make_plan(args.release_dir, args.config, args.identity_config, args.expect_system_id, args.rollout)
    elif args.operation == 'apply-schema':
        need(args.plan is not None and args.manifest is None, 'apply-schema requires --plan')
        apply_schema(args.plan, args.apply)
    elif args.operation == 'finalize':
        need(args.plan is not None and args.manifest is None, 'finalize requires --plan')
        finalize(args.plan, args.apply)
    elif args.operation in ('apply-identity','apply-workflows'):
        need(args.plan is not None and args.manifest is None,'cloud deployment requires --plan')
        apply_cloud(args.plan,args.operation,args.apply)
    elif args.operation=='apply-app':
        need(args.manifest is not None and args.plan is None,'apply-app requires --manifest')
        apply_app(args.manifest,args.apply)
    else:
        need(args.manifest is not None and args.plan is None,'promotion/rollback requires --manifest')
        promote(args.manifest,args.apply,args.operation=='rollback')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        print('ERROR: release refused; check reviewed inputs, staging identity and published readbacks. Inspect retained phase journals before retrying.', file=sys.stderr)
        sys.exit(1)
