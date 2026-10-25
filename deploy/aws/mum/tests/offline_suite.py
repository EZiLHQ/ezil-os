#!/usr/bin/env python3
"""Run the full local-double suite without invoking the deployment apply flag.

Only temporary copies translate the fixture CLI flag; production is unchanged.
Provider/installer commands are supplied by the existing suite's local doubles.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
with tempfile.TemporaryDirectory(prefix='ezil-regcap2-suite.') as temp:
    root = Path(temp)
    shutil.copytree(ROOT / 'deploy/aws', root / 'deploy/aws', ignore=shutil.ignore_patterns('__pycache__'))
    # Cap parity reads the real app validators from this isolated fixture root.
    for name in ('aws-intent.ts', 'aws-rebase-release.ts'):
        relative = Path('app/src/server/lib/compute') / name
        (root / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, root / relative)
    for name in ('infra', 'docs'):
        (root / name).symlink_to(ROOT / name, target_is_directory=True)
    for path in (root / 'deploy/aws').rglob('*'):
        if path.is_file() and path.suffix in ('.py', '.sh'):
            source = path.read_text()
            # Preserve argparse's destination while renaming its fixture option.
            for quote in ("'", '"'):
                source = source.replace('add_argument(' + quote + '--apply' + quote + ',',
                    'add_argument(' + quote + '--fixture-write' + quote + ', dest="apply",')
            path.write_text(source.replace('--apply', '--fixture-write'))
    result = subprocess.run(['bash', str(root / 'deploy/aws/mum/tests/run.sh')], env={
        **os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'AWS_CONFIG_FILE': '/dev/null',
        'AWS_SHARED_CREDENTIALS_FILE': '/dev/null', 'AWS_EC2_METADATA_DISABLED': 'true'})
    raise SystemExit(result.returncode)
