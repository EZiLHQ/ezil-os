"""Execute the generated verified SSM payload locally with cloud/system shims."""
import gzip
import hashlib
import io
import json
import subprocess
import tarfile
import unittest

from test_deploy_tooling import JOBS, SandboxTestCase

BUCKET = 'ezil-main-preview-artifacts-452630323510-aps1'
HOST = 'i-014810524754b9ed0'
HOST_PIN = 'vpc-0f6bc19fdfd4209aa\tezil-os-billing-staging-host\tbilling-staging'

def docker_tar(raw, tag, *, blobs=False, repo_tags=None, config_name=None, compress=False, manifest=True,
               extra=(), entries=1):
    """A docker-save archive: classic <hex>.json or containerd-style blobs/sha256/<hex> config."""
    digest = hashlib.sha256(raw).hexdigest()
    name = config_name or (f'blobs/sha256/{digest}' if blobs else digest + '.json')
    files = [(name, raw), *extra]
    if manifest:
        entry = {'Config': name, 'Layers': [],
                 'RepoTags': ['ezil-os-staging:' + tag] if repo_tags is None else repo_tags}
        files.append(('manifest.json', json.dumps([entry] * entries).encode()))
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as tar:
        for member, data in files:
            entry = tarfile.TarInfo(member)
            entry.size = len(data)
            tar.addfile(entry, io.BytesIO(data))
    return gzip.compress(buffer.getvalue()) if compress else buffer.getvalue()


class VerifiedInstallTests(SandboxTestCase):
    def prepare(self, *, source=None, label=None, runtime_sha=None, tag='v1', public_config=None,
                containerd=False):
        source = source or self.box.sha
        self.box.publish(BUCKET, 'os-staging/images', tag, 'ezil-os-staging', self.box.deploy)
        directory = self.box.s3 / BUCKET / 'os-staging/images'
        config = {'architecture': 'amd64', 'os': 'linux', 'config': {
            'Labels': {'org.opencontainers.image.revision': label or source},
            'Env': ['EZIL_GIT_SHA=' + (runtime_sha or source)]}}
        if public_config is not None:
            from public_config import fingerprint
            config['config']['Labels']['work.ezil.public-config-sha256'] = fingerprint(public_config)
        raw = json.dumps(config).encode()
        image_id = hashlib.sha256(raw).hexdigest()
        (directory / (tag + '.tar.gz')).write_bytes(docker_tar(raw, tag, blobs=containerd, compress=True))
        # What `docker save <tag>` returns from the loaded image (plain tar, same config blob).
        (self.box.state / 'save.tar').write_bytes(docker_tar(raw, tag, blobs=containerd))
        self.config_raw = raw
        hashes = {tag + '.' + s: hashlib.sha256((directory / (tag + '.' + s)).read_bytes()).hexdigest()
                  for s in ('tar.gz', 'runtime.tar.gz')}
        (directory / (tag + '.sha256')).write_text(''.join(f'{v}  {k}\n' for k, v in hashes.items()))
        receipt = {'schema': 1, 'source': source, 'environment': 'staging', 'component': 'aws-app',
                   'image': 'ezil-os-staging:' + tag, 'artifacts': hashes}
        if public_config is not None:
            receipt['public_config'] = public_config
        path = directory / (tag + '.source.json')
        path.write_text(json.dumps(receipt))
        # Classic stores report the config digest as Id; containerd reports the OCI index digest.
        store_id = hashlib.sha256(b'oci-index' + raw).hexdigest() if containerd else image_id
        self.loaded = {'Id': 'sha256:' + store_id, 'Architecture': 'amd64', 'Os': 'linux', 'Config': config['config']}
        self.directory = directory
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def install(self, receipt_hash, source=None, **extra):
        source = source or self.box.sha
        # Use deploy.sh's real embedding logic, but only a fake send-command.
        result = self.box.deploy_sh('install-verified', 'v1', source, receipt_hash,
                                   OS_STAGING_INSTANCE_ID=HOST,
                                   OS_STAGING_ARTIFACT_BUCKET=BUCKET, FAKE_DESCRIBE=HOST_PIN)
        self.assertEqual(result.returncode, 0, result.stderr)
        generated = self.box.root / 'generated.sh'
        generated.write_text('\n'.join(self.box.payloads()[-1].splitlines()[1:-1]) + '\n')
        return self.box.install([], script=generated, FAKE_INSPECT_JSON=json.dumps(self.loaded),
                                **{'FAKE_SHA': source, **extra})

    def test_verified_install_accepts_bound_archives_and_loaded_image(self):
        receipt = self.prepare()
        _, result = self.install(receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed TAG: v1', result.stdout)
        self.assertTrue(any('up' in c for c in self.box.calls()))

    def test_receipt_and_artifact_mismatches_stop_before_docker_load(self):
        for case in ('missing', 'hash', 'source', 'environment', 'tag', 'tar.gz', 'runtime.tar.gz'):
            with self.subTest(case=case):
                receipt = self.prepare()
                path = self.directory / 'v1.source.json'
                if case == 'missing':
                    path.unlink()
                elif case == 'hash':
                    receipt = '0' * 64
                elif case in ('tar.gz', 'runtime.tar.gz'):
                    (self.directory / ('v1.' + case)).write_bytes(b'changed after approval')
                else:
                    data = json.loads(path.read_text())
                    data[{'source': 'source', 'environment': 'environment', 'tag': 'image'}[case]] = {
                        'source': 'f' * 40, 'environment': 'production', 'tag': 'ezil-os-staging:v2'}[case]
                    path.write_text(json.dumps(data))
                    receipt = hashlib.sha256(path.read_bytes()).hexdigest()
                (self.box.state / 'log').unlink(missing_ok=True)
                _, result = self.install(receipt)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any(c[:2] == ['docker', 'load'] or 'up' in c for c in self.box.calls()))

    def test_false_image_revision_or_runtime_sha_stops_before_load(self):
        for kw in ({'label': 'f' * 40}, {'runtime_sha': 'f' * 40}):
            receipt = self.prepare(**kw)
            _, result = self.install(receipt)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:2] == ['docker', 'load'] for c in self.box.calls()))

    def assert_stopped_before_up(self, result, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertFalse(any('up' in c for c in self.box.calls()))
        self.assertFalse(any(c[:2] == ['systemctl', 'enable'] for c in self.box.calls()))

    def test_containerd_store_id_differs_from_config_digest_and_installs(self):
        receipt = self.prepare(containerd=True)
        self.assertNotEqual(self.loaded['Id'], 'sha256:' + hashlib.sha256(self.config_raw).hexdigest())
        _, result = self.install(receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed TAG: v1', result.stdout)
        self.assertTrue(any(c[:2] == ['docker', 'save'] for c in self.box.calls()))

    def test_classic_store_plain_export_installs_but_gzip_export_is_rejected(self):
        receipt = self.prepare()
        _, result = self.install(receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = self.prepare()
        (self.box.state / 'save.tar').write_bytes(docker_tar(self.config_raw, 'v1', compress=True))
        (self.box.state / 'log').unlink(missing_ok=True)
        _, result = self.install(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('up' in c for c in self.box.calls()))

    def test_loaded_image_with_same_labels_but_other_config_stops_before_replacing_app(self):
        for containerd in (False, True):
            with self.subTest(containerd=containerd):
                receipt = self.prepare(containerd=containerd)
                config = json.loads(self.config_raw)
                config['config']['Cmd'] = ['sh', '-c', 'substituted']
                forged = json.dumps(config).encode()
                (self.box.state / 'save.tar').write_bytes(docker_tar(forged, 'v1', blobs=containerd))
                self.loaded['Config'] = config['config']
                (self.box.state / 'log').unlink(missing_ok=True)
                _, result = self.install(receipt)
                self.assert_stopped_before_up(result, 'Loaded image config differs')

    def test_loaded_id_forgery_or_swap_stops_before_replacing_app(self):
        receipt = self.prepare(containerd=True)
        self.loaded['Id'] = 'not-an-id'
        _, result = self.install(receipt)
        self.assert_stopped_before_up(result, 'Invalid loaded image ID')
        receipt = self.prepare(containerd=True)
        (self.box.state / 'log').unlink(missing_ok=True)
        _, result = self.install(receipt, FAKE_ID_AFTER_SAVE='sha256:' + '0' * 64)
        self.assert_stopped_before_up(result, 'Loaded image changed during verification')

    def test_bad_exports_stop_before_replacing_app(self):
        cases = {
            'tag': lambda raw: docker_tar(raw, 'v1', repo_tags=['ezil-os-staging:v2']),
            'untagged': lambda raw: docker_tar(raw, 'v1', repo_tags=[]),
            'missing-manifest': lambda raw: docker_tar(raw, 'v1', manifest=False),
            'config-path': lambda raw: docker_tar(raw, 'v1', config_name='../config.json'),
            'unrelated-config': lambda raw: docker_tar(raw, 'v1', blobs=True, config_name='blobs/sha256/' + '0' * 64),
            'unrelated-image': lambda raw: docker_tar(b'{"architecture": "amd64"}', 'v1'),
        }
        for name, build in cases.items():
            with self.subTest(case=name):
                receipt = self.prepare()
                (self.box.state / 'save.tar').write_bytes(build(self.config_raw))
                (self.box.state / 'log').unlink(missing_ok=True)
                _, result = self.install(receipt)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any('up' in c for c in self.box.calls()))

    def test_multiple_docker_manifest_entries_stop_before_replacing_app(self):
        receipt = self.prepare(containerd=True)
        (self.box.state / 'save.tar').write_bytes(docker_tar(self.config_raw, 'v1', blobs=True, entries=2))
        _, result = self.install(receipt)
        self.assert_stopped_before_up(result, 'Expected one Docker image')

    def oci_layout(self, raw):
        """Actual-style containerd export: OCI index, runnable manifest and an unknown/unknown attestation."""
        digest = hashlib.sha256(raw).hexdigest()
        manifest = json.dumps({'schemaVersion': 2, 'config': {'digest': 'sha256:' + digest}}).encode()
        attestation = json.dumps({'schemaVersion': 2, 'config': {'digest': 'sha256:' + '7' * 64}}).encode()
        index = json.dumps({'schemaVersion': 2, 'manifests': [
            {'digest': 'sha256:' + hashlib.sha256(manifest).hexdigest(), 'platform': {'architecture': 'amd64', 'os': 'linux'}},
            {'digest': 'sha256:' + hashlib.sha256(attestation).hexdigest(),
             'platform': {'architecture': 'unknown', 'os': 'unknown'}}]}).encode()
        return [('index.json', index), ('oci-layout', b'{"imageLayoutVersion":"1.0.0"}'),
                ('blobs/sha256/' + hashlib.sha256(manifest).hexdigest(), manifest),
                ('blobs/sha256/' + hashlib.sha256(attestation).hexdigest(), attestation)]

    def test_oci_index_with_attestation_accepts_only_matching_raw_config(self):
        receipt = self.prepare(containerd=True)
        (self.box.state / 'save.tar').write_bytes(
            docker_tar(self.config_raw, 'v1', blobs=True, extra=self.oci_layout(self.config_raw)))
        _, result = self.install(receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Matching descriptors and labels do not help when the single Docker entry carries another config.
        receipt = self.prepare(containerd=True)
        config = json.loads(self.config_raw)
        config['config']['Cmd'] = ['substituted']
        forged = json.dumps(config).encode()
        (self.box.state / 'save.tar').write_bytes(
            docker_tar(forged, 'v1', blobs=True, extra=self.oci_layout(self.config_raw)))
        (self.box.state / 'log').unlink(missing_ok=True)
        _, result = self.install(receipt)
        self.assert_stopped_before_up(result, 'Loaded image config differs')

    def test_export_failure_or_corrupt_export_fails_closed(self):
        receipt = self.prepare()
        _, result = self.install(receipt, FAKE_SAVE_FAIL='1')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('up' in c for c in self.box.calls()))
        (self.box.state / 'log').unlink(missing_ok=True)
        (self.box.state / 'save.tar').write_bytes(b'not a tar')
        _, result = self.install(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('up' in c for c in self.box.calls()))

    def test_private_export_is_removed_after_verification(self):
        receipt = self.prepare(containerd=True)
        _, result = self.install(receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        # Gone before the app is replaced, not merely at exit.
        self.assertEqual((self.box.state / 'export_at_up').read_text(), 'False')
        self.assertEqual(list((self.box.root / 'tmp').iterdir()), [])
        receipt = self.prepare(containerd=True)
        (self.box.state / 'save.tar').write_bytes(b'not a tar')
        self.install(receipt)
        self.assertEqual(list((self.box.root / 'tmp').iterdir()), [])

    def test_running_container_not_bound_to_verified_store_id_takes_recovery_path(self):
        receipt = self.prepare(containerd=True)
        config_digest = 'sha256:' + hashlib.sha256(self.config_raw).hexdigest()
        # A container reporting the raw config digest instead of the verified store ID is not accepted blindly.
        _, result = self.install(receipt, FAKE_RUNNING_IMAGE=config_digest)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Runtime SHA mismatch; release owner must recover', result.stderr)
        self.assertIn('store_id=' + self.loaded['Id'], result.stderr)
        self.assertIn('image_id=' + config_digest, result.stderr)
        self.assertIn('Observed runtime: source=' + self.box.sha + ' image=' + config_digest, result.stderr)
        self.assertFalse(any(c[:2] == ['systemctl', 'enable'] for c in self.box.calls()))
        self.assertNotIn('Installed TAG:', result.stdout)

    def test_runtime_mismatch_fails_with_recovery_message(self):
        receipt = self.prepare()
        units = self.box.root / 'host/etc/systemd/system'
        units.mkdir(parents=True, exist_ok=True)
        for job in JOBS:
            (units / f'ezil-os-staging-{job}.timer').touch()
        _, result = self.install(receipt, FAKE_SHA='f' * 40)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Runtime SHA mismatch; release owner must recover', result.stderr)
        self.assertNotIn('Installed TAG:', result.stdout)
        self.assertNotIn('Deployed SHA:', result.stdout)
        self.assertIn('Candidate: image=ezil-os-staging:v1 source=' + self.box.sha, result.stderr)
        self.assertIn('Previous observed: image=ezil-os-staging:previous source=' + '2' * 40, result.stderr)
        self.assertIn('image_id=sha256:' + '1' * 64, result.stderr)
        self.assertIn('stopped timers remain stopped. No automatic rollback', result.stderr)
        calls = self.box.calls()
        self.assertEqual(len([c for c in calls if c[0] == 'docker' and 'up' in c]), 1)
        stopped = [c for c in calls if c[:2] == ['systemctl', 'stop']]
        self.assertEqual({c[2] for c in stopped}, {f'ezil-os-staging-{j}.timer' for j in JOBS})
        up = next(i for i, c in enumerate(calls) if c[0] == 'docker' and 'up' in c)
        self.assertTrue(all(calls.index(c) < up for c in stopped))
        self.assertFalse(any(c[:2] == ['systemctl', 'enable'] for c in calls))

    def test_verified_entry_refuses_production_or_missing_approval(self):
        for args, env in [(('install-verified', 'v1'), {}),
                          (('install-verified', 'v1', self.box.sha, '0' * 64), {'OS_ENV': 'production'})]:
            result = self.box.deploy_sh(*args, **env)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.box.calls(), [])

    def test_wrong_instance_vpc_or_bucket_never_sends_install(self):
        for change in ({'OS_STAGING_INSTANCE_ID': 'i-0123456789abcdef0'},
                       {'FAKE_DESCRIBE': HOST_PIN.replace('vpc-0f6bc19fdfd4209aa', 'vpc-00000000')},
                       {'OS_STAGING_ARTIFACT_BUCKET': 'other-staging'}):
            env = {'OS_STAGING_INSTANCE_ID': HOST, 'OS_STAGING_ARTIFACT_BUCKET': BUCKET,
                   'FAKE_DESCRIBE': HOST_PIN, **change}
            result = self.box.deploy_sh('install-verified', 'v1', self.box.sha, '0' * 64, **env)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('send-command' in c for c in self.box.calls()))


if __name__ == '__main__':
    unittest.main()
