#!/usr/bin/env python3
"""Build review evidence from local exports only; never contacts AWS or a DB.

A missing proof produces an unresolved reference, not an exemption. Context is
an optional reviewed JSON containing the ordinary GC pins, collection times,
quiescence and runtimeConfigs/releasePlans sources. Never invent fresh capture
or writer-fence claims from file modification times.
"""
import argparse
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import sys

import registry_gc as gc
import registry_gc_bindings as bindings
import registry_gc_provenance as provenance


BINDABLE = {'placements': 'placement_image', 'imageJobs': 'image_job_releases',
            'snapshots': 'historical_imagebuilder_root', 'releasePlans': 'original_plan_target'}


def compare_execution_observations(row, d):
    gaps = []
    required = ('executionArn','stateMachineArn','status','startDate','name')
    if any(k not in row or k not in d for k in required): gaps.append('missing list/describe identity')
    if ('redriveStatus' in d and d['redriveStatus'] not in ('REDRIVABLE','NOT_REDRIVABLE','REDRIVABLE_BY_MAP_RUN')) or ('redriveStatusReason' in d and type(d['redriveStatusReason']) is not str):
        gaps.append('invalid Describe-only redrive status')
    shared = ('executionArn','stateMachineArn','stateMachineVersionArn','stateMachineAliasArn',
              'status','startDate','stopDate','redriveCount','redriveDate','name')
    conflicts = [k for k in shared if (k in row or k in d) and
                 (k not in row or k not in d or type(row[k]) is not type(d[k]) or row[k] != d[k])]
    if conflicts: gaps.append('describe contradicts list (' + ','.join(conflicts) + ')')
    return gaps


def collect(directory, candidate_name, context=None):
    directory = Path(directory)
    files = {}
    contents = {}

    def read(path):
        path = Path(path)
        data = path.read_bytes()
        name = str(path.relative_to(directory))
        digest = hashlib.sha256(data).hexdigest()
        gc.need(name not in files or files[name] == digest, 'E1 consumed file changed')
        files[name] = digest
        contents[name] = data.decode()
        return gc.manifest.loads(data.decode())

    db = read(directory / 'db-evidence.json')
    records = read(directory / 'registry-snapshot.json')
    candidates = [r for r in records if candidate_name in (r['recipeVersion'], r['amiId'])]
    gc.need(len(candidates) == 1, 'collector candidate absent or ambiguous')
    candidate = candidates[0]
    captured = db['meta']['captured_at']
    evidence = {'schemaVersion': 1, 'accountId': gc.tool.ACCOUNT, 'region': gc.tool.REGION,
                'namespace': 'mum', 'registrySha256': gc.sha(records),
                'planSha256': None, 'secretVersionId': None, 'capturedAt': captured,
                'expiresAt': (gc.time_value(captured) + timedelta(minutes=15)).isoformat(),
                'quiescence': {}, 'sources': {}, 'attestations': [],
                'proof': {'usage': db['usage'], 'databaseMeta': db['meta'],
                          'inventoryCapturedAt': None, 'cloudTrail': [], 'executions': {}}}
    if context:
        # Context never restamps old inputs: capture time comes only from the DB snapshot.
        gc.need(context.get('capturedAt', captured) == captured and context.get('expiresAt', evidence['expiresAt']) == evidence['expiresAt'],
                'collector context restamps capture time')
        for key in ('planSha256', 'secretVersionId', 'quiescence'):
            evidence[key] = context[key]
        evidence['proof']['inventoryCapturedAt'] = context['inventoryCapturedAt']
        evidence['proof']['fenceActivatedAt'] = context['fenceActivatedAt']
        if 'originalPlanJson' in context:
            evidence['proof']['originalPlanJson'] = context['originalPlanJson']
    unresolved = []

    def source(name, rows, query, uncertain=None):
        evidence['sources'][name] = {'complete': not uncertain, 'uncertain': uncertain or [],
                                    'query': query, 'rows': rows, 'rowsSha256': gc.sha(rows)}

    for name, key in [('placements', 'placements'), ('imageJobs', 'image_jobs'),
                      ('poolHosts', 'pool_hosts'), ('writerLeases', 'writer_leases'),
                      ('providerMigrations', 'migrations')]:
        source(name, db[key], 'db-evidence.json:' + key)
    for name, key in [('instances', 'Reservations'), ('volumes', 'Volumes'), ('snapshots', 'Snapshots')]:
        data = read(directory / ('ec2-' + name + '.json'))
        rows = data[key]
        if name == 'instances':
            rows = [i for reservation in rows for i in reservation['Instances']]
        source(name, rows, 'ec2-' + name + '.json (all account resources)',
               ['pagination token present'] if data.get('NextToken') else [])
    evidence['proof']['ec2Definitions'] = {
        path.name: read(path) for path in sorted(directory.glob('ec2-*.json'))
        if path.name not in files}
    for name in ('runtimeConfigs', 'releasePlans'):
        if context and name in context.get('sources', {}):
            evidence['sources'][name] = context['sources'][name]
        else:
            source(name, [], 'not collected', ['missing ' + name])
    # Accept raw CloudTrail records or standard lookup-events/Records envelopes.
    for path in sorted(directory.rglob('*.json')):
        if not any(token in str(path.relative_to(directory)).lower() for token in
                   ('cloudtrail', 'termination', 'terminateinstances', 'runinstances', 'run-instances', 'events.json')):
            continue
        data = read(path)
        events = data.get('Events', data.get('Records', [data])) if isinstance(data, dict) else data
        # A preserved provider receipt wraps exactly one raw record under 'event'.
        events = [e['event'] if isinstance(e, dict) and set(e) >= {'event', 'resourceId', 'query'} else e for e in events]
        for event in events:
            evidence['proof']['cloudTrail'].append(gc.decoded(event.get('CloudTrailEvent', event)))
    describes = {}
    execution_gaps = []
    ambiguous_describes = set()
    for path in sorted(directory.glob('exec*/*.describe.json')):
        d = read(path)
        arn = d['executionArn']
        if arn in describes or arn in ambiguous_describes:
            execution_gaps.append(arn + ': duplicate/ambiguous describe observations')
            ambiguous_describes.add(arn)
            describes.pop(arn, None)
            evidence['proof']['executions'].pop(arn, None)
            continue
        if d.get('status') not in gc.TERMINAL:
            execution_gaps.append(arn + ': nonterminal describe observation')
        history = path.with_name(path.name.replace('.describe.json', '.history.json'))
        if history.is_file():
            evidence['proof']['executions'][d['executionArn']] = {'describe': d, 'history': read(history)}
        describes[d['executionArn']] = d
    execution_rows = {}
    for path in sorted(directory.glob('sfn-*.json')):
        data = read(path)
        if data.get('nextToken'):
            execution_gaps.append(path.name + ': pagination token present')
        for row in data['executions']:
            arn = row['executionArn']
            # Duplicate or contradictory observations are unresolved, never silently replaced.
            if arn in execution_rows:
                execution_gaps.append(arn + ': duplicate/ambiguous list observations')
                if row.get('status') not in gc.TERMINAL:
                    execution_rows[arn] = row
            else:
                execution_rows[arn] = row
            if row.get('status') not in gc.TERMINAL:
                execution_gaps.append(arn + ': nonterminal or unknown execution status ' + str(row.get('status')))
    for arn, d in describes.items():
        row = execution_rows.get(arn)
        if row is None:
            execution_gaps.append(arn + ': describe without list observation')
            execution_rows[arn] = d
            continue
        conflicts = compare_execution_observations(row, d)
        if conflicts:
            execution_gaps.extend(arn + ': ' + message for message in conflicts)
        else:
            execution_rows[arn] = d
    source('executions', list(execution_rows.values()), 'sfn-*.json + exec*/*.describe.json', execution_gaps)
    receipt_path = directory / 'E1' / 'collection-receipts.json'
    # The receipt manifest is not a self-receipted input file.
    receipts = gc.manifest.loads(receipt_path.read_text())
    for name in receipts.get('files', {}):
        gc.need(not Path(name).is_absolute() and '..' not in Path(name).parts, 'E1 unsafe file path')
        data = (directory / name).read_bytes()
        gc.need(hashlib.sha256(data).hexdigest() == receipts['files'][name]['sha256'], 'E1 actual file hash mismatch')
        gc.need(name not in files or files[name] == hashlib.sha256(data).hexdigest(), 'E1 consumed file changed')
        if name not in files:
            files[name] = hashlib.sha256(data).hexdigest()
            contents[name] = data.decode()
    evidence['proof']['collectionReceipts'] = receipts
    evidence['collection'] = {'filesSha256': dict(files), 'receiptManifestSha256': provenance.sha(receipts)}
    extracted, _ = provenance.reconstruct_proof(contents)
    evidence['proof']['cloudTrail'] = extracted['cloudTrail']
    provenance.bind_proof_files(evidence, contents)
    provenance.validate(evidence, receipts.get('databaseSystemIdentifier'), datetime.now(timezone.utc))
    gc.need(receipts['databaseSystemIdentifier'] == db['meta']['system_identifier'], 'E1 database export mismatch')
    snapshot = {'deployment': {'releases': records}}

    def absence(instance):
        events = [e for e in evidence['proof']['cloudTrail']
                  if e.get('eventName') == 'TerminateInstances' and instance in gc.resource_ids(e)]
        gc.need(len(events) == 1, 'missing/ambiguous raw CloudTrail TerminateInstances event: ' + instance)
        e = events[0]
        return {'inventorySha256': gc.sha(gc.inventory(evidence)),
                'inventoryCapturedAt': evidence['proof']['inventoryCapturedAt'],
                'terminationEventId': e['eventID'], 'terminationEventTime': e['eventTime'],
                'terminationEventSha256': gc.sha(e)}

    def disposition(resource):
        for record in records:
            if record == candidate:
                continue
            value = {'disposition': 'kept-record', 'record': gc.identity(record)}
            try:
                gc.kept_resource(evidence, snapshot, candidate, resource, value)
                return value
            except (ValueError, KeyError, TypeError):
                pass
        return {'disposition': 'attested', **absence(resource)}

    pending = []
    for name in gc.SOURCES:
        for row in evidence['sources'][name]['rows']:
            if not gc.references(row, candidate):
                continue
            row_id = row.get('id', row.get('executionArn', row.get('computer_id', row.get('job_id'))))
            try:
                a = {'source': name, 'rowSha256': gc.sha(row)}
                if name == 'poolHosts':
                    saved = gc.decoded(row['lifecycle_input'])
                    document = gc.decoded(saved['document'])
                    matches = [d for d in describes.values() if gc.decoded(d['input']) == saved]
                    gc.need(len(matches) == 1, 'missing retire execution describe')
                    d = matches[0]
                    a.update(kind='pool_host_retired_settled', poolId=row['id'], generation=row['generation'],
                             instanceId=row['instance_id'], state=row['state'], dispatchStatus=row['dispatch_status'],
                             retireJobId=row['lifecycle_job_id'], lifecycleDigest=row['lifecycle_digest'],
                             executionStatus=d['status'], receiptSha256=gc.sha(gc.decoded(d.get('output'))),
                             **absence(row['instance_id']))
                elif name == 'executions':
                    d = row
                    h = evidence['proof']['executions'][d['executionArn']]['history']
                    a.update(kind='execution_terminal', status=d['status'],
                             resources={r: disposition(r) for r in sorted(gc.resource_ids([d, h]))})
                else:
                    if name in BINDABLE:
                        pending.append({'kind': BINDABLE[name], 'source': name, 'rowSha256': gc.sha(row), 'rowId': row_id})
                        continue
                    raise ValueError('reference source has no historical exemption')
                h = evidence['proof']['executions'][d['executionArn']]['history']
                a.update(executionArn=d['executionArn'], versionArn=d['stateMachineVersionArn'],
                         describeSha256=gc.sha(d), historySha256=gc.sha(h))
                gc.need(not gc.ambiguous_lower(row, candidate), 'undisambiguated digest-only reference')
                gc.validate_attestation(a, row, evidence, snapshot, candidate)
                evidence['attestations'].append(a)
            except (ValueError, KeyError, TypeError, AttributeError) as error:
                unresolved.append({'source': name, 'rowId': row_id, 'rowSha256': gc.sha(row), 'reason': str(error)})
    # Snapshot child coverage: only when the full account/region image and launch-template inventories
    # (every template, every version) were collected; each template's versions 1..latest must be present.
    defs = evidence['proof'].get('ec2Definitions', {})
    if {'ec2-images.json', 'ec2-lt.json', 'ec2-lt-versions.json'} <= defs.keys():
        gaps = []
        versions = defs['ec2-lt-versions.json'].get('LaunchTemplateVersions', [])
        for t in defs['ec2-lt.json'].get('LaunchTemplates', []):
            have = sorted(v['VersionNumber'] for v in versions if v.get('LaunchTemplateId') == t['LaunchTemplateId'])
            if have != list(range(1, t['LatestVersionNumber'] + 1)):
                gaps.append(t['LaunchTemplateId'] + ': version history incomplete')
        if {v.get('LaunchTemplateId') for v in versions} - {t['LaunchTemplateId'] for t in defs['ec2-lt.json'].get('LaunchTemplates', [])}:
            gaps.append('launch-template versions without a listed template')
        if not gaps:
            evidence['proof']['snapshotChildCoverage'] = {
                'complete': True, 'uncertain': [], 'definitionsSha256': bindings.sha(defs),
                'executionsSha256': bindings.sha(evidence['proof'].get('executions', {})),
                'scope': 'all-account-region-images-templates-and-all-version-history'}
        else:
            unresolved.append({'source': 'snapshots', 'rowId': None, 'rowSha256': None, 'reason': 'child coverage: ' + '; '.join(gaps)})
    # Bindings hash the FINAL proof; each is validated alone by the same analyzer the checker uses.
    proof_sha = bindings.sha(evidence['proof'])
    target = (context or {}).get('target')
    for p in pending:
        binding = {'kind': p['kind'], 'source': p['source'], 'rowSha256': p['rowSha256'], 'proofSha256': proof_sha}
        try:
            bindings.analyze({**evidence, 'referenceBindings': [binding]}, records, candidate, gc.references, target)
            evidence.setdefault('referenceBindings', []).append(binding)
        except (ValueError, KeyError, TypeError, AttributeError) as error:
            unresolved.append({'source': p['source'], 'rowId': p['rowId'], 'rowSha256': p['rowSha256'], 'reason': 'binding: ' + str(error)})
    evidence['collection'] = {**evidence['collection'], 'candidate': gc.identity(candidate), 'filesSha256': files,
                              'unresolved': unresolved,
                              'missingContext': not bool(context)}
    # The main checker sees collection gaps even if the remaining references
    # could otherwise be exempted. Sources retain every original canonical row.
    evidence['sources']['releasePlans']['uncertain'].extend(
        ['collector has unresolved references'] if unresolved else [])
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--context', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    gc.need(args.directory.resolve() not in args.output.resolve().parents,
            'collector output must be outside source evidence')
    evidence = collect(args.directory, args.candidate, gc.manifest.read(args.context) if args.context else None)
    gc.immutable(args.output, evidence)
    print(json.dumps({'output': str(args.output), 'attestations': len(evidence['attestations']),
                      'unresolved': evidence['collection']['unresolved'],
                      'missingContext': evidence['collection']['missingContext']}, indent=2))
    return 2 if evidence['collection']['unresolved'] or evidence['collection']['missingContext'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, TypeError, OSError):
        print('evidence collection refused: incomplete or malformed local input', file=sys.stderr)
        sys.exit(1)
