"""Offline traces of deploy.sh and install-host.sh for S staging (no AWS, Docker or systemd).

aws, docker, curl and systemctl are PATH shims that log their arguments. The
host script runs with /opt, /etc, /var/lib and /var/log (the D4 web-log
snapshot) rewritten under a temporary root and its root/arch check replaced,
so it never touches this machine.
"""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import unittest

HERE = Path(__file__).parent
SHA = "0123456789abcdef0123456789abcdef01234567"
JOBS = ("telemetry-maintenance", "sandbox-reap", "billing-session-sweep",
        "aws-stop-settle", "pool-replenish", "aws-reconcile")

SHIM = r'''#!/usr/bin/env python3
import json, os, pathlib, shutil, sys
name, args = pathlib.Path(sys.argv[0]).name, sys.argv[1:]
state = pathlib.Path(os.environ["SHIM_STATE"])
with open(state / "log", "a") as log:
    log.write(json.dumps([name] + args) + "\n")
def after(flag):
    return args[args.index(flag) + 1]
if name == "aws":
    if "describe-instances" in args:
        print(os.environ.get("FAKE_DESCRIBE", "None"))
    elif "send-command" in args:
        count = len(list(state.glob("payload-*.json")))
        shutil.copyfile(after("--parameters")[len("file://"):], state / f"payload-{count}.json")
        print("command-1")
    elif "get-command-invocation" in args:
        print("Success" if after("--query") == "Status" else os.environ.get("FAKE_SSM_STDOUT", ""))
    elif args[3:5] == ["s3", "cp"]:
        bucket, key = args[5][len("s3://"):].split("/", 1)
        source = pathlib.Path(os.environ["FAKE_S3"], bucket, key)
        if not source.is_file():
            sys.exit(1)
        limited = os.environ.get('FAKE_LIMITED_TMP')  # stands in for a tmpfs too small for GB artifacts
        with open(state / "dests", "a") as dests:
            dests.write(args[6] + "\n")
        if limited and args[6].startswith(limited):
            sys.exit(1)
        shutil.copyfile(source, args[6])
elif name == "docker":
    if args[:1] == ["build"]:
        context = pathlib.Path(args[-1])
        (state / 'built-dockerfile').write_bytes(pathlib.Path(after('--file')).read_bytes())
        fixture = context / 'app/provenance-fixture.txt'
        if fixture.exists():
            (state / 'built-fixture').write_bytes(fixture.read_bytes())
        (state / 'built-ignored').write_text(str((context / 'app/ignored.txt').exists()))
        if os.environ.get('MUTATE_DURING_BUILD'):
            pathlib.Path(os.environ['MUTATE_DURING_BUILD']).write_text('changed during build\n')
    if args[:2] == ["save", "-o"]:
        (state / "save_path").write_text(args[2])
        (state / "save_dir_mode").write_text(oct(pathlib.Path(args[2]).parent.stat().st_mode & 0o777))
        if os.environ.get('FAKE_SAVE_FAIL') or (os.environ.get('FAKE_LIMITED_TMP') and
                                                args[2].startswith(os.environ['FAKE_LIMITED_TMP'])):
            sys.exit(1)
        shutil.copyfile(os.environ.get('FAKE_SAVE_TAR') or state / "save.tar", args[2])
        (state / "saved").touch()
    elif args[:1] == ["save"]:
        sys.stdout.write("image:" + args[1])
    elif args[:1] == ["load"]:
        (state / "loaded").write_bytes(sys.stdin.buffer.read())
    elif args[:2] == ["image", "inspect"]:
        if args[2] == 'sha256:' + '1' * 64:
            print('2' * 40)
            sys.exit(0)
        loaded = state / "loaded"
        if os.environ.get('FAKE_INSPECT_JSON') and loaded.exists():
            data = json.loads(os.environ['FAKE_INSPECT_JSON'])
            if after('--format') == '{{.Id}}':
                print(os.environ.get('FAKE_ID_AFTER_SAVE', data['Id']) if (state / "saved").exists() else data['Id'])
                sys.exit(0)
            print(json.dumps(data) if after('--format') == '{{json .}}' else data['Architecture'])
            sys.exit(0)
        if not loaded.exists() or loaded.read_bytes() != ("image:" + args[2]).encode():
            sys.exit(1)
        print("amd64")
    elif args[:3] == ["compose", "version", "--short"]:
        print("2.39.4")
    elif args[:2] == ["container", "inspect"] and '--format' in args:
        if after('--format') == '{{.Image}}':
            print(os.environ.get('FAKE_RUNNING_IMAGE') or json.loads(os.environ['FAKE_INSPECT_JSON'])['Id'])
        else:
            print('ezil-os-staging:previous sha256:' + '1' * 64)
    elif "up" in args:
        if os.environ.get('FAKE_UP_CONSUMES_STDIN'):  # a compose child that drains the inline-bash script
            sys.stdin.buffer.read()
        (state / "export_at_up").write_text(str(bool(list((pathlib.Path(os.environ["SHIM_STATE"]).parent / "host").rglob("loaded-export.tar")))))
        with open(state / "log", "a") as log:
            log.write(json.dumps(["compose.env", pathlib.Path("compose.env").read_text()]) + "\n")
    elif "exec" in args:
        if os.environ.get('FAKE_EXEC_CONSUMES_STDIN'):  # real `compose exec -T` forwards stdin
            sys.stdin.buffer.read()
        print(os.environ['FAKE_SHA'] if 'process.stdout.write' in args[-1] else "Deployed SHA: " + os.environ["FAKE_SHA"])
elif name == "curl":
    if args[-1] == 'http://169.254.169.254/latest/api/token':
        print('fixture-imds-token')
        sys.exit(0)
    if args[-1] == 'http://169.254.169.254/latest/dynamic/instance-identity/document':
        print(os.environ.get('FAKE_INSTANCE_IDENTITY', json.dumps({'instanceId': 'i-014810524754b9ed0',
              'accountId': '452630323510', 'region': 'ap-south-1'})))
        sys.exit(0)
    pathlib.Path(after("--output")).write_text(os.environ.get("FAKE_HEALTH", ""))
    sys.stdout.write(after("--write-out").replace("%{http_code}", os.environ.get("FAKE_STATUS", "200"))
                     .replace("%{remote_ip}", os.environ.get("FAKE_REMOTE_IP", "203.0.113.10")))
'''

RENDER_ENV_STUB = r'''import json, os, sys
with open(os.path.join(os.environ["SHIM_STATE"], "log"), "a") as log:
    log.write(json.dumps(["render-env.py"] + sys.argv[1:]) + "\n")
print("\n".join(sorted(os.environ.get("FAKE_KEYS", "").split())))
'''


class Sandbox:
    """A temporary deploy tree, shim bin directory and fake S3 root."""

    def __init__(self, source=HERE):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.deploy = self.root / "repo/deploy/aws/os-staging"
        shutil.copytree(source, self.deploy, ignore=shutil.ignore_patterns("artifacts", "__pycache__"))
        (self.root / "repo/app").mkdir()
        (self.root / "repo/app/Dockerfile").write_text("FROM scratch\n")
        (self.root / "repo/app/.dockerignore").write_text("*\n")
        (self.root / "repo/.gitignore").write_text("app/ignored.txt\n")
        subprocess.run(['git', 'init', '-q', str(self.root / 'repo')], check=True)
        subprocess.run(['git', '-C', str(self.root / 'repo'), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root / 'repo'), '-c', 'user.name=Offline Fixture',
                        '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], check=True)
        self.sha = subprocess.check_output(['git', '-C', str(self.root / 'repo'), 'rev-parse', 'HEAD'], text=True).strip()
        self.state = self.root / "state"
        self.bin = self.root / "bin"
        self.s3 = self.root / "s3"
        for directory in (self.state, self.bin, self.s3, self.root / "tmp"):
            directory.mkdir()
        for tool in ("aws", "docker", "curl", "systemctl"):
            (self.bin / tool).write_text(SHIM)
            (self.bin / tool).chmod(0o755)

    def close(self):
        self.temporary.cleanup()

    def environment(self, **extra):
        base = {key: value for key, value in os.environ.items()
                if not key.startswith(("OS_ENV", "OS_STAGING_", "OS_PRODUCTION_", "NEXT_PUBLIC_", "AWS_"))}
        base.update(PATH=f"{self.bin}:{os.environ['PATH']}", TMPDIR=str(self.root / "tmp"),
                    SHIM_STATE=str(self.state), FAKE_S3=str(self.s3), FAKE_SHA=SHA, GIT_SHA=self.sha,
                    OS_STAGING_PROMOTION_LEDGER=str(self.root / "absent-ledger.json"))
        base.update(extra)
        return base

    def calls(self):
        log = self.state / "log"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def payloads(self):
        return [json.loads(path.read_text())["commands"][0]
                for path in sorted(self.state.glob("payload-*.json"), key=lambda p: int(p.stem.split("-")[1]))]

    def deploy_sh(self, *args, **environment):
        return subprocess.run(["bash", str(self.deploy / "deploy.sh"), *args], capture_output=True, text=True,
                              env=self.environment(**environment), timeout=60)

    def fake_artifacts(self, directory, tag):
        directory.mkdir(parents=True, exist_ok=True)
        for suffix in ("tar.gz", "runtime.tar.gz"):
            (directory / f"{tag}.{suffix}").write_bytes(suffix.encode())
        environment = 'production' if directory.name == 'production' else 'staging'
        (directory / f'{tag}.source.json').write_text(json.dumps({
            'schema': 1, 'environment': environment, 'component': 'aws-app',
            'source': self.sha, 'tree': self.sha, 'source_archive_sha256': '0' * 64,
            'image': f'ezil-os-{environment}:{tag}',
            'artifacts': {f'{tag}.{s}': hashlib.sha256((directory / f'{tag}.{s}').read_bytes()).hexdigest()
                          for s in ('tar.gz', 'runtime.tar.gz')}}))
        with (directory / f"{tag}.sha256").open("w") as manifest:
            subprocess.run(["sha256sum", f"{tag}.tar.gz", f"{tag}.runtime.tar.gz"], cwd=directory, check=True,
                           stdout=manifest)

    # Host side: install-host.sh against fake S3 objects and a rewritten root.
    def publish(self, bucket, prefix, tag, image, runtime_dir):
        target = self.s3 / bucket / prefix
        target.mkdir(parents=True, exist_ok=True)
        (target / f"{tag}.tar.gz").write_bytes(gzip.compress(f"image:{image}:{tag}".encode()))
        bundle = io.BytesIO()
        with tarfile.open(fileobj=bundle, mode="w:gz") as archive:
            for path in sorted(runtime_dir.rglob("*")):
                name = path.relative_to(runtime_dir).as_posix()
                if name == "render-env.py":
                    data = RENDER_ENV_STUB.encode()
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    archive.addfile(info, io.BytesIO(data))
                elif path.is_file() and name in {"compose.yaml", "Caddyfile"} | {f"cron/{p.name}" for p in runtime_dir.glob("cron/*")}:
                    archive.add(path, name)
        (target / f"{tag}.runtime.tar.gz").write_bytes(bundle.getvalue())
        lines = [f"{hashlib.sha256((target / f'{tag}.{s}').read_bytes()).hexdigest()}  {tag}.{s}\n"
                 for s in ("tar.gz", "runtime.tar.gz")]
        (target / f"{tag}.sha256").write_text("".join(lines))

    def host_script(self, set_args, script=None):
        host = self.root / "host"
        for directory in ("opt", "etc/systemd/system", "var/lib", "var/log"):
            (host / directory).mkdir(parents=True, exist_ok=True)
        text = (script or self.deploy / "install-host.sh").read_text()
        guard = "[[ $EUID == 0 && $(uname -m) == x86_64 ]]"
        assert text.count(guard) == 1
        text = text.replace(guard, "true")
        for prefix in ("/opt/", "/etc/", "/var/lib/", "/var/log/"):
            count = text.count(prefix)
            text = text.replace(prefix, f"{host}{prefix}")
            assert text.count(f"{host}{prefix}") == count and str(host).count(prefix) == 0
        path = self.root / "host.sh"
        path.write_text("set -- " + " ".join(set_args) + "\n" + text)
        return host, path

    def install(self, set_args, script=None, stdin=False, **environment):
        host, path = self.host_script(set_args, script)
        # stdin=True feeds the script on bash's stdin, the SSM `bash <<EOF` transport.
        command, extra = (["bash"], {"input": path.read_text()}) if stdin else (["bash", str(path)], {})
        result = subprocess.run(command, capture_output=True, text=True, cwd=self.root,
                                env=self.environment(**environment), timeout=60, **extra)
        return host, result



class SandboxTestCase(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)


class LegacyStagingTests(SandboxTestCase):
    def test_generated_legacy_install_keeps_two_arguments_and_no_receipt(self):
        self.box.publish('fixture-staging', 'os-staging/images', 'old', 'ezil-os-staging', self.box.deploy)
        result = self.box.deploy_sh('install', 'old', OS_STAGING_INSTANCE_ID='i-0123456789abcdef0',
                                   OS_STAGING_ARTIFACT_BUCKET='fixture-staging', FAKE_DESCRIBE='staging')
        self.assertEqual(result.returncode, 0, result.stderr)
        body = '\n'.join(self.box.payloads()[-1].splitlines()[1:-1]) + '\n'
        self.assertTrue(body.startswith('set -- old fixture-staging\n'))
        self.assertNotIn('verify_install_source() {', body)
        path = self.box.root / 'legacy.sh'
        path.write_text(body)
        _, result = self.box.install([], script=path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Installed TAG: old', result.stdout)
        self.assertIn(['render-env.py'], self.box.calls())
        enabled = [c[3] for c in self.box.calls() if c[:3] == ['systemctl', 'enable', '--now']]
        self.assertEqual(enabled, [f'ezil-os-staging-{j}.timer' for j in JOBS])
        self.assertFalse(any('.source.json' in ' '.join(c) for c in self.box.calls()))

    def test_legacy_checksum_failure_stops_before_load_or_timer_changes(self):
        self.box.publish('fixture-staging', 'os-staging/images', 'old', 'ezil-os-staging', self.box.deploy)
        (self.box.s3 / 'fixture-staging/os-staging/images/old.tar.gz').write_bytes(b'changed')
        _, result = self.box.install(['old', 'fixture-staging'])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Checksum mismatch', result.stderr)
        self.assertFalse(any(c[:2] == ['docker', 'load'] or c[0] == 'systemctl' for c in self.box.calls()))

    def test_legacy_staging_refuses_production_or_missing_host_name(self):
        for name in ('prod-host', 'None', ''):
            result = self.box.deploy_sh('install', 'old', OS_STAGING_INSTANCE_ID='i-0123456789abcdef0',
                                       OS_STAGING_ARTIFACT_BUCKET='fixture-staging', FAKE_DESCRIBE=name)
            self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any('send-command' in c for c in self.box.calls()))

    def test_install_refuses_pending_or_unreadable_ledger_before_any_aws_call(self):
        # Cooperative fence only: it guards this checkout's deploy.sh, not raw SSM or older checkouts.
        ledger = self.box.root / 'ledger.json'
        environment = dict(OS_STAGING_INSTANCE_ID='i-0123456789abcdef0', OS_STAGING_ARTIFACT_BUCKET='fixture-staging',
                           FAKE_DESCRIBE='staging', OS_STAGING_PROMOTION_LEDGER=str(ledger))
        for content in (json.dumps({'entries': [{'state': 'completed'}, {'state': 'pending'}]}), '{not json'):
            ledger.write_text(content)
            for command in (('install', 'old'), ('install-verified', 'old', SHA, '0' * 64)):
                result = self.box.deploy_sh(*command, **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('pending operation', result.stderr)
        self.assertEqual(self.box.calls(), [])
        self.box.publish('fixture-staging', 'os-staging/images', 'old', 'ezil-os-staging', self.box.deploy)
        ledger.write_text(json.dumps({'entries': [{'state': 'pending'}, {'state': 'completed'}]}))
        self.assertEqual(self.box.deploy_sh('install', 'old', **environment).returncode, 0)

    def test_staging_tooling_refuses_production_selection(self):
        for command in ('build', 'upload', 'install'):
            result = self.box.deploy_sh(command, 'v1', OS_ENV='production')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('targets staging only', result.stderr)
        self.assertEqual(self.box.calls(), [])


if __name__ == '__main__':
    unittest.main()
