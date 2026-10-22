"""Staging-only SSM/S3 transport. Payloads and receipts contain no secret values."""
import hashlib
import json
from pathlib import Path
import re
import shlex
import tempfile
import time

import rebase_manifest as manifest

HOST = 'i-014810524754b9ed0'
BUCKET = 'ezil-main-preview-artifacts-452630323510-aps1'
PREFIX = 'os-staging/images/rebase-release/'
need = manifest.need


def host_identity(aws):
    identity = aws('sts', 'get-caller-identity')
    need(identity['Account'] == '452630323510', 'staging account required')
    response = aws('ec2', 'describe-instances', '--instance-ids', HOST)
    instances = [i for r in response['Reservations'] for i in r['Instances']]
    need(not response.get('NextToken') and len(instances) == 1, 'incomplete staging host readback')
    host = instances[0]
    tags = {t['Key']: t['Value'] for t in host.get('Tags', [])}
    need(host['InstanceId'] == HOST and host['State']['Name'] == 'running' and
         tags.get('ezil:purpose') == 'os-staging' and tags.get('ezil:env') == 'billing-staging' and
         'prod' not in tags.get('Name', '').lower(), 'staging host identity mismatch')


def run(directory, operation, body, apply, aws, write, sleep=time.sleep, fresh=False):
    """Journal before submission; reconcile ambiguous sends by the unique comment.

    A missing ambiguous result refuses. Never blindly repeat send-command. A
    completed invocation is read again on resume. stdout must be one JSON object;
    provider errors/stdout are never echoed to an operator on failure.
    """
    host_identity(aws)
    content = body.encode('utf-8')
    sha = hashlib.sha256(content).hexdigest()
    path = Path(directory) / (operation + '-ssm.json')
    comment = 'ezil-rebase-' + operation + '-' + sha[:32]
    key = PREFIX + sha + '.sh'
    expected = {'schemaVersion': 1, 'host': HOST, 'operation': operation, 'sha256': sha, 'key': key}
    state = manifest.read(path) if path.exists() else None
    if state:
        need(all(state.get(k) == v for k, v in expected.items()), 'SSM journal input drift')
    if not apply:
        print('DRY RUN: verified staging host; ' + operation + ' via SSM/S3; no submission')
        return None
    if state is None:
        state = {**expected, 'status': 'uploading', 'commandId': None, 'comment': comment, 'attempts': []}
        write(path, state)
    if state['status'] == 'failed' or fresh and state['status'] == 'complete':
        state['attempts'].append(state['commandId'])
        state.update(status='uploading', commandId=None, comment=comment + '-r' + str(len(state['attempts'])))
        write(path, state)
    comment = state['comment']
    if state['status'] == 'uploading':
        with tempfile.TemporaryDirectory(prefix='ezil-rebase-payload-') as temp:
            payload = Path(temp) / 'payload.sh'; payload.write_bytes(content)
            aws('s3api', 'put-object', '--bucket', BUCKET, '--key', key, '--body', str(payload), '--server-side-encryption', 'AES256')
        state['status'] = 'submitting'; write(path, state)
        # Download and verify the exact reviewed payload before executing it.
        command = ('set -eu; umask 077; unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI; export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=false; f=$(mktemp); trap \'rm -f "$f"\' EXIT; '
                   'aws --region ap-south-1 s3 cp --only-show-errors ' + shlex.quote('s3://' + BUCKET + '/' + key) + ' "$f"; '
                   'printf "%s  %s\\n" ' + sha + ' "$f" | sha256sum --check --status; bash "$f"')
        response = aws('ssm', 'send-command', '--instance-ids', HOST, '--document-name', 'AWS-RunShellScript',
                       '--comment', comment, '--timeout-seconds', '900', '--parameters',
                       json.dumps({'commands': [command], 'executionTimeout': ['900']}))
        state['commandId'] = response['Command']['CommandId']
        write(path, state)
    if not state['commandId']:
        response = aws('ssm', 'list-commands', '--instance-id', HOST,
                       '--filters', json.dumps([{'key': 'DocumentName', 'value': 'AWS-RunShellScript'}]))
        need(not response.get('NextToken'), 'incomplete SSM reconciliation')
        matches = [c for c in response['Commands'] if c.get('Comment') == comment and c.get('InstanceIds') == [HOST]]
        need(len(matches) == 1, 'uncertain SSM submission; reconcile command before retry')
        state['commandId'] = matches[0]['CommandId']; write(path, state)
    need(re.fullmatch(r'[0-9a-f-]{36}', state['commandId']) is not None, 'invalid SSM command ID')
    for _ in range(180):
        result = aws('ssm', 'get-command-invocation', '--command-id', state['commandId'], '--instance-id', HOST)
        status = result['Status']
        if status in ('Pending', 'InProgress', 'Delayed'):
            sleep(5); continue
        if status != 'Success' or result['ResponseCode'] != 0:
            need(status in ('Failed', 'Cancelled', 'TimedOut'), 'unknown SSM state; retain command ID')
            state['status'] = 'failed'; write(path, state)
            raise ValueError('SSM operation failed; next apply retries the idempotent transaction; prior command retained')
        receipt = manifest.loads(result['StandardOutputContent'].strip())
        need(isinstance(receipt, dict), 'missing nonsecret operation receipt')
        state['status'] = 'complete'; write(path, state)
        # Cleanup is resumable too; the command no longer needs its input object.
        aws('s3api', 'delete-object', '--bucket', BUCKET, '--key', key)
        return receipt
    raise ValueError('SSM still pending; retained command ID must be resumed')
