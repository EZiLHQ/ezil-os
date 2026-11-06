#!/usr/bin/env python3
"""Fixed-document delivery adapter. Disabled contract refuses before AWS calls.

Invoked only by the separately approved reusable workflow, never by PR checks.
All AWS operations are injectable for credential-free offline tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
from urllib.request import urlopen
import zipfile

from fixed_document import document_digest
from install_receipt import require, sha256, verify_archive
from release_admission import BUILD_JOB, RELEASE_PATH, REPO, GitHub, REPO_ID, admit_remote, bind_source, delivery_contract
from staging_candidate import PINNED, prepare
from public_config import approved


def aws(service, operation, *args, region=PINNED['region']):
    result = subprocess.run(['aws', '--region', region, '--no-cli-pager', '--output', 'json',
                             service, operation, *args], capture_output=True, text=True)
    if result.returncode:
        if operation == 'get-command-invocation' and 'InvocationDoesNotExist' in result.stderr:
            return {'Status': 'Pending'}
        # Do not echo credential diagnostics, arbitrary host output or tokens.
        raise RuntimeError(f'AWS {service}:{operation} failed; inspect privately, do not blindly retry')
    return json.loads(result.stdout or '{}')


def artifact_files(request):
    return [request['tag'] + '.' + suffix for suffix in ('tar.gz', 'runtime.tar.gz', 'source.json', 'sha256')]


def validate_artifacts(directory, request):
    image_id = verify_archive(directory, request['tag'], 'staging', request['source'], request['receipt_sha256'])
    hashes = json.loads((directory / (request['tag'] + '.source.json')).read_text())['artifacts']
    expected = ''.join(f'{hashes[request["tag"] + "." + suffix]}  {request["tag"]}.{suffix}\n'
                       for suffix in ('tar.gz', 'runtime.tar.gz'))
    require((directory / (request['tag'] + '.sha256')).read_text() == expected, 'Checksum completion marker differs')
    return image_id


def current_build(request, env):
    require(env.get('GITHUB_REPOSITORY') == REPO and env.get('GITHUB_REPOSITORY_ID') == str(REPO_ID) and
            env.get('GITHUB_SHA') == request['source'] and env.get('GITHUB_REF') == request['ref'] and
            env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            env.get('GITHUB_WORKFLOW_REF') == f'{REPO}/{RELEASE_PATH}@{request["ref"]}',
            'Delivery is not invoked by the approved release entry/source')
    run_id, attempt = int(env['GITHUB_RUN_ID']), int(env['GITHUB_RUN_ATTEMPT'])
    require(run_id > 0 and attempt > 0, 'Missing current release run/attempt')
    return {'run_id': run_id, 'run_attempt': attempt, 'path': RELEASE_PATH, 'event': 'workflow_dispatch'}


def download_artifact(api, artifact_id, run_id, digest, request, destination, build):
    require(artifact_id > 0 and run_id > 0, 'Missing approved artifact/run ID')
    require(run_id == build['run_id'] and build['path'] == RELEASE_PATH and build['event'] == 'workflow_dispatch',
            'Artifact is not from the admitted current release build')
    digest = digest.removeprefix('sha256:')
    require(re.fullmatch(r'[0-9a-f]{64}', digest), 'Missing approved GitHub artifact digest')
    producer = api.json(f'actions/runs/{run_id}')
    require(producer['id'] == run_id and producer['run_attempt'] == build['run_attempt'] and
            producer['path'] == build['path'] and producer['event'] == build['event'] and
            producer['repository']['id'] == REPO_ID and producer['head_repository']['id'] == REPO_ID and
            producer['head_sha'] == request['source'] and
            producer['head_branch'] == request['ref'].removeprefix('refs/heads/'),
            'Wrong release build workflow/source/event/attempt')
    jobs = api.json(f'actions/runs/{run_id}/attempts/{build["run_attempt"]}/jobs?per_page=100')['jobs']
    jobs = [j for j in jobs if j['name'] == BUILD_JOB]
    require(len(jobs) == 1 and jobs[0]['run_id'] == run_id and jobs[0]['run_attempt'] == build['run_attempt'] and
            jobs[0]['head_sha'] == request['source'] and jobs[0]['status'] == 'completed' and
            jobs[0]['conclusion'] == 'success', 'Approved artifact build job did not succeed')
    metadata = api.json(f'actions/artifacts/{artifact_id}')
    run = metadata['workflow_run']
    require(metadata['id'] == artifact_id and not metadata['expired'] and
            metadata['digest'] == 'sha256:' + digest and run['id'] == run_id and
            run['head_sha'] == request['source'] and run['head_repository_id'] == REPO_ID and
            metadata['name'] == f'os-staging-app-{request["source"]}-{run_id}-{build["run_attempt"]}',
            'Wrong app artifact source/run/repository/digest')
    archive_path = destination / 'download.zip'
    api.download(artifact_id, archive_path)
    require(sha256(archive_path) == digest, 'Downloaded app artifact digest mismatch')
    with zipfile.ZipFile(archive_path) as archive:
        require(sorted(archive.namelist()) == sorted(artifact_files(request)) and all(
            not member.is_dir() and (member.external_attr >> 16) & 0o170000 != 0o120000
            for member in archive.infolist()), 'Unexpected or unsafe app artifact members')
        for member in archive.infolist():
            with archive.open(member) as stream, (destination / member.filename).open('wb') as output:
                shutil.copyfileobj(stream, output)
    archive_path.unlink()
    validate_artifacts(destination, request)


def assert_lease(call, owner, now):
    require(re.fullmatch(r'github-os-app-[0-9]+-[0-9]+', owner), 'Invalid workflow lease owner')
    value = call('dynamodb', 'get-item', '--table-name', 'ezil-ci-staging',
                 '--key', json.dumps({'scope': {'S': 'shared-staging'}}), '--consistent-read', region='us-east-1')
    item = value.get('Item', {})
    require(item.get('owner', {}).get('S') == owner and
            int(item.get('expires_at', {}).get('N', '0')) > now() + 1020,
            'Shared lease is absent, changed or too short for the bounded install')
    return int(item['expires_at']['N'])


def validate_target_and_document(call, contract):
    caller = call('sts', 'get-caller-identity')
    role_name = contract['delivery_role_arn'].rsplit('/', 1)[1]
    require(caller.get('Account') == PINNED['account'] and re.fullmatch(
        rf'arn:aws:sts::{PINNED["account"]}:assumed-role/{re.escape(role_name)}/[^/]+', caller.get('Arn', '')),
        'Not the approved GitHub app delivery role/account')
    response = call('ec2', 'describe-instances', '--instance-ids', PINNED['instance_id'])
    instances = [i for r in response['Reservations'] for i in r['Instances']]
    require(len(instances) == 1, 'Ambiguous staging instance')
    instance = instances[0]
    tags = {t['Key']: t['Value'] for t in instance.get('Tags', [])}
    require(instance['InstanceId'] == PINNED['instance_id'] and instance['VpcId'] == PINNED['vpc_id'] and
            instance['State']['Name'] == 'running' and tags.get('Name') == PINNED['instance_name'] and
            tags.get('ezil:env') == PINNED['instance_environment'], 'Staging instance target drift')
    name, version = contract['ssm_document_name'], contract['ssm_document_version']
    content = call('ssm', 'get-document', '--name', name, '--document-version', version, '--document-format', 'JSON')
    require(content['Name'] == name and content['DocumentVersion'] == version and
            document_digest(json.loads(content['Content'])) == contract['ssm_document_sha256'],
            'Installed SSM document does not match approved source/version')
    description = call('ssm', 'describe-document', '--name', name, '--document-version', version)['Document']
    require(description['Name'] == name and description['DocumentVersion'] == version and
            description['HashType'] == 'Sha256' and re.fullmatch(r'[0-9a-f]{64}', description['Hash']),
            'Missing immutable SSM service document hash')
    return description['Hash']


def read_health():
    with urlopen(PINNED['app_origin'] + '/api/health', timeout=10) as response:
        return json.load(response)


def deliver(contract, request, directory, owner, save, *, call=aws, now=time.time, sleep=time.sleep, health=read_health):
    prepare(contract, request)
    delivery_contract(contract)
    receipt = {'schema': 1, 'candidate': request, 'state': 'preflight', 'lease_release_allowed': True,
               'worker_action': 'retain', 'provider_acceptance': 'still requires independent release-owner acceptance'}
    save(receipt)
    try:
        # Upload only a verified private snapshot; mutation of caller files cannot
        # change a later upload body after these checks.
        with tempfile.TemporaryDirectory() as temporary:
            snapshot = Path(temporary)
            for name in artifact_files(request):
                shutil.copyfile(directory / name, snapshot / name)
            receipt['image_id'] = validate_artifacts(snapshot, request)
            public = json.loads((snapshot / (request['tag'] + '.source.json')).read_text()).get('public_config')
            require(public == approved(contract), 'Artifact public configuration is not approved for staging')
            receipt['public_config'] = public
            service_hash = validate_target_and_document(call, contract)
            for name in artifact_files(request):
                receipt['lease_expires_at'] = assert_lease(call, owner, now)
                call('s3api', 'put-object', '--bucket', PINNED['artifact_bucket'],
                     '--key', PINNED['artifact_prefix'] + name, '--body', str(snapshot / name),
                     '--server-side-encryption', 'AES256', '--if-none-match', '*')
            receipt['lease_expires_at'] = assert_lease(call, owner, now)
            # A transport failure during SendCommand has uncertain outcome. Retain
            # the lease and receipt for owner inspection, never send twice.
            receipt.update(state='submission_pending', lease_release_allowed=False)
            save(receipt)
            command = call('ssm', 'send-command', '--instance-ids', PINNED['instance_id'],
                           '--document-name', contract['ssm_document_name'],
                           '--document-version', contract['ssm_document_version'],
                           '--document-hash', service_hash, '--document-hash-type', 'Sha256',
                           '--parameters', json.dumps({'Tag': [request['tag']], 'SourceSha': [request['source']],
                                                       'ReceiptSha256': [request['receipt_sha256']]}),
                           '--timeout-seconds', '120')
            receipt.update(command_id=command['Command']['CommandId'], state='command_submitted')
            save(receipt)
            for _ in range(192):
                result = call('ssm', 'get-command-invocation', '--command-id', receipt['command_id'],
                              '--instance-id', PINNED['instance_id'])
                status = result['Status']
                if status in ('Pending', 'InProgress', 'Delayed'):
                    sleep(5)
                    continue
                require(status in ('Success', 'Cancelled', 'TimedOut', 'Failed'), 'Unknown SSM outcome; retain lease')
                receipt.update(ssm_status=status)
                require(status == 'Success', 'SSM failed; app/timers may be changed; release owner must recover')
                break
            else:
                raise ValueError('SSM outcome still uncertain; retain lease and inspect command ID')
            for _ in range(12):
                try:
                    observed = health()
                except Exception:
                    observed = {}
                if observed.get('ok') is True and observed.get('sha') == request['source']:
                    receipt.update(state='installed_health_verified', observed_app_sha=request['source'],
                                   lease_release_allowed=True)
                    save(receipt)
                    return receipt
                sleep(5)
            raise ValueError('Installed app health/source mismatch; release owner must recover; no automatic rollback')
    except Exception as error:
        receipt.update(state='recovery_required', error=str(error), automatic_rollback=False)
        if not receipt['lease_release_allowed']:
            receipt['recovery_gate'] = 'No explicit lease release; owner must inspect/recover before normal leasing resumes after the recorded TTL'
        save(receipt)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('request', type=Path)
    parser.add_argument('--artifact-id', type=int, required=True)
    parser.add_argument('--artifact-run', type=int, required=True)
    parser.add_argument('--artifact-digest', required=True)
    parser.add_argument('--receipt-sha256', required=True)
    parser.add_argument('--lease-owner', required=True)
    parser.add_argument('--result', type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.request.read_text())
    def save(receipt):
        args.result.write_text(json.dumps(receipt, indent=2) + '\n')
    # If a read-only preflight fails after acquisition, no SSM submission has
    # occurred and cleanup may release our own lease. This flips before SendCommand.
    save({'schema': 1, 'state': 'preflight', 'lease_release_allowed': True})
    require('receipt_sha256' not in request or request['receipt_sha256'] == args.receipt_sha256, 'Artifact approval differs')
    request['receipt_sha256'] = args.receipt_sha256
    contract = json.loads(Path(__file__).with_name('pipeline.json').read_text())
    prepare(contract, request)
    delivery_contract(contract)
    api = GitHub()
    admit_remote(contract, request, bind_source(request), api)
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        download_artifact(api, args.artifact_id, args.artifact_run, args.artifact_digest, request, directory,
                          current_build(request, os.environ))
        deliver(contract, request, directory, args.lease_owner, save)
