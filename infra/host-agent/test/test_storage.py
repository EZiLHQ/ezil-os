#!/usr/bin/env python3
"""Unprivileged unit tests (no root, mounts or network) for the storage sampler (storage.py):
  * the meter is statvfs used blocks of the data volume, only while it is THIS lease's
    guarded mount (an unmounted mountpoint would report the host root disk);
  * the wire format and MAC match the app's verifier (one shared test vector);
  * posting retries transport errors, 429 and 5xx with bounded backoff, re-signing the same
    body, and treats every other answer as final;
  * the periodic schedule (first sample, then every interval) and the stop sample's hard
    budget; the agent takes the stop sample after the sync and before the data unmount, and
    a failing app never fails the quiesce.
Run: python3 -m unittest -v test_storage   (from infra/host-agent/test)."""
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, config, guard, storage  # noqa: E402

CID = "11111111-1111-4111-8111-111111111111"
LEASE = {"computerId": CID, "generation": 3, "leaseEpoch": 7}
KEY = bytes(range(32))
# Shared with app/src/server/billing/http/host-storage.test.ts: both sides sign this vector alike.
VECTOR_BODY = b'{"bytes":"1610612736","measuredAt":"2026-11-01T11:59:00Z","reason":"interval"}'
VECTOR_TS = 1793534400
VECTOR_SIG = "v1=d914aeeec7cf11c04065b5e5d63c86048f5080f25e856bbfc647f0c7b92de40a"


def scratch(test):
    d = tempfile.mkdtemp(prefix="ezil-storage-unit-")
    test.addCleanup(shutil.rmtree, d, True)
    for sub in ("state", "run", "data"):
        os.makedirs(os.path.join(d, sub), mode=0o700)
    with open(os.path.join(d, "state", "control.key"), "wb") as f:
        f.write(KEY)
    cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
    cfg.update(stateDir=os.path.join(d, "state"), runDir=os.path.join(d, "run"), dataMount=os.path.join(d, "data"),
               enrollUrl="https://app.example.org/api/compute/aws/enroll")
    return d, cfg


def stamp(cfg, lease=LEASE):
    """What the guard really writes (guard.run_guard): its full marker for this lease."""
    full = dict(lease, volumeId="vol-0123456789abcdef0", fsUuid="44444444-4444-4444-8444-444444444444")
    with open(os.path.join(cfg.runDir, "guard-ok"), "w") as f:
        json.dump(guard.new_marker(full, "sha256:" + "0" * 64, "i-0123456789abcdef0"), f)


def vfs(blocks, bfree, frsize=4096, bavail=None):
    return lambda path: SimpleNamespace(f_blocks=blocks, f_bfree=bfree, f_bavail=bfree if bavail is None else bavail, f_frsize=frsize)


class Clock:
    """A fake monotonic + wall clock that sleeping advances."""

    def __init__(self, wall=VECTOR_TS):
        self.mono, self.wall, self.sleeps = 1000.0, float(wall), []

    def monotonic(self):
        return self.mono

    def clock(self):
        return self.wall

    def sleep(self, s):
        self.sleeps.append(s)
        self.mono += s
        self.wall += s


class Meter(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)

    def test_used_bytes_are_allocated_blocks_and_ignore_the_root_reserve(self):
        self.assertEqual(storage.used_bytes("/x", vfs(1000, 250)), 750 * 4096)
        # f_bavail < f_bfree (root-reserved blocks): still not "used".
        self.assertEqual(storage.used_bytes("/x", vfs(1000, 250, bavail=200)), 750 * 4096)
        self.assertEqual(storage.used_bytes("/x", vfs(10, 10, frsize=1024)), 0)
        self.assertEqual(storage.used_bytes("/x", vfs(2 ** 40, 0, frsize=4096)), 2 ** 52)

    def test_measures_only_this_leases_guarded_mount(self):
        mounted = lambda p: p == self.cfg.dataMount  # noqa: E731
        # Positive control: stamped for this epoch and mounted.
        stamp(self.cfg)
        self.assertEqual(storage.measure(self.cfg, LEASE, is_mounted=mounted, statvfs=vfs(100, 40)), 60 * 4096)
        # Not a mountpoint (the host root disk would answer): nothing.
        self.assertIsNone(storage.measure(self.cfg, LEASE, is_mounted=lambda p: False, statvfs=vfs(100, 40)))
        # A stamp for another epoch or another computer, a non-object stamp, or none: nothing.
        stamp(self.cfg, dict(LEASE, leaseEpoch=6))
        self.assertIsNone(storage.measure(self.cfg, LEASE, is_mounted=mounted, statvfs=vfs(100, 40)))
        stamp(self.cfg, dict(LEASE, computerId="22222222-2222-4222-8222-222222222222"))
        self.assertIsNone(storage.measure(self.cfg, LEASE, is_mounted=mounted, statvfs=vfs(100, 40)))
        with open(os.path.join(self.cfg.runDir, "guard-ok"), "w") as f:
            json.dump([3, 7], f)
        self.assertIsNone(storage.measure(self.cfg, LEASE, is_mounted=mounted, statvfs=vfs(100, 40)))
        os.unlink(os.path.join(self.cfg.runDir, "guard-ok"))
        self.assertIsNone(storage.measure(self.cfg, LEASE, is_mounted=mounted, statvfs=vfs(100, 40)))
        # The minimal epoch-only stamp older tests write is accepted too (no computer named).
        with open(os.path.join(self.cfg.runDir, "guard-ok"), "w") as f:
            json.dump({"generation": 3, "leaseEpoch": 7}, f)
        self.assertEqual(storage.measure(self.cfg, LEASE, is_mounted=mounted, statvfs=vfs(100, 40)), 60 * 4096)

    def test_a_statvfs_failure_is_no_measurement(self):
        stamp(self.cfg)

        def broken(path):
            raise OSError("EIO")
        self.assertIsNone(storage.measure(self.cfg, LEASE, is_mounted=lambda p: True, statvfs=broken))

    def test_measures_a_real_directory_with_os_statvfs(self):
        stamp(self.cfg)
        n = storage.measure(self.cfg, LEASE, is_mounted=lambda p: True)
        st = os.statvfs(self.cfg.dataMount)
        self.assertEqual(n, (st.f_blocks - st.f_bfree) * st.f_frsize)


class Wire(unittest.TestCase):
    def test_body_names_no_computer_or_user_and_uses_whole_utc_seconds(self):
        raw = storage.body(1610612736, 1793534340.9, "interval")
        self.assertEqual(raw, VECTOR_BODY)
        self.assertEqual(set(json.loads(raw)), {"bytes", "measuredAt", "reason"})

    def test_signature_matches_the_shared_vector_and_binds_every_field(self):
        self.assertEqual(storage.sign(KEY, VECTOR_TS, CID, 3, 7, VECTOR_BODY), VECTOR_SIG)
        self.assertEqual(storage.sign(KEY, VECTOR_TS, CID.upper(), 3, 7, VECTOR_BODY), VECTOR_SIG)
        msg = f"ezil-storage-sample-v1|{VECTOR_TS}|{CID}|3|7|{hashlib.sha256(VECTOR_BODY).hexdigest()}"
        self.assertEqual(VECTOR_SIG, "v1=" + hmac.new(KEY, msg.encode(), hashlib.sha256).hexdigest())
        for changed in (storage.sign(KEY, VECTOR_TS + 1, CID, 3, 7, VECTOR_BODY), storage.sign(KEY, VECTOR_TS, CID, 4, 7, VECTOR_BODY),
                        storage.sign(KEY, VECTOR_TS, CID, 3, 8, VECTOR_BODY), storage.sign(KEY, VECTOR_TS, CID, 3, 7, VECTOR_BODY + b" "),
                        storage.sign(b"k" * 32, VECTOR_TS, CID, 3, 7, VECTOR_BODY)):
            self.assertNotEqual(changed, VECTOR_SIG)

    def test_identity_and_endpoint_come_from_the_lease_and_the_enrolled_origin(self):
        _, cfg = scratch(self)
        self.assertEqual(storage.identity(dict(LEASE, computerId=CID.upper())), (CID, 3, 7))
        for bad in ({}, dict(LEASE, computerId="not-a-uuid"), dict(LEASE, generation=0), dict(LEASE, leaseEpoch=True)):
            self.assertIsNone(storage.identity(bad))
        self.assertEqual(storage.endpoint(cfg, LEASE), "https://app.example.org/api/compute/aws/storage")
        self.assertEqual(storage.endpoint(cfg, dict(LEASE, appOrigin="https://pool.example.org")),
                         "https://pool.example.org/api/compute/aws/storage")
        cfg["enrollUrl"] = None
        self.assertIsNone(storage.endpoint(cfg, LEASE))
        cfg["enrollUrl"] = "http://app.example.org/api/compute/aws/enroll"   # never plain HTTP
        self.assertIsNone(storage.endpoint(cfg, LEASE))

    def test_a_pool_claimed_computer_is_sampled_at_the_origin_its_claim_enrolled_with(self):
        _, cfg = scratch(self)
        # runDir/lease.json after a pool claim: pool.computer_lease's shape, then enrollment's routing.
        claimed = {"v": 1, "computerId": CID, "generation": 3, "leaseEpoch": 7, "volumeId": "vol-0123456789abcdef0",
                   "fsUuid": "44444444-4444-4444-8444-444444444444", "provision": False, "nonceConsumed": True,
                   "sandboxId": "guac-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb", "zone": "ezil.org"}
        record = {"appOrigin": "https://pool-app.example.org", "claim": {"computerId": CID, "generation": 3, "leaseEpoch": 7}}
        self.assertEqual(storage.identity(claimed), (CID, 3, 7))
        with mock.patch.object(storage.pool, "read_record", return_value=record):
            self.assertEqual(storage.endpoint(cfg, claimed), "https://pool-app.example.org/api/compute/aws/storage")
            self.assertTrue(storage.Sampler(cfg, claimed, KEY, print).enabled())
            # Another epoch on the same host (a later cold boot): the baked origin, not the old claim's.
            self.assertEqual(storage.endpoint(cfg, dict(claimed, leaseEpoch=8)), "https://app.example.org/api/compute/aws/storage")
        with mock.patch.object(storage.pool, "read_record", side_effect=storage.Refused("pool_epoch_malformed")):
            self.assertEqual(storage.endpoint(cfg, claimed), "https://app.example.org/api/compute/aws/storage")
        cfg["enrollUrl"] = None
        with mock.patch.object(storage.pool, "read_record", return_value=record):
            self.assertEqual(storage.endpoint(cfg, claimed), "https://pool-app.example.org/api/compute/aws/storage")


class Post(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.clock = Clock()
        self.calls = []

    def replies(self, *answers):
        it = iter(answers)

        def request(method, url, body=None, headers=None, timeout=None, ca_file=None, server_name=None):
            self.calls.append({"method": method, "url": url, "body": body, "headers": dict(headers), "timeout": timeout})
            a = next(it)
            if isinstance(a, BaseException):
                raise a
            return a
        return request

    def post(self, request, budget=60.0, lease=LEASE):
        return storage.post(self.cfg, lease, KEY, VECTOR_BODY, self.clock.monotonic() + budget, request=request,
                            sleep=self.clock.sleep, clock=self.clock.clock, monotonic=self.clock.monotonic)

    def test_a_200_is_recorded_with_the_signed_headers(self):
        self.assertEqual(self.post(self.replies((200, b'{"recorded":true}'))), "recorded")
        (call,) = self.calls
        self.assertEqual((call["method"], call["url"], call["body"]), ("POST", "https://app.example.org/api/compute/aws/storage", VECTOR_BODY))
        h = call["headers"]
        self.assertEqual((h["X-Ezil-Computer-Id"], h["X-Ezil-Generation"], h["X-Ezil-Lease-Epoch"], h["X-Ezil-Timestamp"]),
                         (CID, "3", "7", str(VECTOR_TS)))
        self.assertEqual(h["X-Ezil-Signature"], VECTOR_SIG)
        self.assertNotIn(KEY.hex(), json.dumps(h))
        self.assertEqual(self.post(self.replies((200, b'{"recorded":false}'))), "duplicate")

    def test_transport_errors_429_and_5xx_retry_with_backoff_and_a_fresh_signature(self):
        out = self.post(self.replies(ConnectionResetError(), (503, b'{"error":"storage_unavailable","retryable":true}'),
                                     (429, b""), (502, b"<html>"), (200, b'{"recorded":true}')))
        self.assertEqual(out, "recorded")
        self.assertEqual(self.clock.sleeps, [1.0, 2.0, 4.0, 8.0])
        self.assertEqual({c["body"] for c in self.calls}, {VECTOR_BODY})   # same measurement every time
        self.assertEqual(len({c["headers"]["X-Ezil-Timestamp"] for c in self.calls}), 5)   # re-signed

    def test_other_answers_are_final_without_retry(self):
        for status in (400, 401, 403, 404, 413, 422):
            self.calls.clear()
            self.assertEqual(self.post(self.replies((status, b'{"error":"x"}'))), f"refused_{status}")
            self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_retries_stop_at_the_deadline(self):
        out = self.post(self.replies(*[OSError()] * 50), budget=20.0)
        self.assertEqual(out, "storage_retry_exhausted")
        self.assertLessEqual(sum(self.clock.sleeps), 20.0)
        self.assertEqual(self.clock.sleeps, [1.0, 2.0, 4.0, 8.0])
        self.assertTrue(all(c["timeout"] <= 10.0 for c in self.calls))

    def test_no_identity_or_origin_sends_nothing(self):
        self.assertEqual(self.post(self.replies(), lease={"generation": 3, "leaseEpoch": 7}), "storage_unconfigured")
        self.cfg["enrollUrl"] = None
        self.assertEqual(self.post(self.replies()), "storage_unconfigured")
        self.assertEqual(self.calls, [])


class FakeStop:
    """threading.Event stand-in: wait() returns False (keep going) `ticks` times, then True."""

    def __init__(self, ticks):
        self.ticks, self.waits = ticks, []

    def wait(self, s):
        self.waits.append(s)
        if len(self.waits) > self.ticks:
            return True
        return False


class Schedule(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.logs = []

    def test_first_sample_after_a_minute_then_every_fifteen_minutes_until_stopped(self):
        measured, posted = [], []
        sampler = storage.Sampler(self.cfg, LEASE, KEY, self.logs.append,
                                  measure_fn=lambda cfg, lease: measured.append(1) or 4096,
                                  request=lambda *a, **k: posted.append(k["body"]) or (200, b'{"recorded":true}'))
        self.assertTrue(sampler.enabled())
        stop = FakeStop(ticks=3)
        sampler.run(stop)
        self.assertEqual(stop.waits, [60.0, 900.0, 900.0, 900.0])
        self.assertEqual(len(measured), 3)
        self.assertEqual([json.loads(b)["reason"] for b in posted], ["interval"] * 3)
        self.assertEqual(self.logs, ["storage: sample recorded bytes=4096"] * 3)

    def test_an_unmounted_volume_or_a_crashing_measure_never_ends_the_loop(self):
        calls = []

        def flaky(cfg, lease):
            calls.append(1)
            if len(calls) == 1:
                raise RuntimeError("boom")
            return None
        sampler = storage.Sampler(self.cfg, LEASE, KEY, self.logs.append, measure_fn=flaky,
                                  request=lambda *a, **k: self.fail("nothing to post"))
        sampler.run(FakeStop(ticks=2))
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.logs, ["storage: sample error_RuntimeError", "storage: sample not_mounted"])

    def test_off_without_a_computer_an_origin_or_an_interval(self):
        self.assertFalse(storage.Sampler(self.cfg, {"generation": 3, "leaseEpoch": 7}, KEY, print).enabled())
        self.assertFalse(storage.Sampler(config.Config(dict(self.cfg, enrollUrl=None)), LEASE, KEY, print).enabled())
        self.assertFalse(storage.Sampler(config.Config(dict(self.cfg, storageSampleSeconds=0)), LEASE, KEY, print).enabled())
        self.assertTrue(storage.Sampler(self.cfg, LEASE, KEY, print).enabled())

    def test_a_backoff_wakes_when_the_agent_stops(self):
        # The periodic path sleeps on the stop event, so a stop never waits out a 30 s backoff.
        waits = []

        class Stop:
            def wait(self, s):
                waits.append(s)
                return len(waits) > 2   # tick, then the first backoff wait returns "stopped"
        posts = []
        sampler = storage.Sampler(self.cfg, LEASE, KEY, self.logs.append, measure_fn=lambda c, l: 1,
                                  request=lambda *a, **k: posts.append(1) or (503, b""))
        sampler.run(Stop())
        # tick, backoff 1 s, backoff 2 s → stopped (no busy loop of retries), then the loop's own wait ends it.
        self.assertEqual(waits, [60.0, 1.0, 2.0, 900.0])
        self.assertEqual(len(posts), 2)
        self.assertEqual(self.logs, ["storage: sample storage_stopped bytes=1"])


class StopSample(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.logs = []

    def test_the_stop_sample_is_bounded_by_its_budget_and_never_raises(self):
        clock = Clock()
        with mock.patch.object(storage.time, "monotonic", clock.monotonic):
            out = storage.on_stop(self.cfg, LEASE, KEY, self.logs.append, measure_fn=lambda c, l: 10,
                                  request=lambda *a, **k: (_ for _ in ()).throw(OSError("unreachable")),
                                  sleep=clock.sleep, monotonic=clock.monotonic, clock=clock.clock)
        self.assertEqual(out, "storage_retry_exhausted")
        self.assertLessEqual(sum(clock.sleeps), float(self.cfg.storageStopBudgetSeconds))
        self.assertEqual(self.logs, ["storage: stop sample storage_retry_exhausted"])

    def test_the_stop_sample_posts_reason_stop(self):
        bodies = []
        out = storage.on_stop(self.cfg, LEASE, KEY, self.logs.append, measure_fn=lambda c, l: 77,
                              request=lambda *a, **k: bodies.append(k["body"]) or (200, b'{"recorded":true}'))
        self.assertEqual(out, "recorded")
        self.assertEqual(json.loads(bodies[0])["reason"], "stop")
        self.assertEqual(json.loads(bodies[0])["bytes"], "77")

    def test_a_log_that_raises_still_never_raises(self):
        def bad_log(m):
            raise ValueError("log")
        self.assertEqual(storage.on_stop(self.cfg, LEASE, KEY, bad_log, measure_fn=lambda c, l: None), "not_mounted")


class AgentIntegration(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg = scratch(self)
        self.logs = []
        self.a = agentmod.Agent(self.cfg, dict(LEASE), log=self.logs.append, sleep=lambda s: None)

    def shutdown_order(self, on_stop):
        order = []

        def run(cmd, *a, **k):
            order.append("umount-data" if cmd[:1] == ["umount"] else "sync" if cmd[:1] == ["sync"] else "run")
            return subprocess.CompletedProcess(cmd, 0)
        with mock.patch.object(agentmod.tunnel, "fence"), mock.patch.object(agentmod.time, "sleep"), \
                mock.patch.object(agentmod.desktop, "stop", side_effect=lambda *a, **k: order.append("desktop") or "clean"), \
                mock.patch.object(agentmod.desktop, "overlay_umount"), mock.patch.object(agentmod.desktop, "netns_down"), \
                mock.patch.object(agentmod.export, "remove_container"), mock.patch.object(agentmod.canary, "stopped") as stopped, \
                mock.patch.object(agentmod.guard, "is_mounted", return_value=True), \
                mock.patch.object(agentmod.guard, "clear_stamp", side_effect=lambda cfg: order.append("stamp")), \
                mock.patch.object(agentmod.storage, "on_stop", side_effect=lambda *a, **k: order.append("storage") or on_stop()), \
                mock.patch.object(self.a, "power_off"), mock.patch.object(agentmod.subprocess, "run", side_effect=run):
            self.a.shutdown("idle")
        return order, stopped

    def test_shutdown_samples_after_the_sync_and_before_the_stamp_and_data_unmount(self):
        order, stopped = self.shutdown_order(lambda: "recorded")
        self.assertLess(order.index("desktop"), order.index("storage"))
        self.assertLess(order.index("sync"), order.index("storage"))
        self.assertLess(order.index("storage"), order.index("stamp"))
        self.assertLess(order.index("storage"), order.index("umount-data"))
        self.assertTrue(self.a.storage_stop.is_set(), "the periodic sampler is stopped before the quiesce")
        self.assertTrue(stopped.call_args.kwargs["quiesce_ok"])

    def test_the_real_stop_sample_with_an_unreachable_app_keeps_the_quiesce_ok(self):
        stamp(self.cfg)
        with mock.patch.object(storage, "measure", return_value=123), \
                mock.patch.object(storage.http, "request", side_effect=OSError("unreachable")), \
                mock.patch.object(storage.time, "sleep"):
            self.cfg["storageStopBudgetSeconds"] = 0.05
            real = storage.on_stop   # shutdown_order patches the module attribute; keep the real one
            order, stopped = self.shutdown_order(lambda: real(self.cfg, self.a.lease, self.a.key, self.logs.append))
        self.assertIn("storage", order)
        self.assertTrue(stopped.call_args.kwargs["quiesce_ok"])
        self.assertIn("storage: stop sample storage_retry_exhausted", self.logs)

    def test_an_agent_without_lease_key_or_sampler_still_quiesces_cleanly(self):
        bare = agentmod.Agent.__new__(agentmod.Agent)   # as test_canary builds one
        bare.cfg, bare.stop_outcome, bare.log, bare.sleep = self.cfg, None, self.logs.append, lambda s: None
        with mock.patch.object(agentmod.tunnel, "fence"), mock.patch.object(agentmod.time, "sleep"), \
                mock.patch.object(bare, "record_stop"), mock.patch.object(agentmod.guard, "clear_stamp"), \
                mock.patch.object(agentmod.desktop, "stop", return_value="clean"), mock.patch.object(agentmod.desktop, "overlay_umount"), \
                mock.patch.object(agentmod.desktop, "netns_down"), mock.patch.object(agentmod.export, "remove_container"), \
                mock.patch.object(agentmod.canary, "stopped") as stopped, mock.patch.object(bare, "power_off"), \
                mock.patch.object(agentmod.storage, "on_stop") as on_stop, \
                mock.patch.object(agentmod.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)):
            bare.shutdown("idle")
        on_stop.assert_not_called()
        self.assertTrue(stopped.call_args.kwargs["quiesce_ok"])

    def test_run_starts_the_sampler_thread_only_for_an_enrolled_computer(self):
        with mock.patch.object(agentmod.threading, "Thread") as thread:
            self.assertIsNotNone(self.a._start_storage_sampler())
        thread.assert_called_once()
        self.assertEqual(thread.call_args.kwargs["name"], "ezil-storage")
        self.assertIs(thread.call_args.kwargs["args"][0], self.a.storage_stop)
        bare = agentmod.Agent(self.cfg, {"generation": 3, "leaseEpoch": 7}, log=self.logs.append)
        with mock.patch.object(agentmod.threading, "Thread") as thread:
            self.assertIsNone(bare._start_storage_sampler())
        thread.assert_not_called()
        self.assertIn("storage: sampler off (no computer, app origin or interval)", self.logs)

    def test_the_agent_loop_ending_stops_the_sampler(self):
        with mock.patch.object(self.a, "serve"), mock.patch.object(self.a, "tick", return_value="stopped"), \
                mock.patch.object(self.a, "_start_storage_sampler") as start:
            self.a.run()
        start.assert_called_once()
        self.assertTrue(self.a.storage_stop.is_set())


if __name__ == "__main__":
    unittest.main()
