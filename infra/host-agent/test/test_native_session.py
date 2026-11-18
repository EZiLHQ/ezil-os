"""Offline native-session gates: no cgroup, netns, runc, cloud, model or provider call."""
import hashlib, json, os, shutil, socket, stat, subprocess, sys, tempfile, threading, time, unittest
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "lib"))
from ezil_host import native_authority as na, native_session as ns, native_isolation as ni, native_artifact as art
from ezil_host.config import Config
from ezil_host.fsops import Refused

OP, SES, CMP, OWN = ("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
                     "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
CORE_UUID = "55555555-5555-4555-8555-555555555555"
FENCE, INSTANCE = "66666666-6666-4666-8666-666666666666", "i-0123456789abcdef0"
TOKEN = "ezg_" + "A" * 43
KEY = b"k" * 32


def now_ms():
    return int(time.time() * 1000)


def delivery(**over):
    instruction = over.pop("instruction", "Fix the failing test.")
    t = now_ms()
    d = {"v": 1, "kind": "create", "profileId": ns.PROFILE_ID, "operationId": OP, "sessionId": SES, "computerId": CMP,
         "ownerUserId": OWN, "placement": {"generation": "7", "leaseEpoch": "3", "instanceId": INSTANCE, "fenceToken": FENCE},
         "leaseUntil": na.iso_ms(t + 3_600_000),
         "sourceAuthorization": {"authorizationId": "77777777-7777-4777-8777-777777777777", "epoch": "1",
                                 "authorizationDeadline": na.iso_ms(t + 3_600_000), "clientId": "ezil-mcp",
                                 "profileId": ns.PROFILE_ID, "policyId": "88888888-8888-4888-8888-888888888888",
                                 "budgetMicro": "250000000", "initialApprovalAt": na.iso_ms(t - 1000)},
         "task": {"taskRef": "task:abc", "instructionRevision": 1,
                  "instructionDigest": "sha256:" + hashlib.sha256(instruction.encode()).hexdigest(), "instruction": instruction},
         "grant": {"accessToken": TOKEN, "tokenSha256": hashlib.sha256(TOKEN.encode()).hexdigest(),
                   "grantId": "99999999-9999-4999-8999-999999999999", "expiresAt": na.iso_ms(t + 290_000)}}
    for k, v in over.items():
        d[k] = v
    return d


def raw(d):
    return json.dumps(d).encode()


class Authority(unittest.TestCase):
    binding = {"operationId": OP, "sessionId": SES, "computerId": CMP, "ownerUserId": OWN,
               "placement": {"generation": "7", "leaseEpoch": "3", "instanceId": INSTANCE, "fenceToken": FENCE}}

    def reply(self, req_raw, body, status=200, key=KEY):
        rb = json.dumps(body).encode()
        req = json.loads(req_raw)
        mac = na.reply_mac(key, CMP, "7", "3", req_raw, rb)
        return status, {"X-Ezil-Authority": mac}, rb

    def test_pre_runtime_omits_runtime_id_and_runtime_requires_core_uuid(self):
        pre = json.loads(na.build_request(self.binding, None, ns.POLICY_DIGEST, now_ms(), now_ms() + 60_000))
        self.assertEqual(pre["phase"], "pre-runtime")
        self.assertNotIn("runtimeId", pre)
        rt = json.loads(na.build_request(self.binding, CORE_UUID, ns.POLICY_DIGEST, now_ms(), now_ms() + 60_000))
        self.assertEqual((rt["phase"], rt["runtimeId"]), ("runtime", CORE_UUID))
        self.assertLessEqual(na.parse_ms(rt["expiresAt"]) - na.parse_ms(rt["issuedAt"]), na.WINDOW_MS)
        for bad in (dict(pre, runtimeId=None), dict(rt, runtimeId="0" * 64), {k: v for k, v in rt.items() if k != "runtimeId"}):
            self.assertFalse(na.valid_request(bad))
        with self.assertRaises(ValueError):
            na.build_request(dict(self.binding, placement=dict(self.binding["placement"], generation="2147483648")),
                             None, ns.POLICY_DIGEST, now_ms(), now_ms() + 1000)

    def test_reply_is_bound_to_phase_nonce_body_and_never_slides(self):
        t = now_ms()
        req = na.build_request(self.binding, CORE_UUID, ns.POLICY_DIGEST, t, t + 60_000)
        r = json.loads(req)
        ok = {"v": 1, "phase": "runtime", "requestNonce": r["requestNonce"], "operationId": OP, "runtimeId": CORE_UUID,
              "decision": "allow", "expiresAt": r["expiresAt"]}
        self.assertEqual(na.verify_reply(KEY, req, *self.reply(req, ok), t + 99_999)[0], "allow")
        cases = [dict(ok, requestNonce="x" * 43), dict(ok, phase="pre-runtime"), {k: v for k, v in ok.items() if k != "runtimeId"},
                 dict(ok, expiresAt=na.iso_ms(na.parse_ms(r["expiresAt"]) + 1)), dict(ok, extra=1)]
        for body in cases:
            self.assertEqual(na.verify_reply(KEY, req, *self.reply(req, body), t + 99_999)[0], "unknown", body)
        self.assertEqual(na.verify_reply(KEY, req, *self.reply(req, ok, key=b"x" * 32), t + 99_999), ("unknown", "reply_mac"))
        deny = {"v": 1, "phase": "runtime", "requestNonce": r["requestNonce"], "operationId": OP, "runtimeId": CORE_UUID,
                "decision": "deny", "reason": "placement_changed"}
        self.assertEqual(na.verify_reply(KEY, req, *self.reply(req, deny, 403), t), ("deny", "placement_changed"))
        pre = na.build_request(self.binding, None, ns.POLICY_DIGEST, t, t + 60_000)
        p = json.loads(pre)
        pre_ok = {"v": 1, "phase": "pre-runtime", "requestNonce": p["requestNonce"], "operationId": OP,
                  "decision": "allow", "expiresAt": p["expiresAt"]}
        self.assertEqual(na.verify_reply(KEY, pre, *self.reply(pre, pre_ok), t + 99_999)[0], "allow")
        self.assertEqual(na.verify_reply(KEY, pre, *self.reply(pre, dict(pre_ok, runtimeId=CORE_UUID)), t)[0], "unknown")
        # The local cap (grant/lease) shortens an answer; it can never extend one.
        self.assertEqual(na.verify_reply(KEY, req, *self.reply(req, ok), t + 5)[1], t + 5)


class Parity(unittest.TestCase):
    def test_policy_digest_matches_the_os_reader_constant(self):
        # app/src/server/native-session/native-authority-reader.ts NATIVE_POLICY_DIGEST
        self.assertEqual(ns.POLICY_DIGEST, "sha256:669f2e04be8d8183727f1e750f4b9fe1bad3bd1b991babbbd549debc5a305e3e")

    def test_explicit_bare_preview_revision_keeps_only_actual_catalog(self):
        self.assertEqual(ns.POLICY_REVISION, "bare-cli2.1.310-r2")
        self.assertEqual(ns.PROFILE["policyRevision"], ns.POLICY_REVISION)
        self.assertEqual(ns.PROFILE["tools"], ["Bash", "Edit", "Read"])
        self.assertEqual(ns.PROFILE["permissionMode"], "acceptEdits")
        self.assertEqual(ns.PROFILE["profileId"], "ezil-native-claude-v1")
        self.assertNotEqual(ns.POLICY_DIGEST, "sha256:8e60e6fcdb6c28968d85d56c13b6ebafae3bf3ef7e852d12478216fbb5485062")



class Delivery(unittest.TestCase):
    def test_strict_shape_digest_token_and_source_formats(self):
        self.assertIsNotNone(ns.parse_delivery(raw(delivery())))
        d = delivery()
        d["task"]["instructionDigest"] = "sha256:" + "0" * 64
        self.assertIsNone(ns.parse_delivery(raw(d)))
        d = delivery()
        d["task"]["instructionDigest"] = d["task"]["instructionDigest"][7:]       # RAW64 task digest is refused
        self.assertIsNone(ns.parse_delivery(raw(d)))
        d = delivery()
        d["grant"]["tokenSha256"] = "sha256:" + d["grant"]["tokenSha256"]        # token digest is RAW64 only
        self.assertIsNone(ns.parse_delivery(raw(d)))
        for k, v in (("epoch", "01"), ("epoch", "0"), ("budgetMicro", "-5"), ("clientId", ""), ("profileId", "other"),
                     ("authorizationDeadline", "2026-11-16T00:00:00Z")):
            d = delivery()
            d["sourceAuthorization"][k] = v
            self.assertIsNone(ns.parse_delivery(raw(d)), k)
        d = delivery()
        d["extra"] = 1
        self.assertIsNone(ns.parse_delivery(raw(d)))
        self.assertIsNone(ns.parse_delivery(raw(d)[:-1] + b',"v":1}'))           # duplicate key

    def test_max_escaped_16k_instruction_fits_128k_and_oversize_is_refused(self):
        worst = '"\\' * 8192                                                     # 16 KiB of quotes/backslashes
        body = raw(delivery(instruction=worst))
        self.assertGreater(len(body), 32768)
        self.assertLessEqual(len(body), ns.MAX_BODY)
        self.assertIsNotNone(ns.parse_delivery(body))
        ctl = "\x01" * 16384                                                     # \u0001 escapes: 6x
        self.assertLessEqual(len(raw(delivery(instruction=ctl))), ns.MAX_BODY)
        self.assertIsNone(ns.parse_delivery(raw(delivery(instruction="x" * 16385))))
        self.assertIsNone(ns.parse_delivery(b" " * (ns.MAX_BODY + 1)))


class FakeAuthority:
    def __init__(self, verdicts=None):
        self.calls, self.verdicts = [], list(verdicts or [])

    def check(self, binding, runtime_id, policy, exp, cap):
        self.calls.append(runtime_id)
        v = self.verdicts.pop(0) if self.verdicts else ("allow", now_ms() + 30_000)
        return v


class FakeDriver:
    def __init__(self):
        import queue
        self.inbox, self.sent = queue.Queue(), []

    def next_frame(self, timeout):
        import queue
        try:
            return self.inbox.get(timeout=timeout)
        except queue.Empty:
            return None

    def send(self, frame):
        self.sent.append(frame)

    def close(self):
        pass


class FakeLauncher:
    def __init__(self, receipt_ok=True):
        self.started, self.stopped, self.receipt_ok, self.driver = [], [], receipt_ok, FakeDriver()

    def start_driver(self, rec, artifact, token, instruction, profile):
        self.started.append((rec["operationId"], token == TOKEN, bool(instruction)))
        return self.driver

    def prepare(self, rec):
        return {"v": 1, "runtimeId": rec["runtimeId"]}

    def kill_cli(self, rec):
        return True

    def reap_cli(self, rec):
        return True

    def stop(self, rec, driver):
        self.stopped.append(rec["operationId"])
        return {"relayRevoked": True, "cgroupEmpty": True, "credentialRemoved": self.receipt_ok}


class Manager(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.cfg = Config(stateDir=self.dir, runDir=self.dir, nativeSessions="enabled")
        self.lease = {"computerId": CMP, "generation": 7, "leaseEpoch": 3}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def manager(self, authority=None, launcher=None, threads=False, witness=True):
        self.auth, self.launch = authority or FakeAuthority(), launcher or FakeLauncher()
        return ns.Manager(self.cfg, self.lease, artifact_loader=lambda: {"manifestSha256": "a" * 64},
                          witness_reader=lambda a: {"ok": True} if witness else None, launcher=self.launch,
                          authority=self.auth, instance_id=lambda: INSTANCE, start_threads=threads, log=lambda m: None)

    def ledger_text(self):
        return "".join(open(os.path.join(self.dir, "native", "ops", n)).read() for n in os.listdir(os.path.join(self.dir, "native", "ops")))

    def test_gate_placement_overflow_renew_and_semantic_idempotency(self):
        self.assertEqual(self.manager(witness=False).admit(raw(delivery())), {"ok": False, "error": "native_unavailable"})
        m = self.manager()
        self.assertEqual(m.admit(raw(delivery(kind="renew", task=None)))["error"], "renew_unsupported")
        for p in ({"generation": "8"}, {"leaseEpoch": "2147483648"}, {"instanceId": "i-0000000000000000f"}):
            d = delivery()
            d["placement"] = dict(d["placement"], **p)
            self.assertIn(m.admit(raw(d))["error"], ("placement_mismatch", "native_invalid"))
        base = delivery()
        self.assertEqual(m.admit(raw(base)), {"ok": True, "state": "starting"})
        # Same operation, identical immutable sourceAuthorization/task/placement, ROTATED grant: replay, no 2nd runtime.
        rotated = json.loads(raw(base))
        token2 = "ezg_" + "B" * 43
        rotated["grant"] = {"accessToken": token2, "tokenSha256": hashlib.sha256(token2.encode()).hexdigest(),
                            "grantId": OWN, "expiresAt": na.iso_ms(now_ms() + 200_000)}
        self.assertEqual(rotated["sourceAuthorization"], base["sourceAuthorization"])
        self.assertEqual(m.admit(raw(rotated)), {"ok": True, "state": "starting"})
        changed_source = json.loads(raw(base))
        changed_source["sourceAuthorization"]["epoch"] = "2"
        self.assertEqual(m.admit(raw(changed_source))["error"], "operation_conflict")
        self.assertEqual(len(m.runtimes), 1)
        other = delivery(instruction="Something else")
        self.assertEqual(m.admit(raw(other))["error"], "operation_conflict")
        text = self.ledger_text()
        for secret in (TOKEN, "Fix the failing test", "ezg_"):
            self.assertNotIn(secret, text)
        self.assertIn('"instructionDigest":"sha256:', text)

    def run_flow(self, frames, authority=None, launcher=None):
        m = self.manager(authority, launcher)
        self.assertTrue(m.admit(raw(delivery()))["ok"])
        rt = m.runtimes[OP]
        for f in frames:
            self.launch.driver.inbox.put(f)
        t = threading.Thread(target=m._run, args=(rt, {"manifestSha256": "a" * 64}))
        t.start()
        return m, rt, t

    def test_pre_runtime_deny_never_starts_driver(self):
        m, rt, t = self.run_flow([], FakeAuthority([("deny", "consent_revoked")]))
        t.join(5)
        self.assertEqual(m.status(OP), {"ok": True, "state": "refused", "reason": "authority_denied_consent_revoked"})
        self.assertEqual((self.launch.started, self.auth.calls), ([], [None]))

    def test_core_uuid_adoption_ack_then_fence_on_runtime_deny(self):
        frames = [{"id": 1, "rpc": "authority.check"}, {"id": 2, "rpc": "isolation.prepare", "runtimeId": CORE_UUID},
                  {"id": 3, "rpc": "isolation.verify", "runtimeId": CORE_UUID, "receipt": {"v": 1, "runtimeId": CORE_UUID}},
                  {"id": 4, "rpc": "permits.acquire", "runtimeId": CORE_UUID},
                  {"event": "accepted", "runtimeId": CORE_UUID, "sessionId": SES, "userUuid": FENCE,
                   "acceptedAt": "2026-11-16T22:00:00.000Z"}]
        auth = FakeAuthority([("allow", 0), ("allow", 0), ("allow", now_ms() + 30_000)])
        m, rt, t = self.run_flow(frames, auth)
        self.assertEqual(m.wait_running(OP, 5)["state"], "running")
        rec = m.records[OP]
        self.assertEqual((rec["runtimeId"], rec["ack"]["userUuid"]), (CORE_UUID, FENCE))
        self.assertEqual(auth.calls[:3], [None, None, CORE_UUID])                 # pre-runtime until adoption
        replies = {f["id"]: f["result"] for f in self.launch.driver.sent}
        self.assertEqual((replies[1], replies[2]["ok"], replies[3], replies[4]["ok"]), ({"ok": True}, True, {"ok": True}, True))
        self.assertEqual(self.launch.started, [(OP, True, True)])
        auth.verdicts.append(("deny", "placement_changed"))
        m.fence_all("host_stop")
        t.join(5)
        self.assertEqual(m.status(OP)["state"], "stopped")

    def test_wrong_uuid_echo_or_session_is_a_violation_and_incomplete_cleanup_quarantines(self):
        frames = [{"id": 1, "rpc": "isolation.prepare", "runtimeId": CORE_UUID},
                  {"id": 2, "rpc": "isolation.prepare", "runtimeId": OWN},
                  {"event": "accepted", "runtimeId": CORE_UUID, "sessionId": OWN, "userUuid": FENCE, "acceptedAt": "x"}]
        m, rt, t = self.run_flow(frames, launcher=FakeLauncher(receipt_ok=False))
        t.join(5)
        self.assertEqual(self.launch.driver.sent[1]["result"], {"ok": False, "code": "runtime_mismatch"})
        self.assertEqual(m.status(OP), {"ok": True, "state": "quarantined", "reason": "protocol_violation"})
        self.assertEqual(m.admit(raw(delivery(operationId=OWN, sessionId=FENCE)))["error"], "permits_exhausted")

    def test_restart_quarantines_live_record_and_holds_permit(self):
        m = self.manager()
        m.admit(raw(delivery()))
        m2 = self.manager()
        self.assertEqual(m2.status(OP)["state"], "quarantined")
        self.assertEqual(m2.admit(raw(delivery(operationId=OWN, sessionId=FENCE)))["error"], "permits_exhausted")


class Credential(unittest.TestCase):
    def test_raw_token_private_file_nofollow_and_bad_root_refused(self):
        d = tempfile.mkdtemp(prefix="ezil-native-credential-test-", dir="/run")
        try:
            os.chmod(d, 0o711)
            cfg = Config(nativeGrantRoot=os.path.join(d, "native", "grant"))
            key = "ab" * 32
            path = ni.write_credential(cfg, key, TOKEN, os.getuid(), os.getgid())
            st = os.lstat(path)
            self.assertEqual((stat.S_IMODE(st.st_mode), open(path).read()), (0o600, TOKEN))
            self.assertEqual(stat.S_IMODE(os.lstat(os.path.dirname(path)).st_mode), 0o700)
            self.assertTrue(ni.remove_credential(cfg, key))
            with self.assertRaises(Refused):
                ni.write_credential(cfg, key, "not-a-token", 0, 0)
            os.chmod(cfg.nativeGrantRoot, 0o777)
            with self.assertRaises(Refused):
                ni.write_credential(cfg, key, TOKEN, os.getuid(), os.getgid())
            os.chmod(cfg.nativeGrantRoot, 0o711)
            os.symlink("/tmp", os.path.join(cfg.nativeGrantRoot, key[:16]))
            with self.assertRaises(OSError):                                   # never followed
                ni.write_credential(cfg, key, TOKEN, os.getuid(), os.getgid())
        finally:
            shutil.rmtree(d)

    def test_spec_idmap_direction_devices_and_no_caps(self):
        spec = ni.build_cli_spec(rootfs="/r", artifact_dir="/a", workspace="/w", state_leaves=["/s/home"], uid_base=300000,
                                 service_uid=299000, cgroups_path="/x/cli", netns_path="/var/run/netns/n", seccomp=None,
                                 args=["/a/claude"], env={"HOME": "/s/home"}, cwd="/w")
        mounts = {m["destination"]: m for m in spec["mounts"]}
        self.assertEqual(mounts["/w"]["uidMappings"], [{"containerID": 0, "hostID": 301000, "size": 1}])
        self.assertEqual(mounts["/s/home"]["uidMappings"], [{"containerID": 299000, "hostID": 301000, "size": 1}])
        self.assertEqual(spec["process"]["capabilities"]["bounding"], [])
        self.assertEqual(sorted(d["minor"] for d in spec["linux"]["devices"]), [3, 5, 8, 9])
        self.assertEqual(spec["linux"]["resources"]["devices"][0], {"allow": False, "access": "rwm"})
        rules = ni.nft_ruleset(ni.network_plan("ab" * 32, 1), "10.0.0.2")
        self.assertIn("policy drop", rules)
        self.assertIn("169.254.0.0/16", rules)


class Artifact(unittest.TestCase):
    def build(self, d):
        src = os.path.join(d, "src")
        os.makedirs(os.path.join(src, "core"))
        os.makedirs(os.path.join(src, "bin"))
        files = []
        for rel, data, mode in (("bin/claude", b"#!/bin/sh\n", "0755"), ("core/gatewayNativeSupervisor.mjs", b"s", "0644"),
                                ("core/gatewayNativeJournal.mjs", b"j", "0644")):
            open(os.path.join(src, rel), "wb").write(data)
            files.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mode": mode})
        descriptor = json.dumps({"v": 1, "kind": "ezil-native-rootfs-template", "entries": [{"path": "etc", "type": "dir", "mode": 0o755}]}, sort_keys=True, separators=(",", ":")).encode()
        Path(src, "rootfs-template.json").write_bytes(descriptor)
        files.append({"path": "rootfs-template.json", "sha256": hashlib.sha256(descriptor).hexdigest(), "size": len(descriptor), "mode": "0644"})
        m = art.manifest_bytes(files, {"core": "core/gatewayNativeSupervisor.mjs", "cli": "bin/claude"}, "137")
        open(os.path.join(src, "manifest.json"), "wb").write(m)
        return src, {"manifestSha256": hashlib.sha256(m).hexdigest(), "cliVersion": "2.1.310", "nodeAbi": "137"}

    def test_install_load_tamper_symlink_and_pin(self):
        d = tempfile.mkdtemp()
        try:
            os.chmod(d, 0o755)
            src, pin = self.build(d)
            root = os.path.join(d, "inst")
            os.mkdir(root, 0o755)
            desc = art.install(src, root, pin)
            self.assertEqual((desc["cli"], desc["core"]), ("bin/claude", "core/gatewayNativeSupervisor.mjs"))
            with self.assertRaises(Refused) as e:
                art.load(root, dict(pin, nodeAbi="138"))
            self.assertEqual(e.exception.code, "pin_mismatch")
            with self.assertRaises(Refused) as e:
                art.load(root, dict(pin, manifestSha256="b" * 64))
            self.assertEqual(e.exception.code, "artifact_missing")
            os.chmod(os.path.join(root, pin["manifestSha256"], "bin", "claude"), 0o755)
            open(os.path.join(root, pin["manifestSha256"], "bin", "claude"), "ab").write(b"x")
            with self.assertRaises(Refused) as e:
                art.load(root, pin)
            self.assertEqual(e.exception.code, "artifact_invalid")
            d2 = os.path.join(d, "b")
            os.mkdir(d2)
            src2, pin2 = self.build(d2)
            os.unlink(os.path.join(src2, "core", "gatewayNativeJournal.mjs"))
            os.symlink("/etc/hostname", os.path.join(src2, "core", "gatewayNativeJournal.mjs"))
            with self.assertRaises(Refused):
                art.install(src2, root, pin2)
        finally:
            shutil.rmtree(d)


class Edge(unittest.TestCase):
    """The real Edge.handle over a socketpair with a gw1-signed request and a scripted agent."""

    class Seq:
        def __init__(self, answers, delay=0.0):
            self.answers, self.sent, self.delay, self.timeouts = list(answers), [], delay, []

        presence_calls = 0

        def presence(self):
            self.presence_calls += 1
            return None

        def send(self, op, timeout=10, **fields):
            self.sent.append((op, fields))
            self.timeouts.append(timeout)
            time.sleep(min(self.delay, timeout))
            return self.answers.pop(0) if self.answers else {"ok": True, "state": "starting"}

    def call(self, method, path, body=b"", answers=(), hold=0.6, delay=0.0):
        import hmac as _h
        from ezil_host import edge
        lease = {"computerId": CMP, "generation": 7, "leaseEpoch": 3}
        seq = self.seq = self.Seq(answers, delay)
        e = edge.Edge(Config(edgeUpstreamHost="127.0.0.1"), lease, KEY, sequencer=seq)
        ts = int(time.time())
        sig = _h.new(KEY, edge.gateway_payload(lease, ts, method, path).encode(), hashlib.sha256).hexdigest()
        # Exercise only an unbound AF_UNIX pair, including under the offline socket guard.
        from _socket import socketpair
        a, b = socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
        req = (f"{method} {path} HTTP/1.1\r\nHost: x\r\nx-ezil-gw: gw1.{ts}.{sig}\r\n"
               + (f"Content-Length: {len(body)}\r\n" if body else "") + "\r\n").encode() + body
        a.sendall(req)
        old = edge.NATIVE_HOLD
        edge.NATIVE_HOLD = hold
        try:
            e.handle(b)
        finally:
            edge.NATIVE_HOLD = old
        b.close()
        resp = b""
        while True:
            chunk = a.recv(65536)
            if not chunk:
                break
            resp += chunk
        a.close()
        status = int(resp.split(b" ", 2)[1])
        return status, json.loads(resp.split(b"\r\n\r\n", 1)[1]), seq.sent

    def test_runtime_timeout_remains_unknown_after_agent_may_have_executed(self):
        body = b'{"v":"ezil-native-runtime-rpc/1"}'
        path = "/__ezil/control/native-runtime/" + hashlib.sha256(body).hexdigest()
        status, reply, sent = self.call("POST", path, body, [{"kind": "unknown", "reason": "host_timeout"}])
        self.assertEqual((status, reply), (200, {"v": "ezil-native-runtime-rpc/1", "outcome": "unknown", "reason": "host_timeout"}))
        self.assertEqual([op for op, _ in sent], ["native-runtime"])
        self.assertEqual(self.seq.presence_calls, 0)

    def test_post_digest_strict_hold_and_closed_answers(self):
        body = raw(delivery())
        path = "/__ezil/control/native-session/" + hashlib.sha256(body).hexdigest()
        st, ans, sent = self.call("POST", path, body, [{"ok": True, "state": "starting"}, {"ok": True, "state": "running"}])
        self.assertEqual((st, ans), (200, {"ok": True, "state": "running"}))
        self.assertEqual([op for op, _ in sent], ["native-session", "native-session-status"])
        st, ans, _ = self.call("POST", path, body, [{"ok": True, "state": "starting"}])
        self.assertEqual((st, ans), (202, {"ok": True, "state": "starting"}))      # held past the bound: unknown upstream
        st, ans, _ = self.call("POST", path, body, [{"ok": False, "error": "renew_unsupported"}])
        self.assertEqual((st, ans), (409, {"ok": False, "error": "renew_unsupported"}))
        st, ans, _ = self.call("POST", path, body, [{"ok": False, "error": "internal", "detail": "x"}])
        self.assertEqual((st, ans), (503, {"ok": False, "error": "agent_unavailable"}))
        st, ans, sent = self.call("POST", "/__ezil/control/native-session/" + "0" * 64, body)
        self.assertEqual((st, sent), (400, []))                                      # digest mismatch: nothing sent
        bad = raw(delivery(extra=1))
        st, _, sent = self.call("POST", "/__ezil/control/native-session/" + hashlib.sha256(bad).hexdigest(), bad)
        self.assertEqual((st, sent), (400, []))

    def test_hold_is_one_absolute_deadline_over_all_control_io(self):
        body = raw(delivery())
        path = "/__ezil/control/native-session/" + hashlib.sha256(body).hexdigest()
        t0 = time.monotonic()
        st, ans, sent = self.call("POST", path, body, hold=1.0, delay=0.3)
        elapsed = time.monotonic() - t0
        self.assertEqual((st, ans), (202, {"ok": True, "state": "starting"}))
        self.assertLess(elapsed, 1.0 + 0.5)
        self.assertLessEqual(self.seq.timeouts[0], 1.0)
        self.assertTrue(all(t <= 1.0 for t in self.seq.timeouts))
        self.assertEqual([op for op, _ in sent].count("native-session"), 1)          # never re-sent

    def test_native_paths_are_not_human_presence_but_browser_requests_still_are(self):
        body = raw(delivery())
        self.call("POST", "/__ezil/control/native-session/" + hashlib.sha256(body).hexdigest(), body,
                  [{"ok": True, "state": "running"}])
        self.assertEqual(self.seq.presence_calls, 0)
        self.call("GET", "/__ezil/control/native-session-status/" + OP, answers=[{"ok": True, "state": "starting"}])
        self.assertEqual(self.seq.presence_calls, 0)
        self.call("GET", "/__ezil/control/desktop", answers=[{"ok": True}])
        self.assertEqual(self.seq.presence_calls, 0)  # desktop status is also an operational read
        self.call("GET", "/__ezil/proxy/9999/", answers=[])
        self.assertEqual(self.seq.presence_calls, 1)

    def test_agent_native_status_leaves_last_presence_unchanged(self):
        from ezil_host import agent as ag
        a = ag.Agent.__new__(ag.Agent)
        a.key, a.lease, a.cfg = KEY, {"leaseEpoch": 3}, Config(stateDir=tempfile.mkdtemp())
        a.clock, a.lock, a.last_seq, a.native, a.last_presence = time.time, threading.Lock(), 0, None, 123.0
        try:
            msg = {"op": "native-session-status", "operationId": OP, "leaseEpoch": 3, "ts": time.time(), "seq": 5}
            msg["mac"] = ag.sign(KEY, msg)
            self.assertEqual(a.handle(json.dumps(msg).encode()), {"ok": False, "error": "operation_unknown"})
            self.assertEqual(a.last_presence, 123.0)
        finally:
            shutil.rmtree(a.cfg.stateDir)

    def test_status_get_is_a_pure_read(self):
        st, ans, sent = self.call("GET", "/__ezil/control/native-session-status/" + OP, answers=[{"ok": True, "state": "running"}])
        self.assertEqual((st, ans, [op for op, _ in sent]), (200, {"ok": True, "state": "running"}, ["native-session-status"]))
        st, ans, _ = self.call("GET", "/__ezil/control/native-session-status/" + OP, answers=[{"ok": False, "error": "operation_unknown"}])
        self.assertEqual(st, 404)


class AgentHooks(unittest.TestCase):
    def agent(self, native):
        from ezil_host import agent as ag
        a = ag.Agent.__new__(ag.Agent)
        a.key, a.lease, a.clock, a.log = KEY, {"leaseEpoch": 3}, time.time, lambda m: None
        a.native, a.last_seq, a.lock = native, 0, threading.Lock()
        return a, ag

    def test_line_caps_non_native_64k_native_128k(self):
        a, ag = self.agent(None)
        big = json.dumps({"op": "presence", "pad": "x" * 70000}).encode()
        self.assertEqual(a.handle(big), {"ok": False, "error": "too_large"})
        nat = json.dumps({"op": "native-session", "pad": "x" * 100000}).encode()
        self.assertNotEqual(a.handle(nat).get("error"), "too_large")               # reaches the MAC check
        self.assertEqual(a.handle(json.dumps({"op": "native-session", "pad": "x" * ag.NATIVE_LINE}).encode()),
                         {"ok": False, "error": "too_large"})

    def test_export_is_blocked_when_a_native_runtime_is_not_fenced(self):
        class N:
            def fence_all(self, why):
                return False
        a, ag = self.agent(N())
        d = tempfile.mkdtemp()
        try:
            a.cfg = Config(runDir=d)
            self.assertFalse(a._export_stop_desktop())
            self.assertFalse(os.path.exists(os.path.join(d, ag.desktop.EXPORT_QUIESCE)))   # nothing quiesced/captured
            with self.assertRaises(RuntimeError):
                a._native_fence("stop")
        finally:
            shutil.rmtree(d)


@unittest.skipUnless(shutil.which("node"), "BLOCKED: node binary absent")
class DriverChannel(unittest.TestCase):
    def test_real_node_receives_bootstrap_on_fd3_and_no_inherited_marker_fd(self):
        d = tempfile.mkdtemp()
        marker_path = os.path.join(d, "marker")
        open(marker_path, "w").write("marker")
        marker = os.open(marker_path, os.O_RDONLY)
        os.set_inheritable(marker, True)                                        # would leak without the child's sweep
        mst = os.fstat(marker)
        # Node opens its own internal fds; the proof is that no fd in the child is the marker's inode.
        script = ("import net from 'node:net'; import fs from 'node:fs';"
                  f"const want={mst.st_ino},dev={mst.st_dev};let leaked=false;"
                  "for(const n of fs.readdirSync('/proc/self/fd')){try{const s=fs.fstatSync(Number(n));"
                  "if(s.ino===want&&s.dev===dev)leaked=true}catch{}}"
                  "const s=new net.Socket({fd:3,readable:true,writable:true});let b='';"
                  "s.on('data',c=>{b+=c;if(b.includes('\\n')){const f=JSON.parse(b);"
                  "s.end(JSON.stringify({event:'echo',type:f.type,leaked})+'\\n')}});")
        try:
            p = os.path.join(d, "echo.mjs")
            open(p, "w").write(script)
            # Use an unbound AF_UNIX pair under the offline socket guard.
            from _socket import socketpair
            parent, child = socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                proc = ni.spawn_driver([shutil.which("node"), p], child, {"PATH": "/usr/bin:/bin"})
            finally:
                child.close()
            ch = ni.DriverChannel(parent)
            ch.send({"type": "bootstrap"})
            frame = ch.next_frame(15)
            self.assertEqual(frame, {"event": "echo", "type": "bootstrap", "leaked": False})
            with self.assertRaises(Refused):
                ch.send({"pad": "x" * ni.FRAME_LIMIT})                       # oversize never sent or truncated
            ch.close()                                                       # node exits once its peer closes
            proc.wait(10)
        finally:
            os.close(marker)
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main()


class BootEpoch(unittest.TestCase):
    def test_boot_and_every_placement_field_are_bound(self):
        d = delivery(); p = d["placement"]
        first = ni.derive_host_epoch(OP, CMP, p)
        self.assertRegex(first, r"^[0-9a-f]{32}$")
        self.assertEqual(first, ni.derive_host_epoch(OP, CMP, dict(p)))
        self.assertNotEqual(first, ni.derive_host_epoch(SES, CMP, p))
        for k, v in {"generation": "8", "leaseEpoch": "4", "instanceId": "i-00000000000000000", "fenceToken": OWN}.items():
            self.assertNotEqual(first, ni.derive_host_epoch(OP, CMP, dict(p, **{k: v})))
        for bad in (None, "", "legacy"):
            with self.assertRaises(ValueError): ni.derive_host_epoch(bad, CMP, p)

    def test_real_kernel_boot_reader_refuses_missing_or_invalid_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "boot"; self.assertIsNone(ni.boot_id(str(p)))
            p.write_text("not-a-boot"); self.assertIsNone(ni.boot_id(str(p)))
            p.write_text(OP + "\n"); self.assertEqual(ni.boot_id(str(p)), OP)


class DriverJournalDirectory(unittest.TestCase):
    def test_driver_creates_private_journal_directory_before_sqlite_open(self):
        driver = Path(ni.__file__).with_name("native_driver.mjs")
        with tempfile.TemporaryDirectory() as root:
            script = r"""
import{PassThrough}from'node:stream';import{pathToFileURL}from'node:url';import{mkdir,stat}from'node:fs/promises';import{DatabaseSync}from'node:sqlite';import path from'node:path';
const driver=process.argv[1],stateRoot=process.argv[2];process.argv[1]='/fixture/not-entry.mjs';const{run}=await import(pathToFileURL(driver).href);
const stream=new PassThrough(),id='11111111-1111-4111-8111-111111111111';let made=false,db;
const pending=run({stream,importCore:async()=>[{createInstalledCliWire:()=>({id:'fixture'}),createRuntimeCoreAbi:()=>({}),createSupervisor:()=>({start:async()=>{},submit:async()=>({operationId:id}),close:async()=>{}})},
{openJournal(dir){if(!made)throw Error('journal_opened_before_private_directory');db=new DatabaseSync(path.join(dir,'gateway-native.sqlite'));return{runtime:()=>({policyDigest:'a'.repeat(64)}),operation:()=>({acceptedAt:new Date().toISOString(),userUuid:id})};}},
{async privateDirectory(dir,options){if(dir!==path.join(stateRoot,'journal')||options.create!==true)throw Error('wrong_private_directory');await mkdir(dir,{mode:0o700});made=true;return dir;}}]});
stream.write(JSON.stringify({type:'bootstrap',coreDir:'/fixture',stateRoot,hostEpoch:'a'.repeat(32),principal:id,sessionRef:id,binding:{sessionId:id},cli:{version:'2.1.310'},requestId:id,instruction:'fixture only'})+'\n');
const result=await pending;if(!result||!made)process.exit(2);const info=await stat(path.join(stateRoot,'journal'));if((info.mode&0o777)!==0o700||info.uid!==process.getuid())process.exit(3);result.close();db.close();stream.destroy();
"""
            result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", script, str(driver), root], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)


class EmptySysMount(unittest.TestCase):
    def test_runtime_sys_is_empty_readonly_bounded_and_other_isolation_fences_remain(self):
        spec = ni.build_cli_spec(rootfs="/fixture/rootfs", artifact_dir="/fixture/artifact", workspace="/fixture/workspace",
            state_leaves=["/fixture/home"], uid_base=300000, service_uid=299000, cgroups_path="/fixture/cli",
            netns_path="/fixture/netns", seccomp=None, args=["/usr/bin/node"], env={}, cwd="/fixture/workspace")
        mounts = [m for m in spec["mounts"] if m["destination"] == "/sys"]
        self.assertEqual(mounts, [{"destination": "/sys", "type": "tmpfs", "source": "tmpfs",
            "options": ["nosuid", "noexec", "nodev", "ro", "mode=0555", "size=65536"]}])
        self.assertEqual(spec["process"]["user"], {"uid": 1000, "gid": 1000})
        self.assertTrue(spec["process"]["noNewPrivileges"])
        self.assertTrue(spec["root"]["readonly"])
        self.assertEqual(spec["process"]["capabilities"], {k: [] for k in ("bounding", "effective", "permitted", "ambient")})
        self.assertEqual(spec["linux"]["resources"]["devices"][0], {"allow": False, "access": "rwm"})
        self.assertIn({"type": "network", "path": "/fixture/netns"}, spec["linux"]["namespaces"])


class PrivateRootfsAssembly(unittest.TestCase):
    def setUp(self):
        self.base = Path("/run") / ("ezil-rootfs-test-" + __import__("uuid").uuid4().hex)
        self.base.mkdir(mode=0o700);self.template=self.base/"template";self.template.mkdir(mode=0o755)
        (self.template/"etc").mkdir();(self.template/"etc/value").write_bytes(b"seed")
        self.bundle=self.base/"bundle";self.bundle.mkdir(mode=0o700)
        self.points=["/artifact/sha", "/workspace", "/state/home", "/state/config", "/state/tmp"]
    def tearDown(self): shutil.rmtree(self.base)
    def descriptor(self):
        raw=art.rootfs_descriptor_bytes(str(self.template))
        return {"rootfsTemplate":art.parse_rootfs_descriptor(raw),"rootfsTemplateSha256":hashlib.sha256(raw).hexdigest()}
    def test_private_copy_and_all_dynamic_mountpoints_have_no_template_alias(self):
        receipt=art.prepare_rootfs(str(self.template),self.descriptor(),str(self.bundle),self.points)
        private=Path(receipt["path"]);self.assertEqual((private/"etc/value").read_bytes(),b"seed")
        self.assertNotEqual((private/"etc/value").stat().st_ino,(self.template/"etc/value").stat().st_ino)
        (private/"etc/value").write_bytes(b"changed");self.assertEqual((self.template/"etc/value").read_bytes(),b"seed")
        for target in self.points:self.assertTrue((private/target[1:]).is_dir())
        self.assertFalse((self.template/"artifact").exists())
    def test_changed_template_fails_closed_before_copy(self):
        descriptor=self.descriptor();(self.template/"etc/value").write_bytes(b"tampered")
        with self.assertRaises(Refused):art.prepare_rootfs(str(self.template),descriptor,str(self.bundle),self.points)
        self.assertFalse((self.bundle/"rootfs").exists())
    def test_symlink_escape_and_hardlink_source_refused(self):
        os.symlink("../../outside",self.template/"escape")
        with self.assertRaises(Refused):self.descriptor()
        (self.template/"escape").unlink();os.link(self.template/"etc/value",self.template/"alias")
        with self.assertRaises(Refused):self.descriptor()
    def test_template_path_symlink_and_writable_ancestry_refused(self):
        os.symlink(self.template,self.base/"link")
        with self.assertRaises((OSError,Refused)):art.rootfs_descriptor_bytes(str(self.base/"link"))
        os.chmod(self.base,0o777)
        with self.assertRaises(Refused):self.descriptor()
        os.chmod(self.base,0o700)
    def test_mountpoint_symlink_refused_without_following(self):
        os.symlink("etc",self.template/"state");descriptor=self.descriptor()
        with self.assertRaises((OSError,Refused)):art.prepare_rootfs(str(self.template),descriptor,str(self.bundle),self.points)
        self.assertFalse((self.template/"etc/home").exists())
    def test_inventory_byte_bound_and_missing_artifact_pin_refused(self):
        from unittest.mock import patch
        with patch.object(art,"ROOTFS_MAX_BYTES",3):
            with self.assertRaises(Refused):self.descriptor()
        with self.assertRaises(Refused):art.prepare_rootfs(str(self.template),{},str(self.bundle),self.points)
    def test_noncanonical_mountpoint_and_existing_private_root_refused(self):
        descriptor=self.descriptor()
        with self.assertRaises((OSError,Refused)):art.prepare_rootfs(str(self.template),descriptor,str(self.bundle),["/../escape",*self.points[1:]])
        self.assertFalse((self.base/"escape").exists())


class RootfsSearchableWorkRoot(unittest.TestCase):
    def test_hidden_ancestor_is_refused_and_existing_bundle_permissions_never_widened(self):
        root=Path("/run")/("ezil-rootfs-work-test-"+__import__("uuid").uuid4().hex);root.mkdir(mode=0o700)
        try:
            with self.assertRaises(Refused):art.private_rootfs_container(str(root/"work"),"a"*16)
            self.assertEqual(root.stat().st_mode&0o777,0o700)
            os.chmod(root,0o711);path=Path(art.private_rootfs_container(str(root/"work"),"a"*16))
            self.assertEqual(path.stat().st_mode&0o777,0o711)
            self.assertEqual((root/"work").stat().st_mode&0o777,0o711)
            with self.assertRaises(FileExistsError):art.private_rootfs_container(str(root/"work"),"a"*16)
        finally:shutil.rmtree(root)


class CgroupOciPath(unittest.TestCase):
    def test_actual_cgroup_mount_translation_and_outside_paths_refused(self):
        name="ezil-cgroup-path-test-"+__import__("uuid").uuid4().hex[:8]
        path=Path("/sys/fs/cgroup")/name;path.mkdir()
        try:
            self.assertEqual(ni.cgroup_oci_path(str(path)),"/"+name)
            for bad in ["/tmp",str(path)+"/../escape","relative"]:
                with self.assertRaises((OSError,Refused)):ni.cgroup_oci_path(bad)
            with tempfile.TemporaryDirectory() as root:
                os.symlink(path,Path(root)/"link")
                with self.assertRaises((OSError,Refused)):ni.cgroup_oci_path(str(Path(root)/"link"))
        finally:path.rmdir()


class RootfsServiceUmask(unittest.TestCase):
    def test_dedicated_service_umask_child_exact_modes_and_concurrent_publication(self):
        script = r"""
import os,sys,json,hashlib,shutil,uuid,concurrent.futures
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from ezil_host import native_artifact as art
base=Path('/run')/('ezil-umask-test-'+uuid.uuid4().hex);base.mkdir(mode=0o711)
try:
 template=base/'template';template.mkdir(mode=0o755);(template/'etc').mkdir(mode=0o755);(template/'etc/value').write_bytes(b'seed')
 secret=base/'secret';secret.mkdir(mode=0o700)
 raw=art.rootfs_descriptor_bytes(str(template));descriptor={'rootfsTemplate':art.parse_rootfs_descriptor(raw),'rootfsTemplateSha256':hashlib.sha256(raw).hexdigest()}
 os.umask(0o077)
 work=base/'work'
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:paths=list(pool.map(lambda key:art.private_rootfs_container(str(work),key*16),['a','b','c','d']))
 assert work.stat().st_mode&511==0o711
 for value in paths:assert Path(value).stat().st_mode&511==0o711
 receipt=art.prepare_rootfs(str(template),descriptor,paths[0],['/artifact/x','/workspace','/state/home','/state/config','/state/tmp'])
 root=Path(receipt['path']);assert root.stat().st_mode&511==0o755
 for value in ['etc','artifact','artifact/x','workspace','state','state/home','state/config','state/tmp']:assert (root/value).stat().st_mode&511==0o755
 assert secret.stat().st_mode&511==0o700
 unsafe=base/'unsafe';unsafe.mkdir(mode=0o700)
 try:art.private_rootfs_container(str(unsafe),'e'*16);raise AssertionError('unsafe normalized')
 except art.Refused:pass
 assert unsafe.stat().st_mode&511==0o700
 print(json.dumps({'umask':'0077','allExactModes':True,'concurrentCreators':4,'secretBundle0700':True,'unsafeExistingRejected':True}))
finally:shutil.rmtree(base)
"""
        result=subprocess.run([sys.executable,"-I","-c",script,str(HERE.parent/"lib")],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)


class InitialGrantServiceUmask(unittest.TestCase):
    def test_fresh_grant_chain_exact_modes_under077_and_unsafe_existing_refused(self):
        script=r"""
import os,sys,uuid,shutil
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from ezil_host import native_isolation as ni
from ezil_host.config import Config
root=Path('/run')/('ezil-initial-grant-test-'+uuid.uuid4().hex);root.mkdir(mode=0o711)
try:
 os.umask(0o077);cfg=Config(runDir=str(root),nativeGrantRoot=str(root/'native/grants'))
 ni.ensure_grant_root(cfg)
 for path in [root/'native',root/'native/grants']:assert path.stat().st_mode&511==0o711
 path=ni.write_credential(cfg,'a'*64,'ezg_'+'A'*43,299000,299000);assert Path(path).stat().st_mode&511==0o600;assert Path(path).stat().st_uid==299000
 assert ni.remove_credential(cfg,'a'*64)
 os.chmod(root/'native/grants',0o700)
 try:ni.ensure_grant_root(cfg);raise AssertionError('unsafeexistingnormalized')
 except ni.Refused:pass
 assert (root/'native/grants').stat().st_mode&511==0o700
finally:shutil.rmtree(root)
"""
        result=subprocess.run([sys.executable,"-I","-c",script,str(HERE.parent/"lib")],capture_output=True,text=True,timeout=15)
        self.assertEqual(result.returncode,0,result.stderr)


@unittest.skipUnless(os.geteuid() == 0 and os.access("/run", os.W_OK), "requires root-owned test directories")
class WitnessStorage(unittest.TestCase):
    def setUp(self):
        from unittest.mock import patch
        temp = tempfile.TemporaryDirectory(dir="/run")
        self.addCleanup(temp.cleanup)
        self.state = Path(temp.name)
        self.native = self.state / "native"
        self.evidence = self.native / "evidence"
        self.rootfs = self.state / "rootfs"
        self.native.mkdir(mode=0o700)
        self.evidence.mkdir(mode=0o700)
        self.rootfs.mkdir(mode=0o700)
        self.cfg = Config(stateDir=str(self.state), nativeRootfs=str(self.rootfs),
                          nativeRuntimeRoot=str(self.state / "runtime"), runcBin="/fixture/runc",
                          nativeGatewayCaPem="fixture CA", nativeGatewaySpkiSha256="a" * 64,
                          nativeGatewayOrigin="https://fixture.invalid")
        self.artifact = {"manifestSha256": "a" * 64, "rootfsTemplateSha256": "b" * 64}
        placement = {"generation": "7", "leaseEpoch": "3", "instanceId": INSTANCE, "fenceToken": FENCE}
        boot = ni.boot_id()
        self.witness = {"v": 2, "bootId": boot, "kernel": os.uname().release, "runc": "test-runc",
                        "manifestSha256": self.artifact["manifestSha256"], "placement": placement,
                        "computerId": CMP, "hostEpoch": ni.derive_host_epoch(boot, CMP, placement),
                        "observations": {}}
        for name in ("artifact", "tls", "credentialPeer", "uidNamespaces", "cgroup", "devices", "egress",
                     "workspace", "build", "rootfsTemplate", "childIdentity", "cliInitialize",
                     "firstMessageAck", "fencingCleanup"):
            values = {"fixture": name}
            if name == "rootfsTemplate":
                values["descriptorSha256"] = self.artifact["rootfsTemplateSha256"]
            if name == "build":
                values.update(exitCode=0, outputSha256="c" * 64)
            if name == "tls":
                values.update(caSha256=hashlib.sha256(b"fixture CA").hexdigest(),
                              spkiSha256=self.cfg.nativeGatewaySpkiSha256, gatewayOrigin=self.cfg.nativeGatewayOrigin)
            data = json.dumps(values).encode()
            digest = hashlib.sha256(data).hexdigest()
            record = self.evidence / (digest + ".json")
            record.write_bytes(data)
            record.chmod(0o600)
            self.witness["observations"][name] = {"status": "observed", "evidenceSha256": digest, "observed": values}
        self.enterContext(patch.object(art, "load", return_value=self.artifact))
        self.enterContext(patch.object(ni.subprocess, "run", return_value=SimpleNamespace(stdout="test-runc\n")))

    def test_invalid_replacement_leaves_valid_witness_readable(self):
        from unittest.mock import patch
        ni.write_witness(self.cfg, self.witness)
        self.assertEqual(ni.read_witness(self.cfg, self.artifact), self.witness)
        with self.assertRaisesRegex(Refused, "native_qualification_evidence_invalid"):
            ni.write_witness(self.cfg, dict(self.witness, observations={}))
        self.assertEqual(ni.read_witness(self.cfg, self.artifact), self.witness)
        with patch.object(ni.os, "geteuid", return_value=299000):
            with self.assertRaisesRegex(Refused, "native_qualification_storage_untrusted"):
                ni.write_witness(self.cfg, self.witness)
        self.assertEqual(ni.read_witness(self.cfg, self.artifact), self.witness)

    def test_untrusted_witness_or_evidence_storage_cannot_allow(self):
        ni.write_witness(self.cfg, self.witness)
        evidence = next(self.evidence.iterdir())
        witness = self.native / "witness.json"
        for path, unsafe, safe in ((evidence, 0o644, 0o600), (witness, 0o644, 0o600),
                                   (self.evidence, 0o755, 0o700), (self.native, 0o755, 0o700),
                                   (self.state, 0o777, 0o700)):
            with self.subTest(path=path):
                path.chmod(unsafe)
                try:
                    self.assertIsNone(ni.read_witness(self.cfg, self.artifact))
                finally:
                    path.chmod(safe)
        copy = self.native / "witness-copy.json"
        witness.rename(copy)
        witness.symlink_to(copy)
        self.assertIsNone(ni.read_witness(self.cfg, self.artifact))
