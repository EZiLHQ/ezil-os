"""Nonsecret operator context. Selection is explicit; artifacts never select it.

Resource pins live in json-tool.py/common.sh. These are the existing app-host
and database contracts from deploy/aws/os-staging/{README,INFRASTRUCTURE}.md.
No environment, credential or installed configuration is consulted here.
"""
from pathlib import Path
import re

import rebase_manifest as manifest

NAMESPACE = 'mum'
ENVIRONMENT = 'staging'
SLUG = 'ezil-os-staging'
ARTIFACT_BUCKET = 'ezil-main-preview-artifacts-452630323510-aps1'
ARTIFACT_PREFIX = 'os-staging/images/'
DB_HOST = '10.61.20.35'
PRODUCTION_SYSTEM_ID = '7698288507300208674'


def select(name):
    global NAMESPACE, ENVIRONMENT, SLUG, ARTIFACT_BUCKET, ARTIFACT_PREFIX, DB_HOST
    manifest.need(name in ('mum', 'prd'), 'unknown operator namespace')
    NAMESPACE = name
    ENVIRONMENT = 'production' if name == 'prd' else 'staging'
    SLUG = 'ezil-os-' + ENVIRONMENT
    ARTIFACT_BUCKET = ('ezil-main-prod-artifacts-452630323510-aps1' if name == 'prd'
                       else 'ezil-main-preview-artifacts-452630323510-aps1')
    ARTIFACT_PREFIX = 'os/images/' if name == 'prd' else 'os-staging/images/'
    DB_HOST = '10.63.20.252' if name == 'prd' else '10.61.20.35'


def path(value):
    """Reject foreign operator roots, including aliases through parent symlinks."""
    p = Path(value)
    other = 'mum' if NAMESPACE == 'prd' else 'prd'
    for candidate in (p.absolute(), p.resolve()):
        manifest.need('ezil-aws-' + other not in candidate.parts,
                      'foreign namespace operator path')
    return p


def system_id(value):
    manifest.need(value is None or manifest.matches(r'[0-9]{1,20}', value),
                  'independently verified DB system identifier required')
    if NAMESPACE == 'prd':
        manifest.need(value == PRODUCTION_SYSTEM_ID, 'production database identity mismatch')


def scope(value, account='452630323510', region='ap-south-1'):
    manifest.need(all(value.get(k) == v for k, v in
                  {'accountId': account, 'region': region, 'namespace': NAMESPACE}.items()),
                  'operator namespace identity mismatch')


def identities(value):
    """Imported reviews cannot grant or reference the other operator namespace."""
    other = 'mum' if NAMESPACE == 'prd' else 'prd'
    if isinstance(value, dict):
        for key, child in value.items():
            if key in ('namespace', 'ezil:namespace', 'ezil:stage'):
                manifest.need(child != other, 'foreign namespace review identity')
            identities(child)
    elif isinstance(value, list):
        for child in value: identities(child)
    elif isinstance(value, str):
        for account in re.findall(r'arn:aws:[a-z0-9-]+:[a-z0-9-]*:([0-9]{12}):', value):
            manifest.need(account == '452630323510', 'foreign account review identity')
        for region in re.findall(r'arn:aws:[a-z0-9-]+:([a-z]{2}-[a-z]+-[0-9]+):', value):
            manifest.need(region == 'ap-south-1', 'foreign region review identity')
        manifest.need(not any(token in value for token in
                      (f'ezil-{other}-', f'/ezil/{other}/', f'ezil-host-{other}',
                       f'ezil-identity-{other}', f'/root/ezil-aws-{other}/')),
                      'foreign namespace review identity')
