#!/usr/bin/env python3
"""Read-only GitHub admission for the disabled reusable staging release graph."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from urllib.parse import quote
import zipfile

from fixed_document import definition, document_digest
from install_receipt import require
from source_provenance import git, source
from staging_candidate import validate_identity
from public_config import approved

REPO = 'EZiLHQ/ezil-os'
REPO_ID = 1339112799
REQUIRED_CHECKS = [
    'worker (typecheck + unit) (ubuntu-latest)', 'app (typecheck + unit) (ubuntu-latest)',
    'sdk + mcp (typecheck + unit) (ubuntu-latest)', 'shell (bundle check + browser suites) (ubuntu-latest)',
    'tools (typecheck + unit)', 'DCO', 'CodeQL (javascript-typescript)',
    'computer infrastructure (typecheck + test + synth)',
    'ezil-models (EZiL Chat provider + committed VSIX)', 'container (real image)',
    'local (typecheck + unit + smoke)', 'OS cloud release contracts', 'OS source provenance',
]
CHECK_ORIGINS = dict(zip(REQUIRED_CHECKS, [
    ('ci.yml', 'worker'), ('ci.yml', 'app'), ('ci.yml', 'connectors'), ('ci.yml', 'shell'),
    ('ci.yml', 'tools'), ('dco.yml', 'dco'), ('codeql.yml', 'codeql'),
    ('ci.yml', 'computer-infrastructure'), ('ci.yml', 'ezil-models'), ('ci.yml', 'container'),
    ('ci.yml', 'local'), ('ci.yml', 'cloud-release-contract'), ('source-provenance.yml', 'provenance'),
]))
RELEASE_PATH = '.github/workflows/staging-entry.yml'
BUILD_JOB = 'release / Build approved staging artifact'


def json_artifact(api, run_id, name, member):
    artifacts = api.json(f'actions/runs/{run_id}/artifacts?per_page=100')['artifacts']
    artifacts = [a for a in artifacts if a['name'] == name and not a['expired']]
    require(len(artifacts) == 1 and artifacts[0]['size_in_bytes'] < 65536, 'Missing or ambiguous checkout artifact: ' + name)
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / 'receipt.zip'
        api.download(artifacts[0]['id'], path)
        require('sha256:' + hashlib.sha256(path.read_bytes()).hexdigest() == artifacts[0]['digest'], 'Checkout artifact digest mismatch')
        with zipfile.ZipFile(path) as archive:
            require(archive.namelist() == [member] and archive.infolist()[0].file_size < 65536,
                    'Invalid checkout artifact contents')
            return json.loads(archive.read(member))


def authenticate_check(api, check, name, request, tree):
    workflow, job_key = CHECK_ORIGINS[name]
    path = '.github/workflows/' + workflow
    match = re.fullmatch(r'https://github.com/EZiLHQ/ezil-os/actions/runs/([0-9]+)/job/([0-9]+)', check['details_url'])
    require(match, 'Unknown check run identity: ' + name)
    run_id, job_id = map(int, match.groups())
    run = api.json(f'actions/runs/{run_id}')
    require(run['id'] == run_id and run['repository']['id'] == REPO_ID and
            run['head_repository']['id'] == REPO_ID and run['head_sha'] == request['source'] and
            run['head_branch'] == request['ref'].removeprefix('refs/heads/') and
            run['path'] == path and run['event'] == 'push' and run['status'] == 'completed' and
            run['conclusion'] == 'success', 'Wrong required workflow/source/event: ' + name)
    job = api.json(f'actions/jobs/{job_id}')
    require(job['id'] == job_id and job['run_id'] == run_id and job['run_attempt'] == run['run_attempt'] and
            job['head_sha'] == request['source'] and job['name'] == name and
            job['check_run_url'] == f'https://api.github.com/repos/{REPO}/check-runs/{check["id"]}' and
            job['status'] == 'completed' and job['conclusion'] == 'success', 'Wrong check job/attempt: ' + name)
    receipt = json_artifact(api, run_id, f'os-check-{job_key}-{run_id}-{run["run_attempt"]}', 'checkout.json')
    require(receipt.get('repository') == REPO and receipt.get('job') == job_key and
            receipt.get('workflow_ref') == f'{REPO}/{path}@{request["ref"]}' and
            receipt.get('run_id') == run_id and receipt.get('run_attempt') == run['run_attempt'] and
            receipt.get('event') == 'push' and receipt.get('ref') == request['ref'] and
            receipt.get('source') == request['source'] and receipt.get('head') == request['source'] and
            receipt.get('tree') == tree and receipt.get('deployment_authorized') is False,
            'Required job tested different source/tree/event: ' + name)
    return {'check_id': check['id'], 'run_id': run_id, 'run_attempt': run['run_attempt'],
            'workflow': path, 'job_id': job_id, 'job': job_key, 'tree': tree}


class GitHub:
    def json(self, path):
        return json.loads(subprocess.check_output(['gh', 'api', '--hostname', 'github.com',
                                                  f'repos/{REPO}/{path}']))

    def download(self, artifact_id, destination):
        require(isinstance(artifact_id, int) and artifact_id > 0, 'Invalid artifact ID')
        with destination.open('wb') as stream:
            subprocess.run(['gh', 'api', '--hostname', 'github.com',
                            f'repos/{REPO}/actions/artifacts/{artifact_id}/zip'], stdout=stream, check=True)


def delivery_contract(contract):
    approved(contract)
    require(isinstance(contract.get('required_checks'), list) and
            set(REQUIRED_CHECKS) == set(contract['required_checks']) and
            len(contract['required_checks']) == len(set(contract['required_checks'])),
            'Required checks need explicit approval with meaningful coverage preserved')
    require(re.fullmatch(r'EZiL-OS-Staging-InstallVerified-[A-Za-z0-9_-]+', contract.get('ssm_document_name') or ''),
            'No approved fixed SSM document name')
    require(re.fullmatch(r'[1-9][0-9]*', contract.get('ssm_document_version') or ''),
            'SSM document must use an approved numeric version')
    require(contract.get('ssm_document_sha256') == document_digest(definition()),
            'Fixed installer source differs from approved document hash')
    reviewers = contract.get('environment_reviewers')
    require(isinstance(reviewers, list) and reviewers and all(
        r.get('type') in ('User', 'Team') and isinstance(r.get('id'), int) and r['id'] > 0 for r in reviewers),
        'Staging environment reviewers must be chosen explicitly')


def admit_remote(contract, request, tree, api):
    validate_identity(contract, request)  # Disabled/null contract fails before even a GitHub read.
    delivery_contract(contract)
    branch, sha = request['ref'].removeprefix('refs/heads/'), request['source']
    ref = api.json('git/ref/heads/' + quote(branch, safe=''))
    require(ref['object']['sha'] == sha, 'Approved branch head moved')
    environment = api.json('environments/staging')
    policy = environment.get('deployment_branch_policy') or {}
    require(policy.get('custom_branch_policies') is True, 'Staging branch policy is not active')
    policies = api.json('environments/staging/deployment-branch-policies')['branch_policies']
    require(len(policies) == 1 and policies[0]['name'] == branch and policies[0].get('type', 'branch') == 'branch',
            'Staging environment must admit only the approved branch')
    rules = [r for r in environment['protection_rules'] if r['type'] == 'required_reviewers']
    require(len(rules) == 1 and rules[0].get('prevent_self_review') is True, 'Staging needs independent environment review')
    actual = {(r['type'], r['reviewer']['id']) for r in rules[0]['reviewers']}
    require(actual == {(r['type'], r['id']) for r in contract['environment_reviewers']}, 'Environment reviewers differ from approval')
    checks = []
    for page in range(1, 101):
        batch = api.json(f'commits/{sha}/check-runs?per_page=100&page={page}')['check_runs']
        checks.extend(batch)
        if len(batch) < 100:
            break
    else:
        raise ValueError('Too many check runs; cannot establish current checks')
    selected = {}
    for name in contract['required_checks']:
        # Ignore PR-event runs entirely. Their head_sha can match while checkout
        # actually tested refs/pull/N/merge. Duplicate display names are not authority.
        matching = []
        for check in checks:
            if check['name'] != name or check['head_sha'] != sha:
                continue
            match = re.fullmatch(r'https://github.com/EZiLHQ/ezil-os/actions/runs/([0-9]+)/job/[0-9]+', check['details_url'])
            if match:
                run = api.json(f'actions/runs/{match[1]}')
                if run.get('event') == 'push' and run.get('path') == '.github/workflows/' + CHECK_ORIGINS[name][0]:
                    matching.append(check)
        require(matching, 'Missing branch push check: ' + name)
        check = max(matching, key=lambda c: c['id'])
        require(check['app']['slug'] == 'github-actions' and check['status'] == 'completed' and
                check['conclusion'] == 'success', 'Required check is not successful: ' + name)
        selected[name] = authenticate_check(api, check, name, request, tree)
    return {'source': sha, 'tree': tree, 'checks': selected}


def bind_source(request):
    require(os.environ.get('GITHUB_REPOSITORY') == REPO and os.environ.get('GITHUB_SHA') == request['source'] and
            os.environ.get('GITHUB_REF') == request['ref'], 'Release invocation does not match repository/SHA/ref')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch' and
            os.environ.get('GITHUB_WORKFLOW_REF') == f'{REPO}/{RELEASE_PATH}@{request["ref"]}',
            'Release requires the reviewed entry workflow and explicit build-window invocation')
    receipt = source(Path.cwd(), request['source'])
    git(Path.cwd(), 'merge-base', '--is-ancestor', request['base'], request['source'])
    return receipt['tree']


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('request', type=Path)
    args = p.parse_args()
    request = json.loads(args.request.read_text())
    contract = json.loads(Path(__file__).with_name('pipeline.json').read_text())
    validate_identity(contract, request)
    print(json.dumps(admit_remote(contract, request, bind_source(request), GitHub()), indent=2))
