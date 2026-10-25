#!/usr/bin/env python3
"""Staging-only operator client. Authority material stays in process memory."""
import argparse
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import sys
import time

import rebase_manifest as wire

spec = importlib.util.spec_from_file_location('mum_json', Path(__file__).with_name('json-tool.py'))
json_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(json_tool)
need = wire.need
PATH = '/api/internal/computers/image-rebase'
ORIGIN = 'https://os-staging.ezil.work'
UUID = r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
PHASES = set('reserved fencing snapshot_pending snapshot_ready launch_pending verifying failed unconfirmed recovery_pending restore_pending rebind_pending succeeded recovered cancelled'.split())
FAILURES = set('source_digest_unknown unsupported_predecessor release_mismatch image_job_conflict authority_revoked source_identity_mismatch writer_not_fenced volume_not_available generation_drift preparation_timeout preparation_failed snapshot_create_unconfirmed snapshot_pending snapshot_missing snapshot_error snapshot_ambiguous snapshot_identity_mismatch snapshot_not_fresh launch_failed launch_unconfirmed permit_invalid permit_expired enrollment_time_insufficient previous_lower_missing rebase_failed rebase_timeout marker_commit_unconfirmed host_digest_mismatch enrollment_failed desktop_unhealthy restore_failed restore_lineage_mismatch rebind_failed operator_required'.split())
OPERATIONS = ('plan', 'prepare', 'launch', 'verify', 'recover')
RECONCILE = 'reconcile-replacement'
RECONCILE_OUTCOMES = {'settled', 'unconfirmed', 'generation_drift', 'not_applicable', 'launch_not_disproven', 'source_not_proven'}
RECONCILE_RELEASE = 'reconcile-release'
RELEASE_OUTCOMES = {'settled', 'recovering', 'waiting', 'unconfirmed', 'not_applicable', 'source_not_proven'}
# The hint must name one execution of the staging lifecycle machine; the server re-reads and proves everything.
SOURCE_EXECUTION = re.escape(json_tool.MACHINE.replace(':stateMachine:', ':execution:') + ':computer-') + UUID


def request(operation, computer, job):
    need(operation in OPERATIONS, 'invalid operation')
    need(wire.matches(UUID, computer) or operation == 'recover' and computer is None, 'invalid computer UUID')
    need(job is None or wire.matches(UUID, job), 'invalid job UUID')
    need(operation != 'recover' or job is not None, 'recover requires exact failed job')
    return dict(schemaVersion=1, operation=operation, computerId=computer, jobId=job)


def headers(body, secret, timestamp):
    need(wire.matches(r'[0-9a-f]{64}', secret), 'existing authority secret required')
    timestamp = str(timestamp)
    signing = '\n'.join(('ezil-lifecycle-authority-v1', 'POST', PATH, timestamp, hashlib.sha256(body).hexdigest()))
    signature = hmac.new(bytes.fromhex(secret), signing.encode(), hashlib.sha256).hexdigest()
    return {'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature}


def response(value, sent):
    need(isinstance(value, dict) and set(value) == {'schemaVersion', 'computerId', 'jobId', 'phase', 'eligible', 'failureCode'}, 'response fields mismatch')
    need(type(value['schemaVersion']) is int and value['schemaVersion'] == 1 and type(value['eligible']) is bool, 'response primitive mismatch')
    need(wire.matches(UUID, value['computerId']), 'response computer mismatch')
    need(sent['computerId'] is None or value['computerId'] == sent['computerId'], 'response names another computer')
    need(value['jobId'] is None or wire.matches(UUID, value['jobId']), 'response job mismatch')
    need(sent['jobId'] is None or value['jobId'] == sent['jobId'], 'response names another job')
    need(value['phase'] is None or value['phase'] in PHASES, 'response phase mismatch')
    need(value['failureCode'] is None or value['failureCode'] in FAILURES, 'response failure code mismatch')
    return {k: value[k] for k in ('schemaVersion', 'computerId', 'jobId', 'phase', 'eligible', 'failureCode')}


def send(sent, secret):
    body = json.dumps(sent, separators=(',', ':')).encode('utf-8')
    auth = headers(body, secret, int(time.time()))
    connection = http.client.HTTPSConnection('os-staging.ezil.work', timeout=6)
    try:
        connection.request('POST', PATH, body=body, headers=auth)
        received = connection.getresponse()
        need(received.status in (200, 202, 409), 'authority denied or dependency unavailable; reconcile before retry')
        need(received.getheader('content-type', '').split(';')[0].strip().lower() == 'application/json', 'response must be JSON')
        raw = received.read(4097)
        need(len(raw) <= 4096, 'response too large')
        value = response(wire.loads(raw.decode('utf-8')), sent)
        need(received.status != 202 or value['jobId'] is not None, 'accepted work must name a durable job')
        return received.status, value
    finally:
        connection.close()


def reconcile_request(computer, job, source):
    need(wire.matches(UUID, computer) and wire.matches(UUID, job), 'reconcile requires the exact computer and failed job UUIDs')
    need(wire.matches(SOURCE_EXECUTION, source), 'source hint must be exactly one staging lifecycle execution ARN')
    need(not source.endswith(':computer-' + job), 'source hint cannot be the failed job itself')
    return dict(schemaVersion=1, operation=RECONCILE, computerId=computer, expectedJobId=job, sourceRetirementExecutionArn=source)


def reconcile_response(value, sent):
    need(isinstance(value, dict) and set(value) == {'schemaVersion', 'computerId', 'jobId', 'outcome'}, 'reconcile response fields mismatch')
    need(type(value['schemaVersion']) is int and value['schemaVersion'] == 1, 'reconcile response version mismatch')
    need(value['computerId'] == sent['computerId'] and value['jobId'] == sent['expectedJobId'], 'reconcile response names another computer or job')
    need(value['outcome'] in RECONCILE_OUTCOMES, 'reconcile outcome mismatch')
    return {k: value[k] for k in ('schemaVersion', 'computerId', 'jobId', 'outcome')}


def release_request(computer, job, execution):
    need(wire.matches(UUID, computer) and wire.matches(UUID, job), 'reconcile-release requires the exact computer and failed release job UUIDs')
    # Unlike reconcile-replacement, the hint is the expected job's OWN execution (the failed release, or its reserved replay).
    need(wire.matches(SOURCE_EXECUTION, execution) and execution.endswith(':computer-' + job),
         "the hint must be exactly the expected job's own staging lifecycle execution ARN")
    return dict(schemaVersion=1, operation=RECONCILE_RELEASE, computerId=computer, expectedJobId=job, releaseExecutionArn=execution)


def release_response(value, sent):
    need(isinstance(value, dict) and set(value) == {'schemaVersion', 'computerId', 'jobId', 'outcome', 'error'}, 'reconcile-release response fields mismatch')
    need(type(value['schemaVersion']) is int and value['schemaVersion'] == 1, 'reconcile-release response version mismatch')
    need(value['computerId'] == sent['computerId'] and value['jobId'] == sent['expectedJobId'], 'reconcile-release response names another computer or job')
    need(value['outcome'] in RELEASE_OUTCOMES, 'reconcile-release outcome mismatch')
    need(value['error'] is None or isinstance(value['error'], str) and wire.matches(r'[a-z_]{1,60}', value['error']), 'reconcile-release error code mismatch')
    return {k: value[k] for k in ('schemaVersion', 'computerId', 'jobId', 'outcome', 'error')}


def send_reconcile(sent, secret, validate=None):
    validate = validate or reconcile_response
    body = json.dumps(sent, separators=(',', ':')).encode('utf-8')
    auth = headers(body, secret, int(time.time()))
    connection = http.client.HTTPSConnection('os-staging.ezil.work', timeout=30)
    try:
        connection.request('POST', PATH, body=body, headers=auth)
        received = connection.getresponse()
        need(received.status == 200, 'authority denied, image job conflict or dependency unavailable; nothing to retry blindly')
        need(received.getheader('content-type', '').split(';')[0].strip().lower() == 'application/json', 'response must be JSON')
        raw = received.read(4097)
        need(len(raw) <= 4096, 'response too large')
        return validate(wire.loads(raw.decode('utf-8')), sent)
    finally:
        connection.close()


def reconcile(computer, job, source, apply, secret, sender=send_reconcile):
    """Ordinary proof-driven reconciliation writes (normal CAS) on the server; dry run unless --apply."""
    sent = reconcile_request(computer, job, source)
    if not apply:
        print('DRY RUN: ' + json.dumps(sent, separators=(',', ':')) + '; add --apply to submit')
        return None
    observed = sender(sent, secret)
    print(json.dumps(observed, separators=(',', ':')))
    return observed


def reconcile_release(computer, job, execution, apply, secret, sender=None):
    """The ordinary failed-release recovery on the server (normal CAS, release replay); dry run unless --apply."""
    sent = release_request(computer, job, execution)
    if not apply:
        print('DRY RUN: ' + json.dumps(sent, separators=(',', ':')) + '; add --apply to submit')
        return None
    observed = (sender or (lambda value, key: send_reconcile(value, key, release_response)))(sent, secret)
    print(json.dumps(observed, separators=(',', ':')))
    return observed


def operate(operation, computer, job, journal, apply, secret, sender=send):
    sent = request(operation, computer, job)
    journal = Path(journal)
    need(journal.is_absolute() and not journal.is_symlink(), 'absolute non-symlink journal required')
    state = wire.read(journal, 16384) if journal.exists() else None
    if state is not None:
        need(isinstance(state, dict) and set(state) == {'schemaVersion', 'computerId', 'jobId', 'pending', 'lastResponse'}, 'journal fields mismatch')
        need(type(state['schemaVersion']) is int and state['schemaVersion'] == 1, 'journal version mismatch')
        need(computer is None or state['computerId'] == computer, 'journal computer mismatch')
        need(job is None or job == state['jobId'], 'journal job CAS mismatch')
        need(state['jobId'] is None or wire.matches(UUID, state['jobId']), 'journal job mismatch')
        if state['pending'] is not None:
            pending = state['pending']
            need(request(pending['operation'], pending['computerId'], pending['jobId']) == pending, 'pending request mismatch')
        if state['lastResponse'] is not None:
            response(state['lastResponse'], request('plan', state['computerId'], state['jobId']))
        sent['jobId'] = state['jobId']
    else:
        state = dict(schemaVersion=1, computerId=computer, jobId=job, pending=None, lastResponse=None)
    mutating = operation in ('prepare', 'launch', 'recover')
    if mutating and not apply:
        print('DRY RUN: ' + json.dumps(sent, separators=(',', ':')) + '; add --apply to submit')
        return
    # A lost create result is reconciled with plan; never issue a second unbound prepare.
    if state['pending'] is not None and state['jobId'] is None:
        need(state['computerId'] is not None, 'uncertain request needs explicit job')
        status, observed = sender(request('plan', state['computerId'], None), secret)
        need(status == 200 and observed['jobId'] is not None, 'unconfirmed prepare; keep journal and reconcile server job')
        state.update(jobId=observed['jobId'], lastResponse=observed, pending=None)
        sent['jobId'] = observed['jobId']
        json_tool.write(journal, state)
    if operation in ('launch', 'recover'):
        need(sent['jobId'] is not None, 'launch/recover requires an existing journal or --job')
    if state['lastResponse'] and state['lastResponse']['phase'] in ('succeeded', 'recovered', 'cancelled') and mutating:
        raise ValueError('terminal job retained; use a separately reviewed new job')
    journal.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if mutating:
        state['pending'] = sent
        json_tool.write(journal, state)  # fsync before the network call
    status, observed = sender(sent, secret)
    # Preserve uncertainty on CAS errors; never rotate/retry an uncertain mutation.
    state.update(computerId=observed['computerId'], jobId=observed['jobId'], lastResponse=observed)
    if status != 409:
        state['pending'] = None
    json_tool.write(journal, state)
    print(json.dumps(observed, separators=(',', ':')))
    need(status != 409, 'phase/job CAS conflict; retained for reconciliation')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=(*OPERATIONS, RECONCILE, RECONCILE_RELEASE))
    parser.add_argument('--computer')
    parser.add_argument('--job')
    parser.add_argument('--source-execution-arn')
    parser.add_argument('--journal', type=Path)
    parser.add_argument('--origin', default=ORIGIN)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    need(args.origin == ORIGIN, 'only os-staging is allowed; btgq/curomaa refused')
    if args.operation == RECONCILE:
        reconcile_request(args.computer, args.job, args.source_execution_arn)
        reconcile(args.computer, args.job, args.source_execution_arn, args.apply, os.environ.get('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', ''))
        return
    if args.operation == RECONCILE_RELEASE:
        release_request(args.computer, args.job, args.source_execution_arn)
        reconcile_release(args.computer, args.job, args.source_execution_arn, args.apply, os.environ.get('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', ''))
        return
    need(args.source_execution_arn is None, 'source hint is only for reconcile-replacement or reconcile-release')
    request(args.operation, args.computer, args.job)
    journal = args.journal or Path('/root/ezil-aws-mum/rebase-computers') / ((args.computer or args.job) + '.json')
    # Use only the existing environment name; never a credential file, CLI argument or log.
    secret = os.environ.get('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', '')
    operate(args.operation, args.computer, args.job, journal, args.apply, secret)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, http.client.HTTPException):
        print('ERROR: computer operation refused or unconfirmed; retain the journal and reconcile staging authority/job state.', file=sys.stderr)
        sys.exit(1)
