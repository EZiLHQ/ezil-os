#!/usr/bin/env python3
"""Unprivileged unit tests (no root, runc, Docker or network) for:
  * terminal history: PROMPT_COMMAND injection, the profile.d file, and the pre-stop
    SIGHUP that makes an open shell save a still-running command — exercised on REAL
    interactive bash shells in ptys, with controls that show the gap without the fix;
  * desktop.stop() outcomes and the agent's flush/idle/stop-record mapping;
  * the firewall drift check comparing rule ORDER, and netns_down's exit status.
Run: python3 -m unittest -v test_history_stop   (from infra/host-agent/test)."""
import json
import os
import pty
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, config, desktop  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

BASH = shutil.which("bash")


HOST_NS = os.readlink(f"/proc/{os.getpid()}/ns/pid")


def env_list_to_dict(env):
    return dict(e.split("=", 1) for e in env)


class Shell:
    """An interactive bash on a pty, like a terminal window."""

    def __init__(self, home, env_extra=None, args=("--norc", "--noprofile"), tty=True):
        self.histfile = os.path.join(home, ".bash_history")
        env = {"HOME": home, "HISTFILE": self.histfile, "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
               "TERM": "dumb", "PS1": "EZPROMPT$ "}
        env.update(env_extra or {})
        if tty:
            self.pid, self.fd = pty.fork()
            if self.pid == 0:
                os.execve(BASH, [BASH, *args, "-i"], env)
        else:
            # two commands: `bash -c 'sleep 30'` alone would exec sleep and stop being bash
            p = subprocess.Popen([BASH, "-c", "sleep 30; :"], env=env, stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            self.pid, self.fd, self.popen = p.pid, None, p
        self.buf = b""
        if tty:
            self.expect(b"EZPROMPT$ ")

    def expect(self, needle, timeout=10):
        end = time.time() + timeout
        while needle not in self.buf:
            r, _, _ = select.select([self.fd], [], [], max(0.0, end - time.time()))
            if not r:
                raise AssertionError(f"timeout waiting for {needle!r}; got {self.buf[-300:]!r}")
            try:
                self.buf += os.read(self.fd, 4096)
            except OSError:
                raise AssertionError(f"pty closed waiting for {needle!r}; got {self.buf[-300:]!r}")
        self.buf = self.buf.split(needle, 1)[1]

    def run(self, line):
        os.write(self.fd, line.encode() + b"\n")

    def alive(self):
        try:
            pid, _ = os.waitpid(self.pid, os.WNOHANG)
            return pid == 0
        except ChildProcessError:
            return False

    def wait_exit(self, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            if not self.alive():
                return True
            if self.fd is not None:          # keep draining like a terminal emulator would
                r, _, _ = select.select([self.fd], [], [], 0.1)
                if r:
                    try:
                        os.read(self.fd, 4096)
                    except OSError:
                        pass
            else:
                time.sleep(0.1)
        return False

    def kill(self):
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        self.wait_exit()
        if self.fd is not None:
            os.close(self.fd)

    def history(self):
        try:
            with open(self.histfile) as f:
                return f.read()
        except FileNotFoundError:
            return ""


@unittest.skipUnless(BASH, "bash required")
class HistoryInjection(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="ezil-hist-unit-")
        self.addCleanup(shutil.rmtree, self.home, True)

    def test_with_history_prepends_and_keeps_existing(self):
        env = env_list_to_dict(desktop.with_history(["A=1"]))
        self.assertEqual(env["PROMPT_COMMAND"], desktop.HISTORY_PROMPT)
        out = desktop.with_history(["PROMPT_COMMAND=echo hi", "B=2"])
        self.assertEqual([e for e in out if e.startswith("PROMPT_COMMAND=")],
                         [f"PROMPT_COMMAND={desktop.HISTORY_PROMPT}; echo hi"])
        self.assertEqual(desktop.with_history(["PROMPT_COMMAND=history -a"])[-1], "PROMPT_COMMAND=history -a")

    def test_build_spec_injects_env_and_readonly_profile(self):
        run = os.path.join(self.home, "run")
        img = os.path.join(self.home, "image.json")
        with open(img, "w") as f:
            json.dump({"Env": ["PATH=/usr/bin:/bin"], "WorkingDir": "/"}, f)
        cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        cfg.update({"runDir": run, "imageConfigFile": img, "dataMount": os.path.join(self.home, "data"),
                    "seccompProfile": os.path.join(HERE, "..", "security", "seccomp.json")})
        bundle = desktop.build_spec(cfg, {"generation": 1, "leaseEpoch": 1})
        spec = json.load(open(os.path.join(bundle, "config.json")))
        env = env_list_to_dict(spec["process"]["env"])
        self.assertEqual(env["PROMPT_COMMAND"], desktop.HISTORY_PROMPT)
        m = [x for x in spec["mounts"] if x["destination"] == "/etc/profile.d/ezil-history.sh"]
        self.assertEqual(len(m), 1)
        self.assertIn("ro", m[0]["options"])
        self.assertEqual(open(m[0]["source"]).read(), desktop.HISTORY_PROFILE)

    def _typed_then_killed(self, env_extra, args=("--norc", "--noprofile")):
        sh = Shell(self.home, env_extra, args)
        try:
            sh.run("echo ezil-unit-$((40+2))")
            sh.expect(b"ezil-unit-42")
            sh.expect(b"EZPROMPT$ ")
            before_kill = sh.history()
        finally:
            sh.kill()                         # a stop that ends in KILL: bash never exits normally
        return before_kill, sh.history()

    def test_control_without_fix_open_terminal_history_is_lost(self):
        before, after = self._typed_then_killed({})
        self.assertNotIn("echo ezil-unit-", after, "control: plain bash must lose the line on KILL")

    def test_prompt_command_appends_each_command_while_terminal_is_open(self):
        before, after = self._typed_then_killed({"PROMPT_COMMAND": env_list_to_dict(desktop.with_history([]))["PROMPT_COMMAND"]})
        self.assertIn("echo ezil-unit-$((40+2))", before, "line must be in HISTFILE while the shell is still open")
        self.assertIn("echo ezil-unit-$((40+2))", after)

    def test_prompt_command_survives_vscode_style_wrapping(self):
        # VS Code's bash integration stores the inherited PROMPT_COMMAND and evals it
        # from its own prompt function: mimic that wrapper in an rc file.
        rc = os.path.join(self.home, "vsc-rc")
        with open(rc, "w") as f:
            f.write('__orig=${PROMPT_COMMAND:-}\n__wrap(){ local c; for c in "${__orig[@]}"; do eval "${c:-}"; done; }\n'
                    "PROMPT_COMMAND=__wrap\nPS1='EZPROMPT$ '\n")
        before, after = self._typed_then_killed({"PROMPT_COMMAND": desktop.HISTORY_PROMPT},
                                                args=("--noprofile", "--rcfile", rc))
        self.assertIn("echo ezil-unit-$((40+2))", before)

    def test_profile_d_script_covers_shells_without_the_env(self):
        prof = os.path.join(self.home, "ezil-history.sh")
        with open(prof, "w") as f:
            f.write(desktop.HISTORY_PROFILE)
        rc = os.path.join(self.home, "login-rc")          # /etc/bash.bashrc resets PS1 under --rcfile
        with open(rc, "w") as f:
            f.write(f'. "{prof}"\nPS1="EZPROMPT$ "\n')
        before, after = self._typed_then_killed({}, args=("--noprofile", "--rcfile", rc))
        self.assertIn("echo ezil-unit-$((40+2))", before)
        # POSIX sh (dash) sources /etc/profile.d too: it must parse and do nothing there
        sh = shutil.which("dash") or shutil.which("sh")
        r = subprocess.run([sh, "-c", f'. "{prof}"; echo "pc=${{PROMPT_COMMAND:-unset}}"'], capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "pc=unset"))
        # and it does not stack a second history -a on top of the env one
        r = subprocess.run([BASH, "--noprofile", "--norc", "-i", "-c", f'. "{prof}"; echo "[$PROMPT_COMMAND]"'],
                           env={"PATH": "/usr/bin:/bin", "PROMPT_COMMAND": desktop.HISTORY_PROMPT, "HOME": self.home},
                           capture_output=True, text=True)
        self.assertIn(f"[{desktop.HISTORY_PROMPT}]", r.stdout)


@unittest.skipUnless(BASH, "bash required")
class HangupBeforeStop(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="ezil-hist-unit-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))

    def test_running_command_is_saved_when_the_terminal_shell_is_hung_up(self):
        sh = Shell(self.home)                 # no PROMPT_COMMAND: only the hangup can save it
        try:
            sh.run("sleep 30 # ezil-unit-running")
            time.sleep(0.5)
            self.assertNotIn("ezil-unit-running", sh.history())
            n = desktop.hangup_shells(self.cfg, settle=5.0, pids=[sh.pid], scope=HOST_NS)
            self.assertEqual(n, 1)
            self.assertTrue(sh.wait_exit(5), "hung-up shell must exit")
            self.assertIn("sleep 30 # ezil-unit-running", sh.history())
        finally:
            sh.kill()

    def test_scripts_and_non_shells_are_not_hung_up(self):
        script = Shell(self.home, tty=False)          # bash without a terminal: a script
        cat_pid, cat_fd = pty.fork()                   # a non-shell on a terminal
        if cat_pid == 0:
            os.execvp("cat", ["cat"])
        try:
            time.sleep(0.3)
            self.assertEqual(desktop._proc_shell_on_tty(script.pid), ("bash", 0), "precondition: a real bash with no tty")
            self.assertEqual(desktop._proc_shell_on_tty(cat_pid)[0], "cat")
            n = desktop.hangup_shells(self.cfg, settle=0.5, pids=[script.pid, cat_pid, 999999999], scope=HOST_NS)
            self.assertEqual(n, 0)
            self.assertTrue(script.alive())
            self.assertEqual(os.waitpid(cat_pid, os.WNOHANG)[0], 0)
        finally:
            script.popen.kill(); script.popen.wait()
            os.kill(cat_pid, signal.SIGKILL); os.waitpid(cat_pid, 0); os.close(cat_fd)


@unittest.skipUnless(BASH, "bash required")
class HangupScope(unittest.TestCase):
    """The pid -> pidfd race: membership is re-checked after the pin (container pid ns)."""

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="ezil-hist-unit-")
        self.addCleanup(shutil.rmtree, self.home, True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))

    def test_a_terminal_shell_outside_the_container_namespace_is_never_hung_up(self):
        sh = Shell(self.home)                 # a real bash on a tty, but in the HOST pid ns
        try:
            time.sleep(0.3)
            n = desktop.hangup_shells(self.cfg, settle=0.5, pids=[sh.pid], scope="pid:[1]")
            self.assertEqual(n, 0)
            self.assertTrue(sh.alive(), "a host shell (e.g. a recycled pid) must not get SIGHUP")
        finally:
            sh.kill()

    def test_membership_is_read_after_the_pidfd_pin(self):
        sh = Shell(self.home)
        order = []
        real_open, real_ns = os.pidfd_open, desktop._pid_ns
        try:
            time.sleep(0.3)
            with mock.patch.object(desktop.os, "pidfd_open", side_effect=lambda p: (order.append("pin"), real_open(p))[1]), \
                 mock.patch.object(desktop, "_pid_ns", side_effect=lambda p: (order.append("ns"), real_ns(p))[1]):
                n = desktop.hangup_shells(self.cfg, settle=5.0, pids=[sh.pid], scope=HOST_NS)
            self.assertEqual(n, 1)
            self.assertEqual(order[:2], ["pin", "ns"], "the namespace must be checked on the pinned process")
        finally:
            sh.kill()

    def test_no_container_means_nothing_is_signalled(self):
        sh = Shell(self.home)
        try:
            time.sleep(0.3)
            with mock.patch.object(desktop, "container_scope", return_value=None):
                self.assertEqual(desktop.hangup_shells(self.cfg, settle=0.5, pids=[sh.pid]), 0)
            self.assertTrue(sh.alive())
        finally:
            sh.kill()

    def test_no_scope_and_unreadable_namespace_never_match(self):
        # None == None must not count as membership: with the container gone and a pid whose
        # /proc/<pid>/ns/pid cannot be read, nothing is signalled.
        sh = Shell(self.home)
        try:
            time.sleep(0.3)
            with mock.patch.object(desktop, "container_scope", return_value=None), \
                 mock.patch.object(desktop, "_pid_ns", return_value=None):
                self.assertEqual(desktop.hangup_shells(self.cfg, settle=0.5, pids=[sh.pid]), 0)
            self.assertTrue(sh.alive())
        finally:
            sh.kill()

    def test_container_scope_is_the_init_pid_namespace(self):
        class R:
            def __init__(self, rc, out):
                self.returncode, self.stdout = rc, out
        with mock.patch.object(desktop, "runc", return_value=R(0, json.dumps({"pid": os.getpid()}))):
            self.assertEqual(desktop.container_scope(self.cfg), HOST_NS)
        for r in (R(1, ""), R(0, json.dumps({"pid": 1})), R(0, json.dumps({"pid": True})), R(0, "not json")):
            with mock.patch.object(desktop, "runc", return_value=r):
                self.assertIsNone(desktop.container_scope(self.cfg))


class StopOutcome(unittest.TestCase):
    def setUp(self):
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))

    def _fake(self, exits_on_term):
        st = {"s": "running", "calls": []}

        def runc(cfg, *args, **kw):
            st["calls"].append(args)
            if args[0] == "kill" and (args[-1] == "KILL" or exits_on_term):
                st["s"] = "stopped"
            if args[0] == "delete":
                st["s"] = "absent"
            return subprocess.CompletedProcess(args, 1 if args[0] == "ps" else 0, "", "")
        return st, runc

    def test_absent(self):
        with mock.patch.object(desktop, "state", return_value="absent"):
            self.assertEqual(desktop.stop(self.cfg), "absent")

    def test_clean_and_killed(self):
        for exits, want in ((True, "clean"), (False, "killed")):
            st, runc = self._fake(exits)
            with mock.patch.object(desktop, "runc", runc), mock.patch.object(desktop, "state", lambda cfg: st["s"]):
                self.assertEqual(desktop.stop(self.cfg, grace=0.6), want)
            self.assertEqual(st["calls"][-1][0], "delete")

    def test_forced_kill_is_killed(self):
        st, runc = self._fake(True)
        with mock.patch.object(desktop, "runc", runc), mock.patch.object(desktop, "state", lambda cfg: st["s"]):
            self.assertEqual(desktop.stop(self.cfg, kill=True), "killed")
        self.assertFalse(any(c[0] == "ps" for c in st["calls"]), "a forced kill does not wait on shells")


class AgentStopRecord(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ezil-agent-unit-")
        self.addCleanup(shutil.rmtree, self.d, True)
        for sub in ("state", "run", "data"):
            os.makedirs(os.path.join(self.d, sub))
        with open(os.path.join(self.d, "state", "control.key"), "wb") as f:
            f.write(b"k" * 32)
        self.lease = {"generation": 3, "leaseEpoch": 7}
        with open(os.path.join(self.d, "run", "guard-ok"), "w") as f:
            json.dump(self.lease, f)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update({"stateDir": os.path.join(self.d, "state"), "runDir": os.path.join(self.d, "run"),
                         "dataMount": os.path.join(self.d, "data")})
        self.cfg["idle"]["flushTimeoutSeconds"] = 5
        self.a = agentmod.Agent(self.cfg, self.lease, log=lambda m: None)

    def flush_with(self, outcome, sync_rc=0):
        sync = lambda argv, **kw: subprocess.CompletedProcess(argv, sync_rc, "", "")  # noqa: E731 (host IO-independent)
        with mock.patch.object(agentmod.desktop, "stop", return_value=outcome), \
                mock.patch.object(agentmod, "dpkg_lock_held", return_value=False), \
                mock.patch.object(agentmod.subprocess, "run", sync):
            return self.a.flush(blockable=True)

    def test_killed_stop_is_never_ok(self):
        self.assertEqual(self.flush_with("clean"), "ok")
        self.assertEqual(self.flush_with("absent"), "ok")
        self.assertEqual(self.flush_with("killed"), "unclean")
        self.assertEqual(self.flush_with("absent"), "ok")
        self.assertEqual(self.a.stop_outcome, "killed", "worst outcome of the boot is kept")
        self.assertEqual(self.flush_with("clean", sync_rc=1), "failed")

    def test_idle_tick_stops_on_unclean_and_blocks_on_busy(self):
        calls = []
        self.a.last_presence = 0
        with mock.patch.object(self.a, "shutdown", side_effect=calls.append), \
                mock.patch("builtins.open", mock.mock_open(read_data="0.01 0 0 1/1 1")):
            with mock.patch.object(self.a, "flush", return_value="unclean"):
                self.assertEqual(self.a.tick(), "stopped")
            with mock.patch.object(self.a, "flush", return_value="busy"):
                self.assertEqual(self.a.tick(), "flush_busy")
        self.assertEqual(calls, ["idle flush=unclean"])

    def test_record_written_durably_and_reported_at_boot(self):
        self.a.stop_outcome = "killed"
        with mock.patch.object(agentmod.guard, "is_mounted", return_value=True):
            self.a.record_stop("idle flush=unclean")
        p = os.path.join(self.cfg.dataMount, desktop.STOP_RECORD)
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        rec = desktop.read_stop_record(self.cfg)
        self.assertEqual((rec["outcome"], rec["reason"], rec["generation"], rec["leaseEpoch"]),
                         ("killed", "idle flush=unclean", 3, 7))
        with mock.patch.object(desktop, "remove_singletons", return_value=[]), \
                mock.patch.object(desktop, "clear_dir", return_value=0):
            self.assertEqual(desktop.host_clean(self.cfg)["lastStop"]["outcome"], "killed")

    def test_shutdown_records_the_outcome_before_the_volume_unmounts(self):
        p = os.path.join(self.cfg.dataMount, desktop.STOP_RECORD)
        seen = []

        def run(argv, **kw):
            if argv[0] == "umount":
                seen.append(os.path.exists(p))
            return subprocess.CompletedProcess(argv, 0, "", "")
        with mock.patch.object(agentmod.tunnel, "fence"), mock.patch.object(agentmod.time, "sleep"), \
                mock.patch.object(agentmod.desktop, "stop", return_value="killed"), \
                mock.patch.object(agentmod.desktop, "overlay_umount"), mock.patch.object(agentmod.desktop, "netns_down"), \
                mock.patch.object(agentmod.guard, "clear_stamp"), mock.patch.object(agentmod.guard, "is_mounted", return_value=True), \
                mock.patch.object(agentmod.subprocess, "run", run):
            self.a.shutdown("stop:cap flush=unclean")
        self.assertEqual(seen, [True], "the record must exist when the data volume is unmounted")
        self.assertEqual(desktop.read_stop_record(self.cfg)["outcome"], "killed")

    def test_record_refused_without_the_data_volume(self):
        with mock.patch.object(agentmod.guard, "is_mounted", return_value=False):
            with self.assertRaises(Refused):
                self.a.record_stop("idle")
        self.assertFalse(os.path.exists(os.path.join(self.cfg.dataMount, desktop.STOP_RECORD)))

    def test_hostile_or_garbage_record_reads_as_unreadable(self):
        p = os.path.join(self.cfg.dataMount, desktop.STOP_RECORD)
        self.assertIsNone(desktop.read_stop_record(self.cfg))
        os.symlink("/etc/passwd", p)
        self.assertEqual(desktop.read_stop_record(self.cfg), {"outcome": "unreadable"})
        os.unlink(p)
        with open(p, "w") as f:
            f.write('{"outcome": "fine", "reason": 5}')
        self.assertEqual(desktop.read_stop_record(self.cfg)["outcome"], "unreadable")


class FakeIptables:
    """In-memory iptables for one table: -N -X -F -A -C -S, identity canonical form."""

    def __init__(self):
        self.chains = {"FORWARD": [], "INPUT": [], "POSTROUTING": []}
        self.policy = {"FORWARD": "ACCEPT", "INPUT": "ACCEPT", "POSTROUTING": "ACCEPT"}

    def __call__(self, cfg, argv, check=True, host=True):
        a = argv[argv.index("-t") + 2:]
        op, chain, rest = a[0], a[1], a[2:]
        rc, out = 0, ""
        if op == "-N":
            rc = 1 if chain in self.chains else 0
            self.chains.setdefault(chain, [])
        elif op == "-X":
            rc = 0 if self.chains.pop(chain, None) is not None else 1
        elif op == "-F":
            rc = 0 if chain in self.chains else 1
            if chain in self.chains:
                self.chains[chain] = []
        elif op == "-A":
            self.chains[chain].append(" ".join(rest))
        elif op == "-C":
            rc = 0 if " ".join(rest) in self.chains.get(chain, []) else 1
        elif op == "-S":
            if chain not in self.chains:
                rc = 1
            else:
                head = [f"-P {chain} {self.policy[chain]}"] if chain in self.policy else [f"-N {chain}"]
                out = "\n".join(head + [f"-A {chain} {r}" for r in self.chains[chain]]) + "\n"
        if check and rc:
            raise subprocess.CalledProcessError(rc, argv)
        return subprocess.CompletedProcess(argv, rc, out, "")


class DriftOrder(unittest.TestCase):
    def setUp(self):
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.key = ("iptables", "filter", "EZIL-CT-FWD")
        self.rules = desktop.desired_rules(self.cfg)[self.key]
        self.fake = FakeIptables()
        self.fake.chains["EZIL-CT-FWD"] = [" ".join(r) for r in self.rules]
        self.fake.chains["FORWARD"] = ["-j EZIL-CT-FWD"]

    def ok(self):
        with mock.patch.object(desktop, "_run", self.fake):
            return desktop._chain_ok(self.cfg, *self.key, self.rules)

    def test_in_order_chain_is_ok_and_scratch_chain_is_removed(self):
        self.assertTrue(self.ok())
        self.assertNotIn("EZIL-CT-FWD-C", self.fake.chains)

    def test_accept_moved_ahead_of_the_drops_is_drift(self):
        live = self.fake.chains["EZIL-CT-FWD"]
        accept = " ".join(["-i", desktop.HOST_IF, "-j", "ACCEPT"])
        live.remove(accept)
        live.insert(0, accept)
        self.assertEqual(sorted(live), sorted(" ".join(r) for r in self.rules), "same members, only the order differs")
        self.assertFalse(self.ok())

    def test_missing_rule_is_drift(self):
        self.fake.chains["EZIL-CT-FWD"].pop(1)
        self.assertFalse(self.ok())

    def test_netns_delete_failure_is_reported(self):
        def run(argv, **kw):
            if argv[:3] == ["ip", "netns", "list"]:
                return subprocess.CompletedProcess(argv, 0, f"{self.cfg.netnsName} (id: 1)\n", "")
            return subprocess.CompletedProcess(argv, 1, "", "Device or resource busy")
        with mock.patch.object(desktop.subprocess, "run", run):
            with self.assertRaises(Refused) as e:
                desktop.netns_down(self.cfg)
        self.assertEqual(e.exception.code, "netns_delete_failed")


if __name__ == "__main__":
    unittest.main()
