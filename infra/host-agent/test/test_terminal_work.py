#!/usr/bin/env python3
"""Unprivileged SIGNAL C parity tests: terminal work holds the AWS host's idle stop.
No root, runc or network; the shell probe runs with a fake ps and no tmux on PATH.
Run: python3 -m unittest -v test_terminal_work   (from infra/host-agent/test)."""
import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, config, desktop, terminal_work  # noqa: E402


def scratch(test):
    d = tempfile.mkdtemp(prefix="ezil-terminal-unit-")
    test.addCleanup(shutil.rmtree, d, True)
    for sub in ("state", "run", "data"):
        os.makedirs(os.path.join(d, sub), mode=0o700)
    with open(os.path.join(d, "state", "control.key"), "wb") as f:
        f.write(b"k" * 32)
    cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
    cfg.update(stateDir=os.path.join(d, "state"), runDir=os.path.join(d, "run"), dataMount=os.path.join(d, "data"))
    return d, cfg


class Parse(unittest.TestCase):
    def test_counts(self):
        for stdout, want in (("0 0", (0, 0)), ("2 1\n", (2, 1)), (" 3 0 ", (3, 0))):
            with self.subTest(stdout=stdout):
                self.assertEqual(terminal_work.parse(stdout), want)

    def test_malformed_counts(self):
        for stdout in ("", "1", "1 2 3", "-1 0", "a b", "1  2", "١ 0", "0 ١", "1\t2", "1\n2", None):
            with self.subTest(stdout=stdout):
                self.assertIsNone(terminal_work.parse(stdout))

    def test_safe_integer_limit_on_both_counts(self):
        cap = 2**53 - 1
        self.assertEqual(terminal_work.parse(f"{cap} {cap}"), (cap, cap))
        for stdout in (f"{cap + 1} 0", f"0 {cap + 1}", "9" * 5000 + " 0"):
            with self.subTest(length=len(stdout)):
                self.assertIsNone(terminal_work.parse(stdout))

    def test_leading_zeroes_do_not_change_the_value(self):
        self.assertEqual(terminal_work.parse("0" * 5000 + "2 01"), (2, 1))


class Verdict(unittest.TestCase):
    def test_every_reason(self):
        cases = (
            (None, (False, None, "probe_threw")),
            ((1, "1 0"), (False, None, "probe_exit_1")),
            ((-9, "1 0"), (False, None, "probe_exit_-9")),
            ((0, "garbage"), (False, None, "unparseable")),
            ((0, "0 0"), (False, (0, 0), "no_terminal_work")),
            ((0, "1 0"), (True, (1, 0), "live_tmux_sessions")),
            ((0, "0 2"), (True, (0, 2), "running_terminal_jobs")),
            ((0, "3 1"), (True, (3, 1), "live_tmux_sessions")),
        )
        for probe, want in cases:
            with self.subTest(probe=probe):
                self.assertEqual(terminal_work.verdict(probe, 600), want)

    def test_cap_boundary(self):
        cap = terminal_work.TERMINAL_KEEPALIVE_MAX_SECONDS
        self.assertEqual(cap, 8 * 60 * 60)
        self.assertEqual(terminal_work.verdict((0, "3 1"), cap - 1), (True, (3, 1), "live_tmux_sessions"))
        self.assertEqual(terminal_work.verdict((0, "3 1"), cap),
                         (False, (3, 1), "terminal_keepalive_expired"))

    def test_nonfinite_idle_age_does_not_hold(self):
        for idle in (float("nan"), float("inf")):
            with self.subTest(idle=idle):
                self.assertEqual(terminal_work.verdict((0, "1 0"), idle),
                                 (False, (1, 0), "terminal_keepalive_expired"))

    def test_no_work_takes_precedence_over_expired_cap(self):
        self.assertEqual(terminal_work.verdict((0, "0 0"), terminal_work.TERMINAL_KEEPALIVE_MAX_SECONDS),
                         (False, (0, 0), "no_terminal_work"))


class ScriptParity(unittest.TestCase):
    def test_script_matches_worker_verbatim(self):
        root = os.environ.get("EZIL_HOST_REPO", os.path.join(HERE, "..", "..", ".."))
        path = os.path.join(root, "worker", "src", "terminal-keepalive.ts")
        if not os.path.isfile(path):
            self.skipTest("Worker spec not present in this checkout")
        with open(path) as f:
            source = f.read()
        match = re.search(r"TERMINAL_WORK_SCRIPT\s*=\s*(\[.*?\])\.join", source, re.DOTALL)
        self.assertIsNotNone(match)
        lines = ast.literal_eval(match.group(1))
        self.assertEqual(lines[-1], "")
        self.assertEqual("\n".join(lines), terminal_work.SCRIPT)
        self.assertTrue(terminal_work.SCRIPT.endswith("\n"))


class ScriptSemantics(unittest.TestCase):
    def setUp(self):
        self.bin = tempfile.mkdtemp(prefix="ezil-terminal-path-")
        self.addCleanup(shutil.rmtree, self.bin, True)
        for name in ("awk", "wc", "timeout"):
            real = shutil.which(name)
            self.assertIsNotNone(real, f"{name} required for shell semantics test")
            os.symlink(real, os.path.join(self.bin, name))

    def run_probe(self, lines=(), rc=0):
        path = os.path.join(self.bin, "ps")
        with open(path, "w") as f:
            f.write("#!/bin/sh\n")
            if lines:
                f.write("printf '%s\\n' " + " ".join(shlex.quote(line) for line in lines) + "\n")
            f.write(f"exit {rc}\n")
        os.chmod(path, 0o700)
        result = subprocess.run(["/bin/sh", "-c", terminal_work.SCRIPT], env={"PATH": self.bin},
                                capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_only_pts_session_leaders_with_foreground_jobs_count(self):
        cases = (
            ("100 100 100 101 pts/0", 1),  # foreground command
            ("200 200 200 200 pts/1", 0),  # idle prompt
            ("300 300 300 301 ?", 0),      # no terminal
            ("400 400 400 401 tty1", 0),   # not a pseudo-terminal
            ("501 500 500 502 pts/2", 0),  # not the session leader
            ("600 600 600 -1 pts/3", 0),   # no foreground group
            ("700 700 700 0 pts/4", 0),
        )
        for line, count in cases:
            with self.subTest(line=line):
                self.assertEqual(self.run_probe([line]), f"0 {count}\n")
        lines = [line for line, _ in cases] + ["800 800 800 801 pts/5"]
        self.assertEqual(self.run_probe(lines), "0 2\n")

    def test_ps_failure_counts_as_no_jobs(self):
        self.assertEqual(self.run_probe(rc=1), "0 0\n")


class Probe(unittest.TestCase):
    def test_exec_argv_options_and_result(self):
        cfg = object()
        argv = ["/bin/sh", "-c", terminal_work.SCRIPT]
        for rc in (0, 1):
            with self.subTest(rc=rc), mock.patch.object(desktop, "exec_", return_value=
                                                       subprocess.CompletedProcess(argv, rc, "2 1\n", "")) as execute:
                self.assertEqual(terminal_work.probe(cfg), (rc, "2 1\n"))
                execute.assert_called_once_with(cfg, argv, capture_output=True, text=True,
                                                stdin=subprocess.DEVNULL, timeout=30)

    def test_any_exception_means_unknown(self):
        errors = (OSError("exec failed"), subprocess.TimeoutExpired("runc", 30),
                  UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid byte"), RuntimeError("unexpected"))
        for error in errors:
            with self.subTest(error=type(error).__name__), mock.patch.object(desktop, "exec_", side_effect=error):
                self.assertIsNone(terminal_work.probe(object()))


class AgentTick(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.now, self.logs = 100000.0, []
        self.a = agentmod.Agent(self.cfg, {"generation": 1, "leaseEpoch": 2},
                               clock=lambda: self.now, log=self.logs.append)
        self.a.last_presence = self.now - 600
        self.stopping = os.path.join(self.cfg.runDir, "stopping")
        stack = ExitStack()
        self.addCleanup(stack.close)
        # Patch only pre-SIGNAL-C names: these integration tests must fail on the old tick().
        self.state = stack.enter_context(mock.patch.object(agentmod.desktop, "state", return_value="running"))
        self.execute = stack.enter_context(mock.patch.object(agentmod.desktop, "exec_"))
        self.load = stack.enter_context(mock.patch("builtins.open", mock.mock_open(read_data="0.01 0 0 1/1 1")))
        self.flush = stack.enter_context(mock.patch.object(self.a, "flush", return_value="ok"))
        self.shutdown = stack.enter_context(mock.patch.object(self.a, "shutdown"))
        self.output("0 0")

    def output(self, stdout, rc=0):
        argv = ["/bin/sh", "-c", terminal_work.SCRIPT]
        self.execute.return_value = subprocess.CompletedProcess(argv, rc, stdout, "")

    def assert_held(self, counts, reason):
        self.assertEqual(self.a.tick(), "held_terminal")
        self.execute.assert_called_once()
        self.load.assert_not_called()
        self.flush.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertFalse(os.path.exists(self.stopping))
        idle = int(self.now - self.a.last_presence)
        self.assertEqual(self.logs, [f"idle stop held: tmuxSessions/terminalJobs={counts} reason={reason} idle={idle}s"])

    def assert_stopped(self, reason=None, counts="unknown"):
        self.assertEqual(self.a.tick(), "stopped")
        self.load.assert_called_once_with("/proc/loadavg")
        self.flush.assert_called_once_with(blockable=True)
        self.shutdown.assert_called_once_with("idle")
        self.assertTrue(os.path.exists(self.stopping))
        if reason:
            self.assertEqual(self.logs, [f"terminal hold: none (tmuxSessions/terminalJobs={counts} reason={reason})"])

    def test_tmux_session_holds_idle_stop(self):
        self.output("1 0")
        self.assert_held("1/0", "live_tmux_sessions")

    def test_foreground_terminal_jobs_hold_idle_stop(self):
        self.output("0 2")
        self.assert_held("0/2", "running_terminal_jobs")

    def test_terminal_hold_precedes_busy_load(self):
        self.output("1 0")
        self.load.return_value.read.return_value = "9.0 0 0 1/1 1"
        self.assert_held("1/0", "live_tmux_sessions")

    def test_terminal_hold_precedes_unparseable_load(self):
        self.output("1 0")
        self.load.return_value.read.return_value = "garbage"
        self.assert_held("1/0", "live_tmux_sessions")

    def test_terminal_hold_precedes_unreadable_load(self):
        self.output("1 0")
        self.load.side_effect = OSError("unreadable")
        self.assert_held("1/0", "live_tmux_sessions")

    def test_presence_during_the_probe_cancels_the_stop(self):
        def returning_user(*_args, **_kwargs):
            self.a.last_presence = self.now     # a presence report lands while the probe runs
            return subprocess.CompletedProcess(["/bin/sh"], 0, "0 0", "")
        self.execute.side_effect = returning_user
        self.assertEqual(self.a.tick(), "active")
        self.flush.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertFalse(os.path.exists(self.stopping))

    def test_presence_does_not_probe(self):
        self.a.last_presence = self.now - 599
        self.assertEqual(self.a.tick(), "active")
        self.state.assert_not_called()
        self.execute.assert_not_called()
        self.load.assert_not_called()
        self.flush.assert_not_called()
        self.shutdown.assert_not_called()
        self.assertFalse(os.path.exists(self.stopping))

    def test_stopped_desktop_does_not_probe(self):
        self.state.return_value = "stopped"
        self.assert_stopped("desktop_not_running")
        self.execute.assert_not_called()

    def test_absent_desktop_does_not_probe(self):
        self.state.return_value = "absent"
        self.assert_stopped("desktop_not_running")
        self.execute.assert_not_called()

    def test_desktop_state_failure_does_not_probe(self):
        self.state.side_effect = OSError("state failed")
        self.assert_stopped("desktop_not_running")
        self.execute.assert_not_called()

    def test_unexpected_desktop_state_exception_does_not_end_agent(self):
        self.state.side_effect = RuntimeError("unexpected")
        self.assert_stopped()
        self.execute.assert_not_called()

    def test_exec_failure_does_not_hold(self):
        self.execute.side_effect = OSError("exec failed")
        self.assert_stopped("probe_threw")

    def test_exec_timeout_does_not_hold(self):
        self.execute.side_effect = subprocess.TimeoutExpired("runc", 30)
        self.assert_stopped("probe_threw")

    def test_undecodable_output_does_not_hold(self):
        self.execute.side_effect = UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid byte")
        self.assert_stopped("probe_threw")

    def test_nonzero_exit_does_not_hold(self):
        self.output("1 0", rc=1)
        self.assert_stopped("probe_exit_1")

    def test_malformed_output_does_not_hold(self):
        self.output("garbage")
        self.assert_stopped("unparseable")

    def test_no_work_preserves_idle_shutdown(self):
        self.assert_stopped()
        self.assertEqual(self.logs, [])

    def test_cap_expires_at_exactly_eight_hours(self):
        self.a.last_presence = self.now - 8 * 60 * 60
        self.output("3 1")
        self.assert_stopped("terminal_keepalive_expired", "3/1")

    def test_holds_until_eight_hours(self):
        self.a.last_presence = self.now - (8 * 60 * 60 - 60)
        self.output("3 1")
        self.assert_held("3/1", "live_tmux_sessions")

    def test_logging_failure_does_not_end_agent(self):
        def fail_log(message):
            raise RuntimeError("log failed")
        self.a.log = fail_log
        self.output("1 0")
        self.assert_stopped()

    def test_control_plane_stop_does_not_probe(self):
        self.a.stop_request = {"kind": "stop", "warn": 0, "reason": "cap"}
        self.output("1 0")
        self.assertEqual(self.a.tick(), "stopped")
        self.state.assert_not_called()
        self.execute.assert_not_called()
        self.load.assert_not_called()
        self.flush.assert_called_once_with(blockable=False)
        self.shutdown.assert_called_once_with("stop:cap flush=ok")


if __name__ == "__main__":
    unittest.main()
