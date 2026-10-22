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

spec = importlib.util.spec_from_file_location('mum_json', Path(__file__).with_name('json-tool.py'))
json_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(json_tool)
need = manifest.need
REPO = Path(__file__).resolve().parents[3]
BAKE_KEYS = ('schemaVersion', 'accountId', 'region', 'namespace', 'recipeVersion', 'lowerImageDigest',
             'lowerImageRef', 'previousLowerImageDigest', 'previousLowerImageRef', 'agentCommit')
PLAN_KEYS = ('schemaVersion', 'accountId', 'region', 'namespace', 'bake', 'buildArn', 'amiId',
             'configPath', 'configSha256', 'identityConfigPath', 'identityConfigSha256', 'schemaPath', 'schemaSha256', 'evidence')
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


def make_plan(directory, config_path, identity_path):
    directory = Path(directory).resolve()
    config_path, identity_path = safe_path(config_path), safe_path(identity_path)
    config = manifest.read(config_path)
    deployment = staging(config)
    identity = manifest.read(identity_path)
    need((identity['accountId'], identity['region'], identity['namespace']) == (json_tool.ACCOUNT, json_tool.REGION, 'mum'), 'staging identity config mismatch')
    bake, ami, build_arn = bake_evidence(directory)
    # Draft references can be desired versions, but no manifest is made until published readbacks.
    candidate = {**bake, **{k: deployment[k] for k in (*VERSION_KEYS, 'launchTemplateId', 'launchTemplateVersion')},
                 'amiId': ami, 'createdAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
    manifest.validate(candidate, target=True, repository=json_tool.REPOSITORY)
    need(all(deployment[k] == candidate[k] for k in (*manifest.PROMOTION, 'launchTemplateId')), 'desired deployment and bake disagree')
    schema = (REPO / 'docs/aws-computers/sql/0002_image_rebase.sql.txt').resolve()
    evidence = {name: digest(directory / name) for name in ('bake-inputs.json', 'build-arn.txt', 'build.json', 'image.json', 'previous-rebase-release.json')}
    source = manifest.load(directory / 'previous-rebase-release.json', repository=json_tool.REPOSITORY)
    need((source['lowerImageDigest'], source['lowerImageRef']) == (bake['previousLowerImageDigest'], bake['previousLowerImageRef']), 'source release and bake disagree')
    plan = dict(zip(PLAN_KEYS, (1, json_tool.ACCOUNT, json_tool.REGION, 'mum', bake, build_arn, ami,
        str(config_path), digest(config_path), str(identity_path), digest(identity_path), str(schema), digest(schema), evidence)))
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
    need(set(plan['evidence']) == {'bake-inputs.json', 'build-arn.txt', 'build.json', 'image.json', 'previous-rebase-release.json'}, 'plan evidence fields mismatch')
    for name, expected in plan['evidence'].items():
        need(digest(path.parent / name) == expected, 'bake evidence changed')
    bake, ami, build_arn = bake_evidence(path.parent)
    need(plan['bake'] == bake and plan['amiId'] == ami and plan['buildArn'] == build_arn, 'plan bake mismatch')
    staging(manifest.read(plan['configPath']))
    return plan


def aws(*args):
    # Only reviewed nonsecret readbacks. No SDK/default provider or credential file reads here.
    result = subprocess.run(['aws', '--profile', 'ezil-admin', '--region', json_tool.REGION, '--no-cli-pager', *args, '--output', 'json'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
    need(result.returncode == 0, 'AWS readback failed (provider details suppressed)')
    need(len(result.stdout) <= 4 * 1024 * 1024, 'AWS readback too large')
    return manifest.loads(result.stdout.decode('utf-8'))


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
        'createdAt': now or datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}, target=True, repository=json_tool.REPOSITORY)
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
        need(params.get(key) == [expected], 'bake binding mismatch: ' + key)
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
    evidence = readbacks(plan)
    target = Path(path).parent / 'rebase-release.json'
    existing = manifest.load(target, target=True, repository=json_tool.REPOSITORY) if target.exists() else None
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('plan', 'finalize', 'apply-schema', 'apply-identity', 'apply-workflows', 'apply-app', 'promote-canary'))
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--config', type=Path, default=Path('/root/ezil-aws-mum/config/lifecycle.mum.json'))
    parser.add_argument('--identity-config', type=Path, default=Path('/root/ezil-aws-mum/config/identity.mum.json'))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.operation == 'plan':
        need(args.release_dir is not None and args.plan is None and args.manifest is None, 'plan requires --release-dir')
        make_plan(args.release_dir, args.config, args.identity_config)
    elif args.operation == 'finalize':
        need(args.plan is not None and args.manifest is None, 'finalize requires --plan')
        finalize(args.plan, args.apply)
    else:
        # Initial schema/IAM/code changes exceed the AMI-only allowlists. Do not
        # send these through the old promoter or treat a journal as deployment proof.
        if args.plan:
            load_plan(args.plan)
        elif args.manifest:
            value = manifest.load(args.manifest, target=True, repository=json_tool.REPOSITORY)
            need((value['accountId'], value['region'], value['namespace']) == (json_tool.ACCOUNT, json_tool.REGION, 'mum'), 'staging manifest identity mismatch')
        else:
            raise ValueError('reviewed --plan or --manifest required')
        print('ERROR: ' + args.operation + ' is not implemented; lead integration must supply reviewed staging deployment and readback handling.', file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired):
        print('ERROR: release refused; check reviewed inputs, staging identity and published readbacks. Deployment phases require follow-up implementation.', file=sys.stderr)
        sys.exit(1)
