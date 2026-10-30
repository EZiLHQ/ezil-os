"""Pool behavior with temporary host state and mocked IMDS, HTTP and block devices.
No root, external network, credentials, or real mounts are needed.
"""
import base64
import copy
import fcntl
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from http.client import RemoteDisconnected
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lib"))
from ezil_host import agent, cli, config, desktop, enroll, guard, lease, pool, restore
from ezil_host.fsops import Refused

POOL = {"kind": "pool", "poolHostId": "11111111-1111-4111-8111-111111111111",
        "poolGeneration": 1, "appOrigin": "https://app.example.test"}
CLAIM = {"computerId": "22222222-2222-4222-8222-222222222222", "generation": 4,
         "leaseEpoch": 9, "fence": "33333333-3333-4333-8333-333333333333",
         "volumeSerial": "vol0123456789abcdef0", "enrollNonce": "n" * 43}
TAGS = {"ezil:computer": CLAIM["computerId"], "ezil:generation": "4",
        "ezil:lease-epoch": "9", "ezil:fence": CLAIM["fence"]}
FS_UUID = "44444444-4444-4444-8444-444444444444"
IDENTITY = {"document": '{"instanceId":"i-0123456789abcdef0"}', "signature": "c2ln\n"}
HEALTH = {"ok": True, "desktop": True, "editor": True}
TOKEN = "T0kEn_" + "x" * 37
RESTORE = {"kind": "cf-snapshot", "migrationId": "55555555-5555-4555-8555-555555555555",
           "generation": "66666666-6666-4666-8666-666666666666", "system": True,
           "fetchBase": POOL["appOrigin"] + "/api/compute/restore/" + CLAIM["computerId"], "identityToken": TOKEN}
RESTORE_CLAIM = dict(CLAIM, fsUuid=FS_UUID, createVolume=True, restore=RESTORE)
ANSWER = json.dumps({"tunnelToken": "t" * 32, "controlKey": base64.b64encode(b"k" * 32).decode(),
                     "sandboxId": "guac-1111-2222", "zone": "example.test"}).encode()


def restore_head(generation, chunks):
    """A Cloudflare v1 head as the app's restore route serves it (restore._head's shape)."""
    return {"version": 1, "generation": generation, "sha256": "a" * 64, "entries": chunks,
            "chunks": [{"size": 1024 * 1024, "sha256": "%064x" % i} for i in range(chunks)]}


class Clock:
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def sleep(self, seconds):
        self.now += seconds
        self.sleeps.append(seconds)


class PoolTest(unittest.TestCase):
    def setUp(self):
        self.patch(guard, "committed_digest", return_value="sha256:" + "a" * 64)
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
        rich = dict(CLAIM, fsUuid=FS_UUID, createVolume=True)
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
            "enrollNonce": [None, "short"], "fsUuid": [None, "invalid"], "createVolume": [1, "true", True],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(Refused):
                    pool.parse_claim(json.dumps({**CLAIM, key: value}))

    def test_claim_may_carry_the_migrations_restore_lease(self):
        # C3: the cold provision's RestoreLease (provider-migrate.ts restoreLeaseFor), carried by a claim.
        self.assertEqual(pool.parse_claim(json.dumps(RESTORE_CLAIM)), RESTORE_CLAIM)
        self.assertEqual(pool.parse_claim(json.dumps(RESTORE_CLAIM), origin=POOL["appOrigin"]), RESTORE_CLAIM)
        self.assertEqual(pool.parse_claim(json.dumps(dict(RESTORE_CLAIM, restore=dict(RESTORE, system=False))))["restore"]["system"], False)

    def test_restore_lease_is_closed_and_bound_to_this_computer_and_origin(self):
        other = "77777777-7777-4777-8777-777777777777"
        bad = {
            "kind": ["s3", None], "system": [1, "true", None], "migrationId": ["x", "ABCDEF77-7777-4777-8777-777777777777", None],
            "generation": ["", other + "\n"], "identityToken": ["short", "x" * 44, "bad token " + "x" * 33, None],
            "fetchBase": ["http://app.example.test/api/compute/restore/" + CLAIM["computerId"],
                          POOL["appOrigin"] + "/api/compute/restore/" + other,
                          POOL["appOrigin"] + "/api/compute/restore/" + CLAIM["computerId"] + "?x=1",
                          "https://u:p@app.example.test/api/compute/restore/" + CLAIM["computerId"],
                          "https://app.example.test:99999/api/compute/restore/" + CLAIM["computerId"], 7],
        }
        for key, values in bad.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    with self.assertRaises(Refused) as caught:
                        pool.parse_claim(json.dumps(dict(RESTORE_CLAIM, restore=dict(RESTORE, **{key: value}))))
                    self.assertNotIn(TOKEN, str(caught.exception), "the token is never echoed")
        for restore in ({**RESTORE, "extra": 1}, {k: v for k, v in RESTORE.items() if k != "system"}, [], None):
            with self.subTest(restore=restore), self.assertRaises(Refused):
                pool.parse_claim(json.dumps(dict(RESTORE_CLAIM, restore=restore)))
        with self.assertRaisesRegex(Refused, "restore fetchBase"):
            pool.parse_claim(json.dumps(RESTORE_CLAIM), origin="https://other.example.test")
        for claim in (dict(CLAIM, restore=RESTORE), dict(CLAIM, fsUuid=FS_UUID, restore=RESTORE)):
            with self.subTest(createVolume=claim.get("createVolume")), self.assertRaisesRegex(Refused, "restore requires createVolume"):
                pool.parse_claim(json.dumps(claim))

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
        self.assertEqual(json.loads(calls[1].kwargs["body"]), {"poolHostId": POOL["poolHostId"], "health": {"editorOk": True}})
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
        client.enroll.assert_called_once_with(retry_seconds=20)
        client.ready.assert_called_once_with(HEALTH, retry_seconds=20)
        ready.assert_called_once_with(self.cfg, timeout=20)
        self.assertEqual(self.clock.sleeps, [1] * 301)

    def test_claim_precedes_due_refresh(self):
        client = mock.Mock()
        client.claim.side_effect = [None] * 300 + [CLAIM]
        ready = self.patch(pool, "wait_ready", return_value=HEALTH)
        self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
        client.enroll.assert_not_called()
        client.ready.assert_not_called()
        ready.assert_not_called()

    def test_claim_arriving_during_refused_refresh_is_returned(self):
        self.patch(pool, "wait_ready", return_value=HEALTH)
        for operation in ("enroll", "ready"):
            for code in ("pool_unavailable", "pool_retry_exhausted", "pool_request_refused"):
                with self.subTest(operation=operation, code=code):
                    self.clock.now, self.clock.sleeps = 0, []
                    client = mock.Mock()
                    client.claim.side_effect = [None] * 301 + [CLAIM]
                    getattr(client, operation).side_effect = Refused(code)
                    self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
                    self.assertEqual(client.mock_calls[-1], mock.call.claim())
                    self.assertEqual(self.clock.sleeps, [1] * 300)

    def test_an_app_outage_while_waiting_keeps_the_host_but_a_refusal_ends_it(self):
        # R2-4: the guard's exit 2 is never restarted, so an outage (the claim request's own
        # retry budget spent) must not end the spare's pool agent. A refusal still does.
        self.patch(pool, "wait_ready", return_value=HEALTH)
        for code in ("pool_retry_exhausted", "pool_unavailable"):
            with self.subTest(code=code):
                self.clock.now, self.clock.sleeps = 0, []
                client = mock.Mock()
                client.claim.side_effect = [Refused(code), None, Refused(code), CLAIM]
                self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
                self.assertEqual((client.claim.call_count, self.clock.sleeps), (4, [1] * 3))
        client = mock.Mock()
        client.claim.side_effect = [None, Refused("pool_request_refused"), CLAIM]
        with self.assertRaisesRegex(Refused, "pool_request_refused"):
            pool.wait_claim(client, self.cfg)

    def test_an_outage_on_the_claim_check_after_a_failed_refresh_keeps_waiting(self):
        self.patch(pool, "wait_ready", return_value=HEALTH)
        client = mock.Mock()
        client.claim.side_effect = [None] * 301 + [Refused("pool_retry_exhausted"), None, CLAIM]
        client.enroll.side_effect = Refused("pool_retry_exhausted")
        self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
        self.assertEqual(client.claim.call_count, 304)

    def test_retryable_refresh_refusal_without_claim_keeps_polling(self):
        self.patch(pool, "wait_ready", return_value=HEALTH)
        for operation in ("enroll", "ready"):
            for code in ("pool_unavailable", "pool_retry_exhausted"):
                with self.subTest(operation=operation, code=code):
                    self.clock.now, self.clock.sleeps = 0, []
                    client = mock.Mock()
                    client.claim.side_effect = [None] * 302 + [CLAIM]
                    getattr(client, operation).side_effect = Refused(code)
                    self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
                    self.assertEqual(client.enroll.call_count, 1)
                    self.assertEqual(self.clock.sleeps, [1] * 301)

    def test_retryable_refresh_is_retried_on_next_cycle(self):
        self.patch(pool, "wait_ready", return_value=HEALTH)
        for operation in ("enroll", "ready"):
            with self.subTest(operation=operation):
                self.clock.now, self.clock.sleeps = 0, []
                client = mock.Mock()
                client.claim.side_effect = [None] * 303 + [CLAIM]
                getattr(client, operation).side_effect = [Refused("pool_retry_exhausted"), None]
                self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
                self.assertEqual(client.enroll.call_count, 2)
                self.assertEqual(client.ready.call_count, 1 if operation == "enroll" else 2)
                self.assertEqual(self.clock.sleeps, [1] * 302)

    def test_nonretryable_refresh_refusal_without_claim_raises(self):
        self.patch(pool, "wait_ready", return_value=HEALTH)
        for operation in ("enroll", "ready"):
            with self.subTest(operation=operation):
                self.clock.now, self.clock.sleeps = 0, []
                client = mock.Mock()
                client.claim.return_value = None
                refusal = Refused("pool_request_refused")
                getattr(client, operation).side_effect = refusal
                with self.assertRaises(Refused) as caught:
                    pool.wait_claim(client, self.cfg)
                self.assertIs(caught.exception, refusal)
                self.assertEqual(client.claim.call_count, 302)
                self.assertEqual(client.mock_calls[-1], mock.call.claim())

    def test_refresh_retry_budget_is_bounded_for_enroll_and_ready(self):
        self.patch(pool, "wait_ready", return_value=HEALTH)
        request = self.patch(pool.http, "request")
        for operation in ("enroll", "ready"):
            for budget in (5, 100, 540):
                with self.subTest(operation=operation, budget=budget):
                    self.clock.now, self.clock.sleeps = 0, []
                    self.cfg["enrollRetrySeconds"] = budget
                    attempts = []

                    def respond(method, url, **kwargs):
                        if url.endswith("/claim"):
                            if self.clock.now == 0:
                                self.clock.now = 300
                                return 204, b""
                            return 200, json.dumps(CLAIM).encode()
                        if url.endswith("/" + operation):
                            attempts.append((self.clock.now, kwargs["timeout"]))
                            return 503, b'{"error":"pool_unavailable","retryable":true}'
                        return 200, b"{}"

                    request.side_effect = respond
                    self.assertEqual(pool.wait_claim(pool.Client(self.cfg, POOL), self.cfg), CLAIM)
                    self.assertTrue(attempts)
                    self.assertLessEqual(self.clock.now - 300, min(20, budget))
                    for at, timeout in attempts:
                        self.assertLessEqual(at + timeout, 300 + min(20, budget))
                    self.assertEqual(self.cfg["enrollRetrySeconds"], budget)

    def test_initial_pool_enrollment_keeps_its_retry_budget(self):
        request = self.patch(pool.http, "request", side_effect=[
            (503, b'{"error":"pool_unavailable","retryable":true}')] * 5 + [(200, b"{}")])
        pool.Client(self.cfg, POOL).enroll()
        self.assertEqual(self.clock.sleeps, [1, 2, 4, 8, 16])
        self.assertEqual(request.call_count, 6)

    def test_refresh_health_wait_is_bounded_and_checks_claim_on_failure(self):
        client = mock.Mock()
        client.claim.side_effect = [None] * 301 + [CLAIM]
        self.patch(pool, "health", return_value={"ok": False})
        self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
        self.assertEqual(self.clock.now, 320)
        client.ready.assert_not_called()


class Readiness(PoolTest):
    """R2-4: a warm desktop's readiness miss is never fatal (first boot or refresh)."""

    def test_first_boot_bound_is_two_waits_with_a_liveness_enrollment_between(self):
        self.assertEqual((pool.FIRST_BOOT_READY_ATTEMPTS, pool.REFRESH_SECONDS), (2, 300))
        client = mock.Mock()
        events = []
        client.enroll.side_effect = lambda **kw: events.append(("enroll", self.clock.now))
        client.ready.side_effect = lambda health: events.append(("ready", self.clock.now))
        health = self.patch(pool, "health", side_effect=lambda cfg: HEALTH if self.clock.now >= 200 else {"ok": False})
        self.assertTrue(pool.first_ready(client, self.cfg))
        # 180 s miss, then re-enroll (the planner fails a spare not ready 5 min after enrolling),
        # then the second wait answers.
        self.assertEqual([e[0] for e in events], ["enroll", "ready"])
        self.assertAlmostEqual(events[0][1], 180.0, delta=0.5)
        self.assertLess(events[1][1], 180 + 180)
        self.assertGreater(health.call_count, 2)

    def test_first_boot_exhausted_returns_unready_never_raises(self):
        client = mock.Mock()
        self.patch(pool, "health", return_value={"ok": False})
        self.assertFalse(pool.first_ready(client, self.cfg))
        client.ready.assert_not_called()
        self.assertEqual(client.enroll.call_count, pool.FIRST_BOOT_READY_ATTEMPTS - 1)
        self.assertLessEqual(self.clock.now, pool.FIRST_BOOT_READY_ATTEMPTS * 180 + 1, "bounded")

    def test_first_boot_retry_enrollment_tolerates_an_outage_but_not_a_refusal(self):
        for code, raises in (("pool_retry_exhausted", False), ("pool_unavailable", False), ("pool_request_refused", True)):
            with self.subTest(code=code):
                self.clock.now = 0
                client = mock.Mock()
                client.enroll.side_effect = Refused(code)
                self.patch(pool, "wait_ready", side_effect=[Refused("pool_desktop_not_ready"), HEALTH])
                if raises:
                    with self.assertRaisesRegex(Refused, code):
                        pool.first_ready(client, self.cfg)
                    client.ready.assert_not_called()
                else:
                    self.assertTrue(pool.first_ready(client, self.cfg))
                    client.ready.assert_called_once_with(HEALTH)

    def test_other_first_boot_failures_still_raise(self):
        client = mock.Mock()
        self.patch(pool, "wait_ready", side_effect=Refused("pool_desktop_start_failed"))
        with self.assertRaisesRegex(Refused, "pool_desktop_start_failed"):
            pool.first_ready(client, self.cfg)

    def test_refresh_miss_keeps_the_host_and_tries_again_next_refresh(self):
        client = mock.Mock()
        client.claim.side_effect = [None] * 700 + [CLAIM]
        calls = []
        client.enroll.side_effect = lambda **kw: calls.append(("enroll", self.clock.now))
        client.ready.side_effect = lambda h, **kw: calls.append(("ready", self.clock.now))
        ok = iter([False, True])
        self.patch(pool, "wait_ready", side_effect=lambda cfg, timeout: HEALTH if next(ok) else (_ for _ in ()).throw(
            Refused("pool_desktop_not_ready")))
        self.assertEqual(pool.wait_claim(client, self.cfg), CLAIM)
        # The miss at 300 refreshed nothing (an unready host ages out of the claimable set); the
        # next refresh, 300 s later, enrolled and posted ready.
        self.assertEqual([c[0] for c in calls], ["enroll", "ready"])
        self.assertEqual(calls[0][1], 600)

    def test_unit_restarts_a_failed_agent_rate_bounded_and_never_a_refusal(self):
        path = os.path.join(os.path.dirname(__file__), "..", "systemd", "ezil-guard.service")
        sections, current = {}, None
        with open(path) as f:
            for raw in f:
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("["):
                    current = sections.setdefault(line[1:-1], {})
                    continue
                key, _, value = line.partition("=")
                current[key] = value
        service, unit = sections["Service"], sections["Unit"]
        self.assertEqual((service["Type"], service["Restart"]), ("oneshot", "on-failure"),
                         "oneshot allows on-failure only (systemd refuses always/on-success)")
        # normal mode passes through failed: every Requires= dependent's start job fails with it
        # and nothing starts them again (the ezil-enroll.service rule). Unit-file only: that the
        # dependents still start after one failed run is a live check on a systemd 255 host.
        self.assertEqual(service.get("RestartMode"), "direct", "a restart must not fail the dependents")
        self.assertGreater(int(service["RestartSec"]), 0)
        self.assertGreater(int(unit["StartLimitIntervalSec"]), 0)
        self.assertGreater(int(unit["StartLimitBurst"]), 0)
        self.assertLessEqual(int(unit["StartLimitBurst"]), 5, "bounded restart rate")
        self.assertIn("2", service["RestartPreventExitStatus"].split(), "a C-4 refusal is never retried")


class Timing(PoolTest):
    def test_relay_poll_detects_arrival_within_quarter_second(self):
        self.patch(desktop, "read_desktop_config", side_effect=[None, None, {"expiresAt": 1000}])
        self.assertIsNotNone(desktop.wait_desktop_config(self.cfg, 30, clock=lambda: self.clock.now,
                                                        sleep=self.clock.sleep))
        self.assertEqual(self.clock.sleeps, [0.25, 0.25])

    def test_warm_stop_requires_absence_before_unmount(self):
        self.patch(desktop, "stop")
        self.patch(desktop, "state", return_value="running")
        unmount = self.patch(desktop, "overlay_umount")
        with self.assertRaisesRegex(Refused, "pool_desktop_stop_failed"):
            pool.stop_warm(pool.warm_config(self.cfg))
        unmount.assert_not_called()

    def test_claim_publication_is_optional_bounded_numeric(self):
        for value in (0, 1790000000000, 4102444800000):
            claim = pool.parse_claim(json.dumps(dict(CLAIM, claimPublishedAtMs=value)))
            self.assertEqual(claim["claimPublishedAtMs"], value)
            self.assertEqual(pool.timing(self.cfg, "claimObservedMs", claim)["claimPublishedAtMs"], value)
        for value in (True, "123", None, -1, 4102444800001, float("inf")):
            with self.subTest(value=value), self.assertRaises(Refused):
                pool.parse_claim(json.dumps(dict(CLAIM, claimPublishedAtMs=value)))

    def test_timing_drops_non_numeric_unknown_and_unbounded_values(self):
        enroll._write_private(os.path.join(self.cfg.runDir, pool.TIMING_FILE), json.dumps({
            "claimObservedMs": True, "guardDoneMs": -1, "enrollDoneMs": "secret",
            "warmStoppedMs": 2**54, "desktopHealthyMs": float("nan"), "nonce": CLAIM["enrollNonce"],
            "relayAvailableMs": 10, "desktopStartedMs": 11,
        }).encode())
        self.assertEqual(pool.timing(self.cfg), {"relayAvailableMs": 10, "desktopStartedMs": 11})


class Fences(PoolTest):
    def test_durable_epoch_refuses_replay_and_second_tenant(self):
        pool.reserve_claim(self.cfg, POOL, CLAIM)
        path = os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)
        record = pool.read_record(self.cfg)
        self.assertEqual(record["claim"], CLAIM)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        for epoch in (8, 9, 10):
            code = "epoch_not_increasing" if epoch <= 9 else "pool_host_already_claimed"
            with self.assertRaisesRegex(Refused, code):
                pool.reserve_claim(self.cfg, POOL, dict(CLAIM, generation=CLAIM["generation"] + 1, leaseEpoch=epoch))

    def test_authenticated_claim_needs_no_imds_tags(self):
        request = self.patch(lease.http, "request", side_effect=AssertionError("IMDS tags disabled"))
        pool.reserve_claim(self.cfg, POOL, CLAIM)
        self.assertEqual(pool.read_record(self.cfg)["claim"], CLAIM)
        request.assert_not_called()

    def test_instance_identity_is_required(self):
        self.patch(guard, "current_instance_id", return_value=None)
        with self.assertRaisesRegex(Refused, "pool_instance_missing"):
            pool.reserve_claim(self.cfg, POOL, CLAIM)

    def test_corrupt_or_symlinked_epoch_state_refuses(self):
        path = os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)
        for raw in (b"not json", b"null", b'{"leaseEpoch":true}'):
            enroll._write_private(path, raw)
            with self.assertRaisesRegex(Refused, "pool_epoch_malformed"):
                pool.reserve_claim(self.cfg, POOL, CLAIM)
        os.unlink(path)
        os.symlink(os.path.join(self.cfg.runDir, "identity.json"), path)
        with self.assertRaisesRegex(Refused, "pool_epoch_malformed"):
            pool.reserve_claim(self.cfg, POOL, CLAIM)

    def test_generation_must_increase_independently_of_epoch(self):
        pool.reserve_claim(self.cfg, POOL, CLAIM)
        for generation in (CLAIM["generation"] - 1, CLAIM["generation"]):
            with self.assertRaisesRegex(Refused, "epoch_not_increasing"):
                pool.reserve_claim(self.cfg, POOL, dict(CLAIM, generation=generation, leaseEpoch=99))

    def test_pool_has_no_tag_reader(self):
        self.assertFalse(hasattr(lease.Imds, "claim_tags"))
        self.assertFalse(hasattr(lease.Imds, "fence_tag"))


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
        with self.assertRaisesRegex(Refused, "pool_volume_unformatted"):
            pool.computer_lease(self.cfg, dict(CLAIM, fsUuid=FS_UUID))
        probe = self.patch(pool.subprocess, "run", return_value=SimpleNamespace(returncode=2, stdout=""))
        result = pool.computer_lease(self.cfg, dict(CLAIM, fsUuid=FS_UUID, createVolume=True))
        self.assertEqual(result["fsUuid"], FS_UUID)
        self.assertTrue(result["provision"])
        for status, output in ((0, "TYPE=ext4"), (2, "PTTYPE=gpt"), (4, "")):
            probe.return_value = SimpleNamespace(returncode=status, stdout=output)
            with self.assertRaisesRegex(Refused, "pool_volume_has_signature"):
                pool.computer_lease(self.cfg, dict(CLAIM, fsUuid=FS_UUID, createVolume=True))

    def test_restore_claim_lease_restores_into_the_fresh_volume(self):
        self.patch(guard, "wait_device_for_volume", return_value="/dev/nvme0n1")
        self.patch(guard, "fs_uuid", return_value=None)
        self.patch(pool.subprocess, "run", return_value=SimpleNamespace(returncode=2, stdout=""))
        result = pool.computer_lease(self.cfg, RESTORE_CLAIM)
        self.assertEqual((result["restore"], result["provision"], result["fsUuid"]), (RESTORE, True, FS_UUID))
        self.assertIsNot(result["restore"], RESTORE_CLAIM["restore"], "the guard augments its own copy")
        self.assertNotIn("restore", pool.computer_lease(self.cfg, dict(CLAIM, fsUuid=FS_UUID, createVolume=True)))

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
        self.assertEqual(self.clock.sleeps, [0.25, 0.25])
        probe.side_effect = None
        probe.return_value = {"ok": False}
        with self.assertRaisesRegex(Refused, "pool_desktop_not_ready"):
            pool.wait_ready(self.cfg)
        self.assertEqual(sum(self.clock.sleeps), 180.5)

    def lifecycle_stubs(self):
        self.save_lease(POOL)
        client = mock.Mock(origin=POOL["appOrigin"])
        client.claim.return_value = None
        self.patch(pool, "Client", return_value=client)
        self.patch(pool, "start_warm")
        self.patch(pool, "wait_ready", return_value=HEALTH)
        self.patch(pool, "wait_claim", return_value=CLAIM)
        self.patch(desktop, "state", return_value="absent")
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
            self.assertEqual(body["nonce"], CLAIM["enrollNonce"])
            self.assertNotIn("poolHostId", body)
            self.assertNotIn("fence", body)
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
        spec.assert_not_called()  # relay-aware spec is built once by run_desktop

    def test_nonce_claim_uses_existing_enrollment_proof(self):
        self.lifecycle_stubs()
        self.patch(pool, "wait_claim", return_value=dict(CLAIM, enrollNonce="n" * 43))
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

    def test_invalid_claim_precedes_disk_work_and_enrollment(self):
        client, guarded, stopped = self.lifecycle_stubs()
        self.patch(pool, "wait_claim", return_value=dict(CLAIM, fence=""))
        enroll_call = self.patch(enroll, "enroll")
        disk = self.patch(pool, "computer_lease")
        with self.assertRaisesRegex(Refused, "pool_claim_invalid"):
            pool.run(self.cfg, POOL)
        guarded.assert_not_called()
        disk.assert_not_called()
        enroll_call.assert_not_called()
        stopped.assert_called_once()

    def test_unready_host_without_claim_never_reports_ready_or_adopts(self):
        # R2-4 changed this from "pool_desktop_not_ready ends the agent" (one miss ended the
        # host's pool agent for good): the unready host is kept, never posts ready, and waits
        # for a claim, which the app never publishes to an unready host. Here the planner then
        # fails it (the refresh's enrollment is refused) and nothing is adopted.
        client, guarded, stopped = self.lifecycle_stubs()
        self.patch(pool, "wait_ready", side_effect=Refused("pool_desktop_not_ready"))
        waited = self.patch(pool, "wait_claim", side_effect=Refused("pool_request_refused", "enroll HTTP 409"))
        with self.assertRaisesRegex(Refused, "pool_request_refused"):
            pool.run(self.cfg, POOL)
        client.ready.assert_not_called()
        waited.assert_called_once()
        self.assertEqual(client.enroll.call_count, pool.FIRST_BOOT_READY_ATTEMPTS)
        client.claim.assert_called_once_with()
        guarded.assert_not_called()
        stopped.assert_called_once()

    def test_first_boot_miss_then_success_ends_ready_and_adopts(self):
        client, guarded, _ = self.lifecycle_stubs()
        self.patch(pool, "wait_ready", side_effect=[Refused("pool_desktop_not_ready"), HEALTH])
        self.patch(enroll.http, "request", return_value=(200, ANSWER))
        self.assertIn("pool claimed", pool.run(self.cfg, POOL))
        client.ready.assert_called_once_with(HEALTH)
        self.assertEqual(client.enroll.call_args_list, [mock.call(), mock.call(retry_seconds=20)])
        guarded.assert_called_once()

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
        stop = self.patch(desktop, "stop")
        self.patch(desktop, "state", return_value="absent")
        self.patch(desktop, "overlay_umount")
        pool.stop_warm(warm)
        stop.assert_called_once_with(warm, grace=0, kill=True)
        self.assertFalse(os.path.exists(warm.dataMount))
        with open(target) as f:
            self.assertEqual(json.load(f), IDENTITY)


class Resume(PoolTest):
    lifecycle_stubs = Lifecycle.lifecycle_stubs

    def setUp(self):
        super().setUp()
        self.client, self.guarded, self.stopped = self.lifecycle_stubs()
        self.request = self.patch(enroll.http, "request", return_value=(200, ANSWER))
        self.command = self.patch(pool.subprocess, "run")

    def test_reserved_claim_resumes_without_pool_reentry(self):
        pool.reserve_claim(self.cfg, POOL, CLAIM)
        pool.run(self.cfg, POOL)
        self.client.enroll.assert_not_called()
        self.client.ready.assert_not_called()
        self.assertFalse(self.guarded.call_args.kwargs["allow_reboot"])
        self.assertEqual(pool.read_record(self.cfg)["phase"], "switched")

    def test_restore_claim_reaches_the_guard_and_survives_a_resume(self):
        # C3: the adopted spare restores before the marker, as the cold provision does.
        self.patch(pool, "wait_claim", return_value=RESTORE_CLAIM)
        self.patch(guard, "fs_uuid", return_value=None)
        self.command.return_value = SimpleNamespace(returncode=2, stdout="")
        self.guarded.side_effect = SystemExit(99)          # crash inside the guard (the restore)
        with self.assertRaises(SystemExit):
            pool.run(self.cfg, POOL)
        lease = self.guarded.call_args.args[1]
        self.assertEqual((lease["restore"], lease["provision"]), (RESTORE, True))
        record = pool.read_record(self.cfg)
        self.assertEqual((record["phase"], record["claim"]["restore"], record["lease"]["restore"]),
                         ("guarding", RESTORE, RESTORE))
        self.guarded.side_effect = None
        pool.run(self.cfg, POOL)
        # run_guard is mocked: this proves the claim-shaped lease reaches a resumed guard, not that
        # the real guard accepts it once a restore began (restore.matches needs the heads, so it
        # refuses restore_head_invalid, exactly as the cold path's same-instance reboot does).
        self.assertEqual(self.guarded.call_args.args[1]["restore"], RESTORE)
        self.assertEqual(pool.read_record(self.cfg)["phase"], "switched")

    def test_fetched_restore_heads_stay_in_the_guards_copy_never_in_the_saved_lease(self):
        # C3: restore.http_fetch publishes the heads INTO the lease it is given (spec.update). A
        # 30-chunk workspace head pushes that lease past lease.parse's 3072-byte bound, so a saved
        # copy would make every later read_record (the overlay step's session_record) refuse
        # pool_epoch_malformed. The real fetch runs here, against a stubbed restore route.
        self.patch(pool, "wait_claim", return_value=RESTORE_CLAIM)
        self.patch(guard, "fs_uuid", return_value=None)
        self.command.return_value = SimpleNamespace(returncode=2, stdout="")
        heads = {kind: restore_head(RESTORE["generation"], n) for kind, n in (("workspace", 30), ("system", 2))}
        self.patch(restore.SnapshotClient, "get", side_effect=lambda path, token, response_limit=None: (
            200, json.dumps(heads[path.split("/")[-2]]).encode()))

        def guard_with_the_real_fetch(cfg, computer_lease, **kwargs):
            restore.http_fetch(cfg, restore.SnapshotClient(cfg, computer_lease))
            return "init"
        self.guarded.side_effect = guard_with_the_real_fetch
        pool.run(self.cfg, POOL)
        fetched = self.guarded.call_args.args[1]["restore"]
        self.assertEqual((fetched["workspace"], fetched["system"]), (heads["workspace"], heads["system"]),
                         "the guard's own copy carries the fetched heads")
        record, saved = pool.read_record(self.cfg), enroll.load_lease(self.cfg)
        for kept in (record["claim"]["restore"], record["lease"]["restore"], saved["restore"]):
            self.assertEqual(kept, RESTORE, "every saved copy stays claim-shaped")
        self.assertEqual(pool.session_record(self.cfg, saved)["phase"], "switched")
        lease.parse(json.dumps({k: v for k, v in saved.items() if k in lease.LEASE_KEYS}))

    def test_restart_with_leased_host_picks_up_claim_before_pool_enrollment(self):
        warm = self.patch(pool, "start_warm")
        self.patch(desktop, "state", return_value="running")
        self.client.claim.return_value = CLAIM
        self.client.enroll.side_effect = Refused("pool_unavailable")
        self.assertIsNone(pool.read_record(self.cfg))
        self.assertIn("pool claimed", cli.step(self.cfg, "guard"))
        self.assertEqual(self.client.mock_calls, [mock.call.claim()])
        warm.assert_not_called()
        self.guarded.assert_called_once()
        self.request.assert_called_once()
        self.assertEqual(pool.read_record(self.cfg)["phase"], "switched")

    def test_crash_after_marker_commit_resumes_same_instance_epoch(self):
        self.guarded.side_effect = SystemExit(99)
        with self.assertRaises(SystemExit):
            pool.run(self.cfg, POOL)
        self.guarded.side_effect = None
        pool.run(self.cfg, POOL)
        self.assertTrue(self.guarded.call_args.kwargs["allow_reboot"])
        self.assertEqual(self.client.enroll.call_count, 1)
        self.request.assert_called_once()

    def test_crash_after_enrollment_receipt_reuses_nonce_and_never_reenrolls(self):
        original = enroll.mark_nonce_consumed
        retire = self.patch(enroll, "mark_nonce_consumed", side_effect=SystemExit(99))
        with self.assertRaises(SystemExit):
            pool.run(self.cfg, POOL)
        retire.side_effect = original
        pool.run(self.cfg, POOL)
        self.request.assert_called_once()
        record = pool.read_record(self.cfg)
        self.assertNotIn("enrollNonce", record["claim"])
        self.assertNotIn("nonce", record["lease"])

    def test_restart_after_switch_reuses_enrollment_and_does_not_stop_again(self):
        pool.run(self.cfg, POOL)
        # IMDS user data remains kind:pool after a reboot; tmpfs lease is repopulated.
        self.save_lease(POOL)
        pool.run(self.cfg, POOL)
        self.request.assert_called_once()
        self.stopped.assert_called_once()
        self.assertEqual(self.client.enroll.call_count, 1)
        self.assertTrue(enroll.load_lease(self.cfg)["nonceConsumed"])

    def test_guard_restart_with_computer_lease_checks_instance(self):
        pool.run(self.cfg, POOL)
        self.patch(guard, "current_instance_id", return_value="i-other")
        with self.assertRaisesRegex(Refused, "pool_resume_mismatch"):
            cli.step(self.cfg, "guard")
        self.guarded.assert_called_once()

    def test_guard_restart_retains_the_original_app_origin(self):
        pool.run(self.cfg, POOL)
        self.cfg["enrollUrl"] = "https://other.example.test/api/compute/aws/enroll"
        client = self.patch(pool, "Client", wraps=pool.Client)
        cli.step(self.cfg, "guard")
        self.assertEqual(client.call_args.args[1]["appOrigin"], POOL["appOrigin"])

    def test_resume_refuses_changed_pool_or_instance(self):
        record = pool.reserve_claim(self.cfg, POOL, CLAIM)
        for key, value in (("poolHostId", CLAIM["computerId"]), ("poolGeneration", 2),
                           ("instanceId", "i-other")):
            changed = copy.deepcopy(record)
            changed[key] = value
            pool.save_record(self.cfg, changed)
            with self.subTest(key=key), self.assertRaisesRegex(Refused, "pool_resume_mismatch"):
                pool.run(self.cfg, POOL)
        self.guarded.assert_not_called()
        self.request.assert_not_called()

    def test_epoch_mismatch_precedes_mount_and_enroll(self):
        self.patch(pool, "wait_claim", return_value=dict(CLAIM, leaseEpoch=0))
        with self.assertRaisesRegex(Refused, "pool_claim_invalid"):
            pool.run(self.cfg, POOL)
        self.guarded.assert_not_called()
        self.request.assert_not_called()

    def test_concurrent_guard_activation_refuses(self):
        os.makedirs(self.cfg.stateDir, exist_ok=True)
        fd = os.open(self.cfg.stateDir, os.O_RDONLY | os.O_DIRECTORY)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(Refused, "pool_adoption_busy"):
                pool.run(self.cfg, POOL)
        finally:
            os.close(fd)
        self.guarded.assert_not_called()

    def test_corrupt_resume_records_refuse(self):
        pool.run(self.cfg, POOL)
        good = pool.read_record(self.cfg)
        cases = [{**good, "phase": "other"}, {**good, "instanceId": None}, {**good, "lease": None},
                 {**good, "poolGeneration": True},
                 {**good, "lease": {**good["lease"], "fsUuid": "bad"}},
                 {**good, "claim": {**good["claim"], "leaseEpoch": True}},
                 {**good, "lease": {**good["lease"], "computerId": POOL["poolHostId"]}},
                 {**good, "lease": {**good["lease"], "volumeId": "vol-aaaaaaaaaaaaaaaaa"}}]
        for value in cases:
            pool.save_record(self.cfg, value)
            with self.assertRaisesRegex(Refused, "pool_epoch_malformed"):
                pool.run(self.cfg, POOL)

    def test_failure_body_and_nonce_never_reach_logs(self):
        self.request.return_value = (403, CLAIM["enrollNonce"].encode() + ANSWER)
        out = io.StringIO()
        with redirect_stdout(out), self.assertRaises(Refused) as caught:
            pool.run(self.cfg, POOL)
        for secret in (CLAIM["enrollNonce"], "t" * 32, base64.b64encode(b"k" * 32).decode()):
            self.assertNotIn(secret, out.getvalue() + str(caught.exception))
            self.assertNotIn(secret, json.dumps(pool.read_record(self.cfg)))

    def test_warm_guard_restart_reuses_running_scratch(self):
        self.patch(desktop, "state", return_value="running")
        warm = self.patch(pool, "start_warm")
        pool.run(self.cfg, POOL)
        warm.assert_not_called()


class Sessions(PoolTest):
    lifecycle_stubs = Lifecycle.lifecycle_stubs

    def setUp(self):
        super().setUp()
        self.client, self.guarded, self.stopped = self.lifecycle_stubs()
        self.patch(enroll.http, "request", return_value=(200, ANSWER))
        self.patch(pool.subprocess, "run")
        pool.run(self.cfg, POOL)
        self.client.request.return_value = (200, b"{}")
        self.adopted = enroll.load_lease(self.cfg)
        self.patch(guard, "require_stamp")
        self.running = False
        self.state = self.patch(desktop, "state", side_effect=lambda cfg: "running" if self.running else "absent")
        from test_ice import relay_config
        self.relay = relay_config()
        self.wait_relay = self.patch(desktop, "wait_desktop_config", return_value=self.relay)
        self.real_spec = desktop.build_spec
        self.spec = self.patch(desktop, "build_spec")
        self.start = self.patch(desktop, "run", side_effect=self.started)
        self.health = self.patch(pool, "health", return_value=HEALTH)
        self.ready = self.patch(pool, "wait_ready", side_effect=lambda *a, **kw: self.health(self.cfg))

    def started(self, *args, **kwargs):
        self.running = True
        return 0

    def test_single_restart_with_relay_and_user_disk_before_ready(self):
        events = []
        self.start.side_effect = lambda *a, **kw: (events.append("user-start"), self.started())[1]
        self.ready.side_effect = lambda *a, **kw: events.append("user-healthy") or HEALTH
        self.assertIn("healthy", cli.step(self.cfg, "desktop", detach=True))
        self.assertTrue(pool.session_ready(self.cfg, self.adopted))
        cli.step(self.cfg, "desktop", detach=True)
        self.stopped.assert_called_once()
        self.start.assert_called_once()
        self.assertEqual(events, ["user-start", "user-healthy", "user-healthy"])
        self.assertEqual(self.spec.call_args.args[0].dataMount, self.cfg.dataMount)
        self.assertEqual(self.spec.call_args.args[1]["computerId"], CLAIM["computerId"])
        self.assertEqual(self.spec.call_args.kwargs["desktop_config"], self.relay)
        self.assertEqual(desktop.read_ice_state(self.cfg), "applied")

    def test_session_ack_follows_health_once_and_requires_success(self):
        self.client.request.side_effect = [(204, b""), (200, b"{}")]
        self.ready.side_effect = lambda *a, **kw: self.assertEqual(self.client.request.call_count, 0) or HEALTH
        with self.assertRaisesRegex(Refused, "pool_session_ack_refused"):
            cli.step(self.cfg, "desktop", detach=True)
        self.ready.assert_called_once()
        self.assertNotIn("sessionReadyReported", pool.read_record(self.cfg))
        self.ready.side_effect = None
        cli.step(self.cfg, "desktop", detach=True)
        cli.step(self.cfg, "desktop", detach=True)
        self.assertEqual(self.client.request.call_count, 2)
        self.client.request.assert_called_with("POST", "session-ready",
                                               {"sessionReady": True, "timing": pool.timing(self.cfg)})
        self.start.assert_called_once()

    def test_numeric_timings_cross_units_and_preserve_first_observation(self):
        initial = pool.timing(self.cfg)
        self.assertEqual(set(initial), set(pool.TIMING_PHASES[:4]))
        self.clock.now = 1.25
        self.wait_relay.side_effect = lambda *a, **kw: self.relay
        self.start.side_effect = lambda *a, **kw: (self.clock.sleep(0.125), self.started())[1]
        self.ready.side_effect = lambda *a, **kw: self.clock.sleep(0.25) or HEALTH
        cli.step(self.cfg, "desktop", detach=True)
        payload = self.client.request.call_args.args[2]
        self.assertEqual(set(payload["timing"]), set(pool.TIMING_PHASES))
        self.assertEqual(payload["timing"]["relayAvailableMs"], 1250)
        self.assertEqual(payload["timing"]["desktopStartedMs"], 1375)
        self.assertEqual(payload["timing"]["desktopHealthyMs"], 1625)
        self.assertTrue(all(type(v) in (int, float) for v in payload["timing"].values()))
        self.assertNotIn(CLAIM["enrollNonce"], json.dumps(payload))
        self.clock.now = 5
        cli.step(self.cfg, "desktop", detach=True)
        self.assertEqual(pool.timing(self.cfg), payload["timing"])
        self.client.request.assert_called_once()

    def test_missing_relay_refuses_before_start(self):
        self.wait_relay.return_value = None
        with self.assertRaisesRegex(Refused, "pool_relay_missing"):
            cli.step(self.cfg, "desktop", detach=True)
        self.start.assert_not_called()
        self.ready.assert_not_called()
        self.assertFalse(pool.session_ready(self.cfg, self.adopted))

    def test_user_spec_binds_disk_home_workspace_and_relay(self):
        for field, contents in (("imageConfigFile", {"Env": [], "WorkingDir": "/"}),
                                ("seccompProfile", {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []})):
            self.cfg[field] = os.path.join(self.cfg.runDir, field + ".json")
            with open(self.cfg[field], "w") as f:
                json.dump(contents, f)
        self.patch(desktop, "host_limits", return_value=(200000, 4 * 1024**3))
        self.spec.side_effect = self.real_spec
        cli.step(self.cfg, "desktop", detach=True)
        with open(os.path.join(self.cfg.runDir, "bundle", "config.json")) as f:
            spec = json.load(f)
        self.assertEqual(spec["root"]["path"], desktop.merged(self.cfg))
        binds = {m["destination"]: m["source"] for m in spec["mounts"] if m["type"] == "bind"}
        self.assertEqual(binds["/workspace"], self.cfg.dataMount + "/workspace")
        self.assertEqual(binds["/var/lib/ezil-profiles"], self.cfg.dataMount + "/profiles")
        env = dict(e.split("=", 1) for e in spec["process"]["env"])
        self.assertEqual(env["HOME"], "/root")
        self.assertEqual(env["NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD"], self.relay["neko"]["admin"])

    def test_failed_start_never_reports_healthy(self):
        self.start.side_effect = None
        self.start.return_value = 1
        with self.assertRaisesRegex(Refused, "pool_desktop_start_failed"):
            cli.step(self.cfg, "desktop", detach=True)
        self.ready.assert_not_called()

    def test_running_desktop_without_applied_relay_refuses(self):
        self.running = True
        with self.assertRaisesRegex(Refused, "pool_relay_missing"):
            cli.step(self.cfg, "desktop", detach=True)
        self.start.assert_not_called()
        self.ready.assert_not_called()

    def test_crash_after_runc_start_resumes_without_a_second_restart(self):
        self.ready.side_effect = SystemExit(99)
        with self.assertRaises(SystemExit):
            cli.step(self.cfg, "desktop", detach=True)
        self.ready.side_effect = None
        self.ready.return_value = HEALTH
        cli.step(self.cfg, "desktop", detach=True)
        self.start.assert_called_once()
        self.stopped.assert_called_once()

    def test_supervisor_stays_alive_until_container_exits(self):
        self.ready.side_effect = None
        self.state.side_effect = ["absent", "running", "running", "stopped"]
        cli.step(self.cfg, "desktop")
        self.assertEqual(self.clock.sleeps, [1, 1])
        self.start.assert_called_once()

    def test_session_refuses_missing_or_mismatched_record(self):
        good = pool.read_record(self.cfg)
        for key, value in (("computerId", POOL["poolHostId"]), ("generation", 5), ("leaseEpoch", 10)):
            with self.assertRaisesRegex(Refused, "pool_session_mismatch"):
                pool.run_desktop(self.cfg, {**self.adopted, key: value}, detach=True)
        good["phase"] = "enrolled"
        pool.save_record(self.cfg, good)
        self.assertFalse(pool.session_ready(self.cfg, self.adopted))
        with self.assertRaisesRegex(Refused, "pool_session_mismatch"):
            pool.run_desktop(self.cfg, self.adopted, detach=True)
        desktop.write_ice_state(self.cfg, "applied")
        os.unlink(os.path.join(self.cfg.stateDir, pool.EPOCH_FILE))
        self.assertFalse(pool.session_ready(self.cfg, self.adopted))
        with self.assertRaisesRegex(Refused, "pool_session_missing"):
            pool.run_desktop(self.cfg, self.adopted, detach=True)
        self.start.assert_not_called()

    def test_session_status_waits_for_health_relay_and_guard(self):
        cli.step(self.cfg, "desktop", detach=True)
        a = agent.Agent(self.cfg, self.adopted, log=lambda _: None)
        self.patch(a, "_desktop_state", return_value="running")
        self.patch(a, "_desktop_unit", return_value="active")
        relay = self.patch(desktop, "read_desktop_config", return_value=self.relay)
        self.assertTrue(a._desktop_status(0)["sessionReady"])
        for field in ("health", "relay", "guard", "ice"):
            with self.subTest(field=field):
                self.health.return_value = {"ok": field != "health"}
                relay.return_value = None if field == "relay" else self.relay
                guard.require_stamp.side_effect = Refused("disk_gone") if field == "guard" else None
                desktop.write_ice_state(self.cfg, "missing" if field == "ice" else "applied")
                status = a._desktop_status(0)
                self.assertFalse(status["sessionReady"])
                self.assertEqual(status["desktop"], "starting")


class Protocol(PoolTest):
    def test_enrollment_without_nonce_is_refused(self):
        request = self.patch(enroll.http, "request", return_value=(200, ANSWER))
        with self.assertRaisesRegex(Refused, "enroll_nonce_absent"):
            enroll.enroll(self.cfg, {"computerId": CLAIM["computerId"], "generation": 4, "leaseEpoch": 9})
        request.assert_not_called()

    def test_strict_claim_json_and_nonce_are_required(self):
        raw = json.dumps(CLAIM)
        for body in (raw.replace('"generation": 4', '"generation": 4, "generation": 4'),
                     raw.replace('"generation": 4', '"generation": NaN'),
                     json.dumps({**CLAIM, "generation": 2147483648}),
                     json.dumps({k: v for k, v in CLAIM.items() if k != "enrollNonce"})):
            with self.assertRaises(Refused):
                pool.parse_claim(body)

    def test_request_timeout_never_exceeds_remaining_budget(self):
        self.cfg["enrollRetrySeconds"] = 2
        request = self.patch(pool.http, "request", side_effect=OSError())
        with self.assertRaisesRegex(Refused, "pool_retry_exhausted"):
            pool.Client(self.cfg, POOL).claim()
        self.assertEqual([c.kwargs["timeout"] for c in request.call_args_list], [2, 1])
        self.cfg["enrollRetrySeconds"] = 0
        request.reset_mock()
        with self.assertRaisesRegex(Refused, "pool_retry_exhausted"):
            pool.Client(self.cfg, POOL).claim()
        request.assert_not_called()

    def test_stub_app_complete_pool_wire_flow(self):
        from stub_servers import PoolApp
        app = PoolApp(POOL, IDENTITY, CLAIM, ANSWER)
        self.patch(pool.http, "request", side_effect=app.request)
        self.save_lease(POOL)
        self.patch(pool, "start_warm")
        self.patch(desktop, "state", return_value="absent")
        self.patch(pool, "wait_ready", return_value=HEALTH)
        self.patch(guard, "wait_device_for_volume", return_value="/dev/nvme0n1")
        self.patch(guard, "fs_uuid", return_value=FS_UUID)
        self.patch(guard, "run_guard")
        self.patch(pool, "stop_warm")
        cli.step(self.cfg, "guard")
        self.assertEqual(self.clock.sleeps, [1])
        self.assertEqual(app.calls, [("GET", "pool/claim"), ("POST", "pool/enroll"), ("POST", "pool/ready"),
                                     ("GET", "pool/claim"), ("GET", "pool/claim"), ("POST", "enroll")])
        self.assertTrue(app.enrolled)


if __name__ == "__main__":
    unittest.main()
