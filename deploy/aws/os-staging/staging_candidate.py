#!/usr/bin/env python3
"""Validate a reviewed staging handoff and render commands; never execute them.

The checked-in contract deliberately has no approved release branch or delivery
role. This is not a substitute for GitHub check/identity/lease admission.
"""
import argparse
import json
import os
from pathlib import Path
import re

from install_receipt import require
from source_provenance import commit, git, source

PINNED = {
    'account': '452630323510', 'region': 'ap-south-1',
    'app_origin': 'https://os-staging.ezil.work',
    'instance_id': 'i-014810524754b9ed0', 'instance_name': 'ezil-os-billing-staging-host',
    'instance_environment': 'billing-staging', 'vpc_id': 'vpc-0f6bc19fdfd4209aa',
    'artifact_bucket': 'ezil-main-preview-artifacts-452630323510-aps1',
    'artifact_prefix': 'os-staging/images/', 'worker_name': 'ezil-os-worker-staging',
    'lease_role_arn': 'arn:aws:iam::452630323510:role/ezil-os-staging-lease',
}


def prepare(contract, request):
    require(contract.get('schema') == 1 and all(contract.get(k) == v for k, v in PINNED.items()),
            'Wrong staging target contract')
    require(contract.get('enabled') is True, 'Staging delivery is disabled pending activation approval')
    ref, role = contract.get('release_ref'), contract.get('delivery_role_arn')
    require(isinstance(ref, str) and re.fullmatch(r'refs/heads/[A-Za-z0-9][A-Za-z0-9_./-]*', ref),
            'No approved release branch')
    require(isinstance(role, str) and re.fullmatch(r'arn:aws:iam::452630323510:role/[A-Za-z0-9+=,.@_/-]+', role)
            and role != PINNED['lease_role_arn'], 'No approved AWS app delivery role; lease role is not a deployer')
    require(request.get('ref') == ref, 'Candidate is on an unapproved branch')
    require(all(request.get(k) == v for k, v in PINNED.items()), 'Candidate target differs from staging contract')
    for field in ('source', 'base', 'previous_app_source', 'worker_source'):
        require(re.fullmatch(r'[0-9a-f]{40}', request.get(field, '')), 'Missing exact source: ' + field)
    for field in ('receipt_sha256', 'previous_app_archive_sha256', 'previous_runtime_archive_sha256', 'worker_bundle_sha256'):
        require(re.fullmatch(r'[0-9a-f]{64}', request.get(field, '')), 'Missing immutable receipt: ' + field)
    for field in ('tag', 'previous_app_tag'):
        require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', request.get(field, '')), 'Invalid tag')
    require(re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', request.get('worker_version', '')),
            'Missing pinned Worker version')
    require(re.fullmatch(r'sha256:[0-9a-f]{64}', request.get('desktop_digest', '')), 'Desktop must use a digest')
    require(request.get('worker_action') == 'retain', 'Worker changes need their separate reviewed release')
    require(request.get('rollback_format') == 'legacy-two-archive' and request.get('rollback_reviewed') is True,
            'Legacy rollback requires explicit reviewed archive pins')
    return {'schema': 1, 'mode': 'review-only', 'deployment_authorized': False,
            'candidate': request, 'delivery_role_arn': role,
            'required_live_gates': ['exact GitHub checks and branch head', 'cb1 release ACK',
                                    'current host/VPC/identity and app/Worker/desktop readback',
                                    'shared staging lease', 'schema/backups and reviewed rollback'],
            'install_environment': {'OS_ENV': 'staging', 'OS_STAGING_INSTANCE_ID': PINNED['instance_id'],
                                    'OS_STAGING_ARTIFACT_BUCKET': PINNED['artifact_bucket']},
            'install_argv': ['bash', 'deploy/aws/os-staging/deploy.sh', 'install-verified',
                             request['tag'], request['source'], request['receipt_sha256']],
            'rollback_argv': ['bash', 'deploy/aws/os-staging/deploy.sh', 'install', request['previous_app_tag']]}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('request', type=Path)
    p.add_argument('--contract', type=Path, default=Path(__file__).with_name('pipeline.json'))
    args = p.parse_args()
    request = json.loads(args.request.read_text())
    result = prepare(json.loads(args.contract.read_text()), request)
    require(os.environ.get('GITHUB_SHA') == request['source'] and os.environ.get('GITHUB_REF') == request['ref'],
            'Handoff must run on the exact candidate SHA and approved ref')
    source(Path.cwd(), request['source'])
    commit(Path.cwd(), request['base'])
    git(Path.cwd(), 'merge-base', '--is-ancestor', request['base'], request['source'])
    print(json.dumps(result, indent=2))
