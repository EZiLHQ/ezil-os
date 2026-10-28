import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
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

    def test_feedback_keys_are_optional(self):
        # In-product feedback (docs/feedback-migration.md): off unless set, so
        # every key is optional and none is required for a working app.
        feedback = {"EZIL_OS_FEEDBACK": "1", "EZIL_OS_FEEDBACK_SCREENSHOTS": "1",
                    "FEEDBACK_PILOT_EMAILS": "a@example.com,b@example.com",
                    "FEEDBACK_ADMIN_EMAILS": "contact@ezil.work"}
        self.assertEqual(renderer.validate({**self.values, **feedback}), {**self.values, **feedback})
        self.assertTrue(set(feedback) <= renderer.OPTIONAL)
        self.assertFalse(set(feedback) & renderer.REQUIRED)
        renderer.validate(dict(self.values))
        # The floating-controls pill is not part of this build; its flag stays refused.
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_OS_FLOATING_CONTROLS": "1"})
        with self.assertRaises(renderer.RenderError):
            renderer.validate({**self.values, "EZIL_OS_FEEDBACK": ""})

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


if __name__ == "__main__":
    unittest.main()
