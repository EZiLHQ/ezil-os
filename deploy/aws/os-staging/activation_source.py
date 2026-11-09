#!/usr/bin/env python3
"""Render an OFFLINE activation patch after explicit branch selection.

Writes to a new directory outside the checkout; never applies, pushes, configures
GitHub or dispatches anything. The contract remains disabled with null authority.
"""
import argparse
import json
from pathlib import Path
import re
import subprocess

from install_receipt import require
from release_admission import CHECK_ORIGINS

ROOT = Path(__file__).resolve().parents[3]

RECORD = '''      - name: Record mapped checkout before checks
        if: github.event_name == 'push'
        run: python3 -B deploy/aws/os-staging/check_evidence.py > "$RUNNER_TEMP/checkout.json"
'''
UPLOAD = '''      - uses: actions/upload-artifact@v4
        if: github.event_name == 'push'
        with:
          name: os-check-${{ github.job }}-${{ github.run_id }}-${{ github.run_attempt }}
          path: ${{ runner.temp }}/checkout.json
          if-no-files-found: error
'''
DCO_PUSH = '''      - name: Validate push DCO range
        if: github.event_name == 'push'
        env:
          BASE_SHA: ${{ github.event.before }}
          HEAD_SHA: ${{ github.sha }}
        run: |
          [[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ && "$BASE_SHA" != 0000000000000000000000000000000000000000 ]]
          git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA"
          [[ $(git rev-list --count "$BASE_SHA..$HEAD_SHA") -gt 0 ]]
'''


def render(root, ref):
    require(ref.startswith('refs/heads/') and ref not in ('refs/heads/main', 'refs/heads/preview'),
            'Explicit durable staging branch required; main/preview are not staging')
    branch = ref.removeprefix('refs/heads/')
    subprocess.run(['git', 'check-ref-format', ref], check=True, capture_output=True)
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_./-]*', branch), 'Unsupported branch spelling')
    output = {}
    for workflow in sorted({v[0] for v in CHECK_ORIGINS.values()}):
        text = (root / '.github/workflows' / workflow).read_text()
        if workflow in ('ci.yml', 'codeql.yml'):
            require(text.count('    branches: [main]') == 1, 'Push trigger changed; review generator')
            text = text.replace('    branches: [main]', '    branches: [main, ' + json.dumps(branch) + ']')
        elif workflow == 'dco.yml':
            text = text.replace('\non:\n', '\non:\n  push:\n    branches: [' + json.dumps(branch) + ']\n', 1)
            text = text.replace('group: dco-${{ github.event.pull_request.number }}',
                                'group: dco-${{ github.event.pull_request.number || github.ref }}')
            text = text.replace('BASE_SHA: ${{ github.event.pull_request.base.sha }}',
                                'BASE_SHA: ${{ github.event.pull_request.base.sha || github.event.before }}')
            text = text.replace('HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
                                'HEAD_SHA: ${{ github.event.pull_request.head.sha || github.sha }}')
        for _, job in (v for v in CHECK_ORIGINS.values() if v[0] == workflow):
            pattern = re.compile(r'(^  ' + re.escape(job) + r':\n)(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)', re.M | re.S)
            match = pattern.search(text)
            require(match is not None, 'Missing mapped job: ' + job)
            body = match[2]
            checkout = re.search(r'^      - uses: actions/checkout@v7\n(?:        with:\n(?:          [^\n]*\n)*)?', body, re.M)
            require(checkout is not None and body.count('uses: actions/checkout@') == 1, 'Checkout contract changed: ' + job)
            replacement = ('      - uses: actions/checkout@v7\n        with:\n'
                           '          fetch-depth: 0\n          persist-credentials: false\n' + RECORD)
            if workflow == 'dco.yml':
                replacement += DCO_PUSH
            body = body[:checkout.start()] + replacement + body[checkout.end():]
            # Appending after all original steps means failed/skipped checks cannot
            # emit a successful receipt. Existing test commands remain unchanged.
            body = body.rstrip() + '\n' + UPLOAD + '\n'
            text = text[:match.start()] + match[1] + body + text[match.end():]
        output['.github/workflows/' + workflow] = text
    # Existing semantic triage tests intentionally pin this exact paragraph.
    # Keep their citation accurate in the proposed activation patch as well.
    lines = output['.github/workflows/ci.yml'].splitlines()
    start = next(i + 1 for i, line in enumerate(lines) if 'THE PACKAGE IS PRIVATE' in line)
    end = next(i + 1 for i, line in enumerate(lines) if 'setting if the pull is refused, rather than a bare docker exit code.' in line)
    triage = (root / 'tools/triage.ts').read_text()
    triage, count = re.subn(r'const CI_PRIVATE_PACKAGE_LINES = \{ start: [0-9]+, end: [0-9]+ \}',
                            f'const CI_PRIVATE_PACKAGE_LINES = {{ start: {start}, end: {end} }}', triage)
    require(count == 1, 'Triage citation contract changed')
    output['tools/triage.ts'] = triage
    output['.github/workflows/staging-entry.yml'] = '''# OFFLINE PROPOSAL ONLY. Requires separate source/security/build-window approval.
name: Approved AWS staging entry
on:
  workflow_dispatch:
    inputs:
      candidate:
        description: Reviewed exact candidate/previous app and retained Worker pins
        type: string
        required: true
permissions:
  contents: read
  actions: read
  id-token: write
jobs:
  release:
    uses: ./.github/workflows/staging-release.yml
    with:
      candidate: ${{ inputs.candidate }}
      public_supabase_url: ${{ vars.OS_STAGING_PUBLIC_SUPABASE_URL }}
      public_supabase_anon_key: ${{ vars.OS_STAGING_PUBLIC_SUPABASE_ANON_KEY }}
      stripe_publishable_key: ${{ vars.OS_STAGING_STRIPE_PUBLISHABLE_KEY }}
'''
    return output


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--release-ref', required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    output = args.output.resolve()
    require(not output.is_relative_to(ROOT), 'Activation bundle must stay outside the checkout')
    files = render(ROOT, args.release_ref)
    output.mkdir()  # Never overwrite an existing review bundle.
    for name, text in files.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
