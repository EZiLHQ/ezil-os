#!/usr/bin/env python3
"""Read-only URL → served commit → branch table for OS environments. No credentials, no writes.

A slot's PR and image ID are in its receipt (PR comment, `preview.sh status`); /api/health gives only the commit.

Usage: inventory.py [REPO_DIR]   (fetch first; it reads origin/* refs and each URL's /api/health)
Image IDs are not public: the preview slot receipts (PR comment, host status) carry them, and
os-staging/production image IDs come from their release owner's install receipts.
"""
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

URLS = {
    'production (canonical)': 'https://os.ezil.org',
    'production': 'https://os.ezil.work',
    'os-staging': 'https://os-staging.ezil.work',
    'pr-preview-1': 'https://os-pv1.ezil.work',
    'pr-preview-2': 'https://os-pv2.ezil.work',
}
BRANCHES = ('main', 'staging/os-union-20261106')


def served_sha(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url + '/api/health'), timeout=10) as response:
            sha = json.loads(response.read(4096)).get('sha')
            return sha if isinstance(sha, str) else None
    except Exception:  # noqa: BLE001 - an unreachable or empty slot is a row, not a crash
        return None


def git(repo, *args):
    result = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else None


def relation(repo, sha, heads):
    if not sha:
        return 'unreachable or empty'
    found = [f'= {name}' for name, head in heads.items() if head == sha]
    found += [f'behind {name} by {git(repo, "rev-list", "--count", f"{sha}..{head}")}'
              for name, head in heads.items() if head and head != sha
              and subprocess.run(['git', '-C', str(repo), 'merge-base', '--is-ancestor', sha, head]).returncode == 0]
    return '; '.join(found) or 'not on a tracked branch (PR head or detached)'


def table(rows):
    lines = ['| Environment | URL | Served commit | Relation |', '|---|---|---|---|']
    lines += [f'| {r["env"]} | {r["url"]} | `{(r["sha"] or "-")[:12]}` | {r["relation"]} |' for r in rows]
    return '\n'.join(lines)


def main(argv):
    repo = Path(argv[1] if len(argv) > 1 else '.')
    heads = {name: git(repo, 'rev-parse', f'origin/{name}') for name in BRANCHES}
    rows = []
    for env, url in URLS.items():
        sha = served_sha(url)
        rows.append({'env': env, 'url': url, 'sha': sha, 'relation': relation(repo, sha, heads)})
    print(table(rows))
    print('\nBranch heads: ' + ', '.join(f'{n}={(h or "-")[:12]}' for n, h in heads.items()))


if __name__ == '__main__':
    main(sys.argv)
