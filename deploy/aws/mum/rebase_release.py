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
             'configPath', 'configSha256', 'identityConfigPath', 'identityConfigSha256', 'schemaPath', 'schemaSha256', 'databaseSystemIdentifier', 'maintenance', 'rollout', 'evidence', 'ledgerGeneration')
VERSION_KEYS = ('stateMachineVersionArn', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn')
LEDGER_PATH = Path('/root/ezil-aws-mum/releases/promotion-ledger.json')


def release_roles(directory, maintenance=False, legacy=False):
    source_name = 'maintenance-source-release.json' if maintenance else 'previous-rebase-release.json'
    source = manifest.load(Path(directory) / source_name, source=True, repository=json_tool.REPOSITORY)
    deployed = source if legacy else manifest.load(Path(directory) / 'deployed-release.json', source=True, repository=json_tool.REPOSITORY)
    return deployed, source


def lineage(bake, source, maintenance):
    if maintenance:
        need(bake['previousLowerImageDigest'] is None and bake['previousLowerImageRef'] is None, 'maintenance previous must be null')
        need(source['lowerImageDigest'] == bake['lowerImageDigest'] and source['agentCommit'] != bake['agentCommit'], 'maintenance source lower/new agent mismatch')
    else:
        need((source['lowerImageDigest'], source['lowerImageRef']) == (bake['previousLowerImageDigest'], bake['previousLowerImageRef']), 'image predecessor and bake disagree')


def plan_roles(path, plan):
    return release_roles(Path(path).parent, plan['maintenance'], 'deployed-release.json' not in plan['evidence'])


def live_roles(path, plan, d, deployed=True):
    current, predecessor = plan_roles(path, plan)
    if deployed:
        manifest.promoted_release(d, current)
    if not plan['maintenance'] and 'ledgerGeneration' in plan:
        manifest.retained_release(d, predecessor)
    return current, predecessor


def ledger_tuple(d):
    return {k: d.get(k) for k in manifest.PROMOTION}


def load_ledger(ledger_path):
    value = manifest.read(safe_path(ledger_path))
    need(isinstance(value, dict) and set(value) == {'schemaVersion', 'entries'} and type(value['schemaVersion']) is int and value['schemaVersion'] == 1,
         'invalid promotion ledger')
    entries = value['entries']
    need(isinstance(entries, list) and bool(entries), 'empty promotion ledger; use ledger-init')
    for generation, entry in enumerate(entries, 1):
        base = {'generation', 'planSha256', 'operation'}
        state = entry.get('state', 'completed') if isinstance(entry, dict) else None
        fields = base | ({'state', 'before', 'expected'} if state == 'pending' else {'secretVersionId', 'tuple', 'appGitSha'})
        if state != 'pending' and isinstance(entry, dict) and 'registrySha256' in entry:
            fields.add('registrySha256')
        if isinstance(entry, dict) and 'state' in entry:
            fields.add('state')
        adopt = isinstance(entry, dict) and entry.get('operation') == 'app-adopt'
        if adopt:
            fields |= {'state', 'before', 'expected', 'registrySha256'}
        need(isinstance(entry, dict) and set(entry) == fields, 'invalid ledger entry')
        need(state in ('pending', 'completed', 'aborted'), 'invalid ledger state')
        need(type(entry['generation']) is int and entry['generation'] == generation, 'invalid ledger generation')
        snapshots = [entry['before'], entry['expected']] if state == 'pending' else [entry]
        if state == 'pending':
            need(isinstance(entry['before'], dict) and set(entry['before']) - {'registrySha256'} == {'secretVersionId', 'tuple', 'appGitSha'} and
                 isinstance(entry['expected'], dict) and set(entry['expected']) - {'registrySha256'} == {'tuple', 'appGitSha'}, 'invalid pending snapshots')
        if adopt:
            need(state == 'completed' and all(isinstance(entry[k], dict) and
                 set(entry[k]) == {'secretVersionId', 'tuple', 'registrySha256', 'appGitSha'} for k in ('before', 'expected')),
                 'invalid app-adopt snapshots')
            snapshots = [entry, entry['before'], entry['expected']]
        for snapshot in snapshots:
            need('registrySha256' not in snapshot or manifest.matches(r'[0-9a-f]{64}', snapshot['registrySha256']), 'invalid ledger registry hash')
            need(manifest.matches(r'[0-9a-f]{40}', snapshot['appGitSha']) and
                 (entry['planSha256'] == 'app-adopt:' + entry['appGitSha'] if adopt else manifest.matches(r'[0-9a-f]{64}', entry['planSha256'])),
                 'invalid ledger source pin')
            need(entry['operation'] in ('apply-app', 'promote-canary', 'rollback', 'registry-gc', 'app-adopt') and
                 isinstance(snapshot.get('secretVersionId', 'expected'), str) and bool(snapshot.get('secretVersionId', 'expected')), 'invalid ledger operation/version')
            need(isinstance(snapshot['tuple'], dict) and set(snapshot['tuple']) == set(manifest.PROMOTION), 'invalid ledger tuple')
        if entry['operation'] == 'registry-gc':
            need('state' in entry and all('registrySha256' in snapshot for snapshot in snapshots),
                 'registry-gc requires explicit state and registry pins')
            if state == 'pending':
                need(entry['before']['tuple'] == entry['expected']['tuple'] and
                     entry['before']['appGitSha'] == entry['expected']['appGitSha'] and
                     entry['before']['registrySha256'] != entry['expected']['registrySha256'],
                     'registry-gc must change only registry identity')
        prior = entries[generation - 2] if generation > 1 else None
        if adopt:
            need(prior is not None and prior.get('state', 'completed') == 'completed' and 'registrySha256' in prior,
                 'app-adopt requires completed registry baseline')
            need(state_matches(entry['before'], prior) and
                 entry['expected'] == {k: entry[k] for k in entry['expected']} and
                 entry['before'] == {**entry['expected'], 'appGitSha': prior['appGitSha']} and
                 entry['appGitSha'] != prior['appGitSha'], 'app-adopt must change only app identity')
        elif prior and prior.get('state') == 'pending':
            need(state in ('completed', 'aborted') and entry['planSha256'] == prior['planSha256'] and entry['operation'] == prior['operation'], 'unresolved pending ledger entry')
            if entry['operation'] == 'registry-gc':
                need(state_matches(entry, prior['expected' if state == 'completed' else 'before']),
                     'registry-gc terminal state mismatch')
        elif entry['operation'] == 'registry-gc':
            need(state == 'pending' and prior is not None, 'registry-gc requires pending predecessor')
        elif 'state' in entry:
            need(state == 'pending' and prior is not None or state == 'completed' and generation == 1, 'terminal ledger entry requires pending')
    return value


def completed_entries(ledger):
    return [e for e in ledger['entries'] if e.get('state', 'completed') == 'completed']


def release_state(d, git_sha):
    registry = json.dumps(d.get('releases', []), sort_keys=True, separators=(',', ':'))
    return {'tuple': ledger_tuple(d), 'registrySha256': hashlib.sha256(registry.encode()).hexdigest(), 'appGitSha': git_sha}


def observed_state(envelope, d, git_sha):
    return {'secretVersionId': envelope['VersionId'], **release_state(d, git_sha)}


def state_matches(observed, expected):
    # VersionId is evidence, not release identity: admission gate updates share this secret.
    # Older entries have no registry hash; preserve their tuple/SHA-only comparison.
    return all(observed[k] == expected[k] for k in ('tuple', 'registrySha256', 'appGitSha')
               if k in expected and (k != 'appGitSha' or observed['appGitSha'] is not None))


def ledger_drift(ledger, envelope, d, git_sha=None):
    latest = ledger['entries'][-1]
    snapshots = [latest['before'], latest['expected']] if latest.get('state') == 'pending' else [completed_entries(ledger)[-1]]
    observed = observed_state(envelope, d, git_sha)
    need(any(state_matches(observed, s) for s in snapshots), 'ledger drift')


def ledger_admit(ledger_path, path, plan, envelope, d, operation):
    ledger = load_ledger(ledger_path)
    latest = ledger['entries'][-1]
    if latest.get('state') == 'pending':
        need(latest['planSha256'] == digest(path), 'pending operation of another plan; run ledger-reconcile')
        need(latest['operation'] == operation, 'pending operation differs; run ledger-reconcile')
    ledger_drift(ledger, envelope, d)
    completed = completed_entries(ledger)
    latest = completed[-1]
    own = [e for e in completed if e['planSha256'] == digest(path)]
    if own or 'ledgerGeneration' not in plan:
        need(latest['planSha256'] == digest(path), 'stale plan: latest ledger entry belongs to another plan')
    else:
        need(latest['generation'] == plan['ledgerGeneration'], 'stale plan: ledger generation advanced')
    if operation == 'rollback':
        need(any(e['operation'] == 'promote-canary' for e in own), 'rollback requires a ledger promotion')
        need(not any(e['operation'] == 'rollback' for e in own), 'release already rolled back')
    return ledger


def ledger_entry(path, operation, envelope, d, git_sha, generation):
    need(manifest.matches(r'[0-9a-f]{40}', git_sha), 'invalid running app gitSha')
    return {'generation': generation, 'planSha256': digest(path), 'operation': operation, 'state': 'completed',
            **observed_state(envelope, d, git_sha)}


def write_ledger_entry(ledger_path, ledger, path, plan, entry):
    need(load_plan(path) == plan, 'plan changed before ledger append')
    return write_ledger_append(ledger_path, ledger, entry)


def write_ledger_append(ledger_path, ledger, entry):
    need(load_ledger(ledger_path) == ledger, 'ledger changed during operation')
    # json_tool.write uses temp + fsync + rename + directory fsync. Caller holds app-secret.lock.
    updated = {**ledger, 'entries': [*ledger['entries'], entry]}
    # Preserve every historical entry's original bytes, including whitespace/key order.
    raw = safe_path(ledger_path).read_bytes().decode('utf-8')
    decoder = json.JSONDecoder()
    pos = raw.index('{') + 1
    while True:
        pos += len(raw[pos:]) - len(raw[pos:].lstrip())
        key, pos = decoder.raw_decode(raw, pos)
        pos = raw.index(':', pos) + 1
        pos += len(raw[pos:]) - len(raw[pos:].lstrip())
        _, end = decoder.raw_decode(raw, pos)
        if key == 'entries':
            serialized = raw[:end - 1] + ',' + json.dumps(entry, indent=2) + raw[end - 1:]
            break
        pos = raw.index(',', end) + 1
    json_tool.write(ledger_path, updated, serialized=serialized)
    return updated


def append_ledger(ledger_path, ledger, path, plan, operation, envelope, d, git_sha, state='completed'):
    entry = ledger_entry(path, operation, envelope, d, git_sha, ledger['entries'][-1]['generation'] + 1)
    entry['state'] = state
    return write_ledger_entry(ledger_path, ledger, path, plan, entry)


def live_app(path, plan, operation, envelope, fd, expected=None):
    result = app_operation(path, plan, operation, True, expected, install=False)
    check = json_tool.secret_aws(['get-secret-value', '--secret-id', json_tool.SECRET, '--output', 'json'], lock_fd=fd)
    need(check == envelope and load_plan(path) == plan, 'ledger inputs changed during readback')
    need(result is not None and manifest.matches(r'[0-9a-f]{40}', result.get('gitSha')), 'ledger app readback missing')
    return result


def begin_operation(ledger_path, ledger, path, plan, operation, envelope, d, expected_d, apply, fd):
    latest = ledger['entries'][-1]
    result = live_app(path, plan, ('registry-gc-check-g' if operation == 'registry-gc' else 'ledger-check-g') + str(latest['generation']), envelope, fd,
                      rebase_app.public_deployment(d) if operation == 'registry-gc' else None)
    if operation == 'registry-gc':
        need(plan['rollout']['app']['tag'] == '478c66b3559c' and
             result['gitSha'] == plan['rollout']['app']['gitSha'], 'registry-gc requires the same frozen app')
    ledger_drift(ledger, envelope, d, result['gitSha'])
    expected = release_state(expected_d, plan['rollout']['app']['gitSha'])
    if latest.get('state') == 'pending':
        need(state_matches(expected, latest['expected']), 'pending operation expected state changed')
        return ledger, latest['generation']
    generation = latest['generation'] + 1
    entry = {'generation': generation, 'planSha256': digest(path), 'operation': operation, 'state': 'pending',
             'before': observed_state(envelope, d, result['gitSha']), 'expected': expected}
    if apply:
        ledger = write_ledger_entry(ledger_path, ledger, path, plan, entry)
    return ledger, generation


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


def make_plan(directory, config_path, identity_path, system_id=None, rollout_path=None, ledger_path=None):
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
    evidence = {name: digest(directory / name) for name in ('bake-inputs.json', 'build-arn.txt', 'build.json', 'image.json', source_name, 'deployed-release.json')}
    deployed, source = release_roles(directory, maintenance)
    lineage(bake, source, maintenance)
    with json_tool.app_secret_lock() as fd:
        envelope = json_tool.secret_aws(['get-secret-value', '--secret-id', json_tool.SECRET, '--output', 'json'], lock_fd=fd)
        _, d = secret_deployment(envelope)
        manifest.promoted_release(d, deployed)
        if not maintenance:
            manifest.retained_release(d, source)
        ledger = load_ledger(ledger_path or LEDGER_PATH)
        need(ledger['entries'][-1].get('state') != 'pending', 'pending operation; run ledger-reconcile before planning')
        ledger_drift(ledger, envelope, d)
    plan = dict(zip(PLAN_KEYS, (1, json_tool.ACCOUNT, json_tool.REGION, 'mum', bake, build_arn, ami,
        str(config_path), digest(config_path), str(identity_path), digest(identity_path), str(schema), digest(schema), system_id, maintenance, pin_rollout(rollout_path, bake) if rollout_path else None, evidence, completed_entries(ledger)[-1]['generation'])))
    path = directory / 'rebase-plan.json'
    if path.exists():
        need(manifest.read(path) == plan, 'existing plan differs; retain the release and use a new directory')
    else:
        json_tool.write(path, plan)
    print(f'Reviewed plan: {path}')


def load_plan(path):
    path = safe_path(path)
    plan = manifest.read(path, 65536)
    need(isinstance(plan, dict) and set(plan) in (set(PLAN_KEYS), set(PLAN_KEYS) - {'ledgerGeneration'}) and type(plan['schemaVersion']) is int and plan['schemaVersion'] == 1, 'invalid plan schema')
    if 'ledgerGeneration' in plan:
        need(type(plan['ledgerGeneration']) is int and plan['ledgerGeneration'] >= 1, 'invalid ledger generation pin')
    need((plan['accountId'], plan['region'], plan['namespace']) == (json_tool.ACCOUNT, json_tool.REGION, 'mum'), 'staging plan identity mismatch')
    need(plan['schemaPath'] == str((REPO / 'docs/aws-computers/sql/0002_image_rebase.sql.txt').resolve()), 'unreviewed schema path')
    for field in ('config', 'identityConfig', 'schema'):
        need(digest(plan[field + 'Path']) == plan[field + 'Sha256'], 'reviewed input changed: ' + field)
    need(type(plan['maintenance']) is bool and (plan['databaseSystemIdentifier'] is None or manifest.matches(r'[0-9]{1,20}', plan['databaseSystemIdentifier'])), 'invalid release mode or database identity')
    source_name = 'maintenance-source-release.json' if plan['maintenance'] else 'previous-rebase-release.json'
    names = {'bake-inputs.json', 'build-arn.txt', 'build.json', 'image.json', source_name}
    if 'ledgerGeneration' in plan or 'deployed-release.json' in plan['evidence']:
        names.add('deployed-release.json')
    need(set(plan['evidence']) == names, 'plan evidence fields mismatch')
    for name, expected in plan['evidence'].items():
        need(digest(path.parent / name) == expected, 'bake evidence changed')
    bake, ami, build_arn = bake_evidence(path.parent)
    need(plan['bake'] == bake and plan['amiId'] == ami and plan['buildArn'] == build_arn, 'plan bake mismatch')
    _, source = plan_roles(path, plan)
    lineage(bake, source, plan['maintenance'])
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
    need(set(value) in ({'schemaVersion','stacks','app'},{'schemaVersion','stacks','app','poolIam'}) and type(value['schemaVersion']) is int and value['schemaVersion']==1,'invalid rollout review')
    need(set(value['stacks'])==set(cfn.STACKS),'all three stack reviews required')
    if 'poolIam' in value:
        value['poolIam']=str(safe_path(value['poolIam']))
        value['poolIamSha256']=digest(value['poolIam'])
    pool_iam=cfn.load_pool_iam(value,digest)
    for phase,spec in value['stacks'].items():
        fields={'stackName','changeSetArn','roleArn','beforeTemplatePath','candidateTemplatePath','reviewPath'}
        need(set(spec) in (fields,fields | {'beforeParameters'}),'invalid stack review fields')
        need(spec['stackName']==cfn.STACKS[phase] and (phase=='identity' and spec['changeSetArn'] is None or manifest.matches(r'arn:aws:cloudformation:ap-south-1:452630323510:changeSet/[A-Za-z0-9-]+/[a-zA-Z0-9-]+',spec['changeSetArn'])),'invalid staged change set identity')
        for name in ('beforeTemplate','candidateTemplate','review'):
            spec[name+'Path']=str(safe_path(spec[name+'Path']))
            spec[name+'Sha256']=digest(spec[name+'Path'])
        validate_stack_review(phase,spec,pool_iam)
    app=value['app']
    need(set(app)=={'tag','gitSha','checksumSha256'},'invalid app review fields')
    need(app['gitSha']==bake['agentCommit'],'app and host must use the same reviewed integrated source commit')
    installer=REPO/'deploy/aws/os-staging/install-host.sh'
    rebase_app.body(safe_path(installer).read_text(),app,install=False)
    value['installerSha256']=digest(installer)
    return value


def validate_stack_review(phase,spec,pool_iam=None):
    if 'beforeParameters' in spec:
        need(phase=='identity' and spec['changeSetArn'] is None,'beforeParameters requires unchanged identity')
        cfn.parameters(spec['beforeParameters'])
    cfn.validate_templates(phase,manifest.read(spec['beforeTemplatePath']),manifest.read(spec['candidateTemplatePath']),
                           manifest.read(spec['reviewPath']),unchanged=spec['changeSetArn'] is None,pool_iam=pool_iam)


def verify_rollout(value):
    pool_iam=cfn.load_pool_iam(value,digest)
    for phase,spec in value['stacks'].items():
        for name in ('beforeTemplate','candidateTemplate','review'):
            need(digest(spec[name+'Path'])==spec[name+'Sha256'],'rollout artifact changed')
        validate_stack_review(phase,spec,pool_iam)
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
            if name=='identity' and expected['changeSetArn'] is None:
                recorded=evidence[name].get('parameters')
                params=cfn.parameters(expected.get('beforeParameters',recorded))
                need(evidence[name]=={'changeSetArn':None,'candidateSha256':expected['candidateTemplateSha256'],'status':'unchanged',
                     'liveTemplateSha256':cfn.template_sha256(manifest.read(expected['candidateTemplatePath'])),'parameters':params},
                     'invalid unchanged identity evidence')
            else:
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

def app_operation(path,plan,operation,apply,expected=None,install=True,generation=None):
    need(plan['rollout'] is not None,'plan requires --rollout with reviewed staged change sets and app artifact')
    body=rebase_app.body(safe_path(REPO/'deploy/aws/os-staging/install-host.sh').read_text(),plan['rollout']['app'],expected,install)
    if generation is not None:
        legacy_path = Path(path).parent / (operation + '-ssm.json')
        operation += '-g' + str(generation)
        transport_path = Path(path).parent / (operation + '-ssm.json')
        # Only an admitted legacy plan may import its own old transport evidence.
        if 'ledgerGeneration' not in plan and legacy_path.exists() and not transport_path.exists():
            legacy = manifest.read(safe_path(legacy_path))
            if legacy.get('sha256') == hashlib.sha256(body.encode('utf-8')).hexdigest() and apply:
                json_tool.write(transport_path, {**legacy, 'operation': operation})
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
        deployed,_=live_roles(path,plan,d)
        # Verify the running app is gated, not merely a pending secret update.
        app_operation(path,plan,phase+'-gate',apply,install=False)
        results={}
        for name in (('identity',) if phase=='apply-identity' else ('foundation','workflows')):
            spec=dict(plan['rollout']['stacks'][name],amiId=plan['amiId'],sourceAmiId=deployed['amiId'])
            results[name]=cfn.execute(name,spec,Path(path).parent,apply,aws,json_tool.write,digest,pool_iam=plan['rollout'])
        if apply and phase=='apply-workflows':
            evidence=readbacks(plan);final_manifest(plan,evidence)
            source=deployed
            prior=aws('ec2','describe-launch-template-versions','--launch-template-id',source['launchTemplateId'],'--versions',source['launchTemplateVersion'])['LaunchTemplateVersions']
            need(len(prior)==1,'source launch template missing')
            a=prior[0]['LaunchTemplateData'];b=evidence['template']['LaunchTemplateVersions'][0]['LaunchTemplateData']
            need(a['ImageId']==source['amiId'] and {k:v for k,v in a.items() if k!='ImageId'}=={k:v for k,v in b.items() if k!='ImageId'},'foundation launch data changed outside AMI')
            results['readbacks']=evidence
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'],'app secret changed during rollout')
    need(load_plan(path)==plan,'plan changed during cloud deployment')
    if apply:write_receipt(path,phase,results)


def apply_app(manifest_path,apply,ledger_path=None):
    ledger_path=ledger_path or LEDGER_PATH
    path=Path(manifest_path).parent/'rebase-plan.json';plan=load_plan(path)
    value=manifest.load(manifest_path,target=not plan['maintenance'],repository=json_tool.REPOSITORY)
    need(final_manifest(plan,readbacks(plan),value['createdAt'])==value,'final manifest readbacks changed')
    for phase in ('apply-schema','apply-identity','apply-workflows'):require_receipt(path,phase)
    with json_tool.app_secret_lock() as fd:
        envelope=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        _,d=secret_deployment(envelope)
        static_deployment(plan,d)
        ledger=ledger_admit(ledger_path,path,plan,envelope,d,'apply-app')
        deployed,_=live_roles(path,plan,d,deployed=False)
        # Current-plan retries can observe its target after its own promotion.
        latest=completed_entries(ledger)[-1]
        own_promoted=latest['planSha256']==digest(path) and latest['tuple']==ledger_tuple(value)
        manifest.promoted_release(d,value if own_promoted else deployed)
        ledger,generation=begin_operation(ledger_path,ledger,path,plan,'apply-app',envelope,d,d,apply,fd)
        result=app_operation(path,plan,'apply-app',apply,rebase_app.public_deployment(d),generation=generation)
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'],'secret changed during app deployment')
        if apply:
            need(result is not None,'app verification missing')
            write_receipt(path,'apply-app',result)
            append_ledger(ledger_path,ledger,path,plan,'apply-app',check,d,result['gitSha'])
    need(load_plan(path)==plan,'plan changed during app deployment')


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


def promote(manifest_path,apply,rollback=False,ledger_path=None):
    ledger_path=ledger_path or LEDGER_PATH
    path=Path(manifest_path).parent/'rebase-plan.json';plan=load_plan(path)
    need(not plan['maintenance'],'maintenance releases are source artifacts; do not authorize a rebase target')
    target=manifest.load(manifest_path,target=True,repository=json_tool.REPOSITORY)
    if not rollback:
        need(final_manifest(plan,readbacks(plan),target['createdAt'])==target,'target manifest no longer matches readbacks')
    for phase in ('apply-schema','apply-identity','apply-workflows','apply-app'):require_receipt(path,phase)
    source,predecessor=plan_roles(path,plan)
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
        operation='rollback' if rollback else 'promote-canary'
        ledger=ledger_admit(ledger_path,path,plan,envelope,d,operation)
        live_roles(path,plan,d,deployed=False)
        current=json_tool.pair({'settings':{'deployment':d}})
        if journal is None:
            manifest.promoted_release(d,source)
            journal={'schemaVersion':1,'planSha256':digest(path),'source':source,'target':target,'before':current,
                     'after':{k:target[k] for k in manifest.PROMOTION},'beforeDeployment':rebase_app.public_deployment(d),'status':'planned'}
        before,after=(journal['after'],journal['before']) if rollback else (journal['before'],journal['after'])
        need(current in (before,after),'complete deployment tuple drift')
        updated=json_tool.edit_release_secret(envelope,before,after,[source,predecessor,target])
        _,next_d=secret_deployment({'SecretString':json.dumps(updated)})
        journal['rollbackDeployment' if rollback else 'afterDeployment']=rebase_app.public_deployment(next_d)
        ledger,generation=begin_operation(ledger_path,ledger,path,plan,operation,envelope,d,next_d,apply,fd)
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
        app_result=app_operation(path,plan,'rollback-app' if rollback else 'promote-app',True,rebase_app.public_deployment(next_d),generation=generation)
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check['VersionId']==envelope['VersionId'] and manifest.loads(check['SecretString'])==updated,'app secret drift after restart')
        need(app_result is not None,'app verification missing')
        journal['status']='rolled-back' if rollback else 'promoted';json_tool.write(journal_path,journal)
        append_ledger(ledger_path,ledger,path,plan,operation,check,next_d,app_result['gitSha'])
    print('Full deployment tuple and registry verified; admission remains gated for the lead canary')


def ledger_reconcile(path, apply=False, ledger_path=None):
    ledger_path = Path(ledger_path or LEDGER_PATH)
    path = safe_path(path)
    plan = load_plan(path)
    with json_tool.app_secret_lock() as fd:
        ledger = load_ledger(ledger_path)
        pending = ledger['entries'][-1]
        need(pending.get('state') == 'pending' and pending['planSha256'] == digest(path), 'ledger-reconcile requires this plan pending entry')
        need(rebase_ssm.generation_terminal(path.parent, pending['generation'], aws), 'remote command not terminal; wait or cancel')
        envelope = json_tool.secret_aws(['get-secret-value', '--secret-id', json_tool.SECRET, '--output', 'json'], lock_fd=fd)
        _, d = secret_deployment(envelope)
        result = live_app(path, plan, 'ledger-reconcile-g' + str(pending['generation']), envelope, fd)
        observed = observed_state(envelope, d, result['gitSha'])
        if pending['operation'] == 'registry-gc':
            import registry_gc
            registry_gc.verify_reconciliation(path, pending, d, result)
        expected_match = state_matches(observed, pending['expected'])
        before_match = state_matches(observed, pending['before'])
        if observed['tuple'] == pending['expected']['tuple'] and pending['operation'] in ('promote-canary', 'rollback'):
            # The secret already matches the expected tuple. Use the normal completion
            # projection, preserving fields absent from legacy deployments.
            expected_deployment = rebase_app.public_deployment(d)
            need(result.get('deployment') == expected_deployment, 'secret written; app not yet adopted — resume the same operation')
        if not expected_match and not before_match:
            # Only tuple key names and source SHAs; never emit secret contents.
            diff = {name: {'tupleKeys': [k for k in manifest.PROMOTION if observed['tuple'][k] != pending[name]['tuple'][k]],
                           'gitSha': {'live': observed['appGitSha'], 'recorded': pending[name]['appGitSha']}}
                    for name in ('before', 'expected')}
            diff['secretVersionChanged'] = observed['secretVersionId'] != pending['before']['secretVersionId']
            print(json.dumps(diff, sort_keys=True))
        need(expected_match or before_match, 'manual reconciliation required')
        state = 'completed' if expected_match else 'aborted'
        if apply:
            # Restore phase evidence before closing the fence, including a lost completion append.
            if state == 'completed' and pending['operation'] == 'apply-app':
                write_receipt(path, 'apply-app', result)
            journal_path = path.parent / 'rebase-promotion.json'
            if pending['operation'] in ('promote-canary', 'rollback') and journal_path.exists():
                journal = manifest.read(safe_path(journal_path))
                need(journal['planSha256'] == digest(path), 'reconciliation journal belongs to another plan')
                rollback = pending['operation'] == 'rollback'
                journal['status'] = ('rolled-back' if rollback else 'promoted') if state == 'completed' else ('promoted' if rollback else 'planned')
                json_tool.write(journal_path, journal)
            append_ledger(ledger_path, ledger, path, plan, pending['operation'], envelope, d, result['gitSha'], state)
        print(('Ledger reconciled: ' if apply else 'DRY RUN: would append ') + state)


def ledger_init(manifest_path, apply, ledger_path=None):
    ledger_path=Path(ledger_path or LEDGER_PATH)
    path=Path(manifest_path).parent/'rebase-plan.json'
    plan=load_plan(path)
    target=manifest.load(manifest_path,target=True,repository=json_tool.REPOSITORY)
    source,_=plan_roles(path,plan)
    journal=manifest.read(safe_path(path.parent/'rebase-promotion.json'))
    need(journal['status']=='promoted' and journal['planSha256']==digest(path) and journal['source']==source and journal['target']==target,
         'ledger-init requires this plan promoted journal')
    need(journal['after']=={k:target[k] for k in manifest.PROMOTION},'ledger-init journal target mismatch')
    receipt=require_receipt(path,'apply-app')
    with json_tool.app_secret_lock() as fd:
        need(not ledger_path.exists() and not ledger_path.is_symlink(),'promotion ledger already exists')
        envelope=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        _,d=secret_deployment(envelope)
        need(json_tool.pair({'settings':{'deployment':d}})==journal['after'],'ledger-init live tuple mismatch')
        # On apply, inspect the running app without installing. Dry-run uses the retained receipt.
        observed=app_operation(path,plan,'ledger-init-readback',apply,rebase_app.public_deployment(d),install=False)
        git_sha=(observed or receipt)['gitSha']
        check=json_tool.secret_aws(['get-secret-value','--secret-id',json_tool.SECRET,'--output','json'],lock_fd=fd)
        need(check==envelope and load_plan(path)==plan,'ledger-init inputs changed during readback')
        entry=ledger_entry(path,'promote-canary',check,d,git_sha,1)
        if apply:
            ledger_path.parent.mkdir(parents=True,exist_ok=True)
            json_tool.write(ledger_path,{'schemaVersion':1,'entries':[entry]})
            print('Promotion ledger initialized at generation 1')
        else:
            print('DRY RUN: promoted journal and live tuple verified; add --apply to initialize ledger')


def ledger_adopt_app(git_sha, source_repo, apply=False, ledger_path=None):
    need(manifest.matches(r'[0-9a-f]{40}', git_sha), 'ledger-adopt-app requires a 40-hex git SHA')
    ledger_path = Path(ledger_path or LEDGER_PATH)
    with json_tool.app_secret_lock() as fd:
        need(ledger_path.is_file(), 'ledger-adopt-app requires an existing ledger')
        ledger = load_ledger(ledger_path)
        latest = ledger['entries'][-1]
        need(latest.get('state', 'completed') == 'completed', 'ledger-adopt-app requires a completed latest entry')
        envelope = json_tool.secret_aws(['get-secret-value', '--secret-id', json_tool.SECRET, '--output', 'json'], lock_fd=fd)
        _, d = secret_deployment(envelope)
        before = observed_state(envelope, d, latest['appGitSha'])
        need(before['tuple'] == latest['tuple'], 'ledger-adopt-app tuple drift')
        need(before['registrySha256'] == latest.get('registrySha256'), 'ledger-adopt-app registry drift')
        # Readback requires artifact-shaped inputs, but never uses them to install.
        plan = {'rollout': {'app': {'tag': 'ledger-adopt-app', 'gitSha': git_sha, 'checksumSha256': '0' * 64}}}
        generation = latest['generation'] + 1
        result = app_operation(ledger_path, plan, 'ledger-adopt-app-g' + str(generation) + '-' + git_sha[:12],
                               True, rebase_app.public_deployment(d), install=False)
        need(result is not None and result.get('gitSha') == git_sha, 'ledger-adopt-app live git SHA mismatch')
        need(git_sha != latest['appGitSha'], 'ledger-adopt-app already recorded')
        ancestor = subprocess.run(['git', '-C', str(source_repo), 'merge-base', '--is-ancestor', latest['appGitSha'], git_sha],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
        need(ancestor.returncode == 0, 'ledger-adopt-app requires a forward descendant')
        check = json_tool.secret_aws(['get-secret-value', '--secret-id', json_tool.SECRET, '--output', 'json'], lock_fd=fd)
        need(check == envelope, 'ledger-adopt-app inputs changed during readback')
        expected = observed_state(envelope, d, git_sha)
        entry = {'generation': generation, 'planSha256': 'app-adopt:' + git_sha, 'operation': 'app-adopt', 'state': 'completed',
                 'before': before, 'expected': expected, **expected}
        if apply:
            write_ledger_append(ledger_path, ledger, entry)
        print(('Ledger appended: ' if apply else 'DRY RUN: would append ') +
              f'app-adopt completed generation {generation}, app {latest["appGitSha"]} -> {git_sha}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('plan', 'finalize', 'apply-schema', 'apply-identity', 'apply-workflows', 'apply-app', 'promote-canary', 'rollback', 'ledger-init', 'ledger-reconcile', 'ledger-adopt-app'))
    parser.add_argument('--release-dir', type=Path)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--config', type=Path, default=Path('/root/ezil-aws-mum/config/lifecycle.mum.json'))
    parser.add_argument('--identity-config', type=Path, default=Path('/root/ezil-aws-mum/config/identity.mum.json'))
    parser.add_argument('--expect-system-id')
    parser.add_argument('--rollout', type=Path)
    parser.add_argument('--ledger', type=Path, default=LEDGER_PATH)
    parser.add_argument('--git-sha')
    parser.add_argument('--source-repo', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.operation == 'plan':
        need(args.release_dir is not None and args.plan is None and args.manifest is None, 'plan requires --release-dir')
        make_plan(args.release_dir, args.config, args.identity_config, args.expect_system_id, args.rollout, args.ledger)
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
        apply_app(args.manifest,args.apply,args.ledger)
    elif args.operation=='ledger-init':
        need(args.manifest is not None and args.plan is None,'ledger-init requires --manifest')
        ledger_init(args.manifest,args.apply,args.ledger)
    elif args.operation=='ledger-reconcile':
        need(args.plan is not None and args.manifest is None,'ledger-reconcile requires --plan')
        ledger_reconcile(args.plan,args.apply,args.ledger)
    elif args.operation=='ledger-adopt-app':
        need(args.git_sha is not None and args.source_repo is not None and args.plan is None and args.manifest is None,
             'ledger-adopt-app requires --git-sha and --source-repo')
        ledger_adopt_app(args.git_sha,args.source_repo,args.apply,args.ledger)
    else:
        need(args.manifest is not None and args.plan is None,'promotion/rollback requires --manifest')
        promote(args.manifest,args.apply,args.operation=='rollback',args.ledger)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.TimeoutExpired) as error:
        public_reasons = {'ledger drift', 'manual reconciliation required',
                          'identity stack drifted from the reviewed template',
                          'remote command not terminal; wait or cancel',
                          'secret written; app not yet adopted — resume the same operation',
                          'pending operation of another plan; run ledger-reconcile',
                          'pending operation differs; run ledger-reconcile',
                          'ledger-reconcile requires this plan pending entry',
                          'pending operation; run ledger-reconcile before planning'}
        reason = str(error) if isinstance(error, ValueError) and str(error) in public_reasons else 'release refused'
        print('ERROR: '+reason+'; check reviewed inputs, staging identity and published readbacks. Inspect retained phase journals before retrying.', file=sys.stderr)
        sys.exit(1)
