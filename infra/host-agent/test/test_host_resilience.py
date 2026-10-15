#!/usr/bin/env python3
"""Unprivileged unit tests (no root, runc or network) for three ways an AWS host could be
stranded (PR #200 review, round 3):
  * a failed poweroff must not end the agent: it retries, with backoff and a forced fallback,
    until the OS accepts it; a restarted agent resumes a shutdown that began;
  * a desktop that exited (crashed) is restarted: the unit's Restart= is kept off a host the
    agent is stopping (runDir/stopping), and an `ice` push that finds the unit exited or failed
    resets and restarts it, bounded, then reports exhaustion;
  * an in-place reboot of the SAME instance in the same lease epoch boots (the marker records
    which instance took the epoch) and reuses that instance's own enrollment; a different
    instance replaying the epoch is still refused.
Run: python3 -m unittest -v test_host_resilience   (from infra/host-agent/test)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, cli, config, desktop, enroll as enrollmod, guard  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

SID, ZONE = "guac-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb", "ezil.org"


def scratch(test):
    d = tempfile.mkdtemp(prefix="ezil-resilience-unit-")
    test.addCleanup(shutil.rmtree, d, True)
    for sub in ("state", "run", "data"):
        os.makedirs(os.path.join(d, sub), mode=0o700)
    with open(os.path.join(d, "state", "control.key"), "wb") as f:
        f.write(b"k" * 32)
    cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
    cfg.update(stateDir=os.path.join(d, "state"), runDir=os.path.join(d, "run"), dataMount=os.path.join(d, "data"))
    return d, cfg


def sh(script):
    return ["/bin/sh", "-c", script]


# ------------------------------------------------------------------------------- poweroff
class PowerOff(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.sleeps, self.logs = [], []
        self.calls = os.path.join(self.d, "calls")
        self.a = agentmod.Agent(self.cfg, {"generation": 1, "leaseEpoch": 2}, log=self.logs.append, sleep=self.sleeps.append)

    def counting(self, tag, fail_first):
        """A command that appends `tag` and fails its first `fail_first` calls (all calls counted)."""
        return sh(f'echo {tag} >> {self.calls}; n=$(wc -l < {self.calls}); [ "$n" -gt {fail_first} ]')

    def seen(self):
        with open(self.calls) as f:
            return f.read().split()

    def test_a_failed_poweroff_is_retried_with_backoff_until_accepted(self):
        self.cfg["shutdownCmd"] = self.counting("main", 2)
        self.cfg["shutdownFallbackCmd"] = None
        self.assertEqual(self.a.power_off(), 3)
        self.assertEqual(self.seen(), ["main", "main", "main"])
        self.assertEqual(self.sleeps, [1.0, 2.0], "doubling backoff between attempts")

    def test_backoff_is_capped_and_the_fallback_alternates_after_three_failures(self):
        self.cfg["shutdownCmd"] = sh(f"echo main >> {self.calls}; exit 1")
        self.cfg["shutdownFallbackCmd"] = sh(f'echo fallback >> {self.calls}; n=$(grep -c fallback {self.calls}); [ "$n" -ge 2 ]')
        self.cfg["shutdownRetryMaxSeconds"] = 4
        self.assertEqual(self.a.power_off(), 6)
        self.assertEqual(self.seen(), ["main", "main", "main", "fallback", "main", "fallback"])
        self.assertEqual(self.sleeps, [1.0, 2.0, 4.0, 4.0, 4.0])

    def test_a_command_that_cannot_run_counts_as_a_failure(self):
        self.cfg["shutdownCmd"] = ["/nonexistent/shutdown"]
        self.cfg["shutdownFallbackCmd"] = sh("exit 0")
        self.assertEqual(self.a.power_off(), 4)
        self.assertTrue(any("FileNotFoundError" in m for m in self.logs))

    def test_shutdown_marks_stopping_and_pending_before_fencing(self):
        seen = {}

        def fence(cfg, why):
            seen["stopping"] = os.path.exists(os.path.join(cfg.runDir, desktop.STOPPING))
            seen["pending"] = os.path.exists(os.path.join(cfg.runDir, agentmod.SHUTDOWN_PENDING))
        with mock.patch.object(agentmod.tunnel, "fence", side_effect=fence), mock.patch.object(agentmod.time, "sleep"), \
                mock.patch.object(agentmod.desktop, "stop", return_value="clean"), \
                mock.patch.object(agentmod.desktop, "overlay_umount"), mock.patch.object(agentmod.desktop, "netns_down"), \
                mock.patch.object(agentmod.guard, "is_mounted", return_value=True), \
                mock.patch.object(self.a, "power_off") as po, \
                mock.patch.object(agentmod.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            self.a.shutdown("idle")
        self.assertEqual(seen, {"stopping": True, "pending": True})
        po.assert_called_once()

    def test_a_restarted_agent_resumes_a_shutdown_that_began(self):
        with open(os.path.join(self.cfg.runDir, agentmod.SHUTDOWN_PENDING), "w") as f:
            f.write("1\n")
        # tick() answers "stopped" so a run() that skipped the resume returns at once (never hangs)
        with mock.patch.object(self.a, "shutdown") as sd, mock.patch.object(self.a, "serve") as serve, \
                mock.patch.object(self.a, "tick", return_value="stopped"):
            self.a.run()
        sd.assert_called_once()
        self.assertIn("resume", sd.call_args[0][0])
        serve.assert_not_called()

    def test_idle_stop_marks_stopping_and_clears_it_when_blocked(self):
        self.a.last_presence = 0
        stopping = os.path.join(self.cfg.runDir, desktop.STOPPING)
        seen = []
        with mock.patch.object(self.a, "flush", side_effect=lambda **kw: seen.append(os.path.exists(stopping)) or "busy"), \
                mock.patch("builtins.open", mock.mock_open(read_data="0.01 0 0 1/1 1")):
            self.assertEqual(self.a.tick(), "flush_busy")
        self.assertEqual(seen, [True], "the marker is set before the flush stops the desktop")
        self.assertFalse(os.path.exists(stopping), "a blocked idle stop lets the desktop start again")

    def test_a_control_plane_stop_marks_stopping_before_the_flush(self):
        self.a.stop_request = {"kind": "stop", "warn": 0, "reason": "t"}
        stopping = os.path.join(self.cfg.runDir, desktop.STOPPING)
        seen = []
        with mock.patch.object(self.a, "flush", side_effect=lambda **kw: seen.append(os.path.exists(stopping)) or "ok"), \
                mock.patch.object(self.a, "shutdown"):
            self.assertEqual(self.a.tick(), "stopped")
        self.assertEqual(seen, [True])


# ------------------------------------------------------------------------ desktop restart
class DesktopRestart(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.t = [1000.0]
        self.unit = os.path.join(self.d, "unit")
        self.set_unit("active", 5)
        self.marks = os.path.join(self.d, "marks")
        self.cfg["desktopUnitStateCmd"] = sh(f"cat {self.unit}")
        self.cfg["desktopResetCmd"] = sh(f"echo reset >> {self.marks}")
        self.cfg["desktopRestartCmd"] = sh(f"echo restart >> {self.marks}")
        self.a = agentmod.Agent(self.cfg, {"generation": 1, "leaseEpoch": 2}, clock=lambda: self.t[0], log=lambda m: None)
        self.seq = 0
        self.now_ms = int(time.time() * 1000)

    def set_unit(self, state, started):
        with open(self.unit, "w") as f:
            f.write(f"ActiveState={state}\nExecMainStartTimestampMonotonic={started}\n")

    def send(self, op, **fields):
        self.seq += 1
        msg = {"op": op, "leaseEpoch": 2, "ts": self.t[0], "seq": self.seq, **fields}
        msg["mac"] = agentmod.sign(b"k" * 32, msg)
        return self.a.handle(json.dumps(msg))

    def push(self):
        c = {"v": 1, "expiresAt": int(self.t[0] * 1000) + 1_200_000,
             "frontend": [{"urls": ["turns:turn.cloudflare.com:443?transport=tcp"], "username": "u", "credential": "p"}],
             "backend": [{"urls": ["turns:turn.cloudflare.com:443?transport=tcp"], "username": "u", "credential": "p"}],
             "neko": {"user": "a" * 32, "admin": "b" * 32}}
        return self.send("ice", config=c)

    def marks_seen(self):
        try:
            with open(self.marks) as f:
                return f.read().split()
        except FileNotFoundError:
            return []

    def test_unit_state_parsing(self):
        for (state, started), want in ((("active", 5), "active"), (("activating", 5), "activating"),
                                       (("inactive", 0), "pending"), (("inactive", 5), "inactive"),
                                       (("failed", 5), "failed"), (("bogus", 5), "unknown")):
            self.set_unit(state, started)
            self.assertEqual(self.a._desktop_unit(), want, (state, started))
        self.cfg["desktopUnitStateCmd"] = sh("exit 1")
        self.assertEqual(self.a._desktop_unit(), "unknown")

    def test_a_crashed_desktop_is_reset_and_restarted_by_the_next_push(self):
        for state in ("inactive", "failed"):
            self.set_unit(state, 5)
            with mock.patch.object(desktop, "state", return_value="absent"):
                self.assertEqual(self.push(), {"ok": True, "state": "restart_scheduled"}, state)
            self.assertEqual(self.a.tick(), "restarting")
        self.assertEqual(self.marks_seen(), ["reset", "restart", "reset", "restart"], "reset-failed, then restart")

    def test_a_desktop_still_starting_is_never_restarted(self):
        for state, started in (("active", 5), ("activating", 5), ("inactive", 0)):
            self.set_unit(state, started)
            with mock.patch.object(desktop, "state", return_value="absent"):
                self.assertEqual(self.push(), {"ok": True, "state": "accepted"}, state)
        self.assertFalse(self.a.restart_request)

    def test_restarts_are_bounded_per_window_then_reported(self):
        self.set_unit("failed", 5)
        with mock.patch.object(desktop, "state", return_value="absent"):
            for _ in range(3):
                self.assertEqual(self.push()["state"], "restart_scheduled")
                self.a.tick()
                self.t[0] += 10
            self.assertEqual(self.push(), {"ok": False, "error": "desktop_restart_exhausted"})
            self.assertFalse(self.a.restart_request)
            st = self.send("desktop_status")
            self.assertEqual((st["unit"], st["restartsExhausted"]), ("failed", True))
            self.t[0] += 600
            self.assertEqual(self.push()["state"], "restart_scheduled", "the window moves on")
            self.assertFalse(self.send("desktop_status")["restartsExhausted"])

    def test_the_desktop_step_refuses_while_the_agent_is_stopping(self):
        lease = {"generation": 1, "leaseEpoch": 2}
        with open(os.path.join(self.cfg.runDir, "lease.json"), "w") as f:
            json.dump(lease, f)
        with open(os.path.join(self.cfg.runDir, "guard-ok"), "w") as f:
            json.dump(lease, f)
        with open(os.path.join(self.cfg.runDir, desktop.STOPPING), "w") as f:
            f.write("1\n")
        with mock.patch.object(desktop, "run") as run, mock.patch.object(cli, "desktop_relay") as relay, \
                mock.patch.object(guard, "require_stamp"):
            with self.assertRaises(Refused) as e:
                cli.step(self.cfg, "desktop")
        self.assertEqual(e.exception.code, "desktop_stopping")
        run.assert_not_called()
        relay.assert_not_called()


# --------------------------------------------------------------------- same-instance reboot
LEASE = {"computerId": "c1", "volumeId": "vol-1", "fsUuid": "f1", "generation": 1, "leaseEpoch": 2}
DIGEST = "sha256:" + "a" * 64


class GuardReboot(unittest.TestCase):
    def marker(self, **over):
        m = guard.new_marker(LEASE, DIGEST, "i-0abc")
        m.update(over)
        return m

    def test_same_instance_same_epoch_is_a_reboot(self):
        self.assertEqual(guard.check_marker(self.marker(), LEASE, DIGEST, "i-0abc"), "reboot")

    def test_a_different_instance_replaying_the_epoch_is_refused(self):
        with self.assertRaises(Refused) as e:
            guard.check_marker(self.marker(), LEASE, DIGEST, "i-0def")
        self.assertEqual(e.exception.code, "epoch_not_increasing")

    def test_no_instance_proof_means_no_reboot(self):
        for m, iid in ((self.marker(), None), ({k: v for k, v in self.marker().items() if k != "instanceId"}, "i-0abc")):
            with self.assertRaises(Refused):
                guard.check_marker(m, LEASE, DIGEST, iid)

    def test_a_same_epoch_reboot_needs_the_same_generation(self):
        with self.assertRaises(Refused):
            guard.check_marker(self.marker(generation=0), LEASE, DIGEST, "i-0abc")

    def test_the_next_epoch_still_works_and_is_ok(self):
        self.assertEqual(guard.check_marker(self.marker(leaseEpoch=1), LEASE, DIGEST, "i-0def"), "ok")

    def test_marker_records_the_instance_and_a_malformed_one_is_refused(self):
        self.assertEqual(guard.new_marker(LEASE, DIGEST, "i-0abc")["instanceId"], "i-0abc")
        self.assertNotIn("instanceId", guard.new_marker(LEASE, DIGEST))
        d = tempfile.mkdtemp(prefix="ezil-marker-unit-")
        self.addCleanup(shutil.rmtree, d, True)
        root = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, root)
        for iid, ok in (("i-0abc", True), ("../x", False), (5, False)):
            with open(os.path.join(d, guard.MARKER), "w") as f:
                json.dump(self.marker(instanceId=iid), f)
            if ok:
                self.assertEqual(guard.read_marker(root)["instanceId"], iid)
            else:
                with self.assertRaises(Refused):
                    guard.read_marker(root)

    def test_current_instance_id_comes_from_the_stored_identity_document(self):
        d, cfg = scratch(self)
        self.assertIsNone(guard.current_instance_id(cfg))
        p = os.path.join(cfg.runDir, "identity.json")
        for doc, want in (('{"instanceId": "i-0abc"}', "i-0abc"), ('{"instanceId": "nope"}', None), ("not json", None)):
            with open(p, "w") as f:
                json.dump({"document": doc, "signature": "s"}, f)
            self.assertEqual(guard.current_instance_id(cfg), want)


class EnrollReuse(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.cfg["userDataCopies"] = [os.path.join(self.d, "cloud", "*.txt")]
        os.makedirs(os.path.join(self.d, "cloud"))
        with open(os.path.join(self.d, "cloud", "user-data.txt"), "w") as f:
            f.write("nonce")
        self.lease = {"computerId": "c1", "generation": 1, "leaseEpoch": 2, "nonce": "n" * 32}
        self.write(self.cfg.runDir, "lease.json", self.lease)
        self.write(self.cfg.runDir, "identity.json", {"document": '{"instanceId": "i-0abc"}', "signature": "s"})
        self.write(self.cfg.stateDir, "tunnel.json", {"token": "t" * 32, "generation": 1, "leaseEpoch": 2})
        self.write(self.cfg.stateDir, cli.ENROLLED_FILE,
                   {"instanceId": "i-0abc", "generation": 1, "leaseEpoch": 2, "sandboxId": SID, "zone": ZONE})

    @staticmethod
    def write(d, name, obj):
        with open(os.path.join(d, name), "w") as f:
            json.dump(obj, f)

    def test_same_instance_same_epoch_reuses_its_own_enrollment(self):
        with mock.patch.object(enrollmod, "enroll", side_effect=AssertionError("must not post the consumed nonce")):
            out = cli.enroll_or_reuse(self.cfg, self.lease)
        self.assertIn("same-instance reboot", out)
        lease = enrollmod.load_lease(self.cfg)
        self.assertNotIn("nonce", lease)
        self.assertTrue(lease["nonceConsumed"])
        self.assertEqual((lease["sandboxId"], lease["zone"]), (SID, ZONE), "the edge's routing is restored")
        self.assertFalse(os.path.exists(os.path.join(self.d, "cloud", "user-data.txt")), "local nonce copies wiped")

    def test_any_other_case_enrolls_and_records_the_instance(self):
        cases = [("identity.json", "runDir", {"document": '{"instanceId": "i-0def"}', "signature": "s"}, "i-0def"),
                 ("tunnel.json", "stateDir", {"token": "t" * 32, "generation": 1, "leaseEpoch": 1}, "i-0abc")]
        for name, where, obj, iid in cases:
            self.setUp()
            self.write(self.cfg[where], name, obj)
            calls = []

            def fake_enroll(cfg, lease, instance_id=None):
                calls.append((lease["leaseEpoch"], instance_id))
            with mock.patch.object(enrollmod, "enroll", side_effect=fake_enroll):
                cli.enroll_or_reuse(self.cfg, self.lease)
            # enroll.persist records the instance (test_enroll_durability.py), so cli passes it on.
            self.assertEqual(calls, [(2, iid)], name)

    def test_a_fenced_host_without_its_control_key_enrolls(self):
        os.unlink(os.path.join(self.cfg.stateDir, "control.key"))
        with mock.patch.object(enrollmod, "enroll") as en, mock.patch.object(enrollmod, "load_lease", return_value=self.lease):
            cli.enroll_or_reuse(self.cfg, self.lease)
        en.assert_called_once()


if __name__ == "__main__":
    unittest.main()
