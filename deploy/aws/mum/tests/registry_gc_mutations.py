#!/usr/bin/env python3
"""Disable GC guards individually, including its new main-ledger guards.

All executions use local unit doubles; sources are restored in finally.
"""
import ast
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
commands = {
    'registry_gc.py': [sys.executable, '-B', str(HERE / 'registry_gc.py')],
    'rebase_release.py': [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(HERE), '-p', 'rebase.py', '-k', 'RegistryGcLedger'],
    'json-tool.py': [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(HERE), '-p', 'rebase.py', '-k', 'RegistryGcLedger'],
}
killed = total = 0
for filename, command in commands.items():
    path = HERE.parent / filename
    original = path.read_text()
    offsets = [0]
    for line in original.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    guards = [node for node in ast.walk(ast.parse(original)) if isinstance(node, ast.Call)
              and isinstance(node.func, ast.Name) and node.func.id == 'need'
              and (filename == 'registry_gc.py' or isinstance(node.args[1], ast.Constant)
                   and ('registry-gc' in str(node.args[1].value) or node.args[1].value == 'serialized evidence mismatch'))]
    try:
        for node in guards:
            arg = node.args[0]
            start = offsets[arg.lineno - 1] + arg.col_offset
            end = offsets[arg.end_lineno - 1] + arg.end_col_offset
            path.write_text(original[:start] + 'True' + original[end:])
            test = commands['registry_gc.py'] if 'same frozen app' in ast.unparse(node.args[1]) else command
            historical = {'execution_proof', 'absent_instance', 'kept_resource', 'validate_attestation', 'check_attestations'}
            if filename == 'registry_gc.py' and any(
                    isinstance(f, ast.FunctionDef) and f.name in historical and f.lineno <= node.lineno <= f.end_lineno
                    for f in ast.walk(ast.parse(original))):
                test = [*test, 'HistoricalAttestationTests']
            result = subprocess.run(test, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
            total += 1
            killed += bool(result.returncode)
            print('KILLED' if result.returncode else 'SURVIVED', filename, ast.unparse(node.args[1]), flush=True)
    finally:
        path.write_text(original)
# Guard wiring also matters: a valid predicate is useless if its call is skipped.
rollout = [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', str(HERE), '-p', 'rollout.py', '-k', 'registry_gc']
wiring = [
    ('registry_gc.py', '    check_attestations(evidence, snapshot, candidate, views)', '    pass  # removed reference closure', commands['registry_gc.py']),
    ('registry_gc.py', '            if references(view(name, row), candidate)]', '            if False]  # bound views ignored', commands['registry_gc.py']),
    ('registry_gc.py', '        validate_attestation(a, row, evidence, snapshot, candidate)', '        pass  # removed typed proof validation', commands['registry_gc.py']),
    ('rebase_release.py', "'rollback', 'registry-gc', 'app-adopt'", "'rollback', 'app-adopt'", commands['registry_gc.py']),
    ('rebase_release.py', "if pending['operation'] == 'registry-gc':", 'if False:', commands['registry_gc.py']),
    ('rebase_release.py', "rebase_app.public_deployment(d) if operation == 'registry-gc' else None", 'None', rollout),
    ('registry_gc.py', "'registry-gc-app', True,", "'registry-gc-app', False,", rollout),
    ('registry_gc.py', "    verify_backup(directory, snapshot)", '    pass  # removed backup verification', commands['registry_gc.py']),
    ('registry_gc.py', "    immutable(directory / 'secret-write-intent.json', {'generation': generation, 'expected': ledger['entries'][-1]['expected']})", '    pass  # lost intent marker', commands['registry_gc.py']),
    ('registry_gc.py', "             and output.get('schemaVersion') == 1 and type(output.get('schemaVersion')) is int\n", '', commands['registry_gc.py']),
    ('registry_gc.py', "             and output.get('fenceToken') == document.get('fenceToken')\n", '', commands['registry_gc.py']),
    ('registry_gc.py', "             and 'volumeId' in output and output['volumeId'] is None\n", '', commands['registry_gc.py']),
    ('registry_gc.py', "             and output.get('leaseEpoch') == document.get('leaseEpoch')\n", '', commands['registry_gc.py']),
    ('registry_gc_evidence.py', "        gc.need(context.get('capturedAt', captured) == captured", "        gc.need(True or context.get('capturedAt', captured) == captured", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "            if row.get('status') not in gc.TERMINAL:", "            if False:", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "    if conflicts: gaps.append('describe contradicts list (' + ','.join(conflicts) + ')')", "    pass  # dropped describe/list conflict detection", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "            if arn in execution_rows:", "            if False:", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "        events = [e['event'] if isinstance(e, dict) and set(e) >= {'event', 'resourceId', 'query'} else e for e in events]", "        pass", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "            if have != list(range(1, t['LatestVersionNumber'] + 1)):", "            if False:", commands['registry_gc.py']),
    # R1 shared-lower (this PR): each new guard dropped individually must be killed.
    ('registry_gc.py', '    if shared_lower_kept(snapshot, candidate):', '    if True:  # dropped R1 kept-alias gate', commands['registry_gc.py']),
    ('registry_gc.py', 'not candidate_ami_observable(evidence, candidate)', 'not False', commands['registry_gc.py']),
    ('registry_gc.py', 'dict(candidate, lowerImageDigest=None)', 'candidate', commands['registry_gc.py']),
    # R2 retained-data-volume (this PR): each typed data check dropped individually must be killed.
    ('registry_gc.py', "resource.startswith('vol-') and len(volumes) == 1", "resource.startswith('vol-') and True", commands['registry_gc.py']),
    ('registry_gc.py', "volume['SnapshotId'] == ''", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "volume['Attachments'] == []", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "volume.get('State') == 'available'", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "bool(volume.get('VolumeType'))", 'True', commands['registry_gc.py']),
    ('registry_gc.py', 'len(set(keys)) == len(keys)', 'True', commands['registry_gc.py']),
    ('registry_gc.py', 'len(owners) == 1', 'True', commands['registry_gc.py']),
    ('registry_gc.py', "tags.get('ezil:computer-id') == owner['computer_id']", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "need(owner.get('lower_image_digest') == candidate['lowerImageDigest']", 'need(True', commands['registry_gc.py']),
    ('registry_gc.py', "r1_allowlisted('placements', owner, candidate) and shared_lower_kept(snapshot, candidate)",
     "True and shared_lower_kept(snapshot, candidate)", commands['registry_gc.py']),
    ('registry_gc.py', "r1_allowlisted('placements', owner, candidate) and shared_lower_kept(snapshot, candidate)",
     "r1_allowlisted('placements', owner, candidate) and True", commands['registry_gc.py']),
    ('registry_gc.py', "owner.get('state') == 'STOPPED'", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "('placements', 'poolHosts', 'imageJobs')", "('placements', 'poolHosts')", commands['registry_gc.py']),
    ('registry_gc.py', 'need(not claimants,', 'need(True or not claimants,', commands['registry_gc.py']),
    ('registry_gc.py', 'and not closed_usage_row(u, captured)', 'and False', commands['registry_gc.py']),
    # R1 single-oracle allowlist + poolHost eligibility (this PR).
    ('registry_gc.py', 'return not references(stripped, candidate)', 'return True', commands['registry_gc.py']),
    ('registry_gc.py', 'return decode_embedded(manifest.loads(value[start:]))', 'return value', commands['registry_gc.py']),
    ('registry_gc.py', "isinstance(obj.get(path[-1]), str)", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "row.get('state') == 'retired' and row.get('dispatch_status') == 'settled'", "row.get('state') == 'retired'", commands['registry_gc.py']),
    ('registry_gc.py', "row.get('state') == 'retired'", 'True', commands['registry_gc.py']),
    # Generalized app-tag pin (this PR): restoring a fixed literal or dropping either condition must be killed.
    ('rebase_release.py', "app.get('tag') == app['gitSha'][:12]", "app.get('tag') == '478c66b3559c'", commands['registry_gc.py']),
    ('rebase_release.py', "result['gitSha'] == app['gitSha']", 'True', commands['registry_gc.py']),
    # Closed-usage absence (this PR): dropping either usage guard must be killed.
    ('registry_gc.py', 'return False  # open or unparsable usage row is a live join',
     'return True  # open or unparsable usage row is a live join', commands['registry_gc.py']),
    ('registry_gc.py', 'return parsed <= captured', 'return True', commands['registry_gc.py']),
    # R1 string-prefix gap, terminal gating, spare attestation, stopped-instance (review fixes).
    ('registry_gc.py', 'return not any(token in blob for token in tokens)', 'return True', commands['registry_gc.py']),
    ('registry_gc.py', "row.get('status') in TERMINAL", 'True', commands['registry_gc.py']),
    ('registry_gc.py', "row.get('phase') in TERMINAL_IMAGE_JOB_PHASES", 'True', commands['registry_gc.py']),
    ('registry_gc.py', 'for n, r in required if n == a', 'for n, r in refs if n == a', commands['registry_gc.py']),
    ('registry_gc.py', ".get('Name') != 'terminated'", ".get('Name') == 'running'", commands['registry_gc.py']),
    # Layered non-digest token scan + decoded claimant scan (review fixes).
    ('registry_gc.py', 'return non_digest_token_present(manifest.loads(value[start:]), tokens)', 'return False', commands['registry_gc.py']),
    ('registry_gc.py', 'resource in (resource_ids(r) | resource_ids(decode_embedded(r)))', 'resource in resource_ids(r)', commands['registry_gc.py']),
]
for filename, before, after, command in wiring:
    path = HERE.parent / filename
    original = path.read_text()
    assert before in original, before
    try:
        path.write_text(original.replace(before, after))
        result = subprocess.run(command, env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}, capture_output=True, text=True)
        total += 1
        killed += bool(result.returncode)
        print('KILLED' if result.returncode else 'SURVIVED', filename, 'wiring:', before, flush=True)
    finally:
        path.write_text(original)
print(f'RESULT: {killed}/{total} guard mutations killed')
sys.exit(0 if killed == total else 1)
