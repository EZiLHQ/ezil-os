"""Offline tests for PR preview slots (no AWS, Docker, systemd or network).

preview_host.py runs against a temporary root with its Docker/AWS/health calls
replaced; preview.sh runs with an `aws` PATH shim that captures the SSM payload.
"""
import datetime as dt
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import preview_host as ph  # noqa: E402

SHA = '0123456789abcdef0123456789abcdef01234567'
SHA2 = 'fedcba9876543210fedcba9876543210fedcba98'
IMAGE = 'sha256:' + 'a' * 64
RECEIPT = 'b' * 64
BUCKET = 'ezil-main-preview-artifacts-452630323510-aps1'
STAGING_ENV = ''.join(f'{k}={v}\n' for k, v in {
    'AUTH0_CLIENT_ID': 'client', 'CHECKOUT_ENABLED': '1', 'CLOUDFLARE_GUACAMOLE_HMAC_SECRET': 'h' * 40,
    'CRON_SECRET': 'c' * 40, 'EZIL_AWS_COMPUTERS_ENABLED': '1', 'EZIL_AWS_KILL_SWITCH': '0',
    'STRIPE_WEBHOOK_SECRET': 'whsec_x', 'SUPABASE_DATABASE_URL': 'postgres://u:p$w@10.0.0.1:5432/db?x=#1',
    'EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET': 'l' * 40, 'EZIL_AWS_APP_CALLER_ROLE_ARN_AP_SOUTH_1': 'arn:x',
}.items())


def tag(pr, sha=SHA):
    return f'pr{pr}-{sha[:12]}'


class Host(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / 'staging').mkdir()
        (self.tmp / 'staging' / 'app.env').write_text(STAGING_ENV)
        (self.tmp / 'staging' / 'compose.env').write_text('OS_STAGING_TAG=s9-20261108\n')
        patches = {'ROOT': self.tmp / 'opt', 'ETC': self.tmp / 'etc', 'SYSTEMD': self.tmp / 'systemd',
                   'STAGING_ENV': self.tmp / 'staging' / 'app.env',
                   'STAGING_COMPOSE_ENV': self.tmp / 'staging' / 'compose.env'}
        for name, value in patches.items():
            self.enterContext(mock.patch.object(ph, name, value))
        self.calls = []
        self.health = {}
        self.archive_id = IMAGE
        self.enterContext(mock.patch.object(ph, 'run', self.fake_run))
        self.enterContext(mock.patch.object(ph, 'download', self.fake_download))
        self.enterContext(mock.patch.object(ph.install_receipt, 'verify_archive', self.fake_verify_archive))
        self.enterContext(mock.patch.object(ph.install_receipt, 'verify_loaded', self.fake_verify_loaded))
        self.enterContext(mock.patch.object(ph, 'fetch_health', lambda port: self.health[port]))
        self.enterContext(mock.patch.object(ph.subprocess, 'run', self.fake_subprocess))
        self.enterContext(mock.patch.object(ph.time, 'sleep', lambda s: None))
        self.enterContext(mock.patch.object(ph, 'wait_healthy', self.fast_wait_healthy))

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    # -- fakes
    def fake_run(self, args, **kwargs):
        self.calls.append(list(args))
        if args[:3] == ['docker', 'image', 'inspect']:
            return json.dumps({'Id': IMAGE})
        if args[:2] == ['docker', 'compose'] and 'up' in args:
            receipts = ph.read_receipts()
            self.at_up = {s: (r['state'], r['expires_at']) for s, r in receipts.items()}
            if getattr(self, 'fail_up', False):
                raise subprocess.CalledProcessError(1, args)
        return ''

    def fake_download(self, bucket, t, directory):
        self.assertEqual(bucket, BUCKET)
        self.calls.append(['download', t])
        (directory / f'{t}.tar.gz').write_bytes(b'')

    def fake_subprocess(self, args, **kwargs):
        self.calls.append(list(args))
        return subprocess.CompletedProcess(args, 0, '', '')

    def fake_verify_archive(self, directory, t, environment, source, receipt):
        self.assertEqual((environment, receipt), ('staging', RECEIPT))
        self.calls.append(['verify_archive', t, source])
        return self.archive_id

    def fake_verify_loaded(self, image, source, expected):
        if getattr(self, 'fail_loaded', False):
            raise ValueError('Loaded image ID differs from verified archive')
        self.assertEqual(image['Id'], expected)

    def fast_wait_healthy(self, slot, sha, deadline_seconds=120):
        body = self.health.get(ph.SLOTS[slot], {})
        if not (body.get('ok') is True and body.get('sha') == sha):
            raise ph.PreviewError(f'Preview pv{slot} did not report sha {sha}')

    # -- helpers
    def deploy(self, pr, sha=SHA, **extra):
        for port in ph.SLOTS.values():
            self.health.setdefault(port, {'ok': True, 'sha': sha})
        args = ['deploy', '--pr', str(pr), '--sha', sha, '--tag', tag(pr, sha), '--image-id', IMAGE,
                '--receipt-sha256', RECEIPT, '--bucket', BUCKET, '--run', '42-1']
        for key, value in extra.items():
            args += [f'--{key.replace("_", "-")}', str(value)]
        with mock.patch('sys.stdout') as out:
            ph.main(args)
        line = ''.join(c.args[0] for c in out.write.call_args_list)
        self.assertTrue(line.startswith('PREVIEW_RESULT '), line)
        return json.loads(line.removeprefix('PREVIEW_RESULT '))['result']

    def env_of(self, slot):
        return ph.parse_env((self.tmp / 'etc' / f'pv{slot}.env').read_text())

    def removed_images(self):
        return [c[3] for c in self.calls if c[:3] == ['docker', 'image', 'rm']]

    def compose_calls(self):
        return [c for c in self.calls if c[:2] == ['docker', 'compose']]


class SlotAllocation(Host):
    def test_two_prs_get_their_own_slots_and_a_third_is_refused(self):
        self.assertEqual(self.deploy(289)['slot'], 1)
        self.assertEqual(self.deploy(290)['slot'], 2)
        with self.assertRaisesRegex(ph.PreviewError, r'busy \(pv1=pr289 until .*pv2=pr290'):
            self.deploy(291)
        self.assertEqual({r['pr'] for r in ph.read_receipts().values()}, {289, 290})

    def test_a_new_head_reuses_its_slot_and_drops_only_its_old_image(self):
        self.deploy(289)
        self.deploy(290)
        self.health = {p: {'ok': True, 'sha': SHA2} for p in ph.SLOTS.values()}
        second = self.deploy(289, SHA2)
        self.assertEqual((second['slot'], second['sha']), (1, SHA2))
        self.assertIn(['docker', 'image', 'rm', f'ezil-os-staging:{tag(289)}'], self.calls)
        self.assertNotIn(['docker', 'image', 'rm', f'ezil-os-staging:{tag(290)}'], self.calls)

    def test_an_expired_slot_is_reclaimed(self):
        self.deploy(289)
        self.deploy(290)
        receipt = json.loads(ph.receipt_path(1).read_text())
        receipt['expires_at'] = ph.iso(ph.now() - dt.timedelta(minutes=1))
        ph.receipt_path(1).write_text(json.dumps(receipt))
        self.assertEqual(self.deploy(291)['slot'], 1)
        self.assertIn(['docker', 'image', 'rm', f'ezil-os-staging:{tag(289)}'], self.calls)

    def test_choose_slot_never_returns_another_live_pr(self):
        later = ph.iso(ph.now() + dt.timedelta(hours=1))
        receipts = {1: {'pr': 1, 'expires_at': later}, 2: {'pr': 2, 'expires_at': later}}
        self.assertEqual(ph.choose_slot(receipts, 2, ph.now()), 2)
        with self.assertRaises(ph.PreviewError):
            ph.choose_slot(receipts, 3, ph.now())


class Deploy(Host):
    def test_receipt_compose_and_env_record_the_exact_lane(self):
        receipt = self.deploy(289, ttl_hours=6)
        self.assertEqual({k: receipt[k] for k in ('slot', 'origin', 'pr', 'sha', 'tag', 'image_id', 'computers')},
                         {'slot': 1, 'origin': 'https://os-pv1.ezil.work', 'pr': 289, 'sha': SHA, 'tag': tag(289),
                          'image_id': IMAGE, 'computers': 'off'})
        self.assertEqual(receipt['data_plane'], 'shared-staging-preview-supabase')
        self.assertEqual(ph.parse_iso(receipt['expires_at']) - ph.parse_iso(receipt['deployed_at']), dt.timedelta(hours=6))
        compose = json.loads((self.tmp / 'opt' / 'pv1' / 'compose.json').read_text())
        web = compose['services']['web']
        self.assertEqual(compose['name'], 'ezil-os-preview-pv1')
        self.assertEqual(web['image'], f'ezil-os-staging:{tag(289)}')
        self.assertEqual(web['command'][-4:], ['-H', '127.0.0.1', '-p', '3101'])
        self.assertEqual((web['mem_limit'], web['cpus'], web['pull_policy'], web['network_mode']), ('768m', '0.5', 'never', 'host'))
        self.assertEqual(web['labels']['work.ezil.preview.image_id'], IMAGE)
        up = [c for c in self.compose_calls() if 'up' in c]
        self.assertEqual(up[0][:4], ['docker', 'compose', '--project-name', 'ezil-os-preview-pv1'])
        self.assertFalse(any('ezil-os-staging' == c[3] for c in self.compose_calls()))
        mode = stat.S_IMODE((self.tmp / 'etc' / 'pv1.env').stat().st_mode)
        self.assertEqual(mode, 0o600)

    def test_env_overlay_removes_cron_webhook_and_computer_authority(self):
        self.deploy(289)
        env = self.env_of(1)
        for key in ('CRON_SECRET', 'STRIPE_WEBHOOK_SECRET', 'CLOUDFLARE_GUACAMOLE_HMAC_SECRET'):
            self.assertNotIn(key, env)
        self.assertEqual({k: env[k] for k in ('EZIL_DEPLOY_ENV', 'EZIL_PR_PREVIEW_ORIGIN', 'EZIL_PR_PREVIEW_LANE',
                                              'CHECKOUT_ENABLED', 'EZIL_AWS_COMPUTERS_ENABLED', 'EZIL_AWS_KILL_SWITCH')},
                         {'EZIL_DEPLOY_ENV': 'pr-preview', 'EZIL_PR_PREVIEW_ORIGIN': 'https://os-pv1.ezil.work',
                          'EZIL_PR_PREVIEW_LANE': 'pr-289', 'CHECKOUT_ENABLED': '0',
                          'EZIL_AWS_COMPUTERS_ENABLED': '0', 'EZIL_AWS_KILL_SWITCH': '1'})
        # Raw values survive byte-for-byte (Compose format: raw).
        self.assertEqual(env['SUPABASE_DATABASE_URL'], 'postgres://u:p$w@10.0.0.1:5432/db?x=#1')

    def test_shared_computers_keep_staging_computer_settings_but_never_cron(self):
        self.deploy(289, computers='shared')
        env = self.env_of(1)
        self.assertEqual((env['EZIL_AWS_COMPUTERS_ENABLED'], env['EZIL_AWS_KILL_SWITCH']), ('1', '0'))
        self.assertEqual(env['CLOUDFLARE_GUACAMOLE_HMAC_SECRET'], 'h' * 40)
        self.assertNotIn('CRON_SECRET', env)
        self.assertEqual(env['CHECKOUT_ENABLED'], '0')

    def test_wrong_health_sha_removes_the_slot(self):
        self.health = {p: {'ok': True, 'sha': SHA2} for p in ph.SLOTS.values()}
        with self.assertRaisesRegex(ph.PreviewError, 'did not report sha'):
            self.deploy(289)
        self.assertEqual(ph.read_receipts(), {})
        self.assertFalse((self.tmp / 'etc' / 'pv1.env').exists())
        self.assertTrue(any('down' in c for c in self.compose_calls()))

    def test_image_id_mismatch_is_refused_before_any_container_change(self):
        self.archive_id = 'sha256:' + 'c' * 64
        with self.assertRaisesRegex(ph.PreviewError, 'image ID differs'):
            self.deploy(289)
        self.assertEqual(self.compose_calls(), [])
        self.assertFalse((self.tmp / 'etc').exists())

    def test_argument_validation(self):
        bad = [['--tag', tag(290)], ['--tag', 'pr289-' + SHA2[:12]], ['--sha', SHA[:39]],
               ['--image-id', 'a' * 64], ['--ttl-hours', '73'], ['--ttl-hours', '0'], ['--pr', '0'],
               ['--run', '42; rm -rf /'], ['--bucket', 'Bad_Bucket'], ['--receipt-sha256', 'B' * 64]]
        for change in bad:
            args = {'--pr': '289', '--sha': SHA, '--tag': tag(289), '--image-id': IMAGE,
                    '--receipt-sha256': RECEIPT, '--bucket': BUCKET, '--run': '', '--ttl-hours': '48'}
            args[change[0]] = change[1]
            with self.subTest(change=change), self.assertRaises(ph.PreviewError):
                ph.main(['deploy', *[x for kv in args.items() for x in kv]])
        self.assertEqual(self.compose_calls(), [])


class Lifecycle(Host):
    def test_teardown_removes_only_that_pr(self):
        self.deploy(289)
        self.deploy(290)
        with mock.patch('sys.stdout'):
            ph.main(['teardown', '--pr', '289'])
        self.assertEqual({r['pr'] for r in ph.read_receipts().values()}, {290})
        self.assertFalse((self.tmp / 'etc' / 'pv1.env').exists())
        self.assertTrue((self.tmp / 'etc' / 'pv2.env').exists())

    def test_reaper_removes_only_expired_slots(self):
        self.deploy(289)
        self.deploy(290)
        receipt = json.loads(ph.receipt_path(2).read_text())
        receipt['expires_at'] = ph.iso(ph.now() - dt.timedelta(seconds=1))
        ph.receipt_path(2).write_text(json.dumps(receipt))
        with mock.patch('sys.stdout'):
            ph.main(['reap'])
        self.assertEqual({r['pr'] for r in ph.read_receipts().values()}, {289})

    def test_never_removes_the_staging_image_or_a_non_preview_tag(self):
        for victim in ('s9-20261108', 'latest', None, 'pr289-zzzzzzzzzzzz'):
            ph.remove_image(victim)
        (self.tmp / 'staging' / 'compose.env').write_text(f'OS_STAGING_TAG={tag(289)}\n')
        ph.remove_image(tag(289))
        self.assertFalse([c for c in self.calls if c[:3] == ['docker', 'image', 'rm']])

    def test_install_reaper_writes_an_hourly_timer(self):
        with mock.patch('sys.stdout'):
            ph.main(['install-reaper'])
        timer = (self.tmp / 'systemd' / 'ezil-os-preview-reap.timer').read_text()
        self.assertIn('OnCalendar=hourly', timer)
        self.assertIn(f'{self.tmp / "opt"}/preview_host.py reap',
                      (self.tmp / 'systemd' / 'ezil-os-preview-reap.service').read_text())
        self.assertIn(['systemctl', 'enable', '--now', 'ezil-os-preview-reap.timer'], self.calls)

    def test_project_names_never_alias_staging(self):
        with self.assertRaises(ph.PreviewError):
            ph.project(3)
        self.assertEqual([ph.project(s) for s in ph.SLOTS], ['ezil-os-preview-pv1', 'ezil-os-preview-pv2'])

    def test_multiline_env_values_are_refused(self):
        with self.assertRaises(ph.PreviewError):
            ph.preview_env({'A': 'x\ny'}, 1, 289, 'off')
        with self.assertRaises(ph.PreviewError):
            ph.parse_env('not a line\n')


class Failures(Host):
    def test_the_slot_is_claimed_with_a_short_expiry_before_the_container_starts(self):
        moment = ph.now()
        receipt = self.deploy(289)
        state, expires = self.at_up[1]
        self.assertEqual(state, 'starting')
        self.assertLessEqual(ph.parse_iso(expires) - moment, dt.timedelta(minutes=ph.STARTING_MINUTES, seconds=5))
        self.assertEqual(receipt['state'], 'serving')
        self.assertEqual(json.loads(ph.receipt_path(1).read_text())['state'], 'serving')

    def test_a_failure_before_the_slot_is_touched_keeps_the_old_head_serving(self):
        self.deploy(289)
        self.health = {p: {'ok': True, 'sha': SHA2} for p in ph.SLOTS.values()}
        self.fail_loaded = True
        self.calls.clear()
        with self.assertRaises(ValueError):
            self.deploy(289, SHA2)
        self.assertEqual(ph.read_receipts()[1]['sha'], SHA)
        self.assertTrue((self.tmp / 'etc' / 'pv1.env').exists())
        self.assertEqual(self.compose_calls(), [])
        self.assertEqual(self.removed_images(), [f'ezil-os-staging:{tag(289, SHA2)}'])

    def test_a_failure_after_the_slot_is_touched_removes_both_images(self):
        self.deploy(289)
        self.fail_up = True
        self.calls.clear()
        with self.assertRaises(subprocess.CalledProcessError):
            self.deploy(289, SHA2)
        self.assertEqual(ph.read_receipts(), {})
        self.assertFalse((self.tmp / 'etc' / 'pv1.env').exists())
        self.assertEqual(sorted(self.removed_images()),
                         sorted([f'ezil-os-staging:{tag(289)}', f'ezil-os-staging:{tag(289, SHA2)}']))

    def test_a_killed_redeploy_leaves_the_reaper_both_images(self):
        self.deploy(289)
        self.fail_up = True
        self.at_up = None

        def killed(args, **kwargs):
            if args[:2] == ['docker', 'compose'] and 'up' in args:
                self.starting = json.loads(ph.receipt_path(1).read_text())
                raise KeyboardInterrupt  # stands in for SIGTERM from the SSM timeout
            return self.fake_run(args, **kwargs)
        with mock.patch.object(ph, 'run', killed), self.assertRaises(KeyboardInterrupt):
            self.deploy(289, SHA2)
        self.assertEqual((self.starting['tag'], self.starting['previous_tag']), (tag(289, SHA2), tag(289)))
        # A real SIGTERM runs no cleanup: the starting receipt stays, and once it expires the reaper
        # must remove the replaced image as well as the new one.
        self.starting['expires_at'] = ph.iso(ph.now() - dt.timedelta(seconds=1))
        ph.write_receipt(1, self.starting)
        self.calls.clear()
        with mock.patch('sys.stdout'):
            ph.main(['reap'])
        self.assertEqual(sorted(self.removed_images()),
                         sorted([f'ezil-os-staging:{tag(289)}', f'ezil-os-staging:{tag(289, SHA2)}']))
        self.assertEqual(ph.read_receipts(), {})

    def test_a_failed_down_keeps_the_receipt_for_the_reaper_and_the_original_error(self):
        self.fail_up = True
        original = self.fake_run

        def down_fails(args, **kwargs):
            if 'down' in args:
                raise subprocess.CalledProcessError(2, args)
            return original(args, **kwargs)
        with mock.patch.object(ph, 'run', down_fails), self.assertRaises(subprocess.CalledProcessError) as caught:
            self.deploy(289)
        self.assertEqual(caught.exception.returncode, 1)
        self.assertEqual(ph.read_receipts()[1]['state'], 'starting')

    def test_image_id_is_optional_when_a_published_receipt_is_reused(self):
        receipt = self.deploy(289, image_id='')
        self.assertEqual(receipt['image_id'], IMAGE)

    def test_computers_off_also_drops_lifecycle_and_caller_roles(self):
        self.deploy(289)
        env = self.env_of(1)
        self.assertNotIn('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', env)
        self.assertNotIn('EZIL_AWS_APP_CALLER_ROLE_ARN_AP_SOUTH_1', env)

    def test_shared_computers_keep_lifecycle_and_caller_roles(self):
        self.deploy(289, computers='shared')
        env = self.env_of(1)
        self.assertEqual(env['EZIL_AWS_APP_CALLER_ROLE_ARN_AP_SOUTH_1'], 'arn:x')


class WaitHealthy(unittest.TestCase):
    def test_polls_until_the_exact_sha(self):
        answers = iter([OSError(), {'ok': True, 'sha': SHA2}, {'ok': True, 'sha': SHA}])

        def fetch(port):
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            return answer
        with mock.patch.object(ph, 'fetch_health', fetch), mock.patch.object(ph.time, 'sleep', lambda s: None):
            ph.wait_healthy(1, SHA)

    def test_times_out_without_echoing_bodies(self):
        with mock.patch.object(ph, 'fetch_health', lambda port: {'ok': True, 'sha': SHA2, 'x': 'secret'}), \
                mock.patch.object(ph.time, 'sleep', lambda s: None), \
                mock.patch.object(ph.time, 'monotonic', side_effect=[0, 1, 200]):
            with self.assertRaisesRegex(ph.PreviewError, f'sha={SHA2}') as caught:
                ph.wait_healthy(1, SHA)
        self.assertNotIn('secret', str(caught.exception))


AWS_SHIM = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
args, state = sys.argv[1:], pathlib.Path(os.environ["SHIM_STATE"])
with open(state / "log", "a") as log:
    log.write(json.dumps(args) + "\n")
if "describe-instances" in args:
    print(os.environ["FAKE_PIN"])
elif "send-command" in args:
    shutil.copyfile(args[args.index("--parameters") + 1][len("file://"):], state / "payload.json")
    print("command-1")
elif "--query" in args and args[args.index("--query") + 1] == "Status":
    print(os.environ.get("FAKE_STATUS", "Success"))
elif "head-object" in args:
    obj = pathlib.Path(os.environ["FAKE_S3"]) / pathlib.Path(args[args.index("--key") + 1]).name
    if not obj.exists():
        sys.exit(255)
    import hashlib
    print('"' + hashlib.md5(obj.read_bytes()).hexdigest() + '"')
elif "put-object" in args:
    obj = pathlib.Path(os.environ["FAKE_S3"]) / pathlib.Path(args[args.index("--key") + 1]).name
    if obj.exists():
        sys.exit(254)
    shutil.copyfile(args[args.index("--body") + 1], obj)
elif "cp" in args[:6]:
    src = pathlib.Path(os.environ["FAKE_S3"]) / pathlib.Path(args[args.index("cp") + 1]).name
    shutil.copyfile(src, args[args.index("cp") + 2])
else:
    print('noise line\nPREVIEW_RESULT {"command": "deploy"}\t')
'''
PIN = 'vpc-0f6bc19fdfd4209aa\tezil-os-billing-staging-host\tbilling-staging'


class Wrapper(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / 'bin').mkdir()
        shim = self.tmp / 'bin' / 'aws'
        shim.write_text(AWS_SHIM)
        shim.chmod(0o755)
        self.env = {**os.environ, 'PATH': f'{self.tmp / "bin"}:{os.environ["PATH"]}', 'SHIM_STATE': str(self.tmp),
                    'OS_STAGING_INSTANCE_ID': 'i-014810524754b9ed0', 'OS_STAGING_ARTIFACT_BUCKET': BUCKET,
                    'FAKE_PIN': PIN, 'FAKE_S3': str(self.tmp / 's3')}
        (self.tmp / 's3').mkdir()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp)

    def preview(self, *args, **env):
        return subprocess.run(['bash', str(HERE / 'preview.sh'), *args], env={**self.env, **env},
                              capture_output=True, text=True)

    def test_deploy_payload_carries_both_scripts_and_exact_args(self):
        result = self.preview('deploy', '289', SHA, tag(289), IMAGE, RECEIPT, '42-1')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PREVIEW_RESULT', result.stdout)
        self.assertNotIn('noise line', result.stdout)
        body = json.loads((self.tmp / 'payload.json').read_text())['commands'][0]
        self.assertIn((HERE / 'preview_host.py').read_text().rstrip('\n'), body)
        self.assertIn((HERE.parent / 'install_receipt.py').read_text().rstrip('\n'), body)
        self.assertIn(f'preview_host.py deploy --pr 289 --sha {SHA} --tag {tag(289)} --image-id {IMAGE} '
                      f'--receipt-sha256 {RECEIPT} --bucket {BUCKET} --run 42-1 --ttl-hours 48 --computers off', body)
        self.assertEqual(subprocess.run(['bash', '-n'], input=body, text=True).returncode, 0)

    def test_refuses_another_host_bucket_or_identity(self):
        cases = [({'OS_STAGING_INSTANCE_ID': 'i-09012068d96166828'}, 'pinned OS staging host'),
                 ({'OS_STAGING_ARTIFACT_BUCKET': 'ezil-main-prod-artifacts'}, 'pinned OS staging artifact bucket'),
                 ({'FAKE_PIN': 'vpc-x\tezil-main-prod\tproduction'}, 'identity/VPC mismatch'),
                 ({'OS_ENV': 'production'}, 'only on the staging host')]
        for env, message in cases:
            with self.subTest(env=env):
                result = self.preview('deploy', '289', SHA, tag(289), IMAGE, RECEIPT, **env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.tmp / 'payload.json').exists())

    def artifacts(self, t):
        directory = HERE.parent / 'artifacts'
        directory.mkdir(exist_ok=True)
        self.addCleanup(lambda: [f.unlink() for f in directory.glob(f'{t}.*')])
        for suffix, body in (('tar.gz', b'image'), ('runtime.tar.gz', b'runtime'), ('source.json', b'{"r":1}')):
            (directory / f'{t}.{suffix}').write_bytes(body)
        subprocess.run(f'sha256sum {t}.tar.gz {t}.runtime.tar.gz > {t}.sha256', shell=True, cwd=directory, check=True)
        return directory

    def test_publish_uploads_a_new_tag_with_the_marker_last(self):
        t = 'pr289-' + 'd' * 12
        directory = self.artifacts(t)
        result = self.preview('publish', t)
        self.assertEqual(result.returncode, 0, result.stderr)
        import hashlib
        self.assertIn(f"PUBLISHED mode=fresh receipt_sha256={hashlib.sha256(b'{\"r\":1}').hexdigest()}", result.stdout)
        puts = [json.loads(l) for l in (self.tmp / 'log').read_text().splitlines() if 'put-object' in l]
        self.assertEqual([p[p.index('--key') + 1].split(t)[1] for p in puts], ['.tar.gz', '.runtime.tar.gz', '.source.json', '.sha256'])
        self.assertTrue(all("--if-none-match" in p for p in puts))
        self.assertEqual((self.tmp / 's3' / f'{t}.tar.gz').read_bytes(), (directory / f'{t}.tar.gz').read_bytes())

    def test_publish_reuses_a_complete_tag_and_never_overwrites_it(self):
        t = 'pr289-' + 'e' * 12
        self.artifacts(t)
        (self.tmp / 's3' / f'{t}.sha256').write_text('marker')
        (self.tmp / 's3' / f'{t}.source.json').write_bytes(b'{"published":1}')
        result = self.preview('publish', t)
        self.assertEqual(result.returncode, 0, result.stderr)
        import hashlib
        self.assertIn(f"mode=reuse receipt_sha256={hashlib.sha256(b'{\"published\":1}').hexdigest()}", result.stdout)
        self.assertNotIn('put-object', (self.tmp / 'log').read_text())

    def test_publish_completes_a_matching_partial_upload_and_refuses_a_different_one(self):
        t = 'pr289-' + 'f' * 12
        directory = self.artifacts(t)
        (self.tmp / 's3' / f'{t}.tar.gz').write_bytes((directory / f'{t}.tar.gz').read_bytes())
        result = self.preview('publish', t)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('mode=fresh', result.stdout)
        for f in (self.tmp / 's3').iterdir():
            f.unlink()
        (self.tmp / 's3' / f'{t}.tar.gz').write_bytes(b'another build')
        result = self.preview('publish', t)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Partial upload', result.stderr)

    def test_host_failure_fails_the_wrapper(self):
        result = self.preview('teardown', '289', FAKE_STATUS='Failed')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('failed on the host', result.stderr)


if __name__ == '__main__':
    unittest.main()
