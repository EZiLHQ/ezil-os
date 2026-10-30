#!/usr/bin/env python3
"""Offline app guard mutations, following app/scripts/pool-wire-mutations.py.

Only HOSTSWITCH-owned files are mutated; each is restored before proceeding.
Run alone (not concurrently with tests/typecheck). No network or external CLI.
"""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[3]
APP = ROOT / 'app'
BASE = APP / 'src/server/lib/compute'
CASES = []
for module, guards in [('aws-pool-adopt.ts', ['observe_leased', 'observe_binding', 'observe_execution', 'observe_work', 'observe_attached']),
                       ('aws-pool-session.ts', ['session_timing'])]:
    for guard in guards:
        anchor = "poolGuard('" + guard + "', "
        CASES.append((guard, module, anchor, anchor + 'true || '))
CASES += [
    ('session-body-bound', 'aws-pool-session.ts', 'parseRebaseJson(await req.text(), 1024)', 'parseRebaseJson(await req.text(), 8192)'),
    ('observe-success', 'aws-pool-adopt.ts', "if (e.status !== 'SUCCEEDED') return;", 'if (false) return;'),
    ('observe-state', 'aws-pool-adopt.ts', "!['LEASED', 'STARTING', 'MOUNTING'].includes(p.state)", 'false'),
    ('observe-consumed', 'aws-pool-adopt.ts', 'p.enrollConsumedHash !== null', 'false'),
    ('observe-before-claim', 'aws-pool-claim.ts', 'await deps.observeAdopt?.(proof, identity);', ''),
    ('timing-upper-bound', 'aws-pool-timing.ts', '.max(Number.MAX_SAFE_INTEGER)', ''),
    ('timing-lower-bound', 'aws-pool-timing.ts', '.nonnegative()', ''),
    ('timing-strict-fields', 'aws-pool-timing.ts', '}).strict().superRefine', '}).superRefine'),
    ('timing-order', 'aws-pool-timing.ts', 'i > 0 && v < phases[i - 1]!', 'false'),
    ('timing-span', 'aws-pool-timing.ts', 'phases.at(-1)! - phases[0]! > 86_400_000', 'false'),
    ('publication-time-bound', 'aws-pool-timing.ts', '.max(4102444800000)', ''),
    ('publication-time-immutable', 'ready-pool.ts', 'ELSE updated_at END', 'ELSE now() END'),
]

def main():
    failed = []
    for name, module, before, after in CASES:
        path = BASE / module
        original = path.read_text()
        if before not in original:
            raise RuntimeError('missing mutation anchor: ' + name)
        try:
            path.write_text(original.replace(before, after, 1))
            result = subprocess.run(['node', 'node_modules/vitest/vitest.mjs', 'run', '--no-cache', '--configLoader', 'runner',
                                     'src/server/lib/compute/aws-pool-hostswitch.test.ts'], cwd=APP,
                                    env={**os.environ, 'npm_config_offline': 'true'}, capture_output=True, text=True, timeout=60)
            output = result.stdout + result.stderr
            killed = result.returncode != 0 and ' FAIL ' in output and 'AssertionError' in output
            print(('KILLED ' if killed else 'SURVIVED ') + name, flush=True)
            if not killed:
                failed.append(name)
                Path('/tmp/hostswitch-mutant-' + name + '.log').write_text(output)
        finally:
            path.write_text(original)
    print(f'HOSTSWITCH app mutations: {len(CASES) - len(failed)} killed, {len(failed)} survived', flush=True)
    return bool(failed)

if __name__ == '__main__':
    sys.exit(main())
