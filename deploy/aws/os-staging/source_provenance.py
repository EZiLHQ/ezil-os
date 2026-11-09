#!/usr/bin/env python3
"""Offline source receipts and immutable build contexts. Never deploys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def commit(root, sha):
    if not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', sha or ''):
        raise ValueError('Expected a full commit SHA')
    if git(root, 'rev-parse', '--verify', sha + '^{commit}').decode().strip() != sha:
        raise ValueError('Source must name an exact commit')
    return sha


def source(root, sha):
    commit(root, sha)
    if git(root, 'rev-parse', 'HEAD').decode().strip() != sha:
        raise ValueError('GIT_SHA must equal checkout HEAD')
    if git(root, 'status', '--porcelain', '--untracked-files=all'):
        raise ValueError('Source checkout is dirty; use a clean isolated worktree')
    return {'schema': 1, 'source': sha,
            'tree': git(root, 'rev-parse', sha + '^{tree}').decode().strip(),
            'parents': git(root, 'show', '-s', '--format=%P', sha).decode().split()}


def snapshot(root, sha, output):
    receipt = source(root, sha)
    output.mkdir()  # Caller owns a fresh private directory outside the checkout.
    archive = output / 'source.tar'
    with archive.open('wb') as stream:
        subprocess.run(['git', '-C', str(root), 'archive', '--format=tar', sha],
                       stdout=stream, check=True)
    receipt['source_archive_sha256'] = digest(archive)
    context = output / 'context'
    context.mkdir()
    subprocess.run(['tar', '-xf', str(archive), '-C', str(context)], check=True)
    (output / 'source.json').write_text(json.dumps(receipt, indent=2) + '\n')


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def artifact(snapshot_dir, directory, tag, environment):
    receipt = json.loads((snapshot_dir / 'source.json').read_text())
    if 'NEXT_PUBLIC_SUPABASE_URL' in os.environ or 'NEXT_PUBLIC_SUPABASE_ANON_KEY' in os.environ:
        from public_config import identity
        receipt['public_config'] = identity(os.environ.get('NEXT_PUBLIC_SUPABASE_URL'),
                                            os.environ.get('NEXT_PUBLIC_SUPABASE_ANON_KEY'))
    receipt.update(environment=environment, component='aws-app',
                   image=f'ezil-os-{environment}:{tag}',
                   artifacts={f'{tag}.{suffix}': digest(directory / f'{tag}.{suffix}')
                              for suffix in ('tar.gz', 'runtime.tar.gz')})
    (directory / f'{tag}.source.json').write_text(json.dumps(receipt, indent=2) + '\n')


def verify(directory, tag, environment):
    receipt = json.loads((directory / f'{tag}.source.json').read_text())
    if (receipt.get('schema') != 1 or receipt.get('environment') != environment or
            receipt.get('component') != 'aws-app' or
            receipt.get('image') != f'ezil-os-{environment}:{tag}' or
            not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', receipt.get('source', '')) or
            not re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', receipt.get('tree', '')) or
            not re.fullmatch(r'[0-9a-f]{64}', receipt.get('source_archive_sha256', ''))):
        raise ValueError('Invalid source receipt or wrong target')
    expected = {f'{tag}.{s}': digest(directory / f'{tag}.{s}')
                for s in ('tar.gz', 'runtime.tar.gz')}
    if receipt.get('artifacts') != expected:
        raise ValueError('Artifacts differ from source receipt')


def ci_receipt(root, sha, event, event_name, ref):
    receipt = source(root, sha)
    if event_name == 'pull_request':
        pr = event['pull_request']
        head, base = commit(root, pr['head']['sha']), commit(root, pr['base']['sha'])
        # actions/checkout tests the synthetic merge, not just the author's head.
        if receipt['parents'] != [base, head]:
            raise ValueError('PR checkout is not the merge of the event base and head')
        receipt.update(head=head, base=base, head_branch=pr['head']['ref'],
                       base_branch=pr['base']['ref'])
    elif event_name == 'push':
        if event.get('after') != sha or not ref.startswith('refs/heads/'):
            raise ValueError('Push checkout does not match the branch event')
        head = sha
        before = event.get('before', '')
        base = None if before and set(before) == {'0'} else commit(root, before)
        receipt.update(head=head, base=base, head_branch=ref.removeprefix('refs/heads/'))
    else:
        raise ValueError('Only branch push and pull_request source receipts are supported')
    if base:
        merge_base = git(root, 'merge-base', base, head).decode().strip()
        receipt.update(merge_base=merge_base,
                       unique_commits=[int(n) for n in git(root, 'rev-list', '--left-right', '--count',
                                                          f'{base}...{head}').decode().split()],
                       head_delta_files=git(root, 'diff', '--name-only', '-z', merge_base, head).decode().split('\0')[:-1],
                       composed_files=git(root, 'diff', '--name-only', '-z', base, sha).decode().split('\0')[:-1],
                       composed_diff_sha256=hashlib.sha256(git(root, 'diff', '--binary', '--no-ext-diff',
                                                               '--no-textconv', base, sha)).hexdigest())
    receipt.update(event=event_name, ref=ref, deployment_authorized=False,
                   intended_staging={'app': 'https://os-staging.ezil.work', 'app_provider': 'aws',
                                     'worker': 'ezil-os-worker-staging', 'worker_provider': 'cloudflare'},
                   legacy_preview_app='https://ezil-os-staging.vercel.app')
    return receipt


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='command', required=True)
    snap = sub.add_parser('snapshot')
    snap.add_argument('root', type=Path)
    snap.add_argument('sha')
    snap.add_argument('output', type=Path)
    build = sub.add_parser('artifact')
    build.add_argument('snapshot', type=Path)
    for parser in (build, sub.add_parser('verify')):
        parser.add_argument('directory', type=Path)
        parser.add_argument('tag')
        parser.add_argument('environment', choices=('staging', 'production'))
    ci = sub.add_parser('ci')
    ci.add_argument('root', type=Path)
    args = p.parse_args()
    if args.command == 'snapshot':
        snapshot(args.root, args.sha, args.output)
    elif args.command == 'artifact':
        artifact(args.snapshot, args.directory, args.tag, args.environment)
    elif args.command == 'verify':
        verify(args.directory, args.tag, args.environment)
    else:
        result = ci_receipt(args.root, os.environ['GITHUB_SHA'],
                            json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text()),
                            os.environ['GITHUB_EVENT_NAME'], os.environ['GITHUB_REF'])
        result.update(run_id=os.environ['GITHUB_RUN_ID'], run_attempt=os.environ['GITHUB_RUN_ATTEMPT'])
        print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
