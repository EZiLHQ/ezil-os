#!/usr/bin/env python3
"""Offline checkout evidence, uploaded only after the mapped job succeeds."""
import json
import os
from pathlib import Path

from source_provenance import ci_receipt


def record(root, env):
    receipt = ci_receipt(root, env['GITHUB_SHA'],
                         json.loads(Path(env['GITHUB_EVENT_PATH']).read_text()),
                         env['GITHUB_EVENT_NAME'], env['GITHUB_REF'])
    receipt.update(repository=env['GITHUB_REPOSITORY'], job=env['GITHUB_JOB'],
                   workflow_ref=env['GITHUB_WORKFLOW_REF'],
                   run_id=int(env['GITHUB_RUN_ID']), run_attempt=int(env['GITHUB_RUN_ATTEMPT']))
    return receipt


if __name__ == '__main__':
    print(json.dumps(record(Path.cwd(), os.environ), indent=2))
