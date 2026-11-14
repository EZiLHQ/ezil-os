#!/usr/bin/env python3
"""install-host.sh's release-registry guard and deploy.sh's capacity label, run from their exact bytes.

Offline: the guard program is executed with subprocess.run replaced (no AWS, no Docker, no secret).
"""
import contextlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
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


class GuardTests(unittest.TestCase):
    SANITIZED = {'AWS_CONFIG_FILE': '/dev/null', 'AWS_SHARED_CREDENTIALS_FILE': '/dev/null'}

    def run_guard(self, labels, count, source='secret', secret_ok=True, raw=None, environment=None, label_text=None):
        deployments = json.dumps(registry(count)) if raw is None else raw
        calls = []

        def run(command, **kwargs):
            calls.append((command, kwargs))
            self.assertEqual(command[:6], ['aws', '--region', 'ap-south-1', '--no-cli-pager', 'secretsmanager', 'get-secret-value'])
            self.assertNotIn('env', kwargs)  # inherits install-host.sh's exported instance-role-only environment
            self.assertIs(kwargs['stdin'], subprocess.DEVNULL)
            secret = json.dumps({'CRON_SECRET': 'x' * 40, 'EZIL_AWS_LIFECYCLE_DEPLOYMENTS': deployments})
            return subprocess.CompletedProcess(command, 0 if secret_ok else 255, stdout=json.dumps({'SecretString': secret}), stderr='')

        with tempfile.TemporaryDirectory() as directory:
            if source == 'env':
                env = Path(directory) / 'app.env'
                env.write_text('CRON_SECRET=' + 'x' * 40 + '\nEZIL_AWS_LIFECYCLE_DEPLOYMENTS=' + deployments + '\n')
                source = str(env)
            argv = ['-', json.dumps(labels) if label_text is None else label_text, source]
            stderr = io.StringIO()
            with patch.object(sys, 'argv', argv), patch('subprocess.run', side_effect=run), contextlib.redirect_stderr(stderr), \
                    patch.dict('os.environ', self.SANITIZED if environment is None else environment, clear=False):
                try:
                    exec(compile(GUARD[0], 'install-host-registry-guard', 'exec'), {'__name__': '__main__'})
                    outcome = None
                except SystemExit as error:
                    outcome = str(error.code)
        self.assertNotIn('x' * 40, (outcome or '') + stderr.getvalue())  # never prints a secret value
        return outcome, calls

    def test_exactly_one_guard_program(self):
        self.assertEqual(len(GUARD), 1)
        self.assertEqual(len(LABEL), 1)

    def test_legacy_registry_accepts_any_image(self):
        for labels in (None, {}, {'work.ezil.registry-capacity': '32'}, {'work.ezil.registry-capacity': 'junk'}):
            for count in (1, 31, 32):
                with self.subTest(labels=labels, count=count):
                    self.assertIsNone(self.run_guard(labels, count)[0])

    def test_past_thirty_two_requires_a_reading_image(self):
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '33'}, 33)[0])
        self.assertIsNone(self.run_guard({'work.ezil.registry-capacity': '33'}, 33, source='env')[0])
        for labels, count in ((None, 33), ({}, 33), ({'org.opencontainers.image.revision': 'e' * 40}, 33),
                              ({'work.ezil.registry-capacity': '32'}, 33), ({'work.ezil.registry-capacity': '033'}, 33),
                              ({'work.ezil.registry-capacity': '33'}, 34), ({'work.ezil.registry-capacity': ' 33'}, 33)):
            for source in ('secret', 'env'):
                with self.subTest(labels=labels, count=count, source=source):
                    outcome, _ = self.run_guard(labels, count, source=source)
                    self.assertEqual(outcome, 'Image cannot read the live release registry; refused before install')

    def test_unreadable_inputs_refuse(self):
        self.assertEqual(self.run_guard({}, 33, secret_ok=False)[0], 'Registry capacity guard could not read the app secret')
        self.assertEqual(self.run_guard({}, 1, label_text='amd64')[0], 'Registry capacity guard could not read the image labels')
        self.assertEqual(self.run_guard({}, 1, raw='{not json')[0], 'Invalid release registry')
        self.assertEqual(self.run_guard({}, 1, source='/nonexistent/app.env')[0], 'Invalid rendered environment')
        outcome, calls = self.run_guard({}, 1, environment={'AWS_SHARED_CREDENTIALS_FILE': '/root/.aws/credentials'})
        self.assertEqual(outcome, 'Registry capacity guard requires the instance-role-only AWS environment')
        self.assertEqual(calls, [])
        self.assertLess(INSTALLER.index('export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null'),
                        INSTALLER.index('registry_guard secret\n'))
        self.assertEqual(self.run_guard({}, 1, raw=json.dumps({'ap-south-1': {'releases': {}}}))[0], 'Invalid release registry')
        self.assertIsNone(self.run_guard({}, 1, raw=json.dumps({'ap-south-1': {}}))[0])  # no registry yet: nothing to read

    def test_guard_runs_before_any_change_and_again_on_the_rendered_environment(self):
        first = INSTALLER.index('registry_guard secret\n')
        self.assertLess(INSTALLER.index('docker load'), first)
        self.assertLess(first, INSTALLER.index('# Extract only known ordinary files'))
        self.assertLess(first, INSTALLER.index('systemctl stop'))
        second = INSTALLER.index('registry_guard /etc/ezil-os-staging/app.env\n')
        self.assertLess(INSTALLER.index('python3 render-env.py </dev/null'), second)
        self.assertLess(second, INSTALLER.index('docker compose --env-file compose.env up -d --force-recreate'))
        self.assertEqual(INSTALLER.count('registry_guard '), 2)


class InstallerSandboxTests(SandboxTestCase):
    """The real install-host.sh in the shared PATH-shim sandbox (fake S3/Docker/AWS; nothing leaves the box)."""

    def install(self, count, labels=None):
        self.box.publish('fixture-staging', 'os-staging/images', 'old', 'ezil-os-staging', self.box.deploy)
        extra = {'FAKE_LABELS': json.dumps(labels)} if labels is not None else {}
        return self.box.install(['old', 'fixture-staging'], FAKE_DEPLOYMENTS=json.dumps(registry(count)), FAKE_SHA='e' * 40, **extra)

    def test_thirty_three_records_refuse_an_unlabelled_image_before_any_change(self):
        _, result = self.install(33)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Image cannot read the live release registry; refused before install', result.stderr)
        calls = self.box.calls()
        self.assertTrue(any(c[:2] == ['docker', 'load'] for c in calls))
        self.assertFalse(any(c[0] in ('systemctl', 'render-env.py') or 'up' in c for c in calls))

    def test_thirty_three_records_reach_render_with_a_reading_image(self):
        _, result = self.install(33, {'work.ezil.registry-capacity': '33'})
        self.assertIn(['render-env.py'], self.box.calls())
        self.assertNotIn('cannot read the live release registry', result.stderr)


class LabelTests(unittest.TestCase):
    def capacity(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'aws-rebase-release.ts'
            path.write_text(text)
            return subprocess.run([sys.executable, '-', str(path)], input=LABEL[0], capture_output=True, text=True, timeout=30)

    def test_label_is_the_exact_source_constant(self):
        source = (HERE.parents[2] / 'app/src/server/lib/compute/aws-rebase-release.ts').read_text()
        result = self.capacity(source)
        self.assertEqual((result.returncode, result.stdout), (0, '33\n'))
        self.assertIn('--label "work.ezil.registry-capacity=$registry_capacity"', DEPLOY)
        for bad in ('', 'export const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\nexport const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\n',
                    'const REBASE_RELEASE_REGISTRY_CAPACITY = 33;\n', 'export const REBASE_RELEASE_REGISTRY_CAPACITY = 0;\n'):
            with self.subTest(bad=bad):
                self.assertNotEqual(self.capacity(bad).returncode, 0)


if __name__ == '__main__':
    unittest.main()
