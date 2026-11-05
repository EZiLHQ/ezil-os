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

class VerifiedInstallTests(SandboxTestCase):
    def prepare(self, *, source=None, label=None, runtime_sha=None, tag='v1', public_config=None):
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
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for name, data in [(image_id + '.json', raw), ('manifest.json', json.dumps([
                    {'Config': image_id + '.json', 'RepoTags': ['ezil-os-staging:' + tag], 'Layers': []}]).encode())]:
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                tar.addfile(entry, io.BytesIO(data))
        (directory / (tag + '.tar.gz')).write_bytes(gzip.compress(archive.getvalue()))
        hashes = {tag + '.' + s: hashlib.sha256((directory / (tag + '.' + s)).read_bytes()).hexdigest()
                  for s in ('tar.gz', 'runtime.tar.gz')}
        (directory / (tag + '.sha256')).write_text(''.join(f'{v}  {k}\n' for k, v in hashes.items()))
        receipt = {'schema': 1, 'source': source, 'environment': 'staging', 'component': 'aws-app',
                   'image': 'ezil-os-staging:' + tag, 'artifacts': hashes}
        if public_config is not None:
            receipt['public_config'] = public_config
        path = directory / (tag + '.source.json')
        path.write_text(json.dumps(receipt))
        self.loaded = {'Id': 'sha256:' + image_id, 'Architecture': 'amd64', 'Os': 'linux', 'Config': config['config']}
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

    def test_loaded_image_substitution_stops_before_replacing_app(self):
        receipt = self.prepare()
        self.loaded['Id'] = 'sha256:' + '0' * 64
        _, result = self.install(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Loaded image ID differs', result.stderr)
        self.assertFalse(any('up' in c for c in self.box.calls()))

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
