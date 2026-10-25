"""Offline, exact-field reference bindings. Never mutates evidence or raw rows.

Hashes bind reviewed exports, not authenticity. The caller must validate complete
inventory, freshness, DB identity and writer fence before using this analysis.
"""
import copy
import hashlib
import json

import rebase_manifest as manifest

need = manifest.need


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False).encode()).hexdigest()


def decoded(value):
    return manifest.loads(value) if isinstance(value, str) else value


def retained(record, records, candidate, scope):
    manifest.validate(record, source=True)
    need(record in records and record['amiId'] != candidate['amiId'], 'binding requires retained manifest')
    need(all(record[k] == scope[k] for k in ('accountId', 'region', 'namespace')), 'binding foreign manifest')
    return record


def instance_image(instance, evidence):
    """All matching inventory/events must agree; request-only events never prove launch."""
    scope = evidence
    images = []
    for row in evidence['sources']['instances']['rows']:
        if row.get('InstanceId') == instance:
            images.append(row['ImageId'])  # inventory scope validated by enclosing evidence
    for wrapped in evidence.get('proof', {}).get('cloudTrail', []):
        event = wrapped.get('event', wrapped)
        if event.get('eventName') != 'RunInstances':
            continue
        items = (event.get('responseElements') or {}).get('instancesSet', {}).get('items', [])
        for item in items:
            if item.get('instanceId') != instance:
                continue
            need(event.get('eventSource') == 'ec2.amazonaws.com'
                 and event.get('recipientAccountId') == scope['accountId']
                 and event.get('awsRegion') == scope['region']
                 and not event.get('errorCode') and not event.get('errorMessage'), 'binding foreign/failed launch')
            image = item.get('imageId')
            need(image and event.get('requestParameters', {}).get('imageId') in (None, image),
                 'binding conflicting launch image')
            images.append(image)
    need(images and len(set(images)) == 1, 'binding missing/conflicting instance image')
    return images[0]


def deployment_matches(deployment, record):
    need(isinstance(deployment, dict) and all(deployment.get(k) == record[k] for k in
         ('accountId', 'region', 'namespace', 'amiId', 'launchTemplateId',
          'launchTemplateVersion', *manifest.TUPLE, 'stateMachineVersionArn')),
         'binding deployment/manifest mismatch')


def job_view(row, records, candidate, evidence):
    source = retained(decoded(row['source_release']), records, candidate, evidence)
    target = retained(decoded(row['target_release']), records, candidate, evidence)
    need(row['from_digest'] == source['lowerImageDigest'] and
         row['to_digest'] == target['lowerImageDigest'], 'binding job digest mismatch')
    need(isinstance(row['preparation_document'], str) and
         hashlib.sha256(row['preparation_document'].encode()).hexdigest() == row['preparation_digest'],
         'binding preparation document hash mismatch')
    prep = decoded(row['preparation_document'])
    deployment_matches(prep['sourceDeployment'], source)
    deployment_matches(prep['deployment'], target)
    pairs = {'jobId': 'job_id', 'computerId': 'computer_id', 'sourceInstanceId': 'source_instance_id',
             'sourceVolumeId': 'source_volume_id', 'fsUuid': 'fs_uuid',
             'sourceGeneration': 'source_generation', 'sourceLeaseEpoch': 'source_lease_epoch',
             'sourceFenceToken': 'source_fence_token', 'fromDigest': 'from_digest', 'toDigest': 'to_digest'}
    need(all(prep.get(k) == row[v] for k, v in pairs.items()), 'binding preparation mismatch')
    result = copy.deepcopy(row)
    del result['from_digest'], result['to_digest']
    for key, record in (('source_release', source), ('target_release', target)):
        result[key] = copy.deepcopy(record)
        # Full retained manifests are archival definitions of their own AMI.
        del result[key]['lowerImageRef']
    # Only these exact digest fields have source/consumer semantics. Everything
    # else, including recovery/rebind documents and unknown fields, is scanned.
    prep = copy.deepcopy(prep)
    del prep['fromDigest'], prep['toDigest']
    result['preparation_document'] = prep
    if row.get('launch_document'):
        need(isinstance(row['launch_document'], str) and
             hashlib.sha256(row['launch_document'].encode()).hexdigest() == row['launch_digest'],
             'binding launch document hash mismatch')
        launch = decoded(row['launch_document'])
        deployment_matches(launch['deployment'], target)
        need(launch['computerId'] == row['computer_id'] and launch['jobId'] == row['launch_job_id']
             and launch['rebasePreparation']['preparationJobId'] == row['job_id']
             and launch['rebasePreparation']['digest'] == row['preparation_digest'], 'binding launch mismatch')
    if row.get('snapshot_evidence'):
        snap = decoded(row['snapshot_evidence'])
        need(all(snap.get(k) == row[v] for k, v in pairs.items())
             and snap['snapshotId'] == row['snapshot_id'] and snap['state'] == 'snapshot_ready'
             and snap['digest'] == row['preparation_digest'], 'binding snapshot job mismatch')
        snap = copy.deepcopy(snap)
        del snap['fromDigest'], snap['toDigest']
        result['snapshot_evidence'] = snap
    if row.get('host_evidence'):
        host = decoded(row['host_evidence'])
        need(host['computerId'] == row['computer_id'] and host['fsUuid'] == row['fs_uuid']
             and host['generation'] == row['target_generation']
             and host['lowerImageDigest'] == target['lowerImageDigest']
             and instance_image(host['instanceId'], evidence) == target['amiId'], 'binding host mismatch')
        host = copy.deepcopy(host)
        del host['lowerImageDigest']
        result['host_evidence'] = host
    return result


def snapshot_view(row, candidate, evidence):
    proof = evidence['proof']
    definitions = proof.get('ec2Definitions', {})
    coverage = proof.get('snapshotChildCoverage', {})
    need(isinstance(definitions, dict) and
         {'ec2-images.json', 'ec2-lt.json', 'ec2-lt-versions.json'} <= definitions.keys()
         and coverage == {'complete': True, 'uncertain': [],
                          'definitionsSha256': sha(definitions),
                          'executionsSha256': sha(proof.get('executions', {})),
                          'scope': 'all-account-region-images-templates-and-all-version-history'},
         'binding incomplete snapshot child coverage')
    def no_pagination(value):
        if isinstance(value, dict):
            need(not any(k.lower() in ('nexttoken', 'next_token', 'marker', 'nextmarker')
                         and v for k, v in value.items()), 'binding incomplete child pagination')
            for child in value.values(): no_pagination(child)
        elif isinstance(value, list):
            for child in value: no_pagination(child)
    no_pagination(definitions)
    no_pagination(proof.get('executions', {}))
    images = definitions['ec2-images.json']
    need(isinstance(images.get('Images'), list)
         and isinstance(definitions['ec2-lt.json'].get('LaunchTemplates'), list)
         and isinstance(definitions['ec2-lt-versions.json'].get('LaunchTemplateVersions'), list),
         'binding unknown child definition shape')
    matches = [r for r in images['Images'] if r['ImageId'] == candidate['amiId']]
    need(len(matches) == 1, 'binding missing/duplicate image definition')
    image = matches[0]
    sid = row['SnapshotId']
    roots = [block for block in image['BlockDeviceMappings']
             if block.get('DeviceName') == image.get('RootDeviceName')]
    need(image.get('RootDeviceName') and image.get('RootDeviceType') == 'ebs'
         and len(roots) == 1 and roots[0].get('Ebs', {}).get('SnapshotId') == sid
         and row['State'] == 'completed'
         and row['OwnerId'] == image['OwnerId'] == evidence['accountId'],
         'binding snapshot root mapping mismatch')
    arn = f"arn:aws:imagebuilder:{evidence['region']}:{evidence['accountId']}:image/ezil-host-{evidence['namespace']}/{candidate['recipeVersion']}/"
    import re
    build_arns = []
    for obj in (row, image):
        tags = obj.get('Tags', [])
        need(len({t['Key'] for t in tags}) == len(tags), 'binding duplicate tags')
        tags = {t['Key']: t['Value'] for t in tags}
        build = tags.get('Ec2ImageBuilderArn', '')
        need(tags.get('CreatedBy') == 'EC2 Image Builder' and
             re.fullmatch(re.escape(arn) + r'[1-9][0-9]*', build),
             'binding missing ImageBuilder provenance')
        build_arns.append(build)
    need(build_arns[0] == build_arns[1], 'binding different ImageBuilder builds')
    # Inspect every supplemental definition/history, including default and old LT
    # versions. Exclude exactly the verified parent AMI's root SnapshotId edge.
    supplemental = copy.deepcopy(definitions)
    parent = next(r for r in supplemental['ec2-images.json']['Images']
                  if r['ImageId'] == candidate['amiId'])
    root = next(r for r in parent['BlockDeviceMappings']
                if r.get('DeviceName') == parent['RootDeviceName'])
    del root['Ebs']['SnapshotId']
    need(sid not in json.dumps(supplemental, sort_keys=True)
         and sid not in json.dumps(proof.get('executions', {}), sort_keys=True),
         'binding snapshot has supplemental dependent child')
    import re
    need(re.fullmatch(r'Created by CreateImage\(i-[0-9a-f]{17}\) for ' + re.escape(candidate['amiId']),
                      row['Description']), 'binding missing CreateImage provenance')
    # Conservative: even a terminal child blocks until separately reviewed.
    for name, source in evidence['sources'].items():
        for child in source['rows']:
            if name == 'snapshots' and child == row:
                continue
            need(sid not in json.dumps(child, sort_keys=True), 'binding snapshot has dependent child')
    result = copy.deepcopy(row)
    del result['Description']
    # Remove only the proven archival provenance tag; unknown tags still scan.
    result['Tags'] = [t for t in result['Tags'] if t['Key'] != 'Ec2ImageBuilderArn']
    return result


def analyze(evidence, records, candidate, references, target=None):
    """Return {(source, original-row-hash): analysis-view}; reject spare proofs.

    Caller scans unbound raw rows normally. Views are NEVER inventory/receipts.
    """
    bindings = evidence.get('referenceBindings', [])
    need(isinstance(bindings, list), 'binding list required')
    views = {}
    kinds = {'placement_image': 'placements', 'image_job_releases': 'imageJobs',
             'historical_imagebuilder_root': 'snapshots', 'original_plan_target': 'releasePlans'}
    for binding in bindings:
        need(isinstance(binding, dict) and set(binding) ==
             {'kind', 'source', 'rowSha256', 'proofSha256'}, 'binding schema mismatch')
        kind, name = binding['kind'], binding['source']
        need(kinds.get(kind) == name, 'binding kind/source mismatch')
        need(binding['proofSha256'] == sha(evidence.get('proof', {})), 'binding proof hash mismatch')
        rows = [r for r in evidence['sources'][name]['rows'] if sha(r) == binding['rowSha256']]
        key = (name, binding['rowSha256'])
        need(len(rows) == 1 and key not in views and references(rows[0], candidate),
             'binding spare/duplicate/forged row')
        row = rows[0]
        if kind == 'placement_image':
            need(row['region'] == evidence['region'] and row['provider'] == 'aws-ec2', 'binding foreign placement')
            ami = instance_image(row['instance_id'], evidence)
            matches = [r for r in records if r['amiId'] == ami and r['lowerImageDigest'] == row['lower_image_digest']]
            need(len(matches) == 1, 'binding unknown placement release')
            retained(matches[0], records, candidate, evidence)
            view = copy.deepcopy(row)
            del view['lower_image_digest']
        elif kind == 'image_job_releases':
            view = job_view(row, records, candidate, evidence)
        elif kind == 'historical_imagebuilder_root':
            view = snapshot_view(row, candidate, evidence)
        else:
            raw = evidence['proof']['originalPlanJson']
            need(isinstance(raw, str) and hashlib.sha256(raw.encode()).hexdigest() == evidence['planSha256']
                 and decoded(raw) == row, 'binding original plan hash mismatch')
            need(target is not None and target['amiId'] != candidate['amiId'], 'binding target missing/candidate')
            manifest.validate(target, source=True)
            need(all(target[k] == evidence[k] for k in ('accountId', 'region', 'namespace'))
                 and row['amiId'] == target['amiId'] and row['bake']
                 and all(target.get(k) == v for k, v in row['bake'].items()), 'binding plan target mismatch')
            view = copy.deepcopy(row)
            del view['bake']['lowerImageDigest']
            # Immutable ECR ref is the same exact lower identity, not a new edge.
            if view['bake'].get('lowerImageRef') == target['lowerImageRef']:
                del view['bake']['lowerImageRef']
        need(not references(view, candidate), 'binding unresolved reference (unknown/conflicting field)')
        views[key] = view
    return views
