#!/usr/bin/env python3
"""Unprivileged unit tests (no root, runc, Docker or network) for the streamed desktop's
WebRTC relay on an AWS host (worker/src/aws-ice.ts is the Worker side):
  * the pushed config's validation (relay only, lifetime, derived neko values);
  * the container env it produces (Cloudflare's neko ICE env, no local-mode settings);
  * where it is stored (runDir tmpfs, 0600, never the data volume) and the bounded wait;
  * the agent's `ice` / `desktop_status` ops and the restart of a desktop that started
    without a relay;
  * the relay-mode desktop step (applied / missing) and the boot order;
  * that no credential appears in a response, a log line or the step's output.
Run: python3 -m unittest -v test_ice   (from infra/host-agent/test)."""
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, cli, config, desktop  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

TURN_USER, TURN_PASS = "turn-user-SECRET-1", "turn-pass-SECRET-2"
NEKO = {"user": "a" * 32, "admin": "b" * 32}
SECRETS = (TURN_USER, TURN_PASS, NEKO["user"], NEKO["admin"])


def relay_config(now_ms=None, **over):
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    c = {
        "v": 1,
        "expiresAt": now_ms + 1_200_000,
        "frontend": [{"urls": ["stun:stun.cloudflare.com:3478"]},
                     {"urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
                      "username": TURN_USER, "credential": TURN_PASS}],
        "backend": [{"urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp",
                              "turns:turn.cloudflare.com:443?transport=tcp"],
                     "username": TURN_USER, "credential": TURN_PASS}],
        "neko": dict(NEKO),
    }
    c.update(over)
    return c


def scratch(test):
    d = tempfile.mkdtemp(prefix="ezil-ice-unit-")
    test.addCleanup(shutil.rmtree, d, True)
    for sub in ("state", "run", "data", "etc"):
        os.makedirs(os.path.join(d, sub), mode=0o700)
    with open(os.path.join(d, "state", "control.key"), "wb") as f:
        f.write(b"k" * 32)
    with open(os.path.join(d, "etc", "image-config.json"), "w") as f:
        json.dump({"Env": ["PATH=/usr/bin:/bin", "NEKO_WEBRTC_ICELITE=true"], "WorkingDir": "/"}, f)
    with open(os.path.join(d, "etc", "seccomp.json"), "w") as f:
        json.dump({"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []}, f)
    cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
    cfg.update(stateDir=os.path.join(d, "state"), runDir=os.path.join(d, "run"), dataMount=os.path.join(d, "data"),
               imageConfigFile=os.path.join(d, "etc", "image-config.json"), seccompProfile=os.path.join(d, "etc", "seccomp.json"))
    return d, cfg


def spec_env(cfg):
    with open(os.path.join(cfg.runDir, "bundle", "config.json")) as f:
        env = json.load(f)["process"]["env"]
    keys = [e.split("=", 1)[0] for e in env]
    return dict(e.split("=", 1) for e in env), keys


class RelayConfig(unittest.TestCase):
    def test_accepts_a_cloudflare_shaped_config(self):
        now = int(time.time() * 1000)
        c = desktop.validate_desktop_config(relay_config(now), now)
        self.assertTrue(all(u.startswith(("turn:", "turns:")) for s in c["backend"] for u in s["urls"]))
        self.assertEqual(c["neko"], NEKO)

    def test_relay_only_backend_and_authenticated_turn(self):
        now = int(time.time() * 1000)
        bad = [
            relay_config(now, backend=[{"urls": ["stun:stun.cloudflare.com:3478"]}]),            # STUN -> srflx gathering
            relay_config(now, backend=[{"urls": ["stun:s:3478", "turn:t:3478"], "username": "u", "credential": "p"}]),
            relay_config(now, backend=[{"urls": ["turn:t:3478"]}]),                               # no credentials
            relay_config(now, frontend=[{"urls": ["stun:s:3478"]}]),                              # no relay for the browser
            relay_config(now, frontend=[{"urls": ["https://t.example"], "username": "u", "credential": "p"}]),
            relay_config(now, backend=[{"urls": ["turn:t"], "username": "u", "credential": "p"}] * 9),
            relay_config(now, backend=[{"urls": ["turn:t"], "username": "u", "credential": "p", "x": 1}]),
            relay_config(now, frontend=[{"urls": ["stun:s:3478"], "username": "leak"}, relay_config(now)["frontend"][1]]),
        ]
        for c in bad:
            with self.assertRaises(ValueError):
                desktop.validate_desktop_config(c, now)

    def test_lifetime_window(self):
        now = int(time.time() * 1000)
        for exp in (now + 60_000, now + 1_800_000 + 5_001, "soon", True):
            with self.assertRaises(ValueError):
                desktop.validate_desktop_config(relay_config(now, expiresAt=exp), now)
        desktop.validate_desktop_config(relay_config(now, expiresAt=now + 60_001), now)

    def test_never_the_image_defaults_or_one_value_twice(self):
        now = int(time.time() * 1000)
        for neko in ({"user": "neko", "admin": "admin"}, {"user": "a" * 32, "admin": "a" * 32},
                     {"user": "A" * 32, "admin": "b" * 32}, {"user": "a" * 32}):
            with self.assertRaises(ValueError):
                desktop.validate_desktop_config(relay_config(now, neko=neko), now)
        for extra in ({"v": 2}, {"other": 1}):
            with self.assertRaises(ValueError):
                desktop.validate_desktop_config({**relay_config(now), **extra}, now)


class RelayEnv(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.lease = {"generation": 1, "leaseEpoch": 2}

    def test_relay_config_gives_cloudflares_neko_env_and_derived_credentials(self):
        now = int(time.time() * 1000)
        c = desktop.validate_desktop_config(relay_config(now), now)
        desktop.build_spec(self.cfg, self.lease, "desktop", desktop_config=c)
        env, keys = spec_env(self.cfg)
        self.assertEqual(len(keys), len(set(keys)), "every env key exactly once")
        self.assertEqual(json.loads(env["NEKO_WEBRTC_ICESERVERS_BACKEND"]), c["backend"])
        self.assertEqual(json.loads(env["NEKO_WEBRTC_ICESERVERS_FRONTEND"]), c["frontend"])
        self.assertEqual(env["NEKO_WEBRTC_ICELITE"], "false", "ICE-lite never uses a relay")
        self.assertEqual(env["NEKO_WEBRTC_ICETRICKLE"], "true")
        self.assertEqual(env["NEKO_WEBRTC_NAT1TO1"], desktop.CT_IP, "never loopback, never a public-IP lookup")
        self.assertEqual(env["EZIL_RELAY_EXPIRES_AT"], str(c["expiresAt"]))
        self.assertEqual(env["NEKO_MEMBER_MULTIUSER_USER_PASSWORD"], NEKO["user"])
        self.assertEqual(env["NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD"], NEKO["admin"])
        self.assertIn("history -a", env["PROMPT_COMMAND"], "history injection kept")

    def test_local_mode_spec_is_unchanged(self):
        desktop.build_spec(self.cfg, self.lease, "desktop")
        env, _ = spec_env(self.cfg)
        self.assertEqual(env["NEKO_WEBRTC_ICELITE"], "true")
        self.assertEqual(env["NEKO_WEBRTC_NAT1TO1"], "127.0.0.1")
        self.assertNotIn("NEKO_WEBRTC_ICESERVERS_BACKEND", env)
        self.assertNotIn(NEKO["admin"], env["NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD"])


class RelayStore(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)

    def test_runDir_only_private_and_expiry_aware(self):
        now = int(time.time() * 1000)
        desktop.write_desktop_config(self.cfg, desktop.validate_desktop_config(relay_config(now), now))
        p = os.path.join(self.cfg.runDir, desktop.DESKTOP_CONFIG)
        self.assertEqual(stat.S_IMODE(os.stat(p).st_mode), 0o600)
        self.assertIsNotNone(desktop.read_desktop_config(self.cfg, now))
        self.assertIsNone(desktop.read_desktop_config(self.cfg, now + 1_200_000 - 60_000), "within 60 s of expiry = unusable")
        for root, _, files in os.walk(self.cfg.dataMount):
            self.assertEqual(files, [], "nothing on the data volume")

    def test_refused_when_runDir_is_on_the_data_volume(self):
        now = int(time.time() * 1000)
        self.cfg["runDir"] = os.path.join(self.cfg.dataMount, "run")
        os.makedirs(self.cfg.runDir)
        with self.assertRaises(Refused):
            desktop.write_desktop_config(self.cfg, desktop.validate_desktop_config(relay_config(now), now))
        self.assertIsNone(desktop.read_desktop_config(self.cfg, now))

    def test_wait_is_bounded_and_returns_a_config_that_arrives(self):
        t = [1000.0]
        clock, sleep = (lambda: t[0]), (lambda s: t.__setitem__(0, t[0] + s))
        self.assertIsNone(desktop.wait_desktop_config(self.cfg, 30, clock=clock, sleep=sleep))
        self.assertGreaterEqual(t[0], 1030.0)
        self.assertLess(t[0], 1032.0, "never waits past the bound")
        now_ms = int(t[0] * 1000)
        calls = [0]

        def sleep_then_arrive(s):
            calls[0] += 1
            t[0] += s
            if calls[0] == 3:
                desktop.write_desktop_config(self.cfg, desktop.validate_desktop_config(relay_config(now_ms), now_ms))
        self.assertIsNotNone(desktop.wait_desktop_config(self.cfg, 30, clock=clock, sleep=sleep_then_arrive))


class AgentIce(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.logs = []
        marker = os.path.join(self.d, "restarted")
        self.marker = marker
        self.cfg["desktopRestartCmd"] = ["/bin/sh", "-c", f"echo restart >> {marker}"]
        self.a = agentmod.Agent(self.cfg, {"generation": 1, "leaseEpoch": 2}, log=self.logs.append)
        self.seq = 0

    def send(self, op, **fields):
        self.seq += 1
        msg = {"op": op, "leaseEpoch": 2, "ts": time.time(), "seq": self.seq, **fields}
        msg["mac"] = agentmod.sign(b"k" * 32, msg)
        return self.a.handle(json.dumps(msg))

    def test_accepted_while_the_desktop_waits_then_status(self):
        with mock.patch.object(desktop, "state", return_value="absent"):
            self.assertEqual(self.send("desktop_status")["configured"], False)
            r = self.send("ice", config=relay_config())
            self.assertEqual(r, {"ok": True, "state": "accepted"})
            st = self.send("desktop_status")
        self.assertEqual((st["configured"], st["desktop"], st["ice"]), (True, "absent", "none"))
        self.assertIsNotNone(desktop.read_desktop_config(self.cfg, int(time.time() * 1000)))

    def test_invalid_config_is_refused_before_the_seq_is_used(self):
        last = self.a.last_seq
        r = self.send("ice", config=relay_config(backend=[{"urls": ["stun:s:3478"]}]))
        self.assertEqual(r, {"ok": False, "error": "ice_config_invalid"})
        self.assertEqual(self.a.last_seq, last)
        self.assertFalse(os.path.exists(os.path.join(self.cfg.runDir, desktop.DESKTOP_CONFIG)))

    def test_running_with_a_relay_keeps_it_and_never_restarts(self):
        desktop.write_ice_state(self.cfg, "applied", 1)
        with mock.patch.object(desktop, "state", return_value="running"):
            self.assertEqual(self.send("ice", config=relay_config()), {"ok": True, "state": "already_running"})
        self.assertFalse(self.a.restart_request)

    def test_running_without_a_relay_is_restarted_once_by_the_tick(self):
        desktop.write_ice_state(self.cfg, "missing")
        with mock.patch.object(desktop, "state", return_value="running"):
            self.assertEqual(self.send("ice", config=relay_config()), {"ok": True, "state": "restart_scheduled"})
        self.assertEqual(self.a.tick(), "restarting")
        with open(self.marker) as f:
            self.assertEqual(f.read(), "restart\n")
        self.a.last_presence = time.time()
        self.assertEqual(self.a.tick(), "active", "one restart per scheduled push")

    def test_a_stop_request_wins_over_a_pending_restart(self):
        self.a.restart_request = True
        self.a.stop_request = {"kind": "stop", "warn": 0, "reason": "t"}
        with mock.patch.object(self.a, "flush", return_value="ok"), mock.patch.object(self.a, "shutdown") as sd:
            self.assertEqual(self.a.tick(), "stopped")
        sd.assert_called_once()
        self.assertFalse(os.path.exists(self.marker))

    def test_no_response_or_log_line_carries_a_credential(self):
        out = []
        with mock.patch.object(desktop, "state", return_value="running"):
            desktop.write_ice_state(self.cfg, "missing")
            out.append(self.send("ice", config=relay_config()))
            out.append(self.send("ice", config=relay_config(expiresAt=1)))
            out.append(self.send("desktop_status"))
        self.a.tick()
        blob = json.dumps(out) + "\n".join(self.logs)
        for s in SECRETS:
            self.assertNotIn(s, blob)


class DesktopStep(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.lease = {"generation": 1, "leaseEpoch": 2}
        self.cfg["iceMode"] = "relay"

    def run_step(self, wait_result):
        buf = io.StringIO()
        with redirect_stdout(buf):
            out = cli.desktop_relay(self.cfg, self.lease, wait=lambda cfg, timeout: wait_result)
        return out, buf.getvalue()

    def test_applied(self):
        now = int(time.time() * 1000)
        out, printed = self.run_step(desktop.validate_desktop_config(relay_config(now), now))
        self.assertEqual(out, "applied")
        self.assertEqual(desktop.read_ice_state(self.cfg), "applied")
        env, _ = spec_env(self.cfg)
        self.assertEqual(env["NEKO_WEBRTC_ICELITE"], "false")
        for s in SECRETS:
            self.assertNotIn(s, out + printed)

    def test_missing_starts_anyway_and_says_so(self):
        out, _ = self.run_step(None)
        self.assertIn("ice_missing", out)
        self.assertEqual(desktop.read_ice_state(self.cfg), "missing")
        env, _ = spec_env(self.cfg)
        self.assertNotIn("NEKO_WEBRTC_ICESERVERS_BACKEND", env)

    def test_modes(self):
        self.cfg["iceMode"] = "local"
        self.assertIsNone(cli.desktop_relay(self.cfg, self.lease, wait=lambda *a: self.fail("local never waits")))
        self.cfg["iceMode"] = "bogus"
        with self.assertRaises(Refused):
            cli.desktop_relay(self.cfg, self.lease)

    def test_relay_boot_order_puts_the_desktop_last(self):
        self.assertEqual(cli.boot_order(self.cfg)[-1], "desktop")
        self.assertLess(cli.boot_order(self.cfg).index("enroll"), cli.boot_order(self.cfg).index("desktop"))
        self.cfg["iceMode"] = "local"
        self.assertEqual(cli.boot_order(self.cfg), cli.BOOT_ORDER)


if __name__ == "__main__":
    unittest.main()
