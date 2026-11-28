import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("render_env", Path(__file__).with_name("render-env.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class RenderEnvTests(unittest.TestCase):
    def setUp(self):
        self.values = {key: "synthetic-value-never-log-1234567890" for key in renderer.REQUIRED}

    def test_unknown_key_refused(self):
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "UNKNOWN": "synthetic"})
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_AWS_ARBITRARY": "synthetic"})

    def test_universe_project_repo_origin_is_optional(self):
        # Opening a Universe project in Code (app/src/server/works/project-repo.ts): off unless set.
        universe = {"UNIVERSE_PROJECT_REPO_ORIGIN": "https://universe-staging.example.invalid"}
        self.assertEqual(renderer.validate({**self.values, **universe}), {**self.values, **universe})
        self.assertIn("UNIVERSE_PROJECT_REPO_ORIGIN", renderer.OPTIONAL)
        self.assertNotIn("UNIVERSE_PROJECT_REPO_ORIGIN", renderer.REQUIRED)

    def test_the_old_works_origin_name_is_refused(self):
        # Renamed when the authority moved to Universe: a secret still holding the old key fails rendering.
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_WORKS_PROJECT_REPO_ORIGIN": "https://works.example.invalid"})

    def test_feedback_keys_are_optional(self):
        # In-product feedback (docs/feedback-migration.md): off unless set, so
        # every key is optional and none is required for a working app.
        feedback = {"EZIL_OS_FEEDBACK": "1", "EZIL_OS_FEEDBACK_SCREENSHOTS": "1",
                    "FEEDBACK_PILOT_EMAILS": "a@example.com,b@example.com",
                    "FEEDBACK_ADMIN_EMAILS": "contact@ezil.work", "FEEDBACK_SMTP2GO_API_KEY": "synthetic-provider-key"}
        self.assertEqual(renderer.validate({**self.values, **feedback}), {**self.values, **feedback})
        self.assertTrue(set(feedback) <= renderer.OPTIONAL)
        self.assertFalse(set(feedback) & renderer.REQUIRED)
        renderer.validate(dict(self.values))
        # The floating-controls pill is not part of this build; its flag stays refused.
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_OS_FLOATING_CONTROLS": "1"})
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_OS_FEEDBACK": ""})

    def test_telemetry_admin_emails_is_optional_and_forwarded_exactly(self):
        # The telemetry and AI-trace admin pages read this exact key; off (no admin) unless set.
        key = "TELEMETRY_ADMIN_EMAILS"
        self.assertIn(key, renderer.OPTIONAL)
        self.assertNotIn(key, renderer.REQUIRED)
        raw = "contact@ezil.work,ops+alerts@example.invalid"
        values = {**self.values, key: raw}
        self.assertEqual(renderer.validate(values), values)
        (app, cron), names = self.render_fixture(values)
        rendered = dict(line.split("=", 1) for line in app.decode().splitlines())
        self.assertEqual(rendered[key], raw)
        self.assertEqual(names.splitlines(), sorted(values))
        self.assertNotIn(raw, names)
        self.assertNotIn(key, cron.decode())
        renderer.validate(dict(self.values))  # absent stays valid
        for unknown in ("TELEMETRY_ADMIN_EMAIL", "TELEMETRY_ADMIN_EMAILS_EXTRA", "AI_TRACES_GATEWAY_CONSOLE_ORIGIN"):
            with self.subTest(key=unknown), self.assertRaisesRegex(renderer.RenderError, "Unknown key refused"):
                renderer.validate({**self.values, unknown: raw})

    def test_standalone_repo_open_flag_is_optional_and_forwarded_exactly(self):
        # Both Git routes (app/src/server/git/staging.ts awsStandaloneGitEnabled) read this exact key; absent means off.
        key = "AWS_STANDALONE_REPO_OPEN_ENABLED"
        self.assertIn(key, renderer.OPTIONAL)
        self.assertNotIn(key, renderer.REQUIRED)
        values = {**self.values, key: "true"}
        self.assertEqual(renderer.validate(values), values)
        (app, cron), names = self.render_fixture(values)
        rendered = dict(line.split("=", 1) for line in app.decode().splitlines())
        self.assertEqual(rendered[key], "true")
        self.assertEqual(names.splitlines(), sorted(values))
        self.assertNotIn(key, cron.decode())
        # Absent stays valid and is never synthesized, so the routes keep their disabled default.
        (app, _), _ = self.render_fixture(dict(self.values))
        self.assertNotIn(key, dict(line.split("=", 1) for line in app.decode().splitlines()))
        for unknown in ("AWS_STANDALONE_REPO_OPEN", "AWS_STANDALONE_REPO_OPEN_ENABLED_EXTRA", "AWS_STANDALONE_GIT_ENABLED"):
            with self.subTest(key=unknown), self.assertRaisesRegex(renderer.RenderError, "Unknown key refused"):
                renderer.validate({**self.values, unknown: "true"})
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, key: ""})  # the existing non-empty string rule still applies

    def render_fixture(self, values):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            output = io.StringIO()
            with contextlib.ExitStack() as stack:
                if os.geteuid() != 0:
                    stack.enter_context(patch.object(renderer.os, "geteuid", return_value=0))
                    stack.enter_context(patch.object(renderer.os, "chown"))
                    stack.enter_context(patch.object(renderer.os, "fchown"))
                with contextlib.redirect_stdout(output):
                    renderer.render(values, Path(temporary))
            return tuple((Path(temporary) / name).read_bytes() for name in ("app.env", "cron.env")), output.getvalue()

    def test_admin_entitlement_sender_keys_absence_keeps_existing_output(self):
        key = "EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS"
        self.assertIn(key, renderer.OPTIONAL)
        self.assertNotIn(key, renderer.REQUIRED)
        with patch.object(renderer, "OPTIONAL", renderer.OPTIONAL - {key}):
            before = self.render_fixture(self.values)
        self.assertEqual(self.render_fixture(self.values), before)

    def test_admin_entitlement_sender_keys_json_is_forwarded_verbatim(self):
        key = "EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS"
        public_map = {"synthetic-${NO_EXPAND}-#-quoted": {
            "kty": "OKP", "crv": "Ed25519", "x": "A" * 43}}
        raw = json.dumps(public_map, separators=(",", ":"))
        values = {**self.values, key: raw}
        (app, cron), names = self.render_fixture(values)
        rendered = dict(line.split("=", 1) for line in app.decode().splitlines())
        self.assertEqual(rendered, values)
        self.assertEqual(rendered[key], raw)
        self.assertEqual(json.loads(rendered[key]), public_map)
        self.assertEqual(names.splitlines(), sorted(values))
        self.assertNotIn(raw, names)
        self.assertNotIn(key, cron.decode())

    def test_admin_entitlement_nearby_or_private_key_names_remain_refused(self):
        for key in ("EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEY",
                    "EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS_EXTRA",
                    "EZIL_OS_ADMIN_ENTITLEMENT_PRIVATE_KEYS",
                    "EZIL_OS_ADMIN_ENTITLEMENT_SIGNING_KEY",
                    "EZIL_GATEWAY_ADMIN_SENDER_KEYS"):
            with self.subTest(key=key), self.assertRaises(renderer.RenderError):
                renderer.validate({**self.values, key: "synthetic"})

    def test_admin_entitlement_value_keeps_existing_string_validation(self):
        for value in (None, False, 1, "", " padded ", "before\nafter", "before\0after"):
            with self.subTest(value=repr(value)), self.assertRaises(renderer.RenderError):
                renderer.validate({**self.values, "EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS": value})

    def test_missing_key_refused(self):
        del self.values["AUTH0_SECRET_ID"]
        with self.assertRaises(renderer.RenderError):
            renderer.validate(self.values)

    def test_newline_and_nul_refused(self):
        for char in ("\n", "\r", "\0"):
            with self.subTest(char=repr(char)), self.assertRaises(renderer.RenderError):
                renderer.validate({**self.values, "AUTH0_SECRET_ID": "before" + char + "after"})

    def test_nonstring_and_empty_refused(self):
        for value in (None, False, 123, "", " padded "):
            with self.subTest(value=value), self.assertRaises(renderer.RenderError):
                renderer.validate({**self.values, "AUTH0_SECRET_ID": value})

    def test_regional_names(self):
        renderer.validate({**self.values, "EZIL_AWS_MAX_RUNNING_AP_SOUTH_1": "1",
                           "EZIL_AWS_APP_CALLER_ROLE_ARN_US_EAST_1": "synthetic"})
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_AWS_MAX_RUNNING_AP_SOUTH_1_OOPS": "1"})

    def test_short_cron_secret_refused(self):
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "CRON_SECRET": "short"})

    def test_write_is_private_raw_and_prints_names_only(self):
        literal = 'synthetic-$TOKEN-${TOKEN}-#-"-\'-\\-secret-1234567890'
        self.values["CRON_SECRET"] = literal
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            directory = Path(temporary)
            output = io.StringIO()
            # Supports an unprivileged local test runner; on root, check real ownership.
            with contextlib.ExitStack() as stack:
                if os.geteuid() != 0:
                    stack.enter_context(patch.object(renderer.os, "geteuid", return_value=0))
                    stack.enter_context(patch.object(renderer.os, "chown"))
                    stack.enter_context(patch.object(renderer.os, "fchown"))
                with contextlib.redirect_stdout(output):
                    renderer.render(self.values, directory)
            self.assertEqual(output.getvalue().splitlines(), sorted(self.values))
            for value in self.values.values():
                self.assertNotIn(value, output.getvalue())
            for name in ("app.env", "cron.env"):
                details = (directory / name).stat()
                self.assertEqual(stat.S_IMODE(details.st_mode), 0o600)
                if os.geteuid() == 0:
                    self.assertEqual((details.st_uid, details.st_gid), (0, 0))
            self.assertEqual(dict(line.split("=", 1) for line in
                                  (directory / "app.env").read_text().splitlines()), self.values)
            cron = (directory / "cron.env").read_text()
            self.assertEqual(cron, 'CRON_SECRET="' + literal.replace('\\', '\\\\').replace('"', '\\"') + '"\n')
            before = (directory / "app.env").read_bytes()
            with self.assertRaises(renderer.RenderError):
                renderer.render({**self.values, "UNEXPECTED": "synthetic"}, directory)
            self.assertEqual((directory / "app.env").read_bytes(), before)

    def test_cli_errors_do_not_leak_values(self):
        for error in (ValueError("synthetic-secret-in-json-error"),
                      RuntimeError("synthetic-secret-in-aws-stderr")):
            output = io.StringIO()
            with patch.object(renderer.os, "geteuid", return_value=0), \
                 patch.object(renderer, "fetch_secret", side_effect=error), \
                 contextlib.redirect_stderr(output):
                self.assertEqual(renderer.main(), 1)
            self.assertNotIn("synthetic-secret", output.getvalue())

    def test_fetch_uses_role_and_fixed_secret(self):
        response = type("Response", (), {"returncode": 0,
            "stdout": json.dumps({"SecretString": json.dumps(self.values)})})()
        with patch.object(renderer.subprocess, "run", return_value=response) as run:
            self.assertEqual(renderer.fetch_secret(), self.values)
        args, kwargs = run.call_args
        self.assertIn("ezil-os/billing-staging/app", args[0])
        self.assertEqual(kwargs["env"]["AWS_SHARED_CREDENTIALS_FILE"], "/dev/null")
        self.assertNotIn("AWS_ACCESS_KEY_ID", kwargs["env"])


PRODUCTION_DB = "postgres://ezil_os_app:synthetic-password-1234@10.63.20.252:5432/postgres?sslmode=require"


class ProductionEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.values = {key: "synthetic-value-never-log-1234567890" for key in renderer.REQUIRED}
        self.values.update({
            "NEXT_PUBLIC_SUPABASE_URL": "https://db.ezil.work",
            "SUPABASE_DATABASE_URL": PRODUCTION_DB,
            "STRIPE_PUBLISHABLE_KEY": "pk_live_synthetic",
            "STRIPE_SECRET": "sk_live_synthetic",
        })

    def assertRefused(self, values, message, environment="production"):
        with self.assertRaisesRegex(renderer.RenderError, message):
            renderer.validate(values, environment)

    def test_production_accepts_the_pinned_shape(self):
        self.assertEqual(renderer.validate(dict(self.values), "production"), self.values)
        renderer.validate({**self.values, "STRIPE_SECRET": "rk_live_synthetic",
                           "SUPABASE_DATABASE_URL": PRODUCTION_DB.replace("postgres://", "postgresql://")}, "production")

    def assignment_values(self):
        return {
            **self.values,
            "BILLING_FUNDING_URL": "https://ai.ezil.work",
            "UNIVERSE_PROJECT_REPO_ORIGIN": "https://universe.ezil.work",
            renderer.ASSIGNMENT_GATE: "1",
            renderer.ASSIGNMENT_SIGNER: "synthetic-signing-key-" + "x" * 20,
        }

    def test_assignment_gate_and_origin_are_exact(self):
        values = self.assignment_values()
        self.assertEqual(renderer.validate(values, "production"), values)
        for key, refusers in {
            renderer.ASSIGNMENT_GATE: ["true", "enabled", "0"],
            renderer.ASSIGNMENT_SIGNER: ["x" * 31],
            "BILLING_FUNDING_URL": ["https://ai.ezil.work/", "https://ai-staging.ezil.work"],
            "UNIVERSE_PROJECT_REPO_ORIGIN": ["https://universe.ezil.work/", "https://universe-staging.ezil.work",
                                             "https://universe.ezil.work.example.invalid"],
        }.items():
            for value in [None, *refusers]:
                with self.subTest(key=key, value=value), self.assertRaises(renderer.RenderError):
                    renderer.validate(({**values, key: value} if value is not None
                                       else {name: val for name, val in values.items() if name != key}), "production")
        disabled = {**self.values, renderer.ASSIGNMENT_GATE: "0"}
        self.assertEqual(renderer.validate(disabled, "production"), disabled)
        self.assertEqual(renderer.validate(self.values, "production"), self.values)

    def test_assignment_keys_require_the_production_realm(self):
        stage = {key: "synthetic-value-never-log-1234567890" for key in renderer.REQUIRED}
        for key in renderer.PRODUCTION_ASSIGNMENT:
            self.assertRefused({**stage, key: "synthetic"}, "Unknown key refused", "staging")
        for key in (renderer.ASSIGNMENT_SIGNER, renderer.ASSIGNMENT_CA):
            self.assertRefused({**self.values, key: "synthetic"}, "require the enabled gate")

    def test_assignment_ca_is_one_real_certificate_and_one_raw_line(self):
        with tempfile.TemporaryDirectory() as directory:
            prefix = ["openssl", "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
                      "-nodes", "-x509", "-days", "1", "-subj", "/CN=Synthetic Assignment Test"]
            pem_path = Path(directory) / "public.pem"
            for is_ca in (False, True):
                subprocess.run([*prefix, "-addext", f"basicConstraints=critical,CA:{str(is_ca).upper()}",
                                "-out", str(pem_path), "-keyout", str(Path(directory) / "key.pem")],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
                pem = pem_path.read_text()
                if not is_ca:
                    self.assertRefused({**self.assignment_values(), renderer.ASSIGNMENT_CA: pem}, "valid CA")
            values = self.assignment_values()
            escaped = pem.replace("\n", r"\n")
            for valid in (pem, pem.replace("\n", "\r\n"), escaped):
                normalized = renderer.validate({**values, renderer.ASSIGNMENT_CA: valid}, "production")
                self.assertEqual(normalized[renderer.ASSIGNMENT_CA], escaped)
                self.assertNotIn("\n", normalized[renderer.ASSIGNMENT_CA])
            for invalid in (pem + pem, pem + "\nFORGED_KEY=synthetic", pem.replace("CERTIFICATE", "PRIVATE KEY"),
                            "-----BEGIN CERTIFICATE-----\nYQ==\n-----END CERTIFICATE-----\n", "x" * 16385):
                self.assertRefused({**values, renderer.ASSIGNMENT_CA: invalid}, "valid CA")

    def test_native_keys_are_explicit_and_production_only(self):
        native = {key: "synthetic-pin" for key in renderer.PRODUCTION_NATIVE}
        native.update({key: "0" for key in renderer.NATIVE_SWITCHES})
        native.update(EZIL_NATIVE_AUTHORIZATION="disabled", EZIL_NATIVE_SESSIONS_ORIGIN="https://os.ezil.work")
        native["EZIL_NATIVE_QUALIFICATION_TARGET"] = (
            "a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002/i-0123456789abcdef0"
        )
        values = {**self.values, **native}
        self.assertEqual(renderer.validate(values, "production"), values)
        self.assertTrue(set(native).isdisjoint(renderer.REQUIRED))
        self.assertRefused(values, "Unknown key", "staging")
        self.assertRefused({**values, "EZIL_NATIVE_UNREVIEWED": "1"}, "Unknown key")

    def test_native_gates_and_origin_use_the_exact_app_literals(self):
        for key in renderer.NATIVE_SWITCHES:
            self.assertRefused({**self.values, key: "true"}, "gates must be exactly")
            renderer.validate({**self.values, key: "1"}, "production")
        self.assertRefused({**self.values, "EZIL_NATIVE_AUTHORIZATION": "1"}, "must be exactly")
        self.assertRefused({**self.values, "EZIL_NATIVE_SESSIONS_ORIGIN": "https://other.example.test"}, "production OS origin")

    def test_refuses_unpinned_native_qualification_targets(self):
        key = "EZIL_NATIVE_QUALIFICATION_TARGET"
        target = "a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000002/i-0123456789abcdef0"
        self.assertRefused({**self.values, key: ""}, "nonempty strings")
        for value in ("*", target.upper(), target.rsplit("/", 1)[0], target + "," + target):
            self.assertRefused({**self.values, key: value}, "qualification target")

    def test_production_pins_api_url(self):
        for url in ("https://13-206-183-230.sslip.io", "https://db.ezil.work/", "http://db.ezil.work"):
            with self.subTest(url=url):
                # The sslip.io host is refused earlier, as a non-production host.
                self.assertRefused({**self.values, "NEXT_PUBLIC_SUPABASE_URL": url},
                                   "NEXT_PUBLIC_SUPABASE_URL must be|Production refuses staging")

    def test_production_pins_private_database_with_tls(self):
        for url in (PRODUCTION_DB.replace("?sslmode=require", ""),
                    PRODUCTION_DB.replace("sslmode=require", "sslmode=disable"),
                    PRODUCTION_DB + "&host=127.0.0.1",
                    PRODUCTION_DB.replace("10.63.20.252:5432", "10.63.20.252:6543"),
                    PRODUCTION_DB.replace("10.63.20.252:5432", "10.63.20.252"),
                    PRODUCTION_DB.replace("10.63.20.252", "10.63.20.25"),
                    PRODUCTION_DB.replace("/postgres?", "?"),
                    PRODUCTION_DB.replace("postgres://", "mysql://"),
                    "postgres://u:p@10.63.20.252:notaport/postgres?sslmode=require"):
            with self.subTest(url=url):
                self.assertRefused({**self.values, "SUPABASE_DATABASE_URL": url}, "SUPABASE_DATABASE_URL must be")

    def test_production_requires_live_stripe(self):
        self.assertRefused({**self.values, "STRIPE_PUBLISHABLE_KEY": "pk_test_synthetic"}, "live-mode")
        self.assertRefused({**self.values, "STRIPE_SECRET": "sk_test_synthetic"}, "live-mode")

    def test_production_refuses_staging_and_preview_values(self):
        for key, value in (("SUPABASE_DATABASE_URL", "postgres://u:p@10.61.20.35:5432/postgres?sslmode=require"),
                           ("NEXT_PUBLIC_SUPABASE_URL", "https://13-203-99-168.sslip.io"),
                           ("EZIL_AWS_ENROLL_URL", "https://os-staging.ezil.work/api/compute/aws/enroll")):
            with self.subTest(key=key):
                self.assertRefused({**self.values, key: value}, "Production refuses staging")

    def test_production_refuses_any_staging_or_sslip_host(self):
        for key, value in (("BILLING_FUNDING_URL", "https://ai-staging.ezil.work"),
                           ("CLOUDFLARE_GUACAMOLE_WORKER_URL", "https://api-desktop-staging.ezil.work"),
                           ("EZIL_AWS_ENROLL_URL", "https://db-preview.ezil.work/x"),
                           ("EZIL_AWS_BROWSER_ZONE", "13-206-183-230.sslip.io")):
            with self.subTest(key=key):
                self.assertRefused({**self.values, key: value}, "Production refuses staging")

    def test_production_pins_funding_url(self):
        renderer.validate({**self.values, "BILLING_FUNDING_URL": "https://ai.ezil.work"}, "production")
        self.assertRefused({**self.values, "BILLING_FUNDING_URL": "https://ai.ezil.work/"}, "BILLING_FUNDING_URL must be")

    def test_staging_pins_funding_url(self):
        staging = {key: "synthetic-value-never-log-1234567890" for key in renderer.REQUIRED}
        renderer.validate({**staging, "BILLING_FUNDING_URL": "https://ai-staging.ezil.work"})
        self.assertRefused({**staging, "BILLING_FUNDING_URL": "https://ai.ezil.work"}, "Staging BILLING_FUNDING_URL", "staging")

    def test_staging_refuses_production_values(self):
        staging = {key: "synthetic-value-never-log-1234567890" for key in renderer.REQUIRED}
        renderer.validate(dict(staging))  # Positive control: the staging shape is unchanged.
        renderer.validate({**staging, "STRIPE_SECRET": "sk_test_synthetic", "STRIPE_PUBLISHABLE_KEY": "pk_test_synthetic"})
        for key, value in (("NEXT_PUBLIC_SUPABASE_URL", "https://db.ezil.work"), ("SUPABASE_DATABASE_URL", PRODUCTION_DB)):
            with self.subTest(key=key):
                self.assertRefused({**staging, key: value}, "Staging refuses production", "staging")
        for key, value in (("STRIPE_SECRET", "sk_live_synthetic"), ("STRIPE_SECRET", "rk_live_synthetic"),
                           ("STRIPE_PUBLISHABLE_KEY", "pk_live_synthetic")):
            with self.subTest(key=key, value=value):
                self.assertRefused({**staging, key: value}, "Staging refuses Stripe live", "staging")
        # The production shape is refused by the default (staging) validation too.
        self.assertRefused(dict(self.values), "Staging refuses", "staging")

    def test_main_selects_secret_and_directory_per_environment(self):
        for argv, secret, directory, environment in (
                ([], "ezil-os/billing-staging/app", "/etc/ezil-os-staging", "staging"),
                (["staging"], "ezil-os/billing-staging/app", "/etc/ezil-os-staging", "staging"),
                (["production"], "ezil-os/production/app", "/etc/ezil-os-production", "production")):
            with self.subTest(argv=argv), patch.object(renderer.os, "geteuid", return_value=0), \
                 patch.object(renderer, "fetch_secret", return_value=self.values) as fetch, \
                 patch.object(renderer, "render") as render:
                self.assertEqual(renderer.main(argv), 0)
                fetch.assert_called_once_with(secret)
                render.assert_called_once_with(self.values, Path(directory), environment)
        for argv in (["prod"], ["production", "extra"], ["Production"]):
            output = io.StringIO()
            with self.subTest(argv=argv), patch.object(renderer, "fetch_secret") as fetch, \
                 contextlib.redirect_stderr(output):
                self.assertEqual(renderer.main(argv), 1)
                fetch.assert_not_called()

    def test_fetch_uses_production_secret(self):
        response = type("Response", (), {"returncode": 0,
            "stdout": json.dumps({"SecretString": json.dumps(self.values)})})()
        with patch.object(renderer.subprocess, "run", return_value=response) as run:
            self.assertEqual(renderer.fetch_secret("ezil-os/production/app"), self.values)
        self.assertIn("ezil-os/production/app", run.call_args[0][0])
        self.assertNotIn("ezil-os/billing-staging/app", run.call_args[0][0])

    def test_production_write_prints_names_only(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            output = io.StringIO()
            with contextlib.ExitStack() as stack:
                if os.geteuid() != 0:
                    stack.enter_context(patch.object(renderer.os, "geteuid", return_value=0))
                    stack.enter_context(patch.object(renderer.os, "chown"))
                    stack.enter_context(patch.object(renderer.os, "fchown"))
                with contextlib.redirect_stdout(output):
                    renderer.render(self.values, Path(temporary), "production")
            self.assertEqual(output.getvalue().splitlines(), sorted(self.values))
            self.assertNotIn("synthetic-password", output.getvalue())
            with self.assertRaises(renderer.RenderError):
                renderer.render(self.values, Path(temporary), "staging")


def b64url(number):
    return base64.urlsafe_b64encode(number.to_bytes(32, "big")).rstrip(b"=").decode()


# The published P-256 base point: a public constant, never live key material.
P256_G = {"kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": "synthetic-kid",
          "x": b64url(0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296),
          "y": b64url(0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5)}
DELEGATION_GATE = "EZIL_DELEGATED_COMPUTER_READS"
DELEGATION_NAMES = (DELEGATION_GATE, "EZIL_DELEGATION_ISSUER", "EZIL_DELEGATION_AUDIENCE",
                    "EZIL_DELEGATION_PUBLIC_JWKS", "EZIL_DELEGATION_CLIENT_IDS")


def delegation(keys=(P256_G,), **overrides):
    values = {DELEGATION_GATE: "enabled", "EZIL_DELEGATION_ISSUER": "https://mcp.example.invalid",
              "EZIL_DELEGATION_AUDIENCE": "https://os-prod.ezil.work",
              "EZIL_DELEGATION_PUBLIC_JWKS": json.dumps({"keys": list(keys)}, separators=(",", ":")),
              "EZIL_DELEGATION_CLIENT_IDS": "synthetic-client-a, synthetic-client-b"}
    values.update(overrides)
    return {name: value for name, value in values.items() if value is not None}


class DelegationEnvironmentTests(unittest.TestCase):
    """Config for the receiver in app/src/server/api/delegation-core.ts; its rejections fail rendering here."""

    def setUp(self):
        self.staging = {key: "synthetic-value-never-log-1234567890" for key in renderer.REQUIRED}
        self.production = {**self.staging, "NEXT_PUBLIC_SUPABASE_URL": "https://db.ezil.work",
                           "SUPABASE_DATABASE_URL": PRODUCTION_DB, "STRIPE_PUBLISHABLE_KEY": "pk_live_synthetic",
                           "STRIPE_SECRET": "sk_live_synthetic"}

    def refused(self, extra, environment="production"):
        base = self.production if environment == "production" else self.staging
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**base, **extra}, environment)

    def test_production_browser_canary_is_default_off_and_pins_one_exact_https_target(self):
        names = renderer.PRODUCTION_BROWSER_PINS
        pins = {names[0]: "12ac8d12-78cf-4850-8c11-23f874204eda",
                names[1]: "87fc8cee-4b15-4e17-a204-6d039a98a9c2", names[2]: "https://browser.fixture.example"}
        values = {
            **self.production,
            **delegation(EZIL_DELEGATION_ISSUER="https://connect.ezil.work", EZIL_DELEGATION_AUDIENCE="https://os.ezil.work"),
            "CLOUDFLARE_GUACAMOLE_WORKER_URL": "https://api-desktop.ezil.org",
            "CLOUDFLARE_GUACAMOLE_HMAC_SECRET": "fixture-only",
            renderer.PRODUCTION_BROWSER_GATE: "enabled", **pins,
        }
        self.assertEqual(renderer.validate(values, "production"), values)
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.staging, **pins}, "staging")
        for bad in ("http://127.0.0.1:44880", "https://127.0.0.1:44880", "https://browser.fixture.example/",
                    "https://browser.fixture.example/subpath", "https://browser.fixture.example,https://other.example"):
            with self.subTest(origin=bad), self.assertRaises(renderer.RenderError):
                renderer.validate({**values, names[2]: bad}, "production")
        for name in (*names, "CLOUDFLARE_GUACAMOLE_HMAC_SECRET", "CLOUDFLARE_GUACAMOLE_WORKER_URL"):
            with self.subTest(missing=name), self.assertRaises(renderer.RenderError):
                renderer.validate({key: value for key, value in values.items() if key != name}, "production")

    def test_names_are_optional_and_absence_changes_nothing(self):
        self.assertTrue(set(DELEGATION_NAMES) <= renderer.OPTIONAL)
        self.assertFalse(set(DELEGATION_NAMES) & renderer.REQUIRED)
        for base, environment in ((self.staging, "staging"), (self.production, "production")):
            self.assertEqual(renderer.validate(dict(base), environment), base)

    def test_complete_set_is_accepted_in_production_with_either_origin(self):
        for audience in renderer.PRODUCTION_OS_ORIGINS:
            values = {**self.production, **delegation(EZIL_DELEGATION_AUDIENCE=audience)}
            self.assertEqual(renderer.validate(dict(values), "production"), values)
        two = delegation(keys=(P256_G, {**P256_G, "kid": "rotated"}))
        renderer.validate({**self.production, **two}, "production")
        bare = {key: value for key, value in P256_G.items() if key not in ("alg", "use")}
        renderer.validate({**self.production, **delegation(keys=(bare,))}, "production")

    def test_gate_is_exact_and_never_enabled_by_omission(self):
        renderer.validate({**self.production, **delegation(**{DELEGATION_GATE: "disabled"})}, "production")
        renderer.validate({**self.production, **delegation(**{DELEGATION_GATE: None})}, "production")
        renderer.validate({**self.production, DELEGATION_GATE: "disabled"}, "production")
        for gate in ("true", "1", "Enabled", "ENABLED", "on", "yes", "enabled "):
            with self.subTest(gate=gate):
                self.refused(delegation(**{DELEGATION_GATE: gate}))
        self.refused({DELEGATION_GATE: "enabled"})

    def test_pins_are_all_or_nothing(self):
        for name in DELEGATION_NAMES[1:]:
            with self.subTest(missing=name):
                self.refused(delegation(**{name: None}))
                self.refused(delegation(**{name: None, DELEGATION_GATE: "disabled"}))

    def test_issuer_and_audience_are_one_bare_https_origin_each(self):
        for key in ("EZIL_DELEGATION_ISSUER", "EZIL_DELEGATION_AUDIENCE"):
            for bad in ("http://mcp.example.invalid", "https://mcp.example.invalid/", "https://mcp.example.invalid/x",
                        "https://mcp.example.invalid?x=1", "https://mcp.example.invalid#x", "https://Mcp.example.invalid",
                        "https://u:p@mcp.example.invalid", "https://mcp.example.invalid:443", "https://mcp.example.invalid:0",
                        "https://mcp.example.invalid:99999", "https://a.invalid,https://b.invalid", "https://a.invalid https://b.invalid",
                        "https://bad_host.invalid", "https://.invalid", "https://a..invalid", "mcp.example.invalid", "*"):
                with self.subTest(key=key, bad=bad):
                    self.refused(delegation(**{key: bad}))
        renderer.validate({**self.production, **delegation(EZIL_DELEGATION_ISSUER="https://mcp.example.invalid:8443")}, "production")
        self.refused(delegation(EZIL_DELEGATION_ISSUER="https://os-prod.ezil.work"))

    def test_client_ids_are_explicit(self):
        for bad in (" , ", "*", "synthetic-a *", "x" * 513):
            with self.subTest(bad=bad):
                self.refused(delegation(EZIL_DELEGATION_CLIENT_IDS=bad))
        renderer.validate({**self.production, **delegation(EZIL_DELEGATION_CLIENT_IDS="x" * 512)}, "production")

    def test_jwks_is_strict_and_public_only(self):
        jwks = lambda *keys, **top: json.dumps({"keys": list(keys), **top})
        bad = {
            "not JSON": "keys", "NaN": '{"keys":[NaN]}', "array": "[]", "no keys": jwks(), "four keys": jwks(
                *({**P256_G, "kid": f"k{n}"} for n in range(4))),
            "extra top member": jwks(P256_G, jku="https://x.invalid"), "keys not a list": '{"keys":{}}',
            "private member": jwks({**P256_G, "d": "A" * 43}), "extra member": jwks({**P256_G, "x5u": "https://x.invalid"}),
            "key not object": jwks("k"), "wrong kty": jwks({**P256_G, "kty": "OKP"}), "wrong crv": jwks({**P256_G, "crv": "P-384"}),
            "wrong alg": jwks({**P256_G, "alg": "RS256"}), "null alg": jwks({**P256_G, "alg": None}),
            "wrong use": jwks({**P256_G, "use": "enc"}), "no kid": jwks({k: v for k, v in P256_G.items() if k != "kid"}),
            "empty kid": jwks({**P256_G, "kid": ""}), "long kid": jwks({**P256_G, "kid": "k" * 129}),
            "numeric kid": jwks({**P256_G, "kid": 1}), "duplicate kid": jwks(P256_G, P256_G),
            "duplicate member": '{"keys":[%s],"keys":[%s]}' % (json.dumps(P256_G), json.dumps(P256_G)),
            "padded x": jwks({**P256_G, "x": P256_G["x"] + "="}), "short y": jwks({**P256_G, "y": P256_G["y"][:-1]}),
            "standard base64 x": jwks({**P256_G, "x": P256_G["x"][:-1] + "+"}),
            "non canonical x": jwks({**P256_G, "x": P256_G["x"][:-1] + "B"}), "missing y": jwks(
                {k: v for k, v in P256_G.items() if k != "y"}), "x not string": jwks({**P256_G, "x": 1}),
            "off curve": jwks({**P256_G, "y": b64url(2)}), "x out of range": jwks({**P256_G, "x": b64url(2**256 - 1)}),
        }
        for name, raw in bad.items():
            with self.subTest(name=name):
                self.refused(delegation(EZIL_DELEGATION_PUBLIC_JWKS=raw))
        self.refused(delegation(EZIL_DELEGATION_PUBLIC_JWKS="[" * 100000))

    def test_errors_do_not_echo_values(self):
        marker = "synthetic-secret-in-config"
        # Any plain string is a valid client ID, so the client list is exercised with a wildcard instead.
        for key, value in [(name, marker) for name in DELEGATION_NAMES[:-1]] + [
                ("EZIL_DELEGATION_CLIENT_IDS", marker + " *")]:
            with self.subTest(key=key):
                with self.assertRaises(renderer.RenderError) as caught:
                    renderer.validate({**self.production, **delegation(**{key: value})}, "production")
                self.assertNotIn(marker, str(caught.exception))

    def test_environments_stay_separate(self):
        staging_values = delegation(EZIL_DELEGATION_AUDIENCE="https://os-staging.ezil.work")
        renderer.validate({**self.staging, **staging_values}, "staging")
        self.refused(staging_values)  # Production refuses a staging audience (and any staging host).
        for audience in renderer.PRODUCTION_OS_ORIGINS:
            self.refused(delegation(EZIL_DELEGATION_AUDIENCE=audience), "staging")
        self.refused(delegation(EZIL_DELEGATION_AUDIENCE="https://os.ezil.org"))
        self.refused(delegation(EZIL_DELEGATION_ISSUER="https://mcp.13-203-99-168.sslip.io"))
        self.refused(delegation(EZIL_DELEGATION_CLIENT_IDS="https://ai-staging.ezil.work"))
        # Disabled does not bypass the check: a leftover wrong-environment pin still fails closed.
        self.refused(delegation(EZIL_DELEGATION_AUDIENCE="https://os-staging.ezil.work", **{DELEGATION_GATE: "disabled"}))

    def test_nearby_or_private_names_remain_refused(self):
        for key in ("EZIL_DELEGATION_PRIVATE_JWKS", "EZIL_DELEGATION_PRIVATE_KEY", "EZIL_DELEGATION_SIGNING_KEY",
                    "EZIL_DELEGATION_JWKS", "EZIL_DELEGATION_PUBLIC_JWKS_URL", "EZIL_DELEGATED_COMPUTER_WRITES",
                    "EZIL_DELEGATION_CLIENT_ID", "EZIL_DELEGATION_SECRET"):
            with self.subTest(key=key):
                self.refused({key: "synthetic"})

    def test_render_forwards_verbatim_prints_names_only_and_keeps_cron_unchanged(self):
        values = {**self.production, **delegation(EZIL_DELEGATION_CLIENT_IDS="synthetic-${NO_EXPAND}-#-client")}
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent) as temporary:
            output = io.StringIO()
            with contextlib.ExitStack() as stack:
                if os.geteuid() != 0:
                    stack.enter_context(patch.object(renderer.os, "geteuid", return_value=0))
                    stack.enter_context(patch.object(renderer.os, "chown"))
                    stack.enter_context(patch.object(renderer.os, "fchown"))
                with contextlib.redirect_stdout(output):
                    renderer.render(values, Path(temporary), "production")
            rendered = dict(line.split("=", 1) for line in (Path(temporary) / "app.env").read_text().splitlines())
            cron = (Path(temporary) / "cron.env").read_text()
        self.assertEqual(rendered, values)
        self.assertEqual(output.getvalue().splitlines(), sorted(values))
        for name in ("EZIL_DELEGATION_PUBLIC_JWKS", "EZIL_DELEGATION_CLIENT_IDS", "EZIL_DELEGATION_ISSUER"):
            self.assertNotIn(values[name], output.getvalue())
        self.assertNotIn("DELEGAT", cron)
        self.assertEqual(rendered[DELEGATION_GATE], "enabled")


if __name__ == "__main__":
    unittest.main()
