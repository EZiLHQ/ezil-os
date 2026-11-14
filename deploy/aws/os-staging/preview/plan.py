#!/usr/bin/env python3
"""Decide one os-pr-preview run: deploy, teardown or skip (with the reason). No network.

Usage: plan.py EVENT_JSON ACTIVATION_JSON CHANGED_FILES REPOSITORY  -> key=value lines for GITHUB_OUTPUT.
ACTIVATION_JSON comes from the PR's base commit. It is an on/off switch, not a security boundary:
the os-pr-preview environment's required reviewers are (see README.md).
"""
import json
from pathlib import Path
import re
import sys

ROLE = re.compile(r'arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_-]{1,64}')
SLOTS = {'1': 'https://os-pv1.ezil.work', '2': 'https://os-pv2.ezil.work'}
# What the os-staging app image is built from (deploy.sh build / app/.dockerignore).
APP_TIER = ('app/', 'native/src/contract.ts', 'native/src/surfaces.ts')
TRUNCATED = '__TRUNCATED__'


def schema_change(path):
    return path.startswith('app/drizzle/') or (path.startswith('app/') and 'migrat' in path.lower()
                                                and not re.search(r'\.test\.[cm]?[jt]sx?$', path))


def decide(event, activation, files, repository):
    pr = event['pull_request']
    number, sha = int(pr['number']), pr['head']['sha']
    base = {'pr': number, 'sha': sha, 'tag': f'pr{number}-{sha[:12]}'}

    def out(action, reason, **extra):
        return {**base, 'action': action, 'reason': reason, **extra}
    if (pr['head'].get('repo') or {}).get('full_name') != repository:
        return out('skip', 'Fork pull requests never get previews (no deployment identity is exposed to them).')
    if activation.get('enabled') is not True:
        return out('skip', 'Inactive: preview/activation.json is not enabled on the base branch.')
    if (activation.get('schema') != 1 or not ROLE.fullmatch(activation.get('role_arn') or '')
            or activation.get('slots') != SLOTS or activation.get('computers') not in ('off', 'shared')
            or not isinstance(activation.get('ttl_hours'), int) or not 1 <= activation['ttl_hours'] <= 72
            or not re.fullmatch(r'[a-z0-9:_-]{1,50}', activation.get('label') or '')):
        raise SystemExit('Invalid preview/activation.json')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise SystemExit('Invalid head SHA')
    deployment = {'role_arn': activation['role_arn'], 'ttl_hours': str(activation['ttl_hours']),
                  'computers': activation['computers']}
    label = activation['label']
    event_label = (event.get('label') or {}).get('name')
    labelled = label in {item['name'] for item in pr.get('labels', [])}
    # Only a PR that had a preview tears one down (removing the label already did); the TTL reaper is the backstop.
    if (event['action'] == 'closed' and labelled) or (event['action'] == 'unlabeled' and event_label == label):
        return out('teardown', 'Pull request closed or preview label removed.', **deployment)
    if event['action'] == 'closed' or pr.get('state') != 'open':
        return out('skip', 'Pull request is not open.')
    if not labelled:
        return out('skip', f'Not labelled {label}.')
    if event['action'] in ('labeled', 'unlabeled') and event_label != label:
        return out('skip', 'Another label changed; the preview is unchanged.')
    if TRUNCATED in files:
        return out('skip', 'Too many changed files to classify safely (API limit 300).')
    if [f for f in files if schema_change(f)]:
        return out('skip', 'Schema change: a preview shares the staging PREVIEW database, so this PR '
                           'goes through the staging release instead.')
    if not [f for f in files if f.startswith(APP_TIER)]:
        return out('skip', 'No app-tier change: app previews do not cover editor/computer image changes.')
    return out('deploy', 'Labelled, app-tier change, no schema change.', **deployment)


def main(argv):
    event, activation = (json.loads(Path(p).read_text()) for p in argv[1:3])
    files = [line for line in Path(argv[3]).read_text().splitlines() if line]
    for key, value in decide(event, activation, files, argv[4]).items():
        print(f'{key}={value}')


if __name__ == '__main__':
    main(sys.argv)
