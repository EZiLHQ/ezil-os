"""Every long-lived host unit restarts after a crash, bounded, and never restarts a refusal.

A long-lived step that dies (an OOM kill, an uncaught socket error) with no Restart= stays
dead while EC2 still reports the instance running, so the app never notices and the computer
is unusable until replaced (Codex review 4277613539, ezil-edge.service). Units are read from
systemd/ as shipped; the steps that honour runDir/stopping are exercised through cli.step.
"""
import glob
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
SYSTEMD = os.path.join(HERE, "..", "systemd")
sys.path.insert(0, os.path.join(HERE, "..", "lib"))

from ezil_host import cli, config, desktop, guard, tunnel  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402


def read_unit(path):
    sections, current = {}, None
    with open(path) as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("[") and line.endswith("]"):
                current = sections.setdefault(line[1:-1], {})
                continue
            key, _, value = line.partition("=")
            current.setdefault(key.strip(), []).append(value.strip())
    return sections


UNITS = {os.path.basename(p)[: -len(".service")]: read_unit(p) for p in sorted(glob.glob(os.path.join(SYSTEMD, "*.service")))}
# Long-lived = a process systemd keeps running (not a oneshot boot step).
LONG_LIVED = sorted(n for n, u in UNITS.items() if u["Service"].get("Type", ["simple"])[-1] == "simple")


def one(unit, section, key):
    values = unit.get(section, {}).get(key, [])
    return values[-1] if values else None


class UnitPolicy(unittest.TestCase):
    def test_the_long_lived_units_are_the_ones_we_reason_about(self):
        # A new long-lived unit must be added here on purpose, and so get this policy.
        self.assertEqual(LONG_LIVED, ["ezil-agent", "ezil-cloudflared", "ezil-desktop", "ezil-edge"])

    def test_every_long_lived_unit_restarts_after_a_crash_bounded(self):
        for name in LONG_LIVED:
            u = UNITS[name]
            with self.subTest(unit=name):
                self.assertIn(one(u, "Service", "Restart"), ("on-failure", "always"), "a crash must be restarted")
                self.assertGreater(int(one(u, "Service", "RestartSec") or 0), 0, "restarts are spaced")
                self.assertGreater(int(one(u, "Unit", "StartLimitIntervalSec") or 0), 0, "restarts are bounded (interval)")
                self.assertGreater(int(one(u, "Unit", "StartLimitBurst") or 0), 0, "restarts are bounded (burst)")

    def test_a_restarted_oneshot_never_fails_its_dependents(self):
        # A oneshot boot step's restart in the default (normal) mode passes through failed, which
        # fails the start job of every unit that Requires= it, for good (ezil-enroll.service).
        restarted = sorted(n for n, u in UNITS.items() if u["Service"].get("Type", ["simple"])[-1] == "oneshot"
                           and one(u, "Service", "Restart") not in (None, "no"))
        self.assertEqual(restarted, ["ezil-guard"], "a new restarted oneshot gets this policy on purpose")
        for name in restarted:
            with self.subTest(unit=name):
                self.assertEqual(one(UNITS[name], "Service", "RestartMode"), "direct")

    def test_units_whose_step_refuses_while_stopping_never_restart_that_refusal(self):
        for step in cli.RESTARTED_STEPS:
            u = UNITS[f"ezil-{step}"]
            with self.subTest(unit=step):
                self.assertIn("2", (one(u, "Service", "RestartPreventExitStatus") or "").split(),
                              "exit 2 (a refusal) must never be restarted, or a restart undoes a stop")


class StepsRefuseWhileStopping(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="ezil-unit-policy-")
        self.addCleanup(shutil.rmtree, self.d, True)
        for sub in ("state", "run", "data"):
            os.makedirs(os.path.join(self.d, sub), mode=0o700)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(stateDir=os.path.join(self.d, "state"), runDir=os.path.join(self.d, "run"),
                        dataMount=os.path.join(self.d, "data"))
        lease = {"generation": 1, "leaseEpoch": 2}
        for f in ("lease.json", "guard-ok"):
            with open(os.path.join(self.cfg.runDir, f), "w") as fh:
                json.dump(lease, fh)
        p = mock.patch.object(guard, "require_stamp")
        p.start()
        self.addCleanup(p.stop)

    def stopping(self):
        with open(os.path.join(self.cfg.runDir, desktop.STOPPING), "w") as f:
            f.write("1\n")

    def test_the_edge_refuses_while_stopping_and_never_serves(self):
        self.stopping()
        from ezil_host import edge as edgemod
        with mock.patch.object(edgemod, "Edge") as edge, mock.patch.object(edgemod, "load_key", return_value=b"k" * 32):
            with self.assertRaises(Refused) as e:
                cli.step(self.cfg, "edge")
        self.assertEqual(e.exception.code, "edge_stopping")
        edge.assert_not_called()

    def test_the_cloudflared_supervisor_refuses_while_stopping_and_never_starts(self):
        self.stopping()
        with mock.patch.object(tunnel, "supervise") as sup:
            with self.assertRaises(Refused) as e:
                cli.step(self.cfg, "cloudflared")
        self.assertEqual(e.exception.code, "cloudflared_stopping")
        sup.assert_not_called()

    def test_without_the_marker_both_steps_run(self):
        from ezil_host import edge as edgemod
        with mock.patch.object(edgemod, "Edge") as edge, mock.patch.object(edgemod, "load_key", return_value=b"k" * 32), \
                mock.patch.object(cli.signal, "signal"):
            cli.step(self.cfg, "edge")
        edge.return_value.serve.assert_called_once()
        with mock.patch.object(tunnel, "supervise", return_value=("fence", 0)) as sup:
            self.assertIn("fence", cli.step(self.cfg, "cloudflared"))
        sup.assert_called_once()

    def test_a_refusal_is_exit_2(self):
        self.stopping()
        with mock.patch.object(config, "load", return_value=self.cfg), mock.patch.object(tunnel, "supervise") as sup:
            self.assertEqual(cli.main(["cloudflared"]), 2)
        sup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
