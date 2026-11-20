#!/usr/bin/env python3
"""install-host.sh's release-registry guard and deploy.sh's capacity label, run from their exact bytes.

Offline: the guard program is executed with subprocess.run replaced, and the real installer runs in the
shared PATH-shim sandbox (fake S3/Docker/AWS). No AWS, no Docker, no secret.
"""
import contextlib
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from test_deploy_tooling import SandboxTestCase  # noqa: E402

INSTALLER = (HERE / 'install-host.sh').read_text()
DEPLOY = (HERE / 'deploy.sh').read_text()
GUARD = re.findall(r"<<'OS_REGISTRY_CAPACITY_PY'\n(.*?)\nOS_REGISTRY_CAPACITY_PY\n", INSTALLER, re.S)
LABEL = re.findall(r"registry_capacity=\$\(python3 - \"\$build_root/app/src/server/lib/compute/aws-rebase-release.ts\" <<'PY'\n(.*?)\nPY\n\)",
                   DEPLOY, re.S)


def registry(count):
    record = {'amiId': 'ami-' + '1' * 17}
    return {'ap-south-1': {'amiId': 'ami-' + '2' * 17, 'releases': [dict(record, n=n) for n in range(count)]}}


def image_archive(labels, entries=1, config_ref=None):
    """A docker-save shaped gzip tar: manifest.json -> Config blob carrying the image labels."""
    config = json.dumps({'architecture': 'amd64', 'os': 'linux', 'config': {'Labels': labels}}).encode()
    name = 'blobs/sha256/' + hashlib.sha256(config).hexdigest()
    members = {'manifest.json': json.dumps([{'Config': config_ref or name, 'RepoTags': ['ezil-os-staging:old'], 'Layers': []}] * entries).encode(),
               name: config, 'blobs/sha256/' + 'f' * 64: b'layer bytes'}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for member, data in members.items():
            info = tarfile.TarInfo(member)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return gzip.compress(buffer.getvalue())


class GuardTests(unittest.TestCase):
    SANITIZED = {'AWS_CONFIG_FILE': '/dev/null', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null',
                 'EZIL_REGISTRY_SECRET_ID': 'ezil-os/billing-staging/app', 'EZIL_REGISTRY_LEGACY': '32'}
    PRODUCTION = dict(SANITIZED, EZIL_REGISTRY_SECRET_ID='ezil-os/production/app', EZIL_REGISTRY_LEGACY='26')

    def run_guard(self, labels, count, source='secret', secret_ok=True, raw=None, environment=None, archive=None, running=None):
        deployments = json.dumps(registry(count)) if raw is None else raw
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            self.assertEqual(command[:6], ['aws', '--region', 'ap-south-1', '--no-cli-pager', 'secretsmanager', 'get-secret-value'])
            self.assertNotIn('env', kwargs)  # inherits install-host.sh's exported instance-role-only environment
            # The environment's own app secret: billing-staging for staging, production for production.
            self.assertEqual(command[command.index('--secret-id') + 1], os.environ['EZIL_REGISTRY_SECRET_ID'])
            self.assertIs(kwargs['stdin'], subprocess.DEVNULL)
            secret = json.dumps({'CRON_SECRET': 'x' * 40, 'EZIL_AWS_LIFECYCLE_DEPLOYMENTS': deployments})
            return subprocess.CompletedProcess(command, 0 if secret_ok else 255, stdout=json.dumps({'SecretString': secret}), stderr='')

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'old.tar.gz'
            path.write_bytes(image_archive(labels) if archive is None else archive)
            if source == 'env':
                env = Path(directory) / 'app.env'
                env.write_text('CRON_SECRET=' + 'x' * 40 + '\nEZIL_AWS_LIFECYCLE_DEPLOYMENTS=' + deployments + '\n')
                source = str(env)
            argv = ['-', str(path), source, *([] if running is None else [running])]
            stderr = io.StringIO()
            with patch.object(sys, 'argv', argv), patch('subprocess.run', side_effect=run), contextlib.redirect_stderr(stderr), \
                    patch.dict('os.environ', self.SANITIZED if environment is None else environment, clear=False):
                try:
                    exec(compile(GUARD[0], 'install-host-registry-guard', 'exec'), {'__name__': '__main__'})
                    outcome = None
                except SystemExit as error:
                    outcome = None if error.code in (None, 0) else str(error.code)
        self.assertNotIn('x' * 40, (outcome or '') + stderr.getvalue())  # never prints a secret value
        return outcome, calls

    def test_exactly_one_guard_program(self):
        self.assertEqual(len(GUARD), 1)
        self.assertEqual(len(LABEL), 1)

    def test_legacy_registry_accepts_any_image_without_reading_it(self):
        for labels in (None, {}, {'work.ezil.registry-capacity': '32'}, {'work.ezil.registry-capacity': 'junk'}):
            for count in (1, 31, 32):
                with self.subTest(labels=labels, count=count):
                    self.assertIsNone(self.run_guard(labels, count)[0])
        self.assertIsNone(self.run_guard({}, 32, archive=b'not an archive')[0])  # nothing is parsed at or below 32

    def test_past_thirty_two_requires_a_reading_image(self):
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '33'}, 33)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '33'}, 33, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '35'}, 35)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '35'}, 35, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '36'}, 36)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '36'}, 36, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '37'}, 37)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '37'}, 37, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '38'}, 38)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '38'}, 38, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '39'}, 39)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '40'}, 40)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '39'}, 39, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '40'}, 40, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '41'}, 41)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '41'}, 41, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '42'}, 42)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '42'}, 42, source='env')[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '43'}, 43)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '43'}, 43, source='env')[0])
        for labels, count in ((None, 33), ({}, 33), ({'org.opencontainers.image.revision': 'e' * 40}, 33),
                              ({'work.ezil.registry-capacity': '32'}, 33), ({'work.ezil.registry-capacity': '033'}, 33),
                              ({'work.ezil.registry-capacity': '33'}, 34), ({'work.ezil.registry-capacity': ' 33'}, 33),
                              ({'work.ezil.registry-capacity': '34'}, 35), ({'work.ezil.registry-capacity': '35'}, 36),
                              ({'work.ezil.registry-capacity': '36'}, 37), ({'work.ezil.registry-capacity': '37'}, 38),
                              ({'work.ezil.registry-capacity': '38'}, 39), ({'work.ezil.registry-capacity': '39'}, 40),
                              ({'work.ezil.registry-capacity': '40'}, 41), ({'work.ezil.registry-capacity': '41'}, 42),
                              ({'work.ezil.registry-capacity': '42'}, 43), ({'work.ezil.registry-capacity': '43'}, 44)):
            for source in ('secret', 'env'):
                with self.subTest(labels=labels, count=count, source=source):
                    outcome, _ = self.run_guard(labels, count, source=source)
                    self.assertEqual(outcome, 'Image cannot read the live release registry; refused before install')

    def test_production_keeps_its_legacy_twenty_six(self):
        production = self.PRODUCTION
        for labels in (None, {}, {'work.ezil.registry-capacity': 'junk'}):
            for count in (1, 25, 26):
                with self.subTest(labels=labels, count=count):
                    self.assertIsNone(self.run_guard(labels, count, environment=production)[0])
        self.assertIsNone(self.run_guard({}, 26, environment=production, archive=b'not an archive')[0])
        for labels, count in ((None, 27), ({}, 27), ({'work.ezil.registry-capacity': '26'}, 27),
                              ({'work.ezil.registry-capacity': '32'}, 33), ({'work.ezil.registry-capacity': '35'}, 36),
                              ({'work.ezil.registry-capacity': '36'}, 37), ({'work.ezil.registry-capacity': '37'}, 38),
                              ({'work.ezil.registry-capacity': '38'}, 39), ({'work.ezil.registry-capacity': '39'}, 40),
                              ({'work.ezil.registry-capacity': '40'}, 41), ({'work.ezil.registry-capacity': '41'}, 42),
                              ({'work.ezil.registry-capacity': '42'}, 43), ({'work.ezil.registry-capacity': '43'}, 44)):
            for source in ('secret', 'env'):
                with self.subTest(labels=labels, count=count, source=source):
                    outcome, _ = self.run_guard(labels, count, source=source, environment=production)
                    self.assertEqual(outcome, 'Image cannot read the live release registry; refused before install')
        for label, count in (('27', 27), ('36', 36), ('37', 37), ('38', 38), ('39', 39), ('40', 40), ('41', 41), ('42', 42), ('43', 43)):
            self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': label}, count, environment=production)[0])
        # After the recreate a production app must itself prove a reader past twenty-six.
        self.assertIsNone(self.run_guard({}, 26, source='env', running='unavailable', environment=production)[0])
        outcome, _ = self.run_guard({}, 27, source='env', running='26', environment=production)
        self.assertTrue(outcome.startswith('Running app cannot read the live release registry.'), outcome)

    def test_unreviewed_environment_pair_refuses_before_reading(self):
        for pair in ({'EZIL_REGISTRY_SECRET_ID': 'ezil-os/production/app', 'EZIL_REGISTRY_LEGACY': '32'},
                     {'EZIL_REGISTRY_SECRET_ID': 'ezil-os/billing-staging/app', 'EZIL_REGISTRY_LEGACY': '26'},
                     {'EZIL_REGISTRY_SECRET_ID': '', 'EZIL_REGISTRY_LEGACY': ''}):
            with self.subTest(pair=pair):
                outcome, calls = self.run_guard({}, 1, environment=dict(self.SANITIZED, **pair))
                self.assertEqual(outcome, 'Registry capacity guard environment is not a reviewed pair')
                self.assertEqual(calls, [])

    def test_unreadable_archive_refuses_past_thirty_two(self):
        reading = {'work.ezil.registry-capacity': '33'}
        for archive in (b'not an archive', gzip.compress(b'not a tar'), image_archive(reading, entries=2),
                        image_archive(reading, config_ref='blobs/sha256/' + '0' * 64), image_archive(reading)[:60]):
            with self.subTest(archive=archive[:12]):
                self.assertEqual(self.run_guard(reading, 33, archive=archive)[0], 'Registry capacity guard could not read the image labels')

    def test_running_capacity_after_recreate(self):
        for running in ('33', '34'):
            self.assertIsNone(self.run_guard({}, 33, source='env', running=running)[0])
        for running in ('32', 'unavailable', '', '033'):
            with self.subTest(running=running):
                outcome, _ = self.run_guard({'work.ezil.registry-capacity': '33'}, 33, source='env', running=running)
                self.assertTrue(outcome.startswith('Running app cannot read the live release registry. App replacement already ran; '
                                                   'stopped timers remain stopped.'), outcome)
        self.assertIsNone(self.run_guard({}, 32, source='env', running='unavailable')[0])

    def test_unreadable_inputs_refuse(self):
        self.assertEqual(self.run_guard({}, 33, secret_ok=False)[0], 'Registry capacity guard could not read the app secret')
        self.assertEqual(self.run_guard({}, 1, raw='{not json')[0], 'Invalid release registry')
        self.assertEqual(self.run_guard({}, 1, raw=json.dumps({'ap-south-1': {'releases': {}}}))[0], 'Invalid release registry')
        self.assertIsNone(self.run_guard({}, 1, raw=json.dumps({'ap-south-1': {}}))[0])  # no registry yet: nothing to read
        self.assertEqual(self.run_guard({}, 1, source='/nonexistent/app.env')[0], 'Invalid rendered environment')
        outcome, calls = self.run_guard({}, 1, environment=dict(self.SANITIZED, AWS_SHARED_CREDENTIALS_FILE='/root/.aws/credentials'))
        self.assertEqual(outcome, 'Registry capacity guard requires the instance-role-only AWS environment')
        self.assertEqual(calls, [])

    def test_guard_order_in_the_installer(self):
        exported = INSTALLER.index('export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null')
        checksum = INSTALLER.index('raise SystemExit("Checksum mismatch")')
        first = INSTALLER.index('registry_guard secret\n')
        load = INSTALLER.index('gzip -dc "$temporary/$tag.tar.gz" | docker load')
        self.assertLess(exported, first)
        self.assertLess(checksum, first)
        self.assertLess(first, load)  # before load, retag, runtime extraction or timers
        self.assertLess(load, INSTALLER.index('systemctl stop'))
        second = INSTALLER.index('registry_guard "/etc/$slug/app.env"\n')
        self.assertLess(INSTALLER.index('keys=$(python3 render-env.py "$environment" </dev/null)'), second)
        up = INSTALLER.index('docker compose --env-file compose.env up -d --force-recreate')
        self.assertLess(second, up)
        third = INSTALLER.index('registry_guard "/etc/$slug/app.env" "$running_capacity"\n')
        self.assertLess(up, third)
        self.assertLess(third, INSTALLER.index('systemctl enable --now'))
        self.assertEqual(INSTALLER.count('registry_guard '), 3)
        # Exactly the two reviewed environment pairs (json-tool.py legacy_registry_capacity()).
        self.assertIn('staging) registry_secret=ezil-os/billing-staging/app registry_legacy=32;;', INSTALLER)
        self.assertIn('production) registry_secret=ezil-os/production/app registry_legacy=26;;', INSTALLER)


class InstallerSandboxTests(SandboxTestCase):
    """The real install-host.sh in the shared PATH-shim sandbox (fake S3/Docker/AWS; nothing leaves the box)."""

    def install(self, count, labels=None, running=None):
        self.box.publish('fixture-staging', 'os-staging/images', 'old', 'ezil-os-staging', self.box.deploy)
        images = self.box.s3 / 'fixture-staging/os-staging/images'
        (images / 'old.tar.gz').write_bytes(image_archive(labels or {}))
        (images / 'old.sha256').write_text(''.join(f"{hashlib.sha256((images / f'old.{s}').read_bytes()).hexdigest()}  old.{s}\n"
                                                  for s in ('tar.gz', 'runtime.tar.gz')))
        extra = {'FAKE_INSPECT_JSON': json.dumps({'Id': 'sha256:' + 'a' * 64, 'Architecture': 'amd64'})}
        if running is not None:
            extra['FAKE_RUNNING_CAPACITY'] = running
        return self.box.install(['old', 'fixture-staging'], FAKE_DEPLOYMENTS=json.dumps(registry(count)), FAKE_SHA='e' * 40, **extra)

    def enabled(self):
        return [c for c in self.box.calls() if c[:3] == ['systemctl', 'enable', '--now']]

    def test_thirty_three_records_refuse_an_unlabelled_image_before_load(self):
        _, result = self.install(33)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Image cannot read the live release registry; refused before install', result.stderr)
        calls = self.box.calls()
        self.assertFalse(any(c[:2] == ['docker', 'load'] for c in calls))
        self.assertFalse(any(c[0] in ('systemctl', 'render-env.py') or 'up' in c for c in calls))
        self.assertFalse((self.box.state / 'loaded').exists())

    def test_thirty_three_records_install_with_a_reading_image_and_running_proof(self):
        _, result = self.install(33, {'work.ezil.registry-capacity': '33'}, running='33')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(c[:2] == ['docker', 'load'] for c in self.box.calls()))
        self.assertEqual(len(self.enabled()), 6)

    def test_running_app_without_capacity_proof_keeps_timers_stopped(self):
        for running in (None, '32', 'unavailable'):
            with self.subTest(running=running):
                self.setUp()
                _, result = self.install(33, {'work.ezil.registry-capacity': '33'}, running=running)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Running app cannot read the live release registry. App replacement already ran; '
                              'stopped timers remain stopped.', result.stderr)
                self.assertTrue(any('up' in c for c in self.box.calls()))
                self.assertEqual(self.enabled(), [])

    def test_legacy_registry_needs_no_label_or_running_capacity(self):
        _, result = self.install(32, running='unavailable')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.enabled()), 6)


class LabelTests(unittest.TestCase):
    def capacity(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'aws-rebase-release.ts'
            path.write_text(text)
            return subprocess.run([sys.executable, '-', str(path)], input=LABEL[0], capture_output=True, text=True, timeout=30)

    def test_label_is_the_exact_source_constant(self):
        source = (HERE.parents[2] / 'app/src/server/lib/compute/aws-rebase-release.ts').read_text()
        result = self.capacity(source)
        self.assertEqual((result.returncode, result.stdout), (0, '43\n'))
        self.assertIn('--label "work.ezil.registry-capacity=$registry_capacity"', DEPLOY)
        for bad in ('', 'export const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\nexport const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\n',
                    'const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\n', 'export const REBASE_RELEASE_REGISTRY_CAPACITY = 0;\n'):
            with self.subTest(bad=bad):
                self.assertNotEqual(self.capacity(bad).returncode, 0)


if __name__ == '__main__':
    unittest.main()
