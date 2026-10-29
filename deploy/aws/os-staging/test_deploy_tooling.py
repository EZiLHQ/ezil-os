"""Offline traces of deploy.sh and install-host.sh per OS_ENV (no AWS, Docker or systemd).

aws, docker, curl and systemctl are PATH shims that log their arguments. The
host script runs with /opt, /etc and /var/lib rewritten under a temporary root
and its root/arch check replaced, so it never touches this machine.
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
PROD_BUCKET = "ezil-main-prod-artifacts-452630323510-aps1"
PROD_PIN = "vpc-040bdd6e09e35425f\tezil-os-prod-host\tproduction"
JOBS = ("telemetry-maintenance", "sandbox-reap", "billing-session-sweep",
        "aws-stop-settle", "pool-replenish", "aws-reconcile")
AWS_JOBS = ("aws-stop-settle", "pool-replenish", "aws-reconcile")

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
        shutil.copyfile(source, args[6])
elif name == "docker":
    if args[:1] == ["save"]:
        sys.stdout.write("image:" + args[1])
    elif args[:1] == ["load"]:
        (state / "loaded").write_text(sys.stdin.read())
    elif args[:2] == ["image", "inspect"]:
        loaded = state / "loaded"
        if not loaded.exists() or loaded.read_text() != "image:" + args[2]:
            sys.exit(1)
        print("amd64")
    elif args[:3] == ["compose", "version", "--short"]:
        print("2.39.4")
    elif "up" in args:
        with open(state / "log", "a") as log:
            log.write(json.dumps(["compose.env", pathlib.Path("compose.env").read_text()]) + "\n")
    elif "exec" in args:
        print("Deployed SHA: " + os.environ["FAKE_SHA"])
elif name == "curl":
    pathlib.Path(after("--output")).write_text(os.environ.get("FAKE_HEALTH", ""))
    sys.stdout.write(os.environ.get("FAKE_STATUS", "200"))
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
                    SHIM_STATE=str(self.state), FAKE_S3=str(self.s3), FAKE_SHA=SHA, GIT_SHA=SHA)
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
        for directory in ("opt", "etc/systemd/system", "var/lib"):
            (host / directory).mkdir(parents=True, exist_ok=True)
        text = (script or self.deploy / "install-host.sh").read_text()
        guard = "[[ $EUID == 0 && $(uname -m) == x86_64 ]]"
        assert text.count(guard) == 1
        text = text.replace(guard, "true")
        for prefix in ("/opt/", "/etc/", "/var/lib/"):
            count = text.count(prefix)
            text = text.replace(prefix, f"{host}{prefix}")
            assert text.count(f"{host}{prefix}") == count and str(host).count(prefix) == 0
        path = self.root / "host.sh"
        path.write_text("set -- " + " ".join(set_args) + "\n" + text)
        return host, path

    def install(self, set_args, script=None, **environment):
        host, path = self.host_script(set_args, script)
        result = subprocess.run(["bash", str(path)], capture_output=True, text=True, cwd=self.root,
                                env=self.environment(**environment), timeout=60)
        return host, result


def rendered_production(sandbox):
    output = sandbox.root / "rendered"
    subprocess.run(["python3", str(sandbox.deploy / "render-runtime.py"), str(sandbox.deploy), str(output)], check=True)
    return output


def tar_members(path):
    with tarfile.open(path) as archive:
        return sorted(member.name for member in archive.getmembers() if member.isfile())


class SandboxTestCase(unittest.TestCase):
    def setUp(self):
        self.box = Sandbox()
        self.addCleanup(self.box.close)


class RenderRuntimeTests(SandboxTestCase):
    def render(self):
        return subprocess.run(["python3", str(self.box.deploy / "render-runtime.py"), str(self.box.deploy),
                               str(self.box.root / "out")], capture_output=True, text=True)

    def test_production_runtime_names_hosts_and_paths(self):
        output = rendered_production(self.box)
        self.assertEqual(sorted(p.name for p in (output / "cron").iterdir()),
                         sorted(f"ezil-os-production-{job}.{kind}" for job in JOBS for kind in ("service", "timer")))
        for job in JOBS:
            service = (output / f"cron/ezil-os-production-{job}.service").read_text()
            staging = (self.box.deploy / f"cron/ezil-os-staging-{job}.service").read_text()
            self.assertIn(f" https://os-prod.ezil.work/api/cron/{job}\n", service)
            self.assertIn("EnvironmentFile=/etc/ezil-os-production/cron.env\n", service)
            # Only names change: schedules, limits and hardening stay identical.
            self.assertEqual(len(service.splitlines()), len(staging.splitlines()))
            timer = (output / f"cron/ezil-os-production-{job}.timer").read_text()
            self.assertIn(f"Unit=ezil-os-production-{job}.service\n", timer)
            self.assertEqual([l for l in timer.splitlines() if l.startswith("OnCalendar=")],
                             [l for l in (self.box.deploy / f"cron/ezil-os-staging-{job}.timer").read_text().splitlines()
                              if l.startswith("OnCalendar=")])
        compose = (output / "compose.yaml").read_text()
        self.assertIn("name: ezil-os-production\n", compose)
        self.assertIn("image: ezil-os-production:${OS_PRODUCTION_TAG:?Set OS_PRODUCTION_TAG}", compose)
        self.assertIn("path: /etc/ezil-os-production/app.env\n", compose)
        self.assertIn("\nos-prod.ezil.work, os.ezil.work {\n", (output / "Caddyfile").read_text())
        self.assertEqual((output / "render-env.py").read_bytes(), (self.box.deploy / "render-env.py").read_bytes())
        for path in output.rglob("*"):
            if path.is_file() and path.name != "render-env.py":
                self.assertNotIn("staging", path.read_text().lower(), path.name)

    def test_drifted_sources_fail_the_build(self):
        self.assertEqual(self.render().returncode, 0)  # Positive control.
        shutil.rmtree(self.box.root / "out")
        mutations = (
            ("cron/ezil-os-staging-extra.timer", None, "does not match the known job set"),
            ("Caddyfile", ("os-staging.ezil.work {", "os-staging.ezil.work:443 {"), "expected exactly one"),
            ("compose.yaml", ("    restart: unless-stopped\n    init: true",
                              "    restart: unless-stopped\n    init: true\n    # staging only"), "staging reference survived"),
        )
        for name, change, message in mutations:
            with self.subTest(name=name):
                path = self.box.deploy / name
                before = path.read_text() if path.exists() else None
                path.write_text("x\n" if change is None else before.replace(*change))
                result = self.render()
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                path.unlink() if before is None else path.write_text(before)
                shutil.rmtree(self.box.root / "out", ignore_errors=True)


class DeployScriptTests(SandboxTestCase):
    def test_os_env_is_strict(self):
        for value in ("prod", "Production", "preview"):
            with self.subTest(value=value):
                result = self.box.deploy_sh("smoke", OS_ENV=value)
                self.assertEqual(result.returncode, 1)
                self.assertIn("OS_ENV must be staging (the default) or production.", result.stderr)
        self.assertEqual(self.box.calls(), [])
        # Positive control: unset and explicit staging both reach the staging guard.
        for environment in ({}, {"OS_ENV": "staging"}):
            result = self.box.deploy_sh("smoke", **environment)
            self.assertIn("Set OS_STAGING_INSTANCE_ID.", result.stderr)

    def test_production_pins_its_instance(self):
        cases = (
            ({"OS_STAGING_INSTANCE_ID": "i-0123456789abcdef0"}, "Set OS_PRODUCTION_INSTANCE_ID.", False),
            ({"OS_PRODUCTION_INSTANCE_ID": "i-09012068d96166828"}, "Refusing the production database host.", False),
            ({"OS_PRODUCTION_INSTANCE_ID": "i-0123456789abcdef0",
              "FAKE_DESCRIBE": "vpc-0f6bc19fdfd4209aa\tezil-os-billing-staging-host\tbilling-staging"}, "Refusing instance", True),
            ({"OS_PRODUCTION_INSTANCE_ID": "i-0123456789abcdef0",
              "FAKE_DESCRIBE": "vpc-040bdd6e09e35425f\tezil-os-prod-host\tbilling-staging"}, "Refusing instance", True),
            ({"OS_PRODUCTION_INSTANCE_ID": "i-0123456789abcdef0",
              "FAKE_DESCRIBE": "vpc-040bdd6e09e35425f\tezil-os-prod-host-2\tproduction"}, "Refusing instance", True),
        )
        for environment, message, described in cases:
            with self.subTest(message=message, environment=environment):
                (self.box.state / "log").unlink(missing_ok=True)
                result = self.box.deploy_sh("install", "v1", OS_ENV="production", **environment)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual([c[5] for c in self.box.calls()], ["describe-instances"] if described else [])
        # Positive control: the exact pin sends the production installer.
        result = self.box.deploy_sh("install", "v1", OS_ENV="production", FAKE_DESCRIBE=PROD_PIN,
                                    OS_PRODUCTION_INSTANCE_ID="i-0123456789abcdef0",
                                    OS_STAGING_ARTIFACT_BUCKET="ezil-preview-artifacts-example")
        self.assertEqual(result.returncode, 0, result.stderr)
        send, = [c for c in self.box.calls() if "send-command" in c]
        self.assertIn("i-0123456789abcdef0", send)
        self.assertEqual(send[send.index("--comment") + 1], "OS production install")
        payload, = self.box.payloads()
        self.assertTrue(payload.startswith(f"bash <<'OS_STAGING_SSM'\nset -- v1 {PROD_BUCKET} production\n#!/usr/bin/env bash\n"))
        self.assertIn((self.box.deploy / "install-host.sh").read_text(), payload)

    def test_staging_refuses_production_instance_and_bucket(self):
        result = self.box.deploy_sh("install", "v1", OS_STAGING_INSTANCE_ID="i-0123456789abcdef0",
                                    FAKE_DESCRIBE="ezil-os-prod-host", OS_STAGING_ARTIFACT_BUCKET="b-staging")
        self.assertIn("Name contains prod", result.stderr)
        self.box.fake_artifacts(self.box.deploy / "artifacts", "v1")
        result = self.box.deploy_sh("upload", "v1", OS_STAGING_ARTIFACT_BUCKET=PROD_BUCKET)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Refusing a production bucket for staging.", result.stderr)
        self.assertEqual([c for c in self.box.calls() if "put-object" in c], [])
        # Positive control: a staging bucket uploads under the staging prefix.
        result = self.box.deploy_sh("upload", "v1", OS_STAGING_ARTIFACT_BUCKET="ezil-preview-artifacts-example")
        self.assertEqual(result.returncode, 0, result.stderr)
        puts = [(c[c.index("--bucket") + 1], c[c.index("--key") + 1]) for c in self.box.calls() if "put-object" in c]
        self.assertEqual(puts, [("ezil-preview-artifacts-example", f"os-staging/images/v1.{s}")
                                for s in ("tar.gz", "runtime.tar.gz", "sha256")])

    def test_production_upload_uses_its_bucket_prefix_and_artifacts(self):
        self.box.fake_artifacts(self.box.deploy / "artifacts", "v1")  # A staging build of the same tag.
        result = self.box.deploy_sh("upload", "v1", OS_ENV="production")
        self.assertEqual(result.returncode, 1)
        self.assertIn("Run build TAG first.", result.stderr)
        self.box.fake_artifacts(self.box.deploy / "artifacts/production", "v1")
        result = self.box.deploy_sh("upload", "v1", OS_ENV="production", OS_STAGING_ARTIFACT_BUCKET="b-staging")
        self.assertEqual(result.returncode, 0, result.stderr)
        puts = [(c[c.index("--bucket") + 1], c[c.index("--key") + 1]) for c in self.box.calls() if "put-object" in c]
        self.assertEqual(puts, [(PROD_BUCKET, f"os/images/v1.{s}") for s in ("tar.gz", "runtime.tar.gz", "sha256")])

    def test_build_inputs_and_bundles_per_environment(self):
        production = {"OS_ENV": "production", "NEXT_PUBLIC_SUPABASE_URL": "https://db.ezil.work",
                      "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_live_x"}
        for change, message in (({"NEXT_PUBLIC_SUPABASE_URL": "https://13-203-99-168.sslip.io"}, "https://db.ezil.work"),
                                ({"NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_test_x"}, "pk_live_")):
            result = self.box.deploy_sh("build", "v1", **{**production, **change})
            self.assertEqual(result.returncode, 1)
            self.assertIn(message, result.stderr)
        staging = {"NEXT_PUBLIC_SUPABASE_URL": "https://13-203-99-168.sslip.io",
                   "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon", "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_test_x"}
        for change in ({"NEXT_PUBLIC_SUPABASE_URL": "https://db.ezil.work"}, {"NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY": "pk_live_x"}):
            result = self.box.deploy_sh("build", "v1", **{**staging, **change})
            self.assertIn("Staging refuses the production API URL and Stripe live keys.", result.stderr)
        self.assertEqual([c for c in self.box.calls() if c[:2] == ["docker", "build"]], [])
        # Positive controls: each environment builds its own image and runtime bundle.
        for environment, image, artifacts, slug in ((production, "ezil-os-production", "artifacts/production", "ezil-os-production"),
                                                    (staging, "ezil-os-staging", "artifacts", "ezil-os-staging")):
            result = self.box.deploy_sh("build", "v1", **environment)
            self.assertEqual(result.returncode, 0, result.stderr)
            build = [c for c in self.box.calls() if c[:2] == ["docker", "build"]][-1]
            self.assertEqual(build[build.index("--tag") + 1], f"{image}:v1")
            bundle = self.box.deploy / artifacts / "v1.runtime.tar.gz"
            self.assertEqual(tar_members(bundle), sorted(["Caddyfile", "compose.yaml", "render-env.py"] +
                             [f"cron/{slug}-{job}.{kind}" for job in JOBS for kind in ("service", "timer")]))
            with tarfile.open(bundle) as archive:
                self.assertIn(f"name: {slug}\n", archive.extractfile("compose.yaml").read().decode())

    def test_smoke_hosts_and_sha_check(self):
        health = json.dumps({"ok": True, "sha": SHA})
        base = {"OS_ENV": "production", "OS_PRODUCTION_INSTANCE_ID": "i-0123456789abcdef0", "FAKE_DESCRIBE": PROD_PIN,
                "FAKE_SSM_STDOUT": f"Deployed SHA: {SHA}", "FAKE_HEALTH": health}
        for args, url in ((("smoke",), "https://os-prod.ezil.work/api/health"),
                          (("smoke", "public"), "https://os.ezil.work/api/health")):
            with self.subTest(args=args):
                (self.box.state / "log").unlink(missing_ok=True)
                result = self.box.deploy_sh(*args, **base)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([c[-1] for c in self.box.calls() if c[0] == "curl"], [url])
        # Another deployment's SHA (e.g. Vercel before cutover) fails the smoke.
        result = self.box.deploy_sh("smoke", "public", **{**base, "FAKE_HEALTH": json.dumps({"ok": True, "sha": "f" * 40})})
        self.assertEqual(result.returncode, 1)
        self.assertIn("must return 200 with this host's deployed SHA", result.stderr)
        result = self.box.deploy_sh("smoke", **{**base, "FAKE_STATUS": "502"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("/opt/ezil-os-production\n", self.box.payloads()[-1])
        # Staging keeps its no-argument contract and host.
        result = self.box.deploy_sh("smoke", "public", OS_STAGING_INSTANCE_ID="i-0123456789abcdef0")
        self.assertIn("smoke takes no argument.", result.stderr)
        (self.box.state / "log").unlink()
        result = self.box.deploy_sh("smoke", OS_STAGING_INSTANCE_ID="i-0123456789abcdef0", FAKE_DESCRIBE="ezil-os-billing-staging-host")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([c[-1] for c in self.box.calls() if c[0] == "curl"], ["https://os-staging.ezil.work/api/health"])
        self.assertTrue(self.box.payloads()[-1].startswith(
            "bash <<'OS_STAGING_SSM'\nset -euo pipefail\nset +x\ncd /opt/ezil-os-staging\nexec 9>deploy.lock\n"))


class InstallHostTests(SandboxTestCase):
    def publish_production(self):
        self.box.publish(PROD_BUCKET, "os/images", "v1", "ezil-os-production", rendered_production(self.box))

    def timers(self):
        return [(c[1], c[-1]) for c in self.box.calls() if c[0] == "systemctl" and c[1] in ("enable", "disable")]

    def test_production_runs_only_non_aws_timers_by_default(self):
        self.publish_production()
        (self.box.root / "host/var/lib/ezil-os-production").mkdir(parents=True)
        (self.box.root / "host/var/lib/ezil-os-production/bootstrap.done").touch()
        host, result = self.box.install(["v1", PROD_BUCKET, "production"], FAKE_KEYS="CRON_SECRET STRIPE_SECRET")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AWS computer timers stay disabled", result.stdout)
        self.assertEqual(self.timers(), [("disable" if job in AWS_JOBS else "enable", f"ezil-os-production-{job}.timer")
                                         for job in JOBS])
        self.assertIn(["render-env.py", "production"], self.box.calls())
        self.assertIn(["compose.env", "OS_PRODUCTION_TAG=v1\n"], self.box.calls())
        self.assertEqual(sorted(p.name for p in (host / "etc/systemd/system").iterdir()),
                         sorted(f"ezil-os-production-{job}.{kind}" for job in JOBS for kind in ("service", "timer")))
        self.assertIn("os-prod.ezil.work, os.ezil.work {", (host / "opt/ezil-os-production/Caddyfile").read_text())
        # Positive control: once the secret configures AWS computers, all six run.
        (self.box.state / "log").unlink()
        _, result = self.box.install(["v1", PROD_BUCKET, "production"], FAKE_KEYS="CRON_SECRET EZIL_AWS_COMPUTERS_ENABLED")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("AWS computer timers stay disabled", result.stdout)
        self.assertEqual(self.timers(), [("enable", f"ezil-os-production-{job}.timer") for job in JOBS])

    def test_production_host_refusals(self):
        self.publish_production()
        host, result = self.box.install(["v1", PROD_BUCKET, "production"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bootstrap.done is missing", result.stderr)
        (host / "var/lib/ezil-os-production").mkdir()
        (host / "var/lib/ezil-os-production/bootstrap.done").touch()
        (host / "var/lib/ezil-os-staging").mkdir()
        _, result = self.box.install(["v1", PROD_BUCKET, "production"])
        self.assertIn("this host carries", result.stderr)
        self.assertFalse(any(c[0] == "docker" for c in self.box.calls()))
        (host / "var/lib/ezil-os-staging").rmdir()
        # A staging bundle (staging unit names) never installs on production.
        self.box.publish(PROD_BUCKET, "os/images", "v2", "ezil-os-production", self.box.deploy)
        _, result = self.box.install(["v2", PROD_BUCKET, "production"])
        self.assertIn("Invalid runtime bundle", result.stderr)
        # Nor does a staging image under a production tag.
        self.box.publish(PROD_BUCKET, "os/images", "v3", "ezil-os-staging", self.box.root / "rendered")
        _, result = self.box.install(["v3", PROD_BUCKET, "production"])
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(["compose.env", "OS_PRODUCTION_TAG=v3\n"], self.box.calls())
        # Positive control.
        _, result = self.box.install(["v1", PROD_BUCKET, "production"])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_staging_enables_every_timer_and_refuses_a_production_host(self):
        self.box.publish("b-staging", "os-staging/images", "v1", "ezil-os-staging", self.box.deploy)
        host, result = self.box.install(["v1", "b-staging", "staging"], FAKE_KEYS="CRON_SECRET")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.timers(), [("enable", f"ezil-os-staging-{job}.timer") for job in JOBS])
        self.assertIn(["render-env.py", "staging"], self.box.calls())
        self.assertIn(["compose.env", "OS_STAGING_TAG=v1\n"], self.box.calls())
        (host / "var/lib/ezil-os-production").mkdir()
        _, result = self.box.install(["v1", "b-staging", "staging"])
        self.assertIn("this host carries", result.stderr)


if __name__ == "__main__":
    unittest.main()
