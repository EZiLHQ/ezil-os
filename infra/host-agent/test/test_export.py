#!/usr/bin/env python3
"""Reverse move export on the host (REVERSE-MOVE-CONTRACT §2.2-§2.5, acceptance §2.7 unit rows).

No sockets, root, runc or network: the edge is driven with in-memory client sockets and its
sequencer delivers to a REAL agent.Agent in-process (the agent's own MAC, epoch, freshness and
replay rules apply); the export container is replaced by a runner that executes the committed
codec copy (lib/ezil_host/workspace-snapshot-script.py) exactly as the container would, with
its two binds emulated (/workspace -> <dataMount>/workspace, /tmp -> <export_dir>/tmp). The
codec's real /tmp/ezil-snapshot-<uuid> is removed by exact path.
Run: python3 -B -m unittest -v test_export   (from infra/host-agent/test)."""
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, cli, config, desktop, edge, export, guard, tunnel  # noqa: E402
from ezil_host.fsops import Refused  # noqa: E402

REAL_START_EXPORT = agentmod.Agent._start_export
KEY = b"k" * 32
CID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
LEASE = {"computerId": CID, "generation": 3, "leaseEpoch": 7}
DIGEST = "sha256:" + "d" * 64
MOVE = "abcdef01-2222-4333-8444-5555555555ee"


def body_for(move_id, generation):
    """The Worker's exact bytes: JSON.stringify({v: 1, moveId, generation})."""
    return json.dumps({"v": 1, "moveId": move_id, "generation": generation}, separators=(",", ":")).encode()


class FakeClient:
    """An accepted client connection: recv from a buffer, everything sent is recorded."""

    def __init__(self, data):
        self.buf, self.out = data, b""

    def settimeout(self, _):
        pass

    def recv(self, n):
        chunk, self.buf = self.buf[:n], self.buf[n:]
        return chunk

    def sendall(self, data):
        self.out += data

    def response(self):
        head, _, body = self.out.partition(b"\r\n\r\n")
        lines = head.decode("latin-1").split("\r\n")
        headers = dict(line.split(": ", 1) for line in lines[1:])
        return int(lines[0].split(" ")[1]), headers, body

    def json(self):
        status, _, body = self.response()
        return status, json.loads(body)


def scratch(test):
    """A host layout under one temp dir: state/run (root volume), data (the volume, with
    workspace/), the promoted lower with the export spec's mount destinations."""
    limits = mock.patch.object(desktop, "host_limits", return_value=(200000, 3584 * 1024**2))
    limits.start()
    test.addCleanup(limits.stop)
    d = os.path.realpath(tempfile.mkdtemp(prefix="ezil-export-unit-"))
    test.addCleanup(shutil.rmtree, d, True)
    for sub in ("state", "run", "data/workspace", "etc", "lowers"):
        os.makedirs(os.path.join(d, sub), mode=0o700)
    with open(os.path.join(d, "state", "control.key"), "wb") as f:
        f.write(KEY)
    with open(os.path.join(d, "etc", "seccomp.json"), "w") as f:
        json.dump({"_comment": "x", "defaultAction": "SCMP_ACT_ERRNO", "syscalls": []}, f)
    with open(os.path.join(d, "etc", "lower-image-digest"), "w") as f:
        f.write(DIGEST + "\n")
    lower = os.path.join(d, "lowers", DIGEST[7:])
    for sub in ("usr/bin", "proc", "dev", "tmp", "workspace", "etc"):
        os.makedirs(os.path.join(lower, sub))
    for name in ("etc/hosts", "etc/hostname"):
        open(os.path.join(lower, name), "w").close()
    cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
    cfg.update(stateDir=os.path.join(d, "state"), runDir=os.path.join(d, "run"), dataMount=os.path.join(d, "data"),
               seccompProfile=os.path.join(d, "etc", "seccomp.json"), lowersDir=os.path.join(d, "lowers"),
               lowerDigestFile=os.path.join(d, "etc", "lower-image-digest"))
    return d, cfg, lower


def write_record(cfg, **over):
    record = {"moveId": MOVE, "importGeneration": str(uuid.uuid4()), "state": "capturing",
              "startedAt": export.iso(time.time()), "finishedAt": None, "lastServedAt": None, "error": None, "head": None}
    record.update(over)
    export.ensure_root(cfg)
    export._write_state(cfg, record)
    return record


class CodecRunner:
    """Stands in for `runc run` of the export bundle: reads the spec it was given and runs its
    process (the committed codec, `export-capture`) with the spec's binds emulated."""

    def __init__(self, test, before=None):
        self.test, self.before, self.calls = test, before, []

    def __call__(self, cfg, bundle, result_path, timeout=None):
        with open(os.path.join(bundle, "config.json")) as f:
            spec = json.load(f)
        self.calls.append(spec)
        binds = {m["destination"]: m["source"] for m in spec["mounts"] if m["type"] == "bind"}
        args = spec["process"]["args"]
        params = json.loads(args[4])
        self.test.addCleanup(shutil.rmtree, params["work"], True)    # /tmp/ezil-snapshot-<uuid>, this exact path
        if self.before:
            self.before(binds)
        with open(result_path, "xb") as out:
            rc = subprocess.run([sys.executable, *args[1:4], json.dumps(dict(params, root=binds["/workspace"]))],
                                stdout=out, stderr=subprocess.DEVNULL, timeout=120).returncode
        if os.path.exists(params["work"]):
            shutil.move(params["work"], os.path.join(binds["/tmp"], os.path.basename(params["work"])))
        return rc


class Body(unittest.TestCase):
    def test_exact_worker_bytes_parse(self):
        g = str(uuid.uuid4())
        self.assertEqual(export.parse_request(body_for(MOVE, g)), {"v": 1, "moveId": MOVE, "generation": g})

    def test_closed_body(self):
        g = str(uuid.uuid4())
        bad = [
            b'{"v":1,"moveId":"%s","generation":"%s","x":1}' % (MOVE.encode(), g.encode()),       # extra key
            b'{"v":1,"moveId":"%s"}' % MOVE.encode(),                                              # missing key
            b'{"v":1,"moveId":"%s","moveId":"%s","generation":"%s"}' % (MOVE.encode(), MOVE.encode(), g.encode()),
            b'{"v":true,"moveId":"%s","generation":"%s"}' % (MOVE.encode(), g.encode()),           # v not the integer 1
            b'{"v":1.0,"moveId":"%s","generation":"%s"}' % (MOVE.encode(), g.encode()),
            b'{"v":"1","moveId":"%s","generation":"%s"}' % (MOVE.encode(), g.encode()),
            b'{"v":2,"moveId":"%s","generation":"%s"}' % (MOVE.encode(), g.encode()),
            b'{"v":1,"moveId":"%s","generation":"%s"}' % (MOVE.upper().encode(), g.encode()),     # not lowercase
            b'{"v":1,"moveId":"%s\\n","generation":"%s"}' % (MOVE.encode(), g.encode()),          # no trailing newline
            b'{"v":NaN,"moveId":"%s","generation":"%s"}' % (MOVE.encode(), g.encode()),
            b'[1]', b'', b'\xff\xfe',
            body_for(MOVE, g).decode().encode("utf-16"),                                           # json.loads(bytes) would accept
        ]
        for raw in bad:
            with self.subTest(raw=raw[:60]):
                self.assertIsNone(export.parse_request(raw))


class AgentOp(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg, _ = scratch(self)
        self.agent = agentmod.Agent(self.cfg, LEASE, log=lambda m: None)
        self.seq = 0
        started = mock.patch.object(agentmod.Agent, "_start_export")
        self.start = started.start()
        self.addCleanup(started.stop)

    def send(self, op="export", drop=(), **fields):
        self.seq += 1
        msg = {"op": op, "leaseEpoch": LEASE["leaseEpoch"], "ts": time.time(), "seq": self.seq, **fields}
        for k in drop:
            msg.pop(k)
        msg["mac"] = agentmod.sign(KEY, msg)
        return self.agent.handle(json.dumps(msg))

    def test_closed_message_including_lease_epoch_and_mac(self):
        g = str(uuid.uuid4())
        last = self.agent.last_seq
        for fields, drop in (({"moveId": MOVE, "importGeneration": g, "extra": 1}, ()),
                             ({"moveId": MOVE, "importGeneration": g, "generation": g}, ()),
                             ({"moveId": MOVE}, ()),
                             ({"moveId": MOVE.upper(), "importGeneration": g}, ()),
                             ({"moveId": MOVE, "importGeneration": 7}, ())):
            with self.subTest(fields=fields):
                self.assertEqual(self.send(**fields), {"ok": False, "error": "export_invalid"})
        self.assertEqual(self.agent.last_seq, last, "refused before the seq is spent")
        self.assertEqual(self.send(moveId=MOVE, importGeneration=g, drop=("leaseEpoch",)), {"ok": False, "error": "wrong_epoch"})
        self.seq += 1
        msg = {"op": "export", "leaseEpoch": 7, "ts": time.time(), "seq": self.seq, "moveId": MOVE, "importGeneration": g}
        msg["mac"] = agentmod.sign(b"x" * 32, msg)
        self.assertEqual(self.agent.handle(json.dumps(msg)), {"ok": False, "error": "bad_mac"})
        self.assertIsNone(export.read_state(self.cfg))
        self.start.assert_not_called()

    def test_accepts_persists_capturing_and_is_idempotent(self):
        g = str(uuid.uuid4())
        self.assertEqual(self.send(moveId=MOVE, importGeneration=g), {"ok": True})
        record = export.read_state(self.cfg)
        self.assertEqual((record["moveId"], record["importGeneration"], record["state"]), (MOVE, g, "capturing"))
        self.assertEqual(oct(os.stat(os.path.join(self.cfg.stateDir, "export", "state.json")).st_mode & 0o777), "0o600")
        self.assertEqual(self.send(moveId=MOVE, importGeneration=g), {"ok": True})
        self.assertEqual(export.read_state(self.cfg), record, "the same ids resume or report; nothing is rewritten")
        self.assertEqual(self.send(moveId=MOVE, importGeneration=str(uuid.uuid4())), {"ok": False, "error": "export_busy"})
        self.assertEqual(self.send(moveId=str(uuid.uuid4()), importGeneration=g), {"ok": False, "error": "export_busy"})
        self.assertEqual(self.start.call_count, 2)

    def test_a_host_committed_to_stopping_answers_stopping(self):
        # A control-plane stop or fence accepted, or a shutdown begun: no job may start. The
        # export's own guard (runDir/stopping alone) is not that: its re-POSTs still report.
        g = str(uuid.uuid4())
        self.assertEqual(self.send(moveId=MOVE, importGeneration=g), {"ok": True})
        open(os.path.join(self.cfg.runDir, desktop.STOPPING), "w").close()
        self.assertEqual(self.send(moveId=MOVE, importGeneration=g), {"ok": True})
        for commit in ("stop_request", "shutdown_pending"):
            with self.subTest(commit=commit):
                if commit == "stop_request":
                    self.agent.stop_request = {"kind": "stop", "warn": 0, "reason": "control_plane"}
                else:
                    self.agent.stop_request = None
                    open(os.path.join(self.cfg.runDir, agentmod.SHUTDOWN_PENDING), "w").close()
                for ids in ((MOVE, g), (MOVE, str(uuid.uuid4()))):
                    self.assertEqual(self.send(moveId=ids[0], importGeneration=ids[1]), {"ok": False, "error": "stopping"})
        self.assertEqual(self.start.call_count, 2)
        self.assertEqual(export.read_state(self.cfg)["importGeneration"], g)

    def test_the_job_is_told_when_the_host_commits_to_stopping(self):
        with mock.patch.object(export, "Job") as job, mock.patch.object(agentmod.threading, "Thread"):
            REAL_START_EXPORT(self.agent)                  # setUp patched the method itself
        stopping = job.call_args.kwargs["stopping"]
        self.assertFalse(stopping())
        self.agent.stop_request = {"kind": "fence", "warn": 0, "reason": "fence"}
        self.assertTrue(stopping())
        self.agent.stop_request = None
        open(os.path.join(self.cfg.runDir, desktop.STOPPING), "w").close()
        self.assertFalse(stopping(), "the export's own desktop stop is not a host stop")
        open(os.path.join(self.cfg.runDir, agentmod.SHUTDOWN_PENDING), "w").close()
        self.assertTrue(stopping())

    def test_unreadable_record_is_busy_never_overwritten(self):
        export.ensure_root(self.cfg)
        with open(os.path.join(self.cfg.stateDir, "export", "state.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(self.send(moveId=MOVE, importGeneration=str(uuid.uuid4())), {"ok": False, "error": "export_busy"})
        with self.assertRaises(Refused):
            export.read_state(self.cfg)


class EdgeRig(unittest.TestCase):
    """The edge in front of a real in-process agent (its sequencer's socket replaced)."""

    def setUp(self):
        self.d, self.cfg, self.lower = scratch(self)
        self.agent = agentmod.Agent(self.cfg, LEASE, log=lambda m: None)
        self.seq = edge.Sequencer(self.cfg, LEASE, KEY, log=lambda m: None)
        self.delivered = []

        def deliver(msg):
            msg["mac"] = agentmod.sign(KEY, msg)
            self.delivered.append(msg["op"])
            return self.agent.handle(json.dumps(msg))
        self.seq._send_once = deliver
        self.edge = edge.Edge(self.cfg, LEASE, KEY, sequencer=self.seq, log=lambda m: None)

    def request(self, method, path, headers=(), body=b"", gw=True):
        lines = [f"{method} {path} HTTP/1.1", "Host: c-x.origin.example.net"]
        if gw:
            ts = int(time.time())
            payload = edge.gateway_payload(LEASE, ts, method, path.split("?")[0])
            lines.append(f"x-ezil-gw: gw1.{ts}.{hmac.new(KEY, payload.encode(), hashlib.sha256).hexdigest()}")
        lines += list(headers)
        client = FakeClient(("\r\n".join(lines) + "\r\n\r\n").encode() + body)
        self.edge.handle(client)
        return client

    def post(self, body, digest=None, extra=(), method="POST", query=""):
        digest = hashlib.sha256(body).hexdigest() if digest is None else digest
        return self.request(method, f"/__ezil/control/export/{digest}{query}",
                            headers=[f"Content-Length: {len(body)}", *extra], body=body)


class EdgePost(EdgeRig):
    def setUp(self):
        super().setUp()
        started = mock.patch.object(agentmod.Agent, "_start_export")
        self.start = started.start()
        self.addCleanup(started.stop)

    def test_post_is_202_with_the_status_and_idempotent(self):
        g = str(uuid.uuid4())
        status, st = self.post(body_for(MOVE, g)).json()
        self.assertEqual(status, 202)
        self.assertEqual((st["ok"], st["state"], st["moveId"], st["generation"], st["error"]), (True, "capturing", MOVE, g, None))
        self.assertIsNotNone(st["startedAt"])
        self.assertNotIn("entries", st)
        self.assertEqual(self.post(body_for(MOVE, g)).json(), (202, st))
        self.assertEqual(self.post(body_for(MOVE, str(uuid.uuid4()))).json(), (409, {"ok": False, "error": "export_busy"}))
        self.assertEqual(self.delivered.count("export"), 3)

    def test_digest_mismatch_and_bad_bodies_never_reach_the_agent(self):
        body = body_for(MOVE, str(uuid.uuid4()))
        cases = [
            (self.post(body, digest=hashlib.sha256(body + b" ").hexdigest()), 400, "export_digest_mismatch"),
            (self.post(b'{"v":1}'), 400, "export_body_invalid"),
            (self.post(b"x" * 1025), 400, "export_body_invalid"),
            (self.request("POST", f"/__ezil/control/export/{hashlib.sha256(b'').hexdigest()}",
                          headers=["Content-Length: 0"]), 400, "export_body_invalid"),
            (self.request("POST", f"/__ezil/control/export/{hashlib.sha256(body).hexdigest()}",
                          headers=["Transfer-Encoding: chunked"], body=b"%x\r\n" % len(body) + body + b"\r\n0\r\n\r\n"),
             400, "export_body_invalid"),
            (self.request("POST", f"/__ezil/control/export/{hashlib.sha256(body).hexdigest()}",
                          headers=["Content-Length: ²".encode("latin-1").decode("latin-1")], body=body), 400, "export_body_invalid"),
            (self.post(body, extra=[f"Content-Length: {len(body)}"]), 400, "bad_request"),       # duplicate length header
            (self.post(body, method="GET"), 404, "not_found"),
            (self.post(body, query="?a=1"), 404, "not_found"),
        ]
        for client, code, error in cases:
            with self.subTest(error=error, code=code):
                self.assertEqual(client.json(), (code, {"ok": False, "error": error}))
        self.assertNotIn("export", self.delivered)
        self.assertIsNone(export.read_state(self.cfg))

    def test_the_digest_fixes_the_bytes_so_spacing_and_key_order_are_not_checked(self):
        g = str(uuid.uuid4())
        body = ('{ "generation" : "%s",\n "moveId": "%s", "v": 1 }\n' % (g, MOVE)).encode()
        status, st = self.post(body).json()
        self.assertEqual((status, st["moveId"], st["generation"]), (202, MOVE, g))

    def test_unsigned_post_is_401_and_nothing_is_relayed(self):
        body = body_for(MOVE, str(uuid.uuid4()))
        client = self.request("POST", f"/__ezil/control/export/{hashlib.sha256(body).hexdigest()}",
                              headers=[f"Content-Length: {len(body)}"], body=body, gw=False)
        self.assertEqual(client.response()[0], 401)
        self.assertEqual(self.delivered, [])

    def test_agent_unavailable_is_503(self):
        body = body_for(MOVE, str(uuid.uuid4()))
        # Only a refusal the agent sent is 409 (final for the Worker); the agent failing is not.
        for failure in (OSError("connect"), ValueError("bad json"), {"ok": False, "error": "internal"},
                        {}, {"ok": False}, {"ok": False, "error": 7}, {"ok": False, "error": "stopping"},
                        {"ok": "yes"}, {"ok": False, "error": "something_new"}, []):
            with self.subTest(failure=failure):
                def send(op, **fields):
                    if op != "export":
                        return {"ok": True}
                    if isinstance(failure, (dict, list)):
                        return failure
                    raise failure
                with mock.patch.object(self.seq, "send", side_effect=send):
                    self.assertEqual(self.post(body).json(), (503, {"ok": False, "error": "agent_unavailable"}))
        self.assertIsNone(export.read_state(self.cfg))

    def test_a_post_to_a_host_committed_to_stopping_is_503_and_starts_nothing(self):
        self.agent.stop_request = {"kind": "stop", "warn": 0, "reason": "control_plane"}
        self.assertEqual(self.post(body_for(MOVE, str(uuid.uuid4()))).json(),
                         (503, {"ok": False, "error": "agent_unavailable"}))
        self.assertIsNone(export.read_state(self.cfg))
        self.start.assert_not_called()

    def test_an_agent_that_closes_the_socket_unanswered_is_503(self):
        # The agent died or restarted mid-request: the sequencer reads EOF and json.loads(b"{}")
        # (or a reply that is not an object). Retryable (export_unreachable), never export_refused.
        body = body_for(MOVE, str(uuid.uuid4()))
        for reply in ({}, [], "x"):
            with self.subTest(reply=reply):
                self.seq._send_once = lambda msg, reply=reply: reply if msg["op"] == "export" else {"ok": True}
                self.assertEqual(self.post(body).json(), (503, {"ok": False, "error": "agent_unavailable"}))

    def test_an_agent_refusal_is_409_export_invalid(self):
        body = body_for(MOVE, str(uuid.uuid4()))
        for error in ("export_invalid", "wrong_epoch", "stale_request", "replayed", "bad_mac", "bad_seq", "bad_ts",
                      "bad_json"):
            with self.subTest(error=error):
                with mock.patch.object(self.seq, "send", return_value={"ok": False, "error": error}):
                    self.assertEqual(self.post(body).json(), (409, {"ok": False, "error": "export_invalid"}))


class EdgeGet(EdgeRig):
    """status, head and chunk are served from disk: the agent socket is never used for them."""

    def ready(self, data=b"z" * (1024 * 1024 + 5)):
        g = str(uuid.uuid4())
        parts = [data[i:i + export.CHUNK] for i in range(0, len(data), export.CHUNK)]
        chunks = [{"i": i, "size": len(p), "sha256": hashlib.sha256(p).hexdigest()} for i, p in enumerate(parts)]
        head = {"v": 1, "moveId": MOVE, "generation": g, "sha256": hashlib.sha256(data).hexdigest(), "entries": 3,
                "skipped": 1, "bytes": len(data), "chunks": chunks}
        os.makedirs(os.path.join(self.cfg.stateDir, "export", g, "chunks"))
        for i, p in enumerate(parts):
            with open(os.path.join(self.cfg.stateDir, "export", g, "chunks", str(i)), "wb") as f:
                f.write(p)
        write_record(self.cfg, importGeneration=g, state="ready", finishedAt=export.iso(time.time()), head=head)
        return g, head, parts

    def get(self, path, **kw):
        with mock.patch.object(self.seq, "send", side_effect=lambda op, **f: {"ok": True} if op == "presence"
                               else self.fail(f"{op} must not reach the agent")):
            return self.request("GET", path, **kw)

    def test_status_none_before_any_post(self):
        self.assertEqual(self.get("/__ezil/control/export/status").json(), (200, {
            "ok": True, "state": "none", "moveId": None, "generation": None, "startedAt": None,
            "finishedAt": None, "lastServedAt": None, "error": None}))

    def test_ready_status_head_and_chunks_from_disk(self):
        g, head, parts = self.ready()
        status, st = self.get("/__ezil/control/export/status").json()
        self.assertEqual((status, st["state"], st["entries"], st["bytes"], st["skipped"]), (200, "ready", 3, head["bytes"], 1))
        self.assertIsNotNone(st["lastServedAt"], "a status GET is lastServedAt")
        self.assertEqual(self.get("/__ezil/control/export/head").json(), (200, head))
        for i, p in enumerate(parts):
            status, headers, body = self.get(f"/__ezil/control/export/chunk/{i}").response()
            self.assertEqual((status, headers["Content-Type"], int(headers["Content-Length"]), body),
                             (200, "application/octet-stream", head["chunks"][i]["size"], p))

    def test_chunk_index_grammar_and_order(self):
        self.assertEqual(self.get("/__ezil/control/export/chunk/07").json(), (400, {"ok": False, "error": "bad_chunk_index"}))
        self.assertEqual(self.get("/__ezil/control/export/chunk/0").json(), (409, {"ok": False, "error": "export_not_ready"}))
        self.assertEqual(self.get("/__ezil/control/export/head").json(), (409, {"ok": False, "error": "export_not_ready"}))
        g, head, _ = self.ready()
        for bad in ("007", "00", "-1", "1.0", "abc", "", "512", "1000", "0x1", "+1", "%201", "1/2"):
            with self.subTest(index=bad):
                self.assertEqual(self.get(f"/__ezil/control/export/chunk/{bad}").json(), (400, {"ok": False, "error": "bad_chunk_index"}))
        self.assertEqual(self.get(f"/__ezil/control/export/chunk/{len(head['chunks'])}").json(),
                         (400, {"ok": False, "error": "bad_chunk_index"}), "past the last chunk")
        os.unlink(os.path.join(self.cfg.stateDir, "export", g, "chunks", "1"))
        self.assertEqual(self.get("/__ezil/control/export/chunk/1").json(), (404, {"ok": False, "error": "export_chunk_missing"}))
        os.symlink("0", os.path.join(self.cfg.stateDir, "export", g, "chunks", "1"))
        self.assertEqual(self.get("/__ezil/control/export/chunk/1").json(), (404, {"ok": False, "error": "export_chunk_missing"}),
                         "a link is never followed")

    def test_wrong_method_query_or_body_is_404(self):
        self.ready()
        for client in (self.get("/__ezil/control/export/status?x=1"), self.request("POST", "/__ezil/control/export/head"),
                       self.get("/__ezil/control/export/chunk/0", headers=["Content-Length: 0"])):
            self.assertEqual(client.json(), (404, {"ok": False, "error": "not_found"}))

    def test_unreadable_state(self):
        export.ensure_root(self.cfg)
        with open(os.path.join(self.cfg.stateDir, "export", "state.json"), "w") as f:
            f.write('{"state":"ready"}')
        self.assertEqual(self.get("/__ezil/control/export/status").json(), (503, {"ok": False, "error": "export_state_unreadable"}))
        self.assertEqual(self.get("/__ezil/control/export/head").json(), (409, {"ok": False, "error": "export_not_ready"}))

    def test_last_served_is_throttled_and_kept_by_the_job(self):
        g, _, _ = self.ready()
        t = time.time()
        export.note_served(self.cfg, t)
        self.assertEqual(export.read_state(self.cfg)["lastServedAt"], export.iso(t))
        export.note_served(self.cfg, t + 10)
        self.assertEqual(export.read_state(self.cfg)["lastServedAt"], export.iso(t), "at most one write per 15 s")
        export.note_served(self.cfg, t + 15)
        self.assertEqual(export.read_state(self.cfg)["lastServedAt"], export.iso(t + 15))


class Spec(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg, self.lower = scratch(self)
        self.g = str(uuid.uuid4())
        self.export_dir = os.path.join(export.ensure_root(self.cfg), self.g)
        os.makedirs(os.path.join(self.export_dir, "tmp"), mode=0o700)

    def build(self):
        bundle = desktop.build_export_spec(self.cfg, LEASE, self.export_dir)
        with open(os.path.join(bundle, "config.json")) as f:
            return bundle, json.load(f)

    def test_generated_export_spec(self):
        bundle, spec = self.build()
        self.assertNotEqual(bundle, os.path.join(self.cfg.runDir, "bundle"), "a desktop restart can never launch it")
        self.assertEqual(spec["root"], {"path": self.lower, "readonly": True}, "the promoted lower, read-only")
        mounts = {m["destination"]: m for m in spec["mounts"]}
        self.assertEqual(set(mounts), {"/proc", "/dev", "/tmp", "/workspace", "/etc/hosts", "/etc/hostname"})
        ws = mounts["/workspace"]
        self.assertEqual((ws["type"], ws["source"]), ("bind", os.path.join(self.cfg.dataMount, "workspace")))
        self.assertTrue({"ro", "nosuid", "nodev", "noexec"} <= set(ws["options"]))
        self.assertNotIn("rw", ws["options"])
        tmp = mounts["/tmp"]
        self.assertEqual((tmp["type"], tmp["source"]), ("bind", os.path.join(self.export_dir, "tmp")), "/tmp on the export dir")
        self.assertIn("rw", tmp["options"])
        for dst in ("/etc/hosts", "/etc/hostname"):
            self.assertIn("ro", mounts[dst]["options"])
            self.assertTrue(mounts[dst]["source"].startswith(os.path.join(self.cfg.runDir, "gen") + "/"))
        self.assertFalse(any("profiles" in m["source"] or "profiles" in m["destination"] for m in spec["mounts"]),
                         "no profiles bind")
        self.assertFalse(any(m["destination"] == "/tmp" and m["type"] == "tmpfs" for m in spec["mounts"]))
        net = [n for n in spec["linux"]["namespaces"] if n["type"] == "network"]
        self.assertEqual(net, [{"type": "network"}], "a NEW network namespace: loopback only, never the desktop's")
        self.assertEqual(spec["linux"]["cgroupsPath"], self.cfg.cgroupsPath + "-export")
        p = spec["process"]
        self.assertEqual(p["args"][:3], ["/usr/bin/python3", "-I", "-c"])
        with open(desktop.EXPORT_CODEC) as f:
            self.assertEqual(p["args"][3], f.read(), "the committed Worker codec")
        self.assertEqual(json.loads(p["args"][4]), {"op": "export-capture", "root": "/workspace",
                                                    "work": f"/tmp/ezil-snapshot-{self.g}"})
        self.assertEqual((p["capabilities"]["bounding"], p["noNewPrivileges"], p["apparmorProfile"]),
                         (desktop.CAPS, True, self.cfg.apparmorProfile))
        self.assertNotIn("_comment", spec["linux"]["seccomp"])
        self.assertEqual(spec["linux"]["resources"]["pids"], {"limit": self.cfg.pidsLimit})
        self.assertEqual(spec["linux"]["resources"]["memory"], {"limit": 3584 * 1024**2})

    def test_missing_lower_mountpoints_are_refused_never_created(self):
        for rel in ("workspace", "tmp", "etc/hostname"):
            with self.subTest(rel=rel):
                path = os.path.join(self.lower, rel)
                os.rmdir(path) if os.path.isdir(path) else os.unlink(path)
                with self.assertRaisesRegex(Refused, "export_lower_mountpoint_missing"):
                    self.build()
                self.assertFalse(os.path.exists(path))
                os.mkdir(path) if rel != "etc/hostname" else open(path, "w").close()
        os.rmdir(os.path.join(self.lower, "workspace"))
        os.symlink("tmp", os.path.join(self.lower, "workspace"))
        with self.assertRaisesRegex(Refused, "export_lower_mountpoint_missing"):
            self.build()

    def test_export_dir_must_be_an_import_generation(self):
        with self.assertRaisesRegex(Refused, "export_dir_invalid"):
            desktop.build_export_spec(self.cfg, LEASE, os.path.join(self.cfg.stateDir, "export", "..x"))

    def test_export_dir_is_never_on_the_data_volume(self):
        self.cfg["stateDir"] = os.path.join(self.cfg.dataMount, "state")
        with self.assertRaisesRegex(Refused, "export_dir_on_data_volume"):
            export.root(self.cfg)


class Jobs(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg, _ = scratch(self)
        self.logs = []
        self.stops = []
        self.stop_ok = True
        self.ws = os.path.join(self.cfg.dataMount, "workspace")
        with open(os.path.join(self.ws, "a.txt"), "wb") as f:
            f.write(os.urandom(1024 * 1024 + 300))
        os.makedirs(os.path.join(self.ws, "src"))
        with open(os.path.join(self.ws, "src", "b"), "w") as f:
            f.write("b")
        os.mkfifo(os.path.join(self.ws, "pipe"))
        self.record = write_record(self.cfg)
        self.g = self.record["importGeneration"]
        # The host's real free space never decides a test (the refusal test sets its own).
        for name, kw in (("remove_container", {}), ("_free_bytes", {"return_value": export.MIN_FREE_BYTES})):
            p = mock.patch.object(export, name, **kw)
            p.start()
            self.addCleanup(p.stop)
        self.host_stopping = []

    def job(self):
        def stop():
            self.stops.append(time.time())
            return self.stop_ok
        return export.Job(self.cfg, LEASE, stop, log=self.logs.append,
                          stopping=lambda: bool(self.host_stopping and self.host_stopping.pop(0)))

    def run_with(self, runner):
        with mock.patch.object(export, "run_container", side_effect=runner):
            self.job().run()
        return export.read_state(self.cfg)

    def test_capture_stages_rehashed_chunks_and_a_valid_head(self):
        record = self.run_with(CodecRunner(self))
        self.assertEqual((record["state"], record["error"]), ("ready", None), self.logs)
        head = record["head"]
        self.assertTrue(export.valid_head(head, MOVE, self.g))
        self.assertEqual((head["entries"], head["skipped"], len(head["chunks"])), (3, 1, 2))
        d = os.path.join(self.cfg.stateDir, "export", self.g)
        self.assertFalse(os.path.exists(os.path.join(d, "tmp")), "archive and codec scratch are gone")
        joined = b""
        for c in head["chunks"]:
            with open(os.path.join(d, "chunks", str(c["i"])), "rb") as f:
                data = f.read()
            self.assertEqual(hashlib.sha256(data).hexdigest(), c["sha256"])
            joined += data
        self.assertEqual(hashlib.sha256(joined).hexdigest(), head["sha256"])
        with open(os.path.join(d, "head.json")) as f:
            self.assertEqual(json.load(f), head)
        self.assertEqual(len(self.stops), 1)
        self.assertIsNotNone(record["finishedAt"])

    def test_exit_codes(self):
        for rc, error in ((3, "workspace_too_large"), (1, "capture_failed"), (4, "capture_failed"), (None, "capture_failed")):
            with self.subTest(rc=rc):
                record = write_record(self.cfg)
                record = self.run_with(lambda *a, **kw: rc)
                self.assertEqual((record["state"], record["error"], record["head"]), ("failed", error, None))
                self.assertFalse(os.path.exists(os.path.join(self.cfg.stateDir, "export", record["importGeneration"])))

    def test_real_codec_over_the_limit_is_workspace_too_large(self):
        with open(desktop.EXPORT_CODEC) as f:
            codec = f.read().replace("MAX_ENTRIES = 100000", "MAX_ENTRIES = 1", 1)
        limited = os.path.join(self.d, "codec.py")
        with open(limited, "w") as f:
            f.write(codec)
        with mock.patch.object(desktop, "EXPORT_CODEC", limited):
            record = self.run_with(CodecRunner(self))
        self.assertEqual((record["state"], record["error"]), ("failed", "workspace_too_large"))

    def test_free_space_refusal_comes_before_any_stop(self):
        with mock.patch.object(export, "_free_bytes", return_value=export.MIN_FREE_BYTES - 1):
            record = self.run_with(CodecRunner(self))
        self.assertEqual((record["state"], record["error"]), ("failed", "staging_space_low"))
        self.assertEqual(self.stops, [])
        self.assertEqual(export.MIN_FREE_BYTES, 1879048192, "1.75 GiB")

    def test_desktop_that_will_not_stop(self):
        self.stop_ok = False
        runner = CodecRunner(self)
        record = self.run_with(runner)
        self.assertEqual((record["state"], record["error"]), ("failed", "desktop_stop_failed"))
        self.assertEqual(runner.calls, [], "no capture while the desktop may still write")

    def test_workspace_missing_or_not_a_directory(self):
        shutil.rmtree(self.ws)
        runner = CodecRunner(self)
        self.assertEqual(self.run_with(runner)["error"], "workspace_missing")
        os.symlink("/etc", self.ws)
        write_record(self.cfg)
        self.assertEqual(self.run_with(runner)["error"], "workspace_missing")
        self.assertEqual(runner.calls, [])

    def test_tampered_staging_is_capture_failed(self):
        def tamper(kind):
            def run(cfg, bundle, result_path, timeout=None):
                rc = CodecRunner(self)(cfg, bundle, result_path)
                work = os.path.join(self.cfg.stateDir, "export", export.read_state(self.cfg)["importGeneration"], "tmp")
                work = os.path.join(work, os.listdir(work)[0])
                target = os.path.join(work, "0")
                if kind == "bytes":
                    with open(target, "r+b") as f:
                        f.write(b"X")
                elif kind == "link":
                    os.unlink(target)
                    os.symlink("/etc/passwd", target)
                elif kind == "missing":
                    os.unlink(os.path.join(work, "1"))
                elif kind == "hardlink":
                    os.link(target, os.path.join(work, "extra"))
                elif kind == "stdout":
                    with open(result_path, "wb") as f:
                        f.write(b"not json")
                return rc
            return run
        for kind in ("bytes", "link", "missing", "hardlink", "stdout"):
            with self.subTest(kind=kind):
                write_record(self.cfg)
                record = self.run_with(tamper(kind))
                self.assertEqual((record["state"], record["error"]), ("failed", "capture_failed"))

    def test_finish_keeps_last_served_and_never_touches_another_job(self):
        t = time.time()

        def runner(cfg, bundle, result_path, timeout=None):
            export.note_served(self.cfg, t)        # the edge served a status GET mid-capture
            return CodecRunner(self)(cfg, bundle, result_path)
        record = self.run_with(runner)
        self.assertEqual((record["state"], record["lastServedAt"]), ("ready", export.iso(t)))
        other = write_record(self.cfg, state="failed", error="capture_failed", finishedAt=export.iso(t))
        self.job()._finish(MOVE, self.g, "ready", head=record["head"])
        self.assertEqual(export.read_state(self.cfg), other)

    def test_a_host_committed_to_stopping_never_starts_the_container(self):
        # Checked at the job's start and again right before the container binds /workspace (a
        # stop committed during the desktop stop): the quiesce must find nothing holding the volume.
        for checks, stopped in (([True], 0), ([False, True], 1)):
            with self.subTest(checks=checks):
                write_record(self.cfg)
                self.stops.clear()
                self.host_stopping[:] = checks
                runner = CodecRunner(self)
                record = self.run_with(runner)
                self.assertEqual((record["state"], record["error"]), ("failed", "capture_failed"))
                self.assertEqual((runner.calls, len(self.stops)), ([], stopped))

    def test_the_job_budget_runs_from_started_at(self):
        # A capture never outlives the app's 20 min `exporting` deadline: the container's timeout
        # is what is left of 15 min after the job started, and a resumed job past it fails at once.
        self.assertEqual(export.JOB_BUDGET_SECONDS, 15 * 60)
        timeouts = []

        def runner(cfg, bundle, result_path, timeout):
            timeouts.append(timeout)
            return CodecRunner(self)(cfg, bundle, result_path)
        write_record(self.cfg, startedAt=export.iso(time.time() - 600))
        self.assertEqual(self.run_with(runner)["state"], "ready")
        self.assertTrue(0 < timeouts[0] <= 300, timeouts)
        write_record(self.cfg, startedAt=export.iso(time.time() - export.JOB_BUDGET_SECONDS - 1))
        record = self.run_with(runner)
        self.assertEqual((record["state"], record["error"], len(timeouts)), ("failed", "capture_failed", 1))

    def test_a_job_that_fails_before_its_capture_still_reports(self):
        # The export dir's own setup is inside the job's guard: the record never stays capturing.
        real, calls = export.ensure_root, []

        def flaky(cfg):
            calls.append(1)
            if len(calls) == 1:
                raise PermissionError("export dir")
            return real(cfg)
        with mock.patch.object(export, "ensure_root", side_effect=flaky):
            record = self.run_with(CodecRunner(self))
        self.assertEqual((record["state"], record["error"]), ("failed", "capture_failed"))
        # An export dir that refuses every time (it resolves onto the data volume): the job
        # cannot record anything, and still never raises out of its thread.
        write_record(self.cfg)
        with mock.patch.object(export, "ensure_root", side_effect=Refused("export_dir_on_data_volume")), \
                mock.patch.object(export.time, "sleep"):
            self.job().run()
        self.assertEqual(export.read_state(self.cfg)["state"], "capturing")

    def test_a_failed_final_write_is_retried_once_then_left_to_the_app_deadline(self):
        real = export._write_state
        for failures, state in ((1, "ready"), (2, "capturing")):
            with self.subTest(failures=failures):
                write_record(self.cfg)
                left = [failures]

                def write(cfg, record):
                    if left[0]:
                        left[0] -= 1
                        raise OSError(28, "No space left on device")
                    return real(cfg, record)
                with mock.patch.object(export, "_write_state", side_effect=write), \
                        mock.patch.object(export.time, "sleep"):
                    record = self.run_with(CodecRunner(self))      # never raises
                self.assertEqual(record["state"], state)


class AgentJob(unittest.TestCase):
    """The agent answers within 1 s while a capture runs in its worker thread."""

    def setUp(self):
        self.d, self.cfg, _ = scratch(self)
        self.agent = agentmod.Agent(self.cfg, LEASE, log=lambda m: None)
        self.seq = 0
        self.release = threading.Event()
        self.running = threading.Event()
        for name, kw in (("remove_container", {}), ("_free_bytes", {"return_value": export.MIN_FREE_BYTES})):
            p = mock.patch.object(export, name, **kw)
            p.start()
            self.addCleanup(p.stop)
        p = mock.patch.object(agentmod.Agent, "_export_stop_desktop", return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def send(self, **fields):
        self.seq += 1
        msg = {"op": "export", "leaseEpoch": LEASE["leaseEpoch"], "ts": time.time(), "seq": self.seq, **fields}
        msg["mac"] = agentmod.sign(KEY, msg)
        started = time.monotonic()
        resp = self.agent.handle(json.dumps(msg))
        return resp, time.monotonic() - started

    def test_answers_in_under_a_second_while_a_capture_runs(self):
        def slow(cfg, bundle, result_path, timeout=None):
            self.running.set()
            self.release.wait(30)
            return 1
        g = str(uuid.uuid4())
        with mock.patch.object(export, "run_container", side_effect=slow):
            resp, took = self.send(moveId=MOVE, importGeneration=g)
            self.assertEqual(resp, {"ok": True})
            self.assertLess(took, 1.0)
            self.assertTrue(self.running.wait(10), "the capture runs in the worker thread")
            for fields, want in (({"moveId": MOVE, "importGeneration": g}, {"ok": True}),
                                 ({"moveId": MOVE, "importGeneration": str(uuid.uuid4())}, {"ok": False, "error": "export_busy"})):
                resp, took = self.send(**fields)
                self.assertEqual(resp, want)
                self.assertLess(took, 1.0, "never waits for the capture")
            self.assertEqual(threading.active_count() >= 2, True)
            thread = self.agent.export_thread
            self.release.set()
            thread.join(10)
        self.assertEqual(export.read_state(self.cfg)["state"], "failed")

    def test_run_resumes_a_capture_the_last_agent_did_not_finish(self):
        write_record(self.cfg)
        with mock.patch.object(agentmod.Agent, "_start_export") as start, \
                mock.patch.object(agentmod.Agent, "serve"), \
                mock.patch.object(agentmod.Agent, "tick", return_value="stopped"):
            self.agent.run()
        start.assert_called_once_with()
        write_record(self.cfg, state="failed", error="capture_failed", finishedAt=export.iso(time.time()))
        with mock.patch.object(agentmod.Agent, "_start_export") as start, \
                mock.patch.object(agentmod.Agent, "serve"), \
                mock.patch.object(agentmod.Agent, "tick", return_value="stopped"):
            self.agent.run()
        start.assert_not_called()

class StopDesktop(unittest.TestCase):
    def test_stop_desktop_sets_the_export_quiesce_marker_and_requires_the_unit_down(self):
        d, cfg, _ = scratch(self)
        agent = agentmod.Agent(cfg, LEASE, log=lambda m: None)
        ran = []
        with mock.patch.object(agentmod, "DESKTOP_STOP_CMD", ("/bin/true",)), \
                mock.patch.object(agentmod.subprocess, "run", side_effect=lambda cmd, **kw: ran.append(cmd)), \
                mock.patch.object(desktop, "stop", return_value="clean") as stop, \
                mock.patch.object(desktop, "state", return_value="absent"):
            for unit, want in (("inactive", True), ("failed", True), ("pending", True), ("active", False),
                               ("activating", False), ("unknown", False)):
                with self.subTest(unit=unit), mock.patch.object(agentmod.Agent, "_desktop_unit", return_value=unit):
                    self.assertEqual(agentmod.Agent._export_stop_desktop(agent), want)
                    self.assertTrue(os.path.exists(os.path.join(cfg.runDir, desktop.EXPORT_QUIESCE)))
                    self.assertFalse(os.path.exists(os.path.join(cfg.runDir, desktop.STOPPING)),
                                     "r7: never runDir/stopping, which also refuses the edge and the tunnel")
        self.assertIn(["/bin/true"], ran)
        stop.assert_called()
        with mock.patch.object(agentmod.subprocess, "run"), mock.patch.object(desktop, "stop", return_value="clean"), \
                mock.patch.object(desktop, "state", return_value="running"), \
                mock.patch.object(agentmod.Agent, "_desktop_unit", return_value="inactive"):
            self.assertFalse(agentmod.Agent._export_stop_desktop(agent), "a container still running is not down")


class IdleHold(unittest.TestCase):
    def setUp(self):
        self.d, self.cfg, _ = scratch(self)
        self.t0 = 1_800_000_000.0

    def hold(self, now, **over):
        write_record(self.cfg, startedAt=export.iso(self.t0), **over)
        return export.holds_idle(self.cfg, now)

    def ready(self, **over):
        g = str(uuid.uuid4())
        head = {"v": 1, "moveId": MOVE, "generation": g, "sha256": "a" * 64, "entries": 0, "skipped": 0,
                "bytes": 10, "chunks": [{"i": 0, "size": 10, "sha256": "b" * 64}]}
        return dict(importGeneration=g, state="ready", head=head, **over)

    def test_bounds(self):
        self.assertFalse(export.holds_idle(self.cfg, self.t0), "no job, no hold")
        self.assertTrue(self.hold(self.t0 + 60))
        self.assertTrue(self.hold(self.t0 + 185 * 60 - 1), "always while capturing")
        self.assertFalse(self.hold(self.t0 + 185 * 60), "never 185 min after the job started")
        fin = self.t0 + 600
        self.assertTrue(self.hold(fin + 15 * 60 - 1, **self.ready(finishedAt=export.iso(fin))), "15 min after finishedAt, before any GET")
        self.assertFalse(self.hold(fin + 15 * 60, **self.ready(finishedAt=export.iso(fin))))
        served = fin + 3000
        r = self.ready(finishedAt=export.iso(fin), lastServedAt=export.iso(served))
        self.assertTrue(self.hold(served + 15 * 60 - 1, **r), "15 min after the last GET")
        self.assertFalse(self.hold(served + 15 * 60, **r))
        late = self.t0 + 185 * 60 - 60
        self.assertFalse(self.hold(self.t0 + 185 * 60, **self.ready(finishedAt=export.iso(fin), lastServedAt=export.iso(late))),
                         "the 185 min cap wins over a recent GET")
        self.assertFalse(self.hold(self.t0 + 60, state="failed", error="capture_failed", finishedAt=export.iso(self.t0 + 30)))
        with open(os.path.join(self.cfg.stateDir, "export", "state.json"), "w") as f:
            f.write("garbage")
        self.assertFalse(export.holds_idle(self.cfg, self.t0 + 60), "unknown = no hold")

    def test_tick_holds_only_an_otherwise_due_idle_stop(self):
        clock = [self.t0]
        agent = agentmod.Agent(self.cfg, LEASE, log=lambda m: None, clock=lambda: clock[0])
        write_record(self.cfg, startedAt=export.iso(self.t0))
        self.assertEqual(agent.tick(), "active")
        clock[0] = self.t0 + 601
        with mock.patch.object(agentmod.Agent, "_terminal_hold", side_effect=AssertionError("export holds first")):
            self.assertEqual(agent.tick(), "held_export")
        self.assertFalse(os.path.exists(os.path.join(self.cfg.runDir, desktop.STOPPING)), "a hold never commits to stopping")
        clock[0] = self.t0 + 185 * 60
        with mock.patch.object(agentmod.Agent, "_terminal_hold", return_value=True):
            self.assertEqual(agent.tick(), "held_terminal", "past the cap the normal predicate applies")


def load_validate_lowers():
    import importlib.util
    spec = importlib.util.spec_from_file_location("validate_lowers", os.path.join(HERE, "..", "ami", "validate-lowers.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Bake(unittest.TestCase):
    """T0 (b2) at bake time: the current lower has the codec's python3 and git, and every mount
    destination of the export spec (ami/validate-lowers.py, run by the bake and its validate phase)."""

    def setUp(self):
        self.v = load_validate_lowers()
        self.d, _, self.lower = scratch(self)
        self.lowers = os.path.dirname(self.lower)
        bin_dir = os.path.join(self.lower, "usr", "bin")
        for name in ("python3.12", "git"):
            with open(os.path.join(bin_dir, name), "w") as f:
                f.write("#!/bin/true\n")
            os.chmod(os.path.join(bin_dir, name), 0o755)
        os.symlink("python3.12", os.path.join(bin_dir, "python3"))

    def check(self):
        self.v.validate_export(__import__("pathlib").Path(self.lowers), DIGEST)

    def test_mirrors_the_export_spec(self):
        self.assertEqual((self.v.EXPORT_LOWER_DIRS, self.v.EXPORT_LOWER_FILES),
                         (desktop.EXPORT_LOWER_DIRS, desktop.EXPORT_LOWER_FILES))

    def test_complete_lower_passes_and_absolute_links_resolve_inside_it(self):
        self.check()
        os.unlink(os.path.join(self.lower, "usr/bin/python3"))
        os.symlink("/usr/bin/python3.12", os.path.join(self.lower, "usr/bin/python3"))
        self.check()

    def test_each_missing_requirement_fails_the_bake(self):
        cases = {
            "git": lambda: os.unlink(os.path.join(self.lower, "usr/bin/git")),
            "git not executable": lambda: os.chmod(os.path.join(self.lower, "usr/bin/git"), 0o644),
            "python3 escapes the lower": lambda: (os.unlink(os.path.join(self.lower, "usr/bin/python3")),
                                                  os.symlink("../../../../../../usr/bin/python3",
                                                             os.path.join(self.lower, "usr/bin/python3"))),
            "dangling python3": lambda: os.unlink(os.path.join(self.lower, "usr/bin/python3.12")),
            "workspace": lambda: os.rmdir(os.path.join(self.lower, "workspace")),
            "tmp is a link": lambda: (os.rmdir(os.path.join(self.lower, "tmp")),
                                      os.symlink("workspace", os.path.join(self.lower, "tmp"))),
            "hosts": lambda: os.unlink(os.path.join(self.lower, "etc/hosts")),
        }
        for name, breaker in cases.items():
            with self.subTest(case=name):
                self.setUp()
                breaker()
                with self.assertRaises(ValueError):
                    self.check()

    def test_the_cli_runs_the_export_check(self):
        with open(os.path.join(HERE, "..", "ami", "validate-lowers.py")) as f:
            self.assertIn("    validate_export(args.lowers_dir, args.current)", f.read())


class ExportQuiesce(unittest.TestCase):
    """r7 (lead decision H-1, §2.5 step 3): the export's desktop stop sets runDir/export-quiesce, which
    keeps the desktop down for the host's life but never gates the edge or cloudflared: a crashed edge
    or tunnel restarts mid-export and the Worker's chunk GETs still reach the host."""

    def setUp(self):
        self.d, self.cfg, _ = scratch(self)
        self.t0 = 1_800_000_000.0
        self.clock = [self.t0]
        self.agent = agentmod.Agent(self.cfg, LEASE, log=lambda m: None, clock=lambda: self.clock[0])
        for p in (mock.patch.object(cli, "_lease", return_value=dict(LEASE)), mock.patch.object(guard, "require_stamp")):
            p.start()
            self.addCleanup(p.stop)

    def marker(self, name):
        return os.path.exists(os.path.join(self.cfg.runDir, name))

    def quiesce(self):
        """The REAL export desktop stop, with the unit and the container reported down."""
        with mock.patch.object(agentmod.subprocess, "run"), mock.patch.object(desktop, "stop", return_value="clean"), \
                mock.patch.object(desktop, "state", return_value="absent"), \
                mock.patch.object(agentmod.Agent, "_desktop_unit", return_value="inactive"):
            self.assertTrue(self.agent._export_stop_desktop())
        self.assertTrue(self.marker(desktop.EXPORT_QUIESCE))
        self.assertFalse(self.marker(desktop.STOPPING))

    def test_the_edge_and_cloudflared_restart_during_an_export(self):
        self.quiesce()
        with mock.patch.object(edge, "Edge") as e, mock.patch.object(edge, "load_key", return_value=KEY), \
                mock.patch.object(cli.signal, "signal"):
            self.assertEqual(cli.step(self.cfg, "edge"), "edge stopped")
        e.return_value.serve.assert_called_once()
        with mock.patch.object(tunnel, "supervise", return_value=("exit", 1)) as sup:
            self.assertIn("cloudflared supervisor exit", cli.step(self.cfg, "cloudflared"))
        sup.assert_called_once()
        with mock.patch.object(config, "load", return_value=self.cfg), \
                mock.patch.object(tunnel, "supervise", return_value=("exit", 1)):
            self.assertEqual(cli.main(["cloudflared"]), 0, "a restarted tunnel is never a refusal (exit 2) mid-export")

    def test_the_desktop_stays_down_during_an_export(self):
        self.quiesce()
        with mock.patch.object(desktop, "run") as run, mock.patch.object(cli, "desktop_relay") as relay:
            with self.assertRaises(Refused) as r:
                cli.step(self.cfg, "desktop", detach=True)
            self.assertEqual(r.exception.code, "desktop_export_quiesced")
            with mock.patch.object(config, "load", return_value=self.cfg):
                self.assertEqual(cli.main(["desktop"]), 2, "exit 2: RestartPreventExitStatus, never restarted")
        run.assert_not_called()
        relay.assert_not_called()

    def test_no_agent_restart_brings_the_desktop_back_during_an_export(self):
        self.quiesce()
        msg = {"op": "restart-desktop", "seq": 1, "ts": self.t0, "leaseEpoch": LEASE["leaseEpoch"], "requestId": "a" * 64}
        msg["mac"] = agentmod.sign(KEY, msg)
        self.assertEqual(self.agent.handle(json.dumps(msg)), {"ok": False, "error": "restart_unavailable"})
        self.agent.restart_request = True         # e.g. an `ice` push that found the unit inactive
        with mock.patch.object(agentmod.Agent, "restart_desktop") as restart:
            self.agent.tick()
        restart.assert_not_called()

    def test_a_blocked_idle_flush_after_the_hold_never_clears_the_export_marker(self):
        write_record(self.cfg, startedAt=export.iso(self.t0))
        self.quiesce()
        self.clock[0] = self.t0 + 185 * 60          # the export's hold has ended; the normal predicate applies
        self.agent.last_presence = self.t0
        with mock.patch.object(agentmod.Agent, "_terminal_hold", return_value=False), \
                mock.patch.object(agentmod, "parse_load1", return_value=0.0), \
                mock.patch.object(agentmod.Agent, "flush", return_value="busy"):
            self.assertEqual(self.agent.tick(), "flush_busy")
        self.assertFalse(self.marker(desktop.STOPPING), "the blocked flush clears its own marker")
        self.assertTrue(self.marker(desktop.EXPORT_QUIESCE), "and never the export's")
        with mock.patch.object(desktop, "run") as run:
            with self.assertRaises(Refused):
                cli.step(self.cfg, "desktop", detach=True)
        run.assert_not_called()

    def test_a_committed_stop_still_refuses_the_edge_and_cloudflared(self):
        self.quiesce()
        open(os.path.join(self.cfg.runDir, desktop.STOPPING), "w").close()
        for step in ("edge", "cloudflared"):
            with self.subTest(step=step), mock.patch.object(edge, "Edge") as e, mock.patch.object(tunnel, "supervise") as sup:
                with self.assertRaises(Refused) as r:
                    cli.step(self.cfg, step)
                self.assertEqual(r.exception.code, f"{step}_stopping")
                e.assert_not_called()
                sup.assert_not_called()


class Quiesce(unittest.TestCase):
    def test_a_stop_during_a_capture_removes_the_export_container_before_the_volume_unmounts(self):
        d, cfg, _ = scratch(self)
        agent = agentmod.Agent(cfg, LEASE, log=lambda m: None)
        steps = []
        with mock.patch.object(agentmod.tunnel, "fence"), mock.patch.object(agentmod.time, "sleep"), \
                mock.patch.object(desktop, "stop", side_effect=lambda *a, **k: steps.append("desktop") or "absent"), \
                mock.patch.object(export, "remove_container", side_effect=lambda c: steps.append("export")), \
                mock.patch.object(agentmod.Agent, "record_stop", side_effect=lambda *a: steps.append("record")), \
                mock.patch.object(desktop, "overlay_umount"), mock.patch.object(desktop, "netns_down"), \
                mock.patch.object(agentmod.subprocess, "run", side_effect=lambda cmd, **k: steps.append(cmd[0])), \
                mock.patch.object(agentmod.guard, "clear_stamp"), mock.patch.object(agentmod.canary, "stopped"), \
                mock.patch.object(agentmod.Agent, "power_off"):
            agent.shutdown("stop:test")
        self.assertLess(steps.index("export"), steps.index("umount"))


if __name__ == "__main__":
    unittest.main()
