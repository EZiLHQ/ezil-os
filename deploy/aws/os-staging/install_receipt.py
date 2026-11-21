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


OCI_INDEX = 'application/vnd.oci.image.index.v1+json'
OCI_IMAGE = 'application/vnd.oci.image.manifest.v1+json'
OCI_CONFIG = 'application/vnd.oci.image.config.v1+json'
DIGEST = r'sha256:[0-9a-f]{64}'


def verify_descriptor(read_json, descriptor, media_type):
    require(isinstance(descriptor, dict) and descriptor.get('mediaType') == media_type,
            'Unexpected OCI descriptor media type')
    digest = descriptor.get('digest', '')
    require(isinstance(digest, str) and re.fullmatch(DIGEST, digest), 'Invalid OCI descriptor digest')
    raw, content = read_json('blobs/' + digest.replace(':', '/', 1))
    require(descriptor.get('size') == len(raw) and digest == 'sha256:' + hashlib.sha256(raw).hexdigest(),
            'OCI descriptor content mismatch')
    require(isinstance(content, dict) and content.get('schemaVersion') == 2 and content.get('mediaType') == media_type,
            'Unexpected OCI descriptor content')
    return content


def verify_oci_identity(read_json, tag, config_digest, config_size):
    _, index = read_json('index.json')
    require(isinstance(index, dict) and index.get('schemaVersion') == 2
            and isinstance(index.get('manifests'), list) and len(index['manifests']) == 1,
            'Expected one OCI archive image reference')
    root = index['manifests'][0]
    require(isinstance(root, dict) and isinstance(root.get('annotations'), dict)
            and root['annotations'].get('org.opencontainers.image.ref.name') == tag
            and root['annotations'].get('io.containerd.image.name', f'docker.io/library/ezil-os-staging:{tag}')
            == f'docker.io/library/ezil-os-staging:{tag}', 'OCI archive tag mismatch')
    media_type = root.get('mediaType')
    require(media_type in (OCI_IMAGE, OCI_INDEX), 'Unexpected OCI archive root type')
    manifest = verify_descriptor(read_json, root, media_type)
    if media_type == OCI_INDEX:
        entries = manifest.get('manifests')
        require(isinstance(entries, list) and all(isinstance(entry, dict) for entry in entries),
                'Invalid OCI platform entries')
        runnable = [entry for entry in entries if entry.get('platform') == {'architecture': 'amd64', 'os': 'linux'}]
        require(len(runnable) == 1, 'Expected one linux/amd64 OCI image')
        leaf = runnable[0]
        for entry in entries:
            if entry is leaf:
                continue
            annotations = entry.get('annotations')
            require(entry.get('platform') == {'architecture': 'unknown', 'os': 'unknown'}
                    and isinstance(annotations, dict)
                    and annotations.get('vnd.docker.reference.type') == 'attestation-manifest'
                    and annotations.get('vnd.docker.reference.digest') == leaf.get('digest'),
                    'Unexpected OCI platform entry')
            verify_descriptor(read_json, entry, OCI_IMAGE)
        manifest = verify_descriptor(read_json, leaf, OCI_IMAGE)
    require(manifest.get('config') == {'mediaType': OCI_CONFIG, 'digest': config_digest, 'size': config_size},
            'OCI image config differs from verified Docker config')
    return {key: root[key] for key in ('digest', 'mediaType', 'size')}


def verify_archive(directory, tag, environment, source, receipt_hash, *, load_identities=False):
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
        if 'public_config' in receipt:
            public = receipt['public_config']
            require(isinstance(public, dict) and set(public) == {'supabase_url', 'anon_key_sha256'} and
                    isinstance(public.get('supabase_url'), str) and public['supabase_url'] and
                    re.fullmatch(r'[0-9a-f]{64}', public.get('anon_key_sha256', '')), 'Invalid public config receipt')
            fingerprint = hashlib.sha256(json.dumps(public, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
            require(config.get('config', {}).get('Labels', {}).get('work.ezil.public-config-sha256') == fingerprint,
                    'Image public configuration differs from sealed receipt')
        config_digest = 'sha256:' + digest
        if load_identities:
            alternate = verify_oci_identity(read_json, tag, config_digest, len(data)) if any(
                member.name == 'index.json' for member in members) else None
            return {'config': config_digest, 'oci': alternate}
    return config_digest


def verify_loaded(image, source, expected_id):
    require(image.get('Id') == expected_id, 'Loaded image ID differs from verified archive')
    image_metadata(image, source)


def verify_loaded_identity(image, source, identities):
    observed = image.get('Id')
    if observed == identities['config']:
        verify_loaded(image, source, identities['config'])
        return observed
    oci = identities['oci']
    require(oci is not None and observed == oci['digest'], 'Loaded image ID differs from verified archive')
    descriptor = image.get('Descriptor')
    require(isinstance(descriptor, dict) and all(descriptor.get(key) == value for key, value in oci.items()),
            'Loaded OCI descriptor differs from verified archive')
    verify_loaded(image, source, oci['digest'])
    return observed


if __name__ == '__main__':
    if sys.argv[1] == 'archive':
        print(verify_archive(Path(sys.argv[2]), *sys.argv[3:]))
    elif sys.argv[1] == 'loaded':
        verify_loaded(json.loads(Path(sys.argv[2]).read_text()), *sys.argv[3:])
    elif sys.argv[1] == 'archive-load-identities':
        print(json.dumps(verify_archive(Path(sys.argv[2]), *sys.argv[3:], load_identities=True), separators=(',', ':')))
    elif sys.argv[1] == 'loaded-identity':
        print(verify_loaded_identity(json.loads(Path(sys.argv[2]).read_text()), sys.argv[3], json.loads(sys.argv[4])))
    else:
        raise SystemExit('Unknown verification mode')
