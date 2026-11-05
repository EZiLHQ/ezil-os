#!/usr/bin/env python3
"""Self-contained verifier embedded in the opt-in staging SSM installer."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def image_metadata(image, source):
    config = image.get('config', image.get('Config', {}))
    require(image.get('architecture', image.get('Architecture')) == 'amd64', 'Wrong image architecture')
    require(image.get('os', image.get('Os')) == 'linux', 'Wrong image OS')
    require(config.get('Labels', {}).get('org.opencontainers.image.revision') == source,
            'Image revision differs from approved source')
    require([v for v in config.get('Env', []) if v.startswith('EZIL_GIT_SHA=')] == ['EZIL_GIT_SHA=' + source],
            'Image runtime SHA differs from approved source')


def verify_archive(directory, tag, environment, source, receipt_hash):
    require(environment == 'staging', 'Verified installer is staging-only')
    require(re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', tag), 'Invalid tag')
    require(re.fullmatch(r'[0-9a-f]{40}|[0-9a-f]{64}', source), 'Expected full approved source SHA')
    require(re.fullmatch(r'[0-9a-f]{64}', receipt_hash), 'Expected approved receipt SHA256')
    path = directory / f'{tag}.source.json'
    require(path.stat().st_size <= 65536 and sha256(path) == receipt_hash, 'Source receipt hash mismatch')
    receipt = json.loads(path.read_text())
    require(receipt.get('schema') == 1 and receipt.get('source') == source and
            receipt.get('environment') == environment and receipt.get('component') == 'aws-app' and
            receipt.get('image') == f'ezil-os-staging:{tag}', 'Source receipt identity mismatch')
    require(receipt.get('artifacts') == {f'{tag}.{s}': sha256(directory / f'{tag}.{s}')
                                       for s in ('tar.gz', 'runtime.tar.gz')}, 'Source receipt artifact mismatch')
    with tarfile.open(directory / f'{tag}.tar.gz', 'r:gz') as image:
        members = image.getmembers()
        def read_json(name):
            found = [m for m in members if m.name == name]
            require(len(found) == 1 and found[0].isfile() and found[0].size <= 1024 * 1024,
                    'Missing, duplicate or invalid image metadata')
            data = image.extractfile(found[0]).read()
            return data, json.loads(data)
        _, manifests = read_json('manifest.json')
        require(isinstance(manifests, list) and len(manifests) == 1, 'Expected one Docker image')
        manifest = manifests[0]
        require(manifest.get('RepoTags') == [f'ezil-os-staging:{tag}'], 'Docker archive tag mismatch')
        name = manifest.get('Config', '')
        require(re.fullmatch(r'(?:[0-9a-f]{64}\.json|blobs/sha256/[0-9a-f]{64})', name),
                'Invalid Docker config path')
        data, config = read_json(name)
        digest = hashlib.sha256(data).hexdigest()
        require(digest in (name.removesuffix('.json'), name.removeprefix('blobs/sha256/')),
                'Docker config digest mismatch')
        image_metadata(config, source)
    return 'sha256:' + digest


def verify_loaded(image, source, expected_id):
    require(image.get('Id') == expected_id, 'Loaded image ID differs from verified archive')
    image_metadata(image, source)


if __name__ == '__main__':
    if sys.argv[1] == 'archive':
        print(verify_archive(Path(sys.argv[2]), *sys.argv[3:]))
    elif sys.argv[1] == 'loaded':
        verify_loaded(json.loads(Path(sys.argv[2]).read_text()), *sys.argv[3:])
    else:
        raise SystemExit('Unknown verification mode')
