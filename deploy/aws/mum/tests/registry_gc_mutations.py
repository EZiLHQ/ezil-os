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
    ('rebase_release.py', "'rollback', 'registry-gc') and", "'rollback') and", commands['registry_gc.py']),
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
    ('registry_gc_evidence.py', "        if any(row[k] != d[k] for k in shared):", "        if False:", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "            if arn in execution_rows and execution_rows[arn] != row:", "            if False:", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "        events = [e['event'] if isinstance(e, dict) and set(e) >= {'event', 'resourceId', 'query'} else e for e in events]", "        pass", commands['registry_gc.py']),
    ('registry_gc_evidence.py', "            if have != list(range(1, t['LatestVersionNumber'] + 1)):", "            if False:", commands['registry_gc.py']),
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
