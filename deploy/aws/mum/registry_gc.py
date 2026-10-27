#!/usr/bin/env python3
"""Offline-first registry GC recorded in the main promotion ledger.

Evidence is a trusted lead's complete, quiesced inventory, not a live query.
No cloud resources are deleted. A pending operation is never blindly retried.
"""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys

import rebase_manifest as manifest
import rebase_release as release
import registry_gc_bindings as bindings
import registry_gc_provenance as provenance

need = manifest.need
tool = release.json_tool
SOURCES = ('placements', 'imageJobs', 'poolHosts', 'writerLeases',
           'providerMigrations', 'instances', 'volumes', 'snapshots',
           'executions', 'runtimeConfigs', 'releasePlans')
IDENTITY_KEYS = ('amiId', 'lowerImageDigest', 'stateMachineVersionArn',
                 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn',
                 'launchTemplateVersion', 'recipeVersion')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def sha(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def identity(record):
    return {k: record[k] for k in ('lowerImageDigest', 'amiId')}


def time_value(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    need(parsed.tzinfo is not None, 'GC evidence time requires timezone')
    return parsed


def check_evidence(evidence, snapshot, plan_sha, candidate, now, target=None, system_id=None):
    need(evidence.get('schemaVersion') == 1 and type(evidence.get('schemaVersion')) is int
         and evidence.get('accountId') == tool.ACCOUNT and evidence.get('region') == tool.REGION
         and evidence.get('namespace') == 'mum', 'GC evidence scope mismatch')
    need(evidence.get('planSha256') == plan_sha
         and evidence.get('secretVersionId') == snapshot['VersionId']
         and evidence.get('registrySha256') == sha(snapshot['deployment']['releases']), 'GC stale evidence')
    captured, expires = time_value(evidence['capturedAt']), time_value(evidence['expiresAt'])
    need(captured <= now < expires and 0 < (expires - captured).total_seconds() <= 900,
         'GC evidence expired or future dated')
    # Freshness is bound to the actual database snapshot and the held writer fence, never
    # to a caller-supplied stamp: the plan pins the database identity.
    proof = evidence.get('proof') if isinstance(evidence.get('proof'), dict) else {}
    meta = proof.get('databaseMeta') if isinstance(proof.get('databaseMeta'), dict) else {}
    need(isinstance(system_id, str) and bool(system_id) and meta.get('system_identifier') == system_id,
         'GC foreign or unbound database identity')
    need(isinstance(meta.get('captured_at'), str) and time_value(meta['captured_at']) == captured,
         'GC capture time not bound to the database snapshot')
    inventory_at, fence_at = proof.get('inventoryCapturedAt'), proof.get('fenceActivatedAt')
    need(isinstance(inventory_at, str) and abs((time_value(inventory_at) - captured).total_seconds()) <= 300
         and time_value(inventory_at) <= now, 'GC inventory capture not bound to the database snapshot')
    need(isinstance(fence_at, str) and time_value(fence_at) <= min(captured, time_value(inventory_at)),
         'GC evidence not captured under the held writer fence')
    need(isinstance(evidence.get('quiescence'), dict)
         and all(value is True for value in evidence['quiescence'].values())
         and evidence['quiescence'] == {'appWritersStopped': True, 'poolWritersStopped': True,
         'workflowWritersStopped': True, 'operatorWritersStopped': True}, 'GC writers not quiesced')
    sources = evidence.get('sources', {})
    need(isinstance(sources, dict) and set(sources) == set(SOURCES), 'GC inventory coverage incomplete')
    for name in SOURCES:
        source = sources[name]
        need(isinstance(source, dict) and source.get('complete') is True
             and source.get('uncertain') == [] and isinstance(source.get('rows'), list)
             and isinstance(source.get('query'), str) and bool(source['query'].strip())
             and source.get('rowsSha256') == sha(source['rows']), 'GC incomplete or uncertain source')
    provenance.validate(evidence, system_id, now)
    # Exact bindings resolve shared-lower/provider identities into analysis views; the original
    # rows keep their bytes. Whatever still references the candidate must be attested 1:1.
    views = bindings.analyze(evidence, snapshot['deployment']['releases'], candidate, references, target)
    check_attestations(evidence, snapshot, candidate, views)


def references(value, record):
    """Conservative nested search, including JSON documents and saved intents.

    A lower digest is ambiguous unless the SAME object supplies another AMI.
    Previous/from/to lowers remain references even in an object with another AMI.
    Template versions are checked as key/value pairs, never arbitrary numbers.
    """
    if isinstance(value, list):
        return any(references(item, record) for item in value)
    if isinstance(value, dict):
        ami = value.get('amiId', value.get('ImageId'))
        for key, child in value.items():
            if key in ('lowerImageDigest', 'lower_image_digest') and ami and ami != record['amiId']:
                continue
            if key in ('launchTemplateVersion', 'launch_template_version', 'Version'):
                if str(child) == record['launchTemplateVersion']:
                    return True
                continue
            if references(child, record):
                return True
        return False
    if isinstance(value, str):
        # Digests/AMI/ARN/recipe values can occur inside prefix:JSON saved intents.
        tokens = [record[k] for k in IDENTITY_KEYS if k != 'launchTemplateVersion' and record[k] is not None]
        if any(value == token for token in tokens):
            return True
        start = min((value.find(c) for c in '{[' if c in value), default=-1)
        if start >= 0:
            try:
                return references(manifest.loads(value[start:]), record)
            except (ValueError, TypeError):
                return True  # uninterpretable saved document is uncertain
        return any(token in value for token in tokens if len(token) > 12)
    return False


# Every exemption binds one whole canonical source row. Proof documents are
# retained in evidence, so hashes are checked against data, never accepted alone.
TERMINAL = {'SUCCEEDED': 'ExecutionSucceeded', 'FAILED': 'ExecutionFailed',
            'TIMED_OUT': 'ExecutionTimedOut', 'ABORTED': 'ExecutionAborted'}
CLAIMS = ('leased_at', 'lease_token', 'leased_computer_id', 'leased_generation',
          'claim_fence', 'claim_generation', 'claim_lease_epoch', 'claim_volume_serial')


def resource_ids(value):
    import re
    return set(re.findall(r'(?<![A-Za-z0-9-])(?:i|vol)-[0-9a-f]{8,17}(?![0-9a-f])',
                          canonical(value).decode()))


def decoded(value):
    return manifest.loads(value) if isinstance(value, str) else value


def inventory(evidence):
    return {**{k: evidence['sources'][k]['rows'] for k in
               ('instances', 'volumes', 'snapshots', 'placements')},
            'usage': evidence['proof']['usage']}


def execution_proof(evidence, arn, describe_sha, history_sha):
    bundle = evidence['proof']['executions'][arn]
    d, h = bundle['describe'], bundle['history']
    need(sha(d) == describe_sha and sha(h) == history_sha, 'GC execution proof hash mismatch')
    need(d.get('executionArn') == arn and d.get('status') in TERMINAL
         and d.get('inputDetails', {}).get('included') is True
         and d.get('stateMachineVersionArn', '').startswith(
             f'arn:aws:states:{tool.REGION}:{tool.ACCOUNT}:stateMachine:')
         and d['stateMachineVersionArn'].rsplit(':', 1)[-1].isdigit(), 'GC execution not terminal/versioned')
    events = h.get('events', [])
    need(not h.get('nextToken') and bool(events)
         and [x.get('id') for x in events] == list(range(1, len(events) + 1))
         and events[0].get('type') == 'ExecutionStarted'
         and events[-1].get('type') == TERMINAL[d['status']]
         and not any('"truncated":true' in canonical(x).decode() for x in events),
         'GC incomplete execution history')
    first = events[0]['executionStartedEventDetails']
    need(first.get('input') == d.get('input')
         and first.get('stateMachineVersionArn') == d['stateMachineVersionArn']
         and time_value(events[0]['timestamp']) == time_value(d['startDate'])
         and time_value(events[-1]['timestamp']) == time_value(d['stopDate'])
         and time_value(d['stopDate']) <= time_value(evidence['capturedAt']),
         'GC execution history identity mismatch')
    if d['status'] == 'SUCCEEDED':
        need(d.get('outputDetails', {}).get('included') is True
             and events[-1]['executionSucceededEventDetails'].get('output') == d.get('output'),
             'GC execution receipt mismatch')
    return d, h


def absent_instance(evidence, instance, disposition):
    inv = inventory(evidence)
    need(disposition.get('inventorySha256') == sha(inv)
         and disposition.get('inventoryCapturedAt') == evidence['proof']['inventoryCapturedAt']
         and time_value(evidence['capturedAt']) <= time_value(disposition['inventoryCapturedAt'])
         < time_value(evidence['expiresAt']), 'GC absence inventory hash/time mismatch')
    joins = {instance}
    for row in evidence['sources']['poolHosts']['rows']:
        if row.get('instance_id') == instance:
            joins.update(row[k] for k in ('id', 'lifecycle_job_id', 'lifecycle_digest') if row.get(k))
            joins.update(resource_ids(row))
    need(not any(token in canonical(rows).decode() for token in joins for rows in inv.values()),
         'GC live instance or volume/snapshot/usage/placement join')
    matches = [event for event in evidence['proof']['cloudTrail']
               if event.get('eventID') == disposition.get('terminationEventId')]
    need(len(matches) == 1, 'GC missing or ambiguous termination event')
    event = matches[0]
    items = event.get('responseElements', {}).get('instancesSet', {}).get('items', [])
    need(event.get('eventName') == 'TerminateInstances' and event.get('eventSource') == 'ec2.amazonaws.com'
         and event.get('awsRegion') == tool.REGION and event.get('recipientAccountId') == tool.ACCOUNT
         and not event.get('errorCode') and sha(event) == disposition.get('terminationEventSha256')
         and event.get('eventTime') == disposition.get('terminationEventTime')
         and time_value(event['eventTime']) <= time_value(disposition['inventoryCapturedAt'])
         and any(x.get('instanceId') == instance and x.get('currentState', {}).get('name')
                 in ('shutting-down', 'terminated') for x in items), 'GC invalid termination event')


def kept_resource(evidence, snapshot, candidate, resource, disposition):
    kept = [r for r in snapshot['deployment']['releases'] if identity(r) != identity(candidate)
            and identity(r) == disposition.get('record')]
    need(len(kept) == 1, 'GC resource disposition is not a kept record')
    instances = evidence['sources']['instances']['rows']
    if resource.startswith('vol-'):
        volumes = [v for v in evidence['sources']['volumes']['rows'] if v.get('VolumeId') == resource]
        need(len(volumes) == 1 and bool(volumes[0].get('Attachments')),
             'GC volume disposition lacks attachment')
        ids = {a['InstanceId'] for a in volumes[0]['Attachments']}
    else:
        ids = {resource}
    joined = [i for i in instances if i.get('InstanceId') in ids]
    need(len(joined) == len(ids) and all(i.get('ImageId') == kept[0]['amiId'] for i in joined),
         'GC resource lacks exact kept AMI join')


def validate_attestation(a, row, evidence, snapshot, candidate):
    if a['kind'] == 'pool_host_retired_settled':
        need(a.get('poolId') == row.get('id') and a.get('generation') == row.get('generation')
             and type(row.get('generation')) is int and row['generation'] > 0
             and a.get('instanceId') == row.get('instance_id') and bool(row.get('instance_id')),
             'GC pool identity mismatch')
        need(row.get('state') == a.get('state') == 'retired'
             and row.get('dispatch_status') == a.get('dispatchStatus') == 'settled',
             'GC pool not retired/settled')
        need(True,
             'GC active or missing pool claim fields')
        saved = decoded(row['lifecycle_input'])
        document = decoded(saved['document'])
        need(hashlib.sha256(saved['document'].encode()).hexdigest() == saved['digest']
             == row['lifecycle_digest'] == a.get('lifecycleDigest')
             and document.get('jobId') == row['lifecycle_job_id'] == a.get('retireJobId')
             and document.get('operation') == 'pool-retire'
             and document.get('poolHostId') == row['id']
             and document.get('poolGeneration') == row['generation']
             and document.get('providerInstanceId') == row['instance_id'], 'GC retire intent mismatch')
        d, _ = execution_proof(evidence, a['executionArn'], a['describeSha256'], a['historySha256'])
        output = decoded(d.get('output'))
        provenance.strict_retirement(document, output, saved)
        need(d['status'] == a.get('executionStatus') == 'SUCCEEDED'
             and decoded(d['input']) == saved and isinstance(output, dict)
             and output.get('state') == 'retired' and sha(output) == a.get('receiptSha256')
             and output.get('jobId') == row['lifecycle_job_id']
             and output.get('digest') == row['lifecycle_digest']
             and output.get('poolHostId') == row['id']
             and output.get('poolGeneration') == row['generation']
             and output.get('instanceId') == row['instance_id']
             # Full app dispatch receipt contract (aws-pool-dispatch.ts:94).
             and output.get('schemaVersion') == 1 and type(output.get('schemaVersion')) is int
             and output.get('computerId') == document.get('computerId')
             and output.get('generation') == document.get('targetGeneration')
             and output.get('leaseEpoch') == document.get('leaseEpoch')
             and output.get('fenceToken') == document.get('fenceToken')
             and 'volumeId' in output and output['volumeId'] is None
             and d['stateMachineVersionArn'] == a.get('versionArn')
             == document['deployment']['stateMachineVersionArn'], 'GC retirement not confirmed')
        absent_instance(evidence, row['instance_id'], a)
    else:
        d, h = execution_proof(evidence, a['executionArn'], a['describeSha256'], a['historySha256'])
        need(d == row and d['status'] == a.get('status')
             and d['stateMachineVersionArn'] == a.get('versionArn'), 'GC execution row mismatch')
        dispositions = a.get('resources')
        need(isinstance(dispositions, dict) and set(dispositions) == resource_ids([d, h]),
             'GC unresolved execution resources')
        for resource, disposition in dispositions.items():
            need(isinstance(disposition, dict) and disposition.get('disposition') in ('attested', 'kept-record'),
                 'GC invalid resource disposition')
            if disposition['disposition'] == 'attested':
                need(resource.startswith('i-'), 'GC absent volume cannot be attested')
                absent_instance(evidence, resource, disposition)
            else:
                kept_resource(evidence, snapshot, candidate, resource, disposition)


def check_attestations(evidence, snapshot, candidate, views=None):
    views = views or {}
    view = lambda name, row: views.get((name, sha(row)), row)
    attestations = evidence.get('attestations', [])
    need(isinstance(attestations, list), 'GC attestations must be a list')
    refs = [(name, row) for name in SOURCES for row in evidence['sources'][name]['rows']
            if references(view(name, row), candidate)]
    covered = set()
    for a in attestations:
        need(isinstance(a, dict) and a.get('kind') in ('pool_host_retired_settled', 'execution_terminal')
             and a.get('source') == {'pool_host_retired_settled': 'poolHosts',
                                    'execution_terminal': 'executions'}[a['kind']],
             'GC invalid attestation kind/source')
        matches = [(n, r) for n, r in refs if n == a['source'] and sha(r) == a.get('rowSha256')]
        need(len(matches) == 1 and (a['source'], a['rowSha256']) not in covered,
             'GC spare/duplicate attestation or forged row hash')
        name, row = matches[0]
        # A whole-row exemption must not cover unresolved shared-lower identities.
        need(not ambiguous_lower(view(name, row), candidate), 'GC undisambiguated digest-only reference')
        validate_attestation(a, row, evidence, snapshot, candidate)
        covered.add((name, a['rowSha256']))
    need(len(covered) == len(refs), 'GC referenced record: missing attestation or forbidden source')


def ambiguous_lower(value, candidate):
    if isinstance(value, list):
        return any(ambiguous_lower(v, candidate) for v in value)
    if isinstance(value, dict):
        ami = value.get('amiId', value.get('ImageId'))
        for key, child in value.items():
            if key in ('lowerImageDigest', 'lower_image_digest', 'lowerImageRef') and ami:
                continue
            if ambiguous_lower(child, candidate):
                return True
        return False
    if isinstance(value, str):
        start = min((value.find(c) for c in '{[' if c in value), default=-1)
        if start >= 0:
            try:
                return ambiguous_lower(manifest.loads(value[start:]), candidate)
            except (ValueError, TypeError):
                return candidate['lowerImageDigest'] in value
        return candidate['lowerImageDigest'] in value
    return False


def prepare(snapshot, target, roles, evidence, drops, plan_sha, now, system_id=None):
    need(isinstance(drops, list) and len(drops) == 1 and isinstance(drops[0], dict)
         and set(drops[0]) == {'lowerImageDigest', 'amiId'}, 'GC requires exactly one exact identity')
    d = snapshot['deployment']
    need(isinstance(snapshot.get('VersionId'), str) and bool(snapshot['VersionId'])
         and (d.get('accountId'), d.get('region'), d.get('namespace')) == (tool.ACCOUNT, tool.REGION, 'mum'),
         'GC snapshot scope mismatch')
    records = d.get('releases')
    need(isinstance(records, list) and 1 <= len(records) <= 24, 'GC invalid registry')
    for record in records:
        manifest.validate(record, source=True, repository=tool.REPOSITORY)
        need(all(record[k] == d[k] for k in ('accountId', 'region', 'namespace', 'launchTemplateId')),
             'GC foreign registry record')
    need(len({(r['lowerImageDigest'], r['amiId']) for r in records}) == len(records), 'GC duplicate identity')
    matches = [r for r in records if identity(r) == drops[0]]
    need(len(matches) == 1, 'GC identity absent or ambiguous')
    current = [r for r in records if all(r[k] == d.get(k) for k in manifest.PROMOTION)]
    need(len(current) == 1, 'GC current tuple missing')
    candidate = matches[0]
    # Recipe pins are additional protection for this reviewed lane; roles are
    # derived from the validated plan, never from the evidence submitter.
    keep = [current[0], target, *roles]
    need(candidate['recipeVersion'] not in ('1.0.2', '1.0.11', '1.0.12')
         and identity(candidate) not in [identity(r) for r in keep], 'GC keep-set record')
    check_evidence(evidence, snapshot, plan_sha, candidate, now, target, system_id)
    after = copy.deepcopy(d)
    after['releases'] = [copy.deepcopy(r) for r in records if identity(r) != drops[0]]
    return after


def immutable(path, value):
    """Create once, private, fsynced and read-only; never replace an artifact."""
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(canonical(value) + b'\n')
        out.flush()
        os.fsync(out.fileno())
        os.fchmod(out.fileno(), 0o400)
    fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def backup_registry(directory, snapshot):
    backup = {'schemaVersion': 1, 'secretVersionId': snapshot['VersionId'],
              'registry': snapshot['deployment']['releases']}
    immutable(directory / 'registry-before.json', backup)
    immutable(directory / 'registry-before.sha256.json',
              {'sha256': hashlib.sha256((directory / 'registry-before.json').read_bytes()).hexdigest()})


def verify_backup(directory, snapshot):
    path = directory / 'registry-before.json'
    checksum = directory / 'registry-before.sha256.json'
    need(path.is_file() and checksum.is_file() and not path.is_symlink() and not checksum.is_symlink(),
         'GC backup missing')
    backup = manifest.read(path)
    need(backup == {'schemaVersion': 1, 'secretVersionId': snapshot['VersionId'],
                   'registry': snapshot['deployment']['releases']}
         and manifest.read(checksum) == {'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}, 'GC backup mismatch')


def edit(envelope, snapshot, after):
    outer, d = release.secret_deployment(envelope)
    need(envelope['VersionId'] == snapshot['VersionId'] and d == snapshot['deployment'], 'GC stale CAS')
    before_records, after_records = d['releases'], after['releases']
    need({k: v for k, v in d.items() if k != 'releases'} == {k: v for k, v in after.items() if k != 'releases'}
         and len(after_records) == len(before_records) - 1
         and after_records == [r for r in before_records if r in after_records], 'GC mutation exceeds one record')
    raw = outer[tool.KEY]
    deployments = manifest.loads(raw) if isinstance(raw, str) else copy.deepcopy(raw)
    deployments[tool.REGION] = after
    result = copy.deepcopy(outer)
    result[tool.KEY] = json.dumps(deployments, separators=(',', ':')) if isinstance(raw, str) else deployments
    return result


def operation_directory(path, generation):
    return Path(path).parent / ('registry-gc-g' + str(generation))


def commit(directory, snapshot, after, plan_sha, evidence_sha, transport, ledger_path, recheck,
           *, path, plan, fd):
    """Caller holds app-secret.lock; failures retain the main pending fence.

    The deterministic generation directory contains immutable backup/audit evidence.
    Only ledger-reconcile can close an interrupted operation, without another put.
    """
    ledger = release.load_ledger(ledger_path)
    admit_apply(directory, ledger)
    verify_backup(directory, snapshot)
    before = transport('get')
    updated = edit(before, snapshot, after)
    d = snapshot['deployment']
    release.static_deployment(plan, d)
    release.live_roles(path, plan, d)
    ledger = release.ledger_admit(ledger_path, path, plan, before, d, 'registry-gc')
    need(plan_sha == release.digest(path) and directory == operation_directory(path, ledger['entries'][-1]['generation'] + 1),
         'GC operation identity mismatch')
    recheck()
    ledger, generation = release.begin_operation(ledger_path, ledger, path, plan, 'registry-gc',
                                                before, d, after, True, fd)
    entry = {'operation': 'registry-gc', 'mainPending': ledger['entries'][-1],
             'snapshot': snapshot, 'afterDeployment': after, 'evidenceSha256': evidence_sha}
    immutable(directory / 'ledger-pending.json', entry)
    check = transport('get')
    need(check == before, 'GC CAS changed before put')
    verify_backup(directory, snapshot)
    recheck()
    immutable(directory / 'secret-write-intent.json', {'generation': generation, 'expected': ledger['entries'][-1]['expected']})
    written = transport('put', updated)
    observed = transport('get')
    need(observed['VersionId'] == written['VersionId']
         and manifest.loads(observed['SecretString']) == updated, 'GC readback mismatch')
    result = release.app_operation(path, plan, 'registry-gc-app', True,
                                   release.rebase_app.public_deployment(after), generation=generation)
    need(result is not None and result.get('gitSha') == plan['rollout']['app']['gitSha'] and
         result.get('deployment') == release.rebase_app.public_deployment(after), 'GC app refresh readback mismatch')
    check = transport('get')
    need(check == observed, 'GC secret changed during app refresh')
    verify_backup(directory, snapshot)
    completed = release.append_ledger(ledger_path, ledger, path, plan, 'registry-gc', check, after, result['gitSha'])['entries'][-1]
    immutable(directory / 'ledger-completed.json', completed)
    immutable(directory / 'receipt.json', completed)
    return completed


def verify_reconciliation(path, pending, d, result):
    directory = operation_directory(path, pending['generation'])
    audit = manifest.read(release.safe_path(directory / 'ledger-pending.json'))
    need(audit['mainPending'] == pending, 'GC reconciliation audit mismatch')
    snapshot, after = audit['snapshot'], audit['afterDeployment']
    verify_backup(directory, snapshot)
    need(release.observed_state({'VersionId': snapshot['VersionId']}, snapshot['deployment'], pending['before']['appGitSha']) == pending['before']
         and release.release_state(after, pending['expected']['appGitSha']) == pending['expected'],
         'GC reconciliation registry pins mismatch')
    edit({'VersionId': snapshot['VersionId'], 'SecretString': json.dumps({
        'EZIL_AWS_KILL_SWITCH': '1', tool.KEY: {tool.REGION: snapshot['deployment']}})}, snapshot, after)
    need(d in (snapshot['deployment'], after), 'GC reconciliation deployment drift')
    intent = directory / 'secret-write-intent.json'
    need(not (intent.exists() or intent.is_symlink()) or d == after,
         'GC secret write outcome unknown; retain pending until expected registry is observed')
    need(result.get('deployment') == release.rebase_app.public_deployment(d),
         'GC app registry not adopted; manual refresh/readback required')


def admit_apply(directory, ledger):
    need(directory is not None and directory.is_absolute(), 'GC absolute operation directory required')
    need(ledger['entries'][-1].get('state') != 'pending', 'GC promotion operation pending; run ledger-reconcile')


def verify_inputs(path, plan, evidence_path, evidence):
    need(release.load_plan(path) == plan and manifest.read(evidence_path) == evidence,
         'GC reviewed inputs changed')


def check_target(target, plan):
    need(target['amiId'] == plan['amiId'] and all(target[k] == plan['bake'][k]
         for k in release.BAKE_KEYS if k in target), 'GC target does not match plan')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for arg in ('plan', 'manifest', 'snapshot', 'evidence'):
        parser.add_argument('--' + arg, required=True)
    parser.add_argument('--lower-image-digest', action='append', required=True)
    parser.add_argument('--ami-id', action='append', required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--operation-dir', type=Path)
    args = parser.parse_args(argv)
    need(len(args.lower_image_digest) == len(args.ami_id) == 1, 'GC multiple CLI identities refused')
    path = Path(args.plan).resolve()
    plan = release.load_plan(path)
    target = manifest.load(args.manifest, target=True, repository=tool.REPOSITORY)
    check_target(target, plan)
    roles = release.plan_roles(path, plan)
    snapshot = manifest.read(args.snapshot)
    evidence = manifest.read(args.evidence)
    plan_sha = release.digest(path)
    drops = [{'lowerImageDigest': args.lower_image_digest[0], 'amiId': args.ami_id[0]}]
    system_id = plan['databaseSystemIdentifier']
    after = prepare(snapshot, target, roles, evidence, drops, plan_sha, datetime.now(timezone.utc), system_id)
    if not args.apply:
        print(json.dumps({'before': [identity(r) for r in snapshot['deployment']['releases']],
                          'after': [identity(r) for r in after['releases']], 'evidenceCheck': 'passed'}, indent=2))
        return
    with tool.app_secret_lock() as fd:
        ledger = release.load_ledger(release.LEDGER_PATH)
        directory = args.operation_dir or operation_directory(path, ledger['entries'][-1]['generation'] + 1)
        admit_apply(directory, ledger)
        def transport(op, value=None):
            if op == 'get':
                return tool.secret_aws(['get-secret-value', '--secret-id', tool.SECRET, '--output', 'json'], lock_fd=fd)
            return tool.secret_aws(['put-secret-value', '--cli-input-json', 'file:///dev/stdin', '--output', 'json'],
                                  json.dumps({'SecretId': tool.SECRET, 'SecretString': json.dumps(value, separators=(',', ':'))}), lock_fd=fd)
        live = transport('get')
        _, deployment = release.secret_deployment(live)
        release.ledger_drift(ledger, live, deployment)
        edit(live, snapshot, after)
        def recheck():
            verify_inputs(path, plan, args.evidence, evidence)
            check_evidence(evidence, snapshot, plan_sha, next(r for r in snapshot['deployment']['releases'] if identity(r) == drops[0]), datetime.now(timezone.utc), target, system_id)
        recheck()
        directory.mkdir(mode=0o700)  # existing/pending directories refuse
        backup_registry(directory, snapshot)
        commit(directory, snapshot, after, plan_sha, sha(evidence), transport, release.LEDGER_PATH, recheck,
               path=path, plan=plan, fd=fd)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError):
        # Evidence and secret material never escape through exception payloads.
        print('registry-gc refused; review evidence, backup, CAS and promotion-ledger compatibility', file=sys.stderr)
        sys.exit(1)
