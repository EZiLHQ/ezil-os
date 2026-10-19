"""Pool behavior with temporary host state and mocked IMDS, HTTP and block devices.
No root, external network, credentials, or real mounts are needed.
"""
import base64
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from http.client import RemoteDisconnected
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from ezil_host import cli, config, desktop, enroll, guard, lease, pool
from ezil_host.fsops import Refused

POOL = {"kind": "pool", "poolHostId": "11111111-1111-4111-8111-111111111111",
        "poolGeneration": 1, "appOrigin": "https://app.example.test"}
CLAIM = {"computerId": "22222222-2222-4222-8222-222222222222", "generation": 4,
         "leaseEpoch": 9, "fence": "33333333-3333-4333-8333-333333333333",
         "volumeSerial": "vol0123456789abcdef0"}
FS_UUID = "44444444-4444-4444-8444-444444444444"
IDENTITY = {"document": '{"instanceId":"i-0123456789abcdef0"}', "signature": "c2ln\n"}
HEALTH = {"ok": True, "desktop": True, "editor": True}
ANSWER = json.dumps({"tunnelToken": "t" * 32, "controlKey": base64.b64encode(b"k" * 32).decode(),
                     "sandboxId": "guac-1111-2222", "zone": "example.test"}).encode()


class Clock:
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def sleep(self, seconds):
        self.now += seconds
        self.sleeps.append(seconds)


class PoolTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="ezil-pool-")
        self.addCleanup(temp.cleanup)
        self.cfg = config.Config(dict(config.DEFAULTS))
        self.cfg.update(runDir=os.path.join(temp.name, "run"), stateDir=os.path.join(temp.name, "state"),
                        dataMount=os.path.join(temp.name, "data"), deviceByIdDir=os.path.join(temp.name, "by-id"),
                        enrollUrl="https://app.example.test/api/compute/aws/enroll", userDataCopies=[],
                        enrollRetrySeconds=100, volumeWaitSeconds=3, volumeWaitIntervalSeconds=1)
        enroll._write_private(os.path.join(self.cfg.runDir, "identity.json"), json.dumps(IDENTITY).encode())
        self.clock = Clock()
        self.patch(pool.time, "sleep", side_effect=self.clock.sleep)
        self.patch(pool.time, "monotonic", side_effect=lambda: self.clock.now)

    def patch(self, obj, name, **kwargs):
        patch = mock.patch.object(obj, name, **kwargs)
        result = patch.start()
        self.addCleanup(patch.stop)
        return result

    def save_lease(self, value):
        enroll._write_private(os.path.join(self.cfg.runDir, "lease.json"), json.dumps(value).encode())


class Parsing(PoolTest):
    def test_pool_lease_has_no_disk_or_nonce_and_fetch_never_discovers_a_disk(self):
        for value in (POOL, dict(POOL, v=1)):
            self.assertEqual(lease.parse(json.dumps(value)), value)
        self.patch(enroll, "_imds_lease_and_identity", return_value=(json.dumps(POOL), "doc", "sig"))
        disk = self.patch(guard, "wait_provision_volume", side_effect=AssertionError("must not probe disks"))
        self.assertEqual(enroll.fetch_lease(self.cfg), POOL)
        disk.assert_not_called()

    def test_invalid_pool_leases(self):
        for changes in ({"poolHostId": "not-uuid"}, {"poolGeneration": True}, {"poolGeneration": 0},
                        {"poolGeneration": 2**53}, {"v": True}, {"v": 2}, {"volumeId": None},
                        {"nonce": "n" * 43}, {"provision": False}):
            with self.subTest(changes=changes), self.assertRaises(lease.LeaseError):
                lease.parse(json.dumps({**POOL, **changes}))

    def test_claim_required_fields_and_optional_enrollment_fields(self):
        self.assertEqual(pool.parse_claim(json.dumps(CLAIM)), CLAIM)
        rich = dict(CLAIM, nonce="n" * 43, fsUuid=FS_UUID, provision=True)
        self.assertEqual(pool.parse_claim(json.dumps(rich)), rich)
        self.assertEqual(pool.parse_claim(json.dumps(dict(CLAIM, dataMount="/", nonceConsumed=True))), CLAIM)
        for key in CLAIM:
            missing = dict(CLAIM)
            del missing[key]
            with self.subTest(key=key), self.assertRaises(Refused):
                pool.parse_claim(json.dumps(missing))

    def test_malformed_and_unsafe_claims(self):
        for raw in (b"", b"\xff", "null", "[]", "true", "{}"):
            with self.subTest(raw=raw), self.assertRaises(Refused):
                pool.parse_claim(raw)
        for key, values in {
            "generation": [True, 0, -1, 2**53, "4", 1.5],
            "leaseEpoch": [False, 0, -1, "9"],
            "computerId": [None, "id", CLAIM["computerId"] + "\n"],
            "fence": [None, "", "bad\nfence", "x" * 257],
            "volumeSerial": [None, "", "/dev/nvme0n1", "volXYZ", "vol01234567-part1", "vol01234567\n"],
            "nonce": [None, "short"], "fsUuid": [None, "invalid"], "provision": [1, "true", True],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(Refused):
                    pool.parse_claim(json.dumps({**CLAIM, key: value}))

    def test_https_origin_from_pool_lease_or_existing_config(self):
        self.assertEqual(pool.app_origin(self.cfg, POOL), "https://app.example.test")
        self.assertEqual(pool.app_origin(self.cfg, {}), "https://app.example.test")
        for url in ("http://app.test", "https://u:p@app.test", "https://app.test/path",
                    "https://app.test?x", "https://app.test#x", "/relative", 9):
            with self.subTest(url=url), self.assertRaisesRegex(Refused, "pool_app_origin_invalid"):
                pool.app_origin(self.cfg, dict(POOL, appOrigin=url))


class Requests(PoolTest):
    def test_identity_authenticated_enrollment_readiness_and_empty_claim(self):
        request = self.patch(pool.http, "request", side_effect=[(200, b"{}"), (204, b""), (204, b"not json")])
        client = pool.Client(self.cfg, POOL)
        client.enroll()
        client.ready(HEALTH)
        self.assertIsNone(client.claim())
        calls = request.call_args_list
        self.assertEqual([c.args for c in calls], [
            ("POST", POOL["appOrigin"] + "/api/compute/aws/pool/enroll"),
            ("POST", POOL["appOrigin"] + "/api/compute/aws/pool/ready"),
            ("GET", POOL["appOrigin"] + "/api/compute/aws/pool/claim"),
        ])
        self.assertEqual(json.loads(calls[0].kwargs["body"]), {
            "poolHostId": POOL["poolHostId"], "poolGeneration": 1,
            "identityDocument": IDENTITY["document"], "signature": IDENTITY["signature"],
        })
        self.assertEqual(json.loads(calls[1].kwargs["body"]), {"poolHostId": POOL["poolHostId"], "health": HEALTH})
        self.assertIsNone(calls[2].kwargs["body"])
        headers = calls[2].kwargs["headers"]
        self.assertEqual(base64.b64decode(headers["X-Ezil-Identity-Document"]).decode(), IDENTITY["document"])
        self.assertEqual(headers["X-Ezil-Identity-Signature"], "c2ln")
        self.assertEqual(headers["X-Ezil-Pool-Host-Id"], POOL["poolHostId"])
        self.assertEqual(headers["X-Ezil-Pool-Generation"], "1")

    def test_poll_every_second_and_reset_backoff_after_204(self):
        self.patch(pool.http, "request", side_effect=[ConnectionResetError(), (204, b""), (204, b""),
                                                     RemoteDisconnected(), (200, json.dumps(CLAIM).encode())])
        self.assertEqual(pool.wait_claim(pool.Client(self.cfg, POOL), self.cfg), CLAIM)
        self.assertEqual(self.clock.sleeps, [1, 1, 1, 1])

    def test_transport_rate_limit_and_retryable_errors_use_capped_backoff(self):
        replies = [OSError(), (429, b"slow"), (503, b'{"error":"busy","retryable":true}'),
                   (502, b"platform error"), (503, b"platform error"), (503, b"platform error"),
                   (503, b"platform error"), (200, json.dumps(CLAIM).encode())]
        request = self.patch(pool.http, "request", side_effect=replies)
        self.assertEqual(pool.Client(self.cfg, POOL).claim(), CLAIM)
        self.assertEqual(self.clock.sleeps, [1, 2, 4, 8, 16, 30, 30])
        self.assertEqual(request.call_count, 8)

    def test_retry_budget_is_bounded(self):
        self.cfg["enrollRetrySeconds"] = 5
        request = self.patch(pool.http, "request", side_effect=ConnectionError())
        with self.assertRaisesRegex(Refused, "pool_retry_exhausted"):
            pool.Client(self.cfg, POOL).claim()
        self.assertEqual(self.clock.sleeps, [1, 2])
        self.assertEqual(request.call_count, 3)

    def test_refusals_redirects_and_bad_json_are_final(self):
        request = self.patch(pool.http, "request")
        for status, body in ((403, b"forbidden"), (409, b"stale"), (302, b"redirect"),
                             (503, b'{"error":"retired"}'), (200, b"broken"), (200, b"{}")):
            request.reset_mock()
            request.return_value = status, body
            with self.subTest(status=status, body=body), self.assertRaises(Refused):
                pool.Client(self.cfg, POOL).claim()
            request.assert_called_once()
        self.assertEqual(self.clock.sleeps, [])

    def test_idle_pool_refreshes_enrollment_before_ten_minutes(self):
        client = mock.Mock()
        client.claim.side_effect = [None] * 301 + [CLAIM]
        ready = self.patch(pool, "wait_ready", return_value=HEALTH)
        self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
        client.enroll.assert_called_once_with()
        client.ready.assert_called_once_with(HEALTH)
        ready.assert_called_once_with(self.cfg)
        self.assertEqual(self.clock.sleeps, [1] * 301)


class Fences(PoolTest):
    def test_disabled_tags_use_authenticated_claim_and_durable_epoch(self):
        pool.reserve_claim(self.cfg, POOL, CLAIM, None)
        path = os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)
        with open(path) as f:
            record = json.load(f)
        self.assertEqual(record["fence"], CLAIM["fence"])
        self.assertEqual(record["leaseEpoch"], CLAIM["leaseEpoch"])
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        for epoch in (8, 9):
            with self.assertRaisesRegex(Refused, "epoch_not_increasing"):
                pool.reserve_claim(self.cfg, POOL, dict(CLAIM, leaseEpoch=epoch), None)
        with self.assertRaisesRegex(Refused, "pool_host_already_claimed"):
            pool.reserve_claim(self.cfg, POOL, dict(CLAIM, leaseEpoch=10), None)

    def test_mismatched_tag_refuses_without_recording_claim(self):
        with self.assertRaisesRegex(Refused, "pool_fence_mismatch"):
            pool.reserve_claim(self.cfg, POOL, CLAIM, "different-fence")
        self.assertFalse(os.path.exists(os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)))
        pool.reserve_claim(self.cfg, POOL, CLAIM, CLAIM["fence"])

    def test_corrupt_or_symlinked_epoch_state_refuses(self):
        path = os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)
        for raw in (b"not json", b"null", b'{"leaseEpoch":true}'):
            enroll._write_private(path, raw)
            with self.assertRaisesRegex(Refused, "pool_epoch_malformed"):
                pool.reserve_claim(self.cfg, POOL, CLAIM, None)
        os.unlink(path)
        os.symlink(os.path.join(self.cfg.runDir, "identity.json"), path)
        with self.assertRaisesRegex(Refused, "pool_epoch_malformed"):
            pool.reserve_claim(self.cfg, POOL, CLAIM, None)

    def test_imds_fallback_only_when_tags_are_disabled(self):
        request = self.patch(lease.http, "request")
        request.side_effect = [(200, b"token"), (404, b"")]
        self.assertIsNone(lease.Imds(self.cfg).fence_tag())
        request.side_effect = [(200, b"token"), (200, b"ezil:fence\nezil:computer"),
                               (200, CLAIM["fence"].encode())]
        self.assertEqual(lease.Imds(self.cfg).fence_tag(), CLAIM["fence"])
        for status, body in ((500, b""), (403, b""), (200, b"ezil:computer")):
            request.side_effect = [(200, b"token"), (status, body)]
            with self.subTest(status=status), self.assertRaises(lease.LeaseError):
                lease.Imds(self.cfg).fence_tag()


class Devices(PoolTest):
    def test_select_exact_serial_when_root_is_nvme1n1(self):
        data_id, root_id = "vol-0123456789abcdef0", "vol-aaaaaaaaaaaaaaaaa"
        links = {guard._volume_link(self.cfg, data_id): "/dev/nvme0n1",
                 guard._volume_link(self.cfg, root_id): "/dev/nvme1n1"}
        stats = {"/": SimpleNamespace(st_dev=os.makedev(259, 3)),
                 "/dev/nvme1n1": SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=os.makedev(259, 2)),
                 "/dev/nvme0n1": SimpleNamespace(st_mode=stat.S_IFBLK, st_rdev=os.makedev(259, 0))}
        self.patch(guard.os.path, "realpath", side_effect=lambda p, **kw: links[p])
        self.patch(guard.os, "stat", side_effect=lambda p: stats[p])
        command = self.patch(guard.subprocess, "run", return_value=SimpleNamespace(stdout="259:3\n259:2\n"))
        uuid = self.patch(guard, "fs_uuid", return_value=FS_UUID)
        for serial in (CLAIM["volumeSerial"], data_id):
            result = pool.computer_lease(self.cfg, dict(CLAIM, volumeSerial=serial))
            self.assertEqual(result["volumeId"], data_id)
            uuid.assert_called_with("/dev/nvme0n1")
        with self.assertRaisesRegex(Refused, "volume_is_root_device"):
            pool.computer_lease(self.cfg, dict(CLAIM, volumeSerial=root_id))
        self.assertTrue(all(c.args[0][0] == "lsblk" for c in command.call_args_list))

    def test_waits_for_claimed_serial_and_never_uses_another_attached_disk(self):
        os.makedirs(self.cfg.deviceByIdDir)
        other = os.path.join(self.cfg.deviceByIdDir, "nvme-Amazon_Elastic_Block_Store_volaaaaaaaaaaaaaaaaa")
        os.symlink("/dev/null", other)
        with self.assertRaisesRegex(Refused, "volume_device_missing"):
            pool.computer_lease(self.cfg, CLAIM)
        self.assertEqual(self.clock.sleeps, [1, 1, 1])

    def test_refuse_unformatted_disk_without_explicit_provision_fields(self):
        self.patch(guard, "wait_device_for_volume", return_value="/dev/nvme0n1")
        self.patch(guard, "fs_uuid", return_value=None)
        with self.assertRaisesRegex(Refused, "pool_volume_unformatted"):
            pool.computer_lease(self.cfg, CLAIM)
        result = pool.computer_lease(self.cfg, dict(CLAIM, fsUuid=FS_UUID, provision=True))
        self.assertEqual(result["fsUuid"], FS_UUID)
        self.assertTrue(result["provision"])

    def test_pool_disk_guard_disables_same_instance_reboot_exception(self):
        self.cfg["lowerDigestFile"] = os.path.join(self.cfg.runDir, "digest")
        with open(self.cfg.lowerDigestFile, "w") as f:
            f.write("sha256:" + "a" * 64)
        os.makedirs(self.cfg.dataMount)
        current = dict(CLAIM, volumeId="vol-0123456789abcdef0", fsUuid=FS_UUID)
        marker = guard.new_marker(current, "sha256:" + "a" * 64, "i-0123456789abcdef0")
        self.patch(guard, "mount_data")
        self.patch(guard, "mount_opts", return_value="ro,nosuid,nodev")
        self.patch(guard, "read_marker", return_value=marker)
        self.patch(guard.subprocess, "run")
        remount = self.patch(guard, "remount")
        with self.assertRaisesRegex(Refused, "epoch_not_increasing"):
            guard.run_guard(self.cfg, current, allow_reboot=False)
        remount.assert_not_called()


class Lifecycle(PoolTest):
    def test_warm_spec_uses_only_disposable_home_workspace_and_profiles(self):
        warm = pool.warm_config(self.cfg)
        for field, contents in (("imageConfigFile", {"Env": [], "WorkingDir": "/"}),
                                ("seccompProfile", {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []})):
            warm[field] = os.path.join(self.cfg.runDir, field + ".json")
            with open(warm[field], "w") as f:
                json.dump(contents, f)
        self.patch(desktop, "host_limits", return_value=(200000, 4 * 1024**3))
        overlay = self.patch(desktop, "overlay_mount")
        self.patch(desktop, "netns_up")
        run = self.patch(desktop, "run", return_value=0)
        pool.start_warm(warm, POOL)
        overlay.assert_called_once_with(warm)
        self.assertTrue(run.call_args.kwargs["detach"])
        with open(os.path.join(warm.runDir, "bundle", "config.json")) as f:
            spec = json.load(f)
        self.assertEqual(spec["root"]["path"], desktop.merged(warm))
        for bind in spec["mounts"]:
            if bind["destination"] in ("/workspace", "/var/lib/ezil-profiles"):
                self.assertTrue(bind["source"].startswith(warm.dataMount + "/"))
                self.assertFalse(bind["source"].startswith(self.cfg.dataMount + "/"))
        self.assertTrue(os.path.isdir(os.path.join(warm.dataMount, "root", "upper")))

    def test_readiness_requires_desktop_and_editor(self):
        self.patch(desktop, "state", return_value="running")
        probe = self.patch(desktop, "exec_", side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=22)])
        self.assertEqual(pool.health(self.cfg), {"ok": False, "desktop": True, "editor": False})
        self.assertIn("http://127.0.0.1:8443/healthz", probe.call_args.args[1])
        probe.side_effect = [SimpleNamespace(returncode=0)] * 2
        self.assertEqual(pool.health(self.cfg), HEALTH)

    def test_readiness_wait_and_timeout(self):
        probe = self.patch(pool, "health", side_effect=[{"ok": False}, subprocess.TimeoutExpired("runc", 5), HEALTH])
        self.assertEqual(pool.wait_ready(self.cfg), HEALTH)
        self.assertEqual(self.clock.sleeps, [1, 1])
        probe.side_effect = None
        probe.return_value = {"ok": False}
        with self.assertRaisesRegex(Refused, "pool_desktop_not_ready"):
            pool.wait_ready(self.cfg)
        self.assertEqual(sum(self.clock.sleeps), 182)

    def lifecycle_stubs(self):
        self.save_lease(POOL)
        client = mock.Mock(origin=POOL["appOrigin"])
        self.patch(pool, "Client", return_value=client)
        self.patch(pool, "start_warm")
        self.patch(pool, "wait_ready", return_value=HEALTH)
        self.patch(pool, "wait_claim", return_value=CLAIM)
        self.patch(lease.Imds, "fence_tag", return_value=None)
        self.patch(guard, "wait_device_for_volume", return_value="/dev/nvme0n1")
        self.patch(guard, "fs_uuid", return_value=FS_UUID)
        guarded = self.patch(guard, "run_guard", return_value="ok")
        stopped = self.patch(pool, "stop_warm")
        return client, guarded, stopped

    def test_claim_mount_enroll_and_switch_into_standard_chain(self):
        client, guarded, stopped = self.lifecycle_stubs()
        events = []
        guarded.side_effect = lambda *a, **kw: events.append("guard")
        stopped.side_effect = lambda *a: events.append("stop-warm")

        def post(method, url, **kwargs):
            events.append("enroll")
            self.assertEqual(url, POOL["appOrigin"] + "/api/compute/aws/enroll")
            body = json.loads(kwargs["body"])
            self.assertEqual(body["fence"], CLAIM["fence"])
            self.assertEqual(body["poolHostId"], POOL["poolHostId"])
            self.assertNotIn("nonce", body)
            self.assertTrue(os.path.exists(os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)))
            return 200, ANSWER

        self.patch(enroll.http, "request", side_effect=post)
        self.assertIn("pool claimed", cli.step(self.cfg, "guard"))
        self.assertEqual(events, ["guard", "enroll", "stop-warm"])
        client.ready.assert_called_once_with(HEALTH)
        self.assertFalse(guarded.call_args.kwargs["allow_reboot"])
        adopted = enroll.load_lease(self.cfg)
        self.assertEqual(adopted["computerId"], CLAIM["computerId"])
        self.assertEqual(adopted["fsUuid"], FS_UUID)
        self.assertTrue(adopted["nonceConsumed"])
        self.assertNotIn("kind", adopted)
        warm = stopped.call_args.args[0]
        self.assertNotEqual(warm.dataMount, self.cfg.dataMount)
        self.assertTrue(warm.dataMount.startswith(self.cfg.stateDir + "/"))
        # The ordinary enrollment unit reuses the exact epoch just enrolled.
        self.assertIn("re-enrolled", cli.enroll_or_reuse(self.cfg, adopted))
        self.patch(guard, "require_stamp")
        overlay = self.patch(desktop, "overlay_mount")
        self.patch(desktop, "netns_up")
        spec = self.patch(desktop, "build_spec")
        cli.step(self.cfg, "overlay")
        overlay.assert_called_once_with(self.cfg)
        self.assertEqual(spec.call_args.args[1]["computerId"], CLAIM["computerId"])

    def test_nonce_claim_uses_existing_enrollment_proof(self):
        self.lifecycle_stubs()
        self.patch(pool, "wait_claim", return_value=dict(CLAIM, nonce="n" * 43))
        request = self.patch(enroll.http, "request", return_value=(200, ANSWER))
        pool.run(self.cfg, POOL)
        body = json.loads(request.call_args.kwargs["body"])
        self.assertEqual(body["nonce"], "n" * 43)
        self.assertNotIn("fence", body)

    def test_enrollment_failure_unmounts_and_burns_host(self):
        _, guarded, stopped = self.lifecycle_stubs()
        self.patch(enroll.http, "request", return_value=(403, b"refused"))
        command = self.patch(pool.subprocess, "run")
        with self.assertRaisesRegex(Refused, "enroll_refused"):
            pool.run(self.cfg, POOL)
        command.assert_called_once_with(["umount", self.cfg.dataMount], check=True)
        stopped.assert_called_once()
        with self.assertRaisesRegex(Refused, "pool_host_already_claimed"):
            pool.run(self.cfg, POOL)
        guarded.assert_called_once()

    def test_fence_failure_precedes_disk_work_and_enrollment(self):
        _, guarded, stopped = self.lifecycle_stubs()
        self.patch(lease.Imds, "fence_tag", return_value="wrong")
        enroll_call = self.patch(enroll, "enroll")
        disk = self.patch(pool, "computer_lease")
        with self.assertRaisesRegex(Refused, "pool_fence_mismatch"):
            pool.run(self.cfg, POOL)
        guarded.assert_not_called()
        disk.assert_not_called()
        enroll_call.assert_not_called()
        stopped.assert_called_once()

    def test_unready_host_never_reports_ready_or_claims(self):
        client, guarded, stopped = self.lifecycle_stubs()
        self.patch(pool, "wait_ready", side_effect=Refused("pool_desktop_not_ready"))
        with self.assertRaisesRegex(Refused, "pool_desktop_not_ready"):
            pool.run(self.cfg, POOL)
        client.ready.assert_not_called()
        guarded.assert_not_called()
        stopped.assert_called_once()

    def test_failed_warm_stop_revokes_guard_and_unmounts_adopted_disk(self):
        _, _, stopped = self.lifecycle_stubs()
        self.patch(enroll.http, "request", return_value=(200, ANSWER))
        command = self.patch(pool.subprocess, "run")
        cleared = self.patch(guard, "clear_stamp")
        stopped.side_effect = Refused("pool_desktop_stop_failed")
        with self.assertRaisesRegex(Refused, "pool_desktop_stop_failed"):
            pool.run(self.cfg, POOL)
        cleared.assert_called_once_with(self.cfg)
        command.assert_called_once_with(["umount", self.cfg.dataMount], check=True)

    def test_warm_cleanup_preserves_host_state_and_symlink_targets(self):
        warm = pool.warm_config(self.cfg)
        os.makedirs(warm.dataMount)
        target = os.path.join(self.cfg.runDir, "identity.json")
        os.symlink(target, os.path.join(warm.dataMount, "guest-link"))
        self.patch(desktop, "stop")
        self.patch(desktop, "state", return_value="absent")
        self.patch(desktop, "overlay_umount")
        pool.stop_warm(warm)
        self.assertFalse(os.path.exists(warm.dataMount))
        with open(target) as f:
            self.assertEqual(json.load(f), IDENTITY)


if __name__ == "__main__":
    unittest.main()
