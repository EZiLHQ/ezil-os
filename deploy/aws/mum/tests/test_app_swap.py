#!/usr/bin/env python3
"""Fake-host tests for rebase_app_swap.py: no AWS, SSM, Docker, systemd or host side effects.

The generated install and probe payloads really execute here, with subprocess
replaced by an in-memory host. Passing proves the operator's local decisions,
not a real IAM, SSM-document or host fence.
"""
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
from rebase import TOOL, release_record
import rebase_app
import rebase_app_swap as ops
import rebase_manifest as manifest
import rebase_release as release
import rebase_ssm as ssm

REPO = HERE.parents[3]
JOBS = rebase_app.JOBS
# The Status filter values AWS ListCommands accepts (aws ssm list-commands help). Cancelling is not one.
LIST_COMMANDS_STATUS = ('Pending', 'InProgress', 'Success', 'Cancelled', 'Failed', 'TimedOut', 'AccessDenied',
                        'DeliveryTimedOut', 'ExecutionTimedOut', 'Incomplete', 'NoInstancesInTag', 'LimitExceeded')
OTHER = 'feedfeed-1111-4111-8111-111111111111'


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid',
                           '-c', 'commit.gpgsign=false', *args], check=True, capture_output=True, text=True).stdout.strip()


def tar_gz(members, directories=()):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as bundle:
        for name in directories:
            info = tarfile.TarInfo(name)
            info.type = tarfile.DIRTYPE
            bundle.addfile(info)
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            bundle.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


class App:
    """One whole-app artifact: a docker-save style archive, its checksum marker and identities."""
    def __init__(self, root, tag, sha, repo, repo_tags=None, index_name=None, revision=None, architecture='amd64',
                 index_entries=1, pad_index=0, runtime_extra=None):
        self.tag, self.sha = tag, sha
        config = json.dumps({'architecture': architecture, 'os': 'linux', 'config': {
            'Labels': {'org.opencontainers.image.revision': revision or sha, 'fixture.tag': tag}, 'Env': ['EZIL_GIT_SHA=' + sha]}}).encode()
        self.image = 'sha256:' + sha256(config)
        members = {'manifest.json': json.dumps([{'Config': 'blobs/sha256/' + sha256(config),
                                                 'RepoTags': repo_tags or ['ezil-os-staging:' + tag], 'Layers': []}]).encode(),
                   'blobs/sha256/' + sha256(config): config, 'oci-layout': b'{"imageLayoutVersion":"1.0.0"}'}
        if index_name or index_entries != 1 or pad_index:
            entry = {'annotations': {'io.containerd.image.name': index_name or 'docker.io/library/ezil-os-staging:' + tag}}
            members['index.json'] = json.dumps({'manifests': [entry] * index_entries, 'pad': ' ' * pad_index}).encode()
        self.archive = root / (tag + '.tar.gz')
        self.archive.write_bytes(tar_gz(members))
        runtime = {name: subprocess.run(['git', '-C', str(repo), 'show', sha + ':deploy/aws/os-staging/' + name],
                                        check=True, capture_output=True).stdout for name in ops.RUNTIME}
        runtime.update(runtime_extra or {})
        self.runtime = root / (tag + '.runtime.tar.gz')
        self.runtime.write_bytes(tar_gz(runtime, directories=('cron',)))
        self.marker = root / (tag + '.sha256')
        self.marker.write_text(f'{sha256(self.archive.read_bytes())}  {tag}.tar.gz\n{sha256(self.runtime.read_bytes())}  {tag}.runtime.tar.gz\n')
        self.checksum = sha256(self.marker.read_bytes())


class Host:
    def __init__(self, app, deployment):
        self.git_sha, self.image_id, self.compose_tag, self.deployment = app.sha, app.image, app.tag, deployment
        self.tags = {app.tag: app.image}
        self.timers = {job: {'enabled': 'enabled', 'active': 'active', 'service': 'inactive'} for job in JOBS}
        self.lock_free = True
        # Caddy -> web /api/health: serving, the SHA it reports when not the running app's, or a whole replacement body.
        self.serving, self.served_sha, self.health_body = True, None, None

    def systemctl(self, verb, unit):
        job, kind = unit[len('ezil-os-staging-'):].rsplit('.', 1)
        return self.timers[job]['enabled' if verb == 'is-enabled' else 'active' if kind == 'timer' else 'service']


def execute(payload, host, install):
    """Run the generated Python program; only subprocess IO is faked."""
    script = payload.split("<<'EZIL_APP_PY'\n", 1)[1].rsplit('\nEZIL_APP_PY', 1)[0]
    namespace = {}
    real_run = subprocess.run

    def done(code, out=''):
        return subprocess.CompletedProcess([], code, stdout=out, stderr='')

    def run(command, **kwargs):
        if command == ['bash', '-s']:
            assert kwargs['input'] == namespace['SCRIPT']
            return done(0 if install(namespace['APP']) else 1)
        if command[:6] == ['docker', 'compose', '--env-file', 'compose.env', 'exec', '-T']:
            assert kwargs['cwd'] == '/opt/ezil-os-staging'
            return real_run(['node', '-e', namespace['NODE']], capture_output=True, text=True, timeout=10,
                            env={'PATH': os.environ['PATH'], 'EZIL_GIT_SHA': host.git_sha, 'EZIL_AWS_KILL_SWITCH': '1',
                                 'EZIL_AWS_LIFECYCLE_DEPLOYMENTS': json.dumps({TOOL.REGION: host.deployment})})
        if command[:3] == ['docker', 'container', 'inspect']:
            return done(0, host.image_id + '\n')
        if command[:3] == ['docker', 'image', 'inspect']:
            tag = command[3].split(':', 1)[1]
            return done(0, host.tags[tag] + '\n') if tag in host.tags else done(1)
        if command == ['cat', 'compose.env']:
            return done(0, 'OS_STAGING_TAG=' + host.compose_tag + '\n')
        if command[0] == 'systemctl':
            return done(0, host.systemctl(command[1], command[2]) + '\n')
        if command[:2] == ['flock', '-n']:
            return done(0 if host.lock_free else 1)
        if command[0] == 'curl':
            # Through the host's Caddy with certificate verification (no -k), to the public health route.
            assert command[-3:] == ['--resolve', 'os-staging.ezil.work:443:127.0.0.1', 'https://os-staging.ezil.work/api/health'], command
            assert '-k' not in command and '--insecure' not in command and '-fsS' in command
            body = host.health_body if host.health_body is not None else json.dumps({'ok': True, 'sha': host.served_sha or host.git_sha})
            return done(0, body) if host.serving else done(22)
        raise AssertionError(command)

    with patch('subprocess.run', side_effect=run), patch('sys.stdout', new_callable=io.StringIO) as output, \
            patch('sys.stderr', new_callable=io.StringIO):
        try:
            exec(compile(script, 'generated-payload', 'exec'), namespace)
        except SystemExit:
            return {'Status': 'Failed', 'ResponseCode': 1, 'StandardOutputContent': ''}
    return {'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': output.getvalue()}


class AppSwapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'source'
        git(self.root, 'init', '-q', str(self.repo))
        for name, text in (('infra/host-agent/agent.txt', 'agent\n'), ('shell/ezil/apps/code.js', 'old\n'),
                           ('app/public/os/bundle.min.js', 'old\n'), ('worker/bridge.js', 'bridge\n'),
                           *(('deploy/aws/os-staging/' + n, (REPO / 'deploy/aws/os-staging' / n).read_text()) for n in ops.RUNTIME)):
            (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
            (self.repo / name).write_text(text)
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-qm', 'agent')
        self.agent = git(self.repo, 'rev-parse', 'HEAD')
        for name in ('shell/ezil/apps/code.js', 'app/public/os/bundle.min.js'):
            (self.repo / name).write_text('folder fix\n')
        git(self.repo, 'commit', '-qam', 'candidate')
        self.candidate_sha = git(self.repo, 'rev-parse', 'HEAD')
        (self.repo / 'worker/bridge.js').write_text('changed\n')
        git(self.repo, 'commit', '-qam', 'worker change')
        self.worker_sha = git(self.repo, 'rev-parse', 'HEAD')
        artifacts = self.root / 'artifacts'
        artifacts.mkdir()
        self.old = App(artifacts, 'old-app', self.agent, self.repo)
        self.new = App(artifacts, 'new-app', self.candidate_sha, self.repo)
        checkout = self.root / 'checkout'
        installer = checkout / ops.INSTALLER
        installer.parent.mkdir(parents=True)
        installer.write_text((REPO / ops.INSTALLER).read_text())
        self.installer_sha = sha256(installer.read_bytes())
        self.ledger = self.root / 'releases/promotion-ledger.json'
        self.ledger.parent.mkdir()
        record = release_record()
        self.envelope = {'VersionId': 'v1', 'SecretString': json.dumps(
            {'EZIL_AWS_KILL_SWITCH': '1', TOOL.KEY: {TOOL.REGION: dict(record, releases=[record])}})}
        _, d = release.secret_deployment(self.envelope)
        self.host = Host(self.old, copy.deepcopy(d))
        TOOL.write(self.ledger, {'schemaVersion': 1, 'entries': [{
            'generation': 1, 'planSha256': '0' * 64, 'operation': 'promote-canary', 'state': 'completed',
            **release.observed_state(self.envelope, d, self.agent)}]})
        self.calls, self.payloads, self.commands, self.results = [], {}, {}, {}
        self.in_flight, self.install_mode, self.lose_reply, self.crash_poll, self.probe_hooks = [], 'success', False, False, {}
        self.listing_extra = {}
        patches = [patch.object(release, 'REPO', checkout), patch.object(release, 'aws', self.aws),
                   patch.object(release.json_tool, 'APP_SECRET_LOCK', str(self.root / 'app-secret.lock')),
                   patch.object(release.json_tool, 'secret_aws', self.secret_aws), patch('sys.stdout', new_callable=io.StringIO)]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)

    # ---- fakes -------------------------------------------------------------------------
    def secret_aws(self, args, payload=None, lock_fd=None):
        self.assertIsNotNone(lock_fd)
        self.assertEqual(args[0], 'get-secret-value')
        self.calls.append(('secret', 'get-secret-value'))
        return copy.deepcopy(self.envelope)

    def install(self, app):
        # The installer only ever runs while this operation's pending fence is durable.
        self.assertEqual(release.load_ledger(self.ledger)['entries'][-1]['state'], 'pending')
        target = self.new if app['gitSha'] == self.new.sha else self.old
        mode = self.install_mode
        if mode in ('timers-stopped', 'partial', 'compose-written'):
            for timer in self.host.timers.values():
                timer['active'] = 'inactive'
        if mode == 'compose-written':
            # install-host.sh rewrites compose.env before `up`; a failure between them leaves the old container.
            self.host.compose_tag = target.tag
        if mode in ('success', 'partial', 'wrong-image'):
            self.host.git_sha, self.host.image_id, self.host.compose_tag = target.sha, target.image, target.tag
            self.host.tags[target.tag] = target.image
        if mode == 'wrong-image':
            # Same Git SHA label, different image: only the image-ID readback can tell.
            self.host.image_id = 'sha256:' + '6' * 64
        return mode in ('success', 'wrong-image')

    def aws(self, *args):
        self.calls.append(args)
        service, operation = args[:2]

        def flag(name):
            return args[args.index(name) + 1]
        if service == 'sts':
            return {'Account': TOOL.ACCOUNT}
        if service == 'ec2':
            return {'Reservations': [{'Instances': [{'InstanceId': ssm.HOST, 'State': {'Name': 'running'}, 'Tags': [
                {'Key': 'ezil:purpose', 'Value': 'os-staging'}, {'Key': 'ezil:env', 'Value': 'billing-staging'}]}]}]}
        if service == 's3api':
            if operation == 'put-object':
                self.payloads[flag('--key')] = Path(flag('--body')).read_text()
            return {}
        if operation == 'send-command':
            command_id = f'{len(self.commands) + 1:08x}-1111-4111-8111-111111111111'
            comment = flag('--comment')
            self.commands[command_id] = comment
            payload = next(body for key, body in self.payloads.items() if key.rsplit('/', 1)[-1][:32] in comment)
            for marker, hook in self.probe_hooks.items():
                if marker in comment:
                    hook()
            self.results[command_id] = execute(payload, self.host, self.install)
            if self.lose_reply and self.is_install(comment):
                self.lose_reply = False
                raise TimeoutError('lost send reply')
            return {'Command': {'CommandId': command_id}}
        if operation == 'get-command-invocation':
            if self.crash_poll and self.is_install(self.commands[flag('--command-id')]):
                self.crash_poll = False
                raise TimeoutError('operator crashed while polling')
            return copy.deepcopy(self.results[flag('--command-id')])
        if operation == 'list-commands':
            if '--command-id' in args:
                command_id = flag('--command-id')
                return {'Commands': [{'CommandId': command_id, 'Status': self.results[command_id]['Status']}]}
            filters = json.loads(flag('--filters'))
            self.assertEqual(len(filters), 1)
            key, value = filters[0]['key'], filters[0]['value']
            # AWS ListCommands: no node ID with Status=Pending; only these Status/ExecutionStage values.
            if key == 'Status' and (value not in LIST_COMMANDS_STATUS or (value == 'Pending' and '--instance-id' in args)):
                raise ValueError('InvalidFilter: rejected by AWS ListCommands')
            if key == 'ExecutionStage' and value not in ('Executing', 'Complete'):
                raise ValueError('InvalidFilterValue: rejected by AWS ListCommands')
            if key in ('Status', 'ExecutionStage'):
                # Executing is a running command, including one being cancelled; this fake keeps Pending out of it.
                stage = {'InProgress': 'Executing', 'Cancelling': 'Executing', 'Pending': None}
                listed = [(c, ids) for c, status, ids in self.in_flight
                          if (status == value if key == 'Status' else stage.get(status, 'Complete') == value)
                          and ('--instance-id' not in args or flag('--instance-id') in ids)]
                return {'Commands': [{'CommandId': c, 'InstanceIds': ids} for c, ids in listed], **self.listing_extra}
            return {'Commands': [{'CommandId': c, 'Comment': comment, 'InstanceIds': [ssm.HOST]} for c, comment in self.commands.items()]}
        raise AssertionError(args)

    @staticmethod
    def is_install(comment):
        return comment.startswith(('ezil-rebase-app-swap-g', 'ezil-rebase-app-restore-g'))

    def installs(self):
        return [c for c in self.calls if c[:2] == ('ssm', 'send-command') and self.is_install(c[c.index('--comment') + 1])]

    # ---- helpers -----------------------------------------------------------------------
    def plan(self, name, source, target, generation=1, operation='app-swap', undoes=None, agent=None, check=True, **extra):
        directory = self.root / name
        directory.mkdir()
        path = directory / 'app-plan.json'
        TOOL.write(path, {'schemaVersion': 1, 'operation': operation, 'ledgerGeneration': generation, 'agentCommit': agent or self.agent,
                          'from': {'tag': source.tag, 'gitSha': source.sha, 'imageId': source.image},
                          'to': {'tag': target.tag, 'gitSha': target.sha, 'imageId': target.image, 'checksumSha256': target.checksum},
                          'undoes': undoes, 'installerSha256': self.installer_sha, **extra})
        if check:
            ops.archive_check(path, target.archive, target.marker, target.runtime, self.repo, True)
        return path

    def entries(self):
        return release.load_ledger(self.ledger)['entries']

    def assert_refused_before_pending(self, message, path, **kwargs):
        before, host = self.ledger.read_bytes(), copy.deepcopy(self.host.__dict__)
        with self.assertRaisesRegex(ValueError, message):
            ops.swap(path, self.repo, True, self.ledger, **kwargs)
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(self.installs(), [])
        self.assertEqual(self.host.__dict__, host)

    # ---- archive preflight ---------------------------------------------------------------
    def test_archive_check_pins_marker_bytes_tag_and_image_id(self):
        path = self.plan('swap', self.old, self.new, check=False)
        with self.assertRaisesRegex(ValueError, 'archive receipt missing'):
            ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(self.calls, [])
        ops.archive_check(path, self.new.archive, self.new.marker, self.new.runtime, self.repo, False)
        self.assertFalse(ops.receipt_path(path).exists())
        receipt = ops.archive_check(path, self.new.archive, self.new.marker, self.new.runtime, self.repo, True)
        self.assertEqual(manifest.read(ops.receipt_path(path)), receipt)
        self.assertEqual(receipt['archiveSha256'], sha256(self.new.archive.read_bytes()))
        with self.assertRaisesRegex(ValueError, 'checksum marker differs'):
            ops.archive_check(path, self.new.archive, self.old.marker, self.new.runtime, self.repo, False)
        # (options, refusal, pin the plan to the good image ID so only the image check can refuse)
        cases = ((dict(repo_tags=['ezil-os-staging:new-app', 'ezil-os-staging:old-app']), 'unexpected name', False),
                 (dict(index_name='docker.io/library/ezil-os-staging:old-app'), 'unexpected name', False),
                 (dict(sha=self.worker_sha), 'image ID differs', True),
                 (dict(revision=self.worker_sha), 'revision differs from approved source', False),
                 (dict(architecture='arm64'), 'Wrong image architecture', False),
                 (dict(index_entries=2), 'invalid archive index', False),
                 # A >1 MiB index naming another tag must be refused, not skipped.
                 (dict(index_name='docker.io/library/ezil-os-staging:old-app', pad_index=ops.SMALL), 'not inspectable', False),
                 (dict(runtime_extra={'cron/extra.timer': b'x'}), 'invalid runtime archive members', False),
                 (dict(runtime_extra={'render-env.py': b'import os\n'}), 'runtime archive differs from the baked source', False))
        for number, (options, message, pin_good_image) in enumerate(cases):
            bad = self.root / f'bad-{number}'
            bad.mkdir()
            app = App(bad, 'new-app', options.pop('sha', self.candidate_sha), self.repo, **options)
            # The marker is re-pinned to the bad archive, so only the tag/image rules can refuse it.
            path = self.plan(f'bad-plan-{number}', self.old, app, check=False)
            if pin_good_image:
                plan = manifest.read(path)
                plan['to'].update(gitSha=self.new.sha, imageId=self.new.image)
                TOOL.write(path, plan)
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                ops.archive_check(path, app.archive, app.marker, app.runtime, self.repo, True)
            self.assertFalse(ops.receipt_path(path).exists())
        # Same runtime members, different bytes from the marker's pin.
        runtime = self.new.runtime.read_bytes()
        members = {}
        with tarfile.open(self.new.runtime) as bundle:
            for member in bundle.getmembers():
                if member.isfile():
                    members[member.name] = bundle.extractfile(member).read()
        self.new.runtime.write_bytes(tar_gz(members))
        with self.assertRaisesRegex(ValueError, 'runtime archive differs from the checksum marker'):
            ops.archive_check(self.plan('runtime-bytes', self.old, self.new, check=False), self.new.archive, self.new.marker, self.new.runtime, self.repo, True)
        self.new.runtime.write_bytes(runtime)
        swapped = self.plan('swapped-bytes', self.old, self.new, check=False)
        self.old.archive.replace(self.new.archive)
        with self.assertRaisesRegex(ValueError, 'differs from the checksum marker'):
            ops.archive_check(swapped, self.new.archive, self.new.marker, self.new.runtime, self.repo, True)

    # ---- forward swap --------------------------------------------------------------------
    def test_dry_run_then_one_send_completes_with_gate_closed(self):
        path = self.plan('swap', self.old, self.new)
        before = self.ledger.read_bytes()
        ops.swap(path, self.repo, False, self.ledger)
        self.assertEqual(self.ledger.read_bytes(), before)
        # A dry run reads only the app secret, under the lock: no SSM, S3 or ledger write.
        self.assertEqual(self.calls, [('secret', 'get-secret-value')])
        self.calls.clear()
        ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 1)
        pending, completed = self.entries()[1:]
        self.assertEqual((pending['state'], completed['state'], completed['operation']), ('pending', 'completed', 'app-swap'))
        self.assertEqual((completed['appGitSha'], completed['appImageId']), (self.new.sha, self.new.image))
        self.assertEqual((pending['before']['appGitSha'], pending['before']['appImageId']), (self.old.sha, self.old.image))
        self.assertEqual(completed['tuple'], pending['before']['tuple'])
        self.assertEqual(completed['registrySha256'], pending['before']['registrySha256'])
        self.assertTrue(all(t['enabled'] == 'enabled' and t['active'] == 'active' for t in self.host.timers.values()))
        self.assertEqual(json.loads(self.envelope['SecretString'])['EZIL_AWS_KILL_SWITCH'], '1')
        with self.assertRaisesRegex(ValueError, 'stale plan'):
            ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 1)

    def test_source_outside_shell_allowlist_refused_before_any_aws_call(self):
        worker = App(self.root / 'artifacts', 'worker-app', self.worker_sha, self.repo)
        self.assert_refused_before_pending('outside the shell bundle allowlist', self.plan('worker', self.old, worker))
        self.assertEqual(self.calls, [])
        self.assert_refused_before_pending('outside the shell bundle allowlist', self.plan('agent', self.old, self.new, agent=self.worker_sha))
        self.assertEqual(self.calls, [])

    def test_installer_drift_stale_generation_and_live_drift_refused(self):
        path = self.plan('installer', self.old, self.new)
        (release.REPO / ops.INSTALLER).write_text('changed\n')
        self.assert_refused_before_pending('installer changed', path)
        (release.REPO / ops.INSTALLER).write_text((REPO / ops.INSTALLER).read_text())
        self.assert_refused_before_pending('stale plan', self.plan('stale', self.old, self.new, generation=2))
        self.host.image_id = 'sha256:' + '7' * 64
        self.assert_refused_before_pending('before-state', self.plan('live', self.old, self.new))

    def test_host_not_quiescent_or_tag_collision_refused_before_pending(self):
        path = self.plan('swap', self.old, self.new)
        for setup, message in ((lambda: setattr(self.host, 'lock_free', False), 'not quiescent'),
                               (lambda: self.host.timers['sandbox-reap'].update(service='activating'), 'not quiescent'),
                               (lambda: self.in_flight.append((OTHER, 'InProgress', [ssm.HOST])), 'not quiescent'),
                               (lambda: self.host.tags.update({'new-app': 'sha256:' + '9' * 64}), 'tag already names another image'),
                               (lambda: self.host.timers['aws-reconcile'].update(enabled='disabled'), 'before-state')):
            host, in_flight = copy.deepcopy(self.host), list(self.in_flight)
            setup()
            with self.subTest(message=message):
                self.assert_refused_before_pending(message, path)
            self.host, self.in_flight = host, in_flight

    # ---- the pending fence ---------------------------------------------------------------
    def leave_pending(self):
        path = self.plan('swap', self.old, self.new)
        self.install_mode = 'failure'
        with self.assertRaisesRegex(ValueError, 'one-shot SSM command failed'):
            ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        return path

    def test_pending_app_operation_fences_ledger_tools_and_older_tooling(self):
        self.leave_pending()
        other = self.root / 'other-plan.json'
        other.write_text('{}')
        _, d = release.secret_deployment(self.envelope)
        with self.assertRaisesRegex(ValueError, 'pending operation of another plan'):
            release.ledger_admit(self.ledger, other, {}, self.envelope, d, 'apply-app')
        with self.assertRaisesRegex(ValueError, 'requires a completed latest entry'):
            release.ledger_adopt_app(self.new.sha, self.repo, False, self.ledger)
        with patch.object(release, 'load_plan', return_value={}), patch.object(release, 'digest', return_value=self.entries()[-1]['planSha256']):
            with self.assertRaisesRegex(ValueError, 'run app-swap-reconcile'):
                release.ledger_reconcile(other, False, self.ledger)
        competing = self.plan('competing', self.old, App(self.root / 'artifacts', 'third-app', self.candidate_sha, self.repo))
        with self.assertRaisesRegex(ValueError, 'pending operation of another plan'):
            ops.swap(competing, self.repo, True, self.ledger)

    def test_tooling_before_app_operations_refuses_the_ledger(self):
        # The staging base this change applies to carries the pre-app-operation rebase_release.py.
        old = subprocess.run(['git', '-C', str(REPO), 'show', '9e3dd5f3d54921df9ce28ae960e5023041750bbd:deploy/aws/mum/rebase_release.py'],
                             capture_output=True, text=True)
        if old.returncode:
            self.skipTest('pre-change rebase_release.py needs a Git checkout containing the staging base')
        self.leave_pending()
        # Tooling from before this change refuses the unknown operation instead of ignoring it.
        old_source = self.root / 'old/old_rebase_release.py'
        old_source.parent.mkdir()
        (old_source.parent / 'json-tool.py').write_text((HERE.parent / 'json-tool.py').read_text())
        old_source.write_text(old.stdout)
        import importlib.util
        spec = importlib.util.spec_from_file_location('old_rebase_release', old_source)
        old = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(old)
        with self.assertRaisesRegex(ValueError, 'invalid (ledger entry|pending snapshots)'):
            old.load_ledger(self.ledger)

    def test_lost_send_reply_reconciles_by_comment_without_resend(self):
        path = self.plan('swap', self.old, self.new)
        self.lose_reply = True
        with self.assertRaises(TimeoutError):
            ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 1)
        self.assertEqual(self.entries()[-1]['state'], 'completed')

    def test_crash_while_polling_resumes_same_command(self):
        path = self.plan('swap', self.old, self.new)
        self.crash_poll = True
        with self.assertRaises(TimeoutError):
            ops.swap(path, self.repo, True, self.ledger)
        ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 1)
        self.assertEqual(self.entries()[-1]['state'], 'completed')

    def test_lost_completion_append_resumes_without_resend(self):
        path = self.plan('swap', self.old, self.new)
        with patch.object(ops, 'terminal', side_effect=OSError('crash before append')):
            with self.assertRaises(OSError):
                ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 1)
        self.assertEqual(self.entries()[-1]['state'], 'completed')

    def test_terminal_failure_never_resends_and_aborts_only_when_quiescent(self):
        path = self.leave_pending()
        with self.assertRaisesRegex(ValueError, 'never resubmit'):
            ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 1)
        ops.reconcile(path, False, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        for setup in (lambda: setattr(self.host, 'lock_free', False),
                      lambda: self.in_flight.append((OTHER, 'InProgress', [ssm.HOST]))):
            host, in_flight = copy.deepcopy(self.host), list(self.in_flight)
            setup()
            with self.assertRaisesRegex(ValueError, 'not proven quiescent'):
                ops.reconcile(path, True, self.ledger)
            self.assertEqual(self.entries()[-1]['state'], 'pending')
            self.host, self.in_flight = host, in_flight
        ops.reconcile(path, True, self.ledger)
        aborted = self.entries()[-1]
        self.assertEqual((aborted['state'], aborted['appGitSha'], aborted['appImageId']), ('aborted', self.old.sha, self.old.image))
        self.assertEqual(len(self.installs()), 1)
        with self.assertRaisesRegex(ValueError, 'stale plan'):
            ops.swap(path, self.repo, True, self.ledger)
        # A new attempt is a new reviewed plan at the new generation.
        self.install_mode = 'success'
        ops.swap(self.plan('retry', self.old, self.new, generation=3), self.repo, True, self.ledger)
        self.assertEqual(len(self.installs()), 2)
        self.assertEqual(self.entries()[-1]['state'], 'completed')

    def test_stopped_timers_or_third_state_require_manual_reconciliation(self):
        for mode in ('timers-stopped', 'partial'):
            with self.subTest(mode=mode):
                self.setUp()
                path = self.plan('swap', self.old, self.new)
                self.install_mode = mode
                with self.assertRaisesRegex(ValueError, 'one-shot SSM command failed'):
                    ops.swap(path, self.repo, True, self.ledger)
                with self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
                    ops.reconcile(path, True, self.ledger)
                self.assertEqual(self.entries()[-1]['state'], 'pending')
                self.assertIn('"timersNotRunning": ["aws-reconcile"', sys.stdout.getvalue())
                # The owner restores the recorded timer state; only then does the fence close.
                for timer in self.host.timers.values():
                    timer['active'] = 'active'
                ops.reconcile(path, True, self.ledger)
                self.assertEqual(self.entries()[-1]['state'], 'aborted' if mode == 'timers-stopped' else 'completed')
                self.assertEqual(len(self.installs()), 1)

    def test_reported_success_with_wrong_image_retains_fence(self):
        path = self.plan('swap', self.old, self.new)
        self.install_mode = 'wrong-image'
        with self.assertRaisesRegex(ValueError, 'post-install state differs'):
            ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        with self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
            ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        self.assertEqual(len(self.installs()), 1)

    def test_reconcile_requires_both_probes_quiescent_and_stable(self):
        path = self.leave_pending()
        cases = ((('-reconcile-a-', '-reconcile-b-'), lambda: setattr(self.host, 'lock_free', False), lambda: setattr(self.host, 'lock_free', True)),
                 ('-reconcile-b-', lambda: self.host.timers['pool-replenish'].update(service='activating'),
                  lambda: self.host.timers['pool-replenish'].update(service='inactive')),
                 # The image changes between the two probes: activity is ongoing.
                 ('-reconcile-b-', lambda: setattr(self.host, 'image_id', 'sha256:' + '5' * 64),
                  lambda: setattr(self.host, 'image_id', self.old.image)))
        for marker, before, after in cases:
            # A tuple sets the condition for the first probe only and clears it before the second.
            self.probe_hooks = {marker[0]: before, marker[1]: after} if isinstance(marker, tuple) else {marker: before}
            with self.assertRaisesRegex(ValueError, 'not proven quiescent'):
                ops.reconcile(path, True, self.ledger)
            self.assertEqual(self.entries()[-1]['state'], 'pending')
            after()
        self.probe_hooks = {}
        ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'aborted')

    def test_compose_env_left_on_candidate_blocks_abort(self):
        path = self.plan('swap', self.old, self.new)
        self.install_mode = 'compose-written'
        with self.assertRaisesRegex(ValueError, 'one-shot SSM command failed'):
            ops.swap(path, self.repo, True, self.ledger)
        for timer in self.host.timers.values():
            timer['active'] = 'active'
        with self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
            ops.reconcile(path, True, self.ledger)
        self.assertIn('"composeTag": {"before": "old-app", "expected": "new-app", "live": "new-app"}', sys.stdout.getvalue())
        self.host.compose_tag = self.old.tag
        ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'aborted')

    # ---- review regressions ----------------------------------------------------------------
    def test_secret_rotation_while_pending_blocks_resume_and_reconcile(self):
        path = self.plan('swap', self.old, self.new)
        with patch.object(ops, 'terminal', side_effect=OSError('crash before append')):
            with self.assertRaises(OSError):
                ops.swap(path, self.repo, True, self.ledger)
        before = self.ledger.read_bytes()
        self.assertEqual(self.entries()[-1]['before']['secretVersionId'], 'v1')
        # Same tuple and registry, new version: the installer would re-render from it.
        self.envelope['VersionId'] = 'v2'
        for action in (lambda: ops.swap(path, self.repo, True, self.ledger), lambda: ops.swap(path, self.repo, False, self.ledger),
                       lambda: ops.reconcile(path, True, self.ledger), lambda: ops.reconcile(path, False, self.ledger)):
            self.calls.clear()
            with self.assertRaisesRegex(ValueError, 'app secret changed while pending; manual reconciliation required'):
                action()
            self.assertEqual(self.ledger.read_bytes(), before)
            # Refused before any probe, install or upload.
            self.assertFalse(any(c[:2] in (('ssm', 'send-command'), ('s3api', 'put-object')) for c in self.calls))
        self.envelope['VersionId'] = 'v1'
        ops.swap(path, self.repo, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'completed')
        # Every install ever sent, across the cleared call logs.
        self.assertEqual(sum(map(self.is_install, self.commands.values())), 1)

    def test_in_flight_check_uses_only_supported_list_commands_queries(self):
        # The fake rejects what AWS rejects: a node ID with Status=Pending, and a Cancelling filter.
        for args in (('--instance-id', ssm.HOST, '--filters', json.dumps([{'key': 'Status', 'value': 'Pending'}])),
                     ('--filters', json.dumps([{'key': 'Status', 'value': 'Cancelling'}]))):
            with self.assertRaisesRegex(ValueError, 'InvalidFilter'):
                self.aws('ssm', 'list-commands', *args)
        self.calls.clear()
        self.assertFalse(ops.other_in_flight())
        queries = [c for c in self.calls if c[:2] == ('ssm', 'list-commands')]
        self.assertEqual([json.loads(c[c.index('--filters') + 1]) for c in queries],
                         [[{'key': 'ExecutionStage', 'value': 'Executing'}], [{'key': 'Status', 'value': 'Pending'}]])
        self.assertTrue(all('--instance-id' not in c for c in queries))
        elsewhere = ['i-0123456789abcdef0']
        for status, targets, expected in (('InProgress', [ssm.HOST], True), ('Cancelling', [ssm.HOST], True),
                                          ('Pending', [ssm.HOST], True), ('InProgress', [ssm.HOST, *elsewhere], True),
                                          ('InProgress', elsewhere, False), ('Pending', elsewhere, False),
                                          # Addressed by Targets: no instance IDs, so it cannot be ruled out.
                                          ('Pending', [], True), ('Cancelling', [], True), ('Success', [ssm.HOST], False)):
            self.in_flight = [(OTHER, status, targets)]
            with self.subTest(status=status, targets=targets):
                self.assertEqual(ops.other_in_flight(), expected)
        self.in_flight, self.listing_extra = [], {'NextToken': 'more'}
        with self.assertRaisesRegex(ValueError, 'incomplete SSM listing'):
            ops.other_in_flight()
        self.listing_extra = {}
        # A command running on another instance does not hold up this host.
        self.in_flight = [(OTHER, 'InProgress', elsewhere)]
        ops.swap(self.plan('swap', self.old, self.new), self.repo, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'completed')

    def test_moved_tag_blocks_admission_and_completion(self):
        moved = 'sha256:' + '4' * 64
        # The old tag no longer names the running image: a restart would run something else.
        self.host.tags['old-app'] = moved
        self.assert_refused_before_pending('before-state', self.plan('before', self.old, self.new))
        self.host.tags['old-app'] = self.old.image
        path = self.plan('swap', self.old, self.new)
        # A concurrent load moves the candidate tag after the container was created.
        self.probe_hooks = {'-after-': lambda: self.host.tags.update({'new-app': moved})}
        with self.assertRaisesRegex(ValueError, 'post-install state differs'):
            ops.swap(path, self.repo, True, self.ledger)
        self.probe_hooks = {}
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        self.assertEqual((self.host.git_sha, self.host.image_id, self.host.compose_tag), (self.new.sha, self.new.image, self.new.tag))
        with self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
            ops.reconcile(path, True, self.ledger)
        self.assertIn('"composeImageId": {"before": false, "expected": false}', sys.stdout.getvalue())
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        self.host.tags['new-app'] = self.new.image
        ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'completed')
        self.assertEqual(len(self.installs()), 1)

    def test_moved_old_tag_blocks_abort(self):
        path = self.leave_pending()
        self.host.tags['old-app'] = 'sha256:' + '4' * 64
        with self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
            ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        self.host.tags['old-app'] = self.old.image
        ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'aborted')

    def test_served_health_required_before_admission_and_terminal_rows(self):
        path = self.plan('swap', self.old, self.new)
        for setup in (lambda: setattr(self.host, 'serving', False), lambda: setattr(self.host, 'served_sha', self.worker_sha)):
            host = copy.deepcopy(self.host)
            setup()
            self.assert_refused_before_pending('before-state', path)
            self.host = host
        # The web container runs the candidate, but Caddy/Next is not serving after the forced recreate.
        self.probe_hooks = {'-after-': lambda: setattr(self.host, 'serving', False)}
        with self.assertRaisesRegex(ValueError, 'post-install state differs'):
            ops.swap(path, self.repo, True, self.ledger)
        self.probe_hooks = {}
        self.assertEqual(self.entries()[-1]['state'], 'pending')
        with self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
            ops.reconcile(path, True, self.ledger)
        self.assertIn(f'"servedSha": {{"before": "{self.old.sha}", "expected": "{self.new.sha}", "live": null}}', sys.stdout.getvalue())
        # Serving again, but a stale app answers, the app reports itself not ok, or the body is not JSON.
        self.host.serving = True
        for served_sha, body in ((self.old.sha, None), (None, json.dumps({'ok': False, 'sha': self.new.sha})),
                                 (None, json.dumps({'ok': 'true', 'sha': self.new.sha})), (None, '<html>502</html>')):
            self.host.served_sha, self.host.health_body = served_sha, body
            with self.subTest(served_sha=served_sha, body=body), self.assertRaisesRegex(ValueError, 'manual reconciliation required'):
                ops.reconcile(path, True, self.ledger)
            self.assertEqual(self.entries()[-1]['state'], 'pending')
        self.host.served_sha, self.host.health_body = None, None
        ops.reconcile(path, True, self.ledger)
        self.assertEqual(self.entries()[-1]['state'], 'completed')
        self.assertEqual(len(self.installs()), 1)

    # ---- restore ---------------------------------------------------------------------------
    def test_restore_is_its_own_ledger_valid_operation(self):
        swap_path = self.plan('swap', self.old, self.new)
        ops.swap(swap_path, self.repo, True, self.ledger)
        swap_sha = release.digest(swap_path)
        with self.assertRaisesRegex(ValueError, 'must undo the latest completed app-swap'):
            ops.swap(self.plan('wrong-link', self.new, self.old, generation=3, operation='app-restore', undoes='1' * 64), self.repo, True, self.ledger)
        other = App(self.root / 'artifacts', 'other-old', self.agent, self.repo)
        with self.assertRaisesRegex(ValueError, 'must undo the latest completed app-swap'):
            ops.swap(self.plan('wrong-image', self.new, other, generation=3, operation='app-restore', undoes=swap_sha), self.repo, True, self.ledger)
        with self.assertRaisesRegex(ValueError, 'adopt|forward descendant'):
            release.ledger_adopt_app(self.old.sha, self.repo, True, self.ledger)
        restore = self.plan('restore', self.new, self.old, generation=3, operation='app-restore', undoes=swap_sha)
        ops.swap(restore, self.repo, True, self.ledger)
        latest = self.entries()[-1]
        self.assertEqual((latest['operation'], latest['state'], latest['appGitSha'], latest['appImageId']),
                         ('app-restore', 'completed', self.old.sha, self.old.image))
        self.assertEqual((self.host.git_sha, self.host.image_id), (self.old.sha, self.old.image))
        self.assertEqual(len(self.installs()), 2)
        with self.assertRaisesRegex(ValueError, 'stale plan'):
            ops.swap(restore, self.repo, True, self.ledger)

    # ---- ledger schema ---------------------------------------------------------------------
    def test_ledger_schema_binds_app_operations(self):
        ops.swap(self.plan('swap', self.old, self.new), self.repo, True, self.ledger)
        valid = manifest.read(self.ledger)
        release.validate_ledger(valid)
        mutations = (
            (1, lambda e: e['expected']['tuple'].update(amiId='ami-' + '9' * 17), 'change only app identity'),
            (1, lambda e: e['expected'].update(registrySha256='9' * 64), 'change only app identity'),
            (1, lambda e: e['expected'].update(appImageId=e['before']['appImageId']), 'change only app identity'),
            (1, lambda e: e['before'].update(appGitSha='9' * 40), 'registry baseline'),
            (1, lambda e: e['before'].pop('appImageId'), 'invalid app operation snapshots'),
            (2, lambda e: e.update(appImageId='sha256:' + '9' * 64), 'terminal state mismatch'),
            (2, lambda e: e.update(appImageId='9' * 64), 'invalid ledger app image ID'),
            (2, lambda e: e.update(operation='app-restore'), 'unresolved pending'),
            (1, lambda e: e.update(operation='app-restore'), 'must undo the latest completed app-swap'))
        for index, mutate, message in mutations:
            value = copy.deepcopy(valid)
            mutate(value['entries'][index])
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                release.validate_ledger(value)
        _, d = release.secret_deployment(self.envelope)
        restore = {'generation': 4, 'planSha256': '4' * 64, 'operation': 'app-restore', 'state': 'pending',
                   'before': {**release.observed_state(self.envelope, d, self.new.sha), 'appImageId': self.new.image},
                   'expected': {**release.release_state(d, self.old.sha), 'appImageId': self.old.image}}
        release.validate_ledger({**valid, 'entries': [*valid['entries'], restore]})
        for key, value in (('appImageId', 'sha256:' + '9' * 64), ('appGitSha', '9' * 40)):
            wrong = copy.deepcopy(restore)
            wrong['expected'][key] = value
            with self.subTest(restore=key), self.assertRaisesRegex(ValueError, 'must undo the latest completed app-swap'):
                release.validate_ledger({**valid, 'entries': [*valid['entries'], wrong]})
        no_registry = copy.deepcopy(valid)
        del no_registry['entries'][0]['registrySha256']
        with self.assertRaisesRegex(ValueError, 'registry baseline'):
            release.validate_ledger(no_registry)

    def test_plan_quoted_refusals_reach_the_operator(self):
        # rebase_release.main prints only PUBLIC_REASONS; anything else becomes 'release refused'.
        import re
        names = ('rebase_app_swap.py', 'rebase_ssm.py', 'rebase_release.py', 'rebase_cloudformation.py', 'registry_gc.py')
        # Scan raising code only: the PUBLIC_REASONS literal itself must not count as a use.
        sources = re.sub(r'\nPUBLIC_REASONS = \{.*?\}\n', '\n', ''.join((HERE.parent / name).read_text() for name in names), flags=re.S)
        self.assertNotIn('PUBLIC_REASONS = {', sources)
        plan = re.sub(r'```.*?```', '', (REPO / 'docs/STAGING-APP-ONLY-RELEASE-PLAN.md').read_text(), flags=re.S)
        quoted = set(re.findall(r'`([^`]+)`', plan))
        # Every refusal the plan's stop conditions branch on: raised verbatim, quoted by the plan, and public.
        stop_conditions = ('live app differs from the plan before-state', 'post-install state differs; run app-swap-reconcile',
                           'one-shot SSM command failed; reconcile under the retained fence', 'manual reconciliation required',
                           'uncertain SSM submission; reconcile command before retry',
                           'app secret changed while pending; manual reconciliation required')
        for message in stop_conditions:
            self.assertIn("'" + message + "'", sources)
            self.assertTrue(any(message.startswith(text) for text in quoted), message)
        # The other app-operation refusals an operator acts on must also print.
        operator = (*stop_conditions, 'staging host is not quiescent', 'candidate tag already names another image',
                    'staging host is not proven quiescent; retain the fence', 'app-swap-reconcile requires this plan pending entry',
                    'archive receipt missing; run app-archive-check', 'stale plan: ledger generation advanced',
                    'app-restore must undo the latest completed app-swap', 'app operation pending; run app-swap-reconcile',
                    'one-shot SSM command already ended; reconcile it, never resubmit', 'remote command not terminal; wait or cancel')
        for message in operator:
            self.assertIn("'" + message + "'", sources)
            self.assertIn(message, release.PUBLIC_REASONS)
        self.assertEqual({reason for reason in release.PUBLIC_REASONS if "'" + reason + "'" not in sources}, set())

    def test_one_shot_transport_refuses_failed_journal_without_send(self):
        state = {'schemaVersion': 1, 'host': ssm.HOST, 'operation': 'x-g2', 'sha256': sha256(b'body'), 'key': ssm.PREFIX + sha256(b'body') + '.sh',
                 'status': 'failed', 'commandId': '00000001-1111-4111-8111-111111111111', 'comment': 'c', 'attempts': []}
        TOOL.write(self.root / 'x-g2-ssm.json', state)
        with self.assertRaisesRegex(ValueError, 'never resubmit'):
            ssm.run(self.root, 'x-g2', 'body', True, self.aws, TOOL.write, one_shot=True)
        self.assertFalse(any(c[:2] in (('ssm', 'send-command'), ('s3api', 'put-object')) for c in self.calls))
        self.assertEqual(manifest.read(self.root / 'x-g2-ssm.json'), state)


if __name__ == '__main__':
    unittest.main()
