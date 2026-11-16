import hashlib, json, os, pathlib, subprocess

root = pathlib.Path.cwd()
out = root / '.task-tmp'
checkpoint = out / 'phase1-checkpoint'
manifest = json.loads((checkpoint / 'manifest.json').read_text())
base = '25c1274b5215'

def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}): {result.stderr.decode()}')
    return result.stdout

def sha(data):
    return hashlib.sha256(data).hexdigest()

assert sha((checkpoint / 'phase1.patch').read_bytes()) == '907afd5113eecf60cdc907918e06a51cda5975592f58745448a0c1fc73c48697'
assert run(['git', 'rev-parse', 'HEAD']).decode().strip().startswith(base)
changed = []
parts = []
for name, expected in manifest.items():
    before = checkpoint / 'files' / name
    after = root / name
    assert sha(before.read_bytes()) == expected, name
    if before.read_bytes() == after.read_bytes():
        continue
    changed.append(name)
    diff = subprocess.run(['git', 'diff', '--no-index', '--no-prefix', '--binary', str(before), str(after)], capture_output=True)
    assert diff.returncode == 1, diff.stderr.decode()
    lines = diff.stdout.decode().splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.startswith('diff --git '):
            lines[i] = f'diff --git a/{name} b/{name}\n'
        elif line.startswith('--- '):
            lines[i] = f'--- a/{name}\n'
        elif line.startswith('+++ '):
            lines[i] = f'+++ b/{name}\n'
    parts.append(''.join(lines).encode())
incremental = b''.join(parts)
full = run(['git', 'diff', '--binary', base, '--', *manifest])
assert set(run(['git', 'diff', '--name-only', base]).decode().splitlines()) == set(manifest)
(out / 'o-credits-phase2-only.patch').write_bytes(incremental)
(out / 'o-credits-full-final.patch').write_bytes(full)

# Verify actual application to independent RAM copies. Never change the checkpoint or Git index.
verification = out / 'phase2-apply-verification'
verification.mkdir(exist_ok=True)
env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(verification))
for label, patch in [('phase1-plus-phase2', out / 'o-credits-phase2-only.patch'), ('base-plus-full', out / 'o-credits-full-final.patch')]:
    tree = verification / label
    tree.mkdir(exist_ok=True)
    for name in manifest:
        dest = tree / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes((checkpoint / 'files' / name).read_bytes() if label.startswith('phase1') else run(['git', 'show', f'{base}:{name}']))
    run(['git', 'apply', '--check', str(patch)], cwd=tree, env=env)
    run(['git', 'apply', str(patch)], cwd=tree, env=env)
    for name in manifest:
        assert (tree / name).read_bytes() == (root / name).read_bytes(), (label, name)

info = {
    'base': base,
    'phase1_checkpoint_sha256': sha((checkpoint / 'phase1.patch').read_bytes()),
    'phase2_patch_sha256': sha(incremental),
    'full_patch_sha256': sha(full),
    'phase2_files': changed,
    'phase1_unchanged_files': [name for name in manifest if name not in changed],
    'final_file_sha256': {name: sha((root / name).read_bytes()) for name in manifest},
    'verification': 'Both patches applied to isolated copies and reproduced all 20 final files byte-for-byte.'
}
(out / 'phase2-patch-manifest.json').write_text(json.dumps(info, indent=2) + '\n')
print(json.dumps({key: info[key] for key in ['phase2_patch_sha256', 'full_patch_sha256', 'verification']}, indent=2))
